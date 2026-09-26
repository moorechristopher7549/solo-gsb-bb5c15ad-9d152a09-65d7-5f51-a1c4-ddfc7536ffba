// ICS 解析：折行还原、组件/属性行号索引、VTIMEZONE 注册、主子 VEVENT 归组

import ICAL from 'ical.js';
import type {
  MasterSeries,
  OverrideEvent,
  ParsedCalendar,
  VEventBlock,
  Warning,
} from './types';
import { registerSynthesizedTimezone, isTimeZoneSupported } from './timezones';

interface ScanBlock {
  kind: string;
  start: number;
  end: number;
  propLines: Record<string, number[]>;
}

/** RFC 5545 折行还原：以空格/制表符开头的逻辑行接续上一行 */
export function unfoldLines(raw: string): string[] {
  const physical = raw.replace(/\r\n/g, '\n').split('\n');
  const logical: string[] = [];
  for (const line of physical) {
    if (/^[ \t]/.test(line) && logical.length > 0) {
      logical[logical.length - 1] += line.slice(1);
    } else {
      logical.push(line);
    }
  }
  return logical;
}

function propName(line: string): string {
  const head = line.split(':', 1)[0];
  return head.split(';', 1)[0].toUpperCase();
}

/** 扫描逻辑行，得到各组件块的行范围及内部属性行号（按文档顺序） */
function scanBlocks(lines: string[]): { blocks: ScanBlock[]; calendarRanges: [number, number][] } {
  const stack: { kind: string; start: number; propLines: Record<string, number[]> }[] = [];
  const blocks: ScanBlock[] = [];
  const calendarRanges: [number, number][] = [];

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    if (line.startsWith('BEGIN:')) {
      // 注意：不能用属性名取组件类型（propName('BEGIN:X') 是 'BEGIN'），需取冒号之后
      const kind = line.slice(6).split(';', 1)[0].toUpperCase();
      stack.push({ kind, start: lineNo, propLines: {} });
      return;
    }
    if (line.startsWith('END:')) {
      const frame = stack.pop();
      if (frame) {
        const block: ScanBlock = { kind: frame.kind, start: frame.start, end: lineNo, propLines: frame.propLines };
        blocks.push(block);
        if (frame.kind === 'VCALENDAR') calendarRanges.push([frame.start, lineNo]);
      }
      return;
    }
    const top = stack[stack.length - 1];
    const name = propName(line);
    if (top && name) {
      (top.propLines[name] ??= []).push(lineNo);
    }
  });

  return { blocks, calendarRanges };
}

let warnSeq = 0;
function warn(list: Warning[], level: Warning['level'], text: string, line?: number): void {
  list.push({ id: `w${warnSeq++}`, level, text, line });
}

function stripQuotes(s: string): string {
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

/** 从原文中收集所有 TZID 引用 */
function collectReferencedTzids(lines: string[]): Set<string> {
  const set = new Set<string>();
  for (const line of lines) {
    const m = line.match(/;TZID=([^:;]+)/i);
    if (m) set.add(stripQuotes(m[1].trim()));
  }
  return set;
}

/** 估计时区合成所需的时间窗（只统计 VEVENT 内的 DTSTART/UNTIL 等，忽略 VTIMEZONE 自带 DTSTART） */
function estimateHorizon(
  lines: string[],
  ignoreRanges: { start: number; end: number }[]
): [number, number] {
  const ignored = new Set<number>();
  for (const r of ignoreRanges) {
    for (let l = r.start; l <= r.end; l++) ignored.add(l);
  }
  const years: number[] = [];
  let maxUntil = 0;
  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    if (ignored.has(lineNo)) return;
    const m = line.match(/^(DTSTART|EXDATE|RDATE|RECURRENCE-ID)\b[^\r\n]*?:\s*(\d{4})/);
    if (m) years.push(Number(m[2]));
    const u = line.match(/UNTIL=(\d{4})/i);
    if (u) maxUntil = Math.max(maxUntil, Number(u[1]));
  });
  const nowYear = new Date().getFullYear();
  years.push(nowYear);
  const minYear = Math.min(...years) - 1;
  const endYear = Math.max(maxUntil || 0, Math.max(...years) + 2, nowYear + 2) + 1;
  return [Date.UTC(minYear, 0, 1), Date.UTC(endYear, 0, 1)];
}

interface RawRecurDate {
  time: ICAL.Time;
  end: ICAL.Time | null;
}

function inflateRecurDates(prop: ICAL.Property): RawRecurDate[] {
  const values = prop.getValues();
  const out: RawRecurDate[] = [];
  for (const v of values) {
    if (v instanceof ICAL.Time) {
      out.push({ time: v, end: null });
    } else if (v && typeof v === 'object' && 'start' in v) {
      // PERIOD 值：{ start: Time, end?: Time, duration?: Duration }
      const period = v as { start: ICAL.Time; end?: ICAL.Time; duration?: ICAL.Duration };
      let end = period.end ?? null;
      if (!end && period.duration) {
        end = period.start.clone();
        end.addDuration(period.duration);
      }
      out.push({ time: period.start, end });
    }
  }
  return out;
}

export function parseCalendar(raw: string): ParsedCalendar | { fatal: string } {
  const warnings: Warning[] = [];
  const logicalLines = unfoldLines(raw);
  if (logicalLines.every((l) => l.trim() === '')) {
    return { fatal: '内容为空，请粘贴或导入 ICS 文本。' };
  }

  const { blocks: scanned, calendarRanges } = scanBlocks(logicalLines);
  if (calendarRanges.length === 0) {
    return { fatal: '未找到 VCALENDAR 组件，请确认输入是合法的 ICS 文本。' };
  }

  // 按顺序解析每个 VCALENDAR（兼容一个数据流含多个 VCALENDAR）
  // 第一遍解析用于提取 VTIMEZONE；时区必须在读取 DATE-TIME 值之前全部注册，
  // 否则未知 TZID 会在解析瞬间退化为 floating。
  const rootCompsFirst: ICAL.Component[] = [];
  for (const [start, end] of calendarRanges) {
    const slice = logicalLines.slice(start - 1, end).join('\r\n');
    try {
      rootCompsFirst.push(new ICAL.Component(ICAL.parse(slice)));
    } catch (e) {
      return { fatal: `第 ${start}-${end} 行的 VCALENDAR 解析失败：${(e as Error).message}` };
    }
  }

  // 注册自带 VTIMEZONE
  const vtimezoneBlocks: VEventBlock[] = [];
  let compOrder = 0;
  const vtzScanned = scanned.filter((b) => b.kind === 'VTIMEZONE');
  let vtzIdx = 0;
  for (const root of rootCompsFirst) {
    for (const vtz of root.getAllSubcomponents('vtimezone')) {
      try {
        const zone = new ICAL.Timezone(vtz);
        ICAL.TimezoneService.register(zone);
      } catch (e) {
        warn(warnings, 'warn', `VTIMEZONE 注册失败：${(e as Error).message}`, vtzScanned[vtzIdx]?.start);
      }
      const sb = vtzScanned[vtzIdx];
      if (sb) {
        vtimezoneBlocks.push({
          component: vtz,
          kind: 'vtimezone',
          range: { start: sb.start, end: sb.end },
          propLines: sb.propLines,
          order: compOrder++,
        });
      }
      vtzIdx++;
    }
  }

  // 缺失时区：Intl 合成兜底（horizon 排除自带 VTIMEZONE 区域，避免把其历史 DTSTART 计入）
  const registeredTzids: string[] = [];
  const [hStart, hEnd] = estimateHorizon(
    logicalLines,
    vtzScanned.map((b) => ({ start: b.start, end: b.end }))
  );
  for (const tzid of collectReferencedTzids(logicalLines)) {
    if (ICAL.TimezoneService.has(tzid)) {
      registeredTzids.push(tzid);
      continue;
    }
    if (registerSynthesizedTimezone(tzid, hStart, hEnd)) {
      warn(
        warnings,
        'info',
        `TZID="${tzid}" 缺少 VTIMEZONE，已根据浏览器时区数据库自动合成（展开窗内有效）。`
      );
      registeredTzids.push(tzid);
    } else if (isTimeZoneSupported(tzid)) {
      warn(warnings, 'error', `TZID="${tzid}" 无法合成，将按浮动时间处理。`);
    } else {
      warn(warnings, 'error', `TZID="${tzid}" 在当前浏览器中不受支持，将按浮动时间处理。`);
    }
  }

  // 时区就绪后第二遍正式解析
  const rootComps: ICAL.Component[] = [];
  for (const [start, end] of calendarRanges) {
    const slice = logicalLines.slice(start - 1, end).join('\r\n');
    try {
      rootComps.push(new ICAL.Component(ICAL.parse(slice)));
    } catch (e) {
      return { fatal: `第 ${start}-${end} 行的 VCALENDAR 二次解析失败：${(e as Error).message}` };
    }
  }

  // VEVENT 块按文档顺序与 jCal 组件配对
  const veventScanned = scanned.filter((b) => b.kind === 'VEVENT');
  const veventPairs: { comp: ICAL.Component; scan: (typeof veventScanned)[number] }[] = [];
  let evIdx = 0;
  for (const root of rootComps) {
    for (const comp of root.getAllSubcomponents('vevent')) {
      const scan = veventScanned[evIdx++];
      if (scan) veventPairs.push({ comp, scan });
    }
  }

  const masters: MasterSeries[] = [];
  const masterByUid = new Map<string, MasterSeries>();
  const orphanOverrides: { comp: ICAL.Component; scan: (typeof veventScanned)[number] }[] = [];

  for (const { comp, scan } of veventPairs) {
    const makeBlock = (): VEventBlock => ({
      component: comp,
      kind: 'vevent',
      range: { start: scan.start, end: scan.end },
      propLines: scan.propLines,
      order: compOrder,
    });

    const uid = (comp.getFirstPropertyValue('uid') as string | null) ?? `inline-${compOrder}`;
    const recurIdProp = comp.getFirstProperty('recurrence-id');

    if (!recurIdProp) {
      const dtstart = comp.getFirstPropertyValue('dtstart') as ICAL.Time | null;
      if (!dtstart) {
        warn(warnings, 'error', `VEVENT 缺少 DTSTART，已跳过（第 ${scan.start}-${scan.end} 行）。`, scan.start);
        compOrder++;
        continue;
      }

      if (masterByUid.has(uid) && uid.startsWith('inline-') === false) {
        warn(warnings, 'warn', `UID="${uid}" 存在多个主 VEVENT，第 ${scan.start} 行起的组件被忽略。`, scan.start);
        compOrder++;
        continue;
      }

      const durationSec = readDuration(comp, dtstart);
      const rruleProp = comp.getFirstProperty('rrule');
      const rdates = flattenRecurProps(comp, 'rdate', scan.propLines, warnings);
      const exdates = flattenRecurProps(comp, 'exdate', scan.propLines, warnings);

      const series: MasterSeries = {
        id: uid,
        uid,
        block: makeBlock(),
        summary: stringOrEmpty(comp.getFirstPropertyValue('summary')),
        location: stringOrEmpty(comp.getFirstPropertyValue('location')),
        description: stringOrEmpty(comp.getFirstPropertyValue('description')),
        status: (stringOrEmpty(comp.getFirstPropertyValue('status')) || 'CONFIRMED').toUpperCase(),
        dtstart,
        durationSec,
        isAllDay: dtstart.isDate,
        rrule: (rruleProp?.getFirstValue() as ICAL.Recur | undefined) ?? null,
        rruleLine: rruleProp ? scan.propLines['RRULE']?.[0] ?? 0 : 0,
        rruleRaw: rruleProp ? rawRrule(rruleProp) : '',
        rdates,
        exdates,
        overrides: [],
      };
      masters.push(series);
      masterByUid.set(uid, series);
    } else {
      orphanOverrides.push({ comp, scan });
    }
    compOrder++;
  }

  // 归组例外
  for (const { comp, scan } of orphanOverrides) {
    const uid = stringOrEmpty(comp.getFirstPropertyValue('uid'));
    const master = masterByUid.get(uid);
    const recurIdProp = comp.getFirstProperty('recurrence-id')!;
    const recurrenceId = recurIdProp.getFirstValue() as ICAL.Time;
    if (recurIdProp.getFirstParameter('range')?.toUpperCase() === 'THISANDFUTURE') {
      warn(
        warnings,
        'warn',
        'RECURRENCE-ID 带 RANGE=THISANDFUTURE，当前版本按单实例覆盖处理。',
        scan.propLines['RECURRENCE-ID']?.[0]
      );
    }
    if (!master) {
      warn(
        warnings,
        'warn',
        `第 ${scan.start} 行的例外事件（RECURRENCE-ID）找不到 UID="${uid}" 的主事件，已忽略。`,
        scan.start
      );
      continue;
    }
    const dtstart = (comp.getFirstPropertyValue('dtstart') as ICAL.Time | null) ?? recurrenceId;
    const durationSec = readDuration(comp, dtstart, master.durationSec);
    const dtendProp = comp.getFirstProperty('dtend');
    const ov: OverrideEvent = {
      id: `${uid}#${Math.round(recurrenceId.toUnixTime())}`,
      block: {
        component: comp,
        kind: 'vevent',
        range: { start: scan.start, end: scan.end },
        propLines: scan.propLines,
        order: scan.start,
      },
      recurrenceId,
      dtstart,
      dtend: (dtendProp?.getFirstValue() as ICAL.Time | null) ?? null,
      durationSec,
      isAllDay: dtstart.isDate,
      summary: stringOrEmpty(comp.getFirstPropertyValue('summary')) || master.summary,
      location: stringOrEmpty(comp.getFirstPropertyValue('location')) || master.location,
      description: stringOrEmpty(comp.getFirstPropertyValue('description')) || master.description,
      status: (stringOrEmpty(comp.getFirstPropertyValue('status')) || master.status).toUpperCase(),
      cancelled: (stringOrEmpty(comp.getFirstPropertyValue('status')) || '').toUpperCase() === 'CANCELLED',
    };
    master.overrides.push(ov);
  }

  // 基础校验告警
  for (const m of masters) {
    for (const ov of m.overrides) {
      const known =
        ov.recurrenceId.toUnixTime() === m.dtstart.toUnixTime() ||
        m.rdates.some((r) => r.time.toUnixTime() === ov.recurrenceId.toUnixTime()) ||
        m.rrule !== null;
      if (!known) {
        warn(
          warnings,
          'info',
          `UID="${m.uid}" 的例外 ${ov.recurrenceId.toJSON()} 不在规则/RDATE 上，展开窗内若无对应实例将标记为孤立覆盖。`,
          ov.block.range.start
        );
      }
    }
  }

  return {
    root: rootComps[0],
    logicalLines,
    vtimezoneBlocks,
    masters,
    warnings,
    registeredTzids,
  };
}

function stringOrEmpty(v: unknown): string {
  return v == null ? '' : String(v);
}

function readDuration(comp: ICAL.Component, dtstart: ICAL.Time, fallbackSec?: number): number {
  const durProp = comp.getFirstProperty('duration');
  if (durProp) return (durProp.getFirstValue() as ICAL.Duration).toSeconds();
  const dtend = comp.getFirstPropertyValue('dtend') as ICAL.Time | null;
  if (dtend) return dtend.subtractDate(dtstart).toSeconds();
  if (fallbackSec !== undefined) return fallbackSec;
  return dtstart.isDate ? 86400 : 0;
}

function flattenRecurProps(
  comp: ICAL.Component,
  name: string,
  propLines: Record<string, number[]>,
  warnings: Warning[]
): { time: ICAL.Time; end: ICAL.Time | null; line: number }[] {
  const out: { time: ICAL.Time; end: ICAL.Time | null; line: number }[] = [];
  const props = comp.getAllProperties(name);
  // jCal 中属性出现顺序与原文一致，propLines 同样按出现顺序记录
  const lines = propLines[name.toUpperCase()] ?? [];
  props.forEach((prop, pi) => {
    const line = lines[pi] ?? 0;
    try {
      for (const item of inflateRecurDates(prop)) {
        out.push({ time: item.time, end: item.end, line });
      }
    } catch (e) {
      warn(warnings, 'error', `${name.toUpperCase()} 解析失败：${(e as Error).message}`, line || undefined);
    }
  });
  return out;
}

function rawRrule(prop: ICAL.Property): string {
  try {
    return (prop.getFirstValue() as ICAL.Recur).toString();
  } catch {
    return '';
  }
}

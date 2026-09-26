// 重复实例展开引擎
// 规则：RRULE 用 ical.js RecurExpansion（内部按 VTIMEZONE 处理 DST），
// RDATE 并入，EXDATE 剔除，RECURRENCE-ID 覆盖替换，STATUS:CANCELLED 隐藏。
// 跨 DST 时 RRULE 在“声明时区墙钟空间”迭代，墙钟时刻不变，UTC 自动平移。

import ICAL from 'ical.js';
import type {
  EngineState,
  ExpansionResult,
  Instance,
  MasterSeries,
  Warning,
} from './types';

const MAX_COLLECTED = 5000;
const MAX_ITERATIONS = 250000;

let warnSeq = 0;
function warn(list: Warning[], level: Warning['level'], text: string, line?: number): void {
  list.push({ id: `e${warnSeq++}`, level, text, line });
}

export interface Range {
  /** 范围起，本地午夜的 unix 秒 */
  startUtc: number;
  /** 范围止（不含），本地午夜的 unix 秒 */
  endUtc: number;
}

function clockOf(t: ICAL.Time): string {
  const p = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return `${p(t.hour)}:${p(t.minute)}`;
}

function dateOf(t: ICAL.Time): string {
  const p = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return `${t.year}-${p(t.month)}-${p(t.day)}`;
}

function wallLabel(t: ICAL.Time, allDay: boolean): string {
  return allDay ? dateOf(t) : `${dateOf(t)} ${clockOf(t)}`;
}

function tzidOf(t: ICAL.Time): string | null {
  // UTC 时间 zone.tzid 为 'UTC' / 'Z'；floating / 全天（VALUE=DATE）语义上无固定时区，
  // ical.js 按 UTC 解释其绝对时刻，显示墙钟时也应按 UTC 还原
  const z = t.zone;
  if (!z || z.tzid === 'floating') return 'UTC';
  return z.tzid;
}

function offsetOf(t: ICAL.Time): number | null {
  if (!t.zone || t.zone.tzid === 'floating') return null;
  try {
    return t.utcOffset();
  } catch {
    return null;
  }
}

interface BuildInput {
  master: MasterSeries;
  time: ICAL.Time;
  durationSec: number;
  source: Instance['source'];
  originLine: number;
  excluded?: boolean;
  cancelled?: boolean;
  override?: Instance['override'];
  overrideDisabled?: boolean;
  overrideRange?: Instance['overrideRange'];
}

function buildInstance(input: BuildInput): Instance {
  const { master, time, durationSec, source, originLine } = input;
  const startUtc = Math.round(time.toUnixTime());
  const endUtc = startUtc + durationSec;
  const tzid = tzidOf(time);

  if (input.override) {
    const ov = input.override;
    return {
      key: startUtc,
      recurrenceKey: Math.round(ov.recurrenceId.toUnixTime()),
      seriesId: master.id,
      uid: master.uid,
      startUtc,
      endUtc,
      tzid,
      utcOffsetSec: offsetOf(time),
      localClock: ov.isAllDay ? '全天' : clockOf(ov.dtstart),
      isAllDay: ov.isAllDay,
      summary: ov.summary,
      location: ov.location,
      status: ov.status,
      source: 'override',
      excluded: input.excluded ?? false,
      cancelled: input.cancelled ?? ov.cancelled,
      overrideDisabled: input.overrideDisabled ?? false,
      override: ov,
      masterRange: master.block.range,
      originLine: ov.block.propLines['RECURRENCE-ID']?.[0] ?? originLine,
      overrideRange: ov.block.range,
    };
  }

  return {
    key: startUtc,
    recurrenceKey: startUtc,
    seriesId: master.id,
    uid: master.uid,
    startUtc,
    endUtc,
    tzid,
    utcOffsetSec: offsetOf(time),
    localClock: master.isAllDay ? '全天' : clockOf(time),
    isAllDay: master.isAllDay,
    summary: master.summary,
    location: master.location,
    status: master.status,
    source,
    excluded: input.excluded ?? false,
    cancelled: input.cancelled ?? false,
    overrideDisabled: input.overrideDisabled ?? false,
    masterRange: master.block.range,
    originLine,
  };
}

/**
 * 展开单个主事件序列。
 */
function expandSeries(
  master: MasterSeries,
  range: Range,
  state: EngineState,
  warnings: Warning[],
  rruleErrors: Record<string, string>
): { visible: Instance[]; cancelled: Instance[]; excluded: Instance[] } {
  const visible: Instance[] = [];
  const cancelled: Instance[] = [];
  const excluded: Instance[] = [];

  const editedRaw = state.editedRrule[master.id];
  let rule: ICAL.Recur | null = master.rrule;
  if (editedRaw !== undefined) {
    const trimmed = editedRaw.trim();
    if (trimmed === '') {
      rule = null;
    } else {
      try {
        rule = ICAL.Recur.fromString(trimmed.startsWith('RRULE:') ? trimmed.slice(6) : trimmed);
      } catch (e) {
        const msg = (e as Error).message;
        rruleErrors[master.id] = msg;
        warn(warnings, 'error', `UID="${master.uid}" 的 RRULE 无法解析：${msg}`, master.rruleLine || undefined);
        rule = master.rrule; // 保留最后一次有效规则
      }
    }
  }

  // key -> 基础实例（RRULE / RDATE / 单次）
  const base = new Map<number, Instance>();

  const putBase = (inst: Instance): void => {
    if (!base.has(inst.key)) base.set(inst.key, inst);
  };

  // 1) RRULE 迭代（RecurIterator 保证 DTSTART 为首个候选，并在声明时区墙钟空间推进）
  if (rule) {
    let iter: ReturnType<ICAL.Recur['iterator']>;
    try {
      iter = rule.iterator(master.dtstart.clone());
    } catch (e) {
      warn(warnings, 'error', `UID="${master.uid}" 展开失败：${(e as Error).message}`, master.rruleLine || undefined);
      iter = (master.rrule ?? rule).iterator(master.dtstart.clone());
    }
    let iterCount = 0;
    let collected = 0;
    let done = false;
    while (iterCount < MAX_ITERATIONS && collected < MAX_COLLECTED && !done) {
      const t = iter.next();
      iterCount++;
      if (!t) {
        done = true;
        break;
      }
      const tSec = Math.round(t.toUnixTime());
      // 范围之前的实例（COUNT 规则也必须经过迭代计数）直接跳过
      if (tSec + master.durationSec <= range.startUtc) continue;
      if (tSec >= range.endUtc) {
        // 迭代时间单调递增：越过范围右端即可结束（规则结束时 next() 自然返回 null）
        break;
      }
      collected++;
      putBase(
        buildInstance({
          master,
          time: t,
          durationSec: master.durationSec,
          source: 'rrule',
          originLine: master.rruleLine || master.block.propLines['DTSTART']?.[0] || 0,
        })
      );
    }
    if (iterCount >= MAX_ITERATIONS) {
      warn(warnings, 'warn', `UID="${master.uid}" 迭代次数达到上限 ${MAX_ITERATIONS}，已截断，请收窄日期范围。`, master.rruleLine || undefined);
    }
    if (collected >= MAX_COLLECTED) {
      warn(warnings, 'warn', `UID="${master.uid}" 范围内实例达到上限 ${MAX_COLLECTED}，已截断。`, master.rruleLine || undefined);
    }
  } else if (!rule && master.rdates.length === 0) {
    // 无规则、无 RDATE：主事件自身即单次实例
    putBase(
      buildInstance({
        master,
        time: master.dtstart.clone(),
        durationSec: master.durationSec,
        source: 'single',
        originLine: master.block.propLines['DTSTART']?.[0] || 0,
      })
    );
  }

  // 2) RDATE 并入（PERIOD 以其显式 end 反推时长）
  for (const rd of master.rdates) {
    const dur = rd.end ? Math.round(rd.end.toUnixTime() - rd.time.toUnixTime()) : master.durationSec;
    putBase(
      buildInstance({
        master,
        time: rd.time.clone(),
        durationSec: dur,
        source: 'rdate',
        originLine: rd.line || master.block.propLines['RDATE']?.[0] || 0,
      })
    );
  }

  // 3) 记录被 EXDATE 排除的实例（审计用），并从基础集合移除
  for (const ex of master.exdates) {
    const key = Math.round(ex.time.toUnixTime());
    const hit = base.get(key);
    if (hit) {
      base.delete(key);
      excluded.push({ ...hit, excluded: true, originLine: ex.line || hit.originLine });
    } else {
      warn(
        warnings,
        'info',
        `EXDATE ${wallLabel(ex.time, ex.time.isDate)} 未匹配到实例。`,
        ex.line || undefined
      );
    }
  }

  // 4) 例外覆盖
  for (const ov of master.overrides) {
    const key = Math.round(ov.recurrenceId.toUnixTime());
    const disabled = state.disabledOverrides.has(ov.id);

    if (ov.cancelled) {
      const hit = base.get(key);
      if (disabled) {
        // 停用取消：原实例恢复（审计列表里标注）
        if (hit) (hit as Instance).overrideDisabled = true;
      } else if (hit) {
        base.delete(key);
        cancelled.push({ ...hit, cancelled: true, source: 'override', override: ov, overrideRange: ov.block.range, originLine: ov.block.propLines['RECURRENCE-ID']?.[0] ?? 0 });
      } else {
        // 孤立的 CANCELLED 例外：仅在范围内时审计展示
        if (inRange(ov.dtstart, ov.durationSec, range)) {
          cancelled.push(
            buildInstance({
              master,
              time: ov.dtstart.clone(),
              durationSec: master.durationSec,
              source: 'override',
              originLine: ov.block.propLines['RECURRENCE-ID']?.[0] ?? 0,
              cancelled: true,
              override: ov,
              overrideRange: ov.block.range,
            })
          );
        }
      }
      continue;
    }

    // 普通覆盖
    const replaced = base.get(key);
    if (disabled) {
      // 停用覆盖：原实例恢复并标注
      if (replaced) {
        replaced.overrideDisabled = true;
      } else {
        warn(
          warnings,
          'info',
          `被停用的例外 ${wallLabel(ov.recurrenceId, ov.isAllDay)} 没有对应的原实例。`,
          ov.block.range.start
        );
      }
      continue;
    }

    const inst = buildInstance({
      master,
      time: ov.dtstart.clone(),
      durationSec: ov.durationSec,
      source: 'override',
      originLine: ov.block.propLines['RECURRENCE-ID']?.[0] ?? 0,
      override: ov,
      overrideRange: ov.block.range,
    });
    if (replaced) base.delete(key);
    base.set(Math.round(ov.dtstart.toUnixTime()), inst);
    if (!replaced) {
      (inst as Instance).orphan = true;
      warn(
        warnings,
        'info',
        `例外 ${wallLabel(ov.recurrenceId, ov.isAllDay)} 在展开序列中找不到原实例（孤立覆盖，已按其自身时间展示）。`,
        ov.block.range.start
      );
    }
  }

  // 5) 范围过滤（半开区间，相切不算重叠）
  for (const inst of base.values()) {
    if (inst.startUtc < range.endUtc && inst.endUtc > range.startUtc) visible.push(inst);
  }

  const cancelledInRange = cancelled.filter(
    (i) => i.startUtc < range.endUtc && i.endUtc > range.startUtc
  );
  const excludedInRange = excluded.filter(
    (i) => i.startUtc < range.endUtc && i.endUtc > range.startUtc
  );

  visible.sort((a, b) => a.startUtc - b.startUtc || a.uid.localeCompare(b.uid));
  cancelledInRange.sort((a, b) => a.startUtc - b.startUtc);
  excludedInRange.sort((a, b) => a.startUtc - b.startUtc);
  return { visible, cancelled: cancelledInRange, excluded: excludedInRange };
}

function inRange(t: ICAL.Time, durationSec: number, range: Range): boolean {
  const s = Math.round(t.toUnixTime());
  return s < range.endUtc && s + durationSec > range.startUtc;
}

export function expandAll(
  masters: MasterSeries[],
  range: Range,
  state: EngineState
): ExpansionResult {
  const warnings: Warning[] = [];
  const rruleErrors: Record<string, string> = {};
  const visible: Instance[] = [];
  const cancelled: Instance[] = [];
  const excluded: Instance[] = [];

  for (const master of masters) {
    const r = expandSeries(master, range, state, warnings, rruleErrors);
    visible.push(...r.visible);
    cancelled.push(...r.cancelled);
    excluded.push(...r.excluded);
  }

  visible.sort((a, b) => a.startUtc - b.startUtc || a.location.localeCompare(b.location));
  cancelled.sort((a, b) => a.startUtc - b.startUtc);
  excluded.sort((a, b) => a.startUtc - b.startUtc);

  return {
    instances: visible,
    cancelled,
    excluded,
    warnings,
    rruleErrors,
  };
}

/** 将 unix 秒格式化为 YYYY-MM-DD HH:mm（浏览器本地时区） */
export function formatLocal(utcSec: number, allDay: boolean): string {
  const d = new Date(utcSec * 1000);
  const p = (n: number): string => (n < 10 ? `0${n}` : String(n));
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return allDay ? date : `${date} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

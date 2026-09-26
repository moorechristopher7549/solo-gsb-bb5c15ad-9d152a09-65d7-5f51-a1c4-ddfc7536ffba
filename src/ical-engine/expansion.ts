// 重复实例展开引擎
// 规则：RRULE 用 ical.js RecurExpansion（内部按 VTIMEZONE 处理 DST），
// RDATE 并入，EXDATE 剔除，RECURRENCE-ID 覆盖替换，STATUS:CANCELLED 隐藏。
// RECURRENCE-ID;RANGE=THISANDFUTURE 范围例外：以原始 recurrence key 判定影响范围，
// 按声明时区墙钟位移调整该次及后续实例，并延续范围例外的时长/标题/地点/状态。
// 跨 DST 时 RRULE 在“声明时区墙钟空间”迭代，墙钟时刻不变，UTC 自动平移。

import ICAL from 'ical.js';
import type {
  EngineState,
  ExpansionResult,
  Instance,
  MasterSeries,
  OverrideEvent,
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
 * 把实例起点按墙钟位移平移：先在声明时区还原墙钟字段，做朴素（日历）加减，
 * 规范化后再按该时区当时的真实偏移折回 UTC。跨 DST 时墙钟位移量保持恒定，
 * UTC 位移随两侧偏移差自动变化。
 */
function shiftWallClock(inst: Instance, deltaSec: number): ICAL.Time {
  const t = ICAL.Time.epochTime.clone();
  t.fromUnixTime(inst.startUtc);
  let zoned = t;
  if (inst.tzid && inst.tzid !== 'UTC') {
    const zone = ICAL.TimezoneService.get(inst.tzid);
    if (zone) zoned = t.convertToZone(zone);
  }
  zoned.addDuration(ICAL.Duration.fromSeconds(deltaSec));
  zoned._normalize();
  return zoned;
}

/**
 * 应用范围例外（RANGE=THISANDFUTURE）到单个实例：
 * 起点按墙钟位移平移，时长/标题/地点/状态延续范围例外；
 * recurrenceKey 保持原始 key 不变（变更比对据此识别为“移动”而非一删一增）。
 */
function applyRangeOverride(inst: Instance, rov: OverrideEvent): Instance {
  const shifted = shiftWallClock(inst, rov.wallDeltaSec);
  const startUtc = Math.round(shifted.toUnixTime());
  return {
    ...inst,
    key: startUtc,
    startUtc,
    endUtc: startUtc + rov.durationSec,
    utcOffsetSec: offsetOf(shifted),
    localClock: inst.isAllDay ? '全天' : clockOf(shifted),
    summary: rov.summary,
    location: rov.location,
    status: rov.status,
    source: 'range',
    override: rov,
    overrideRange: rov.block.range,
    originLine: rov.block.propLines['RECURRENCE-ID']?.[0] ?? inst.originLine,
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

  // 生效的范围例外（按原始 key 升序）：既用于第 4 步的范围调整，
  // 也用于放宽 RRULE 收集窗口——原起点在窗外、墙钟位移后落入窗内的实例不能被漏收。
  const rangeOvs = master.overrides
    .filter((ov) => ov.isRange && !state.disabledOverrides.has(ov.id))
    .sort((a, b) => Math.round(a.recurrenceId.toUnixTime()) - Math.round(b.recurrenceId.toUnixTime()));
  let collectStart = range.startUtc;
  let collectEnd = range.endUtc;
  if (rangeOvs.length > 0) {
    // 墙钟位移折算成 UTC 时最多差一个时区偏移变化（26h 覆盖全球 −12…+14 的极端）；
    // 起点侧再放宽范围例外的最大时长（时长也可能被延续）。
    const shiftMargin = rangeOvs.reduce((m, ov) => Math.max(m, Math.abs(ov.wallDeltaSec)), 0) + 26 * 3600;
    const maxRovDur = rangeOvs.reduce((m, ov) => Math.max(m, ov.durationSec), 0);
    collectStart = range.startUtc - shiftMargin - maxRovDur;
    collectEnd = range.endUtc + shiftMargin;
  }

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
      if (tSec + master.durationSec <= collectStart) continue;
      if (tSec >= collectEnd) {
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

  // 4) 范围例外（RECURRENCE-ID;RANGE=THISANDFUTURE）：
  // 以原始 recurrence key 判定影响范围（base 此刻仍以原始 key 索引），
  // 多个范围例外按原始 key 排序，后者覆盖前者（位移不叠加）；
  // 停用某条范围例外后，相应实例自动回到前一条生效范围例外（或主事件）的状态。
  if (rangeOvs.length > 0) {
    const rangeKeys = rangeOvs.map((ov) => Math.round(ov.recurrenceId.toUnixTime()));
    const touched = new Set<string>();
    for (const [key, inst] of [...base.entries()]) {
      // 生效范围内最后一条（原始 key 最大且 <= 实例原始 key）范围例外
      let pick = -1;
      for (let i = 0; i < rangeKeys.length; i++) {
        if (rangeKeys[i] <= key) pick = i;
        else break;
      }
      if (pick < 0) continue;
      const rov = rangeOvs[pick];
      touched.add(rov.id);
      const adjusted = applyRangeOverride(inst, rov);
      if (rov.cancelled) {
        // CANCELLED 范围例外：该次及后续实例全部取消（审计留痕）
        base.delete(key);
        cancelled.push({ ...adjusted, cancelled: true });
      } else {
        // 挂回原始 key：后续单次例外仍按原始 recurrence key 匹配
        base.set(key, adjusted);
      }
    }
    for (const rov of rangeOvs) {
      if (!touched.has(rov.id)) {
        warn(
          warnings,
          'info',
          `范围例外 ${wallLabel(rov.recurrenceId, rov.isAllDay)} 在展开范围内未影响任何实例。`,
          rov.block.range.start
        );
      }
    }
  }

  // 5) 单次例外覆盖（显式单次例外优先于范围调整：按原始 key 命中后直接替换）
  for (const ov of master.overrides) {
    if (ov.isRange) continue;
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

  // 6) 范围过滤（半开区间，相切不算重叠）
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

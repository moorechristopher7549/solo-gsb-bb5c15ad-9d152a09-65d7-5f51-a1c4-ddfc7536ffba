// 空闲窗口计算
// 基于当前生效实例，在指定 LOCATION / IANA 时区 / 日期范围 / 每日工作时段内，
// 寻找可容纳指定分钟数的连续空档。
//
// 语义：
// 1. VALUE=DATE 全天事件的 DTSTART/DTEND 是无时区公历日期（ical.js 登记为 UTC 午夜），
//    参与计算前先按“所选 IANA 时区对应日期的本地日界”重建半开区间：
//    单日 [当日00:00, 次日00:00)，多日 [DTSTART 当地零点, DTEND 当地零点)，绝不沿用 UTC 午夜；
// 2. 跨日事件先按所选时区的真实本地日界（DST 日为 23h/25h，绝不固定 24h）裁剪到每一天；
// 3. 每天取与工作时段相交的忙碌半开区间 [s,e)，合并相交或首尾相接（s <= 上一区间 e）者；
// 4. 工作时段减去合并后忙碌区间即空档，长度 >= 最小分钟数者入选；
// 5. 仅同 LOCATION（trim 后精确相等、非空）的生效实例参与，已取消/已排除不参与。

import type { Instance } from './types';
import {
  dayLengthSec,
  dayStartUtcSec,
  listCalendarDays,
  parseHHMM,
  supportedTimeZone,
  wallToUtcSec,
} from '../utils/localtime';

export interface FreeWindowQuery {
  /** 精确匹配（trim 后）的 LOCATION，空串视为未选择 */
  location: string;
  tzid: string;
  /** YYYY-MM-DD，含 */
  startDate: string;
  /** YYYY-MM-DD，含 */
  endDate: string;
  /** 每日工作时段起，HH:MM（所选时区墙钟） */
  workStart: string;
  /** 每日工作时段止，HH:MM（所选时区墙钟；不支持跨夜，须晚于起点） */
  workEnd: string;
  /** 空档至少容纳的分钟数（>=5） */
  minMinutes: number;
}

export interface FreeSlot {
  /** YYYY-MM-DD（所选时区本地日） */
  date: string;
  /** 空档起，UTC 秒 */
  startUtc: number;
  /** 空档止（不含），UTC 秒 */
  endUtc: number;
  /** 空档长度（分钟） */
  minutes: number;
  /** 该日 UTC 偏移（秒），跨 DST 日随日变化 */
  offsetSec: number;
  /** 该日本地日长度（秒），非 86400 即跨 DST */
  dayLengthSec: number;
  /**
   * 前一个相邻忙碌实例：endUtc <= 空档起 的实例中结束最晚者
   * （含跨日被裁剪到当日的事件）；整日空闲 / 工作时段前无事件时为 null。
   */
  prev: Instance | null;
  /** 后一个相邻忙碌实例：startUtc >= 空档止 的实例中开始最早者；无则 null。 */
  next: Instance | null;
}

export interface FreeWindowResult {
  slots: FreeSlot[];
  /** 参与计算的实例数（该 LOCATION、与查询时间窗相交） */
  busyInstanceCount: number;
  error?: string;
}

interface Piece {
  start: number;
  end: number;
}

/** 跨日事件裁剪到某一本地日后的区间（不做工作时段裁剪，用于相邻判定） */
interface DayPiece {
  cs: number;
  ce: number;
  inst: Instance;
}

interface Block {
  start: number;
  end: number;
}

interface BusyInterval {
  start: number;
  end: number;
  inst: Instance;
}

/**
 * 从全天实例（VALUE=DATE）登记的 UTC 午夜时刻还原其公历日期分量。
 * DATE 值没有时区语义，ical.js 按 UTC 解释，因此这里必须取 UTC 分量；
 * 绝不取浏览器/查询时区分量，否则在部分时区会错到相邻日期。
 */
function utcDateParts(sec: number): { y: number; m: number; d: number } {
  const dt = new Date(sec * 1000);
  return {
    y: dt.getUTCFullYear(),
    m: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
  };
}

/**
 * 实例在“所选 IANA 时区”解释下的忙碌半开区间（UTC 秒）。
 * - 带时刻事件：沿用其声明时区对应的绝对时刻，不做改动；
 * - VALUE=DATE 全天事件：DTSTART/DTEND 为无时区公历日期，按查询时区对应日期的
 *   本地日界重建。多日事件覆盖 DTSTART 当地零点 → DTEND 当地零点；
 *   本地日界经真实偏移换算，23/25 小时 DST 日自动正确。
 */
function busyIntervalInZone(inst: Instance, tzid: string): { start: number; end: number } {
  if (!inst.isAllDay) return { start: inst.startUtc, end: inst.endUtc };
  const s = utcDateParts(inst.startUtc);
  const e = utcDateParts(inst.endUtc);
  const start = dayStartUtcSec(tzid, s.y, s.m, s.d);
  // DTEND 为排他结束日；退化为零长度（DTEND==DTSTART）时仍返回空区间
  const end = dayStartUtcSec(tzid, e.y, e.m, e.d);
  return { start, end: Math.max(start, end) };
}

export function computeFreeWindows(
  instances: Instance[],
  q: FreeWindowQuery
): FreeWindowResult {
  const location = q.location.trim();
  if (!location) return { slots: [], busyInstanceCount: 0, error: '请先选择 LOCATION' };
  if (!q.tzid.trim()) return { slots: [], busyInstanceCount: 0, error: '请填写 IANA 时区' };
  if (!supportedTimeZone(q.tzid.trim())) {
    return { slots: [], busyInstanceCount: 0, error: `不支持的 IANA 时区：${q.tzid}` };
  }
  const ws = parseHHMM(q.workStart);
  const we = parseHHMM(q.workEnd);
  if (!ws || !we) return { slots: [], busyInstanceCount: 0, error: '工作时段格式应为 HH:MM' };
  const workStartMin = ws.hh * 60 + ws.mm;
  const workEndMin = we.hh * 60 + we.mm;
  if (workEndMin <= workStartMin) {
    return { slots: [], busyInstanceCount: 0, error: '每日工作时段止必须晚于起（暂不支持跨午夜时段）' };
  }
  if (!Number.isFinite(q.minMinutes) || q.minMinutes < 5) {
    return { slots: [], busyInstanceCount: 0, error: '最小空档分钟数需 ≥ 5' };
  }

  const days = listCalendarDays(q.startDate, q.endDate);
  if (days === null) return { slots: [], busyInstanceCount: 0, error: '日期范围非法或跨度超过一年' };
  if (days.length === 0) return { slots: [], busyInstanceCount: 0, error: '起始日期不能晚于结束日期' };

  const tzid = q.tzid.trim();
  const minSec = Math.round(q.minMinutes * 60);

  // 同地点生效实例（半开区间）。
  // 全天实例先按所选时区本地日界重建区间，再做时间窗相交与逐日裁剪。
  const busyIntervals: BusyInterval[] = instances
    .filter((i) => i.location.trim() === location)
    .map((inst) => ({ ...busyIntervalInZone(inst, tzid), inst }));

  const horizonStart = dayStartUtcSec(tzid, days[0].y, days[0].m, days[0].d);
  const lastDay = days[days.length - 1];
  const horizonEnd = (() => {
    const dt = new Date(Date.UTC(lastDay.y, lastDay.m - 1, lastDay.d));
    dt.setUTCDate(dt.getUTCDate() + 1);
    return dayStartUtcSec(tzid, dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  })();
  const inHorizon = busyIntervals.filter((b) => b.start < horizonEnd && b.end > horizonStart);

  const slots: FreeSlot[] = [];

  for (const day of days) {
    const { y, m, d, ymd } = day;
    const d0 = dayStartUtcSec(tzid, y, m, d);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + 1);
    const d1 = dayStartUtcSec(tzid, dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());

    // 工作时段按真实本地墙钟换算（DST 日不做固定 24h 假设）
    const workS = wallToUtcSec(tzid, y, m, d, ws.hh, ws.mm, 0);
    const workE = wallToUtcSec(tzid, y, m, d, we.hh, we.mm, 0);
    const dayLen = dayLengthSec(tzid, y, m, d);
    const offsetSec = (() => {
      const noon = wallToUtcSec(tzid, y, m, d, 12, 0, 0);
      return Math.round((Date.UTC(y, m - 1, d, 12) - noon * 1000) / 1000);
    })();

    // 1) 跨日事件先裁剪到本地日 [d0,d1)；
    //    pieces 再与当日工作时段求交，作为忙碌区间。
    const dayPieces: DayPiece[] = [];
    const pieces: Piece[] = [];
    for (const b of inHorizon) {
      const cs = Math.max(b.start, d0);
      const ce = Math.min(b.end, d1);
      if (cs >= ce) continue;
      dayPieces.push({ cs, ce, inst: b.inst });
      const s = Math.max(cs, workS);
      const e = Math.min(ce, workE);
      if (s < e) pieces.push({ start: s, end: e });
    }

    // 2) 合并相交或首尾相接的半开区间（相接：下一个 start <= 上一个 end）
    pieces.sort((a, b) => a.start - b.start || b.end - a.end);
    const blocks: Block[] = [];
    for (const p of pieces) {
      const last = blocks[blocks.length - 1];
      if (last && p.start <= last.end) {
        last.end = Math.max(last.end, p.end);
      } else {
        blocks.push({ start: p.start, end: p.end });
      }
    }

    // 相邻忙碌实例：按“裁剪到当日的区间”判定，保证跨日事件也算当日边界事件。
    // 前邻：当日裁剪终点 <= t 的实例中结束最晚者；后邻：裁剪起点 >= t 的实例中开始最早者。
    const neighborAfter = (t: number): Instance | null => {
      let hit: DayPiece | null = null;
      for (const p of dayPieces) {
        if (p.cs >= t && (!hit || p.cs < hit.cs)) hit = p;
      }
      return hit?.inst ?? null;
    };
    const neighborBefore = (t: number): Instance | null => {
      let hit: DayPiece | null = null;
      for (const p of dayPieces) {
        if (p.ce <= t && (!hit || p.ce > hit.ce)) hit = p;
      }
      return hit?.inst ?? null;
    };

    // 3) 工作时段内的空档，保留长度 >= 最小分钟数者
    let cursor = workS;
    const pushGap = (g0: number, g1: number): void => {
      if (g1 - g0 < minSec) return;
      slots.push({
        date: ymd,
        startUtc: g0,
        endUtc: g1,
        minutes: Math.round((g1 - g0) / 60),
        offsetSec,
        dayLengthSec: dayLen,
        prev: neighborBefore(g0),
        next: neighborAfter(g1),
      });
    };

    for (const blk of blocks) {
      if (blk.start > cursor) pushGap(cursor, Math.min(blk.start, workE));
      cursor = Math.max(cursor, blk.end);
      if (cursor >= workE) break;
    }
    if (cursor < workE) pushGap(cursor, workE);
  }

  // 列表按日期、开始时间排序
  slots.sort((a, b) => a.startUtc - b.startUtc);

  return { slots, busyInstanceCount: inHorizon.length };
}

/** 从生效实例中收集全部非空 LOCATION（trim 去重，按字母序）。 */
export function collectLocations(instances: Instance[]): string[] {
  const set = new Set<string>();
  for (const i of instances) {
    const loc = i.location.trim();
    if (loc) set.add(loc);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

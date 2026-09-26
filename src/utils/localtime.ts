// 按真实 IANA 时区进行墙钟 ⇄ UTC 换算。
// 关键约束：跨 DST 的本地“一天”并不总是 86400 秒（春季 23h、秋季 25h），
// 因此本地日界一律用真实偏移换算，绝不固定加 24 小时。

import { isTimeZoneSupported } from '../ical-engine/timezones';

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 给定 UTC 毫秒，取其在 tzid 中的 UTC 偏移（秒）。UTC 别名按 0 处理。 */
export function offsetSecAt(tzid: string, utcMs: number): number {
  if (/^(Z|UTC|GMT)$/i.test(tzid)) return 0;
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tzid,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const map: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = Number(p.value);
  }
  const hour = map.hour === 24 ? 0 : map.hour;
  const asUtc = Date.UTC(map.year, map.month - 1, map.day, hour, map.minute, map.second);
  return Math.round((asUtc - utcMs) / 1000);
}

/**
 * 墙钟（本地日 + 当日钟点）→ UTC 秒。
 * 先在目标时刻前后各约一天内取若干探针偏移的最大值（覆盖跨 DST 的新旧两个偏移），
 * 以“最早可能的 UTC 瞬间”为起点，再向 UTC 增大方向逐分钟推进，
 * 直到该瞬间的本地墙钟首次 >= 目标墙钟。
 * - 普通时间：起点即解；
 * - 秋季回退（歧义墙钟）：取第一个出现的偏移（切换前）；
 * - 春季跳表（不存在的墙钟）：取跳表结束后的第一个有效瞬间。
 */
export function wallToUtcSec(
  tzid: string,
  y: number,
  m: number, // 1-12
  d: number,
  hh: number,
  mm: number,
  ss = 0
): number {
  if (/^(Z|UTC|GMT)$/i.test(tzid)) {
    return Math.round(Date.UTC(y, m - 1, d, hh, mm, ss) / 1000);
  }
  const wallMs = Date.UTC(y, m - 1, d, hh, mm, ss);
  // 探针：跨 DST 日附近新旧偏移都会被采样到；取最大（最不负）偏移得到最早候选
  let maxOffSec = -Infinity;
  for (const deltaH of [-26, -2, 2, 26]) {
    maxOffSec = Math.max(maxOffSec, offsetSecAt(tzid, wallMs + deltaH * 3600_000));
  }
  let u = wallMs - maxOffSec * 1000;
  for (let step = 0; step < 4 * 60; step++) {
    const back = u + offsetSecAt(tzid, u) * 1000;
    if (back >= wallMs) return Math.round(u / 1000);
    u += 60_000;
  }
  return Math.round(u / 1000);
}

/**
 * tzid 中某本地日（00:00 墙钟）对应的 UTC 秒。
 * wallToUtcSec 已按真实偏移处理 DST：
 * 秋季回退日 00:00 取第一个出现（仍为旧偏移）；春季跳表若午夜不存在则取切换瞬间。
 */
export function dayStartUtcSec(tzid: string, y: number, m: number, d: number): number {
  return wallToUtcSec(tzid, y, m, d, 0, 0, 0);
}

/** 该本地日的真实长度（秒）：跨 DST 时为 23h/25h，平时 24h。 */
export function dayLengthSec(
  tzid: string,
  y: number,
  m: number,
  d: number
): number {
  const start = dayStartUtcSec(tzid, y, m, d);
  // 次日 00:00：用公历逐日（不按 24h 固定）
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  const next = dayStartUtcSec(tzid, dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  return next - start;
}

/** 枚举 [startYmd, endYmd]（均含）之间的本地日历日；超过上限返回 null。 */
export function listCalendarDays(
  startYmd: string,
  endYmd: string,
  maxDays = 372
): { y: number; m: number; d: number; ymd: string }[] | null {
  const [sy, sm, sd] = startYmd.split('-').map(Number);
  const [ey, em, ed] = endYmd.split('-').map(Number);
  if (!sy || !sm || !sd || !ey || !em || !ed) return null;
  const dt = new Date(Date.UTC(sy, sm - 1, sd));
  const end = Date.UTC(ey, em - 1, ed);
  if (end < dt.getTime()) return [];
  const out: { y: number; m: number; d: number; ymd: string }[] = [];
  while (dt.getTime() <= end) {
    if (out.length >= maxDays) return null;
    const y = dt.getUTCFullYear();
    const m = dt.getUTCMonth() + 1;
    const d = dt.getUTCDate();
    out.push({ y, m, d, ymd: `${y}-${pad(m)}-${pad(d)}` });
    dt.setUTCDate(dt.getUTCDate() + 1);
  }
  return out;
}

/** 校验 HH:MM（支持 24:00 作为次日边界——本工具不使用，合法范围 00:00–23:59）。 */
export function parseHHMM(s: string): { hh: number; mm: number } | null {
  const mt = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!mt) return null;
  const hh = Number(mt[1]);
  const mm = Number(mt[2]);
  if (hh > 23 || mm > 59) return null;
  return { hh, mm };
}

export function supportedTimeZone(tzid: string): boolean {
  if (/^(Z|UTC|GMT)$/i.test(tzid)) return true;
  return isTimeZoneSupported(tzid);
}

/** 浏览器当前 IANA 时区（取不到时回退 UTC）。 */
export function browserTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && isTimeZoneSupported(tz)) return tz;
  } catch {
    /* ignore */
  }
  return 'UTC';
}

/** 常用 IANA 时区清单（作为输入建议）。 */
export const COMMON_TIMEZONES: string[] = [
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Africa/Cairo',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Australia/Sydney',
  'Pacific/Auckland',
  'UTC',
];

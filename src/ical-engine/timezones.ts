// 时区兜底：当 ICS 内引用的 TZID 没有对应 VTIMEZONE 时，
// 利用宿主 Intl API 探测该时区在展开时间窗内的偏移与 DST 切换点，
// 合成一个最小合法的 VTIMEZONE 注册进 ical.js，
// 从而保证跨 DST 展开时“本地墙钟时刻不变、UTC 绝对时刻随之平移”。

import ICAL from 'ical.js';

function offsetMinutesAt(tzid: string, date: Date): number {
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
  const parts = dtf.formatToParts(date);
  const map: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = Number(p.value);
  }
  // hour12:false 在个别环境会给出 24
  const hour = map.hour === 24 ? 0 : map.hour;
  const asUtc = Date.UTC(map.year, map.month - 1, map.day, hour, map.minute, map.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

export function isTimeZoneSupported(tzid: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tzid });
    return true;
  } catch {
    return false;
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function wallStringFromUtc(utcMs: number, offsetSec: number): string {
  const d = new Date(utcMs + offsetSec * 1000);
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`
  );
}

function offsetIcs(sec: number): string {
  const sign = sec < 0 ? '-' : '+';
  const a = Math.abs(sec);
  const h = Math.floor(a / 3600);
  const m = Math.floor((a % 3600) / 60);
  const s = a % 60;
  return `${sign}${pad2(h)}${pad2(m)}${s ? pad2(s) : ''}`;
}

function tzNameAt(tzid: string, utcMs: number): string {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid,
      timeZoneName: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    for (const p of dtf.formatToParts(new Date(utcMs))) {
      if (p.type === 'timeZoneName') return p.value;
    }
  } catch {
    /* ignore */
  }
  return '';
}

interface Transition {
  /** UTC 切换瞬间（毫秒） */
  at: number;
  fromSec: number;
  toSec: number;
}

/** 探测 [startMs, endMs] 内的偏移切换点（粗扫 1 天 + 分钟级二分；DST 切换必发生在某一日内） */
function probeTransitions(tzid: string, startMs: number, endMs: number): Transition[] {
  const STEP = 24 * 3600 * 1000;
  const result: Transition[] = [];
  let prevT = startMs;
  let prevOff = offsetMinutesAt(tzid, new Date(prevT)) * 60;
  for (let t = startMs + STEP; t <= endMs; t += STEP) {
    const off = offsetMinutesAt(tzid, new Date(t)) * 60;
    if (off !== prevOff) {
      // 在 [prevT, t] 之间二分，找到最小的分钟刻度 k 使 offset(k) === off
      let lo = prevT;
      let hi = t;
      while (hi - lo > 60 * 1000) {
        const mid = Math.floor((lo + hi) / 2 / 60000) * 60000;
        const mOff = offsetMinutesAt(tzid, new Date(mid)) * 60;
        if (mOff === prevOff) lo = mid;
        else hi = mid;
      }
      result.push({ at: hi, fromSec: prevOff, toSec: off });
      prevOff = off;
    }
    prevT = t;
  }
  return result;
}

/**
 * 合成并注册一个 VTIMEZONE。返回是否成功（失败时调用方应按 UTC 处理并告警）。
 */
export function registerSynthesizedTimezone(
  tzid: string,
  horizonStartMs: number,
  horizonEndMs: number
): boolean {
  if (ICAL.TimezoneService.has(tzid)) return true;
  if (/^(Z|UTC|GMT)$/i.test(tzid)) {
    const utc = ICAL.TimezoneService.get('UTC') || ICAL.TimezoneService.get('Z');
    if (utc) {
      ICAL.TimezoneService.register(utc, tzid);
      return true;
    }
    return false;
  }
  if (!isTimeZoneSupported(tzid)) return false;

  const transitions = probeTransitions(tzid, horizonStartMs, horizonEndMs);
  const offsets = new Set<number>();
  for (const tr of transitions) {
    offsets.add(tr.fromSec);
    offsets.add(tr.toSec);
  }
  const initial = offsetMinutesAt(tzid, new Date(horizonStartMs)) * 60;
  offsets.add(initial);
  const maxOffset = Math.max(...offsets);

  const lines: string[] = ['BEGIN:VTIMEZONE', `TZID:${tzid}`];

  if (transitions.length === 0) {
    lines.push(
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      `TZOFFSETFROM:${offsetIcs(initial)}`,
      `TZOFFSETTO:${offsetIcs(initial)}`,
      'END:STANDARD'
    );
  } else {
    // 窗口之前的固定偏移块，保证早于第一个切换点的时间也能取到偏移
    lines.push(
      'BEGIN:STANDARD',
      `DTSTART:${wallStringFromUtc(horizonStartMs, initial)}`,
      `TZOFFSETFROM:${offsetIcs(initial)}`,
      `TZOFFSETTO:${offsetIcs(initial)}`,
      'END:STANDARD'
    );
    for (const tr of transitions) {
      const isDaylight = tr.toSec === maxOffset && tr.toSec !== tr.fromSec;
      // DTSTART 取切换瞬间按“切换前偏移”还原出的墙钟，
      // ical.js 内部会再用 TZOFFSETFROM 折回 UTC，从而精确定位切换瞬间。
      lines.push(
        `BEGIN:${isDaylight ? 'DAYLIGHT' : 'STANDARD'}`,
        `DTSTART:${wallStringFromUtc(tr.at, tr.fromSec)}`,
        `TZOFFSETFROM:${offsetIcs(tr.fromSec)}`,
        `TZOFFSETTO:${offsetIcs(tr.toSec)}`,
        `TZNAME:${tzNameAt(tzid, tr.at + tr.toSec * 1000) || tzid}`,
        `END:${isDaylight ? 'DAYLIGHT' : 'STANDARD'}`
      );
    }
  }
  lines.push('END:VTIMEZONE');

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Recur Inspector//Synthetic Timezone//CN',
    ...lines,
    'END:VCALENDAR',
  ].join('\r\n');

  try {
    const comp = new ICAL.Component(ICAL.parse(ics));
    const vtz = comp.getFirstSubcomponent('vtimezone');
    if (!vtz) return false;
    const tz = new ICAL.Timezone(vtz);
    ICAL.TimezoneService.register(tz);
    return true;
  } catch {
    return false;
  }
}

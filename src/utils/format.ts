// 时间格式化与日期范围工具

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 当地午夜 unix 秒（浏览器时区）；非法输入返回 NaN */
export function localMidnightUtcSec(ymdStr: string): number {
  const [y, m, d] = ymdStr.split('-').map(Number);
  if (!y || !m || !d) return Number.NaN;
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime() / 1000;
}

export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return ymd(dt);
}

/** 用指定时区把 unix 秒格式化为墙钟；tzid 为 null 时用浏览器时区（floating 按 UTC 还原） */
export function formatWall(utcSec: number, tzid: string | null, allDay: boolean): string {
  const d = new Date(utcSec * 1000);
  const tz = tzid ?? undefined;
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(allDay ? {} : { hour: '2-digit', minute: '2-digit', hour12: false }),
  });
  const parts = dtf.formatToParts(d);
  const get = (t: string): string | undefined => parts.find((p) => p.type === t)?.value;
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  if (allDay) return date;
  let hour = Number(get('hour'));
  if (hour === 24) hour = 0;
  return `${date} ${pad(hour)}:${get('minute')}`;
}

export function formatDuration(sec: number, allDay: boolean): string {
  if (allDay) return `${Math.round(sec / 86400)} 天`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h && m) return `${h} 小时 ${m} 分`;
  if (h) return `${h} 小时`;
  return `${m} 分钟`;
}

export function formatOffset(offsetSec: number | null): string {
  if (offsetSec === null) return '浮动';
  const sign = offsetSec < 0 ? '-' : '+';
  const a = Math.abs(offsetSec);
  const h = Math.floor(a / 3600);
  const m = Math.round((a % 3600) / 60);
  return `UTC${sign}${pad(h)}:${pad(m)}`;
}

export function downloadText(filename: string, text: string, mime = 'text/calendar'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

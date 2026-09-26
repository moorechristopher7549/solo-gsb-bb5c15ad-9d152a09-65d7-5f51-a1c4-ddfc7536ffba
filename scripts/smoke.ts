// 引擎端到端冒烟测试（Node 下通过 vite-node 运行 TS 源码）
import assert from 'node:assert';
import { parseCalendar } from '../src/ical-engine/parser';
import { expandAll } from '../src/ical-engine/expansion';
import { detectConflicts, instanceId } from '../src/ical-engine/conflicts';
import { diffInstances, instanceIdentity } from '../src/ical-engine/diff';
import { normalizeCalendar } from '../src/ical-engine/normalizer';
import { collectLocations, computeFreeWindows } from '../src/ical-engine/free-windows';
import { dayLengthSec, dayStartUtcSec, wallToUtcSec } from '../src/utils/localtime';

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//
BEGIN:VTIMEZONE
TZID:America/New_York
BEGIN:DAYLIGHT
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
TZNAME:EDT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
TZNAME:EST
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:daily@x
SUMMARY:Daily
LOCATION:Room-A
DTSTART;TZID=America/New_York:20260305T090000
DTEND;TZID=America/New_York:20260305T100000
RRULE:FREQ=DAILY;COUNT=14
EXDATE;TZID=America/New_York:20260306T090000
RDATE;TZID=America/New_York:20260320T090000
END:VEVENT
BEGIN:VEVENT
UID:daily@x
SUMMARY:Daily moved to Room-B and 11:00
LOCATION:Room-B
DTSTART;TZID=America/New_York:20260309T110000
DTEND;TZID=America/New_York:20260309T120000
RECURRENCE-ID;TZID=America/New_York:20260309T090000
END:VEVENT
BEGIN:VEVENT
UID:daily@x
STATUS:CANCELLED
DTSTART;TZID=America/New_York:20260310T090000
DTEND;TZID=America/New_York:20260310T100000
RECURRENCE-ID;TZID=America/New_York:20260310T090000
END:VEVENT
BEGIN:VEVENT
UID:other@x
SUMMARY:Other overlapping
LOCATION:Room-A
DTSTART;TZID=America/New_York:20260305T093000
DTEND;TZID=America/New_York:20260305T103000
RRULE:FREQ=DAILY;COUNT=3
END:VEVENT
BEGIN:VEVENT
UID:synth@x
SUMMARY:Berlin no vtimezone
LOCATION:Online
DTSTART;TZID=Europe/Berlin:20260325T150000
DTEND;TZID=Europe/Berlin:20260325T160000
RRULE:FREQ=WEEKLY;COUNT=3
END:VEVENT
END:VCALENDAR
`;

function utc(y: number, m0: number, d: number, h = 0, min = 0): number {
  return Date.UTC(y, m0, d, h, min) / 1000;
}

function rangeFor(start: string, endExclusive: string) {
  const [sy, sm, sd] = start.split('-').map(Number);
  const [ey, em, ed] = endExclusive.split('-').map(Number);
  return {
    startUtc: utc(sy, sm - 1, sd) - 5 * 3600,
    endUtc: utc(ey, em - 1, ed) - 4 * 3600,
  };
}

const parsed = parseCalendar(ICS);
assert.ok(!('fatal' in parsed), 'parse ok');
if ('fatal' in parsed) process.exit(1);

const masters = parsed.masters;
assert.strictEqual(masters.length, 3, 'three series');
const daily = masters.find((m) => m.uid === 'daily@x')!;
assert.strictEqual(daily.overrides.length, 2, 'two overrides grouped');

const range = rangeFor('2026-03-05', '2026-04-10');
const expanded = expandAll(masters, range, { disabledOverrides: new Set(), editedRrule: {} });
// 原始日历基线（无编辑、无停用）
const baseline0 = expandAll(masters, range, { disabledOverrides: new Set(), editedRrule: {} });

// 1) EXDATE
assert.ok(
  !expanded.instances.some((i) => i.uid === 'daily@x' && i.startUtc === utc(2026, 2, 6, 14)),
  'EXDATE 2026-03-06 removed'
);
const exRows = expanded.excluded.filter((i) => i.uid === 'daily@x');
assert.strictEqual(exRows.length, 1, 'excluded audit row');
assert.strictEqual(exRows[0].originLine, daily.exdates[0].line, 'exdate origin line tracked');

// 2) CANCELLED（Mar 10 已进入夏令时，09:00 EDT = 13:00Z）
assert.ok(
  !expanded.instances.some((i) => i.uid === 'daily@x' && i.startUtc === utc(2026, 2, 10, 13)),
  'CANCELLED instance absent'
);
const cancelled = expanded.cancelled.filter((i) => i.uid === 'daily@x');
assert.strictEqual(cancelled.length, 1, 'cancelled audit row');

// 3) override replacement
const ov = expanded.instances.find(
  (i) => i.uid === 'daily@x' && i.summary.includes('moved')
)!;
assert.ok(ov, 'override present');
assert.strictEqual(ov.source, 'override');
assert.strictEqual(ov.location, 'Room-B');
assert.strictEqual(ov.startUtc, utc(2026, 2, 9, 15), 'override at 11:00 EDT = 15:00Z');
assert.ok(
  !expanded.instances.some(
    (i) => i.uid === 'daily@x' && i.startUtc === utc(2026, 2, 9, 14)
  ),
  'original at 09:00 replaced'
);

// 4) DST wall clock preserved（2026 年纽约 3/8 切换；Mar 7 EST -05:00，Mar 9 起 EDT -04:00）
const mar7 = expanded.instances.find((i) => i.uid === 'daily@x' && i.startUtc === utc(2026, 2, 7, 14))!;
assert.ok(mar7, 'Mar 7 instance exists');
assert.strictEqual(mar7.utcOffsetSec, -5 * 3600, 'EST -05:00');
assert.strictEqual(mar7.localClock, '09:00', 'wall 09:00 in EST');
const mar9Original = expanded.instances.find(
  (i) => i.uid === 'daily@x' && i.startUtc === utc(2026, 2, 9, 14)
);
assert.strictEqual(mar9Original, undefined, 'Mar 9 09:00 original replaced by override');
// override 自身在 EDT 下保持 11:00 墙钟
assert.strictEqual(ov.utcOffsetSec, -4 * 3600, 'EDT -04:00');
assert.strictEqual(ov.localClock, '11:00', 'override wall 11:00');

// RDATE
assert.ok(
  expanded.instances.some((i) => i.uid === 'daily@x' && i.source === 'rdate'),
  'RDATE present'
);

// 5) conflicts by location
const conflicts = detectConflicts(expanded.instances);
const aGroups = conflicts.groups.filter((g) => g.location === 'Room-A');
assert.ok(aGroups.length >= 1, 'Room-A conflict groups detected');
assert.ok(
  conflicts.byKey.has(instanceId(expanded.instances.find((i) => i.uid === 'other@x')!)),
  'other event flagged conflict'
);
// override moved to Room-B, must not conflict at 11:00 with Room-A events
assert.ok(
  !conflicts.byKey.has(instanceId(ov)),
  'override in Room-B has no conflict'
);

// 6) disable override -> original restored
const disabled = new Set([daily.overrides.find((o) => !o.cancelled)!.id]);
const re = expandAll(masters, range, { disabledOverrides: disabled, editedRrule: {} });
assert.ok(
  re.instances.some((i) => i.uid === 'daily@x' && i.startUtc === utc(2026, 2, 9, 13) && i.overrideDisabled),
  'original restored when override disabled'
);

// 7) disable cancelled override -> original restored
const disabledCancel = new Set([daily.overrides.find((o) => o.cancelled)!.id]);
const re2 = expandAll(masters, range, { disabledOverrides: disabledCancel, editedRrule: {} });
assert.ok(
  re2.instances.some((i) => i.uid === 'daily@x' && i.startUtc === utc(2026, 2, 10, 13)),
  'cancelled override disabled restores instance'
);

// 8) edited rrule live recompute (weekly instead of daily)
const re3 = expandAll(
  masters,
  range,
  { disabledOverrides: new Set(), editedRrule: { 'daily@x': 'FREQ=WEEKLY;COUNT=2' } }
);
const dailyCount = re3.instances.filter((i) => i.uid === 'daily@x' && i.source === 'rrule').length;
assert.strictEqual(dailyCount, 2, 'edited weekly rule yields 2 rrule instances');

// invalid rule -> fallback + error
const re4 = expandAll(
  masters,
  range,
  { disabledOverrides: new Set(), editedRrule: { 'daily@x': 'FREQ=BOGUS' } }
);
assert.ok(re4.rruleErrors['daily@x'], 'invalid rule reported');
assert.ok(re4.instances.some((i) => i.uid === 'daily@x'), 'falls back to original rule');

// 8b) 变更影响：无编辑时与基线完全一致
assert.strictEqual(diffInstances(expanded.instances, expanded.instances).length, 0, 'identical sets yield no changes');
const baseChanges = diffInstances(baseline0.instances, expanded.instances);
assert.strictEqual(baseChanges.length, 0, 'fresh expansion equals baseline (no effective edits)');

// 8c) 停用覆盖例外：同一身份（UID + 原始 recurrence key）标记为移动/字段变化，不是一删一增
{
  const changes = diffInstances(baseline0.instances, re.instances);
  const mar9Key = utc(2026, 2, 9, 13); // RECURRENCE-ID 09:00 EDT（3/8 已入夏令时）
  const same = changes.filter((c) => c.identity === `daily@x#${mar9Key}`);
  assert.strictEqual(same.length, 1, 'override identity matched exactly once');
  const ch = same[0];
  assert.ok(ch.before && ch.after, 'before/after both present -> modified, not add/remove');
  assert.deepStrictEqual(
    ch.kinds.slice().sort(),
    ['end-moved', 'location', 'start-moved', 'summary'],
    'start/end moved + summary/location changed'
  );
  assert.ok(
    !changes.some((c) => c.kinds[0] === 'added' && c.uid === 'daily@x' && c.recurrenceKey === mar9Key),
    'move must not be reported as added'
  );
  assert.ok(
    !changes.some((c) => c.kinds[0] === 'removed' && c.uid === 'daily@x' && c.recurrenceKey === mar9Key),
    'move must not be reported as removed'
  );
}

// 8d) 停用 CANCELLED 例外：原实例恢复，标记为新增
{
  const changes = diffInstances(baseline0.instances, re2.instances);
  const mar10 = utc(2026, 2, 10, 13); // EDT
  const added = changes.filter((c) => c.kinds[0] === 'added' && c.uid === 'daily@x');
  assert.ok(
    added.some((c) => c.recurrenceKey === mar10),
    'restored cancelled instance reported as added'
  );
}

// 8e) 编辑 RRULE 为 WEEKLY：仅基线存在的日实例标记移除，改期过的例外身份保持不变
{
  const changes = diffInstances(baseline0.instances, re3.instances);
  const removedKeys = changes.filter((c) => c.kinds[0] === 'removed').map((c) => c.recurrenceKey);
  assert.ok(removedKeys.includes(utc(2026, 2, 7, 14)), 'Mar 7 daily occurrence removed');
  assert.ok(removedKeys.includes(utc(2026, 2, 8, 13)), 'Mar 8 daily occurrence removed');
  const mar9Key = utc(2026, 2, 9, 13); // 09:00 EDT
  assert.ok(
    !removedKeys.includes(mar9Key),
    'moved override keeps identity under the new rule (orphan at same time)'
  );
  // 身份键确实是 UID + recurrenceKey
  assert.strictEqual(
    instanceIdentity(re.instances.find((i) => i.startUtc === utc(2026, 2, 9, 13))!),
    `daily@x#${mar9Key}`
  );
}

// 9) synthetic timezone (Europe/Berlin no VTIMEZONE) keeps 15:00 wall across DST (Mar 29 2026)
const berlin = re.instances.filter((i) => i.uid === 'synth@x');
assert.strictEqual(berlin.length, 3, 'three berlin instances');
const b0 = berlin[0];
const b2 = berlin[2];
assert.strictEqual(b0.localClock, '15:00');
assert.strictEqual(b2.localClock, '15:00', 'wall stays 15:00 after DST');
assert.strictEqual(b0.utcOffsetSec, 3600, 'CET +01:00 before');
assert.strictEqual(b2.utcOffsetSec, 7200, 'CEST +02:00 after');
assert.strictEqual(b2.startUtc, utc(2026, 3, 8, 13), 'Apr 8 15:00 CEST = 13:00Z');

// 10) normalize export
const norm = normalizeCalendar(parsed, { disabledOverrides: new Set(), editedRrule: {} });
assert.ok(norm.ics.includes('BEGIN:VTIMEZONE'), 'export contains vtimezone');
assert.ok(norm.ics.includes('Europe/Berlin'), 'synthetic tz exported');
assert.ok(norm.ics.includes('VERSION:2.0'));
assert.ok(norm.ics.includes('FREQ=DAILY'));
assert.strictEqual((norm.ics.match(/BEGIN:VEVENT/g) || []).length, 5, 'master + 2 overrides + other + synth');
// disabled override excluded from export
const norm2 = normalizeCalendar(parsed, {
  disabledOverrides: new Set([daily.overrides.find((o) => !o.cancelled)!.id]),
  editedRrule: {},
});
assert.strictEqual((norm2.ics.match(/BEGIN:VEVENT/g) || []).length, 4, 'disabled override omitted');
// edited rule in export
const norm3 = normalizeCalendar(parsed, {
  disabledOverrides: new Set(),
  editedRrule: { 'daily@x': 'FREQ=WEEKLY;COUNT=2' },
});
assert.ok(norm3.ics.includes('FREQ=WEEKLY;COUNT=2'), 'edited rrule exported');

// round-trip parse of normalized output
const reparsed = parseCalendar(norm.ics);
assert.ok(!('fatal' in reparsed), 'normalized output reparses');

// ================= 空闲窗口 =================

const FW_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test-FW//
BEGIN:VTIMEZONE
TZID:America/New_York
BEGIN:DAYLIGHT
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
TZNAME:EDT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
TZNAME:EST
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:fw-daily@x
SUMMARY:每日站会
LOCATION:FW-Room
DTSTART;TZID=America/New_York:20260305T090000
DTEND;TZID=America/New_York:20260305T093000
RRULE:FREQ=DAILY;COUNT=7
END:VEVENT
BEGIN:VEVENT
UID:fw-lunch@x
SUMMARY:午间评审（与站会首尾相接）
LOCATION:FW-Room
DTSTART;TZID=America/New_York:20260306T093000
DTEND;TZID=America/New_York:20260306T103000
END:VEVENT
BEGIN:VEVENT
UID:fw-overnight@x
SUMMARY:跨日部署窗口（3/7 22:00 → 3/8 06:00，跨 DST 切换）
LOCATION:FW-Room
DTSTART;TZID=America/New_York:20260307T220000
DTEND;TZID=America/New_York:20260308T060000
END:VEVENT
BEGIN:VEVENT
UID:fw-allday@x
SUMMARY:全天占用
LOCATION:FW-Room
DTSTART;VALUE=DATE:20260310
DTEND;VALUE=DATE:20260311
END:VEVENT
BEGIN:VEVENT
UID:fw-daily@x
STATUS:CANCELLED
DTSTART;TZID=America/New_York:20260309T090000
DTEND;TZID=America/New_York:20260309T093000
RECURRENCE-ID;TZID=America/New_York:20260309T090000
END:VEVENT
BEGIN:VEVENT
UID:fw-other-loc@x
SUMMARY:别的房间（不参与）
LOCATION:Other-Room
DTSTART;TZID=America/New_York:20260305T140000
DTEND;TZID=America/New_York:20260305T150000
END:VEVENT
END:VCALENDAR
`;

const fwParsed = parseCalendar(FW_ICS);
assert.ok(!('fatal' in fwParsed), 'free-window sample parses');
if (!('fatal' in fwParsed)) {
  const fwRange = {
    startUtc: Date.UTC(2026, 2, 3) / 1000,
    endUtc: Date.UTC(2026, 2, 15) / 1000,
  };
  const fwExp = expandAll(fwParsed.masters, fwRange, {
    disabledOverrides: new Set(),
    editedRrule: {},
  });

  // DST 日界：3/8（春季跳表日）00:00 EST = 05:00Z；3/9 00:00 EDT = 04:00Z，该日 23h
  assert.strictEqual(
    dayStartUtcSec('America/New_York', 2026, 3, 8),
    Date.UTC(2026, 2, 8, 5) / 1000,
    'day start on spring-forward day uses EST midnight (05:00Z)'
  );
  assert.strictEqual(
    dayStartUtcSec('America/New_York', 2026, 3, 9),
    Date.UTC(2026, 2, 9, 4) / 1000,
    'day start after spring-forward uses EDT midnight (04:00Z)'
  );
  assert.strictEqual(
    dayStartUtcSec('America/New_York', 2026, 3, 9) - dayStartUtcSec('America/New_York', 2026, 3, 8),
    23 * 3600,
    'spring-forward local day is 23h, not fixed 24h'
  );
  assert.strictEqual(
    wallToUtcSec('America/New_York', 2026, 3, 8, 9, 0, 0),
    Date.UTC(2026, 2, 8, 13) / 1000,
    '09:00 EDT on DST day = 13:00Z'
  );

  const fw = computeFreeWindows(fwExp.instances, {
    location: 'FW-Room',
    tzid: 'America/New_York',
    startDate: '2026-03-05',
    endDate: '2026-03-10',
    workStart: '09:00',
    workEnd: '18:00',
    minMinutes: 30,
  });
  assert.ok(!fw.error, 'no query error');

  // 3/5：忙碌 09:00–09:30，空档 09:30–18:00
  const d5 = fw.slots.filter((s) => s.date === '2026-03-05');
  assert.strictEqual(d5.length, 1, 'one slot on Mar 5');
  assert.strictEqual(d5[0].startUtc, Date.UTC(2026, 2, 5, 14, 30) / 1000, 'Mar 5 gap starts 09:30 EST');
  assert.strictEqual(d5[0].minutes, 510, 'Mar 5 gap 8.5h');
  assert.strictEqual(d5[0].prev?.summary, '每日站会', 'prev neighbor = standup');
  assert.strictEqual(d5[0].next, null, 'no next neighbor at work-end');

  // 3/6：09:00–10:30 合并（站会 09:00–09:30 与评审 09:30–10:30 首尾相接），空档 10:30–18:00
  const d6 = fw.slots.filter((s) => s.date === '2026-03-06');
  assert.strictEqual(d6.length, 1, 'one slot on Mar 6');
  assert.strictEqual(d6[0].startUtc, Date.UTC(2026, 2, 6, 15, 30) / 1000, 'abutting events merged, gap 10:30 EST');
  assert.strictEqual(d6[0].prev?.summary, '午间评审（与站会首尾相接）', 'prev neighbor = later ending abutting event');

  // 3/8 DST 日：跨日事件裁到 00:00–06:00（工作时段之外），站会 09:00–09:30 EDT
  const d8 = fw.slots.filter((s) => s.date === '2026-03-08');
  assert.strictEqual(d8.length, 1, 'one slot on Mar 8 (DST day)');
  assert.strictEqual(d8[0].dayLengthSec, 23 * 3600, 'slot tagged 23h DST day');
  assert.strictEqual(d8[0].offsetSec, -4 * 3600, 'EDT -04:00 on Mar 8');
  assert.strictEqual(d8[0].startUtc, Date.UTC(2026, 2, 8, 13, 30) / 1000, 'Mar 8 gap 09:30 EDT = 13:30Z');
  assert.strictEqual(d8[0].endUtc, Date.UTC(2026, 2, 8, 22) / 1000, 'Mar 8 work end 18:00 EDT = 22:00Z');
  assert.strictEqual(d8[0].minutes, 510, 'DST-day gap still 8.5 wall hours');
  // 跨日事件在工作时段前结束（06:00），不作为该空档前邻（与 09:30 不相接）
  assert.strictEqual(d8[0].prev?.summary, '每日站会', 'overnight event not adjacent to 09:30 gap');

  // 3/10：全天事件整日占用，无空档
  assert.strictEqual(fw.slots.filter((s) => s.date === '2026-03-10').length, 0, 'all-day event blocks whole day');

  // 3/9 站会被 CANCELLED 例外取消：生效忙碌集不含该实例，工作时段整日空闲（无相邻忙碌事件）
  const d9 = fw.slots.filter((s) => s.date === '2026-03-09');
  assert.strictEqual(d9.length, 1, 'one slot on Mar 9');
  assert.strictEqual(d9[0].minutes, 540, 'cancelled standup leaves full work-day gap');
  assert.strictEqual(d9[0].prev, null, 'cancelled instance is not a busy neighbor');

  // 停用该 CANCELLED 例外：3/9 站会恢复生效，空档回缩到 09:30–18:00（实时重算）
  const fwDaily = fwParsed.masters.find((mm) => mm.uid === 'fw-daily@x')!;
  const cancelOv = fwDaily.overrides.find((o) => o.cancelled)!;
  const fwRestored = expandAll(fwParsed.masters, fwRange, {
    disabledOverrides: new Set([cancelOv.id]),
    editedRrule: {},
  });
  const fw3 = computeFreeWindows(fwRestored.instances, {
    location: 'FW-Room',
    tzid: 'America/New_York',
    startDate: '2026-03-09',
    endDate: '2026-03-09',
    workStart: '09:00',
    workEnd: '18:00',
    minMinutes: 30,
  });
  assert.strictEqual(fw3.slots.length, 1, 'one slot after cancellation override disabled');
  assert.strictEqual(fw3.slots[0].minutes, 510, 'restored standup shrinks gap to 510 min');
  assert.strictEqual(fw3.slots[0].prev?.summary, '每日站会', 'restored instance becomes prev neighbor');

  // 总空档数（3/5..3/9 各 1，3/10 为 0）
  assert.strictEqual(fw.slots.length, 5, 'five slots across Mar 5–9');
  // 列表按日期、开始时间排序
  for (let i = 1; i < fw.slots.length; i++) {
    assert.ok(fw.slots[i].startUtc >= fw.slots[i - 1].startUtc, 'slots sorted by start');
  }

  // 最小分钟数过滤：480 分钟时 3/5、3/7、3/8（510）、3/9（540，取消整日空闲）入选，3/6（450）淘汰
  const fwLong = computeFreeWindows(fwExp.instances, {
    location: 'FW-Room',
    tzid: 'America/New_York',
    startDate: '2026-03-05',
    endDate: '2026-03-10',
    workStart: '09:00',
    workEnd: '18:00',
    minMinutes: 480,
  });
  assert.strictEqual(fwLong.slots.length, 4, 'minMinutes filters short gaps');

  // LOCATION 精确隔离：Other-Room 独立计算
  assert.deepStrictEqual(
    collectLocations(fwExp.instances).sort(),
    ['FW-Room', 'Other-Room'],
    'locations collected'
  );
  const other = computeFreeWindows(fwExp.instances, {
    location: 'Other-Room',
    tzid: 'America/New_York',
    startDate: '2026-03-05',
    endDate: '2026-03-05',
    workStart: '09:00',
    workEnd: '18:00',
    minMinutes: 30,
  });
  // Other-Room 仅 14:00–15:00 占用 → 09:00–14:00 与 15:00–18:00 两个空档
  assert.strictEqual(other.slots.length, 2, 'other location computed independently');
  assert.strictEqual(other.slots[0].next?.summary, '别的房间（不参与）', 'next neighbor within location');

  // 参数校验
  assert.ok(computeFreeWindows(fwExp.instances, {
    location: '', tzid: 'America/New_York', startDate: '2026-03-05', endDate: '2026-03-05',
    workStart: '09:00', workEnd: '18:00', minMinutes: 30,
  }).error, 'empty location rejected');
  assert.ok(computeFreeWindows(fwExp.instances, {
    location: 'FW-Room', tzid: 'Bad/Zone', startDate: '2026-03-05', endDate: '2026-03-05',
    workStart: '09:00', workEnd: '18:00', minMinutes: 30,
  }).error, 'bad tzid rejected');
  assert.ok(computeFreeWindows(fwExp.instances, {
    location: 'FW-Room', tzid: 'America/New_York', startDate: '2026-03-05', endDate: '2026-03-05',
    workStart: '18:00', workEnd: '09:00', minMinutes: 30,
  }).error, 'inverted work window rejected');

  // 停用/编辑实时重算：把每日站会规则清空（主事件退化为 3/5 单次实例）后重算，
  // 3/7 工作时段不再有站会（跨日事件 06:00 结束，在工作时段之外），整日空闲、前后邻均为 null
  const fwEdited = expandAll(fwParsed.masters, fwRange, {
    disabledOverrides: new Set(),
    editedRrule: { 'fw-daily@x': '' },
  });
  const fw2 = computeFreeWindows(fwEdited.instances, {
    location: 'FW-Room',
    tzid: 'America/New_York',
    startDate: '2026-03-05',
    endDate: '2026-03-08',
    workStart: '09:00',
    workEnd: '18:00',
    minMinutes: 30,
  });
  const d7 = fw2.slots.filter((s) => s.date === '2026-03-07');
  assert.strictEqual(d7.length, 1, 'Mar 7 recomputed: one free slot after rule cleared');
  assert.strictEqual(d7[0].minutes, 540, '09:00–18:00 = 540 minutes');
  assert.strictEqual(d7[0].prev, null, 'event ending before work window is not prev neighbor');
  assert.strictEqual(d7[0].next?.summary, '跨日部署窗口（3/7 22:00 → 3/8 06:00，跨 DST 切换）',
    'overnight event starting at 22:00 is next neighbor of the work-hours gap');
  // 3/5 站会作为单次事件仍在
  const d5b = fw2.slots.filter((s) => s.date === '2026-03-05');
  assert.strictEqual(d5b.length, 1);
  assert.strictEqual(d5b[0].minutes, 510, 'single instance remains after rule cleared');
  assert.strictEqual(d5b[0].prev?.summary, '每日站会');
}

// ================= VALUE=DATE 全天事件：按查询时区本地日界解释 =================
{
  // Pacific/Auckland：1–3 月 UTC+13；2026-04-05 03:00 回退（25h 日）；
  // 2026-09-27 02:00→03:00 跳表（23h 日），9 月底为 UTC+13。
  assert.strictEqual(
    dayLengthSec('Pacific/Auckland', 2026, 4, 5),
    25 * 3600,
    'Auckland fall-back local day is 25h'
  );
  assert.strictEqual(
    dayLengthSec('Pacific/Auckland', 2026, 9, 27),
    23 * 3600,
    'Auckland spring-forward local day is 23h'
  );

  const AD_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test-FW-ALLDAY//
BEGIN:VEVENT
UID:akl-one@x
SUMMARY:Auckland 单日全天（UTC+13）
LOCATION:AKL-Room
DTSTART;VALUE=DATE:20260115
DTEND;VALUE=DATE:20260116
END:VEVENT
BEGIN:VEVENT
UID:akl-multi@x
SUMMARY:跨新西兰春令时跳表的多日全天
LOCATION:AKL-Room
DTSTART;VALUE=DATE:20260925
DTEND;VALUE=DATE:20260929
END:VEVENT
BEGIN:VEVENT
UID:akl-fallback@x
SUMMARY:新西兰回秋日全天（25h）
LOCATION:AKL-Room
DTSTART;VALUE=DATE:20260405
DTEND;VALUE=DATE:20260406
END:VEVENT
BEGIN:VEVENT
UID:akl-cancel-seq@x
SUMMARY:每日全天例会
LOCATION:AKL-Room
DTSTART;VALUE=DATE:20260120
DTEND;VALUE=DATE:20260121
RRULE:FREQ=DAILY;COUNT=3
END:VEVENT
BEGIN:VEVENT
UID:akl-cancel-seq@x
STATUS:CANCELLED
DTSTART;VALUE=DATE:20260121
DTEND;VALUE=DATE:20260122
RECURRENCE-ID;VALUE=DATE:20260121
END:VEVENT
BEGIN:VEVENT
UID:akl-timed@x
SUMMARY:带时刻事件不受影响
LOCATION:AKL-Room
DTSTART;TZID=Pacific/Auckland:20260116T090000
DTEND;TZID=Pacific/Auckland:20260116T100000
END:VEVENT
END:VCALENDAR
`;

  const adParsed = parseCalendar(AD_ICS);
  assert.ok(!('fatal' in adParsed), 'all-day sample parses');
  if (!('fatal' in adParsed)) {
    const adRange = {
      startUtc: Date.UTC(2026, 0, 1) / 1000,
      endUtc: Date.UTC(2026, 9, 15) / 1000,
    };
    const adExp = expandAll(adParsed.masters, adRange, {
      disabledOverrides: new Set(),
      editedRrule: {},
    });

    // 回归场景：UTC+13 单日全天，09:00–18:00 不得产生空档
    const ad1 = computeFreeWindows(adExp.instances, {
      location: 'AKL-Room',
      tzid: 'Pacific/Auckland',
      startDate: '2026-01-15',
      endDate: '2026-01-15',
      workStart: '09:00',
      workEnd: '18:00',
      minMinutes: 30,
    });
    assert.ok(!ad1.error, 'Auckland query valid');
    assert.strictEqual(ad1.busyInstanceCount, 1, 'all-day event rebuilt into horizon at UTC+13');
    assert.strictEqual(ad1.slots.length, 0, 'single all-day day leaves no gap at 09:00–18:00 (UTC+13)');

    // 多日全天覆盖 9/25..9/28 全部本地日（含 23h 跳表日 9/27），逐日均无空档
    const adSpring = computeFreeWindows(adExp.instances, {
      location: 'AKL-Room',
      tzid: 'Pacific/Auckland',
      startDate: '2026-09-25',
      endDate: '2026-09-28',
      workStart: '09:00',
      workEnd: '18:00',
      minMinutes: 30,
    });
    assert.strictEqual(adSpring.slots.length, 0, 'multi-day all-day covers every local day incl. 23h DST day');

    // 多日边界为半开：DTEND=9/29 当地零点排他，故 9/24、9/29、9/30 整日空闲（各 540 分钟）。
    // 9/24 裁剪区间与当日相接 → 后邻为该多日事件；9/29 事件在当地零点结束（工作时段前，
    // 不相接），不计为前邻。
    const adAround = computeFreeWindows(adExp.instances, {
      location: 'AKL-Room',
      tzid: 'Pacific/Auckland',
      startDate: '2026-09-24',
      endDate: '2026-09-30',
      workStart: '09:00',
      workEnd: '18:00',
      minMinutes: 30,
    });
    assert.deepStrictEqual(
      adAround.slots.map((s) => s.date),
      ['2026-09-24', '2026-09-29', '2026-09-30'],
      'half-open DATE span: DTEND local midnight is exclusive'
    );
    assert.ok(adAround.slots.every((s) => s.minutes === 540), 'outer days fully free');
    assert.strictEqual(adAround.slots[0].next, null, 'event starting at next-day midnight is not next neighbor (clipped-day semantics)');
    assert.strictEqual(adAround.slots[1].prev, null, 'event ending at midnight before work hours is not prev neighbor');

    // 25h 回秋日的单日全天同样整日占用
    const adFall = computeFreeWindows(adExp.instances, {
      location: 'AKL-Room',
      tzid: 'Pacific/Auckland',
      startDate: '2026-04-05',
      endDate: '2026-04-05',
      workStart: '09:00',
      workEnd: '18:00',
      minMinutes: 30,
    });
    assert.strictEqual(adFall.slots.length, 0, 'all-day event covers 25h fall-back day');

    // 同一 DATE 事件换负偏移时区查询：公历日期跟随所选时区，而非沿用 UTC 午夜。
    // America/Los_Angeles 1 月为 PST（UTC-8）：1/15 整日占用，1/14 不受影响。
    const adLA15 = computeFreeWindows(adExp.instances, {
      location: 'AKL-Room',
      tzid: 'America/Los_Angeles',
      startDate: '2026-01-15',
      endDate: '2026-01-15',
      workStart: '09:00',
      workEnd: '18:00',
      minMinutes: 30,
    });
    assert.strictEqual(adLA15.slots.length, 0, 'DATE follows queried zone: busy on the zone-local DATE day (PST)');
    const adLA14 = computeFreeWindows(adExp.instances, {
      location: 'AKL-Room',
      tzid: 'America/Los_Angeles',
      startDate: '2026-01-14',
      endDate: '2026-01-14',
      workStart: '09:00',
      workEnd: '18:00',
      minMinutes: 30,
    });
    assert.strictEqual(adLA14.slots.length, 1, 'preceding local day is fully free');
    assert.strictEqual(adLA14.slots[0].minutes, 540, 'no UTC-midnight spill onto the preceding local day');
    assert.strictEqual(adLA14.slots[0].prev, null, 'all-day event starts at next-day midnight: not prev neighbor');

    // 带时刻事件 1/16 09:00–10:00（NZDT，=1/15 20:00Z–21:00Z）仍按绝对时刻裁剪：
    // 空档 10:00–18:00，前邻为该带时刻事件，绝不按“全天”处理。
    const adTimed = computeFreeWindows(adExp.instances, {
      location: 'AKL-Room',
      tzid: 'Pacific/Auckland',
      startDate: '2026-01-16',
      endDate: '2026-01-16',
      workStart: '09:00',
      workEnd: '18:00',
      minMinutes: 30,
    });
    assert.strictEqual(adTimed.slots.length, 1, 'one gap on timed-event day');
    assert.strictEqual(adTimed.slots[0].minutes, 480, 'gap 10:00–18:00 = 480 minutes');
    assert.strictEqual(
      adTimed.slots[0].startUtc,
      Date.UTC(2026, 0, 15, 21) / 1000,
      'gap starts 10:00 NZDT = previous day 21:00Z (absolute timed semantics unchanged)'
    );
    assert.strictEqual(adTimed.slots[0].prev?.summary, '带时刻事件不受影响', 'prev neighbor is the timed event');

    // CANCELLED 的 DATE 例外语义不变：1/20、1/22 占用，1/21 整日空闲且无相邻忙碌事件。
    const adSeqFw = computeFreeWindows(adExp.instances, {
      location: 'AKL-Room',
      tzid: 'Pacific/Auckland',
      startDate: '2026-01-20',
      endDate: '2026-01-22',
      workStart: '09:00',
      workEnd: '18:00',
      minMinutes: 30,
    });
    assert.deepStrictEqual(
      adSeqFw.slots.map((s) => `${s.date}@${s.minutes}`),
      ['2026-01-21@540'],
      'cancelled DATE occurrence leaves full-day gap only'
    );
    assert.strictEqual(adSeqFw.slots[0].prev, null, 'cancelled DATE override is not a busy neighbor');
    assert.strictEqual(adSeqFw.slots[0].next, null, 'no busy event after cancelled day within that day');
    const adCancelled = adExp.cancelled.filter((i) => i.uid === 'akl-cancel-seq@x');
    assert.strictEqual(adCancelled.length, 1, 'DATE CANCELLED override still audited');
    assert.strictEqual(adCancelled[0].isAllDay, true, 'cancelled audit row keeps all-day flag');

    // 停用取消例外后，1/21 恢复为全天占用（实时重算）
    const adSeq = adParsed.masters.find((mm) => mm.uid === 'akl-cancel-seq@x')!;
    const adCancelOv = adSeq.overrides.find((o) => o.cancelled)!;
    const adRestored = expandAll(adParsed.masters, adRange, {
      disabledOverrides: new Set([adCancelOv.id]),
      editedRrule: {},
    });
    const adRestoredFw = computeFreeWindows(adRestored.instances, {
      location: 'AKL-Room',
      tzid: 'Pacific/Auckland',
      startDate: '2026-01-21',
      endDate: '2026-01-21',
      workStart: '09:00',
      workEnd: '18:00',
      minMinutes: 30,
    });
    assert.strictEqual(adRestoredFw.slots.length, 0, 're-enabling cancelled all-day occurrence blocks the day');
  }
}

console.log('✓ all engine smoke tests passed');
console.log(`  instances=${expanded.instances.length} cancelled=${expanded.cancelled.length} excluded=${expanded.excluded.length} conflictGroups=${conflicts.groups.length}`);

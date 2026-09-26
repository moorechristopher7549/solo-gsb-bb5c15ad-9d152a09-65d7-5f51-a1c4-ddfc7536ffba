import { useEffect, useMemo, useState } from 'react';
import type { Instance } from '../ical-engine/types';
import {
  collectLocations,
  computeFreeWindows,
  type FreeSlot,
} from '../ical-engine/free-windows';
import { instanceId } from '../ical-engine/conflicts';
import { formatDuration, formatOffset, formatWall } from '../utils/format';
import {
  browserTimeZone,
  COMMON_TIMEZONES,
  dayStartUtcSec,
  supportedTimeZone,
} from '../utils/localtime';

interface FreeWindowsProps {
  instances: Instance[];
  /** 展开范围（浏览器本地午夜 UTC 秒），用于提示查询日期超出展开范围 */
  rangeStartUtc: number;
  rangeEndUtc: number;
  initialStartDate: string;
  initialEndDate: string;
  selectedSlotKey: string | null;
  selectedNeighborKeys: Set<string>;
  onSelectSlot: (slot: FreeSlot, tzid: string) => void;
  onSelectInstance: (inst: Instance) => void;
}

export function FreeWindows({
  instances,
  rangeStartUtc,
  rangeEndUtc,
  initialStartDate,
  initialEndDate,
  selectedSlotKey,
  selectedNeighborKeys,
  onSelectSlot,
  onSelectInstance,
}: FreeWindowsProps) {
  const locations = useMemo(() => collectLocations(instances), [instances]);

  const [location, setLocation] = useState('');
  const [tzid, setTzid] = useState(browserTimeZone());
  const [startDate, setStartDate] = useState(initialStartDate);
  const [endDate, setEndDate] = useState(initialEndDate);
  const [workStart, setWorkStart] = useState('09:00');
  const [workEnd, setWorkEnd] = useState('18:00');
  const [minMinutes, setMinMinutes] = useState(30);

  // 顶部「展开范围」变化时同步空闲窗口日期（用户本地改过之后仍以最新展开范围为准）
  useEffect(() => {
    setStartDate(initialStartDate);
  }, [initialStartDate]);
  useEffect(() => {
    setEndDate(initialEndDate);
  }, [initialEndDate]);

  const result = useMemo(
    () => (location ? computeFreeWindows(instances, {
      location,
      tzid,
      startDate,
      endDate,
      workStart,
      workEnd,
      minMinutes,
    }) : null),
    [instances, location, tzid, startDate, endDate, workStart, workEnd, minMinutes]
  );

  const tzBad = tzid.trim() !== '' && !supportedTimeZone(tzid.trim());
  const outOfRange = useMemo(() => {
    // 提示条：按所选时区真实日界比较查询窗与顶部展开窗（仅提示，不影响计算）
    if (tzBad) return false;
    const tz = tzid.trim();
    const sParts = startDate.split('-').map(Number);
    const eParts = endDate.split('-').map(Number);
    if (sParts.some(Number.isNaN) || eParts.some(Number.isNaN)) return false;
    const qs = dayStartUtcSec(tz, sParts[0], sParts[1], sParts[2]);
    if (Number.isNaN(qs)) return false;
    const edt = new Date(Date.UTC(eParts[0], eParts[1] - 1, eParts[2]));
    edt.setUTCDate(edt.getUTCDate() + 1);
    const qe = dayStartUtcSec(tz, edt.getUTCFullYear(), edt.getUTCMonth() + 1, edt.getUTCDate());
    return qe <= rangeStartUtc || qs >= rangeEndUtc;
  }, [startDate, endDate, rangeStartUtc, rangeEndUtc, tzid, tzBad]);

  return (
    <>
      <div className="filter-bar free-controls">
        <label>
          LOCATION
          <select value={location} onChange={(e) => setLocation(e.target.value)}>
            <option value="">请选择…</option>
            {locations.map((loc) => (
              <option key={loc} value={loc}>
                {loc}
              </option>
            ))}
          </select>
        </label>
        <label title="IANA 时区，如 America/New_York；跨 DST 按真实本地日界换算">
          时区
          <input
            type="text"
            list="iana-tz-list"
            value={tzid}
            spellCheck={false}
            onChange={(e) => setTzid(e.target.value)}
            style={{ width: 150, fontFamily: 'var(--mono)', fontSize: 12 }}
          />
          <datalist id="iana-tz-list">
            {COMMON_TIMEZONES.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        </label>
        <label>
          起 <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </label>
        <label>
          止 <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </label>
        <label title="所选时区的每日工作时段（墙钟）">
          工作
          <input
            type="time"
            value={workStart}
            onChange={(e) => setWorkStart(e.target.value)}
            style={{ width: 88 }}
          />
          <span className="clock">–</span>
          <input
            type="time"
            value={workEnd}
            onChange={(e) => setWorkEnd(e.target.value)}
            style={{ width: 88 }}
          />
        </label>
        <label title="只保留可容纳该时长的空档（分钟）">
          至少
          <input
            type="number"
            min={5}
            step={5}
            value={minMinutes}
            onChange={(e) => setMinMinutes(Number(e.target.value))}
            style={{ width: 64 }}
          />
          分钟
        </label>
        <span style={{ flex: 1 }} />
        {result && !result.error && (
          <span className="clock">
            空档 <b style={{ color: 'var(--text)' }}>{result.slots.length}</b> · 忙碌实例{' '}
            {result.busyInstanceCount}
          </span>
        )}
      </div>

      {tzBad && <div className="free-msg error">✕ 不支持的 IANA 时区：{tzid}</div>}
      {outOfRange && !result?.error && (
        <div className="free-msg warn">
          ⚠ 查询日期与顶部「展开范围」不相交——空档基于已展开的生效实例计算，请先扩大展开范围。
        </div>
      )}
      {result?.error && <div className="free-msg error">✕ {result.error}</div>}

      {!location ? (
        <div className="empty-hint diff-empty">
          <div style={{ fontSize: 28, marginBottom: 6 }}>🪟</div>
          选择 LOCATION 后，按 IANA 时区、日期范围与每日工作时段计算可容纳指定分钟数的空档
          <div className="clock" style={{ marginTop: 4 }}>
            跨日事件按真实本地日界裁剪（DST 日 23/25 小时）；忙碌区间相交或首尾相接即合并
          </div>
        </div>
      ) : result && !result.error ? (
        result.slots.length === 0 ? (
          <div className="empty-hint diff-empty">
            <div style={{ fontSize: 28, marginBottom: 6 }}>🚫</div>
            所选条件下没有足够长的空档
          </div>
        ) : (
          <table className="instance-table free-table">
            <thead>
              <tr>
                <th style={{ width: 110 }}>日期</th>
                <th style={{ width: 178 }}>空档（所选时区墙钟）</th>
                <th style={{ width: 86 }}>时长</th>
                <th>前 / 后相邻事件</th>
              </tr>
            </thead>
            <tbody>
              {result.slots.map((slot) => (
                <FreeSlotRow
                  key={`${slot.startUtc}-${slot.endUtc}`}
                  slot={slot}
                  tzid={tzid.trim()}
                  selected={selectedSlotKey === slotKey(slot)}
                  neighborKeys={selectedNeighborKeys}
                  onSelect={() => onSelectSlot(slot, tzid.trim())}
                  onSelectInstance={onSelectInstance}
                />
              ))}
            </tbody>
          </table>
        )
      ) : null}
    </>
  );
}

function FreeSlotRow({
  slot,
  tzid,
  selected,
  neighborKeys,
  onSelect,
  onSelectInstance,
}: {
  slot: FreeSlot;
  tzid: string;
  selected: boolean;
  neighborKeys: Set<string>;
  onSelect: () => void;
  onSelectInstance: (inst: Instance) => void;
}) {
  const dstDay = slot.dayLengthSec !== 86400;
  const prev = slot.prev;
  const next = slot.next;
  return (
    <tr
      className={`instance-row free-row ${selected ? 'selected' : ''}`}
      onClick={onSelect}
      title="点击在生效实例表中定位前后相邻事件"
    >
      <td className="cell-time">
        {slot.date}
        {dstDay && (
          <span className="dst-note" title={`该日本地日长 ${slot.dayLengthSec / 3600} 小时（跨 DST）`}>
            DST {slot.dayLengthSec / 3600}h
          </span>
        )}
        <br />
        <span className="clock">{formatOffset(slot.offsetSec)}</span>
      </td>
      <td className="cell-time">
        {formatWall(slot.startUtc, tzid, false)}
        <br />
        <span className="clock">至 {formatWall(slot.endUtc, tzid, false)}</span>
      </td>
      <td>
        <span className="free-min">{slot.minutes} 分钟</span>
      </td>
      <td>
        <NeighborChip inst={prev} tone="prev" active={!!prev && neighborKeys.has(instanceId(prev))} onClick={onSelectInstance} />
        <span className="clock" style={{ margin: '0 6px' }}>
          →
        </span>
        <NeighborChip inst={next} tone="next" active={!!next && neighborKeys.has(instanceId(next))} onClick={onSelectInstance} />
      </td>
    </tr>
  );
}

function NeighborChip({
  inst,
  tone,
  active,
  onClick,
}: {
  inst: Instance | null;
  tone: 'prev' | 'next';
  active: boolean;
  onClick: (inst: Instance) => void;
}) {
  if (!inst) {
    return (
      <span className={`free-neighbor ${tone}`}>
        <em className="clock">{tone === 'prev' ? '无前邻（工作时段起点）' : '无后邻（工作时段终点）'}</em>
      </span>
    );
  }
  return (
    <a
      className={`free-neighbor ${tone} ${active ? 'active' : ''}`}
      title={`${inst.location} · ${formatDuration(inst.endUtc - inst.startUtc, inst.isAllDay)}（点击定位该实例）`}
      onClick={(e) => {
        e.stopPropagation();
        onClick(inst);
      }}
    >
      {tone === 'prev' ? '← ' : ''}
      {inst.summary || '（无标题）'}
      <span className="clock" style={{ marginLeft: 6 }}>
        {inst.isAllDay ? '全天' : `${formatWall(inst.startUtc, inst.tzid, false).slice(11)} 起`}
      </span>
      {tone === 'next' ? ' →' : ''}
    </a>
  );
}

export function slotKey(slot: FreeSlot): string {
  return `slot@${slot.startUtc}-${slot.endUtc}`;
}

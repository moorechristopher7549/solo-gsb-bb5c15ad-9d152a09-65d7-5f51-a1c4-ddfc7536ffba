import type { MasterSeries, OverrideEvent } from '../ical-engine/types';
import { formatWall } from '../utils/format';

interface SeriesPanelProps {
  masters: MasterSeries[];
  disabledOverrides: Set<string>;
  editedRrule: Record<string, string>;
  rruleErrors: Record<string, string>;
  selectedSeriesId: string | null;
  selectedOverrideId: string | null;
  onFocusSeries: (master: MasterSeries) => void;
  onFocusOverride: (ov: OverrideEvent) => void;
  onToggleOverride: (id: string) => void;
  onEditRrule: (seriesId: string, value: string) => void;
  onResetRrule: (seriesId: string) => void;
}

export function SeriesPanel({
  masters,
  disabledOverrides,
  editedRrule,
  rruleErrors,
  selectedSeriesId,
  selectedOverrideId,
  onFocusSeries,
  onFocusOverride,
  onToggleOverride,
  onEditRrule,
  onResetRrule,
}: SeriesPanelProps) {
  if (masters.length === 0) {
    return <div className="empty-hint">解析后在此显示重复规则与例外</div>;
  }

  return (
    <div>
      {masters.map((m) => {
        const edited = editedRrule[m.id];
        const isEdited = edited !== undefined;
        const shown = isEdited ? edited : m.rruleRaw;
        const err = rruleErrors[m.id];
        return (
          <div
            className="series-card"
            key={m.id}
            style={
              selectedSeriesId === m.id
                ? { boxShadow: 'inset 3px 0 0 var(--accent)' }
                : undefined
            }
          >
            <div className="series-head" onClick={() => onFocusSeries(m)}>
              <span className="summary">{m.summary || '（无标题）'}</span>
              <span className="uid">{m.uid}</span>
            </div>
            <div className="series-meta">
              <span>📍 {m.location || '无地点'}</span>
              <span>
                起 {formatWall(Math.round(m.dtstart.toUnixTime()), tzidOf(m), m.isAllDay)}
              </span>
              {m.rrule && <span className="tag freq">{freqOf(m)}</span>}
              {!m.rrule && m.rdates.length === 0 && <span className="tag">单次事件</span>}
              <span>{m.overrides.length} 条例外</span>
              <span>{m.exdates.length} 条 EXDATE</span>
              <span>{m.rdates.length} 条 RDATE</span>
            </div>

            {(m.rrule || isEdited) && (
              <div className="rrule-edit">
                <div className="row">
                  <input
                    type="text"
                    value={shown}
                    spellCheck={false}
                    onChange={(e) => onEditRrule(m.id, e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  {isEdited && (
                    <button onClick={() => onResetRrule(m.id)} title="恢复原文">
                      重置
                    </button>
                  )}
                </div>
                {err ? (
                  <span className="rrule-error">✕ {err}</span>
                ) : isEdited ? (
                  <span className="rrule-ok">✓ 规则已生效，实例列表已实时重算</span>
                ) : null}
              </div>
            )}

            {m.rdates.length > 0 && (
              <div className="rdates-list">
                RDATE：
                {m.rdates
                  .map((r, i) => (
                    <span
                      key={i}
                      className="wline"
                      style={{ cursor: 'pointer', fontFamily: 'var(--mono)', marginRight: 8 }}
                      onClick={() => onFocusSeries(m)}
                    >
                      {formatWall(Math.round(r.time.toUnixTime()), tzidOf(m), r.time.isDate)}
                      {r.end ? ' (PERIOD)' : ''}
                      <sup> L{r.line}</sup>
                    </span>
                  ))}
              </div>
            )}

            {m.exdates.length > 0 && (
              <div className="exdates-list">
                EXDATE：
                {m.exdates.map((x, i) => (
                  <span key={i} style={{ fontFamily: 'var(--mono)', marginRight: 8 }}>
                    {formatWall(Math.round(x.time.toUnixTime()), tzidOf(m), x.time.isDate)}
                    <sup> L{x.line}</sup>
                  </span>
                ))}
              </div>
            )}

            {m.overrides.map((ov) => {
              const off = disabledOverrides.has(ov.id);
              return (
                <div
                  key={ov.id}
                  className={`override-item ${off ? 'off' : ''}`}
                  style={
                    selectedOverrideId === ov.id
                      ? { outline: '1px solid var(--override)' }
                      : undefined
                  }
                  onClick={() => !off && onFocusOverride(ov)}
                >
                  <span className={`dot ${ov.cancelled ? 'cancelled' : 'override'}`} />
                  <label
                    className="oi-main"
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleOverride(ov.id);
                    }}
                    title={off ? '勾选以重新启用该例外' : '取消勾选以停用该例外（恢复原实例）'}
                  >
                    <input
                      type="checkbox"
                      checked={!off}
                      onChange={() => onToggleOverride(ov.id)}
                    />{' '}
                    {ov.cancelled ? 'CANCELLED' : '覆盖'} ·{' '}
                    {formatWall(Math.round(ov.recurrenceId.toUnixTime()), tzidOf(m), ov.isAllDay)} ·{' '}
                    {ov.summary}
                    <div className="oi-line">
                      L{ov.block.range.start}–{ov.block.range.end}（RECURRENCE-ID L
                      {ov.block.propLines['RECURRENCE-ID']?.[0] ?? '?'}）
                    </div>
                  </label>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function freqOf(m: MasterSeries): string {
  const r = m.rrule;
  if (!r) return '';
  return `${r.freq}${r.interval > 1 ? `×${r.interval}` : ''}${r.count ? `;COUNT=${r.count}` : ''}${
    r.until ? `;UNTIL=${r.until.toString()}` : ''
  }`;
}

function tzidOf(m: MasterSeries): string | null {
  const z = m.dtstart.zone;
  // floating / 全天按 UTC 还原墙钟（ical.js 以 UTC 解释）
  if (!z || z.tzid === 'floating') return 'UTC';
  return z.tzid;
}

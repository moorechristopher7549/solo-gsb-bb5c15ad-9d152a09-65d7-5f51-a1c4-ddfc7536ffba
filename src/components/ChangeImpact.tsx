import { useMemo, useState } from 'react';
import type { Instance } from '../ical-engine/types';
import {
  CHANGE_LABEL,
  FIELD_LABEL,
  type ChangeKind,
  type FieldChange,
  type InstanceChange,
} from '../ical-engine/diff';
import { formatWall } from '../utils/format';

interface ChangeImpactProps {
  changes: InstanceChange[];
  /** 当前全局选中实例的身份键（uid#recurrenceKey），用于行高亮 */
  selectedIdentity: string | null;
  onSelectChange: (change: InstanceChange) => void;
}

const FILTER_KINDS: ChangeKind[] = [
  'added',
  'removed',
  'start-moved',
  'end-moved',
  'summary',
  'location',
  'status',
];

export function ChangeImpact({ changes, selectedIdentity, onSelectChange }: ChangeImpactProps) {
  const [filter, setFilter] = useState<ChangeKind | 'all'>('all');

  const counts = useMemo(() => {
    const map = new Map<ChangeKind, number>();
    for (const c of changes) for (const k of c.kinds) map.set(k, (map.get(k) ?? 0) + 1);
    return map;
  }, [changes]);

  const rows = useMemo(
    () => (filter === 'all' ? changes : changes.filter((c) => c.kinds.includes(filter))),
    [changes, filter]
  );

  return (
    <>
      <div className="filter-bar diff-filter">
        <button
          className={filter === 'all' ? 'chip active' : 'chip'}
          onClick={() => setFilter('all')}
        >
          全部（{changes.length}）
        </button>
        {FILTER_KINDS.map((k) => (
          <button
            key={k}
            className={`chip ${k} ${filter === k ? 'active' : ''}`}
            onClick={() => setFilter(k)}
            disabled={!counts.has(k)}
          >
            {CHANGE_LABEL[k]}（{counts.get(k) ?? 0}）
          </button>
        ))}
      </div>

      {changes.length === 0 ? (
        <div className="empty-hint diff-empty">
          <div style={{ fontSize: 28, marginBottom: 6 }}>🟰</div>
          当前范围内没有有效改动
          <div className="clock" style={{ marginTop: 4 }}>
            编辑 RRULE 或停用例外后，这里会立即重算新增 / 移除 / 移动与字段变化
          </div>
        </div>
      ) : (
        <div className="diff-list">
          {rows.map((c) => (
            <DiffRow
              key={c.identity}
              change={c}
              selected={selectedIdentity === c.identity}
              onClick={() => onSelectChange(c)}
            />
          ))}
          {rows.length === 0 && (
            <div className="empty-hint">该变更类型下没有匹配项</div>
          )}
        </div>
      )}
    </>
  );
}

function DiffRow({
  change,
  selected,
  onClick,
}: {
  change: InstanceChange;
  selected: boolean;
  onClick: () => void;
}) {
  const { before, after } = change;
  const tzid = before?.tzid ?? after?.tzid ?? null;
  const allDay = before?.isAllDay ?? after?.isAllDay ?? false;
  const summary = after?.summary ?? before?.summary ?? '';
  const identityTime = formatWall(change.recurrenceKey, tzid, allDay);

  return (
    <div
      className={`diff-row ${change.kinds[0]} ${selected ? 'selected' : ''}`}
      onClick={onClick}
    >
      <div className="diff-head">
        <span className={`diff-badge ${change.kinds[0]}`}>{CHANGE_LABEL[change.kinds[0]]}</span>
        {change.kinds.slice(1).map((k) => (
          <span key={k} className={`diff-mini ${k}`}>
            {CHANGE_LABEL[k]}
          </span>
        ))}
        <span className="diff-title">{summary || '（无标题）'}</span>
        <span className="diff-uid" title={change.uid}>
          {change.uid}
        </span>
      </div>
      <div className="diff-ident clock">
        原始 recurrence key：{identityTime}
        <span className="diff-key-mono">{change.identity}</span>
      </div>
      {change.kinds[0] === 'added' && after && (
        <div className="diff-fields">
          <FieldLine
            label="生效"
            value={`${formatWall(after.startUtc, tzid, allDay)} · ${textOrBlank(after.summary)}`}
            note="（原始日历中不存在）"
            tone="after"
          />
        </div>
      )}
      {change.kinds[0] === 'removed' && before && (
        <div className="diff-fields">
          <FieldLine
            label="原值"
            value={`${formatWall(before.startUtc, tzid, allDay)} · ${textOrBlank(before.summary)}`}
            note="（生效列表中已不存在）"
            tone="before"
          />
        </div>
      )}
      {before && after && (
        <div className="diff-fields">
          {change.fields.map((f) => (
            <FieldDiff key={f.field} fc={f} before={before} after={after} />
          ))}
        </div>
      )}
    </div>
  );
}

function FieldDiff({
  fc,
  before,
  after,
}: {
  fc: FieldChange;
  before: Instance;
  after: Instance;
}) {
  const isTime = fc.field === 'start' || fc.field === 'end';
  return (
    <div className="field-diff">
      <span className="field-name">{FIELD_LABEL[fc.field]}</span>
      {isTime ? (
        <>
          <span className="val before">{formatWall(Number(fc.before), before.tzid, before.isAllDay)}</span>
          <span className="arrow">→</span>
          <span className="val after">{formatWall(Number(fc.after), after.tzid, after.isAllDay)}</span>
        </>
      ) : (
        <>
          <span className="val before">{textOrBlank(String(fc.before))}</span>
          <span className="arrow">→</span>
          <span className="val after">{textOrBlank(String(fc.after))}</span>
        </>
      )}
    </div>
  );
}

function FieldLine({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note: string;
  tone: 'before' | 'after';
}) {
  return (
    <div className="field-diff">
      <span className="field-name">{label}</span>
      <span className={`val ${tone}`}>{value}</span>
      <span className="clock">{note}</span>
    </div>
  );
}

function textOrBlank(s: string): string {
  return s.trim() ? s : '（空）';
}

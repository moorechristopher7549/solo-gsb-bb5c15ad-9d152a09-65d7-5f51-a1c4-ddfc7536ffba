// 变更影响比对
// 比较“原始日历”与“规则编辑 / 例外停用后”的生效实例（仅当前查询范围内的 visible 实例）。
// 实例身份：UID + 原始 recurrence key（覆盖实例取 RECURRENCE-ID，普通实例取原始起点）。
// 因此覆盖改期只标记为“移动”，不会被误报成一删一增。

import type { Instance } from './types';

export type ChangeKind =
  | 'added' // 仅生效（候选）侧存在
  | 'removed' // 仅原始侧存在
  | 'start-moved'
  | 'end-moved'
  | 'summary'
  | 'location'
  | 'status';

export type DiffField = 'start' | 'end' | 'summary' | 'location' | 'status';

export interface FieldChange {
  field: DiffField;
  kind: ChangeKind;
  /** 文本字段为字符串；开始/结束字段为 unix 秒（number），由 UI 按时区渲染墙钟 */
  before: string | number;
  after: string | number;
}

export interface InstanceChange {
  /** 身份：uid + 原始 recurrence key */
  identity: string;
  uid: string;
  /** 原始 recurrence key（unix 秒） */
  recurrenceKey: number;
  /** 该身份上的全部变更类型（新增/移除为单元素） */
  kinds: ChangeKind[];
  /** 字段级前后值（modified 时非空） */
  fields: FieldChange[];
  before: Instance | null;
  after: Instance | null;
}

/** 实例身份键：UID + 原始 recurrence key */
export function instanceIdentity(inst: Instance): string {
  return `${inst.uid}#${inst.recurrenceKey}`;
}

export const CHANGE_LABEL: Record<ChangeKind, string> = {
  added: '新增',
  removed: '移除',
  'start-moved': '开始移动',
  'end-moved': '结束移动',
  summary: '标题',
  location: '地点',
  status: '状态',
};

/** 字段中文名 */
export const FIELD_LABEL: Record<DiffField, string> = {
  start: '开始',
  end: '结束',
  summary: '标题',
  location: '地点',
  status: '状态',
};

function normText(s: string): string {
  return s.trim();
}

/**
 * 比较两份生效实例集合。
 * @param baseline 原始日历展开结果（无规则编辑、无例外停用）
 * @param current  当前编辑状态下的展开结果
 */
export function diffInstances(baseline: Instance[], current: Instance[]): InstanceChange[] {
  const baseMap = new Map<string, Instance>();
  for (const inst of baseline) {
    const id = instanceIdentity(inst);
    if (!baseMap.has(id)) baseMap.set(id, inst);
  }
  const curMap = new Map<string, Instance>();
  for (const inst of current) {
    const id = instanceIdentity(inst);
    if (!curMap.has(id)) curMap.set(id, inst);
  }

  const changes: InstanceChange[] = [];

  for (const [id, after] of curMap) {
    const before = baseMap.get(id);
    if (!before) {
      changes.push({
        identity: id,
        uid: after.uid,
        recurrenceKey: after.recurrenceKey,
        kinds: ['added'],
        fields: [],
        before: null,
        after,
      });
    } else {
      const fields = compareFields(before, after);
      if (fields.length > 0) {
        changes.push({
          identity: id,
          uid: before.uid,
          recurrenceKey: before.recurrenceKey,
          kinds: fields.map((f) => f.kind),
          fields,
          before,
          after,
        });
      }
    }
  }

  for (const [id, before] of baseMap) {
    if (!curMap.has(id)) {
      changes.push({
        identity: id,
        uid: before.uid,
        recurrenceKey: before.recurrenceKey,
        kinds: ['removed'],
        fields: [],
        before,
        after: null,
      });
    }
  }

  changes.sort((a, b) => {
    const ta = a.after?.startUtc ?? a.before?.startUtc ?? 0;
    const tb = b.after?.startUtc ?? b.before?.startUtc ?? 0;
    return ta - tb || a.uid.localeCompare(b.uid);
  });
  return changes;
}

function compareFields(before: Instance, after: Instance): FieldChange[] {
  const out: FieldChange[] = [];
  if (before.startUtc !== after.startUtc) {
    out.push({ field: 'start', kind: 'start-moved', before: before.startUtc, after: after.startUtc });
  }
  if (before.endUtc !== after.endUtc) {
    out.push({ field: 'end', kind: 'end-moved', before: before.endUtc, after: after.endUtc });
  }
  if (normText(before.summary) !== normText(after.summary)) {
    out.push({ field: 'summary', kind: 'summary', before: before.summary, after: after.summary });
  }
  if (normText(before.location) !== normText(after.location)) {
    out.push({ field: 'location', kind: 'location', before: before.location, after: after.location });
  }
  const sb = (before.status || '').toUpperCase();
  const sa = (after.status || '').toUpperCase();
  if (sb !== sa) {
    out.push({ field: 'status', kind: 'status', before: before.status, after: after.status });
  }
  return out;
}

// LOCATION 维度的实例重叠检测
// 规则：同一非空 LOCATION 下，半开区间 [start, end) 相交即冲突；
// 仅对当前生效（未排除、未取消）的实例检测；全天事件同样参与。

import type { ConflictGroup, Instance } from './types';

export interface ConflictResult {
  /** 冲突组（按 LOCATION 排序） */
  groups: ConflictGroup[];
  /** 实例 key(seriesId + start) -> 同组冲突实例 */
  byKey: Map<string, Instance[]>;
}

export function instanceId(inst: Instance): string {
  return `${inst.seriesId}@${inst.startUtc}`;
}

export function detectConflicts(instances: Instance[]): ConflictResult {
  const byLocation = new Map<string, Instance[]>();
  for (const inst of instances) {
    const loc = inst.location.trim();
    if (!loc) continue;
    const arr = byLocation.get(loc);
    if (arr) arr.push(inst);
    else byLocation.set(loc, [inst]);
  }

  const groups: ConflictGroup[] = [];
  const byKey = new Map<string, Instance[]>();

  for (const [location, arr] of byLocation) {
    if (arr.length < 2) continue;
    arr.sort((a, b) => a.startUtc - b.startUtc || b.endUtc - a.endUtc);

    // 连通分量：与当前组任一区间重叠的归入同一冲突组
    let group: Instance[] = [];
    let groupEnd = -Infinity;

    const flush = (): void => {
      if (group.length >= 2) {
        groups.push({ location, instances: [...group] });
        for (const a of group) {
          const peers = group.filter((b) => b !== a && a.startUtc < b.endUtc && b.startUtc < a.endUtc);
          if (peers.length > 0) byKey.set(instanceId(a), peers);
        }
      }
    };

    for (const inst of arr) {
      if (group.length > 0 && inst.startUtc >= groupEnd) {
        flush();
        group = [];
        groupEnd = -Infinity;
      }
      group.push(inst);
      groupEnd = Math.max(groupEnd, inst.endUtc);
    }
    flush();
  }

  groups.sort((a, b) => a.location.localeCompare(b.location));
  return { groups, byKey };
}

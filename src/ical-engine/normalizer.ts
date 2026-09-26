// 规范化导出
// - 仅输出当前仍生效的主 VEVENT 与其例外（停用的例外不导出）
// - 主事件的 RRULE 使用编辑后的文本
// - 汇总被引用的 VTIMEZONE（原文自带 + 运行时合成），按 TZID 去重
// - 输出 CRLF、RFC 5545 折行，事件按 UID + RECURRENCE-ID 排序

import ICAL from 'ical.js';
import type { EngineState, MasterSeries, ParsedCalendar } from './types';

const PRODID = '-//Recur Inspector//Normalized iCalendar//CN';

function cloneComp(comp: ICAL.Component): ICAL.Component {
  return new ICAL.Component(JSON.parse(JSON.stringify(comp.toJSON())) as any[]);
}

/** 递归收集组件（含子组件）所有属性上的 TZID 引用 */
function collectTzids(comp: ICAL.Component, out: Set<string>): void {
  for (const prop of comp.getAllProperties()) {
    const jcal = prop.toJSON() as [string, Record<string, unknown>, string, ...unknown[]];
    const params = jcal[1] || {};
    const tzid = params.tzid ?? params.TZID;
    if (typeof tzid === 'string') out.add(tzid);
  }
  for (const sub of comp.getAllSubcomponents()) collectTzids(sub, out);
}

/** 用编辑后的 RRULE 替换主组件中的 RRULE，并将其置于 DTSTART 之后 */
function applyRrule(master: MasterSeries, comp: ICAL.Component, state: EngineState): void {
  const edited = state.editedRrule[master.id];
  if (edited === undefined) return;

  // 删除既有 RRULE
  const existing = comp.getAllProperties('rrule');
  for (const prop of existing) comp.removeProperty(prop);

  const trimmed = edited.trim();
  if (trimmed === '') return; // 规则被清空：导出无规则事件

  const newProp = ICAL.Property.fromString(
    `RRULE:${trimmed.startsWith('RRULE:') ? trimmed.slice(6) : trimmed}`
  );
  const propsArr = comp.jCal[1] as any[];
  const dtstartIdx = propsArr.findIndex((p) => Array.isArray(p) && p[0] === 'dtstart');
  const newJCal = newProp.toJSON();
  if (dtstartIdx >= 0) propsArr.splice(dtstartIdx + 1, 0, newJCal);
  else propsArr.unshift(newJCal);
}

export interface NormalizeResult {
  ics: string;
  eventCount: number;
  timezoneCount: number;
}

export function normalizeCalendar(calendar: ParsedCalendar, state: EngineState): NormalizeResult {
  const root = new ICAL.Component(['vcalendar', [], []]);
  root.updatePropertyWithValue('version', '2.0');
  root.updatePropertyWithValue('prodid', PRODID);
  root.updatePropertyWithValue('calscale', 'GREGORIAN');

  // 事件组件：按 UID 分组排序，主事件在例外之前
  type Item = { uid: string; hasRecur: boolean; recurKey: number; comp: ICAL.Component };
  const items: Item[] = [];
  const disabled = state.disabledOverrides;

  for (const master of calendar.masters) {
    const masterComp = cloneComp(master.block.component);
    applyRrule(master, masterComp, state);
    items.push({ uid: master.uid, hasRecur: false, recurKey: -1, comp: masterComp });

    for (const ov of master.overrides) {
      if (disabled.has(ov.id)) continue;
      items.push({
        uid: master.uid,
        hasRecur: true,
        recurKey: Math.round(ov.recurrenceId.toUnixTime()),
        comp: cloneComp(ov.block.component),
      });
    }
  }

  items.sort((a, b) =>
    a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : a.hasRecur === b.hasRecur ? a.recurKey - b.recurKey : a.hasRecur ? 1 : -1
  );

  // 汇总 VTIMEZONE
  const neededTzids = new Set<string>();
  for (const item of items) collectTzids(item.comp, neededTzids);

  const tzAdded = new Set<string>();
  const originalByTzid = new Map<string, ICAL.Component>();
  for (const block of calendar.vtimezoneBlocks) {
    const tzid = block.component.getFirstPropertyValue('tzid');
    if (typeof tzid === 'string' && !originalByTzid.has(tzid)) originalByTzid.set(tzid, block.component);
  }

  for (const tzid of neededTzids) {
    if (tzAdded.has(tzid)) continue;
    const original = originalByTzid.get(tzid);
    if (original) {
      root.addSubcomponent(cloneComp(original));
      tzAdded.add(tzid);
      continue;
    }
    const zone = ICAL.TimezoneService.get(tzid);
    if (zone && zone.component) {
      root.addSubcomponent(cloneComp(zone.component));
      tzAdded.add(tzid);
    }
  }

  for (const item of items) root.addSubcomponent(item.comp);

  return {
    ics: root.toString(),
    eventCount: items.length,
    timezoneCount: tzAdded.size,
  };
}

// 领域模型：解析 / 展开 / 冲突 相关的全部类型定义

import ICAL from 'ical.js';

export type IcalComponent = InstanceType<typeof ICAL.Component>;
export type IcalTime = InstanceType<typeof ICAL.Time>;
export type IcalRecur = InstanceType<typeof ICAL.Recur>;
export type IcalDuration = InstanceType<typeof ICAL.Duration>;
export type IcalProperty = InstanceType<typeof ICAL.Property>;

export interface LineRange {
  /** 起始逻辑行号（从 1 开始，已折叠续行） */
  start: number;
  /** 结束逻辑行号（含） */
  end: number;
}

/** 一个 VEVENT 组件的原始块信息 */
export interface VEventBlock {
  component: IcalComponent;
  /** 组件名（VEVENT） */
  kind: string;
  /** VEVENT BEGIN..END 的原文行范围 */
  range: LineRange;
  /** 关键属性行号表：属性名 -> 行号（同名属性取数组） */
  propLines: Record<string, number[]>;
  /** 该组件在文档中的出现序号（用于稳定 id 与主子匹配兜底） */
  order: number;
}

export interface Warning {
  id: string;
  level: 'error' | 'warn' | 'info';
  text: string;
  line?: number;
}

export interface MasterSeries {
  /** 稳定 id：uid 或合成 id */
  id: string;
  uid: string;
  block: VEventBlock;
  summary: string;
  location: string;
  description: string;
  status: string;
  dtstart: IcalTime;
  durationSec: number;
  isAllDay: boolean;
  rrule: IcalRecur | null;
  rruleLine: number;
  /** RRULE 原文，供编辑回填 */
  rruleRaw: string;
  rdates: { time: IcalTime; end: IcalTime | null; line: number }[];
  exdates: { time: IcalTime; end: IcalTime | null; line: number }[];
  overrides: OverrideEvent[];
}

export interface OverrideEvent {
  id: string;
  block: VEventBlock;
  /** RECURRENCE-ID 对应的时间（以原序列本地墙钟为准） */
  recurrenceId: IcalTime;
  dtstart: IcalTime;
  dtend: IcalTime | null;
  durationSec: number;
  isAllDay: boolean;
  summary: string;
  location: string;
  description: string;
  status: string;
  cancelled: boolean;
}

export interface ParsedCalendar {
  root: IcalComponent;
  /** 未折行的逻辑行数组（索引 0 即第 1 行） */
  logicalLines: string[];
  vtimezoneBlocks: VEventBlock[];
  masters: MasterSeries[];
  warnings: Warning[];
  /** 解析期注册过的 TZID，规范化导出时用于挑选需要的 VTIMEZONE */
  registeredTzids: string[];
}

export type InstanceSource =
  | 'rrule'
  | 'rdate'
  | 'override'
  | 'single';

export interface Instance {
  /** 同组内稳定 key：recurrenceId 的 unix 秒 */
  key: number;
  /**
   * 实例身份用的原始 recurrence key（unix 秒）：
   * 普通 RRULE/RDATE/单次实例取其原始起点；覆盖实例取 RECURRENCE-ID 对应时刻。
   * 覆盖改期后 startUtc 变化，但 recurrenceKey 不变，变更比对据此识别“移动”而非一删一增。
   */
  recurrenceKey: number;
  seriesId: string;
  uid: string;
  /** 实例原始起点（按声明时区解释）绝对时间，秒 */
  startUtc: number;
  /** 实例原始终点绝对时间，秒 */
  endUtc: number;
  /** 声明时区 id（UTC 事件为 'UTC'，floating 为 null） */
  tzid: string | null;
  /** 该实例起点在声明时区中的 UTC 偏移（秒），null 表示浮动时间；跨 DST 时随实例变化 */
  utcOffsetSec: number | null;
  /** 事件声明的本地时刻（墙钟），HH:MM */
  localClock: string;
  isAllDay: boolean;
  summary: string;
  location: string;
  status: string;
  source: InstanceSource;
  /** 是否被 EXDATE 排除（审计视图使用） */
  excluded: boolean;
  /** 是否被 CANCELLED 例外取消（审计视图使用） */
  cancelled: boolean;
  /** 是否由被停用的例外覆盖（显示为"原实例"） */
  overrideDisabled: boolean;
  override?: OverrideEvent;
  /** 所属规则（主组件）行范围 */
  masterRange: LineRange;
  /** 定位用：RRULE 行 / RDATE 行 / EXDATE 行 / RECURRENCE-ID 行 */
  originLine: number;
  /** 该实例若为例外，点击后应定位到的 VEVENT 块 */
  overrideRange?: LineRange;
  /** 孤立覆盖（在展开范围内找不到原实例） */
  orphan?: boolean;
}

export interface ExpansionResult {
  instances: Instance[];
  cancelled: Instance[];
  excluded: Instance[];
  warnings: Warning[];
  /** 编辑后 RRULE 解析失败：seriesId -> 错误信息 */
  rruleErrors: Record<string, string>;
}

export interface ConflictGroup {
  location: string;
  /** 互相重叠的实例（时间已排序） */
  instances: Instance[];
}

export interface EngineState {
  /** 被停用的例外 id 集合（recurrenceId 派生） */
  disabledOverrides: Set<string>;
  /** 编辑后的 RRULE 原文（null 表示保持原文） */
  editedRrule: Record<string, string>;
}

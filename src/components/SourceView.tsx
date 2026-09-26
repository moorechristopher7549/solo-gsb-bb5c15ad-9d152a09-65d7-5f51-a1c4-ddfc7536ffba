import { useEffect, useRef } from 'react';

interface SourceViewProps {
  lines: string[];
  /** 主事件块行范围 */
  masterRange?: { start: number; end: number };
  /** 关键属性行 */
  originLine?: number;
  /** 例外块行范围 */
  overrideRange?: { start: number; end: number };
  /** 定位到冲突方时需要高亮的块 */
  highlightRanges?: { start: number; end: number; kind: 'conflict' }[];
  /** 外部直接指定高亮行（如告警点击） */
  focusLine?: number;
  /** 当前选中实例 key，用于触发滚动 */
  scrollToken?: string;
}

export function SourceView({
  lines,
  masterRange,
  originLine,
  overrideRange,
  highlightRanges = [],
  focusLine,
  scrollToken,
}: SourceViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const focusRef = useRef<HTMLDivElement>(null);

  const targetLine = focusLine ?? originLine ?? masterRange?.start;

  useEffect(() => {
    const el = focusRef.current ?? containerRef.current?.querySelector('[data-focus="true"]');
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [scrollToken, targetLine]);

  const inRange = (lineNo: number, r?: { start: number; end: number }): boolean =>
    !!r && lineNo >= r.start && lineNo <= r.end;

  const conflictLines = new Set<number>();
  for (const hr of highlightRanges) {
    for (let l = hr.start; l <= hr.end; l++) conflictLines.add(l);
  }

  return (
    <div className="source-view" ref={containerRef}>
      {lines.map((text, idx) => {
        const lineNo = idx + 1;
        const classes = ['source-line'];
        if (inRange(lineNo, overrideRange)) classes.push('override-block');
        else if (inRange(lineNo, masterRange)) classes.push('block');
        if (lineNo === originLine || lineNo === focusLine) classes.push('origin');
        if (conflictLines.has(lineNo)) classes.push('conflict-line');
        return (
          <div
            key={lineNo}
            className={classes.join(' ')}
            data-focus={lineNo === targetLine || undefined}
            ref={lineNo === targetLine ? focusRef : undefined}
          >
            <span className="ln">{lineNo}</span>
            <span className="code">{text || ' '}</span>
          </div>
        );
      })}
    </div>
  );
}

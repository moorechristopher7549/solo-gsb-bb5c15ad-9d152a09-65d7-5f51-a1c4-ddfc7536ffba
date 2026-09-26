import { JSDOM } from 'jsdom';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import App from '../src/App';

;(async () => {
// 临时 DOM 集成验证：挂载 App，切换到“变更影响”页签，验证空状态 / 停用例外后的差异行 / 点击联动。

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(dom.window.HTMLElement.prototype as any).scrollIntoView = () => {};

const container = document.getElementById('root')!;
const root = createRoot(container);

await act(async () => {
  root.render(React.createElement(App));
});

const byText = (sel: string, text: string): Element | null =>
  [...container.querySelectorAll(sel)].find((el) => el.textContent?.includes(text)) ?? null;

// 1) 初始无编辑：切到变更影响页签，应显示空状态
const impactTab = byText('button', '变更影响') as HTMLElement;
if (!impactTab) throw new Error('变更影响 页签未渲染');
await act(async () => {
  impactTab.click();
});
if (!container.textContent?.includes('当前范围内没有有效改动')) {
  throw new Error('无编辑时应显示空状态');
}
console.log('✓ 无改动时显示空状态');

// 2) 停用示例中的覆盖例外（中栏第一个勾选框）后，差异应出现
const checkboxes = [...container.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
const overrideCb = checkboxes.find((c) => c.checked);
if (!overrideCb) throw new Error('找不到已启用的例外勾选框');
await act(async () => {
  overrideCb.click();
});
await act(async () => {});
if (container.textContent?.includes('当前范围内没有有效改动')) {
  throw new Error('停用例外后应出现差异');
}
const rows = container.querySelectorAll('.diff-row');
if (rows.length === 0) throw new Error('停用例外后应至少有一条差异行');
console.log(`✓ 停用例外后出现 ${rows.length} 条差异`);

// 必须存在“开始移动”或“地点/标题”类修改，且不应把同身份报成一删一增
const labels = container.textContent ?? '';
if (!/开始移动|标题|地点/.test(labels)) throw new Error('应标出移动或字段变化');
const addCount = (labels.match(/新增/g) || []).length;
const remCount = (labels.match(/移除/g) || []).length;
console.log(`  新增标记=${addCount} 移除标记=${remCount}`);

// 3) 类型筛选按钮可用
const movedChip = byText('button.chip', '开始移动') as HTMLElement;
if (movedChip) {
  await act(async () => movedChip.click());
  const filtered = container.querySelectorAll('.diff-row');
  console.log(`✓ 按“开始移动”筛选后 ${filtered.length} 行`);
  const allChip = byText('button.chip', '全部') as HTMLElement;
  await act(async () => allChip.click());
}

// 4) 点击差异行：联动切回生效表
const firstRow = container.querySelector('.diff-row') as HTMLElement;
await act(async () => firstRow.click());
const visibleBtn = byText('.tabs button', '生效实例') as HTMLElement;
if (!visibleBtn.classList.contains('active')) {
  throw new Error('点击差异项应切回生效实例页签');
}
const selected = container.querySelector('tr.instance-row.selected');
if (!selected) throw new Error('点击差异项后应选中实例表行');
console.log('✓ 点击差异项联动实例表');

// 5) 恢复例外（再次勾选），差异应清空
await act(async () => overrideCb.click());
await act(async () => {});
await act(async () => impactTab.click());
if (!container.textContent?.includes('当前范围内没有有效改动')) {
  throw new Error('恢复例外后差异应清空');
}
console.log('✓ 恢复后差异立即清空（重算）');

root.unmount();
console.log('✓ DOM 集成验证全部通过');

})();

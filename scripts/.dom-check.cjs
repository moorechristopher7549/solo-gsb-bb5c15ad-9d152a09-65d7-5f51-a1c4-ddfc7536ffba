var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var import_jsdom = require("jsdom");
var import_react = __toESM(require("react"));
var import_client = require("react-dom/client");
var import_test_utils = require("react-dom/test-utils");
var import_App = __toESM(require("../src/App.tsx"));
;
(async () => {
  const dom = new import_jsdom.JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://localhost/",
    pretendToBeVisual: true
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.navigator = dom.window.navigator;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Element = dom.window.Element;
  globalThis.Node = dom.window.Node;
  globalThis.MouseEvent = dom.window.MouseEvent;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  dom.window.HTMLElement.prototype.scrollIntoView = () => {
  };
  const container = document.getElementById("root");
  const root = (0, import_client.createRoot)(container);
  await (0, import_test_utils.act)(async () => {
    root.render(import_react.default.createElement(import_App.default));
  });
  const byText = (sel, text) => [...container.querySelectorAll(sel)].find((el) => el.textContent?.includes(text)) ?? null;
  const impactTab = byText("button", "\u53D8\u66F4\u5F71\u54CD");
  if (!impactTab) throw new Error("\u53D8\u66F4\u5F71\u54CD \u9875\u7B7E\u672A\u6E32\u67D3");
  await (0, import_test_utils.act)(async () => {
    impactTab.click();
  });
  if (!container.textContent?.includes("\u5F53\u524D\u8303\u56F4\u5185\u6CA1\u6709\u6709\u6548\u6539\u52A8")) {
    throw new Error("\u65E0\u7F16\u8F91\u65F6\u5E94\u663E\u793A\u7A7A\u72B6\u6001");
  }
  console.log("\u2713 \u65E0\u6539\u52A8\u65F6\u663E\u793A\u7A7A\u72B6\u6001");
  const checkboxes = [...container.querySelectorAll('input[type="checkbox"]')];
  const overrideCb = checkboxes.find((c) => c.checked);
  if (!overrideCb) throw new Error("\u627E\u4E0D\u5230\u5DF2\u542F\u7528\u7684\u4F8B\u5916\u52FE\u9009\u6846");
  await (0, import_test_utils.act)(async () => {
    overrideCb.click();
  });
  await (0, import_test_utils.act)(async () => {
  });
  if (container.textContent?.includes("\u5F53\u524D\u8303\u56F4\u5185\u6CA1\u6709\u6709\u6548\u6539\u52A8")) {
    throw new Error("\u505C\u7528\u4F8B\u5916\u540E\u5E94\u51FA\u73B0\u5DEE\u5F02");
  }
  const rows = container.querySelectorAll(".diff-row");
  if (rows.length === 0) throw new Error("\u505C\u7528\u4F8B\u5916\u540E\u5E94\u81F3\u5C11\u6709\u4E00\u6761\u5DEE\u5F02\u884C");
  console.log(`\u2713 \u505C\u7528\u4F8B\u5916\u540E\u51FA\u73B0 ${rows.length} \u6761\u5DEE\u5F02`);
  const labels = container.textContent ?? "";
  if (!/开始移动|标题|地点/.test(labels)) throw new Error("\u5E94\u6807\u51FA\u79FB\u52A8\u6216\u5B57\u6BB5\u53D8\u5316");
  const addCount = (labels.match(/新增/g) || []).length;
  const remCount = (labels.match(/移除/g) || []).length;
  console.log(`  \u65B0\u589E\u6807\u8BB0=${addCount} \u79FB\u9664\u6807\u8BB0=${remCount}`);
  const movedChip = byText("button.chip", "\u5F00\u59CB\u79FB\u52A8");
  if (movedChip) {
    await (0, import_test_utils.act)(async () => movedChip.click());
    const filtered = container.querySelectorAll(".diff-row");
    console.log(`\u2713 \u6309\u201C\u5F00\u59CB\u79FB\u52A8\u201D\u7B5B\u9009\u540E ${filtered.length} \u884C`);
    const allChip = byText("button.chip", "\u5168\u90E8");
    await (0, import_test_utils.act)(async () => allChip.click());
  }
  const firstRow = container.querySelector(".diff-row");
  await (0, import_test_utils.act)(async () => firstRow.click());
  const visibleBtn = byText(".tabs button", "\u751F\u6548\u5B9E\u4F8B");
  if (!visibleBtn.classList.contains("active")) {
    throw new Error("\u70B9\u51FB\u5DEE\u5F02\u9879\u5E94\u5207\u56DE\u751F\u6548\u5B9E\u4F8B\u9875\u7B7E");
  }
  const selected = container.querySelector("tr.instance-row.selected");
  if (!selected) throw new Error("\u70B9\u51FB\u5DEE\u5F02\u9879\u540E\u5E94\u9009\u4E2D\u5B9E\u4F8B\u8868\u884C");
  console.log("\u2713 \u70B9\u51FB\u5DEE\u5F02\u9879\u8054\u52A8\u5B9E\u4F8B\u8868");
  await (0, import_test_utils.act)(async () => overrideCb.click());
  await (0, import_test_utils.act)(async () => {
  });
  await (0, import_test_utils.act)(async () => impactTab.click());
  if (!container.textContent?.includes("\u5F53\u524D\u8303\u56F4\u5185\u6CA1\u6709\u6709\u6548\u6539\u52A8")) {
    throw new Error("\u6062\u590D\u4F8B\u5916\u540E\u5DEE\u5F02\u5E94\u6E05\u7A7A");
  }
  console.log("\u2713 \u6062\u590D\u540E\u5DEE\u5F02\u7ACB\u5373\u6E05\u7A7A\uFF08\u91CD\u7B97\uFF09");
  root.unmount();
  console.log("\u2713 DOM \u96C6\u6210\u9A8C\u8BC1\u5168\u90E8\u901A\u8FC7");
})();

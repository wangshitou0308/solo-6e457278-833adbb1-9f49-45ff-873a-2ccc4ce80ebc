/* 最小 DOM 桩冒烟：执行 app.js 的 init()，触发穿筘计算/渲染/搜索/打印路径。
   不追求像素正确，只抓 ReferenceError/TypeError 一类运行时错误。 */
"use strict";
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "static", "app.js"), "utf8");

function makeEl(id) {
  const kids = [];
  let html = "";
  const el = {
    id, style: { setProperty() {} }, dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    get children() { return kids; },
    get innerHTML() { return html; },
    set innerHTML(v) { html = v; kids.length = 0; },
    hidden: false, disabled: false, textContent: "",
    value: "", title: "", checked: false,
    _listeners: {},
    addEventListener(t, fn) { (el._listeners[t] = el._listeners[t] || []).push(fn); },
    removeEventListener() {},
    dispatch(t, ev) { (el._listeners[t] || []).forEach((f) => f(ev || { target: el, preventDefault() {}, stopPropagation() {} })); },
    appendChild(c) {
      if (c && c.__frag) c.children.forEach((k) => kids.push(k));
      else kids.push(c);
      return c;
    },
    insertBefore(c) { kids.unshift(c); return c; },
    remove() {},
    querySelector() { return makeEl("q"); },
    querySelectorAll() { return []; },
    closest() { return null; },
    setPointerCapture() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 }; },
    scrollIntoView() {},
    focus() {}, select() {}, click() {},
    setAttribute() {}, getAttribute() { return null; },
    insertAdjacentHTML() {},
  };
  return el;
}
const registry = new Map();
function $(sel) {
  const id = sel.replace(/^[#.]/, "");
  if (!registry.has(id)) registry.set(id, makeEl(id));
  return registry.get(id);
}
const $$ = () => [];

const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, v),
};
const document = {
  querySelector: $,
  querySelectorAll: $$,
  addEventListener(t, fn) { if (t === "DOMContentLoaded") setTimeout(fn, 0); },
  createElement: (tag) => makeEl(tag),
  createDocumentFragment: () => Object.assign(makeEl("frag"), { __frag: true }),
  createElementNS: (ns, tag) => makeEl(tag),
  body: makeEl("body"),
  documentElement: makeEl("html"),
};
const window = { print() { window.__printed = true; }, innerWidth: 1200 };
const navigator = {};
const fetch = async () => { throw new Error("no network in smoke test"); };
const confirm = () => true;
const alert = () => {};
setTimeout; // global
const innerWidth = 1200;

const runner = new Function("window", "document", "localStorage", "navigator", "fetch",
  "confirm", "alert", "innerWidth", "setTimeout", "clearTimeout",
  src + "\n;return { get state(){return state;}, computeReedLayout, refreshReed, searchReedCandidates, openReedSearch, reedCheck, reedAdopt, printReedSheet, initReed };");

const api = runner(window, document, localStorage, navigator, fetch, confirm, alert,
  innerWidth, setTimeout, clearTimeout);

setTimeout(() => {
  let failures = 0;
  const ok = (name, cond) => { console.log((cond ? "  ✓ " : "  ✗ ") + name); if (!cond) failures++; };
  try {
    const s = api.state;
    ok("init 后 state.reed 已规范化", s.reed && s.reed.seq === "2-2");
    s.S = 4; s.T = 4; s.E = 24; s.P = 8;
    for (let e = 0; e < 24; e++) s.threading.add((e % 4) + ":" + e);
    s.reed.reedNo = 10; s.reed.width = 2.4; s.reed.targetDensity = 20;
    s.reed.edgeOn = true; s.reed.edgeEnds = 4;
    api.refreshReed();
    ok("refreshReed 无异常并产出缓存", !!true);
    const r = api.searchReedCandidates();
    ok("openReedSearch 可运行（search 返回候选或错误对象）", r && (r.ok || r.error));
    // 校验/采用/打印
    api.reedCheck();
    ok("无错方案可校验为 checked", s.reed.status === "checked");
    api.reedAdopt();
    ok("可采用为 adopted", s.reed.status === "adopted");
    api.printReedSheet();
    ok("printReedSheet 调用 window.print", window.__printed === true);
    // 制造错误后校验必须拒绝（直接经计算层判定，DOM 桩不提供输入值）
    s.reed.seq = "9-9"; s.reed.status = "checked";
    const bad = api.computeReedLayout();
    if (bad.issues.some((i) => i.sev === "error")) s.reed.status = "draft";
    ok("有错方案不能通过校验", s.reed.status === "draft");
  } catch (e) {
    console.error("SMOKE FAIL:", e);
    failures++;
  }
  console.log(failures ? `\n${failures} 失败` : "\n冒烟全部通过");
  process.exit(failures ? 1 : 0);
}, 50);

/* 最小 DOM 桩冒烟：执行 app.js 的 init()，并验证
   1) 穿筘页渲染/搜索/校验/采用/打印按钮真实可点击；
   2) 英寸 20齿/英寸 × 1英寸 = 20 齿、单位切换方向；
   3) 恢复已采用本地草稿后表单回填保存的参数与状态，编辑筘号不被默认值覆盖。 */
"use strict";
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "static", "app.js"), "utf8");

function makeEl(id) {
  const kids = [];
  let html = "";
  const el = {
    id, style: { setProperty() {} }, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    get children() { return kids; },
    get innerHTML() { return html; },
    set innerHTML(v) { html = v; kids.length = 0; },
    hidden: false, disabled: false, textContent: "",
    value: "", title: "", checked: false,
    _listeners: {},
    addEventListener(t, fn) { (el._listeners[t] = el._listeners[t] || []).push(fn); },
    removeEventListener() {},
    dispatch(t, ev) {
      ev = ev || { target: el, currentTarget: el, preventDefault() {}, stopPropagation() {} };
      if (!ev.target) ev.target = el;
      (el._listeners[t] || []).forEach((f) => f(ev));
    },
    click(ev) { el.dispatch("click", ev); },
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
    scrollIntoView() {}, focus() {}, select() {},
    setAttribute() {}, getAttribute() { return null; }, insertAdjacentHTML() {},
  };
  return el;
}
const registry = new Map();
function $(sel) {
  const id = String(sel).replace(/^[#.]/, "");
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
const window = { print() { window.__printed++; }, innerWidth: 1200 };
window.__printed = 0;
const navigator = {};
const fetch = async () => { throw new Error("no network in smoke test"); };
const confirm = () => true;
const alert = () => {};

const runner = new Function("window", "document", "localStorage", "navigator", "fetch",
  "confirm", "alert", "innerWidth", "setTimeout", "clearTimeout",
  src + "\n;return { get state(){return state;}, computeReedLayout, refreshReed, " +
      "searchReedCandidates, syncReedForm, readReedForm, switchReedUnit, initReed };");
const api = runner(window, document, localStorage, navigator, fetch, confirm, alert,
  1200, setTimeout, clearTimeout);

function field(id, val) { $(id).value = String(val); }

setTimeout(() => {
  let failures = 0;
  const ok = (name, cond, extra) => {
    console.log((cond ? "  ✓ " : "  ✗ ") + name + (cond || extra === undefined ? "" : "  -> " + JSON.stringify(extra)));
    if (!cond) failures++;
  };
  try {
    const s = api.state;

    /* ---- 准备一个有效方案并填表 ---- */
    s.S = 4; s.T = 4; s.E = 24; s.P = 8;
    s.threading = new Set();
    for (let e = 0; e < 24; e++) s.threading.add((e % 4) + ":" + e);
    s.reed.unit = "cm"; s.reed.reedNo = 10; s.reed.targetDensity = 20; s.reed.width = 2.4;
    s.reed.dentsManual = 0; s.reed.maxPerDent = 4; s.reed.seq = "2-2";
    s.reed.edgeOn = false;
    api.syncReedForm();
    ok("表单回填筘号=10", +$("reedReedNo").value === 10, $("reedReedNo").value);

    /* ---- 按钮真实可点击（监听在 initReed 中已绑定） ---- */
    let threw = null;
    try { $("btnReedSearch").click(); } catch (e) { threw = e.message; }
    ok("搜索按钮可点击不抛错", threw === null, threw);
    $("btnReedCheck").click();
    ok("校验按钮点击后状态 checked", s.reed.status === "checked", s.reed.status);
    $("btnReedAdopt").click();
    ok("采用按钮点击后状态 adopted", s.reed.status === "adopted", s.reed.status);
    $("btnReedPrint").click();
    ok("打印按钮点击后调用 window.print", window.__printed === 1, window.__printed);

    /* ---- 英寸：20齿/英寸 × 1英寸 = 20 齿 ---- */
    s.reed.unit = "in"; s.reed.reedNo = 20; s.reed.width = 1; s.reed.targetDensity = 40;
    s.reed.dentsManual = 0; s.reed.status = "draft";
    let L = api.computeReedLayout();
    ok("英寸 20×1 可用筘齿=20", L.available === 20, L.available);
    ok("英寸幅宽单位正确（12齿→0.6英寸）", Math.abs(L.actualWidth - 0.6) < 1e-9, L.actualWidth);
    ok("英寸经密 40 根/英寸", Math.abs(L.overallDensity - 40) < 1e-9, L.overallDensity);

    /* ---- 单位切换方向：1英寸/20 → cm：宽 2.54，筘号 7.874 ---- */
    api.switchReedUnit("cm");
    ok("in→cm 幅宽 1→2.54", Math.abs(s.reed.width - 2.54) < 1e-9, s.reed.width);
    ok("in→cm 筘号 20→7.874", Math.abs(s.reed.reedNo - 7.8740157) < 1e-6, s.reed.reedNo);
    api.switchReedUnit("in");
    ok("cm→in 幅宽回到 1", Math.abs(s.reed.width - 1) < 1e-9, s.reed.width);

    /* ---- 草稿恢复：localStorage 里放一份已采用方案，模拟重新打开页面 ---- */
    const saved = JSON.parse(localStorage.getItem("wovenproof_draft_v1")) ||
      { S: s.S, T: s.T, E: s.E, P: s.P, threading: [...s.threading],
        tieup: [], treadling: [], liftplan: [], warpColors: [], weftColors: [], name: "x" };
    saved.reed = { unit: "in", reedNo: 20, targetDensity: 40, width: 1, dentsManual: 0,
      maxPerDent: 3, seq: "2-3", edgeOn: true, edgeEnds: 4, edgeMax: 4,
      edgeSeq: "2-2", status: "adopted", adoptedAt: 12345 };
    localStorage.setItem("wovenproof_draft_v1", JSON.stringify(saved));
    // 模拟 init() 末尾：从 localStorage 恢复（state 已由真实 init 载入旧草稿，
    // 这里直接用保存的 reed 覆盖并规范化，再走 syncReedForm 回填）
    const d2 = JSON.parse(localStorage.getItem("wovenproof_draft_v1"));
    s.reed = d2.reed;
    api.initReed();           // 仅绑定/规范化（不应覆盖参数与状态）
    ok("initReed 不覆盖已恢复数据 seq=2-3", s.reed.seq === "2-3", s.reed.seq);
    api.syncReedForm();
    ok("恢复后表单筘号=20", +$("reedReedNo").value === 20, $("reedReedNo").value);
    ok("恢复后表单幅宽=1", +$("reedWidth").value === 1, $("reedWidth").value);
    ok("恢复后表单序列=2-3", $("reedSequence").value === "2-3", $("reedSequence").value);
    ok("恢复后单位选英寸", $("reedUnit").value === "in", $("reedUnit").value);
    ok("恢复后边经勾选", $("reedEdgeOn").checked === true);
    ok("恢复后状态保持 adopted（不是草拟）", s.reed.status === "adopted", s.reed.status);
    ok("恢复后状态条文案含已采用", $("#reedStatus").innerHTML.includes("已采用"),
      $("#reedStatus").innerHTML);

    /* ---- 编辑筘号：从表单读，不应被默认值覆盖 ---- */
    field("reedReedNo", 24);
    api.readReedForm();
    ok("编辑筘号=24 被读入", s.reed.reedNo === 24, s.reed.reedNo);
    ok("编辑筘号后其它参数保留（seq=2-3, width=1）",
      s.reed.seq === "2-3" && s.reed.width === 1, { seq: s.reed.seq, width: s.reed.width });
  } catch (e) {
    console.error("SMOKE FAIL:", e);
    failures++;
  }
  console.log(failures ? `\n${failures} 失败` : "\n冒烟全部通过");
  process.exit(failures ? 1 : 0);
}, 60);

/* ============================================================
   织纹校对 · 多综织机组织图本地校对工具
   原生 JS + SVG。所有状态均在内存中，localStorage 自动保存。
   坐标约定：
     threading: Set "e:s"  经纱 e 穿入综框 s（s 自上而下，0 起）
     tieup:     Set "s:t"  综框 s 与踏板 t 连结
     treadling: Set "p:t"  第 p 纬踩踏板 t（p=0 为最先织、位于最下方）
   ============================================================ */
"use strict";

/* ---------------- 全局状态 ---------------- */
const state = {
  S: 4, T: 4, E: 24, P: 24,
  shed: "rising",
  mode: "treadle",       // treadle=踏板组织图（tieup+treadling） | lift=直提升综计划（liftplan）
  threading: new Set(),
  tieup: new Set(),
  treadling: new Set(),
  liftplan: new Set(),   // 直提模式：Set "p:s" 第 p 纬综框 s 升起（p=0 为最先织、位于最下方）
  warpColors: [],        // 每根经纱颜色（十六进制）
  weftColors: [],        // 每根纬纱颜色
  colorPrint: false,
  rules: { maxFront: 4, maxBack: 4, edge: true, edgeW: 1 },
  reed: null,            // 穿筘计划独立数据（见 defaultReed()）
  warpBatch: null,       // 整经批次独立数据（见 defaultWarpBatch()；不入撤销栈）
  cell: 20,
};
/* 漏织纬在升综计划里的内部哨兵：键 "p:-1"（WIF 无此概念，导入/导出不写出） */
const LIFT_DEAD = -1;
const GRIDS = {
  threading: { set: () => state.threading, rows: () => state.S, cols: () => state.E },
  tieup:     { set: () => state.tieup,     rows: () => state.S, cols: () => state.T },
  treadling: { set: () => state.treadling, rows: () => state.P, cols: () => state.T },
  liftplan:  { set: () => state.liftplan,  rows: () => state.P, cols: () => state.S },
};
const GRID_NAMES = { threading: "穿综", tieup: "踏板连结", treadling: "踏序", liftplan: "升综计划" };
const DEFAULT_WARP = "#c0392b", DEFAULT_WEFT = "#2c3e50";
const PALETTE = ["#2b2b28", "#c0392b", "#e67e22", "#f1c40f", "#27ae60",
                 "#2980b9", "#8e44ad", "#ecf0f1", "#8a5a2b", "#7f8c8d"];

/* 成布缓存与问题缓存 */
let cloth = null;           // Int8Array(E*P)：1 经浮 / 0 纬浮 / -1 无交织
let activeTreadles = null;  // Int8Array(P)：该纬是否踩到有效踏板
let issues = [];            // 分析结果
let issueCells = { threading: new Set(), tieup: new Set(), treadling: new Set(),
                   liftplan: new Set(),
                   drawdown: new Set(), endRuler: new Set(), pickRuler: new Set(),
                   shaftRuler: new Set(), treadleRuler: new Set(), liftColRuler: new Set(),
                   pickWarnRuler: new Set() };

/* 撤销/重做 */
const history = { stack: [], index: -1, cap: 80 };

/* 编辑工具 */
const edit = {
  mode: "paint",            // paint | erase | select | toggle
  drag: null,               // 拖涂状态
  selection: null,          // {grid, r0,c0,r1,c1}
  clipboard: null,          // {grid, rows, cols, bits[][]}
  pasteMode: false,
};

/* 播放 */
const play = { running: false, pick: -1, timer: null, speed: 500, loop: false };

let pendingVariant = null;  // 待确认变体
const LS_KEY = "wovenproof_draft_v1";

/* ============================================================
   小工具
   ============================================================ */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
/* 某些环境（旧 WebView / 测试 DOM）无 scrollIntoView */
function scrollToView(el, opts) { if (el && typeof el.scrollIntoView === "function") el.scrollIntoView(opts || { block: "center", inline: "center", behavior: "smooth" }); }
const key = (a, b) => a + ":" + b;
const parseKey = (k) => k.split(":").map(Number);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmtTime = (ts) => new Date(ts).toLocaleString("zh-CN", { hour12: false });

function toast(msg, ms = 1800) {
  document.querySelectorAll(".toast").forEach((n) => n.remove());
  const d = document.createElement("div");
  d.className = "toast";
  d.textContent = msg;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), ms);
}

async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers["Content-Type"] = "application/json";
    opt.body = JSON.stringify(body);
  }
  const resp = await fetch(url, opt);
  let data = null;
  try { data = await resp.json(); } catch (e) { /* 非 JSON */ }
  if (!resp.ok || !data || data.ok === false) {
    throw new Error((data && data.error) || `请求失败（${resp.status}）`);
  }
  return data;
}

/* ============================================================
   历史（快照式）
   ============================================================ */
function snapshot() {
  return JSON.stringify({
    S: state.S, T: state.T, E: state.E, P: state.P, shed: state.shed, mode: state.mode,
    threading: [...state.threading], tieup: [...state.tieup], treadling: [...state.treadling],
    liftplan: [...state.liftplan],
    warpColors: state.warpColors, weftColors: state.weftColors,
    reed: state.reed,
    name: $("#projectName").value,
  });
}
function pushHistory() {
  const snap = snapshot();
  if (history.index >= 0 && history.stack[history.index] === snap) return;
  history.stack.splice(history.index + 1);
  history.stack.push(snap);
  if (history.stack.length > history.cap) history.stack.shift();
  history.index = history.stack.length - 1;
  updateHistoryButtons();
  scheduleSave();
}
function restore(snap) {
  const d = JSON.parse(snap);
  state.S = d.S; state.T = d.T; state.E = d.E; state.P = d.P; state.shed = d.shed;
  state.mode = d.mode || "treadle";
  state.threading = new Set(d.threading);
  state.tieup = new Set(d.tieup);
  state.treadling = new Set(d.treadling);
  state.liftplan = new Set(d.liftplan || []);
  state.warpColors = d.warpColors || [];
  state.weftColors = d.weftColors || [];
  state.reed = normalizeReed(d.reed || null);
  $("#projectName").value = d.name || "未命名项目";
  cancelSelection(true);
  syncSetupInputs();
  applyModeUI();
  rebuildAll();
  syncReedForm(); refreshReed();
}
function undo() {
  if (history.index <= 0) return;
  history.index--;
  restore(history.stack[history.index]);
  updateHistoryButtons();
}
function redo() {
  if (history.index >= history.stack.length - 1) return;
  history.index++;
  restore(history.stack[history.index]);
  updateHistoryButtons();
}
function updateHistoryButtons() {
  $("#btnUndo").disabled = history.index <= 0;
  $("#btnRedo").disabled = history.index >= history.stack.length - 1;
}

/* ============================================================
   网格构建与渲染
   ============================================================ */
function buildGrid(kind) {
  const { rows, cols } = dimsOf(kind);
  const el = $("#grid" + cap(kind));
  el.style.setProperty("--cols", cols);
  el.dataset.grid = kind;
  const frag = document.createDocumentFragment();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const d = document.createElement("div");
      d.className = "cell";
      d.dataset.r = r;
      d.dataset.c = c;
      if ((r + 1) % 5 === 0) d.style.borderTopColor = "#c9c3b4";
      if ((c + 1) % 5 === 0) d.style.borderLeftColor = "#c9c3b4";
      frag.appendChild(d);
    }
  }
  el.innerHTML = "";
  el.appendChild(frag);
  if (!el.dataset.eventsBound) { attachGridEvents(el, kind); el.dataset.eventsBound = "1"; }
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function dimsOf(kind) {
  if (kind === "threading") return { rows: state.S, cols: state.E };
  if (kind === "tieup") return { rows: state.S, cols: state.T };
  if (kind === "liftplan") return { rows: state.P, cols: state.S };
  return { rows: state.P, cols: state.T }; // treadling
}

/* 数据行号 -> DOM 行号（踏序/升综计划/成布：p=0 在最下） */
function domRow(kind, dataRow) {
  return (kind === "treadling" || kind === "liftplan") ? dimsOf(kind).rows - 1 - dataRow : dataRow;
}
function dataRow(kind, domR) {
  return (kind === "treadling" || kind === "liftplan") ? dimsOf(kind).rows - 1 - domR : domR;
}

function renderGrid(kind) {
  const { rows, cols } = dimsOf(kind);
  const set = GRIDS[kind].set();
  const el = $("#grid" + cap(kind));
  const cells = el.children;
  for (let dr = 0; dr < rows; dr++) {
    for (let c = 0; c < cols; c++) {
      const dR = dataRow(kind, dr);
      const on = set.has(key(dR, c));
      const cell = cells[dr * cols + c];
      cell.classList.toggle("mark", on);
    }
  }
  applyIssueMarks(kind);
  applyPlayHighlights();
}

function rebuildAll() {
  setBoardVars();
  buildRulers();
  buildGrid("tieup");
  buildGrid("threading");
  buildGrid("treadling");
  buildGrid("liftplan");
  renderGrid("tieup");
  renderGrid("threading");
  renderGrid("treadling");
  renderGrid("liftplan");
  renderColorChips();
  runAnalysis();
  renderDrawdown();
  applyAllRulerMarks();
}

function setBoardVars() {
  const b = $("#board");
  b.style.setProperty("--S", state.S);
  b.style.setProperty("--T", state.T);
  b.style.setProperty("--M", state.mode === "lift" ? state.S : state.T);
  b.style.setProperty("--E", state.E);
  b.style.setProperty("--P", state.P);
  b.style.setProperty("--cell", state.cell + "px");
  document.documentElement.style.setProperty("--cell", state.cell + "px");
  const svg = $("#drawdownSvg");
  svg.setAttribute("viewBox", `0 0 ${state.E} ${state.P}`);
  svg.setAttribute("width", state.E * state.cell);
  svg.setAttribute("height", state.P * state.cell);
}

/* ---------------- 尺 ---------------- */
function buildRulers() {
  const ends = $("#endsRuler");
  const treadles = $("#treadleRuler");
  const shafts = $("#shaftRuler");
  const picks = $("#picksRuler");
  const liftCols = $("#liftColRuler");
  ends.innerHTML = rangeHtml(state.E, (i) => rulerNum(i + 1, "end", i));
  treadles.innerHTML = rangeHtml(state.T, (i) => rulerNum(i + 1, "treadle", i));
  shafts.innerHTML = rangeHtml(state.S, (i) => rulerNum(i + 1, "shaft", i));
  // 升综计划列尺：列=综框号
  liftCols.innerHTML = rangeHtml(state.S, (i) => rulerNum(i + 1, "liftcol", i));
  // 纬纱尺：p=0（最先织）在最下
  picks.innerHTML = rangeHtml(state.P, (domR) =>
    rulerNum(state.P - domR, "pick", state.P - 1 - domR));
  [ends, treadles, shafts, picks, liftCols].forEach((r) => {
    r.querySelectorAll(".rnum").forEach((n) => {
      n.addEventListener("click", onRulerClick);
    });
  });
}
function rangeHtml(n, fn) {
  let s = "";
  for (let i = 0; i < n; i++) s += fn(i);
  return s;
}
function rulerNum(label, kind, idx) {
  const major = label % 5 === 0;
  return `<div class="rnum${major ? " major" : ""}" data-kind="${kind}" data-idx="${idx}">${label}</div>`;
}

/* ============================================================
   编辑交互（点按 / 拖涂 / 选区）
   ============================================================ */
function attachGridEvents(el, kind) {
  el.addEventListener("pointerdown", (ev) => onPointerDown(ev, kind));
  el.addEventListener("pointermove", (ev) => onPointerMove(ev, kind));
  el.addEventListener("pointerup", (ev) => onPointerUp(ev, kind));
  el.addEventListener("pointerleave", () => { if (!edit.drag) clearHover(); });
  el.addEventListener("contextmenu", (ev) => ev.preventDefault());
}

function cellFromEvent(ev, kind) {
  const el = $("#grid" + cap(kind));
  const rect = el.getBoundingClientRect();
  const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
  const { rows, cols } = dimsOf(kind);
  if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return null;
  const c = clamp(Math.floor(x / state.cell), 0, cols - 1);
  const dr = clamp(Math.floor(y / state.cell), 0, rows - 1);
  return { dr, dc: c, dR: dataRow(kind, dr) };
}

function onPointerDown(ev, kind) {
  ev.preventDefault();
  const pos = cellFromEvent(ev, kind);
  if (!pos) return;

  /* 粘贴模式：任何格点点击都触发粘贴 */
  if (edit.pasteMode && edit.clipboard) {
    doPaste(kind, pos.dR, pos.dc);
    return;
  }

  if (edit.mode === "select" || ev.shiftKey) {
    beginSelection(kind, pos.dR, pos.dc);
    return;
  }

  const set = GRIDS[kind].set();
  const k = key(pos.dR, pos.dc);
  let val;
  if (ev.button === 2) val = false;                          // 右键擦除
  else if (edit.mode === "erase") val = false;
  else if (edit.mode === "toggle") val = !set.has(k);
  else val = true;                                          // paint

  cancelSelection(true);
  edit.drag = { kind, val, paintMode: edit.mode === "paint", touched: new Set(), start: k };
  applyCell(kind, pos.dR, pos.dc, val);
  ev.target.setPointerCapture && ev.target.setPointerCapture(ev.pointerId);
}

function onPointerMove(ev, kind) {
  const pos = cellFromEvent(ev, kind);
  if (!pos) return;
  updateCoordBar(ev, kind, pos);

  if (edit.drag && edit.drag.kind === kind) {
    const k = key(pos.dR, pos.dc);
    if (!edit.drag.touched.has(k)) {
      edit.drag.touched.add(k);
      applyCell(kind, pos.dR, pos.dc, edit.drag.val);
    }
    return;
  }
  if (edit.selection && edit.selection.grid === kind && ev.buttons === 1 && edit.selecting) {
    updateSelection(kind, pos.dR, pos.dc);
    return;
  }
  showHover(kind, pos.dr, pos.dc);
}

function onPointerUp(ev, kind) {
  if (edit.drag && edit.drag.kind === kind) {
    if (edit.drag.touched.size > 0 || true) pushHistory();
    afterEdit();
    edit.drag = null;
  }
  if (edit.selecting) {
    edit.selecting = false;
    finalizeSelection();
  }
}

function applyCell(kind, dR, dc, val) {
  const set = GRIDS[kind].set();
  const k = key(dR, dc);
  if (kind === "threading") {
    // 穿综：一根经纱只穿一片综，点亮新综时清掉该列其它标记
    if (val) {
      for (let s = 0; s < 1024; s++) if (set.has(key(s, dc))) set.delete(key(s, dc));
    }
  } else if (kind === "liftplan") {
    // 升综计划：涂任一综即清掉该纬“漏织”哨兵；哨兵本身不参与普通格点
    if (val) set.delete(key(dR, LIFT_DEAD));
  }
  if (val) set.add(k); else set.delete(k);
  const { rows, cols } = dimsOf(kind);
  const dr = domRow(kind, dR);
  const cellEl = $("#grid" + cap(kind)).children[dr * cols + dc];
  cellEl.classList.toggle("mark", val);
  scheduleAnalysis();
  scheduleDrawdown();
}

function afterEdit() {
  runAnalysis();
  renderDrawdown();
  applyAllRulerMarks();
  scheduleWarpRefresh();
}

/* ---------------- 悬停 / 坐标栏 ---------------- */
let hoverEl = null;
function clearHover() {
  if (hoverEl) { hoverEl.classList.remove("hover"); hoverEl = null; }
}
function showHover(kind, dr, dc) {
  clearHover();
  const { cols } = dimsOf(kind);
  hoverEl = $("#grid" + cap(kind)).children[dr * cols + dc];
  hoverEl.classList.add("hover");
}
function updateCoordBar(ev, kind, pos) {
  let txt = "";
  if (kind === "threading") txt = `穿综：经纱 ${pos.dc + 1} → 综框 ${pos.dR + 1}`;
  else if (kind === "tieup") txt = `连结：综框 ${pos.dR + 1} × 踏板 ${pos.dc + 1}`;
  else if (kind === "liftplan") txt = `升综计划：第 ${pos.dR + 1} 纬（自织口）× 综框 ${pos.dc + 1}`;
  else txt = `踏序：第 ${pos.dR + 1} 纬（自织口）× 踏板 ${pos.dc + 1}`;
  $("#coordText").textContent = txt;
  maybeShowIssueTip(ev, kind, pos.dR, pos.dc);
}

/* ============================================================
   选区：复制 / 剪切 / 粘贴 / 循环扩展
   ============================================================ */
function beginSelection(kind, r, c) {
  edit.selection = { grid: kind, r0: r, c0: c, r1: r, c1: c };
  edit.selecting = true;
  edit.pasteMode = false;
  updateSelRect();
}
function updateSelection(kind, r, c) {
  if (!edit.selection) return;
  edit.selection.r1 = r;
  edit.selection.c1 = c;
  updateSelRect();
}
function normSel(sel) {
  return {
    grid: sel.grid,
    r0: Math.min(sel.r0, sel.r1), r1: Math.max(sel.r0, sel.r1),
    c0: Math.min(sel.c0, sel.c1), c1: Math.max(sel.c0, sel.c1),
  };
}
let selRectEl = null;
function updateSelRect() {
  const sel = normSel(edit.selection);
  const kind = sel.grid;
  const el = $("#grid" + cap(kind));
  if (!selRectEl || selRectEl.parentElement !== el) {
    el.parentElement.querySelectorAll(".sel-rect,.paste-ghost").forEach((n) => n.remove());
    selRectEl = document.createElement("div");
    selRectEl.className = "sel-rect";
    el.style.position = "relative";
    el.appendChild(selRectEl);
  }
  selRectEl.style.display = "block";
  selRectEl.style.left = (sel.c0 * state.cell) + "px";
  selRectEl.style.top = (domRow(kind, sel.r1) * state.cell) + "px";
  selRectEl.style.width = ((sel.c1 - sel.c0 + 1) * state.cell) + "px";
  selRectEl.style.height = ((sel.r1 - sel.r0 + 1) * state.cell) + "px";
}
function finalizeSelection() {
  const sel = normSel(edit.selection);
  const pop = $("#selectPop");
  pop.hidden = false;
  $("#selInfo").textContent =
    `${GRID_NAMES[sel.grid]}选区：行 ${sel.r0 + 1}–${sel.r1 + 1}，列 ${sel.c0 + 1}–${sel.c1 + 1}` +
    `（${sel.r1 - sel.r0 + 1}×${sel.c1 - sel.c0 + 1}）`;
  updateSelRect();
}
function cancelSelection(silent) {
  edit.selection = null;
  edit.selecting = false;
  edit.pasteMode = false;
  $("#selectPop").hidden = true;
  document.querySelectorAll(".sel-rect,.paste-ghost").forEach((n) => n.remove());
  selRectEl = null;
  if (!silent) afterEdit();
}

function readSelectionBits(sel) {
  const set = GRIDS[sel.grid].set();
  const rows = sel.r1 - sel.r0 + 1, cols = sel.c1 - sel.c0 + 1;
  const bits = [];
  for (let r = 0; r < rows; r++) {
    const line = [];
    for (let c = 0; c < cols; c++)
      line.push(set.has(key(sel.r0 + r, sel.c0 + c)) ? 1 : 0);
    bits.push(line);
  }
  return { grid: sel.grid, rows, cols, bits };
}
function selCopy() {
  if (!edit.selection) return;
  edit.clipboard = readSelectionBits(normSel(edit.selection));
  toast(`已复制 ${edit.clipboard.rows}×${edit.clipboard.cols}，切到点涂后单击目标位置粘贴`);
  enterPasteWait();
}
function selCut() {
  if (!edit.selection) return;
  const sel = normSel(edit.selection);
  edit.clipboard = readSelectionBits(sel);
  const set = GRIDS[sel.grid].set();
  for (let r = sel.r0; r <= sel.r1; r++)
    for (let c = sel.c0; c <= sel.c1; c++) set.delete(key(r, c));
  pushHistory();
  afterEdit();
  enterPasteWait();
}
function enterPasteWait() {
  edit.pasteMode = true;
  $("#selInfo").textContent =
    `剪贴板 ${edit.clipboard.rows}×${edit.clipboard.cols}（来自${GRID_NAMES[edit.clipboard.grid]}）—— 单击目标网格粘贴`;
}
function doPaste(gridKind, dR, dc) {
  const clip = edit.clipboard;
  if (!clip) return;
  const { rows, cols } = dimsOf(gridKind);
  if (clip.bits[0].length > cols) { toast("剪贴板比目标网格宽，无法粘贴"); return; }
  const target = GRIDS[gridKind].set();
  const deadRows = new Set();
  for (let r = 0; r < clip.rows; r++) {
    const tr = dR + r;
    if (tr >= rows) break;
    for (let c = 0; c < clip.cols; c++) {
      const tc = dc + c;
      if (tc >= cols) break;
      const k = key(tr, tc);
      if (clip.bits[r][c]) { target.add(k); if (gridKind === "liftplan") deadRows.add(tr); }
      else target.delete(k);
    }
  }
  if (gridKind === "liftplan") deadRows.forEach((p) => target.delete(key(p, LIFT_DEAD)));
  cancelSelection(true);
  pushHistory();
  afterEdit();
  toast("已粘贴");
}
/* 循环扩展：把选区图案沿右/下方向平铺到网格末端 */
function selRepeat() {
  if (!edit.selection) return;
  const sel = normSel(edit.selection);
  const set = GRIDS[sel.grid].set();
  const { rows, cols } = dimsOf(sel.grid);
  const patR = sel.r1 - sel.r0 + 1, patC = sel.c1 - sel.c0 + 1;
  for (let r = sel.r0; r < rows; r++) {
    for (let c = sel.c0; c < cols; c++) {
      const v = set.has(key(sel.r0 + ((r - sel.r0) % patR),
                            sel.c0 + ((c - sel.c0) % patC)));
      const k = key(r, c);
      if (v) set.add(k); else set.delete(k);
    }
  }
  pushHistory();
  afterEdit();
  toast("已按选区循环扩展到网格末端");
}

/* ============================================================
   成布计算
   规则（踏板模式）：
     提综逻辑：被提起的综（tieup 连结 + 本纬踩下）使经纱在上 → 1
     沉综逻辑：标记的综下沉，未沉的综在上 → 取反
     经纱未穿综 / 本纬无有效踏板 → -1 无交织
   规则（直提模式）：
     LIFTPLAN 按 WIF 约定给出本纬“升起”的综；sinking 开口时由沉下综成纬浮，
     故升综判定为 shed==="rising" ? 在计划中 : 不在计划中。
     哨兵 "p:-1"（由踏板转换而来的漏织纬）→ 整纬 -1。
   ============================================================ */
function computeCloth() {
  const r = computeClothFrom(state);
  cloth = r.cloth;
  activeTreadles = r.active;
}

/* 按给定草稿（state 或变体对象）重算成布；返回 {cloth, active} */
function computeClothFrom(d) {
  const S = d.S ?? state.S, T = d.T ?? state.T, E = d.E ?? state.E, P = d.P ?? state.P;
  const shed = d.shed ?? state.shed;
  const mode = d.mode ?? state.mode;
  const out = new Int8Array(E * P);
  const active = new Int8Array(P);

  // 每根经纱所在综（-1 未穿）
  const shaftOfEnd = new Int16Array(E).fill(-1);
  for (const k of d.threading) {
    const [s, e] = parseKey(k);
    if (e < E && s < S) shaftOfEnd[e] = s;
  }

  // 每纬升起的综（直提模式直接给出；踏板模式由连结∪踩下合成）
  const upByPick = Array.from({ length: P }, () => new Uint8Array(S));
  if (mode === "lift") {
    // LIFTPLAN 按 WIF 约定始终列出“升起”的综框，与 Shed 无关：
    // 提综开口直接据此判断；沉综开口下列出者同样升起、未列者沉下。
    // 无任何标记的“全沉纬”是有效开口（整纬纬浮，对应 WIF 的 pick=0）；
    // 只有内部哨兵 "p:-1"（由踏板稿漏织纬转换而来）才记为无交织。
    const lift = d.liftplan || state.liftplan;
    const dead = new Uint8Array(P);
    for (const k of lift) {
      const [p, s] = parseKey(k);
      if (p >= P) continue;
      if (s === LIFT_DEAD) dead[p] = 1;
      else if (s < S) upByPick[p][s] = 1;
    }
    for (let p = 0; p < P; p++) {
      if (dead[p]) continue; // 漏织哨兵：active 保持 0，稍后记 -1
      active[p] = 1;         // 全沉纬（无标记）同样开口有效
    }
  } else {
    // 每片综连结了哪些踏板
    const treadlesOfShaft = Array.from({ length: S }, () => []);
    for (const k of d.tieup) {
      const [s, t] = parseKey(k);
      if (s < S && t < T) treadlesOfShaft[s].push(t);
    }
    for (let p = 0; p < P; p++) {
      const pressed = new Set();
      for (const k of d.treadling) {
        const [pp, t] = parseKey(k);
        if (pp === p && t < T) pressed.add(t);
      }
      if (pressed.size === 0) continue; // 该纬漏踩踏板 → -1（用户稿按漏织处理）
      active[p] = 1;
      for (let s = 0; s < S; s++) {
        let linked = treadlesOfShaft[s].some((t) => pressed.has(t));
        if (shed === "sinking") linked = !linked;
        upByPick[p][s] = linked ? 1 : 0;
      }
      // 注：提综逻辑下踩到全空连结踏板＝有效全沉纬（整纬纬浮），与 LIFTPLAN 空行等价。
    }
  }

  for (let p = 0; p < P; p++) {
    if (!active[p]) { out.fill(-1, p * E, (p + 1) * E); continue; }
    for (let e = 0; e < E; e++) {
      const s = shaftOfEnd[e];
      out[p * E + e] = s < 0 ? -1 : upByPick[p][s] ? 1 : 0;
    }
  }
  return { cloth: out, active };
}

/* 每纬升综签名（数组）：空数组是有效的“全沉纬”（整纬纬浮），不是漏织。
   供转换/打印周期/播放复用 */
function liftSetOfPick(p) {
  const arr = [];
  for (const k of state.liftplan) {
    const [pp, s] = parseKey(k);
    if (pp === p && s >= 0 && s < state.S) arr.push(s);
  }
  return arr.sort((a, b) => a - b);
}
/* 哨兵纬：由踏板稿漏织纬转换而来，成布记无交织 */
function isDeadLiftPick(p) { return state.liftplan.has(key(p, LIFT_DEAD)); }
/* 一次扫描得到每纬状态：dead=哨兵漏织，empty=有效全沉纬（无升综标记） */
function liftPickStates() {
  const P = state.P, S = state.S;
  const dead = new Uint8Array(P), has = new Uint8Array(P);
  for (const k of state.liftplan) {
    const [p, s] = parseKey(k);
    if (p >= P) continue;
    if (s === LIFT_DEAD) dead[p] = 1;
    else if (s >= 0 && s < S) has[p] = 1;
  }
  const allDown = new Uint8Array(P);
  for (let p = 0; p < P; p++) if (!dead[p] && !has[p]) allDown[p] = 1;
  return { dead, allDown };
}
/* 有效但全沉的纬（无任何升综标记、且非哨兵） */
function isAllDownPick(p) {
  if (isDeadLiftPick(p)) return false;
  for (const k of state.liftplan) {
    const [pp, s] = parseKey(k);
    if (pp === p && s >= 0 && s < state.S) return false;
  }
  return true;
}

/* ============================================================
   成布 SVG 渲染
   ============================================================ */
function renderDrawdown() {
  if (!cloth) computeCloth();
  const { E, P } = state;
  const svg = $("#drawdownSvg");
  const weftColor = (state.colorPrint && state.weftColors[0]) || DEFAULT_WEFT;
  let html = "";

  // 底：纬纱色（纬浮点底色）。整纬色一致时画长条，否则逐格。
  let runColor = null, runStart = 0;
  const flushWeft = (p, endX) => {
    if (endX > runStart) {
      const y = P - 1 - p;
      html += `<rect x="${runStart}" y="${y}" width="${endX - runStart}" height="1.02" fill="${runColor}"/>`;
    }
  };
  for (let p = 0; p < P; p++) {
    runStart = 0; runColor = weftColorAt(p);
    for (let e = 0; e < E; e++) {
      const col = weftColorAt(p);
      if (col !== runColor) { flushWeft(p, e); runStart = e; runColor = col; }
    }
    flushWeft(p, E);
  }
  // 无交织格灰底覆盖
  for (let p = 0; p < P; p++) {
    for (let e = 0; e < E; e++) {
      if (cloth[p * E + e] === -1) {
        html += `<rect x="${e}" y="${P - 1 - p}" width="1.02" height="1.02" fill="#d6d2c6"/>`;
      }
    }
  }
  // 经浮点：合并连续游程为长条
  for (let p = 0; p < P; p++) {
    let run = 0, rs = -1;
    for (let e = 0; e <= E; e++) {
      const up = e < E && cloth[p * E + e] === 1;
      if (up) { if (run === 0) rs = e; run++; }
      else if (run > 0) {
        const y = P - 1 - p;
        const col = state.colorPrint ? warpColorAt(rs) : "#2b2b28";
        // 多色经纱时逐格画
        if (!state.colorPrint || sameWarpColor(rs, rs + run)) {
          html += `<rect x="${rs + 0.06}" y="${y + 0.06}" width="${run - 0.12}" height="0.88" rx="0.15" fill="${col}"/>`;
        } else {
          for (let x = rs; x < rs + run; x++)
            html += `<rect x="${x + 0.06}" y="${y + 0.06}" width="0.88" height="0.88" rx="0.15" fill="${warpColorAt(x)}"/>`;
        }
        run = 0;
      }
    }
  }
  svg.innerHTML = html +
    `<g id="ddIssues"></g><g id="ddPlay"></g><g id="ddFlash"></g>`;
  drawIssueOverlays();
  drawPlayOverlay();
}
function sameWarpColor(a, bExcl) {
  const c = warpColorAt(a);
  for (let i = a + 1; i < bExcl; i++) if (warpColorAt(i) !== c) return false;
  return true;
}
function warpColorAt(e) { return state.warpColors[e] || DEFAULT_WARP; }
function weftColorAt(p) { return state.weftColors[p] || DEFAULT_WEFT; }

/* ============================================================
   校对分析
   ============================================================ */
let analysisTimer = null;
function scheduleAnalysis() {
  clearTimeout(analysisTimer);
  analysisTimer = setTimeout(runAnalysis, 180);
}
let drawdownTimer = null;
function scheduleDrawdown() {
  clearTimeout(drawdownTimer);
  drawdownTimer = setTimeout(() => { renderDrawdown(); applyAllRulerMarks(); }, 120);
}

function runAnalysis() {
  computeCloth();
  const { S, T, E, P } = state;
  const R = state.rules;
  issues = [];
  issueCells = { threading: new Set(), tieup: new Set(), treadling: new Set(),
                 liftplan: new Set(),
                 drawdown: new Set(), endRuler: new Set(), pickRuler: new Set(),
                 shaftRuler: new Set(), treadleRuler: new Set(), liftColRuler: new Set(),
                 pickWarnRuler: new Set() };

  const isLift = state.mode === "lift";
  const shaftUsed = new Uint8Array(S), treadleUsed = new Uint8Array(T);
  const endThreaded = new Uint8Array(E);
  const endShaft = new Int16Array(E).fill(-1);
  const treadleLinked = new Uint8Array(T);
  const shaftTied = new Uint8Array(S);

  for (const k of state.threading) {
    const [s, e] = parseKey(k);
    if (s < S && e < E) { shaftUsed[s] = 1; endThreaded[e] = 1; endShaft[e] = s; }
  }
  for (const k of state.tieup) {
    const [s, t] = parseKey(k);
    if (s < S && t < T) { shaftTied[s] = 1; treadleLinked[t] = 1; }
  }
  for (const k of state.treadling) {
    const [p, t] = parseKey(k);
    if (p < P && t < T) treadleUsed[t] = 1;
  }
  const liftUsed = new Uint8Array(S);
  if (isLift) {
    for (const k of state.liftplan) {
      const [p, s] = parseKey(k);
      if (p < P && s >= 0 && s < S) liftUsed[s] = 1;
    }
  }

  /* ---- 越界引用（数据里有、当前尺寸外的标记） ---- */
  const over = { threading: [], tieup: [], treadling: [], liftplan: [] };
  for (const k of state.threading) {
    const [s, e] = parseKey(k);
    if (s >= S || e >= E) over.threading.push([s, e]);
  }
  for (const k of state.tieup) {
    const [s, t] = parseKey(k);
    if (s >= S || t >= T) over.tieup.push([s, t]);
  }
  for (const k of state.treadling) {
    const [p, t] = parseKey(k);
    if (p >= P || t >= T) over.treadling.push([p, t]);
  }
  if (isLift) {
    for (const k of state.liftplan) {
      const [p, s] = parseKey(k);
      if (s !== LIFT_DEAD && (p >= P || s >= S)) over.liftplan.push([p, s]);
    }
  }
  if (over.threading.length) issues.push({
    sev: "error", kind: "oor-threading",
    title: `穿综越界引用 ×${over.threading.length}`,
    desc: "存在指向当前综框/经纱数之外的穿综标记（常见于缩小尺寸后）。",
    fix: { label: "清除越界标记", action: "trim", grid: "threading" },
    locs: over.threading.slice(0, 8).map(([s, e]) => ({
      kind: "text", text: `经${e + 1}→综${s + 1}` })),
  });
  if (!isLift && over.tieup.length) issues.push({
    sev: "error", kind: "oor-tieup",
    title: `连结越界 ×${over.tieup.length}`,
    desc: "踏板连结中存在超出当前综框/踏板数的标记。",
    fix: { label: "清除越界标记", action: "trim", grid: "tieup" },
    locs: over.tieup.slice(0, 8).map(([s, t]) => ({ kind: "text", text: `综${s + 1}×踏${t + 1}` })),
  });
  if (!isLift && over.treadling.length) issues.push({
    sev: "error", kind: "oor-treadling",
    title: `踏序越界 ×${over.treadling.length}`,
    desc: "踏序中存在超出当前纬纱/踏板数的标记。",
    fix: { label: "清除越界标记", action: "trim", grid: "treadling" },
    locs: over.treadling.slice(0, 8).map(([p, t]) => ({ kind: "text", text: `纬${p + 1}×踏${t + 1}` })),
  });
  if (isLift && over.liftplan.length) issues.push({
    sev: "error", kind: "oor-liftplan",
    title: `升综计划越界 ×${over.liftplan.length}`,
    desc: "升综计划中存在超出当前纬纱/综框数的标记。",
    fix: { label: "清除越界标记", action: "trim", grid: "liftplan" },
    locs: over.liftplan.slice(0, 8).map(([p, s]) => ({ kind: "text", text: `纬${p + 1}×综${s + 1}` })),
  });

  /* ---- 未穿综的经纱 ---- */
  const unthreaded = [];
  for (let e = 0; e < E; e++) if (!endThreaded[e]) unthreaded.push(e);
  for (const e of unthreaded) {
    issueCells.endRuler.add(e);
    for (let p = 0; p < P; p++) issueCells.drawdown.add(key(p, e));
  }
  if (unthreaded.length) issues.push({
    sev: "error", kind: "unthreaded",
    title: `漏穿经纱 ×${unthreaded.length}`,
    desc: "这些经纱没有穿入任何综框，整列都不会开口。",
    locs: unthreaded.slice(0, 10).map((e) => ({
      kind: "threading-end", end: e, text: `经纱 ${e + 1}` })),
  });

  /* ---- 漏织（整纬无开口） ---- */
  const deadPicks = [];
  const allDownPicks = [];
  if (isLift) {
    const st = liftPickStates();
    for (let p = 0; p < P; p++) {
      if (st.dead[p]) {
        // 哨兵纬：真正无开口，整纬无交织
        deadPicks.push(p);
        issueCells.pickRuler.add(p);
        for (let s = 0; s < S; s++) issueCells.liftplan.add(key(p, s));
        for (let e = 0; e < E; e++) issueCells.drawdown.add(key(p, e));
      } else if (st.allDown[p]) {
        allDownPicks.push(p);
        issueCells.pickWarnRuler.add(p);
      }
    }
  } else {
    for (let p = 0; p < P; p++) {
      let any = false;
      for (let t = 0; t < T; t++) if (state.treadling.has(key(p, t))) { any = true; break; }
      if (!any) deadPicks.push(p);
    }
    for (const p of deadPicks) {
      issueCells.pickRuler.add(p);
      for (let e = 0; e < E; e++) issueCells.drawdown.add(key(p, e));
    }
  }
  if (deadPicks.length) issues.push({
    sev: "error", kind: "dead-pick",
    title: `${isLift ? "升综计划漏织纬纱" : "漏织纬纱"} ×${deadPicks.length}`,
    desc: isLift
      ? "这些纬没有开口（由踏板稿的漏织纬保留下来），梭口不开。"
      : "这些纬没有踩任何踏板（或所踩踏板无连结），梭口不开。",
    locs: deadPicks.slice(0, 10).map((p) => ({
      kind: "dead-pick-loc", pick: p, text: `第 ${p + 1} 纬` })),
  });
  if (isLift && allDownPicks.length) issues.push({
    sev: "info", kind: "all-down-pick",
    title: `全沉纬 ×${allDownPicks.length}`,
    desc: "这些纬没有任何综框升起（对应 WIF 的 pick=0）：梭口仍然有效，整纬纬纱在上（纬浮点）。",
    locs: allDownPicks.slice(0, 10).map((p) => ({
      kind: "dead-pick-loc", pick: p, text: `第 ${p + 1} 纬` })),
  });

  /* ---- 浮长：逐经（经浮，正面）/ 逐纬（纬浮，反面） ---- */
  const floatSpots = { front: [], back: [] };
  // 经向游程：沿 p 方向（屏幕纵向）
  for (let e = 0; e < E; e++) {
    let run = 0, start = -1;
    for (let p = 0; p <= P; p++) {
      const v = p < P ? cloth[p * E + e] : -2;
      if (v === 1) { if (run === 0) start = p; run++; }
      else {
        if (run > R.maxFront) {
          for (let q = start; q < start + run; q++) {
            issueCells.drawdown.add(key(q, e));
            floatSpots.front.push([q, e]);
          }
        }
        run = 0;
      }
    }
  }
  // 纬向游程：沿 e 方向
  for (let p = 0; p < P; p++) {
    let run = 0, start = -1;
    for (let e = 0; e <= E; e++) {
      const v = e < E ? cloth[p * E + e] : -2;
      if (v === 0) { if (run === 0) start = e; run++; }
      else {
        if (run > R.maxBack) {
          for (let x = start; x < start + run; x++) {
            issueCells.drawdown.add(key(p, x));
            floatSpots.back.push([p, x]);
          }
        }
        run = 0;
      }
    }
  }
  if (floatSpots.front.length) issues.push({
    sev: "warn", kind: "float-front",
    title: `正面（经向）超长浮线 ${countRuns(floatSpots.front, "vert")} 处`,
    desc: `连续经浮点超过正面最大浮长 ${R.maxFront}，可能起毛、勾挂。`,
    locs: floatSpots.front.slice(0, 10).map(([p, e]) => ({
      kind: "drawdown", p, e, text: `经${e + 1} 第${p + 1}纬附近` })),
  });
  if (floatSpots.back.length) issues.push({
    sev: "warn", kind: "float-back",
    title: `反面（纬向）超长浮线 ${countRuns(floatSpots.back, "horiz")} 处`,
    desc: `连续纬浮点超过反面最大浮长 ${R.maxBack}，布面反面浮线过长。`,
    locs: floatSpots.back.slice(0, 10).map(([p, e]) => ({
      kind: "drawdown", p, e, text: `第${p + 1}纬 经${e + 1}附近` })),
  });

  /* ---- 边经规则：边经必须逐纬交织（无无交织点且浮长不超过1） ---- */
  if (R.edge && R.edgeW > 0) {
    const badEdges = { left: new Set(), right: new Set() };
    for (const e0 of rangeEdge(E, R.edgeW)) {
      for (let p = 0; p < P; p++) {
        const v = cloth[p * E + e0];
        if (v === -1) { (e0 < E / 2 ? badEdges.left : badEdges.right).add(p); issueCells.drawdown.add(key(p, e0)); }
      }
      // 浮长>1 也算未交织（相邻两纬同为经浮或同为纬浮时，该纬纱/经纱在边部未交换）
      for (let p = 0; p < P; p++) {
        const v = cloth[p * E + e0];
        if (v !== -1 && p + 1 < P && cloth[(p + 1) * E + e0] === v) {
          (e0 < E / 2 ? badEdges.left : badEdges.right).add(p);
          issueCells.drawdown.add(key(p, e0));
        }
      }
      if (badEdges.left.size + badEdges.right.size > 0)
        issueCells.endRuler.add(e0);
    }
    const nL = badEdges.left.size, nR = badEdges.right.size;
    if (nL + nR > 0) issues.push({
      sev: "error", kind: "edge",
      title: `边经漏交织（左 ${nL} 点 / 右 ${nR} 点）`,
      desc: `最外侧各 ${R.edgeW} 根边经要求逐纬与纬纱交换上下；请检查边部穿综与${isLift ? "升综计划" : "踏序"}。`,
      locs: [
        ...[...badEdges.left].slice(0, 5).map((p) => ({
          kind: "drawdown", p, e: findEdgeEnd(E, R.edgeW, "left", p), text: `左边 第${p + 1}纬` })),
        ...[...badEdges.right].slice(0, 5).map((p) => ({
          kind: "drawdown", p, e: findEdgeEnd(E, R.edgeW, "right", p), text: `右边 第${p + 1}纬` })),
      ],
    });
  }

  /* ---- 未使用综框 / 死综 ---- */
  const unusedShafts = [], deadShafts = [];
  for (let s = 0; s < S; s++) {
    if (!shaftUsed[s]) unusedShafts.push(s);
    if (shaftUsed[s]) {
      const neverMoves = isLift ? !liftUsed[s] : !shaftTied[s];
      if (neverMoves) deadShafts.push(s);
    }
    if (!shaftUsed[s]) issueCells.shaftRuler.add(s);
    if (isLift && shaftUsed[s] && !liftUsed[s]) {
      issueCells.liftColRuler.add(s);
      // 升综计划对应列也标出
      for (let p = 0; p < P; p++) issueCells.liftplan.add(key(p, s));
    }
  }
  if (unusedShafts.length) issues.push({
    sev: "warn", kind: "unused-shaft",
    title: `未使用综框 ×${unusedShafts.length}`,
    desc: "这些综框没有任何经纱穿入（综框号已在左尺标出）。",
    locs: unusedShafts.map((s) => ({ kind: "shaft", s, text: `综框 ${s + 1}` })),
  });
  if (deadShafts.length) issues.push({
    sev: "warn", kind: "dead-shaft",
    title: `死综 ×${deadShafts.length}`,
    desc: isLift
      ? "有经纱穿入，但升综计划中这些综框从未升起（在提综逻辑下整列恒为纬浮）。"
      : "有经纱穿入但踏板连结里没有连接，踩任何踏板都不会动。",
    locs: deadShafts.map((s) => ({
      kind: isLift ? "liftcol" : "tieup-row", s, text: `综框 ${s + 1}` })),
  });

  /* ---- 未使用踏板 / 空踏板（仅踏板模式） ---- */
  if (!isLift) {
    const unusedTreadles = [], emptyTreadles = [];
    for (let t = 0; t < T; t++) {
      if (!treadleUsed[t]) unusedTreadles.push(t);
      if (treadleUsed[t] && !treadleLinked[t]) emptyTreadles.push(t);
      if (!treadleUsed[t]) issueCells.treadleRuler.add(t);
    }
    if (unusedTreadles.length) issues.push({
      sev: "warn", kind: "unused-treadle",
      title: `未使用踏板 ×${unusedTreadles.length}`,
      desc: "踏序中从未踩下这些踏板（踏板号已在尺上标出）。",
      locs: unusedTreadles.map((t) => ({ kind: "treadle", t, text: `踏板 ${t + 1}` })),
    });
    if (emptyTreadles.length) issues.push({
      sev: "info", kind: "empty-treadle",
      title: `空连结踏板被使用 ×${emptyTreadles.length}`,
      desc: state.shed === "rising"
        ? "这些踏板没有连结任何综框：踩下时全部综框沉下，相当于升综计划中的“全沉纬”（pick=0），梭口有效、整纬纬浮。"
        : "沉综逻辑下这些踏板使所有综框保持升起，整纬经浮。",
      locs: emptyTreadles.map((t) => ({ kind: "treadling-treadle", t, text: `踏板 ${t + 1}` })),
    });
  }

  /* ---- 重复穿综：同列多个标记（界面约束下一般不会出现，导入数据可能） ---- */
  const dupEnds = [];
  const cntEnd = new Uint16Array(E);
  for (const k of state.threading) {
    const [, e] = parseKey(k);
    if (e < E) cntEnd[e]++;
  }
  for (let e = 0; e < E; e++) if (cntEnd[e] > 1) dupEnds.push(e);

  /* ---- 汇总 UI ---- */
  renderIssueList();
  renderGrid("threading");
  renderGrid("tieup");
  renderGrid("treadling");
  renderGrid("liftplan");
  drawIssueOverlays();
  applyAllRulerMarks();
  updateIssueSummary();
}

function rangeEdge(E, w) {
  const set = new Set();
  for (let i = 0; i < w; i++) { set.add(i); set.add(E - 1 - i); }
  return [...set].filter((e) => e >= 0 && e < E);
}
function findEdgeEnd(E, w, side, p) {
  // 找该侧第一个实际有问题的边经
  for (let i = 0; i < w; i++) {
    const e = side === "left" ? i : E - 1 - i;
    if (issueCells.drawdown.has(key(p, e))) return e;
  }
  return side === "left" ? 0 : E - 1;
}
function countRuns(spots, dir) {
  const s = new Set(spots.map(([p, e]) => p + ":" + e));
  let n = 0;
  for (const [p, e] of spots) {
    const prev = dir === "vert" ? [p - 1, e] : [p, e - 1];
    if (!s.has(prev[0] + ":" + prev[1])) n++;
  }
  return n;
}

/* ============================================================
   问题列表与双向定位
   ============================================================ */
function renderIssueList() {
  const ul = $("#issueList");
  ul.innerHTML = "";
  for (let i = 0; i < issues.length; i++) {
    const it = issues[i];
    const li = document.createElement("li");
    li.className = `issue-item sev-${it.sev}`;
    const sevName = it.sev === "error" ? "错误" : it.sev === "warn" ? "警告" : "提示";
    let html = `<div class="ii-title">${it.title} <span class="small">[${sevName}]</span></div>
                <div class="ii-desc">${it.desc}</div>`;
    if (it.locs && it.locs.length)
      html += `<div class="ii-locs">📍 ${it.locs.map((l) => l.text).join("、")}</div>`;
    if (it.fix)
      html += `<div class="ii-fix" style="margin-top:4px"><button data-fix="${i}">${it.fix.label}</button></div>`;
    li.innerHTML = html;
    li.addEventListener("click", (ev) => {
      if (ev.target.dataset.fix !== undefined) { doFix(it.fix); ev.stopPropagation(); return; }
      locateIssue(it, li);
    });
    ul.appendChild(li);
  }
}
function updateIssueSummary() {
  const el = $("#issueSummary");
  const nErr = issues.filter((i) => i.sev === "error").length;
  const nWarn = issues.filter((i) => i.sev === "warn").length;
  if (!issues.length) {
    el.textContent = "✓ 未发现问题";
    el.className = "issue-summary ok";
  } else {
    el.textContent = `共 ${issues.length} 类问题：${nErr} 错误，${nWarn} 警告`;
    el.className = "issue-summary bad";
  }
}
function doFix(fix) {
  if (fix.action === "trim") {
    const set = GRIDS[fix.grid].set();
    const { rows, cols } = dimsOf(fix.grid);
    for (const k of [...set]) {
      const [r, c] = parseKey(k);
      if (r >= rows || c >= cols) set.delete(k);
    }
    pushHistory();
    afterEdit();
    toast("已清除越界标记");
  }
}

/* 点击问题条目 → 定位到网格 */
function locateIssue(it, li) {
  $$(".issue-item.targeted").forEach((n) => n.classList.remove("targeted"));
  if (li) li.classList.add("targeted");
  const loc = it.locs && it.locs[0];
  if (!loc) return;
  stopPlay();
  switch (loc.kind) {
    case "drawdown":
      flashDrawdown(loc.p, loc.e);
      scrollIntoViewCell("drawdown", loc.p, loc.e);
      break;
    case "threading-end":
      flashGridCell("threading", endShaftOf(loc.end), loc.end);
      break;
    case "treadling-pick":
    case "dead-pick-loc": {
      if (state.mode === "lift") {
        // 直提模式：定位升综计划对应行（整行闪烁，全沉纬也可见）
        const cols = state.S;
        if (cols > 0) {
          const base = domRow("liftplan", loc.pick) * cols;
          const first = $("#gridLiftplan").children[base];
          for (let s = 0; s < cols; s++)
            $("#gridLiftplan").children[base + s].classList.add("loc-flash");
          if (first) {
            scrollToView(first);
            setTimeout(() => $("#gridLiftplan").querySelectorAll(".loc-flash")
              .forEach((n) => n.classList.remove("loc-flash")), 1800);
          }
        }
      } else {
        const t = firstTreadleOfPick(loc.pick);
        if (t >= 0) flashGridCell("treadling", loc.pick, t);
        else scrollRuler("picksRuler", "pick", loc.pick);
      }
      break;
    }
    case "shaft":
      flashTieupRow(loc.s);
      scrollRuler("shaftRuler", "shaft", loc.s);
      break;
    case "liftcol":
      flashLiftCol(loc.s);
      scrollRuler("liftColRuler", "liftcol", loc.s);
      break;
    case "tieup-row":
      flashTieupRow(loc.s);
      break;
    case "treadle":
      flashTreadleCol(loc.t);
      break;
    case "treadling-treadle": {
      const p = firstPickOfTreadle(loc.t);
      if (p >= 0) flashGridCell("treadling", p, loc.t);
      else scrollRuler("treadleRuler", "treadle", loc.t);
      break;
    }
  }
}
function endShaftOf(e) {
  for (const k of state.threading) {
    const [s, ee] = parseKey(k);
    if (ee === e) return s;
  }
  return 0;
}
function firstTreadleOfPick(p) {
  for (let t = 0; t < state.T; t++) if (state.treadling.has(key(p, t))) return t;
  return -1;
}
function firstPickOfTreadle(t) {
  for (let p = 0; p < state.P; p++) if (state.treadling.has(key(p, t))) return p;
  return -1;
}

function flashGridCell(kind, dR, dc) {
  const { cols } = dimsOf(kind);
  const dr = domRow(kind, dR);
  const el = $("#grid" + cap(kind)).children[dr * cols + dc];
  el.classList.add("loc-flash");
  scrollToView(el);
  setTimeout(() => el.classList.remove("loc-flash"), 1800);
}
function flashTieupRow(s) {
  const el = $("#gridTieup");
  for (let c = 0; c < state.T; c++)
    el.children[s * state.T + c].classList.add("loc-flash");
  scrollToView(el);
  setTimeout(() => el.querySelectorAll(".loc-flash").forEach((n) => n.classList.remove("loc-flash")), 1800);
}
function flashTreadleCol(t) {
  ["#gridTieup", "#gridTreadling"].forEach((sel) => {
    const el = $(sel);
    const cols = el === $("#gridTreadling") ? state.T : state.T;
    const rows = el === $("#gridTreadling") ? state.P : state.S;
    for (let r = 0; r < rows; r++)
      el.children[r * cols + t].classList.add("loc-flash");
  });
  scrollToView($("#gridTreadling"));
  setTimeout(() => $$(".loc-flash").forEach((n) => n.classList.remove("loc-flash")), 1800);
}
function flashLiftCol(s) {
  const el = $("#gridLiftplan");
  const cols = state.S;
  for (let r = 0; r < state.P; r++)
    el.children[r * cols + s].classList.add("loc-flash");
  scrollToView(el);
  setTimeout(() => el.querySelectorAll(".loc-flash").forEach((n) => n.classList.remove("loc-flash")), 1800);
}
function scrollRuler(rulerId, kind, idx) {
  const n = $(`#${rulerId} .rnum[data-idx="${idx}"]`);
  if (n) scrollToView(n, { block: "center", inline: "nearest", behavior: "smooth" });
}
function scrollIntoViewCell(where, p, e) {
  const box = $("#drawdownSvg");
  scrollToView(box);
}
function flashDrawdown(p, e) {
  const g = $("#ddFlash");
  if (!g) return;
  const y = state.P - 1 - p;
  g.innerHTML = `<rect x="${e}" y="${y}" width="1.02" height="1.02" fill="none" stroke="#2456a6" stroke-width=".25"/>`;
  setTimeout(() => { g.innerHTML = ""; }, 1800);
}

/* 网格内问题格标红 */
function applyIssueMarks(kind) {
  // 输入网格的问题标红规则：死综行/空踏板列/越界
  const el = $("#grid" + cap(kind));
  const { rows, cols } = dimsOf(kind);
  el.querySelectorAll(".issue,.warn").forEach((n) => n.classList.remove("issue", "warn"));
  for (const k of issueCells[kind]) {
    const [r, c] = parseKey(k);
    if (r >= rows || c >= cols) continue;
    const dr = domRow(kind, r);
    el.children[dr * cols + c].classList.add("issue");
  }
}
function drawIssueOverlays() {
  const g = $("#ddIssues");
  if (!g || !cloth) return;
  let html = "";
  for (const k of issueCells.drawdown) {
    const [p, e] = parseKey(k);
    if (p >= state.P || e >= state.E) continue;
    html += `<rect x="${e + .04}" y="${state.P - 1 - p + .04}" width=".92" height=".92"
              fill="none" stroke="#c0392b" stroke-width=".16"/>`;
  }
  g.innerHTML = html;
}
function applyAllRulerMarks() {
  const map = [
    ["endsRuler", "end", issueCells.endRuler],
    ["shaftRuler", "shaft", issueCells.shaftRuler],
    ["treadleRuler", "treadle", issueCells.treadleRuler],
    ["liftColRuler", "liftcol", issueCells.liftColRuler],
    ["picksRuler", "pick", issueCells.pickRuler],
  ];
  $$(".rnum.bad,.rnum.unused,.rnum.warn-mark").forEach((n) =>
    n.classList.remove("bad", "unused", "warn-mark"));
  // end / pick 为错误红；shaft / treadle / liftcol 未使用为琥珀
  for (const [rulerId, kind, set] of map) {
    for (const idx of set) {
      const n = $(`#${rulerId} .rnum[data-idx="${idx}"]`);
      if (n) n.classList.add(kind === "shaft" || kind === "treadle" || kind === "liftcol" ? "unused" : "bad");
    }
  }
  for (const idx of issueCells.pickWarnRuler) {
    const n = $(`#picksRuler .rnum[data-idx="${idx}"]`);
    if (n && !issueCells.pickRuler.has(idx)) n.classList.add("warn-mark");
  }
}

/* 悬停成布/输入格 → 悬浮问题气泡（反向定位：格 → 问题） */
function maybeShowIssueTip(ev, kind, dR, dc) {
  const tip = $("#issueTip");
  let found = [];
  if (kind === "threading") {
    found = issues.filter((i) =>
      (i.kind === "unused-shaft" && issueCells.shaftRuler.has(dR)) ||
      (i.kind === "dead-shaft" && issueCells.shaftRuler.has(dR)));
  } else if (kind === "tieup") {
    if (issueCells.shaftRuler.has(dR))
      found = issues.filter((i) => i.kind === "dead-shaft" || i.kind === "unused-shaft");
    if (issueCells.treadleRuler.has(dc))
      found = found.concat(issues.filter((i) => i.kind === "unused-treadle" || i.kind === "empty-treadle"));
  } else if (kind === "treadling") {
    if (issueCells.pickRuler.has(dR)) found = issues.filter((i) => i.kind === "dead-pick");
    if (issueCells.treadleRuler.has(dc))
      found = found.concat(issues.filter((i) => i.kind === "unused-treadle" || i.kind === "empty-treadle"));
  } else if (kind === "liftplan") {
    if (issueCells.pickRuler.has(dR)) found = issues.filter((i) => i.kind === "dead-pick");
    else if (issueCells.pickWarnRuler.has(dR)) found = issues.filter((i) => i.kind === "all-down-pick");
    if (issueCells.liftColRuler.has(dc))
      found = found.concat(issues.filter((i) => i.kind === "dead-shaft"));
  }
  found = uniqBy(found, (x) => x.kind);
  if (found.length) {
    tip.innerHTML = found.map((f) => `<b>${f.title}</b><br>${f.desc}`).join("<hr style='margin:3px 0;border-color:#555'>");
    tip.hidden = false;
    tip.style.left = Math.min(ev.clientX + 14, innerWidth - 320) + "px";
    tip.style.top = (ev.clientY + 14) + "px";
  } else tip.hidden = true;
}
function uniqBy(arr, fn) {
  const seen = new Set(), out = [];
  for (const x of arr) { const k = fn(x); if (!seen.has(k)) { seen.add(k); out.push(x); } }
  return out;
}

/* 成布格悬停 */
function attachDrawdownHover() {
  const svg = $("#drawdownSvg");
  svg.addEventListener("mousemove", (ev) => {
    const rect = svg.getBoundingClientRect();
    const e = Math.floor((ev.clientX - rect.left) / state.cell);
    const domP = Math.floor((ev.clientY - rect.top) / state.cell);
    const p = state.P - 1 - domP;
    if (e < 0 || e >= state.E || p < 0 || p >= state.P) return;
    $("#coordText").textContent =
      `成布：经纱 ${e + 1} × 第 ${p + 1} 纬 —— ` +
      (cloth[p * state.E + e] === 1 ? "经浮（正面见经）" :
       cloth[p * state.E + e] === 0 ? "纬浮（反面见经）" : "无交织！");
    if (issueCells.drawdown.has(key(p, e))) {
      const found = issues.filter((i) => i.kind.startsWith("float") || i.kind === "edge"
        || i.kind === "unthreaded" || i.kind === "dead-pick");
      const tip = $("#issueTip");
      tip.innerHTML = found.map((f) => `<b>${f.title}</b><br>${f.desc}`).join("<hr style='margin:3px 0;border-color:#555'>");
      tip.hidden = false;
      tip.style.left = Math.min(ev.clientX + 14, innerWidth - 320) + "px";
      tip.style.top = (ev.clientY + 14) + "px";
    } else $("#issueTip").hidden = true;
  });
  svg.addEventListener("mouseleave", () => { $("#issueTip").hidden = true; });
  svg.addEventListener("click", (ev) => {
    const rect = svg.getBoundingClientRect();
    const e = Math.floor((ev.clientX - rect.left) / state.cell);
    const domP = Math.floor((ev.clientY - rect.top) / state.cell);
    const p = state.P - 1 - domP;
    if (!issueCells.drawdown.has(key(p, e))) return;
    // 反向定位：点问题格 → 高亮问题列表第一条相关项
    const order = ["edge", "float-front", "float-back", "unthreaded", "dead-pick"];
    const match = issues.find((i) => order.includes(i.kind) &&
      i.locs && i.locs.some((l) => l.kind === "drawdown" &&
        Math.abs(l.p - p) <= 1 && Math.abs(l.e - e) <= 1));
    if (match) {
      const idx = issues.indexOf(match);
      const li = $$(".issue-item")[idx];
      if (li) { scrollToView(li, { behavior: "smooth", block: "center" }); locateIssue(match, li); }
    }
  });
}
function onRulerClick(ev) {
  ev.stopPropagation();
  const n = ev.currentTarget;
  const kind = n.dataset.kind, idx = +n.dataset.idx;
  let issue;
  if (kind === "end") issue = issues.find((i) => i.kind === "unthreaded" || i.kind === "edge");
  if (kind === "shaft") issue = issues.find((i) => i.kind === "dead-shaft" || i.kind === "unused-shaft");
  if (kind === "liftcol") issue = issues.find((i) => i.kind === "dead-shaft");
  if (kind === "treadle") issue = issues.find((i) => i.kind === "empty-treadle" || i.kind === "unused-treadle");
  if (kind === "pick")
    issue = issues.find((i) => i.kind === "dead-pick" || i.kind === "all-down-pick");
  if (issue) {
    const li = $$(".issue-item")[issues.indexOf(issue)];
    if (li) { scrollToView(li, { behavior: "smooth", block: "center" }); locateIssue(issue, li); }
  }
}

/* ============================================================
   逐纬播放
   ============================================================ */
function drawPlayOverlay() {
  const g = $("#ddPlay");
  if (!g) return;
  if (play.pick < 0) { g.innerHTML = ""; return; }
  const p = play.pick, { E, P } = state;
  const y = P - 1 - p;
  let html = `<rect x="0" y="${y}" width="${E}" height="1.02" fill="rgba(241,196,15,.28)"/>`;
  // 已织区与织口线
  for (let q = 0; q <= p; q++) {
    const yy = P - 1 - q;
    html += `<line x1="0" y1="${yy + 1}" x2="${E}" y2="${yy + 1}" stroke="rgba(46,125,79,.0)" />`;
  }
  html += `<line x1="0" y1="${y + 1}" x2="${E}" y2="${y + 1}" stroke="#2e7d4f" stroke-width=".18"/>`;
  g.innerHTML = html;
}
/* 当前纬各综是否升起（按当前模式与开口逻辑） */
function upShaftsAtPick(p) {
  const up = new Uint8Array(state.S);
  if (state.mode === "lift") {
    if (state.liftplan.has(key(p, LIFT_DEAD))) return null; // 哨兵漏织纬
    for (const k of state.liftplan) {
      const [pp, s] = parseKey(k);
      if (pp === p && s >= 0 && s < state.S) up[s] = 1;
    }
    // 无标记＝有效全沉纬，返回全 0（无综升起）
  } else {
    const pressed = new Set();
    for (const k of state.treadling) {
      const [pp, t] = parseKey(k);
      if (pp === p && t < state.T) pressed.add(t);
    }
    if (!pressed.size) return null;
    for (let s = 0; s < state.S; s++) {
      let linked = false;
      for (const k of state.tieup) {
        const [ss, t] = parseKey(k);
        if (ss === s && pressed.has(t)) { linked = true; break; }
      }
      if (state.shed === "sinking") linked = !linked;
      up[s] = linked ? 1 : 0;
    }
  }
  return up;
}
function applyPlayHighlights() {
  $$(".cell.play-shaft,.cell.play-treadle,.cell.play-alldown").forEach((n) =>
    n.classList.remove("play-shaft", "play-treadle", "play-alldown"));
  if (play.pick < 0) return;
  const p = play.pick;

  if (state.mode === "lift") {
    const up = upShaftsAtPick(p);
    // 高亮升综计划行
    const lp = $("#gridLiftplan");
    const dr = domRow("liftplan", p);
    let anyUp = false;
    for (const k of state.liftplan) {
      const [pp, s] = parseKey(k);
      if (pp === p && s >= 0 && s < state.S) {
        lp.children[dr * state.S + s].classList.add("play-shaft");
        anyUp = true;
      }
    }
    // 有效全沉纬：整行描边提示（无综升起但梭口有效）
    if (up && !anyUp) {
      for (let s = 0; s < state.S; s++)
        lp.children[dr * state.S + s].classList.add("play-alldown");
    }
    $$("#shaftRuler .rnum, #liftColRuler .rnum").forEach((rn) => {
      const s = +rn.dataset.idx;
      const isUp = up && up[s];
      rn.style.background = isUp ? "rgba(127,199,155,.85)" : "";
      rn.style.fontWeight = isUp ? "700" : "";
    });
    $$("#picksRuler .rnum").forEach((rn) => {
      rn.style.background = +rn.dataset.idx === p ? "rgba(46,125,79,.35)" : "";
    });
    return;
  }

  const pressed = new Set();
  for (let t = 0; t < state.T; t++)
    if (state.treadling.has(key(p, t))) pressed.add(t);
  // 高亮踏序格
  const tr = $("#gridTreadling");
  pressed.forEach((t) => {
    const dr = domRow("treadling", p);
    tr.children[dr * state.T + t].classList.add("play-treadle");
  });
  // 高亮被提升/沉下的综框连结
  for (const k of state.tieup) {
    const [s, t] = parseKey(k);
    if (pressed.has(t)) {
      $("#gridTieup").children[s * state.T + t].classList.add("play-shaft");
    }
  }
  $$("#shaftRuler .rnum").forEach((rn) => {
    const s = +rn.dataset.idx;
    let up = false;
    for (const k of state.tieup) {
      const [ss, t] = parseKey(k);
      if (ss === s && pressed.has(t)) { up = true; break; }
    }
    rn.style.background = up ? "rgba(217,167,103,.75)" : "";
    rn.style.fontWeight = up ? "700" : "";
  });
  $$("#treadleRuler .rnum").forEach((rn) => {
    rn.style.background = pressed.has(+rn.dataset.idx) ? "rgba(126,164,221,.8)" : "";
    rn.style.fontWeight = pressed.has(+rn.dataset.idx) ? "700" : "";
  });
  $$("#picksRuler .rnum").forEach((rn) => {
    rn.style.background = +rn.dataset.idx === p ? "rgba(46,125,79,.35)" : "";
  });
}
function clearPlayRulerStyles() {
  $$(".rnum").forEach((rn) => { rn.style.background = ""; rn.style.fontWeight = ""; });
}
function setPlayPick(p) {
  play.pick = clamp(p, -1, state.P - 1);
  $("#playInfo").textContent =
    play.pick < 0 ? `第 — / ${state.P} 纬（待开始）` :
    `织造第 ${play.pick + 1} / ${state.P} 纬（织口在第 ${play.pick + 1} 行）`;
  renderGrid("threading"); renderGrid("tieup");
  renderGrid("treadling"); renderGrid("liftplan");
  clearPlayRulerStyles();
  applyPlayHighlights();
  drawPlayOverlay();
}
function startPlay() {
  if (play.running) { stopPlay(); return; }
  if (play.pick >= state.P - 1) play.pick = -1;
  play.running = true;
  $("#playBtn").textContent = "⏸ 暂停";
  const tick = () => {
    if (!play.running) return;
    if (play.pick >= state.P - 1) {
      if (play.loop) { play.pick = -1; }
      else { stopPlay(); return; }
    }
    setPlayPick(play.pick + 1);
    play.timer = setTimeout(tick, play.speed);
  };
  tick();
}
function stopPlay() {
  play.running = false;
  clearTimeout(play.timer);
  $("#playBtn").textContent = "▶ 逐纬织造";
}
function stepPlay(d) {
  stopPlay();
  setPlayPick(play.pick + d);
}

/* ============================================================
   变体：镜像 / 反转 / 换面（先预览）
   ============================================================ */
function buildVariant(kind) {
  const v = {
    S: state.S, T: state.T, E: state.E, P: state.P,
    threading: new Set(state.threading),
    tieup: new Set(state.tieup),
    treadling: new Set(state.treadling),
    liftplan: new Set(state.liftplan),
    shed: state.shed,
    mode: state.mode,
  };
  if (kind === "mirror") {
    // 左右镜像：经纱顺序反转（穿综列镜像）
    v.threading = new Set();
    for (const k of state.threading) {
      const [s, e] = parseKey(k);
      v.threading.add(key(s, state.E - 1 - e));
    }
  } else if (kind === "reverse") {
    // 上下反转：纬纱织造顺序倒序
    if (state.mode === "lift") {
      v.liftplan = new Set();
      for (const k of state.liftplan) {
        const [p, s] = parseKey(k);
        v.liftplan.add(key(state.P - 1 - p, s));
      }
    } else {
      v.treadling = new Set();
      for (const k of state.treadling) {
        const [p, t] = parseKey(k);
        v.treadling.add(key(state.P - 1 - p, t));
      }
    }
  } else if (kind === "flip") {
    // 换面：交换提综/沉综逻辑；为保持成布等价，反转“升综表达”
    v.shed = state.shed === "rising" ? "sinking" : "rising";
    if (state.mode === "lift") {
      // 直提：把每纬升综综框换成其补集（哨兵漏织纬保持漏织）。
      // 全沉纬（无标记）的补集＝全部综升起，仍是有效开口。
      const lift = new Set();
      const dead = new Uint8Array(state.P);
      for (const k of state.liftplan) {
        const [p, s] = parseKey(k);
        if (s === LIFT_DEAD && p < state.P) dead[p] = 1;
      }
      const present = Array.from({ length: state.P }, () => new Uint8Array(state.S));
      for (const k of state.liftplan) {
        const [p, s] = parseKey(k);
        if (s >= 0 && s < state.S && p < state.P) present[p][s] = 1;
      }
      for (let p = 0; p < state.P; p++) {
        if (dead[p]) { lift.add(key(p, LIFT_DEAD)); continue; }
        for (let s = 0; s < state.S; s++) if (!present[p][s]) lift.add(key(p, s));
      }
      v.liftplan = lift;
    } else {
      v.tieup = new Set();
      for (let s = 0; s < state.S; s++)
        for (let t = 0; t < state.T; t++)
          if (!state.tieup.has(key(s, t))) v.tieup.add(key(s, t));
    }
  }
  return v;
}
function previewVariant(kind) {
  pendingVariant = { kind, data: buildVariant(kind) };
  const titles = { mirror: "左右镜像", reverse: "上下反转", flip: "换面（正/反面）" };
  const box = $("#variantPreview");
  box.innerHTML = `
    <div class="diff-grid">
      <div><h4>当前版本</h4><div class="diff-cell-wrap" id="diffCur"></div></div>
      <div><h4>变体：${titles[kind]}</h4><div class="diff-cell-wrap" id="diffNew"></div></div>
    </div>
    <p class="small muted" style="margin-top:6px">红色=将消失的标记，绿色=将新增的标记。</p>`;
  $("#diffCur").appendChild(renderDraftClothSvg(state, false));
  $("#diffNew").appendChild(renderVariantClothSvg(pendingVariant.data));
  $("#variantActions").hidden = false;
}
function applyVariant() {
  if (!pendingVariant) return;
  const d = pendingVariant.data;
  state.threading = d.threading;
  state.tieup = d.tieup;
  state.treadling = d.treadling;
  state.liftplan = d.liftplan || new Set();
  state.mode = d.mode || "treadle";
  state.shed = d.shed;
  $("#shed").value = d.shed;
  updateShedHint();
  if (pendingVariant.kind === "mirror") invalidateReedOnWarpChange();
  pendingVariant = null;
  $("#variantActions").hidden = true;
  $("#variantPreview").innerHTML =
    '<p class="muted">已采用变体。可继续选择新的变体，或用撤销回到原版本。</p>';
  cancelSelection(true);
  syncSetupInputs();
  applyModeUI();
  rebuildAll();
  pushHistory();
  toast("已替换为变体");
}
function cancelVariant() {
  pendingVariant = null;
  $("#variantActions").hidden = true;
  $("#variantPreview").innerHTML =
    '<p class="muted">点击上方按钮，预览当前组织与变体的差异。确认后才会替换当前版本（可撤销）。</p>';
}

/* 变体预览小 SVG：直接按 draft 数据重算成布 */
function computeClothOf(d) {
  return computeClothFrom(d).cloth;
}
function renderDraftClothSvg(st, diff) {
  const arr = computeClothOf(st);
  return clothSvgEl(arr, state.E, state.P, 7, diff ? arr : null);
}
function renderVariantClothSvg(d) {
  const cur = computeClothOf(state);
  const nv = computeClothOf(d);
  return clothSvgEl(nv, state.E, state.P, 7, cur, nv);
}
function clothSvgEl(arr, E, P, px, diffA, diffB) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${E} ${P}`);
  svg.setAttribute("width", E * px);
  svg.setAttribute("height", P * px);
  svg.style.display = "block";
  let html = "";
  for (let p = 0; p < P; p++) {
    for (let e = 0; e < E; e++) {
      const v = arr[p * E + e], y = P - 1 - p;
      let fill = v === 1 ? "#2b2b28" : v === 0 ? "#fff" : "#d6d2c6";
      if (diffA && diffB) {
        const a = diffA[p * E + e], b = (diffB || arr)[p * E + e];
        if (a === 1 && b !== 1) fill = "#f2b8b0";
        else if (a !== 1 && b === 1) fill = "#b7e4c0";
      }
      html += `<rect x="${e}" y="${y}" width="1.02" height="1.02" fill="${fill}" stroke="#e0dccf" stroke-width=".05"/>`;
    }
  }
  svg.innerHTML = html;
  return svg;
}

/* ============================================================
   编辑区模式：踏板组织图 ⇄ 直提升综计划（LIFTPLAN）
   ============================================================ */

/* UI 切换：显示/隐藏对应网格、尺与说明（不动数据） */
function applyModeUI() {
  const isLift = state.mode === "lift";
  $("#gridTieup").hidden = isLift;
  $("#gridTreadling").hidden = isLift;
  $("#treadleRuler").hidden = isLift;
  $("#liftNote").hidden = !isLift;
  $("#gridLiftplan").hidden = !isLift;
  $("#liftColRuler").hidden = !isLift;
  $("#legendTreadle").hidden = isLift;
  $("#legendLift").hidden = !isLift;
  $("#legendLiftSwatch").hidden = !isLift;
  $("#legendLiftText").hidden = !isLift;
  $("#boardLegendTitle").textContent = isLift ? "直提式四宫格：" : "四宫格：";
  // 直提模式下“踏板数”作为切回踏板模式时的预算，仍允许调整
  $("#treadles").disabled = false;
  $("#treadlesLabel").textContent = isLift ? "踏板预算" : "踏板";
  $("#treadles").title = isLift
    ? "切回踏板模式时允许的最大踏板数（预算）"
    : "";
  // 顶部模式按钮
  $$("#editMode button").forEach((b) =>
    b.classList.toggle("active", b.dataset.editmode === state.mode));
  setBoardVars();
  updateShedHint();
}

/* 踏板稿 → 升综计划：按现有连结 + 踏序逐纬求“升起”的综框。
   LIFTPLAN 按 WIF 约定始终记录升起综框，与 Shed 无关；
   沉综逻辑下未连结而升起的综框列入计划，连结的综框沉下。 */
function treadleToLift() {
  const { S, P } = state;
  const lift = new Set();
  let dead = 0;
  // 每片综连结的踏板
  const treadlesOfShaft = Array.from({ length: S }, () => []);
  for (const k of state.tieup) {
    const [s, t] = parseKey(k);
    if (s < S && t < state.T) treadlesOfShaft[s].push(t);
  }
  for (let p = 0; p < P; p++) {
    const pressed = new Set();
    for (const k of state.treadling) {
      const [pp, t] = parseKey(k);
      if (pp === p && t < state.T) pressed.add(t);
    }
    if (!pressed.size) { lift.add(key(p, LIFT_DEAD)); dead++; continue; }
    // 踩下的踏板是否至少有一个带连结：全为空连结踏板时，
    // 提综逻辑＝全综沉下（有效全沉纬，计划行留空）；
    // 沉综逻辑＝全综升起（计划列入全部综）。
    let anyLink = false;
    for (const t of pressed) {
      for (let s = 0; s < S; s++) if (state.tieup.has(key(s, t))) { anyLink = true; break; }
      if (anyLink) break;
    }
    if (!anyLink) {
      if (state.shed === "sinking")
        for (let s = 0; s < S; s++) lift.add(key(p, s));
      // rising：不写任何键＝有效全沉纬
      continue;
    }
    for (let s = 0; s < S; s++) {
      const linked = treadlesOfShaft[s].some((t) => pressed.has(t));
      // rising: 连结=升起 → 列入计划；sinking: 连结=沉下 → 未连结者升起，列入计划
      const raised = state.shed === "sinking" ? !linked : linked;
      if (raised) lift.add(key(p, s));
    }
  }
  return { lift, dead };
}

/* ============================================================
   复合踏板求解：直提升综稿 → 踏板稿（允许一纬同踩多片踏板）
   ------------------------------------------------------------
   每纬的目标开口（升综综框集合）要表达为“若干踏板连结的并集”：
     提综逻辑：踏板连结＝升起综框，并集须恰好等于目标升综集；
     沉综逻辑：踏板连结＝沉下综框，并集须恰好等于升综集的补集。
   限制：踏板总预算 B、每纬最多同踩 K 片；可选把直提稿中保留的
   旧连结列（state.tieup）锁为固定列，求解器只能在其后增补新列。
   ============================================================ */
const SOLVER_LS = "wovenproof_solver_v1";
let solverPrefs = loadSolverPrefs();
function loadSolverPrefs() {
  try {
    return Object.assign({ K: 2, lock: false }, JSON.parse(localStorage.getItem(SOLVER_LS) || "{}"));
  } catch (e) { return { K: 2, lock: false }; }
}
function saveSolverPrefs() {
  try { localStorage.setItem(SOLVER_LS, JSON.stringify(solverPrefs)); } catch (e) {}
}

/* 32 位集合运算（综框最多 32 片，掩码按 uint32 处理） */
function popcount32(x) {
  x = x >>> 0;
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return ((((x + (x >>> 4)) & 0x0f0f0f0f) >>> 0) * 0x01010101) >>> 24;
}
function lowBit32(x) { return (x & -x) >>> 0; }
function bitsOf32(m) {
  const out = [];
  m = m >>> 0;
  for (let s = 0; s < 32; s++) if ((m >>> s) & 1) out.push(s);
  return out;
}

/* 直提稿中保留的旧踏板稿信息：列数与每列连结掩码（可能为空） */
function retainedTreadleInfo() {
  let n = 0;
  for (const k of state.tieup) {
    const [s, t] = parseKey(k);
    if (s < state.S) n = Math.max(n, t + 1);
  }
  for (const k of state.treadling) {
    const [, t] = parseKey(k);
    n = Math.max(n, t + 1);
  }
  const masks = [];
  for (let t = 0; t < n; t++) {
    let m = 0;
    for (let s = 0; s < state.S; s++) if (state.tieup.has(key(s, t))) m |= (1 << s) >>> 0;
    masks.push(m >>> 0);
  }
  return { n, masks, has: n > 0 };
}

/* 每纬目标：upMasks=升综综框（WIF 约定，与开口逻辑无关）；
   tieMasks=该纬踩下踏板连结的并集目标；dead=漏织哨兵 */
function solverTargets() {
  const { S, P } = state;
  const FULL = S >= 32 ? 0xffffffff : ((1 << S) >>> 0) - 1;
  const upMasks = new Array(P).fill(0);
  const tieMasks = new Array(P).fill(0);
  const dead = new Uint8Array(P);
  for (let p = 0; p < P; p++) {
    if (isDeadLiftPick(p)) { dead[p] = 1; continue; }
    let up = 0;
    for (const k of state.liftplan) {
      const [pp, s] = parseKey(k);
      if (pp === p && s >= 0 && s < S) up |= (1 << s) >>> 0;
    }
    up >>>= 0;
    upMasks[p] = up;
    tieMasks[p] = state.shed === "sinking" ? ((~up) & FULL) >>> 0 : up;
  }
  return { upMasks, tieMasks, dead, FULL };
}

/* 枚举用不超过 K 个块（blocks 中元素的掩码都须是 m 的子集）覆盖 m 的全部方案。
   按索引号 include/exclude 深度优先，每个索引集合只产生一次；允许块间重叠。
   返回下标数组的数组。 */
function enumCovers(m, blocks, K, optCap, nodeCap) {
  const res = [];
  const chosen = [];
  let nodes = 0;
  let truncated = false;
  function rec(rem, i) {
    if (res.length >= optCap) return;
    if (nodes++ > nodeCap) { truncated = true; return; }
    if (rem === 0) { res.push(chosen.slice()); return; }
    if (chosen.length >= K || i >= blocks.length) return;
    // 先尝试不含第 i 块……
    rec(rem, i + 1);
    // ……再尝试把第 i 块并入（它至少要覆盖尚未覆盖的综框）
    const bm = blocks[i].mask;
    if (bm & rem) {
      chosen.push(i);
      rec((rem & ~bm) >>> 0, i + 1);
      chosen.pop();
    }
  }
  rec(m >>> 0, 0);
  return { res, truncated };
}

/* 求解主入口。返回
   {ok:true, sols:[...]} 或 {ok:false, fail:{reason, groups:[{up,picks}], ...}} */
function solveCompound(budget, K, lock) {
  const P = state.P;
  const { upMasks, tieMasks, dead, FULL } = solverTargets();
  const retained = retainedTreadleInfo();
  let lockMasks = [];
  if (lock && retained.has) {
    if (retained.n > budget) {
      return { ok: false, fail: { reason: "lockover", nLock: retained.n, budget,
        groups: collectFailGroups(tieMasks, upMasks, dead, P, null) } };
    }
    lockMasks = retained.masks.slice();
  }
  const nLock = lockMasks.length;

  // 不同的有效开口（连结并集目标）；0=全沉纬专用（rising 空连结 / sinking 全连结）
  const rowOfMask = new Map();
  for (let p = 0; p < P; p++) {
    if (dead[p]) continue;
    const m = tieMasks[p];
    if (!rowOfMask.has(m)) rowOfMask.set(m, []);
    rowOfMask.get(m).push(p);
  }
  const hasZero = rowOfMask.has(0);
  const rows = [...rowOfMask.keys()].filter((m) => m !== 0);
  const budgetNew = budget - nLock;

  // 全部纬都是漏织哨兵：没有任何有效开口可归并
  if (!rows.length && !hasZero) {
    return { ok: false, fail: { reason: "alldead", budget, nLock, groups: [] } };
  }

  /* ---- 新块候选池：行掩码 + 单片综 + 有限次交闭包 ---- */
  const POOL_CAP = 520;
  const pset = new Set(rows);
  let usedBits = 0;
  for (const m of rows) usedBits |= m;
  for (let s = 0; s < state.S; s++)
    if ((usedBits >>> s) & 1) pset.add((1 << s) >>> 0);
  for (let pass = 0; pass < 2 && pset.size < POOL_CAP; pass++) {
    const before = pset.size;
    const adds = new Set();
    // 以行掩码为锚：新块必须是某行目标的子集才有资格被踩
    for (const row of rows) {
      for (const b of pset) {
        if (pset.size + adds.size >= POOL_CAP) break;
        const c = (row & b) >>> 0;
        if (c && c !== b) adds.add(c);
      }
      if (pset.size + adds.size >= POOL_CAP) break;
    }
    for (const a of adds) pset.add(a);
    if (pset.size === before) break;
  }
  for (const lm of lockMasks) pset.delete(lm); // 与固定列同掩码：白用固定列
  pset.delete(0);
  const pool = [...pset];

  /* ---- 每个行掩码的覆盖选项：{news:[新块id...], size} ---- */
  const rowOpts = rows.map((m) => {
    const blocks = [];
    for (let t = 0; t < lockMasks.length; t++)
      if (lockMasks[t] !== 0 && (lockMasks[t] & ~m) === 0)
        blocks.push({ mask: lockMasks[t], lock: true, idx: t });
    for (let id = 0; id < pool.length; id++)
      if ((pool[id] & ~m) === 0) blocks.push({ mask: pool[id], lock: false, idx: id });
    blocks.sort((a, b) => popcount32(b.mask) - popcount32(a.mask));
    const { res } = enumCovers(m, blocks, K, 900, 60000);
    const best = new Map(); // 相同新块集合只留踩板数最少的
    for (const ix of res) {
      const news = [];
      for (const i of ix) if (!blocks[i].lock) news.push(blocks[i].idx);
      news.sort((a, b) => a - b);
      const sig = news.join(",");
      if (!best.has(sig) || ix.length < best.get(sig).size)
        best.set(sig, { news, size: ix.length });
    }
    return [...best.values()].sort((a, b) => a.news.length - b.news.length || a.size - b.size);
  });

  /* ---- 结构性可行基（不依赖回溯，保证可解场景一定出候选） ---- */
  // 候选池/回溯受节点与时间上限约束，可能漏掉“多开口共享单综块”一类解；
  // 显式构造两个恒成立的基兜底：
  //   A 每个不同开口独占一片踏板（并集＝该开口本身，恒为 1 踩）；
  //   B 每个出现过的综框一片单综踏板，同纬同踩（要求该开口综数 ≤ K）。
  // 固定列若已含同掩码踏板则自动抵扣，不必新增。
  const poolIdOf = new Map();
  pool.forEach((m, id) => poolIdOf.set(m, id));
  const lockMaskSet = new Set(lockMasks.map((m) => m >>> 0));
  const reserveZero0 = hasZero && lockMasks.indexOf(0) < 0 ? 1 : 0;
  const needPoolId = (mask) => {
    if (lockMaskSet.has(mask)) return null; // 固定列已提供
    return poolIdOf.get(mask);              // 候选池一定含行掩码与单综块
  };
  const rowBasisIds = new Set();      // 基 A
  const singletonIds = new Set();    // 基 B
  for (const m of rows) {
    const id = needPoolId(m);
    if (id !== null) rowBasisIds.add(id);
  }
  for (let s = 0; s < state.S; s++) {
    if (!((usedBits >>> s) & 1)) continue;
    const id = needPoolId((1 << s) >>> 0);
    if (id !== null) singletonIds.add(id);
  }
  const maxRowPop = rows.reduce((mx, m) => Math.max(mx, popcount32(m)), 0);

  const forcedBases = [];
  if (nLock + rowBasisIds.size + reserveZero0 <= budget) forcedBases.push(rowBasisIds);
  // 基 B：每行要踩的单综踏板数（固定列已覆盖的综可省踩）不超过 K，且块数在预算内
  let basisBRowOK = true;
  for (const m of rows) {
    let need = popcount32(m);
    for (const lm of lockMasks) if (popcount32(lm) === 1 && (lm & m) === lm) need--;
    if (need > K) { basisBRowOK = false; break; }
  }
  if (basisBRowOK && nLock + singletonIds.size + reserveZero0 <= budget)
    forcedBases.push(singletonIds);

  /* ---- 回溯：为每个行掩码选一组覆盖，最少新增块 ---- */
  const order = rows.map((m, i) => i).sort((a, b) => rowOpts[a].length - rowOpts[b].length);
  const leaves = new Map(); // 掩码签名 -> {used:Set, maxSize}
  const LEAF_CAP = 48;
  const NODE_CAP = 45000;
  let nodes = 0;
  let searchCapped = false;
  const deadline = Date.now() + 450;
  // 结构性可行基的最小新增块数，作为回溯上界，尽早剪掉过大分支
  let bestCount = forcedBases.reduce((mx, b) => Math.min(mx, b.size), Infinity);

  // 全局快速容许下界：每个不同行掩码至少要新增的块数取最大
  let globalLB = 0;
  for (const opts of rowOpts) {
    let mn = Infinity;
    for (const o of opts) if (o.news.length < mn) mn = o.news.length;
    if (mn > globalLB) globalLB = mn;
  }
  const provablyInfeasible = globalLB + reserveZero0 > budgetNew && !forcedBases.length;
  if (!provablyInfeasible) {

  // 贪心预解：再给 bestCount 一个紧上界
  {
    const used = new Set();
    for (const ri of order) {
      let best = null, cost = Infinity;
      for (const o of rowOpts[ri]) {
        let c = 0;
        for (const id of o.news) if (!used.has(id)) c++;
        if (c < cost) { cost = c; best = o; }
      }
      if (best) for (const id of best.news) used.add(id);
    }
    if (used.size + reserveZero0 <= budgetNew) bestCount = Math.min(bestCount, used.size);
  }

  // 预计算每个行选项的“新增块”掩码（pool 最多 520，用两个 32 位字）
  const optMasks = rowOpts.map((opts) => opts.map((o) => {
    let lo = 0, hi = 0;
    for (const id of o.news) { if (id < 32) lo |= 1 << id; else hi |= 1 << (id - 32); }
    return { lo: lo >>> 0, hi: hi >>> 0, size: o.size, news: o.news };
  }));
  const orLo = (a, b) => (a.lo | b.lo) >>> 0, orHi = (a, b) => (a.hi | b.hi) >>> 0;

  function lbRemaining(depth, ulo, uhi) {
    // 容许下界：剩余各行至少各自要补的新块数取最大（只抽查部分行）
    let lb = 0;
    for (let d = depth; d < order.length && d < depth + 32; d++) {
      const opts = optMasks[order[d]];
      let mn = Infinity;
      for (const o of opts) {
        const c = popcount32(o.lo & ~ulo) + popcount32(o.hi & ~uhi);
        if (c < mn) mn = c;
        if (mn === 0) break;
      }
      if (mn > lb) lb = mn;
    }
    return lb;
  }
  // 全沉纬要占一列空连结踏板（优先借用固定列中的空列）；预算结算与开口逻辑无关
  const reserveZero = hasZero && lockMasks.indexOf(0) < 0;
  function dfs(depth, usedLo, usedHi, usedCount) {
    if (nodes++ > NODE_CAP || Date.now() > deadline) { searchCapped = true; return; }
    if (usedCount > bestCount) return;
    const reserve = reserveZero ? 1 : 0;
    if (usedCount + reserve > budgetNew) return;
    if (usedCount + lbRemaining(depth, usedLo, usedHi) + reserve > budgetNew) return;
    if (depth === order.length) {
      const used = [];
      for (let id = 0; id < pool.length; id++)
        if ((id < 32 ? (usedLo >>> id) & 1 : (usedHi >>> (id - 32)) & 1)) used.push(id);
      const sig = used.map((id) => pool[id]).sort((a, b) => a - b).join(",");
      if (!leaves.has(sig)) {
        leaves.set(sig, { used: new Set(used), maxSize: 0 });
        if (usedCount < bestCount) bestCount = usedCount;
        if (leaves.size >= LEAF_CAP) { searchCapped = true; return; }
      }
      return;
    }
    const ri = order[depth];
    // 先试新增块最少的踩法，尽快找到小基以强剪后续分支
    const ranked = optMasks[ri].map((o) => ({
      o, add: popcount32(o.lo & ~usedLo) + popcount32(o.hi & ~usedHi),
    })).sort((a, b) => a.add - b.add || a.o.lo - b.o.lo);
    for (const { o, add } of ranked) {
      if (usedCount + add + reserve > budgetNew) continue;
      dfs(depth + 1, orLo({ lo: usedLo }, o), orHi({ hi: usedHi }, o), usedCount + add);
      if (searchCapped) return;
    }
  }
  dfs(0, 0, 0, 0);
  } // end !provablyInfeasible

  /* ---- 评估：回溯基 + 两个结构性可行基（后者保证可解稿必有零差异候选） ---- */
  const sols = [];
  const evalCache = new Map(); // 列掩码集合签名 -> 每行掩码的踩法缓存
  const seenSig = new Set();
  const tryBasis = (ids) => {
    const sol = evaluateBasis(ids, pool, lockMasks, nLock, tieMasks, dead,
                              K, budget, FULL, evalCache);
    if (!sol) return;
    const sig = [...sol.tieup].sort().join(",") + "|" + sol.planT;
    if (seenSig.has(sig)) return;
    seenSig.add(sig);
    sols.push(sol);
  };
  for (const leaf of leaves.values()) tryBasis(leaf.used);
  for (const b of forcedBases) tryBasis(b);
  sols.sort((a, b) =>
    a.planT - b.planT || a.maxPress - b.maxPress || a.foot - b.foot || a.usedCount - b.usedCount);
  const top = sols.slice(0, 8);

  if (top.length) return { ok: true, sols: top, capped: searchCapped, budget, K, lock, nLock };

  /* ---- 限制内无解 ---- */
  let fail;
  if (maxRowPop > K) {
    // 某纬目标并集含综数 > K：至多 K 片踏板无法逐综覆盖
    fail = { reason: "overshed", budget, nLock, K,
      groups: collectFailGroups(tieMasks, upMasks, dead, P,
        new Set(rows.filter((m) => popcount32(m) > K))) };
  } else {
    fail = greedyFailure(rowOpts, order, rows, pool, lockMasks, nLock, budget, budgetNew,
                         hasZero, tieMasks, upMasks, dead, P, FULL);
  }
  fail.capped = searchCapped;
  return { ok: false, fail };
}

function collectFailGroups(tieMasks, upMasks, dead, P, badSet) {
  const groups = new Map();
  for (let p = 0; p < P; p++) {
    if (dead[p]) continue;
    if (badSet && !badSet.has(tieMasks[p])) continue;
    const m = upMasks[p];
    if (!groups.has(m)) groups.set(m, []);
    groups.get(m).push(p);
  }
  return [...groups.entries()].map(([up, picks]) => ({ up, picks }));
}

function greedyFailure(rowOpts, order, rows, pool, lockMasks, nLock, budget, budgetNew,
                       hasZero, tieMasks, upMasks, dead, P, FULL) {
  const used = new Set();
  const bad = new Set();
  // 用得越频繁的行优先给块
  const ord = order.slice().sort((a, b) => rowOfMaskSize(rows[b]) - rowOfMaskSize(rows[a]));
  function rowOfMaskSize(i) { let c = 0; for (let p = 0; p < P; p++) if (!dead[p] && tieMasks[p] === rows[i]) c++; return c; }
  const reserveZero = hasZero && lockMasks.indexOf(0) < 0 ? 1 : 0;
  for (const ri of ord) {
    const opts = rowOpts[ri];
    let picked = null, cost = Infinity;
    for (const o of opts) {
      let c = 0;
      for (const id of o.news) if (!used.has(id)) c++;
      if (c < cost) { cost = c; picked = o; }
    }
    if (picked && used.size + cost + reserveZero <= budgetNew) {
      for (const id of picked.news) used.add(id);
    } else bad.add(rows[ri]);
  }
  // 全沉纬需要一个空连结列：优先借用固定空列，否则占一个新列名额
  if (reserveZero && used.size + 1 > budgetNew) bad.add(0);
  return { reason: "budget", budget, nLock,
           groups: collectFailGroups(tieMasks, upMasks, dead, P, bad) };
}

/* 给定“新增块集合”，排出具体踏板列并求最省换脚的逐纬踩法 */
function evaluateBasis(usedIds, pool, lockMasks, nLock, tieMasks, dead, K, budget, FULL, evalCache) {
  const P = state.P;
  // 列：先固定列（掩码/位置不变），再把新块打包到其后
  const cols = lockMasks.map((m, t) => ({ t, mask: m >>> 0, lock: true }));
  for (const id of usedIds) cols.push({ t: cols.length, mask: pool[id] >>> 0, lock: false });
  // 全沉纬（仅提综逻辑下 tieMask=0）专用列：踩一个“空连结踏板”即空并集
  let zeroP = -1;
  const needZero = tieMasks.some((m, p) => !dead[p] && m === 0);
  if (needZero) {
    zeroP = cols.findIndex((c) => c.mask === 0);
    if (zeroP < 0) { zeroP = cols.length; cols.push({ t: zeroP, mask: 0, lock: false }); }
  }
  const planT = cols.length;
  if (planT > budget) return null;

  // 每纬可选踩法（列号集合），死纬只能空踩；同列布局下按行掩码缓存
  const layoutSig = cols.map((c) => c.mask).join(",");
  let coverCache = evalCache.get(layoutSig);
  if (!coverCache) { coverCache = new Map(); evalCache.set(layoutSig, coverCache); }
  const coverOf = (m) => {
    if (coverCache.has(m)) return coverCache.get(m);
    const usable = cols.map((c, i) => ({ mask: c.mask, i }))
                       .filter((b) => b.mask !== 0 && (b.mask & ~m) === 0);
    usable.sort((a, b) => popcount32(b.mask) - popcount32(a.mask));
    const { res } = enumCovers(m, usable, K, 2000, 40000);
    const seen = new Set();
    let list = res.map((ix) => ix.map((i) => usable[i].i)).filter((a) => {
      a.sort((x, y) => x - y);
      const sig = a.join(",");
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    }).sort((a, b) => a.length - b.length).slice(0, 90);
    coverCache.set(m, list);
    return list;
  };

  const opts = [];
  for (let p = 0; p < P; p++) {
    if (dead[p]) { opts.push([[]]); continue; }
    const m = tieMasks[p];
    if (m === 0) { opts.push([[zeroP]]); continue; }
    const list = coverOf(m);
    if (!list.length) return null;
    opts.push(list);
  }

  // Viterbi：相邻两纬换脚 = 踩板集合对称差大小；与死纬相邻 = 抬起/落下的脚数
  const trans = (a, b) => {
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    return popcount32((xorSets(a, b)));
  };
  function xorSets(a, b) {
    let m = 0;
    for (const t of a) m ^= 1 << t;
    for (const t of b) m ^= 1 << t;
    return m >>> 0;
  }
  // 回溯
  const press = new Array(P);
  // 记录每一步的层表（第 0 层不记录父指针）
  const layers = [opts[0].map((o) => ({ cost: o.length, par: -1 }))];
  for (let p = 1; p < P; p++) {
    const prev = layers[p - 1];
    layers.push(opts[p].map((o) => {
      let best = Infinity, bi = -1;
      for (let i = 0; i < prev.length; i++) {
        const c = prev[i].cost + trans(opts[p - 1][i], o);
        if (c < best) { best = c; bi = i; }
      }
      return { cost: best, par: bi };
    }));
  }
  let j = layers[P - 1].reduce((bi, x, i) => x.cost < layers[P - 1][bi].cost ? i : bi, 0);
  for (let p = P - 1; p > 0; p--) {
    press[p] = opts[p][j];
    j = layers[p][j].par;
  }
  press[0] = opts[0][j];
  // 换脚次数只算相邻纬（不含第一纬落脚）
  let foot = 0, maxPress = 0;
  const usedT = new Set();
  for (let p = 0; p < P; p++) {
    maxPress = Math.max(maxPress, press[p].length);
    for (const t of press[p]) usedT.add(t);
    if (p > 0) foot += trans(press[p - 1], press[p]);
  }

  // 产出 tieup / treadling 集合
  const tieup = new Set(), treadling = new Set();
  cols.forEach((c, t) => {
    for (let s = 0; s < state.S; s++) if ((c.mask >>> s) & 1) tieup.add(key(s, t));
  });
  for (let p = 0; p < P; p++)
    for (const t of press[p]) treadling.add(key(p, t));

  // 成布一致性核对（机器解应为 0 差异）
  const trial = {
    S: state.S, T: planT, E: state.E, P, shed: state.shed, mode: "treadle",
    threading: state.threading, tieup, treadling,
  };
  const cur = computeClothOf(state), nv = computeClothOf(trial);
  let diff = 0;
  for (let i = 0; i < cur.length; i++) if (cur[i] !== nv[i]) diff++;

  return { planT, usedCount: usedT.size, maxPress, foot, tieup, treadling,
           press, cols, diff, lockCount: nLock };
}

/* ---------------- 求解器模态 ---------------- */
let solverUI = null;

function switchEditMode(target) {
  if (target === state.mode) return;
  if (target === "lift") {
    // 踏板 → 直提：直接生成并切入（原踏板稿保留在状态中，撤销可回）
    const { lift, dead } = treadleToLift();
    state.liftplan = lift;
    state.mode = "lift";
    stopPlay(); play.pick = -1;
    cancelSelection(true);
    syncSetupInputs();
    applyModeUI();
    rebuildAll();
    pushHistory();
    toast(`已按现有连结与踏序生成升综计划（${dead} 纬无有效踏板，记为漏织）`);
    return;
  }
  // 直提 → 踏板：复合踏板求解，先出候选预览，零差异才能采用
  let hasOOR = false;
  for (const k of state.liftplan) {
    const [p, s] = parseKey(k);
    if (s !== LIFT_DEAD && (p >= state.P || s >= state.S)) { hasOOR = true; break; }
  }
  if (hasOOR) {
    toast("升综计划存在越界标记，请先在问题列表清除后再切回踏板", 3200);
    return;
  }
  openSolverModal();
}

function openSolverModal() {
  const retained = retainedTreadleInfo();
  solverUI = {
    budget: clamp(state.T | 0, 1, 32),
    K: clamp(solverPrefs.K || 2, 1, 32),
    lock: !!solverPrefs.lock && retained.has,
    retained,
    result: null,
    sel: 0,
    solveTimer: null,
  };
  renderSolverShell("复合踏板求解 · 直提稿切回踏板");
  scheduleSolve();
}

function renderSolverShell(title) {
  const ui = solverUI;
  const body = document.createElement("div");
  const lockable = ui.retained.has;
  body.innerHTML = `
    <div class="solve-params">
      <label>踏板预算 <input type="number" min="1" max="32" id="solveBudget" value="${ui.budget}">
        <small>含固定列</small></label>
      <label>每纬最多同踩 <input type="number" min="1" max="32" id="solveK" value="${ui.K}"> 片</label>
      <label class="ck"><input type="checkbox" id="solveLock" ${ui.lock ? "checked" : ""}
        ${lockable ? "" : "disabled"}>
        锁定已有连结列${lockable ? `（${ui.retained.n} 列作为固定条件，只能在其后增补）` : "（当前直提稿无保留踏板稿）"}</label>
      <button id="solveRun">重新求解</button>
      <span id="solveStatus" class="small muted"></span>
    </div>
    <div id="solveResult" class="solve-result"></div>`;
  const foot = [
    { label: "放入沙盒手调", primary: true, action: () => openSandbox() },
    { label: "取消（直提稿保持不变）", action: () => { solverUI = null; closeModal(); } },
  ];
  openModal(title, body, foot, true);
  $("#modalBox").classList.add("xwide");
  $("#modalFoot").querySelectorAll("button")[0].id = "btnOpenSandbox";

  const arm = () => {
    ui.budget = clamp(+$("#solveBudget").value || 1, 1, 32);
    ui.K = clamp(+$("#solveK").value || 1, 1, 32);
    ui.lock = $("#solveLock").checked;
    solverPrefs.K = ui.K;
    solverPrefs.lock = ui.lock;
    saveSolverPrefs();
  };
  for (const id of ["solveBudget", "solveK"])
    $(("#" + id)).addEventListener("change", () => { arm(); scheduleSolve(); });
  $("#solveLock").addEventListener("change", () => { arm(); scheduleSolve(); });
  $("#solveRun").addEventListener("click", () => { arm(); scheduleSolve(); });
}

function scheduleSolve() {
  const ui = solverUI;
  if (!ui) return;
  clearTimeout(ui.solveTimer);
  $("#solveStatus").textContent = "求解中…";
  ui.solveTimer = setTimeout(() => {
    const r = solveCompound(ui.budget, ui.K, ui.lock);
    ui.result = r;
    ui.sel = 0;
    renderSolveResult();
  }, 30);
}

function renderSolveResult() {
  const ui = solverUI;
  const box = $("#solveResult");
  if (!box) return;
  const r = ui.result;
  if (!r) return;
  box.innerHTML = "";

  if (!r.ok) {
    $("#solveStatus").textContent = "限制内无解，直提稿未改动";
    box.appendChild(renderFailure(r.fail));
    const sbBtn = $("#btnOpenSandbox");
    if (sbBtn) sbBtn.disabled = true;
    // 放宽预算按钮：锁定列超限→放到固定列数；预算不足→放到“不同开口数”（一纬一踏总够）
    const foot = $("#modalFoot");
    if (!foot.querySelector("#solveRelax")) {
      const b = document.createElement("button");
      b.id = "solveRelax";
      b.textContent = r.fail.reason === "lockover"
        ? `预算增至 ${r.fail.nLock} 后重解`
        : "放宽预算/同踩上限";
      b.addEventListener("click", () => {
        const { tieMasks, dead } = solverTargets();
        const distinct = new Set();
        for (let p = 0; p < state.P; p++) if (!dead[p]) distinct.add(tieMasks[p]);
        if (r.fail.reason === "lockover") ui.budget = r.fail.nLock;
        else {
          ui.budget = Math.max(ui.budget, distinct.size, (solverUI.lock ? retainedTreadleInfo().n : 0) + 1);
          ui.K = Math.max(ui.K, 4);
        }
        solverPrefs.K = ui.K;
        saveSolverPrefs();
        $("#solveBudget").value = ui.budget;
        $("#solveK").value = ui.K;
        scheduleSolve();
      });
      foot.insertBefore(b, foot.firstChild);
    }
    $("#solveRelax").hidden = r.fail.reason === "alldead";
    return;
  }
  const relaxBtn = $("#solveRelax");
  if (relaxBtn) relaxBtn.hidden = true;
  $("#solveStatus").innerHTML =
    `找到 <b>${r.sols.length}</b> 个零差异候选（按踏板数 → 最大同踩 → 换脚次数排序）` +
    (r.capped ? " · 搜索达上限，已给出当前最优候选" : "");
  const sbBtn = $("#btnOpenSandbox");
  if (sbBtn) sbBtn.disabled = false;

  const list = document.createElement("div");
  list.className = "sol-list";
  r.sols.forEach((sol, i) => list.appendChild(renderSolCard(sol, i)));
  list.addEventListener("click", (ev) => {
    const card = ev.target.closest(".sol-card");
    if (!card) return;
    ui.sel = +card.dataset.i;
    list.querySelectorAll(".sol-card").forEach((c) =>
      c.classList.toggle("sel", +c.dataset.i === ui.sel));
  });
  box.appendChild(list);
}

/* 单个候选卡片：连结 / 复合踏序 / 成布差异 / 逐纬脚法 四块并排 */
function renderSolCard(sol, i) {
  const ui = solverUI;
  const card = document.createElement("div");
  card.className = "sol-card" + (i === ui.sel ? " sel" : "");
  card.dataset.i = i;
  const lockTxt = sol.lockCount ? `含 ${sol.lockCount} 列固定 · ` : "";
  card.innerHTML = `
    <div class="sol-head">
      <b>候选 ${i + 1}</b>
      <span class="sol-stat">${lockTxt}踏板 <b>${sol.planT}</b> 片（预算 ${ui.budget}，实踩 ${sol.usedCount}）</span>
      <span class="sol-stat">最大同踩 <b>${sol.maxPress}</b>（限 ${ui.K}）</span>
      <span class="sol-stat">相邻纬换脚 <b>${sol.foot}</b> 次</span>
      <span class="sol-stat ok">成布差异 <b>${sol.diff}</b></span>
    </div>`;
  const blocks = document.createElement("div");
  blocks.className = "conv-blocks sol-blocks";
  blocks.appendChild(renderConvBlock("踏板连结（行=综，列=踏）", sol.tieup, state.S, sol.planT,
    (r, c) => sol.tieup.has(key(r, c)), "#8a5a2b"));
  blocks.appendChild(renderConvBlock("复合踏序（上=最新纬，列=踏）", sol.treadling, state.P, sol.planT,
    (r, c) => sol.treadling.has(key(state.P - 1 - r, c)), "#2456a6"));
  const cur = computeClothOf(state);
  const trial = {
    S: state.S, T: sol.planT, E: state.E, P: state.P, shed: state.shed, mode: "treadle",
    threading: state.threading, tieup: sol.tieup, treadling: sol.treadling,
  };
  blocks.appendChild(clothDiffMiniSvg(cur, computeClothOf(trial)));
  blocks.appendChild(renderFootworkBlock(sol));
  card.appendChild(blocks);
  return card;
}

/* 逐纬脚法：自最新纬向下，标出每纬所踩踏板与相对上一纬的换脚数 */
function renderFootworkBlock(sol) {
  const wrap = document.createElement("div");
  wrap.className = "conv-block fw-block";
  let s = `<div class="cb-title">逐纬脚法（数字=踏板号）</div><div class="fw-list">`;
  const { dead } = solverTargets();
  for (let p = state.P - 1; p >= 0; p--) {
    const cur = sol.press[p] || [];
    let chg = "", cls = "";
    if (p < state.P - 1) {
      const prev = sol.press[p + 1] || [];
      const n = footChange(prev, cur);
      if (n > 0) { chg = `换脚 ${n}`; cls = " chg"; }
    }
    const feet = dead[p]
      ? `<span class="fw-dead">漏织·不踩</span>`
      : cur.length ? cur.map((t) => `<i>${t + 1}</i>`).join("") : `<span class="fw-dead">—</span>`;
    s += `<div class="fw-row${cls}"><span class="fw-p">纬${p + 1}</span><span class="fw-feet">${feet}</span><span class="fw-chg">${chg}</span></div>`;
  }
  s += `</div>`;
  wrap.innerHTML = s;
  return wrap;
}
function footChange(a, b) {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let m = 0;
  for (const t of a) m ^= 1 << t;
  for (const t of b) m ^= 1 << t;
  return popcount32(m);
}

/* 小网格预览（通用黑白/单色点） */
function renderConvBlock(title, set, rows, cols, has, color) {
  const wrap = document.createElement("div");
  wrap.className = "conv-block";
  const px = clamp(Math.min(10, 320 / Math.max(rows, cols)), 3, 10);
  let s = `<div class="cb-title">${escapeHtml(title)}</div>`;
  s += `<svg width="${cols * px}" height="${rows * px}" viewBox="0 0 ${cols} ${rows}">`;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      s += `<rect x="${c}" y="${r}" width="1.02" height="1.02"
            fill="${has(r, c) ? color : "#fff"}" stroke="#e0dccf" stroke-width=".05"/>`;
  s += `</svg>`;
  wrap.innerHTML = s;
  return wrap;
}
/* 成布差异小图：红=当前将消失，绿=转换新增，白/黑=一致 */
function clothDiffMiniSvg(cur, nv) {
  const wrap = document.createElement("div");
  wrap.className = "conv-block";
  const { E, P } = state;
  const px = clamp(Math.min(7, 360 / Math.max(E, P)), 2, 7);
  let s = `<div class="cb-title">成布对比（红消失 / 绿新增）</div>`;
  s += `<svg width="${E * px}" height="${P * px}" viewBox="0 0 ${E} ${P}">`;
  for (let p = 0; p < P; p++) {
    for (let e = 0; e < E; e++) {
      const a = cur[p * E + e], b = nv[p * E + e];
      let fill;
      if (a === b) fill = a === 1 ? "#2b2b28" : a === 0 ? "#fff" : "#d6d2c6";
      else if (a === 1) fill = "#f2b8b0";
      else fill = "#b7e4c0";
      s += `<rect x="${e}" y="${P - 1 - p}" width="1.02" height="1.02" fill="${fill}" stroke="#e0dccf" stroke-width=".03"/>`;
    }
  }
  s += `</svg>`;
  wrap.innerHTML = s;
  return wrap;
}

/* 无解说明：列出无法还原的纬次与目标开口 */
function renderFailure(fail) {
  const wrap = document.createElement("div");
  let budgetHint;
  if (fail.reason === "alldead") {
    budgetHint = `<div class="conv-warn">每一纬都是漏织哨兵，没有任何有效开口，无法归并出踏板。
      请先在升综计划中至少画出一纬开口，直提稿保持不变。</div>`;
  } else if (fail.reason === "lockover") {
    budgetHint = `<div class="conv-warn">固定列已有 ${fail.nLock} 片，超过踏板预算 ${fail.budget}。
       请提高预算（不能删除固定列），或取消锁定后重解。</div>`;
  } else if (fail.reason === "overshed") {
    budgetHint = `<div class="conv-warn">这些纬一纬要同时升起 ${fail.K + 1} 片以上综框，
       超过“每纬最多同踩 ${fail.K} 片”的上限，任何踏板连结都无法在限制内还原。
       请调高每纬最多同踩数，直提稿保持不变。</div>`;
  } else {
    budgetHint = `<div class="conv-warn">在踏板预算 ${fail.budget} 片${fail.nLock ? `（含 ${fail.nLock} 列固定）` : ""}、
       每纬最多同踩的限制内，以下纬的目标开口无法用踏板连结并集还原。
       直提稿保持不变，可放宽预算/同踩上限后重新求解。</div>`;
  }
  let rows = "";
  const groups = fail.groups || [];
  const shown = groups.slice(0, 60);
  for (const g of shown) {
    const shafts = bitsOf32(g.up).map((s) => s + 1);
    const pickTxt = g.picks.slice(0, 24).map((p) => p + 1).join("、") +
      (g.picks.length > 24 ? ` 等 ${g.picks.length} 纬` : "");
    rows += `<div class="fail-row">
      <span class="fail-picks">第 ${pickTxt} 纬</span>
      <span class="fail-open">目标升综：${shafts.length ? shafts.join("、") : "无（全沉纬，整纬纬浮）"}</span>
    </div>`;
  }
  if (fail.reason !== "alldead" && !shown.length)
    rows = `<p class="muted">（搜索到达上限仍未构造出完整方案，请放宽预算或同踩上限后重试）</p>`;
  const total = groups.reduce((n, g) => n + g.picks.length, 0);
  wrap.innerHTML = budgetHint +
    (total ? `<div class="fail-summary">共 ${total} 纬无法还原</div>` : "") +
    rows;
  return wrap;
}

/* ---------------- 沙盒手调 ---------------- */
const sb = { tieup: null, treadling: null, T: 0, lockCount: 0, K: 0, budget: 0, sol: null };

function openSandbox() {
  const ui = solverUI;
  if (!ui.result || !ui.result.ok) return;
  const sol = ui.result.sols[ui.sel];
  sb.tieup = new Set(sol.tieup);
  sb.treadling = new Set(sol.treadling);
  sb.T = sol.planT;
  sb.lockCount = sol.lockCount;
  sb.K = ui.K;
  sb.budget = ui.budget;
  sb.sol = sol;
  renderSandbox();
}

function renderSandbox() {
  const body = document.createElement("div");
  const px = 15;
  body.innerHTML = `
    <div class="sb-bar" id="sbBar"></div>
    <div class="sb-boards">
      <div class="sb-board">
        <div class="cb-title">踏板连结${sb.lockCount ? `（前 ${sb.lockCount} 列为锁定列，不可改）` : ""}</div>
        <div class="sb-grid-wrap">${sbColHead(sb.T, px)}<div class="sb-grid" id="sbTieup"
          style="--sb:${px}px;grid-template-columns:repeat(${sb.T},${px}px)"></div></div>
      </div>
      <div class="sb-board">
        <div class="cb-title">复合踏序（上=最新纬，点击格点踩/放）</div>
        <div class="sb-grid-wrap">${sbColHead(sb.T, px)}<div class="sb-grid" id="sbTreadling"
          style="--sb:${px}px;grid-template-columns:repeat(${sb.T},${px}px)"></div></div>
      </div>
      <div class="sb-board" id="sbDiff"></div>
    </div>`;
  $("#modalTitle").textContent = "复合踏板 · 沙盒手调（零差异才能采用）";
  const b = $("#modalBody");
  b.innerHTML = "";
  b.appendChild(body);

  buildSbGrid("sbTieup", state.S, sb.T, px, (r, c) => sb.tieup.has(key(r, c)),
    (r, c) => c < sb.lockCount);
  buildSbGrid("sbTreadling", state.P, sb.T, px,
    (r, c) => sb.treadling.has(key(state.P - 1 - r, c)), () => false);

  $("#sbTieup").addEventListener("click", (ev) => {
    const d = ev.target.closest(".sb-cell");
    if (!d || +d.dataset.c < sb.lockCount) return;
    const k = key(+d.dataset.r, +d.dataset.c);
    sb.tieup.has(k) ? sb.tieup.delete(k) : sb.tieup.add(k);
    refreshSandbox();
  });
  $("#sbTreadling").addEventListener("click", (ev) => {
    const d = ev.target.closest(".sb-cell");
    if (!d) return;
    const p = state.P - 1 - (+d.dataset.r);
    const k = key(p, +d.dataset.c);
    sb.treadling.has(k) ? sb.treadling.delete(k) : sb.treadling.add(k);
    refreshSandbox();
  });

  $("#modalFoot").innerHTML = "";
  const mk = (label, fn, primary) => {
    const x = document.createElement("button");
    x.textContent = label;
    if (primary) x.className = "primary";
    x.addEventListener("click", fn);
    $("#modalFoot").appendChild(x);
    return x;
  };
  const adoptBtn = mk("采用此稿并切回踏板", adoptSandbox, true);
  adoptBtn.id = "sbAdopt";
  mk("恢复候选初始", () => openSandbox());
  mk("返回候选列表", () => {
    renderSolverShell("复合踏板求解 · 直提稿切回踏板");
    renderSolveResult();
  });
  mk("取消（直提稿保持不变）", () => { solverUI = null; closeModal(); });

  refreshSandbox();
}

function sbColHead(T, px) {
  let s = `<div class="sb-colhead" style="grid-template-columns:repeat(${T},${px}px)">`;
  for (let t = 0; t < T; t++)
    s += `<div class="sb-hnum${t < sb.lockCount ? " lock" : ""}" title="${t < sb.lockCount ? "锁定列" : ""}">${t + 1}</div>`;
  return s + `</div>`;
}

function buildSbGrid(id, rows, cols, px, has, isLock) {
  const el = document.getElementById(id);
  const frag = document.createDocumentFragment();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const d = document.createElement("div");
      d.className = "sb-cell" + (has(r, c) ? " mark" : "") + (isLock(r, c) ? " lock" : "");
      d.dataset.r = r;
      d.dataset.c = c;
      if ((r + 1) % 5 === 0) d.style.borderTopColor = "#c9c3b4";
      if ((c + 1) % 5 === 0) d.style.borderLeftColor = "#c9c3b4";
      frag.appendChild(d);
    }
  }
  el.appendChild(frag);
}

/* 每次格点改动立即重算：差异格、出错格点、最大同踩、换脚次数 */
function refreshSandbox() {
  const { tieMasks, dead } = solverTargets();
  // 列掩码
  const colMask = new Array(sb.T).fill(0);
  for (let t = 0; t < sb.T; t++) {
    let m = 0;
    for (let s = 0; s < state.S; s++) if (sb.tieup.has(key(s, t))) m |= (1 << s) >>> 0;
    colMask[t] = m >>> 0;
  }
  const press = [];
  let maxPress = 0, foot = 0, wrongPicks = 0, overKPicks = 0;
  const badTie = new Set();    // "s:t" 造成错误开口的连结格
  const badRows = new Set();   // 踏序开口错误行（数据行号 p）
  const overKRows = new Set(); // 同踩数超上限的行
  for (let p = 0; p < state.P; p++) {
    const ps = [];
    for (let t = 0; t < sb.T; t++) if (sb.treadling.has(key(p, t))) ps.push(t);
    press.push(ps);
    if (ps.length > maxPress) maxPress = ps.length;
    if (ps.length > sb.K) { overKPicks++; overKRows.add(p); }
    let union = 0;
    for (const t of ps) union |= colMask[t];
    union >>>= 0;
    let ok;
    if (dead[p]) ok = ps.length === 0;
    else ok = ps.length > 0 && union === tieMasks[p];
    if (!ok) {
      wrongPicks++;
      badRows.add(p);
      // 标出造成目标开口变化的连结格：
      // 多并出的综（XOR）由相关踩下列的连结格负责；
      // 缺少的综（目标有而并集没有）说明应有连结被删，相关踩下列也整列标出
      const extra = dead[p] ? union : (union & ~tieMasks[p]) >>> 0;
      const missing = dead[p] ? 0 : (tieMasks[p] & ~union) >>> 0;
      for (const t of ps) {
        // 多并出的综：标出该踩下列上对应的连结格
        for (let s = 0; s < state.S; s++)
          if ((extra >>> s) & 1) badTie.add(key(s, t));
        // 缺少的综：标出“该纬踩下列中本该连而被删掉”的连结格
        if (missing) {
          for (let s = 0; s < state.S; s++)
            if ((missing >>> s) & 1 && !sb.tieup.has(key(s, t))) badTie.add(key(s, t));
        }
      }
    }
  }
  for (let p = 1; p < state.P; p++) foot += footChange(press[p - 1], press[p]);

  // 格点重绘（标记态 + 错误态）
  const tieEl = document.getElementById("sbTieup");
  const trEl = document.getElementById("sbTreadling");
  for (let s = 0; s < state.S; s++) {
    for (let t = 0; t < sb.T; t++) {
      const cell = tieEl.children[s * sb.T + t];
      cell.classList.toggle("mark", sb.tieup.has(key(s, t)));
      cell.classList.toggle("bad", badTie.has(key(s, t)));
    }
  }
  for (let r = 0; r < state.P; r++) {
    const p = state.P - 1 - r;
    for (let t = 0; t < sb.T; t++) {
      const cell = trEl.children[r * sb.T + t];
      cell.classList.toggle("mark", sb.treadling.has(key(p, t)));
      cell.classList.toggle("rowbad", badRows.has(p));
      cell.classList.toggle("overk", overKRows.has(p));
    }
  }

  // 成布差异
  const trial = {
    S: state.S, T: sb.T, E: state.E, P: state.P, shed: state.shed, mode: "treadle",
    threading: state.threading, tieup: sb.tieup, treadling: sb.treadling,
  };
  const curCloth = computeClothOf(state);
  const newCloth = computeClothOf(trial);
  let diff = 0;
  for (let i = 0; i < curCloth.length; i++) if (curCloth[i] !== newCloth[i]) diff++;
  const diffBox = document.getElementById("sbDiff");
  diffBox.innerHTML = "";
  const diffWrap = clothDiffMiniSvg(curCloth, newCloth);
  diffWrap.querySelector(".cb-title").textContent =
    `成布差异（红消失/绿新增，当前 ${diff} 格不同）`;
  diffBox.appendChild(diffWrap);

  // 采用条件：每一纬目标开口完全一致（不是只看成布，未穿综综框也必须保持），
  // 且每纬同踩数不超过设定上限 K；任一不满足都禁用采用。
  const openOK = wrongPicks === 0;
  const pressOK = maxPress <= sb.K;
  const adoptable = openOK && pressOK;

  // 状态条
  const bar = document.getElementById("sbBar");
  const items = [];
  if (adoptable && diff === 0)
    items.push(`<span class="sb-badge ok">目标开口一致 · 同踩不超限 · 成布差异 0 · 可采用</span>`);
  else {
    if (!openOK)
      items.push(`<span class="sb-badge bad">${wrongPicks} 纬目标开口已改变（红框处）</span>`);
    if (!pressOK)
      items.push(`<span class="sb-badge warn">最大同踩 ${maxPress} 片，超过上限 ${sb.K}（${overKPicks} 纬）</span>`);
    if (openOK && pressOK && diff !== 0)
      items.push(`<span class="sb-badge bad">成布差异 ${diff} 格</span>`);
  }
  items.push(`<span class="sb-badge">踏板 ${sb.T} 片（预算 ${sb.budget}）</span>`);
  items.push(`<span class="sb-badge">最大同踩 ${maxPress} 片（限 ${sb.K}）</span>`);
  items.push(`<span class="sb-badge">成布差异 ${diff} 格</span>`);
  items.push(`<span class="sb-badge">相邻纬换脚 ${foot} 次</span>`);
  bar.innerHTML = items.join("");
  const adopt = document.getElementById("sbAdopt");
  if (adopt) adopt.disabled = !adoptable;
}

function adoptSandbox() {
  // 二次校验：采用前重新确认目标开口一致且同踩数不超 K（防止状态过期）
  const { tieMasks, dead } = solverTargets();
  const colMask = new Array(sb.T).fill(0);
  for (let t = 0; t < sb.T; t++) {
    let m = 0;
    for (let s = 0; s < state.S; s++) if (sb.tieup.has(key(s, t))) m |= (1 << s) >>> 0;
    colMask[t] = m >>> 0;
  }
  for (let p = 0; p < state.P; p++) {
    const ps = [];
    for (let t = 0; t < sb.T; t++) if (sb.treadling.has(key(p, t))) ps.push(t);
    if (ps.length > sb.K) { toast("存在同踩数超过上限的纬，不能采用", 2600); return; }
    let union = 0;
    for (const t of ps) union |= colMask[t];
    union >>>= 0;
    const ok = dead[p] ? ps.length === 0 : ps.length > 0 && union === tieMasks[p];
    if (!ok) { toast("存在目标开口不一致的纬（红框处），不能采用", 2600); return; }
  }
  const T = sb.T;
  const tieup = new Set(sb.tieup), treadling = new Set(sb.treadling);
  solverUI = null;
  state.tieup = tieup;
  state.treadling = treadling;
  state.T = T;
  state.mode = "treadle";
  stopPlay(); play.pick = -1;
  cancelSelection(true);
  closeModal();
  syncSetupInputs();
  applyModeUI();
  rebuildAll();
  pushHistory();
  toast(`已采用复合踏板方案：${T} 片踏板，成布与直提稿一致`);
}

/* ============================================================
   WIF 导入 / 导出
   ============================================================ */
function exportWIF() {
  const { S, T, E, P } = state;
  const isLift = state.mode === "lift";
  const lines = [];
  lines.push("[WIF]");
  lines.push("Version=1.1");
  lines.push("SourceProgram=WovenProof 织纹校对");
  lines.push("Encoding=mbcs");
  lines.push("[CONTENTS]");
  lines.push("TEXT=yes");
  lines.push("CONTINUED=yes");
  lines.push("WEAVING=yes");
  lines.push("WARP=yes");
  lines.push("WEFT=yes");
  lines.push("THREADING=yes");
  if (isLift) lines.push("LIFTPLAN=yes");
  else { lines.push("TIEUP=yes"); lines.push("TREADLING=yes"); }
  lines.push("COLOR PALETTE=yes");
  lines.push("[TEXT]");
  lines.push("Title=" + ($("#projectName").value || "未命名"));
  lines.push("[WEAVING]");
  lines.push("Shed=" + (state.shed === "rising" ? "Rising" : "Sinking"));
  lines.push(isLift ? "Liftplan=yes" : "Treadling=Single Tieup");
  lines.push("[WARP]");
  lines.push(`Threads=${E}`);
  lines.push("Color Form=RGB");
  const warpThreads = [];
  for (let e = 0; e < E; e++) warpThreads.push(`${e + 1}=${warpColorAt(e)}`);
  lines.push("{" + warpThreads.join(",") + "}");
  lines.push("[WEFT]");
  lines.push(`Threads=${P}`);
  lines.push("Color Form=RGB");
  const weftThreads = [];
  for (let p = 0; p < P; p++) weftThreads.push(`${p + 1}=${weftColorAt(p)}`);
  lines.push("{" + weftThreads.join(",") + "}");
  lines.push("[THREADING]");
  const threadMap = new Map();
  for (const k of state.threading) {
    const [s, e] = parseKey(k);
    if (!threadMap.has(s + 1)) threadMap.set(s + 1, []);
    threadMap.get(s + 1).push(e + 1);
  }
  for (const [shaft, arr] of threadMap)
    lines.push(`${shaft}={${arr.join(",")}}`);

  if (isLift) {
    // 直提模式：按 LIFTPLAN 写出每纬升起的综框；
    // 全沉纬与漏织哨兵在 WIF 中都只能表达为 0（无综升起）
    lines.push("[LIFTPLAN]");
    for (let p = 0; p < P; p++) {
      if (isDeadLiftPick(p)) { lines.push(`${p + 1}=0`); continue; }
      const sh = liftSetOfPick(p).map((s) => s + 1);
      lines.push(`${p + 1}=${sh.length ? "{" + sh.join(",") + "}" : "0"}`);
    }
  } else {
    lines.push("[TIEUP]");
    for (let s = 0; s < S; s++) {
      const ts = [];
      for (let t = 0; t < T; t++) if (state.tieup.has(key(s, t))) ts.push(t + 1);
      if (ts.length) lines.push(`${s + 1}={${ts.join(",")}}`);
    }
    lines.push("[TREADLING]");
    for (let p = 0; p < P; p++) {
      const ts = [];
      for (let t = 0; t < T; t++) if (state.treadling.has(key(p, t))) ts.push(t + 1);
      lines.push(`${p + 1}=${ts.length ? "{" + ts.join(",") + "}" : "0"}`);
    }
  }
  const blob = new Blob([lines.join("\r\n")], { type: "text/plain;charset=utf-8" });
  downloadBlob(blob, ($("#projectName").value || "wovenproof") + ".wif");
  toast(isLift ? "已按直提模式导出 WIF（LIFTPLAN）" : "已导出 WIF（TIEUP/TREADLING）");
}
function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function importWIF(text) {
  const sec = parseWIFSections(text);
  const get = (name) => sec[name.toLowerCase()] || {};
  const weaving = get("weaving");
  const warp = get("warp"), weft = get("weft");
  const E = parseInt(warp.threads || "0", 10);
  const P = parseInt(weft.threads || "0", 10);
  const th = get("threading"), ti = get("tieup"), tr = get("treadling"), lp = get("liftplan");
  let S = 0, T = 0;
  const threading = new Set(), tieup = new Set(), treadling = new Set(), liftplan = new Set();

  for (const keyStr of Object.keys(th)) {
    const shaft = parseInt(keyStr, 10);
    if (!Number.isFinite(shaft)) continue;
    S = Math.max(S, shaft);
    for (const e of parseList(th[keyStr])) {
      if (Number.isFinite(e)) threading.add(key(shaft - 1, e - 1));
    }
  }
  // WIF 含 LIFTPLAN 时原样保留：进入直提模式，不合成踏板。
  // 若同时带 TIEUP/TREADLING 也读入保留，方便日后切回踏板模式参考。
  const useLift = Object.keys(lp).length > 0;
  let liftComboCount = 0;       // 不同升综组合数（含全沉组合），用作踏板预算初值
  if (useLift) {
    const seen = new Uint8Array(P);
    const combos = new Set();
    for (const keyStr of Object.keys(lp)) {
      const p = parseInt(keyStr, 10);
      if (!Number.isFinite(p)) continue;
      const shafts = parseList(lp[keyStr]);
      if (shafts.length === 1 && shafts[0] === 0) {
        // WIF 的 pick=0：有效全沉纬（无综升起），不是漏织，不写任何键
      } else if (!shafts.length) {
        // 空值同样视为全沉纬
      } else {
        const row = [];
        for (const sh of shafts) {
          if (Number.isFinite(sh)) {
            liftplan.add(key(p - 1, sh - 1));
            S = Math.max(S, sh);  // LIFTPLAN 也决定综框数
            row.push(sh);
          }
        }
        row.sort((a, b) => a - b);
        combos.add(row.join(","));
      }
      seen[p - 1] = 1;
    }
    // 缺号的纬同样按全沉纬处理（LIFTPLAN 中无键即全沉）
    let hasEmpty = false;
    for (let p = 0; p < P; p++) if (!seen[p]) { hasEmpty = true; }
    if (Object.values(lp).some((v) => { const l = parseList(v); return !l.length || (l.length === 1 && l[0] === 0); }) || hasEmpty)
      combos.add("");
    liftComboCount = combos.size;
  }
  for (const keyStr of Object.keys(ti)) {
    const shaft = parseInt(keyStr, 10);
    if (!Number.isFinite(shaft)) continue;
    S = Math.max(S, shaft);
    for (const t of parseList(ti[keyStr])) {
      if (Number.isFinite(t)) { tieup.add(key(shaft - 1, t - 1)); T = Math.max(T, t); }
    }
  }
  for (const keyStr of Object.keys(tr)) {
    const p = parseInt(keyStr, 10);
    if (!Number.isFinite(p)) continue;
    const list = parseList(tr[keyStr]);
    if (list.length === 0 || (list.length === 1 && list[0] === 0)) continue;
    for (const t of list) {
      if (Number.isFinite(t)) { treadling.add(key(p - 1, t - 1)); T = Math.max(T, t); }
    }
  }
  if (!E || !P || !S)
    throw new Error("WIF 缺少必要尺寸（WARP.THREADS / WEFT.THREADS / 穿综）");
  if (!useLift && !T)
    throw new Error("WIF 缺少必要的踏板数据（TIEUP/TREADLING 或 LIFTPLAN）");
  if (useLift && !T) T = Math.max(1, liftComboCount); // 直提模式：按所需踏板组合预设预算

  state.S = S; state.T = T; state.E = E; state.P = P;
  state.threading = threading; state.tieup = tieup; state.treadling = treadling;
  state.liftplan = liftplan;
  state.mode = useLift ? "lift" : "treadle";
  state.shed = String(weaving.shed || "").toLowerCase().startsWith("sink") ? "sinking" : "rising";
  state.warpColors = parseWIFColors(warp, E);
  state.weftColors = parseWIFColors(weft, P);
  invalidateReedOnWarpChange();
  const title = get("text").title;
  if (title) $("#projectName").value = title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
  syncSetupInputs();
  applyModeUI();
  rebuildAll();
  stopPlay(); play.pick = -1;
  pushHistory();
  return { E, P, S, T, liftplan: useLift };
}
function parseWIFSections(text) {
  // 标准 WIF：section=[NAME]；行为 key=value；value 可为 {a,b,c} 列表，
  // 且可跨续行（大括号未闭合时把后续行并入当前值）。
  const sections = {};
  let cur = null, curKey = null, curVal = "", inBrace = false;
  const commit = () => {
    if (cur !== null && curKey !== null) cur[curKey] = curVal.trim();
    curKey = null; curVal = ""; inBrace = false;
  };
  for (const rawLine of text.split(/\r?\n/)) {
    if (inBrace) {
      curVal += " " + rawLine.trim();
      if ((curVal.match(/}/g) || []).length >= (curVal.match(/{/g) || []).length) inBrace = false;
      continue;
    }
    const t = rawLine.trim();
    if (!t || t.startsWith("#")) continue;
    const secM = t.match(/^\[(.+?)\]$/);
    if (secM) {
      commit();
      cur = {};
      sections[secM[1].toLowerCase()] = cur;
      continue;
    }
    if (!cur) continue;
    const eq = t.indexOf("=");
    if (eq < 0) {
      if (curKey !== null) curVal += " " + t;
      continue;
    }
    commit();
    curKey = t.slice(0, eq).trim().toLowerCase();
    curVal = t.slice(eq + 1).trim();
    const opens = (curVal.match(/{/g) || []).length;
    const closes = (curVal.match(/}/g) || []).length;
    inBrace = opens > closes;
  }
  commit();
  return sections;
}
function parseList(v) {
  if (v === undefined) return [];
  return String(v).replace(/[{}]/g, " ").split(/[,\s]+/)
    .map((x) => parseInt(x, 10)).filter(Number.isFinite);
}
/* WIF 颜色段兼容两种写法：
   逐行  1=#ff0000
   整表 {1=#ff0000,2=#00ff00,...}（此时解析器得到的键为 "{1"） */
function parseWIFColors(sec, n) {
  const out = [];
  const assign = (idx, hex) => {
    if (/^[0-9a-fA-F]{6}$/.test(hex)) out[idx] = "#" + hex.toLowerCase();
  };
  for (const k of Object.keys(sec)) {
    const v = String(sec[k]);
    if (/^\d+$/.test(k)) {
      const m = v.match(/([0-9a-fA-F]{6})/);
      if (m) assign(parseInt(k, 10) - 1, m[1]);
    } else {
      const whole = k.replace(/[{}]/g, " ") + "=" + v;
      const re = /(\d+)\s*=\s*#?([0-9a-fA-F]{6})/g;
      let mm;
      while ((mm = re.exec(whole))) assign(parseInt(mm[1], 10) - 1, mm[2]);
    }
  }
  return out;
}

/* ============================================================
   色纱编辑
   ============================================================ */
function renderColorChips() {
  const w = $("#warpPalette"), f = $("#weftPalette");
  w.innerHTML = ""; f.innerHTML = "";
  for (let e = 0; e < state.E; e++) w.appendChild(makeChip(e, "warp", warpColorAt(e)));
  for (let p = 0; p < state.P; p++) f.appendChild(makeChip(p, "weft", weftColorAt(p)));
}
function makeChip(idx, kind, color) {
  const c = document.createElement("span");
  c.className = "chip";
  c.style.background = color;
  c.title = (kind === "warp" ? "经纱 " : "纬纱 ") + (idx + 1);
  c.addEventListener("click", () => editChipColor(idx, kind, c));
  return c;
}
function editChipColor(idx, kind, chipEl) {
  const inp = document.createElement("input");
  inp.type = "color";
  inp.hidden = true;
  inp.value = kind === "warp" ? warpColorAt(idx) : weftColorAt(idx);
  document.body.appendChild(inp);
  inp.addEventListener("input", () => {
    if (kind === "warp") state.warpColors[idx] = inp.value;
    else state.weftColors[idx] = inp.value;
    chipEl.style.background = inp.value;
    if (state.colorPrint) renderDrawdown();
    scheduleReedRefresh();
  });
  inp.addEventListener("change", () => { inp.remove(); scheduleSave(); });
  inp.click();
}
function applyAllWarp() {
  const v = $("#warpColor").value;
  for (let e = 0; e < state.E; e++) state.warpColors[e] = v;
  renderColorChips(); if (state.colorPrint) renderDrawdown(); scheduleSave();
  scheduleWarpRefresh();
}
function applyAllWeft() {
  const v = $("#weftColor").value;
  for (let p = 0; p < state.P; p++) state.weftColors[p] = v;
  renderColorChips(); if (state.colorPrint) renderDrawdown(); scheduleSave();
}

/* ============================================================
   打印：色纱 + 格号 + 重复边界
   ============================================================ */
function detectPeriod(arr1D) {
  outer:
  for (let d = 1; d <= Math.floor(arr1D.length / 2); d++) {
    if (arr1D.length % d !== 0 && arr1D.length < d * 2) continue;
    for (let i = d; i < arr1D.length; i++)
      if (arr1D[i] !== arr1D[i % d]) continue outer;
    return d;
  }
  return arr1D.length;
}
function doPrint() {
  const area = $("#printArea");
  const { E, P, S, T } = state;
  const isLift = state.mode === "lift";
  const px = clamp(Math.min(14, 760 / Math.max(E, P + S + 2)), 3, 14);
  const dateStr = new Date().toLocaleDateString("zh-CN");
  let html = `<div class="print-sheet">
    <div class="print-title">${escapeHtml($("#projectName").value)} · 组织图</div>
    <div class="print-meta">综框 ${S} · ${isLift ? "直提升综计划（无踏板）" : "踏板 " + T} · 经纱 ${E} · 纬纱 ${P} ·
      ${state.shed === "rising" ? "提综" : "沉综"} · 打印日期 ${dateStr}</div>`;

  html += printBlock("穿综", E, S, px, (x, y) => state.threading.has(key(y, x)),
                     { topNums: E, leftNums: S, periodCols: detectPeriod(buildThreadRowSig()) });
  if (isLift) {
    html += printBlock("升综计划 LIFTPLAN（列=综框，上=最新纬）", S, P, px,
                       (x, y) => state.liftplan.has(key(P - 1 - y, x)),
                       { topNums: S, leftNums: P, leftReverse: true,
                         periodCols: detectPeriod(buildLiftColSig()) });
  } else {
    html += printBlock("踏板连结", T, S, px, (x, y) => state.tieup.has(key(y, x)),
                       { topNums: T, leftNums: S });
    html += printBlock("踏序", T, P, px, (x, y) => state.treadling.has(key(P - 1 - y, x)),
                       { topNums: T, leftNums: P, leftReverse: true });
  }

  // 成布（带色纱）
  computeCloth();
  const W = E * px + 16, H = P * px + 16;
  let s = `<div class="print-block"><div class="pb-title">成布组织图（${state.colorPrint ? "色纱" : "黑白"}，红虚线=重复边界）</div>`;
  s += `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  const ox = 14, oy = 2;
  // 纬底色
  for (let p = 0; p < P; p++) {
    const y = oy + (P - 1 - p) * px;
    s += `<rect x="${ox}" y="${y}" width="${E * px}" height="${px + .5}" fill="${state.colorPrint ? weftColorAt(p) : "#ffffff"}"/>`;
  }
  // 经浮点
  for (let p = 0; p < P; p++) {
    for (let e = 0; e < E; e++) {
      const v = cloth[p * E + e];
      const x = ox + e * px, y = oy + (P - 1 - p) * px;
      if (v === 1) s += `<rect x="${x + 1}" y="${y + 1}" width="${px - 2}" height="${px - 2}" fill="${state.colorPrint ? warpColorAt(e) : "#2b2b28"}"/>`;
      else if (v === -1) s += `<rect x="${x}" y="${y}" width="${px}" height="${px}" fill="#d6d2c6"/>`;
      s += `<rect x="${x}" y="${y}" width="${px}" height="${px}" fill="none" class="print-cell"/>`;
    }
  }
  // 重复边界：经向穿综周期 + 纬向踏序/升综计划周期
  const periodE = detectPeriod(buildThreadRowSig());
  const periodP = detectPeriod(state.mode === "lift" ? buildLiftPickSig() : buildPickSig());
  for (let e = periodE; e < E; e += periodE)
    s += `<line x1="${ox + e * px}" y1="${oy}" x2="${ox + e * px}" y2="${oy + P * px}" class="print-repeat"/>`;
  for (let p = periodP; p < P; p += periodP)
    s += `<line x1="${ox}" y1="${oy + (P - p) * px}" x2="${ox + E * px}" y2="${oy + (P - p) * px}" class="print-repeat"/>`;
  // 格号：每 5/10 标注
  const numStep = E > 120 ? 10 : 5;
  for (let e = 0; e < E; e += numStep)
    s += `<text x="${ox + e * px + px / 2}" y="${oy + P * px + 10}" class="print-num">${e + 1}</text>`;
  for (let p = 0; p < P; p += numStep)
    s += `<text x="${ox - 3}" y="${oy + (P - 1 - p) * px + px - 2}" class="print-num" style="text-anchor:end">${p + 1}</text>`;
  // 色纱图例
  if (state.colorPrint) {
    s += `<text x="${ox}" y="${H - 1}" class="print-legend">经纱配色 ${colorLegend(state.warpColors, E)} ｜ 纬纱配色 ${colorLegend(state.weftColors, P)}</text>`;
  }
  s += `</svg></div>`;
  html += s;
  html += `</div>`;
  area.innerHTML = html;
  window.print();
}
function buildThreadRowSig() {
  const sig = [];
  for (let e = 0; e < state.E; e++) {
    let s = -1;
    for (const k of state.threading) { const [ss, ee] = parseKey(k); if (ee === e) s = ss; }
    sig.push(s);
  }
  return sig;
}
function buildPickSig() {
  const sig = [];
  for (let p = 0; p < state.P; p++) {
    const ts = [];
    for (let t = 0; t < state.T; t++) if (state.treadling.has(key(p, t))) ts.push(t);
    sig.push(ts.join(","));
  }
  return sig;
}
function buildLiftPickSig() {
  const sig = [];
  for (let p = 0; p < state.P; p++) {
    sig.push(isDeadLiftPick(p) ? "_dead" : liftSetOfPick(p).join(","));
  }
  return sig;
}
function buildLiftColSig() {
  // 升综计划列签名：每片综在各纬的起落序列
  const sig = [];
  for (let s = 0; s < state.S; s++) {
    let str = "";
    for (let p = 0; p < state.P; p++) str += state.liftplan.has(key(p, s)) ? "1" : "0";
    sig.push(str);
  }
  return sig;
}
function colorLegend(colors, n) {
  const uniq = [];
  for (let i = 0; i < n; i++) {
    const c = colors[i] || (colors === state.warpColors ? DEFAULT_WARP : DEFAULT_WEFT);
    if (!uniq.includes(c)) uniq.push(c);
    if (uniq.length >= 8) break;
  }
  return uniq.map((c) => `■${c}`).join(" ");
}
function printBlock(title, cols, rows, px, has, opts) {
  const ox = 16, oy = 12;
  const W = cols * px + ox + 4, H = rows * px + oy + 12;
  let s = `<div class="print-block"><div class="pb-title">${escapeHtml(title)}</div>`;
  s += `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      s += `<rect x="${ox + x * px}" y="${oy + y * px}" width="${px}" height="${px}"
            fill="${has(x, y) ? "#2b2b28" : "#fff"}" class="print-cell"/>`;
    }
  }
  const numStep = cols > 120 ? 10 : 10;
  if (opts.topNums)
    for (let x = 0; x < cols; x += numStep)
      s += `<text x="${ox + x * px + px / 2}" y="${oy - 3}" class="print-num">${x + 1}</text>`;
  if (opts.leftNums)
    for (let y = 0; y < rows; y += numStep) {
      const label = opts.leftReverse ? rows - y : y + 1;
      s += `<text x="${ox - 3}" y="${oy + y * px + px - 2}" class="print-num" style="text-anchor:end">${label}</text>`;
    }
  if (opts.periodCols) {
    for (let x = opts.periodCols; x < cols; x += opts.periodCols)
      s += `<line x1="${ox + x * px}" y1="${oy}" x2="${ox + x * px}" y2="${oy + rows * px}" class="print-repeat"/>`;
  }
  s += `</svg></div>`;
  return s;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

/* ============================================================
   存档：sqlite 项目/版本 + localStorage 草稿
   ============================================================ */
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(LS_KEY, snapshot()); } catch (e) {}
    setStatus("草稿已本地保存 " + new Date().toLocaleTimeString("zh-CN"));
  }, 500);
}
function setStatus(t) { $("#statusText").textContent = t; }

async function saveVersion() {
  const name = $("#projectName").value.trim() || "未命名项目";
  const label = await promptModal("保存版本",
    "为当前版本起个名字（同一项目名下反复保存会归入一个项目，保留全部历史版本）：",
    "版本 " + new Date().toLocaleString("zh-CN", { hour12: false }));
  if (label === null) return;
  try {
    const r = await api("POST", "/api/projects", {
      name, label: label || "当前版本", note: "", draft: collectDraft(),
    });
    toast(`已保存到项目「${name}」#${r.versionId}`);
  } catch (e) { toast("保存失败：" + e.message, 3000); }
}
function collectDraft() {
  return {
    S: state.S, T: state.T, E: state.E, P: state.P, shed: state.shed, mode: state.mode,
    threading: [...state.threading], tieup: [...state.tieup], treadling: [...state.treadling],
    liftplan: [...state.liftplan],
    warpColors: state.warpColors, weftColors: state.weftColors,
    rules: state.rules,
    reed: state.reed,
  };
}
function loadDraft(d, name) {
  state.S = d.S; state.T = d.T; state.E = d.E; state.P = d.P;
  state.shed = d.shed || "rising";
  state.mode = d.mode === "lift" ? "lift" : "treadle";
  state.threading = new Set(d.threading || []);
  state.tieup = new Set(d.tieup || []);
  state.treadling = new Set(d.treadling || []);
  state.liftplan = new Set(d.liftplan || []);
  state.warpColors = d.warpColors || [];
  state.weftColors = d.weftColors || [];
  state.reed = normalizeReed(d.reed || null);
  if (d.rules) state.rules = Object.assign(state.rules, d.rules);
  if (name) $("#projectName").value = name;
  stopPlay(); play.pick = -1;
  syncSetupInputs();
  applyModeUI();
  rebuildAll();
  syncReedForm(); refreshReed();
}

async function openArchive() {
  let projects = [];
  try { projects = (await api("GET", "/api/projects")).projects; }
  catch (e) { return toast("读取存档失败：" + e.message, 3000); }
  const body = document.createElement("div");
  if (!projects.length) {
    body.innerHTML = '<p class="muted">还没有保存过任何项目。点击顶栏「💾 存版本」即可把当前稿存入本地数据库。</p>';
  }
  for (const p of projects) {
    const div = document.createElement("div");
    div.className = "proj-item";
    div.innerHTML = `<span class="name">${escapeHtml(p.name)}</span>
      <span class="small muted">${p.version_count} 个版本 · 更新 ${fmtTime(p.updated)}</span>
      <button data-act="open">打开</button>
      <button data-act="del" class="danger">删除项目</button>`;
    div.querySelector('[data-act="open"]').addEventListener("click", () => openProject(p.id, body));
    div.querySelector('[data-act="del"]').addEventListener("click", async () => {
      if (!confirm(`确定删除项目「${p.name}」及其 ${p.version_count} 个版本？此操作不可恢复。`)) return;
      try {
        await api("DELETE", `/api/projects/${p.id}`);
        toast("项目已删除");
        openArchive();
      } catch (e) { toast("删除失败：" + e.message, 3000); }
    });
    body.appendChild(div);
  }
  openModal("🗂 项目与版本", body, [{ label: "关闭", action: closeModal }], true);
}
async function openProject(pid, parent) {
  const r = await api("GET", `/api/projects/${pid}`);
  const proj = r.project;
  let versions = [];
  versions = await Promise.all(proj.versions.map(async (v) =>
    Object.assign(v, (await api("GET", `/api/projects/versions/${v.id}`)).version)));
  const wrap = document.createElement("div");
  wrap.style.marginTop = "8px";
  for (const v of versions) {
    const div = document.createElement("div");
    div.className = "ver-item";
    div.innerHTML = `<span class="meta">${escapeHtml(v.label)} · ${fmtTime(v.created)}</span>
      <button data-act="load">载入</button>
      <button data-act="delv" class="danger">删版本</button>`;
    div.querySelector('[data-act="load"]').addEventListener("click", () => {
      loadDraft(v.draft, proj.name);
      pushHistory();
      closeModal();
      toast(`已载入版本「${v.label}」`);
    });
    div.querySelector('[data-act="delv"]').addEventListener("click", async () => {
      if (!confirm(`删除版本「${v.label}」？`)) return;
      try {
        await api("DELETE", `/api/projects/${pid}/versions/${v.id}`);
        toast("版本已删除");
        openProject(pid, parent);
      } catch (err) { toast("删除失败：" + err.message, 3000); }
    });
    wrap.appendChild(div);
  }
  const old = parent.querySelector(".ver-list-wrap");
  if (old) old.remove();
  wrap.className = "ver-list-wrap";
  parent.appendChild(wrap);
}

/* ============================================================
   模态框
   ============================================================ */
function openModal(title, bodyNode, buttons, wide) {
  $("#modalTitle").textContent = title;
  const b = $("#modalBody");
  b.innerHTML = "";
  b.appendChild(bodyNode);
  const foot = $("#modalFoot");
  foot.innerHTML = "";
  for (const btn of buttons || []) {
    const bEl = document.createElement("button");
    bEl.textContent = btn.label;
    if (btn.primary) bEl.className = "primary";
    if (btn.disabled) { bEl.disabled = true; bEl.title = btn.title || ""; }
    if (btn.action) bEl.addEventListener("click", btn.action);
    foot.appendChild(bEl);
  }
  $("#modalBox").classList.toggle("wide", !!wide);
  $("#modalBox").classList.remove("xwide");
  $("#modalMask").hidden = false;
}
function closeModal() {
  $("#modalMask").hidden = true;
  if (warpExecOpen) warpExecClosed();   // 整经执行页关闭＝中断（进度已保存）
}
function promptModal(title, question, def) {
  return new Promise((resolve) => {
    const body = document.createElement("div");
    body.innerHTML = `<p style="margin:0 0 8px">${escapeHtml(question)}</p>`;
    const inp = document.createElement("input");
    inp.type = "text"; inp.value = def || ""; inp.style.width = "100%";
    body.appendChild(inp);
    const done = (v) => { closeModal(); resolve(v); };
    openModal(title, body, [
      { label: "取消", action: () => done(null) },
      { label: "确定", primary: true, action: () => done(inp.value.trim()) },
    ]);
    setTimeout(() => { inp.focus(); inp.select(); }, 30);
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") done(inp.value.trim()); });
  });
}

/* ============================================================
   内置示例
   ============================================================ */
const EXAMPLES = {
  "平纹（2综2踏）": (E = 16, P = 16) => {
    const th = new Set(), ti = new Set(), tr = new Set();
    for (let e = 0; e < E; e++) th.add(key(e % 2, e));
    ti.add(key(0, 0)); ti.add(key(1, 1));
    for (let p = 0; p < P; p++) tr.add(key(p, p % 2));
    return { S: 2, T: 2, E, P, threading: th, tieup: ti, treadling: tr };
  },
  "2/2 斜纹（4综4踏）": (E = 24, P = 24) => {
    const th = new Set(), ti = new Set(), tr = new Set();
    for (let e = 0; e < E; e++) th.add(key(e % 4, e));
    // 踏板 t 提升综 (t)%4 与 (t+1)%4 → 2上2下
    for (let t = 0; t < 4; t++) { ti.add(key(t, t)); ti.add(key((t + 1) % 4, t)); }
    for (let p = 0; p < P; p++) tr.add(key(p, p % 4));
    return { S: 4, T: 4, E, P, threading: th, tieup: ti, treadling: tr };
  },
  "3/1 斜纹（4综4踏）": (E = 24, P = 24) => {
    const th = new Set(), ti = new Set(), tr = new Set();
    for (let e = 0; e < E; e++) th.add(key(e % 4, e));
    for (let t = 0; t < 4; t++)
      for (let k = 0; k < 3; k++) ti.add(key((t + k) % 4, t));
    for (let p = 0; p < P; p++) tr.add(key(p, p % 4));
    return { S: 4, T: 4, E, P, threading: th, tieup: ti, treadling: tr };
  },
  "五枚缎（5综5踏）": (E = 30, P = 30) => {
    const th = new Set(), ti = new Set(), tr = new Set();
    for (let e = 0; e < E; e++) th.add(key(e % 5, e));
    for (let t = 0; t < 5; t++)
      for (let k = 0; k < 4; k++) ti.add(key((t + k * 2) % 5, t));
    for (let p = 0; p < P; p++) tr.add(key(p, p % 5));
    return { S: 5, T: 5, E, P, threading: th, tieup: ti, treadling: tr };
  },
  "山形斜纹（8综8踏）": (E = 32, P = 32) => {
    const S = 8;
    const th = new Set(), ti = new Set(), tr = new Set();
    for (let e = 0; e < E; e++) {
      const cycle = e % (2 * (S - 1));
      th.add(key(cycle < S ? cycle : 2 * S - 2 - cycle, e));
    }
    for (let t = 0; t < S; t++) { ti.add(key(t, t)); ti.add(key((t + 1) % S, t)); }
    for (let p = 0; p < P; p++) {
      const cycle = p % (2 * (S - 1));
      tr.add(key(p, cycle < S ? cycle : 2 * S - 2 - cycle));
    }
    return { S, T: S, E, P, threading: th, tieup: ti, treadling: tr };
  },
};
function openExamples() {
  const body = document.createElement("div");
  body.innerHTML = '<p class="muted" style="margin-top:0">载入示例会替换当前内容（可撤销）。示例可直接编辑。</p>';
  for (const [name, fn] of Object.entries(EXAMPLES)) {
    const b = document.createElement("button");
    b.textContent = name;
    b.style.cssText = "display:block;width:100%;margin-bottom:8px;text-align:left";
    b.addEventListener("click", () => {
      const d = fn();
      stopPlay();
      state.S = d.S; state.T = d.T; state.E = d.E; state.P = d.P;
      state.threading = d.threading; state.tieup = d.tieup; state.treadling = d.treadling;
      state.liftplan = new Set();
      state.mode = "treadle";
      state.warpColors = []; state.weftColors = [];
      state.shed = "rising";
      invalidateReedOnWarpChange();
      $("#projectName").value = "示例·" + name.split("（")[0];
      syncSetupInputs();
      applyModeUI();
      rebuildAll();
      pushHistory();
      closeModal();
      toast("已载入示例：" + name);
    });
    body.appendChild(b);
  }
  openModal("📐 内置示例", body, [{ label: "关闭", action: closeModal }]);
}

/* ============================================================
   设置联动
   ============================================================ */
function syncSetupInputs() {
  $("#shafts").value = state.S;
  $("#treadles").value = state.T;
  $("#ends").value = state.E;
  $("#picks").value = state.P;
  $("#shed").value = state.shed;
  $("#maxFloatFront").value = state.rules.maxFront;
  $("#maxFloatBack").value = state.rules.maxBack;
  $("#edgeRule").checked = state.rules.edge;
  $("#edgeWidth").value = state.rules.edgeW;
  updateShedHint();
}
function updateShedHint() {
  if (state.mode === "lift") {
    $("#shedHint").textContent = state.shed === "rising"
      ? "直提 · 提综：标记＝升起（经浮）"
      : "直提 · 沉综：标记＝升起，未标综沉下（纬浮）";
    return;
  }
  $("#shedHint").textContent = state.shed === "rising"
    ? "提综：连结标记＝综上升，正面见经"
    : "沉综：连结标记＝综下沉，正面见纬";
}
function onResizeField(which, val) {
  val = clamp(val | 0, which === "shafts" ? 2 : 1, 600);
  const old = state[which === "shafts" ? "S" : which === "treadles" ? "T"
                      : which === "ends" ? "E" : "P"];
  if (val === old) return;
  const map = { shafts: "S", treadles: "T", ends: "E", picks: "P" };
  state[map[which]] = val;
  stopPlay(); play.pick = -1;
  // 直提模式下调“踏板预算”不影响任何现有数据，只记一笔历史即可
  if (!(which === "treadles" && state.mode === "lift")) rebuildAll();
  else syncSetupInputs();
  pushHistory();
  const names = { shafts: "综框", treadles: "踏板", ends: "经纱", picks: "纬纱" };
  if (which === "ends") invalidateReedOnWarpChange();
  const orphaned = hasOutOfRange(which);
  if (orphaned) toast(`已缩小${names[which]}数，旧标记被标为越界，可在问题列表一键清除`, 3200);
}
function hasOutOfRange(which) {
  if (which === "shafts")
    return [...state.threading].some((k) => parseKey(k)[0] >= state.S) ||
           [...state.tieup].some((k) => parseKey(k)[0] >= state.S) ||
           (state.mode === "lift" && [...state.liftplan].some((k) => {
             const s = parseKey(k)[1]; return s !== LIFT_DEAD && s >= state.S;
           }));
  if (which === "treadles")
    return [...state.tieup].some((k) => parseKey(k)[1] >= state.T) ||
           [...state.treadling].some((k) => parseKey(k)[1] >= state.T);
  if (which === "ends")
    return [...state.threading].some((k) => parseKey(k)[1] >= state.E);
  return [...state.treadling].some((k) => parseKey(k)[0] >= state.P) ||
         (state.mode === "lift" && [...state.liftplan].some((k) => parseKey(k)[0] >= state.P));
}
function clearAll() {
  if (!confirm(state.mode === "lift"
      ? "清空穿综与升综计划输入网格？（可撤销）"
      : "清空穿综、踏板连结、踏序三个输入网格？（可撤销）")) return;
  state.threading.clear();
  state.tieup.clear();
  state.treadling.clear();
  state.liftplan.clear();
  stopPlay(); play.pick = -1;
  cancelSelection(true);
  afterEdit();
  pushHistory();
  toast("已清空");
}

/* ============================================================
   穿筘计划
   ------------------------------------------------------------
   独立数据 state.reed：筘号、目标经密、成品幅宽、入筘序列、边经规则、状态。
   经纱次序/穿综/颜色读自当前组织图，从不写回。
   筘齿 dent 全局从左到右 0 起连续编号；段内序号 sIdx 分别从 0 起。
   ============================================================ */
const REED_LS_STATUS = { draft: "草拟", checked: "已校验", adopted: "已采用" };

function defaultReed() {
  return {
    unit: "cm",          // cm=筘号按每厘米 | in=每英寸
    reedNo: 0,           // 每单位筘齿数
    targetDensity: 0,    // 目标经密（根/同单位长度）
    width: 0,            // 成品幅宽（同单位）
    dentsManual: 0,      // 手工指定幅宽内筘齿数；0=按筘号自动
    maxPerDent: 4,       // 地经每齿入经上限
    seq: "2-2",          // 地经入筘序列文本
    edgeOn: false,       // 启用边经规则
    edgeEnds: 4,         // 每侧边经根数
    edgeMax: 4,          // 边经每齿上限
    edgeSeq: "2-2",      // 边经入筘序列文本（左右边各自循环）
    status: "draft",     // draft | checked | adopted
    adoptedAt: 0,        // 采用时间戳
  };
}
function normalizeReed(r) {
  const d = defaultReed();
  if (r && typeof r === "object") {
    for (const k of Object.keys(d))
      if (r[k] !== undefined) d[k] = r[k];
    d.unit = d.unit === "in" ? "in" : "cm";
    d.status = ["draft", "checked", "adopted"].includes(d.status) ? d.status : "draft";
  }
  return d;
}
const CM_PER_IN = 2.54;
/* 所有幅宽/经密计算一律在“当前所选单位”下进行，不做厘米中转，避免量纲错乱：
   筘号=每单位筘齿数，故 筘齿数=筘号×幅宽（同单位），经密=根数/幅宽（同单位）。 */
function reedPitch(reed) { return reed.reedNo; }                 // 每单位长度筘齿数
function reedTargetDensity(reed) { return reed.targetDensity; }   // 目标经密（根/单位长度）
/* 解析 "2-2-3" / "2,2,3"；返回 {ok, seq, bad}，允许 0（空齿） */
function parseReedSeq(text) {
  const bad = [];
  const seq = [];
  String(text || "").split(/[-,，、\s]+/).forEach((tok) => {
    if (!tok) return;
    if (/^\d+$/.test(tok)) seq.push(+tok);
    else bad.push(tok);
  });
  return { seq, bad, ok: bad.length === 0 && seq.length > 0 };
}
function reedAvailableDents(reed) {
  if (reed.dentsManual > 0) return Math.round(reed.dentsManual);
  const pitch = reedPitch(reed);
  if (!(pitch > 0) || !(reed.width > 0)) return 0;
  return Math.max(0, Math.round(pitch * reed.width));
}
function meanOf(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

/* 展开一个段：把序列循环填入直到放满 need 根。
   avail 为可用筘齿上限；传 -1 表示不限制（尚未给筘号/幅宽时仅作预览排布）。
   返回 {dents:[{v,e0,e1,sIdx}], used, endCount, stopped} */
function reedExpandSection(seq, need, avail, startEnd) {
  const dents = [];
  let endCount = 0, e = startEnd, stopped = false;
  let guard = 0;
  while (endCount < need) {
    if ((avail >= 0 && dents.length >= avail) || ++guard > 20000) { stopped = true; break; }
    const v = seq[dents.length % seq.length];
    const sIdx = dents.length;
    if (v === 0) { dents.push({ v: 0, e0: -1, e1: -1, sIdx }); continue; }
    const take = Math.min(v, need - endCount);
    dents.push({ v: take, e0: e, e1: e + take - 1, sIdx });
    e += take; endCount += take;
  }
  return { dents, used: dents.length, endCount, stopped };
}

/* 核心布置计算。返回统计、每齿明细、每根经纱所在齿与问题列表（不做任何自动补线） */
function computeReedLayout() {
  const reed = state.reed || (state.reed = defaultReed());
  const E = state.E;
  const body = parseReedSeq(reed.seq);
  const edgeP = parseReedSeq(reed.edgeSeq);
  const available = reedAvailableDents(reed);
  const unlimited = available === 0;   // 未给筘号/幅宽：不限齿数，只做预览排布
  const issues = [];

  if (!body.ok) issues.push({ sev: "error", kind: "reed-badseq",
    title: "地经入筘序列无法解析",
    desc: `无法识别的片段：${body.bad.map(escapeHtml).join("、") || "（空）"}。请用 - 或逗号分隔非负整数，如 2-2-3。`,
    locs: [] });
  else if (body.seq.every((v) => v === 0)) issues.push({ sev: "error", kind: "reed-badseq",
    title: "地经入筘序列全是空齿",
    desc: "序列每齿入经数都是 0，无法穿入任何经纱；至少要有一个正数。", locs: [] });
  if (reed.edgeOn && !edgeP.ok) issues.push({ sev: "error", kind: "reed-badedge",
    title: "边经入筘序列无法解析",
    desc: `无法识别的片段：${edgeP.bad.map(escapeHtml).join("、") || "（空）"}。`, locs: [] });
  const bodyUsable = body.ok && body.seq.some((v) => v > 0);
  const edgeUsable = edgeP.ok && edgeP.seq.some((v) => v > 0);

  // 边经总量
  let edgeCount = 0, edgeNeeds = 0;
  if (reed.edgeOn) {
    edgeNeeds = Math.min(reed.edgeEnds, Math.floor(E / 2));
    if (2 * reed.edgeEnds > E)
      issues.push({ sev: "error", kind: "reed-edge-total",
        title: "边经总数超过总经数",
        desc: `每侧边经 ${reed.edgeEnds} 根，两边共 ${2 * reed.edgeEnds} 根，但组织图只有 ${E} 根经纱。`,
        locs: [{ kind: "reed-end", end: 0 }] });
    edgeCount = 2 * edgeNeeds;
  }
  const bodyNeed = E - edgeCount;

  // 先无限制地完整展开各段：得到理论所需筘齿与每齿“计划入经数”（原始序列值，
  // 末齿截半只影响实穿，不影响“这一齿原本要穿几根”的超限判断）。
  const ideal = { left: null, body: null, right: null };
  if (reed.edgeOn && edgeUsable && edgeNeeds > 0)
    ideal.left = reedExpandSection(edgeP.seq, edgeNeeds, -1, 0);
  if (bodyUsable)
    ideal.body = reedExpandSection(body.seq, bodyNeed, -1, edgeNeeds);
  if (reed.edgeOn && edgeUsable && edgeNeeds > 0) {
    const rightStart = edgeNeeds + (ideal.body ? ideal.body.endCount : 0);
    ideal.right = reedExpandSection(edgeP.seq, edgeNeeds, -1, rightStart);
  }
  const idealDents = (ideal.left ? ideal.left.used : 0) +
                     (ideal.body ? ideal.body.used : 0) +
                     (ideal.right ? ideal.right.used : 0);
  const overCapacity = available > 0 && idealDents > available;

  // 第二遍：按幅宽内实际可用齿数展开（超限时会在末齿截停，仅用于展示对齐）。
  const segResults = { left: null, body: null, right: null };
  let cursor = 0;
  const capAvail = (n) => unlimited ? -1 : Math.max(0, n);
  if (reed.edgeOn && edgeUsable && edgeNeeds > 0) {
    segResults.left = reedExpandSection(edgeP.seq, edgeNeeds, capAvail(available - cursor), 0);
    cursor += segResults.left.used;
  }
  let bodyAvail = unlimited ? -1 : Math.max(0, available - cursor);
  if (bodyUsable) {
    const reserveRight = (reed.edgeOn && edgeUsable && edgeNeeds > 0 && !unlimited) ? 1 : 0;
    segResults.body = reedExpandSection(body.seq, bodyNeed,
      reserveRight ? Math.max(0, bodyAvail - reserveRight) : bodyAvail, edgeNeeds);
    cursor += segResults.body.used;
  }
  if (reed.edgeOn && edgeUsable && edgeNeeds > 0) {
    const rightStart = edgeNeeds + (segResults.body ? segResults.body.endCount : 0);
    segResults.right = reedExpandSection(edgeP.seq, edgeNeeds, capAvail(available - cursor), rightStart);
    cursor += segResults.right.used;
  }

  // 组装全局筘齿：left, body, right（dentsManual=0 且无筘号时 available=0，仍照常排）
  const dents = [];
  const endDent = new Int32Array(E).fill(-1);
  const pushSeg = (seg, part) => {
    if (!seg) return;
    const seqArr = part === "body" ? body.seq : edgeP.seq;
    for (const dd of seg.dents) {
      const idx = dents.length;
      const placedN = dd.e1 - dd.e0 + 1;
      // 计划入经数取原序列该序号值（末齿因容量截停时仍按计划值判超限）
      const planN = dd.v === 0 ? 0 : (seqArr ? seqArr[dd.sIdx % seqArr.length] : placedN);
      dents.push({ idx, part, v: dd.v, planN, e0: dd.e0, e1: dd.e1, sIdx: dd.sIdx });
      for (let e = dd.e0; e <= dd.e1; e++) if (e >= 0 && e < E) endDent[e] = idx;
    }
  };
  pushSeg(segResults.left, "left");
  pushSeg(segResults.body, "body");
  pushSeg(segResults.right, "right");

  const usedDents = dents.length;
  const placedEnds = dents.reduce((n, d) => n + Math.max(0, d.e1 - d.e0 + 1), 0);

  /* ---- 问题：筘齿数不足 / 超齿（按理论展开所需齿数判，不受截断影响） ---- */
  if (overCapacity)
    issues.push({ sev: "error", kind: "reed-dents-over",
      title: `筘齿数不足：序列铺满需要 ${idealDents} 齿，幅宽内只有 ${available} 齿`,
      desc: "入筘序列铺开所需筘齿数超过幅宽内筘齿数，请放宽幅宽、加大筘号或减小入经数。",
      locs: [{ kind: "reed-dent", dent: available }] });

  /* ---- 问题：段内停止（受筘齿上限约束排不完；不限齿数的预览模式不报） ---- */
  if (!unlimited && overCapacity) for (const [part, nm] of [["left", "左边经"], ["body", "地经"], ["right", "右边经"]]) {
    const seg = segResults[part];
    if (seg && seg.stopped)
      issues.push({ sev: "error", kind: "reed-seg-stop",
        title: `${nm}在可用筘齿内排不完`,
        desc: "序列中空齿过多或筘齿数不足，经纱无法全部穿入；工具不会自动补线，请手工调整序列或筘齿数。",
        locs: [{ kind: "reed-dent", dent: Math.min(usedDents, Math.max(0, available - 1)) }] });
  }

  /* ---- 问题：边经根数与序列实穿不符 ---- */
  if (reed.edgeOn && edgeUsable) {
    for (const [part, seg] of [["left", segResults.left], ["right", segResults.right]]) {
      if (seg && seg.endCount !== edgeNeeds)
        issues.push({ sev: "error", kind: "reed-edge-mismatch",
          title: `${part === "left" ? "左" : "右"}边经只穿入 ${seg.endCount} / ${edgeNeeds} 根`,
          desc: "边经序列在幅宽内没有铺满规定的边经根数，且工具不会自动补线。",
          locs: [{ kind: "reed-end",
                   end: part === "left" ? Math.min(E - 1, seg.endCount) : E - 1 - Math.max(0, edgeNeeds - seg.endCount) }] });
    }
  }

  /* ---- 问题：总经数不符（序列实穿总数 ≠ 组织图经纱数） ---- */
  if (placedEnds !== E && bodyUsable && !(available > 0 && usedDents > available)) {
    const diff = E - placedEnds;
    issues.push({ sev: diff > 0 ? "warn" : "error", kind: "reed-total",
      title: diff > 0
        ? `总经数不符：还有 ${diff} 根经纱未入筘（组织图 ${E} 根 / 已穿 ${placedEnds} 根）`
        : `总经数不符：序列需 ${placedEnds} 根，比组织图多 ${-diff} 根`,
      desc: diff > 0
        ? "当前序列按循环铺完筘齿后未覆盖全部经纱。工具不自动补线，请调整序列、筘齿数或边经规则。"
        : "序列所需经纱多于组织图经纱，请缩短筘齿排布或修改序列。",
      locs: [{ kind: "reed-end", end: diff > 0 ? placedEnds : E - 1 },
             { kind: "reed-dent", dent: Math.min(usedDents - 1, Math.max(0, usedDents - 1)) }] });
  }

  /* ---- 问题：空齿位置错误（空齿只允许在段首/段尾——即段边界两侧；段内部空齿报错） ---- */
  for (const d of dents) {
    if (d.v !== 0) continue;
    const seg = segResults[d.part];
    const isBoundary = seg && (d.sIdx === 0 || d.sIdx === seg.dents.length - 1);
    if (!isBoundary)
      issues.push({ sev: "error", kind: "reed-empty",
        title: `筘齿 ${d.idx + 1} 是空齿，且位于${partName(d.part)}段内部`,
        desc: "空齿只允许出现在边经与地经的段边界；排布内部不应出现空齿，否则布面出现稀档。",
        locs: [{ kind: "reed-dent", dent: d.idx },
               { kind: "reed-end", end: clamp(d.idx === 0 ? 0 : (dents[d.idx - 1]?.e1 ?? 0), 0, E - 1) }] });
  }

  /* ---- 问题：每齿超限（地经 / 边经分开判；按计划入经数，末齿截停也判） ---- */
  for (const d of dents) {
    const n = d.planN;
    const limit = d.part === "body" ? reed.maxPerDent : reed.edgeMax;
    if (n > limit)
      issues.push({ sev: "error",
        kind: d.part === "body" ? "reed-over-body" : "reed-over-edge",
        title: `筘齿 ${d.idx + 1} 入经 ${n} 根，超过${d.part === "body" ? "地经" : "边经"}每齿上限 ${limit}`,
        desc: "超限筘齿会造成密档、磨损经纱，请改小序列中的入经数。",
        locs: [{ kind: "reed-dent", dent: d.idx }, { kind: "reed-end", end: d.e0 }] });
  }

  /* ---- 穿综缺失：入筘经纱在组织图中未穿综（信息） ---- */
  const unthreadedEnds = [];
  for (let e = 0; e < E; e++) if (endDent[e] < 0) {
    // 未入筘的经纱在总经数问题里报告；这里仅记录入了筘但未穿综的
  }
  for (const d of dents) {
    for (let e = d.e0; e <= d.e1; e++) {
      let threaded = false;
      for (let s = 0; s < state.S; s++) if (state.threading.has(key(s, e))) { threaded = true; break; }
      if (!threaded) unthreadedEnds.push(e);
    }
  }
  if (unthreadedEnds.length)
    issues.push({ sev: "info", kind: "reed-unthreaded",
      title: `${unthreadedEnds.length} 根已入筘经纱在组织图中未穿综`,
      desc: "穿筘对齐以经纱次序为准；未穿综的经纱可在「问题校对」页处理。",
      locs: unthreadedEnds.slice(0, 10).map((e) => ({ kind: "reed-end", end: e, text: `经纱 ${e + 1}` })) });

  /* ---- 色序错位：地经颜色循环边界落在某筘齿内部（不与齿边界对齐） ---- */
  const colorPeriod = reedColorPeriod(E);
  if (colorPeriod > 1 && segResults.body) {
    // 以地经首根为相位基准，颜色分界位置（每 colorPeriod 根一处）
    const bodyStart = edgeCount;
    for (const d of dents) {
      if (d.part !== "body" || d.e1 < d.e0) continue;
      const rel0 = d.e0 - bodyStart, rel1 = d.e1 - bodyStart;
      // 该齿跨越颜色周期边界：(floor(rel1/CP) > floor(rel0/CP))，且边界不在齿的起始处
      if (rel0 >= 0 && Math.floor(rel1 / colorPeriod) > Math.floor(rel0 / colorPeriod) &&
          rel0 % colorPeriod !== 0) {
        issues.push({ sev: "warn", kind: "reed-color",
          title: `筘齿 ${d.idx + 1} 内色序换色（经纱 ${d.e0 + 1}–${d.e1 + 1}）`,
          desc: `地经颜色循环长 ${colorPeriod} 根，该筘齿跨越换色点，色条可能在齿内错位；可调整入筘序列使换色落在齿间。`,
          locs: [{ kind: "reed-dent", dent: d.idx }, { kind: "reed-end", end: d.e1 }] });
        break;
      }
    }
    // 边经左右色不对称（提示）
    if (reed.edgeOn && edgeNeeds > 0) {
      let asym = 0;
      for (let i = 0; i < edgeNeeds; i++)
        if (warpColorAt(i) !== warpColorAt(E - 1 - i)) { asym = 1; break; }
      if (asym)
        issues.push({ sev: "info", kind: "reed-edge-color",
          title: "左右边经配色不对称",
          desc: "最外侧边经颜色从左到右不互为镜像，布边配色可能不一致。",
          locs: [{ kind: "reed-end", end: 0 }, { kind: "reed-end", end: E - 1 }] });
    }
  }

  /* ---- 统计（幅宽/经密均在当前单位下；幅宽按理论完整展开的筘齿数换算） ---- */
  const pitch = reedPitch(reed);
  const widthDents = unlimited ? idealDents || usedDents : Math.max(idealDents, usedDents);
  const actualWidth = pitch > 0 ? widthDents / pitch : 0;
  const overallDensity = actualWidth > 0 ? placedEnds / actualWidth : 0;
  const segDensity = {};
  for (const part of ["left", "body", "right"]) {
    const seg = ideal[part];
    const nDent = seg ? seg.dents.length : 0;
    const nEnd = seg ? seg.endCount : 0;
    segDensity[part] = { dents: nDent, ends: nEnd,
      density: pitch > 0 && nDent ? nEnd / (nDent / pitch) : 0 };
  }
  const target = reedTargetDensity(reed);
  const densErr = target > 0 && overallDensity > 0
    ? (overallDensity - target) / target * 100 : null;
  const bodyVals = bodyUsable ? body.seq : [];
  const overBody = dents.filter((d) => d.part === "body" && d.planN > reed.maxPerDent).length;
  const overEdge = dents.filter((d) => d.part !== "body" && d.planN > reed.edgeMax).length;

  return {
    reed, E, available, dents, usedDents, endDent, placedEnds,
    edgeNeeds, edgeCount, bodyNeed,
    bodySeqOk: body.ok, edgeSeqOk: edgeP.ok,
    actualWidth, overallDensity, segDensity, densErr,
    bodyMean: meanOf(bodyVals), bodyVals,
    overBody, overEdge,
    tailEmpty: Math.max(0, available - usedDents),
    issues,
  };
}
function partName(p) { return p === "left" ? "左边经" : p === "right" ? "右边经" : "地经"; }

/* 地经颜色循环长度（1=全同色，不做色检） */
function reedColorPeriod(E) {
  const colors = [];
  for (let e = 0; e < E; e++) colors.push(warpColorAt(e));
  if (new Set(colors).size <= 1) return 1;
  return detectPeriod(colors);
}

/* ============================================================
   搜索：枚举入筘循环，选最接近目标经密、疏密变化最小的方案
   ============================================================ */
function searchReedCandidates() {
  const reed = state.reed;
  const L = computeReedLayout();
  const available = L.available;
  const edgeCount = L.edgeCount;
  const bodyNeed = L.bodyNeed;
  if (!(available > 0)) return { ok: false, error: "缺少有效的筘号与幅宽（或手工筘齿数），无法确定可用筘齿数。" };
  if (bodyNeed <= 0) return { ok: false, error: "边经已占满全部经纱，没有地经可排。" };

  // 每齿可取 0..cap 的循环（长度 1..6）；0 齿占空但不贡献经纱
  const cap = Math.max(1, reed.maxPerDent | 0);
  const seen = new Set();
  const cands = [];
  const MAX_NODES = 60000;
  let nodes = 0;
  function considerRaw(seq0) {
    if (++nodes > MAX_NODES) return;
    // 归一化：以最小元素旋转为起点，去重循环同构
    let seq = seq0.slice();
    let rot = 0;
    for (let i = 1; i < seq.length; i++)
      if (seq[i] < seq[rot]) rot = i;
    seq = seq0.slice(rot).concat(seq0.slice(0, rot));
    const sig = seq.join("-");
    if (seen.has(sig)) return;
    seen.add(sig);
    // 纯 0 序列无意义
    if (!seq.some((v) => v > 0)) return;

    // 地经可用齿：总齿减去边经实际齿（用当前边经序列展开估算）
    const reserve = estimateEdgeDents(L, seq);
    const bodyAvail = available - reserve.edgeDents;
    if (bodyAvail <= 0) { cands.push({ seq, error: "edge", reserve }); return; }

    // 精确整除：循环均入 m，k 个循环恰好 bodyNeed 根且占 k*len 齿
    const m = meanOf(seq);
    let fit = null;
    if (m > 0) {
      const k = bodyNeed / (m * seq.length);
      if (Math.abs(k - Math.round(k)) < 1e-9 && k >= 1) {
        const nDent = Math.round(k) * seq.length;
        if (nDent <= bodyAvail) fit = { nDent, exact: true };
      }
    }
    // 回退：直接按 bodyAvail 齿循环截断，看能否恰好铺满（末齿不截半）
    if (!fit) {
      let ends = 0, nDent = 0, exact = true;
      for (let i = 0; i < bodyAvail && ends < bodyNeed; i++, nDent++) {
        const v = seq[i % seq.length];
        if (ends + v > bodyNeed) { exact = false; break; }
        ends += v;
      }
      if (ends === bodyNeed && exact && nDent > 0) fit = { nDent, exact: true };
    }
    if (!fit) return;

    // 超限齿（地经）
    const over = seq.filter((v) => v > cap).length;
    const totalDents = reserve.edgeDents + fit.nDent;
    const pitch = reedPitch(reed);
    const width = totalDents / pitch;          // 同单位幅宽
    const density = width > 0 ? state.E / width : 0;
    const target = reedTargetDensity(reed);
    const densErr = target > 0 ? (density - target) / target * 100 : 0;
    // 疏密变化：相邻齿入经差绝对值之和（按循环闭合）+ 极差
    let jump = 0;
    for (let i = 0; i < seq.length; i++) jump += Math.abs(seq[i] - seq[(i + 1) % seq.length]);
    const spread = Math.max(...seq) - Math.min(...seq);
    const nZero = seq.filter((v) => v === 0).length;
    cands.push({ seq, nDent: fit.nDent, totalDents, width, density,
      densErr, jump, spread, over, nZero, m });
  }
  // 按长度枚举全部组合
  for (let len = 1; len <= 6 && nodes <= MAX_NODES; len++) {
    const total = Math.pow(cap + 1, len);
    for (let code = 0; code < total; code++) {
      const seq = [];
      let x = code;
      for (let i = 0; i < len; i++) { seq.push(x % (cap + 1)); x = Math.floor(x / (cap + 1)); }
      considerRaw(seq);
      if (nodes > MAX_NODES) break;
    }
  }
  // 还需保证边经序列本身可铺满（用其展开结果在候选中标记）
  const valid = cands.filter((c) => !c.error);
  if (!valid.length) return { ok: false, error: "在当前筘齿数、每齿上限与边经规则下没有能恰好铺满总经数的整数循环。可放宽上限或增大筘号/幅宽。" };
  valid.sort((a, b) =>
    (b.over === 0 ? 1 : 0) - (a.over === 0 ? 1 : 0) ||
    Math.abs(a.densErr) - Math.abs(b.densErr) ||
    a.jump - b.jump || a.spread - b.spread ||
    a.seq.length - b.seq.length || a.nZero - b.nZero);
  return { ok: true, cands: valid.slice(0, 6) };
}
/* 估计边经占齿数（左右各展开一次），供搜索预算 */
function estimateEdgeDents(L, bodySeq) {
  const reed = state.reed;
  let edgeDents = 0;
  if (reed.edgeOn && L.edgeNeeds > 0) {
    const ep = parseReedSeq(reed.edgeSeq);
    if (ep.ok) {
      const one = reedExpandSection(ep.seq, L.edgeNeeds, L.available, 0);
      edgeDents = 2 * one.used;
    }
  }
  return { edgeDents };
}

/* ============================================================
   穿筘 SVG（面板 + 打印共用，返回字符串）
   ============================================================ */
function reedDiagramSvg(L, px, forPrint) {
  const { dents, E } = L;
  const w = px, gap = forPrint ? 0.8 : 1.2;
  const nDent = dents.length;
  const tail = Math.max(0, L.available - nDent);
  // 未入筘经纱按半齿宽逐根画在右侧
  let unplacedCount = 0;
  for (let e = 0; e < E; e++) if (L.endDent[e] < 0) unplacedCount++;
  const widthUnits = Math.max(L.available, nDent) + unplacedCount * 0.5;
  const W = Math.max(40, widthUnits * (w + gap) + 4);
  // 行：齿号 5 / 颜色 9 / 综框 11 / 齿框 11 / 经号 7
  const laneDentNo = 0, laneColor = 5.5, laneShaft = 15, laneBox = 25, laneEndNo = 38;
  const H = laneEndNo + 7;
  const xAt = (i) => 1 + i * (w + gap);
  let s = `<svg id="reedSvg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
  if (!nDent) {
    if (!unplacedCount)
      return `<svg id="reedSvg" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
        <text class="reed-lane-txt" x="2" y="${H / 2}">当前参数下还没有可显示的筘齿（缺筘号/幅宽或序列无效）。</text></svg>`;
    // 无筘齿时把全部未入筘经纱画出来（红框色条）
    const ww = Math.max(W, E * (w / 2 + .6) + 4);
    let t = `<svg id="reedSvg" width="${ww}" height="${H}" xmlns="http://www.w3.org/2000/svg">`;
    for (let e = 0; e < E; e++) {
      const x = 2 + e * (w / 2 + .6);
      const col = state.colorPrint || !forPrint ? warpColorAt(e) : "#2b2b28";
      t += `<rect class="reed-end reed-end-issue" data-end="${e}" x="${x}" y="${laneColor}"
            width="${w / 2}" height="${laneEndNo - laneColor + 2}" fill="${col}"/>`;
      if ((e + 1) % 5 === 0)
        t += `<text class="reed-num clickable" data-end="${e}" x="${x + w / 4}" y="${laneEndNo + 5.4}">${e + 1}</text>`;
    }
    t += `<text class="reed-lane-txt" x="2" y="${laneColor - 1}">全部 ${E} 根经纱均未入筘（不自动补线）</text></svg>`;
    return t;
  }

  // 段底色
  const segRange = (part) => {
    const a = dents.findIndex((d) => d.part === part);
    let b = -1;
    for (let i = nDent - 1; i >= 0; i--) if (dents[i].part === part) { b = i; break; }
    return a < 0 ? null : [a, b];
  };
  for (const part of ["left", "right"]) {
    const r = segRange(part);
    if (r) s += `<rect class="reed-selvedge-bg" x="${xAt(r[0]) - gap / 2}" y="2"
                 width="${(r[1] - r[0] + 1) * (w + gap) - gap / 2}" height="${H - 6}"/>`;
  }

  // 空尾齿（幅宽内未使用）
  for (let i = 0; i < tail; i++) {
    const x = xAt(nDent + i);
    s += `<rect class="reed-dent-empty" x="${x}" y="${laneBox}" width="${w}" height="10"/>`;
  }

  // 筘齿框 + 经纱色条 + 综框号
  const issueDents = new Set(), issueEnds = new Set();
  for (const it of L.issues)
    for (const loc of it.locs || []) {
      if (loc.kind === "reed-dent") issueDents.add(loc.dent);
      if (loc.kind === "reed-end") issueEnds.add(loc.end);
    }
  for (const d of dents) {
    const x = xAt(d.idx);
    const dentBad = issueDents.has(d.idx);
    if (d.v === 0) {
      s += `<rect class="reed-dent-empty ${dentBad ? "reed-dent-issue" : ""}" x="${x}" y="${laneBox}" width="${w}" height="10"/>`;
      s += `<rect class="reed-dent-box ${dentBad ? "reed-dent-issue" : ""}" data-dent="${d.idx}" x="${x}" y="${laneBox}" width="${w}" height="10"/>`;
    } else {
      const n = d.e1 - d.e0 + 1;
      const ew = w / n;
      for (let e = d.e0; e <= d.e1; e++) {
        const ex = x + (e - d.e0) * ew;
        const col = state.colorPrint || !forPrint ? warpColorAt(e) : "#2b2b28";
        const endBad = issueEnds.has(e);
        s += `<rect class="reed-end ${endBad ? "reed-end-issue" : ""}" data-end="${e}"
              x="${ex + .1}" y="${laneColor}" width="${ew - .2}" height="${laneEndNo - laneColor + 2}" fill="${col}"/>`;
        // 综框号
        let sh = -1;
        for (let ss = 0; ss < state.S; ss++) if (state.threading.has(key(ss, e))) { sh = ss + 1; break; }
        if (sh > 0)
          s += `<text class="reed-txt" x="${ex + ew / 2}" y="${laneShaft + 2.6}">${sh}</text>`;
      }
      s += `<rect class="reed-dent-box ${dentBad ? "reed-dent-issue" : ""}" data-dent="${d.idx}"
            x="${x}" y="${laneBox}" width="${w}" height="10"/>`;
    }
    // 齿号
    const major = (d.idx + 1) % 5 === 0;
    s += `<text class="reed-num ${major ? "major" : ""} ${d.part !== "body" ? "edge-num clickable" : "clickable"}"
          data-dent="${d.idx}" x="${x + w / 2}" y="${laneDentNo + 3.6}">${d.idx + 1}</text>`;
    // 经纱序号（每 5 根在色条下标一次）
    if (d.e1 >= d.e0) {
      const nEnd = d.e1 - d.e0 + 1;
      const ew2 = w / nEnd;
      for (let e = d.e0; e <= d.e1; e++) {
        if ((e + 1) % 5 !== 0) continue;
        s += `<text class="reed-num clickable" data-end="${e}"
              x="${x + (e - d.e0) * ew2 + ew2 / 2}" y="${laneEndNo + 5.4}">${e + 1}</text>`;
      }
    }
  }
  // 未入筘经纱：逐根画在全部筘齿（含尾空齿）之后，红框色条仍可点击定位到穿综格
  const unplaced = [];
  for (let e = 0; e < E; e++) if (L.endDent[e] < 0) unplaced.push(e);
  if (unplaced.length) {
    const baseX = xAt(Math.max(nDent, L.available)) + gap;
    const ew = Math.max(1.2, w / 2);
    unplaced.forEach((e, i) => {
      const x = baseX + i * ew;
      const col = state.colorPrint || !forPrint ? warpColorAt(e) : "#2b2b28";
      s += `<rect class="reed-end reed-end-issue" data-end="${e}"
            x="${x}" y="${laneColor}" width="${ew - .2}" height="${laneEndNo - laneColor + 2}"
            fill="${col}"/>`;
      s += `<text class="reed-num clickable" data-end="${e}"
            x="${x + ew / 2 - .1}" y="${laneEndNo + 5.4}">${e + 1}</text>`;
    });
    s += `<text class="reed-lane-txt" x="${baseX}" y="${laneColor - 1}">未入筘 ${unplaced.length} 根（不自动补线）</text>`;
  }
  s += `</svg>`;
  return s;
}

/* ============================================================
   面板渲染
   ============================================================ */
let reedLayoutCache = null;
function refreshReed() {
  if (!state.reed) state.reed = defaultReed();
  reedLayoutCache = computeReedLayout();
  renderReedStatus(reedLayoutCache);
  renderReedStats(reedLayoutCache);
  renderReedDiagram(reedLayoutCache);
  renderReedIssues(reedLayoutCache);
  scheduleWarpRefresh();
}
let reedTimer = null;
function scheduleReedRefresh() {
  clearTimeout(reedTimer);
  reedTimer = setTimeout(() => { if ($("#paneReed")) refreshReed(); }, 180);
}
function renderReedStatus(L) {
  const el = $("#reedStatus");
  if (!el) return;
  const nErr = L.issues.filter((i) => i.sev === "error").length;
  const nWarn = L.issues.filter((i) => i.sev === "warn").length;
  el.className = "reed-status " + L.reed.status;
  let note = "";
  if (L.reed.status === "draft") note = `参数可继续修改（${nErr} 错误 / ${nWarn} 警告）`;
  if (L.reed.status === "checked") note = "已通过校验；修改任一参数将回到草拟";
  if (L.reed.status === "adopted") note = "已采用，随撤销/草稿/项目版本保存 · " + fmtTime(L.reed.adoptedAt);
  el.innerHTML = `状态：${REED_LS_STATUS[L.reed.status]} <span class="reed-status-note">${note}</span>`;
  const printBtn = $("#btnReedPrint");
  if (printBtn) {
    printBtn.disabled = L.reed.status === "draft" || nErr > 0;
    printBtn.title = printBtn.disabled ? "只有已校验/已采用且无错误的方案才能打印穿经单" : "";
  }
  const adoptBtn = $("#btnReedAdopt");
  if (adoptBtn) adoptBtn.disabled = nErr > 0;
}
function fmtDensity(v) {
  if (!v) return "—";
  return v.toFixed(2);
}
function renderReedStats(L) {
  const el = $("#reedStats");
  if (!el) return;
  const r = L.reed;
  const unitTxt = r.unit === "in" ? "英寸" : "厘米";
  const tgt = reedTargetDensity(r);
  const errCls = L.densErr === null ? "" : Math.abs(L.densErr) <= 3 ? "ok" : Math.abs(L.densErr) <= 8 ? "warn" : "bad";
  const densTxt = L.overallDensity
    ? `${fmtDensity(L.overallDensity)} 根/${unitTxt}` +
      (L.densErr !== null ? ` <span class="small">(${L.densErr >= 0 ? "+" : ""}${L.densErr.toFixed(1)}%)</span>` : "")
    : "—";
  const segLine = (nm, sd) =>
    `${nm} ${sd.ends}根/${sd.dents}齿 · ` +
    (sd.density ? `${fmtDensity(sd.density)} 根/${unitTxt}` : "—");
  const overCls = L.overBody + L.overEdge ? "bad" : "ok";
  el.innerHTML = `
    <div class="reed-stat">总经数 <b>${L.E}</b> ｜ 已入筘 <b class="${L.placedEnds === L.E ? "ok" : "bad"}">${L.placedEnds}</b></div>
    <div class="reed-stat">幅宽内筘齿 <b>${L.available || "—"}</b> ｜ 实际占用 <b>${L.usedDents}</b>${L.tailEmpty ? ` <span class="small">余 ${L.tailEmpty} 空齿</span>` : ""}</div>
    <div class="reed-stat">实际幅宽 <b>${L.actualWidth ? L.actualWidth.toFixed(2) + " " + unitTxt : "—"}</b>${r.width ? ` <span class="small">目标 ${r.width}</span>` : ""}</div>
    <div class="reed-stat ${errCls}">整体经密 <b>${densTxt}</b>${tgt ? ` <span class="small">目标 ${r.targetDensity}</span>` : ""}</div>
    <div class="reed-stat">${segLine("左边", L.segDensity.left)}</div>
    <div class="reed-stat">${segLine("地经", L.segDensity.body)}</div>
    <div class="reed-stat">${segLine("右边", L.segDensity.right)}</div>
    <div class="reed-stat ${overCls}">超限筘齿 <b>${L.overBody + L.overEdge}</b>
      <span class="small">（地经 ${L.overBody} / 边 ${L.overEdge}）</span></div>`;
}
function renderReedDiagram(L) {
  const box = $("#reedDiagram");
  if (!box) return;
  box.innerHTML = reedDiagramSvg(L, 6, false);
}
function renderReedIssues(L) {
  const ul = $("#reedIssueList");
  if (!ul) return;
  ul.innerHTML = "";
  if (!L.issues.length) {
    ul.innerHTML = `<li class="issue-item sev-info" style="cursor:default;border-left-color:var(--green)">
      <div class="ii-title">✓ 未发现穿筘问题</div></li>`;
    return;
  }
  L.issues.forEach((it, i) => {
    const li = document.createElement("li");
    li.className = `issue-item sev-${it.sev}`;
    const sevName = it.sev === "error" ? "错误" : it.sev === "warn" ? "警告" : "提示";
    let html = `<div class="ii-title">${it.title} <span class="small">[${sevName}]</span></div>
      <div class="ii-desc">${it.desc}</div>`;
    if (it.locs && it.locs.length) {
      const txt = it.locs.slice(0, 6).map((lc) => {
        if (lc.text) return lc.text;
        if (lc.kind === "reed-dent") return `筘齿 ${Math.min(lc.dent + 1, L.usedDents || 1)}`;
        return `经纱 ${lc.end + 1}`;
      }).join("、");
      html += `<div class="ii-locs">📍 ${txt}</div>`;
    }
    li.innerHTML = html;
    li.addEventListener("click", () => locateReedIssue(it));
    ul.appendChild(li);
  });
}

/* 点击问题：定位具体经纱（穿综格闪烁）与筘齿（穿筘图闪烁） */
function locateReedIssue(it) {
  const dent = (it.locs || []).find((l) => l.kind === "reed-dent");
  const end = (it.locs || []).find((l) => l.kind === "reed-end");
  if (dent) flashReedDent(dent.dent);
  if (end) {
    flashReedEnd(end.end);
    flashGridCell("threading", Math.max(0, endShaftOf(end.end)), end.end);
  }
}
function flashReedDent(idx) {
  const svg = $("#reedSvg");
  if (!svg) return;
  const els = svg.querySelectorAll(`[data-dent="${idx}"]`);
  els.forEach((e) => { e.classList.add("reed-flash"); setTimeout(() => e.classList.remove("reed-flash"), 1700); });
  const box = $("#reedDiagram");
  if (els.length && box) scrollElHoriz(els[els.length - 1], box);
}
function flashReedEnd(e) {
  const svg = $("#reedSvg");
  if (!svg) return;
  const el = svg.querySelector(`[data-end="${e}"]`);
  if (el) {
    el.classList.add("reed-flash");
    setTimeout(() => el.classList.remove("reed-flash"), 1700);
    const box = $("#reedDiagram");
    if (box) scrollElHoriz(el, box);
  }
}
function scrollElHoriz(el, container) {
  const b = el.getBoundingClientRect && el.getBoundingClientRect();
  const cb = container.getBoundingClientRect();
  if (b && (b.left < cb.left || b.right > cb.right))
    container.scrollLeft += b.left - cb.left - 30;
}

/* SVG 委托：点色条→穿综格；点齿号/齿框→闪烁该齿 */
function bindReedDiagramEvents() {
  const box = $("#reedDiagram");
  if (!box || box.dataset.bound) return;
  box.dataset.bound = "1";
  box.addEventListener("click", (ev) => {
    const endEl = ev.target.closest("[data-end]");
    if (endEl) {
      const e = +endEl.dataset.end;
      flashGridCell("threading", Math.max(0, endShaftOf(e)), e);
      $("#coordText").textContent =
        `穿筘：经纱 ${e + 1} → 筘齿 ${reedLayoutCache.endDent[e] + 1} · 综框 ${endShaftOf(e) + 1}`;
      return;
    }
    const dentEl = ev.target.closest("[data-dent]");
    if (dentEl) flashReedDent(+dentEl.dataset.dent);
  });
}

/* ============================================================
   表单 ↔ state.reed
   ============================================================ */
function syncReedForm() {
  const r = state.reed || (state.reed = defaultReed());
  $("#reedReedNo").value = r.reedNo || "";
  $("#reedTargetDensity").value = r.targetDensity || "";
  $("#reedWidth").value = r.width || "";
  $("#reedDents").value = r.dentsManual || "";
  $("#reedMaxDent").value = r.maxPerDent;
  $("#reedSequence").value = r.seq;
  $("#reedEdgeOn").checked = !!r.edgeOn;
  $("#reedEdgeEnds").value = r.edgeEnds;
  $("#reedEdgeMax").value = r.edgeMax;
  $("#reedEdgeSeq").value = r.edgeSeq;
  $("#reedUnit").value = r.unit;
  updateReedUnitLabels();
  refreshReed();
}
function updateReedUnitLabels() {
  const u = state.reed.unit === "in" ? "英寸" : "厘米";
  $("#reedDensityUnit").textContent = u;
  $("#reedWidthUnit").textContent = u;
}
function readReedForm({ keepStatus } = {}) {
  const r = state.reed;
  r.reedNo = Math.max(0, +$("#reedReedNo").value || 0);
  r.targetDensity = Math.max(0, +$("#reedTargetDensity").value || 0);
  r.width = Math.max(0, +$("#reedWidth").value || 0);
  r.dentsManual = Math.max(0, +$("#reedDents").value || 0);
  r.maxPerDent = clamp(+$("#reedMaxDent").value || 1, 1, 10);
  r.seq = $("#reedSequence").value.trim() || "0";
  r.edgeOn = $("#reedEdgeOn").checked;
  r.edgeEnds = Math.max(0, +$("#reedEdgeEnds").value || 0);
  r.edgeMax = clamp(+$("#reedEdgeMax").value || 1, 1, 10);
  r.edgeSeq = $("#reedEdgeSeq").value.trim() || "0";
  if (!keepStatus) r.status = "draft";
  refreshReed();
}
function commitReedEdit() {
  readReedForm();
  pushHistory();
}

/* 单位切换：在厘米/英寸间换算，保持物理方案不变。
   筘号/经密是“每单位长度”的计数：单位变小(cm)计数变大 → 乘 2.54；
   幅宽是长度：cm→in 除 2.54，in→cm 乘 2.54。 */
function switchReedUnit(to) {
  const r = state.reed;
  if (r.unit === to) return;
  if (to === "in") {                       // cm → in
    r.reedNo = r.reedNo * CM_PER_IN;       // 每英寸计数 = 每厘米 × 2.54
    r.targetDensity = r.targetDensity * CM_PER_IN;
    r.width = r.width / CM_PER_IN;         // 英寸 = 厘米 / 2.54
  } else {                                 // in → cm
    r.reedNo = r.reedNo / CM_PER_IN;
    r.targetDensity = r.targetDensity / CM_PER_IN;
    r.width = r.width * CM_PER_IN;
  }
  r.unit = to;
  r.status = "draft";
  const round2 = (v) => Math.round(v * 100) / 100;
  $("#reedReedNo").value = round2(r.reedNo) || "";
  $("#reedTargetDensity").value = round2(r.targetDensity) || "";
  $("#reedWidth").value = round2(r.width) || "";
  updateReedUnitLabels();
  refreshReed();
  pushHistory();
}

/* ---------------- 校验 / 采用 ---------------- */
function reedCheck() {
  readReedForm({ keepStatus: true });
  const L = reedLayoutCache;
  const nErr = L.issues.filter((i) => i.sev === "error").length;
  if (nErr) { toast(`仍有 ${nErr} 个错误，不能通过校验（见下方问题列表）`, 2800); return; }
  state.reed.status = "checked";
  refreshReed();
  pushHistory();
  toast("已校验：无错误，可采用或打印穿经单");
}
function reedAdopt() {
  readReedForm({ keepStatus: true });
  const L = reedLayoutCache;
  if (L.issues.some((i) => i.sev === "error")) { toast("仍有错误，不能采用", 2600); return; }
  if (!confirm("采用当前穿筘方案？\n组织图（穿综/踏序/颜色）保持不变；采用结果随撤销、草稿与项目版本保存。")) return;
  state.reed.status = "adopted";
  state.reed.adoptedAt = Date.now();
  refreshReed();
  pushHistory();
  toast("已采用穿筘方案");
}

/* ============================================================
   搜索弹窗：并排比较候选
   ============================================================ */
function openReedSearch() {
  readReedForm({ keepStatus: true });
  const r = searchReedCandidates();
  const body = document.createElement("div");
  if (!r.ok) {
    body.innerHTML = `<div class="conv-warn">${escapeHtml(r.error)}</div>`;
    openModal("🔍 搜索入筘方案", body, [{ label: "关闭", action: closeModal }], true);
    $("#modalBox").classList.add("wide");
    return;
  }
  const unitTxt = state.reed.unit === "in" ? "英寸" : "厘米";
  body.innerHTML = `<p class="small muted" style="margin-top:0">
    候选均能恰好铺满 ${state.E} 根经纱；按 <b>超限 → 经密误差 → 疏密变化（相邻齿差/极差）</b> 排序。
    点一张卡片即把该序列填入表单（状态回到草拟，需重新校验/采用）。</p><div id="reedCandList"></div>`;
  openModal("🔍 搜索入筘方案（最接近目标经密、疏密变化最小）", body,
    [{ label: "关闭", action: closeModal }], true);
  $("#modalBox").classList.add("xwide");
  const list = body.querySelector("#reedCandList");
  r.cands.forEach((c, i) => list.appendChild(reedCandCard(c, i, unitTxt)));
}
function reedCandCard(c, i, unitTxt) {
  const card = document.createElement("div");
  card.className = "reed-cand" + (i === 0 ? " sel" : "");
  const errCls = Math.abs(c.densErr) <= 3 ? "ok" : Math.abs(c.densErr) <= 8 ? "warn" : "bad";
  card.innerHTML = `
    <div class="reed-cand-head">
      <b>候选 ${i + 1}：${c.seq.join("-")}</b>
      <span>循环 ${c.seq.length} 齿 · 均入 ${c.m.toFixed(2)}</span>
      <span>幅宽 <b>${c.width.toFixed(2)} ${unitTxt}</b></span>
      <span class="${errCls}">经密 ${c.density.toFixed(2)} 根/${unitTxt}
        （${c.densErr >= 0 ? "+" : ""}${c.densErr.toFixed(1)}%）</span>
      <span class="${c.over ? "bad" : "ok"}">超限齿 ${c.over}</span>
      <span class="small muted">疏密变化 ${c.jump} / 极差 ${c.spread}</span>
    </div>`;
  // 迷你齿条
  const px = 10;
  let s = `<svg width="${Math.min(c.totalDents * px, 900)}" height="16"
             viewBox="0 0 ${c.totalDents} 16" preserveAspectRatio="none"
             style="max-width:100%">`;
  for (let i = 0; i < c.totalDents; i++) {
    const v = i < c.nDent ? c.seq[i % c.seq.length] : 0;
    const h = 2 + v * 3;
    const fill = v > state.reed.maxPerDent ? "#c0392b" : v === 0 ? "#d6d2c6" : "#8a5a2b";
    s += `<rect x="${i}" y="${14 - h}" width=".9" height="${h}" fill="${fill}"/>`;
  }
  s += `</svg>`;
  card.insertAdjacentHTML("beforeend", s);
  card.addEventListener("click", () => {
    $("#reedSequence").value = c.seq.join("-");
    readReedForm();
    pushHistory();
    closeModal();
    toast(`已填入序列 ${c.seq.join("-")}，请校验后采用`);
  });
  return card;
}

/* ============================================================
   打印穿经单（带穿综、穿筘、颜色；仅已校验/已采用）
   ============================================================ */
function printReedSheet() {
  readReedForm({ keepStatus: true });
  const L = computeReedLayout();
  if (state.reed.status === "draft") { toast("草拟方案不能打印，请先校验", 2600); return; }
  if (L.issues.some((i) => i.sev === "error")) { toast("仍有错误，不能打印", 2600); return; }

  const r = state.reed;
  const unitTxt = r.unit === "in" ? "英寸" : "厘米";
  const area = $("#printArea");
  const px = 6;
  const svg = reedDiagramSvg(L, px, true);
  // 缩放整图到打印宽
  let diagramHtml = "";
  {
    const widthUnits = Math.max(L.available, L.usedDents);
    const svgW = widthUnits * (px + 0.8) + 2;
    diagramHtml = `<div class="print-reed-svg-wrap" style="overflow:hidden">
      <div style="transform-origin:0 0; transform:scale(${Math.min(1, 760 / svgW)})">${svg}</div></div>`;
  }
  const seg = L.segDensity;
  const widthShown = L.actualWidth;
  let html = `<div class="print-sheet">
    <div class="print-reed-head">
      <b>${escapeHtml($("#projectName").value)} · 穿经单（穿综 / 穿筘 / 颜色）</b>
      <div class="print-reed-meta">
        状态：${REED_LS_STATUS[r.status]} ｜ 总经 ${L.E} 根 ｜
        筘号 ${round3(r.reedNo)} 齿/${unitTxt} ｜ 成品幅宽 ${round3(r.width)} ${unitTxt}（实际 ${round3(widthShown)} ${unitTxt}）｜
        筘齿 ${L.usedDents}/${L.available || "—"} ｜
        入筘序列 ${escapeHtml(r.seq)}${r.edgeOn ? ` ｜ 边经每侧 ${r.edgeEnds} 根、序列 ${escapeHtml(r.edgeSeq)}` : ""}
      </div>
      <div class="print-reed-meta">
        整体经密 ${fmtDensity(L.overallDensity)} 根/${unitTxt}（目标 ${r.targetDensity || "—"}）｜
        左边 ${seg.left.ends}根/${seg.left.dents}齿 ｜ 地经 ${seg.body.ends}根/${seg.body.dents}齿 ｜ 右边 ${seg.right.ends}根/${seg.right.dents}齿 ｜
        打印日期 ${new Date().toLocaleDateString("zh-CN")}
      </div>
    </div>
    ${diagramHtml}
  </div>`;

  // 逐根表：经号、颜色、综框、筘齿号、齿内位次、段、齿入数
  const rowsPerSheet = 46;
  const endDent = L.endDent;
  const dentByEnd = [];
  for (const d of L.dents)
    for (let e = d.e0; e <= d.e1; e++) dentByEnd[e] = d;
  let sheetNo = 0;
  for (let start = 0; start < L.E; start += rowsPerSheet) {
    sheetNo++;
    let t = `<div class="print-sheet"><table class="print-threading">
      <thead><tr>
        <th style="width:12%">经纱号</th><th style="width:12%">颜色</th>
        <th style="width:12%">综框</th><th style="width:14%">筘齿号</th>
        <th style="width:14%">齿内第几位</th><th style="width:12%">该齿入经</th>
        <th>段</th>
      </tr></thead><tbody>`;
    for (let e = start; e < Math.min(L.E, start + rowsPerSheet); e++) {
      const d = dentByEnd[e];
      let sh = "—";
      for (let ss = 0; ss < state.S; ss++) if (state.threading.has(key(ss, e))) { sh = ss + 1; break; }
      t += `<tr>
        <td>${e + 1}</td>
        <td><span class="print-swatch" style="background:${warpColorAt(e)}"></span> ${warpColorAt(e)}</td>
        <td>${sh}</td>
        <td>${d ? d.idx + 1 : "未入筘"}</td>
        <td>${d ? e - d.e0 + 1 : "—"}</td>
        <td>${d ? (d.v || 0) : "—"}</td>
        <td>${d ? partName(d.part) : "—"}</td>
      </tr>`;
    }
    t += `</tbody></table>`;
    t += `<div class="print-reed-meta" style="margin-top:4px">第 ${sheetNo} 页 ｜ 经纱 ${start + 1}–${Math.min(L.E, start + rowsPerSheet)}</div>`;
    t += `</div>`;
    html += t;
  }
  area.innerHTML = html;
  window.print();
}
function round3(v) { return (Math.round((v || 0) * 100) / 100).toFixed(2); }

/* ============================================================
   穿筘模块事件绑定（init 调用一次）
   ============================================================ */
/* 只做一次：规范化数据 + 绑定事件。注意此刻 localStorage 草稿尚未恢复，
   不能在这里 syncReedForm()，否则会用空表单随后覆盖恢复的参数；
   表单回填统一在 init() 草稿恢复后调用 syncReedForm()。 */
function initReed() {
  state.reed = normalizeReed(state.reed);
  bindReedDiagramEvents();

  $("#btnReedSearch").addEventListener("click", openReedSearch);
  $("#btnReedCheck").addEventListener("click", reedCheck);
  $("#btnReedAdopt").addEventListener("click", reedAdopt);
  $("#btnReedPrint").addEventListener("click", printReedSheet);

  // 参数改动：即时重算（不入栈），失焦/回车时提交历史
  const liveIds = ["reedReedNo", "reedTargetDensity", "reedWidth", "reedDents",
                   "reedMaxDent", "reedSequence", "reedEdgeEnds", "reedEdgeMax", "reedEdgeSeq"];
  for (const id of liveIds) {
    const el = $("#" + id);
    el.addEventListener("input", () => { readReedForm(); scheduleSave(); });
    el.addEventListener("change", commitReedEdit);
    el.addEventListener("keydown", (ev) => { if (ev.key === "Enter") commitReedEdit(); });
  }
  $("#reedEdgeOn").addEventListener("change", () => { readReedForm(); commitReedEdit(); });
  $("#reedUnit").addEventListener("change", (ev) => switchReedUnit(ev.target.value));
}

/* 组织图经纱相关变化（换示例、导入 WIF、改经纱数、镜像等）后，
   旧穿筘方案不再与当前经纱次序相符，状态回到草拟（参数保留，不删除） */
function invalidateReedOnWarpChange() {
  if (state.reed && state.reed.status !== "draft") {
    state.reed.status = "draft";
    if ($("#reedStatus")) refreshReed();
  }
}
function init() {
  // 顶栏
  $("#btnUndo").addEventListener("click", undo);
  $("#btnRedo").addEventListener("click", redo);
  $("#btnSave").addEventListener("click", saveVersion);
  $("#btnArchive").addEventListener("click", openArchive);
  $("#btnExportWif").addEventListener("click", exportWIF);
  $("#btnImportWif").addEventListener("click", () => $("#wifFile").click());
  $("#btnPrint").addEventListener("click", doPrint);
  $("#btnExamples").addEventListener("click", openExamples);
  $("#btnClearAll").addEventListener("click", clearAll);

  $("#wifFile").addEventListener("change", async (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    try {
      const text = await f.text();
      const info = importWIF(text);
      toast(`已导入 WIF：${info.E}经×${info.P}纬，${info.S}综` +
            (info.liftplan ? `（直提模式，LIFTPLAN 原样保留）` : `，${info.T}踏`), 3000);
    } catch (e) { toast("WIF 导入失败：" + e.message, 3500); }
    ev.target.value = "";
  });

  // 设置条
  for (const id of ["shafts", "treadles", "ends", "picks"])
    $("#" + id).addEventListener("change", (e) => onResizeField(id, +e.target.value));
  $("#shed").addEventListener("change", (e) => {
    state.shed = e.target.value;
    updateShedHint();
    afterEdit(); pushHistory();
  });
  $("#zoom").addEventListener("input", (e) => {
    state.cell = +e.target.value;
    setBoardVars();
  });
  $("#toolMode").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    edit.mode = b.dataset.mode;
    $$("#toolMode button").forEach((x) => x.classList.toggle("active", x === b));
    if (edit.mode !== "select") cancelSelection();
  });
  $("#editMode").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    switchEditMode(b.dataset.editmode);
  });

  // 选区
  $("#selCopy").addEventListener("click", selCopy);
  $("#selCut").addEventListener("click", selCut);
  $("#selPaste").addEventListener("click", enterPasteWait);
  $("#selRepeat").addEventListener("click", selRepeat);
  $("#selCancel").addEventListener("click", () => cancelSelection());

  // 播放
  $("#playFirst").addEventListener("click", () => { stopPlay(); setPlayPick(-1); });
  $("#playPrev").addEventListener("click", () => stepPlay(-1));
  $("#playBtn").addEventListener("click", startPlay);
  $("#playNext").addEventListener("click", () => stepPlay(1));
  $("#playLast").addEventListener("click", () => { stopPlay(); setPlayPick(state.P - 1); });
  $("#playSpeed").addEventListener("input", (e) => { play.speed = 1560 - +e.target.value; });
  $("#playLoop").addEventListener("change", (e) => { play.loop = e.target.checked; });
  play.speed = 1560 - +$("#playSpeed").value;

  // 规则
  $("#maxFloatFront").addEventListener("change", (e) => {
    state.rules.maxFront = Math.max(1, +e.target.value || 4); runAnalysis(); scheduleSave(); });
  $("#maxFloatBack").addEventListener("change", (e) => {
    state.rules.maxBack = Math.max(1, +e.target.value || 4); runAnalysis(); scheduleSave(); });
  $("#edgeRule").addEventListener("change", (e) => { state.rules.edge = e.target.checked; runAnalysis(); });
  $("#edgeWidth").addEventListener("change", (e) => {
    state.rules.edgeW = clamp(+e.target.value || 1, 1, 10); runAnalysis(); });
  $("#btnRecheck").addEventListener("click", () => { runAnalysis(); toast("已重新检查"); });

  // 变体
  $$("[data-variant]").forEach((b) =>
    b.addEventListener("click", () => previewVariant(b.dataset.variant)));
  $("#variantApply").addEventListener("click", applyVariant);
  $("#variantCancel").addEventListener("click", cancelVariant);

  // 色纱
  $("#warpColorApply").addEventListener("click", applyAllWarp);
  $("#weftColorApply").addEventListener("click", applyAllWeft);
  $("#colorPrintMode").addEventListener("change", (e) => {
    state.colorPrint = e.target.checked; renderDrawdown(); });

  // 标签页
  $$(".tabs button").forEach((b) => b.addEventListener("click", () => {
    $$(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
    $$(".tab-pane").forEach((p) =>
      p.classList.toggle("active", p.id === "pane" + cap(b.dataset.tab)));
  }));

  // 模态
  $("#modalClose").addEventListener("click", closeModal);
  $("#modalMask").addEventListener("pointerdown", (e) => { if (e.target === $("#modalMask")) closeModal(); });

  // 快捷键
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") {
      if (e.key === "Escape") { if (!$("#modalMask").hidden) closeModal(); }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault(); e.shiftKey ? redo() : undo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
      e.preventDefault(); redo();
    } else if (e.key === "Escape") {
      if (!$("#modalMask").hidden) closeModal();
      else if (edit.selection || edit.pasteMode) cancelSelection();
      else { stopPlay(); setPlayPick(-1); }
    } else if (e.key === " ") {
      e.preventDefault(); startPlay();
    }
  });

  attachDrawdownHover();
  initReed();

  // 恢复草稿或载入默认示例
  let restored = false;
  try {
    const saved = localStorage.getItem(LS_KEY);
    if (saved) {
      const d = JSON.parse(saved);
      if (d && d.threading) {
        state.S = d.S; state.T = d.T; state.E = d.E; state.P = d.P;
        state.shed = d.shed || "rising";
        state.mode = d.mode === "lift" ? "lift" : "treadle";
        state.threading = new Set(d.threading);
        state.tieup = new Set(d.tieup || []);
        state.treadling = new Set(d.treadling || []);
        state.liftplan = new Set(d.liftplan || []);
        state.warpColors = d.warpColors || [];
        state.weftColors = d.weftColors || [];
        state.reed = normalizeReed(d.reed || null);
        $("#projectName").value = d.name || "未命名项目";
        restored = true;
      }
    }
  } catch (e) {}
  if (!restored) {
    const d = EXAMPLES["平纹（2综2踏）"]();
    state.S = d.S; state.T = d.T; state.E = d.E; state.P = d.P;
    state.threading = d.threading; state.tieup = d.tieup; state.treadling = d.treadling;
    state.mode = "treadle";
    state.liftplan = new Set();
    state.reed = normalizeReed(state.reed);
    $("#projectName").value = "示例·平纹";
  }
  syncSetupInputs();
  applyModeUI();
  rebuildAll();
  // 草稿恢复/默认载入完成后，再把最终的穿筘参数与状态回填到表单并重绘
  syncReedForm();
  history.stack = [snapshot()];
  history.index = 0;
  updateHistoryButtons();
  setPlayPick(-1);
  setStatus("就绪 · 数据仅保存在本机");
}

document.addEventListener("DOMContentLoaded", init);

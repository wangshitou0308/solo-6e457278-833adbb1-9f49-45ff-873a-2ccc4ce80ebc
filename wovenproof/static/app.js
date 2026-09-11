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
  threading: new Set(),
  tieup: new Set(),
  treadling: new Set(),
  warpColors: [],        // 每根经纱颜色（十六进制）
  weftColors: [],        // 每根纬纱颜色
  colorPrint: false,
  rules: { maxFront: 4, maxBack: 4, edge: true, edgeW: 1 },
  cell: 20,
};
const GRIDS = {
  threading: { set: () => state.threading, rows: () => state.S, cols: () => state.E },
  tieup:     { set: () => state.tieup,     rows: () => state.S, cols: () => state.T },
  treadling: { set: () => state.treadling, rows: () => state.P, cols: () => state.T },
};
const GRID_NAMES = { threading: "穿综", tieup: "踏板连结", treadling: "踏序" };
const DEFAULT_WARP = "#c0392b", DEFAULT_WEFT = "#2c3e50";
const PALETTE = ["#2b2b28", "#c0392b", "#e67e22", "#f1c40f", "#27ae60",
                 "#2980b9", "#8e44ad", "#ecf0f1", "#8a5a2b", "#7f8c8d"];

/* 成布缓存与问题缓存 */
let cloth = null;           // Int8Array(E*P)：1 经浮 / 0 纬浮 / -1 无交织
let activeTreadles = null;  // Int8Array(P)：该纬是否踩到有效踏板
let issues = [];            // 分析结果
let issueCells = { threading: new Set(), tieup: new Set(), treadling: new Set(),
                   drawdown: new Set(), endRuler: new Set(), pickRuler: new Set(),
                   shaftRuler: new Set(), treadleRuler: new Set() };

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
    S: state.S, T: state.T, E: state.E, P: state.P, shed: state.shed,
    threading: [...state.threading], tieup: [...state.tieup], treadling: [...state.treadling],
    warpColors: state.warpColors, weftColors: state.weftColors,
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
  state.threading = new Set(d.threading);
  state.tieup = new Set(d.tieup);
  state.treadling = new Set(d.treadling);
  state.warpColors = d.warpColors || [];
  state.weftColors = d.weftColors || [];
  $("#projectName").value = d.name || "未命名项目";
  cancelSelection(true);
  syncSetupInputs();
  rebuildAll();
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
  attachGridEvents(el, kind);
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function dimsOf(kind) {
  if (kind === "threading") return { rows: state.S, cols: state.E };
  if (kind === "tieup") return { rows: state.S, cols: state.T };
  return { rows: state.P, cols: state.T }; // treadling
}

/* 数据行号 -> DOM 行号（踏序/成布：p=0 在最下） */
function domRow(kind, dataRow) {
  return kind === "treadling" ? dimsOf(kind).rows - 1 - dataRow : dataRow;
}
function dataRow(kind, domR) {
  return kind === "treadling" ? dimsOf(kind).rows - 1 - domR : domR;
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
  renderGrid("tieup");
  renderGrid("threading");
  renderGrid("treadling");
  renderColorChips();
  runAnalysis();
  renderDrawdown();
  applyAllRulerMarks();
}

function setBoardVars() {
  const b = $("#board");
  b.style.setProperty("--S", state.S);
  b.style.setProperty("--T", state.T);
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
  ends.innerHTML = rangeHtml(state.E, (i) => rulerNum(i + 1, "end", i));
  treadles.innerHTML = rangeHtml(state.T, (i) => rulerNum(i + 1, "treadle", i));
  shafts.innerHTML = rangeHtml(state.S, (i) => rulerNum(i + 1, "shaft", i));
  // 纬纱尺：p=0（最先织）在最下
  picks.innerHTML = rangeHtml(state.P, (domR) =>
    rulerNum(state.P - domR, "pick", state.P - 1 - domR));
  [ends, treadles, shafts, picks].forEach((r) => {
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
  for (let r = 0; r < clip.rows; r++) {
    const tr = dR + r;
    if (tr >= rows) break;
    for (let c = 0; c < clip.cols; c++) {
      const tc = dc + c;
      if (tc >= cols) break;
      const k = key(tr, tc);
      if (clip.bits[r][c]) target.add(k); else target.delete(k);
    }
  }
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
   规则：
     提综逻辑：被提起的综（tieup 连结 + 本纬踩下）使经纱在上 → 1
     沉综逻辑：标记的综下沉，未沉的综在上 → 取反
     经纱未穿综 / 本纬无有效踏板 → -1 无交织
   ============================================================ */
function computeCloth() {
  const { S, T, E, P } = state;
  cloth = new Int8Array(E * P);
  activeTreadles = new Int8Array(P);

  // 每根经纱所在综（-1 未穿）
  const shaftOfEnd = new Int16Array(E).fill(-1);
  for (const k of state.threading) {
    const [s, e] = parseKey(k);
    if (e < E && s < S) shaftOfEnd[e] = s;
  }
  // 每片综连结了哪些踏板
  const treadlesOfShaft = Array.from({ length: S }, () => []);
  for (const k of state.tieup) {
    const [s, t] = parseKey(k);
    if (s < S && t < T) treadlesOfShaft[s].push(t);
  }
  // 每一纬踩下的踏板
  const treadlesOfPick = Array.from({ length: P }, () => []);
  for (const k of state.treadling) {
    const [p, t] = parseKey(k);
    if (p < P && t < T) treadlesOfPick[p].push(t);
  }

  for (let p = 0; p < P; p++) {
    const pressed = new Set(treadlesOfPick[p]);
    if (pressed.size === 0) {
      cloth.fill(-1, p * E, (p + 1) * E);
      continue;
    }
    activeTreadles[p] = 1;
    // 每片综本纬是否升起
    const shaftUp = new Uint8Array(S);
    for (let s = 0; s < S; s++) {
      let linked = treadlesOfShaft[s].some((t) => pressed.has(t));
      if (state.shed === "sinking") linked = !linked;
      shaftUp[s] = linked ? 1 : 0;
    }
    for (let e = 0; e < E; e++) {
      const s = shaftOfEnd[e];
      cloth[p * E + e] = s < 0 ? -1 : shaftUp[s] ? 1 : 0;
    }
  }
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
                 drawdown: new Set(), endRuler: new Set(), pickRuler: new Set(),
                 shaftRuler: new Set(), treadleRuler: new Set() };

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

  /* ---- 越界引用（数据里有、当前尺寸外的标记） ---- */
  const over = { threading: [], tieup: [], treadling: [] };
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
  if (over.threading.length) issues.push({
    sev: "error", kind: "oor-threading",
    title: `穿综越界引用 ×${over.threading.length}`,
    desc: "存在指向当前综框/经纱数之外的穿综标记（常见于缩小尺寸后）。",
    fix: { label: "清除越界标记", action: "trim", grid: "threading" },
    locs: over.threading.slice(0, 8).map(([s, e]) => ({
      kind: "text", text: `经${e + 1}→综${s + 1}` })),
  });
  if (over.tieup.length) issues.push({
    sev: "error", kind: "oor-tieup",
    title: `连结越界 ×${over.tieup.length}`,
    desc: "踏板连结中存在超出当前综框/踏板数的标记。",
    fix: { label: "清除越界标记", action: "trim", grid: "tieup" },
    locs: over.tieup.slice(0, 8).map(([s, t]) => ({ kind: "text", text: `综${s + 1}×踏${t + 1}` })),
  });
  if (over.treadling.length) issues.push({
    sev: "error", kind: "oor-treadling",
    title: `踏序越界 ×${over.treadling.length}`,
    desc: "踏序中存在超出当前纬纱/踏板数的标记。",
    fix: { label: "清除越界标记", action: "trim", grid: "treadling" },
    locs: over.treadling.slice(0, 8).map(([p, t]) => ({ kind: "text", text: `纬${p + 1}×踏${t + 1}` })),
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

  /* ---- 漏织（整纬无踏板） ---- */
  const deadPicks = [];
  for (let p = 0; p < P; p++) {
    let any = false;
    for (let t = 0; t < T; t++) if (state.treadling.has(key(p, t))) { any = true; break; }
    if (!any) deadPicks.push(p);
  }
  for (const p of deadPicks) {
    issueCells.pickRuler.add(p);
    for (let e = 0; e < E; e++) issueCells.drawdown.add(key(p, e));
  }
  if (deadPicks.length) issues.push({
    sev: "error", kind: "dead-pick",
    title: `漏织纬纱 ×${deadPicks.length}`,
    desc: "这些纬没有踩任何踏板（或所踩踏板无连结），梭口不开。",
    locs: deadPicks.slice(0, 10).map((p) => ({
      kind: "treadling-pick", pick: p, text: `第 ${p + 1} 纬` })),
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
      desc: `最外侧各 ${R.edgeW} 根边经要求逐纬与纬纱交换上下；请检查边部穿综与踏序。`,
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
    if (shaftUsed[s] && !shaftTied[s]) deadShafts.push(s);
    if (!shaftUsed[s]) issueCells.shaftRuler.add(s);
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
    desc: "有经纱穿入但踏板连结里没有连接，踩任何踏板都不会动。",
    locs: deadShafts.map((s) => ({ kind: "tieup-row", s, text: `综框 ${s + 1}` })),
  });

  /* ---- 未使用踏板 / 空踏板 ---- */
  const unusedTreadles = [], emptyTreadles = [];
  for (let t = 0; t < T; t++) {
    if (!treadleUsed[t]) unusedTreadles.push(t);
    if (treadleUsed[t] && !treadleLinked[t]) emptyTreadles.push(t);
    if (!treadleUsed[t] || (treadleUsed[t] && !treadleLinked[t]))
      issueCells.treadleRuler.add(t);
  }
  if (unusedTreadles.length) issues.push({
    sev: "warn", kind: "unused-treadle",
    title: `未使用踏板 ×${unusedTreadles.length}`,
    desc: "踏序中从未踩下这些踏板（踏板号已在尺上标出）。",
    locs: unusedTreadles.map((t) => ({ kind: "treadle", t, text: `踏板 ${t + 1}` })),
  });
  if (emptyTreadles.length) issues.push({
    sev: "error", kind: "empty-treadle",
    title: `空连结踏板被使用 ×${emptyTreadles.length}`,
    desc: "踏序踩了这些踏板，但它们没有连结任何综框，等于空踩。",
    locs: emptyTreadles.map((t) => ({ kind: "treadling-treadle", t, text: `踏板 ${t + 1}` })),
  });

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
    case "treadling-pick": {
      const t = firstTreadleOfPick(loc.pick);
      if (t >= 0) flashGridCell("treadling", loc.pick, t);
      else scrollRuler("picksRuler", "pick", loc.pick);
      break;
    }
    case "shaft":
      flashTieupRow(loc.s);
      scrollRuler("shaftRuler", "shaft", loc.s);
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
    ["picksRuler", "pick", issueCells.pickRuler],
  ];
  $$(".rnum.bad,.rnum.unused").forEach((n) => n.classList.remove("bad", "unused"));
  // end / pick 为错误红；shaft / treadle 未使用为琥珀
  for (const [rulerId, kind, set] of map) {
    for (const idx of set) {
      const n = $(`#${rulerId} .rnum[data-idx="${idx}"]`);
      if (n) n.classList.add(kind === "shaft" || kind === "treadle" ? "unused" : "bad");
    }
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
  if (kind === "treadle") issue = issues.find((i) => i.kind === "empty-treadle" || i.kind === "unused-treadle");
  if (kind === "pick") issue = issues.find((i) => i.kind === "dead-pick");
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
function applyPlayHighlights() {
  $$(".cell.play-shaft,.cell.play-treadle").forEach((n) =>
    n.classList.remove("play-shaft", "play-treadle"));
  if (play.pick < 0) return;
  const p = play.pick;
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
      // 综框尺高亮
      const rn = $(`#shaftRuler .rnum[data-idx="${s}"]`);
      if (rn) rn.style.background = "rgba(217,167,103,.6)";
    }
  }
  $$("#shaftRuler .rnum").forEach((rn) => {
    const s = +rn.dataset.idx;
    let up = false;
    for (const k of state.tieup) {
      const [ss, t] = parseKey(k);
      if (ss === s && pressed.has(t)) up = true;
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
  renderGrid("threading"); renderGrid("tieup"); renderGrid("treadling");
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
    threading: new Set(state.threading),
    tieup: new Set(state.tieup),
    treadling: new Set(state.treadling),
    shed: state.shed,
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
    v.treadling = new Set();
    for (const k of state.treadling) {
      const [p, t] = parseKey(k);
      v.treadling.add(key(state.P - 1 - p, t));
    }
  } else if (kind === "flip") {
    // 换面：交换提综/沉综逻辑；为保持成布等价，同时反转 tieup 连结
    v.shed = state.shed === "rising" ? "sinking" : "rising";
    v.tieup = new Set();
    for (let s = 0; s < state.S; s++)
      for (let t = 0; t < state.T; t++)
        if (!state.tieup.has(key(s, t))) v.tieup.add(key(s, t));
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
  state.shed = d.shed;
  $("#shed").value = d.shed;
  updateShedHint();
  pendingVariant = null;
  $("#variantActions").hidden = true;
  $("#variantPreview").innerHTML =
    '<p class="muted">已采用变体。可继续选择新的变体，或用撤销回到原版本。</p>';
  cancelSelection(true);
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
  const { S, T, E, P } = state;
  const arr = new Int8Array(E * P);
  const shaftOfEnd = new Int16Array(E).fill(-1);
  for (const k of d.threading) { const [s, e] = parseKey(k); if (e < E && s < S) shaftOfEnd[e] = s; }
  const upShaft = Array.from({ length: P }, () => new Uint8Array(S));
  for (let p = 0; p < P; p++) {
    const pressed = new Set();
    for (let t = 0; t < T; t++) if (d.treadling.has(key(p, t))) pressed.add(t);
    for (let s = 0; s < S; s++) {
      let linked = false;
      for (let t = 0; t < T; t++) if (pressed.has(t) && d.tieup.has(key(s, t))) linked = true;
      if (d.shed === "sinking") linked = !linked;
      upShaft[p][s] = linked ? 1 : 0;
    }
    for (let e = 0; e < E; e++) {
      const s = shaftOfEnd[e];
      arr[p * E + e] = s < 0 ? -1 : (upShaft[p][s] ? 1 : 0);
    }
  }
  return arr;
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
   WIF 导入 / 导出
   ============================================================ */
function exportWIF() {
  const { S, T, E, P } = state;
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
  lines.push("TIEUP=yes");
  lines.push("TREADLING=yes");
  lines.push("COLOR PALETTE=yes");
  lines.push("[TEXT]");
  lines.push("Title=" + ($("#projectName").value || "未命名"));
  lines.push("[WEAVING]");
  lines.push("Shed=" + (state.shed === "rising" ? "Rising" : "Sinking"));
  lines.push("Treadling=Single Tieup");
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
  const blob = new Blob([lines.join("\r\n")], { type: "text/plain;charset=utf-8" });
  downloadBlob(blob, ($("#projectName").value || "wovenproof") + ".wif");
  toast("已导出 WIF");
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
  const threading = new Set(), tieup = new Set(), treadling = new Set();

  for (const keyStr of Object.keys(th)) {
    const shaft = parseInt(keyStr, 10);
    if (!Number.isFinite(shaft)) continue;
    S = Math.max(S, shaft);
    for (const e of parseList(th[keyStr])) {
      if (Number.isFinite(e)) threading.add(key(shaft - 1, e - 1));
    }
  }
  const useLift = Object.keys(lp).length > 0 && Object.keys(tr).length === 0;
  const treadleMap = new Map(); // 踏板组合签名 -> 踏板号
  if (useLift) {
    // LIFTPLAN：键=纬号，值=提升的综列表；按提升组合合成 tieup + treadling
    T = 0;
    for (const keyStr of Object.keys(lp)) {
      const p = parseInt(keyStr, 10);
      if (!Number.isFinite(p)) continue;
      const shafts = parseList(lp[keyStr]).sort((a, b) => a - b);
      const sig = shafts.join(",");
      let tnum = treadleMap.get(sig);
      if (tnum === undefined) {
        T++;
        tnum = T;
        treadleMap.set(sig, tnum);
        for (const sh of shafts) {
          tieup.add(key(sh - 1, tnum - 1));
          S = Math.max(S, sh);
        }
      }
      treadling.add(key(p - 1, tnum - 1));
    }
  } else {
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
  }
  if (!E || !P || !S || !T)
    throw new Error("WIF 缺少必要尺寸（WARP.THREADS / WEFT.THREADS / 穿综 / 踏板）");

  state.S = S; state.T = T; state.E = E; state.P = P;
  state.threading = threading; state.tieup = tieup; state.treadling = treadling;
  state.shed = String(weaving.shed || "").toLowerCase().startsWith("sink") ? "sinking" : "rising";
  state.warpColors = parseWIFColors(warp, E);
  state.weftColors = parseWIFColors(weft, P);
  const title = get("text").title;
  if (title) $("#projectName").value = title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
  syncSetupInputs();
  rebuildAll();
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
  });
  inp.addEventListener("change", () => { inp.remove(); scheduleSave(); });
  inp.click();
}
function applyAllWarp() {
  const v = $("#warpColor").value;
  for (let e = 0; e < state.E; e++) state.warpColors[e] = v;
  renderColorChips(); if (state.colorPrint) renderDrawdown(); scheduleSave();
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
  const px = clamp(Math.min(14, 760 / Math.max(E, P + S + 2)), 3, 14);
  const dateStr = new Date().toLocaleDateString("zh-CN");
  let html = `<div class="print-sheet">
    <div class="print-title">${escapeHtml($("#projectName").value)} · 组织图</div>
    <div class="print-meta">综框 ${S} · 踏板 ${T} · 经纱 ${E} · 纬纱 ${P} ·
      ${state.shed === "rising" ? "提综" : "沉综"} · 打印日期 ${dateStr}</div>`;

  html += printBlock("穿综", E, S, px, (x, y) => state.threading.has(key(y, x)),
                     { topNums: E, leftNums: S, periodCols: detectPeriod(buildThreadRowSig()) });
  html += printBlock("踏板连结", T, S, px, (x, y) => state.tieup.has(key(y, x)),
                     { topNums: T, leftNums: S });
  html += printBlock("踏序", T, P, px, (x, y) => state.treadling.has(key(P - 1 - y, x)),
                     { topNums: T, leftNums: P, leftReverse: true });

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
  // 重复边界：经向穿综周期 + 纬向踏序周期
  const periodE = detectPeriod(buildThreadRowSig());
  const periodP = detectPeriod(buildPickSig());
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
    S: state.S, T: state.T, E: state.E, P: state.P, shed: state.shed,
    threading: [...state.threading], tieup: [...state.tieup], treadling: [...state.treadling],
    warpColors: state.warpColors, weftColors: state.weftColors,
    rules: state.rules,
  };
}
function loadDraft(d, name) {
  state.S = d.S; state.T = d.T; state.E = d.E; state.P = d.P;
  state.shed = d.shed || "rising";
  state.threading = new Set(d.threading || []);
  state.tieup = new Set(d.tieup || []);
  state.treadling = new Set(d.treadling || []);
  state.warpColors = d.warpColors || [];
  state.weftColors = d.weftColors || [];
  if (d.rules) state.rules = Object.assign(state.rules, d.rules);
  if (name) $("#projectName").value = name;
  syncSetupInputs();
  rebuildAll();
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
    bEl.addEventListener("click", btn.action);
    foot.appendChild(bEl);
  }
  $("#modalBox").classList.toggle("wide", !!wide);
  $("#modalMask").hidden = false;
}
function closeModal() { $("#modalMask").hidden = true; }
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
      state.warpColors = []; state.weftColors = [];
      state.shed = "rising";
      $("#projectName").value = "示例·" + name.split("（")[0];
      syncSetupInputs();
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
  $("#shedHint").textContent = state.shed === "rising"
    ? "提综逻辑：连结标记＝该综上升，正面见经（黑格）"
    : "沉综逻辑：连结标记＝该综下沉，正面见纬（白格）";
}
function onResizeField(which, val) {
  val = clamp(val | 0, which === "shafts" ? 2 : 1, 600);
  const old = state[which === "shafts" ? "S" : which === "treadles" ? "T"
                      : which === "ends" ? "E" : "P"];
  if (val === old) return;
  const map = { shafts: "S", treadles: "T", ends: "E", picks: "P" };
  state[map[which]] = val;
  stopPlay(); play.pick = -1;
  rebuildAll();
  pushHistory();
  const names = { shafts: "综框", treadles: "踏板", ends: "经纱", picks: "纬纱" };
  const orphaned = hasOutOfRange(which);
  if (orphaned) toast(`已缩小${names[which]}数，旧标记被标为越界，可在问题列表一键清除`, 3200);
}
function hasOutOfRange(which) {
  if (which === "shafts")
    return [...state.threading].some((k) => parseKey(k)[0] >= state.S) ||
           [...state.tieup].some((k) => parseKey(k)[0] >= state.S);
  if (which === "treadles")
    return [...state.tieup].some((k) => parseKey(k)[1] >= state.T) ||
           [...state.treadling].some((k) => parseKey(k)[1] >= state.T);
  if (which === "ends")
    return [...state.threading].some((k) => parseKey(k)[1] >= state.E);
  return [...state.treadling].some((k) => parseKey(k)[0] >= state.P);
}
function clearAll() {
  if (!confirm("清空穿综、踏板连结、踏序三个输入网格？（可撤销）")) return;
  state.threading.clear();
  state.tieup.clear();
  state.treadling.clear();
  stopPlay(); play.pick = -1;
  cancelSelection(true);
  afterEdit();
  pushHistory();
  toast("已清空");
}

/* ============================================================
   初始化
   ============================================================ */
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
      pushHistory();
      toast(`已导入 WIF：${info.E}经×${info.P}纬，${info.S}综${info.T}踏` +
            (info.liftplan ? "（由 LIFTPLAN 转换）" : ""), 3000);
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

  // 恢复草稿或载入默认示例
  let restored = false;
  try {
    const saved = localStorage.getItem(LS_KEY);
    if (saved) {
      const d = JSON.parse(saved);
      if (d && d.threading) {
        state.S = d.S; state.T = d.T; state.E = d.E; state.P = d.P;
        state.shed = d.shed || "rising";
        state.threading = new Set(d.threading);
        state.tieup = new Set(d.tieup);
        state.treadling = new Set(d.treadling);
        state.warpColors = d.warpColors || [];
        state.weftColors = d.weftColors || [];
        $("#projectName").value = d.name || "未命名项目";
        restored = true;
      }
    }
  } catch (e) {}
  if (!restored) {
    const d = EXAMPLES["平纹（2综2踏）"]();
    state.S = d.S; state.T = d.T; state.E = d.E; state.P = d.P;
    state.threading = d.threading; state.tieup = d.tieup; state.treadling = d.treadling;
    $("#projectName").value = "示例·平纹";
  }
  syncSetupInputs();
  rebuildAll();
  history.stack = [snapshot()];
  history.index = 0;
  updateHistoryButtons();
  setPlayPick(-1);
  setStatus("就绪 · 数据仅保存在本机");
}

document.addEventListener("DOMContentLoaded", init);

/* 无头测试：给穿筘模块提供最小 DOM/state 桩，验证计算、校验与搜索 */
"use strict";
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "static", "app.js"), "utf8");
const start = src.indexOf("/* ============================================================\n   穿筘计划");
const end = src.indexOf("/* 组织图经纱相关变化");
if (start < 0 || end < 0) { console.error("section not found", start, end); process.exit(1); }
let reedSrc = src.slice(start, end);

// 去掉对 DOM 初始化绑定段（initReed 不在被测范围）
reedSrc = reedSrc.replace(/function initReed\(\)[\s\S]*?\n\}\n\/\*[\s\S]*$/, "");

// ---- 桩 ----
const state = {
  S: 4, T: 4, E: 24, P: 24,
  threading: new Set(),
  warpColors: [],
  reed: null,
};
for (let e = 0; e < 24; e++) state.threading.add((e % 4) + ":" + e);

const DEFAULT_WARP = "#c0392b";
const key = (a, b) => a + ":" + b;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const warpColorAt = (e) => state.warpColors[e] || DEFAULT_WARP;
const escapeHtml = (s) => String(s);
const fmtTime = (t) => "time";
function detectPeriod(a) {
  outer: for (let d = 1; d <= Math.floor(a.length / 2); d++) {
    if (a.length % d !== 0 && a.length < d * 2) continue;
    for (let i = d; i < a.length; i++) if (a[i] !== a[i % d]) continue outer;
    return d;
  }
  return a.length;
}
const $ = () => null;

const factory = new Function("state", "key", "clamp", "warpColorAt", "escapeHtml",
  "fmtTime", "detectPeriod", "$", "DEFAULT_WARP",
  reedSrc + "\n;return { defaultReed, computeReedLayout, searchReedCandidates, parseReedSeq, parseReedSeqText: parseReedSeq };");
const M = factory(state, key, clamp, warpColorAt, escapeHtml, fmtTime, detectPeriod, $, DEFAULT_WARP);
const { computeReedLayout, searchReedCandidates, parseReedSeq } = M;
const defaultReed = M.defaultReed;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, extra !== undefined ? JSON.stringify(extra) : ""); }
}
function kinds(L) { return L.issues.map((i) => i.kind); }

/* ---- 用例 1：平纹 24 经，10 齿/cm，幅宽 2.4cm=24 齿，2-2 序列，无错 ---- */
state.E = 24;
state.reed = defaultReed();
Object.assign(state.reed, { unit: "cm", reedNo: 10, targetDensity: 10, width: 2.4,
  dentsManual: 0, maxPerDent: 4, seq: "2-2", edgeOn: false });
let L = computeReedLayout();
check("24齿/2-2：占用12齿", L.usedDents === 12, { used: L.usedDents });
check("24齿/2-2：实穿24根", L.placedEnds === 24, L.placedEnds);
check("24齿/2-2：实际幅宽1.2cm", Math.abs(L.actualWidth - 1.2) < 1e-9, L.actualWidth);
check("24齿/2-2：整体经密20根/cm", Math.abs(L.overallDensity - 20) < 1e-9, L.overallDensity);
check("24齿/2-2：无错误", !L.issues.some((i) => i.sev === "error"), kinds(L));
check("24齿/2-2：余12空齿提示", L.tailEmpty === 12, L.tailEmpty);

/* ---- 用例 2：筘齿数不足（12齿需求 > 10 齿） ---- */
state.reed.dentsManual = 10;
L = computeReedLayout();
check("10齿不够：报 reed-dents-over", kinds(L).includes("reed-dents-over"), kinds(L));
state.reed.dentsManual = 0;

/* ---- 用例 3：总经数不符（手工齿数 14，2-2 铺满28>24 → 截断到24根末齿截半）---- */
state.reed.dentsManual = 14;
L = computeReedLayout();
// need=24，12 齿恰好铺满，之后不再排 -> placed=24，无问题；尾2齿空
check("14齿/2-2：恰好铺12齿，无总经错", L.placedEnds === 24 && !kinds(L).includes("reed-total"),
  { placed: L.placedEnds, issues: kinds(L) });
state.reed.dentsManual = 0;

/* ---- 用例 4：2-3 序列对 24 根：均入2.5，10齿=25>24，铺到9齿=22后第10齿需3根但只剩2 → 末齿截半 ---- */
state.reed.seq = "2-3";
L = computeReedLayout();
check("2-3铺24根：恰好 10 齿（2+3循环到24）", L.placedEnds === 24, { placed: L.placedEnds });
// 末齿 take=2（截半），检查末齿
const lastD = L.dents[L.dents.length - 1];
check("2-3末齿截入2根", lastD.v === 2, lastD);

/* ---- 用例 5：内部空齿 2-0-2 ---- */
state.reed.seq = "2-0-2";
state.reed.dentsManual = 12;
L = computeReedLayout();
check("2-0-2：段内空齿报 reed-empty",
  kinds(L).filter((k) => k === "reed-empty").length >= 1, kinds(L));
state.reed.dentsManual = 0;
state.reed.seq = "2-2";

/* ---- 用例 6：超限齿 5 根，上限 4 ---- */
state.reed.seq = "5";
L = computeReedLayout();
check("序列5/上限4：报 reed-over-body", kinds(L).includes("reed-over-body"), kinds(L));
state.reed.seq = "2-2";

/* ---- 用例 7：边经规则 每侧4根 2-2，地经16根 ---- */
state.reed.edgeOn = true;
state.reed.edgeEnds = 4;
state.reed.edgeMax = 4;
state.reed.edgeSeq = "2-2";
state.reed.seq = "2-2";
L = computeReedLayout();
check("边经：左2齿4根", L.segDensity.left.dents === 2 && L.segDensity.left.ends === 4, L.segDensity.left);
check("边经：地经8齿16根", L.segDensity.body.dents === 8 && L.segDensity.body.ends === 16, L.segDensity.body);
check("边经：右2齿4根", L.segDensity.right.dents === 2 && L.segDensity.right.ends === 4, L.segDensity.right);
check("边经：总12齿24根无错误", L.usedDents === 12 && L.placedEnds === 24 &&
  !L.issues.some((i) => i.sev === "error"), { used: L.usedDents, placed: L.placedEnds, i: kinds(L) });
check("边经：首4根齿号0-1，末4根齿号10-11",
  L.endDent[0] === 0 && L.endDent[3] === 1 && L.endDent[20] === 10 && L.endDent[23] === 11,
  { d0: L.endDent[0], d20: L.endDent[20], d23: L.endDent[23] });

/* ---- 用例 8：边经超限 ---- */
state.reed.edgeSeq = "5";
L = computeReedLayout();
check("边经序列5/上限4：报 reed-over-edge", kinds(L).includes("reed-over-edge"), kinds(L));
state.reed.edgeSeq = "2-2";

/* ---- 用例 9：边经总根数超总经 ---- */
state.reed.edgeEnds = 20;
L = computeReedLayout();
check("每侧20根>24/2：报 reed-edge-total", kinds(L).includes("reed-edge-total"), kinds(L));
state.reed.edgeEnds = 4;

/* ---- 用例 10：色序错位（颜色周期4，序列3-3：齿跨色界）---- */
state.reed.edgeOn = false;
state.warpColors = [];
for (let e = 0; e < 24; e++) state.warpColors.push(e % 4 < 2 ? "#a00" : "#0a0");
state.reed.seq = "3-3";
L = computeReedLayout();
check("色周期4 + 3-3：报 reed-color 警告", kinds(L).includes("reed-color"), kinds(L));
state.reed.seq = "2-2";
L = computeReedLayout();
check("色周期4 + 2-2：不报 reed-color", !kinds(L).includes("reed-color"), kinds(L));
state.warpColors = [];

/* ---- 用例 11：未穿综 ---- */
const savedThreading = new Set(state.threading);
state.threading = new Set();
L = computeReedLayout();
check("全未穿综：报 reed-unthreaded 提示", kinds(L).includes("reed-unthreaded"), kinds(L));
state.threading = savedThreading;

/* ---- 用例 12：英寸单位（20 齿/英寸 × 1 英寸 = 20 齿；密度按根/英寸） ---- */
state.reed.edgeOn = false;
state.reed.unit = "in";
state.reed.reedNo = 20;      // 20齿/英寸
state.reed.width = 1;        // 1 英寸 → 20 齿
state.reed.targetDensity = 40;
state.reed.dentsManual = 0;
L = computeReedLayout();
check("英寸：可用齿=20×1=20", L.available === 20, L.available);
// 2-2 穿24根需12齿，实际幅宽 12/20=0.6 英寸，密度 24/0.6=40 根/英寸
check("英寸：实际幅宽0.6英寸", Math.abs(L.actualWidth - 0.6) < 1e-9, L.actualWidth);
check("英寸：整体经密40根/英寸", Math.abs(L.overallDensity - 40) < 1e-9, L.overallDensity);
state.reed.unit = "cm"; state.reed.reedNo = 10; state.reed.width = 2.4; state.reed.targetDensity = 10;

/* ---- 用例 13：搜索候选 ---- */
state.E = 40;
state.reed.edgeOn = false;
state.reed.reedNo = 10; state.reed.width = 2; // 20 齿
state.reed.targetDensity = 20; // 目标40根/2cm
state.reed.maxPerDent = 4;
state.reed.seq = "2-2";
const r = searchReedCandidates();
check("搜索：有候选", r.ok && r.cands.length > 0, r.error);
if (r.ok) {
  const c0 = r.cands[0];
  check("搜索：首选恰好铺满40根", c0.seq.reduce((a, b) => a + b, 0) > 0, c0);
  // 2-2：均入2，20齿=40根，密度20，误差0
  const twoTwo = r.cands.find((c) => c.seq.join("-") === "2-2");
  check("搜索：含 2-2 且占20齿", twoTwo && twoTwo.totalDents === 20, twoTwo);
  check("搜索：2-2 经密误差0%", twoTwo && Math.abs(twoTwo.densErr) < 1e-9, twoTwo && twoTwo.densErr);
  check("排序：首个误差绝对值最小",
    Math.abs(r.cands[0].densErr) <= Math.abs(r.cands[r.cands.length - 1].densErr));
}

/* ---- 用例 14：序列解析 ---- */
check("解析 2-2-3", JSON.stringify(parseReedSeq("2-2-3").seq) === "[2,2,3]");
check("解析 2,2,3、中文逗号", JSON.stringify(parseReedSeq("2，2、3").seq) === "[2,2,3]");
check("解析非法片段", parseReedSeq("2-x-3").ok === false);
check("解析含0", JSON.stringify(parseReedSeq("2-0").seq) === "[2,0]");

/* ---- 用例 15：全0序列报错且不卡死 ---- */
state.reed.seq = "0-0";
L = computeReedLayout();
check("全0序列：报 reed-badseq", kinds(L).includes("reed-badseq"), kinds(L));
check("全0序列：不死循环（齿为0）", L.usedDents === 0, L.usedDents);

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);

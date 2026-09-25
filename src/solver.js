// src/solver.js —— 两阶段求解（技术文档 §4）
//
//   阶段一：计数最优 (CIP) —— 分支定界 + 支配剪枝 + 目标截断
//   阶段二：具体化 + 路径可行性 —— 确定性 DFS + (体力,压力) Pareto 支配剪枝
//           + 【R3】精确饱和模拟 + 无夹取证书判定
//
// 松弛的 sound 修正（§3.10，C-9 已判定为必需）：i=1..8 只累加**正增量**（UB_i），
// 压力项用线性净值 ⇒ v_relax ≤ v_true（admissible）。
//
// 终止性/精确性（§4.3）：阶段一按 v_relax 非降序推进，一旦某候选的精确目标等于
// 全局下界 z，该解即全问题最优；否则枚举完所有 v_relax < best 的候选后 best 亦已证最优。
// 预算耗尽的出口是 status='undetermined'（E10），并给出已认证的最优性间隙，绝不静默。

import {
  ATTRS, IDX, S_MAX, S_MIN, S_STAMINA_MIN, S_STRESS_MAX, deltaS, restWeight, CLUB_REST_DAYS,
} from './spec.js';
import { advance, pathFeasible, simulate, objectiveS } from './verify.js';
import { buildProblem } from './model.js';
import { mondayOf } from './calendar.js';

// 全局视野（一直解到毕业，1063 天 / 152 个平时块 + 152 个休日槽）下的统一预算。
// 输入已经足够好时（目标可达）求解只需几毫秒；预算只在难以证明最优时兜底（E10）。
const DEFAULT_BUDGET = 400_000;
const REALIZE_BUDGET = 120_000;
const DEFAULT_TIME_LIMIT = 1500;
const MEMO_CAP = 80_000;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ================================================================ 上下文与界
function pad2(n, v) { return Array.from({ length: n }, () => v); }

export function buildContext(problem) {
  const commands = problem.commands;
  const n = commands.length;
  const mm = problem.counts.M.slice();
  const K = mm.length;
  const Nfree = mm.map((m) => problem.counts.Nfree[m]);
  const Hfree = problem.counts.Hfree;

  const base = problem.s0.map((v, i) => v + problem.sFix[i]);
  const L = problem.targetsS.L.slice();
  const U9 = problem.targetsS.U9;
  const E9 = base[IDX.STRESS] - U9;
  const D = L.map((l, i) => l - base[i]);

  // 贡献表：i = 0..7「只累加正增量」（§3.10 UB_i）；i = 8 取线性净值
  const posOrSigned = (cmd, units, i) => (
    i === IDX.STRESS ? cmd.scale * units * cmd.T[i] : cmd.scale * units * Math.max(0, cmd.T[i])
  );

  const cw = [];   // [k][a][i]
  for (let k = 0; k < K; k += 1) {
    const m = mm[k];
    cw.push(commands.map((cmd) => ATTRS.map((_, i) => posOrSigned(cmd, m, i))));
  }
  const cr = commands.map((cmd) => ATTRS.map((_, i) => posOrSigned(cmd, restWeight(cmd), i)));

  // ---- 独立松弛：逐单位极值 + 后缀和
  const wMax = [];
  const wMin9 = [];
  for (let k = 0; k < K; k += 1) {
    const mx = new Array(9).fill(-Infinity);
    let mn9 = Infinity;
    for (let a = 0; a < n; a += 1) {
      for (let i = 0; i < 8; i += 1) if (cw[k][a][i] > mx[i]) mx[i] = cw[k][a][i];
      if (cw[k][a][8] < mn9) mn9 = cw[k][a][8];
    }
    wMax.push(mx);
    wMin9.push(mn9);
  }
  wMax.push(new Array(9).fill(0));   // 哨兵（k === K）
  wMin9.push(0);

  const rMax = new Array(9).fill(-Infinity);
  let rMin9 = Infinity;
  for (let a = 0; a < n; a += 1) {
    for (let i = 0; i < 8; i += 1) if (cr[a][i] > rMax[i]) rMax[i] = cr[a][i];
    if (cr[a][8] < rMin9) rMin9 = cr[a][8];
  }

  const sufWMax = new Array(K + 2).fill(null).map(() => new Array(9).fill(0));
  const sufWMin9 = new Array(K + 2).fill(0);
  for (let k = K - 1; k >= 0; k -= 1) {
    sufWMax[k] = sufWMax[k + 1].map((v, i) => v + Nfree[k] * wMax[k][i]);
    sufWMin9[k] = sufWMin9[k + 1] + Nfree[k] * wMin9[k];
  }

  // ---- 子集（单元素 / 二元）联合界
  const subsets = [];
  for (let i = 0; i < 8; i += 1) subsets.push([i]);
  for (let i = 0; i < 8; i += 1) for (let j = i + 1; j < 8; j += 1) subsets.push([i, j]);

  const subWeekA = [];
  const subWeekG = [];
  const subRestA = [];
  const subRestG = [];
  for (const S of subsets) {
    const wa = [];
    const wg = [];
    for (let k = 0; k < K; k += 1) {
      let ba = -Infinity;
      let bg = -Infinity;
      for (let a = 0; a < n; a += 1) {
        let sa = 0;
        for (const i of S) sa += cw[k][a][i];
        if (sa > ba) ba = sa;
        if (sa - cw[k][a][8] > bg) bg = sa - cw[k][a][8];
      }
      wa.push(ba);
      wg.push(bg);
    }
    wa.push(0);
    wg.push(0);
    let ra = -Infinity;
    let rg = -Infinity;
    for (let a = 0; a < n; a += 1) {
      let sa = 0;
      for (const i of S) sa += cr[a][i];
      if (sa > ra) ra = sa;
      if (sa - cr[a][8] > rg) rg = sa - cr[a][8];
    }
    subWeekA.push(wa);
    subWeekG.push(wg);
    subRestA.push(ra);
    subRestG.push(rg);
  }
  const subSufA = subsets.map((_, s) => {
    const out = new Array(K + 2).fill(0);
    for (let k = K - 1; k >= 0; k -= 1) out[k] = out[k + 1] + Nfree[k] * subWeekA[s][k];
    return out;
  });
  const subSufG = subsets.map((_, s) => {
    const out = new Array(K + 2).fill(0);
    for (let k = K - 1; k >= 0; k -= 1) out[k] = out[k + 1] + Nfree[k] * subWeekG[s][k];
    return out;
  });
  const subD = subsets.map((S) => S.reduce((acc, i) => acc + D[i], 0));

  // ---- 时间线 / 强制点
  const weekSize = new Map();
  for (const wk of problem.weeks) weekSize.set(wk.weekStart, wk.m);
  const forcedWeekCmd = new Map();
  for (const f of problem.forcedWeeks) forcedWeekCmd.set(f.weekStart, problem.cmdById.get(f.command));
  const forcedRestCmd = new Map();
  for (const f of problem.forcedRest) forcedRestCmd.set(f.date, problem.cmdById.get(f.command));

  const mIndex = new Map();
  mm.forEach((m, k) => mIndex.set(m, k));

  // ---- Lagrangian 加权界：0 ≤ λ ≤ 1 时 Σv ≥ Σλ_i D_i − λ9 U9 − Σ_单位 max_a(Σλ_i c_a[i] − λ9 c_a[8])
  const lamCtx = { D, U9, Nfree, Hfree, cw, cr, mm, K, n };
  const lam = optimizeLambda(lamCtx);
  const lamMaxW = [];
  const lamMaxR = [];
  let lamSumD = 0;
  for (let i = 0; i < 8; i += 1) lamSumD += lam[i] * D[i];
  const lamU9 = lam[8] * U9;
  let maxR = -Infinity;
  for (let a = 0; a < n; a += 1) {
    let v = 0;
    for (let i = 0; i < 8; i += 1) v += lam[i] * cr[a][i];
    v -= lam[8] * cr[a][8];
    if (v > maxR) maxR = v;
  }
  lamMaxR.push(maxR);
  for (let k = 0; k < K; k += 1) {
    let mx = -Infinity;
    for (let a = 0; a < n; a += 1) {
      let v = 0;
      for (let i = 0; i < 8; i += 1) v += lam[i] * cw[k][a][i];
      v -= lam[8] * cw[k][a][8];
      if (v > mx) mx = v;
    }
    lamMaxW.push(mx);
  }
  lamMaxW.push(0);
  const lamSufW = new Array(K + 2).fill(0);
  for (let k = K - 1; k >= 0; k -= 1) lamSufW[k] = lamSufW[k + 1] + Nfree[k] * lamMaxW[k];

  return {
    problem, commands, n, mm, K, Nfree, Hfree, mIndex,
    lam, lamMaxW, lamMaxR, lamSufW, lamSumD, lamU9,
    base, L, D, U9, E9,
    cw, cr, wMax, wMin9, rMax, rMin9, sufWMax, sufWMin9,
    subsets, subWeekA, subWeekG, subRestA, subRestG, subSufA, subSufG, subD,
    days: problem.calendar.days,
    weekSize, forcedWeekCmd, forcedRestCmd,
  };
}

/** 部分解的下界（admissible）：独立松弛 + 子集联合界 + 压力耦合界 */
export function lowerBound(ctx, k, remWk, remR, accP, acc9) {
  const {
    D, E9, U9, wMax, wMin9, rMax, rMin9, sufWMax, sufWMin9,
    subsets, subWeekA, subWeekG, subRestA, subRestG, subSufA, subSufG, subD,
  } = ctx;

  let best = 0;
  let indep = 0;
  for (let i = 0; i < 8; i += 1) {
    const remMax = remWk * wMax[k][i] + sufWMax[k + 1][i] + remR * rMax[i];
    const s = D[i] - accP[i] - remMax;
    if (s > 0) indep += s;
  }
  const remMin9 = remWk * wMin9[k] + sufWMin9[k + 1] + remR * rMin9;
  const s9 = E9 + acc9 + remMin9;
  if (s9 > 0) indep += s9;
  if (indep > best) best = indep;

  for (let s = 0; s < subsets.length; s += 1) {
    let accS = 0;
    for (const i of subsets[s]) accS += accP[i];
    const remA = remWk * subWeekA[s][k] + subSufA[s][k + 1] + remR * subRestA[s];
    const v1 = subD[s] - accS - remA;
    if (v1 > best) best = v1;
    const remG = remWk * subWeekG[s][k] + subSufG[s][k + 1] + remR * subRestG[s];
    const v2 = subD[s] - U9 - (accS - acc9) - remG;
    if (v2 > best) best = v2;
  }

  // Lagrangian 加权界（λ 在根节点一次性优化，0 ≤ λ ≤ 1 ⇒ admissible）
  if (ctx.lam) {
    const lam = ctx.lam;
    let accLam = 0;
    for (let i = 0; i < 8; i += 1) accLam += lam[i] * accP[i];
    accLam -= lam[8] * acc9;
    const remLam = remWk * ctx.lamMaxW[k] + ctx.lamSufW[k + 1] + remR * ctx.lamMaxR[0];
    const v3 = ctx.lamSumD - ctx.lamU9 - accLam - remLam;
    if (v3 > best) best = v3;
  }
  return best;
}

/** 坐标上升优化 Lagrangian 权重（根节点一次性；只影响剪枝强度，不影响正确性） */
function optimizeLambda(lamCtx) {
  const { D, U9, Nfree, Hfree, cw, cr, K, n } = lamCtx;
  const lam = new Array(9).fill(1);
  const value = (L) => {
    let s = 0;
    for (let i = 0; i < 8; i += 1) s += L[i] * D[i];
    s -= L[8] * U9;
    let part = 0;
    for (let k = 0; k < K; k += 1) {
      let mx = -Infinity;
      for (let a = 0; a < n; a += 1) {
        let v = 0;
        for (let i = 0; i < 8; i += 1) v += L[i] * cw[k][a][i];
        v -= L[8] * cw[k][a][8];
        if (v > mx) mx = v;
      }
      part += Nfree[k] * mx;
    }
    let mxr = -Infinity;
    for (let a = 0; a < n; a += 1) {
      let v = 0;
      for (let i = 0; i < 8; i += 1) v += L[i] * cr[a][i];
      v -= L[8] * cr[a][8];
      if (v > mxr) mxr = v;
    }
    part += Hfree * mxr;
    return s - part;
  };
  const grid = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
  let cur = value(lam);
  for (let round = 0; round < 6; round += 1) {
    let improved = false;
    for (let i = 0; i < 9; i += 1) {
      const prev = lam[i];
      let bestV = cur;
      let bestX = prev;
      for (const x of grid) {
        lam[i] = x;
        const v = value(lam);
        if (v > bestV + 1e-9) { bestV = v; bestX = x; }
      }
      lam[i] = bestX;
      if (bestX !== prev) improved = true;
      cur = bestV;
    }
    if (!improved) break;
  }
  return lam;
}

/** 计数向量的松弛目标值 v_relax */
export function relaxedObjectiveOf(ctx, counts) {
  const X = ctx.base.slice();
  for (let k = 0; k < ctx.K; k += 1) {
    for (let a = 0; a < ctx.n; a += 1) {
      const v = counts.x[k][a];
      if (!v) continue;
      const t = ctx.cw[k][a];
      for (let i = 0; i < 9; i += 1) X[i] += v * t[i];
    }
  }
  for (let a = 0; a < ctx.n; a += 1) {
    const v = counts.y[a];
    if (!v) continue;
    const t = ctx.cr[a];
    for (let i = 0; i < 9; i += 1) X[i] += v * t[i];
  }
  let total = 0;
  for (let i = 0; i < 8; i += 1) total += Math.max(0, ctx.L[i] - X[i]);
  total += Math.max(0, X[IDX.STRESS] - ctx.U9);
  return total;
}

// ================================================================ 阶段一：计数枚举
export function encodeCounts(x, y) {
  let s = '';
  for (let k = 0; k < x.length; k += 1) s += `${x[k].join(',')};`;
  return `${s}|${y.join(',')}`;
}

/**
 * 枚举所有 v_relax ≤ theta 的计数向量。
 * 遍历顺序固定（m 升序 → 指令权威索引升序；休日槽按指令索引升序）⇒ 取解确定（D13）。
 */
export function enumerateCounts(ctx, thetaOrFn, onCandidate, budget) {
  const thetaOf = typeof thetaOrFn === 'function' ? thetaOrFn : () => thetaOrFn;
  const { K, n, Nfree, Hfree } = ctx;
  const remW = Nfree.slice();
  const x = Array.from({ length: K }, () => new Array(n).fill(0));
  const y = new Array(n).fill(0);
  let remR = Hfree;
  const accP = new Array(8).fill(0);
  let acc9 = 0;
  let nodes = 0;
  let aborted = false;
  let stopped = false;

  function dfsRest(a) {
    if (aborted || stopped) return;
    nodes += 1;
    if (nodes > budget) { aborted = true; return; }
    if (lowerBound(ctx, K, 0, remR, accP, acc9) > thetaOf()) return;
    if (a === n) {
      if (onCandidate({ x: x.map((r) => r.slice()), y: y.slice() }) === false) stopped = true;
      return;
    }
    if (a === n - 1) {
      const v = remR;
      const t = ctx.cr[a];
      y[a] = v; remR = 0;
      for (let i = 0; i < 8; i += 1) accP[i] += v * t[i];
      acc9 += v * t[8];
      dfsRest(a + 1);
      for (let i = 0; i < 8; i += 1) accP[i] -= v * t[i];
      acc9 -= v * t[8];
      remR = v; y[a] = 0;
      return;
    }
    for (let v = 0; v <= remR; v += 1) {
      const t = ctx.cr[a];
      y[a] = v; remR -= v;
      for (let i = 0; i < 8; i += 1) accP[i] += v * t[i];
      acc9 += v * t[8];
      dfsRest(a + 1);
      for (let i = 0; i < 8; i += 1) accP[i] -= v * t[i];
      acc9 -= v * t[8];
      remR += v; y[a] = 0;
      if (aborted || stopped) return;
    }
  }

  function dfsWeek(k, a) {
    if (aborted || stopped) return;
    nodes += 1;
    if (nodes > budget) { aborted = true; return; }
    const remWk = k < K ? remW[k] : 0;
    if (lowerBound(ctx, k, remWk, remR, accP, acc9) > thetaOf()) return;
    if (k === K) { dfsRest(0); return; }

    if (a === n - 1) {
      const v = remW[k];
      const t = ctx.cw[k][a];
      x[k][a] = v; remW[k] = 0;
      for (let i = 0; i < 8; i += 1) accP[i] += v * t[i];
      acc9 += v * t[8];
      dfsWeek(k + 1, 0);
      for (let i = 0; i < 8; i += 1) accP[i] -= v * t[i];
      acc9 -= v * t[8];
      remW[k] = v; x[k][a] = 0;
      return;
    }
    for (let v = 0; v <= remW[k]; v += 1) {
      const t = ctx.cw[k][a];
      x[k][a] = v; remW[k] -= v;
      for (let i = 0; i < 8; i += 1) accP[i] += v * t[i];
      acc9 += v * t[8];
      dfsWeek(k, a + 1);
      for (let i = 0; i < 8; i += 1) accP[i] -= v * t[i];
      acc9 -= v * t[8];
      remW[k] += v; x[k][a] = 0;
      if (aborted || stopped) return;
    }
  }

  dfsWeek(0, 0);
  return { aborted, nodes, stopped };
}

// ================================================================ 启发式种子（局部搜索）
function evalX(ctx, X) {
  let v = 0;
  for (let i = 0; i < 8; i += 1) { const d = ctx.L[i] - X[i]; if (d > 0) v += d; }
  const d9 = X[IDX.STRESS] - ctx.U9;
  if (d9 > 0) v += d9;
  return v;
}

export function localSearch(ctx, startX, startY, maxIter = 2000) {
  const { K, n } = ctx;
  const x = startX.map((r) => r.slice());
  const y = startY.slice();
  const X = ctx.base.slice();
  for (let k = 0; k < K; k += 1) {
    for (let a = 0; a < n; a += 1) {
      const v = x[k][a];
      if (!v) continue;
      const t = ctx.cw[k][a];
      for (let i = 0; i < 9; i += 1) X[i] += v * t[i];
    }
  }
  for (let a = 0; a < n; a += 1) {
    const v = y[a];
    if (!v) continue;
    const t = ctx.cr[a];
    for (let i = 0; i < 9; i += 1) X[i] += v * t[i];
  }

  let cur = evalX(ctx, X);
  const tmp = new Array(9);
  for (let iter = 0; iter < maxIter; iter += 1) {
    let bestDelta = 0;
    let move = null;
    for (let k = 0; k < K; k += 1) {
      for (let a = 0; a < n; a += 1) {
        if (x[k][a] <= 0) continue;
        for (let b = 0; b < n; b += 1) {
          if (b === a) continue;
          for (let i = 0; i < 9; i += 1) tmp[i] = X[i] + ctx.cw[k][b][i] - ctx.cw[k][a][i];
          const d = evalX(ctx, tmp) - cur;
          if (d < bestDelta) { bestDelta = d; move = { t: 'w', k, a, b }; }
        }
      }
    }
    for (let a = 0; a < n; a += 1) {
      if (y[a] <= 0) continue;
      for (let b = 0; b < n; b += 1) {
        if (b === a) continue;
        for (let i = 0; i < 9; i += 1) tmp[i] = X[i] + ctx.cr[b][i] - ctx.cr[a][i];
        const d = evalX(ctx, tmp) - cur;
        if (d < bestDelta) { bestDelta = d; move = { t: 'r', a, b }; }
      }
    }
    if (!move) break;
    if (move.t === 'w') {
      x[move.k][move.a] -= 1; x[move.k][move.b] += 1;
      for (let i = 0; i < 9; i += 1) X[i] += ctx.cw[move.k][move.b][i] - ctx.cw[move.k][move.a][i];
    } else {
      y[move.a] -= 1; y[move.b] += 1;
      for (let i = 0; i < 9; i += 1) X[i] += ctx.cr[move.b][i] - ctx.cr[move.a][i];
    }
    cur += bestDelta;
  }
  return { x, y, value: cur };
}

export function seedCandidates(ctx, limit = 8) {
  const { K, n, Nfree, Hfree } = ctx;
  const starts = [];
  for (let a = 0; a < n; a += 1) {
    const x = Array.from({ length: K }, (_, k) => {
      const row = new Array(n).fill(0); row[a] = Nfree[k]; return row;
    });
    const y = new Array(n).fill(0); y[a] = Hfree;
    starts.push({ x, y });
  }
  if (n > 1) {
    const x = Array.from({ length: K }, (_, k) => {
      const row = new Array(n).fill(0);
      let rem = Nfree[k];
      for (let a = 0; a < n && rem > 0; a += 1) { const v = Math.floor(rem / (n - a)); row[a] = v; rem -= v; }
      return row;
    });
    const y = new Array(n).fill(0);
    let rem = Hfree;
    for (let a = 0; a < n && rem > 0; a += 1) { const v = Math.floor(rem / (n - a)); y[a] = v; rem -= v; }
    starts.push({ x, y });
  }

  const seen = new Set();
  const out = [];
  for (const st of starts) {
    const r = localSearch(ctx, st.x, st.y);
    const key = encodeCounts(r.x, r.y);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ x: r.x, y: r.y, value: r.value });
  }
  out.sort((p, q) => p.value - q.value);
  return out.slice(0, limit);
}

// ================================================================ 目标驱动构造式启发（真目标，非松弛）
/**
 * 前向构造：在每个决策点上，按「离终点的实际缺口」挑指令。
 * 由于 §3.10 的松弛在全局视野下几乎失去剪枝力，种子质量完全决定搜索效率；
 * 这里直接优化**精确目标**（min(gain, need) 天然处理目标截断与饱和）。
 *
 * 打分（S 域）：Σ_i α_i·min(max(0,Δ_i), need_i) − 压力越界重罚 − 体力越界重罚 + 体力余量
 * 只依赖确定性的状态 ⇒ 满足 D13 可复现性。
 */
export function constructGreedyPlan(ctx, opts = {}) {
  const problem = ctx.problem;
  const days = problem.calendar.days;
  const commands = problem.commands;
  const L = problem.targetsS.L;
  const U9 = problem.targetsS.U9;
  const SM = problem.constants.S_STAMINA_MIN;
  const SX = problem.constants.S_STRESS_MAX;

  const stressWeight = opts.stressWeight ?? 8;
  const staminaWeight = opts.staminaWeight ?? 4;
  const marginWeight = opts.marginWeight ?? 0.02;
  const alpha = opts.alpha || new Array(8).fill(1);
  const clubBonus = opts.clubBonus ?? 0;

  // 社团指令约束（硬）：截止日前必须累计够社团分配天数
  const clubReq = problem.clubReq && problem.clubReq.active ? problem.clubReq : null;
  const clubCmd = problem.clubReq ? (commands.find((c) => c.kind === 'club') || null) : null;
  const clubJoin = problem.clubReq ? problem.clubReq.joinDate : null;
  // 自第 i 天起，截止日前「全部选社团活动」还能累计多少天（用于「必须选社团」判定）
  const clubCapFrom = new Array(days.length + 1).fill(0);
  if (clubReq) {
    for (let i = days.length - 1; i >= 0; i -= 1) {
      const day = days[i];
      let add = 0;
      if (day.kind !== 'skip' && day.date <= clubReq.deadline) {
        add = day.kind === 'rest' ? CLUB_REST_DAYS : 1;
      }
      clubCapFrom[i] = clubCapFrom[i + 1] + add;
    }
  }
  let clubAcc = 0;
  const clubTotalCap = clubReq ? clubCapFrom[0] : 0;
  /** 进度目标：把 minDays 按剩余机会容量等比例摊开（避免前期把社团堆在一起） */
  const paceTargetAt = (di) => (clubTotalCap > 0
    ? Math.ceil((clubReq.minDays * (clubTotalCap - clubCapFrom[di + 1])) / clubTotalCap)
    : 0);

  const plan = seedForcedPlan(ctx);
  const S = problem.s0.slice();
  let feasible = true;

  const scratch = new Array(9);

  function applyDelta(cmd, units) {
    const T = cmd.T;
    const k = cmd.scale * units;
    for (let i = 0; i < 9; i += 1) {
      const raw = S[i] + k * T[i];
      S[i] = raw < S_MIN ? S_MIN : (raw > S_MAX ? S_MAX : raw);
    }
  }

  function scoreOf(cmd, units) {
    const T = cmd.T;
    const k = cmd.scale * units;
    for (let i = 0; i < 9; i += 1) {
      const raw = S[i] + k * T[i];
      scratch[i] = raw < S_MIN ? S_MIN : (raw > S_MAX ? S_MAX : raw);
    }
    let score = 0;
    for (let i = 0; i < 8; i += 1) {
      const gain = Math.max(0, scratch[i] - S[i]);
      const need = Math.max(0, L[i] - S[i]);
      score += alpha[i] * Math.min(gain, need);
    }
    const overStress = scratch[IDX.STRESS] - U9;
    if (overStress > 0) score -= stressWeight * overStress;
    const underSta = SM - scratch[IDX.STAMINA];
    if (underSta > 0) score -= staminaWeight * underSta;
    const margin = scratch[IDX.STAMINA] - SM;
    score += marginWeight * Math.min(margin, 30000);
    // 轻微偏好降压（避免长期贴着上界）
    score -= 0.5 * Math.max(0, scratch[IDX.STRESS] - (U9 * 3) / 4);
    return score;
  }

  function pick(row, unitsOf, bonus, allowClub = true) {
    let bestScore = -Infinity;
    let bestCmd = null;
    for (let a = 0; a < commands.length; a += 1) {
      if (row && row[a] <= 0) continue;
      const cmd = commands[a];
      if (!allowClub && cmd === clubCmd) continue; // 入社日之前不可选
      let sc = scoreOf(cmd, unitsOf(cmd));
      if (bonus && cmd === clubCmd) sc += bonus;
      if (sc > bestScore) { bestScore = sc; bestCmd = cmd; }
    }
    if (!bestCmd) { feasible = false; return commands[0]; }
    return bestCmd;
  }

  for (let di = 0; di < days.length; di += 1) {
    const day = days[di];
    if (day.kind === 'skip') continue;
    const inP1 = !!clubReq && day.date <= clubReq.deadline;
    const clubOk = !clubCmd || !clubJoin || day.date >= clubJoin; // 入社日之前不可选社团
    if (day.kind === 'weekday') {
      let cmd = plan.weekCmd.get(day.weekStart);
      if (!cmd) {
        // 必须选社团：本块再不选，后面全选社团也凑不够
        const mustClub = clubOk && inP1 && clubCmd && (clubAcc + clubCapFrom[di + 1] < clubReq.minDays);
        const needClub = clubOk && inP1 && clubCmd && clubAcc < paceTargetAt(di);
        cmd = mustClub ? clubCmd : pick(null, () => 1, needClub ? clubBonus : 0, clubOk);
        plan.weekCmd.set(day.weekStart, cmd);
      }
      if (inP1 && cmd === clubCmd) clubAcc += 1;
      applyDelta(cmd, 1);
      if (S[IDX.STAMINA] < SM || S[IDX.STRESS] > SX) feasible = false;
    } else {
      let cmd = plan.restCmd.get(day.date);
      if (!cmd) {
        const mustClub = clubOk && inP1 && clubCmd && (clubAcc + clubCapFrom[di + 1] < clubReq.minDays);
        const needClub = clubOk && inP1 && clubCmd && clubAcc < paceTargetAt(di);
        cmd = mustClub ? clubCmd : pick(null, (c) => restWeight(c), needClub ? clubBonus : 0, clubOk);
        plan.restCmd.set(day.date, cmd);
      }
      if (inP1 && cmd === clubCmd) clubAcc += CLUB_REST_DAYS;
      applyDelta(cmd, restWeight(cmd));
      if (S[IDX.STAMINA] < SM || S[IDX.STRESS] > SX) feasible = false;
    }
  }
  if (clubReq && clubAcc < clubReq.minDays) feasible = false; // 社团分配不足 ⇒ 该构造不可行
  return { plan, feasible, counts: countsOfPlan(ctx, plan), clubDays: clubAcc };
}

/** 由具体安排反推计数向量（同尺寸周 / 休日槽可互换，§3.5） */
export function countsOfPlan(ctx, plan) {
  const x = Array.from({ length: ctx.K }, (_, k) => new Array(ctx.n).fill(0));
  const y = new Array(ctx.n).fill(0);
  const idx = new Map(ctx.commands.map((c, i) => [c.id, i]));
  for (const wk of ctx.problem.freeWeeks) {
    const cmd = plan.weekCmd.get(wk.weekStart);
    if (!cmd) continue;
    x[ctx.mIndex.get(wk.m)][idx.get(cmd.id)] += 1;
  }
  for (const slot of ctx.problem.freeRest) {
    const cmd = plan.restCmd.get(slot.date);
    if (!cmd) continue;
    y[idx.get(cmd.id)] += 1;
  }
  return { x, y };
}

// ================================================================ 阶段二：具体化 + 路径可行性
function emptyPlan() { return { weekCmd: new Map(), restCmd: new Map() }; }

function seedForcedPlan(ctx) {
  const plan = emptyPlan();
  for (const [ws, cmd] of ctx.forcedWeekCmd) plan.weekCmd.set(ws, cmd);
  for (const [d, cmd] of ctx.forcedRestCmd) plan.restCmd.set(d, cmd);
  return plan;
}

function memoKey(i, remX, remY) {
  let s = `${i}|`;
  for (let k = 0; k < remX.length; k += 1) s += `${remX[k].join(',')};`;
  return `${s}|${remY.join(',')}`;
}

function dominated(front, S) {
  for (let j = 0; j < front.length; j += 1) {
    if (front[j][0] >= S[IDX.STAMINA] && front[j][1] <= S[IDX.STRESS]) return true;
  }
  return false;
}

function pushFront(front, S) {
  for (let j = front.length - 1; j >= 0; j -= 1) {
    if (front[j][0] <= S[IDX.STAMINA] && front[j][1] >= S[IDX.STRESS]) front.splice(j, 1);
  }
  front.push([S[IDX.STAMINA], S[IDX.STRESS]]);
}

/**
 * 给定计数向量，求一个满足 (C2) 的具体安排（§4.3 阶段二）。
 * @returns {{kind:'witness',plan:Object}|{kind:'refuted'}|{kind:'unknown'}}
 */
export function realize(ctx, counts, budget, opts = {}) {
  const { days, commands, n, problem } = ctx;
  const remX = counts.x.map((r) => r.slice());
  const remY = counts.y.slice();
  const plan = seedForcedPlan(ctx);
  const heuristic = !!opts.heuristicOrder;
  // 小实例（决策点 ≤ 24）不做 Pareto 记忆化：搜索树本就很小，省下键构造开销
  const useMemo = opts.useMemo ?? (problem.freeWeeks.length + problem.freeRest.length > 24);

  // 社团指令约束：截止日前至少 minDays 天；用后缀容量做剪枝，逼 DFS 提前安排社团活动。
  // 社团最早 1995-04-09 才可加入 ⇒ 入社日之前的决策点不产生社团候选。
  const clubReq = problem.clubReq && problem.clubReq.active ? problem.clubReq : null;
  const clubIdx = commands.findIndex((c) => c.kind === 'club');
  const clubCmd = clubIdx >= 0 ? commands[clubIdx] : null;
  const clubJoin = problem.clubReq ? problem.clubReq.joinDate : null;
  const clubAllowedAt = (date) => !clubCmd || !clubJoin || date >= clubJoin;
  const clubCapFrom = clubReq ? new Array(days.length + 1).fill(0) : null;
  if (clubReq) {
    for (let i = days.length - 1; i >= 0; i -= 1) {
      const day = days[i];
      let add = 0;
      if (day.kind !== 'skip' && clubAllowedAt(day.date) && day.date <= clubReq.deadline) {
        add = day.kind === 'rest' ? CLUB_REST_DAYS : 1;
      }
      clubCapFrom[i] = clubCapFrom[i + 1] + add;
    }
  }

  let nodes = 0;
  let aborted = false;
  const memo = new Map();

  function candidatesFor(row, S, unitsOf, allowClub) {
    const skipA = allowClub ? -1 : clubIdx;
    if (!heuristic) {
      const out = [];
      for (let a = 0; a < n; a += 1) if (row[a] > 0 && a !== skipA) out.push(a);
      return out;
    }
    const scored = [];
    for (let a = 0; a < n; a += 1) {
      if (row[a] <= 0 || a === skipA) continue;
      scored.push({ a, score: safety(commands[a], S, ctx, unitsOf(a)) });
    }
    scored.sort((p, q) => (q.score - p.score) || (p.a - q.a));
    return scored.map((s) => s.a);
  }

  function dfs(i, S, clubAcc) {
    if (aborted) return false;
    nodes += 1;
    if (nodes > budget) { aborted = true; return false; }
    if (clubReq && clubAcc + clubCapFrom[i] < clubReq.minDays) return false; // 剩余容量不够
    if (i === days.length) return true;
    const day = days[i];

    if (day.kind === 'skip') return dfs(i + 1, S, clubAcc);

    if (day.kind === 'weekday') {
      const existing = plan.weekCmd.get(day.weekStart);
      const inP1 = clubReq && day.date <= clubReq.deadline;
      if (existing) {
        const next = advance(S, deltaS(existing, 1));
        if (!pathFeasible(next)) return false;
        const add = inP1 && existing === clubCmd ? 1 : 0;
        return dfs(i + 1, next, clubAcc + add);
      }
      const k = ctx.mIndex.get(ctx.weekSize.get(day.weekStart));
      const row = remX[k];
      const key = useMemo ? memoKey(i, remX, remY) + (clubReq ? `|c${clubAcc}` : '') : null;
      const front = useMemo ? memo.get(key) : null;
      if (front && dominated(front, S)) return false;
      for (const a of candidatesFor(row, S, () => 1, clubAllowedAt(day.date))) {
        const cmd = commands[a];
        row[a] -= 1;
        plan.weekCmd.set(day.weekStart, cmd);
        const next = advance(S, deltaS(cmd, 1));
        const add = inP1 && cmd === clubCmd ? 1 : 0;
        if (pathFeasible(next) && dfs(i + 1, next, clubAcc + add)) return true;
        plan.weekCmd.delete(day.weekStart);
        row[a] += 1;
        if (aborted) return false;
      }
      if (useMemo) {
        if (front) pushFront(front, S); else memo.set(key, [[S[IDX.STAMINA], S[IDX.STRESS]]]);
        if (memo.size > MEMO_CAP) memo.clear();
      }
      return false;
    }

    const inP1 = clubReq && day.date <= clubReq.deadline;
    const key = useMemo ? memoKey(i, remX, remY) + (clubReq ? `|c${clubAcc}` : '') : null;
    const front = useMemo ? memo.get(key) : null;
    if (front && dominated(front, S)) return false;
    for (const a of candidatesFor(remY, S, (a2) => restWeight(commands[a2]), clubAllowedAt(day.date))) {
      const cmd = commands[a];
      remY[a] -= 1;
      plan.restCmd.set(day.date, cmd);
      // R2：4 / 6 天当量一次结算，只在落地后检查
      const next = advance(S, deltaS(cmd, restWeight(cmd)));
      const add = inP1 && cmd === clubCmd ? CLUB_REST_DAYS : 0;
      if (pathFeasible(next) && dfs(i + 1, next, clubAcc + add)) return true;
      plan.restCmd.delete(day.date);
      remY[a] += 1;
      if (aborted) return false;
    }
    if (useMemo) {
      if (front) pushFront(front, S); else memo.set(key, [[S[IDX.STAMINA], S[IDX.STRESS]]]);
      if (memo.size > MEMO_CAP) memo.clear();
    }
    return false;
  }

  const ok = dfs(0, ctx.problem.s0.slice(), 0);
  if (ok) return { kind: 'witness', plan, nodes };
  return { kind: aborted ? 'unknown' : 'refuted', nodes };
}

/** 确定性安全度打分（越大越安全），只依赖当前状态 ⇒ 不破坏可复现性（D13） */
function safety(cmd, S, ctx, units) {
  const d = deltaS(cmd, units);
  const sta = Math.min(S_MAX, Math.max(S_MIN, S[IDX.STAMINA] + d[IDX.STAMINA]));
  const str = Math.min(S_MAX, Math.max(S_MIN, S[IDX.STRESS] + d[IDX.STRESS]));
  return Math.min(sta - ctx.problem.constants.S_STAMINA_MIN,
    ctx.problem.constants.S_STRESS_MAX - str);
}

// ================================================================ 精确评估与证书（R3）
export function exactEvaluate(problem, plan) {
  const clampedSim = simulate(problem.calendar, plan, problem.s0, { clamp: true });
  const linearSim = simulate(problem.calendar, plan, problem.s0, { clamp: false });
  const obj = objectiveS(clampedSim.S, problem.targetsS);
  const affected = [];
  for (let i = 0; i < 9; i += 1) {
    const vT = i < 8
      ? Math.max(0, problem.targetsS.L[i] - clampedSim.S[i])
      : Math.max(0, clampedSim.S[i] - problem.targetsS.U9);
    const vL = i < 8
      ? Math.max(0, problem.targetsS.L[i] - linearSim.S[i])
      : Math.max(0, linearSim.S[i] - problem.targetsS.U9);
    if (vT !== vL) affected.push({ attr: ATTRS[i], trueViolation: vT, linearViolation: vL });
  }
  const wasted = {};
  for (const ev of clampedSim.clampEvents) {
    const amount = ev.raw > S_MAX ? ev.raw - S_MAX : S_MIN - ev.raw;
    wasted[ev.attr] = (wasted[ev.attr] || 0) + amount;
  }
  return {
    sim: clampedSim,
    linearSim,
    obj,
    certificate: clampedSim.certificate,
    saturation: { clamped: clampedSim.clamped, affectedTargets: affected, wasted },
  };
}


// ================================================================ 快速精确评估（热路径，零分配）
/**
 * 与 verify.js 的 advance() 完全同源的语义，只是省掉轨迹与事件的分配。
 * 返回 S 域精确目标（含 clamp）与线性目标（无 clamp）以及是否发生夹取。
 */
export function makeFastEvaluator(problem) {
  const days = problem.calendar.days;
  const s0 = problem.s0;
  const L = problem.targetsS.L;
  const U9 = problem.targetsS.U9;
  const S = new Array(9).fill(0);
  const SL = new Array(9).fill(0);
  // 社团指令约束：截止日前累计的社团分配天数（平时日 1 天、休日 6 天）
  const clubReq = problem.clubReq && problem.clubReq.active ? problem.clubReq : null;
  const clubCmd = problem.commands.find((c) => c.kind === 'club') || null;
  const clubJoin = problem.clubReq ? problem.clubReq.joinDate : null;

  return function fastEval(plan) {
    for (let i = 0; i < 9; i += 1) { S[i] = s0[i]; SL[i] = s0[i]; }
    let clamped = false;
    let violated = false;
    let clubAcc = 0;
    for (let d = 0; d < days.length; d += 1) {
      const day = days[d];
      let cmd = null;
      let units = 0;
      if (day.kind === 'weekday') { cmd = plan.weekCmd.get(day.weekStart); units = 1; }
      else if (day.kind === 'rest') { cmd = plan.restCmd.get(day.date); units = restWeight(cmd); }
      if (!cmd) continue;
      if (clubCmd && cmd === clubCmd) {
        // 入社日之前不允许社团活动（游戏规则）
        if (clubJoin && day.date < clubJoin) violated = true;
        else if (clubReq && day.date <= clubReq.deadline) {
          clubAcc += day.kind === 'rest' ? CLUB_REST_DAYS : 1;
        }
      }
      const T = cmd.T;
      const k = cmd.scale * units;
      for (let i = 0; i < 9; i += 1) {
        const inc = k * T[i];
        const raw = S[i] + inc;
        const v = raw < S_MIN ? S_MIN : (raw > S_MAX ? S_MAX : raw);
        if (v !== raw) clamped = true;
        S[i] = v;
        SL[i] += inc;
      }
      if (S[IDX.STAMINA] < S_STAMINA_MIN || S[IDX.STRESS] > S_STRESS_MAX) violated = true;
    }
    if (clubReq && clubAcc < clubReq.minDays) violated = true; // 硬约束：社团分配不足即不可行
    let obj = 0;
    let objLin = 0;
    for (let i = 0; i < 8; i += 1) {
      const a = L[i] - S[i]; if (a > 0) obj += a;
      const b = L[i] - SL[i]; if (b > 0) objLin += b;
    }
    const a9 = S[IDX.STRESS] - U9; if (a9 > 0) obj += a9;
    const b9 = SL[IDX.STRESS] - U9; if (b9 > 0) objLin += b9;
    return { objS: obj, objLinS: objLin, clamped, violated, S: S.slice(), clubDays: clubAcc };
  };
}


/** 计划级局部搜索（真目标）：每次改动一个决策点，用精确前向模拟打分 */
export function refinePlan(ctx, startPlan, fastEval, opts = {}) {
  const problem = ctx.problem;
  const deadline = now() + (opts.timeLimitMs ?? 400);
  const clone = (p) => ({ weekCmd: new Map(p.weekCmd), restCmd: new Map(p.restCmd) });
  const cur = clone(startPlan);
  let curEval = fastEval(cur);
  if (curEval.violated) return { plan: cur, eval: curEval, improved: false };

  const weekPoints = problem.freeWeeks.map((w) => w.weekStart);
  const restPoints = problem.freeRest.map((r) => r.date);
  const cmds = ctx.commands;
  let improvedAny = false;

  for (let iter = 0; iter < (opts.maxIter ?? 200); iter += 1) {
    if (now() > deadline) break;
    let bestDelta = 0;
    let bestApply = null;
    let bestEval = null;

    for (const ws of weekPoints) {
      const prev = cur.weekCmd.get(ws);
      for (const cmd of cmds) {
        if (cmd === prev) continue;
        cur.weekCmd.set(ws, cmd);
        const e = fastEval(cur);
        if (!e.violated && e.objS < curEval.objS && e.objS - curEval.objS < bestDelta) {
          bestDelta = e.objS - curEval.objS;
          bestApply = () => cur.weekCmd.set(ws, cmd);
          bestEval = e;
        }
      }
      cur.weekCmd.set(ws, prev);
    }
    for (const d of restPoints) {
      const prev = cur.restCmd.get(d);
      for (const cmd of cmds) {
        if (cmd === prev) continue;
        cur.restCmd.set(d, cmd);
        const e = fastEval(cur);
        if (!e.violated && e.objS < curEval.objS && e.objS - curEval.objS < bestDelta) {
          bestDelta = e.objS - curEval.objS;
          bestApply = () => cur.restCmd.set(d, cmd);
          bestEval = e;
        }
      }
      cur.restCmd.set(d, prev);
    }

    if (!bestApply) break;
    bestApply();
    curEval = bestEval;
    improvedAny = true;
    if (curEval.objS === 0) break;
  }
  return { plan: cur, eval: curEval, improved: improvedAny };
}

// ================================================================ D14：不可行归因
export function diagnosePath(problem, budget = 120_000) {
  const days = problem.calendar.days;
  const commands = problem.commands;
  const forcedWeek = new Map();
  for (const f of problem.forcedWeeks) forcedWeek.set(f.weekStart, problem.cmdById.get(f.command));
  const forcedRest = new Map();
  for (const f of problem.forcedRest) forcedRest.set(f.date, problem.cmdById.get(f.command));

  const { S_STAMINA_MIN, S_STRESS_MAX } = problem.constants;
  const memo = new Map();
  let nodes = 0;
  let best = { violation: Infinity, trace: null };
  let aborted = false;

  function step(S, cmd, units) {
    const next = advance(S, deltaS(cmd, units));
    const add = (next[IDX.STAMINA] < S_STAMINA_MIN ? S_STAMINA_MIN - next[IDX.STAMINA] : 0)
      + (next[IDX.STRESS] > S_STRESS_MAX ? next[IDX.STRESS] - S_STRESS_MAX : 0);
    return { next, add };
  }

  function dfs(i, S, viol, trace) {
    if (aborted) return;
    nodes += 1;
    if (nodes > budget) { aborted = true; return; }
    if (viol >= best.violation) return;
    if (i === days.length) { best = { violation: viol, trace: trace.slice() }; return; }
    const key = `${i}|${S[IDX.STAMINA]}|${S[IDX.STRESS]}`;
    const prev = memo.get(key);
    if (prev !== undefined && prev <= viol) return;
    memo.set(key, viol);
    if (memo.size > MEMO_CAP) memo.clear();

    const day = days[i];
    if (day.kind === 'skip') { trace.push({ day, cmd: null }); dfs(i + 1, S, viol, trace); trace.pop(); return; }

    if (day.kind === 'weekday') {
      const forced = forcedWeek.get(day.weekStart);
      const cands = forced ? [forced] : commands;
      for (const cmd of cands) {
        const { next, add } = step(S, cmd, 1);
        trace.push({ day, cmd });
        dfs(i + 1, next, viol + add, trace);
        trace.pop();
        if (aborted) return;
      }
      return;
    }
    const forced = forcedRest.get(day.date);
    const cands = forced ? [forced] : commands;
    for (const cmd of cands) {
      const { next, add } = step(S, cmd, restWeight(cmd));
      trace.push({ day, cmd });
      dfs(i + 1, next, viol + add, trace);
      trace.pop();
      if (aborted) return;
    }
  }

  dfs(0, problem.s0.slice(), 0, []);
  return { ...best, aborted, nodes };
}

/**
 * 是否存在路径可行解（§4.4 归因用）。
 *
 * 全局视野有 300+ 个决策点，最小违反 DFS 不可能在可行预算内穷尽；
 * 但「构造式贪心」在全局视野下几毫秒就能给出见证 —— 这正是判断
 * 「解除某条强制标注后是否可行」所需的信号。贪心失败时再用有界 DFS 兜底
 * （找不到就保守地判为不可行，只会少报冲突，不会误报）。
 */
export function hasFeasiblePath(problem, budget = 60_000) {
  const ctx = buildContext(problem);
  const fast = makeFastEvaluator(problem);
  for (const v of [{}, { stressWeight: 16, marginWeight: 0.01 }, { stressWeight: 4, marginWeight: 0.06 }]) {
    const g = constructGreedyPlan(ctx, v);
    if (g.feasible && !fast(g.plan).violated) return true;
  }
  return diagnosePath(problem, budget).violation === 0;
}

/** §4.4：逐条解除强制标注，凡「解除后可行」者构成冲突集 */
export function attributeConflicts(problem) {
  const out = [];
  const forced = [
    ...problem.forcedWeeks.map((f) => ({ type: 'week', key: f.weekStart, command: f.command })),
    ...problem.forcedRest.map((f) => ({ type: 'rest', key: f.date, command: f.command })),
  ];
  for (const f of forced) {
    const raw = {
      ...problem.input,
      weekForces: { ...problem.input.weekForces },
      annotations: JSON.parse(JSON.stringify(problem.input.annotations)),
    };
    if (f.type === 'week') delete raw.weekForces[f.key];
    else if (raw.annotations[f.key]) delete raw.annotations[f.key].force;
    const alt = buildProblem(raw);
    if (hasFeasiblePath(alt)) out.push({ type: f.type, key: f.key, command: f.command });
  }
  return out;
}

export function buildInfeasible(problem, diag) {
  const { S_STAMINA_MIN, S_STRESS_MAX } = problem.constants;
  const trace = diag.trace || [];
  let worst = null;
  if (trace.length) {
    // 用同一份 advance() 语义复算一遍轨迹，找最早越界点
    const plan = emptyPlan();
    for (const st of trace) {
      if (!st.cmd) continue;
      if (st.day.kind === 'weekday') plan.weekCmd.set(st.day.weekStart, st.cmd);
      if (st.day.kind === 'rest') plan.restCmd.set(st.day.date, st.cmd);
    }
    let S = problem.s0.slice();
    for (const st of trace) {
      if (!st.cmd) continue;
      S = advance(S, deltaS(st.cmd, st.day.kind === 'rest' ? restWeight(st.cmd) : 1));
      const bad = [];
      if (S[IDX.STAMINA] < S_STAMINA_MIN) bad.push('stamina');
      if (S[IDX.STRESS] > S_STRESS_MAX) bad.push('stress');
      if (bad.length) {
        const wk = problem.weeks.findIndex((w) => w.weekStart === mondayOf(st.day.date));
        worst = { date: st.day.date, attrs: bad, week: wk >= 0 ? wk + 1 : null };
        break;
      }
    }
  }
  const label = (a) => (a === 'stamina' ? '体力' : '压力');
  const reason = worst
    ? `第 ${worst.week} 周${worst.attrs.map(label).join('、')}越界（${worst.date}）`
    : '路径约束不可满足（体力 ≥ 20 / 压力 ≤ 70）';
  return {
    reason,
    attribute: worst ? worst.attrs[0] : null,
    week: worst ? worst.week : null,
    date: worst ? worst.date : null,
    totalViolation: Number.isFinite(diag.violation) ? diag.violation : null,
    conflicts: attributeConflicts(problem),
    diagnosticOnly: true,
  };
}

// ================================================================ 主循环（§4.5）
export function solve(problem, options = {}) {
  const started = now();
  const ctx = buildContext(problem);
  const budget = options.budget ?? DEFAULT_BUDGET;
  const realizeBudget = options.realizeBudget ?? REALIZE_BUDGET;
  const timeLimit = options.timeLimitMs === 0
    ? Infinity
    : (options.timeLimitMs ?? DEFAULT_TIME_LIMIT);

  // 社团指令约束：容量不足时无需搜索即可判定不可行（给出可读的归因）
  if (problem.clubReq && problem.clubReq.active && !problem.clubReq.feasibleByCapacity) {
    const q = problem.clubReq;
    return {
      status: 'path_infeasible',
      optimal: true,
      proven: true,
      gapS: 0,
      plan: null,
      counts: null,
      exact: null,
      relaxedObjective: null,
      infeasible: {
        kind: 'club',
        reason: `社团分配天数不足：${q.name} 需在 ${q.deadline} 前累计 ${q.minDays} 天，`
          + `自 ${problem.t0} 起最多只能安排 ${q.capacity} 天`,
        attribute: null,
        week: null,
        date: null,
        totalViolation: null,
        conflicts: [],
        diagnosticOnly: false,
      },
      meta: {
        relaxationBound: null,
        realized: 0,
        refuted: 0,
        enumerated: 0,
        nodes: 0,
        elapsedMs: Math.round(now() - started),
        timeLimitMs: Number.isFinite(timeLimit) ? timeLimit : null,
        warnings: problem.warnings,
      },
    };
  }

  let spentNodes = 0;
  let realized = 0;
  let refuted = 0;
  const cuts = new Set();

  const z = lowerBound(ctx, 0, ctx.K ? ctx.Nfree[0] : 0, ctx.Hfree, new Array(8).fill(0), 0);
  const fastEval = makeFastEvaluator(problem);
  let best = null;
  let proven = false;

  const considerPlan = (plan, source) => {
    const fast = fastEval(plan);
    if (fast.violated) return { violated: true };
    const counts = countsOfPlan(ctx, plan);
    if (!best || fast.objS < best.fast.objS) {
      best = { counts, plan, fast, source, relaxed: relaxedObjectiveOf(ctx, counts) };
    }
    return { objective: fast.objS };
  };

  const consider = (counts, source) => {
    let key = null;
    if (cuts.size) {
      key = encodeCounts(counts.x, counts.y);
      if (cuts.has(key)) return { skipped: true };
    }
    let res = realize(ctx, counts, realizeBudget, { heuristicOrder: false });
    spentNodes += res.nodes;
    if (res.kind === 'unknown') {
      res = realize(ctx, counts, realizeBudget, { heuristicOrder: true });
      spentNodes += res.nodes;
    }
    realized += 1;
    if (res.kind === 'refuted') {
      cuts.add(key || encodeCounts(counts.x, counts.y));
      refuted += 1;
      return { refuted: true };
    }
    if (res.kind === 'unknown') return { unknown: true };
    const fast = fastEval(res.plan);
    if (fast.violated) return { violated: true }; // 含社团分配硬约束
    if (!best || fast.objS < best.fast.objS) {
      best = { counts, plan: res.plan, fast, source, relaxed: relaxedObjectiveOf(ctx, counts) };
    }
    return { objective: fast.objS };
  };

  // 1a) 目标驱动构造式启发（直接优化精确目标；弱松弛下这是唯一可靠的入口）
  const greedyVariants = [
    {},
    { stressWeight: 16, marginWeight: 0.01 },
    { stressWeight: 4, marginWeight: 0.06 },
  ];
  // 社团指令约束下，多来几个「社团优先」的变体，保证一定拿到满足约束的可行见证
  if (problem.clubReq && problem.clubReq.active) {
    greedyVariants.push(
      { clubBonus: 3000 },
      { stressWeight: 16, marginWeight: 0.01, clubBonus: 3000 },
      { stressWeight: 4, marginWeight: 0.06, clubBonus: 8000 },
      { stressWeight: 24, marginWeight: 0.02, clubBonus: 12000 },
    );
  }
  for (const v of greedyVariants) {
    if (proven || now() - started > timeLimit) break;
    const g = constructGreedyPlan(ctx, v);
    if (!g.feasible) continue;
    considerPlan(g.plan, 'greedy');
    if (best && best.fast.objS <= z) { proven = true; break; }
  }

  // 1b) 计划级局部搜索（真目标精修）
  if (!proven && best) {
    const refineBudget = options.refineMs ?? 700;
    const r = refinePlan(ctx, best.plan, fastEval, { timeLimitMs: refineBudget });
    if (r.eval.objS < best.fast.objS) considerPlan(r.plan, 'refine');
    if (best && best.fast.objS <= z) proven = true;
  }

  // 1c) 松弛驱动的计数型局部搜索种子
  if (!proven) {
    for (const seed of seedCandidates(ctx)) {
      if (now() - started > timeLimit) break;
      consider({ x: seed.x, y: seed.y }, 'seed');
      if (best && best.fast.objS <= z) { proven = true; break; }
    }
  }

  // 2) 单遍动态阈值枚举：剪枝阈值 = 当前最优精确目标（随搜索收紧）
  //    正确性：任何 v_true < best_final 的候选都有 v_relax ≤ v_true < best_final ≤ θ_t，
  //    其路径上所有节点界均 ≤ θ_t，故不会被剪掉 ⇒ 必被枚举（§4.3）。
  let complete = true;
  let enumerated = 0;
  if (!proven) {
    const thetaOf = () => (best ? best.fast.objS : Infinity);
    const res = enumerateCounts(ctx, thetaOf, (counts) => {
      enumerated += 1;
      if (now() - started > timeLimit) { complete = false; return false; }
      consider(counts, 'enumerate');
      if (best && best.fast.objS <= z) return false; // 已证全局最优
      return undefined;
    }, budget);
    if (res.aborted) complete = false;
  }

  // 3) 预算耗尽时把剩余时间继续投入真目标精修（E10：不静默、但也不浪费）
  if (!proven && best && !complete) {
    const remaining = timeLimit - (now() - started);
    if (remaining > 60) {
      const r = refinePlan(ctx, best.plan, fastEval, { timeLimitMs: Math.min(remaining - 30, 500) });
      if (r.eval.objS < best.fast.objS) considerPlan(r.plan, 'refine-after-enum');
      if (best && best.fast.objS <= z) proven = true;
    }
  }

  const elapsedMs = Math.round(now() - started);
  const meta = {
    relaxationBound: z,
    realized,
    refuted,
    enumerated,
    nodes: spentNodes,
    elapsedMs,
    timeLimitMs: Number.isFinite(timeLimit) ? timeLimit : null,
    warnings: problem.warnings,
  };

  if (!best) {
    const diag = diagnosePath(problem, 120_000);
    const infeasible = buildInfeasible(problem, diag);
    // 有社团分配要求时，说明「可行」是指「在满足社团分配要求的前提下」
    if (problem.clubReq && problem.clubReq.active) {
      infeasible.kind = infeasible.kind || 'path';
      infeasible.clubRequirement = {
        clubId: problem.clubReq.clubId,
        name: problem.clubReq.name,
        minDays: problem.clubReq.minDays,
        deadline: problem.clubReq.deadline,
      };
      infeasible.reason = `${infeasible.reason}（已计入社团分配要求：${problem.clubReq.name} `
        + `${problem.clubReq.deadline} 前 ≥ ${problem.clubReq.minDays} 天）`;
    }
    return {
      status: 'path_infeasible',
      optimal: true,
      proven: true,
      gapS: 0,
      plan: null,
      counts: null,
      exact: null,
      relaxedObjective: null,
      infeasible,
      meta,
    };
  }

  const optimal = proven || complete;
  const gapS = optimal ? 0 : Math.max(0, best.fast.objS - z);

  const exact = exactEvaluate(problem, best.plan);
  return {
    status: optimal
      ? (best.fast.objS === 0 ? 'ok' : 'targets_missed')
      : 'undetermined',
    optimal,
    proven: optimal,
    gapS,
    plan: best.plan,
    counts: best.counts,
    relaxedObjective: best.relaxed,
    exact,
    infeasible: null,
    meta,
  };
}

export const __internals = { DEFAULT_BUDGET, DEFAULT_TIME_LIMIT };

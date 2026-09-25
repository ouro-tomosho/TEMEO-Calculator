// src/verify.js —— 唯一的「状态推进语义」实现（技术文档 §1.3 / §3.2 / §3.7）
//
// 关键设计原则：求解器内部的所有状态推进、以及结果的按天属性轨迹，
// 都必须经由同一份 advance(state, delta)，避免求解与展示两套语义漂移。
//
// R3：advance() 内部含饱和夹取，它才是权威语义；(E1) 线性式只是它在「无夹取」区间的闭式解。
// R2：休日的 4（社团 6）天当量是**一次结算**（原子步长），落地后只检查一次。

import {
  SCALE, S_MIN, S_MAX, S_STAMINA_MIN, S_STRESS_MAX, IDX, ATTRS,
  deltaS, restWeight,
} from './spec.js';

/** 饱和夹取（R3 权威语义） */
export function clampS(v) {
  if (v < S_MIN) return S_MIN;
  if (v > S_MAX) return S_MAX;
  return v;
}

/** 就地安全：返回新的 S 向量 */
export function advance(S, delta) {
  const out = new Array(9);
  for (let i = 0; i < 9; i += 1) out[i] = clampS(S[i] + delta[i]);
  return out;
}

/** 无夹取累加（仅用于证书判定 / (E1) 闭式解） */
export function advanceLinear(S, delta) {
  const out = new Array(9);
  for (let i = 0; i < 9; i += 1) out[i] = S[i] + delta[i];
  return out;
}

/** 逐期路径约束（C2）：体力 ≥ 20 且 压力 ≤ 70（命题 2：与夹取无关） */
export function pathViolations(S) {
  const v = [];
  if (S[IDX.STAMINA] < S_STAMINA_MIN) v.push('stamina');
  if (S[IDX.STRESS] > S_STRESS_MAX) v.push('stress');
  return v;
}

export function pathFeasible(S) {
  return S[IDX.STAMINA] >= S_STAMINA_MIN && S[IDX.STRESS] <= S_STRESS_MAX;
}

/** 单个决策点的 S 域增量 */
export function deltaForCommand(cmd, units) {
  return deltaS(cmd, units);
}

/**
 * 逐日精确模拟（权威）。
 *
 * @param {Object} calendar expandCalendar() 的结果
 * @param {{weekCmd:Map<string,Object>, restCmd:Map<string,Object>}} plan 指令描述子
 * @param {number[]} s0 S 域初值
 * @param {{clamp?:boolean, keepTrajectory?:boolean}} [opts]
 */
export function simulate(calendar, plan, s0, opts = {}) {
  const clamp = opts.clamp !== false;
  const keepTrajectory = opts.keepTrajectory !== false;
  const step = clamp ? advance : advanceLinear;

  let S = s0.slice();
  const trajectory = [];
  const clampEvents = [];
  let clamped = false;
  let linearMin = Infinity;
  let linearMax = -Infinity;

  const note = (S2) => {
    for (let i = 0; i < 9; i += 1) {
      if (S2[i] < linearMin) linearMin = S2[i];
      if (S2[i] > linearMax) linearMax = S2[i];
    }
  };
  note(S);

  for (const day of calendar.days) {
    let delta = null;
    if (day.kind === 'weekday') {
      const cmd = plan.weekCmd.get(day.weekStart);
      if (!cmd) throw new Error(`未分配的平时块: ${day.weekStart}`);
      delta = deltaS(cmd, 1); // 每天 1 个天当量，逐日结算
    } else if (day.kind === 'rest') {
      const cmd = plan.restCmd.get(day.date);
      if (!cmd) throw new Error(`未分配的休日槽: ${day.date}`);
      delta = deltaS(cmd, restWeight(cmd)); // R2：4 / 6 天当量一次结算
    }

    if (delta) {
      const raw = new Array(9);
      for (let i = 0; i < 9; i += 1) raw[i] = S[i] + delta[i];
      const next = step(S, delta);
      if (clamp) {
        for (let i = 0; i < 9; i += 1) {
          if (next[i] !== raw[i]) {
            clamped = true;
            if (clampEvents.length < 64) {
              clampEvents.push({ date: day.date, attr: ATTRS[i], raw: raw[i], value: next[i] });
            }
          }
        }
      }
      S = next;
      note(S);
    }

    if (keepTrajectory) {
      trajectory.push({
        date: day.date,
        kind: day.kind,
        S: S.slice(),
        attrs: sOf(S),
        violations: day.kind === 'skip' ? [] : pathViolations(S),
      });
    }
  }

  return {
    S,
    trajectory,
    clamped,
    clampEvents,
    linearRange: { min: linearMin, max: linearMax },
    // 无夹取证书（命题 3）：全程 0 ≤ Λ_k ≤ 999·180
    certificate: !clamped && linearMin >= S_MIN && linearMax <= S_MAX,
  };
}

/** S → s（渲染层；除法只发生在输出，§3.2） */
export function sOf(S) {
  return S.map((v) => v / SCALE);
}

/** 单边 L1 违反量（S 域整数，§3.4） */
export function objectiveS(finalS, targetsS) {
  let total = 0;
  const items = [];
  for (let i = 0; i < 8; i += 1) {
    const v = Math.max(0, targetsS.L[i] - finalS[i]);
    total += v;
    if (v > 0) items.push({ attr: ATTRS[i], index: i, violation: v });
  }
  const v9 = Math.max(0, finalS[IDX.STRESS] - targetsS.U9);
  total += v9;
  if (v9 > 0) items.push({ attr: 'stress', index: 8, violation: v9 });
  return { total, items };
}

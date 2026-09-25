// src/result.js —— 结果装配、达标核对、轨迹、差距诊断（技术文档 §2.4 / §5.4 / §7.3）

import { ATTRS, ATTR_LABELS, IDX, SCALE } from './spec.js';
import { structuralBounds, clubAllocation } from './model.js';
import { simulate, objectiveS } from './verify.js';

export const fmtS = (v, digits = 2) => {
  const x = v / SCALE;
  const r = Number(x.toFixed(digits));
  return Number.isInteger(r) ? r : r;
};

const fmtNum = (v, digits = 2) => {
  const r = Number(v.toFixed(digits));
  return String(r);
};

/**
 * 结果装配（§5.4 Schema）。
 *
 * 求解**恒为全局**（一直算到毕业日 T）；`opts.displayFrom / opts.displayEnd`
 * 只决定 `executable` 与 `trajectory` 这两个对外切片的范围（默认两个月）。
 * `terminal / checklist / diagnosis` 一律取全局终点（毕业）的口径。
 */
export function assembleResult(problem, solution, opts = {}) {
  const { t0, T } = problem;
  const displayFrom = opts.displayFrom || problem.displayFrom || t0;
  const displayEnd = opts.displayEnd || problem.displayEnd || T;

  if (solution.status === 'path_infeasible') {
    return {
      status: 'path_infeasible',
      horizon: { from: t0, T, displayFrom, displayEnd },
      objective: null,
      objectiveS: null,
      verdict: `无法求解：${solution.infeasible.reason}`,
      saturation: { clamped: false, affectedTargets: [], wasted: {} },
      executable: { weeks: [], restSlots: [] },
      trajectory: [],
      terminal: problem.s0.map((v) => fmtS(v)),
      checklist: [],
      diagnosis: { totalGap: null, items: [], structurallyUnreachable: [] },
      club: clubAllocation(problem, null),
      infeasible: solution.infeasible,
      meta: solution.meta,
    };
  }

  const plan = solution.plan;
  const exact = solution.exact;
  const objS = exact.obj.total;
  const objective = fmtS(objS, 4);

  // ---- executable：对外只给显示窗口内的切片（全局解不外泄）
  const inDisplay = (d) => d >= displayFrom && d <= displayEnd;
  const forcedWeekSet = new Set(problem.forcedWeeks.map((f) => f.weekStart));
  const weeks = [];
  for (const wk of problem.weeks) {
    if (wk.m === 0) continue;
    const dates = wk.dates.filter(inDisplay);
    if (!dates.length) continue;
    const cmd = plan.weekCmd.get(wk.weekStart);
    weeks.push({
      weekStart: wk.weekStart,
      range: `${dates[0].slice(5)}~${dates[dates.length - 1].slice(5)}`,
      from: dates[0],
      to: dates[dates.length - 1],
      blockDays: wk.m,
      command: cmd ? cmd.id : null,
      commandName: cmd ? cmd.name : null,
      forced: forcedWeekSet.has(wk.weekStart),
    });
  }

  const restSlots = [];
  for (const day of problem.calendar.days) {
    if (!inDisplay(day.date)) continue;
    if (day.kind === 'rest') {
      const cmd = plan.restCmd.get(day.date);
      restSlots.push({
        date: day.date,
        command: cmd ? cmd.id : null,
        commandName: cmd ? cmd.name : null,
        forced: !!day.forced,
        skipped: false,
      });
    } else if (day.kind === 'skip') {
      restSlots.push({ date: day.date, command: null, commandName: null, forced: false, skipped: true });
    }
  }

  // ---- trajectory（只给显示窗口：两月 ≤ 62 行）
  const trajectory = [];
  for (const row of exact.sim.trajectory) {
    if (!inDisplay(row.date)) continue;
    trajectory.push({
      date: row.date,
      kind: row.kind,
      // row.attrs 已是 s = S/180（渲染层除法只做一次）
      attrs: row.attrs.map((v) => Number(v.toFixed(2))),
      attrsRaw: row.S.slice(),
      violations: row.violations.slice(),
    });
  }

  // ---- terminal（区间终点，精确饱和模拟；§3.4）
  const terminal = exact.sim.S.map((v) => fmtS(v, 2));

  // ---- checklist（区间终点 vs 最终目标）
  const checklist = ATTRS.map((a, i) => {
    const value = exact.sim.S[i] / SCALE;
    const target = i < 8 ? problem.targetsS.L[i] / SCALE : problem.targetsS.U9 / SCALE;
    const ok = i < 8 ? value >= target : value <= target;
    const diff = i < 8 ? value - target : target - value;
    return {
      attr: a,
      label: ATTR_LABELS[a],
      value: Number(value.toFixed(2)),
      target: Number(target.toFixed(2)),
      ok,
      diff: Number(diff.toFixed(2)),
    };
  });

  // ---- diagnosis（§5.4：结构性不可达）
  const bounds = structuralBounds(problem);
  const items = [];
  const structurallyUnreachable = [];
  for (let i = 0; i < 9; i += 1) {
    const a = ATTRS[i];
    const value = exact.sim.S[i];
    if (i < 8) {
      const gapS = Math.max(0, problem.targetsS.L[i] - value);
      if (gapS > 0) items.push({ attr: a, label: ATTR_LABELS[a], gap: fmtS(gapS), value: fmtS(value), target: fmtS(problem.targetsS.L[i]) });
      if (bounds.reachable[i] < problem.targetsS.L[i]) {
        structurallyUnreachable.push({
          attr: a,
          label: ATTR_LABELS[a],
          reachable: fmtS(bounds.reachable[i]),
          target: fmtS(problem.targetsS.L[i]),
        });
      }
    } else {
      const gapS = Math.max(0, value - problem.targetsS.U9);
      if (gapS > 0) items.push({ attr: a, label: ATTR_LABELS[a], gap: fmtS(gapS), value: fmtS(value), target: fmtS(problem.targetsS.U9) });
      if (bounds.lowest[i] > problem.targetsS.U9) {
        structurallyUnreachable.push({
          attr: a,
          label: ATTR_LABELS[a],
          reachable: fmtS(bounds.lowest[i]),
          target: fmtS(problem.targetsS.U9),
        });
      }
    }
  }
  items.sort((p, q) => q.gap - p.gap);

  const verdict = buildVerdict(solution, items, objective);

  return {
    status: solution.status,
    horizon: { from: t0, T, displayFrom, displayEnd },
    objective,
    objectiveS: objS,
    verdict,
    saturation: solution.exact.saturation,
    certificate: solution.exact.certificate,
    executable: { weeks, restSlots },
    trajectory,
    terminal,
    checklist,
    diagnosis: { totalGap: objective, items, structurallyUnreachable },
    club: clubAllocation(problem, plan),
    infeasible: null,
    meta: solution.meta,
  };
}

function buildVerdict(solution, items, objective) {
  if (solution.status === 'ok') return '全部达标';
  if (solution.status === 'undetermined') {
    // E10：明确提示为近似结果，不得静默；逐项明细见「达标核对」页签
    const gap = fmtNum(solution.gapS / SCALE, 2);
    return `未确定：搜索预算耗尽，当前方案总差距 ${fmtNum(objective, 2)}，已认证最优性间隙 ≤ ${gap}（近似结果）`;
  }
  if (!items.length) return '未达标';
  return `未达标：总差距 ${fmtNum(objective, 2)}（${items.map((it) => `${it.label} −${fmtNum(it.gap, 2)}`).join('、')}）`;
}

export { simulate, objectiveS, IDX };

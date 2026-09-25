// src/model.js —— buildProblem()：UI 状态 → (CIP) 参数 + 强制扣除 + 目标截断（§3.6 / §5.2）

import {
  ATTRS, ATTR_INDEX, SCALE, S_MIN, S_MAX, S_STAMINA_MIN, S_STRESS_MAX,
  NONE_CLUB, isClubSelected, listCommands, restWeight, deltaS, COMMAND_ORDER,
  clubRequirement, clubDayUnits, CLUB_REST_DAYS, CLUB_COMMAND_ID, CLUB_JOIN_DATE,
} from './spec.js';
import {
  expandCalendar, HOUSE_END, monthEnd, shiftMonth, isSunday,
} from './calendar.js';

export const DEFAULT_CURRENT_DATE = '1995-04-04';

export const DEFAULT_ATTRS = {
  stamina: 100, liberal: 40, science: 40, art: 40, sports: 40,
  popularity: 32, appearance: 60, intellect: 5, stress: 0,
};

export const DEFAULT_TARGETS = {
  stamina: 60, liberal: 80, science: 80, art: 80, sports: 60,
  popularity: 60, appearance: 80, intellect: 60, stress: 50,
};

export function defaultInput() {
  return {
    currentDate: DEFAULT_CURRENT_DATE,
    attrs: { ...DEFAULT_ATTRS },
    targets: { ...DEFAULT_TARGETS },
    club: NONE_CLUB,
    annotations: {},
    weekForces: {},
  };
}

/** 输入校验（C6 / E7）：整数且落在 [0,999] */
export function validateInput(input) {
  const errors = [];
  const warnings = [];
  const intInRange = (v) => Number.isInteger(v) && v >= 0 && v <= 999;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.currentDate || ''))) {
    errors.push('当前日期格式非法（应为 YYYY-MM-DD）');
  }
  for (const a of ATTRS) {
    if (!intInRange(input.attrs?.[a])) errors.push(`当前值「${a}」必须是 [0,999] 的整数`);
    if (!intInRange(input.targets?.[a])) errors.push(`目标值「${a}」必须是 [0,999] 的整数`);
  }
  if (input.club && input.club !== NONE_CLUB && !isClubSelected(input.club)) {
    errors.push(`未知社团: ${input.club}`);
  }
  for (const [date, ann] of Object.entries(input.annotations || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push(`标注日期非法: ${date}`);
    if (!isSunday(date) && ann && ann.skip && !ann.rest) {
      warnings.push(`${date}: 跳过只能从休日进入（D2），该标记将被忽略`);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

/**
 * 求解视野终点：**恒定全局**——一直解到毕业日 1998-03-01（D17 原模式 B 语义）。
 * 不再有「本月 / 两月」视野：两月只是**对外显示切片**（见 displayWindowEnd）。
 */
export function horizonEnd(t0) {
  return HOUSE_END < t0 ? t0 : HOUSE_END;
}

/**
 * 对外显示切片的终点：当前日期起**两个自然月**（当前月 + 下一月）的月末，
 * 且不越过毕业日。结果面板与月历都只呈现这一段（全局解仍算到毕业）。
 */
export function displayWindowEnd(t0, T = horizonEnd(t0)) {
  const twoMonthEnd = monthEnd(shiftMonth(t0, 1));
  const end = twoMonthEnd > T ? T : twoMonthEnd;
  return end < t0 ? t0 : end;
}

/**
 * 构造问题实例（领域层的唯一入口）。
 * @param {Object} rawInput §5.2 的输入模型
 * @param {{now?:string, T?:string, ignoreClub?:boolean, frozen?:Object}} [opts]
 *        opts.T —— 显式指定求解视野终点，供测试 / 交叉校验构造缩小实例；
 *        正常调用（UI）一律留空，恒为毕业日。
 *        opts.ignoreClub —— 缩小的交叉校验实例用：忽略社团指令约束
 *        （该约束跨越整个视野，被截断的视野下必然不可满足）。
 *        opts.frozen —— 增量重规划：把 `before` 之前的决策固定为上一份排程，
 *        只允许改动 `before` 当天及之后的规划。形状：
 *          { before?:string, weekForces?:{[weekStart]:commandId}, restForces?:{[date]:commandId} }
 *        固定的决策点与用户强制走同一条硬约束通道（进入 forcedWeeks / forcedRest，
 *        不进 freeWeeks / freeRest），因此求解器无需任何改动即可正确重解剩余部分。
 */
export function buildProblem(rawInput, opts = {}) {
  const input = normalizeInput(rawInput, opts);
  const validation = validateInput(input);

  const t0 = input.currentDate;
  const T = opts.T || horizonEnd(t0);
  const calendar = expandCalendar(t0, T, input.annotations, input.weekForces);
  const frozen = opts.frozen && opts.frozen.before ? opts.frozen : null;
  if (frozen) applyFrozenPrefix(calendar, frozen);

  const commands = listCommands(input.club);
  const cmdById = new Map(commands.map((c) => [c.id, c]));
  const warnings = [...validation.warnings, ...calendar.warnings];

  const s0 = ATTRS.map((a) => input.attrs[a] * SCALE);
  const targetsS = { L: ATTRS.slice(0, 8).map((a) => input.targets[a] * SCALE), U9: input.targets.stress * SCALE };

  const sFix = new Array(9).fill(0);
  const freeWeeks = [];
  const forcedWeeks = [];
  // 社团最早 1995-04-09 才可加入：该日期之前的决策点不允许「社团活动」
  const clubAllowedOn = (date) => date >= CLUB_JOIN_DATE;
  const weekClubAllowed = (wk) => clubAllowedOn(wk.dates[wk.dates.length - 1]);

  for (const wk of calendar.weeks) {
    if (wk.m === 0) continue; // E3：没有平时日的周不产生决策点
    const clubAllowed = weekClubAllowed(wk);
    if (wk.forced) {
      const cmd = cmdById.get(wk.forced);
      if (!cmd || (cmd.id === CLUB_COMMAND_ID && !clubAllowed)) {
        warnings.push(cmd
          ? `${wk.weekStart}: 社团最早 ${CLUB_JOIN_DATE} 才能加入，「社团活动」已忽略`
          : `${wk.weekStart}: 强制指令「${wk.forced}」不可用（社团未选？），已忽略（E6）`);
        freeWeeks.push({ weekStart: wk.weekStart, m: wk.m, clubAllowed });
        continue;
      }
      const d = deltaS(cmd, wk.m); // m 个平时日当量
      for (let i = 0; i < 9; i += 1) sFix[i] += d[i];
      forcedWeeks.push({
        weekStart: wk.weekStart, m: wk.m, command: cmd.id, clubAllowed, frozen: !!wk.frozen,
      });
    } else {
      freeWeeks.push({ weekStart: wk.weekStart, m: wk.m, clubAllowed });
    }
  }

  const freeRest = [];
  const forcedRest = [];
  for (const slot of calendar.restSlots) {
    const clubAllowed = clubAllowedOn(slot.date);
    if (slot.forced) {
      const cmd = cmdById.get(slot.forced);
      if (!cmd || (cmd.id === CLUB_COMMAND_ID && !clubAllowed)) {
        warnings.push(cmd
          ? `${slot.date}: 社团最早 ${CLUB_JOIN_DATE} 才能加入，「社团活动」已忽略`
          : `${slot.date}: 强制指令「${slot.forced}」不可用（社团未选？），已忽略（E6）`);
        freeRest.push({ date: slot.date, index: slot.index, clubAllowed });
        continue;
      }
      const d = deltaS(cmd, restWeight(cmd)); // R2：一次结算
      for (let i = 0; i < 9; i += 1) sFix[i] += d[i];
      forcedRest.push({
        date: slot.date, command: cmd.id, clubAllowed, frozen: !!slot.frozen,
      });
    } else {
      freeRest.push({ date: slot.date, index: slot.index, clubAllowed });
    }
  }

  // 计数归约参数（§3.6）
  const N = {};
  const NF = {};
  for (const wk of calendar.weeks) N[wk.m] = (N[wk.m] || 0) + 1;
  for (const wk of forcedWeeks) NF[wk.m] = (NF[wk.m] || 0) + 1;
  const M = [...new Set(freeWeeks.map((w) => w.m))].sort((a, b) => a - b);
  const Nfree = {};
  for (const m of M) Nfree[m] = freeWeeks.filter((w) => w.m === m).length;

  // ---- 社团指令约束：截止日前累计「社团分配天数」（每周 6 天、休息日算 6 天）
  const clubReq = opts.ignoreClub ? null : buildClubRequirement(input.club, t0, T, calendar);

  // 对外显示切片（两月）：求解是全局的，显示只有这两天窗（§2.4 D17 调整）
  const displayEnd = displayWindowEnd(t0, T);

  return {
    input,
    club: input.club,
    clubReq,
    t0,
    T,
    displayFrom: t0,
    displayEnd,
    frozenBefore: frozen ? frozen.before : null,
    calendar,
    commands,
    cmdById,
    s0,
    targetsS,
    sFix,
    weeks: calendar.weeks,
    restSlots: calendar.restSlots,
    freeWeeks,
    forcedWeeks,
    freeRest,
    forcedRest,
    counts: {
      M,
      N,
      NF,
      Nfree,
      Htotal: calendar.restSlots.length,
      Hfree: freeRest.length,
      Wfree: freeWeeks.length,
    },
    warnings,
    validation,
    // 求解区间常量（§3.2 / §5.1）
    constants: {
      SCALE, S_MIN, S_MAX, S_STAMINA_MIN, S_STRESS_MAX,
    },
  };
}

/**
 * 增量重规划：把上一份排程在 `frozen.before` 之前的决策固定下来。
 *
 * 固定方式：直接写回 `wk.forced` / `slot.forced`（与用户强制同一条硬约束通道），
 * 并打上 `frozen` 标记供结果面板区分展示；已在 `weekForces` / `annotations.force`
 * 中显式声明的用户强制保持原样，不覆盖。
 */
function applyFrozenPrefix(calendar, frozen) {
  const weekForces = frozen.weekForces || {};
  const restForces = frozen.restForces || {};
  for (const wk of calendar.weeks) {
    const id = weekForces[wk.weekStart];
    if (id && !wk.forced) { wk.forced = id; wk.frozen = true; }
  }
  for (const slot of calendar.restSlots) {
    const id = restForces[slot.date];
    if (id && !slot.forced) { slot.forced = id; slot.frozen = true; }
  }
}

/**
 * 从上一份「已求解的问题 + 排程」推导固定前缀（增量重规划的唯一推导入口）。
 *
 * 判定口径（与 UI 的「编辑点」一致）：
 *  - 平时块：该块**全部**平时日都早于 before 才固定。锚点所在周允许重排 ——
 *    改休日 / 跳过会改变该周的 m 与决策点结构，强行固定反而与用户操作冲突。
 *  - 休日槽：日期早于 before 即固定。
 *
 * @param {Object} problem 上一份 buildProblem 的结果（结构须与本次一致）
 * @param {{weekCmd:Map, restCmd:Map}} plan 上一份排程
 * @param {string} before 编辑点日期（含当天可改）
 * @returns {{before:string, weekForces:Object, restForces:Object}|null}
 */
export function frozenFromPlan(problem, plan, before) {
  if (!problem || !plan || !before) return null;
  const weekForces = {};
  const restForces = {};
  const idOf = (cmd) => (cmd && typeof cmd.id === 'string' ? cmd.id : null);
  for (const wk of problem.weeks) {
    if (wk.m === 0 || !wk.dates.length) continue;
    if (wk.dates[wk.dates.length - 1] >= before) continue; // 锚点所在周允许重排
    const id = idOf(plan.weekCmd.get(wk.weekStart));
    if (id) weekForces[wk.weekStart] = id;
  }
  for (const slot of problem.restSlots) {
    if (slot.date >= before) continue;
    const id = idOf(plan.restCmd.get(slot.date));
    if (id) restForces[slot.date] = id;
  }
  return { before, weekForces, restForces };
}

export function normalizeInput(rawInput = {}, opts = {}) {
  const d = defaultInput();
  return {
    currentDate: rawInput.currentDate || d.currentDate,
    attrs: { ...d.attrs, ...(rawInput.attrs || {}) },
    targets: { ...d.targets, ...(rawInput.targets || {}) },
    club: rawInput.club || NONE_CLUB,
    annotations: { ...(rawInput.annotations || {}) },
    weekForces: { ...(rawInput.weekForces || {}) },
  };
}

/**
 * 社团指令约束（硬）：选定社团后，必须在 `deadline` 前累计 `minDays` 个
 * 「社团分配天数」（计数口径：满周 6 天、休日 6 天）。
 *
 * 生效范围（关键）：
 *  - **只有从游戏开局日期 `1995-04-04` 开始求解时才检查**。其它起点意味着玩家
 *    可能已经攒过社团天数，本工具无从得知，因此不对该计划施加这条硬约束。
 *  - 计数区间是 `[max(t0, 1995-04-09), deadline]`：社团最早 1995-04-09 才可加入。
 *  - 该区间内即使全部选社团也凑不够 `minDays` ⇒ 结构性不可行（无需搜索即判定）。
 */
function buildClubRequirement(club, t0, T, calendar) {
  const req = clubRequirement(club);
  if (!req) return null;
  const deadline = req.deadline > T ? T : req.deadline;
  const fromDefaultStart = t0 === DEFAULT_CURRENT_DATE;
  const windowStart = t0 > CLUB_JOIN_DATE ? t0 : CLUB_JOIN_DATE;
  const active = fromDefaultStart && windowStart <= deadline;

  let capacity = 0;
  for (const wk of calendar.weeks) {
    if (wk.m === 0) continue;
    // 按天计入：跨截止日 / 跨入社日的平时块只算区间内的那些天
    for (const d of wk.dates) if (d >= windowStart && d <= deadline) capacity += 1;
  }
  for (const slot of calendar.restSlots) {
    if (slot.date >= windowStart && slot.date <= deadline) capacity += CLUB_REST_DAYS;
  }

  return {
    ...req,
    deadline,
    joinDate: CLUB_JOIN_DATE,
    fromDefaultStart,
    active,
    capacity,
    feasibleByCapacity: !active || capacity >= req.minDays,
  };
}

/**
 * 计划级的社团分配天数统计（用于结果报告与约束判定）。
 * 平时日使用社团活动计 1 天、休日使用社团活动计 6 天；
 * 只统计 `[max(t0, 1995-04-09), deadline]` 这一段（入社前/截止后都不算）。
 * `plan` 省略时只返回约束本身（无方案时的报告口径）。
 */
export function clubAllocation(problem, plan) {
  const req = problem.clubReq;
  const limit = req ? req.deadline : null;
  const start = req ? (problem.t0 > req.joinDate ? problem.t0 : req.joinDate) : null;
  let before = 0;
  let total = 0;
  if (plan) {
    for (const day of problem.calendar.days) {
      if (day.kind === 'skip') continue;
      const cmd = day.kind === 'rest'
        ? plan.restCmd.get(day.date)
        : plan.weekCmd.get(day.weekStart);
      if (!cmd || cmd.id !== CLUB_COMMAND_ID) continue;
      const units = clubDayUnits(day.kind);
      total += units;
      if ((!limit || day.date <= limit) && (!start || day.date >= start)) before += units;
    }
  }
  const required = req && req.active ? req.minDays : 0;
  return {
    clubId: req ? req.clubId : null,
    name: req ? req.name : null,
    category: req ? req.category : null,
    deadline: limit,
    joinDate: req ? req.joinDate : null,
    minDays: req ? req.minDays : null,
    required,
    active: !!(req && req.active),
    fromDefaultStart: !!(req && req.fromDefaultStart),
    before,
    total,
    satisfied: before >= required,
    capacity: req ? req.capacity : null,
  };
}

/**
 * 独立松弛的可达上界（§5.4「结构性不可达」判定；乐观上界，仅用于诊断）。
 * best_i = clamp( s0_i + s_fix_i + Σ_单位 max_a(scale_a·units_a·T_a[i]) , 0, 999 )
 */
export function structuralBounds(problem) {
  const { commands, s0, sFix, freeWeeks, freeRest } = problem;

  // 单个单位的「乐观最好 / 悲观最坏」S 域贡献
  const unitExtremes = (unitsOf) => {
    const max = new Array(9).fill(-Infinity);
    const min = new Array(9).fill(Infinity);
    for (const cmd of commands) {
      const k = cmd.scale * unitsOf(cmd);
      for (let i = 0; i < 9; i += 1) {
        if (k * cmd.T[i] > max[i]) max[i] = k * cmd.T[i];
        if (k * cmd.T[i] < min[i]) min[i] = k * cmd.T[i];
      }
    }
    return { max, min };
  };

  const best = s0.map((v, i) => v + (sFix[i] || 0));
  const worst = s0.map((v, i) => v + (sFix[i] || 0));

  const bySize = new Map();
  for (const wk of freeWeeks) {
    if (!bySize.has(wk.m)) bySize.set(wk.m, unitExtremes(() => wk.m));
    const { max, min } = bySize.get(wk.m);
    for (let i = 0; i < 9; i += 1) { best[i] += max[i]; worst[i] += min[i]; }
  }
  const restEx = unitExtremes((cmd) => restWeight(cmd));
  for (let s = 0; s < freeRest.length; s += 1) {
    for (let i = 0; i < 9; i += 1) { best[i] += restEx.max[i]; worst[i] += restEx.min[i]; }
  }

  return {
    reachable: best.map((v) => Math.min(S_MAX, Math.max(S_MIN, v))),
    lowest: worst.map((v) => Math.min(S_MAX, Math.max(S_MIN, v))),
  };
}

export { COMMAND_ORDER, ATTR_INDEX };

// src/spec.js —— 18 条指令效果的唯一权威转写（技术文档 §5.1）
//
// 数值 = 技术文档 §5.1 表 A（7 类基础指令）+ 表 B（11 个社团）。
// 表值口径 = 「连续三周选择同一指令」的总变动，且包含每周日那一次决策（C-11 = N1）。
// 本文件是唯一数据源：任何效果数值不得出现在其他文件里（§6 构建纪律）。
//
// 内部整数缩放：S ≡ 180·s（NORM.L = lcm(NORM.base, NORM.club) = 180）
//   S 增量 = scale(cmd) · units · T[cmd]
//     scale(base) = 180/30 = 6 ；scale(club) = 180/36 = 5
//     units = 1（平时日）/ 4（休日槽）/ 6（休日槽且选社团活动）

export const ATTRS = [
  'stamina', 'liberal', 'science', 'art', 'sports',
  'popularity', 'appearance', 'intellect', 'stress',
];

export const ATTR_LABELS = {
  stamina: '体力',
  liberal: '文科',
  science: '理科',
  art: '艺术',
  sports: '运动',
  popularity: '人缘',
  appearance: '容貌',
  intellect: '智力',
  stress: '压力',
};

export const ATTR_INDEX = ATTRS.reduce((m, a, i) => { m[a] = i; return m; }, {});

export const IDX = {
  STAMINA: 0, LIBERAL: 1, SCIENCE: 2, ART: 3, SPORTS: 4,
  POPULARITY: 5, APPEARANCE: 6, INTELLECT: 7, STRESS: 8,
};

// ---------------------------------------------------------------- 常量（§5.1 / §2.2）
export const NORM = { base: 30, club: 36, L: 180 };   // C-11 = N1
export const WEIGHTS = { weekdayPerDay: 1, restSlot: 4, restSlotClub: 6 };
export const PATHS = { staminaMin: 20, stressMax: 70 };
export const CLAMP = { min: 0, max: 999, mode: 'saturate' };  // R3：恒定，不可配置
export const SUNDAY_ALWAYS_REST = true;                       // R1：恒定，不可配置
export const REST_SETTLE_MODE = 'atomic';                     // R2：恒定，不可配置

export const SCALE = NORM.L;                                  // 180
export const S_MIN = CLAMP.min * SCALE;                       // 0
export const S_MAX = CLAMP.max * SCALE;                       // 179820
export const S_STAMINA_MIN = PATHS.staminaMin * SCALE;        // 3600
export const S_STRESS_MAX = PATHS.stressMax * SCALE;          // 12600
export const BASE_SCALE = SCALE / NORM.base;                  // 6
export const CLUB_SCALE = SCALE / NORM.club;                  // 5
export const D_BASE = NORM.base;                              // 30
export const D_CLUB = NORM.club;                              // 36

export const CLUB_COMMAND_ID = 'club';

// ---------------------------------------------------------------- 表 A：7 类基础指令
// 顺序即权威索引序，发布后不得重排（§3.9 的确定性取解规则依赖它）。
export const COMMANDS = [
  { id: 'research', name: '研究文科',     T: [-17,  31,   1,   1,  -9,   8,  -6,  -1,   24] },
  { id: 'science',  name: '研究理科',     T: [-17,   1,  31,   1, -17,   4, -10,   8,   15] },
  { id: 'art',      name: '培养艺术气质', T: [-17,   1,   1,  31, -10,   2,  -3,  -1,    1] },
  { id: 'sports',   name: '运动',         T: [-52,  -3,  -3,  -3, 108,   2, -10,  46,    5] },
  { id: 'chat',     name: '和同学闲聊',   T: [-26,  -6,  -6,  -6,   5,  47,  23,  -4,   23] },
  { id: 'grooming', name: '整理仪容',     T: [-14,  -3,  -3,  -2,  -2,  15,  59,  -7,    8] },
  { id: 'rest',     name: '休息',         T: [113,   0,   0,   0,   0, -14, -17,  -1, -108] },
];

// ---------------------------------------------------------------- 表 B：11 个社团
//
// `kind` / `minDays` / `deadline` 是**社团指令约束**（游戏内硬性要求）：
// 选定社团后，必须在截止日之前累计足够的「社团分配天数」。
// 计数口径 = 「每周 6 天、休息日算 6 天」：
//   一个平时块（周一至周六）按实际天数 m_w 计（满周恰好 6 天）；
//   一个休日槽按 6 天计（与 §3.6 注 1「社团活动作为休日行动权重 6」一致）。
export const CLUBS = [
  { id: 'literature', name: '文艺社', kind: 'culture', minDays: 380, deadline: '1998-01-03', T: [-17,  24,   8,   4,  0,  2, -6, -1, 31] },
  { id: 'drama',      name: '演剧社', kind: 'culture', minDays: 380, deadline: '1998-01-03', T: [-19,  28,   0,  12,  4,  2, -3,  2, 30] },
  { id: 'sciencec',   name: '科学社', kind: 'culture', minDays: 380, deadline: '1998-01-03', T: [-18,   2,  31,   8,  0,  2, -6,  9, 34] },
  { id: 'computer',   name: '电脑社', kind: 'culture', minDays: 380, deadline: '1998-01-03', T: [-18,   2,  30,  13,  0,  9, -9,  9, 39] },
  { id: 'finearts',   name: '美术社', kind: 'culture', minDays: 380, deadline: '1998-01-03', T: [-19,   4,   0,  30,  2,  2, -2, -2, 29] },
  { id: 'wind',       name: '管乐社', kind: 'culture', minDays: 380, deadline: '1998-01-03', T: [-19,   1,   1,  24,  5,  4, -5,  2, 27] },
  { id: 'baseball',   name: '棒球社', kind: 'sports',  minDays: 320, deadline: '1997-08-11', T: [-41,  -2,  -2,  -2, 26,  2, -6, 23,  7] },
  { id: 'football',   name: '足球社', kind: 'sports',  minDays: 350, deadline: '1998-01-03', T: [-41,  -2,  -2,  -2, 28,  4, -5, 21,  8] },
  { id: 'tennis',     name: '网球社', kind: 'sports',  minDays: 350, deadline: '1998-01-03', T: [-35,  -2,  -2,   0, 24,  4, -2, 19, 16] },
  { id: 'swimming',   name: '游泳社', kind: 'sports',  minDays: 350, deadline: '1998-01-03', T: [-43,  -2,  -2,   0, 28,  0, -3, 21,  7] },
  { id: 'basketball', name: '篮球社', kind: 'sports',  minDays: 350, deadline: '1998-01-03', T: [-40,  -2,  -2,  -2, 26,  2, -5, 20, 12] },
];

export const NONE_CLUB = 'none';

/**
 * 社团最早可在 **1995-04-09**（开局后的第一个周日）加入：
 * 该日期之前的决策点不允许使用「社团活动」，也不计入社团分配天数。
 */
export const CLUB_JOIN_DATE = '1995-04-09';

// 8 类指令的权威索引序：7 基础 + 1 类「社团活动」
export const COMMAND_ORDER = [...COMMANDS.map((c) => c.id), CLUB_COMMAND_ID];

// ---------------------------------------------------------------- 查询辅助
const CLUB_BY_ID = CLUBS.reduce((m, c) => { m[c.id] = c; return m; }, {});
const COMMAND_BY_ID = COMMANDS.reduce((m, c) => { m[c.id] = c; return m; }, {});

export function isClubSelected(club) {
  return !!club && club !== NONE_CLUB && !!CLUB_BY_ID[club];
}

export function getClub(club) {
  return CLUB_BY_ID[club] || null;
}

export function authoritativeIndex(commandId) {
  const k = COMMAND_ORDER.indexOf(commandId);
  return k < 0 ? Number.MAX_SAFE_INTEGER : k;
}

/**
 * 展开「8 类指令」为本次求解真正可用的指令描述子。
 * 社团未选时（C4 / D4 / E6）「社团活动」不进入模型。
 * @returns {Array<{id,name,kind:'base'|'club',scale:number,T:number[],clubId?:string}>}
 */
export function listCommands(club) {
  const out = COMMANDS.map((c) => ({
    id: c.id, name: c.name, kind: 'base', scale: BASE_SCALE, T: c.T.slice(),
  }));
  const clubDef = getClub(club);
  if (clubDef) {
    out.push({
      id: CLUB_COMMAND_ID,
      name: `社团活动·${clubDef.name}`,
      kind: 'club',
      scale: CLUB_SCALE,
      T: clubDef.T.slice(),
      clubId: clubDef.id,
    });
  }
  return out;
}

/** 休日槽权重：社团活动（且已选社团）为 6，其余为 4（§3.6 注 1） */
export function restWeight(cmd) {
  return cmd.kind === 'club' ? WEIGHTS.restSlotClub : WEIGHTS.restSlot;
}

/** 休日槽使用社团活动时计入「社团分配天数」的天数（每周 6 天、休息日算 6 天） */
export const CLUB_REST_DAYS = WEIGHTS.restSlotClub; // 6

/**
 * 选定社团对应的**社团指令约束**；未选社团返回 null（C4：社团活动不可用）。
 * @returns {{clubId:string,name:string,category:'culture'|'sports',minDays:number,deadline:string}|null}
 */
export function clubRequirement(club) {
  const def = getClub(club);
  if (!def) return null;
  return {
    clubId: def.id,
    name: def.name,
    category: def.kind,
    minDays: def.minDays,
    deadline: def.deadline,
  };
}

/**
 * 一个决策点（平时日 / 休日）使用社团活动时贡献的「社团分配天数」。
 * 平时日 1 天；休日 6 天。
 */
export function clubDayUnits(day) {
  return day === 'rest' ? CLUB_REST_DAYS : 1;
}

/**
 * S 域增量向量：S += scale(cmd) · units · T[cmd]
 * @param {{scale:number,T:number[]}} cmd
 * @param {number} units 天当量（平时日 1；休日槽 4 / 社团 6）
 */
export function deltaS(cmd, units) {
  if (!cmd || typeof cmd.scale !== 'number') {
    throw new TypeError('deltaS 需要 listCommands() 展开后的指令描述子（含 scale）');
  }
  const k = cmd.scale * units;
  const out = new Array(9);
  for (let i = 0; i < 9; i += 1) out[i] = k * cmd.T[i];
  return out;
}

/** 单个决策点/单位对第 i 项的**最大** S 域贡献（供独立松弛与界复用） */
export function unitMaxPositive(cmd, units, i) {
  return cmd.scale * units * Math.max(0, cmd.T[i]);
}

/** 单个决策点/单位对第 i 项的**最小** S 域贡献（压力下界用） */
export function unitMinSigned(cmd, units, i) {
  return cmd.scale * units * cmd.T[i];
}

// ---------------------------------------------------------------- 负增量报告（§5.1 C-9）
const ALL_EFFECTS = [...COMMANDS, ...CLUBS];

/** 18 条效果中第 i 项的最小增量（C-9：8 项能力须全为负） */
export function minOverCommands(i) {
  return ALL_EFFECTS.reduce((m, c) => Math.min(m, c.T[i]), Infinity);
}

/** 18 条效果中第 i 项的最大增量 */
export function maxOverCommands(i) {
  return ALL_EFFECTS.reduce((m, c) => Math.max(m, c.T[i]), -Infinity);
}

/** 负增量报告：每一项是否存在负增量（§5.1 C-9 判定） */
export function negativeDeltaReport() {
  return ATTRS.map((a, i) => ({
    attr: a,
    min: minOverCommands(i),
    max: maxOverCommands(i),
    hasNegative: minOverCommands(i) < 0,
  }));
}

/** 11 个社团的压力增量（全部为正，C-10） */
export function clubStressVector() {
  return CLUBS.map((c) => c.T[IDX.STRESS]);
}

// ---------------------------------------------------------------- 构建期 + 单测校验（§5.1）
export function validateSpec() {
  const errors = [];
  const check = (cond, msg) => { if (!cond) errors.push(msg); };

  check(COMMANDS.length === 7, `COMMANDS.length 应为 7，实际 ${COMMANDS.length}`);
  check(CLUBS.length === 11, `CLUBS.length 应为 11，实际 ${CLUBS.length}`);
  check(COMMANDS.length + CLUBS.length === 18, '效果条目合计应为 18');

  for (const row of [...COMMANDS, ...CLUBS]) {
    check(Array.isArray(row.T) && row.T.length === 9, `${row.id}: 效果行必须是 9 个整数`);
    check(row.T.every((v) => Number.isInteger(v)), `${row.id}: 效果行必须全为整数`);
    check(typeof row.name === 'string' && row.name.length > 0, `${row.id}: 缺少中文名`);
  }

  // 社团指令约束：分类与门槛齐备，截止日为合法 ISO 日期
  for (const c of CLUBS) {
    check(c.kind === 'culture' || c.kind === 'sports', `${c.id}: 社团分类必须是 culture / sports`);
    check(Number.isInteger(c.minDays) && c.minDays > 0, `${c.id}: 缺少合法的 minDays`);
    check(/^\d{4}-\d{2}-\d{2}$/.test(String(c.deadline)), `${c.id}: 缺少合法的 deadline`);
  }
  const culture = CLUBS.filter((c) => c.kind === 'culture');
  const sports = CLUBS.filter((c) => c.kind === 'sports');
  check(culture.length === 6, `文化社团应为 6 个，实际 ${culture.length}`);
  check(sports.length === 5, `体育社团应为 5 个，实际 ${sports.length}`);
  check(culture.every((c) => c.minDays === 380 && c.deadline === '1998-01-03'), '文化社团门槛应为 380 天 / 1998-01-03');
  check(sports.filter((c) => c.id !== 'baseball').every((c) => c.minDays === 350 && c.deadline === '1998-01-03'), '体育社团（除棒球社）门槛应为 350 天 / 1998-01-03');
  check(CLUBS.find((c) => c.id === 'baseball').minDays === 320, '棒球社门槛应为 320 天');
  check(CLUBS.find((c) => c.id === 'baseball').deadline === '1997-08-11', '棒球社截止日应为 1997-08-11');

  check(NORM.L === 180, 'NORM.L 应为 180');
  check(NORM.L % NORM.base === 0 && NORM.L % NORM.club === 0, 'L 必须是 base/club 的公倍数');
  check(BASE_SCALE === 6 && CLUB_SCALE === 5, 'S 域系数应为 6 / 5');
  check(S_MAX === 179820, 'S 域箱上界应为 179820');
  check(S_STAMINA_MIN === 3600, 'S 域体力下界应为 3600');
  check(S_STRESS_MAX === 12600, 'S 域压力上界应为 12600');

  // C-9：8 项能力全部存在负增量
  for (let i = 0; i < 8; i += 1) {
    check(minOverCommands(i) < 0, `${ATTRS[i]}: 8 项能力必须存在负增量（C-9）`);
  }
  // C-10：11 个社团的压力增量全部为正
  for (const c of CLUBS) {
    check(c.T[IDX.STRESS] > 0, `${c.id}: 社团压力必须为正（C-10）`);
  }
  // 「休息」是唯一降压力、升体力的指令
  const restRow = COMMAND_BY_ID.rest.T;
  check(restRow[IDX.STRESS] < 0 && restRow[IDX.STAMINA] > 0, '「休息」必须升体力、降压力');

  return { ok: errors.length === 0, errors };
}

/**
 * P0 复现（§9）：用 §5.1 的归一化口径反算一行效果表。
 * 三周 = 18 个平时日当量 + 3 个休日槽；S 域总量应恰好等于 180·T。
 */
export function reproduceRow(T, kind) {
  const scale = kind === 'club' ? CLUB_SCALE : BASE_SCALE;
  const units = kind === 'club' ? WEIGHTS.restSlotClub : WEIGHTS.restSlot;
  return T.map((v) => (18 * scale * v) + (3 * units * scale * v));
}

export { COMMAND_BY_ID, CLUB_BY_ID };

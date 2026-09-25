// src/calendar.js —— 自然月分页、周一分界、expandCalendar()（技术文档 §2.3 / §5.2）
//
// 【推导】把「周的键」固定为该周周一的 ISO 日期，把「日的键」固定为 ISO 日期字符串；
// 所有标注按绝对日期保存，翻月 / 改当前日期都不会让标注错位。
//
// R1：周日恒为休日，不可取消；周日可跳过（唯一的退出通道）。

import { SUNDAY_ALWAYS_REST } from './spec.js';

/** 毕业日：求解视野终点（全局，恒为该日） */
export const HOUSE_END = '1998-03-01';

const MS_PER_DAY = 86400000;

/** 'YYYY-MM-DD' → UTC 零点 Date */
export function parseISO(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Date → 'YYYY-MM-DD' */
export function toISO(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(iso, n) {
  return toISO(new Date(parseISO(iso).getTime() + n * MS_PER_DAY));
}

export function diffDays(a, b) {
  return Math.round((parseISO(b).getTime() - parseISO(a).getTime()) / MS_PER_DAY);
}

/** 0 = 周日 … 6 = 周六 */
export function weekdayIndex(iso) {
  return parseISO(iso).getUTCDay();
}

export function isSunday(iso) {
  return weekdayIndex(iso) === 0;
}

/** 周一，作为「周」的键 */
export function mondayOf(iso) {
  const wd = weekdayIndex(iso);
  const back = (wd + 6) % 7;
  return addDays(iso, -back);
}

export function monthStart(iso) {
  return `${iso.slice(0, 7)}-01`;
}

export function monthEnd(iso) {
  const [y, m] = iso.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)); // 下月第 0 天 = 本月最后一天
  return toISO(last);
}

export function shiftMonth(iso, delta) {
  const [y, m] = iso.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return toISO(d);
}

/** 闭区间日期序列 */
export function eachDate(from, to) {
  const out = [];
  let cur = from;
  const n = diffDays(from, to);
  for (let i = 0; i <= n; i += 1) { out.push(cur); cur = addDays(cur, 1); }
  return out;
}

/** 覆盖某月（或任一日期区间）的周一键序列 */
export function mondaysBetween(from, to) {
  const out = [];
  let cur = mondayOf(from);
  const last = mondayOf(to);
  while (cur <= last) { out.push(cur); cur = addDays(cur, 7); }
  return out;
}

/**
 * 展开日历：唯一的「UI 状态 → 模型集合」入口（§5.2）。
 *
 * @param {string} t0 当前日期（存档点）
 * @param {string} T  视野终点
 * @param {Object} annotations 键 = ISO 日期：{ rest?:boolean, skip?:boolean, force?:string }
 *        R1 之后不存在 rest:false 记录；读到旧版本时直接丢弃（§5.5 迁移）。
 * @param {Object} weekForces  键 = 该周周一的 ISO 日期 → 指令 id
 * @returns {{t0:string,T:string,dates:string[],days:Array,weeks:Array,restSlots:Array,
 *            skipped:string[],warnings:string[]}}
 */
export function expandCalendar(t0, T, annotations = {}, weekForces = {}) {
  const warnings = [];
  const dates = eachDate(t0, T);
  const days = [];
  const skipped = [];
  const weekMap = new Map();
  const restSlots = [];

  // 【推导】W 取与 D 相交的全部 ISO 周；m_w = 0 的周也保留（§3.6 注 2 / E3）
  for (const ws of mondaysBetween(t0, T)) {
    weekMap.set(ws, { weekStart: ws, m: 0, dates: [], forced: null, forcedRaw: null });
  }

  for (const date of dates) {
    const ann = annotations[date] || {};
    const wd = weekdayIndex(date);
    const weekStart = mondayOf(date);
    const forced = typeof ann.force === 'string' && ann.force ? ann.force : null;

    if (wd === 0 ? !!ann.skip : (!!ann.skip && !!ann.rest)) {
      // 跳过：不参与计算（无决策、无属性变化、不计入平时块）
      days.push({ date, kind: 'skip', weekStart, restIndex: null, forced: null });
      skipped.push(date);
      continue;
    }

    const isRest = wd === 0 || ann.rest === true;
    if (ann.rest === false) {
      // R1 迁移：annotations 不再有 rest:false；显式读到即丢弃
      warnings.push(wd === 0
        ? `${date}: 周日恒为休日（R1），忽略历史遗留的 rest:false 标注`
        : `${date}: 忽略历史遗留的 rest:false 标注（R1：只有用户标记的休日可取消）`);
    }
    if (wd !== 0 && ann.skip && !ann.rest) {
      warnings.push(`${date}: 跳过只能从休日进入（D2/E5），已忽略该 skip 标记`);
    }

    if (isRest) {
      const index = restSlots.length;
      restSlots.push({ date, index, forced, sunday: wd === 0 });
      days.push({ date, kind: 'rest', weekStart, restIndex: index, forced });
    } else {
      const wk = weekMap.get(weekStart);
      wk.dates.push(date);
      wk.m += 1;
      days.push({ date, kind: 'weekday', weekStart, restIndex: null, forced: null });
    }
  }

  // 周的强制指令（键 = 该周周一 ISO）；无平时日的周不产生决策点（E3）
  const weeks = [...weekMap.values()].sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1));
  for (const wk of weeks) {
    const raw = weekForces[wk.weekStart];
    wk.forcedRaw = raw || null;
    if (!raw) { wk.forced = null; continue; }
    if (wk.m === 0) {
      warnings.push(`${wk.weekStart}: 该周没有平时日（m=0），强制指令被忽略（E3）`);
      wk.forced = null;
    } else {
      wk.forced = raw;
    }
  }

  return { t0, T, dates, days, weeks, restSlots, skipped, warnings };
}

/** 判断日期是否落在求解区间内 */
export function inRange(iso, t0, T) {
  return iso >= t0 && iso <= T;
}

export { SUNDAY_ALWAYS_REST };

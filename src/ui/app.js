// src/ui/app.js —— 月历网格 / 单元格状态机 / 批量框选 / 结果面板 / 主题（技术文档 §7）
//
// R1：周日恒为休日，不可取消；周日唯一的退出通道是「跳过」。
// R2：休日 4（社团 6）天当量一次结算，往返 UI 只表达"一条指令"。
//
// 本次 UI 调整（相对 §7.2 原文）：
//   1) 可输入日期仅限 95 年 4 月 ~ 98 年 3 月（毕业日），越界存档夹回范围内；
//   2) 结果区简化为「结论条 + 一行元信息 + 三个页签（排程指令 / 达标核对 / 属性轨迹）」；
//   3) 三块（月历 / 输入 / 结果）重新排版：月历两月视图占满整行，输入与结果并排；
//   4) 日历改为周日第一列（行 = 周日…周六，行键仍是该周周一）；
//   5) **取消视野 A/B 选择**：求解恒为全局（当前日期 → 毕业 1998-03-01），
//      对外只显示「月历当前两月窗口」的切片；翻月即换切片，无需重新求解。

import {
  ATTRS, ATTR_LABELS, CLUBS, NONE_CLUB, COMMAND_ORDER, IDX, CLUB_JOIN_DATE,
} from '../spec.js';
import {
  addDays, isSunday, monthEnd, shiftMonth, mondaysBetween,
} from '../calendar.js';
import { buildProblem, validateInput, defaultInput } from '../model.js';
import { solve } from '../solver.js';
import { assembleResult } from '../result.js';
import { createStore } from '../store.js';

// 周日排在第一列（需求 4）：行 = 周日…周六，行键仍取该周周一的 ISO 日期
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

// 可输入 / 可标注的日期范围（§2.2 / §2.5）：95 年 4 月 ~ 98 年 3 月（毕业日 1998-03-01）
const DATE_MIN = '1995-04-01';
const DATE_MAX = '1998-03-01';
const MONTH_MIN = DATE_MIN.slice(0, 7);   // 1995-04
const MONTH_MAX = DATE_MAX.slice(0, 7);   // 1998-03
/** 两月窗口最后一次可用的起始月（第二月 = 起始月 + 1） */
const MONTH_LAST_START = shiftMonth(`${MONTH_MAX}-01`, -1).slice(0, 7); // 1998-02

/** 把任意日期夹到 [DATE_MIN, DATE_MAX] */
export function clampDate(iso) {
  const s = String(iso || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return DATE_MIN;
  if (s < DATE_MIN) return DATE_MIN;
  if (s > DATE_MAX) return DATE_MAX;
  return s;
}

/** 把两月窗口的起始月夹到合法范围 */
export function clampWindowStart(ym) {
  const s = String(ym || '');
  if (!/^\d{4}-\d{2}$/.test(s)) return MONTH_MIN;
  if (s < MONTH_MIN) return MONTH_MIN;
  if (s > MONTH_LAST_START) return MONTH_LAST_START;
  return s;
}

/** '1995-04' → '1995 年 4 月' */
function monthLabel(ym) {
  return `${ym.slice(0, 4)} 年 ${Number(ym.slice(5, 7))} 月`;
}

/** 允许的日期 / 两月窗口范围（供测试与 UI 复用） */
export const DATE_RANGE = {
  DATE_MIN, DATE_MAX, MONTH_MIN, MONTH_MAX, MONTH_LAST_START,
};

/**
 * 两月显示窗口 = 月历窗口（起始月 + 下一月）∩ [t0, T]（纯函数，便于测试）。
 * 完全落在 [t0, T] 之外时返回 null，由调用方回退到默认窗口。
 */
export function twoMonthWindow(monthStart, t0, T) {
  const start = `${monthStart}-01`;
  const end = monthEnd(shiftMonth(start, 1)); // 第二月月末
  const from = start < t0 ? t0 : start;
  const to = end > T ? T : end;
  return from > to ? null : { displayFrom: from, displayEnd: to };
}

export function mountApp(root) {
  const store = createStore();
  const state = {
    input: defaultInput(),
    annotations: {},
    ui: { theme: 'light', month: null, tab: 'plan' },
    problem: null,
    solution: null,
    result: null,
    error: null,
    sel: null,
    dragging: false,
    messages: [],
  };

  // ---- 载入存档（§5.5）
  if (store.loaded.input) {
    state.input = { ...defaultInput(), ...store.loaded.input };
  }
  state.annotations = store.loaded.annotations || {};
  state.ui = { ...state.ui, ...(store.loaded.ui || {}) };
  delete state.ui.mode; // 视野选择已取消，清掉旧存档里的残留键
  state.input.annotations = state.annotations;
  // 可输入日期仅限 95 年 4 月 ~ 98 年 3 月：越界存档直接夹回范围内
  state.input.currentDate = clampDate(state.input.currentDate);
  state.ui.month = clampWindowStart(state.ui.month || state.input.currentDate.slice(0, 7));
  state.messages = store.loaded.messages || [];

  document.body.dataset.theme = state.ui.theme === 'dark' ? 'dark' : 'light';

  // 兼容 `$('#id')` 与 `$('id')` 两种写法
  const $ = (sel) => root.querySelector(String(sel).startsWith('#') ? sel : `#${sel}`);

  // ================================================================ 输入面板
  function renderInputs() {
    const clubOpts = [`<option value="${NONE_CLUB}">不参加社团</option>`]
      .concat(CLUBS.map((c) => `<option value="${c.id}"${state.input.club === c.id ? ' selected' : ''}>${c.name}</option>`))
      .join('');
    const attrRows = ATTRS.map((a, i) => `
      <span class="h">${ATTR_LABELS[a]}${i === IDX.STRESS ? '（≤）' : '（≥）'}</span>
      <input type="number" min="0" max="999" step="1" data-kind="attr" data-key="${a}" value="${state.input.attrs[a]}">
      <input type="number" min="0" max="999" step="1" data-kind="target" data-key="${a}" value="${state.input.targets[a]}">
    `).join('');

    $('#input-card').innerHTML = `
      <h2>输入</h2>
      <div class="row">
        <label>当前日期 <input type="date" id="in-date" min="${DATE_MIN}" max="${DATE_MAX}" value="${state.input.currentDate}"></label>
        <label>社团 <select id="in-club">${clubOpts}</select></label>
      </div>
      <div class="hint" style="margin-top:4px">日期范围 ${DATE_MIN} ~ ${DATE_MAX}（95 年 4 月 ~ 98 年 3 月，共 36 个月）</div>
      <div class="hint" style="margin-top:2px">求解区间固定为「当前日期 → 毕业 1998-03-01」；结果与月历都只显示当前两月。</div>
      <div class="grid2" style="margin-top:8px">
        <span class="h"></span><span class="h">当前值</span><span class="h">目标值</span>
        ${attrRows}
      </div>
      <div class="row" style="margin-top:10px">
        <button class="primary" id="btn-solve">求解</button>
        <button id="btn-reset">恢复默认</button>
        <span class="hint" id="solve-hint"></span>
      </div>`;

    $('#in-date').addEventListener('change', (e) => {
      state.input.currentDate = clampDate(e.target.value || state.input.currentDate);
      e.target.value = state.input.currentDate;
      state.ui.month = clampWindowStart(state.input.currentDate.slice(0, 7));
      persist(); renderCalendar(); scheduleSolve();
    });
    $('#in-club').addEventListener('change', (e) => {
      state.input.club = e.target.value;
      persist(); scheduleSolve();
    });
    $('#input-card').addEventListener('input', (e) => {
      const t = e.target;
      if (!t.dataset || !t.dataset.kind) return;
      const v = Number(t.value);
      const ok = Number.isInteger(v) && v >= 0 && v <= 999;
      t.classList.toggle('invalid', !ok);
      if (!ok) return;
      if (t.dataset.kind === 'attr') state.input.attrs[t.dataset.key] = v;
      else state.input.targets[t.dataset.key] = v;
      persist(); scheduleSolve();
    });
    $('#btn-solve').addEventListener('click', () => runSolve());
    $('#btn-reset').addEventListener('click', () => {
      state.input = defaultInput();
      state.input.annotations = state.annotations;
      persist(); renderInputs(); runSolve();
    });
  }

  // ================================================================ 月历
  function horizon() {
    if (state.problem) return { t0: state.problem.t0, T: state.problem.T, weeks: state.problem.weeks };
    const p = safeProblem();
    return p ? { t0: p.t0, T: p.T, weeks: p.weeks } : { t0: state.input.currentDate, T: state.input.currentDate, weeks: [] };
  }

  /**
   * 对外显示切片 = 月历当前的两月窗口 ∩ [t0, T]。
   * 求解恒为全局，翻月只是换一个两月切片重看，不需要重新求解。
   */
  function displayWindow(problem) {
    const monthStart = clampWindowStart(state.ui.month || state.input.currentDate.slice(0, 7));
    return twoMonthWindow(monthStart, problem.t0, problem.T)
      || { displayFrom: problem.displayFrom, displayEnd: problem.displayEnd };
  }

  /** 只重新切片 + 重绘结果（不重新求解） */
  function refreshDisplay() {
    if (!state.problem || !state.solution) return;
    state.result = assembleResult(state.problem, state.solution, displayWindow(state.problem));
    renderResults();
  }

  function safeProblem() {
    try { return buildProblem(state.input); } catch (e) { return null; }
  }

  function renderCalendar() {
    // 两月窗口（需求 5）：起始月 + 下一月，且整体夹在 95-04 ~ 98-03 内
    const m1 = clampWindowStart(state.ui.month || state.input.currentDate.slice(0, 7));
    state.ui.month = m1;
    const window2 = [m1, shiftMonth(`${m1}-01`, 1).slice(0, 7)];

    const { t0, T, weeks: probWeeks } = horizon();
    const weekIndex = new Map(probWeeks.map((w, i) => [w.weekStart, i + 1]));
    const plan = state.result && state.result.executable ? state.result.executable : null;
    const restCmd = new Map();
    const weekCmd = new Map();
    if (plan) {
      for (const r of plan.restSlots) restCmd.set(r.date, r);
      for (const w of plan.weeks) weekCmd.set(w.weekStart, w);
    }
    const traj = new Map();
    if (state.result) for (const row of state.result.trajectory) traj.set(row.date, row);

    const cmdOptions = (selected, allowAuto, allowClub = true) => {
      const list = COMMAND_ORDER.map((id) => {
        if (id === 'club' && (!allowClub || !(state.input.club && state.input.club !== NONE_CLUB))) return '';
        const nm = id === 'club'
          ? `社团活动·${(CLUBS.find((c) => c.id === state.input.club) || {}).name || ''}`
          : (COMMAND_ORDER.indexOf(id) >= 0 ? labelOf(id) : id);
        return `<option value="${id}"${selected === id ? ' selected' : ''}>${nm}</option>`;
      }).join('');
      return `${allowAuto ? `<option value="">自动</option>` : ''}${list}`;
    };

    /** 单个自然月的周行网格（行 = 周日…周六，行键 = 该周周一） */
    function monthTable(ym) {
      const first = `${ym}-01`;
      const last = monthEnd(first);
      let html = '<table class="grid"><thead><tr><th class="wkh">周</th>'
        + WEEKDAYS.map((d) => `<th${d === '日' ? ' class="sunh"' : ''}>${d}</th>`).join('')
        + '</tr></thead><tbody>';

      for (const ws of mondaysBetween(first, last)) {
        // i = 0 → 周日（ws 前一天）；i = 1..6 → 周一..周六
        const dates = WEEKDAYS.map((_, i) => addDays(ws, i - 1));
        const inWin = dates.filter((d) => d >= t0 && d <= T);
        const wno = weekIndex.get(ws);
        const forced = state.input.weekForces[ws] || '';
        const res = weekCmd.get(ws);
        // 平时块 = 周一至周六（周日恒为休日，不参与计数）；dates[6] = 该周周六
        const blockDays = dates.slice(1).filter((d) => d >= t0 && d <= T);
        const weekdayCount = blockDays.filter((d) => !isRestLike(d)).length;
        // 行首描述的是「该周的平时块」，所以区间取周一至周六这一段（不含周日）
        const rangeText = wno && blockDays.length
          ? `${blockDays[0].slice(5)}~${blockDays[blockDays.length - 1].slice(5)}`
          : '区间外';
        // 「第 N 周 / 日期区间 / M 天」各占一行（原来用 · 分隔）
        const wkLines = wno ? [`第 ${wno} 周`, rangeText, `${weekdayCount} 天`] : ['区间外'];
        const weekClubOk = dates[6] >= CLUB_JOIN_DATE; // 社团最早 1995-04-09 才可加入
        html += '<tr>';
        html += `<td class="wkcell"><div class="wk">${wkLines.map((l) => `<span class="wkline">${l}</span>`).join('')}</div>`;
        if (wno) {
          html += `<select data-week="${ws}" class="${forced ? 'locked' : ''}" title="整周指令">${cmdOptions(forced, true, weekClubOk)}</select>`;
        } else {
          html += '<div class="hint">—</div>';
        }
        html += '</td>';
        for (const d of dates) html += cellHtml(d, t0, T, res, restCmd, traj);
        html += '</tr>';
      }
      html += '</tbody></table>';
      return html;
    }

    const legend = `
      <div class="legend">
        <span><i style="background:var(--block);border-color:var(--block-line)"></i>平时日（周一至周六共享一条指令）</span>
        <span><i style="background:var(--rest);border-color:var(--rest-line)"></i>休日（4 天当量，独立指令）</span>
        <span><i style="background:var(--skip)"></i>跳过（不参与计算）</span>
        <span>周日固定为休日（第一列）</span><span>🔒 强制指令</span><span>〔跳〕跳过</span><span>⚠ 体力&lt;20 / 压力&gt;70</span>
      </div>`;

    const prevDisabled = m1 <= MONTH_MIN;
    const nextDisabled = m1 >= MONTH_LAST_START;

    $('#calendar-card').innerHTML = `
      <h2>月历标注 · 两月视图</h2>
      <div class="calhead">
        <button id="cal-prev"${prevDisabled ? ' disabled' : ''}>‹</button>
        <span class="month">${window2[0]} ~ ${window2[1]}</span>
        <button id="cal-next"${nextDisabled ? ' disabled' : ''}>›</button>
        <button id="cal-now">回到当前月</button>
        <span class="sp" style="flex:1"></span>
        <span class="hint">求解区间 ${t0} ~ ${T}</span>
      </div>
      <div id="cal-grid" class="months">
        ${window2.map((ym) => `<div class="monthblock"><div class="mhead">${monthLabel(ym)}</div>${monthTable(ym)}</div>`).join('')}
      </div>
      ${legend}
      <div id="cal-batch"></div>`;

    $('#cal-prev').addEventListener('click', () => {
      state.ui.month = clampWindowStart(shiftMonth(`${m1}-01`, -1).slice(0, 7));
      persist(); renderCalendar(); refreshDisplay();
    });
    $('#cal-next').addEventListener('click', () => {
      state.ui.month = clampWindowStart(shiftMonth(`${m1}-01`, 1).slice(0, 7));
      persist(); renderCalendar(); refreshDisplay();
    });
    $('#cal-now').addEventListener('click', () => {
      state.ui.month = clampWindowStart(state.input.currentDate.slice(0, 7));
      persist(); renderCalendar(); refreshDisplay();
    });
    $('#cal-grid').addEventListener('change', (e) => {
      const ws = e.target.dataset && e.target.dataset.week;
      if (!ws) return;
      const v = e.target.value;
      if (v) state.input.weekForces[ws] = v; else delete state.input.weekForces[ws];
      persist(); renderCalendar(); scheduleSolve();
    });
    renderBatch();
  }

  function isRestLike(date) {
    const a = state.annotations[date] || {};
    return isSunday(date) || a.rest === true;
  }

  function cellHtml(date, t0, T, weekRes, restCmd, traj) {
    const ann = state.annotations[date] || {};
    const sun = isSunday(date);
    const inWin = date >= t0 && date <= T;
    const rest = sun || ann.rest === true;
    const skip = !!ann.skip && rest;
    const kind = skip ? 'skip' : (rest ? 'rest' : 'weekday');
    const cls = ['day'];
    if (!inWin) cls.push('out');
    else if (kind === 'skip') cls.push('skip');
    else if (kind === 'rest') cls.push('rest');
    if (sun && inWin) cls.push('sun');
    if (ann.force && inWin) cls.push('locked');
    if (state.sel && inRangeSel(state.sel, date)) cls.push('sel');

    let badge = '';
    if (inWin) {
      if (ann.force) badge += '🔒';
      if (kind === 'skip') badge += '〔跳〕';
      else if (kind === 'rest' && !sun) badge += '〔休〕';
    }

    let sub = '';
    if (inWin && state.result) {
      if (kind === 'rest') {
        const r = restCmd.get(date);
        if (r && r.commandName) sub = r.commandName;
      } else if (kind === 'weekday' && weekRes) {
        sub = weekRes.commandName || '';
      }
    }
    const row = traj.get(date);
    const viol = row && row.violations && row.violations.length
      ? `<span class="viol">⚠${row.violations.map((v) => (v === 'stamina' ? '体' : '压')).join('')}</span>` : '';

    // 日历格子空间有限：社团指令只显示社团名（如「游泳社」），不显示「社团活动·」前缀
    const label = sub.indexOf('社团活动·') === 0 ? sub.slice('社团活动·'.length) : sub;

    const title = inWin ? '' : '不在求解区间内（当前日期 ~ 毕业 1998-03-01）';
    return `<td><div class="${cls.join(' ')}" data-date="${date}" title="${title}">
      <div class="d">${Number(date.slice(8))}</div>
      <div class="m">${label}</div>
      <span class="badge">${badge}</span>${viol}
    </div></td>`;
  }

  function labelOf(cmdId) {
    const map = {
      research: '研究文科', science: '研究理科', art: '培养艺术气质', sports: '运动',
      chat: '和同学闲聊', grooming: '整理仪容', rest: '休息', club: '社团活动',
    };
    return map[cmdId] || cmdId;
  }

  // ================================================================ 选择 / 菜单
  function inRangeSel(sel, date) {
    const [a, b] = sel.a <= sel.b ? [sel.a, sel.b] : [sel.b, sel.a];
    return date >= a && date <= b;
  }

  function renderBatch() {
    const box = $('#cal-batch');
    if (!box) return;
    if (!state.sel || state.sel.a === state.sel.b) { box.innerHTML = ''; return; }
    const [a, b] = state.sel.a <= state.sel.b ? [state.sel.a, state.sel.b] : [state.sel.b, state.sel.a];
    box.innerHTML = `<div class="batch">
      <span>已选 ${a} ~ ${b}</span>
      <button data-act="rest">全部设为休日</button>
      <button data-act="skip">全部跳过</button>
      <button data-act="clear">清除标记</button>
      <button data-act="cancel">取消选择</button>
    </div>`;
    box.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => batchApply(btn.dataset.act, a, b));
    });
  }

  function batchApply(act, a, b) {
    const dates = [];
    let cur = a;
    while (cur <= b) { dates.push(cur); cur = addDays(cur, 1); }
    let sundayTouched = false;
    for (const d of dates) {
      const sun = isSunday(d);
      const ann = { ...(state.annotations[d] || {}) };
      if (sun) sundayTouched = true;
      if (act === 'rest') {
        if (!sun) ann.rest = true;
        delete ann.skip;
      } else if (act === 'skip') {
        if (sun) ann.skip = true;
        else { ann.rest = true; ann.skip = true; }
      } else if (act === 'clear') {
        if (sun) { delete ann.skip; delete ann.force; }
        else { delete ann.rest; delete ann.skip; delete ann.force; }
      }
      if (Object.keys(ann).length) state.annotations[d] = ann; else delete state.annotations[d];
    }
    // 强制指令与跳过互斥（§5.3）
    for (const d of dates) {
      if (state.annotations[d] && state.annotations[d].skip) delete state.annotations[d].force;
    }
    if (act === 'clear' && sundayTouched) toast('周日固定为休日，「清除标记」只清除跳过与强制');
    else if (act === 'rest' && sundayTouched) toast('周日固定为休日，无需设置');
    persist(); renderCalendar(); scheduleSolve();
  }

  let menuEl = null;
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }

  function openMenu(date) {
    closeMenu();
    const sun = isSunday(date);
    const ann = state.annotations[date] || {};
    const rest = sun || ann.rest === true;
    const skip = !!ann.skip && rest;
    const clubOk = state.input.club && state.input.club !== NONE_CLUB;
    const items = [];
    if (!sun && !rest) items.push(['设为休日', () => setAnn(date, { rest: true })]);
    if (!sun && rest) items.push(['取消休日', () => setAnn(date, null)]);
    if (rest && !skip) items.push(['跳过这一天', () => setAnn(date, { rest: !sun ? true : undefined, skip: true })]);
    if (skip) items.push(['恢复', () => setAnn(date, rest ? { rest: !sun ? true : undefined, skip: false } : null)]);
    const clubAllowed = date >= CLUB_JOIN_DATE; // 社团最早 1995-04-09 才可加入
    const cmdOpts = COMMAND_ORDER
      .filter((id) => id !== 'club' || (clubOk && clubAllowed))
      .map((id) => `<option value="${id}"${ann.force === id ? ' selected' : ''}>${labelOf(id)}</option>`).join('');

    menuEl = document.createElement('div');
    menuEl.className = 'menu';
    menuEl.innerHTML = `
      ${items.map((it, i) => `<button data-i="${i}">${it[0]}</button>`).join('')}
      ${items.length ? '<div class="sep"></div>' : ''}
      <div style="font-size:11px;color:var(--muted);padding:2px 6px">强制指令</div>
      <select id="menu-force"><option value="">自动（交给求解器）</option>${cmdOpts}</select>
      ${skip ? '<div class="hint" style="padding:4px 6px">跳过的日子没有决策可强制</div>' : ''}
      <div class="sep"></div>
      <div class="hint" style="padding:2px 6px">${date}${sun ? '（周日恒为休日）' : ''}${!clubAllowed ? `（社团最早 ${CLUB_JOIN_DATE} 加入）` : ''}</div>`;
    document.body.appendChild(menuEl);
    const rect = document.querySelector(`.day[data-date="${date}"]`).getBoundingClientRect();
    menuEl.style.left = `${Math.min(rect.left + window.scrollX, window.innerWidth - 220)}px`;
    menuEl.style.top = `${rect.bottom + window.scrollY + 4}px`;
    items.forEach((it, i) => {
      menuEl.querySelector(`button[data-i="${i}"]`).addEventListener('click', () => { it[1](); closeMenu(); });
    });
    menuEl.querySelector('#menu-force').addEventListener('change', (e) => {
      const v = e.target.value;
      if (skip) { toast('跳过的日子没有决策可强制（§5.3 互斥）'); return; }
      const next = { ...(state.annotations[date] || {}) };
      if (v) next.force = v; else delete next.force;
      setAnn(date, Object.keys(next).length ? next : null);
      closeMenu();
    });
  }

  function setAnn(date, value) {
    if (value === null) delete state.annotations[date];
    else {
      const clean = {};
      const sun = isSunday(date);
      if (!sun && value.rest) clean.rest = true;
      if (value.skip) clean.skip = true;
      if (value.force && !value.skip) clean.force = value.force;
      if (Object.keys(clean).length) state.annotations[date] = clean; else delete state.annotations[date];
    }
    persist(); renderCalendar(); scheduleSolve();
  }

  // ---- 拖拽框选
  root.addEventListener('mousedown', (e) => {
    const cell = e.target.closest && e.target.closest('.day');
    if (!cell || cell.classList.contains('out')) return;
    e.preventDefault();
    state.dragging = true;
    state.sel = { a: cell.dataset.date, b: cell.dataset.date };
    renderCalendar();
  });
  root.addEventListener('mouseover', (e) => {
    if (!state.dragging) return;
    const cell = e.target.closest && e.target.closest('.day');
    if (!cell) return;
    if (state.sel && state.sel.b !== cell.dataset.date) {
      state.sel = { ...state.sel, b: cell.dataset.date };
      renderCalendar();
    }
  });
  document.addEventListener('mouseup', () => {
    if (!state.dragging) return;
    state.dragging = false;
    const sel = state.sel;
    if (sel && sel.a === sel.b) { state.sel = null; renderCalendar(); openMenu(sel.a); }
    else renderBatch();
  });
  document.addEventListener('mousedown', (e) => {
    if (menuEl && !menuEl.contains(e.target) && !(e.target.closest && e.target.closest('.day'))) closeMenu();
  });

  // ================================================================ 求解
  let solveTimer = null;
  function scheduleSolve() {
    if (solveTimer) clearTimeout(solveTimer);
    solveTimer = setTimeout(() => { solveTimer = null; runSolve(); }, 320);
  }

  function collectInput() {
    return {
      ...state.input,
      annotations: JSON.parse(JSON.stringify(state.annotations)),
    };
  }

  function runSolve(silent) {
    const input = collectInput();
    state.input.annotations = state.annotations;
    const v = validateInput(input);
    if (!v.ok) {
      state.error = v.errors;
      renderResults();
      return;
    }
    let problem = null;
    let solution = null;
    let result = null;
    const t = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    try {
      problem = buildProblem(input);
      solution = solve(problem);
      result = assembleResult(problem, solution, displayWindow(problem));
      result.elapsedMs = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t);
      state.error = null;
    } catch (e) {
      state.error = [`求解失败：${e && e.message ? e.message : e}`];
      return;
    }
    state.problem = problem;
    state.solution = solution;
    state.result = result;
    renderResults();
    renderCalendar();
    if (!silent) {
      const hint = $('#solve-hint');
      if (hint) hint.textContent = `用时 ${result.elapsedMs} ms · 状态 ${result.status}`;
    }
  }

  // ================================================================ 结果面板（简化版）
  //
  // 只保留两块：① 结论条（三态）+ 一行元信息；② 页签「排程指令 / 达标核对 / 属性轨迹」，
  // 每页签只放一张表。**有方案时不显示任何诊断提示**；只有「没有解」才给出归因框。
  // 原「逐周指令」「逐休日指令」合并为一张按日期排序的指令表；
  // 原「差距诊断」「结构性不可达」并入「达标核对」，不再重复列表。
  function renderResults() {
    const card = $('#result-card');
    if (state.error && state.error.length) {
      card.innerHTML = `<h2>结果</h2><div class="warnbox">${state.error.map(esc).join('<br>')}</div>`;
      return;
    }
    const r = state.result;
    if (!r) {
      card.innerHTML = '<h2>结果</h2><div class="hint">点击「求解」生成排程。</div>';
      return;
    }
    const cls = r.status === 'ok' ? 'ok' : (r.status === 'path_infeasible' ? 'bad' : (r.status === 'undetermined' ? 'warn' : 'bad'));

    const TABS = ['plan', 'check', 'traj'];
    const activeTab = TABS.includes(state.ui.tab) ? state.ui.tab : 'plan';

    // ---- 指令页：逐周 + 逐休日合并成一张按时间排序的表
    function planPanel(res) {
      const allWeeks = state.problem ? state.problem.weeks : [];
      const rows = [];
      res.executable.weeks.forEach((w, i) => {
        const no = allWeeks.findIndex((x) => x.weekStart === w.weekStart);
        rows.push({
          sort: w.from || w.weekStart,
          date: w.range,
          type: `第 ${no >= 0 ? no + 1 : i + 1} 周 · 平时块 ${w.blockDays} 天`,
          cmd: w.commandName || '—',
          mark: w.forced ? '🔒 强制' : '',
        });
      });
      res.executable.restSlots.forEach((s) => {
        rows.push({
          sort: s.date,
          date: s.date.slice(5),
          type: s.skipped ? '跳过' : (isSunday(s.date) ? '休日 · 周日' : '休日'),
          cmd: s.skipped ? '—' : (s.commandName || '—'),
          mark: s.forced ? '🔒 强制' : '',
        });
      });
      rows.sort((a, b) => (a.sort < b.sort ? -1 : (a.sort > b.sort ? 1 : 0)));

      let h = `<h3 class="ptitle">显示区间 ${res.horizon.displayFrom} ~ ${res.horizon.displayEnd}（逐周指令 + 逐休日指令）</h3>`;
      // 社团指令约束（硬性要求）的完成情况：只在选中社团时给出这一条状态
      if (res.club && res.club.clubId) {
        const c = res.club;
        let head = '社团分配（全程累计）';
        let tail;
        if (c.active) {
          tail = `${c.before} / 需 ${c.required} 天 · 截止 ${c.deadline}`;
        } else if (!c.fromDefaultStart) {
          head = '社团分配';
          tail = `仅从开局 1995-04-04 开始求解时检查（需 ${c.minDays} 天 / 截止 ${c.deadline}）`;
        } else {
          head = '社团分配';
          tail = `截止 ${c.deadline} 已过，本次计划不再检查`;
        }
        h += `<div class="clubline${c.active && !c.satisfied ? ' bad' : ''}">`
          + `${head}：${esc(c.name)} · ${esc(tail)}</div>`;
      }
      h += '<table class="res"><thead><tr><th>日期</th><th>类型</th><th>指令</th><th>备注</th></tr></thead><tbody>';
      if (!rows.length) h += '<tr><td colspan="4">（显示区间内没有决策点）</td></tr>';
      for (const row of rows) {
        h += `<tr><td>${esc(row.date)}</td><td>${esc(row.type)}</td><td>${esc(row.cmd)}</td><td>${esc(row.mark)}</td></tr>`;
      }
      h += '</tbody></table>';
      return h;
    }

    // ---- 核对页：终点九项 + 结构不可达合并（不再单列「差距诊断」）
    function checkPanel(res) {
      const unreach = new Map((res.diagnosis.structurallyUnreachable || []).map((u) => [u.attr, u]));
      let h = `<h3 class="ptitle">达标核对（毕业终点 ${res.horizon.T}）</h3>`;
      h += '<table class="res"><thead><tr><th>属性</th><th>终点值</th><th>目标</th><th>差</th><th>结果</th></tr></thead><tbody>';
      for (const c of res.checklist) {
        const u = unreach.get(c.attr);
        h += `<tr class="${c.ok ? '' : 'bad'}"><td>${esc(c.label)}</td><td>${c.value}</td><td>${c.target}</td>`
          + `<td>${c.diff > 0 ? '+' : ''}${c.diff}</td>`
          + `<td>${c.ok ? '✓' : (u ? '✗ 不可达' : '✗')}</td></tr>`;
      }
      h += '</tbody></table>';
      if (unreach.size) {
        h += '<div class="hint" style="margin-top:5px">结构性不可达（全局乐观上界仍低于目标，与排程无关）：'
          + [...unreach.values()].map((u) => `${esc(u.label)} ≤ ${u.reachable} &lt; ${u.target}`).join('、') + '</div>';
      }
      return h;
    }

    // ---- 轨迹页：按天九项
    function trajPanel(res) {
      let h = `<h3 class="ptitle">属性轨迹（${res.trajectory.length} 天，仅显示区间）</h3>`;
      h += '<div class="scroll"><table class="res"><thead><tr><th>日期</th>'
        + ATTRS.map((a) => `<th>${ATTR_LABELS[a]}</th>`).join('') + '</tr></thead><tbody>';
      for (const row of res.trajectory) {
        const bad = row.violations.length ? ' class="bad"' : '';
        h += `<tr${bad}><td>${row.date}</td>${row.attrs.map((v) => `<td>${v}</td>`).join('')}</tr>`;
      }
      h += '</tbody></table></div>';
      return h;
    }

    let html = '<h2>结果</h2>';
    html += `<div class="verdict ${cls}">${esc(r.verdict)}</div>`;
    // 只在「没有解」时给出诊断/归因；有方案时不显示任何诊断提示
    if (r.status === 'path_infeasible' && r.infeasible) {
      const isClub = r.infeasible.kind === 'club';
      html += `<div class="warnbox"><b>${esc(r.infeasible.reason)}</b>`
        + (isClub ? '' : '<br>该解仅用于诊断定位，不作为可执行方案（D14）。')
        + ((r.infeasible.conflicts || []).length
          ? '<table class="res" style="margin-top:6px"><thead><tr><th>冲突的强制标注</th><th>指令</th></tr></thead><tbody>'
            + r.infeasible.conflicts.map((c) => `<tr><td>${esc(c.type === 'week' ? `周 ${c.key}` : c.key)}</td><td>${esc(labelOf(c.command))}</td></tr>`).join('')
            + '</tbody></table>'
          : '')
        + '</div>';
    }
    html += `<div class="metaline">
      <span class="hint">全局求解 ${r.horizon.from} ~ ${r.horizon.T}（毕业） · 显示 ${r.horizon.displayFrom} ~ ${r.horizon.displayEnd}（两月） · 总差距 ${r.objective === null ? '—' : r.objective} · ${r.meta.elapsedMs} ms</span>
    </div>`;

    const tabBtn = (id, name) => `<button data-tab="${id}"${activeTab === id ? ' class="on"' : ''}>${name}</button>`;
    html += `<div class="tabs" id="res-tabs">${tabBtn('plan', '排程指令')}${tabBtn('check', '达标核对')}${tabBtn('traj', '属性轨迹')}</div>`;
    const panel = (id, body) => `<div class="tabpanel" data-panel="${id}"${activeTab === id ? '' : ' hidden'}>${body}</div>`;
    html += panel('plan', planPanel(r));
    html += panel('check', checkPanel(r));
    html += panel('traj', trajPanel(r));

    card.innerHTML = html;

    card.querySelectorAll('[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.ui.tab = btn.dataset.tab;
        persist();
        card.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b === btn));
        card.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== state.ui.tab; });
      });
    });
  }

  // ================================================================ 工具
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  let toastTimer = null;
  function toast(msg) {
    let t = document.getElementById('toast-layer');
    if (!t) { t = document.createElement('div'); t.id = 'toast-layer'; document.body.appendChild(t); }
    t.innerHTML = `<div class="toast">${esc(msg)}</div>`;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.innerHTML = ''; }, 2600);
  }

  function persist() {
    state.input.annotations = state.annotations;
    store.saveInput(state.input);
    store.saveAnnotations(state.annotations);
    store.saveUI(state.ui);
  }

  // ================================================================ 启动
  renderInputs();
  renderCalendar();
  setTimeout(() => runSolve(), 0);

  // 主题切换按钮由模板注入
  const themeBtn = root.querySelector('#btn-theme');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      state.ui.theme = state.ui.theme === 'dark' ? 'light' : 'dark';
      document.body.dataset.theme = state.ui.theme;
      themeBtn.textContent = state.ui.theme === 'dark' ? '浅色' : '深色';
      persist();
    });
    themeBtn.textContent = state.ui.theme === 'dark' ? '浅色' : '深色';
  }

  return state;
}

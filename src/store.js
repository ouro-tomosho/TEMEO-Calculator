// src/store.js —— localStorage 读写与迁移（技术文档 §5.5）
//
// 键空间：temeo.v1.input / temeo.v1.annotations / temeo.v1.ui
// 标注与输入分离存储；标注按绝对日期保存，改 t0 或翻月都不丢失。
// R1 后 annotations 中不再有 rest:false 记录；读到旧版本里的 rest:false 时直接丢弃。

export const KEYS = {
  input: 'temeo.v1.input',
  annotations: 'temeo.v1.annotations',
  ui: 'temeo.v1.ui',
};

const memory = new Map();

/** 取可用的存储后端（file:// 或隐私模式下 localStorage 可能抛错） */
export function pickStorage() {
  try {
    if (typeof localStorage !== 'undefined') {
      const probe = '__temeo_probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return localStorage;
    }
  } catch (e) { /* fallthrough */ }
  return {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => memory.set(k, String(v)),
    removeItem: (k) => memory.delete(k),
  };
}

export function readJSON(storage, key, fallback) {
  try {
    const raw = storage.getItem(key);
    if (raw === null || raw === undefined) return fallback;
    const parsed = JSON.parse(raw);
    return parsed === null ? fallback : parsed;
  } catch (e) {
    return { __error: String(e && e.message ? e.message : e) };
  }
}

/**
 * R1 迁移：丢弃历史遗留的 rest:false；跳过只能从休日进入（D2）。
 * @returns {{annotations:Object, log:string[]}}
 */
export function migrateAnnotations(raw) {
  const log = [];
  const out = {};
  if (!raw || typeof raw !== 'object') return { annotations: out, log };
  for (const [date, ann] of Object.entries(raw)) {
    if (!ann || typeof ann !== 'object') continue;
    if (Object.prototype.hasOwnProperty.call(ann, 'rest') && ann.rest === false) {
      log.push(`${date}: 丢弃历史遗留的 rest:false（R1：周日恒为休日，用户休日只能整条取消）`);
      continue;
    }
    const next = {};
    if (ann.rest) next.rest = true;
    if (ann.skip) next.skip = true;
    if (typeof ann.force === 'string' && ann.force) next.force = ann.force;
    if (Object.keys(next).length) out[date] = next;
  }
  return { annotations: out, log };
}

export function loadAll(storage = pickStorage()) {
  const messages = [];
  const inputRaw = readJSON(storage, KEYS.input, null);
  if (inputRaw && inputRaw.__error) messages.push(`输入存档损坏，已回退默认值（${inputRaw.__error}）`);
  const annRaw = readJSON(storage, KEYS.annotations, {});
  if (annRaw && annRaw.__error) messages.push(`标注存档损坏，已回退默认值（${annRaw.__error}）`);
  const uiRaw = readJSON(storage, KEYS.ui, {});
  const { annotations, log } = migrateAnnotations(annRaw && !annRaw.__error ? annRaw : {});
  messages.push(...log);
  return {
    input: inputRaw && !inputRaw.__error ? inputRaw : null,
    annotations,
    ui: uiRaw && !uiRaw.__error ? uiRaw : {},
    messages,
  };
}

export function saveJSON(storage, key, value) {
  try { storage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
}

/** 防抖写入（§5.5：输入 change 事件 + 标注变更后防抖 300 ms） */
export function debounce(fn, ms = 300) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  };
}

export function createStore(storage = pickStorage()) {
  const loaded = loadAll(storage);
  return {
    storage,
    loaded,
    saveInput: debounce((input) => saveJSON(storage, KEYS.input, input), 300),
    saveAnnotations: debounce((ann) => saveJSON(storage, KEYS.annotations, ann), 300),
    saveUI: debounce((ui) => saveJSON(storage, KEYS.ui, ui), 300),
    flushInput(input) { saveJSON(storage, KEYS.input, input); },
    flushAnnotations(ann) { saveJSON(storage, KEYS.annotations, ann); },
    flushUI(ui) { saveJSON(storage, KEYS.ui, ui); },
  };
}

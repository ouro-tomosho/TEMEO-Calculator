// src/build.js —— 内联打包为单文件 index.html（技术文档 §6：构建纪律）
//
// 源码分模块，构建期内联为单文件；index.html 由本脚本生成，不得手改。
// 每个模块被包进独立的 IIFE（避免跨模块命名冲突），import/export 静态改写为
// 模块命名空间的解构引用。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

// 拓扑序（无环，可顺序求值）
const ORDER = [
  'spec.js',
  'calendar.js',
  'verify.js',
  'model.js',
  'solver.js',
  'result.js',
  'store.js',
  'ui/styles.js',
  'ui/app.js',
];

const moduleId = (rel) => `__m_${rel.replace(/\.js$/, '').replace(/[^A-Za-z0-9_]/g, '_')}`;

function resolveSpec(fromRel, spec) {
  const dir = path.posix.dirname(fromRel);
  return path.posix.normalize(path.posix.join(dir, spec));
}

function parseNames(list) {
  return list.split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const m = x.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
    return m ? { src: m[1], local: m[2] } : { src: x, local: x };
  });
}

function transform(rel, source) {
  const exports = new Map(); // local -> exported name
  let body = source;

  // 1) import { a, b as c } from './x.js'
  body = body.replace(/import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"];?/g, (m, names, spec) => {
    const target = resolveSpec(rel, spec);
    const id = moduleId(target);
    const bindings = parseNames(names).map((b) => (b.src === b.local ? b.src : `${b.src}: ${b.local}`));
    return `const { ${bindings.join(', ')} } = ${id};`;
  });

  // 2) export { a, b as c };
  body = body.replace(/export\s*\{([\s\S]*?)\};?/g, (m, names) => {
    for (const b of parseNames(names)) exports.set(b.src, b.local);
    return '';
  });

  // 3) export const/let/var/function/class NAME
  body = body.replace(/^export\s+(const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm, (m, kw, name) => {
    exports.set(name, name);
    return `${kw} ${name}`;
  });

  const leftovers = body.match(/^export\s+/m);
  if (leftovers) throw new Error(`${rel}: 存在未支持的 export 形式（build.js 只支持 export const/let/var/function/class 与 export {…}）`);

  const returns = [...exports.keys()];
  return `// ---- ${rel} ----\nconst ${moduleId(rel)} = (function () {\n${body}\nreturn { ${returns.join(', ')} };\n})();\n`;
}

function build() {
  const parts = [];
  for (const rel of ORDER) {
    const abs = path.join(SRC, rel);
    if (!fs.existsSync(abs)) throw new Error(`缺少模块：src/${rel}`);
    parts.push(transform(rel, fs.readFileSync(abs, 'utf8')));
  }

  const css = fs.readFileSync(path.join(SRC, 'ui/styles.js'), 'utf8')
    .match(/export const CSS = `([\s\S]*?)`;/)[1];

  const bootstrap = `
// ---- bootstrap ----
if (typeof document !== 'undefined' && document.querySelector('#input-card')) {
  ${moduleId('ui/app.js')}.mountApp(document.body);
}
`;

  const script = `(function () {\n'use strict';\n${parts.join('\n')}${bootstrap}\n})();`;

  const tpl = fs.readFileSync(path.join(SRC, 'index.template.html'), 'utf8');
  const html = tpl
    .replace('/*__CSS__*/', () => css)
    .replace('/*__SCRIPT__*/', () => script);

  const out = path.join(ROOT, 'index.html');
  fs.writeFileSync(out, html, 'utf8');
  const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
  process.stdout.write(`已生成 index.html（${kb} KB，模块 ${ORDER.length} 个）\n`);
}

build();

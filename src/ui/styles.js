// src/ui/styles.js —— 内联样式（单文件交付；无外链字体/网络请求）

export const CSS = `
:root{
  --bg:#f4f6fa; --panel:#ffffff; --panel2:#f8fafc; --line:#dde3ec; --text:#1d2530;
  --muted:#6b7686; --accent:#2f6fed; --accent-soft:#e6efff; --ok:#199b57; --bad:#d8452f;
  --warn:#b4690e; --rest:#fff3d6; --rest-line:#e8c777; --skip:#eceff3; --block:#eef4ff;
  --block-line:#c9dcff; --shadow:0 1px 3px rgba(20,30,50,.08);
}
body[data-theme="dark"]{
  --bg:#12161c; --panel:#1a1f27; --panel2:#20262f; --line:#2c343f; --text:#e6ebf2;
  --muted:#95a1b2; --accent:#5b9bff; --accent-soft:#1d2c44; --ok:#41c07a; --bad:#ff6b52;
  --warn:#e0a44a; --rest:#3a3320; --rest-line:#6d5c2c; --skip:#22272f; --block:#1b2740;
  --block-line:#33507f; --shadow:0 1px 3px rgba(0,0,0,.4);
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--text);font:13px/1.5 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
button,select,input{font:inherit;color:inherit}
button{cursor:pointer;background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:4px 10px}
button:hover:not(:disabled){border-color:var(--accent)}
button:disabled{opacity:.38;cursor:not-allowed}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
button.primary:hover{filter:brightness(1.08)}
select,input[type=number],input[type=date]{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:3px 6px}
input:invalid{border-color:var(--bad);background:rgba(216,69,47,.08)}
.app{max-width:1440px;margin:0 auto;padding:14px}
header{display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap}
header h1{font-size:17px;margin:0}
header .sp{flex:1}
/* 三块布局：月历（两月视图，全宽）在上；第二行 = 输入（窄）+ 结果（宽）。
   输入与结果并排且高度接近（结果用页签收敛），三块大小与位置互相平衡。 */
main{
  display:grid;
  grid-template-columns:minmax(330px,400px) minmax(0,1fr);
  grid-template-areas:"cal cal" "in res";
  gap:14px;align-items:start;
}
#calendar-card{grid-area:cal}
#input-card{grid-area:in}
#result-card{grid-area:res}
/* 允许栅格项收缩到内容宽度以下，避免窄屏横向溢出（宽表由 .scroll 自己滚动） */
#calendar-card,#input-card,#result-card{min-width:0}
@media (max-width:900px){
  main{grid-template-columns:minmax(0,1fr);grid-template-areas:"cal" "in" "res"}
}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;box-shadow:var(--shadow);padding:12px;margin-bottom:12px}
.card h2{font-size:13px;margin:0 0 8px;letter-spacing:.04em;color:var(--muted);text-transform:uppercase}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.row+.row{margin-top:8px}
.grid2{display:grid;grid-template-columns:auto 1fr 1fr;gap:6px 8px;align-items:center}
.grid2 .h{color:var(--muted);font-size:12px}
.grid2 input[type=number]{width:100%}
.hint{color:var(--muted);font-size:12px}
.calhead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}
.calhead .month{font-weight:600;font-size:17px;min-width:210px;text-align:center;letter-spacing:.02em}
/* 两月并排：窄屏自动堆叠 */
.months{display:grid;grid-template-columns:repeat(auto-fit,minmax(560px,1fr));gap:20px}
.monthblock{min-width:0}
.monthblock .mhead{font-size:15px;font-weight:700;color:var(--text);text-align:center;margin:0 0 8px;letter-spacing:.04em}
table.grid{width:100%;border-collapse:separate;border-spacing:5px;table-layout:fixed}
table.grid th{font-size:13px;color:var(--muted);font-weight:600;padding:4px 0;text-align:center}
table.grid th.wkh{width:150px}
table.grid th.sunh{color:var(--warn)}
table.grid td{padding:0;vertical-align:top}
.wkcell{width:150px;background:var(--panel2);border:1px solid var(--line);border-radius:9px;padding:8px 8px;text-align:center}
.wkcell .wk{font-size:12.5px;color:var(--muted);line-height:1.3}
.wkcell .wk .wkline{display:block}
.wkcell select{width:100%;margin-top:6px;font-size:13px;text-align:center;text-align-last:center}
.day{position:relative;height:62px;border:1px solid var(--block-line);background:var(--block);border-radius:9px;padding:6px 4px;cursor:pointer;user-select:none;overflow:hidden;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:1px}
.day.rest{background:var(--rest);border-color:var(--rest-line)}
.day.skip{background:var(--skip);border-color:var(--line);color:var(--muted);text-decoration:line-through}
.day.out{background:transparent;border-color:var(--line);border-style:dashed;color:var(--muted);cursor:not-allowed;text-decoration:none}
.day.sun{box-shadow:inset 0 0 0 1px var(--rest-line)}
.day .d{font-size:15px;font-weight:700;line-height:1.15;font-variant-numeric:tabular-nums}
.day .m{font-size:11.5px;color:var(--muted);line-height:1.25;max-width:100%;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}
.day .badge{position:absolute;right:4px;top:3px;font-size:11px;line-height:1}
.day .viol{position:absolute;left:4px;bottom:3px;font-size:11px;color:var(--bad);font-weight:700;line-height:1}
.day.sel{outline:2px solid var(--accent);outline-offset:-2px}
.day.locked{box-shadow:inset 0 0 0 2px var(--accent)}
.legend{display:flex;gap:16px;flex-wrap:wrap;justify-content:center;margin-top:10px;font-size:12.5px;color:var(--muted)}
.legend i{display:inline-block;width:13px;height:13px;border-radius:3px;border:1px solid var(--line);vertical-align:-2px;margin-right:5px}
.menu{position:absolute;z-index:50;background:var(--panel);border:1px solid var(--line);border-radius:8px;box-shadow:0 6px 22px rgba(0,0,0,.18);padding:6px;min-width:186px}
.menu button{display:block;width:100%;text-align:left;border:none;background:none;padding:5px 8px;border-radius:5px}
.menu button:hover{background:var(--accent-soft)}
.menu .sep{height:1px;background:var(--line);margin:5px 2px}
.menu select{width:100%}
.verdict{padding:9px 11px;border-radius:8px;font-weight:600;margin-bottom:8px;border:1px solid var(--line)}
.verdict.ok{background:rgba(25,155,87,.12);border-color:rgba(25,155,87,.4);color:var(--ok)}
.verdict.bad{background:rgba(216,69,47,.12);border-color:rgba(216,69,47,.4);color:var(--bad)}
.verdict.warn{background:rgba(180,105,14,.12);border-color:rgba(180,105,14,.4);color:var(--warn)}
.metaline{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px}
.metaline .hint{flex:1;min-width:200px}
.clubline{font-size:12px;color:var(--muted);background:var(--panel2);border:1px solid var(--line);border-radius:7px;padding:5px 9px;margin:0 0 7px}
.clubline.bad{color:var(--bad);border-color:rgba(216,69,47,.4);background:rgba(216,69,47,.08)}
table.res{width:100%;border-collapse:collapse;font-size:12px}
table.res th,table.res td{border-bottom:1px solid var(--line);padding:3px 6px;text-align:right}
table.res th:first-child,table.res td:first-child{text-align:left}
table.res th{color:var(--muted);font-weight:500}
table.res tr.bad td{color:var(--bad);font-weight:600}
.scroll{max-height:330px;overflow:auto}
.tabs{display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap}
.tabs button.on{background:var(--accent-soft);border-color:var(--accent);font-weight:600}
.tabpanel h3.ptitle{font-size:12px;font-weight:600;color:var(--muted);margin:0 0 6px}
.tabpanel[hidden]{display:none}
.toast{position:fixed;left:50%;transform:translateX(-50%);bottom:24px;background:#222a35;color:#fff;padding:8px 14px;border-radius:8px;z-index:99;opacity:.96;font-size:12px;max-width:80vw}
.warnbox{background:rgba(180,105,14,.12);border:1px solid rgba(180,105,14,.4);color:var(--warn);border-radius:8px;padding:8px 10px;margin-bottom:10px;font-size:12px}
.batch{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:8px;padding:6px 8px;background:var(--accent-soft);border:1px solid var(--accent);border-radius:8px;font-size:12px}
`;

/** Workbench UI stylesheet, kept beside the components that rely on it. */
export const WORKBENCH_STYLES = `:root{color-scheme:dark;--bg:#0b1020;--panel:#121a2c;--panel2:#18233a;--line:#2a3857;--text:#e9efff;--muted:#91a0bd;--accent:#72a7ff;--ok:#55d6a1;--warn:#ffc56b;--bad:#ff7c92}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
button,input,select,textarea{font:inherit;color:inherit;background:#0e172b;border:1px solid var(--line);border-radius:7px;padding:8px 10px}
button{cursor:pointer;background:#21345a;border-color:#395b97}button:hover{background:#2c4880}button.ghost{background:transparent}
button:focus-visible,input:focus-visible,select:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.shell{display:grid;grid-template-columns:300px 1fr;min-height:100vh}.sidebar{border-right:1px solid var(--line);padding:18px;background:#0d1528}
.brand{font-weight:700;font-size:18px;letter-spacing:.02em;margin-bottom:18px}.muted{color:var(--muted)}
.section{margin:18px 0}.section h3{font-size:12px;text-transform:uppercase;color:var(--muted);letter-spacing:.08em;margin:0 0 8px}
.row{display:flex;gap:8px;align-items:center}.row.wrap{flex-wrap:wrap}.stack{display:flex;flex-direction:column;gap:8px}
.project{padding:10px;border:1px solid transparent;border-radius:8px;cursor:pointer}.project.active{background:var(--panel2);border-color:#385385}
.target,.run{padding:9px;border-top:1px solid var(--line);cursor:pointer}.target:hover,.run:hover{background:#15213a}
.run:focus-visible,.project:focus-visible,.node:focus-visible,.target:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.pill{display:inline-flex;align-items:center;border-radius:999px;padding:2px 8px;font-size:11px;background:#263657;color:var(--muted)}
.pill.ok{color:#081b16;background:#55d6a1}.pill.warn{color:#211708;background:#ffc56b}.pill.bad{color:#260812;background:#ff7c92}
.banner{border:1px solid var(--bad);background:#2a1220;color:var(--text);border-radius:8px;padding:10px 12px;margin:0 0 12px;font-size:12px}
.banner .code{color:var(--bad);font-weight:600;margin-right:6px}.banner ul{margin:6px 0 0;padding-left:18px}
.main{min-width:0}.topbar{display:flex;align-items:center;justify-content:space-between;padding:17px 22px;border-bottom:1px solid var(--line);background:#0d1528;position:sticky;top:0;z-index:2;flex-wrap:wrap;gap:8px}
.topbar h1{font-size:17px;margin:0}.content{padding:22px;max-width:1500px}
.cards{display:grid;grid-template-columns:repeat(4,minmax(130px,1fr));gap:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px}.card .label{color:var(--muted);font-size:12px}
.card .value{font-size:21px;font-weight:650;margin-top:5px}
.workspace{display:grid;grid-template-columns:220px minmax(0,1fr) 320px;gap:14px;margin-top:14px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;min-height:180px;overflow:hidden}
.panel h2{font-size:13px;padding:12px 14px;margin:0;border-bottom:1px solid var(--line)}
.panel-body{padding:12px 14px}
.steps{padding:6px 0}.step{display:flex;gap:8px;align-items:flex-start;padding:9px 12px}
.step .dot{width:9px;height:9px;border-radius:50%;background:#415273;margin-top:5px;flex:none}
.step.running .dot{background:var(--accent);box-shadow:0 0 0 4px #72a7ff22}.step.succeeded .dot{background:var(--ok)}
.step.failed .dot{background:var(--bad)}.step.waiting .dot{background:var(--warn)}.step.cancelled .dot{background:var(--bad)}
.step .name{font-size:13px}.step .message{font-size:11px;color:var(--muted);margin-top:2px}
.timeline{max-height:420px;overflow:auto}.event{padding:7px 0;border-bottom:1px solid #20304c;font-size:12px}
.event strong{color:var(--accent);font-weight:550}.event .detail{word-break:break-word}
.tabs{display:flex;gap:7px;margin:14px 0;flex-wrap:wrap}.tabs button.active{background:#395b97}.tab{display:none}.tab.active{display:block}
.graph{height:420px;overflow:auto;background:#0b1221;border-top:1px solid var(--line)}
.node{display:flex;gap:8px;padding:7px 10px;border-bottom:1px solid #17243d;align-items:center;cursor:pointer}
.node-kind{color:var(--accent);font-size:11px;min-width:135px}
.node-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.code{white-space:pre-wrap;word-break:break-word;background:#0a1120;padding:14px;border-radius:8px;min-height:300px;overflow:auto;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}
.empty{color:var(--muted);padding:18px;text-align:center}
.loading{color:var(--muted);padding:24px;text-align:center;letter-spacing:.06em}
.state-note{border:1px solid var(--warn);background:#241b0c;border-radius:8px;padding:8px 12px;margin:10px 0;font-size:12px}
.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.form-grid label{display:flex;flex-direction:column;gap:5px;color:var(--muted);font-size:12px}
.form-grid label.full{grid-column:1/-1}
.form-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
@media(max-width:1100px){.shell{grid-template-columns:240px 1fr}.workspace{grid-template-columns:190px minmax(0,1fr)}.workspace>.panel:last-child{grid-column:1/-1}}
@media(max-width:760px){.shell{display:block}.sidebar{border-right:0;border-bottom:1px solid var(--line)}.cards{grid-template-columns:repeat(2,1fr)}
.workspace{display:block}.panel{margin-top:12px}.content{padding:14px}.topbar{padding:12px 14px}
.node-kind{min-width:90px}.event .detail,.code{font-size:11px}}`;

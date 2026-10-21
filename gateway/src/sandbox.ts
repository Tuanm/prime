// GET /mcp - the Sandbox: this browser as a device. The signed-in device
// (HTTP Basic, as on /files) uploads JavaScript tools - one file per tool, an
// 'export default async function' documented with JSDoc - kept in this browser's
// storage. Tools are validated, and later run, in a sandboxed iframe with an
// opaque origin and no network (GET /mcp?frame=runtime), never in the page.

import { validDeviceId } from "./config";
import { FAVICON, UI_CSS } from "./ui-css";
import { authorizeDevice } from "./files-routes";
import type { Env } from "./config";

const SANDBOX_CSS = `
      body { width: 720px; }
      .cols { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; }
      .tname { width: 150px; flex: none; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .targs { width: 150px; flex: none; font-size: 12px; color: #666; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .tdesc { flex: 1; min-width: 0; font-size: 12px; color: #666; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dot.pending { background: #ccc; }
      .row { flex-wrap: wrap; }
      .terr { flex-basis: 100%; margin: 4px 0 0 22px; font-size: 11px; color: #b91c1c; }
      .dot-spacer { width: 10px; flex: none; }
      .dropzone { flex: 1; min-height: 46px; border: 1px dashed #bbb; background: #fff; color: #999; font-size: 12px; display: flex; align-items: center; justify-content: center; cursor: pointer; box-sizing: border-box; }
      .dropzone:hover, .dropzone.over { border-color: #111; color: #111; }
      .plus:disabled { opacity: 0.35; cursor: default; }
      .connect-row { margin-top: 28px; display: flex; align-items: center; gap: 14px; }
      .connect { font: inherit; font-weight: 600; padding: 10px 22px; background: #111; color: #fff; border: 1px solid #111; cursor: pointer; }
      .connect:hover { background: #000; }
      .dlg.dlg-wide { width: 680px; max-width: calc(100vw - 32px); }
      .dlg.dlg-wide .dlg-body { padding: 14px 16px 16px; }
      .dlg.dlg-wide .dlg-msg { padding: 10px 0 0; }
      .src { width: 100%; height: 340px; box-sizing: border-box; font: inherit; font-size: 12px; line-height: 1.5; padding: 10px 12px; border: 1px solid #ddd; background: #fafafa; resize: none; white-space: pre; tab-size: 2; }
      .src:focus { outline: none; border-color: #111; }
      .connect:disabled { opacity: 0.5; cursor: default; }
      .connect.on { background: #fff; color: #111; }
      .connect.on:hover { background: #f2f2f2; }
      .conninfo { font-size: 11px; color: #666; line-height: 1.5; word-break: break-all; }
      /* ---- dash: where tools put UI and drive cursors ---- */
      #dash { margin-top: 28px; }
      #dash[hidden] { display: none; }
      .dash-area { position: relative; min-height: 320px; border: 1px dashed #bbb; padding: 16px; display: flex; flex-direction: column; gap: 12px; overflow: auto; max-height: 70vh; }
      .dash-empty { color: #999; font-size: 12px; margin: auto; text-align: center; }
      .dash-head { gap: 12px; }
      .dash-head #running { flex: 1; text-align: right; }
      .icon-btn { width: 28px; height: 28px; flex: none; display: inline-flex; align-items: center; justify-content: center; background: #fff; color: #111; border: 1px solid #111; cursor: pointer; padding: 0; }
      .icon-btn:hover { background: #f2f2f2; }
      .icon-btn:disabled { opacity: 0.3; cursor: default; background: #fff; }
      .icon-btn svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: square; }
      /* Expanded: the dash covers the page (the browser window), not the screen. */
      #dash.full { position: fixed; inset: 0; z-index: 50; margin: 0; background: #fff; padding: 16px 20px 20px; display: flex; flex-direction: column; box-sizing: border-box; }
      #dash.full .dash-head { margin-top: 0; }
      #dash.full .dash-area { flex: 1; max-height: none; min-height: 0; }
      body.dash-full { overflow: hidden; }
      .dash-empty[hidden] { display: none; }
      /* Components: the page's own vocabulary - mono type, black on white, 1px lines. */
      .uc { font-size: 13px; color: #111; min-width: 0; }
      .uc-heading { font-size: 15px; font-weight: 700; letter-spacing: 0.3px; }
      .uc-text { white-space: pre-wrap; line-height: 1.5; }
      .uc-text.muted { color: #666; font-size: 12px; }
      .uc-code pre { margin: 0; background: #f5f5f5; border: 1px solid #ddd; padding: 10px 12px; font: inherit; font-size: 12px; overflow-x: auto; white-space: pre; }
      .uc-image img { display: block; max-width: 100%; border: 1px solid #111; }
      .uc-label { font-size: 10px; color: #999; text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 4px; }
      .uc-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 10px; }
      .uc-row { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px; }
      .uc-card { border: 1px solid #111; padding: 12px 14px; }
      .uc-card .uc-body { display: flex; flex-direction: column; gap: 10px; }
      .uc-status { display: flex; align-items: center; gap: 8px; font-size: 12px; }
      .uc-divider { border-top: 1px solid #ddd; }
      .uc-status .dot.pending { background: #ccc; }
      .ubtn { font: inherit; font-size: 12px; font-weight: 600; padding: 7px 16px; background: #111; color: #fff; border: 1px solid #111; cursor: pointer; transition: transform 0.08s; }
      .ubtn:hover { background: #000; }
      .ubtn.secondary { background: #fff; color: #111; }
      .ubtn.secondary:hover { background: #f2f2f2; }
      .ubtn.danger { background: #b91c1c; border-color: #b91c1c; }
      .ubtn:disabled { opacity: 0.4; cursor: default; }
      .ubtn.pressed { transform: scale(0.96); }
      .uinput { font: inherit; font-size: 13px; width: 100%; box-sizing: border-box; border: 0; border-bottom: 1px dotted #999; padding: 4px 0; background: transparent; color: #111; }
      .uinput:focus { outline: none; border-bottom: 1px solid #111; }
      .utextarea, .ueditor { font: inherit; font-size: 12px; width: 100%; box-sizing: border-box; border: 1px solid #ddd; padding: 8px 10px; background: #fff; color: #111; resize: none; line-height: 1.5; }
      .ueditor { background: #fafafa; white-space: pre; tab-size: 2; }
      .utextarea:focus, .ueditor:focus { outline: none; border-color: #111; }
      /* Drawn controls: no native checkbox, select or range anywhere. */
      .ucheck { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px; user-select: none; outline: none; }
      .ucheck-box { width: 14px; height: 14px; border: 1px solid #111; background: #fff; display: inline-flex; align-items: center; justify-content: center; flex: none; box-sizing: border-box; }
      .ucheck-box svg { width: 10px; height: 10px; fill: none; stroke: #fff; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; opacity: 0; }
      .ucheck.on .ucheck-box { background: #111; }
      .ucheck.on .ucheck-box svg { opacity: 1; }
      .ucheck:focus-visible .ucheck-box { box-shadow: 0 0 0 2px #fff, 0 0 0 3px #111; }
      .ucheck.disabled { opacity: 0.4; cursor: default; }
      .usel { display: inline-flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 140px; box-sizing: border-box; border: 1px solid #111; background: #fff; color: #111; font-size: 12px; padding: 5px 8px 5px 10px; cursor: pointer; user-select: none; outline: none; }
      .usel:focus-visible, .usel.open { box-shadow: 0 0 0 1px #111; }
      .usel-chev { display: inline-flex; }
      .usel-chev svg { width: 10px; height: 10px; fill: none; stroke: currentColor; stroke-width: 2.2; transition: transform 0.12s; }
      .usel.open .usel-chev svg { transform: rotate(180deg); }
      .usel.disabled { opacity: 0.4; cursor: default; }
      .usel-list { position: fixed; z-index: 1000; max-height: 240px; overflow-y: auto; background: #fff; border: 1px solid #111; padding: 4px 0; font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; box-sizing: border-box; }
      .usel-item { position: relative; padding: 6px 12px 6px 26px; cursor: pointer; white-space: nowrap; color: #111; }
      .usel-item.active { background: #f2f2f2; }
      .usel-item[aria-selected="true"] { font-weight: 700; }
      .usel-item[aria-selected="true"]::before { content: "\\2713"; position: absolute; left: 10px; }
      .uslide { display: inline-flex; align-items: center; gap: 12px; width: 260px; padding: 6px 0; cursor: pointer; touch-action: none; user-select: none; outline: none; }
      .uslide-track { position: relative; flex: 1; height: 2px; background: #ddd; }
      .uslide-fill { position: absolute; left: 0; top: 0; bottom: 0; background: #111; }
      .uslide-thumb { position: absolute; top: 50%; width: 12px; height: 12px; margin: -6px 0 0 -6px; background: #111; border: 2px solid #fff; box-shadow: 0 0 0 1px #111; box-sizing: border-box; }
      .uslide:focus-visible .uslide-thumb, .uslide.dragging .uslide-thumb { box-shadow: 0 0 0 1px #111, 0 0 0 4px rgba(17,17,17,0.12); }
      .uslide-value { font-size: 11px; color: #666; min-width: 28px; text-align: right; }
      .uslide.disabled { opacity: 0.4; cursor: default; }
      .utoggle { display: inline-flex; align-items: center; gap: 10px; cursor: pointer; font-size: 13px; user-select: none; outline: none; }
      .utoggle-track { position: relative; width: 30px; height: 16px; border: 1px solid #111; background: #fff; box-sizing: border-box; flex: none; transition: background 0.12s; }
      .utoggle-knob { position: absolute; top: 2px; left: 2px; width: 10px; height: 10px; background: #111; transition: left 0.12s, background 0.12s; }
      .utoggle.on .utoggle-track { background: #111; }
      .utoggle.on .utoggle-knob { left: 16px; background: #fff; }
      .utoggle:focus-visible .utoggle-track { box-shadow: 0 0 0 2px #fff, 0 0 0 3px #111; }
      .utoggle.disabled { opacity: 0.4; cursor: default; }
      .uradio { display: inline-flex; flex-direction: column; gap: 6px; outline: none; }
      .uradio.row { flex-direction: row; flex-wrap: wrap; gap: 6px 18px; }
      .uradio-opt { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px; user-select: none; }
      .uradio-dot { width: 14px; height: 14px; border: 1px solid #111; border-radius: 50%; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; flex: none; background: #fff; }
      .uradio-opt.on .uradio-dot::after { content: ""; width: 6px; height: 6px; border-radius: 50%; background: #111; }
      .uradio:focus-visible .uradio-opt.on .uradio-dot { box-shadow: 0 0 0 2px #fff, 0 0 0 3px #111; }
      .uradio.disabled { opacity: 0.4; pointer-events: none; }
      .uc-progress { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 0 12px; }
      .uc-progress .uc-label { grid-column: 1 / -1; }
      .uprog { height: 6px; border: 1px solid #111; background: #fff; position: relative; }
      .uprog-fill { position: absolute; left: 0; top: 0; bottom: 0; background: #111; transition: width 0.25s; }
      .uprog-text { font-size: 11px; color: #666; min-width: 34px; text-align: right; }
      /* Layout */
      .uc[hidden] { display: none !important; }
      .uc-column { display: flex; flex-direction: column; gap: 10px; }
      .uc-grid { display: grid; gap: 10px; }
      .uc-accordion { border: 1px solid #111; }
      .uacc-head { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; cursor: pointer; font-size: 11px; font-weight: 700; letter-spacing: 0.8px; text-transform: uppercase; outline: none; user-select: none; }
      .uacc-head:focus-visible { background: #f5f5f5; }
      .uc-accordion.open .usel-chev svg { transform: rotate(180deg); }
      .uc-accordion > .uc-body { display: none; flex-direction: column; gap: 10px; padding: 0 14px 12px; }
      .uc-accordion.open > .uc-body { display: flex; }
      .utabs-bar { display: flex; gap: 0; border-bottom: 1px solid #111; margin-bottom: 12px; overflow-x: auto; }
      .utab { padding: 7px 14px; font-size: 12px; cursor: pointer; color: #666; border: 1px solid transparent; border-bottom: 0; margin-bottom: -1px; outline: none; white-space: nowrap; user-select: none; }
      .utab:hover { color: #111; }
      .utab.on { color: #111; font-weight: 700; border-color: #111; background: #fff; }
      .utab:focus-visible { text-decoration: underline; }
      .utab-panel { display: flex; flex-direction: column; gap: 10px; }
      .utab-panel[hidden] { display: none; }
      /* Overlays: modal and drawer, inside the dash */
      .uc-overlay { position: absolute; left: 0; right: 0; top: 0; z-index: 15; display: none; }
      .uc-overlay.open { display: block; }
      .uoverlay-back { position: absolute; inset: 0; background: rgba(17,17,17,0.35); }
      .umodal-panel { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); max-width: calc(100% - 32px); max-height: calc(100% - 32px); background: #fff; border: 1px solid #111; display: flex; flex-direction: column; box-shadow: 0 10px 30px rgba(0,0,0,0.18); }
      .udrawer-panel { position: absolute; top: 0; bottom: 0; max-width: 90%; background: #fff; display: flex; flex-direction: column; box-shadow: 0 0 24px rgba(0,0,0,0.15); animation: udrawer-in 0.14s ease-out; }
      .udrawer-panel.right { right: 0; border-left: 1px solid #111; }
      .udrawer-panel.left { left: 0; border-right: 1px solid #111; animation-name: udrawer-in-left; }
      @keyframes udrawer-in { from { transform: translateX(30px); opacity: 0; } }
      @keyframes udrawer-in-left { from { transform: translateX(-30px); opacity: 0; } }
      .umodal-panel > .dlg-head, .udrawer-panel > .dlg-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      .umodal-panel > .dlg-head .uc-title-text, .udrawer-panel > .dlg-head .uc-title-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .umodal-body { padding: 14px 16px 16px; overflow: auto; display: flex; flex-direction: column; gap: 10px; }
      .uc-preview .umodal-panel, .uc-preview .udrawer-panel { position: static; transform: none; box-shadow: none; animation: none; max-width: 100%; border: 1px solid #111; }
      .dash-area.locked { overflow: hidden; }
      .uc-title-text { font-size: 11px; font-weight: 700; letter-spacing: 0.8px; text-transform: uppercase; }
      /* Data */
      .utable { overflow-x: auto; border: 1px solid #111; outline: none; }
      .utable table { width: 100%; border-collapse: collapse; font-size: 12px; }
      .utable th { text-align: left; font-size: 10px; font-weight: 700; letter-spacing: 0.6px; text-transform: uppercase; padding: 8px 10px; border-bottom: 1px solid #111; white-space: nowrap; user-select: none; }
      .utable th.sortable { cursor: pointer; }
      .utable th[data-sort="asc"]::after { content: " \\25b2"; font-size: 8px; }
      .utable th[data-sort="desc"]::after { content: " \\25bc"; font-size: 8px; }
      .utable td { padding: 7px 10px; border-bottom: 1px solid #eee; }
      .utable tr:last-child td { border-bottom: 0; }
      .utable.selectable tbody tr { cursor: pointer; }
      .utable.selectable tbody tr:hover td { background: #f5f5f5; }
      .utable tbody tr.on td { background: #111; color: #fff; }
      .utable-empty { color: #999; text-align: center !important; }
      .ulist { border: 1px solid #111; display: flex; flex-direction: column; }
      .ulist-item { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 12px; cursor: pointer; border-left: 3px solid transparent; outline: none; user-select: none; }
      .ulist-item + .ulist-item { border-top: 1px solid #eee; }
      .ulist-item:hover, .ulist-item:focus-visible { background: #f5f5f5; }
      .ulist-item.on { border-left-color: #111; font-weight: 700; }
      .ulist-label { font-size: 13px; }
      .ulist-desc { font-size: 11px; color: #666; font-weight: 400; margin-top: 2px; }
      .ubadge { display: inline-block; font-size: 10px; font-weight: 600; letter-spacing: 0.3px; padding: 1px 7px; border: 1px solid #111; color: #111; background: #fff; white-space: nowrap; }
      .ubadge.solid { background: #111; color: #fff; }
      .ubadge.success { border-color: #16a34a; color: #16a34a; }
      .ubadge.warning { border-color: #ca8a04; color: #a16207; }
      .ubadge.error { border-color: #b91c1c; color: #b91c1c; }
      .uc-alert { border: 1px solid #111; border-left-width: 4px; padding: 10px 14px; font-size: 12px; }
      .uc-alert.info { border-left-color: #2563eb; }
      .uc-alert.success { border-left-color: #16a34a; }
      .uc-alert.warning { border-left-color: #ca8a04; }
      .uc-alert.error { border-left-color: #b91c1c; }
      .ualert-title { font-weight: 700; margin-bottom: 3px; }
      .ualert-text { white-space: pre-wrap; line-height: 1.5; }
      .uc-stat { border: 1px solid #111; padding: 10px 14px; }
      .ustat-value { font-size: 22px; font-weight: 700; letter-spacing: 0.3px; line-height: 1.2; }
      .ustat-delta { font-size: 11px; color: #666; margin-top: 2px; }
      .ustat-delta.up { color: #16a34a; }
      .ustat-delta.down { color: #b91c1c; }
      .utoasts { position: absolute; right: 12px; z-index: 22; display: flex; flex-direction: column; gap: 6px; align-items: flex-end; pointer-events: none; }
      .utoast { background: #111; color: #fff; font-size: 12px; padding: 7px 12px; border-left: 4px solid #111; box-shadow: 0 4px 14px rgba(0,0,0,0.15); animation: utoast-in 0.18s ease-out; transition: opacity 0.3s; }
      .utoast.success { border-left-color: #16a34a; }
      .utoast.warning { border-left-color: #ca8a04; }
      .utoast.error { border-left-color: #b91c1c; }
      .utoast.leaving { opacity: 0; }
      .utoast.static { display: inline-block; animation: none; }
      @keyframes utoast-in { from { transform: translateY(-6px); opacity: 0; } }
      .uinput::-webkit-outer-spin-button, .uinput::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
      .uinput[type=number] { -moz-appearance: textfield; }
      /* Drag and drop */
      .uc[data-draggable] { border: 1px solid #ddd; background: #fff; padding: 7px 10px; cursor: grab; user-select: none; touch-action: none; }
      .uc[data-draggable]:hover { border-color: #111; }
      .uc[data-draggable].dragging { position: relative; z-index: 30; opacity: 0.85; cursor: grabbing; border-color: #111; box-shadow: 0 6px 18px rgba(0,0,0,0.12); }
      body.dragging-any, body.dragging-any * { cursor: grabbing !important; }
      .drop-line { position: absolute; z-index: 25; background: #2563eb; pointer-events: none; }
      .uc-row > .uc-card { flex: 1 1 160px; min-width: 150px; align-self: stretch; }
      .uc-card .uc-body:empty { min-height: 36px; border: 1px dashed #ddd; }
      .uc.hovered { outline: 1px dashed #111; outline-offset: 3px; }
      #status:empty, #starters:empty, #data:empty, #running:empty { display: none; }
      .linkbtn:disabled { color: #bbb; cursor: default; text-decoration: none; }
      #gate { z-index: 60; }
      /* Bodies that already pad themselves (the gate, the source dialog, the
         page's confirmations) must not pad the action bar a second time. */
      .dlg.dlg-confirm .dlg-bar, .dlg.dlg-wide .dlg-bar { padding: 12px 0 0; }
      #gate[hidden] { display: none; }
      .gate-input { width: 100%; box-sizing: border-box; font: inherit; font-size: 13px; padding: 9px 10px; border: 1px solid #111; background: #fff; color: #111; margin: 4px 0 2px; }
      .gate-input:focus { outline: none; box-shadow: 0 0 0 1px #111; }
      #gate .dlg-bar { justify-content: flex-end; }
      .linkbtn { font: inherit; font-size: 11px; background: none; border: 0; padding: 0; color: #111; text-decoration: underline; cursor: pointer; }
      .dlg.dlg-confirm { width: 420px; max-width: calc(100vw - 32px); }
      .dlg.dlg-confirm .dlg-body { padding: 14px 16px 16px; }
      .dlg.dlg-confirm .dlg-msg { padding: 0 0 12px; color: #111; }
      .uc.dragging { opacity: 0.45; }
      /* Virtual cursors: a black arrow and the client's name. */
      .cur { position: absolute; left: 0; top: 0; z-index: 20; pointer-events: none; transform: translate(12px, 12px); }
      .cur svg { width: 16px; height: 20px; display: block; fill: #111; stroke: #fff; stroke-width: 1.2; filter: drop-shadow(0 1px 1px rgba(0,0,0,0.25)); }
      .cur-name { position: absolute; left: 14px; top: 16px; font-size: 10px; font-weight: 600; color: #fff; padding: 2px 6px; white-space: nowrap; letter-spacing: 0.3px; display: inline-flex; align-items: center; gap: 5px; }
      .cur-spin { display: none; width: 8px; height: 8px; border: 1.5px solid rgba(255,255,255,0.45); border-top-color: #fff; border-radius: 50%; animation: curspin 0.7s linear infinite; }
      .cur.busy .cur-spin { display: inline-block; }
      @keyframes curspin { to { transform: rotate(360deg); } }
      .cur { transition: opacity 0.45s; }
      .cur.leaving { opacity: 0; }
      .cur.me { z-index: 21; --cur: #111; }
      .cur.me .cur-name { background: #111; }
      .cur.me[hidden] { display: none; }
      .dash-area.mine, .dash-area.mine * { cursor: none !important; }
      .cur.click svg { animation: curclick 0.16s ease-out; }
      .cur.grab svg { transform: scale(0.9); }
      .cur::after { content: ""; position: absolute; left: -6px; top: -6px; width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--cur); opacity: 0; }
      .cur.click::after { animation: curring 0.4s ease-out; }
      @keyframes curclick { 50% { transform: scale(0.85); } }
      @keyframes curring { from { opacity: 0.9; transform: scale(0.4); } to { opacity: 0; transform: scale(2.2); } }
      /* ---- the components reference ---- */
      .gallery { margin-top: 36px; }
      .gallery summary { cursor: pointer; font-size: 11px; font-weight: 700; letter-spacing: 0.8px; text-transform: uppercase; list-style: none; }
      .gallery summary::-webkit-details-marker { display: none; }
      .gallery summary::before { content: "+ "; }
      .gallery[open] summary::before { content: "\\2212  "; }
      .gal-intro { font-size: 12px; color: #666; margin: 12px 0 4px; line-height: 1.6; }
      .gal-item { display: grid; grid-template-columns: 130px 1fr; gap: 6px 14px; padding: 12px 0; border-bottom: 1px solid #eee; align-items: start; }
      .gal-name { font-size: 11px; color: #666; padding-top: 4px; }
      .gal-code { grid-column: 2; font-size: 10.5px; color: #888; background: none; border: 0; padding: 0; word-break: break-all; }
`;

const RUNTIME_JS = String.raw`(function () {
  "use strict";
  var NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
  var MAX_SOURCE = 200000;
  var HEAD_RE = /export\s+default\s+async\s+function\s*([A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/;

  function fail(msg) { var e = new Error(msg); e.userFacing = true; throw e; }

  function schemaFor(type) {
    var t = String(type || "").trim();
    if (!t || t === "*" || /^any$/i.test(t)) return {};
    if (t.indexOf("|") >= 0) {
      var parts = t.split("|").map(function (p) { return schemaFor(p).type; }).filter(Boolean);
      return parts.length ? { type: parts } : {};
    }
    if (/\[\]$/.test(t) || /^array(<.*>)?$/i.test(t) || /^Array\./.test(t)) return { type: "array" };
    var l = t.toLowerCase();
    if (l === "number") return { type: "number" };
    if (l === "integer" || l === "int") return { type: "integer" };
    if (l === "string") return { type: "string" };
    if (l === "boolean" || l === "bool") return { type: "boolean" };
    if (l === "object" || /^object(<.*>)?$/i.test(t) || /^\{.*\}$/.test(t)) return { type: "object" };
    if (l === "null") return { type: "null" };
    fail("unsupported @param type {" + t + "} - use number, integer, string, boolean, object, array, a union, or *");
  }

  function analyze(source, filename) {
    source = String(source == null ? "" : source);
    if (!source.trim()) fail("the file is empty");
    if (source.length > MAX_SOURCE) fail("the file is larger than " + MAX_SOURCE / 1000 + " KB");
    var m = HEAD_RE.exec(source);
    if (!m) fail("the file must contain 'export default async function (...)'");
    if ((source.match(/\bexport\b/g) || []).length !== 1) fail("only one export is allowed: the default async function");
    if (/^\s*import\b/m.test(source) || /\bimport\s*\(/.test(source)) fail("imports are not available: a tool runs offline in the browser");

    // Syntax: compile (never run) the module body as a function.
    var body = "var __tool__;\n" + source.replace(/export\s+default\s+async\s+function/, "__tool__ = async function") + "\n;return __tool__;";
    try { new Function(body); } catch (err) { fail("syntax error: " + (err && err.message || err)); }

    // Signature: plain parameters (with optional defaults) only.
    var sig = [];
    m[2].split(",").map(function (p) { return p.trim(); }).filter(Boolean).forEach(function (p) {
      var pm = /^([A-Za-z_$][\w$]*)\s*(=[\s\S]*)?$/.exec(p);
      if (!pm) fail("parameter '" + p + "': use plain parameters (no destructuring or ...rest) - document each with @param");
      sig.push({ name: pm[1], hasDefault: !!pm[2] });
    });

    // JSDoc: the block comment right before the function.
    var before = source.slice(0, m.index);
    var dm = /\/\*\*([\s\S]*?)\*\/\s*$/.exec(before);
    if (!dm) fail("add a JSDoc comment (/** ... */) right above the function: its text is the tool's description");
    var lines = dm[1].split(/\r?\n/).map(function (l) { return l.replace(/^\s*\*? ?/, ""); });
    var desc = [], params = [], inTag = false;
    lines.forEach(function (line) {
      var t = line.trim();
      if (/^@param\b/.test(t)) {
        inTag = true;
        var pm = /^@param\s+\{([^}]+)\}\s+(\[)?([A-Za-z_$][\w$]*)(?:=([^\]]*))?\]?\s*(?:-\s*)?([\s\S]*)$/.exec(t);
        if (!pm) fail("cannot read '" + t + "' - write it as @param {type} name description");
        var type = pm[1].trim(), optional = !!pm[2];
        if (/=$/.test(type)) { optional = true; type = type.slice(0, -1); }
        params.push({ name: pm[3], type: type, description: pm[5].trim(), optional: optional });
      } else if (/^@/.test(t)) {
        inTag = true;
      } else if (inTag && params.length && t) {
        params[params.length - 1].description += " " + t;
      } else if (!inTag) {
        desc.push(line);
      }
    });
    var description = desc.join("\n").trim();
    if (!description) fail("the JSDoc comment needs a description (text before the @param tags)");

    var docNames = params.map(function (p) { return p.name; }).join(", ");
    var sigNames = sig.map(function (p) { return p.name; }).join(", ");
    if (docNames !== sigNames) fail("the @param tags (" + (docNames || "none") + ") must match the function's parameters (" + (sigNames || "none") + "), in order");

    var properties = {}, required = [];
    params.forEach(function (p, i) {
      var s = schemaFor(p.type);
      if (p.description) s.description = p.description;
      properties[p.name] = s;
      if (!p.optional && !sig[i].hasDefault) required.push(p.name);
      else p.optional = true;
    });

    var stem = String(filename || "").replace(/^.*[\\/]/, "").replace(/\.(m?js)$/i, "").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^[^A-Za-z]+/, "");
    var name = m[1] || stem;
    if (!NAME_RE.test(name || "")) fail("cannot derive a tool name: name the function (letters, digits, _ or -, starting with a letter)");

    return {
      ok: true,
      name: name,
      description: description,
      params: params,
      inputSchema: { type: "object", properties: properties, required: required, additionalProperties: false }
    };
  }

  // ---- running a tool (one iframe per call; the page owns everything else) ----
  var seq = 1, waiting = {}, logs = [], logBytes = 0;
  function api(method, args) {
    return new Promise(function (resolve, reject) {
      var s = seq++;
      waiting[s] = { resolve: resolve, reject: reject };
      var clean;
      try { clean = JSON.parse(JSON.stringify(args)); } catch (err) { delete waiting[s]; reject(new Error(method + ": arguments must be plain data")); return; }
      parent.postMessage({ type: "api", seq: s, method: method, args: clean }, "*");
    });
  }
  function fmt(v) {
    if (typeof v === "string") return v;
    try { var j = JSON.stringify(v); return j === undefined ? String(v) : j; } catch (e) { return String(v); }
  }
  function log(level) {
    return function () {
      var line = (level === "log" ? "" : level + ": ") + Array.prototype.map.call(arguments, fmt).join(" ");
      if (logs.length < 200 && logBytes < 20000) { logs.push(line.slice(0, 2000)); logBytes += line.length; }
    };
  }
  var sandboxConsole = Object.freeze({ log: log("log"), info: log("info"), warn: log("warn"), error: log("error"), debug: log("debug") });
  var ui = Object.freeze({
    add: function (spec) { return api("ui.add", [spec]); },
    update: function (id, props) { return api("ui.update", [id, props]); },
    get: function (id) { return api("ui.get", [id]); },
    remove: function (id) { return api("ui.remove", [id]); },
    clear: function () { return api("ui.clear", []); },
    list: function () { return api("ui.list", []); },
    wait: function (id, options) { return api("ui.wait", [id, options || {}]); },
    events: function (options) { return api("ui.events", [options || {}]); },
    toast: function (text, options) { return api("ui.toast", [String(text), options || {}]); }
  });
  var cursor = Object.freeze({
    move: function (id) { return api("cursor.move", [id]); },
    click: function (id) { return api("cursor.click", [id]); },
    type: function (id, text) { return api("cursor.type", [id, String(text)]); },
    fill: function (id, text) { return api("cursor.fill", [id, String(text)]); },
    check: function (id, value) { return api("cursor.check", [id, value === undefined ? true : !!value]); },
    select: function (id, value) { return api("cursor.select", [id, String(value)]); },
    drag: function (id, target) { return api("cursor.drag", [id, target]); },
    hover: function (id) { return api("cursor.hover", [id]); },
    dblclick: function (id) { return api("cursor.dblclick", [id]); },
    press: function (id, key) { return api("cursor.press", [id, String(key)]); },
    scroll: function (id) { return api("cursor.scroll", [id]); }
  });
  var kv = Object.freeze({
    get: function (key) { return api("kv.get", [String(key)]); },
    set: function (key, value) { return api("kv.set", [String(key), value === undefined ? null : value]); },
    delete: function (key) { return api("kv.delete", [String(key)]); },
    list: function (prefix) { return api("kv.list", [prefix === undefined ? "" : String(prefix)]); }
  });
  var db = Object.freeze({
    query: function (sql, params) { return api("db.query", [String(sql), params === undefined ? null : params]); },
    execute: function (sql, params) { return api("db.execute", [String(sql), params === undefined ? null : params]); }
  });
  function result(ok, value, error) {
    var text = null;
    if (ok) text = value === undefined ? "" : (typeof value === "string" ? value : fmt(value));
    parent.postMessage({ type: "result", ok: ok, text: text, error: error || null, logs: logs }, "*");
  }
  function run(d) {
    var source = String(d.source || "");
    var body = "var __tool__;\n" + source.replace(/export\s+default\s+async\s+function/, "__tool__ = async function") + "\n;return __tool__;";
    var fn;
    try { fn = new Function("ui", "cursor", "console", "client", "event", "kv", "db", body)(ui, cursor, sandboxConsole, Object.freeze(d.client || {}), d.event ? Object.freeze(d.event) : null, kv, db); }
    catch (err) { result(false, null, "the tool failed to load: " + (err && err.message || err)); return; }
    if (typeof fn !== "function") { result(false, null, "the tool has no default function"); return; }
    Promise.resolve().then(function () { return fn.apply(null, d.args || []); }).then(
      function (v) { result(true, v); },
      function (err) { result(false, null, err && err.message ? String(err.message) : String(err)); }
    );
  }

  window.addEventListener("message", function (e) {
    if (e.source !== parent) return;
    var d = e.data || {};
    if (d.type === "run") { run(d); return; }
    if (d.type === "api-result") {
      var w = waiting[d.seq];
      if (!w) return;
      delete waiting[d.seq];
      if (d.ok) w.resolve(d.value); else w.reject(new Error(d.error || "failed"));
      return;
    }
    if (d.type !== "analyze") return;
    var result;
    try { result = analyze(d.source, d.filename); }
    catch (err) { result = { ok: false, error: err && err.userFacing ? err.message : "invalid tool: " + (err && err.message || err) }; }
    parent.postMessage({ type: "analyzed", id: d.id, result: result }, "*");
  });
  parent.postMessage({ type: "ready" }, "*");
})();`;

const PAGE_JS = String.raw`(function () {
  "use strict";
  var DEVICE = window.__DEVICE__;
  // "basic": the browser signed in with HTTP Basic (/mcp). "token": the page was
  // opened at /mcp/{device} and asks for the device token itself.
  var MODE = window.__MODE__ || "basic";
  var TOKEN_KEY = "code-mcp.sandbox.token." + DEVICE;
  var deviceToken = MODE === "token" ? sessionStorage.getItem(TOKEN_KEY) : null;
  function authHeaders() {
    var h = { "x-sandbox": "1" };
    if (MODE === "token" && deviceToken) h.authorization = "Basic " + btoa(DEVICE + ":" + deviceToken);
    return h;
  }
  var KEY = "code-mcp.sandbox.tools." + DEVICE;
  var MAX_TOOLS = 50;
  var tools = load();
  var SEEDED_KEY = "code-mcp.sandbox.seeded." + DEVICE;
  var STARTERS = window.__STARTERS__ || [];
  var pending = [];
  var nextQid = 1;
  var showDropzone = false;
  var connected = false;
  var calls = [];
  var list = document.getElementById("list");
  var statusEl = document.getElementById("status");
  var picker = document.getElementById("picker");

  // ---- the sandbox runtime (opaque origin, no network, no storage) ----------
  var frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.src = "/mcp?frame=runtime";
  frame.title = "tool runtime";
  frame.style.display = "none";
  document.body.appendChild(frame);
  var ready, readyResolve;
  ready = new Promise(function (r) { readyResolve = r; });
  var waiting = {}, nextId = 1;
  window.addEventListener("message", function (e) {
    for (var i = 0; i < calls.length; i++) {
      if (calls[i].frame.contentWindow === e.source) { calls[i].onMessage(e.data || {}); return; }
    }
    if (e.source !== frame.contentWindow) return;
    var d = e.data || {};
    if (d.type === "ready") readyResolve();
    if (d.type === "analyzed" && waiting[d.id]) { waiting[d.id](d.result); delete waiting[d.id]; }
  });
  function analyze(source, filename) {
    return ready.then(function () {
      return new Promise(function (resolve) {
        var id = nextId++;
        var timer = setTimeout(function () { delete waiting[id]; resolve({ ok: false, error: "validation timed out" }); }, 5000);
        waiting[id] = function (r) { clearTimeout(timer); resolve(r); };
        frame.contentWindow.postMessage({ type: "analyze", id: id, source: source, filename: filename }, "*");
      });
    });
  }

  // ---- storage -----------------------------------------------------------------
  function load() {
    try { var v = JSON.parse(localStorage.getItem(KEY) || "[]"); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  }
  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(tools)); return true; }
    catch (e) { setStatus("could not save to this browser's storage: " + (e && e.message || e), true); return false; }
  }

  function setStatus(msg, isErr) { statusEl.textContent = msg || ""; statusEl.style.color = isErr ? "#b91c1c" : "#666"; }
  function argsLabel(t) {
    return "(" + (t.params || []).map(function (p) { return p.name + (p.optional ? "?" : ""); }).join(", ") + ")";
  }
  function closeMenus() { document.querySelectorAll(".menu.open").forEach(function (m) { m.classList.remove("open"); }); }
  document.addEventListener("click", closeMenus);

  function row(dotClass, cols, items, opts) {
    opts = opts || {};
    var li = document.createElement("li");
    li.className = "row" + (opts.disabled ? " disabled" : "");
    var d = document.createElement("span"); d.className = dotClass; li.appendChild(d);
    var box = document.createElement("div"); box.className = "box"; box.style.background = opts.tint || "#fff";
    var c = document.createElement("div"); c.className = "cols";
    cols.forEach(function (col) { var el = document.createElement("div"); el.className = col[0]; el.textContent = col[1]; if (col[2]) el.title = col[2]; c.appendChild(el); });
    box.appendChild(c);
    var wrap = document.createElement("div"); wrap.className = "menu-wrap";
    var btn = document.createElement("button"); btn.className = "menu-btn"; btn.type = "button"; btn.textContent = "\u22ef"; btn.setAttribute("aria-label", "Actions");
    var menu = document.createElement("div"); menu.className = "menu";
    items.forEach(function (item) {
      var b = document.createElement("button"); b.type = "button"; b.textContent = item.label;
      if (item.danger) b.className = "danger";
      if (item.disabled) b.disabled = true;
      b.addEventListener("click", function (ev) { ev.stopPropagation(); closeMenus(); item.run(); });
      menu.appendChild(b);
    });
    btn.addEventListener("click", function (ev) { ev.stopPropagation(); var open = menu.classList.contains("open"); closeMenus(); if (!open) menu.classList.add("open"); });
    wrap.appendChild(btn); wrap.appendChild(menu); box.appendChild(wrap);
    li.appendChild(box);
    if (opts.error) { var er = document.createElement("div"); er.className = "terr"; er.textContent = opts.error; li.appendChild(er); }
    return li;
  }

  function render() {
    list.innerHTML = "";
    tools.forEach(function (t) {
      var locked = connected;
      list.appendChild(row(t.active ? "dot on" : "dot off",
        [["tname", t.name], ["targs", argsLabel(t), argsLabel(t)], ["tdesc", t.description.split("\n")[0], t.description]],
        [
          { label: "View", run: function () { view(t); } },
          { label: "Download", run: function () { download(t.filename || t.name + ".js", t.source); } },
          { label: t.active ? "Deactivate" : "Activate", disabled: locked, run: function () { t.active = !t.active; persist(); render(); } },
          { label: "Delete", danger: true, disabled: locked, run: function () { askConfirm("Delete tool", "Delete the tool '" + t.name + "'? This cannot be undone.", "Delete").then(function (yes) { if (yes) { tools = tools.filter(function (x) { return x !== t; }); persist(); render(); } }); } }
        ], { disabled: !t.active }));
    });
    pending.forEach(function (p) {
      list.appendChild(row("dot pending",
        [["tname", p.filename], ["targs", ""], ["tdesc", p.error ? "not valid" : "not saved"]],
        [
          { label: "Save", disabled: connected, run: function () { savePending(p); } },
          { label: "View", run: function () { view(null, p); } },
          { label: "Delete", danger: true, run: function () { pending = pending.filter(function (x) { return x !== p; }); render(); } }
        ], { tint: p.error ? "#fee2e2" : "#fff", error: p.error }));
    });
    if (showDropzone && !connected) {
      var li = document.createElement("li"); li.className = "row";
      var sp = document.createElement("span"); sp.className = "dot-spacer"; li.appendChild(sp);
      var dz = document.createElement("div"); dz.className = "dropzone"; dz.id = "dropzone"; dz.textContent = "Drop a .js file here, or click to choose";
      dz.addEventListener("click", function () { picker.click(); });
      dz.addEventListener("dragover", function (e) { e.preventDefault(); dz.classList.add("over"); });
      dz.addEventListener("dragleave", function () { dz.classList.remove("over"); });
      dz.addEventListener("drop", function (e) { e.preventDefault(); dz.classList.remove("over"); addFiles(e.dataTransfer.files); });
      li.appendChild(dz); list.appendChild(li);
    }
    if (!tools.length && !pending.length && !showDropzone) {
      var em = document.createElement("li"); em.className = "empty"; em.textContent = "No tools yet. Click + to add one."; list.appendChild(em);
    }
    document.getElementById("addBtn").disabled = connected;
    if (typeof renderStarterOffer === "function" && document.getElementById("starters")) renderStarterOffer();
    var clrBtn = document.querySelector("#data .linkbtn"); if (clrBtn) clrBtn.disabled = connected;
    var active = tools.filter(function (t) { return t.active; }).length;
    document.getElementById("count").textContent = tools.length + " tool" + (tools.length === 1 ? "" : "s") + " \u00b7 " + active + " active";
  }

  function addFiles(fileList) {
    Array.prototype.forEach.call(fileList || [], function (f) {
      if (!/\.(m?js)$/i.test(f.name)) { setStatus(f.name + ": only .js files can be tools", true); return; }
      if (f.size > 200000) { setStatus(f.name + ": larger than 200 KB", true); return; }
      f.text().then(function (text) {
        pending.push({ qid: nextQid++, filename: f.name, source: text });
        showDropzone = false; setStatus(f.name + " loaded - Save to add it as a tool"); render();
      });
    });
  }
  picker.addEventListener("change", function () { addFiles(picker.files); picker.value = ""; });
  document.getElementById("addBtn").addEventListener("click", function () { if (connected) return; showDropzone = !showDropzone; render(); });

  /** Validate, then store. 'existing' is the tool being replaced (edit), if any. */
  function validateAndStore(source, filename, existing) {
    return analyze(source, filename).then(function (r) {
      if (!r.ok) return r;
      var clash = tools.filter(function (t) { return t.name === r.name && t !== existing; })[0];
      if (clash) return { ok: false, error: "a tool named '" + r.name + "' already exists" };
      if (!existing && tools.length >= MAX_TOOLS) return { ok: false, error: "at most " + MAX_TOOLS + " tools" };
      var tool = existing || { id: "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), active: true };
      tool.name = r.name; tool.description = r.description; tool.params = r.params; tool.inputSchema = r.inputSchema;
      tool.source = source; tool.filename = filename; tool.savedAt = new Date().toISOString();
      if (!existing) tools.push(tool);
      if (!persist()) { if (!existing) tools.pop(); return { ok: false, error: "browser storage is full" }; }
      return { ok: true, tool: tool };
    });
  }
  function savePending(p) {
    validateAndStore(p.source, p.filename, null).then(function (r) {
      if (!r.ok) { p.error = r.error; setStatus(p.filename + ": " + r.error, true); render(); return; }
      pending = pending.filter(function (x) { return x !== p; });
      setStatus("saved tool '" + r.tool.name + "'"); render();
    });
  }

  /** The page's own confirmation dialog (resolves true for the confirm button). */
  function askConfirm(title, message, okLabel) {
    return new Promise(function (resolve) {
      var overlay = document.createElement("div"); overlay.className = "overlay";
      var dlg = document.createElement("div"); dlg.className = "dlg dlg-confirm"; dlg.setAttribute("role", "alertdialog");
      var head = document.createElement("div"); head.className = "dlg-head";
      var t = document.createElement("span"); t.textContent = title; head.appendChild(t);
      var body = document.createElement("div"); body.className = "dlg-body";
      var msg = document.createElement("div"); msg.className = "dlg-msg"; msg.textContent = message;
      var bar = document.createElement("div"); bar.className = "dlg-bar";
      var cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "btn secondary"; cancel.textContent = "Cancel";
      var ok = document.createElement("button"); ok.type = "button"; ok.className = "btn danger"; ok.textContent = okLabel || "OK";
      bar.appendChild(cancel); bar.appendChild(ok); body.appendChild(msg); body.appendChild(bar);
      dlg.appendChild(head); dlg.appendChild(body); overlay.appendChild(dlg); document.body.appendChild(overlay);
      function done(v) { document.removeEventListener("keydown", key, true); overlay.remove(); resolve(v); }
      function key(e) { if (e.key === "Escape") { e.preventDefault(); done(false); } }
      document.addEventListener("keydown", key, true);
      cancel.addEventListener("click", function () { done(false); });
      ok.addEventListener("click", function () { done(true); });
      overlay.addEventListener("click", function (e) { if (e.target === overlay) done(false); });
      cancel.focus();
    });
  }

  function download(name, text) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function view(tool, p) {
    var overlay = document.createElement("div"); overlay.className = "overlay";
    var dlg = document.createElement("div"); dlg.className = "dlg dlg-wide";
    var head = document.createElement("div"); head.className = "dlg-head";
    var title = document.createElement("span"); title.textContent = tool ? tool.name : p.filename;
    var sub = document.createElement("span"); sub.className = "dlg-id"; sub.textContent = tool ? argsLabel(tool) : "not saved";
    var x = document.createElement("button"); x.type = "button"; x.className = "dlg-close"; x.title = "Close"; x.innerHTML = "&times;";
    head.appendChild(title); head.appendChild(sub); head.appendChild(x);
    var body = document.createElement("div"); body.className = "dlg-body";
    var ta = document.createElement("textarea"); ta.className = "src"; ta.spellcheck = false; ta.value = tool ? tool.source : p.source;
    ta.readOnly = connected;
    var msg = document.createElement("div"); msg.className = "dlg-msg";
    msg.textContent = connected ? "Connected: disconnect to edit." : "Edit, then Save. The file is validated before it is stored.";
    var bar = document.createElement("div"); bar.className = "dlg-bar";
    var save = document.createElement("button"); save.type = "button"; save.className = "btn"; save.textContent = "Save"; save.disabled = connected;
    bar.appendChild(save);
    body.appendChild(ta); body.appendChild(msg); body.appendChild(bar);
    dlg.appendChild(head); dlg.appendChild(body); overlay.appendChild(dlg); document.body.appendChild(overlay);
    function close() { overlay.remove(); }
    x.addEventListener("click", close);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
    save.addEventListener("click", function () {
      save.disabled = true;
      var filename = tool ? tool.filename || tool.name + ".js" : p.filename;
      validateAndStore(ta.value, filename, tool).then(function (r) {
        save.disabled = false;
        if (!r.ok) { msg.textContent = r.error; msg.className = "dlg-msg err"; return; }
        if (p) pending = pending.filter(function (q) { return q !== p; });
        setStatus("saved tool '" + r.tool.name + "'"); render(); close();
      });
    });
  }

  // ===========================================================================
  // Connection: a Worker owns the WebSocket (timers in a background tab are
  // throttled; a Worker's are not), the page speaks MCP over the tunnel.
  // ===========================================================================
  var connectBtn = document.getElementById("connect");
  var connInfo = document.getElementById("conninfo");
  var dashSection = document.getElementById("dash");
  var dashArea = document.getElementById("dash-area");
  var conn = { worker: null, state: "idle", userClosed: false, retry: 0, timer: null, mcpUrl: "", registered: false };
  var WORKER_SRC = [
    "var ws = null, beat = null;",
    "onmessage = function (e) {",
    "  var d = e.data || {};",
    "  if (d.type === 'open') {",
    "    try { ws = new WebSocket(d.url); } catch (err) { postMessage({ type: 'close', code: 0, reason: String(err) }); return; }",
    "    ws.onopen = function () { ws.send(JSON.stringify({ type: 'register', deviceId: d.deviceId })); beat = setInterval(function () { try { ws.send('{\"type\":\"keepalive\"}'); } catch (x) {} }, 20000); postMessage({ type: 'open' }); };",
    "    ws.onmessage = function (ev) { postMessage({ type: 'message', data: ev.data }); };",
    "    ws.onclose = function (ev) { clearInterval(beat); postMessage({ type: 'close', code: ev.code, reason: ev.reason }); };",
    "  } else if (d.type === 'send') { if (ws && ws.readyState === 1) ws.send(d.data); }",
    "  else if (d.type === 'close') { if (ws) ws.close(1000, 'disconnected by the user'); }",
    "};"
  ].join("\n");

  // The tab's icon turns green while connected (as browser-mcp's toolbar icon does).
  var faviconEl = document.getElementById("favicon");
  var FAVICON_OFF = faviconEl ? faviconEl.href : "";
  var FAVICON_ON = FAVICON_OFF.replace(/%23111111/g, "%2316a34a");
  function setConn(state, info) {
    conn.state = state;
    if (faviconEl) faviconEl.href = state === "connected" ? FAVICON_ON : FAVICON_OFF;
    document.title = (state === "connected" ? "\u25cf " : "") + "Prime - Sandbox";
    var wasConnected = connected;
    connected = state !== "idle";
    connectBtn.disabled = state === "connecting";
    connectBtn.textContent = state === "idle" ? "Connect" : state === "connecting" ? "Connecting\u2026" : "Disconnect";
    connectBtn.classList.toggle("on", state === "connected");
    dashSection.hidden = state === "idle" && !Object.keys(comps).length;
    connInfo.textContent = info || "";
    if (state === "idle") { abortCalls("the sandbox was disconnected"); clearCursors(); }
    emptyHint();
    if (wasConnected !== connected) render();
  }

  function connect(first) {
    conn.userClosed = false;
    clearTimeout(conn.timer);
    if (first) setConn("connecting");
    fetch("/mcp?ticket=1", { method: "POST", headers: authHeaders(), credentials: "same-origin", cache: "no-store" })
      .then(function (r) {
        if (r.status === 401) {
          if (MODE === "token") { forgetToken(); throw new Error("the device token was refused - enter it again"); }
          throw new Error("signed out - reload the page and sign in again");
        }
        if (r.status === 403) throw new Error("this device is disabled - an admin has to activate it again");
        if (!r.ok) throw new Error("ticket request failed (HTTP " + r.status + ")");
        return r.json();
      })
      .then(function (t) {
        if (conn.userClosed) return;
        if (t.online && first) {
          setConn("idle");
          setStatus("Device " + DEVICE + " is already connected from somewhere else (for example code-mcp or 'mcp connect'). Stop it there, then Connect.", true);
          return;
        }
        conn.mcpUrl = t.mcp_url;
        openSocket(t.ws_url);
      })
      .catch(function (err) {
        if (conn.userClosed) return;
        if (first) { setConn("idle"); setStatus("Could not connect: " + (err && err.message || err), true); }
        else scheduleReconnect();
      });
  }

  function openSocket(url) {
    if (conn.worker) conn.worker.terminate();
    var blobUrl = URL.createObjectURL(new Blob([WORKER_SRC], { type: "text/javascript" }));
    var w = new Worker(blobUrl);
    URL.revokeObjectURL(blobUrl);
    conn.worker = w;
    conn.registered = false;
    w.onmessage = function (e) {
      if (w !== conn.worker) return;
      var d = e.data || {};
      if (d.type === "message") onFrame(d.data);
      else if (d.type === "close") onClose(d.code, d.reason);
    };
    w.postMessage({ type: "open", url: url, deviceId: DEVICE });
  }

  function onFrame(raw) {
    var msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "registered") {
      conn.registered = true;
      conn.retry = 0;
      setStatus("");
      setConn("connected");
      return;
    }
    if (msg.type) return;
    if (typeof msg.id === "string" && msg.request) handleRpc(msg);
  }

  function onClose(code, reason) {
    if (conn.worker) { conn.worker.terminate(); conn.worker = null; }
    if (conn.userClosed || conn.state === "idle") return;
    if (!conn.registered && conn.state === "connecting") {
      setConn("idle");
      setStatus("Could not connect: the gateway refused the tunnel (" + (reason || "code " + code) + "). Is " + DEVICE + " connected from somewhere else?", true);
      return;
    }
    if (/replaced/.test(reason || "")) {
      setConn("idle");
      setStatus("Disconnected: another connection for " + DEVICE + " replaced this one.", true);
      return;
    }
    abortCalls("the connection to the gateway was lost");
    scheduleReconnect();
  }

  function scheduleReconnect() {
    conn.retry += 1;
    if (conn.retry > 8) { setConn("idle"); setStatus("Disconnected: the gateway could not be reached. Connect to try again.", true); return; }
    var delay = Math.min(30000, 1000 * Math.pow(2, conn.retry - 1));
    setConn("reconnecting", "Reconnecting in " + Math.round(delay / 1000) + " s\u2026");
    conn.timer = setTimeout(function () { connect(false); }, delay);
  }

  function disconnect() {
    conn.userClosed = true;
    clearTimeout(conn.timer);
    if (conn.worker) { conn.worker.postMessage({ type: "close" }); var w = conn.worker; conn.worker = null; setTimeout(function () { w.terminate(); }, 500); }
    setConn("idle");
    setStatus("Disconnected.");
  }

  connectBtn.addEventListener("click", function () {
    if (conn.state === "idle") connect(true); else disconnect();
  });
  window.addEventListener("beforeunload", function () { if (conn.worker) conn.worker.postMessage({ type: "close" }); });

  function send(obj) { if (conn.worker) conn.worker.postMessage({ type: "send", data: JSON.stringify(obj) }); }

  // ===========================================================================
  // MCP: exactly two tools, search and call.
  // ===========================================================================
  var SEARCH_TOOL = {
    name: "search",
    description: "Search the tools available in the browser sandbox of device " + DEVICE + ". Returns each match's name, description and inputSchema; run one with the 'call' tool. An empty query lists every active tool.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Words to look for in tool names, descriptions and parameter names" }, limit: { type: "integer", minimum: 1, maximum: 50, description: "At most this many results (default 20)" } }, additionalProperties: false }
  };
  var CALL_TOOL = {
    name: "call",
    description: "Run one of the sandbox's tools (find them with 'search') in the browser of device " + DEVICE + ". Tools can show UI and use a virtual cursor in the page's dash area.",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "The tool's name, as returned by search" }, arguments: { type: "object", description: "The tool's arguments, matching its inputSchema" } }, required: ["name"], additionalProperties: false }
  };

  function handleRpc(env) {
    var req = env.request || {};
    var client = env.client && typeof env.client === "object" ? { id: String(env.client.id || "client").slice(0, 32), name: String(env.client.name || "client").slice(0, 40) } : { id: "client", name: "client" };
    if (!Object.prototype.hasOwnProperty.call(req, "id")) { send({ id: env.id, response: null }); return; }
    Promise.resolve().then(function () { return dispatch(req, client); }).then(
      function (result) { send({ id: env.id, response: { jsonrpc: "2.0", id: req.id, result: result } }); },
      function (err) { send({ id: env.id, response: { jsonrpc: "2.0", id: req.id, error: { code: err && err.code || -32603, message: String(err && err.message || err) } } }); }
    );
  }

  function rpcError(code, message) { var e = new Error(message); e.code = code; return e; }
  function textResult(text, isError) { var r = { content: [{ type: "text", text: text }] }; if (isError) r.isError = true; return r; }

  function dispatch(req, client) {
    var p = req.params || {};
    if (req.method === "initialize") {
      return {
        protocolVersion: typeof p.protocolVersion === "string" ? p.protocolVersion : "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "code-mcp-sandbox", version: "1.0.0" },
        instructions: "Tools run in a browser (device " + DEVICE + "). Use 'search' to find a tool and its inputSchema, then 'call' it with {name, arguments}."
      };
    }
    if (req.method === "ping") return {};
    if (req.method === "tools/list") return { tools: [SEARCH_TOOL, CALL_TOOL] };
    if (req.method === "resources/list") return { resources: [] };
    if (req.method === "prompts/list") return { prompts: [] };
    if (req.method === "tools/call") {
      if (p.name === "search") return search(p.arguments || {});
      if (p.name === "call") return callTool(p.arguments || {}, client);
      return textResult("unknown tool '" + p.name + "': this device has 'search' and 'call'", true);
    }
    throw rpcError(-32601, "method not found: " + req.method);
  }

  function activeTools() { return tools.filter(function (t) { return t.active; }); }
  function toolView(t) { return { name: t.name, description: t.description, inputSchema: t.inputSchema }; }

  function search(args) {
    if (args.query !== undefined && typeof args.query !== "string") return textResult("'query' must be a string", true);
    var limit = args.limit === undefined ? 20 : args.limit;
    if (typeof limit !== "number" || !(limit >= 1 && limit <= 50) || Math.floor(limit) !== limit) return textResult("'limit' must be an integer from 1 to 50", true);
    var words = String(args.query || "").toLowerCase().split(/\s+/).filter(Boolean);
    var scored = [];
    activeTools().forEach(function (t) {
      var name = t.name.toLowerCase(), desc = t.description.toLowerCase();
      var params = (t.params || []).map(function (q) { return (q.name + " " + q.description).toLowerCase(); }).join(" ");
      var score = 0, all = true;
      words.forEach(function (w) {
        var s = (name.indexOf(w) >= 0 ? 3 : 0) + (desc.indexOf(w) >= 0 ? 2 : 0) + (params.indexOf(w) >= 0 ? 1 : 0);
        if (!s) all = false;
        score += s;
      });
      if (all) scored.push({ t: t, score: score });
    });
    scored.sort(function (a, b) { return b.score - a.score || (a.t.name < b.t.name ? -1 : 1); });
    var out = { total: scored.length, tools: scored.slice(0, limit).map(function (s) { return toolView(s.t); }) };
    return textResult(JSON.stringify(out, null, 2));
  }

  function typeOk(value, schema) {
    if (!schema || schema.type === undefined) return true;
    var types = Array.isArray(schema.type) ? schema.type : [schema.type];
    return types.some(function (t) {
      if (t === "integer") return typeof value === "number" && Math.floor(value) === value;
      if (t === "array") return Array.isArray(value);
      if (t === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
      if (t === "null") return value === null;
      return typeof value === t;
    });
  }

  function argProblems(t, a) {
    var props = t.inputSchema.properties || {}, problems = [];
    Object.keys(a).forEach(function (k) { if (!Object.prototype.hasOwnProperty.call(props, k)) problems.push("unknown argument '" + k + "'"); });
    (t.inputSchema.required || []).forEach(function (k) { if (a[k] === undefined) problems.push("missing required argument '" + k + "'"); });
    Object.keys(props).forEach(function (k) {
      if (a[k] !== undefined && !typeOk(a[k], props[k])) problems.push("'" + k + "' must be " + [].concat(props[k].type).join(" or "));
    });
    return problems;
  }

  function callTool(args, client) {
    if (typeof args.name !== "string") return textResult("'name' must be a string: the tool's name from search", true);
    var t = activeTools().filter(function (x) { return x.name === args.name; })[0];
    if (!t) return textResult("no active tool named '" + args.name + "' - use search to list the tools", true);
    var a = args.arguments === undefined ? {} : args.arguments;
    if (a === null || typeof a !== "object" || Array.isArray(a)) return textResult("'arguments' must be an object", true);
    var problems = argProblems(t, a);
    if (problems.length) return textResult("invalid arguments for '" + t.name + "': " + problems.join("; ") + ". inputSchema: " + JSON.stringify(t.inputSchema), true);
    var positional = (t.params || []).map(function (q) { return a[q.name]; });
    return runTool(t, positional, client).then(function (r) {
      var text = r.ok ? r.text : "error: " + r.error;
      if (r.logs && r.logs.length) text += "\n--- console ---\n" + r.logs.join("\n");
      return textResult(text, !r.ok);
    });
  }

  // One sandboxed iframe per call: calls cannot see each other, and a hung or
  // runaway tool is stopped by removing its frame.
  var CALL_TIMEOUT_MS = 120000;
  var runner = document.createElement("div");
  runner.style.display = "none";
  document.body.appendChild(runner);

  function runTool(tool, args, client, event) {
    return new Promise(function (resolve) {
      var f = document.createElement("iframe");
      f.setAttribute("sandbox", "allow-scripts");
      f.src = "/mcp?frame=runtime";
      var call = { frame: f, tool: tool, client: client, done: false, waiters: [] };
      var timer = setTimeout(function () { finish({ ok: false, error: "the tool did not finish within " + CALL_TIMEOUT_MS / 1000 + " s and was stopped", logs: [] }); }, CALL_TIMEOUT_MS);
      function finish(r) {
        if (call.done) return;
        call.done = true;
        clearTimeout(timer);
        f.remove();
        calls = calls.filter(function (c) { return c !== call; });
        call.waiters.slice().forEach(function (w) { w.cancel("the call ended"); });
        updateRunning();
        resolve(r);
      }
      call.finish = finish;
      call.onMessage = function (d) {
        if (d.type === "ready") f.contentWindow.postMessage({ type: "run", source: tool.source, args: args, client: client, event: event || null }, "*");
        else if (d.type === "result") finish({ ok: !!d.ok, text: d.text == null ? "" : String(d.text), error: d.error, logs: Array.isArray(d.logs) ? d.logs.map(String) : [] });
        else if (d.type === "api") handleApi(call, d);
      };
      calls.push(call);
      call.waitingFor = 0;
      runner.appendChild(f);
      updateRunning();
    });
  }

  function abortCalls(why) { calls.slice().forEach(function (c) { c.finish({ ok: false, error: why, logs: [] }); }); }
  // A client's cursor shows a spinner while any of its calls is running.
  function updateRunning() {
    var busy = {};
    calls.forEach(function (c) { if (c.client && !c.waitingFor) busy[c.client.id] = (busy[c.client.id] || 0) + 1; });
    Object.keys(cursors).forEach(function (k) {
      var was = cursors[k].el.classList.contains("busy");
      cursors[k].el.classList.toggle("busy", !!busy[k]);
      if (was && !busy[k]) touch(cursors[k]);
    });
  }

  function handleApi(call, d) {
    var fn = API[d.method];
    if (call.client && conn.state !== "idle" && !/^ui\.(wait|events|list|get)$|^kv\.|^db\./.test(d.method)) cursorFor(call.client);
    Promise.resolve().then(function () {
      if (!fn) throw new Error("unknown method " + d.method);
      return fn(call, Array.isArray(d.args) ? d.args : []);
    }).then(
      function (v) { if (!call.done) call.frame.contentWindow.postMessage({ type: "api-result", seq: d.seq, ok: true, value: v === undefined ? null : v }, "*"); },
      function (err) { if (!call.done) call.frame.contentWindow.postMessage({ type: "api-result", seq: d.seq, ok: false, error: String(err && err.message || err) }, "*"); }
    );
  }

  // ===========================================================================
  // Dash: components (rendered by the page, styled by the page) and cursors.
  // ===========================================================================
  var comps = {}, order = 0, cursors = {};
  var MAX_COMPONENTS = 300;
  var CONTAINERS = { row: 1, column: 1, grid: 1, card: 1, tabs: 1, accordion: 1, modal: 1, drawer: 1 };
  var PALETTE = ["#2563eb", "#db2777", "#16a34a", "#ea580c", "#7c3aed", "#0891b2", "#ca8a04"];

  function str(v, max) { return v === undefined || v === null ? "" : String(v).slice(0, max || 2000); }
  function compOf(id) { var c = comps[id]; if (!c) throw new Error("no component '" + id + "'"); return c; }
  function emptyHint() {
    var e = dashArea.querySelector(".dash-empty");
    var any = Object.keys(comps).length > 0;
    if (e) e.hidden = any;
    if (typeof conn !== "undefined") {
      dashSection.hidden = conn.state === "idle" && !any;
    }
  }

  // ---- drawn controls (no native checkbox, select or range) ----------------------
  // Each exposes the properties the dash code reads - value / checked / options
  // / disabled - and fires "change" (and "input") like the native ones would.
  function prop(el, name, get, set) { Object.defineProperty(el, name, { get: get, set: set, configurable: true }); }
  function fire(el, type) { el.dispatchEvent(new Event(type, { bubbles: true })); }

  function makeCheckbox(text, initial) {
    var root = document.createElement("div");
    root.className = "ucheck"; root.tabIndex = 0; root.setAttribute("role", "checkbox");
    var box = document.createElement("span"); box.className = "ucheck-box";
    box.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2 L5 8.6 L9.6 3.6" /></svg>';
    var t = document.createElement("span"); t.textContent = text;
    root.appendChild(box); root.appendChild(t);
    var checked = !!initial, disabled = false;
    function paint() { root.classList.toggle("on", checked); root.setAttribute("aria-checked", checked ? "true" : "false"); }
    prop(root, "checked", function () { return checked; }, function (v) { checked = !!v; paint(); });
    prop(root, "disabled", function () { return disabled; }, function (v) { disabled = !!v; root.classList.toggle("disabled", disabled); root.tabIndex = disabled ? -1 : 0; root.setAttribute("aria-disabled", String(disabled)); });
    function toggle() { if (disabled) return; checked = !checked; paint(); fire(root, "change"); }
    root.addEventListener("click", toggle);
    root.addEventListener("keydown", function (e) { if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggle(); } });
    paint();
    return root;
  }

  var openSelect = null;
  document.addEventListener("click", function (e) { if (openSelect && !openSelect.contains(e.target) && !openSelect.__list.contains(e.target)) openSelect.__close(); });
  window.addEventListener("resize", function () { if (openSelect) openSelect.__close(); });
  document.addEventListener("scroll", function () { if (openSelect) openSelect.__close(); }, true);

  function makeSelect(opts, initial) {
    var root = document.createElement("div");
    root.className = "usel"; root.tabIndex = 0;
    root.setAttribute("role", "combobox"); root.setAttribute("aria-haspopup", "listbox"); root.setAttribute("aria-expanded", "false");
    var shown = document.createElement("span"); shown.className = "usel-value";
    var chev = document.createElement("span"); chev.className = "usel-chev";
    chev.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 4l4 4 4-4" /></svg>';
    root.appendChild(shown); root.appendChild(chev);
    // The list is fixed-positioned on the page, so the dash's scroll box cannot clip it.
    var list = document.createElement("div"); list.className = "usel-list"; list.setAttribute("role", "listbox");
    var current = opts.some(function (o) { return o.value === initial; }) ? initial : opts[0].value;
    var active = 0, disabled = false;
    var items = opts.map(function (o, i) {
      var it = document.createElement("div"); it.className = "usel-item"; it.setAttribute("role", "option"); it.textContent = o.label;
      it.addEventListener("mousedown", function (e) { e.preventDefault(); });
      it.addEventListener("click", function (e) { e.stopPropagation(); choose(o.value); root.focus(); });
      it.addEventListener("mousemove", function () { setActive(i); });
      list.appendChild(it);
      return it;
    });
    function indexOf(v) { for (var i = 0; i < opts.length; i++) if (opts[i].value === v) return i; return -1; }
    function paint() {
      var i = indexOf(current);
      shown.textContent = i >= 0 ? opts[i].label : "";
      items.forEach(function (it, k) { it.setAttribute("aria-selected", k === i ? "true" : "false"); });
    }
    function setActive(i) { active = Math.max(0, Math.min(opts.length - 1, i)); items.forEach(function (it, k) { it.classList.toggle("active", k === active); }); items[active].scrollIntoView({ block: "nearest" }); }
    function open() {
      if (disabled || root.__isOpen) return;
      if (openSelect && openSelect !== root) openSelect.__close();
      document.body.appendChild(list);
      var r = root.getBoundingClientRect();
      list.style.minWidth = r.width + "px";
      list.style.left = r.left + "px";
      var h = Math.min(list.scrollHeight, 240);
      list.style.top = (r.bottom + 4 + h > window.innerHeight && r.top - 4 - h > 0 ? r.top - 4 - h : r.bottom + 4) + "px";
      root.__isOpen = true; openSelect = root;
      root.classList.add("open"); root.setAttribute("aria-expanded", "true");
      setActive(Math.max(0, indexOf(current)));
    }
    function close() {
      if (!root.__isOpen) return;
      root.__isOpen = false; if (openSelect === root) openSelect = null;
      list.remove(); root.classList.remove("open"); root.setAttribute("aria-expanded", "false");
    }
    function choose(v) { var changed = v !== current; current = v; paint(); close(); if (changed) fire(root, "change"); }
    root.addEventListener("click", function () { if (root.__isOpen) close(); else open(); });
    root.addEventListener("keydown", function (e) {
      if (disabled) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (!root.__isOpen) open(); else setActive(active + (e.key === "ArrowDown" ? 1 : -1)); }
      else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (root.__isOpen) choose(opts[active].value); else open(); }
      else if (e.key === "Escape" || e.key === "Tab") close();
      else if (e.key === "Home" && root.__isOpen) { e.preventDefault(); setActive(0); }
      else if (e.key === "End" && root.__isOpen) { e.preventDefault(); setActive(opts.length - 1); }
    });
    root.addEventListener("blur", function () { setTimeout(function () { if (document.activeElement !== root) close(); }, 0); });
    prop(root, "value", function () { return current; }, function (v) { v = String(v); if (indexOf(v) >= 0) { current = v; paint(); } });
    prop(root, "options", function () { return opts.map(function (o) { return { value: o.value, label: o.label }; }); });
    prop(root, "disabled", function () { return disabled; }, function (v) { disabled = !!v; if (disabled) close(); root.classList.toggle("disabled", disabled); root.tabIndex = disabled ? -1 : 0; root.setAttribute("aria-disabled", String(disabled)); });
    root.__open = open; root.__close = close; root.__list = list;
    root.__item = function (v) { var i = indexOf(v); return i >= 0 ? items[i] : null; };
    paint();
    return root;
  }

  function makeToggle(text, initial) {
    var root = document.createElement("div");
    root.className = "utoggle"; root.tabIndex = 0; root.setAttribute("role", "switch");
    var track = document.createElement("span"); track.className = "utoggle-track";
    var knob = document.createElement("span"); knob.className = "utoggle-knob"; track.appendChild(knob);
    var t = document.createElement("span"); t.textContent = text;
    root.appendChild(track); root.appendChild(t);
    var checked = !!initial, disabled = false;
    function paint() { root.classList.toggle("on", checked); root.setAttribute("aria-checked", checked ? "true" : "false"); }
    prop(root, "checked", function () { return checked; }, function (v) { checked = !!v; paint(); });
    prop(root, "disabled", function () { return disabled; }, function (v) { disabled = !!v; root.classList.toggle("disabled", disabled); root.tabIndex = disabled ? -1 : 0; root.setAttribute("aria-disabled", String(disabled)); });
    function flip() { if (disabled) return; checked = !checked; paint(); fire(root, "change"); }
    root.addEventListener("click", flip);
    root.addEventListener("keydown", function (e) { if (e.key === " " || e.key === "Enter") { e.preventDefault(); flip(); } });
    paint();
    return root;
  }

  function makeRadio(opts, initial, horizontal) {
    var root = document.createElement("div");
    root.className = "uradio" + (horizontal ? " row" : ""); root.tabIndex = 0; root.setAttribute("role", "radiogroup");
    var current = opts.some(function (o) { return o.value === initial; }) ? initial : opts[0].value, disabled = false;
    var items = opts.map(function (o) {
      var it = document.createElement("div"); it.className = "uradio-opt"; it.setAttribute("role", "radio");
      var dot = document.createElement("span"); dot.className = "uradio-dot";
      var t = document.createElement("span"); t.textContent = o.label;
      it.appendChild(dot); it.appendChild(t);
      it.addEventListener("click", function () { choose(o.value); });
      root.appendChild(it);
      return it;
    });
    function indexOf(v) { for (var i = 0; i < opts.length; i++) if (opts[i].value === v) return i; return -1; }
    function paint() { var i = indexOf(current); items.forEach(function (it, k) { it.classList.toggle("on", k === i); it.setAttribute("aria-checked", k === i ? "true" : "false"); }); }
    function choose(v) { if (disabled) return; var changed = v !== current; current = v; paint(); if (changed) fire(root, "change"); }
    root.addEventListener("keydown", function (e) {
      var i = indexOf(current);
      if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); choose(opts[(i + 1) % opts.length].value); }
      else if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); choose(opts[(i - 1 + opts.length) % opts.length].value); }
    });
    prop(root, "value", function () { return current; }, function (v) { v = String(v); if (indexOf(v) >= 0) { current = v; paint(); } });
    prop(root, "options", function () { return opts.map(function (o) { return { value: o.value, label: o.label }; }); });
    prop(root, "disabled", function () { return disabled; }, function (v) { disabled = !!v; root.classList.toggle("disabled", disabled); root.tabIndex = disabled ? -1 : 0; });
    root.__item = function (v) { var i = indexOf(v); return i >= 0 ? items[i] : null; };
    paint();
    return root;
  }

  function makeSlider(min, max, step, initial) {
    var root = document.createElement("div");
    root.className = "uslide"; root.tabIndex = 0; root.setAttribute("role", "slider");
    root.setAttribute("aria-valuemin", String(min)); root.setAttribute("aria-valuemax", String(max));
    var track = document.createElement("div"); track.className = "uslide-track";
    var fill = document.createElement("div"); fill.className = "uslide-fill";
    var thumb = document.createElement("div"); thumb.className = "uslide-thumb";
    var out = document.createElement("span"); out.className = "uslide-value";
    track.appendChild(fill); track.appendChild(thumb); root.appendChild(track); root.appendChild(out);
    var value = min, disabled = false;
    function snap(v) {
      v = Math.max(min, Math.min(max, Number(v)));
      if (!isFinite(v)) v = min;
      v = min + Math.round((v - min) / step) * step;
      return Math.max(min, Math.min(max, Number(v.toFixed(10))));
    }
    function paint() {
      var p = (value - min) / (max - min) * 100;
      fill.style.width = p + "%"; thumb.style.left = p + "%";
      out.textContent = String(value); root.setAttribute("aria-valuenow", String(value));
    }
    function set(v, evt) { var n = snap(v); if (n === value) return; value = n; paint(); if (evt) fire(root, "input"); }
    function fromX(x) { var r = track.getBoundingClientRect(); return min + (Math.max(0, Math.min(r.width, x - r.left)) / (r.width || 1)) * (max - min); }
    root.addEventListener("pointerdown", function (e) {
      if (disabled) return;
      e.preventDefault(); root.focus();
      var start = value;
      root.setPointerCapture(e.pointerId);
      root.classList.add("dragging");
      set(fromX(e.clientX), true);
      function move(ev) { set(fromX(ev.clientX), true); }
      function up() {
        root.removeEventListener("pointermove", move); root.removeEventListener("pointerup", up); root.removeEventListener("pointercancel", up);
        root.classList.remove("dragging");
        if (value !== start) fire(root, "change");
      }
      root.addEventListener("pointermove", move); root.addEventListener("pointerup", up); root.addEventListener("pointercancel", up);
    });
    root.addEventListener("keydown", function (e) {
      if (disabled) return;
      var before = value, big = Math.max(step, (max - min) / 10);
      if (e.key === "ArrowRight" || e.key === "ArrowUp") set(value + step, true);
      else if (e.key === "ArrowLeft" || e.key === "ArrowDown") set(value - step, true);
      else if (e.key === "PageUp") set(value + big, true);
      else if (e.key === "PageDown") set(value - big, true);
      else if (e.key === "Home") set(min, true);
      else if (e.key === "End") set(max, true);
      else return;
      e.preventDefault();
      if (value !== before) fire(root, "change");
    });
    prop(root, "value", function () { return String(value); }, function (v) { set(v, false); });
    prop(root, "min", function () { return String(min); }, function () {});
    prop(root, "max", function () { return String(max); }, function () {});
    prop(root, "disabled", function () { return disabled; }, function (v) { disabled = !!v; root.classList.toggle("disabled", disabled); root.tabIndex = disabled ? -1 : 0; root.setAttribute("aria-disabled", String(disabled)); });
    value = snap(initial); paint();
    return root;
  }

  var TYPES = ["heading", "text", "code", "image", "editor", "button", "input", "textarea", "checkbox", "toggle", "radio", "select", "slider", "progress", "status", "badge", "alert", "stat", "table", "list", "divider", "row", "column", "grid", "card", "tabs", "accordion", "modal", "drawer"];
  // Every component: hidden, width (px number or a CSS length/percent), grow.
  function applyCommon(el, spec) {
    el.hidden = !!spec.hidden;
    if (spec.width !== undefined && el.className.indexOf("uc-modal") < 0 && el.className.indexOf("uc-drawer") < 0) {
      var w = typeof spec.width === "number" ? Math.max(20, Math.min(2000, spec.width)) + "px" : /^\d{1,4}(px|%|rem|em|ch)$/.test(String(spec.width)) ? String(spec.width) : "";
      if (w) { el.style.width = w; el.style.flex = "0 0 " + w; }
    }
    if (spec.grow) el.style.flex = "1 1 0";
  }

  function makeTable(spec) {
    var cols = (Array.isArray(spec.columns) ? spec.columns : []).slice(0, 20).map(function (c, i) {
      if (c && typeof c === "object") return { key: c.key !== undefined ? String(c.key) : String(c.label !== undefined ? c.label : i), label: str(c.label !== undefined ? c.label : c.key, 80), align: c.align === "right" || c.align === "center" ? c.align : "left" };
      return { key: String(c), label: str(c, 80), align: "left" };
    });
    if (!cols.length) throw new Error("table: give it columns, e.g. columns: ['Name', 'Status'] or [{ key: 'name', label: 'Name' }]");
    var raw = (Array.isArray(spec.rows) ? spec.rows : []).slice(0, 1000);
    var rows = raw.map(function (r, i) {
      var cells = cols.map(function (c, k) { var v = Array.isArray(r) ? r[k] : r && typeof r === "object" ? r[c.key] : k === 0 ? r : ""; return v === undefined || v === null ? "" : v; });
      return { index: i, cells: cells, raw: r };
    });
    var root = document.createElement("div"); root.className = "utable"; root.tabIndex = -1;
    var table = document.createElement("table"), thead = document.createElement("thead"), tbody = document.createElement("tbody");
    var hr = document.createElement("tr");
    var sortKey = -1, sortDir = 1, selected = Number.isInteger(spec.value) ? spec.value : -1, disabled = false;
    var sortable = spec.sortable !== false, selectable = spec.selectable !== false;
    cols.forEach(function (c, k) {
      var th = document.createElement("th"); th.textContent = c.label; th.style.textAlign = c.align;
      if (sortable) { th.classList.add("sortable"); th.addEventListener("click", function () { sortDir = sortKey === k ? -sortDir : 1; sortKey = k; paint(); }); }
      hr.appendChild(th);
    });
    thead.appendChild(hr); table.appendChild(thead); table.appendChild(tbody); root.appendChild(table);
    if (selectable) root.classList.add("selectable");
    var trs = {};
    function cmp(a, b) {
      var x = a.cells[sortKey], y = b.cells[sortKey];
      var nx = typeof x === "number" ? x : Number(x), ny = typeof y === "number" ? y : Number(y);
      if (x !== "" && y !== "" && !isNaN(nx) && !isNaN(ny)) return (nx - ny) * sortDir;
      return String(x).localeCompare(String(y)) * sortDir;
    }
    function paint() {
      tbody.innerHTML = ""; trs = {};
      var list = sortKey >= 0 ? rows.slice().sort(cmp) : rows;
      Array.prototype.forEach.call(hr.children, function (th, k) { th.dataset.sort = k === sortKey ? (sortDir > 0 ? "asc" : "desc") : ""; });
      if (!list.length) { var er = document.createElement("tr"); var ed = document.createElement("td"); ed.colSpan = cols.length; ed.className = "utable-empty"; ed.textContent = str(spec.empty || "No rows", 120); er.appendChild(ed); tbody.appendChild(er); return; }
      list.forEach(function (r) {
        var tr = document.createElement("tr");
        if (r.index === selected) tr.classList.add("on");
        r.cells.forEach(function (v, k) { var td = document.createElement("td"); td.textContent = typeof v === "object" ? JSON.stringify(v) : String(v); td.style.textAlign = cols[k].align; tr.appendChild(td); });
        if (selectable) tr.addEventListener("click", function () { root.__pick(r.index); });
        tbody.appendChild(tr); trs[r.index] = tr;
      });
    }
    root.__pick = function (i) {
      i = Number(i);
      if (!rows[i]) throw new Error("table has no row " + i + " (rows 0 to " + (rows.length - 1) + ")");
      if (disabled || !selectable) return;
      selected = i; spec.value = i; paint();
      root.dispatchEvent(new CustomEvent("upick", { detail: { event: "select", index: i, row: rows[i].raw } }));
    };
    root.__item = function (i) { return trs[Number(i)] || null; };
    prop(root, "value", function () { return selected; }, function (v) { selected = Number(v); spec.value = selected; paint(); });
    prop(root, "disabled", function () { return disabled; }, function (v) { disabled = !!v; });
    root.__rows = function () { return rows.length; };
    root.__selectedRow = function () { return rows[selected] ? rows[selected].raw : null; };
    paint();
    return root;
  }

  function makeList(spec) {
    var items = (Array.isArray(spec.items) ? spec.items : []).slice(0, 200).map(function (o) {
      return o && typeof o === "object" ? { value: str(o.value !== undefined ? o.value : o.label, 200), label: str(o.label !== undefined ? o.label : o.value, 200), description: o.description ? str(o.description, 200) : "", badge: o.badge !== undefined ? str(o.badge, 30) : "" } : { value: str(o, 200), label: str(o, 200), description: "", badge: "" };
    });
    if (!items.length) throw new Error("list: give it items, e.g. items: ['Overview', 'Settings']");
    var root = document.createElement("div"); root.className = "ulist"; root.setAttribute("role", "listbox");
    var current = spec.value !== undefined ? str(spec.value, 200) : null, disabled = false, els = {};
    items.forEach(function (it) {
      var row = document.createElement("div"); row.className = "ulist-item"; row.tabIndex = 0; row.setAttribute("role", "option");
      var main = document.createElement("div"); main.className = "ulist-main";
      var l = document.createElement("div"); l.className = "ulist-label"; l.textContent = it.label; main.appendChild(l);
      if (it.description) { var d = document.createElement("div"); d.className = "ulist-desc"; d.textContent = it.description; main.appendChild(d); }
      row.appendChild(main);
      if (it.badge) { var b = document.createElement("span"); b.className = "ubadge"; b.textContent = it.badge; row.appendChild(b); }
      row.addEventListener("click", function () { root.__pick(it.value); });
      row.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); root.__pick(it.value); } });
      root.appendChild(row); els[it.value] = row;
    });
    function paint() { items.forEach(function (it) { els[it.value].classList.toggle("on", it.value === current); els[it.value].setAttribute("aria-selected", String(it.value === current)); }); }
    root.__pick = function (v) {
      v = String(v);
      var it = items.filter(function (x) { return x.value === v; })[0];
      if (!it) throw new Error("list has no item '" + v + "'");
      if (disabled) return;
      current = v; spec.value = v; paint();
      root.dispatchEvent(new CustomEvent("upick", { detail: { event: "click", value: v, label: it.label } }));
    };
    root.__item = function (v) { return els[String(v)] || null; };
    prop(root, "value", function () { return current; }, function (v) { current = String(v); spec.value = current; paint(); });
    prop(root, "options", function () { return items.map(function (x) { return { value: x.value, label: x.label }; }); });
    prop(root, "disabled", function () { return disabled; }, function (v) { disabled = !!v; root.classList.toggle("disabled", disabled); });
    paint();
    return root;
  }

  // Modals and drawers cover the dash's visible area (it scrolls), under the cursors.
  function positionOverlays() {
    var any = false;
    Object.keys(comps).forEach(function (id) {
      var c = comps[id];
      if (c.type !== "modal" && c.type !== "drawer") return;
      if (c.spec.open && !c.el.hidden) any = true;
      c.el.style.top = dashArea.scrollTop + "px";
      c.el.style.height = dashArea.clientHeight + "px";
    });
    dashArea.classList.toggle("locked", any);
  }
  window.addEventListener("resize", positionOverlays);

  function toast(text, o) {
    o = o || {};
    var t = document.createElement("div");
    t.className = "utoast " + (["success", "warning", "error"].indexOf(o.variant) >= 0 ? o.variant : "");
    t.textContent = str(text, 300);
    var holder = dashArea.querySelector(".utoasts");
    if (!holder) { holder = document.createElement("div"); holder.className = "utoasts"; dashArea.appendChild(holder); }
    holder.style.top = dashArea.scrollTop + 10 + "px";
    holder.appendChild(t);
    setTimeout(function () { t.classList.add("leaving"); setTimeout(function () { t.remove(); }, 300); }, Math.max(1000, Math.min(15000, Number(o.timeout) || 4000)));
    return true;
  }

  window.__buildComponent = buildComponent;
  function buildComponent(spec) {
    var type = spec.type;
    var el = document.createElement("div");
    el.className = "uc uc-" + type;
    var input = null, body = null;
    function label(text) { if (!text) return; var l = document.createElement("div"); l.className = "uc-label"; l.textContent = str(text, 120); el.appendChild(l); }
    if (type === "heading") { el.textContent = str(spec.text, 200); }
    else if (type === "text") { el.textContent = str(spec.text, 20000); if (spec.muted) el.classList.add("muted"); }
    else if (type === "code") { var pre = document.createElement("pre"); pre.textContent = str(spec.text, 50000); el.appendChild(pre); }
    else if (type === "image") {
      var src = str(spec.src, 3000000);
      if (!/^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+\/=]+$/.test(src)) throw new Error("image: src must be a base64 data:image/... URL (tools have no network)");
      var img = document.createElement("img"); img.src = src; img.alt = str(spec.alt, 200);
      if (spec.width) img.style.width = Math.max(16, Math.min(640, Number(spec.width) || 0)) + "px";
      el.appendChild(img);
    }
    else if (type === "editor") { label(spec.label); input = document.createElement("textarea"); input.className = "ueditor"; input.spellcheck = false; input.value = str(spec.value, 200000); input.rows = Math.max(3, Math.min(30, Number(spec.rows) || 10)); input.readOnly = !!spec.readonly; el.appendChild(input); }
    else if (type === "button") {
      input = document.createElement("button"); input.type = "button"; input.className = "ubtn" + (spec.variant === "secondary" ? " secondary" : spec.variant === "danger" ? " danger" : ""); input.textContent = str(spec.label || "Button", 80); input.disabled = !!spec.disabled; el.appendChild(input);
    }
    else if (type === "input") { label(spec.label); input = document.createElement("input"); input.type = ["password", "number", "email", "search", "url"].indexOf(spec.inputType) >= 0 ? spec.inputType : "text"; input.className = "uinput"; input.placeholder = str(spec.placeholder, 200); input.value = str(spec.value, 5000); el.appendChild(input); }
    else if (type === "textarea") { label(spec.label); input = document.createElement("textarea"); input.className = "utextarea"; input.placeholder = str(spec.placeholder, 200); input.value = str(spec.value, 100000); input.rows = Math.max(2, Math.min(20, Number(spec.rows) || 4)); el.appendChild(input); }
    else if (type === "checkbox") { input = makeCheckbox(str(spec.label, 200), !!spec.checked); el.appendChild(input); }
    else if (type === "select") {
      label(spec.label);
      var opts = (Array.isArray(spec.options) ? spec.options : []).slice(0, 200).map(function (o) {
        return o && typeof o === "object" ? { value: str(o.value, 200), label: str(o.label === undefined ? o.value : o.label, 200) } : { value: str(o, 200), label: str(o, 200) };
      });
      if (!opts.length) throw new Error("select: give it options, e.g. options: ['S', 'M', 'L']");
      input = makeSelect(opts, spec.value === undefined ? undefined : str(spec.value, 200));
      el.appendChild(input);
    }
    else if (type === "slider") {
      label(spec.label);
      var min = Number(spec.min) || 0, max = spec.max === undefined ? 100 : Number(spec.max);
      if (!(max > min)) throw new Error("slider: max must be greater than min");
      input = makeSlider(min, max, Number(spec.step) > 0 ? Number(spec.step) : 1, spec.value === undefined ? min : Number(spec.value));
      el.appendChild(input);
    }
    else if (type === "toggle") { input = makeToggle(str(spec.label, 200), !!spec.checked); el.appendChild(input); }
    else if (type === "radio") {
      label(spec.label);
      var ropts = (Array.isArray(spec.options) ? spec.options : []).slice(0, 50).map(function (o) {
        return o && typeof o === "object" ? { value: str(o.value, 200), label: str(o.label === undefined ? o.value : o.label, 200) } : { value: str(o, 200), label: str(o, 200) };
      });
      if (!ropts.length) throw new Error("radio: give it options, e.g. options: ['Small', 'Large']");
      input = makeRadio(ropts, spec.value === undefined ? undefined : str(spec.value, 200), spec.direction === "row");
      el.appendChild(input);
    }
    else if (type === "progress") {
      label(spec.label);
      var pmax = Number(spec.max) > 0 ? Number(spec.max) : 100, pv = Math.max(0, Math.min(pmax, Number(spec.value) || 0));
      var bar = document.createElement("div"); bar.className = "uprog";
      var fillEl = document.createElement("div"); fillEl.className = "uprog-fill"; fillEl.style.width = (pv / pmax * 100) + "%";
      var pt = document.createElement("span"); pt.className = "uprog-text"; pt.textContent = spec.text !== undefined ? str(spec.text, 40) : Math.round(pv / pmax * 100) + "%";
      bar.appendChild(fillEl); el.appendChild(bar); el.appendChild(pt);
      bar.setAttribute("role", "progressbar"); bar.setAttribute("aria-valuemin", "0"); bar.setAttribute("aria-valuemax", String(pmax)); bar.setAttribute("aria-valuenow", String(pv));
    }
    else if (type === "status") {
      var dot = document.createElement("span"); dot.className = "dot " + (spec.state === "off" ? "off" : spec.state === "pending" ? "pending" : "on");
      var t = document.createElement("span"); t.textContent = str(spec.text, 200);
      el.appendChild(dot); el.appendChild(t);
    }
    else if (type === "divider") { }
    else if (type === "row" || type === "column") { body = el; }
    else if (type === "grid") { body = el; el.style.gridTemplateColumns = "repeat(" + Math.max(1, Math.min(6, Number(spec.columns) || 2)) + ", minmax(0, 1fr))"; }
    else if (type === "accordion") {
      var ah = document.createElement("div"); ah.className = "uacc-head"; ah.tabIndex = 0; ah.setAttribute("role", "button");
      var at = document.createElement("span"); at.className = "uc-title-text"; at.textContent = str(spec.title || "Section", 120);
      var ac = document.createElement("span"); ac.className = "usel-chev"; ac.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 4l4 4 4-4" /></svg>';
      ah.appendChild(at); ah.appendChild(ac); el.appendChild(ah);
      body = document.createElement("div"); body.className = "uc-body"; el.appendChild(body);
      if (spec.open === undefined) spec.open = true;
      el.classList.toggle("open", !!spec.open); ah.setAttribute("aria-expanded", String(!!spec.open));
      el.__toggle = function () { spec.open = !spec.open; el.classList.toggle("open", spec.open); ah.setAttribute("aria-expanded", String(spec.open)); el.dispatchEvent(new CustomEvent("uc", { detail: { event: "toggle", open: spec.open } })); };
      ah.addEventListener("click", el.__toggle);
      ah.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.__toggle(); } });
    }
    else if (type === "tabs") {
      var names = (Array.isArray(spec.tabs) ? spec.tabs : []).slice(0, 12).map(function (x) { return str(x, 60); }).filter(Boolean);
      if (!names.length) throw new Error("tabs: give it tab names, e.g. tabs: ['Overview', 'Logs']");
      if (names.indexOf(spec.value) < 0) spec.value = names[0];
      var bar = document.createElement("div"); bar.className = "utabs-bar"; bar.setAttribute("role", "tablist");
      el.appendChild(bar);
      el.__bodies = {}; el.__tabEls = {};
      names.forEach(function (n) {
        var tb = document.createElement("div"); tb.className = "utab"; tb.tabIndex = 0; tb.setAttribute("role", "tab"); tb.textContent = n;
        var panel = document.createElement("div"); panel.className = "uc-body utab-panel"; panel.dataset.tab = n; panel.setAttribute("role", "tabpanel");
        tb.addEventListener("click", function () { el.__pick(n); });
        tb.addEventListener("keydown", function (e) {
          var i = names.indexOf(spec.value);
          if (e.key === "ArrowRight") { e.preventDefault(); el.__pick(names[(i + 1) % names.length]); el.__tabEls[spec.value].focus(); }
          else if (e.key === "ArrowLeft") { e.preventDefault(); el.__pick(names[(i - 1 + names.length) % names.length]); el.__tabEls[spec.value].focus(); }
          else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.__pick(n); }
        });
        bar.appendChild(tb); el.appendChild(panel);
        el.__bodies[n] = panel; el.__tabEls[n] = tb;
      });
      el.__show = function () { names.forEach(function (n) { var on = n === spec.value; el.__tabEls[n].classList.toggle("on", on); el.__tabEls[n].setAttribute("aria-selected", String(on)); el.__bodies[n].hidden = !on; }); };
      el.__pick = function (n) { if (names.indexOf(n) < 0) throw new Error("tabs has no tab '" + n + "'"); var changed = n !== spec.value; spec.value = n; el.__show(); if (el.__comp) el.__comp.body = el.__bodies[n]; if (changed) el.dispatchEvent(new CustomEvent("uc", { detail: { event: "change", value: n } })); };
      el.__show();
      body = el.__bodies[spec.value];
    }
    else if (type === "modal" || type === "drawer") {
      if (spec.parent !== undefined && spec.parent !== null && !spec.__preview) throw new Error(type + ": add it at the top of the dash (no parent); put components inside it with parent");
      var panelEl = document.createElement("div"); panelEl.className = type === "modal" ? "umodal-panel" : "udrawer-panel " + (spec.side === "left" ? "left" : "right");
      if (type === "modal") panelEl.style.width = Math.max(240, Math.min(900, Number(spec.width) || 460)) + "px";
      else panelEl.style.width = Math.max(180, Math.min(600, Number(spec.width) || 280)) + "px";
      panelEl.setAttribute("role", "dialog");
      var mh = document.createElement("div"); mh.className = "dlg-head";
      var mt = document.createElement("span"); mt.className = "uc-title-text"; mt.textContent = str(spec.title || "", 120);
      mh.appendChild(mt);
      if (spec.closable !== false) { var mx = document.createElement("button"); mx.type = "button"; mx.className = "dlg-close"; mx.title = "Close"; mx.innerHTML = "&times;"; mx.addEventListener("click", function () { el.__close(); }); mh.appendChild(mx); }
      body = document.createElement("div"); body.className = "uc-body umodal-body";
      panelEl.appendChild(mh); panelEl.appendChild(body);
      if (spec.__preview) { el.classList.add("uc-preview"); el.appendChild(panelEl); }
      else {
        var back = document.createElement("div"); back.className = "uoverlay-back";
        back.addEventListener("click", function () { if (spec.closable !== false) el.__close(); });
        el.appendChild(back); el.appendChild(panelEl);
        el.classList.add("uc-overlay");
        if (spec.open === undefined) spec.open = true;
        el.classList.toggle("open", !!spec.open);
        el.__close = function () { if (!spec.open) return; spec.open = false; el.classList.remove("open"); positionOverlays(); el.dispatchEvent(new CustomEvent("uc", { detail: { event: "close" } })); };
      }
    }
    else if (type === "table") { input = makeTable(spec); el.appendChild(input); }
    else if (type === "list") { input = makeList(spec); el.appendChild(input); }
    else if (type === "badge") {
      var bd = document.createElement("span"); bd.className = "ubadge " + (["solid", "success", "warning", "error"].indexOf(spec.variant) >= 0 ? spec.variant : ""); bd.textContent = str(spec.text, 60); el.appendChild(bd);
    }
    else if (type === "alert") {
      el.classList.add(["success", "warning", "error"].indexOf(spec.variant) >= 0 ? spec.variant : "info");
      if (spec.title) { var alt = document.createElement("div"); alt.className = "ualert-title"; alt.textContent = str(spec.title, 120); el.appendChild(alt); }
      var alx = document.createElement("div"); alx.className = "ualert-text"; alx.textContent = str(spec.text, 2000); el.appendChild(alx);
    }
    else if (type === "stat") {
      var sl = document.createElement("div"); sl.className = "uc-label"; sl.textContent = str(spec.label, 80);
      var sv = document.createElement("div"); sv.className = "ustat-value"; sv.textContent = str(spec.value, 40);
      el.appendChild(sl); el.appendChild(sv);
      if (spec.delta !== undefined) { var sd = document.createElement("div"); sd.className = "ustat-delta " + (spec.trend === "down" ? "down" : spec.trend === "up" ? "up" : ""); sd.textContent = (spec.trend === "down" ? "\u25bc " : spec.trend === "up" ? "\u25b2 " : "") + str(spec.delta, 40); el.appendChild(sd); }
    }
    else if (type === "card") {
      if (spec.title) { var h = document.createElement("div"); h.className = "uc-title"; h.textContent = str(spec.title, 120); el.appendChild(h); }
      body = document.createElement("div"); body.className = "uc-body"; el.appendChild(body);
    }
    else throw new Error("unknown component type '" + type + "' - use " + TYPES.join(", "));
    if (spec.draggable) { if (body) throw new Error(type + ": containers cannot be draggable; put draggable components inside them"); el.dataset.draggable = "1"; }
    applyCommon(el, spec);
    return { el: el, input: input, body: body };
  }

  // Every interaction - by the person or by a client's cursor - is logged (for
  // ui.events), wakes ui.wait / ui.events callers, and runs the component's
  // handler, if it has one.
  var eventLog = [], eventSeq = 0, eventWaiters = [], handlerRuns = 0;
  var EVENTS = ["click", "change", "drop", "dblclick", "select", "toggle", "close"];
  var MAX_HANDLER_RUNS = 4;
  function notify(c, ev) {
    ev.seq = ++eventSeq;
    ev.at = new Date().toISOString();
    ev.type = c.type;
    eventLog.push(ev);
    if (eventLog.length > 200) eventLog.shift();
    c.waiters.slice().forEach(function (w) { if (!w.event || w.event === ev.event) w.resolve(ev); });
    eventWaiters.slice().forEach(function (w) { w.check(); });
    saveDash();
    runHandler(c, ev);
  }

  function handlerSpec(on) {
    if (on === undefined || on === null) return null;
    if (typeof on !== "object" || Array.isArray(on)) throw new Error("'on' must be an object like { click: { tool: 'name', args: {...} } }");
    var out = {};
    Object.keys(on).forEach(function (ev) {
      if (EVENTS.indexOf(ev) < 0) throw new Error("'on' supports " + EVENTS.join(", ") + ", not '" + ev + "'");
      var h = on[ev];
      if (typeof h === "string") h = { tool: h };
      if (!h || typeof h.tool !== "string") throw new Error("on." + ev + " needs { tool: 'name', args: {...} }");
      var t = activeTools().filter(function (x) { return x.name === h.tool; })[0];
      if (!t) throw new Error("on." + ev + ": no active tool named '" + h.tool + "'");
      var args = h.args === undefined ? {} : h.args;
      if (args === null || typeof args !== "object" || Array.isArray(args)) throw new Error("on." + ev + ".args must be an object");
      var problems = argProblems(t, args);
      if (problems.length) throw new Error("on." + ev + " -> " + t.name + ": " + problems.join("; "));
      out[ev] = { tool: t.name, args: args };
    });
    return out;
  }

  function dashNote(text, isErr) {
    var el = document.getElementById("running");
    el.textContent = text; el.style.color = isErr ? "#b91c1c" : "#666";
    clearTimeout(dashNote.t);
    dashNote.t = setTimeout(function () { el.textContent = ""; }, 8000);
  }

  function runHandler(c, ev) {
    var h = c.handlers && c.handlers[ev.event];
    if (!h) return;
    if (c.handlerBusy) { ev.handler = "skipped: the previous run of " + h.tool + " is still going"; return; }
    if (handlerRuns >= MAX_HANDLER_RUNS) { ev.handler = "skipped: too many handlers running"; return; }
    var t = activeTools().filter(function (x) { return x.name === h.tool; })[0];
    if (!t) { ev.handler = "skipped: tool " + h.tool + " is not active"; return; }
    c.handlerBusy = true; handlerRuns++;
    ev.handler = h.tool;
    var positional = (t.params || []).map(function (q) { return h.args[q.name]; });
    var detail = {}; Object.keys(ev).forEach(function (k) { if (k !== "handler") detail[k] = ev[k]; });
    runTool(t, positional, c.ownerClient, detail).then(function (r) {
      c.handlerBusy = false; handlerRuns--;
      if (!r.ok) dashNote(h.tool + " (on " + ev.event + " of " + c.id + ") failed: " + r.error, true);
    });
  }

  // Who is acting right now: a client's name while its cursor presses keys,
  // otherwise the person at the browser.
  var actor = null;
  function by() { return actor || "user"; }
  function wire(c) {
    c.el.addEventListener("dblclick", function (e) {
      if (e.target.closest("[data-cid]") !== c.el) return;
      notify(c, { event: "dblclick", id: c.id, by: by() });
    });
    if (c.el.dataset.draggable) enableDrag(c);
    c.el.__comp = c;
    c.el.addEventListener("uc", function (e) { if (e.target === c.el) notify(c, Object.assign({ id: c.id, by: by() }, e.detail)); });
    if (c.input) c.input.addEventListener("upick", function (e) { notify(c, Object.assign({ id: c.id, by: by() }, e.detail)); });
    var i = c.input;
    if (!i || c.type === "table" || c.type === "list") return;
    if (c.type === "button") i.addEventListener("click", function () { if (!c.synthetic && !c.el.__suppressClick) notify(c, { event: "click", id: c.id, by: by() }); });
    else if (c.type === "checkbox" || c.type === "toggle") i.addEventListener("change", function () { if (!c.synthetic) notify(c, { event: "change", id: c.id, checked: i.checked, by: by() }); });
    else {
      i.addEventListener("change", function () { if (!c.synthetic) notify(c, { event: "change", id: c.id, value: i.value, by: by() }); });
      if (c.type === "input") i.addEventListener("keydown", function (e) { if (e.key === "Enter") i.blur(); });
    }
  }

  // ---- drag and drop (pointer-driven: no native HTML drag) ------------------------
  function hostOf(el) { return el.parentNode; }
  function containerIdOf(host) { if (host === dashArea) return null; var p = host.closest("[data-cid]"); return p ? p.dataset.cid : null; }
  dashArea.addEventListener("scroll", function () { positionOverlays(); var h = dashArea.querySelector(".utoasts"); if (h) h.style.top = dashArea.scrollTop + 10 + "px"; });
  function childrenOf(host) { return Array.prototype.filter.call(host.children, function (x) { return x.dataset && x.dataset.cid; }); }
  function isRow(host) { return host.classList && host.classList.contains("uc-row"); }
  function moveComponent(c, host, before) {
    host.insertBefore(c.el, before || null);
    c.parentId = containerIdOf(host);
    c.spec.parent = c.parentId === null ? undefined : c.parentId;
    if (host.dataset && host.dataset.tab) c.spec.tab = host.dataset.tab; else delete c.spec.tab;
    var sibs = childrenOf(host);
    saveDash();
    return { parent: c.parentId, index: sibs.indexOf(c.el), before: before ? before.dataset.cid : null };
  }
  /** Where a drop at (x, y) would land: a host element and the child to insert before. */
  function dropTarget(c, x, y) {
    var under = document.elementFromPoint(x, y);
    if (!under || !dashArea.contains(under)) return null;
    var t = under.closest("[data-cid]");
    while (t && c.el.contains(t)) t = t.parentNode && t.parentNode.closest ? t.parentNode.closest("[data-cid]") : null;
    var host, ref = null;
    if (!t) host = dashArea;
    else {
      var tc = comps[t.dataset.cid];
      if (tc && tc.body && !c.el.contains(tc.body)) host = tc.body;
      else { host = hostOf(t); ref = t; }
    }
    var kids = childrenOf(host).filter(function (k) { return k !== c.el; });
    if (ref) {
      var r = ref.getBoundingClientRect();
      var after = isRow(host) ? x > r.left + r.width / 2 : y > r.top + r.height / 2;
      var idx = kids.indexOf(ref);
      return { host: host, before: after ? kids[idx + 1] || null : ref };
    }
    var before = null;
    for (var k = 0; k < kids.length; k++) {
      var kr = kids[k].getBoundingClientRect();
      if (isRow(host) ? x < kr.left + kr.width / 2 : y < kr.top + kr.height / 2) { before = kids[k]; break; }
    }
    return { host: host, before: before };
  }
  var dropLine = document.createElement("div"); dropLine.className = "drop-line";
  function showDropLine(t) {
    if (!t) { dropLine.remove(); return; }
    var a = dashArea.getBoundingClientRect(), hr = t.host.getBoundingClientRect();
    var kids = childrenOf(t.host).filter(function (k) { return !k.classList.contains("dragging"); });
    var row = isRow(t.host), r;
    if (t.before) r = t.before.getBoundingClientRect();
    else if (kids.length) { var last = kids[kids.length - 1].getBoundingClientRect(); r = row ? { left: last.right + 5, top: last.top, height: last.height, width: 0 } : { left: hr.left, top: last.bottom + 5, width: hr.width, height: 0 }; }
    else r = { left: hr.left + 4, top: hr.top + 4, width: Math.max(20, hr.width - 8), height: Math.max(20, hr.height - 8) };
    dashArea.appendChild(dropLine);
    var ox = -a.left + dashArea.scrollLeft, oy = -a.top + dashArea.scrollTop;
    if (row) { dropLine.style.cssText = "left:" + (r.left - 5 + ox) + "px;top:" + (r.top + oy) + "px;width:2px;height:" + (r.height || hr.height) + "px"; }
    else { dropLine.style.cssText = "left:" + ((t.before ? r.left : r.left) + ox) + "px;top:" + (r.top - 5 + oy) + "px;height:2px;width:" + (r.width || hr.width) + "px"; }
  }
  function enableDrag(c) {
    c.el.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      if (e.target.closest("input, textarea, .usel, .uslide, .ucheck, .utoggle, .uradio")) return;
      var sx = e.clientX, sy = e.clientY, dragging = false, target = null;
      function move(ev) {
        if (!dragging) {
          if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 6) return;
          dragging = true; c.el.classList.add("dragging"); document.body.classList.add("dragging-any");
        }
        ev.preventDefault();
        c.el.style.transform = "translate(" + (ev.clientX - sx) + "px, " + (ev.clientY - sy) + "px)";
        c.el.style.pointerEvents = "none";
        target = dropTarget(c, ev.clientX, ev.clientY);
        showDropLine(target);
        var a = dashArea.getBoundingClientRect();
        if (ev.clientY > a.bottom - 30) dashArea.scrollTop += 12; else if (ev.clientY < a.top + 30) dashArea.scrollTop -= 12;
      }
      function up() {
        document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); document.removeEventListener("pointercancel", up);
        if (!dragging) return;
        c.el.classList.remove("dragging"); document.body.classList.remove("dragging-any");
        c.el.style.transform = ""; c.el.style.pointerEvents = "";
        showDropLine(null);
        c.el.__suppressClick = true; setTimeout(function () { c.el.__suppressClick = false; }, 0);
        if (target && comps[c.id]) { var where = moveComponent(c, target.host, target.before); notify(c, Object.assign({ event: "drop", id: c.id, by: "user" }, where)); }
      }
      document.addEventListener("pointermove", move); document.addEventListener("pointerup", up); document.addEventListener("pointercancel", up);
    });
  }

  // ---- the dash survives Disconnect, reloads and restarts ----------------------------
  // Saved to IndexedDB (per device) shortly after any change: the components in
  // page order, each with its spec, parent, handlers, owner and current value.
  var dashRestoring = false;
  function snapshotDash() {
    var list = Array.prototype.map.call(dashArea.querySelectorAll("[data-cid]"), function (el) { return comps[el.dataset.cid]; }).filter(Boolean);
    return {
      v: 1, order: order,
      components: list.map(function (c) {
        var d = describe(c), spec = Object.assign({}, c.spec);
        delete spec.on;
        if (c.parentId) spec.parent = c.parentId; else delete spec.parent;
        if (d.value !== undefined && c.type !== "progress") spec.value = d.value;
        if (d.checked !== undefined) spec.checked = d.checked;
        return { id: c.id, spec: spec, handlers: c.handlers || null, owner: c.owner, ownerClient: c.ownerClient };
      })
    };
  }
  function saveDash() {
    if (dashRestoring) return;
    clearTimeout(saveDash.t);
    saveDash.t = setTimeout(function () {
      var snap = snapshotDash();
      idbDo("dash", "readwrite", function (st) { st.put(JSON.stringify(snap), DEVICE); }).catch(function (e) { setStatus("could not save the dash: " + e.message, true); });
    }, 250);
  }
  function restoreDash() {
    return idbDo("dash", "readonly", function (st) { return st.get(DEVICE); }).then(function (raw) {
      if (!raw) return;
      var snap = JSON.parse(raw);
      dashRestoring = true;
      try {
        (snap.components || []).forEach(function (x) {
          try {
            var built = buildComponent(x.spec);
            built.el.dataset.cid = x.id;
            var host = dashArea;
            if (x.spec.parent && comps[x.spec.parent]) { try { host = hostFor(comps[x.spec.parent], x.spec); } catch (e) { host = dashArea; } }
            host.appendChild(built.el);
            var c = { id: x.id, type: x.spec.type, el: built.el, input: built.input, body: built.body, owner: x.owner || "", ownerClient: x.ownerClient || { id: "page", name: "page" }, waiters: [], spec: x.spec, handlers: x.handlers || null, parentId: host === dashArea ? null : x.spec.parent };
            comps[x.id] = c;
            wire(c);
            if (c.type === "tabs") c.body = c.el.__bodies[c.spec.value];
          } catch (e) { /* a component that no longer builds is dropped */ }
        });
        order = Math.max(order, Number(snap.order) || 0);
      } finally { dashRestoring = false; }
      positionOverlays();
      emptyHint();
    }).catch(function () {});
  }

  /** Where a child of component p goes: its body, or for tabs the named tab's panel. */
  function hostFor(p, spec) {
    if (!p.body) throw new Error("parent '" + p.id + "' is a " + p.type + "; only " + Object.keys(CONTAINERS).join(", ") + " hold components");
    if (p.type === "tabs") {
      var tab = spec.tab !== undefined ? String(spec.tab) : p.spec.value;
      if (!p.el.__bodies[tab]) throw new Error("tabs '" + p.id + "' has no tab '" + tab + "' (tabs: " + Object.keys(p.el.__bodies).join(", ") + ")");
      spec.tab = tab;
      return p.el.__bodies[tab];
    }
    return p.body;
  }

  function addComponent(call, spec) {
    if (!spec || typeof spec !== "object") throw new Error("ui.add needs a component, e.g. { type: 'button', label: 'Run' }");
    if (Object.keys(comps).length >= MAX_COMPONENTS) throw new Error("the dash holds at most " + MAX_COMPONENTS + " components");
    var built = buildComponent(spec);
    var id = "c" + (++order);
    var handlers = handlerSpec(spec.on);
    var c = { id: id, type: spec.type, el: built.el, input: built.input, body: built.body, owner: call ? call.client.id : "", ownerClient: call ? call.client : { id: "page", name: "page" }, waiters: [], spec: spec, handlers: handlers, parentId: spec.parent !== undefined && spec.parent !== null ? String(spec.parent) : null };
    built.el.dataset.cid = id;
    var host = dashArea;
    if (spec.parent !== undefined && spec.parent !== null) host = hostFor(compOf(String(spec.parent)), spec);
    host.appendChild(built.el);
    if (c.type !== "modal" && c.type !== "drawer") reveal(built.el);
    comps[id] = c;
    wire(c);
    positionOverlays();
    emptyHint();
    saveDash();
    return id;
  }

  function removeComponent(id) {
    var c = comps[id];
    if (!c) return;
    c.el.querySelectorAll("[data-cid]").forEach(function (child) { delete comps[child.dataset.cid]; });
    c.waiters.slice().forEach(function (w) { w.cancel("the component was removed"); });
    if (openSelect && c.el.contains(openSelect)) openSelect.__close();
    c.el.remove();
    delete comps[id];
    emptyHint();
    saveDash();
  }

  function clearCursors() {
    Object.keys(cursors).forEach(function (k) { cursors[k].el.remove(); });
    cursors = {};
  }


  function describe(c) {
    var d = { id: c.id, type: c.type };
    if (c.spec.label !== undefined) d.label = str(c.spec.label, 200);
    if (c.spec.text !== undefined) d.text = str(c.spec.text, 2000);
    if (c.spec.title !== undefined) d.title = str(c.spec.title, 120);
    if (c.type === "checkbox") d.checked = c.input.checked;
    else if (c.input && "value" in c.input && c.type !== "button" && c.type !== "toggle" && c.type !== "table") d.value = c.input.value;
    if (c.type === "progress") d.value = Number(c.spec.value) || 0;
    if (c.input && c.input.disabled) d.disabled = true;
    if (c.type === "modal" || c.type === "drawer" || c.type === "accordion") d.open = !!c.spec.open;
    if (c.type === "tabs") { d.value = c.spec.value; d.tabs = Object.keys(c.el.__bodies); }
    if (c.type === "table") { d.value = c.input.value; d.rows = c.input.__rows(); if (c.input.value >= 0) d.selected = c.input.__selectedRow(); }
    if (c.type === "stat") d.value = str(c.spec.value, 40);
    if (c.spec.tab !== undefined) d.tab = c.spec.tab;
    if (c.el.hidden) d.hidden = true;
    if (c.handlers) d.on = c.handlers;
    if (c.parentId) d.parent = c.parentId;
    if (c.el.dataset.draggable) d.draggable = true;
    if (c.type === "toggle") d.checked = c.input.checked;
    return d;
  }

  function update(c, props) {
    if (!props || typeof props !== "object") throw new Error("ui.update needs an object of properties");
    if (CONTAINERS[c.type]) {
      if (props.title !== undefined) {
        c.spec.title = props.title;
        var t = c.type === "card" ? c.el.querySelector(":scope > .uc-title") : c.el.querySelector(".uc-title-text");
        if (t) t.textContent = str(props.title, 120);
      }
      if (props.open !== undefined && (c.type === "modal" || c.type === "drawer" || c.type === "accordion")) {
        var want = !!props.open;
        if (c.type === "accordion") { if (want !== !!c.spec.open) c.el.__toggle(); }
        else { c.spec.open = want; c.el.classList.toggle("open", want); }
      }
      if (props.value !== undefined && c.type === "tabs") { c.el.__pick(String(props.value)); c.body = c.el.__bodies[c.spec.value]; }
      if (props.columns !== undefined && c.type === "grid") { c.spec.columns = props.columns; c.el.style.gridTemplateColumns = "repeat(" + Math.max(1, Math.min(6, Number(props.columns) || 2)) + ", minmax(0, 1fr))"; }
      ["hidden", "width", "grow"].forEach(function (k) { if (props[k] !== undefined) c.spec[k] = props[k]; });
      applyCommon(c.el, c.spec);
      positionOverlays();
      saveDash();
      return describe(c);
    }
    if (props.on !== undefined) c.handlers = handlerSpec(props.on);
    var spec = Object.assign({}, c.spec, props, { type: c.type, parent: c.spec.parent });
    if (c.input && props.value === undefined && c.type !== "button" && c.type !== "checkbox" && !(c.type === "table" && props.rows !== undefined)) spec.value = c.input.value;
    if ((c.type === "checkbox" || c.type === "toggle") && props.checked === undefined) spec.checked = c.input.checked;
    if (c.type === "progress" || c.type === "heading" || c.type === "text") { /* plain props */ }
    var built = buildComponent(spec);
    built.el.dataset.cid = c.id;
    c.el.replaceWith(built.el);
    c.el = built.el; c.input = built.input; c.spec = spec;
    wire(c);
    saveDash();
    return describe(c);
  }

  // ---- cursors ------------------------------------------------------------------
  // MCP clients speak stateless HTTP: nothing says "I am gone". So a cursor
  // fades away after a while with no activity (waiting does not count) and
  // comes back, from where it was, with the client's next action.
  var CURSOR_IDLE_MS = 10000;
  var lastSpot = {};
  function touch(cur) { cur.lastActive = Date.now(); }
  setInterval(function () {
    var now = Date.now();
    Object.keys(cursors).forEach(function (k) {
      var cur = cursors[k];
      if (cur.el.classList.contains("busy") || now - (cur.lastActive || 0) < CURSOR_IDLE_MS) return;
      lastSpot[k] = { x: cur.x, y: cur.y };
      delete cursors[k];
      cur.el.classList.add("leaving");
      setTimeout(function () { cur.el.remove(); }, 500);
    });
  }, 1000);
  function cursorFor(client) {
    var cur = cursors[client.id];
    if (cur) { touch(cur); return cur; }
    // The first colour no cursor on the dash is using: clients stay apart.
    var used = Object.keys(cursors).map(function (k) { return cursors[k].color; });
    var color = PALETTE.filter(function (c) { return used.indexOf(c) < 0; })[0] || PALETTE[used.length % PALETTE.length];
    var el = document.createElement("div");
    el.className = "cur";
    el.innerHTML = '<svg viewBox="0 0 16 20" aria-hidden="true"><path d="M1 1 L1 16 L5 12 L8 19 L11 17.6 L8 11 L14 11 Z" /></svg><span class="cur-name"><span class="cur-label"></span><span class="cur-spin" aria-label="working"></span></span>';
    el.querySelector(".cur-label").textContent = client.name;
    el.querySelector(".cur-name").style.background = color;
    el.style.setProperty("--cur", color);
    dashArea.appendChild(el);
    var spot = lastSpot[client.id] || { x: 12, y: 12 };
    cur = { el: el, x: spot.x, y: spot.y, client: client, color: color, busy: 0, lastActive: Date.now() };
    el.style.transform = "translate(" + Math.round(spot.x) + "px, " + Math.round(spot.y) + "px)";
    cursors[client.id] = cur;
    return cur;
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ---- expand the dash to the whole page (not the screen) and back ----------------
  var sizeBtn = document.getElementById("dashSize");
  var ICON_EXPAND = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" /></svg>', ICON_COLLAPSE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2v4H2M14 6h-4V2M10 14v-4h4M2 10h4v4" /></svg>';
  function setFull(on) {
    dashSection.classList.toggle("full", on);
    document.body.classList.toggle("dash-full", on);
    sizeBtn.innerHTML = on ? ICON_COLLAPSE : ICON_EXPAND;
    sizeBtn.title = on ? "Collapse" : "Expand";
    sizeBtn.setAttribute("aria-label", sizeBtn.title);
    if (openSelect) openSelect.__close();
  }
  sizeBtn.addEventListener("click", function () { setFull(!dashSection.classList.contains("full")); });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || document.querySelector(".overlay") || openSelect) return;
    var open = Object.keys(comps).map(function (k) { return comps[k]; }).filter(function (c) { return (c.type === "modal" || c.type === "drawer") && c.spec.open && c.spec.closable !== false && c.el.__close; });
    if (open.length) { e.stopImmediatePropagation(); open[open.length - 1].el.__close(); }
  }, true);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && dashSection.classList.contains("full") && !document.querySelector(".overlay") && !openSelect) setFull(false);
  });
  setFull(false);

  // The person's own pointer, drawn like the clients' and labelled "you".
  var me = document.createElement("div");
  me.className = "cur me";
  me.innerHTML = '<svg viewBox="0 0 16 20" aria-hidden="true"><path d="M1 1 L1 16 L5 12 L8 19 L11 17.6 L8 11 L14 11 Z" /></svg><span class="cur-name"><span class="cur-label">you</span></span>';
  me.hidden = true;
  var lastPointer = null;
  function showMe(e) {
    lastPointer = { clientX: e.clientX, clientY: e.clientY };
    var a = dashArea.getBoundingClientRect();
    if (me.parentNode !== dashArea) dashArea.appendChild(me);
    me.hidden = false;
    dashArea.classList.add("mine");
    me.style.transform = "translate(" + Math.round(e.clientX - a.left + dashArea.scrollLeft) + "px, " + Math.round(e.clientY - a.top + dashArea.scrollTop) + "px)";
  }
  dashArea.addEventListener("input", function (e) { if (e.target.closest && e.target.closest("[data-cid]")) saveDash(); });
  dashArea.addEventListener("pointermove", showMe);
  dashArea.addEventListener("pointerenter", showMe);
  dashArea.addEventListener("pointerdown", function (e) { me.classList.remove("click"); void me.offsetWidth; me.classList.add("click"); showMe(e); });
  dashArea.addEventListener("pointerleave", function () { me.hidden = true; lastPointer = null; dashArea.classList.remove("mine"); });
  // The dash can scroll under a still pointer (a tool revealing a component):
  // keep the drawn pointer where the real one is.
  dashArea.addEventListener("scroll", function () { if (lastPointer && !me.hidden) showMe(lastPointer); });
  // Keep what a tool works on in view: inside the dash's own scroll area only.
  function reveal(el) {
    var a = dashArea.getBoundingClientRect(), r = el.getBoundingClientRect();
    if (r.bottom > a.bottom) dashArea.scrollTop += r.bottom - a.bottom + 16;
    else if (r.top < a.top) dashArea.scrollTop -= a.top - r.top + 16;
  }
  function pointIn(c, fx, fy) {
    reveal(c.el);
    var a = dashArea.getBoundingClientRect(), r = (c.input || c.el).getBoundingClientRect();
    return { x: r.left - a.left + dashArea.scrollLeft + r.width * (fx === undefined ? 0.5 : fx), y: r.top - a.top + dashArea.scrollTop + r.height * (fy === undefined ? 0.5 : fy) };
  }
  // A cursor glides like a hand would: along a slight arc, easing in and out,
  // taking longer for longer distances. A newer move supersedes an older one.
  // In a hidden tab (no animation frames) it jumps, so tools never stall.
  function place(cur, x, y) { cur.x = x; cur.y = y; cur.el.style.transform = "translate(" + Math.round(x) + "px, " + Math.round(y) + "px)"; }
  function moveTo(cur, p, ms) {
    touch(cur);
    var x0 = cur.x, y0 = cur.y, x1 = p.x, y1 = p.y;
    var dist = Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0));
    var token = (cur.token || 0) + 1; cur.token = token;
    cur.el.style.transition = "none";
    if (dist < 2 || document.hidden) { place(cur, x1, y1); return sleep(document.hidden ? 0 : 60); }
    var dur = Math.max(260, Math.min(1000, (ms || 420) * (0.55 + dist / 700)));
    cur.bend = -(cur.bend || 1);
    var bend = Math.min(70, dist * 0.18) * cur.bend;
    var cx = (x0 + x1) / 2 - (y1 - y0) / dist * bend, cy = (y0 + y1) / 2 + (x1 - x0) / dist * bend;
    return new Promise(function (resolve) {
      var t0 = null, done = false;
      function finish() { if (done) return; done = true; if (cur.token === token) place(cur, x1, y1); resolve(); }
      function step(now) {
        if (done || cur.token !== token) { finish(); return; }
        if (t0 === null) t0 = now;
        var t = Math.min(1, (now - t0) / dur);
        var e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        var u = 1 - e;
        place(cur, u * u * x0 + 2 * u * e * cx + e * e * x1, u * u * y0 + 2 * u * e * cy + e * e * y1);
        if (t < 1) requestAnimationFrame(step); else finish();
      }
      requestAnimationFrame(step);
      setTimeout(finish, dur + 400);
    });
  }
  /** Glide a client's cursor to a component it just added or changed (no waiting). */
  function glide(call, c) {
    if (!call || !call.client || conn.state === "idle" || !comps[c.id]) return;
    try { moveTo(cursorFor(call.client), pointIn(c, 0.12, 0.5)); } catch (e) {}
  }
  function pulse(cur) {
    cur.el.classList.remove("click"); void cur.el.offsetWidth; cur.el.classList.add("click");
    return sleep(160);
  }
  function needInput(c, kinds) {
    if (kinds.indexOf(c.type) < 0) throw new Error("component '" + c.id + "' is a " + c.type + "; this works on " + kinds.join(", "));
    if (c.input.disabled) throw new Error("component '" + c.id + "' is disabled");
  }
  function setValue(c, value, by) {
    c.synthetic = true;
    c.input.value = value;
    c.input.dispatchEvent(new Event("input", { bubbles: true }));
    c.synthetic = false;
    notify(c, { event: "change", id: c.id, value: c.input.value, by: by });
  }

  var TEXTUAL = ["input", "textarea", "editor"];
  var API = {
    "ui.add": function (call, a) { var id = addComponent(call, a[0]); glide(call, comps[id]); return id; },
    "ui.update": function (call, a) { var c = compOf(String(a[0])); var r = update(c, a[1]); glide(call, c); return r; },
    "ui.get": function (call, a) { return describe(compOf(String(a[0]))); },
    "ui.remove": function (call, a) {
      var c = compOf(String(a[0])), cur = cursorFor(call.client);
      return moveTo(cur, pointIn(c, 0.12, 0.5), 300).then(function () { removeComponent(String(a[0])); return true; });
    },
    "ui.clear": function (call) {
      var n = 0;
      Object.keys(comps).forEach(function (id) { if (comps[id] && comps[id].owner === call.client.id) { removeComponent(id); n++; } });
      return n;
    },
    // In page order (after drags), each with its parent.
    "ui.toast": function (call, a) { return toast(a[0], a[1]); },
    "ui.list": function () { return Array.prototype.map.call(dashArea.querySelectorAll("[data-cid]"), function (el) { return comps[el.dataset.cid]; }).filter(Boolean).map(describe); },
    "ui.wait": function (call, a) {
      var c = compOf(String(a[0])), o = a[1] || {};
      var ms = Math.max(100, Math.min(CALL_TIMEOUT_MS - 5000, Number(o.timeout) || 60000));
      return new Promise(function (resolve, reject) {
        var w = { event: EVENTS.indexOf(o.event) >= 0 ? o.event : null };
        var timer = setTimeout(function () { done(); resolve({ event: "timeout", id: c.id }); }, ms);
        call.waitingFor++; updateRunning();
        function done() { clearTimeout(timer); if (w.finished) return; w.finished = true; call.waitingFor--; updateRunning(); c.waiters = c.waiters.filter(function (x) { return x !== w; }); call.waiters = call.waiters.filter(function (x) { return x !== w; }); }
        w.resolve = function (ev) { done(); resolve(ev); };
        w.cancel = function (why) { done(); reject(new Error(why)); };
        c.waiters.push(w); call.waiters.push(w);
      });
    },
    "ui.events": function (call, a) {
      var o = a[0] || {}, since = Number(o.since) || 0;
      var ids = Array.isArray(o.ids) ? o.ids.map(String) : o.id !== undefined ? [String(o.id)] : null;
      function pick() { return eventLog.filter(function (e) { return e.seq > since && (!ids || ids.indexOf(e.id) >= 0); }); }
      function result(list) { return { events: list, next: list.length ? list[list.length - 1].seq : Math.max(since, 0), latest: eventSeq }; }
      var now = pick();
      var ms = Math.max(0, Math.min(CALL_TIMEOUT_MS - 5000, (Number(o.timeout) || 0)));
      if (now.length || !ms) return result(now);
      return new Promise(function (resolve, reject) {
        var w = {};
        var timer = setTimeout(function () { done(); resolve(result([])); }, ms);
        call.waitingFor++; updateRunning();
        function done() { clearTimeout(timer); if (w.finished) return; w.finished = true; call.waitingFor--; updateRunning(); eventWaiters = eventWaiters.filter(function (x) { return x !== w; }); call.waiters = call.waiters.filter(function (x) { return x !== w; }); }
        w.check = function () { var l = pick(); if (l.length) { done(); resolve(result(l)); } };
        w.cancel = function (why) { done(); reject(new Error(why)); };
        eventWaiters.push(w); call.waiters.push(w);
      });
    },
    "cursor.move": function (call, a) { var c = compOf(String(a[0])); return moveTo(cursorFor(call.client), pointIn(c)).then(function () { return true; }); },
    "cursor.click": function (call, a) {
      var c = compOf(String(a[0])), cur = cursorFor(call.client);
      return moveTo(cur, pointIn(c)).then(function () { return pulse(cur); }).then(function () {
        if (c.input && c.input.disabled) throw new Error("component '" + c.id + "' is disabled");
        if (c.type === "accordion") { actor = call.client.name; try { c.el.__toggle(); } finally { actor = null; } return describe(c); }
        if ((c.type === "modal" || c.type === "drawer") && c.el.__close) { actor = call.client.name; try { c.el.__close(); } finally { actor = null; } return describe(c); }
        if (c.type === "button") { c.input.classList.add("pressed"); setTimeout(function () { c.input.classList.remove("pressed"); }, 180); notify(c, { event: "click", id: c.id, by: call.client.name }); }
        else if (c.type === "checkbox" || c.type === "toggle") { c.input.checked = !c.input.checked; notify(c, { event: "change", id: c.id, checked: c.input.checked, by: call.client.name }); }
        else if (c.input && c.input.focus) c.input.focus();
        return describe(c);
      });
    },
    "cursor.type": function (call, a) {
      var c = compOf(String(a[0])), text = str(a[1], 5000), cur = cursorFor(call.client);
      needInput(c, TEXTUAL);
      if (c.input.readOnly) throw new Error("component '" + c.id + "' is read-only");
      var stepMs = text.length > 400 ? 2 : text.length > 100 ? 10 : 35;
      return moveTo(cur, pointIn(c, 0.15)).then(function () { return pulse(cur); }).then(function () {
        c.input.focus();
        var i = 0;
        return new Promise(function (resolve) {
          (function next() {
            if (i >= text.length || !comps[c.id]) { resolve(); return; }
            var chunk = stepMs < 5 ? text.slice(i, i + 8) : text[i];
            i += chunk.length;
            c.input.value += chunk;
            c.input.dispatchEvent(new Event("input", { bubbles: true }));
            setTimeout(next, stepMs);
          })();
        });
      }).then(function () { notify(c, { event: "change", id: c.id, value: c.input.value, by: call.client.name }); return describe(c); });
    },
    "cursor.fill": function (call, a) {
      var c = compOf(String(a[0])), cur = cursorFor(call.client);
      needInput(c, TEXTUAL);
      if (c.input.readOnly) throw new Error("component '" + c.id + "' is read-only");
      return moveTo(cur, pointIn(c, 0.15)).then(function () { return pulse(cur); }).then(function () { setValue(c, str(a[1], 200000), call.client.name); return describe(c); });
    },
    "cursor.check": function (call, a) {
      var c = compOf(String(a[0])), cur = cursorFor(call.client);
      needInput(c, ["checkbox", "toggle"]);
      return moveTo(cur, pointIn(c)).then(function () { return pulse(cur); }).then(function () {
        if (c.input.checked !== !!a[1]) { c.input.checked = !!a[1]; notify(c, { event: "change", id: c.id, checked: c.input.checked, by: call.client.name }); }
        return describe(c);
      });
    },
    "cursor.select": function (call, a) {
      var c = compOf(String(a[0])), cur = cursorFor(call.client), v = str(a[1], 200);
      if (c.type === "table" || c.type === "list" || c.type === "tabs") {
        var itemEl = c.type === "tabs" ? c.el.__tabEls[v] : c.input.__item(c.type === "table" ? Number(v) : v);
        if (!itemEl) throw new Error(c.type + " '" + c.id + "' has no " + (c.type === "table" ? "row " : c.type === "tabs" ? "tab '" : "item '") + v + (c.type === "table" ? "" : "'"));
        reveal(itemEl.closest("[data-cid]") || c.el);
        var a1 = dashArea.getBoundingClientRect(), ri = itemEl.getBoundingClientRect();
        return moveTo(cur, { x: ri.left - a1.left + dashArea.scrollLeft + Math.min(30, ri.width / 2), y: ri.top - a1.top + dashArea.scrollTop + ri.height / 2 }).then(function () { return pulse(cur); }).then(function () {
          actor = call.client.name;
          try { if (c.type === "tabs") c.el.__pick(v); else c.input.__pick(c.type === "table" ? Number(v) : v); } finally { actor = null; }
          return describe(c);
        });
      }
      needInput(c, ["select", "radio"]);
      if (!c.input.options.some(function (o) { return o.value === v; })) throw new Error(c.type + " '" + c.id + "' has no option '" + v + "'");
      if (c.type === "radio") {
        var opt = c.input.__item(v), a0 = dashArea.getBoundingClientRect();
        reveal(c.el);
        var ro = opt.getBoundingClientRect();
        return moveTo(cur, { x: ro.left - a0.left + dashArea.scrollLeft + 6, y: ro.top - a0.top + dashArea.scrollTop + ro.height / 2 }).then(function () { return pulse(cur); }).then(function () {
          if (c.input.value !== v) { c.synthetic = true; c.input.value = v; c.synthetic = false; notify(c, { event: "change", id: c.id, value: v, by: call.client.name }); }
          return describe(c);
        });
      }
      return moveTo(cur, pointIn(c)).then(function () { return pulse(cur); }).then(function () {
        c.input.__open();
        var item = c.input.__item(v), a = dashArea.getBoundingClientRect(), r = item.getBoundingClientRect();
        return moveTo(cur, { x: r.left - a.left + dashArea.scrollLeft + Math.min(24, r.width / 2), y: r.top - a.top + dashArea.scrollTop + r.height / 2 }, 300);
      }).then(function () { return pulse(cur); }).then(function () {
        c.input.__close();
        if (c.input.value !== v) { c.synthetic = true; c.input.value = v; c.synthetic = false; notify(c, { event: "change", id: c.id, value: v, by: call.client.name }); }
        return describe(c);
      });
    },
    "cursor.drag": function (call, a) {
      var c = compOf(String(a[0])), cur = cursorFor(call.client), target = a[1];
      if (c.type === "slider") {
        if (typeof target !== "number") throw new Error("dragging a slider needs a number to drag it to");
        needInput(c, ["slider"]);
        var min = Number(c.input.min), max = Number(c.input.max), v = Math.max(min, Math.min(max, target));
        var from = (Number(c.input.value) - min) / ((max - min) || 1), to = (v - min) / ((max - min) || 1);
        return moveTo(cur, pointIn(c, from)).then(function () { cur.el.classList.add("grab"); return moveTo(cur, pointIn(c, to), 600); })
          .then(function () { cur.el.classList.remove("grab"); setValue(c, String(v), call.client.name); return describe(c); });
      }
      // target: a component id (drop before it - or into it, for a row or card),
      // or { before | after | into: id }.
      var spec2 = typeof target === "string" ? { to: target } : target && typeof target === "object" ? target : null;
      if (!spec2) throw new Error("cursor.drag needs a target: a component id, { before | after | into: id }, or a number for a slider");
      var tid = String(spec2.to || spec2.before || spec2.after || spec2.into);
      var t = compOf(tid);
      if (t === c || c.el.contains(t.el)) throw new Error("cannot drag a component onto itself or into itself");
      var host, before;
      if ((spec2.to && t.body) || spec2.into) { if (!t.body) throw new Error("'" + tid + "' is a " + t.type + "; only rows and cards take components"); host = t.body; before = null; }
      else if (spec2.after) { host = t.el.parentNode; before = t.el.nextSibling; while (before && before === c.el) before = before.nextSibling; }
      else { host = t.el.parentNode; before = t.el; }
      return moveTo(cur, pointIn(c)).then(function () { cur.el.classList.add("grab"); c.el.classList.add("dragging"); return moveTo(cur, pointIn(t, 0.5, before === t.el ? 0.05 : 0.9), 650); })
        .then(function () {
          cur.el.classList.remove("grab"); c.el.classList.remove("dragging");
          var where = moveComponent(c, host, before);
          notify(c, Object.assign({ event: "drop", id: c.id, by: call.client.name }, where));
          return Object.assign({ moved: c.id }, where);
        });
    },
    "cursor.hover": function (call, a) {
      var c = compOf(String(a[0])), cur = cursorFor(call.client);
      return moveTo(cur, pointIn(c)).then(function () { c.el.classList.add("hovered"); setTimeout(function () { c.el.classList.remove("hovered"); }, 900); return describe(c); });
    },
    "cursor.dblclick": function (call, a) {
      var c = compOf(String(a[0])), cur = cursorFor(call.client);
      return moveTo(cur, pointIn(c)).then(function () { return pulse(cur); }).then(function () { return pulse(cur); }).then(function () { notify(c, { event: "dblclick", id: c.id, by: call.client.name }); return describe(c); });
    },
    "cursor.scroll": function (call, a) {
      var c = compOf(String(a[0])), cur = cursorFor(call.client);
      return moveTo(cur, pointIn(c), 500).then(function () { return describe(c); });
    },
    "cursor.press": function (call, a) {
      var c = compOf(String(a[0])), key = str(a[1], 20), cur = cursorFor(call.client);
      var target = c.input || c.el;
      return moveTo(cur, pointIn(c, 0.15)).then(function () { return pulse(cur); }).then(function () {
        if (target.disabled) throw new Error("component '" + c.id + "' is disabled");
        if (TEXTUAL.indexOf(c.type) >= 0) {
          if (c.input.readOnly) throw new Error("component '" + c.id + "' is read-only");
          c.input.focus();
          if (key === "Enter" && c.type === "input") { notify(c, { event: "change", id: c.id, value: c.input.value, by: call.client.name }); }
          else if (key === "Enter") setValue(c, c.input.value + "\n", call.client.name);
          else if (key === "Backspace") setValue(c, c.input.value.slice(0, -1), call.client.name);
          else if (key.length === 1) setValue(c, c.input.value + key, call.client.name);
          else throw new Error("text boxes take Enter, Backspace or a single character");
          return describe(c);
        }
        actor = call.client.name;
        try {
          if (target.focus) target.focus();
          if (c.type === "button" && (key === "Enter" || key === " ")) { notify(c, { event: "click", id: c.id, by: call.client.name }); }
          else target.dispatchEvent(new KeyboardEvent("keydown", { key: key, bubbles: true, cancelable: true }));
        } finally { actor = null; }
        return describe(c);
      });
    }
  };

  // ===========================================================================
  // Data: kv and db for tools, kept in this browser's IndexedDB, per device.
  // Tools are sandboxed (no storage of their own); the page holds it for them.
  // ===========================================================================
  var KV_MAX_VALUE = 1048576, KV_MAX_KEYS = 10000, DB_MAX_BYTES = 52428800, ROWS_MAX = 10000;
  var idbPromise = null;
  function idb() {
    if (!idbPromise) idbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open("code-mcp-sandbox", 2);
      req.onupgradeneeded = function () {
        var d = req.result;
        ["kv", "db", "dash"].forEach(function (n) { if (!d.objectStoreNames.contains(n)) d.createObjectStore(n); });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { idbPromise = null; reject(new Error("browser storage unavailable: " + (req.error && req.error.message))); };
    });
    return idbPromise;
  }
  function idbDo(store, mode, fn) {
    return idb().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(store, mode), st = tx.objectStore(store), out;
        var r = fn(st); if (r) r.onsuccess = function () { out = r.result; };
        tx.oncomplete = function () { resolve(out); };
        tx.onerror = tx.onabort = function () { reject(new Error("browser storage: " + (tx.error && tx.error.message || "failed"))); };
      });
    });
  }
  var KV_PREFIX = DEVICE + "\u0000";
  function kvRange(prefix) { return IDBKeyRange.bound(KV_PREFIX + prefix, KV_PREFIX + prefix + "\uffff"); }
  function kvKey(key) {
    if (typeof key !== "string" || !key.length || key.length > 256) throw new Error("kv: a key is a string of 1 to 256 characters");
    return KV_PREFIX + key;
  }

  var sqlReady = null, sqlDb = null;
  function loadSql() {
    if (!sqlReady) sqlReady = new Promise(function (resolve, reject) {
      var sc = document.createElement("script");
      sc.src = "/mcp?asset=sql-wasm.js";
      sc.onload = function () {
        window.initSqlJs({ locateFile: function () { return "/mcp?asset=sql-wasm.wasm"; } }).then(function (SQL) {
          return idbDo("db", "readonly", function (st) { return st.get(DEVICE); }).then(function (bytes) {
            sqlDb = bytes ? new SQL.Database(new Uint8Array(bytes)) : new SQL.Database();
            resolve(sqlDb);
          });
        }).catch(function (err) { sqlReady = null; reject(new Error("could not start SQLite: " + (err && err.message || err))); });
      };
      sc.onerror = function () { sqlReady = null; reject(new Error("could not load SQLite")); };
      document.head.appendChild(sc);
    });
    return sqlReady;
  }
  function saveDb() {
    var bytes = sqlDb.export();
    if (bytes.length > DB_MAX_BYTES) throw new Error("db: the database would exceed " + DB_MAX_BYTES / 1048576 + " MB; the change was not saved");
    return idbDo("db", "readwrite", function (st) { st.put(bytes.buffer, DEVICE); });
  }
  function sqlParams(p) {
    if (p === null || p === undefined) return undefined;
    if (Array.isArray(p) || (typeof p === "object")) return p;
    throw new Error("db: params must be an array (for ?) or an object (for :name)");
  }
  var dbChain = Promise.resolve();
  function serial(fn) { var r = dbChain.then(fn); dbChain = r.catch(function () {}); return r; }

  function dataApi() {
    return {
      "kv.get": function (call, a) { var k = kvKey(a[0]); return idbDo("kv", "readonly", function (st) { return st.get(k); }).then(function (v) { return v === undefined ? null : JSON.parse(v); }); },
      "kv.set": function (call, a) {
        var k = kvKey(a[0]), json = JSON.stringify(a[1] === undefined ? null : a[1]);
        if (json.length > KV_MAX_VALUE) throw new Error("kv: a value is at most 1 MB as JSON");
        return idbDo("kv", "readonly", function (st) { return st.count(kvRange("")); }).then(function (n) {
          return idbDo("kv", "readonly", function (st) { return st.get(k); }).then(function (old) {
            if (old === undefined && n >= KV_MAX_KEYS) throw new Error("kv: at most " + KV_MAX_KEYS + " keys");
            return idbDo("kv", "readwrite", function (st) { st.put(json, k); });
          });
        }).then(function () { refreshData(); return true; });
      },
      "kv.delete": function (call, a) {
        var k = kvKey(a[0]);
        return idbDo("kv", "readonly", function (st) { return st.get(k); }).then(function (old) {
          if (old === undefined) return false;
          return idbDo("kv", "readwrite", function (st) { st.delete(k); }).then(function () { refreshData(); return true; });
        });
      },
      "kv.list": function (call, a) {
        var prefix = typeof a[0] === "string" ? a[0] : "";
        return idbDo("kv", "readonly", function (st) { return st.getAllKeys(kvRange(prefix), 1000); }).then(function (keys) { return (keys || []).map(function (k) { return String(k).slice(KV_PREFIX.length); }); });
      },
      "db.query": function (call, a) {
        return serial(function () {
          return loadSql().then(function (d) {
            var stmt = d.prepare(String(a[0])), rows = [];
            try {
              var p = sqlParams(a[1]); if (p !== undefined) stmt.bind(p);
              while (stmt.step()) { if (rows.length >= ROWS_MAX) throw new Error("db.query: more than " + ROWS_MAX + " rows - add a LIMIT"); rows.push(stmt.getAsObject()); }
            } finally { stmt.free(); }
            var changed = d.getRowsModified() > 0 && !/^\s*(select|with|pragma|explain)\b/i.test(String(a[0]));
            return (changed ? saveDb() : Promise.resolve()).then(function () { if (changed) refreshData(); return rows; });
          });
        });
      },
      "db.execute": function (call, a) {
        return serial(function () {
          return loadSql().then(function (d) {
            var p = sqlParams(a[1]);
            if (p === undefined) d.exec(String(a[0])); else d.run(String(a[0]), p);
            var changes = d.getRowsModified();
            var last = d.exec("SELECT last_insert_rowid() AS id");
            var lastId = last.length ? last[0].values[0][0] : 0;
            return saveDb().then(function () { refreshData(); return { changes: changes, lastInsertRowid: lastId }; });
          });
        });
      }
    };
  }

  // The "Data" line: what tools have stored, and a way to clear it.
  function refreshData() {
    clearTimeout(refreshData.t);
    refreshData.t = setTimeout(function () {
      Promise.all([
        idbDo("kv", "readonly", function (st) { return st.count(kvRange("")); }),
        idbDo("db", "readonly", function (st) { return st.get(DEVICE); })
      ]).then(function (r) {
        var keys = r[0] || 0, bytes = r[1] ? r[1].byteLength : 0;
        var tables = 0;
        if (sqlDb) { try { var t = sqlDb.exec("SELECT count(*) FROM sqlite_master WHERE type = 'table'"); tables = t.length ? t[0].values[0][0] : 0; } catch (e) {} }
        var el = document.getElementById("data");
        el.innerHTML = "";
        if (!keys && !bytes) return;
        var label = document.createElement("span");
        label.textContent = "Data: " + keys + " key" + (keys === 1 ? "" : "s") + (bytes ? " \u00b7 SQLite " + (sqlDb ? tables + " table" + (tables === 1 ? "" : "s") + ", " : "") + fmtSize(bytes) : "") + " \u00b7 ";
        var clr = document.createElement("button"); clr.type = "button"; clr.className = "linkbtn"; clr.textContent = "Clear data";
        clr.disabled = connected;
        clr.addEventListener("click", function () {
          askConfirm("Clear data", "Delete every kv key and the SQLite database that tools stored in this browser for " + DEVICE + "?", "Clear").then(function (yes) {
            if (!yes) return;
            idbDo("kv", "readwrite", function (st) { st.delete(kvRange("")); }).then(function () {
              return idbDo("db", "readwrite", function (st) { st.delete(DEVICE); });
            }).then(function () { sqlDb = null; sqlReady = null; refreshData(); setStatus("Data cleared."); });
          });
        });
        el.appendChild(label); el.appendChild(clr);
      }).catch(function () {});
    }, 150);
  }
  function fmtSize(n) { return n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB"; }
  var DATA_API = dataApi();
  Object.keys(DATA_API).forEach(function (k) { API[k] = DATA_API[k]; });
  refreshData();
  restoreDash();

  // ---- the Components reference (same renderer as the dash) -----------------------
  var SAMPLES = [
    ["heading", { type: "heading", text: "Heading" }],
    ["text", { type: "text", text: "Plain text, wrapping as needed." }],
    ["code", { type: "code", text: "const x = 42;" }],
    ["status", { type: "status", text: "Running", state: "on" }],
    ["button", { type: "button", label: "Run" }],
    ["button (secondary)", { type: "button", label: "Cancel", variant: "secondary" }],
    ["button (danger)", { type: "button", label: "Delete", variant: "danger" }],
    ["input", { type: "input", label: "Name", placeholder: "type here" }],
    ["textarea", { type: "textarea", label: "Notes", rows: 2 }],
    ["checkbox", { type: "checkbox", label: "I agree" }],
    ["select", { type: "select", label: "Size", options: ["S", "M", "L"], value: "M" }],
    ["slider", { type: "slider", label: "Volume", min: 0, max: 10, value: 4 }],
    ["toggle", { type: "toggle", label: "Dark mode", checked: true }],
    ["radio", { type: "radio", label: "Plan", options: ["Free", "Pro", "Team"], value: "Pro", direction: "row" }],
    ["progress", { type: "progress", label: "Upload", value: 64 }],
    ["draggable", { type: "text", text: "Drag me", draggable: true }],
    ["badge", { type: "badge", text: "beta", variant: "solid" }],
    ["alert", { type: "alert", title: "Heads up", text: "Deploys are paused until 18:00.", variant: "warning" }],
    ["stat", { type: "stat", label: "Requests", value: "12.4k", delta: "8% this week", trend: "up" }],
    ["table", { type: "table", columns: [{ key: "name", label: "Name" }, { key: "status", label: "Status" }, { key: "ms", label: "ms", align: "right" }], rows: [{ name: "api", status: "ok", ms: 41 }, { name: "web", status: "slow", ms: 380 }, { name: "jobs", status: "ok", ms: 12 }] }],
    ["list", { type: "list", items: [{ label: "Overview", value: "overview", description: "Today at a glance" }, { label: "Deploys", value: "deploys", badge: "3" }, "Settings"], value: "overview" }],
    ["tabs", { type: "tabs", tabs: ["Overview", "Logs"] }],
    ["accordion", { type: "accordion", title: "Advanced", open: true }],
    ["grid", { type: "grid", columns: 3 }],
    ["modal", { type: "modal", title: "Modal", __preview: true }],
    ["drawer", { type: "drawer", title: "Drawer (sidebar)", side: "right", __preview: true }],
    ["editor", { type: "editor", label: "Editor", value: "function hi() {\n  return 'hi';\n}", rows: 3 }],
    ["card", { type: "card", title: "Card" }],
    ["toast", null]
  ];
  var gal = document.getElementById("gallery-list");
  SAMPLES.forEach(function (s) {
    if (!s[1]) {
      var ti = document.createElement("div"); ti.className = "gal-item";
      var tn = document.createElement("div"); tn.className = "gal-name"; tn.textContent = "toast";
      var td = document.createElement("div"); td.className = "gal-demo"; var tt = document.createElement("div"); tt.className = "utoast success static"; tt.textContent = "Saved"; td.appendChild(tt);
      var tc = document.createElement("code"); tc.className = "gal-code"; tc.textContent = "ui.toast('Saved', { variant: 'success' })";
      ti.appendChild(tn); ti.appendChild(td); ti.appendChild(tc); gal.appendChild(ti);
      return;
    }
    var item = document.createElement("div"); item.className = "gal-item";
    var name = document.createElement("div"); name.className = "gal-name"; name.textContent = s[0];
    var demo = document.createElement("div"); demo.className = "gal-demo";
    var b = buildComponent(s[1]);
    if (s[1].type === "tabs") Object.keys(b.el.__bodies).forEach(function (n) { b.el.__bodies[n].appendChild(buildComponent({ type: "text", text: "The " + n + " tab: put components in it with parent and tab: '" + n + "'.", muted: true }).el); });
    else if (s[1].type === "grid") ["One", "Two", "Three"].forEach(function (n) { b.body.appendChild(buildComponent({ type: "stat", label: n, value: n.length }).el); });
    else if (b.body) { var inner = buildComponent({ type: "text", text: s[1].type === "modal" || s[1].type === "drawer" ? "Shown over the dash; put components inside with parent. Opens with open: true, closes with the x, Esc or a click outside (a 'close' event)." : "Components inside it.", muted: true }); b.body.appendChild(inner.el); }
    demo.appendChild(b.el);
    var shown = Object.assign({}, s[1]); delete shown.__preview;
    var code = document.createElement("code"); code.className = "gal-code"; code.textContent = "ui.add(" + JSON.stringify(shown) + ")";
    item.appendChild(name); item.appendChild(demo); item.appendChild(code);
    gal.appendChild(item);
  });

  // ---- starter tools: added once, on a first visit with no tools --------------
  // Which starters this browser has been offered: a JSON list of names (or, from
  // the first release, a date - meaning the first ten).
  var FIRST_STARTERS = ["dashboard_add", "dashboard_update", "dashboard_list", "dashboard_remove", "ask_user", "confirm", "bar_chart", "table", "cursor_click", "cursor_type"];
  function starterName(s) { return s.filename.replace(/\.js$/, ""); }
  function offeredStarters() {
    var v = null;
    try { v = localStorage.getItem(SEEDED_KEY); } catch (e) {}
    if (!v) return null;
    try { var j = JSON.parse(v); if (Array.isArray(j)) return j; } catch (e) {}
    return FIRST_STARTERS;
  }
  function markOffered() { try { localStorage.setItem(SEEDED_KEY, JSON.stringify(STARTERS.map(starterName))); } catch (e) {} }
  function newStarters() {
    var offered = offeredStarters();
    if (!offered) return [];
    var have = tools.map(function (t) { return t.name; });
    return STARTERS.filter(function (s) { var n = starterName(s); return offered.indexOf(n) < 0 && have.indexOf(n) < 0; });
  }
  function renderStarterOffer() {
    var el = document.getElementById("starters");
    var fresh = connected ? [] : newStarters();
    el.innerHTML = "";
    if (!fresh.length) return;
    var t = document.createElement("span");
    t.textContent = fresh.length + " new starter tool" + (fresh.length === 1 ? "" : "s") + ": " + fresh.map(starterName).join(", ") + " \u00b7 ";
    var add = document.createElement("button"); add.type = "button"; add.className = "linkbtn"; add.textContent = "Add";
    var skip = document.createElement("button"); skip.type = "button"; skip.className = "linkbtn"; skip.textContent = "Not now";
    add.addEventListener("click", function () {
      var chain = Promise.resolve(), n = 0;
      fresh.forEach(function (s) { chain = chain.then(function () { return validateAndStore(s.source, s.filename, null).then(function (r) { if (r.ok) n++; }); }); });
      chain.then(function () { markOffered(); render(); setStatus("Added " + n + " starter tool" + (n === 1 ? "" : "s") + "."); });
    });
    skip.addEventListener("click", function () { markOffered(); render(); });
    el.appendChild(t); el.appendChild(add); el.appendChild(document.createTextNode(" \u00b7 ")); el.appendChild(skip);
  }

  function seedStarters() {
    var seeded = null;
    try { seeded = localStorage.getItem(SEEDED_KEY); } catch (e) {}
    if (seeded || tools.length || !STARTERS.length) return;
    var chain = Promise.resolve(), added = 0;
    STARTERS.forEach(function (s) {
      chain = chain.then(function () {
        return validateAndStore(s.source, s.filename, null).then(function (r) { if (r.ok) added++; });
      });
    });
    chain.then(function () {
      markOffered();
      render();
      if (added) setStatus("Added " + added + " starter tools for building an interactive dashboard - View them as examples, or delete the ones you do not need.");
    });
  }
  seedStarters();

  // ---- token mode: ask for the device token (same page, same styles) ----------
  var gate = document.getElementById("gate");
  function forgetToken() {
    deviceToken = null;
    try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) {}
    if (gate) { gate.hidden = false; var inp = document.getElementById("gate-token"); if (inp) { inp.value = ""; inp.focus(); } }
  }
  function showGateError(msg) { var el = document.getElementById("gate-err"); if (el) { el.textContent = msg || ""; } }
  function unlock(token) {
    return fetch("/mcp?ticket=1", { method: "POST", headers: { "x-sandbox": "1", authorization: "Basic " + btoa(DEVICE + ":" + token) }, credentials: "same-origin", cache: "no-store" })
      .then(function (r) {
        if (r.status === 401) { showGateError("That token is not right for " + DEVICE + "."); return false; }
        if (r.status === 403) { showGateError("Device " + DEVICE + " is disabled."); return false; }
        if (!r.ok) { showGateError("Could not check the token (HTTP " + r.status + ")."); return false; }
        deviceToken = token;
        try { sessionStorage.setItem(TOKEN_KEY, token); } catch (e) {}
        gate.hidden = true;
        showGateError("");
        setStatus("");
        return true;
      })
      .catch(function (e) { showGateError("Network error: " + (e && e.message || e)); return false; });
  }
  if (MODE === "token" && gate) {
    if (!deviceToken) gate.hidden = false;
    var form = document.getElementById("gate-form");
    var submit = document.getElementById("gate-go");
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var v = (document.getElementById("gate-token").value || "").trim();
      if (!v) { showGateError("Enter the device token."); return; }
      submit.disabled = true;
      unlock(v).then(function (ok) { submit.disabled = false; if (ok) document.getElementById("gate-token").blur(); });
    });
    if (!deviceToken) setTimeout(function () { var i = document.getElementById("gate-token"); if (i) i.focus(); }, 50);
  }

  window.__sandbox = { analyze: analyze, tools: function () { return tools; }, comps: function () { return comps; }, state: function () { return conn.state; }, mode: MODE, locked: function () { var g = document.getElementById("gate"); return !!(g && !g.hidden); } };
  render();
})();`;

/** Example tools added on a first visit with no tools: building blocks for an
 *  interactive dashboard, and templates for writing new tools. */
export const STARTER_TOOLS: { filename: string; source: string }[] = [
  {
    "filename": "dashboard_add.js",
    "source": "/**\n * Add a component to the dashboard and return its id. Types:\n * - content: heading, text, code, image (data URL), badge, alert, stat, status, progress, divider\n * - input: button, input (inputType: text|password|number|email), textarea, editor, checkbox,\n *   toggle, radio, select, slider\n * - data: table (columns, rows; sortable, selectable -> 'select'), list (items -> 'click')\n * - layout: row, column, grid (columns: n), card (title), tabs (tabs: [...]; children give tab),\n *   accordion (title, open), modal and drawer (title, open, side; 'close' event; top level only)\n * Put a component inside a container with parent. Any component takes hidden, width, grow;\n * \"draggable\": true lets people drag it (a 'drop' event). Make it interactive with\n * \"on\": {\"click\": {\"tool\": \"dashboard_update\", \"args\": {\"id\": \"c7\", \"props\": {\"open\": true}}}}\n * (events: click, change, drop, dblclick, select, toggle, close) - it runs in the browser.\n * Example spec: {\"type\": \"card\", \"title\": \"Build\"} or {\"type\": \"button\", \"label\": \"Run\", \"parent\": \"c1\"}.\n * @param {object} spec The component, e.g. {\"type\": \"text\", \"text\": \"Hello\"}\n */\nexport default async function dashboard_add(spec) {\n  return await ui.add(spec);\n}\n"
  },
  {
    "filename": "dashboard_update.js",
    "source": "/**\n * Change a dashboard component: its text, label, value, options, checked, rows,\n * variant, state, disabled, hidden, open (modal, drawer, accordion), value (the\n * tab of tabs) or on (handlers). Returns the component as it is now.\n * @param {string} id The component id (from dashboard_add or dashboard_list)\n * @param {object} props The properties to change, e.g. {\"text\": \"Done\", \"state\": \"off\"}\n */\nexport default async function dashboard_update(id, props) {\n  return await ui.update(id, props);\n}\n"
  },
  {
    "filename": "dashboard_list.js",
    "source": "/**\n * List every component on the dashboard with its id, type and current value,\n * so an agent can see what is there - including what the user typed or checked.\n */\nexport default async function dashboard_list() {\n  return await ui.list();\n}\n"
  },
  {
    "filename": "dashboard_remove.js",
    "source": "/**\n * Remove one component (and anything inside it), or - with no id - everything\n * this client added to the dashboard.\n * @param {string} [id] The component to remove; omit to clear your components\n */\nexport default async function dashboard_remove(id) {\n  if (id === undefined) return { removed: await ui.clear() };\n  await ui.remove(id);\n  return { removed: 1 };\n}\n"
  },
  {
    "filename": "dashboard_events.js",
    "source": "/**\n * What happened on the dashboard: clicks and changes by the person at the\n * browser or by any client's cursor, oldest first. Pass the returned 'next' as\n * 'since' to get only newer events; with timeout_seconds, wait for one.\n * @param {integer} [since=0] Only events after this sequence number\n * @param {number} [timeout_seconds=0] Wait up to this long when nothing new has happened\n */\nexport default async function dashboard_events(since = 0, timeout_seconds = 0) {\n  return await ui.events({ since, timeout: Math.min(timeout_seconds, 110) * 1000 });\n}\n"
  },
  {
    "filename": "ask_user.js",
    "source": "/**\n * Ask the person at the browser a question and wait for the answer (typed into\n * a box on the dashboard, sent with Enter or the Send button).\n * @param {string} question What to ask\n * @param {string} [placeholder] Hint shown in the empty answer box\n * @param {number} [timeout_seconds=100] How long to wait for an answer\n */\nexport default async function ask_user(question, placeholder, timeout_seconds = 100) {\n  const card = await ui.add({ type: \"card\", title: \"Question\" });\n  await ui.add({ type: \"text\", text: question, parent: card });\n  const row = await ui.add({ type: \"row\", parent: card });\n  const answer = await ui.add({ type: \"input\", placeholder: placeholder || \"your answer\", parent: row });\n  const send = await ui.add({ type: \"button\", label: \"Send\", parent: row });\n  const timeout = Math.min(timeout_seconds, 110) * 1000;\n  const quiet = (p) => p.catch(() => ({ event: \"cancelled\" }));\n  const ev = await Promise.race([quiet(ui.wait(send, { event: \"click\", timeout })), quiet(ui.wait(answer, { event: \"change\", timeout }))]);\n  const text = (await ui.get(answer)).value;\n  await ui.remove(card);\n  if (ev.event === \"timeout\") return { answered: false };\n  return { answered: true, answer: text };\n}\n"
  },
  {
    "filename": "confirm.js",
    "source": "/**\n * Ask the person at the browser to confirm something: shows the message with\n * Yes and No buttons and waits for a click. Returns true for Yes.\n * @param {string} message What to confirm\n * @param {number} [timeout_seconds=100] How long to wait\n */\nexport default async function confirm(message, timeout_seconds = 100) {\n  const card = await ui.add({ type: \"card\", title: \"Confirm\" });\n  await ui.add({ type: \"text\", text: message, parent: card });\n  const row = await ui.add({ type: \"row\", parent: card });\n  const yes = await ui.add({ type: \"button\", label: \"Yes\", parent: row });\n  const no = await ui.add({ type: \"button\", label: \"No\", variant: \"secondary\", parent: row });\n  const timeout = Math.min(timeout_seconds, 110) * 1000;\n  const quiet = (p) => p.catch(() => ({ event: \"cancelled\" }));\n  const ev = await Promise.race([quiet(ui.wait(yes, { event: \"click\", timeout })), quiet(ui.wait(no, { event: \"click\", timeout }))]);\n  await ui.remove(card);\n  if (ev.event !== \"click\") return { answered: false };\n  return { answered: true, confirmed: ev.id === yes };\n}\n"
  },
  {
    "filename": "bar_chart.js",
    "source": "/**\n * Draw a bar chart on the dashboard (an SVG image). Returns the image's id;\n * call it again with the same id to redraw it with new numbers.\n * @param {string} title The chart's title\n * @param {string[]} labels One label per bar\n * @param {number[]} values One number per bar\n * @param {string} [id] An existing chart to redraw instead of adding a new one\n */\nexport default async function bar_chart(title, labels, values, id) {\n  if (labels.length !== values.length) throw new Error(\"labels and values must have the same length\");\n  const esc = (s) => String(s).replace(/&/g, \"&amp;\").replace(/</g, \"&lt;\").replace(/>/g, \"&gt;\");\n  const W = 560, H = 240, pad = 34, bw = (W - pad * 2) / Math.max(1, values.length);\n  const max = Math.max(1, ...values.map(Math.abs));\n  let bars = \"\";\n  values.forEach((v, i) => {\n    const h = Math.round((Math.abs(v) / max) * (H - pad * 2 - 14));\n    const x = pad + i * bw + bw * 0.15, y = H - pad - h;\n    bars += '<rect x=\"' + x + '\" y=\"' + y + '\" width=\"' + bw * 0.7 + '\" height=\"' + h + '\" fill=\"#111\"/>';\n    bars += '<text x=\"' + (x + bw * 0.35) + '\" y=\"' + (y - 4) + '\" text-anchor=\"middle\" font-size=\"10\">' + esc(v) + '</text>';\n    bars += '<text x=\"' + (x + bw * 0.35) + '\" y=\"' + (H - pad + 14) + '\" text-anchor=\"middle\" font-size=\"10\" fill=\"#666\">' + esc(labels[i]) + '</text>';\n  });\n  const svg = '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"' + W + '\" height=\"' + H + '\" font-family=\"JetBrains Mono, monospace\">' +\n    '<rect width=\"100%\" height=\"100%\" fill=\"#fff\"/>' +\n    '<text x=\"' + pad + '\" y=\"20\" font-size=\"12\" font-weight=\"700\">' + esc(title) + '</text>' +\n    '<line x1=\"' + pad + '\" y1=\"' + (H - pad) + '\" x2=\"' + (W - pad) + '\" y2=\"' + (H - pad) + '\" stroke=\"#111\"/>' + bars + '</svg>';\n  const src = \"data:image/svg+xml;base64,\" + btoa(unescape(encodeURIComponent(svg)));\n  if (id) { await ui.update(id, { src, alt: title }); return id; }\n  return await ui.add({ type: \"image\", src, alt: title });\n}\n"
  },
  {
    "filename": "table.js",
    "source": "/**\n * Show rows of data as an aligned table on the dashboard. Returns its id.\n * @param {string[]} columns The column headings\n * @param {array} rows The rows: each an array with one value per column\n * @param {string} [title] A heading above the table\n */\nexport default async function table(columns, rows, title) {\n  const cells = [columns.map(String)].concat(rows.map((r) => columns.map((_, i) => (r[i] === undefined || r[i] === null ? \"\" : String(r[i])))));\n  const widths = columns.map((_, i) => Math.max(...cells.map((r) => r[i].length)));\n  const line = (r) => r.map((c, i) => c.padEnd(widths[i])).join(\"  \").trimEnd();\n  const text = [line(cells[0]), widths.map((w) => \"-\".repeat(w)).join(\"  \")].concat(cells.slice(1).map(line)).join(\"\\n\");\n  if (!title) return await ui.add({ type: \"code\", text });\n  const card = await ui.add({ type: \"card\", title });\n  await ui.add({ type: \"code\", text, parent: card });\n  return card;\n}\n"
  },
  {
    "filename": "increment.js",
    "source": "/**\n * Add to the number shown by a text or heading component - an example of an\n * event handler: give a button on: {click: {tool: \"increment\", args: {id: \"c2\"}}}\n * and every click counts up, in the browser. The click itself arrives as 'event'.\n * @param {string} id The text or heading showing the number\n * @param {number} [by=1] How much to add\n */\nexport default async function increment(id, by = 1) {\n  const current = Number((await ui.get(id)).text) || 0;\n  await ui.update(id, { text: String(current + by) });\n  return { value: current + by, clicked_by: event ? event.by : null };\n}\n"
  },
  {
    "filename": "cursor_click.js",
    "source": "/**\n * Move your named cursor to a component and click it (a button presses, a\n * checkbox toggles, a text box gets focus). Returns the component's state.\n * @param {string} id The component to click\n */\nexport default async function cursor_click(id) {\n  return await cursor.click(id);\n}\n"
  },
  {
    "filename": "cursor_type.js",
    "source": "/**\n * Move your named cursor to a text box (input, textarea or editor) and type\n * into it, key by key. With replace=true the box is cleared first.\n * @param {string} id The text box\n * @param {string} text What to type\n * @param {boolean} [replace=false] Clear the box before typing\n */\nexport default async function cursor_type(id, text, replace = false) {\n  if (replace) await cursor.fill(id, \"\");\n  return await cursor.type(id, text);\n}\n"
  },
  {
    "filename": "cursor_drag.js",
    "source": "/**\n * Drag a component with your named cursor: before another component, into a\n * row or card, or a slider to a value. Reports a 'drop' (or 'change') event.\n * @param {string} id The component to drag (draggable components, or a slider)\n * @param {string|number} target A component id (drops before it, or into it if it is a row or card), or a number for a slider\n * @param {string} [position] 'before', 'after' or 'into' - overrides the default for a component target\n */\nexport default async function cursor_drag(id, target, position) {\n  if (typeof target === \"number\" || !position) return await cursor.drag(id, target);\n  return await cursor.drag(id, { [position]: target });\n}\n"
  },
  {
    "filename": "kanban.js",
    "source": "/**\n * Build a kanban board: a row of columns (cards), with the given tasks as\n * draggable items in the first column. People drag tasks with the mouse,\n * agents with cursor_drag; each move is a 'drop' event (see dashboard_events).\n * With progress (default), a progress bar and a status line above the board\n * update themselves on every move - in the browser, no agent needed - via the\n * kanban_progress tool as each task's drop handler.\n * @param {string[]} columns Column names, e.g. [\"To do\", \"Doing\", \"Done\"] - the last counts as done\n * @param {string[]} [tasks] Tasks to start with, in the first column\n * @param {boolean} [progress=true] Add the self-updating progress bar and status line\n * @param {string} [parent] A row or card to put the board in\n */\nexport default async function kanban(columns, tasks, progress = true, parent) {\n  if (!columns.length) throw new Error(\"give at least one column\");\n  const where = parent ? { parent } : {};\n  let status, bar;\n  if (progress) {\n    status = await ui.add({ type: \"status\", text: \"\", state: \"pending\", ...where });\n    bar = await ui.add({ type: \"progress\", label: columns[columns.length - 1], value: 0, text: \"0 / 0\", ...where });\n  }\n  const board = await ui.add({ type: \"row\", ...where });\n  const ids = {};\n  for (const name of columns) ids[name] = await ui.add({ type: \"card\", title: name, parent: board });\n  const cols = columns.map((n) => ids[n]);\n  const handler = progress ? { drop: { tool: \"kanban_progress\", args: { columns: cols, done: cols[cols.length - 1], progress: bar, status } } } : undefined;\n  const items = [];\n  for (const t of tasks || []) items.push(await ui.add({ type: \"text\", text: String(t), draggable: true, parent: ids[columns[0]], ...(handler ? { on: handler } : {}) }));\n  if (progress) await kanban_progress_now(cols, bar, status);\n  return { board, columns: ids, tasks: items, progress: bar, status, on: handler };\n}\n\nasync function kanban_progress_now(cols, bar, status) {\n  const comps = await ui.list();\n  const n = cols.map((c) => comps.filter((x) => x.parent === c).length);\n  const total = n.reduce((a, b) => a + b, 0), done = n[n.length - 1];\n  await ui.update(bar, { value: total ? Math.round((done / total) * 100) : 0, text: done + \" / \" + total });\n  const titles = cols.map((c) => (comps.find((x) => x.id === c) || {}).title || c);\n  await ui.update(status, { text: n.map((k, i) => k + \" \" + titles[i].toLowerCase()).join(\" \\u00b7 \"), state: !total ? \"pending\" : done === total ? \"on\" : \"off\" });\n}\n"
  },
  {
    "filename": "kanban_progress.js",
    "source": "/**\n * Update a kanban board's progress: count the items in each column, then set\n * the progress bar (done / total, the done column being the one given) and,\n * optionally, a status line like \"2 to do \\u00b7 1 doing \\u00b7 3 done\". Made to be\n * the drop handler of the board's items, so progress follows every drag:\n * on: {drop: {tool: \"kanban_progress\", args: {columns, done, progress, status}}}.\n * @param {string[]} columns The columns' ids (cards), in order\n * @param {string} done The id of the column that counts as done\n * @param {string} progress The progress component to update\n * @param {string} [status] A status component for the per-column counts\n */\nexport default async function kanban_progress(columns, done, progress, status) {\n  const comps = await ui.list();\n  const count = {};\n  for (const c of columns) count[c] = comps.filter((x) => x.parent === c).length;\n  const total = Object.values(count).reduce((a, b) => a + b, 0), finished = count[done] || 0;\n  await ui.update(progress, { value: total ? Math.round((finished / total) * 100) : 0, text: finished + \" / \" + total });\n  if (status) {\n    const title = (id) => ((comps.find((x) => x.id === id) || {}).title || id).toLowerCase();\n    await ui.update(status, { text: columns.map((c) => count[c] + \" \" + title(c)).join(\" \\u00b7 \"), state: !total ? \"pending\" : finished === total ? \"on\" : \"off\" });\n  }\n  return { count, done: finished, total };\n}\n"
  },
  {
    "filename": "sql.js",
    "source": "/**\n * Run SQL on this browser's SQLite database (it lasts across calls and\n * reloads). Statements that return rows (SELECT, WITH, PRAGMA, ... RETURNING)\n * give the rows; others give { changes, lastInsertRowid }. Without params,\n * several statements separated by ';' run in order.\n * @param {string} statement SQL, e.g. \"CREATE TABLE todo (id INTEGER PRIMARY KEY, text TEXT, done INTEGER DEFAULT 0)\"\n * @param {array} [params] Values for the ? placeholders\n */\nexport default async function sql(statement, params) {\n  if (/^\\s*(select|with|pragma|explain)\\b/i.test(statement) || /\\breturning\\b/i.test(statement)) return await db.query(statement, params);\n  return await db.execute(statement, params);\n}\n"
  },
  {
    "filename": "storage.js",
    "source": "/**\n * Keep small values in this browser across calls and reloads (a key-value\n * store). get returns the value (or null), set stores any JSON value, delete\n * removes a key, list returns the keys (optionally those starting with key).\n * @param {string} action get, set, delete or list\n * @param {string} [key] The key - for list, an optional prefix\n * @param {*} [value] For set: the value to store\n */\nexport default async function storage(action, key, value) {\n  if (action === \"list\") return await kv.list(key || \"\");\n  if (!key) throw new Error(\"give a key\");\n  if (action === \"get\") return await kv.get(key);\n  if (action === \"set\") return await kv.set(key, value);\n  if (action === \"delete\") return await kv.delete(key);\n  throw new Error(\"action must be get, set, delete or list\");\n}\n"
  },
  {
    "filename": "example_app.js",
    "source": "/**\n * Build an example web app on the dashboard - a header, a navigation drawer,\n * stats, alerts, a sortable table in tabs, an accordion and an About modal - to\n * show what the components can do. Buttons open the drawer and the modal with\n * dashboard_update handlers, so it works in the browser without an agent.\n * Returns the ids, so an agent can keep building on it.\n */\nexport default async function example_app() {\n  const nav = await ui.add({ type: \"drawer\", title: \"Navigate\", side: \"left\", open: false });\n  const navList = await ui.add({ type: \"list\", parent: nav, value: \"overview\", items: [\n    { label: \"Overview\", value: \"overview\", description: \"Today at a glance\" },\n    { label: \"Deploys\", value: \"deploys\", badge: \"3\" },\n    { label: \"Settings\", value: \"settings\" },\n  ] });\n  const about = await ui.add({ type: \"modal\", title: \"About Acme Ops\", open: false });\n  await ui.add({ type: \"text\", parent: about, text: \"Built by an agent with the Sandbox components. Close with the x, Esc or a click outside.\" });\n  const header = await ui.add({ type: \"row\" });\n  await ui.add({ type: \"button\", label: \"\\u2630 Menu\", variant: \"secondary\", parent: header, on: { click: { tool: \"dashboard_update\", args: { id: nav, props: { open: true } } } } });\n  await ui.add({ type: \"heading\", text: \"Acme Ops\", parent: header, grow: true });\n  await ui.add({ type: \"badge\", text: \"live\", variant: \"success\", parent: header });\n  await ui.add({ type: \"button\", label: \"About\", variant: \"secondary\", parent: header, on: { click: { tool: \"dashboard_update\", args: { id: about, props: { open: true } } } } });\n  await ui.add({ type: \"alert\", variant: \"warning\", title: \"Maintenance\", text: \"Database upgrade on Saturday 02:00-03:00.\" });\n  const stats = await ui.add({ type: \"grid\", columns: 3 });\n  await ui.add({ type: \"stat\", parent: stats, label: \"Requests\", value: \"12.4k\", delta: \"8% this week\", trend: \"up\" });\n  await ui.add({ type: \"stat\", parent: stats, label: \"Errors\", value: \"0.3%\", delta: \"0.1% this week\", trend: \"down\" });\n  await ui.add({ type: \"stat\", parent: stats, label: \"Deploys\", value: \"27\" });\n  const tabs = await ui.add({ type: \"tabs\", tabs: [\"Deploys\", \"Logs\"] });\n  const table = await ui.add({ type: \"table\", parent: tabs, tab: \"Deploys\",\n    columns: [{ key: \"id\", label: \"#\", align: \"right\" }, { key: \"service\", label: \"Service\" }, { key: \"status\", label: \"Status\" }, { key: \"ms\", label: \"Duration (s)\", align: \"right\" }],\n    rows: [{ id: 104, service: \"api\", status: \"ok\", ms: 41 }, { id: 103, service: \"web\", status: \"failed\", ms: 380 }, { id: 102, service: \"jobs\", status: \"ok\", ms: 12 }] });\n  await ui.add({ type: \"code\", parent: tabs, tab: \"Logs\", text: \"02:14 api   deploy 104 ok\\n02:09 web   deploy 103 failed: health check\\n01:58 jobs  deploy 102 ok\" });\n  const more = await ui.add({ type: \"accordion\", title: \"Settings\", open: false });\n  await ui.add({ type: \"toggle\", label: \"Auto-deploy main\", checked: true, parent: more });\n  await ui.add({ type: \"input\", label: \"Alert email\", inputType: \"email\", placeholder: \"ops@acme.dev\", parent: more });\n  await ui.toast(\"Example app ready\", { variant: \"success\" });\n  return { nav, navList, about, header, stats, tabs, table, more };\n}\n"
  }
];

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderSandboxPage(deviceId: string, mode: "basic" | "token" = "basic"): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "  <head>",
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
    '    <meta name="referrer" content="no-referrer" />',
    "    <title>Prime - Sandbox</title>",
    '    <link rel="icon" id="favicon" href="' + FAVICON + '" />',
    '    <link rel="preconnect" href="https://fonts.googleapis.com" />',
    '    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />',
    '    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet" />',
    "    <style>" + UI_CSS + SANDBOX_CSS + "    </style>",
    "  </head>",
    "  <body>",
    "    <h1>Sandbox</h1>",
    '    <div class="sub">this browser as a device &middot; ' + esc(deviceId) + "</div>",
    '    <div class="row-head">',
    "      <h2>Tools</h2>",
    '      <button class="plus" id="addBtn" type="button" title="Add a tool">+</button>',
    "    </div>",
    '    <ul id="list"></ul>',
    '    <div class="status" id="status"></div>',
    '    <div class="status" id="count"></div>',
    '    <div class="status" id="starters"></div>',
    '    <div class="status" id="data"></div>',
    '    <div class="connect-row"><button class="connect" id="connect" type="button">Connect</button><div class="conninfo" id="conninfo"></div></div>',
    '    <section id="dash" hidden>',
    '      <div class="row-head section dash-head"><h2>Dash</h2><span class="status" id="running"></span><button class="icon-btn" id="dashSize" type="button" title="Expand" aria-label="Expand"></button></div>',
    '      <div class="dash-area" id="dash-area"><div class="dash-empty">Tools called by MCP clients show their UI here. It stays across Disconnect and reloads.</div></div>',
    "    </section>",
    '    <details class="gallery" id="gallery">',
    "      <summary>Components</summary>",
    '      <p class="gal-intro">Inside a tool, <code>ui.add({...})</code> returns a component id; <code>ui.update</code>, <code>ui.get</code>, <code>ui.remove</code>, <code>ui.clear</code>, <code>ui.list</code> and <code>ui.wait(id)</code> (the next click or change) work on it. Give a component <code>on: { click: { tool: \'name\', args: {...} } }</code> (or <code>change</code>) and every click or change runs that tool in the browser - it receives the details as <code>event</code>; <code>ui.events({ since, timeout })</code> returns what happened, for agents to react to. Add <code>draggable: true</code> and people can drag a component between others or into a row or card (a <code>drop</code> event). <code>cursor.move</code>, <code>hover</code>, <code>click</code>, <code>dblclick</code>, <code>type</code>, <code>fill</code>, <code>press</code>, <code>check</code>, <code>select</code>, <code>drag</code> and <code>scroll</code> drive this client\'s named cursor. Pass <code>parent</code> to put a component in a row or card. Tools have no network; images are data URLs. Tools also get <code>kv.get/set/delete/list</code> and <code>db.query/execute</code> (SQLite), kept in this browser.</p>',
    '      <div id="gallery-list"></div>',
    "    </details>",
    '    <input id="picker" type="file" accept=".js,.mjs,text/javascript" multiple style="display:none" />',
    mode === "token"
      ? '    <div class="overlay" id="gate" hidden><form class="dlg dlg-confirm" id="gate-form" role="dialog" aria-labelledby="gate-title">' +
        '<div class="dlg-head"><span id="gate-title">Device token</span><span class="dlg-id">' + esc(deviceId) + '</span></div>' +
        '<div class="dlg-body"><div class="dlg-msg">This page manages the Sandbox of device <b>' + esc(deviceId) + '</b>. Enter its device token to continue - the same token you gave the gateway admin page.</div>' +
        '<input id="gate-token" class="gate-input" type="password" autocomplete="current-password" spellcheck="false" placeholder="device token" aria-label="device token" />' +
        '<div class="dlg-msg err" id="gate-err"></div>' +
        '<div class="dlg-bar"><button class="btn" id="gate-go" type="submit">Unlock</button></div></div></form></div>'
      : "",
    "    <script>window.__DEVICE__ = " + JSON.stringify(deviceId).replace(/</g, "\\u003c") + "; window.__MODE__ = " + JSON.stringify(mode) + "; window.__STARTERS__ = " + JSON.stringify(STARTER_TOOLS).replace(/</g, "\\u003c") + ";</script>",
    "    <script>" + PAGE_JS + "</script>",
    "  </body>",
    "</html>",
  ].join("\n");
}

export { RUNTIME_JS };

export function renderRuntimeFrame(): string {
  return '<!doctype html><html><head><meta charset="utf-8"><title>tool runtime</title></head><body><script>' + RUNTIME_JS + "</script></body></html>";
}

const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src data: blob:",
  "frame-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

// The runtime is sandboxed by its own response too, so even opened directly it
// has an opaque origin: no cookies, no storage, no credentials, no network.
const RUNTIME_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "img-src data:",
  "frame-ancestors 'self'",
].join("; ");

// ---- WebSocket tickets ----------------------------------------------------------
// "<exp>.<nonce>.<sig>", sig = HMAC-SHA256(device token, "sandbox|id|exp|nonce").
// Short-lived (30 s), bound to the device id, single-use (the DO remembers the
// nonce). Signed with the device's own token: no extra secret to manage, and
// rotating the token invalidates outstanding tickets.
export const TICKET_TTL_MS = 30_000;

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function ticketSig(deviceId: string, token: string, exp: string, nonce: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("sandbox|" + deviceId + "|" + exp + "|" + nonce));
  return b64url(new Uint8Array(sig));
}

export async function signTicket(deviceId: string, token: string, now = Date.now()): Promise<string> {
  const exp = String(now + TICKET_TTL_MS);
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  return exp + "." + nonce + "." + (await ticketSig(deviceId, token, exp, nonce));
}

export async function verifyTicket(deviceId: string, ticket: string, token: string, now = Date.now()): Promise<{ nonce: string } | null> {
  const parts = ticket.split(".");
  if (parts.length !== 3 || !/^\d{13}$/.test(parts[0]) || !/^[\w-]{16,64}$/.test(parts[1])) return null;
  const exp = Number(parts[0]);
  if (exp < now || exp > now + TICKET_TTL_MS + 5_000) return null;
  const expected = await ticketSig(deviceId, token, parts[0], parts[1]);
  if (expected.length !== parts[2].length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ parts[2].charCodeAt(i);
  return diff === 0 ? { nonce: parts[1] } : null;
}

function basicPassword(request: Request): string | null {
  const h = request.headers.get("authorization") || "";
  if (!/^basic /i.test(h)) return null;
  try {
    const raw = atob(h.slice(6).trim());
    const i = raw.indexOf(":");
    return i < 0 ? null : raw.slice(i + 1);
  } catch {
    return null;
  }
}

function sandboxUnauthorized(base: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { ...base, "content-type": "application/json; charset=utf-8", "www-authenticate": 'Basic realm="Prime sandbox", charset="UTF-8"' },
  });
}

/** A refusal from authorizeDevice as-is (a disabled device is 403, not 401),
 *  with the browser's Basic challenge only when it really is an auth failure. */
function refusal(res: Response, base: Record<string, string>): Response {
  if (res.status !== 401) return res;
  const headers = new Headers(res.headers);
  headers.set("www-authenticate", 'Basic realm="Prime sandbox", charset="UTF-8"');
  headers.set("cache-control", "no-store");
  return new Response(res.body, { status: 401, headers });
}

/** GET/HEAD /mcp (page, runtime frame); POST /mcp?ticket=1 (WebSocket ticket). */
/** GET /mcp/{deviceId} opened in a browser: the same Sandbox page, which asks
 *  for the device token instead of relying on HTTP Basic. MCP clients keep the
 *  405 they already got: this only answers requests that ask for HTML. */
export function handleSandboxDevicePage(request: Request, url: URL): Response {
  const deviceId = url.pathname.slice("/mcp/".length);
  if (!validDeviceId(deviceId)) return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
  const ws = (url.protocol === "https:" ? "wss://" : "ws://") + url.host;
  return new Response(request.method === "HEAD" ? null : renderSandboxPage(deviceId, "token"), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
      "content-security-policy": PAGE_CSP + "; connect-src 'self' " + ws + "; worker-src blob:",
    },
  });
}

export async function handleSandbox(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === "POST" && url.searchParams.has("ticket")) {
    const base = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
    // A custom header forces a CORS preflight, so another site cannot make the
    // browser mint a ticket with its remembered Basic credentials.
    if (request.headers.get("x-sandbox") !== "1") return Response.json({ error: "missing x-sandbox header" }, { status: 400, headers: base });
    const auth = await authorizeDevice(env, request);
    const token = basicPassword(request);
    if (auth instanceof Response) return refusal(auth, base);
    if (!token) return sandboxUnauthorized(base);
    let online = false;
    try {
      const r = await env.DEVICES.get(env.DEVICES.idFromName(auth.deviceId)).fetch("https://device/online");
      online = ((await r.json()) as { online?: boolean }).online === true;
    } catch {}
    const ticket = await signTicket(auth.deviceId, token);
    const wsBase = (url.protocol === "https:" ? "wss://" : "ws://") + url.host;
    return Response.json(
      { device_id: auth.deviceId, online, ticket, ws_url: wsBase + "/ws/" + encodeURIComponent(auth.deviceId) + "?ticket=" + encodeURIComponent(ticket), mcp_url: url.origin + "/mcp/" + encodeURIComponent(auth.deviceId), expires_in_ms: TICKET_TTL_MS },
      { headers: base },
    );
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return Response.json({ error: "method not allowed", hint: "MCP clients POST to /mcp/{deviceId}" }, { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const base = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" };
  if (url.searchParams.get("frame") === "runtime") {
    return new Response(request.method === "HEAD" ? null : renderRuntimeFrame(), {
      headers: { ...base, "content-type": "text/html; charset=utf-8", "content-security-policy": RUNTIME_CSP },
    });
  }
  const auth = await authorizeDevice(env, request);
  if (auth instanceof Response) return refusal(auth, base);
  const ws = (url.protocol === "https:" ? "wss://" : "ws://") + url.host;
  return new Response(request.method === "HEAD" ? null : renderSandboxPage(auth.deviceId), {
    headers: { ...base, "content-type": "text/html; charset=utf-8", "content-security-policy": PAGE_CSP.replace("script-src 'unsafe-inline'", "script-src 'unsafe-inline' 'self' 'wasm-unsafe-eval'") + "; connect-src 'self' " + ws + "; worker-src blob:" },
  });
}

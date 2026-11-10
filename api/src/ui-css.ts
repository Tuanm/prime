// Shared stylesheet for the gateway's HTML pages.
//
// Extracted verbatim from the admin UI so /files and /files/{id} are styled
// identically to /admin instead of drifting apart. Escaping (backslashes,
// backticks, \${) only exists so the CSS can live in a template literal;
// the emitted bytes are exactly the admin page's <style> content.

export const UI_CSS = `      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }
      body {
        width: 540px;
        margin: 48px auto;
        font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 13px;
        color: #111;
        background: #fff;
        line-height: 1.4;
      }
      h1 {
        font-size: 20px;
        font-weight: 700;
        letter-spacing: 0.4px;
        margin-bottom: 2px;
      }
      .sub {
        font-size: 11px;
        color: #999;
        margin-bottom: 22px;
      }
      .row-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 10px;
      }
      /* A second section on the same page (Anonymous Devices under Devices):
         clear separation, and the same header height as one with a + button. */
      .row-head.section {
        margin-top: 40px;
        min-height: 28px;
      }
      .row-head h2 {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.7px;
      }
      .plus {
        width: 28px;
        height: 28px;
        border: 1px solid #111;
        background: #fff;
        color: #111;
        font-size: 16px;
        line-height: 1;
        cursor: pointer;
      }
      .plus:hover {
        background: #f5f5f5;
      }
      ul {
        list-style: none;
      }
      .row {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 8px;
      }
      .dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        flex: none;
      }
      .dot.on {
        background: #16a34a;
      }
      .dot.off {
        background: #fff;
        border: 1.5px solid #b91c1c;
      }
      /* Same footprint as the 10px status dot (width + gap must match) so
         the box's left border aligns exactly with the other rows. */
      .cloud-ic {
        width: 10px;
        height: 10px;
        flex: none;
        display: flex;
        align-items: center;
        justify-content: center;
        line-height: 0;
      }
      .cloud-ic svg {
        display: block;
        width: 100%;
        height: 100%;
        fill: currentColor;
      }
      .cloud-ic.on {
        color: #16a34a;
      }
      .cloud-ic.off {
        color: #999;
      }
      /* Disabled rows dim via colors, NOT opacity: the context menu lives
         inside .box and opacity would make the menu see-through. */
      .row.disabled .box {
        border-color: #ccc;
        background: #fafafa;
      }
      .row.disabled .id-input,
      .row.disabled .tok-input {
        color: #999;
      }
      .row.disabled .menu-btn {
        border-color: #ccc;
        color: #999;
      }
      .row.disabled .dot.on {
        background: #999;
      }
      .box {
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 8px;
        border: 1px solid #111;
        padding: 8px 10px;
        background: #fff;
      }
      .box input {
        border: none;
        border-bottom: 1px dotted #999;
        font-family: inherit;
        padding: 2px 0;
        background: transparent;
        color: #111;
      }
      .box input:focus {
        outline: none;
        border-bottom-color: #111;
      }
      .id-input {
        flex: 1;
        min-width: 0;
        font-size: 13px;
        font-weight: 600;
      }
      .tok-input {
        width: 140px;
        font-size: 12px;
        color: #666;
      }
      .menu-wrap {
        position: relative;
        flex: none;
      }
      .menu-btn {
        width: 28px;
        height: 28px;
        border: 1px solid #111;
        background: #fff;
        color: #111;
        font-size: 15px;
        line-height: 1;
        cursor: pointer;
      }
      .menu-btn:hover {
        background: #f5f5f5;
      }
      .menu {
        position: absolute;
        right: 0;
        top: 32px;
        min-width: 130px;
        border: 1px solid #111;
        background: #fff;
        z-index: 10;
        display: none;
      }
      .menu.open {
        display: block;
      }
      .menu button {
        display: block;
        width: 100%;
        text-align: left;
        padding: 8px 12px;
        border: none;
        background: #fff;
        font-family: inherit;
        font-size: 12px;
        cursor: pointer;
      }
      .menu button:hover {
        background: #f5f5f5;
      }
      .menu button.danger {
        color: #b91c1c;
      }
      .menu button:disabled {
        color: #ccc;
        cursor: default;
      }
      .menu button:disabled:hover {
        background: #fff;
      }
      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(17, 17, 17, 0.4);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 100;
      }
      .dlg {
        width: 480px;
        max-width: 92vw;
        max-height: 70vh;
        background: #fff;
        border: 1px solid #111;
        display: flex;
        flex-direction: column;
      }
      .dlg-head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 12px;
        border-bottom: 1px solid #111;
        font-size: 12px;
        font-weight: 700;
      }
      .dlg-id {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: #666;
        font-weight: 400;
      }
      /* Dialog action buttons: same black/white, 1px-line design as the rest. */
      /* The body carries no padding of its own - rows do - so the action bar
         pads itself to line up with them instead of touching the border. */
      /* Sticky: a long dialog scrolls behind the bar instead of hiding the
         buttons below the fold, so the action is always in reach. */
      .dlg-bar {
        position: sticky;
        bottom: 0;
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        padding: 12px;
        background: #fff;
        border-top: 1px solid #eee;
      }
      .btn {
        font: inherit;
        font-size: 12px;
        font-weight: 600;
        line-height: 1.2;
        padding: 7px 16px;
        background: #111;
        color: #fff;
        border: 1px solid #111;
        cursor: pointer;
      }
      .btn:hover:not(:disabled) {
        background: #000;
      }
      .btn.secondary {
        background: #fff;
        color: #111;
      }
      .btn.secondary:hover:not(:disabled) {
        background: #f2f2f2;
      }
      .btn.danger {
        background: #b91c1c;
        border-color: #b91c1c;
      }
      .btn.danger:hover:not(:disabled) {
        background: #991b1b;
        border-color: #991b1b;
      }
      .btn:disabled {
        opacity: 0.4;
        cursor: default;
      }
      .dlg-close {
        border: 1px solid #111;
        background: #fff;
        cursor: pointer;
        font-size: 14px;
        line-height: 1;
        padding: 2px 7px;
      }
      .dlg-close:hover {
        background: #f5f5f5;
      }
      .dlg-body {
        overflow-y: auto;
        padding: 6px 0;
        font-size: 12px;
      }
      .dlg-tool {
        padding: 8px 12px;
        border-bottom: 1px solid #eee;
      }
      .dlg-tool .t-name {
        font-weight: 600;
      }
      .dlg-tool .t-desc {
        color: #666;
        font-size: 11px;
        margin-top: 2px;
      }
      .dlg-msg {
        padding: 14px 12px;
        color: #666;
      }
      .dlg-msg.err {
        color: #b91c1c;
      }
      .status {
        margin-top: 14px;
        font-size: 11px;
        color: #666;
        min-height: 16px;
      }
      .empty {
        font-size: 12px;
        color: #999;
        padding: 14px;
        border: 1px dashed #999;
        text-align: center;
      }
      /* ---- fleets ----
         The fleets are roots and the spaces in them are the leaves below.
         Every one of them is a row of the device list, so they all look
         the same. */
      .fleet-branch {
        margin-bottom: 10px;
      }
      .fleet-meta {
        color: #666;
        font-size: 11px;
        white-space: nowrap;
      }
      .fleet-actions {
        margin-left: auto;
        display: flex;
        gap: 6px;
      }
      /* The plain actions: they say what they do, so they are not hidden
         behind a menu. They are the secondary buttons of the interface. */
      .fleet-btn {
        font: inherit;
        font-size: 12px;
        font-weight: 600;
        line-height: 1.2;
        padding: 7px 12px;
        background: #fff;
        color: #111;
        border: 1px solid #111;
        cursor: pointer;
        white-space: nowrap;
      }
      .fleet-btn:hover {
        background: #f2f2f2;
      }
      .fleet-btn.danger {
        color: #b91c1c;
        border-color: #b91c1c;
      }
      .fleet-btn {
        border: 1px solid #111;
        background: #fff;
        padding: 5px 10px;
        font: inherit;
        font-size: 12px;
        cursor: pointer;
        color: #111;
      }
      .fleet-btn:hover {
        background: #f5f5f5;
      }
      .fleet-btn.danger {
        color: #b91c1c;
      }
      /* The fleets are roots; the spaces in them are the leaves below.
         The branch is drawn with a line, the way a tree is drawn. */
      .fleet-tree {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .fleet-branch {
        margin-bottom: 14px;
      }
      .fleet-tree .fleet-tree {
        position: relative;
        margin-top: 8px;
        padding-left: 26px;
      }
      /* The line the leaves hang from. */
      .fleet-tree .fleet-tree::before {
        content: "";
        position: absolute;
        left: 11px;
        top: -4px;
        bottom: 14px;
        border-left: 1px solid #dcdcdc;
      }
      /* The tick into each leaf. */
      .fleet-tree .fleet-tree > li {
        position: relative;
      }
      .fleet-tree .fleet-tree > li::before {
        content: "";
        position: absolute;
        left: -15px;
        top: 17px;
        width: 14px;
        border-top: 1px solid #dcdcdc;
      }
      .fleet-tree .row {
        margin-bottom: 6px;
      }
      /* The primary holds the lease: it is the one that writes. */
      .fleet-row.primary .box {
        border: 2px solid #16a34a;
        padding: 7px 9px;
        background: #f0fdf4;
      }
      /* A space that is waiting to be admitted is drawn as an outline:
         it is not in the fleet yet. */
      .fleet-row.waiting .box {
        border-style: dashed;
        color: #666;
      }
      /* The card that is filled in to make a fleet is a row like the others,
         with a dashed box so it reads as not there yet. */
      .fleet-row.new .box {
        border-style: dashed;
      }
      .dlg-code {
        margin: 0 12px 14px;
        padding: 10px;
        border: 1px solid #111;
        background: #fafafa;
        font-size: 13px;
        word-break: break-all;
        user-select: all;
      }
      @media (max-width: 600px) {
        body {
          width: auto;
          margin: 24px 14px;
        }
      }
`;

/**
 * The Prime gateway favicon, shared by every page so /admin, /files and the
 * download page all show the same mark.
 */
export const FAVICON =
  "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2024%2024'%20fill='%23111111'%3E%3Cpath%20d='M15.688%202.343a2.588%202.588%200%2000-3.61%200l-9.626%209.44a.863.863%200%2001-1.203%200%20.823.823%200%20010-1.18l9.626-9.44a4.313%204.313%200%20016.016%200%204.116%204.116%200%20011.204%203.54%204.3%204.3%200%20013.609%201.18l.05.05a4.115%204.115%200%20010%205.9l-8.706%208.537a.274.274%200%20000%20.393l1.788%201.754a.823.823%200%20010%201.18.863.863%200%2001-1.203%200l-1.788-1.753a1.92%201.92%200%20010-2.754l8.706-8.538a2.47%202.47%200%20000-3.54l-.05-.049a2.588%202.588%200%2000-3.607-.003l-7.172%207.034-.002.002-.098.097a.863.863%200%2001-1.204%200%20.823.823%200%20010-1.18l7.273-7.133a2.47%202.47%200%2000-.003-3.537z'/%3E%3Cpath%20d='M14.485%204.703a.823.823%200%20000-1.18.863.863%200%2000-1.204%200l-7.119%206.982a4.115%204.115%200%20000%205.9%204.314%204.314%200%20006.016%200l7.12-6.982a.823.823%200%20000-1.18.863.863%200%2000-1.204%200l-7.119%206.982a2.588%202.588%200%2001-3.61%200%202.47%202.47%200%20010-3.54l7.12-6.982z'/%3E%3C/svg%3E";

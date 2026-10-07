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
      @media (max-width: 600px) {
        body {
          width: auto;
          margin: 24px 14px;
        }
      }
`;

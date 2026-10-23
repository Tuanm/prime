// The front page: Prime, with the three things it does. The full product page
// lives at /mcp; the pages themselves are /files (file sharing) and /sandbox
// (the browser sandbox).

import { FAVICON, UI_CSS } from "./ui-css";

export const HOME_HTML =
  "<!doctype html>" +
  '<html lang="en">' +
  "  <head>" +
  '    <meta charset="utf-8" />' +
  '    <meta name="viewport" content="width=device-width, initial-scale=1" />' +
  '    <meta name="referrer" content="no-referrer" />' +
  "    <title>Prime</title>" +
  '    <link rel="icon" href="' + FAVICON + '" />' +
  '    <link rel="preconnect" href="https://fonts.googleapis.com" />' +
  '    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />' +
  '    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet" />' +
  "    <style>" +
  UI_CSS +
  "      body { width: 640px; max-width: calc(100vw - 48px); margin: 72px auto; }" +
  "      .hero h1 { font-size: 40px; letter-spacing: -1px; margin-bottom: 10px; }" +
  "      .hero p { color: #555; font-size: 14px; max-width: 46ch; }" +
  "      .cards { display: flex; flex-direction: column; gap: 10px; margin-top: 32px; }" +
  "      .card { display: block; padding: 16px 18px; border: 1px solid #111; color: #111; text-decoration: none; }" +
  "      .card:hover { background: #f5f5f5; }" +
  "      .card .t { font-weight: 700; font-size: 14px; }" +
  "      .card .d { color: #666; font-size: 12px; margin-top: 4px; }" +
  "      .card .u { color: #999; font-size: 11px; margin-top: 8px; }" +
  "      footer { margin-top: 28px; font-size: 11px; color: #999; }" +
  "      footer a { color: #666; }" +
  "    </style>" +
  "  </head>" +
  "  <body>" +
  '    <div class="hero">' +
  "      <h1>Prime</h1>" +
  "      <p>Give AI agents your machine's files and shell as MCP tools - locally, or from anywhere.</p>" +
  "    </div>" +
  '    <div class="cards">' +
  '      <a class="card" href="/mcp">' +
  '        <div class="t">Devices and tools</div>' +
  '        <div class="d">Any machine becomes an MCP device: its files, shell and tools, reachable from any MCP client.</div>' +
  '        <div class="u">/mcp</div>' +
  "      </a>" +
  '      <a class="card" href="/files">' +
  '        <div class="t">File sharing</div>' +
  '        <div class="d">Devices park temporary files and hand out a link - optionally protected, always expiring.</div>' +
  '        <div class="u">/files</div>' +
  "      </a>" +
  '      <a class="card" href="/sandbox">' +
  '        <div class="t">Browser sandbox</div>' +
  '        <div class="d">Turn a browser tab into a device whose tools are JavaScript you write in the page, with a real UI.</div>' +
  '        <div class="u">/sandbox</div>' +
  "      </a>" +
  "    </div>" +
  "    <footer>See the <a href=\"/mcp\">overview</a> for how it works, or the <a href=\"https://github.com/Tuanm/prime\">source</a>.</footer>" +
  "  </body>" +
  "</html>\n";

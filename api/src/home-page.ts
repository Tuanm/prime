// The front page: Prime, with the three things it does. The full product page
// lives at /connect; the pages themselves are /files (file sharing) and /sandbox
// (the browser sandbox).

import { FAVICON } from "./ui-css";
import { LANDING_CSS } from "./landing-page";

const GITHUB_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';

export const HOME_HTML = (`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>Prime</title>
    <link rel="icon" href="__FAVICON__" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet" />
    <style>
__CSS__
      .cards { margin-top: 8px; }
      .card { display: block; padding: 10px 12px; margin-top: 8px; border: 1px solid #111; color: #111; text-decoration: none; }
      .card:hover { background: #f5f5f5; }
      .card .t { font-weight: 700; }
      .card .d { color: #666; font-size: 12px; margin-top: 2px; }
      .card .u { color: #999; font-size: 10px; margin-top: 6px; }
    </style>
  </head>
  <body>
    <h1>Prime</h1>
    <div class="sub">devices, files, sandbox</div>
    <p class="desc">A toolkit that turns a machine, a file and a browser into tools - with limits you set.</p>

    <div class="cards">
      <a class="card" href="/connect">
        <div class="t">Device Connect</div>
        <div class="d">Any machine becomes a device: its files, shell and tools, reachable from any MCP client.</div>
        <div class="u">/connect</div>
      </a>
      <a class="card" href="/files">
        <div class="t">File Share</div>
        <div class="d">Devices park temporary files and hand out a link - optionally protected, always expiring.</div>
        <div class="u">/files</div>
      </a>
      <a class="card" href="/sandbox">
        <div class="t">Sandbox</div>
        <div class="d">Tools you write in the page run in a locked-down frame, with no access to your pages, cookies or data.</div>
        <div class="u">/sandbox</div>
      </a>
      <a class="card" href="https://github.com/Tuanm/prime/blob/main/cli/README.md#spaces---disposable-or-persistent-codespaces">
        <div class="t">Codespaces</div>
        <div class="d">prime spaces create runs a rootless Linux container as a local device: disposable or persistent, with its own token and limits.</div>
        <div class="u">prime spaces</div>
      </a>
      <a class="card" href="https://github.com/Tuanm/prime/blob/main/cli/README.md#vaults-and-run">
        <div class="t">Vaults</div>
        <div class="d">Encrypted local values, secrets and TOTP codes, assigned to a space for its run tool.</div>
        <div class="u">prime vaults</div>
      </a>
    </div>

    <p class="meta"><a href="https://github.com/Tuanm/prime/releases">All releases</a></p>
    <div class="foot">
      <a href="https://github.com/Tuanm/prime" aria-label="Source on GitHub">__ICON__</a>
    </div>
  </body>
</html>
`).replace("__FAVICON__", FAVICON).replace("__CSS__", LANDING_CSS).replace("__ICON__", GITHUB_ICON);

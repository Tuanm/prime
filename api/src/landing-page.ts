// The public landing page: GET / on the gateway, and index.html on GitHub Pages
// (api/scripts/build-site.ts writes it out). One source for both.
//
// The page finds the newest prime release through the GitHub API at load time,
// so it never needs a rebuild for a new release.

import { FAVICON } from "./ui-css";

export const LANDING_HTML = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Device Connect</title>
    <meta name="description" content="Connect this machine as a device and use its files and shell as MCP tools - from anywhere." />
    <link rel="icon" href="__FAVICON__" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet" />
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { max-width: 560px; margin: 64px auto; padding: 0 20px; font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; color: #111; background: #fff; line-height: 1.5; }
      h1 { font-size: 22px; font-weight: 700; letter-spacing: 0.4px; margin-bottom: 4px; }
      .sub { font-size: 10px; color: #999; text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 20px; }
      .desc { margin-bottom: 26px; }
      .cg { position: relative; display: inline-flex; }
      .cg button { font: inherit; cursor: pointer; background: #111; color: #fff; border: 1px solid #111; }
      .cg button:hover { background: #000; }
      .cg .main { padding: 10px 22px; font-weight: 600; }
      .cg .chev { width: 38px; border-left-color: #555; display: inline-flex; align-items: center; justify-content: center; }
      .cg .chev svg { width: 12px; height: 12px; stroke: currentColor; fill: none; stroke-width: 2.4; transition: transform 0.12s; }
      .cg .chev[aria-expanded="true"] svg { transform: rotate(180deg); }
      .menu { display: none; position: absolute; top: calc(100% + 4px); left: 0; z-index: 10; min-width: 300px; background: #fff; border: 1px solid #111; padding: 4px 0; }
      .menu.open { display: block; }
      .menu button { position: relative; display: flex; width: 100%; justify-content: space-between; gap: 16px; padding: 7px 12px 7px 28px; background: #fff; color: #111; border: 0; text-align: left; font: inherit; font-size: 12px; cursor: pointer; }
      .menu button:hover, .menu button:focus { background: #f2f2f2; outline: none; }
      .menu button[aria-checked="true"] { font-weight: 700; }
      .menu button[aria-checked="true"]::before { content: "\2713"; position: absolute; left: 11px; }
      .menu button .hint { color: #999; font-weight: 400; }
      .menu .sep { border-top: 1px solid #eee; margin: 4px 0; }
      .target { margin-top: 8px; font-size: 11px; color: #666; min-height: 17px; }
      .guide { display: none; margin-top: 18px; border: 1px solid #111; padding: 14px 16px; font-size: 12px; }
      .guide.show { display: block; }
      .guide b { font-weight: 700; }
      .guide p { margin-top: 10px; }
      .guide p:first-child { margin-top: 0; }
      .code { position: relative; margin-top: 8px; }
      .code pre { background: #f5f5f5; border: 1px solid #ddd; padding: 10px 12px; padding-right: 64px; overflow-x: auto; font: inherit; font-size: 11.5px; white-space: pre; }
      .code .copy { position: absolute; top: 6px; right: 6px; font: inherit; font-size: 10px; padding: 3px 8px; background: #fff; border: 1px solid #ccc; cursor: pointer; }
      .code .copy:hover { border-color: #111; }
      .guide .hint { color: #666; }
      code { background: #f5f5f5; border: 1px solid #ddd; padding: 1px 4px; font-size: 12px; }
      .more { margin-top: 30px; font-size: 12px; }
      .more li { margin: 0 0 6px 18px; }
      .meta { margin-top: 26px; font-size: 10px; color: #999; }
      .meta a { color: #999; }
      .foot { margin-top: 14px; }
      .foot a { color: #999; display: inline-flex; align-items: center; }
      .foot a:hover { color: #111; }
      .foot svg { width: 18px; height: 18px; fill: currentColor; }
      @media (max-width: 420px) { .menu { min-width: 260px; } }
    </style>
  </head>
  <body>
    <h1>Device Connect</h1>
    <div class="sub">this machine as MCP tools, anywhere</div>
    <p class="desc">Connect this machine's files and shell as MCP tools - from anywhere. Download <b>prime</b>, run <code>prime connect</code>, and add the URL it prints to Claude Code, Codex or any MCP client.</p>

    <div class="cg" id="cg">
      <button type="button" class="main" id="connect">Connect</button>
      <button type="button" class="chev" id="chev" aria-haspopup="menu" aria-expanded="false" aria-label="Choose platform">
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 4l4 4 4-4" /></svg>
      </button>
      <div class="menu" id="menu" role="menu"></div>
    </div>
    <div class="target" id="target"></div>

    <div class="guide" id="guide"></div>

    <ul class="more">
      <li><code>prime connect</code> registers this machine as a device and serves its tools until you stop it.</li>
      <li><code>prime service install</code> keeps it running at every login.</li>
      <li><code>prime serve</code> exposes every connected device to a local MCP client.</li>
      <li><code>prime spaces create</code> runs a rootless Linux codespace as a local device.</li>
    </ul>

    <script>
      (function () {
        var REPO = "Tuanm/prime";
        var RELEASES = "https://github.com/" + REPO + "/releases";
        var PLATFORMS = [
          { id: "darwin-arm64", label: "macOS", hint: "Apple silicon", os: "mac" },
          { id: "darwin-x64", label: "macOS", hint: "Intel", os: "mac" },
          { id: "windows-x64", label: "Windows", hint: "x64", os: "win", ext: ".exe" },
          { id: "windows-arm64", label: "Windows", hint: "Arm", os: "win", ext: ".exe" },
          { id: "linux-x64", label: "Linux", hint: "x64", os: "linux" },
          { id: "linux-arm64", label: "Linux", hint: "Arm64", os: "linux" },
          { id: "bundle", label: "JS bundle", hint: "any OS with Bun", os: "bun" }
        ];
        var byId = {};
        PLATFORMS.forEach(function (p) { byId[p.id] = p; });

        var release = null; // { tag, version, assets: { name: { url, size } } }
        var picked = false;
        var current = byId[guess()] || byId["linux-x64"];

        var connectBtn = document.getElementById("connect");
        var chev = document.getElementById("chev");
        var menu = document.getElementById("menu");
        var targetEl = document.getElementById("target");
        var guide = document.getElementById("guide");

        // ---- platform detection ----------------------------------------------
        function guess() {
          var saved = null;
          try { saved = localStorage.getItem("code-mcp.platform"); } catch (e) {}
          if (saved && byId[saved]) { picked = true; return saved; }
          var ua = navigator.userAgent || "";
          var p = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "").toLowerCase();
          var arm = /aarch64|arm64|armv8/i.test(ua);
          if (/win/.test(p) || /Windows/.test(ua)) return arm ? "windows-arm64" : "windows-x64";
          // Every Mac browser reports "Intel Mac OS X"; most Macs are Apple silicon.
          if (/mac/.test(p) || /Macintosh/.test(ua)) return "darwin-arm64";
          if (/linux|x11|cros/.test(p) || /Linux/.test(ua)) return arm ? "linux-arm64" : "linux-x64";
          return "linux-x64";
        }

        // Chromium can tell the CPU apart (Apple silicon vs Intel, Arm Windows).
        if (!picked && navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
          navigator.userAgentData.getHighEntropyValues(["architecture"]).then(function (v) {
            if (picked || !v || !v.architecture) return;
            var arm = v.architecture === "arm";
            var os = current.os;
            var id = os === "mac" ? (arm ? "darwin-arm64" : "darwin-x64") : os === "win" ? (arm ? "windows-arm64" : "windows-x64") : os === "linux" ? (arm ? "linux-arm64" : "linux-x64") : current.id;
            select(byId[id], false);
          }).catch(function () {});
        }

        // ---- the newest prime release ------------------------------------------
        fetch("https://api.github.com/repos/" + REPO + "/releases?per_page=30", { headers: { accept: "application/vnd.github+json" } })
          .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
          .then(function (list) {
            for (var i = 0; i < list.length; i++) {
              var rel = list[i];
              if (rel.draft || rel.prerelease || !/^prime-v/.test(rel.tag_name || "")) continue;
              var assets = {};
              (rel.assets || []).forEach(function (a) { assets[a.name] = { url: a.browser_download_url, size: a.size }; });
              release = { tag: rel.tag_name, version: rel.tag_name.slice("prime-v".length), assets: assets, url: rel.html_url };
              break;
            }
            render();
          })
          .catch(function () { render(); });

        function assetName(p) {
          if (!release) return "";
          return p.id === "bundle" ? "prime-" + release.version + ".js" : "prime-" + release.version + "-" + p.id + (p.ext || "");
        }
        function asset(p) { return release ? release.assets[assetName(p)] : undefined; }
        function mb(n) { return (n / 1048576).toFixed(n < 1048576 ? 2 : 1) + " MB"; }
        function name(p) { return p.label + " (" + p.hint + ")"; }

        // ---- rendering --------------------------------------------------------
        function renderMenu() {
          menu.innerHTML = "";
          PLATFORMS.forEach(function (p, i) {
            if (p.id === "bundle") { var s = document.createElement("div"); s.className = "sep"; menu.appendChild(s); }
            var b = document.createElement("button");
            b.type = "button";
            b.setAttribute("role", "menuitemradio");
            b.setAttribute("aria-checked", p.id === current.id ? "true" : "false");
            b.dataset.id = p.id;
            var l = document.createElement("span"); l.textContent = p.label;
            var h = document.createElement("span"); h.className = "hint"; h.textContent = p.hint;
            b.appendChild(l); b.appendChild(h);
            b.addEventListener("click", function () { select(p, true); closeMenu(); connectBtn.focus(); });
            menu.appendChild(b);
          });
        }

        function render() {
          renderMenu();
          var a = asset(current);
          if (a) targetEl.textContent = "prime " + release.version + " for " + name(current) + " \u00b7 " + mb(a.size);
          else if (release) targetEl.textContent = "No " + name(current) + " build in prime " + release.version + " - see all releases.";
          else targetEl.textContent = "For " + name(current);
          var metaEl = document.getElementById("meta");
          if (metaEl) metaEl.innerHTML = release
            ? '<a href="' + release.url + '">mcp ' + release.version + '</a> \u00b7 <a href="' + RELEASES + '">all releases</a>'
            : '<a href="' + RELEASES + '">All releases</a>';
          if (guide.classList.contains("show")) showGuide();
        }

        function select(p, byUser) {
          current = p;
          if (byUser) {
            picked = true;
            try { localStorage.setItem("code-mcp.platform", p.id); } catch (e) {}
          }
          render();
        }

        // ---- guide ------------------------------------------------------------
        function block(text) {
          var wrap = document.createElement("div"); wrap.className = "code";
          var pre = document.createElement("pre"); pre.textContent = text;
          var copy = document.createElement("button"); copy.type = "button"; copy.className = "copy"; copy.textContent = "copy";
          copy.addEventListener("click", function () {
            (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () {
              copy.textContent = "copied"; setTimeout(function () { copy.textContent = "copy"; }, 1200);
            }, function () { copy.textContent = "select + copy"; });
          });
          wrap.appendChild(pre); wrap.appendChild(copy);
          return wrap;
        }
        function para(html) { var p = document.createElement("p"); p.innerHTML = html; return p; }

        function showGuide() {
          var file = assetName(current) || "prime";
          guide.innerHTML = "";
          guide.appendChild(para("<b>Then, in a terminal:</b>"));
          if (current.os === "win") {
            guide.appendChild(block(
              '$dir = "$env:LOCALAPPDATA\\Programs\\prime"\n' +
              'New-Item -ItemType Directory -Force $dir | Out-Null\n' +
              'Move-Item -Force "$HOME\\Downloads\\' + file + '" "$dir\\prime.exe"\n' +
              '& "$dir\\prime.exe" connect'));
            guide.appendChild(para('<span class="hint">PowerShell. Add <code>%LOCALAPPDATA%\\Programs\\prime</code> to your PATH to run <code>prime</code> from anywhere.</span>'));
          } else if (current.os === "bun") {
            guide.appendChild(block("bun ~/Downloads/" + file + " connect"));
            guide.appendChild(para('<span class="hint">Needs <a href="https://bun.sh">Bun</a>.</span>'));
          } else {
            var lines = ["cd ~/Downloads"];
            // A browser download is quarantined; Gatekeeper would refuse to run it.
            if (current.os === "mac") lines.push("xattr -d com.apple.quarantine " + file + " 2>/dev/null");
            lines.push("chmod +x " + file);
            lines.push("mkdir -p ~/.local/bin && mv " + file + " ~/.local/bin/prime");
            lines.push("~/.local/bin/prime connect");
            guide.appendChild(block(lines.join("\n")));
            guide.appendChild(para('<span class="hint">Add <code>~/.local/bin</code> to your PATH to run <code>prime</code> from anywhere.</span>'));
          }
          guide.appendChild(para("<code>prime connect</code> prints a device id, a 6-character device code and a <b>connect URL</b>. Add that URL to your MCP client, e.g.:"));
          guide.appendChild(block("claude mcp add --transport http my-machine '<connect URL>'"));
          guide.appendChild(para('<span class="hint">Keep the URL and code private: they give access to this machine\'s files and shell.</span>'));
          guide.classList.add("show");
        }

        // ---- events -----------------------------------------------------------
        connectBtn.addEventListener("click", function () {
          var a = asset(current);
          if (a) {
            var link = document.createElement("a");
            link.href = a.url;
            link.download = assetName(current);
            document.body.appendChild(link);
            link.click();
            link.remove();
          } else {
            window.open(release ? release.url : RELEASES, "_blank", "noopener");
          }
          showGuide();
        });

        function openMenu() {
          menu.classList.add("open");
          chev.setAttribute("aria-expanded", "true");
          var sel = menu.querySelector('[aria-checked="true"]');
          if (sel) sel.focus();
        }
        function closeMenu() {
          menu.classList.remove("open");
          chev.setAttribute("aria-expanded", "false");
        }
        chev.addEventListener("click", function (e) {
          e.stopPropagation();
          menu.classList.contains("open") ? closeMenu() : openMenu();
        });
        document.addEventListener("click", function (e) {
          if (!document.getElementById("cg").contains(e.target)) closeMenu();
        });
        document.addEventListener("keydown", function (e) {
          if (!menu.classList.contains("open")) return;
          var items = Array.prototype.slice.call(menu.querySelectorAll("button"));
          var i = items.indexOf(document.activeElement);
          if (e.key === "Escape") { closeMenu(); chev.focus(); }
          else if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
          else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
        });

        render();
      })();
    </script>
  </body>
</html>
`.replace("__FAVICON__", FAVICON);

/** The page's own stylesheet, reused by the front page so both look alike. */
export const LANDING_CSS = LANDING_HTML.slice(LANDING_HTML.indexOf("<style>") + 7, LANDING_HTML.indexOf("</style>"));

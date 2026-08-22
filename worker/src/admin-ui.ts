// Admin UI for the code-mcp gateway device registry. Served at GET /admin.
// Styled after the browser-mcp extension popup (minimal black/white,
// JetBrains Mono). The page is gated by Cloudflare Access at the edge; the
// API calls below additionally require the admin token (stored locally in
// the operator's browser).

export const ADMIN_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Admin</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap"
      rel="stylesheet"
    />
    <style>
      * {
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
    </style>
  </head>
  <body>
    <h1>Admin</h1>
    <div class="sub">device registry &middot; admin</div>

    <div class="row-head">
      <h2>Devices</h2>
      <button class="plus" id="addBtn" type="button" title="Add device">+</button>
    </div>
    <ul id="list"></ul>
    <div class="status" id="status"></div>

    <script>
      (function () {
        var listEl = document.getElementById("list");
        var statusEl = document.getElementById("status");
        var addBtn = document.getElementById("addBtn");
        function maskToken(t) {
          if (!t) return "";
          if (t.length <= 5) return "***";
          if (t.length <= 8) return t.charAt(0) + "***" + t.charAt(t.length - 1);
          if (t.length <= 12) return t.slice(0, 2) + "***" + t.slice(-2);
          return t.slice(0, 3) + "***" + t.slice(-3);
        }

        function setStatus(msg, isErr) {
          statusEl.textContent = msg || "";
          statusEl.style.color = isErr ? "#b91c1c" : "#666";
        }

        function api(path, opts) {
          opts = opts || {};
          var headers = {};
          var h = opts.headers || {};
          for (var k in h) headers[k] = h[k];
          if (opts.body) headers["content-type"] = "application/json";
          return fetch(path, { method: opts.method || "GET", headers: headers, body: opts.body }).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (j) {
              if (!r.ok) throw new Error((j && j.error) || ("HTTP " + r.status));
              return j;
            });
          });
        }

                // Unsaved rows created via "+" - preserved across re-renders so
        // typing is never lost.
        var devices = [];
        var pendingNew = [];

        function render() {
          listEl.innerHTML = "";
          if (!devices.length && !pendingNew.length) {
            var empty = document.createElement("li");
            empty.className = "empty";
            empty.textContent = "No devices registered. Click + to add one.";
            listEl.appendChild(empty);
            return;
          }
          devices.forEach(function (d) { renderRow(d, false, null); });
          pendingNew.forEach(function (p) { renderRow({ deviceId: p.id, token: p.token, online: false }, true, p); });
        }

        function renderRow(dev, isNew, pendingObj) {
          var li = document.createElement("li");
          li.className = "row";
          li.dataset.deviceId = dev.deviceId || "";

          // Status dot lives OUTSIDE the device box.
          var dot = document.createElement("span");
          dot.className = "dot " + (dev.online ? "on" : "off");

          var box = document.createElement("div");
          box.className = "box";

          var realToken = dev.token || "";
          var masked = maskToken(realToken);

          var idInput = document.createElement("input");
          idInput.className = "id-input";
          idInput.placeholder = "device id";
          idInput.value = dev.deviceId || "";

          var tokInput = document.createElement("input");
          tokInput.className = "tok-input";
          tokInput.type = "text";
          tokInput.value = isNew ? realToken : masked;
          tokInput.placeholder = "token";
          if (!isNew) {
            // Selecting the masked token on focus makes editing replace it.
            tokInput.addEventListener("focus", function () {
              if (tokInput.value === masked) tokInput.select();
            });
          }
          if (isNew && pendingObj) {
            // Keep the pending row in sync so a later re-render preserves it.
            idInput.addEventListener("input", function () { pendingObj.id = idInput.value; });
            tokInput.addEventListener("input", function () { pendingObj.token = tokInput.value; });
          }

          var menuWrap = document.createElement("span");
          menuWrap.className = "menu-wrap";
          var btn = document.createElement("button");
          btn.type = "button";
          btn.className = "menu-btn";
          btn.textContent = "⋮";
          var menu = document.createElement("span");
          menu.className = "menu";
          var toolsItem = document.createElement("button");
          toolsItem.type = "button";
          toolsItem.textContent = "Tools";
          var clientsItem = document.createElement("button");
          clientsItem.type = "button";
          clientsItem.textContent = "Clients";
          var saveItem = document.createElement("button");
          saveItem.type = "button";
          saveItem.textContent = "Save";
          var delItem = document.createElement("button");
          delItem.type = "button";
          delItem.className = "danger";
          delItem.textContent = "Delete";
          menu.appendChild(toolsItem);
          menu.appendChild(clientsItem);
          menu.appendChild(saveItem);
          menu.appendChild(delItem);
          menuWrap.appendChild(btn);
          menuWrap.appendChild(menu);

          box.appendChild(idInput);
          box.appendChild(tokInput);
          box.appendChild(menuWrap);
          li.appendChild(dot);
          li.appendChild(box);
          listEl.appendChild(li);

          function closeMenus() {
            var open = document.querySelectorAll(".menu.open");
            for (var i = 0; i < open.length; i++) open[i].classList.remove("open");
          }

          // Per-row state: online marker + dirty detection for the menu items.
          li.dataset.online = dev.online ? "1" : "0";
          var origId = dev.deviceId || "";
          var origToken = realToken;
          var maskedTok = masked;

          function isDirty() {
            var idChanged = idInput.value.trim() !== origId;
            var tok = tokInput.value.trim();
            var tokChanged = !(tok === maskedTok || tok === origToken);
            return idChanged || tokChanged;
          }

          function updateMenuState() {
            var online = li.dataset.online === "1";
            toolsItem.disabled = !online; // Tools needs a live tunnel
            clientsItem.disabled = !online; // Clients needs a live tunnel
            saveItem.disabled = !isDirty(); // Save only after the user edits
          }

          toolsItem.addEventListener("click", function () {
            closeMenus();
            if (li.dataset.online !== "1") return;
            showToolsDialog(idInput.value.trim() || dev.deviceId, realToken);
          });

          clientsItem.addEventListener("click", function () {
            closeMenus();
            if (li.dataset.online !== "1") return;
            showClientsDialog(idInput.value.trim() || dev.deviceId);
          });

          btn.addEventListener("click", function (e) {
            e.stopPropagation();
            var wasOpen = menu.classList.contains("open");
            closeMenus();
            updateMenuState();
            if (!wasOpen) menu.classList.add("open");
          });

          function dropPending() {
            if (pendingObj) {
              var ix = pendingNew.indexOf(pendingObj);
              if (ix >= 0) pendingNew.splice(ix, 1);
            }
          }

          saveItem.addEventListener("click", function () {
            closeMenus();
            var id = (idInput.value || "").trim();
            var tokVal = tokInput.value.trim();
            // Unchanged masked token means "keep the real token".
            if (!isNew && tokVal === masked) tokVal = realToken;
            if (!id) return setStatus("enter a device ID", true);
            if (!tokVal) return setStatus("enter a token", true);
            setStatus("saving " + id + " ...");
            function fail(e) { setStatus("save failed: " + e.message, true); }
            function done() {
              dropPending();
              setStatus("saved " + id);
              load();
            }
            var upsert = api("/admin/api/devices", { method: "POST", body: JSON.stringify({ deviceId: id, token: tokVal }) });
            if (!isNew && id !== dev.deviceId) {
              // ID changed on an existing device: create the new pair and
              // remove the old one (rename semantics).
              upsert.then(function () {
                return api("/admin/api/devices/" + encodeURIComponent(dev.deviceId), { method: "DELETE" });
              }).then(done).catch(fail);
            } else {
              upsert.then(done).catch(fail);
            }
          });

          delItem.addEventListener("click", function () {
            closeMenus();
            var id = (idInput.value || "").trim() || (dev.deviceId || "");
            if (!id) return setStatus("no device to delete", true);
            if (pendingObj) {
              // Unsaved row: just discard it locally.
              dropPending();
              render();
              setStatus("");
              return;
            }
            setStatus("deleting " + id + " ...");
            api("/admin/api/devices/" + encodeURIComponent(id), { method: "DELETE" })
              .then(function () {
                setStatus("deleted " + id);
                load();
              })
              .catch(function (e) { setStatus("delete failed: " + e.message, true); });
          });

          document.addEventListener("click", function handler(ev) {
            if (!menuWrap.contains(ev.target)) closeMenus();
            document.removeEventListener("click", handler);
          });
        }

        // Shared dialog scaffolding (black/white, JetBrains Mono vibe).
        function openDialog(title, deviceId) {
          var overlay = document.createElement("div");
          overlay.className = "overlay";
          overlay.innerHTML =
            '<div class="dlg">' +
            '<div class="dlg-head"><span>' + title + '</span><span class="dlg-id">' + deviceId + '</span>' +
            '<button type="button" class="dlg-close" title="Close">&times;</button></div>' +
            '<div class="dlg-body"><div class="dlg-msg">Loading&hellip;</div></div>' +
            "</div>";
          document.body.appendChild(overlay);
          var bodyEl = overlay.querySelector(".dlg-body");
          var closeBtn = overlay.querySelector(".dlg-close");
          function close() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
          closeBtn.addEventListener("click", close);
          overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
          return { overlay: overlay, bodyEl: bodyEl, close: close };
        }

        function ago(ts) {
          var sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
          if (sec < 5) return "just now";
          if (sec < 60) return sec + "s ago";
          var min = Math.floor(sec / 60);
          if (min < 60) return min + "m ago";
          return Math.floor(min / 60) + "h ago";
        }

        // List the device's tools, relayed through the gateway tunnel.
        function showToolsDialog(deviceId, token) {
          var d = openDialog("Tools", deviceId);
          fetch("/mcp/" + encodeURIComponent(deviceId), {
            method: "POST",
            headers: { "content-type": "application/json", "x-device-token": token },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
            signal: AbortSignal.timeout(20000),
          })
            .then(function (r) { return r.json().catch(function () { return {}; }); })
            .then(function (j) {
              var tools = j && j.result && j.result.tools;
              if (!tools) throw new Error((j && j.error && j.error.message) || "device did not respond");
              d.bodyEl.innerHTML = "";
              if (!tools.length) {
                d.bodyEl.innerHTML = '<div class="dlg-msg">No tools reported.</div>';
                return;
              }
              tools.forEach(function (t) {
                var el = document.createElement("div");
                el.className = "dlg-tool";
                var name = document.createElement("div");
                name.className = "t-name";
                name.textContent = t.name || "?";
                var desc = document.createElement("div");
                desc.className = "t-desc";
                desc.textContent = t.description || "";
                el.appendChild(name);
                el.appendChild(desc);
                d.bodyEl.appendChild(el);
              });
            })
            .catch(function (e) {
              d.bodyEl.innerHTML = '<div class="dlg-msg err">' + ((e && e.message) || "failed to load tools") + "</div>";
            });
        }

        // List the MCP clients currently relaying through this device.
        function showClientsDialog(deviceId) {
          var d = openDialog("Clients", deviceId);
          fetch("/admin/api/devices/" + encodeURIComponent(deviceId) + "/clients")
            .then(function (r) { return r.json().catch(function () { return {}; }); })
            .then(function (j) {
              var clients = j && j.clients;
              if (!clients) throw new Error((j && j.error) || "failed to load clients");
              d.bodyEl.innerHTML = "";
              if (!clients.length) {
                d.bodyEl.innerHTML = '<div class="dlg-msg">No clients connected.</div>';
                return;
              }
              clients.forEach(function (c) {
                var el = document.createElement("div");
                el.className = "dlg-tool";
                var name = document.createElement("div");
                name.className = "t-name";
                name.textContent = c.name || c.ip;
                var meta = document.createElement("div");
                meta.className = "t-desc";
                meta.textContent =
                  (c.name ? c.ip + " · " : "") +
                  c.count + " request" + (c.count === 1 ? "" : "s") +
                  " · " + ago(c.lastSeen);
                el.appendChild(name);
                el.appendChild(meta);
                d.bodyEl.appendChild(el);
              });
            })
            .catch(function (e) {
              d.bodyEl.innerHTML = '<div class="dlg-msg err">' + ((e && e.message) || "failed to load clients") + "</div>";
            });
        }

        function load() {
          return api("/admin/api/devices")
            .then(function (j) {
              devices = (j && j.devices) || [];
              render();
            })
            .catch(function (e) { setStatus("load failed: " + e.message, true); });
        }

        // Poll ONLY the status dots - never rebuild rows while the user is
        // typing (a rebuild would wipe in-progress edits and unsaved rows).
        function refreshDots() {
          api("/admin/api/devices")
            .then(function (j) {
              var map = {};
              (j.devices || []).forEach(function (d) { map[d.deviceId] = !!d.online; });
              var rows = listEl.querySelectorAll("li.row");
              for (var i = 0; i < rows.length; i++) {
                var id = rows[i].dataset.deviceId;
                var dot = rows[i].querySelector(".dot");
                var on = !!map[id];
                if (dot) dot.className = "dot " + (on ? "on" : "off");
                rows[i].dataset.online = on ? "1" : "0";
              }
            })
            .catch(function () {});
        }

        addBtn.addEventListener("click", function () {
          // Append ONLY the new row - do not rebuild existing rows, so any
          // in-progress edits elsewhere stay untouched.
          var empty = listEl.querySelector("li.empty");
          if (empty) empty.remove();
          var p = { id: "", token: "" };
          pendingNew.push(p);
          renderRow({ deviceId: "", token: "", online: false }, true, p);
        });

        load();
        setInterval(refreshDots, 5000);
      })();
    </script>
  </body>
</html>
`;
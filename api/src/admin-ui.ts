import { FAVICON, UI_CSS } from "./ui-css";

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
    <link rel="icon" href="${FAVICON}" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap"
      rel="stylesheet"
    />
    <style>
${UI_CSS}    </style>
  </head>
  <body>
    <h1>Admin</h1>
    <div class="sub">device registry &middot; admin<span id="count"></span></div>

    <div class="row-head">
      <h2>Usage this month</h2>
    </div>
    <div class="usage" id="usage"></div>

    <div class="row-head section">
      <h2>Fleets</h2>
      <button class="plus" id="fleetAddBtn" type="button" title="New fleet">+</button>
    </div>
    <ul id="fleetList"></ul>

    <div class="row-head section">
      <h2>Buddies</h2>
      <button class="plus" id="addBtn" type="button" title="Add a buddy">+</button>
    </div>
    <ul id="list"></ul>

    <div class="row-head section">
      <h2>Anonymous</h2>
    </div>
    <ul id="anonList"></ul>

    <div class="toasts" id="toasts"></div>

    <script>
      (function () {
        var listEl = document.getElementById("list");
        // (the old status line is a toast now: see toast() below)
        var addBtn = document.getElementById("addBtn");
        var anonListEl = document.getElementById("anonList");
        var countEl = document.getElementById("count");
        function maskToken(t) {
          if (!t) return "";
          if (t.length <= 5) return "***";
          if (t.length <= 8) return t.charAt(0) + "***" + t.charAt(t.length - 1);
          if (t.length <= 12) return t.slice(0, 2) + "***" + t.slice(-2);
          return t.slice(0, 3) + "***" + t.slice(-3);
        }

        var toastsEl = document.getElementById("toasts");

        /**
         * Say what happened, in a toast that leaves on its own.
         *
         * The sandbox page's toast, in the admin page's colours: a short note in
         * the corner, with a coloured edge for what it is. Several can be up at
         * once - a poll that fails while another message is showing does not
         * hide it - and each leaves after a few seconds.
         */
        function toast(text, variant) {
          var msg = String(text == null ? "" : text).slice(0, 300);
          if (!msg) return;
          var t = document.createElement("div");
          t.className = "toast " + (variant === "error" ? "error" : "success");
          t.textContent = msg;
          toastsEl.appendChild(t);
          // A few at a time is enough: the oldest goes when the list grows.
          while (toastsEl.children.length > 4) toastsEl.removeChild(toastsEl.children[0]);
          setTimeout(function () {
            t.classList.add("leaving");
            setTimeout(function () {
              if (t.parentNode) t.parentNode.removeChild(t);
            }, 300);
          }, variant === "error" ? 6000 : 3500);
        }

        function setStatus(msg, isErr) {
          toast(msg, isErr ? "error" : "success");
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
          if (!devices.length && !pendingNew.length && !fleets.length) {
            var empty = document.createElement("li");
            empty.className = "empty";
            empty.textContent = "No buddies yet. Click + to add one.";
            listEl.appendChild(empty);
            return;
          }
          // Pin virtual (cloud) devices to the top.
          var pinned = [], rest = [];
          devices.forEach(function (d) { (d.virtual ? pinned : rest).push(d); });
          pinned.forEach(function (d) { renderRow(d, false, null); });
          rest.forEach(function (d) { renderRow(d, false, null); });
          pendingNew.forEach(function (p) { renderRow({ deviceId: p.id, token: p.token, online: false }, true, p); });
          // A fleet is a buddy too: it answers to its own name, with a token
          // the operator sets here.
          fleets.forEach(fleetBuddyRow);
        }

        // The row a fleet gets in the list: the same shape a device has, with
        // the cloud a group is drawn with, and its own token for clients.
        function fleetBuddyRow(f) {
          var li = document.createElement("li");
          li.className = "row" + (f.disabled ? " disabled" : "");
          li.dataset.fleetBuddy = f.fleet;

          var cloud = document.createElement("span");
          // Filled: a token is set, so a client can reach the fleet. Hollow:
          // there is no way in.
          cloud.className = fleetCloudClass(f);
          cloud.title = f.disabled
            ? "a fleet of spaces, paused"
            : !f.buddy
              ? "no token is set, so no client can reach this fleet"
              : f.primary
                ? "a fleet of spaces, reached through " + f.primary
                : "no space holds the lease right now, so no client can reach this fleet";
          cloud.innerHTML = FLEET_CLOUD;

          var box = document.createElement("div");
          box.className = "box";
          var idInput = document.createElement("input");
          idInput.className = "id-input";
          idInput.readOnly = true;
          idInput.value = f.fleet;
          idInput.title = "the fleet, reached as a device of this name";
          var tokInput = document.createElement("input");
          tokInput.className = "tok-input";
          tokInput.placeholder = "token";
          // Masked, like every other token on the page: the whole of it is
          // handed over once, in the dialog Refresh token opens.
          var real = f.buddy || "";
          var masked = maskToken(real);
          tokInput.value = masked;
          tokInput.title = real
            ? "a token is set; Refresh token shows a new one"
            : "no token is set, so no client can reach this fleet";
          tokInput.addEventListener("focus", function () {
            if (tokInput.value === masked) tokInput.select();
          });

          var saveSpec = {
            text: "Save",
            disabled: true,
            onClick: function () { fleetBuddySave(f.fleet, tokInput.value.trim(), tokInput); },
          };
          var refreshSpec = {
            text: "Refresh token",
            onClick: function () { fleetBuddyRefresh(f.fleet); },
          };
          // The actions a buddy has. The fleet is reached through one of its
          // spaces, so they act on the one that holds the lease.
          var primary = null;
          (f.members || []).forEach(function (m) {
            if (m.deviceId === f.primary) primary = m;
          });
          var primaryPath = primary ? "/admin/api/devices/" + encodeURIComponent(primary.deviceId) : "";
          var items = [
            {
              text: "View",
              disabled: !primary,
              onClick: function () {
                showViewDialog(f.fleet, primaryPath + "/origin");
              },
            },
            {
              text: "Tools",
              disabled: !primary || !primary.online || !!primary.disabled,
              onClick: function () {
                showTools(f.fleet, fetch(primaryPath + "/tools", { method: "POST" }));
              },
            },
            {
              text: "Clients",
              disabled: !primary || !primary.online || !!primary.disabled,
              onClick: function () {
                showClientsDialog(primary.deviceId);
              },
            },
            saveSpec,
            {
              text: f.disabled ? "Activate" : "Deactivate",
              danger: !f.disabled,
              onClick: function () {
                fleetSaveMeta(f, null, !f.disabled);
              },
            },
            refreshSpec,
          ];
          tokInput.addEventListener("input", function () {
            var v = tokInput.value.trim();
            // Save only what would change it: the mask is not the token.
            saveSpec.el.disabled = v === "" || v === masked || v === real;
          });
          box.appendChild(idInput);
          box.appendChild(tokInput);
          box.appendChild(fleetMenu(items));
          li.appendChild(cloud);
          li.appendChild(box);
          listEl.appendChild(li);
        }

        /**
         * Whether a client can reach the fleet right now: it has a token of its
         * own, it is not paused, and one of its spaces holds the lease.
         */
        function fleetOpen(f) {
          return !f.disabled && !!f.buddy && !!f.primary;
        }

        /** The cloud says whether there is a way in. */
        function fleetCloudClass(f) {
          return "cloud-ic " + (fleetOpen(f) ? "on" : "off hollow");
        }

        /** A fresh token for a client to keep. */
        function randomToken() {
          var bytes = new Uint8Array(24);
          crypto.getRandomValues(bytes);
          var s = "";
          for (var i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
          return s;
        }

        function fleetBuddySave(fleet, token, field) {
          api("/admin/api/fleets/" + encodeURIComponent(fleet) + "/buddy", {
            method: "POST",
            body: JSON.stringify({ token: token }),
          })
            .then(function () {
              setStatus("saved the token for " + fleet);
              if (field) field.value = "";
              loadFleets();
            })
            .catch(function (e) { setStatus("could not save the token: " + e.message, true); });
        }

        // A fresh token, handed over once in a dialog the operator can copy
        // from - the card never shows it.
        function fleetBuddyRefresh(fleet) {
          var token = randomToken();
          api("/admin/api/fleets/" + encodeURIComponent(fleet) + "/buddy", {
            method: "POST",
            body: JSON.stringify({ token: token }),
          })
            .then(function () {
              var d = openDialog("Fleet token", fleet);
              d.bodyEl.innerHTML =
                '<div class="dlg-msg">A client reaches this fleet with this token. It replaces the one that was set, so a client still using the old one stops working.</div>' +
                '<div class="dlg-code">' +
                esc(token) +
                "</div>" +
                '<div class="dlg-msg"><button type="button" class="btn" id="copyFleetToken">Copy</button></div>';
              var copy = d.bodyEl.querySelector("#copyFleetToken");
              if (copy) {
                copy.addEventListener("click", function () {
                  var done = function () {
                    copy.textContent = "Copied";
                    setTimeout(function () {
                      copy.textContent = "Copy";
                    }, 1500);
                  };
                  if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(token).then(done, done);
                  } else {
                    done();
                  }
                });
              }
              setStatus("new token for " + fleet);
              loadFleets();
            })
            .catch(function (e) { setStatus("could not refresh the token: " + e.message, true); });
        }

        function renderRow(dev, isNew, pendingObj) {
          var li = document.createElement("li");
          li.className = "row" + (isNew ? " new" : "") + (dev.disabled ? " disabled" : "");
          li.dataset.deviceId = dev.deviceId || "";

          var virtual = !!dev.virtual;

          // Virtual devices show a cloud icon (active green / disabled gray)
          // instead of the tunnel status dot.
          var dot = null;
          if (virtual) {
            var cloud = document.createElement("span");
            cloud.className = "cloud-ic " + (dev.disabled ? "off" : "on");
            cloud.title = "cloud device (in-process)";
            cloud.innerHTML =
              '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"/></svg>';
          } else {
            // Status dot lives OUTSIDE the device box.
            dot = document.createElement("span");
            dot.className = "dot " + (dev.online ? "on" : "off");
          }

          var box = document.createElement("div");
          box.className = "box";

          var realToken = dev.token || "";
          var masked = maskToken(realToken);

          var idInput = document.createElement("input");
          idInput.className = "id-input";
          idInput.placeholder = "id";
          idInput.value = dev.deviceId || "";
          // Cloud devices are registry-managed: the id is read-only.
          if (virtual) idInput.readOnly = true;

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
          // What the row may do depends on what is in it.
          idInput.addEventListener("input", function () { updateMenuState(); });
          tokInput.addEventListener("input", function () { updateMenuState(); });

          var menuWrap = document.createElement("span");
          menuWrap.className = "menu-wrap";
          var btn = document.createElement("button");
          btn.type = "button";
          btn.className = "menu-btn";
          btn.textContent = "⋮";
          var menu = document.createElement("span");
          menu.className = "menu";
          var viewItem = document.createElement("button");
          viewItem.type = "button";
          viewItem.textContent = "View";
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
          // Every device can be Deactivated/Activated (a disabled device is
          // rejected with 403 at /mcp and /ws). Tunnel devices additionally
          // keep Delete (removes them from the registry entirely).
          var stateItem = document.createElement("button");
          stateItem.type = "button";
          stateItem.textContent = dev.disabled ? "Activate" : "Deactivate";
          if (!dev.disabled) stateItem.className = "danger";
          // A row that is being filled in has nothing to look at yet: it
          // offers Save, and Cancel to throw it away.
          var cancelItem = document.createElement("button");
          cancelItem.type = "button";
          cancelItem.textContent = "Cancel";
          if (isNew) {
            menu.appendChild(saveItem);
            menu.appendChild(cancelItem);
          } else {
            menu.appendChild(viewItem);
            menu.appendChild(toolsItem);
            menu.appendChild(clientsItem);
            menu.appendChild(saveItem);
            menu.appendChild(stateItem);
            if (!virtual) menu.appendChild(delItem);
          }
          menuWrap.appendChild(btn);
          menuWrap.appendChild(menu);

          box.appendChild(idInput);
          box.appendChild(tokInput);
          box.appendChild(menuWrap);
          if (cloud) li.appendChild(cloud); // virtual devices render a cloud icon
          if (dot) li.appendChild(dot); // tunnel devices render a status dot
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

          cancelItem.addEventListener("click", function () {
            closeMenus();
            if (pendingObj) {
              dropPending();
              render();
              setStatus("");
            }
          });

          function isDirty() {
            var idChanged = idInput.value.trim() !== origId;
            var tok = tokInput.value.trim();
            var tokChanged = !(tok === maskedTok || tok === origToken);
            return idChanged || tokChanged;
          }

          function updateMenuState() {
            var online = li.dataset.online === "1";
            toolsItem.disabled = !online; // Tools needs a live tunnel
            clientsItem.disabled = virtual || !online; // Clients needs a live tunnel
            // Save does nothing until there is something to save: an edited
            // device, or a new one with a name and a token to give it.
            saveItem.disabled = isNew
              ? !idInput.value.trim() || !tokInput.value.trim()
              : !isDirty();
          }
          // Start in the right state, not only after the menu is opened.
          updateMenuState();

          viewItem.addEventListener("click", function () {
            closeMenus();
            var id = idInput.value.trim() || dev.deviceId;
            showViewDialog(id, "/admin/api/devices/" + encodeURIComponent(id) + "/origin");
          });

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
            // An id change on an existing device is a rename: the registry swaps
            // the old entry for the new one in a single step, so it also works
            // when the gateway is at its device limit.
            var payload = { deviceId: id, token: tokVal };
            if (!isNew && id !== dev.deviceId) payload.replaces = dev.deviceId;
            api("/admin/api/devices", { method: "POST", body: JSON.stringify(payload) }).then(done).catch(fail);
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
            confirmDialog(
              "Delete device",
              "Delete the device " + id + "? Its tunnel is dropped, and a client that still has its id and token stops working.",
              "Delete",
              function () {
                setStatus("deleting " + id + " ...");
                api("/admin/api/devices/" + encodeURIComponent(id), { method: "DELETE" })
                  .then(function () {
                    setStatus("deleted " + id);
                    load();
                  })
                  .catch(function (e) { setStatus("delete failed: " + e.message, true); });
              },
              true,
            );
          });

          if (stateItem) {
            stateItem.addEventListener("click", function () {
              closeMenus();
              var id = (idInput.value || "").trim() || (dev.deviceId || "");
              if (!id) return setStatus("no device to toggle", true);
              var turningOff = !dev.disabled; // current state decides the action
              setStatus((turningOff ? "deactivating " : "activating ") + id + " ...");
              api("/admin/api/devices/" + encodeURIComponent(id) + "/state", {
                method: "POST",
                body: JSON.stringify({ disabled: turningOff }),
              })
                .then(function () {
                  setStatus((turningOff ? "deactivated " : "activated ") + id);
                  load();
                })
                .catch(function (e) { setStatus("state change failed: " + e.message, true); });
            });
          }

          document.addEventListener("click", function handler(ev) {
            if (!menuWrap.contains(ev.target)) closeMenus();
            document.removeEventListener("click", handler);
          });
        }

        // Shared dialog scaffolding (black/white, JetBrains Mono vibe).
        /**
         * Ask a question in the page's own dialog.
         *
         * The browser's confirm() blocks the page, cannot be styled, and reads
         * as a warning from the browser rather than a decision by the page. This
         * is the same dialog the page shows everywhere else.
         */
        function confirmDialog(title, message, confirmLabel, onConfirm, danger) {
          var d = openDialog(title, "");
          // One main answer and one way out. The main one is filled in - black for
          // what it does, red for a decision that loses something.
          d.bodyEl.innerHTML =
            '<div class="dlg-msg">' +
            esc(message) +
            "</div>" +
            '<div class="dlg-actions">' +
            '<button type="button" class="btn secondary" id="confirmNo">Cancel</button>' +
            '<button type="button" class="btn' +
            (danger ? " danger" : "") +
            '" id="confirmYes">' +
            esc(confirmLabel) +
            "</button>" +
            "</div>";
          var yes = d.bodyEl.querySelector("#confirmYes");
          var no = d.bodyEl.querySelector("#confirmNo");
          if (yes) {
            yes.addEventListener("click", function () {
              d.close();
              onConfirm();
            });
          }
          if (no) no.addEventListener("click", d.close);
          if (yes) yes.focus();
          return d;
        }

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
          function onKey(e) {
            if (e.key === "Escape") {
              e.preventDefault();
              close();
            }
          }
          function close() {
            document.removeEventListener("keydown", onKey, true);
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
          }
          closeBtn.addEventListener("click", close);
          // Escape closes it; clicking the backdrop does not, so a mis-click on
          // the way to a button never throws away what is in the dialog.
          document.addEventListener("keydown", onKey, true);
          return { overlay: overlay, bodyEl: bodyEl, close: close };
        }

        // Escape untrusted text before it can reach innerHTML: device-supplied
        // error messages could otherwise inject markup into the admin page.
        function esc(s) {
          return String(s == null ? "" : s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
        }

        function ago(ts) {
          var sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
          if (sec < 5) return "just now";
          if (sec < 60) return sec + "s ago";
          var min = Math.floor(sec / 60);
          if (min < 60) return min + "m ago";
          return Math.floor(min / 60) + "h ago";
        }

        // Where a device connects from: address, location, network, user agent -
        // and one button to block that address (or lift the block).
        function showViewDialog(label, originPath) {
          var d = openDialog("View", esc(label));
          function row(name, value) {
            var el = document.createElement("div");
            el.className = "dlg-tool";
            var n = document.createElement("div");
            n.className = "t-name";
            n.textContent = name;
            var v = document.createElement("div");
            v.className = "t-desc";
            v.textContent = value;
            el.appendChild(n);
            el.appendChild(v);
            return el;
          }
          function paint(info) {
            d.bodyEl.innerHTML = "";
            var o = info.origin;
            if (!o) {
              d.bodyEl.appendChild(row("Status", info.online ? "connected (no origin recorded)" : "not connected"));
              d.bodyEl.appendChild(row("Note", "The address is known only while the device is connected - open View again while it is online."));
            } else {
              d.bodyEl.appendChild(row("Status", info.online ? "connected" : "not connected"));
              d.bodyEl.appendChild(row("IP address", String(o.ip || "unknown")));
              var where = [o.city, o.region, o.country].filter(Boolean).join(", ");
              if (where) d.bodyEl.appendChild(row("Location", where + (o.colo ? " - " + String(o.colo) + " edge" : "")));
              if (o.as) d.bodyEl.appendChild(row("Network", String(o.as) + (o.asn ? " (AS" + String(o.asn) + ")" : "")));
              if (o.ua) d.bodyEl.appendChild(row("User agent", String(o.ua)));
              if (o.at) d.bodyEl.appendChild(row("Connected at", new Date(String(o.at)).toLocaleString()));
              if (info.block_key) d.bodyEl.appendChild(row("Block key", String(info.block_key) + (info.blocked ? "  (blocked)" : "")));
            }
            var bar = document.createElement("div");
            bar.className = "dlg-bar";
            if (o && info.block_key) {
              var btn = document.createElement("button");
              btn.type = "button";
              btn.className = "btn" + (info.blocked ? "" : " danger");
              btn.textContent = info.blocked ? "Unblock" : "Block";
              btn.title = info.blocked
                ? "Let this address connect again"
                : "Refuse every request from this address (device or MCP client); the admin page stays reachable";
              btn.addEventListener("click", function () {
                btn.disabled = true;
                api("/admin/api/blocked", { method: "POST", body: JSON.stringify({ ip: String(o.ip), blocked: !info.blocked }) })
                  .then(function () { setStatus((info.blocked ? "unblocked " : "blocked ") + String(o.ip)); loadView(); load(); })
                  .catch(function (e) { btn.disabled = false; setStatus("block failed: " + e.message, true); });
              });
              bar.appendChild(btn);
            }
            d.bodyEl.appendChild(bar);
          }
          function loadView() {
            fetch(originPath)
              .then(function (r) { return r.json().catch(function () { return {}; }); })
              .then(paint)
              .catch(function (e) { d.bodyEl.innerHTML = '<div class="dlg-msg err">' + esc((e && e.message) || "failed to load") + "</div>"; });
          }
          loadView();
        }

        // List the device's tools, relayed through the gateway tunnel.
        function showToolsDialog(deviceId, token) {
          showTools(deviceId, fetch("/mcp/" + encodeURIComponent(deviceId), {
            method: "POST",
            headers: { "content-type": "application/json", "x-device-token": token },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
            signal: AbortSignal.timeout(20000),
          }));
        }

        // Anonymous devices: the gateway relays tools/list itself, so the
        // device code never reaches this page.
        function showAnonToolsDialog(ref, label) {
          showTools(label, fetch("/admin/api/anonymous/" + ref + "/tools", { method: "POST", signal: AbortSignal.timeout(20000) }));
        }

        function showTools(title, request) {
          var d = openDialog("Tools", esc(title));
          request
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
              d.bodyEl.innerHTML = '<div class="dlg-msg err">' + esc((e && e.message) || "failed to load tools") + "</div>";
            });
        }

        // List the MCP clients currently relaying through this device.
        function showClientsDialog(deviceId) {
          showClients(deviceId, "/admin/api/devices/" + encodeURIComponent(deviceId) + "/clients");
        }

        function showClients(title, path) {
          var d = openDialog("Clients", esc(title));
          fetch(path)
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
              d.bodyEl.innerHTML = '<div class="dlg-msg err">' + esc((e && e.message) || "failed to load clients") + "</div>";
            });
        }

        function showCount(j) {
          if (j && typeof j.count === "number" && typeof j.max_devices === "number") {
            countEl.textContent = " \u00b7 " + j.count + " / " + j.max_devices + " devices";
          }
        }

        function load() {
          loadAnon();
          loadFleets();
          return api("/admin/api/devices")
            .then(function (j) {
              devices = (j && j.devices) || [];
              showCount(j);
              render();
            })
            .catch(function (e) { setStatus("load failed: " + e.message, true); });
        }

        // ---- fleets ----
        // A fleet is a group of spaces that keep each other in step. The
        // operator sets them up here: the fleet is created, the spaces ask to
        // join with an invite code, and the operator admits them. The member
        // that holds the lease is the primary: it is the one that writes.
        var fleetListEl = document.getElementById("fleetList");
        var fleetAddBtn = document.getElementById("fleetAddBtn");
        var fleets = [];
        // The fleets being set up, kept across re-renders so that typing is
        // never lost.
        var pendingFleets = [];

        // An action button: the thing it does is on it, and its weight says how
        // much it matters - "primary" for the main one, "danger" for one that
        // loses something, nothing for the way out.
        function fleetBtn(text, onClick, variant) {
          var b = document.createElement("button");
          b.type = "button";
          b.className = "fleet-btn" + (variant ? " " + variant : "");
          b.textContent = text;
          b.addEventListener("click", onClick);
          return b;
        }

        // The menu of a row, the way the device rows do it: a button that
        // opens a list of actions.
        function fleetMenu(items) {
          var wrap = document.createElement("span");
          wrap.className = "menu-wrap";
          var btn = document.createElement("button");
          btn.type = "button";
          btn.className = "menu-btn";
          btn.textContent = "\u22ee";
          var menu = document.createElement("span");
          menu.className = "menu";
          items.forEach(function (spec) {
            // The row keeps the button so it can switch it off while the
            // action would do nothing (Save with nothing changed).
            var b = document.createElement("button");
            b.type = "button";
            b.textContent = spec.text;
            if (spec.danger) b.className = "danger";
            if (spec.disabled) b.disabled = true;
            spec.el = b;
            b.addEventListener("click", function (e) {
              e.stopPropagation();
              closeFleetMenus();
              spec.onClick();
            });
            menu.appendChild(b);
          });
          btn.addEventListener("click", function (e) {
            e.stopPropagation();
            var wasOpen = menu.classList.contains("open");
            closeFleetMenus();
            if (!wasOpen) menu.classList.add("open");
          });
          wrap.appendChild(btn);
          wrap.appendChild(menu);
          document.addEventListener("click", function handler(ev) {
            if (!wrap.contains(ev.target)) closeFleetMenus();
            document.removeEventListener("click", handler);
          });
          return wrap;
        }

        function closeFleetMenus() {
          var open = document.querySelectorAll(".menu.open");
          for (var i = 0; i < open.length; i++) open[i].classList.remove("open");
        }


        // The mark of a fleet: the cloud, the same one a cloud device has.
        var FLEET_CLOUD =
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"/></svg>';

        function fleetName(m) {
          return m.label || m.deviceId || "?";
        }

        function fleetRender() {
          fleetListEl.innerHTML = "";
          if (!fleets.length && !pendingFleets.length) {
            var empty = document.createElement("li");
            empty.className = "empty";
            empty.textContent = "No fleets yet. Click + to create one.";
            fleetListEl.appendChild(empty);
            return;
          }
          fleets.forEach(fleetCard);
          // The cards that are being filled in are appended here: forEach
          // throws away what the function returns.
          pendingFleets.forEach(function (pending) {
            fleetListEl.appendChild(fleetNewCard(pending));
          });
        }

        // The card that is filled in to make a new fleet: the same row the
        // device list opens, with the name to type into.
        function fleetNewCard(pending) {
          // There is nothing to create until a name is typed.
          var createSpec = {
            text: "Create",
            disabled: !(pending.name || "").trim(),
            onClick: function () {
              fleetCreate(pending);
            },
          };
          var row = fleetRootRow(
            { name: pending.name || "" },
            [
              createSpec,
              {
                text: "Cancel",
                onClick: function () {
                  fleetDrop(pending);
                },
              },
            ],
            true
          );
          row.input.addEventListener("input", function () {
            pending.name = row.input.value;
            createSpec.el.disabled = !row.input.value.trim();
          });
          row.input.addEventListener("keydown", function (e) {
            if (e.key === "Enter") fleetCreate(pending);
          });
          var branch = document.createElement("li");
          branch.className = "fleet-tree fleet-branch";
          branch.appendChild(row.li);
          return branch;
        }

        function fleetDrop(pending) {
          var i = pendingFleets.indexOf(pending);
          if (i >= 0) pendingFleets.splice(i, 1);
          fleetRender();
        }

        function fleetCard(f) {
          var members = f.members || [];
          var pending = f.pending || [];

          // The fleet is the root of the tree: a row of the device list, with
          // the spaces in it as the leaves below.
          // Save does nothing until the name is changed, so it stays off.
          var saveSpec = {
            text: "Save",
            disabled: true,
            onClick: function () {
              fleetSaveMeta(f, row.input.value);
            },
          };
          var row;
          row = fleetRootRow(
            f,
            [
              saveSpec,
              {
                text: f.disabled ? "Activate" : "Deactivate",
                danger: !f.disabled,
                onClick: function () {
                  fleetSaveMeta(f, null, !f.disabled);
                },
              },
              {
                text: "Invite",
                onClick: function () {
                  fleetInvite(f.fleet);
                },
              },
              {
                text: "Delete",
                danger: true,
                onClick: function () {
                  fleetDelete(f.fleet);
                },
              },
            ],
            false
          );
          var li = row.li;
          // Save is offered only when the name has been changed.
          row.input.addEventListener("input", function () {
            saveSpec.el.disabled = row.input.value.trim() === (f.label || f.fleet);
          });

          // The spaces hang from the fleet as the leaves of a tree: the
          // primary first, then the mirrors in the order they came.
          var ordered = members.slice().sort(function (a, b) {
            var ap = a.deviceId === f.primary ? 0 : 1;
            var bp = b.deviceId === f.primary ? 0 : 1;
            if (ap !== bp) return ap - bp;
            return (a.addedAt || 0) - (b.addedAt || 0);
          });
          var leaves = document.createElement("ul");
          leaves.className = "fleet-tree";
          ordered.forEach(function (m) {
            var leaf = document.createElement("li");
            leaf.appendChild(fleetNode(f.fleet, m, m.deviceId === f.primary));
            leaves.appendChild(leaf);
          });
          pending.forEach(function (p) {
            var leaf = document.createElement("li");
            leaf.appendChild(fleetPendingNode(f.fleet, p));
            leaves.appendChild(leaf);
          });

          // The fleet card is the root; the leaves are below it, outside it.
          // The branch is a tree, so the lines are drawn between the root
          // and the leaves.
          var branch = document.createElement("li");
          branch.className = "fleet-tree fleet-branch";
          branch.appendChild(li);
          branch.appendChild(leaves);
          fleetListEl.appendChild(branch);
        }

        // A root row: the fleet, or the card that is filled in to make one.
        // It is a row of the device list, the same as the spaces below it,
        // with a cloud instead of the status dot: a fleet is a group.
        function fleetRootRow(fleet, items, isNew) {
          var li = document.createElement("li");
          li.className = "row fleet-row" + (isNew ? " new" : "") + (fleet.disabled ? " disabled" : "");
          var cloud = document.createElement("span");
          cloud.className = isNew ? "cloud-ic off hollow" : fleetCloudClass(fleet);
          cloud.title = isNew ? "a new fleet" : "a fleet of spaces";
          cloud.innerHTML = FLEET_CLOUD;
          var box = document.createElement("div");
          box.className = "box";

          var nameInput = document.createElement("input");
          nameInput.className = "id-input";
          nameInput.placeholder = isNew ? "fleet name" : "a name for the fleet";
          nameInput.value = isNew ? fleet.name || "" : fleet.label || fleet.fleet || "";
          nameInput.title = isNew ? "" : "the fleet " + fleet.fleet;

          box.appendChild(nameInput);
          box.appendChild(fleetMenu(items));
          li.appendChild(cloud);
          li.appendChild(box);
          return { li: li, input: nameInput };
        }

        // A space in the fleet, drawn as a row of the device list: the status
        // outside, the box with the name and the device id, and the actions in
        // the menu.
        function fleetNode(fleet, m, isPrimary) {
          var li = document.createElement("li");
          li.className = "row fleet-row" + (isPrimary ? " primary" : "") + (m.disabled ? " disabled" : "");
          var dot = document.createElement("span");
          dot.className = "dot " + (m.online ? "on" : "off");
          var box = document.createElement("div");
          box.className = "box";

          var nameInput = document.createElement("input");
          nameInput.className = "id-input";
          nameInput.readOnly = true;
          nameInput.value = fleetName(m);
          nameInput.title = isPrimary
            ? "the primary: it holds the lease, so it is the one that writes"
            : m.role === "owner"
              ? "the owner of the fleet"
              : "a member of the fleet";

          // The space is a device, so it has the actions a device has.
          var menu = fleetMenu([
            {
              text: "View",
              onClick: function () {
                showViewDialog(fleetName(m), "/admin/api/devices/" + encodeURIComponent(m.deviceId) + "/origin");
              },
            },
            {
              text: "Tools",
              disabled: !m.online || m.disabled,
              onClick: function () {
                showTools(fleetName(m), fetch("/admin/api/devices/" + encodeURIComponent(m.deviceId) + "/tools", { method: "POST" }));
              },
            },
            {
              text: "Clients",
              disabled: !m.online || m.disabled,
              onClick: function () {
                showClientsDialog(m.deviceId);
              },
            },
            {
              text: m.disabled ? "Activate" : "Deactivate",
              danger: !m.disabled,
              onClick: function () {
                fleetDeviceState(m);
              },
            },
            {
              text: "Remove",
              danger: true,
              onClick: function () {
                fleetAction(fleet, "remove", { deviceId: m.deviceId }, "removed " + fleetName(m));
              },
            },
          ]);

          box.appendChild(nameInput);
          box.appendChild(menu);
          li.appendChild(dot);
          li.appendChild(box);
          return li;
        }

        // A space that asked to join: the same row, with the two answers in
        // the menu.
        function fleetPendingNode(fleet, p) {
          var li = document.createElement("li");
          li.className = "row fleet-row waiting";
          var dot = document.createElement("span");
          dot.className = "dot " + (p.online ? "on" : "off");
          var box = document.createElement("div");
          box.className = "box";

          var nameInput = document.createElement("input");
          nameInput.className = "id-input";
          nameInput.readOnly = true;
          nameInput.value = p.label || "a device";
          nameInput.title = "waiting to be admitted";

          // The answers the operator has to give are shown, not tucked away.
          var answers = document.createElement("span");
          answers.className = "fleet-actions";
          answers.appendChild(fleetBtn("Admit", function () {
            fleetAction(fleet, "approve", { deviceId: p.deviceId }, "admitted " + (p.label || p.deviceId));
          }, "primary"));
          answers.appendChild(fleetBtn("Decline", function () {
            fleetAction(fleet, "remove", { deviceId: p.deviceId }, "declined " + (p.label || p.deviceId));
          }, "danger"));

          box.appendChild(nameInput);
          box.appendChild(answers);
          li.appendChild(dot);
          li.appendChild(box);
          return li;
        }

        // A space is a device: the operator can switch it off and on.
        function fleetDeviceState(m) {
          var disabled = !m.disabled;
          setStatus((disabled ? "deactivating " : "activating ") + fleetName(m) + " ...");
          api("/admin/api/devices/" + encodeURIComponent(m.deviceId) + "/state", {
            method: "POST",
            body: JSON.stringify({ disabled: disabled }),
          })
            .then(function () {
              setStatus((disabled ? "deactivated " : "activated ") + fleetName(m));
              loadFleets();
            })
            .catch(function (e) { setStatus("could not change the state: " + e.message, true); });
        }

        function fleetCreate(pending) {
          var name = (pending.name || "").trim();
          if (!name) {
            setStatus("enter a name for the fleet", true);
            return;
          }
          if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) {
            setStatus("that is not a fleet name: a-z, 0-9 and dashes, up to 32 characters", true);
            return;
          }
          api("/admin/api/fleets/" + encodeURIComponent(name), { method: "POST", body: "{}" })
            .then(function () {
              setStatus("created fleet " + name);
              fleetDrop(pending);
              loadFleets();
            })
            .catch(function (e) { setStatus("could not create the fleet: " + e.message, true); });
        }

        // The + button opens the card that is filled in to make a fleet.
        function fleetAddCard() {
          var pending = { name: "" };
          pendingFleets.push(pending);
          fleetRender();
          var inputs = fleetListEl.querySelectorAll(".fleet-row .id-input");
          var last = inputs[inputs.length - 1];
          if (last) last.focus();
        }

        // What the operator decided about the fleet itself: its name, or
        // whether it takes part in anything.
        function fleetSaveMeta(f, label, disabled) {
          var patch = {};
          if (label !== null && label !== undefined) patch.label = String(label).trim();
          if (disabled !== undefined) patch.disabled = disabled;
          api("/admin/api/fleets/" + encodeURIComponent(f.fleet) + "/meta", {
            method: "POST",
            body: JSON.stringify(patch),
          })
            .then(function () {
              setStatus(disabled !== undefined ? (disabled ? "paused " : "resumed ") + f.fleet : "saved " + f.fleet);
              loadFleets();
            })
            .catch(function (e) { setStatus("could not change the fleet: " + e.message, true); });
        }

        function fleetInvite(fleet) {
          api("/admin/api/fleets/" + encodeURIComponent(fleet) + "/invite", { method: "POST", body: "{}" })
            .then(function (j) {
              var d = openDialog("Invite code", fleet);
              var expires = j.expiresAt ? Math.max(0, Math.round((j.expiresAt - Date.now()) / 1000)) : 0;
              d.bodyEl.innerHTML =
                '<div class="dlg-msg">This code admits one space to the fleet. It expires in ' +
                expires +
                ' seconds.</div>' +
                '<div class="dlg-code">' +
                esc(j.code || "") +
                "</div>" +
                '<div class="dlg-msg"><button type="button" class="btn" id="copyInvite">Copy</button></div>';
              var copy = d.bodyEl.querySelector("#copyInvite");
              if (copy) {
                copy.addEventListener("click", function () {
                  var code = j.code || "";
                  var done = function () {
                    copy.textContent = "Copied";
                    setTimeout(function () {
                      copy.textContent = "Copy";
                    }, 1500);
                  };
                  if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(code).then(done, done);
                  } else {
                    done();
                  }
                });
              }
            })
            .catch(function (e) { setStatus("could not mint an invite: " + e.message, true); });
        }

        function fleetDelete(fleet) {
          confirmDialog(
            "Delete fleet",
            "Delete the fleet " + fleet + "? The spaces in it are not touched.",
            "Delete",
            function () { fleetDeleteNow(fleet); },
            true,
          );
        }

        function fleetDeleteNow(fleet) {
          api("/admin/api/fleets/" + encodeURIComponent(fleet), { method: "DELETE" })
            .then(function () {
              setStatus("deleted fleet " + fleet);
              loadFleets();
            })
            .catch(function (e) { setStatus("could not delete the fleet: " + e.message, true); });
        }

        function fleetAction(fleet, step, body, what, danger) {
          api("/admin/api/fleets/" + encodeURIComponent(fleet) + "/" + step, {
            method: "POST",
            body: JSON.stringify(body),
          })
            .then(function () {
              setStatus(what);
              loadFleets();
            })
            .catch(function (e) { setStatus("could not " + step + ": " + e.message, true); });
        }

        function loadFleets() {
          return api("/admin/api/fleets")
            .then(function (j) {
              fleets = (j && j.fleets) || [];
              fleetRender();
              // The fleets are rows of the list above as well.
              render();
            })
            .catch(function (e) { setStatus("could not load the fleets: " + e.message, true); });
        }

        // ---- anonymous devices ----
        // Same row and menu as a registered device, but read-only: the id and
        // the code are never sent to this page. Rows are addressed by an opaque
        // ref the gateway resolves server-side.
        var anonDevices = [];
        var anonSignature = "";

        // A short UUID-style handle (no spaces). It comes from the opaque ref,
        // not the device id, which this page never receives.
        function anonLabel(d) {
          return d.ref.slice(0, 8);
        }

        function renderAnon() {
          anonListEl.innerHTML = "";
          if (!anonDevices.length) {
            var empty = document.createElement("li");
            empty.className = "empty";
            empty.textContent = "No anonymous devices.";
            anonListEl.appendChild(empty);
            return;
          }
          anonDevices.forEach(renderAnonRow);
        }

        function renderAnonRow(dev) {
          var li = document.createElement("li");
          li.className = "row" + (dev.disabled ? " disabled" : "");
          li.dataset.ref = dev.ref;
          var dot = document.createElement("span");
          dot.className = "dot " + (dev.online ? "on" : "off");
          var box = document.createElement("div");
          box.className = "box";
          var label = anonLabel(dev);

          var idInput = document.createElement("input");
          idInput.className = "id-input";
          idInput.readOnly = true;
          idInput.value = label;
          idInput.title =
            "created " + ago(dev.createdAt) +
            (dev.lastSeenAt ? " \u00b7 last seen " + ago(dev.lastSeenAt) : " \u00b7 never connected") +
            (dev.locked ? " \u00b7 locked after failed attempts" : "");
          var tokInput = document.createElement("input");
          tokInput.className = "tok-input";
          tokInput.readOnly = true;
          tokInput.value = "\u2022\u2022\u2022\u2022\u2022\u2022";
          tokInput.title = "the device code is not shown";

          var menuWrap = document.createElement("span");
          menuWrap.className = "menu-wrap";
          var btn = document.createElement("button");
          btn.type = "button";
          btn.className = "menu-btn";
          btn.textContent = "\u22ee";
          var menu = document.createElement("span");
          menu.className = "menu";
          function item(text, danger) {
            var b = document.createElement("button");
            b.type = "button";
            b.textContent = text;
            if (danger) b.className = "danger";
            menu.appendChild(b);
            return b;
          }
          var viewItem = item("View");
          var toolsItem = item("Tools");
          var clientsItem = item("Clients");
          var stateItem = item(dev.disabled ? "Activate" : "Deactivate", !dev.disabled);
          var delItem = item("Delete", true);
          menuWrap.appendChild(btn);
          menuWrap.appendChild(menu);
          box.appendChild(idInput);
          box.appendChild(tokInput);
          box.appendChild(menuWrap);
          li.appendChild(dot);
          li.appendChild(box);
          anonListEl.appendChild(li);

          function closeMenus() {
            var open = document.querySelectorAll(".menu.open");
            for (var i = 0; i < open.length; i++) open[i].classList.remove("open");
          }
          btn.addEventListener("click", function (e) {
            e.stopPropagation();
            var wasOpen = menu.classList.contains("open");
            closeMenus();
            toolsItem.disabled = !dev.online || dev.disabled;
            clientsItem.disabled = !dev.online;
            if (!wasOpen) menu.classList.add("open");
          });
          viewItem.addEventListener("click", function () {
            closeMenus();
            showViewDialog(label, "/admin/api/anonymous/" + dev.ref + "/origin");
          });
          toolsItem.addEventListener("click", function () {
            closeMenus();
            showAnonToolsDialog(dev.ref, label);
          });
          clientsItem.addEventListener("click", function () {
            closeMenus();
            showClients(label, "/admin/api/anonymous/" + dev.ref + "/clients");
          });
          stateItem.addEventListener("click", function () {
            closeMenus();
            var turningOff = !dev.disabled;
            setStatus((turningOff ? "deactivating " : "activating ") + label + " ...");
            api("/admin/api/anonymous/" + dev.ref + "/state", { method: "POST", body: JSON.stringify({ disabled: turningOff }) })
              .then(function () {
                setStatus((turningOff ? "deactivated " : "activated ") + label);
                loadAnon(true);
              })
              .catch(function (e) { setStatus("state change failed: " + e.message, true); });
          });
          delItem.addEventListener("click", function () {
            closeMenus();
            confirmDialog(
              "Delete anonymous device",
              "Delete the anonymous device " + label + "? Its tunnel is dropped, and a client that still has its code stops working.",
              "Delete",
              function () {
                setStatus("deleting " + label + " ...");
                api("/admin/api/anonymous/" + dev.ref, { method: "DELETE" })
                  .then(function () {
                    setStatus("deleted " + label);
                    loadAnon(true);
                    load();
                  })
                  .catch(function (e) { setStatus("delete failed: " + e.message, true); });
              },
              true,
            );
          });
        }

        // Anonymous rows hold no edits, so they can be rebuilt on every poll -
        // but only when something changed and no menu of theirs is open.
        function loadAnon(force) {
          return api("/admin/api/anonymous")
            .then(function (j) {
              var list = (j && j.devices) || [];
              showCount(j);
              var sig = JSON.stringify(list.map(function (d) { return [d.ref, d.online, d.disabled, d.locked]; }));
              if (!force && sig === anonSignature) return;
              if (!force && anonListEl.querySelector(".menu.open")) return;
              anonSignature = sig;
              anonDevices = list;
              renderAnon();
            })
            .catch(function (e) { setStatus("load failed: " + e.message, true); });
        }

        // Poll ONLY the status dots - never rebuild rows while the user is
        // typing (a rebuild would wipe in-progress edits and unsaved rows).
        function refreshDots() {
          api("/admin/api/devices")
            .then(function (j) {
              var map = {}, disMap = {};
              (j.devices || []).forEach(function (d) {
                map[d.deviceId] = !!d.online;
                disMap[d.deviceId] = !!d.disabled;
              });
              var rows = listEl.querySelectorAll("li.row");
              for (var i = 0; i < rows.length; i++) {
                var id = rows[i].dataset.deviceId;
                var on = !!map[id];
                var dis = !!disMap[id];
                var dot = rows[i].querySelector(".dot");
                if (dot) dot.className = "dot " + (on ? "on" : "off");
                var cloud = rows[i].querySelector(".cloud-ic");
                if (cloud) cloud.className = "cloud-ic " + (dis ? "off" : "on");
                rows[i].dataset.online = on ? "1" : "0";
                rows[i].className = "row" + (dis ? " disabled" : "");
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

        fleetAddBtn.addEventListener("click", fleetAddCard);

        // ---- what the month has cost ----
        // The gateway keeps a count of what it has done this month and prices
        // it; the fleets stop when the month passes the budget.
        var usageEl = document.getElementById("usage");
        function loadUsage() {
          fetch("/admin/api/usage")
            .then(function (res) { return res.json(); })
            .then(function (j) {
              if (!j || !j.cost) return;
              var spent = Number(j.spentUsd || 0);
              var budget = Number(j.budgetUsd || 0);
              var pct = budget > 0 ? Math.min(100, Math.round((spent / budget) * 100)) : 0;
              var c = j.cost;
              usageEl.innerHTML =
                '<div class="usage-top"><span class="usage-money">$' +
                spent.toFixed(2) +
                '</span><span class="usage-of">of $' +
                budget.toFixed(2) +
                ' budget</span><span class="usage-month">' +
                esc(String(j.month || "")) +
                "</span></div>" +
                '<div class="usage-bar"><span style="width:' +
                pct +
                '%" class="' +
                (j.overBudget ? "over" : "") +
                '"></span></div>' +
                '<div class="usage-parts">plan $' +
                c.plan.toFixed(2) +
                " · requests $" +
                (c.gatewayRequests + c.doRequests).toFixed(2) +
                " · duration $" +
                c.doDuration.toFixed(2) +
                " · r2 $" +
                c.r2.toFixed(2) +
                "</div>" +
                '<div class="usage-counts">' +
                Number(j.counts?.gatewayRequests || 0).toLocaleString() +
                " requests · " +
                Number(j.counts?.doRequests || 0).toLocaleString() +
                " object requests · " +
                Number(j.counts?.doMinutes || 0).toLocaleString() +
                " object minutes</div>" +
                (j.overBudget
                  ? '<div class="usage-over">The fleet budget is spent: the fleets are paused until the month turns over or the budget is raised.</div>'
                  : "");
            })
            .catch(function () {});
        }

        load();
        loadUsage();
        setInterval(loadUsage, 30000);
        setInterval(refreshDots, 5000);
        setInterval(loadAnon, 5000);
        setInterval(loadFleets, 10000);
      })();
    </script>
  </body>
</html>
`;
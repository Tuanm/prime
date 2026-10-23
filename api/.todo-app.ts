
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const MINUTES = Number(process.env.MINUTES || 20);
const deadline = Date.now() + MINUTES * 60_000;
const c = new Client({ name: "todo-agent", version: "1" });
await c.connect(new StreamableHTTPClientTransport(new URL("https://prime.tuanm.workers.dev/mcp/demo"), { requestInit: { headers: { "x-device-token": "demo" } } }));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
async function call(name, args = {}) {
  const r = await c.callTool({ name: "call", arguments: { name, arguments: args } });
  const t = (r.content || []).map((x) => x.text).join("");
  if (r.isError) throw new Error(name + ": " + t);
  try { return JSON.parse(t); } catch { return t; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stopping = false;

// ---- the app ----
const app = await call("dashboard_add", { spec: { type: "card", title: "Todo" } });
await call("dashboard_add", { spec: { type: "heading", text: "Today", parent: app } });
const status = await call("dashboard_add", { spec: { type: "status", text: "no tasks yet", state: "pending", parent: app } });
const listCard = await call("dashboard_add", { spec: { type: "card", title: "Tasks", parent: app } });
const empty = await call("dashboard_add", { spec: { type: "text", text: "Nothing to do. Add a task below.", muted: true, parent: listCard } });
const clear = await call("dashboard_add", { spec: { type: "checkbox", label: "Clear completed", parent: app } });
await call("dashboard_add", { spec: { type: "text", text: "Type a task in the box below and press Enter. Tick a task when it is done; tick 'Clear completed' to remove the finished ones.", muted: true, parent: app } });
log("app built", { app, listCard, clear });

const tasks = []; // { id, text }
let emptyShown = true;
async function addTask(text) {
  if (emptyShown) { await call("dashboard_remove", { id: empty }); emptyShown = false; }
  const id = await call("dashboard_add", { spec: { type: "checkbox", label: text, parent: listCard } });
  tasks.push({ id, text });
  log("added", JSON.stringify(text), id);
  return id;
}

// ---- new tasks: an ask_user box, again and again ----
async function askLoop() {
  while (!stopping && Date.now() < deadline - 5000) {
    try {
      const r = await call("ask_user", { question: "New task", placeholder: "e.g. Buy milk - then Enter", timeout_seconds: 100 });
      if (r.answered && String(r.answer).trim()) await addTask(String(r.answer).trim().slice(0, 120));
    } catch (e) { log("ask error:", e.message); if (/offline|503/.test(e.message)) { stopping = true; } await sleep(2000); }
  }
}

// ---- follow the state: counter and clear-completed ----
let lastStatus = "";
async function pollLoop() {
  while (!stopping && Date.now() < deadline) {
    try {
      const comps = await call("dashboard_list");
      const byId = Object.fromEntries(comps.map((x) => [x.id, x]));
      for (let i = tasks.length - 1; i >= 0; i--) if (!byId[tasks[i].id]) tasks.splice(i, 1);
      const done = tasks.filter((t) => byId[t.id] && byId[t.id].checked);
      if (byId[clear] && byId[clear].checked) {
        for (const t of done) await call("dashboard_remove", { id: t.id });
        await call("dashboard_update", { id: clear, props: { checked: false } });
        log("cleared", done.length, "completed");
        continue;
      }
      const text = tasks.length ? done.length + " of " + tasks.length + " done" : "no tasks yet";
      const state = !tasks.length ? "pending" : done.length === tasks.length ? "on" : "off";
      if (text + state !== lastStatus) { await call("dashboard_update", { id: status, props: { text, state } }); lastStatus = text + state; log("status:", text); }
      if (!tasks.length && !emptyShown) {
        await call("dashboard_add", { spec: { type: "text", text: "Nothing to do. Add a task below.", muted: true, parent: listCard } }).then((id) => { emptyShown = true; globalThis.__empty = id; });
      }
    } catch (e) { log("poll error:", e.message); if (/offline|503/.test(e.message)) { stopping = true; break; } }
    await sleep(1200);
  }
}

// ---- demo: the agent's own cursor types the first tasks ----
async function demo() {
  for (const t of ["Read the Sandbox README", "Write a JS tool", "Connect a second agent"]) {
    let input, send;
    for (let i = 0; i < 40 && !input; i++) {
      const comps = await call("dashboard_list");
      const inputs = comps.filter((x) => x.type === "input");
      const sends = comps.filter((x) => x.type === "button" && x.label === "Send");
      if (inputs.length && sends.length) { input = inputs[inputs.length - 1].id; send = sends[sends.length - 1].id; }
      else await sleep(300);
    }
    if (!input) return;
    await call("cursor_type", { id: input, text: t });
    await call("cursor_click", { id: send });
    await sleep(1500);
  }
  if (tasks[0]) { await call("cursor_click", { id: tasks[0].id }); log("demo: ticked the first task"); }
}

await Promise.all([askLoop(), pollLoop(), demo()]);
log("stopping:", stopping ? "device went offline" : MINUTES + " minutes are up");
await c.close();

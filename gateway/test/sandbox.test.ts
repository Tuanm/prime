import { describe, expect, test } from "bun:test";
import { RUNTIME_JS, STARTER_TOOLS, renderSandboxPage, signTicket, verifyTicket } from "../src/sandbox";

// Run the runtime's analyzer as the sandboxed iframe would, with a fake parent.
function analyzer() {
  const replies: any[] = [];
  let onMessage: (e: any) => void = () => {};
  const parent = { postMessage: (m: any) => replies.push(m) };
  const window = { addEventListener: (_: string, fn: any) => { onMessage = fn; } };
  new Function("window", "parent", RUNTIME_JS)(window, parent);
  return (source: string, filename = "tool.js") => {
    onMessage({ source: parent, data: { type: "analyze", id: 1, source, filename } });
    return replies.pop().result;
  };
}
const analyze = analyzer();
const ADD = "/**\n * Add two numbers.\n * @param {number} a First\n * @param {number} [b=1] Second\n */\nexport default async function (a, b = 1) { return a + b; }\n";

describe("sandbox tool validation", () => {
  test("JSDoc becomes the description and the JSON schema", () => {
    const r = analyze(ADD, "add.js");
    expect(r.ok).toBe(true);
    expect(r.name).toBe("add");
    expect(r.description).toBe("Add two numbers.");
    expect(r.inputSchema).toEqual({ type: "object", properties: { a: { type: "number", description: "First" }, b: { type: "number", description: "Second" } }, required: ["a"], additionalProperties: false });
  });

  test("named functions name the tool; types map to JSON schema", () => {
    const r = analyze("/**\n * T.\n * @param {string|number} x X\n * @param {string[]} list L\n * @param {object=} opts O\n * @param {*} any A\n */\nexport default async function tidy(x, list, opts, any) {}\n", "whatever.js");
    expect(r.name).toBe("tidy");
    expect(r.inputSchema.properties.x.type).toEqual(["string", "number"]);
    expect(r.inputSchema.properties.list.type).toBe("array");
    expect(r.inputSchema.required).toEqual(["x", "list", "any"]);
  });

  test.each([
    ["", "empty"],
    ["/** N. */\nasync function x() {}", "export default async function"],
    ["/** B.\n * @param {string} s s */\nexport default async function (s) { return s + ; }", "syntax error"],
    ["/**\n * G.\n * @param {string} who\n */\nexport default async function (name) {}", "must match"],
    ["export default async function (a) {}", "JSDoc"],
    ["/** @param {number} a A */\nexport default async function (a) {}", "description"],
    ["import x from 'y';\n/** I. */\nexport default async function () {}", "imports"],
    ["/** D. */\nexport default async function ({ a }) {}", "plain parameters"],
    ["/** D.\n * @param {Date} d d */\nexport default async function (d) {}", "unsupported @param type"],
    ["/** D. */\nexport const x = 1;\nexport default async function () {}", "only one export"],
  ])("rejects %#: %s", (source, message) => {
    const r = analyze(source as string);
    expect(r.ok).toBe(false);
    expect(r.error).toContain(message as string);
  });

  test("validation never runs the tool's code", () => {
    (globalThis as any).__ran = false;
    expect(analyze("globalThis.__ran = true;\n/** R. */\nexport default async function () {}").ok).toBe(true);
    expect((globalThis as any).__ran).toBe(false);
  });

  test("every starter tool is valid, with a unique name", () => {
    expect(STARTER_TOOLS.length).toBeGreaterThanOrEqual(8);
    const names = STARTER_TOOLS.map((s) => {
      const r = analyze(s.source, s.filename);
      expect(r.error).toBeUndefined();
      expect(r.ok).toBe(true);
      expect(r.name + ".js").toBe(s.filename);
      return r.name;
    });
    expect(new Set(names).size).toBe(names.length);
  });

  test("the page script declares each function once (a later one would silently replace it)", () => {
    const js = [...renderSandboxPage("demo").matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
    expect(() => new Function(js)).not.toThrow();
    const names = [...js.matchAll(/^  function ([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(40);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
  });

  test("the page escapes the device id", () => {
    const html = renderSandboxPage('a"<b>');
    expect(html).not.toContain('a"<b>');
  });
});

describe("sandbox WebSocket tickets", () => {
  test("valid for its device and token, within 30 s", async () => {
    const now = Date.now();
    const ticket = await signTicket("demo", "tok", now);
    expect(await verifyTicket("demo", ticket, "tok", now + 1000)).not.toBeNull();
    expect(await verifyTicket("other", ticket, "tok", now)).toBeNull();
    expect(await verifyTicket("demo", ticket, "rotated", now)).toBeNull();
    expect(await verifyTicket("demo", ticket, "tok", now + 31_000)).toBeNull();
    const [exp, nonce, sig] = ticket.split(".");
    expect(await verifyTicket("demo", [String(Number(exp) + 60_000), nonce, sig].join("."), "tok", now)).toBeNull();
    expect(await verifyTicket("demo", [exp, nonce, sig.slice(0, -2) + "AA"].join("."), "tok", now)).toBeNull();
    expect(await verifyTicket("demo", "garbage", "tok", now)).toBeNull();
  });
});

describe("vendored sql.js", () => {
  test("equals the sql.js devDependency", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    const root = join(import.meta.dir, "..");
    for (const [vendored, original] of [["vendor/sql-wasm.js.txt", "node_modules/sql.js/dist/sql-wasm.js"], ["vendor/sql-wasm.wasm.bin", "node_modules/sql.js/dist/sql-wasm.wasm"]]) {
      expect(Buffer.compare(readFileSync(join(root, vendored)), readFileSync(join(root, original)))).toBe(0);
    }
  });
});

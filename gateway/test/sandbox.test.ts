import { describe, expect, test } from "bun:test";
import { RUNTIME_JS, renderSandboxPage } from "../src/sandbox";

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

  test("the page escapes the device id", () => {
    const html = renderSandboxPage('a"<b>');
    expect(html).not.toContain('a"<b>');
  });
});

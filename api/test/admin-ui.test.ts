import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The admin interface is a page of script. It is run here against a small
// stand-in for the browser, so that the parts that only show up when someone
// clicks something are checked: a button that does nothing is easy to write
// and hard to notice.

interface El {
  tagName: string;
  children: El[];
  style: Record<string, unknown>;
  dataset: Record<string, string>;
  className: string;
  textContent: string;
  value: string;
  placeholder: string;
  title: string;
  readOnly: boolean;
  disabled: boolean;
  innerHTML: string;
  listeners: Record<string, Function[]>;
  appendChild(child: El): El;
  removeChild(child: El): void;
  setAttribute(name: string, value: string): void;
  addEventListener(name: string, fn: Function): void;
  removeEventListener(name: string, fn: Function): void;
  focus(): void;
  querySelector(selector: string): El | null;
  querySelectorAll(selector: string): El[];
  getAttribute(name: string): string | null;
  contains(other: El): boolean;
}

function makeEl(tag: string): El {
  const el: El = {
    tagName: tag,
    children: [],
    style: {},
    dataset: {},
    className: "",
    textContent: "",
    value: "",
    placeholder: "",
    title: "",
    readOnly: false,
    disabled: false,
    innerHTML: "",
    listeners: {},
    appendChild(child) { this.children.push(child); return child; },
    removeChild(child) { this.children = this.children.filter((c) => c !== child); },
    setAttribute() {},
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); },
    removeEventListener() {},
    focus() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getAttribute() { return null; },
    contains() { return false; },
  };
  // Setting the html replaces what is inside, the way a browser does it.
  let html = "";
  Object.defineProperty(el, "innerHTML", {
    get() { return html; },
    set(value: string) { html = value; el.children = []; },
  });
  return el;
}

interface Page {
  byId: Record<string, El>;
  click(id: string): void;
  list(): El[];
  settle(): Promise<void>;
}

function loadPage(fleets: unknown[] = []): Page {
  const source = readFileSync(new URL("../src/admin-ui.ts", import.meta.url), "utf8");
  const html = source.slice(source.indexOf("<script>") + 8, source.indexOf("</script>"));
  const byId: Record<string, El> = {};
  const doc = {
    getElementById: (id: string) => (byId[id] ||= makeEl("div")),
    createElement: (tag: string) => makeEl(tag),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    body: makeEl("body"),
  };
  const fetchStub = async (path: string) => ({
    ok: true,
    status: 200,
    json: async () => (String(path).indexOf("/admin/api/fleets") === 0 ? { fleets } : {}),
    text: async () => "{}",
    headers: { get: () => null },
  });
  const run = new Function(
    "document",
    "window",
    "fetch",
    "setInterval",
    "clearInterval",
    "setTimeout",
    "clearTimeout",
    "AbortSignal",
    html,
  );
  run(
    doc,
    { prompt: () => null, confirm: () => false, addEventListener: () => {} },
    fetchStub,
    () => 0,
    () => {},
    (fn: Function) => fn(),
    () => {},
    AbortSignal,
  );
  return {
    byId,
    click(id) {
      for (const handler of byId[id]?.listeners?.click || []) handler({ stopPropagation() {} });
    },
    list() { return byId["fleetList"]?.children || []; },
    async settle() {
      // The list arrives over the network; let the promises run.
      for (let i = 0; i < 10; i++) await Promise.resolve();
      await new Promise((r) => setTimeout(r, 30));
    },
  };
}


/** The labels of the actions in a row's menu. */
function menuOf(row: El): string[] {
  // row > box > menu-wrap > [button, menu] and the menu holds the actions.
  for (const child of row.children) {
    if (child.className === "box") {
      for (const inner of child.children) {
        if (inner.className === "menu-wrap") {
          const menu = inner.children.find((c) => c.className === "menu");
          return (menu?.children || []).map((b) => b.textContent);
        }
      }
    }
  }
  return [];
}

describe("the fleets in the admin interface", () => {
  test("the + button opens the card that is filled in", () => {
    const page = loadPage();
    expect(page.list().length).toBe(0);
    page.click("fleetAddBtn");
    expect(page.list().length).toBe(1);
    expect(page.list()[0]!.className).toContain("fleet-branch");
  });

  test("each + opens a card of its own", () => {
    const page = loadPage();
    page.click("fleetAddBtn");
    page.click("fleetAddBtn");
    expect(page.list().length).toBe(2);
  });

  test("the card that is filled in survives a refresh of the list", async () => {
    const page = loadPage();
    page.click("fleetAddBtn");
    // The list is fetched again every few seconds: what is being typed must not
    // be thrown away by that.
    await page.settle();
    expect(page.list().length).toBe(1);
  });

  test("the fleets are shown with their spaces under them", async () => {
    const page = loadPage([
      {
        fleet: "acme",
        members: [{ deviceId: "d1", role: "owner", label: "alpha", addedAt: 1, online: true }],
        memberCount: 1,
        primary: "d1",
        pending: [],
      },
    ]);
    await page.settle();
    expect(page.list().length).toBe(1);
    const branch = page.list()[0]!;
    // The fleet is the root; the spaces are the leaves below it.
    expect(branch.children.length).toBeGreaterThan(1);
    expect(branch.children[0]!.className).toContain("fleet-row");
  });
  test("a fleet is a cloud, and it offers Save and Deactivate", async () => {
    const page = loadPage([
      {
        fleet: "acme",
        label: "the office",
        disabled: false,
        members: [{ deviceId: "d1", role: "owner", label: "alpha", addedAt: 1, online: true }],
        primary: "d1",
        pending: [],
      },
    ]);
    await page.settle();
    const branch = page.list()[0]!;
    const root = branch.children[0]!;
    // A fleet is a group of spaces, so it carries the cloud, not a status dot.
    expect(root.children[0]!.className).toContain("cloud-ic");
    expect(menuOf(root)).toEqual(["Save", "Deactivate", "Invite", "Delete"]);
  });

  test("a paused fleet is drawn as switched off, and offers Activate", async () => {
    const page = loadPage([
      { fleet: "acme", disabled: true, members: [], primary: null, pending: [] },
    ]);
    await page.settle();
    const root = page.list()[0]!.children[0]!;
    expect(root.className).toContain("disabled");
    expect(root.children[0]!.className).toContain("off");
    expect(menuOf(root)).toContain("Activate");
  });

  test("a space is a member of a fleet, not a device with an id on show", async () => {
    const page = loadPage([
      {
        fleet: "acme",
        members: [{ deviceId: "d1", role: "owner", label: "alpha", addedAt: 1, online: true }],
        primary: "d1",
        pending: [],
      },
    ]);
    await page.settle();
    const leaves = page.list()[0]!.children[1]!;
    const space = leaves.children[0]!.children[0]!;
    const box = space.children.find((c) => c.className === "box")!;
    // The name, and the actions: the device id is not shown.
    expect(box.children.length).toBe(2);
    expect(menuOf(space)).toEqual(["View", "Tools", "Clients", "Deactivate", "Remove"]);
  });

  test("the card for a new device is an outline that can be cancelled", () => {
    const page = loadPage();
    page.click("addBtn");
    const rows = page.byId["list"]!.children;
    expect(rows.length).toBe(1);
    expect(rows[0]!.className).toContain("new");
    expect(menuOf(rows[0]!)).toEqual(["Save", "Cancel"]);
  });
});

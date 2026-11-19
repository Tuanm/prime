import { describe, expect, test } from "bun:test";
import { ADMIN_HTML } from "../src/admin-ui";

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
  hidden: boolean;
  removeAttribute(name: string): void;
  classList: { add(name: string): void; remove(name: string): void; contains(name: string): boolean };
  parentNode?: El;
}

function makeEl(tag: string): El {
  const parts: Record<string, El> = {};
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
    // A toast fades by adding a class a few seconds after it appears. A stand-in that
    // lacks it throws from that timer, long after the test that made it has ended, and
    // the runner blames whichever test is running by then.
    classList: {
      add(name) { const have = new Set(el.className.split(/\s+/).filter(Boolean)); have.add(name); el.className = [...have].join(" "); },
      remove(name) { el.className = el.className.split(/\s+/).filter((c) => c && c !== name).join(" "); },
      contains(name) { return el.className.split(/\s+/).includes(name); },
    },
    appendChild(child) { this.children.push(child); return child; },
    removeChild(child) { this.children = this.children.filter((c) => c !== child); },
    setAttribute(name, value) {
      // hidden is a boolean property in a browser, not a string attribute.
      if (name === "hidden") this.hidden = true;
      else (this as Record<string, unknown>)[name] = value;
    },
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); },
    removeEventListener() {},

    hidden: false,
    removeAttribute(name) {
      if (name === "hidden") this.hidden = false;
      else delete (this as Record<string, unknown>)[name];
    },
    focus() {},
    // The parts of a dialog the page reaches for by selector exist, one per
    // selector, so what the page writes into a dialog can be read back.
    // Anything else is not found, as before.
    querySelector(selector: string) {
      if (!/^(\.dlg-|#copy)/.test(selector)) return null;
      return (parts[selector] ||= makeEl("div"));
    },
    querySelectorAll() { return []; },
    getAttribute(name) { return ((this as Record<string, unknown>)[name] as string) ?? null; },
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

interface Call {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

interface Page {
  byId: Record<string, El>;
  body: El;
  calls: Call[];
  click(id: string): void;
  list(): El[];
  settle(): Promise<void>;
}

function loadPage(fleets: unknown[] = [], opts: { failFleets?: boolean; devices?: unknown[] } = {}): Page {
  // The page as it is served: the template already expanded. Reading the .ts
  // source instead would compile the escaping of the template rather than what
  // the browser is given, and a stray backslash would pass unnoticed.
  const page = ADMIN_HTML;
  const html = page.slice(page.indexOf("<script>") + 8, page.indexOf("</script>"));
  const byId: Record<string, El> = {};
  // The tabs the page puts in its markup, so the script can find them the way it
  // does in a browser.
  const tabs: El[] = [];
  const panels: El[] = [];
  for (const name of page.match(/data-tab="[a-z]+"/g) || []) {
    const kind = /"([a-z]+)"/.exec(name)![1]!;
    if (tabs.some((t) => t.dataset.tab === kind)) {
      const panel = makeEl("div");
      panel.dataset.tab = kind;
      panel.setAttribute("data-tab", kind);
      panel.hidden = kind !== "buddies";
      panels.push(panel);
    } else {
      const tab = makeEl("button");
      tab.dataset.tab = kind;
      tab.setAttribute("data-tab", kind);
      tabs.push(tab);
    }
  }
  const doc = {
    getElementById: (id: string) => (byId[id] ||= makeEl("div")),
    createElement: (tag: string) => makeEl(tag),
    querySelector: () => null,
    querySelectorAll: (selector: string) => {
      const m = /\.utab$/.exec(selector);
      if (m) return tabs;
      const p = /\.utab-panel$/.exec(selector);
      if (p) return panels;
      return [];
    },
    addEventListener() {},
    removeEventListener() {},
    body: makeEl("body"),
  };
  const calls: Call[] = [];
  const fetchStub = async (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    let body: Record<string, unknown> | null = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch {}
    calls.push({ path: String(path), method: init.method || "GET", headers: init.headers || {}, body });
    const fleetsCall = String(path).indexOf("/admin/api/fleets") === 0;
    const devicesCall = String(path) === "/admin/api/devices" && (init.method || "GET") === "GET";
    const failing = fleetsCall && opts.failFleets;
    return {
      ok: !failing,
      status: failing ? 500 : 200,
      json: async () => (fleetsCall ? { fleets } : devicesCall ? { devices: opts.devices || [] } : {}),
      text: async () => "{}",
      headers: { get: () => null },
    };
  };
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
    (fn: Function, ms?: number) => setTimeout(fn, Math.max(0, Number(ms) || 0)),
    () => {},
    AbortSignal,
  );
  return {
    byId,
    body: doc.body,
    calls,
    click(id) {
      for (const handler of byId[id]?.listeners?.click || []) handler({ stopPropagation() {} });
    },
    list() { return byId["fleetList"]?.children || []; },
    /** Click a tab, as the page's tab bar does. */
    tab(name: string) {
      for (const handler of tabs.find((t) => t.dataset.tab === name)?.listeners?.click || []) {
        handler({ stopPropagation() {} });
      }
    },
    openPanel(): string | undefined {
      return panels.find((p) => !p.hidden)?.dataset.tab;
    },
    async settle() {
      // The list arrives over the network; let the promises run.
      for (let i = 0; i < 10; i++) await Promise.resolve();
      await new Promise((r) => setTimeout(r, 30));
    },
  };
}


/** The action buttons in a row's menu. */
function menuButtons(row: El): El[] {
  // row > box > menu-wrap > [button, menu] and the menu holds the actions.
  for (const child of row.children) {
    if (child.className === "box") {
      for (const inner of child.children) {
        if (inner.className === "menu-wrap") {
          const menu = inner.children.find((c) => c.className === "menu");
          return menu?.children || [];
        }
      }
    }
  }
  return [];
}

/** The labels of the actions in a row's menu. */
function menuOf(row: El): string[] {
  return menuButtons(row).map((b) => b.textContent);
}

/** The action with this label, as an element. */
function action(row: El, label: string): El | undefined {
  return menuButtons(row).find((b) => b.textContent === label);
}

/** Type into a field, as a person typing would. */
function type(input: El, text: string): void {
  input.value = text;
  for (const fn of input.listeners["input"] || []) fn({});
}

describe("the fleets in the admin interface", () => {
  test("the + button opens the card that is filled in", () => {
    const page = loadPage();
    expect(page.list().length).toBe(0);
    page.tab("fleets");
    page.click("addBtn");
    expect(page.list().length).toBe(1);
    expect(page.list()[0]!.className).toContain("fleet-branch");
  });

  test("each + opens a card of its own", () => {
    const page = loadPage();
    page.tab("fleets");
    page.click("addBtn");
    page.tab("fleets");
    page.click("addBtn");
    expect(page.list().length).toBe(2);
  });

  test("the card that is filled in survives a refresh of the list", async () => {
    const page = loadPage();
    page.tab("fleets");
    page.click("addBtn");
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
        buddy: "0123456789abcdef0123456789abcdef01234567",
        members: [{ deviceId: "d1", role: "owner", label: "alpha", addedAt: 1, online: true }],
        primary: "d1",
        pending: [],
      },
    ]);
    await page.settle();
    const branch = page.list()[0]!;
    const root = branch.children[0]!;
    // A fleet is a group of spaces, so it carries the cloud, not a status dot.
    // A token and a space holding the lease mean there is a way in.
    expect(root.children[0]!.className).toContain("cloud-ic");
    expect(root.children[0]!.className).toContain("on");
    expect(root.children[0]!.className).not.toContain("hollow");
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

  test("the fleet card carries the name and the actions, and nothing else", async () => {
    const page = loadPage([
      {
        fleet: "acme",
        disabled: false,
        members: [{ deviceId: "d1", role: "owner", label: "alpha", addedAt: 1, online: true }],
        primary: "d1",
        pending: [],
      },
    ]);
    await page.settle();
    const root = page.list()[0]!.children[0]!;
    const box = root.children.find((c) => c.className === "box")!;
    // The name, and the menu: no member count, no primary line, no meta.
    expect(box.children.length).toBe(2);
    expect(box.children[0]!.tagName).toBe("input");
  });

  test("Save is off until the name of the fleet is changed", async () => {
    const page = loadPage([
      { fleet: "acme", disabled: false, members: [], primary: null, pending: [] },
    ]);
    await page.settle();
    const root = page.list()[0]!.children[0]!;
    expect(action(root, "Save")!.disabled).toBe(true);
    const name = root.children.find((c) => c.className === "box")!.children[0]!;
    type(name, "the office");
    expect(action(root, "Save")!.disabled).toBe(false);
  });

  test("there is nothing to create until the fleet has a name", () => {
    const page = loadPage();
    page.tab("fleets");
    page.click("addBtn");
    const root = page.list()[0]!.children[0]!;
    expect(action(root, "Create")!.disabled).toBe(true);
    const name = root.children.find((c) => c.className === "box")!.children[0]!;
    type(name, "acme");
    expect(action(root, "Create")!.disabled).toBe(false);
  });

  test("there is nothing to save until a new device has a name", () => {
    const page = loadPage();
    page.click("addBtn");
    const row = page.byId["list"]!.children[0]!;
    expect(action(row, "Save")!.disabled).toBe(true);
    const field = (i: number) => row.children.find((c) => c.className === "box")!.children[i]!;
    // The token may stay empty: the page makes one.
    type(field(0), "my-device");
    expect(action(row, "Save")!.disabled).toBe(false);
  });

  test("a fleet is a buddy in the list, and shows which token it has, never the token", async () => {
    const page = loadPage([
      {
        fleet: "acme",
        label: "",
        disabled: false,
        buddy: "a1b2c3d4",
        members: [],
        primary: "d1",
        pending: [],
      },
    ]);
    await page.settle();
    const rows = page.byId["list"]!.children;
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    // A token is set, so the cloud is filled.
    expect(row.children[0]!.className).toContain("cloud-ic");
    expect(row.children[0]!.className).not.toContain("hollow");
    const box = row.children.find((c) => c.className === "box")!;
    // Its own name is the id it answers to; the token is masked, like every
    // other token on the page, and its fingerprint is in the tooltip.
    expect(box.children[0]!.value).toBe("acme");
    expect(box.children[1]!.value).toBe("***");
    expect(box.children[1]!.title).toContain("a1b2c3d4");
    // The actions a buddy has, acting on the space that holds the lease.
    expect(menuOf(row)).toEqual(["View", "Tools", "Clients", "Save", "Deactivate", "Refresh token"]);
    expect(action(row, "Save")!.disabled).toBe(true);
    // With no space holding the lease there is nothing to look at.
    expect(action(row, "View")!.disabled).toBe(true);
  });

  test("a fleet with no token is drawn hollow: there is no way in", async () => {
    const page = loadPage([
      { fleet: "closed", label: "", disabled: false, buddy: "", members: [], primary: null, pending: [] },
    ]);
    await page.settle();
    const row = page.byId["list"]!.children[0]!;
    expect(row.children[0]!.className).toContain("hollow");
    const box = row.children.find((c) => c.className === "box")!;
    // There is no token, so the field is the plain empty one it always was.
    expect(box.children[1]!.value).toBe("");
    expect(box.children[1]!.placeholder).toBe("token");
    expect(menuOf(row)).toContain("Refresh token");
  });

  test("a tab shows its list and hides the others", () => {
    const page = loadPage();
    // Buddies is the tab you land on: the + makes a device, not a fleet.
    expect(page.openPanel()).toBe("buddies");
    page.click("addBtn");
    expect(page.byId["list"]!.children.length).toBe(1);
    page.tab("fleets");
    expect(page.openPanel()).toBe("fleets");
    page.click("addBtn");
    expect(page.list().length).toBe(1);
    page.tab("anonymous");
    expect(page.openPanel()).toBe("anonymous");
  });

  test("one Devices section, three tabs in the order people look", () => {
    const page = ADMIN_HTML;
    expect(page).toContain("<h2>Devices</h2>");
    // The three lists are tabs of that section, in this order.
    const order = [...page.matchAll(/class="utab[^"]*" type="button" role="tab" data-tab="([a-z]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["buddies", "fleets", "anonymous"]);
    // Three tabs fit: the bar must not be a scroll container, which would clip
    // the selected tab's box. Only a bar with more tabs than fit asks for it.
    expect(page).toContain('<div class="utabs-bar" id="deviceTabs"');
    expect(page).toContain(".utabs-bar.scroll {");
    expect(page).toContain('data-tab="buddies" role="tabpanel"');
    expect(page).toContain('data-tab="fleets" role="tabpanel" hidden');
    expect(page).toContain('data-tab="anonymous" role="tabpanel" hidden');
    // The old separate headings are gone with the sections they named.
    expect(page).not.toContain("<h2>Fleets</h2>");
    expect(page).not.toContain("<h2>Buddies</h2>");
    expect(page).not.toContain("<h2>Anonymous</h2>");
    expect(page).not.toContain('placeholder = "device id"');
  });


  test("a fleet with a token and no primary is hollow: nobody to reach", async () => {
    const page = loadPage([
      {
        fleet: "lonely",
        label: "",
        disabled: false,
        buddy: "0123456789abcdef0123456789abcdef01234567",
        members: [],
        primary: null,
        pending: [],
      },
    ]);
    await page.settle();
    const row = page.byId["list"]!.children[0]!;
    expect(row.children[0]!.className).toContain("hollow");
  });

  test("what goes wrong is said in a toast, not in a line at the bottom", async () => {
    const page = loadPage([], { failFleets: true });
    await page.settle();
    const toasts = page.byId["toasts"]!.children;
    expect(toasts.length).toBeGreaterThan(0);
    expect(toasts[toasts.length - 1]!.className).toContain("toast");
    expect(toasts[toasts.length - 1]!.className).toContain("error");
  });
});

/** Run an action's click handlers, as a click on it would. */
function press(el: El | undefined): void {
  for (const fn of el?.listeners["click"] || []) fn({ stopPropagation() {} });
}

/** The text of every dialog the page has opened, newest last. */
function dialogs(page: Page): string[] {
  return page.body.children
    .filter((c) => c.className === "overlay")
    .map((o) => o.querySelector(".dlg-body")!.innerHTML);
}

describe("a buddy's token in the admin interface", () => {
  const field = (row: El, i: number) => row.children.find((c) => c.className === "box")!.children[i]!;
  const posts = (page: Page) => page.calls.filter((c) => c.path === "/admin/api/devices" && c.method === "POST");

  test("a new device needs only a name: the page makes its token and shows it once", async () => {
    const page = loadPage();
    page.click("addBtn");
    const row = page.byId["list"]!.children[0]!;
    type(field(row, 0), "laptop");
    press(action(row, "Save"));
    await page.settle();
    const sent = posts(page);
    expect(sent.length).toBe(1);
    expect(sent[0]!.body!.deviceId).toBe("laptop");
    const token = String(sent[0]!.body!.token);
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    const shown = dialogs(page);
    expect(shown.length).toBe(1);
    expect(shown[0]).toContain(token);
  });

  test("a token the operator types is sent as it is, and not shown back", async () => {
    const page = loadPage();
    page.click("addBtn");
    const row = page.byId["list"]!.children[0]!;
    type(field(row, 0), "laptop");
    type(field(row, 1), "their-own-token");
    press(action(row, "Save"));
    await page.settle();
    expect(posts(page)[0]!.body).toEqual({ deviceId: "laptop", token: "their-own-token" });
    expect(dialogs(page)).toEqual([]);
  });

  test("a registered device's token is masked, with its fingerprint in the tooltip", async () => {
    const page = loadPage([], { devices: [{ deviceId: "d1", fingerprint: "a1b2c3d4", online: true }] });
    await page.settle();
    const row = page.byId["list"]!.children[0]!;
    expect(field(row, 1).value).toBe("***");
    expect(field(row, 1).title).toContain("a1b2c3d4");
    expect(action(row, "Save")!.disabled).toBe(true);
  });

  test("a token typed over the mask replaces it; the mask itself is never sent", async () => {
    const page = loadPage([], { devices: [{ deviceId: "d1", fingerprint: "a1b2c3d4", online: true }] });
    await page.settle();
    const row = page.byId["list"]!.children[0]!;
    type(field(row, 1), "a-new-token");
    expect(action(row, "Save")!.disabled).toBe(false);
    press(action(row, "Save"));
    await page.settle();
    expect(posts(page)[0]!.body).toEqual({ deviceId: "d1", token: "a-new-token" });
    // Typing the mask back is no change at all.
    type(field(row, 1), "***");
    expect(action(row, "Save")!.disabled).toBe(true);
  });

  test("a fleet's mask is not a token: Save stays off until one is typed", async () => {
    const page = loadPage([{ fleet: "acme", label: "", disabled: false, buddy: "a1b2c3d4", members: [], primary: "d1", pending: [] }]);
    await page.settle();
    const row = page.byId["list"]!.children[0]!;
    const tok = row.children.find((c) => c.className === "box")!.children[1]!;
    type(tok, "***");
    expect(action(row, "Save")!.disabled).toBe(true);
    type(tok, "a-new-fleet-token");
    expect(action(row, "Save")!.disabled).toBe(false);
  });

  test("a rename sends no token: the device keeps the one it has", async () => {
    const page = loadPage([], { devices: [{ deviceId: "d1", fingerprint: "a1b2c3d4", online: true }] });
    await page.settle();
    const row = page.byId["list"]!.children[0]!;
    type(field(row, 0), "d2");
    expect(action(row, "Save")!.disabled).toBe(false);
    press(action(row, "Save"));
    await page.settle();
    expect(posts(page)[0]!.body).toEqual({ deviceId: "d2", replaces: "d1" });
  });

  test("New token replaces the token and shows the new one once", async () => {
    const page = loadPage([], { devices: [{ deviceId: "d1", fingerprint: "a1b2c3d4", online: true }] });
    await page.settle();
    const row = page.byId["list"]!.children[0]!;
    expect(menuOf(row)).toContain("New token");
    press(action(row, "New token"));
    await page.settle();
    const sent = posts(page);
    expect(sent.length).toBe(1);
    expect(sent[0]!.body!.deviceId).toBe("d1");
    const token = String(sent[0]!.body!.token);
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(dialogs(page).at(-1)).toContain(token);
  });

  test("Tools asks the gateway, and sends no token", async () => {
    const page = loadPage([], { devices: [{ deviceId: "d1", fingerprint: "a1b2c3d4", online: true }] });
    await page.settle();
    const row = page.byId["list"]!.children[0]!;
    press(action(row, "Tools"));
    await page.settle();
    const tools = page.calls.filter((c) => c.path.endsWith("/tools"));
    expect(tools.length).toBe(1);
    expect(tools[0]!.path).toBe("/admin/api/devices/d1/tools");
    expect(tools[0]!.method).toBe("POST");
    expect(JSON.stringify(page.calls).includes("x-device-token")).toBe(false);
  });
});

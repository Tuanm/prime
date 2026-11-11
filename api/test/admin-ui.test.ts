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

function loadPage(fleets: unknown[] = [], opts: { failFleets?: boolean } = {}): Page {
  // The page as it is served: the template already expanded. Reading the .ts
  // source instead would compile the escaping of the template rather than what
  // the browser is given, and a stray backslash would pass unnoticed.
  const page = ADMIN_HTML;
  const html = page.slice(page.indexOf("<script>") + 8, page.indexOf("</script>"));
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
  const fetchStub = async (path: string) => {
    const fleetsCall = String(path).indexOf("/admin/api/fleets") === 0;
    const failing = fleetsCall && opts.failFleets;
    return {
      ok: !failing,
      status: failing ? 500 : 200,
      json: async () => (fleetsCall ? { fleets } : {}),
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
    page.click("fleetAddBtn");
    const root = page.list()[0]!.children[0]!;
    expect(action(root, "Create")!.disabled).toBe(true);
    const name = root.children.find((c) => c.className === "box")!.children[0]!;
    type(name, "acme");
    expect(action(root, "Create")!.disabled).toBe(false);
  });

  test("there is nothing to save until a new device has a name and a token", () => {
    const page = loadPage();
    page.click("addBtn");
    const row = page.byId["list"]!.children[0]!;
    expect(action(row, "Save")!.disabled).toBe(true);
    const field = (i: number) => row.children.find((c) => c.className === "box")!.children[i]!;
    type(field(0), "my-device");
    expect(action(row, "Save")!.disabled).toBe(true);
    type(field(1), "a-token");
    expect(action(row, "Save")!.disabled).toBe(false);
  });

  test("a fleet is a buddy in the list, and its token is masked like the others", async () => {
    const page = loadPage([
      {
        fleet: "acme",
        label: "",
        disabled: false,
        buddy: "0123456789abcdef0123456789abcdef01234567",
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
    // other token on the page.
    expect(box.children[0]!.value).toBe("acme");
    expect(box.children[1]!.value).not.toContain("0123456789abcdef");
    expect(box.children[1]!.value).toContain("***");
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

  test("the sections are named for what they hold", () => {
    const page = ADMIN_HTML;
    expect(page).toContain("<h2>Fleets</h2>");
    expect(page).toContain("<h2>Buddies</h2>");
    expect(page).toContain("<h2>Anonymous</h2>");
    // The headings are what the operator reads: the section names are gone from
    // them, wherever else the old words might survive in a comment.
    expect(page).not.toContain("<h2>Anonymous Devices</h2>");
    expect(page).not.toContain("<h2>Devices</h2>");
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

// Runs the temporary-file pages' inline JavaScript in a fake DOM.
//
// The page code lives inside template strings, so tsc cannot see it and a
// reference to something that no longer exists throws only in a browser. Two
// such bugs shipped before this existed: an upload that called a queue option
// that had been deleted, and a tint constant that was never defined. Both were
// caught by hand in Chromium; this makes that a test.

type Listener = (ev: any) => void;

export class FakeEl {
  className = "";
  textContent = "";
  value = "";
  type = "";
  disabled = false;
  files: unknown[] = [];
  clicked = 0;
  style: Record<string, string> = {};
  dataset: Record<string, string> = new Proxy({} as Record<string, string>, {
    set: (target, key, value) => {
      target[key as string] = String(value);
      return true;
    },
  });
  children: FakeEl[] = [];
  private listeners: Record<string, Listener[]> = {};

  constructor(
    readonly tag: string,
    private readonly nodes: FakeEl[],
  ) {
    nodes.push(this);
  }

  get classList() {
    const self = this;
    const has = (c: string) => self.className.split(/\s+/).includes(c);
    return {
      contains: has,
      add: (c: string) => {
        if (!has(c)) self.className = (self.className + " " + c).trim();
      },
      remove: (c: string) => {
        self.className = self.className.split(/\s+/).filter((x) => x !== c).join(" ");
      },
    };
  }

  appendChild(child: FakeEl): FakeEl {
    this.children.push(child);
    return child;
  }
  addEventListener(ev: string, fn: Listener): void {
    (this.listeners[ev] ||= []).push(fn);
  }
  click(): void {
    this.clicked++;
    this.fire("click");
  }
  fire(ev: string, arg?: unknown): void {
    for (const fn of this.listeners[ev] ?? []) fn(arg ?? { stopPropagation() {} });
  }
  remove(): void {}
  querySelectorAll(): FakeEl[] {
    return [];
  }

  /** Every element below this one, this one included. */
  descendants(): FakeEl[] {
    return [this, ...this.children.flatMap((c) => c.descendants())];
  }
}

export interface PageHarness {
  els: Record<string, FakeEl>;
  window: Record<string, any>;
  /** XHRs the page started, in order. */
  requests: {
    method: string;
    url: string;
    body: unknown;
    headers: Record<string, string>;
    upload: { onprogress?: Listener };
    onload?: Listener;
    onerror?: Listener;
    /** The live fake XHR, so a test can set status/responseText before onload. */
    xhr: unknown;
  }[];
  errors: string[];
  /** Fire the picker's change event with these files. */
  pick(...files: { name: string; size: number; type?: string }[]): void;
  /** Click the menu entry with this label inside the given element. */
  menuClick(scope: FakeEl, label: string): void;
}

/** Execute the page's inline scripts against a fake document. */
export function runPage(html: string, init: Record<string, any> = {}): PageHarness {
  const nodes: FakeEl[] = [];
  const ids = ["list", "status", "addBtn", "picker", "usage", "budget"];
  const els: Record<string, FakeEl> = {};
  for (const id of ids) els[id] = new FakeEl("div", nodes);

  const document = {
    getElementById: (id: string) => els[id] ?? null,
    createElement: (tag: string) => new FakeEl(tag, nodes),
    querySelector: (sel: string) => {
      const m = /data-qid="([^"]*)"/.exec(sel);
      if (!m) return null;
      return nodes.find((n) => n.dataset.qid === m[1]) ?? null;
    },
    body: new FakeEl("body", nodes),
    // The page closes its menus on a document click.
    addEventListener: () => {},
  };

  const window: Record<string, any> = {
    __FILES__: [],
    __USAGE__: { bytes: 0, count: 0 },
    __LIMITS__: { max_files: 5, max_upload_bytes: 200 * 1024 * 1024, max_total_bytes: 500 * 1024 * 1024, max_expiry_ms: 604800000 },
    __BUDGET__: null,
    ...init,
  };

  const requests: PageHarness["requests"] = [];
  class FakeXHR {
    upload: { onprogress?: Listener } = {};
    onload?: Listener;
    onerror?: Listener;
    status = 0;
    responseText = "";
    private req = { method: "", url: "", body: null as unknown, headers: {} as Record<string, string> };
    open(method: string, url: string) {
      this.req.method = method;
      this.req.url = url;
    }
    setRequestHeader(k: string, v: string) {
      this.req.headers[k] = v;
    }
    send(body: unknown) {
      this.req.body = body;
      requests.push({ ...this.req, upload: this.upload, onload: this.onload, onerror: this.onerror, xhr: this });
    }
  }

  const errors: string[] = [];
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  for (const code of scripts) {
    try {
      new Function("window", "document", "navigator", "XMLHttpRequest", "fetch", code)(
        window,
        document,
        { clipboard: undefined },
        FakeXHR,
        () => Promise.resolve({ json: () => Promise.resolve({ files: [], usage: { bytes: 0, count: 0 }, budget: null }) }),
      );
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return {
    els,
    window,
    requests,
    errors,
    pick(...files) {
      els.picker.files = files.map((f) => ({ name: f.name, size: f.size, type: f.type ?? "" }));
      els.picker.fire("change");
    },
    menuClick(scope, label) {
      const button = scope
        .descendants()
        .find((n) => n.tag === "button" && n.textContent === label);
      if (!button) throw new Error("no menu button labelled " + label);
      button.click();
    },
  };
}

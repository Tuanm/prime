// A request body is read into one buffer of the length it declares, and held once.
import { describe, expect, test } from "bun:test";
import { readBounded, readBoundedText } from "../src/body";

const enc = new TextEncoder();

/** A request whose body arrives as the given chunks, saying `length` of it (or nothing). */
function request(chunks: Uint8Array[], length: number | null, onPull?: (n: number) => void): Request {
  let n = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull?.(n);
      if (n < chunks.length) controller.enqueue(chunks[n++]!);
      else controller.close();
    },
  });
  const headers: Record<string, string> = {};
  if (length !== null) headers["content-length"] = String(length);
  return new Request("https://gw.example/up", { method: "POST", body, headers, duplex: "half" } as RequestInit);
}

function bytes(n: number, fill = 7): Uint8Array {
  return new Uint8Array(n).fill(fill);
}

describe("readBounded", () => {
  test("a declared length gets its buffer before the first chunk is read, and the chunks are copied into it", async () => {
    const real = globalThis.Uint8Array;
    const made: number[] = [];
    let before = -1;
    // Allocations of a given length are noted, with how many chunks had been pulled by then.
    let pulled = 0;
    const Spy = new Proxy(real, {
      construct(target, args, nt) {
        if (typeof args[0] === "number" && args[0] === 3000) made.push(pulled);
        return Reflect.construct(target, args, nt);
      },
    });
    (globalThis as { Uint8Array: unknown }).Uint8Array = Spy;
    try {
      const req = request([bytes(1000, 1), bytes(1000, 2), bytes(1000, 3)], 3000, (n) => {
        pulled = n;
        if (n === 0) before = made.length;
      });
      const out = await readBounded(req, 64 * 1024);
      expect(out).toBeInstanceOf(ArrayBuffer);
      const view = new real(out as ArrayBuffer);
      expect(view.byteLength).toBe(3000);
      expect([view[0], view[1000], view[2999]]).toEqual([1, 2, 3]);
    } finally {
      (globalThis as { Uint8Array: unknown }).Uint8Array = real;
    }
    // One buffer of the declared size, made before the first pull and not again at the end.
    expect(made).toEqual([0]);
    expect(before).toBe(1);
  });

  test("a body shorter than it said is returned as it is, not padded", async () => {
    const out = (await readBounded(request([bytes(10)], 500), 1000)) as ArrayBuffer;
    expect(out.byteLength).toBe(10);
  });

  test("a body longer than it said is collected whole, and is still held to the cap", async () => {
    const out = (await readBounded(request([bytes(60, 1), bytes(60, 2)], 50), 1000)) as ArrayBuffer;
    expect(out.byteLength).toBe(120);
    const view = new Uint8Array(out);
    expect([view[0], view[59], view[60], view[119]]).toEqual([1, 1, 2, 2]);
    const refused = await readBounded(request([bytes(60), bytes(60)], 50), 100);
    expect(refused).toBeInstanceOf(Response);
    expect((refused as Response).status).toBe(413);
  });

  test("a body that overruns what it declared is copied out of the declared buffer, not viewed through it", async () => {
    const proto = Uint8Array.prototype as { subarray: (...a: number[]) => Uint8Array; slice: (...a: number[]) => Uint8Array };
    const realSub = proto.subarray;
    let views = 0;
    proto.subarray = function (this: Uint8Array, ...a: number[]) {
      views += 1;
      return realSub.apply(this, a as [number, number]);
    };
    try {
      const out = (await readBounded(request([bytes(40, 1), bytes(40, 2)], 50), 1000)) as ArrayBuffer;
      expect(out.byteLength).toBe(80);
      expect(new Uint8Array(out)[39]).toBe(1);
      expect(new Uint8Array(out)[40]).toBe(2);
    } finally {
      proto.subarray = realSub;
    }
    expect(views).toBe(0);
  });

  test("no length, an empty body, and a length over the cap", async () => {
    expect(((await readBounded(request([bytes(5), bytes(6)], null), 100)) as ArrayBuffer).byteLength).toBe(11);
    expect(((await readBounded(new Request("https://gw.example/x", { method: "POST" }), 100)) as ArrayBuffer).byteLength).toBe(0);
    const big = await readBounded(request([bytes(5)], 101), 100);
    expect((big as Response).status).toBe(413);
  });

  test("text decodes what was read", async () => {
    const out = await readBoundedText(request([enc.encode("héllo "), enc.encode("wörld")], 13), 100);
    expect(out).toBe("héllo wörld");
  });
});

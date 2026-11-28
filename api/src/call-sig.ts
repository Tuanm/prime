// Signed tool calls pass through the gateway untouched. A client signs the exact
// bytes of its request body and sends the signature in `x-prime-call-sig`; the
// device checks both against a key it trusts. The gateway only carries them:
// the body as the string it received (never the parsed and re-serialised one,
// which would not hash the same) and the header as it came. It cannot make a
// signature, and a call it alters or originates is one the device refuses.
//
// The device may sign its answer: `replySig` in its frame becomes the response
// header `x-prime-reply-sig`, and `responseText`, the exact text it signed, is
// returned as the body instead of a copy the gateway re-serialises.

export const CALL_SIG_HEADER = "x-prime-call-sig";
export const REPLY_SIG_HEADER = "x-prime-reply-sig";
/** A device that lists this in its register frame reads a signed call from `raw` alone: it is sent no `request`. */
export const CALL_RAW_ONLY = "call-raw-only";

// Printable ASCII, bounded: a real signature header is about 150 characters.
const SIG_RE = /^[\x21-\x7e]{1,1024}$/;

/** The client's signature header, when it is one that could be a signature. */
export function callerSigOf(headers: Headers): string | undefined {
  const v = headers.get(CALL_SIG_HEADER);
  return v !== null && SIG_RE.test(v) ? v : undefined;
}

/** Hand the signature header on to the next hop (a device object, or a fleet's primary). */
export function forwardCallerSig(from: Request, to: Headers): void {
  const v = callerSigOf(from.headers);
  if (v !== undefined) to.set(CALL_SIG_HEADER, v);
}

/** A device's reply signature, when it is a string that could be one. */
export function replySigOf(v: unknown): string | undefined {
  return typeof v === "string" && SIG_RE.test(v) ? v : undefined;
}

/**
 * A request body as text. `text` is what the relay has always parsed (a byte-order mark
 * dropped, invalid UTF-8 replaced). `exact` is the same bytes as a string with nothing
 * dropped or replaced, or null when they are not valid UTF-8: a signature over them can
 * only hold for the exact text, so a body that has none carries no `raw`.
 */
export function decodeBody(bytes: ArrayBuffer): { text: string; exact: string | null } {
  let exact: string | null = null;
  try {
    exact = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    // not UTF-8
  }
  const text = exact !== null ? (exact.charCodeAt(0) === 0xfeff ? exact.slice(1) : exact) : new TextDecoder().decode(bytes);
  return { text, exact };
}

// Reading a request body without trusting what the sender says about its length.

/**
 * Read a request body, at most `max` bytes of it.
 *
 * A Durable Object that is handed a request it refuses early (413, 503) leaves the unread body behind, and
 * the runtime logs an uncaught "Can't read from request stream after response has been sent" for each, and
 * sometimes drops the connection as a 500 where the caller was owed the refusal. Reading it here settles the
 * stream. It never buffers more than the cap plus one chunk, so a lying Content-Length or a chunked body
 * cannot force a large allocation. When the length is declared and within the cap the body is read into
 * one buffer of that size, so it is held once.
 */
export async function readBounded(request: Request, max: number): Promise<ArrayBuffer | Response> {
  if (!request.body) return new ArrayBuffer(0);
  const tooLarge = () => Response.json({ error: "payload too large" }, { status: 413 });
  if (Number(request.headers.get("content-length") || 0) > max) return tooLarge();

  // The sender says how long the body is. Believed only for what it saves: a buffer of that size is made
  // up front (the cap bounds it) and each chunk is copied into it as it arrives, so the body is never held
  // twice, as the chunks and then the whole. A body that turns out longer than it said, or has no length,
  // is collected as chunks, as before, and is still held to the cap.
  const declared = Number(request.headers.get("content-length") || 0);
  let fixed = Number.isInteger(declared) && declared > 0 && declared <= max ? new Uint8Array(declared) : null;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (fixed && total + value.byteLength <= fixed.byteLength) {
      fixed.set(value, total);
    } else {
      if (fixed) {
        // Longer than declared: what is in the buffer is copied out (a view would keep the whole declared
        // buffer alive beside the chunks), and the buffer is let go; it goes on from there as chunks.
        chunks.push(fixed.slice(0, total));
        fixed = null;
      }
      if (total + value.byteLength <= max) chunks.push(value);
    }
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return tooLarge();
    }
  }
  if (fixed) return total === fixed.byteLength ? fixed.buffer : fixed.slice(0, total).buffer;
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

/** The same, as text. */
export async function readBoundedText(request: Request, max: number): Promise<string | Response> {
  const body = await readBounded(request, max);
  return body instanceof Response ? body : new TextDecoder().decode(body);
}

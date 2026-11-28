// Reading a request body without trusting what the sender says about its length.

/**
 * Read a request body, at most `max` bytes of it.
 *
 * A Durable Object that is handed a request it refuses early (413, 503) leaves the unread body behind, and
 * the runtime logs an uncaught "Can't read from request stream after response has been sent" for each, and
 * sometimes drops the connection as a 500 where the caller was owed the refusal. Reading it here settles the
 * stream. It never buffers more than the cap plus one chunk, so a lying Content-Length or a chunked body
 * cannot force a large allocation.
 */
export async function readBounded(request: Request, max: number): Promise<ArrayBuffer | Response> {
  if (!request.body) return new ArrayBuffer(0);
  const tooLarge = () => Response.json({ error: "payload too large" }, { status: 413 });
  if (Number(request.headers.get("content-length") || 0) > max) return tooLarge();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return tooLarge();
    }
    chunks.push(value);
  }
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

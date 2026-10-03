/**
 * Run tasks with bounded concurrency.
 *
 * Firing every call at once is tempting but wrong: the gateway rate-limits per
 * client IP (100 requests/minute by default) and caps pending requests per
 * device, so an unbounded burst converts a large batch into a pile of 429/503
 * failures. A small worker pool keeps the parallelism that actually helps
 * (overlapping network waits) without provoking the limiter.
 *
 * Results are returned in input order regardless of completion order, and a
 * rejecting task rejects the whole pool - callers that need per-item isolation
 * should catch inside `run`.
 */
export async function pool<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await run(items[index]!, index);
    }
  };

  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

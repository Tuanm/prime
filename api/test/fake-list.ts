// What a Durable Object's storage does that the small fakes in the tests did not need until the audit log: list rows by
// prefix, in key order, and delete several keys at once.

/** The rows of `data` that `list` of a Durable Object's storage would answer, as a copy. */
export function listRows(data: Map<string, unknown>, o: { prefix?: string; start?: string; limit?: number; reverse?: boolean }): Map<string, unknown> {
  let keys = [...data.keys()].filter((k) => k.startsWith(o.prefix ?? "") && (o.start === undefined || k >= o.start)).sort();
  if (o.reverse) keys.reverse();
  if (o.limit !== undefined) keys = keys.slice(0, o.limit);
  return new Map(keys.map((k) => [k, structuredClone(data.get(k))]));
}

/** Delete one key or several; the count that were there. */
export function deleteRows(data: Map<string, unknown>, key: string | string[]): number {
  let n = 0;
  for (const k of Array.isArray(key) ? key : [key]) if (data.delete(k)) n++;
  return n;
}

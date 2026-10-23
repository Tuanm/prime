// Static assets for the Sandbox page: sql.js (SQLite in WebAssembly, MIT),
// vendored in ../vendor. Public and immutable for a given deploy.
import SQL_JS from "../vendor/sql-wasm.js.txt";
import SQL_WASM from "../vendor/sql-wasm.wasm.bin";

export function sandboxAsset(name: string | null): Response {
  const base = { "x-content-type-options": "nosniff", "cache-control": "public, max-age=86400" };
  if (name === "sql-wasm.js") return new Response(SQL_JS, { headers: { ...base, "content-type": "text/javascript; charset=utf-8" } });
  if (name === "sql-wasm.wasm") return new Response(SQL_WASM, { headers: { ...base, "content-type": "application/wasm" } });
  return new Response("not found", { status: 404 });
}

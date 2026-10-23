# Vendored files

- `sql-wasm.js.txt`, `sql-wasm.wasm.bin`: [sql.js](https://github.com/sql-js/sql.js)
  1.15.1 (MIT) - SQLite compiled to WebAssembly. The Sandbox page (GET /mcp)
  loads them from `/mcp?asset=sql-wasm.js` / `sql-wasm.wasm` for its `db` object.
  The extensions make wrangler's default rules bundle them as text and bytes.
  A unit test checks they equal `node_modules/sql.js/dist` (the devDependency).

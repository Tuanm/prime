// Write the GitHub Pages site: the same landing page the gateway serves at /.
//
//   bun api/scripts/build-site.ts [outDir]     (default _site)

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HOME_HTML } from "../src/home-page";
import { LANDING_HTML } from "../src/landing-page";

const out = resolve(process.argv[2] ?? "_site");
mkdirSync(out, { recursive: true });
// On Pages these are static files: the device and sandbox pages live on the
// running service, so point those two links there instead of at a 404.
const site = HOME_HTML.replace('href="/mcp"', 'href="mcp.html"')
  .replace('href="/files"', 'href="https://prime.tuanm.workers.dev/files"')
  .replace('href="/sandbox"', 'href="https://prime.tuanm.workers.dev/sandbox"');
writeFileSync(join(out, "index.html"), site);
writeFileSync(join(out, "mcp.html"), LANDING_HTML);
// Pages: serve files as they are (no Jekyll processing).
writeFileSync(join(out, ".nojekyll"), "");
console.log("site written to " + out);

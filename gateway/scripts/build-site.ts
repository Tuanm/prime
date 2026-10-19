// Write the GitHub Pages site: the same landing page the gateway serves at /.
//
//   bun gateway/scripts/build-site.ts [outDir]     (default _site)

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LANDING_HTML } from "../src/landing-page";

const out = resolve(process.argv[2] ?? "_site");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "index.html"), LANDING_HTML);
// Pages: serve files as they are (no Jekyll processing).
writeFileSync(join(out, ".nojekyll"), "");
console.log("site written to " + out);

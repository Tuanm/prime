// Check that every block comment is closed.
//
// A comment that opens with /** and whose body is written with // never ends,
// and everything after it is silently part of the comment. TypeScript then
// reports a pile of "cannot find name" errors that point nowhere near the
// real mistake.
//
// Run: bun scripts/check-comments.ts [dir]

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

interface Problem {
  file: string;
  line: number;
  text: string;
}

type State = "code" | "line" | "block" | "string" | "template";

function check(file: string, text: string): Problem[] {
  const problems: Problem[] = [];
  let state: State = "code";
  let blockStart = 0;
  let line = 1;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === String.fromCharCode(10)) {
      line++;
      if (state === "line") state = "code";
      i++;
      continue;
    }
    if (state === "code") {
      if (ch === "/" && next === "/") { state = "line"; i += 2; continue; }
      if (ch === "/" && next === "*") { state = "block"; blockStart = line; i += 2; continue; }
      if (ch === '"' || ch === "'") { state = "string"; i++; continue; }
      if (ch === "`") { state = "template"; i++; continue; }
      i++;
      continue;
    }
    if (state === "line") { i++; continue; }
    if (state === "block") {
      if (ch === "*" && next === "/") { state = "code"; i += 2; continue; }
      i++;
      continue;
    }
    if (state === "string") {
      if (ch === "\\") { i += 2; continue; }
      if (ch === '"' || ch === "'") state = "code";
      i++;
      continue;
    }
    if (ch === "\\") { i += 2; continue; }
    if (ch === "`") state = "code";
    i++;
  }
  if (state === "block") {
    problems.push({ file, line: blockStart, text: "this block comment is never closed" });
  }
  return problems;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === "dist" || name === ".wrangler") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const root = process.argv[2] ?? ".";
const problems: Problem[] = [];
for (const file of walk(root)) {
  problems.push(...check(relative(root, file), readFileSync(file, "utf8")));
}
if (problems.length > 0) {
  for (const p of problems) console.error(p.file + ":" + p.line + ": " + p.text);
  console.error(problems.length + " unclosed block comment(s)");
  process.exit(1);
}
console.log("every block comment is closed");

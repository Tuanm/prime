#!/usr/bin/env bun
// Lint the GitHub Actions workflows for the mistakes that only GitHub's own
// parser catches - by which time the workflow has already been rejected with
// the unhelpful "This run likely failed because of a workflow file issue."
//
// Two checks, both learned the hard way:
//
//  1. Every ${{ ... }} expression must close with }} on the same line. A
//     malformed expression is still valid YAML, so a YAML parse says nothing.
//  2. A heredoc inside a `run:` block must have its terminator at column 0 of
//     the *dedented* script, otherwise the shell swallows the rest of the file.
//
// Run: bun scripts/check-workflows.ts [dir]

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? ".github/workflows";
let problems = 0;
let files = 0;
let expressions = 0;

/** The dedented body of a `run: |` / `run: >` block starting at line index. */
function runBlockBody(lines: string[], runAt: number): string[] {
  let indent = -1;
  for (let i = runAt + 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "") continue;
    indent = lines[i]!.search(/\S/);
    break;
  }
  if (indent === -1) return [];
  const body: string[] = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() !== "" && line.search(/\S/) < indent) break;
    body.push(line.slice(indent));
  }
  return body;
}

for (const file of readdirSync(dir).sort()) {
  if (!/\.ya?ml$/.test(file)) continue;
  const path = join(dir, file);
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  files++;

  try {
    Bun.YAML.parse(text);
  } catch (err) {
    problems++;
    console.log(`${path}: invalid YAML: ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }

  lines.forEach((line, index) => {
    const opens = (line.match(/\$\{\{/g) ?? []).length;
    const closes = (line.match(/\}\}/g) ?? []).length;
    expressions += opens;
    if (opens !== closes) {
      problems++;
      console.log(`${path}:${index + 1}: unbalanced expression braces (opens=${opens} closes=${closes}): ${line.trim()}`);
    }
  });

  lines.forEach((line, index) => {
    if (!/^\s+run: [|>]/.test(line)) return;
    const body = runBlockBody(lines, index);
    for (const bodyLine of body) {
      const match = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(bodyLine);
      if (!match) continue;
      const terminator = match[2]!;
      if (!body.some((l) => l === terminator)) {
        problems++;
        console.log(`${path}:${index + 1}: heredoc <<${terminator} has no terminator at column 0 of the run block`);
      }
    }
  });
}

console.log(`checked ${files} workflow file(s), ${expressions} expression(s): ${problems} problem(s)`);
if (problems > 0) process.exit(1);

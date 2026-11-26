// Run by a test: write a snapshot over a work tree in a process the test can kill half way.
//   bun apply-child.ts <work> <gitDir> <commit> <previous>
import { applyCommit } from "../../src/fleet-sync";

const [work, gitDir, commit, previous] = process.argv.slice(2);
if (!work || !gitDir || !commit || !previous) throw new Error("usage: apply-child <work> <gitDir> <commit> <previous>");
await applyCommit(work, gitDir, commit, [], previous);

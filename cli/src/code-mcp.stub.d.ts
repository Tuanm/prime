// Type-check stand-in for "#code-mcp" (the real src/code-mcp.ts),
// used only by tsconfig.typecheck.json ("bun run typecheck"). code-mcp is a
// script with no exports, written to its own conventions rather than this
// package's strict compiler settings, so it is not type-checked from here.
// Bun ignores this file: it resolves "#code-mcp" via package.json imports.
export {};

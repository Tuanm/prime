// Type-check stand-in for the vendored src/code-mcp.ts, used only by
// tsconfig.typecheck.json ("bun run typecheck"). The real module is a script
// with no exports; it is kept byte-identical to upstream code-mcp, which is not
// written to this package's strict compiler settings, so it is not type-checked
// here. Bun ignores this file: it resolves "#code-mcp" via package.json imports.
export {};

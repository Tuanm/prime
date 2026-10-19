// The "#code-mcp" entry (package.json imports): the code-mcp device server,
// which lives in this repository at code-mcp/code-mcp.ts. A static import, so
// Bun.build and "bun build --compile" embed it in the bundle and the binaries.
//
// code-mcp is a script: importing it parses Bun.argv and starts the server.
// Only "mcp code-mcp" (src/code-mcp-host.ts) imports this, dynamically.
import "../../code-mcp/code-mcp.ts";

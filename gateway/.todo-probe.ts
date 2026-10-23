
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const c = new Client({ name: "todo-agent", version: "1" });
await c.connect(new StreamableHTTPClientTransport(new URL("https://prime.tuanm.workers.dev/mcp/demo"), { requestInit: { headers: { "x-device-token": "demo" } } }));
console.log("tools/list:", (await c.listTools()).tools.map((t) => t.name).join(", "));
const r = JSON.parse((await c.callTool({ name: "search", arguments: { limit: 50 } })).content[0].text);
console.log("sandbox tools (" + r.total + "):", r.tools.map((t) => t.name).join(", "));
const list = await c.callTool({ name: "call", arguments: { name: "dashboard_list", arguments: {} } });
console.log("dash now:", list.content[0].text.slice(0, 300));
await c.close();

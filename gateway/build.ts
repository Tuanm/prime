import { DeviceRegistry } from './device-registry';
import type { TunnelRequest, TunnelMessage, TunnelResponse, TunnelError } from './protocol';

// Configuration from flags
let PORT = 8080;
let GATEWAY_TOKEN: string | undefined;
let RATE_LIMIT_WINDOW_MS = 60_000;
let RATE_LIMIT_MAX = 100;
let TIMEOUT_MS = 30_000;
let MAX_PENDING = 100;

const HELP = `Usage: code-mcp-gateway [options]
Options:
  --port <n>          Listen port (default: 8080)
  --token <s>         Bearer token auth (optional)
  --rate-window <ms>  Rate limit window (default: 60000)
  --rate-max <n>      Max requests per window (default: 100)
  --timeout <ms>       Request timeout (default: 30000)
  --max-pending <n>   Max pending requests (default: 100)
  install             Install as user service
  uninstall           Remove user service
  -h, --help          Show this help`;

// Parse args
for (let i = 0; i < Bun.argv.length; i++) {
  const arg = Bun.argv[i];
  if (arg === "--port" && i + 1 < Bun.argv.length) {
    PORT = parseInt(Bun.argv[++i]);
  } else if (arg === "--token" && i + 1 < Bun.argv.length) {
    GATEWAY_TOKEN = Bun.argv[++i];
  } else if (arg === "--rate-window" && i + 1 < Bun.argv.length) {
    RATE_LIMIT_WINDOW_MS = parseInt(Bun.argv[++i]);
  } else if (arg === "--rate-max" && i + 1 < Bun.argv.length) {
    RATE_LIMIT_MAX = parseInt(Bun.argv[++i]);
  } else if (arg === "--timeout" && i + 1 < Bun.argv.length) {
    TIMEOUT_MS = parseInt(Bun.argv[++i]);
  } else if (arg === "--max-pending" && i + 1 < Bun.argv.length) {
    MAX_PENDING = parseInt(Bun.argv[++i]);
  } else if (arg === "install") {
    await installService();
    process.exit(0);
  } else if (arg === "uninstall") {
    await uninstallService();
    process.exit(0);
  } else if (arg === "-h" || arg === "--help") {
    console.log(HELP);
    process.exit(0);
  }
}

// State
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
type PendingResolve = (v: TunnelResponse | TunnelError | null) => void;
const pendingMap = new Map<string, { resolve: PendingResolve; timer: ReturnType<typeof setTimeout> }>();
const wsMap = new Map<string, Bun.WebSocket>();
const deviceRegistry = new DeviceRegistry();

function rateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

function authenticate(request: Request): Response | null {
  if (!GATEWAY_TOKEN) return null;
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${GATEWAY_TOKEN}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

function respond(id: string, res: TunnelResponse | TunnelError | null): void {
  const p = pendingMap.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pendingMap.delete(id);
  if (res) p.resolve(res);
}

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);

    const authError = authenticate(req);
    if (authError) return authError;

    if (req.method === "GET" && url.pathname === "/devices") {
      return Response.json({ devices: deviceRegistry.listDevices() });
    }

    if (req.method === "POST" && url.pathname === "/mcp") {
      const ip = req.headers.get("x-forwarded-for") || "unknown";
      if (!rateLimit(ip)) {
        return Response.json({ error: "rate limited" }, { status: 429 });
      }

      const deviceId = req.headers.get("x-device-id");
      if (!deviceId) {
        return Response.json({ error: "missing x-device-id" }, { status: 400 });
      }

      const ws = wsMap.get(deviceId);
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return Response.json({ error: "device offline" }, { status: 503 });
      }

      let body: unknown;
      try {
        body = req.json();
      } catch {
        return Response.json({ error: "invalid json" }, { status: 400 });
      }

      if (pendingMap.size >= MAX_PENDING) {
        return Response.json({ error: "device busy" }, { status: 503 });
      }

      const id = crypto.randomUUID();
      const token = req.headers.get("x-token") || undefined;
      const tunnelReq: TunnelRequest = { id, request: body as TunnelRequest["request"], ...(token && { token }) };
      ws.send(JSON.stringify(tunnelReq));

      return new Promise<Response>((resolve) => {
        const timer = setTimeout(() => {
          pendingMap.delete(id);
          resolve(Response.json({ error: "timeout" }, { status: 504 }));
        }, TIMEOUT_MS);
        pendingMap.set(id, { resolve, timer });
      });
    }

    if (url.pathname === "/ws" && req.headers.get("upgrade") === "websocket") {
      const deviceId = url.searchParams.get("deviceId") || crypto.randomUUID();
      server.upgrade(req, { data: deviceId });
      return;
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },

  websocket: {
    open(ws) {
      const deviceId = ws.data as string;
      wsMap.set(deviceId, ws);
      deviceRegistry.register(deviceId);
      ws.send(JSON.stringify({ type: "registered", deviceId }));
    },
    close(ws) {
      const deviceId = ws.data as string;
      wsMap.delete(deviceId);
      deviceRegistry.close(deviceId);
    },
    message(ws, data) {
      try {
        const msg = JSON.parse(data as string) as TunnelMessage;
        if ("id" in msg && ("response" in msg || "error" in msg)) {
          respond(msg.id, msg as TunnelResponse | TunnelError);
        }
      } catch {
        // Ignore
      }
    },
  },
});

console.log(`code-mcp-gateway listening on http://localhost:${PORT}`);
if (GATEWAY_TOKEN) console.log("Token auth: enabled");

// Service installation
async function installService() {
  const isMac = process.platform === "darwin";
  const isLinux = process.platform === "linux";
  const home = Bun.env.HOME || "";
  const name = "code-mcp-gateway";

  if (!isMac && !isLinux) {
    console.error("install is only supported on Linux and macOS");
    process.exit(1);
  }

  const execPath = process.execPath;
  const scriptPath = process.argv[1] || "build.ts";
  const serviceDir = isMac
    ? `${home}/Library/LaunchAgents`
    : `${home}/.config/systemd/user`;

  // Ensure service directory exists
  await Bun.write(`${serviceDir}/${name}-start.sh`, `#!/bin/bash\nexec ${execPath} "${scriptPath}" --port 8080\n`);
  await Bun.spawn(["chmod", "+x", `${serviceDir}/${name}-start.sh`]).exited;

  if (isMac) {
    const serviceFile = `${serviceDir}/${name}.plist`;
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${name}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${execPath}</string>
    <string>${scriptPath}</string>
    <string>--port</string>
    <string>8080</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>`;
    await Bun.write(serviceFile, plist);
    console.log(`Installed: ${serviceFile}`);
    console.log("Run: launchctl load", serviceFile);
  } else {
    const serviceFile = `${serviceDir}/${name}.service`;
    const service = `[Unit]
Description=Prime

[Service]
ExecStart=${execPath} "${scriptPath}" --port 8080
Restart=always
RestartSec=5

[Install]
WantedBy=default.target`;
    await Bun.write(serviceFile, service);
    console.log(`Installed: ${serviceFile}`);
    console.log("Run: systemctl --user daemon-reload && systemctl --user enable --now", name);
  }
}

async function uninstallService() {
  const isMac = process.platform === "darwin";
  const isLinux = process.platform === "linux";
  const home = Bun.env.HOME || "";
  const name = "code-mcp-gateway";

  if (!isMac && !isLinux) {
    console.error("uninstall is only supported on Linux and macOS");
    process.exit(1);
  }

  const serviceDir = isMac
    ? `${home}/Library/LaunchAgents`
    : `${home}/.config/systemd/user`;
  const serviceFile = isMac
    ? `${serviceDir}/${name}.plist`
    : `${serviceDir}/${name}.service`;

  try {
    await Bun.file(`${serviceDir}/${name}-start.sh`).delete();
    await Bun.file(serviceFile).delete();
    console.log(`Uninstalled from ${serviceDir}`);
  } catch {
    console.log("Service files not found, skipping");
  }
}

export interface Config {
  port: number;
  gatewayToken?: string;
  deviceToken?: string;
  rateWindowMs: number;
  rateMax: number;
  timeoutMs: number;
  maxPendingPerDevice: number;
  maxBodyBytes: number;
  trustProxy: boolean;
  allowedOrigins?: Set<string>;
  pingIntervalMs: number;
  pingMaxMisses: number;
  idleTimeoutSec: number;
}

export type Action = 'serve' | 'install' | 'uninstall';

const HELP = `Usage: code-mcp-gateway [options] [install|uninstall]
Options:
  --port <n>              Listen port (default: 8080)
  --token <s>             Gateway bearer token (client -> gateway auth)
                          Send via: Authorization: Bearer <token>
                                    or ?auth=<token>
  --device-token <s>      Device bearer token (device -> gateway auth at WS)
                          Send via: Authorization: Bearer <token>
                                    or ?auth=<token>
  --rate-window <ms>      Rate limit window (default: 60000)
  --rate-max <n>          Max requests per IP per window (default: 100)
  --timeout <ms>          Request timeout (default: 30000)
  --max-pending <n>       Max pending requests per device (default: 100)
  --max-body <bytes>      Max HTTP body bytes (default: 1048576)
  --trust-proxy           Trust X-Forwarded-For / X-Real-IP headers
  --allowed-origin <csv>  Comma-separated WS origin whitelist
  --ping-interval <ms>    WS ping interval (default: 30000)
  --ping-max-misses <n>   Drop WS after N missed pongs (default: 2)
  --idle-timeout <sec>    Bun WS idle timeout (default: 120)
  -h, --help              Show this help

Subcommands:
  install                 Install as user service (launchd/systemd)
  uninstall               Remove user service`;

function parsePosInt(v: string, name: string): number {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`Invalid value for ${name}: ${v}`);
    process.exit(1);
  }
  return n;
}

export function parseArgs(argv: string[]): { config: Config; action: Action } {
  const config: Config = {
    port: 8080,
    rateWindowMs: 60_000,
    rateMax: 100,
    timeoutMs: 30_000,
    maxPendingPerDevice: 100,
    maxBodyBytes: 1024 * 1024,
    trustProxy: false,
    pingIntervalMs: 30_000,
    pingMaxMisses: 2,
    idleTimeoutSec: 120,
  };
  let action: Action = 'serve';

  const take = (i: number, flag: string): string => {
    if (i + 1 >= argv.length) {
      console.error(`Missing value for ${flag}`);
      process.exit(1);
    }
    return argv[i + 1];
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--port':
        config.port = parsePosInt(take(i, arg), arg);
        i++;
        break;
      case '--token':
        config.gatewayToken = take(i, arg);
        i++;
        break;
      case '--device-token':
        config.deviceToken = take(i, arg);
        i++;
        break;
      case '--rate-window':
        config.rateWindowMs = parsePosInt(take(i, arg), arg);
        i++;
        break;
      case '--rate-max':
        config.rateMax = parsePosInt(take(i, arg), arg);
        i++;
        break;
      case '--timeout':
        config.timeoutMs = parsePosInt(take(i, arg), arg);
        i++;
        break;
      case '--max-pending':
        config.maxPendingPerDevice = parsePosInt(take(i, arg), arg);
        i++;
        break;
      case '--max-body':
        config.maxBodyBytes = parsePosInt(take(i, arg), arg);
        i++;
        break;
      case '--trust-proxy':
        config.trustProxy = true;
        break;
      case '--allowed-origin': {
        const csv = take(i, arg);
        i++;
        config.allowedOrigins = new Set(
          csv
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        );
        break;
      }
      case '--ping-interval':
        config.pingIntervalMs = parsePosInt(take(i, arg), arg);
        i++;
        break;
      case '--ping-max-misses':
        config.pingMaxMisses = parsePosInt(take(i, arg), arg);
        i++;
        break;
      case '--idle-timeout':
        config.idleTimeoutSec = parsePosInt(take(i, arg), arg);
        i++;
        break;
      case 'install':
        action = 'install';
        break;
      case 'uninstall':
        action = 'uninstall';
        break;
      case '-h':
      case '--help':
        console.log(HELP);
        process.exit(0);
      default:
        if (arg.startsWith('-')) {
          console.error(`Unknown flag: ${arg}`);
          console.error(HELP);
          process.exit(1);
        }
    }
  }
  return { config, action };
}

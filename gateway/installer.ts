import { mkdir, writeFile, unlink } from 'fs/promises';

const NAME = 'code-mcp-gateway';

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Quote for systemd ExecStart. systemd supports "..." with backslash escaping.
function systemdQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface InstallOpts {
  execPath: string;
  scriptPath?: string;
  port: number;
  token?: string;
  deviceToken?: string;
}

export async function installService(opts: InstallOpts): Promise<void> {
  const isMac = process.platform === 'darwin';
  const isLinux = process.platform === 'linux';
  if (!isMac && !isLinux) {
    console.error('install is only supported on Linux and macOS');
    process.exit(1);
  }

  const home = process.env.HOME;
  if (!home) {
    console.error('HOME env not set');
    process.exit(1);
  }

  if (!opts.token) {
    console.warn('WARNING: installing without --token. /mcp/* will be publicly accessible.');
  }
  if (!opts.deviceToken) {
    console.warn('WARNING: installing without --device-token. Any client may register as a device.');
  }

  const serviceDir = isMac ? `${home}/Library/LaunchAgents` : `${home}/.config/systemd/user`;
  await mkdir(serviceDir, { recursive: true });

  const argv: string[] = [opts.execPath];
  if (opts.scriptPath) argv.push(opts.scriptPath);
  argv.push('--port', String(opts.port));
  if (opts.token) argv.push('--token', opts.token);
  if (opts.deviceToken) argv.push('--device-token', opts.deviceToken);

  if (isMac) {
    const file = `${serviceDir}/${NAME}.plist`;
    const args = argv.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(NAME)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`;
    await writeFile(file, plist, { mode: 0o600 });
    console.log(`Installed: ${file}`);
    console.log(`Next: launchctl load ${shellSingleQuote(file)}`);
  } else {
    const file = `${serviceDir}/${NAME}.service`;
    const execLine = argv.map(systemdQuote).join(' ');
    const service = `[Unit]
Description=Prime

[Service]
ExecStart=${execLine}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
    await writeFile(file, service, { mode: 0o600 });
    console.log(`Installed: ${file}`);
    console.log(`Next: systemctl --user daemon-reload && systemctl --user enable --now ${NAME}`);
  }
}

export async function uninstallService(): Promise<void> {
  const isMac = process.platform === 'darwin';
  const isLinux = process.platform === 'linux';
  if (!isMac && !isLinux) {
    console.error('uninstall is only supported on Linux and macOS');
    process.exit(1);
  }

  const home = process.env.HOME || '';
  const serviceDir = isMac ? `${home}/Library/LaunchAgents` : `${home}/.config/systemd/user`;
  const file = isMac ? `${serviceDir}/${NAME}.plist` : `${serviceDir}/${NAME}.service`;
  // Legacy file from earlier versions
  const legacyShell = `${serviceDir}/${NAME}-start.sh`;

  for (const f of [file, legacyShell]) {
    try {
      await unlink(f);
      console.log(`Removed: ${f}`);
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e;
    }
  }
}

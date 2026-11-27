import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describeOptions, mergeOptions, optionsFromConfig, parseCodeMcpArgs, toCodeMcpArgv } from "../src/code-mcp-options.ts";
import { effectiveCodeMcpArgv, serviceEnv, splitHostFlags, withDefaultGateway } from "../src/code-mcp-host.ts";
import { codeMcpLaunch } from "../src/connect.ts";
import { installFleetAgent } from "../src/fleet-daemon.ts";
import { FLEET_AGENT_LABEL, FLEET_AGENT_NAME, bindServiceStatus, fleetAgentServiceConfig, fleetAgentSpec, sameConfig } from "../src/fleet-service.ts";
import { emptyConfig, loadConfig, parseConfig, saveConfig } from "../src/config.ts";
import { rememberAnonymous } from "../src/connect.ts";
import {
  captureNetworkEnv,
  definedServiceConfig,
  readServiceDefinition,
  loadServiceEnv,
  loadOverrides,
  parseLaunchdConfig,
  parseSystemdConfig,
  renderLaunchdPlist,
  renderSystemdUnit,
  installService,
  configOfTaskArguments,
  parseWindowsTaskProbe,
  renderWindowsTaskProbeScript,
  isFleetAgentAction,
  renderWindowsInstallScript,
  renderWindowsRetireOldAgentScript,
  serviceStatus,
  uninstallService,
  type Shell,
  renderWindowsUninstallScript,
  taskNameOf,
  saveOverrides,
  systemdQuote,
  systemdUserDirs,
  windowsQuote,
  type ServiceSpec,
} from "../src/service.ts";

describe("code-mcp config section", () => {
  test("is parsed: strings, numbers as text, booleans", () => {
    const c = parseConfig('devices: {}\ncode-mcp:\n  port: 7777\n  bind: "127.0.0.1"\n  enable-memory: true\n  id: demo\n', "t");
    expect(c.codeMcp).toEqual({ port: "7777", bind: "127.0.0.1", "enable-memory": true, id: "demo" });
  });

  test("survives every save - 'prime connect' must not drop it", () => {
    const dir = mkdtempSync(join(tmpdir(), "prime-svc-"));
    const path = join(dir, "config.yaml");
    const config = emptyConfig();
    config.codeMcp = { port: "7777", token: 'we"ird\\tok', "enable-memory": true };
    saveConfig(path, config);
    const loaded = loadConfig(path);
    rememberAnonymous(loaded, "https://gw.example", { deviceId: "anon-0123456789abcdef", token: "ABC123" }, undefined, "2026-01-01T00:00:00.000Z");
    saveConfig(path, loaded);
    expect(loadConfig(path).codeMcp).toEqual(config.codeMcp);
    expect(readFileSync(path, "utf8")).toContain("code-mcp:");
  });

  test("rejects a non-mapping section and non-scalar values", () => {
    expect(() => parseConfig("code-mcp: [1, 2]\n", "t")).toThrow("must be a mapping");
    expect(() => parseConfig("code-mcp:\n  port: [1]\n", "t")).toThrow("must be a string, number or true/false");
  });
});

describe("code-mcp options", () => {
  test("validates config keys and types", () => {
    expect(() => optionsFromConfig({ prot: "1" }, "cfg")).toThrow('unknown code-mcp option "prot"');
    expect(() => optionsFromConfig({ "enable-memory": "yes" }, "cfg")).toThrow("must be true or false");
    expect(() => optionsFromConfig({ port: true }, "cfg")).toThrow("must be a non-empty string");
  });

  test("parses --k v, --k=v, booleans, and a bare --gateway like code-mcp", () => {
    expect(parseCodeMcpArgs(["--port", "1", "--bind=0.0.0.0", "--enable-memory", "--public=false"]).options).toEqual({ port: "1", bind: "0.0.0.0", "enable-memory": true, public: false });
    expect(parseCodeMcpArgs(["--gateway", "--id", "x"]).options).toEqual({ gateway: "prime.tuanm.workers.dev", id: "x" });
    expect(parseCodeMcpArgs(["--help"]).help).toBe(true);
    expect(() => parseCodeMcpArgs(["--port"])).toThrow("needs a value");
    expect(() => parseCodeMcpArgs(["--nope", "1"])).toThrow("unknown code-mcp option");
    expect(() => parseCodeMcpArgs(["positional"])).toThrow("unexpected argument");
  });

  test("later layers win, false booleans are dropped, secrets are masked", () => {
    const merged = mergeOptions({ port: "1", "enable-memory": true, token: "s3cret" }, { port: "2" }, { "enable-memory": false });
    expect(toCodeMcpArgv(merged)).toEqual(["--port", "2", "--token", "s3cret"]);
    expect(describeOptions(merged)).toBe("--port 2 --token ***");
  });
});

describe("prime code-mcp argv", () => {
  test("host flags are split off; config + overrides + command line merge for the service", () => {
    const dir = mkdtempSync(join(tmpdir(), "prime-svc-"));
    const config = join(dir, "config.yaml");
    const c = emptyConfig();
    c.codeMcp = { port: "7777", token: "cfg-token", bind: "127.0.0.1" };
    saveConfig(config, c);
    saveOverrides(join(dir, "service.yaml"), { port: "8888", "enable-memory": true });
    expect((statSync(join(dir, "service.yaml")).mode & 0o777).toString(8)).toBe(process.platform === "win32" ? (statSync(join(dir, "service.yaml")).mode & 0o777).toString(8) : "600");

    const { host, rest } = splitHostFlags(["--service", "--config", config, "--bind", "0.0.0.0", "--log=/x.log"]);
    expect(host).toEqual({ service: true, config, log: "/x.log" });
    expect(effectiveCodeMcpArgv(rest, host, config).argv).toEqual(["--port", "8888", "--bind", "0.0.0.0", "--token", "cfg-token", "--enable-memory"]);
    // Not the service: the overrides file does not apply.
    expect(effectiveCodeMcpArgv([], { service: false }, config).argv).toEqual(["--port", "7777", "--bind", "127.0.0.1", "--token", "cfg-token"]);
    expect(loadOverrides(join(dir, "service.yaml"))).toEqual({ port: "8888", "enable-memory": true });
  });
});

describe("default gateway for a device id", () => {
  test("an id without a gateway goes to the configured default, else the managed one", () => {
    // code-mcp dials a gateway only with --gateway: an id alone used to start a
    // local-only server that never showed up on the gateway.
    expect(withDefaultGateway({ id: "demo", token: "demo" }, undefined)).toEqual({ id: "demo", token: "demo", gateway: "https://prime.tuanm.workers.dev" });
    expect(withDefaultGateway({ id: "demo" }, "https://gw.example")).toEqual({ id: "demo", gateway: "https://gw.example" });
    expect(withDefaultGateway({ id: "demo", gateway: "own.example" }, "https://gw.example").gateway).toBe("own.example");
    // No id: a plain local server, as before.
    expect(withDefaultGateway({ token: "t" }, undefined)).toEqual({ token: "t" });
  });

  test("'prime code-mcp' applies it", () => {
    const dir = mkdtempSync(join(tmpdir(), "prime-svc-"));
    const config = join(dir, "config.yaml");
    const c = emptyConfig();
    c.codeMcp = { id: "demo", token: "demo" };
    saveConfig(config, c);
    expect(effectiveCodeMcpArgv([], { service: false }, config).argv).toEqual(["--token", "demo", "--gateway", "https://prime.tuanm.workers.dev", "--id", "demo"]);
  });
});

describe("network settings for the service", () => {
  test("install captures proxy and CA variables, and nothing else", () => {
    const env = { HTTPS_PROXY: "http://u:p@proxy:8080", no_proxy: "localhost", NODE_EXTRA_CA_CERTS: "/etc/corp.pem", SSL_CERT_FILE: "  ", AWS_SECRET_ACCESS_KEY: "x", PATH: "/bin" };
    expect(captureNetworkEnv(env)).toEqual({ HTTPS_PROXY: "http://u:p@proxy:8080", no_proxy: "localhost", NODE_EXTRA_CA_CERTS: "/etc/corp.pem" });
  });

  test("they are saved privately with the overrides and read back", () => {
    const dir = mkdtempSync(join(tmpdir(), "prime-svc-"));
    const path = join(dir, "service.yaml");
    saveOverrides(path, { port: "7777" }, { HTTPS_PROXY: 'http://u:p"q@proxy:8080', NODE_EXTRA_CA_CERTS: "C:\\corp\\root.pem" });
    expect(loadServiceEnv(path)).toEqual({ HTTPS_PROXY: 'http://u:p"q@proxy:8080', NODE_EXTRA_CA_CERTS: "C:\\corp\\root.pem" });
    expect(loadOverrides(path)).toEqual({ port: "7777" });
    if (process.platform !== "win32") expect((statSync(path).mode & 0o777).toString(8)).toBe("600");
  });

  test("only known variables are ever applied from the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "prime-svc-"));
    const path = join(dir, "service.yaml");
    Bun.write(path, 'env:\n  HTTPS_PROXY: "http://p"\n  LD_PRELOAD: "/evil.so"\n');
    return Bun.sleep(10).then(() => expect(loadServiceEnv(path)).toEqual({ HTTPS_PROXY: "http://p" }));
  });

  test("the service and connect's child trust the OS certificate store unless told otherwise", () => {
    expect(serviceEnv({ PATH: "/bin" }, {}).NODE_USE_SYSTEM_CA).toBe("1");
    expect(serviceEnv({ NODE_USE_SYSTEM_CA: "0" }, {}).NODE_USE_SYSTEM_CA).toBe("0");
    expect(serviceEnv({}, { NODE_EXTRA_CA_CERTS: "/c.pem" }).NODE_EXTRA_CA_CERTS).toBe("/c.pem");
    expect(codeMcpLaunch("https://gw", { deviceId: "anon-0123456789abcdef", token: "ABC123" }, 1, []).env.NODE_USE_SYSTEM_CA).toBeDefined();
  });
});

describe("service definitions", () => {
  const spec: ServiceSpec = {
    command: ["/opt/my tools/prime", "code-mcp", "--service", "--config", "/home/u/.prime/config.yaml"],
    configPath: "/home/u/.prime/config.yaml",
    logPath: "/home/u/Library/Logs/prime/code-mcp.log",
    pathEnv: "/usr/local/bin:/usr/bin:/odd/100%/$HOME",
    home: "/home/u",
  };

  test("systemd: quoted ExecStart, % and $ escaped there, PATH kept literal", () => {
    const unit = renderSystemdUnit(spec);
    expect(unit).toContain('ExecStart="/opt/my tools/prime" "code-mcp" "--service" "--config" "/home/u/.prime/config.yaml"');
    expect(unit).toContain('Environment="PATH=/usr/local/bin:/usr/bin:/odd/100%%/$HOME"');
    expect(unit).toContain("Restart=on-failure");
    // Not quoted: systemd rejects a quoted WorkingDirectory as a bad setting.
    expect(unit).toContain("WorkingDirectory=/home/u\n");
    expect(unit).toContain("WantedBy=default.target");
    expect(systemdQuote('a"b\\c%d$e')).toBe('"a\\"b\\\\c%%d$$e"');
  });

  test("launchd: escaped XML, restart on crash only", () => {
    const plist = renderLaunchdPlist({ ...spec, command: ["/x/mcp", "code-mcp", "--config", "/a&b/<c>.yaml"] });
    expect(plist).toContain("<string>/a&amp;b/&lt;c&gt;.yaml</string>");
    expect(plist).toContain("<key>SuccessfulExit</key><false/>");
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
  });

  test("the fleet agent gets its own name, and comes back after any exit", () => {
    const agent = fleetAgentSpec("/home/u/.prime/config.yaml", "linux");
    const unit = renderSystemdUnit({ ...agent, command: ["/opt/prime", "__fleet-agent", "--config", "/home/u/.prime/config.yaml"] });
    // The unit name comes from the spec: the agent is not the buddy, and the two
    // cannot share a unit file.
    expect(agent.name).toBe(FLEET_AGENT_NAME);
    expect(unit).toContain("Description=Prime fleet agent");
    expect(unit).toContain('ExecStart="/opt/prime" "__fleet-agent" "--config" "/home/u/.prime/config.yaml"');
    // A buddy may exit cleanly; an agent that stops takes the fleet's place with it.
    expect(unit).toContain("Restart=always");
    const plist = renderLaunchdPlist(agent);
    expect(plist).toContain("<key>Label</key><string>" + FLEET_AGENT_LABEL + "</string>");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
  });

  test("Windows: CommandLineToArgvW quoting and a headless, per-user, logon task", () => {
    expect(windowsQuote("C:\\Program Files\\prime.exe")).toBe('"C:\\Program Files\\prime.exe"');
    expect(windowsQuote("plain")).toBe("plain");
    expect(windowsQuote('say "hi"')).toBe('"say \\"hi\\""');
    expect(windowsQuote("C:\\dir with space\\")).toBe('"C:\\dir with space\\\\"');
    const script = renderWindowsInstallScript({ ...spec, command: ["C:\\Users\\o'brien\\prime.exe", "code-mcp", "--service"] });
    expect(script).toContain("--headless C:\\Users\\o''brien\\prime.exe code-mcp --service");
    expect(script).toContain("-AtLogOn -User $user");
    expect(script).toContain("-LogonType Interactive -RunLevel Limited");
    expect(script).toContain("-RestartCount 999");
    // The watchdog trigger that actually restarts a crashed service.
    expect(script).toContain("-RepetitionInterval (New-TimeSpan -Minutes 1)");
    expect(script).toContain("-MultipleInstances IgnoreNew");
  });
});

describe("the Scheduled Task each Windows service is", () => {
  test("the fleet agent has a task of its own: installing it never replaces the buddy's", () => {
    const buddy = renderWindowsInstallScript({ command: ["prime.exe", "code-mcp", "--service"], configPath: "C:\\cfg\\config.yaml", logPath: "C:\\log", pathEnv: "", home: "C:\\Users\\o" });
    expect(buddy).toContain("-TaskName 'code-mcp'");
    const agent = renderWindowsInstallScript(fleetAgentSpec("C:\\cfg\\config.yaml", "win32"));
    expect(agent).toContain("-TaskPath '\\prime\\' -TaskName 'prime-fleet-agent'");
    expect(agent).not.toContain("-TaskName 'code-mcp'");
    expect(agent).not.toContain("installed by prime service install");
    expect(taskNameOf(fleetAgentSpec("x", "win32"))).toBe("prime-fleet-agent");
    expect(taskNameOf({})).toBe("code-mcp");
  });

  test("removing one stops its own task and processes, not the other's", () => {
    const agent = renderWindowsUninstallScript("C:\\cfg\\config.yaml", { name: FLEET_AGENT_NAME });
    expect(agent).toContain("-TaskName 'prime-fleet-agent'");
    expect(agent).toContain("Contains('__fleet-agent')");
    expect(agent).not.toContain("code-mcp");
    const buddy = renderWindowsUninstallScript("C:\\cfg\\config.yaml");
    expect(buddy).toContain("-TaskName 'code-mcp'");
    expect(buddy).toContain("Contains('code-mcp --service')");
  });
});

describe("which configuration a service runs", () => {
  // There is one service per machine and it runs one --config; everything else has to be able to tell.
  const awkward = "/home/a b/\"q\" & 100%/$x/config.yaml";
  const spec = (configPath: string) => ({ ...fleetAgentSpec(configPath), command: ["/usr/bin/prime", "__fleet-agent", "--config", configPath] });

  test("is read back from the definition, whatever the path holds", () => {
    expect(parseLaunchdConfig(renderLaunchdPlist(spec(awkward)))).toBe(awkward);
    expect(parseSystemdConfig(renderSystemdUnit(spec(awkward)))).toBe(awkward);
    expect(parseLaunchdConfig("<plist></plist>")).toBeUndefined();
    expect(parseSystemdConfig("[Service]\nExecStart=\"/bin/x\"\n")).toBeUndefined();
  });

  test("is found from the files of a home, without asking the manager", () => {
    const home = mkdtempSync(join(tmpdir(), "svc-home-"));
    try {
      const identity = { name: FLEET_AGENT_NAME, label: FLEET_AGENT_LABEL };
      expect(definedServiceConfig("darwin", identity, home, {})).toBeUndefined();
      mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
      writeFileSync(join(home, "Library", "LaunchAgents", FLEET_AGENT_LABEL + ".plist"), renderLaunchdPlist(spec("/cfg/a.yaml")));
      expect(definedServiceConfig("darwin", identity, home, {})).toBe("/cfg/a.yaml");
      mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
      writeFileSync(join(home, ".config", "systemd", "user", FLEET_AGENT_NAME + ".service"), renderSystemdUnit(spec("/cfg/b.yaml")));
      expect(definedServiceConfig("linux", identity, home, {})).toBe("/cfg/b.yaml");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a service that runs another configuration is not installed for this one", () => {
    const status = { installed: true, running: true, where: "w", pid: 42 };
    expect(bindServiceStatus(status, "/cfg/default.yaml", "/cfg/default.yaml")).toMatchObject({ installed: true, pid: 42 });
    const other = bindServiceStatus(status, "/cfg/default.yaml", "/cfg/other.yaml");
    expect(other.installed).toBe(false);
    expect(other.running).toBe(false);
    expect(other.pid).toBeUndefined();
    // A definition that does not say is taken as it is (an older install).
    expect(bindServiceStatus(status, undefined, "/cfg/other.yaml").installed).toBe(true);
  });

  test("the service is installed with an absolute path", () => {
    expect(fleetAgentSpec("rel/config.yaml").command.at(-1)).toBe(join(process.cwd(), "rel/config.yaml"));
  });

  test("numeric XML entities and the --config=path spelling are read", () => {
    const plist = "<plist><dict><key>ProgramArguments</key><array><string>/bin/prime</string><string>--config=/a&#38;b/&#x63;.yaml</string></array></dict></plist>";
    expect(parseLaunchdConfig(plist)).toBe("/a&b/c.yaml");
    expect(parseSystemdConfig('ExecStart="/bin/prime" "--config=/etc/c.yaml"\n')).toBe("/etc/c.yaml");
  });

  test("a relative path in an old definition is the one the manager runs: from the home, not from where the command is typed", () => {
    const home = mkdtempSync(join(tmpdir(), "svc-bind-"));
    try {
      mkdirSync(join(home, "cfg"), { recursive: true });
      writeFileSync(join(home, "cfg", "config.yaml"), "");
      const status = { installed: true, running: true, where: "w", pid: 7 };
      // The same file named absolutely, from anywhere: bound.
      expect(bindServiceStatus(status, "cfg/config.yaml", join(home, "cfg", "config.yaml"), home).installed).toBe(true);
      // Another configuration that happens to be spelled the same way relative to wherever it is typed: not.
      const elsewhere = join(home, "work", "cfg", "config.yaml");
      expect(bindServiceStatus(status, "cfg/config.yaml", elsewhere, home).installed).toBe(false);
      expect(sameConfig("cfg/config.yaml", "cfg/config.yaml", home)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("two spellings of one file (a symlink) are one configuration", () => {
    const root = mkdtempSync(join(tmpdir(), "svc-link-"));
    try {
      mkdirSync(join(root, "real"), { recursive: true });
      writeFileSync(join(root, "real", "config.yaml"), "");
      symlinkSync(join(root, "real"), join(root, "alias"));
      expect(sameConfig(join(root, "real", "config.yaml"), join(root, "alias", "config.yaml"), root)).toBe(true);
      expect(sameConfig(join(root, "real", "config.yaml"), join(root, "alias", "other.yaml"), root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a definition that does not say is the default configuration's (not whatever PRIME_CONFIG names), and binds no other", () => {
    const was = process.env.PRIME_CONFIG;
    process.env.PRIME_CONFIG = "/elsewhere/x.yaml";
    try {
      expect(fleetAgentServiceConfig(null)).toBeUndefined();
      expect(fleetAgentServiceConfig({ config: "/cfg/x.yaml" })).toBe("/cfg/x.yaml");
      const runs = fleetAgentServiceConfig({ config: undefined })!;
      expect(runs).toBe(join(homedir(), ".prime", "config.yaml"));
      const status = { installed: true, running: true, where: "w" };
      expect(bindServiceStatus(status, runs, join(homedir(), ".prime", "config.yaml")).installed).toBe(true);
      // The configuration the environment points at is not the one the unreadable service runs.
      expect(bindServiceStatus(status, runs, "/elsewhere/x.yaml").installed).toBe(false);
      expect(bindServiceStatus(status, runs, "/some/other/config.yaml").installed).toBe(false);
    } finally {
      if (was === undefined) delete process.env.PRIME_CONFIG;
      else process.env.PRIME_CONFIG = was;
    }
  });

  test("a systemd drop-in that overrides ExecStart decides which configuration the service runs", () => {
    const unit = renderSystemdUnit(fleetAgentSpec("/cfg/a.yaml", "linux"));
    expect(parseSystemdConfig(unit)).toBe("/cfg/a.yaml");
    // `ExecStart=` clears the unit's, the next one is the command; with no reset the last one still wins (as systemd's, for a simple service).
    expect(parseSystemdConfig(unit + '\n[Service]\nExecStart=\nExecStart="/bin/prime" "__fleet-agent" "--config" "/cfg/b.yaml"\n')).toBe("/cfg/b.yaml");
    expect(parseSystemdConfig(unit + '\n[Service]\nExecStart="/bin/prime" "--config" "/cfg/c.yaml"\n')).toBe("/cfg/c.yaml");
    // Cleared and not replaced: nothing runs, so it does not say.
    expect(parseSystemdConfig(unit + "\n[Service]\nExecStart=\n")).toBeUndefined();

    const home = mkdtempSync(join(tmpdir(), "svc-dropin-"));
    try {
      const identity = { name: FLEET_AGENT_NAME, label: FLEET_AGENT_LABEL };
      const dir = join(home, ".config", "systemd", "user");
      mkdirSync(join(dir, FLEET_AGENT_NAME + ".service.d"), { recursive: true });
      writeFileSync(join(dir, FLEET_AGENT_NAME + ".service"), unit);
      expect(readServiceDefinition("linux", identity, home, {})).toEqual({ config: "/cfg/a.yaml" });
      writeFileSync(join(dir, FLEET_AGENT_NAME + ".service.d", "override.conf"), '[Service]\nExecStart=\nExecStart="/bin/prime" "__fleet-agent" "--config" "/cfg/b.yaml"\n');
      writeFileSync(join(dir, FLEET_AGENT_NAME + ".service.d", "notes.txt"), '[Service]\nExecStart="/bin/x" "--config" "/ignored.yaml"\n');
      expect(readServiceDefinition("linux", identity, home, {})).toEqual({ config: "/cfg/b.yaml" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a drop-in from the machine's own directory (/etc/systemd/user) counts too, and the user's masks it by name", () => {
    const unit = renderSystemdUnit(fleetAgentSpec("/cfg/a.yaml", "linux"));
    const home = mkdtempSync(join(tmpdir(), "svc-dropin-sys-"));
    try {
      const identity = { name: FLEET_AGENT_NAME, label: FLEET_AGENT_LABEL };
      const user = join(home, ".config", "systemd", "user");
      const machine = join(home, "etc-systemd-user");
      mkdirSync(user, { recursive: true });
      mkdirSync(join(machine, FLEET_AGENT_NAME + ".service.d"), { recursive: true });
      writeFileSync(join(user, FLEET_AGENT_NAME + ".service"), unit);
      const roots = [user, machine];
      const dropIn = (dir: string, file: string, config: string): void => {
        mkdirSync(join(dir, FLEET_AGENT_NAME + ".service.d"), { recursive: true });
        writeFileSync(join(dir, FLEET_AGENT_NAME + ".service.d", file), '[Service]\nExecStart=\nExecStart="/bin/prime" "__fleet-agent" "--config" "' + config + '"\n');
      };
      expect(readServiceDefinition("linux", identity, home, {}, roots)).toEqual({ config: "/cfg/a.yaml" });
      dropIn(machine, "10-machine.conf", "/cfg/machine.yaml");
      expect(readServiceDefinition("linux", identity, home, {}, roots)).toEqual({ config: "/cfg/machine.yaml" });
      // Files merge by name, whichever directory they are in: the later name wins.
      dropIn(user, "20-user.conf", "/cfg/user.yaml");
      expect(readServiceDefinition("linux", identity, home, {}, roots)).toEqual({ config: "/cfg/user.yaml" });
      // The same name in a directory of higher priority replaces the machine's file instead of adding one.
      dropIn(user, "10-machine.conf", "/cfg/masked.yaml");
      writeFileSync(join(user, FLEET_AGENT_NAME + ".service.d", "20-user.conf"), "[Service]\n# nothing\n");
      expect(readServiceDefinition("linux", identity, home, {}, roots)).toEqual({ config: "/cfg/masked.yaml" });
      // The default list of directories names the machine's.
      expect(systemdUserDirs({}, home)).toContain("/etc/systemd/user");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a definition that exists and does not say is told apart from none", () => {
    const home = mkdtempSync(join(tmpdir(), "svc-def-"));
    try {
      const identity = { name: FLEET_AGENT_NAME, label: FLEET_AGENT_LABEL };
      expect(readServiceDefinition("darwin", identity, home, {})).toBeUndefined();
      mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
      writeFileSync(join(home, "Library", "LaunchAgents", FLEET_AGENT_LABEL + ".plist"), Buffer.from("bplist00\u0001\u0002", "latin1"));
      expect(readServiceDefinition("darwin", identity, home, {})).toEqual({ config: undefined });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("the fleet agent an earlier Windows build registered as the buddy's task", () => {
  const AGENT = fleetAgentSpec("C:\\cfg\\config.yaml", "win32");
  const agentArguments = "--headless prime.exe __fleet-agent --config C:\\cfg\\config.yaml";
  const buddyArguments = "--headless prime.exe code-mcp --service --config C:\\cfg\\config.yaml";

  // A Task Scheduler with `\prime\code-mcp` registered to run `argument` (or nothing), and what was asked of it.
  function scheduler(oldTask: { argument: string; state?: string } | undefined, own = false) {
    const calls: string[] = [];
    let oldPresent = oldTask !== undefined;
    let ownPresent = own;
    const shell: Shell = {
      run(cmd) {
        calls.push(cmd.join(" "));
        const named = cmd[cmd.length - 1] ?? "";
        if (named === "\\prime\\code-mcp") return { code: oldPresent ? 0 : 1, out: "", err: "" };
        if (named === "\\prime\\prime-fleet-agent") return { code: ownPresent ? 0 : 1, out: "", err: "" };
        return { code: 1, out: "", err: "" };
      },
      powershell(script) {
        calls.push(script);
        if (script.includes("Unregister-ScheduledTask -TaskPath '\\prime\\' -TaskName 'code-mcp'")) {
          // the script's own guard, evaluated here as PowerShell would
          const guard = script.includes("$arguments.Contains('__fleet-agent') -and -not $arguments.Contains('code-mcp --service')");
          if (oldPresent && guard && isFleetAgentAction(oldTask!.argument)) {
            oldPresent = false;
            return { code: 0, out: "removed\n", err: "" };
          }
          return { code: 0, out: "absent\n", err: "" };
        }
        if (script.includes("Unregister-ScheduledTask") && script.includes("prime-fleet-agent")) {
          const had = ownPresent;
          ownPresent = false;
          return { code: 0, out: had ? "removed\n" : "absent\n", err: "" };
        }
        if (script.includes("Get-ScheduledTask -TaskPath '\\prime\\' -TaskName 'code-mcp'") && script.includes("'task '")) {
          return { code: 0, out: oldPresent ? "task " + (oldTask!.state ?? "Ready") + "\narguments " + oldTask!.argument + "\n" : "", err: "" };
        }
        if (script.includes("Get-ScheduledTask -TaskPath '\\prime\\' -TaskName 'prime-fleet-agent'") && script.includes("'task '")) {
          return { code: 0, out: ownPresent ? "task Ready\narguments " + agentArguments + "\n" : "", err: "" };
        }
        if (script.includes("Register-ScheduledTask")) { ownPresent = true; return { code: 0, out: "", err: "" }; }
        return { code: 0, out: "False", err: "" };
      },
    };
    return { shell, calls, oldPresent: () => oldPresent, ownPresent: () => ownPresent };
  }

  test("is told apart by what it runs", () => {
    expect(isFleetAgentAction(agentArguments)).toBe(true);
    expect(isFleetAgentAction(buddyArguments)).toBe(false);
    expect(isFleetAgentAction("")).toBe(false);
  });

  test("installing the agent removes the old task, and then registers its own", () => {
    const s = scheduler({ argument: agentArguments });
    installService("win32", AGENT, s.shell);
    expect(s.oldPresent()).toBe(false);
    expect(s.ownPresent()).toBe(true);
  });

  test("the buddy's task is never touched by installing or removing the agent", () => {
    const s = scheduler({ argument: buddyArguments }, true);
    installService("win32", AGENT, s.shell);
    expect(s.oldPresent()).toBe(true);
    uninstallService("win32", "C:\\cfg\\config.yaml", { name: FLEET_AGENT_NAME }, s.shell);
    expect(s.oldPresent()).toBe(true);
    expect(s.calls.join("\n")).not.toContain("Unregister-ScheduledTask -TaskPath '\\prime\\' -TaskName 'code-mcp'");
  });

  test("the retiring script guards itself, and only stops the agent's process, not the buddy's", () => {
    const script = renderWindowsRetireOldAgentScript("C:\\cfg\\config.yaml");
    expect(script).toContain("$arguments.Contains('__fleet-agent') -and -not $arguments.Contains('code-mcp --service')");
    expect(script).toContain("Contains('__fleet-agent')");
    expect(script).not.toMatch(/Contains\('code-mcp --service'\) -and \$_/);
  });

  test("uninstalling the agent removes the old task too, and says there was one", () => {
    const s = scheduler({ argument: agentArguments });
    expect(uninstallService("win32", "C:\\cfg\\config.yaml", { name: FLEET_AGENT_NAME }, s.shell)).toBe(true);
    expect(s.oldPresent()).toBe(false);
  });

  test("its status says it is there, whether it runs, and that installing again moves it", () => {
    const running = serviceStatus("win32", "C:\\cfg\\config.yaml", { name: FLEET_AGENT_NAME }, scheduler({ argument: agentArguments, state: "Running" }).shell);
    expect(running).toMatchObject({ installed: true, running: true, where: "Task Scheduler \\prime\\code-mcp" });
    expect(running.detail).toContain("install it again");
    const ready = serviceStatus("win32", "C:\\cfg\\config.yaml", { name: FLEET_AGENT_NAME }, scheduler({ argument: agentArguments, state: "Ready" }).shell);
    expect(ready).toMatchObject({ installed: true, running: false });
  });

  test("the status of the agent does not take the buddy's task for its own, nor does a machine with neither", () => {
    expect(serviceStatus("win32", "C:\\cfg\\config.yaml", { name: FLEET_AGENT_NAME }, scheduler({ argument: buddyArguments }).shell).installed).toBe(false);
    expect(serviceStatus("win32", "C:\\cfg\\config.yaml", { name: FLEET_AGENT_NAME }, scheduler(undefined).shell).installed).toBe(false);
  });

  test("the configuration an old task runs is read from its command line, quoted or not", () => {
    expect(configOfTaskArguments(agentArguments)).toBe("C:\\cfg\\config.yaml");
    expect(configOfTaskArguments('--headless prime.exe __fleet-agent --config "C:\\Users\\a b\\config.yaml"')).toBe("C:\\Users\\a b\\config.yaml");
    expect(configOfTaskArguments("--headless prime.exe __fleet-agent")).toBeUndefined();
  });

  test("an old task that runs another configuration is left alone, and status says whose it is", () => {
    const other = "--headless prime.exe __fleet-agent --config D:\\other\\config.yaml";
    const s = scheduler({ argument: other, state: "Running" });
    installService("win32", AGENT, s.shell);
    expect(s.oldPresent()).toBe(true);
    expect(s.ownPresent()).toBe(true);
    expect(uninstallService("win32", "C:\\cfg\\config.yaml", { name: FLEET_AGENT_NAME }, s.shell)).toBe(true); // its own, removed
    expect(s.oldPresent()).toBe(true);
    const status = serviceStatus("win32", "C:\\cfg\\config.yaml", { name: FLEET_AGENT_NAME }, scheduler({ argument: other }).shell);
    expect(status.installed).toBe(false);
    expect(status.detail).toContain("D:\\other\\config.yaml");
    expect(status.detail).toContain("--config");
    // and it is that configuration's own when asked from it
    expect(serviceStatus("win32", "D:\\other\\config.yaml", { name: FLEET_AGENT_NAME }, scheduler({ argument: other }).shell).installed).toBe(true);
  });

  test("an old agent task that does not say its configuration is not taken for this one's", () => {
    const s = scheduler({ argument: "--headless prime.exe __fleet-agent" });
    installService("win32", AGENT, s.shell);
    expect(s.oldPresent()).toBe(true);
  });

  test("what the scripts print is read as UTF-8, so a path with a non-ASCII character round-trips", () => {
    expect(renderWindowsTaskProbeScript("prime-fleet-agent")).toContain("[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false");
    expect(renderWindowsTaskProbeScript()).toContain("[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false");
    expect(renderWindowsRetireOldAgentScript("C:\\cfg\\config.yaml")).toContain("[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false");
    const config = "C:\\Users\\Nguy\u1ec5n \u00c9mile\\.prime\\config.yaml";
    // as the probe prints it (with the byte order mark a host may add), read back, and compared
    const printed = "\uFEFFtask Ready\r\narguments --headless prime.exe __fleet-agent --config " + windowsQuote(config) + "\r\n";
    const probed = parseWindowsTaskProbe(printed)!;
    expect(probed.state).toBe("Ready");
    expect(configOfTaskArguments(probed.argument)).toBe(config);
    expect(parseWindowsTaskProbe("")).toBeUndefined();
  });

  test("the configuration the task of its own runs is its definition, so another configuration's install is refused", async () => {
    const own = (argument: string | undefined): Shell => ({
      run: (cmd) => ({ code: argument === undefined && cmd.join(" ").includes("prime-fleet-agent") ? 1 : 0, out: "", err: "" }),
      powershell: (script) => ({ code: 0, out: argument !== undefined && script.includes("'prime-fleet-agent'") ? "task Running\narguments " + argument + "\n" : "", err: "" }),
    });
    const identity = { name: FLEET_AGENT_NAME };
    const definition = readServiceDefinition("win32", identity, undefined, undefined, undefined, own(agentArguments));
    expect(definition).toEqual({ config: "C:\\cfg\\config.yaml" });
    expect(readServiceDefinition("win32", identity, undefined, undefined, undefined, own(undefined))).toBeUndefined();
    // what installFleetAgent compares with: another configuration is refused
    await expect(installFleetAgent("D:\\other\\config.yaml", { install: () => "x", boundTo: () => fleetAgentServiceConfig(definition ?? null) })).rejects.toThrow(/installed for C:\\cfg\\config.yaml/);
  });

  test("the scripts that only read guard the output encoding, which throws without a console", () => {
    const set = "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false";
    for (const script of [renderWindowsTaskProbeScript(), renderWindowsTaskProbeScript("prime-fleet-agent"), renderWindowsRetireOldAgentScript("C:\\cfg\\config.yaml")]) {
      expect(script).toContain("try { " + set + " } catch {}");
    }
  });

  test("a status asks Task Scheduler about the agent's task once, for what it runs and whether it runs", () => {
    const s = scheduler(undefined, true);
    const definition = readServiceDefinition("win32", { name: FLEET_AGENT_NAME }, undefined, undefined, undefined, s.shell);
    const status = serviceStatus("win32", "C:\\cfg\\config.yaml", { name: FLEET_AGENT_NAME }, s.shell);
    expect(definition).toEqual({ config: "C:\\cfg\\config.yaml" });
    expect(status.installed).toBe(true);
    const scripts = s.calls.filter((c) => c.includes("Get-ScheduledTask"));
    expect(scripts).toHaveLength(1);
    expect(s.calls.filter((c) => c.startsWith("schtasks"))).toHaveLength(1);
  });

  test("what was seen of a task is forgotten when it is installed, so the status after is what is there", () => {
    const s = scheduler({ argument: agentArguments });
    expect(serviceStatus("win32", "C:\\cfg\\config.yaml", { name: FLEET_AGENT_NAME }, s.shell).detail).toContain("install it again");
    installService("win32", AGENT, s.shell); // retires the old, registers its own
    const after = serviceStatus("win32", "C:\\cfg\\config.yaml", { name: FLEET_AGENT_NAME }, s.shell);
    expect(after.where).toBe("Task Scheduler \\prime\\prime-fleet-agent");
    expect(after.installed).toBe(true);
  });

  test("a task of its own is reported as it is, and the old one is not looked up", () => {
    const s = scheduler(undefined, true);
    expect(serviceStatus("win32", "C:\\cfg\\config.yaml", { name: FLEET_AGENT_NAME }, s.shell).where).toBe("Task Scheduler \\prime\\prime-fleet-agent");
    expect(s.calls.some((c) => c.includes("\\prime\\code-mcp"))).toBe(false);
  });
});

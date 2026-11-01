import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeOptions, mergeOptions, optionsFromConfig, parseCodeMcpArgs, toCodeMcpArgv } from "../src/code-mcp-options.ts";
import { effectiveCodeMcpArgv, serviceEnv, splitHostFlags, withDefaultGateway } from "../src/code-mcp-host.ts";
import { codeMcpLaunch } from "../src/connect.ts";
import { emptyConfig, loadConfig, parseConfig, saveConfig } from "../src/config.ts";
import { rememberAnonymous } from "../src/connect.ts";
import {
  captureNetworkEnv,
  loadServiceEnv,
  loadOverrides,
  renderLaunchdPlist,
  renderSystemdUnit,
  renderWindowsInstallScript,
  saveOverrides,
  systemdQuote,
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

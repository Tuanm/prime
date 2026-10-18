// CodeMCP.java - Minimal MCP server over HTTP with Streamable HTTP transport and JSON-RPC 2.0
// JDK 21+ with NO external libraries - built-in JDK APIs only

import com.sun.net.httpserver.*;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import javax.net.ssl.*;
import java.io.*;
import java.net.*;
import java.net.http.*;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.*;
import java.util.stream.*;

/**
 * Minimal MCP server over HTTP (Streamable HTTP transport, JSON-RPC 2.0).
 *
 * Tools (always on): read, write, edit, multi_edit, bash, shell, command, powershell, grep, find, ls, job, mcp.
 * Tools (conditional):
 *   - preview              enabled only if cloudflared is on PATH
 *   - remember, forget, recall  enabled only with --enable-memory
 *   - get_upload_link      enabled only with --public or --domain
 *
 * Shell tools: only one enabled based on detected shell (bash/shell/command/powershell).
 */
public final class CodeMCP {

    // ===== CONSTANTS =====
    private static final int DEFAULT_PORT = 7777;
    private static final String DEFAULT_GATEWAY = "code-mcp.tuanm.workers.dev"; // bare --gateway
    private static final int OUTPUT_CAP_MAX = 1_000_000;
    private static final int OUTPUT_CAP_KEEP = 500_000;
    private static final int RESULT_SPILL_THRESHOLD = 10_000;
    private static final int RESULT_SPILL_HEAD = 3_000;
    private static final int UPLOAD_TTL_MS = 10 * 60 * 1000;
    private static final int MEMO_TAIL_BYTES = 8192;
    private static final int MAX_CONCURRENT_JOBS = 10;
    private static final int MAX_SHELL_SEMAPHORE_PERMITS = 5;
    private static final long MAX_UPLOAD_BYTES = 100L * 1024 * 1024;
    private static final long MAX_UPLOAD_BODY_BYTES = MAX_UPLOAD_BYTES + 1024 * 1024;
    private static final long MAX_WS_FRAME_BYTES = 64L * 1024 * 1024;
    private static final int MAX_GATEWAY_HEADER_BYTES = 64 * 1024;
    private static final int MAX_REQUEST_BYTES = 100 * 1024 * 1024;
    private static final long MAX_READ_BYTES = 100L * 1024 * 1024; // cap single-file reads (memory DoS guard)
    private static final int MAX_HTTP_THREADS = 64;
    private static final String DEFAULT_BIND = "127.0.0.1";
    private static final int MAX_RETRIES = 30;
    private static final long RECONNECT_DELAY_MS = 3000L;
    private static final long DEFAULT_SHELL_TIMEOUT_MS = 60_000L;

    private static String timeoutMarker(long ms) {
        return "\n[TIMEOUT after " + ms + "ms — long-running? use the `job` tool: "
            + "mode=start to launch, mode=view to check progress]";
    }

    private static String backgroundedMarker(long ms, String jobId) {
        return "\n[BACKGROUNDED after " + ms + "ms — process still running as job " + jobId + ". "
            + "Above output is a snapshot at handoff; further output continues into the job. "
            + "Use `job` tool: mode=view command=" + jobId + " to read, mode=stop command=" + jobId + " to kill. "
            + "Pass explicit timeout_ms to disable auto-background and force kill-on-timeout instead.]";
    }

    // Allow-list of env vars to forward to spawned children. Limits blast radius
    // of MCP token compromise: even if the token leaks, AWS_*/OPENAI_API_KEY/etc.
    // are not handed to user-invoked commands or external MCP children.
    private static final Set<String> SPAWN_ENV_ALLOWLIST = Set.of(
        "PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
        "TMPDIR", "TEMP", "TMP",
        "SystemRoot", "SystemDrive", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
        "PROGRAMFILES", "PROGRAMDATA", "WINDIR", "COMSPEC", "PATHEXT",
        // Non-secret Windows system variables. PSModulePath matters most: without it
        // Windows PowerShell rebuilds its module cache on every start ("Preparing
        // modules for first use"), which made each PowerShell command - and the job
        // helper compile - take 10-30 s instead of well under one.
        "PSModulePath", "PROGRAMFILES(X86)", "PROGRAMW6432", "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "COMMONPROGRAMW6432",
        "ALLUSERSPROFILE", "PUBLIC", "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "USERNAME", "COMPUTERNAME", "HOMEDRIVE", "HOMEPATH"
    );

    private static void scrubEnv(ProcessBuilder pb) {
        Map<String, String> env = pb.environment();
        env.keySet().removeIf(k -> isWindows
            ? SPAWN_ENV_ALLOWLIST.stream().noneMatch(allowed -> allowed.equalsIgnoreCase(k))
            : !SPAWN_ENV_ALLOWLIST.contains(k));
    }

    private static void putMcpEnv(ProcessBuilder builder, String name, String value) {
        Map<String, String> env = builder.environment();
        if (isWindows) env.keySet().removeIf(key -> key.equalsIgnoreCase(name));
        env.put(name, value);
    }

    // ===== STATIC STATE =====
    private static final Map<String, Job> jobs = new ConcurrentHashMap<>();
    private static final AtomicInteger jobSeq = new AtomicInteger(0);
    private static final Semaphore shellSemaphore = new Semaphore(MAX_SHELL_SEMAPHORE_PERMITS, true);
    private static volatile boolean shuttingDown = false;

    // ===== MCP SERVER STATE =====
    private static final Map<String, Process> mcpProcesses = new ConcurrentHashMap<>(); // key: "cwd:serverName" (stdio)
    private record McpStdioSetup(long deadline, CompletableFuture<Void> done) {}
    private static final Map<Process, McpStdioSetup> mcpStdioSetups = new ConcurrentHashMap<>();
    private static final Map<String, Map<String, Object>> mcpHttp = new ConcurrentHashMap<>(); // key: "cwd:serverName" -> {url,headers,session_id}
    private static final Map<Process, String> mcpProcessConfigSignatures = Collections.synchronizedMap(new WeakHashMap<>());

    private static final Object mcpIdleLock = new Object();
    private static final Map<Process, McpIdleState> mcpIdleStates = new WeakHashMap<>();
    private static final class McpIdleState {
        final long timeoutNanos;
        int users = 1;
        long generation;
        boolean retired;
        ScheduledFuture<?> timer;
        McpIdleState(long timeoutMs) { timeoutNanos = TimeUnit.MILLISECONDS.toNanos(timeoutMs); }
    }
    private static final ScheduledThreadPoolExecutor MCP_IDLE_TIMER = new ScheduledThreadPoolExecutor(1, r -> {
        Thread thread = new Thread(r, "mcp-idle");
        thread.setDaemon(true);
        return thread;
    });
    static {
        MCP_IDLE_TIMER.setRemoveOnCancelPolicy(true);
        MCP_IDLE_TIMER.setExecuteExistingDelayedTasksAfterShutdownPolicy(false);
    }

    private static long mcpIdleTimeout(Map<String, Object> cfg) {
        return ((Number) cfg.getOrDefault("idleTimeoutMs", 600000)).longValue();
    }

    private static void mcpIdleRegister(Process proc, long timeoutMs) {
        synchronized (mcpIdleLock) { mcpIdleStates.put(proc, new McpIdleState(timeoutMs)); }
    }

    private static void mcpIdleCancel(McpIdleState state) {
        state.generation++;
        if (state.timer != null) { state.timer.cancel(false); state.timer = null; }
    }

    private static boolean mcpIdleRetired(Process proc) {
        synchronized (mcpIdleLock) {
            McpIdleState state = mcpIdleStates.get(proc);
            return state != null && state.retired;
        }
    }

    private static boolean mcpIdleAcquire(Process proc) {
        synchronized (mcpIdleLock) {
            McpIdleState state = mcpIdleStates.get(proc);
            if (state == null) return true;
            if (state.retired) return false;
            state.users++;
            mcpIdleCancel(state);
            return true;
        }
    }

    private static void mcpIdleRetire(Process proc) {
        synchronized (mcpIdleLock) {
            McpIdleState state = mcpIdleStates.get(proc);
            if (state != null) { state.retired = true; mcpIdleCancel(state); }
        }
    }

    private static void mcpIdleRelease(Process proc) {
        synchronized (mcpIdleLock) {
            McpIdleState state = mcpIdleStates.get(proc);
            if (state == null) return;
            state.users--;
            if (state.users != 0 || state.retired || state.timeoutNanos <= 0 || shuttingDown) return;
            long generation = ++state.generation;
            state.timer = MCP_IDLE_TIMER.schedule(() -> {
                synchronized (mcpIdleLock) {
                    if (state.generation != generation || state.users != 0 || state.retired || shuttingDown) return;
                    state.retired = true;
                    state.timer = null;
                }
                // Cleanup never holds the idle lock or looks up a replacement key.
                closeMcpStdio(proc, "MCP subprocess idle timeout");
            }, state.timeoutNanos, TimeUnit.NANOSECONDS);
        }
    }
    private static final Map<String, List<String>> mcpServerTools = new ConcurrentHashMap<>(); // key: "cwd:serverName"
    private static int mcpNextId = 0;
    private static final Object mcpIdLock = new Object();

    // ===== AGGREGATOR STATE (boot-time --mcp probe, parity with TS) =====
    private record AggregatedTool(String ns, String tool, String description, Map<String, Object> inputSchema, Map<String, Object> definition) {}
    private static final Map<String, Process> aggregatorProcesses = new ConcurrentHashMap<>(); // key: namespace (stdio)
    private static final Map<String, Map<String, Object>> aggregatorStdioConfigs = new ConcurrentHashMap<>();
    private static final Map<String, CompletableFuture<Process>> aggregatorStdioSetups = new ConcurrentHashMap<>();
    private static final Map<String, Map<String, Object>> aggregatorHttpConfigs = new ConcurrentHashMap<>();
    private static final Map<String, CompletableFuture<McpHttpCancellation>> aggregatorHttpSetups = new ConcurrentHashMap<>();
    private static final Map<String, Map<String, Object>> aggregatorHttp = new ConcurrentHashMap<>(); // ns -> {url, headers, session_id}
    private static final Map<String, BufferedReader> aggregatorReaders = new ConcurrentHashMap<>();
    private static final Map<String, Object> aggregatorLocks = new ConcurrentHashMap<>();
    private static final Map<String, AggregatedTool> aggregatorTools = new ConcurrentHashMap<>(); // prefixed name -> info
    private static final Set<String> aggregatorKnown = ConcurrentHashMap.newKeySet(); // all ns declared in --mcp
    private static final AtomicInteger aggregatorNextId = new AtomicInteger(0);
    private static final long AGGREGATOR_HTTP_MAX_RESP = 16L * 1024 * 1024; // memory-DoS guard
    private static final Pattern AGGREGATOR_NS_RE = Pattern.compile("^[A-Za-z][A-Za-z0-9_-]{0,63}$");

    // ===== CONFIGURATION =====
    private static int port = DEFAULT_PORT;
    private static String bindAddr = DEFAULT_BIND;
    private static String token = null;
    private static String gatewayToken = null;  // device credential for the /ws upgrade (defaults to token)
    private static boolean memoryEnabled = false;
    private static boolean makePublic = false;
    private static String domain = null;
    private static String mcpConfigPath = null;
    private static String publicBaseUrl = null;
    private record PublicTunnel(String url, Job job) {}
    private static volatile PublicTunnel publicTunnel;
    private static String resolvedPublicBaseUrl() {
        if (domain != null) return publicBaseUrl;
        PublicTunnel state = publicTunnel;
        return state != null && state.job().process.isAlive() ? state.url() : null;
    }

    private static String gatewayDomain = null;
    private static String assignedDeviceId = null;
    private static final Set<String> disallowedTools = new HashSet<>();
    private static String uploadRoot;
    private static String spillRoot;
    private static boolean hasRg = false;
    private static boolean hasFindstr = false;
    private static boolean hasCloudflared = false;
    private static ShellType detectedShell = ShellType.SH;
    private static boolean isWindows = false;

    // ===== SHELL TYPES =====
    private enum ShellType { BASH, SH, CMD, POWERSHELL }

    // ===== MAIN ENTRY POINT =====
    public static void main(String[] args) throws Exception {

        System.err.println("[main] starting...");
        parseArgs(args);

        isWindows = System.getProperty("os.name").toLowerCase().startsWith("windows");
        detectedShell = detectShell();

        // Detect optional binaries
        hasRg = hasOnPath("rg");
        hasFindstr = hasOnPath("findstr");
        hasCloudflared = hasOnPath("cloudflared");

        // Set upload root
        String osName = System.getProperty("os.name");
        if (osName.equals("Mac OS X")) {
            uploadRoot = "/private/tmp";
        } else if (osName.equals("Linux")) {
            uploadRoot = "/tmp";
        } else {
            uploadRoot = System.getProperty("java.io.tmpdir");
        }
        uploadRoot = Path.of(uploadRoot, "code-mcp", "uploads").toString();

        // Prepare spill directory (parity with Python/TS):
        // spill files hold tool output (potentially secrets), so keep the root
        // private (0700) and sweep files older than 24h so a long session can't
        // fill the disk or leave world-readable data behind.
        spillRoot = Path.of(System.getProperty("java.io.tmpdir"), "code-mcp").toString();
        try {
            Files.createDirectories(Path.of(spillRoot));
            try {
                Files.setPosixFilePermissions(Path.of(spillRoot),
                    java.nio.file.attribute.PosixFilePermissions.fromString("rwx------"));
            } catch (UnsupportedOperationException ignored) {}
            long cutoff = System.currentTimeMillis() - 86_400_000L;
            try (var stream = Files.list(Path.of(spillRoot))) {
                stream.forEach(p -> {
                    try {
                        if (Files.isRegularFile(p)
                                && Files.getLastModifiedTime(p).toMillis() < cutoff) {
                            Files.deleteIfExists(p);
                        }
                    } catch (IOException ignored) {}
                });
            }
        } catch (IOException e) {
            System.err.println("[spill] warning: " + spillRoot + ": " + e.getMessage());
        }

        // Set public base URL
        if (domain != null) {
            publicBaseUrl = "https://" + domain;
        }

        // Create HTTP server bound to selected address (default 127.0.0.1).
        HttpServer server = HttpServer.create(new InetSocketAddress(bindAddr, port), 0);

        // Routes
        server.createContext("/mcp", new MCPRouteHandler());
        server.createContext("/upload/", new UploadRouteHandler());

        // Let bounded concurrency grow before queuing: eight blocked tool calls
        // must not keep unload/control requests behind them in a 256-item queue.
        ThreadPoolExecutor httpExecutor = new ThreadPoolExecutor(
            MAX_HTTP_THREADS, MAX_HTTP_THREADS,
            60L, TimeUnit.SECONDS,
            new LinkedBlockingQueue<>(256),
            r -> { Thread t = new Thread(r, "http-" + System.nanoTime()); t.setDaemon(true); return t; },
            new ThreadPoolExecutor.CallerRunsPolicy());
        httpExecutor.allowCoreThreadTimeOut(true);
        server.setExecutor(httpExecutor);
        // Handle shutdown
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            synchronized (jobs) { shuttingDown = true; }
            shutdownJobs();
            shutdownAggregator();
            server.stop(5);
        }));

        // Load --mcp aggregator (boot-time probe, parity with TS). Relative paths
        // resolve against process cwd at file-open time; no need to prepend.
        if (mcpConfigPath != null) {
            loadAggregator(mcpConfigPath);
        }

        // Publish the listener only after configured tools are ready for discovery.
        server.start();
        if (makePublic) startPublicTunnel(server.getAddress().getPort());

        String bindLabel = (bindAddr.equals("0.0.0.0") || bindAddr.equals("::")) ? "localhost" : bindAddr;
        System.err.println("code-mcp listening on http://" + bindLabel + ":" + port + "/mcp" +
            (token != null ? " (auth)" : " (no auth)"));

        // Start gateway client if --gateway is set
        if (gatewayDomain != null) {
            try {
                startGatewayClient(gatewayDomain, assignedDeviceId, gatewayToken != null ? gatewayToken : token);
            } catch (Exception e) {
                System.err.println("[gateway] failed to start: " + e.getMessage());
            }
        }
    }

    private static void startPublicTunnel(int listenPort) {
        Thread thread = new Thread(() -> {
            PublicTunnel state = null;
            try {
                String host = bindAddr.equals("0.0.0.0") ? "127.0.0.1" : bindAddr.equals("::") ? "::1" : bindAddr;
                String authority = host.contains(":") && !host.startsWith("[") ? "[" + host + "]" : host;
                String result = handlePreview("http://" + authority + ":" + listenPort);
                Matcher match = Pattern.compile("(https://[a-z0-9-]+\\.trycloudflare\\.com) \\(job ([^)]+)\\)", Pattern.CASE_INSENSITIVE).matcher(result);
                if (!match.matches()) throw new IOException("invalid public tunnel result");
                Job job;
                synchronized (jobs) { job = jobs.get(match.group(2)); }
                if (job == null || !job.process.isAlive()) throw new IOException("public tunnel exited before ready");
                state = new PublicTunnel(match.group(1), job);
                publicTunnel = state;
                System.err.println("public URL: " + state.url() + "/mcp");
                job.process.waitFor();
            } catch (Exception error) {
                System.err.println("warning: public tunnel unavailable: " + error.getMessage());
                if (error instanceof InterruptedException) Thread.currentThread().interrupt();
            } finally {
                if (state != null && publicTunnel == state) publicTunnel = null;
            }
        }, "public-tunnel");
        thread.setDaemon(true);
        thread.start();
    }

    // ===== ARGUMENT PARSING =====
    private static boolean validPublicDomain(String value) {
        Matcher match = Pattern.compile("([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?").matcher(value);
        if (!match.matches()) return false;
        if (match.group(2) != null) {
            int valuePort = Integer.parseInt(match.group(2));
            if (valuePort < 1 || valuePort > 65535) return false;
        }
        String host = match.group(1);
        if (host.endsWith(".")) host = host.substring(0, host.length() - 1);
        if (host.isEmpty() || host.length() > 253) return false;
        String[] labels = host.split("\\.", -1);
        for (String label : labels) {
            if (label.length() > 63 || !label.matches("[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?")) return false;
        }
        if (labels[labels.length - 1].matches("(?i)(?:[0-9]+|0x[0-9a-f]+)")) {
            if (labels.length != 4) return false;
            for (String label : labels) {
                if (!label.matches("(?:0|[1-9][0-9]{0,2})") || Integer.parseInt(label) > 255) return false;
            }
        }
        return true;
    }

    private static void parseArgs(String[] args) {
        String envPort = System.getenv("PORT");
        if (envPort != null && !envPort.isBlank()) {
            try {
                port = Integer.parseInt(envPort);
            } catch (NumberFormatException e) {
                System.err.println("error: invalid $PORT=" + envPort);
                System.exit(2);
            }
        }
        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--port" -> {
                    if (++i >= args.length) usage();
                    try {
                        port = Integer.parseInt(args[i]);
                    } catch (NumberFormatException e) {
                        System.err.println("error: invalid --port " + args[i]);
                        System.exit(2);
                    }
                    if (port < 1 || port > 65535) {
                        System.err.println("error: --port out of range: " + port);
                        System.exit(2);
                    }
                }
                case "--bind" -> {
                    if (++i >= args.length) usage();
                    bindAddr = args[i];
                }
                case "--token" -> {
                    if (++i >= args.length) usage();
                    token = args[i];
                }
                case "--enable-memory" -> memoryEnabled = true;
                case "--public" -> makePublic = true;
                case "--domain" -> {
                    if (++i >= args.length) usage();
                    domain = args[i];
                }
                case "--mcp" -> {
                    if (++i >= args.length) usage();
                    mcpConfigPath = args[i];
                }
                case "--gateway" -> {
                    // Bare --gateway (no URL) connects to the default managed gateway.
                    if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
                        i++;
                        gatewayDomain = args[i];
                    } else {
                        gatewayDomain = DEFAULT_GATEWAY;
                    }
                }
                case "--id" -> {
                    if (++i >= args.length) usage();
                    assignedDeviceId = args[i];
                }
                case "--gateway-token" -> {
                    if (++i >= args.length) usage();
                    gatewayToken = args[i];
                }
                case "--disallowed-tools" -> {
                    if (++i >= args.length) usage();
                    for (String t : args[i].split(",")) {
                        String name = t.trim();
                        if (!name.isEmpty()) disallowedTools.add(name);
                    }
                }
                case "-h", "--help" -> {
                    System.out.println(USAGE);
                    System.exit(0);
                }
                default -> usage();
            }
        }

        if (makePublic && domain != null) {
            System.err.println("error: --public and --domain are mutually exclusive");
            System.exit(2);
        }
        if ((makePublic || domain != null) && (token == null || token.isEmpty())) {
            System.err.println("error: --public/--domain require --token (otherwise the server is an unauthenticated remote shell)");
            System.exit(2);
        }
        if (domain != null && !validPublicDomain(domain)) {
            System.err.println("error: invalid --domain: " + domain);
            System.exit(2);
        }
    }

    private static void usage() {
        System.err.println(USAGE);
        System.exit(2);
    }

    private static final String USAGE = """
        Usage: java CodeMCP.java [options]

        Options:
          --port <n>                  Listen port (default: 7777 or $PORT)
          --bind <addr>               Bind address (default: 127.0.0.1)
          --token <s>                 Require ?token=<s> or Bearer auth on every request
          --enable-memory             Enable remember/forget/recall tools
          --public                    Expose via Cloudflare quick tunnel (requires cloudflared)
          --domain <host>             Use given public hostname (mutually exclusive with --public)
          --mcp <path>                Aggregate tools from external MCP servers (JSON config)
          --gateway [domain]         Connect to gateway server; bare flag uses the default
                                      (wss://code-mcp.tuanm.workers.dev)
          --id <uuid>                 Use specific device ID for gateway connection
          --gateway-token <s>         Device credential sent to the gateway on connect
                                      (defaults to --token; must match the token registered
                                      for --id in the gateway device registry)
          --disallowed-tools <list>   Comma-separated tools to disable
          -h, --help                  Show this help and exit
        """;

    // ===== SECURITY: PATH VALIDATION =====

    // Resolve path and verify it stays within allowed directory (prevents path traversal)
    private static Path safeResolve(String cwd, String userPath) throws IOException {
        return safeResolve(cwd, userPath, false);
    }

    private static Path safeResolve(String cwd, String userPath, boolean allowSpill) throws IOException {
        if (userPath == null || userPath.contains("\0")) {
            throw new IOException("Invalid path");
        }
        Path base = Path.of(cwd).toAbsolutePath().normalize();
        Path realBase;
        try {
            realBase = base.toRealPath();
        } catch (IOException e) {
            realBase = base; // cwd missing: fall back to the lexical base
        }
        Path resolved = base.resolve(userPath).normalize();
        // Real-path the DEEPEST EXISTING ancestor, then re-append the missing
        // tail. normalize() is lexical, so a symlinked INTERMEDIATE directory
        // could otherwise smuggle the target outside the cwd (e.g. repo/link/passwd
        // where link -> /etc). The final component is checked implicitly because
        // its parent chain is real-pathed before use.
        Path probe = resolved;
        Path tail = Path.of("");
        while (probe != null && !Files.exists(probe, LinkOption.NOFOLLOW_LINKS)) {
            tail = probe.getFileName() == null ? tail : probe.getFileName().resolve(tail);
            probe = probe.getParent();
        }
        Path real = (probe != null) ? probe.toRealPath() : resolved;
        Path finalPath = real.resolve(tail).normalize();
        if (!finalPath.startsWith(realBase)) {
            // Spill files live under spillRoot, outside cwd. read/grep must reach
            // them because spill markers point callers at that path.
            if (allowSpill && spillRoot != null) {
                Path spillBase;
                try {
                    spillBase = Path.of(spillRoot).toRealPath();
                } catch (IOException e) {
                    spillBase = Path.of(spillRoot).toAbsolutePath().normalize();
                }
                if (finalPath.startsWith(spillBase)) {
                    return finalPath;
                }
            }
            throw new IOException("path escapes cwd: " + userPath);
        }
        return finalPath;
    }

    // Same as safeResolve but also verifies result is a file (not directory)
    private static Path safeResolveFile(String cwd, String userPath) throws IOException {
        return safeResolveFile(cwd, userPath, false);
    }

    private static Path safeResolveFile(String cwd, String userPath, boolean allowSpill) throws IOException {
        Path p = safeResolve(cwd, userPath, allowSpill);
        if (Files.isDirectory(p)) {
            throw new IOException("Expected file, got directory: " + userPath);
        }
        return p;
    }

    // Same as safeResolve but also verifies result is a directory
    private static Path safeResolveDir(String cwd, String userPath) throws IOException {
        Path p = safeResolve(cwd, userPath);
        if (Files.exists(p) && !Files.isDirectory(p)) {
            throw new IOException("Expected directory, got file: " + userPath);
        }
        return p;
    }

    // Parity with Python/TS: a missing cwd defaults to the process working directory.
    private static String effCwd(String cwd) {
        return (cwd == null || cwd.isBlank()) ? System.getProperty("user.dir") : cwd;
    }

    // ===== SECURITY: SHELL ESCAPING =====

    // Escape string for bash -c to prevent command injection
    private static String escapeBash(String cmd) {
        if (cmd == null) return "";
        // No escaping needed - bash -c interprets the string directly
        return cmd;
    }

    // Escape string for sh -c
    private static String escapeSh(String cmd) {
        if (cmd == null) return "";
        // No escaping needed - sh -c interprets the string directly
        return cmd;
    }

    // ===== SHELL DETECTION =====
    private static volatile String powerShellBinary = null;
    private static volatile boolean powerShellChecked = false;

    private static String detectPowerShellBinary() {
        if (!powerShellChecked) {
            synchronized (CodeMCP.class) {
                if (!powerShellChecked) {
                    if (hasOnPath("pwsh")) powerShellBinary = "pwsh";
                    else if (hasOnPath("powershell")) powerShellBinary = "powershell";
                    powerShellChecked = true;
                }
            }
        }
        return powerShellBinary;
    }

    private static ShellType detectShell() {
        if (isWindows) {
            // PSModulePath is set inside any PowerShell session (5.1 or 7+). Use that
            // as the authoritative signal AND require a usable powershell binary.
            if (System.getenv("PSModulePath") != null && detectPowerShellBinary() != null) {
                return ShellType.POWERSHELL;
            }
            return ShellType.CMD;
        }
        // Prefer bash when available regardless of $SHELL (matches Python/TS behavior).
        if (hasOnPath("bash")) return ShellType.BASH;
        return ShellType.SH;
    }

    private static String[] bashCmd(String command) {
        return new String[]{"bash", "-c", escapeBash(command)};
    }

    private static String[] shCmd(String command) {
        return new String[]{"sh", "-c", escapeSh(command)};
    }

    private static String[] cmdCmd(String command) {
        // /s removes the command string's first and last quote. Supply that
        // outer transport pair so it cannot consume a quoted executable/path
        // from the user's script. Interior quotes/metacharacters stay verbatim.
        return new String[]{"cmd.exe", "/d", "/s", "/c", "\"" + command + "\""};
    }

    private static String[] pwshCmd(String command) {
        // Fall back to literal "pwsh" if neither is on PATH so the caller gets a
        // useful "command not found" error instead of an NPE.
        String bin = detectPowerShellBinary();
        if (bin == null) bin = "pwsh";
        // Pass the script as base64(UTF-16LE) via -EncodedCommand (parity with
        // Python/TS). Handing the raw string to -Command lets the Windows command
        // line mangle embedded double quotes - a quoted "|" separator became a
        // real pipeline, so PowerShell tried to run "PLAT=..." as a command.
        // Base64 carries no shell metacharacters, so the script survives intact
        // no matter how the caller built or quoted it.
        // Encoded commands can serialize stderr as CLIXML on Windows PowerShell.
        // Keep errors visible and suppress module-initialization progress.
        // Parse separately so leading param/using remain valid. Inner encoding also
        // protects smart quotes. Preserve a final failed command's process status:
        // invoking a script block alone resets $? after nonterminating/native errors.
        String inner = Base64.getEncoder().encodeToString(
            (command + "\nif (-not $?) { exit 1 }").getBytes(StandardCharsets.UTF_16LE));
        String script = "$ProgressPreference = 'SilentlyContinue'; "
            + "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); "
            + "$OutputEncoding = [Console]::OutputEncoding; & ([scriptblock]::Create("
            + "[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('" + inner + "'))))";
        String enc = Base64.getEncoder().encodeToString(script.getBytes(StandardCharsets.UTF_16LE));
        return new String[]{bin, "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", enc};
    }

    private static String[] shellCmd(String command) {
        return switch (detectedShell) {
            case BASH -> bashCmd(command);
            case SH -> shCmd(command);
            case CMD -> cmdCmd(command);
            case POWERSHELL -> pwshCmd(command);
        };
    }

    private static boolean hasOnPath(String bin) {
        String probe = isWindows ? "where " + bin : "command -v " + bin;
        try {
            ProcessBuilder pb = new ProcessBuilder(isWindows
                ? new String[]{"cmd.exe", "/d", "/s", "/c", probe}
                : new String[]{"sh", "-c", probe});
            pb.redirectInput(ProcessBuilder.Redirect.PIPE);
            pb.redirectOutput(ProcessBuilder.Redirect.DISCARD);
            pb.redirectError(ProcessBuilder.Redirect.DISCARD);
            Process p = pb.start();
            try { p.getOutputStream().close(); } catch (IOException ignored) {}
            return p.waitFor() == 0;
        } catch (Exception e) {
            return false;
        }
    }

    // ===== HMAC UTILITIES =====
    private static String b64url(byte[] buf) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(buf);
    }

    private static String b64url(String str) {
        return b64url(str.getBytes(StandardCharsets.UTF_8));
    }

    private static byte[] b64urlDecode(String s) {
        s = s.replace('-', '+').replace('_', '/');
        while (s.length() % 4 != 0) s += "=";
        return Base64.getDecoder().decode(s);
    }

    private static String mintUploadSessionId() {
        if (token == null) throw new RuntimeException("--token is required to mint upload sessions");
        long exp = System.currentTimeMillis() + UPLOAD_TTL_MS;
        String nonce = String.format("%016x", new SecureRandom().nextLong());
        String payload = exp + "." + nonce;
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(token.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            byte[] sig = mac.doFinal(payload.getBytes(StandardCharsets.UTF_8));
            return b64url(payload) + "." + b64url(sig);
        } catch (NoSuchAlgorithmException | InvalidKeyException e) {
            throw new RuntimeException(e);
        }
    }

    private static long verifiedUploadExpiry(String id) {
        if (token == null) throw new IllegalArgumentException("server has no token configured");
        if (id == null || id.length() > 128 || !id.matches("[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{43}"))
            throw new IllegalArgumentException("malformed");
        try {
            String[] parts = id.split("\\.", -1);
            byte[] raw = b64urlDecode(parts[0]), sig = b64urlDecode(parts[1]);
            if (!Base64.getUrlEncoder().withoutPadding().encodeToString(raw).equals(parts[0])
                    || !Base64.getUrlEncoder().withoutPadding().encodeToString(sig).equals(parts[1]))
                throw new IllegalArgumentException("malformed");
            String payload = new String(raw, StandardCharsets.UTF_8);
            if (!payload.matches("[1-9][0-9]{0,15}\\.[a-f0-9]{16}")) throw new IllegalArgumentException("malformed");
            long expiry = Long.parseLong(payload.substring(0, payload.indexOf('.')));
            if (expiry > 9007199254740991L) throw new IllegalArgumentException("malformed");
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(token.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            if (!MessageDigest.isEqual(sig, mac.doFinal(raw))) throw new IllegalArgumentException("bad signature");
            return expiry;
        } catch (GeneralSecurityException error) { throw new IllegalStateException(error); }
    }

    private static VerificationResult verifyUploadSessionId(String id) {
        try {
            if (System.currentTimeMillis() > verifiedUploadExpiry(id)) return new VerificationResult(false, "expired");
            return new VerificationResult(true, null);
        } catch (Exception error) { return new VerificationResult(false, error.getMessage() == null ? "malformed" : error.getMessage()); }
    }

    private record VerificationResult(boolean ok, String reason) {}

    // ===== RESULT SPILL =====
    private static String spillToolName(String toolName) {
        String value = toolName == null ? "unknown" : toolName;
        return value.substring(0, Math.min(value.length(), 64)).replaceAll("[^A-Za-z0-9_.-]", "_");
    }

    private static boolean hasUnpairedSurrogate(String text) {
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (Character.isHighSurrogate(c)) {
                if (++i >= text.length() || !Character.isLowSurrogate(text.charAt(i))) return true;
            } else if (Character.isLowSurrogate(c)) return true;
        }
        return false;
    }

    private static String maybeSpillText(String text, String toolName) {
        if (hasUnpairedSurrogate(text)) {
            String encoded = "\"" + escapeJson(text) + "\"";
            if (encoded.getBytes(StandardCharsets.UTF_8).length <= RESULT_SPILL_THRESHOLD) return text;
            return "[JSON-encoded text: JSON-decode the saved file contents to recover the original string.]\n"
                + maybeSpillText(encoded, toolName);
        }
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        if (bytes.length <= RESULT_SPILL_THRESHOLD) return text;

        // Byte-exact head
        ByteBuffer buf = ByteBuffer.wrap(bytes);
        ByteBuffer headBuf = ByteBuffer.allocate(RESULT_SPILL_HEAD);
        buf.get(headBuf.array(), 0, RESULT_SPILL_HEAD);
        String head = StandardCharsets.UTF_8.decode(headBuf).toString();

        // Snap to line boundary
        int lastNl = head.lastIndexOf('\n');
        if (lastNl > 0) head = head.substring(0, lastNl);

        // Generate filename: keep full timestamp incl. time so files spilled in
        // the same second don't collide on the prefix (parity with Python/TS).
        String ts = java.time.Instant.now().toString().replaceAll("[-:.Z]", "");
        String safeTool = spillToolName(toolName);
        String shortId = String.format("%08x", new SecureRandom().nextInt());
        String fname = ts + "-" + safeTool + "-" + shortId + ".txt";
        Path path = Path.of(spillRoot, fname);

        // Count lines
        int totalLines = text.isEmpty() ? 0 : (int) text.chars().filter(c -> c == '\n').count() + 1;

        try {
            Files.writeString(path, text, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);
            // Spill files hold tool output (potentially secrets): never leave
            // them world-readable (parity with Python/TS 0600).
            try {
                Files.setPosixFilePermissions(path,
                    java.nio.file.attribute.PosixFilePermissions.fromString("rw-------"));
            } catch (UnsupportedOperationException ignored) {}
        } catch (IOException e) {
            System.err.println("[spill] failed to write " + path + ": " + e.getMessage());
            return head + "\n[TRUNCATED: full output is " + bytes.length + " bytes (" + totalLines + " lines); spill to disk FAILED (" + e.getMessage() + ")]\n";
        }

        String marker = "\n[TRUNCATED: " + bytes.length + " bytes (" + totalLines + " lines) saved to " + path + " — use read with range or grep to view the remaining content]\n";
        return head + marker;
    }

    private static Map<String, Object> maybeSpillBinary(String b64, Object mimeValue, String toolName) {
        if (b64.length() < RESULT_SPILL_THRESHOLD * 4.0 / 3 || !(mimeValue instanceof String mime)) return null;
        if (!b64.matches("[A-Za-z0-9+/]*={0,2}") || (b64.contains("=") && b64.length() % 4 != 0)) return null;
        byte[] raw;
        try {
            raw = Base64.getDecoder().decode(b64);
            if (!Base64.getEncoder().withoutPadding().encodeToString(raw).equals(b64.replaceFirst("=+$", ""))) return null;
        } catch (IllegalArgumentException error) { return null; }
        if (raw.length <= RESULT_SPILL_THRESHOLD) return null;
        String ts = java.time.Instant.now().toString().replaceAll("[-:.Z]", "");
        String safeTool = spillToolName(toolName);
        int slash = mime.indexOf('/');
        String ext = slash < 0 ? "bin" : mime.substring(slash + 1, Math.min(slash + 17, mime.length())).split("/", 2)[0].replaceAll("[^A-Za-z0-9]", "");
        Path path = Path.of(spillRoot, ts + "-" + safeTool + "-" + UUID.randomUUID().toString().substring(0, 8) + "." + (ext.isEmpty() ? "bin" : ext));
        try {
            Files.write(path, raw);
            try { Files.setPosixFilePermissions(path, java.nio.file.attribute.PosixFilePermissions.fromString("rw-------")); }
            catch (UnsupportedOperationException ignored) {}
        } catch (IOException error) {
            return Map.of("type", "text", "text", maybeSpillText("[TRUNCATED: " + mime + " payload of " + raw.length + " bytes; spill to disk FAILED (" + error.getMessage() + "). Payload dropped.]", toolName));
        }
        return Map.of("type", "text", "text", maybeSpillText("[TRUNCATED: " + mime + " payload of " + raw.length + " bytes, saved to " + path + " — read the file directly to access it.]", toolName));
    }

    private static Object spillContentBlocks(Object content, String toolName) {
        if (!(content instanceof List<?> blocks)) return content;
        List<Object> result = new ArrayList<>(blocks.size());
        for (Object value : blocks) {
            Object replacement = value;
            if (value instanceof Map<?, ?> block) {
                Map<Object, Object> updated = null;
                Map<String, Object> spilled = null;
                Object kind = block.get("type");
                if ("text".equals(kind) && block.get("text") instanceof String text) {
                    updated = new LinkedHashMap<>(block);
                    updated.put("text", maybeSpillText(text, toolName));
                } else if (("image".equals(kind) || "audio".equals(kind)) && block.get("data") instanceof String data) {
                    Object mime = block.get("mimeType");
                    spilled = maybeSpillBinary(data, mime == null ? ("image".equals(kind) ? "image/png" : "application/octet-stream") : mime, toolName);
                } else if ("resource".equals(kind) && block.get("resource") instanceof Map<?, ?> resource) {
                    if (resource.get("text") instanceof String text) {
                        Map<Object, Object> nested = new LinkedHashMap<>(resource);
                        nested.put("text", maybeSpillText(text, toolName));
                        updated = new LinkedHashMap<>(block);
                        updated.put("resource", nested);
                    } else if (resource.get("blob") instanceof String blob) {
                        Object mime = resource.get("mimeType");
                        spilled = maybeSpillBinary(blob, mime == null ? "application/octet-stream" : mime, toolName);
                    }
                }
                if (spilled != null) {
                    updated = new LinkedHashMap<>(block);
                    updated.remove("data"); updated.remove("mimeType"); updated.remove("resource");
                    updated.putAll(spilled);
                }
                if (updated != null) replacement = updated;
            }
            result.add(replacement);
        }
        return result;
    }

    // ===== OUTPUT CAPPING =====
    private static final String OUTPUT_TRUNCATED = "[OUTPUT TRUNCATED: earlier output discarded; retained tail follows]\n";
    private static final String OUTPUT_INCOMPLETE = "[OUTPUT INCOMPLETE: capture stopped before all output streams closed]\n";

    private static String capOutput(String text) {
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        if (bytes.length <= OUTPUT_CAP_MAX) return text;
        int start = bytes.length - OUTPUT_CAP_KEEP;
        while (start < bytes.length && (bytes[start] & 0xC0) == 0x80) start++;
        return OUTPUT_TRUNCATED + new String(bytes, start, bytes.length - start, StandardCharsets.UTF_8);
    }

    // ===== PROCESS EXECUTION =====
    private static class ShellCapture {
        final InputStream input;
        final StringBuilder buffer;
        volatile boolean cancelled, done, failed;
        Thread thread;
        ShellCapture(InputStream input, StringBuilder buffer) { this.input = input; this.buffer = buffer; }
        void cancel() {
            synchronized (buffer) {
                if (done || cancelled) return;
                cancelled = true;
                buffer.append('\n').append(OUTPUT_INCOMPLETE);
            }
            if (isWindows && thread != null) {
                try {
                    cancelWindowsShellRead(this);
                    thread.join(250);
                    if (!done) throw new IOException("capture reader did not finish after cancellation");
                } catch (Exception e) {
                    if (e instanceof InterruptedException) Thread.currentThread().interrupt();
                    synchronized (buffer) {
                        buffer.append("[OUTPUT CLEANUP FAILED: ").append(e.getMessage()).append("]\n");
                    }
                }
                // The reader owns and closes its stream in finally once its
                // ReadFile is cancelled. Never enqueue a CloseHandle which can
                // itself block indefinitely behind that synchronous read.
                return;
            }
            Thread closer = new Thread(() -> {
                try { input.close(); } catch (IOException ignored) {}
            }, "shell-capture-close");
            closer.setDaemon(true);
            closer.start();
        }
        String snapshot() { synchronized (buffer) { return buffer.toString(); } }
    }

    private static void cancelWindowsShellRead(ShellCapture capture) throws IOException, InterruptedException {
        if (capture.done || capture.thread == null || !capture.thread.isAlive()) return;
        // This helper only cancels synchronous I/O on one uniquely named thread
        // in this JVM. It never terminates a thread or targets the command PID.
        String nativeCode = """
            using System;
            using System.Diagnostics;
            using System.ComponentModel;
            using System.Runtime.InteropServices;
            public static class CodeMcpCancelRead {
              [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenThread(uint access, bool inherit, uint id);
              [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetProcessIdOfThread(IntPtr thread);
              [DllImport("kernel32.dll")] static extern int GetThreadDescription(IntPtr thread, out IntPtr description);
              [DllImport("kernel32.dll", SetLastError=true)] static extern bool CancelSynchronousIo(IntPtr thread);
              [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
              [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
              [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
              public static bool Cancel(int processId, string exactName) {
                using (Process process = Process.GetProcessById(processId)) {
                  foreach (ProcessThread candidate in process.Threads) {
                    IntPtr thread = OpenThread(0x100801, false, (uint)candidate.Id);
                    if (thread == IntPtr.Zero) continue;
                    try {
                      if (GetProcessIdOfThread(thread) != (uint)processId) continue;
                      IntPtr description;
                      if (GetThreadDescription(thread, out description) < 0) continue;
                      string name;
                      try { name = Marshal.PtrToStringUni(description); }
                      finally { if (description != IntPtr.Zero) LocalFree(description); }
                      if (!String.Equals(name, exactName, StringComparison.Ordinal)) continue;
                      // Keep this verified handle throughout retries: the reader
                      // may be paused between its cancellation check and ReadFile.
                      // ERROR_NOT_FOUND is not proof that the reader has exited.
                      Stopwatch deadline = Stopwatch.StartNew();
                      while (deadline.ElapsedMilliseconds < 750) {
                        uint state = WaitForSingleObject(thread, 0);
                        if (state == 0) return true;
                        if (state == 0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error());
                        if (!CancelSynchronousIo(thread)) {
                          int error = Marshal.GetLastWin32Error();
                          if (error != 1168) throw new Win32Exception(error);
                        }
                        state = WaitForSingleObject(thread, 10);
                        if (state == 0) return true;
                        if (state == 0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error());
                      }
                      throw new TimeoutException("capture reader did not exit after bounded I/O cancellation");
                    } finally { CloseHandle(thread); }
                  }
                }
                return false;
              }
            }
            """;
        String code64 = Base64.getEncoder().encodeToString(nativeCode.getBytes(StandardCharsets.UTF_8));
        String name64 = Base64.getEncoder().encodeToString(capture.thread.getName().getBytes(StandardCharsets.UTF_8));
        String script = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; "
            + "Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + code64 + "'))); "
            + "if (-not [CodeMcpCancelRead]::Cancel(" + ProcessHandle.current().pid() + ", "
            + "[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + name64 + "')))) { exit 23 }";
        String systemRoot = System.getenv().getOrDefault("SystemRoot", "C:\\Windows");
        ProcessBuilder builder = new ProcessBuilder(Path.of(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe").toString(),
            "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand",
            Base64.getEncoder().encodeToString(script.getBytes(StandardCharsets.UTF_16LE)));
        builder.redirectOutput(ProcessBuilder.Redirect.DISCARD).redirectError(ProcessBuilder.Redirect.DISCARD);
        scrubEnv(builder);
        Process helper = builder.start();
        try {
            helper.getOutputStream().close();
            if (!helper.waitFor(2000, TimeUnit.MILLISECONDS)) throw new IOException("Windows capture cancellation helper timed out");
            if (helper.exitValue() != 0 && !capture.done) {
                if (helper.exitValue() == 23) throw new IOException("no verified matching Windows capture thread found");
                throw new IOException("Windows capture cancellation helper failed: exit " + helper.exitValue());
            }
        } finally {
            if (helper.isAlive()) {
                helper.destroyForcibly();
                helper.waitFor(250, TimeUnit.MILLISECONDS);
            }
        }
    }

    private static void pumpProcessOutput(InputStream in, StringBuilder sb) {
        pumpShellCapture(new ShellCapture(in, sb));
    }

    private static void pumpShellCapture(ShellCapture capture) {
        long byteCount = 0;
        char pendingHigh = 0;
        try (var reader = new InputStreamReader(capture.input, StandardCharsets.UTF_8)) {
            char[] chars = new char[4096];
            while (!capture.cancelled) {
                int count = reader.read(chars);
                if (count < 0) break;
                if (count == 0) continue;
                String chunk = (pendingHigh == 0 ? "" : String.valueOf(pendingHigh)) + new String(chars, 0, count);
                pendingHigh = 0;
                if (Character.isHighSurrogate(chunk.charAt(chunk.length() - 1))) {
                    pendingHigh = chunk.charAt(chunk.length() - 1);
                    chunk = chunk.substring(0, chunk.length() - 1);
                }
                synchronized (capture.buffer) {
                    if (capture.cancelled) break;
                    capture.buffer.append(chunk);
                    byteCount += chunk.getBytes(StandardCharsets.UTF_8).length;
                    if (byteCount > OUTPUT_CAP_MAX) {
                        String capped = capOutput(capture.buffer.toString());
                        capture.buffer.setLength(0);
                        capture.buffer.append(capped);
                        byteCount = capped.getBytes(StandardCharsets.UTF_8).length;
                    }
                }
            }
        } catch (IOException e) {
            capture.failed = true;
            synchronized (capture.buffer) {
                if (!capture.cancelled) capture.buffer.append('\n').append(OUTPUT_INCOMPLETE);
            }
        } finally {
            capture.done = true;
        }
    }

    private static long shellRemaining(long deadline) { return Math.max(0, deadline - System.nanoTime()); }
    private static void waitShellCapture(ShellCapture capture, long deadline) throws InterruptedException {
        long remaining = shellRemaining(deadline);
        if (remaining > 0) TimeUnit.NANOSECONDS.timedJoin(capture.thread, remaining);
    }

    private static String runShellCommand(String[] cmd, String displayCommand, String cwd, long timeoutMs) throws Exception {
        ensureWindowsRootOwner();
        boolean explicit = timeoutMs > 0;
        long effective = explicit ? timeoutMs : DEFAULT_SHELL_TIMEOUT_MS;
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(effective);
        ProcessBuilder builder = new ProcessBuilder(cmd).directory(new File(cwd)).redirectErrorStream(true);
        builder.redirectInput(ProcessBuilder.Redirect.PIPE);
        scrubEnv(builder);
        Process process;
        try { process = builder.start(); }
        catch (IOException e) { throw new ShellFailure("cannot start shell: " + e.getMessage()); }
        try { process.getOutputStream().close(); } catch (IOException ignored) {}
        ShellCapture capture = new ShellCapture(process.getInputStream(), new StringBuilder());
        capture.thread = new Thread(() -> pumpShellCapture(capture), "shell-stdout-" + UUID.randomUUID());
        capture.thread.setDaemon(true);
        capture.thread.start();
        try {
            long remaining = shellRemaining(deadline);
            if (remaining > 0) process.waitFor(remaining, TimeUnit.NANOSECONDS);
            if (!process.isAlive()) {
                waitShellCapture(capture, deadline);
                if (capture.done) return "exit=" + process.exitValue() + "\n" + capture.snapshot();
                capture.cancel();
                return "exit=" + (explicit ? 124 : process.exitValue()) + "\n" + capture.snapshot()
                    + (explicit ? timeoutMarker(effective) : "");
            }
            if (!explicit) {
                try {
                    Job adopted = adoptJob(displayCommand, process, capture);
                    return "exit=running\n" + capture.snapshot() + backgroundedMarker(effective, adopted.id);
                } catch (RuntimeException e) {
                    if (process.isAlive()) terminateShellProcess(process);
                    capture.cancel();
                    throw new ShellFailure("auto-background failed: " + e.getMessage());
                }
            }
            if (process.isAlive()) terminateShellProcess(process);
            waitShellCapture(capture, System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(250));
            capture.cancel();
            return "exit=124\n" + capture.snapshot() + timeoutMarker(effective);
        } catch (InterruptedException e) {
            if (process.isAlive()) terminateShellProcess(process);
            capture.cancel();
            Thread.currentThread().interrupt();
            throw new ShellFailure("shell execution interrupted");
        }
    }

    /**
     * Run a process for the bash/shell/command/powershell tools.
     *
     * Two paths depending on whether the caller passed timeoutMs:
     *   - explicit timeoutMs > 0: classic kill-on-timeout (exit=124 + timeoutMarker).
     *   - no timeoutMs: at DEFAULT_SHELL_TIMEOUT_MS (60s) the still-running process is
     *     adopted into the `job` system instead of being killed, returning
     *     exit=running + backgroundedMarker so the agent can poll with the `job` tool.
     *
     * Returns the full formatted body (already includes the "exit=...\n" prefix).
     * `displayCommand` is the original command string used as the job name on adoption.
     */
    private static class ShellFailure extends IOException {
        ShellFailure(String message) { super(message); }
    }

    private static void terminateShellProcess(Process process) {
        if (!process.isAlive()) return;
        try {
            process.descendants().forEach(child -> {
                try { child.destroyForcibly(); } catch (RuntimeException ignored) {}
            });
        } finally {
            if (process.isAlive()) process.destroyForcibly();
            try { process.waitFor(750, TimeUnit.MILLISECONDS); }
            catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        }
    }

    private static String runCommand(String[] cmd, String displayCommand, String cwd, long timeoutMs) throws Exception {
        return runCommand(cmd, displayCommand, cwd, timeoutMs, false);
    }

    private static String runCommand(String[] cmd, String displayCommand, String cwd, long timeoutMs, boolean shellTool) throws Exception {
        if (shellTool) return runShellCommand(cmd, displayCommand, cwd, timeoutMs);
        boolean explicit = timeoutMs > 0;
        long effective = explicit ? timeoutMs : DEFAULT_SHELL_TIMEOUT_MS;

        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.directory(new File(cwd));
        pb.redirectErrorStream(true);              // merge stderr into stdout (matches Python/TS combined output)
        pb.redirectInput(ProcessBuilder.Redirect.PIPE);
        scrubEnv(pb);

        Process p;
        try {
            p = pb.start();
        } catch (IOException e) {
            // Match Python+TS exit=-1 + ERROR shape so MCP clients see a uniform error
            // format (bad cwd, missing binary, fork failure) instead of an exception.
            if (shellTool) throw new ShellFailure("cannot start shell: " + e.getMessage());
            return "exit=-1\nERROR: " + e.getMessage();
        }
        try { p.getOutputStream().close(); } catch (IOException ignored) {}

        StringBuilder sb = new StringBuilder();
        ShellCapture capture = new ShellCapture(p.getInputStream(), sb);
        Thread reader = new Thread(() -> pumpShellCapture(capture), "shell-stdout-" + UUID.randomUUID());
        capture.thread = reader;
        reader.setDaemon(true);
        reader.start();

        boolean finished;
        try {
            finished = p.waitFor(effective, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            terminateShellProcess(p);
            Thread.currentThread().interrupt();
            try { reader.join(500); } catch (InterruptedException ignored) {}
            String body;
            synchronized (sb) { body = capOutput(sb.toString()); }
            return "exit=-1\n" + body + "\n[INTERRUPTED]";
        }
        if (!finished) {
            if (explicit) {
                terminateShellProcess(p);
                try { reader.join(500); } catch (InterruptedException ignored) {}
                String body;
                synchronized (sb) { body = capOutput(sb.toString()); }
                return "exit=124\n" + body + timeoutMarker(effective);
            }
            // Auto-background: hand off the still-running process + reader + buffer to the job system.
            try {
                Job adopted = adoptJob(displayCommand, p, capture);
                String snapshot;
                synchronized (sb) { snapshot = capOutput(sb.toString()); }
                return "exit=running\n" + snapshot + backgroundedMarker(effective, adopted.id);
            } catch (RuntimeException adoptErr) {
                terminateShellProcess(p);
                try { reader.join(500); } catch (InterruptedException ignored) {}
                String body;
                synchronized (sb) { body = capOutput(sb.toString()); }
                return "exit=124\n" + body + "\n[Auto-background failed: " + adoptErr.getMessage() + "; process killed.]";
            }
        }
        reader.join();                              // EOF → reader exits naturally
        String body;
        synchronized (sb) { body = capOutput(sb.toString()); }
        return "exit=" + p.exitValue() + "\n" + body;
    }

    // ===== JOB MANAGEMENT =====
    private static class Job {
        final String id;
        final String command;
        final Process process;
        // Shared with the reader/pumper thread. view_job reads through currentOutput()
        // so the same buffer that is being appended to is observable as live output —
        // and the buffer is trivially handoff-able from a foreground runCommand call
        // into the job system without re-attaching streams.
        final StringBuilder sb;
        final ShellCapture capture;
        volatile long completedAt;
        volatile String status = "running";
        volatile Integer exitCode;
        final long startedAt;

        Job(String id, String command, Process process, ShellCapture capture) {
            this.id = id;
            this.command = command;
            this.process = process;
            this.sb = capture.buffer;
            this.capture = capture;
            this.startedAt = System.currentTimeMillis();
        }

        String currentOutput() {
            synchronized (sb) { return capOutput(sb.toString()); }
        }
    }

    /**
     * Register a new Job in the jobs map iff we're not shutting down and the running-job count
     * is below MAX_CONCURRENT_JOBS. The check + put runs under `synchronized (jobs)` so two
     * concurrent start/adopt calls can never both pass the check.
     */
    private static Job registerJob(String id, String command, Process process, ShellCapture capture) {
        synchronized (jobs) {
            if (shuttingDown) {
                throw new RuntimeException("server is shutting down");
            }
            pruneFinishedJobs();
            int running = 0;
            for (Job j : jobs.values()) if ("running".equals(j.status)) running++;
            if (running >= MAX_CONCURRENT_JOBS) {
                throw new RuntimeException("max concurrent jobs (" + MAX_CONCURRENT_JOBS + ") exceeded");
            }
            Job job = new Job(id, command, process, capture);
            jobs.put(id, job);
            return job;
        }
    }

    private static final java.util.concurrent.atomic.AtomicLong completedJobSequence = new java.util.concurrent.atomic.AtomicLong();

    // Call only while holding jobs. Completion order, not creation order,
    // determines retained history; every running job remains addressable.
    private static void pruneFinishedJobs() {
        List<Job> finished = jobs.values().stream().filter(j -> !j.status.equals("running"))
            .sorted(Comparator.comparingLong(j -> j.completedAt)).toList();
        for (int i = 0; i < finished.size() - 100; i++) jobs.remove(finished.get(i).id, finished.get(i));
    }

    private static void finishJob(Job job, int code) {
        synchronized (job) {
            if (!job.status.equals("running")) return;
            try { waitShellCapture(job.capture, System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(1000)); }
            catch (InterruptedException e) { Thread.currentThread().interrupt(); }
            job.capture.cancel();
            synchronized (jobs) {
                job.exitCode = code;
                job.completedAt = completedJobSequence.incrementAndGet();
                job.status = "exited";
                pruneFinishedJobs();
            }
        }
    }

    private static void watchJob(Job job) {
        Thread waiter = new Thread(() -> {
            try { finishJob(job, job.process.waitFor()); }
            catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        }, "job-wait-" + job.id);
        waiter.setDaemon(true);
        waiter.start();
    }

    private static boolean terminateJobTree(Process process, long graceMs, long deadline) throws InterruptedException {
        if (!process.isAlive()) return true; // Never target a recycled parent PID.
        List<ProcessHandle> children = process.descendants().toList();
        if (!isWindows) {
            for (int i = children.size() - 1; i >= 0; i--) if (children.get(i).isAlive()) children.get(i).destroy();
            if (process.isAlive()) process.destroy();
            long graceDeadline = Math.min(deadline, System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(Math.min(1000, graceMs)));
            while (shellRemaining(graceDeadline) > 0 && (process.isAlive() || children.stream().anyMatch(ProcessHandle::isAlive))) Thread.sleep(5);
        }
        // ProcessHandle retains identity even if the parent exits during grace.
        for (int i = children.size() - 1; i >= 0; i--) if (children.get(i).isAlive()) children.get(i).destroyForcibly();
        if (process.isAlive()) process.destroyForcibly();
        while (shellRemaining(deadline) > 0) {
            if (!process.isAlive() && children.stream().noneMatch(ProcessHandle::isAlive)) return true;
            Thread.sleep(5);
        }
        return !process.isAlive() && children.stream().noneMatch(ProcessHandle::isAlive);
    }

    private static void stopOwnedJob(Job job, long graceMs) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
        boolean confirmed = terminateJobTree(job.process, graceMs, deadline);
        // The watcher owns capture finalization; do not wait for its monitor
        // beyond this stop request's shared process/capture deadline.
        while (shellRemaining(deadline) > 0 && (job.status.equals("running") || job.capture.thread.isAlive())) Thread.sleep(5);
        if (!confirmed || job.process.isAlive() || job.status.equals("running") || job.capture.thread.isAlive() || job.capture.cancelled || job.capture.failed)
            throw new RuntimeException(job.id + ": termination incomplete; process-tree termination or final capture could not be confirmed");
    }

    private static void shutdownJobs() {
        for (Job job : new ArrayList<>(jobs.values())) {
            if (!job.status.equals("running") && !job.capture.thread.isAlive()) continue;
            try { stopOwnedJob(job, 2000); }
            catch (Exception e) { System.err.println("[job] shutdown cleanup failed for " + job.id + ": " + e.getMessage()); }
        }
    }

    private static Job startJob(String command, String cwd) {
        return startJobImpl(shellCmd(command), command, cwd);
    }

    // Like startJob but spawns argv directly (no shell interpolation): use for
    // tool inputs that must never reach a shell (e.g. preview URL).
    private static Job startJobArgv(String[] argv, String displayCommand, String cwd) {
        return startJobImpl(argv, displayCommand, cwd);
    }

    private static Job startJobImpl(String[] argv, String displayCommand, String cwd) {
        try { ensureWindowsRootOwner(); }
        catch (IOException error) { throw new RuntimeException(error.getMessage(), error); }
        // Check admission before executing any caller command, and publish the
        // spawned process before shutdown can take its jobs snapshot.
        synchronized (jobs) {
            if (shuttingDown) throw new RuntimeException("server is shutting down");
            pruneFinishedJobs();
            long running = jobs.values().stream().filter(j -> "running".equals(j.status)).count();
            if (running >= MAX_CONCURRENT_JOBS) throw new RuntimeException("max concurrent jobs (" + MAX_CONCURRENT_JOBS + ") exceeded");
            return startJobLocked(argv, displayCommand, cwd);
        }
    }

    // Caller holds jobs across OS spawn and registration. registerJob uses
    // the same reentrant monitor so adoption and explicit starts share capacity.
    private static Job startJobLocked(String[] argv, String displayCommand, String cwd) {
        String id = "j" + jobSeq.incrementAndGet();
        ProcessBuilder pb = new ProcessBuilder(argv);
        pb.directory(new File(cwd));
        pb.redirectInput(ProcessBuilder.Redirect.PIPE);
        pb.redirectErrorStream(true);
        scrubEnv(pb);

        try {
            // cmdCmd already supplies the outer /s quote pair. Pass the command
            // line verbatim through the owner rather than CRT-quoting it again.
            String rawCommand = argv.length == 5 && argv[0].equalsIgnoreCase("cmd.exe")
                && argv[1].equals("/d") && argv[2].equals("/s") && argv[3].equals("/c")
                ? "\"cmd.exe\" /d /s /c " + argv[4] : null;
            Process process = startOwnedProcess(pb, true, rawCommand);
            try { process.getOutputStream().close(); } catch (IOException ignored) {}
            ShellCapture capture = new ShellCapture(process.getInputStream(), new StringBuilder());
            capture.thread = new Thread(() -> pumpShellCapture(capture), "shell-stdout-" + UUID.randomUUID());
            capture.thread.setDaemon(true);
            capture.thread.start();
            final Job job;
            try {
                job = registerJob(id, displayCommand, process, capture);
            } catch (RuntimeException e) {
                if (process.isAlive()) terminateShellProcess(process);
                capture.cancel();
                throw e;
            }
            watchJob(job);

            return job;
        } catch (IOException e) {
            throw new RuntimeException("Failed to start job: " + e.getMessage(), e);
        }
    }

    /**
     * Adopt an already-running process (with its existing reader thread + buffer) as a job.
     * Lets the foreground bash/shell/command/powershell tools hand off long-running children
     * to the job system at the auto-background threshold without dropping in-flight output.
     */
    private static Job adoptJob(String command, Process process, ShellCapture capture) {
        String id = "j" + jobSeq.incrementAndGet();
        Job job = registerJob(id, command, process, capture);
        watchJob(job);
        return job;
    }

    // ===== MEMO MANAGEMENT =====
    private record Memo(long id, long ts, String memo, List<String> tags) {}

    private static List<Memo> readMemos(String cwd) throws IOException {
        List<Memo> memos = new ArrayList<>();
        readMemoAppendState(cwd, memos::add);
        return memos;
    }

    @SuppressWarnings("unchecked")
    private static Memo parseMemo(String json) {
        Map<String, Object> m = parseJsonObject(json);
        Object idRaw = m.get("id");
        Object tsRaw = m.get("ts");
        Object memoRaw = m.get("memo");
        if (!(idRaw instanceof Number) || !(tsRaw instanceof Number) || !(memoRaw instanceof String)) {
            throw new IllegalArgumentException("invalid memo shape");
        }
        double id = ((Number) idRaw).doubleValue(), ts = ((Number) tsRaw).doubleValue();
        if (!Double.isFinite(id) || id < 1 || id > 9007199254740991L || id != Math.rint(id)
                || !Double.isFinite(ts) || ts < 0 || ts > 9007199254740991L || ts != Math.rint(ts))
            throw new IllegalArgumentException("invalid memo numeric fields");
        List<String> tags = sanitizeTags(m.get("tags"));
        return new Memo(
            ((Number) idRaw).longValue(),
            ((Number) tsRaw).longValue(),
            (String) memoRaw,
            tags
        );
    }

    /** Filter to clean string list or null. Drops null/numbers/empty strings. */
    private static List<String> sanitizeTags(Object tags) {
        if (!(tags instanceof List<?>)) return null;
        List<String> out = new ArrayList<>();
        for (Object t : (List<?>) tags) {
            if (t instanceof String s && !s.isEmpty()) out.add(s);
        }
        return out.isEmpty() ? null : out;
    }

    // ===== CROSS-PROCESS MEMO LOCK =====
    // Multiple Claude agents on the same device may share a cwd; serialize
    // remember/forget across processes via an EEXIST lockfile.
    private static final long MEMO_LOCK_TIMEOUT_MS = 30_000L;
    private static final long STALE_MEMO_LOCK_MS = 60_000L;
    private static final long MEMO_LOCK_RETRY_MS = 40L;

    private static boolean memoLockOwnerDefinitelyDead(Path path) throws IOException {
        byte[] bytes;
        try (InputStream input = Files.newInputStream(path)) { bytes = input.readNBytes(128); }
        var match = Pattern.compile("^([1-9][0-9]{0,9})\\r?\\n").matcher(new String(bytes, StandardCharsets.US_ASCII));
        if (!match.find()) return false;
        return memoProcessDefinitelyDead(Long.parseLong(match.group(1)));
    }

    private static boolean memoProcessDefinitelyDead(long pid) {
        if (pid < 1 || pid > 2147483647L) return false;
        try {
            if (ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false)) return false;
            // Windows ProcessHandle.of can be empty when OpenProcess is denied.
            // A process-table snapshot still contains protected PIDs; do not
            // turn inaccessible process metadata into permission to steal.
            try (var processes = ProcessHandle.allProcesses()) {
                return processes.noneMatch(owner -> owner.pid() == pid);
            }
        } catch (RuntimeException unavailable) { return false; }
    }

    @FunctionalInterface private interface MemoRead<T> { T read() throws IOException; }
    private static <T> T readMemoFileWithRetry(MemoRead<T> read) throws IOException {
        for (int attempt = 0; ; attempt++) {
            try { return read.read(); }
            catch (AccessDeniedException denied) {
                // A pathname being deleted on Windows can briefly deny opens
                // and stat. Retry reads only; persistent denial remains an error.
                if (!System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win") || attempt >= 5) throw denied;
                memoLockSleep(MEMO_LOCK_RETRY_MS);
            }
        }
    }

    private record MemoRecoveryPeer(String name, long ticket) {}

    private static List<MemoRecoveryPeer> memoRecoveryEntries(Path root, long deadline) throws IOException {
        List<MemoRecoveryPeer> entries = new ArrayList<>();
        try (DirectoryStream<Path> directory = Files.newDirectoryStream(root)) {
            int count = 0;
            for (Path participant : directory) {
                if (System.nanoTime() >= deadline) throw new IOException("timeout waiting for memo lock recovery");
                if (++count > 4096) throw new IOException("too many memo recovery participants");
                String name = participant.getFileName().toString();
                var match = Pattern.compile("p([1-9][0-9]{0,9})-([0-9a-f]{32})").matcher(name);
                if (!match.matches()) continue;
                try {
                    var info = readMemoFileWithRetry(() -> Files.readAttributes(participant, java.nio.file.attribute.BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS));
                    if (!info.isDirectory() || info.isSymbolicLink() || info.isOther()) throw new IOException("invalid memo recovery participant");
                    if (memoProcessDefinitelyDead(Long.parseLong(match.group(1)))) {
                        // No recursive removal; leave unexpected user contents alone.
                        try {
                            var ticketInfo = Files.readAttributes(participant.resolve("ticket"), java.nio.file.attribute.BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
                            if (ticketInfo.isRegularFile() && !ticketInfo.isSymbolicLink()) Files.deleteIfExists(participant.resolve("ticket"));
                        } catch (IOException ignored) { }
                        try { Files.deleteIfExists(participant); } catch (IOException ignored) { }
                        continue;
                    }
                    long ticket = 0;
                    try {
                        Path file = participant.resolve("ticket");
                        info = readMemoFileWithRetry(() -> Files.readAttributes(file, java.nio.file.attribute.BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS));
                        if (!info.isRegularFile() || info.isSymbolicLink() || info.size() > 64) throw new IOException("invalid memo recovery ticket");
                        String text = readMemoFileWithRetry(() -> {
                            try (InputStream input = Files.newInputStream(file)) { return new String(input.readNBytes(65), StandardCharsets.US_ASCII); }
                        });
                        if (text.endsWith("\n")) {
                            if (!text.matches("[1-9][0-9]{0,15}\\n") || Long.parseLong(text.strip()) > 9007199254740991L)
                                throw new IOException("invalid memo recovery ticket");
                            ticket = Long.parseLong(text.strip());
                        } else if (text.length() > 16 || !text.matches("[0-9]*")) throw new IOException("invalid memo recovery ticket");
                    } catch (NoSuchFileException missing) { /* still choosing, or departing */ }
                    entries.add(new MemoRecoveryPeer(name, ticket));
                } catch (NoSuchFileException missing) { /* participant departed */ }
            }
        }
        return entries;
    }

    private static void memoLockSleep(long millis) throws IOException {
        try { Thread.sleep(millis); }
        catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IOException("interrupted while waiting for memo lock", interrupted);
        }
    }

    private static final class MemoRecovery implements AutoCloseable {
        private final Path root;
        private final Path participant;
        private final String name;
        private MemoRecovery(String cwd, long deadline) throws IOException {
            root = Path.of(cwd, ".memo.recovery");
            try { Files.createDirectory(root); } catch (FileAlreadyExistsException exists) { }
            var info = Files.readAttributes(root, java.nio.file.attribute.BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            if (!info.isDirectory() || info.isSymbolicLink() || info.isOther()) throw new IOException("memo recovery must be a real directory");
            name = "p" + ProcessHandle.current().pid() + "-" + UUID.randomUUID().toString().replace("-", "");
            participant = root.resolve(name);
            Files.createDirectory(participant);
            boolean acquired = false;
            try {
                long ticket = memoRecoveryEntries(root, deadline).stream().mapToLong(MemoRecoveryPeer::ticket).max().orElse(0) + 1;
                if (ticket > 9007199254740991L) throw new IOException("memo recovery ticket space exhausted");
                try (FileChannel channel = FileChannel.open(participant.resolve("ticket"), StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
                    ByteBuffer data = ByteBuffer.wrap((ticket + "\n").getBytes(StandardCharsets.US_ASCII));
                    while (data.hasRemaining()) if (channel.write(data) <= 0) throw new IOException("incomplete memo recovery ticket");
                }
                while (System.nanoTime() < deadline) {
                    boolean waiting = memoRecoveryEntries(root, deadline).stream().anyMatch(peer -> !peer.name.equals(name)
                        && (peer.ticket == 0 || peer.ticket < ticket || (peer.ticket == ticket && peer.name.compareTo(name) < 0)));
                    if (!waiting) { acquired = true; return; }
                    memoLockSleep(MEMO_LOCK_RETRY_MS);
                }
                throw new IOException("timeout waiting for memo lock recovery");
            } finally { if (!acquired) close(); }
        }
        @Override public void close() throws IOException {
            for (int attempt = 0; ; attempt++) {
                try {
                    Files.deleteIfExists(participant.resolve("ticket"));
                    Files.deleteIfExists(participant);
                    return;
                } catch (FileSystemException denied) {
                    // Windows sharing violations are not always AccessDeniedException.
                    if (!System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win") || attempt >= 5) throw denied;
                    memoLockSleep(MEMO_LOCK_RETRY_MS);
                }
            }
        }
    }

    private record MemoLock(Path path, Object identity, String token,
                            java.util.concurrent.atomic.AtomicBoolean released) {}

    private static MemoLock acquireMemoLock(String cwd) throws IOException {
        Path lockPath = Path.of(cwd, ".memo.lock");
        long start = System.nanoTime();
        int permissionRetries = 0;
        while (System.nanoTime() - start < TimeUnit.MILLISECONDS.toNanos(MEMO_LOCK_TIMEOUT_MS)) {
            boolean opened = false;
            try {
                String token = ProcessHandle.current().pid() + "\n" + UUID.randomUUID() + "\n";
                FileChannel channel = FileChannel.open(lockPath, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE);
                opened = true;
                Object identity = null;
                try {
                    try (channel) {
                        identity = memoFileIdentity(lockPath);
                        ByteBuffer data = ByteBuffer.wrap(token.getBytes(StandardCharsets.US_ASCII));
                        while (data.hasRemaining()) {
                            if (channel.write(data) <= 0) throw new IOException("incomplete memo lock write");
                        }
                    }
                    try (InputStream current = Files.newInputStream(lockPath)) {
                        if (!new String(current.readNBytes(128), StandardCharsets.US_ASCII).equals(token))
                            throw new IOException("memo lock changed during acquisition");
                    }
                    return new MemoLock(lockPath, identity, token, new java.util.concurrent.atomic.AtomicBoolean());
                } catch (IOException | RuntimeException failure) {
                    if (identity == null) throw new IOException("memo lock ownership could not be verified; .memo.lock may remain. No memory was written by this request. Inspect .memo.lock before retrying: " + failure.getMessage(), failure);
                    IOException reported = new IOException("memo lock initialization failed: " + failure.getMessage(), failure);
                    if (identity != null) {
                        try { removeOwnedMemoLock(new MemoLock(lockPath, identity, token, new java.util.concurrent.atomic.AtomicBoolean()), true); }
                        catch (IOException cleanup) {
                            reported = new IOException("memo lock initialization and cleanup failed: " + failure.getMessage() + "; " + cleanup.getMessage(), failure);
                            reported.addSuppressed(cleanup);
                        }
                    }
                    throw reported;
                }
            } catch (FileAlreadyExistsException e) {
                permissionRetries = 0;
                try {
                    long age = System.currentTimeMillis()
                        - readMemoFileWithRetry(() -> Files.getLastModifiedTime(lockPath)).toMillis();
                    if (age > STALE_MEMO_LOCK_MS) {
                        try (MemoRecovery recovery = new MemoRecovery(cwd, start + TimeUnit.MILLISECONDS.toNanos(MEMO_LOCK_TIMEOUT_MS))) {
                            try {
                                var latest = Files.readAttributes(lockPath, java.nio.file.attribute.BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
                                if (!latest.isRegularFile() || latest.isSymbolicLink()) throw new IOException("memo lock must be a regular file");
                                if (System.currentTimeMillis() - latest.lastModifiedTime().toMillis() > STALE_MEMO_LOCK_MS
                                        && memoLockOwnerDefinitelyDead(lockPath)) Files.deleteIfExists(lockPath);
                            } catch (NoSuchFileException missing) { }
                        }
                    }
                } catch (NoSuchFileException nsfe) {
                    continue;
                }
                try {
                    Thread.sleep(MEMO_LOCK_RETRY_MS
                        + ThreadLocalRandom.current().nextInt(30));
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    throw new IOException("interrupted while waiting for memo lock", ie);
                }
            } catch (AccessDeniedException denied) {
                if (opened || !System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win") || permissionRetries++ >= 5) throw denied;
                memoLockSleep(MEMO_LOCK_RETRY_MS);
            }
        }
        throw new IOException("could not acquire memo lock at " + lockPath
            + " within " + MEMO_LOCK_TIMEOUT_MS + "ms");
    }

    private static void releaseMemoLock(MemoLock owned) throws IOException {
        if (!owned.released.compareAndSet(false, true)) return;
        removeOwnedMemoLock(owned, false);
    }

    private static void removeOwnedMemoLock(MemoLock owned, boolean allowPartial) throws IOException {
        for (int attempt = 0; ; attempt++) {
            try {
                var current = Files.readAttributes(owned.path, java.nio.file.attribute.BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
                if (!current.isRegularFile() || current.isSymbolicLink() || !Objects.equals(memoFileIdentity(owned.path), owned.identity)) return;
                try (InputStream input = Files.newInputStream(owned.path)) {
                    String actual = new String(input.readNBytes(128), StandardCharsets.US_ASCII);
                    if (allowPartial ? !owned.token.startsWith(actual) : !actual.equals(owned.token)) return;
                }
                current = Files.readAttributes(owned.path, java.nio.file.attribute.BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
                if (current.isRegularFile() && !current.isSymbolicLink() && Objects.equals(memoFileIdentity(owned.path), owned.identity))
                    Files.deleteIfExists(owned.path);
                return;
            } catch (NoSuchFileException missing) { return; }
            catch (FileSystemException busy) {
                if (!System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win") || attempt >= 5) throw busy;
                memoLockSleep(MEMO_LOCK_RETRY_MS);
            }
        }
    }
    /** ISO 8601 with milliseconds + Z, parity with TS Date.toISOString() and Python output. */
    private static String formatMemoTs(long ms) {
        long cycleMs = 146097L * 86400000L;
        var date = java.time.OffsetDateTime.ofInstant(java.time.Instant.ofEpochMilli(ms % cycleMs),
                java.time.ZoneOffset.UTC);
        long year = date.getYear() + ms / cycleMs * 400;
        String prefix = String.format(Locale.ROOT, year <= 9999 ? "%04d" : "+%06d", year);
        return prefix + date.format(java.time.format.DateTimeFormatter
                .ofPattern("-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT));
    }

    // ===== GUIDE =====
    // Renders an XML-block operating manual for the agent. Reflects live state
    // of this server (enabled tools, memos in cwd, project docs, external MCP
    // servers). Called by the `guide` tool.

    private static String xmlAttr(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;")
                .replace(">", "&gt;").replace("\"", "&quot;");
    }

    private record MemoState(int count, String latest, boolean lockHeld) {}

    private static MemoState collectMemoState(String cwd) throws IOException {
        RecallPage selected = selectRecallPage(cwd, null, null, 1, 0);
        List<Memo> memos = selected.page;
        String latest = null;
        if (!memos.isEmpty()) {
            Memo newest = memos.stream().max((a, b) -> Long.compare(a.id, b.id)).orElse(null);
            if (newest != null) {
                String ts = formatMemoTs(newest.ts);
                String tagStr = (newest.tags != null && !newest.tags.isEmpty())
                    ? ", tags=[" + String.join(",", newest.tags) + "]" : "";
                latest = ts + tagStr;
            }
        }
        boolean lockHeld = false;
        Path lockPath = Path.of(cwd, ".memo.lock");
        try {
            var info = Files.readAttributes(lockPath, java.nio.file.attribute.BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            // Age cannot prove that a writer exited; unknown ownership stays conservative.
            lockHeld = !info.isRegularFile() || !memoLockOwnerDefinitelyDead(lockPath);
        } catch (NoSuchFileException nsfe) {
            // not held
        } catch (IOException | SecurityException ignored) { lockHeld = true; }
        return new MemoState(selected.total, latest, lockHeld);
    }

    private static List<String> collectProjectDocs(String cwd) {
        List<String> docs = new ArrayList<>();
        for (String name : List.of("CLAUDE.md", "README.md")) {
            Path p = Path.of(cwd, name);
            if (Files.isRegularFile(p)) docs.add(name);
        }
        return docs;
    }

    // Lightweight scan of <cwd>/.mcp.json: ns + transport only. Lenient on URL scheme
    // since the guide is informational; mcp tool does strict validation at load time.
    @SuppressWarnings("unchecked")
    private static List<Map<String, String>> collectLoadableServers(String cwd) {
        Path path = Path.of(cwd, ".mcp.json");
        if (!Files.isRegularFile(path)) return List.of();
        Map<String, Object> parsed;
        try {
            parsed = parseJsonObject(readMcpConfigText(path));
        } catch (Exception e) {
            return List.of();
        }
        Object serversRaw = parsed.get("mcpServers");
        if (!(serversRaw instanceof Map<?, ?>)) return List.of();
        Map<String, Object> servers = (Map<String, Object>) serversRaw;
        List<Map<String, String>> out = new ArrayList<>();
        for (var entry : servers.entrySet()) {
            String ns = entry.getKey();
            if (ns == null || !AGGREGATOR_NS_RE.matcher(ns).matches()) continue;
            if (!(entry.getValue() instanceof Map<?, ?>)) continue;
            Map<String, Object> cfg = (Map<String, Object>) entry.getValue();
            String transport = "http".equals(cfg.get("type")) ? "http" : "stdio";
            if ("http".equals(transport) && !(cfg.get("url") instanceof String)) continue;
            if ("stdio".equals(transport) && !(cfg.get("command") instanceof String)) continue;
            out.add(Map.of("ns", ns, "transport", transport));
        }
        out.sort((a, b) -> a.get("ns").compareTo(b.get("ns")));
        return out;
    }

    private static List<Map<String, Object>> listExternalServers() {
        // Source: aggregatorKnown (server-wide, from --mcp config). Tool names come
        // from aggregatorTools (only populated for successfully probed servers).
        Map<String, List<String>> aggrByNs = new HashMap<>();
        for (AggregatedTool t : aggregatorTools.values()) {
            aggrByNs.computeIfAbsent(t.ns(), k -> new ArrayList<>()).add(t.tool());
        }
        List<String> names = new ArrayList<>(aggregatorKnown);
        names.sort(String::compareTo);
        List<Map<String, Object>> out = new ArrayList<>();
        for (String ns : names) {
            List<String> tools = new ArrayList<>(aggrByNs.getOrDefault(ns, List.of()));
            tools.sort(String::compareTo);
            out.add(Map.of("ns", ns, "tools", tools));
        }
        return out;
    }

    private static List<String> builtinToolNames() {
        List<String> names = new ArrayList<>(List.of(
            "read", "write", "edit", "multi_edit",
            "grep", "find", "ls", "job", "mcp", "guide"
        ));
        switch (detectedShell) {
            case BASH -> names.add("bash");
            case SH -> names.add("shell");
            case CMD -> names.add("command");
            case POWERSHELL -> names.add("powershell");
        }
        if (hasCloudflared) names.add("preview");
        if (memoryEnabled) {
            names.add("remember");
            names.add("forget");
            names.add("recall");
        }
        if ((domain != null || makePublic) && token != null) names.add("get_upload_link");
        names.removeAll(disallowedTools);
        names.sort(String::compareTo);
        return names;
    }

    // ===== AGGREGATOR (boot-time --mcp probe) =====

    private static String mcpConfigText(Object value, String label, boolean empty) throws IOException {
        if (!(value instanceof String text) || (!empty && text.isEmpty())) throw new IOException(label + " must be a string" + (empty ? "" : " and nonempty"));
        if (text.indexOf(0) >= 0) throw new IOException(label + " contains NUL");
        StandardCharsets.UTF_8.newEncoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
            .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT).encode(java.nio.CharBuffer.wrap(text));
        return text;
    }

    private static void validateMcpServer(Object value) throws IOException {
        if (!(value instanceof Map<?, ?> cfg)) throw new IOException("config must be an object");
        if (cfg.containsKey("idleTimeoutMs")) {
            Object raw = cfg.get("idleTimeoutMs");
            if (!(raw instanceof Number number) || !Double.isFinite(number.doubleValue()) || number.doubleValue() < 0
                || number.doubleValue() > 2147483647 || number.doubleValue() != Math.rint(number.doubleValue()))
                throw new IOException("idleTimeoutMs must be an integer from 0 through 2147483647");
        }
        Object transport = cfg.containsKey("type") ? cfg.get("type") : "stdio";
        if ("http".equals(transport)) {
            String raw = mcpConfigText(cfg.get("url"), "url", false);
            if (raw.chars().anyMatch(c -> c <= 32)) throw new IOException("invalid http url");
            URI url;
            try { url = URI.create(raw); } catch (IllegalArgumentException error) { throw new IOException("invalid http url", error); }
            String scheme = url.getScheme(), host = url.getHost();
            if (scheme == null || host == null || !(scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https"))
                || url.getPort() > 65535) throw new IOException("invalid http url");
            boolean loopback = Set.of("localhost", "127.0.0.1", "::1", "[::1]").contains(host.toLowerCase(Locale.ROOT));
            if (scheme.equalsIgnoreCase("http") && !loopback) throw new IOException("http transport requires HTTPS except for loopback");
            if (cfg.containsKey("headers")) {
                if (!(cfg.get("headers") instanceof Map<?, ?> headers)) throw new IOException("headers must be an object");
                for (var header : headers.entrySet()) {
                    if (!(header.getKey() instanceof String name) || !name.matches("[!#$%&'*+.^_`|~0-9A-Za-z-]+")) throw new IOException("invalid header name");
                    String text = mcpConfigText(header.getValue(), "header value", true);
                    if (!text.matches("[\\t\\x20-\\x7e\\x80-\\xff]*")) throw new IOException("invalid header value");
                }
            }
        } else if ("stdio".equals(transport)) {
            String command = mcpConfigText(cfg.get("command"), "command", false);
            if (command.chars().anyMatch(c -> ";|<>&".indexOf(c) >= 0)) throw new IOException("command contains shell operators");
            if (cfg.containsKey("args")) {
                if (!(cfg.get("args") instanceof List<?> args)) throw new IOException("args must be an array of strings");
                for (Object arg : args) mcpConfigText(arg, "argument", true);
            }
            if (cfg.containsKey("env")) {
                if (!(cfg.get("env") instanceof Map<?, ?> env)) throw new IOException("env must be an object");
                for (var entry : env.entrySet()) {
                    if (mcpConfigText(entry.getKey(), "env key", false).contains("=")) throw new IOException("invalid env key");
                    mcpConfigText(entry.getValue(), "env value", true);
                }
            }
        } else throw new IOException("unsupported transport type");
    }

    private static String validateAggregatorServer(String ns, Map<String, Object> cfg) {
        if (!AGGREGATOR_NS_RE.matcher(ns).matches()) return "invalid namespace '" + ns + "'";
        try { validateMcpServer(cfg); return null; }
        catch (IOException error) { return error.getMessage(); }
    }

    private static final class McpSseDecoder {
        private final ByteArrayOutputStream line = new ByteArrayOutputStream();
        private final List<String> data = new ArrayList<>();
        private boolean skipLF, firstLine = true;
        private final McpHttpDispatch dispatch;
        McpSseDecoder() { this(null); }
        McpSseDecoder(McpHttpDispatch dispatch) { this.dispatch = dispatch; }
        String feed(byte[] chunk) throws IOException {
            int start = 0;
            for (int index = 0; index < chunk.length; index++) {
                byte value = chunk[index];
                if (value != 10 && value != 13) continue;
                if (skipLF) {
                    skipLF = false;
                    if (value == 10 && index == start) { start = index + 1; continue; }
                }
                line.write(chunk, start, index - start);
                String result = finishLine();
                if (result != null) return result;
                skipLF = value == 13;
                start = index + 1;
            }
            if (start < chunk.length) { line.write(chunk, start, chunk.length - start); skipLF = false; }
            return null;
        }
        private String finishLine() throws IOException {
            String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT).decode(ByteBuffer.wrap(line.toByteArray())).toString();
            line.reset();
            if (firstLine) { firstLine = false; if (text.startsWith("\ufeff")) text = text.substring(1); }
            if (text.isEmpty()) {
                String payload = String.join("\n", data); data.clear();
                Object parsed;
                try { parsed = parseJsonValue(payload); }
                catch (JsonDepthException | JsonNumberException excessive) { throw excessive; }
                catch (RuntimeException ignored) { return null; /* non-RPC events */ }
                if (parsed instanceof List<?> || parsed instanceof Map<?, ?> message
                        && (message.containsKey("method") || message.containsKey("result") || message.containsKey("error"))) {
                    Object response = dispatch == null ? parsed : dispatch.accept(parsed);
                    if (response != null) return response == parsed ? payload : toJson(response);
                }
            } else {
                int colon = text.indexOf(':');
                String field = colon < 0 ? text : text.substring(0, colon);
                if (field.equals("data")) {
                    String value = colon < 0 ? "" : text.substring(colon + 1);
                    data.add(value.startsWith(" ") ? value.substring(1) : value);
                }
            }
            return null;
        }
    }

    private static final HttpClient MCP_HTTP_CLIENT = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(30)).followRedirects(HttpClient.Redirect.NEVER).build();

    // Keep callback POSTs off HttpClient's response-delivery threads. Bounded tasks,
    // queued bytes, and one requested chunk per stream provide backpressure.
    private static final ThreadPoolExecutor MCP_HTTP_DISPATCH = new ThreadPoolExecutor(
        16, 16, 30, TimeUnit.SECONDS, new ArrayBlockingQueue<>(64), task -> {
            Thread thread = new Thread(task, "mcp-http-dispatch"); thread.setDaemon(true); return thread;
        });
    static { MCP_HTTP_DISPATCH.allowCoreThreadTimeOut(true); }
    private static final java.util.concurrent.atomic.AtomicLong mcpHttpDispatchBytes = new java.util.concurrent.atomic.AtomicLong();

    private static final class McpHttpBody implements HttpResponse.BodySubscriber<String> {
        private final CompletableFuture<String> body = new CompletableFuture<>();
        private final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        private final long declaredLength;
        private long received;
        private final McpSseDecoder sse;
        private volatile Flow.Subscription subscription;
        private final Object workLock = new Object();
        private FutureTask<Void> pending;
        private boolean ended;
        McpHttpBody(long declaredLength, boolean eventStream) { this(declaredLength, eventStream, null); }
        McpHttpBody(long declaredLength, boolean eventStream, McpHttpDispatch dispatch) {
            this.declaredLength = declaredLength;
            sse = eventStream ? new McpSseDecoder(dispatch) : null;
        }
        public CompletionStage<String> getBody() { return body; }
        public void onSubscribe(Flow.Subscription value) {
            subscription = value;
            if (body.isDone()) value.cancel();
            else if (declaredLength > AGGREGATOR_HTTP_MAX_RESP) fail(new IOException("MCP HTTP response exceeds 16 MiB"));
            else value.request(1);
        }
        private void fail(Throwable error) {
            body.completeExceptionally(error);
            Flow.Subscription value = subscription;
            if (value != null) value.cancel();
            synchronized (workLock) { if (pending != null) pending.cancel(true); }
        }
        public void onNext(List<ByteBuffer> buffers) {
            if (body.isDone()) return;
            long count = 0;
            for (ByteBuffer buffer : buffers) count += buffer.remaining();
            received += count;
            if (received > AGGREGATOR_HTTP_MAX_RESP) { fail(new IOException("MCP HTTP response exceeds 16 MiB")); return; }
            if (sse == null) {
                for (ByteBuffer buffer : buffers) { byte[] chunk = new byte[buffer.remaining()]; buffer.get(chunk); bytes.writeBytes(chunk); }
                subscription.request(1);
                return;
            }
            final long charge = count;
            long used;
            do {
                used = mcpHttpDispatchBytes.get();
                if (charge > AGGREGATOR_HTTP_MAX_RESP - used) { fail(new IOException("MCP HTTP dispatch capacity exceeded")); return; }
            } while (!mcpHttpDispatchBytes.compareAndSet(used, used + charge));
            byte[] chunk = new byte[(int) count];
            int offset = 0;
            for (ByteBuffer buffer : buffers) { int size = buffer.remaining(); buffer.get(chunk, offset, size); offset += size; }
            AtomicBoolean started = new AtomicBoolean(), released = new AtomicBoolean();
            Runnable release = () -> { if (released.compareAndSet(false, true)) mcpHttpDispatchBytes.addAndGet(-charge); };
            FutureTask<Void> task = new FutureTask<>(() -> {
                try {
                    if (body.isDone()) return null;
                    String message = sse.feed(chunk);
                    if (message != null) { body.complete(message); subscription.cancel(); return null; }
                    synchronized (workLock) {
                        pending = null;
                        if (ended) finish();
                        else if (!body.isDone()) subscription.request(1);
                    }
                } catch (Throwable error) { fail(error); }
                return null;
            }) {
                public void run() { started.set(true); try { super.run(); } finally { release.run(); } }
                protected void done() {
                    MCP_HTTP_DISPATCH.remove(this);
                    if (!started.get()) release.run();
                }
            };
            synchronized (workLock) {
                if (body.isDone()) { task.cancel(false); return; }
                pending = task;
                try { MCP_HTTP_DISPATCH.execute(task); }
                catch (RejectedExecutionException error) { task.cancel(false); fail(new IOException("MCP HTTP dispatch capacity exceeded", error)); }
            }
        }
        public void onError(Throwable error) { fail(error); }
        public void onComplete() {
            synchronized (workLock) { ended = true; if (pending == null) finish(); }
        }
        private void finish() {
            if (body.isDone()) return;
            if (sse != null) { body.completeExceptionally(new IOException("SSE stream ended without an RPC response")); return; }
            try {
                String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                    .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes.toByteArray())).toString();
                body.complete(text.startsWith("\ufeff") ? text.substring(1) : text);
            } catch (Exception error) { body.completeExceptionally(error); }
        }
    }

    private static long mcpSetupRemaining(long deadlineNanos) throws IOException {
        long remaining = deadlineNanos - System.nanoTime();
        if (remaining <= 0) throw new IOException("MCP HTTP setup deadline exceeded");
        return Math.max(1, TimeUnit.NANOSECONDS.toMillis(remaining));
    }

    private static long mcpHttpTimeoutMillis(String method) {
        return "tools/call".equals(method) ? 90_000 : 30_000;
    }

    private static final class McpHttpCancellation {
        boolean cancelled;
        final Set<CompletableFuture<?>> requests = new HashSet<>();
        void cancel() {
            List<CompletableFuture<?>> pending;
            synchronized (this) {
                cancelled = true;
                pending = new ArrayList<>(requests);
                requests.clear();
            }
            for (var request : pending) request.cancel(true);
        }
    }

    private static void expireMcpHttp(McpHttpCancellation scope) {
        // Namespace and SID alone cannot identify a connection generation.
        for (String ns : aggregatorHttp.keySet()) {
            aggregatorHttp.computeIfPresent(ns, (key, current) -> current.get("cancellation") == scope ? null : current);
        }
        List<CompletableFuture<?>> setups = new ArrayList<>();
        for (String key : mcpHttp.keySet()) {
            mcpHttp.computeIfPresent(key, (ignored, current) -> {
                if (current.get("cancellation") != scope) return current;
                mcpServerTools.remove(key);
                if (current.get("setup_done") instanceof CompletableFuture<?> setup) setups.add(setup);
                return null;
            });
        }
        for (var setup : setups) setup.completeExceptionally(new IOException("MCP HTTP session expired"));
        scope.cancel();
    }

    private static HttpResponse<String> sendMcpHttp(HttpRequest request, long timeoutMs) throws IOException, InterruptedException {
        return sendMcpHttp(request, timeoutMs, null);
    }

    private static HttpResponse<String> sendMcpHttp(HttpRequest request, long timeoutMs, McpHttpCancellation cancellation) throws IOException, InterruptedException {
        return sendMcpHttp(request, timeoutMs, cancellation, null, false);
    }

    private static HttpResponse<String> sendMcpHttp(HttpRequest request, long timeoutMs, McpHttpCancellation cancellation,
            McpHttpDispatch dispatch, boolean oneWay) throws IOException, InterruptedException {
        CompletableFuture<HttpResponse<String>> response;
        var subscriber = new java.util.concurrent.atomic.AtomicReference<McpHttpBody>();
        AtomicBoolean stopped = new AtomicBoolean();
        // Serialize registration with unload, so it cannot miss a newly started exchange.
        synchronized (cancellation != null ? cancellation : new Object()) {
            if (cancellation != null && cancellation.cancelled) throw new IOException("MCP server was unloaded");
            response = MCP_HTTP_CLIENT.sendAsync(request, info -> {
                boolean expired = info.statusCode() == 404 && cancellation != null
                    && request.headers().firstValue("Mcp-Session-Id").filter(value -> !value.isEmpty()).isPresent();
                if (expired) expireMcpHttp(cancellation);
                McpHttpBody value = new McpHttpBody(info.headers().firstValueAsLong("Content-Length").orElse(-1),
                    !oneWay && info.statusCode() >= 200 && info.statusCode() < 300
                        && info.statusCode() != 202 && info.statusCode() != 204
                        && info.headers().firstValueAsLong("Content-Length").orElse(-1) != 0
                        && info.headers().firstValue("Content-Type").orElse("").toLowerCase(Locale.ROOT).contains("text/event-stream"), dispatch);
                subscriber.set(value);
                if (expired) value.fail(new IOException("MCP HTTP session expired; start a new call to reconnect"));
                else if (stopped.get()) value.fail(new IOException("MCP HTTP request was cancelled"));
                return value;
            });
            if (cancellation != null) {
                if (cancellation.cancelled) response.cancel(true);
                else cancellation.requests.add(response);
            }
        }
        try { return response.get(timeoutMs, TimeUnit.MILLISECONDS); }
        catch (TimeoutException error) {
            response.cancel(true);
            throw new IOException("MCP HTTP response deadline exceeded", error);
        } catch (InterruptedException error) {
            response.cancel(true);
            throw error;
        } catch (CancellationException error) {
            throw new IOException("MCP HTTP request was cancelled", error);
        } catch (ExecutionException error) {
            Throwable cause = error.getCause();
            if (cause instanceof IOException io) throw io;
            throw new IOException("MCP HTTP request failed", cause);
        } finally {
            stopped.set(true);
            McpHttpBody value = subscriber.get();
            if (value != null && !value.body.isDone()) value.fail(new IOException("MCP HTTP request was cancelled"));
            if (cancellation != null) {
                synchronized (cancellation) { cancellation.requests.remove(response); }
            }
        }
    }

    private static final class McpHttpDispatch {
        final Map<String, Object> info;
        final int requestId;
        final long deadline;
        int callbacks;
        McpHttpDispatch(Map<String, Object> info, int requestId, long timeoutMs) {
            this.info = info; this.requestId = requestId;
            deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs);
        }
        private long remaining() throws IOException {
            if (Thread.currentThread().isInterrupted()) throw new IOException("MCP HTTP callback was cancelled");
            McpHttpCancellation cancellation = (McpHttpCancellation) info.get("cancellation");
            if (cancellation != null) synchronized (cancellation) {
                if (cancellation.cancelled) throw new IOException("MCP server was unloaded");
            }
            return mcpSetupRemaining(deadline);
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> accept(Object payload) throws IOException {
            remaining();
            boolean batched = payload instanceof List<?>;
            if (!batched && !(payload instanceof Map<?, ?>)) throw new IOException("invalid RPC response envelope");
            if (!batched && payload instanceof Map<?, ?> single && !single.containsKey("method"))
                return (Map<String, Object>) single;
            List<?> messages = mcpBatchMessages(payload);
            List<Map<String, Object>> replies = new ArrayList<>();
            Map<String, Object> response = null;
            boolean sawResponse = false;
            for (Object item : messages) {
                if (!(item instanceof Map<?, ?>)) { replies.add(mcpServerRequest(Map.of())); continue; }
                Map<String, Object> message = (Map<String, Object>) item;
                if (message.containsKey("method")) {
                    if (!mcpIsNotification(message)) replies.add(mcpServerRequest(message));
                } else {
                    boolean matches = message.get("id") instanceof Number id && id.doubleValue() == requestId;
                    if (message.containsKey("result") || message.containsKey("error") || matches) {
                        sawResponse = true;
                        if (matches) response = message;
                    } else replies.add(mcpServerRequest(message));
                }
            }
            if (sawResponse && response == null) throw new IOException("MCP HTTP batch has no matching RPC response");
            if (messages.isEmpty()) replies.add(mcpServerRequest(Map.of()));
            if (!replies.isEmpty()) {
                callbacks += replies.size();
                if (callbacks > MCP_MAX_BATCH_MESSAGES) throw new IOException("MCP HTTP response exceeds 1024 callbacks");
                String body = toJson(batched && !messages.isEmpty() ? replies : replies.getFirst());
                if (body.getBytes(StandardCharsets.UTF_8).length > AGGREGATOR_HTTP_MAX_RESP)
                    throw new IOException("MCP HTTP callback response exceeds 16 MiB");
                long timeout = Math.min(30_000, remaining());
                try {
                    HttpResponse<String> reply = sendMcpHttp(mcpHttpRequestBuilder(info, "", body, timeout).build(),
                        timeout, (McpHttpCancellation) info.get("cancellation"), null, true);
                    if (reply.statusCode() < 200 || reply.statusCode() >= 300) throw new IOException("http " + reply.statusCode());
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    throw new IOException("MCP HTTP callback was cancelled", error);
                }
            }
            remaining();
            return response;
        }
    }

    private static Map<?, ?> mcpRpcResult(Map<String, Object> message, int requestId) throws IOException {
        if (message == null || !"2.0".equals(message.get("jsonrpc"))
            || !(message.get("id") instanceof Number id) || id.doubleValue() != requestId)
            throw new IOException("invalid RPC response envelope");
        if (message.containsKey("result") == message.containsKey("error"))
            throw new IOException("RPC response must contain exactly one of result or error");
        if (message.containsKey("error")) throw new IOException("rpc error: " + message.get("error"));
        if (!(message.get("result") instanceof Map<?, ?> result)) throw new IOException("MCP RPC result must be an object");
        return result;
    }

    private static final Set<String> MCP_HANDSHAKE_VERSIONS = Set.of("2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25");

    private static String mcpNegotiatedVersion(Map<?, ?> result) throws IOException {
        // Future revisions may change transport and lifecycle semantics.
        if (!(result.get("protocolVersion") instanceof String version) || !MCP_HANDSHAKE_VERSIONS.contains(version))
            throw new IOException("unsupported or invalid MCP protocol version");
        return version;
    }

    private static HttpRequest.Builder mcpHttpRequestBuilder(Map<String, Object> info, String method, String body, long timeoutMs) {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create((String) info.get("url")))
            .timeout(Duration.ofMillis(timeoutMs))
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .POST(HttpRequest.BodyPublishers.ofString(body));
        if (info.get("headers") instanceof Map<?, ?> headers) {
            for (Map.Entry<?, ?> entry : headers.entrySet()) {
                if (entry.getKey() instanceof String key && entry.getValue() instanceof String value
                    && !key.equalsIgnoreCase("Content-Type") && !key.equalsIgnoreCase("Accept") && !key.equalsIgnoreCase("Mcp-Session-Id") && !key.equalsIgnoreCase("MCP-Protocol-Version"))
                    builder.setHeader(key, value);
            }
        }
        if (!method.equals("initialize") && info.get("protocol_version") instanceof String version)
            builder.header("MCP-Protocol-Version", version);
        if (!method.equals("initialize") && info.get("session_id") instanceof String sid && !sid.isEmpty())
            builder.header("Mcp-Session-Id", sid);
        return builder;
    }

    private static String mcpValidateSessionId(String value) throws IOException {
        if (value != null && value.isEmpty()) return null;
        if (value != null && !value.matches("[\\x21-\\x7e]+")) throw new IOException("invalid MCP session ID");
        return value;
    }

    @SuppressWarnings("unchecked")
    private static Map<?, ?> aggregatorHttpRpc(String ns, String method, Map<String, Object> params, long timeoutMs) throws IOException {
        return aggregatorHttpRpc(ns, method, params, timeoutMs, null);
    }

    private static Map<?, ?> aggregatorHttpRpc(String ns, String method, Map<String, Object> params, long timeoutMs,
            McpHttpCancellation expected) throws IOException {
        Map<String, Object> info = aggregatorHttp.get(ns);
        if (expected != null && (info == null || info.get("cancellation") != expected))
            throw new IOException("MCP server was replaced during request");
        if (shuttingDown || info == null) throw new IOException("aggregator '" + ns + "' not running");
        McpHttpCancellation cancellation = (McpHttpCancellation) info.get("cancellation");
        int reqId = aggregatorNextId.incrementAndGet();
        boolean notification = method.startsWith("notifications/");
        String body = "{\"jsonrpc\":\"2.0\"" + (notification ? "" : ",\"id\":" + reqId)
            + ",\"method\":\"" + method + "\",\"params\":" + toJson(params) + "}";
        try {
            HttpRequest.Builder rb = mcpHttpRequestBuilder(info, method, body, timeoutMs);
            McpHttpDispatch dispatch = notification ? null : new McpHttpDispatch(info, reqId, timeoutMs);
            HttpResponse<String> resp = sendMcpHttp(rb.build(), timeoutMs, cancellation, dispatch, notification);
            synchronized (cancellation) {
                Map<String, Object> current = aggregatorHttp.get(ns);
                if (shuttingDown || cancellation.cancelled || current == null || current.get("cancellation") != cancellation)
                    throw new IOException("MCP server was unloaded during request");
            }
            int status = resp.statusCode();
            if (status < 200 || status >= 300) throw new IOException("http " + status);
            if (notification) return Map.of();
            if (status == 202 || status == 204 || resp.headers().firstValue("Content-Length").orElse("").equals("0")) {
                throw new IOException("RPC request received an empty response");
            }
            String text = resp.body();
            if (text == null || text.isBlank()) throw new IOException("RPC request received an empty response");
            if (text.length() > AGGREGATOR_HTTP_MAX_RESP) throw new IOException("aggregator '" + ns + "' response too large");
            Map<String, Object> msg = dispatch.accept(parseJsonValue(text));
            if (msg == null) throw new IOException("aggregator '" + ns + "' no JSON-RPC response");
            Map<?, ?> result = mcpRpcResult(msg, reqId);
            if (method.equals("initialize")) {
                String version = mcpNegotiatedVersion(result);
                String sid = mcpValidateSessionId(resp.headers().firstValue("Mcp-Session-Id").orElse(null));
                Map<String, Object> updated = new LinkedHashMap<>(info);
                updated.put("session_id", sid);
                updated.put("protocol_version", version);
                if (!aggregatorHttp.replace(ns, info, updated)) throw new IOException("MCP server was unloaded during request");
            }
            return result;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("aggregator '" + ns + "' http rpc interrupted", e);
        } catch (IOException e) {
            throw e;
        } catch (Exception e) {
            throw new IOException("aggregator '" + ns + "' http rpc failed: " + e.getMessage(), e);
        }
    }

    @SuppressWarnings("unchecked")
    private static List<AggregatedTool> aggregatorSpawnHttp(String ns, Map<String, Object> cfg) throws Exception {
        long setupDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        Map<String, Object> info = new LinkedHashMap<>();
        info.put("url", cfg.get("url"));
        Object headersRaw = cfg.get("headers");
        if (headersRaw instanceof Map<?, ?> hm) {
            Map<String, Object> headers = new LinkedHashMap<>();
            for (Map.Entry<?, ?> e : hm.entrySet()) {
                if (e.getKey() instanceof String k && e.getValue() instanceof String v) headers.put(k, v);
            }
            info.put("headers", headers);
        } else {
            info.put("headers", Map.of());
        }
        info.put("session_id", null);
        McpHttpCancellation cancellation = new McpHttpCancellation();
        info.put("cancellation", cancellation);
        synchronized (mcpOwnershipLock) {
            if (shuttingDown) throw new IOException("server is shutting down");
            aggregatorHttp.put(ns, info);
        }
        try {
            aggregatorHttpRpc(ns, "initialize", Map.of(
                "protocolVersion", "2024-11-05",
                "capabilities", Map.of("roots", Map.of()),
                "clientInfo", Map.of("name", "code-mcp-aggregator", "version", "0.1.0")
            ), mcpSetupRemaining(setupDeadline));
            aggregatorHttpRpc(ns, "notifications/initialized", Map.of(), mcpSetupRemaining(setupDeadline));
            Map<?, ?> result = discoverMcpTools((params, budget) -> aggregatorHttpRpc(ns, "tools/list", params, budget), setupDeadline);
            Object toolsRaw = result.get("tools");
            if (!(toolsRaw instanceof List<?>)) return List.of();
            List<AggregatedTool> out = new ArrayList<>();
            for (Object t : (List<?>) toolsRaw) {
                if (!(t instanceof Map<?, ?> tm)) continue;
                Object name = tm.get("name");
                if (!(name instanceof String)) continue;
                Object desc = tm.get("description");
                Object schemaRaw = tm.get("inputSchema");
                Map<String, Object> schema = schemaRaw instanceof Map
                    ? new LinkedHashMap<>((Map<String, Object>) schemaRaw)
                    : Map.of("type", "object");
                out.add(new AggregatedTool(ns, (String) name,
                    desc instanceof String s ? s : "", schema, new LinkedHashMap<>((Map<String, Object>) tm)));
            }
            mcpSetupRemaining(setupDeadline);
            return out;
        } catch (Exception e) {
            aggregatorHttp.computeIfPresent(ns, (key, current) -> current.get("cancellation") == cancellation ? null : current);
            cancellation.cancel();
            throw e;
        }
    }

    private static Map<?, ?> aggregatorRpc(String ns, String method, Map<String, Object> params, long timeoutMs) throws IOException {
        return aggregatorRpc(ns, method, params, timeoutMs, null);
    }

    private static Map<?, ?> aggregatorRpc(String ns, String method, Map<String, Object> params, long timeoutMs, Process expectedProc) throws IOException {
        if (shuttingDown) throw new IOException("server is shutting down");
        if (aggregatorHttp.containsKey(ns)) return aggregatorHttpRpc(ns, method, params, timeoutMs);
        Process proc = aggregatorProcesses.get(ns);
        if (expectedProc != null && proc != expectedProc) throw new IOException("MCP server was replaced during request");
        if (proc == null || !proc.isAlive()) throw new IOException("aggregator '" + ns + "' not running");
        Map<?, ?> result = stdioExchange(proc, method, params, timeoutMs);
        if (aggregatorProcesses.get(ns) != proc) throw new IOException("MCP server was unloaded during request");
        return result;
    }

    @SuppressWarnings("unchecked")
    private static List<AggregatedTool> aggregatorSpawn(String ns, Map<String, Object> cfg) throws Exception {
        if ("http".equals(cfg.get("type"))) {
            return aggregatorSpawnHttp(ns, cfg);
        }
        String cmd = (String) cfg.get("command");
        Object argsRaw = cfg.getOrDefault("args", List.of());
        List<?> argsList = argsRaw instanceof List<?> ? (List<?>) argsRaw : List.of();
        Map<String, String> extraEnv = new LinkedHashMap<>();
        Object envRaw = cfg.get("env");
        if (envRaw instanceof Map<?, ?> envMap) {
            for (Map.Entry<?, ?> e : envMap.entrySet()) {
                if (e.getKey() instanceof String k && e.getValue() != null) {
                    extraEnv.put(k, String.valueOf(e.getValue()));
                }
            }
        }
        List<String> cmdList = new ArrayList<>();
        cmdList.add(cmd);
        for (Object a : argsList) cmdList.add(String.valueOf(a));
        ProcessBuilder pb = new ProcessBuilder(cmdList);
        scrubEnv(pb);
        extraEnv.forEach((name, value) -> putMcpEnv(pb, name, value));
        pb.redirectError(ProcessBuilder.Redirect.DISCARD);
        long setupDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        Process proc = startMcpStdio(pb);
        mcpIdleRegister(proc, mcpIdleTimeout(cfg));
        boolean registered;
        synchronized (aggregatorStdioSetups) {
            registered = !shuttingDown;
            if (registered) {
                aggregatorProcesses.put(ns, proc);
                aggregatorReaders.put(ns, new BufferedReader(new InputStreamReader(proc.getInputStream(), StandardCharsets.UTF_8)));
                aggregatorLocks.put(ns, new Object());
            }
        }
        if (!registered) {
            closeMcpStdio(proc, "MCP server shutdown");
            throw new IOException("server is shutting down");
        }
        try {
            aggregatorRpc(ns, "initialize", Map.of(
                "protocolVersion", "2024-11-05",
                "capabilities", Map.of("roots", Map.of()),
                "clientInfo", Map.of("name", "code-mcp-aggregator", "version", "0.1.0")
            ), mcpSetupRemaining(setupDeadline));
            aggregatorRpc(ns, "notifications/initialized", Map.of(), mcpSetupRemaining(setupDeadline));
            Map<?, ?> result = discoverMcpTools((params, budget) -> aggregatorRpc(ns, "tools/list", params, budget, proc), setupDeadline);
            mcpSetupRemaining(setupDeadline);
            Object toolsRaw = result.get("tools");
            if (!(toolsRaw instanceof List<?>)) return List.of();
            List<AggregatedTool> out = new ArrayList<>();
            for (Object t : (List<?>) toolsRaw) {
                if (!(t instanceof Map<?, ?> tm)) continue;
                Object name = tm.get("name");
                if (!(name instanceof String)) continue;
                Object desc = tm.get("description");
                Object schemaRaw = tm.get("inputSchema");
                Map<String, Object> schema = schemaRaw instanceof Map
                    ? new LinkedHashMap<>((Map<String, Object>) schemaRaw)
                    : Map.of("type", "object");
                out.add(new AggregatedTool(ns, (String) name,
                    desc instanceof String s ? s : "", schema, new LinkedHashMap<>((Map<String, Object>) tm)));
            }
            return out;
        } catch (Exception e) {
            if (aggregatorProcesses.remove(ns, proc)) {
                aggregatorReaders.remove(ns);
                aggregatorLocks.remove(ns);
            }
            closeMcpStdio(proc, "MCP initialization failed");
            throw e;
        } finally {
            mcpIdleRelease(proc);
        }
    }

    @SuppressWarnings("unchecked")
    private static void loadAggregator(String configPath) {
        Path path = Path.of(configPath);
        if (!Files.exists(path)) {
            System.err.println("[mcp] config not found: " + configPath);
            return;
        }
        Map<String, Object> cfg;
        try {
            cfg = parseJsonObject(readMcpConfigText(path.toRealPath()));
        } catch (Exception e) {
            System.err.println("[mcp] failed to parse " + configPath + ": " + e.getMessage());
            return;
        }
        Object serversRaw = cfg.get("mcpServers");
        if (!(serversRaw instanceof Map<?, ?>)) {
            System.err.println("[mcp] " + configPath + " has no 'mcpServers' object; aggregation disabled");
            return;
        }
        Map<String, Object> servers = (Map<String, Object>) serversRaw;
        List<Map.Entry<String, Map<String, Object>>> valid = new ArrayList<>();
        for (var e : servers.entrySet()) {
            String ns = e.getKey();
            if (!(e.getValue() instanceof Map<?, ?>)) {
                System.err.println("[mcp] skipping '" + ns + "': not an object");
                continue;
            }
            Map<String, Object> scfg = (Map<String, Object>) e.getValue();
            String err = validateAggregatorServer(ns, scfg);
            if (err != null) {
                System.err.println("[mcp] skipping '" + ns + "': " + err);
                continue;
            }
            valid.add(Map.entry(ns, scfg));
            aggregatorKnown.add(ns);
            if ("http".equals(scfg.get("type"))) aggregatorHttpConfigs.put(ns, scfg);
            else aggregatorStdioConfigs.put(ns, scfg);
        }
        if (valid.isEmpty()) return;
        Set<String> ambiguousNames = new HashSet<>();
        ExecutorService pool = Executors.newFixedThreadPool(Math.min(8, valid.size()));
        try {
            List<Future<?>> futures = new ArrayList<>();
            for (var e : valid) {
                String ns = e.getKey();
                Map<String, Object> scfg = e.getValue();
                futures.add(pool.submit(() -> {
                    try {
                        List<AggregatedTool> entries = aggregatorSpawn(ns, scfg);
                        for (AggregatedTool t : entries) {
                            String prefixed = ns + "__" + t.tool();
                            synchronized (aggregatorTools) {
                                if (disallowedTools.contains(prefixed) || ambiguousNames.contains(prefixed)) continue;
                                if (aggregatorTools.containsKey(prefixed)) {
                                    aggregatorTools.remove(prefixed);
                                    ambiguousNames.add(prefixed);
                                    System.err.println("[mcp] ambiguous tool " + toJson(prefixed) + " disabled; rename namespaces or upstream tools");
                                } else {
                                    aggregatorTools.put(prefixed, t);
                                }
                            }
                        }
                        String transport = "http".equals(scfg.get("type")) ? "http" : "stdio";
                        System.err.println("[mcp] probed '" + ns + "' (" + transport + "): " + entries.size() + " tool(s) discovered");
                    } catch (Exception ex) {
                        System.err.println("[mcp] probe '" + ns + "' failed: " + ex.getMessage());
                    }
                }));
            }
            for (Future<?> f : futures) {
                try { f.get(); } catch (Exception ignored) {}
            }
        } finally {
            pool.shutdown();
        }
    }

    private static void shutdownAggregator() {
        List<Process> startup;
        List<CompletableFuture<Process>> setups;
        synchronized (aggregatorStdioSetups) {
            startup = new ArrayList<>(aggregatorProcesses.values());
            aggregatorProcesses.clear();
            aggregatorReaders.clear();
            aggregatorLocks.clear();
            setups = new ArrayList<>(aggregatorStdioSetups.values());
            aggregatorStdioSetups.clear();
            aggregatorStdioConfigs.clear();
        }
        for (CompletableFuture<Process> setup : setups) setup.completeExceptionally(new IOException("MCP server shutdown"));
        List<Map<String, Object>> startupHttp;
        List<CompletableFuture<McpHttpCancellation>> httpSetups;
        synchronized (mcpOwnershipLock) {
            startupHttp = new ArrayList<>(aggregatorHttp.values());
            aggregatorHttp.clear();
            httpSetups = new ArrayList<>(aggregatorHttpSetups.values());
            aggregatorHttpSetups.clear();
            aggregatorHttpConfigs.clear();
        }
        for (var setup : httpSetups) setup.completeExceptionally(new IOException("MCP server shutdown"));
        for (Map<String, Object> info : startupHttp) ((McpHttpCancellation) info.get("cancellation")).cancel();
        for (Process p : startup) closeMcpStdio(p, "MCP server shutdown");
        // Dynamic per-project servers belong to this process too.
        for (String key : new ArrayList<>(mcpProcesses.keySet())) removeMcpStdio(key, null);
        for (String key : new ArrayList<>(mcpHttp.keySet())) unloadMcpHttp(key);
        List<Process> owned;
        synchronized (mcpOwnershipLock) { owned = new ArrayList<>(mcpOwnedStdio); }
        for (Process proc : owned) closeMcpStdio(proc, "MCP server shutdown");
        cleanupWindowsMcpJob();
    }

    private static McpHttpCancellation ensureAggregatedHttp(String ns) throws IOException {
        Map<String, Object> cfg;
        CompletableFuture<McpHttpCancellation> setup;
        boolean owner;
        synchronized (mcpOwnershipLock) {
            if (shuttingDown) throw new IOException("server is shutting down");
            cfg = aggregatorHttpConfigs.get(ns);
            if (cfg == null) return null;
            setup = aggregatorHttpSetups.get(ns);
            Map<String, Object> info = aggregatorHttp.get(ns);
            if (setup == null && info != null) return (McpHttpCancellation) info.get("cancellation");
            owner = setup == null;
            if (owner) {
                setup = new CompletableFuture<>();
                aggregatorHttpSetups.put(ns, setup);
            }
        }
        if (owner) {
            try {
                aggregatorSpawnHttp(ns, cfg);
                synchronized (mcpOwnershipLock) {
                    if (shuttingDown || aggregatorHttpSetups.get(ns) != setup)
                        throw new IOException("MCP server shutdown during initialization");
                    Map<String, Object> info = aggregatorHttp.get(ns);
                    if (info == null) throw new IOException("MCP server was unloaded during initialization");
                    setup.complete((McpHttpCancellation) info.get("cancellation"));
                }
            } catch (Exception error) { setup.completeExceptionally(error); }
            finally { synchronized (mcpOwnershipLock) { aggregatorHttpSetups.remove(ns, setup); } }
        }
        McpHttpCancellation connection;
        try { connection = setup.get(30, TimeUnit.SECONDS); }
        catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IOException("MCP startup recovery interrupted", error);
        } catch (ExecutionException | TimeoutException error) {
            throw new IOException("MCP startup recovery failed: " + error.getMessage(), error);
        }
        Map<String, Object> info = aggregatorHttp.get(ns);
        if (shuttingDown || info == null || info.get("cancellation") != connection)
            throw new IOException("MCP server was replaced during initialization");
        return connection;
    }

    private static Process ensureAggregatedStdio(String ns) throws IOException {
        // Reconnect only before a new user call; never replay failed tool work.
        Map<String, Object> cfg;
        CompletableFuture<Process> setup;
        boolean owner;
        synchronized (aggregatorStdioSetups) {
            if (shuttingDown) throw new IOException("server is shutting down");
            cfg = aggregatorStdioConfigs.get(ns);
            if (cfg == null) return null;
            setup = aggregatorStdioSetups.get(ns);
            Process proc = aggregatorProcesses.get(ns);
            if (setup == null && proc != null && proc.isAlive() && !mcpStdioClosed(proc)) return proc;
            owner = setup == null;
            if (owner) {
                setup = new CompletableFuture<>();
                aggregatorStdioSetups.put(ns, setup);
            }
        }
        if (owner) {
            try {
                aggregatorSpawn(ns, cfg);
                synchronized (aggregatorStdioSetups) {
                    if (shuttingDown || aggregatorStdioSetups.get(ns) != setup)
                        throw new IOException("MCP server shutdown during initialization");
                    setup.complete(aggregatorProcesses.get(ns));
                }
            } catch (Exception error) {
                setup.completeExceptionally(error);
            } finally {
                synchronized (aggregatorStdioSetups) { aggregatorStdioSetups.remove(ns, setup); }
            }
        }
        Process proc;
        try { proc = setup.get(30, TimeUnit.SECONDS); }
        catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IOException("MCP startup recovery interrupted", error);
        } catch (ExecutionException | TimeoutException error) {
            throw new IOException("MCP startup recovery failed: " + error.getMessage(), error);
        }
        if (shuttingDown) throw new IOException("server is shutting down");
        if (proc == null) throw new IOException("MCP server was unloaded during initialization");
        return proc;
    }

    @SuppressWarnings("unchecked")
    private static Map<?, ?> callAggregatedRaw(String prefixedName, Map<String, Object> args) throws IOException {
        AggregatedTool info = aggregatorTools.get(prefixedName);
        if (info == null) throw new IOException("unknown aggregated tool: " + prefixedName);
        McpHttpCancellation http = ensureAggregatedHttp(info.ns());
        if (http != null) return validateMcpToolResult(aggregatorHttpRpc(info.ns(), "tools/call",
            Map.of("name", info.tool(), "arguments", args == null ? Map.of() : args), 90_000, http));
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        Process proc;
        while (true) {
            proc = ensureAggregatedStdio(info.ns());
            if (mcpIdleAcquire(proc)) break;
            if (System.nanoTime() >= deadline) throw new IOException("MCP server idle retirement raced initialization");
        }
        try {
            return validateMcpToolResult(aggregatorRpc(info.ns(), "tools/call",
                Map.of("name", info.tool(), "arguments", args == null ? Map.of() : args), 90_000, proc));
        } finally {
            mcpIdleRelease(proc);
        }
    }

    @SuppressWarnings("unchecked")
    private static String renderGuide(String cwd) throws IOException {
        List<String> lines = new ArrayList<>();
        lines.add("<guide tool=\"code-mcp\">");
        lines.add("");

        boolean canRecall = memoryEnabled && !disallowedTools.contains("recall");
        boolean canRemember = memoryEnabled && !disallowedTools.contains("remember");
        boolean canForget = memoryEnabled && !disallowedTools.contains("forget");
        boolean canMcp = !disallowedTools.contains("mcp");
        MemoState memoState = canRecall ? collectMemoState(cwd) : null;
        List<String> docs = disallowedTools.contains("read") ? List.of() : collectProjectDocs(cwd);

        lines.add("<state cwd=\"" + xmlAttr(cwd) + "\">");
        if (memoState != null) {
            String latestSuffix = memoState.latest != null ? " (latest " + xmlAttr(memoState.latest) + ")" : "";
            lines.add("memos: " + memoState.count + latestSuffix);
            lines.add("concurrent_writer: " + (memoState.lockHeld ? "yes" : "no"));
        }
        if (!docs.isEmpty()) {
            lines.add("project_docs: " + String.join(", ", docs) + "  (read for project rules)");
        }
        lines.add("</state>");

        if (canRecall || !docs.isEmpty()) {
            lines.add("");
            lines.add("<session_start>");
            int step = 1;
            if (canRecall) lines.add(step++ + ". call recall(cwd) first to load prior memos");
            if (!docs.isEmpty()) lines.add(step++ + ". read " + String.join(" and ", docs) + " for project rules");
            if (canRecall) lines.add(step++ + ". \"(no matches)\" from recall = fresh session");
            lines.add("</session_start>");
        }

        if (canRemember) {
            lines.add("");
            lines.add("<when_to_remember>");
            lines.add("- user signals handoff (e.g. \"handoff\", \"wrap up\"): tags=[\"handoff\"],");
            lines.add("  include file paths, last action, next step");
            lines.add("- design or architectural decisions: tags=[\"decision\"]");
            lines.add("- non-obvious behaviors, surprising bugs: tags=[\"gotcha\"]");
            lines.add("- followups: tags=[\"todo\"]");
            lines.add("</when_to_remember>");

            lines.add("");
        }
        if (canRecall || canRemember || canForget) {
            lines.add("<memory_rules>");
            lines.add("- memos are private to this cwd; never access the storage file directly,");
            lines.add("  use the enabled memory tools listed below");
            if (canRecall) lines.add("- tags are case-insensitive; multiple tags = AND filter");
            if (canRemember) lines.add("- non-string tags are dropped on write");
            lines.add("- multiple agents on the same cwd are serialized automatically");
            if (canRecall) lines.add("- recall: limit default 20 (max 1000), offset default 0");
            if (canRecall) lines.add("- paging past end returns \"(no matches at offset=N; total=M)\"");
            lines.add("</memory_rules>");
        }

        lines.add("");
        lines.add("<tools>");
        lines.add("built-in: " + String.join(", ", builtinToolNames()));
        List<Map<String, Object>> externals = canMcp ? listExternalServers() : List.of();
        List<Map<String, String>> loadable = canMcp ? collectLoadableServers(cwd) : List.of();
        Set<String> loadableSet = new HashSet<>();
        for (Map<String, String> l : loadable) loadableSet.add(l.get("ns"));
        Set<String> externalsSet = new HashSet<>();
        for (Map<String, Object> e : externals) externalsSet.add((String) e.get("ns"));
        if (!externals.isEmpty()) {
            lines.add("external (via mcp tool, prefix \"<server>__<tool>\"):");
            int nsWidth = externals.stream().mapToInt(e -> ((String) e.get("ns")).length()).max().orElse(0);
            for (Map<String, Object> e : externals) {
                String ns = (String) e.get("ns");
                List<String> tools = (List<String>) e.get("tools");
                String padded = ns + " ".repeat(Math.max(0, nsWidth - ns.length()));
                String also = loadableSet.contains(ns) ? "  [also in .mcp.json]" : "";
                if (tools != null && !tools.isEmpty()) {
                    String preview = String.join(", ", tools.subList(0, Math.min(6, tools.size())));
                    String hint = tools.size() > 6 ? preview + ", ... (" + tools.size() + " total)" : preview;
                    lines.add("- " + padded + "  tools: " + xmlAttr(hint) + also);
                } else {
                    lines.add("- " + padded + "  (tools not yet probed; call mcp(action=\"list\") to discover)" + also);
                }
            }
            lines.add("call mcp(action=\"list\") for full schemas of external tools.");
        }
        List<Map<String, String>> loadableOnly = new ArrayList<>();
        for (Map<String, String> l : loadable) if (!externalsSet.contains(l.get("ns"))) loadableOnly.add(l);
        if (!loadableOnly.isEmpty()) {
            if (!externals.isEmpty()) lines.add("");
            lines.add("loadable (via mcp tool from .mcp.json in cwd):");
            int lWidth = loadableOnly.stream().mapToInt(l -> l.get("ns").length()).max().orElse(0);
            for (Map<String, String> l : loadableOnly) {
                String ns = l.get("ns");
                String padded = ns + " ".repeat(Math.max(0, lWidth - ns.length()));
                lines.add("- " + padded + "  " + l.get("transport"));
            }
            lines.add("call mcp(action=\"list\", server=\"<name>\") to load tools on demand.");
        }
        lines.add("</tools>");

        lines.add("");
        lines.add("<cheat_sheet>");
        if (canRecall) {
            lines.add("recall(cwd)");
            lines.add("recall(cwd, query=\"webhook\")");
            lines.add("recall(cwd, tags=[\"decision\"], limit=5)");
        }
        if (canRemember) lines.add("remember(cwd, \"fixed bug at file.py:42\", tags=[\"bug\",\"fix\"])");
        if (canForget) lines.add("forget(cwd, 7)");
        lines.add("guide(cwd)");
        if (!externals.isEmpty()) lines.add("mcp(action=\"list\")");
        if (!loadableOnly.isEmpty()) lines.add("mcp(action=\"list\", server=\"" + loadableOnly.get(0).get("ns") + "\")");
        lines.add("</cheat_sheet>");
        lines.add("");
        lines.add("</guide>");
        return String.join("\n", lines);
    }

    // ----- JSON parser (FSM-based, RFC 8259 subset) -----
    private static final class JsonDepthException extends RuntimeException {
        JsonDepthException(int limit) { super("JSON: too deeply nested (>" + limit + ")"); }
    }

    private static final class JsonNumberException extends RuntimeException {
        JsonNumberException() { super("JSON: number exceeds finite range"); }
    }

    private static final class JsonParser {
        private final int maxDepth;
        private final String src;
        private int pos;
        private int depth = 0;
        JsonParser(String s) { this(s, 256); }
        JsonParser(String s, int maxDepth) { this.src = s; this.pos = 0; this.maxDepth = maxDepth; }

        Object parse() {
            skipWs();
            Object v = readValue();
            skipWs();
            if (pos != src.length()) {
                throw new RuntimeException("JSON: trailing data at pos " + pos);
            }
            return v;
        }

        private void skipWs() {
            while (pos < src.length()) {
                char c = src.charAt(pos);
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') pos++;
                else break;
            }
        }

        private Object readValue() {
            skipWs();
            if (pos >= src.length()) throw new RuntimeException("JSON: unexpected EOF");
            char c = src.charAt(pos);
            if (c == '{') return readObject();
            if (c == '[') return readArray();
            if (c == '"') return readString();
            if (c == 't' || c == 'f') return readBool();
            if (c == 'n') return readNull();
            if (c == '-' || (c >= '0' && c <= '9')) return readNumber();
            throw new RuntimeException("JSON: unexpected char '" + c + "' at pos " + pos);
        }

        private Map<String, Object> readObject() {
            if (++depth > maxDepth) throw new JsonDepthException(maxDepth);
            expect('{');
            Map<String, Object> m = new LinkedHashMap<>();
            skipWs();
            if (peek() == '}') { pos++; depth--; return m; }
            while (true) {
                skipWs();
                if (peek() != '"') throw new RuntimeException("JSON: expected string key at pos " + pos);
                String key = readString();
                skipWs();
                expect(':');
                Object value = readValue();
                m.put(key, value);
                skipWs();
                char c = peek();
                if (c == ',') { pos++; continue; }
                if (c == '}') { pos++; depth--; return m; }
                throw new RuntimeException("JSON: expected ',' or '}' at pos " + pos);
            }
        }

        private List<Object> readArray() {
            if (++depth > maxDepth) throw new JsonDepthException(maxDepth);
            expect('[');
            List<Object> list = new ArrayList<>();
            skipWs();
            if (peek() == ']') { pos++; depth--; return list; }
            while (true) {
                list.add(readValue());
                skipWs();
                char c = peek();
                if (c == ',') { pos++; continue; }
                if (c == ']') { pos++; depth--; return list; }
                throw new RuntimeException("JSON: expected ',' or ']' at pos " + pos);
            }
        }

        private int readHexCodeUnit(int offset) {
            if (offset + 4 > src.length()) throw new RuntimeException("JSON: bad unicode escape");
            int value = 0;
            for (int i = offset; i < offset + 4; i++) {
                char c = src.charAt(i);
                int digit = c >= '0' && c <= '9' ? c - '0'
                    : c >= 'a' && c <= 'f' ? c - 'a' + 10
                    : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
                if (digit < 0) throw new RuntimeException("JSON: bad unicode escape");
                value = (value << 4) | digit;
            }
            return value;
        }

        private String readString() {
            expect('"');
            StringBuilder sb = new StringBuilder();
            while (pos < src.length()) {
                char c = src.charAt(pos++);
                if (c == '"') return sb.toString();
                if (c == '\\') {
                    if (pos >= src.length()) throw new RuntimeException("JSON: dangling escape");
                    char esc = src.charAt(pos++);
                    switch (esc) {
                        case '"': sb.append('"'); break;
                        case '\\': sb.append('\\'); break;
                        case '/': sb.append('/'); break;
                        case 'b': sb.append('\b'); break;
                        case 'f': sb.append('\f'); break;
                        case 'n': sb.append('\n'); break;
                        case 'r': sb.append('\r'); break;
                        case 't': sb.append('\t'); break;
                        case 'u':
                            if (pos + 4 > src.length()) throw new RuntimeException("JSON: bad unicode escape");
                            int code = readHexCodeUnit(pos);
                            pos += 4;
                            // Surrogate pair handling
                            if (code >= 0xD800 && code <= 0xDBFF && pos + 6 <= src.length()
                                    && src.charAt(pos) == '\\' && src.charAt(pos + 1) == 'u') {
                                int low = readHexCodeUnit(pos + 2);
                                if (low >= 0xDC00 && low <= 0xDFFF) {
                                    sb.appendCodePoint(0x10000 + (((code - 0xD800) << 10) | (low - 0xDC00)));
                                    pos += 6;
                                    break;
                                }
                            }
                            sb.append((char) code);
                            break;
                        default: throw new RuntimeException("JSON: bad escape '\\" + esc + "'");
                    }
                } else if (c < 0x20) {
                    throw new RuntimeException("JSON: unescaped control char 0x" + Integer.toHexString(c));
                } else {
                    sb.append(c);
                }
            }
            throw new RuntimeException("JSON: unterminated string");
        }

        private Object readNumber() {
            int start = pos;
            if (peek() == '-') pos++;
            if (pos < src.length() && src.charAt(pos) == '0') {
                pos++;
            } else {
                requireNumberDigits();
            }
            if (pos < src.length() && src.charAt(pos) == '.') {
                pos++;
                requireNumberDigits();
            }
            if (pos < src.length() && (src.charAt(pos) == 'e' || src.charAt(pos) == 'E')) {
                pos++;
                if (pos < src.length() && (src.charAt(pos) == '+' || src.charAt(pos) == '-')) pos++;
                requireNumberDigits();
            }
            String num = src.substring(start, pos);
            if (num.contains(".") || num.contains("e") || num.contains("E")) {
                return finiteNumber(num);
            }
            try {
                return Long.parseLong(num);
            } catch (NumberFormatException e) {
                return finiteNumber(num);
            }
        }

        private void requireNumberDigits() {
            int start = pos;
            while (pos < src.length() && src.charAt(pos) >= '0' && src.charAt(pos) <= '9') pos++;
            if (pos == start) throw new RuntimeException("JSON: expected digit at pos " + pos);
        }

        private static double finiteNumber(String text) {
            double value = Double.parseDouble(text);
            if (!Double.isFinite(value)) throw new JsonNumberException();
            return value;
        }

        private Boolean readBool() {
            if (src.regionMatches(pos, "true", 0, 4)) { pos += 4; return Boolean.TRUE; }
            if (src.regionMatches(pos, "false", 0, 5)) { pos += 5; return Boolean.FALSE; }
            throw new RuntimeException("JSON: invalid literal at pos " + pos);
        }

        private Object readNull() {
            if (src.regionMatches(pos, "null", 0, 4)) { pos += 4; return null; }
            throw new RuntimeException("JSON: invalid literal at pos " + pos);
        }

        private char peek() {
            if (pos >= src.length()) throw new RuntimeException("JSON: unexpected EOF");
            return src.charAt(pos);
        }

        private void expect(char c) {
            if (pos >= src.length() || src.charAt(pos) != c) {
                throw new RuntimeException("JSON: expected '" + c + "' at pos " + pos);
            }
            pos++;
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> parseJsonObject(String json) {
        return parseJsonObject(json, 256);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> parseJsonObject(String json, int maxDepth) {
        Object v = new JsonParser(json, maxDepth).parse();
        if (!(v instanceof Map)) throw new RuntimeException("JSON: expected object, got " + (v == null ? "null" : v.getClass().getSimpleName()));
        return (Map<String, Object>) v;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> parseJsonArray(String json) {
        Object v = new JsonParser(json).parse();
        if (!(v instanceof List)) throw new RuntimeException("JSON: expected array");
        return (List<Object>) v;
    }

    private static Object parseJsonValue(String json) {
        return new JsonParser(json).parse();
    }

    private static String memoToJsonLine(Memo m) {
        StringBuilder sb = new StringBuilder();
        sb.append("{\"id\":").append(m.id)
          .append(",\"ts\":").append(m.ts)
          .append(",\"memo\":\"").append(escapeJson(m.memo)).append("\"");
        if (m.tags != null && !m.tags.isEmpty()) {
            sb.append(",\"tags\":[");
            boolean first = true;
            for (String t : m.tags) {
                if (!first) sb.append(',');
                first = false;
                sb.append('"').append(escapeJson(t)).append('"');
            }
            sb.append(']');
        }
        sb.append('}');
        return sb.toString();
    }

    private static String escapeJson(String s) {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '\\': sb.append("\\\\"); break;
                case '"':  sb.append("\\\""); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                default:
                    if (Character.isHighSurrogate(c) && i + 1 < s.length() && Character.isLowSurrogate(s.charAt(i + 1))) {
                        // Valid surrogate pair — pass through as two raw UTF-16 chars; UTF-8 encoder will produce 4 bytes.
                        sb.append(c);
                        sb.append(s.charAt(++i));
                    } else if (Character.isSurrogate(c)) {
                        // Lone surrogate — emit as \\uXXXX escape so resulting JSON is well-formed UTF-8.
                        sb.append(String.format("\\u%04x", (int) c));
                    } else if (c < 0x20 || c == 0x7F || (c >= 0x80 && c <= 0x9F) || c == 0x2028 || c == 0x2029) {
                        // C0+C1 controls, DEL, and JS-hostile U+2028/U+2029.
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        return sb.toString();
    }

    // The Windows JDK public attribute view omits both file ID and link count.
    // Native metadata calls use literal argv, bounded output and deadlines.
    private static byte[] memoWindowsMetadata(Path file, String operation, String action) throws IOException {
        String systemRoot = System.getenv().getOrDefault("SystemRoot", "C:\\Windows");
        Process process = new ProcessBuilder(Path.of(systemRoot, "System32", "fsutil.exe").toString(),
            operation, action, file.toAbsolutePath().toString())
            .redirectError(ProcessBuilder.Redirect.DISCARD).start();
        FutureTask<byte[]> output = new FutureTask<>(() -> process.getInputStream().readNBytes(65537));
        Thread reader = Thread.ofVirtual().name("memo-file-metadata").start(output);
        try {
            process.getOutputStream().close();
            byte[] bytes = output.get(5, TimeUnit.SECONDS);
            if (bytes.length > 65536 || !process.waitFor(1, TimeUnit.SECONDS) || process.exitValue() != 0)
                throw new IOException("cannot verify memo file metadata");
            return bytes;
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IOException("memo metadata check interrupted", interrupted);
        } catch (ExecutionException | TimeoutException failure) {
            throw new IOException("cannot verify memo file metadata", failure);
        } finally {
            if (process.isAlive()) process.destroyForcibly();
            try { process.getInputStream().close(); } catch (IOException ignored) { }
            output.cancel(true);
            reader.interrupt();
        }
    }

    private static Object memoFileIdentity(Path file) throws IOException {
        var info = Files.readAttributes(file, java.nio.file.attribute.BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (!info.isRegularFile() || info.isSymbolicLink()) throw new IOException("memo lock must be a regular file");
        if (info.fileKey() != null) return info.fileKey();
        if (!System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win"))
            throw new IOException("memo file identity is unavailable");
        String output = new String(memoWindowsMetadata(file, "file", "queryfileid"), StandardCharsets.US_ASCII);
        var id = Pattern.compile("(?i)0x([0-9a-f]{32}|[0-9a-f]{16})(?![0-9a-f])").matcher(output);
        if (!id.find()) throw new IOException("cannot determine memo file identity");
        return file.toAbsolutePath().getRoot().toString().toLowerCase(Locale.ROOT) + id.group(1).toLowerCase(Locale.ROOT);
    }

    private static void requireSingleMemoLink(Path file) throws IOException {
        if (!System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win")) {
            Object count = Files.getAttribute(file, "unix:nlink", LinkOption.NOFOLLOW_LINKS);
            if (!(count instanceof Number links) || links.longValue() != 1)
                throw new IOException("memo storage must not have hardlink aliases");
            return;
        }
        byte[] bytes = memoWindowsMetadata(file, "hardlink", "list");
        // Windows pathnames cannot contain LF; count bytes without decoding a
        // locale-dependent filename. No external alias names enter tool output.
        int links = 0;
        for (byte value : bytes) if (value == '\n') links++;
        if (bytes.length == 0 || bytes[bytes.length - 1] != '\n' || links != 1)
            throw new IOException("memo storage must not have hardlink aliases");
    }

    private static Set<OpenOption> memoOpenOptions(OpenOption... requested) throws IOException {
        Set<OpenOption> options = new HashSet<>(Arrays.asList(requested));
        if (System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win")) {
            // FileChannel has no portable descriptor identity API. Keep the
            // Windows path bound to this handle and exclude outside writers.
            try {
                options.add(com.sun.nio.file.ExtendedOpenOption.NOSHARE_DELETE);
                options.add(com.sun.nio.file.ExtendedOpenOption.NOSHARE_WRITE);
            } catch (LinkageError unsupported) {
                throw new IOException("Java runtime lacks required Windows memory file sharing options", unsupported);
            }
        }
        return options;
    }
    private record MemoStorageSnapshot(Object identity, long size, java.nio.file.attribute.FileTime modified, java.nio.file.attribute.FileTime created) {}
    private static MemoStorageSnapshot memoStorageSnapshot(Path path) throws IOException {
        java.nio.file.attribute.BasicFileAttributes info;
        try { info = Files.readAttributes(path, java.nio.file.attribute.BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS); }
        catch (NoSuchFileException missing) { return null; }
        if (!info.isRegularFile() || info.isSymbolicLink()) throw new IOException("memo storage must be a regular file");
        requireSingleMemoLink(path);
        return new MemoStorageSnapshot(memoFileIdentity(path), info.size(), info.lastModifiedTime(), info.creationTime());
    }
    private static void requireMemoSnapshot(Path path, MemoStorageSnapshot expected) throws IOException {
        if (!Objects.equals(memoStorageSnapshot(path), expected)) throw new IOException("memo storage changed during append preparation");
    }
    private record MemoAppendState(long highest, String separator, long size, MemoStorageSnapshot snapshot) {}
    private static long memoLineId(ByteArrayOutputStream bytes, java.util.function.Consumer<Memo> visit) throws IOException {
        if (bytes.size() == 0) return 0;
        // Strict decoding is outside the malformed-JSON catch.
        String line = StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes.toByteArray())).toString();
        // Preserve original JSON whitespace rules by parsing the unmodified line.
        if (!line.stripLeading().startsWith("{")) return 0;
        Memo memo;
        try { memo = parseMemo(line); }
        catch (RuntimeException invalid) { return 0; }
        if (visit != null) visit.accept(memo);
        return memo.id;
    }
    private static MemoAppendState readMemoAppendState(String cwd) throws IOException {
        return readMemoAppendState(cwd, null);
    }
    private static MemoAppendState readMemoAppendState(String cwd, java.util.function.Consumer<Memo> visit) throws IOException {
        Path memoFile = Path.of(cwd, ".memo.jsonl");
        MemoStorageSnapshot snapshot = memoStorageSnapshot(memoFile);
        if (snapshot == null) return new MemoAppendState(0, "", 0, null);
        if (snapshot.size > MAX_READ_BYTES) throw new IOException("memo storage exceeds 100 MiB limit");
        long highest = 0, consumed = 0;
        int lastByte = -1;
        try (FileChannel channel = FileChannel.open(memoFile, memoOpenOptions(StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS))) {
            if (channel.size() != snapshot.size) throw new IOException("memo storage changed during read");
            ByteBuffer buffer = ByteBuffer.allocate(64 * 1024);
            ByteArrayOutputStream line = new ByteArrayOutputStream();
            while (true) {
                buffer.clear();
                buffer.limit((int) Math.min(buffer.capacity(), snapshot.size - consumed + 1));
                int count = channel.read(buffer);
                if (count < 0) break;
                if (count == 0) throw new IOException("memo read made no progress");
                consumed += count;
                if (consumed > snapshot.size) throw new IOException("memo storage changed during read");
                byte[] bytes = buffer.array();
                lastByte = bytes[count - 1] & 0xff;
                int start = 0;
                for (int i = 0; i < count; i++) {
                    if (bytes[i] != '\n') continue;
                    line.write(bytes, start, i - start);
                    highest = Math.max(highest, memoLineId(line, visit));
                    line.reset();
                    start = i + 1;
                }
                if (start < count) line.write(bytes, start, count - start);
            }
            if (line.size() > 0) highest = Math.max(highest, memoLineId(line, visit));
            if (consumed != snapshot.size || channel.size() != snapshot.size)
                throw new IOException("memo storage changed during read");
        }
        requireMemoSnapshot(memoFile, snapshot);
        return new MemoAppendState(highest, consumed > 0 && lastByte != 10 ? "\n" : "", snapshot.size, snapshot);
    }

    private static void rollbackMemoAppend(FileChannel channel, Path path, MemoStorageSnapshot opened, long size, byte[] data) throws IOException {
        MemoStorageSnapshot current = memoStorageSnapshot(path);
        if (current == null || !Objects.equals(current.identity, opened.identity) || current.size < size
                || current.size - size > data.length || channel.size() != current.size)
            throw new IOException("memo append recovery refused: file identity or size changed");
        long extra = current.size - size;
        try (FileChannel verify = FileChannel.open(path, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
            verify.position(size);
            ByteBuffer buffer = ByteBuffer.allocate(64 * 1024);
            for (int offset = 0; offset < extra;) {
                buffer.clear(); buffer.limit((int) Math.min(buffer.capacity(), extra - offset));
                int count = verify.read(buffer);
                if (count <= 0) throw new IOException("memo append recovery refused: incomplete verification read");
                for (int i = 0; i < count; i++) {
                    if (buffer.array()[i] != data[offset + i]) throw new IOException("memo append recovery refused: appended bytes changed");
                }
                offset += count;
            }
            if (verify.size() != current.size) throw new IOException("memo append recovery refused: file changed while checking");
        }
        requireMemoSnapshot(path, current);
        if (channel.size() != current.size) throw new IOException("memo append recovery refused: file size changed");
        if (extra > 0) channel.truncate(size);
        channel.force(true);
    }

    // ===== TOOL HANDLERS =====

    // --- read tool ---
    private static long[] readRange(Map<?, ?> args) throws IOException {
        if (!args.containsKey("range")) return null;
        if (!(args.get("range") instanceof List<?> values) || values.size() != 2)
            throw new IOException("range must be [start, end]");
        long[] range = new long[2];
        for (int i = 0; i < 2; i++) {
            if (!(values.get(i) instanceof Number number)) throw new IOException("range items must be integers");
            double value = number.doubleValue();
            if (!Double.isFinite(value) || value != Math.floor(value) || value < 1 || value > 9007199254740991L)
                throw new IOException("range items must be integers from 1 to 9007199254740991");
            range[i] = number.longValue();
        }
        if (range[0] > range[1]) throw new IOException("range start must not exceed end");
        return range;
    }

    private static String handleRead(String cwd, String path, long[] range, boolean noTruncate) throws IOException {
        StandardCharsets.UTF_8.newEncoder().encode(java.nio.CharBuffer.wrap(cwd));
        StandardCharsets.UTF_8.newEncoder().encode(java.nio.CharBuffer.wrap(path));
        String shape = java.io.File.separatorChar == '\\' ? path.replace('\\', '/') : path;
        String last = shape.substring(shape.lastIndexOf('/') + 1);
        if (last.isEmpty() || last.equals(".") || last.equals("..")) throw new IOException("read path must name a file");
        Path cwdPath = Path.of(cwd).toAbsolutePath();
        Path base = cwdPath.toRealPath();
        if (!Files.isDirectory(base)) throw new IOException("cwd must be an existing directory");
        Path supplied = Path.of(path);
        Path requested = supplied.isAbsolute() ? supplied : cwdPath.resolve(supplied);
        // Use Write's physical component order, then apply Read's spill exception.
        Path file = resolveWritePath(requested.getRoot(), requested);
        if (!file.startsWith(base) && !(spillRoot != null
            && file.startsWith(Path.of(spillRoot).toRealPath()))) throw new IOException("path escapes cwd");
        var before = Files.readAttributes(file, java.nio.file.attribute.BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (!before.isRegularFile()) throw new IOException("not a regular file");
        long initialSize = before.size();
        if (range == null && initialSize > MAX_READ_BYTES) throw new IOException("file too large; use a range");
        ByteArrayOutputStream selected = new ByteArrayOutputStream();
        // Java exposes no portable fstat on FileChannel. NOFOLLOW and identity,
        // size and timestamp checks detect ordinary swaps/changes, not hostile races.
        try (FileChannel channel = FileChannel.open(file, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
            verifyReadFile(file, before, channel);
            ByteBuffer buffer = ByteBuffer.allocate(64 * 1024);
            long remaining = initialSize, line = 1, scanned = 0;
            // Regular virtual files can report zero size yet have content.
            // Bound their entire EOF-driven scan, including skipped lines.
            boolean unknownSize = initialSize == 0;
            long start = range == null ? 1 : range[0], end = range == null ? Long.MAX_VALUE : range[1];
            boolean finished = false;
            while ((unknownSize || remaining > 0) && !finished) {
                buffer.clear();
                long limit = unknownSize ? MAX_READ_BYTES + 1L - scanned : remaining;
                buffer.limit((int) Math.min(buffer.capacity(), limit));
                int count = channel.read(buffer);
                if (count < 0) {
                    if (unknownSize) break;
                    throw new IOException("file truncated during read");
                }
                if (count == 0) throw new IOException("file read made no progress");
                scanned += count;
                if (unknownSize && scanned > MAX_READ_BYTES) throw new IOException("zero-size file exceeded read scan limit");
                if (!unknownSize) remaining -= count;
                byte[] bytes = buffer.array();
                int segment = line >= start ? 0 : -1;
                for (int i = 0; i < count; i++) {
                    if (bytes[i] != '\n') continue;
                    if (line == end) {
                        if (segment >= 0) appendReadBytes(selected, bytes, segment, i - segment);
                        finished = true;
                        segment = -1;
                        break;
                    }
                    line++;
                    if (line == start) segment = i + 1;
                }
                if (segment >= 0) appendReadBytes(selected, bytes, segment, count - segment);
            }
            verifyReadFile(file, before, channel);
        }
        String content = StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(selected.toByteArray())).toString();
        return noTruncate ? content : maybeSpillText(content, "read");
    }

    private static void appendReadBytes(ByteArrayOutputStream selected, byte[] bytes, int offset, int count) throws IOException {
        if ((long) selected.size() + count > MAX_READ_BYTES) throw new IOException("selected text exceeds 100 MiB read limit");
        selected.write(bytes, offset, count);
    }

    private static void verifyReadFile(Path file, java.nio.file.attribute.BasicFileAttributes before,
                                       FileChannel channel) throws IOException {
        var now = Files.readAttributes(file, java.nio.file.attribute.BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (!now.isRegularFile() || !Objects.equals(before.fileKey(), now.fileKey())
            || !before.creationTime().equals(now.creationTime()) || before.size() != now.size()
            || before.size() != channel.size() || !before.lastModifiedTime().equals(now.lastModifiedTime()))
            throw new IOException("file changed during read");
    }

    // --- write tool ---
    private static String writeString(Map<?, ?> args, String key, boolean allowEmpty) throws IOException {
        if (!(args.get(key) instanceof String value) || (!allowEmpty && value.isEmpty())) {
            throw new IOException(key + " must be " + (allowEmpty ? "a string" : "a nonempty string"));
        }
        return value;
    }
    private record WriteState(Object key, boolean directory, boolean symbolicLink,
                              long size, java.nio.file.attribute.FileTime modified) {}

    private static WriteState writeState(Path path) throws IOException {
        var a = Files.readAttributes(path, java.nio.file.attribute.BasicFileAttributes.class,
            LinkOption.NOFOLLOW_LINKS);
        // Windows' JDK provider does not expose fileKey. Its creation timestamp
        // still detects ordinary replacement; unlike a native file ID it cannot
        // distinguish deliberate timestamp cloning by another local process.
        // These optimistic checks are not a sandbox against hostile local code.
        Object identity = a.fileKey() != null ? a.fileKey() : a.creationTime();
        return new WriteState(identity, a.isDirectory(), a.isSymbolicLink(), a.size(), a.lastModifiedTime());
    }

    private static void rememberWritePath(Path path, Map<Path, WriteState> states) throws IOException {
        for (Path p = path; p != null; p = p.getParent()) {
            if (Files.exists(p, LinkOption.NOFOLLOW_LINKS)) states.putIfAbsent(p, writeState(p));
        }
    }

    private static void checkWriteStates(Map<Path, WriteState> states) throws IOException {
        for (var entry : states.entrySet()) {
            WriteState old = entry.getValue(), now = writeState(entry.getKey());
            // Creating our sibling temporary file changes directory timestamps.
            if (!old.key().equals(now.key()) || old.directory() != now.directory()
                || old.symbolicLink() != now.symbolicLink()
                || (!old.directory() && (old.size() != now.size() || !old.modified().equals(now.modified())))) {
                throw new IOException("path changed during write: " + entry.getKey());
            }
        }
    }

    private static Path resolveWritePath(Path base, Path requested) throws IOException {
        // Resolve components in physical order. Appending an unresolved suffix
        // then normalizing can reveal a symlink after missing/.. and escape cwd.
        Path resolved = requested.getRoot();
        for (Path component : requested) {
            if (Files.exists(resolved, LinkOption.NOFOLLOW_LINKS) && !Files.isDirectory(resolved))
                throw new IOException("write parent is not a directory");
            String name = component.toString();
            if (name.equals(".")) continue;
            if (name.equals("..")) {
                if (resolved.getParent() != null) resolved = resolved.getParent();
                continue;
            }
            resolved = resolved.resolve(component);
            if (Files.exists(resolved, LinkOption.NOFOLLOW_LINKS)) resolved = resolved.toRealPath();
        }
        if (!resolved.startsWith(base)) throw new IOException("path escapes cwd");
        return resolved;
    }

    private static void checkWriteTarget(Path file) throws IOException {
        if (!Files.exists(file, LinkOption.NOFOLLOW_LINKS)) return;
        if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) throw new IOException("not a regular file");
        if (!Files.isWritable(file)) throw new IOException("file is not writable");
        if (file.getFileSystem().supportedFileAttributeViews().contains("posix")) {
            var mode = Files.getPosixFilePermissions(file, LinkOption.NOFOLLOW_LINKS);
            if (!mode.contains(java.nio.file.attribute.PosixFilePermission.OWNER_WRITE)
                && !mode.contains(java.nio.file.attribute.PosixFilePermission.GROUP_WRITE)
                && !mode.contains(java.nio.file.attribute.PosixFilePermission.OTHERS_WRITE)) {
                throw new IOException("file is read-only");
            }
        }
    }

    private static void stageWriteMetadata(Path source, Path temp) throws IOException {
        String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
        List<String> command;
        if (os.contains("mac")) {
            // Apple's cp preserves ACLs/resource forks that the JDK cannot see.
            // Both operands are absolute paths, so cannot become command options.
            command = List.of("/bin/cp", "-p", source.toString(), temp.toString());
        } else if (os.contains("linux")) {
            // Explicit xattr preservation makes errors fatal (GNU --preserve=all
            // may silently ignore xattr/security-context preservation failures).
            command = List.of("/bin/cp", "--attributes-only",
                "--preserve=mode,ownership,timestamps,xattr", "--", source.toString(), temp.toString());
        } else if (os.contains("win")) {
            // The JDK ACL view omits descriptor control flags (e.g. automatic
            // inheritance). Use the OS descriptor API, as Python/TS do, so an
            // atomic overwrite preserves the complete DACL and named streams.
            String source64 = Base64.getEncoder().encodeToString(source.toString().getBytes(StandardCharsets.UTF_16LE));
            String temp64 = Base64.getEncoder().encodeToString(temp.toString().getBytes(StandardCharsets.UTF_16LE));
            String script = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; "
                + "$s=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('" + source64 + "')); "
                + "$d=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('" + temp64 + "')); "
                + "Copy-Item -LiteralPath $s -Destination $d -Force; $acl=Get-Acl -LiteralPath $s; Set-Acl -LiteralPath $d -AclObject $acl";
            String systemRoot = System.getenv().getOrDefault("SystemRoot", "C:\\Windows");
            command = List.of(Path.of(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe").toString(),
                "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand",
                Base64.getEncoder().encodeToString(script.getBytes(StandardCharsets.UTF_16LE)));
        } else {
            throw new IOException("atomic overwrite metadata preservation is unsupported on this platform");
        }
        Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
        try {
            if (!process.waitFor(30, java.util.concurrent.TimeUnit.SECONDS))
                throw new IOException("file metadata preservation timed out");
            byte[] diagnostic = process.getInputStream().readNBytes(65536);
            if (process.exitValue() != 0) throw new IOException("cannot preserve file metadata: "
                + new String(diagnostic, StandardCharsets.UTF_8).strip());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("metadata preservation interrupted", e);
        } finally {
            if (process.isAlive()) process.destroyForcibly();
        }
    }

    private static void copyWriteMetadata(Path source, Path temp) throws IOException {
        var posix = Files.getFileAttributeView(source, java.nio.file.attribute.PosixFileAttributeView.class,
            LinkOption.NOFOLLOW_LINKS);
        if (posix != null) {
            var original = posix.readAttributes();
            var target = Files.getFileAttributeView(temp, java.nio.file.attribute.PosixFileAttributeView.class,
                LinkOption.NOFOLLOW_LINKS);
            var current = target.readAttributes();
            if (!current.owner().equals(original.owner())) target.setOwner(original.owner());
            if (!current.group().equals(original.group())) target.setGroup(original.group());
            target.setPermissions(original.permissions());
        }
        var acl = Files.getFileAttributeView(source, java.nio.file.attribute.AclFileAttributeView.class,
            LinkOption.NOFOLLOW_LINKS);
        if (acl != null) {
            var target = Files.getFileAttributeView(temp, java.nio.file.attribute.AclFileAttributeView.class,
                LinkOption.NOFOLLOW_LINKS);
            if (!target.getOwner().equals(acl.getOwner())) target.setOwner(acl.getOwner());
            target.setAcl(acl.getAcl());
        }
        var user = Files.getFileAttributeView(source, java.nio.file.attribute.UserDefinedFileAttributeView.class,
            LinkOption.NOFOLLOW_LINKS);
        if (user != null) {
            var target = Files.getFileAttributeView(temp, java.nio.file.attribute.UserDefinedFileAttributeView.class,
                LinkOption.NOFOLLOW_LINKS);
            for (String key : user.list()) {
                ByteBuffer value = ByteBuffer.allocate(user.size(key));
                user.read(key, value);
                value.flip();
                target.write(key, value);
            }
        }
        var dos = Files.getFileAttributeView(source, java.nio.file.attribute.DosFileAttributeView.class,
            LinkOption.NOFOLLOW_LINKS);
        if (dos != null) {
            var original = dos.readAttributes();
            var target = Files.getFileAttributeView(temp, java.nio.file.attribute.DosFileAttributeView.class,
                LinkOption.NOFOLLOW_LINKS);
            target.setArchive(original.isArchive());
            target.setHidden(original.isHidden());
            target.setSystem(original.isSystem());
            target.setReadOnly(original.isReadOnly());
        }
    }

    private record ExpectedWrite(Path file, WriteState state) {}
    @FunctionalInterface
    private interface WriteCommitGuard { void check() throws IOException; }

    private static String handleWrite(String cwd, String path, String content) throws IOException {
        return handleWrite(cwd, path, content, null);
    }

    private static String handleWrite(String cwd, String path, String content, ExpectedWrite expected) throws IOException {
        return handleWrite(cwd, path, content, expected, null);
    }

    private static String handleWrite(String cwd, String path, String content, ExpectedWrite expected, WriteCommitGuard beforeCommit) throws IOException {
        // Strict text conversion stays outside the private binary upload path.
        ByteBuffer bytes = StandardCharsets.UTF_8.newEncoder().encode(java.nio.CharBuffer.wrap(content));
        return handleWriteBytes(cwd, path, bytes, expected, beforeCommit);
    }

    private static String handleWriteBytes(String cwd, String path, ByteBuffer bytes, ExpectedWrite expected, WriteCommitGuard beforeCommit) throws IOException {
        StandardCharsets.UTF_8.newEncoder().encode(java.nio.CharBuffer.wrap(cwd));
        StandardCharsets.UTF_8.newEncoder().encode(java.nio.CharBuffer.wrap(path));
        String shape = java.io.File.separatorChar == '\\' ? path.replace('\\', '/') : path;
        String last = shape.substring(shape.lastIndexOf('/') + 1);
        if (last.isEmpty() || last.equals(".") || last.equals("..")) throw new IOException("write path must name a file");
        int byteCount = bytes.remaining();
        Path cwdPath = Path.of(cwd).toAbsolutePath();
        Path base = cwdPath.toRealPath();
        if (!Files.isDirectory(base)) throw new IOException("cwd must be an existing directory");
        Path supplied = Path.of(path);
        Path requested = supplied.isAbsolute() ? supplied : cwdPath.resolve(supplied);
        Path file = resolveWritePath(base, requested);
        checkWriteTarget(file);
        Map<Path, WriteState> states = new LinkedHashMap<>();
        rememberWritePath(cwdPath, states);
        rememberWritePath(requested, states);
        rememberWritePath(file, states);
        // Edit's pre-read version must still be the writer's initial version.
        // The existing checks below then guard that snapshot through staging.
        if (expected != null && (!expected.file().equals(file) || !expected.state().equals(states.get(file))))
            throw new IOException("file changed during edit");
        boolean existed = Files.exists(file, LinkOption.NOFOLLOW_LINKS);
        Deque<Path> parents = new ArrayDeque<>();
        for (Path p = file.getParent(); !Files.exists(p, LinkOption.NOFOLLOW_LINKS); p = p.getParent()) parents.addFirst(p);
        for (Path parent : parents) {
            checkWriteStates(states);
            Files.createDirectory(parent);
            rememberWritePath(parent, states);
            checkWriteStates(states);
        }
        checkWriteStates(states);
        if (!resolveWritePath(base, requested).equals(file)) throw new IOException("path changed during write");
        Path temp = null;
        WriteState temporaryState = null;
        try {
            temp = Files.createTempFile(file.getParent(), ".code-mcp-write-", ".tmp");
            temporaryState = writeState(temp);
            if (existed) {
                checkWriteStates(states);
                stageWriteMetadata(file, temp);
                temporaryState = writeState(temp);
                checkWriteStates(states);
                if (temporaryState.directory() || temporaryState.symbolicLink()) throw new IOException("invalid staging file");
            }
            try (FileChannel output = FileChannel.open(temp, StandardOpenOption.WRITE,
                    StandardOpenOption.TRUNCATE_EXISTING, LinkOption.NOFOLLOW_LINKS)) {
                while (bytes.hasRemaining()) output.write(bytes);
                output.force(true);
            }
            // Reapplying a JDK ACL on Windows would discard inheritance flags
            // preserved by stageWriteMetadata's full security descriptor copy.
            if (existed && !System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win"))
                copyWriteMetadata(file, temp);
            checkWriteStates(states);
            if (!resolveWritePath(base, requested).equals(file)
                || existed != Files.exists(file, LinkOption.NOFOLLOW_LINKS)) throw new IOException("path changed during write");
            checkWriteTarget(file);
            WriteState ready = writeState(temp);
            if (!temporaryState.key().equals(ready.key()) || ready.symbolicLink()
                || ready.directory() || ready.size() != byteCount) throw new IOException("temporary file changed during write");
            // Portable JDK has no renameat/mkdirat or compare-and-swap rename.
            // These checks detect changes, but cannot close a hostile local
            // process's last check-to-rename race. Never fall back to a non-atomic move.
            if (beforeCommit != null) beforeCommit.check();
            Files.move(temp, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            temp = null;
            return "wrote " + byteCount + " bytes to " + path;
        } finally {
            if (temp != null && Files.exists(temp, LinkOption.NOFOLLOW_LINKS)
                && temporaryState != null && temporaryState.key().equals(writeState(temp).key())) Files.delete(temp);
        }
    }

    // --- edit tool ---
    private static String handleEdit(String cwd, String path, String oldStr, String newStr) throws IOException {
        if (cwd == null || cwd.isEmpty() || path == null || path.isEmpty()
            || oldStr == null || oldStr.isEmpty() || newStr == null)
            throw new IOException("cwd, path and old_str must be nonempty strings; new_str must be a string");
        // Validate even text which is not found: no encoder substitution or null
        // string concatenation may silently change the requested replacement.
        for (String value : List.of(cwd, path, oldStr, newStr))
            StandardCharsets.UTF_8.newEncoder().encode(java.nio.CharBuffer.wrap(value));
        String shape = java.io.File.separatorChar == '\\' ? path.replace('\\', '/') : path;
        String last = shape.substring(shape.lastIndexOf('/') + 1);
        if (last.isEmpty() || last.equals(".") || last.equals("..")) throw new IOException("edit path must name a file");
        Path cwdPath = Path.of(cwd).toAbsolutePath();
        Path base = cwdPath.toRealPath();
        if (!Files.isDirectory(base)) throw new IOException("cwd must be an existing directory");
        Path supplied = Path.of(path);
        Path requested = supplied.isAbsolute() ? supplied : cwdPath.resolve(supplied);
        Path file = resolveWritePath(base, requested); // Edit never gets Read's spill exception.
        if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) throw new IOException("not a regular file");
        checkWriteTarget(file);
        ExpectedWrite expected = new ExpectedWrite(file, writeState(file));
        String text = handleRead(base.toString(), file.toString(), null, true);
        if (!resolveWritePath(base, requested).equals(file) || !expected.state().equals(writeState(file)))
            throw new IOException("file changed during edit");
        int first = text.indexOf(oldStr);
        if (first == -1) throw new IOException("old_str not found");
        // Move one character, not oldStr.length(), to include overlapping matches.
        if (text.indexOf(oldStr, first + 1) != -1) throw new IOException("old_str not unique");
        String result = text.substring(0, first) + newStr + text.substring(first + oldStr.length());
        handleWrite(cwd, path, result, expected);
        return "ok";
    }

    // --- multi_edit tool ---
    private static class Edit {
        final String path;
        final String oldStr;
        final String newStr;

        Edit(String path, String oldStr, String newStr) {
            this.path = path;
            this.oldStr = oldStr;
            this.newStr = newStr;
        }
    }

    private record MultiState(WriteState file, Object mode) {}
    private static MultiState multiState(Path path) throws IOException {
        Object mode;
        if (path.getFileSystem().supportedFileAttributeViews().contains("posix")) {
            mode = Files.getPosixFilePermissions(path, LinkOption.NOFOLLOW_LINKS);
        } else {
            var dos = Files.readAttributes(path, java.nio.file.attribute.DosFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            mode = List.of(dos.isReadOnly(), dos.isHidden(), dos.isSystem(), dos.isArchive());
        }
        return new MultiState(writeState(path), mode);
    }

    private static class MultiFile {
        final Path file;
        final Set<Path> requested = new LinkedHashSet<>();
        final Map<Path, WriteState> parents = new LinkedHashMap<>();
        MultiState originalState, committedState;
        Map<String, Object> originalUnixMetadata;
        String original, text;
        int count;
        Path stage, backup;
        WriteState stageIdentity, backupIdentity;
        MultiState stageReady, backupReady;
        boolean committed, retainBackup;
        MultiFile(Path file) { this.file = file; }
    }

    private static long multiUtf8Size(String text) {
        long bytes = 0;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c < 0x80) bytes++;
            else if (c < 0x800) bytes += 2;
            else if (Character.isHighSurrogate(c)) { bytes += 4; i++; }
            else bytes += 3;
        }
        return bytes;
    }

    private static void checkMultiPath(Path base, MultiFile entry, MultiState expected) throws IOException {
        checkWriteStates(entry.parents);
        for (Path requested : entry.requested)
            if (!resolveWritePath(base, requested).equals(entry.file)) throw new IOException("multi_edit path changed: " + requested);
        if (!Files.isRegularFile(entry.file, LinkOption.NOFOLLOW_LINKS) || !expected.equals(multiState(entry.file)))
            throw new IOException("multi_edit file changed: " + entry.file);
    }

    private static void checkMultiTemporary(Path path, WriteState identity) throws IOException {
        if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) || !identity.key().equals(writeState(path).key()))
            throw new IOException("multi_edit temporary file changed: " + path);
    }

    private static Map<String, Object> multiUnixMetadata(Path path) throws IOException {
        if (!path.getFileSystem().supportedFileAttributeViews().contains("unix")) return Map.of();
        return Files.readAttributes(path, "unix:mode,uid,gid", LinkOption.NOFOLLOW_LINKS);
    }

    private static void stageMultiFile(Path base, MultiFile entry, boolean backup) throws IOException {
        checkMultiPath(base, entry, entry.originalState);
        Path temp = Files.createTempFile(entry.file.getParent(), ".code-mcp-multi-", backup ? ".backup" : ".stage");
        WriteState identity = writeState(temp);
        if (backup) { entry.backup = temp; entry.backupIdentity = identity; }
        else { entry.stage = temp; entry.stageIdentity = identity; }
        stageWriteMetadata(entry.file, temp);
        // Native metadata copying can update creationTime on Windows, where
        // the JDK identity fallback is that timestamp. Save the copied identity.
        if (!Files.isRegularFile(temp, LinkOption.NOFOLLOW_LINKS)) throw new IOException("invalid multi_edit staging file");
        identity = writeState(temp);
        if (backup) entry.backupIdentity = identity; else entry.stageIdentity = identity;
        checkMultiPath(base, entry, entry.originalState);
        byte[] bytes = (backup ? entry.original : entry.text).getBytes(StandardCharsets.UTF_8);
        checkMultiTemporary(temp, identity);
        try (FileChannel channel = FileChannel.open(temp, StandardOpenOption.WRITE,
                StandardOpenOption.TRUNCATE_EXISTING, LinkOption.NOFOLLOW_LINKS)) {
            checkMultiTemporary(temp, identity);
            ByteBuffer buffer = ByteBuffer.wrap(bytes);
            while (buffer.hasRemaining()) channel.write(buffer);
            channel.force(true);
        }
        if (!System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win")) {
            if (backup) {
                // Writing exact backup bytes can clear setuid/setgid and file
                // capabilities. Restore native metadata after the final write;
                // changed output deliberately keeps its existing Write policy.
                checkMultiPath(base, entry, entry.originalState);
                if (!entry.originalUnixMetadata.equals(multiUnixMetadata(entry.file)))
                    throw new IOException("multi_edit source ownership or full mode changed: " + entry.file);
                checkMultiTemporary(temp, identity);
                stageWriteMetadata(entry.file, temp);
                checkMultiTemporary(temp, identity);
                checkMultiPath(base, entry, entry.originalState);
                if (!entry.originalUnixMetadata.equals(multiUnixMetadata(entry.file))
                    || !entry.originalUnixMetadata.equals(multiUnixMetadata(temp)))
                    throw new IOException("multi_edit backup ownership or full mode mismatch: " + temp);
            } else {
                copyWriteMetadata(entry.file, temp);
            }
        }
        if (backup) Files.setLastModifiedTime(temp, entry.originalState.file().modified());
        checkMultiTemporary(temp, identity);
        checkMultiPath(base, entry, entry.originalState);
        MultiState ready = multiState(temp);
        if (ready.file().size() != bytes.length) throw new IOException("multi_edit staging size changed");
        if (backup) entry.backupReady = ready; else entry.stageReady = ready;
    }

    private static void cleanupMultiTemporary(Path path, WriteState identity, List<String> problems) {
        if (path == null) return;
        try {
            if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) return;
            checkMultiTemporary(path, identity);
            Files.delete(path);
        } catch (Exception e) { problems.add("cleanup failed for " + path + ": " + e.getMessage()); }
    }

    private static String normalizeMultiWindowsPath(String value) throws IOException {
        if (java.io.File.separatorChar != '\\') return value;
        String windows = value.replace('/', '\\');
        // Explicit namespaces retain their requested OS semantics.
        if (windows.startsWith("\\\\?\\") || windows.startsWith("\\\\.\\")) return value;
        String[] parts = windows.split("\\\\", -1);
        int uncNames = windows.startsWith("\\\\") ? 2 : 0;
        for (int i = 0; i < parts.length; i++) {
            String part = parts[i];
            if (part.isEmpty()) continue;
            if (uncNames > 0) { uncNames--; continue; }
            String drive = "";
            if (i == 0 && part.length() >= 2 && Character.isLetter(part.charAt(0)) && part.charAt(1) == ':') {
                drive = part.substring(0, 2);
                part = part.substring(2);
                if (part.isEmpty()) continue;
            }
            if (part.equals(".") || part.equals("..")) continue;
            int end = part.length();
            if (i == parts.length - 1) {
                // Only the final segment trims all terminal dots and spaces.
                while (end > 0 && (part.charAt(end - 1) == '.' || part.charAt(end - 1) == ' ')) end--;
            } else if (part.charAt(end - 1) == '.' && !part.endsWith("..")) {
                // Intermediate segments remove one terminal period. Spaces
                // remain literal; never redirect a legal spaced directory.
                end--;
            }
            if (end == 0) throw new IOException("multi_edit path component is empty after Win32 normalization");
            if (i < parts.length - 1 && (part.charAt(end - 1) == ' ' || part.charAt(end - 1) == '.'))
                throw new IOException("unsupported or ambiguous Windows intermediate path component: " + part);
            parts[i] = drive + part.substring(0, end);
        }
        return String.join("\\", parts);
    }

    private static String handleMultiEdit(String cwd, List<Edit> edits) throws IOException {
        if (cwd == null || cwd.isEmpty() || edits == null || edits.isEmpty() || edits.size() > 1000)
            throw new IOException("cwd must be nonempty; edits must contain 1 to 1000 items");
        StandardCharsets.UTF_8.newEncoder().encode(java.nio.CharBuffer.wrap(cwd));
        // Finish every argument check before filesystem staging or mutation.
        for (Edit edit : edits) {
            if (edit.path == null || edit.path.isEmpty() || edit.oldStr == null || edit.oldStr.isEmpty() || edit.newStr == null)
                throw new IOException("path and old_str must be nonempty strings; new_str must be a string");
            for (String value : List.of(edit.path, edit.oldStr, edit.newStr))
                StandardCharsets.UTF_8.newEncoder().encode(java.nio.CharBuffer.wrap(value));
            String shape = java.io.File.separatorChar == '\\' ? edit.path.replace('\\', '/') : edit.path;
            String last = shape.substring(shape.lastIndexOf('/') + 1);
            if (last.isEmpty() || last.equals(".") || last.equals("..")) throw new IOException("multi_edit path must name a file");
            Path.of(normalizeMultiWindowsPath(edit.path)); // Reject NUL before any staging.
        }
        Path cwdPath = Path.of(normalizeMultiWindowsPath(cwd)).toAbsolutePath(), base = cwdPath.toRealPath();
        if (!Files.isDirectory(base)) throw new IOException("cwd must be an existing directory");
        Map<Path, MultiFile> files = new LinkedHashMap<>();
        Map<String, MultiFile> requestedCache = new HashMap<>();
        List<MultiFile> ordered = new ArrayList<>();
        long originalBytes = 0;
        for (Edit edit : edits) {
            Path supplied = Path.of(normalizeMultiWindowsPath(edit.path));
            Path requested = supplied.isAbsolute() ? supplied : cwdPath.resolve(supplied);
            MultiFile cached = requestedCache.get(edit.path);
            if (cached != null) {
                ordered.add(cached);
                continue;
            }
            Path file = resolveWritePath(base, requested);
            MultiFile entry = files.get(file);
            if (entry == null) {
                entry = new MultiFile(file);
                if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) throw new IOException("not a regular file: " + file);
                checkWriteTarget(file);
                entry.originalState = multiState(file);
                entry.originalUnixMetadata = multiUnixMetadata(file);
                if (originalBytes + entry.originalState.file().size() > MAX_READ_BYTES)
                    throw new IOException("multi_edit original text exceeds 100 MiB total limit");
                rememberWritePath(cwdPath, entry.parents);
                rememberWritePath(file.getParent(), entry.parents);
                rememberWritePath(requested.getParent(), entry.parents);
                entry.requested.add(requested);
                checkMultiPath(base, entry, entry.originalState);
                entry.original = handleRead(base.toString(), file.toString(), null, true);
                checkMultiPath(base, entry, entry.originalState);
                originalBytes += multiUtf8Size(entry.original);
                if (originalBytes > MAX_READ_BYTES) throw new IOException("multi_edit original text exceeds 100 MiB total limit");
                entry.text = entry.original;
                files.put(file, entry);
            } else {
                entry.requested.add(requested);
                rememberWritePath(requested.getParent(), entry.parents);
                // This distinct alias was just physically resolved. Do not
                // rescan every prior alias for each edit; staging and commit
                // revalidate the complete deduplicated alias set.
                if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)
                    || !entry.originalState.equals(multiState(file)))
                    throw new IOException("multi_edit file changed: " + file);
            }
            requestedCache.put(edit.path, entry);
            ordered.add(entry);
        }
        long workingBytes = originalBytes;
        for (int i = 0; i < edits.size(); i++) {
            Edit edit = edits.get(i);
            MultiFile entry = ordered.get(i);
            int first = entry.text.indexOf(edit.oldStr);
            if (first < 0) throw new IOException("edit #" + (i + 1) + ": old_str not found");
            if (entry.text.indexOf(edit.oldStr, first + 1) >= 0) throw new IOException("edit #" + (i + 1) + ": old_str not unique");
            long predicted = workingBytes - multiUtf8Size(edit.oldStr) + multiUtf8Size(edit.newStr);
            if (predicted > MAX_READ_BYTES) throw new IOException("multi_edit working text exceeds 100 MiB total limit");
            entry.text = entry.text.substring(0, first) + edit.newStr + entry.text.substring(first + edit.oldStr.length());
            workingBytes = predicted;
            entry.count++;
        }
        List<MultiFile> batch = new ArrayList<>(files.values());
        List<String> problems = new ArrayList<>();
        boolean complete = false;
        try {
            for (MultiFile entry : batch) {
                stageMultiFile(base, entry, false);
                stageMultiFile(base, entry, true);
            }
            for (MultiFile entry : batch) checkMultiPath(base, entry, entry.originalState);
            for (MultiFile entry : batch) {
                checkMultiPath(base, entry, entry.originalState);
                checkWriteTarget(entry.file);
                if (!entry.stageReady.equals(multiState(entry.stage)) || !entry.backupReady.equals(multiState(entry.backup)))
                    throw new IOException("multi_edit staged content changed: " + entry.file);
                Files.move(entry.stage, entry.file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
                entry.stage = null;
                entry.committed = true;
                // The known staged snapshot also covers a failure observing the
                // newly renamed file. Never adopt an external replacement.
                entry.committedState = entry.stageReady;
                if (!entry.committedState.equals(multiState(entry.file))) throw new IOException("multi_edit committed file changed: " + entry.file);
            }
            complete = true;
        } catch (Exception failure) {
            problems.add("multi_edit failed: " + failure.getMessage());
            for (int i = batch.size() - 1; i >= 0; i--) {
                MultiFile entry = batch.get(i);
                if (!entry.committed) continue;
                try {
                    checkMultiPath(base, entry, entry.committedState);
                    if (!entry.backupReady.equals(multiState(entry.backup))) throw new IOException("backup changed");
                    Files.move(entry.backup, entry.file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
                    entry.backup = null;
                    entry.committed = false;
                } catch (Exception rollback) {
                    entry.retainBackup = true;
                    problems.add("PARTIAL FAILURE: cannot restore " + entry.file + "; original backup " + entry.backup + ": " + rollback.getMessage());
                }
            }
        } finally {
            for (MultiFile entry : batch) {
                cleanupMultiTemporary(entry.stage, entry.stageIdentity, problems);
                if (!entry.retainBackup) cleanupMultiTemporary(entry.backup, entry.backupIdentity, problems);
            }
        }
        if (!problems.isEmpty()) throw new IOException((complete ? "edits committed; " : "") + String.join("; ", problems));
        String summary = batch.stream().map(e -> e.file + " (" + e.count + " edit" + (e.count > 1 ? "s" : "") + ")")
            .collect(Collectors.joining(", "));
        return "applied " + edits.size() + " edit(s) across " + batch.size() + " file(s): " + summary;
    }

    // --- bash/shell/command/powershell tools ---
    private static String handleBash(String cwd, String command, Long timeoutMs) throws Exception {
        if (!shellSemaphore.tryAcquire(30, TimeUnit.SECONDS)) {
            throw new ShellFailure("Too many concurrent shell executions, please try again later");
        }
        try {
            return runCommand(bashCmd(command), command, cwd, timeoutMs != null ? timeoutMs : 0, true);
        } finally {
            shellSemaphore.release();
        }
    }

    private static String handleShell(String cwd, String command, Long timeoutMs) throws Exception {
        if (!shellSemaphore.tryAcquire(30, TimeUnit.SECONDS)) {
            throw new ShellFailure("Too many concurrent shell executions, please try again later");
        }
        try {
            return runCommand(shCmd(command), command, cwd, timeoutMs != null ? timeoutMs : 0, true);
        } finally {
            shellSemaphore.release();
        }
    }

    private static String handleCommand(String cwd, String command, Long timeoutMs) throws Exception {
        if (!shellSemaphore.tryAcquire(30, TimeUnit.SECONDS)) {
            throw new ShellFailure("Too many concurrent shell executions, please try again later");
        }
        try {
            return runCommand(cmdCmd(command), command, cwd, timeoutMs != null ? timeoutMs : 0, true);
        } finally {
            shellSemaphore.release();
        }
    }

    private static String handlePowershell(String cwd, String command, Long timeoutMs) throws Exception {
        if (!shellSemaphore.tryAcquire(30, TimeUnit.SECONDS)) {
            throw new ShellFailure("Too many concurrent shell executions, please try again later");
        }
        try {
            return runCommand(pwshCmd(command), command, cwd, timeoutMs != null ? timeoutMs : 0, true);
        } finally {
            shellSemaphore.release();
        }
    }

    // --- grep tool ---
    private static final String GREP_FALLBACK_SCRIPT_BASE64 = "JEVycm9yQWN0aW9uUHJlZmVyZW5jZSA9ICdTdG9wJwpbQ29uc29sZV06OklucHV0RW5jb2RpbmcgPSBbVGV4dC5VVEY4RW5jb2RpbmddOjpuZXcoJGZhbHNlKQpbQ29uc29sZV06Ok91dHB1dEVuY29kaW5nID0gW1RleHQuVVRGOEVuY29kaW5nXTo6bmV3KCRmYWxzZSkKJE91dHB1dEVuY29kaW5nID0gW0NvbnNvbGVdOjpPdXRwdXRFbmNvZGluZwp0cnkgewogICAgJHJlcXVlc3QgPSBbQ29uc29sZV06OkluLlJlYWRUb0VuZCgpIHwgQ29udmVydEZyb20tSnNvbgogICAgJG1hdGNoZXIgPSBbcmVnZXhdOjpuZXcoW3N0cmluZ10kcmVxdWVzdC5wYXR0ZXJuLCBbVGV4dC5SZWd1bGFyRXhwcmVzc2lvbnMuUmVnZXhPcHRpb25zXTo6Q3VsdHVyZUludmFyaWFudCwgW1RpbWVTcGFuXTo6RnJvbU1pbGxpc2Vjb25kcygyNTApKQogICAgJHJvb3QgPSBbSU8uUGF0aF06OkdldEZ1bGxQYXRoKFtzdHJpbmddJHJlcXVlc3QucGF0aCkKICAgICRnbG9iID0gW3N0cmluZ10kcmVxdWVzdC5nbG9iCiAgICAkZmlsdGVyID0gJG51bGwKICAgIGlmICgkZ2xvYikgewogICAgICAgICRnID0gJGdsb2IuUmVwbGFjZSgnXCcsJy8nKQogICAgICAgICRuZWdhdGUgPSAkZy5TdGFydHNXaXRoKCchJykKICAgICAgICBpZiAoJG5lZ2F0ZSkgeyAkZyA9ICRnLlN1YnN0cmluZygxKSB9CiAgICAgICAgaWYgKC1ub3QgJGcpIHsgdGhyb3cgJ0dsb2IgbXVzdCBub3QgYmUgZW1wdHkgYWZ0ZXIgbmVnYXRpb24nIH0KICAgICAgICAkZGVwdGg9MAogICAgICAgICRwcmVmaXggPSBpZiAoJGcuQ29udGFpbnMoJy8nKSkgeyAnXicgfSBlbHNlIHsgJyhefC8pJyB9CiAgICAgICAgJHJ4ID0gW1RleHQuU3RyaW5nQnVpbGRlcl06Om5ldygkcHJlZml4KQogICAgICAgIGZvciAoJGk9MDsgJGkgLWx0ICRnLkxlbmd0aDsgJGkrKykgewogICAgICAgICAgICAkYz0kZ1skaV0KICAgICAgICAgICAgaWYgKCRjIC1lcSAnKicpIHsKICAgICAgICAgICAgICAgIGlmICgkaSsxIC1sdCAkZy5MZW5ndGggLWFuZCAkZ1skaSsxXSAtZXEgJyonKSB7CiAgICAgICAgICAgICAgICAgICAgJGkrKwogICAgICAgICAgICAgICAgICAgIGlmICgkaSsxIC1sdCAkZy5MZW5ndGggLWFuZCAkZ1skaSsxXSAtZXEgJy8nKSB7ICRpKys7IFt2b2lkXSRyeC5BcHBlbmQoJyg/Oi4qLyk/JykgfQogICAgICAgICAgICAgICAgICAgIGVsc2UgeyBbdm9pZF0kcnguQXBwZW5kKCcuKicpIH0KICAgICAgICAgICAgICAgIH0gZWxzZSB7IFt2b2lkXSRyeC5BcHBlbmQoJ1teL10qJykgfQogICAgICAgICAgICB9IGVsc2VpZiAoJGMgLWVxICc/JykgeyBbdm9pZF0kcnguQXBwZW5kKCdbXi9dJykgfQogICAgICAgICAgICBlbHNlaWYgKCRjIC1lcSAnWycpIHsKICAgICAgICAgICAgICAgICRlbmQ9JGcuSW5kZXhPZignXScsJGkrMSkKICAgICAgICAgICAgICAgIGlmICgkZW5kIC1sdCAwKSB7IHRocm93ICdVbmNsb3NlZCBnbG9iIGNoYXJhY3RlciBjbGFzcycgfQogICAgICAgICAgICAgICAgJGJvZHk9JGcuU3Vic3RyaW5nKCRpKzEsJGVuZC0kaS0xKQogICAgICAgICAgICAgICAgaWYgKC1ub3QgJGJvZHkgLW9yICRib2R5LkNvbnRhaW5zKCdbJykgLW9yICRib2R5LkNvbnRhaW5zKCcvJykpIHsgdGhyb3cgJ0ludmFsaWQgZ2xvYiBjaGFyYWN0ZXIgY2xhc3MnIH0KICAgICAgICAgICAgICAgIGlmICgkYm9keS5TdGFydHNXaXRoKCchJykgLW9yICRib2R5LlN0YXJ0c1dpdGgoJ14nKSkgeyAkYm9keT0nXi8nKyRib2R5LlN1YnN0cmluZygxKSB9CiAgICAgICAgICAgICAgICBbdm9pZF0kcnguQXBwZW5kKCcoPyEvKVsnKyRib2R5KyddJyk7ICRpPSRlbmQKICAgICAgICAgICAgfSBlbHNlaWYgKCRjIC1lcSAneycpIHsgJGRlcHRoKys7IGlmKCRkZXB0aCAtZ3QgMTYpe3Rocm93ICdHbG9iIG5lc3RpbmcgbGltaXQgZXhjZWVkZWQnfTsgW3ZvaWRdJHJ4LkFwcGVuZCgnKD86JykgfQogICAgICAgICAgICBlbHNlaWYgKCRjIC1lcSAnfScpIHsgaWYoJGRlcHRoIC1lcSAwKXt0aHJvdyAnVW5tYXRjaGVkIGdsb2IgYnJhY2UnfTsgJGRlcHRoLS07IFt2b2lkXSRyeC5BcHBlbmQoJyknKSB9CiAgICAgICAgICAgIGVsc2VpZiAoJGMgLWVxICcsJyAtYW5kICRkZXB0aCAtZ3QgMCkgeyBbdm9pZF0kcnguQXBwZW5kKCd8JykgfQogICAgICAgICAgICBlbHNlIHsgW3ZvaWRdJHJ4LkFwcGVuZChbcmVnZXhdOjpFc2NhcGUoW3N0cmluZ10kYykpIH0KICAgICAgICB9CiAgICAgICAgaWYoJGRlcHRoIC1uZSAwKXt0aHJvdyAnVW5jbG9zZWQgZ2xvYiBicmFjZSd9CiAgICAgICAgW3ZvaWRdJHJ4LkFwcGVuZCgnKD86Ly4qKT8kJykKICAgICAgICAkZmlsdGVyPVtyZWdleF06Om5ldygkcnguVG9TdHJpbmcoKSxbVGV4dC5SZWd1bGFyRXhwcmVzc2lvbnMuUmVnZXhPcHRpb25zXTo6Q3VsdHVyZUludmFyaWFudCxbVGltZVNwYW5dOjpGcm9tTWlsbGlzZWNvbmRzKDI1MCkpCiAgICB9CiAgICAkYmFzZSA9IGlmIChbSU8uRGlyZWN0b3J5XTo6RXhpc3RzKCRyb290KSkgeyAkcm9vdC5UcmltRW5kKCdcJywnLycpKydcJyB9IGVsc2UgeyBbSU8uUGF0aF06OkdldERpcmVjdG9yeU5hbWUoJHJvb3QpLlRyaW1FbmQoJ1wnLCcvJykrJ1wnIH0KICAgICRzdGFjaz1bQ29sbGVjdGlvbnMuR2VuZXJpYy5TdGFja1tzdHJpbmddXTo6bmV3KCk7JHN0YWNrLlB1c2goJHJvb3QpCiAgICAkbWF0Y2hlZD0kZmFsc2U7JHZpc2l0ZWQ9MAogICAgd2hpbGUgKCRzdGFjay5Db3VudCAtZ3QgMCkgewogICAgICAgICR2aXNpdGVkKys7aWYoJHZpc2l0ZWQgLWd0IDEwMDAwMCl7dGhyb3cgJ1NlYXJjaCBlbnRyeSBsaW1pdCBleGNlZWRlZCd9CiAgICAgICAgJHBhdGg9JHN0YWNrLlBvcCgpOyRhdHRycz1bSU8uRmlsZV06OkdldEF0dHJpYnV0ZXMoJHBhdGgpCiAgICAgICAgaWYgKCgkYXR0cnMgLWJhbmQgW0lPLkZpbGVBdHRyaWJ1dGVzXTo6UmVwYXJzZVBvaW50KSAtbmUgMCkgeyBjb250aW51ZSB9CiAgICAgICAgaWYgKCgkYXR0cnMgLWJhbmQgW0lPLkZpbGVBdHRyaWJ1dGVzXTo6RGlyZWN0b3J5KSAtbmUgMCkgewogICAgICAgICAgICBmb3JlYWNoICgkZW50cnkgaW4gW0lPLkRpcmVjdG9yeV06OkVudW1lcmF0ZUZpbGVTeXN0ZW1FbnRyaWVzKCRwYXRoKSkgewogICAgICAgICAgICAgICAgJG5hbWU9W0lPLlBhdGhdOjpHZXRGaWxlTmFtZSgkZW50cnkpCiAgICAgICAgICAgICAgICBpZiAoJG5hbWUuU3RhcnRzV2l0aCgnLicpIC1hbmQgLW5vdCAoJGZpbHRlciAtYW5kIC1ub3QgJG5lZ2F0ZSkpIHsgY29udGludWUgfQogICAgICAgICAgICAgICAgaWYgKChbSU8uRmlsZV06OkdldEF0dHJpYnV0ZXMoJGVudHJ5KSAtYmFuZCBbSU8uRmlsZUF0dHJpYnV0ZXNdOjpIaWRkZW4pIC1uZSAwIC1hbmQgLW5vdCAoJGZpbHRlciAtYW5kIC1ub3QgJG5lZ2F0ZSkpIHsgY29udGludWUgfQogICAgICAgICAgICAgICAgaWYoJHN0YWNrLkNvdW50IC1nZSAxMDAwMDApe3Rocm93ICdTZWFyY2ggcGVuZGluZyBlbnRyeSBsaW1pdCBleGNlZWRlZCd9CiAgICAgICAgICAgICAgICAkc3RhY2suUHVzaCgkZW50cnkpCiAgICAgICAgICAgIH0KICAgICAgICAgICAgY29udGludWUKICAgICAgICB9CiAgICAgICAgJHJlbGF0aXZlPSRwYXRoLlN1YnN0cmluZygkYmFzZS5MZW5ndGgpLlJlcGxhY2UoJ1wnLCcvJykKICAgICAgICBpZiAoJGZpbHRlcikgeyAkaW5jbHVkZWQ9JGZpbHRlci5Jc01hdGNoKCRyZWxhdGl2ZSk7IGlmICgkbmVnYXRlKSB7ICRpbmNsdWRlZD0tbm90ICRpbmNsdWRlZCB9OyBpZiAoLW5vdCAkaW5jbHVkZWQpIHsgY29udGludWUgfSB9CiAgICAgICAgJHN0cmVhbT1bSU8uRmlsZV06Ok9wZW4oJHBhdGgsW0lPLkZpbGVNb2RlXTo6T3BlbixbSU8uRmlsZUFjY2Vzc106OlJlYWQsW0lPLkZpbGVTaGFyZV06OlJlYWRXcml0ZSkKICAgICAgICB0cnkgewogICAgICAgICAgICAkaW5pdGlhbExlbmd0aD0kc3RyZWFtLkxlbmd0aAogICAgICAgICAgICBpZiAoJGluaXRpYWxMZW5ndGggLWd0IDEwNDg1NzYwMCkgeyB0aHJvdyAnU2VhcmNoIGZpbGUgZXhjZWVkcyAxMDAgTWlCIGxpbWl0JyB9CiAgICAgICAgICAgICRwcm9iZT1bYnl0ZVtdXTo6bmV3KDgxOTIpOyRjb3VudD0kc3RyZWFtLlJlYWQoJHByb2JlLDAsJHByb2JlLkxlbmd0aCkKICAgICAgICAgICAgJGJpbmFyeT0kZmFsc2U7Zm9yKCRpPTA7JGkgLWx0ICRjb3VudDskaSsrKXtpZigkcHJvYmVbJGldIC1lcSAwKXskYmluYXJ5PSR0cnVlO2JyZWFrfX0KICAgICAgICAgICAgaWYoJGJpbmFyeSl7Y29udGludWV9OyRzdHJlYW0uUG9zaXRpb249aWYoJGNvdW50IC1nZSAzIC1hbmQgJHByb2JlWzBdIC1lcSAyMzkgLWFuZCAkcHJvYmVbMV0gLWVxIDE4NyAtYW5kICRwcm9iZVsyXSAtZXEgMTkxKXszfWVsc2V7MH0KICAgICAgICAgICAgJHJlYWRlcj1bSU8uU3RyZWFtUmVhZGVyXTo6bmV3KCRzdHJlYW0sW1RleHQuVVRGOEVuY29kaW5nXTo6bmV3KCRmYWxzZSwkdHJ1ZSksJGZhbHNlLDY1NTM2LCR0cnVlKQogICAgICAgICAgICB0cnkgewogICAgICAgICAgICAgICAgJGxpbmVObz0wOyRsaW5lPVtUZXh0LlN0cmluZ0J1aWxkZXJdOjpuZXcoKTskY2hhcnM9W2NoYXJbXV06Om5ldyg2NTUzNikKICAgICAgICAgICAgICAgIHdoaWxlKCgkcmVhZD0kcmVhZGVyLlJlYWQoJGNoYXJzLDAsJGNoYXJzLkxlbmd0aCkpIC1ndCAwKSB7CiAgICAgICAgICAgICAgICAgICAgaWYoJHN0cmVhbS5Qb3NpdGlvbiAtZ3QgJGluaXRpYWxMZW5ndGggLW9yICRzdHJlYW0uUG9zaXRpb24gLWd0IDEwNDg1NzYwMCl7dGhyb3cgJ1NlYXJjaCBmaWxlIGdyZXcgYmV5b25kIGl0cyBpbml0aWFsIHNpemUnfQogICAgICAgICAgICAgICAgICAgICRjaHVuaz1bc3RyaW5nXTo6bmV3KCRjaGFycywwLCRyZWFkKTskb2Zmc2V0PTAKICAgICAgICAgICAgICAgICAgICB3aGlsZSgkb2Zmc2V0IC1sdCAkY2h1bmsuTGVuZ3RoKSB7CiAgICAgICAgICAgICAgICAgICAgICAgICRlbmQ9JGNodW5rLkluZGV4T2YoImBuIiwkb2Zmc2V0KQogICAgICAgICAgICAgICAgICAgICAgICAkbGVuZ3RoPWlmKCRlbmQgLWx0IDApeyRjaHVuay5MZW5ndGgtJG9mZnNldH1lbHNleyRlbmQtJG9mZnNldH0KICAgICAgICAgICAgICAgICAgICAgICAgaWYoJGxpbmUuTGVuZ3RoKyRsZW5ndGggLWd0IDEwNDg1NzYpe3Rocm93ICdTZWFyY2ggbGluZSBleGNlZWRzIDEwNDg1NzYgY2hhcmFjdGVyIGxpbWl0J30KICAgICAgICAgICAgICAgICAgICAgICAgW3ZvaWRdJGxpbmUuQXBwZW5kKCRjaHVuaywkb2Zmc2V0LCRsZW5ndGgpCiAgICAgICAgICAgICAgICAgICAgICAgIGlmKCRlbmQgLWx0IDApe2JyZWFrfQogICAgICAgICAgICAgICAgICAgICAgICAkbGluZU5vKys7JHRleHQ9JGxpbmUuVG9TdHJpbmcoKTtpZigkdGV4dC5FbmRzV2l0aCgiYHIiKSl7JHRleHQ9JHRleHQuU3Vic3RyaW5nKDAsJHRleHQuTGVuZ3RoLTEpfQogICAgICAgICAgICAgICAgICAgICAgICBpZigkbWF0Y2hlci5Jc01hdGNoKCR0ZXh0KSl7W0NvbnNvbGVdOjpPdXQuV3JpdGVMaW5lKCRwYXRoKyc6JyskbGluZU5vKyc6JyskdGV4dCk7JG1hdGNoZWQ9JHRydWV9CiAgICAgICAgICAgICAgICAgICAgICAgIFt2b2lkXSRsaW5lLkNsZWFyKCk7JG9mZnNldD0kZW5kKzEKICAgICAgICAgICAgICAgICAgICB9CiAgICAgICAgICAgICAgICB9CiAgICAgICAgICAgICAgICBpZigkc3RyZWFtLkxlbmd0aCAtbmUgJGluaXRpYWxMZW5ndGgpe3Rocm93ICdTZWFyY2ggZmlsZSBzaXplIGNoYW5nZWQgZHVyaW5nIHNlYXJjaCd9CiAgICAgICAgICAgICAgICBpZigkbGluZS5MZW5ndGggLWd0IDApeyRsaW5lTm8rKzskdGV4dD0kbGluZS5Ub1N0cmluZygpO2lmKCRtYXRjaGVyLklzTWF0Y2goJHRleHQpKXtbQ29uc29sZV06Ok91dC5Xcml0ZUxpbmUoJHBhdGgrJzonKyRsaW5lTm8rJzonKyR0ZXh0KTskbWF0Y2hlZD0kdHJ1ZX19CiAgICAgICAgICAgIH0gZmluYWxseSB7JHJlYWRlci5EaXNwb3NlKCl9CiAgICAgICAgfSBmaW5hbGx5IHskc3RyZWFtLkRpc3Bvc2UoKX0KICAgIH0KICAgIGlmKCRtYXRjaGVkKXtleGl0IDB9ZWxzZXtleGl0IDF9Cn0gY2F0Y2ggewogICAgW0NvbnNvbGVdOjpFcnJvci5Xcml0ZUxpbmUoJF8uRXhjZXB0aW9uLk1lc3NhZ2UpCiAgICBleGl0IDIKfQo=";

    private static Path grepExecutable(String name) {
        String pathValue = System.getenv("PATH");
        if (isWindows) {
            for (var entry : System.getenv().entrySet())
                if (entry.getKey().equalsIgnoreCase("PATH")) { pathValue = entry.getValue(); break; }
        }
        if (pathValue == null) return null;
        for (String part : pathValue.split(Pattern.quote(File.pathSeparator), -1)) {
            if (part.length() >= 2 && part.startsWith("\"") && part.endsWith("\"")) part = part.substring(1, part.length() - 1);
            try {
                Path executable = Path.of(part, name).toAbsolutePath();
                if (Files.isRegularFile(executable) && Files.isExecutable(executable)) return executable.toRealPath();
            } catch (IOException | InvalidPathException ignored) {}
        }
        return null;
    }

    private static ShellCapture startGrepCapture(InputStream input, String label) {
        ShellCapture capture = new ShellCapture(input, new StringBuilder());
        capture.thread = new Thread(() -> pumpShellCapture(capture), "grep-" + label + "-" + UUID.randomUUID());
        capture.thread.setDaemon(true);
        capture.thread.start();
        return capture;
    }

    private static ShellCapture startGrepInput(Process process, byte[] payload) {
        ShellCapture writer = new ShellCapture(InputStream.nullInputStream(), new StringBuilder());
        writer.thread = new Thread(() -> {
            try (OutputStream output = process.getOutputStream()) {
                // Full buffer-sized writes bypass BufferedOutputStream buffering.
                // Whitespace padding is valid JSON and keeps close() from retrying
                // a cancelled buffered flush on an inherited, unconsumed pipe.
                byte[] chunk = new byte[8192];
                for (int offset = 0; offset < payload.length && !writer.cancelled; offset += chunk.length) {
                    Arrays.fill(chunk, (byte) ' ');
                    System.arraycopy(payload, offset, chunk, 0, Math.min(chunk.length, payload.length - offset));
                    output.write(chunk);
                }
            } catch (IOException e) {
                writer.failed = true;
                synchronized (writer.buffer) { writer.buffer.append("stdin write failed: ").append(e.getMessage()); }
            } finally { writer.done = true; }
        }, "grep-stdin-" + UUID.randomUUID());
        writer.thread.setDaemon(true);
        writer.thread.start();
        return writer;
    }

    private static void cleanupGrepProcess(Process process, List<ShellCapture> captures) {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
        List<Thread> cleaners = new ArrayList<>();
        for (ShellCapture capture : captures) {
            if (capture.done) continue;
            Thread cleaner = new Thread(capture::cancel, "grep-cleanup-" + UUID.randomUUID());
            cleaner.setDaemon(true);
            cleaners.add(cleaner);
            cleaner.start();
        }
        // Do not use a dead parent's PID. Native cancellation addresses our
        // own capture threads, so inherited writers can continue independently.
        if (process.isAlive()) terminateShellProcess(process);
        for (Thread cleaner : cleaners) {
            long remaining = shellRemaining(deadline);
            if (remaining == 0) break;
            try { TimeUnit.NANOSECONDS.timedJoin(cleaner, remaining); }
            catch (InterruptedException e) { Thread.currentThread().interrupt(); break; }
        }
    }

    private static String runGrepBackend(String[] command, String cwd, byte[] input) throws Exception {
        if (!shellSemaphore.tryAcquire(30, TimeUnit.SECONDS)) throw new GrepFailure("too many concurrent shell/search executions");
        Process process = null;
        List<ShellCapture> captures = new ArrayList<>();
        try {
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
            ProcessBuilder builder = new ProcessBuilder(command).directory(new File(cwd));
            builder.redirectErrorStream(false);
            scrubEnv(builder);
            try { process = builder.start(); }
            catch (IOException e) { throw new GrepFailure("cannot start grep backend: " + e.getMessage()); }
            ShellCapture stdout = startGrepCapture(process.getInputStream(), "stdout");
            captures.add(stdout);
            ShellCapture stderr = startGrepCapture(process.getErrorStream(), "stderr");
            captures.add(stderr);
            ShellCapture writer = null;
            if (input == null) process.getOutputStream().close();
            else { writer = startGrepInput(process, input); captures.add(writer); }
            long remaining = shellRemaining(deadline);
            if (remaining > 0) process.waitFor(remaining, TimeUnit.NANOSECONDS);
            if (process.isAlive()) throw new GrepFailure("grep backend timed out after 30000 ms");
            for (ShellCapture capture : captures) waitShellCapture(capture, deadline);
            if (captures.stream().anyMatch(c -> !c.done)) throw new GrepFailure("grep capture/input timed out after 30000 ms; output incomplete");
            if (captures.stream().anyMatch(c -> c.failed || c.cancelled))
                throw new GrepFailure("grep input/output capture failed; output incomplete: "
                    + stderr.snapshot() + (writer == null ? "" : writer.snapshot()));
            int code = process.exitValue();
            if (code != 0 && code != 1) throw new GrepFailure("grep backend failed (exit=" + code + "): " + stderr.snapshot());
            return code == 1 ? "(no matches)" : maybeSpillText(stdout.snapshot(), "grep");
        } finally {
            try { if (process != null) cleanupGrepProcess(process, captures); }
            finally { shellSemaphore.release(); }
        }
    }

    private static class GrepFailure extends IOException {
        GrepFailure(String message) { super(message); }
    }

    private static String grepString(Map<?, ?> args, String key, boolean allowEmpty) throws GrepFailure {
        if (!(args.get(key) instanceof String value) || (!allowEmpty && value.isEmpty()))
            throw new GrepFailure(key + " must be " + (allowEmpty ? "a string" : "a nonempty string"));
        if (value.indexOf('\0') >= 0) throw new GrepFailure(key + " must not contain NUL");
        try { StandardCharsets.UTF_8.newEncoder().encode(java.nio.CharBuffer.wrap(value)); }
        catch (java.nio.charset.CharacterCodingException e) { throw new GrepFailure(key + " must be valid Unicode"); }
        return value;
    }

    private static String handleGrep(String cwd, String pattern, String path, String glob) throws Exception {
        if (glob != null && glob.isEmpty()) glob = null;
        if (glob != null) {
            String g = glob.replace("\\", "/");
            if (g.startsWith("/") || g.startsWith("~") || g.matches("^[A-Za-z]:.*"))
                throw new GrepFailure("glob must be relative");
            for (String segment : g.split("/"))
                if (segment.equals("..")) throw new GrepFailure("glob may not contain '..'");
        }
        Path cwdPath = Path.of(cwd).toAbsolutePath(), base = cwdPath.toRealPath();
        if (!Files.isDirectory(base)) throw new GrepFailure("cwd must be an existing directory");
        Path supplied = Path.of(path);
        Path requested = supplied.isAbsolute() ? supplied : cwdPath.resolve(supplied);
        Path resolved = resolveWritePath(requested.getRoot(), requested);
        if (!resolved.startsWith(base) && !(spillRoot != null && resolved.startsWith(Path.of(spillRoot).toRealPath())))
            throw new GrepFailure("path escapes cwd");
        if (!Files.isRegularFile(resolved, LinkOption.NOFOLLOW_LINKS) && !Files.isDirectory(resolved, LinkOption.NOFOLLOW_LINKS))
            throw new GrepFailure("path must be an existing regular file or directory");
        // NIO removes terminal separators when parsing Path. Keep the caller's
        // directory syntax meaningful instead of silently accepting a file.
        if ((path.endsWith("/") || (isWindows && path.endsWith("\\")))
            && !Files.isDirectory(resolved, LinkOption.NOFOLLOW_LINKS))
            throw new GrepFailure("path ending in a separator must name a directory");
        String searchPath = resolved.toString();
        String normalizedGlob = glob == null ? null : glob.replace('\\', '/');
        Path rg = grepExecutable(isWindows ? "rg.exe" : "rg");
        if (rg != null) {
            String[] command = new String[]{rg.toString(), "--no-config", "--line-number", "--with-filename", "--no-heading", "--color=never"};
            if (normalizedGlob != null) command = append(command, "--glob", normalizedGlob);
            return runGrepBackend(append(command, "--", pattern, searchPath), cwd, null);
        }
        if (isWindows) {
            String systemRoot = System.getenv().getOrDefault("SystemRoot", "C:\\Windows");
            Path powershell = Path.of(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
            if (!Files.isRegularFile(powershell)) throw new GrepFailure("Windows PowerShell grep fallback is unavailable");
            String script = new String(Base64.getDecoder().decode(GREP_FALLBACK_SCRIPT_BASE64), StandardCharsets.UTF_8);
            String[] command = new String[]{powershell.toString(), "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
                Base64.getEncoder().encodeToString(script.getBytes(StandardCharsets.UTF_16LE))};
            byte[] input = toJson(Map.of("path", searchPath, "pattern", pattern, "glob", normalizedGlob == null ? "" : normalizedGlob))
                .getBytes(StandardCharsets.UTF_8);
            return runGrepBackend(command, cwd, input);
        }
        Path grep = grepExecutable("grep");
        if (grep == null) throw new GrepFailure("neither ripgrep nor grep is available on PATH");
        String[] command = new String[]{grep.toString(), "-rEnH"};
        if (normalizedGlob != null) command = append(command, "--include", normalizedGlob);
        return runGrepBackend(append(command, "--", pattern, searchPath), cwd, null);
    }

    private static String joinArgs(String[] args) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < args.length; i++) {
            if (i > 0) b.append(' ');
            b.append(args[i]);
        }
        return b.toString();
    }

    private static String[] append(String[] arr, String... elements) {
        String[] result = new String[arr.length + elements.length];
        System.arraycopy(arr, 0, result, 0, arr.length);
        System.arraycopy(elements, 0, result, arr.length, elements.length);
        return result;
    }

    // --- find tool ---
    private static final Set<String> FIND_NOISE = Set.of("node_modules", ".git", ".next", ".nuxt", ".turbo", ".cache", "dist", "build", "out", "target", "coverage", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".idea", ".vscode");
    private record FindToken(char kind, int literal, boolean negate, List<int[]> ranges) {
        FindToken(char kind) { this(kind, 0, false, List.of()); }
    }
    private record FindPattern(String glob, List<FindToken> tokens) {}
    private record FindExpansion(String value, int depth) {}
    private record FindDirectory(Path path, String prefix, int depth) {}

    private static List<FindPattern> findPatterns(String pattern) throws IOException {
        pattern = pattern.replace('\\', '/');
        if (pattern.startsWith("/") || pattern.startsWith("~") || pattern.matches("(?s)^[A-Za-z]:.*")) throw new IOException("pattern must be relative to the working directory");
        if (Arrays.asList(pattern.split("/", -1)).contains("..")) throw new IOException("pattern may not contain '..'");
        while (pattern.startsWith("./")) pattern = pattern.substring(2);
        if (pattern.isEmpty() || pattern.codePointCount(0, pattern.length()) > 4096) throw new IOException("pattern must contain 1 to 4096 characters");
        ArrayDeque<FindExpansion> pending = new ArrayDeque<>();
        pending.push(new FindExpansion(pattern, 0));
        List<String> expanded = new ArrayList<>();
        while (!pending.isEmpty()) {
            FindExpansion expansion = pending.pop(); String value = expansion.value();
            int start = -1, balance = 0, cut = 0, end = -1, classFirst = -1; boolean inClass = false;
            List<String> pieces = new ArrayList<>();
            for (int i = 0; i < value.length(); i++) {
                char ch = value.charAt(i);
                if (ch == '[' && !inClass) {
                    inClass = true; classFirst = i + 1;
                    if (classFirst < value.length() && (value.charAt(classFirst) == '!' || value.charAt(classFirst) == '^')) classFirst++;
                } else if (ch == ']' && inClass && i > classFirst) inClass = false;
                else if (!inClass) {
                    if (ch == '{') { if (balance == 0) { start = i; cut = i + 1; } balance++; }
                    else if (ch == '}') {
                        if (balance == 0) throw new IOException("unmatched glob brace");
                        if (--balance == 0) { pieces.add(value.substring(cut, i)); end = i; break; }
                    } else if (ch == ',' && balance == 1) { pieces.add(value.substring(cut, i)); cut = i + 1; }
                }
            }
            if (balance != 0) throw new IOException("unmatched glob brace");
            if (end >= 0) {
                if (expansion.depth() >= 16 || pieces.size() < 2) throw new IOException("glob braces require alternatives and at most 16 expansions in depth");
                for (String piece : pieces) pending.push(new FindExpansion(value.substring(0, start) + piece + value.substring(end + 1), expansion.depth() + 1));
                if (pending.size() + expanded.size() > 256) throw new IOException("glob exceeds 256 alternatives");
            } else expanded.add(value);
        }
        int total = 0; List<FindPattern> compiled = new ArrayList<>();
        for (String value : expanded) {
            if (value.startsWith("/") || value.startsWith("~") || value.matches("(?s)^[A-Za-z]:.*") || Arrays.asList(value.split("/", -1)).contains(".."))
                throw new IOException("glob alternatives must be relative and may not contain '..'");
            String glob = value.contains("/") ? value : "**/" + value;
            int[] chars = glob.codePoints().toArray(); List<FindToken> tokens = new ArrayList<>();
            for (int i = 0; i < chars.length; i++) {
                int ch = chars[i];
                if (ch == '*') {
                    int j = i; while (j < chars.length && chars[j] == '*') j++;
                    boolean whole = (i == 0 || chars[i - 1] == '/') && (j == chars.length || chars[j] == '/');
                    if (j - i >= 2 && whole) { tokens.add(new FindToken(j < chars.length ? 'G' : 'D')); if (j < chars.length) j++; }
                    else tokens.add(new FindToken('S'));
                    i = j - 1;
                } else if (ch == '?') tokens.add(new FindToken('Q'));
                else if (ch == '[') {
                    int j = i + 1; boolean negate = j < chars.length && (chars[j] == '!' || chars[j] == '^'); if (negate) j++;
                    List<int[]> ranges = new ArrayList<>();
                    while (j < chars.length && (chars[j] != ']' || ranges.isEmpty())) {
                        int lo = chars[j], hi = lo;
                        if (lo == '/') throw new IOException("glob classes cannot contain separators");
                        if (j + 2 < chars.length && chars[j + 1] == '-' && chars[j + 2] != ']') {
                            hi = chars[j + 2]; if (hi < lo || hi == '/') throw new IOException("invalid glob class range"); j += 3;
                        } else j++;
                        ranges.add(new int[] {lo, hi});
                    }
                    if (j == chars.length || ranges.isEmpty()) throw new IOException("unclosed or empty glob class");
                    tokens.add(new FindToken('C', 0, negate, ranges)); i = j;
                } else if (ch == '{' || ch == '}' || ch == ']') throw new IOException("unmatched glob delimiter");
                else tokens.add(new FindToken('L', ch, false, List.of()));
            }
            total += tokens.size(); if (total > 16384) throw new IOException("glob exceeds token budget");
            compiled.add(new FindPattern(glob, tokens));
        }
        return compiled;
    }

    private static boolean findMatches(List<FindToken> tokens, String value, long[] budget) throws IOException {
        return findMatches(tokens, value, budget, false);
    }
    private static boolean findMatches(List<FindToken> tokens, String value, long[] budget, boolean prefix) throws IOException {
        int[] chars = value.codePoints().toArray(); int length = chars.length;
        long weight = 0;
        for (FindToken token : tokens) weight += token.kind() == 'C' ? Math.max(1, token.ranges().size()) : 1;
        budget[0] -= weight * (length + 1);
        if (budget[0] < 0) throw new IOException("find exceeds glob matching work limit");
        boolean[] previous = new boolean[length + 1]; previous[0] = true;
        for (FindToken token : tokens) {
            boolean[] current = new boolean[length + 1]; char kind = token.kind();
            if (kind == 'S' || kind == 'D' || kind == 'G') {
                current[0] = previous[0]; boolean seen = previous[0];
                for (int j = 1; j <= length; j++) {
                    int ch = chars[j - 1];
                    if (kind == 'G') { current[j] = previous[j] || (seen && ch == '/'); seen |= previous[j]; }
                    else current[j] = previous[j] || (current[j - 1] && (kind == 'D' || ch != '/'));
                }
            } else {
                for (int j = 1; j <= length; j++) {
                    if (!previous[j - 1]) continue;
                    int ch = chars[j - 1]; boolean match;
                    if (kind == 'L') match = ch == token.literal();
                    else if (kind == 'Q') match = ch != '/';
                    else {
                        boolean inside = false;
                        for (int[] range : token.ranges()) if (range[0] <= ch && ch <= range[1]) { inside = true; break; }
                        match = ch != '/' && (inside != token.negate());
                    }
                    current[j] = previous[j - 1] && match;
                }
            }
            if (prefix && current[length]) return true;
            previous = current;
        }
        return previous[length];
    }

    private static String handleFind(String cwd, String pattern, String path, boolean includeHidden) throws IOException {
        Path root = Path.of(cwd).toRealPath(), supplied = Path.of(path);
        Path requested = supplied.isAbsolute() ? supplied : root.resolve(supplied);
        Path base = resolveWritePath(requested.getRoot(), requested);
        if (!base.startsWith(root) && !(spillRoot != null && base.startsWith(Path.of(spillRoot).toRealPath()))) throw new IOException("path escapes cwd");
        if (!Files.isDirectory(base)) throw new IOException("path must be an existing directory");
        List<FindPattern> patterns = findPatterns(pattern);
        Set<String> explicit = new HashSet<>(); List<List<FindToken>> hidden = new ArrayList<>();
        for (FindPattern item : patterns) for (String part : item.glob().split("/")) {
            if (part.indexOf('*') < 0 && part.indexOf('?') < 0 && part.indexOf('[') < 0) explicit.add(part);
            if (part.startsWith(".")) { List<FindToken> all = findPatterns(part).get(0).tokens(); hidden.add(all.subList(1, all.size())); }
        }
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30); long[] budget = {10_000_000};
        ArrayDeque<FindDirectory> pending = new ArrayDeque<>(); pending.push(new FindDirectory(base, "", 0));
        List<String> results = new ArrayList<>(); int visited = 0, bytes = 0;
        while (!pending.isEmpty()) {
            FindDirectory directory = pending.pop();
            if (System.nanoTime() >= deadline) throw new IOException("find timed out after 30000 ms");
            if (!directory.path().toRealPath().equals(directory.path())) continue;
            try (DirectoryStream<Path> entries = Files.newDirectoryStream(directory.path())) {
                for (Path entry : entries) {
                    if (++visited > 100000) throw new IOException("find exceeds 100000 filesystem entries");
                    if (System.nanoTime() >= deadline) throw new IOException("find timed out after 30000 ms");
                    String name = entry.getFileName().toString();
                    if (name.startsWith(".") && !includeHidden) {
                        boolean allow = false; for (List<FindToken> tokens : hidden) if (findMatches(tokens, name, budget)) { allow = true; break; }
                        if (!allow) continue;
                    }
                    var info = Files.readAttributes(entry, java.nio.file.attribute.BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
                    if (info.isSymbolicLink() || info.isOther()) continue;
                    String relative = directory.prefix() + name;
                    if (info.isDirectory()) {
                        if (FIND_NOISE.contains(name) && !explicit.contains(name)) continue;
                        boolean descend = false;
                        for (FindPattern item : patterns) if (findMatches(item.tokens(), relative + "/", budget, true)) { descend = true; break; }
                        if (!descend) continue;
                        if (directory.depth() >= 256) throw new IOException("find exceeds 256 directory levels");
                        pending.push(new FindDirectory(entry, relative + "/", directory.depth() + 1));
                    } else if (info.isRegularFile()) {
                        boolean match = false; for (FindPattern item : patterns) if (findMatches(item.tokens(), relative, budget)) { match = true; break; }
                        if (!match) continue;
                        Path physical = entry.toRealPath(); if (!physical.startsWith(root)) continue;
                        String result = root.relativize(physical).toString().replace('\\', '/');
                        bytes += result.getBytes(StandardCharsets.UTF_8).length + 1;
                        if (results.size() >= 10000 || bytes > 1000000) throw new IOException("find result limit exceeded (10000 files or 1000000 UTF-8 bytes); narrow the pattern/path");
                        results.add(result);
                    }
                }
            }
        }
        Collections.sort(results);
        return results.isEmpty() ? "(no matches)" : String.join("\n", results);
    }

    // --- ls tool ---
    private static String handleLs(String cwd, String path) throws IOException {
        Path root = Path.of(cwd).toRealPath(), supplied = Path.of(path);
        if (!Files.isDirectory(root)) throw new IOException("cwd must be an existing directory");
        Path requested = supplied.isAbsolute() ? supplied : root.resolve(supplied);
        Path directory = resolveWritePath(requested.getRoot(), requested);
        if (!directory.startsWith(root) && !(spillRoot != null && directory.startsWith(Path.of(spillRoot).toRealPath()))) throw new IOException("path escapes cwd");
        if (!Files.isDirectory(directory)) throw new IOException("path must be an existing directory");
        List<String> lines = new ArrayList<>(); int size = 0;
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        try (DirectoryStream<Path> entries = Files.newDirectoryStream(directory)) {
            for (Path entry : entries) {
                if (lines.size() >= 100000) throw new IOException("ls exceeds 100000 entries; choose a narrower directory");
                if (System.nanoTime() >= deadline) throw new IOException("ls timed out after 30000 ms");
                String name = entry.getFileName().toString(), line;
                StandardCharsets.UTF_8.newEncoder().encode(java.nio.CharBuffer.wrap(name));
                try {
                    var info = Files.readAttributes(entry, java.nio.file.attribute.BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
                    char kind = info.isSymbolicLink() || (isWindows && info.isOther()) ? 'l' : info.isDirectory() ? 'd' : info.isRegularFile() ? '-' : '?';
                    line = kind == '?' ? "? " + name : kind + String.format(java.util.Locale.ROOT, "%10d", kind == '-' ? info.size() : 0) + " " + name;
                } catch (IOException error) { line = "? " + name; }
                size += line.getBytes(StandardCharsets.UTF_8).length + 1;
                if (size > 1000000) throw new IOException("ls exceeds 1000000 UTF-8 bytes; choose a narrower directory");
                lines.add(line);
            }
        }
        Collections.sort(lines); return String.join("\n", lines);
    }

    // --- job tool ---
    private static String handleJob(String cwd, String mode, String command, Long timeoutMs) {
        if (!mode.equals("list") && !mode.equals("start") && !mode.equals("view") && !mode.equals("stop")) {
            throw new RuntimeException("unknown mode: " + mode);
        }
        if (mode.equals("list")) {
            if (jobs.isEmpty()) return "(no jobs)";
            return jobs.values().stream()
                .sorted(Comparator.comparingLong(j -> Long.parseLong(j.id.substring(1))))
                .map(j -> j.id + " [" + j.status + (j.exitCode != null ? " " + j.exitCode : "") + "] " + j.command)
                .collect(Collectors.joining("\n"));
        }

        if (mode.equals("start")) {
            if (command == null || command.isEmpty()) throw new RuntimeException("command required");
            Job j = startJob(command, cwd);
            return "started " + j.id;
        }

        if (command == null || command.isEmpty()) throw new RuntimeException("job id required (pass as command)");

        Job j = jobs.get(command);
        if (j == null) throw new RuntimeException("no such job: " + command);

        if (mode.equals("view")) {
            return "[" + j.id + "] " + j.command + "\n[" + j.status + (j.exitCode != null ? " " + j.exitCode : "") + "]\n" + j.currentOutput();
        }

        if (mode.equals("stop")) {
            if (!j.status.equals("running")) return j.id + " already " + j.status;
            long timeout = timeoutMs == null ? 500 : Math.max(1, Math.min(timeoutMs, 1000));
            try {
                stopOwnedJob(j, timeout);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new RuntimeException("job stop interrupted: " + j.id, e);
            }
            return j.id + " stopped";
        }

        throw new RuntimeException("bad mode: " + mode);
    }

    private static final int MAX_MCP_CONFIG_BYTES = 16 * 1024 * 1024;
    private static String readMcpConfigText(Path path) throws IOException {
        var before = Files.readAttributes(path, java.nio.file.attribute.BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (!before.isRegularFile()) throw new IOException("MCP config must be a regular file");
        if (before.size() > MAX_MCP_CONFIG_BYTES) throw new IOException("MCP config exceeds 16 MiB limit");
        try (FileChannel channel = FileChannel.open(path, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
            verifyReadFile(path, before, channel);
            ByteBuffer bytes = ByteBuffer.allocate((int) before.size() + 1);
            while (bytes.hasRemaining()) {
                if (channel.read(bytes) < 0) break;
            }
            if (bytes.position() != before.size()) throw new IOException("MCP config changed during read");
            verifyReadFile(path, before, channel);
            bytes.flip();
            String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT).decode(bytes).toString();
            return text.startsWith("\ufeff") ? text.substring(1) : text;
        }
    }

    // --- mcp tool ---
    @SuppressWarnings("unchecked")
    private static Map<String, Object> loadMcpServers(Path configFullPath) throws IOException {
        String content = readMcpConfigText(configFullPath);
        Map<String, Object> parsed = parseJsonObject(content);
        Object servers = parsed.get("mcpServers");
        if (!(servers instanceof Map<?, ?> entries)) throw new IOException(".mcp.json must contain an mcpServers object");
        for (var entry : entries.entrySet()) validateMcpServer(entry.getValue());
        return (Map<String, Object>) servers;
    }

    private static void mcpResultStrings(Map<?, ?> value, String... fields) throws IOException {
        for (String field : fields) if (!(value.get(field) instanceof String)) throw new IOException("tools/call returned invalid " + field);
    }

    private static void mcpResultMetadata(Map<?, ?> value) throws IOException {
        for (String field : List.of("annotations", "_meta"))
            if (value.containsKey(field) && !(value.get(field) instanceof Map<?, ?>)) throw new IOException("tools/call returned invalid " + field);
    }

    private static Map<?, ?> validateMcpToolResult(Map<?, ?> result) throws IOException {
        if (result == null || !(result.get("content") instanceof List<?> content)) throw new IOException("tools/call returned invalid content");
        if (result.containsKey("isError") && !(result.get("isError") instanceof Boolean)) throw new IOException("tools/call returned invalid isError");
        for (String field : List.of("structuredContent", "_meta"))
            if (result.containsKey(field) && !(result.get(field) instanceof Map<?, ?>)) throw new IOException("tools/call returned invalid " + field);
        for (Object value : content) {
            if (!(value instanceof Map<?, ?> block) || !(block.get("type") instanceof String kind) || kind.isEmpty()) throw new IOException("tools/call returned invalid content block");
            mcpResultMetadata(block);
            switch (kind) {
                case "text" -> mcpResultStrings(block, "text");
                case "image", "audio" -> mcpResultStrings(block, "data", "mimeType");
                case "resource_link" -> {
                    mcpResultStrings(block, "uri", "name");
                    for (String field : List.of("mimeType", "title", "description")) if (block.containsKey(field)) mcpResultStrings(block, field);
                }
                case "resource" -> {
                    if (!(block.get("resource") instanceof Map<?, ?> resource)) throw new IOException("tools/call returned invalid resource");
                    mcpResultStrings(resource, "uri");
                    mcpResultMetadata(resource);
                    if (!resource.containsKey("text") && !resource.containsKey("blob")) throw new IOException("tools/call returned invalid resource content");
                    for (String field : List.of("text", "blob", "mimeType")) if (resource.containsKey(field)) mcpResultStrings(resource, field);
                }
                default -> { /* Preserve unknown extension block types. */ }
            }
        }
        return result;
    }

    // Validate proxy-facing field types without claiming full JSON Schema evaluation.
    private static void validateMcpToolDefinition(Map<?, ?> tool) throws IOException {
        for (String field : List.of("inputSchema", "outputSchema")) {
            if (!tool.containsKey(field)) continue;
            if (!(tool.get(field) instanceof Map<?, ?> schema)) throw new IOException("tools/list returned invalid " + field);
            if (schema.containsKey("type") && !"object".equals(schema.get("type"))) throw new IOException("tools/list returned invalid " + field + ".type");
            if (schema.containsKey("$schema") && !(schema.get("$schema") instanceof String)) throw new IOException("tools/list returned invalid " + field + ".$schema");
            if (schema.containsKey("properties") && !(schema.get("properties") instanceof Map<?, ?>)) throw new IOException("tools/list returned invalid " + field + ".properties");
            if (schema.containsKey("required") && (!(schema.get("required") instanceof List<?> required) || required.stream().anyMatch(value -> !(value instanceof String)))) throw new IOException("tools/list returned invalid " + field + ".required");
        }
        for (String field : List.of("description", "title"))
            if (tool.containsKey(field) && !(tool.get(field) instanceof String)) throw new IOException("tools/list returned invalid " + field);
        for (String field : List.of("annotations", "_meta", "execution"))
            if (tool.containsKey(field) && !(tool.get(field) instanceof Map<?, ?>)) throw new IOException("tools/list returned invalid " + field);
        if (tool.get("annotations") instanceof Map<?, ?> annotations) {
            for (String field : List.of("readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"))
                if (annotations.containsKey(field) && !(annotations.get(field) instanceof Boolean)) throw new IOException("tools/list returned invalid annotations." + field);
            if (annotations.containsKey("title") && !(annotations.get("title") instanceof String)) throw new IOException("tools/list returned invalid annotations.title");
        }
        if (tool.containsKey("icons")) {
            if (!(tool.get("icons") instanceof List<?> icons)) throw new IOException("tools/list returned invalid icons");
            for (Object value : icons) {
                if (!(value instanceof Map<?, ?> icon) || !(icon.get("src") instanceof String)) throw new IOException("tools/list returned invalid icons.src");
                for (String field : List.of("mimeType", "theme"))
                    if (icon.containsKey(field) && !(icon.get(field) instanceof String)) throw new IOException("tools/list returned invalid icons." + field);
                if (icon.containsKey("sizes") && (!(icon.get("sizes") instanceof List<?> sizes) || sizes.stream().anyMatch(size -> !(size instanceof String)))) throw new IOException("tools/list returned invalid icons.sizes");
            }
        }
    }

    @FunctionalInterface
    private interface McpToolPage {
        Map<?, ?> fetch(Map<String, Object> params, long timeoutMs) throws Exception;
    }

    private static Map<?, ?> discoverMcpTools(McpToolPage fetch, long deadline) throws Exception {
        List<Object> tools = new ArrayList<>();
        Set<String> names = new HashSet<>(), cursors = new HashSet<>();
        Map<String, Object> params = Map.of();
        long bytes = 0;
        for (int pageNumber = 0; pageNumber < 256; pageNumber++) {
            Map<?, ?> page = fetch.fetch(params, mcpSetupRemaining(deadline));
            if (page == null || !(page.get("tools") instanceof List<?> entries))
                throw new IOException("tools/list response must contain a tools array");
            boolean more = page.containsKey("nextCursor");
            if (pageNumber > 0 || more) {
                bytes += toJson(page).getBytes(StandardCharsets.UTF_8).length;
                if (bytes > 16 * 1024 * 1024) throw new IOException("MCP discovery exceeds 16 MiB limit");
            }
            for (Object entry : entries) {
                if (!(entry instanceof Map<?, ?> tool) || !(tool.get("name") instanceof String name) || name.isEmpty())
                    throw new IOException("tools/list returned an invalid tool");
                validateMcpToolDefinition(tool);
                if (!names.add(name)) throw new IOException("tools/list contains duplicate tool names");
                tools.add(tool);
            }
            mcpSetupRemaining(deadline);
            if (!more) return Map.of("tools", tools);
            if (!(page.get("nextCursor") instanceof String cursor))
                throw new IOException("tools/list nextCursor must be a string");
            if (!cursors.add(cursor)) throw new IOException("tools/list repeated a pagination cursor");
            params = Map.of("cursor", cursor);
        }
        throw new IOException("MCP discovery exceeds 256 pages");
    }

    private static String mcpListedTools(String key, String server, Map<?, ?> result) throws IOException {
        return mcpListedTools(key, server, result, null);
    }

    private static String mcpListedTools(String key, String server, Map<?, ?> result, Object expectedSetup) throws IOException {
        return mcpListedTools(key, server, result, expectedSetup, 600000);
    }

    private static String mcpListedTools(String key, String server, Map<?, ?> result, Object expectedSetup, long idleTimeoutMs) throws IOException {
        if (!(result.get("tools") instanceof List<?> tools)) throw new IOException("tools/list response must contain a tools array");
        List<Map<String, Object>> normalized = new ArrayList<>();
        List<String> names = new ArrayList<>();
        for (Object tool : tools) {
            if (!(tool instanceof Map<?, ?> entry) || !(entry.get("name") instanceof String name) || name.isEmpty())
                throw new IOException("tools/list returned an invalid tool");
            Map<String, Object> definition = new LinkedHashMap<>();
            for (var field : entry.entrySet()) definition.put((String) field.getKey(), field.getValue());
            definition.putIfAbsent("description", "");
            definition.putIfAbsent("inputSchema", Map.of("type", "object"));
            normalized.add(definition);
            names.add(name);
        }
        if (expectedSetup == null) {
            mcpServerTools.put(key, names);
        } else if (expectedSetup instanceof Process expectedProc) {
            AtomicBoolean published = new AtomicBoolean();
            mcpProcesses.computeIfPresent(key, (ignored, current) -> {
                if (current == expectedProc) {
                    mcpServerTools.put(key, names);
                    published.set(true);
                }
                return current;
            });
            if (!published.get()) throw new IOException("MCP server was unloaded during discovery");
        } else {
            AtomicBoolean published = new AtomicBoolean();
            mcpHttp.computeIfPresent(key, (ignored, current) -> {
                if (current.get("setup_done") == expectedSetup) {
                    mcpServerTools.put(key, names);
                    published.set(true);
                }
                return current;
            });
            if (!published.get()) throw new IOException("MCP server was unloaded during discovery");
        }
        return toJson(Map.of("server", server, "status", "loaded", "tools", normalized, "idleTimeoutMs", idleTimeoutMs));
    }

    private static Process removeMcpStdio(String key, Process expected) {
        Process[] removed = new Process[1];
        synchronized (mcpProcesses) {
            mcpProcesses.computeIfPresent(key, (ignored, current) -> {
                if (expected != null && current != expected) return current;
                removed[0] = current;
                mcpServerTools.remove(key);
                return null;
            });
        }
        Process proc = removed[0];
        if (proc != null) {
            closeMcpStdio(proc, "MCP server was unloaded");
            McpStdioSetup setup = mcpStdioSetups.remove(proc);
            if (setup != null) setup.done().completeExceptionally(new IOException("MCP server was unloaded"));
        }
        return proc;
    }

    private static void unloadMcpHttp(String key) {
        List<Map<String, Object>> removed = new ArrayList<>(1);
        mcpHttp.compute(key, (ignored, current) -> {
            mcpServerTools.remove(key);
            if (current != null) removed.add(current);
            return null;
        });
        for (var info : removed) {
            ((CompletableFuture<?>) info.get("setup_done")).completeExceptionally(new IOException("MCP server was unloaded"));
            ((McpHttpCancellation) info.get("cancellation")).cancel();
        }
    }

    private static void unloadMcpEntries(String cwd, String selectedKey) {
        List<Process> procs = new ArrayList<>();
        List<Map<String, Object>> http = new ArrayList<>();
        // Detach both transports and their metadata at one registry boundary.
        // Cleanup must not look up a key again after new work can replace it.
        synchronized (mcpProcesses) {
            Set<String> keys = new HashSet<>();
            if (selectedKey != null) keys.add(selectedKey);
            else {
                keys.addAll(mcpProcesses.keySet());
                keys.addAll(mcpHttp.keySet());
                keys.addAll(mcpServerTools.keySet());
                String prefix = mcpCachePrefix(cwd);
                keys.removeIf(key -> !key.startsWith(prefix));
            }
            for (String key : keys) {
                Process proc = mcpProcesses.remove(key);
                if (proc != null) procs.add(proc);
                Map<String, Object> info = mcpHttp.remove(key);
                if (info != null) http.add(info);
                mcpServerTools.remove(key);
            }
        }
        for (var info : http) {
            ((CompletableFuture<?>) info.get("setup_done")).completeExceptionally(new IOException("MCP server was unloaded"));
            ((McpHttpCancellation) info.get("cancellation")).cancel();
        }
        for (Process proc : procs) {
            closeMcpStdio(proc, "MCP server was unloaded");
            McpStdioSetup setup = mcpStdioSetups.remove(proc);
            if (setup != null) setup.done().completeExceptionally(new IOException("MCP server was unloaded"));
        }
    }

    private static String mcpCacheKey(String cwd, Path config, String server) {
        return toJson(List.of(cwd, config.toString(), server));
    }

    private static String mcpCachePrefix(String cwd) { return "[" + toJson(cwd) + ","; }

    private static List<List<Object>> mcpConfigPairs(Object value, boolean insensitive) {
        if (!(value instanceof Map<?, ?> map)) return List.of();
        List<List<Object>> pairs = new ArrayList<>();
        for (var entry : map.entrySet()) pairs.add(List.of(entry.getKey(), entry.getValue()));
        // List.sort is stable: colliding keys retain their override precedence.
        pairs.sort(Comparator.comparing(pair -> insensitive
            ? ((String) pair.get(0)).toLowerCase(Locale.ROOT) : (String) pair.get(0)));
        return pairs;
    }

    private static void checkMcpCapacity(String cwd, String key) throws IOException {
        // Caller holds mcpProcesses through registration so pending setups count.
        Set<String> keys = new HashSet<>(mcpProcesses.keySet());
        keys.addAll(mcpHttp.keySet());
        if (keys.contains(key)) return;
        String prefix = mcpCachePrefix(cwd);
        if (keys.stream().filter(candidate -> candidate.startsWith(prefix)).count() >= 10)
            throw new IOException("max servers per cwd (10) exceeded for " + cwd);
        if (keys.size() >= 50) throw new IOException("max total cached servers (50) exceeded");
    }

    private static String mcpConfigSignature(Map<String, Object> cfg) {
        List<?> effective = "http".equals(cfg.get("type"))
            ? List.of("http", cfg.get("url"), mcpConfigPairs(cfg.get("headers"), true))
            : List.of("stdio", cfg.get("command"), cfg.getOrDefault("args", List.of()),
                mcpConfigPairs(cfg.get("env"), isWindows), mcpIdleTimeout(cfg));
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(toJson(effective).getBytes(StandardCharsets.UTF_8))); }
        catch (NoSuchAlgorithmException impossible) { throw new AssertionError(impossible); }
    }

    private static boolean mcpConfigMatches(String key, String signature) {
        Map<String, Object> info = mcpHttp.get(key);
        return info != null ? signature.equals(info.get("config_signature"))
            : signature.equals(mcpProcessConfigSignatures.get(mcpProcesses.get(key)));
    }

    @SuppressWarnings("unchecked")
    private static Map<String, String> reconcileMcpConfig(String cwd, Path path, Map<String, Object> servers) {
        Map<String, String> signatures = new HashMap<>();
        for (var entry : servers.entrySet()) signatures.put(entry.getKey(), mcpConfigSignature((Map<String, Object>) entry.getValue()));
        List<Process> procs = new ArrayList<>();
        List<Map<String, Object>> http = new ArrayList<>();
        String prefix = mcpCachePrefix(cwd);
        synchronized (mcpProcesses) {
            for (var entry : new ArrayList<>(mcpProcesses.entrySet())) {
                String key = entry.getKey();
                if (!key.startsWith(prefix)) continue;
                List<?> id = (List<?>) parseJsonValue(key);
                if (!path.toString().equals(id.get(1))) continue;
                String signature = signatures.get(id.get(2));
                if (signature == null || !signature.equals(mcpProcessConfigSignatures.get(entry.getValue()))) {
                    if (mcpProcesses.remove(key, entry.getValue())) {
                        mcpServerTools.remove(key);
                        procs.add(entry.getValue());
                    }
                }
            }
            for (var entry : new ArrayList<>(mcpHttp.entrySet())) {
                String key = entry.getKey();
                if (!key.startsWith(prefix)) continue;
                List<?> id = (List<?>) parseJsonValue(key);
                if (!path.toString().equals(id.get(1))) continue;
                String signature = signatures.get(id.get(2));
                if (signature == null || !signature.equals(entry.getValue().get("config_signature"))) {
                    mcpHttp.computeIfPresent(key, (ignored, current) -> {
                        if (current.get("cancellation") != entry.getValue().get("cancellation")) return current;
                        mcpServerTools.remove(key);
                        http.add(current);
                        return null;
                    });
                }
            }
        }
        for (var info : http) {
            ((CompletableFuture<?>) info.get("setup_done")).completeExceptionally(new IOException("MCP configuration changed"));
            ((McpHttpCancellation) info.get("cancellation")).cancel();
        }
        for (Process proc : procs) {
            McpStdioSetup setup = mcpStdioSetups.remove(proc);
            if (setup != null) setup.done().completeExceptionally(new IOException("MCP configuration changed"));
            closeMcpStdio(proc, "MCP configuration changed");
        }
        return signatures;
    }

    private static String handleMcp(String cwd, String action, String server, String tool, Map<String, Object> args, String mcpCfgPath) {
        if (shuttingDown) return "{\"error\":\"server is shutting down\"}";
        if ((action.equals("list") || action.equals("call")) && server != null && !server.isEmpty()
                && !AGGREGATOR_NS_RE.matcher(server).matches())
            return "{\"error\":\"invalid server namespace\"}";
        String cfgPath = mcpCfgPath != null ? mcpCfgPath : ".mcp.json";
        // The agent-supplied config path must stay inside the cwd sandbox
        // (parity with TS): an absolute path or ../ escape is refused, not
        // silently read. Path.of(cwd, abs) would join it as a CHILD of cwd.
        Path cwdResolved = Path.of(cwd).toAbsolutePath().normalize();
        Path configFullPath = Path.of(cfgPath).isAbsolute()
            ? Path.of(cfgPath).normalize()
            : Path.of(cwd, cfgPath).normalize();
        if (!configFullPath.startsWith(cwdResolved)) {
            return "{\"error\":\"config path escapes cwd: " + escapeJson(cfgPath) + "\"}";
        }

        if (action.equals("list") && server == null) {
            try {
                Map<String, Object> servers = loadMcpServers(configFullPath);
                Map<String, String> signatures = reconcileMcpConfig(cwd, configFullPath, servers);
                List<String> result = new ArrayList<>();
                for (String name : servers.keySet()) {
                    String key = mcpCacheKey(cwd, configFullPath, name);
                    Process p = mcpProcesses.get(key);
                    boolean isLoaded = (((p != null) && p.isAlive() && !mcpStdioClosed(p) && !mcpStdioSetups.containsKey(p)) || mcpHttp.containsKey(key)) && mcpServerTools.containsKey(key) && mcpConfigMatches(key, signatures.get(name));
                    result.add(toJson(Map.of("name", name, "status", isLoaded ? "loaded" : "unloaded",
                        "tools", isLoaded ? mcpServerTools.getOrDefault(key, List.of()) : List.of(),
                        "idleTimeoutMs", mcpIdleTimeout((Map<String, Object>) servers.get(name)))));
                }
                return "{\"servers\":[" + String.join(",", result) + "],\"mcpConfigPath\":\"" + escapeJson(cfgPath) + "\"}";
            } catch (Exception e) {
                return "{\"error\":\"" + escapeJson(e.getMessage()) + "\"}";
            }
        }

        if (action.equals("call") || action.equals("list")) {
            if (server == null || server.isEmpty()) return "{\"error\":\"server name required for call action\"}";
            if (action.equals("call") && (tool == null || tool.isEmpty())) return "{\"error\":\"tool name required for call action\"}";
            try {
                if (!Files.exists(configFullPath)) {
                    return "{\"error\":\".mcp.json not found at " + escapeJson(cfgPath) + "\"}";
                }
                Map<String, Object> servers = loadMcpServers(configFullPath);
                Map<String, String> signatures = reconcileMcpConfig(cwd, configFullPath, servers);
                @SuppressWarnings("unchecked")
                Map<String, Object> serverCfg = (Map<String, Object>) servers.get(server);
                if (serverCfg == null) {
                    return "{\"error\":\"server '" + escapeJson(server) + "' not found in .mcp.json\"}";
                }

                // One initializer owns each HTTP connection generation. Waiters
                // cannot send requests until its handshake and discovery succeed.
                if ("http".equals(serverCfg.get("type"))) {
                    String key = mcpCacheKey(cwd, configFullPath, server);
                    Map<String, Object> info;
                    boolean needsInit = false;
                    synchronized (mcpProcesses) {
                    if (shuttingDown) throw new IOException("server is shutting down");
                    info = mcpHttp.get(key);
                    if (mcpProcesses.containsKey(key) || (info != null && !signatures.get(server).equals(info.get("config_signature"))))
                        throw new IOException("MCP configuration changed during request");
                    if (info == null) {
                        checkMcpCapacity(cwd, key);
                        Map<String, Object> fresh = new LinkedHashMap<>();
                        fresh.put("config_signature", signatures.get(server));
                        fresh.put("url", serverCfg.get("url"));
                        fresh.put("headers", serverCfg.getOrDefault("headers", Map.of()));
                        fresh.put("session_id", null);
                        fresh.put("setup_done", new CompletableFuture<Void>());
                        fresh.put("cancellation", new McpHttpCancellation());
                        fresh.put("setup_deadline", System.nanoTime() + TimeUnit.SECONDS.toNanos(30));
                        info = mcpHttp.putIfAbsent(key, fresh);
                        if (info == null) { info = fresh; needsInit = true; }
                    }
                    }
                    @SuppressWarnings("unchecked")
                    CompletableFuture<Void> setup = (CompletableFuture<Void>) info.get("setup_done");
                    try {
                        Map<?, ?> toolsResult = null;
                        if (needsInit) {
                            long setupDeadline = (Long) info.get("setup_deadline");
                            mcpHttpRpc(key, "initialize", Map.of(
                                "protocolVersion", "2024-11-05",
                                "capabilities", Map.of("roots", Map.of()),
                                "clientInfo", Map.of("name", "code-mcp-aggregator", "version", "0.1.0")
                            ), mcpSetupRemaining(setupDeadline), setup);
                            mcpHttpRpc(key, "notifications/initialized", Map.of(), mcpSetupRemaining(setupDeadline), setup);
                            toolsResult = discoverMcpTools((params, budget) -> mcpHttpRpc(key, "tools/list", params, budget, setup), setupDeadline);
                            mcpSetupRemaining(setupDeadline);
                            mcpListedTools(key, server, toolsResult, setup);
                            setup.complete(null);
                        } else if (setup.isDone()) {
                            setup.get();
                        } else {
                            setup.get(mcpSetupRemaining((Long) info.get("setup_deadline")), TimeUnit.MILLISECONDS);
                        }
                        if (action.equals("list")) {
                            if (toolsResult == null) toolsResult = discoverMcpTools((params, budget) -> mcpHttpRpc(key, "tools/list", params, budget, setup), System.nanoTime() + TimeUnit.SECONDS.toNanos(30));
                            return mcpListedTools(key, server, toolsResult, setup, mcpIdleTimeout(serverCfg));
                        }
                        return toJson(validateMcpToolResult(mcpHttpRpc(key, "tools/call", Map.of("name", tool,
                            "arguments", args != null ? args : Map.of()), 90_000, setup)));
                    } catch (Exception error) {
                        if (error instanceof InterruptedException) Thread.currentThread().interrupt();
                        if (needsInit && !setup.isDone()) {
                            setup.completeExceptionally(new IOException(String.valueOf(error.getMessage())));
                            mcpHttp.computeIfPresent(key, (ignored, current) -> {
                                if (current.get("setup_done") != setup) return current;
                                mcpServerTools.remove(key);
                                return null;
                            });
                        }
                        return "{\"error\":\"" + escapeJson(String.valueOf(error.getMessage())) + "\"}";
                    }
                }

                String cmd = (String) serverCfg.get("command");
                if (cmd == null) return "{\"error\":\"server '" + escapeJson(server) + "' missing 'command'\"}";
                List<String> cmdArgs = new ArrayList<>();
                cmdArgs.add(cmd);
                Object cfgArgs = serverCfg.get("args");
                if (cfgArgs instanceof List) {
                    for (Object a : (List<?>) cfgArgs) cmdArgs.add(String.valueOf(a));
                }
                String key = mcpCacheKey(cwd, configFullPath, server);
                // Registry mutation is short; a handshake must never hold up
                // initialization of an unrelated server.
                Process proc;
                McpStdioSetup setup;
                boolean owner;
                Map<?, ?> discovered = null;
                synchronized (mcpProcesses) {
                    if (shuttingDown) throw new IOException("server is shutting down");
                    proc = mcpProcesses.get(key);
                    if (mcpHttp.containsKey(key) || (proc != null && !signatures.get(server).equals(mcpProcessConfigSignatures.get(proc))))
                        throw new IOException("MCP configuration changed during request");
                    owner = proc == null || !proc.isAlive() || mcpStdioClosed(proc);
                    if (!owner && !mcpIdleAcquire(proc)) owner = true;
                    if (owner) {
                        checkMcpCapacity(cwd, key);
                        mcpServerTools.remove(key);
                        ProcessBuilder pb = new ProcessBuilder(cmdArgs);
                        pb.directory(Path.of(cwd).toFile());
                        pb.redirectError(ProcessBuilder.Redirect.DISCARD);
                        scrubEnv(pb);
                        if (serverCfg.containsKey("env")) {
                            if (!(serverCfg.get("env") instanceof Map<?, ?> overrides)) throw new IOException("env must be an object");
                            for (var entry : overrides.entrySet()) {
                                if (!(entry.getKey() instanceof String name) || !(entry.getValue() instanceof String value))
                                    throw new IOException("env values must be strings");
                                putMcpEnv(pb, name, value);
                            }
                        }
                        setup = new McpStdioSetup(System.nanoTime() + TimeUnit.SECONDS.toNanos(30), new CompletableFuture<>());
                        proc = startMcpStdio(pb);
                        mcpIdleRegister(proc, mcpIdleTimeout(serverCfg));
                        mcpStdioSetups.put(proc, setup);
                        mcpProcessConfigSignatures.put(proc, signatures.get(server));
                        mcpProcesses.put(key, proc);
                    } else {
                        setup = mcpStdioSetups.get(proc);
                    }
                }
                final Process discoveryProc = proc;
                try {
                    if (owner) {
                        try {
                            mcpCall(key, proc, "initialize", Map.of(
                                "protocolVersion", "2024-11-05", "capabilities", Map.of("roots", Map.of()),
                                "clientInfo", Map.of("name", "code-mcp-aggregator", "version", "0.1.0")), mcpSetupRemaining(setup.deadline()));
                            mcpCall(key, proc, "notifications/initialized", Map.of(), mcpSetupRemaining(setup.deadline()));
                            discovered = discoverMcpTools((params, budget) -> mcpCall(key, discoveryProc, "tools/list", params, budget), setup.deadline());
                            mcpSetupRemaining(setup.deadline());
                            mcpListedTools(key, server, discovered, proc);
                            setup.done().complete(null);
                        } catch (Exception failure) {
                            setup.done().completeExceptionally(failure);
                            removeMcpStdio(key, proc);
                            proc.destroy();
                            throw failure;
                        } finally {
                            mcpStdioSetups.remove(proc, setup);
                        }
                    } else if (setup != null) {
                        setup.done().get(mcpSetupRemaining(setup.deadline()), TimeUnit.MILLISECONDS);
                    }
                    Map<String, Object> callArgs = new LinkedHashMap<>();
                    callArgs.put("name", tool);
                    callArgs.put("arguments", args != null ? args : Map.of());
                    // RPC/application errors affect this call only. The connection
                    // closes itself on fatal I/O, framing failures or deadlines.
                    if (action.equals("list")) return mcpListedTools(key, server, discovered != null ? discovered : discoverMcpTools((params, budget) -> mcpCall(key, discoveryProc, "tools/list", params, budget), System.nanoTime() + TimeUnit.SECONDS.toNanos(30)), proc, mcpIdleTimeout(serverCfg));
                    Map<?, ?> result = mcpCall(key, proc, "tools/call", callArgs);
                    return toJson(validateMcpToolResult(result));
                } finally {
                    mcpIdleRelease(proc);
                }
            } catch (Exception e) {
                return "{\"error\":\"" + escapeJson(e.getMessage()) + "\"}";
            }
        }

        if (action.equals("unload")) {
            unloadMcpEntries(cwd, server != null ? mcpCacheKey(cwd, configFullPath, server) : null);
            return "{ \"success\": true }";
        }

        return "{ \"error\": \"unknown action: " + escapeJson(action) + "\" }";
    }

    @SuppressWarnings("unchecked")
    private static Map<?, ?> mcpHttpRpc(String key, String method, Map<String, Object> params) throws Exception {
        return mcpHttpRpc(key, method, params, mcpHttpTimeoutMillis(method));
    }

    private static Map<?, ?> mcpHttpRpc(String key, String method, Map<String, Object> params, long timeoutMs) throws Exception {
        return mcpHttpRpc(key, method, params, timeoutMs, null);
    }

    private static Map<?, ?> mcpHttpRpc(String key, String method, Map<String, Object> params, long timeoutMs, Object expectedSetup) throws Exception {
        Map<String, Object> info = mcpHttp.get(key);
        if (expectedSetup != null && (info == null || info.get("setup_done") != expectedSetup))
            throw new IOException("MCP server was unloaded during request");
        if (info == null) throw new IOException("MCP server '" + key + "' not running");
        int reqId;
        synchronized (mcpIdLock) {
            mcpNextId++;
            reqId = mcpNextId;
        }
        boolean notification = method.startsWith("notifications/");
        String body = "{\"jsonrpc\":\"2.0\"" + (notification ? "" : ",\"id\":" + reqId)
            + ",\"method\":\"" + method + "\",\"params\":" + toJson(params) + "}";
        try {
            HttpRequest.Builder rb = mcpHttpRequestBuilder(info, method, body, timeoutMs);
            McpHttpDispatch dispatch = notification ? null : new McpHttpDispatch(info, reqId, timeoutMs);
            HttpResponse<String> resp = sendMcpHttp(rb.build(), timeoutMs, (McpHttpCancellation) info.get("cancellation"), dispatch, notification);
            Map<String, Object> current = mcpHttp.get(key);
            if (current == null || current.get("setup_done") != info.get("setup_done"))
                throw new IOException("MCP server was unloaded during request");
            int status = resp.statusCode();
            if (status < 200 || status >= 300) throw new IOException("http " + status);
            if (notification) return Map.of();
            if (status == 202 || status == 204 || resp.headers().firstValue("Content-Length").orElse("").equals("0")) {
                throw new IOException("RPC request received an empty response");
            }
            String text = resp.body();
            if (text == null || text.isBlank()) throw new IOException("RPC request received an empty response");
            Map<String, Object> msg = dispatch.accept(parseJsonValue(text));
            if (msg == null) throw new IOException("no JSON-RPC response");
            Map<?, ?> result = mcpRpcResult(msg, reqId);
            if (method.equals("initialize")) {
                String version = mcpNegotiatedVersion(result);
                String sid = mcpValidateSessionId(resp.headers().firstValue("Mcp-Session-Id").orElse(null));
                Map<String, Object> updated = new LinkedHashMap<>(info);
                updated.put("session_id", sid);
                updated.put("protocol_version", version);
                if (!mcpHttp.replace(key, info, updated)) throw new IOException("MCP server was unloaded during request");
            }
            return result;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("http rpc interrupted", e);
        } catch (Exception e) {
            throw new IOException("http rpc failed: " + e.getMessage(), e);
        }
    }

    private static boolean mcpIsNotification(Map<String, Object> message) {
        return "2.0".equals(message.get("jsonrpc")) && message.get("method") instanceof String
            && !message.containsKey("id") && !message.containsKey("result") && !message.containsKey("error");
    }

    private static Map<String, Object> mcpServerRequest(Map<String, Object> message) {
        Object id = message.get("id");
        boolean validId = id instanceof String || (id instanceof Number number && Double.isFinite(number.doubleValue()));
        Map<String, Object> reply = new LinkedHashMap<>();
        reply.put("jsonrpc", "2.0");
        reply.put("id", validId ? id : null);
        int code = 0;
        String error = null;
        if (!validId || !"2.0".equals(message.get("jsonrpc")) || !(message.get("method") instanceof String)
                || message.containsKey("result") || message.containsKey("error")) {
            code = -32600; error = "Invalid Request";
        } else if (message.containsKey("params") && !(message.get("params") instanceof Map<?, ?>)) {
            code = -32602; error = "Invalid params";
        } else if ("ping".equals(message.get("method"))) {
            reply.put("result", Map.of());
        } else if ("roots/list".equals(message.get("method"))) {
            reply.put("result", Map.of("roots", List.of()));
        } else {
            code = -32601; error = "Method not found";
        }
        if (error != null) reply.put("error", Map.of("code", code, "message", error));
        return reply;
    }

    private static final int MCP_MAX_BATCH_MESSAGES = 1024;
    private static List<?> mcpBatchMessages(Object value) throws IOException {
        if (!(value instanceof List<?> messages)) return Collections.singletonList(value);
        if (messages.size() > MCP_MAX_BATCH_MESSAGES) throw new IOException("MCP batch exceeds 1024 messages");
        Set<Object> requests = new HashSet<>(), responses = new HashSet<>();
        for (Object item : messages) {
            if (!(item instanceof Map<?, ?> message)) continue;
            Object id = message.get("id");
            if (id instanceof Number number && Double.isFinite(number.doubleValue())) {
                double numericId = number.doubleValue();
                id = numericId == 0.0 ? 0.0 : numericId; // -0 and 0 name the same request.
            }
            else if (!(id instanceof String)) continue;
            Set<Object> ids = message.containsKey("method") ? requests : responses;
            if (!ids.add(id)) throw new IOException("duplicate MCP batch request or response ID");
        }
        return messages;
    }

    private static final int MAX_MCP_STDIO_FRAME_BYTES = 16 * 1024 * 1024;
    private static final class McpStdioFrameException extends IOException {
        McpStdioFrameException(String message) { super(message); }
    }
    private static final class McpStdioFrameBuffer extends ByteArrayOutputStream {
        String decode() throws IOException {
            return StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(buf, 0, count)).toString();
        }
    }
    private static final class McpStdioLineReader {
        private final InputStream input;
        private final byte[] buffer = new byte[8192];
        private int offset, available;
        McpStdioLineReader(InputStream input) { this.input = input; }
        String readLine() throws IOException {
            if (available == -1) return null;
            McpStdioFrameBuffer frame = new McpStdioFrameBuffer();
            while (true) {
                if (offset == available) {
                    available = input.read(buffer);
                    offset = 0;
                    if (available == -1) {
                        if (frame.size() != 0) throw new McpStdioFrameException("unterminated MCP stdio frame");
                        return null;
                    }
                    if (available == 0) continue;
                }
                int end = offset;
                while (end < available && buffer[end] != 10) end++;
                boolean newline = end < available;
                if (newline) end++;
                int length = end - offset;
                if (frame.size() + length > MAX_MCP_STDIO_FRAME_BYTES)
                    throw new McpStdioFrameException("MCP stdio frame exceeds 16 MiB");
                frame.write(buffer, offset, length);
                offset = end;
                if (newline) return frame.decode();
            }
        }
    }

    // Same readable Windows Job Object helper as Python and TypeScript.
    private static final String MCP_WINDOWS_JOB_SOURCE = """
        using System;
        using System.ComponentModel;
        using System.IO;
        using System.Runtime.InteropServices;
        using System.Text;
        using System.Threading;

        public static class CodeMcpWindowsJob {
            [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint Low, High; public ulong Value { get { return ((ulong)High << 32) | Low; } } }
            [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
                public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorkingSet, MaxWorkingSet;
                public uint ActiveProcesses; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
            }
            [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
            [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
                public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
            }
            [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
                public uint Size; public string Reserved, Desktop, Title;
                public uint X, Y, XSize, YSize, XChars, YChars, FillAttribute, Flags;
                public ushort ShowWindow, ReservedCount; public IntPtr ReservedData, Input, Output, Error;
            }
            [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo Info; public IntPtr Attributes; }
            [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
            [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
            [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimits limits, uint length);
            [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
            [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
            [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
            [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInfo process);
            [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, uint count, uint flags, ref UIntPtr bytes);
            [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, UIntPtr attribute, IntPtr value, UIntPtr bytes, IntPtr previous, IntPtr returned);
            [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
            [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
            [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint id);
            [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
            [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out FileTime created, out FileTime exited, out FileTime kernel, out FileTime user);
            [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
            [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint milliseconds);
            [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
            [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetStdHandle(int which);
            [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
            [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetStdHandle(int which, IntPtr handle);
            [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
            [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
            [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, IntPtr attributes, uint size);
            [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(IntPtr handle, IntPtr bytes, uint length, out uint read, IntPtr overlapped);
            [DllImport("kernel32.dll", SetLastError=true)] static extern bool WriteFile(IntPtr handle, IntPtr bytes, uint length, out uint written, IntPtr overlapped);
            static ManualResetEvent outputDone = new ManualResetEvent(false);
            static volatile bool outputFailed;
            static void RelayOutput(IntPtr source, IntPtr sink) {
                byte[] bytes = new byte[65536]; GCHandle buffer = GCHandle.Alloc(bytes, GCHandleType.Pinned);
                try {
                    uint read;
                    while (ReadFile(source, buffer.AddrOfPinnedObject(), (uint)bytes.Length, out read, IntPtr.Zero)) {
                        if (read == 0) return;
                        uint offset = 0;
                        while (offset < read) {
                            uint written; Check(WriteFile(sink, IntPtr.Add(buffer.AddrOfPinnedObject(), (int)offset), read-offset, out written, IntPtr.Zero));
                            if (written == 0) throw new IOException("MCP output write made no progress");
                            offset += written;
                        }
                    }
                    int failure = Marshal.GetLastWin32Error();
                    if (failure != 109) throw new Win32Exception(failure);
                } catch { outputFailed = true; }
                finally { buffer.Free(); CloseHandle(source); CloseHandle(sink); outputDone.Set(); }
            }
            static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
            static IntPtr Inherit(int which) {
                IntPtr source = GetStdHandle(which), result;
                // Only the explicit child duplicate may be inherited. An extra copy
                // would keep the pipe alive after the child closes its standard stream.
                Check(SetHandleInformation(source, 1, 0));
                Check(DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), out result, 0, true, 2)); return result;
            }
            static void ReleaseProtocolHandles() {
                IntPtr input = GetStdHandle(-10), output = GetStdHandle(-11), error = GetStdHandle(-12);
                Check(SetStdHandle(-10, IntPtr.Zero)); Check(SetStdHandle(-11, IntPtr.Zero));
                // Keep stderr for ownership diagnostics; the helper never uses the
                // protocol streams once the suspended child has received its handles.
                if (input != error) CloseHandle(input);
                if (output != input && output != error) CloseHandle(output);
            }
            static ulong Created(IntPtr process) { FileTime created, exited, kernel, user; Check(GetProcessTimes(process, out created, out exited, out kernel, out user)); return created.Value; }
            static string Quote(string argument) {
                StringBuilder result = new StringBuilder("\\""); int slashes = 0;
                foreach (char c in argument) {
                    if (c == '\\\\') { slashes++; continue; }
                    if (c == '"') { result.Append('\\\\', slashes * 2 + 1); result.Append('"'); }
                    else { result.Append('\\\\', slashes); result.Append(c); }
                    slashes = 0;
                }
                result.Append('\\\\', slashes * 2); result.Append('"'); return result.ToString();
            }
            // The guardian starts before assigning the root, so it remains outside
            // this Job. Detached descendants survive their shell but not their server.
            public static void GuardRoot(uint ownerId) {
                IntPtr owner = IntPtr.Zero, job = IntPtr.Zero;
                try {
                    owner = OpenProcess(0x101101, false, ownerId); Check(owner != IntPtr.Zero);
                    if (Created(owner) > Created(GetCurrentProcess()) || WaitForSingleObject(owner, 0) != 258)
                        throw new InvalidOperationException("MCP root owner already exited");
                    job = CreateJobObjectW(IntPtr.Zero, null); Check(job != IntPtr.Zero);
                    ExtendedLimits limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000;
                    Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
                    Check(AssignProcessToJobObject(job, owner));
                    Console.WriteLine("CODE_MCP_ROOT_READY"); Console.Out.Flush();
                    Check(WaitForSingleObject(owner, 0xffffffff) == 0);
                } finally {
                    if (job != IntPtr.Zero) CloseHandle(job);
                    if (owner != IntPtr.Zero) CloseHandle(owner);
                }
            }
            public static int Main(string[] args) {
                IntPtr owner = IntPtr.Zero, job = IntPtr.Zero, input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
                ProcessInfo child = new ProcessInfo(); bool assigned = false, relayStarted = false;
                IntPtr relayRead = IntPtr.Zero, relaySink = IntPtr.Zero;
                try {
                    // Fixed control fields are never inferred from the child command.
                    // The executable and all its arguments remain literal payload data.
                    uint ownerId;
                    if (args.Length < 4 || !UInt32.TryParse(args[0], out ownerId) || ownerId == 0)
                        throw new ArgumentException("missing MCP owner or command");
                    if (args[1] != "stdio" && args[1] != "job") throw new ArgumentException("invalid process owner mode");
                    bool backgroundJob = args[1] == "job";
                    bool rawCommand = args[2] == "raw" || args[2] == "raw-file";
                    string[] original;
                    if (args[2] == "file" || args[2] == "raw-file") {
                        if (args.Length != 4) throw new ArgumentException("invalid MCP argument file envelope");
                        // Java's Windows ProcessBuilder quoting differs from the CLR.
                        // Transfer exact UTF-8 argv without a second command-line parse.
                        using (FileStream request = new FileStream(args[3], FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete, 4096, FileOptions.DeleteOnClose)) {
                            if (request.Length > 262144) throw new ArgumentException("MCP argument file exceeds limit");
                            byte[] bytes = new byte[(int)request.Length]; int offset = 0;
                            while (offset < bytes.Length) { int n = request.Read(bytes, offset, bytes.Length - offset); if (n == 0) throw new EndOfStreamException(); offset += n; }
                            original = new UTF8Encoding(false, true).GetString(bytes).Split(new char[] { '\\0' });
                        }
                    } else if (args[2] == "argv" || args[2] == "raw") {
                        original = new string[args.Length - 3];
                        Array.Copy(args, 3, original, 0, original.Length);
                    } else throw new ArgumentException("invalid MCP argument transport");
                    string[] decoded = new string[original.Length + 1]; decoded[0] = args[0];
                    Array.Copy(original, 0, decoded, 1, original.Length); args = decoded;
                    owner = OpenProcess(0x101000, false, ownerId); Check(owner != IntPtr.Zero);
                    // Pin the owner handle. If its PID was recycled before this helper
                    // opened it, the new process cannot predate this helper's creation.
                    if (Created(owner) > Created(GetCurrentProcess()) || WaitForSingleObject(owner, 0) != 258) throw new InvalidOperationException("MCP owner already exited");
                    job = CreateJobObjectW(IntPtr.Zero, null); Check(job != IntPtr.Zero);
                    ExtendedLimits limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000;
                    Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
                    input = Inherit(-10); error = Inherit(-12);
                    Check(CreatePipe(out relayRead, out output, IntPtr.Zero, 65536));
                    Check(SetHandleInformation(output, 1, 1));
                    Check(DuplicateHandle(GetCurrentProcess(), GetStdHandle(-11), GetCurrentProcess(), out relaySink, 0, false, 2));
                    StartupInfoEx startup = new StartupInfoEx(); startup.Info.Size = (uint)Marshal.SizeOf(typeof(StartupInfoEx));
                    startup.Info.Flags = 0x100; startup.Info.Input = input; startup.Info.Output = output; startup.Info.Error = error;
                    StringBuilder command = new StringBuilder();
                    if (rawCommand) {
                        // CMD parses its /s /c command itself; CRT escaping changes both
                        // quoted executable paths and shell metacharacter semantics.
                        if (original.Length != 1) throw new ArgumentException("invalid raw command envelope");
                        command.Append(original[0]);
                    } else {
                        for (int i=1; i<args.Length; i++) { if (i>1) command.Append(' '); command.Append(Quote(args[i])); }
                    }
                    if (command.Length >= 32767) throw new ArgumentException("MCP command exceeds Windows command-line limit");
                    // The managed runtime can hold additional inheritable handles.
                    // Pass only our three distinct stdio duplicates to the child.
                    IntPtr handleList = IntPtr.Zero; bool attributesReady = false;
                    try {
                        UIntPtr attributeBytes = UIntPtr.Zero;
                        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeBytes);
                        int attributeLength = checked((int)attributeBytes.ToUInt64());
                        if (attributeLength <= 0) throw new InvalidOperationException("invalid MCP process attribute size");
                        startup.Attributes = Marshal.AllocHGlobal(attributeLength);
                        Check(InitializeProcThreadAttributeList(startup.Attributes, 1, 0, ref attributeBytes)); attributesReady = true;
                        handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
                        Marshal.WriteIntPtr(handleList, 0, input); Marshal.WriteIntPtr(handleList, IntPtr.Size, output); Marshal.WriteIntPtr(handleList, IntPtr.Size * 2, error);
                        Check(UpdateProcThreadAttribute(startup.Attributes, 0, new UIntPtr(0x20002), handleList, new UIntPtr((uint)(IntPtr.Size * 3)), IntPtr.Zero, IntPtr.Zero));
                        if (!CreateProcessW(null, command, IntPtr.Zero, IntPtr.Zero, true, 0x08080004, IntPtr.Zero, null, ref startup, out child)) {
                            int failure = Marshal.GetLastWin32Error(); child = new ProcessInfo(); throw new Win32Exception(failure);
                        }
                    } finally {
                        if (attributesReady) DeleteProcThreadAttributeList(startup.Attributes);
                        if (startup.Attributes != IntPtr.Zero) Marshal.FreeHGlobal(startup.Attributes);
                        if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
                    }
                    // The child cannot spawn anything before assignment succeeds.
                    Check(AssignProcessToJobObject(job, child.Process)); assigned = true;
                    if (WaitForSingleObject(owner, 0) != 258) throw new InvalidOperationException("MCP owner exited during spawn");
                    Check(ResumeThread(child.Thread) != 0xffffffff);
                    CloseHandle(child.Thread); child.Thread = IntPtr.Zero;
                    CloseHandle(input); input = IntPtr.Zero; CloseHandle(output); output = IntPtr.Zero; CloseHandle(error); error = IntPtr.Zero;
                    ReleaseProtocolHandles();
                    Thread relay = new Thread(() => RelayOutput(relayRead, relaySink)); relay.IsBackground = true;
                    relay.Start(); relayStarted = true;
                    IntPtr done = outputDone.SafeWaitHandle.DangerousGetHandle();
                    uint signaled = WaitForMultipleObjects(3, new IntPtr[] { child.Process, owner, done }, false, 0xffffffff);
                    // Background jobs can close stdout while continuing useful work.
                    // Protocol children retain their existing EOF retirement behavior.
                    if (signaled == 2 && backgroundJob && !outputFailed)
                        signaled = WaitForMultipleObjects(2, new IntPtr[] { child.Process, owner }, false, 0xffffffff);
                    if (signaled == 0) {
                        uint code; Check(GetExitCodeProcess(child.Process, out code));
                        // End inherited descendants, then drain every already-written byte.
                        Check(TerminateJobObject(job, 125));
                        uint drained = WaitForMultipleObjects(2, new IntPtr[] { done, owner }, false, 0xffffffff);
                        if (drained == 1 || outputFailed) return 125;
                        if (drained != 0) throw new Win32Exception(Marshal.GetLastWin32Error());
                        return unchecked((int)code);
                    }
                    if (signaled == 1) return 125;
                    if (signaled == 2) {
                        if (outputFailed) return 125;
                        // Stdio may close just before normal process termination. Give
                        // that exit a bounded chance to publish its original status.
                        if (WaitForSingleObject(child.Process, 100) == 0) {
                            uint code; Check(GetExitCodeProcess(child.Process, out code)); return unchecked((int)code);
                        }
                        return 0;
                    }
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                } catch (Exception failure) {
                    Console.Error.WriteLine("MCP process ownership failed: " + failure.Message); return 125;
                } finally {
                    if (job != IntPtr.Zero) { TerminateJobObject(job, 125); CloseHandle(job); }
                    if (child.Process != IntPtr.Zero) {
                        if (!assigned) TerminateProcess(child.Process, 125);
                        WaitForSingleObject(child.Process, 2000); CloseHandle(child.Process);
                    }
                    if (child.Thread != IntPtr.Zero) CloseHandle(child.Thread);
                    if (input != IntPtr.Zero) CloseHandle(input); if (output != IntPtr.Zero) CloseHandle(output); if (error != IntPtr.Zero) CloseHandle(error);
                    // Once started, the background relay owns its pipe handles. If the
                    // owner disappears during a blocked write, process exit closes them.
                    if (!relayStarted) { if (relayRead != IntPtr.Zero) CloseHandle(relayRead); if (relaySink != IntPtr.Zero) CloseHandle(relaySink); }
                    if (owner != IntPtr.Zero) CloseHandle(owner);
                }
            }
        }
        """;
    private static Path mcpWindowsJobExe;
    private static final Set<Path> mcpWindowsJobRequests = ConcurrentHashMap.newKeySet();
    private static void cleanupWindowsMcpJob() {
        Path executable;
        synchronized (mcpOwnershipLock) { executable = mcpWindowsJobExe; }
        if (executable == null) return;
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
        boolean interrupted = Thread.interrupted();
        try {
            while (true) {
                try {
                    for (Path request : mcpWindowsJobRequests) { Files.deleteIfExists(request); mcpWindowsJobRequests.remove(request); }
                    Files.deleteIfExists(executable);
                    Files.deleteIfExists(executable.getParent().resolve("owner.cs"));
                    Files.deleteIfExists(executable.getParent());
                    return;
                } catch (IOException error) {
                    // Windows may briefly retain an executable image lock after
                    // process exit. deleteOnExit alone has no retry for that case.
                    if (System.nanoTime() >= deadline) {
                        System.err.println("[mcp] Windows process owner cleanup failed: " + error.getMessage());
                        return;
                    }
                    try { Thread.sleep(25); } catch (InterruptedException ignored) { interrupted = true; }
                }
            }
        } finally { if (interrupted) Thread.currentThread().interrupt(); }
    }
    private static Path windowsMcpJobHelper() throws IOException {
        // Serialized by mcpOwnershipLock; no fallback to an uncontained spawn.
        if (mcpWindowsJobExe != null) return mcpWindowsJobExe;
        Path directory = Files.createTempDirectory("code-mcp-job-");
        Path source = directory.resolve("owner.cs"), executable = directory.resolve("owner.exe");
        // Reverse deletion order runs after application shutdown hooks.
        directory.toFile().deleteOnExit();
        source.toFile().deleteOnExit();
        executable.toFile().deleteOnExit();
        Process compiler = null;
        boolean success = false;
        try {
            Files.writeString(source, MCP_WINDOWS_JOB_SOURCE, StandardCharsets.UTF_8);
            String script = "$ErrorActionPreference='Stop'; Add-Type -TypeDefinition ([IO.File]::ReadAllText('"
                + source.toString().replace("'", "''") + "')) -OutputAssembly '"
                + executable.toString().replace("'", "''") + "' -OutputType ConsoleApplication";
            String powershell = Path.of(System.getenv().getOrDefault("SystemRoot", "C:\\Windows"),
                "System32", "WindowsPowerShell", "v1.0", "powershell.exe").toString();
            ProcessBuilder build = new ProcessBuilder(powershell, "-NoProfile", "-NonInteractive", "-EncodedCommand",
                Base64.getEncoder().encodeToString(script.getBytes(StandardCharsets.UTF_16LE)));
            scrubEnv(build);
            build.directory(directory.toFile()).redirectOutput(ProcessBuilder.Redirect.DISCARD).redirectError(ProcessBuilder.Redirect.DISCARD);
            compiler = build.start();
            compiler.getOutputStream().close();
            if (!compiler.waitFor(10, TimeUnit.SECONDS)) throw new IOException("Windows MCP process owner compilation timed out");
            if (compiler.exitValue() != 0 || !Files.isRegularFile(executable)) throw new IOException("Windows MCP process owner compilation failed");
            mcpWindowsJobExe = executable;
            success = true;
            return executable;
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IOException("Windows MCP process owner compilation interrupted", error);
        } finally {
            if (compiler != null && compiler.isAlive()) {
                boolean interrupted = Thread.interrupted();
                try { terminateJobTree(compiler, 0, System.nanoTime() + TimeUnit.SECONDS.toNanos(3)); }
                catch (InterruptedException error) { interrupted = true; }
                finally { if (interrupted) Thread.currentThread().interrupt(); }
            }
            if (!success) {
                try { Files.deleteIfExists(executable); Files.deleteIfExists(source); Files.deleteIfExists(directory); }
                catch (IOException ignored) { /* deleteOnExit retries owned paths */ }
            }
        }
    }

    private static final Object mcpOwnershipLock = new Object();
    private static final Set<Process> mcpOwnedStdio = ConcurrentHashMap.newKeySet();
    private static Process startMcpStdio(ProcessBuilder builder) throws IOException {
        return startOwnedProcess(builder, false);
    }
    private static final Object windowsRootOwnerLock = new Object();
    private static Process windowsRootOwner;
    private static void ensureWindowsRootOwner() throws IOException {
        if (!isWindows) return;
        synchronized (windowsRootOwnerLock) {
            if (shuttingDown) throw new IOException("server is shutting down");
            if (windowsRootOwner != null) {
                if (!windowsRootOwner.isAlive()) throw new IOException("Windows root process owner exited");
                return;
            }
            Path helper;
            synchronized (mcpOwnershipLock) { helper = windowsMcpJobHelper(); }
            String powershell = Path.of(System.getenv().getOrDefault("SystemRoot", "C:\\Windows"),
                "System32", "WindowsPowerShell", "v1.0", "powershell.exe").toString();
            String script = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; "
                + "Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:CODE_MCP_OWNER_SOURCE)); "
                + "[CodeMcpWindowsJob]::GuardRoot([uint32]$env:CODE_MCP_OWNER_PID)";
            ProcessBuilder builder = new ProcessBuilder(powershell, "-NoProfile", "-NonInteractive", "-Command", script);
            builder.directory(Path.of(powershell).getParent().toFile());
            scrubEnv(builder);
            builder.environment().put("CODE_MCP_OWNER_SOURCE", helper.resolveSibling("owner.cs").toString());
            builder.environment().put("CODE_MCP_OWNER_PID", Long.toString(ProcessHandle.current().pid()));
            builder.redirectError(ProcessBuilder.Redirect.DISCARD);
            Process guard = builder.start(); guard.getOutputStream().close();
            CompletableFuture<String> ready = CompletableFuture.supplyAsync(() -> {
                try (var input = new BufferedReader(new InputStreamReader(guard.getInputStream(), StandardCharsets.UTF_8))) {
                    return input.readLine();
                } catch (IOException error) { throw new CompletionException(error); }
            });
            try {
                if (!"CODE_MCP_ROOT_READY".equals(ready.get(15, TimeUnit.SECONDS)))
                    throw new IOException("Windows root process owner did not become ready");
                windowsRootOwner = guard;
            } catch (Exception error) {
                terminateShellProcess(guard);
                if (error instanceof InterruptedException) Thread.currentThread().interrupt();
                throw new IOException("Windows root process owner failed to start", error);
            }
        }
    }

    private static Process startOwnedProcess(ProcessBuilder builder, boolean backgroundJob) throws IOException {
        return startOwnedProcess(builder, backgroundJob, null);
    }
    private static Process startOwnedProcess(ProcessBuilder builder, boolean backgroundJob, String rawCommand) throws IOException {
        synchronized (mcpOwnershipLock) {
            if (shuttingDown) throw new IOException("server is shutting down");
            if (System.getProperty("os.name").toLowerCase(Locale.ROOT).startsWith("windows")) {
                Path helper = windowsMcpJobHelper();
                if (shuttingDown) throw new IOException("server is shutting down");
                for (String argument : builder.command()) if (argument.indexOf(0) >= 0) throw new IOException("MCP argument contains NUL");
                List<String> command = rawCommand == null ? new ArrayList<>(builder.command()) : List.of(rawCommand);
                byte[] arguments = String.join("\0", command).getBytes(StandardCharsets.UTF_8);
                if (arguments.length > 262144) throw new IOException("MCP argument file exceeds limit");
                Path request = Files.createTempFile(helper.getParent(), "argv-", ".bin");
                mcpWindowsJobRequests.add(request);
                try {
                    Files.write(request, arguments);
                    builder.command(helper.toString(), Long.toString(ProcessHandle.current().pid()), backgroundJob ? "job" : "stdio", rawCommand == null ? "file" : "raw-file", request.toString());
                    Process proc = builder.start();
                    if (!backgroundJob) mcpOwnedStdio.add(proc);
                    // The helper deletes after reading; also cover a spawn
                    // cancelled before it can open the request file.
                    proc.onExit().thenRun(() -> { try { Files.deleteIfExists(request); mcpWindowsJobRequests.remove(request); } catch (IOException ignored) {} });
                    return proc;
                } catch (IOException | RuntimeException error) {
                    Files.deleteIfExists(request);
                    mcpWindowsJobRequests.remove(request);
                    throw error;
                }
            }
            Process proc = builder.start();
            if (!backgroundJob) mcpOwnedStdio.add(proc);
            return proc;
        }
    }
    private static void releaseMcpStdio(Process proc) {
        mcpIdleRetire(proc);
        // A slow OS spawn must not delay another connection's cleanup.
        mcpOwnedStdio.remove(proc);
    }

    private static final Semaphore mcpStdioSlots = new Semaphore(16, true);
    private static final Semaphore mcpStdioAdmission = new Semaphore(80);
    private static final Map<Process, McpStdioConnection> mcpStdioConnections = Collections.synchronizedMap(new WeakHashMap<>());

    private static final class McpStdioWaiter {
        final long deadline;
        final boolean notification;
        final CompletableFuture<Map<?, ?>> result = new CompletableFuture<>();
        McpStdioWaiter(long deadline, boolean notification) { this.deadline = deadline; this.notification = notification; }
    }
    private record McpStdioWrite(byte[] payload, long deadline, Integer notificationId, boolean control, long sequence)
            implements Comparable<McpStdioWrite> {
        public int compareTo(McpStdioWrite other) {
            int priority = Boolean.compare(other.control, control);
            return priority != 0 ? priority : Long.compare(sequence, other.sequence);
        }
    }
    private static final class McpStdioConnection {
        // Do not keep a strong value-to-key reference in the weak process map.
        final java.lang.ref.WeakReference<Process> process;
        final Map<Integer, McpStdioWaiter> pending = new HashMap<>();
        final PriorityBlockingQueue<McpStdioWrite> writes = new PriorityBlockingQueue<>();
        volatile boolean closed;
        final CompletableFuture<Void> terminated = new CompletableFuture<>();
        IOException failure;
        long sequence;
        int writeBytes, writeCount;
        final Thread reader, writer;

        McpStdioConnection(Process proc) {
            process = new java.lang.ref.WeakReference<>(proc);
            reader = Thread.ofVirtual().name("mcp-stdio-reader").unstarted(this::read);
            writer = Thread.ofVirtual().name("mcp-stdio-writer").unstarted(this::write);
            try { writer.start(); reader.start(); }
            catch (RuntimeException error) {
                close(new IOException("MCP stdio reader/writer failed to start", error));
                throw error;
            }
        }

        void close(IOException error) {
            synchronized (this) {
                if (closed) return;
                closed = true;
                failure = error;
                for (McpStdioWaiter waiter : pending.values()) waiter.result.completeExceptionally(error);
                pending.clear();
                writes.clear();
                writeBytes = 0;
                writeCount = 0;
            }
            Process proc = process.get();
            try { if (proc != null) terminateShellProcess(proc); }
            finally {
                terminated.complete(null);
                if (proc != null) releaseMcpStdio(proc);
            }
            reader.interrupt();
            writer.interrupt();
            // Each I/O owner closes its own streams after process termination
            // unblocks native Windows reads/writes. Never acquire a pipe lock
            // in a caller whose request deadline has already expired.
        }

        synchronized void enqueue(byte[] payload, long deadline, Integer notificationId, boolean control) throws IOException {
            if (closed) throw failure;
            if (payload.length > MAX_MCP_STDIO_FRAME_BYTES) throw new IOException("MCP stdio frame exceeds 16 MiB");
            // Charge the active write as well as pending queue entries.
            if (writeCount >= 64 || writeBytes + payload.length > MAX_MCP_STDIO_FRAME_BYTES)
                throw new IOException("MCP stdio write queue capacity exceeded");
            writes.add(new McpStdioWrite(payload, deadline, notificationId, control, ++sequence));
            writeBytes += payload.length;
            writeCount++;
        }

        synchronized void complete(int id, Map<?, ?> value, IOException error) {
            McpStdioWaiter waiter = pending.remove(id);
            if (waiter == null) return;
            if (System.nanoTime() >= waiter.deadline)
                waiter.result.completeExceptionally(new TimeoutException("MCP stdio deadline exceeded"));
            else if (error != null) waiter.result.completeExceptionally(error);
            else waiter.result.complete(value);
        }

        void reply(Object value) throws IOException {
            enqueue((toJson(value) + "\n").getBytes(StandardCharsets.UTF_8), System.nanoTime() + TimeUnit.SECONDS.toNanos(30), null, true);
        }

        synchronized boolean expectsResponse(Object id) {
            return id instanceof Number number && number.doubleValue() == number.intValue() && pending.containsKey(number.intValue());
        }

        void dispatchResponse(Map<String, Object> response) {
            Object id = response.get("id");
            if (!(id instanceof Number number) || number.doubleValue() != number.intValue()) return;
            int requestId = number.intValue();
            synchronized (this) {
                McpStdioWaiter waiter = pending.get(requestId);
                // Only the writer can acknowledge notification flushes.
                if (waiter == null || waiter.notification) return;
            }
            try { complete(requestId, mcpRpcResult(response, requestId), null); }
            catch (IOException error) { complete(requestId, null, error); }
        }

        void read() {
            Process proc = process.get();
            try {
                if (proc == null) throw new EOFException("MCP server process ended");
                McpStdioLineReader input = new McpStdioLineReader(proc.getInputStream());
                while (!closed) {
                    String line = input.readLine();
                    if (line == null) throw new EOFException("MCP server process ended");
                    if (line.isBlank()) continue;
                    Object payload;
                    try { payload = parseJsonValue(line); }
                    catch (JsonDepthException | JsonNumberException excessive) { throw excessive; }
                    catch (RuntimeException malformed) { continue; }
                    // Ordinary messages avoid batch lists and ID-set allocation.
                    if (!(payload instanceof List<?>)) {
                        if (!(payload instanceof Map<?, ?>)) continue;
                        @SuppressWarnings("unchecked")
                        Map<String, Object> response = (Map<String, Object>) payload;
                        if (response.containsKey("method")) {
                            if (!mcpIsNotification(response)) reply(mcpServerRequest(response));
                        } else dispatchResponse(response);
                        continue;
                    }
                    List<?> messages = mcpBatchMessages(payload);
                    List<Map<String, Object>> replies = new ArrayList<>(), responses = new ArrayList<>();
                    for (Object item : messages) {
                        if (!(item instanceof Map<?, ?>)) {
                            replies.add(mcpServerRequest(Map.of()));
                            continue;
                        }
                        @SuppressWarnings("unchecked")
                        Map<String, Object> response = (Map<String, Object>) item;
                        if (response.containsKey("method")) {
                            if (!mcpIsNotification(response)) replies.add(mcpServerRequest(response));
                        } else if (response.containsKey("result") || response.containsKey("error") || expectsResponse(response.get("id"))) {
                            responses.add(response);
                        } else replies.add(mcpServerRequest(response));
                    }
                    if (messages.isEmpty()) reply(mcpServerRequest(Map.of()));
                    else if (!replies.isEmpty()) reply(replies);
                    for (Map<String, Object> response : responses) dispatchResponse(response);
                }
            } catch (Exception error) {
                close(error instanceof IOException io ? io : new IOException("MCP stdio read failed", error));
            } finally {
                if (closed) terminated.join();
                if (proc != null) {
                    try { proc.getInputStream().close(); } catch (IOException ignored) {}
                    try { proc.getErrorStream().close(); } catch (IOException ignored) {}
                }
            }
        }

        void write() {
            Process proc = process.get();
            try {
                if (proc == null) throw new EOFException("MCP server process ended");
                while (!closed) {
                    McpStdioWrite job = writes.take();
                    if (closed) break;
                    long remaining = job.deadline() - System.nanoTime();
                    if (remaining <= 0) throw new IOException("MCP stdio write deadline exceeded");
                    // Virtual timer sleeps cheaply and also bounds replies to
                    // server requests when there is no active outbound call.
                    Thread timer = Thread.ofVirtual().name("mcp-stdio-write-deadline").start(() -> {
                        try {
                            TimeUnit.NANOSECONDS.sleep(Math.max(0, job.deadline() - System.nanoTime()));
                            close(new IOException("MCP stdio write deadline exceeded"));
                        } catch (InterruptedException cancelled) { /* write completed */ }
                    });
                    try {
                        if (closed) break;
                        proc.getOutputStream().write(job.payload());
                        proc.getOutputStream().flush();
                        if (job.notificationId() != null) complete(job.notificationId(), Map.of(), null);
                    } finally {
                        timer.interrupt();
                        synchronized (this) {
                            if (!closed) { writeBytes -= job.payload().length; writeCount--; }
                        }
                    }
                }
            } catch (Exception error) {
                close(error instanceof IOException io ? io : new IOException("MCP stdio write failed", error));
            } finally {
                if (closed) terminated.join();
                if (proc != null) try { proc.getOutputStream().close(); } catch (IOException ignored) {}
            }
        }

        Map<?, ?> call(int id, String method, Map<String, Object> params, long deadline) throws IOException {
            boolean notification = method.startsWith("notifications/");
            Map<String, Object> request = new LinkedHashMap<>();
            request.put("jsonrpc", "2.0");
            if (!notification) request.put("id", id);
            request.put("method", method);
            request.put("params", params);
            byte[] payload = (toJson(request) + "\n").getBytes(StandardCharsets.UTF_8);
            McpStdioWaiter waiter = new McpStdioWaiter(deadline, notification);
            synchronized (this) {
                if (closed) throw failure;
                pending.put(id, waiter);
            }
            try {
                enqueue(payload, deadline, notification ? id : null, false);
                return waiter.result.get(Math.max(0, deadline - System.nanoTime()), TimeUnit.NANOSECONDS);
            } catch (TimeoutException | InterruptedException error) {
                IOException failure = new IOException("MCP stdio deadline exceeded or interrupted", error);
                close(failure);
                if (error instanceof InterruptedException) Thread.currentThread().interrupt();
                throw failure;
            } catch (ExecutionException error) {
                IOException failure = new IOException("MCP stdio failed: " + error.getCause().getMessage(), error.getCause());
                if (error.getCause() instanceof TimeoutException) close(failure);
                throw failure;
            } finally {
                synchronized (this) { pending.remove(id); }
            }
        }
    }

    private static void closeMcpStdio(Process proc, String reason) {
        mcpIdleRetire(proc);
        McpStdioConnection connection = mcpStdioConnections.get(proc);
        if (connection != null) {
            connection.close(new IOException(reason));
            connection.terminated.join();
        } else {
            try {
                terminateShellProcess(proc);
                try { proc.getOutputStream().close(); } catch (IOException ignored) {}
                try { proc.getInputStream().close(); } catch (IOException ignored) {}
                try { proc.getErrorStream().close(); } catch (IOException ignored) {}
            } finally { releaseMcpStdio(proc); }
        }
    }

    private static boolean mcpStdioClosed(Process proc) {
        if (mcpIdleRetired(proc)) return true;
        McpStdioConnection connection = mcpStdioConnections.get(proc);
        return connection != null && connection.closed;
    }

    private static Map<?, ?> stdioExchange(Process proc, String method, Map<String, Object> params, long timeoutMs) throws IOException {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs);
        if (timeoutMs <= 0) throw new IOException("MCP setup deadline exceeded");
        if (!mcpStdioAdmission.tryAcquire()) throw new IOException("MCP stdio call capacity exceeded");
        try {
            try {
                if (!mcpStdioSlots.tryAcquire(Math.max(0, deadline - System.nanoTime()), TimeUnit.NANOSECONDS))
                    throw new IOException("MCP stdio capacity deadline exceeded");
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new IOException("MCP stdio interrupted", error);
            }
            try {
                final int reqId;
                synchronized (mcpIdLock) { reqId = ++mcpNextId; }
                McpStdioConnection connection;
                synchronized (mcpStdioConnections) {
                    connection = mcpStdioConnections.computeIfAbsent(proc, McpStdioConnection::new);
                }
                Map<?, ?> result = connection.call(reqId, method, params, deadline);
                if (method.equals("initialize")) mcpNegotiatedVersion(result);
                return result;
            } finally { mcpStdioSlots.release(); }
        } finally { mcpStdioAdmission.release(); }
    }

    private static Map<?, ?> mcpCall(String key, Process proc, String method, Map<String, Object> params) throws Exception {
        return mcpCall(key, proc, method, params, mcpHttpTimeoutMillis(method));
    }

    private static Map<?, ?> mcpCall(String key, Process proc, String method, Map<String, Object> params, long timeoutMs) throws Exception {
        if (mcpProcesses.get(key) != proc) throw new IOException("MCP server was unloaded during request");
        Map<?, ?> result = stdioExchange(proc, method, params, timeoutMs);
        if (mcpProcesses.get(key) != proc) throw new IOException("MCP server was unloaded during request");
        return result;
    }

    private static String toJson(Object obj) {
        if (obj == null) return "null";
        if (obj instanceof String) return "\"" + escapeJson((String) obj) + "\"";
        if (obj instanceof Boolean) return String.valueOf(obj);
        if (obj instanceof Number) {
            // Avoid NaN/Infinity which are not valid JSON.
            Number n = (Number) obj;
            if (n instanceof Double || n instanceof Float) {
                double d = n.doubleValue();
                if (Double.isNaN(d) || Double.isInfinite(d)) return "null";
            }
            return n.toString();
        }
        if (obj instanceof List) {
            List<?> list = (List<?>) obj;
            StringBuilder sb = new StringBuilder("[");
            String sep = "";
            for (Object item : list) {
                sb.append(sep).append(toJson(item));
                sep = ",";
            }
            return sb.append("]").toString();
        }
        if (obj instanceof Map) {
            Map<?, ?> map = (Map<?, ?>) obj;
            StringBuilder sb = new StringBuilder("{");
            String sep = "";
            for (Map.Entry<?, ?> e : map.entrySet()) {
                sb.append(sep).append("\"").append(escapeJson(String.valueOf(e.getKey()))).append("\":").append(toJson(e.getValue()));
                sep = ",";
            }
            return sb.append("}").toString();
        }
        return "\"" + escapeJson(String.valueOf(obj)) + "\"";
    }

    // --- preview tool ---
    private static String previewPolicyHost(String value) {
        // Decode policy aliases without turning a literal '+' into a space.
        String host = java.net.URLDecoder.decode(value.replace("+", "%2B"), StandardCharsets.UTF_8).toLowerCase(Locale.ROOT);
        if (host.indexOf('%') >= 0 || host.indexOf('\ufffd') >= 0) throw new IllegalArgumentException("invalid host encoding");
        if (host.indexOf(':') < 0) {
            host = java.net.IDN.toASCII(host).toLowerCase(Locale.ROOT).replaceAll("\\.+$", "");
            if (host.isEmpty() || host.chars().anyMatch(c -> c <= 32 || c == 127 || "#%/:<>?@[\\]^|".indexOf(c) >= 0))
                throw new IllegalArgumentException("invalid host character");
        }
        if (host.indexOf(':') >= 0) {
            try { return java.net.InetAddress.getByName(host.replace("[", "").replace("]", "")).getHostAddress(); }
            catch (Exception error) { throw new IllegalArgumentException("invalid IPv6 address", error); }
        }
        String[] parts = host.split("\\.", -1);
        if (Arrays.stream(parts).allMatch(part -> part.matches("(?:0[xX][0-9a-fA-F]+|[0-9]+)"))) {
            if (parts.length > 4) throw new IllegalArgumentException("invalid IPv4 address");
            long address = 0;
            for (int i = 0; i < parts.length; i++) {
                String part = parts[i];
                boolean hex = part.toLowerCase(Locale.ROOT).startsWith("0x");
                long number = Long.parseLong(hex ? part.substring(2) : part, hex ? 16 : part.length() > 1 && part.charAt(0) == '0' ? 8 : 10);
                long bound = i == parts.length - 1 ? 1L << (8 * (5 - parts.length)) : 256;
                if (number < 0 || number >= bound) throw new IllegalArgumentException("invalid IPv4 address");
                address += number << (i == parts.length - 1 ? 0 : 8 * (3 - i));
            }
            return (address >>> 24 & 255) + "." + (address >>> 16 & 255) + "." + (address >>> 8 & 255) + "." + (address & 255);
        }
        return host;
    }

    @SuppressWarnings("removal")
    private static String previewProcessUrl(String url) {
        if (!isWindows || url.indexOf('"') < 0) return url;
        // Windows JDK legacy launching does not escape embedded quotes. Its
        // safe mode does, so preserve its normal argument processing instead.
        // URL validation excludes backslashes, keeping this escape scoped.
        boolean legacy = !"false".equalsIgnoreCase(System.getProperty(
                "jdk.lang.Process.allowAmbiguousCommands",
                System.getSecurityManager() == null ? "true" : "false"));
        return legacy ? "\"" + url.replace("\"", "\\\"") + "\"" : url;
    }

    private static String handlePreview(String url) {
        if (!hasCloudflared) throw new RuntimeException("cloudflared not found on PATH");
        if (url == null || url.isEmpty()) throw new IllegalArgumentException("url required");
        if (url.chars().anyMatch(c -> c <= 32 || c == 127 || c == '\\')
                || Pattern.compile("%(?![0-9a-fA-F]{2})").matcher(url).find()
                || !Pattern.compile("^https?://", Pattern.CASE_INSENSITIVE).matcher(url).find())
            throw new IllegalArgumentException("invalid http(s) url");
        java.net.URL parsed;
        try { parsed = new java.net.URL(url); }
        catch (java.net.MalformedURLException error) { throw new IllegalArgumentException("invalid http(s) url", error); }
        if (parsed.getHost().isEmpty() || parsed.getPort() > 65535 || parsed.getPort() < -1)
            throw new IllegalArgumentException("invalid http(s) url");
        String authority = parsed.getAuthority();
        String hostPort = authority.substring(authority.lastIndexOf('@') + 1);
        int portSeparator = hostPort.startsWith("[") ? hostPort.indexOf(']') + 1 : hostPort.lastIndexOf(':');
        if (portSeparator >= 0 && portSeparator < hostPort.length()
                && hostPort.charAt(portSeparator) == ':'
                && !hostPort.substring(portSeparator + 1).matches("[0-9]*"))
            throw new IllegalArgumentException("invalid http(s) url");
        String host = previewPolicyHost(parsed.getHost());
        // Known host names/literals only; this is not a DNS-rebinding boundary.
        if (host.equals("169.254.169.254") || host.equals("metadata.google.internal") || host.equals("metadata") || host.endsWith(".internal"))
            throw new IllegalArgumentException("url targets a protected host");
        Job job = startJobArgv(new String[]{"cloudflared", "tunnel", "--url", previewProcessUrl(url), "--no-autoupdate"},
                "cloudflared tunnel --url " + url + " --no-autoupdate", System.getProperty("user.dir"));
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        // A capture can end mid-hostname; wait for an actual log delimiter.
        Pattern pattern = Pattern.compile("https://[a-z0-9-]+\\.trycloudflare\\.com(?=[\\s|])", Pattern.CASE_INSENSITIVE);
        try {
            while (System.nanoTime() < deadline) {
                if (!job.process.isAlive()) throw new RuntimeException("cloudflared exited (job " + job.id + ")");
                Matcher match = pattern.matcher(job.currentOutput());
                if (match.find()) return match.group() + " (job " + job.id + ")";
                Thread.sleep(250);
            }
            throw new RuntimeException("timeout waiting for tunnel URL (job " + job.id + ")");
        } catch (Exception failure) {
            boolean interrupted = failure instanceof InterruptedException;
            interrupted |= Thread.interrupted();
            try { stopOwnedJob(job, 0); }
            catch (Exception cleanup) {
                interrupted |= cleanup instanceof InterruptedException;
                failure.addSuppressed(cleanup);
                throw new RuntimeException(failure.getMessage() + "; cleanup failed for " + job.id + ": " + cleanup.getMessage(), failure);
            } finally { if (interrupted) Thread.currentThread().interrupt(); }
            throw new RuntimeException(failure.getMessage(), failure);
        }
    }

    // --- memory tools (remember/forget/recall) ---
    private static String memoFailureMessage(Throwable failure) {
        String message = failure.getMessage();
        return message == null || message.isBlank() ? failure.getClass().getSimpleName() : message;
    }

    private static String handleRemember(String cwd, String memo, List<String> tags) throws IOException {
        List<String> cleanTags = sanitizeTags(tags);
        MemoLock lockPath = acquireMemoLock(cwd);
        long savedId = 0;
        long attemptedId = 0;
        Throwable operationFailure = null;
        try {
            MemoAppendState state = readMemoAppendState(cwd);
            long previous = state.highest;
            if (previous >= 9007199254740991L) throw new IOException("memo ID space exhausted");
            long id = previous + 1;
            Memo m = new Memo(id, System.currentTimeMillis(), memo, cleanTags);
            byte[] data = (state.separator + memoToJsonLine(m) + "\n").getBytes(StandardCharsets.UTF_8);
            if (state.size + data.length > MAX_READ_BYTES) throw new IOException("memo storage exceeds 100 MiB limit");
            Path path = Path.of(cwd, ".memo.jsonl");
            requireMemoSnapshot(path, state.snapshot);
            Set<OpenOption> options = memoOpenOptions(StandardOpenOption.WRITE, StandardOpenOption.APPEND, LinkOption.NOFOLLOW_LINKS);
            if (state.snapshot == null) options.add(StandardOpenOption.CREATE_NEW);
            FileChannel ch = FileChannel.open(path, options);
            Throwable appendFailure = null;
            try {
                MemoStorageSnapshot opened = memoStorageSnapshot(path);
                if (opened == null || (state.snapshot != null && !state.snapshot.equals(opened))
                        || (state.snapshot == null && opened.size != 0) || ch.size() != opened.size)
                    throw new IOException("memo storage changed during append preparation");
                attemptedId = id;
                try {
                    ByteBuffer buffer = ByteBuffer.wrap(data);
                    while (buffer.hasRemaining()) {
                        if (ch.write(buffer) <= 0) throw new IOException("incomplete memo write");
                    }
                    ch.force(true);
                } catch (IOException | RuntimeException failure) {
                    try { rollbackMemoAppend(ch, path, opened, state.size, data); }
                    catch (IOException | RuntimeException recovery) {
                        failure.addSuppressed(recovery);
                        throw new IOException("append failed: " + memoFailureMessage(failure) + "; recovery failed: " + memoFailureMessage(recovery), failure);
                    }
                    attemptedId = 0;
                    throw new IOException("memory append failed; appended bytes removed: " + memoFailureMessage(failure), failure);
                }
            } catch (IOException | RuntimeException failure) {
                appendFailure = failure;
                throw failure;
            } finally {
                try { ch.close(); }
                catch (IOException | RuntimeException closing) {
                    if (appendFailure != null) {
                        appendFailure.addSuppressed(closing);
                        throw new IOException(memoFailureMessage(appendFailure) + "; close failed: " + memoFailureMessage(closing), appendFailure);
                    }
                    throw closing;
                }
            }
            savedId = id;
            return "remembered #" + id;
        } catch (IOException | RuntimeException failure) {
            if (attemptedId > 0) {
                IOException uncertain = new IOException("memory #" + attemptedId + " may be partially or fully stored. Inspect .memo.jsonl before retrying: " + memoFailureMessage(failure), failure);
                operationFailure = uncertain;
                throw uncertain;
            }
            operationFailure = failure;
            throw failure;
        } finally {
            try { releaseMemoLock(lockPath); }
            catch (IOException | RuntimeException cleanup) {
                if (savedId > 0) throw new IOException("remembered #" + savedId + "; lock cleanup failed: " + memoFailureMessage(cleanup) + ". Do not resend this memory.", cleanup);
                if (operationFailure != null) {
                    operationFailure.addSuppressed(cleanup);
                    throw new IOException("memory operation failed: " + operationFailure.getMessage() + "; lock cleanup failed: " + memoFailureMessage(cleanup), operationFailure);
                }
                throw cleanup;
            }
        }
    }

    private static String handleForget(String cwd, long memoId) throws IOException {
        MemoLock lockPath = acquireMemoLock(cwd);
        boolean attempted = false, saved = false;
        Exception operationFailure = null;
        try {
            Path path = Path.of(cwd, ".memo.jsonl");
            MemoStorageSnapshot snapshot = memoStorageSnapshot(path);
            if (snapshot == null) throw new IOException("no memo with id " + memoId);
            ExpectedWrite expected = new ExpectedWrite(path, writeState(path));
            requireMemoSnapshot(path, snapshot);
            String text = handleRead(cwd, path.toString(), null, true);
            requireMemoSnapshot(path, snapshot);
            if (!expected.state.equals(writeState(path))) throw new IOException("memo storage changed during read");
            StringBuilder kept = new StringBuilder();
            boolean removed = false;
            for (int start = 0; start < text.length();) {
                int newline = text.indexOf('\n', start), end = newline < 0 ? text.length() : newline + 1;
                String raw = text.substring(start, end);
                boolean matches = false;
                try { matches = parseMemo(raw).id == memoId; }
                catch (RuntimeException invalid) { /* Preserve malformed non-target records verbatim. */ }
                if (matches) removed = true; else kept.append(raw);
                start = end;
            }
            if (!removed) throw new IOException("no memo with id " + memoId);
            requireMemoSnapshot(path, snapshot);
            attempted = true;
            handleWrite(cwd, path.toString(), kept.toString(), expected, () -> requireMemoSnapshot(path, snapshot));
            saved = true;
            return "forgot #" + memoId;
        } catch (Exception failure) {
            operationFailure = attempted
                ? new IOException("forget #" + memoId + " may have completed. Inspect .memo.jsonl before retrying: " + memoFailureMessage(failure), failure)
                : failure;
            if (operationFailure instanceof IOException io) throw io;
            throw new IOException(memoFailureMessage(operationFailure), operationFailure);
        } finally {
            try { releaseMemoLock(lockPath); }
            catch (Exception cleanup) {
                if (saved) throw new IOException("forgot #" + memoId + "; lock cleanup failed: " + memoFailureMessage(cleanup) + ". Do not retry this deletion.", cleanup);
                if (operationFailure != null) {
                    IOException combined = new IOException(memoFailureMessage(operationFailure) + "; lock cleanup failed: " + memoFailureMessage(cleanup), operationFailure);
                    combined.addSuppressed(cleanup);
                    throw combined;
                }
                throw new IOException(memoFailureMessage(cleanup), cleanup);
            }
        }
    }

    private record RecallEntry(Memo memo, int ordinal) {}
    private record RecallSelection(int total, List<RecallEntry> entries) {}
    private record RecallPage(int total, List<Memo> page) {}

    private static RecallSelection scanRecall(String cwd, String query, Set<String> wanted, int capacity) throws IOException {
        Comparator<RecallEntry> order = (a, b) -> {
            int comparison = Long.compare(a.memo.id, b.memo.id);
            if (comparison == 0) comparison = Integer.compare(b.ordinal, a.ordinal);
            return comparison;
        };
        PriorityQueue<RecallEntry> heap = new PriorityQueue<>(Math.min(capacity, 1024), order);
        int[] total = {0};
        readMemoAppendState(cwd, memo -> {
            if (query != null && !memo.memo.toLowerCase(Locale.ROOT).contains(query)) return;
            if (wanted != null) {
                Set<String> actual = new HashSet<>();
                if (memo.tags != null) for (String tag : memo.tags) actual.add(tag.toLowerCase(Locale.ROOT));
                if (!actual.containsAll(wanted)) return;
            }
            RecallEntry entry = new RecallEntry(memo, total[0]++);
            if (heap.size() < capacity) heap.add(entry);
            else if (order.compare(entry, heap.peek()) > 0) { heap.poll(); heap.add(entry); }
        });
        return new RecallSelection(total[0], new ArrayList<>(heap));
    }

    private static RecallPage selectRecallPage(String cwd, String query, List<String> tags, int limit, long offset) throws IOException {
        String q = query != null && !query.isEmpty() ? query.toLowerCase(Locale.ROOT) : null;
        List<String> cleanTags = sanitizeTags(tags);
        Set<String> wanted = null;
        if (cleanTags != null) {
            wanted = new HashSet<>();
            for (String tag : cleanTags) wanted.add(tag.toLowerCase(Locale.ROOT));
        }
        // Keep deep pages to one scan: probing the tail then rescanning doubled latency.
        if (offset > 1000) {
            List<Memo> memos = new ArrayList<>();
            final Set<String> required = wanted;
            readMemoAppendState(cwd, memo -> {
                if (q != null && !memo.memo.toLowerCase(Locale.ROOT).contains(q)) return;
                if (required != null) {
                    Set<String> actual = new HashSet<>();
                    if (memo.tags != null) for (String tag : memo.tags) actual.add(tag.toLowerCase(Locale.ROOT));
                    if (!actual.containsAll(required)) return;
                }
                memos.add(memo);
            });
            memos.sort((a, b) -> Long.compare(b.id, a.id));
            int total = memos.size();
            if (offset >= total) return new RecallPage(total, List.of());
            return new RecallPage(total, memos.subList((int) offset, (int) Math.min(offset + limit, total)));
        }
        RecallSelection selected = scanRecall(cwd, q, wanted, (int) offset + limit);
        selected.entries.sort((a, b) -> {
            int comparison = Long.compare(b.memo.id, a.memo.id);
            return comparison != 0 ? comparison : Integer.compare(a.ordinal, b.ordinal);
        });
        if (offset >= selected.total) return new RecallPage(selected.total, List.of());
        List<Memo> page = selected.entries.subList((int) offset, Math.min((int) offset + limit, selected.entries.size()))
            .stream().map(entry -> entry.memo).collect(Collectors.toList());
        return new RecallPage(selected.total, page);
    }

    private static String handleRecall(String cwd, String query, List<String> tags, int limit, long offset) throws IOException {
        int lim = limit < 1 ? 20 : Math.min(limit, 1000);
        long off = offset < 0 ? 0 : offset;
        RecallPage selected = selectRecallPage(cwd, query, tags, lim, off);
        int total = selected.total;
        if (total == 0) return "(no matches)";
        if (off >= total) return "(no matches at offset=" + off + "; total=" + total + ")";
        List<Memo> page = selected.page;
        String body = page.stream()
            .map(m -> "#" + m.id + " " + formatMemoTs(m.ts) + (m.tags != null && !m.tags.isEmpty() ? " [" + String.join(",", m.tags) + "]" : "") + " " + m.memo)
            .collect(Collectors.joining("\n"));
        long end = off + page.size();
        String footer = "-- " + (off + 1) + "-" + end + " of " + total;
        if (end < total) footer += " (next: offset=" + end + ")";
        return body + "\n" + footer;
    }

    // --- get_upload_link tool ---
    private static String uploadWidget(String url) {
        return (
            "<div style=\"display: flex; flex-direction: column; gap: 12px; max-width: 560px;\"><div style=\"positio" +
            "n: relative;\"><pre style=\"margin: 0; padding: 12px 40px 12px 12px; background: var(--color-backgroun" +
            "d-secondary); border-radius: var(--border-radius-md); font-size: 12px; font-family: var(--font-mono)" +
            "; color: var(--color-text-primary); white-space: pre-wrap; overflow-wrap: anywhere;\">{UPLOAD_URL}</p" +
            "re><button type=\"button\" aria-label=\"Copy URL\" data-url=\"{UPLOAD_URL}\" style=\"position: absolute; to" +
            "p: 8px; right: 8px; width: 28px; height: 28px; padding: 0; display: inline-flex; align-items: center" +
            "; justify-content: center; color: var(--color-text-tertiary); background: transparent; border: none;" +
            " cursor: pointer; border-radius: 4px;\" onmouseover=\"this.style.background='var(--color-background-pr" +
            "imary)'; this.style.color='var(--color-text-primary)';\" onmouseout=\"this.style.background='transpare" +
            "nt'; this.style.color='var(--color-text-tertiary)';\" onclick=\"(function(b){var u=b.getAttribute('dat" +
            "a-url');var prev=b.innerHTML;var done=function(){b.innerHTML='<svg width=\\'14\\' height=\\'14\\' viewBo" +
            "x=\\'0 0 24 24\\' fill=\\'none\\' stroke=\\'currentColor\\' stroke-width=\\'2\\' stroke-linecap=\\'round\\' st" +
            "roke-linejoin=\\'round\\'><polyline points=\\'20 6 9 17 4 12\\'/></svg>';b.style.color='var(--color-text" +
            "-success)';setTimeout(function(){b.innerHTML=prev;b.style.color='var(--color-text-tertiary)';},1500)" +
            ";};if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(u).then(done" +
            ").catch(function(){});}else{var ta=document.createElement('textarea');ta.value=u;ta.style.cssText='p" +
            "osition:fixed;left:-9999px;';document.body.appendChild(ta);ta.select();try{document.execCommand('cop" +
            "y');done();}catch(e){}document.body.removeChild(ta);}})(this)\"><svg width=\"14\" height=\"14\" viewBox=\"" +
            "0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin" +
            "=\"round\" aria-hidden=\"true\"><rect x=\"9\" y=\"9\" width=\"13\" height=\"13\" rx=\"2\" ry=\"2\"/><path d=\"M5 15H4" +
            "a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1\"/></svg></button></div><a href=\"{UPLOAD_URL}\" targe" +
            "t=\"_blank\" rel=\"noopener\" style=\"display: inline-block; align-self: flex-start; font-family: var(--f" +
            "ont-sans); font-size: 14px; padding: 8px 16px; background: transparent; color: var(--color-text-prim" +
            "ary); border: 0.5px solid var(--color-border-secondary); border-radius: var(--border-radius-md); tex" +
            "t-decoration: none; cursor: pointer; transition: background 100ms ease, transform 100ms ease;\" onmou" +
            "seover=\"this.style.background='var(--color-background-secondary)'\" onmouseout=\"this.style.background" +
            "='transparent'\" onmousedown=\"this.style.transform='scale(0.98)'\" onmouseup=\"this.style.transform='sc" +
            "ale(1)'\">Open</a></div>"
        ).replace("{UPLOAD_URL}", xmlAttr(url));
    }

    private static String handleGetUploadLink() {
        String base = resolvedPublicBaseUrl();
        if (base == null) throw new RuntimeException("get_upload_link requires --public or --domain");
        if (token == null) throw new RuntimeException("get_upload_link requires --token");
        String sessionId = mintUploadSessionId();
        String url = base + "/upload/" + sessionId;
        return toJson(Map.of("url", url, "expiresInMinutes", 10, "widget", uploadWidget(url), "hint", "Render the `widget` HTML by calling visualize:show_widget. Also show the `url` as a markdown link as fallback."));
    }

    // ===== MCP HTTP ROUTE HANDLER =====
    private static boolean validMcpRequest(Object value) {
        if (!(value instanceof Map<?, ?> request) || !"2.0".equals(request.get("jsonrpc"))
                || !(request.get("method") instanceof String)) return false;
        Object id = request.get("id");
        return id == null || id instanceof String || id instanceof Number number && Double.isFinite(number.doubleValue());
    }

    private static class MCPRouteHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if ((exchange.getRequestMethod().equals("POST") || exchange.getRequestMethod().equals("OPTIONS"))
                    && exchange.getRequestURI().getPath().equals("/mcp")) {
                handleMcpRequest(exchange);
            } else {
                exchange.sendResponseHeaders(404, 0);
                exchange.close();
            }
        }

        // In-process JSON-RPC dispatch mirroring handleMcpRequest: used by the
        // gateway relay path so tunneled calls skip the local HTTP round trip.
        // Returns the response body string, or null for notifications.
        private static String handleMcpBody(String body) {
            boolean notification = false;
            try {
                Object parsed = parseJsonValue(body);
                if (!validMcpRequest(parsed)) return "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32600,\"message\":\"Invalid Request\"}}";
                @SuppressWarnings("unchecked")
                Map<String, Object> request = (Map<String, Object>) parsed;
                notification = !request.containsKey("id");
                String idStr = request.containsKey("id") ? toJson(request.get("id")) : "null";
                String method = (String) request.get("method");
                @SuppressWarnings("unchecked")
                Object paramsObj = request.get("params");
                if (paramsObj != null && !(paramsObj instanceof Map)) {
                    if (notification) return null;
                    return "{\"jsonrpc\":\"2.0\",\"id\":" + idStr + ",\"error\":{\"code\":-32602,\"message\":\"Invalid params: expected object\"}}";
                }
                Map<String, Object> params = (Map<String, Object>) paramsObj;
                if (method != null && method.startsWith("notifications/") && notification) {
                    return null; // notification - no response body
                }
                Object result = handleMcpMethod(method, params);
                if (notification) return null;
                if (result instanceof String && ((String) result).startsWith("ERROR")) {
                    String errMsg = (String) result;
                    int code = -32603;
                    if (errMsg.startsWith("ERROR:-32601:")) {
                        code = -32601;
                        errMsg = errMsg.substring("ERROR:-32601:".length()).trim();
                    } else if (errMsg.startsWith("ERROR:-32602:")) {
                        code = -32602;
                        errMsg = errMsg.substring("ERROR:-32602:".length()).trim();
                    }
                    return "{\"jsonrpc\":\"2.0\",\"id\":" + idStr + ",\"error\":{\"code\":" + code + ",\"message\":" + jsonQuote(errMsg) + "}}";
                }
                return "{\"jsonrpc\":\"2.0\",\"id\":" + idStr + ",\"result\":" + serializeResult(result) + "}";
            } catch (Exception e) {
                if (notification) return null;
                return "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32700,\"message\":" + jsonQuote(e.getMessage()) + "}}";
            }
        }

        private static boolean trustedAnonymousHost(String authority) {
            if (authority == null) return false;
            var match = Pattern.compile("^(\\[[0-9a-fA-F:.]+\\]|[a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?$").matcher(authority);
            if (!match.matches()) return false;
            if (match.group(2) != null) {
                int port = Integer.parseInt(match.group(2));
                if (port < 1 || port > 65535) return false;
            }
            String host = match.group(1).replace("[", "").replace("]", "").toLowerCase(Locale.ROOT);
            if (host.equals("localhost") || host.equals(bindAddr.toLowerCase(Locale.ROOT))) return true;
            // A colon guarantees an IPv6 literal, so this cannot perform DNS.
            if (host.contains(":")) {
                try { InetAddress.getByName(host); return true; }
                catch (Exception ignored) { return false; }
            }
            String[] octets = host.split("\\.", -1);
            if (octets.length != 4) return false;
            for (String octet : octets) {
                if (!octet.matches("0|[1-9][0-9]{0,2}") || Integer.parseInt(octet) > 255) return false;
            }
            return true;
        }

        private void handleMcpRequest(HttpExchange exchange) throws IOException {
            boolean authenticatedMode = token != null && !token.isEmpty();
            if (!authenticatedMode && (exchange.getRequestHeaders().containsKey("Origin")
                    || exchange.getRequestMethod().equals("OPTIONS"))) {
                writeJsonResponse(exchange, 403, "{\"error\":\"browser MCP access requires --token\"}");
                return;
            }
            Headers headers = exchange.getResponseHeaders();
            if (!authenticatedMode) {
                if (!trustedAnonymousHost(exchange.getRequestHeaders().getFirst("Host"))) {
                    writeJsonResponse(exchange, 403, "{\"error\":\"untrusted Host; configure --token for DNS aliases\"}");
                    return;
                }
                String contentType = exchange.getRequestHeaders().getFirst("Content-Type");
                if (contentType == null || !contentType.split(";", 2)[0].trim().equalsIgnoreCase("application/json")) {
                    writeJsonResponse(exchange, 415, "{\"error\":\"anonymous MCP requests require application/json\"}");
                    return;
                }
            }
            if (authenticatedMode) {
                headers.add("Access-Control-Allow-Origin", "*");
                headers.add("Access-Control-Allow-Methods", "POST, OPTIONS");
                headers.add("Access-Control-Allow-Headers", "Content-Type, Authorization");
            }

            if (exchange.getRequestMethod().equals("OPTIONS")) {
                exchange.sendResponseHeaders(204, -1);
                exchange.close();
                return;
            }

            // Token check (constant-time compare, supports ?token=… and Authorization: Bearer …)
            if (token != null) {
                String reqToken = parseQueryParam(exchange.getRequestURI(), "token");
                if (reqToken == null) {
                    String authHdr = exchange.getRequestHeaders().getFirst("Authorization");
                    if (authHdr != null && authHdr.startsWith("Bearer ")) {
                        reqToken = authHdr.substring(7).trim();
                    }
                }
                byte[] expected = token.getBytes(StandardCharsets.UTF_8);
                byte[] given = reqToken == null ? new byte[0] : reqToken.getBytes(StandardCharsets.UTF_8);
                if (!MessageDigest.isEqual(expected, given)) {
                    writeJsonResponse(exchange, 401, "{\"error\":\"unauthorized\"}");
                    return;
                }
            }

            // Cap request body size
            long contentLen = -1;
            String clHdr = exchange.getRequestHeaders().getFirst("Content-Length");
            if (clHdr != null) {
                try { contentLen = Long.parseLong(clHdr); } catch (NumberFormatException ignored) {}
            }
            if (contentLen > MAX_REQUEST_BYTES) {
                writeJsonResponse(exchange, 413, "{\"error\":\"request too large\"}");
                return;
            }
            String body = readBodyCapped(exchange, MAX_REQUEST_BYTES);

            String idStr;
            boolean notification = false;
            try {
                Object parsed = parseJsonValue(body);
                if (!validMcpRequest(parsed)) {
                    writeJsonResponse(exchange, 400, "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32600,\"message\":\"Invalid Request\"}}");
                    return;
                }
                @SuppressWarnings("unchecked")
                Map<String, Object> request = (Map<String, Object>) parsed;
                notification = !request.containsKey("id");
                idStr = request.containsKey("id") ? toJson(request.get("id")) : "null";
                String method = (String) request.get("method");
                @SuppressWarnings("unchecked")
                Object paramsObj = request.get("params");
                if (paramsObj != null && !(paramsObj instanceof Map)) {
                    if (notification) { writeNoContent(exchange); return; }
                    String response = "{\"jsonrpc\":\"2.0\",\"id\":" + idStr + ",\"error\":{\"code\":-32602,\"message\":\"Invalid params: expected object\"}}";
                    writeJsonResponse(exchange, 400, response);
                    return;
                }
                Map<String, Object> params = (Map<String, Object>) paramsObj;

                // Notifications have no id and expect no response body.
                if (method != null && method.startsWith("notifications/") && notification) {
                    exchange.sendResponseHeaders(204, -1);
                    exchange.close();
                    return;
                }

                Object result = handleMcpMethod(method, params);
                if (notification) { writeNoContent(exchange); return; }

                String response;
                if (result instanceof String && ((String) result).startsWith("ERROR")) {
                    String errMsg = (String) result;
                    int code = -32603;
                    if (errMsg.startsWith("ERROR:-32601:")) {
                        code = -32601;
                        errMsg = errMsg.substring("ERROR:-32601:".length()).trim();
                    } else if (errMsg.startsWith("ERROR:-32602:")) {
                        code = -32602;
                        errMsg = errMsg.substring("ERROR:-32602:".length()).trim();
                    }
                    response = "{\"jsonrpc\":\"2.0\",\"id\":" + idStr + ",\"error\":{\"code\":" + code + ",\"message\":" + jsonQuote(errMsg) + "}}";
                } else {
                    String resultJson = serializeResult(result);
                    response = "{\"jsonrpc\":\"2.0\",\"id\":" + idStr + ",\"result\":" + resultJson + "}";
                }
                writeJsonResponse(exchange, 200, response);
            } catch (Exception e) {
                if (notification) { writeNoContent(exchange); return; }
                String response = "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32700,\"message\":" + jsonQuote(e.getMessage()) + "}}";
                writeJsonResponse(exchange, 400, response);
            }
        }

        private static void writeNoContent(HttpExchange exchange) throws IOException {
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
        }

        private static void writeJsonResponse(HttpExchange exchange, int status, String body) throws IOException {
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json; charset=utf-8");
            exchange.sendResponseHeaders(status, bytes.length);
            OutputStream output = exchange.getResponseBody();
            try { output.write(bytes); }
            finally { closeHttpResponse(output); }
        }

        // A client that trickles bytes (slowloris) must not pin an HTTP thread
        // forever: run the body read under a watchdog that force-closes the
        // exchange after BODY_READ_TIMEOUT_MS (com.sun.net.httpserver exposes
        // no socket SO_TIMEOUT, so this is the portable guard).
        private static final long BODY_READ_TIMEOUT_MS = 120_000;

        private static String readBodyCapped(HttpExchange exchange, long maxBytes) throws IOException {
            Thread watchdog = new Thread(() -> {
                try { Thread.sleep(BODY_READ_TIMEOUT_MS); exchange.close(); }
                catch (InterruptedException ignored) {}
            });
            watchdog.setDaemon(true);
            watchdog.start();
            try {
                InputStream in = exchange.getRequestBody();
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                long total = 0;
                int n;
                while ((n = in.read(buf)) != -1) {
                    total += n;
                    if (total > maxBytes) throw new IOException("request body exceeds " + maxBytes + " bytes");
                    out.write(buf, 0, n);
                }
                return out.toString(StandardCharsets.UTF_8);
            } finally {
                watchdog.interrupt();
            }
        }

        private String parseQueryParam(URI uri, String param) {
            String query = uri.getRawQuery();
            if (query == null) return null;
            for (String pair : query.split("&")) {
                String[] kv = pair.split("=", 2);
                String key;
                try {
                    key = URLDecoder.decode(kv[0], StandardCharsets.UTF_8);
                } catch (Exception e) {
                    key = kv[0];
                }
                if (key.equals(param)) {
                    if (kv.length < 2) return "";
                    try {
                        return URLDecoder.decode(kv[1], StandardCharsets.UTF_8);
                    } catch (Exception e) {
                        return kv[1];
                    }
                }
            }
            return null;
        }

        private static String jsonQuote(String s) {
            if (s == null) return "\"\"";
            return "\"" + escapeJson(s) + "\"";
        }

        private static String serializeResult(Object result) {
            if (result == null) return "null";
            if (result instanceof String) {
                return "\"" + escapeJson((String) result) + "\"";
            }
            if (result instanceof List) {
                List<?> list = (List<?>) result;
                if (list.isEmpty()) return "[]";
                StringBuilder sb = new StringBuilder("[");
                for (int i = 0; i < list.size(); i++) {
                    sb.append(serializeResult(list.get(i)));
                    if (i < list.size() - 1) sb.append(",");
                }
                sb.append("]");
                return sb.toString();
            }
            if (result instanceof Map) {
                @SuppressWarnings("unchecked")
                Map<String, Object> map = (Map<String, Object>) result;
                if (map.isEmpty()) return "{}";
                StringBuilder sb = new StringBuilder("{");
                boolean first = true;
                for (Map.Entry<String, Object> e : map.entrySet()) {
                    if (!first) sb.append(",");
                    first = false;
                    sb.append("\"").append(escapeJson(e.getKey())).append("\":");
                    sb.append(serializeResult(e.getValue()));
                }
                sb.append("}");
                return sb.toString();
            }
            return String.valueOf(result);
        }

        private static Object handleMcpMethod(String method, Map<String, Object> params) {
            if (method == null) return "ERROR: missing method";
            // ID-less notifications are handled by the transport wrappers.
            if (method.equals("ping")) return Map.of();
            return switch (method) {
                case "initialize" -> Map.of(
                    "protocolVersion", "2024-11-05",
                    "capabilities", Map.of("tools", Map.of()),
                    "serverInfo", Map.of("name", "code-mcp", "version", "0.1.0")
                );
                case "tools/list" -> {
                    List<Map<String, Object>> tools = new ArrayList<>();
                    tools.add(makeTool("read", "Read a file. Optional line range [start,end] (1-indexed, inclusive). Pass no_truncate=true to disable output truncation.",
                        List.of(Map.of("name", "cwd", "type", "string", "required", true),
                               Map.of("name", "path", "type", "string", "required", true),
                               Map.of("name", "range", "type", "array", "minItems", 2, "maxItems", 2, "items", Map.of("type", "integer", "minimum", 1, "maximum", 9007199254740991L)),
                               Map.of("name", "no_truncate", "type", "boolean"))));

                    tools.add(makeTool("write", "Write/overwrite a file with the given content.",
                        List.of(Map.of("name", "cwd", "type", "string", "required", true),
                               Map.of("name", "path", "type", "string", "required", true),
                               Map.of("name", "content", "type", "string", "required", true))));
                    tools.add(makeTool("edit", "Replace old_str literally with new_str in a file. old_str must be nonempty and occur exactly once, including overlapping matches.",
                        List.of(Map.of("name", "cwd", "type", "string", "required", true),
                               Map.of("name", "path", "type", "string", "required", true),
                               Map.of("name", "old_str", "type", "string", "minLength", 1, "required", true),
                               Map.of("name", "new_str", "type", "string", "required", true))));
                    tools.add(makeTool("multi_edit", "Apply ordered edits after validating and staging the entire batch; atomically replace each file with guarded rollback on failure. Simultaneous multi-file visibility and crash atomicity are not guaranteed. Limited to 1000 edits and 100 MiB total original/working text.",
                        List.of(Map.of("name", "cwd", "type", "string", "required", true),
                               Map.of("name", "edits", "type", "array", "minItems", 1, "maxItems", 1000,
                                   "items", Map.of("type", "object", "required", List.of("path", "old_str", "new_str"),
                                       "properties", Map.of("path", Map.of("type", "string", "minLength", 1),
                                           "old_str", Map.of("type", "string", "minLength", 1), "new_str", Map.of("type", "string"))), "required", true))));

                    tools.add(switch (detectedShell) {
                        case BASH -> makeTool("bash", "Run a bash command. Returns combined stdout+stderr. If still running at 60s with no timeout_ms set, auto-detaches into the `job` tool (the return value carries the job id). Pass an explicit timeout_ms to force kill-on-timeout instead.",
                            List.of(Map.of("name", "cwd", "type", "string", "minLength", 1, "required", true),
                                   Map.of("name", "command", "type", "string", "required", true),
                                   Map.of("name", "timeout_ms", "type", "integer", "minimum", 1, "maximum", 2147483647)));
                        case SH -> makeTool("shell", "Run a POSIX sh command. Returns combined stdout+stderr. If still running at 60s with no timeout_ms set, auto-detaches into the `job` tool (the return value carries the job id). Pass an explicit timeout_ms to force kill-on-timeout instead.",
                            List.of(Map.of("name", "cwd", "type", "string", "minLength", 1, "required", true),
                                   Map.of("name", "command", "type", "string", "required", true),
                                   Map.of("name", "timeout_ms", "type", "integer", "minimum", 1, "maximum", 2147483647)));
                        case CMD -> makeTool("command", "Run a Windows CMD command. Returns combined stdout+stderr. If still running at 60s with no timeout_ms set, auto-detaches into the `job` tool (the return value carries the job id). Pass an explicit timeout_ms to force kill-on-timeout instead.",
                            List.of(Map.of("name", "cwd", "type", "string", "minLength", 1, "required", true),
                                   Map.of("name", "command", "type", "string", "required", true),
                                   Map.of("name", "timeout_ms", "type", "integer", "minimum", 1, "maximum", 2147483647)));
                        case POWERSHELL -> makeTool("powershell", "Run a PowerShell command. Returns combined stdout+stderr. If still running at 60s with no timeout_ms set, auto-detaches into the `job` tool (the return value carries the job id). Pass an explicit timeout_ms to force kill-on-timeout instead.",
                            List.of(Map.of("name", "cwd", "type", "string", "minLength", 1, "required", true),
                                   Map.of("name", "command", "type", "string", "required", true),
                                   Map.of("name", "timeout_ms", "type", "integer", "minimum", 1, "maximum", 2147483647)));
                    });

                    tools.add(makeTool("grep", "Search files by regex, preferring ripgrep. Windows fallback uses PowerShell/.NET; POSIX fallback uses grep ERE. Regex and ignore features may differ by backend. Windows fallback skips hidden, reparse and binary files by default; explicit targets or positive globs allow hidden files. Ignore files require ripgrep.",
                        List.of(Map.of("name", "cwd", "type", "string", "minLength", 1, "required", true),
                               Map.of("name", "pattern", "type", "string", "required", true),
                               Map.of("name", "path", "type", "string", "minLength", 1),
                               Map.of("name", "glob", "type", "string"))));

                    tools.add(makeTool("find", "Find regular files with case-sensitive globs (*, ?, [], {a,b}, **). Bare patterns match at any depth. Returns sorted cwd-relative paths. Prunes common noise directories unless explicitly named; dot names require include_hidden=true or an explicit dot component. Skips symlink/reparse entries during traversal. Search/output/complexity limits return errors; narrow the pattern or path (maximum 10000 results, 1000000 UTF-8 bytes, 100000 entries, 256 directory levels).",
                        List.of(Map.of("name", "cwd", "type", "string", "required", true),
                               Map.of("name", "pattern", "type", "string", "required", true),
                               Map.of("name", "path", "type", "string"),
                               Map.of("name", "include_hidden", "type", "boolean"))));

                    tools.add(makeTool("ls", "List one directory, including hidden entries. Sorted lines contain type, byte size and name: '-' file, 'd' directory, 'l' link (target metadata is not followed), '?' unavailable or unsupported metadata. Directory/link sizes are 0. Errors above 100000 entries or 1000000 UTF-8 output bytes.",
                        List.of(Map.of("name", "cwd", "type", "string", "required", true),
                               Map.of("name", "path", "type", "string"))));

                    tools.add(makeTool("job", "Manage background jobs using the selected shell. mode: list|view|start|stop; list is in creation order. command is required for start, or holds the job id for view/stop. cwd is required but used only for start. timeout_ms is stop grace (default 500 ms, capped at 1000); Windows forces termination immediately. Stop uses a shared 3000 ms process/capture confirmation deadline and reports incomplete cleanup as an error.",
                        List.of(Map.of("name", "cwd", "type", "string", "required", true),
                               Map.of("name", "mode", "type", "string", "enum", List.of("list", "view", "start", "stop"), "required", true),
                               Map.of("name", "command", "type", "string"),
                               Map.of("name", "timeout_ms", "type", "number"))));


                    tools.add(makeTool("mcp", "Manage MCP servers from local .mcp.json files. Actions:   list: List all servers defined in .mcp.json for cwd   list server=X: Load server X and return its tools   call server=X tool=Y args={}: Call tool Y on loaded server X   unload: Unload all servers for this cwd   unload server=X: Unload server X from the selected configuration file. If a config alias was removed, use unload without server or supply the physical config path.",
                        List.of(Map.of("name", "cwd", "type", "string", "minLength", 1, "description", "Working directory containing .mcp.json", "required", true),
                               Map.of("name", "action", "type", "string", "enum", List.of("list", "call", "unload"), "description", "Action to perform", "required", true),
                               Map.of("name", "server", "type", "string", "minLength", 1, "description", "Server name (required for call, optional for list/unload)"),
                               Map.of("name", "tool", "type", "string", "minLength", 1, "description", "Tool name (required for call)"),
                               Map.of("name", "args", "type", "object", "description", "Tool arguments (defaults to an empty object)", "default", Map.of(), "additionalProperties", true),
                               Map.of("name", "mcpConfigPath", "type", "string", "minLength", 1, "default", ".mcp.json", "description", "Path to .mcp.json relative to cwd"))));

                    if (hasCloudflared) {
                        tools.add(makeTool("preview", "Start a Cloudflare quick tunnel to the given local URL and return the public URL.",
                            List.of(Map.of("name", "url", "type", "string", "required", true))));

                    }

                    if (memoryEnabled) {
                        tools.add(makeTool("remember", "Append a memo.",
                            List.of(Map.of("name", "cwd", "type", "string", "required", true),
                                   Map.of("name", "memo", "type", "string", "required", true),
                                   Map.of("name", "tags", "type", "array", "items", Map.of("type", "string")))));

                        tools.add(makeTool("forget", "Remove a memo by id.",
                            List.of(Map.of("name", "cwd", "type", "string", "required", true),
                                   Map.of("name", "memo_id", "type", "number", "required", true))));

                        tools.add(makeTool("recall", "Search memos by substring (query) and/or tags (AND). Both are case-insensitive. Sorted newest first. Paginated.",
                            List.of(Map.of("name", "cwd", "type", "string", "required", true),
                                   Map.of("name", "query", "type", "string"),
                                   Map.of("name", "tags", "type", "array"),
                                   Map.of("name", "limit", "type", "number"),
                                   Map.of("name", "offset", "type", "number"))));

                    }

                    if ((domain != null || makePublic) && token != null) {
                        tools.add(makeTool("get_upload_link", "Return an upload link the user can open to upload files to Tuan's local machine. Files are saved to `${UPLOAD_ROOT}/<session_id>/`. Session is valid for 10 minutes. Returns a JSON object with: `url` (the upload URL), `expiresInMinutes` (10), `widget` (an HTML button matching the upload page style), and `hint`. When responding to the user, render the `widget` HTML by calling the `visualize:show_widget` tool (or equivalent) so the user sees a clickable button instead of a raw URL. Also include the URL as a markdown link in your response as a fallback for clients that don't render widgets.",
                            List.of()));
                    }

                    tools.add(makeTool("guide",
                        "Operating manual for this code-mcp server: live state, session-start ritual, when to remember, tool catalog. Call at session start.",
                        List.of(Map.of("name", "cwd", "type", "string", "required", true))));

                    // Aggregated external tools (boot-probed via --mcp).
                    for (var entry : aggregatorTools.entrySet()) {
                        AggregatedTool info = entry.getValue();
                        Map<String, Object> definition = new LinkedHashMap<>(info.definition());
                        definition.put("name", entry.getKey());
                        definition.put("description", info.description() != null ? info.description() : "");
                        definition.put("inputSchema", info.inputSchema() != null ? info.inputSchema() : Map.of("type", "object"));
                        tools.add(definition);
                    }

                    // Strip any tool that was disabled via --disallowed-tools.
                    if (!disallowedTools.isEmpty()) {
                        tools.removeIf(t -> disallowedTools.contains((String) t.get("name")));
                    }

                    yield Map.of("tools", tools);
                }
                case "tools/call" -> {
                    if (params == null || !(params.get("name") instanceof String name) || name.isEmpty())
                        yield "ERROR:-32602: name must be a nonempty string";
                    if (!disallowedTools.contains(name) && !aggregatorTools.containsKey(name)
                            && !builtinToolNames().contains(name)
                            && !Set.of("bash", "shell", "command", "powershell").contains(name))
                        yield "ERROR:-32601: unknown tool: " + name;
                    if ("get_upload_link".equals(name)) {
                        try {
                            if (disallowedTools.contains(name)) throw new IOException("tool 'get_upload_link' disabled");
                            Object raw = params.containsKey("arguments") ? params.get("arguments") : Map.of();
                            if (!(raw instanceof Map<?, ?>)) throw new IOException("get_upload_link arguments must be an object");
                            yield Map.of("content", List.of(Map.of("type", "text", "text", maybeSpillText(handleGetUploadLink(), name))));
                        } catch (Exception error) {
                            yield Map.of("isError", true, "content", List.of(Map.of("type", "text", "text", "ERROR: " + error.getMessage())));
                        }
                    }
                    if ("read".equals(name)) {
                        try {
                            if (disallowedTools.contains(name)) throw new IOException("tool 'read' disabled");
                            Object raw = params.get("arguments");
                            if (!(raw instanceof Map<?, ?> readArgs)) throw new IOException("arguments must be an object");
                            String readCwd = writeString(readArgs, "cwd", false);
                            String readPath = writeString(readArgs, "path", false);
                            long[] range = readRange(readArgs);
                            if (readArgs.containsKey("no_truncate") && !(readArgs.get("no_truncate") instanceof Boolean))
                                throw new IOException("no_truncate must be a boolean");
                            String text = handleRead(readCwd, readPath, range, Boolean.TRUE.equals(readArgs.get("no_truncate")));
                            yield Map.of("content", List.of(Map.of("type", "text", "text", text)));
                        } catch (Exception e) {
                            yield Map.of("isError", true, "content", List.of(Map.of("type", "text", "text", "ERROR: " + e.getMessage())));
                        }
                    }
                    if ("edit".equals(name)) {
                        try {
                            if (disallowedTools.contains(name)) throw new IOException("tool 'edit' disabled");
                            Object raw = params.get("arguments");
                            if (!(raw instanceof Map<?, ?> editArgs)) throw new IOException("arguments must be an object");
                            String editCwd = writeString(editArgs, "cwd", false);
                            String editPath = writeString(editArgs, "path", false);
                            String oldStr = writeString(editArgs, "old_str", false);
                            String newStr = writeString(editArgs, "new_str", true);
                            yield Map.of("content", List.of(Map.of("type", "text", "text",
                                handleEdit(editCwd, editPath, oldStr, newStr))));
                        } catch (Exception e) {
                            yield Map.of("isError", true, "content", List.of(Map.of("type", "text",
                                "text", "ERROR: " + e.getMessage())));
                        }
                    }
                    if ("multi_edit".equals(name)) {
                        try {
                            if (disallowedTools.contains(name)) throw new IOException("tool 'multi_edit' disabled");
                            if (!(params.get("arguments") instanceof Map<?, ?> multiArgs)) throw new IOException("arguments must be an object");
                            String multiCwd = writeString(multiArgs, "cwd", false);
                            if (!(multiArgs.get("edits") instanceof List<?> rawEdits) || rawEdits.isEmpty() || rawEdits.size() > 1000)
                                throw new IOException("edits must contain 1 to 1000 items");
                            List<Edit> edits = new ArrayList<>();
                            for (Object rawEdit : rawEdits) {
                                if (!(rawEdit instanceof Map<?, ?> item)) throw new IOException("each edit must be an object");
                                edits.add(new Edit(writeString(item, "path", false), writeString(item, "old_str", false), writeString(item, "new_str", true)));
                            }
                            yield Map.of("content", List.of(Map.of("type", "text", "text", handleMultiEdit(multiCwd, edits))));
                        } catch (Exception e) {
                            yield Map.of("isError", true, "content", List.of(Map.of("type", "text", "text", "ERROR: " + e.getMessage())));
                        }
                    }
                    // Write validates before the legacy argument casts so malformed tool
                    // arguments remain tool errors and preserve the JSON-RPC request ID.
                    if ("write".equals(name)) {
                        try {
                            if (disallowedTools.contains(name)) throw new IOException("tool 'write' disabled");
                            Object raw = params.get("arguments");
                            if (!(raw instanceof Map<?, ?> writeArgs)) throw new IOException("arguments must be an object");
                            String writeCwd = writeString(writeArgs, "cwd", false);
                            String writePath = writeString(writeArgs, "path", false);
                            String content = writeString(writeArgs, "content", true);
                            yield Map.of("content", List.of(Map.of("type", "text", "text",
                                handleWrite(writeCwd, writePath, content))));
                        } catch (Exception e) {
                            yield Map.of("isError", true, "content", List.of(Map.of("type", "text",
                                "text", "ERROR: " + e.getMessage())));
                        }
                    }
                    if (Set.of("bash", "shell", "command", "powershell").contains(name == null ? "" : name)) {
                        try {
                            if (disallowedTools.contains(name)) throw new ShellFailure("tool '" + name + "' disabled");
                            String available = switch (detectedShell) {
                                case BASH -> "bash"; case SH -> "shell";
                                case CMD -> "command"; case POWERSHELL -> "powershell";
                            };
                            if (!name.equals(available)) throw new ShellFailure("tool '" + name + "' not available on this shell");
                            if (!(params.get("arguments") instanceof Map<?, ?> shellArgs)) throw new ShellFailure("arguments must be an object");
                            String shellCwd = writeString(shellArgs, "cwd", false);
                            String command = writeString(shellArgs, "command", true);
                            for (String value : List.of(shellCwd, command)) {
                                if (value.indexOf('\0') >= 0) throw new ShellFailure("cwd and command must not contain NUL");
                                StandardCharsets.UTF_8.newEncoder().encode(java.nio.CharBuffer.wrap(value));
                            }
                            Path directory = Path.of(shellCwd).toRealPath();
                            if (!Files.isDirectory(directory)) throw new ShellFailure("cwd must be an existing directory");
                            Long timeout = null;
                            if (shellArgs.containsKey("timeout_ms")) {
                                if (!(shellArgs.get("timeout_ms") instanceof Number number))
                                    throw new ShellFailure("timeout_ms must be an integer from 1 to 2147483647");
                                double value = number.doubleValue();
                                if (!Double.isFinite(value) || value != Math.floor(value) || value < 1 || value > 2147483647)
                                    throw new ShellFailure("timeout_ms must be an integer from 1 to 2147483647");
                                timeout = number.longValue();
                            }
                            String result = switch (name) {
                                case "bash" -> handleBash(directory.toString(), command, timeout);
                                case "shell" -> handleShell(directory.toString(), command, timeout);
                                case "command" -> handleCommand(directory.toString(), command, timeout);
                                default -> handlePowershell(directory.toString(), command, timeout);
                            };
                            yield Map.of("content", List.of(Map.of("type", "text", "text", maybeSpillText(result, name))));
                        } catch (Exception e) {
                            yield Map.of("isError", true, "content", List.of(Map.of("type", "text", "text", "ERROR: " + e.getMessage())));
                        }
                    }
                    if ("preview".equals(name)) {
                        try {
                            if (disallowedTools.contains(name)) throw new IOException("tool 'preview' disabled");
                            if (!(params.get("arguments") instanceof Map<?, ?> previewArgs)) throw new IOException("preview arguments must be an object");
                            String url = mcpConfigText(previewArgs.get("url"), "url", false);
                            yield Map.of("content", List.of(Map.of("type", "text", "text", handlePreview(url))));
                        } catch (Exception error) {
                            yield Map.of("isError", true, "content", List.of(Map.of("type", "text", "text", "ERROR: " + error.getMessage())));
                        }
                    }
                    if ("guide".equals(name)) {
                        try {
                            if (disallowedTools.contains(name)) throw new IOException("tool 'guide' disabled");
                            if (!(params.get("arguments") instanceof Map<?, ?> guideArgs)) throw new IOException("guide arguments must be an object");
                            Path directory = Path.of(grepString(guideArgs, "cwd", false)).toRealPath();
                            if (!Files.isDirectory(directory)) throw new IOException("cwd must be an existing directory");
                            String result = renderGuide(directory.toString());
                            yield Map.of("content", List.of(Map.of("type", "text", "text", maybeSpillText(result, name))));
                        } catch (Exception error) {
                            yield Map.of("isError", true, "content", List.of(Map.of("type", "text", "text", "ERROR: " + error.getMessage())));
                        }
                    }
                    if ("remember".equals(name)) {
                        try {
                            if (disallowedTools.contains(name)) throw new IOException("tool 'remember' disabled");
                            if (!memoryEnabled) throw new IOException("memory disabled (start server with --enable-memory)");
                            if (!(params.get("arguments") instanceof Map<?, ?> memoryArgs)) throw new IOException("remember arguments must be an object");
                            Path directory = Path.of(grepString(memoryArgs, "cwd", false)).toRealPath();
                            if (!Files.isDirectory(directory)) throw new IOException("cwd must be an existing directory");
                            String memo = writeString(memoryArgs, "memo", true);
                            String result = handleRemember(directory.toString(), memo, sanitizeTags(memoryArgs.get("tags")));
                            yield Map.of("content", List.of(Map.of("type", "text", "text", result)));
                        } catch (Exception error) {
                            yield Map.of("isError", true, "content", List.of(Map.of("type", "text", "text", "ERROR: " + error.getMessage())));
                        }
                    }
                    if ("forget".equals(name)) {
                        try {
                            if (disallowedTools.contains(name)) throw new IOException("tool 'forget' disabled");
                            if (!memoryEnabled) throw new IOException("memory disabled (start server with --enable-memory)");
                            if (!(params.get("arguments") instanceof Map<?, ?> memoryArgs)) throw new IOException("forget arguments must be an object");
                            Path directory = Path.of(grepString(memoryArgs, "cwd", false)).toRealPath();
                            if (!Files.isDirectory(directory)) throw new IOException("cwd must be an existing directory");
                            Object rawId = memoryArgs.get("memo_id");
                            if (!(rawId instanceof Number number)) throw new IOException("memo_id must be a positive safe integer");
                            double value = number.doubleValue();
                            if (!Double.isFinite(value) || value < 1 || value > 9007199254740991L || value != Math.floor(value))
                                throw new IOException("memo_id must be a positive safe integer");
                            String result = handleForget(directory.toString(), number.longValue());
                            yield Map.of("content", List.of(Map.of("type", "text", "text", result)));
                        } catch (Exception error) {
                            yield Map.of("isError", true, "content", List.of(Map.of("type", "text", "text", "ERROR: " + memoFailureMessage(error))));
                        }
                    }
                    if ("recall".equals(name)) {
                        try {
                            if (disallowedTools.contains(name)) throw new IOException("tool 'recall' disabled");
                            if (!memoryEnabled) throw new IOException("memory disabled (start server with --enable-memory)");
                            if (!(params.get("arguments") instanceof Map<?, ?> memoryArgs)) throw new IOException("recall arguments must be an object");
                            Path directory = Path.of(grepString(memoryArgs, "cwd", false)).toRealPath();
                            if (!Files.isDirectory(directory)) throw new IOException("cwd must be an existing directory");
                            Object rawQuery = memoryArgs.get("query"), rawLimit = memoryArgs.get("limit"), rawOffset = memoryArgs.get("offset");
                            double limit = rawLimit instanceof Number n ? n.doubleValue() : Double.NaN;
                            double offset = rawOffset instanceof Number n ? n.doubleValue() : Double.NaN;
                            int lim = Double.isFinite(limit) && limit >= 1 ? (int) Math.min(Math.floor(limit), 1000) : 20;
                            long off = Double.isFinite(offset) && offset >= 0 ? (long) Math.min(Math.floor(offset), 9007199254740991L) : 0;
                            String result = handleRecall(directory.toString(), rawQuery instanceof String q ? q : null,
                                sanitizeTags(memoryArgs.get("tags")), lim, off);
                            yield Map.of("content", List.of(Map.of("type", "text", "text", maybeSpillText(result, name))));
                        } catch (Exception error) {
                            yield Map.of("isError", true, "content", List.of(Map.of("type", "text", "text", "ERROR: " + memoFailureMessage(error))));
                        }
                    }
                    if ("mcp".equals(name)) {
                        try {
                            if (disallowedTools.contains(name)) throw new IOException("tool 'mcp' disabled");
                            if (!(params.get("arguments") instanceof Map<?, ?> mcpArgs)) throw new IOException("arguments must be an object");
                            Path directory = Path.of(grepString(mcpArgs, "cwd", false)).toRealPath();
                            if (!Files.isDirectory(directory)) throw new IOException("cwd must be an existing directory");
                            String action = grepString(mcpArgs, "action", false);
                            if (!Set.of("list", "call", "unload").contains(action)) throw new IOException("unknown action: " + action);
                            String server = mcpArgs.containsKey("server") || action.equals("call") ? grepString(mcpArgs, "server", false) : null;
                            String tool = mcpArgs.containsKey("tool") || action.equals("call") ? grepString(mcpArgs, "tool", false) : null;
                            String config = mcpArgs.containsKey("mcpConfigPath") ? grepString(mcpArgs, "mcpConfigPath", false) : ".mcp.json";
                            Object rawArgs = mcpArgs.containsKey("args") ? mcpArgs.get("args") : Map.of();
                            if (!(rawArgs instanceof Map<?, ?>)) throw new IOException("args must be an object");
                            @SuppressWarnings("unchecked") Map<String, Object> arguments = (Map<String, Object>) rawArgs;
                            Path supplied = Path.of(config), requested = supplied.isAbsolute() ? supplied : directory.resolve(supplied);
                            Path resolved = resolveWritePath(requested.getRoot(), requested);
                            if (resolved.equals(directory) || !resolved.startsWith(directory)) throw new IOException("config path escapes cwd or names cwd itself");
                            String result = handleMcp(directory.toString(), action, server, tool, arguments, directory.relativize(resolved).toString());
                            Map<String, Object> parsed = parseJsonObject(result);
                            if (parsed.containsKey("error") && !parsed.containsKey("content")) throw new IOException(String.valueOf(parsed.get("error")));
                            Map<String, Object> response = new LinkedHashMap<>();
                            response.put("content", List.of(Map.of("type", "text", "text", maybeSpillText(result, name))));
                            if (action.equals("call") && Boolean.TRUE.equals(parsed.get("isError"))) response.put("isError", true);
                            yield response;
                        } catch (Exception error) {
                            yield Map.of("isError", true, "content", List.of(Map.of("type", "text", "text", "ERROR: " + error.getMessage())));
                        }
                    }
                    if ("job".equals(name)) {
                        try {
                            if (disallowedTools.contains(name)) throw new IOException("tool 'job' disabled");
                            if (!(params.get("arguments") instanceof Map<?, ?> jobArgs)) throw new IOException("arguments must be an object");
                            String jobCwd = grepString(jobArgs, "cwd", false);
                            String mode = grepString(jobArgs, "mode", false);
                            if (!Set.of("list", "start", "view", "stop").contains(mode)) throw new IOException("unknown mode: " + mode);
                            String command = jobArgs.containsKey("command") || !mode.equals("list") ? grepString(jobArgs, "command", mode.equals("list")) : null;
                            long timeout = 500;
                            if (jobArgs.containsKey("timeout_ms")) {
                                if (!(jobArgs.get("timeout_ms") instanceof Number number)) throw new IOException("timeout_ms must be an integer from 1 to 2147483647");
                                double value = number.doubleValue();
                                if (!Double.isFinite(value) || value != Math.floor(value) || value < 1 || value > 2147483647) throw new IOException("timeout_ms must be an integer from 1 to 2147483647");
                                timeout = number.longValue();
                            }
                            if (mode.equals("start")) {
                                Path directory = Path.of(jobCwd).toRealPath();
                                if (!Files.isDirectory(directory)) throw new IOException("cwd must be an existing directory");
                                jobCwd = directory.toString();
                            }
                            yield Map.of("content", List.of(Map.of("type", "text", "text", maybeSpillText(handleJob(jobCwd, mode, command, timeout), name))));
                        } catch (Exception e) {
                            yield Map.of("isError", true, "content", List.of(Map.of("type", "text", "text", "ERROR: " + e.getMessage())));
                        }
                    }
                    if ("ls".equals(name)) {
                        try {
                            if (disallowedTools.contains(name)) throw new IOException("tool 'ls' disabled");
                            if (!(params.get("arguments") instanceof Map<?, ?> lsArgs)) throw new IOException("arguments must be an object");
                            String lsCwd = grepString(lsArgs, "cwd", false);
                            String path = lsArgs.containsKey("path") ? grepString(lsArgs, "path", false) : ".";
                            yield Map.of("content", List.of(Map.of("type", "text", "text", maybeSpillText(handleLs(lsCwd, path), name))));
                        } catch (Exception e) {
                            yield Map.of("isError", true, "content", List.of(Map.of("type", "text", "text", "ERROR: " + e.getMessage())));
                        }
                    }
                    if ("find".equals(name)) {
                        try {
                            if (disallowedTools.contains(name)) throw new IOException("tool 'find' disabled");
                            if (!(params.get("arguments") instanceof Map<?, ?> findArgs)) throw new IOException("arguments must be an object");
                            String findCwd = grepString(findArgs, "cwd", false);
                            String pattern = grepString(findArgs, "pattern", false);
                            String path = findArgs.containsKey("path") ? grepString(findArgs, "path", false) : ".";
                            if (findArgs.containsKey("include_hidden") && !(findArgs.get("include_hidden") instanceof Boolean))
                                throw new IOException("include_hidden must be a boolean");
                            if (!Files.isDirectory(Path.of(findCwd))) throw new IOException("cwd must be an existing directory");
                            yield Map.of("content", List.of(Map.of("type", "text", "text",
                                maybeSpillText(handleFind(findCwd, pattern, path, Boolean.TRUE.equals(findArgs.get("include_hidden"))), name))));
                        } catch (Exception e) {
                            yield Map.of("isError", true, "content", List.of(Map.of("type", "text", "text", "ERROR: " + e.getMessage())));
                        }
                    }
                    if ("grep".equals(name)) {
                        try {
                            if (disallowedTools.contains(name)) throw new GrepFailure("tool 'grep' disabled");
                            if (!(params.get("arguments") instanceof Map<?, ?> grepArgs)) throw new GrepFailure("arguments must be an object");
                            String grepCwd = grepString(grepArgs, "cwd", false);
                            String pattern = grepString(grepArgs, "pattern", true);
                            String path = grepArgs.containsKey("path") ? grepString(grepArgs, "path", false) : ".";
                            String glob = grepArgs.containsKey("glob") ? grepString(grepArgs, "glob", true) : null;
                            yield Map.of("content", List.of(Map.of("type", "text", "text", handleGrep(grepCwd, pattern, path, glob))));
                        } catch (Exception e) {
                            yield Map.of("isError", true, "content", List.of(Map.of("type", "text", "text", "ERROR: " + e.getMessage())));
                        }
                    }
                    if (name != null && disallowedTools.contains(name)) {
                        yield Map.of("isError", true, "content", List.of(Map.of("type", "text",
                            "text", "ERROR: tool '" + name + "' disabled")));
                    }
                    // Preserve upstream result metadata while spilling oversized content.
                    if (name != null && aggregatorTools.containsKey(name)) {
                        try {
                            Object supplied = params.containsKey("arguments") ? params.get("arguments") : Map.of();
                            if (!(supplied instanceof Map<?, ?>)) throw new IOException("arguments must be an object");
                            @SuppressWarnings("unchecked") Map<String, Object> forwardedArgs = (Map<String, Object>) supplied;
                            Map<?, ?> raw = callAggregatedRaw(name, forwardedArgs);
                            Map<Object, Object> forwarded = new LinkedHashMap<>(raw);
                            if (raw.containsKey("content")) forwarded.put("content", spillContentBlocks(raw.get("content"), name));
                            yield forwarded;
                        } catch (Exception e) {
                            yield Map.of("isError", true, "content", List.of(Map.of("type", "text",
                                "text", "ERROR: " + e.getMessage())));
                        }
                    }

                    @SuppressWarnings("unchecked")
                    Map<String, Object> args = params != null ? (Map<String, Object>) params.get("arguments") : Map.of();
                    String cwd = effCwd((String) args.get("cwd"));

                    if (name == null) {
                        yield "ERROR: tool name required";
                    }
                    // Only allow the shell tool matching the detected shell.
                    if ((name.equals("bash") && detectedShell != ShellType.BASH)
                            || (name.equals("shell") && detectedShell != ShellType.SH)
                            || (name.equals("command") && detectedShell != ShellType.CMD)
                            || (name.equals("powershell") && detectedShell != ShellType.POWERSHELL)) {
                        yield Map.of("content", List.of(Map.of("type", "text",
                            "text", "ERROR: tool '" + name + "' not available on this shell (" + detectedShell + ")")));
                    }



                    String result;
                    try {
                        result = switch (name) {
                            case "write" -> handleWrite(
                                cwd,
                                (String) args.get("path"),
                                (String) args.get("content"));
                            case "find" -> handleFind(
                                cwd,
                                (String) args.get("pattern"),
                                (String) args.get("path"),
                                Boolean.TRUE.equals(args.get("include_hidden")));
                            case "ls" -> handleLs(
                                cwd,
                                (String) args.get("path"));
                            case "job" -> handleJob(
                                cwd,
                                (String) args.get("mode"),
                                (String) args.get("command"),
                                parseNumber(args.get("timeout_ms")));
                            case "preview" -> handlePreview((String) args.get("url"));
                            case "remember" -> {
                                @SuppressWarnings("unchecked")
                                List<String> tags = (List<String>) args.get("tags");
                                yield handleRemember(cwd, (String) args.get("memo"), tags);
                            }
                            case "forget" -> handleForget(
                                cwd,
                                ((Number) args.get("memo_id")).longValue());
                            case "recall" -> {
                                @SuppressWarnings("unchecked")
                                List<String> tags = (List<String>) (Object) args.get("tags");
                                yield handleRecall(
                                    cwd,
                                    (String) args.get("query"),
                                    tags,
                                    args.containsKey("limit") ? ((Number) args.get("limit")).intValue() : 20,
                                    args.containsKey("offset") ? ((Number) args.get("offset")).intValue() : 0);
                            }
                            case "mcp" -> handleMcp(
                                cwd,
                                (String) args.get("action"),
                                (String) args.get("server"),
                                (String) args.get("tool"),
                                args.get("args") != null ? (Map<String, Object>) args.get("args") : Map.of(),
                                (String) args.get("mcpConfigPath"));
                            case "get_upload_link" -> handleGetUploadLink();
                            case "guide" -> renderGuide(cwd);
                            default -> "ERROR: unknown tool: " + name;
                        };
                    } catch (RuntimeException e) {
                        result = "ERROR: " + e.getMessage();
                    } catch (Exception e) {
                        result = "ERROR: " + e.getMessage();
                    }

                    // Response-layer spill (parity with Python/TS): any tool result
                    // over RESULT_SPILL_THRESHOLD bytes is spilled to disk and the
                    // response carries a head + marker, so huge bash/job/recall/etc.
                    // output doesn't blow the client context window. read+no_truncate
                    // is the one deliberate escape hatch (matching PY/TS skip_spill).
                    boolean skipSpill = name.equals("read")
                        && Boolean.TRUE.equals(args.get("no_truncate"));
                    String finalText = skipSpill ? result : maybeSpillText(result, name);
                    yield Map.of("content", List.of(Map.of("type", "text", "text", finalText)));
                }
                default -> "ERROR:-32601: unknown method: " + method;
            };
        }

        private static Map<String, Object> makeTool(String name, String desc, List<Map<String, Object>> props) {
            // Build a valid JSON Schema: "required" must be a top-level array of
            // property names, never a boolean flag on each property. Codex and
            // other strict clients reject per-property "required": true and drop
            // the tool from their router (tools show up in tools/list but calls
            // fail / the tool is silently skipped).
            List<String> required = new ArrayList<>();
            Map<String, Object> properties = new LinkedHashMap<>();
            for (Map<String, Object> p : props) {
                String propName = (String) p.get("name");
                Map<String, Object> prop = new LinkedHashMap<>(p);
                prop.remove("name");
                if (Boolean.TRUE.equals(prop.remove("required"))) {
                    required.add(propName);
                }
                properties.put(propName, prop);
            }
            Map<String, Object> schema = new LinkedHashMap<>();
            schema.put("type", "object");
            schema.put("properties", properties);
            if (!required.isEmpty()) {
                schema.put("required", required);
            }
            return Map.of(
                "name", name,
                "description", desc,
                "inputSchema", schema
            );
        }

        private static Long parseNumber(Object n) {
            if (n == null) return null;
            if (n instanceof Number) return ((Number) n).longValue();
            try {
                return Long.parseLong(String.valueOf(n));
            } catch (NumberFormatException e) {
                return null;
            }
        }
    }

    // ===== UPLOAD HTTP ROUTE HANDLER =====
    private record UploadDirectory(Path root, Path directory, Map<Path, Object> identities) {
        void verify() throws IOException {
            for (var entry : identities.entrySet()) {
                var attrs = Files.readAttributes(entry.getKey(), java.nio.file.attribute.BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
                if (!attrs.isDirectory() || attrs.isSymbolicLink() || attrs.isOther()
                        || !Objects.equals(attrs.fileKey(), entry.getValue()) || !entry.getKey().toRealPath().equals(entry.getKey()))
                    throw new IOException("upload path changed");
            }
        }
    }

    private static UploadDirectory prepareUploadDirectory(String sessionId) throws IOException {
        verifiedUploadExpiry(sessionId);
        Path path = Path.of(uploadRoot).getParent().getParent().toRealPath();
        Map<Path, Object> identities = new LinkedHashMap<>();
        for (String part : List.of("code-mcp", "uploads", sessionId)) {
            path = path.resolve(part);
            try { Files.createDirectory(path); } catch (FileAlreadyExistsException ignored) {}
            var attrs = Files.readAttributes(path, java.nio.file.attribute.BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            if (!attrs.isDirectory() || attrs.isSymbolicLink() || attrs.isOther() || !path.toRealPath().equals(path)) throw new IOException("upload path invalid");
            identities.put(path, attrs.fileKey());
            try { Files.setPosixFilePermissions(path, java.nio.file.attribute.PosixFilePermissions.fromString("rwx------")); } catch (UnsupportedOperationException ignored) {}
        }
        return new UploadDirectory(path.getParent(), path, identities);
    }

    private static void checkUploadFile(Path path) throws IOException {
        try {
            var attrs = Files.readAttributes(path, java.nio.file.attribute.BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            if (!attrs.isRegularFile() || attrs.isSymbolicLink() || attrs.isOther()) throw new IOException("upload file invalid");
            // Atomic replacement leaves hardlink aliases unchanged; no in-place
            // truncation or write is performed on an existing upload target.
        } catch (NoSuchFileException ignored) {}
    }

    private static void sweepUploads(Path root, String currentSession) {
        long cutoff = System.currentTimeMillis() - 900_000L;
        // Preserve unknown/key-rotated entries; never sweep the general tempdir.
        try (var entries = Files.list(root)) {
            for (Path path : entries.toList()) {
                if (path.getFileName().toString().equals(currentSession)) continue;
                try {
                    if (verifiedUploadExpiry(path.getFileName().toString()) >= cutoff) continue;
                    var attrs = Files.readAttributes(path, java.nio.file.attribute.BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
                    if (!attrs.isDirectory() || attrs.isSymbolicLink() || attrs.isOther()) continue;
                    try (var descendants = Files.walk(path)) {
                        for (Path child : descendants.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(child);
                    }
                } catch (Exception ignored) {}
            }
        } catch (IOException ignored) {}
    }

    private static final ScheduledThreadPoolExecutor HTTP_CLOSE_DEADLINES = new ScheduledThreadPoolExecutor(1, runnable -> {
        Thread thread = new Thread(runnable, "http-close-deadline");
        thread.setDaemon(true);
        return thread;
    });
    static { HTTP_CLOSE_DEADLINES.setRemoveOnCancelPolicy(true); }

    // JDK response close drains unread input. Preserve ordinary small request
    // bodies (avoiding a TCP reset) but never let a slow peer pin this worker.
    private static void closeHttpResponse(OutputStream output) throws IOException {
        Thread owner = Thread.currentThread();
        Object gate = new Object();
        boolean[] state = { true, false }; // active, interrupted by this watchdog
        ScheduledFuture<?> deadline = HTTP_CLOSE_DEADLINES.schedule(() -> {
            synchronized (gate) {
                if (state[0]) {
                    state[1] = true;
                    owner.interrupt(); // closes an in-progress SocketChannel read
                }
            }
        }, 1, TimeUnit.SECONDS);
        try {
            output.close();
        } finally {
            synchronized (gate) {
                state[0] = false;
                deadline.cancel(false);
                if (state[1]) Thread.interrupted(); // do not leak cancellation into the next pool task
            }
        }
    }

    private static class UploadRouteHandler implements HttpHandler {
        private static final Semaphore UPLOAD_SLOTS = new Semaphore(4);
        private static final Map<String, UploadWriteEntry> UPLOAD_WRITES = new HashMap<>();
        private static final class UploadWriteEntry {
            final java.util.concurrent.locks.ReentrantLock lock = new java.util.concurrent.locks.ReentrantLock();
            int users;
        }
        private static final class UploadWriteGuard implements AutoCloseable {
            final String session;
            final UploadWriteEntry entry;
            UploadWriteGuard(String session) {
                this.session = session;
                synchronized (UPLOAD_WRITES) {
                    entry = UPLOAD_WRITES.computeIfAbsent(session, ignored -> new UploadWriteEntry());
                    entry.users++;
                }
                entry.lock.lock();
            }
            public void close() {
                entry.lock.unlock();
                synchronized (UPLOAD_WRITES) {
                    if (--entry.users == 0) UPLOAD_WRITES.remove(session);
                }
            }
        }

        private static final ScheduledThreadPoolExecutor UPLOAD_DEADLINES = new ScheduledThreadPoolExecutor(1, runnable -> {
            Thread thread = new Thread(runnable, "upload-deadline");
            thread.setDaemon(true);
            return thread;
        });
        static { UPLOAD_DEADLINES.setRemoveOnCancelPolicy(true); }

        @Override
        public void handle(HttpExchange exchange) throws IOException {
            String path = exchange.getRequestURI().getPath();
            if (!path.startsWith("/upload/")) {
                exchange.sendResponseHeaders(404, 0);
                exchange.close();
                return;
            }

            String sessionId = path.substring("/upload/".length());

            Headers headers = exchange.getResponseHeaders();
            headers.add("Access-Control-Allow-Origin", "*");
            headers.add("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            headers.add("Access-Control-Allow-Headers", "Content-Type");

            if (exchange.getRequestMethod().equals("OPTIONS")) {
                exchange.sendResponseHeaders(204, -1);
                exchange.close();
                return;
            }

            VerificationResult check = verifyUploadSessionId(sessionId);
            if (!check.ok()) {
                String response = "{\"error\":" + jsonQuote(check.reason()) + "}";
                byte[] bytes = response.getBytes(StandardCharsets.UTF_8);
                headers.add("Content-Type", "application/json; charset=utf-8");
                exchange.sendResponseHeaders(401, bytes.length);
                OutputStream output = exchange.getResponseBody();
                try { output.write(bytes); }
                finally { closeHttpResponse(output); }
                return;
            }

            if (exchange.getRequestMethod().equals("GET")) {
                String html = getUploadPageHtml(sessionId);
                headers.add("Content-Type", "text/html; charset=utf-8");
                byte[] bytes = html.getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(200, bytes.length);
                exchange.getResponseBody().write(bytes);
                exchange.close();
                return;
            }

            if (exchange.getRequestMethod().equals("POST")) {
                handleUpload(exchange, sessionId);
                return;
            }

            exchange.sendResponseHeaders(405, 0);
            exchange.close();
        }

        private static String jsonQuote(String s) {
            if (s == null) return "\"\"";
            return "\"" + escapeJson(s) + "\"";
        }

        private record UploadParameters(String type, Map<String, String> params) {}
        private static UploadParameters uploadParameters(String value) {
            int first = value.indexOf(';'), at = first < 0 ? value.length() : first;
            String type = (first < 0 ? value : value.substring(0, first)).trim().toLowerCase(Locale.ROOT);
            Map<String, String> params = new LinkedHashMap<>();
            while (at < value.length()) {
                if (value.charAt(at++) != ';') throw new IllegalArgumentException("invalid multipart parameter");
                while (at < value.length() && " \t".indexOf(value.charAt(at)) >= 0) at++;
                int start = at;
                while (at < value.length() && ("!#$%&'*+.^_`|~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-".indexOf(value.charAt(at)) >= 0)) at++;
                String key = value.substring(start, at).toLowerCase(Locale.ROOT);
                while (at < value.length() && " \t".indexOf(value.charAt(at)) >= 0) at++;
                if (key.isEmpty() || at >= value.length() || value.charAt(at++) != '=') throw new IllegalArgumentException("invalid multipart parameter");
                while (at < value.length() && " \t".indexOf(value.charAt(at)) >= 0) at++;
                String text;
                if (at < value.length() && value.charAt(at) == '"') {
                    at++; boolean closed = false; StringBuilder parsed = new StringBuilder();
                    while (at < value.length()) {
                        char c = value.charAt(at++);
                        if (c == '"') { closed = true; break; }
                        if (c == '\\') { if (at >= value.length()) throw new IllegalArgumentException("invalid multipart quote"); c = value.charAt(at++); }
                        parsed.append(c);
                    }
                    if (!closed) throw new IllegalArgumentException("invalid multipart quote");
                    text = parsed.toString();
                    while (at < value.length() && " \t".indexOf(value.charAt(at)) >= 0) at++;
                    if (at < value.length() && value.charAt(at) != ';') throw new IllegalArgumentException("invalid multipart parameter");
                } else {
                    start = at; while (at < value.length() && value.charAt(at) != ';') at++;
                    text = value.substring(start, at).trim();
                }
                if (params.containsKey(key) || text.indexOf('\r') >= 0 || text.indexOf('\n') >= 0 || text.indexOf(0) >= 0) throw new IllegalArgumentException("ambiguous multipart parameter");
                params.put(key, text);
            }
            return new UploadParameters(type, params);
        }

        private static String uploadFilename(String value) {
            String name = value.replace('\\', '/'); name = name.substring(name.lastIndexOf('/') + 1);
            name = name.replaceAll("[\\x00-\\x1f\\x7f<>:\"|?*]", "_").replaceAll("[ .]+$", "");
            if (name.isEmpty()) name = "upload.bin";
            if (name.split("\\.", -1)[0].stripTrailing().matches("(?i)(CON|PRN|AUX|NUL|CONIN\\$|CONOUT\\$|COM[1-9¹²³]|LPT[1-9¹²³])")) name = "_" + name;
            if (name.getBytes(StandardCharsets.UTF_8).length > 255) throw new IllegalArgumentException("filename exceeds 255 UTF-8 bytes");
            return name;
        }

        private record UploadPart(String name, String mime, int start, int end) {}
        private record UploadDelimiter(int position, int after, boolean closing) {}
        private static UploadDelimiter uploadDelimiter(byte[] body, int position, int markerLength) {
            int at = position + markerLength;
            boolean closing = at + 1 < body.length && body[at] == '-' && body[at + 1] == '-';
            if (closing) at += 2;
            while (at < body.length && (body[at] == ' ' || body[at] == '\t')) at++;
            if (closing && at == body.length) return new UploadDelimiter(position, at, true);
            if (at + 1 < body.length && body[at] == '\r' && body[at + 1] == '\n') return new UploadDelimiter(position, at + 2, closing);
            return null;
        }
        private static UploadDelimiter nextUploadDelimiter(byte[] body, byte[] prefix, int from) {
            for (int found = findBytes(body, from, body.length, prefix); found >= 0; found = findBytes(body, found + prefix.length, body.length, prefix)) {
                UploadDelimiter value = uploadDelimiter(body, found + 2, prefix.length - 2);
                if (value != null) return value;
            }
            return null;
        }
        private static UploadPart parseUploadForm(String contentType, byte[] body) throws IOException {
            UploadParameters parsed = uploadParameters(contentType == null ? "" : contentType);
            String boundary = parsed.params().getOrDefault("boundary", "");
            if (!parsed.type().equals("multipart/form-data") || !boundary.matches("[0-9A-Za-z'()+_,./:=? -]{1,70}") || boundary.endsWith(" ")) throw new IllegalArgumentException("invalid multipart boundary");
            byte[] marker = ("--" + boundary).getBytes(StandardCharsets.US_ASCII), prefix = ("\r\n--" + boundary).getBytes(StandardCharsets.US_ASCII);
            UploadDelimiter current = body.length >= marker.length && Arrays.equals(body, 0, marker.length, marker, 0, marker.length)
                ? uploadDelimiter(body, 0, marker.length) : nextUploadDelimiter(body, prefix, 0);
            UploadPart selected = null; int count = 0;
            while (current != null && !current.closing()) {
                if (++count > 128) throw new IllegalArgumentException("too many multipart parts");
                UploadDelimiter next = nextUploadDelimiter(body, prefix, current.after());
                if (next == null) throw new IllegalArgumentException("truncated multipart body");
                int end = next.position() - 2, headerEnd = findBytes(body, current.after(), end, new byte[]{'\r','\n','\r','\n'});
                if (headerEnd < current.after() || headerEnd - current.after() > 65536) throw new IllegalArgumentException("invalid multipart headers");
                String headerText = StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(body, current.after(), headerEnd - current.after())).toString();
                Map<String, String> headers = new LinkedHashMap<>();
                for (String line : headerText.split("\r\n", -1)) {
                    int colon = line.indexOf(':');
                    if (colon <= 0) throw new IllegalArgumentException("invalid multipart headers");
                    String key = line.substring(0, colon).toLowerCase(Locale.ROOT);
                    if (!key.matches("[!#$%&'*+.^_`|~0-9a-z-]+") || headers.containsKey(key)) throw new IllegalArgumentException("invalid multipart headers");
                    headers.put(key, line.substring(colon + 1).trim());
                }
                UploadParameters disposition = uploadParameters(headers.getOrDefault("content-disposition", ""));
                if (!disposition.type().equals("form-data") || !disposition.params().containsKey("name")) throw new IllegalArgumentException("invalid content disposition");
                if (disposition.params().get("name").equals("file")) {
                    if (selected != null || !disposition.params().containsKey("filename")) throw new IllegalArgumentException("expected one file field");
                    String mime = headers.getOrDefault("content-type", "application/octet-stream");
                    mime = !mime.isEmpty() && mime.matches("[\\x20-\\x7e]+") ? mime.toLowerCase(Locale.ROOT) : "application/octet-stream";
                    selected = new UploadPart(uploadFilename(disposition.params().get("filename")), mime, headerEnd + 4, end);
                }
                current = next;
            }
            if (current == null || !current.closing() || selected == null) throw new IllegalArgumentException("missing file field");
            return selected;
        }

        private void handleUpload(HttpExchange exchange, String sessionId) throws IOException {
            Headers respHdr = exchange.getResponseHeaders();
            respHdr.add("Content-Type", "application/json; charset=utf-8");

            if (!UPLOAD_SLOTS.tryAcquire()) {
                respHdr.set("Retry-After", "1");
                writeJson(exchange, 503, "{\"error\":\"too many active uploads\"}");
                return;
            }
            AtomicBoolean reading = new AtomicBoolean(true);
            ScheduledFuture<?> deadline = UPLOAD_DEADLINES.schedule(() -> {
                if (reading.compareAndSet(true, false)) exchange.close();
            }, 60, TimeUnit.SECONDS);
            try {
                String contentType = exchange.getRequestHeaders().getFirst("Content-Type");
                long contentLen = -1;
                String clHdr = exchange.getRequestHeaders().getFirst("Content-Length");
                if (clHdr != null) {
                    try { contentLen = Long.parseLong(clHdr); } catch (NumberFormatException ignored) {}
                }
                if (contentLen > MAX_UPLOAD_BODY_BYTES) {
                    writeJson(exchange, 413, "{\"error\":\"upload body exceeds " + MAX_UPLOAD_BODY_BYTES + " bytes\"}");
                    return;
                }

                // Read body with hard byte cap.
                ByteArrayOutputStream baos = new ByteArrayOutputStream();
                byte[] buf = new byte[64 * 1024];
                long total = 0;
                // The exchange owns the stream. Closing it while unwinding a
                // malformed chunk can drain unread bytes and block the error response.
                InputStream in = exchange.getRequestBody();
                try {
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        total += n;
                        if (total > MAX_UPLOAD_BODY_BYTES) {
                            writeJson(exchange, 413, "{\"error\":\"upload body exceeds " + MAX_UPLOAD_BODY_BYTES + " bytes\"}");
                            return;
                        }
                        baos.write(buf, 0, n);
                    }
                } catch (IOException error) {
                    if (!reading.get()) return; // deadline closed the underlying connection
                    writeJson(exchange, 400, "{\"error\":" + jsonQuote("invalid upload body: " + error.getMessage()) + "}");
                    return;
                }
                if (!reading.compareAndSet(true, false)) return;
                deadline.cancel(false);
                byte[] body = baos.toByteArray();

                UploadPart part;
                try {
                    part = parseUploadForm(contentType, body);
                } catch (IOException | IllegalArgumentException error) {
                    writeJson(exchange, 400, "{\"error\":" + jsonQuote("bad form: " + error.getMessage()) + "}");
                    return;
                }
                if (part.end() - part.start() > MAX_UPLOAD_BYTES) {
                    writeJson(exchange, 413, "{\"error\":\"file too large (max " + MAX_UPLOAD_BYTES + " bytes)\"}");
                    return;
                }
                String fileName = part.name(), mime = part.mime();
                int fileContentStart = part.start(), fileContentEnd = part.end();

                try (UploadWriteGuard writeGuard = new UploadWriteGuard(sessionId)) {
                    UploadDirectory owned = prepareUploadDirectory(sessionId);
                    Path filePath = owned.directory().resolve(fileName);
                    if (!filePath.getParent().equals(owned.directory())) throw new IOException("upload filename invalid");
                    checkUploadFile(filePath);
                    handleWriteBytes(owned.root().toString(), filePath.toString(),
                            ByteBuffer.wrap(body, fileContentStart, fileContentEnd - fileContentStart), null,
                            () -> { owned.verify(); checkUploadFile(filePath); });
                    owned.verify();
                    MessageDigest md = MessageDigest.getInstance("SHA-256");
                    md.update(body, fileContentStart, fileContentEnd - fileContentStart);
                    byte[] hash = md.digest();
                    StringBuilder hashHex = new StringBuilder();
                    for (byte b : hash) hashHex.append(String.format("%02x", b));


                    sweepUploads(owned.root(), sessionId);

                    String response = String.format(
                        "{\"path\":%s,\"size\":%d,\"sha256\":%s,\"mime\":%s}",
                        jsonQuote(filePath.toString()),
                        fileContentEnd - fileContentStart,
                        jsonQuote(hashHex.toString()),
                        jsonQuote(mime));
                    writeJson(exchange, 200, response);
                }
            } catch (Exception e) {
                writeJson(exchange, 500, "{\"error\":" + jsonQuote(e.getMessage()) + "}");
            } finally {
                reading.set(false);
                deadline.cancel(false);
                UPLOAD_SLOTS.release();
            }
        }

        private static void writeJson(HttpExchange exchange, int status, String body) throws IOException {
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(status, bytes.length);
            OutputStream output = exchange.getResponseBody();
            try { output.write(bytes); }
            finally { closeHttpResponse(output); }
        }

        private static int findBytes(byte[] haystack, int from, int to, byte[] needle) {
            outer:
            for (int i = from; i <= to - needle.length; i++) {
                for (int j = 0; j < needle.length; j++) {
                    if (haystack[i + j] != needle[j]) continue outer;
                }
                return i;
            }
            return -1;
        }

        private String getUploadPageHtml(String sessionId) {
            return "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width="
                + "device-width, initial-scale=1.0\">\n<title>Upload to local machine</title>\n<style>\n  :root {\n    --bg:"
                + " #faf9f5;\n    --surface: #ffffff;\n    --text-primary: #181818;\n    --text-secondary: #6b6b63;\n    --"
                + "text-tertiary: #96958b;\n    --text-info: #2d5fb3;\n    --text-success: #0f6e56;\n    --text-warning: #"
                + "854f0b;\n    --text-danger: #a32d2d;\n    --border-tertiary: rgba(24, 24, 24, 0.08);\n    --border-seco"
                + "ndary: rgba(24, 24, 24, 0.16);\n    --border-info: rgba(45, 95, 179, 0.3);\n    --bg-info: rgba(45, 95"
                + ", 179, 0.06);\n    --bg-tertiary: #f1efe8;\n    --radius-md: 8px;\n    --radius-lg: 12px;\n  }\n  * { box"
                + "-sizing: border-box; }\n  html, body { margin: 0; padding: 0; }\n  body {\n    background: var(--bg);\n "
                + "   color: var(--text-primary);\n    font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", Robot"
                + "o, \"Helvetica Neue\", Arial, sans-serif;\n    font-size: 16px;\n    line-height: 1.5;\n    min-height: 1"
                + "00vh;\n    display: flex;\n    align-items: center;\n    justify-content: center;\n    padding: 2rem 1re"
                + "m;\n  }\n  .container {\n    width: 100%;\n    max-width: 560px;\n  }\n  .dropzone {\n    display: block;\n "
                + "   background: transparent;\n    border: 0.5px dashed var(--border-secondary);\n    border-radius: var"
                + "(--radius-lg);\n    padding: 2rem 1.25rem;\n    text-align: center;\n    cursor: pointer;\n    transitio"
                + "n: background 120ms ease, border-color 120ms ease;\n    user-select: none;\n    -webkit-user-select: n"
                + "one;\n    -webkit-tap-highlight-color: transparent;\n  }\n  .dropzone:hover {\n    background: var(--bg-"
                + "info);\n    border-color: var(--border-info);\n  }\n  .dropzone.hover {\n    background: var(--bg-info);"
                + "\n    border-color: var(--border-info);\n  }\n  .dropzone.disabled {\n    cursor: not-allowed;\n    opaci"
                + "ty: 0.5;\n  }\n  .dropzone .icon { display: flex; justify-content: center; margin-bottom: 12px; color:"
                + " var(--text-secondary); }\n  .dropzone .title { margin: 0; font-size: 14px; color: var(--text-primary"
                + "); }\n  .dropzone .browse { color: var(--text-info); text-decoration: underline; }\n  .file-list { mar"
                + "gin-top: 0.75rem; display: none; flex-direction: column; gap: 6px; }\n  .file-row {\n    display: flex"
                + ";\n    align-items: center;\n    justify-content: space-between;\n    gap: 12px;\n    padding: 8px 12px;"
                + "\n    background: var(--surface);\n    border: 0.5px solid var(--border-tertiary);\n    border-radius: "
                + "var(--radius-md);\n  }\n  .file-row .info { display: flex; align-items: baseline; gap: 8px; min-width:"
                + " 0; flex: 1; }\n  .file-row .name { font-size: 13px; color: var(--text-primary); overflow: hidden; te"
                + "xt-overflow: ellipsis; white-space: nowrap; }\n  .file-row .size { font-size: 12px; color: var(--text"
                + "-tertiary); flex-shrink: 0; }\n  .file-row button {\n    flex-shrink: 0;\n    width: 24px;\n    height: "
                + "24px;\n    padding: 0;\n    display: inline-flex;\n    align-items: center;\n    justify-content: center"
                + ";\n    color: var(--text-tertiary);\n    background: transparent;\n    border: none;\n    cursor: pointe"
                + "r;\n    border-radius: 4px;\n  }\n  .file-row button:hover { background: var(--bg-tertiary); color: var"
                + "(--text-primary); }\n  .file-row button:disabled { cursor: not-allowed; opacity: 0.4; }\n  .progress-w"
                + "rap { margin-top: 0.75rem; display: none; }\n  .progress-track {\n    background: var(--bg-tertiary);\n"
                + "    border-radius: 999px;\n    height: 4px;\n    overflow: hidden;\n  }\n  .progress-bar {\n    height: 1"
                + "00%;\n    width: 0%;\n    background: var(--text-info);\n    transition: width 120ms ease;\n  }\n  .progr"
                + "ess-message { margin: 8px 0 0; font-size: 12px; color: var(--text-secondary); }\n  .actions { display"
                + ": flex; justify-content: flex-end; gap: 8px; margin-top: 0.75rem; }\n  .actions button {\n    font-fam"
                + "ily: inherit;\n    font-size: 14px;\n    padding: 8px 16px;\n    background: transparent;\n    color: va"
                + "r(--text-primary);\n    border: 0.5px solid var(--border-secondary);\n    border-radius: var(--radius-"
                + "md);\n    cursor: pointer;\n    transition: background 100ms ease, transform 100ms ease;\n  }\n  .action"
                + "s button:hover:not(:disabled) { background: var(--bg-tertiary); }\n  .actions button:active:not(:disa"
                + "bled) { transform: scale(0.98); }\n  .actions button:disabled { opacity: 0.5; cursor: not-allowed; }\n"
                + "</style>\n</head>\n<body>\n  <div class=\"container\">\n    <input type=\"file\" id=\"file-input\" multiple st"
                + "yle=\"position: absolute; left: -9999px; width: 1px; height: 1px; opacity: 0;\" />\n    <label id=\"drop"
                + "zone\" class=\"dropzone\" for=\"file-input\">\n      <div class=\"icon\">\n        <svg width=\"24\" height=\"24"
                + "\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" st"
                + "roke-linejoin=\"round\">\n          <path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\"/>\n          <po"
                + "lyline points=\"17 8 12 3 7 8\"/>\n          <line x1=\"12\" y1=\"3\" x2=\"12\" y2=\"15\"/>\n        </svg>\n    "
                + "  </div>\n      <p class=\"title\">Drop files here, or <span class=\"browse\">browse</span></p>\n    </lab"
                + "el>\n\n    <div id=\"file-list\" class=\"file-list\"></div>\n\n    <div id=\"progress-wrap\" class=\"progress-w"
                + "rap\">\n      <div class=\"progress-track\"><div id=\"progress-bar\" class=\"progress-bar\"></div></div>\n   "
                + "   <p id=\"progress-message\" class=\"progress-message\"></p>\n    </div>\n\n    <div class=\"actions\">\n    "
                + "  <button id=\"cancel-btn\">Cancel</button>\n      <button id=\"upload-btn\" disabled>Upload</button>\n   "
                + " </div>\n  </div>\n\n<script data-cfasync=\"false\">\n(function () {\n  var dropzone = document.getElementB"
                + "yId('dropzone');\n  var fileInput = document.getElementById('file-input');\n  var fileList = document."
                + "getElementById('file-list');\n  var progressWrap = document.getElementById('progress-wrap');\n  var pr"
                + "ogressBar = document.getElementById('progress-bar');\n  var progressMessage = document.getElementById"
                + "('progress-message');\n  var uploadBtn = document.getElementById('upload-btn');\n  var cancelBtn = doc"
                + "ument.getElementById('cancel-btn');\n\n  var UPLOAD_URL = window.location.href;\n\n  var queue = [];\n  v"
                + "ar uploading = false;\n  var cancelled = false;\n  var currentXhr = null;\n  var finished = false;\n\n  f"
                + "unction fmtBytes(n) {\n    if (n < 1024) return n + ' B';\n    if (n < 1024 * 1024) return (n / 1024)."
                + "toFixed(1) + ' KB';\n    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';\n "
                + "   return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';\n  }\n\n  function setBtn(btn, enabled) {\n    "
                + "btn.disabled = !enabled;\n  }\n\n  function refreshButtons() {\n    if (finished) {\n      setBtn(uploadB"
                + "tn, false);\n      setBtn(cancelBtn, false);\n      return;\n    }\n    setBtn(uploadBtn, !uploading && "
                + "queue.length > 0);\n    setBtn(cancelBtn, true);\n  }\n\n  function renderList() {\n    if (queue.length "
                + "=== 0) {\n      fileList.style.display = 'none';\n      fileList.innerHTML = '';\n      refreshButtons("
                + ");\n      return;\n    }\n    fileList.style.display = 'flex';\n    fileList.innerHTML = '';\n    queue.f"
                + "orEach(function (file, idx) {\n      var row = document.createElement('div');\n      row.className = '"
                + "file-row';\n\n      var info = document.createElement('div');\n      info.className = 'info';\n      var"
                + " name = document.createElement('span');\n      name.className = 'name';\n      name.textContent = file"
                + ".name;\n      var size = document.createElement('span');\n      size.className = 'size';\n      size.te"
                + "xtContent = fmtBytes(file.size);\n      info.appendChild(name);\n      info.appendChild(size);\n\n      "
                + "var remove = document.createElement('button');\n      remove.setAttribute('aria-label', 'Remove ' + f"
                + "ile.name);\n      remove.innerHTML = '<svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" str"
                + "oke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><line x1=\"18\" y1="
                + "\"6\" x2=\"6\" y2=\"18\"/><line x1=\"6\" y1=\"6\" x2=\"18\" y2=\"18\"/></svg>';\n      remove.disabled = uploading "
                + "|| finished;\n      remove.addEventListener('click', function (e) {\n        e.stopPropagation();\n    "
                + "    if (uploading || finished) return;\n        queue.splice(idx, 1);\n        renderList();\n      });"
                + "\n\n      row.appendChild(info);\n      row.appendChild(remove);\n      fileList.appendChild(row);\n    }"
                + ");\n    refreshButtons();\n  }\n\n  function addFiles(files) {\n    if (uploading || finished) return;\n  "
                + "  for (var i = 0; i < files.length; i++) queue.push(files[i]);\n    renderList();\n  }\n\n  function upl"
                + "oadOne(file, onProgress) {\n    return new Promise(function (resolve) {\n      var xhr = new XMLHttpRe"
                + "quest();\n      currentXhr = xhr;\n      var form = new FormData();\n      form.append('file', file);\n\n"
                + "      xhr.upload.addEventListener('progress', function (e) {\n        if (e.lengthComputable) onProgr"
                + "ess(e.loaded, e.total);\n      });\n      xhr.addEventListener('load', function () {\n        if (xhr.s"
                + "tatus >= 200 && xhr.status < 300) {\n          var body = {};\n          try { body = JSON.parse(xhr.r"
                + "esponseText); } catch (e) {}\n          resolve({ ok: true, path: body.path || file.name, file: file "
                + "});\n        } else {\n          resolve({ ok: false, status: xhr.status, file: file });\n        }\n   "
                + "   });\n      xhr.addEventListener('error', function () {\n        resolve({ ok: false, networkError: "
                + "true, file: file });\n      });\n      xhr.addEventListener('abort', function () {\n        resolve({ o"
                + "k: false, aborted: true, file: file });\n      });\n      xhr.open('POST', UPLOAD_URL);\n      xhr.send"
                + "(form);\n    });\n  }\n\n  function disableAll() {\n    finished = true;\n    dropzone.classList.add('disa"
                + "bled');\n    fileInput.disabled = true;\n    refreshButtons();\n    // re-render list so the remove but"
                + "tons get disabled\n    renderList();\n  }\n\n  function runUpload() {\n    if (uploading || queue.length "
                + "=== 0) return;\n    uploading = true;\n    cancelled = false;\n    refreshButtons();\n    progressWrap.s"
                + "tyle.display = 'block';\n    progressBar.style.background = 'var(--text-info)';\n    progressBar.style"
                + ".width = '0%';\n    progressMessage.style.color = 'var(--text-secondary)';\n\n    var files = queue.sli"
                + "ce();\n    var totalBytes = files.reduce(function (s, f) { return s + f.size; }, 0);\n    var complete"
                + "dBytes = 0;\n    var results = [];\n\n    function next(i) {\n      if (cancelled || i >= files.length) "
                + "return finish(results, files, i);\n      var f = files[i];\n      progressMessage.textContent = 'Uploa"
                + "ding ' + f.name + ' (' + (i + 1) + '/' + files.length + ')';\n      uploadOne(f, function (loaded) {\n"
                + "        var pct = totalBytes === 0 ? 0 : ((completedBytes + loaded) / totalBytes) * 100;\n        pro"
                + "gressBar.style.width = pct + '%';\n      }).then(function (res) {\n        completedBytes += f.size;\n "
                + "       results.push(res);\n        next(i + 1);\n      });\n    }\n\n    function finish(results, allFile"
                + "s, stoppedAt) {\n      uploading = false;\n      currentXhr = null;\n      var ok = results.filter(func"
                + "tion (r) { return r.ok; });\n      var failed = results.filter(function (r) { return !r.ok && !r.abor"
                + "ted; });\n\n      progressBar.style.width = '100%';\n\n      if (cancelled) {\n        progressBar.style."
                + "background = 'var(--text-warning)';\n        progressMessage.textContent = 'Cancelled — ' + ok.length"
                + " + ' uploaded before stop';\n        progressMessage.style.color = 'var(--text-warning)';\n      } els"
                + "e if (failed.length === 0) {\n        progressBar.style.background = 'var(--text-success)';\n        p"
                + "rogressMessage.textContent = 'Uploaded ' + ok.length + ' file' + (ok.length === 1 ? '' : 's') + '. T"
                + "ell Claude where they landed:';\n        progressMessage.style.color = 'var(--text-success)';\n      }"
                + " else {\n        progressBar.style.background = 'var(--text-danger)';\n        progressMessage.textCon"
                + "tent = ok.length + ' uploaded, ' + failed.length + ' failed';\n        progressMessage.style.color = "
                + "'var(--text-danger)';\n      }\n\n      if (ok.length > 0) {\n        var summaryWrap = document.createE"
                + "lement('div');\n        summaryWrap.style.cssText = 'position: relative; margin-top: 12px;';\n        "
                + "var summary = document.createElement('pre');\n        summary.style.cssText = 'margin: 0; padding: 12"
                + "px 40px 12px 12px; background: var(--bg-tertiary); border-radius: var(--radius-md); font-size: 12px;"
                + " font-family: ui-monospace, \"SF Mono\", Menlo, monospace; color: var(--text-primary); white-space: pr"
                + "e-wrap; overflow-wrap: anywhere;';\n        var text = ok.map(function (r) { return r.path; }).join('"
                + "\\n');\n        summary.textContent = text;\n        var copyBtn = document.createElement('button');\n  "
                + "      copyBtn.type = 'button';\n        copyBtn.setAttribute('aria-label', 'Copy paths');\n        cop"
                + "yBtn.style.cssText = 'position: absolute; top: 8px; right: 8px; width: 28px; height: 28px; padding: "
                + "0; display: inline-flex; align-items: center; justify-content: center; color: var(--text-tertiary); "
                + "background: transparent; border: none; cursor: pointer; border-radius: 4px;';\n        copyBtn.innerH"
                + "TML = '<svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-widt"
                + "h=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"9\" y=\"9\" width=\"13\" height=\"13\" rx=\"2\""
                + " ry=\"2\"/><path d=\"M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1\"/></svg>';\n        copyBtn"
                + ".addEventListener('mouseenter', function () { copyBtn.style.background = 'var(--surface)'; copyBtn.s"
                + "tyle.color = 'var(--text-primary)'; });\n        copyBtn.addEventListener('mouseleave', function () {"
                + " copyBtn.style.background = 'transparent'; copyBtn.style.color = 'var(--text-tertiary)'; });\n       "
                + " copyBtn.addEventListener('click', function () {\n          var done = function () {\n            var "
                + "prev = copyBtn.innerHTML;\n            copyBtn.innerHTML = '<svg width=\"14\" height=\"14\" viewBox=\"0 0 "
                + "24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"ro"
                + "und\"><polyline points=\"20 6 9 17 4 12\"/></svg>';\n            copyBtn.style.color = 'var(--text-succe"
                + "ss)';\n            setTimeout(function () { copyBtn.innerHTML = prev; copyBtn.style.color = 'var(--te"
                + "xt-tertiary)'; }, 1500);\n          };\n          if (navigator.clipboard && navigator.clipboard.write"
                + "Text) {\n            navigator.clipboard.writeText(text).then(done).catch(function () {});\n          "
                + "} else {\n            // fallback for older browsers / non-secure contexts\n            var ta = docum"
                + "ent.createElement('textarea');\n            ta.value = text;\n            ta.style.cssText = 'position"
                + ": fixed; left: -9999px;';\n            document.body.appendChild(ta);\n            ta.select();\n      "
                + "      try { document.execCommand('copy'); done(); } catch (err) {}\n            document.body.removeC"
                + "hild(ta);\n          }\n        });\n        summaryWrap.appendChild(summary);\n        summaryWrap.appe"
                + "ndChild(copyBtn);\n        progressWrap.appendChild(summaryWrap);\n      }\n\n      // clear queue, disa"
                + "ble the page\n      queue = [];\n      fileList.style.display = 'none';\n      fileList.innerHTML = '';"
                + "\n      disableAll();\n    }\n\n    next(0);\n  }\n\n  function runCancel() {\n    if (uploading) {\n      ca"
                + "ncelled = true;\n      if (currentXhr) try { currentXhr.abort(); } catch (e) {}\n    } else {\n      qu"
                + "eue = [];\n      progressWrap.style.display = 'none';\n      renderList();\n      progressMessage.textC"
                + "ontent = 'Upload cancelled.';\n      progressMessage.style.color = 'var(--text-warning)';\n      progr"
                + "essWrap.style.display = 'block';\n      progressBar.style.background = 'var(--text-warning)';\n      p"
                + "rogressBar.style.width = '100%';\n      disableAll();\n    }\n  }\n\n  dropzone.addEventListener('click',"
                + " function (e) {\n    // <label for=\"file-input\"> handles the click natively. JS click() is\n    // unr"
                + "eliable on mobile browsers — we let the label do its job.\n    if (uploading || finished) e.preventDe"
                + "fault();\n  });\n  fileInput.addEventListener('change', function (e) {\n    var files = e.target.files "
                + "|| fileInput.files;\n    if (files && files.length) {\n      // copy FileList to array — some mobile b"
                + "rowsers invalidate it after value reset\n      var arr = [];\n      for (var i = 0; i < files.length; "
                + "i++) arr.push(files[i]);\n      addFiles(arr);\n    }\n    fileInput.value = '';\n  });\n  dropzone.addEv"
                + "entListener('dragover', function (e) { e.preventDefault(); if (!uploading && !finished) dropzone.cla"
                + "ssList.add('hover'); });\n  dropzone.addEventListener('dragleave', function () { dropzone.classList.r"
                + "emove('hover'); });\n  dropzone.addEventListener('drop', function (e) {\n    e.preventDefault();\n    d"
                + "ropzone.classList.remove('hover');\n    if (uploading || finished) return;\n    if (e.dataTransfer.fil"
                + "es && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);\n  });\n\n  uploadBtn.addEventListen"
                + "er('click', runUpload);\n  cancelBtn.addEventListener('click', runCancel);\n})();\n</script>\n</body>\n</"
                + "html>\n";
        }
    }

    private static final String WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    private static final SecureRandom WS_RNG = new SecureRandom();

    // Shared HTTP client + dispatch pool for gateway tunnel — reused across all messages.
    private static final HttpClient GATEWAY_HTTP = HttpClient.newBuilder()
            .connectTimeout(java.time.Duration.ofSeconds(10))
            .build();
    // Bounded queue + caller-runs policy so a slow handler can't OOM the server
    // by accumulating thousands of pending tunnel messages.
    private static final ExecutorService GATEWAY_DISPATCH = new ThreadPoolExecutor(
        8, 32, 60L, TimeUnit.SECONDS,
        new LinkedBlockingQueue<>(128),
        r -> {
            Thread t = new Thread(r, "gw-dispatch-" + System.nanoTime());
            t.setDaemon(true);
            return t;
        },
        new ThreadPoolExecutor.CallerRunsPolicy());

    // ===== GATEWAY CLIENT =====
    private static void startGatewayClient(String domain, String deviceIdParam, String gwToken) {
        final String deviceId = deviceIdParam != null ? deviceIdParam : UUID.randomUUID().toString();

        Thread t = new Thread(() -> {
            int retries = 0;
            System.err.println("[gateway] starting client for: " + domain + " (deviceId=" + deviceId + ")");
            while (!shuttingDown) {
                Socket sock = null;
                try {
                    // Normalize the gateway domain: accept bare host, ws(s):// or http(s)://
                    // prefixes (README examples use wss://). Bare hosts default to wss
                    // for anything that is not a loopback/LAN address.
                    boolean isLocal = domain.startsWith("localhost") || domain.startsWith("127.") ||
                            domain.startsWith("192.168.") || domain.startsWith("10.") ||
                            domain.startsWith("172.16.") || domain.startsWith("ws://") || domain.startsWith("http://");
                    String baseUrl;
                    if (domain.startsWith("wss://") || domain.startsWith("https://")) {
                        baseUrl = domain.replace("https://", "wss://");
                    } else if (domain.startsWith("ws://") || domain.startsWith("http://")) {
                        baseUrl = domain.replace("http://", "ws://");
                    } else {
                        baseUrl = (isLocal ? "ws://" : "wss://") + domain;
                    }
                    String url = deviceIdParam != null
                            ? baseUrl + "/ws/" + deviceIdParam
                            : baseUrl + "/ws";
                    URI uri = URI.create(url);
                    String host = uri.getHost();
                    int gatewayPort = uri.getPort() > 0 ? uri.getPort() : (isLocal ? 80 : 443);
                    String wsPath = uri.getPath();

                    if (isLocal) {
                        sock = new Socket(host, gatewayPort);
                    } else {
                        SSLSocketFactory sf = SSLContext.getDefault().getSocketFactory();
                        SSLSocket ssl = (SSLSocket) sf.createSocket(host, gatewayPort);
                        sock = ssl; // The outer finally owns failed handshakes too.
                        ssl.setSoTimeout(60_000);
                        var parameters = ssl.getSSLParameters();
                        parameters.setEndpointIdentificationAlgorithm("HTTPS");
                        ssl.setSSLParameters(parameters);
                        ssl.startHandshake();
                    }
                    sock.setSoTimeout(60_000);

                    DataOutputStream out = new DataOutputStream(sock.getOutputStream());
                    InputStream in = sock.getInputStream();

                    byte[] keyBytes = new byte[16];
                    WS_RNG.nextBytes(keyBytes);
                    String wsKey = Base64.getEncoder().encodeToString(keyBytes);
                    String hostHeader = (gatewayPort == 80 || gatewayPort == 443) ? host : host + ":" + gatewayPort;
                    // Device credential for the gateway: sent as X-Device-Token so the
                    // registry-backed /ws auth accepts the upgrade. Without it the
                    // hardened gateway answers 401 (legacy gateways ignore the header).
                    // Defensive: never let a token inject headers into the handshake.
                    String safeTok = gwToken == null ? "" : gwToken.replace("\r", "").replace("\n", "");
                    String tokenHeader = safeTok.isEmpty() ? "" : "X-Device-Token: " + safeTok + "\r\n";
                    String request = "GET " + wsPath + " HTTP/1.1\r\n" +
                            "Host: " + hostHeader + "\r\n" +
                            "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
                            "Sec-WebSocket-Key: " + wsKey + "\r\nSec-WebSocket-Version: 13\r\n" +
                            "User-Agent: code-mcp/0.1.0\r\n" +
                            tokenHeader + "\r\n";
                    out.write(request.getBytes(StandardCharsets.US_ASCII));
                    out.flush();

                    // Read response headers (byte-level until \r\n\r\n) with cap.
                    ByteArrayOutputStream hdr = new ByteArrayOutputStream();
                    int b;
                    int last4 = 0; // rolling window of the last 4 bytes
                    while ((b = in.read()) != -1) {
                        hdr.write(b);
                        if (hdr.size() > MAX_GATEWAY_HEADER_BYTES) {
                            throw new IOException("gateway handshake too large");
                        }
                        last4 = ((last4 << 8) | (b & 0xFF)) & 0xFFFFFFFF;
                        if (last4 == 0x0D0A0D0A) { // CRLFCRLF
                            break;
                        }
                    }
                    String headersText = hdr.toString(StandardCharsets.ISO_8859_1);
                    String[] hdrLines = headersText.split("\r\n");
                    if (hdrLines.length == 0 || !hdrLines[0].contains(" 101 ")) {
                        String statusLine = hdrLines.length > 0 ? hdrLines[0] : "<empty>";
                        String hint = statusLine.contains("401")
                                ? " (device auth failed: pass --token or --gateway-token matching the token registered for --id in the gateway)"
                                : "";
                        throw new IOException("WebSocket upgrade failed: " + statusLine + hint);
                    }
                    String accept = null;
                    for (int i = 1; i < hdrLines.length; i++) {
                        int idx = hdrLines[i].indexOf(':');
                        if (idx > 0) {
                            String k = hdrLines[i].substring(0, idx).trim();
                            String v = hdrLines[i].substring(idx + 1).trim();
                            if (k.equalsIgnoreCase("Sec-WebSocket-Accept")) { accept = v; break; }
                        }
                    }
                    String expected = Base64.getEncoder().encodeToString(
                            MessageDigest.getInstance("SHA-1").digest((wsKey + WS_MAGIC).getBytes(StandardCharsets.US_ASCII)));
                    if (accept == null || !MessageDigest.isEqual(
                            accept.getBytes(StandardCharsets.US_ASCII),
                            expected.getBytes(StandardCharsets.US_ASCII))) {
                        throw new IOException("Sec-WebSocket-Accept mismatch");
                    }

                    retries = 0;
                    System.err.println("[gateway] connected, registering as " + deviceId);
                    String register = "{\"type\":\"register\",\"deviceId\":\"" + escapeJson(deviceId) + "\"}";
                    sendFrame(out, register.getBytes(StandardCharsets.UTF_8), (byte) 0x81);

                    // Proactive app-layer keepalive every 25s.
                    // HTTP/2 tunnels (cloudflared) can swallow WS control ping/pong;
                    // data frames always propagate. Send failure breaks TCP and
                    // closes the socket so the read loop reconnects.
                    final AtomicBoolean stopKa = new AtomicBoolean(false);
                    final Socket sockRef = sock;
                    final DataOutputStream outRef = out;
                    Thread keepalive = new Thread(() -> {
                        byte[] payload = "{\"type\":\"keepalive\"}".getBytes(StandardCharsets.UTF_8);
                        while (!stopKa.get()) {
                            try { Thread.sleep(25_000); }
                            catch (InterruptedException ie) { return; }
                            if (stopKa.get()) return;
                            try {
                                sendFrame(outRef, payload, (byte) 0x81);
                            } catch (IOException ioe) {
                                System.err.println("[gateway] keepalive send failed: " + ioe.getMessage());
                                try { sockRef.close(); } catch (IOException ignored) {}
                                return;
                            }
                        }
                    }, "gw-keepalive");
                    keepalive.setDaemon(true);
                    keepalive.start();

                    try {
                        webSocketReadLoop(in, out, sock);
                    } finally {
                        stopKa.set(true);
                        keepalive.interrupt();
                        // Brief join so a mid-flight sendFrame finishes before the
                        // outer finally closes the socket; bounded to stay responsive.
                        try { keepalive.join(100); } catch (InterruptedException ignored) {}
                    }
                } catch (Exception e) {
                    System.err.println("[gateway] error: " + e.getClass().getSimpleName() + ": " + e.getMessage());
                } finally {
                    if (sock != null) try { sock.close(); } catch (IOException ignored) {}
                }
                if (++retries > MAX_RETRIES) {
                    // Backoff hard but keep HTTP server alive (do NOT System.exit).
                    System.err.println("[gateway] max retries reached; backing off 60s");
                    try { Thread.sleep(60_000); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); return; }
                    retries = 0;
                    continue;
                }
                try { Thread.sleep(RECONNECT_DELAY_MS); } catch (InterruptedException ignored) { return; }
            }
        }, "gw-client");
        t.setDaemon(true);
        t.start();
    }

    // Bounds in-flight gateway relays: a gateway flooding faster than we drain
    // must get an immediate busy response, never queue unboundedly or run on
    // the WS read-loop thread (CallerRunsPolicy would stall keepalives and churn).
    private static final Semaphore GATEWAY_DISPATCH_SLOTS = new Semaphore(64);

    private static void handleGatewayMessage(DataOutputStream out, String data, Socket sock) {
        if (!GATEWAY_DISPATCH_SLOTS.tryAcquire()) {
            // Backpressure: answer with a busy error instead of queueing forever.
            try {
                Map<String, Object> json = parseJsonObject(data, 257);
                Object req = json.get("request");
                Map<String, Object> err = new LinkedHashMap<>();
                err.put("jsonrpc", "2.0");
                err.put("id", req instanceof Map<?, ?> request ? request.get("id") : null);
                err.put("error", Map.of("code", -32000, "message", "gateway relay overloaded"));
                Map<String, Object> tunnelRes = new LinkedHashMap<>();
                tunnelRes.put("id", json.get("id"));
                tunnelRes.put("response", err);
                sendFrame(out, MCPRouteHandler.serializeResult(tunnelRes).getBytes(StandardCharsets.UTF_8), (byte) 0x81);
            } catch (JsonDepthException | JsonNumberException excessive) {
                try { sock.close(); } catch (IOException ignored) {}
            } catch (Exception ignored) {}
            return;
        }
        // Submit to dispatch pool so a slow tool call does not block the WebSocket read loop.
        GATEWAY_DISPATCH.submit(() -> {
            try {
                Map<String, Object> json = parseJsonObject(data, 257);
                String id = String.valueOf(json.get("id"));
                @SuppressWarnings("unchecked")
                Object req = json.get("request");
                String tok = json.containsKey("token") ? String.valueOf(json.get("token")) : null;

                // In-process dispatch: handleMcpBody mirrors the /mcp HTTP handler
                // exactly, so tunneled calls skip the local HTTP round trip
                // (per-call TCP + HTTP overhead) - critical under heavy load.
                Map<String, Object> mcpRes;
                try {
                    String respBody = MCPRouteHandler.handleMcpBody(MCPRouteHandler.serializeResult(req));
                    // Notification: handleMcpBody returns null -> reply
                    // response:null so the gateway answers 204 No Content
                    // (strict clients reject error bodies for notifications).
                    mcpRes = respBody == null ? null : parseJsonObject(respBody);
                } catch (Exception e) {
                    Map<String, Object> err = new LinkedHashMap<>();
                    err.put("jsonrpc", "2.0");
                    err.put("id", req instanceof Map<?, ?> request ? request.get("id") : null);
                    // Sanitize: an exception message may embed the localhost URL
                    // including the relayed ?token= - never echo it back through
                    // the tunnel (the token is the device credential).
                    String msg = e.getMessage();
                    if (msg != null) {
                        int q = msg.indexOf("?token=");
                        if (q >= 0) msg = msg.substring(0, q) + "?token=***";
                    }
                    err.put("error", Map.of("code", -32603, "message", msg));
                    mcpRes = err;
                }

                Map<String, Object> tunnelRes = new LinkedHashMap<>();
                tunnelRes.put("id", id);
                tunnelRes.put("response", mcpRes);

                sendFrame(out, MCPRouteHandler.serializeResult(tunnelRes).getBytes(StandardCharsets.UTF_8), (byte) 0x81);
            } catch (JsonDepthException | JsonNumberException excessive) {
                // Parsing failed before a trustworthy request ID was available.
                try { sock.close(); } catch (IOException ignored) {}
            } catch (Exception e) {
                System.err.println("[gateway] dispatch error: " + e.getMessage());
            } finally {
                GATEWAY_DISPATCH_SLOTS.release();
            }
        });
    }

    private static void webSocketReadLoop(InputStream in, DataOutputStream out, Socket sock) throws IOException {
        ByteArrayOutputStream messageBuf = new ByteArrayOutputStream();
        // If nothing inbound for this long, treat the connection as dead and force
        // reconnect. Client sends a keepalive every 25s and the gateway replies
        // with keepalive-ack, so 75s of total silence means the path is broken
        // (e.g. half-open TCP behind a tunnel that didn't propagate FIN).
        long lastInboundMs = System.currentTimeMillis();
        final long INBOUND_DEADLINE_MS = 75_000L;
        while (true) {
            int b0;
            try {
                b0 = in.read();
            } catch (SocketTimeoutException e) {
                if (System.currentTimeMillis() - lastInboundMs > INBOUND_DEADLINE_MS) {
                    throw new IOException("ws: no inbound for " + INBOUND_DEADLINE_MS + "ms, forcing reconnect");
                }
                continue;
            }
            if (b0 == -1) break;
            lastInboundMs = System.currentTimeMillis();
            boolean fin = (b0 & 0x80) != 0;
            int opcode = b0 & 0x0F;

            int b1 = in.read();
            if (b1 == -1) break;
            boolean masked = (b1 & 0x80) != 0;
            long len = b1 & 0x7F;
            if (len == 126) {
                int h = in.read();
                int l = in.read();
                if (h == -1 || l == -1) break;
                len = ((h & 0xFFL) << 8) | (l & 0xFFL);
            } else if (len == 127) {
                len = 0;
                for (int j = 0; j < 8; j++) {
                    int x = in.read();
                    if (x == -1) return;
                    len = (len << 8) | (x & 0xFFL);
                }
            }
            if (len < 0 || len > MAX_WS_FRAME_BYTES) {
                throw new IOException("ws frame too large: " + len);
            }
            // RFC 6455 5.5: control frame payloads are at most 125 bytes. Without
            // this a 64MB ping would be buffered and echoed as a pong (memory +
            // bandwidth amplification from a chatty gateway).
            if ((opcode == 0x8 || opcode == 0x9 || opcode == 0xA) && len > 125) {
                throw new IOException("ws: control frame too large: " + len);
            }
            byte[] mask = new byte[4];
            if (masked) {
                if (readFully(in, mask, 0, 4, System.currentTimeMillis() + INBOUND_DEADLINE_MS) != 4) break;
            }
            byte[] payload = new byte[(int) len];
            if (len > 0) {
                int got = readFully(in, payload, 0, (int) len, System.currentTimeMillis() + INBOUND_DEADLINE_MS);
                if (got != (int) len) break;
            }
            if (masked) {
                for (int j = 0; j < payload.length; j++) {
                    payload[j] = (byte) (payload[j] ^ mask[j & 3]);
                }
            }

            switch (opcode) {
                case 0x8: // close
                    try { sendFrame(out, payload.length > 0 ? Arrays.copyOf(payload, Math.min(payload.length, 125)) : new byte[0], (byte) 0x88); } catch (IOException ignored) {}
                    return;
                case 0x9: // ping → pong
                    try { sendFrame(out, payload, (byte) 0x8A); } catch (IOException ignored) {}
                    continue;
                case 0xA: // pong
                    continue;
                case 0x0: case 0x1: case 0x2:
                    messageBuf.write(payload);
                    // Enforce the cap across FRAGMENTS too: endless continuation
                    // frames must not grow the message buffer without bound (OOM guard).
                    if (messageBuf.size() > MAX_WS_FRAME_BYTES) {
                        throw new IOException("ws: fragmented message too large");
                    }
                    if (fin) {
                        String msg = messageBuf.toString(StandardCharsets.UTF_8);
                        messageBuf.reset();
                        if (msg.contains("\"request\"")) {
                            handleGatewayMessage(out, msg, sock);
                        }
                    }
                    break;
                default:
                    throw new IOException("ws: unknown opcode " + opcode);
            }
        }
    }

    private static int readFully(InputStream in, byte[] buf, int off, int len, long deadline) throws IOException {
        int total = 0;
        while (total < len) {
            int n;
            try {
                n = in.read(buf, off + total, len - total);
            } catch (SocketTimeoutException e) {
                // A peer that stalls mid-frame must not pin this thread forever:
                // give up once the inbound deadline passes so the reconnect loop
                // can fire (previously this spun on 60s socket timeouts forever).
                if (System.currentTimeMillis() > deadline) {
                    throw new IOException("ws: timed out mid-frame");
                }
                continue;
            }
            if (n == -1) break;
            total += n;
        }
        return total;
    }

    private static void sendFrame(DataOutputStream out, byte[] data, byte opcodeByte) throws IOException {
        // opcodeByte already encodes FIN + opcode (eg. 0x81 = FIN | text).
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        baos.write(opcodeByte & 0xFF);
        if (data.length < 126) {
            baos.write(data.length | 0x80);
        } else if (data.length < 65536) {
            baos.write(126 | 0x80);
            baos.write((data.length >> 8) & 0xFF);
            baos.write(data.length & 0xFF);
        } else {
            baos.write(127 | 0x80);
            long n = data.length;
            for (int i = 7; i >= 0; i--) baos.write((int) ((n >> (i * 8)) & 0xFF));
        }
        byte[] mask = new byte[4];
        WS_RNG.nextBytes(mask);
        baos.write(mask[0] & 0xFF);
        baos.write(mask[1] & 0xFF);
        baos.write(mask[2] & 0xFF);
        baos.write(mask[3] & 0xFF);
        for (int i = 0; i < data.length; i++) {
            baos.write(data[i] ^ mask[i & 3]);
        }
        synchronized (out) {
            out.write(baos.toByteArray());
            out.flush();
        }
    }
}

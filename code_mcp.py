#!/usr/bin/env python3
"""
Code MCP - Minimal MCP server over HTTP with Streamable HTTP transport and JSON-RPC 2.0.
Python 3.10+ only, no external dependencies.
"""

import atexit
import base64
import codecs
from datetime import datetime, timedelta
import concurrent.futures
import functools
import hashlib
import hmac
import http.client
import http.server
import ipaddress
import json
import math
import heapq
import os
import random
import queue
import weakref
import re
import secrets
import select
import shutil
import shlex
import signal
import socket
import socketserver
import ssl
import stat
import struct
import subprocess
import sys
import threading
from contextlib import contextmanager
import time
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from enum import Enum
from functools import lru_cache
from http.server import HTTPServer, BaseHTTPRequestHandler
from io import BytesIO, StringIO
from pathlib import Path
from typing import Any, BinaryIO, Optional

# Configuration
DEFAULT_PORT = 7777
DEFAULT_GATEWAY = "code-mcp.tuanm.workers.dev"  # used by bare `--gateway`
DEFAULT_BIND = "127.0.0.1"
TIMEOUT_MS = 30_000
MAX_OUTPUT = 1_000_000
OUTPUT_CAP_KEEP = 500_000
UPLOAD_TTL_MS = 10 * 60 * 1000
MAX_CONCURRENT_JOBS = 10
MAX_SHELL_CONCURRENCY = 5          # parity with Java's shellSemaphore
_shell_semaphore = threading.BoundedSemaphore(MAX_SHELL_CONCURRENCY)
MAX_REQUEST_BYTES = 100 * 1024 * 1024  # cap request body to 100MB (DoS guard)
MAX_UPLOAD_BYTES = 100 * 1024 * 1024
MAX_UPLOAD_BODY_BYTES = MAX_UPLOAD_BYTES + 1024 * 1024
_UPLOAD_SLOTS = threading.BoundedSemaphore(4)
MAX_READ_BYTES = 100 * 1024 * 1024  # cap single-file reads (memory DoS guard)


def _read_size_error(path: Path) -> str | None:
    """Return an error string if the file exceeds MAX_READ_BYTES, else None."""
    try:
        size = path.stat().st_size
    except OSError:
        return None
    if size > MAX_READ_BYTES:
        return (f"ERROR: file too large ({size} bytes > {MAX_READ_BYTES}); "
                f"use a range, or grep the file instead")
    return None
MAX_GATEWAY_HEADER_BYTES = 64 * 1024   # cap WS handshake response headers
MAX_WS_FRAME_BYTES = 64 * 1024 * 1024  # cap WS frame payload (DoS guard)
DEFAULT_SHELL_TIMEOUT_MS = 60_000  # auto-handoff threshold for shell tools when caller doesn't pass timeout_ms
UPLOAD_TTL_S = 10 * 60  # session id valid for 10 minutes


def _timeout_marker(timeout_ms: int) -> str:
    return (f"\n[TIMEOUT after {timeout_ms}ms — long-running? use the `job` tool: "
            f"mode=start to launch, mode=view to check progress]")


def _backgrounded_marker(timeout_ms: int, job_id: str) -> str:
    return (f"\n[BACKGROUNDED after {timeout_ms}ms — process still running as job {job_id}. "
            f"Above output is a snapshot at handoff; further output continues into the job. "
            f"Use `job` tool: mode=view command={job_id} to read, mode=stop command={job_id} to kill. "
            f"Pass explicit timeout_ms to disable auto-background and force kill-on-timeout instead.]")

# ---------- result spill ----------
# Tool results larger than RESULT_SPILL_THRESHOLD bytes are written to a file
# under RESULT_SPILL_ROOT and replaced in the response with a head + pointer.
# Matches Java/TS behaviour byte-for-byte so the three impls produce
# interchangeable output.
import tempfile as _tempfile
RESULT_SPILL_THRESHOLD = 10_000
RESULT_SPILL_HEAD = 3_000
RESULT_SPILL_ROOT = Path(_tempfile.gettempdir()) / "code-mcp"
try:
    RESULT_SPILL_ROOT.mkdir(parents=True, exist_ok=True)
    # Spill files hold tool output (potentially secrets): keep the root
    # private and sweep files older than 24h so a long session can't fill the
    # disk or leave world-readable data behind (default mkdir is 0777&~umask).
    os.chmod(RESULT_SPILL_ROOT, 0o700)
    _spill_cutoff = time.time() - 86_400
    for _p in RESULT_SPILL_ROOT.iterdir():
        try:
            if _p.is_file() and _p.stat().st_mtime < _spill_cutoff:
                _p.unlink()
        except OSError:
            pass
except OSError:
    pass


def _spill_tool_name(tool_name):
    return re.sub(r"[^A-Za-z0-9_.-]", "_", (tool_name or "unknown")[:64])


def maybe_spill_text(text: str, tool_name: str = "") -> str:
    """If text exceeds RESULT_SPILL_THRESHOLD bytes, write it to a spill file
    and return a head preview + pointer. Otherwise return text unchanged.
    Mirrors maybeSpillText() in CodeMCP.java and code-mcp.ts."""
    if not isinstance(text, str):
        return text
    try:
        raw = text.encode("utf-8")
    except UnicodeEncodeError:
        # A plain UTF-8 file cannot represent isolated UTF-16 code units.
        encoded = json_utf8(text)
        if len(encoded) <= RESULT_SPILL_THRESHOLD:
            return text
        return ("[JSON-encoded text: JSON-decode the saved file contents to recover the original string.]\n"
                + maybe_spill_text(encoded.decode("utf-8"), tool_name))
    if len(raw) <= RESULT_SPILL_THRESHOLD:
        return text
    head = raw[:RESULT_SPILL_HEAD].decode("utf-8", errors="replace")
    last_nl = head.rfind("\n")
    if last_nl > 0:
        head = head[:last_nl]
    ts = time.strftime("%Y%m%dT%H%M%S", time.gmtime()) + f"{int((time.time() % 1) * 1000):03d}"
    safe_tool = _spill_tool_name(tool_name)
    short_id = secrets.token_hex(4)
    fname = f"{ts}-{safe_tool}-{short_id}.txt"
    path = RESULT_SPILL_ROOT / fname
    total_lines = text.count("\n") + 1 if text else 0
    try:
        # 0600: tool results can contain secrets; never world-readable.
        with open(path, "wb") as _fh:
            _fh.write(raw)
        os.chmod(path, 0o600)
    except OSError as e:
        return (head + f"\n[TRUNCATED: full output is {len(raw)} bytes "
                f"({total_lines} lines); spill to disk FAILED ({e})]\n")
    return (head + f"\n[TRUNCATED: {len(raw)} bytes ({total_lines} lines) "
            f"saved to {path} — use read with range or grep to view the remaining content]\n")


def _maybe_spill_binary(b64, mime_type, tool_name):
    """Spill decoded bytes; preserve malformed base64 rather than corrupting it."""
    if len(b64) < RESULT_SPILL_THRESHOLD * 4 / 3 or not isinstance(mime_type, str):
        return None
    if not re.fullmatch(r"[A-Za-z0-9+/]*={0,2}", b64) or ("=" in b64 and len(b64) % 4):
        return None
    try:
        raw = base64.b64decode(b64 + "=" * (-len(b64) % 4), validate=True)
        if base64.b64encode(raw).decode("ascii").rstrip("=") != b64.rstrip("="):
            return None
    except ValueError:
        return None
    if len(raw) <= RESULT_SPILL_THRESHOLD:
        return None
    ts = time.strftime("%Y%m%dT%H%M%S", time.gmtime()) + f"{int((time.time() % 1) * 1000):03d}"
    safe_tool = _spill_tool_name(tool_name)
    slash = mime_type.find("/")
    ext = re.sub(r"[^A-Za-z0-9]", "", mime_type[slash + 1:slash + 17].split("/", 1)[0]) if slash >= 0 else "bin"
    path = RESULT_SPILL_ROOT / f"{ts}-{safe_tool}-{secrets.token_hex(4)}.{ext or 'bin'}"
    try:
        path.write_bytes(raw)
        os.chmod(path, 0o600)
    except OSError as error:
        return {"type": "text", "text": maybe_spill_text(f"[TRUNCATED: {mime_type} payload of {len(raw)} bytes; spill to disk FAILED ({error}). Payload dropped.]", tool_name)}
    return {"type": "text", "text": maybe_spill_text(f"[TRUNCATED: {mime_type} payload of {len(raw)} bytes, saved to {path} — read the file directly to access it.]", tool_name)}


def _spill_content_blocks(content, tool_name):
    if not isinstance(content, list):
        return content
    result = []
    for block in content:
        replacement = block
        if isinstance(block, dict):
            kind = block.get("type")
            spilled = None
            if kind == "text" and isinstance(block.get("text"), str):
                replacement = {**block, "text": maybe_spill_text(block["text"], tool_name)}
            elif kind in ("image", "audio") and isinstance(block.get("data"), str):
                mime = block.get("mimeType")
                if mime is None:
                    mime = "image/png" if kind == "image" else "application/octet-stream"
                spilled = _maybe_spill_binary(block["data"], mime, tool_name)
            elif kind == "resource" and isinstance(block.get("resource"), dict):
                resource = block["resource"]
                if isinstance(resource.get("text"), str):
                    replacement = {**block, "resource": {**resource, "text": maybe_spill_text(resource["text"], tool_name)}}
                elif isinstance(resource.get("blob"), str):
                    mime = resource.get("mimeType")
                    spilled = _maybe_spill_binary(resource["blob"], "application/octet-stream" if mime is None else mime, tool_name)
            if spilled is not None:
                replacement = {**{key: value for key, value in block.items() if key not in ("data", "mimeType", "resource")}, **spilled}
        result.append(replacement)
    return result

# Global state
jobs: dict[str, dict] = {}
job_seq = 0
total_jobs = 0
jobs_lock = threading.Lock()
memo_lock = threading.Lock()
shutting_down = False
port = DEFAULT_PORT
bind_addr = DEFAULT_BIND
token: Optional[str] = None
gateway_domain: Optional[str] = None
gateway_token: Optional[str] = None  # device credential sent on the /ws upgrade (defaults to --token)
gateway_device_id: Optional[str] = None
gateway_lock = threading.Lock()
assigned_device_id: Optional[str] = None
memory_enabled = False
has_cloudflared = False
mcp_config_path: Optional[str] = None
disallowed_tools: set[str] = set()
public_domain: Optional[str] = None
make_public = False
public_base_url: Optional[str] = None
_public_tunnel_state = None  # atomic (public URL, owned job) snapshot
_gateway_dispatch_pool: Optional[Any] = None  # lazy-initialized ThreadPoolExecutor, reused across gateway reconnects
_gateway_dispatch_slots = threading.BoundedSemaphore(64)  # bound in-flight tunnel relays (backpressure)

def check_cloudflared() -> bool:
    # Availability is PATH-based, like the other implementations. Do not run
    # the optional binary during discovery; report launch failures on use.
    return find_on_path("cloudflared")


class ShellType(Enum):
    BASH = "bash"
    SH = "sh"
    CMD = "cmd"
    POWERSHELL = "pwsh"


def detect_shell() -> ShellType:
    if sys.platform == "win32":
        return ShellType.CMD
    return ShellType.BASH


def find_on_path(name: str) -> bool:
    try:
        if sys.platform == "win32":
            result = subprocess.run(
                ["where", name],
                capture_output=True, timeout=5,
                env=build_child_env(),
            )
        else:
            # sh -c "command -v name" — sh has a built-in default PATH when
            # PATH is unset, so detection works even under a stripped env
            # (parity with the TS/Java hasOnPath which use the same probe).
            result = subprocess.run(
                ["sh", "-c", "command -v " + name],
                capture_output=True, timeout=5,
                env=build_child_env(),
            )
        return result.returncode == 0
    except Exception:
        return False


@functools.lru_cache(maxsize=1)
def has_rg() -> bool:
    return find_on_path("rg")


@functools.lru_cache(maxsize=1)
def has_findstr() -> bool:
    return find_on_path("findstr")


def detect_powershell_binary() -> Optional[str]:
    """Return the PowerShell executable to invoke ('pwsh' for 7+, 'powershell' for 5.1), or None."""
    if find_on_path("pwsh"):
        return "pwsh"
    if find_on_path("powershell"):
        return "powershell"
    return None


_powershell_binary_cache: Optional[str] = None
_powershell_binary_checked = False


def get_powershell_binary() -> Optional[str]:
    global _powershell_binary_cache, _powershell_binary_checked
    if not _powershell_binary_checked:
        _powershell_binary_cache = detect_powershell_binary()
        _powershell_binary_checked = True
    return _powershell_binary_cache


def detect_shell_type() -> ShellType:
    if sys.platform == "win32":
        # PSModulePath is set inside any PowerShell session (5.1 or 7+). Use that
        # as the authoritative signal AND require a usable powershell binary.
        if os.environ.get("PSModulePath") and get_powershell_binary():
            return ShellType.POWERSHELL
        return ShellType.CMD
    if find_on_path("bash"):
        return ShellType.BASH
    return ShellType.SH


_shell_type_cache: Optional[ShellType] = None


def get_shell_type() -> ShellType:
    """Lazy + cached shell detection so importing the module doesn't run subprocess."""
    global _shell_type_cache
    if _shell_type_cache is None:
        _shell_type_cache = detect_shell_type()
    return _shell_type_cache


def _valid_public_domain(value: str) -> bool:
    match = re.fullmatch(r"([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?", value)
    if not match or (match[2] is not None and not 1 <= int(match[2]) <= 65535):
        return False
    host = match[1].removesuffix(".")
    if not host or len(host) > 253:
        return False
    labels = host.split(".")
    if any(len(label) > 63 or not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?", label) for label in labels):
        return False
    if re.fullmatch(r"(?:[0-9]+|0x[0-9a-f]+)", labels[-1], re.IGNORECASE):
        return len(labels) == 4 and all(re.fullmatch(r"(?:0|[1-9][0-9]{0,2})", label) and int(label) <= 255 for label in labels)
    return True


def parse_args(args: list[str]) -> tuple[int, str | None, str | None, str | None]:
    """Returns (port, token, gateway_domain, device_id). Other flags set as module globals."""
    global memory_enabled, has_cloudflared, mcp_config_path, disallowed_tools
    global public_domain, make_public, bind_addr
    port = DEFAULT_PORT
    env_port = os.environ.get("PORT")
    if env_port:
        try:
            port = int(env_port)
        except ValueError:
            print(f"ERROR: invalid $PORT={env_port}", file=sys.stderr)
            sys.exit(2)
    token = None
    gateway_domain = None
    device_id = None
    global gateway_token
    gateway_token = None
    memory_enabled = False
    has_cloudflared = check_cloudflared()
    mcp_config_path = None
    disallowed_tools = set()
    public_domain = None
    make_public = False
    bind_addr = DEFAULT_BIND
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--port" and i + 1 < len(args):
            try:
                port = int(args[i + 1])
            except ValueError:
                print(f"ERROR: invalid --port {args[i + 1]}", file=sys.stderr)
                sys.exit(2)
            if not (1 <= port <= 65535):
                print(f"ERROR: --port out of range: {port}", file=sys.stderr)
                sys.exit(2)
            i += 2
        elif arg == "--token" and i + 1 < len(args):
            token = args[i + 1]
            i += 2
        elif arg == "--gateway-token" and i + 1 < len(args):
            gateway_token = args[i + 1]
            i += 2
        elif arg == "--gateway":
            # Bare --gateway (no URL) connects to the default managed gateway.
            if i + 1 < len(args) and not args[i + 1].startswith("--"):
                gateway_domain = args[i + 1]
                i += 2
            else:
                gateway_domain = DEFAULT_GATEWAY
                i += 1
        elif arg == "--id" and i + 1 < len(args):
            device_id = args[i + 1]
            i += 2
        elif arg == "--bind" and i + 1 < len(args):
            bind_addr = args[i + 1]
            i += 2
        elif arg == "--enable-memory":
            memory_enabled = True
            i += 1
        elif arg == "--mcp" and i + 1 < len(args):
            mcp_config_path = args[i + 1]
            i += 2
        elif arg == "--public":
            make_public = True
            i += 1
        elif arg == "--domain" and i + 1 < len(args):
            public_domain = args[i + 1]
            i += 2
        elif arg == "--disallowed-tools" and i + 1 < len(args):
            disallowed_tools = {t.strip() for t in args[i + 1].split(",") if t.strip()}
            i += 2
        elif arg == "-h" or arg == "--help":
            print(USAGE)
            sys.exit(0)
        else:
            i += 1
    if make_public and public_domain:
        print("ERROR: --public and --domain are mutually exclusive", file=sys.stderr)
        sys.exit(2)
    if (make_public or public_domain) and not token:
        print("ERROR: --public/--domain require --token (otherwise the server is an unauthenticated remote shell)", file=sys.stderr)
        sys.exit(2)
    if public_domain is not None and not _valid_public_domain(public_domain):
        print(f"ERROR: invalid --domain: {public_domain!r}", file=sys.stderr)
        sys.exit(2)
    return port, token, gateway_domain, device_id


USAGE = """Code MCP - Minimal MCP server over HTTP

Usage: code_mcp.py [flags]

Flags:
  --port <n>            Listen port (default: 7777 or $PORT)
  --bind <addr>         Bind address (default: 127.0.0.1)
  --token <s>           Require ?token=<s> on every request
  --gateway [url]       Connect to gateway server; bare flag uses the default
                        (wss://code-mcp.tuanm.workers.dev)
  --id <uuid>           Use specific device ID for gateway connection
  --gateway-token <s>   Device credential sent to the gateway on connect
                        (defaults to --token; must match the token registered
                        for --id in the gateway device registry)
  --enable-memory       Enable remember/forget/recall tools
  --mcp <path>          Aggregate tools from external MCP servers
  --public              Expose via Cloudflare quick tunnel (requires cloudflared)
  --domain <host>       Use existing public hostname (mutually exclusive with --public)
  --disallowed-tools <list>  Comma-separated tools to disable

Tools: read, write, edit, multi_edit, bash, grep, find, ls, job, mcp
"""


def jsonrpc_request(method: str, params: dict | None = None) -> dict:
    return {
        "jsonrpc": "2.0",
        "id": str(uuid.uuid4()),
        "method": method,
        "params": params or {}
    }


def jsonrpc_response(id: str, result: Any) -> dict:
    return {
        "jsonrpc": "2.0",
        "id": id,
        "result": result
    }


def jsonrpc_error(id: str, code: int, message: str, data: Any = None) -> dict:
    err = {"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}
    if data:
        err["error"]["data"] = data
    return err


def json_utf8(data) -> bytes:
    # JSON can represent isolated UTF-16 code units as escapes. Preserve them
    # without emitting invalid UTF-8 or losing an already-executed call's reply.
    return json.dumps(data, ensure_ascii=False).encode("utf-8", errors="backslashreplace")


def valid_mcp_request(data) -> bool:
    if not isinstance(data, dict) or data.get("jsonrpc") != "2.0" or not isinstance(data.get("method"), str):
        return False
    request_id = data.get("id")
    return (request_id is None or isinstance(request_id, str) or type(request_id) is int
            or (type(request_id) is float and math.isfinite(request_id)))


def parse_jsonrpc_request(data: dict) -> tuple[str, str, dict | None]:
    method = data.get("method", "")
    params = data.get("params")
    req_id = data.get("id")
    return req_id, method, params


def safe_resolve(cwd: str, user_path: str, allow_spill: bool = False) -> tuple[bool, Path, str]:
    """Resolve path safely, ensuring it stays within cwd. Returns (ok, resolved_path, error_msg)."""
    try:
        cwd_path = Path(cwd).resolve()
        # Handle both absolute paths and relative paths
        if Path(user_path).is_absolute():
            # Absolute paths: resolve symlinks but keep absolute
            full_path = Path(user_path).resolve()
        else:
            full_path = (cwd_path / user_path).resolve()
        # Ensure the resolved path is within cwd
        try:
            full_path.relative_to(cwd_path)
        except ValueError:
            # Spill files live under RESULT_SPILL_ROOT, outside cwd. read/grep
            # must reach them because spill markers point callers at that path.
            if allow_spill:
                try:
                    full_path.relative_to(RESULT_SPILL_ROOT.resolve())
                    return True, full_path, ""
                except ValueError:
                    pass
            return False, full_path, f"path escapes cwd: {user_path}"
        return True, full_path, ""
    except Exception as e:
        return False, Path("."), f"invalid path: {user_path}"


class ToolFailure(str):
    """Typed failure, independent of any prefix present in ordinary file text."""


class WriteFailure(ToolFailure):
    pass


class ReadFailure(ToolFailure):
    pass


class EditFailure(ToolFailure):
    pass


class MultiEditFailure(ToolFailure):
    pass


class ShellFailure(ToolFailure):
    pass


class McpFailure(ToolFailure):
    pass


class JobFailure(ToolFailure):
    pass


class LsFailure(ToolFailure):
    pass


class FindFailure(ToolFailure):
    pass


class GrepFailure(ToolFailure):
    pass


_READ_RANGE_OMITTED = object()


def read_file(path: str, cwd: str = None,
              range=_READ_RANGE_OMITTED, no_truncate: bool = False) -> str:
    try:
        for name, value in (("cwd", cwd), ("path", path)):
            if not isinstance(value, str) or not value:
                raise ValueError(f"{name} must be a nonempty string")
            if "\0" in value:
                raise ValueError(f"{name} contains NUL")
            value.encode("utf-8", errors="strict")
        if type(no_truncate) is not bool:
            raise ValueError("no_truncate must be a boolean")
        whole_file = range is _READ_RANGE_OMITTED
        start, end = 1, 9007199254740991
        if not whole_file:
            if (not isinstance(range, list) or len(range) != 2 or
                    any(type(n) not in (int, float) or not 1 <= n <= 9007199254740991
                        or int(n) != n for n in range) or range[0] > range[1]):
                raise ValueError("range must be [start, end] integers with 1 <= start <= end <= 9007199254740991")
            start, end = map(int, range)
        shape = path.replace("\\", "/") if os.name == "nt" else path
        if shape.rsplit("/", 1)[-1] in ("", ".", ".."):
            raise ValueError("read path must name a file")
        root = Path(cwd).resolve(strict=True)
        if not root.is_dir():
            raise ValueError("cwd must be an existing directory")
        target = _write_target(root, path, allow_spill=True)
        before = target.lstat()
        if not stat.S_ISREG(before.st_mode):
            raise ValueError("not a regular file")
        # Nonblocking/no-follow avoid a swapped FIFO blocking, or a swapped final
        # symlink being followed. fstat checks the opened object on all platforms.
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(target, flags)
        try:
            with os.fdopen(fd, "rb", buffering=0) as source:
                fd = None
                initial = os.fstat(source.fileno())
                if (not stat.S_ISREG(initial.st_mode) or
                        (initial.st_dev, initial.st_ino) != (before.st_dev, before.st_ino)):
                    raise ValueError("file changed while opening")
                if whole_file and initial.st_size > MAX_READ_BYTES:
                    raise ValueError(f"selected content exceeds {MAX_READ_BYTES} bytes")
                remaining = initial.st_size
                # Some regular virtual files report zero bytes but provide text.
                # Probe EOF in that case, bounding even an unselected prefix.
                unknown_size = remaining == 0
                scanned = 0
                line = 1
                selected = bytearray()
                while unknown_size or remaining:
                    limit = MAX_READ_BYTES + 1 - scanned if unknown_size else remaining
                    chunk = source.read(min(65536, limit))
                    if not chunk:
                        if unknown_size:
                            break
                        raise ValueError("file truncated while reading")
                    scanned += len(chunk)
                    if unknown_size and scanned > MAX_READ_BYTES:
                        raise ValueError("zero-size file exceeded read scan limit")
                    if not unknown_size:
                        remaining -= len(chunk)
                    if line < start:
                        count = chunk.count(b"\n")
                        if line + count < start:
                            line += count
                            continue
                        chunk = chunk.split(b"\n", start - line)[-1]
                        line = start
                    count = chunk.count(b"\n")
                    finished = line + count > end
                    if finished:
                        chunk = b"\n".join(chunk.split(b"\n", end - line + 1)[:-1])
                    if len(selected) + len(chunk) > MAX_READ_BYTES:
                        raise ValueError(f"selected content exceeds {MAX_READ_BYTES} bytes")
                    selected.extend(chunk)
                    if finished:
                        break
                    line += count
                final = os.fstat(source.fileno())
                if final.st_size != initial.st_size or final.st_mtime_ns != initial.st_mtime_ns:
                    raise ValueError("file changed while reading")
        finally:
            if fd is not None:
                os.close(fd)
        content = selected.decode("utf-8", errors="strict")
        return content if no_truncate else maybe_spill_text(content, "read")
    except Exception as e:
        return ReadFailure(f"ERROR: {e}")


def _write_target(root: Path, path: str, allow_spill: bool = False) -> Path:
    requested = Path(path) if Path(path).is_absolute() else root / path
    # Resolve in physical component order, including a symlink reached after
    # missing/.., and reject a regular file used as a parent (even before ..).
    target = Path(requested.anchor)
    for part in requested.parts[1:]:
        if target.exists() and not target.is_dir():
            raise NotADirectoryError("write parent is not a directory")
        if part == "..":
            target = target.parent
        elif part != ".":
            target = target / part
            if target.is_symlink():
                target = target.resolve(strict=True)
            elif target.exists():
                target = target.resolve()
    try:
        target.relative_to(root)
    except ValueError:
        if not allow_spill:
            raise
        target.relative_to(RESULT_SPILL_ROOT.resolve())
    if target == root:
        raise ValueError("not a regular file")
    return target


def _write_check_target(info):
    if info is not None:
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("not a regular file")
        if not info.st_mode & 0o222:
            raise PermissionError("destination is not writable")


def _write_identity(info):
    # Windows Python versions disagree between stat and fstat about ctime
    # (creation time versus metadata-change time). Never compare those unlike
    # timestamps; native file identity, size and mtime remain comparable.
    return None if info is None else (info.st_dev, info.st_ino, info.st_size,
                                     info.st_mtime_ns,
                                     info.st_ctime_ns if os.name != "nt" else None)


def _write_verify_parents(parents):
    for path, original in parents:
        current = path.lstat()
        if not stat.S_ISDIR(current.st_mode) or (current.st_dev, current.st_ino) != (original.st_dev, original.st_ino):
            raise OSError("parent changed during write")


def _write_copy_metadata(source: Path, destination: Path):
    """Use OS copy tools because Python has no macOS ACL/Windows DACL API."""
    if sys.platform == "darwin":
        command = ["/bin/cp", "-p", str(source), str(destination)]
    elif os.name == "posix":
        command = ["/bin/cp", "--attributes-only", "--preserve=mode,ownership,timestamps,xattr", "--", str(source), str(destination)]
    elif os.name == "nt":
        powershell = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
        def literal(value):
            encoded = base64.b64encode(str(value).encode("utf-16-le")).decode("ascii")
            return "[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('" + encoded + "'))"
        script = ("$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; "
                  "$s=" + literal(source) + "; $d=" + literal(destination) + "; "
                  "Copy-Item -LiteralPath $s -Destination $d -Force -ErrorAction Stop; "
                  "$acl=Get-Acl -LiteralPath $s; Set-Acl -LiteralPath $d -AclObject $acl -ErrorAction Stop")
        command = [str(powershell), "-NoProfile", "-NonInteractive", "-EncodedCommand",
                   base64.b64encode(script.encode("utf-16-le")).decode("ascii")]
    else:
        raise OSError("metadata-preserving overwrite is unsupported on this platform")
    copied = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=30, check=False)
    if copied.returncode:
        raise OSError("metadata copy failed: " + copied.stderr.decode("utf-8", errors="replace").strip())


def _write_check_expected(target: Path, original, expected_snapshot):
    # Edit pins the physical destination and its pre-read snapshot. Ordinary
    # Write has no expected snapshot and retains its existing behavior.
    if expected_snapshot is not None:
        expected_target, expected_identity = expected_snapshot
        if target != expected_target or _write_identity(original) != expected_identity:
            raise OSError("destination changed since edit read")


def _write_atomic_posix(root: Path, target: Path, data: bytes, expected_snapshot=None, before_commit=None):
    # Traverse canonical components through pinned directory handles. O_NOFOLLOW
    # prevents a swapped ancestor symlink from redirecting mkdir/open/replace.
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fds = []
    temp_name = None
    try:
        parent = os.open(str(root), flags)
        fds.append(parent)
        parents = [(root, os.fstat(parent))]
        parent_path = root
        parts = target.relative_to(root).parts
        for part in parts[:-1]:
            try:
                child = os.open(part, flags, dir_fd=parent)
            except FileNotFoundError:
                if expected_snapshot is not None:
                    raise OSError("parent changed since edit read")
                try:
                    os.mkdir(part, dir_fd=parent)
                except FileExistsError:
                    pass
                child = os.open(part, flags, dir_fd=parent)
            fds.append(child)
            parent = child
            parent_path = parent_path / part
            parents.append((parent_path, os.fstat(parent)))
        name = parts[-1]
        try:
            original = os.stat(name, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            original = None
        _write_check_target(original)
        _write_check_expected(target, original, expected_snapshot)
        if original is not None:
            # Check actual access/ACLs without truncating, and reject a swap.
            check_fd = os.open(name, os.O_WRONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                checked = os.fstat(check_fd)
                if (checked.st_dev, checked.st_ino) != (original.st_dev, original.st_ino):
                    raise OSError("destination changed during write")
            finally:
                os.close(check_fd)
        candidate = ".code-mcp-write-" + secrets.token_hex(16)
        fd = os.open(candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=parent)
        temp_name = candidate
        os.close(fd)
        if original is not None:
            _write_verify_parents(parents)
            if _write_identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) != _write_identity(original):
                raise OSError("destination changed during write")
            _write_copy_metadata(target, target.parent / temp_name)
            _write_verify_parents(parents)
            if _write_identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) != _write_identity(original):
                raise OSError("destination changed during write")
        staged = os.stat(temp_name, dir_fd=parent, follow_symlinks=False)
        _write_check_target(staged)
        if staged.st_nlink != 1:
            raise OSError("temporary file has hardlink aliases")
        fd = os.open(temp_name, os.O_WRONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        with os.fdopen(fd, "wb") as stream:
            opened = os.fstat(stream.fileno())
            if _write_identity(opened) != _write_identity(staged):
                raise OSError("temporary file changed during write")
            stream.truncate(0)
            stream.write(data)
            stream.flush()
            if original is not None:
                if (opened.st_uid, opened.st_gid) != (original.st_uid, original.st_gid):
                    os.fchown(stream.fileno(), original.st_uid, original.st_gid)
                if stat.S_IMODE(opened.st_mode) != stat.S_IMODE(original.st_mode):
                    os.fchmod(stream.fileno(), stat.S_IMODE(original.st_mode))
            os.fsync(stream.fileno())
            written = os.fstat(stream.fileno())
        try:
            current = os.stat(name, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            current = None
        _write_check_target(current)
        if _write_identity(original) != _write_identity(current):
            raise OSError("destination changed during write")
        _write_verify_parents(parents)
        if _write_identity(os.stat(temp_name, dir_fd=parent, follow_symlinks=False)) != _write_identity(written):
            raise OSError("temporary file changed during write")
        if before_commit is not None:
            before_commit()
        os.replace(temp_name, name, src_dir_fd=parent, dst_dir_fd=parent)
        temp_name = None
    finally:
        if temp_name is not None:
            try:
                os.unlink(temp_name, dir_fd=parent)
            except FileNotFoundError:
                pass
        for fd in reversed(fds):
            os.close(fd)


def _write_atomic_portable(root: Path, target: Path, data: bytes, expected_snapshot=None, before_commit=None):
    # Windows Python lacks dir_fd operations. Revalidate each parent and target;
    # atomic replacement protects content, but cannot pin ancestry against an
    # adversarial concurrent junction/rename. This is not a sandbox boundary.
    parent = root
    parents = [(root, root.lstat())]
    for part in target.relative_to(root).parts[:-1]:
        parent = parent / part
        if expected_snapshot is None:
            parent.mkdir(exist_ok=True)
        elif not parent.is_dir():
            raise OSError("parent changed since edit read")
        if parent.resolve() != parent:
            raise OSError("parent changed during write")
        parents.append((parent, parent.lstat()))
    try:
        original = target.lstat()
    except FileNotFoundError:
        original = None
    _write_check_target(original)
    _write_check_expected(target, original, expected_snapshot)
    if original is not None:
        with target.open("r+b"):
            pass
    temp = target.parent / (".code-mcp-write-" + secrets.token_hex(16))
    temp_created = False
    try:
        temp_fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        temp_created = True
        os.close(temp_fd)
        if original is not None:
            _write_verify_parents(parents)
            if _write_identity(target.lstat()) != _write_identity(original):
                raise OSError("destination changed during write")
            _write_copy_metadata(target, temp)
            _write_verify_parents(parents)
            if _write_identity(target.lstat()) != _write_identity(original):
                raise OSError("destination changed during write")
        staged = temp.lstat()
        _write_check_target(staged)
        if staged.st_nlink != 1:
            raise OSError("temporary file has hardlink aliases")
        with temp.open("r+b") as stream:
            if _write_identity(os.fstat(stream.fileno())) != _write_identity(staged):
                raise OSError("temporary file changed during write")
            stream.truncate(0)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
            written = os.fstat(stream.fileno())
        if target.parent.resolve() != target.parent:
            raise OSError("parent changed during write")
        try:
            current = target.lstat()
        except FileNotFoundError:
            current = None
        _write_check_target(current)
        if _write_identity(original) != _write_identity(current):
            raise OSError("destination changed during write")
        _write_verify_parents(parents)
        if _write_identity(temp.lstat()) != _write_identity(written):
            raise OSError("temporary file changed during write")
        if before_commit is not None:
            before_commit()
        os.replace(temp, target)
    finally:
        if temp_created:
            temp.unlink(missing_ok=True)


def write_file(path: str, content: str, cwd: str = None) -> str:
    try:
        for name, value in (("cwd", cwd), ("path", path), ("content", content)):
            if not isinstance(value, str):
                raise ValueError(f"{name} must be a string")
            if name != "content" and not value:
                raise ValueError(f"{name} must not be empty")
        for name, value in (("cwd", cwd), ("path", path)):
            if "\0" in value:
                raise ValueError(f"{name} contains NUL")
            value.encode("utf-8", errors="strict")
        shape = path.replace("\\", "/") if os.name == "nt" else path
        if shape.rsplit("/", 1)[-1] in ("", ".", ".."):
            raise ValueError("write path must name a file")
        data = content.encode("utf-8", errors="strict")
        root = Path(cwd).resolve(strict=True)
        if not root.is_dir():
            raise ValueError("cwd must be an existing directory")
        target = _write_target(root, path)
        if os.name == "posix":
            _write_atomic_posix(root, target, data)
        else:
            _write_atomic_portable(root, target, data)
        return f"wrote {len(data)} bytes to {path}"
    except Exception as e:
        return WriteFailure(f"ERROR: {e}")


def edit_file(path: str, old_str: str, new_str: str, cwd: str = None) -> str:
    try:
        for name, value in (("cwd", cwd), ("path", path),
                            ("old_str", old_str), ("new_str", new_str)):
            if not isinstance(value, str):
                raise ValueError(f"{name} must be a string")
            if name != "new_str" and not value:
                raise ValueError(f"{name} must not be empty")
            value.encode("utf-8", errors="strict")
            if name in ("cwd", "path") and "\0" in value:
                raise ValueError(f"{name} contains NUL")
        shape = path.replace("\\", "/") if os.name == "nt" else path
        if shape.rsplit("/", 1)[-1] in ("", ".", ".."):
            raise ValueError("edit path must name a file")
        root = Path(cwd).resolve(strict=True)
        if not root.is_dir():
            raise ValueError("cwd must be an existing directory")
        # Resolve without Read's spill-root allowance, then snapshot before any
        # source read. Read supplies strict decoding and bounded lossless I/O.
        target = _write_target(root, path)
        original = target.lstat()
        _write_check_target(original)
        expected_snapshot = (target, _write_identity(original))
        content = read_file(str(target), str(root), no_truncate=True)
        if isinstance(content, ToolFailure):
            return EditFailure(str(content))
        if _write_target(root, path) != target:
            raise OSError("destination changed during edit read")
        _write_check_expected(target, target.lstat(), expected_snapshot)
        first = content.find(old_str)
        if first < 0:
            raise ValueError("old_str not found")
        if content.find(old_str, first + 1) >= 0:
            raise ValueError("old_str not unique (including overlapping occurrences)")
        data = (content[:first] + new_str + content[first + len(old_str):]).encode("utf-8", errors="strict")
        if os.name == "posix":
            _write_atomic_posix(root, target, data, expected_snapshot)
        else:
            _write_atomic_portable(root, target, data, expected_snapshot)
        return "ok"
    except Exception as e:
        return EditFailure(f"ERROR: {e}")


def _multi_normalize_path(value):
    """Normalize ordinary Win32 DOS components without changing namespaces."""
    if os.name != "nt":
        return value
    if value.startswith(("\\\\?\\", "\\\\.\\")):
        return value
    value = value.replace("/", "\\")
    if value.startswith(("\\\\?\\", "\\\\.\\")):
        return value
    drive, tail = os.path.splitdrive(value)
    # splitdrive preserves drive letters and the UNC server/share prefix.
    parts = tail.split("\\")
    for index, part in enumerate(parts):
        if not part or part in (".", ".."):
            continue
        if index == len(parts) - 1:
            normalized = part.rstrip(". ")
        elif part.endswith(".") and not part.endswith(".."):
            normalized = part[:-1]
        else:
            normalized = part
        if not normalized:
            raise ValueError("multi_edit path component is empty after Win32 normalization")
        # Component-wise physical resolution would expose each parent to
        # terminal Win32 trimming and could silently select a different folder.
        # These literal parent names are outside the ordinary-path contract.
        if index < len(parts) - 1 and normalized.endswith((" ", ".")):
            raise ValueError("multi_edit unsupported ambiguous Windows parent component ending in space or dot")
        parts[index] = normalized
    return drive + "\\".join(parts)


def _multi_identity(info):
    # Our replacement of one hardlink name changes other aliases' ctime only.
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_mode)


def _multi_parents(root, target):
    paths = [root]
    for part in target.relative_to(root).parts[:-1]:
        paths.append(paths[-1] / part)
    parents = []
    for path in paths:
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or path.resolve(strict=True) != path:
            raise OSError("multi_edit parent changed")
        parents.append((path, info))
    return parents


def _multi_verify(record, expected):
    _write_verify_parents(record["parents"])
    target = record["target"]
    if target.parent.resolve(strict=True) != target.parent:
        raise OSError(f"multi_edit parent changed: {target}")
    for requested in record["requests"]:
        if _write_target(record["root"], _multi_normalize_path(requested)) != target:
            raise OSError(f"multi_edit path changed: {requested}")
    current = target.lstat()
    _write_check_target(current)
    if _multi_identity(current) != expected:
        raise OSError(f"multi_edit destination changed: {target}")


def _multi_prepare(record, kind, data, artifacts):
    """Prepare an owned sibling without renaming or modifying the original."""
    _multi_verify(record, record["original"])
    path = record["target"].parent / (".code-mcp-multi-" + kind + "-" + secrets.token_hex(16))
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, 0o600)
    artifact = {"path": path, "identity": os.fstat(fd), "record": record, "retain": False, "moved": False}
    artifacts.append(artifact)
    os.close(fd)
    _write_copy_metadata(record["target"], path)
    _multi_verify(record, record["original"])
    staged = path.lstat()
    owned = artifact["identity"]
    if (not stat.S_ISREG(staged.st_mode) or staged.st_nlink != 1 or
            (staged.st_dev, staged.st_ino) != (owned.st_dev, owned.st_ino)):
        raise OSError(f"multi_edit staging file changed: {path}")
    flags = os.O_WRONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    fd = os.open(path, flags)
    with os.fdopen(fd, "wb") as stream:
        opened = os.fstat(stream.fileno())
        if _multi_identity(opened) != _multi_identity(staged):
            raise OSError(f"multi_edit staging file changed: {path}")
        stream.truncate(0)
        stream.write(data)
        stream.flush()
        if os.name == "posix":
            original = record["stat"]
            if (opened.st_uid, opened.st_gid) != (original.st_uid, original.st_gid):
                os.fchown(stream.fileno(), original.st_uid, original.st_gid)
            if stat.S_IMODE(opened.st_mode) != stat.S_IMODE(original.st_mode):
                os.fchmod(stream.fileno(), stat.S_IMODE(original.st_mode))
        os.fsync(stream.fileno())
    if kind == "backup":
        original = record["stat"]
        if os.name == "posix":
            # Writing even identical bytes can clear privilege bits/capability
            # xattrs. A rollback backup must retain the original metadata; do
            # this only for backups, never for the changed output stage.
            _multi_verify(record, record["original"])
            before_copy = path.lstat()
            if (not stat.S_ISREG(before_copy.st_mode) or before_copy.st_nlink != 1 or
                    (before_copy.st_dev, before_copy.st_ino) != (owned.st_dev, owned.st_ino)):
                raise OSError(f"multi_edit backup changed: {path}")
            _write_copy_metadata(record["target"], path)
            _multi_verify(record, record["original"])
            restored = path.lstat()
            if (not stat.S_ISREG(restored.st_mode) or restored.st_nlink != 1 or
                    (restored.st_dev, restored.st_ino) != (owned.st_dev, owned.st_ino) or
                    restored.st_size != len(data) or
                    stat.S_IMODE(restored.st_mode) != stat.S_IMODE(original.st_mode) or
                    (restored.st_uid, restored.st_gid) != (original.st_uid, original.st_gid)):
                raise OSError(f"multi_edit backup metadata not preserved: {path}")
            if hasattr(os, "listxattr") and hasattr(os, "getxattr"):
                attribute = "security.capability"
                source_has = attribute in os.listxattr(record["target"], follow_symlinks=False)
                backup_has = attribute in os.listxattr(path, follow_symlinks=False)
                if source_has != backup_has or (source_has and
                        os.getxattr(record["target"], attribute, follow_symlinks=False) !=
                        os.getxattr(path, attribute, follow_symlinks=False)):
                    raise OSError(f"multi_edit backup capability metadata not preserved: {path}")
        _write_verify_parents(record["parents"])
        before_time = path.lstat()
        if (not stat.S_ISREG(before_time.st_mode) or before_time.st_nlink != 1 or
                (before_time.st_dev, before_time.st_ino) != (owned.st_dev, owned.st_ino)):
            raise OSError(f"multi_edit backup changed before timestamp restore: {path}")
        timestamps = (original.st_atime_ns, original.st_mtime_ns)
        if os.utime in os.supports_follow_symlinks:
            os.utime(path, ns=timestamps, follow_symlinks=False)
        else:
            # Windows lacks utime's no-follow option. Keep the checked physical
            # parent and owned regular-file identity guarded around this call.
            os.utime(path, ns=timestamps)
        _write_verify_parents(record["parents"])
        after_time = path.lstat()
        if (not stat.S_ISREG(after_time.st_mode) or after_time.st_nlink != 1 or
                (after_time.st_dev, after_time.st_ino) != (owned.st_dev, owned.st_ino) or
                after_time.st_size != len(data) or after_time.st_mtime_ns != original.st_mtime_ns):
            raise OSError(f"multi_edit backup timestamp restore failed: {path}")
    artifact["identity"] = path.lstat()
    _multi_verify(record, record["original"])
    return artifact


def _multi_verify_artifact(artifact):
    current = artifact["path"].lstat()
    if (not stat.S_ISREG(current.st_mode) or current.st_nlink != 1 or
            _multi_identity(current) != _multi_identity(artifact["identity"])):
        raise OSError(f"multi_edit temporary file changed: {artifact['path']}")


def _multi_cleanup(artifacts):
    errors = []
    for artifact in artifacts:
        if artifact["moved"] or artifact["retain"]:
            continue
        path = artifact["path"]
        try:
            _write_verify_parents(artifact["record"]["parents"])
            try:
                current = path.lstat()
            except FileNotFoundError:
                continue
            owned = artifact["identity"]
            if (current.st_dev, current.st_ino) != (owned.st_dev, owned.st_ino):
                raise OSError("temporary pathname no longer identifies our file")
            path.unlink()
        except Exception as error:
            errors.append(f"{path}: {error}")
    return errors


def multi_edit_files(edits: list[dict], cwd: str = None) -> str:
    records, artifacts, committed = {}, [], []
    failure = None
    try:
        if not isinstance(cwd, str) or not cwd or "\0" in cwd:
            raise ValueError("cwd must be a nonempty string without NUL")
        cwd.encode("utf-8", errors="strict")
        if not isinstance(edits, list) or not 1 <= len(edits) <= 1000:
            raise ValueError("edits must be a nonempty array with at most 1000 items")
        for index, edit in enumerate(edits):
            if not isinstance(edit, dict):
                raise ValueError(f"edit #{index + 1} must be an object")
            for name in ("path", "old_str", "new_str"):
                value = edit.get(name)
                if not isinstance(value, str) or (name != "new_str" and not value):
                    raise ValueError(f"edit #{index + 1}: invalid required string {name}")
                value.encode("utf-8", errors="strict")
            path = edit["path"]
            shape = path.replace("\\", "/") if os.name == "nt" else path
            if "\0" in path or shape.rsplit("/", 1)[-1] in ("", ".", ".."):
                raise ValueError(f"edit #{index + 1}: path must name a file without NUL")
        root = Path(_multi_normalize_path(cwd)).resolve(strict=True)
        if not root.is_dir():
            raise ValueError("cwd must be an existing directory")
        ordered, original_total = [], 0
        requested_records = {}
        for edit in edits:
            requested = edit["path"]
            if requested in requested_records:
                ordered.append((requested_records[requested], edit))
                continue
            target = _write_target(root, _multi_normalize_path(requested))
            key = os.path.normcase(str(target))
            if key not in records:
                original = target.lstat()
                _write_check_target(original)
                if original_total + original.st_size > MAX_READ_BYTES:
                    raise ValueError("multi_edit original text exceeds 100 MiB total")
                record = {"root": root, "target": target, "stat": original,
                          "original": _multi_identity(original), "requests": [edit["path"]],
                          "parents": _multi_parents(root, target), "count": 0}
                flags = os.O_RDWR | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
                fd = os.open(target, flags)
                try:
                    if _multi_identity(os.fstat(fd)) != record["original"]:
                        raise OSError(f"multi_edit destination changed: {target}")
                finally:
                    os.close(fd)
                text = read_file(str(target), str(root), no_truncate=True)
                if isinstance(text, ToolFailure):
                    raise ValueError(str(text))
                _multi_verify(record, record["original"])
                raw = text.encode("utf-8")
                original_total += len(raw)
                if original_total > MAX_READ_BYTES:
                    raise ValueError("multi_edit original text exceeds 100 MiB total")
                record.update(text=text, raw=raw, size=len(raw))
                records[key] = record
            else:
                records[key]["requests"].append(requested)
            requested_records[requested] = records[key]
            ordered.append((records[key], edit))
        working_total = original_total
        for index, (record, edit) in enumerate(ordered):
            text, old, new = record["text"], edit["old_str"], edit["new_str"]
            first = text.find(old)
            if first < 0 or text.find(old, first + 1) >= 0:
                raise ValueError(f"edit #{index + 1}: old_str must occur exactly once, including overlaps")
            delta = len(new.encode("utf-8")) - len(old.encode("utf-8"))
            if working_total + delta > MAX_READ_BYTES:
                raise ValueError("multi_edit working text exceeds 100 MiB total")
            record["text"] = text[:first] + new + text[first + len(old):]
            record["size"] += delta
            record["count"] += 1
            working_total += delta
        for record in records.values():
            record["backup"] = _multi_prepare(record, "backup", record["raw"], artifacts)
            record["stage"] = _multi_prepare(record, "stage", record["text"].encode("utf-8"), artifacts)
        for record in records.values():
            _multi_verify(record, record["original"])
            _multi_verify_artifact(record["backup"])
            _multi_verify_artifact(record["stage"])
        for record in records.values():
            _multi_verify(record, record["original"])
            stage = record["stage"]
            _multi_verify_artifact(stage)
            os.replace(stage["path"], record["target"])
            stage["moved"] = True
            record["committed"] = _multi_identity(stage["identity"])
            committed.append(record)
            current = record["target"].lstat()
            if _multi_identity(current) != record["committed"]:
                raise OSError(f"multi_edit destination changed after commit: {record['target']}")
            record["committed"] = _multi_identity(current)
    except Exception as error:
        failure = str(error)
        recovery = []
        for record in reversed(committed):
            backup = record["backup"]
            try:
                _multi_verify(record, record["committed"])
                _multi_verify_artifact(backup)
                os.replace(backup["path"], record["target"])
                backup["moved"] = True
            except Exception as rollback_error:
                backup["retain"] = True
                recovery.append(f"{record['target']} -> {backup['path']} ({rollback_error})")
        if recovery:
            failure += "; PARTIAL FAILURE; original backups retained: " + "; ".join(recovery)
        elif committed:
            failure += "; committed files rolled back"
    cleanup = _multi_cleanup(artifacts)
    if cleanup:
        context = "changes committed" if failure is None else failure
        failure = context + "; cleanup failed: " + "; ".join(cleanup)
    if failure is not None:
        return MultiEditFailure("ERROR: " + failure)
    summary = ", ".join(f"{r['target']} ({r['count']} edit{'s' if r['count'] != 1 else ''})" for r in records.values())
    return f"applied {len(edits)} edit(s) across {len(records)} file(s): {summary}"


def _capture_text(buf):
    prefix = "[OUTPUT TRUNCATED: earlier output discarded; retained tail follows]\n" if buf.get("truncated") else ""
    if buf.get("incomplete"):
        prefix += "[OUTPUT INCOMPLETE: capture stopped before all output streams closed]\n"
    return prefix + buf["text"]


def _cancel_capture(buf, lock):
    with lock:
        buf["incomplete"] = True
        buf["cancel"].set()


def _start_pump_threads(proc):
    """Own cancellable pipe readers and a byte-bounded, UTF-8-safe shared tail."""
    buf = {"text": "", "bytes": 0, "truncated": False,
           "incomplete": False, "cancel": threading.Event()}
    buf_lock = threading.Lock()
    threads = []

    def append(text):
        if not text:
            return
        with buf_lock:
            if buf["cancel"].is_set():
                return
            buf["text"] += text
            buf["bytes"] += len(text.encode("utf-8"))
            if buf["bytes"] > MAX_OUTPUT:
                tail = buf["text"].encode("utf-8")[-OUTPUT_CAP_KEEP:]
                # Discard only the partial codepoint at the left cut boundary.
                while tail and tail[0] & 0xc0 == 0x80:
                    tail = tail[1:]
                buf["text"] = tail.decode("utf-8")
                buf["bytes"] = len(tail)
                buf["truncated"] = True

    def pump(stream):
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        try:
            fd = stream.fileno()
            if sys.platform == "win32":
                import ctypes
                import msvcrt
                from ctypes import wintypes
                kernel = ctypes.WinDLL("kernel32", use_last_error=True)
                peek = kernel.PeekNamedPipe
                peek.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
                                 ctypes.c_void_p, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
                peek.restype = wintypes.BOOL
                handle = msvcrt.get_osfhandle(fd)
            while not buf["cancel"].is_set():
                count = 4096
                if sys.platform == "win32":
                    available = wintypes.DWORD()
                    if not peek(handle, None, 0, None, ctypes.byref(available), None):
                        error = ctypes.get_last_error()
                        if error in (109, 232):
                            append(decoder.decode(b"", final=True))
                            break
                        raise OSError(error, "PeekNamedPipe failed")
                    if not available.value:
                        buf["cancel"].wait(0.01)
                        continue
                    count = min(count, available.value)
                elif not select.select([fd], [], [], 0.05)[0]:
                    continue
                # Only this reader consumes the pipe. Windows reads no more
                # than PeekNamedPipe reported, so descendant-held pipes cannot
                # pin the thread in a blocking read during cancellation.
                chunk = os.read(fd, count)
                if not chunk:
                    append(decoder.decode(b"", final=True))
                    break
                append(decoder.decode(chunk))
        except Exception:
            with buf_lock:
                buf["incomplete"] = True
        finally:
            try:
                stream.close()
            except Exception:
                with buf_lock:
                    buf["incomplete"] = True

    for stream in (proc.stdout, proc.stderr):
        if stream is not None:
            thread = threading.Thread(target=pump, args=(stream,), daemon=True)
            thread.start()
            threads.append(thread)
    return buf, buf_lock, threads


def _kill_proc_tree(proc):
    """Bounded termination of the spawned process tree, with parent fallback."""
    if proc.poll() is not None:
        return False
    if sys.platform == "win32":
        taskkill = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/taskkill.exe"
        try:
            result = subprocess.run([str(taskkill), "/F", "/T", "/PID", str(proc.pid)],
                                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL, timeout=1,
                                    env=build_child_env(), check=False)
            if result.returncode == 0:
                return True
        except (OSError, subprocess.TimeoutExpired):
            pass
    else:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            return True
        except (ProcessLookupError, PermissionError):
            pass
    try:
        if proc.poll() is None:
            proc.kill()
    except Exception:
        pass
    return False


SPAWN_ENV_ALLOWLIST = {
    "PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
    "TMPDIR", "TEMP", "TMP",
    "SystemRoot", "SystemDrive", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "PROGRAMFILES", "PROGRAMDATA", "WINDIR", "COMSPEC", "PATHEXT",
    # Non-secret Windows system variables. PSModulePath matters most: without it
    # Windows PowerShell rebuilds its module cache on every start ("Preparing
    # modules for first use"), which made each PowerShell command - and the job
    # helper compile - take 10-30 s instead of well under one.
    "PSModulePath", "PROGRAMFILES(X86)", "PROGRAMW6432", "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "COMMONPROGRAMW6432",
    "ALLUSERSPROFILE", "PUBLIC", "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "USERNAME", "COMPUTERNAME", "HOMEDRIVE", "HOMEPATH",
}


def _upload_root() -> str:
    if sys.platform == "darwin":
        base = "/private/tmp"
    elif sys.platform.startswith("linux"):
        base = "/tmp"
    else:
        base = os.environ.get("TMP") or os.environ.get("TEMP") or "/tmp"
    return os.path.join(base, "code-mcp", "uploads")


UPLOAD_ROOT = _upload_root()


def _b64url(buf: bytes) -> str:
    return base64.urlsafe_b64encode(buf).rstrip(b"=").decode("ascii")


def _b64url_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def mint_upload_session_id() -> str:
    if not token:
        raise RuntimeError("--token is required to mint upload sessions")
    # exp is in MILLISECONDS - parity with Java/TS, so a session minted by
    # any implementation verifies on any other implementation.
    exp = int(time.time() * 1000) + UPLOAD_TTL_MS
    nonce = secrets.token_hex(8)
    payload = f"{exp}.{nonce}"
    sig = hmac.new(token.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).digest()
    return f"{_b64url(payload.encode())}.{_b64url(sig)}"


def _verified_upload_expiry(sid: str) -> int:
    if not token:
        raise ValueError("server has no token configured")
    if not isinstance(sid, str) or len(sid) > 128 or not re.fullmatch(r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}", sid):
        raise ValueError("malformed")
    body, signature = sid.split(".")
    raw, sig = _b64url_decode(body), _b64url_decode(signature)
    if _b64url(raw) != body or _b64url(sig) != signature:
        raise ValueError("malformed")
    payload = raw.decode("utf-8", errors="strict")
    if not re.fullmatch(r"[1-9][0-9]{0,15}\.[a-f0-9]{16}", payload):
        raise ValueError("malformed")
    expiry = int(payload.split(".")[0])
    if expiry > 9007199254740991:
        raise ValueError("malformed")
    expected = hmac.new(token.encode("utf-8"), raw, hashlib.sha256).digest()
    if not hmac.compare_digest(sig, expected):
        raise ValueError("bad signature")
    return expiry


def verify_upload_session_id(sid: str) -> tuple[bool, str]:
    try:
        if int(time.time() * 1000) > _verified_upload_expiry(sid):
            return False, "expired"
        return True, ""
    except Exception as error:
        return False, str(error) or "malformed"


def _resolve_public_base_url() -> Optional[str]:
    if public_domain:
        return f"https://{public_domain}"
    state = _public_tunnel_state
    if state is not None and state[1]["proc"].poll() is None:
        return state[0]
    return None


def _upload_widget(url: str) -> str:
    return (
        '<div style="display: flex; flex-direction: column; gap: 12px; max-width: 560px;"><div style="positio'
        'n: relative;"><pre style="margin: 0; padding: 12px 40px 12px 12px; background: var(--color-backgroun'
        'd-secondary); border-radius: var(--border-radius-md); font-size: 12px; font-family: var(--font-mono)'
        '; color: var(--color-text-primary); white-space: pre-wrap; overflow-wrap: anywhere;">{UPLOAD_URL}</p'
        're><button type="button" aria-label="Copy URL" data-url="{UPLOAD_URL}" style="position: absolute; to'
        'p: 8px; right: 8px; width: 28px; height: 28px; padding: 0; display: inline-flex; align-items: center'
        '; justify-content: center; color: var(--color-text-tertiary); background: transparent; border: none;'
        ' cursor: pointer; border-radius: 4px;" onmouseover="this.style.background=\'var(--color-background-pr'
        'imary)\'; this.style.color=\'var(--color-text-primary)\';" onmouseout="this.style.background=\'transpare'
        'nt\'; this.style.color=\'var(--color-text-tertiary)\';" onclick="(function(b){var u=b.getAttribute(\'dat'
        "a-url');var prev=b.innerHTML;var done=function(){b.innerHTML='<svg width=\\'14\\' height=\\'14\\' viewBo"
        "x=\\'0 0 24 24\\' fill=\\'none\\' stroke=\\'currentColor\\' stroke-width=\\'2\\' stroke-linecap=\\'round\\' st"
        "roke-linejoin=\\'round\\'><polyline points=\\'20 6 9 17 4 12\\'/></svg>';b.style.color='var(--color-text"
        "-success)';setTimeout(function(){b.innerHTML=prev;b.style.color='var(--color-text-tertiary)';},1500)"
        ';};if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(u).then(done'
        ").catch(function(){});}else{var ta=document.createElement('textarea');ta.value=u;ta.style.cssText='p"
        "osition:fixed;left:-9999px;';document.body.appendChild(ta);ta.select();try{document.execCommand('cop"
        'y\');done();}catch(e){}document.body.removeChild(ta);}})(this)"><svg width="14" height="14" viewBox="'
        '0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin'
        '="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4'
        'a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button></div><a href="{UPLOAD_URL}" targe'
        't="_blank" rel="noopener" style="display: inline-block; align-self: flex-start; font-family: var(--f'
        'ont-sans); font-size: 14px; padding: 8px 16px; background: transparent; color: var(--color-text-prim'
        'ary); border: 0.5px solid var(--color-border-secondary); border-radius: var(--border-radius-md); tex'
        't-decoration: none; cursor: pointer; transition: background 100ms ease, transform 100ms ease;" onmou'
        'seover="this.style.background=\'var(--color-background-secondary)\'" onmouseout="this.style.background'
        '=\'transparent\'" onmousedown="this.style.transform=\'scale(0.98)\'" onmouseup="this.style.transform=\'sc'
        'ale(1)\'">Open</a></div>'
    ).replace("{UPLOAD_URL}", _xml_attr(url))


def handle_get_upload_link() -> str:
    base = _resolve_public_base_url()
    if not base:
        raise ValueError("get_upload_link requires --public or --domain")
    if not token:
        raise ValueError("get_upload_link requires --token")
    sid = mint_upload_session_id()
    url = f"{base}/upload/{sid}"
    return json.dumps({"url": url, "expiresInMinutes": UPLOAD_TTL_S // 60, "widget": _upload_widget(url), "hint": 'Render the `widget` HTML by calling visualize:show_widget. Also show the `url` as a markdown link as fallback.'})


_UPLOAD_PAGE_HTML = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<title>Upload to local machine</title>\n<style>\n  :root {\n    --bg: #faf9f5;\n    --surface: #ffffff;\n    --text-primary: #181818;\n    --text-secondary: #6b6b63;\n    --text-tertiary: #96958b;\n    --text-info: #2d5fb3;\n    --text-success: #0f6e56;\n    --text-warning: #854f0b;\n    --text-danger: #a32d2d;\n    --border-tertiary: rgba(24, 24, 24, 0.08);\n    --border-secondary: rgba(24, 24, 24, 0.16);\n    --border-info: rgba(45, 95, 179, 0.3);\n    --bg-info: rgba(45, 95, 179, 0.06);\n    --bg-tertiary: #f1efe8;\n    --radius-md: 8px;\n    --radius-lg: 12px;\n  }\n  * { box-sizing: border-box; }\n  html, body { margin: 0; padding: 0; }\n  body {\n    background: var(--bg);\n    color: var(--text-primary);\n    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;\n    font-size: 16px;\n    line-height: 1.5;\n    min-height: 100vh;\n    display: flex;\n    align-items: center;\n    justify-content: center;\n    padding: 2rem 1rem;\n  }\n  .container {\n    width: 100%;\n    max-width: 560px;\n  }\n  .dropzone {\n    display: block;\n    background: transparent;\n    border: 0.5px dashed var(--border-secondary);\n    border-radius: var(--radius-lg);\n    padding: 2rem 1.25rem;\n    text-align: center;\n    cursor: pointer;\n    transition: background 120ms ease, border-color 120ms ease;\n    user-select: none;\n    -webkit-user-select: none;\n    -webkit-tap-highlight-color: transparent;\n  }\n  .dropzone:hover {\n    background: var(--bg-info);\n    border-color: var(--border-info);\n  }\n  .dropzone.hover {\n    background: var(--bg-info);\n    border-color: var(--border-info);\n  }\n  .dropzone.disabled {\n    cursor: not-allowed;\n    opacity: 0.5;\n  }\n  .dropzone .icon { display: flex; justify-content: center; margin-bottom: 12px; color: var(--text-secondary); }\n  .dropzone .title { margin: 0; font-size: 14px; color: var(--text-primary); }\n  .dropzone .browse { color: var(--text-info); text-decoration: underline; }\n  .file-list { margin-top: 0.75rem; display: none; flex-direction: column; gap: 6px; }\n  .file-row {\n    display: flex;\n    align-items: center;\n    justify-content: space-between;\n    gap: 12px;\n    padding: 8px 12px;\n    background: var(--surface);\n    border: 0.5px solid var(--border-tertiary);\n    border-radius: var(--radius-md);\n  }\n  .file-row .info { display: flex; align-items: baseline; gap: 8px; min-width: 0; flex: 1; }\n  .file-row .name { font-size: 13px; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n  .file-row .size { font-size: 12px; color: var(--text-tertiary); flex-shrink: 0; }\n  .file-row button {\n    flex-shrink: 0;\n    width: 24px;\n    height: 24px;\n    padding: 0;\n    display: inline-flex;\n    align-items: center;\n    justify-content: center;\n    color: var(--text-tertiary);\n    background: transparent;\n    border: none;\n    cursor: pointer;\n    border-radius: 4px;\n  }\n  .file-row button:hover { background: var(--bg-tertiary); color: var(--text-primary); }\n  .file-row button:disabled { cursor: not-allowed; opacity: 0.4; }\n  .progress-wrap { margin-top: 0.75rem; display: none; }\n  .progress-track {\n    background: var(--bg-tertiary);\n    border-radius: 999px;\n    height: 4px;\n    overflow: hidden;\n  }\n  .progress-bar {\n    height: 100%;\n    width: 0%;\n    background: var(--text-info);\n    transition: width 120ms ease;\n  }\n  .progress-message { margin: 8px 0 0; font-size: 12px; color: var(--text-secondary); }\n  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 0.75rem; }\n  .actions button {\n    font-family: inherit;\n    font-size: 14px;\n    padding: 8px 16px;\n    background: transparent;\n    color: var(--text-primary);\n    border: 0.5px solid var(--border-secondary);\n    border-radius: var(--radius-md);\n    cursor: pointer;\n    transition: background 100ms ease, transform 100ms ease;\n  }\n  .actions button:hover:not(:disabled) { background: var(--bg-tertiary); }\n  .actions button:active:not(:disabled) { transform: scale(0.98); }\n  .actions button:disabled { opacity: 0.5; cursor: not-allowed; }\n</style>\n</head>\n<body>\n  <div class="container">\n    <input type="file" id="file-input" multiple style="position: absolute; left: -9999px; width: 1px; height: 1px; opacity: 0;" />\n    <label id="dropzone" class="dropzone" for="file-input">\n      <div class="icon">\n        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">\n          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>\n          <polyline points="17 8 12 3 7 8"/>\n          <line x1="12" y1="3" x2="12" y2="15"/>\n        </svg>\n      </div>\n      <p class="title">Drop files here, or <span class="browse">browse</span></p>\n    </label>\n\n    <div id="file-list" class="file-list"></div>\n\n    <div id="progress-wrap" class="progress-wrap">\n      <div class="progress-track"><div id="progress-bar" class="progress-bar"></div></div>\n      <p id="progress-message" class="progress-message"></p>\n    </div>\n\n    <div class="actions">\n      <button id="cancel-btn">Cancel</button>\n      <button id="upload-btn" disabled>Upload</button>\n    </div>\n  </div>\n\n<script data-cfasync="false">\n(function () {\n  var dropzone = document.getElementById(\'dropzone\');\n  var fileInput = document.getElementById(\'file-input\');\n  var fileList = document.getElementById(\'file-list\');\n  var progressWrap = document.getElementById(\'progress-wrap\');\n  var progressBar = document.getElementById(\'progress-bar\');\n  var progressMessage = document.getElementById(\'progress-message\');\n  var uploadBtn = document.getElementById(\'upload-btn\');\n  var cancelBtn = document.getElementById(\'cancel-btn\');\n\n  var UPLOAD_URL = window.location.href;\n\n  var queue = [];\n  var uploading = false;\n  var cancelled = false;\n  var currentXhr = null;\n  var finished = false;\n\n  function fmtBytes(n) {\n    if (n < 1024) return n + \' B\';\n    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + \' KB\';\n    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + \' MB\';\n    return (n / (1024 * 1024 * 1024)).toFixed(2) + \' GB\';\n  }\n\n  function setBtn(btn, enabled) {\n    btn.disabled = !enabled;\n  }\n\n  function refreshButtons() {\n    if (finished) {\n      setBtn(uploadBtn, false);\n      setBtn(cancelBtn, false);\n      return;\n    }\n    setBtn(uploadBtn, !uploading && queue.length > 0);\n    setBtn(cancelBtn, true);\n  }\n\n  function renderList() {\n    if (queue.length === 0) {\n      fileList.style.display = \'none\';\n      fileList.innerHTML = \'\';\n      refreshButtons();\n      return;\n    }\n    fileList.style.display = \'flex\';\n    fileList.innerHTML = \'\';\n    queue.forEach(function (file, idx) {\n      var row = document.createElement(\'div\');\n      row.className = \'file-row\';\n\n      var info = document.createElement(\'div\');\n      info.className = \'info\';\n      var name = document.createElement(\'span\');\n      name.className = \'name\';\n      name.textContent = file.name;\n      var size = document.createElement(\'span\');\n      size.className = \'size\';\n      size.textContent = fmtBytes(file.size);\n      info.appendChild(name);\n      info.appendChild(size);\n\n      var remove = document.createElement(\'button\');\n      remove.setAttribute(\'aria-label\', \'Remove \' + file.name);\n      remove.innerHTML = \'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>\';\n      remove.disabled = uploading || finished;\n      remove.addEventListener(\'click\', function (e) {\n        e.stopPropagation();\n        if (uploading || finished) return;\n        queue.splice(idx, 1);\n        renderList();\n      });\n\n      row.appendChild(info);\n      row.appendChild(remove);\n      fileList.appendChild(row);\n    });\n    refreshButtons();\n  }\n\n  function addFiles(files) {\n    if (uploading || finished) return;\n    for (var i = 0; i < files.length; i++) queue.push(files[i]);\n    renderList();\n  }\n\n  function uploadOne(file, onProgress) {\n    return new Promise(function (resolve) {\n      var xhr = new XMLHttpRequest();\n      currentXhr = xhr;\n      var form = new FormData();\n      form.append(\'file\', file);\n\n      xhr.upload.addEventListener(\'progress\', function (e) {\n        if (e.lengthComputable) onProgress(e.loaded, e.total);\n      });\n      xhr.addEventListener(\'load\', function () {\n        if (xhr.status >= 200 && xhr.status < 300) {\n          var body = {};\n          try { body = JSON.parse(xhr.responseText); } catch (e) {}\n          resolve({ ok: true, path: body.path || file.name, file: file });\n        } else {\n          resolve({ ok: false, status: xhr.status, file: file });\n        }\n      });\n      xhr.addEventListener(\'error\', function () {\n        resolve({ ok: false, networkError: true, file: file });\n      });\n      xhr.addEventListener(\'abort\', function () {\n        resolve({ ok: false, aborted: true, file: file });\n      });\n      xhr.open(\'POST\', UPLOAD_URL);\n      xhr.send(form);\n    });\n  }\n\n  function disableAll() {\n    finished = true;\n    dropzone.classList.add(\'disabled\');\n    fileInput.disabled = true;\n    refreshButtons();\n    // re-render list so the remove buttons get disabled\n    renderList();\n  }\n\n  function runUpload() {\n    if (uploading || queue.length === 0) return;\n    uploading = true;\n    cancelled = false;\n    refreshButtons();\n    progressWrap.style.display = \'block\';\n    progressBar.style.background = \'var(--text-info)\';\n    progressBar.style.width = \'0%\';\n    progressMessage.style.color = \'var(--text-secondary)\';\n\n    var files = queue.slice();\n    var totalBytes = files.reduce(function (s, f) { return s + f.size; }, 0);\n    var completedBytes = 0;\n    var results = [];\n\n    function next(i) {\n      if (cancelled || i >= files.length) return finish(results, files, i);\n      var f = files[i];\n      progressMessage.textContent = \'Uploading \' + f.name + \' (\' + (i + 1) + \'/\' + files.length + \')\';\n      uploadOne(f, function (loaded) {\n        var pct = totalBytes === 0 ? 0 : ((completedBytes + loaded) / totalBytes) * 100;\n        progressBar.style.width = pct + \'%\';\n      }).then(function (res) {\n        completedBytes += f.size;\n        results.push(res);\n        next(i + 1);\n      });\n    }\n\n    function finish(results, allFiles, stoppedAt) {\n      uploading = false;\n      currentXhr = null;\n      var ok = results.filter(function (r) { return r.ok; });\n      var failed = results.filter(function (r) { return !r.ok && !r.aborted; });\n\n      progressBar.style.width = \'100%\';\n\n      if (cancelled) {\n        progressBar.style.background = \'var(--text-warning)\';\n        progressMessage.textContent = \'Cancelled — \' + ok.length + \' uploaded before stop\';\n        progressMessage.style.color = \'var(--text-warning)\';\n      } else if (failed.length === 0) {\n        progressBar.style.background = \'var(--text-success)\';\n        progressMessage.textContent = \'Uploaded \' + ok.length + \' file\' + (ok.length === 1 ? \'\' : \'s\') + \'. Tell Claude where they landed:\';\n        progressMessage.style.color = \'var(--text-success)\';\n      } else {\n        progressBar.style.background = \'var(--text-danger)\';\n        progressMessage.textContent = ok.length + \' uploaded, \' + failed.length + \' failed\';\n        progressMessage.style.color = \'var(--text-danger)\';\n      }\n\n      if (ok.length > 0) {\n        var summaryWrap = document.createElement(\'div\');\n        summaryWrap.style.cssText = \'position: relative; margin-top: 12px;\';\n        var summary = document.createElement(\'pre\');\n        summary.style.cssText = \'margin: 0; padding: 12px 40px 12px 12px; background: var(--bg-tertiary); border-radius: var(--radius-md); font-size: 12px; font-family: ui-monospace, "SF Mono", Menlo, monospace; color: var(--text-primary); white-space: pre-wrap; overflow-wrap: anywhere;\';\n        var text = ok.map(function (r) { return r.path; }).join(\'\\n\');\n        summary.textContent = text;\n        var copyBtn = document.createElement(\'button\');\n        copyBtn.type = \'button\';\n        copyBtn.setAttribute(\'aria-label\', \'Copy paths\');\n        copyBtn.style.cssText = \'position: absolute; top: 8px; right: 8px; width: 28px; height: 28px; padding: 0; display: inline-flex; align-items: center; justify-content: center; color: var(--text-tertiary); background: transparent; border: none; cursor: pointer; border-radius: 4px;\';\n        copyBtn.innerHTML = \'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>\';\n        copyBtn.addEventListener(\'mouseenter\', function () { copyBtn.style.background = \'var(--surface)\'; copyBtn.style.color = \'var(--text-primary)\'; });\n        copyBtn.addEventListener(\'mouseleave\', function () { copyBtn.style.background = \'transparent\'; copyBtn.style.color = \'var(--text-tertiary)\'; });\n        copyBtn.addEventListener(\'click\', function () {\n          var done = function () {\n            var prev = copyBtn.innerHTML;\n            copyBtn.innerHTML = \'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>\';\n            copyBtn.style.color = \'var(--text-success)\';\n            setTimeout(function () { copyBtn.innerHTML = prev; copyBtn.style.color = \'var(--text-tertiary)\'; }, 1500);\n          };\n          if (navigator.clipboard && navigator.clipboard.writeText) {\n            navigator.clipboard.writeText(text).then(done).catch(function () {});\n          } else {\n            // fallback for older browsers / non-secure contexts\n            var ta = document.createElement(\'textarea\');\n            ta.value = text;\n            ta.style.cssText = \'position: fixed; left: -9999px;\';\n            document.body.appendChild(ta);\n            ta.select();\n            try { document.execCommand(\'copy\'); done(); } catch (err) {}\n            document.body.removeChild(ta);\n          }\n        });\n        summaryWrap.appendChild(summary);\n        summaryWrap.appendChild(copyBtn);\n        progressWrap.appendChild(summaryWrap);\n      }\n\n      // clear queue, disable the page\n      queue = [];\n      fileList.style.display = \'none\';\n      fileList.innerHTML = \'\';\n      disableAll();\n    }\n\n    next(0);\n  }\n\n  function runCancel() {\n    if (uploading) {\n      cancelled = true;\n      if (currentXhr) try { currentXhr.abort(); } catch (e) {}\n    } else {\n      queue = [];\n      progressWrap.style.display = \'none\';\n      renderList();\n      progressMessage.textContent = \'Upload cancelled.\';\n      progressMessage.style.color = \'var(--text-warning)\';\n      progressWrap.style.display = \'block\';\n      progressBar.style.background = \'var(--text-warning)\';\n      progressBar.style.width = \'100%\';\n      disableAll();\n    }\n  }\n\n  dropzone.addEventListener(\'click\', function (e) {\n    // <label for="file-input"> handles the click natively. JS click() is\n    // unreliable on mobile browsers — we let the label do its job.\n    if (uploading || finished) e.preventDefault();\n  });\n  fileInput.addEventListener(\'change\', function (e) {\n    var files = e.target.files || fileInput.files;\n    if (files && files.length) {\n      // copy FileList to array — some mobile browsers invalidate it after value reset\n      var arr = [];\n      for (var i = 0; i < files.length; i++) arr.push(files[i]);\n      addFiles(arr);\n    }\n    fileInput.value = \'\';\n  });\n  dropzone.addEventListener(\'dragover\', function (e) { e.preventDefault(); if (!uploading && !finished) dropzone.classList.add(\'hover\'); });\n  dropzone.addEventListener(\'dragleave\', function () { dropzone.classList.remove(\'hover\'); });\n  dropzone.addEventListener(\'drop\', function (e) {\n    e.preventDefault();\n    dropzone.classList.remove(\'hover\');\n    if (uploading || finished) return;\n    if (e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);\n  });\n\n  uploadBtn.addEventListener(\'click\', runUpload);\n  cancelBtn.addEventListener(\'click\', runCancel);\n})();\n</script>\n</body>\n</html>\n'


def _upload_parameters(value: str):
    first = value.find(";")
    kind = (value if first < 0 else value[:first]).strip().lower()
    params = {}
    at = len(value) if first < 0 else first
    while at < len(value):
        if value[at] != ";":
            raise ValueError("invalid multipart parameter")
        at += 1
        while at < len(value) and value[at] in " \t":
            at += 1
        start = at
        while at < len(value) and re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]", value[at]):
            at += 1
        key = value[start:at].lower()
        while at < len(value) and value[at] in " \t":
            at += 1
        if not key or at >= len(value) or value[at] != "=":
            raise ValueError("invalid multipart parameter")
        at += 1
        while at < len(value) and value[at] in " \t":
            at += 1
        if at < len(value) and value[at] == '"':
            at += 1
            text, closed = [], False
            while at < len(value):
                char = value[at]
                at += 1
                if char == '"':
                    closed = True
                    break
                if char == "\\":
                    if at >= len(value):
                        raise ValueError("invalid multipart quote")
                    char = value[at]
                    at += 1
                text.append(char)
            if not closed:
                raise ValueError("invalid multipart quote")
            text = "".join(text)
            while at < len(value) and value[at] in " \t":
                at += 1
            if at < len(value) and value[at] != ";":
                raise ValueError("invalid multipart parameter")
        else:
            start = at
            while at < len(value) and value[at] != ";":
                at += 1
            text = value[start:at].strip()
        if key in params or any(c in text for c in "\r\n\0"):
            raise ValueError("ambiguous multipart parameter")
        params[key] = text
    return kind, params


def _sanitize_filename(value: str) -> str:
    name = value.replace("\\", "/").rsplit("/", 1)[-1]
    name = re.sub(r'[\x00-\x1f\x7f<>:"|?*]', "_", name).rstrip(" .") or "upload.bin"
    if re.fullmatch(r"CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³]", name.split(".")[0].rstrip(), re.IGNORECASE):
        name = "_" + name
    if len(name.encode("utf-8")) > 255:
        raise ValueError("filename exceeds 255 UTF-8 bytes")
    return name


def _parse_upload_form(content_type: str, body: bytes):
    kind, params = _upload_parameters(content_type)
    boundary = params.get("boundary", "")
    if kind != "multipart/form-data" or not re.fullmatch(r"[0-9A-Za-z'()+_,./:=? -]{1,70}", boundary) or boundary.endswith(" "):
        raise ValueError("invalid multipart boundary")
    marker = b"--" + boundary.encode("ascii")
    prefix = b"\r\n" + marker

    def delimiter(position):
        at = position + len(marker)
        closing = body[at:at+2] == b"--"
        if closing:
            at += 2
        while body[at:at+1] in (b" ", b"\t"):
            at += 1
        if closing and at == len(body):
            return position, at, closing
        if body[at:at+2] == b"\r\n":
            return position, at + 2, closing
        return None

    def next_delimiter(start):
        found = body.find(prefix, start)
        while found >= 0:
            value = delimiter(found + 2)
            if value is not None:
                return value
            found = body.find(prefix, found + len(prefix))
        return None

    current = delimiter(0) if body.startswith(marker) else next_delimiter(0)
    selected, count = None, 0
    while current is not None and not current[2]:
        count += 1
        if count > 128:
            raise ValueError("too many multipart parts")
        next_part = next_delimiter(current[1])
        if next_part is None:
            raise ValueError("truncated multipart body")
        end = next_part[0] - 2
        header_end = body.find(b"\r\n\r\n", current[1], end)
        if header_end < current[1] or header_end - current[1] > 65536:
            raise ValueError("invalid multipart headers")
        headers = {}
        for line in body[current[1]:header_end].decode("utf-8", errors="strict").split("\r\n"):
            key, separator, value = line.partition(":")
            key = key.lower()
            if not separator or not re.fullmatch(r"[!#$%&'*+.^_`|~0-9a-z-]+", key) or key in headers:
                raise ValueError("invalid multipart headers")
            headers[key] = value.strip()
        disposition, fields = _upload_parameters(headers.get("content-disposition", ""))
        if disposition != "form-data" or "name" not in fields:
            raise ValueError("invalid content disposition")
        if fields["name"] == "file":
            if selected is not None or "filename" not in fields:
                raise ValueError("expected one file field")
            mime = headers.get("content-type", "application/octet-stream")
            mime = mime.lower() if mime and re.fullmatch(r"[\x20-\x7e]+", mime) else "application/octet-stream"
            selected = _sanitize_filename(fields["filename"]), mime, memoryview(body)[header_end+4:end]
        current = next_part
    if current is None or not current[2] or selected is None:
        raise ValueError("missing file field")
    return selected


def _upload_directory(session_id: str):
    _verified_upload_expiry(session_id)
    path = Path(UPLOAD_ROOT).parent.parent.resolve(strict=True)
    snapshots = []
    for part in ("code-mcp", "uploads", session_id):
        path = path / part
        path.mkdir(mode=0o700, exist_ok=True)
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400 or path.resolve() != path:
            raise ValueError("upload path invalid")
        snapshots.append((path, info.st_dev, info.st_ino))

    def verify():
        for directory, dev, ino in snapshots:
            info = directory.lstat()
            if (not stat.S_ISDIR(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400
                    or (info.st_dev, info.st_ino) != (dev, ino) or directory.resolve() != directory):
                raise ValueError("upload path changed")
    return path.parent, path, verify


def _upload_check_file(path: Path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return
    if not stat.S_ISREG(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        raise ValueError("upload file invalid")


def _sweep_uploads(root: Path, current_session: str):
    # Only authenticated, expired sessions in our dedicated namespace. Preserve
    # unknown/key-rotated entries rather than guessing ownership from age.
    cutoff = int(time.time() * 1000) - 900_000
    try:
        for directory in root.iterdir():
            if directory.name == current_session:
                continue
            try:
                if _verified_upload_expiry(directory.name) >= cutoff:
                    continue
                info = directory.lstat()
                if stat.S_ISDIR(info.st_mode) and not getattr(info, "st_file_attributes", 0) & 0x400:
                    shutil.rmtree(directory)
            except Exception:
                pass
    except OSError:
        pass


_UPLOAD_WRITE_LOCKS = {}
_UPLOAD_WRITE_LOCKS_GUARD = threading.Lock()


@contextmanager
def _upload_write_lock(session_id):
    # A session lock also covers Windows case aliases for filenames. Remove
    # entries after the last holder/waiter; HTTP admission bounds active work.
    with _UPLOAD_WRITE_LOCKS_GUARD:
        entry = _UPLOAD_WRITE_LOCKS.setdefault(session_id, [threading.Lock(), 0])
        entry[1] += 1
    try:
        with entry[0]:
            yield
    finally:
        with _UPLOAD_WRITE_LOCKS_GUARD:
            entry[1] -= 1
            if entry[1] == 0:
                del _UPLOAD_WRITE_LOCKS[session_id]


def handle_upload_post(content_type: str, body: bytes, session_id: str) -> tuple[int, dict]:
    if len(body) > MAX_UPLOAD_BODY_BYTES:
        return 413, {"error": f"upload body exceeds {MAX_UPLOAD_BODY_BYTES} bytes"}
    try:
        safe_name, mime, file_bytes = _parse_upload_form(content_type, body)
    except (ValueError, UnicodeError) as error:
        return 400, {"error": f"bad form: {error}"}

    if len(file_bytes) > MAX_UPLOAD_BYTES:
        return 413, {"error": f"file too large (max {MAX_UPLOAD_BYTES} bytes)"}
    try:
        with _upload_write_lock(session_id):
            root, target_dir, verify = _upload_directory(session_id)
            target = target_dir / safe_name
            if target.parent != target_dir:
                raise ValueError("upload filename invalid")
            _upload_check_file(target)

            def before_commit():
                verify()
                _upload_check_file(target)

            if os.name == "posix":
                _write_atomic_posix(root, target, file_bytes, before_commit=before_commit)
            else:
                _write_atomic_portable(root, target, file_bytes, before_commit=before_commit)
            verify()
            _sweep_uploads(root, session_id)
    except Exception as error:
        return 500, {"error": f"write failed: {error}"}

    sha = hashlib.sha256(file_bytes).hexdigest()
    return 200, {"path": str(target), "size": len(file_bytes), "sha256": sha, "mime": mime}


def build_child_env(extra: dict | None = None) -> dict:
    """Spawn-time env allow-list — limits blast radius of MCP token compromise.

    Only forwards POSIX/Windows essentials (PATH, HOME, SHELL, etc.). Secrets
    like AWS_*, OPENAI_API_KEY, ANTHROPIC_API_KEY are dropped. Users who need
    extra vars in commands should set them inline (`FOO=bar my-cmd`).
    """
    base = {}
    if os.name == "nt":
        allowed = {key.casefold() for key in SPAWN_ENV_ALLOWLIST}
        for key, value in os.environ.items():
            if key.casefold() in allowed:
                base[key] = value
    else:
        for k in SPAWN_ENV_ALLOWLIST:
            v = os.environ.get(k)
            if v is not None:
                base[k] = v
    base.setdefault("HOME", os.path.expanduser("~"))
    if extra:
        base.update(extra)
    return base


def _run_proc(cmd, cwd: str, timeout_ms: int | None, executable: str | None = None, shell: bool = True) -> str:
    """Run a process for the bash/shell/command/powershell tools.

    Two paths depending on whether the caller passed timeout_ms:
      - explicit timeout_ms > 0: classic kill-on-timeout behaviour (exit=124 + _timeout_marker).
      - no timeout_ms: at DEFAULT_SHELL_TIMEOUT_MS (60s) the still-running process is adopted
        into the `job` system instead of being killed, and we return exit=running plus
        _backgrounded_marker so the agent can poll with the `job` tool.
    """
    explicit = bool(timeout_ms and timeout_ms > 0)
    effective_ms = timeout_ms if explicit else DEFAULT_SHELL_TIMEOUT_MS
    timeout_s = effective_ms / 1000.0
    # Bound concurrent shell executions (parity with Java): waiting callers get
    # a clear error after 30s instead of unbounded subprocess fan-out.
    if not _shell_semaphore.acquire(timeout=30):
        return ShellFailure("ERROR: Too many concurrent shell executions, please try again later")
    try:
        return _run_proc_inner(cmd, cwd, timeout_ms, explicit, effective_ms, timeout_s,
                               executable, shell)
    finally:
        _shell_semaphore.release()


def _run_proc_inner(cmd, cwd, timeout_ms, explicit, effective_ms, timeout_s,
                    executable=None, shell=True) -> str:
    try:
        _ensure_windows_root_owner()
    except Exception as error:
        return ShellFailure(f"ERROR: {error}")
    deadline = time.monotonic() + timeout_s
    popen_kwargs = dict(
        shell=shell,
        executable=executable,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        stdin=subprocess.DEVNULL,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=build_child_env(),
    )
    if sys.platform != "win32":
        # Own process group so we can SIGKILL all descendants (sleep etc.) on timeout.
        popen_kwargs["start_new_session"] = True
    try:
        proc = subprocess.Popen(cmd, **popen_kwargs)
    except Exception as e:
        return ShellFailure(f"exit=-1\nERROR: {e}")

    buf, buf_lock, pump_threads = _start_pump_threads(proc)
    try:
        exit_code = proc.wait(timeout=max(0, deadline - time.monotonic()))
        for thread in pump_threads:
            thread.join(timeout=max(0, deadline - time.monotonic()))
        if any(thread.is_alive() for thread in pump_threads):
            raise subprocess.TimeoutExpired(cmd, timeout_s)
    except subprocess.TimeoutExpired:
        exit_code = proc.poll()
        if explicit or exit_code is not None:
            # Never kill the numeric PID of an exited parent: descendants may
            # intentionally outlive it and the PID might have been recycled.
            if exit_code is None:
                _kill_proc_tree(proc)
                cleanup_deadline = time.monotonic() + 1.0
                try:
                    proc.wait(timeout=max(0, cleanup_deadline - time.monotonic()))
                except subprocess.TimeoutExpired:
                    pass
                for thread in pump_threads:
                    thread.join(timeout=max(0, cleanup_deadline - time.monotonic()))
            if any(thread.is_alive() for thread in pump_threads):
                _cancel_capture(buf, buf_lock)
            with buf_lock:
                snapshot = _capture_text(buf)
            if explicit:
                return f"exit=124\n{snapshot}" + _timeout_marker(effective_ms)
            return f"exit={exit_code}\n{snapshot}"
        # Adopt as a background job rather than killing.
        original_cmd = cmd if isinstance(cmd, str) else " ".join(cmd)
        try:
            job_id = _adopt_as_job(original_cmd, proc, buf, buf_lock, pump_threads)
        except Exception as e:
            _kill_proc_tree(proc)
            cleanup_deadline = time.monotonic() + 1.0
            try: proc.wait(timeout=max(0, cleanup_deadline - time.monotonic()))
            except subprocess.TimeoutExpired: pass
            for thread in pump_threads:
                thread.join(timeout=max(0, cleanup_deadline - time.monotonic()))
            if any(thread.is_alive() for thread in pump_threads):
                _cancel_capture(buf, buf_lock)
            with buf_lock: snapshot = _capture_text(buf)
            return f"exit=124\n{snapshot}\n[Auto-background failed: {e}; process killed.]"
        with buf_lock: snapshot = _capture_text(buf)
        return f"exit=running\n{snapshot}" + _backgrounded_marker(effective_ms, job_id)
    except Exception as e:
        _kill_proc_tree(proc)
        _cancel_capture(buf, buf_lock)
        return ShellFailure(f"exit=-1\nERROR: {e}")
    with buf_lock: snapshot = _capture_text(buf)
    return f"exit={exit_code}\n{snapshot}"


def _prune_jobs_locked():
    """Keep all active jobs and the 100 most recently completed jobs."""
    completed = sorted((job for job in jobs.values() if job.get("_finalized")),
                       key=lambda job: job["completed_at"])
    for job in completed[:-100]:
        jobs.pop(job["id"], None)


def _complete_job_capture(job):
    global total_jobs
    with job["_finalize_lock"]:
        if job.get("_finalized") or job["proc"].poll() is None:
            return
        deadline = time.monotonic() + 1.0
        threads = job["_pump_threads"]
        for thread in threads:
            thread.join(timeout=max(0, deadline - time.monotonic()))
        buf, lock = job["_buf"], job["_buf_lock"]
        if any(thread.is_alive() for thread in threads):
            _cancel_capture(buf, lock)
        with lock:
            output = _capture_text(buf)
        with jobs_lock:
            job["output"] = output
            job["status"] = "exited"
            job["exit_code"] = job["proc"].returncode
            job["completed_at"] = time.monotonic()
            job["_finalized"] = True
            total_jobs = max(0, total_jobs - 1)
            _prune_jobs_locked()


def _watch_job(job):
    def finalize():
        job["proc"].wait()
        _complete_job_capture(job)
    threading.Thread(target=finalize, daemon=True).start()


def _adopt_as_job(command: str, proc, buf: dict, buf_lock, pump_threads) -> str:
    """Register an already-running process as a job, reusing the caller's pumper buffer
    so view_job continues to see live output without losing in-flight bytes.
    Returns the assigned job_id. Raises on max-jobs / shutdown."""
    global total_jobs, job_seq
    job = {
        "command": command,
        "proc": proc,
        "_buf": buf,
        "_buf_lock": buf_lock,
        "_pump_threads": pump_threads,
        "_finalize_lock": threading.Lock(),
        "output": "",  # finalized on exit; live reads go through _buf
        "status": "running",
        "started_at": time.time(),
    }
    with jobs_lock:
        _prune_jobs_locked()
        if total_jobs >= MAX_CONCURRENT_JOBS:
            raise RuntimeError(f"max concurrent jobs ({MAX_CONCURRENT_JOBS}) exceeded")
        if shutting_down:
            raise RuntimeError("server is shutting down")
        total_jobs += 1
        job_seq += 1
        job_id = f"j{job_seq}"
        job["id"] = job_id
        jobs[job_id] = job

    _watch_job(job)
    return job_id


def execute_bash(command: str, cwd: str = ".", timeout_ms: int | None = None) -> str:
    return _run_proc(["bash", "-c", command], cwd, timeout_ms, shell=False)


def execute_shell(command: str, cwd: str = ".", timeout_ms: int | None = None) -> str:
    return _run_proc(["sh", "-c", command], cwd, timeout_ms, shell=False)


def _powershell_argv(command: str) -> list[str]:
    binary = get_powershell_binary()
    if not binary:
        raise FileNotFoundError("PowerShell (pwsh / powershell.exe) not found on PATH")
    # -EncodedCommand (base64 UTF-16LE) instead of raw -Command: the Windows
    # command line mangles embedded double quotes, so a quoted "|" separator
    # became a real pipeline and PowerShell tried to run "PLAT=..." as a
    # command. Base64 has no shell metacharacters, so the script arrives intact.
    # Encoded commands can serialize stderr as CLIXML on Windows PowerShell.
    # Keep errors visible and suppress module-initialization progress.
    # Parse separately so leading param/using remain valid. Inner encoding also
    # protects smart quotes. Preserve a final failed command's process status:
    # invoking a script block alone resets $? after nonterminating/native errors.
    inner = base64.b64encode((command + "\nif (-not $?) { exit 1 }").encode("utf-16-le")).decode("ascii")
    script = ("$ProgressPreference = 'SilentlyContinue'; "
              "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); "
              "$OutputEncoding = [Console]::OutputEncoding; & ([scriptblock]::Create("
              + "[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('" + inner + "'))))")
    enc = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    return [binary, "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", enc]


def execute_powershell(command: str, cwd: str = ".", timeout_ms: int | None = None) -> str:
    try:
        argv = _powershell_argv(command)
    except Exception as error:
        return ShellFailure(f"exit=-1\nERROR: {error}")
    return _run_proc(argv, cwd, timeout_ms, shell=False)


def _job_command(command: str):
    shell_type = get_shell_type()
    if shell_type == ShellType.POWERSHELL:
        return _powershell_argv(command)
    if shell_type == ShellType.CMD:
        binary = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/cmd.exe"
        return f'"{binary}" /d /s /c "{command}"'
    return ["bash" if shell_type == ShellType.BASH else "sh", "-c", command]



def execute_command(command: str, cwd: str = ".", timeout_ms: int | None = None) -> str:
    """Windows cmd.exe execution."""
    binary = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/cmd.exe"
    # CMD /s removes this outer script boundary; internal caller quotes remain
    # unchanged. Avoid list2cmdline's C-runtime escaping and disable AutoRun.
    return _run_proc(f'"{binary}" /d /s /c "{command}"', cwd, timeout_ms, shell=False)


_GREP_FALLBACK_SCRIPT_B64 = "JEVycm9yQWN0aW9uUHJlZmVyZW5jZSA9ICdTdG9wJwpbQ29uc29sZV06OklucHV0RW5jb2RpbmcgPSBbVGV4dC5VVEY4RW5jb2RpbmddOjpuZXcoJGZhbHNlKQpbQ29uc29sZV06Ok91dHB1dEVuY29kaW5nID0gW1RleHQuVVRGOEVuY29kaW5nXTo6bmV3KCRmYWxzZSkKJE91dHB1dEVuY29kaW5nID0gW0NvbnNvbGVdOjpPdXRwdXRFbmNvZGluZwp0cnkgewogICAgJHJlcXVlc3QgPSBbQ29uc29sZV06OkluLlJlYWRUb0VuZCgpIHwgQ29udmVydEZyb20tSnNvbgogICAgJG1hdGNoZXIgPSBbcmVnZXhdOjpuZXcoW3N0cmluZ10kcmVxdWVzdC5wYXR0ZXJuLCBbVGV4dC5SZWd1bGFyRXhwcmVzc2lvbnMuUmVnZXhPcHRpb25zXTo6Q3VsdHVyZUludmFyaWFudCwgW1RpbWVTcGFuXTo6RnJvbU1pbGxpc2Vjb25kcygyNTApKQogICAgJHJvb3QgPSBbSU8uUGF0aF06OkdldEZ1bGxQYXRoKFtzdHJpbmddJHJlcXVlc3QucGF0aCkKICAgICRnbG9iID0gW3N0cmluZ10kcmVxdWVzdC5nbG9iCiAgICAkZmlsdGVyID0gJG51bGwKICAgIGlmICgkZ2xvYikgewogICAgICAgICRnID0gJGdsb2IuUmVwbGFjZSgnXCcsJy8nKQogICAgICAgICRuZWdhdGUgPSAkZy5TdGFydHNXaXRoKCchJykKICAgICAgICBpZiAoJG5lZ2F0ZSkgeyAkZyA9ICRnLlN1YnN0cmluZygxKSB9CiAgICAgICAgaWYgKC1ub3QgJGcpIHsgdGhyb3cgJ0dsb2IgbXVzdCBub3QgYmUgZW1wdHkgYWZ0ZXIgbmVnYXRpb24nIH0KICAgICAgICAkZGVwdGg9MAogICAgICAgICRwcmVmaXggPSBpZiAoJGcuQ29udGFpbnMoJy8nKSkgeyAnXicgfSBlbHNlIHsgJyhefC8pJyB9CiAgICAgICAgJHJ4ID0gW1RleHQuU3RyaW5nQnVpbGRlcl06Om5ldygkcHJlZml4KQogICAgICAgIGZvciAoJGk9MDsgJGkgLWx0ICRnLkxlbmd0aDsgJGkrKykgewogICAgICAgICAgICAkYz0kZ1skaV0KICAgICAgICAgICAgaWYgKCRjIC1lcSAnKicpIHsKICAgICAgICAgICAgICAgIGlmICgkaSsxIC1sdCAkZy5MZW5ndGggLWFuZCAkZ1skaSsxXSAtZXEgJyonKSB7CiAgICAgICAgICAgICAgICAgICAgJGkrKwogICAgICAgICAgICAgICAgICAgIGlmICgkaSsxIC1sdCAkZy5MZW5ndGggLWFuZCAkZ1skaSsxXSAtZXEgJy8nKSB7ICRpKys7IFt2b2lkXSRyeC5BcHBlbmQoJyg/Oi4qLyk/JykgfQogICAgICAgICAgICAgICAgICAgIGVsc2UgeyBbdm9pZF0kcnguQXBwZW5kKCcuKicpIH0KICAgICAgICAgICAgICAgIH0gZWxzZSB7IFt2b2lkXSRyeC5BcHBlbmQoJ1teL10qJykgfQogICAgICAgICAgICB9IGVsc2VpZiAoJGMgLWVxICc/JykgeyBbdm9pZF0kcnguQXBwZW5kKCdbXi9dJykgfQogICAgICAgICAgICBlbHNlaWYgKCRjIC1lcSAnWycpIHsKICAgICAgICAgICAgICAgICRlbmQ9JGcuSW5kZXhPZignXScsJGkrMSkKICAgICAgICAgICAgICAgIGlmICgkZW5kIC1sdCAwKSB7IHRocm93ICdVbmNsb3NlZCBnbG9iIGNoYXJhY3RlciBjbGFzcycgfQogICAgICAgICAgICAgICAgJGJvZHk9JGcuU3Vic3RyaW5nKCRpKzEsJGVuZC0kaS0xKQogICAgICAgICAgICAgICAgaWYgKC1ub3QgJGJvZHkgLW9yICRib2R5LkNvbnRhaW5zKCdbJykgLW9yICRib2R5LkNvbnRhaW5zKCcvJykpIHsgdGhyb3cgJ0ludmFsaWQgZ2xvYiBjaGFyYWN0ZXIgY2xhc3MnIH0KICAgICAgICAgICAgICAgIGlmICgkYm9keS5TdGFydHNXaXRoKCchJykgLW9yICRib2R5LlN0YXJ0c1dpdGgoJ14nKSkgeyAkYm9keT0nXi8nKyRib2R5LlN1YnN0cmluZygxKSB9CiAgICAgICAgICAgICAgICBbdm9pZF0kcnguQXBwZW5kKCcoPyEvKVsnKyRib2R5KyddJyk7ICRpPSRlbmQKICAgICAgICAgICAgfSBlbHNlaWYgKCRjIC1lcSAneycpIHsgJGRlcHRoKys7IGlmKCRkZXB0aCAtZ3QgMTYpe3Rocm93ICdHbG9iIG5lc3RpbmcgbGltaXQgZXhjZWVkZWQnfTsgW3ZvaWRdJHJ4LkFwcGVuZCgnKD86JykgfQogICAgICAgICAgICBlbHNlaWYgKCRjIC1lcSAnfScpIHsgaWYoJGRlcHRoIC1lcSAwKXt0aHJvdyAnVW5tYXRjaGVkIGdsb2IgYnJhY2UnfTsgJGRlcHRoLS07IFt2b2lkXSRyeC5BcHBlbmQoJyknKSB9CiAgICAgICAgICAgIGVsc2VpZiAoJGMgLWVxICcsJyAtYW5kICRkZXB0aCAtZ3QgMCkgeyBbdm9pZF0kcnguQXBwZW5kKCd8JykgfQogICAgICAgICAgICBlbHNlIHsgW3ZvaWRdJHJ4LkFwcGVuZChbcmVnZXhdOjpFc2NhcGUoW3N0cmluZ10kYykpIH0KICAgICAgICB9CiAgICAgICAgaWYoJGRlcHRoIC1uZSAwKXt0aHJvdyAnVW5jbG9zZWQgZ2xvYiBicmFjZSd9CiAgICAgICAgW3ZvaWRdJHJ4LkFwcGVuZCgnKD86Ly4qKT8kJykKICAgICAgICAkZmlsdGVyPVtyZWdleF06Om5ldygkcnguVG9TdHJpbmcoKSxbVGV4dC5SZWd1bGFyRXhwcmVzc2lvbnMuUmVnZXhPcHRpb25zXTo6Q3VsdHVyZUludmFyaWFudCxbVGltZVNwYW5dOjpGcm9tTWlsbGlzZWNvbmRzKDI1MCkpCiAgICB9CiAgICAkYmFzZSA9IGlmIChbSU8uRGlyZWN0b3J5XTo6RXhpc3RzKCRyb290KSkgeyAkcm9vdC5UcmltRW5kKCdcJywnLycpKydcJyB9IGVsc2UgeyBbSU8uUGF0aF06OkdldERpcmVjdG9yeU5hbWUoJHJvb3QpLlRyaW1FbmQoJ1wnLCcvJykrJ1wnIH0KICAgICRzdGFjaz1bQ29sbGVjdGlvbnMuR2VuZXJpYy5TdGFja1tzdHJpbmddXTo6bmV3KCk7JHN0YWNrLlB1c2goJHJvb3QpCiAgICAkbWF0Y2hlZD0kZmFsc2U7JHZpc2l0ZWQ9MAogICAgd2hpbGUgKCRzdGFjay5Db3VudCAtZ3QgMCkgewogICAgICAgICR2aXNpdGVkKys7aWYoJHZpc2l0ZWQgLWd0IDEwMDAwMCl7dGhyb3cgJ1NlYXJjaCBlbnRyeSBsaW1pdCBleGNlZWRlZCd9CiAgICAgICAgJHBhdGg9JHN0YWNrLlBvcCgpOyRhdHRycz1bSU8uRmlsZV06OkdldEF0dHJpYnV0ZXMoJHBhdGgpCiAgICAgICAgaWYgKCgkYXR0cnMgLWJhbmQgW0lPLkZpbGVBdHRyaWJ1dGVzXTo6UmVwYXJzZVBvaW50KSAtbmUgMCkgeyBjb250aW51ZSB9CiAgICAgICAgaWYgKCgkYXR0cnMgLWJhbmQgW0lPLkZpbGVBdHRyaWJ1dGVzXTo6RGlyZWN0b3J5KSAtbmUgMCkgewogICAgICAgICAgICBmb3JlYWNoICgkZW50cnkgaW4gW0lPLkRpcmVjdG9yeV06OkVudW1lcmF0ZUZpbGVTeXN0ZW1FbnRyaWVzKCRwYXRoKSkgewogICAgICAgICAgICAgICAgJG5hbWU9W0lPLlBhdGhdOjpHZXRGaWxlTmFtZSgkZW50cnkpCiAgICAgICAgICAgICAgICBpZiAoJG5hbWUuU3RhcnRzV2l0aCgnLicpIC1hbmQgLW5vdCAoJGZpbHRlciAtYW5kIC1ub3QgJG5lZ2F0ZSkpIHsgY29udGludWUgfQogICAgICAgICAgICAgICAgaWYgKChbSU8uRmlsZV06OkdldEF0dHJpYnV0ZXMoJGVudHJ5KSAtYmFuZCBbSU8uRmlsZUF0dHJpYnV0ZXNdOjpIaWRkZW4pIC1uZSAwIC1hbmQgLW5vdCAoJGZpbHRlciAtYW5kIC1ub3QgJG5lZ2F0ZSkpIHsgY29udGludWUgfQogICAgICAgICAgICAgICAgaWYoJHN0YWNrLkNvdW50IC1nZSAxMDAwMDApe3Rocm93ICdTZWFyY2ggcGVuZGluZyBlbnRyeSBsaW1pdCBleGNlZWRlZCd9CiAgICAgICAgICAgICAgICAkc3RhY2suUHVzaCgkZW50cnkpCiAgICAgICAgICAgIH0KICAgICAgICAgICAgY29udGludWUKICAgICAgICB9CiAgICAgICAgJHJlbGF0aXZlPSRwYXRoLlN1YnN0cmluZygkYmFzZS5MZW5ndGgpLlJlcGxhY2UoJ1wnLCcvJykKICAgICAgICBpZiAoJGZpbHRlcikgeyAkaW5jbHVkZWQ9JGZpbHRlci5Jc01hdGNoKCRyZWxhdGl2ZSk7IGlmICgkbmVnYXRlKSB7ICRpbmNsdWRlZD0tbm90ICRpbmNsdWRlZCB9OyBpZiAoLW5vdCAkaW5jbHVkZWQpIHsgY29udGludWUgfSB9CiAgICAgICAgJHN0cmVhbT1bSU8uRmlsZV06Ok9wZW4oJHBhdGgsW0lPLkZpbGVNb2RlXTo6T3BlbixbSU8uRmlsZUFjY2Vzc106OlJlYWQsW0lPLkZpbGVTaGFyZV06OlJlYWRXcml0ZSkKICAgICAgICB0cnkgewogICAgICAgICAgICAkaW5pdGlhbExlbmd0aD0kc3RyZWFtLkxlbmd0aAogICAgICAgICAgICBpZiAoJGluaXRpYWxMZW5ndGggLWd0IDEwNDg1NzYwMCkgeyB0aHJvdyAnU2VhcmNoIGZpbGUgZXhjZWVkcyAxMDAgTWlCIGxpbWl0JyB9CiAgICAgICAgICAgICRwcm9iZT1bYnl0ZVtdXTo6bmV3KDgxOTIpOyRjb3VudD0kc3RyZWFtLlJlYWQoJHByb2JlLDAsJHByb2JlLkxlbmd0aCkKICAgICAgICAgICAgJGJpbmFyeT0kZmFsc2U7Zm9yKCRpPTA7JGkgLWx0ICRjb3VudDskaSsrKXtpZigkcHJvYmVbJGldIC1lcSAwKXskYmluYXJ5PSR0cnVlO2JyZWFrfX0KICAgICAgICAgICAgaWYoJGJpbmFyeSl7Y29udGludWV9OyRzdHJlYW0uUG9zaXRpb249aWYoJGNvdW50IC1nZSAzIC1hbmQgJHByb2JlWzBdIC1lcSAyMzkgLWFuZCAkcHJvYmVbMV0gLWVxIDE4NyAtYW5kICRwcm9iZVsyXSAtZXEgMTkxKXszfWVsc2V7MH0KICAgICAgICAgICAgJHJlYWRlcj1bSU8uU3RyZWFtUmVhZGVyXTo6bmV3KCRzdHJlYW0sW1RleHQuVVRGOEVuY29kaW5nXTo6bmV3KCRmYWxzZSwkdHJ1ZSksJGZhbHNlLDY1NTM2LCR0cnVlKQogICAgICAgICAgICB0cnkgewogICAgICAgICAgICAgICAgJGxpbmVObz0wOyRsaW5lPVtUZXh0LlN0cmluZ0J1aWxkZXJdOjpuZXcoKTskY2hhcnM9W2NoYXJbXV06Om5ldyg2NTUzNikKICAgICAgICAgICAgICAgIHdoaWxlKCgkcmVhZD0kcmVhZGVyLlJlYWQoJGNoYXJzLDAsJGNoYXJzLkxlbmd0aCkpIC1ndCAwKSB7CiAgICAgICAgICAgICAgICAgICAgaWYoJHN0cmVhbS5Qb3NpdGlvbiAtZ3QgJGluaXRpYWxMZW5ndGggLW9yICRzdHJlYW0uUG9zaXRpb24gLWd0IDEwNDg1NzYwMCl7dGhyb3cgJ1NlYXJjaCBmaWxlIGdyZXcgYmV5b25kIGl0cyBpbml0aWFsIHNpemUnfQogICAgICAgICAgICAgICAgICAgICRjaHVuaz1bc3RyaW5nXTo6bmV3KCRjaGFycywwLCRyZWFkKTskb2Zmc2V0PTAKICAgICAgICAgICAgICAgICAgICB3aGlsZSgkb2Zmc2V0IC1sdCAkY2h1bmsuTGVuZ3RoKSB7CiAgICAgICAgICAgICAgICAgICAgICAgICRlbmQ9JGNodW5rLkluZGV4T2YoImBuIiwkb2Zmc2V0KQogICAgICAgICAgICAgICAgICAgICAgICAkbGVuZ3RoPWlmKCRlbmQgLWx0IDApeyRjaHVuay5MZW5ndGgtJG9mZnNldH1lbHNleyRlbmQtJG9mZnNldH0KICAgICAgICAgICAgICAgICAgICAgICAgaWYoJGxpbmUuTGVuZ3RoKyRsZW5ndGggLWd0IDEwNDg1NzYpe3Rocm93ICdTZWFyY2ggbGluZSBleGNlZWRzIDEwNDg1NzYgY2hhcmFjdGVyIGxpbWl0J30KICAgICAgICAgICAgICAgICAgICAgICAgW3ZvaWRdJGxpbmUuQXBwZW5kKCRjaHVuaywkb2Zmc2V0LCRsZW5ndGgpCiAgICAgICAgICAgICAgICAgICAgICAgIGlmKCRlbmQgLWx0IDApe2JyZWFrfQogICAgICAgICAgICAgICAgICAgICAgICAkbGluZU5vKys7JHRleHQ9JGxpbmUuVG9TdHJpbmcoKTtpZigkdGV4dC5FbmRzV2l0aCgiYHIiKSl7JHRleHQ9JHRleHQuU3Vic3RyaW5nKDAsJHRleHQuTGVuZ3RoLTEpfQogICAgICAgICAgICAgICAgICAgICAgICBpZigkbWF0Y2hlci5Jc01hdGNoKCR0ZXh0KSl7W0NvbnNvbGVdOjpPdXQuV3JpdGVMaW5lKCRwYXRoKyc6JyskbGluZU5vKyc6JyskdGV4dCk7JG1hdGNoZWQ9JHRydWV9CiAgICAgICAgICAgICAgICAgICAgICAgIFt2b2lkXSRsaW5lLkNsZWFyKCk7JG9mZnNldD0kZW5kKzEKICAgICAgICAgICAgICAgICAgICB9CiAgICAgICAgICAgICAgICB9CiAgICAgICAgICAgICAgICBpZigkc3RyZWFtLkxlbmd0aCAtbmUgJGluaXRpYWxMZW5ndGgpe3Rocm93ICdTZWFyY2ggZmlsZSBzaXplIGNoYW5nZWQgZHVyaW5nIHNlYXJjaCd9CiAgICAgICAgICAgICAgICBpZigkbGluZS5MZW5ndGggLWd0IDApeyRsaW5lTm8rKzskdGV4dD0kbGluZS5Ub1N0cmluZygpO2lmKCRtYXRjaGVyLklzTWF0Y2goJHRleHQpKXtbQ29uc29sZV06Ok91dC5Xcml0ZUxpbmUoJHBhdGgrJzonKyRsaW5lTm8rJzonKyR0ZXh0KTskbWF0Y2hlZD0kdHJ1ZX19CiAgICAgICAgICAgIH0gZmluYWxseSB7JHJlYWRlci5EaXNwb3NlKCl9CiAgICAgICAgfSBmaW5hbGx5IHskc3RyZWFtLkRpc3Bvc2UoKX0KICAgIH0KICAgIGlmKCRtYXRjaGVkKXtleGl0IDB9ZWxzZXtleGl0IDF9Cn0gY2F0Y2ggewogICAgW0NvbnNvbGVdOjpFcnJvci5Xcml0ZUxpbmUoJF8uRXhjZXB0aW9uLk1lc3NhZ2UpCiAgICBleGl0IDIKfQo="


def _grep_pin_writer(state):
    # Open our own thread while executing inside it. Never resolve a numeric
    # thread ID later: after exit Windows can recycle that ID for another owner.
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenThread.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenThread.restype = wintypes.HANDLE
        kernel.CancelSynchronousIo.argtypes = [wintypes.HANDLE]
        kernel.CancelSynchronousIo.restype = wintypes.BOOL
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenThread(1, False, threading.get_native_id())
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        with state["lock"]:
            state["kernel"], state["handle"] = kernel, handle


def _grep_cancel_writer(state):
    with state["lock"]:
        if state.get("handle") is not None:
            state["kernel"].CancelSynchronousIo(state["handle"])


def _grep_release_writer(thread, state):
    if thread.ident is None:
        return
    def release_after_join():
        thread.join()
        with state["lock"]:
            handle = state.pop("handle", None)
            if handle is not None:
                state["kernel"].CloseHandle(handle)
    if thread.is_alive():
        # Cancellation is bounded for the response, but a still-blocked writer
        # retains its pinned handle until it really exits. No late ID lookup.
        threading.Thread(target=release_after_join, daemon=True).start()
    else:
        release_after_join()


def _grep_run(cmd, cwd, payload=None):
    if not _shell_semaphore.acquire(timeout=30):
        return GrepFailure("ERROR: Too many concurrent shell executions, please try again later")
    proc = None
    captures = []
    writer = None
    writer_state = {"lock": threading.Lock()}
    write_stop = threading.Event()
    write_errors = []
    try:
        from types import SimpleNamespace
        deadline = time.monotonic() + 30.0
        kwargs = dict(cwd=cwd, stdin=subprocess.PIPE if payload is not None else subprocess.DEVNULL,
                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False, bufsize=0,
                      env=build_child_env())
        if sys.platform != "win32":
            kwargs["start_new_session"] = True
        proc = subprocess.Popen(cmd, **kwargs)
        for stream in (proc.stdout, proc.stderr):
            captures.append(_start_pump_threads(SimpleNamespace(stdout=stream, stderr=None)))
        if payload is not None:
            def send_input():
                try:
                    _grep_pin_writer(writer_state)
                    fd = proc.stdin.fileno()
                    offset = 0
                    while offset < len(payload) and not write_stop.is_set():
                        if sys.platform != "win32" and not select.select([], [fd], [], 0.05)[1]:
                            continue
                        offset += os.write(fd, payload[offset:offset + 4096])
                except Exception as error:
                    write_errors.append(str(error))
                finally:
                    proc.stdin.close()
            writer = threading.Thread(target=send_input, daemon=True)
            writer.start()
        code = proc.wait(timeout=max(0, deadline - time.monotonic()))
        if writer is not None:
            writer.join(timeout=max(0, deadline - time.monotonic()))
        for _, _, threads in captures:
            for thread in threads:
                thread.join(timeout=max(0, deadline - time.monotonic()))
        if ((writer is not None and writer.is_alive()) or
                any(thread.is_alive() for _, _, threads in captures for thread in threads)):
            raise subprocess.TimeoutExpired(cmd, 30)
        output = []
        for buf, lock, _ in captures:
            with lock:
                if buf["incomplete"]:
                    return GrepFailure("ERROR: grep output capture incomplete")
                output.append(_capture_text(buf))
        if code not in (0, 1):
            return GrepFailure(f"ERROR (exit={code}): {output[1]}")
        if write_errors:
            return GrepFailure("ERROR: grep input delivery failed: " + "; ".join(write_errors))
        return "(no matches)" if code == 1 else (output[0] or "(no matches)")
    except subprocess.TimeoutExpired:
        return GrepFailure("ERROR: grep timed out after 30000ms; output capture incomplete")
    except Exception as error:
        return GrepFailure(f"ERROR: {error}")
    finally:
        try:
            # No numeric PID termination after the owned parent has exited.
            if proc is not None and proc.poll() is None:
                _kill_proc_tree(proc)
            cleanup_deadline = time.monotonic() + 2.0
            write_stop.set()
            if writer is not None and writer.is_alive():
                _grep_cancel_writer(writer_state)
            for buf, lock, threads in captures:
                if any(thread.is_alive() for thread in threads):
                    _cancel_capture(buf, lock)
            if proc is not None:
                try:
                    proc.wait(timeout=max(0, cleanup_deadline - time.monotonic()))
                except subprocess.TimeoutExpired:
                    pass
            if writer is not None:
                while writer.is_alive() and time.monotonic() < cleanup_deadline:
                    _grep_cancel_writer(writer_state)
                    writer.join(timeout=min(0.05, max(0, cleanup_deadline - time.monotonic())))
            for _, _, threads in captures:
                for thread in threads:
                    thread.join(timeout=max(0, cleanup_deadline - time.monotonic()))
        finally:
            try:
                if writer is not None:
                    _grep_release_writer(writer, writer_state)
            finally:
                _shell_semaphore.release()


def _grep_resolve(root: Path, path: str) -> Path:
    requested = Path(path) if Path(path).is_absolute() else root / path
    target = Path(requested.anchor)
    for part in requested.parts[1:]:
        if target.exists() and not target.is_dir():
            raise NotADirectoryError("grep parent is not a directory")
        if part == "..":
            target = target.parent
        else:
            target = target / part
            if target.is_symlink():
                target = target.resolve(strict=True)
            elif target.exists():
                target = target.resolve()
    try:
        target.relative_to(root)
    except ValueError:
        target.relative_to(RESULT_SPILL_ROOT.resolve())
    info = target.stat()
    shape = path.replace("\\", "/") if os.name == "nt" else path
    if shape.rsplit("/", 1)[-1] in ("", ".", "..") and not stat.S_ISDIR(info.st_mode):
        raise NotADirectoryError("grep path uses directory syntax for a file")
    if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
        raise ValueError("grep path must be an existing regular file or directory")
    return target


def grep_files(pattern: str, paths: list[str], cwd: str = None, glob: str | None = None) -> str:
    try:
        if not isinstance(paths, list) or not paths:
            raise ValueError("grep paths must be a nonempty list")
        values = [("cwd", cwd), ("pattern", pattern)] + [("path", path) for path in paths]
        if glob is not None:
            values.append(("glob", glob))
        for name, value in values:
            if not isinstance(value, str) or (name in ("cwd", "path") and not value):
                raise ValueError(f"{name} must be {'a nonempty' if name in ('cwd', 'path') else 'a'} string")
            if "\0" in value:
                raise ValueError(f"{name} contains NUL")
            value.encode("utf-8", errors="strict")
        root = Path(cwd).resolve(strict=True)
        if not root.is_dir():
            raise ValueError("cwd must be an existing directory")
        valid_paths = []
        for p in paths:
            valid_paths.append(str(_grep_resolve(root, p)))
        if glob:
            norm_glob = glob.replace("\\", "/")
            if norm_glob.startswith("/") or norm_glob.startswith("~") or re.match(r"^[A-Za-z]:", norm_glob):
                raise ValueError("glob must be relative")
            if any(seg == ".." for seg in norm_glob.split("/")):
                raise ValueError("glob may not contain '..'")
        normalized_glob = glob.replace("\\", "/") if glob else ""
        binary = shutil.which("rg.exe" if sys.platform == "win32" else "rg")
        payload = None
        if binary:
            cmd = [str(Path(binary).resolve(strict=True)), "--no-config", "--line-number", "--with-filename", "--no-heading", "--color=never"]
            if glob:
                cmd.extend(["--glob", normalized_glob])
            # `--` so a pattern starting with `-` isn't parsed as a flag.
            cmd.append("--")
            cmd.extend([pattern] + valid_paths)
        elif sys.platform == "win32":
            if len(valid_paths) != 1:
                raise ValueError("Windows grep fallback requires one search root")
            binary = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
            script = base64.b64decode(_GREP_FALLBACK_SCRIPT_B64).decode("utf-8")
            encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
            cmd = [str(binary), "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded]
            payload = json.dumps({"path": valid_paths[0], "pattern": pattern, "glob": normalized_glob},
                                 ensure_ascii=False).encode("utf-8")
        else:
            binary = shutil.which("grep")
            if not binary:
                raise FileNotFoundError("neither ripgrep nor grep is available")
            cmd = [str(Path(binary).resolve(strict=True)), "-rEnH"]
            if glob:
                cmd.extend(["--include", normalized_glob])
            cmd.append("--")
            cmd.extend([pattern] + valid_paths)
        return _grep_run(cmd, str(root), payload)
    except Exception as e:
        return GrepFailure(f"ERROR: {e}")


_FIND_NOISE = frozenset(("node_modules", ".git", ".next", ".nuxt", ".turbo", ".cache",
                         "dist", "build", "out", "target", "coverage", ".venv", "venv",
                         "__pycache__", ".pytest_cache", ".mypy_cache", ".idea", ".vscode"))


def _find_patterns(pattern: str) -> list[tuple[str, list]]:
    """Compile portable globs to bounded, non-backtracking token sequences."""
    pattern = pattern.replace("\\", "/")
    if pattern.startswith(("/", "~")) or re.match(r"^[A-Za-z]:", pattern):
        raise ValueError("pattern must be relative to the working directory")
    if ".." in pattern.split("/"):
        raise ValueError("pattern may not contain '..'")
    while pattern.startswith("./"):
        pattern = pattern[2:]
    if not pattern or len(pattern) > 4096:
        raise ValueError("pattern must contain 1 to 4096 characters")
    pending = [(pattern, 0)]
    expanded = []
    while pending:
        current, depth = pending.pop()
        start = -1
        balance = 0
        in_class = False
        class_first = -1
        pieces = []
        cut = 0
        end = -1
        for i, ch in enumerate(current):
            if ch == "[" and not in_class:
                in_class = True
                class_first = i + 1
                if class_first < len(current) and current[class_first] in "!^":
                    class_first += 1
            elif ch == "]" and in_class and i > class_first:
                in_class = False
            elif not in_class:
                if ch == "{":
                    if balance == 0:
                        start = i
                        cut = i + 1
                    balance += 1
                elif ch == "}":
                    if balance == 0:
                        raise ValueError("unmatched glob brace")
                    balance -= 1
                    if balance == 0:
                        pieces.append(current[cut:i])
                        end = i
                        break
                elif ch == "," and balance == 1:
                    pieces.append(current[cut:i])
                    cut = i + 1
        if balance:
            raise ValueError("unmatched glob brace")
        if end >= 0:
            if depth >= 16 or len(pieces) < 2:
                raise ValueError("glob braces require alternatives and at most 16 expansions in depth")
            for piece in pieces:
                pending.append((current[:start] + piece + current[end + 1:], depth + 1))
            if len(pending) + len(expanded) > 256:
                raise ValueError("glob exceeds 256 alternatives")
            continue
        expanded.append(current)
    compiled = []
    total_tokens = 0
    for current in expanded:
        if current.startswith(("/", "~")) or re.match(r"^[A-Za-z]:", current) or ".." in current.split("/"):
            raise ValueError("glob alternatives must be relative and may not contain '..'")
        if "/" not in current:
            current = "**/" + current
        tokens = []
        i = 0
        while i < len(current):
            ch = current[i]
            if ch == "*":
                j = i
                while j < len(current) and current[j] == "*":
                    j += 1
                whole_segment = (i == 0 or current[i - 1] == "/") and (j == len(current) or current[j] == "/")
                if j - i >= 2 and whole_segment:
                    if j < len(current):
                        tokens.append(("G", None))
                        j += 1
                    else:
                        tokens.append(("D", None))
                else:
                    tokens.append(("S", None))
                i = j
                continue
            if ch == "?":
                tokens.append(("Q", None))
            elif ch == "[":
                j = i + 1
                negate = j < len(current) and current[j] in "!^"
                if negate:
                    j += 1
                ranges = []
                while j < len(current) and (current[j] != "]" or not ranges):
                    lo = ord(current[j])
                    if current[j] == "/":
                        raise ValueError("glob classes cannot contain separators")
                    if j + 2 < len(current) and current[j + 1] == "-" and current[j + 2] != "]":
                        hi = ord(current[j + 2])
                        if hi < lo or current[j + 2] == "/":
                            raise ValueError("invalid glob class range")
                        j += 3
                    else:
                        hi = lo
                        j += 1
                    ranges.append((lo, hi))
                if j == len(current) or not ranges:
                    raise ValueError("unclosed or empty glob class")
                tokens.append(("C", (negate, ranges)))
                i = j
            elif ch in "{}]":
                raise ValueError("unmatched glob delimiter")
            else:
                tokens.append(("L", ch))
            i += 1
        total_tokens += len(tokens)
        if total_tokens > 16384:
            raise ValueError("glob exceeds token budget")
        compiled.append((current, tokens))
    return compiled


def _find_matches(tokens: list, value: str, budget: list[int], prefix: bool = False) -> bool:
    length = len(value)
    budget[0] -= sum(max(1, len(data[1])) if kind == "C" else 1 for kind, data in tokens) * (length + 1)
    if budget[0] < 0:
        raise ValueError("find exceeds glob matching work limit")
    previous = [False] * (length + 1)
    previous[0] = True
    for kind, data in tokens:
        current = [False] * (length + 1)
        if kind in ("S", "D", "G"):
            current[0] = previous[0]
            seen = previous[0]
            for j in range(1, length + 1):
                ch = value[j - 1]
                if kind == "G":
                    current[j] = previous[j] or (seen and ch == "/")
                    seen = seen or previous[j]
                else:
                    current[j] = previous[j] or (current[j - 1] and (kind == "D" or ch != "/"))
        else:
            for j in range(1, length + 1):
                if not previous[j - 1]:
                    continue
                ch = value[j - 1]
                if kind == "L":
                    match = ch == data
                elif kind == "Q":
                    match = ch != "/"
                else:
                    negate, ranges = data
                    inside = any(lo <= ord(ch) <= hi for lo, hi in ranges)
                    match = ch != "/" and (inside != negate)
                current[j] = previous[j - 1] and match
        if prefix and current[length]:
            return True
        previous = current
    return previous[length]


def find_files(pattern: str, cwd: str = ".", path: str = ".", include_hidden: bool = False) -> str:
    try:
        for name, value in (("cwd", cwd), ("pattern", pattern), ("path", path)):
            if not isinstance(value, str) or not value:
                raise ValueError(f"{name} must be a nonempty string")
            if "\0" in value:
                raise ValueError(f"{name} contains NUL")
            value.encode("utf-8", errors="strict")
        if type(include_hidden) is not bool:
            raise ValueError("include_hidden must be a boolean")
        root = Path(cwd).resolve(strict=True)
        if not root.is_dir():
            raise ValueError("cwd must be an existing directory")
        base = _grep_resolve(root, path)
        if not base.is_dir():
            raise ValueError("path must be an existing directory")
        patterns = _find_patterns(pattern)
        explicit = {part for glob, _ in patterns for part in glob.split("/") if not any(ch in part for ch in "*?[")}
        hidden_patterns = [part for glob, _ in patterns for part in glob.split("/") if part.startswith(".")]
        hidden_tokens = [_find_patterns(part)[0][1][1:] for part in hidden_patterns]
        deadline = time.monotonic() + 30
        budget = [10_000_000]
        pending = [(base, "", 0)]
        results = []
        visited = 0
        output_bytes = 0
        while pending:
            directory, prefix, depth = pending.pop()
            if time.monotonic() >= deadline:
                raise ValueError("find timed out after 30000 ms")
            # Recheck the physical directory immediately before enumeration.
            if directory.resolve(strict=True) != directory:
                continue
            with os.scandir(directory) as entries:
                for entry in entries:
                    visited += 1
                    if visited > 100_000:
                        raise ValueError("find exceeds 100000 filesystem entries")
                    if time.monotonic() >= deadline:
                        raise ValueError("find timed out after 30000 ms")
                    name = entry.name
                    if name.startswith(".") and not include_hidden and not any(_find_matches(tokens, name, budget) for tokens in hidden_tokens):
                        continue
                    info = entry.stat(follow_symlinks=False)
                    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                        continue
                    rel = prefix + name
                    if stat.S_ISDIR(info.st_mode):
                        if name in _FIND_NOISE and name not in explicit:
                            continue
                        if not any(_find_matches(tokens, rel + "/", budget, prefix=True) for _, tokens in patterns):
                            continue
                        if depth >= 256:
                            raise ValueError("find exceeds 256 directory levels")
                        pending.append((Path(entry.path), rel + "/", depth + 1))
                    elif stat.S_ISREG(info.st_mode) and any(_find_matches(tokens, rel, budget) for _, tokens in patterns):
                        physical = Path(entry.path).resolve(strict=True)
                        if not physical.is_relative_to(root):
                            continue
                        result = physical.relative_to(root).as_posix()
                        output_bytes += len(result.encode("utf-8")) + 1
                        if len(results) >= 10_000 or output_bytes > 1_000_000:
                            raise ValueError("find result limit exceeded (10000 files or 1000000 UTF-8 bytes); narrow the pattern/path")
                        results.append(result)
        return "\n".join(sorted(results, key=lambda s: s.encode("utf-16-be"))) if results else "(no matches)"
    except Exception as e:
        return FindFailure(f"ERROR: {e}")


def list_directory(path: str = ".", cwd: str = ".") -> str:
    try:
        for name, value in (("cwd", cwd), ("path", path)):
            if not isinstance(value, str) or not value:
                raise ValueError(f"{name} must be a nonempty string")
            if "\0" in value:
                raise ValueError(f"{name} contains NUL")
            value.encode("utf-8", errors="strict")
        root = Path(cwd).resolve(strict=True)
        if not root.is_dir():
            raise ValueError("cwd must be an existing directory")
        directory = _grep_resolve(root, path)
        if not directory.is_dir():
            raise ValueError("path must be an existing directory")
        lines = []
        size = 0
        deadline = time.monotonic() + 30
        with os.scandir(directory) as entries:
            for entry in entries:
                if len(lines) >= 100_000:
                    raise ValueError("ls exceeds 100000 entries; choose a narrower directory")
                if time.monotonic() >= deadline:
                    raise ValueError("ls timed out after 30000 ms")
                entry.name.encode("utf-8", errors="strict")
                try:
                    info = entry.stat(follow_symlinks=False)
                    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                        line = f"l{0:>10} {entry.name}"
                    elif stat.S_ISDIR(info.st_mode):
                        line = f"d{0:>10} {entry.name}"
                    elif stat.S_ISREG(info.st_mode):
                        line = f"-{info.st_size:>10} {entry.name}"
                    else:
                        line = f"? {entry.name}"
                except OSError:
                    line = f"? {entry.name}"
                size += len(line.encode("utf-8")) + 1
                if size > 1_000_000:
                    raise ValueError("ls exceeds 1000000 UTF-8 bytes; choose a narrower directory")
                lines.append(line)
        return "\n".join(sorted(lines, key=lambda line: line.encode("utf-16-be")))
    except Exception as error:
        return LsFailure(f"ERROR: {error}")


def get_job_status(job_id: str) -> dict:
    with jobs_lock:
        job = jobs.get(job_id)
        if job is not None:
            return {"status": job.get("status", "unknown"), "success": True}
    return {"error": "Job not found", "success": False}


def list_jobs() -> str:
    with jobs_lock:
        snapshot = list(jobs.items())
    if not snapshot:
        return "(no jobs)"
    lines = []
    for jid, j in snapshot:
        status = j.get("status", "unknown")
        exit_info = f" {j.get('exit_code')}" if j.get("exit_code") is not None else ""
        lines.append(f"{jid} [{status}{exit_info}] {j.get('command', '')}")
    return "\n".join(lines)


def start_job(command: str, cwd: str, _argv=None) -> str:
    global total_jobs, job_seq
    try:
        _ensure_windows_root_owner()
    except Exception as error:
        return f"ERROR: failed to establish process ownership: {error}"
    popen_kwargs = dict(
        shell=False,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        stdin=subprocess.DEVNULL,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=build_child_env(),
    )
    if sys.platform != "win32":
        popen_kwargs["start_new_session"] = True
    # Publish the process and its capture ownership before shutdown can take
    # its snapshot. This serializes OS spawn latency under jobs_lock, but keeps
    # daemon request threads from leaving an untracked child during shutdown.
    with jobs_lock:
        _prune_jobs_locked()
        if total_jobs >= MAX_CONCURRENT_JOBS:
            return f"ERROR: max concurrent jobs ({MAX_CONCURRENT_JOBS}) exceeded"
        if shutting_down:
            return "ERROR: server is shutting down"
        total_jobs += 1
        job_seq += 1
        job_id = f"j{job_seq}"
        try:
            argv = _job_command(command) if _argv is None else _argv
            if sys.platform == "win32":
                # Reuse the suspended-spawn, kill-on-close Windows owner without
                # registering a background job as an MCP protocol connection.
                with _mcp_spawn_lock:
                    executable = _mcp_windows_job_helper()
                    if shutting_down:
                        raise IOError("server is shutting down")
                    launch = ([executable, str(os.getpid()), "job", "raw", argv]
                              if isinstance(argv, str) else
                              [executable, str(os.getpid()), "job", "argv", *argv])
                    proc = subprocess.Popen(launch, **popen_kwargs)
            else:
                proc = subprocess.Popen(argv, **popen_kwargs)
        except Exception as e:
            total_jobs = max(0, total_jobs - 1)
            return f"ERROR: failed to start job: {e}"
        buf, buf_lock, pump_threads = _start_pump_threads(proc)
        job = {
            "id": job_id,
            "command": command,
            "proc": proc,
            "_buf": buf,
            "_buf_lock": buf_lock,
            "_pump_threads": pump_threads,
            "_finalize_lock": threading.Lock(),
            "output": "",  # finalized on exit; live reads go through _buf
            "status": "running",
            "started_at": time.time(),
        }
        jobs[job_id] = job

    _watch_job(job)
    return f"started {job_id}"


def stop_job(job_id: str, timeout_ms: int = 500) -> str:
    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        return JobFailure(f"ERROR: no such job: {job_id}")
    if job["status"] != "running":
        return f"{job_id} already {job['status']}"
    deadline = time.monotonic() + 3.0
    proc = job["proc"]
    confirmed = True
    if proc.poll() is None:
        if sys.platform == "win32":
            confirmed = _kill_proc_tree(proc)
        else:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                confirmed = False
                if proc.poll() is None:
                    proc.terminate()
            try:
                proc.wait(timeout=min(1.0, timeout_ms / 1000, max(0, deadline - time.monotonic())))
            except subprocess.TimeoutExpired:
                pass
            if proc.poll() is None:
                confirmed = _kill_proc_tree(proc) and confirmed
            else:
                # Never send another signal to a numeric group after its owned
                # parent exits. A still-existing group makes cleanup uncertain.
                try:
                    os.killpg(proc.pid, 0)
                    confirmed = False
                except ProcessLookupError:
                    pass
                except PermissionError:
                    confirmed = False
    # The existing watcher owns capture finalization. Waiting on its published
    # state avoids taking a finalizer lock past this request's deadline.
    while time.monotonic() < deadline:
        if job.get("_finalized") and not any(t.is_alive() for t in job["_pump_threads"]):
            break
        time.sleep(min(0.01, max(0, deadline - time.monotonic())))
    with job["_buf_lock"]:
        incomplete = job["_buf"].get("incomplete", False)
    if (not confirmed or proc.poll() is None or not job.get("_finalized")
            or any(t.is_alive() for t in job["_pump_threads"]) or incomplete):
        return JobFailure(f"ERROR: {job_id} termination incomplete; process-tree termination or final capture could not be confirmed")
    return f"{job_id} stopped"


def view_job(job_id: str) -> str:
    with jobs_lock:
        job = jobs.get(job_id)
    if job is None:
        return f"ERROR: no such job: {job_id}"
    status = job.get("status", "unknown")
    exit_code = job.get("exit_code")
    buf = job.get("_buf")
    buf_lock = job.get("_buf_lock")
    if buf is not None and buf_lock is not None and not job.get("_finalized"):
        with buf_lock:
            output = _capture_text(buf)
    else:
        output = job.get("output", "")
    exit_info = f" {exit_code}" if exit_code is not None else ""
    return f"[{job_id}] {job.get('command', '')}\n[{status}{exit_info}]\n{output}"


def _shell_tool_name() -> str:
    return {
        ShellType.BASH: "bash",
        ShellType.SH: "shell",
        ShellType.CMD: "command",
        ShellType.POWERSHELL: "powershell",
    }.get(get_shell_type(), "bash")


def _shell_tool_description() -> str:
    lead = {
        ShellType.BASH: "Run a bash command.",
        ShellType.SH: "Run a POSIX sh command.",
        ShellType.CMD: "Run a Windows CMD command.",
        ShellType.POWERSHELL: "Run a PowerShell command.",
    }.get(get_shell_type(), "Run a bash command.")
    return (f"{lead} Returns combined stdout+stderr. If still running at 60s with no "
            f"timeout_ms set, auto-detaches into the `job` tool (the return value carries "
            f"the job id). Pass an explicit timeout_ms to force kill-on-timeout instead.")


# tools/list is built on every request; cache it (the tool set is static
# after startup apart from aggregator loads, which invalidate the cache).
_tools_list_cache: Optional[list[dict]] = None


def invalidate_tools_list() -> None:
    global _tools_list_cache
    _tools_list_cache = None


def build_tools_list() -> list[dict]:
    global _tools_list_cache
    if _tools_list_cache is not None:
        return _tools_list_cache
    tools: list[dict] = [
        {"name": "read", "description": "Read a file. Optional line range [start,end] (1-indexed, inclusive). Pass no_truncate=true to disable output truncation.",
         "inputSchema": {"type": "object", "properties": {"cwd": {"type": "string"}, "path": {"type": "string"}, "range": {"type": "array", "items": {"type": "integer", "minimum": 1, "maximum": 9007199254740991}, "minItems": 2, "maxItems": 2}, "no_truncate": {"type": "boolean"}}, "required": ["cwd", "path"]}},
        {"name": "write", "description": "Write/overwrite a file with the given content.",
         "inputSchema": {"type": "object", "properties": {"cwd": {"type": "string"}, "path": {"type": "string"}, "content": {"type": "string"}}, "required": ["cwd", "path", "content"]}},
        {"name": "edit", "description": "Replace literal old_str with new_str in a UTF-8 file. old_str must be nonempty and occur exactly once, including overlapping occurrences.",
         "inputSchema": {"type": "object", "properties": {"cwd": {"type": "string"}, "path": {"type": "string"}, "old_str": {"type": "string", "minLength": 1}, "new_str": {"type": "string"}}, "required": ["cwd", "path", "old_str", "new_str"]}},
        {"name": "multi_edit", "description": "Apply ordered edits after validating and staging the entire batch. Atomically replace each file with guarded rollback on failure; simultaneous multi-file visibility and crash atomicity are not guaranteed. At most 1000 edits and 100 MiB total original/working UTF-8 text. old_str must be nonempty and occur exactly once, including overlaps, in the current text after preceding edits.",
         "inputSchema": {"type": "object", "properties": {"cwd": {"type": "string"}, "edits": {"type": "array", "minItems": 1, "maxItems": 1000, "items": {"type": "object", "properties": {"path": {"type": "string"}, "old_str": {"type": "string", "minLength": 1}, "new_str": {"type": "string"}}, "required": ["path", "old_str", "new_str"]}}}, "required": ["cwd", "edits"]}},
        {"name": _shell_tool_name(), "description": _shell_tool_description(),
         "inputSchema": {"type": "object", "properties": {"cwd": {"type": "string", "minLength": 1}, "command": {"type": "string"}, "timeout_ms": {"type": "integer", "minimum": 1, "maximum": 2147483647}}, "required": ["cwd", "command"]}},
        {"name": "grep", "description": "Search files by regex, preferring ripgrep. Windows fallback uses PowerShell/.NET; POSIX fallback uses grep ERE. Regex and ignore features may differ by backend. Windows fallback skips hidden, reparse and binary files by default; explicit targets or positive globs allow hidden files. Ignore files require ripgrep.",
         "inputSchema": {"type": "object", "properties": {"cwd": {"type": "string"}, "pattern": {"type": "string"}, "path": {"type": "string"}, "glob": {"type": "string"}}, "required": ["cwd", "pattern"]}},
        {"name": "find", "description": "Find regular files with case-sensitive globs (*, ?, [], {a,b}, **). Bare patterns match at any depth. Returns sorted cwd-relative paths. Prunes common noise directories unless explicitly named; dot names require include_hidden=true or an explicit dot component. Skips symlink/reparse entries during traversal. Search/output/complexity limits return errors; narrow the pattern or path (maximum 10000 results, 1000000 UTF-8 bytes, 100000 entries, 256 directory levels).",
         "inputSchema": {"type": "object", "properties": {"cwd": {"type": "string"}, "pattern": {"type": "string"}, "path": {"type": "string"}, "include_hidden": {"type": "boolean"}}, "required": ["cwd", "pattern"]}},
        {"name": "ls", "description": "List one directory, including hidden entries. Sorted lines contain type, byte size and name: '-' file, 'd' directory, 'l' link (target metadata is not followed), '?' unavailable or unsupported metadata. Directory/link sizes are 0. Errors above 100000 entries or 1000000 UTF-8 output bytes.",
         "inputSchema": {"type": "object", "properties": {"cwd": {"type": "string"}, "path": {"type": "string"}}, "required": ["cwd"]}},
        {"name": "job", "description": "Manage background jobs using the selected shell. mode: list|view|start|stop; list is in creation order. command is required for start, or holds the job id for view/stop. cwd is required but used only for start. timeout_ms is stop grace (default 500 ms, capped at 1000); Windows forces termination immediately. Stop uses a shared 3000 ms process/capture confirmation deadline and reports incomplete cleanup as an error.",
         "inputSchema": {"type": "object", "properties": {"cwd": {"type": "string"}, "mode": {"type": "string", "enum": ["list", "view", "start", "stop"]}, "command": {"type": "string"}, "timeout_ms": {"type": "number"}}, "required": ["cwd", "mode"]}},
        {"name": "mcp", "description": "Manage MCP servers from local .mcp.json files. Actions:   list: List all servers defined in .mcp.json for cwd   list server=X: Load server X and return its tools   call server=X tool=Y args={}: Call tool Y on loaded server X   unload: Unload all servers for this cwd   unload server=X: Unload server X from the selected configuration file. If a config alias was removed, use unload without server or supply the physical config path.",
         "inputSchema": {"type": "object", "properties": {"cwd": {"type": "string", "minLength": 1, "description": "Working directory containing .mcp.json"}, "action": {"type": "string", "enum": ["list", "call", "unload"], "description": "Action to perform"}, "server": {"type": "string", "minLength": 1, "description": "Server name (required for call, optional for list/unload)"}, "tool": {"type": "string", "minLength": 1, "description": "Tool name (required for call)"}, "args": {"type": "object", "description": "Tool arguments (defaults to an empty object)", "default": {}, "additionalProperties": True}, "mcpConfigPath": {"type": "string", "minLength": 1, "default": ".mcp.json", "description": "Path to .mcp.json relative to cwd"}}, "required": ["cwd", "action"]}},
    ]
    if memory_enabled:
        tools.extend([
            {"name": "remember", "description": "Append a memo. Returns the assigned id.",
             "inputSchema": {"type": "object", "properties": {"cwd": {"type": "string"}, "memo": {"type": "string"}, "tags": {"type": "array", "items": {"type": "string"}}}, "required": ["cwd", "memo"]}},
            {"name": "forget", "description": "Remove a memo by id.",
             "inputSchema": {"type": "object", "properties": {"cwd": {"type": "string"}, "memo_id": {"type": "number"}}, "required": ["cwd", "memo_id"]}},
            {"name": "recall", "description": "Search memos by substring (query) and/or tags (AND). Both are case-insensitive. Sorted newest first. Paginated.",
             "inputSchema": {"type": "object", "properties": {"cwd": {"type": "string"}, "query": {"type": "string"}, "tags": {"type": "array", "items": {"type": "string"}}, "limit": {"type": "number"}, "offset": {"type": "number"}}, "required": ["cwd"]}},
        ])
    tools.append({"name": "guide",
                  "description": "Operating manual for this code-mcp server: live state, session-start ritual, when to remember, tool catalog. Call at session start.",
                  "inputSchema": {"type": "object", "properties": {"cwd": {"type": "string"}}, "required": ["cwd"]}})
    # Merge in aggregated external tools (boot-probed via --mcp).
    with aggregator_lock:
        for prefixed_name, info in aggregator_tools.items():
            tools.append({
                **info.get("definition", {}),
                "name": prefixed_name,
                "description": info.get("description", ""),
                "inputSchema": info.get("inputSchema", {"type": "object"}),
            })
    if has_cloudflared:
        tools.append({"name": "preview", "description": "Start a Cloudflare quick tunnel to the given local URL and return the public URL.",
                      "inputSchema": {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]}})
    if (public_domain or make_public) and token:
        tools.append({"name": "get_upload_link",
                      "description": "Return an upload link the user can open to upload files to Tuan's local machine. Files are saved to `${UPLOAD_ROOT}/<session_id>/`. Session is valid for 10 minutes. Returns a JSON object with: `url` (the upload URL), `expiresInMinutes` (10), `widget` (an HTML button matching the upload page style), and `hint`. When responding to the user, render the `widget` HTML by calling the `visualize:show_widget` tool (or equivalent) so the user sees a clickable button instead of a raw URL. Also include the URL as a markdown link in your response as a fallback for clients that don't render widgets.",
                      "inputSchema": {"type": "object", "properties": {}, "required": []}})
    _tools_list_cache = [t for t in tools if t["name"] not in disallowed_tools]
    return _tools_list_cache


class UnknownToolFailure(str):
    """Dispatch marker, distinct from text returned by a successful tool."""


def dispatch_tool(tool_name: str, params: dict) -> Any:
    """Dispatch a single tool call. Used by both tools/call and raw-method handlers."""
    shell_aliases = {"bash": ShellType.BASH, "shell": ShellType.SH,
                     "command": ShellType.CMD, "powershell": ShellType.POWERSHELL}
    if tool_name in disallowed_tools:
        if tool_name in shell_aliases:
            return ShellFailure(f"ERROR: tool '{tool_name}' disabled")
        if tool_name == "grep":
            return GrepFailure("ERROR: tool 'grep' disabled")
        return ToolFailure(f"ERROR: tool '{tool_name}' disabled")
    # Only allow the shell tool matching the detected shell (parity with Java/TS).
    if tool_name in shell_aliases:
        try:
            if shell_aliases[tool_name] != get_shell_type():
                raise ValueError(f"tool '{tool_name}' not available on this shell ({get_shell_type().value})")
            if not isinstance(params, dict):
                raise ValueError("arguments must be an object")
            for name in ("cwd", "command"):
                value = params.get(name)
                if not isinstance(value, str) or (name == "cwd" and not value):
                    raise ValueError(f"{name} must be {'a nonempty' if name == 'cwd' else 'a'} string")
                if "\0" in value:
                    raise ValueError(f"{name} contains NUL")
                value.encode("utf-8", errors="strict")
            cwd = params["cwd"]
            if not Path(cwd).is_dir():
                raise ValueError("cwd must be an existing directory")
            timeout = None
            if "timeout_ms" in params:
                value = params["timeout_ms"]
                if (type(value) not in (int, float) or not 1 <= value <= 2147483647
                        or int(value) != value):
                    raise ValueError("timeout_ms must be an integer from 1 to 2147483647")
                timeout = int(value)
            execute = {"bash": execute_bash, "shell": execute_shell,
                       "command": execute_command, "powershell": execute_powershell}[tool_name]
            return execute(params["command"], cwd, timeout)
        except Exception as error:
            return ShellFailure(f"ERROR: {error}")
    if tool_name in ("remember", "recall", "forget"):
        if not memory_enabled:
            return UnknownToolFailure(f"ERROR:-32601: unknown tool: {tool_name}")
        try:
            if not isinstance(params, dict):
                raise ValueError(f"{tool_name} arguments must be an object")
            cwd, memo = params.get("cwd"), params.get("memo")
            if not isinstance(cwd, str) or not cwd:
                raise ValueError("cwd must be a nonempty string")
            if "\0" in cwd:
                raise ValueError("cwd contains NUL")
            cwd.encode("utf-8", errors="strict")
            if tool_name == "remember" and not isinstance(memo, str):
                raise ValueError("memo must be a string")
            directory = Path(cwd).resolve(strict=True)
            if not directory.is_dir():
                raise ValueError("cwd must be an existing directory")
            if tool_name == "forget":
                memo_id = params.get("memo_id")
                if (type(memo_id) not in (int, float) or not math.isfinite(memo_id)
                        or memo_id < 1 or memo_id > 9007199254740991 or int(memo_id) != memo_id):
                    raise ValueError("memo_id must be a positive safe integer")
                return handle_forget(str(directory), int(memo_id))
            if tool_name == "recall":
                return handle_recall(str(directory), params.get("query"), params.get("tags"), params.get("limit"), params.get("offset"))
            return handle_remember(str(directory), memo, params.get("tags"))
        except Exception as error:
            return ToolFailure(f"ERROR: {error}")
    if tool_name == "preview":
        if not has_cloudflared:
            return UnknownToolFailure("ERROR:-32601: unknown tool: preview")
        try:
            if not isinstance(params, dict):
                raise ValueError("preview arguments must be an object")
            return handle_preview(params.get("url"))
        except Exception as error:
            return ToolFailure(f"ERROR: {error}")
    if tool_name == "get_upload_link":
        if not (public_domain or make_public) or not token:
            return UnknownToolFailure("ERROR:-32601: unknown tool: get_upload_link")
        try:
            if not isinstance(params, dict):
                raise ValueError("get_upload_link arguments must be an object")
            return handle_get_upload_link()
        except Exception as error:
            return ToolFailure(f"ERROR: {error}")
    if tool_name == "guide":
        try:
            if not isinstance(params, dict):
                raise ValueError("guide arguments must be an object")
            cwd = params.get("cwd")
            if not isinstance(cwd, str) or not cwd:
                raise ValueError("cwd must be a nonempty string")
            if "\0" in cwd:
                raise ValueError("cwd contains NUL")
            cwd.encode("utf-8", errors="strict")
            directory = Path(cwd).resolve(strict=True)
            if not directory.is_dir():
                raise ValueError("cwd must be an existing directory")
            return render_guide(str(directory))
        except Exception as error:
            return ToolFailure(f"ERROR: {error}")
    cwd = params.get("cwd", ".") if isinstance(params, dict) else "."
    try:
        if tool_name == "read":
            if not isinstance(params, dict):
                return ReadFailure("ERROR: arguments must be an object")
            return read_file(params.get("path"), params.get("cwd"),
                             range=params.get("range", _READ_RANGE_OMITTED),
                             no_truncate=params.get("no_truncate", False))
        if tool_name == "write":
            if not isinstance(params, dict):
                return WriteFailure("ERROR: arguments must be an object")
            return write_file(params.get("path"), params.get("content"), params.get("cwd"))
        if tool_name == "edit":
            if not isinstance(params, dict):
                return EditFailure("ERROR: arguments must be an object")
            return edit_file(params.get("path"), params.get("old_str"),
                             params.get("new_str"), params.get("cwd"))
        if tool_name == "multi_edit":
            if not isinstance(params, dict):
                return MultiEditFailure("ERROR: arguments must be an object")
            return multi_edit_files(params.get("edits"), params.get("cwd"))
        if tool_name == "grep":
            if not isinstance(params, dict):
                return GrepFailure("ERROR: arguments must be an object")
            if "glob" in params and not isinstance(params["glob"], str):
                return GrepFailure("ERROR: glob must be a string")
            return grep_files(params.get("pattern"),
                              [params.get("path", ".")], params.get("cwd"),
                              params.get("glob"))
        if tool_name == "find":
            if not isinstance(params, dict):
                return FindFailure("ERROR: arguments must be an object")
            return find_files(params.get("pattern"), params.get("cwd"),
                              params.get("path", "."),
                              params.get("include_hidden", False))
        if tool_name == "ls":
            if not isinstance(params, dict):
                return LsFailure("ERROR: arguments must be an object")
            return list_directory(params.get("path", "."), params.get("cwd"))
        if tool_name == "job":
            try:
                if not isinstance(params, dict):
                    raise ValueError("arguments must be an object")
                for key in ("cwd", "mode"):
                    value = params.get(key)
                    if not isinstance(value, str) or not value:
                        raise ValueError(f"{key} must be a nonempty string")
                    if "\0" in value:
                        raise ValueError(f"{key} contains NUL")
                    value.encode("utf-8", errors="strict")
                mode, cwd = params["mode"], params["cwd"]
                if mode not in ("list", "start", "view", "stop"):
                    raise ValueError(f"unknown mode: {mode}")
                command = params.get("command")
                if mode != "list" or "command" in params:
                    if not isinstance(command, str) or (mode != "list" and not command):
                        raise ValueError("command must be a string and nonempty for start/view/stop")
                    if "\0" in command:
                        raise ValueError("command contains NUL")
                    command.encode("utf-8", errors="strict")
                timeout = params.get("timeout_ms", 500)
                if type(timeout) not in (int, float) or not 1 <= timeout <= 2147483647 or int(timeout) != timeout:
                    raise ValueError("timeout_ms must be an integer from 1 to 2147483647")
                if mode == "start":
                    directory = Path(cwd).resolve(strict=True)
                    if not directory.is_dir():
                        raise ValueError("cwd must be an existing directory")
                    result = start_job(command, str(directory))
                elif mode == "list":
                    result = list_jobs()
                elif mode == "view":
                    result = view_job(command)
                else:
                    result = stop_job(command, int(timeout))
                return JobFailure(result) if result.startswith("ERROR:") else result
            except Exception as error:
                return JobFailure(f"ERROR: {error}")
        if tool_name == "forget":
            if not memory_enabled:
                return "ERROR: memory disabled"
            try:
                return handle_forget(cwd, params.get("memo_id", 0))
            except ValueError as e:
                return f"ERROR: {e}"
        if tool_name == "preview":
            if not has_cloudflared:
                return "ERROR: cloudflared not on PATH"
            return handle_preview(params.get("url", ""))
        if tool_name == "get_upload_link":
            return handle_get_upload_link()
        if tool_name == "mcp":
            try:
                if not isinstance(params, dict):
                    raise ValueError("arguments must be an object")
                def string(key, required=True, default=None):
                    if not required and key not in params:
                        return default
                    value = params.get(key)
                    if not isinstance(value, str) or not value:
                        raise ValueError(f"{key} must be a nonempty string")
                    if "\0" in value:
                        raise ValueError(f"{key} contains NUL")
                    value.encode("utf-8", errors="strict")
                    return value
                directory = Path(string("cwd")).resolve(strict=True)
                if not directory.is_dir():
                    raise ValueError("cwd must be an existing directory")
                action = string("action")
                if action not in ("list", "call", "unload"):
                    raise ValueError(f"unknown action: {action}")
                server = string("server", action == "call")
                tool = string("tool", action == "call")
                config_path = string("mcpConfigPath", False, ".mcp.json")
                arguments = params.get("args", {})
                if not isinstance(arguments, dict):
                    raise ValueError("args must be an object")
                result = handle_mcp(action, server, tool, arguments, config_path, str(directory))
                parsed = json.loads(result)
                if isinstance(parsed, dict) and "error" in parsed and "content" not in parsed:
                    return McpFailure("ERROR: " + str(parsed["error"]))
                if action == "call" and isinstance(parsed, dict) and parsed.get("isError") is True:
                    return McpFailure(result)
                return result
            except Exception as error:
                return McpFailure(f"ERROR: {error}")
        if tool_name == "guide":
            return render_guide(cwd)
        # Aggregated tools are handled directly in tools/call; raw-method dispatch
        # falls through to error so the caller knows to use tools/call.
        return UnknownToolFailure(f"ERROR:-32601: unknown method: {tool_name}")
    except Exception as e:
        return f"ERROR: {e}"


MAX_CONCURRENT_REQUESTS = 64   # parity with Java's MAX_HTTP_THREADS
HTTP_READ_TIMEOUT_S = 60          # slowloris guard: a stalled body can't pin a thread forever


class ThreadingHTTPServer(socketserver.ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 128

    # Bounded concurrency: excess connections get an immediate 503 instead of
    # spawning unbounded handler threads (memory-DoS guard).
    _active = 0
    _active_lock = threading.Lock()

    def process_request(self, request, client_address):
        with self._active_lock:
            if self._active >= MAX_CONCURRENT_REQUESTS:
                try:
                    request.sendall(
                        b"HTTP/1.1 503 Service Unavailable\r\n"
                        b"Content-Length: 0\r\nConnection: close\r\n\r\n")
                except Exception:
                    pass
                try:
                    request.close()
                except Exception:
                    pass
                return
            self._active += 1
        try:
            super().process_request(request, client_address)
        except Exception:
            with self._active_lock:
                self._active -= 1
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            with self._active_lock:
                self._active -= 1

    def handle_error(self, request, client_address):
        # Slowloris probes / aborted clients are not server errors: keep the
        # log clean while real failures stay visible.
        exc = sys.exc_info()[1]
        if isinstance(exc, (socket.timeout, ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


class MCPRequestHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def setup(self):
        super().setup()
        # Slowloris guard: never block forever reading a request body.
        try:
            self.connection.settimeout(HTTP_READ_TIMEOUT_S)
        except Exception:
            pass

    def send_json(self, data: dict, status: int = 200):
        if getattr(self, "_mcp_notification", False):
            self.send_response(204)
            self.end_headers()
            return
        body = json_utf8(data)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        # This handler uses HTTP/1.0 and closes after each response. Explicitly
        # advertise that lifecycle so clients do not pool a closing socket.
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        # Browser MCP clients require explicit configured authentication. Anonymous
        # native clients remain supported, but untrusted pages cannot invoke tools.
        if token and urllib.parse.urlparse(getattr(self, "path", "")).path == "/mcp":
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        super().end_headers()

    def do_OPTIONS(self):
        if urllib.parse.urlparse(self.path).path != "/mcp":
            self.send_error(404)
        elif not token:
            self.send_json({"error": "browser MCP access requires --token"}, 403)
        else:
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.send_header("Connection", "close")
            self.end_headers()

    def authenticate(self) -> bool:
        if not token and self.headers.get("Origin") is not None:
            self.send_json({"error": "browser MCP access requires --token"}, 403)
            return False
        if not token:
            authority = self.headers.get("Host", "")
            match = re.fullmatch(r"(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?", authority)
            trusted = False
            if match and (match[2] is None or 1 <= int(match[2]) <= 65535):
                host = match[1].strip("[]").lower()
                trusted = host in ("localhost", bind_addr.lower())
                if not trusted:
                    try:
                        ipaddress.ip_address(host)
                        trusted = True
                    except ValueError:
                        pass
            if not trusted:
                self.send_json({"error": "untrusted Host; configure --token for DNS aliases"}, 403)
                return False
            if self.command == "POST" and self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
                self.send_json({"error": "anonymous MCP requests require application/json"}, 415)
                return False
        if token:
            parsed = urllib.parse.urlparse(self.path)
            query = dict(urllib.parse.parse_qsl(parsed.query))
            req_token = query.get("token")
            # Also accept Authorization: Bearer <token>
            if not req_token:
                auth_hdr = self.headers.get("Authorization", "")
                if auth_hdr.startswith("Bearer "):
                    req_token = auth_hdr[7:].strip()
            if not req_token or not hmac.compare_digest(req_token.encode("utf-8"), token.encode("utf-8")):
                self.send_json({"error": "unauthorized"}, 401)
                return False
        return True

    def do_POST(self):
        self._mcp_notification = False
        try:
            self._handle_post()
        finally:
            self._mcp_notification = False

    def _handle_post(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith("/upload/"):
            self._handle_upload_post(parsed.path[len("/upload/"):])
            return
        if not self.authenticate():
            return
        if parsed.path != "/mcp":
            self.send_json({"error": "not found"}, 404)
            return

        try:
            content_length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            self.send_json({"error": "invalid Content-Length"}, 400)
            return
        if content_length < 0 or content_length > MAX_REQUEST_BYTES:
            self.send_json({"error": "Content-Length too large"}, 413)
            return
        body = self.rfile.read(content_length).decode("utf-8", errors="replace")

        try:
            request = _mcp_parse_json(body)
        except (json.JSONDecodeError, _McpJsonDepthError, _McpJsonNumberError):
            self.send_json({"jsonrpc": "2.0", "id": None,
                            "error": {"code": -32700, "message": "Parse error"}}, 400)
            return

        if not valid_mcp_request(request):
            self.send_json(jsonrpc_error(None, -32600, "Invalid Request"))
            return

        self._mcp_notification = "id" not in request
        req_id, method, params = parse_jsonrpc_request(request)

        # JSON-RPC 2.0: params (when present) must be an object or array. We use object-style; reject arrays/scalars with -32602.
        if params is not None and not isinstance(params, dict):
            self.send_json(jsonrpc_error(req_id, -32602, "Invalid params: expected object"))
            return

        if method == "initialize":
            # MCP handshake: return server info
            self.send_json(jsonrpc_response(req_id, {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "code-mcp", "version": "0.1.0"}
            }))
            return

        if method and method.startswith("notifications/") and "id" not in request:
            # MCP handshake: client notification, no response body needed.
            self.send_response(204)
            self.end_headers()
            return

        if method == "ping":
            self.send_json(jsonrpc_response(req_id, {}))
            return

        if method == "tools/list":
            self.send_json(jsonrpc_response(req_id, {"tools": build_tools_list()}))
            return

        if method == "tools/call":
            if not isinstance(params, dict):
                self.send_json(jsonrpc_error(req_id, -32602, "Invalid params: expected object"))
                return
            tool_name = params.get("name", "")
            if not isinstance(tool_name, str) or not tool_name:
                self.send_json(jsonrpc_error(req_id, -32602, "Invalid params: name must be a nonempty string"))
                return
            tool_params = params.get("arguments", {})
            # Preserve upstream result metadata while spilling oversized content.
            with aggregator_lock:
                is_aggregated = tool_name in aggregator_tools
            if is_aggregated:
                try:
                    raw = call_aggregated_raw(tool_name, tool_params)
                    if isinstance(raw, dict) and isinstance(raw.get("content"), list):
                        raw = {**raw, "content": _spill_content_blocks(raw["content"], tool_name)}
                        self.send_json(jsonrpc_response(req_id, raw))
                    else:
                        text = json.dumps(raw, ensure_ascii=False) if not isinstance(raw, str) else raw
                        self.send_json(jsonrpc_response(req_id, {"content": [{"type": "text", "text": text}]}))
                except Exception as e:
                    self.send_json(jsonrpc_response(req_id, {"isError": True, "content": [{"type": "text", "text": f"ERROR: {e}"}]}))
                return
            result = dispatch_tool(tool_name, tool_params)
            if isinstance(result, UnknownToolFailure):
                self.send_json(jsonrpc_error(req_id, -32601, str(result)))
                return
            text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False)
            # read+no_truncate: caller explicitly asked for full content; don't re-spill.
            skip_spill = tool_name == "read" and isinstance(tool_params, dict) and bool(tool_params.get("no_truncate"))
            final_text = text if skip_spill else maybe_spill_text(text, tool_name)
            self.send_json(jsonrpc_response(req_id, {"content": [{"type": "text", "text": final_text}], **({"isError": True} if isinstance(result, ToolFailure) else {})}))
            return

        # Handle raw methods directly (like Java/TypeScript MCP servers)
        tool_params = params if isinstance(params, dict) else {}
        result = dispatch_tool(method, tool_params)
        # Emit JSON-RPC error for "method not found"-style results.
        if method != "read" and isinstance(result, str) and result.startswith("ERROR:-32601:"):
            msg = result[len("ERROR:-32601:"):].strip()
            self.send_json(jsonrpc_error(req_id, -32601, msg))
            return
        if isinstance(result, ToolFailure):
            self.send_json(jsonrpc_error(req_id, -32000, str(result)))
            return
        self.send_json(jsonrpc_response(req_id, result))

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith("/upload/"):
            self._handle_upload_get(parsed.path[len("/upload/"):])
            return
        if not self.authenticate():
            return
        if parsed.path == "/mcp":
            self.send_json({"status": "ok"})
            return
        self.send_json({"error": "not found"}, 404)

    def _handle_upload_get(self, sid: str):
        # GET serves the HTML uploader page. Auth lives in the signed sid.
        ok, reason = verify_upload_session_id(sid)
        if not ok:
            body = f"Upload session {reason}.".encode("utf-8")
            self.send_response(401)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        body = _UPLOAD_PAGE_HTML.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_upload_body_with_deadline(self):
        state_lock = threading.Lock()
        finished = False
        expired = False

        def expire():
            nonlocal finished, expired
            with state_lock:
                if finished:
                    return
                finished = expired = True
                try:
                    self.connection.shutdown(socket.SHUT_RD)
                except OSError:
                    pass

        timer = threading.Timer(60.0, expire)
        timer.daemon = True
        timer.start()
        try:
            try:
                body = self._read_upload_body()
            except (OSError, ValueError):
                with state_lock:
                    if expired:
                        raise TimeoutError("upload body deadline exceeded") from None
                raise
            with state_lock:
                finished = True
                if expired:
                    raise TimeoutError("upload body deadline exceeded")
            return body
        finally:
            with state_lock:
                finished = True
            timer.cancel()

    def _read_upload_body(self):
        lengths = self.headers.get_all("Content-Length", [])
        encodings = self.headers.get_all("Transfer-Encoding", [])
        if len(lengths) > 1 or len(encodings) > 1 or (lengths and encodings):
            raise ValueError("ambiguous upload framing")
        if encodings and encodings[0].strip().lower() != "chunked":
            raise ValueError("unsupported transfer encoding")
        body = bytearray()

        def read_exact(size):
            remaining = size
            while remaining:
                block = self.rfile.read(min(remaining, 65536))
                if not block:
                    raise ValueError("truncated upload body")
                body.extend(block)
                remaining -= len(block)

        if not encodings:
            value = lengths[0].strip() if lengths else "0"
            if not re.fullmatch(r"[0-9]+", value) or len(value) > 16:
                raise ValueError("invalid Content-Length")
            size = int(value)
            if size > MAX_UPLOAD_BODY_BYTES:
                raise OverflowError("upload body too large")
            read_exact(size)
            return body
        while True:
            line = self.rfile.readline(8193)
            if len(line) > 8192 or not line.endswith(b"\r\n"):
                raise ValueError("invalid chunk header")
            size_text = line[:-2].split(b";", 1)[0]
            if not re.fullmatch(rb"[0-9A-Fa-f]{1,16}", size_text):
                raise ValueError("invalid chunk size")
            size = int(size_text, 16)
            if size > MAX_UPLOAD_BODY_BYTES - len(body):
                raise OverflowError("upload body too large")
            if size == 0:
                trailer_bytes = 0
                while True:
                    trailer = self.rfile.readline(8193)
                    trailer_bytes += len(trailer)
                    if len(trailer) > 8192 or trailer_bytes > 65536 or not trailer.endswith(b"\r\n"):
                        raise ValueError("invalid chunk trailer")
                    if trailer == b"\r\n":
                        return body
                    key, colon, _ = trailer[:-2].partition(b":")
                    if not colon or not re.fullmatch(rb"[!#$%&'*+.^_`|~0-9A-Za-z-]+", key):
                        raise ValueError("invalid chunk trailer")
            read_exact(size)
            if self.rfile.read(2) != b"\r\n":
                raise ValueError("invalid chunk terminator")

    def _handle_upload_post(self, sid: str):
        # Never reuse a connection with unread or rejected upload bytes.
        self.close_connection = True
        ok, reason = verify_upload_session_id(sid)
        if not ok:
            self.send_json({"error": reason}, 401)
            return
        if not _UPLOAD_SLOTS.acquire(blocking=False):
            self.send_json({"error": "too many active uploads"}, 503)
            return
        try:
            try:
                body = self._read_upload_body_with_deadline()
            except TimeoutError as error:
                self.send_json({"error": str(error)}, 408)
                return
            except OverflowError as error:
                self.send_json({"error": str(error)}, 413)
                return
            except ValueError as error:
                self.send_json({"error": str(error)}, 400)
                return
            ctype = self.headers.get("Content-Type", "")
            status, payload = handle_upload_post(ctype, body, sid)
            self.send_json(payload, status)
        finally:
            _UPLOAD_SLOTS.release()


def start_gateway_client(domain: str, device_id: str | None, gw_token: str | None = None) -> None:
    """Connect to gateway and relay requests.

    gw_token is the device credential presented on the /ws upgrade
    (X-Device-Token); the gateway rejects the connection with 401 without it.
    """
    global gateway_device_id, assigned_device_id

    def build_url(d: str, dev_id: str | None) -> str:
        # Determine scheme: wss for production (anything not localhost/127.x), ws for local
        if d.startswith("wss://") or d.startswith("https://"):
            base = d.replace("https://", "wss://")
        elif d.startswith("ws://") or d.startswith("http://"):
            base = d.replace("http://", "ws://")
        else:
            # No scheme specified - use wss for production, ws for localhost/127.x
            is_local = d.startswith("localhost") or d.startswith("127.") or d.startswith("192.168.") or d.startswith("10.") or d.startswith("172.16.")
            base = ("ws://" if is_local else "wss://") + d
        if dev_id:
            # Defensive: --id lands in the request path — never allow CR/LF
            # to inject headers or extra request lines into the handshake.
            safe_dev = dev_id.replace("\r", "").replace("\n", "")
            return base + "/ws/" + safe_dev
        return base + "/ws"

    def send_ws_frame(sock, data: bytes):
        frame = bytearray()
        frame.append(0x81)
        length = len(data)
        if length < 126:
            frame.append(0x80 | length)
        elif length < 65536:
            frame.append(0x80 | 126)
            frame.extend(struct.pack(">H", length))
        else:
            frame.append(0x80 | 127)
            frame.extend(struct.pack(">Q", length))
        mask = secrets.token_bytes(4)
        frame.extend(mask)
        frame.extend(_apply_mask(data, mask))
        sock.sendall(bytes(frame))

    def recv_ws_frame(sock, prefetched: bytearray) -> bytes | None:
        """Return next non-control text/binary message payload. Handles fragmentation,
        ping/pong (auto-reply), and close. Returns None on close or error."""
        def _recv_exact(sock, size: int) -> bytes | None:
            available = min(size, len(prefetched))
            data = bytes(prefetched[:available])
            del prefetched[:available]
            while len(data) < size:
                try:
                    chunk = sock.recv(size - len(data))
                    if not chunk:
                        return None
                    data += chunk
                except ssl.SSLError as e:
                    if e.errno == ssl.SSL_ERROR_WANT_READ:
                        continue
                    raise
            return data

        buffer = bytearray()
        try:
            while True:
                first = _recv_exact(sock, 1)
                if not first:
                    return None
                b0 = first[0]
                fin = (b0 & 0x80) != 0
                opcode = b0 & 0x0F
                second = _recv_exact(sock, 1)
                if not second:
                    return None
                b1 = second[0]
                masked = (b1 & 0x80) != 0
                length = b1 & 0x7F
                if length == 126:
                    ext = _recv_exact(sock, 2)
                    if not ext:
                        return None
                    length = struct.unpack(">H", ext)[0]
                elif length == 127:
                    ext = _recv_exact(sock, 8)
                    if not ext:
                        return None
                    length = struct.unpack(">Q", ext)[0]
                if length > MAX_WS_FRAME_BYTES:
                    print(f"[gateway] frame too large: {length}", file=sys.stderr)
                    return None
                mask_key = b""
                if masked:
                    mask_key = _recv_exact(sock, 4) or b""
                payload = b""
                if length > 0:
                    payload = _recv_exact(sock, length) or b""
                    if masked and mask_key:
                        payload = _apply_mask(payload, mask_key)
                # Control frames (0x8 close, 0x9 ping, 0xA pong) — never fragmented.
                if opcode == 0x8:
                    # Close: best-effort echo and bail.
                    try:
                        send_ws_frame_with_opcode(sock, 0x8, payload[:125])
                    except Exception:
                        pass
                    return None
                if opcode == 0x9:
                    try:
                        send_ws_frame_with_opcode(sock, 0xA, payload)
                    except Exception:
                        pass
                    continue
                if opcode == 0xA:
                    continue
                if opcode in (0x1, 0x2, 0x0):
                    buffer.extend(payload)
                    # Enforce the cap across FRAGMENTS too (a single frame is
                    # already capped; endless continuations must not grow the
                    # message buffer without bound -> OOM guard).
                    if len(buffer) > MAX_WS_FRAME_BYTES:
                        print(f"[gateway] message exceeds {MAX_WS_FRAME_BYTES} bytes", file=sys.stderr)
                        return None
                    if fin:
                        return bytes(buffer)
                    continue
                # Unknown opcode — drop connection.
                print(f"[gateway] unknown opcode: {opcode}", file=sys.stderr)
                return None
        except ssl.SSLError as e:
            print(f"[gateway] SSL error: {e}", file=sys.stderr)
            return None
        except Exception as e:
            print(f"[gateway] recv error: {e}", file=sys.stderr)
            return None

    def send_ws_frame_with_opcode(sock, opcode: int, data: bytes):
        frame = bytearray()
        frame.append(0x80 | (opcode & 0x0F))
        length = len(data)
        if length < 126:
            frame.append(0x80 | length)
        elif length < 65536:
            frame.append(0x80 | 126)
            frame.extend(struct.pack(">H", length))
        else:
            frame.append(0x80 | 127)
            frame.extend(struct.pack(">Q", length))
        mask = secrets.token_bytes(4)
        frame.extend(mask)
        frame.extend(_apply_mask(data, mask))
        # Control frames share the response/keepalive lock: sendall may issue
        # multiple writes, and another frame must never split their payload.
        with send_lock:
            sock.sendall(bytes(frame))

    def handle_request(req: dict) -> dict | None:
        result = dispatch_request(req)
        return None if valid_mcp_request(req) and "id" not in req else result

    def dispatch_request(req: dict) -> dict:
        """Handle incoming request from gateway, dispatch like local /mcp."""
        if not valid_mcp_request(req):
            return jsonrpc_error(None, -32600, "Invalid Request")
        req_id, method, params = parse_jsonrpc_request(req)
        if params is not None and not isinstance(params, dict):
            return jsonrpc_error(req_id, -32602, "Invalid params: expected object")

        if method == "initialize":
            return jsonrpc_response(req_id, {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "code-mcp", "version": "0.1.0"},
            })
        if method and method.startswith("notifications/") and "id" not in req:
            # Notification: no response body. The relay sends response:null so
            # the gateway answers 204 No Content (strict clients reject error
            # bodies for notifications).
            return None
        if method == "ping":
            return jsonrpc_response(req_id, {})
        if method == "tools/list":
            return jsonrpc_response(req_id, {"tools": build_tools_list()})

        is_tools_call = method == "tools/call"
        if is_tools_call:
            if not isinstance(params, dict):
                return jsonrpc_error(req_id, -32602, "Invalid params: expected object")
            tool_name = params.get("name", "")
            if not isinstance(tool_name, str) or not tool_name:
                return jsonrpc_error(req_id, -32602, "Invalid params: name must be a nonempty string")
            tool_params = params.get("arguments", {})
        else:
            tool_name = method
            tool_params = params if isinstance(params, dict) else {}

        if is_tools_call:
            # Aggregated tools use the same content spill path as HTTP /mcp.
            with aggregator_lock:
                is_aggregated = tool_name in aggregator_tools
            if is_aggregated:
                try:
                    raw = call_aggregated_raw(tool_name, tool_params)
                    if isinstance(raw, dict) and isinstance(raw.get("content"), list):
                        return jsonrpc_response(req_id, {**raw, "content": _spill_content_blocks(raw["content"], tool_name)})
                    text = json.dumps(raw, ensure_ascii=False) if not isinstance(raw, str) else raw
                    return jsonrpc_response(req_id, {"content": [{"type": "text", "text": text}]})
                except Exception as e:
                    return jsonrpc_response(req_id, {"isError": True, "content": [{"type": "text", "text": f"ERROR: {e}"}]})

        result = dispatch_tool(tool_name, tool_params)
        if is_tools_call and isinstance(result, UnknownToolFailure):
            return jsonrpc_error(req_id, -32601, str(result))
        if is_tools_call:
            text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False)
            skip_spill = tool_name == "read" and isinstance(tool_params, dict) and bool(tool_params.get("no_truncate"))
            final_text = text if skip_spill else maybe_spill_text(text, tool_name)
            result = {"content": [{"type": "text", "text": final_text}], **({"isError": True} if isinstance(result, ToolFailure) else {})}
            return jsonrpc_response(req_id, result)
        # Raw methods: emit a proper JSON-RPC error for "method not found".
        if method != "read" and isinstance(result, str) and result.startswith("ERROR:-32601:"):
            return jsonrpc_error(req_id, -32601, result[len("ERROR:-32601:"):].strip())
        if isinstance(result, ToolFailure):
            return jsonrpc_error(req_id, -32000, str(result))
        return jsonrpc_response(req_id, result)

    def _apply_mask(data: bytes, mask: bytes) -> bytes:
        """XOR a WS payload with its 4-byte mask via big-int math (~10-50x faster
        than the naive per-byte loop; matters for near-64MB frames)."""
        if not data:
            return data
        n = len(data)
        # Repeat the 4-byte mask as a BYTE SEQUENCE (mask * repeats), then XOR
        # the big-int views: all C-speed, no Python per-byte loop.
        stream = (mask * ((n + 3) // 4))[:n]
        return (int.from_bytes(data, "big") ^ int.from_bytes(stream, "big")).to_bytes(n, "big")

    WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
    # Singleton pool reused across reconnects so a churning gateway can't leak
    # 8-worker pools per attempt.
    global _gateway_dispatch_pool
    if _gateway_dispatch_pool is None:
        _gateway_dispatch_pool = concurrent.futures.ThreadPoolExecutor(
            max_workers=24, thread_name_prefix="gw-dispatch")
    dispatch_pool = _gateway_dispatch_pool
    send_lock = threading.Lock()

    def safe_send(sock, payload: bytes):
        with send_lock:
            send_ws_frame(sock, payload)

    while True:
        stop_keepalive: Optional[threading.Event] = None
        try:
            url = build_url(domain, device_id)
            print(f"[gateway] connecting to {url}", file=sys.stderr)

            uri = urllib.parse.urlparse(url)
            host = (uri.hostname or domain).replace("\r", "").replace("\n", "")
            gateway_port = uri.port or (443 if uri.scheme == "wss" else 80)

            use_ssl = url.startswith("wss://") or url.startswith("https://")
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            if use_ssl:
                context = ssl.create_default_context()
                ssock = context.wrap_socket(sock, server_hostname=host)
                ssock.connect((host, gateway_port))
            else:
                ssock = sock
                ssock.connect((host, gateway_port))
            ssock.settimeout(60)

            ws_key = base64.b64encode(secrets.token_bytes(16)).decode()
            # Host header uses the gateway host:port (not local port).
            host_header = host if gateway_port in (80, 443) else f"{host}:{gateway_port}"
            # Device credential for the gateway: sent as X-Device-Token so the
            # registry-backed /ws auth accepts the upgrade. Without it the
            # hardened gateway answers 401 (legacy gateways ignore the header).
            # Defensive: never let a token inject headers into the handshake.
            safe_tok = (gw_token or "").replace("\r", "").replace("\n", "")
            token_header = f"X-Device-Token: {safe_tok}\r\n" if safe_tok else ""
            request = (
                f"GET {uri.path} HTTP/1.1\r\n"
                f"Host: {host_header}\r\n"
                f"Upgrade: websocket\r\n"
                f"Connection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {ws_key}\r\n"
                f"Sec-WebSocket-Version: 13\r\n"
                f"User-Agent: code-mcp/0.1.0\r\n"
                f"Accept: */*\r\n"
                f"{token_header}"
                f"\r\n"
            )
            ssock.sendall(request.encode())

            resp = b""
            while b"\r\n\r\n" not in resp:
                chunk = ssock.recv(4096)
                if not chunk:
                    break
                resp += chunk
                if len(resp) > MAX_GATEWAY_HEADER_BYTES:
                    raise ValueError(f"gateway handshake response too large: {len(resp)} bytes")

            header_end = resp.find(b"\r\n\r\n")
            if header_end == -1:
                raise ValueError("gateway closed before sending headers")
            headers_text = resp[:header_end].decode("iso-8859-1", errors="replace")
            status_line = headers_text.split("\r\n", 1)[0]
            if " 101 " not in (" " + status_line + " "):
                hint = ""
                if "401" in status_line:
                    hint = (" - device auth failed: pass --token (or --gateway-token) "
                            "matching the token registered for --id in the gateway")
                print(f"[gateway] WebSocket upgrade failed: {status_line}{hint}", file=sys.stderr)
                ssock.close()
                time.sleep(3)
                continue
            # Verify Sec-WebSocket-Accept = base64(SHA1(key + magic))
            expected = base64.b64encode(hashlib.sha1((ws_key + WS_MAGIC).encode()).digest()).decode()
            accept_hdr = None
            for line in headers_text.split("\r\n")[1:]:
                if ":" in line:
                    k, _, v = line.partition(":")
                    if k.strip().lower() == "sec-websocket-accept":
                        accept_hdr = v.strip()
                        break
            if not accept_hdr or not hmac.compare_digest(accept_hdr, expected):
                print("[gateway] Sec-WebSocket-Accept mismatch — aborting", file=sys.stderr)
                ssock.close()
                time.sleep(3)
                continue

            # TCP can deliver WebSocket bytes with the HTTP upgrade response.
            # Preserve complete frames and partial prefixes for the frame reader.
            prefetched = bytearray(resp[header_end + 4:])
            ssock.settimeout(60)

            if not device_id:
                device_id = str(uuid.uuid4())
            register = json.dumps({"type": "register", "deviceId": device_id}, ensure_ascii=False)
            safe_send(ssock, register.encode("utf-8"))
            print(f"[gateway] registered as {device_id}", file=sys.stderr)

            # Proactive app-layer keepalive: sends {"type":"keepalive"} every 25s.
            # Why app-layer not WS ping: HTTP/2 tunnels (cloudflared) can swallow
            # control ping/pong frames. Data frames always reach origin.
            # If send fails -> TCP is broken -> close socket -> recv loop breaks ->
            # outer loop reconnects.
            stop_keepalive = threading.Event()
            def keepalive_loop(sock_ref):
                payload = b'{"type":"keepalive"}'
                while not stop_keepalive.wait(25):
                    try:
                        safe_send(sock_ref, payload)
                    except Exception as e:
                        print(f"[gateway] keepalive send failed: {e}", file=sys.stderr)
                        try: sock_ref.close()
                        except Exception: pass
                        return
            ka_thread = threading.Thread(target=keepalive_loop, args=(ssock,),
                                         name="gw-keepalive", daemon=True)
            ka_thread.start()

            MAX_GATEWAY_RESP_BYTES = 64 * 1024 * 1024  # cap tool responses relayed through the tunnel

            def dispatch_async(msg, sock_ref):
                try:
                    tunnel_req = msg["request"]
                    tunnel_id = msg["id"]
                    # In-process dispatch: handle_request mirrors the local /mcp
                    # handler (initialize, ping, tools/list, tools/call, raw
                    # methods, aggregated tools, spill). Bypassing the local HTTP
                    # round trip removes ~20ms latency per call plus the
                    # per-request TCP connection, and keeps the gateway relay
                    # responsive under heavy concurrent load.
                    if isinstance(tunnel_req, dict):
                        resp_obj = handle_request(tunnel_req)
                    else:
                        resp_obj = {"jsonrpc": "2.0", "id": None,
                                    "error": {"code": -32600, "message": "invalid request"}}
                    tunnel_resp = {"id": tunnel_id, "response": resp_obj}
                    safe_send(sock_ref, json_utf8(tunnel_resp))
                except Exception as e:
                    print(f"[gateway] dispatch error: {e}", file=sys.stderr)

            try:
                while True:
                    try:
                        payload = recv_ws_frame(ssock, prefetched)
                        if not payload:
                            break
                        try:
                            # One container is the gateway envelope; depth errors close
                            # this connection via the outer read-loop failure path.
                            msg = _mcp_parse_json(payload.decode("utf-8", errors="replace"), 257)
                        except json.JSONDecodeError:
                            continue
                        if isinstance(msg, dict) and msg.get("type") == "keepalive-ack":
                            continue
                        if "request" in msg:
                            if not _gateway_dispatch_slots.acquire(blocking=False):
                                # Backpressure: a gateway flooding faster than we can
                                # drain must not grow an unbounded queue (OOM guard).
                                try:
                                    _req = msg.get("request") or {}
                                    safe_send(ssock, json_utf8({
                                        "id": msg.get("id"),
                                        "response": {"jsonrpc": "2.0", "id": _req.get("id"),
                                                     "error": {"code": -32000, "message": "gateway relay overloaded"}},
                                    }))
                                except Exception:
                                    pass
                                continue
                            def _dispatch_guarded(m, sock):
                                try:
                                    dispatch_async(m, sock)
                                finally:
                                    _gateway_dispatch_slots.release()
                            dispatch_pool.submit(_dispatch_guarded, msg, ssock)
                    except socket.timeout:
                        continue
                    except Exception as e:
                        print(f"[gateway] read loop error: {e}", file=sys.stderr)
                        break
            finally:
                stop_keepalive.set()
            try:
                ssock.close()
            except Exception:
                pass

        except Exception as e:
            print(f"[gateway] error: {e}", file=sys.stderr)
            if stop_keepalive is not None:
                stop_keepalive.set()
            time.sleep(3)


# ---------- memos ----------
MEMO_FILE = ".memo.jsonl"
MEMO_LOCK_FILE = ".memo.lock"
MEMO_TAIL_BYTES = 8192
MEMO_LOCK_TIMEOUT_MS = 30_000
STALE_MEMO_LOCK_MS = 60_000
MEMO_LOCK_RETRY_S = 0.04


def _sanitize_tags(tags) -> list[str] | None:
    """Filter to clean string[] or None. Drops null/numbers/empty strings."""
    if not isinstance(tags, list):
        return None
    out = [t for t in tags if isinstance(t, str) and t]
    return out if out else None


def _memo_lock_owner_definitely_dead(path: Path) -> bool:
    with open(path, "rb") as stream:
        owner = stream.read(128)
    match = re.match(rb"([1-9][0-9]{0,9})\r?\n", owner)
    if match is None:
        return False
    return _memo_process_definitely_dead(int(match.group(1)))


def _memo_process_definitely_dead(pid: int) -> bool:
    if pid < 1 or pid > 2147483647:
        return False
    if os.name == "nt":
        # Never use os.kill(pid, 0) on Windows: Python's implementation can
        # terminate the target. A synchronization-only handle cannot do so.
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.WaitForSingleObject.restype = wintypes.DWORD
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        handle = kernel.OpenProcess(0x00100000, False, pid)
        if not handle:
            return ctypes.get_last_error() == 87  # ERROR_INVALID_PARAMETER: no such PID
        try:
            return kernel.WaitForSingleObject(handle, 0) == 0  # signaled process exited
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return False
    except ProcessLookupError:
        return True
    except OSError:
        return False


def _memo_recovery_entries(root: Path, deadline: float):
    entries = []
    with os.scandir(root) as directory:
        for count, item in enumerate(directory, 1):
            if time.monotonic() >= deadline:
                raise IOError("timeout waiting for memo lock recovery")
            if count > 4096:
                raise IOError("too many memo recovery participants")
            match = re.fullmatch(r"p([1-9][0-9]{0,9})-([0-9a-f]{32})", item.name)
            if match is None:
                continue
            participant = root / item.name
            try:
                info = participant.lstat()
                if not stat.S_ISDIR(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                    raise IOError("invalid memo recovery participant")
                if _memo_process_definitely_dead(int(match.group(1))):
                    # Never recursively remove unexpected files or directories.
                    try:
                        if stat.S_ISREG((participant / "ticket").lstat().st_mode):
                            (participant / "ticket").unlink()
                    except OSError:
                        pass
                    try:
                        participant.rmdir()
                    except OSError:
                        pass
                    continue
                ticket = 0
                try:
                    path = participant / "ticket"
                    info = path.lstat()
                    if not stat.S_ISREG(info.st_mode) or info.st_size > 64:
                        raise IOError("invalid memo recovery ticket")
                    with open(path, "rb") as stream:
                        data = stream.read(65)
                    if data.endswith(b"\n"):
                        if not re.fullmatch(rb"[1-9][0-9]{0,15}\n", data) or int(data) > 9007199254740991:
                            raise IOError("invalid memo recovery ticket")
                        ticket = int(data)
                    elif len(data) > 16 or not re.fullmatch(rb"[0-9]*", data):
                        raise IOError("invalid memo recovery ticket")
                except FileNotFoundError:
                    pass
                entries.append((item.name, ticket))
            except FileNotFoundError:
                pass
    return entries


class _MemoRecovery:
    def __init__(self, cwd: str, deadline: float):
        self.root = Path(cwd) / ".memo.recovery"
        self.name = f"p{os.getpid()}-{uuid.uuid4().hex}"
        self.path = self.root / self.name
        self.deadline = deadline

    def __enter__(self):
        try:
            self.root.mkdir(mode=0o700)
        except FileExistsError:
            pass
        info = self.root.lstat()
        if not stat.S_ISDIR(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise IOError("memo recovery must be a real directory")
        self.path.mkdir(mode=0o700)
        try:
            ticket = max((number for name, number in _memo_recovery_entries(self.root, self.deadline)), default=0) + 1
            if ticket > 9007199254740991:
                raise IOError("memo recovery ticket space exhausted")
            with open(self.path / "ticket", "xb") as stream:
                data = f"{ticket}\n".encode("ascii")
                if stream.write(data) != len(data):
                    raise IOError("incomplete memo recovery ticket")
            while time.monotonic() < self.deadline:
                waiting = any(name != self.name and (number == 0 or (number, name) < (ticket, self.name))
                              for name, number in _memo_recovery_entries(self.root, self.deadline))
                if not waiting:
                    return self
                time.sleep(MEMO_LOCK_RETRY_S)
            raise IOError("timeout waiting for memo lock recovery")
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, exc_type, exc, tb):
        for attempt in range(6):
            try:
                (self.path / "ticket").unlink(missing_ok=True)
                self.path.rmdir()
                return False
            except FileNotFoundError:
                return False
            except PermissionError:
                if os.name != "nt" or attempt == 5:
                    raise
                time.sleep(MEMO_LOCK_RETRY_S)
        return False


class _MemoLock:
    """Cross-process lock via O_CREAT|O_EXCL on {cwd}/.memo.lock.
    Multiple Claude agents on the same device may share a cwd; this serializes
    remember/forget across processes. Only aged locks with proven dead owners
    are reaped; age alone never evicts a live or unknown owner.
    """
    def __init__(self, cwd: str):
        self.path = Path(cwd) / MEMO_LOCK_FILE
        self.identity = None
        self.token = None
        self.released = False

    def __enter__(self):
        self.released = False
        self.identity = None
        self.token = None
        start = time.monotonic()
        permission_retries = 0
        while (time.monotonic() - start) * 1000 < MEMO_LOCK_TIMEOUT_MS:
            opened = False
            try:
                fd = os.open(str(self.path), os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_BINARY", 0), 0o600)
                opened = True
                try:
                    try:
                        self.identity = os.fstat(fd)
                        self.token = f"{os.getpid()}\n{uuid.uuid4()}\n".encode("ascii")
                        if os.write(fd, self.token) != len(self.token):
                            raise IOError("incomplete memo lock write")
                    finally:
                        os.close(fd)
                except BaseException as failure:
                    if self.identity is None:
                        if not isinstance(failure, Exception):
                            raise
                        raise RuntimeError(f"memo lock ownership could not be verified; .memo.lock may remain. No memory was written by this request. Inspect .memo.lock before retrying: {failure}") from failure
                    self._remove_owned_lock(allow_partial=True)
                    raise
                return self
            except FileExistsError:
                if opened:
                    raise
                permission_retries = 0
                try:
                    age_ms = (time.time() - self.path.stat().st_mtime) * 1000
                    if age_ms > STALE_MEMO_LOCK_MS:
                        with _MemoRecovery(str(self.path.parent), start + MEMO_LOCK_TIMEOUT_MS / 1000):
                            try:
                                latest = self.path.lstat()
                                if not stat.S_ISREG(latest.st_mode):
                                    raise IOError("memo lock must be a regular file")
                                if ((time.time() - latest.st_mtime) * 1000 > STALE_MEMO_LOCK_MS
                                        and _memo_lock_owner_definitely_dead(self.path)):
                                    self.path.unlink()
                            except FileNotFoundError:
                                pass
                except FileNotFoundError:
                    continue
                time.sleep(MEMO_LOCK_RETRY_S + random.random() * 0.03)
            except PermissionError:
                if opened or os.name != "nt" or permission_retries >= 5:
                    raise
                permission_retries += 1
                time.sleep(MEMO_LOCK_RETRY_S)
        raise RuntimeError(
            f"could not acquire memo lock at {self.path} within {MEMO_LOCK_TIMEOUT_MS}ms"
        )

    def __exit__(self, exc_type, exc, tb):
        if self.released:
            return False
        self.released = True
        try:
            return self._remove_owned_lock()
        except Exception as cleanup:
            if exc is not None:
                raise RuntimeError(f"memory operation failed: {exc}; lock cleanup failed: {cleanup}") from cleanup
            raise

    def _remove_owned_lock(self, allow_partial=False):
        def matches(info):
            return (self.identity is not None and stat.S_ISREG(info.st_mode)
                    and info.st_dev == self.identity.st_dev and info.st_ino == self.identity.st_ino)
        for attempt in range(6):
            try:
                if not matches(self.path.lstat()):
                    return False
                with open(self.path, "rb") as current:
                    if not matches(os.fstat(current.fileno())):
                        return False
                    actual = current.read(128)
                    if self.token is None or (not self.token.startswith(actual) if allow_partial else actual != self.token):
                        return False
                if matches(self.path.lstat()):
                    self.path.unlink()
                return False
            except FileNotFoundError:
                return False
            except PermissionError:
                if os.name != "nt" or attempt == 5:
                    raise
                time.sleep(MEMO_LOCK_RETRY_S)
        return False


def read_memos(cwd: str) -> list[dict]:
    memos = []
    def accept(m):
        m["id"], m["ts"] = int(m["id"]), int(m["ts"])
        clean = _sanitize_tags(m.get("tags"))
        if clean:
            m["tags"] = clean
        else:
            m.pop("tags", None)
        memos.append(m)
    _memo_append_state(cwd, accept)
    return memos


def _memo_storage_info(info):
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("memo storage must be a regular file")
    if info.st_nlink != 1:
        raise ValueError("memo storage must not have hardlink aliases")
    # Windows path stat and fstat can give ctime different meanings.
    # birthtime is the stable creation timestamp on Python 3.12+; older
    # Windows Python versions expose creation time through ctime.
    stable_time = getattr(info, "st_birthtime_ns", info.st_ctime_ns) if os.name == "nt" else info.st_ctime_ns
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, stable_time)


def _memo_storage_snapshot(path):
    try:
        return _memo_storage_info(path.lstat())
    except FileNotFoundError:
        return None


def _require_memo_snapshot(path, expected):
    if _memo_storage_snapshot(path) != expected:
        raise IOError("memo storage changed during append preparation")


def _memo_append_state(cwd: str, visit=None):
    path = Path(cwd) / MEMO_FILE
    snapshot = _memo_storage_snapshot(path)
    if snapshot is None:
        return 0, b"", 0, None
    if snapshot[2] > MAX_READ_BYTES:
        raise ValueError("memo storage exceeds 100 MiB limit")
    highest, consumed, last_byte = 0, 0, None
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    with open(path, "rb", opener=lambda name, mode: os.open(name, flags)) as source:
        if _memo_storage_info(os.fstat(source.fileno())) != snapshot:
            raise IOError("memo storage changed during read")
        while True:
            raw = source.readline(snapshot[2] - consumed + 1)
            if not raw:
                break
            consumed += len(raw)
            if consumed > snapshot[2]:
                raise IOError("memo storage changed during read")
            last_byte = raw[-1]
            # Decode outside the JSON catch: invalid UTF-8 must always reject.
            line = raw.decode("utf-8", errors="strict")
            # Only objects can allocate IDs; still validate every byte as UTF-8.
            if not line.lstrip(" \t\r\n").startswith("{"):
                continue
            try:
                m = _mcp_parse_json(line)
                if (isinstance(m, dict) and type(m.get("id")) in (int, float)
                        and math.isfinite(m["id"]) and 1 <= m["id"] <= 9007199254740991
                        and int(m["id"]) == m["id"] and type(m.get("ts")) in (int, float)
                        and math.isfinite(m["ts"]) and 0 <= m["ts"] <= 9007199254740991
                        and int(m["ts"]) == m["ts"] and isinstance(m.get("memo"), str)):
                    highest = max(highest, int(m["id"]))
                    if visit is not None:
                        visit(m)
            except (ValueError, TypeError, OverflowError):
                pass  # Preserve malformed records; they do not allocate an ID.
        if consumed != snapshot[2] or _memo_storage_info(os.fstat(source.fileno())) != snapshot:
            raise IOError("memo storage changed during read")
    _require_memo_snapshot(path, snapshot)
    return highest, (b"\n" if consumed and last_byte != 10 else b""), snapshot[2], snapshot


def _rollback_memo_append(source, path, opened, size, data):
    current = _memo_storage_info(os.fstat(source.fileno()))
    extra = current[2] - size
    if current[:2] != opened[:2] or extra < 0 or extra > len(data):
        raise IOError("memo append recovery refused: file identity or size changed")
    _require_memo_snapshot(path, current)
    source.seek(size)
    offset = 0
    while offset < extra:
        chunk = source.read(min(64 * 1024, extra - offset))
        if not chunk or chunk != data[offset:offset + len(chunk)]:
            raise IOError("memo append recovery refused: appended bytes changed")
        offset += len(chunk)
    if _memo_storage_info(os.fstat(source.fileno())) != current:
        raise IOError("memo append recovery refused: file changed while checking")
    _require_memo_snapshot(path, current)
    if extra:
        source.truncate(size)
    os.fsync(source.fileno())


# ---------- guide ----------

def _xml_attr(s: str) -> str:
    return (s.replace("&", "&amp;").replace("<", "&lt;")
              .replace(">", "&gt;").replace('"', "&quot;"))


def _collect_memo_state(cwd: str) -> dict:
    count, memos = _select_recall_page(cwd, None, None, 1, 0)
    latest = None
    if memos:
        newest = max(memos, key=lambda m: m.get("id", 0))
        ts = _format_memo_timestamp(newest["ts"])
        tag_str = ""
        if isinstance(newest.get("tags"), list) and newest["tags"]:
            tag_str = f", tags=[{','.join(newest['tags'])}]"
        latest = f"{ts}{tag_str}"
    lock_held = False
    lock_path = Path(cwd) / MEMO_LOCK_FILE
    try:
        info = lock_path.lstat()
        # Age cannot prove that a writer exited; unknown ownership stays conservative.
        lock_held = not stat.S_ISREG(info.st_mode) or not _memo_lock_owner_definitely_dead(lock_path)
    except FileNotFoundError:
        pass
    except Exception:
        lock_held = True
    return {"count": count, "latest": latest, "lock_held": lock_held}


def _collect_project_docs(cwd: str) -> list[str]:
    docs = []
    for name in ("CLAUDE.md", "README.md"):
        p = Path(cwd) / name
        try:
            if p.is_file():
                docs.append(name)
        except Exception:
            pass
    return docs


def _collect_loadable_servers(cwd: str) -> list[dict]:
    """Lightweight scan of <cwd>/.mcp.json: ns + transport only. Lenient on
    URL scheme since the guide is informational; mcp tool does strict validation
    at load time."""
    try:
        parsed = _mcp_read_config(Path(cwd) / ".mcp.json")
    except Exception:
        return []
    servers = parsed.get("mcpServers") if isinstance(parsed, dict) else None
    if not isinstance(servers, dict):
        return []
    out = []
    for ns, cfg in servers.items():
        if not isinstance(ns, str) or not NAMESPACE_RE.fullmatch(ns):
            continue
        if not isinstance(cfg, dict):
            continue
        transport = "http" if cfg.get("type") == "http" else "stdio"
        if transport == "http" and not isinstance(cfg.get("url"), str):
            continue
        if transport == "stdio" and not isinstance(cfg.get("command"), str):
            continue
        out.append({"ns": ns, "transport": transport})
    out.sort(key=lambda x: x["ns"])
    return out


def _list_external_servers(cwd: str) -> list[dict]:
    """Enumerate external MCP servers from aggregator state (server-wide, --mcp flag).
    Tool names included for probed servers."""
    out = []
    with aggregator_lock:
        known = sorted(aggregator_known)
        aggr_by_ns: dict[str, list[str]] = {}
        for info in aggregator_tools.values():
            aggr_by_ns.setdefault(info["ns"], []).append(info["tool"])
    for name in known:
        tools = sorted(aggr_by_ns.get(name, []))
        out.append({"ns": name, "tools": tools})
    return out


def render_guide(cwd: str) -> str:
    lines = [f'<guide tool="code-mcp">', ""]

    can_recall = memory_enabled and "recall" not in disallowed_tools
    can_remember = memory_enabled and "remember" not in disallowed_tools
    can_forget = memory_enabled and "forget" not in disallowed_tools
    can_mcp = "mcp" not in disallowed_tools
    memo_state = _collect_memo_state(cwd) if can_recall else None
    docs = _collect_project_docs(cwd) if "read" not in disallowed_tools else []

    lines.append(f'<state cwd="{_xml_attr(cwd)}">')
    if memo_state is not None:
        latest_s = f" (latest {_xml_attr(memo_state['latest'])})" if memo_state['latest'] else ""
        lines.append(f"memos: {memo_state['count']}{latest_s}")
        lines.append(f"concurrent_writer: {'yes' if memo_state['lock_held'] else 'no'}")
    if docs:
        lines.append(f"project_docs: {', '.join(docs)}  (read for project rules)")
    lines.append("</state>")

    if can_recall or docs:
        lines.append("")
        lines.append("<session_start>")
        step = 1
        if can_recall:
            lines.append(f"{step}. call recall(cwd) first to load prior memos"); step += 1
        if docs:
            lines.append(f"{step}. read {' and '.join(docs)} for project rules"); step += 1
        if can_recall:
            lines.append(f'{step}. "(no matches)" from recall = fresh session')
        lines.append("</session_start>")

    if can_remember:
        lines.extend([
            "",
            "<when_to_remember>",
            '- user signals handoff (e.g. "handoff", "wrap up"): tags=["handoff"],',
            "  include file paths, last action, next step",
            '- design or architectural decisions: tags=["decision"]',
            '- non-obvious behaviors, surprising bugs: tags=["gotcha"]',
            '- followups: tags=["todo"]',
            "</when_to_remember>",
            "",
        ])
    if can_recall or can_remember or can_forget:
        lines.extend([
            "<memory_rules>",
            "- memos are private to this cwd; never access the storage file directly,",
            "  use the enabled memory tools listed below",
        ])
        if can_recall:
            lines.append("- tags are case-insensitive; multiple tags = AND filter")
        if can_remember:
            lines.append("- non-string tags are dropped on write")
        lines.append("- multiple agents on the same cwd are serialized automatically")
        if can_recall:
            lines.append("- recall: limit default 20 (max 1000), offset default 0")
            lines.append('- paging past end returns "(no matches at offset=N; total=M)"')
        lines.append("</memory_rules>")

    lines.append("")
    lines.append("<tools>")
    with aggregator_lock:
        aggregated_names = set(aggregator_tools.keys())
    builtin = sorted(t["name"] for t in build_tools_list() if t["name"] not in aggregated_names)
    lines.append("built-in: " + ", ".join(builtin))
    externals = _list_external_servers(cwd) if can_mcp else []
    loadable = _collect_loadable_servers(cwd) if can_mcp else []
    loadable_set = {l["ns"] for l in loadable}
    externals_set = {e["ns"] for e in externals}
    if externals:
        lines.append('external (via mcp tool, prefix "<server>__<tool>"):')
        ns_width = max(len(e["ns"]) for e in externals)
        for e in externals:
            also = "  [also in .mcp.json]" if e["ns"] in loadable_set else ""
            if e["tools"]:
                preview = ", ".join(e["tools"][:6])
                hint = preview + (f", ... ({len(e['tools'])} total)" if len(e["tools"]) > 6 else "")
                lines.append(f"- {e['ns'].ljust(ns_width)}  tools: {_xml_attr(hint)}{also}")
            else:
                lines.append(f"- {e['ns'].ljust(ns_width)}  (tools not yet probed; call mcp(action=\"list\") to discover){also}")
        lines.append('call mcp(action="list") for full schemas of external tools.')
    loadable_only = [l for l in loadable if l["ns"] not in externals_set]
    if loadable_only:
        if externals:
            lines.append("")
        lines.append("loadable (via mcp tool from .mcp.json in cwd):")
        l_width = max(len(l["ns"]) for l in loadable_only)
        for l in loadable_only:
            lines.append(f"- {l['ns'].ljust(l_width)}  {l['transport']}")
        lines.append('call mcp(action="list", server="<name>") to load tools on demand.')
    lines.append("</tools>")

    lines.append("")
    lines.append("<cheat_sheet>")
    if can_recall:
        lines.extend([
            "recall(cwd)",
            'recall(cwd, query="webhook")',
            'recall(cwd, tags=["decision"], limit=5)',
        ])
    if can_remember:
        lines.append('remember(cwd, "fixed bug at file.py:42", tags=["bug","fix"])')
    if can_forget:
        lines.append("forget(cwd, 7)")
    lines.append("guide(cwd)")
    if externals:
        lines.append('mcp(action="list")')
    if loadable_only:
        lines.append(f'mcp(action="list", server="{loadable_only[0]["ns"]}")')
    lines.append("</cheat_sheet>")
    lines.append("")
    lines.append("</guide>")
    return "\n".join(lines)


def handle_remember(cwd: str, memo: str, tags: list | None = None) -> str:
    clean_tags = _sanitize_tags(tags)
    saved_id = None
    attempted_id = None
    try:
        with _MemoLock(cwd):
            previous, separator, original_size, snapshot = _memo_append_state(cwd)
            if previous >= 9007199254740991:
                raise ValueError("memo ID space exhausted")
            memo_id = previous + 1
            entry = {"id": memo_id, "ts": int(time.time() * 1000), "memo": memo}
            if clean_tags:
                entry["tags"] = clean_tags
            path = Path(cwd) / MEMO_FILE
            data = separator + json_utf8(entry) + b"\n"
            if original_size + len(data) > MAX_READ_BYTES:
                raise ValueError("memo storage exceeds 100 MiB limit")
            _require_memo_snapshot(path, snapshot)
            flags = os.O_RDWR | os.O_APPEND | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
            if snapshot is None:
                flags |= os.O_CREAT | os.O_EXCL
            f = open(path, "a+b", buffering=0, opener=lambda name, mode: os.open(name, flags))
            append_failure = None
            try:
                opened = _memo_storage_info(os.fstat(f.fileno()))
                if (snapshot is not None and opened != snapshot) or (snapshot is None and opened[2] != 0):
                    raise IOError("memo storage changed during append preparation")
                _require_memo_snapshot(path, opened)
                attempted_id = memo_id
                try:
                    if f.write(data) != len(data):
                        raise IOError("incomplete memo write")
                    f.flush()
                    os.fsync(f.fileno())
                except Exception as failure:
                    try:
                        _rollback_memo_append(f, path, opened, original_size, data)
                    except Exception as recovery:
                        raise RuntimeError(f"append failed: {failure}; recovery failed: {recovery}") from recovery
                    attempted_id = None
                    raise RuntimeError(f"memory append failed; appended bytes removed: {failure}") from failure
            except Exception as failure:
                append_failure = failure
                raise
            finally:
                try:
                    f.close()
                except Exception as closing:
                    if append_failure is not None:
                        raise RuntimeError(f"{append_failure}; close failed: {closing}") from closing
                    raise
            saved_id = memo_id
    except Exception as failure:
        if saved_id is not None:
            raise RuntimeError(f"remembered #{saved_id}; lock cleanup failed: {failure}. Do not resend this memory.") from failure
        if attempted_id is not None:
            raise RuntimeError(f"memory #{attempted_id} may be partially or fully stored. Inspect .memo.jsonl before retrying: {failure}") from failure
        raise
    return f"remembered #{memo_id}"


def handle_forget(cwd: str, memo_id: int) -> str:
    attempted = saved = False
    try:
        with _MemoLock(cwd):
            path = Path(cwd) / MEMO_FILE
            snapshot = _memo_storage_snapshot(path)
            if snapshot is None:
                raise ValueError(f"no memo with id {memo_id}")
            expected = (path, _write_identity(path.lstat()))
            _require_memo_snapshot(path, snapshot)
            text = read_file(str(path), cwd, no_truncate=True)
            if isinstance(text, ToolFailure):
                raise IOError(str(text))
            _require_memo_snapshot(path, snapshot)
            _write_check_expected(path, path.lstat(), expected)
            kept, removed, start = [], False, 0
            while start < len(text):
                newline = text.find("\n", start)
                end = len(text) if newline < 0 else newline + 1
                raw = text[start:end]
                matches = False
                try:
                    m = _mcp_parse_json(raw)
                    matches = (isinstance(m, dict) and type(m.get("id")) in (int, float)
                               and m["id"] == memo_id and type(m.get("ts")) in (int, float)
                               and math.isfinite(m["ts"]) and 0 <= m["ts"] <= 9007199254740991
                               and int(m["ts"]) == m["ts"] and isinstance(m.get("memo"), str))
                except (ValueError, TypeError, OverflowError):
                    pass  # Preserve malformed non-target records verbatim.
                if matches:
                    removed = True
                else:
                    kept.append(raw)
                start = end
            if not removed:
                raise ValueError(f"no memo with id {memo_id}")
            _require_memo_snapshot(path, snapshot)
            data = "".join(kept).encode("utf-8", errors="strict")
            attempted = True
            if os.name == "posix":
                _write_atomic_posix(Path(cwd), path, data, expected, lambda: _require_memo_snapshot(path, snapshot))
            else:
                _write_atomic_portable(Path(cwd), path, data, expected, lambda: _require_memo_snapshot(path, snapshot))
            saved = True
    except Exception as failure:
        if saved:
            raise RuntimeError(f"forgot #{memo_id}; lock cleanup failed: {failure}. Do not retry this deletion.") from failure
        if attempted:
            raise RuntimeError(f"forget #{memo_id} may have completed. Inspect .memo.jsonl before retrying: {failure}") from failure
        raise
    return f"forgot #{memo_id}"


def _format_memo_timestamp(ms: int) -> str:
    # Avoid platform time_t limits by reducing to a Gregorian 400-year cycle.
    cycles, remainder = divmod(ms, 146097 * 86400000)
    date = datetime(1970, 1, 1) + timedelta(milliseconds=remainder)
    year = date.year + cycles * 400
    prefix = f"{year:04d}" if year <= 9999 else f"+{year:06d}"
    return (f"{prefix}-{date.month:02d}-{date.day:02d}T"
            f"{date.hour:02d}:{date.minute:02d}:{date.second:02d}.{date.microsecond // 1000:03d}Z")


def _select_recall_page(cwd, query, tags, limit, offset):
    q = query.lower() if isinstance(query, str) and query else None
    clean_tags = _sanitize_tags(tags)
    wanted = {tag.lower() for tag in clean_tags} if clean_tags else None

    def scan(capacity):
        heap = []
        total = 0
        def accept(raw):
            nonlocal total
            if q and q not in raw["memo"].lower():
                return
            clean = _sanitize_tags(raw.get("tags"))
            if wanted and not wanted.issubset({tag.lower() for tag in clean or []}):
                return
            memo = {"id": int(raw["id"]), "ts": int(raw["ts"]), "memo": raw["memo"]}
            if clean:
                memo["tags"] = clean
            entry = (memo["id"], -total, total, memo)
            total += 1
            if len(heap) < capacity:
                heapq.heappush(heap, entry)
            elif entry[:2] > heap[0][:2]:
                heapq.heapreplace(heap, entry)
        _memo_append_state(cwd, accept)
        return total, heap

    # Keep deep pages to one scan: probing the tail then rescanning doubled latency.
    if offset > 1000:
        memos = []
        def accept(raw):
            if q and q not in raw["memo"].lower():
                return
            clean = _sanitize_tags(raw.get("tags"))
            if wanted and not wanted.issubset({tag.lower() for tag in clean or []}):
                return
            memo = {"id": int(raw["id"]), "ts": int(raw["ts"]), "memo": raw["memo"]}
            if clean:
                memo["tags"] = clean
            memos.append(memo)
        _memo_append_state(cwd, accept)
        memos.sort(key=lambda memo: memo["id"], reverse=True)
        return len(memos), memos[offset:offset + limit]
    total, heap = scan(offset + limit)
    heap.sort(key=lambda entry: (-entry[3]["id"], entry[2]))
    return total, [entry[3] for entry in heap[offset:offset + limit]]


def handle_recall(cwd: str, query: str | None = None, tags: list | None = None,
                  limit: int | None = None, offset: int | None = None) -> str:
    finite = lambda value: type(value) is int or (type(value) is float and math.isfinite(value))
    lim = int(min(limit, 1000)) if finite(limit) and limit >= 1 else 20
    off = int(min(offset, 9007199254740991)) if finite(offset) and offset >= 0 else 0
    total, page = _select_recall_page(cwd, query, tags, lim, off)
    if not total:
        return "(no matches)"
    if off >= total:
        return f"(no matches at offset={off}; total={total})"
    lines = []
    for m in page:
        ts = _format_memo_timestamp(m["ts"])
        tag_str = f" [{','.join(m['tags'])}]" if m.get("tags") else ""
        lines.append(f"#{m['id']} {ts}{tag_str} {m['memo']}")
    end = off + len(page)
    footer = f"-- {off + 1}-{end} of {total}"
    if end < total:
        footer += f" (next: offset={end})"
    return "\n".join(lines) + "\n" + footer


def _preview_policy_host(host: str) -> str:
    host = urllib.parse.unquote(host, encoding="utf-8", errors="strict").lower()
    if "%" in host:
        raise ValueError("invalid host encoding")
    if ":" not in host:
        host = host.encode("idna").decode("ascii").lower().rstrip(".")
        if not host or any(ord(c) <= 32 or ord(c) == 127 or c in "#%/:<>?@[\\]^|" for c in host):
            raise ValueError("invalid host character")
    if ":" in host:
        import ipaddress
        address = ipaddress.IPv6Address(host)
        return str(address.ipv4_mapped or address)
    parts = host.split(".")
    if all(re.fullmatch(r"(?:0[xX][0-9a-fA-F]+|[0-9]+)", part) for part in parts):
        if len(parts) > 4:
            raise ValueError("invalid IPv4 address")
        values = [int(part[2:], 16) if part.lower().startswith("0x") else int(part, 8 if len(part) > 1 and part[0] == "0" else 10) for part in parts]
        if any(value > 255 for value in values[:-1]) or values[-1] >= 256 ** (5 - len(parts)):
            raise ValueError("invalid IPv4 address")
        value = sum(part << (8 * (3 - i)) for i, part in enumerate(values[:-1])) + values[-1]
        host = ".".join(str((value >> shift) & 255) for shift in (24, 16, 8, 0))
    return host


def handle_preview(url: str) -> str:
    if not has_cloudflared:
        raise ValueError("cloudflared not found on PATH")
    if not isinstance(url, str) or not url:
        raise ValueError("url required")
    url.encode("utf-8", errors="strict")
    if (re.search(r"[\x00-\x20\x7f\\]", url) or re.search(r"%(?![0-9a-fA-F]{2})", url)
            or not re.match(r"https?://", url, re.IGNORECASE)):
        raise ValueError("invalid http(s) url")
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("invalid http(s) url")
    _ = parsed.port
    host = _preview_policy_host(parsed.hostname)
    if host in ("169.254.169.254", "metadata.google.internal", "metadata") or host.endswith(".internal"):
        raise ValueError("url targets a protected host")
    # Use the shared job owner/capture lifecycle; never share the gateway tunnel cache.
    started = start_job(f"cloudflared tunnel --url {url} --no-autoupdate", os.getcwd(),
                        _argv=["cloudflared", "tunnel", "--url", url, "--no-autoupdate"])
    if not started.startswith("started "):
        raise RuntimeError(started)
    job_id = started[len("started "):]
    with jobs_lock:
        job = jobs[job_id]
    deadline = time.monotonic() + 20
    try:
        while time.monotonic() < deadline:
            if job["proc"].poll() is not None:
                raise RuntimeError(f"cloudflared exited (job {job_id})")
            with job["_buf_lock"]:
                text = _capture_text(job["_buf"])
            # A capture can end mid-hostname; wait for an actual log delimiter.
            match = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com(?=[\s|])", text, re.IGNORECASE)
            if match:
                return f"{match.group(0)} (job {job_id})"
            time.sleep(0.25)
        raise TimeoutError(f"timeout waiting for tunnel URL (job {job_id})")
    except Exception as failure:
        cleanup = stop_job(job_id, 0)
        if isinstance(cleanup, JobFailure):
            raise RuntimeError(f"{failure}; cleanup failed for {job_id}: {cleanup}") from failure
        raise


# MCP server state management
mcp_servers: dict[str, dict] = {}  # key: "cwd:servername"
mcp_processes: dict[str, subprocess.Popen] = {}  # key: "cwd:servername" (stdio)
mcp_http: dict[str, dict] = {}  # key: "cwd:servername" -> {"url","headers","session_id"} (http)
mcp_next_id = 0
mcp_lock = threading.Lock()

# Bound concurrent outbound requests; server replies use the connection writer
# independently so a full request limit cannot deadlock callback responses.
_mcp_stdio_slots = threading.BoundedSemaphore(16)
_mcp_stdio_admission = threading.BoundedSemaphore(80)


# One lazy scheduler owns idle deadlines; calls do not create timer threads.
_mcp_idle_condition = threading.Condition()
_mcp_idle_deadlines = {}
_mcp_idle_thread = None


def _mcp_idle_register(proc, timeout_ms):
    proc._mcp_idle = {"users": 1, "ttl": timeout_ms / 1000.0, "retired": False}


def _mcp_idle_retired(proc):
    return getattr(proc, "_mcp_idle", {}).get("retired", False)


def _mcp_idle_acquire(proc):
    with _mcp_idle_condition:
        state = getattr(proc, "_mcp_idle", None)
        if state is None:
            return True
        if state["retired"]:
            return False
        state["users"] += 1
        _mcp_idle_deadlines.pop(proc, None)
        _mcp_idle_condition.notify()
        return True


def _mcp_idle_retire(proc):
    with _mcp_idle_condition:
        state = getattr(proc, "_mcp_idle", None)
        if state is not None:
            state["retired"] = True
        _mcp_idle_deadlines.pop(proc, None)
        _mcp_idle_condition.notify()


def _mcp_idle_release(proc):
    global _mcp_idle_thread
    with _mcp_idle_condition:
        state = getattr(proc, "_mcp_idle", None)
        if state is None:
            return
        state["users"] -= 1
        if state["users"] == 0 and not state["retired"] and state["ttl"] > 0 and not shutting_down:
            _mcp_idle_deadlines[proc] = time.monotonic() + state["ttl"]
            if _mcp_idle_thread is None:
                _mcp_idle_thread = threading.Thread(target=_mcp_idle_run, name="mcp-idle", daemon=True)
                _mcp_idle_thread.start()
            _mcp_idle_condition.notify()


def _mcp_idle_run():
    global _mcp_idle_thread
    while True:
        with _mcp_idle_condition:
            if shutting_down:
                _mcp_idle_deadlines.clear()
                _mcp_idle_thread = None
                return
            if not _mcp_idle_deadlines:
                notified = _mcp_idle_condition.wait(60.0)
                if not notified and not _mcp_idle_deadlines:
                    _mcp_idle_thread = None
                    return
                continue
            proc, deadline = min(_mcp_idle_deadlines.items(), key=lambda item: item[1])
            remaining = deadline - time.monotonic()
            if remaining > 0:
                _mcp_idle_condition.wait(remaining)
                continue
            _mcp_idle_deadlines.pop(proc, None)
            state = proc._mcp_idle
            if state["users"] or state["retired"]:
                continue
            # Mark before cleanup so new work acquires a fresh generation.
            state["retired"] = True
        try:
            _mcp_close_stdio(proc, "MCP subprocess idle timeout")
        except Exception as error:
            print(f"[mcp] idle cleanup failed: {error}", file=sys.stderr)


MAX_MCP_STDIO_FRAME_BYTES = 16 * 1024 * 1024


class _McpStdioFrameError(IOError):
    pass


def _mcp_is_notification(message):
    return (message.get("jsonrpc") == "2.0" and isinstance(message.get("method"), str)
            and "id" not in message and "result" not in message and "error" not in message)


def _mcp_server_request(message):
    request_id = message.get("id")
    valid_id = isinstance(request_id, str)
    if type(request_id) in (int, float):
        try: valid_id = math.isfinite(request_id)
        except OverflowError: valid_id = False
    response = {"jsonrpc": "2.0", "id": request_id if valid_id else None}
    def error(code, text):
        return {**response, "error": {"code": code, "message": text}}
    if (not valid_id or message.get("jsonrpc") != "2.0" or not isinstance(message.get("method"), str)
            or "result" in message or "error" in message):
        return error(-32600, "Invalid Request")
    if "params" in message and not isinstance(message["params"], dict):
        return error(-32602, "Invalid params")
    if message["method"] == "ping":
        return {**response, "result": {}}
    if message["method"] == "roots/list":
        return {**response, "result": {"roots": []}}
    return error(-32601, "Method not found")


_MCP_MAX_BATCH_MESSAGES = 1024


def _mcp_batch_messages(value):
    if not isinstance(value, list):
        return [value]
    if len(value) > _MCP_MAX_BATCH_MESSAGES:
        raise IOError("MCP batch exceeds 1024 messages")
    requests, responses = set(), set()
    for message in value:
        if not isinstance(message, dict):
            continue
        request_id = message.get("id")
        valid_id = isinstance(request_id, str)
        if type(request_id) in (int, float):
            try: valid_id = math.isfinite(request_id)
            except OverflowError: valid_id = False
        if not valid_id:
            continue
        ids = requests if "method" in message else responses
        if request_id in ids:
            raise IOError("duplicate MCP batch request or response ID")
        ids.add(request_id)
    return value


# Windows MCP children are assigned to a kill-on-close Job before resuming.
# Keep this source identical across the three standalone implementations.
_MCP_WINDOWS_JOB_SOURCE = r'''using System;
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
        StringBuilder result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in argument) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); }
            else { result.Append('\\', slashes); result.Append(c); }
            slashes = 0;
        }
        result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
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
                    original = new UTF8Encoding(false, true).GetString(bytes).Split(new char[] { '\0' });
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
'''
_mcp_windows_job_dir = None
_mcp_windows_job_exe = None


def _mcp_windows_job_helper():
    # Caller holds _mcp_spawn_lock; compile once, never fall back to an
    # uncontained child if the compiler or Windows job setup is unavailable.
    global _mcp_windows_job_dir, _mcp_windows_job_exe
    if _mcp_windows_job_exe is not None:
        return _mcp_windows_job_exe
    directory = Path(_tempfile.mkdtemp(prefix="code-mcp-job-"))
    source, executable = directory / "owner.cs", directory / "owner.exe"
    compiler = None
    try:
        source.write_text(_MCP_WINDOWS_JOB_SOURCE, encoding="utf-8")
        quote = lambda value: "'" + str(value).replace("'", "''") + "'"
        script = ("$ErrorActionPreference='Stop'; Add-Type -TypeDefinition ([IO.File]::ReadAllText("
                  + quote(source) + ")) -OutputAssembly " + quote(executable) + " -OutputType ConsoleApplication")
        powershell = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
        compiler = subprocess.Popen([str(powershell), "-NoProfile", "-NonInteractive", "-EncodedCommand",
                    base64.b64encode(script.encode("utf-16-le")).decode("ascii")],
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    env=build_child_env(), cwd=str(directory))
        if compiler.wait(timeout=10) != 0 or not executable.is_file():
            raise IOError("Windows MCP process owner compilation failed")
        _mcp_windows_job_dir, _mcp_windows_job_exe = directory, str(executable)
        return _mcp_windows_job_exe
    except BaseException:
        if compiler is not None and compiler.poll() is None:
            _kill_proc_tree(compiler)
            try: compiler.wait(timeout=3)
            except subprocess.TimeoutExpired: pass
        shutil.rmtree(directory, ignore_errors=True)
        raise


_windows_root_guard = None
_windows_root_guard_lock = threading.Lock()


def _ensure_windows_root_owner():
    """Lazily own subsequent Windows process trees for the server lifetime."""
    global _windows_root_guard
    if sys.platform != "win32":
        return
    with _windows_root_guard_lock:
        if shutting_down:
            raise IOError("server is shutting down")
        if _windows_root_guard is not None:
            if _windows_root_guard.poll() is not None:
                raise IOError("Windows root process owner exited")
            return
        with _mcp_spawn_lock:
            executable = _mcp_windows_job_helper()
        script = ("$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; "
                  "Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:CODE_MCP_OWNER_SOURCE)); "
                  "[CodeMcpWindowsJob]::GuardRoot([uint32]$env:CODE_MCP_OWNER_PID)")
        powershell = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
        proc = subprocess.Popen([str(powershell), "-NoProfile", "-NonInteractive", "-Command", script],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                cwd=str(powershell.parent),
                env=build_child_env({"CODE_MCP_OWNER_SOURCE": str(Path(executable).with_name("owner.cs")),
                                     "CODE_MCP_OWNER_PID": str(os.getpid())}))
        ready = queue.Queue(maxsize=1)
        def read_ready():
            try:
                ready.put(proc.stdout.readline(128))
            except BaseException as error:
                ready.put(error)
        reader = threading.Thread(target=read_ready, daemon=True, name="root-owner-ready")
        reader.start()
        try:
            if ready.get(timeout=15) != b"CODE_MCP_ROOT_READY\r\n":
                raise IOError("Windows root process owner did not become ready")
            _windows_root_guard = proc
        except BaseException:
            if proc.poll() is None:
                _kill_proc_tree(proc)
            try: proc.wait(timeout=2)
            except subprocess.TimeoutExpired: pass
            raise IOError("Windows root process owner failed to start")
        finally:
            reader.join(timeout=1)
            if not reader.is_alive(): proc.stdout.close()


def _mcp_cleanup_windows_job():
    _mcp_shutdown_stdio()
    if _mcp_windows_job_dir is not None:
        shutil.rmtree(_mcp_windows_job_dir, ignore_errors=True)


atexit.register(_mcp_cleanup_windows_job)


_mcp_owned_stdio = set()
_mcp_owned_lock = threading.Lock()
_mcp_spawn_lock = threading.Lock()


def _mcp_spawn_stdio(*args, **kwargs):
    # Ownership must be visible to shutdown before an OS spawn is allowed to
    # return to namespace registration. Do not hold this lock over handshake IO.
    with _mcp_spawn_lock:
        if shutting_down:
            raise IOError("server is shutting down")
        if sys.platform == "win32":
            executable = _mcp_windows_job_helper()
            if shutting_down:
                raise IOError("server is shutting down")
            args = ([executable, str(os.getpid()), "stdio", "argv", *args[0]], *args[1:])
        proc = subprocess.Popen(*args, **kwargs)
        with _mcp_owned_lock:
            _mcp_owned_stdio.add(proc)
        return proc


def _mcp_release_stdio(proc):
    _mcp_idle_retire(proc)
    with _mcp_owned_lock:
        _mcp_owned_stdio.discard(proc)


def _mcp_shutdown_stdio():
    with _mcp_spawn_lock:
        with _mcp_owned_lock:
            owned = list(_mcp_owned_stdio)
    for proc in owned:
        _mcp_close_stdio(proc, "MCP server shutdown")


class _McpStdioConnection:
    """One reader and one bounded writer per owned process, including while idle."""
    def __init__(self, proc):
        self.process = weakref.ref(proc)
        self.lock = threading.Lock()
        self.closed = threading.Event()
        self.terminated = threading.Event()
        self.error = None
        self.timed_out = False
        self.pending = {}
        self.serial = 0
        self.writes = queue.PriorityQueue(maxsize=64)
        self.write_bytes = 0
        self.write_count = 0
        self.read_io = {"lock": threading.Lock()}
        self.write_io = {"lock": threading.Lock()}
        self.reader = threading.Thread(target=self._read, name="mcp-stdio-reader", daemon=True)
        self.writer = threading.Thread(target=self._write, name="mcp-stdio-writer", daemon=True)
        try:
            self.writer.start()
            self.reader.start()
        except Exception:
            self.close("MCP stdio reader/writer failed to start")
            raise

    @staticmethod
    def _release_io(state):
        with state["lock"]:
            handle = state.pop("handle", None)
            if handle is not None:
                state["kernel"].CloseHandle(handle)

    def close(self, error):
        with self.lock:
            if self.closed.is_set():
                return
            self.error = str(error)
            self.timed_out = isinstance(error, TimeoutError)
            self.closed.set()
            waiters = list(self.pending.values())
            self.pending.clear()
            while True:
                try: self.writes.get_nowait()
                except queue.Empty: break
            self.write_bytes = 0
            self.write_count = 0
            for waiter in waiters:
                waiter["error"] = self.error
                waiter["timeout"] = self.timed_out
                waiter["done"].set()
        proc = self.process()
        try:
            if proc is not None:
                _kill_proc_tree(proc)
        finally:
            # Closing stdin first can make the parent exit before taskkill
            # enumerates its children. Keep pipe owners behind tree cleanup.
            self.terminated.set()
            if proc is not None:
                _mcp_release_stdio(proc)
        # Use pinned thread handles, never recycled numeric thread IDs. Repeat
        # briefly to cover an I/O call starting concurrently with cancellation.
        until = time.monotonic() + .2
        current = threading.current_thread()
        while True:
            _grep_cancel_writer(self.read_io)
            _grep_cancel_writer(self.write_io)
            others = [t for t in (self.reader, self.writer) if t is not current and t.is_alive()]
            if not others or time.monotonic() >= until:
                break
            for thread in others:
                thread.join(.01)

    def _enqueue(self, payload, deadline, waiter=None, control=False):
        with self.lock:
            if self.closed.is_set():
                raise IOError(self.error or "MCP stdio connection closed")
            if len(payload) > MAX_MCP_STDIO_FRAME_BYTES:
                raise IOError("MCP stdio frame exceeds 16 MiB")
            # Include the active write, not only entries still in the queue.
            if self.write_count >= 64 or self.write_bytes + len(payload) > MAX_MCP_STDIO_FRAME_BYTES:
                raise IOError("MCP stdio write queue capacity exceeded")
            self.serial += 1
            self.writes.put_nowait((0 if control else 1, self.serial, (payload, deadline, waiter)))
            self.write_bytes += len(payload)
            self.write_count += 1

    def _complete(self, request_id, value=None, error=None):
        with self.lock:
            waiter = self.pending.pop(request_id, None)
            if waiter is None:
                return
            if time.monotonic() >= waiter["deadline"]:
                waiter["error"] = "MCP stdio deadline exceeded"
                waiter["timeout"] = True
            elif error is not None:
                waiter["error"] = str(error)
            else:
                waiter["value"] = value
            waiter["done"].set()

    def _read(self):
        proc = self.process()
        try:
            _grep_pin_writer(self.read_io)
            while not self.closed.is_set():
                line = proc.stdout.readline(MAX_MCP_STDIO_FRAME_BYTES + 1)
                if not line:
                    raise EOFError("MCP server process ended")
                if len(line) > MAX_MCP_STDIO_FRAME_BYTES:
                    raise _McpStdioFrameError("MCP stdio frame exceeds 16 MiB")
                if not line.endswith(b"\n"):
                    raise _McpStdioFrameError("unterminated MCP stdio frame")
                try:
                    self._dispatch(line)
                finally:
                    del line
        except Exception as error:
            self.close(error)
        finally:
            if self.closed.is_set():
                self.terminated.wait()
            if proc is not None:
                for stream in (proc.stdout, proc.stderr):
                    if stream is not None:
                        try: stream.close()
                        except OSError: pass
            self._release_io(self.read_io)

    def _reply(self, reply):
        self._enqueue(json_utf8(reply) + b"\n", time.monotonic() + 30.0, control=True)

    def _expects_response(self, request_id):
        if type(request_id) not in (int, float):
            return False
        with self.lock:
            return request_id in self.pending

    def _dispatch_response(self, message):
        request_id = message.get("id")
        if type(request_id) not in (int, float):
            return
        with self.lock:
            waiter = self.pending.get(request_id)
            # Only the writer can acknowledge notification flushes.
            if waiter is None or waiter["notification"]:
                return
        try:
            value = _mcp_rpc_result(message, request_id)
        except Exception as error:
            self._complete(request_id, error=error)
        else:
            self._complete(request_id, value=value)

    def _dispatch(self, line):
        try:
            payload = _mcp_parse_json(line.decode("utf-8", errors="strict"))
        except json.JSONDecodeError:
            return
        # Ordinary messages avoid batch arrays and ID-set allocation.
        if not isinstance(payload, list):
            if not isinstance(payload, dict):
                return
            if "method" in payload:
                if not _mcp_is_notification(payload):
                    self._reply(_mcp_server_request(payload))
            else:
                self._dispatch_response(payload)
            return
        messages = _mcp_batch_messages(payload)
        replies, responses = [], []
        for message in messages:
            if not isinstance(message, dict):
                replies.append(_mcp_server_request({}))
            elif "method" in message:
                if not _mcp_is_notification(message):
                    replies.append(_mcp_server_request(message))
            elif "result" in message or "error" in message or self._expects_response(message.get("id")):
                responses.append(message)
            else:
                replies.append(_mcp_server_request(message))
        if not messages:
            self._reply(_mcp_server_request({}))
        elif replies:
            self._reply(replies)
        for message in responses:
            self._dispatch_response(message)

    def _write(self):
        proc = self.process()
        try:
            _grep_pin_writer(self.write_io)
            while not self.closed.is_set():
                try:
                    _, _, (payload, deadline, waiter) = self.writes.get(timeout=.05)
                except queue.Empty:
                    continue
                if self.closed.is_set():
                    break
                if time.monotonic() >= deadline:
                    raise TimeoutError("MCP stdio write deadline exceeded")
                timer = threading.Timer(max(0.0, deadline - time.monotonic()), self.close,
                                        args=(TimeoutError("MCP stdio write deadline exceeded"),))
                timer.daemon = True
                timer.start()
                try:
                    if self.closed.is_set():
                        break
                    proc.stdin.write(payload)
                    proc.stdin.flush()
                    if waiter is not None and waiter["notification"]:
                        self._complete(waiter["id"], value={})
                finally:
                    timer.cancel()
                    with self.lock:
                        if not self.closed.is_set():
                            self.write_bytes -= len(payload)
                            self.write_count -= 1
                    del payload, timer, waiter
        except Exception as error:
            self.close(error)
        finally:
            if self.closed.is_set():
                self.terminated.wait()
            if proc is not None and proc.stdin is not None:
                try: proc.stdin.close()
                except OSError: pass
            self._release_io(self.write_io)

    def call(self, request_id, method, params, deadline):
        notification = method.startswith("notifications/")
        request = {"jsonrpc": "2.0", "method": method, "params": params}
        if not notification:
            request["id"] = request_id
        payload = json_utf8(request) + b"\n"
        waiter = {"id": request_id, "done": threading.Event(), "notification": notification, "deadline": deadline}
        with self.lock:
            if self.closed.is_set():
                raise IOError(self.error or "MCP stdio connection closed")
            self.pending[request_id] = waiter
        try:
            self._enqueue(payload, deadline, waiter)
            if not waiter["done"].wait(max(0.0, deadline - time.monotonic())):
                self.close(TimeoutError("MCP stdio deadline exceeded"))
                raise TimeoutError("MCP stdio deadline exceeded")
            if waiter.get("timeout"):
                self.close(TimeoutError(waiter["error"]))
                raise TimeoutError(waiter["error"])
            if "error" in waiter:
                raise IOError(waiter["error"])
            return waiter["value"]
        finally:
            with self.lock:
                self.pending.pop(request_id, None)


def _mcp_close_stdio(proc, reason="MCP server was unloaded"):
    _mcp_idle_retire(proc)
    connection = getattr(proc, "_mcp_connection", None)
    if connection is not None:
        connection.close(IOError(reason))
        connection.terminated.wait()
    else:
        try:
            _kill_proc_tree(proc)
            for stream in (proc.stdin, proc.stdout, proc.stderr):
                if stream is not None:
                    try: stream.close()
                    except OSError: pass
        finally:
            _mcp_release_stdio(proc)


def _mcp_stdio_exchange(proc, method, params, timeout_s=None):
    global mcp_next_id
    budget = timeout_s if timeout_s is not None else (90.0 if method == "tools/call" else 30.0)
    deadline = time.monotonic() + budget
    if budget <= 0:
        raise TimeoutError("MCP setup deadline exceeded")
    if not _mcp_stdio_admission.acquire(blocking=False):
        raise IOError("MCP stdio call capacity exceeded")
    try:
        if not _mcp_stdio_slots.acquire(timeout=max(0.0, deadline - time.monotonic())):
            raise TimeoutError("MCP stdio capacity deadline exceeded")
        try:
            with mcp_lock:
                mcp_next_id += 1
                request_id = mcp_next_id
                connection = getattr(proc, "_mcp_connection", None)
                if connection is None:
                    connection = proc._mcp_connection = _McpStdioConnection(proc)
            result = connection.call(request_id, method, params, deadline)
            if method == "initialize":
                _mcp_negotiated_version(result)
            return result
        finally:
            _mcp_stdio_slots.release()
    finally:
        _mcp_stdio_admission.release()


# ----- Boot-time aggregator (parity with TS --mcp flag) -----
# Servers from {process.cwd()}/{mcp_config_path} are spawned at startup, probed
# in parallel, and their tools surface in the main tools/list under
# `<ns>__<tool>` so the agent can call them as if they were built-in.
NAMESPACE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
aggregator_processes: dict[str, subprocess.Popen] = {}  # key: namespace (stdio)
aggregator_stdio_configs: dict[str, dict] = {}
aggregator_stdio_setups: dict[str, concurrent.futures.Future] = {}
aggregator_http_configs: dict[str, dict] = {}
aggregator_http_setups: dict[str, concurrent.futures.Future] = {}
aggregator_http: dict[str, dict] = {}  # namespace -> {"url","headers","session_id"} (http transport)
aggregator_tools: dict[str, dict] = {}  # prefixed name -> {"ns","tool","description","inputSchema"}
aggregator_known: set[str] = set()  # all ns declared in --mcp config (probed or not)
aggregator_lock = threading.Lock()  # protects aggregator_* maps and set
aggregator_io_locks: dict[str, threading.Lock] = {}  # per-namespace stdio lock
_aggregator_next_id = 0


def _mcp_validate_server(cfg):
    def text(value, label, empty=True):
        if not isinstance(value, str) or (not empty and not value):
            raise ValueError(f"{label} must be a string" if empty else f"{label} must be a nonempty string")
        if "\0" in value:
            raise ValueError(f"{label} contains NUL")
        value.encode("utf-8", errors="strict")
        return value
    if not isinstance(cfg, dict):
        raise ValueError("config must be an object")
    if "idleTimeoutMs" in cfg:
        value = cfg["idleTimeoutMs"]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not (0 <= value <= 2147483647) or value != int(value):
            raise ValueError("idleTimeoutMs must be an integer from 0 through 2147483647")
    transport = cfg.get("type", "stdio")
    if transport == "http":
        raw = text(cfg.get("url"), "url", False)
        if re.search(r"[\x00-\x20]", raw):
            raise ValueError("invalid http url")
        url = urllib.parse.urlsplit(raw)
        if url.scheme not in ("http", "https") or not url.hostname:
            raise ValueError("invalid http url")
        _ = url.port  # Validate explicit ports before connecting.
        if url.scheme == "http" and url.hostname.lower() not in ("localhost", "127.0.0.1", "::1"):
            raise ValueError("http transport requires HTTPS except for loopback")
        if "headers" in cfg:
            if not isinstance(cfg["headers"], dict):
                raise ValueError("headers must be an object")
            for key, value in cfg["headers"].items():
                if not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", key):
                    raise ValueError("invalid header name")
                if not re.fullmatch(r"[\t\x20-\x7e\x80-\xff]*", text(value, "header value")):
                    raise ValueError("invalid header value")
    elif transport == "stdio":
        if re.search(r"[;|<>&]", text(cfg.get("command"), "command", False)):
            raise ValueError("command contains shell operators")
        if "args" in cfg:
            if not isinstance(cfg["args"], list):
                raise ValueError("args must be an array of strings")
            for arg in cfg["args"]:
                text(arg, "argument")
        if "env" in cfg:
            if not isinstance(cfg["env"], dict):
                raise ValueError("env must be an object")
            for key, value in cfg["env"].items():
                if "=" in text(key, "env key", False):
                    raise ValueError("invalid env key")
                text(value, "env value")
    else:
        raise ValueError("unsupported transport type")


def _aggregator_validate(ns: str, cfg: dict) -> str | None:
    if not NAMESPACE_RE.fullmatch(ns):
        return f"invalid namespace '{ns}'"
    try:
        _mcp_validate_server(cfg)
        return None
    except (ValueError, TypeError, UnicodeError) as error:
        return str(error)


_AGGREGATOR_HTTP_MAX_RESP = 16 * 1024 * 1024  # memory-DoS guard for http responses


class _McpJsonDepthError(ValueError):
    pass


class _McpJsonNumberError(ValueError):
    pass


_MCP_JSON_TOKENS = re.compile('"[^"\\\\]*"|["{}\\[\\]]|-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?')
# Bound regex state even on escape-heavy or unterminated strings.
_MCP_JSON_QUOTED_CHUNK = re.compile(r'[^"\\]*(?:\\[\s\S][^"\\]*){0,256}')


def _mcp_invalid_json_constant(value):
    # Python accepts these JavaScript extensions by default; MCP uses JSON.
    raise json.JSONDecodeError("Invalid JSON constant", value, 0)


def _mcp_parse_json(text, max_depth=256):
    """Bound container nesting before native parsing, skipping quoted runs."""
    pos, depth = 0, 0
    while True:
        match = _MCP_JSON_TOKENS.search(text, pos)
        if match is None:
            break
        pos = match.end()
        ch = text[match.start()]
        if ch == '"' and pos - match.start() == 1:
            while pos < len(text):
                pos = _MCP_JSON_QUOTED_CHUNK.match(text, pos).end()
                if pos >= len(text):
                    break
                if text[pos] == '"':
                    pos += 1
                    break
                pos += 2  # chunk escape limit, or malformed trailing backslash
        elif ch in '{[':
            depth += 1
            if depth > max_depth:
                raise _McpJsonDepthError(f"JSON: too deeply nested (>{max_depth})")
        elif ch in '}]':
            depth -= 1
        elif ch != '"':
            token = match.group()
            if (len(token) >= 309 or 'e' in token or 'E' in token) and not math.isfinite(float(token)):
                raise _McpJsonNumberError("JSON: number exceeds finite range")
    return json.loads(text, parse_constant=_mcp_invalid_json_constant)


class _McpSseDecoder:
    def __init__(self, dispatch=None):
        self.parts, self.data, self.skip_lf = [], [], False
        self.dispatch = dispatch

    def finish_line(self):
        line = "".join(self.parts)
        self.parts = []
        if not line:
            payload = "\n".join(self.data)
            self.data = []
            try:
                message = _mcp_parse_json(payload)
            except (_McpJsonDepthError, _McpJsonNumberError):
                raise
            except (ValueError, RecursionError):
                return None
            if self.dispatch is not None and (isinstance(message, list) or
                    (isinstance(message, dict) and any(key in message for key in ("method", "result", "error")))):
                return self.dispatch(message)
            if isinstance(message, dict) and ("result" in message or "error" in message):
                return message
        else:
            field, separator, value = line.partition(":")
            if field == "data":
                self.data.append(value[1:] if value.startswith(" ") else value)
        return None

    def feed(self, text):
        start = 0
        for match in re.finditer(r"[\r\n]", text):
            index, char = match.start(), match.group()
            if self.skip_lf:
                self.skip_lf = False
                if char == "\n" and index == start:
                    start = index + 1
                    continue
            self.parts.append(text[start:index])
            message = self.finish_line()
            if message is not None:
                return message
            self.skip_lf = char == "\r"
            start = index + 1
        if start < len(text):
            self.parts.append(text[start:])
            self.skip_lf = False
        return None


def _read_mcp_http_message(response, notification, dispatch=None):
    declared = int(response.headers.get("Content-Length", "-1"))
    if declared > _AGGREGATOR_HTTP_MAX_RESP:
        raise IOError("MCP HTTP response exceeds 16 MiB")
    if response.status in (202, 204) or declared == 0:
        if not notification:
            raise IOError("RPC request received an empty response")
        return None
    if not notification and "text/event-stream" in response.headers.get("Content-Type", "").lower():
        parser = _McpSseDecoder(dispatch)
        decoder = codecs.getincrementaldecoder("utf-8-sig")(errors="strict")
        total = 0
        while True:
            chunk = response.read1(64 * 1024)
            if not chunk:
                parser.feed(decoder.decode(b"", final=True))
                raise IOError("SSE stream ended without an RPC response")
            total += len(chunk)
            if total > _AGGREGATOR_HTTP_MAX_RESP:
                raise IOError("SSE response exceeds 16 MiB")
            message = parser.feed(decoder.decode(chunk))
            if message is not None:
                return message
    raw = response.read(_AGGREGATOR_HTTP_MAX_RESP + 1)
    if len(raw) > _AGGREGATOR_HTTP_MAX_RESP:
        raise IOError("MCP HTTP response exceeds 16 MiB")
    if notification:
        return None
    payload = _mcp_parse_json(raw.decode("utf-8-sig", errors="strict"))
    return dispatch(payload) if dispatch is not None else payload


class _McpNoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


# Bound worker count as well as elapsed time: an OS resolver cannot be interrupted
# portably, so a stuck resolver retains its slot instead of spawning unbounded work.
_mcp_http_slots = threading.BoundedSemaphore(16)
# Reserved one-way reply workers avoid deadlocking sixteen occupied RPC workers.
# These slots, like RPC slots, stay charged until OS-owned DNS work really exits.
_mcp_http_callback_slots = threading.BoundedSemaphore(16)


class _McpHttpCancellation:
    def __init__(self):
        self.cancelled = threading.Event()
        self.lock = threading.Lock()
        self.callbacks = set()

    def register(self, callback):
        with self.lock:
            if not self.cancelled.is_set():
                self.callbacks.add(callback)
                return
        callback()

    def unregister(self, callback):
        with self.lock:
            self.callbacks.discard(callback)

    def cancel(self):
        with self.lock:
            self.cancelled.set()
            callbacks = tuple(self.callbacks)
            self.callbacks.clear()
        for callback in callbacks:
            callback()


def _expire_mcp_http(scope):
    # Match connection identity, never just namespace or a possibly reused SID.
    with aggregator_lock:
        for key, info in list(aggregator_http.items()):
            if info.get("cancellation") is scope:
                aggregator_http.pop(key, None)
    removed = []
    with mcp_lock:
        for key, info in list(mcp_http.items()):
            if info.get("cancellation") is scope:
                mcp_http.pop(key, None)
                mcp_servers.pop(key, None)
                removed.append(info)
    for info in removed:
        info["setup_error"] = "MCP HTTP session expired"
        info["setup_done"].set()
    scope.cancel()


def _mcp_http_exchange(request, notification, timeout_s=30.0, cancellation=None, message_handler=None, callback=False):
    deadline = time.monotonic() + timeout_s
    slots = _mcp_http_callback_slots if callback else _mcp_http_slots
    while True:
        if cancellation is not None and cancellation.cancelled.is_set():
            raise IOError("MCP server was unloaded")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("MCP HTTP response deadline exceeded while waiting for capacity")
        if slots.acquire(timeout=min(0.05, remaining)):
            break
    finished = threading.Event()
    wake = threading.Event()
    cancelled = threading.Event()
    owned_lock = threading.Lock()
    owned_sockets = []
    outcome = []

    def close_socket(sock):
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            sock.close()
        except OSError:
            pass

    def abort():
        cancelled.set()
        with owned_lock:
            sockets = tuple(owned_sockets)
        for sock in sockets:
            close_socket(sock)

    def cancel_request():
        abort()
        wake.set()

    def connect_socket(address, timeout=None, source_address=None):
        # Resolution itself is OS-owned and not portably cancellable. Check again
        # after it returns, before creating any socket or contacting any address.
        addresses = socket.getaddrinfo(address[0], address[1], 0, socket.SOCK_STREAM)
        last_error = None
        for family, socktype, protocol, _, target in addresses:
            remaining = deadline - time.monotonic()
            if cancelled.is_set() or remaining <= 0:
                raise TimeoutError("MCP HTTP response deadline exceeded")
            sock = socket.socket(family, socktype, protocol)
            with owned_lock:
                owned_sockets.append(sock)
                expired = cancelled.is_set()
            if expired:
                close_socket(sock)
                raise TimeoutError("MCP HTTP response deadline exceeded")
            try:
                sock.settimeout(remaining)
                if source_address:
                    sock.bind(source_address)
                sock.connect(target)
                return sock
            except OSError as error:
                close_socket(sock)
                # Keep diagnostics, not a traceback cycle back to this frame.
                last_error = (type(error), error.args)
        if last_error is not None:
            raise last_error[0](*last_error[1])
        raise OSError("MCP HTTP hostname resolved to no addresses")

    class DeadlineConnection:
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._create_connection = connect_socket

        def connect(self):
            if cancelled.is_set() or time.monotonic() >= deadline:
                raise TimeoutError("MCP HTTP response deadline exceeded")
            self.timeout = max(0.001, deadline - time.monotonic())
            super().connect()
            # Retain the socket itself: urllib detaches it from the connection
            # after headers, while HTTPResponse's file keeps the descriptor alive.
            sock = self.sock
            with owned_lock:
                owned_sockets.append(sock)
                expired = cancelled.is_set() or time.monotonic() >= deadline
            if expired:
                close_socket(sock)
                raise TimeoutError("MCP HTTP response deadline exceeded")

    class HTTPConnection(DeadlineConnection, http.client.HTTPConnection):
        pass

    class HTTPSConnection(DeadlineConnection, http.client.HTTPSConnection):
        pass

    class HTTPHandler(urllib.request.HTTPHandler):
        def http_open(self, req):
            return self.do_open(HTTPConnection, req)

    class HTTPSHandler(urllib.request.HTTPSHandler):
        def https_open(self, req):
            return self.do_open(HTTPSConnection, req, context=self._context)

    def run():
        try:
            if cancelled.is_set() or time.monotonic() >= deadline:
                raise TimeoutError("MCP HTTP response deadline exceeded")
            opener = urllib.request.build_opener(_McpNoRedirect(), HTTPHandler(), HTTPSHandler())
            try:
                with opener.open(request, timeout=max(0.001, deadline - time.monotonic())) as response:
                    sid = response.headers.get("Mcp-Session-Id")
                    result = _read_mcp_http_message(response, notification,
                        (lambda payload: message_handler(payload, deadline, cancelled)) if message_handler is not None else None)
                    if not cancelled.is_set():
                        outcome.append((True, (result, sid)))
            except urllib.error.HTTPError as error:
                if error.code == 404 and cancellation is not None and any(
                        name.lower() == "mcp-session-id" and value for name, value in request.header_items()):
                    error.close()
                    _expire_mcp_http(cancellation)
                    raise IOError("MCP HTTP session expired; start a new call to reconnect")
                try:
                    detail = error.read(512).decode("utf-8", errors="replace")
                finally:
                    error.close()
                raise IOError(f"http {error.code}: {detail}") from error
        except Exception as error:
            if not cancelled.is_set():
                # Never retain an exception traceback across threads: its frames
                # keep the opener, SSL contexts and sockets alive until cyclic GC.
                outcome.append((False, (isinstance(error, TimeoutError), str(error))))
        finally:
            abort()
            slots.release()
            finished.set()
            wake.set()

    if cancellation is not None:
        cancellation.register(cancel_request)
    worker = threading.Thread(target=run, name="mcp-http-callback" if callback else "mcp-http", daemon=True)
    started = False
    try:
        if cancellation is not None and cancellation.cancelled.is_set():
            raise IOError("MCP server was unloaded")
        worker.start()
        started = True
        if not wake.wait(max(0, deadline - time.monotonic())):
            abort()
            raise TimeoutError("MCP HTTP response deadline exceeded")
        if cancellation is not None and cancellation.cancelled.is_set():
            abort()
            raise IOError("MCP server was unloaded")
        if not finished.is_set() or time.monotonic() >= deadline:
            abort()
            raise TimeoutError("MCP HTTP response deadline exceeded")
        ok, value = outcome.pop()
        if not ok:
            timed_out, detail = value
            if timed_out:
                raise TimeoutError(detail)
            raise IOError(detail)
        return value
    finally:
        if not started:
            slots.release()
        if cancellation is not None:
            cancellation.unregister(cancel_request)


def _mcp_rpc_result(message, request_id):
    if (not isinstance(message, dict) or message.get("jsonrpc") != "2.0"
            or type(message.get("id")) not in (int, float) or message["id"] != request_id):
        raise IOError("invalid RPC response envelope")
    if ("result" in message) == ("error" in message):
        raise IOError("RPC response must contain exactly one of result or error")
    if "error" in message:
        raise IOError(f"rpc error: {message['error']}")
    if not isinstance(message["result"], dict):
        raise IOError("MCP RPC result must be an object")
    return message["result"]


_MCP_HANDSHAKE_VERSIONS = frozenset(("2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"))


def _mcp_negotiated_version(result):
    # Future protocol revisions may change transport and lifecycle semantics.
    version = result.get("protocolVersion")
    if not isinstance(version, str) or version not in _MCP_HANDSHAKE_VERSIONS:
        raise IOError("unsupported or invalid MCP protocol version")
    return version


def _mcp_http_headers(info, method):
    # Header names are case-insensitive; keep transport state authoritative.
    headers = {key.lower(): value for key, value in (info.get("headers") or {}).items()
               if key.lower() not in ("content-type", "accept", "mcp-session-id", "mcp-protocol-version")}
    headers["Content-Type"] = "application/json"
    headers["Accept"] = "application/json, text/event-stream"
    if method != "initialize" and info.get("protocol_version"):
        headers["MCP-Protocol-Version"] = info["protocol_version"]
    if method != "initialize" and info.get("session_id"):
        headers["Mcp-Session-Id"] = info["session_id"]
    return headers


class _McpHttpDispatch:
    def __init__(self, info, request_id):
        self.info, self.request_id, self.callbacks = info, request_id, 0

    def __call__(self, payload, deadline, cancelled):
        if cancelled.is_set() or time.monotonic() >= deadline:
            raise TimeoutError("MCP HTTP response deadline exceeded")
        batched = isinstance(payload, list)
        if not batched and (not isinstance(payload, dict) or "method" not in payload):
            return payload
        messages = _mcp_batch_messages(payload)
        replies, response, saw_response = [], None, False
        for message in messages:
            if not isinstance(message, dict):
                replies.append(_mcp_server_request({}))
            elif "method" in message:
                if not _mcp_is_notification(message):
                    replies.append(_mcp_server_request(message))
            else:
                matches = type(message.get("id")) in (int, float) and message["id"] == self.request_id
                if "result" in message or "error" in message or matches:
                    saw_response = True
                    if matches:
                        response = message
                else:
                    replies.append(_mcp_server_request(message))
        if saw_response and response is None:
            raise IOError("MCP HTTP batch has no matching RPC response")
        if not messages:
            replies = [_mcp_server_request({})]
        if replies:
            self.callbacks += len(replies)
            if self.callbacks > _MCP_MAX_BATCH_MESSAGES:
                raise IOError("MCP HTTP response exceeds 1024 callbacks")
            reply = replies if batched and messages else replies[0]
            data = json_utf8(reply)
            if len(data) > _AGGREGATOR_HTTP_MAX_RESP:
                raise IOError("MCP HTTP callback response exceeds 16 MiB")
            if cancelled.is_set():
                raise IOError("MCP HTTP callback was cancelled")
            remaining = min(30.0, _mcp_setup_remaining(deadline))
            request = urllib.request.Request(self.info["url"], data=data,
                headers=_mcp_http_headers(self.info, ""), method="POST")
            # One-way replies never recursively dispatch their response bodies.
            _mcp_http_exchange(request, True, remaining, self.info.get("cancellation"), callback=True)
        if cancelled.is_set() or time.monotonic() >= deadline:
            raise TimeoutError("MCP HTTP response deadline exceeded")
        return response


def _mcp_validate_session_id(value):
    if value == "":
        return None  # Empty HTTP fields do not assign a session.
    if value is not None and not re.fullmatch(r"[\x21-\x7e]+", value):
        raise IOError("invalid MCP session ID")
    return value


def _aggregator_http_rpc(ns: str, method: str, params: dict, timeout_s: float = 30.0, expected_info=None) -> dict:
    """JSON-RPC over HTTP (Streamable HTTP transport) to an aggregator server."""
    global _aggregator_next_id
    with aggregator_lock:
        info = aggregator_http.get(ns)
    if expected_info is not None and info is not expected_info:
        raise IOError("MCP server was replaced during request")
    if info is None:
        raise IOError(f"aggregator server '{ns}' not running")
    with aggregator_lock:
        _aggregator_next_id += 1
        req_id = _aggregator_next_id
    notification = method.startswith("notifications/")
    body = {"jsonrpc": "2.0", "method": method, "params": params}
    if not notification:
        body["id"] = req_id
    headers = _mcp_http_headers(info, method)
    data = json.dumps(body).encode("utf-8")
    try:
        req = urllib.request.Request(info["url"], data=data, headers=headers, method="POST")
        msg, new_sid = _mcp_http_exchange(req, notification, timeout_s, info.get("cancellation"),
            message_handler=None if notification else _McpHttpDispatch(info, req_id))
        result = {} if notification else _mcp_rpc_result(msg, req_id)
        version = _mcp_negotiated_version(result) if method == "initialize" else None
        sid = _mcp_validate_session_id(new_sid) if method == "initialize" else None
        with aggregator_lock:
            if shutting_down or aggregator_http.get(ns) is not info:
                raise IOError("MCP server was unloaded during request")
            if method == "initialize":
                info["session_id"] = sid
                info["protocol_version"] = version
        return result
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise IOError(f"aggregator '{ns}' http rpc failed: {e}")


def _mcp_setup_remaining(deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("MCP HTTP setup deadline exceeded")
    return remaining


def _aggregator_spawn_http(ns: str, cfg: dict) -> list[dict]:
    """Probe one http-transport aggregator server. Returns prefixed tool dicts."""
    deadline = time.monotonic() + 30.0
    with aggregator_lock:
        if shutting_down:
            raise IOError("server is shutting down")
        info = {
            "url": cfg["url"],
            "headers": cfg.get("headers") or {},
            "session_id": None,
            "cancellation": _McpHttpCancellation(),
        }
        aggregator_http[ns] = info
    try:
        _aggregator_http_rpc(ns, "initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {"roots": {}},
            "clientInfo": {"name": "code-mcp-aggregator", "version": "0.1.0"},
        }, _mcp_setup_remaining(deadline))
        _aggregator_http_rpc(ns, "notifications/initialized", {}, _mcp_setup_remaining(deadline))
        result = _mcp_discover_tools(lambda params, budget: _aggregator_http_rpc(ns, "tools/list", params, budget), deadline)
        raw_tools = result.get("tools", []) if isinstance(result, dict) else []
        prefixed = []
        for t in raw_tools:
            if not isinstance(t, dict) or not isinstance(t.get("name"), str):
                continue
            prefixed.append({
                "ns": ns,
                "tool": t["name"],
                "definition": t,
                "description": t.get("description", ""),
                "inputSchema": t.get("inputSchema", {"type": "object"}),
            })
        _mcp_setup_remaining(deadline)
        return prefixed
    except Exception:
        with aggregator_lock:
            if aggregator_http.get(ns) is info:
                aggregator_http.pop(ns, None)
        info["cancellation"].cancel()
        raise


def _aggregator_rpc(ns: str, method: str, params: dict, timeout_s=None, expected_proc=None) -> dict:
    if shutting_down:
        raise IOError("server is shutting down")
    with aggregator_lock:
        is_http = ns in aggregator_http
        proc = aggregator_processes.get(ns)
    if expected_proc is not None and proc is not expected_proc:
        raise IOError("MCP server was replaced during request")
    budget = timeout_s if timeout_s is not None else (90.0 if method == "tools/call" else 30.0)
    if is_http:
        return _aggregator_http_rpc(ns, method, params, budget)
    if proc is None or proc.poll() is not None:
        raise IOError(f"aggregator server '{ns}' not running")
    result = _mcp_stdio_exchange(proc, method, params, budget)
    with aggregator_lock:
        if aggregator_processes.get(ns) is not proc:
            raise IOError("MCP server was unloaded during request")
    return result


def _aggregator_spawn(ns: str, cfg: dict) -> list[dict]:
    """Spawn one aggregator server and probe its tools. Returns prefixed tool dicts."""
    if cfg.get("type") == "http":
        return _aggregator_spawn_http(ns, cfg)
    cmd = cfg["command"]
    args = cfg.get("args", []) or []
    extra_env = cfg.get("env") or {}
    if not isinstance(extra_env, dict):
        extra_env = {}
    if isinstance(cmd, str):
        cmd_list = [cmd] + list(args)
    else:
        cmd_list = list(cmd) + list(args)
    deadline = time.monotonic() + 30.0
    proc = _mcp_spawn_stdio(
        cmd_list,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        start_new_session=(sys.platform != "win32"),
        env=build_child_env({k: str(v) for k, v in extra_env.items()}),
    )
    _mcp_idle_register(proc, cfg.get("idleTimeoutMs", 600000))
    with aggregator_lock:
        registered = not shutting_down
        if registered:
            aggregator_processes[ns] = proc
            aggregator_io_locks[ns] = threading.Lock()
    if not registered:
        _mcp_close_stdio(proc, "MCP server shutdown")
        raise IOError("server is shutting down")
    try:
        _aggregator_rpc(ns, "initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {"roots": {}},
            "clientInfo": {"name": "code-mcp-aggregator", "version": "0.1.0"},
        }, _mcp_setup_remaining(deadline))
        _aggregator_rpc(ns, "notifications/initialized", {}, _mcp_setup_remaining(deadline))
        result = _mcp_discover_tools(lambda params, budget: _aggregator_rpc(ns, "tools/list", params, budget, proc), deadline)
        _mcp_setup_remaining(deadline)
        raw_tools = result.get("tools", []) if isinstance(result, dict) else []
        prefixed = []
        for t in raw_tools:
            if not isinstance(t, dict) or not isinstance(t.get("name"), str):
                continue
            entry = {
                "ns": ns,
                "tool": t["name"],
                "definition": t,
                "description": t.get("description", ""),
                "inputSchema": t.get("inputSchema", {"type": "object"}),
            }
            prefixed.append(entry)
        return prefixed
    except Exception:
        with aggregator_lock:
            p = proc
            if aggregator_processes.get(ns) is proc:
                aggregator_processes.pop(ns, None)
                aggregator_io_locks.pop(ns, None)
        if p is not None:
            _mcp_close_stdio(p, "MCP initialization failed")
        raise
    finally:
        _mcp_idle_release(proc)


def load_aggregator(config_path: str) -> None:
    """Parse --mcp config and probe all servers in parallel. Called once at boot."""
    try:
        cfg = _mcp_read_config(Path(config_path).resolve(strict=True))
    except FileNotFoundError:
        print(f"[mcp] config not found: {config_path}", file=sys.stderr)
        return
    except Exception as e:
        print(f"[mcp] failed to parse {config_path}: {e}", file=sys.stderr)
        return
    servers = cfg.get("mcpServers") or {}
    if not isinstance(servers, dict) or not servers:
        print(f"[mcp] {config_path} has no 'mcpServers' object; aggregation disabled", file=sys.stderr)
        return
    valid: list[tuple[str, dict]] = []
    for ns, scfg in servers.items():
        err = _aggregator_validate(ns, scfg or {})
        if err:
            print(f"[mcp] skipping '{ns}': {err}", file=sys.stderr)
            continue
        valid.append((ns, scfg))
        with aggregator_lock:
            aggregator_known.add(ns)
            if scfg.get("type") == "http":
                aggregator_http_configs[ns] = scfg
            else:
                aggregator_stdio_configs[ns] = scfg
    if not valid:
        return
    ambiguous_names: set[str] = set()
    # Parallel probe so boot time is bounded by the slowest server.
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(8, len(valid))) as pool:
        try:
            futures = {pool.submit(_aggregator_spawn, ns, scfg): (ns, scfg) for ns, scfg in valid}
            for fut in concurrent.futures.as_completed(futures):
                ns, scfg = futures[fut]
                try:
                    entries = fut.result()
                except Exception as e:
                    print(f"[mcp] probe '{ns}' failed: {e}", file=sys.stderr)
                    continue
                with aggregator_lock:
                    for entry in entries:
                        prefixed_name = f"{ns}__{entry['tool']}"
                        if prefixed_name in disallowed_tools or prefixed_name in ambiguous_names:
                            continue
                        if prefixed_name in aggregator_tools:
                            del aggregator_tools[prefixed_name]
                            ambiguous_names.add(prefixed_name)
                            print(f"[mcp] ambiguous tool {json.dumps(prefixed_name)} disabled; rename namespaces or upstream tools", file=sys.stderr)
                        else:
                            aggregator_tools[prefixed_name] = entry
                        invalidate_tools_list()
                transport = "http" if scfg.get("type") == "http" else "stdio"
                print(f"[mcp] probed '{ns}' ({transport}): {len(entries)} tool(s) discovered", file=sys.stderr)
        except BaseException:
            # Unwind namespace locks before cleanup, and cancel owned RPCs
            # before the executor context waits for its startup workers.
            _shutdown_owned_resources()
            raise


def shutdown_aggregator() -> None:
    with aggregator_lock:
        procs = list(aggregator_processes.items())
        setups = list(aggregator_stdio_setups.values()) + list(aggregator_http_setups.values())
        aggregator_http_setups.clear()
        aggregator_http_configs.clear()
        aggregator_stdio_setups.clear()
        aggregator_stdio_configs.clear()
        aggregator_processes.clear()
        aggregator_io_locks.clear()
        http_connections = list(aggregator_http.values())
        aggregator_http.clear()
    for setup in setups:
        with aggregator_lock:
            if not setup.done():
                setup.set_exception(IOError("MCP server shutdown"))
    for info in http_connections:
        cancellation = info.get("cancellation")
        if cancellation is not None:
            cancellation.cancel()
    for ns, p in procs:
        _mcp_close_stdio(p, "MCP server shutdown")


def _ensure_aggregated_http(ns):
    # A new user call can replace an expired session; failed work is never replayed.
    with aggregator_lock:
        if shutting_down:
            raise IOError("server is shutting down")
        cfg = aggregator_http_configs.get(ns)
        if cfg is None:
            return None
        setup = aggregator_http_setups.get(ns)
        info = aggregator_http.get(ns)
        if setup is None and info is not None:
            return info
        owner = setup is None
        if owner:
            setup = concurrent.futures.Future()
            aggregator_http_setups[ns] = setup
    if owner:
        try:
            _aggregator_spawn_http(ns, cfg)
            with aggregator_lock:
                if shutting_down or aggregator_http_setups.get(ns) is not setup:
                    raise IOError("MCP server shutdown during initialization")
                info = aggregator_http.get(ns)
                if info is None:
                    raise IOError("MCP server was unloaded during initialization")
                setup.set_result(info)
        except Exception as error:
            with aggregator_lock:
                if not setup.done():
                    setup.set_exception(error)
        finally:
            with aggregator_lock:
                if aggregator_http_setups.get(ns) is setup:
                    aggregator_http_setups.pop(ns, None)
    info = setup.result(timeout=30.0)
    with aggregator_lock:
        if shutting_down or aggregator_http.get(ns) is not info:
            raise IOError("MCP server was replaced during initialization")
    return info


def _ensure_aggregated_stdio(ns):
    # Reconnect only before a new user call; never replay a failed tools/call.
    with aggregator_lock:
        if shutting_down:
            raise IOError("server is shutting down")
        cfg = aggregator_stdio_configs.get(ns)
        if cfg is None:
            return None
        setup = aggregator_stdio_setups.get(ns)
        proc = aggregator_processes.get(ns)
        connection = getattr(proc, "_mcp_connection", None)
        if setup is None and proc is not None and proc.poll() is None and not _mcp_idle_retired(proc) and connection is not None and not connection.closed.is_set():
            return proc
        owner = setup is None
        if owner:
            setup = concurrent.futures.Future()
            aggregator_stdio_setups[ns] = setup
    if owner:
        try:
            _aggregator_spawn(ns, cfg)
            with aggregator_lock:
                if shutting_down or aggregator_stdio_setups.get(ns) is not setup:
                    raise IOError("MCP server shutdown during initialization")
                setup.set_result(aggregator_processes.get(ns))
        except Exception as error:
            with aggregator_lock:
                if not setup.done():
                    setup.set_exception(error)
        finally:
            with aggregator_lock:
                if aggregator_stdio_setups.get(ns) is setup:
                    aggregator_stdio_setups.pop(ns, None)
    proc = setup.result(timeout=30.0)
    with aggregator_lock:
        if shutting_down:
            raise IOError("server is shutting down")
    if proc is None:
        raise IOError("MCP server was unloaded during initialization")
    return proc


def call_aggregated_raw(prefixed_name: str, args: dict):
    """Return the raw result dict from the upstream MCP server (with content blocks)."""
    if not isinstance(args, dict):
        raise ValueError("arguments must be an object")
    with aggregator_lock:
        info = aggregator_tools.get(prefixed_name)
    if info is None:
        raise ValueError(f"unknown aggregated tool: {prefixed_name}")
    http = _ensure_aggregated_http(info["ns"])
    if http is not None:
        return _mcp_validate_tool_result(_aggregator_http_rpc(info["ns"], "tools/call", {"name": info["tool"], "arguments": args or {}}, 90.0, http))
    deadline = time.monotonic() + 30.0
    while True:
        proc = _ensure_aggregated_stdio(info["ns"])
        if _mcp_idle_acquire(proc):
            break
        if time.monotonic() >= deadline:
            raise TimeoutError("MCP server idle retirement raced initialization")
    try:
        return _mcp_validate_tool_result(_aggregator_rpc(info["ns"], "tools/call", {"name": info["tool"], "arguments": args or {}}, expected_proc=proc))
    finally:
        _mcp_idle_release(proc)


MAX_MCP_CONFIG_BYTES = 16 * 1024 * 1024


def _mcp_read_config(path):
    before = os.stat(path, follow_symlinks=False)
    if not stat.S_ISREG(before.st_mode):
        raise ValueError("MCP config must be a regular file")
    if before.st_size > MAX_MCP_CONFIG_BYTES:
        raise ValueError("MCP config exceeds 16 MiB limit")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    try:
        def matches(value):
            # The shared identity helper handles Windows stat/fstat ctime differences.
            return stat.S_ISREG(value.st_mode) and _write_identity(value) == _write_identity(before)
        initial = os.fstat(descriptor)
        if not matches(initial):
            raise ValueError("MCP config changed during read")
        chunks, used = [], 0
        while used <= initial.st_size:
            chunk = os.read(descriptor, min(64 * 1024, initial.st_size + 1 - used))
            if not chunk:
                break
            chunks.append(chunk)
            used += len(chunk)
        if used != initial.st_size or not matches(os.fstat(descriptor)) or not matches(os.stat(path, follow_symlinks=False)):
            raise ValueError("MCP config changed during read")
        return _mcp_parse_json(b"".join(chunks).decode("utf-8-sig", errors="strict"))
    finally:
        os.close(descriptor)


def _mcp_load_servers(path):
    config = _mcp_read_config(path)
    if not isinstance(config, dict) or not isinstance(config.get("mcpServers"), dict):
        raise ValueError(".mcp.json must contain an mcpServers object")
    servers = config["mcpServers"]
    for name, value in servers.items():
        try:
            _mcp_validate_server(value)
        except (ValueError, TypeError, UnicodeError) as error:
            raise ValueError(f"server '{name}': {error}") from error
    return servers


def _mcp_validate_tool_result(result):
    def invalid(field):
        raise ValueError("tools/call returned invalid " + field)
    def metadata(value):
        for field in ("annotations", "_meta"):
            if field in value and not isinstance(value[field], dict):
                invalid(field)
    def strings(value, fields):
        for field in fields:
            if not isinstance(value.get(field), str):
                invalid(field)
    if not isinstance(result, dict) or not isinstance(result.get("content"), list):
        invalid("content")
    if "isError" in result and not isinstance(result["isError"], bool):
        invalid("isError")
    for field in ("structuredContent", "_meta"):
        if field in result and not isinstance(result[field], dict):
            invalid(field)
    for block in result["content"]:
        if not isinstance(block, dict) or not isinstance(block.get("type"), str) or not block["type"]:
            invalid("content block")
        metadata(block)
        kind = block["type"]
        if kind == "text":
            strings(block, ("text",))
        elif kind in ("image", "audio"):
            strings(block, ("data", "mimeType"))
        elif kind == "resource_link":
            strings(block, ("uri", "name"))
            for field in ("mimeType", "title", "description"):
                if field in block:
                    strings(block, (field,))
        elif kind == "resource":
            resource = block.get("resource")
            if not isinstance(resource, dict):
                invalid("resource")
            strings(resource, ("uri",))
            metadata(resource)
            if "text" not in resource and "blob" not in resource:
                invalid("resource content")
            for field in ("text", "blob", "mimeType"):
                if field in resource:
                    strings(resource, (field,))
        # Unknown extension types are forwarded without dropping their payload.
    return result


def _mcp_validate_tool_definition(tool):
    # Validate proxy-facing field types, not every JSON Schema keyword.
    def invalid(field):
        raise ValueError("tools/list returned invalid " + field)
    for field in ("inputSchema", "outputSchema"):
        if field not in tool:
            continue
        schema = tool[field]
        if not isinstance(schema, dict):
            invalid(field)
        if "type" in schema and schema["type"] != "object":
            invalid(field + ".type")
        if "$schema" in schema and not isinstance(schema["$schema"], str):
            invalid(field + ".$schema")
        if "properties" in schema and not isinstance(schema["properties"], dict):
            invalid(field + ".properties")
        if "required" in schema and (not isinstance(schema["required"], list) or any(not isinstance(value, str) for value in schema["required"])):
            invalid(field + ".required")
    for field in ("description", "title"):
        if field in tool and not isinstance(tool[field], str):
            invalid(field)
    for field in ("annotations", "_meta", "execution"):
        if field in tool and not isinstance(tool[field], dict):
            invalid(field)
    annotations = tool.get("annotations", {})
    for field in ("readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"):
        if field in annotations and not isinstance(annotations[field], bool):
            invalid("annotations." + field)
    if "title" in annotations and not isinstance(annotations["title"], str):
        invalid("annotations.title")
    if "icons" in tool:
        if not isinstance(tool["icons"], list):
            invalid("icons")
        for icon in tool["icons"]:
            if not isinstance(icon, dict) or not isinstance(icon.get("src"), str):
                invalid("icons.src")
            for field in ("mimeType", "theme"):
                if field in icon and not isinstance(icon[field], str):
                    invalid("icons." + field)
            if "sizes" in icon and (not isinstance(icon["sizes"], list) or any(not isinstance(value, str) for value in icon["sizes"])):
                invalid("icons.sizes")


def _mcp_discover_tools(fetch_page, deadline=None):
    deadline = time.monotonic() + 30.0 if deadline is None else deadline
    tools, names, cursors = [], set(), set()
    params, size = {}, 0
    for page_number in range(256):
        page = fetch_page(params, _mcp_setup_remaining(deadline))
        if not isinstance(page, dict) or not isinstance(page.get("tools"), list):
            raise ValueError("tools/list response must contain a tools array")
        more = "nextCursor" in page
        if page_number or more:
            size += len(json.dumps(page, ensure_ascii=False, separators=(",", ":")).encode("utf-8", errors="backslashreplace"))
            if size > 16 * 1024 * 1024:
                raise ValueError("MCP discovery exceeds 16 MiB limit")
        for tool in page["tools"]:
            if not isinstance(tool, dict) or not isinstance(tool.get("name"), str) or not tool["name"]:
                raise ValueError("tools/list returned an invalid tool")
            _mcp_validate_tool_definition(tool)
            if tool["name"] in names:
                raise ValueError("tools/list contains duplicate tool names")
            names.add(tool["name"])
            tools.append(tool)
        _mcp_setup_remaining(deadline)
        if not more:
            return {"tools": tools}
        cursor = page["nextCursor"]
        if not isinstance(cursor, str):
            raise ValueError("tools/list nextCursor must be a string")
        if cursor in cursors:
            raise ValueError("tools/list repeated a pagination cursor")
        cursors.add(cursor)
        params = {"cursor": cursor}
    raise ValueError("MCP discovery exceeds 256 pages")


def _mcp_listed_tools(key, server, result, expected_info=None, expected_proc=None, idle_timeout_ms=600000):
    tools = result.get("tools")
    if not isinstance(tools, list):
        raise ValueError("tools/list response must contain a tools array")
    normalized = []
    for tool in tools:
        if not isinstance(tool, dict) or not isinstance(tool.get("name"), str) or not tool["name"]:
            raise ValueError("tools/list returned an invalid tool")
        normalized.append({**tool, "description": tool.get("description", ""),
                           "inputSchema": tool.get("inputSchema", {"type": "object"})})
    with mcp_lock:
        if expected_info is not None and mcp_http.get(key) is not expected_info:
            raise IOError("MCP server was unloaded during discovery")
        if expected_proc is not None and mcp_processes.get(key) is not expected_proc:
            raise IOError("MCP server was unloaded during discovery")
        signature = (expected_info.get("config_signature") if expected_info is not None else
                     getattr(expected_proc, "_mcp_config_signature", None))
        mcp_servers[key] = {"tools": [tool["name"] for tool in normalized], "config_signature": signature}
    return json_utf8({"server": server, "status": "loaded", "tools": normalized, "idleTimeoutMs": idle_timeout_ms}).decode("utf-8")


def _mcp_cache_key(cwd, config_path, server):
    return json.dumps([cwd, str(config_path), server], ensure_ascii=False, separators=(",", ":"))


def _mcp_cache_prefix(cwd):
    return "[" + json.dumps(cwd, ensure_ascii=False) + ","


def _mcp_check_capacity(cwd, key):
    # Caller holds mcp_lock through registration, including in-progress setup.
    keys = mcp_processes.keys() | mcp_http.keys()
    if key in keys:
        return
    if sum(candidate.startswith(_mcp_cache_prefix(cwd)) for candidate in keys) >= 10:
        raise IOError(f"max servers per cwd (10) exceeded for {cwd}")
    if len(keys) >= 50:
        raise IOError("max total cached servers (50) exceeded")


def _mcp_config_signature(cfg):
    def pairs(value, insensitive):
        # Stable ordering retains precedence when differently cased keys collide.
        return sorted((value or {}).items(), key=lambda item: item[0].lower() if insensitive else item[0])
    effective = (["http", cfg["url"], pairs(cfg.get("headers"), True)] if cfg.get("type") == "http" else
                 ["stdio", cfg["command"], cfg.get("args", []), pairs(cfg.get("env"), os.name == "nt"), int(cfg.get("idleTimeoutMs", 600000))])
    return hashlib.sha256(json.dumps(effective, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def _reconcile_mcp_config(cwd, path, servers):
    signatures = {name: _mcp_config_signature(cfg) for name, cfg in servers.items()}
    procs, http = [], []
    prefix = _mcp_cache_prefix(cwd)
    with mcp_lock:
        for key, proc in list(mcp_processes.items()):
            if not key.startswith(prefix):
                continue
            _, config_path, ns = json.loads(key)
            if config_path == str(path) and (ns not in signatures or getattr(proc, "_mcp_config_signature", None) != signatures[ns]):
                mcp_processes.pop(key, None)
                mcp_servers.pop(key, None)
                procs.append(proc)
        for key, info in list(mcp_http.items()):
            if not key.startswith(prefix):
                continue
            _, config_path, ns = json.loads(key)
            if config_path == str(path) and (ns not in signatures or info.get("config_signature") != signatures[ns]):
                mcp_http.pop(key, None)
                mcp_servers.pop(key, None)
                http.append(info)
    for info in http:
        info["setup_error"] = "MCP configuration changed"
        info["setup_done"].set()
        info["cancellation"].cancel()
    for proc in procs:
        proc._mcp_setup_error = "MCP configuration changed"
        proc._mcp_setup_done.set()
        _mcp_close_stdio(proc, "MCP configuration changed")
    return signatures


def handle_mcp(action: str, server: str, tool: str, args: dict, mcp_config_path: str, cwd: str = ".") -> str:
    """Handle mcp tool actions: list, call, unload."""
    if shutting_down:
        return json.dumps({"error": "server is shutting down"})
    if action in ("list", "call") and server and not NAMESPACE_RE.fullmatch(server):
        return json.dumps({"error": "invalid server namespace"})
    config_path = mcp_config_path or ".mcp.json"

    # The agent-supplied config path must stay inside the cwd sandbox (parity
    # with TS): an absolute path or ../ escape is refused, not silently read.
    try:
        cwd_resolved = Path(cwd).resolve()
        config_full_path = (Path(cwd) / config_path).resolve()
        if not str(config_full_path).startswith(str(cwd_resolved) + os.sep):
            return json.dumps({"error": f"config path escapes cwd: {config_path}"}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"error": f"invalid config path: {e}"}, ensure_ascii=False)

    if action == "list" and not server:
        try:
            servers = _mcp_load_servers(config_full_path)
            signatures = _reconcile_mcp_config(cwd, config_full_path, servers)
            result = []
            with mcp_lock:
                loaded_snapshot = {k: dict(v) for k, v in mcp_servers.items()
                                   if k in mcp_http or (k in mcp_processes
                                       and mcp_processes[k].poll() is None
                                       and not _mcp_idle_retired(mcp_processes[k])
                                       and mcp_processes[k]._mcp_setup_done.is_set()
                                       and not mcp_processes[k]._mcp_setup_error
                                       and not (getattr(mcp_processes[k], "_mcp_connection", None) is not None
                                                and mcp_processes[k]._mcp_connection.closed.is_set()))}
            for name in servers:
                key = _mcp_cache_key(cwd, config_full_path, name)
                is_loaded = key in loaded_snapshot and loaded_snapshot[key].get("config_signature") == signatures[name]
                result.append({
                    "name": name,
                    "status": "loaded" if is_loaded else "unloaded",
                    "tools": loaded_snapshot.get(key, {}).get("tools", []) if is_loaded else [],
                    "idleTimeoutMs": servers[name].get("idleTimeoutMs", 600000),
                })
            return json.dumps({"servers": result, "mcpConfigPath": config_path}, ensure_ascii=False)
        except Exception as e:
            return json.dumps({"error": str(e)}, ensure_ascii=False)

    if action in ("call", "list"):
        if not server:
            return json.dumps({"error": "server name required for call action"}, ensure_ascii=False)
        if action == "call" and not tool:
            return json.dumps({"error": "tool name required for call action"}, ensure_ascii=False)

        try:
            servers = _mcp_load_servers(config_full_path)
            signatures = _reconcile_mcp_config(cwd, config_full_path, servers)
            if server not in servers:
                return json.dumps({"error": f"server '{server}' not found in .mcp.json"}, ensure_ascii=False)
            server_config = servers[server]

            key = _mcp_cache_key(cwd, config_full_path, server)
            signature = signatures[server]

            # Publish one in-progress initialization per key; other callers wait
            # for discovery rather than using a half-initialized HTTP session.
            if server_config.get("type") == "http":
                with mcp_lock:
                    info = mcp_http.get(key)
                    if key in mcp_processes or (info is not None and info.get("config_signature") != signature):
                        raise IOError("MCP configuration changed during request")
                    needs_init = info is None
                    if needs_init:
                        _mcp_check_capacity(cwd, key)
                        info = {
                            "config_signature": signature,
                            "url": server_config["url"],
                            "headers": server_config.get("headers") or {},
                            "session_id": None,
                            "setup_done": threading.Event(),
                            "cancellation": _McpHttpCancellation(),
                            "setup_deadline": time.monotonic() + 30.0,
                            "setup_error": None,
                        }
                        mcp_http[key] = info
                try:
                    tools_result = None
                    if needs_init:
                        deadline = info["setup_deadline"]
                        try:
                            mcp_http_call(key, "initialize", {
                                "protocolVersion": "2024-11-05",
                                "capabilities": {"roots": {}},
                                "clientInfo": {"name": "code-mcp-aggregator", "version": "0.1.0"},
                            }, _mcp_setup_remaining(deadline), info)
                            mcp_http_call(key, "notifications/initialized", {}, _mcp_setup_remaining(deadline), info)
                            tools_result = _mcp_discover_tools(lambda params, budget: mcp_http_call(key, "tools/list", params, budget, info), deadline)
                            _mcp_setup_remaining(deadline)
                            _mcp_listed_tools(key, server, tools_result, info)
                        except Exception as error:
                            with mcp_lock:
                                info["setup_error"] = str(error)
                                if mcp_http.get(key) is info:
                                    mcp_http.pop(key, None)
                                    mcp_servers.pop(key, None)
                            raise
                        finally:
                            info["setup_done"].set()
                    elif not info["setup_done"].is_set():
                        if not info["setup_done"].wait(_mcp_setup_remaining(info["setup_deadline"])):
                            raise TimeoutError("MCP HTTP setup deadline exceeded")
                    if info["setup_error"]:
                        raise IOError(info["setup_error"])
                    with mcp_lock:
                        if mcp_http.get(key) is not info:
                            raise IOError("MCP server was unloaded during initialization")
                    if action == "list":
                        if tools_result is None:
                            tools_result = _mcp_discover_tools(lambda params, budget: mcp_http_call(key, "tools/list", params, budget, info))
                        return _mcp_listed_tools(key, server, tools_result, info, idle_timeout_ms=server_config.get("idleTimeoutMs", 600000))
                    result = mcp_http_call(key, "tools/call", {"name": tool, "arguments": args or {}}, expected_info=info)
                    return json_utf8(_mcp_validate_tool_result(result)).decode("utf-8")
                except Exception as error:
                    return json.dumps({"error": str(error)}, ensure_ascii=False)

            # Publish a single in-progress generation. Never hold the global
            # registry lock over pipe I/O or wait on another server's handshake.
            with mcp_lock:
                if shutting_down:
                    raise IOError("server is shutting down")
                proc = mcp_processes.get(key)
                if key in mcp_http or (proc is not None and getattr(proc, "_mcp_config_signature", None) != signature):
                    raise IOError("MCP configuration changed during request")
                needs_spawn = (proc is None or proc.poll() is not None
                               or (getattr(proc, "_mcp_connection", None) is not None
                                   and proc._mcp_connection.closed.is_set()))
                if not needs_spawn and not _mcp_idle_acquire(proc):
                    needs_spawn = True
                if needs_spawn:
                    _mcp_check_capacity(cwd, key)
                    proc = _mcp_spawn_stdio(
                        [server_config["command"], *server_config.get("args", [])],
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                        stderr=subprocess.DEVNULL, cwd=cwd,
                        start_new_session=(sys.platform != "win32"),
                        env=build_child_env(server_config.get("env", {})),
                    )
                    _mcp_idle_register(proc, server_config.get("idleTimeoutMs", 600000))
                    proc._mcp_config_signature = signature
                    proc._mcp_setup_done = threading.Event()
                    proc._mcp_setup_deadline = time.monotonic() + 30.0
                    proc._mcp_setup_error = None
                    mcp_processes[key] = proc
            try:
                tools_result = None
                if needs_spawn:
                    try:
                        deadline = proc._mcp_setup_deadline
                        mcp_call(key, "initialize", {
                            "protocolVersion": "2024-11-05", "capabilities": {"roots": {}},
                            "clientInfo": {"name": "code-mcp-aggregator", "version": "0.1.0"},
                        }, _mcp_setup_remaining(deadline), proc)
                        mcp_call(key, "notifications/initialized", {}, _mcp_setup_remaining(deadline), proc)
                        tools_result = _mcp_discover_tools(lambda params, budget: mcp_call(key, "tools/list", params, budget, proc), deadline)
                        _mcp_setup_remaining(deadline)
                        _mcp_listed_tools(key, server, tools_result, expected_proc=proc)
                    except Exception as error:
                        proc._mcp_setup_error = str(error)
                        with mcp_lock:
                            if mcp_processes.get(key) is proc:
                                mcp_processes.pop(key, None)
                                mcp_servers.pop(key, None)
                        _mcp_close_stdio(proc, "MCP initialization failed")
                        raise
                    finally:
                        proc._mcp_setup_done.set()
                elif not proc._mcp_setup_done.is_set():
                    if not proc._mcp_setup_done.wait(_mcp_setup_remaining(proc._mcp_setup_deadline)):
                        raise TimeoutError("MCP setup deadline exceeded")
                if proc._mcp_setup_error:
                    raise IOError(proc._mcp_setup_error)
                if action == "list":
                    if tools_result is None:
                        tools_result = _mcp_discover_tools(lambda params, budget: mcp_call(key, "tools/list", params, budget, proc))
                    return _mcp_listed_tools(key, server, tools_result, expected_proc=proc, idle_timeout_ms=server_config.get("idleTimeoutMs", 600000))
                result = mcp_call(key, "tools/call", {"name": tool, "arguments": args or {}}, expected_proc=proc)
                return json_utf8(_mcp_validate_tool_result(result)).decode("utf-8")
            finally:
                _mcp_idle_release(proc)
        except Exception as e:
            return json.dumps({"error": str(e)}, ensure_ascii=False)

    if action == "unload":
        http_to_cancel = []
        with mcp_lock:
            if server:
                key = _mcp_cache_key(cwd, config_full_path, server)
                proc = mcp_processes.pop(key, None)
                info = mcp_http.pop(key, None)
                if info is not None:
                    http_to_cancel.append(info)
                mcp_servers.pop(key, None)
                to_terminate = [proc] if proc else []
            else:
                keys = [k for k in list(mcp_processes.keys()) if k.startswith(_mcp_cache_prefix(cwd))]
                to_terminate = [mcp_processes.pop(k) for k in keys]
                for k in keys:
                    mcp_servers.pop(k, None)
                for k in [k for k in list(mcp_http.keys()) if k.startswith(_mcp_cache_prefix(cwd))]:
                    info = mcp_http.pop(k, None)
                    if info is not None:
                        http_to_cancel.append(info)
                for k in [k for k in list(mcp_servers.keys()) if k.startswith(_mcp_cache_prefix(cwd))]:
                    mcp_servers.pop(k, None)
        for info in http_to_cancel:
            info["setup_error"] = "MCP server was unloaded"
            info["setup_done"].set()
            info["cancellation"].cancel()
        for p in to_terminate:
            p._mcp_setup_error = "MCP server was unloaded"
            p._mcp_setup_done.set()
            _mcp_close_stdio(p)
        return json.dumps({"success": True}, ensure_ascii=False)

    return json.dumps({"error": f"unknown action: {action}"}, ensure_ascii=False)


def mcp_http_call(key: str, method: str, params: dict, timeout_s=None, expected_info=None) -> dict:
    """Make a JSON-RPC call to an MCP server over HTTP (Streamable HTTP)."""
    global mcp_next_id
    with mcp_lock:
        info = mcp_http.get(key)
    if expected_info is not None and info is not expected_info:
        raise IOError("MCP server was unloaded during request")
    if info is None:
        raise IOError(f"MCP server '{key}' not running")
    with mcp_lock:
        mcp_next_id += 1
        req_id = mcp_next_id
    notification = method.startswith("notifications/")
    body = {"jsonrpc": "2.0", "method": method, "params": params}
    if not notification:
        body["id"] = req_id
    headers = _mcp_http_headers(info, method)
    data = json.dumps(body).encode("utf-8")
    try:
        req = urllib.request.Request(info["url"], data=data, headers=headers, method="POST")
        msg, new_sid = _mcp_http_exchange(req, notification, timeout_s if timeout_s is not None else (90.0 if method == "tools/call" else 30.0), info.get("cancellation"),
            message_handler=None if notification else _McpHttpDispatch(info, req_id))
        result = {} if notification else _mcp_rpc_result(msg, req_id)
        version = _mcp_negotiated_version(result) if method == "initialize" else None
        sid = _mcp_validate_session_id(new_sid) if method == "initialize" else None
        with mcp_lock:
            if mcp_http.get(key) is not info:
                raise IOError("MCP server was unloaded during request")
            if method == "initialize":
                info["session_id"] = sid
                info["protocol_version"] = version
        return result
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise IOError(f"http rpc failed: {e}")


def mcp_call(key: str, method: str, params: dict, timeout_s=None, expected_proc=None) -> dict:
    with mcp_lock:
        proc = mcp_processes.get(key)
    if proc is None or (expected_proc is not None and proc is not expected_proc):
        raise IOError("MCP server was unloaded during request")
    try:
        result = _mcp_stdio_exchange(proc, method, params, timeout_s)
    except Exception:
        if proc.poll() is not None or (getattr(proc, "_mcp_connection", None) is not None and proc._mcp_connection.closed.is_set()):
            with mcp_lock:
                if mcp_processes.get(key) is proc:
                    mcp_processes.pop(key, None)
                    mcp_servers.pop(key, None)
        raise
    with mcp_lock:
        if mcp_processes.get(key) is not proc:
            raise IOError("MCP server was unloaded during request")
    return result


def _shutdown_owned_resources():
    global shutting_down
    # Run only after interrupted main-thread frames have released their locks.
    # Adopted/explicit jobs share bounded tree termination and capture cleanup.
    with jobs_lock:
        shutting_down = True
        job_ids = list(jobs)
    shutdown_aggregator()
    _mcp_shutdown_stdio()
    failed = False
    for job_id in job_ids:
        result = stop_job(job_id)
        if isinstance(result, ToolFailure):
            failed = True
            print(result, file=sys.stderr)
    with mcp_lock:
        _procs = list(mcp_processes.values())
        http_connections = list(mcp_http.values())
        mcp_http.clear()
    for info in http_connections:
        info["cancellation"].cancel()
        info["setup_error"] = "MCP server shutdown"
        info["setup_done"].set()
    for _p in _procs:
        _mcp_close_stdio(_p, "MCP server shutdown")
    return failed


_shutdown_signal_received = False


def signal_handler(sig, frame):
    global shutting_down, _shutdown_signal_received
    if _shutdown_signal_received:
        return
    _shutdown_signal_received = True
    shutting_down = True
    # A signal can interrupt code holding any Python lock. Do not acquire locks
    # or stop processes here; main/load_aggregator clean up after stack unwind.
    # Keep an explicit programmatic call (no interrupted frame) synchronous.
    if frame is None:
        sys.exit(1 if _shutdown_owned_resources() else 0)
    raise SystemExit(0)


def main():
    try:
        _run_main()
    finally:
        if _shutdown_owned_resources():
            raise SystemExit(1)


def _start_public_tunnel(listen_port):
    global _public_tunnel_state
    state = None
    try:
        host = "127.0.0.1" if bind_addr == "0.0.0.0" else "::1" if bind_addr == "::" else bind_addr
        authority = f"[{host}]" if ":" in host and not host.startswith("[") else host
        result = handle_preview(f"http://{authority}:{listen_port}")
        match = re.fullmatch(r"(https://[a-z0-9-]+\.trycloudflare\.com) \(job ([^)]+)\)", result, re.IGNORECASE)
        if not match:
            raise RuntimeError("invalid public tunnel result")
        with jobs_lock:
            job = jobs.get(match[2])
        if job is None or job["proc"].poll() is not None:
            raise RuntimeError("public tunnel exited before ready")
        state = (match[1], job)
        _public_tunnel_state = state
        print(f"public URL: {state[0]}/mcp", file=sys.stderr)
        job["proc"].wait()
    except Exception as error:
        print(f"warning: public tunnel unavailable: {error}", file=sys.stderr)
    finally:
        if state is not None and _public_tunnel_state is state:
            _public_tunnel_state = None


def _run_main():
    global port, token, gateway_domain, assigned_device_id

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    port, token, gateway_domain, assigned_device_id = parse_args(sys.argv[1:])

    if mcp_config_path:
        # Relative paths resolve against process cwd at open time; no need to
        # explicitly prepend Path.cwd() here.
        load_aggregator(mcp_config_path)

    if gateway_domain:
        gw_cred = gateway_token if gateway_token is not None else token
        t = threading.Thread(target=start_gateway_client, args=(gateway_domain, assigned_device_id, gw_cred), daemon=True)
        t.start()

    server = ThreadingHTTPServer((bind_addr, port), MCPRequestHandler)
    if make_public:
        threading.Thread(target=_start_public_tunnel, args=(server.server_port,), daemon=True).start()
    bind_label = bind_addr if bind_addr not in ("0.0.0.0", "::") else "localhost"
    print(f"code-mcp listening on http://{bind_label}:{port}/mcp"
          f"{' (auth)' if token else ' (no auth)'}", file=sys.stderr)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()

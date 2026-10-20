"""code-mcp's gateway tunnel on restricted networks (TypeScript implementation).

Run with: python3 -m unittest discover -s tests -v   (needs bun on PATH)

A tiny CONNECT proxy stands in for a corporate proxy. code-mcp is pointed at a
gateway host that is never actually reached; what matters is the route the
tunnel takes and what code-mcp says when the TLS handshake fails.
"""
import os
from pathlib import Path
import shutil
import socket
import subprocess
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
BUN = shutil.which("bun")


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class ConnectProxy:
    """Records CONNECT requests, then answers 200 and sends bytes that are not TLS."""

    def __init__(self):
        self.seen = []
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(8)
        self.port = self.sock.getsockname()[1]
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            threading.Thread(target=self._handle, args=(conn,), daemon=True).start()

    def _handle(self, conn):
        try:
            data = conn.recv(4096).decode("latin-1")
            self.seen.append(data.split("\r\n", 1)[0])
            if data.startswith("CONNECT "):
                conn.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                conn.recv(4096)  # the client's TLS ClientHello
                conn.sendall(b"this is not a TLS server\r\n")
            time.sleep(0.2)
        except OSError:
            pass
        finally:
            conn.close()

    def close(self):
        self.sock.close()


@unittest.skipUnless(BUN, "bun is needed for the TypeScript implementation")
class GatewayNetworkTests(unittest.TestCase):
    def run_code_mcp(self, env_extra, seconds=6):
        env = {k: v for k, v in os.environ.items() if "proxy" not in k.lower()}
        env.update(env_extra)
        proc = subprocess.Popen(
            [BUN, str(ROOT / "code-mcp.ts"), "--gateway", "wss://gateway.example.test", "--id", "net-test",
             "--gateway-token", "tok", "--port", str(free_port()), "--bind", "127.0.0.1"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, text=True, encoding="utf-8")
        time.sleep(seconds)
        proc.kill()
        out, err = proc.communicate(timeout=10)
        return out + err

    def setUp(self):
        self.proxy = ConnectProxy()
        self.addCleanup(self.proxy.close)
        self.url = "http://user:s3cret@127.0.0.1:%d" % self.proxy.port

    def test_tunnel_goes_through_https_proxy(self):
        log = self.run_code_mcp({"HTTPS_PROXY": self.url})
        self.assertIn("CONNECT gateway.example.test:443 HTTP/1.1", self.proxy.seen, log)
        self.assertIn("Using proxy", log)
        # The proxy's credentials never reach a log.
        self.assertNotIn("s3cret", log)

    def test_lowercase_variable_works_too(self):
        self.run_code_mcp({"https_proxy": self.url})
        self.assertTrue(any(line.startswith("CONNECT gateway.example.test:443") for line in self.proxy.seen))

    def test_no_proxy_bypasses_it(self):
        for no_proxy in ("gateway.example.test", ".example.test", "example.test", "*", "gateway.example.test:443"):
            with self.subTest(no_proxy=no_proxy):
                self.proxy.seen.clear()
                log = self.run_code_mcp({"HTTPS_PROXY": self.url, "NO_PROXY": no_proxy}, seconds=3)
                self.assertEqual(self.proxy.seen, [], log)
                self.assertNotIn("Using proxy", log)

    def test_tls_failure_gets_a_tls_hint_not_a_401_hint(self):
        log = self.run_code_mcp({"HTTPS_PROXY": self.url})
        self.assertIn("TLS handshake failed", log)
        self.assertIn("NODE_EXTRA_CA_CERTS", log)
        self.assertNotIn("likely 401", log)


if __name__ == "__main__":
    unittest.main()

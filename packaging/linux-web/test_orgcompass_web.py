"""Unit tests for the install-adjunct script. Never binds 4173 or kills unrelated PIDs."""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
import unittest

SCRIPT = Path(__file__).resolve().parent / "orgcompass-web.py"
PY = sys.executable


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        port = int(sock.getsockname()[1])
    if port == 4173:
        return free_port()
    return port


def http_get(url: str) -> tuple[int, str, bytes]:
    try:
        with urllib.request.urlopen(url, timeout=2) as resp:
            return resp.status, resp.headers.get_content_type(), resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.headers.get_content_type() if exc.headers else "", exc.read()


class OrgcompassWebTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(self._tmp())
        self.root = self.tmp / "root"
        self.dist = self.root / "dist"
        self.dist.mkdir(parents=True)
        (self.dist / "index.html").write_text("<!doctype html><title>t</title>ok\n", encoding="utf-8")
        (self.dist / "app.js").write_text("console.log(1)\n", encoding="utf-8")
        (self.dist / "app.css").write_text("body{color:red}\n", encoding="utf-8")
        (self.dist / "icon.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'></svg>\n", encoding="utf-8")
        self.port = free_port()
        self.assertNotEqual(self.port, 4173)

    def _tmp(self) -> str:
        import tempfile
        self._ctx = tempfile.TemporaryDirectory()
        return self._ctx.name

    def tearDown(self) -> None:
        # Best-effort stop of *this test's* instance only, via the script record.
        try:
            self._run("stop")
        except Exception:
            pass
        self._ctx.cleanup()

    def _run(self, *command: str, bind: str = "127.0.0.1", port: int | None = None, check: bool = False) -> subprocess.CompletedProcess[str]:
        args = [
            PY, str(SCRIPT),
            "--root", str(self.root),
            "--dist", str(self.dist),
            "--bind", bind,
            "--port", str(self.port if port is None else port),
            *command,
        ]
        return subprocess.run(args, text=True, capture_output=True, check=check)

    def test_refuses_non_loopback_bind(self) -> None:
        proc = self._run("start", bind="0.0.0.0")
        self.assertEqual(proc.returncode, 9)
        self.assertIn("127.0.0.1", proc.stderr)

    def test_refuses_occupied_port_without_stealing(self) -> None:
        holder = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.addCleanup(holder.close)
        holder.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        holder.bind(("127.0.0.1", self.port))
        holder.listen(1)
        proc = self._run("start")
        self.assertEqual(proc.returncode, 10)
        self.assertIn("occupied", proc.stderr)

    def test_start_serves_files_real_404_and_types_then_stop(self) -> None:
        started = self._run("start")
        self.assertEqual(started.returncode, 0, started.stderr)
        runtime = json.loads((self.root / "var/meta/current-runtime.json").read_text())
        pid = int(runtime["pid"])
        self.assertTrue(Path(f"/proc/{pid}").exists())
        self.assertEqual(runtime["bind"], "127.0.0.1")
        self.assertEqual(runtime["port"], self.port)
        self.assertEqual(Path(runtime["physical_dist"]), self.dist.resolve())
        self.assertEqual(runtime["command_identity"], "orgcompass-web")
        self.assertFalse(runtime.get("formal_install"))
        origin = f"http://127.0.0.1:{self.port}"
        st, typ, body = http_get(origin + "/")
        self.assertEqual(st, 200)
        self.assertIn("html", typ)
        self.assertIn(b"ok", body)
        st, typ, body = http_get(origin + "/app.js")
        self.assertEqual(st, 200)
        self.assertIn("javascript", typ)
        st, typ, body = http_get(origin + "/app.css")
        self.assertEqual(st, 200)
        self.assertIn("css", typ)
        st, typ, body = http_get(origin + "/icon.svg")
        self.assertEqual(st, 200)
        self.assertIn("svg", typ)
        st, typ, body = http_get(origin + "/does-not-exist")
        self.assertEqual(st, 404)
        # Must be a real 404, not the index document.
        self.assertNotIn(b"ok", body)
        # Duplicate start is refused.
        again = self._run("start")
        self.assertEqual(again.returncode, 3)
        stopped = self._run("stop")
        self.assertEqual(stopped.returncode, 0, stopped.stderr)
        self.assertFalse(Path(f"/proc/{pid}").exists())
        self.assertFalse((self.root / "var/run/orgcompass-web.pid").exists())

    def test_http_fallback_content_types_and_real_missing_404(self) -> None:
        # Real HTTP exercises the standard guess_type fallback, not a mocked method.
        fixtures = {
            "_headers": (b"/assets/*\n  Cache-Control: public\n", "application/octet-stream"),
            "NOTICE": (b"synthetic extensionless file\n", "application/octet-stream"),
            "opaque.unregisteredextension3577": (b"synthetic binary\x00\x01", "application/octet-stream"),
            "image.png": (b"\x89PNG\r\n\x1a\n", "image/png"),
        }
        for name, (content, _) in fixtures.items():
            (self.dist / name).write_bytes(content)
        started = self._run("start")
        self.assertEqual(started.returncode, 0, started.stderr)
        origin = f"http://127.0.0.1:{self.port}"
        for name, (content, expected_type) in fixtures.items():
            with self.subTest(path=name):
                status, typ, body = http_get(origin + "/" + name)
                self.assertEqual(status, 200)
                self.assertEqual(typ, expected_type)
                self.assertEqual(body, content)
        for name in ("missing-extensionless", "missing.png", "missing.unknown3577"):
            with self.subTest(missing=name):
                status, typ, body = http_get(origin + "/" + name)
                self.assertEqual(status, 404)
                self.assertEqual(typ, "text/html")  # standard error body, not index fallback
                self.assertNotEqual(body, (self.dist / "index.html").read_bytes())
        self.assertEqual(self._run("stop").returncode, 0)

    def test_status_and_restart_same_dist(self) -> None:
        self.assertNotEqual(self._run("status").returncode, 0)
        self.assertEqual(self._run("start").returncode, 0)
        status = self._run("status")
        self.assertEqual(status.returncode, 0)
        first_pid = int(json.loads((self.root / "var/meta/current-runtime.json").read_text())["pid"])
        restarted = self._run("restart")
        self.assertEqual(restarted.returncode, 0, restarted.stderr)
        second = json.loads((self.root / "var/meta/current-runtime.json").read_text())
        self.assertNotEqual(int(second["pid"]), first_pid)
        self.assertEqual(Path(second["physical_dist"]), self.dist.resolve())
        st, typ, body = http_get(f"http://127.0.0.1:{self.port}/")
        self.assertEqual(st, 200)
        self.assertEqual(self._run("stop").returncode, 0)


if __name__ == "__main__":
    unittest.main()

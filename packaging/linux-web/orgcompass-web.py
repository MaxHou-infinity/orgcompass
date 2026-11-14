#!/usr/bin/env python3
"""OrgCompass local-loopback static server (install adjunct, not a product feature).

Does not register a global service.
Does not rewrite unknown paths to index.html. Binds 127.0.0.1 only.
Default install root is /workspace/apps/orgcompass; tests may pass --root.
This module is a file+unit-test deliverable; running it against 4173 is not a formal install.
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import select
import secrets
import socket
import sys
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

DEFAULT_ROOT = Path("/workspace/apps/orgcompass")
DEFAULT_BIND = "127.0.0.1"
DEFAULT_PORT = 4173
COMMAND_IDENTITY = "orgcompass-web"

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
    ".map": "application/json; charset=utf-8",
}


class ForbiddenBind(ValueError):
    pass


class PortBusy(RuntimeError):
    pass


class IdentityMismatch(RuntimeError):
    pass


def paths(root: Path) -> dict[str, Path]:
    return {
        "root": root,
        "bin": root / "bin",
        "var": root / "var",
        "run": root / "var" / "run",
        "log": root / "var" / "log",
        "meta": root / "var" / "meta",
        "pid": root / "var" / "run" / "orgcompass-web.pid",
        "runtime": root / "var" / "meta" / "current-runtime.json",
        "stdout": root / "var" / "log" / "orgcompass-web.stdout.log",
        "stderr": root / "var" / "log" / "orgcompass-web.stderr.log",
    }


def ensure_var(p: dict[str, Path]) -> None:
    for key in ("run", "log", "meta"):
        p[key].mkdir(parents=True, exist_ok=True)


def read_pid(pid_file: Path) -> int | None:
    if not pid_file.exists():
        return None
    text = pid_file.read_text().strip()
    if not text.isdigit():
        return None
    return int(text)


def proc_alive(pid: int) -> bool:
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0] != "Z"
    except (OSError, IndexError):
        return False


def proc_cmdline(pid: int) -> str:
    try:
        return " ".join(Path(f"/proc/{pid}/cmdline").read_bytes().decode().rstrip("\0").split("\0"))
    except OSError:
        return ""


def process_identity(pid: int, bind: str, port: int) -> dict[str, Any]:
    """Read only this PID's kernel identity and its own matching listening sockets."""
    base = Path(f"/proc/{pid}")
    stat = base.joinpath("stat").read_text().rsplit(")", 1)[1].split()
    owned = set()
    for fd in base.joinpath("fd").iterdir():
        try:
            target = os.readlink(fd)
            if target.startswith("socket:["):
                owned.add(target[8:-1])
        except FileNotFoundError:
            continue  # e.g. an HTTP request fd closed during inspection
    address = socket.inet_aton(bind)[::-1].hex().upper() + f":{port:04X}"
    listeners = []
    # /proc/<pid>/net is namespace-wide: retain ONLY matching owned socket inodes.
    for line in base.joinpath("net/tcp").read_text().splitlines()[1:]:
        fields = line.split()
        if fields[1] == address and fields[3] == "0A" and fields[9] in owned:
            listeners.append(fields[9])
    return {
        "argv": base.joinpath("cmdline").read_bytes().decode().rstrip("\0").split("\0"),
        "start_ticks": stat[19],
        "physical_dist": str(base.joinpath("cwd").resolve(strict=True)),
        "executable": str(base.joinpath("exe").resolve(strict=True)),
        "listener_inodes": sorted(listeners),
    }


def pidfd_exited(fd: int, timeout: float = 0) -> bool:
    return bool(select.select([fd], [], [], timeout)[0])


def load_runtime(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
        return data if isinstance(data, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


class DistHandler(SimpleHTTPRequestHandler):
    """Serve only real files under dist. Missing paths are a real 404, never index.html."""

    def __init__(self, *args: Any, directory: str, **kwargs: Any) -> None:
        super().__init__(*args, directory=directory, **kwargs)

    def guess_type(self, path: str) -> str:  # type: ignore[override]
        ext = Path(path).suffix.lower()
        if ext in CONTENT_TYPES:
            return CONTENT_TYPES[ext]
        # SimpleHTTPRequestHandler.guess_type returns a MIME string, not mimetypes.guess_type's tuple.
        return super().guess_type(path) or "application/octet-stream"

    def send_head(self):  # type: ignore[override]
        # Map URL to a real file; no SPA fallback.
        path = self.translate_path(self.path)
        rel = Path(path)
        if rel.is_dir():
            index = rel / "index.html"
            if self.path.rstrip("/").endswith("index.html") or self.path in ("/", "") or self.path.endswith("/"):
                if index.is_file():
                    return super().send_head()
            self.send_error(404, "File not found")
            return None
        if not rel.is_file():
            self.send_error(404, "File not found")
            return None
        return super().send_head()

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("%s - %s\n" % (self.log_date_time_string(), fmt % args))
        sys.stderr.flush()


def _validate_bind(bind: str) -> None:
    if bind != "127.0.0.1":
        raise ForbiddenBind(f"refusing bind {bind!r}; only 127.0.0.1 is allowed")


def port_in_use(bind: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((bind, port))
            return False
        except OSError:
            return True


def verify_instance(pid: int, runtime: dict[str, Any] | None, dist: Path, bind: str, port: int, expected_root: Path) -> None:
    if not runtime or runtime.get("pid") != pid or runtime.get("command_identity") != COMMAND_IDENTITY:
        raise IdentityMismatch("missing or mismatched runtime identity")
    try:
        _validate_bind(bind)
        if runtime.get("bind") != bind or runtime.get("port") != port:
            raise IdentityMismatch("bind/port mismatch")
        if not dist.is_absolute() or str(dist.resolve(strict=True)) != runtime.get("physical_dist"):
            raise IdentityMismatch("physical dist is not the recorded canonical path")
        argv = runtime.get("argv")
        token = runtime.get("instance_id")
        root = runtime.get("root")
        if root != str(expected_root.resolve(strict=True)):
            raise IdentityMismatch("runtime belongs to another installation root")
        expected = [
            argv[0], str(Path(__file__).resolve()), "--root", root,
            "--dist", str(dist), "--bind", bind, "--port", str(port),
            "start", "--foreground", "--instance-id", token,
        ]
        if not token or not root or str(Path(root).resolve(strict=True)) != root or argv != expected:
            raise IdentityMismatch("argv/root/start-token record invalid")
        actual = process_identity(pid, bind, port)
        for field in ("argv", "start_ticks", "physical_dist", "executable", "listener_inodes"):
            if not runtime.get(field) or actual[field] != runtime[field]:
                raise IdentityMismatch(f"kernel process {field} mismatch")
    except (OSError, ValueError, TypeError, IndexError, KeyError) as exc:
        raise IdentityMismatch(f"cannot establish process identity: {exc}") from exc


def write_runtime(p: dict[str, Path], *, pid: int, dist: Path, bind: str, port: int, argv: list[str]) -> None:
    ensure_var(p)
    identity = process_identity(pid, bind, port)
    payload = {
        **identity,
        "root": str(p["root"].resolve()),
        "instance_id": identity["argv"][identity["argv"].index("--instance-id") + 1],
        "pid": pid,
        "command_identity": COMMAND_IDENTITY,
        "argv": identity["argv"],
        "physical_dist": str(dist.resolve()),
        "bind": bind,
        "port": port,
        "origin": f"http://{bind}:{port}",
        "started_at_asia_shanghai": time.strftime("%Y-%m-%d %H:%M:%S Asia/Shanghai", time.localtime()),
        "formal_install": False,
    }
    verify_instance(pid, payload, dist, bind, port, p["root"])
    p["runtime"].write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    p["pid"].write_text(str(pid) + "\n")


def serve_forever(dist: Path, bind: str, port: int, p: dict[str, Path], argv: list[str]) -> None:
    _validate_bind(bind)
    httpd = ThreadingHTTPServer((bind, port), lambda *a, **k: DistHandler(*a, directory=str(dist), **k))
    try:
        # Bind first, then record the real listening socket identity from /proc.
        write_runtime(p, pid=os.getpid(), dist=dist, bind=bind, port=port, argv=argv)
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


def cmd_start(p: dict[str, Path], dist: Path, bind: str, port: int, argv: list[str], foreground: bool = False) -> int:
    _validate_bind(bind)
    if not dist.is_dir() or not (dist / "index.html").is_file():
        print(f"error: physical dist missing or has no index.html: {dist}", file=sys.stderr)
        return 2
    dist = dist.resolve(strict=True)
    ensure_var(p)
    existing = read_pid(p["pid"])
    runtime = load_runtime(p["runtime"])
    if existing is not None and proc_alive(existing):
        try:
            recorded_dist = Path(str((runtime or {}).get("physical_dist") or dist))
            recorded_bind = str((runtime or {}).get("bind") or bind)
            recorded_port = int((runtime or {}).get("port") or port)
            verify_instance(existing, runtime, recorded_dist, recorded_bind, recorded_port, p["root"])
            print(f"error: already running pid={existing} origin=http://{recorded_bind}:{recorded_port}", file=sys.stderr)
            return 3
        except IdentityMismatch as exc:
            print(f"error: stale or mismatched pid file ({exc}); not starting, not killing", file=sys.stderr)
            return 4
    if port_in_use(bind, port):
        raise PortBusy(f"{bind}:{port} is occupied; refusing to steal the port or pick another")
    if foreground:
        if "--instance-id" not in argv:
            print("error: foreground is internal and requires --instance-id", file=sys.stderr)
            return 2
        os.chdir(dist.resolve())
        serve_forever(dist.resolve(), bind, port, p, argv)
        return 0
    # Daemon: child execs this script in --foreground so the listen PID is the recorded process.
    child_argv = [
        sys.executable,
        str(Path(__file__).resolve()),
        "--root",
        str(p["root"].resolve()),
        "--dist",
        str(dist.resolve()),
        "--bind",
        bind,
        "--port",
        str(port),
        "start",
        "--foreground",
        "--instance-id",
        secrets.token_hex(24),
    ]
    pid = os.fork()
    if pid == 0:
        os.setsid()
        with open(p["stdout"], "ab", buffering=0) as out, open(p["stderr"], "ab", buffering=0) as err:
            os.dup2(out.fileno(), 1)
            os.dup2(err.fileno(), 2)
        os.execv(sys.executable, child_argv)
    # parent: wait until listen or child dies
    for _ in range(50):
        time.sleep(0.05)
        if port_in_use(bind, port) and proc_alive(pid):
            # child will rewrite runtime with its own pid; wait until file matches a live listen process
            rt = load_runtime(p["runtime"])
            if rt and rt.get("pid") == pid:
                try:
                    verify_instance(pid, rt, dist.resolve(), bind, port, p["root"])
                except IdentityMismatch:
                    continue
                print(f"started pid={rt['pid']} origin=http://{bind}:{port} dist={dist.resolve()}")
                return 0
        if not proc_alive(pid):
            print("error: child exited before listen", file=sys.stderr)
            return 5
    print("error: timed out waiting for listen", file=sys.stderr)
    return 5


def cmd_stop(p: dict[str, Path], *, force_kill_after: float = 5.0) -> int:
    pid = read_pid(p["pid"])
    runtime = load_runtime(p["runtime"])
    if pid is None or runtime is None:
        print("error: no valid pid/runtime record; refusing to search by process name", file=sys.stderr)
        return 6
    dist = Path(str(runtime.get("physical_dist") or ""))
    bind = str(runtime.get("bind") or DEFAULT_BIND)
    port = int(runtime.get("port") or DEFAULT_PORT)
    # Pin the process BEFORE inspecting /proc; never signal by recyclable numeric PID.
    # No fallback to os.kill: unsupported pidfd platforms fail closed.
    fd = None
    try:
        fd = os.pidfd_open(pid)
        verify_instance(pid, runtime, dist, bind, port, p["root"])
        if pidfd_exited(fd):
            raise IdentityMismatch("pinned process exited during verification")
        signal.pidfd_send_signal(fd, signal.SIGTERM)
        if not pidfd_exited(fd, force_kill_after):
            verify_instance(pid, runtime, dist, bind, port, p["root"])
            if pidfd_exited(fd):
                raise IdentityMismatch("pinned process exited before escalation")
            signal.pidfd_send_signal(fd, signal.SIGKILL)
            if not pidfd_exited(fd, 1.0):
                print(f"error: pinned pid {pid} still alive", file=sys.stderr)
                return 8
    except (IdentityMismatch, OSError, AttributeError) as exc:
        print(f"error: will not signal/re-signal pid {pid}: {exc}", file=sys.stderr)
        return 7
    finally:
        if fd is not None:
            os.close(fd)
    # A concurrent new start must not lose its PID record during old-stop cleanup.
    current = load_runtime(p["runtime"])
    if read_pid(p["pid"]) == pid and current == runtime:
        p["pid"].unlink()
    print(f"stopped pid={pid}")
    return 0


def cmd_status(p: dict[str, Path]) -> int:
    pid = read_pid(p["pid"])
    runtime = load_runtime(p["runtime"])
    if pid is None:
        print("status: not running (no pid file)")
        return 1
    if runtime is None:
        print(f"status: pid file {pid} but runtime metadata missing")
        return 1
    dist = Path(str(runtime.get("physical_dist") or ""))
    bind = str(runtime.get("bind") or "")
    port = int(runtime.get("port") or 0)
    try:
        verify_instance(pid, runtime, dist, bind, port, p["root"])
    except IdentityMismatch as exc:
        print(f"status: record present but identity check failed: {exc}")
        return 1
    print(f"status: running pid={pid} origin=http://{bind}:{port} dist={dist}")
    return 0


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    parser = argparse.ArgumentParser(description="OrgCompass 127.0.0.1 static preview/adjunct server")
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--dist", type=Path, default=None, help="physical dist directory")
    parser.add_argument("--bind", default=DEFAULT_BIND)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("command", choices=["start", "stop", "status", "restart"])
    parser.add_argument("--foreground", action="store_true", help="internal: do not daemonize")
    parser.add_argument("--instance-id", help="internal: unique per-start identity")
    args = parser.parse_args(argv)
    p = paths(args.root.resolve())
    dist = args.dist
    if dist is None:
        current = args.root / "releases" / "current" / "dist"
        dist = current if current.exists() else args.root / "dist"
    try:
        if args.command == "start":
            return cmd_start(p, dist, args.bind, args.port, [sys.executable, *([str(Path(__file__).resolve())]), *argv], foreground=args.foreground)
        if args.command == "stop":
            return cmd_stop(p)
        if args.command == "status":
            return cmd_status(p)
        if args.command == "restart":
            # Restart same physical dist; stop first if running.
            running = cmd_status(p) == 0
            if running:
                stopped = cmd_stop(p)
                if stopped != 0:
                    return stopped
            return cmd_start(p, dist, args.bind, args.port, [sys.executable, str(Path(__file__).resolve()), *argv], foreground=args.foreground)
        return 2
    except ForbiddenBind as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 9
    except PortBusy as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 10


if __name__ == "__main__":
    sys.exit(main())

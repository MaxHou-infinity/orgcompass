# Linux local web server

Serves prebuilt OrgCompass files on `127.0.0.1` only. It does not register a system service, change DNS, or replace other instances. Unknown paths return HTTP 404; there is no HTML fallback. The application uses in-memory views at `/`, not pathname deep links. `dist/404.html` also supplies the static not-found page for Pages hosting.

## Files and permissions

- In a source checkout: `packaging/linux-web/orgcompass-web.py`.
- In the web archive: `bin/orgcompass-web.py`, executable mode `0755`; invoke it directly or with `python3`.
- The archive contains `dist/`, including `.vite/manifest.json` and `_headers`, plus checksum files and neutral build metadata. The site root is `dist/`, not the archive's outer directory.
- No dependencies beyond Python 3 and Linux `/proc`, `os.pidfd_open`, and `signal.pidfd_send_signal` are required for the local server.

## Explicit instance parameters

From the archive's root directory (for a source checkout, change `SCRIPT` to `packaging/linux-web/orgcompass-web.py` after building):

```sh
SCRIPT=bin/orgcompass-web.py
ROOT="$(pwd)/.runtime/orgcompass"
DIST="$(realpath dist)"
BIND=127.0.0.1
PORT=4176
"$SCRIPT" --root "$ROOT" --dist "$DIST" --bind "$BIND" --port "$PORT" start
"$SCRIPT" --root "$ROOT" --dist "$DIST" --bind "$BIND" --port "$PORT" status
"$SCRIPT" --root "$ROOT" --dist "$DIST" --bind "$BIND" --port "$PORT" restart
"$SCRIPT" --root "$ROOT" --dist "$DIST" --bind "$BIND" --port "$PORT" stop
```

Choose an unused port. An occupied port or non-loopback bind is refused; the script never steals a port. Repeat **all parameters for restart**; do not assume an invocation without them inherits a recorded instance. Use explicit `--root` for isolated operation.

Runtime files live below `ROOT/var/`: `run/`, `log/`, and `meta/`. Before stopping, the script opens a pidfd and verifies the real process argv, physical document root, interpreter, start ticks, instance marker, root, and owned listening-socket inodes. It signals only through that pidfd. Verification or pidfd failure refuses to signal; it does not fall back to numeric PID or process-name killing. Do not use it to take over old or differently configured runtimes. This prevents PID reuse mistakes, not attacks by a malicious same-UID process.

## Development checks

```sh
npm run typecheck
npm run lint
npm test
python3 -m unittest discover -s packaging/linux-web -p test_identity.py -v
python3 -m unittest discover -s packaging/linux-web -p test_orgcompass_web.py -v
npm run build -- --manifest
```

Python integration tests start and stop only their own temporary loopback instances. `TMPDIR` can keep temporary data in a chosen project directory. Spreadsheet tests write synthetic files below `.test-artifacts/` by default; set `ORGCOMPASS_EVIDENCE_DIR` to choose another output directory.

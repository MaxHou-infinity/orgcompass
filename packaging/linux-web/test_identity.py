"""Identity-only tests: no listening server and no real signals. /proc test reads self only."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("web", Path(__file__).with_name("orgcompass-web.py"))
web = importlib.util.module_from_spec(spec)
spec.loader.exec_module(web)

class IdentityTests(unittest.TestCase):
    def setUp(self):
        # All temporary writes stay under this repository, not shared runtime paths.
        self.ctx = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(self.ctx.cleanup)
        self.root = Path(self.ctx.name).resolve()
        self.dist = self.root / 'dist'
        self.dist.mkdir()
        (self.dist / 'index.html').write_text('synthetic')
        self.p = web.paths(self.root)
        web.ensure_var(self.p)
        self.argv = ['/usr/bin/python3', str(Path(web.__file__).resolve()), '--root', str(self.root), '--dist', str(self.dist), '--bind', '127.0.0.1', '--port', '45678', 'start', '--foreground', '--instance-id', 'token-a']
        self.actual = dict(argv=self.argv, start_ticks='12345', physical_dist=str(self.dist), executable='/usr/bin/python3.13', listener_inodes=['987'])
        self.runtime = dict(pid=123, command_identity='orgcompass-web', root=str(self.root), physical_dist=str(self.dist), bind='127.0.0.1', port=45678, argv=self.argv, instance_id='token-a', start_ticks='12345', executable='/usr/bin/python3.13', listener_inodes=['987'])
        self.p['pid'].write_text('123')

    def verify(self, actual=None, runtime=None):
        with patch.object(web, 'proc_alive', return_value=True), patch.object(web, 'proc_cmdline', return_value='orgcompass-web.py'), patch.object(web, 'process_identity', return_value=actual or self.actual, create=True):
            web.verify_instance(123, self.runtime if runtime is None else runtime, self.dist, '127.0.0.1', 45678, self.root)

    def test_foreground_bind_then_kernel_record_wiring_without_service(self):
        server = unittest.mock.Mock()
        with patch.object(web, 'port_in_use', return_value=False), patch.object(web, 'ThreadingHTTPServer', return_value=server) as httpd, patch.object(web.os, 'getpid', return_value=123), patch.object(web.os, 'chdir') as chdir, patch.object(web, 'process_identity', return_value=self.actual):
            self.assertEqual(web.cmd_start(self.p, self.dist, '127.0.0.1', 45678, self.argv, foreground=True), 0)
            httpd.assert_called_once(); server.serve_forever.assert_called_once(); server.server_close.assert_called_once()
            chdir.assert_called_once_with(self.dist)
            rt = web.load_runtime(self.p['runtime'])
            self.assertEqual(rt['argv'], self.argv); self.assertEqual(rt['instance_id'], 'token-a')
            self.assertEqual(rt['listener_inodes'], ['987']); self.assertEqual(rt['start_ticks'], '12345')

    def test_valid_identity(self):
        self.verify()

    def test_rejects_other_instance_and_stale_start_argv_dist_listener(self):
        for key, val in [('start_ticks', '999'), ('physical_dist', str(self.root / 'other-dist')), ('argv', self.argv[:-1] + ['token-b']), ('listener_inodes', []), ('executable', '/other/python')]:
            with self.subTest(key=key):
                actual = dict(self.actual, **{key: val})
                with self.assertRaises(web.IdentityMismatch): self.verify(actual)

    def test_copied_other_root_complete_runtime_is_rejected_without_signal(self):
        other = self.root / 'other-root'; other.mkdir()
        rt = dict(self.runtime, root=str(other))
        self.p['runtime'].write_text(json.dumps(rt))
        with patch.object(web.os, 'pidfd_open', return_value=100), patch.object(web.os, 'close'), patch.object(web, 'process_identity', return_value=self.actual), patch.object(web.signal, 'pidfd_send_signal') as send, patch.object(web.os, 'kill') as kill:
            self.assertEqual(web.cmd_stop(self.p), 7)
            send.assert_not_called(); kill.assert_not_called()

    def test_rejects_legacy_metadata_without_kernel_start_identity(self):
        rt = dict(self.runtime); rt.pop('start_ticks')
        with self.assertRaises(web.IdentityMismatch): self.verify(runtime=rt)

    def test_stop_wrong_pid_or_stale_runtime_sends_no_signal(self):
        for field, value in [('argv', self.argv[:-1] + ['token-b']), ('start_ticks', '999'), ('listener_inodes', [])]:
            self.p['runtime'].write_text(json.dumps(self.runtime))
            with patch.object(web, 'proc_alive', return_value=True), patch.object(web, 'proc_cmdline', return_value='orgcompass-web.py'), patch.object(web, 'process_identity', return_value=dict(self.actual, **{field: value}), create=True), patch.object(web.os, 'pidfd_open', return_value=100, create=True), patch.object(web.os, 'close'), patch.object(web, 'pidfd_exited', return_value=False, create=True), patch.object(web.signal, 'pidfd_send_signal', create=True) as send, patch.object(web.os, 'kill') as kill:
                self.assertEqual(web.cmd_stop(self.p, force_kill_after=0), 7)
                send.assert_not_called(); kill.assert_not_called()

    def test_stop_pins_before_verify_and_uses_only_pidfd(self):
        self.p['runtime'].write_text(json.dumps(self.runtime))
        order = []
        with patch.object(web.os, 'pidfd_open', side_effect=lambda *_: order.append('open') or 100, create=True), patch.object(web.os, 'close'), patch.object(web, 'verify_instance', side_effect=lambda *_: order.append('verify')), patch.object(web, 'pidfd_exited', side_effect=[False, True], create=True), patch.object(web.signal, 'pidfd_send_signal', side_effect=lambda *_: order.append('send'), create=True), patch.object(web.os, 'kill') as kill:
            self.assertEqual(web.cmd_stop(self.p), 0)
            self.assertEqual(order, ['open', 'verify', 'send']); kill.assert_not_called()

    def test_missing_pidfd_support_fails_closed(self):
        self.p['runtime'].write_text(json.dumps(self.runtime))
        with patch.object(web.os, 'pidfd_open', side_effect=OSError('not supported')), patch.object(web.signal, 'pidfd_send_signal') as send, patch.object(web.os, 'kill') as kill:
            self.assertEqual(web.cmd_stop(self.p), 7); send.assert_not_called(); kill.assert_not_called()

    def test_timeout_revalidates_before_pidfd_kill(self):
        self.p['runtime'].write_text(json.dumps(self.runtime))
        with patch.object(web.os, 'pidfd_open', return_value=100), patch.object(web.os, 'close'), patch.object(web, 'verify_instance') as verify, patch.object(web, 'pidfd_exited', side_effect=[False, False, False, True]), patch.object(web.signal, 'pidfd_send_signal') as send, patch.object(web.os, 'kill') as kill:
            self.assertEqual(web.cmd_stop(self.p), 0)
            self.assertEqual(verify.call_count, 2)
            self.assertEqual(send.call_args_list, [unittest.mock.call(100, web.signal.SIGTERM), unittest.mock.call(100, web.signal.SIGKILL)])
            kill.assert_not_called()

    def test_identity_changed_after_term_does_not_escalate(self):
        self.p['runtime'].write_text(json.dumps(self.runtime))
        with patch.object(web.os, 'pidfd_open', return_value=100), patch.object(web.os, 'close'), patch.object(web, 'verify_instance', side_effect=[None, web.IdentityMismatch('changed')]), patch.object(web, 'pidfd_exited', side_effect=[False, False]), patch.object(web.signal, 'pidfd_send_signal') as send:
            self.assertEqual(web.cmd_stop(self.p), 7)
            send.assert_called_once_with(100, web.signal.SIGTERM)

    def test_exited_pinned_process_never_signals_reused_numeric_pid(self):
        self.p['runtime'].write_text(json.dumps(self.runtime))
        with patch.object(web.os, 'pidfd_open', return_value=100, create=True), patch.object(web.os, 'close'), patch.object(web, 'verify_instance'), patch.object(web, 'pidfd_exited', return_value=True, create=True), patch.object(web.signal, 'pidfd_send_signal', create=True) as send, patch.object(web.os, 'kill') as kill:
            self.assertEqual(web.cmd_stop(self.p), 7); send.assert_not_called(); kill.assert_not_called()

    def test_kernel_reader_matches_owned_listener_only_and_rejects_stale_record(self):
        # Synthetic /proc files exercise the actual reader; no network bind or signals.
        base = self.root / 'proc-123'; (base / 'fd').mkdir(parents=True); (base / 'net').mkdir()
        (base / 'stat').write_text('123 (python3) S ' + ' '.join(['0'] * 18 + ['12345'] + ['0'] * 5))
        (base / 'cmdline').write_bytes(('\0'.join(self.argv) + '\0').encode())
        (base / 'cwd').symlink_to(self.dist, target_is_directory=True)
        (base / 'exe').symlink_to('/usr/bin/python3.13')
        (base / 'fd/3').symlink_to('socket:[987]')
        (base / 'net/tcp').write_text('header\n0: 0100007F:B26E 00000000:0000 0A 0 0 0 0 0 987\n1: 0100007F:B26E 00000000:0000 0A 0 0 0 0 0 777\n')
        real_path = Path
        def mapped(value): return base if str(value) == '/proc/123' else real_path(value)
        with patch.object(web, 'Path', side_effect=mapped):
            actual = web.process_identity(123, '127.0.0.1', 45678)
            self.assertEqual(actual['listener_inodes'], ['987'])
            self.assertEqual(actual['start_ticks'], '12345')
            # Match interpreter identity from the fixture's physical exe link.
            rt = dict(self.runtime, executable=actual['executable'])
            web.verify_instance(123, rt, self.dist, '127.0.0.1', 45678, self.root)
            (base / 'cmdline').write_bytes(('\0'.join(self.argv[:-1] + ['token-b']) + '\0').encode())
            with self.assertRaises(web.IdentityMismatch): web.verify_instance(123, rt, self.dist, '127.0.0.1', 45678, self.root)

    def test_reads_current_process_kernel_metadata_without_service(self):
        # Actual reader test; self has no matching listener and is never signaled.
        identity = web.process_identity(os.getpid(), '127.0.0.1', 45678)
        self.assertEqual(Path(identity['executable']), Path(__import__('sys').executable).resolve())
        self.assertIn('unittest', identity['argv'])
        self.assertTrue(identity['start_ticks'].isdigit())
        self.assertEqual(identity['physical_dist'], str(Path.cwd()))
        self.assertEqual(identity['listener_inodes'], [])

if __name__ == '__main__': unittest.main()

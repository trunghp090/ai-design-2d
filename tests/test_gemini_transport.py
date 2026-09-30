import io
import unittest
import urllib.error
from unittest.mock import patch, MagicMock
import server


class GeminiTransportTests(unittest.TestCase):
    def error(self, code, headers=None):
        return urllib.error.HTTPError('https://generativelanguage.googleapis.com/test', code, 'test', headers or {}, io.BytesIO(b'{}'))

    def test_transient_failures_retry_same_request_then_return(self):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'{"ok":true}'
        req = object()
        with patch.object(server.urllib.request, 'urlopen', side_effect=[self.error(503), self.error(429), response]) as call, patch.object(server.time, 'sleep') as sleep, patch.object(server.random, 'uniform', return_value=0):
            self.assertEqual(server._gemini_call(req), b'{"ok":true}')
        self.assertEqual(call.call_count, 3)
        self.assertTrue(all(c.args == (req,) for c in call.call_args_list))
        self.assertEqual([c.args[0] for c in sleep.call_args_list], [2,4])

    def test_no_retry_on_permissions_input_or_ambiguous_timeout(self):
        for error in (self.error(400), self.error(402), self.error(403), TimeoutError(), urllib.error.URLError('disconnected')):
            with self.subTest(error=type(error).__name__), patch.object(server.urllib.request, 'urlopen', side_effect=error) as call, patch.object(server.time, 'sleep') as sleep:
                with self.assertRaises(type(error)):
                    server._gemini_call(object())
                self.assertEqual(call.call_count, 1)
                sleep.assert_not_called()

    def test_maximum_attempts_preserve_last_error_body(self):
        errors = [self.error(503) for _ in range(3)]
        with patch.object(server.urllib.request, 'urlopen', side_effect=errors) as call, patch.object(server.time, 'sleep'):
            with self.assertRaises(urllib.error.HTTPError) as raised:
                server._gemini_call(object())
        self.assertEqual(call.call_count, 3)
        self.assertEqual(raised.exception.read(), b'{}')

    def test_retry_after_cannot_extend_time_budget(self):
        with patch.object(server.urllib.request, 'urlopen', side_effect=self.error(503, {'Retry-After':'600'})) as call, patch.object(server.time, 'sleep') as sleep:
            with self.assertRaises(urllib.error.HTTPError):
                server._gemini_call(object(), timeout=300)
            self.assertEqual(call.call_count, 1)
            sleep.assert_not_called()

    def test_retry_uses_remaining_time(self):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'ok'
        with patch.object(server.urllib.request, 'urlopen', side_effect=[self.error(503), response]) as call, patch.object(server.time, 'monotonic', side_effect=[0,0,100,102]), patch.object(server.time,'sleep'), patch.object(server.random, 'uniform', return_value=0):
            self.assertEqual(server._gemini_call(object()), b'ok')
        self.assertEqual([c.kwargs['timeout'] for c in call.call_args_list], [300,198])

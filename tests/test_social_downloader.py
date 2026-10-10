import io
import json
import tempfile
import time
import unittest
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import social_downloader as downloader
from social_extract import extract as extract_social_post


REQUEST_ID = '11111111-1111-4111-8111-111111111111'
POST_URL = 'https://www.tiktok.com/@trung/photo/7440000000000000001'
PNG_BYTES = b'\x89PNG\r\n\x1a\n' + b'fixture-image-bytes'
MP4_BYTES = b'\x00\x00\x00\x18ftypisom' + b'fixture-video-bytes'


def content(kind='images', count=2):
    return {
        'platform': 'tiktok', 'post_id': '7440000000000000001',
        'title': 'Mẫu thiết kế', 'author': 'Trung', 'type': kind,
        'assets': [
            {'kind': 'video' if kind == 'video' else 'image',
             'urls': ['https://p16-sign.tiktokcdn-us.com/%s.png' % index],
             'headers': {'User-Agent': 'fixture-agent', 'Referer': 'https://www.tiktok.com/'}}
            for index in range(count)
        ],
    }


class MediaResponse(io.BytesIO):
    def __init__(self, data, declared=None, status=200):
        super().__init__(data)
        self.status = status
        self.headers = {} if declared is None else {'Content-Length': str(declared)}


class Handler:
    def __init__(self, path, method='GET', user=None, headers=None, data=b''):
        self.path = path
        self.command = method
        self.user = user
        self.headers = {'Host': 'localhost:8000', **(headers or {})}
        self.rfile = io.BytesIO(data)
        self.wfile = io.BytesIO()
        self.status = None
        self.response_headers = {}
        self.json_body = None

    def current_user(self):
        return self.user

    def json(self, status, body):
        self.status, self.json_body = status, body

    def send_response(self, status):
        self.status = status

    def send_header(self, key, value):
        self.response_headers[key] = value

    def end_headers(self):
        pass


class SocialDownloaderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.app = SimpleNamespace(
            DATA_DIR=self.tmp.name, AUTH_REQUIRED=True,
            user_has_tab=lambda user, tab: tab == 'socialdownload')
        self.body = {'url': POST_URL, 'request_id': REQUEST_ID}
        self.extraction = patch.object(downloader.social_extract, 'extract', return_value=content())
        self.extract = self.extraction.start()
        self.addCleanup(self.extraction.stop)
        self.validation = patch.object(downloader.social_extract, 'validate_url', side_effect=lambda url, **kw: url)
        self.validation.start()
        self.addCleanup(self.validation.stop)

    def resolve(self, owner='one', body=None):
        return downloader.resolve(self.app, body or self.body, owner)

    def assert_problem(self, status, function, *args):
        with self.assertRaises(downloader.Problem) as raised:
            function(*args)
        self.assertEqual(raised.exception.status, status)

    def test_resolve_returns_local_urls_and_keeps_source_credentials_private(self):
        result = self.resolve()
        self.assertEqual(result['type'], 'images')
        self.assertEqual(len(result['items']), 2)
        self.assertEqual(result['items'][0]['preview_url'],
                         '/api/social-download/file?id=' + REQUEST_ID + '&index=0')
        self.assertEqual(result['items'][0]['download_url'],
                         '/api/social-download/file?id=' + REQUEST_ID + '&index=0&download=1')
        self.assertEqual(result['zip_url'], '/api/social-download/zip?id=' + REQUEST_ID)
        public = json.dumps(result)
        self.assertNotIn('tiktokcdn', public)
        self.assertNotIn('User-Agent', public)
        self.assertNotIn('owner', result)
        self.assertNotIn('input', result)

    def test_owner_scoping_idempotency_and_conflict(self):
        first = self.resolve()
        self.assertEqual(self.resolve(), first)
        self.extract.assert_called_once()
        self.assert_problem(409, downloader.resolve, self.app,
                            {**self.body, 'url': POST_URL + '?changed=1'}, 'one')
        self.assert_problem(404, downloader.read, self.app, REQUEST_ID, 'two')
        second_owner = self.resolve('two')
        self.assertEqual(second_owner['id'], REQUEST_ID)
        self.assertEqual(self.extract.call_count, 2)
        self.assertNotEqual(downloader.folder(self.app, 'one'), downloader.folder(self.app, 'two'))

    def test_rejects_path_traversal_and_expired_metadata(self):
        self.resolve()
        for invalid in ['../metadata', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', '', None, 123]:
            with self.subTest(identifier=invalid):
                self.assert_problem(400, downloader.read, self.app, invalid, 'one')
        metadata = downloader.folder(self.app, 'one') / REQUEST_ID / 'metadata.json'
        job = json.loads(metadata.read_text())
        with patch.object(downloader.time, 'time', return_value=job['created'] + downloader.TTL + 1):
            self.assert_problem(410, downloader.read, self.app, REQUEST_ID, 'one')

    def test_rejects_invalid_or_excessive_media(self):
        cases = [content('images', 0), content('images', downloader.MAX_IMAGES + 1), content('video', 2)]
        mixed = content()
        mixed['assets'][1]['kind'] = 'video'
        cases.append(mixed)
        for fixture in cases:
            with self.subTest(kind=fixture['type'], count=len(fixture['assets'])):
                self.extract.return_value = fixture
                self.assert_problem(422, downloader.resolve, self.app, self.body, 'one')
        self.assertFalse((downloader.folder(self.app, 'one') / REQUEST_ID / 'metadata.json').exists())

    def test_douyin_cookie_reaches_extractor_but_is_never_saved_or_returned(self):
        secret = 'sessionid=private-cookie-fixture; ttwid=private-second-fixture'
        body = {**self.body, 'url': 'https://www.douyin.com/video/7450000000000000002',
                'douyin_cookie': secret}
        fixture = content()
        fixture['platform'] = 'douyin'
        fixture['post_id'] = '7450000000000000002'
        fixture['assets'][0]['headers']['Cookie'] = secret
        self.extract.return_value = fixture
        result = downloader.resolve(self.app, body, 'one')
        self.extract.assert_called_once_with(body['url'], cookie_header=secret, user_agent='')
        metadata = downloader.folder(self.app, 'one') / REQUEST_ID / 'metadata.json'
        saved = metadata.read_text()
        self.assertNotIn(secret, saved)
        self.assertNotIn('douyin_cookie', saved)
        self.assertNotIn('Cookie', saved)
        self.assertNotIn(secret, json.dumps(result))

    def test_douyin_cookie_rejects_tiktok_and_invalid_cookie_input(self):
        for value in ['x' * 16001, 'session=secret\nOther: value',
                      'session=secret\rOther: value', None, ['secret']]:
            with self.subTest(cookie=value):
                self.assert_problem(400, downloader.resolve, self.app,
                                    {**self.body, 'url': 'https://v.douyin.com/example/',
                                     'douyin_cookie': value}, 'one')
        self.assert_problem(400, downloader.resolve, self.app,
                            {**self.body, 'douyin_cookie': 'sessionid=private'}, 'one')
        self.extract.assert_not_called()

    def test_douyin_user_agent_is_forwarded_with_cookie_and_kept_in_media_headers(self):
        secret = 'sessionid=synthetic-test-cookie'
        agent = 'Synthetic-Desktop-Test-Agent/1.0'
        body = {**self.body, 'url': 'https://www.douyin.com/video/7450000000000000002',
                'douyin_cookie': secret, 'douyin_user_agent': agent}
        fixture = content()
        fixture['platform'] = 'douyin'
        fixture['post_id'] = '7450000000000000002'
        for asset in fixture['assets']:
            asset['headers']['User-Agent'] = agent
        self.extract.return_value = fixture
        result = downloader.resolve(self.app, body, 'one')
        self.extract.assert_called_once_with(body['url'], cookie_header=secret, user_agent=agent)
        job = downloader.read(self.app, REQUEST_ID, 'one')
        self.assertNotIn('douyin_cookie', job)
        self.assertNotIn('douyin_user_agent', job)
        self.assertNotIn('cookie_header', job)
        self.assertNotIn('user_agent', job)
        self.assertNotIn(secret, json.dumps(job))
        self.assertNotIn(secret, json.dumps(result))
        self.assertNotIn(agent, json.dumps(result))
        self.assertTrue(all(asset['headers']['User-Agent'] == agent for asset in job['assets']))

    def test_douyin_user_agent_is_not_forwarded_without_cookie(self):
        agent = 'Synthetic-Desktop-Test-Agent/1.0'
        result = downloader.resolve(self.app, {**self.body, 'douyin_user_agent': agent}, 'one')
        self.extract.assert_called_once_with(POST_URL)
        job = downloader.read(self.app, REQUEST_ID, 'one')
        self.assertNotIn('douyin_user_agent', job)
        self.assertNotIn(agent, json.dumps(job))
        self.assertNotIn(agent, json.dumps(result))

    def test_douyin_user_agent_validation_applies_with_or_without_cookie(self):
        url = 'https://www.douyin.com/video/7450000000000000002'
        for cookie in ['', 'sessionid=synthetic-test-cookie']:
            for agent in ['x' * 513, 'Agent\r\nHost: localhost', 'Agent\r',
                          'Agent\n', 'Agent\x00', 'Agent\x7f', 'Trình duyệt', None, ['agent']]:
                with self.subTest(cookie=bool(cookie), agent=agent):
                    self.assert_problem(400, downloader.resolve, self.app,
                                        {**self.body, 'url': url, 'douyin_cookie': cookie,
                                         'douyin_user_agent': agent}, 'one')
        self.extract.assert_not_called()

    def test_signed_douyin_extraction_does_not_persist_auth_or_signing_request(self):
        secret = ('sessionid=synthetic-private-session; sid_tt=synthetic-private-sid; '
                  'msToken=synthetic-visitor-token; s_v_web_id=synthetic-fingerprint; '
                  'UIFID_TEMP=synthetic-visitor-id')
        body = {**self.body, 'url': 'https://www.douyin.com/note/7450000000000000002',
                'douyin_cookie': secret, 'douyin_user_agent': 'Synthetic-Desktop-Agent/1.0'}
        fixture = {'aweme_detail': {
            'aweme_id': '7450000000000000002', 'desc': 'Photo fixture',
            'author': {'nickname': 'Fixture Author'},
            'images': [{'url_list': ['https://p3-sign.douyinpic.com/fixture.jpeg']}],
        }}

        def signed_response(url, headers, **kwargs):
            self.assertIn('/aweme/v1/web/aweme/detail/', url)
            self.assertEqual(headers['Cookie'], secret)
            response = MediaResponse(json.dumps(fixture).encode())
            response.url = url
            return response

        with patch.object(downloader.social_extract, 'extract', side_effect=extract_social_post), \
                patch.object(downloader.social_extract, '_open', side_effect=signed_response), \
                patch('douyin_signing.abogus.ABogus') as signer:
            signer.return_value.get_value.return_value = 'synthetic-signature'
            result = downloader.resolve(self.app, body, 'one')
        metadata = (downloader.folder(self.app, 'one') / REQUEST_ID / 'metadata.json').read_text()
        serialized = json.dumps(result)
        for transient in ['synthetic-private-session', 'synthetic-private-sid', 'synthetic-visitor-token',
                          'synthetic-fingerprint', 'synthetic-visitor-id', 'synthetic-signature',
                          'a_bogus', 'x-secsdk-web-signature', 'douyin_cookie', 'douyin_user_agent']:
            self.assertNotIn(transient, metadata)
            self.assertNotIn(transient, serialized)
        self.assertEqual(result['post_id'], '7450000000000000002')
        self.assertEqual(result['type'], 'images')

    def test_download_is_cached_and_extension_comes_from_actual_file(self):
        self.resolve()
        job = downloader.read(self.app, REQUEST_ID, 'one')
        with patch.object(downloader, 'open_media', side_effect=lambda *a: MediaResponse(PNG_BYTES, len(PNG_BYTES))) as network:
            path, item = downloader.media_file(self.app, job, 0)
            cached, cached_item = downloader.media_file(self.app, job, 0)
        network.assert_called_once()
        self.assertEqual(path, cached)
        self.assertEqual(item, cached_item)
        self.assertEqual(path.read_bytes(), PNG_BYTES)
        self.assertEqual(item['mime'], 'image/png')
        self.assertTrue(item['filename'].endswith('.png'))
        self.assertEqual(downloader.FILE_LOCKS, {})
        for invalid in [-1, 2, True, '0']:
            self.assert_problem(404, downloader.media_file, self.app, job, invalid)

    def test_retry_next_cdn_candidate_after_truncated_response(self):
        fixture = content('video', 1)
        fixture['assets'][0]['urls'].append('https://v16m.tiktokcdn.com/backup.mp4')
        self.extract.return_value = fixture
        self.resolve()
        job = downloader.read(self.app, REQUEST_ID, 'one')
        with patch.object(downloader, 'open_media', side_effect=[
                MediaResponse(MP4_BYTES, len(MP4_BYTES) + 10),
                MediaResponse(MP4_BYTES, len(MP4_BYTES))]) as network:
            path, item = downloader.media_file(self.app, job, 0)
        self.assertEqual(network.call_count, 2)
        self.assertEqual(path.read_bytes(), MP4_BYTES)
        self.assertEqual(item['mime'], 'video/mp4')
        self.assertFalse(path.with_suffix('.part').exists())

    def test_invalid_media_and_size_limits_leave_no_partial_download(self):
        self.resolve()
        job = downloader.read(self.app, REQUEST_ID, 'one')
        cases = [(b'<html>login needed</html>', None, 502),
                 (PNG_BYTES, 100, 413), (PNG_BYTES, None, 413)]
        for data, declared, expected in cases:
            with self.subTest(declared=declared, expected=expected), \
                    patch.object(downloader, 'MAX_IMAGE_BYTES', 16), \
                    patch.object(downloader, 'open_media', side_effect=lambda *a: MediaResponse(data, declared)):
                self.assert_problem(expected, downloader.media_file, self.app, job, 0)
                directory = downloader.folder(self.app, 'one') / REQUEST_ID
                self.assertEqual(list(directory.glob('asset-*')), [])
                self.assertEqual(downloader.RESERVED_BYTES, {})

    def test_zip_contains_all_images_in_carousel_order(self):
        self.resolve()
        job = downloader.read(self.app, REQUEST_ID, 'one')
        images = [PNG_BYTES + b'first', PNG_BYTES + b'second']
        with patch.object(downloader, 'open_media', side_effect=[MediaResponse(raw) for raw in images]) as network:
            path, item = downloader.zip_file(self.app, job)
            cached, _ = downloader.zip_file(self.app, job)
        self.assertEqual(path, cached)
        self.assertEqual(network.call_count, 2)
        self.assertEqual(item['mime'], 'application/zip')
        with zipfile.ZipFile(path) as archive:
            self.assertEqual([archive.read(name) for name in archive.namelist()], images)
            self.assertTrue(all('/' not in name for name in archive.namelist()))

    def test_zip_failure_does_not_publish_partial_archive(self):
        self.resolve()
        job = downloader.read(self.app, REQUEST_ID, 'one')
        with patch.object(downloader, 'open_media', side_effect=lambda *a: MediaResponse(PNG_BYTES)), \
                patch.object(downloader, 'MAX_ZIP_BYTES', len(PNG_BYTES)):
            self.assert_problem(413, downloader.zip_file, self.app, job)
        directory = downloader.folder(self.app, 'one') / REQUEST_ID
        self.assertFalse((directory / 'images.zip').exists())
        self.assertFalse((directory / 'images.part').exists())

    def test_expired_request_replacement_does_not_reuse_previous_media(self):
        self.resolve()
        job = downloader.read(self.app, REQUEST_ID, 'one')
        with patch.object(downloader, 'open_media', side_effect=lambda *a: MediaResponse(PNG_BYTES)):
            path, _ = downloader.media_file(self.app, job, 0)
        metadata = downloader.folder(self.app, 'one') / REQUEST_ID / 'metadata.json'
        job['created'] -= downloader.TTL + 1
        metadata.write_text(json.dumps(job))
        replacement_body = {**self.body, 'url': POST_URL + '?replacement=1'}
        fixture = content('video', 1)
        self.extract.return_value = fixture
        downloader.resolve(self.app, replacement_body, 'one')
        replacement = downloader.read(self.app, REQUEST_ID, 'one')
        with patch.object(downloader, 'open_media', side_effect=lambda *a: MediaResponse(MP4_BYTES)) as network:
            replaced, item = downloader.media_file(self.app, replacement, 0)
        network.assert_called_once()
        self.assertEqual(replaced.read_bytes(), MP4_BYTES)
        self.assertEqual(item['mime'], 'video/mp4')

    def test_zip_obeys_total_owner_storage_budget(self):
        self.resolve()
        job = downloader.read(self.app, REQUEST_ID, 'one')
        with patch.object(downloader, 'open_media', side_effect=lambda *a: MediaResponse(PNG_BYTES)):
            for index in range(2):
                downloader.media_file(self.app, job, index)
        root = downloader.folder(self.app, 'one')
        used = sum(path.stat().st_size for path in root.rglob('*') if path.is_file())
        with patch.object(downloader, 'MAX_OWNER_BYTES', used + 1):
            self.assert_problem(413, downloader.zip_file, self.app, job)
        self.assertFalse((root / REQUEST_ID / 'images.zip').exists())

    def test_zip_budget_includes_archive_headers_and_directory(self):
        self.resolve()
        job = downloader.read(self.app, REQUEST_ID, 'one')
        with patch.object(downloader, 'open_media', side_effect=lambda *a: MediaResponse(PNG_BYTES)):
            for index in range(2):
                downloader.media_file(self.app, job, index)
        root = downloader.folder(self.app, 'one')
        used = sum(path.stat().st_size for path in root.rglob('*') if path.is_file())
        with patch.object(downloader, 'MAX_OWNER_BYTES', used + 2 * len(PNG_BYTES) + 200):
            self.assert_problem(413, downloader.zip_file, self.app, job)
        self.assertFalse((root / REQUEST_ID / 'images.zip').exists())
        self.assertEqual(downloader.RESERVED_BYTES, {})

    def test_concurrent_downloads_share_total_owner_storage_budget(self):
        self.resolve()
        job = downloader.read(self.app, REQUEST_ID, 'one')
        root = downloader.folder(self.app, 'one')
        used = sum(path.stat().st_size for path in root.rglob('*') if path.is_file())

        class SlowResponse(MediaResponse):
            def read(self, size=-1):
                time.sleep(0.03)
                return super().read(size)

        def fetch(index):
            try:
                return downloader.media_file(self.app, job, index)
            except downloader.Problem as error:
                return error.status

        with patch.object(downloader, 'MAX_OWNER_BYTES', used + len(PNG_BYTES) + 1), \
                patch.object(downloader, 'open_media', side_effect=lambda *a: SlowResponse(PNG_BYTES)), \
                ThreadPoolExecutor(max_workers=2) as workers:
            results = list(workers.map(fetch, range(2)))
        self.assertEqual(sum(isinstance(result, tuple) for result in results), 1)
        self.assertIn(413, results)
        total = sum(path.stat().st_size for path in root.rglob('*') if path.is_file())
        self.assertLessEqual(total, used + len(PNG_BYTES) + 1)

    def test_range_requests_and_attachment_download(self):
        path = Path(self.tmp.name) / 'fixture.mp4'
        raw = b'0123456789'
        path.write_bytes(raw)
        item = {'mime': 'video/mp4', 'filename': 'fixture.mp4'}
        for value, expected, content_range in [
                ('bytes=2-5', b'2345', 'bytes 2-5/10'),
                ('bytes=7-', b'789', 'bytes 7-9/10'),
                ('bytes=-3', b'789', 'bytes 7-9/10'),
                ('bytes=8-99', b'89', 'bytes 8-9/10')]:
            with self.subTest(range=value):
                h = Handler('/api/social-download/file', headers={'Range': value})
                downloader.send_file(h, path, item)
                self.assertEqual(h.status, 206)
                self.assertEqual(h.wfile.getvalue(), expected)
                self.assertEqual(h.response_headers['Content-Range'], content_range)
                self.assertEqual(h.response_headers['Content-Length'], str(len(expected)))
        for value in ['bytes=10-', 'bytes=6-2', 'bytes=-0', 'bytes=0-1,3-4', 'invalid']:
            h = Handler('/api/social-download/file', headers={'Range': value})
            downloader.send_file(h, path, item)
            self.assertEqual(h.status, 416)
            self.assertEqual(h.wfile.getvalue(), b'')
            self.assertEqual(h.response_headers['Content-Range'], 'bytes */10')
        h = Handler('/api/social-download/file', headers={'Range': 'bytes=2-5'})
        downloader.send_file(h, path, item, attachment=True)
        self.assertEqual(h.status, 200)
        self.assertEqual(h.wfile.getvalue(), raw)
        self.assertIn('attachment;', h.response_headers['Content-Disposition'])
        self.assertEqual(h.response_headers['Cache-Control'], 'private, no-store')

    def test_routes_require_login_and_tab_permission(self):
        h = Handler('/api/social-download/config')
        self.assertTrue(downloader.route(self.app, h, h.path))
        self.assertEqual(h.status, 401)
        h.user = {'id': 'one'}
        self.app.user_has_tab = lambda user, tab: False
        downloader.route(self.app, h, h.path)
        self.assertEqual(h.status, 403)
        self.app.user_has_tab = lambda user, tab: tab == 'socialdownload'
        downloader.route(self.app, h, h.path)
        self.assertEqual(h.status, 200)
        self.assertTrue(h.json_body['available'])
        self.extract.assert_not_called()

    def test_post_rejects_cross_origin_and_caps_json_before_reading(self):
        for headers in [{'Origin': 'https://evil.example'}, {'Sec-Fetch-Site': 'cross-site'}]:
            h = Handler('/api/social-download/resolve', 'POST', {'id': 'one'}, headers)
            downloader.route(self.app, h, h.path, self.body)
            self.assertEqual(h.status, 403)
        data = b'x' * 32001
        h = Handler('/api/social-download/resolve', 'POST', {'id': 'one'},
                    {'Content-Length': str(len(data))}, data)
        downloader.route(self.app, h, h.path)
        self.assertEqual(h.status, 413)
        self.assertEqual(h.rfile.tell(), 0)
        self.extract.assert_not_called()

    def test_route_reads_bounded_json_and_protects_cached_file_owner(self):
        data = json.dumps(self.body).encode()
        h = Handler('/api/social-download/resolve', 'POST', {'id': 'one'},
                    {'Origin': 'http://localhost:8000', 'Content-Length': str(len(data))}, data)
        downloader.route(self.app, h, h.path)
        self.assertEqual(h.status, 200)
        self.assertEqual(h.json_body['id'], REQUEST_ID)
        path = '/api/social-download/file?id=' + REQUEST_ID + '&index=0'
        denied = Handler(path, user={'id': 'two'})
        with patch.object(downloader, 'open_media') as network:
            downloader.route(self.app, denied, path.split('?')[0])
        self.assertEqual(denied.status, 404)
        network.assert_not_called()
        self.assertFalse(downloader.route(self.app, denied, '/api/status'))


if __name__ == '__main__':
    unittest.main()

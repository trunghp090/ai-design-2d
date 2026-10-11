"""ZIP exports validate every requested image before sending any download bytes."""
import ast
import base64
import io
import os
import re
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock


SERVER = Path(__file__).resolve().parents[1] / 'server.py'
tree = ast.parse(SERVER.read_text())
handler_class = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'Handler')
method = next(node for node in handler_class.body if isinstance(node, ast.FunctionDef) and node.name == 'handle_download_zip')
namespace = {'base64': base64, 'io': io, 'os': os, 're': re}
exec(compile(ast.Module(body=[method], type_ignores=[]), str(SERVER), 'exec'), namespace)


class Response:
    def __init__(self):
        self.errors = []
        self.statuses = []
        self.headers = []
        self.ended = False
        self.wfile = io.BytesIO()

    def json(self, status, payload):
        self.errors.append((status, payload))
        return payload

    def send_response(self, status):
        self.statuses.append(status)

    def send_header(self, name, value):
        self.headers.append((name, value))

    def end_headers(self):
        self.ended = True


class DownloadZipTests(unittest.TestCase):
    def setUp(self):
        self.gallery = tempfile.TemporaryDirectory()
        self.addCleanup(self.gallery.cleanup)
        self.fetched = []
        self.cleaned = []
        self.remote = {}
        namespace.update(GALLERY_DIR=self.gallery.name, fetch_image_bytes=self.fetch, strip_ai_meta=self.clean)

    def fetch(self, source):
        self.fetched.append(source)
        result = self.remote.get(source)
        if isinstance(result, Exception):
            raise result
        return result, 'image/png'

    def clean(self, data):
        self.cleaned.append(data)
        return data

    def invoke(self, body):
        response = Response()
        namespace['handle_download_zip'](response, body)
        return response

    def assert_rejected(self, response):
        self.assertEqual(len(response.errors), 1)
        self.assertEqual(response.errors[0][0], 400)
        self.assertIsInstance(response.errors[0][1].get('error'), str)
        self.assertNotIn(200, response.statuses)
        self.assertFalse(response.ended)
        self.assertEqual(response.wfile.getvalue(), b'')

    @staticmethod
    def inline(data=b'first-image', name='First'):
        return {'data': 'data:image/png;base64,' + base64.b64encode(data).decode(), 'name': name}

    def archive(self, response):
        self.assertEqual(response.errors, [])
        self.assertEqual(response.statuses, [200])
        self.assertTrue(response.ended)
        raw = response.wfile.getvalue()
        self.assertEqual(dict(response.headers)['Content-Type'], 'application/zip')
        self.assertEqual(int(dict(response.headers)['Content-Length']), len(raw))
        return zipfile.ZipFile(io.BytesIO(raw))

    def test_body_and_items_must_be_objects_and_lists(self):
        for body in (None, [], 'invalid', {'items': {}}, {'items': 'invalid'}, {'items': 1}):
            with self.subTest(body=body):
                self.assert_rejected(self.invoke(body))
        self.assertEqual(self.fetched, [])

    def test_missing_or_empty_selection_rejected(self):
        for body in ({}, {'items': []}):
            with self.subTest(body=body):
                self.assert_rejected(self.invoke(body))
        self.assertEqual(self.cleaned, [])

    def test_invalid_item_never_emits_a_partial_archive(self):
        for item in (None, [], 'invalid', 1, {}):
            with self.subTest(item=item):
                response = self.invoke({'items': [self.inline(), item, self.inline(b'third-image')]})
                self.assert_rejected(response)

    def test_exactly_100_images_preserve_every_entry(self):
        items = [self.inline(('image-%d' % i).encode(), 'Image %d' % i) for i in range(100)]
        with self.archive(self.invoke({'items': items})) as archive:
            self.assertEqual(len(archive.namelist()), 100)
            self.assertEqual(archive.namelist()[0], '01-Image-0.png')
            self.assertEqual(archive.namelist()[-1], '100-Image-99.png')
            self.assertEqual(archive.read(archive.namelist()[-1]), b'image-99')

    def test_101_images_rejected_before_fetching_or_cleaning(self):
        response = self.invoke({'items': [{'url': 'https://example.test/%d' % i} for i in range(101)]})
        self.assert_rejected(response)
        self.assertEqual(self.fetched, [])
        self.assertEqual(self.cleaned, [])

    def test_unreadable_middle_image_returns_error_without_any_binary_response(self):
        self.remote.update({'https://example.test/missing': OSError('synthetic failure'),
                            'https://example.test/third': b'third-image'})
        response = self.invoke({'items': [self.inline(), {'url': 'https://example.test/missing'},
                                          {'url': 'https://example.test/third'}]})
        self.assert_rejected(response)
        self.assertEqual(self.fetched, ['https://example.test/missing'])

    def test_empty_remote_image_is_not_silently_skipped(self):
        self.remote['https://example.test/empty'] = b''
        response = self.invoke({'items': [self.inline(), {'url': 'https://example.test/empty'}]})
        self.assert_rejected(response)

    def test_missing_gallery_image_rejects_the_whole_selection(self):
        response = self.invoke({'items': [self.inline(), {'id': 'missing-gallery-image'}]})
        self.assert_rejected(response)

    def test_gallery_read_failure_cannot_leave_a_successful_partial_response(self):
        Path(self.gallery.name, 'unreadable.png').write_bytes(b'gallery-image')
        with mock.patch('builtins.open', side_effect=OSError('synthetic read failure')):
            response = self.invoke({'items': [self.inline(), {'id': 'unreadable'}]})
        self.assert_rejected(response)

    def test_metadata_failure_in_middle_rejects_without_writing_a_zip(self):
        def strip(data):
            if data == b'uncleanable':
                raise ValueError('synthetic invalid image')
            return data
        namespace['strip_ai_meta'] = strip
        response = self.invoke({'items': [self.inline(), self.inline(b'uncleanable'), self.inline(b'third-image')]})
        self.assert_rejected(response)

    def test_mixed_sources_keep_request_order_names_and_image_bytes(self):
        Path(self.gallery.name, 'gallery-second.png').write_bytes(b'second-image')
        self.remote['https://example.test/third'] = b'third-image'
        items = [self.inline(b'first-image', 'Ảnh bìa'),
                 {'id': 'gallery-second', 'name': '../Áo nam'},
                 {'url': 'https://example.test/third', 'name': 'Áo nữ'}]
        with self.archive(self.invoke({'items': items})) as archive:
            names = archive.namelist()
            self.assertEqual(names, ['01-Ảnh-bìa.png', '02-Áo-nam.png', '03-Áo-nữ.png'])
            self.assertEqual([archive.read(name) for name in names], [b'first-image', b'second-image', b'third-image'])
        self.assertEqual(self.cleaned, [b'first-image', b'second-image', b'third-image'])
        self.assertEqual(self.fetched, ['https://example.test/third'])


if __name__ == '__main__':
    unittest.main()

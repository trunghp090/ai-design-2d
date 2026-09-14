import io
import json
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

import server


class Request:
    json = lambda self, code, body: (code, body)


class CloneModelTests(unittest.TestCase):
    def setUp(self):
        for name, value in {
            'API_KEY': 'test', 'MODEL': 'gpt-image-2',
            'CLONE_IMAGE_MODEL': 'gpt-image-2.5-sunburst',
            'CLONE_IMAGE_QUALITY': 'high', 'NATIVE_TRANSPARENT': True,
            'HAS_PIL': False,
        }.items():
            p = patch.object(server, name, value)
            p.start()
            self.addCleanup(p.stop)

    def test_sync_clone_ignores_old_global_and_records_actual_model(self):
        requests = []

        def response(req, **kwargs):
            requests.append(req)
            return json.dumps({'data': [{'b64_json': 'aW1hZ2U='}]})

        with patch.object(server, '_openai_call', side_effect=response), \
                patch.object(server, 'gallery_add', return_value={'id': 'clone'}) as gallery:
            status, body = server.Handler.handle_generate(Request(), {
                'images': ['data:image/png;base64,c291cmNl'],
                'mode': 'cloner', 'prompt': 'Đổi THẢO NHI thành NHUNG HỒNG, giữ nguyên font.',
                'size': 'portrait', 'transparent': True,
            })
        self.assertEqual(status, 200)
        fields = requests[0].data.decode()
        self.assertIn('name="model"\r\n\r\ngpt-image-2.5-sunburst', fields)
        self.assertIn('name="quality"\r\n\r\nhigh', fields)
        self.assertIn('NHUNG HỒNG', fields)
        self.assertIn('letterforms', fields)
        self.assertEqual(body['model'], 'gpt-image-2.5-sunburst')
        self.assertEqual(body['quality'], 'high')
        self.assertEqual(gallery.call_args.args[1]['model'], body['model'])

    def test_async_worker_has_same_model_and_quality(self):
        job = {'items': [], 'done': 0, 'finished': False}
        with patch.dict(server.BATCH_JOBS, {'clone-model-test': job}), \
                patch.object(server, 'openai_edit', return_value='aW1hZ2U=') as edit, \
                patch.object(server, 'gallery_add', return_value={'id': 'clone'}) as gallery:
            server.run_generate_job('clone-model-test', [(b'source', 'image/png')],
                                    'cloner', 'Đổi tên thành Nhung Hồng.',
                                    '1024x1536', True, '')
        self.assertTrue(job['finished'])
        self.assertEqual(job['done'], 1)
        self.assertEqual(edit.call_args.kwargs, {
            'native_transparent': True, 'quality': 'high', 'model': 'gpt-image-2.5-sunburst',
        })
        self.assertEqual(job['items'][0]['model'], gallery.call_args.args[1]['model'])
        self.assertEqual(job['items'][0]['quality'], 'high')

    def test_transparency_fallback_keeps_model_quality_and_custom_prompt(self):
        error = urllib.error.HTTPError('https://example.invalid', 400, 'Bad Request', {},
                                       io.BytesIO(b'background transparent is unsupported'))
        with patch.object(server, 'openai_edit', side_effect=[error, 'image']) as edit:
            image, used = server.gen_design([(b'source', 'image/png')], 'cloner', '',
                '1024x1536', True, override='My exact custom prompt',
                quality='high', model=server.CLONE_IMAGE_MODEL)
        self.assertEqual(image, 'image')
        self.assertEqual(used, 'My exact custom prompt')
        self.assertEqual(edit.call_count, 2)
        for call in edit.call_args_list:
            self.assertEqual(call.args[1], used)
            self.assertEqual(call.kwargs['model'], 'gpt-image-2.5-sunburst')
            self.assertEqual(call.kwargs['quality'], 'high')
        self.assertTrue(edit.call_args_list[0].kwargs['native_transparent'])
        self.assertFalse(edit.call_args_list[1].kwargs['native_transparent'])

    def test_model_error_is_not_silently_rerouted(self):
        error = urllib.error.HTTPError('https://example.invalid', 400, 'Bad Request', {},
                                       io.BytesIO(b'model unavailable'))
        with patch.object(server, 'openai_edit', side_effect=error) as edit:
            with self.assertRaises(urllib.error.HTTPError):
                server.gen_design([], 'cloner', '', '1024x1536', True,
                                  quality='high', model=server.CLONE_IMAGE_MODEL)
        self.assertEqual(edit.call_count, 1)

    def test_shared_generator_retains_existing_defaults_for_other_callers(self):
        with patch.object(server, '_openai_call', return_value=json.dumps({
                'data': [{'b64_json': 'image'}]})) as call:
            server.gen_design([(b'source', 'image/png')], 'cloner', '', '1024x1024', False)
        fields = call.call_args.args[0].data.decode()
        self.assertIn('name="model"\r\n\r\ngpt-image-2\r\n', fields)
        self.assertNotIn('name="quality"', fields)

    def test_compare_fix_preserves_requested_name_and_font(self):
        changes = 'Đổi THẢO NHI thành NHUNG HỒNG, giữ nguyên font.'
        with patch.object(server, 'openai_chat', return_value=json.dumps({
                'match': False, 'differences': ['Font chưa giống'],
                'fix': 'Restore the original letterform style.'})) as chat, \
                patch.object(server, 'openai_edit', return_value='fixed') as edit:
            result, info = server.clone_compare_fix(b'source', b'result', user_prompt=changes)
        self.assertEqual(result, 'fixed')
        messages = chat.call_args.args[0]
        self.assertIn(changes, messages[1]['content'][0]['text'])
        self.assertIn('KHÔNG yêu cầu đổi về tên gốc', messages[0]['content'])
        self.assertIn(changes, edit.call_args.args[1])
        self.assertIn('Do not revert an intentionally replaced name', edit.call_args.args[1])
        self.assertIn('letterforms', edit.call_args.args[1])
        self.assertEqual(edit.call_args.kwargs['model'], 'gpt-image-2.5-sunburst')
        self.assertEqual(edit.call_args.kwargs['quality'], 'high')

    def test_compare_endpoint_forwards_requested_changes_and_normalizes_size(self):
        with patch.object(server, 'clone_compare_fix', return_value=('fixed', {})) as compare, \
                patch.object(server, 'gallery_add', return_value={'id': 'fix'}):
            status, body = server.Handler.handle_clone_check(Request(), {
                'original': 'data:image/png;base64,c291cmNl',
                'result': 'data:image/png;base64,cmVzdWx0',
                'size': 'portrait', 'user_prompt': 'Đổi tên thành Nhung Hồng.',
            })
        self.assertEqual(status, 200)
        compare.assert_called_once_with(b'source', b'result', '1024x1536',
                                        user_prompt='Đổi tên thành Nhung Hồng.')
        self.assertEqual(body['model'], 'gpt-image-2.5-sunburst')
        self.assertEqual(body['quality'], 'high')

    def test_status_and_version_distinguish_global_and_clone_model(self):
        with patch.object(server.studio_assistant, 'route', return_value=False), \
                patch.object(server.photo_studio, 'route', return_value=False), \
                patch.object(server.roundup, 'route', return_value=False):
            for path in ['/api/status', '/api/version']:
                request = Request()
                request.path = path
                status, body = server.Handler.do_GET(request)
                self.assertEqual(status, 200)
                self.assertEqual(body['clone_image_model'], 'gpt-image-2.5-sunburst')
                self.assertEqual(body['clone_image_quality'], 'high')
                self.assertEqual(body.get('model', body.get('image_model')), 'gpt-image-2')

    def test_gallery_persists_actual_model_and_quality(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(server, 'GALLERY_DIR', directory), \
                patch.object(server, 'gallery_load', return_value=[]), \
                patch.object(server, 'gallery_save_index') as save:
            item = server.gallery_add('aW1hZ2U=', {
                'mode': 'cloner', 'prompt': 'Đổi tên thành Nhung Hồng.',
                'model': 'gpt-image-2.5-sunburst', 'quality': 'high',
            })
        self.assertEqual(item['model'], 'gpt-image-2.5-sunburst')
        self.assertEqual(item['quality'], 'high')
        self.assertEqual(save.call_args.args[0][0], item)


if __name__ == '__main__':
    unittest.main()

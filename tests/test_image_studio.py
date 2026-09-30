import unittest
import io
import json
import urllib.error
from unittest.mock import patch
import server

class Request:
    current_user = lambda self: {'email': 'test@example.invalid'}
    json = lambda self, code, body: (code, body)

class ImageStudioTests(unittest.TestCase):
    def call(self, **changes):
        body = dict(prompt='A green forest', engine='openai', aspect='1:1', count=1, images=[])
        body.update(changes)
        return server.Handler.handle_image_studio_generate(Request(), body)

    def test_permission(self):
        with patch.object(server, 'user_has_tab', return_value=False):
            self.assertEqual(self.call()[0], 403)

    @patch.object(server, 'user_has_tab', return_value=True)
    @patch.object(server, 'engines_status', return_value=[{'id':'openai','available':True}])
    def test_validation_and_prompt_job(self, *_):
        for invalid in ({'prompt':''}, {'count':8}, {'engine':'unknown'}, {'aspect':'bad'}, {'images':['https://example.com/a.png']}):
            self.assertEqual(self.call(**invalid)[0], 400)
        with patch.object(server.threading, 'Thread') as thread:
            status, result = self.call()
            self.assertEqual(status, 200)
            args = thread.call_args.kwargs['args']
            self.assertEqual(args[1], [])
            self.assertEqual(args[2], 'A green forest')
            self.assertEqual(args[-1], 'imagegen')
            server.BATCH_JOBS.pop(result['job_id'])

    def test_worker_keeps_full_prompt_and_separate_history(self):
        prompt = 'A detailed landscape ' * 20
        job = {'total':1,'done':0,'items':[],'errors':[],'finished':False}
        with patch.dict(server.BATCH_JOBS, {'test_ig':job}), patch.object(server,'gen_shot',return_value='ZmFrZQ=='), patch.object(server,'crop_to_aspect',return_value=b'fake'), patch.object(server,'gallery_add',return_value={'id':'test','url':'/gallery/test.png'}) as save:
            server.run_prod_gen_job('test_ig', [], prompt, 'openai', '1:1', 1, 'imagegen')
            self.assertTrue(job['finished'])
            self.assertEqual(job['done'],1)
            self.assertNotIn('image',job['items'][0])
            self.assertEqual(job['items'][0]['url'],'/gallery/test.png')
            self.assertEqual(save.call_args.args[1]['mode'],'imagegen')
            self.assertEqual(save.call_args.args[1]['prompt'],prompt)

    def test_fast_image_is_published_while_first_image_is_still_running(self):
        import threading
        release = threading.Event()
        published = threading.Event()
        calls = iter(range(2))
        class Items(list):
            def append(self, value):
                super().append(value)
                published.set()
        job = {'total':2,'done':0,'items':Items(),'errors':[],'finished':False}
        def generate(*args, **kwargs):
            if next(calls) == 0:
                if not release.wait(5):
                    raise RuntimeError('Test did not release first image')
            return 'ZmFrZQ=='
        with patch.dict(server.BATCH_JOBS, {'timing':job}), patch.object(server,'gen_shot',side_effect=generate), patch.object(server,'crop_to_aspect',return_value=b'fake'), patch.object(server,'gallery_add',return_value={'id':'test','url':'/gallery/test.png'}):
            worker = threading.Thread(target=server.run_prod_gen_job, args=('timing', [], 'prompt', 'gemini_pro', '3:4', 2, 'imagegen'))
            worker.start()
            try:
                self.assertTrue(published.wait(2), 'Fast image waited for slow first image')
                self.assertEqual(job['done'],1)
                self.assertFalse(job['finished'])
                self.assertIn('provider_seconds',job['items'][0]['timing'])
            finally:
                release.set()
                worker.join(5)
            self.assertFalse(worker.is_alive())
            self.assertTrue(job['finished'])
            self.assertEqual(job['done'],2)

class ImageProviderTests(unittest.TestCase):
    def test_gemini_403_names_actual_provider_and_worker_finishes(self):
        error = urllib.error.HTTPError(
            'https://generativelanguage.googleapis.com/v1beta/models/test:generateContent',
            403, 'Forbidden', {}, io.BytesIO(json.dumps({'error': {
                'message': 'Your project has been denied access. Please contact support.'
            }}).encode()))
        job = {'total':1,'done':0,'items':[],'errors':[],'finished':False}
        with patch.dict(server.BATCH_JOBS, {'denied':job}), \
                patch.object(server,'gen_shot',side_effect=error), \
                patch.object(server,'gallery_add') as save:
            server.run_prod_gen_job('denied', [], 'A forest', 'gemini_pro', '3:4', 1, 'imagegen')
        self.assertTrue(job['finished'])
        self.assertEqual(job['done'], 1)
        self.assertEqual(job['items'], [])
        self.assertIn('Google Gemini (403)', job['errors'][0])
        self.assertIn('Project API', job['errors'][0])
        self.assertNotIn('OpenAI', job['errors'][0])
        save.assert_not_called()

    def test_nano_banana_2_uses_its_exact_google_model_with_references(self):
        refs = [(b'reference', 'image/png')]
        with patch.object(server,'GEMINI_API_KEY','test'), patch.object(server,'GEMINI_IMAGE_MODEL','custom-pro'), patch.object(server,'gemini_edit',return_value='image') as google, patch.object(server,'openai_generate') as openai:
            self.assertEqual(server.gen_shot(refs,'prompt','1024x1536','gemini_2','3:4',lock=False),'image')
            google.assert_called_once_with(refs,'prompt','3:4','gemini-3.1-flash-image')
            openai.assert_not_called()
            self.assertEqual(server.resolve_engine_id({'engine':'gemini_2'}),'gemini_2')
            self.assertEqual(server.engine_model_label('gemini_2'),'gemini-3.1-flash-image')
        with patch.object(server,'GEMINI_API_KEY',''), patch.object(server,'gemini_edit') as google:
            self.assertFalse(next(e for e in server.engines_status() if e['id']=='gemini_2')['available'])
            with self.assertRaisesRegex(RuntimeError,'GEMINI_API_KEY'):
                server.gen_shot([], 'prompt', '1024x1024', 'gemini_2')
            google.assert_not_called()

    def test_previous_preview_setting_migrates_but_custom_models_are_preserved(self):
        for old in (None, '', 'gemini-3-pro-image-preview', ' gemini-3-pro-image-preview '):
            self.assertEqual(server.resolve_gemini_image_model(old), 'gemini-3-pro-image')
        self.assertEqual(server.resolve_gemini_image_model('custom-model'), 'custom-model')

    def test_provider_timeout_finishes_with_clear_message(self):
        job = {'total':1,'done':0,'items':[],'errors':[],'finished':False}
        with patch.dict(server.BATCH_JOBS, {'timeout':job}), patch.object(server,'gen_shot',side_effect=TimeoutError('The read operation timed out')):
            server.run_prod_gen_job('timeout', [], 'prompt', 'gemini_pro', '3:4', 1, 'imagegen')
        self.assertTrue(job['finished'])
        self.assertIn('Google Gemini',job['errors'][0])
        self.assertIn('Quá thời gian',job['errors'][0])

    def test_missing_selected_key_never_calls_other_provider(self):
        with patch.object(server,'GEMINI_API_KEY',''), patch.object(server,'API_KEY','test'), \
                patch.object(server,'openai_generate') as generate, \
                patch.object(server,'openai_edit') as edit:
            self.assertEqual(server.resolve_engine_id({'engine':'gemini_pro'}), 'gemini_pro')
            self.assertEqual(server.resolve_engine_id({'nano':True}), 'gemini_pro')
            for refs in ([], [(b'input','image/png')]):
                with self.assertRaisesRegex(RuntimeError, 'GEMINI_API_KEY'):
                    server.gen_shot(refs,'prompt','1024x1536','gemini_pro')
            generate.assert_not_called();edit.assert_not_called()
        with patch.object(server,'API_KEY',''), patch.object(server,'GEMINI_API_KEY','test'), \
                patch.object(server,'gemini_edit') as gemini:
            self.assertEqual(server.resolve_engine_id({'engine':'openai_25'}), 'openai_25')
            with self.assertRaisesRegex(RuntimeError, 'OPENAI_API_KEY'):
                server.gen_shot([],'prompt','1024x1536','openai_25')
            gemini.assert_not_called()

    def test_selected_gemini_model_and_refs_reach_google(self):
        payload = {'candidates':[{'content':{'parts':[{'inlineData':{'data':'aW1hZ2U='}}]}}]}
        with patch.object(server,'GEMINI_API_KEY','test'), \
                patch.object(server,'GEMINI_IMAGE_MODEL','gemini-3-pro-image'), \
                patch.object(server,'_gemini_call',return_value=json.dumps(payload)) as call, \
                patch.object(server,'strip_ai_meta_b64',side_effect=lambda b:b), \
                patch.object(server,'openai_edit') as openai:
            result = server.gen_shot([(b'ref','image/png')],'My prompt','1024x1536','gemini_pro','3:4',lock=False)
        self.assertEqual(result,'aW1hZ2U=')
        req = call.call_args.args[0]
        self.assertEqual(req.full_url,'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent')
        body = json.loads(req.data)
        self.assertEqual(body['generationConfig']['imageConfig']['aspectRatio'],'3:4')
        self.assertEqual(body['contents'][0]['parts'][1]['inline_data']['data'],'cmVm')
        self.assertEqual(body['contents'][0]['parts'][-1]['text'],'My prompt')
        openai.assert_not_called()

    def test_401_and_429_are_not_conflated_with_project_denial(self):
        for code, expected in ((401,'API key không hợp lệ'),(429,'hạn mức')):
            error = urllib.error.HTTPError('https://api.openai.com/v1/images/edits',code,'error',{},io.BytesIO(b'{}'))
            message = server.openai_error_message(error)
            self.assertIn('OpenAI',message)
            self.assertIn(expected,message)
            self.assertNotIn('Project API bị',message)

if __name__ == '__main__': unittest.main()

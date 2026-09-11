import unittest
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
        with patch.dict(server.BATCH_JOBS, {'test_ig':job}), patch.object(server,'gen_shot',return_value='ZmFrZQ=='), patch.object(server,'crop_to_aspect',return_value=b'fake'), patch.object(server,'gallery_add',return_value={'id':'test'}) as save:
            server.run_prod_gen_job('test_ig', [], prompt, 'openai', '1:1', 1, 'imagegen')
            self.assertTrue(job['finished'])
            self.assertEqual(job['done'],1)
            self.assertEqual(save.call_args.args[1]['mode'],'imagegen')
            self.assertEqual(save.call_args.args[1]['prompt'],prompt)

if __name__ == '__main__': unittest.main()

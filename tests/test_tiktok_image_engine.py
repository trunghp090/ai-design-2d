import unittest,json
from unittest.mock import patch
import server

class ImageEngineTests(unittest.TestCase):
    def test_gemini_exact_model(self):
        with patch.object(server,'GEMINI_API_KEY','test'),patch.object(server,'GEMINI_IMAGE_MODEL','other'),patch.object(server,'gemini_edit',return_value='image') as gem,patch.object(server,'openai_generate') as op:
            self.assertEqual(server._tiktok_render_slide('prompt','gemini_pro'),'image')
            gem.assert_called_once_with([], 'prompt','3:4','gemini-3-pro-image-preview');op.assert_not_called()
    def test_image25_ignores_global_model(self):
        with patch.object(server,'API_KEY','test'),patch.object(server,'MODEL','gpt-image-2'),patch.object(server,'HAS_PIL',False),patch.object(server,'openai_generate',return_value='image') as op,patch.object(server,'gemini_edit') as gem:
            server._tiktok_render_slide('prompt','gpt_image_25')
            op.assert_called_once_with('prompt','1024x1536',model='gpt-image-2.5-sunburst');gem.assert_not_called()
    def test_bonus_uses_image25_edit(self):
        ref=(b'img','image/png')
        with patch.object(server,'API_KEY','test'),patch.object(server,'HAS_PIL',False),patch.object(server,'openai_edit',return_value='image') as edit:
            server._tiktok_render_slide('prompt','gpt_image_25',ref)
            edit.assert_called_once_with([ref],'prompt','1024x1536',native_transparent=False,quality='high',model='gpt-image-2.5-sunburst')
    def test_no_fallback_on_error(self):
        with patch.object(server,'GEMINI_API_KEY','test'),patch.object(server,'gemini_edit',side_effect=RuntimeError('failed')),patch.object(server,'openai_generate') as op:
            with self.assertRaises(RuntimeError):server._tiktok_render_slide('p','gemini_pro')
            op.assert_not_called()
    def test_missing_selected_key_and_invalid(self):
        with patch.object(server,'GEMINI_API_KEY',''),patch.object(server,'API_KEY','test'):
            for engine in ['gemini_pro','invalid',[],None]:
                with self.assertRaises(ValueError):server.tiktok_image_engine(engine)
    def test_job_carries_selection_to_every_slide(self):
        jid='test-model';server.BATCH_JOBS[jid]={'items':[],'errors':[],'done':0,'finished':False}
        plan={'hook':{'prompt':'h'},'slides':[{'prompt':'p','product':'x'}]*4}
        try:
            with patch.object(server,'tiktok_gift_plan',return_value=plan),patch.object(server,'_tiktok_render_slide',return_value='a') as render,patch.object(server,'strip_ai_meta_b64',side_effect=lambda x:x),patch.object(server,'gallery_add',return_value={}):
                server.run_tiktok_job(jid,'','nam','kol_mid',4,gift_ids=[],engine='gpt_image_25')
                self.assertEqual(render.call_count,5)
                self.assertTrue(all(c.args[1]=='gpt_image_25' for c in render.call_args_list))
                self.assertEqual(json.loads(server.BATCH_JOBS[jid]['note'])['engine'],'GPT Image 2.5 Sunburst')
        finally:server.BATCH_JOBS.pop(jid,None)

    def test_pair_references_reach_both_providers_in_order(self):
        refs = [(b'left', 'image/png'), (b'right', 'image/jpeg')]
        with patch.object(server,'GEMINI_API_KEY','test'), patch.object(server,'gemini_edit',return_value='img') as gem:
            server._tiktok_render_slide('pair', 'gemini_pro', refs)
            gem.assert_called_once_with(refs, 'pair', '3:4', 'gemini-3-pro-image-preview')
        with patch.object(server,'API_KEY','test'), patch.object(server,'HAS_PIL',False), patch.object(server,'openai_edit',return_value='img') as edit:
            server._tiktok_render_slide('pair', 'gpt_image_25', refs)
            self.assertEqual(edit.call_args.args[0], refs)

    def test_bonus_pair_preserves_reference_order_and_names(self):
        jid='pair-test'; server.BATCH_JOBS[jid]={'items':[],'errors':[],'done':0,'finished':False}
        left=(b'left','image/png');right=(b'right','image/png')
        try:
            with patch.object(server,'claude_vision_multi',return_value='Precise pair prompt. '*10) as claude, patch.object(server,'_tiktok_render_slide',return_value='a') as render, patch.object(server,'strip_ai_meta_b64',side_effect=lambda x:x), patch.object(server,'gallery_add',return_value={}):
                server.run_tiktok_bonus_job(jid,left,['','Nam'],[],right_ref=right)
                self.assertEqual(claude.call_args.args[2],[b'left',b'right'])
                self.assertEqual(render.call_args.args[2],[left,right])
                prompt=render.call_args.args[0]
                self.assertIn('RIGHT garment: replace only',prompt)
                self.assertNotIn('LEFT garment: replace only',prompt)
                self.assertEqual(len(server.BATCH_JOBS[jid]['items']),1)
        finally:server.BATCH_JOBS.pop(jid,None)

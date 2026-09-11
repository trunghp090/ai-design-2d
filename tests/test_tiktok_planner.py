import json
import unittest
from unittest.mock import patch

import server


class CatalogPlannerTests(unittest.TestCase):
    def setUp(self):
        self.ids = ['soundcore-space-one', 'davidoff-cool-water', 'hario-v60-set', 'casio-gshock']
        self.gifts = server.kol_gift_selection(self.ids, 'nam', 'kol_mid')
        self.plan = {
            'concept': 'mood',
            'hook': {'scene_kind': 'couple', 'prompt': 'Couple scene', 'overlay': ['Sinh nhật ảnh', 'Lướt xem quà']},
            'slides': [{'gift_id': g['key'], 'prompt': 'Product scene', 'overlay': [g['label'], 'Hợp gu của ảnh']}
                       for g in self.gifts],
        }

    def test_openai_without_anthropic_keeps_catalog_and_locks(self):
        with patch.object(server, 'API_KEY', 'test'), patch.object(server, 'ANTHROPIC_API_KEY', ''), \
             patch.object(server, 'openai_chat', return_value=json.dumps(self.plan)) as chat, \
             patch.object(server, 'claude_text') as claude:
            result = server.tiktok_gift_plan('Sinh nhật', 'nam', 'kol_mid', 4, 'mood', self.ids)
        claude.assert_not_called()
        supplied = json.loads(chat.call_args.args[0][1]['content'])
        self.assertEqual([g['key'] for g in supplied['selected_gifts']], self.ids)
        self.assertTrue(chat.call_args.kwargs['json_mode'])
        for slide, gift in zip(result['slides'], self.gifts):
            self.assertEqual(slide['source_url'], gift['sourceUrl'])
            self.assertIn('EXACT PRODUCT LOCK: ' + gift['label'], slide['prompt'])

    def test_rejects_model_changing_selected_product(self):
        self.plan['slides'][0]['gift_id'] = 'unselected-product'
        with patch.object(server, 'API_KEY', 'test'), \
             patch.object(server, 'openai_chat', return_value=json.dumps(self.plan)):
            with self.assertRaisesRegex(RuntimeError, 'lệch sản phẩm'):
                server.tiktok_gift_plan('', 'nam', 'kol_mid', 4, 'mood', self.ids)

    def test_requires_openai_even_when_claude_is_configured(self):
        with patch.object(server, 'API_KEY', ''), patch.object(server, 'ANTHROPIC_API_KEY', 'test'), \
             patch.object(server, 'openai_chat') as chat:
            with self.assertRaisesRegex(RuntimeError, 'OpenAI'):
                server.tiktok_gift_plan('', 'nam', 'kol_mid', 4, 'mood', self.ids)
        chat.assert_not_called()

import unittest,json
from unittest.mock import patch
from kol_gifts import CATALOG,selection

MID=['aristino-wallet','casio-gshock','davidoff-cool-water','jbl-flip-7']
class KolTests(unittest.TestCase):
    def test_catalog_identity(self):
        self.assertEqual(len(CATALOG),63)
        self.assertEqual(len({g['brand'] for g in CATALOG}),56)
        self.assertTrue(all(g['sourceUrl'].startswith('https://') for g in CATALOG))
    def test_exact_products(self):
        self.assertEqual([g['key'] for g in selection(MID,'nam','kol_mid')],MID)
    def test_wrong_recipient_and_segment(self):
        with self.assertRaises(ValueError):selection(MID,'nu','kol_mid')
        with self.assertRaises(ValueError):selection(MID,'nam','kol_luxury')
    def test_watch_types_are_not_distinct(self):
        with self.assertRaises(ValueError):selection(['casio-gshock','orient-bambino','davidoff-cool-water','jbl-flip-7'],'nam','kol_mid')
    def test_invalid_and_old_client(self):
        for ids,tier in [(MID,'budget'),(MID[:3],'kol_mid'),(MID[:3]+['orion'],'kol_mid'),(MID[:3]+[MID[0]],'kol_mid')]:
            with self.assertRaises(ValueError):selection(ids,'nam',tier)
    def test_coach_recipient_per_model(self):
        rows={g['key']:g for g in CATALOG}
        self.assertEqual(rows['coach-tabby']['recipient'],'girlfriend')
        self.assertEqual(rows['coach-wallet']['recipient'],'boyfriend')
    def test_plan_uses_catalog_no_web(self):
        import server
        slides=[{'gift_id':g['key'],'prompt':'photo','overlay':['Top %d: %s'%(4-i,g['label']),'Nhận xét']} for i,g in enumerate(selection(MID,'nam','kol_mid'))]
        with patch.object(server,'ANTHROPIC_API_KEY','test'), patch.object(server,'claude_text',return_value=json.dumps({'concept':'countdown','hook':{'scene_kind':'couple','prompt':'couple','overlay':['Hook','Lướt nhé']},'slides':slides})), patch.object(server,'openai_web_search',side_effect=AssertionError('must not search')):
            plan=server.tiktok_gift_plan('Trung thu','nam','kol_mid',4,'auto',MID)
            self.assertEqual(plan['slides'][0]['product'],selection(MID,'nam','kol_mid')[0]['label'])
            self.assertIn('EXACT PRODUCT LOCK',plan['slides'][0]['prompt'])
    def test_wrong_model_response_stops(self):
        import server
        slides=[{'gift_id':'orion','prompt':'photo'}]*4
        with patch.object(server,'ANTHROPIC_API_KEY','test'), patch.object(server,'claude_text',return_value=json.dumps({'hook':{'prompt':'hook'},'slides':slides})):
            with self.assertRaises((RuntimeError,ValueError)):server.tiktok_gift_plan('','nam','kol_mid',4,'auto',MID)

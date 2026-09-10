import unittest
from kol_gifts import selection
from tiktok_story import SYSTEM,validate_setup,validate_plan

class StoryTests(unittest.TestCase):
    def setUp(self):
        self.gifts=selection(['aristino-wallet','casio-gshock','davidoff-cool-water','jbl-flip-7'],'nam','kol_mid')
    def plan(self,concept):
        overlays={
            'countdown':lambda i,g:['Top %d: %s'%(4-i,g['label']),'Nhận xét'],
            'upgrade':lambda i,g:['❌ Món thường cùng loại','✅ '+g['label'],'Hợp gu hơn'],
            'compare':lambda i,g:['Món thường vs '+g['label'],'Khác thiết kế'],
            'mood':lambda i,g:[g['label'],'Hợp dịp sinh nhật'],
            'category':lambda i,g:[g['label'],'Gợi ý công nghệ'],
        }
        return {'concept':concept,'hook':{'scene_kind':'couple','overlay':['Hook trước','Lướt xem quà']},'slides':[{'overlay':overlays[concept](i,g)} for i,g in enumerate(self.gifts)]}
    def test_all_structures(self):
        for c in ['countdown','upgrade','compare','mood']:
            self.assertEqual(validate_plan(self.plan(c),self.gifts,c),c)
            self.assertEqual(validate_plan(self.plan(c),self.gifts,'auto'),c)
    def test_upgrade_requires_both_lines(self):
        p=self.plan('upgrade');p['slides'][0]['overlay'][0]='Món thường'
        with self.assertRaises(ValueError):validate_plan(p,self.gifts,'upgrade')
    def test_compare_requires_two_sides(self):
        p=self.plan('compare');p['slides'][0]['overlay'][0]=self.gifts[0]['label']
        with self.assertRaises(ValueError):validate_plan(p,self.gifts,'compare')
    def test_hook_is_separate(self):
        p=self.plan('countdown');p['hook']['scene_kind']='gift-lineup'
        with self.assertRaises(ValueError):validate_plan(p,self.gifts,'countdown')
        self.assertIn('Hook KHÔNG phải ảnh bày 4 sản phẩm',SYSTEM)
    def test_category_rejects_mixed(self):
        with self.assertRaises(ValueError):validate_setup(self.gifts,'category')
    def test_tech_category_accepts_different_types(self):
        gifts=selection(['phone','camera','headphones','laptop'],'nam','kol_premium')
        validate_setup(gifts,'category')
    def test_requested_concept_cannot_change(self):
        with self.assertRaises(ValueError):validate_plan(self.plan('countdown'),self.gifts,'upgrade')

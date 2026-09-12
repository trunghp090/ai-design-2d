import unittest
from roundup import plans_for

class ScenarioTests(unittest.TestCase):
    def spec(self,scenario,cover=True):
        return {'scenario':scenario,'cover':cover,'paired':True,'products':[{'scene':'mannequin'},{'scene':'solo'}]}
    def scenes(self,spec):return [scene for _,scene,_ in plans_for(spec)]
    def test_flatlay_never_adds_people_even_with_cover_and_old_paired_flag(self):
        self.assertEqual(self.scenes(self.spec('flatlay')),['flatlay']*3)
    def test_mixed_pairs_every_product_with_flatlay(self):
        self.assertEqual(self.scenes(self.spec('mixed')),['couple','couple','flatlay','solo','flatlay'])
    def test_people_contains_only_wearers(self):
        self.assertEqual(self.scenes(self.spec('people')),['couple','couple','solo'])
    def test_no_cover_and_legacy_custom(self):
        self.assertEqual(self.scenes(self.spec('mixed',False)),['couple','flatlay','solo','flatlay'])
        s=self.spec('custom');s.pop('scenario')
        self.assertEqual(self.scenes(s),['couple','mannequin','flatlay','solo','flatlay'])

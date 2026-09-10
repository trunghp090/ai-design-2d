import unittest
from tiktok_gifts import validate_variety

def gifts():
    return [dict(product='Món '+str(i), brand='Brand '+str(i), family='Family '+str(i), category=c,
                 source_url='https://shop%d.vn/product%d'%(i,i))
            for i,c in enumerate(['tech','fashion','beauty','home'])]

class VarietyTests(unittest.TestCase):
    def test_diverse_gifts(self): validate_variety(gifts(), 'auto')
    def test_food_screenshot_regression(self):
        s=gifts();s[0]['product']='Minaco Gift – Set bánh Orion Bình An 1'
        with self.assertRaises(ValueError):validate_variety(s,'auto')
    def test_repeated_brand(self):
        s=gifts()
        for x in s:x['brand']='Acme'
        with self.assertRaises(ValueError):validate_variety(s,'auto')
    def test_same_product_different_size(self):
        s=gifts();s[1].update(brand=s[0]['brand'],family=s[0]['family'])
        with self.assertRaises(ValueError):validate_variety(s,'auto')
    def test_same_source_tracking_query(self):
        s=gifts();s[1]['source_url']=s[0]['source_url']+'?variant=2'
        with self.assertRaises(ValueError):validate_variety(s,'auto')
    def test_one_shop(self):
        s=gifts()
        for i,x in enumerate(s):x['source_url']='https://shop.vn/'+str(i)
        with self.assertRaises(ValueError):validate_variety(s,'auto')
    def test_category_exception_only_when_selected(self):
        s=gifts()
        for x in s:x['category']='tech'
        validate_variety(s,'category')
        with self.assertRaises(ValueError):validate_variety(s,'auto')

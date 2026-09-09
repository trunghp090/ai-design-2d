import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from studio_assistant import validate_action
class AssistantTests(unittest.TestCase):
 def test_arbitrary_actions_denied(self):
  for a in [{'type':'shell','command':'anything'},{'type':'publish'},{'type':'open','tool':'admin'}]:
   with self.assertRaises(ValueError):validate_action(a,[],[])
 def test_nonexistent_image_denied(self):
  a={'type':'zalo','slides':[{'messages':[{'side':'in','text':'Ảnh','image_indices':[1]}]}]}
  with self.assertRaises(ValueError):validate_action(a,['one'],[])
 def test_real_images_accepted(self):
  a={'type':'zalo','slides':[{'title':'Ảnh khách','messages':[{'side':'in','text':'Giúp em ạ','image_indices':[0],'time':'21:03'}]}]}
  self.assertEqual(validate_action(a,['one'],[])['name'],'Khách đặt áo')
 def test_hallucinated_product_denied(self):
  a={'type':'roundup','products':[{'handle':'invented','image_index':0}]}
  with self.assertRaises(ValueError):validate_action(a,[],[])
if __name__=='__main__':unittest.main()

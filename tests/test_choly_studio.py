import base64,io,tempfile,unittest
from types import SimpleNamespace
from unittest.mock import Mock,patch
from PIL import Image
import choly_studio as p
import roundup
class CholyTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
  buf=io.BytesIO();Image.new('RGB',(24,32),'grey').save(buf,'PNG');self.raw=buf.getvalue();b64=base64.b64encode(self.raw).decode()
  self.app=SimpleNamespace(DATA_DIR=self.tmp.name,API_KEY='x',GEMINI_API_KEY='x',ANTHROPIC_API_KEY='x',PRODUCT_PROMPT_SYSTEM='',claude_vision_multi=Mock(return_value='Claude scene'),gemini_edit=Mock(return_value=b64),gen_shot=Mock(return_value=b64))
  self.body=dict(request_id='11111111-1111-1111-1111-111111111111',concept=1,topic='Kỷ niệm',captions=['Thương anh nhiều']*4,files={'shirt1':'data:image/png;base64,'+b64})
 def test_models_claude_proof_and_captions(self):
  with patch.object(p.threading,'Thread'):j=p.start(self.app,self.body,'one')
  j=p.read(self.app,j['id'],'one');p.run(self.app,j,p.validate(self.body))
  self.assertEqual(j['status'],'done');self.assertEqual(self.app.claude_vision_multi.call_count,4)
  self.assertEqual(self.app.gemini_edit.call_count,1);self.assertEqual(self.app.gen_shot.call_count,3)
  self.assertEqual(self.app.gemini_edit.call_args.args[3],'gemini-3-pro-image')
  for c in self.app.gen_shot.call_args_list:self.assertEqual(c.args[3],'openai_25')
  self.assertEqual(len({c.args[1] for c in self.app.claude_vision_multi.call_args_list}),4)
  for item in j['items']:
   self.assertEqual(item['base'],'Claude scene')
   with Image.open(p.folder(self.app)/item['filename']) as im:
    self.assertEqual(im.size,(1152,1536))
    self.assertEqual(len(im.getcolors(2000000))>1,item['position']!='none')
 def test_no_template_fallback(self):
  self.app.claude_vision_multi.side_effect=RuntimeError('Claude unavailable')
  with patch.object(p.threading,'Thread'):j=p.start(self.app,self.body,'one')
  with patch.object(p.time,'sleep'):p.run(self.app,j,p.validate(self.body))
  self.assertEqual(j['status'],'failed');self.assertEqual(self.app.claude_vision_multi.call_count,3);self.app.gen_shot.assert_not_called();self.app.gemini_edit.assert_not_called()
 def test_idempotency_owner_and_validation(self):
  self.assertEqual(len(p.CONCEPTS),40)
  with patch.object(p.threading,'Thread') as t:
   j=p.start(self.app,self.body,'one');p.start(self.app,self.body,'one');self.assertEqual(t.call_count,1)
  with self.assertRaises(roundup.Problem):p.read(self.app,j['id'],'two')
  with self.assertRaises(roundup.Problem):p.validate({**self.body,'files':{}})
  with self.assertRaises(roundup.Problem):p.start(self.app,{**self.body,'topic':'changed'},'one')
 def test_visual_catalog_and_per_scene_routing(self):
  self.assertEqual(len(p.PRESETS),12)
  for v in p.PRESETS:
   self.assertEqual(len(v['shots']),4)
   for scene in v['shots']:self.assertTrue((p.ROOT/'public/choly-references'/scene['reference']).is_file())
  for visual,people in [('dark-flatlay',0),('cafe-date',3),('mirror',3),('gift-unbox',1)]:
   self.app.gemini_edit.reset_mock();self.app.gen_shot.reset_mock()
   spec=p.validate({**self.body,'visual':visual});j={'id':self.body['request_id'],'items':[]}
   p.run(self.app,j,spec)
   self.assertEqual(j['status'],'done');self.assertEqual(self.app.gemini_edit.call_count,people);self.assertEqual(self.app.gen_shot.call_count,4-people)
 def test_positions_and_invalid_visual(self):
  for change in [{'visual':'bad'},{'positions':['bad']*4}]:
   with self.assertRaises(roundup.Problem):p.validate({**self.body,**change})
  clean=Image.open(io.BytesIO(p.caption_image(self.raw,'test','none')))
  self.assertEqual(len(clean.getcolors(2000000)),1)
  for pos in ['top','middle','bottom','callouts']:
   im=Image.open(io.BytesIO(p.caption_image(self.raw,'Thiệp | Áo | Quà',pos)))
   self.assertGreater(len(im.getcolors(2000000)),1)
 def test_identity_reference_is_reused_and_excluded_from_products(self):
  import hashlib
  portrait=b'identity-test-bytes'
  spec=p.validate({**self.body,'visual':'cafe-letter'})
  j={'id':self.body['request_id'],'items':[]}
  p.run(self.app,j,spec,{'male':(portrait,'image/jpeg')})
  self.assertEqual(j['status'],'done')
  self.assertEqual(self.app.gemini_edit.call_count,3)
  for call in self.app.gemini_edit.call_args_list:
   refs,prompt=call.args[:2]
   self.assertEqual(refs[0][0],self.raw)
   self.assertEqual(refs[1][0],portrait)
   self.assertIn('IDENTITY LOCK',prompt)
   self.assertIn('IDENTITY MALE ONLY',prompt)
   self.assertNotIn('Use new adult',prompt)
  for call in self.app.gen_shot.call_args_list:self.assertNotIn(portrait,[raw for raw,mime in call.args[0]])
 def test_uploaded_identity_overrides_saved_cast(self):
  spec=p.validate({**self.body,'files':{**self.body['files'],'male':self.body['files']['shirt1']}})
  with patch.object(p.roundup_cast,'people',side_effect=AssertionError('Must not load default')):
   self.assertEqual(p.identity_snapshot(spec)['male'][0],self.raw)
 def test_dialogue_requires_four_blocks(self):
  self.app.claude_text=Mock(return_value='### SLIDE 1\nAnh thích không?\n### SLIDE 2\nEm chọn cho anh đó.\n### SLIDE 3\nMai mình mặc cùng nhé.\n### SLIDE 4\nNhất trí rồi!')
  body=dict(visual='cafe-letter',concept=19,topic='Kỷ niệm',tone='Trêu yêu')
  self.assertEqual(len(p.write_dialogue(self.app,body)['captions']),4)
  self.app.claude_text.return_value='Invalid'
  with patch.object(p.time,'sleep'):
   with self.assertRaises(ValueError):p.write_dialogue(self.app,body)
if __name__=='__main__':unittest.main()

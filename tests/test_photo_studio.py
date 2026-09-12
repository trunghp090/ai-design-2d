import base64,io,json,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock,patch
from PIL import Image
import photo_studio as p
import roundup

class PhotoStudioTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
  out=io.BytesIO();Image.new('RGB',(24,32),'white').save(out,'PNG');self.raw=out.getvalue();self.image='data:image/png;base64,'+base64.b64encode(self.raw).decode()
  self.app=SimpleNamespace(DATA_DIR=self.tmp.name,API_KEY='yes',GEMINI_API_KEY='yes',gen_shot=Mock(return_value=base64.b64encode(self.raw).decode()),gemini_edit=Mock(return_value=base64.b64encode(self.raw).decode()))
  self.body={'mode':'flatlay','request_id':'11111111-1111-1111-1111-111111111111','files':{'shirt1':self.image},'shots':['hero','spread'],'concept':p.CATALOG['concepts'][0]['id']}
 def test_wearer_inputs_are_bound_and_scene_never_defines_identity(self):
  self.body.update(mode='wearer',files={'shirt1':self.image,'shirt2':self.image,'reference':self.image})
  spec=p.validate(self.body);refs,prompt=p.inputs(spec,'wearer')
  self.assertEqual(len(refs),5);self.assertEqual(refs[:2],[(self.raw,'image/png')]*2)
  self.assertIn('PRODUCT FEMALE',prompt);self.assertIn('PRODUCT MALE',prompt);self.assertIn('IDENTITY FEMALE',prompt);self.assertIn('IDENTITY MALE',prompt);self.assertIn('SCENE ONLY',prompt)
  j={'id':self.body['request_id'],'mode':'wearer','model':roundup.PEOPLE_MODEL,'aspect':'3:4','items':[],'total':1}
  p.run(self.app,j,[('wearer',refs,prompt)])
  self.app.gen_shot.assert_not_called();self.assertEqual(self.app.gemini_edit.call_args.args[3],'gemini-3-pro-image');self.assertEqual(self.app.gemini_edit.call_args.kwargs['image_size'],'4K');self.assertEqual(j['status'],'done')
 def test_flatlay_uses_chatgpt_and_distinct_shots(self):
  spec=p.validate(self.body);snapshot=[(shot,*p.inputs(spec,shot)) for shot in spec['shots']]
  self.assertNotEqual(snapshot[0][2],snapshot[1][2]);self.assertIn('PRODUCT ONLY',snapshot[0][2])
  j={'id':self.body['request_id'],'mode':'flatlay','model':'gpt-image-2.5-sunburst','aspect':'3:4','items':[],'total':2}
  p.run(self.app,j,snapshot)
  self.assertEqual(j['status'],'done');self.assertEqual(len(j['items']),2);self.app.gemini_edit.assert_not_called();self.assertEqual(self.app.gen_shot.call_args.args[3],'openai_25')
 def test_rejects_bad_images_and_missing_second_shirt(self):
  for changes in [{'files':{'shirt1':'bad'}},{'shots':['../escape']},{'concept':'../../etc/passwd'},{'mode':'wearer'}]:
   with self.assertRaises(roundup.Problem):p.validate({**self.body,**changes})
 def test_idempotency_owner_and_interrupted_state(self):
  with patch.object(p.threading,'Thread') as thread:
   j=p.start(self.app,self.body,'one');self.assertEqual(p.start(self.app,self.body,'one')['id'],j['id']);self.assertEqual(thread.call_count,1)
   with self.assertRaises(roundup.Problem):p.read(self.app,j['id'],'two')
   with self.assertRaises(roundup.Problem):p.start(self.app,{**self.body,'prompt':'changed'},'one')
  p.LIVE.discard(j['id']);self.assertEqual(p.read(self.app,j['id'],'one')['status'],'interrupted')
 def test_partial_failure_keeps_first_result_without_retry(self):
  spec=p.validate(self.body);j={'id':self.body['request_id'],'mode':'flatlay','model':'gpt-image-2.5-sunburst','aspect':'3:4','items':[],'total':2}
  self.app.gen_shot.side_effect=[base64.b64encode(self.raw).decode(),RuntimeError('uncertain')]
  p.run(self.app,j,[(s,*p.inputs(spec,s)) for s in spec['shots']]);self.assertEqual(j['status'],'failed');self.assertEqual(len(j['items']),1);self.assertEqual(self.app.gen_shot.call_count,2)
 def test_preview_free_and_tab_permissions(self):
  h=SimpleNamespace(path='/api/photo-studio/preview',current_user=lambda:None,json=Mock())
  self.app.AUTH_REQUIRED=True;self.app.user_has_tab=lambda u,t:False
  p.route(self.app,h,h.path,self.body);self.assertEqual(h.json.call_args.args[0],401)
  h.current_user=lambda:{'id':'one'};p.route(self.app,h,h.path,self.body);self.assertEqual(h.json.call_args.args[0],403)
  self.app.user_has_tab=lambda u,t:t=='flatlay';p.route(self.app,h,h.path,self.body);self.assertEqual(h.json.call_args.args[0],200)
  self.app.gen_shot.assert_not_called();self.app.gemini_edit.assert_not_called()
 def test_regenerate_preserves_source_and_is_idempotent(self):
  source={'id':self.body['request_id'],'owner':'one','mode':'wearer','model':roundup.PEOPLE_MODEL,'aspect':'3:4','status':'done','items':[{'index':0,'shot':'wearer','filename':'source.png'}]}
  p.write(p.folder(self.app)/(source['id']+'.json'),source);(p.folder(self.app)/'source.png').write_bytes(self.raw)
  body={'request_id':'22222222-2222-2222-2222-222222222222','source_job':source['id'],'index':0,'prompt':'Làm mặt nét hơn'}
  with patch.object(p.threading,'Thread') as thread:
   j=p.regenerate(self.app,body,'one',source)
   self.assertEqual(p.regenerate(self.app,body,'one',source)['id'],j['id']);self.assertEqual(thread.call_count,1)
   snapshot=thread.call_args.kwargs['args'][2]
   self.assertEqual(snapshot[0][1],[(self.raw,'image/png')]);self.assertIn(body['prompt'],snapshot[0][2])
   with self.assertRaises(roundup.Problem):p.regenerate(self.app,{**body,'prompt':'Different'},'one',source)
  p.run(self.app,j,snapshot)
  self.assertEqual(j['status'],'done');self.assertEqual(j['source_job'],source['id']);self.assertEqual(j['total'],1)
  self.assertEqual(json.loads((p.folder(self.app)/(source['id']+'.json')).read_text()),source)
  self.assertEqual(self.app.gemini_edit.call_args.kwargs['image_size'],'4K');self.app.gen_shot.assert_not_called()
  for changes in [{'prompt':''},{'index':99}]:
   with self.assertRaises(roundup.Problem):p.regenerate(self.app,{**body,**changes},'one',source)
  h=SimpleNamespace(path='/api/photo-studio/regenerate',current_user=lambda:{'id':'two'},json=Mock())
  self.app.AUTH_REQUIRED=True;self.app.user_has_tab=lambda u,t:True
  p.route(self.app,h,h.path,body);self.assertNotEqual(h.json.call_args.args[0],200)
  h.current_user=lambda:{'id':'one'};self.app.user_has_tab=lambda u,t:t=='flatlay'
  p.route(self.app,h,h.path,{**body,'mode':'flatlay'});self.assertEqual(h.json.call_args.args[0],403)

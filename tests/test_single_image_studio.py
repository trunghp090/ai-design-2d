import base64,io,json,tempfile,unittest
from types import SimpleNamespace
from unittest.mock import Mock,patch
from PIL import Image
import single_image_studio as s
import choly_studio as core
import roundup

class SingleImageTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
  def png(color):
   out=io.BytesIO();Image.new('RGB',(80,60),color).save(out,'PNG');return out.getvalue()
  self.source=png('red');self.asset=png('blue')
  self.data=lambda raw:'data:image/png;base64,'+base64.b64encode(raw).decode()
  self.prompt=s.PROMPT_OPENING+'\n'+'\n'.join(f'{i}. '+('Aspect Ratio: 4:3' if i==11 else 'Detail: Final photograph.') for i in range(1,12))
  self.app=SimpleNamespace(DATA_DIR=self.tmp.name,API_KEY='test',GEMINI_API_KEY='test',BEST_TEXT_MODEL='gpt-4o',openai_chat=Mock(return_value=self.prompt),gen_shot=Mock(return_value=base64.b64encode(self.asset).decode()))
  self.body=dict(files={'reference':self.data(self.source)},kol='none',accessories=[],prompt=self.prompt,request_id='22222222-2222-2222-2222-222222222222')
 def test_chatgpt_analyzes_source_but_does_not_generate(self):
  result=s.analyze(self.app,self.body)
  self.assertEqual(result['prompt'],self.prompt);self.assertEqual(result['format'],'text');self.app.gen_shot.assert_not_called()
  messages=self.app.openai_chat.call_args.args[0]
  self.assertIn('GENERATE A NEW IMAGE',messages[0]['content'])
  self.assertIn('NOT be sent',messages[0]['content'])
  self.assertEqual(messages[1]['content'][1]['image_url']['url'],self.body['files']['reference'])
 def test_source_never_reaches_either_image_provider(self):
  for provider in s.PROVIDERS:
   spec=s.validate({**self.body,'provider':provider},True);refs,rules=s.references(spec)
   job={'id':self.body['request_id'],'provider':provider,'items':[]}
   s.run(self.app,job,refs,rules,spec['prompt'])
   self.assertEqual(job['status'],'done')
   args=self.app.gen_shot.call_args.args
   self.assertEqual(args[0],[]);self.assertEqual(args[3],provider);self.assertEqual(args[4],'4:3')
   self.assertIn('Create a NEW photograph',args[1]);self.assertNotIn('BASE PHOTO',args[1])
   audit=json.loads((core.folder(self.app)/(job['id']+'-0.audit.json')).read_text())
   self.assertEqual(audit['references'],[]);self.assertEqual(audit['model'],s.PROVIDERS[provider][1])
 def test_asset_order_and_mapping_at_both_steps(self):
  files={k:self.data(self.asset) for k in ('kol_male','kol_female','shirt_male','shirt_female','zip','box','tag','environment')}
  body={**self.body,'files':{**files,**self.body['files']},'kol':'couple','shirts':'both','male_position':'left','accessories':['zip','box','tag'],'environment_description':'Outdoor cafe'}
  with patch.object(core.roundup_cast,'people',side_effect=AssertionError('Uploaded KOLs only')):
   refs,rules=s.references(s.validate(body));s.analyze(self.app,body)
  self.assertEqual(len(refs),8);self.assertTrue(all(raw==self.asset for raw,mime in refs))
  for phrase in ('Image #1: MALE KOL','Image #2: FEMALE KOL','Image #3: MALE SHIRT','Image #4: FEMALE SHIRT','viewer left','viewer right','PACKAGING ONLY','ENVIRONMENT REFERENCE ONLY','Outdoor cafe','Vietnamese accents','no outfit change is required','selected uploaded shirts stay unchanged'):self.assertIn(phrase,rules)
  content=self.app.openai_chat.call_args.args[0][1]['content'];self.assertEqual(len(content),10)
  self.assertEqual(content[1]['image_url']['url'],self.data(self.source))
  job={'id':body['request_id'],'provider':'gemini_pro'};s.run(self.app,job,refs,rules,self.prompt)
  self.assertEqual(self.app.gen_shot.call_args.args[0],refs)
 def test_original_outfit_is_described_while_uploaded_shirt_overrides(self):
  body={**self.body,'shirts':'male','files':{**self.body['files'],'shirt_male':self.data(self.asset)}}
  refs,rules=s.references(s.validate(body));s.analyze(self.app,body)
  self.assertEqual([raw for raw,mime in refs],[self.asset])
  self.assertIn('MALE SHIRT PRODUCT ONLY',rules)
  self.assertIn('exact supplied color, fabric, cut, print placement',rules)
  self.assertIn('no outfit change is required',rules)
  self.assertIn('original visible shirt too',rules)
  self.assertNotIn('The female wears',rules);self.assertNotIn('CLOTHING RESTYLE',rules)
  system=self.app.openai_chat.call_args.args[0][0]['content']
  self.assertIn('without requiring restyling',system)
  self.assertIn('Uploaded shirts override only the corresponding source shirts',system)
 def test_selected_assets_only(self):
  body={**self.body,'files':{**self.body['files'],'kol':self.data(self.asset),'shirt_male':self.data(self.asset),'zip':self.data(self.asset)}}
  self.assertEqual(s.references(s.validate(body))[0],[])
  for mode in ('new','flatlay'):
   with patch.object(core.roundup_cast,'people',side_effect=AssertionError('No saved faces')):
    refs,rules=s.references(s.validate({**body,'kol':mode}))
   self.assertEqual(refs,[]);self.assertIn('NEW FICTIONAL' if mode=='new' else 'no people, faces, hands',rules)
 def test_default_packaging_and_saved_kol_still_work(self):
  from pathlib import Path
  face=Path(self.tmp.name)/'face.png';face.write_bytes(self.asset)
  with patch.object(core.roundup_cast,'people',return_value=[{'role':'male','file':face}]):
   refs,rules=s.references(s.validate({**self.body,'kol':'male','accessories':['zip','box','tag']}))
  self.assertEqual(len(refs),4);self.assertEqual(refs[0][0],self.asset)
 def test_invalid_analysis_and_refusal_blocked(self):
  for output in ('',None,'{}','A short incomplete summary',"I cannot assist with that request."):
   self.app.openai_chat.return_value=output
   with self.assertRaises(roundup.Problem):s.analyze(self.app,self.body)
  for output in ('',None,"I cannot assist with that request."):
   with self.assertRaises(roundup.Problem):s.generate(self.app,{**self.body,'prompt':output},'owner')
  self.app.gen_shot.assert_not_called()
 def test_editable_plain_text_and_ratio_fallback(self):
  spec=s.validate({**self.body,'prompt':'Create a new natural photograph.'},True)
  job={'id':self.body['request_id'],'provider':'gemini_pro','aspect':'4:3'}
  s.run(self.app,job,[],'Generate new',spec['prompt'])
  self.assertEqual(job['status'],'done');self.assertEqual(self.app.gen_shot.call_args.args[4],'4:3')
 def test_analysis_describes_faces_and_shirts_explicitly(self):
  s.analyze(self.app,self.body)
  system=self.app.openai_chat.call_args.args[0][0]['content']
  self.assertIn('NOT JSON',system)
  self.assertIn("KOL's visible facial features",system)
  self.assertIn("shirt's actual color, material, cut, fit, artwork and print placement",system)
 def test_provider_validation_and_no_silent_fallback(self):
  with self.assertRaises(roundup.Problem):s.validate({**self.body,'provider':'bad'})
  for provider,key in [('gemini_pro','GEMINI_API_KEY'),('openai_25','API_KEY')]:
   old=getattr(self.app,key);setattr(self.app,key,'')
   with self.assertRaises(roundup.Problem):s.generate(self.app,{**self.body,'provider':provider},'owner')
   setattr(self.app,key,old)
  self.app.gen_shot.assert_not_called()
 def test_one_job_idempotency_and_ownership(self):
  with patch.object(s.threading,'Thread') as thread:
   job=s.generate(self.app,self.body,'owner');s.generate(self.app,self.body,'owner');self.assertEqual(thread.call_count,1)
   self.assertEqual(thread.call_args.kwargs['args'][2],[])
   self.assertEqual(job['provider'],'gemini_pro')
   with self.assertRaises(roundup.Problem):s.generate(self.app,{**self.body,'provider':'openai_25'},'owner')
   with self.assertRaises(roundup.Problem):core.read(self.app,job['id'],'other')
 def test_provider_failure_is_not_retried(self):
  self.app.gen_shot.side_effect=RuntimeError('provider failed')
  job={'id':self.body['request_id'],'provider':'gemini_pro'}
  s.run(self.app,job,[], 'Generate new',self.prompt)
  self.assertEqual(job['status'],'failed');self.app.gen_shot.assert_called_once()
 def test_saved_faces_persist_independent_slots_and_accounts(self):
  s.saved_faces(self.app,'owner',{'slot':'kol_male','image':self.data(self.source)})
  s.saved_faces(self.app,'owner',{'slot':'kol_female','image':self.data(self.asset)})
  # A fresh application instance reads the same account's persistent data.
  fresh=SimpleNamespace(DATA_DIR=self.tmp.name)
  saved=s.saved_faces(fresh,'owner')
  self.assertEqual(saved['kol'],'couple')
  self.assertEqual(saved['files'],{'kol_male':self.data(self.source),'kol_female':self.data(self.asset)})
  self.assertEqual(s.saved_faces(fresh,'other')['files'],{})
  s.saved_faces(fresh,'owner',{'slot':'kol','image':self.data(self.asset)})
  self.assertEqual(s.saved_faces(fresh,'owner')['kol'],'upload')
  s.saved_faces(fresh,'owner',{'slot':'kol_male','image':None})
  self.assertEqual(set(s.saved_faces(fresh,'owner')['files']),{'kol','kol_female'})
 def test_bad_face_upload_preserves_previous_saved_face(self):
  s.saved_faces(self.app,'owner',{'slot':'kol','image':self.data(self.asset)})
  for body in ({'slot':'reference','image':self.data(self.source)},{'slot':'../../outside','image':None},{'slot':'kol','image':'bad'},{'slot':'kol','image':'x'*4500001}):
   with self.assertRaises(roundup.Problem):s.saved_faces(self.app,'owner',body)
  self.assertEqual(s.saved_faces(self.app,'owner')['files']['kol'],self.data(self.asset))
 def test_selected_aspect_reaches_prompt_provider_and_output(self):
  for aspect in s.ASPECTS:
   body={**self.body,'aspect':aspect}
   s.analyze(self.app,body)
   self.assertIn('Required output Aspect Ratio: '+aspect,self.app.openai_chat.call_args.args[0][1]['content'][0]['text'])
   job={'id':self.body['request_id'],'provider':'gemini_pro','aspect':aspect}
   # Existing editable prompt says 4:3; the selector must override it.
   s.run(self.app,job,[],'Create a new photo',self.prompt)
   self.assertEqual(job['status'],'done')
   self.assertEqual(self.app.gen_shot.call_args.args[4],aspect)
   self.assertIn('takes priority over any ratio in the prompt): '+aspect,self.app.gen_shot.call_args.args[1])
   aw,ah=map(int,aspect.split(':'))
   with Image.open(core.folder(self.app)/job['items'][0]['filename']) as image:self.assertEqual(image.width*ah,image.height*aw)
 def test_aspect_is_frozen_in_job_and_idempotency(self):
  with patch.object(s.threading,'Thread'):
   job=s.generate(self.app,{**self.body,'aspect':'9:16'},'owner')
   self.assertEqual(job['aspect'],'9:16')
   with self.assertRaises(roundup.Problem):s.generate(self.app,{**self.body,'aspect':'1:1'},'owner')
 def test_auto_aspect_uses_reference_and_invalid_values_rejected(self):
  with patch.object(s.threading,'Thread'):
   self.assertEqual(s.generate(self.app,self.body,'owner')['aspect'],'4:3')
  for aspect in ('bad','0:0',None,[],{}):
   with self.assertRaises(roundup.Problem):s.validate({**self.body,'aspect':aspect})
 def test_library_retains_multiple_faces_and_selects_without_upload(self):
  first=s.saved_faces(self.app,'owner',{'slot':'kol','image':self.data(self.source),'name':'First'})
  face_id=first['library'][0]['id']
  second=s.saved_faces(self.app,'owner',{'slot':'kol','image':self.data(self.asset),'name':'Second'})
  self.assertEqual(len(second['library']),2)
  selected=s.saved_faces(self.app,'owner',{'slot':'kol_female','face_id':face_id})
  self.assertEqual(selected['files']['kol_female'],self.data(self.source))
  self.assertEqual(selected['files']['kol'],self.data(self.asset))
  self.assertEqual(len(selected['library']),2)
  s.saved_faces(self.app,'owner',{'slot':'kol_female','image':None})
  self.assertEqual(len(s.saved_faces(self.app,'owner')['library']),2)
  with self.assertRaises(roundup.Problem):s.saved_faces(self.app,'other',{'slot':'kol','face_id':face_id})
  self.assertEqual(s.saved_faces(self.app,'other')['library'],[])
 def test_library_migrates_legacy_faces_and_deduplicates(self):
  import hashlib
  directory=core.folder(self.app)/'saved-faces';directory.mkdir(exist_ok=True)
  path=directory/(hashlib.sha256(b'owner').hexdigest()+'.json')
  path.write_text(json.dumps({'kol':'couple','files':{'kol_male':self.data(self.source),'kol_female':self.data(self.asset)}}))
  migrated=s.saved_faces(self.app,'owner')
  self.assertEqual(len(migrated['library']),2)
  self.assertEqual(len(s.saved_faces(self.app,'owner')['library']),2)
  saved=s.saved_faces(self.app,'owner',{'slot':'kol','image':self.data(self.source)})
  self.assertEqual(len(saved['library']),2)
  self.assertTrue(all(f['thumbnail'].startswith('data:image/jpeg;base64,') for f in saved['library']))
 def test_regenerate_uses_frozen_inputs_and_new_job_without_overwriting_original(self):
  body={**self.body,'kol':'upload','files':{**self.body['files'],'kol':self.data(self.asset)}}
  with patch.object(s.threading,'Thread'):
   original=s.generate(self.app,body,'owner')
  path=core.folder(self.app)/(original['id']+'.json')
  stored=json.loads(path.read_text());stored['status']='done';core.write(path,stored)
  request={'source_id':original['id'],'request_id':'33333333-3333-3333-3333-333333333333'}
  with patch.object(s,'references',side_effect=AssertionError('Must use frozen references')),patch.object(s.threading,'Thread') as thread:
   result=s.regenerate(self.app,request,'owner');s.regenerate(self.app,request,'owner')
   self.assertEqual(thread.call_count,1)
   args=thread.call_args.kwargs['args'];self.assertEqual(args[2][0][0],self.asset);self.assertEqual(args[4],self.prompt)
  self.assertNotEqual(result['id'],original['id']);self.assertEqual(result['aspect'],original['aspect'])
  self.assertNotIn('inputs',result);self.assertNotIn('inputs',original)
  self.assertEqual(json.loads(path.read_text()),stored)
  with self.assertRaises(roundup.Problem):s.regenerate(self.app,request,'other')
 def test_regenerate_rejects_running_and_legacy_images(self):
  with patch.object(s.threading,'Thread'):
   original=s.generate(self.app,self.body,'owner')
  request={'source_id':original['id'],'request_id':'33333333-3333-3333-3333-333333333333'}
  with self.assertRaises(roundup.Problem):s.regenerate(self.app,request,'owner')
  path=core.folder(self.app)/(original['id']+'.json');stored=json.loads(path.read_text());stored['status']='done';stored.pop('inputs');core.write(path,stored)
  with self.assertRaises(roundup.Problem) as error:s.regenerate(self.app,request,'owner')
  self.assertIn('Ảnh cũ',str(error.exception))
 def test_validation(self):
  for change in ({'files':{}},{'kol':'bad'},{'shirts':'male'},{'male_position':'bad'},{'environment_description':None},{'environment_description':'x'*3001},{'accessories':['zip','zip']}):
   with self.assertRaises(roundup.Problem):s.validate({**self.body,**change},True)
if __name__=='__main__':unittest.main()

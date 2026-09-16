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
  self.prompt=json.dumps(dict(task='generate_new_image',**{k:'Detailed final photograph.' for k in ('subject','composition','clothing','pose','environment','lighting','camera','style','constraints')},aspect_ratio='4:3'))
  self.app=SimpleNamespace(DATA_DIR=self.tmp.name,API_KEY='test',GEMINI_API_KEY='test',BEST_TEXT_MODEL='gpt-4o',openai_chat=Mock(return_value=self.prompt),gen_shot=Mock(return_value=base64.b64encode(self.asset).decode()))
  self.body=dict(files={'reference':self.data(self.source)},kol='none',accessories=[],prompt=self.prompt,request_id='22222222-2222-2222-2222-222222222222')
 def test_chatgpt_analyzes_source_but_does_not_generate(self):
  result=s.analyze(self.app,self.body)
  self.assertEqual(json.loads(result['prompt']),json.loads(self.prompt));self.app.gen_shot.assert_not_called()
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
  for phrase in ('Image #1: MALE KOL','Image #2: FEMALE KOL','Image #3: MALE SHIRT','Image #4: FEMALE SHIRT','viewer left','viewer right','PACKAGING ONLY','ENVIRONMENT REFERENCE ONLY','Outdoor cafe','Vietnamese accents','black A-line skirt','denim jeans'):self.assertIn(phrase,rules)
  content=self.app.openai_chat.call_args.args[0][1]['content'];self.assertEqual(len(content),10)
  self.assertEqual(content[1]['image_url']['url'],self.data(self.source))
  job={'id':body['request_id'],'provider':'gemini_pro'};s.run(self.app,job,refs,rules,self.prompt)
  self.assertEqual(self.app.gen_shot.call_args.args[0],refs)
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
 def test_invalid_json_refusal_and_old_edit_prompt_blocked(self):
  for output in ('',None,'Edit image #1','{}','[]',"I cannot assist with that request.",self.prompt.replace('generate_new_image','edit_image'),self.prompt.replace('4:3','bad')):
   self.app.openai_chat.return_value=output
   with self.assertRaises(roundup.Problem):s.analyze(self.app,self.body)
   with self.assertRaises(roundup.Problem):s.generate(self.app,{**self.body,'prompt':output},'owner')
  self.app.gen_shot.assert_not_called()
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
 def test_validation(self):
  for change in ({'files':{}},{'kol':'bad'},{'shirts':'male'},{'male_position':'bad'},{'environment_description':None},{'environment_description':'x'*3001},{'accessories':['zip','zip']}):
   with self.assertRaises(roundup.Problem):s.validate({**self.body,**change},True)
if __name__=='__main__':unittest.main()

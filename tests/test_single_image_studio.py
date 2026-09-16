import base64,io,tempfile,unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import Mock,patch
from PIL import Image
import single_image_studio as s
import choly_studio as core
import roundup
class SingleImageTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
  buf=io.BytesIO();Image.new('RGB',(80,60),'red').save(buf,'PNG');self.raw=buf.getvalue();self.data='data:image/png;base64,'+base64.b64encode(self.raw).decode()
  self.app=SimpleNamespace(DATA_DIR=self.tmp.name,API_KEY='x',BEST_TEXT_MODEL='gpt-4o',openai_chat=Mock(return_value='\n'.join(f'{i}. '+('Aspect Ratio: 4:3' if i==11 else 'Detail') for i in range(1,12))),gen_shot=Mock(return_value=base64.b64encode(self.raw).decode()))
  self.body={'files':{'reference':self.data,'kol':self.data,'zip':self.data},'kol':'upload','accessories':['zip','box','tag'],'prompt':'Edited prompt','request_id':'22222222-2222-2222-2222-222222222222'}
 def test_analyze_only_and_asset_order(self):
  result=s.analyze(self.app,self.body);self.assertTrue(result['prompt'].startswith(s.PROMPT_OPENING+'\n\n'));self.assertIn('11. Aspect Ratio',result['prompt']);self.app.gen_shot.assert_not_called()
  call=self.app.openai_chat.call_args;content=call.args[0][1]['content'];self.assertEqual(len(content),6)
  self.assertIn('KOL IDENTITY ONLY',content[0]['text']);self.assertIn('Source size 80×60',content[0]['text'])
  self.assertEqual(content[1]['image_url']['url'],self.data)
 def test_one_generation_clean_original_ratio_and_owner(self):
  with patch.object(s.threading,'Thread') as thread:
   job=s.generate(self.app,self.body,'owner');s.generate(self.app,self.body,'owner');self.assertEqual(thread.call_count,1)
  job=core.read(self.app,job['id'],'owner');spec=s.validate(self.body,True);refs,rules=s.references(spec);s.run(self.app,job,refs,rules,spec['prompt'])
  self.assertEqual(job['status'],'done');self.assertEqual(len(job['items']),1);self.app.gen_shot.assert_called_once();self.app.openai_chat.assert_not_called()
  self.assertEqual(self.app.gen_shot.call_args.args[2:4],('auto','openai_25'))
  with Image.open(core.folder(self.app)/job['items'][0]['filename']) as im:self.assertEqual(im.size,(80,60))
  with self.assertRaises(roundup.Problem):core.read(self.app,job['id'],'other')
  with self.assertRaises(roundup.Problem):s.generate(self.app,{**self.body,'prompt':'other'},'owner')
 def test_failure_does_not_make_another_image(self):
  self.app.gen_shot.side_effect=RuntimeError('provider failed');refs,rules=s.references(s.validate(self.body));job={'id':self.body['request_id'],'items':[]};s.run(self.app,job,refs,rules,'prompt');self.assertEqual(job['status'],'failed');self.app.gen_shot.assert_called_once()
 def test_couple_distinct_faces_and_mapping_reach_both_steps(self):
  buf=io.BytesIO();Image.new('RGB',(80,60),'blue').save(buf,'PNG');female=buf.getvalue()
  body={**self.body,'kol':'couple','male_position':'left','files':{'reference':self.data,'kol_male':self.data,'kol_female':'data:image/png;base64,'+base64.b64encode(female).decode()}}
  with patch.object(core.roundup_cast,'people',side_effect=AssertionError('Uploads must override defaults')):
   refs,rules=s.references(s.validate(body));s.analyze(self.app,body)
  self.assertEqual(refs[1][0],self.raw);self.assertEqual(refs[2][0],female)
  self.assertIn('Image #2 is MALE KOL IDENTITY ONLY',rules);self.assertIn('Image #3 is FEMALE KOL IDENTITY ONLY',rules)
  self.assertIn('viewer’s left',rules);self.assertIn('viewer’s right',rules)
  self.assertIn('never swap, blend or duplicate',rules)
  content=self.app.openai_chat.call_args.args[0][1]['content'];self.assertEqual(content[3]['image_url']['url'],body['files']['kol_female'])
  job={'id':body['request_id'],'items':[]};s.run(self.app,job,refs,rules,'Couple prompt')
  self.assertEqual(job['status'],'done');self.assertEqual(self.app.gen_shot.call_args.args[0][2][0],female)
 def test_couple_saved_and_uploaded_mix(self):
  face=Path(self.tmp.name)/'saved.png';face.write_bytes(self.raw)
  body={**self.body,'kol':'couple','files':{'reference':self.data,'kol_male':self.data}}
  with patch.object(core.roundup_cast,'people',return_value=[{'role':'female','file':face,'mime':'image/png'}]) as people:
   refs,rules=s.references(s.validate(body));people.assert_called_once_with('couple')
  self.assertEqual(refs[2][0],self.raw)
  with self.assertRaises(roundup.Problem):s.validate({**body,'male_position':'bad'})
 def test_selected_shirts_reach_analysis_and_generation(self):
  buf=io.BytesIO();Image.new('RGB',(80,60),'green').save(buf,'PNG');female=buf.getvalue()
  files={'reference':self.data,'shirt_male':self.data,'shirt_female':'data:image/png;base64,'+base64.b64encode(female).decode()}
  for mode,roles in [('none',[]),('male',['male']),('female',['female']),('both',['male','female'])]:
   body={**self.body,'kol':'none','files':files,'accessories':[],'shirts':mode}
   spec=s.validate(body);refs,rules=s.references(spec)
   self.assertEqual(len(refs),1+len(roles))
   for index,role in enumerate(roles,1):
    self.assertEqual(refs[index][0],self.raw if role=='male' else female)
    self.assertIn(role.upper()+' SHIRT PRODUCT ONLY',rules)
   s.analyze(self.app,body)
   messages=self.app.openai_chat.call_args.args[0]
   self.assertNotIn('There is no garment replacement asset',messages[0]['content'])
   self.assertEqual(len(messages[1]['content']),len(refs)+1)
   job={'id':body['request_id'],'items':[]};s.run(self.app,job,refs,rules,'Prompt')
   self.assertEqual(job['status'],'done');self.assertEqual(self.app.gen_shot.call_args.args[0],refs)
 def test_missing_selected_shirt_rejected(self):
  for mode in ('male','female','both','invalid'):
   with self.assertRaises(roundup.Problem):s.validate({**self.body,'shirts':mode})
 def test_refusal_never_becomes_prompt_or_image(self):
  for refusal in ["I'm sorry, I can't assist with that request.","I’m sorry, I cannot help with this request.","Tôi không thể hỗ trợ yêu cầu này."]:
   self.app.openai_chat.return_value=refusal
   with self.assertRaises(roundup.Problem) as error:s.analyze(self.app,self.body)
   self.assertEqual(error.exception.status,422)
   with self.assertRaises(roundup.Problem):s.generate(self.app,{**self.body,'prompt':refusal},'owner')
  self.app.gen_shot.assert_not_called()
 def test_incomplete_analysis_is_rejected(self):
  for output in ['',None,'A nice photo','1. Subject: Person\n11. Aspect Ratio: 3:4']:
   self.app.openai_chat.return_value=output
   with self.assertRaises(roundup.Problem):s.analyze(self.app,self.body)
  self.app.gen_shot.assert_not_called()
 def test_flatlay_omits_all_kol_references(self):
  body={**self.body,'kol':'flatlay','shirts':'male','files':{**self.body['files'],'kol_male':self.data,'kol_female':self.data,'shirt_male':self.data}}
  with patch.object(core.roundup_cast,'people',side_effect=AssertionError('Flatlay must not load faces')):
   refs,rules=s.references(s.validate(body));s.analyze(self.app,body)
  self.assertEqual(len(refs),5) # base, shirt, three packaging assets
  self.assertIn('FLATLAY / OBJECT-ONLY MODE',rules)
  self.assertIn('no people, faces, hands',rules)
  self.assertNotIn('KOL IDENTITY ONLY',rules)
  job={'id':body['request_id'],'items':[]};s.run(self.app,job,refs,rules,'Object photograph')
  self.assertIn('FLATLAY / OBJECT-ONLY MODE',self.app.gen_shot.call_args.args[1])
 def test_opening_is_exact_and_not_duplicated(self):
  sections='\n'.join(f'{i}. Detail' for i in range(1,12))
  for answer in [sections,s.PROMPT_OPENING+'\n\n'+sections,'```plaintext\n'+sections+'\n```']:
   self.app.openai_chat.return_value=answer
   result=s.analyze(self.app,self.body)['prompt']
   self.assertTrue(result.startswith(s.PROMPT_OPENING+'\n\n1.'))
   self.assertEqual(result.count(s.PROMPT_OPENING),1)
   self.assertNotIn('```',result)
 def test_validation(self):
  for change in [{'files':{}},{'kol':'bad'},{'accessories':['zip','zip']},{'prompt':''}]:
   with self.assertRaises(roundup.Problem):s.validate({**self.body,**change},True)
if __name__=='__main__':unittest.main()

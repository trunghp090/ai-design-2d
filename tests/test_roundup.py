import base64
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import roundup as r

class RoundupTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=SimpleNamespace(DATA_DIR=self.tmp.name,ANTHROPIC_API_KEY='configured',API_KEY='configured',GEMINI_API_KEY='configured',ASPECT_TO_SIZE={'9:16':'1024x1536'})
        self.body={'request_id':'11111111-1111-1111-1111-111111111111','prompt_provider':'claude','engine':'openai','aspect':'9:16','cover':True,'hook':'Top 1','products':[{'handle':'ao-doi','image_index':0,'female':'Lan Anh','male':'Minh Quân','scene':'flatlay','label':'Áo đôi'}]}
    def test_rejects_external_urls_and_bad_inputs(self):
        for value in ['https://evil.test/products/ao','../../etc/passwd','https://rieng.vn.evil.test/products/ao']:
            with self.assertRaises(r.Problem):r.handle(value)
        for mutate in [lambda b:b.update(engine='gemini_flash'),lambda b:b['products'][0].update(image_index=-1),lambda b:b['products'][0].update(female=''),lambda b:b['products'].append(copy.deepcopy(b['products'][0]))]:
            b=copy.deepcopy(self.body);mutate(b)
            with self.assertRaises(r.Problem):r.validate(b)
    def test_style_reaches_prompt_and_preserves_product_lock(self):
        from unittest.mock import Mock
        self.body.update(style='lck-inspired',cover=False)
        spec=r.validate(self.body)
        job={'id':self.body['request_id'],'owner':'u','spec':spec,'status':'running','items':[],'total':1}
        self.app._vn_name_spec=lambda s:s
        self.app.claude_vision_multi=Mock(return_value='Detailed photography prompt. '*10)
        self.app.gen_shot=Mock(return_value=base64.b64encode(b'PNG').decode())
        with patch.object(r,'image',return_value=(b'ref','image/png')),patch.object(r,'product',return_value={'title':'Áo đôi'}):r.run(self.app,job)
        self.assertEqual(job['status'],'done')
        brief=self.app.claude_vision_multi.call_args.args[1]
        self.assertIn(r.lck_style.choose('flatlay',spec['products'][0],0)['prompt_direction'],brief)
        self.assertIn('never invent unseen back artwork',brief)
        self.assertEqual(self.app.gen_shot.call_args.args[0][0],(b'ref','image/png'))
        self.assertEqual(len(self.app.gen_shot.call_args.args[0]),5)
        self.assertIn('Reference #3 is the exact RIENG.VN frosted zip pouch',brief)
        self.assertIn('STYLE ONLY',brief)
        self.assertIn('55-60 percent',brief)
        self.assertIn('pouch must physically fit inside',self.app.gen_shot.call_args.args[1])
        self.body['style']='unrecognized'
        with self.assertRaises(r.Problem):r.validate(self.body)

    def test_openai_prompt_without_anthropic(self):
        from unittest.mock import Mock
        self.body.update(prompt_provider='openai',cover=False)
        self.app.ANTHROPIC_API_KEY=''
        self.app._vn_name_spec=lambda s:s
        self.app.openai_chat=Mock(return_value='Detailed product photograph prompt. '*10)
        self.app.claude_vision_multi=Mock(side_effect=AssertionError('No Claude call'))
        self.app.gen_shot=Mock(return_value=base64.b64encode(b'PNG').decode())
        job={'id':self.body['request_id'],'owner':'u','spec':r.validate(self.body),'status':'running','items':[],'total':1}
        with patch.object(r,'image',return_value=(b'ref','image/png')),patch.object(r,'product',return_value={'title':'Áo đôi'}):r.run(self.app,job)
        self.assertEqual(job['status'],'done')
        self.app.claude_vision_multi.assert_not_called()
        call=self.app.openai_chat.call_args
        self.assertFalse(call.kwargs['json_mode'])
        self.assertTrue(call.args[0][1]['content'][1]['image_url']['url'].startswith('data:image/png;base64,'))
        self.assertEqual(job['items'][0]['prompt_provider'],'openai')

    def test_people_receive_style_reference_with_identity_separation(self):
        for scene in ['couple','solo']:
            refs,rules=r.reference_inputs(b'product','image/png',scene,{'style':'lck-inspired','brand_packaging':True})
            self.assertEqual(refs[0],(b'product','image/png'))
            self.assertEqual(len(refs),1)
            self.assertNotIn('STYLE ONLY',rules)
            plain,_=r.reference_inputs(b'product','image/png',scene,{'style':'classic'})
            self.assertEqual(len(plain),1)

    def test_uploaded_pair_bypasses_catalog_and_reaches_image_model(self):
        import io
        from PIL import Image
        from unittest.mock import Mock
        buf=io.BytesIO();Image.new('RGB',(20,20),'white').save(buf,'PNG')
        upload='data:image/png;base64,'+base64.b64encode(buf.getvalue()).decode()
        self.body.update(cover=False,prompt_provider='openai',style='lck-inspired')
        self.body['products'][0].update(uploads=[upload,upload],title='Bộ áo khách gửi')
        spec=r.validate(self.body)
        self.app._vn_name_spec=lambda x:x
        self.app.openai_chat=Mock(return_value='Detailed uploaded product photograph. '*10)
        self.app.gen_shot=Mock(return_value=base64.b64encode(b'PNG').decode())
        job={'id':self.body['request_id'],'owner':'u','spec':spec,'status':'running','items':[],'total':1}
        with patch.object(r,'image',side_effect=AssertionError('No catalog image')),patch.object(r,'product',side_effect=AssertionError('No catalog lookup')):r.run(self.app,job)
        self.assertEqual(job['status'],'done')
        refs,prompt=self.app.gen_shot.call_args.args[:2]
        self.assertEqual(refs[0][0],buf.getvalue())
        self.assertEqual(refs[-1][0],buf.getvalue())
        self.assertIn('SECOND PRODUCT',prompt)
        self.assertIn('preserving all original names',prompt)
        self.body['products'][0]['uploads']=['data:image/png;base64,YmFk']
        with self.assertRaises(r.Problem):r.validate(self.body)

    def test_missing_key_blocks_before_network_or_job(self):
        self.app.ANTHROPIC_API_KEY=''
        with patch.object(r,'product') as fetch:
            with self.assertRaisesRegex(r.Problem,'ANTHROPIC'):r.start(self.app,self.body,'u')
            fetch.assert_not_called()
        self.assertEqual(list(r.directory(self.app).glob('*.json')),[])
    def test_people_require_gemini_before_starting_paid_work(self):
        self.app.GEMINI_API_KEY=''
        with patch.object(r,'product') as fetch:
            with self.assertRaisesRegex(r.Problem,'Nano Banana Pro'):r.start(self.app,self.body,'u')
            fetch.assert_not_called()
        self.assertEqual(list(r.directory(self.app).glob('*.json')),[])

    def test_idempotency_and_owner(self):
        with patch.object(r,'product',return_value={'images':['url']}),patch.object(r.threading,'Thread') as thread:
            a=r.start(self.app,self.body,'u');b=r.start(self.app,self.body,'u')
            self.assertEqual(a['id'],b['id']);self.assertEqual(thread.call_count,1)
            with self.assertRaises(r.Problem):r.read(self.app,a['id'],'other')
            altered=copy.deepcopy(self.body);altered['hook']='Changed'
            with self.assertRaises(r.Problem):r.start(self.app,altered,'u')
            r.LIVE.discard(a['id'])
            self.assertEqual(r.read(self.app,a['id'],'u')['status'],'interrupted')
    def test_partial_results_survive_error_without_retry(self):
        spec=r.validate(self.body)
        job={'id':self.body['request_id'],'owner':'u','spec':spec,'status':'running','items':[],'total':2}
        self.app._vn_name_spec=lambda s:s
        self.app.claude_vision_multi=lambda *args,**kwargs:'Detailed photography prompt. '*10
        calls=[]
        def gen(*args,**kwargs):
            calls.append(args)
            if len(calls)>1:raise RuntimeError('uncertain image response')
            return base64.b64encode(b'PNG-bytes').decode()
        self.app.gen_shot=gen
        self.app.gemini_edit=gen
        with patch.object(r,'image',return_value=(b'ref','image/png')),patch.object(r,'product',return_value={'title':'Áo đôi'}):r.run(self.app,job)
        self.assertEqual(len(calls),2);self.assertEqual(job['status'],'failed');self.assertEqual(len(job['items']),1)
        saved=json.loads((r.directory(self.app)/(job['id']+'.json')).read_text())
        self.assertIn('base',saved['items'][0]);self.assertIn('prompt',saved['items'][0])
        self.assertTrue((r.directory(self.app)/(job['id']+'-0.png')).exists())

if __name__=='__main__':unittest.main()

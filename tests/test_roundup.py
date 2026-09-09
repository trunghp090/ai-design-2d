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
        self.app=SimpleNamespace(DATA_DIR=self.tmp.name,ANTHROPIC_API_KEY='configured',API_KEY='configured',GEMINI_API_KEY='',ASPECT_TO_SIZE={'9:16':'1024x1536'})
        self.body={'request_id':'11111111-1111-1111-1111-111111111111','engine':'openai','aspect':'9:16','cover':True,'hook':'Top 1','products':[{'handle':'ao-doi','image_index':0,'female':'Lan Anh','male':'Minh Quân','scene':'flatlay','label':'Áo đôi'}]}
    def test_rejects_external_urls_and_bad_inputs(self):
        for value in ['https://evil.test/products/ao','../../etc/passwd','https://rieng.vn.evil.test/products/ao']:
            with self.assertRaises(r.Problem):r.handle(value)
        for mutate in [lambda b:b.update(engine='gemini_flash'),lambda b:b['products'][0].update(image_index=-1),lambda b:b['products'][0].update(female=''),lambda b:b['products'].append(copy.deepcopy(b['products'][0]))]:
            b=copy.deepcopy(self.body);mutate(b)
            with self.assertRaises(r.Problem):r.validate(b)
    def test_missing_key_blocks_before_network_or_job(self):
        self.app.ANTHROPIC_API_KEY=''
        with patch.object(r,'product') as fetch:
            with self.assertRaisesRegex(r.Problem,'ANTHROPIC'):r.start(self.app,self.body,'u')
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
        with patch.object(r,'image',return_value=(b'ref','image/png')),patch.object(r,'product',return_value={'title':'Áo đôi'}):r.run(self.app,job)
        self.assertEqual(len(calls),2);self.assertEqual(job['status'],'failed');self.assertEqual(len(job['items']),1)
        saved=json.loads((r.directory(self.app)/(job['id']+'.json')).read_text())
        self.assertIn('base',saved['items'][0]);self.assertIn('prompt',saved['items'][0])
        self.assertTrue((r.directory(self.app)/(job['id']+'-0.png')).exists())

if __name__=='__main__':unittest.main()

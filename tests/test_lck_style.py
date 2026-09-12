import base64
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import lck_style as library
import roundup

class LibraryTests(unittest.TestCase):
    def test_reviewed_reference_reaches_both_models_and_saved_provenance(self):
        with tempfile.TemporaryDirectory() as temp:
            app=SimpleNamespace(DATA_DIR=temp,ASPECT_TO_SIZE={'3:4':'1024x1536'},MODEL='test',_vn_name_spec=lambda s:s)
            app.openai_chat=Mock(return_value='A detailed realistic photograph. '*20)
            app.gen_shot=Mock()
            app.gemini_edit=Mock(return_value=base64.b64encode(b'png').decode())
            row={'handle':'ao-doi','image_index':0,'female':'Lan','male':'Nam','scene':'couple','label':'Top 1'}
            spec={'products':[row],'cover':False,'style':'lck-inspired','engine':'openai','aspect':'3:4','prompt_provider':'openai','hook':'Top 1'}
            job={'id':'11111111-1111-1111-1111-111111111111','owner':'u','spec':spec,'items':[],'total':1}
            chosen=library.choose('couple',row,0)
            self.assertIsNotNone(chosen)
            with patch.object(roundup,'image',return_value=(b'product','image/png')),patch.object(roundup,'product',return_value={'title':'Áo đôi'}):roundup.run(app,job)
            self.assertEqual(job['status'],'done')
            refs,prompt=app.gemini_edit.call_args.args[:2]
            app.gen_shot.assert_not_called()
            self.assertEqual(app.gemini_edit.call_args.args[3],'gemini-3-pro-image')
            self.assertEqual(app.gemini_edit.call_args.kwargs['image_size'],'4K')
            self.assertEqual(job['items'][0]['image_model'],'gemini-3-pro-image')
            self.assertEqual(refs[0],(b'product','image/png'))
            self.assertEqual(refs[1][0],roundup.roundup_cast.people('solo')[0]['file'].read_bytes())
            self.assertIn(chosen['prompt_direction'],prompt)
            self.assertIn('IDENTITY ONLY for the female',prompt)
            self.assertIn('IDENTITY ONLY for the male',prompt)
            self.assertNotIn(library.asset(chosen).read_bytes(),[r for r,m in refs])
            self.assertEqual(job['items'][0]['style_reference']['slide'],chosen['index'])
            text=app.openai_chat.call_args.args[0][1]['content'][0]['text']
            self.assertIn(chosen['prompt_direction'],text)
            self.assertNotIn('quiet outdoor cafe',text)

    def test_pinned_kol_roles_and_no_identity_on_flatlay(self):
        import roundup_cast
        refs=[]
        rules,audit=roundup_cast.attach(refs,'couple')
        self.assertEqual([p['role'] for p in audit],['female','male'])
        self.assertEqual(refs[0][0],roundup_cast.people('couple')[0]['file'].read_bytes())
        self.assertEqual(refs[1][0],roundup_cast.people('couple')[1]['file'].read_bytes())
        self.assertEqual([mime for _,mime in refs],['image/jpeg','image/jpeg'])
        self.assertIn('Reference #1 is IDENTITY ONLY for the female',rules)
        refs=[]
        _,audit=roundup_cast.attach(refs,'solo')
        self.assertEqual([p['role'] for p in audit],['female'])
        refs=[]
        self.assertEqual(roundup_cast.attach(refs,'flatlay'),('',[]))
        self.assertEqual(refs,[])
        study=library.choose('couple',{'handle':'a'})
        direction=roundup.people_direction({'products':[{'handle':'a'}]},{'handle':'a'},'couple',study)
        self.assertIn('Huy Hoàng',direction)
        self.assertNotIn('Use new fictional adults',direction)

    def test_flatlay_keeps_real_packaging_references(self):
        study=library.choose('flatlay',{'handle':'a'},0)
        refs,rules=roundup.reference_inputs(b'product','image/png','flatlay',{'style':'lck-inspired','brand_packaging':True},study)
        self.assertEqual(refs[1][0],library.asset(study).read_bytes())
        for i,name in enumerate(['rieng-zip.png','rieng-tag.png','kraft-box.png'],2):
            self.assertEqual(refs[i][0],(roundup.ROOT/'public'/'roundup-references'/name).read_bytes())
        direction=roundup.people_direction({}, {}, 'flatlay',study)
        self.assertIn('no people',direction)
        self.assertNotIn('Use new fictional adults',direction)

    def test_excludes_unreviewed_graphics_and_unsafe_assets(self):
        slide={'reviewed':False,'scene':'couple','asset':'/etc/passwd'}
        self.assertIsNone(library.asset(slide))
        with patch.object(library,'load',return_value={'posts':[{'id':'1','url':'https://www.tiktok.com/@lck.hn','slides':[slide]}]}):
            self.assertIsNone(library.choose('couple',{'handle':'a'}))
        self.assertIsNone(library.choose('unrecognized',{'handle':'a'}))

    def test_people_planning_uses_distinct_lck_photos_or_stops(self):
        row={'handle':'same-product','print_side':'front'}
        plans=[(row,'couple',False)]*2
        studies=roundup.plan_people_references({},plans)
        self.assertEqual(len({(s['post_id'],s['index']) for s in studies.values()}),2)
        for n,study in studies.items():
            prompt,key=roundup.people_shot_direction({},row,'couple',study,n)
            self.assertIn(study['prompt_direction'],prompt)
            self.assertEqual(key,f"{study['post_id']}:{study['index']}")
        with self.assertRaises(roundup.Problem):
            roundup.plan_people_references({},plans*3)

    def test_completed_albums_have_all_reviewed_local_images(self):
        for post in library.load()['posts']:
            if post['status']!='complete':continue
            self.assertEqual([s['index'] for s in post['slides']],list(range(1,post['total_slides']+1)))
            for slide in post['slides']:
                self.assertTrue(slide['reviewed'])
                self.assertTrue(library.asset(slide))
        first=library.choose('couple',{'handle':'a'},0)
        second=library.choose('couple',{'handle':'a'},1)
        self.assertNotEqual((first['post_id'],first['index']),(second['post_id'],second['index']))

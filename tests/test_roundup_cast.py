import json
import tempfile
import unittest
from pathlib import Path
from roundup_cast import cast_root

class CastRevisionTests(unittest.TestCase):
    def test_new_release_supersedes_old_persistent_portraits(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            local=root/'data/references/kol'; seed=root/'resource-seed/references/kol'
            for folder in (local,seed):folder.mkdir(parents=True)
            (local/'cast.json').write_text(json.dumps({'people':[]}))
            (seed/'cast.json').write_text(json.dumps({'revision':'2026-09-12-studio-4k','people':[]}))
            self.assertEqual(cast_root(root),seed)
            (local/'cast.json').write_text(json.dumps({'revision':'2026-09-13-new-cast','people':[]}))
            self.assertEqual(cast_root(root),local)
    def test_falls_back_to_bundled_cast_without_local_data(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(cast_root(Path(d)),Path(d)/'resource-seed/references/kol')

class CustomCastTests(unittest.TestCase):
    def setUp(self):
        import roundup_cast as c
        from unittest.mock import patch
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.c=c
        patcher=patch.object(c,'BASE',Path(self.tmp.name));patcher.start();self.addCleanup(patcher.stop)

    def portrait(self):
        import io,base64
        from PIL import Image
        out=io.BytesIO();Image.new('RGB',(600,800),'#987654').save(out,'PNG')
        return 'data:image/png;base64,'+base64.b64encode(out.getvalue()).decode()

    def test_upload_persists_reaches_generator_and_reset_keeps_other_role(self):
        c=self.c
        original={p['role']:p['sha256'] for p in c.people('couple')}
        c.update('male',self.portrait())
        selected={p['role']:p for p in c.people('couple')}
        self.assertEqual(selected['female']['sha256'],original['female'])
        self.assertNotEqual(selected['male']['sha256'],original['male'])
        self.assertEqual(json.loads((c.custom_root()/'cast.json').read_text())['male']['sha256'],selected['male']['sha256'])
        refs=[];_,audit=c.attach(refs,'couple')
        self.assertEqual(refs[1][0],selected['male']['file'].read_bytes())
        self.assertEqual(audit[1]['reference_origin'],'user_upload')
        self.assertIsNone(audit[1]['generation_model'])
        c.update('female',self.portrait());c.update('male',reset=True)
        after={p['role']:p for p in c.people('couple')}
        self.assertEqual(after['male']['sha256'],original['male'])
        self.assertEqual(after['female']['reference_origin'],'user_upload')

    def test_bad_upload_does_not_replace_saved_face(self):
        c=self.c;c.update('male',self.portrait());before=c.custom_data()
        for role,value in [('male','bad'),('../escape',self.portrait()),('male','data:image/png;base64,YmFk')]:
            with self.assertRaises(ValueError):c.update(role,value)
            self.assertEqual(c.custom_data(),before)

    def test_route_requires_auth_and_blocks_changes_during_generation(self):
        import roundup as r
        from types import SimpleNamespace
        from unittest.mock import Mock,patch
        app=SimpleNamespace(AUTH_REQUIRED=True,user_has_tab=lambda u,t:True)
        h=SimpleNamespace(path='/api/roundup/kol-upload',current_user=lambda:None,json=Mock())
        r.route(app,h,h.path,{'role':'male','image':self.portrait()})
        self.assertEqual(h.json.call_args.args[0],401)
        h.current_user=lambda:{'id':'test'}
        with patch.object(r,'LIVE',{'running'}):
            r.route(app,h,h.path,{'role':'male','image':self.portrait()})
        self.assertEqual(h.json.call_args.args[0],409)
        r.route(app,h,h.path,{'role':'male','image':self.portrait()})
        self.assertEqual(h.json.call_args.args[0],200)

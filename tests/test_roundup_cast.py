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

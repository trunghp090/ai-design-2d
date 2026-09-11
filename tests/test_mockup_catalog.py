"""Catalog classification and front/back pairing regressions, without server startup."""
import ast
import os
import re
import tempfile
import unittest
from pathlib import Path

source = ast.parse((Path(__file__).resolve().parents[1] / 'server.py').read_text())
functions = [n for n in source.body if isinstance(n, ast.FunctionDef) and n.name in ('mockup_details', 'list_mockups')]
namespace = {'os': os, 're': re}
exec(compile(ast.Module(body=functions, type_ignores=[]), '<catalog>', 'exec'), namespace)

class MockupCatalogTests(unittest.TestCase):
    def test_original_front_and_back_pair(self):
        front = namespace['mockup_details']('ao_1_trang.png', 'Áo trắng (trước)')
        back = namespace['mockup_details']('ao_1_trang_sau.png', 'Áo trắng (sau)')
        self.assertEqual((front['side'], back['side']), ('front', 'back'))
        self.assertEqual(front['pair'], back['pair'])

    def test_uploads_and_garment_types(self):
        for kind in ('hoodie', 'sweater'):
            front = namespace['mockup_details'](kind + '_den_front.png')
            back = namespace['mockup_details'](kind + '_den_back.png')
            self.assertEqual(front['kind'], kind)
            self.assertEqual(back['side'], 'back')
            self.assertEqual(front['pair'], back['pair'])
        self.assertEqual(namespace['mockup_details']('back_123.png')['side'], 'back')
        self.assertEqual(namespace['mockup_details']('u123.png', 'Áo mặt sau')['side'], 'back')

    def test_people_are_excluded_but_all_flatlay_types_remain(self):
        with tempfile.TemporaryDirectory() as folder:
            for name in ('ao_trang.png', 'sweater_57.png', 'hoodie_44.png', 'model_hoodie_35.png', 'model_tshirt_7.png'):
                Path(folder, name).touch()
            namespace.update(MOCKUP_DIR=folder, mockup_labels=lambda: {}, derive_label=lambda f: f)
            items = namespace['list_mockups']()
            self.assertEqual(len(items), 3)
            self.assertEqual({x['kind'] for x in items}, {'tshirt', 'sweater', 'hoodie'})
            self.assertTrue(all(not x['worn'] for x in items))

    def test_all_seven_colors_both_sides_are_listed(self):
        with tempfile.TemporaryDirectory() as folder:
            for color in ('trang', 'den', 'be', 'nau', 'do', 'dodo', 'xanhreu'):
                for suffix in ('', '_sau'):
                    Path(folder, 'ao_' + color + suffix + '.png').touch()
            namespace.update(MOCKUP_DIR=folder, mockup_labels=lambda: {}, derive_label=lambda f: f)
            items = namespace['list_mockups']()
            self.assertEqual(len(items), 14)
            self.assertEqual(sum(x['side'] == 'back' for x in items), 7)
            self.assertEqual(len({x['pair'] for x in items}), 7)

if __name__ == '__main__':
    unittest.main()

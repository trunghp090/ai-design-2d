"""Ensure the ZIP users install is exactly the extension source that CI tests."""
from pathlib import Path
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]


class ExtensionPackageTests(unittest.TestCase):
    def test_downloadable_zip_matches_reviewed_source(self):
        source = ROOT / 'browser-extension' / 'douyin-connect'
        files = {path.name: path.read_bytes() for path in source.iterdir() if path.is_file()}
        self.assertIn('manifest.json', files)
        with zipfile.ZipFile(ROOT / 'public' / 'douyin-connect-extension.zip') as archive:
            self.assertIsNone(archive.testzip())
            self.assertEqual(set(archive.namelist()), {'douyin-connect/' + name for name in files})
            for name, content in files.items():
                self.assertEqual(archive.read('douyin-connect/' + name), content, name)

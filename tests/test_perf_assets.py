import gzip
import io
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from PIL import Image
from perf_assets import _static, static_bytes, mockup_thumbnail

class AssetPerformanceTests(unittest.TestCase):
    def test_static_cache_invalidates_on_edit_and_versions_all_assets(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder, 'index.html')
            path.write_text('<script src="/app.js"></script><script src="/roundup.js?v=old"></script>')
            _static.cache_clear()
            first = static_bytes(str(path), 'new', True)
            self.assertIn(b'/roundup.js?v=new', gzip.decompress(first))
            self.assertEqual(first, static_bytes(str(path), 'new', True))
            self.assertEqual(_static.cache_info().hits, 1)
            path.write_text('<script src="/other.js"></script>')
            self.assertIn(b'/other.js?v=new', gzip.decompress(static_bytes(str(path), 'new', True)))

    def test_concurrent_thumbnails_preserve_aspect_and_original(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder, 'shirt.png')
            Image.new('RGBA', (1600, 2400), (255, 0, 0, 120)).save(path)
            original = path.read_bytes()
            with ThreadPoolExecutor(max_workers=8) as pool:
                results = list(pool.map(lambda _: mockup_thumbnail(folder, 'shirt.png'), range(16)))
            self.assertTrue(all(result == results[0] for result in results))
            self.assertEqual(Image.open(io.BytesIO(results[0][0])).size, (320, 480))
            self.assertEqual(path.read_bytes(), original)
            Image.new('RGB', (1200, 1200), 'blue').save(path)
            updated = mockup_thumbnail(folder, 'shirt.png')
            self.assertNotEqual(updated[1], results[0][1])
            self.assertEqual(Image.open(io.BytesIO(updated[0])).size, (480, 480))
            with self.assertRaises(FileNotFoundError):
                mockup_thumbnail(folder, '../shirt.png')

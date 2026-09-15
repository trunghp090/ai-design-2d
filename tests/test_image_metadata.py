"""Metadata-free image delivery without modifying PNG artwork or calling providers."""
import base64
import io
import json
import struct
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch

from PIL import Image, PngImagePlugin, features

import server
from image_metadata import clean_image, clean_image_b64


PNG_SIGNATURE = b'\x89PNG\r\n\x1a\n'


def png_chunks(raw):
    """Independent reader used for exact compressed-data and chunk checks."""
    assert raw.startswith(PNG_SIGNATURE)
    offset = len(PNG_SIGNATURE)
    result = []
    while offset < len(raw):
        length = struct.unpack('>I', raw[offset:offset + 4])[0]
        kind = raw[offset + 4:offset + 8]
        payload = raw[offset + 8:offset + 8 + length]
        result.append((kind, payload))
        offset += length + 12
    return result


def chunk(kind, payload):
    return (struct.pack('>I', len(payload)) + kind + payload
            + struct.pack('>I', zlib.crc32(kind + payload) & 0xffffffff))


def dirty_png(palette=False):
    if palette:
        image = Image.new('P', (4, 3))
        image.putpalette([255, 30, 10, 10, 240, 60, 70, 20, 230, 255, 255, 255]
                         + [0] * (768 - 12))
        image.putdata([0, 1, 2, 3] * 3)
        image.info['transparency'] = bytes([0, 64, 128, 255])
    else:
        image = Image.new('RGBA', (4, 3))
        image.putdata([(x * 47, y * 75, (x + y) * 23, x * 80)
                       for y in range(3) for x in range(4)])
    info = PngImagePlugin.PngInfo()
    info.add_text('Software', 'Generated with an image provider')
    info.add_text('Comment', 'Private prompt', zip=True)
    info.add_itxt('XML:com.adobe.xmp', '<xmp>generation prompt</xmp>')
    exif = Image.Exif()
    exif[0x0131] = 'AI editor'
    exif[0x010E] = 'Private generation description'
    output = io.BytesIO()
    image.save(output, 'PNG', pnginfo=info, exif=exif,
               icc_profile=b'test-color-profile', dpi=(300, 300))
    raw = output.getvalue()
    extras = (chunk(b'caBX', b'c2pa private manifest')
              + chunk(b'tIME', struct.pack('>HBBBBB', 2026, 9, 15, 10, 30, 0))
              + chunk(b'vpAg', b'unknown provider metadata'))
    return raw[:33] + extras + raw[33:]


def decoded(raw):
    with Image.open(io.BytesIO(raw)) as image:
        return image.size, image.convert('RGBA').tobytes()


class ImageMetadataTests(unittest.TestCase):
    def test_png_removes_provenance_text_and_unknown_chunks_without_reencoding(self):
        raw = dirty_png()
        clean = clean_image(raw)
        original_chunks = png_chunks(raw)
        clean_chunks = png_chunks(clean)
        kinds = {kind for kind, _ in clean_chunks}
        self.assertTrue({b'caBX', b'eXIf', b'tEXt', b'zTXt', b'iTXt', b'tIME', b'vpAg'}
                        .issubset({kind for kind, _ in original_chunks}))
        self.assertFalse(kinds & {b'caBX', b'eXIf', b'tEXt', b'zTXt', b'iTXt', b'tIME', b'vpAg'})
        for kind in (b'IHDR', b'IDAT', b'iCCP', b'pHYs'):
            self.assertEqual([data for tag, data in clean_chunks if tag == kind],
                             [data for tag, data in original_chunks if tag == kind])
        self.assertEqual(decoded(clean), decoded(raw))
        self.assertEqual(clean_image(clean), clean)

    def test_palette_and_transparency_survive_exactly(self):
        raw = dirty_png(palette=True)
        clean = clean_image(raw)
        for kind in (b'PLTE', b'tRNS', b'IDAT'):
            original = [data for tag, data in png_chunks(raw) if tag == kind]
            self.assertTrue(original)
            self.assertEqual([data for tag, data in png_chunks(clean) if tag == kind], original)
        self.assertEqual(decoded(clean), decoded(raw))
        with Image.open(io.BytesIO(clean)) as image:
            self.assertEqual(image.mode, 'P')
            self.assertEqual(image.info['icc_profile'], b'test-color-profile')
            self.assertAlmostEqual(image.info['dpi'][0], 300, places=1)

    def test_jpeg_applies_orientation_and_removes_exif(self):
        image = Image.new('RGB', (3, 2))
        image.putdata([(255, 0, 0), (0, 255, 0), (0, 0, 255),
                       (100, 10, 30), (10, 100, 30), (10, 30, 100)])
        exif = Image.Exif()
        exif[0x0112] = 6
        exif[0x0131] = 'Image generation provider'
        output = io.BytesIO()
        image.save(output, 'JPEG', quality=95, exif=exif,
                   icc_profile=b'test-color-profile', dpi=(150, 150))
        with Image.open(io.BytesIO(output.getvalue())) as original:
            expected = original.transpose(Image.Transpose.ROTATE_270).convert('RGBA').tobytes()
        clean = clean_image(output.getvalue())
        with Image.open(io.BytesIO(clean)) as result:
            self.assertEqual(result.format, 'PNG')
            self.assertEqual(result.size, (2, 3))
            self.assertEqual(result.convert('RGBA').tobytes(), expected)
            self.assertFalse(result.getexif())
            self.assertEqual(result.info['icc_profile'], b'test-color-profile')
            self.assertAlmostEqual(result.info['dpi'][0], 150, places=1)

    @unittest.skipUnless(features.check('webp'), 'Pillow WebP codec unavailable')
    def test_webp_converts_to_png_and_preserves_alpha(self):
        image = Image.new('RGBA', (3, 2), (150, 50, 25, 80))
        exif = Image.Exif()
        exif[0x0131] = 'Generation provider'
        output = io.BytesIO()
        image.save(output, 'WEBP', lossless=True, exif=exif,
                   xmp=b'<xmp>private prompt</xmp>')
        clean = clean_image(output.getvalue())
        self.assertTrue(clean.startswith(PNG_SIGNATURE))
        self.assertEqual(decoded(clean), decoded(output.getvalue()))
        with Image.open(io.BytesIO(clean)) as result:
            self.assertFalse(result.getexif())
            self.assertNotIn('xmp', result.info)

    def test_base64_interface_matches_byte_interface(self):
        raw = dirty_png()
        encoded = base64.b64encode(raw).decode('ascii')
        self.assertEqual(base64.b64decode(clean_image_b64(encoded)), clean_image(raw))
        self.assertEqual(base64.b64decode(clean_image_b64('data:image/png;base64,' + encoded)),
                         clean_image(raw))

    def test_png_strips_data_appended_after_iend(self):
        raw = dirty_png()
        trailing = b'private c2pa manifest after PNG' + chunk(b'caBX', b'provenance')
        self.assertEqual(clean_image(raw + trailing), clean_image(raw))

    def test_png_rejects_bad_checksum_instead_of_returning_corrupt_image(self):
        raw = dirty_png()
        # The first caBX chunk follows the 33-byte PNG signature and IHDR.
        damaged = bytearray(raw)
        damaged[41] ^= 1
        with self.assertRaises(ValueError):
            clean_image(bytes(damaged))
        # A critical image chunk must be checked as well.
        damaged = bytearray(raw)
        damaged[29] ^= 1
        with self.assertRaises(ValueError):
            clean_image(bytes(damaged))

    def test_invalid_images_and_base64_fail_instead_of_passing_through(self):
        for raw in (b'', b'not an image', PNG_SIGNATURE, dirty_png()[:-8]):
            with self.subTest(raw=raw[:12]), self.assertRaises(ValueError):
                clean_image(raw)
        for encoded in ('!!!', 'aW1hZ2U=', ''):
            with self.subTest(encoded=encoded), self.assertRaises(ValueError):
                clean_image_b64(encoded)


class ImageDeliveryBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.raw = dirty_png()
        self.encoded = base64.b64encode(self.raw).decode('ascii')
        self.expected = clean_image(self.raw)
        for name in ('API_KEY', 'GEMINI_API_KEY'):
            patched = patch.object(server, name, 'offline-test-key')
            patched.start()
            self.addCleanup(patched.stop)

    def assert_clean(self, result):
        self.assertEqual(base64.b64decode(result), self.expected)

    def test_shared_openai_edit_and_generate_clean_provider_output(self):
        response = json.dumps({'data': [{'b64_json': self.encoded}]})
        with patch.object(server, '_openai_call', return_value=response) as provider:
            self.assert_clean(server.openai_edit([(self.raw, 'image/png')], 'Offline prompt',
                                                '1024x1024', False))
            self.assert_clean(server.openai_generate('Offline prompt'))
        self.assertEqual(provider.call_count, 2)

    def test_gemini_cleans_both_response_key_spellings(self):
        for key in ('inline_data', 'inlineData'):
            response = {'candidates': [{'content': {'parts': [{key: {
                'mime_type': 'image/png', 'data': self.encoded}}]}}]}
            with self.subTest(key=key), patch.object(server, '_openai_call',
                                                     return_value=json.dumps(response)):
                self.assert_clean(server.gemini_edit([(self.raw, 'image/png')], 'Offline prompt'))

    def test_provider_invalid_image_is_never_returned_as_success(self):
        with patch.object(server, '_openai_call', return_value=json.dumps({
                'data': [{'b64_json': 'aW1hZ2U='}]})):
            with self.assertRaises(ValueError):
                server.openai_generate('Offline prompt')

    def test_gallery_cleans_before_writing_and_indexing(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(server, 'GALLERY_DIR', directory), \
                patch.object(server, 'gallery_load', return_value=[]), \
                patch.object(server, 'gallery_save_index') as save:
            item = server.gallery_add(self.encoded, {'mode': 'imagegen', 'prompt': 'Offline prompt'})
            self.assertEqual(Path(directory, item['id'] + '.png').read_bytes(), self.expected)
            self.assertEqual(save.call_args.args[0][0], item)
            before = set(Path(directory).iterdir())
            with self.assertRaises(ValueError):
                server.gallery_add('aW1hZ2U=', {'mode': 'imagegen'})
            self.assertEqual(set(Path(directory).iterdir()), before)
            self.assertEqual(save.call_count, 1)

    def test_legacy_cleaning_helpers_are_strict_and_work_when_server_pil_flag_is_false(self):
        with patch.object(server, 'HAS_PIL', False):
            self.assertEqual(server.strip_ai_meta(self.raw), self.expected)
            self.assert_clean(server.strip_ai_meta_b64(self.encoded))
            with self.assertRaises(ValueError):
                server.strip_ai_meta(b'invalid')
            with self.assertRaises(ValueError):
                server.strip_ai_meta_b64('aW1hZ2U=')


if __name__ == '__main__':
    unittest.main()

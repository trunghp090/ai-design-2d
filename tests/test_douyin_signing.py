import random
import unittest

from douyin_signing import sm3, websign
from douyin_signing.abogus import ABogus, decode, structure_error


PUBLIC_BROWSER_SIGNATURE = ('QyUVhFWEmq5nFd/tmcJuHtnlDFgMNTSySTi2WjKPyOu8LheY58Pe/PGbaxLLshEy'
                            'bbBzho372xMAYEdcpUUhp9HpLmkkuBGSCGVc960Lhqw4G0kQLHb0euvzowMxUcGq'
                            'aAV4ilU6gUrogfxAkHdm/dl9yKoK5bWBPZOWk/ucE9sg1MyAgpnePpbdOhPxUJOf')
GEOMETRY = '1920|947|1920|1032|1920|1032|1920|1080|Win32'
USER_AGENT = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
              'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')


class DouyinSigningTests(unittest.TestCase):
    def test_public_browser_captured_signature_decodes_and_validates(self):
        # Upstream fixture at pinned commit 4f0bed8483c35a980315d9c7b3a1d4a1119ad2b2:
        # tests/fixtures/signing/abogus_browser.json (public browser, no cookies).
        self.assertIsNone(structure_error(PUBLIC_BROWSER_SIGNATURE))
        fields = decode(PUBLIC_BROWSER_SIGNATURE)
        self.assertEqual(fields['aid'], 6383)
        self.assertEqual(fields['page_id'], 6241)
        self.assertEqual(fields['sdk_version'], (1, 0, 1, 0))
        self.assertEqual(fields['browser_info'], GEOMETRY)
        self.assertEqual(fields['now_ms'], 1789010742989)
        self.assertEqual(fields['ink_ms'], 1789010742988)

    def test_abogus_matches_pinned_deterministic_signature_vector(self):
        expected = ('Dv0Vg77wDoAjadFtYcGq9enUJCj/rTWydzT/WqpP7NuUc1Fb0SP-gNb0booN4Egf'
                    'mYBThC3H4Ez/YDdcTUUiZoHkLmkkSY7WOzV59hfo/qqRTziQLqb0eL6zwwMrU54q'
                    '-Q5Ji1462UJH6fnAiHd8/QAyHKoF5RSBMpOSkZzbP9sX10gAL3clPBSkoh4z')
        signer = ABogus(USER_AGENT, browser_info=GEOMETRY, rng=random.Random(1))
        signature = signer.get_value('aid=6383&aweme_id=7450000000000000002', now_ms=1760000000000)
        self.assertEqual(signature, expected)
        self.assertIsNone(structure_error(signature))
        self.assertEqual(decode(signature)['now_ms'], 1760000000000)

    def test_abogus_binds_signature_to_requested_post_and_browser(self):
        def sign(query, agent=USER_AGENT, geometry=GEOMETRY):
            return ABogus(agent, browser_info=geometry, rng=random.Random(1)).get_value(
                query, now_ms=1760000000000)
        signature = sign('aweme_id=7450000000000000002')
        self.assertNotEqual(signature, sign('aweme_id=7450000000000000999'))
        self.assertNotEqual(signature, sign('aweme_id=7450000000000000002', agent='Synthetic-Agent/1.0'))
        self.assertNotEqual(signature, sign('aweme_id=7450000000000000002',
                                           geometry='1280|720|1280|800|1280|800|1280|800|Win32'))

    def test_sm3_known_vectors_cover_empty_single_and_multiple_blocks(self):
        # Independently checked with LibreSSL: openssl dgst -sm3.
        vectors = [
            (b'', '1ab21d8355cfa17f8e61194831e81a8f22bec8c728fefb747ed035eb5082aa2b'),
            (b'abc', '66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0'),
            (b'abcd' * 16, 'debe9ff92275b8a138604889c18e5a4d6fdb70e5387e5765293dcba39c0c5732'),
            (bytes(range(256)), '59d171dbfd251d5a4cd77d6ba2b7109b7d64a4cd7fa8182beb100a016fa3ac44'),
        ]
        for payload, expected in vectors:
            with self.subTest(length=len(payload)):
                self.assertEqual(sm3.sm3_hexdigest(payload), expected)

    def test_sm3_array_accepts_text_bytes_and_byte_list(self):
        expected = bytes.fromhex('66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0')
        for value in ['abc', b'abc', [97, 98, 99]]:
            with self.subTest(value=value):
                self.assertEqual(sm3.sm3_to_array(value), list(expected))

    def test_websign_known_signature_preserves_signed_query_order(self):
        pairs = [('device_platform', 'webapp'), ('aid', '6383'),
                 ('aweme_id', '7450000000000000002'), ('msToken', 'Synthetic+Token=')]
        expected_query = ('device_platform=webapp&aid=6383&aweme_id=7450000000000000002'
                          '&msToken=Synthetic%2BToken%3D&uifid=synthetic-visitor-id'
                          '&timestamp=1760000000')
        expected_signature = '611a33dbeb35b1302a796f5bb11d1428'
        query, signature, headers = websign.sign(pairs, 'synthetic-visitor-id', timestamp=1760000000)
        self.assertEqual(signature, expected_signature)
        self.assertEqual(query, expected_query + '&x-secsdk-web-signature=' + expected_signature)
        self.assertEqual(headers, {'uifid': 'synthetic-visitor-id',
                                  'x-secsdk-web-signature': expected_signature,
                                  'x-secsdk-web-expire': '1760000000'})
        self.assertEqual(pairs, [('device_platform', 'webapp'), ('aid', '6383'),
                                 ('aweme_id', '7450000000000000002'), ('msToken', 'Synthetic+Token=')])

    def test_websign_keeps_existing_visitor_id_position_without_duplication(self):
        pairs = [('uifid', 'synthetic-visitor-id'), ('aweme_id', '7450000000000000002')]
        query, _, _ = websign.sign(pairs, 'synthetic-visitor-id', timestamp=1760000000)
        self.assertTrue(query.startswith('uifid=synthetic-visitor-id&aweme_id=7450000000000000002&'))
        self.assertEqual(query.count('uifid='), 1)

    def test_visitor_hint_selection_does_not_use_authentication_cookies(self):
        private = {'sessionid': 'synthetic-private-session', 'sessionid_ss': 'synthetic-private-session',
                   'sid_tt': 'synthetic-private-sid', 'passport_csrf_token': 'synthetic-private-csrf'}
        self.assertIsNone(websign.pick_uifid(private))
        self.assertEqual(websign.pick_uifid({**private, 'UIFID_TEMP': 'synthetic-visitor-id'}),
                         'synthetic-visitor-id')


if __name__ == '__main__':
    unittest.main()

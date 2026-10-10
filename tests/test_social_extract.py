import io
import json
import unittest
import urllib.parse
from unittest.mock import Mock, patch

import social_extract


TIKTOK_ID = '7440000000000000001'
DOUYIN_ID = '7450000000000000002'
TIKTOK_VIDEO = 'https://v16m.tiktokcdn.com/video.mp4'
TIKTOK_IMAGES = [
    'https://p16-sign.tiktokcdn-us.com/first.jpeg',
    'https://p16-sign.tiktokcdn-us.com/second.jpeg',
]
DOUYIN_VIDEO = 'https://v3-web.douyinvod.com/video.mp4'
DOUYIN_IMAGES = [
    'https://p3-sign.douyinpic.com/first.jpeg',
    'https://p3-sign.douyinpic.com/second.jpeg',
]
DOUYIN_TEST_COOKIE = ('sessionid=synthetic-private-session; sid_tt=synthetic-private-sid; '
                      'passport_csrf_token=synthetic-private-csrf; msToken=synthetic-visitor-token; '
                      's_v_web_id=synthetic-fingerprint; UIFID_TEMP=synthetic-visitor-id')
DOUYIN_BROWSER_INFO = '1280|720|1280|800|1280|800|1280|800|MacIntel'
DOUYIN_BROWSER_AGENT = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 '
                       '(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36')


def tiktok_item(images=False):
    item = {
        'id': TIKTOK_ID,
        'desc': 'Mẫu thiết kế mới',
        'author': {'uniqueId': 'trung.design', 'nickname': 'Trung'},
    }
    if images:
        item['imagePost'] = {'images': [
            {'imageURL': {'urlList': [url]}} for url in TIKTOK_IMAGES
        ]}
    else:
        item['video'] = {'playAddr': TIKTOK_VIDEO}
    return item


def douyin_item(images=False):
    item = {
        'aweme_id': DOUYIN_ID,
        'desc': '新设计',
        'author': {'unique_id': 'trung.design', 'nickname': 'Trung'},
    }
    if images:
        item['images'] = [{'url_list': [url]} for url in DOUYIN_IMAGES]
    else:
        item['video'] = {'play_addr': {'url_list': [DOUYIN_VIDEO]}}
    return item


class TransportResponse(io.BytesIO):
    def __init__(self, status=200, headers=None, data=b'media'):
        super().__init__(data)
        self.status = status
        self.reason = 'fixture'
        self.headers = headers or {}


def public_dns(host, port, **kwargs):
    return [(2, 1, 6, '', ('8.8.8.8', 443))]


def douyin_html(images=False):
    payload = {'aweme': {'detail': douyin_item(images)}}
    return ('<script id="RENDER_DATA" type="application/json">' +
            urllib.parse.quote(json.dumps(payload)) + '</script>').encode()


def fixture_transport(requests, responses):
    def open_fixture(url, headers, **kwargs):
        requests.append((url, dict(headers)))
        data = responses.get(url, b'<html><title>verification required</title></html>')
        response = TransportResponse(data=data)
        response.url = url
        return response
    return open_fixture


class SocialExtractTests(unittest.TestCase):
    def signed_session(self):
        session = social_extract._Session(DOUYIN_TEST_COOKIE, user_agent=DOUYIN_BROWSER_AGENT,
                                          browser_info=DOUYIN_BROWSER_INFO)
        session.cookie_domains = ('douyin.com', 'iesdouyin.com')
        return session

    def test_accepts_share_text_from_both_apps(self):
        cases = [
            ('Xem video này https://vm.tiktok.com/ZM1234567/ trên TikTok',
             'https://vm.tiktok.com/ZM1234567/'),
            ('复制此链接，打开抖音 https://v.douyin.com/ABC123/ 即可观看',
             'https://v.douyin.com/ABC123/'),
        ]
        for value, expected in cases:
            with self.subTest(value=value):
                self.assertEqual(social_extract.normalize_input(value), expected)

    def test_rejects_non_platform_urls_credentials_and_local_targets(self):
        cases = [
            'https://tiktok.com.evil.example/@trung/video/' + TIKTOK_ID,
            'https://tiktok.com@evil.example/@trung/video/' + TIKTOK_ID,
            'https://user:secret@www.tiktok.com/@trung/video/' + TIKTOK_ID,
            'https://127.0.0.1/' + TIKTOK_ID,
            'https://www.douyin.com:8443/video/' + DOUYIN_ID,
            'file:///etc/passwd',
        ]
        for url in cases:
            with self.subTest(url=url):
                with self.assertRaises(social_extract.SocialExtractError):
                    social_extract.normalize_input(url)

    def test_media_host_allowlist_rejects_lookalikes_and_private_dns(self):
        with self.assertRaises(social_extract.SocialExtractError):
            social_extract.validate_url(
                'https://tiktokcdn.com.evil.example/video.mp4',
                media=True, resolve_dns=False)
        with patch('socket.getaddrinfo', return_value=[
                (2, 1, 6, '', ('127.0.0.1', 443))]):
            with self.assertRaises(social_extract.SocialExtractError):
                social_extract.validate_url(TIKTOK_VIDEO, media=True)

    def test_parses_video_and_photo_carousel_for_each_platform(self):
        cases = [
            ('tiktok', TIKTOK_ID, social_extract._parse_tiktok,
             tiktok_item(False), 'video', [TIKTOK_VIDEO]),
            ('tiktok', TIKTOK_ID, social_extract._parse_tiktok,
             tiktok_item(True), 'images', TIKTOK_IMAGES),
            ('douyin', DOUYIN_ID, social_extract._parse_douyin,
             douyin_item(False), 'video', [DOUYIN_VIDEO]),
            ('douyin', DOUYIN_ID, social_extract._parse_douyin,
             douyin_item(True), 'images', DOUYIN_IMAGES),
        ]
        for platform, post_id, parser, item, expected_type, urls in cases:
            with self.subTest(platform=platform, kind=expected_type):
                result = parser(item, post_id)
                self.assertEqual(result['platform'], platform)
                self.assertEqual(result['post_id'], post_id)
                self.assertEqual(result['type'], expected_type)
                self.assertEqual([a['urls'][0] for a in result['assets']], urls)
                self.assertTrue(result['title'])
                self.assertTrue(result['author'])
                for asset in result['assets']:
                    self.assertEqual(asset['kind'], 'image' if expected_type == 'images' else 'video')
                    self.assertIn('User-Agent', asset['headers'])
                    self.assertIn('Referer', asset['headers'])

    def test_douyin_alternate_carousel_schema_preserves_image_order(self):
        item = douyin_item(True)
        images = item.pop('images')
        item['image_post_info'] = {'images': [
            {'display_image': image} for image in images
        ]}
        result = social_extract._parse_douyin(item, DOUYIN_ID)
        self.assertEqual(result['type'], 'images')
        self.assertEqual([a['urls'][0] for a in result['assets']], DOUYIN_IMAGES)

    def test_tiktok_rehydration_script_extracts_requested_post(self):
        data = {'__DEFAULT_SCOPE__': {'webapp.video-detail': {
            'itemInfo': {'itemStruct': tiktok_item(True)}
        }}}
        html = '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">' + json.dumps(data) + '</script>'
        result = social_extract._metadata_from_html(html, 'tiktok', TIKTOK_ID)
        self.assertEqual(result['type'], 'images')
        self.assertEqual(len(result['assets']), 2)

    def test_douyin_encoded_render_data_extracts_requested_post(self):
        data = {'aweme': {'detail': douyin_item(False)}}
        encoded = urllib.parse.quote(json.dumps(data))
        html = '<script id="RENDER_DATA" type="application/json">' + encoded + '</script>'
        result = social_extract._metadata_from_html(html, 'douyin', DOUYIN_ID)
        self.assertEqual(result['type'], 'video')
        self.assertEqual(result['assets'][0]['urls'][0], DOUYIN_VIDEO)

    def test_does_not_download_unrelated_recommended_post(self):
        data = {'__DEFAULT_SCOPE__': {'webapp.video-detail': {
            'itemInfo': {'itemStruct': tiktok_item(False)}
        }}}
        html = '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">' + json.dumps(data) + '</script>'
        with self.assertRaises(social_extract.SocialExtractError):
            social_extract._metadata_from_html(html, 'tiktok', '7440000000000000999')

    def test_transport_pins_validated_ip_while_preserving_tls_hostname(self):
        connection = Mock()
        response = TransportResponse(data=b'video-content')
        connection.getresponse.return_value = response
        tls_context = object()
        with patch('socket.getaddrinfo', side_effect=public_dns) as dns, \
                patch('socket.create_connection') as connect, \
                patch.object(social_extract, '_ssl_context', return_value=tls_context), \
                patch('http.client.HTTPSConnection', return_value=connection) as https:
            with social_extract.safe_open(TIKTOK_VIDEO, timeout=10) as stream:
                self.assertEqual(stream.read(), b'video-content')
                self.assertEqual(stream.geturl(), TIKTOK_VIDEO)
                connection._create_connection(('rebound.example', 443), 10, None)
            dns.assert_called_once()
            https.assert_called_once()
            self.assertEqual(https.call_args.args, ('v16m.tiktokcdn.com',))
            self.assertIs(https.call_args.kwargs['context'], tls_context)
            self.assertGreater(https.call_args.kwargs['timeout'], 0)
            self.assertLessEqual(https.call_args.kwargs['timeout'], 10)
            connect.assert_called_once_with(('8.8.8.8', 443), 10, None)
        self.assertTrue(response.closed)
        connection.close.assert_called_once()

    def test_transport_rejects_redirect_outside_allowed_domains(self):
        connection = Mock()
        response = TransportResponse(302, {'Location': 'https://evil.example/steal'})
        connection.getresponse.return_value = response
        with patch('socket.getaddrinfo', side_effect=public_dns), \
                patch.object(social_extract, '_ssl_context', return_value=object()), \
                patch('http.client.HTTPSConnection', return_value=connection) as https:
            with self.assertRaises(social_extract.SocialExtractError):
                social_extract.safe_open(TIKTOK_VIDEO)
            https.assert_called_once()
        self.assertTrue(response.closed)
        connection.close.assert_called_once()

    def test_transport_checks_dns_on_redirect_and_rejects_private_target(self):
        connection = Mock()
        response = TransportResponse(302, {'Location': TIKTOK_IMAGES[0]})
        connection.getresponse.return_value = response
        with patch('socket.getaddrinfo', side_effect=[
                public_dns('', 443), [(2, 1, 6, '', ('192.168.1.3', 443))]]), \
                patch.object(social_extract, '_ssl_context', return_value=object()), \
                patch('http.client.HTTPSConnection', return_value=connection) as https:
            with self.assertRaises(social_extract.SocialExtractError):
                social_extract.safe_open(TIKTOK_VIDEO)
            https.assert_called_once()
        self.assertTrue(response.closed)

    def test_cross_host_redirect_drops_cookie_and_authorization(self):
        first, second = Mock(), Mock()
        redirect = TransportResponse(302, {'Location': TIKTOK_IMAGES[0]})
        success = TransportResponse(data=b'image-content')
        first.getresponse.return_value = redirect
        second.getresponse.return_value = success
        headers = {'Cookie': 'session=private', 'Authorization': 'Bearer secret', 'Accept': '*/*'}
        with patch('socket.getaddrinfo', side_effect=public_dns), \
                patch.object(social_extract, '_ssl_context', return_value=object()), \
                patch('http.client.HTTPSConnection', side_effect=[first, second]):
            with social_extract.safe_open(TIKTOK_VIDEO, headers) as stream:
                self.assertEqual(stream.read(), b'image-content')
                self.assertEqual(stream.geturl(), TIKTOK_IMAGES[0])
        sent_headers = second.request.call_args.kwargs['headers']
        self.assertNotIn('Cookie', sent_headers)
        self.assertNotIn('Authorization', sent_headers)
        self.assertEqual(sent_headers['Accept'], '*/*')
        self.assertTrue(redirect.closed)
        self.assertTrue(success.closed)
        first.close.assert_called_once()
        second.close.assert_called_once()

    def test_transport_rejects_header_injection_before_connecting(self):
        for headers in [{'Referer': 'https://www.tiktok.com/\r\nHost: localhost'},
                        {'Host': 'localhost'}, {'Content-Length': '100'}]:
            with self.subTest(headers=headers), patch('http.client.HTTPSConnection') as https:
                with self.assertRaises(social_extract.SocialExtractError):
                    social_extract.safe_open(TIKTOK_VIDEO, headers)
                https.assert_not_called()

    def test_explicit_douyin_cookie_is_scoped_to_douyin_sites(self):
        secret = 'sessionid=private-cookie-fixture'
        session = social_extract._Session(secret)
        session.cookie_domains = ('douyin.com', 'iesdouyin.com')
        requests = []

        def open_fixture(url, headers, **kwargs):
            requests.append((url, dict(headers)))
            response = TransportResponse(data=b'{}')
            response.url = url
            return response

        urls = ['https://www.douyin.com/video/' + DOUYIN_ID,
                'https://www.iesdouyin.com/share/video/' + DOUYIN_ID,
                'https://www.tiktok.com/@trung/video/' + TIKTOK_ID,
                'https://www.tikwm.com/api/', DOUYIN_IMAGES[0]]
        with patch.object(social_extract, '_open', side_effect=open_fixture):
            for url in urls:
                session.read(url)
        self.assertEqual(requests[0][1]['Cookie'], secret)
        self.assertEqual(requests[1][1]['Cookie'], secret)
        for url, headers in requests[2:]:
            with self.subTest(url=url):
                self.assertNotIn('Cookie', headers)

    def test_platform_parsers_reject_metadata_for_a_different_post(self):
        for parser, fixture in [(social_extract._parse_tiktok, tiktok_item()),
                                (social_extract._parse_douyin, douyin_item())]:
            with self.subTest(parser=parser.__name__):
                with self.assertRaises(social_extract.SocialExtractError):
                    parser(fixture, '7440000000000000999')

    def test_authenticated_douyin_desktop_extracts_video_and_carousel(self):
        secret = 'sessionid=synthetic-test-cookie'
        agent = 'Synthetic-Desktop-Test-Agent/1.0'
        url = 'https://www.douyin.com/video/' + DOUYIN_ID
        for images in [False, True]:
            with self.subTest(images=images):
                requests = []
                with patch.object(social_extract, '_open',
                                  side_effect=fixture_transport(requests, {url: douyin_html(images)})), \
                        patch.object(social_extract, '_douyin_signed_detail',
                                     side_effect=social_extract.SocialExtractError('Fixture signed source unavailable')), \
                        patch.object(social_extract, '_yt_dlp') as fallback:
                    result = social_extract.extract(url, cookie_header=secret, user_agent=agent)
                fallback.assert_not_called()
                self.assertEqual([address for address, _ in requests], [url])
                self.assertEqual(requests[0][1]['Cookie'], secret)
                self.assertEqual(requests[0][1]['User-Agent'], agent)
                self.assertEqual(result['type'], 'images' if images else 'video')
                self.assertEqual(result['post_id'], DOUYIN_ID)
                self.assertEqual(len(result['assets']), 2 if images else 1)
                self.assertNotIn(secret, json.dumps(result))
                self.assertNotIn('cookie_header', result)
                self.assertNotIn('user_agent', result)
                for asset in result['assets']:
                    self.assertEqual(asset['headers']['User-Agent'], agent)
                    self.assertFalse(any(key.lower() == 'cookie' for key in asset['headers']))

    def test_authenticated_douyin_tries_desktop_note_after_empty_video_page(self):
        secret = 'sessionid=synthetic-test-cookie'
        agent = 'Synthetic-Desktop-Test-Agent/1.0'
        video_url = 'https://www.douyin.com/video/' + DOUYIN_ID
        note_url = 'https://www.douyin.com/note/' + DOUYIN_ID
        requests = []
        with patch.object(social_extract, '_open',
                          side_effect=fixture_transport(requests, {note_url: douyin_html(True)})), \
                patch.object(social_extract, '_douyin_signed_detail',
                             side_effect=social_extract.SocialExtractError('Fixture signed source unavailable')), \
                patch.object(social_extract, '_yt_dlp') as fallback:
            result = social_extract.extract(video_url, cookie_header=secret, user_agent=agent)
        fallback.assert_not_called()
        self.assertEqual([url for url, _ in requests], [video_url, note_url])
        self.assertEqual(result['type'], 'images')
        self.assertEqual([asset['urls'][0] for asset in result['assets']], DOUYIN_IMAGES)
        for _, headers in requests:
            self.assertEqual(headers['Cookie'], secret)
            self.assertEqual(headers['User-Agent'], agent)

    def test_authenticated_douyin_falls_back_to_mobile_with_matching_user_agent(self):
        secret = 'sessionid=synthetic-test-cookie'
        agent = 'Synthetic-Desktop-Test-Agent/1.0'
        video_url = 'https://www.douyin.com/video/' + DOUYIN_ID
        note_url = 'https://www.douyin.com/note/' + DOUYIN_ID
        mobile_url = 'https://www.iesdouyin.com/share/video/' + DOUYIN_ID + '/'
        requests = []
        with patch.object(social_extract, '_open',
                          side_effect=fixture_transport(requests, {mobile_url: douyin_html(False)})), \
                patch.object(social_extract, '_douyin_signed_detail',
                             side_effect=social_extract.SocialExtractError('Fixture signed source unavailable')), \
                patch.object(social_extract, '_yt_dlp') as fallback:
            result = social_extract.extract(video_url, cookie_header=secret, user_agent=agent)
        fallback.assert_not_called()
        self.assertEqual([url for url, _ in requests], [video_url, note_url, mobile_url])
        self.assertEqual(result['type'], 'video')
        self.assertEqual(result['assets'][0]['urls'][0], DOUYIN_VIDEO)
        for _, headers in requests:
            self.assertEqual(headers['Cookie'], secret)
            self.assertEqual(headers['User-Agent'], agent)
        self.assertNotIn(secret, json.dumps(result))

    def test_public_douyin_keeps_mobile_share_flow_without_cookie(self):
        video_url = 'https://www.douyin.com/video/' + DOUYIN_ID
        mobile_url = 'https://www.iesdouyin.com/share/video/' + DOUYIN_ID + '/'
        requests = []
        with patch.object(social_extract, '_open',
                          side_effect=fixture_transport(requests, {mobile_url: douyin_html(False)})), \
                patch.object(social_extract, '_yt_dlp') as fallback:
            result = social_extract.extract(video_url)
        fallback.assert_not_called()
        self.assertEqual([url for url, _ in requests], [mobile_url])
        self.assertEqual(requests[0][1]['User-Agent'], social_extract.MOBILE_USER_AGENT)
        self.assertNotIn('Cookie', requests[0][1])
        self.assertEqual(result['type'], 'video')

    def test_user_agent_validation_rejects_injection_and_non_ascii_before_network(self):
        url = 'https://www.douyin.com/video/' + DOUYIN_ID
        for agent in ['x' * 513, 'Agent\r\nHost: localhost', 'Agent\x00', 'Agent\x7f',
                      'Trình duyệt', None, ['agent']]:
            with self.subTest(agent=agent), patch.object(social_extract, '_open') as network:
                with self.assertRaises(social_extract.SocialExtractError) as error:
                    social_extract.extract(url, cookie_header='sessionid=synthetic-test-cookie',
                                           user_agent=agent)
                network.assert_not_called()
                self.assertNotIn('synthetic-test-cookie', str(error.exception))

    def test_custom_user_agent_does_not_broaden_cookie_domain_scope(self):
        secret = 'sessionid=synthetic-test-cookie'
        agent = 'Synthetic-Desktop-Test-Agent/1.0'
        session = social_extract._Session(secret, user_agent=agent)
        session.cookie_domains = ('douyin.com', 'iesdouyin.com')
        requests = []
        urls = ['https://www.douyin.com/video/' + DOUYIN_ID,
                'https://www.iesdouyin.com/share/video/' + DOUYIN_ID,
                'https://www.tiktok.com/@trung/video/' + TIKTOK_ID,
                'https://www.tikwm.com/api/', DOUYIN_IMAGES[0]]
        with patch.object(social_extract, '_open', side_effect=fixture_transport(requests, {})):
            for url in urls:
                session.read(url)
        self.assertEqual(requests[0][1]['Cookie'], secret)
        self.assertEqual(requests[1][1]['Cookie'], secret)
        for index, (_, headers) in enumerate(requests):
            self.assertEqual(headers['User-Agent'], agent)
            if index >= 2:
                self.assertNotIn('Cookie', headers)

    def test_douyin_signed_query_uses_requested_post_and_matching_browser_profile(self):
        query = social_extract._douyin_query(DOUYIN_ID, self.signed_session())
        self.assertEqual(query['aweme_id'], DOUYIN_ID)
        self.assertEqual(query['aid'], '6383')
        self.assertEqual(query['device_platform'], 'webapp')
        self.assertEqual(query['browser_name'], 'Chrome')
        self.assertEqual(query['browser_version'], '143.0.0.0')
        self.assertEqual(query['os_name'], 'Mac OS X')
        self.assertEqual(query['os_version'], '14.4')
        self.assertEqual(query['browser_platform'], 'MacIntel')
        self.assertEqual((query['screen_width'], query['screen_height']), ('1280', '800'))
        self.assertEqual(query['msToken'], 'synthetic-visitor-token')
        for name in ['sessionid', 'sid_tt', 'passport_csrf_token']:
            self.assertNotIn(name, query)
        for invalid in ['../escape', DOUYIN_ID + '&aid=1', None, '123']:
            with self.subTest(post_id=invalid):
                with self.assertRaises(social_extract.SocialExtractError):
                    social_extract._douyin_query(invalid, self.signed_session())

    def test_douyin_signed_url_copies_visitor_hints_without_authentication_cookies(self):
        session = self.signed_session()
        with patch('douyin_signing.abogus.ABogus') as signer, \
                patch('douyin_signing.websign.time.time', return_value=1760000000):
            signer.return_value.get_value.return_value = 'synthetic-signature'
            url, headers = social_extract._douyin_signed_request(DOUYIN_ID, session)
        parsed = urllib.parse.urlsplit(url)
        query = urllib.parse.parse_qs(parsed.query)
        signer.assert_called_once_with(DOUYIN_BROWSER_AGENT, browser_info=DOUYIN_BROWSER_INFO)
        self.assertEqual(parsed.hostname, 'www.douyin.com')
        self.assertEqual(parsed.path, '/aweme/v1/web/aweme/detail/')
        self.assertEqual(query['aweme_id'], [DOUYIN_ID])
        self.assertEqual(query['a_bogus'], ['synthetic-signature'])
        self.assertEqual(query['verifyFp'], ['synthetic-fingerprint'])
        self.assertEqual(query['fp'], ['synthetic-fingerprint'])
        self.assertEqual(query['uifid'], ['synthetic-visitor-id'])
        self.assertEqual(query['timestamp'], ['1760000000'])
        self.assertEqual(query['x-secsdk-web-signature'], [headers['x-secsdk-web-signature']])
        self.assertEqual(signer.return_value.get_value.call_args.args[0],
                         parsed.query.split('&a_bogus=', 1)[0])
        names = [name for name, _ in urllib.parse.parse_qsl(parsed.query)]
        self.assertLess(names.index('msToken'), names.index('a_bogus'))
        self.assertEqual(names[-6:], ['a_bogus', 'verifyFp', 'fp', 'uifid',
                                     'timestamp', 'x-secsdk-web-signature'])
        self.assertFalse(any(name.lower() == 'cookie' for name in headers))
        for secret in ['synthetic-private-session', 'synthetic-private-sid', 'synthetic-private-csrf']:
            self.assertNotIn(secret, url)
            self.assertNotIn(secret, json.dumps(headers))

    def test_douyin_signed_detail_rejects_other_post_metadata(self):
        session = self.signed_session()
        fixture = douyin_item(True)
        fixture['aweme_id'] = '7450000000000000999'
        session.read = Mock(return_value=(json.dumps({'aweme_detail': fixture}).encode(),
                                          'https://www.douyin.com/', {}))
        with patch.object(social_extract, '_douyin_signed_request',
                          return_value=('https://www.douyin.com/aweme/v1/web/aweme/detail/', {})):
            with self.assertRaises(social_extract.SocialExtractError):
                social_extract._douyin_signed_detail(DOUYIN_ID, session)

    def test_authenticated_signed_detail_returns_carousel_without_request_credentials(self):
        url = 'https://www.douyin.com/note/' + DOUYIN_ID
        requests = []

        def open_detail(address, headers, **kwargs):
            requests.append((address, dict(headers)))
            self.assertIn('/aweme/v1/web/aweme/detail/', address)
            response = TransportResponse(data=json.dumps({'aweme_detail': douyin_item(True)}).encode())
            response.url = address
            return response

        with patch.object(social_extract, '_open', side_effect=open_detail), \
                patch('douyin_signing.abogus.ABogus') as signer, \
                patch.object(social_extract, '_douyin_direct') as desktop, \
                patch.object(social_extract, '_yt_dlp') as fallback:
            signer.return_value.get_value.return_value = 'synthetic-signature'
            result = social_extract.extract(url, cookie_header=DOUYIN_TEST_COOKIE,
                                            user_agent=DOUYIN_BROWSER_AGENT,
                                            browser_info=DOUYIN_BROWSER_INFO)
        desktop.assert_not_called()
        fallback.assert_not_called()
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0][1]['Cookie'], DOUYIN_TEST_COOKIE)
        self.assertEqual(requests[0][1]['User-Agent'], DOUYIN_BROWSER_AGENT)
        self.assertEqual(result['post_id'], DOUYIN_ID)
        self.assertEqual(result['type'], 'images')
        self.assertEqual([asset['urls'][0] for asset in result['assets']], DOUYIN_IMAGES)
        serialized = json.dumps(result)
        for transient in ['synthetic-private-session', 'synthetic-private-sid', 'synthetic-private-csrf',
                          'synthetic-visitor-token', 'synthetic-fingerprint', 'synthetic-visitor-id',
                          'synthetic-signature', 'x-secsdk-web-signature']:
            self.assertNotIn(transient, serialized)
        for asset in result['assets']:
            self.assertFalse(any(name.lower() == 'cookie' for name in asset['headers']))

    def test_browser_geometry_rejects_malformed_or_injected_input(self):
        for geometry in [None, ['1280'], '1|2|3', '0|720|1280|800|1280|800|1280|800|MacIntel',
                         '1280|720|1280|800|1280|800|1280|800|MacIntel\r\nHost: local',
                         '1280|720|1280|800|1280|800|1280|800|Mac/Intel']:
            with self.subTest(geometry=geometry):
                with self.assertRaises(social_extract.SocialExtractError):
                    social_extract._Session(user_agent=DOUYIN_BROWSER_AGENT, browser_info=geometry)


if __name__ == '__main__':
    unittest.main()

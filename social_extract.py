"""Resolve public TikTok/Douyin posts without downloading their media.

Only explicitly provided cookies are used. HTTPS requests pin a verified public
IP for the connection, retain TLS hostname checks, and validate every redirect.
"""
import base64
import hashlib
import html
import http.client
import io
import ipaddress
import json
import re
import socket
import ssl
import time
from html.parser import HTMLParser
from urllib.parse import parse_qs, quote, unquote, urlencode, urljoin, urlsplit, urlunsplit


USER_AGENT = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
              'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')
MOBILE_USER_AGENT = ('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) '
                     'AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1')
SITE_HOSTS = frozenset(('tiktok.com', 'www.tiktok.com', 'vm.tiktok.com',
                       'vt.tiktok.com', 'm.tiktok.com', 'www.tiktokv.com',
                       'douyin.com', 'www.douyin.com', 'v.douyin.com',
                       'iesdouyin.com', 'www.iesdouyin.com'))
MEDIA_DOMAINS = ('tiktok.com', 'tiktokv.com', 'tiktokcdn.com', 'tiktokcdn-us.com',
                 'tiktokcdn-eu.com', 'tiktokcdn-in.com', 'muscdn.com',
                 'byteoversea.com', 'ibytedtos.com', 'ibyteimg.com', 'byteimg.com',
                 'douyin.com', 'iesdouyin.com', 'douyincdn.com', 'douyinpic.com',
                 'douyinvod.com', 'pstatp.com', 'snssdk.com', 'ixigua.com',
                 'bytecdn.cn', 'volccdn.com', 'tikwm.com')
METADATA_LIMIT = 12 * 1024 * 1024


class SocialExtractError(ValueError):
    """A safe, user-readable resolution failure."""


def _is_domain(host, domain):
    return host == domain or host.endswith('.' + domain)


def _public_addresses(host):
    try:
        addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise SocialExtractError('Không phân giải được tên miền. Hãy kiểm tra mạng.') from exc
    result = []
    for _, _, _, _, address in addresses:
        ip = ipaddress.ip_address(address[0].split('%', 1)[0])
        if not ip.is_global:
            raise SocialExtractError('Địa chỉ mạng nội bộ không được phép tải.')
        if str(ip) not in result:
            result.append(str(ip))
    if not result:
        raise SocialExtractError('Tên miền không có địa chỉ mạng công khai.')
    return result


def validate_url(url, media=False, resolve_dns=True):
    """Validate an HTTPS platform/CDN URL; return its normalized form."""
    if not isinstance(url, str) or not url or len(url) > 16384:
        raise SocialExtractError('Link không hợp lệ.')
    if any(ord(c) < 32 or ord(c) == 127 for c in url) or '\\' in url:
        raise SocialExtractError('Link chứa ký tự không hợp lệ.')
    try:
        parsed = urlsplit(url)
        host = (parsed.hostname or '').lower()
        port = parsed.port
    except ValueError as exc:
        raise SocialExtractError('Link không hợp lệ.') from exc
    if parsed.scheme != 'https' or port not in (None, 443) or parsed.username or parsed.password:
        raise SocialExtractError('Chỉ hỗ trợ link HTTPS của TikTok và Douyin.')
    allowed = any(_is_domain(host, d) for d in MEDIA_DOMAINS) if media else host in SITE_HOSTS
    if not allowed:
        raise SocialExtractError('Tên miền không thuộc TikTok, Douyin hoặc CDN được hỗ trợ.')
    if resolve_dns:
        _public_addresses(host)
    return urlunsplit(('https', host, parsed.path or '/', parsed.query, ''))


def normalize_input(value):
    """Extract a single supported link from a pasted share message."""
    if not isinstance(value, str) or not value.strip() or len(value) > 20000:
        raise SocialExtractError('Hãy dán link video hoặc bài ảnh cuộn TikTok/Douyin.')
    matches = re.findall(r'https?://[^\s<>"\u201c\u201d]+', value.strip())
    if not matches:
        raise SocialExtractError('Không tìm thấy link TikTok hoặc Douyin trong nội dung đã dán.')
    for candidate in matches:
        candidate = candidate.rstrip('.,;!?)\u3002\uff0c\uff1b\uff01\uff09]}' + "'")
        if candidate.startswith('http://'):
            candidate = 'https://' + candidate[7:]
        try:
            return validate_url(candidate, resolve_dns=False)
        except SocialExtractError:
            continue
    raise SocialExtractError('Chỉ hỗ trợ link video và bài ảnh cuộn TikTok/Douyin.')


class _SafeResponse:
    def __init__(self, response, connection, url):
        self._response = response
        self._connection = connection
        self.url = url
        self.status = response.status
        self.reason = response.reason
        self.headers = response.headers

    def read(self, size=-1):
        return self._response.read(size)

    def geturl(self):
        return self.url

    def getheader(self, key, default=None):
        return self.headers.get(key, default)

    def close(self):
        self._response.close()
        self._connection.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def _ssl_context():
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def _open(url, headers=None, timeout=20, media=False, method='GET', data=None):
    deadline = time.monotonic() + max(0.1, float(timeout))
    headers = dict(headers or {})
    for key, value in headers.items():
        if not isinstance(key, str) or not isinstance(value, str) or '\n' in key + value or '\r' in key + value:
            raise SocialExtractError('Header tải file không hợp lệ.')
        if key.lower() in ('host', 'connection', 'content-length', 'transfer-encoding'):
            raise SocialExtractError('Header tải file không được phép.')
    headers.setdefault('User-Agent', USER_AGENT)
    headers.setdefault('Accept-Encoding', 'identity')
    for _ in range(7):
        url = validate_url(url, media=media, resolve_dns=False)
        parts = urlsplit(url)
        addresses = _public_addresses(parts.hostname)
        connection = None
        response = None
        last_error = None
        # Prefer IPv4 on local systems without functioning IPv6 routing.
        addresses.sort(key=lambda address: ':' in address)
        for address in addresses[:3]:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            connection = http.client.HTTPSConnection(parts.hostname, timeout=remaining, context=_ssl_context())
            connection._create_connection = lambda endpoint, time_limit=None, source_address=None, ip=address: socket.create_connection((ip, 443), time_limit, source_address)
            try:
                path = urlunsplit(('', '', parts.path or '/', parts.query, ''))
                connection.request(method, path, body=data, headers=headers)
                response = connection.getresponse()
                break
            except (OSError, http.client.HTTPException) as exc:
                connection.close()
                last_error = exc
        if response is None:
            raise SocialExtractError('Không kết nối được nguồn tải. Hãy kiểm tra mạng hoặc thử lại.') from last_error
        if response.status in (301, 302, 303, 307, 308):
            location = response.headers.get('Location')
            response.close()
            connection.close()
            if not location:
                raise SocialExtractError('Nguồn trả về chuyển hướng không hợp lệ.')
            next_url = urljoin(url, location)
            if urlsplit(next_url).hostname != parts.hostname:
                headers = {k: v for k, v in headers.items() if k.lower() not in (
                    'cookie', 'authorization', 'uifid', 'x-secsdk-web-signature', 'x-secsdk-web-expire',
                )}
            if response.status == 303 or (response.status in (301, 302) and method == 'POST'):
                method, data = 'GET', None
            url = next_url
            continue
        if response.status >= 400:
            status = response.status
            response.close()
            connection.close()
            if status == 429:
                raise SocialExtractError('Nguồn đang giới hạn lượt tải. Hãy thử lại sau ít phút.')
            if status in (401, 403):
                raise SocialExtractError('Nguồn yêu cầu đăng nhập hoặc xác minh. Hãy thử lại với bài công khai.')
            if status == 404:
                raise SocialExtractError('Không tìm thấy bài đăng; bài có thể đã bị xóa.')
            raise SocialExtractError('Nguồn tải đang gặp lỗi HTTP %s.' % status)
        return _SafeResponse(response, connection, url)
    raise SocialExtractError('Link chuyển hướng quá nhiều lần.')


def safe_open(url, headers=None, timeout=20):
    """Open a platform/CDN asset with validated redirects and pinned public IPs."""
    return _open(url, headers=headers, timeout=timeout, media=True)


class _Session:
    def __init__(self, cookie_header='', timeout=8, user_agent='', browser_info=''):
        if not isinstance(cookie_header, str) or len(cookie_header) > 16000 or '\n' in cookie_header or '\r' in cookie_header:
            raise SocialExtractError('Cookie không hợp lệ.')
        if not isinstance(user_agent, str) or len(user_agent) > 512 or any(ord(c) < 32 or ord(c) > 126 for c in user_agent):
            raise SocialExtractError('User-Agent không hợp lệ.')
        self.cookie_header = cookie_header
        self.user_agent = user_agent.strip() or USER_AGENT
        self.browser_info = _browser_geometry(browser_info, self.user_agent)
        self.cookie_domains = ()
        self.cookies = {}
        self.timeout = timeout
        self.deadline = time.monotonic() + 70

    def read(self, url, headers=None, media=False, method='GET', data=None):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise SocialExtractError('Phân tích link quá lâu. Hãy thử lại.')
        headers = dict(headers or {})
        headers.setdefault('User-Agent', self.user_agent)
        host = urlsplit(url).hostname or ''
        if any(_is_domain(host, domain) for domain in ('tiktok.com', 'douyin.com', 'iesdouyin.com')):
            cookies = self.cookie_header if any(_is_domain(host, domain) for domain in self.cookie_domains) else ''
            if _is_domain(host, 'tiktok.com') and self.cookies:
                cookies = '; '.join(filter(None, [cookies] + ['%s=%s' % pair for pair in self.cookies.items()]))
            if cookies:
                headers['Cookie'] = cookies
        try:
            with _open(url, headers, timeout=min(self.timeout, remaining), media=media, method=method, data=data) as response:
                content = response.read(METADATA_LIMIT + 1)
                if len(content) > METADATA_LIMIT:
                    raise SocialExtractError('Dữ liệu bài đăng vượt giới hạn cho phép.')
                return content, response.url, dict(response.headers)
        except (OSError, http.client.HTTPException) as exc:
            raise SocialExtractError('Nguồn phản hồi quá chậm hoặc ngắt kết nối. Hãy thử lại.') from exc


def _post_reference(url):
    parts = urlsplit(url)
    platform = 'tiktok' if 'tiktok' in (parts.hostname or '') else 'douyin'
    match = re.search(r'/(?:video|photo|note|slides|v|embed)/(\d{6,25})(?:[/.]|$)', parts.path)
    post_id = match.group(1) if match else ''
    if not post_id:
        query = parse_qs(parts.query)
        for key in ('modal_id', 'aweme_id', 'item_id', 'vid'):
            value = (query.get(key) or [''])[0]
            if re.fullmatch(r'\d{6,25}', value):
                post_id = value
                break
    return platform, post_id


def resolve_share_url(value):
    url = normalize_input(value)
    if _post_reference(url)[1]:
        return url
    _, final_url, _ = _Session().read(url, {'User-Agent': MOBILE_USER_AGENT})
    validate_url(final_url, resolve_dns=False)
    if not _post_reference(final_url)[1]:
        raise SocialExtractError('Link phải trỏ đến một video hoặc bài ảnh cuộn, không phải trang hồ sơ.')
    return final_url


def _urls(value):
    if isinstance(value, str):
        values = [value]
    elif isinstance(value, list):
        values = value
    elif isinstance(value, dict):
        values = value.get('url_list') or value.get('urlList') or value.get('UrlList') or [value.get('url') or value.get('src')]
    else:
        values = []
    result = []
    for candidate in values:
        if isinstance(candidate, dict):
            candidates = _urls(candidate)
        elif isinstance(candidate, str):
            candidate = html.unescape(candidate)
            if candidate.startswith('//'):
                candidate = 'https:' + candidate
            if candidate.startswith('http://'):
                candidate = 'https://' + candidate[7:]
            try:
                candidates = [validate_url(candidate, media=True, resolve_dns=False)]
            except SocialExtractError:
                candidates = []
        else:
            candidates = []
        for candidate in candidates:
            if candidate not in result:
                result.append(candidate)
    return result


def _asset(kind, urls, platform):
    if not urls:
        raise SocialExtractError('Bài đăng có tài nguyên không nằm trên CDN được hỗ trợ.')
    return {'kind': kind, 'urls': urls, 'headers': {
        'User-Agent': USER_AGENT,
        'Referer': 'https://www.tiktok.com/' if platform == 'tiktok' else 'https://www.douyin.com/',
    }}


def _result(platform, post_id, title, author, assets):
    if not assets:
        raise SocialExtractError('Không tìm thấy video hoặc ảnh cuộn có thể tải trong bài đăng.')
    if len(assets) > 100:
        raise SocialExtractError('Bài đăng vượt giới hạn 100 ảnh.')
    return {'platform': platform, 'post_id': str(post_id), 'title': str(title or '')[:2000],
            'author': str(author or '')[:200], 'type': 'images' if assets[0]['kind'] == 'image' else 'video',
            'assets': assets}


def _parse_tiktok(item, post_id=''):
    identity = str(item.get('id') or item.get('aweme_id') or '')
    if post_id and identity and identity != str(post_id):
        raise SocialExtractError('Nguồn trả về bài đăng khác với link yêu cầu.')
    images = (item.get('imagePost') or item.get('image_post_info') or {}).get('images') or []
    author = item.get('author') or item.get('authorInfo') or {}
    if isinstance(author, str):
        author = {'uniqueId': author}
    assets = []
    if images:
        for image in images:
            candidates = []
            for key in ('imageURL', 'image_url', 'display_image', 'downloadURL', 'download_url'):
                candidates.extend(url for url in _urls(image.get(key)) if url not in candidates)
            assets.append(_asset('image', candidates, 'tiktok'))
    else:
        video = item.get('video') or {}
        candidates = []
        rates = video.get('bitrateInfo') or video.get('bit_rate') or []
        if isinstance(rates, dict):
            rates = [rates]
        rates = sorted(rates, key=lambda entry: int(entry.get('Bitrate') or entry.get('bit_rate') or 0), reverse=True)
        for rate in rates:
            address = rate.get('PlayAddr') or rate.get('play_addr') or {}
            if 'bytevc2' in str(address.get('UrlKey') or address.get('url_key') or ''):
                continue
            candidates.extend(url for url in _urls(address) if url not in candidates)
        for key in ('playAddr', 'play_addr', 'play_addr_h264', 'downloadAddr', 'download_addr'):
            candidates.extend(url for url in _urls(video.get(key)) if url not in candidates)
        # Photo posts expose their sound as a video URL; never mislabel it MP4.
        candidates = [u for u in candidates if 'mime_type=audio' not in u and '-music-' not in u]
        if candidates:
            assets.append(_asset('video', candidates, 'tiktok'))
    return _result('tiktok', item.get('id') or item.get('aweme_id') or post_id,
                   item.get('desc'), author.get('nickname') or author.get('uniqueId') or author.get('unique_id'), assets)


def _parse_douyin(item, post_id=''):
    identity = str(item.get('aweme_id') or item.get('id') or '')
    if post_id and identity and identity != str(post_id):
        raise SocialExtractError('Nguồn trả về bài đăng khác với link yêu cầu.')
    images = item.get('images') or (item.get('image_post_info') or {}).get('images') or []
    assets = []
    if images:
        for image in images:
            candidates = _urls(image)
            if isinstance(image, dict):
                for key in ('display_image', 'download_image', 'imageURL', 'image_url'):
                    candidates.extend(url for url in _urls(image.get(key)) if url not in candidates)
            assets.append(_asset('image', candidates, 'douyin'))
    else:
        video = item.get('video') or {}
        candidates = []
        rates = sorted(video.get('bit_rate') or [], key=lambda entry: int(entry.get('bit_rate') or 0), reverse=True)
        for rate in rates:
            if 'bytevc2' in str((rate.get('play_addr') or {}).get('url_key', '')):
                continue
            candidates.extend(url for url in _urls(rate.get('play_addr')) if url not in candidates)
        for key in ('play_addr_h264', 'play_addr', 'download_addr'):
            candidates.extend(url for url in _urls(video.get(key)) if url not in candidates)
        if candidates:
            assets.append(_asset('video', candidates, 'douyin'))
    author = item.get('author') or {}
    return _result('douyin', item.get('aweme_id') or item.get('id') or post_id,
                   item.get('desc'), author.get('nickname') or author.get('unique_id'), assets)


class _Scripts(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.values = []
        self.attributes = {}
        self.current = None
        self.buffer = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if attributes.get('id'):
            self.attributes[attributes['id']] = attributes
        if tag == 'script':
            self.current = attributes
            self.buffer = []

    def handle_data(self, data):
        if self.current is not None:
            self.buffer.append(data)

    def handle_endtag(self, tag):
        if tag == 'script' and self.current is not None:
            self.values.append((self.current, ''.join(self.buffer)))
            self.current = None


def _find_item(value, platform, post_id, depth=0):
    if depth > 18:
        return None
    if isinstance(value, dict):
        identity = str(value.get('aweme_id') or value.get('id') or '')
        has_media = any(key in value for key in ('video', 'images', 'imagePost', 'image_post_info'))
        if identity and has_media and (not post_id or identity == post_id):
            return value
        for child in value.values():
            found = _find_item(child, platform, post_id, depth + 1)
            if found:
                return found
    elif isinstance(value, list):
        for child in value:
            found = _find_item(child, platform, post_id, depth + 1)
            if found:
                return found
    return None


def _metadata_from_html(page, platform, post_id):
    parser = _Scripts()
    parser.feed(page)
    decoder = json.JSONDecoder()
    for attributes, content in parser.values:
        candidates = []
        if attributes.get('id') in ('__UNIVERSAL_DATA_FOR_REHYDRATION__', 'SIGI_STATE', 'sigi-persisted-data', '__NEXT_DATA__', 'RENDER_DATA'):
            candidates.append(unquote(content) if attributes.get('id') == 'RENDER_DATA' else content)
        for match in re.finditer(r'(?:window\.)?_(?:ROUTER|SSR)_DATA\s*=\s*', content):
            candidates.append(content[match.end():])
        for candidate in candidates:
            try:
                payload, _ = decoder.raw_decode(candidate.lstrip())
            except (ValueError, TypeError):
                continue
            item = _find_item(payload, platform, post_id)
            if item:
                return _parse_tiktok(item, post_id) if platform == 'tiktok' else _parse_douyin(item, post_id)
    raise SocialExtractError('Nền tảng chưa trả về dữ liệu bài đăng; có thể cần xác minh hoặc đăng nhập.')


def _solve_tiktok_challenge(page, session):
    parser = _Scripts()
    parser.feed(page)
    attrs = parser.attributes
    try:
        encoded = attrs['cs']['class']
        challenge = json.loads(base64.b64decode(encoded + '=' * (-len(encoded) % 4)))
        values = challenge['v']
        target = base64.b64decode(values['c'] + '=' * (-len(values['c']) % 4))
        seed = base64.b64decode(values['a'] + '=' * (-len(values['a']) % 4))
        base = hashlib.sha256(seed)
        for number in range(1000001):
            test = base.copy()
            test.update(str(number).encode('ascii'))
            if test.digest() == target:
                challenge['d'] = base64.b64encode(str(number).encode('ascii')).decode('ascii')
                cookie_name = attrs['wci']['class']
                if not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', cookie_name):
                    return False
                session.cookies[cookie_name] = base64.b64encode(json.dumps(challenge, separators=(',', ':')).encode()).decode('ascii')
                if attrs.get('rci', {}).get('class') and attrs.get('rs', {}).get('class'):
                    name, value = attrs['rci']['class'], attrs['rs']['class']
                    if re.fullmatch(r'[A-Za-z0-9_-]{1,80}', name) and '\r' not in value and '\n' not in value:
                        session.cookies[name] = value
                return True
    except (KeyError, ValueError, TypeError):
        pass
    return False


def _tiktok_direct(url, post_id, session):
    parts = urlsplit(url)
    match = re.search(r'/@([^/]+)', parts.path)
    username = match.group(1) if match else '_'
    page_url = 'https://www.tiktok.com/@%s/video/%s' % (quote(unquote(username), safe='._-'), post_id)
    content, _, _ = session.read(page_url)
    page = content.decode('utf-8', 'replace')
    try:
        return _metadata_from_html(page, 'tiktok', post_id)
    except SocialExtractError:
        if _solve_tiktok_challenge(page, session):
            content, _, _ = session.read(page_url)
            return _metadata_from_html(content.decode('utf-8', 'replace'), 'tiktok', post_id)
        raise


def _douyin_direct(post_id, session):
    if session.cookie_header:
        # Browser challenge cookies may be tied to the browser User-Agent. Read
        # its authenticated desktop pages before changing to a mobile profile.
        for path in ('video', 'note'):
            try:
                content, _, _ = session.read('https://www.douyin.com/%s/%s' % (path, post_id), {
                    'User-Agent': session.user_agent,
                    'Referer': 'https://www.douyin.com/',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                })
                return _metadata_from_html(content.decode('utf-8', 'replace'), 'douyin', post_id)
            except SocialExtractError:
                continue
    # The mobile share page includes albums as well as videos without API signing.
    for path in ('video', 'slides'):
        try:
            content, _, _ = session.read('https://www.iesdouyin.com/share/%s/%s/' % (path, post_id), {
                'User-Agent': session.user_agent if session.cookie_header else MOBILE_USER_AGENT,
            })
            return _metadata_from_html(content.decode('utf-8', 'replace'), 'douyin', post_id)
        except SocialExtractError:
            continue
    api_url = 'https://www.douyin.com/aweme/v1/web/aweme/detail/?' + urlencode({'aweme_id': post_id})
    content, _, _ = session.read(api_url, {'Accept': 'application/json', 'Referer': 'https://www.douyin.com/'})
    try:
        item = _find_item(json.loads(content), 'douyin', post_id)
    except ValueError:
        item = None
    if not item:
        raise SocialExtractError('Douyin yêu cầu cookie mới hoặc xác minh để truy cập bài này. Hãy thử link chia sẻ công khai khác.')
    return _parse_douyin(item, post_id)


def _browser_geometry(value, user_agent):
    if not isinstance(value, str) or len(value) > 256 or any(ord(c) < 32 or ord(c) > 126 for c in value):
        raise SocialExtractError('Thông tin trình duyệt không hợp lệ.')
    if value:
        fields = value.split('|')
        if len(fields) != 9 or not all(re.fullmatch(r'\d{1,5}', field) and 0 < int(field) <= 32768 for field in fields[:8]):
            raise SocialExtractError('Kích thước trình duyệt không hợp lệ.')
        if not re.fullmatch(r'[A-Za-z0-9 _-]{1,48}', fields[8]):
            raise SocialExtractError('Nền tảng trình duyệt không hợp lệ.')
        return value
    platform = 'MacIntel' if 'Mac' in user_agent else ('Linux x86_64' if 'Linux' in user_agent else 'Win32')
    return '1920|947|1920|1032|1920|1032|1920|1080|' + platform


def _cookie_values(header):
    # Only the visitor hints named below are used in the signed query. The
    # complete header remains transient and is sent only to platform hosts.
    values = {}
    for part in header.split(';'):
        name, separator, value = part.strip().partition('=')
        if separator and name:
            values[name] = value.strip().strip('"')
    return values


def _douyin_query(post_id, session):
    if not re.fullmatch(r'\d{6,25}', str(post_id)):
        raise SocialExtractError('Mã bài Douyin không hợp lệ.')
    user_agent = session.user_agent
    geometry = session.browser_info.split('|')
    browser_name, browser_version, engine_name = 'Chrome', '131.0.0.0', 'Blink'
    for label, pattern, engine in (
        ('Chrome', r'Chrome/([\d.]+)', 'Blink'),
        ('Firefox', r'Firefox/([\d.]+)', 'Gecko'),
        ('Safari', r'Version/([\d.]+).*Safari/', 'WebKit'),
    ):
        match = re.search(pattern, user_agent)
        if match:
            browser_name, browser_version, engine_name = label, match.group(1), engine
            break
    os_name, os_version = 'Windows', '10'
    mac_version = re.search(r'Mac OS X ([\d_]+)', user_agent)
    if mac_version:
        os_name, os_version = 'Mac OS X', mac_version.group(1).replace('_', '.')
    elif 'Linux' in user_agent:
        os_name, os_version = 'Linux', ''
    windows_version = re.search(r'Windows NT ([\d.]+)', user_agent)
    if windows_version:
        os_version = windows_version.group(1)
    params = {
        'device_platform': 'webapp', 'aid': '6383', 'channel': 'channel_pc_web',
        'pc_client_type': '1', 'version_code': '290100', 'version_name': '29.1.0',
        'cookie_enabled': 'true', 'screen_width': geometry[6], 'screen_height': geometry[7],
        'browser_language': 'zh-CN', 'browser_platform': geometry[8],
        'browser_name': browser_name, 'browser_version': browser_version,
        'browser_online': 'true', 'engine_name': engine_name, 'engine_version': browser_version,
        'os_name': os_name, 'os_version': os_version, 'cpu_core_num': '12', 'device_memory': '8',
        'platform': 'PC', 'downlink': '10', 'effective_type': '4g', 'round_trip_time': '0',
        'update_version_code': '170400', 'aweme_id': str(post_id),
    }
    token = _cookie_values(session.cookie_header).get('msToken')
    if token:
        params['msToken'] = token
    return params


def _douyin_signed_request(post_id, session):
    """Build an ephemeral signed request; never expose it in download metadata."""
    from douyin_signing.abogus import ABogus
    from douyin_signing import websign
    params = _douyin_query(post_id, session)
    # Use one encoded byte sequence for the hash and the final request. Query
    # spaces are percent-encoded so the later visitor signing layer preserves
    # the exact same bytes when serializing its fields.
    query = websign.encode_pairs(list(params.items()))
    bogus = ABogus(session.user_agent, browser_info=session.browser_info).get_value(query)
    pairs = list(params.items()) + [('a_bogus', bogus)]
    cookies = _cookie_values(session.cookie_header)
    uifid = websign.pick_uifid(cookies)
    headers = {'User-Agent': session.user_agent, 'Accept': 'application/json',
               'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
               'Referer': 'https://www.douyin.com/'}
    if uifid:
        verify_fp = cookies.get('s_v_web_id')
        if verify_fp:
            pairs.extend([('verifyFp', verify_fp), ('fp', verify_fp)])
        query, _, visitor_headers = websign.sign(pairs, uifid)
        headers.update(visitor_headers)
    else:
        query = websign.encode_pairs(pairs)
    return 'https://www.douyin.com/aweme/v1/web/aweme/detail/?' + query, headers


def _douyin_signed_detail(post_id, session):
    url, headers = _douyin_signed_request(post_id, session)
    content, _, _ = session.read(url, headers)
    try:
        payload = json.loads(content)
    except ValueError as exc:
        raise SocialExtractError('Douyin chưa trả về dữ liệu cho yêu cầu đã ký. Hãy làm mới phiên đăng nhập.') from exc
    item = _find_item(payload, 'douyin', post_id)
    if not item:
        raise SocialExtractError('Phiên Douyin chưa đọc được bài này. Hãy mở bài trên trình duyệt đã đăng nhập rồi thử lại.')
    return _parse_douyin(item, post_id)


def _tikwm(url, post_id, session):
    content, _, _ = session.read('https://www.tikwm.com/api/?' + urlencode({'url': url, 'hd': '1'}), media=True)
    try:
        payload = json.loads(content)
    except ValueError as exc:
        raise SocialExtractError('Dịch vụ dự phòng TikTok chưa trả về dữ liệu.') from exc
    if payload.get('code') != 0 or not isinstance(payload.get('data'), dict):
        raise SocialExtractError('Dịch vụ dự phòng chưa đọc được bài TikTok. Hãy thử lại sau.')
    data = payload['data']
    if str(data.get('id') or '') != str(post_id):
        raise SocialExtractError('Dịch vụ dự phòng trả về bài đăng khác với link yêu cầu.')
    if data.get('images'):
        assets = [_asset('image', _urls(image), 'tiktok') for image in data['images']]
    else:
        candidates = []
        for key in ('hdplay', 'play', 'wmplay'):
            candidate = data.get(key)
            if isinstance(candidate, str) and candidate.startswith('/'):
                candidate = urljoin('https://www.tikwm.com/', candidate)
            candidates.extend(u for u in _urls(candidate) if u not in candidates)
        assets = [_asset('video', candidates, 'tiktok')] if candidates else []
    result = _result('tiktok', data.get('id') or post_id, data.get('title'),
                     (data.get('author') or {}).get('nickname'), assets)
    result['provider'] = 'tikwm'
    return result


def _yt_dlp(url, platform, post_id, session):
    try:
        import yt_dlp
        from yt_dlp.networking.common import Response
    except ImportError as exc:
        raise SocialExtractError('Chưa có thư viện yt-dlp để thử nguồn video dự phòng.') from exc

    class QuietLogger:
        def debug(self, message):
            pass
        def warning(self, message):
            pass
        def error(self, message):
            pass

    class GuardedYoutubeDL(yt_dlp.YoutubeDL):
        def urlopen(self, request):
            address = getattr(request, 'url', None) or request.get_full_url()
            method = getattr(request, 'method', 'GET')
            data = getattr(request, 'data', None)
            if data is not None and not isinstance(data, bytes):
                raise SocialExtractError('Định dạng yêu cầu video không được hỗ trợ.')
            headers = dict(getattr(request, 'headers', {}) or {})
            headers = {k: v for k, v in headers.items() if k.lower() not in ('host', 'content-length', 'connection', 'accept-encoding', 'cookie')}
            body, final_url, response_headers = session.read(address, headers, media=True, method=method, data=data)
            return Response(io.BytesIO(body), final_url, response_headers)

    try:
        with GuardedYoutubeDL({'quiet': True, 'no_warnings': True, 'logger': QuietLogger(),
                               'noplaylist': True, 'socket_timeout': 12, 'retries': 0,
                               'extractor_retries': 0, 'cachedir': False,
                               'skip_download': True, 'ignore_no_formats_error': False}) as ydl:
            info = ydl.extract_info(url, download=False)
        if str(info.get('id') or '') != str(post_id):
            raise SocialExtractError('Nguồn video dự phòng trả về bài đăng khác với link yêu cầu.')
        formats = [f for f in info.get('formats', []) if f.get('vcodec') != 'none' and f.get('url')]
        formats.sort(key=lambda f: (int(f.get('height') or 0), float(f.get('tbr') or 0)), reverse=True)
        candidates = []
        for fmt in formats:
            if fmt.get('protocol') in ('m3u8', 'm3u8_native', 'http_dash_segments') or fmt.get('vcodec') == 'bytevc2':
                continue
            candidates.extend(u for u in _urls(fmt['url']) if u not in candidates)
        return _result(platform, info.get('id') or post_id, info.get('title'), info.get('uploader'),
                       [_asset('video', candidates, platform)] if candidates else [])
    except SocialExtractError:
        raise
    except Exception as exc:
        raise SocialExtractError('Nguồn video dự phòng chưa đọc được bài đăng.') from exc


def extract(value, cookie_header='', user_agent='', browser_info=''):
    """Return {platform, post_id, title, author, type, assets} for one post."""
    url = normalize_input(value)
    session = _Session(cookie_header, user_agent=user_agent, browser_info=browser_info)
    platform, post_id = _post_reference(url)
    session.cookie_domains = ('tiktok.com',) if platform == 'tiktok' else ('douyin.com', 'iesdouyin.com')
    if not post_id:
        _, url, _ = session.read(url, {
            'User-Agent': session.user_agent if cookie_header else MOBILE_USER_AGENT,
        })
        validate_url(url, resolve_dns=False)
        platform, post_id = _post_reference(url)
    if not post_id:
        raise SocialExtractError('Hãy dùng link một video hoặc bài ảnh cuộn; link hồ sơ chưa được hỗ trợ.')
    canonical = ('https://www.tiktok.com/@_/video/' if platform == 'tiktok' else 'https://www.douyin.com/video/') + post_id
    if platform == 'tiktok':
        attempts = [lambda: _tiktok_direct(url, post_id, session), lambda: _tikwm(canonical, post_id, session)]
    elif cookie_header:
        attempts = [lambda: _douyin_signed_detail(post_id, session), lambda: _douyin_direct(post_id, session)]
    else:
        attempts = [lambda: _douyin_direct(post_id, session), lambda: _douyin_signed_detail(post_id, session)]
    attempts.append(lambda: _yt_dlp(canonical, platform, post_id, session))
    errors = []
    for attempt in attempts:
        try:
            result = attempt()
            result['source_url'] = url
            for asset in result['assets']:
                asset['headers']['User-Agent'] = session.user_agent
            return result
        except SocialExtractError as exc:
            errors.append(str(exc))
        except (ValueError, TypeError, KeyError) as exc:
            errors.append('Dữ liệu bài đăng chưa tương thích với nguồn phân tích.')
    if platform == 'douyin' and any('cookie' in error for error in errors):
        raise SocialExtractError('Douyin yêu cầu cookie mới hoặc xác minh cho bài này. Hãy thử link chia sẻ công khai khác.')
    raise SocialExtractError(errors[0] if errors else 'Không phân tích được bài đăng. Hãy thử lại.')

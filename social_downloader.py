"""Owner-scoped TikTok/Douyin downloads, with bounded disk caching and ZIP export."""
import hashlib
import json
import logging
from pathlib import Path
import re
import shutil
import threading
import time
import urllib.parse
import uuid
import zipfile

import social_extract

TTL = 6 * 60 * 60
MAX_IMAGES = 60
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_VIDEO_BYTES = 300 * 1024 * 1024
MAX_ZIP_BYTES = 250 * 1024 * 1024
MAX_OWNER_BYTES = 600 * 1024 * 1024
LOCK = threading.RLock()
LIVE_OWNERS = set()
TRANSFERS = threading.BoundedSemaphore(4)
FILE_LOCKS = {}
RESERVED_BYTES = {}


class Problem(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def folder(app, owner):
    key = hashlib.sha256(str(owner).encode()).hexdigest()
    result = Path(app.DATA_DIR) / 'social-downloads' / key
    result.mkdir(parents=True, exist_ok=True, mode=0o700)
    return result


def identifier(value):
    if not isinstance(value, str):
        raise Problem('Mã tải không hợp lệ.')
    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError):
        raise Problem('Mã tải không hợp lệ.')
    if str(parsed) != value:
        raise Problem('Mã tải không hợp lệ.')
    return value


def read(app, request_id, owner):
    request_id = identifier(request_id)
    try:
        job = json.loads((folder(app, owner) / request_id / 'metadata.json').read_text())
    except (OSError, ValueError):
        raise Problem('Không tìm thấy nội dung tải. Hãy dán lại link.', 404)
    if job.get('owner') != str(owner):
        raise Problem('Không tìm thấy nội dung tải.', 404)
    if time.time() - job.get('created', 0) > TTL:
        raise Problem('Link tải đã hết hạn. Hãy dán lại link bài đăng.', 410)
    return job


def public(job):
    base = '/api/social-download/file?id=' + job['id'] + '&index='
    items = [{
        'index': index, 'kind': asset['kind'], 'filename': asset['filename'],
        'preview_url': base + str(index),
        'download_url': base + str(index) + '&download=1',
    } for index, asset in enumerate(job['assets'])]
    return {
        'id': job['id'], 'platform': job['platform'], 'post_id': job['post_id'],
        'title': job['title'], 'author': job['author'], 'type': job['type'],
        'provider': job.get('provider', 'direct'),
        'items': items,
        'zip_url': '/api/social-download/zip?id=' + job['id'] if job['type'] == 'images' else None,
    }


def cleanup(root):
    now = time.time()
    for item in root.iterdir():
        if item.is_dir() and now - item.stat().st_mtime > TTL:
            shutil.rmtree(item, ignore_errors=True)


def resolve(app, body, owner):
    if not isinstance(body, dict):
        raise Problem('Dữ liệu yêu cầu không hợp lệ.')
    value = body.get('url')
    if not isinstance(value, str) or not value.strip() or len(value) > 6000:
        raise Problem('Dán link hoặc nội dung chia sẻ TikTok / Douyin, tối đa 6.000 ký tự.')
    value = value.strip()
    cookie = body.get('douyin_cookie', '')
    if not isinstance(cookie, str) or len(cookie) > 16000 or '\r' in cookie or '\n' in cookie:
        raise Problem('Cookie Douyin không hợp lệ; dùng một dòng tối đa 16.000 ký tự.')
    user_agent = body.get('douyin_user_agent', '')
    if (not isinstance(user_agent, str) or len(user_agent) > 512
            or any(ord(c) < 32 or ord(c) > 126 for c in user_agent)):
        raise Problem('User-Agent không hợp lệ; dùng một dòng tối đa 512 ký tự.')
    if cookie:
        normalized_url = social_extract.normalize_input(value)
        if 'douyin' not in (urllib.parse.urlparse(normalized_url).hostname or ''):
            raise Problem('Cookie Douyin chỉ được dùng với link Douyin.')
    request_id = identifier(body.get('request_id'))
    root = folder(app, owner)
    expired = False
    with LOCK:
        try:
            existing = read(app, request_id, owner)
        except Problem as error:
            if error.status not in (404, 410):
                raise
            expired = error.status == 410
        else:
            if existing['input'] != value:
                raise Problem('Mã yêu cầu này đã dùng cho link khác.', 409)
            return public(existing)
        if str(owner) in LIVE_OWNERS:
            raise Problem('Đang đọc một link. Đợi hoàn tất rồi thử tiếp.', 409)
        LIVE_OWNERS.add(str(owner))
    try:
        if expired:
            shutil.rmtree(root / request_id, ignore_errors=True)
        for cache in root.parent.iterdir():
            if cache.is_dir():
                cleanup(cache)
        if sum(1 for p in root.iterdir() if p.is_dir()) >= 30:
            raise Problem('Đã đọc 30 bài trong 6 giờ. Hãy thử lại sau khi bộ nhớ tạm hết hạn.', 429)
        content = social_extract.extract(value, cookie_header=cookie, user_agent=user_agent) if cookie else social_extract.extract(value)
        assets = content.get('assets') or []
        kind = content.get('type')
        if kind not in ('video', 'images') or not 1 <= len(assets) <= MAX_IMAGES:
            raise Problem('Bài đăng không có video hoặc có quá nhiều ảnh để tải.', 422)
        if kind == 'video' and (len(assets) != 1 or assets[0].get('kind') != 'video'):
            raise Problem('Không đọc được file video.', 422)
        platform = content.get('platform')
        if platform not in ('tiktok', 'douyin'):
            raise Problem('Nền tảng không được hỗ trợ.')
        post_id = re.sub(r'[^a-zA-Z0-9_-]', '', str(content.get('post_id') or 'post'))[:80]
        normalized = []
        for index, asset in enumerate(assets):
            if asset.get('kind') != ('video' if kind == 'video' else 'image'):
                raise Problem('Dữ liệu ảnh/video không hợp lệ.', 422)
            urls = asset.get('urls')
            if not isinstance(urls, list) or not urls:
                raise Problem('Không có đường dẫn tải cho ảnh/video.', 422)
            for url in urls[:5]:
                social_extract.validate_url(url, media=True)
            headers = {str(k): str(v) for k, v in (asset.get('headers') or {}).items()
                       if k.lower() in ('user-agent', 'referer', 'accept') and '\r' not in str(v) and '\n' not in str(v)}
            extension = '.mp4' if kind == 'video' else '.jpg'
            path_extension = Path(urllib.parse.urlparse(urls[0]).path).suffix.lower()
            if kind == 'images' and path_extension in ('.png', '.webp', '.jpeg', '.jpg', '.avif', '.gif'):
                extension = path_extension
            normalized.append({'kind': asset['kind'], 'urls': urls[:5], 'headers': headers,
                               'filename': '%s-%s-%02d%s' % (platform, post_id, index + 1, extension)})
        job = dict(id=request_id, owner=str(owner), input=value, created=time.time(),
                   platform=platform, post_id=post_id, title=str(content.get('title') or '')[:4000],
                   author=str(content.get('author') or '')[:300], type=kind, assets=normalized,
                   provider=content.get('provider', 'direct'))
        target = root / request_id
        target.mkdir(mode=0o700, exist_ok=True)
        temporary = target / 'metadata.tmp'
        temporary.write_text(json.dumps(job, ensure_ascii=False), encoding='utf-8')
        temporary.replace(target / 'metadata.json')
        return public(job)
    except social_extract.SocialExtractError as error:
        raise Problem(str(error), 422)
    finally:
        with LOCK:
            LIVE_OWNERS.discard(str(owner))


def file_lock(key):
    with LOCK:
        if key not in FILE_LOCKS:
            # Only keep locks for active transfers; callers release them below.
            FILE_LOCKS[key] = [threading.Lock(), 0]
        entry = FILE_LOCKS[key]
        entry[1] += 1
        return entry[0]


def release_file_lock(key):
    with LOCK:
        FILE_LOCKS[key][1] -= 1
        if FILE_LOCKS[key][1] == 0:
            del FILE_LOCKS[key]


def open_media(url, headers):
    return social_extract.safe_open(url, headers=headers, timeout=25)


def media_type(head, kind):
    if kind == 'video':
        if len(head) >= 12 and head[4:8] == b'ftyp':
            return 'video/mp4', '.mp4'
    else:
        if head.startswith(b'\xff\xd8\xff'):
            return 'image/jpeg', '.jpg'
        if head.startswith(b'\x89PNG\r\n\x1a\n'):
            return 'image/png', '.png'
        if head.startswith(b'RIFF') and head[8:12] == b'WEBP':
            return 'image/webp', '.webp'
        if head[:6] in (b'GIF87a', b'GIF89a'):
            return 'image/gif', '.gif'
        if head[4:8] == b'ftyp' and head[8:12] in (b'avif', b'avis'):
            return 'image/avif', '.avif'
    raise Problem('Nguồn trả về dữ liệu không phải ảnh/video. Hãy đọc lại link bài đăng.', 502)


def media_file(app, job, index):
    if type(index) is not int or not 0 <= index < len(job['assets']):
        raise Problem('Không tìm thấy file.', 404)
    directory = folder(app, job['owner']) / job['id']
    target = directory / ('asset-%02d.bin' % index)
    asset = job['assets'][index]
    key = str(target)
    mutex = file_lock(key)
    try:
        with mutex:
            if not target.is_file():
                if not TRANSFERS.acquire(blocking=False):
                    raise Problem('Đang tải nhiều file. Hãy thử lại trong giây lát.', 429)
                try:
                    _download(app, job, asset, target)
                finally:
                    TRANSFERS.release()
            with target.open('rb') as file:
                mime, extension = media_type(file.read(32), asset['kind'])
            name = str(Path(asset['filename']).with_suffix(extension))
            return target, {'mime': mime, 'filename': name, 'kind': asset['kind']}
    finally:
        release_file_lock(key)


def _download(app, job, asset, target):
    limit = MAX_VIDEO_BYTES if asset['kind'] == 'video' else MAX_IMAGE_BYTES
    root = folder(app, job['owner'])
    owner = job['owner']
    with LOCK:
        used = sum(p.stat().st_size for p in root.rglob('*') if p.is_file())
        remaining = MAX_OWNER_BYTES - used - RESERVED_BYTES.get(owner, 0)
        if remaining <= 0:
            raise Problem('Bộ nhớ tải tạm đã đầy hoặc đang được sử dụng. Hãy thử lại sau.', 413)
        limit = min(limit, remaining)
        RESERVED_BYTES[owner] = RESERVED_BYTES.get(owner, 0) + limit
    try:
        _download_candidates(asset, target, limit)
    finally:
        with LOCK:
            RESERVED_BYTES[owner] -= limit
            if not RESERVED_BYTES[owner]:
                del RESERVED_BYTES[owner]


def _download_candidates(asset, target, limit):
    partial = target.with_suffix('.part')
    last_error = None
    for url in asset['urls']:
        started = time.monotonic()
        try:
            with open_media(url, asset['headers']) as response:
                if response.status != 200:
                    raise Problem('Nguồn chưa trả file hoàn chỉnh.', 502)
                declared = int(response.headers.get('Content-Length', '0'))
                if declared > limit:
                    raise Problem('File vượt giới hạn: video 300 MB, mỗi ảnh 20 MB.', 413)
                length = 0
                with partial.open('wb') as file:
                    while True:
                        chunk = response.read(128 * 1024)
                        if not chunk:
                            break
                        if not length:
                            media_type(chunk, asset['kind'])
                        length += len(chunk)
                        if length > limit:
                            raise Problem('File vượt giới hạn: video 300 MB, mỗi ảnh 20 MB.', 413)
                        if time.monotonic() - started > 180:
                            raise Problem('Tải file quá lâu. Hãy thử lại.', 504)
                        file.write(chunk)
                if not length or (declared and declared != length):
                    raise Problem('File tải chưa hoàn chỉnh. Hãy thử lại.', 502)
            partial.replace(target)
            return
        except Exception as error:
            partial.unlink(missing_ok=True)
            last_error = error
            if isinstance(error, Problem) and error.status == 413:
                raise
    if isinstance(last_error, Problem):
        raise last_error
    raise Problem('Không tải được file từ nền tảng. Link có thể đã hết hạn; hãy dán lại link bài đăng.', 502)


def zip_file(app, job):
    if job['type'] != 'images':
        raise Problem('Chỉ bài ảnh cuộn mới có bộ ZIP.')
    target = folder(app, job['owner']) / job['id'] / 'images.zip'
    key = str(target)
    mutex = file_lock(key)
    try:
        with mutex:
            if not target.is_file():
                temporary = target.with_suffix('.part')
                reserved = 0
                try:
                    files = []
                    total = 0
                    projected = 22  # ZIP end record; names are generated ASCII.
                    for index in range(len(job['assets'])):
                        path, item = media_file(app, job, index)
                        size = path.stat().st_size
                        total += size
                        if total > MAX_ZIP_BYTES:
                            raise Problem('Bộ ảnh vượt 250 MB. Hãy tải từng ảnh riêng.', 413)
                        projected += size + 76 + 2 * len(item['filename'].encode('utf-8'))
                        files.append((path, item))
                    with LOCK:
                        root = folder(app, job['owner'])
                        used = sum(p.stat().st_size for p in root.rglob('*') if p.is_file())
                        if used + projected + RESERVED_BYTES.get(job['owner'], 0) > MAX_OWNER_BYTES:
                            raise Problem('Không đủ bộ nhớ tạm để đóng ZIP. Hãy tải từng ảnh riêng.', 413)
                        RESERVED_BYTES[job['owner']] = RESERVED_BYTES.get(job['owner'], 0) + projected
                        reserved = projected
                    with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_STORED) as archive:
                        for path, item in files:
                            archive.write(path, arcname=item['filename'])
                    temporary.replace(target)
                except Exception:
                    temporary.unlink(missing_ok=True)
                    raise
                finally:
                    if reserved:
                        with LOCK:
                            RESERVED_BYTES[job['owner']] -= reserved
                            if not RESERVED_BYTES[job['owner']]:
                                del RESERVED_BYTES[job['owner']]
            return target, {'mime': 'application/zip', 'filename': '%s-%s-images.zip' % (job['platform'], job['post_id'])}
    finally:
        release_file_lock(key)


def send_file(h, path, item, attachment=False):
    size = path.stat().st_size
    start, end = 0, size - 1
    requested = h.headers.get('Range') if not attachment else None
    if requested:
        match = re.fullmatch(r'bytes=(\d*)-(\d*)', requested)
        try:
            if not match or not any(match.groups()):
                raise ValueError()
            if match[1]:
                start = int(match[1])
                end = min(int(match[2]), end) if match[2] else end
            else:
                amount = int(match[2])
                if amount <= 0:
                    raise ValueError()
                start = max(0, size - amount)
            if start > end or start >= size:
                raise ValueError()
        except ValueError:
            h.send_response(416)
            h.send_header('Content-Range', 'bytes */%d' % size)
            h.send_header('Content-Length', '0')
            h.end_headers()
            return
    h.send_response(206 if requested else 200)
    h.send_header('Content-Type', item['mime'])
    h.send_header('Content-Length', str(end - start + 1))
    h.send_header('Cache-Control', 'private, no-store')
    h.send_header('X-Content-Type-Options', 'nosniff')
    h.send_header('Accept-Ranges', 'bytes')
    if requested:
        h.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, size))
    if attachment:
        h.send_header('Content-Disposition', 'attachment; filename="%s"' % item['filename'])
    h.end_headers()
    try:
        with path.open('rb') as file:
            file.seek(start)
            remaining = end - start + 1
            while remaining:
                chunk = file.read(min(128 * 1024, remaining))
                if not chunk:
                    break
                h.wfile.write(chunk)
                remaining -= len(chunk)
    except (BrokenPipeError, ConnectionResetError):
        pass


def route(app, h, path, body=None):
    if not path.startswith('/api/social-download/'):
        return False
    try:
        user = h.current_user()
        if app.AUTH_REQUIRED and not user:
            raise Problem('Vui lòng đăng nhập để tải TikTok / Douyin.', 401)
        if app.AUTH_REQUIRED and not app.user_has_tab(user, 'socialdownload'):
            raise Problem('Tài khoản chưa được cấp tab Tải TikTok / Douyin.', 403)
        owner = str((user or {}).get('id') or (user or {}).get('email') or 'local')
        method = getattr(h, 'command', 'POST' if body is not None else 'GET')
        if method == 'POST':
            origin = h.headers.get('Origin')
            if origin:
                parsed = urllib.parse.urlparse(origin)
                if parsed.scheme not in ('http', 'https') or parsed.netloc != h.headers.get('Host'):
                    raise Problem('Nguồn yêu cầu không hợp lệ.', 403)
            if h.headers.get('Sec-Fetch-Site') == 'cross-site':
                raise Problem('Nguồn yêu cầu không hợp lệ.', 403)
            if body is None:
                try:
                    length = int(h.headers.get('Content-Length', '0'))
                except ValueError:
                    raise Problem('Độ dài yêu cầu không hợp lệ.')
                if not 0 < length <= 32000:
                    raise Problem('Yêu cầu quá lớn hoặc thiếu nội dung.', 413)
                try:
                    body = json.loads(h.rfile.read(length))
                except (ValueError, UnicodeDecodeError):
                    raise Problem('JSON không hợp lệ.')
        action = path.rsplit('/', 1)[-1]
        if method == 'GET' and action == 'config':
            h.json(200, {'available': True, 'max_images': MAX_IMAGES, 'max_video_mb': 300})
        elif method == 'POST' and action == 'resolve':
            h.json(200, resolve(app, body, owner))
        elif method == 'GET' and action in ('file', 'zip'):
            query = urllib.parse.parse_qs(urllib.parse.urlparse(h.path).query)
            job = read(app, query.get('id', [''])[0], owner)
            if action == 'zip':
                file, item = zip_file(app, job)
                send_file(h, file, item, True)
            else:
                try:
                    index = int(query.get('index', [''])[0])
                except ValueError:
                    raise Problem('Vị trí file không hợp lệ.')
                file, item = media_file(app, job, index)
                send_file(h, file, item, query.get('download', [''])[0] == '1')
        else:
            raise Problem('Không tìm thấy chức năng.', 404)
    except Problem as error:
        h.json(error.status, {'error': str(error)})
    except social_extract.SocialExtractError as error:
        h.json(422, {'error': str(error)})
    except Exception:
        logging.getLogger('aidesign.social-download').exception('Social download failed')
        h.json(502, {'error': 'Chưa đọc được nội dung tải. Hãy thử lại link bài đăng.'})
    return True

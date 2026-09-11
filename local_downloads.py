"""Save local tool exports through the macOS save dialog."""
import base64
import os
import subprocess
import tempfile
import threading
from urllib.parse import urlsplit

_LOCK = threading.Lock()

def save(handler, body):
    origin = urlsplit(handler.headers.get('Origin', ''))
    if handler.client_address[0] not in ('127.0.0.1', '::1') or origin.scheme != 'http' or origin.netloc != handler.headers.get('Host') or origin.hostname not in ('localhost', '127.0.0.1', '::1'):
        return handler.json(403, {'error': 'Chỉ lưu file từ tool trên máy này.'})
    if not _LOCK.acquire(blocking=False):
        return handler.json(409, {'error': 'Hãy hoàn tất hộp chọn nơi lưu đang mở.'})
    path = None
    try:
        encoded = body.get('data', '')
        if not isinstance(encoded, str) or len(encoded) > 280000000:
            raise ValueError('File quá lớn.')
        data = base64.b64decode(encoded, validate=True)
        name = os.path.basename(str(body.get('name') or 'download.zip')).replace('\x00', '')[:180]
        with tempfile.NamedTemporaryFile(delete=False) as f:
            path = f.name
            f.write(data)
        helper = os.path.join(os.path.dirname(__file__), 'scripts', 'save-file-dialog')
        result = subprocess.run([helper, path, name], capture_output=True, text=True, timeout=600)
        if result.returncode:
            raise ValueError(result.stderr.strip() or 'Không mở được hộp lưu file.')
        return handler.json(200, {'status': result.stdout.strip()})
    except Exception as e:
        return handler.json(400, {'error': str(e)})
    finally:
        if path:
            os.unlink(path)
        _LOCK.release()

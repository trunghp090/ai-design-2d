"""Bounded static-file cache and small mockup previews; originals stay untouched."""
import gzip
import io
import os
import re
import threading
from functools import lru_cache

_thumb_locks = [threading.Lock() for _ in range(16)]

@lru_cache(maxsize=48)
def _static(path, mtime, size, version, compressed):
    with open(path, 'rb') as f:
        data = f.read()
    if path.endswith('.html'):
        # Version every local script/style, including extension modules.
        data = re.sub(rb'((?:src|href)="/[^"?]+\.(?:js|css))(?:\?[^"<>]*)?"',
                      lambda m: m[1] + b'?v=' + version.encode() + b'"', data)
    return gzip.compress(data, 6) if compressed else data


def static_bytes(path, version, compressed):
    stat = os.stat(path)
    return _static(path, stat.st_mtime_ns, stat.st_size, version, compressed)


def mockup_thumbnail(folder, name):
    from PIL import Image, ImageOps
    if name != os.path.basename(name) or not name.lower().endswith('.png'):
        raise FileNotFoundError(name)
    src = os.path.join(folder, name)
    stat = os.stat(src)
    tag = '"%x-%x"' % (stat.st_mtime_ns, stat.st_size)
    target = os.path.join(folder, '.thumbs', name + '.jpg')
    with _thumb_locks[hash(name) % len(_thumb_locks)]:
        if not os.path.isfile(target) or os.stat(target).st_mtime_ns < stat.st_mtime_ns:
            with Image.open(src) as image:
                image = ImageOps.exif_transpose(image)
                image.thumbnail((480, 480))
                rgba = image.convert('RGBA')
                preview = Image.new('RGB', rgba.size, 'white')
                preview.paste(rgba, mask=rgba.getchannel('A'))
                data = io.BytesIO()
                preview.save(data, 'JPEG', quality=80)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            temp = target + '.tmp'
            with open(temp, 'wb') as f:
                f.write(data.getvalue())
            os.replace(temp, target)
        with open(target, 'rb') as f:
            return f.read(), tag

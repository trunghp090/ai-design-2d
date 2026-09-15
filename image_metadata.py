"""Remove descriptive/provenance metadata from generated image files.

PNG image data, transparency, color management and print density are preserved.
This does not detect or remove visible logos or watermarks encoded in pixels.
"""

import base64
import binascii
import io
import math
import struct
import zlib

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
# Keep only image/rendering chunks defined by the PNG specification. Everything
# else (including text, EXIF, XMP, C2PA caBX and private chunks) is discarded.
PNG_KEEP = frozenset((
    b"IHDR", b"PLTE", b"IDAT", b"IEND", b"tRNS", b"gAMA", b"cHRM",
    b"sRGB", b"iCCP", b"cICP", b"mDCV", b"cLLI", b"sBIT", b"bKGD",
    b"pHYs", b"acTL", b"fcTL", b"fdAT",
))


def _clean_png(raw):
    parts = [PNG_SIGNATURE]
    view = memoryview(raw)
    offset = 8
    seen_header = seen_data = False
    while offset + 12 <= len(raw):
        length = struct.unpack_from(">I", view, offset)[0]
        end = offset + length + 12
        if end > len(raw):
            raise ValueError("Ảnh PNG bị thiếu dữ liệu; chưa thể làm sạch metadata.")
        kind = bytes(view[offset + 4:offset + 8])
        if any(not (65 <= c <= 90 or 97 <= c <= 122) for c in kind):
            raise ValueError("Ảnh PNG có cấu trúc không hợp lệ.")
        crc = struct.unpack_from(">I", view, end - 4)[0]
        if zlib.crc32(view[offset + 4:end - 4]) & 0xffffffff != crc:
            raise ValueError("Ảnh PNG bị lỗi checksum; chưa thể làm sạch metadata.")
        if not seen_header:
            if kind != b"IHDR" or length != 13:
                raise ValueError("Ảnh PNG thiếu header hợp lệ.")
            seen_header = True
        elif kind == b"IHDR":
            raise ValueError("Ảnh PNG có header trùng lặp.")
        if not kind[0] & 32 and kind not in PNG_KEEP:
            raise ValueError("Ảnh PNG dùng định dạng chưa được hỗ trợ.")
        if kind == b"IDAT":
            seen_data = True
        if kind in PNG_KEEP:
            parts.append(view[offset:end])
        if kind == b"IEND":
            if length or not seen_data:
                raise ValueError("Ảnh PNG thiếu dữ liệu điểm ảnh.")
            # Data appended after IEND can also contain provenance metadata.
            return b"".join(parts)
        offset = end
    raise ValueError("Ảnh PNG bị thiếu phần kết thúc.")


def clean_image(raw):
    """Return clean PNG bytes; never silently return an unsanitized image."""
    if not isinstance(raw, (bytes, bytearray)) or not raw:
        raise ValueError("Không có dữ liệu ảnh để làm sạch metadata.")
    if raw.startswith(PNG_SIGNATURE):
        return _clean_png(raw)
    try:
        from PIL import Image, ImageOps
        with Image.open(io.BytesIO(raw)) as source:
            source.load()
            profile = source.info.get("icc_profile")
            density = source.info.get("dpi")
            oriented = ImageOps.exif_transpose(source)
            mode = "RGBA" if "A" in oriented.getbands() or "transparency" in oriented.info else "RGB"
            pixels = oriented.convert(mode)
            clean = Image.frombytes(mode, pixels.size, pixels.tobytes())
            options = {}
            if profile:
                options["icc_profile"] = profile
            if (isinstance(density, (tuple, list)) and len(density) == 2
                    and all(isinstance(d, (int, float)) and math.isfinite(d) and 0 < d < 100000 for d in density)):
                options["dpi"] = tuple(density)
            out = io.BytesIO()
            clean.save(out, "PNG", **options)
            return _clean_png(out.getvalue())
    except Exception as exc:
        raise ValueError("Không thể làm sạch metadata của ảnh đầu ra.") from exc


def clean_image_b64(value):
    """Return base64 of a clean PNG, accepting raw base64 or an image data URL."""
    if not isinstance(value, str):
        raise ValueError("Dữ liệu ảnh đầu ra không hợp lệ.")
    if value.startswith("data:image/"):
        value = value.partition(",")[2]
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ValueError("Dữ liệu base64 của ảnh đầu ra không hợp lệ.") from exc
    return base64.b64encode(clean_image(raw)).decode("ascii")

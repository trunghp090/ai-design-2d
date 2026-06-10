#!/usr/bin/env python3
"""
AI Design 2D - clone & redesign artwork áo bằng OpenAI gpt-image.
Tính năng:
  - Clone / redesign design từ ảnh áo  (POST /api/generate)
  - Upscale 4x cho in (Pillow Lanczos)  (POST /api/upscale)
  - Gallery lịch sử lưu trên đĩa         (GET/DELETE /api/gallery)
  - Mockup thật tạo bằng AI + nhiều màu  (POST /api/make-mockup)

Chạy:  python3 server.py   →  http://localhost:8000
Cấu hình .env:  OPENAI_API_KEY, OPENAI_IMAGE_MODEL, PORT
"""

import base64
import hashlib
import io
import json
import mimetypes
import os
import re
import sqlite3
import struct
import sys
import threading
import time
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(ROOT, "public")
GALLERY_DIR = os.path.join(ROOT, "gallery")
MOCKUP_DIR = os.path.join(ROOT, "mockups")
GALLERY_INDEX = os.path.join(GALLERY_DIR, "index.json")
MOCKUP_INDEX = os.path.join(MOCKUP_DIR, "labels.json")
DATA_DIR = os.path.join(ROOT, "data")            # dữ liệu bền (mount volume khi deploy)
AUTH_DB = os.path.join(DATA_DIR, "auth.db")
_auth_lock = threading.Lock()

EDITS_URL = "https://api.openai.com/v1/images/edits"
GEN_URL = "https://api.openai.com/v1/images/generations"

try:
    from PIL import Image, ImageFilter
    HAS_PIL = True
except Exception:
    HAS_PIL = False

try:
    from rembg import remove as _rembg_remove, new_session as _rembg_new_session
    HAS_REMBG = True
except Exception:
    HAS_REMBG = False

try:
    import onnxruntime as _ort
    import numpy as _np
    HAS_ONNX = True
except Exception:
    HAS_ONNX = False

_REMBG_SESSIONS = {}            # cache theo từng model
REMBG_MODELS = {"u2net", "isnet-general-use", "birefnet-general", "bria-rmbg",
                "u2netp", "silueta"}


def rembg_session(model="u2net"):
    if model not in _REMBG_SESSIONS:
        _REMBG_SESSIONS[model] = _rembg_new_session(model)
    return _REMBG_SESSIONS[model]


# --------------------------------------------------------------------------- #
def load_env():
    path = os.path.join(ROOT, ".env")
    if not os.path.isfile(path):
        return
    for line in open(path, "r", encoding="utf-8"):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_env()
API_KEY = os.environ.get("OPENAI_API_KEY", "").strip()
MODEL = os.environ.get("OPENAI_IMAGE_MODEL", "gpt-image-1").strip()
PORT = int(os.environ.get("PORT", "8000"))
# Bật đăng nhập? (đặt AUTH_REQUIRED=0 trong .env để tắt — mặc định BẬT)
AUTH_REQUIRED = os.environ.get("AUTH_REQUIRED", "1").strip() not in ("0", "false", "no")
CUTOUTPRO_KEY = os.environ.get("CUTOUTPRO_API_KEY", "").strip()
CUTOUTPRO_TYPE = os.environ.get("CUTOUTPRO_MATTING_TYPE", "6").strip()  # 6 = matting tổng quát

SIZE_MAP = {
    "portrait": "1024x1536",
    "landscape": "1536x1024",
    "square": "1024x1024",
    "auto": "auto",
}

# gpt-image-2 KHÔNG hỗ trợ background=transparent -> phải tạo nền trắng rồi tự xoá
NATIVE_TRANSPARENT = not MODEL.startswith("gpt-image-2")

COLOR_HEX = {
    "white": "#f5f5f5", "black": "#1c1c1e", "gray": "#9aa0a6",
    "navy": "#21304d", "red": "#b3261e", "sand": "#d8c3a5",
    "forest": "#2f5d3a", "pink": "#e8a0b8",
}
COLOR_VI = {
    "white": "trắng", "black": "đen", "gray": "xám", "navy": "xanh navy",
    "red": "đỏ", "sand": "be", "forest": "xanh rêu", "pink": "hồng",
}


# --------------------------------------------------------------------------- #
#  Prompt
# --------------------------------------------------------------------------- #
def build_prompt(mode, user_prompt, bg_mode):
    """bg_mode: 'transparent' (native) | 'white' (để floodfill) | 'solid'"""
    user_prompt = (user_prompt or "").strip()
    if bg_mode == "transparent":
        bg = ("Place the artwork on a FULLY TRANSPARENT background (alpha channel), "
              "no shirt, no fabric, no mockup, no shadow, no backdrop.")
    elif bg_mode == "neutral":
        bg = ("Center the artwork on a FLAT PLAIN MEDIUM-GRAY (#808080) background with "
              "even margins, evenly lit, no shadow, no gradient, no texture. The gray "
              "must clearly contrast with every part of the artwork — including any "
              "WHITE or light-colored text and details — so nothing blends into the "
              "background and the subject can be cleanly segmented.")
    elif bg_mode == "chroma":
        bg = ("Place the artwork as an isolated cut-out on a SOLID FLAT BRIGHT MAGENTA "
              "(#FF00FF) background — ONE uniform color filling the whole background, even "
              "margins, absolutely no scene, no shadow, no gradient, no texture. Magenta "
              "is only a removable backdrop; keep the artwork's own colors unchanged.")
    else:
        bg = "Use a clean solid background."
    if mode == "cloner":
        base = (
            "Clone the design/artwork printed on the garment in the provided image exactly "
            "as it appears — same illustration, same text (keep all Vietnamese diacritics, "
            "e.g. 'Mẹ Kẽ Chuối'), same colors, same composition. Reproduce it as a clean, "
            "sharp, high-resolution standalone graphic. Output ONLY the artwork itself "
            "(no t-shirt, no body, no folds, no wrinkles). " + bg
        )
    elif mode == "redesign":
        base = (
            "You are an apparel graphic designer. Take the design printed on the "
            "garment as inspiration and produce an improved, cleaner, high-resolution "
            "print-ready version. Output only the artwork. " + bg
        )
    elif mode == "variation":
        base = (
            "Create a fresh creative variation of the artwork printed on the garment, "
            "keeping the same theme and style. Output only the artwork, high "
            "resolution and print-ready. " + bg
        )
    else:
        base = (
            "Recreate the artwork in the provided image as a clean high-resolution "
            "print-ready graphic. Output only the artwork. " + bg
        )
    if user_prompt:
        base += " Apply these requested changes: " + user_prompt
    return base.strip()


def effective_prompt(mode, user_prompt, transparent):
    """Prompt thực tế sẽ gửi cho model (khớp đúng với gen_design)."""
    if transparent and NATIVE_TRANSPARENT:
        return build_prompt(mode, user_prompt, "transparent")
    return build_prompt(mode, user_prompt, "chroma" if transparent else "solid")


# --------------------------------------------------------------------------- #
#  Tải ảnh đầu vào
# --------------------------------------------------------------------------- #
def fetch_image_bytes(src):
    src = src.strip()
    if not src:
        return None, None
    if src.startswith("data:"):
        header, b64 = src.split(",", 1)
        mime = header[5:].split(";")[0] or "image/png"
        return base64.b64decode(b64), mime
    if src.startswith("http://") or src.startswith("https://"):
        req = urllib.request.Request(src, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read(), r.headers.get("Content-Type", "image/png").split(";")[0]
    try:
        return base64.b64decode(src), "image/png"
    except Exception:
        return None, None


def ext_for_mime(m):
    return {"image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg",
            "image/webp": "webp"}.get(m, "png")


# --------------------------------------------------------------------------- #
#  OpenAI calls
# --------------------------------------------------------------------------- #
def build_multipart(fields, files):
    boundary = "----AIDesign" + base64.b16encode(os.urandom(8)).decode()
    nl = b"\r\n"
    body = io.BytesIO()
    for name, value in fields:
        body.write(b"--" + boundary.encode() + nl)
        body.write(('Content-Disposition: form-data; name="%s"' % name).encode() + nl + nl)
        body.write(str(value).encode("utf-8") + nl)
    for name, filename, mime, content in files:
        body.write(b"--" + boundary.encode() + nl)
        body.write(('Content-Disposition: form-data; name="%s"; filename="%s"'
                    % (name, filename)).encode() + nl)
        body.write(("Content-Type: %s" % mime).encode() + nl + nl)
        body.write(content + nl)
    body.write(b"--" + boundary.encode() + b"--" + nl)
    return body.getvalue(), boundary


def openai_edit(images, prompt, size, native_transparent):
    fields = [("model", MODEL), ("prompt", prompt), ("n", "1")]
    if size and size != "auto":
        fields.append(("size", size))
    if native_transparent:
        fields += [("background", "transparent"), ("output_format", "png")]
    files = [("image[]", "shirt_%d.%s" % (i, ext_for_mime(m)), m, d)
             for i, (d, m) in enumerate(images)]
    body, boundary = build_multipart(fields, files)
    req = urllib.request.Request(EDITS_URL, data=body, method="POST")
    req.add_header("Authorization", "Bearer " + API_KEY)
    req.add_header("Content-Type", "multipart/form-data; boundary=" + boundary)
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read())["data"][0]["b64_json"]


def openai_generate(prompt, size="1024x1024"):
    payload = {"model": MODEL, "prompt": prompt, "n": 1, "size": size}
    req = urllib.request.Request(GEN_URL, data=json.dumps(payload).encode(),
                                 method="POST")
    req.add_header("Authorization", "Bearer " + API_KEY)
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read())["data"][0]["b64_json"]


# --------------------------------------------------------------------------- #
#  Upscale (Pillow)
# --------------------------------------------------------------------------- #
def remove_flat_bg(raw, thresh=45):
    """Xoá nền phẳng (BẤT KỲ màu gì) -> trong suốt bằng flood-fill từ viền.
    Tự lấy màu nền ở các góc nên dùng được cho nền trắng, magenta, xám...
    Giữ nguyên màu & chi tiết bên trong design (kể cả vùng cùng màu nhưng không nối ra viền).
    """
    if not HAS_PIL:
        return raw
    from PIL import ImageDraw, ImageChops
    im = Image.open(io.BytesIO(raw)).convert("RGB")
    w, h = im.size
    px = im.load()
    corners = [px[0, 0], px[w - 1, 0], px[0, h - 1], px[w - 1, h - 1]]
    avg = tuple(sum(c[i] for c in corners) // 4 for i in range(3))   # màu nền trung bình
    sat = max(avg) - min(avg)
    rb, gb, bb = im.split()

    def close(a, b, tol=28):
        return all(abs(a[i] - b[i]) <= tol for i in range(3))

    if sat >= 55:
        # NỀN MÀU (chroma, vd magenta): xoá theo KHOẢNG CÁCH màu tới màu nền.
        # - alpha mềm (anti-alias) ở rìa thay vì cứng -> hết răng cưa
        # - DESPILL: rìa bán trong suốt được làm XÁM -> không còn ám màu nền (hồng/xanh)
        # Xoá sạch cả phần nền lọt trong bụng chữ vì cùng màu nền.
        cr, cg, cb = avg
        dr = rb.point(lambda v, c=cr: abs(v - c))
        dg = gb.point(lambda v, c=cg: abs(v - c))
        db = bb.point(lambda v, c=cb: abs(v - c))
        dist = ImageChops.lighter(ImageChops.lighter(dr, dg), db)  # box-distance / pixel
        tin, tout = 90, 185   # dải rộng hơn -> viền hồng nhạt cũng mờ dần
        alpha = dist.point(lambda v: 0 if v <= tin else (255 if v >= tout
                           else int((v - tin) * 255 / (tout - tin))))
        # DESPILL an toàn (khử ám hồng do magenta): nâng kênh Green lên = max(G, min(R,B)).
        # Magenta/hồng có G thấp hơn R&B -> được nâng về trung tính; KHÔNG đụng tới
        # đỏ/xanh/vàng (vì các màu đó G không thấp hơn cả R lẫn B).
        min_rb = ImageChops.darker(rb, bb)
        gb2 = ImageChops.lighter(gb, min_rb)
        out = Image.merge("RGBA", (rb, gb2, bb, alpha))
    else:
        # NỀN TRẮNG/XÁM: cần 4 góc đồng nhất rồi floodfill từ viền (giữ vùng cùng màu
        # nằm bên trong design). Nếu nền không đồng nhất thì không xoá để tránh hỏng.
        if not all(close(corners[0], c) for c in corners):
            return raw
        SENT = (255, 0, 254)
        if close(corners[0], SENT, 8):
            SENT = (0, 255, 1)
        seeds = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1),
                 (w // 2, 0), (w // 2, h - 1), (0, h // 2), (w - 1, h // 2)]
        for sx, sy in seeds:
            ImageDraw.floodfill(im, (sx, sy), SENT, thresh=thresh)
        rb, gb, bb = im.split()
        mr = rb.point(lambda v: 255 if v == SENT[0] else 0)
        mg = gb.point(lambda v: 255 if v == SENT[1] else 0)
        mb = bb.point(lambda v: 255 if v == SENT[2] else 0)
        bgmask = ImageChops.multiply(ImageChops.multiply(mr, mg), mb)
        out = im.convert("RGBA")
        out.putalpha(ImageChops.invert(bgmask))

    buf = io.BytesIO()
    out.save(buf, "PNG")
    return buf.getvalue()


def remove_bg_ai(raw, model="u2net", matting=True):
    """Xoá nền bằng rembg. matting=True bật alpha matting (viền mịn, khử halo)."""
    if not HAS_REMBG:
        return None
    if matting:
        try:
            return _rembg_remove(
                raw, session=rembg_session(model), post_process_mask=True,
                alpha_matting=True,
                alpha_matting_foreground_threshold=240,
                alpha_matting_background_threshold=15,
                alpha_matting_erode_size=8,
            )
        except Exception:
            pass  # pymatting lỗi với vài ảnh -> rớt xuống bản thường
    return _rembg_remove(raw, session=rembg_session(model), post_process_mask=True)


def remove_bg_cutoutpro(raw):
    """Xoá nền bằng API cutout.pro (Cut Pro). Trả PNG bytes hoặc raise lỗi."""
    if not CUTOUTPRO_KEY:
        raise RuntimeError("Chưa cấu hình CUTOUTPRO_API_KEY trong .env")
    url = "https://www.cutout.pro/api/v1/matting?mattingType=" + CUTOUTPRO_TYPE
    body, boundary = build_multipart([], [("file", "image.png", "image/png", raw)])
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("APIKEY", CUTOUTPRO_KEY)
    req.add_header("Content-Type", "multipart/form-data; boundary=" + boundary)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            ctype = resp.headers.get("Content-Type", "")
            data = resp.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")[:300]
        raise RuntimeError("cutout.pro HTTP %s: %s" % (e.code, detail))
    if ctype.startswith("image"):
        return data
    # không phải ảnh -> chắc là JSON báo lỗi
    try:
        j = json.loads(data.decode("utf-8", "ignore"))
    except Exception:
        raise RuntimeError("cutout.pro trả về không hợp lệ")
    # một số response bọc ảnh trong data.imageBase64 / imageUrl
    d = j.get("data") or {}
    if isinstance(d, dict):
        if d.get("imageBase64"):
            return base64.b64decode(d["imageBase64"])
        if d.get("imageUrl"):
            with urllib.request.urlopen(d["imageUrl"], timeout=60) as r2:
                return r2.read()
    raise RuntimeError("cutout.pro lỗi: " + str(j.get("msg") or j))


def strip_background(raw, method, matting=True):
    """method: 'flat' (theo màu nền) | 'cutoutpro' | 'none' | tên model rembg.
    matting: bật alpha matting cho các model rembg (viền mịn hơn)."""
    if method == "none":
        return raw
    if method == "flat":
        return remove_flat_bg(raw)
    if method == "cutoutpro":
        return remove_bg_cutoutpro(raw)
    # còn lại coi là model rembg
    if HAS_REMBG:
        model = method if method in REMBG_MODELS else "u2net"
        try:
            out = remove_bg_ai(raw, model, matting)
            if out:
                return out
        except Exception:
            pass  # rớt xuống floodfill nếu model lỗi/tải fail
    return remove_flat_bg(raw)


def gen_design(images, mode, user_prompt, size, transparent, override=None):
    """Tạo design. override = prompt người dùng tự sửa (nếu có) -> dùng thẳng.
    Trả về (b64, prompt_đã_dùng).
    """
    override = (override or "").strip()
    if transparent and NATIVE_TRANSPARENT:
        p = override or build_prompt(mode, user_prompt, "transparent")
        try:
            return openai_edit(images, p, size, native_transparent=True), p
        except urllib.error.HTTPError as e:
            msg = e.read().decode("utf-8", "ignore")
            if not (e.code == 400 and "background" in msg):
                raise urllib.error.HTTPError(e.url, e.code, msg, e.headers, None)
    p = override or build_prompt(mode, user_prompt, "chroma" if transparent else "solid")
    b64 = openai_edit(images, p, size, native_transparent=False)
    # TÍCH HỢP: clone xong tự tách nền luôn (chroma key) -> trả design trong suốt sẵn.
    if transparent and HAS_PIL:
        try:
            raw = remove_flat_bg(base64.b64decode(b64))
            b64 = base64.b64encode(raw).decode()
        except Exception:
            pass  # nếu lỗi vẫn trả design có nền
    return b64, p


def upscale_png(raw, target_long=4500):
    if not HAS_PIL:
        return raw  # không có Pillow -> trả nguyên bản
    im = Image.open(io.BytesIO(raw)).convert("RGBA")
    w, h = im.size
    scale = target_long / max(w, h)
    if scale <= 1:
        big = im
    else:
        big = im.resize((round(w * scale), round(h * scale)), Image.LANCZOS)
        big = big.filter(ImageFilter.UnsharpMask(radius=1.4, percent=85, threshold=2))
    out = io.BytesIO()
    big.save(out, "PNG", dpi=(300, 300))
    return out.getvalue()


# --------------------------------------------------------------------------- #
#  AI Upscale (Swin2SR x4, ONNX) + tiling
# --------------------------------------------------------------------------- #
SWIN_PATH = os.path.join(ROOT, "models", "swin2sr_x4.onnx")
SWIN_URL = ("https://huggingface.co/Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr"
            "/resolve/main/onnx/model.onnx")
_SWIN_SESSION = None


def ensure_swin():
    if os.path.isfile(SWIN_PATH) and os.path.getsize(SWIN_PATH) > 1_000_000:
        return True
    try:
        os.makedirs(os.path.dirname(SWIN_PATH), exist_ok=True)
        req = urllib.request.Request(SWIN_URL, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=240) as r, open(SWIN_PATH, "wb") as f:
            f.write(r.read())
        return os.path.getsize(SWIN_PATH) > 1_000_000
    except Exception:
        return False


def swin_session():
    global _SWIN_SESSION
    if _SWIN_SESSION is None:
        _SWIN_SESSION = _ort.InferenceSession(SWIN_PATH, providers=["CPUExecutionProvider"])
    return _SWIN_SESSION


def _swin_tiled(arr, tile=256, overlap=24, scale=4):
    sess = swin_session()
    inp = sess.get_inputs()[0].name
    H, W, _ = arr.shape
    step = tile - overlap
    acc = _np.zeros((H * scale, W * scale, 3), _np.float32)
    wsum = _np.zeros((H * scale, W * scale, 1), _np.float32)

    def feather(h, w):
        wy = _np.minimum(_np.arange(h), _np.arange(h)[::-1]) + 1
        wx = _np.minimum(_np.arange(w), _np.arange(w)[::-1]) + 1
        return (_np.minimum.outer(wy, wx).astype(_np.float32) / max(min(h, w), 1))[..., None]

    M = 64  # Swin2SR cần cạnh chia hết cho 64
    y = 0
    while y < H:
        y2 = min(y + tile, H); y1 = max(0, y2 - tile)
        x = 0
        while x < W:
            x2 = min(x + tile, W); x1 = max(0, x2 - tile)
            patch = arr[y1:y2, x1:x2]
            ph, pw = patch.shape[:2]
            Hp = ((ph + M - 1) // M) * M
            Wp = ((pw + M - 1) // M) * M
            pp = _np.pad(patch, ((0, Hp - ph), (0, Wp - pw), (0, 0)), mode="edge")
            t = (pp.astype(_np.float32) / 255.0).transpose(2, 0, 1)[None]
            out = _np.clip(sess.run(None, {inp: t})[0][0], 0, 1).transpose(1, 2, 0)
            out = out[:ph * scale, :pw * scale]      # bỏ phần padding
            oh, ow = out.shape[:2]
            oy, ox = y1 * scale, x1 * scale
            wgt = feather(oh, ow)
            acc[oy:oy + oh, ox:ox + ow] += out * wgt
            wsum[oy:oy + oh, ox:ox + ow] += wgt
            if x2 >= W:
                break
            x += step
        if y2 >= H:
            break
        y += step
    res = acc / _np.maximum(wsum, 1e-6)
    return (_np.clip(res, 0, 1) * 255).astype(_np.uint8)


def ai_upscale_png(raw, target_long=4500):
    """Upscale bằng Swin2SR x4 + tiling, rồi resize về target. Fallback Lanczos nếu lỗi."""
    if not (HAS_ONNX and HAS_PIL) or not ensure_swin():
        return upscale_png(raw, target_long)
    try:
        im = Image.open(io.BytesIO(raw)).convert("RGBA")
        # pre-resize để x4 ~ target (tiết kiệm RAM/thời gian)
        pre = max(1, target_long // 4)
        w, h = im.size
        if max(w, h) > pre:
            s = pre / max(w, h)
            im = im.resize((round(w * s), round(h * s)), Image.LANCZOS)
        alpha = im.getchannel("A")
        rgb = _np.asarray(im.convert("RGB"), dtype=_np.uint8)
        big = Image.fromarray(_swin_tiled(rgb), "RGB").convert("RGBA")
        big.putalpha(alpha.resize(big.size, Image.LANCZOS))
        w, h = big.size
        if max(w, h) > target_long:
            s = target_long / max(w, h)
            big = big.resize((round(w * s), round(h * s)), Image.LANCZOS)
        big = big.filter(ImageFilter.UnsharpMask(radius=1.0, percent=55, threshold=2))
        buf = io.BytesIO()
        big.save(buf, "PNG", dpi=(300, 300))
        return buf.getvalue()
    except Exception:
        return upscale_png(raw, target_long)


# --------------------------------------------------------------------------- #
#  Gallery (lưu đĩa)
# --------------------------------------------------------------------------- #
def gallery_load():
    if os.path.isfile(GALLERY_INDEX):
        try:
            return json.load(open(GALLERY_INDEX, encoding="utf-8"))
        except Exception:
            return []
    return []


def gallery_save_index(items):
    os.makedirs(GALLERY_DIR, exist_ok=True)
    json.dump(items, open(GALLERY_INDEX, "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)


def gallery_add(b64, meta):
    os.makedirs(GALLERY_DIR, exist_ok=True)
    gid = "d%d" % int(time.time() * 1000)
    with open(os.path.join(GALLERY_DIR, gid + ".png"), "wb") as f:
        f.write(base64.b64decode(b64))
    items = gallery_load()
    item = {"id": gid, "ts": int(time.time()), "url": "/gallery/%s.png" % gid,
            "mode": meta.get("mode"), "prompt": meta.get("prompt", "")[:160]}
    items.insert(0, item)
    gallery_save_index(items)
    return item


# --------------------------------------------------------------------------- #
#  Tài khoản (đăng ký / đăng nhập) — SQLite + PBKDF2
# --------------------------------------------------------------------------- #
def auth_init():
    con = sqlite3.connect(AUTH_DB)
    con.execute("CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, "
                "email TEXT UNIQUE, ph TEXT, salt TEXT, is_admin INTEGER DEFAULT 0, ts INTEGER)")
    con.execute("CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, uid INTEGER, ts INTEGER)")
    con.commit()
    con.close()


def _hash_pw(pw, salt):
    return hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), bytes.fromhex(salt), 200000).hex()


def register_user(email, pw):
    email = (email or "").strip().lower()
    pw = pw or ""
    if "@" not in email or "." not in email:
        raise ValueError("Email không hợp lệ.")
    if len(pw) < 6:
        raise ValueError("Mật khẩu phải từ 6 ký tự trở lên.")
    salt = os.urandom(16).hex()
    ph = _hash_pw(pw, salt)
    with _auth_lock:
        con = sqlite3.connect(AUTH_DB)
        n = con.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        try:
            con.execute("INSERT INTO users(email, ph, salt, is_admin, ts) VALUES(?,?,?,?,?)",
                        (email, ph, salt, 1 if n == 0 else 0, int(time.time())))
            con.commit()
        except sqlite3.IntegrityError:
            con.close()
            raise ValueError("Email này đã được đăng ký.")
        uid = con.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()[0]
        con.close()
    return uid


def verify_user(email, pw):
    email = (email or "").strip().lower()
    con = sqlite3.connect(AUTH_DB)
    row = con.execute("SELECT id, ph, salt FROM users WHERE email=?", (email,)).fetchone()
    con.close()
    if not row:
        return None
    uid, ph, salt = row
    return uid if _hash_pw(pw or "", salt) == ph else None


def make_session(uid):
    token = os.urandom(24).hex()
    with _auth_lock:
        con = sqlite3.connect(AUTH_DB)
        con.execute("INSERT INTO sessions(token, uid, ts) VALUES(?,?,?)", (token, uid, int(time.time())))
        con.commit()
        con.close()
    return token


def session_user(token):
    if not token:
        return None
    con = sqlite3.connect(AUTH_DB)
    row = con.execute("SELECT u.id, u.email, u.is_admin FROM sessions s "
                      "JOIN users u ON u.id = s.uid WHERE s.token=?", (token,)).fetchone()
    con.close()
    if not row:
        return None
    return {"id": row[0], "email": row[1], "is_admin": bool(row[2])}


def delete_session(token):
    if not token:
        return
    with _auth_lock:
        con = sqlite3.connect(AUTH_DB)
        con.execute("DELETE FROM sessions WHERE token=?", (token,))
        con.commit()
        con.close()


# --------------------------------------------------------------------------- #
#  Mockup của người dùng (lưu đĩa)
# --------------------------------------------------------------------------- #
def mockup_labels():
    if os.path.isfile(MOCKUP_INDEX):
        try:
            return json.load(open(MOCKUP_INDEX, encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_mockup_labels(d):
    os.makedirs(MOCKUP_DIR, exist_ok=True)
    json.dump(d, open(MOCKUP_INDEX, "w", encoding="utf-8"), ensure_ascii=False, indent=2)


def derive_label(fname):
    if fname.startswith("tee_") and fname.endswith(".png"):
        key = fname[4:-4]
        return "Áo " + COLOR_VI.get(key, key)
    return os.path.splitext(fname)[0]


def list_mockups():
    if not os.path.isdir(MOCKUP_DIR):
        return []
    labels = mockup_labels()
    files = sorted(f for f in os.listdir(MOCKUP_DIR) if f.lower().endswith(".png"))
    # đưa mockup người dùng tải (u...) lên trước
    files.sort(key=lambda f: (not f.startswith("u"), f))
    out = []
    for f in files:
        out.append({"file": f, "url": "/mockups/%s" % f,
                    "name": labels.get(f) or derive_label(f),
                    "mine": not f.startswith("tee_")})
    return out


def save_user_mockup(raw, name, color):
    os.makedirs(MOCKUP_DIR, exist_ok=True)
    if HAS_PIL:  # chuẩn hoá về PNG (nhận cả JPG/WEBP)
        try:
            im = Image.open(io.BytesIO(raw)).convert("RGB")
            buf = io.BytesIO(); im.save(buf, "PNG"); raw = buf.getvalue()
        except Exception:
            pass
    if color and color in COLOR_HEX:
        fname = "tee_%s.png" % color
        label = name or ("Áo " + COLOR_VI.get(color, color))
    else:
        safe = re.sub(r"[^a-zA-Z0-9_-]", "_", (name or ""))[:30]
        fname = "u%d_%s.png" % (int(time.time() * 1000), safe or "ao")
        label = name or "Áo của tôi"
    with open(os.path.join(MOCKUP_DIR, fname), "wb") as f:
        f.write(raw)
    idx = mockup_labels(); idx[fname] = label; save_mockup_labels(idx)
    return {"file": fname, "url": "/mockups/%s" % fname, "name": label, "mine": not fname.startswith("tee_")}


# --------------------------------------------------------------------------- #
#  MOCK PNG
# --------------------------------------------------------------------------- #
def make_mock_png(w=512, h=640):
    import zlib
    def chunk(t, d):
        c = t + d
        return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        for x in range(w):
            checker = ((x // 32) + (y // 32)) % 2
            a = 0 if checker == 0 else 60
            r, g, b = int(120 + 100 * x / w), int(80 + 120 * y / h), 220
            dx, dy = x - w / 2, y - h / 2
            if dx * dx + dy * dy < (w * 0.32) ** 2:
                r, g, b, a = 124, 58, 237, 255
            if (w * 0.22) ** 2 < dx * dx + dy * dy < (w * 0.26) ** 2:
                r, g, b, a = 255, 255, 255, 255
            raw += bytes((r, g, b, a))
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw), 9)
    return base64.b64encode(sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")).decode()


# --------------------------------------------------------------------------- #
#  HTTP
# --------------------------------------------------------------------------- #
class Handler(BaseHTTPRequestHandler):
    server_version = "AIDesign2D/2.0"

    def log_message(self, fmt, *a):
        sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % a))

    # ---------- GET ----------
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/":
            path = "/index.html"

        if path == "/api/status":
            return self.json(200, {"ok": True, "mock": not bool(API_KEY),
                                   "model": MODEL, "pillow": HAS_PIL,
                                   "rembg": HAS_REMBG,
                                   "cutoutpro": bool(CUTOUTPRO_KEY),
                                   "ai_upscale": HAS_ONNX,
                                   "auth_required": AUTH_REQUIRED})
        if path == "/api/me":
            u = self.current_user()
            if not u:
                return self.json(401, {"error": "Chưa đăng nhập"})
            return self.json(200, {"user": u})
        if path == "/api/gallery":
            return self.json(200, {"items": gallery_load()})
        if path == "/api/mockups":
            return self.json(200, {"items": list_mockups()})

        # static: gallery, mockups, public
        if path.startswith("/gallery/"):
            base, sub = GALLERY_DIR, path[len("/gallery/"):]
        elif path.startswith("/mockups/"):
            base, sub = MOCKUP_DIR, path[len("/mockups/"):]
        else:
            base, sub = PUBLIC, path.lstrip("/")
        fp = os.path.normpath(os.path.join(base, sub))
        if not fp.startswith(base) or not os.path.isfile(fp):
            return self.json(404, {"error": "Not found"})
        ctype = mimetypes.guess_type(fp)[0] or "application/octet-stream"
        data = open(fp, "rb").read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    # ---------- DELETE ----------
    def do_DELETE(self):
        path = self.path.split("?", 1)[0]
        qs = self.path.split("?", 1)[1] if "?" in self.path else ""
        params = dict(p.split("=", 1) for p in qs.split("&") if "=" in p)
        if path == "/api/gallery":
            gid = params.get("id")
            items = [x for x in gallery_load() if x["id"] != gid]
            gallery_save_index(items)
            try:
                os.remove(os.path.join(GALLERY_DIR, "%s.png" % gid))
            except Exception:
                pass
            return self.json(200, {"ok": True})
        if path == "/api/mockups":
            fname = os.path.basename(params.get("file", ""))
            if fname:
                try:
                    os.remove(os.path.join(MOCKUP_DIR, fname))
                except Exception:
                    pass
                idx = mockup_labels(); idx.pop(fname, None); save_mockup_labels(idx)
            return self.json(200, {"ok": True})
        return self.json(404, {"error": "Not found"})

    # ---------- POST ----------
    def do_POST(self):
        path = self.path.split("?", 1)[0]
        try:
            n = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(n).decode("utf-8")) if n else {}
        except Exception as e:
            return self.json(400, {"error": "Body lỗi: %s" % e})

        # ---- Tài khoản ----
        COOKIE = "session=%s; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax"
        if path == "/api/register":
            try:
                uid = register_user(body.get("email"), body.get("password"))
            except ValueError as e:
                return self.json(400, {"error": str(e)})
            return self.json(200, {"ok": True}, set_cookie=COOKIE % make_session(uid))
        if path == "/api/login":
            uid = verify_user(body.get("email"), body.get("password"))
            if not uid:
                return self.json(401, {"error": "Sai email hoặc mật khẩu."})
            return self.json(200, {"ok": True}, set_cookie=COOKIE % make_session(uid))
        if path == "/api/logout":
            delete_session(self.get_cookie("session"))
            return self.json(200, {"ok": True}, set_cookie="session=; Path=/; Max-Age=0")

        # ---- Các endpoint AI: CẦN đăng nhập (chống đốt credit) ----
        if AUTH_REQUIRED and not self.current_user():
            return self.json(401, {"error": "Vui lòng đăng nhập để dùng tính năng này."})

        if path == "/api/generate":
            return self.handle_generate(body)
        if path == "/api/upscale":
            return self.handle_upscale(body)
        if path == "/api/make-mockup":
            return self.handle_mockup(body)
        if path == "/api/remove-bg":
            return self.handle_remove_bg(body)
        if path == "/api/upload-mockup":
            return self.handle_upload_mockup(body)
        if path == "/api/preview-prompt":
            if body.get("mode") == "extract":
                return self.json(200, {"prompt": "(Chế độ Giữ nguyên màu: KHÔNG dùng AI "
                                       "vẽ lại. Tool lấy thẳng vùng design bạn khoanh, "
                                       "tách nền bằng rembg và phóng to — màu sắc & chi "
                                       "tiết giữ 100% như ảnh gốc.)"})
            p = effective_prompt(body.get("mode", "cloner"),
                                 body.get("prompt", ""),
                                 bool(body.get("transparent", True)))
            return self.json(200, {"prompt": p})
        return self.json(404, {"error": "Not found"})

    def handle_upload_mockup(self, body):
        img = body.get("image", "")
        if not img:
            return self.json(400, {"error": "Thiếu ảnh."})
        if img.startswith("data:"):
            img = img.split(",", 1)[1]
        try:
            raw = base64.b64decode(img)
            item = save_user_mockup(raw, body.get("name", ""), body.get("color"))
        except Exception as e:
            return self.json(500, {"error": "Lưu mockup lỗi: %s" % e})
        return self.json(200, item)

    def handle_remove_bg(self, body):
        src = body.get("image") or (body.get("images") or [None])[0]
        if not src:
            return self.json(400, {"error": "Thiếu ảnh."})
        method = body.get("method", "flat")
        matting = bool(body.get("matting", True))
        data, _ = fetch_image_bytes(src)
        if not data:
            return self.json(400, {"error": "Không đọc được ảnh."})
        try:
            out = strip_background(data, method, matting)
        except Exception as e:
            return self.json(500, {"error": "Xoá nền lỗi: %s" % e})
        return self.json(200, {"image": base64.b64encode(out).decode(),
                               "method": method if (method != "ai" or HAS_REMBG) else "white"})

    # ---------- handlers ----------
    def handle_generate(self, body):
        sources = body.get("images") or []
        if isinstance(sources, str):
            sources = [s for s in sources.splitlines() if s.strip()]
        sources = [s for s in sources if s and s.strip()][:4]
        if not sources:
            return self.json(400, {"error": "Chưa có ảnh áo đầu vào."})
        mode = body.get("mode", "cloner")
        transparent = bool(body.get("transparent", True))
        size = SIZE_MAP.get(body.get("size", "portrait"), "1024x1536")
        user_prompt = body.get("prompt", "")

        # CHẾ ĐỘ GIỮ NGUYÊN MÀU: không gọi AI, chỉ tách nền ảnh gốc (đã khoanh vùng)
        if mode == "extract":
            data, _ = fetch_image_bytes(sources[0])
            if not data:
                return self.json(400, {"error": "Không đọc được ảnh."})
            try:
                out = remove_bg_ai(data) if HAS_REMBG else None
                if not out:
                    out = remove_flat_bg(data)
                if HAS_PIL:
                    out = upscale_png(out, 1400)  # phóng to vừa phải, giữ alpha
            except Exception as e:
                return self.json(500, {"error": "Tách nền lỗi: %s" % e})
            b64 = base64.b64encode(out).decode()
            item = gallery_add(b64, {"mode": "extract", "prompt": user_prompt})
            return self.json(200, {"image": b64, "mock": False, "gallery": item,
                                   "prompt": "(Giữ nguyên màu — tách nền ảnh gốc, KHÔNG qua AI)"})

        if not API_KEY:
            time.sleep(0.8)
            b64 = make_mock_png()
            item = gallery_add(b64, {"mode": mode, "prompt": user_prompt})
            used = (body.get("override_prompt") or "").strip() or effective_prompt(mode, user_prompt, transparent)
            return self.json(200, {"image": b64, "mock": True, "gallery": item,
                                   "prompt": used, "note": "MOCK (chưa có API key)."})

        images = []
        for s in sources:
            d, m = fetch_image_bytes(s)
            if d:
                images.append((d, m))
        if not images:
            return self.json(400, {"error": "Không tải được ảnh đầu vào."})
        override = body.get("override_prompt", "")
        try:
            b64, used_prompt = gen_design(images, mode, user_prompt, size, transparent, override)
        except urllib.error.HTTPError as e:
            try:
                detail = e.read().decode('utf-8', 'ignore')
            except Exception:
                detail = str(e)
            return self.json(502, {"error": "OpenAI %s: %s" % (e.code, detail[:500])})
        except Exception as e:
            return self.json(500, {"error": "Lỗi: %s" % e})
        item = gallery_add(b64, {"mode": mode, "prompt": user_prompt})
        return self.json(200, {"image": b64, "mock": False, "gallery": item,
                               "prompt": used_prompt})

    def handle_upscale(self, body):
        img = body.get("image", "")
        target = int(body.get("target", 4500))
        if not img:
            return self.json(400, {"error": "Thiếu ảnh."})
        if img.startswith("data:"):
            img = img.split(",", 1)[1]
        method = body.get("method", "lanczos")
        try:
            raw = base64.b64decode(img)
            big = ai_upscale_png(raw, target) if method == "ai" else upscale_png(raw, target)
        except Exception as e:
            return self.json(500, {"error": "Upscale lỗi: %s" % e})
        return self.json(200, {"image": base64.b64encode(big).decode(),
                               "pillow": HAS_PIL,
                               "note": "" if HAS_PIL else "Chưa có Pillow, trả nguyên bản."})

    def handle_mockup(self, body):
        color = body.get("color", "white")
        if color not in COLOR_HEX:
            color = "white"
        os.makedirs(MOCKUP_DIR, exist_ok=True)
        fp = os.path.join(MOCKUP_DIR, "tee_%s.png" % color)
        url = "/mockups/tee_%s.png" % color
        if os.path.isfile(fp):
            return self.json(200, {"url": url, "cached": True, "color": color})
        if not API_KEY:
            return self.json(400, {"error": "Cần API key để tạo mockup thật."})
        prompt = (
            "Photorealistic product photo of a blank %s (%s) cotton crew-neck "
            "t-shirt, front view, laid flat / ghost-mannequin style, centered on a "
            "clean light gray studio background, soft even studio lighting, realistic "
            "fabric texture and subtle natural folds, NO graphics, NO text, NO logo, "
            "high detail, e-commerce apparel mockup."
            % (COLOR_VI.get(color, color), color)
        )
        try:
            b64 = openai_generate(prompt, "1024x1024")
        except urllib.error.HTTPError as e:
            return self.json(502, {"error": "OpenAI %s: %s" % (e.code, e.read().decode('utf-8', 'ignore')[:500])})
        except Exception as e:
            return self.json(500, {"error": "Lỗi tạo mockup: %s" % e})
        with open(fp, "wb") as f:
            f.write(base64.b64decode(b64))
        return self.json(200, {"url": url, "cached": False, "color": color})

    # ---------- util ----------
    def json(self, code, obj, set_cookie=None):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        if set_cookie:
            self.send_header("Set-Cookie", set_cookie)
        self.end_headers()
        self.wfile.write(data)

    # ---- auth helpers ----
    def get_cookie(self, name):
        for part in (self.headers.get("Cookie", "") or "").split(";"):
            if "=" in part:
                k, v = part.strip().split("=", 1)
                if k == name:
                    return v
        return None

    def current_user(self):
        return session_user(self.get_cookie("session"))


def main():
    os.makedirs(PUBLIC, exist_ok=True)
    os.makedirs(GALLERY_DIR, exist_ok=True)
    os.makedirs(MOCKUP_DIR, exist_ok=True)
    os.makedirs(DATA_DIR, exist_ok=True)
    auth_init()
    print("=" * 60)
    print("  AI Design 2D v2  ->  http://localhost:%d" % PORT)
    print("  Model : %s" % MODEL)
    print("  Che do: %s" % ("THAT" if API_KEY else "MOCK (chua co key)"))
    print("  Pillow: %s" % ("co (upscale Lanczos)" if HAS_PIL else "KHONG"))
    print("  rembg : %s" % ("co (xoa nen AI U2Net)" if HAS_REMBG else "KHONG"))
    print("=" * 60)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()

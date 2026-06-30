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
import random
import re
import sqlite3
import struct
import sys
import threading
import time
import urllib.request
import urllib.error
import urllib.parse
import xml.etree.ElementTree as ET
import zipfile
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP_VERSION = "2026.06.30-ads-45-safeframe"   # bump mỗi lần đổi backend để check deploy
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
CHAT_URL = "https://api.openai.com/v1/chat/completions"

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
MODEL = os.environ.get("OPENAI_IMAGE_MODEL", "gpt-image-2").strip()
# Model "đọc ảnh + nghĩ ý tưởng" (vision) cho chế độ Auto. gpt-4o-mini có vision, rẻ.
TEXT_MODEL = os.environ.get("OPENAI_TEXT_MODEL", "gpt-4o-mini").strip()
# Model cao nhất cho việc sáng tạo (art director thiết kế tên) — mặc định gpt-4o
BEST_TEXT_MODEL = os.environ.get("OPENAI_BEST_MODEL", "gpt-4o").strip()
# Gemini "Nano Banana Pro" (ảnh chân thực hơn cho ảnh sản phẩm)
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GEMINI_IMAGE_MODEL = os.environ.get("GEMINI_IMAGE_MODEL", "gemini-3-pro-image-preview").strip()
# Claude API (Anthropic) — viết prompt ảnh sản phẩm chân thực, nhìn ảnh áo (vision).
# Đây là "Claude viết prompt" mà skill nano-banana dựa vào, gọi qua API key (KHÔNG phải agent).
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-opus-4-8").strip()
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
# Shopify Admin API (đẩy sản phẩm)
SHOPIFY_DOMAIN = os.environ.get("SHOPIFY_DOMAIN", "").strip()        # vd: xxx.myshopify.com
SHOPIFY_TOKEN = os.environ.get("SHOPIFY_TOKEN", "").strip()         # token cố định (tuỳ chọn)
SHOPIFY_CLIENT_ID = os.environ.get("SHOPIFY_CLIENT_ID", "").strip()       # dev-dashboard app -> client_credentials
SHOPIFY_CLIENT_SECRET = os.environ.get("SHOPIFY_CLIENT_SECRET", "").strip()
SHOPIFY_API_VER = os.environ.get("SHOPIFY_API_VER", "2024-10").strip()
# Facebook Marketing API (đẩy ad lên tài khoản QC) — user tự cấp, để PAUSED
FB_ACCESS_TOKEN = os.environ.get("FB_ACCESS_TOKEN", "").strip()
FB_AD_ACCOUNT_ID = os.environ.get("FB_AD_ACCOUNT_ID", "").strip().replace("act_", "")
FB_PAGE_ID = os.environ.get("FB_PAGE_ID", "").strip()
FB_API_VER = os.environ.get("FB_API_VER", "v21.0").strip()
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

# Bảng màu áo cho tính năng "Đổi màu theo áo": key -> (nhãn VN, hex áo, gợi ý phối màu)
RECOLOR = {
    "black":  ("đen", "#1c1c1e",
               "the shirt is BLACK. Keep the design FAITHFUL and KEEP every colour that is already "
               "light or bright (they show fine on black). ONLY the parts that are DARK — dark navy, "
               "black, very deep tones that would vanish on black — should be lifted to a LIGHTER "
               "version of the SAME hue (e.g. dark navy → light ice-blue/cream-blue) so they stay "
               "visible. Keep all accents, snow, stars and the design's overall character unchanged"),
    "white":  ("trắng", "#f5f5f5",
               "the shirt is WHITE. KEEP the main lettering colour EXACTLY as it is (e.g. dark navy "
               "lettering already pops on white — DO NOT change it). ONLY change elements that are "
               "WHITE or very pale (white outlines, white snow caps, pale fills) into a soft VISIBLE "
               "tone (light grey-blue, soft beige, light navy) so they do not disappear on white. "
               "Keep everything else identical to the original"),
    "brown":  ("nâu", "#6b4a2f",
               "the shirt is a medium-dark warm BROWN, so use cream, beige, off-white and "
               "warm pastel tones with light outlines; avoid dark brown that blends in"),
    "sand":   ("be", "#d8c3a5",
               "the shirt is a light warm BEIGE, so use deep warm tones (dark brown, maroon, "
               "forest, navy) with dark outlines; avoid pale or white elements"),
    "forest": ("xanh rêu", "#2f5d3a",
               "the shirt is a dark olive/forest GREEN, so use cream, off-white, mustard and "
               "warm light tones with light outlines; avoid dark green or black"),
    "red":    ("đỏ", "#b3261e",
               "the shirt is bright RED, so use white, cream, black and dark contrasting "
               "tones; avoid red, pink or orange that clash or blend with the red shirt"),
    "maroon": ("đỏ đô", "#5e1a1d",
               "the shirt is a dark MAROON/burgundy, so use light gold, cream, white and warm "
               "pastel tones with light outlines; avoid dark red or black"),
}


RECOLOR_EN = {"black": "black", "white": "white", "brown": "brown", "sand": "beige",
              "forest": "olive green", "red": "red", "maroon": "burgundy"}


def detect_bg_desc(raw):
    """Mô tả nền HIỆN TẠI của design (đọc 4 góc) -> 'transparent' / 'white' / 'black' / 'a ... '."""
    if not HAS_PIL:
        return "a plain"
    try:
        im = Image.open(io.BytesIO(raw)).convert("RGBA")
        w, h = im.size
        px = im.load()
        corners = [px[0, 0], px[w - 1, 0], px[0, h - 1], px[w - 1, h - 1]]
        if sum(c[3] for c in corners) / 4 < 30:
            return "transparent"
        avg = tuple(sum(c[i] for c in corners) // 4 for i in range(3))
        lum = 0.299 * avg[0] + 0.587 * avg[1] + 0.114 * avg[2]
        sat = max(avg) - min(avg)
        if sat < 28:
            if lum > 210:
                return "white"
            if lum < 50:
                return "black"
            return "a light grey" if lum > 128 else "a dark grey"
        return "a coloured (RGB %d,%d,%d)" % avg
    except Exception:
        return "a plain"


def recolor_instruction(key, bg="white"):
    """Prompt ĐƠN GIẢN: 'đây là design trên nền X, phối lại cho hợp áo nền Y'."""
    en = RECOLOR_EN.get(key, key)
    hexv = RECOLOR[key][1]
    return ("This is my t-shirt print design, currently shown on a %s background. Re-colour the "
            "DESIGN so it looks great and is clearly visible when printed on a %s (%s) shirt. "
            "Keep the design IDENTICAL — same text, fonts, layout, decorations and proportions — "
            "only adapt the COLOURS to suit a %s background (good contrast, nothing disappears). "
            "Output ONLY the artwork on a plain pure-white empty background (no shirt) so it cuts "
            "out cleanly." % (bg, en, hexv, en))


def recolor_plan(design_bytes, color_key):
    """AI (gpt-4o vision) NHÌN design + màu áo -> chỉ thị phối lại màu CỤ THỂ cho đẹp + tương phản tốt."""
    if not API_KEY or not design_bytes:
        return ""
    vi, hexv, _ = RECOLOR[color_key]
    sys = ("You are an expert APPAREL graphic colourist. Keep the design IDENTICAL and FAITHFUL and make "
           "the MINIMUM colour changes. KEEP every colour that already contrasts well with the shirt; "
           "ONLY recolour the elements whose brightness is too close to the shirt colour (they would "
           "vanish). Preserve the design's MAIN colour identity and character — do NOT flip or remap the "
           "whole palette. Think like a designer making the smallest tweak so the design reads cleanly.")
    is_dark = color_key in ("black", "forest", "maroon", "brown")
    note = ("This shirt is DARK: keep the light/bright parts as-is; ONLY lift the parts that are dark "
            "(dark navy/black/deep) to a lighter version of the SAME hue so they stay visible. Keep accents."
            if is_dark else
            "This shirt is LIGHT: keep the dark/coloured lettering EXACTLY as-is (it already pops); ONLY "
            "change WHITE or very pale elements (white outline, white snow, pale fills) to a soft visible "
            "tone so they don't disappear.")
    user = [
        {"type": "text", "text": (
            "Shirt colour: %s (hex %s). %s Analyse the design's colours element by element, then give ONE "
            "precise instruction (English) listing ONLY the elements that need a new colour and their new "
            "colour — and explicitly say to KEEP the rest unchanged. Keep it harmonious, premium, faithful. "
            "Reply strict JSON: {\"instruction\":\"...\"}." % (vi, hexv, note))},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(design_bytes).decode()}},
    ]
    try:
        out = openai_chat([{"role": "system", "content": sys}, {"role": "user", "content": user}],
                          json_mode=True, max_tokens=400, model=BEST_TEXT_MODEL)
        return (json.loads(out).get("instruction") or "").strip()[:600]
    except Exception:
        return ""


def preserve_alpha(orig_bytes, colored_b64):
    """Giữ NGUYÊN vùng trong suốt của ảnh GỐC cho ảnh đã đổi màu.
    Recolor giữ bố cục y hệt -> áp lại đúng kênh alpha gốc => chỉ đổi MÀU bên trong,
    KHÔNG thêm nền (nền gốc trong suốt thì kết quả cũng trong suốt)."""
    if not HAS_PIL:
        return colored_b64
    try:
        orig = Image.open(io.BytesIO(orig_bytes)).convert("RGBA")
        a = orig.split()[3]
        # Ảnh gốc gần như đặc (không có nền trong suốt) -> không có gì để giữ
        if a.getextrema()[0] >= 250:
            return colored_b64
        col = Image.open(io.BytesIO(base64.b64decode(colored_b64))).convert("RGBA")
        if col.size != orig.size:
            col = col.resize(orig.size, Image.LANCZOS)
        col.putalpha(a)   # ép đúng silhouette gốc -> nền trong suốt như gốc
        out = io.BytesIO()
        col.save(out, "PNG")
        return base64.b64encode(out.getvalue()).decode()
    except Exception:
        return colored_b64


def flatten_on_color(b64_png, hexv):
    """Ghép PNG (đã tách nền) lên NỀN ĐẶC màu hex -> PNG mờ đục (xem như trên áo)."""
    if not HAS_PIL:
        return b64_png
    try:
        im = Image.open(io.BytesIO(base64.b64decode(b64_png))).convert("RGBA")
        rgb = (int(hexv[1:3], 16), int(hexv[3:5], 16), int(hexv[5:7], 16), 255)
        bg = Image.new("RGBA", im.size, rgb)
        bg.alpha_composite(im)
        out = io.BytesIO()
        bg.convert("RGB").save(out, "PNG")
        return base64.b64encode(out.getvalue()).decode()
    except Exception:
        return b64_png


# Màu áo -> file mockup tương ứng (ghép design lên áo thật)
MOCKUP_BY_COLOR = {
    "white": "ao_1_trang.png", "black": "ao_2_den.png", "sand": "ao_3_be.png",
    "brown": "ao_4_nau.png", "red": "ao_5_do.png", "maroon": "ao_6_dodo.png",
    "forest": "ao_7_xanhreu.png",
}


def compose_on_mockup(design_b64, color, x_pct=50.0, y_pct=43.0, w_pct=40.0):
    """Ghép design (đã tách nền) LÊN ÁO mockup theo màu — khớp cách tab Lên áo compose."""
    if not HAS_PIL:
        return design_b64
    fn = MOCKUP_BY_COLOR.get(color)
    path = os.path.join(MOCKUP_DIR, fn) if fn else ""
    if not fn or not os.path.isfile(path):
        return design_b64
    try:
        shirt = Image.open(path).convert("RGBA")
        des = Image.open(io.BytesIO(base64.b64decode(design_b64))).convert("RGBA")
        sw, sh = shirt.size
        dw = max(1, int(sw * w_pct / 100.0))
        dh = max(1, int(des.height * (dw / des.width)))
        des = des.resize((dw, dh), Image.LANCZOS)
        dx = int(sw * x_pct / 100.0 - dw / 2)
        dy = int(sh * y_pct / 100.0 - dh / 2)
        shirt.paste(des, (dx, dy), des)        # dùng alpha làm mask
        out = io.BytesIO()
        shirt.save(out, "PNG")
        return base64.b64encode(out.getvalue()).decode()
    except Exception:
        return design_b64


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


def _openai_call(req, timeout=300, tries=3):
    """Gọi OpenAI, TỰ THỬ LẠI khi gặp lỗi tạm (5xx như 520/502/503, 429, mất mạng)."""
    last = None
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code >= 500 or e.code == 429:   # lỗi tạm phía OpenAI -> thử lại
                last = e
                time.sleep(2 * (attempt + 1))
                continue
            raise                                 # lỗi 4xx khác (sai key/ảnh) -> báo ngay
        except (urllib.error.URLError, TimeoutError) as e:
            last = e
            time.sleep(2 * (attempt + 1))
            continue
    raise last


def gemini_edit(images, prompt, aspect="", model=""):
    """Nano Banana (Gemini): ảnh-ref + prompt -> ảnh mới (base64). images=[(bytes,mime)]."""
    if not GEMINI_API_KEY:
        raise RuntimeError("Chưa cấu hình GEMINI_API_KEY")
    parts = [{"text": prompt}]
    for d, m in images:
        parts.append({"inline_data": {"mime_type": m or "image/png",
                                      "data": base64.b64encode(d).decode()}})
    gen = {"responseModalities": ["IMAGE"]}
    if aspect:
        gen["imageConfig"] = {"aspectRatio": aspect}   # vd "4:5", "1:1"
    payload = {"contents": [{"role": "user", "parts": parts}], "generationConfig": gen}
    url = ("https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent"
           % (model or GEMINI_IMAGE_MODEL))
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("x-goog-api-key", GEMINI_API_KEY)
    res = json.loads(_openai_call(req, timeout=300))
    for cand in res.get("candidates", []):
        for p in (cand.get("content") or {}).get("parts", []):
            inl = p.get("inline_data") or p.get("inlineData")
            if inl and inl.get("data"):
                return inl["data"]
    raise RuntimeError("Gemini không trả ảnh (%s)" % json.dumps(res)[:200])


# size "WxH" -> tỉ lệ Gemini gần nhất
def _aspect_for(size):
    try:
        w, h = (size or "").lower().split("x")
        w, h = int(w), int(h)
    except Exception:
        return "1:1"
    if h > w * 1.15:
        return "4:5"
    if w > h * 1.15:
        return "3:2"
    return "1:1"


# Các model gen ảnh cho user chọn. id -> {label, kind, model}
IMAGE_ENGINES = [
    {"id": "openai",       "label": "OpenAI gpt-image",                 "kind": "openai", "model": ""},
    {"id": "gemini_pro",   "label": "Nano Banana Pro (Gemini 3)",       "kind": "gemini", "model": "gemini-3-pro-image-preview"},
    {"id": "gemini_flash", "label": "Nano Banana (Gemini 2.5 Flash)",   "kind": "gemini", "model": "gemini-2.5-flash-image"},
]


def engine_info(engine_id):
    for e in IMAGE_ENGINES:
        if e["id"] == engine_id:
            return e
    return IMAGE_ENGINES[0]


def engine_model_label(engine_id):
    """Tên model gen ảnh THỰC TẾ đã dùng (để ghi lên ad)."""
    info = engine_info(engine_id)
    if info["kind"] == "openai":
        return MODEL                       # vd gpt-image-2
    if engine_id == "gemini_pro":
        return GEMINI_IMAGE_MODEL or info["model"]
    return info["model"]


def engines_status():
    """Danh sách model gen ảnh + tình trạng khả dụng (cho dropdown frontend)."""
    out = []
    for e in IMAGE_ENGINES:
        avail = bool(API_KEY) if e["kind"] == "openai" else bool(GEMINI_API_KEY)
        m = e["model"]
        if e["id"] == "gemini_pro":
            m = GEMINI_IMAGE_MODEL or e["model"]   # cho phép override qua env
        out.append({"id": e["id"], "label": e["label"], "kind": e["kind"],
                    "model": m, "available": avail})
    return out


def resolve_engine_id(body):
    """Lấy model gen ảnh từ body (field 'engine'), tương thích payload cũ ('nano'),
    fallback nếu thiếu key, mặc định model tốt nhất đang có."""
    eid = (body.get("engine") or "").strip()
    if not eid and body.get("nano"):           # payload cũ: nano=true
        eid = "gemini_pro"
    if eid:
        info = engine_info(eid)
        if info["kind"] == "gemini" and not GEMINI_API_KEY:
            return "openai" if API_KEY else eid
        if info["kind"] == "openai" and not API_KEY and GEMINI_API_KEY:
            return "gemini_pro"
        return eid
    return "gemini_pro" if GEMINI_API_KEY else "openai"   # mặc định


# Khoá design: ép model giữ NGUYÊN design từ ảnh ref (chống vẽ lại khác mẫu gốc)
_DESIGN_LOCK = (
    "CRITICAL — PRESERVE THE DESIGN EXACTLY: the printed graphic, illustration, text, letters, "
    "wording, spelling, fonts, colors and logo on the shirt MUST be copied PIXEL-FOR-PIXEL and "
    "IDENTICAL to the attached reference product image. Treat the design as a fixed locked sticker: "
    "do NOT redraw, re-interpret, restyle, regenerate, translate, paraphrase, add, remove, recolor, "
    "resize, move or re-center any part of it — same artwork, same text, same colors, same size and "
    "same position as the reference. Keep it a LARGE full-front chest print exactly as big as in the "
    "reference; do NOT shrink it into a small left-chest pocket logo. Only the surrounding scene, "
    "shirt fabric, people and background may change. "
)


def gen_shot(images, prompt, size, engine="openai", aspect="", gem_model="", lock=True, quality=""):
    """Sinh 1 ảnh sản phẩm theo MODEL được chọn (engine). Gemini nếu là kind gemini & có key.
    lock=True: chèn KHOÁ DESIGN 1-ảnh giữ đúng mẫu gốc (tắt khi prompt nhiều-design tự khoá).
    quality: low/medium/high cho gpt-image (nhanh<->đẹp); rỗng = mặc định model."""
    if lock:
        prompt = _DESIGN_LOCK + (prompt or "")
    info = engine_info(engine)
    if info["kind"] == "gemini" and GEMINI_API_KEY:
        mdl = gem_model or (GEMINI_IMAGE_MODEL if engine == "gemini_pro" else info["model"])
        return gemini_edit(images, prompt, aspect or _aspect_for(size), mdl)
    return openai_edit(images, prompt, size, native_transparent=False, quality=quality)


# tỉ lệ chọn -> (size gpt-image gần nhất, aspect Gemini)
ASPECT_TO_SIZE = {
    "1:1": "1024x1024", "4:5": "1024x1536", "2:3": "1024x1536", "3:4": "1024x1536",
    "9:16": "1024x1536", "3:2": "1536x1024", "4:3": "1536x1024", "16:9": "1536x1024",
}
# tỉ lệ rộng/cao mong muốn (gpt-image chỉ ra 3 size -> tự cắt giữa về đúng tỉ lệ)
ASPECT_RATIO = {
    "1:1": 1.0, "4:5": 0.8, "2:3": 2.0 / 3, "3:4": 0.75, "9:16": 9.0 / 16,
    "16:9": 16.0 / 9, "3:2": 1.5, "4:3": 4.0 / 3,
}


def crop_to_aspect(raw, aspect):
    """Cắt GIỮA ảnh về ĐÚNG tỉ lệ aspect đã chọn (vì model chỉ ra vài size cố định)."""
    r = ASPECT_RATIO.get(aspect)
    if not r or not HAS_PIL:
        return raw
    try:
        im = Image.open(io.BytesIO(raw)).convert("RGB")
        w, h = im.size
        if abs((w / float(h)) - r) < 0.012:
            return raw
        if (w / float(h)) > r:            # quá rộng -> cắt bớt chiều ngang
            nw = int(round(h * r)); x = (w - nw) // 2
            im = im.crop((x, 0, x + nw, h))
        else:                             # quá cao -> cắt bớt chiều dọc
            nh = int(round(w / r)); y = (h - nh) // 2
            im = im.crop((0, y, w, y + nh))
        buf = io.BytesIO(); im.save(buf, "PNG")
        return buf.getvalue()
    except Exception:
        return raw


def strip_ai_meta(raw):
    """Tạo lại file ảnh sạch (bỏ metadata C2PA/EXIF/XMP mà gpt-image nhúng) — giống xuất qua Canva.
    Giúp Facebook/IG không gắn nhãn 'Made with AI'. Giữ nguyên pixel + alpha."""
    if not HAS_PIL:
        return raw
    try:
        im = Image.open(io.BytesIO(raw))
        # vẽ lại sang ảnh MỚI tinh -> không kế thừa bất kỳ metadata/info nào của file gốc
        clean = Image.new(im.mode, im.size)
        clean.putdata(list(im.getdata()))
        buf = io.BytesIO()
        clean.save(buf, "PNG")   # PNG mới, không truyền exif/pnginfo -> sạch metadata
        return buf.getvalue()
    except Exception:
        return raw


def strip_ai_meta_b64(b64):
    try:
        return base64.b64encode(strip_ai_meta(base64.b64decode(b64))).decode()
    except Exception:
        return b64


def openai_edit(images, prompt, size, native_transparent, quality=""):
    fields = [("model", MODEL), ("prompt", prompt), ("n", "1"),
              ("moderation", "low")]   # hạ độ gắt bộ lọc -> đỡ chặn nhầm
    if quality and quality in ("low", "medium", "high"):
        fields.append(("quality", quality))
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
    return json.loads(_openai_call(req, timeout=300))["data"][0]["b64_json"]


def openai_generate(prompt, size="1024x1024"):
    payload = {"model": MODEL, "prompt": prompt, "n": 1, "size": size,
               "moderation": "low"}
    req = urllib.request.Request(GEN_URL, data=json.dumps(payload).encode(),
                                 method="POST")
    req.add_header("Authorization", "Bearer " + API_KEY)
    req.add_header("Content-Type", "application/json")
    return json.loads(_openai_call(req, timeout=300))["data"][0]["b64_json"]


def openai_chat(messages, json_mode=True, max_tokens=1500, model=None):
    """Gọi AI text/vision (chat completions). Trả về nội dung text của câu trả lời."""
    payload = {"model": (model or TEXT_MODEL), "messages": messages, "max_tokens": max_tokens}
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    req = urllib.request.Request(CHAT_URL, data=json.dumps(payload).encode(),
                                 method="POST")
    req.add_header("Authorization", "Bearer " + API_KEY)
    req.add_header("Content-Type", "application/json")
    res = json.loads(_openai_call(req, timeout=120))
    return res["choices"][0]["message"]["content"]


def claude_vision(system, text, img_bytes, media="image/png", max_tokens=700):
    """Gọi Claude API (Anthropic Messages) có vision: nhìn 1 ảnh + chỉ dẫn -> trả text.

    Dùng cho việc 'Claude viết prompt ảnh sản phẩm'. Gọi qua API key, không phải agent.
    """
    if not ANTHROPIC_API_KEY:
        raise RuntimeError("Chưa cấu hình ANTHROPIC_API_KEY")
    b64 = base64.b64encode(img_bytes).decode()
    payload = {
        "model": ANTHROPIC_MODEL,
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": text},
                {"type": "image", "source": {"type": "base64",
                                             "media_type": media, "data": b64}},
            ],
        }],
    }
    req = urllib.request.Request(ANTHROPIC_URL, data=json.dumps(payload).encode(),
                                 method="POST")
    req.add_header("x-api-key", ANTHROPIC_API_KEY)
    req.add_header("anthropic-version", "2023-06-01")
    req.add_header("Content-Type", "application/json")
    res = json.loads(_openai_call(req, timeout=120))
    # Trả về text của các block type=="text"; bỏ qua thinking/khác.
    parts = [b.get("text", "") for b in (res.get("content") or []) if b.get("type") == "text"]
    return "\n".join(p for p in parts if p).strip()


def claude_text(system, user, max_tokens=2500):
    """Gọi Claude API text-only (không ảnh) -> trả text. Lỗi nếu chưa có key."""
    if not ANTHROPIC_API_KEY:
        raise RuntimeError("Chưa cấu hình ANTHROPIC_API_KEY")
    payload = {"model": ANTHROPIC_MODEL, "max_tokens": max_tokens, "system": system,
               "messages": [{"role": "user", "content": user}]}
    req = urllib.request.Request(ANTHROPIC_URL, data=json.dumps(payload).encode(),
                                 method="POST")
    req.add_header("x-api-key", ANTHROPIC_API_KEY)
    req.add_header("anthropic-version", "2023-06-01")
    req.add_header("Content-Type", "application/json")
    res = json.loads(_openai_call(req, timeout=120))
    parts = [b.get("text", "") for b in (res.get("content") or []) if b.get("type") == "text"]
    return "\n".join(p for p in parts if p).strip()


def ai_json(system, user, max_tokens=2500):
    """Gọi AI để lấy JSON: ưu tiên Claude (nếu có key) -> fallback OpenAI chat json_mode."""
    if ANTHROPIC_API_KEY:
        try:
            return claude_text(system, user + " Chỉ trả JSON thuần.", max_tokens)
        except Exception:
            pass
    return openai_chat([{"role": "system", "content": system},
                        {"role": "user", "content": user}], json_mode=True, max_tokens=max_tokens)


# --------------------------------------------------------------------------- #
#  Shopify Admin API
# --------------------------------------------------------------------------- #
_shopify_tok = {"token": "", "exp": 0}


def shopify_configured():
    return bool(SHOPIFY_DOMAIN and (SHOPIFY_TOKEN or (SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET)))


def shopify_token():
    """Trả access token. Ưu tiên token cố định; nếu không, xin bằng client_credentials (cache 24h)."""
    if SHOPIFY_TOKEN:
        return SHOPIFY_TOKEN
    if _shopify_tok["token"] and _shopify_tok["exp"] - 60 > time.time():
        return _shopify_tok["token"]
    data = urllib.parse.urlencode({
        "grant_type": "client_credentials",
        "client_id": SHOPIFY_CLIENT_ID,
        "client_secret": SHOPIFY_CLIENT_SECRET,
    }).encode()
    req = urllib.request.Request("https://%s/admin/oauth/access_token" % SHOPIFY_DOMAIN,
                                 data=data, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    res = json.loads(urllib.request.urlopen(req, timeout=30).read())
    _shopify_tok["token"] = res["access_token"]
    _shopify_tok["exp"] = time.time() + int(res.get("expires_in", 86399))
    return _shopify_tok["token"]


def shopify_api(method, path, body=None):
    """Gọi REST Admin API. path vd 'products.json'. Trả (status, json|text)."""
    url = "https://%s/admin/api/%s/%s" % (SHOPIFY_DOMAIN, SHOPIFY_API_VER, path)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("X-Shopify-Access-Token", shopify_token())
    req.add_header("Content-Type", "application/json")
    try:
        r = urllib.request.urlopen(req, timeout=60)
        raw = r.read().decode("utf-8", "ignore")
        return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "ignore")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"errors": raw}


def shopify_collection_id(title):
    """Tìm custom collection theo tên, không có thì tạo. Trả id (int) hoặc None."""
    if not title:
        return None
    st, d = shopify_api("GET", "custom_collections.json?title=%s" % urllib.parse.quote(title))
    cols = (d or {}).get("custom_collections") or []
    if cols:
        return cols[0]["id"]
    st, d = shopify_api("POST", "custom_collections.json", {"custom_collection": {"title": title}})
    return ((d or {}).get("custom_collection") or {}).get("id")


def shop_admin_url(pid):
    """URL trang sản phẩm trên admin Shopify mới: admin.shopify.com/store/<handle>/products/<id>."""
    handle = SHOPIFY_DOMAIN.replace(".myshopify.com", "")
    return "https://admin.shopify.com/store/%s/products/%s" % (handle, pid)


def shopify_graphql(query, variables=None):
    url = "https://%s/admin/api/%s/graphql.json" % (SHOPIFY_DOMAIN, SHOPIFY_API_VER)
    data = json.dumps({"query": query, "variables": variables or {}}).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("X-Shopify-Access-Token", shopify_token())
    req.add_header("Content-Type", "application/json")
    r = urllib.request.urlopen(req, timeout=60)
    return json.loads(r.read().decode("utf-8", "ignore"))


_SHOP_PUBS = [None]   # cache danh sách kênh bán (publications)


def shopify_publications():
    if _SHOP_PUBS[0] is not None:
        return _SHOP_PUBS[0]
    try:
        res = shopify_graphql("{ publications(first: 25){ nodes{ id name } } }")
        pubs = [n["id"] for n in (((res.get("data") or {}).get("publications") or {}).get("nodes") or [])]
    except Exception:
        pubs = []
    _SHOP_PUBS[0] = pubs
    return pubs


def shopify_publish_all(product_gid):
    """Bật SP lên TẤT CẢ kênh bán (Online Store, Facebook&Instagram, TikTok, Google…)."""
    pubs = shopify_publications()
    if not pubs or not product_gid:
        return
    q = ("mutation($id:ID!,$in:[PublicationInput!]!){ publishablePublish(id:$id, input:$in){ "
         "userErrors{ message } } }")
    try:
        shopify_graphql(q, {"id": product_gid, "in": [{"publicationId": p} for p in pubs]})
    except Exception:
        pass


# --------------------------------------------------------------------------- #
#  Facebook Marketing API — đẩy ad lên tài khoản QC (tạo chiến dịch PAUSED)
# --------------------------------------------------------------------------- #
def fb_configured():
    return bool(FB_ACCESS_TOKEN and FB_AD_ACCOUNT_ID and FB_PAGE_ID)


def fb_graph(method, path, params, token=None):
    """Gọi Graph/Marketing API (x-www-form-urlencoded). Trả (status, json)."""
    url = "https://graph.facebook.com/%s/%s" % (FB_API_VER, path)
    p = dict(params or {})
    p["access_token"] = token or FB_ACCESS_TOKEN
    data = urllib.parse.urlencode(p).encode()
    if method in ("GET", "DELETE"):
        req = urllib.request.Request(url + "?" + data.decode(), method=method)
    else:
        req = urllib.request.Request(url, data=data, method=method)
    try:
        r = urllib.request.urlopen(req, timeout=60)
        return r.status, json.loads(r.read().decode("utf-8", "ignore") or "{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "ignore")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"error": {"message": raw[:300]}}


def fb_err(d):
    return ((d or {}).get("error") or {}).get("message") or json.dumps(d)[:200]


def fb_upload_adimage(img_bytes):
    """Upload ảnh lên ad account -> trả image_hash."""
    b64 = base64.b64encode(img_bytes).decode()
    st, d = fb_graph("POST", "act_%s/adimages" % FB_AD_ACCOUNT_ID, {"bytes": b64})
    if st != 200:
        raise RuntimeError("upload ảnh lỗi: " + fb_err(d))
    imgs = d.get("images") or {}
    first = next(iter(imgs.values()), {})
    h = first.get("hash")
    if not h:
        raise RuntimeError("không lấy được image_hash: " + json.dumps(d)[:160])
    return h


# ===== Khuôn sản phẩm áo thun (copy từ SP mẫu 'test 1' trên RIENG.VN) =====
SHOP_CATEGORY = "gid://shopify/TaxonomyCategory/aa-1-13-8"   # Apparel > Clothing Tops > T-Shirts
SHOP_COLOR_META = {   # tên màu chuẩn -> metaobject swatch (shopify.color-pattern)
    "Màu đen": "gid://shopify/Metaobject/150711369776",
    "Màu trắng": "gid://shopify/Metaobject/150711205936",
    "Màu xanh rêu": "gid://shopify/Metaobject/150711500848",
    "Màu be": "gid://shopify/Metaobject/150711599152",
    "Màu đỏ": "gid://shopify/Metaobject/150711435312",
    "Đỏ đô": "gid://shopify/Metaobject/150607102000",
    "Màu nâu": "gid://shopify/Metaobject/150711631920",
}
SHOP_SIZE_META = {
    "S": "gid://shopify/Metaobject/150607200304", "M": "gid://shopify/Metaobject/150607265840",
    "L": "gid://shopify/Metaobject/150607298608", "XL": "gid://shopify/Metaobject/150607364144",
    "XXL": "gid://shopify/Metaobject/150607429680",
}
# tên màu từ tool (Lên áo) -> tên màu chuẩn
SHOP_COLOR_NORM = {
    "đen": "Màu đen", "trắng": "Màu trắng", "trang": "Màu trắng",
    "xanh rêu": "Màu xanh rêu", "xanh reu": "Màu xanh rêu",
    "be": "Màu be", "đỏ": "Màu đỏ", "do": "Màu đỏ",
    "đỏ đô": "Đỏ đô", "do do": "Đỏ đô", "nâu": "Màu nâu", "nau": "Màu nâu",
}
SHOP_FIXED_METAFIELDS = [
    {"namespace": "shopify", "key": "sleeve-length-type", "type": "list.metaobject_reference",
     "value": '["gid://shopify/Metaobject/167585382448"]'},                 # Ngắn
    {"namespace": "shopify", "key": "age-group", "type": "list.metaobject_reference",
     "value": '["gid://shopify/Metaobject/167585316912"]'},                 # Người lớn
    {"namespace": "shopify", "key": "neckline", "type": "list.metaobject_reference",
     "value": '["gid://shopify/Metaobject/167585284144"]'},                 # Tròn cao
    {"namespace": "shopify", "key": "target-gender", "type": "list.metaobject_reference",
     "value": '["gid://shopify/Metaobject/167585349680"]'},                 # Cả nam lẫn nữ
    {"namespace": "shopify", "key": "top-length-type", "type": "list.metaobject_reference",
     "value": '["gid://shopify/Metaobject/167585251376","gid://shopify/Metaobject/167585415216"]'},  # Vừa, Dài
    {"namespace": "mm-google-shopping", "key": "google_product_category", "type": "string", "value": "212"},
    {"namespace": "mc-facebook", "key": "google_product_category", "type": "string", "value": "212"},
]


def shop_norm_color(c):
    c = (c or "").strip()
    return SHOP_COLOR_NORM.get(c.lower(), c)


# Mô tả mặc định (size + thông tin + bảo quản) — tự thêm vào mọi sản phẩm
SHOP_DEFAULT_DESC_HTML = (
    "<p>Các bạn vui lòng tham khảo kỹ thông số về size áo theo bảng trên.</p>"
    "<p><strong>THÔNG TIN SẢN PHẨM:</strong></p>"
    "<ul>"
    "<li>Màu nhuộm được xử lý nhiệt và giặt công nghiệp nên có độ bền màu cao</li>"
    "<li>Form áo rộng, phù hợp với nhiều phong cách và dáng người khác nhau</li>"
    "<li>Được kiểm hàng và chấp nhận đổi trả nếu sản phẩm có sai sót về chất lượng</li>"
    "</ul>"
    "<p><strong>HƯỚNG DẪN BẢO QUẢN:</strong></p>"
    "<ul>"
    "<li>Nên giặt áo bằng tay và bằng nước lạnh để tránh bị sờn, dãn áo</li>"
    "<li>Lộn trái áo trước khi giặt để hình in bền màu lâu hơn</li>"
    "<li>Hạn chế ngâm áo lâu trong nước hoặc dùng chất tẩy mạnh, đặc biệt đối với áo có màu</li>"
    "<li>Phơi nắng hoặc ủi áo dưới nhiệt độ vừa phải giúp hạn chế tình trạng sờn vải, giữ màu áo luôn như mới</li>"
    "</ul>"
)


_shop_size_chart_b64 = [None]   # cache base64 ảnh bảng size mặc định


def shop_default_size_chart():
    """Ảnh bảng size mặc định (base64) trong public/size-chart-default.png."""
    if _shop_size_chart_b64[0] is None:
        p = os.path.join(ROOT, "public", "size-chart-default.png")
        try:
            with open(p, "rb") as f:
                _shop_size_chart_b64[0] = base64.b64encode(f.read()).decode()
        except Exception:
            _shop_size_chart_b64[0] = ""
    return _shop_size_chart_b64[0]


def shop_text_to_html(t):
    """Chuỗi mô tả thường -> HTML (giữ xuống dòng). Nếu đã là HTML thì giữ nguyên."""
    t = (t or "").strip()
    if not t:
        return ""
    if "<" in t and ">" in t:
        return t
    paras = [p.strip() for p in t.split("\n\n") if p.strip()]
    return "".join("<p>%s</p>" % p.replace("\n", "<br>") for p in paras)


SHOP_LISTING_SYSTEM = (
    "Bạn là chuyên gia bán áo thun online ở Việt Nam. Nhìn ảnh sản phẩm áo, viết nội dung đăng bán "
    "HẤP DẪN & CHUẨN SEO cho shop Việt: mô tả HTML 2–4 câu (chất liệu cotton, form rộng unisex, in "
    "sắc nét, dịp tặng/mặc), 4–8 tag tiếng Việt, và \"style\" = TÊN PHONG CÁCH áo NGẮN GỌN 1–3 từ "
    "(vd: Vintage, Typography, Streetwear, Couple, Y2K, Thư Pháp, Cute, Local Brand...) — KHÔNG đặt "
    "tên người, KHÔNG dùng tên riêng cá nhân. "
    "Trả JSON {\"style\":\"...\",\"body_html\":\"<p>...</p>\",\"tags\":[\"...\"]}"
)

# Mã số SP (MS) tăng dần, seed theo thời gian -> duy nhất trong phiên
_ms_seq = [int(time.time()) % 100000]


def next_ms():
    _ms_seq[0] = (_ms_seq[0] + 1) % 100000
    return "MS%05d" % _ms_seq[0]


def shopify_listing(image_b64):
    """AI nhìn ảnh -> {style, body_html, tags}. Lỗi -> {}."""
    content = [{"type": "text", "text": "Viết nội dung đăng bán cho áo này. Chỉ trả JSON."},
               {"type": "image_url", "image_url": {"url": "data:image/png;base64," + image_b64}}]
    try:
        raw = openai_chat([{"role": "system", "content": SHOP_LISTING_SYSTEM},
                           {"role": "user", "content": content}], json_mode=True, max_tokens=600)
        d = json.loads(raw)
        return {"style": (d.get("style") or "").strip(),
                "title": (d.get("title") or "").strip(),
                "body_html": (d.get("body_html") or "").strip(),
                "tags": d.get("tags") or []}
    except Exception:
        return {}


AUTO_SYSTEM = (
    "Bạn là chuyên gia thiết kế áo thun cá nhân hoá (print-on-demand) cho thị trường "
    "Việt Nam. Bạn được đưa (các) MẪU thiết kế. Mục tiêu: tạo các bản CÁ NHÂN HOÁ — "
    "GIỮ NGUYÊN STYLE mẫu gốc (cùng hình minh hoạ/illustration, kiểu font, bảng màu, bố "
    "cục tổng thể) và CHÈN/THAY phần chữ bằng TÊN và NGÀY/THÁNG/NĂM khách yêu cầu. "
    "TUYỆT ĐỐI KHÔNG vẽ lại hình mới, KHÔNG đổi phong cách, KHÔNG đổi màu chủ đạo.\n"
    "Cách làm: đọc text đang có trong ảnh, xác định chỗ đặt TÊN (tiêu đề/điểm nhấn) và "
    "chỗ đặt NGÀY THÁNG NĂM (dòng phụ/banner/cung tròn). Điền GIÁ TRỊ THẬT khách cung cấp "
    "vào đúng chỗ, GIỮ NGUYÊN DẤU tiếng Việt, viết hoa/typography theo đúng style mẫu, "
    "chỉnh cỡ & khoảng cách cho cân đối. Nếu khách đưa NHIỀU tên → mỗi tên là 1 concept "
    "riêng. Nếu thiếu thông tin gì thì suy luận hợp lý từ mẫu.\n"
    "Trả về JSON đúng dạng: {\"concepts\":[{\"title\":\"tên ngắn tiếng Việt\","
    "\"change_instruction\":\"câu lệnh TIẾNG ANH\",\"src_index\":0}]}.\n"
    "change_instruction phải: nêu RÕ thay text cũ nào thành text mới gì (TÊN, NGÀY THÁNG "
    "NĂM cụ thể), nhấn mạnh GIỮ NGUYÊN illustration/font style/colors/composition của bản "
    "gốc, canh chỉnh cho vừa. Ví dụ: \"Keep the bear illustration, fonts, colors and layout "
    "exactly as in the original; replace the name text with 'Bé An' and the date line with "
    "'20.11.2024', keep Vietnamese diacritics, match the original font and re-center/resize "
    "so they fit nicely.\" src_index = chỉ số (0-based) của ảnh mẫu mà concept này dựa vào."
)


def auto_concepts(image_b64_list, niche, n=3):
    """AI nhìn mẫu -> đề xuất n concept GIỮ STYLE, chỉ đổi text.
    Trả list[{title, change_instruction, src_index}]."""
    n = max(1, min(int(n or 3), 8))
    nref = len(image_b64_list or [])
    niche = (niche or "").strip() or "tự chọn tên & ngày tháng năm mẫu phù hợp"
    content = [{
        "type": "text",
        "text": ("THÔNG TIN CÁ NHÂN HOÁ (tên / ngày tháng năm khách cần): %s.\n"
                 "Có %d ảnh mẫu (src_index 0..%d). Hãy tạo đúng %d concept GIỮ NGUYÊN STYLE "
                 "mẫu gốc, chỉ điền/đổi TÊN và NGÀY THÁNG NĂM theo thông tin trên. "
                 "Chỉ trả JSON theo schema." % (niche, nref, max(0, nref - 1), n)),
    }]
    for b64 in (image_b64_list or [])[:3]:
        content.append({"type": "image_url",
                        "image_url": {"url": "data:image/png;base64," + b64}})
    messages = [{"role": "system", "content": AUTO_SYSTEM},
                {"role": "user", "content": content}]
    raw = openai_chat(messages, json_mode=True)
    try:
        data = json.loads(raw)
    except Exception:
        return []
    out = []
    for c in (data.get("concepts") or []):
        instr = (c.get("change_instruction") or "").strip()
        if not instr:
            continue
        try:
            si = int(c.get("src_index", 0))
        except Exception:
            si = 0
        si = max(0, min(si, max(0, nref - 1)))
        out.append({"title": (c.get("title") or "Mẫu auto").strip()[:80],
                    "change_instruction": instr, "src_index": si})
    return out[:n]


def openai_error_message(e):
    """Đổi HTTPError của OpenAI -> câu báo lỗi tiếng Việt dễ hiểu."""
    try:
        detail = e.read().decode("utf-8", "ignore")
    except Exception:
        detail = str(e)
    low = detail.lower()
    if "moderation_blocked" in low or "safety system" in low:
        return ("⚠️ OpenAI chặn nội dung này (bộ lọc an toàn — đôi khi chặn nhầm). "
                "Thử: đổi ảnh mẫu khác · sửa/bớt chi tiết · hoặc bấm chạy lại 1–2 lần.")
    if e.code in (500, 502, 503, 520):
        return "OpenAI đang quá tải (lỗi %s). Bấm chạy lại sau giây lát." % e.code
    if e.code == 401:
        return "Key OpenAI sai hoặc hết số dư. Kiểm tra lại API key + tài khoản OpenAI."
    if e.code == 429:
        return "Gọi quá nhanh / hết hạn mức (429). Đợi chút rồi thử lại."
    return "OpenAI %s: %s" % (e.code, detail[:300])


# --------------------------------------------------------------------------- #
#  Đọc Excel (.xlsx) có ẢNH NHÚNG — bằng stdlib (zip + xml)
# --------------------------------------------------------------------------- #
_NS_M = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_NS_XDR = "{http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing}"
_NS_A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
_NS_R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
_NS_REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"


def _xlsx_ref_rowcol(ref):
    m = re.match(r"([A-Z]+)(\d+)", ref or "")
    if not m:
        return None
    col = 0
    for ch in m.group(1):
        col = col * 26 + (ord(ch) - 64)
    return int(m.group(2)) - 1, col - 1


def parse_xlsx_with_images(raw):
    """Trả (headers, rows). rows = [{row, cells:{header:val}, image:bytes|None}].
    Đọc text ô + ảnh nhúng (Insert > Picture) gắn theo dòng."""
    z = zipfile.ZipFile(io.BytesIO(raw))
    names = set(z.namelist())
    shared = []
    if "xl/sharedStrings.xml" in names:
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall(_NS_M + "si"):
            shared.append("".join((t.text or "") for t in si.iter(_NS_M + "t")))
    sheets = sorted(n for n in names if re.match(r"xl/worksheets/sheet\d+\.xml$", n))
    if not sheets:
        return [], []
    sheet = sheets[0]
    cells = {}
    for c in ET.fromstring(z.read(sheet)).iter(_NS_M + "c"):
        rc = _xlsx_ref_rowcol(c.get("r"))
        if not rc:
            continue
        v = c.find(_NS_M + "v")
        if v is None or v.text is None:
            # ô dạng inlineStr
            t = c.find(_NS_M + "is")
            txt = "".join((e.text or "") for e in t.iter(_NS_M + "t")) if t is not None else ""
            if not txt:
                continue
            cells[rc] = txt
            continue
        cells[rc] = shared[int(v.text)] if c.get("t") == "s" else v.text
    # ảnh theo dòng (qua drawing)
    images = {}
    sheet_rels = sheet.replace("worksheets/", "worksheets/_rels/") + ".rels"
    drawing = None
    if sheet_rels in names:
        for rel in ET.fromstring(z.read(sheet_rels)).findall(_NS_REL + "Relationship"):
            if rel.get("Type", "").endswith("/drawing"):
                drawing = "xl/" + rel.get("Target").replace("../", "")
    if drawing and drawing in names:
        drel = drawing.replace("drawings/", "drawings/_rels/") + ".rels"
        relmap = {}
        if drel in names:
            for rel in ET.fromstring(z.read(drel)).findall(_NS_REL + "Relationship"):
                relmap[rel.get("Id")] = "xl/" + rel.get("Target").replace("../", "")
        for anc in ET.fromstring(z.read(drawing)):
            frm = anc.find(_NS_XDR + "from")
            blip = anc.find(".//" + _NS_A + "blip")
            if frm is None or blip is None:
                continue
            try:
                rowidx = int(frm.find(_NS_XDR + "row").text)
            except Exception:
                continue
            media = relmap.get(blip.get(_NS_R + "embed"))
            if media and media in names and rowidx not in images:
                images[rowidx] = z.read(media)
    maxcol = max((c for (r, c) in cells), default=-1)
    headers = [(cells.get((0, c), "") or "").strip() for c in range(maxcol + 1)]
    rows = []
    allrows = set(r for (r, c) in cells) | set(images.keys())
    for r in sorted(x for x in allrows if x >= 1):
        rec = {"row": r, "image": images.get(r),
               "cells": {(headers[c] if c < len(headers) and headers[c] else "col%d" % c):
                         cells.get((r, c), "") for c in range(maxcol + 1)}}
        rows.append(rec)
    return headers, rows


# --------------------------------------------------------------------------- #
#  Job chạy nền nhiều luồng (gen hàng loạt từ Excel)
# --------------------------------------------------------------------------- #
BATCH_JOBS = {}
_batch_lock = threading.Lock()
_batch_seq = [0]


def _batch_row_label(cells):
    """Gộp các ô text thành chuỗi 'Tên: ... ; Ngày: ...' cho AI + nhãn ngắn."""
    parts = []
    for k, v in cells.items():
        v = (str(v) if v is not None else "").strip()
        if v and not k.startswith("col"):
            parts.append("%s: %s" % (k, v))
    return "; ".join(parts)


def run_batch_job(job_id, rows, size, transparent):
    """Mỗi dòng (có ảnh) -> AI giữ style + điền tên/ngày -> lưu gallery. Chạy song song."""
    def work(rec):
        cells = rec.get("cells") or {}
        img = rec.get("image")
        name = ""
        for k, v in cells.items():
            if "tên" in k.lower() or "name" in k.lower():
                name = (str(v) or "").strip()
                break
        label = name or _batch_row_label(cells)[:60] or ("Dòng %d" % rec["row"])
        if not img:
            return {"row": rec["row"], "error": "Dòng không có ảnh mẫu", "title": label}
        try:
            b64ref = base64.b64encode(img).decode()
            niche = _batch_row_label(cells) or "tự đặt nội dung hợp mẫu"
            concepts = auto_concepts([b64ref], niche, 1)
            if not concepts:
                return {"row": rec["row"], "error": "AI không đề xuất được", "title": label}
            b64, _ = gen_design([(img, "image/png")], "cloner",
                                concepts[0]["change_instruction"], size, transparent)
            g = gallery_add(b64, {"mode": "batch", "prompt": label})
            return {"row": rec["row"], "image": b64, "title": label, "gallery": g}
        except urllib.error.HTTPError as e:
            return {"row": rec["row"], "error": openai_error_message(e), "title": label}
        except Exception as e:
            return {"row": rec["row"], "error": str(e), "title": label}

    with ThreadPoolExecutor(max_workers=3) as ex:
        for res in ex.map(work, rows):
            with _batch_lock:
                job = BATCH_JOBS.get(job_id)
                if not job:
                    return
                job["done"] += 1
                if res.get("error"):
                    job["errors"].append("%s: %s" % (res.get("title", ""), res["error"]))
                else:
                    job["items"].append(res)
    with _batch_lock:
        if BATCH_JOBS.get(job_id):
            BATCH_JOBS[job_id]["finished"] = True


# --------------------------------------------------------------------------- #
#  Ảnh sản phẩm (gpt-image-2 edits) — theo phương pháp Nano Banana "khách thật"
# --------------------------------------------------------------------------- #
PRODUCT_NEG = (
    "Negative: visible pores, skin texture, airbrushed skin, plastic skin, waxy skin, "
    "beauty mode, portrait mode, skin smoothing, moles on face, acne, blemishes, warm color "
    "cast, orange tint, yellow tint, golden hour, dark moody, underexposed, film grain, "
    "vintage, faded, desaturated, stock photo look, oversaturated, deformed hands, mannequin "
    "pose, HDR, beauty filter, cluttered props, neck label, brand tag, mouth wide open, "
    "exaggerated smile, forced smile, blank stare, studio lighting, ring light, artificial "
    "light, fashion editorial look, dramatic shadows, harsh shadows."
)
_SHIRT = ("an OVERSIZED t-shirt, its color exactly as in the reference product image, with the "
          "printed graphic reproduced EXACTLY as in the reference product image — same artwork, "
          "SAME SIZE & SCALE, SAME POSITION on the shirt; do NOT shrink, enlarge, move, re-center, "
          "crop or redraw the design, keep it just as large and placed as in the reference; clean "
          "ribbed crewneck collar with no visible tags or labels, natural soft cotton wrinkles")
_CAM = ("Casual smartphone photo. Sharp, clean, naturally exposed — no beauty filter, no "
        "portrait blur, no skin smoothing, no grain. Feels like a friend took it. Aspect ratio 4:5. "
        "Photorealistic real photograph, true cotton fabric texture with natural fabric folds, real "
        "skin and lighting; NOT a 3D render, NOT CGI, NOT illustration, NOT AI-looking.")
_SKIN = ("clean smooth natural Vietnamese skin, naturally clear, no moles, no blemishes, not "
         "airbrushed, not plastic")
_MODEL_F = ("a young Vietnamese woman in her early 20s, petite slim, fair light skin (%s); round "
            "soft face with gentle features, natural double eyelids, bright kind eyes; long "
            "straight black hair past the shoulders worn loosely; wearing a beige pleated mini "
            "skirt and white sneakers" % _SKIN)
_MODEL_M = ("a young Vietnamese man in his early 20s, tall lean, fair light skin (%s); soft "
            "youthful face, bright natural eyes; medium-length naturally tousled black hair "
            "falling loosely across the forehead, not styled; wearing beige wide-leg trousers "
            "and white sneakers" % _SKIN)
_EXPR = ("bright cheerful gentle smile, lips parted slightly showing just the edge of teeth, eyes "
         "sparkling and alive, expression genuinely spontaneous not rehearsed")
_MODEL_KID = ("a cheerful Vietnamese child about 6 years old, %s, round happy face with bright eyes, "
              "short neat black hair, wearing simple shorts and small white sneakers" % _SKIN)
# Đội mẫu theo TỆP khách — ai mặc áo trong ảnh người mẫu
_SEG_CAST = {
    "couple": ("a young Vietnamese couple — the woman is %s; the man is %s — both wearing the SAME "
               "matching t-shirt" % (_MODEL_F, _MODEL_M)),
    "family": ("a young Vietnamese family — the mother is %s; the father is %s; together with %s — "
               "all wearing the SAME matching family t-shirt" % (_MODEL_F, _MODEL_M, _MODEL_KID)),
    "group": ("a group of four young Vietnamese friends in their early 20s, a natural mix of women and "
              "men, all with %s, casual GenZ outfits, all wearing the SAME matching team t-shirt"
              % _SKIN),
}
# Câu mô tả tệp cho AI (Claude) viết prompt
SEG_PEOPLE_HINT = {
    "single": "ONE young Vietnamese model (a woman or a man) wearing the shirt.",
    "couple": "a young Vietnamese COUPLE (a man and a woman), BOTH wearing the SAME design from the "
              "reference (matching couple shirts).",
    "family": "a young Vietnamese FAMILY — a father, a mother and a small child — ALL wearing the "
              "SAME design from the reference (matching family shirts).",
    "group": "a GROUP of 3–5 young Vietnamese friends, ALL wearing the SAME design from the reference "
             "(matching team / uniform shirts).",
}

PRODUCT_BG = {
    "cafe": ("in a small indie café, white brick walls, large glass windows letting in bright "
             "daylight, potted greenery on wooden shelves, wooden tables and rattan chairs, terrazzo "
             "floor; bright even daylight flooding through the windows, neutral, no warm cast, airy"),
    "trasua": ("in a small bubble-tea shop with pastel light-mint walls, a softly glowing neon sign, "
               "wooden counter with drinks, small round tables with colorful stools, a large glass "
               "storefront; bright cheerful interior daylight, neutral white, even"),
    "street_food": ("at a Vietnamese street-food spot on the sidewalk, low tables and stools, a tiled "
                    "wall behind, motorbikes parked nearby, a leafy tree providing shade; bright "
                    "ambient daylight in open shade, even and neutral"),
    "rooftop": ("on an open-air rooftop café terrace, wooden tables and chairs, potted plants along "
                "the edge, city rooftops in the background; bright open-sky daylight, high-key, "
                "neutral, no harsh shadows on the face"),
    "river": ("on a riverside promenade, black iron railing, a row of green leafy trees, calm water "
              "behind, clean concrete sidewalk, a few distant pedestrians softly blurred; bright even "
              "midday daylight, open sky, neutral"),
    "park": ("in a green city park with a wide walking path, tall trees forming a natural canopy, a "
             "wooden bench to the side, grass patches; soft dappled daylight through the leaves, "
             "bright and neutral"),
    "oldquarter": ("in a narrow alley of the Vietnamese old quarter, aged yellow-painted walls with "
                   "slightly peeling texture, old wooden doors, potted plants on the ground, a "
                   "motorbike parked to the side, patches of bright sky above; bright ambient daylight "
                   "bouncing off the walls, neutral, airy"),
    "walkingstreet": ("on a daytime pedestrian walking street, wide paved stone walkway, colorful "
                      "shophouse facades on both sides, trees along the center, a few people far away; "
                      "bright even daylight, open sky, neutral, clean"),
    "bedroom": ("in a simple clean bedroom, light grey walls, a neatly made bed with white sheets, a "
                "small desk with books, a sheer white curtain with bright morning light streaming in; "
                "bright soft morning daylight, neutral, airy"),
    "balcony": ("on a small apartment balcony, a concrete railing, a few small potted plants, a view "
                "of neighbouring buildings and rooftops, bright open sky; natural daylight, bright "
                "and neutral, casual lived-in feel"),
}

# Mỗi danh mục = nhiều BIẾN THỂ (đúng skill: 6 model + 6 flatlay + 5 nền trắng + 7 kraft = 24)
PRODUCT_CATS = {
    "model": {"label": "Người mẫu", "size": "1024x1536", "variants": [
        ("couple_34", "Couple 3/4"), ("couple_wu", "Couple nửa người"),
        ("couple_lean", "Couple tựa vai"), ("solo_f", "Solo nữ"),
        ("solo_m", "Solo nam"), ("chest", "Cận design trên người")]},
    "flatlay": {"label": "Flatlay sofa", "size": "1024x1024", "variants": [
        ("spread", "Trải mở"), ("folded", "Gấp gọn"), ("stacked", "Xếp chồng"),
        ("angled", "Góc nghiêng"), ("close_chest", "Cận ngực"), ("close_zoom", "Cận design")]},
    "white": {"label": "Nền trắng", "size": "1024x1024", "variants": [
        ("topdown", "Top-down"), ("rotated", "Xoay nhẹ"), ("diagonal", "Chéo"),
        ("angled", "Góc nghiêng"), ("closeup", "Cận design")]},
    "kraft": {"label": "Hộp kraft", "size": "1024x1024", "variants": [
        ("topdown", "Top-down"), ("angled", "Góc nghiêng"), ("peek", "Hé ra"),
        ("overlap", "Chồng ngoài hộp"), ("folded_bg", "Hộp làm nền"),
        ("close_box", "Cận trong hộp"), ("close_one", "Cận 1 design")]},
}

# TỆP khách: đổi BIẾN THỂ ảnh người mẫu (ai mặc áo). Flatlay/nền trắng/kraft không đổi.
PRODUCT_SEGMENTS = {
    "single": {"label": "👤 1 áo (1 người mẫu)", "model": [
        ("solo_f", "Solo nữ"), ("solo_m", "Solo nam"), ("solo_f2", "Nữ · góc 2"),
        ("solo_m2", "Nam · góc 2"), ("solo_f3", "Nữ · candid"), ("chest", "Cận design")]},
    "couple": {"label": "💑 Couple (2 người)", "model": [
        ("couple_34", "Couple 3/4"), ("couple_wu", "Couple nửa người"),
        ("couple_lean", "Couple tựa vai"), ("solo_f", "Solo nữ"),
        ("solo_m", "Solo nam"), ("chest", "Cận design")]},
    "family": {"label": "👨‍👩‍👧 Gia đình (bố/mẹ/bé)", "model": [
        ("family_34", "Gia đình 3/4"), ("family_wu", "Gia đình nửa người"),
        ("family_play", "Gia đình vui"), ("family_parents", "Bố & mẹ"),
        ("family_kid", "Bé"), ("chest", "Cận design")]},
    "group": {"label": "👥 Đội nhóm (3–5 người)", "model": [
        ("group_34", "Nhóm 3/4"), ("group_wu", "Nhóm nửa người"),
        ("group_fun", "Nhóm vui"), ("group_line", "Nhóm xếp hàng"),
        ("group_candid", "Nhóm candid"), ("chest", "Cận design")]},
}

# Khung ngắm cho từng biến thể người mẫu (template khi KHÔNG bật AI prompt)
_MODEL_FRAMES = {
    "couple_34": "Three-quarter shot from mid-thigh up, standing side by side, shoulders lightly touching, looking at the camera with bright cheerful smiles.",
    "couple_wu": "Waist-up shot, standing very close, shoulders touching, facing the camera with cheerful natural smiles.",
    "couple_lean": "Waist-up shot, she leans her head gently on his shoulder, both relaxed with gentle cheerful smiles.",
    "family_34": "Three-quarter shot from mid-thigh up, the family standing close together with the child in front between the parents, all looking at the camera with bright happy smiles.",
    "family_wu": "Waist-up group shot, the parents leaning in beside the child, all facing the camera with cheerful natural smiles.",
    "family_play": "Candid three-quarter group shot, the parents smiling as the child looks up, a joyful natural family moment, not posed.",
    "family_parents": "Waist-up shot of just the two parents standing close together, facing the camera with cheerful smiles.",
    "family_kid": "Three-quarter shot of just the child standing happily and looking at the camera with a bright playful smile.",
    "group_34": "Three-quarter group shot from mid-thigh up, the friends standing together in a relaxed cluster, all looking at the camera with bright cheerful smiles.",
    "group_wu": "Waist-up group shot, the friends close together facing the camera with cheerful energetic smiles.",
    "group_fun": "Candid group shot, the friends mid-laugh as if someone just said something funny, genuine joyful energy.",
    "group_line": "Three-quarter shot, the friends standing in a row shoulder to shoulder, all facing the camera with bright smiles, clearly showing the matching shirts.",
    "group_candid": "Candid waist-up group shot, the friends interacting naturally, some looking at the camera, relaxed and happy.",
}

# Giữ design + chân thực (vân vải, bóng đổ mềm) — tránh trông như sticker phẳng/3D giả
_DESIGN_KEEP = ("the printed design reproduced EXACTLY as in the reference — same artwork, SAME SIZE "
                "& SCALE, SAME POSITION on the shirt, do NOT shrink/move/re-center/redraw it; ")
_PHOTOREAL = (" Photorealistic real product photograph: true-to-life cotton fabric with visible weave "
              "texture and natural soft wrinkles, soft realistic contact shadow under the fabric for "
              "depth. NOT a 3D render, NOT CGI, NOT illustration, NOT a flat sticker, NOT AI-looking.")
_FNEG = (" Negative extra: bunched fabric, rolled hem, curled edges, shirt hanging off the surface, "
         "single oval logo, pill shape logo, flat sticker look, 3D render, plastic fabric.")
_FLAT_BASE = ("flatlay photo of the t-shirt from the reference product image on a light cream "
              "fabric sofa seat cushion, lying fully on the cushion (not hanging off the edge), "
              "clean ribbed collar with no tags, " + _DESIGN_KEEP + "Soft natural daylight, bright "
              "airy neutral, fabric color true to life, no props." + _PHOTOREAL)
_WHITE_BASE = ("product photo of the t-shirt from the reference product image on a pure white "
               "seamless background, oversized form clearly visible, " + _DESIGN_KEEP + "clean "
               "collar no tags, soft even neutral lighting with a soft natural contact shadow under "
               "the shirt (not floating), real cotton texture with subtle natural wrinkles, no props." + _PHOTOREAL)
_WNEG = " Negative extra: folded shirt, rolled sleeves, cream or beige or grey background, textured surface, flat sticker look, 3D render, stiff cardboard fabric."
_KRAFT_BASE = ("photo of the t-shirt from the reference product image inside a plain unprinted kraft "
               "FLIP-OPEN box (hinged lid open at the back, NOT a separate lid / shoe box), lined "
               "with thin white tissue paper, " + _DESIGN_KEEP + "soft natural daylight bright "
               "neutral, no props besides the kraft box and white tissue." + _PHOTOREAL)
_KNEG = (" Negative extra: stickers, ribbons, greeting card, dried flowers, printed box, branded box, "
         "separate lid box, detached lid, shoe box style lid.")


def product_prompt(cat, vk, bg_key, seg="single"):
    bg = PRODUCT_BG.get(bg_key, PRODUCT_BG["cafe"])
    if cat == "model":
        if vk == "chest":
            return ("A candid casual smartphone photo, chest-level crop of a young Vietnamese person "
                    "wearing %s — framed from just below the collar to above the waist, NO face "
                    "visible, slightly off-center angle as if a friend zoomed in on a phone. %s "
                    "Directional natural daylight from one side creating slight shadow depth on the "
                    "fabric, dimensional not flat, real cotton fabric texture visible, the design "
                    "large and clearly readable. %s %s" % (_SHIRT, bg, _CAM, PRODUCT_NEG))
        # nhóm nhiều người theo tệp (couple / family / group)
        cast_key = ("couple" if vk.startswith("couple") else
                    "family" if vk.startswith("family") else
                    "group" if vk.startswith("group") else "")
        if cast_key:
            cast = _SEG_CAST[cast_key]
            frame = _MODEL_FRAMES.get(vk, "Three-quarter group shot, all looking at the camera with bright cheerful smiles.")
            return ("A candid casual smartphone photo of %s %s. They all wear %s. %s The fabric "
                    "colors stay true to life, well exposed. %s %s"
                    % (cast, bg, _SHIRT, frame, _CAM, PRODUCT_NEG))
        # solo 1 người (single)
        female = vk in ("solo_f", "solo_f2", "solo_f3")
        who = _MODEL_F if female else _MODEL_M
        pose = ("one hand holding her bag strap" if female else "one hand relaxed in his pocket")
        return ("A candid casual smartphone photo of %s, wearing %s. Standing %s, %s. Waist-up shot "
                "from the waist to the top of the head, looking at the camera, %s. The fabric color "
                "stays true to life, well exposed. %s %s"
                % (who, _SHIRT, bg, pose, _EXPR, _CAM, PRODUCT_NEG))
    if cat == "flatlay":
        v = {"spread": "Laid completely flat and open, body flat, sleeves extended naturally, hem "
             "lying straight. Shot 90° straight from above.",
             "folded": "Neatly folded into a clean rectangle (folded twice), hem fully tucked in, no "
             "fabric sticking out, only the collar and chest with the design visible. Shot 75° slightly angled.",
             "stacked": "Neatly folded into a clean rectangle, hem fully tucked in, shown as a tidy "
             "stack. Shot 75° angled.",
             "angled": "Laid flat and open, shot from the hem side at a 45-55° angle showing the "
             "oversized form and natural perspective.",
             "close_chest": "Folded, frame cropped tightly to the chest + design area, no hem visible, "
             "the design large and readable. Shot 75-80° close crop.",
             "close_zoom": "Extreme close-up of the left chest — the design and collar fill the frame, "
             "cotton fabric texture visible. Shot 70°, about 25cm away."}[vk]
        return ("Top-down %s %s%s %s" % (_FLAT_BASE, v, _FNEG, PRODUCT_NEG))
    if cat == "white":
        v = {"topdown": "Fully spread open flat, sleeves extended to both sides fully visible from "
             "shoulder to cuff, body completely flat, hem straight. Shot 90° from above.",
             "rotated": "Fully spread open flat but rotated about 15-20° on the frame for a dynamic "
             "look, sleeves extended. Shot 90° from above.",
             "diagonal": "Fully spread open flat, oriented along the diagonal of the frame, sleeves "
             "extended. Shot 90° from above.",
             "angled": "Fully spread open flat, shot from the hem looking up at 45-55°, showing the "
             "full length and oversized form.",
             "closeup": "Frame cropped close to the shoulders, collar, chest and design — no hem "
             "visible, design large and readable. Shot 80-90°."}[vk]
        return ("Top-down %s %s%s %s" % (_WHITE_BASE, v, _WNEG, PRODUCT_NEG))
    # kraft
    v = {"topdown": "Neatly folded into a clean rectangle inside the box, white tissue open at the "
         "sides. Shot 90° from above.",
         "angled": "Neatly folded inside the box, showing the box walls and the flip lid open behind. "
         "Shot 45-55° from the front.",
         "peek": "The folded t-shirt leaning slightly against the box wall and peeking out of the "
         "edge, as if just lifted out, no hands. Shot 50-60° angled.",
         "overlap": "The t-shirt spread overlapping on a clean white surface OUTSIDE the box, frame "
         "cropped close, no box in frame. Shot 80-90° from above.",
         "folded_bg": "The folded t-shirt in front in focus, the kraft flip-open box softly blurred "
         "behind as the background. Shot 60-70° angled.",
         "close_box": "Folded inside the box, frame cropped tight to the chest + design, the kraft "
         "box walls framing both sides. Shot 75-80° close crop.",
         "close_one": "Extreme close-up of the chest design of the folded shirt inside the box, the "
         "kraft box wall at the frame edge, fabric texture visible. Shot 70°, about 25cm."}[vk]
    return ("Top-down %s %s%s %s" % (_KRAFT_BASE, v, _KNEG, PRODUCT_NEG))


# AI (OpenAI vision) tự viết prompt từ ảnh design — thay vai trò "Claude viết prompt" trong skill
PRODUCT_PROMPT_SYSTEM = """Bạn là chuyên gia viết prompt ảnh sản phẩm áo thun cho Nano Banana Pro, theo phương pháp "ẢNH KHÁCH HÀNG THẬT" (real customer look). Bạn được đưa ẢNH MỘT CHIẾC ÁO ĐÃ CÓ DESIGN + loại ảnh cần đạt. Viết MỘT prompt TIẾNG ANH duy nhất, là 1 đoạn văn liền mạch copy-dán ngay được.

TRIẾT LÝ: ảnh phải như người bình thường tự chụp / nhờ bạn chụp bằng điện thoại — KHÔNG studio, KHÔNG lookbook, KHÔNG xoá phông; ánh sáng tự nhiên neutral (không ám vàng/cam/ấm), da clean smooth tự nhiên (không airbrush/plastic), góc hơi lệch off-center.

QUY TẮC DESIGN (BẮT BUỘC): TUYỆT ĐỐI KHÔNG mô tả / đặt tên / vẽ lại nội dung design hay chữ trên áo. Luôn viết đúng: "with the printed design reproduced EXACTLY as shown in the reference product image — a LARGE centered FULL-FRONT chest print, SAME ARTWORK, SAME SIZE & SCALE, SAME POSITION as the reference; do NOT shrink it into a small left-chest logo, do not move, recolor or redraw it". (Mẫu là PRINT TO TRƯỚC NGỰC chiếm phần lớn thân áo — KHÔNG phải logo nhỏ.) Nano Banana tự lấy design từ ảnh ref.

NẾU LÀ ẢNH NGƯỜI MẪU — prompt phải có ĐỦ 7 block viết liền thành 1 đoạn:
1) SCENE — đang ở đâu, lúc nào, không khí, đang làm gì (gắn pose với 1 hoạt động thật).
2) LIGHTING & COLOR — nguồn sáng tự nhiên hợp bối cảnh, strictly neutral, bright & airy, fabric color true to life. Cấm studio strobe / ring light / artificial / dramatic / side lighting / warm-golden-orange cast.
3) BACKGROUND — chi tiết, có chiều sâu, bokeh nhẹ, "có đời sống".
4) PRODUCT ON BODY — chỉ MÀU vải + fit oversized + nếp nhăn tự nhiên ở nách/eo + "clean ribbed crewneck collar with no visible tags or labels"; design theo câu cố định ở trên.
5) MODEL — người Việt trẻ đầu 20s, viết CỰC kỳ cụ thể: tuổi, vóc dáng, da ("clean smooth natural Vietnamese skin, naturally clear, no moles, no blemishes, not airbrushed, not plastic"), mặt (natural Vietnamese features, KHÔNG ulzzang/Korean), mắt, tóc, quần/váy + giày + phụ kiện tối thiểu (nam ưu tiên wide-leg / baggy; nữ váy hoặc quần khác kiểu). Couple thì nam và nữ mặc quần/váy KHÁC nhau. NẾU TỆP là GIA ĐÌNH (bố/mẹ/bé) hoặc ĐỘI NHÓM (3–5 bạn): tả từng người trong nhóm, TẤT CẢ mặc CÙNG 1 design áo y hệt nhau (matching), mỗi người quần/váy khác nhau cho phong phú; bé thì da/face trẻ thơ tự nhiên, vui tươi; bố cục nhóm tự nhiên không xếp hàng cứng (trừ khi yêu cầu).
6) POSE & EXPRESSION — pose ngắn gọn tự nhiên; biểu cảm tươi nhưng KHÔNG há miệng to / cười lố: ưu tiên "bright cheerful gentle smile, lips parted slightly showing just the edge of teeth, eyes sparkling and alive, expression genuinely spontaneous not rehearsed". Waist-up: mặt chiếm tối thiểu 1/3 frame. KHÔNG chụp full body.
7) CAMERA — "Casual smartphone photo. Sharp, clean, naturally exposed — no beauty filter, no portrait blur, no skin smoothing, no grain, no filter. Feels like a friend took it." Aspect ratio 4:5.

NẾU LÀ FLATLAY SOFA / NỀN TRẮNG / HỘP KRAFT (không người): tả bề mặt + bố trí áo theo loại; áo nằm phẳng gọn, tà thẳng, tay mở tự nhiên (nền trắng: trải mở hoàn toàn, thấy rõ form oversized; nếu gấp thì gấp gọn hình chữ nhật, no hem visible, no fabric sticking out); cổ áo lộ no tags; ánh sáng soft natural daylight bright airy neutral, fabric true to life; 0 prop (kraft chỉ có hộp nắp-lật mộc + giấy lụa trắng); real cotton texture + soft contact shadow for depth; NOT 3D render, NOT flat sticker, NOT CGI.

CẤM TỪ: warm, golden, amber, honey, cozy, golden hour, terracotta, overcast, moody, dim, underexposed, muted, desaturated, faded, film grain, grain, vintage, analog, professional photograph, high quality, 8K, masterpiece, studio lighting, fashion editorial, visible pores, skin texture, mouth wide open, big laugh, exaggerated smile.

LUÔN kết thúc prompt bằng đúng dòng (giữ nguyên, kể cả ảnh flatlay):
Negative: visible pores, skin texture, hyper-detailed skin, airbrushed skin, plastic skin, waxy skin, beauty mode, portrait mode, skin smoothing, moles on face, acne, blemishes, warm color cast, orange tint, yellow tint, golden hour, dark moody, underexposed, low-key, film grain, vintage, faded, desaturated, stock photo look, oversaturated, extra fingers, deformed hands, mannequin pose, HDR, beauty filter, cluttered props, tan skin, dark skin, neck label, brand tag, mouth wide open, exaggerated smile, blank stare, studio lighting, ring light, artificial light, fashion editorial look, dramatic shadows, side lighting, harsh shadows.

Chỉ trả về CÂU PROMPT thuần (1 đoạn văn), KHÔNG giải thích, KHÔNG markdown, KHÔNG tiêu đề."""


def product_prompt_ai(img_bytes, cat, vk, bg_key, seg="single"):
    """AI nhìn ảnh áo -> tự viết prompt chân thực cho shot này. Lỗi -> prompt mẫu.

    Ưu tiên Claude API (Anthropic, có ANTHROPIC_API_KEY) — đúng kiểu skill nano-banana;
    nếu không có thì dùng OpenAI vision (gpt-4o-mini). Cả hai lỗi -> prompt mẫu cứng.
    """
    base = product_prompt(cat, vk, bg_key, seg)   # gợi ý loại ảnh + bối cảnh + pose
    seg_note = ""
    if cat == "model" and vk != "chest":
        seg_note = " TỆP khách của ảnh này: " + SEG_PEOPLE_HINT.get(seg, SEG_PEOPLE_HINT["single"])
    instr = ("Loại ảnh & bối cảnh cần đạt (tham khảo, hãy viết lại tự nhiên & chi tiết hơn): "
             + base + seg_note + " — Viết 1 prompt tiếng Anh siêu thực cho ảnh áo dưới đây, "
             "GIỮ NGUYÊN design. Chỉ trả prompt.")
    # 1) Claude (nếu có key)
    if ANTHROPIC_API_KEY:
        try:
            p = claude_vision(PRODUCT_PROMPT_SYSTEM, instr, img_bytes, max_tokens=1100)
            p = (p or "").strip().strip('"')
            if len(p) > 30:
                return p
        except Exception:
            pass
    # 2) OpenAI vision (fallback)
    b64 = base64.b64encode(img_bytes).decode()
    content = [
        {"type": "text", "text": instr},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64," + b64}},
    ]
    try:
        p = openai_chat([{"role": "system", "content": PRODUCT_PROMPT_SYSTEM},
                         {"role": "user", "content": content}], json_mode=False, max_tokens=1000)
        p = (p or "").strip().strip('"')
        return p if len(p) > 30 else base
    except Exception:
        return base


# ===== Ảnh sản phẩm kiểu Freepik: gen từ PROMPT + ảnh tham chiếu =====
def run_prod_gen_job(job_id, imgs, prompt, engine, aspect, count):
    """Gen `count` ảnh từ 1 prompt + ảnh tham chiếu (prompt-driven)."""
    size = ASPECT_TO_SIZE.get(aspect, "1024x1536")
    asp = aspect if aspect and aspect != "auto" else ""

    def work(i):
        try:
            b64 = gen_shot(imgs, prompt, size, engine, asp)
            g = gallery_add(b64, {"mode": "product", "prompt": prompt[:140]})
            return {"image": b64, "title": prompt[:80], "prompt": prompt,
                    "engine": engine, "aspect": aspect or "auto", "gallery": g}
        except urllib.error.HTTPError as e:
            return {"error": openai_error_message(e), "title": "Lỗi"}
        except Exception as e:
            return {"error": str(e), "title": "Lỗi"}

    with ThreadPoolExecutor(max_workers=3) as ex:
        for res in ex.map(work, range(count)):
            with _batch_lock:
                job = BATCH_JOBS.get(job_id)
                if not job:
                    return
                job["done"] += 1
                if res.get("error"):
                    job["errors"].append(res["error"])
                else:
                    job["items"].append(res)
    with _batch_lock:
        if BATCH_JOBS.get(job_id):
            BATCH_JOBS[job_id]["finished"] = True


# ===== FACEBOOK ADS: AI đặt tên + gen concept ad theo ảnh style + chèn text =====
ADS_CONCEPTS = {
    "couple":   ("Couple (2 áo)", "a young Vietnamese couple — a man and a woman — BOTH wearing the SAME matching t-shirt"),
    "group":    ("Đội nhóm (3 áo)", "a group of THREE young Vietnamese friends, ALL wearing the SAME matching t-shirt"),
    "family":   ("Gia đình (4 áo)", "a happy Vietnamese family — father, mother and two children — ALL wearing the SAME matching t-shirt"),
    "flatlay2": ("Flatlay 2 áo", "TWO t-shirts of the SAME design laid out flat side by side in a clean tidy flatlay arrangement, NO people"),
    "flatlay3": ("Flatlay 3 áo", "THREE t-shirts of the SAME design laid out flat together in a clean tidy flatlay arrangement, NO people"),
}

ADS_TEXT_SYSTEM = ("Bạn là copywriter quảng cáo áo thun ở Việt Nam. Nhìn DESIGN trên áo, đặt 1 TÊN SẢN "
                   "PHẨM mới ngắn gọn & hấp dẫn bằng tiếng Việt (KHÁC với chữ đã in trên áo) + 1 HOOK "
                   "quảng cáo cực ngắn (≤8 từ, gây chú ý). Trả JSON {\"name\":\"...\",\"hook\":\"...\"}.")


def ads_concept_text(img_bytes):
    """AI nhìn design -> {name, hook} cho ad."""
    b64 = base64.b64encode(img_bytes).decode()
    content = [{"type": "text", "text": "Đặt TÊN sản phẩm + HOOK ads cho áo này. Chỉ trả JSON."},
               {"type": "image_url", "image_url": {"url": "data:image/png;base64," + b64}}]
    try:
        raw = openai_chat([{"role": "system", "content": ADS_TEXT_SYSTEM},
                           {"role": "user", "content": content}], json_mode=True, max_tokens=200)
        d = json.loads(raw)
        return {"name": (d.get("name") or "").strip(), "hook": (d.get("hook") or "").strip()}
    except Exception:
        return {"name": "", "hook": ""}


def ads_read_name(img_bytes):
    """Vision: đọc TÊN/CHỮ CHÍNH (lớn nhất) đang in trên design -> để ép thay thế đúng chỗ đó."""
    b64 = base64.b64encode(img_bytes).decode()
    sysmsg = ("Bạn xem 1 design áo thun in tên. Trả JSON {\"name\":\"...\"} = đúng CỤM CHỮ CHÍNH "
              "lớn nhất (thường là tên người) đang in trên áo, giữ nguyên chữ & dấu. Nếu không có tên "
              "rõ ràng trả \"name\":\"\".")
    content = [{"type": "text", "text": "Đọc tên/chữ chính trên design. Chỉ trả JSON."},
               {"type": "image_url", "image_url": {"url": "data:image/png;base64," + b64}}]
    try:
        raw = openai_chat([{"role": "system", "content": sysmsg},
                           {"role": "user", "content": content}], json_mode=True, max_tokens=60)
        return (json.loads(raw).get("name") or "").strip()
    except Exception:
        return ""


def _ads_replace_clause(old_name):
    """Câu ép XOÁ tên gốc cụ thể (tránh hiện 2 tên)."""
    if old_name:
        return ("The design currently shows the name \"" + old_name + "\". On every shirt you MUST "
                "completely REMOVE \"" + old_name + "\" and put the new name in its exact place. ")
    return ""


def _ads_style_clauses(img_style_n, txt_style_n):
    s = ""
    if img_style_n:
        s += ("Reference image #%d is the STYLE reference — MATCH ITS STYLE CLOSELY so the final ad "
              "clearly looks like it belongs to the same set: the same color palette, lighting, "
              "background look and surface, framing, props arrangement vibe, finishing/retouch and "
              "overall aesthetic. Follow it tightly. BUT two things must NOT come from it: "
              "(a) the SCENE TYPE / SUBJECT is fixed by the concept described ABOVE — if the concept "
              "calls for PEOPLE wearing the shirts, the result MUST show those people even if the "
              "reference is a flatlay; if the concept is a flatlay, keep it a flatlay even if the "
              "reference shows people. Do NOT switch a people scene into a flat lay-down of shirts or "
              "vice-versa. (b) do NOT copy the literal CONTENT of the reference: not its specific "
              "people or faces, not its shirts, and not any printed name or text on it. Every shirt and "
              "printed name in the final ad comes ONLY from the design reference(s) above (each with its "
              "own DIFFERENT name); never reuse a name from this style board. " % img_style_n)
    if txt_style_n:
        s += ("Reference image #%d is a TYPOGRAPHY / LETTERING-STYLE sample ONLY. Use it solely to copy "
              "the LETTERING STYLE of the ad text — the font shape, weight, effects and treatment. "
              "COMPLETELY IGNORE the actual WORDS, letters, names and any text content written in it: do "
              "NOT read, reuse, copy or display ANY of the words from that image. The only words allowed "
              "in the final ad are the product name and hook specified above — never any word taken from "
              "this lettering sample. " % txt_style_n)
    return s


def _ads_text_part(name, hook, text_style, text_color=""):
    txt = 'a big bold headline "' + name + '"'
    if hook:
        txt += ' and a short punchy sub-line "' + hook + '"'
    txt += (". CRITICAL LAYOUT — the image MAY BE CROPPED to a narrower VERTICAL ratio, so the TOP ~14% and "
            "BOTTOM ~14% bands can get CUT OFF. Keep ALL ad text (the headline AND the sub-line) and the "
            "brand inside the CENTRAL ~70% of the height — put NOTHING important in the top or bottom band. "
            "The headline must NOT be near the top edge; pull it well DOWN into the centre with a big top "
            "margin. All text and the product must stay 100% visible even after a top/bottom crop")
    if text_style:
        txt += ' — render the ad text typography in this style: ' + text_style
    tc = (text_color or "").strip()
    if tc:
        txt += (". Render BOTH the headline and the sub-line in this exact COLOUR: " + tc + " — use this "
                "one colour consistently, clearly readable with strong contrast against its background")
    else:
        txt += (". IMPORTANT — choose ONE ad-text COLOUR that looks PREMIUM and HARMONIOUS with the whole "
                "photo, never harsh: prefer a DEEP, RICH, SOPHISTICATED tone — a darkened / muted shade of "
                "the design's main colour, or a deep neutral already in the warm scene (charcoal, near-black, "
                "espresso, deep warm brown). STRONGLY AVOID bright, neon, saturated or pure-primary headline "
                "colours (no bright orange / bright blue / pure red). Apply that same elegant colour to BOTH "
                "the headline and the sub-line, clearly readable with strong contrast against the light "
                "background, looking intentionally colour-coordinated and tasteful, like a high-end brand ad")
    return txt


def _ads_brand_clause(brand):
    """Chèn brand/website nhỏ gọn ở góc ảnh (logo-style)."""
    b = (brand or "").strip()
    if not b:
        return ""
    return (" Also place the brand / website \"" + b + "\" as a SMALL, clean, tasteful brand mark in a "
            "BOTTOM corner of the ad (small logo-style text), in a colour that fits the palette and is "
            "clearly readable but subtle — do NOT let it dominate the ad. Spell it EXACTLY as \"" + b
            + "\", lowercase, no extra words.")


def ads_ad_prompt(cast, name, hook, img_style_n, txt_style_n, text_style="", text_color=""):
    txt = _ads_text_part(name, hook, text_style, text_color)
    style = _ads_style_clauses(img_style_n, txt_style_n)
    return ("Create a polished, eye-catching FACEBOOK AD creative for a t-shirt brand. "
            "The FIRST reference image is the DESIGN: reproduce its printed graphic EXACTLY — same "
            "artwork, text, colors — as a LARGE full-front chest print on the shirt; do not redraw, "
            "recolor or shrink it. " + style +
            "Show " + cast + " wearing the design from the first reference image. "
            "Integrate bold VIETNAMESE ad text naturally into the image like a real ad: " + txt +
            " — render the text CRISP and CORRECTLY SPELLED with proper Vietnamese diacritics, well "
            "placed and clearly readable. Photorealistic, high-quality social-media ad.")


def ads_couple_names():
    """2 tên người Việt 2 chữ: 1 nam, 1 nữ (cho áo đôi cross-name)."""
    sys = ("Đặt 2 TÊN NGƯỜI Việt 2 chữ cho áo couple: 1 NAM, 1 NỮ (vd nam \"Minh Quân\", nữ "
           "\"Thuỳ Linh\"). Trả JSON {\"male\":\"...\",\"female\":\"...\"}.")
    try:
        raw = openai_chat([{"role": "system", "content": sys},
                           {"role": "user", "content": "Cho 2 tên couple. Chỉ trả JSON."}],
                          json_mode=True, max_tokens=80)
        d = json.loads(raw)
        return {"male": (d.get("male") or "Anh Yêu").strip(), "female": (d.get("female") or "Em Yêu").strip()}
    except Exception:
        return {"male": "Anh Yêu", "female": "Em Yêu"}


def ads_n_names(n):
    """n TÊN người Việt 2 chữ KHÁC NHAU (áo cá nhân hoá mỗi áo 1 tên)."""
    sys = ("Đặt %d TÊN NGƯỜI Việt 2 chữ KHÁC NHAU (vd \"Minh Anh\", \"Quốc Bảo\", \"Thuỳ Trang\"). "
           "Trả JSON {\"names\":[...]} đúng %d tên." % (n, n))
    try:
        raw = openai_chat([{"role": "system", "content": sys},
                           {"role": "user", "content": "Cho %d tên. Chỉ trả JSON." % n}],
                          json_mode=True, max_tokens=150)
        d = json.loads(raw)
        names = [str(s).strip() for s in (d.get("names") or []) if str(s).strip()][:n]
    except Exception:
        names = []
    while len(names) < n:
        names.append("Bạn %d" % (len(names) + 1))
    return names


# số áo (tên khác nhau) mỗi concept
ADS_CONCEPT_N = {"couple": 2, "group": 3, "family": 4, "flatlay2": 2, "flatlay3": 3}


_ADS_KEEP = (
    "Reference image #1 is the t-shirt design. On EVERY shirt reproduce this design faithfully: same "
    "layout, same fonts, same emblem/icons, stars, lines, banners and the NON-NAME secondary text "
    "(taglines/series words like 'CUSTOM NAME SERIES' / 'Athletic', and any EST/date) — keep those "
    "identical, do NOT remove, redraw, restyle, simplify or re-center anything. What CHANGES per shirt is "
    "the single MAIN large NAME text (replace with a different name on each shirt, same font/style/weight/"
    "position, correct Vietnamese diacritics). "
    "PRINT COLOUR: keep the design's OWN original colours, but render them CLEAN, crisp and EXACTLY the "
    "SAME on every shirt — the print colour and text must NOT drift, shift, fade, recolor or look "
    "misaligned/mismatched between the shirts; all prints look perfectly aligned and sharp. ")


_ADS_REAL = (
    "Make it a NATURAL, candid, TRUE-TO-LIFE lifestyle PHOTOGRAPH — real Vietnamese people with real "
    "skin and hair, soft natural light, realistic fabric and folds; NOT 3D, NOT CGI, NOT a cartoon, NOT "
    "an AI-looking render. The ADULTS' t-shirts are clearly ADULT OVERSIZE streetwear — roomy, wide, "
    "boxy body with DROP SHOULDERS and wide short sleeves, worn loose and relaxed (size L–XXL look), "
    "longer hem; NOT slim-fit, NOT tight, NOT small. ")


def _short_name(name):
    """Biệt danh = TỪ CUỐI của tên chính (vd 'Hoàng Nam' -> 'Nam', 'Ngọc Anh' -> 'Anh')."""
    parts = [w for w in (name or "").strip().split() if w]
    return parts[-1] if parts else (name or "")


_FAMILY_POSES = [
    "standing close together, the kid(s) in front between the parents, all smiling at the camera",
    "the parents crouching down beside the kid(s), a warm candid hug moment",
    "walking together side by side outdoors, relaxed and laughing",
    "sitting together on a cozy sofa/bench, leaning in close",
    "the dad lifting/piggy-backing the kid while mom laughs beside them",
    "all holding hands in a row, looking at each other happily",
]

_ADS_ONE = ("Each shirt's MAIN big name is exactly ONE (the new one) — never keep the design's original "
            "main name anywhere. (A separate small secondary person-name line, if the design has one, is "
            "allowed and is handled below.) ")

_ADS_ALLNAMES = ("NAMES & LAYOUT RULE (very important): reproduce the reference design's EXACT layout and "
                 "set of elements — do NOT ADD, remove, move or invent anything. The big MAIN name is the "
                 "only text that always changes (a different name on each shirt). For any OTHER name, only "
                 "change it IF it already exists in the reference; NEVER add a new cursive signature, extra "
                 "name line or any element that is not already in the reference design. If the reference "
                 "shows just a main name + a year/EST/tagline (no secondary name), keep it exactly that way. "
                 "Keep all non-name text (taglines, 'EST', dates) identical. ")


def ads_multi_prompt(concept_key, names, prod_name, hook, img_style_n, txt_style_n, text_style, old_name="", bg="", text_color=""):
    """Concept nhiều áo — GIỮ NGUYÊN design gốc, CHỈ đổi tên chính từng áo (1 lần gen)."""
    txt = _ads_text_part(prod_name, hook, text_style, text_color)
    style = _ads_style_clauses(img_style_n, txt_style_n)
    n = len(names)
    # biệt danh phụ = TÊN RÚT GỌN của tên chính (Hoàng Nam -> Nam); CHỈ đổi nếu mẫu vốn CÓ
    subs = [_short_name(names[i]) for i in range(n)]
    perslot = " ".join(('Shirt #%d: main name "%s".' % (i + 1, names[i])) for i in range(n))
    sub_clause = ("SECONDARY NICKNAME — conditional: ONLY IF the reference design ALREADY shows a small "
                  "secondary name (a cursive/handwritten signature OR a small printed name under the main "
                  "name), then on EACH shirt make that secondary name the SHORT given-name taken from that "
                  "shirt's OWN main name (the last word) — it is a person NICKNAME, NEVER an endearment "
                  "word like 'Cục Cưng' / 'Honey' / 'Bé'. Keep its original style/size/position: " +
                  "; ".join('shirt #%d main "%s" -> nickname "%s"' % (i + 1, names[i], subs[i]) for i in range(n)) +
                  ". BUT if the reference has just the main name + year/EST/tagline and NO secondary name, "
                  "keep the layout EXACTLY and DO NOT add any cursive signature or extra name. ")
    namelist = ", ".join('"' + x + '"' for x in names)
    bg = (bg or "").strip()
    if concept_key == "group":
        scene = ("Show a group of %d young Vietnamese friends standing together, EACH wearing one of "
                 "these shirts as a LARGE full-front chest print. " % n) + _ADS_REAL
        if bg:
            scene += ("Set the scene with this background: " + bg + ". ")
    elif concept_key == "family":
        pose = random.choice(_FAMILY_POSES)
        scene = ("Show ONE single happy Vietnamese FAMILY — EXACTLY %d people: a father, a mother and "
                 "their child(ren) — and NO extra people, NO crowd, NO other adults. The whole family is "
                 "%s, in a natural lifestyle photo, EACH person WEARING one of these matching shirts as a "
                 "LARGE full-front chest print (kids wear smaller kid-sized versions of the same design). "
                 "A photo of exactly %d people wearing the shirts — NOT a flatlay, NOT a product-only shot. "
                 % (n, pose, n)) + _ADS_REAL
        if bg:
            scene += ("Set the scene with this background: " + bg + ". ")
    else:  # flatlay2 / flatlay3
        on_bg = (" on " + bg) if bg else ""
        scene = ("Lay %d ADULT UNISEX OVERSIZE t-shirts out FLAT in a clean tidy flatlay arrangement%s, "
                 "NO people. The shirts are clearly BIG adult oversize streetwear tees — WIDE boxy body, "
                 "wide short sleeves, drop shoulders, roomy relaxed cut (size L–XXL look), longer hem; "
                 "NOT slim, NOT small, NOT kids' shirts. Natural, realistic product photo. " % (n, on_bg))
    return ("Create a polished FACEBOOK AD creative for PERSONALISED name t-shirts. " + scene +
            _ADS_KEEP + _ADS_ALLNAMES + _ads_replace_clause(old_name) + _ADS_ONE + sub_clause +
            ("There are %d shirts with %d DIFFERENT main names: %s. %s Every name (big and small) is "
             "DIFFERENT on every shirt — do NOT repeat any name. " % (n, n, namelist, perslot)) +
            style +
            "Integrate bold VIETNAMESE ad text naturally like a real ad: " + txt + " — crisp, correctly "
            "spelled with proper Vietnamese diacritics. Photorealistic, high-quality social-media ad.")


def ads_couple_prompt(nm, prod_name, hook, img_style_n, txt_style_n, text_style="", old_name="", bg="", text_color=""):
    """Couple — GIỮ NGUYÊN design gốc, chỉ đổi tên + cross (nam tên nữ, nữ tên nam), 1 lần gen."""
    txt = _ads_text_part(prod_name, hook, text_style, text_color)
    style = _ads_style_clauses(img_style_n, txt_style_n)
    bg = (bg or "").strip()
    bg_clause = ("Set the scene with this background: " + bg + ". ") if bg else ""
    # biệt danh = tên rút gọn của tên IN TRÊN áo đó (cross-named: áo nam in tên nữ...)
    sub_clause = ("SECONDARY NICKNAME — conditional: ONLY IF the reference ALREADY has a small secondary "
                  "name line, set it as the SHORT given-name (last word) of the main name printed on THAT "
                  "shirt — a person nickname, NEVER an endearment like 'Cục Cưng'/'Honey'. Man's shirt main "
                  "\"%s\" -> nickname \"%s\"; woman's shirt main \"%s\" -> nickname \"%s\" (keep small "
                  "size/position/font). If the reference has NO secondary name, keep the layout exactly and "
                  "do NOT add one. " % (nm["female"], _short_name(nm["female"]), nm["male"], _short_name(nm["male"])))
    return ("Create a polished FACEBOOK AD creative for a COUPLE t-shirt set with INTENTIONAL "
            "CROSS-NAMING (a popular couple-tee idea). " + _ADS_KEEP + _ADS_ALLNAMES +
            _ads_replace_clause(old_name) + _ADS_ONE + sub_clause +
            "There are TWO shirts. The MAN's shirt shows the FEMALE name \"" + nm["female"] + "\"; the "
            "WOMAN's shirt shows the MALE name \"" + nm["male"] + "\". This swap is ON PURPOSE: the "
            "man's shirt MUST show \"" + nm["female"] + "\" and the woman's shirt MUST show \""
            + nm["male"] + "\". Do NOT put the male name on the man or the female name on the woman; do "
            "NOT correct or normalise it. "
            + style +
            "Show a happy young Vietnamese couple standing together, each wearing their shirt as a LARGE "
            "full-front chest print. " + _ADS_REAL + bg_clause +
            "Integrate bold VIETNAMESE ad text naturally like a real ad: " + txt + " — crisp, correctly "
            "spelled with proper Vietnamese diacritics. Photorealistic, high-quality social-media ad.")


def run_ads_job(job_id, design_img, concepts, name, hook, engine, aspect="4:5", text_style="", text_style_img=None, quality="medium", text_color="", brand="rieng.vn"):
    """concepts = [{'key':..., 'ref':bytes|None}]. Gen 1 ad/concept."""
    size = ASPECT_TO_SIZE.get(aspect, "1024x1536")
    asp = aspect or "4:5"

    # đọc TÊN GỐC trên design 1 lần (ép xoá đúng tên đó, tránh hiện 2 tên)
    old_name = ads_read_name(design_img[0])

    def work(c):
        try:
            key = c["key"]
            nm = None
            bg = (c.get("bg") or "").strip()
            # GIỮ NGUYÊN design gốc: đưa design 1 lần làm ref #1, model chỉ đổi TÊN trên từng áo
            # (KHÔNG personalize/vẽ lại -> giữ đúng mẫu + nhanh hơn nhiều, đúng kiểu ChatGPT)
            imgs = [design_img]
            nxt = 2
            if key == "couple":
                nm = ads_couple_names()
            img_n = txt_n = None
            if c.get("ref"):
                imgs.append((c["ref"], "image/png")); img_n = nxt; nxt += 1
            if text_style_img:
                imgs.append((text_style_img, "image/png")); txt_n = nxt; nxt += 1
            cp = (c.get("custom_prompt") or "").strip()
            if cp:
                prompt = cp   # user tự sửa prompt -> dùng nguyên văn
            else:
                if key == "couple":
                    prompt = ads_couple_prompt(nm, name, hook, img_n, txt_n, text_style, old_name, bg, text_color)
                elif key in ADS_CONCEPT_N:
                    names = ads_n_names(ADS_CONCEPT_N[key])
                    prompt = ads_multi_prompt(key, names, name, hook, img_n, txt_n, text_style, old_name, bg, text_color)
                else:
                    prompt = ads_ad_prompt(ADS_CONCEPTS[key][1], name, hook, img_n, txt_n, text_style, text_color)
                prompt += _ads_brand_clause(brand)
            b64 = gen_shot(imgs, prompt, size, engine, asp, lock=False, quality=quality)
            # cắt về ĐÚNG tỉ lệ user chọn (model chỉ ra vài size cố định)
            if HAS_PIL:
                try:
                    b64 = base64.b64encode(crop_to_aspect(base64.b64decode(b64), asp)).decode()
                except Exception:
                    pass
            b64 = strip_ai_meta_b64(b64)   # bỏ metadata C2PA -> FB không gắn nhãn "Made with AI"
            label = "Ads · %s · %s" % (ADS_CONCEPTS[c["key"]][0], name)
            model = engine_model_label(engine)
            adsmeta = {"concept": key, "name": name, "hook": hook, "aspect": asp, "bg": bg, "model": model}
            g = gallery_add(b64, {"mode": "ads", "prompt": label, "ads": adsmeta})
            return {"image": b64, "title": label, "concept": key, "name": name, "hook": hook,
                    "aspect": asp, "bg": bg, "model": model, "gallery": g, "prompt": prompt}
        except urllib.error.HTTPError as e:
            return {"error": openai_error_message(e), "title": ADS_CONCEPTS[c["key"]][0]}
        except Exception as e:
            return {"error": str(e), "title": ADS_CONCEPTS[c["key"]][0]}

    with ThreadPoolExecutor(max_workers=3) as ex:
        for res in ex.map(work, concepts):
            with _batch_lock:
                job = BATCH_JOBS.get(job_id)
                if not job:
                    return
                job["done"] += 1
                if res.get("error"):
                    job["errors"].append("%s: %s" % (res.get("title", ""), res["error"]))
                else:
                    job["items"].append(res)
    with _batch_lock:
        if BATCH_JOBS.get(job_id):
            BATCH_JOBS[job_id]["finished"] = True


# --------------------------------------------------------------------------- #
#  FACEBOOK POST — ảnh SẠCH (không chèn text), mỗi concept 1 BỘ 4-5 ảnh
# --------------------------------------------------------------------------- #
_FBPOST_CLEAN = (
    "This is a CLEAN organic social-media photo for a Facebook page post — absolutely NO advertising "
    "text, NO headline, NO marketing copy, NO price, NO call-to-action, NO logo, NO watermark and NO "
    "brand name overlaid anywhere on the image. Just a beautiful, natural lifestyle/product photograph "
    "of the shirt(s) themselves. ")
_FBPOST_SHOTS = ["wide full shot", "closer waist-up shot", "a slightly different relaxed pose and angle",
                 "a candid natural moment", "a different framing / lighting angle"]
_FBPOST_FLAT_SHOTS = ["clean top-down flatlay", "angled flatlay arrangement",
                      "close-up detail of the printed name", "shirts neatly folded flatlay",
                      "shirts spread out flatlay"]


def _fbpost_names_clause(names):
    n = len(names)
    perslot = " ".join(('Shirt #%d shows the name "%s".' % (i + 1, names[i])) for i in range(n))
    namelist = ", ".join('"' + x + '"' for x in names)
    return ("There are %d shirts with %d DIFFERENT names: %s. %s All names are DIFFERENT — do not repeat. "
            % (n, n, namelist, perslot))


def fbpost_prompt(concept_key, names, nm, img_style_n, bg, old_name, variation=""):
    """Ảnh SẠCH cho FB post (giữ design + tên, KHÔNG chèn text quảng cáo)."""
    style = _ads_style_clauses(img_style_n, None)
    n = len(names)
    bg = (bg or "").strip()
    is_flat = concept_key.startswith("flatlay")
    if concept_key == "couple":
        body = ("Show a happy young Vietnamese couple standing together, each wearing their shirt as a "
                "LARGE full-front chest print. " + _ADS_REAL)
        names_clause = ("The MAN's shirt shows the name \"" + nm["female"] + "\"; the WOMAN's shirt shows "
                        "the name \"" + nm["male"] + "\" (cross-named couple, on purpose). ")
    elif concept_key == "group":
        body = ("Show a group of %d young Vietnamese friends standing together, each wearing one of these "
                "shirts as a LARGE full-front chest print. " % n) + _ADS_REAL
        names_clause = _fbpost_names_clause(names)
    elif concept_key == "family":
        body = ("Show ONE single happy Vietnamese FAMILY — EXACTLY %d people: father, mother and "
                "child(ren), NO extra people / NO crowd — EACH wearing one of these matching shirts (kids "
                "in kid-sized versions). It is the SAME family throughout the whole photo set; only the "
                "pose/angle changes between shots. A photo of exactly %d people, NOT a flatlay. "
                % (n, n)) + _ADS_REAL
        names_clause = _fbpost_names_clause(names)
    else:  # flatlay
        on_bg = (" on " + bg) if bg else ""
        body = ("Lay %d OVERSIZE relaxed t-shirts out FLAT in a clean tidy flatlay arrangement%s, NO "
                "people. Natural realistic product photo. " % (n, on_bg))
        names_clause = _fbpost_names_clause(names)
    bg_clause = ("Background/scene: " + bg + ". ") if (bg and not is_flat) else ""
    # biệt danh phụ = tên rút gọn của tên chính (nếu mẫu vốn có)
    if concept_key == "couple":
        nick_pairs = [(nm["female"], _short_name(nm["female"])), (nm["male"], _short_name(nm["male"]))]
    elif is_flat or concept_key in ("group", "family"):
        nick_pairs = [(names[i], _short_name(names[i])) for i in range(n)]
    else:
        nick_pairs = []
    sub_clause = ""
    if nick_pairs:
        sub_clause = ("SECONDARY NICKNAME — conditional: ONLY IF the reference ALREADY shows a small "
                      "secondary name (cursive signature or small line), set it as the SHORT given-name "
                      "(last word) of that shirt's main name — a person nickname, NEVER an endearment "
                      "like 'Cục Cưng'/'Honey': " +
                      "; ".join('"%s" -> "%s"' % (a, b) for (a, b) in nick_pairs) +
                      ". If there is NO secondary name, keep layout exactly and add nothing. ")
    return (body + _ADS_KEEP + _ADS_ALLNAMES + _ads_replace_clause(old_name) + _ADS_ONE + sub_clause + names_clause + _FBPOST_CLEAN +
            style + bg_clause + variation + "Photorealistic, high-quality, crisp, natural colours.")


def run_fbpost_job(job_id, design_img, concepts, engine, aspect="4:5", quality="medium", per_set=4):
    """Mỗi concept -> 1 BỘ per_set ảnh sạch (không text). concepts=[{key,ref,bg}]."""
    size = ASPECT_TO_SIZE.get(aspect, "1024x1536")
    asp = aspect or "4:5"
    per_set = max(1, min(6, int(per_set or 4)))
    old_name = ads_read_name(design_img[0])

    def work(c):
        try:
            key = c["key"]
            bg = (c.get("bg") or "").strip()
            nm = None
            if key == "couple":
                nm = ads_couple_names(); names = [nm["female"], nm["male"]]
            elif key in ADS_CONCEPT_N:
                names = ads_n_names(ADS_CONCEPT_N[key])
            else:
                names = ads_n_names(1)
            imgs = [design_img]; img_n = None
            if c.get("ref"):
                imgs.append((c["ref"], "image/png")); img_n = 2
            hints = _FBPOST_FLAT_SHOTS if key.startswith("flatlay") else _FBPOST_SHOTS
            label = "FB Post · %s" % ADS_CONCEPTS[key][0]
            pics = []
            for i in range(per_set):
                v = "Shot %d of a matching set — %s. " % (i + 1, hints[i % len(hints)])
                prompt = fbpost_prompt(key, names, nm, img_n, bg, old_name, v)
                b64 = gen_shot(imgs, prompt, size, engine, asp, lock=False, quality=quality)
                if HAS_PIL:
                    try:
                        b64 = base64.b64encode(crop_to_aspect(base64.b64decode(b64), asp)).decode()
                    except Exception:
                        pass
                b64 = strip_ai_meta_b64(b64)   # bỏ metadata C2PA -> FB/IG không gắn nhãn "Made with AI"
                g = gallery_add(b64, {"mode": "fbpost", "prompt": label})
                pics.append({"image": b64, "url": g.get("url"), "id": g.get("id")})
            return {"concept": key, "title": label, "pics": pics}
        except urllib.error.HTTPError as e:
            return {"error": openai_error_message(e), "title": ADS_CONCEPTS[c["key"]][0]}
        except Exception as e:
            return {"error": str(e), "title": ADS_CONCEPTS[c["key"]][0]}

    with ThreadPoolExecutor(max_workers=2) as ex:
        for res in ex.map(work, concepts):
            with _batch_lock:
                job = BATCH_JOBS.get(job_id)
                if not job:
                    return
                job["done"] += 1
                if res.get("error"):
                    job["errors"].append("%s: %s" % (res.get("title", ""), res["error"]))
                else:
                    job["items"].append(res)
    with _batch_lock:
        if BATCH_JOBS.get(job_id):
            BATCH_JOBS[job_id]["finished"] = True


def fb_page_token():
    """Lấy Page Access Token từ user/system token (cần quyền pages_manage_posts để đăng)."""
    st, d = fb_graph("GET", "%s" % FB_PAGE_ID, {"fields": "access_token"})
    return (d or {}).get("access_token")


# ===================== ĐĂNG FB/IG (core dùng lại cho lịch tự động) =====================
def fb_post_core(urls_abs, message):
    """Đăng 1 bộ ảnh lên Fanpage. urls_abs = list URL công khai tuyệt đối. Trả {ok,url|error}."""
    if not (FB_ACCESS_TOKEN and FB_PAGE_ID):
        return {"ok": False, "error": "Chưa cấu hình Facebook."}
    ptok = fb_page_token()
    if not ptok:
        return {"ok": False, "error": "Không lấy được Page token (cần pages_manage_posts)."}
    media = []
    for au in [u for u in (urls_abs or []) if u][:10]:
        st, d = fb_graph("POST", "%s/photos" % FB_PAGE_ID, {"url": au, "published": "false"}, ptok)
        if st == 200 and d.get("id"):
            media.append({"media_fbid": d["id"]})
        else:
            return {"ok": False, "error": "Upload ảnh Trang lỗi: " + fb_err(d)}
    if not media:
        return {"ok": False, "error": "Không upload được ảnh."}
    st, d = fb_graph("POST", "%s/feed" % FB_PAGE_ID,
                     {"message": message, "attached_media": json.dumps(media)}, ptok)
    if not d.get("id"):
        return {"ok": False, "error": "Đăng bài lỗi: " + fb_err(d)}
    return {"ok": True, "id": d["id"], "url": "https://www.facebook.com/%s" % d["id"]}


def ig_user_id():
    """ID tài khoản Instagram Business nối với Trang (None nếu chưa nối)."""
    st, d = fb_graph("GET", "%s" % FB_PAGE_ID, {"fields": "instagram_business_account"})
    return ((d or {}).get("instagram_business_account") or {}).get("id")


def _ig_wait_ready(cid):
    """Chờ media container IG xử lý xong (FINISHED) trước khi publish."""
    for _ in range(25):
        st, d = fb_graph("GET", "%s" % cid, {"fields": "status_code"})
        sc = (d or {}).get("status_code")
        if sc == "FINISHED":
            return True
        if sc == "ERROR":
            return False
        time.sleep(2)
    return False


def ig_post_core(urls_abs, caption):
    """Đăng ảnh lên Instagram (1 ảnh hoặc carousel). Trả {ok,url|error}."""
    if not (FB_ACCESS_TOKEN and FB_PAGE_ID):
        return {"ok": False, "error": "Chưa cấu hình Facebook."}
    igid = ig_user_id()
    if not igid:
        return {"ok": False, "error": "Trang chưa nối Instagram Business (hoặc token thiếu quyền instagram_basic/instagram_content_publish)."}
    urls = [u for u in (urls_abs or []) if u][:10]
    if not urls:
        return {"ok": False, "error": "Thiếu ảnh."}
    if len(urls) == 1:
        st, d = fb_graph("POST", "%s/media" % igid, {"image_url": urls[0], "caption": caption})
        cid = (d or {}).get("id")
        if not cid:
            return {"ok": False, "error": "Tạo media IG lỗi: " + fb_err(d)}
        _ig_wait_ready(cid)
        st, d = fb_graph("POST", "%s/media_publish" % igid, {"creation_id": cid})
        mid = (d or {}).get("id")
        if not mid:
            return {"ok": False, "error": "Đăng IG lỗi: " + fb_err(d)}
        return {"ok": True, "id": mid, "url": "https://www.instagram.com/"}
    # carousel nhiều ảnh
    children = []
    for u in urls:
        st, d = fb_graph("POST", "%s/media" % igid, {"image_url": u, "is_carousel_item": "true"})
        cid = (d or {}).get("id")
        if not cid:
            return {"ok": False, "error": "Tạo ảnh carousel IG lỗi: " + fb_err(d)}
        children.append(cid)
    for cid in children:
        _ig_wait_ready(cid)
    st, d = fb_graph("POST", "%s/media" % igid,
                     {"media_type": "CAROUSEL", "children": ",".join(children), "caption": caption})
    car = (d or {}).get("id")
    if not car:
        return {"ok": False, "error": "Tạo carousel IG lỗi: " + fb_err(d)}
    _ig_wait_ready(car)
    st, d = fb_graph("POST", "%s/media_publish" % igid, {"creation_id": car})
    mid = (d or {}).get("id")
    if not mid:
        return {"ok": False, "error": "Đăng carousel IG lỗi: " + fb_err(d)}
    return {"ok": True, "id": mid, "url": "https://www.instagram.com/"}


# ===================== LỊCH CONTENT TỰ ĐỘNG (FB + IG) =====================
SCHED_FILE = os.path.join(GALLERY_DIR, "schedule.json")
_sched_lock = threading.Lock()


def sched_load():
    try:
        with open(SCHED_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def sched_save(items):
    try:
        os.makedirs(GALLERY_DIR, exist_ok=True)
        with open(SCHED_FILE, "w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False)
    except Exception:
        pass


def sched_process():
    """Đăng các bài tới hạn. Gọi định kỳ bởi luồng nền."""
    with _sched_lock:
        items = sched_load()
    now = time.time()
    due = [it for it in items if it.get("status") == "pending" and float(it.get("when", 0)) <= now]
    if not due:
        return
    for it in due:
        chans = it.get("channels") or ["fb"]
        urls = it.get("image_urls") or []
        msg = it.get("message") or ""
        res = {}
        if "fb" in chans:
            res["fb"] = fb_post_core(urls, msg)
        if "ig" in chans:
            res["ig"] = ig_post_core(urls, msg)
        ok = bool(res) and all(r.get("ok") for r in res.values())
        it["status"] = "posted" if ok else "error"
        it["result"] = {k: (v.get("url") if v.get("ok") else v.get("error")) for k, v in res.items()}
        it["posted_at"] = now
    # ghi lại, gộp theo id để không đè bài mới thêm trong lúc đăng
    with _sched_lock:
        cur = sched_load()
        byid = {x.get("id"): x for x in cur}
        for it in due:
            byid[it.get("id")] = it
        sched_save([v for v in byid.values() if v])


def _sched_loop():
    while True:
        try:
            sched_process()
        except Exception:
            pass
        try:
            autopost_tick()
        except Exception:
            pass
        time.sleep(60)


def start_scheduler():
    threading.Thread(target=_sched_loop, daemon=True).start()


# ============ PHI CÔNG TỰ ĐỘNG: mỗi ngày tự gen + đăng N bài random lên FB + IG ============
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "https://riengvnapp.cloud").rstrip("/")
AUTOPOST_FILE = os.path.join(GALLERY_DIR, "autopost.json")
AUTOPOST_DEFAULT = {"enabled": False, "per_day": 5, "channels": ["fb"], "start_hour": 8,
                    "end_hour": 22, "per_set": 4, "last_date": "", "done_today": 0, "next_at": 0, "log": []}
_autopost_running = [False]
_autopost_prod_cache = {"at": 0, "items": []}
# Mặc định KHỚP với ADS_BUILTIN_STYLES bên FB Ads (group/family dùng ảnh couple, flatlay = sofa)
_AUTOPOST_STYLE = {"couple": "style-couple-default.webp", "group": "style-couple-default.webp",
                   "family": "style-couple-default.webp", "flatlay2": "style-flatlay2.webp",
                   "flatlay3": "style-flatlay3.webp"}
CONCEPT_STYLE_FILE = os.path.join(GALLERY_DIR, "concept_styles.json")


def concept_style_override():
    """Style từng concept user tự đặt bên FB Ads (ghi đè mặc định). {key: dataURL/url}."""
    try:
        with open(CONCEPT_STYLE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def concept_style_save(key, img):
    if key not in _AUTOPOST_STYLE or not img:
        return False
    ov = concept_style_override()
    ov[key] = img
    try:
        os.makedirs(GALLERY_DIR, exist_ok=True)
        with open(CONCEPT_STYLE_FILE, "w", encoding="utf-8") as f:
            json.dump(ov, f, ensure_ascii=False)
        return True
    except Exception:
        return False


def autopost_load():
    try:
        with open(AUTOPOST_FILE, "r", encoding="utf-8") as f:
            return {**AUTOPOST_DEFAULT, **json.load(f)}
    except Exception:
        return dict(AUTOPOST_DEFAULT)


def autopost_save(cfg):
    try:
        os.makedirs(GALLERY_DIR, exist_ok=True)
        with open(AUTOPOST_FILE, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False)
    except Exception:
        pass


def autopost_products():
    if time.time() - _autopost_prod_cache["at"] < 3600 and _autopost_prod_cache["items"]:
        return _autopost_prod_cache["items"]
    if not shopify_configured():
        return []
    try:
        st, d = shopify_api("GET", "products.json?limit=50&status=active")
        out = []
        for p in (d.get("products") or []):
            img = (p.get("image") or {}).get("src") or ((p.get("images") or [{}])[0].get("src") if p.get("images") else "")
            if img:
                out.append({"title": p.get("title", ""), "image": img,
                            "store_url": ("https://rieng.vn/products/%s" % p.get("handle", "")) if p.get("handle") else ""})
        _autopost_prod_cache.update(at=time.time(), items=out)
        return out
    except Exception:
        return []


def _load_style_bytes(key):
    # ưu tiên style user tự đặt bên FB Ads
    ov = concept_style_override().get(key)
    if ov:
        try:
            b, _ = fetch_image_bytes(ov)
            if b:
                return b
        except Exception:
            pass
    try:
        with open(os.path.join(ROOT, "public", _AUTOPOST_STYLE.get(key, "")), "rb") as f:
            return f.read()
    except Exception:
        return None


def autopost_gen_set(design_img, key, per_set):
    asp = "3:4"; size = ASPECT_TO_SIZE.get(asp, "1024x1536")
    old_name = ads_read_name(design_img[0])
    nm = None
    if key == "couple":
        nm = ads_couple_names(); names = [nm["female"], nm["male"]]
    elif key in ADS_CONCEPT_N:
        names = ads_n_names(ADS_CONCEPT_N[key])
    else:
        names = ads_n_names(1)
    imgs = [design_img]; img_n = None
    ref = _load_style_bytes(key)
    if ref:
        imgs.append((ref, "image/png")); img_n = 2
    hints = _FBPOST_FLAT_SHOTS if key.startswith("flatlay") else _FBPOST_SHOTS
    label = "FB Post · %s" % ADS_CONCEPTS[key][0]
    urls = []
    for i in range(max(1, min(6, per_set))):
        v = "Shot %d of a matching set — %s. " % (i + 1, hints[i % len(hints)])
        prompt = fbpost_prompt(key, names, nm, img_n, "", old_name, v)
        b64 = gen_shot(imgs, prompt, size, "openai", asp, lock=False, quality="medium")
        if HAS_PIL:
            try:
                b64 = base64.b64encode(crop_to_aspect(base64.b64decode(b64), asp)).decode()
            except Exception:
                pass
        b64 = strip_ai_meta_b64(b64)
        g = gallery_add(b64, {"mode": "fbpost", "prompt": label})
        u = g.get("url")
        if u:
            urls.append(u if str(u).startswith("http") else PUBLIC_BASE_URL + u)
    return urls


def autopost_run_one(cfg):
    prods = autopost_products()
    if not prods:
        return False, "Không có sản phẩm Shopify active."
    p = random.choice(prods)
    key = random.choice(list(_AUTOPOST_STYLE.keys()))    # concept random
    dd, dm = fetch_image_bytes(p["image"])
    if not dd:
        return False, "Không tải được ảnh SP."
    try:
        urls = autopost_gen_set((dd, dm or "image/png"), key, int(cfg.get("per_set", 4)))
    except Exception as e:
        return False, "Gen lỗi: %s" % str(e)[:80]
    if not urls:
        return False, "Gen không ra ảnh."
    cap = "🔥 Áo thun in tên cá nhân hoá theo tên riêng — chất vải đẹp, in sắc nét.\n👉 Đặt ngay tại rieng.vn!"
    try:
        c = product_content(dd, "Áo thun in tên cá nhân hoá, thương hiệu rieng.vn. %s" % p.get("title", ""))
        if (c.get("facebook") or "").strip():
            cap = c["facebook"].strip()
    except Exception:
        pass
    lk = p.get("store_url") or ""
    if lk and lk not in cap:
        cap += "\n\n🛒 MUA NGAY: " + lk
    chans = cfg.get("channels") or ["fb"]
    # GHI vào Bảng bài FB/IG (📋) để thấy được trên trang tự động đăng
    pid = hashlib.md5(("auto%s%s" % (time.time(), urls[0])).encode()).hexdigest()[:12]
    with _pgpost_lock:
        items = pgpost_load()
        items.insert(0, {"id": pid, "caption": cap, "product": p.get("title", ""),
                         "image_urls": urls, "status": "posting", "source": "auto",
                         "created": time.time()})
        pgpost_save(items)
    res = {}
    if "fb" in chans:
        res["fb"] = fb_post_core(urls, cap)
    if "ig" in chans:
        res["ig"] = ig_post_core(urls, cap)
    ok = bool(res) and all(r.get("ok") for r in res.values())
    _pgpost_set(pid, status=("posted" if ok else "error"),
                result={k: (v.get("url") if v.get("ok") else v.get("error")) for k, v in res.items()})
    detail = "%s · %s" % (ADS_CONCEPTS[key][0], (p.get("title") or "")[:24])
    if not ok:
        detail += " — " + "; ".join((r.get("error") or "")[:40] for r in res.values() if not r.get("ok"))
    return ok, detail


def _autopost_do():
    try:
        ok, msg = autopost_run_one(autopost_load())
        cfg = autopost_load()
        cfg["done_today"] = int(cfg.get("done_today", 0)) + 1
        per_day = max(1, int(cfg.get("per_day", 5)))
        span = max(1, int(cfg.get("end_hour", 22)) - int(cfg.get("start_hour", 8))) * 3600
        cfg["next_at"] = time.time() + max(1200, int(span / per_day))
        log = cfg.get("log", [])
        log.append(("✓ " if ok else "✗ ") + time.strftime("%H:%M", time.localtime()) + " " + (msg or ""))
        cfg["log"] = log[-15:]
        autopost_save(cfg)
    except Exception:
        pass
    finally:
        _autopost_running[0] = False


def autopost_tick():
    cfg = autopost_load()
    if not cfg.get("enabled") or _autopost_running[0]:
        return
    now = time.time()
    day = time.strftime("%Y-%m-%d", time.localtime(now))
    if cfg.get("last_date") != day:
        cfg["last_date"] = day; cfg["done_today"] = 0
        lt = time.localtime(now)
        start_ts = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, int(cfg.get("start_hour", 8)), 0, 0, 0, 0, -1))
        cfg["next_at"] = max(now, start_ts)
        autopost_save(cfg)
    if int(cfg.get("done_today", 0)) >= int(cfg.get("per_day", 5)):
        return
    if now < float(cfg.get("next_at", 0)):
        return
    _autopost_running[0] = True
    threading.Thread(target=_autopost_do, daemon=True).start()


# ============================ TRỢ LÝ AI — điều khiển tool bằng lệnh ============================
# Plan -> user duyệt -> executor chạy từng action (gọi các hàm có sẵn).
AGENT_ACTIONS = {
    "gen_design":    "Tạo design áo mới từ theme/chủ đề. params: {theme, n, text, extra}",
    "gen_ads":       "Tạo ảnh quảng cáo FB từ DESIGN SẠCH của user. MẶC ĐỊNH dùng design sạch gần nhất trong kho (params.count = số design). Chỉ khi user nói RÕ 'dùng sản phẩm' thì mới dùng ảnh SP Shopify (params.products = số SP hoặc 'all'). KHÔNG cần gen_design trước. params: {concept: couple|group|family|flatlay2|flatlay3, prompt, aspect: 1:1|4:5|3:4, bg, count, products}. Tự chọn concept + prompt creative.",
    "push_fb_ads":   "Đẩy ads lên FB Ads (tạo campaign+nhóm+ad). params: {daily_budget, active, link, campaign_name}",
    "gen_fbpost":    "Tạo bộ ảnh FB Post từ design/sản phẩm. params: {per_set}",
    "post_fbig":     "Đăng ảnh lên Fanpage/Instagram. params: {channels, caption}",
    "analyze_fb":    "Phân tích FB Ads account: chi tiêu/CTR/CPC → ĐÁNH GIÁ + LỜI KHUYÊN chiến lược. params: {range}",
    "scale_ads":     "Scale ngân sách chiến dịch đang hiệu quả (CTR > min_ctr). params: {range, factor, min_ctr}",
    "ads_optimize":  "Bật/tắt/dừng ads theo hiệu suất. params: {range, action: report|pause_low|activate_all}",
    "write_content": "Claude viết content/caption cho sản phẩm đã chọn (FB post, ads, campaign). params: {type, tone}",
}
AGENT_RUN = {"running": False, "cur": 0, "total": 0, "steps": [], "log": [], "done": False}

# System prompt cho Claude làm planner — giải thích ngữ cảnh đầy đủ
_AGENT_SYSTEM = """Bạn là não điều khiển (AI orchestrator) của công cụ thiết kế áo thun cá nhân hoá rieng.vn (Việt Nam).
Tool đã tích hợp sẵn: gen design AI, tạo ảnh quảng cáo FB, đẩy lên FB Ads/Fanpage/Instagram, phân tích hiệu suất.

Sản phẩm hiện tại (nếu có): {product_ctx}

Danh sách hành động CÓ THỂ DÙNG (chỉ dùng các action này):
{actions}

Nguyên tắc lập kế hoạch:
- Chọn & sắp xếp các action theo lệnh, chuỗi logic (ví dụ gen_design → gen_ads → push_fb_ads).
- Bước tiêu tiền hoặc đăng công khai (push_fb_ads, post_fbig): mặc định daily_budget=50000, active=false.
- Lấy link sản phẩm từ ngữ cảnh nếu có, không tự đặt.
- Nếu lệnh phân tích/đánh giá → analyze_fb trước, rồi scale_ads/ads_optimize nếu phù hợp.
- Viết content cho SP → write_content TRƯỚC gen_fbpost.
- Trả về ĐÚNG định dạng JSON sau, không giải thích thêm:
{{"summary":"<1 dòng tiếng Việt tóm tắt kế hoạch>","steps":[{{"action":"<key>","label":"<mô tả tiếng Việt>","params":{{...}}}}]}}"""


def agent_plan(command, product_ctx=""):
    """Claude (ưu tiên) / gpt-4o (fallback) đọc lệnh -> kế hoạch JSON."""
    acts = "\n".join("- %s: %s" % (k, v) for k, v in AGENT_ACTIONS.items())
    sys_prompt = _AGENT_SYSTEM.format(product_ctx=product_ctx or "chưa chọn sản phẩm", actions=acts)
    raw = None
    # ── ưu tiên Claude (hiểu ngữ cảnh phức tạp hơn) ──
    if ANTHROPIC_API_KEY:
        try:
            raw = claude_text(sys_prompt,
                              command + "\n\nChỉ trả JSON thuần (không markdown, không giải thích).",
                              max_tokens=1200)
        except Exception:
            raw = None
    # ── fallback OpenAI ──
    if not raw:
        if not API_KEY:
            return {"error": "Chưa cấu hình ANTHROPIC_API_KEY hoặc OPENAI_API_KEY."}
        try:
            raw = openai_chat([{"role": "system", "content": sys_prompt},
                               {"role": "user", "content": command}],
                              json_mode=True, max_tokens=1200, model=BEST_TEXT_MODEL)
        except Exception as e:
            return {"error": "Lập kế hoạch lỗi: %s" % str(e)[:120]}
    try:
        # Claude đôi khi bọc ```json ... ``` — strip ra
        txt = raw.strip()
        if txt.startswith("```"):
            txt = txt.split("```")[-2] if "```" in txt[3:] else txt
            txt = txt.lstrip("`").lstrip("json").strip()
        d = json.loads(txt)
        steps = [s for s in (d.get("steps") or []) if s.get("action") in AGENT_ACTIONS]
        planner = "Claude %s" % ANTHROPIC_MODEL if ANTHROPIC_API_KEY else "gpt-4o"
        return {"summary": (d.get("summary") or "").strip(), "steps": steps, "planner": planner}
    except Exception as e:
        return {"error": "Parse JSON lỗi: %s | raw: %s" % (str(e)[:80], (raw or "")[:120])}


def _strip_json_fence(txt):
    txt = (txt or "").strip()
    if txt.startswith("```"):
        txt = txt.split("```")[-2] if "```" in txt[3:] else txt
        txt = txt.lstrip("`")
        if txt.lower().startswith("json"):
            txt = txt[4:]
    return txt.strip()


_AGENT_FB_KW = ("ads", "quảng cáo", "quang cao", "chiến dịch", "chien dich", "hiệu suất",
                "hieu suat", "ctr", "cpc", "ngân sách", "ngan sach", "chi tiêu", "chi tieu",
                "campaign", "roas", "doanh thu", "quảng", "facebook ads")

_AGENT_CHAT_SYSTEM = """Bạn là Trợ lý AI của rieng.vn — thương hiệu áo thun in tên cá nhân hoá (Việt Nam).
Tool có sẵn: tạo design AI, tạo ảnh quảng cáo, đẩy FB Ads, đăng Fanpage/Instagram, phân tích hiệu suất.

Sản phẩm đang chọn (nếu có): {product_ctx}

Người dùng có thể: (A) HỎI / cần PHÂN TÍCH / cần LỜI KHUYÊN, hoặc (B) RA LỆNH làm việc.

QUY TẮC PHÂN LOẠI:
- Nếu là câu hỏi, nhờ giải thích, phân tích số liệu, xin tư vấn/chiến lược, trò chuyện
  → trả {{"mode":"answer","text":"<câu trả lời tiếng Việt hữu ích, cụ thể, dùng dữ liệu được cung cấp nếu có>"}}.
  TUYỆT ĐỐI không lập kế hoạch, không thực thi gì.
- Nếu là LỆNH muốn tool LÀM việc (tạo design, làm ảnh ads, đăng bài, đẩy ads, scale, dừng ads...)
  → trả {{"mode":"plan","summary":"<1 dòng>","steps":[{{"action":"<key>","label":"<mô tả VN>","params":{{...}}}}]}}.
  CHỈ lập kế hoạch — KHÔNG tự chạy (người dùng sẽ bấm Duyệt / gõ 'chạy đi').

Các action dùng cho mode=plan (chỉ dùng key trong list):
{actions}
Lưu ý: bước tiêu tiền/đăng công khai (push_fb_ads, post_fbig) mặc định daily_budget=50000, active=false.

Chỉ trả JSON thuần (không markdown, không giải thích ngoài JSON)."""


def agent_chat(message, product_ctx="", history=None, image=None):
    """Phân loại: trả lời (answer) hoặc lập kế hoạch (plan). Không thực thi.
    image: dataURL/url ảnh user gửi để AI XEM (vision)."""
    acts = "\n".join("- %s: %s" % (k, v) for k, v in AGENT_ACTIONS.items())
    sys_prompt = _AGENT_CHAT_SYSTEM.format(product_ctx=product_ctx or "chưa chọn sản phẩm", actions=acts)
    img_bytes = None
    if image:
        try:
            img_bytes, _ = fetch_image_bytes(image)
        except Exception:
            img_bytes = None
    if img_bytes:
        message = (message or "").strip() or "Xem ảnh này giúp mình (phân tích / nhận xét)."
        message = "[Người dùng có GỬI KÈM 1 ẢNH — hãy nhìn ảnh để trả lời] " + message
    # Nếu câu hỏi liên quan ads → lấy sẵn dữ liệu để AI phân tích chính xác
    fb_ctx = ""
    low = message.lower()
    if any(k in low for k in _AGENT_FB_KW) and fb_configured():
        try:
            data = fb_ads_data_text("last_7d")
            if data:
                fb_ctx = "\n\n[Dữ liệu FB Ads 7 ngày gần nhất để bạn phân tích]:\n" + data
        except Exception:
            pass
    # Ghép lịch sử hội thoại ngắn (để AI nhớ ngữ cảnh)
    hist_txt = ""
    for h in (history or [])[-6:]:
        role = "Người dùng" if h.get("role") == "user" else "Trợ lý"
        hist_txt += "%s: %s\n" % (role, (h.get("text") or "")[:300])
    user_msg = (hist_txt + "\nNgười dùng: " + message if hist_txt else message) + fb_ctx + \
               "\n\n(Trả JSON đúng định dạng đã hướng dẫn.)"
    raw, planner = None, None
    if ANTHROPIC_API_KEY:
        try:
            if img_bytes:
                raw = claude_vision(sys_prompt, user_msg, img_bytes, max_tokens=1500)
            else:
                raw = claude_text(sys_prompt, user_msg, max_tokens=1500)
            planner = "Claude %s" % ANTHROPIC_MODEL
        except Exception:
            raw = None
    if not raw:
        if not API_KEY:
            return {"error": "Chưa cấu hình ANTHROPIC_API_KEY hoặc OPENAI_API_KEY."}
        try:
            if img_bytes:
                b64 = base64.b64encode(img_bytes).decode()
                user_content = [{"type": "text", "text": user_msg},
                                {"type": "image_url", "image_url": {"url": "data:image/png;base64," + b64}}]
            else:
                user_content = user_msg
            raw = openai_chat([{"role": "system", "content": sys_prompt},
                               {"role": "user", "content": user_content}],
                              json_mode=True, max_tokens=1500, model=BEST_TEXT_MODEL)
            planner = "gpt-4o" + (" (Claude lỗi)" if ANTHROPIC_API_KEY else "")
        except Exception as e:
            return {"error": "AI lỗi: %s" % str(e)[:120]}
    try:
        d = json.loads(_strip_json_fence(raw))
    except Exception:
        # AI trả text thuần (không phải JSON) → coi như câu trả lời
        return {"mode": "answer", "text": raw.strip(), "planner": planner}
    if d.get("mode") == "plan":
        steps = [s for s in (d.get("steps") or []) if s.get("action") in AGENT_ACTIONS]
        if not steps:
            return {"mode": "answer", "text": (d.get("summary") or d.get("text") or "Mình chưa rõ ý, bạn nói cụ thể hơn nhé."), "planner": planner}
        return {"mode": "plan", "summary": (d.get("summary") or "").strip(), "steps": steps, "planner": planner}
    return {"mode": "answer", "text": (d.get("text") or d.get("answer") or "").strip() or "Mình chưa rõ, bạn hỏi lại nhé.", "planner": planner}


def _ag_gen_design(p, ctx):
    n = max(1, min(int(p.get("n", 3) or 3), 6))
    theme = (p.get("theme") or p.get("prompt") or "Custom name T-shirt").strip()
    cons = design_concepts_auto(theme, (p.get("text") or "").strip(), n)
    extra = (p.get("extra") or "").strip()
    out = []
    for c in cons[:n]:
        pr = c.get("prompt", "")
        if extra:
            pr += " " + extra
        b64 = openai_generate(pr, "1024x1024")
        if HAS_PIL:
            b64 = strip_bg_strong_b64(b64)
        b64 = strip_ai_meta_b64(b64)
        g = gallery_add(b64, {"mode": "design", "prompt": theme})
        out.append({"b64": b64, "url": g.get("url")})
    ctx["designs"] = out
    return "Đã tạo %d design (%s)." % (len(out), theme)


def _ag_gen_ads(p, ctx):
    # NGUỒN ưu tiên DESIGN SẠCH (artwork) của user — KHÔNG dùng ảnh SP mockup làm nguồn
    # (mockup ra design trơn linh tinh). Mỗi nguồn = (bytes, link, title).
    sources = []
    pr_param = p.get("products")
    if pr_param:   # CHỈ khi user nói RÕ "dùng sản phẩm" -> ảnh SP làm nguồn
        lim = 20 if str(pr_param).lower() in ("all", "tất cả", "het", "hết") else max(1, min(int(pr_param or 3), 20))
        for pr in recent_products(lim):
            sources.append((pr["img"], pr["link"], pr["title"]))
    if not sources and ctx.get("designs"):   # design vừa tạo trong phiên
        for d in ctx["designs"]:
            sources.append((base64.b64decode(d["b64"]), "", ""))
    if not sources and ctx.get("product") and ctx["product"].get("image"):   # SP user CHỌN
        ib, _ = fetch_image_bytes(ctx["product"]["image"])
        if ib:
            sources.append((ib, ctx.get("product_link", ""), ctx["product"].get("name", "")))
    if not sources:   # MẶC ĐỊNH: DESIGN SẠCH gần nhất trong kho (đúng design của user)
        cnt = max(1, min(int(p.get("count", 1) or 1), 6))
        for b in recent_design_bytes(cnt):
            sources.append((b, "", ""))
    if not sources:
        return "Chưa có sản phẩm/design nào — hãy thêm SP Shopify hoặc tạo design trước."

    key = p.get("concept") if p.get("concept") in ADS_CONCEPTS else "flatlay3"
    ref = _load_style_bytes(key)
    cp = (p.get("prompt") or "").strip()
    aspect = p.get("aspect") if p.get("aspect") in ("1:1", "4:5", "3:4", "9:16") else "1:1"
    ad_images = []
    for (img, link, title) in sources:
        cons = [{"key": key, "ref": ref, "bg": (p.get("bg") or "").strip(), "custom_prompt": cp[:4000]}]
        with _batch_lock:
            _batch_seq[0] += 1
            sj = "agads_%d" % _batch_seq[0]
            BATCH_JOBS[sj] = {"total": 1, "done": 0, "items": [], "errors": [], "finished": False}
        run_ads_job(sj, (img, "image/png"), cons, title or "Áo Thun In Tên",
                    "Cá nhân hoá theo tên riêng", "openai", aspect, quality="high")
        for it in BATCH_JOBS.get(sj, {}).get("items", []):
            ad_images.append({"b64": it.get("image"), "url": (it.get("gallery") or {}).get("url"),
                              "link": link, "title": title})
    ctx["ad_images"] = ad_images
    return "Đã tạo %d ảnh ads (concept %s, %d nguồn%s)." % (len(ad_images), key, len(sources), ", có prompt riêng" if cp else "")


def _ag_push_fb_ads(p, ctx):
    if not ctx.get("ad_images"):
        return "Chưa có ảnh ads — bỏ qua."
    status = "ACTIVE" if p.get("active") else "PAUSED"
    budget = p.get("daily_budget") or 50000
    deflink = p.get("link") or ctx.get("product_link") or "https://rieng.vn"
    ok = 0
    for it in ctx["ad_images"]:
        img = base64.b64decode(it["b64"]) if it.get("b64") else None
        link = it.get("link") or deflink   # mỗi ảnh dùng ĐÚNG link SP của nó
        headline = it.get("title") or "Áo Thun In Tên"
        r = fb_ads_push_core(img, link, "Áo thun in tên cá nhân hoá.", headline,
                             headline, budget, 18, 55, [], ["VN"], "SHOP_NOW", status=status)
        if r.get("ok"):
            ok += 1
    return "Đã đẩy %d ad lên FB Ads (%s)." % (ok, "CHẠY" if status == "ACTIVE" else "TẠM DỪNG")


def _ag_gen_fbpost(p, ctx):
    if ctx.get("designs"):
        dd = base64.b64decode(ctx["designs"][0]["b64"])
    elif ctx.get("product") and ctx["product"].get("image"):
        dd, _ = fetch_image_bytes(ctx["product"]["image"])
    else:
        recent = recent_design_bytes(1)
        dd = recent[0] if recent else None
    if not dd:
        return "Chưa có design và kho cũng trống — hãy tạo design trước."
    per_set = max(1, min(int(p.get("per_set", 4) or 4), 5))
    cons = [{"key": "flatlay3", "ref": _load_style_bytes("flatlay3"), "bg": ""}]
    with _batch_lock:
        _batch_seq[0] += 1
        sj = "agfbp_%d" % _batch_seq[0]
        BATCH_JOBS[sj] = {"total": 1, "done": 0, "items": [], "errors": [], "finished": False}
    run_fbpost_job(sj, (dd, "image/png"), cons, "openai", "3:4", "medium", per_set)
    items = BATCH_JOBS.get(sj, {}).get("items", [])
    pics = items[0].get("pics", []) if items else []
    ctx["post_urls"] = [PUBLIC_BASE_URL + p2["url"] if not str(p2.get("url", "")).startswith("http") else p2["url"] for p2 in pics if p2.get("url")]
    return "Đã tạo bộ %d ảnh FB Post." % len(ctx["post_urls"])


def _ag_post_fbig(p, ctx):
    urls = ctx.get("post_urls") or []
    if not urls:
        return "Chưa có ảnh để đăng — bỏ qua."
    cap = p.get("caption") or "Áo thun in tên cá nhân hoá theo tên riêng.\n🛒 rieng.vn"
    chans = [c for c in (p.get("channels") or ["fb"]) if c in ("fb", "ig")] or ["fb"]
    res = []
    if "fb" in chans:
        res.append("FB " + ("✓" if fb_post_core(urls, cap).get("ok") else "✗"))
    if "ig" in chans:
        res.append("IG " + ("✓" if ig_post_core(urls, cap).get("ok") else "✗"))
    return "Đăng: " + " · ".join(res)


def _ag_ads_optimize(p, ctx):
    if not fb_configured():
        return "Chưa cấu hình FB."
    rng = p.get("range") or "last_7d"
    action = p.get("action") or "report"
    fields = "id,name,status,insights.date_preset(%s){spend,clicks,ctr,cpc}" % rng
    st, d = fb_graph("GET", "act_%s/campaigns" % FB_AD_ACCOUNT_ID, {"fields": fields, "limit": "50"})
    cs = d.get("data") or []
    lines = []
    for c in cs[:10]:
        ins = ((c.get("insights") or {}).get("data") or [{}])[0]
        ctr = float(ins.get("ctr") or 0)
        lines.append("%s: chi %s₫ | click %s | CTR %.2f%% | CPC %s₫ [%s]" % (
            (c.get("name") or "")[:22], ins.get("spend", "0"), ins.get("clicks", "0"),
            ctr, ins.get("cpc", "0"), c.get("status", "")))
        if action == "pause_low" and ctr < 0.5 and c.get("status") == "ACTIVE":
            fb_graph("POST", c["id"], {"status": "PAUSED"})
            lines[-1] += " → ĐÃ DỪNG"
        elif action == "activate_all" and c.get("status") == "PAUSED":
            fb_graph("POST", c["id"], {"status": "ACTIVE"})
            lines[-1] += " → ĐÃ BẬT"
    return "Báo cáo %d chiến dịch:\n" % len(cs) + "\n".join(lines)


def fb_ads_data_text(rng="last_7d", limit=12):
    """Trả về text tóm tắt dữ liệu các chiến dịch FB Ads (dùng cho analyze + chat)."""
    if not fb_configured():
        return ""
    fields = "id,name,status,insights.date_preset(%s){spend,impressions,clicks,ctr,cpc,reach,frequency,actions}" % rng
    st, d = fb_graph("GET", "act_%s/campaigns" % FB_AD_ACCOUNT_ID, {"fields": fields, "limit": "30"})
    cs = d.get("data") or []
    rows = []
    for c in cs[:limit]:
        ins = ((c.get("insights") or {}).get("data") or [{}])[0]
        acts_d = {a.get("action_type"): a.get("value") for a in (ins.get("actions") or [])}
        rows.append("- %s [%s]: chi %s₫ | reach %s | CTR %.2f%% | CPC %s₫ | purchase %s" % (
            (c.get("name") or "")[:28], c.get("status", ""),
            ins.get("spend", "0"), ins.get("reach", "0"),
            float(ins.get("ctr") or 0), ins.get("cpc", "0"),
            acts_d.get("purchase") or acts_d.get("offsite_conversion.fb_pixel_purchase") or "0"))
    return "\n".join(rows)


def _ag_analyze_fb(p, ctx):
    """Lấy dữ liệu FB Ads → Claude phân tích & cho lời khuyên."""
    if not fb_configured():
        return "Chưa cấu hình FB Ads."
    rng = p.get("range") or "last_7d"
    data_txt = fb_ads_data_text(rng)
    if not data_txt:
        return "Không có dữ liệu chiến dịch trong %s." % rng
    if not ANTHROPIC_API_KEY and not API_KEY:
        return "Dữ liệu:\n" + data_txt
    sys_a = ("Bạn là chuyên gia FB Ads cho thương hiệu áo thun in tên rieng.vn (Việt Nam). "
             "Phân tích dữ liệu chiến dịch, đánh giá hiệu suất, chỉ ra điểm mạnh/yếu, "
             "và đưa ra ít nhất 3 lời khuyên cụ thể (scale cái nào, dừng cái nào, thay creative, "
             "tối ưu targeting, thử gì tiếp). Tiếng Việt, ngắn gọn, thực tế.")
    user_a = "Dữ liệu FB Ads (%s):\n%s\n\nPhân tích + lời khuyên?" % (rng, data_txt)
    try:
        advice = claude_text(sys_a, user_a, max_tokens=800) if ANTHROPIC_API_KEY else \
                 openai_chat([{"role": "system", "content": sys_a}, {"role": "user", "content": user_a}],
                             max_tokens=800, model=BEST_TEXT_MODEL)
        ctx["fb_analysis"] = advice
        return "📊 PHÂN TÍCH FB ADS:\n\n%s" % advice
    except Exception as e:
        return "Dữ liệu:\n" + data_txt + "\n\n(AI phân tích lỗi: %s)" % str(e)[:60]


def _ag_scale_ads(p, ctx):
    """Scale ngân sách các chiến dịch có CTR > min_ctr."""
    if not fb_configured():
        return "Chưa cấu hình FB Ads."
    rng = p.get("range") or "last_7d"
    factor = float(p.get("factor") or 1.5)
    min_ctr = float(p.get("min_ctr") or 1.0)
    fields = "id,name,status,daily_budget,insights.date_preset(%s){ctr}" % rng
    st, d = fb_graph("GET", "act_%s/campaigns" % FB_AD_ACCOUNT_ID, {"fields": fields, "limit": "30"})
    scaled, skipped = [], []
    for c in (d.get("data") or []):
        ins = ((c.get("insights") or {}).get("data") or [{}])[0]
        ctr = float(ins.get("ctr") or 0)
        bud = int(c.get("daily_budget") or 0)
        name = (c.get("name") or "")[:25]
        if ctr >= min_ctr and c.get("status") == "ACTIVE" and bud > 0:
            new_bud = int(bud * factor)
            r2, _ = fb_graph("POST", c["id"], {"daily_budget": str(new_bud)})
            if r2 == 200:
                scaled.append("%s: %d₫ → %d₫ (CTR %.2f%%)" % (name, bud, new_bud, ctr))
            else:
                skipped.append("%s: lỗi cập nhật" % name)
        else:
            skipped.append("%s: CTR %.2f%% < %.1f%% hoặc không ACTIVE" % (name, ctr, min_ctr))
    result = "Scale x%.1f (CTR ≥ %.1f%%):\n" % (factor, min_ctr)
    if scaled:
        result += "✓ " + "\n✓ ".join(scaled)
    if skipped:
        result += "\n— " + "\n— ".join(skipped)
    return result or "Không có chiến dịch đủ điều kiện."


def _ag_write_content(p, ctx):
    """Claude viết content/caption cho sản phẩm."""
    prod = ctx.get("product") or {}
    name = prod.get("name") or p.get("product_name") or "áo thun in tên"
    link = prod.get("link") or ctx.get("product_link") or "https://rieng.vn"
    price = prod.get("price") or prod.get("variants", [{}])[0].get("price") if prod.get("variants") else ""
    content_type = p.get("type") or "fb_post"
    tone = p.get("tone") or "vui tươi, gần gũi Gen-Z Việt Nam"
    sys_c = ("Bạn là copywriter cho rieng.vn — áo thun in tên cá nhân hoá. "
             "Viết content theo yêu cầu, tone: %s, tiếng Việt, ngắn gọn, emoji phù hợp. "
             "Thêm CTA 'Mua ngay' kèm link sản phẩm." % tone)
    user_c = ("Sản phẩm: %s. Giá: %s. Link: %s.\nViết %s cho bài đăng FB/IG (200-300 chữ)." %
              (name, price or "liên hệ", link, content_type))
    try:
        txt = claude_text(sys_c, user_c, 600) if ANTHROPIC_API_KEY else \
              openai_chat([{"role": "system", "content": sys_c}, {"role": "user", "content": user_c}],
                          max_tokens=600, model=BEST_TEXT_MODEL)
        ctx["written_caption"] = txt
        return "✍️ Content:\n%s" % txt
    except Exception as e:
        return "Lỗi viết content: %s" % str(e)[:80]


_AGENT_DISPATCH = {
    "gen_design":    _ag_gen_design,
    "gen_ads":       _ag_gen_ads,
    "push_fb_ads":   _ag_push_fb_ads,
    "gen_fbpost":    _ag_gen_fbpost,
    "post_fbig":     _ag_post_fbig,
    "ads_optimize":  _ag_ads_optimize,
    "analyze_fb":    _ag_analyze_fb,
    "scale_ads":     _ag_scale_ads,
    "write_content": _ag_write_content,
}


def _agent_worker(steps, product=None):
    AGENT_RUN.update(running=True, cur=0, total=len(steps), log=[], done=False)
    ctx = {}
    if product:
        ctx["product"] = product
        ctx["product_link"] = product.get("link") or ("https://rieng.vn/products/%s" % product.get("handle", ""))
    for i, s in enumerate(steps):
        AGENT_RUN["cur"] = i + 1
        fn = _AGENT_DISPATCH.get(s.get("action"))
        label = s.get("label") or s.get("action")
        try:
            msg = fn(s.get("params") or {}, ctx) if fn else "Bỏ qua (không rõ action)."
            AGENT_RUN["log"].append(("✓ %s — %s" % (label, msg))[:400])
        except Exception as e:
            AGENT_RUN["log"].append("✗ %s — lỗi: %s" % (label, str(e)[:100]))
    AGENT_RUN.update(running=False, done=True)


def agent_run_start(steps, product=None):
    if AGENT_RUN["running"]:
        return False
    threading.Thread(target=_agent_worker, args=(steps, product), daemon=True).start()
    return True


# ===================== ĐẨY 1 ẢNH -> FB ADS (core dùng lại cho batch) =====================
def fb_ads_push_core(img, link, message, headline, name, daily_budget, age_min, age_max,
                     genders, countries, cta, campaign_id="", adset_id="",
                     campaign_name="", adset_name="", status="PAUSED"):
    """Tạo Campaign/AdSet/Creative/Ad. status=ACTIVE để CHẠY NGAY (tiêu tiền) hoặc PAUSED.
    Trả {ok, ad_id, campaign_id, adset_id, manager_url|error}."""
    status = "ACTIVE" if str(status).upper() == "ACTIVE" else "PAUSED"
    if not fb_configured():
        return {"ok": False, "error": "Chưa cấu hình Facebook Ads."}
    if not img:
        return {"ok": False, "error": "Thiếu ảnh ads."}
    link = (link or "").strip()
    if not link:
        return {"ok": False, "error": "Thiếu link đích."}
    if not link.startswith("http"):
        link = "https://" + link
    message = (message or "").strip() or "Áo thun in tên cá nhân hoá theo tên riêng."
    headline = (headline or "").strip() or "Áo Thun In Tên"
    adname = "[AI] " + ((name or "").strip() or headline)[:60]
    try:
        budget = max(1, int(float(daily_budget or 50000)))
    except Exception:
        budget = 50000
    try:
        age_min = min(65, max(13, int(age_min or 18)))
        age_max = min(65, max(age_min, int(age_max or 55)))
    except Exception:
        age_min, age_max = 18, 55
    genders = genders or []
    countries = countries or ["VN"]
    cta = (cta or "SHOP_NOW").strip()
    campaign_id = (campaign_id or "").strip()
    adset_id = (adset_id or "").strip()
    campaign_name = (campaign_name or "").strip() or adname
    adset_name = (adset_name or "").strip() or adname
    try:
        image_hash = fb_upload_adimage(img)
        if not campaign_id:
            st, c = fb_graph("POST", "act_%s/campaigns" % FB_AD_ACCOUNT_ID,
                             {"name": campaign_name, "objective": "OUTCOME_TRAFFIC",
                              "special_ad_categories": "[]",
                              "is_adset_budget_sharing_enabled": "false", "status": status})
            if st != 200:
                raise RuntimeError("Tạo campaign lỗi: " + fb_err(c))
            campaign_id = c["id"]
        cid = campaign_id
        if not adset_id:
            targeting = {"geo_locations": {"countries": countries}, "age_min": age_min,
                         "age_max": age_max, "targeting_automation": {"advantage_audience": 0}}
            if genders:
                targeting["genders"] = genders
            st, a = fb_graph("POST", "act_%s/adsets" % FB_AD_ACCOUNT_ID,
                             {"name": adset_name, "campaign_id": cid, "daily_budget": budget,
                              "billing_event": "IMPRESSIONS", "optimization_goal": "LINK_CLICKS",
                              "bid_strategy": "LOWEST_COST_WITHOUT_CAP",
                              "targeting": json.dumps(targeting), "status": status})
            if st != 200:
                raise RuntimeError("Tạo ad set lỗi: " + fb_err(a))
            adset_id = a["id"]
        aid = adset_id
        story = {"page_id": FB_PAGE_ID, "link_data": {
            "image_hash": image_hash, "link": link, "message": message, "name": headline,
            "call_to_action": {"type": cta, "value": {"link": link}}}}
        st, cr = fb_graph("POST", "act_%s/adcreatives" % FB_AD_ACCOUNT_ID,
                          {"name": adname, "object_story_spec": json.dumps(story)})
        if st != 200:
            raise RuntimeError("Tạo creative lỗi: " + fb_err(cr))
        st, ad = fb_graph("POST", "act_%s/ads" % FB_AD_ACCOUNT_ID,
                          {"name": adname, "adset_id": aid,
                           "creative": json.dumps({"creative_id": cr["id"]}), "status": status})
        if st != 200:
            raise RuntimeError("Tạo ad lỗi: " + fb_err(ad))
    except Exception as e:
        return {"ok": False, "error": str(e)}
    mgr = ("https://www.facebook.com/adsmanager/manage/campaigns?act=%s&selected_campaign_ids=%s"
           % (FB_AD_ACCOUNT_ID, cid))
    return {"ok": True, "campaign_id": cid, "adset_id": aid, "ad_id": ad["id"], "manager_url": mgr}


# ===================== TẠO ADS TỪ BÀI VIẾT FANPAGE CÓ SẴN (boost post) =====================
def fb_page_posts(limit=12):
    """Liệt kê bài đã đăng trên Fanpage (để tạo ads từ bài có sẵn)."""
    if not fb_configured():
        return {"error": "Chưa cấu hình Facebook (token + page + ad account)."}
    fields = "id,message,full_picture,created_time,permalink_url"
    st, d = fb_graph("GET", "%s/published_posts" % FB_PAGE_ID, {"fields": fields, "limit": str(min(50, max(1, limit)))})
    if st != 200:
        st, d = fb_graph("GET", "%s/posts" % FB_PAGE_ID, {"fields": fields, "limit": str(min(50, max(1, limit)))})
    if st != 200:
        return {"error": fb_err(d)}
    posts = []
    for p in (d.get("data") or []):
        posts.append({"id": p.get("id"), "message": (p.get("message") or "")[:300],
                      "image": p.get("full_picture", ""), "created": p.get("created_time", ""),
                      "permalink": p.get("permalink_url", "")})
    return {"posts": posts}


def fb_ads_push_post(post_id, daily_budget=50000, age_min=18, age_max=55, genders=None,
                     countries=None, campaign_id="", adset_id="", status="PAUSED", name=""):
    """Tạo Campaign/AdSet/Creative/Ad từ 1 BÀI VIẾT Fanpage có sẵn (object_story_id)."""
    status = "ACTIVE" if str(status).upper() == "ACTIVE" else "PAUSED"
    if not fb_configured():
        return {"ok": False, "error": "Chưa cấu hình Facebook Ads."}
    post_id = (post_id or "").strip()
    if not post_id:
        return {"ok": False, "error": "Thiếu ID bài viết."}
    try:
        budget = max(1, int(float(daily_budget or 50000)))
    except Exception:
        budget = 50000
    try:
        age_min = min(65, max(13, int(age_min or 18)))
        age_max = min(65, max(age_min, int(age_max or 55)))
    except Exception:
        age_min, age_max = 18, 55
    countries = countries or ["VN"]
    adname = "[AI-Post] " + ((name or "").strip() or post_id)[:55]
    campaign_id, adset_id = (campaign_id or "").strip(), (adset_id or "").strip()
    try:
        if not campaign_id:
            st, c = fb_graph("POST", "act_%s/campaigns" % FB_AD_ACCOUNT_ID,
                             {"name": adname, "objective": "OUTCOME_ENGAGEMENT",
                              "special_ad_categories": "[]",
                              "is_adset_budget_sharing_enabled": "false", "status": status})
            if st != 200:
                raise RuntimeError("Tạo campaign lỗi: " + fb_err(c))
            campaign_id = c["id"]
        cid = campaign_id
        if not adset_id:
            targeting = {"geo_locations": {"countries": countries}, "age_min": age_min,
                         "age_max": age_max, "targeting_automation": {"advantage_audience": 0}}
            if genders:
                targeting["genders"] = genders
            st, a = fb_graph("POST", "act_%s/adsets" % FB_AD_ACCOUNT_ID,
                             {"name": adname, "campaign_id": cid, "daily_budget": budget,
                              "billing_event": "IMPRESSIONS", "optimization_goal": "POST_ENGAGEMENT",
                              "bid_strategy": "LOWEST_COST_WITHOUT_CAP",
                              "targeting": json.dumps(targeting), "status": status})
            if st != 200:
                raise RuntimeError("Tạo ad set lỗi: " + fb_err(a))
            adset_id = a["id"]
        aid = adset_id
        # creative dùng BÀI CÓ SẴN
        st, cr = fb_graph("POST", "act_%s/adcreatives" % FB_AD_ACCOUNT_ID,
                          {"name": adname, "object_story_id": post_id})
        if st != 200:
            raise RuntimeError("Tạo creative từ bài lỗi: " + fb_err(cr))
        st, ad = fb_graph("POST", "act_%s/ads" % FB_AD_ACCOUNT_ID,
                          {"name": adname, "adset_id": aid,
                           "creative": json.dumps({"creative_id": cr["id"]}), "status": status})
        if st != 200:
            raise RuntimeError("Tạo ad lỗi: " + fb_err(ad))
    except Exception as e:
        return {"ok": False, "error": str(e)}
    mgr = ("https://www.facebook.com/adsmanager/manage/campaigns?act=%s&selected_campaign_ids=%s"
           % (FB_AD_ACCOUNT_ID, cid))
    return {"ok": True, "campaign_id": cid, "adset_id": aid, "ad_id": ad["id"], "manager_url": mgr}


# ===================== BẢNG BÀI FB ADS + ĐẨY HÀNG LOẠT GIÃN CÁCH AN TOÀN =====================
ADPOST_FILE = os.path.join(GALLERY_DIR, "adposts.json")
_adpost_lock = threading.Lock()
# trạng thái job đẩy hàng loạt (1 job tại 1 thời điểm cho an toàn)
ADPOST_PUSH = {"running": False, "done": 0, "total": 0, "gap": 90, "next_in": 0, "log": []}


def adpost_load():
    try:
        with open(ADPOST_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def adpost_save(items):
    try:
        os.makedirs(GALLERY_DIR, exist_ok=True)
        with open(ADPOST_FILE, "w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False)
    except Exception:
        pass


def _adpost_set(pid, **fields):
    with _adpost_lock:
        items = adpost_load()
        for it in items:
            if it.get("id") == pid:
                it.update(fields)
        adpost_save(items)


def _norm_title(t):
    return " ".join((t or "").lower().split())


def _shopify_title_link_map():
    """Trả [(title, store_url), ...] từ Shopify (để khớp tên SP -> đúng link)."""
    out = []
    if not shopify_configured():
        return out
    try:
        st, d = shopify_api("GET", "products.json?limit=250&fields=id,title,handle")
        if st != 200:
            return out
        for p in (d.get("products") or []):
            h = p.get("handle")
            if h:
                out.append((p.get("title", ""), "https://rieng.vn/products/%s" % h))
    except Exception:
        pass
    return out


import re as _re_links


def _best_product_link(prod_title, prods):
    """Khớp tên SP của bài với SP Shopify -> store_url. None nếu không khớp."""
    pt = _norm_title(prod_title)
    if not pt or not prods:
        return None
    norm = [(_norm_title(t), u, t) for (t, u) in prods if u]
    # 1) khớp chính xác
    for nt, u, _ in norm:
        if nt and nt == pt:
            return u
    # 2) khớp theo mã MS (vd MS88945) — chắc chắn nhất
    m = _re_links.search(r"ms\s?\d{3,}", pt)
    if m:
        code = m.group(0).replace(" ", "")
        for nt, u, _ in norm:
            if code in nt.replace(" ", ""):
                return u
    # 3) chứa nhau
    for nt, u, _ in norm:
        if nt and (nt in pt or pt in nt):
            return u
    # 4) trùng token nhiều nhất (>=60%)
    pts = set(pt.split())
    best, bestu = 0.0, None
    for nt, u, _ in norm:
        ts = set(nt.split())
        if not ts:
            continue
        ov = len(pts & ts) / max(1, len(pts | ts))
        if ov > best:
            best, bestu = ov, u
    return bestu if best >= 0.6 else None


def adpost_fix_links(only_ids=None):
    """Sửa link từng bài về ĐÚNG SP (khớp theo tên SP đã lưu). Trả {fixed, unmatched, total}."""
    prods = _shopify_title_link_map()
    if not prods:
        return {"error": "Không tải được sản phẩm Shopify (hoặc chưa cấu hình)."}
    with _adpost_lock:
        items = adpost_load()
        fixed, unmatched = 0, []
        for it in items:
            if only_ids and it.get("id") not in only_ids:
                continue
            link = _best_product_link(it.get("product", ""), prods)
            if link:
                if it.get("link") != link:
                    it["link"] = link
                    fixed += 1
            else:
                unmatched.append({"id": it.get("id"), "product": it.get("product", "")})
        adpost_save(items)
    return {"fixed": fixed, "unmatched": unmatched, "total": len(items)}


def _adpost_push_worker(ids, gap, budget, age_min, age_max, genders, cta, fb_status="PAUSED",
                        campaign_id="", adset_id=""):
    ADPOST_PUSH.update(running=True, done=0, total=len(ids), gap=gap, next_in=0, log=[])
    cur_camp, cur_aset = (campaign_id or "").strip(), (adset_id or "").strip()
    for i, pid in enumerate(ids):
        with _adpost_lock:
            it = next((x for x in adpost_load() if x.get("id") == pid), None)
        if not it:
            continue
        _adpost_set(pid, status="pushing")
        img, _ = fetch_image_bytes(it.get("image_url", ""))
        r = fb_ads_push_core(img, it.get("link"), it.get("caption"), it.get("title"),
                             it.get("title"), budget, age_min, age_max, genders, ["VN"], cta,
                             campaign_id=cur_camp, adset_id=cur_aset, status=fb_status)
        if r.get("ok"):
            # ad sau dồn vào CÙNG chiến dịch + nhóm vừa tạo (nếu ban đầu chưa chọn)
            cur_camp = cur_camp or r.get("campaign_id") or ""
            cur_aset = cur_aset or r.get("adset_id") or ""
            _adpost_set(pid, status="pushed",
                        result={"ad_id": r.get("ad_id"), "manager_url": r.get("manager_url")})
            ADPOST_PUSH["log"].append("✓ %s" % (it.get("title") or pid))
        else:
            _adpost_set(pid, status="error", result={"error": r.get("error")})
            ADPOST_PUSH["log"].append("✗ %s: %s" % (it.get("title") or pid, r.get("error")))
        ADPOST_PUSH["done"] = i + 1
        # GIÃN CÁCH AN TOÀN giữa các bài (tránh checkpoint) — trừ bài cuối
        if i < len(ids) - 1:
            for s in range(gap, 0, -1):
                ADPOST_PUSH["next_in"] = s
                time.sleep(1)
            ADPOST_PUSH["next_in"] = 0
    ADPOST_PUSH["running"] = False


def adpost_push_start(ids, gap, budget, age_min, age_max, genders, cta, fb_status="PAUSED",
                      campaign_id="", adset_id=""):
    if ADPOST_PUSH["running"]:
        return False
    gap = max(30, min(600, int(gap or 90)))   # an toàn: tối thiểu 30s/bài
    threading.Thread(target=_adpost_push_worker,
                     args=(ids, gap, budget, age_min, age_max, genders, cta, fb_status,
                           campaign_id, adset_id), daemon=True).start()
    return True


# ============ BẢNG BÀI ĐĂNG FANPAGE + INSTAGRAM (organic) + đẩy hàng loạt giãn cách ============
PGPOST_FILE = os.path.join(GALLERY_DIR, "pgposts.json")
_pgpost_lock = threading.Lock()
PGPOST_PUSH = {"running": False, "done": 0, "total": 0, "gap": 45, "next_in": 0, "log": []}


def pgpost_load():
    try:
        with open(PGPOST_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def pgpost_save(items):
    try:
        os.makedirs(GALLERY_DIR, exist_ok=True)
        with open(PGPOST_FILE, "w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False)
    except Exception:
        pass


def _pgpost_set(pid, **fields):
    with _pgpost_lock:
        items = pgpost_load()
        for it in items:
            if it.get("id") == pid:
                it.update(fields)
        pgpost_save(items)


def _pgpost_push_worker(ids, gap, channels):
    PGPOST_PUSH.update(running=True, done=0, total=len(ids), gap=gap, next_in=0, log=[])
    for i, pid in enumerate(ids):
        with _pgpost_lock:
            it = next((x for x in pgpost_load() if x.get("id") == pid), None)
        if not it:
            continue
        _pgpost_set(pid, status="posting")
        urls = it.get("image_urls") or []
        cap = it.get("caption") or ""
        res = {}
        if "fb" in channels:
            res["fb"] = fb_post_core(urls, cap)
        if "ig" in channels:
            res["ig"] = ig_post_core(urls, cap)
        ok = bool(res) and all(r.get("ok") for r in res.values())
        _pgpost_set(pid, status=("posted" if ok else "error"),
                    result={k: (v.get("url") if v.get("ok") else v.get("error")) for k, v in res.items()})
        PGPOST_PUSH["log"].append(("✓ " if ok else "✗ ") + (it.get("caption") or pid)[:40])
        PGPOST_PUSH["done"] = i + 1
        if i < len(ids) - 1:
            for s in range(gap, 0, -1):
                PGPOST_PUSH["next_in"] = s
                time.sleep(1)
            PGPOST_PUSH["next_in"] = 0
    PGPOST_PUSH["running"] = False


def pgpost_push_start(ids, gap, channels):
    if PGPOST_PUSH["running"]:
        return False
    gap = max(20, min(600, int(gap or 45)))
    threading.Thread(target=_pgpost_push_worker, args=(ids, gap, channels), daemon=True).start()
    return True


def run_product_job(job_id, img, shots, bg_key, engine="openai", ai_prompt=False):
    def work(shot):
        try:
            seg = shot.get("seg", "single")
            prompt = (product_prompt_ai(img, shot["cat"], shot["vk"], bg_key, seg) if ai_prompt
                      else product_prompt(shot["cat"], shot["vk"], bg_key, seg))
            b64 = gen_shot([(img, "image/png")], prompt,
                           shot["size"], engine, shot.get("aspect", ""))
            g = gallery_add(b64, {"mode": "product", "prompt": shot["label"]})
            return {"image": b64, "title": shot["label"], "gallery": g}
        except urllib.error.HTTPError as e:
            return {"error": openai_error_message(e), "title": shot["label"]}
        except Exception as e:
            return {"error": str(e), "title": shot["label"]}

    with ThreadPoolExecutor(max_workers=3) as ex:
        for res in ex.map(work, shots):
            with _batch_lock:
                job = BATCH_JOBS.get(job_id)
                if not job:
                    return
                job["done"] += 1
                if res.get("error"):
                    job["errors"].append("%s: %s" % (res.get("title", ""), res["error"]))
                else:
                    job["items"].append(res)
    with _batch_lock:
        if BATCH_JOBS.get(job_id):
            BATCH_JOBS[job_id]["finished"] = True


# ===== Ảnh sản phẩm theo TỆP + AI đổi tên (mỗi người 1 tên khác) =====
def _multi_design_prompt(people, vk, bg, names):
    """Prompt ảnh nhiều người, mỗi người mặc 1 design tên riêng (ref image #i)."""
    frame = _MODEL_FRAMES.get(vk, "Three-quarter group shot, all looking at the camera with bright cheerful smiles.")
    cast = "; ".join(desc for _who, desc in people)
    assign = " ".join(
        ("The %s wears an oversized t-shirt whose LARGE full-front chest print is EXACTLY the design "
         "in reference image #%d (the personalised name \"%s\")." % (who, i + 1, names[i]))
        for i, (who, desc) in enumerate(people))
    return ("A candid casual smartphone photo of %s, %s. %s "
            "Copy EACH printed design VERBATIM from its OWN reference image — same artwork, same NAME "
            "text with correct Vietnamese diacritics, same colors, kept a LARGE centered full-front "
            "print; do NOT swap, mix, shrink, move or redraw any design between the people. %s "
            "The shirts are oversized with a clean ribbed crewneck collar and no visible tags; fabric "
            "colors stay true to life, well exposed. %s %s"
            % (cast, bg, assign, frame, _CAM, PRODUCT_NEG))


def _kid_solo_prompt(bg):
    return ("A candid casual smartphone photo of %s, wearing %s. Standing %s. Three-quarter shot, "
            "looking at the camera with a bright playful happy smile. The fabric color stays true to "
            "life, well exposed. %s %s" % (_MODEL_KID, _SHIRT, bg, _CAM, PRODUCT_NEG))


def product_prompt_seg(shot, seg, bg_key, role_designs, names, ai_prompt):
    """-> (list design_b64 dùng làm ref, prompt, lock). Nhiều người: ghép nhiều design tên riêng."""
    cat, vk = shot["cat"], shot["vk"]
    bg = PRODUCT_BG.get(bg_key, PRODUCT_BG["cafe"])
    d0 = role_designs[0]

    def single(design_b64, vkey, segkey="single"):
        if ai_prompt:
            try:
                return product_prompt_ai(base64.b64decode(design_b64), "model", vkey, bg_key, segkey)
            except Exception:
                pass
        return product_prompt("model", vkey, bg_key, segkey)

    if cat != "model":            # flatlay / nền trắng / kraft -> 1 design đại diện
        if ai_prompt:
            try:
                p = product_prompt_ai(base64.b64decode(d0), cat, vk, bg_key, "single")
            except Exception:
                p = product_prompt(cat, vk, bg_key, "single")
        else:
            p = product_prompt(cat, vk, bg_key, "single")
        return [d0], p, True

    if seg == "couple":
        if vk.startswith("couple"):
            people = [("man on the left", _MODEL_M), ("woman on the right", _MODEL_F)]
            return [role_designs[0], role_designs[1]], _multi_design_prompt(people, vk, bg, names[:2]), False
        if vk in ("solo_f", "solo_f2", "solo_f3"):
            return [role_designs[1]], single(role_designs[1], "solo_f"), True
        if vk in ("solo_m", "solo_m2"):
            return [role_designs[0]], single(role_designs[0], "solo_m"), True
        return [d0], single(d0, "chest"), True     # chest / khác

    if seg == "family":
        if vk == "family_kid":
            return [role_designs[2]], (_kid_solo_prompt(bg) if not ai_prompt else _kid_solo_prompt(bg)), True
        if vk == "family_parents":
            people = [("father", _MODEL_M), ("mother", _MODEL_F)]
            return [role_designs[0], role_designs[1]], _multi_design_prompt(people, vk, bg, names[:2]), False
        if vk.startswith("family"):
            people = [("father", _MODEL_M), ("mother", _MODEL_F), ("young child", _MODEL_KID)]
            return [role_designs[0], role_designs[1], role_designs[2]], _multi_design_prompt(people, vk, bg, names[:3]), False
        return [d0], single(d0, "chest"), True

    # single / group -> 1 design (1 tên / tên nhóm), tái dùng template/AI sẵn
    return [d0], single(d0, vk, seg), True


def run_product_seg_job(job_id, base_b64, seg, theme, shots, bg_key,
                        engine="openai", ai_prompt=False, psize="1024x1536"):
    """AI đọc design -> tự nghĩ tên theo tệp (couple 2 / gia đình 3 / 1 mình & nhóm 1) ->
    cá nhân hoá design theo từng tên -> gen ảnh sản phẩm (nhiều người = mỗi người 1 tên)."""
    need = {"couple": 2, "family": 3}.get(seg, 1)
    raw = ai_personal_names([{"tep": seg, "theme": theme or ""}]) or []
    nm = (raw[0].get("name") if raw else "") or ""
    date = (raw[0].get("date") if raw else "") or ""
    role_names = _split_names(nm) or []
    while len(role_names) < need:
        role_names.append(role_names[-1] if role_names else "Yêu Thương")
    role_names = role_names[:need]
    # cá nhân hoá base -> design cho từng tên (1 lần/role)
    role_designs = []
    for rn in role_names:
        try:
            role_designs.append(personalize_core(base_b64, rn, psize, True, date))
        except Exception:
            role_designs.append(base_b64)
    with _batch_lock:
        job = BATCH_JOBS.get(job_id)
        if job:
            job["names"] = role_names
            job["date"] = date

    def work(shot):
        try:
            imgs_b64, prompt, lock = product_prompt_seg(shot, seg, bg_key, role_designs, role_names, ai_prompt)
            imgs = [(base64.b64decode(b), "image/png") for b in imgs_b64]
            b64 = gen_shot(imgs, prompt, shot["size"], engine, shot.get("aspect", ""), lock=lock)
            label = "%s · %s" % (shot["label"], " & ".join(role_names))
            g = gallery_add(b64, {"mode": "product", "prompt": label})
            return {"image": b64, "title": label, "gallery": g}
        except urllib.error.HTTPError as e:
            return {"error": openai_error_message(e), "title": shot["label"]}
        except Exception as e:
            return {"error": str(e), "title": shot["label"]}

    with ThreadPoolExecutor(max_workers=3) as ex:
        for res in ex.map(work, shots):
            with _batch_lock:
                job = BATCH_JOBS.get(job_id)
                if not job:
                    return
                job["done"] += 1
                if res.get("error"):
                    job["errors"].append("%s: %s" % (res.get("title", ""), res["error"]))
                else:
                    job["items"].append(res)
    with _batch_lock:
        if BATCH_JOBS.get(job_id):
            BATCH_JOBS[job_id]["finished"] = True


def run_prompt_job(job_id, img, shots, bg_key):
    """BƯỚC 1: AI nhìn ảnh áo -> sinh prompt cho từng shot (chưa gen ảnh).

    Mỗi item = {title, prompt, size, aspect}. Người dùng sẽ duyệt/sửa/chọn rồi mới gen.
    """
    def work(shot):
        try:
            prompt = product_prompt_ai(img, shot["cat"], shot["vk"], bg_key, shot.get("seg", "single"))
            return {"title": shot["label"], "prompt": prompt,
                    "size": shot["size"], "aspect": shot.get("aspect", "")}
        except urllib.error.HTTPError as e:
            return {"error": openai_error_message(e), "title": shot["label"]}
        except Exception as e:
            return {"error": str(e), "title": shot["label"]}

    with ThreadPoolExecutor(max_workers=3) as ex:
        for res in ex.map(work, shots):
            with _batch_lock:
                job = BATCH_JOBS.get(job_id)
                if not job:
                    return
                job["done"] += 1
                if res.get("error"):
                    job["errors"].append("%s: %s" % (res.get("title", ""), res["error"]))
                else:
                    job["items"].append(res)
    with _batch_lock:
        if BATCH_JOBS.get(job_id):
            BATCH_JOBS[job_id]["finished"] = True


def run_render_job(job_id, img, picks, engine="openai"):
    """BƯỚC 2: gen ảnh từ các prompt người dùng ĐÃ CHỌN, theo model (engine) đã chọn."""
    def work(p):
        title = p.get("title") or "Ảnh"
        try:
            b64 = gen_shot([(img, "image/png")], p["prompt"],
                           p.get("size") or "1024x1024", engine, p.get("aspect", ""))
            g = gallery_add(b64, {"mode": "product", "prompt": title})
            return {"image": b64, "title": title, "gallery": g}
        except urllib.error.HTTPError as e:
            return {"error": openai_error_message(e), "title": title}
        except Exception as e:
            return {"error": str(e), "title": title}

    with ThreadPoolExecutor(max_workers=3) as ex:
        for res in ex.map(work, picks):
            with _batch_lock:
                job = BATCH_JOBS.get(job_id)
                if not job:
                    return
                job["done"] += 1
                if res.get("error"):
                    job["errors"].append("%s: %s" % (res.get("title", ""), res["error"]))
                else:
                    job["items"].append(res)
    with _batch_lock:
        if BATCH_JOBS.get(job_id):
            BATCH_JOBS[job_id]["finished"] = True


CONTENT_SYSTEM = (
    "Bạn là chuyên viết content bán hàng cho thương hiệu ÁO THUN IN TÊN cá nhân hoá rieng.vn "
    "(Việt Nam). Sản phẩm: áo thun in TÊN RIÊNG theo yêu cầu — HỢP cho cặp đôi (couple), nhóm "
    "bạn / đội nhóm, và GIA ĐÌNH; CÓ cả SIZE TRẺ EM nên cả nhà mặc đồng bộ được. NHÌN ảnh để "
    "biết bài này đang hướng tới ai (1 áo / couple 2 áo / nhóm 3 áo / gia đình) và viết cho "
    "ĐÚNG đối tượng đó — KHÔNG mặc định là cặp đôi nếu ảnh là nhóm/gia đình. KHÔNG bịa chi tiết. "
    "Viết tiếng Việt, giọng trẻ trung tự nhiên như bạn bè, KHÔNG sáo rỗng (tránh 'chất lượng "
    "cao', 'giá tốt nhất', 'uy tín').\n"
    "Trả về JSON đúng dạng: {\"facebook\":\"...\",\"tiktok_script\":\"...\",\"tiktok_caption\":\"...\"}.\n\n"
    "1) facebook — 1 bài Facebook Ads cho áo thun IN TÊN: dòng HOOK gây chú ý (cảm xúc/câu hỏi) → "
    "BODY 2–4 dòng ngắn: in tên riêng theo yêu cầu, hợp couple / nhóm bạn / GIA ĐÌNH, CÓ SIZE TRẺ "
    "EM (cả nhà mặc đồng bộ) → CTA rõ ràng (chèn link/giá nếu có) → 5–8 hashtag tiếng Việt "
    "(gồm #áothunintên #riengvn và hashtag hợp đối tượng: couple/nhóm/giađình). Emoji vừa phải.\n\n"
    "2) tiktok_script — kịch bản TikTok ẢNH CUỘN 7 slide. ZERO nhắc sản phẩm (không 'áo/quà/"
    "tặng/mua/shop/couple/in tên'). Tối đa 1–2 slide có text overlay (câu ngắn ≤20 chữ, giọng "
    "nhẹ hơi thơ hiện đại, kiểu 'Gặp đúng người, mọi thứ tự nhiên trở nên dịu dàng...'). Còn lại "
    "ảnh sạch. Format mỗi dòng: 'SLIDE 1 — ảnh sạch', 'SLIDE 2 📝 \"...\"', ... 'SLIDE 7 — rieng.vn'.\n\n"
    "3) tiktok_caption — 1–2 dòng tâm sự nhẹ cùng giọng trên (KHÔNG bán hàng) + 1 dòng CTA nhẹ "
    "('inbox mình nha') + 8–12 hashtag, BẮT BUỘC có #riengvn #áocouple #quàtặngcouple #đồđôi."
)


def product_content(img_bytes, info):
    """AI nhìn ảnh sản phẩm + info -> JSON {facebook, tiktok_script, tiktok_caption}."""
    info = (info or "").strip()
    content = [{"type": "text",
                "text": ("Thông tin sản phẩm/link (nếu có): %s\nViết content theo schema."
                         % (info or "(không có — tự suy từ ảnh)"))}]
    if img_bytes:
        b64 = base64.b64encode(img_bytes).decode()
        content.append({"type": "image_url",
                        "image_url": {"url": "data:image/png;base64," + b64}})
    messages = [{"role": "system", "content": CONTENT_SYSTEM},
                {"role": "user", "content": content}]
    raw = openai_chat(messages, json_mode=True, max_tokens=1800)
    try:
        d = json.loads(raw)
    except Exception:
        return {"facebook": raw, "tiktok_script": "", "tiktok_caption": ""}
    return {"facebook": d.get("facebook", ""),
            "tiktok_script": d.get("tiktok_script", ""),
            "tiktok_caption": d.get("tiktok_caption", "")}


# --------------------------------------------------------------------------- #
#  Tạo design từ đầu (text-to-image) theo PHONG CÁCH có sẵn
# --------------------------------------------------------------------------- #
# 19 phong cách typography hợp thị hiếu VN (từ file Pinterest+Shopee) + vài style graphic.
DESIGN_STYLES = {
    "vintage_americana": ("Vintage Americana / Collegiate", "vintage americana collegiate ringer-tee typography design"),
    "varsity": ("Varsity / College Athletic", "varsity college athletic number t-shirt typography"),
    "minimal_clean": ("Minimal Clean Typography", "minimal clean typography t-shirt"),
    "lineart": ("Minimalist line-art",
        "minimalist single-line / fine line-art t-shirt graphic — a simple elegant continuous "
        "monoline illustration (face, mountain, sun, wave, flower, hand, body...), thin clean "
        "strokes, lots of negative space, 1-2 colors only, tattoo-flash minimal aesthetic, no "
        "background clutter"),
    "retro_groovy": ("Retro Groovy 70s", "70s retro groovy typography t-shirt — wavy bubbly Cooper-Black/Windsor style letters, sunburst rays, warm faded disco palette (mustard, orange, brown, cream)"),
    "type_3d": ("3D phồng (inflate)", "glossy 3D inflated puffy balloon typography t-shirt — rounded chunky letters with soft shadows and highlights, playful, bold"),
    "big_type": ("Chữ to kín áo (kinetic)", "bold oversized stacked typography t-shirt — a few huge words filling the whole print edge to edge, kinetic repeated/justified text block, high-impact, minimal color"),
    "calligraphy": ("Calligraphy lettering", "elegant calligraphy hand-lettering art t-shirt — fancy flowing script with flourishes and ink pen strokes, refined, single color"),
    "ransom_collage": ("Ransom / Collage type", "ransom-note collage typography t-shirt — mismatched cut-out letters from magazines and newspapers, punk DIY, torn paper, taped"),
    "korean_minimal": ("Korean Minimal Lettering", "Korean-style minimal lettering t-shirt — a small refined lowercase phrase, generous empty space, soft muted cream/sage/greige palette, a tiny delicate line icon/accent, calm understated aesthetic (NOT big plain block letters)"),
    "motivational": ("Motivational / Quote Bold", "bold motivational quote t-shirt typography"),
    "street_racing": ("Street Racing / Automotive", "vintage street racing automotive t-shirt"),
    "vintage_washed": ("Vintage Washed / Distressed", "vintage washed distressed t-shirt typography"),
    "y2k_graffiti": ("Y2K Graffiti / Bubble", "y2k graffiti bubble t-shirt typography"),
    "badge_patch": ("Retro Badge / Patch", "retro streetwear patch badge collage t-shirt"),
    "couple_love": ("Couple / L\u1eddi nh\u1eafn t\xecnh y\xeau", "matching couple t-shirt typography \u2014 modern cute his/her love slogan, soft warm palette, small hearts / paired lockup, clean & trendy for GenZ couples"),
    "city_souvenir": ("Local Place / City Souvenir", "Vietnam local-place souvenir t-shirt — iconic VIETNAMESE city & landmark (Hà Nội, Sài Gòn, Đà Nẵng, Hội An, Huế, Đà Lạt; e.g. Hồ Gươm Tháp Rùa, Khuê Văn Các, Chùa Một Cột, Cầu Rồng, Hội An lanterns, Bến Thành market, Landmark 81), bold place name + small tagline, clean 2–3 color, souvenir/travel vibe (NOT USA/Western cities)"),
    "statement_bold": ("Statement / Edgy Bold", "bold edgy statement t-shirt typography — one huge punchy slogan, distressed grit, RESTRAINED 2-color (mono + a single accent), high-impact and clean (not messy or neon-overload)"),
    "funny_vn": ("Funny Quote (ti\u1ebfng Vi\u1ec7t)", "funny / meme-style quote t-shirt \u2014 a witty cheeky humorous slogan (English by default), BOLD playful chunky or handwritten font, a small funny doodle/sticker, casual fun vibe, bright but clean (NOT elegant, NOT calm script)"),
    "floral_quote": ("Aesthetic Floral + Quote", "aesthetic floral quote t-shirt"),
    "luxury_minimal": ("Luxury Minimal Back-print", "luxury minimal back-print t-shirt"),
    "luxury_serif_script": ("Luxury Serif + Script (Couture Club)",
        "upscale LUXURY 'couture / heritage club' back-print t-shirt typography lockup — a LARGE bold "
        "HIGH-CONTRAST SERIF main word (elegant ligatures, fashion-magazine serif), with a flowing "
        "elegant SCRIPT word elegantly OVERLAPPING / crossing through it; refined small SPACED-UPPERCASE "
        "supporting text — a short tagline (e.g. 'Original', 'Anniversary Edition', 'Athletic "
        "Department', 'Legacy of Luxury'), an 'EST. 20xx' and/or a location line; thin decorative "
        "horizontal lines and a tiny emblem / monogram or a small sparkle; sophisticated, premium, "
        "expensive feel; monochrome BLACK or ONE muted accent (deep maroon / navy / warm cream) on a "
        "clean background (The Couture Club / heritage-streetwear aesthetic)"),
    "social_club": ("Social Club / Community", "collegiate 'social club / community' t-shirt typography — varsity arched club name + 'EST. 20xx' + a place/locale line, tidy badge layout, clean 2-color (cream + navy/maroon)"),
    "sport_statement": ("Sport / Athletic Statement", "sport athletic statement t-shirt typography"),
    "liquid_chrome": ("Liquid Chrome / 3D Y2K", "liquid chrome 3D y2k t-shirt typography"),
    "scribble": ("Scribble / Handwritten", "scribble handwritten sketch t-shirt typography"),
    "streetwear": ("Streetwear", "modern urban streetwear t-shirt graphic, bold oversized hype/hypebeast aesthetic"),
    "graffiti_tag": ("Graffiti / Wildstyle", "graffiti wildstyle spray-paint tag t-shirt graphic, urban wall art, drips and bold outlines"),
    "grunge_punk": ("Grunge / Punk", "grunge punk streetwear t-shirt graphic, distressed photocopy zine aesthetic, ripped collage, safety-pin DIY vibe"),
    "cyberpunk": ("Cyberpunk / Techwear", "cyberpunk techwear streetwear t-shirt graphic, neon glitch, futuristic HUD, dystopian Japanese signage"),
    "skate": ("Skate / Skateboard", "skate skateboard streetwear t-shirt graphic, bold cartoon, old-school skate logo vibe"),
    "rap_bootleg": ("Rap Bootleg 90s", "90s rap/hip-hop bootleg t-shirt graphic — bold arched collegiate text, stars, gritty halftone texture, vintage rap-tee collage layout, use a STYLIZED ILLUSTRATED portrait or graphic (not a real celebrity photo)"),
    "vaporwave": ("Vaporwave", "vaporwave aesthetic t-shirt graphic, pastel neon pink-cyan, roman marble bust, retro grid, glitch, 80s"),
    "comic_pop": ("Comic / Pop-art", "comic pop-art t-shirt graphic, ben-day halftone dots, speech bubble, bold panel, retro comic"),
    "acid_trippy": ("Acid / Psychedelic", "psychedelic acid trippy streetwear t-shirt graphic, melting warped type, swirling shapes, bright contrasting colors"),
    "military": ("Military / Utility", "military utility techwear t-shirt graphic, stencil army font, tactical patches, olive and black"),
    "anime_nostalgia": ("Anime hoài niệm (TeeLab)",
        "nostalgic 90s anime illustration t-shirt (TeeLab core-collection style): a soft wholesome "
        "childhood scene (a kid playing a retro CRT TV game console, sitting on a cloud, Studio "
        "Ghibli / 90s anime vibe), gentle muted pastel colors, clean thin outlines; above it a small "
        "neat centered title with a Japanese KATAKANA subtitle line and a tiny English tagline; "
        "calm, dreamy, nostalgic mood"),
    "cute_mascot": ("Cute mascot (SANCOOL)",
        "cute wholesome animal-mascot t-shirt graphic (SANCOOL style): ONE adorable chibi cartoon "
        "animal (crocodile, dino, bear, cat, duck...) with soft rounded shapes, a tiny speech "
        "bubble, a few small floating hearts; a cute rounded hand-lettered caption name + a brand "
        "name + a small 'Copyright ©' line below; soft pastel palette (green, cream, yellow, pink), "
        "clean kawaii commercial vibe, friendly and simple"),
    "mascot": ("Mascot minh hoạ (TeeLab)",
        "Vietnamese illustrated streetwear tee (TeeLab style): a bold cartoon MASCOT/character "
        "(astronaut, robot, animal, monster...) as the hero in the center, placed IN FRONT of LARGE "
        "stacked stylized brand-name typography in the background; a small brand name + '© <year>' "
        "tagline line at the bottom; thick clean cartoon outlines, sticker-like, dynamic pose; "
        "limited bold palette (golden-yellow, teal, white, pink/magenta accents) for a dark shirt"),
    "gothic": ("Gothic streetwear", "dark gothic streetwear t-shirt graphic"),
    "skull": ("Skull dark", "dark skull memento mori t-shirt graphic"),
    "celestial": ("V\u0169 tr\u1ee5 / celestial", "celestial space astronaut t-shirt graphic"),
    "angel": ("Thi\xean th\u1ea7n baroque", "baroque cherub angel t-shirt graphic"),
    "kawaii": ("Cute / kawaii", "cute kawaii cartoon t-shirt graphic"),
    "typography": ("Typography slogan", "bold typography slogan t-shirt"),
    "anime": ("Anime / manga", "anime/manga CHARACTER t-shirt graphic — MUST feature an anime/manga character or hero (expressive face, dynamic pose), CLEAN bold black linework + screentone/halftone shading, restrained 2–3 muted colors, manga-panel feel, print-friendly (NOT a plain landscape, NOT rainbow)"),
    "y2k": ("Y2K", "y2k butterfly chrome t-shirt graphic"),
    "floral": ("Floral line art", "floral botanical line-art t-shirt graphic"),
    "tattoo_oldschool": ("Tattoo old-school", "American traditional old-school tattoo-flash t-shirt graphic — bold black outlines, anchors/roses/daggers/swallows/banners, limited red-black-cream palette"),
    "ukiyoe": ("Nhật cổ / Ukiyo-e", "Japanese ukiyo-e / oriental woodblock t-shirt graphic — great wave, koi, dragon, samurai or oni mask, cherry blossoms, traditional indigo-red-cream palette"),
    "retro_poster": ("Retro Poster", "vintage retro poster t-shirt graphic — travel/propaganda poster style, bold flat shapes, limited warm muted palette, classic mid-century print"),
    "pixel_8bit": ("Pixel / 8-bit", "pixel-art 8-bit retro gaming t-shirt graphic — chunky pixels, arcade vibe, limited palette"),
    "flat_vector": ("Flat Vector", "modern flat vector illustration t-shirt graphic — clean simple shapes, bold flat colors, no gradients, trendy editorial"),
    "watercolor": ("Watercolor", "soft watercolor painting t-shirt graphic — gentle washes and bleeds, delicate artistic, light airy palette"),
    "engraving": ("Engraving cổ điển", "vintage engraving / etching t-shirt graphic — fine cross-hatch line shading, classic botanical or animal illustration, monochrome ink"),
    "abstract_geo": ("Abstract / Geometric", "abstract geometric Bauhaus t-shirt graphic — bold simple shapes, primary blocks, risograph texture, modern minimal art"),
    "mandala": ("Mandala / Zen", "mandala / zen spiritual t-shirt graphic — symmetric ornate linework, lotus, sacred geometry, calm monoline"),
}

DESIGN_SYSTEM = (
    "Bạn là một designer áo thun đẳng cấp thế giới. Hãy TỰ DO SÁNG TẠO bằng toàn bộ kiến thức "
    "của bạn. Tạo N câu prompt TIẾNG ANH cho AI tạo ảnh — mỗi câu là 1 design áo thun CỰC ĐẸP, "
    "độc đáo, khác nhau, theo phong cách '%s'. Bạn toàn quyền quyết định chủ thể, font, màu, bố "
    "cục, hiệu ứng sao cho đẹp & hợp trend nhất — không bị gò bó.\n"
    "Nếu người dùng có nhập (tên/địa danh/câu/chủ đề) thì lồng vào; không có thì tự nghĩ.\n"
    "NGÔN NGỮ chữ trên design: MẶC ĐỊNH dùng TIẾNG ANH (cho ngầu & hợp trend). CHỈ dùng tiếng Việt "
    "khi người dùng nhập sẵn chữ tiếng Việt — khi đó giữ nguyên ĐÚNG DẤU. Tên địa danh thì giữ "
    "tên riêng (vd Hà Nội / Hanoi).\n"
    "MÀU SẮC: ưu tiên bảng màu GỌN (2–4 màu) sạch, tinh tế, dễ in & dễ mặc kiểu áo thun Việt "
    "Nam — TRÁNH sặc sỡ/rối/cầu vồng (trừ phong cách vốn rực rỡ như Y2K, Vaporwave, Graffiti).\n"
    "Mỗi prompt KẾT THÚC bằng: 'isolated t-shirt print graphic on a plain solid white "
    "background, print-ready, no t-shirt, no mockup, no person'. Trả JSON đúng dạng "
    "{\"designs\":[{\"title\":\"tên ngắn tiếng Việt\",\"prompt\":\"...\"}]}."
)


# Phong cách có NHÂN VẬT/mascot -> cần đa dạng con vật, tránh lần nào cũng ra 1 con
_MASCOT_KEYS = {"mascot", "cute_mascot", "kawaii", "anime_nostalgia", "comic_pop"}
_CHAR_POOL = [
    "mèo", "cún corgi", "chó shiba", "gấu nâu", "gấu trúc", "cáo", "cá sấu", "khủng long",
    "thỏ", "ếch", "cú mèo", "hổ con", "sư tử con", "chim cánh cụt", "rái cá", "hà mã",
    "tê giác", "khỉ", "gấu Bắc Cực", "cá voi", "bạch tuộc", "rồng nhỏ", "kỳ lân",
    "robot", "phi hành gia", "quái vật nhỏ lông xù", "ma cute", "người tuyết", "ong",
    "bọ rùa", "vịt vàng", "heo", "cừu", "nai", "sóc", "chuột hamster", "tắc kè hoa",
]


def _variety_hint(styles, n):
    """Câu nhắc đa dạng chủ thể/nhân vật giữa các design VÀ giữa các lần gen (random pool)."""
    if any(s in _MASCOT_KEYS for s in styles):
        pool = _CHAR_POOL[:]
        random.shuffle(pool)
        picks = ", ".join(pool[:max(int(n or 3) + 2, 5)])
        return ("ĐA DẠNG NHÂN VẬT (RẤT QUAN TRỌNG): mỗi design dùng MỘT nhân vật/mascot "
                "KHÁC NHAU, KHÔNG lặp lại; ĐỪNG mặc định cá sấu/phi hành gia. Lần này ưu tiên "
                "chọn nhân vật trong nhóm gợi ý NGẪU NHIÊN (mỗi mẫu 1 con khác nhau): %s." % picks)
    return "Mỗi design có CHỦ THỂ/bố cục KHÁC NHAU, đa dạng, tránh trùng lặp giữa các mẫu."


def design_concepts_custom(prompt, theme, text, n, year="", same_line=False):
    """Không chọn style — dùng PROMPT user tự điền làm mô tả design."""
    n = max(1, min(int(n or 3), 8))
    base = (prompt or "").strip()
    parts = []
    if (text or "").strip():
        parts.append('the text "%s" is the main printed element' % text.strip())
    if (year or "").strip():
        parts.append('include "%s"' % year.strip())
    if (theme or "").strip():
        parts.append('theme/niche: %s' % theme.strip())
    if same_line and (text or "").strip():
        parts.append("keep the words on ONE single line (do not stack)")
    ctx = (" — " + "; ".join(parts) + "." if parts else "")
    suffix = (" Render as a FLAT VECTOR t-shirt PRINT design, ARTWORK ONLY (NOT a mockup, NOT a "
              "person, NOT a photo of a shirt), centered on a PLAIN PURE WHITE background, crisp "
              "PRINT-READY, bold high-contrast, no watermark.")
    cons = []
    for i in range(n):
        v = base + ctx + suffix + (" Variation %d — give it a distinct fresh take." % (i + 1) if n > 1 else "")
        cons.append({"prompt": v, "title": "Prompt tự điền", "style": ""})
    return cons


def design_concepts(styles, theme, text, n, year="", same_line=False):
    """styles: list khoá phong cách. Nhiều style -> TRỘN vào cùng mỗi design (fusion)."""
    n = max(1, min(int(n or 3), 8))
    if isinstance(styles, str):
        styles = [styles]
    styles = [s for s in styles if s in DESIGN_STYLES] or [list(DESIGN_STYLES)[0]]
    if len(styles) == 1:
        sd = DESIGN_STYLES[styles[0]][1]
    else:
        descs = " + ".join("(%s)" % DESIGN_STYLES[s][1] for s in styles)
        names = " + ".join(DESIGN_STYLES[s][0] for s in styles)
        sd = ("MASH-UP / FUSION nhiều phong cách vào CÙNG MỖI design (kết hợp hài hoà thành 1 "
              "thể thống nhất, KHÔNG tách rời, KHÔNG chia ô): %s. Các phong cách cần trộn: %s"
              % (names, descs))
    parts = ["Tạo đúng %d design." % n]
    if (theme or "").strip():
        parts.append("Chủ đề/ngách: %s." % theme.strip())
    if (text or "").strip():
        parts.append("Chèn dòng chữ \"%s\" vào design (đúng chính tả, nổi bật)." % text.strip())
    else:
        parts.append("Tự nghĩ câu chữ/slogan ngắn ấn tượng phù hợp phong cách.")
    if (year or "").strip():
        parts.append("Thêm 1 DÒNG NĂM/SỐ riêng \"%s\" (đúng nguyên văn) làm chi tiết phụ, đặt tách khỏi dòng chữ chính (vd phía dưới/góc), cỡ nhỏ hơn, hợp bố cục." % year.strip())
    if same_line:
        parts.append("BẮT BUỘC bố cục chữ: chữ/tên chính phải nằm trên MỘT HÀNG NGANG DUY NHẤT — TUYỆT ĐỐI KHÔNG xếp chồng 2 tầng, KHÔNG tách mỗi từ một dòng, KHÔNG bố cục arched 2 dòng. Trong MỖI image prompt phải ghi rõ 'all words on one single horizontal line, single-line lockup, not stacked'.")
    parts.append(_variety_hint(styles, n))
    messages = [{"role": "system", "content": DESIGN_SYSTEM % sd},
                {"role": "user", "content": " ".join(parts) + " Chỉ trả JSON."}]
    out = []
    for _attempt in range(2):
        raw = openai_chat(messages, json_mode=True, max_tokens=2800)
        out = _parse_designs(raw)
        if out:
            break
    return out[:n]


def _parse_designs(raw):
    """Parse JSON từ chat — chịu được code fence, JSON lồng, list trần."""
    if not raw:
        return []
    t = raw.strip()
    if t.startswith("```"):
        t = t.strip("`")
        if t[:4].lower() == "json":
            t = t[4:]
    data = None
    try:
        data = json.loads(t)
    except Exception:
        m = re.search(r"[\[{].*[\]}]", t, re.S)
        if m:
            try:
                data = json.loads(m.group(0))
            except Exception:
                data = None
    if data is None:
        return []
    arr = []
    if isinstance(data, list):
        arr = data
    elif isinstance(data, dict):
        arr = data.get("designs")
        if not isinstance(arr, list):
            arr = next((v for v in data.values() if isinstance(v, list)), [])
    out = []
    for d in (arr or []):
        if isinstance(d, str) and d.strip():
            out.append({"title": "Design", "prompt": d.strip()})
        elif isinstance(d, dict):
            p = (d.get("prompt") or d.get("design") or d.get("text") or "").strip()
            if p:
                item = {"title": (d.get("title") or "Design").strip()[:80], "prompt": p}
                if (d.get("style") or "").strip():
                    item["style"] = d.get("style").strip()[:50]
                out.append(item)
    return out


DESIGN_REF_SYSTEM = (
    "Bạn là designer áo thun. Bạn được đưa 1 ẢNH THAM CHIẾU. CHỈ HỌC PHONG CÁCH THỊ GIÁC của nó: "
    "kỹ thuật vẽ/illustration, BẢNG MÀU, kiểu chữ/typography, texture/hiệu ứng, mood. "
    "TUYỆT ĐỐI KHÔNG sao chép CHỦ THỂ / nhân vật / chữ / bố cục / nội dung cụ thể của ảnh ref.\n"
    "1) Nhận diện phong cách (mô tả ngắn; nếu khớp thì nêu TÊN trong danh sách gợi ý).\n"
    "2) Tạo N câu prompt TIẾNG ANH — mỗi cái là 1 design MỚI với CHỦ ĐỀ/CHỦ THỂ KHÁC HẲN ảnh ref "
    "(theo chủ đề người dùng nhập; nếu không có thì tự nghĩ chủ đề mới), nhưng áp ĐÚNG phong cách "
    "(màu + kỹ thuật + kiểu chữ + texture) đã học. Nội dung phải khác ảnh ref rõ rệt. Màu dễ in.\n"
    "Danh sách phong cách gợi ý: %s.\n"
    "Mỗi prompt KẾT THÚC bằng: 'isolated t-shirt print graphic on a plain solid white background, "
    "print-ready, no t-shirt, no mockup, no person'. "
    "Trả JSON {\"style\":\"tên phong cách nhận diện\",\"designs\":[{\"title\":\"tên ngắn\","
    "\"prompt\":\"...\"}]}."
)


def design_concepts_from_ref(ref_bytes, theme, text, n, year="", same_line=False):
    """Nhìn ảnh tham chiếu -> nhận diện style + tạo n design mới cùng phong cách.
    Trả (style_detected, list[concept])."""
    n = max(1, min(int(n or 3), 8))
    labels = ", ".join(v[0] for v in DESIGN_STYLES.values())
    parts = ["Tạo đúng %d design mới cùng phong cách ảnh tham chiếu." % n]
    if (theme or "").strip():
        parts.append("Chủ đề: %s." % theme.strip())
    if (text or "").strip():
        parts.append("Chèn chữ \"%s\"." % text.strip())
    if (year or "").strip():
        parts.append("Thêm 1 dòng năm/số riêng \"%s\" (đúng nguyên văn) làm chi tiết phụ, tách khỏi dòng chữ chính, cỡ nhỏ hơn." % year.strip())
    if same_line:
        parts.append("BẮT BUỘC bố cục chữ: chữ/tên chính nằm trên MỘT HÀNG NGANG DUY NHẤT — KHÔNG xếp chồng, KHÔNG tách mỗi từ một dòng, KHÔNG arched 2 tầng. Mỗi image prompt ghi rõ 'all words on one single horizontal line, single-line lockup, not stacked'.")
    if not (theme or "").strip():
        _p = _CHAR_POOL[:]; random.shuffle(_p)
        parts.append("Nếu phong cách có nhân vật/mascot: mỗi design dùng MỘT nhân vật KHÁC NHAU, đa dạng (gợi ý ngẫu nhiên: %s), KHÔNG lặp lại con giống nhau." % ", ".join(_p[:max(int(n or 3) + 2, 5)]))
    b64 = base64.b64encode(ref_bytes).decode()
    content = [{"type": "text", "text": " ".join(parts) + " Chỉ trả JSON."},
               {"type": "image_url", "image_url": {"url": "data:image/png;base64," + b64}}]
    messages = [{"role": "system", "content": DESIGN_REF_SYSTEM % labels},
                {"role": "user", "content": content}]
    detected, concepts = "", []
    for _attempt in range(2):
        raw = openai_chat(messages, json_mode=True, max_tokens=2800)
        concepts = _parse_designs(raw)
        m = re.search(r'"style"\s*:\s*"([^"]{1,60})"', raw or "")
        if m:
            detected = m.group(1)
        if concepts:
            break
    return detected, concepts[:n]


DESIGN_AUTO_SYSTEM = (
    "Bạn là giám đốc sáng tạo kiêm designer áo thun đẳng cấp, rất hiểu thị hiếu & thị trường "
    "áo thun Việt Nam. Người dùng chỉ đưa chủ đề/chữ (hoặc để trống). NHIỆM VỤ: TỰ CHỌN phong "
    "cách thiết kế PHÙ HỢP & DỄ BÁN, ĐẸP nhất cho từng mẫu. ĐƯỢC PHÉP & KHUYẾN KHÍCH MASH-UP / "
    "TRỘN 2–3 phong cách vào CÙNG 1 mẫu (kết hợp hài hoà thành 1 thể thống nhất, KHÔNG chia ô, "
    "KHÔNG ghép rời rạc) miễn ra mẫu ĐẸP & hợp trend nhất — vd typography + graffiti, mascot + "
    "vintage, line-art + floral... Mỗi mẫu chọn cách trộn riêng để đa dạng. ƯU TIÊN MẶC ĐỊNH chọn "
    "trong các phong cách BÁN CHẠY ở thị trường Việt Nam dưới đây (được trộn 2–3 cái); chỉ dùng "
    "phong cách ngoài danh sách khi thật sự hợp chủ đề hơn. MỖI phong cách kèm mô tả đặc trưng "
    "(ĐÃ chuẩn hoá cho thị trường VN) — khi chọn phong cách nào thì BÁM ĐÚNG mô tả đó (vd City "
    "Souvenir = địa danh VIỆT NAM, không phải thành phố Tây):\n%s\n"
    "Tạo N câu prompt TIẾNG ANH cho AI tạo ảnh — mỗi câu là 1 design áo thun CỰC ĐẸP, độc đáo, "
    "khác nhau. Bạn toàn quyền quyết định chủ thể, font, màu, bố cục, hiệu ứng sao cho đẹp & hợp "
    "trend nhất.\n"
    "NGÔN NGỮ chữ trên design: MẶC ĐỊNH dùng TIẾNG ANH. CHỈ dùng tiếng Việt khi người dùng nhập "
    "sẵn chữ tiếng Việt (giữ nguyên ĐÚNG DẤU). Tên địa danh giữ tên riêng (vd Hà Nội / Hanoi).\n"
    "MÀU SẮC: ưu tiên bảng màu GỌN (2–4 màu) sạch, tinh tế, dễ in & dễ mặc — TRÁNH sặc sỡ/rối "
    "(trừ phong cách vốn rực rỡ như Y2K, Vaporwave, Graffiti).\n"
    "Mỗi prompt KẾT THÚC bằng: 'isolated t-shirt print graphic on a plain solid white background, "
    "print-ready, no t-shirt, no mockup, no person'. Trả JSON đúng dạng "
    "{\"designs\":[{\"title\":\"tên ngắn tiếng Việt\",\"style\":\"phong cách đã chọn (nếu trộn thì ghi vd 'Typography × Graffiti')\",\"prompt\":\"...\"}]}."
)


# Phong cách BÁN CHẠY ở thị trường VN — ưu tiên cho chế độ AI tự chọn
VN_HOT_STYLES = [
    "vintage_americana", "varsity", "typography", "minimal_clean", "korean_minimal",
    "motivational", "vintage_washed", "badge_patch", "couple_love", "city_souvenir",
    "statement_bold", "funny_vn", "floral_quote", "luxury_minimal", "social_club",
    "sport_statement", "scribble", "streetwear", "mascot", "cute_mascot",
    "anime_nostalgia", "retro_groovy", "big_type", "retro_poster", "lineart",
    "flat_vector", "y2k_graffiti", "liquid_chrome", "calligraphy", "tattoo_oldschool",
    "luxury_serif_script",
]


# Phong cách HỢP CÁ NHÂN HOÁ TÊN — dùng cho AI tự chọn ở Trọn gói (tên là điểm nhấn)
NAME_STYLES = [
    "vintage_americana", "varsity", "big_type", "calligraphy", "couple_love",
    "social_club", "statement_bold", "typography", "minimal_clean", "liquid_chrome",
    "y2k_graffiti", "streetwear", "badge_patch", "sport_statement", "korean_minimal",
    "retro_groovy", "vintage_washed", "cute_mascot", "luxury_minimal",
]


def design_concepts_auto(theme, text, n, year="", same_line=False, palette_keys=None,
                         personalize_hint=False, use_claude=False):
    """AI tự chọn phong cách hợp nhất cho chủ đề rồi tạo n design. Mỗi concept kèm 'style'.
    palette_keys: nhóm style để AI chọn (None = VN_HOT_STYLES). personalize_hint: ưu tiên style
    hợp cá nhân hoá tên. use_claude: dùng Claude (ai_json) thay OpenAI để PHÂN TÍCH & chọn."""
    n = max(1, min(int(n or 3), 8))
    # Kèm LUÔN descriptor (đã tinh chỉnh cho thị trường VN) để AI tự pick bám đúng đặc điểm
    keys = [k for k in (palette_keys or VN_HOT_STYLES) if k in DESIGN_STYLES] or VN_HOT_STYLES
    palette = "\n".join("- %s: %s" % (DESIGN_STYLES[k][0], DESIGN_STYLES[k][1])
                        for k in keys if k in DESIGN_STYLES)
    parts = ["Tạo đúng %d design áo thun ĐẸP & DỄ BÁN nhất." % n]
    if personalize_hint:
        parts.append("Đây là design để CÁ NHÂN HOÁ — sẽ gắn TÊN người làm điểm nhấn. Hãy PHÂN TÍCH "
                     "trong các phong cách trên và CHỌN/MIX phong cách hợp nhất để TÊN nổi bật, dễ "
                     "đọc, đẹp & dễ bán; tránh phong cách quá rối khiến tên khó đọc. Chừa khoảng/bố "
                     "cục để đặt tên (chữ to trung tâm).")
    if (theme or "").strip():
        parts.append("Chủ đề/ngách: %s." % theme.strip())
    if (text or "").strip():
        parts.append("Chèn dòng chữ \"%s\" vào design (đúng chính tả, nổi bật)." % text.strip())
    else:
        parts.append("Tự nghĩ câu chữ/slogan ngắn ấn tượng phù hợp.")
    if (year or "").strip():
        parts.append("Thêm 1 DÒNG NĂM/SỐ riêng \"%s\" (đúng nguyên văn) làm chi tiết phụ, tách khỏi dòng chữ chính, cỡ nhỏ hơn." % year.strip())
    if same_line:
        parts.append("Nếu tên/chữ chính có 2 từ thì đặt CẢ 2 TỪ trên MỘT HÀNG NGANG DUY NHẤT, không xếp chồng; mỗi image prompt ghi rõ 'single-line lockup, not stacked'.")
    parts.append("Mỗi design CHỦ THỂ/phong cách KHÁC NHAU, đa dạng, tránh trùng lặp.")
    sys = DESIGN_AUTO_SYSTEM % palette
    user = " ".join(parts) + " Chỉ trả JSON."
    out = []
    for _attempt in range(2):
        if use_claude:
            raw = ai_json(sys, user, max_tokens=2800)       # Claude phân tích & chọn
        else:
            raw = openai_chat([{"role": "system", "content": sys},
                               {"role": "user", "content": user}], json_mode=True, max_tokens=2800)
        out = _parse_designs(raw)
        if out:
            break
    return out[:n]


# ChatGPT đóng vai art director: đánh giá & viết lại prompt do Claude đề xuất cho ĐẸP NHẤT
REFINE_SYSTEM = (
    "Bạn là ART DIRECTOR áo thun khó tính. Nhận các concept (style + image_prompt tiếng Anh) do "
    "một AI khác đề xuất. NHIỆM VỤ: ĐÁNH GIÁ rồi VIẾT LẠI image_prompt cho ĐẸP NHẤT có thể — bố "
    "cục cân đối, typography nổi bật & sắc nét, phối màu đẹp dễ bán, và QUAN TRỌNG: chừa bố cục/để "
    "TÊN người làm điểm nhấn (chữ chính to ở trung tâm, dễ đọc). Giữ NGUYÊN 'style' & 'title'. Mỗi "
    "prompt KẾT THÚC bằng 'isolated t-shirt print graphic on a plain solid white background, "
    "print-ready, no t-shirt, no mockup, no person'. Trả JSON "
    "{\"designs\":[{\"title\":..,\"style\":..,\"prompt\":..}]} đúng số lượng & đúng thứ tự."
)


def refine_concepts(concepts, theme=""):
    """ChatGPT đánh giá & đánh bóng lại prompt do Claude đề xuất. Lỗi -> giữ nguyên concepts."""
    if not concepts:
        return concepts
    payload = [{"title": c.get("title", ""), "style": c.get("style", ""), "prompt": c.get("prompt", "")}
               for c in concepts]
    u = ("Chủ đề: %s. Đánh giá & viết lại cho ĐẸP NHẤT (giữ style+title, chừa chỗ đặt tên người): %s "
         "Chỉ trả JSON." % (theme or "tự do", json.dumps(payload, ensure_ascii=False)))
    try:
        raw = openai_chat([{"role": "system", "content": REFINE_SYSTEM},
                           {"role": "user", "content": u}], json_mode=True, max_tokens=2800)
        out = _parse_designs(raw)
        if out and len(out) >= len(concepts):
            for i, c in enumerate(concepts):
                if i < len(out) and (out[i].get("prompt") or "").strip():
                    c["prompt"] = out[i]["prompt"]
                    if (out[i].get("style") or "").strip():
                        c["style"] = out[i]["style"]
    except Exception:
        pass
    return concepts


# Tệp khách -> tạo nguyên 1 BỘ design ĐỒNG BỘ
SEGMENTS = {
    "couple": {"name": "Couple", "n": 2,
               "short": ["Áo Anh (nam)", "Áo Em (nữ)"],
               "note": "2 mẫu GHÉP ĐÔI bổ trợ nhau (vd KING & QUEEN, 2 nửa trái tim, His & Hers, "
                       "ổ khoá & chìa khoá) — đứng cạnh nhau thành 1 cặp hoàn chỉnh"},
    "family": {"name": "Gia đình", "n": 3,
               "short": ["Bố (Daddy)", "Mẹ (Mommy)", "Bé (Kid)"],
               "note": "bộ GIA ĐÌNH đồng bộ (vd Daddy Bear / Mommy Bear / Baby Bear) — cùng nhân vật/"
                       "chủ đề/màu, đổi chữ & cỡ nhân vật theo vai bố / mẹ / bé"},
    "group": {"name": "Đội nhóm", "n": 1,
              "short": ["Áo đồng phục"],
              "note": "1 mẫu áo ĐỒNG PHỤC để CẢ NHÓM mặc GIỐNG NHAU (logo/tên nhóm/khẩu hiệu/màu), "
                      "không chia vai trò"},
}

# Pool ý tưởng GHÉP ĐÔI/ĐỒNG BỘ — random mỗi lần để tránh lặp (vd couple cứ ra KING & QUEEN)
_COUPLE_IDEAS = [
    "King & Queen", "Mr. Right & Mrs. Always Right", "Lock & Key (ổ khoá & chìa khoá)",
    "Two halves of one heart (2 nửa trái tim ghép)", "Player 1 & Player 2 (game)",
    "Sun & Moon (mặt trời & mặt trăng)", "His & Hers", "Yin & Yang",
    "Mr. & Mrs.", "Two puzzle pieces that fit", "Coffee & Cream", "Peanut Butter & Jelly",
    "Magnet North & South pole", "He's mine & She's mine", "Avocado two halves",
    "Mr. Bear & Mrs. Bear (gấu chàng & gấu nàng)", "Wifi & Password (kết nối)",
    "Left wing & Right wing (đôi cánh)", "You complete me (1 câu chia 2 vế)",
    "Beauty & Beast", "Tom & Jerry vibe (mèo & chuột)", "Cat person & Dog person",
    "King without Queen / Queen without King", "Since <năm yêu> matching couple",
    "Captain & Co-captain", "Salt & Pepper", "Day & Night",
]
_FAMILY_IDEAS = [
    "Daddy Bear / Mommy Bear / Baby Bear", "Big Lion / Lioness / Cub", "Papa / Mama / Mini",
    "The Boss / The Real Boss / The Little Boss", "Captain / Co-pilot / Crew",
    "Sun / Moon / Star (family galaxy)", "King / Queen / Prince–Princess",
    "Original / Remix / Limited Edition", "Penguin family (bố/mẹ/bé chim cánh cụt)",
    "Elephant family", "Dino family (T-Rex bố / mẹ / bé)", "Home Team — Dad/Mom/Kid jersey numbers",
    "Coffee / Latte / Babyccino", "Bee family (Papa/Mama/Baby bee)",
]
_GROUP_IDEAS = [
    "Class/Team crest badge + name + EST.", "Varsity collegiate team name + number",
    "Social club emblem", "Squad / Crew wordmark", "Tour-style back print (member list vibe)",
    "Mascot + team name", "Retro athletic department", "Founding year banner + laurels",
    "Streetwear hype team logo", "Esports team logo style", "United / Together slogan crest",
    "Minimal monogram team logo",
]

# Phong cách hợp THỊ TRƯỜNG VN cho từng tệp (khi không chọn style cụ thể -> AI ưu tiên trong nhóm này)
SEGMENT_STYLES = {
    "couple": ["couple_love", "vintage_americana", "calligraphy", "typography", "minimal_clean",
               "cute_mascot", "floral_quote", "y2k", "liquid_chrome", "scribble"],
    "family": ["cute_mascot", "mascot", "anime_nostalgia", "vintage_americana", "typography",
               "minimal_clean", "floral_quote", "retro_groovy", "flat_vector", "scribble"],
    "group": ["varsity", "social_club", "badge_patch", "vintage_americana", "streetwear",
              "mascot", "big_type", "statement_bold", "typography", "sport_statement",
              "retro_poster", "flat_vector", "comic_pop", "military", "graffiti_tag",
              "minimal_clean", "cute_mascot", "y2k_graffiti"],
}


def design_concepts_segment(segment, styles, theme, text, year="", same_line=False, auto_style=False):
    """Tạo 1 BỘ design đồng bộ theo tệp khách (couple/gia đình/nhóm). Trả list[concept]."""
    seg = SEGMENTS.get(segment)
    if not seg:
        return []
    n = seg["n"]
    valid = [s for s in (styles or []) if s in DESIGN_STYLES]
    if not auto_style and valid:
        if len(valid) == 1:
            style_line = "PHONG CÁCH CHUNG cho cả bộ: %s." % DESIGN_STYLES[valid[0]][1]
        else:
            style_line = "PHONG CÁCH CHUNG (trộn) cho cả bộ: %s." % " + ".join(DESIGN_STYLES[s][1] for s in valid)
    else:
        rec = [k for k in SEGMENT_STYLES.get(segment, VN_HOT_STYLES) if k in DESIGN_STYLES]
        random.shuffle(rec)   # xáo trộn -> mỗi lần AI không thấy varsity đầu tiên
        palette = "\n".join("- %s: %s" % (DESIGN_STYLES[k][0], DESIGN_STYLES[k][1]) for k in rec)
        pick = DESIGN_STYLES[rec[0]][0] if rec else ""
        style_line = ("TỰ CHỌN 1 phong cách CHUNG hợp THỊ TRƯỜNG VIỆT NAM & hợp tệp này — ĐA DẠNG "
                      "giữa các lần, ĐỪNG lúc nào cũng collegiate/varsity badge. Lần này HÃY THỬ "
                      "phong cách '%s' (hoặc 1 cái khác trong nhóm) nếu hợp; có thể trộn 2. BÁM ĐÚNG "
                      "mô tả đã chuẩn hoá VN:\n%s" % (pick, palette))
    if n == 1:
        # vd đội nhóm: cả nhóm mặc 1 áo giống nhau -> chỉ 1 mẫu, không vai trò
        parts = [
            "Tạo ĐÚNG 1 mẫu áo cho %s — %s." % (seg["name"], seg["note"]),
            style_line,
        ]
    else:
        roles_txt = "; ".join("Mẫu %d = %s" % (i + 1, r) for i, r in enumerate(seg["short"]))
        parts = [
            "Tạo 1 BỘ gồm ĐÚNG %d design ĐỒNG BỘ để mặc CHUNG cho %s." % (n, seg["name"]),
            "CÙNG concept, CÙNG phong cách, CÙNG bảng màu & chủ đề -> đứng cạnh nhau trông như 1 SET; "
            "KHÁC nhau theo VAI TRÒ.",
            "Đặc điểm bộ: %s." % seg["note"],
            "Vai trò từng mẫu (đúng thứ tự): %s." % roles_txt,
            style_line,
        ]
    ideas = {"couple": _COUPLE_IDEAS, "family": _FAMILY_IDEAS, "group": _GROUP_IDEAS}.get(segment, [])
    if not (theme or "").strip() and ideas:
        pool = ideas[:]
        random.shuffle(pool)
        parts.append("ĐA DẠNG Ý TƯỞNG — ĐỪNG mặc định lặp lại concept quen (vd couple cứ KING & "
                     "QUEEN). Lần này LẤY CẢM HỨNG từ MỘT trong các concept GHÉP ĐÔI/ĐỒNG BỘ NGẪU "
                     "NHIÊN sau (chọn cái hợp & mới mẻ nhất): %s." % "; ".join(pool[:6]))
    if (theme or "").strip():
        parts.append("Chủ đề/ngách: %s." % theme.strip())
    if (text or "").strip():
        parts.append("Lồng chữ \"%s\" hợp lý theo vai trò." % text.strip())
    if same_line:
        parts.append("Tên/chữ 2 từ thì đặt trên 1 hàng ngang (single-line lockup).")
    parts.append("NGÔN NGỮ chữ MẶC ĐỊNH tiếng Anh (chỉ tiếng Việt nếu user nhập sẵn). Màu GỌN 2–4 màu, dễ in.")
    parts.append("Mỗi prompt TIẾNG ANH, KẾT THÚC bằng 'isolated t-shirt print graphic on a plain solid "
                 "white background, print-ready, no t-shirt, no mockup, no person'.")
    parts.append("title = vai trò ngắn của mẫu. Trả JSON {\"designs\":[{\"title\":\"...\",\"prompt\":\"...\"}]} đúng %d mục." % n)
    sys = ("Bạn là designer áo thun chuyên thiết kế BỘ ĐỒNG BỘ (couple / gia đình / hội nhóm) cho thị "
           "trường Việt Nam — các mẫu trong bộ phải ăn khớp như một set khi mặc chung.")
    messages = [{"role": "system", "content": sys},
                {"role": "user", "content": " ".join(parts)}]
    out = []
    for _attempt in range(2):
        raw = openai_chat(messages, json_mode=True, max_tokens=2800)
        out = _parse_designs(raw)
        if out:
            break
    out = out[:n]
    # gắn nhãn vai trò chuẩn theo thứ tự
    for i, c in enumerate(out):
        role = seg["short"][i] if i < len(seg["short"]) else ("Mẫu %d" % (i + 1))
        c["title"] = "%s — %s" % (role, c.get("title", "Design"))
    return out


RATE_SYSTEM = (
    "Bạn là chuyên gia thẩm định thiết kế áo thun POD cho thị trường Việt Nam. Với MỖI design "
    "được đưa, chấm điểm 0–100 về TIỀM NĂNG BÁN CHẠY ở VN, cân nhắc: thẩm mỹ tổng thể, hợp "
    "trend & thị hiếu VN, độ rõ ràng & dễ in (không quá nhiều chi tiết/màu), tính thương mại "
    "(dễ mặc, dễ bán). KHẮT KHE và PHÂN HOÁ điểm rõ (đừng cho tất cả ~80): mẫu xuất sắc 85–95, "
    "khá 70–84, trung bình 50–69, yếu <50. Kèm 1 lý do NGẮN GỌN tiếng Việt (≤12 từ). "
    "Trả JSON {\"scores\":[{\"i\":<chỉ số>,\"score\":<số>,\"reason\":\"...\"}]} đúng số lượng."
)


def rate_designs(images_b64):
    """Chấm điểm list ảnh (base64). Trả list[{score:int, reason:str}] cùng thứ tự."""
    results = [None] * len(images_b64)
    BATCH = 6
    for start in range(0, len(images_b64), BATCH):
        chunk = images_b64[start:start + BATCH]
        content = [{"type": "text", "text": "Chấm điểm từng design dưới đây (theo đúng chỉ số i):"}]
        for idx, b in enumerate(chunk):
            content.append({"type": "text", "text": "Design i=%d:" % idx})
            content.append({"type": "image_url", "image_url": {"url": "data:image/png;base64," + b}})
        content.append({"type": "text", "text": "Chỉ trả JSON, đúng %d mục." % len(chunk)})
        messages = [{"role": "system", "content": RATE_SYSTEM},
                    {"role": "user", "content": content}]
        try:
            raw = openai_chat(messages, json_mode=True, max_tokens=900)
            data = json.loads(raw)
            arr = data.get("scores") if isinstance(data, dict) else data
            if not isinstance(arr, list):
                arr = next((v for v in data.values() if isinstance(v, list)), [])
            for item in arr:
                if not isinstance(item, dict):
                    continue
                i = int(item.get("i", -1))
                if 0 <= i < len(chunk):
                    sc = max(0, min(100, int(item.get("score", 0) or 0)))
                    results[start + i] = {"score": sc, "reason": (item.get("reason") or "").strip()[:80]}
        except Exception:
            pass
    # ô nào lỗi -> điểm trung tính
    return [r or {"score": 0, "reason": "Chưa chấm được"} for r in results]


DESIGN_MAX_TOTAL = 24      # trần tổng số mẫu / lần (tránh đốt credit)
DESIGN_WORKERS = 5         # số luồng gen ảnh song song


def run_design_job(job_id, styles, theme, text, n, size, transparent, ref=None, year="", same_line=False, auto_style=False, segment="", extra=""):
    # Bước 1: AI nghĩ n design. segment -> bộ đồng bộ; auto_style -> AI tự chọn; ref -> từ ảnh; else theo style
    err_msg = None
    style_tag = ""          # None = tag theo từng concept (auto)
    extra = (extra or "").strip()
    # KHÔNG chọn style + có prompt tự điền -> dùng prompt đó làm design
    custom_mode = bool(extra) and not segment and not auto_style and not ref and not styles
    try:
        if custom_mode:
            concepts = design_concepts_custom(extra, theme, text, n, year, same_line)
            style_tag = "Prompt tự điền"
        elif segment in SEGMENTS:
            concepts = design_concepts_segment(segment, styles, theme, text, year, same_line, auto_style)
            style_tag = SEGMENTS[segment]["name"]
        elif auto_style:
            concepts = design_concepts_auto(theme, text, n, year, same_line)
            style_tag = None
        elif ref:
            detected, concepts = design_concepts_from_ref(ref, theme, text, n, year, same_line)
            style_tag = "Ảnh ref" + (": " + detected if detected else "")
        else:
            concepts = design_concepts(styles, theme, text, n, year, same_line)
            style_tag = " + ".join(DESIGN_STYLES[s][0] for s in styles if s in DESIGN_STYLES)
    except urllib.error.HTTPError as e:
        concepts = []; err_msg = openai_error_message(e); style_tag = ""
    except Exception as e:
        concepts = []; err_msg = "Lỗi nghĩ mẫu: %s" % e; style_tag = ""
    concepts = concepts[:DESIGN_MAX_TOTAL]
    for c in concepts:
        tag = style_tag if style_tag is not None else ("AI chọn: " + (c.get("style") or "").strip() if (c.get("style") or "").strip() else "AI tự chọn")
        c["title"] = "[%s] %s" % (tag, c.get("title", "Design"))
        if extra and not custom_mode:   # có style -> prompt là YÊU CẦU THÊM; không style -> prompt là design (đã dùng ở custom_mode)
            c["prompt"] = c["prompt"] + " IMPORTANT EXTRA USER INSTRUCTIONS (must follow): " + extra
    with _batch_lock:
        job = BATCH_JOBS.get(job_id)
        if not job:
            return
        job["total"] = len(concepts) or 1
        if not concepts:
            job["errors"].append(err_msg or "AI chưa nghĩ được mẫu — thử lại, "
                                 "hoặc bớt số phong cách trộn / gõ chủ đề rõ hơn.")
            job["finished"] = True
            return

    # Bước 2: gen ảnh song song nhiều luồng
    def work(c):
        try:
            b64 = openai_generate(c["prompt"], size)
            if transparent and HAS_PIL:
                b64 = strip_bg_strong_b64(b64)
            g = gallery_add(b64, {"mode": "design", "prompt": c["title"]})
            return {"image": b64, "title": c["title"], "gallery": g}
        except urllib.error.HTTPError as e:
            return {"error": openai_error_message(e), "title": c["title"]}
        except Exception as e:
            return {"error": str(e), "title": c["title"]}

    with ThreadPoolExecutor(max_workers=DESIGN_WORKERS) as ex:
        for res in ex.map(work, concepts):
            with _batch_lock:
                job = BATCH_JOBS.get(job_id)
                if not job:
                    return
                job["done"] += 1
                if res.get("error"):
                    job["errors"].append("%s: %s" % (res.get("title", ""), res["error"]))
                else:
                    job["items"].append(res)
    with _batch_lock:
        if BATCH_JOBS.get(job_id):
            BATCH_JOBS[job_id]["finished"] = True


# --------------------------------------------------------------------------- #
#  PIPELINE TRỌN GÓI: AI tự nghĩ tên + tệp + style + màu -> design -> đổi màu áo
# --------------------------------------------------------------------------- #
AUTO_PIPE_SYSTEM = """Bạn là giám đốc sáng tạo shop áo thun PRINT-ON-DEMAND cá nhân hoá Việt Nam (brand rieng.vn, khách GenZ). Bạn LÊN KẾ HOẠCH cho từng mẫu — KHÔNG viết prompt vẽ (phần vẽ & chọn phong cách do hệ thống tự lo). Bạn TỰ NGHĨ: tệp khách, tên người để in, chủ đề, màu áo.

Trả về JSON: {"items":[{...}, ...]} với mỗi item:
- "tep": 1 trong "single" | "couple" | "family" | "group" (đa dạng; ưu tiên single & couple).
- "name": TÊN người để in. MỖI tên là TÊN VIỆT 2 CHỮ (tên đệm + tên, vd "Phương Linh", "Minh Anh", "Quốc Bảo", "Thuỳ Trang"). single = 1 tên 2 chữ; couple = 2 tên 2 chữ cách bởi "&" (vd "Minh Anh & Phương Linh"); family = tên Bố/Mẹ/Bé MỖI tên 2 chữ cách bởi "/" (vd "Quốc Nam / Thu Hà / Bảo Bi"); group = 1 tên nhóm. Tên Việt tự nhiên, giữ dấu.
- "date": NGÀY THÁNG NĂM in kèm tên (vd "20.10.2025", "Since 2020", "12/03/2024"). Hợp ngữ cảnh (couple = ngày kỷ niệm; single = ngày ý nghĩa).
- "theme": chủ đề/ngách ngắn (vd "mèo cưng", "cà phê đôi", "tuổi Dần", "hội bạn thân").
- "color": MÀU ÁO gợi ý hợp nhất, CHỈ 1 trong: "black" (đen), "white" (trắng), "brown" (nâu), "sand" (be), "forest" (xanh rêu), "red" (đỏ), "maroon" (đỏ đô).

QUY TẮC: mỗi item khác nhau hẳn (tệp/tên/chủ đề/màu đa dạng). Đúng số lượng yêu cầu."""


_SEG_DESC = {
    "single": "TỆP CÁ NHÂN — 1 người, \"name\" là 1 tên Việt 2 CHỮ (vd \"Phương Linh\")",
    "couple": "TỆP COUPLE — 2 người, \"name\" là 2 tên 2 CHỮ cách bởi \"&\" (vd \"Minh Anh & Phương Linh\")",
    "family": "TỆP GIA ĐÌNH — bố/mẹ/bé, \"name\" là 3 tên 2 CHỮ cách bởi \"/\" (vd \"Quốc Nam / Thu Hà / Bảo Bi\")",
    "group": "TỆP ĐỘI NHÓM — \"name\" là 1 tên nhóm",
}


def auto_pipe_plan(n, niche="", seg=""):
    """AI (Claude ưu tiên) tự nghĩ n brief cá nhân hoá. seg ép tệp (single/couple/family/group);
    để trống thì AI tự chọn tệp."""
    n = max(1, min(int(n or 3), 6))
    seg = seg if seg in PRODUCT_SEGMENTS else ""
    u = "Hãy nghĩ ĐÚNG %d mẫu áo cá nhân hoá đẹp & dễ bán nhất." % n
    if (niche or "").strip():
        u += " Xoay quanh ngách/gợi ý: %s." % niche.strip()
    if seg:
        u += " TẤT CẢ mẫu đều là %s." % _SEG_DESC[seg]
    raw = ai_json(AUTO_PIPE_SYSTEM, u, max_tokens=2000)
    items = []
    try:
        data = json.loads(raw)
        items = data.get("items") if isinstance(data, dict) else data
    except Exception:
        items = []
    out = []
    for it in (items or []):
        if not isinstance(it, dict):
            continue
        if not (it.get("name") or it.get("theme")):
            continue
        it["color"] = it.get("color") if it.get("color") in RECOLOR else "white"
        if seg:
            it["tep"] = seg
        else:
            it["tep"] = it.get("tep") if it.get("tep") in PRODUCT_SEGMENTS else "single"
        out.append(it)
    return out[:n]


def _split_names(name):
    """'Minh & An' / 'Nam / Hoa / Bi' -> ['Minh','An'] ..."""
    nm = name or ""
    for s in ("&", "/", ",", "+"):
        nm = nm.replace(s, "|")
    return [p.strip() for p in nm.split("|") if p.strip()]


def _gen_base_b64(prompt, size, transparent=True):
    """Vẽ design từ prompt (như tab Tạo design) + tách nền MẠNH."""
    b64 = openai_generate(prompt, size)
    if transparent and HAS_PIL:
        b64 = strip_bg_strong_b64(b64)
    return b64


def personalize_core(design_b64, name, size, transparent=True, date=""):
    """Cá nhân hoá tên (+ ngày) img2img — DÙNG LẠI logic tab Cá nhân hoá: giữ style, thay chữ chính."""
    base = ("Design a t-shirt graphic featuring the NAME \"%s\" as the focal text. KEEP THE SAME "
            "VISUAL STYLE as the reference image — same color palette, same font character, same "
            "illustration motifs/elements, same texture and mood — you may rework the composition. "
            "Use exactly this name text, keep all Vietnamese diacritics correct." % name)
    if len(name.split()) == 2:
        base += (" The name has exactly TWO words — they MUST be written TOGETHER on ONE single "
                 "horizontal line, side by side; NEVER stack them on separate lines or split them.")
    _allowed = 'the name "%s"' % name + ((' and the small date line "%s"' % date.strip()) if (date or "").strip() else "")
    base += (" CRITICAL — the ONLY readable text on the design must be " + _allowed + ". COMPLETELY "
             "REMOVE every other word, slogan, tagline, label, year, club/brand name and placeholder "
             "(e.g. '@yourtext', 'your text', 'DEAR', 'EST', 'SINCE', 'CLUB') from the reference; keep "
             "only non-text decorative graphic elements.")
    if (date or "").strip():
        base += (" Add a small secondary line with the date \"%s\" below the name, smaller, "
                 "in the same style." % date.strip())
    b64, _ = gen_design([(base64.b64decode(design_b64), "image/png")], "variation", base,
                        size, transparent)
    return b64


def recolor_core(design_b64, color, size):
    """Đổi màu hợp áo (cloner) — DÙNG LẠI logic tab Đổi màu áo."""
    b64, _ = gen_design([(base64.b64decode(design_b64), "image/png")], "cloner",
                        recolor_instruction(color), size, True)
    return b64


def run_auto_pipeline(job_id, plans, size, colors=None, transparent=True):
    """Quy trình THỐNG NHẤT: AI chọn style (56 style/bộ đồng bộ) -> cá nhân hoá tên+ngày ->
    đổi màu + lên áo cho TỪNG màu áo đã chọn -> 1 SP nhiều variant (sẵn đẩy Shopify).

    Mỗi brief nở thành 1 BỘ design theo tệp (single=1, couple=2, family=3, group=1) qua
    design_concepts_auto/segment; mỗi design: vẽ -> personalize -> (mỗi màu: recolor -> lên áo).
    """
    colors = [c for c in (colors or ["black", "white"]) if c in RECOLOR] or ["black"]
    # 1) Nở brief -> các task design (dùng lại design_concepts_auto / design_concepts_segment)
    tasks = []
    for brief in plans:
        tep = brief.get("tep", "single")
        theme = brief.get("theme", "")
        color = brief.get("color") if brief.get("color") in RECOLOR else "white"
        date = (brief.get("date") or "").strip()
        names = _split_names(brief.get("name", ""))
        try:
            if tep in SEGMENTS:
                concepts = design_concepts_segment(tep, [], theme, "", auto_style=True)
            else:
                concepts = design_concepts_auto(theme, "", 1)
        except Exception:
            concepts = []
        for idx, c in enumerate(concepts or []):
            nm = names[idx] if idx < len(names) else (names[-1] if names else "")
            role = ""
            if tep in SEGMENTS and idx < len(SEGMENTS[tep]["short"]):
                role = SEGMENTS[tep]["short"][idx]
            style = (c.get("style") or "").strip() or role
            tasks.append({"prompt": c.get("prompt", ""), "name": nm, "date": date,
                          "color": color, "tep": tep, "theme": theme, "style": style, "role": role})
    with _batch_lock:
        job = BATCH_JOBS.get(job_id)
        if not job:
            return
        job["total"] = len(tasks) or 1
        if not tasks:
            job["errors"].append("AI chưa nghĩ được concept — thử lại hoặc gõ ngách rõ hơn.")
            job["finished"] = True
            return

    # 2) Mỗi design: vẽ -> cá nhân hoá TÊN+NGÀY -> mỗi MÀU áo: đổi màu + lên áo -> 1 SP nhiều variant.
    def work(t):
        nm = (t.get("name") or "").strip()
        date = (t.get("date") or "").strip()
        label = (nm or t.get("role") or "Design") + (" · " + date if date else "")
        try:
            base = _gen_base_b64(t["prompt"], size, transparent)
            named = base
            if nm:
                try:
                    named = personalize_core(base, nm, size, transparent, date)
                except Exception:
                    named = base
            variants = []
            for col in colors:
                vi, hexv, _ = RECOLOR[col]
                try:
                    rec = recolor_core(named, col, size)
                except Exception:
                    rec = named
                shirt = compose_on_mockup(rec, col)        # ghép lên áo mockup màu đó
                variants.append({"color": col, "color_vi": vi, "hex": hexv,
                                 "recolored": rec, "shirt": shirt})
            g = gallery_add(named, {"mode": "design", "prompt": label})
            first = variants[0] if variants else {}
            return {"name": nm, "date": date, "tep": t["tep"], "style": t.get("style", ""),
                    "theme": t.get("theme", ""), "role": t.get("role", ""),
                    "design": base, "named": named, "variants": variants,
                    "color_vi": first.get("color_vi", ""), "shirt": first.get("shirt", named),
                    "title": label + (" · áo " + first.get("color_vi", "") if first else ""),
                    "gallery": g}
        except urllib.error.HTTPError as e:
            return {"error": openai_error_message(e), "title": label}
        except Exception as e:
            return {"error": str(e), "title": label}

    with ThreadPoolExecutor(max_workers=3) as ex:
        for res in ex.map(work, tasks):
            with _batch_lock:
                job = BATCH_JOBS.get(job_id)
                if not job:
                    return
                job["done"] += 1
                if res.get("error"):
                    job["errors"].append("%s: %s" % (res.get("title", ""), res["error"]))
                else:
                    job["items"].append(res)
    with _batch_lock:
        if BATCH_JOBS.get(job_id):
            BATCH_JOBS[job_id]["finished"] = True


# ===== WIZARD 3 BƯỚC: ① ra design → ② chọn & đổi màu → ③ lên áo (client) → Shopify =====
def _pipe_tasks(plans):
    """Nở brief -> task design (dùng design_concepts_auto/segment, kế thừa 56 style + bộ đồng bộ)."""
    tasks = []
    for brief in plans:
        tep = brief.get("tep", "single")
        theme = brief.get("theme", "")
        date = (brief.get("date") or "").strip()
        names = _split_names(brief.get("name", ""))
        try:
            if tep in SEGMENTS:
                concepts = design_concepts_segment(tep, [], theme, "", auto_style=True)
            else:
                concepts = design_concepts_auto(theme, "", 1)
        except Exception:
            concepts = []
        for idx, c in enumerate(concepts or []):
            nm = names[idx] if idx < len(names) else (names[-1] if names else "")
            role = ""
            if tep in SEGMENTS and idx < len(SEGMENTS[tep]["short"]):
                role = SEGMENTS[tep]["short"][idx]
            style = (c.get("style") or "").strip() or role
            tasks.append({"prompt": c.get("prompt", ""), "name": nm, "date": date,
                          "tep": tep, "theme": theme, "style": style, "role": role})
    return tasks


def run_pipe_designs(job_id, theme, n, seg, size, transparent=True):
    """BƯỚC 1 (GỘP): tạo DESIGN ĐẸP (AI auto-style) + CÁ NHÂN HOÁ (AI đặt tên 2 chữ) -> ra design CÓ TÊN.

    seg single -> n design auto-style; couple/family/group -> n BỘ đồng bộ. Mỗi design được AI
    đặt tên người Việt 2 chữ + ngày rồi personalize (img2img) luôn.
    """
    n = max(1, min(int(n or 3), 6))
    seg = seg if seg in PRODUCT_SEGMENTS else "single"
    concepts = []          # [(concept, role)]
    try:
        if seg in SEGMENTS:
            for _ in range(n):
                cs = design_concepts_segment(seg, [], theme, "", auto_style=True) or []
                for idx, c in enumerate(cs):
                    role = SEGMENTS[seg]["short"][idx] if idx < len(SEGMENTS[seg]["short"]) else ""
                    concepts.append((c, role))
        else:
            # ChatGPT phân tích TẤT CẢ 56 style -> chọn/mix concept hợp CÁ NHÂN HOÁ nhất
            cs = design_concepts_auto(theme, "", n, palette_keys=list(DESIGN_STYLES.keys()),
                                      personalize_hint=True) or []
            for c in cs:
                concepts.append((c, ""))
    except Exception:
        concepts = []
    with _batch_lock:
        job = BATCH_JOBS.get(job_id)
        if not job:
            return
        job["total"] = len(concepts) or 1
        if not concepts:
            job["errors"].append("AI chưa nghĩ được design — thử lại hoặc gõ chủ đề rõ hơn.")
            job["finished"] = True
            return

    # AI đặt tên 2 chữ cho từng design (mỗi concept 1 tên người)
    names = ai_personal_names([{"tep": "single", "theme": theme} for _ in concepts])

    def work(p):
        idx, (c, role) = p
        style = (c.get("style") or "").strip() or role
        info = names[idx] if (idx < len(names) and isinstance(names[idx], dict)) else {}
        nm = (info.get("name") or "").strip() or "Bạn Hiền"
        date = (info.get("date") or "").strip()
        label = nm + (" · " + date if date else "")
        try:
            base = _gen_base_b64(c["prompt"], size, transparent)
            try:
                named = personalize_core(base, nm, size, transparent, date)
            except Exception:
                named = base
            g = gallery_add(named, {"mode": "design", "prompt": label})
            return {"name": nm, "date": date, "style": style, "theme": theme, "tep": seg, "role": role,
                    "image": named, "named": named, "design": base, "title": label, "gallery": g}
        except urllib.error.HTTPError as e:
            return {"error": openai_error_message(e), "title": label}
        except Exception as e:
            return {"error": str(e), "title": label}

    with ThreadPoolExecutor(max_workers=3) as ex:
        for res in ex.map(work, list(enumerate(concepts))):
            with _batch_lock:
                job = BATCH_JOBS.get(job_id)
                if not job:
                    return
                job["done"] += 1
                if res.get("error"):
                    job["errors"].append("%s: %s" % (res.get("title", ""), res["error"]))
                else:
                    job["items"].append(res)
    with _batch_lock:
        if BATCH_JOBS.get(job_id):
            BATCH_JOBS[job_id]["finished"] = True


AI_NAME_SYSTEM = ("Bạn đặt TÊN NGƯỜI THẬT Việt Nam cho áo cá nhân hoá. Mỗi \"name\" là tên người "
                  "Việt 2 CHỮ (tên đệm + tên, vd \"Phương Linh\", \"Quốc Bảo\", \"Thuỳ Trang\"). "
                  "TUYỆT ĐỐI KHÔNG đặt tên theo chủ đề hay biệt danh (không \"Tiểu Mèo\", không tên thú "
                  "cưng) — chủ đề chỉ để tham khảo, tên phải là tên người bình thường. couple = 2 tên 2 "
                  "chữ cách \"&\"; gia đình = 3 tên 2 chữ cách \"/\"; nhóm = 1 tên nhóm. \"date\" là 1 "
                  "ngày ý nghĩa (vd \"20.10.2025\", \"Since 2021\"). Trả JSON "
                  "{\"items\":[{\"name\":..,\"date\":..}]} ĐÚNG số lượng & đúng thứ tự yêu cầu.")


def detect_product_seg(img_bytes):
    """AI nhìn design -> đoán TỆP (single/couple/family/group). Không rõ -> single."""
    sys = ("Phân loại 1 design áo thun thuộc TỆP nào để chụp ảnh sản phẩm: "
           "single (1 tên / 1 người), couple (đôi / tình yêu / 2 tên), "
           "family (gia đình / bố mẹ con), group (đội nhóm / tập thể / nhiều tên). "
           "Không rõ -> single. Trả JSON {\"seg\":\"single|couple|family|group\"}.")
    try:
        b64 = base64.b64encode(img_bytes).decode()
        content = [{"type": "text", "text": "Design này hợp tệp nào nhất? Chỉ trả JSON."},
                   {"type": "image_url", "image_url": {"url": "data:image/png;base64," + b64}}]
        raw = openai_chat([{"role": "system", "content": sys},
                           {"role": "user", "content": content}], json_mode=True, max_tokens=60)
        seg = (json.loads(raw) or {}).get("seg", "single")
        return seg if seg in PRODUCT_SEGMENTS else "single"
    except Exception:
        return "single"


def ai_personal_names(designs):
    """AI nghĩ tên 2 chữ + ngày cho từng design (theo tệp/chủ đề). Trả list {name,date}."""
    desc = "; ".join("mẫu %d (tệp %s, chủ đề %s)" % (i + 1, d.get("tep", "single"), d.get("theme", "") or "tự do")
                     for i, d in enumerate(designs))
    u = "Đặt tên + ngày cho %d mẫu áo cá nhân hoá: %s. Đúng %d mục, đúng thứ tự. Chỉ trả JSON." % (len(designs), desc, len(designs))
    try:
        raw = openai_chat([{"role": "system", "content": AI_NAME_SYSTEM},
                           {"role": "user", "content": u}], json_mode=True, max_tokens=1500)
        data = json.loads(raw)
        items = data.get("items") if isinstance(data, dict) else data
        return items or []
    except Exception:
        return []


def run_pipe_personalize(job_id, designs, size):
    """BƯỚC 2: AI tự nghĩ tên 2 chữ -> cá nhân hoá (img2img) các design đã chọn."""
    names = ai_personal_names(designs)
    with _batch_lock:
        job = BATCH_JOBS.get(job_id)
        if job:
            job["total"] = len(designs) or 1

    def work(pair):
        i, d = pair
        img = d.get("image") or ""
        if img.startswith("data:"):
            img = img.split(",", 1)[-1]
        info = names[i] if (i < len(names) and isinstance(names[i], dict)) else {}
        nm = (info.get("name") or "").strip() or "Bạn Hiền"
        date = (info.get("date") or "").strip()
        label = nm + (" · " + date if date else "")
        try:
            named = personalize_core(img, nm, size, True, date)
        except Exception:
            named = img
        g = gallery_add(named, {"mode": "design", "prompt": label})
        return {"name": nm, "date": date, "tep": d.get("tep", "single"), "style": d.get("style", ""),
                "theme": d.get("theme", ""), "role": d.get("role", ""),
                "image": named, "named": named, "design": img, "title": label, "gallery": g}

    with ThreadPoolExecutor(max_workers=3) as ex:
        for res in ex.map(work, list(enumerate(designs))):
            with _batch_lock:
                job = BATCH_JOBS.get(job_id)
                if not job:
                    return
                job["done"] += 1
                if res.get("error"):
                    job["errors"].append("%s: %s" % (res.get("title", ""), res["error"]))
                else:
                    job["items"].append(res)
    with _batch_lock:
        if BATCH_JOBS.get(job_id):
            BATCH_JOBS[job_id]["finished"] = True


def run_pipe_recolor(job_id, designs, colors, size):
    """BƯỚC 2: với mỗi design ĐÃ CHỌN -> đổi màu cho từng màu áo. Trả variants[] (recolored)."""
    colors = [c for c in (colors or ["black", "white"]) if c in RECOLOR] or ["black"]

    def work(d):
        img = d.get("image") or ""
        if img.startswith("data:"):
            img = img.split(",", 1)[-1]
        meta = {k: d.get(k, "") for k in ("name", "date", "tep", "style", "theme", "role")}
        label = (meta.get("name") or meta.get("role") or "Design") + (" · " + meta["date"] if meta.get("date") else "")
        try:
            variants = []
            for col in colors:
                vi, hexv, _ = RECOLOR[col]
                try:
                    rec = recolor_core(img, col, size)
                except Exception:
                    rec = img
                variants.append({"color": col, "color_vi": vi, "hex": hexv, "recolored": rec})
            return dict(meta, image=img, named=img, design=img, variants=variants, title=label)
        except urllib.error.HTTPError as e:
            return {"error": openai_error_message(e), "title": label}
        except Exception as e:
            return {"error": str(e), "title": label}

    with _batch_lock:
        job = BATCH_JOBS.get(job_id)
        if job:
            job["total"] = len(designs) or 1
    with ThreadPoolExecutor(max_workers=3) as ex:
        for res in ex.map(work, designs):
            with _batch_lock:
                job = BATCH_JOBS.get(job_id)
                if not job:
                    return
                job["done"] += 1
                if res.get("error"):
                    job["errors"].append("%s: %s" % (res.get("title", ""), res["error"]))
                else:
                    job["items"].append(res)
    with _batch_lock:
        if BATCH_JOBS.get(job_id):
            BATCH_JOBS[job_id]["finished"] = True


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
        # DESPILL an toàn (khử ám hồng do magenta): nâng kênh Green = max(G, min(R,B)).
        # CHỈ áp ở RÌA bán trong suốt (0 < alpha < 255) — KHÔNG đụng phần CHỮ/đồ hoạ
        # đặc (alpha=255) để giữ NGUYÊN màu chữ (đỏ/hồng/tím cũng không bị xám hoá).
        min_rb = ImageChops.darker(rb, bb)
        gb2 = ImageChops.lighter(gb, min_rb)
        rim = alpha.point(lambda v: 255 if 0 < v < 255 else 0)   # chỉ viền anti-alias
        gb_final = Image.composite(gb2, gb, rim)
        out = Image.merge("RGBA", (rb, gb_final, bb, alpha))
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


def strip_bg_strong(raw):
    """ĐÃ REVERT VỀ BAN ĐẦU: tách nền PHẲNG (remove_flat_bg) cho các tác vụ TẠO DESIGN.
    Lý do: rembg U2Net cắt SAI với design chữ/logo nền phẳng (tưởng cả khối là vật thể →
    cắt nham nhở). Tách nền phẳng (xoá nền trơn từ mép) sạch hơn cho design AI.
    (Tab Tách nền riêng vẫn dùng rembg qua /api/remove-bg để user chủ động chọn.)"""
    return remove_flat_bg(raw)


def strip_bg_strong_b64(b64):
    """Như strip_bg_strong nhưng nhận/đưa base64 (tiện thay tại chỗ)."""
    try:
        return base64.b64encode(strip_bg_strong(base64.b64decode(b64))).decode()
    except Exception:
        return b64


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


def gen_design(images, mode, user_prompt, size, transparent, override=None, quality=""):
    """Tạo design. override = prompt người dùng tự sửa (nếu có) -> dùng thẳng.
    quality: '' (mặc định) | 'high' | 'medium' | 'low' -> độ nét gpt-image.
    Trả về (b64, prompt_đã_dùng).
    """
    override = (override or "").strip()
    if transparent and NATIVE_TRANSPARENT:
        p = override or build_prompt(mode, user_prompt, "transparent")
        try:
            return openai_edit(images, p, size, native_transparent=True, quality=quality), p
        except urllib.error.HTTPError as e:
            msg = e.read().decode("utf-8", "ignore")
            if not (e.code == 400 and "background" in msg):
                raise urllib.error.HTTPError(e.url, e.code, msg, e.headers, None)
    p = override or build_prompt(mode, user_prompt, "chroma" if transparent else "solid")
    b64 = openai_edit(images, p, size, native_transparent=False, quality=quality)
    # TÍCH HỢP: clone xong tự tách nền luôn -> trả design trong suốt sẵn.
    # Ưu tiên rembg AI (U2Net + alpha matting: viền mịn, giữ phần trắng của design); fallback flat.
    if transparent and HAS_PIL:
        try:
            raw = base64.b64decode(b64)
            out = None
            if HAS_REMBG:
                try:
                    out = remove_bg_ai(raw, "u2net", True)
                except Exception:
                    out = None
            raw = out if out else remove_flat_bg(raw)
            b64 = base64.b64encode(raw).decode()
        except Exception:
            pass  # nếu lỗi vẫn trả design có nền
    return b64, p


# ===================== TAB DESIGN TÊN CÁ NHÂN HOÁ (Custom-name T-shirt niche) =====================
# Các style ĐẸP & PHỔ BIẾN của niche áo in tên (curated từ thị trường custom-name tee)
NAMEDES_STYLES = {
    "globe": ("🌐 Retro Globe", "trendy retro outlined PUFFY bubble letters in cream & warm brown with a clean outline, a small minimalist wireframe GLOBE icon plus a few sparkle stars above the name, and a slim horizontal bar showing \"{stamp}\"; soft beige/cream aesthetic, modern Gen-Z 'studio' vibe"),
    "varsity": ("🏈 Varsity Athletic", "bold collegiate VARSITY athletic lettering, slightly italic with a layered drop-shadow outline, stars and dynamic speed/lightning lines, a small \"{stamp}\" tab underneath; energetic sporty look in two contrasting colours such as golden yellow + navy"),
    "retro70s": ("🌻 Retro 70s Groovy", "warm 1970s groovy ROUNDED bubble typography, funky retro letters, earthy palette (mustard, terracotta, cream), a vintage sunburst or rainbow arc behind, nostalgic feel, \"{stamp}\" as a small retro tag"),
    "y2k": ("💿 Y2K Chrome", "glossy Y2K CHROME metallic bubble letters with reflections and sparkle stars, early-2000s silver-and-blue gradient aesthetic, \"{stamp}\" in a small chrome tag"),
    "beach": ("🏝️ Beach Summer", "summer BEACH theme: palm-tree silhouettes, a setting sun, a surfboard and beach chair; the name in a relaxed ARCHED script ABOVE the scene; warm orange + black line-art, \"{stamp}\" as a small caption"),
    "vintage": ("📻 Vintage Americana", "distressed VINTAGE americana screen-print, faded textured retro letters inside a worn badge/banner, muted warm palette, \"{stamp}\" in old-style numerals"),
    "streetwear": ("🔥 Streetwear", "bold modern STREETWEAR graphic, chunky graffiti-influenced letters, urban high-contrast black/white with one accent colour, \"{stamp}\" as a sticker tag"),
    "cute": ("🧸 Cute Bubble", "CUTE kawaii puffy bubble letters, soft pastel colours, tiny hearts and stars doodles around, playful adorable, \"{stamp}\" in a little ribbon"),
    "minimal": ("⚪ Minimalist", "clean MINIMALIST modern typography — an elegant thin script or simple sans-serif, monochrome, lots of negative space, \"{stamp}\" very small and subtle"),
    "couple_heart": ("💞 Couple Heart", "a small photo-frame heart at the top, the name in a clean rounded font below, a tiny tagline, soft modern romantic vibe, \"{stamp}\" under the name"),
}
VN_NAMES = ["Hoàng Long", "Kim Anh", "Đức Minh", "Ngọc Hân", "Văn Tâm", "Phương Linh", "Bảo Ngọc",
            "Minh Khôi", "Thu Hà", "Gia Bảo", "Lê Phương", "Trần Hoà", "Nguyễn An", "Quỳnh Như",
            "Tuấn Kiệt", "Mai Chi", "Khánh Vy", "Hải Đăng", "Thanh Trúc", "Anh Thư", "Bảo Trâm",
            "Đăng Khoa", "Phương Anh", "Ngọc Diệp", "Hữu Phước", "Tường Vy", "Quốc Bảo", "Diễm My",
            "Nhật Minh", "Cẩm Tú", "Gia Hân", "Đình Phong", "Thảo Nguyên", "Hoàng Yến", "Trí Dũng"]

# Tên nhỏ / tên thân mật phụ (đa dạng) — chèn nhỏ dưới tên chính, mỗi bản 1 cái khác
# Biệt danh phụ = TÊN NGƯỜI (bỏ kiểu 'Cục Cưng/Honey'); ưu tiên tên gọi 1 chữ
VN_NICKS = ["Nam", "Anh", "My", "Vy", "Linh", "Trang", "Mai", "Huy", "Lan", "Hân",
            "Khôi", "Ngọc", "Thảo", "Hương", "Quân", "Bảo", "Trâm", "Tú", "Hà", "Minh",
            "Minh Anh", "Khánh Linh", "Ngọc Mai", "Phương Thảo", "Đức Huy", "Quỳnh Anh", "Lan Hương"]


def name_suggest():
    y = random.randint(2000, 2025)
    if random.random() < 0.35:
        stamp = "EST %d.%d.%d" % (random.randint(1, 28), random.randint(1, 12), y)   # EST + ngày
    else:
        stamp = "EST %d" % y                                                          # EST + năm
    return random.choice(VN_NAMES), stamp


def name_design_prompt(name, stamp, style_key):
    label, frag = NAMEDES_STYLES.get(style_key, NAMEDES_STYLES["globe"])
    frag = frag.replace("{stamp}", stamp or "")
    return ("A flat VECTOR T-SHIRT PRINT DESIGN (artwork / graphic ONLY — NOT a t-shirt mockup, NOT a "
            "person, NOT a photo of a shirt). It is a personalised CUSTOM-NAME tee design in the "
            "custom-name t-shirt niche style. The MAIN focal element is the Vietnamese name \""
            + name + "\" rendered as large stylised lettering in this exact style: " + frag + ". "
            "Spell the name EXACTLY \"" + name + "\" with correct Vietnamese diacritics; do NOT add any "
            "other name. Centered, "
            "balanced composition on a PLAIN PURE WHITE background, crisp clean PRINT-READY vector "
            "artwork, BOLD HIGH-CONTRAST, ready to screen-print on a t-shirt. No mockup, no shirt, no "
            "human, no watermark.")


_NAME_AI_SUFFIX = (" IMPORTANT: render as a FLAT VECTOR t-shirt PRINT design, ARTWORK ONLY — NOT a "
                   "t-shirt mockup, NOT a person, NOT a photo of a shirt. Centered, balanced composition "
                   "on a PLAIN PURE WHITE background, crisp clean PRINT-READY vector, bold high-contrast. "
                   "Spell the name EXACTLY as given with correct Vietnamese diacritics; no other names, "
                   "no watermark.")


def name_concepts(name, stamp, n):
    """AI tự DÙNG KIẾN THỨC về ngách custom-name tee -> nghĩ n concept design (mỗi cái 1 prompt)."""
    if not API_KEY:
        return []
    sys = ("You are a WORLD-CLASS print-on-demand designer and trend expert for the global CUSTOM-NAME / "
           "PERSONALISED-NAME T-SHIRT niche (the big Etsy / Amazon Merch / US POD market). You have deep, "
           "up-to-date knowledge of what name designs are BEST-SELLING and trending in this niche right "
           "now. Use YOUR OWN expert judgement to create the most commercial, on-trend, giftable name "
           "graphics — YOU freely decide the styles, typography, colours and decorative elements that "
           "will sell best. The name is a VIETNAMESE name (keep its exact spelling and diacritics). Keep "
           "designs high-contrast and print-ready.")
    acc = (' Add the small accent text "%s" as a tasteful sub-element.' % stamp) if stamp else ""
    user = ("Design %d DISTINCT, best-selling, on-trend CUSTOM-NAME t-shirt PRINT designs whose single "
            "HERO element is the Vietnamese name \"%s\".%s Use your expert knowledge of the niche — pick "
            "whatever styles you judge will sell best right now, make them genuinely DIFFERENT from each "
            "other, and let the name's vibe guide you. For EACH, write a detailed English "
            "IMAGE-GENERATION prompt for a flat vector print artwork on a pure white background "
            "(typography style, exact colours, decorative elements, layout). Return strict JSON: "
            "{\"concepts\":[{\"title\":\"<short style label>\",\"prompt\":\"<the detailed prompt>\"}]} "
            "with EXACTLY %d items." % (n, name, acc, n))
    try:
        out = openai_chat([{"role": "system", "content": sys}, {"role": "user", "content": user}],
                          json_mode=True, max_tokens=2200, model=BEST_TEXT_MODEL)
        cons = (json.loads(out).get("concepts") or [])
        res = []
        for c in cons[:n]:
            p = (c.get("prompt") or "").strip()
            if p:
                res.append({"title": (c.get("title") or "AI design")[:40], "prompt": p + _NAME_AI_SUFFIX})
        return res
    except Exception:
        return []


def run_name_design_job(job_id, name, stamp, style, n, transparent):
    keys = list(NAMEDES_STYLES.keys())
    # CHẾ ĐỘ AI: để AI tự nghiên cứu niche + nghĩ concept (khi không chọn style cứng)
    ai_cons = name_concepts(name, stamp, n) if style not in NAMEDES_STYLES else []

    def work(i):
        if style in NAMEDES_STYLES:
            title = NAMEDES_STYLES[style][0]; prompt = name_design_prompt(name, stamp, style)
        elif i < len(ai_cons):
            title = "🤖 " + ai_cons[i]["title"]; prompt = ai_cons[i]["prompt"]
        else:
            sk = random.choice(keys); title = NAMEDES_STYLES[sk][0]; prompt = name_design_prompt(name, stamp, sk)
        try:
            b64 = openai_generate(prompt, "1024x1024")
            if transparent and HAS_PIL:
                b64 = strip_bg_strong_b64(b64)
            b64 = strip_ai_meta_b64(b64)
            g = gallery_add(b64, {"mode": "design", "prompt": "Tên: %s · %s" % (name, title)})
            return {"image": b64, "title": title, "gallery": g}
        except urllib.error.HTTPError as e:
            return {"error": openai_error_message(e), "title": title}
        except Exception as e:
            return {"error": str(e), "title": title}

    with ThreadPoolExecutor(max_workers=3) as ex:
        for res in ex.map(work, range(n)):
            with _batch_lock:
                job = BATCH_JOBS.get(job_id)
                if not job:
                    return
                job["done"] += 1
                if res.get("error"):
                    job["errors"].append("%s: %s" % (res.get("title", ""), res["error"]))
                else:
                    job["items"].append(res)
    with _batch_lock:
        if BATCH_JOBS.get(job_id):
            BATCH_JOBS[job_id]["finished"] = True


def clone_compare_fix(orig_bytes, result_bytes, size="auto", transparent=True):
    """AI đối chiếu MẪU GỐC vs KẾT QUẢ (sau tách nền) -> liệt kê khác biệt -> vẽ lại từ gốc cho khớp.
    Trả (b64_đã_sửa, info{match,differences,fix})."""
    ob = base64.b64encode(orig_bytes).decode()
    rb = base64.b64encode(result_bytes).decode()
    sys = ("Bạn là QC thiết kế áo. ẢNH 1 = mẫu GỐC. ẢNH 2 = KẾT QUẢ sau khi clone/tách nền. "
           "Chỉ so sánh PHẦN ĐỒ HOẠ/CHỮ (artwork), BỎ QUA màu nền — nền luôn để TRONG SUỐT. "
           "So sánh KỸ: chi tiết/nét/CHỮ (đúng từng chữ & dấu tiếng Việt)/MÀU CHỮ/bố cục/độ dày nét "
           "bị MẤT, SAI, LỆCH, RĂNG CƯA, THIẾU hoặc THỪA so với gốc. Trả JSON "
           "{\"match\": true/false, \"differences\": [\"...\" tiếng Việt ngắn gọn về ĐỒ HOẠ], "
           "\"fix\": \"câu lệnh TIẾNG ANH vẽ lại đồ hoạ/chữ cho GIỐNG HỆT mẫu gốc (giữ mọi chi "
           "tiết/chữ/màu chữ/bố cục/độ dày nét). TUYỆT ĐỐI KHÔNG nhắc tới màu nền/background.\"}.")
    content = [{"type": "text", "text": "ẢNH 1 = GỐC. ẢNH 2 = KẾT QUẢ. So sánh & trả JSON đúng schema."},
               {"type": "image_url", "image_url": {"url": "data:image/png;base64," + ob}},
               {"type": "image_url", "image_url": {"url": "data:image/png;base64," + rb}}]
    info = {"match": True, "differences": [], "fix": ""}
    try:
        raw = openai_chat([{"role": "system", "content": sys},
                           {"role": "user", "content": content}], json_mode=True, max_tokens=900)
        d = json.loads(raw)
        if isinstance(d, dict):
            info = d
    except Exception:
        pass
    fix = (info.get("fix") or "").strip()
    instr = ("Recreate the reference design with 100% fidelity — IDENTICAL artwork, every letter and "
             "word (correct Vietnamese diacritics), every color, detail, line and composition as the "
             "reference image. Do NOT omit, simplify, recolor, move or redraw anything. "
             + (("Specifically fix these issues: " + fix + " ") if fix else "")
             + "Output crisp and complete on a clean, fully transparent background with smooth "
               "anti-aliased edges.")
    b64, _ = gen_design([(orig_bytes, "image/png")], "cloner", "", size, transparent, override=instr)
    return b64, info


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


# DESIGN SẠCH (artwork) -> nguồn tốt cho ảnh ads. KHÔNG lấy cutout (user up linh tinh).
_DESIGN_MODES = ("design", "namedesign", "personalize", "recolor", "auto")


def recent_design_bytes(n=1):
    """Lấy n DESIGN SẠCH gần nhất của user từ kho (bỏ ảnh rác/nhỏ < 8KB)."""
    out = []
    for it in gallery_load():
        if it.get("mode") in _DESIGN_MODES:
            p = os.path.join(GALLERY_DIR, "%s.png" % it.get("id"))
            try:
                with open(p, "rb") as f:
                    data = f.read()
            except Exception:
                continue
            if len(data) < 8000:   # bỏ ảnh rác/test quá nhỏ
                continue
            out.append(data)
            if len(out) >= n:
                break
    return out


def recent_products(n=5):
    """Lấy n SẢN PHẨM gần nhất từ Shopify -> [{img(bytes), link, title}] (Trợ lý AI gen ads nhiều SP)."""
    out = []
    if not shopify_configured():
        return out
    try:
        st, d = shopify_api("GET", "products.json?limit=%d&order=created_at+desc" % max(5, min(50, n)))
        for pr in (d.get("products") or [])[:n]:
            img = (pr.get("image") or {}).get("src") or ((pr.get("images") or [{}])[0].get("src") if pr.get("images") else "")
            if not img:
                continue
            ib, _ = fetch_image_bytes(img)
            if not ib:
                continue
            link = ("https://rieng.vn/products/%s" % pr.get("handle", "")) if pr.get("handle") else ""
            out.append({"img": ib, "link": link, "title": pr.get("title", "")})
    except Exception:
        pass
    return out


def gallery_add(b64, meta):
    os.makedirs(GALLERY_DIR, exist_ok=True)
    gid = "d%d" % int(time.time() * 1000)
    with open(os.path.join(GALLERY_DIR, gid + ".png"), "wb") as f:
        f.write(base64.b64decode(b64))
    items = gallery_load()
    item = {"id": gid, "ts": int(time.time()), "url": "/gallery/%s.png" % gid,
            "mode": meta.get("mode"), "prompt": meta.get("prompt", "")[:160]}
    if meta.get("ads"):
        item["ads"] = meta["ads"]   # lưu concept/name/hook/aspect/bg để Tạo lại
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
                    "mine": not f.startswith("tee_"),
                    "side": "back" if f.startswith("back_") else "front"})
    return out


def save_user_mockup(raw, name, color, side="front"):
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
        prefix = "back_" if side == "back" else "u"
        fname = "%s%d_%s.png" % (prefix, int(time.time() * 1000), safe or "ao")
        label = name or ("Áo sau" if side == "back" else "Áo trước")
    with open(os.path.join(MOCKUP_DIR, fname), "wb") as f:
        f.write(raw)
    idx = mockup_labels(); idx[fname] = label; save_mockup_labels(idx)
    return {"file": fname, "url": "/mockups/%s" % fname, "name": label,
            "mine": not fname.startswith("tee_"),
            "side": "back" if fname.startswith("back_") else "front"}


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
        if path == "/api/version":
            return self.json(200, {"version": APP_VERSION, "image_model": MODEL,
                                   "agent_brain": ("Claude " + ANTHROPIC_MODEL) if ANTHROPIC_API_KEY else "gpt-4o (chưa có ANTHROPIC_API_KEY)"})
        if path == "/api/fb-status":
            return self.json(200, {"configured": fb_configured(),
                                   "ad_account": FB_AD_ACCOUNT_ID, "page": FB_PAGE_ID})
        if path == "/api/fb-perms":
            if not fb_configured():
                return self.json(200, {"configured": False})
            st, d = fb_graph("GET", "me/permissions", {})
            perms = [p["permission"] for p in (d.get("data") or []) if p.get("status") == "granted"]
            return self.json(200, {"perms": perms, "can_ads": "ads_management" in perms,
                                   "can_post": "pages_manage_posts" in perms})
        if path == "/api/fb-post-test":
            if not fb_configured():
                return self.json(200, {"ok": False, "error": "chưa cấu hình"})
            ptok = fb_page_token()
            if not ptok:
                return self.json(200, {"ok": False, "step": "page_token", "error": "không lấy được page token"})
            st, d = fb_graph("POST", "%s/photos" % FB_PAGE_ID,
                             {"url": "https://www.facebook.com/images/fb_icon_325x325.png",
                              "published": "false"}, ptok)
            if st != 200 or not d.get("id"):
                return self.json(200, {"ok": False, "step": "upload", "error": fb_err(d)})
            pid = d["id"]
            fb_graph("DELETE", "%s" % pid, {}, ptok)   # dọn ảnh test
            return self.json(200, {"ok": True, "msg": "Upload ảnh (ẩn) lên Trang + xoá OK → đăng Fanpage chạy được."})
        if path == "/api/fb-campaigns":
            if not fb_configured():
                return self.json(200, {"campaigns": []})
            st, d = fb_graph("GET", "act_%s/campaigns" % FB_AD_ACCOUNT_ID,
                             {"fields": "id,name,status", "limit": "100"})
            if st != 200:
                return self.json(400, {"error": fb_err(d)})
            return self.json(200, {"campaigns": d.get("data") or []})
        if path == "/api/fb-page-posts":
            return self.json(200, fb_page_posts(14))
        if path == "/api/sched-list":
            with _sched_lock:
                items = sched_load()
            items = sorted(items, key=lambda x: x.get("when", 0))
            return self.json(200, {"items": items})
        if path == "/api/concept-styles":
            return self.json(200, {"styles": concept_style_override()})
        if path == "/api/agent-status":
            return self.json(200, {"running": AGENT_RUN["running"], "cur": AGENT_RUN["cur"],
                                   "total": AGENT_RUN["total"], "done": AGENT_RUN["done"],
                                   "log": AGENT_RUN["log"]})
        if path == "/api/name-suggest":
            nm, stamp = name_suggest()
            return self.json(200, {"name": nm, "stamp": stamp})
        if path == "/api/name-styles":
            return self.json(200, {"styles": [{"key": k, "label": v[0]} for k, v in NAMEDES_STYLES.items()]})
        if path == "/api/autopost-status":
            cfg = autopost_load()
            nxt = float(cfg.get("next_at", 0))
            return self.json(200, {
                "enabled": cfg.get("enabled"), "per_day": cfg.get("per_day"),
                "channels": cfg.get("channels"), "start_hour": cfg.get("start_hour"),
                "end_hour": cfg.get("end_hour"), "per_set": cfg.get("per_set"),
                "done_today": cfg.get("done_today"), "running": _autopost_running[0],
                "next_at": nxt, "next_in": max(0, int(nxt - time.time())) if nxt else 0,
                "log": (cfg.get("log") or [])[-10:]})
        if path == "/api/pgpost-list":
            with _pgpost_lock:
                items = pgpost_load()
            return self.json(200, {"items": items, "pushing": {
                "running": PGPOST_PUSH["running"], "done": PGPOST_PUSH["done"],
                "total": PGPOST_PUSH["total"], "gap": PGPOST_PUSH["gap"],
                "next_in": PGPOST_PUSH["next_in"], "log": PGPOST_PUSH["log"][-8:]}})
        if path == "/api/adpost-list":
            with _adpost_lock:
                items = adpost_load()
            return self.json(200, {"items": items, "pushing": {
                "running": ADPOST_PUSH["running"], "done": ADPOST_PUSH["done"],
                "total": ADPOST_PUSH["total"], "gap": ADPOST_PUSH["gap"],
                "next_in": ADPOST_PUSH["next_in"], "log": ADPOST_PUSH["log"][-8:]}})
        if path == "/api/ig-status":
            if not fb_configured():
                return self.json(200, {"connected": False, "reason": "Chưa cấu hình Facebook."})
            igid = ig_user_id()
            uname = ""
            if igid:
                st, d = fb_graph("GET", "%s" % igid, {"fields": "username"})
                uname = (d or {}).get("username") or ""
            st, d = fb_graph("GET", "me/permissions", {})
            perms = [p["permission"] for p in (d.get("data") or []) if p.get("status") == "granted"]
            can_pub = "instagram_content_publish" in perms
            return self.json(200, {"connected": bool(igid), "ig_id": igid or "",
                                   "username": uname, "can_publish": can_pub})
        if path == "/api/fb-ads-list":
            if not fb_configured():
                return self.json(200, {"campaigns": [], "configured": False})
            qs = urllib.parse.parse_qs(self.path.split("?", 1)[1]) if "?" in self.path else {}
            rng = (qs.get("range") or ["last_7d"])[0]
            if rng not in ("today", "yesterday", "last_7d", "last_14d", "last_30d", "maximum"):
                rng = "last_7d"
            fields = ("id,name,status,effective_status,objective,"
                      "insights.date_preset(%s){spend,reach,impressions,clicks,ctr,cpc}" % rng)
            st, d = fb_graph("GET", "act_%s/campaigns" % FB_AD_ACCOUNT_ID,
                             {"fields": fields, "limit": "100"})
            if st != 200:
                return self.json(400, {"error": fb_err(d)})
            out = []
            for c in (d.get("data") or []):
                ins = ((c.get("insights") or {}).get("data") or [{}])
                ins = ins[0] if ins else {}
                out.append({"id": c.get("id"), "name": c.get("name"), "status": c.get("status"),
                            "effective_status": c.get("effective_status"), "objective": c.get("objective"),
                            "spend": ins.get("spend"), "reach": ins.get("reach"),
                            "impressions": ins.get("impressions"), "clicks": ins.get("clicks"),
                            "ctr": ins.get("ctr"), "cpc": ins.get("cpc")})
            mgr = "https://www.facebook.com/adsmanager/manage/campaigns?act=%s" % FB_AD_ACCOUNT_ID
            return self.json(200, {"campaigns": out, "range": rng, "manager_url": mgr})
        if path == "/api/fb-adsets":
            if not fb_configured():
                return self.json(200, {"adsets": []})
            qs = urllib.parse.parse_qs(self.path.split("?", 1)[1]) if "?" in self.path else {}
            cid = (qs.get("campaign_id") or [""])[0]
            edge = ("%s/adsets" % cid) if cid else ("act_%s/adsets" % FB_AD_ACCOUNT_ID)
            st, d = fb_graph("GET", edge, {"fields": "id,name,campaign_id", "limit": "100"})
            if st != 200:
                return self.json(400, {"error": fb_err(d)})
            return self.json(200, {"adsets": d.get("data") or []})
        if path == "/api/me":
            u = self.current_user()
            if not u:
                return self.json(401, {"error": "Chưa đăng nhập"})
            return self.json(200, {"user": u})
        if path == "/api/gallery":
            return self.json(200, {"items": gallery_load()})
        if path == "/api/mockups":
            return self.json(200, {"items": list_mockups()})
        if path == "/api/shopify-status":
            if not shopify_configured():
                return self.json(200, {"configured": False, "shop": SHOPIFY_DOMAIN})
            shop = SHOPIFY_DOMAIN
            try:
                st, d = shopify_api("GET", "shop.json")
                if st == 200:
                    shop = (d.get("shop") or {}).get("name") or SHOPIFY_DOMAIN
                else:
                    return self.json(200, {"configured": False, "shop": SHOPIFY_DOMAIN,
                                           "error": "token/scope lỗi"})
            except Exception:
                return self.json(200, {"configured": False, "shop": SHOPIFY_DOMAIN})
            return self.json(200, {"configured": True, "shop": shop})
        if path == "/api/engines":
            return self.json(200, {"gemini": bool(GEMINI_API_KEY), "model": GEMINI_IMAGE_MODEL,
                                   "claude": bool(ANTHROPIC_API_KEY), "openai_vision": bool(API_KEY),
                                   "claude_model": ANTHROPIC_MODEL,
                                   "engines": engines_status(),
                                   "default_engine": resolve_engine_id({}),
                                   "segments": [{"id": k, "label": v["label"]}
                                                for k, v in PRODUCT_SEGMENTS.items()]})
        if path == "/api/shopify-products":
            if not shopify_configured():
                return self.json(400, {"error": "Chưa cấu hình Shopify."})
            try:
                st, d = shopify_api("GET", "products.json?limit=50&order=created_at+desc")
                if st != 200:
                    return self.json(400, {"error": "Lỗi tải sản phẩm: %s" % json.dumps(d)[:200]})
            except Exception as e:
                return self.json(400, {"error": "Lỗi tải sản phẩm: %s" % e})
            out = []
            for p in (d.get("products") or []):
                vs = p.get("variants") or []
                prices = sorted(set(v.get("price") for v in vs if v.get("price")))
                img = (p.get("image") or {}).get("src") or ((p.get("images") or [{}])[0].get("src") if p.get("images") else "")
                out.append({
                    "id": p["id"], "title": p.get("title", ""), "status": p.get("status", ""),
                    "image": img, "variants": len(vs),
                    "price_min": prices[0] if prices else "", "price_max": prices[-1] if prices else "",
                    "url": shop_admin_url(p["id"]),
                    "store_url": ("https://rieng.vn/products/%s" % p.get("handle", "")) if p.get("handle") else "",
                })
            return self.json(200, {"products": out})
        if path == "/api/shopify-product":
            if not shopify_configured():
                return self.json(400, {"error": "Chưa cấu hình Shopify."})
            qs = urllib.parse.parse_qs(self.path.split("?", 1)[1]) if "?" in self.path else {}
            pid = (qs.get("id") or [""])[0]
            if not pid:
                return self.json(400, {"error": "Thiếu id."})
            try:
                st, d = shopify_api("GET", "products/%s.json" % pid)
                if st != 200:
                    return self.json(400, {"error": "Lỗi tải SP: %s" % json.dumps(d)[:150]})
            except Exception as e:
                return self.json(400, {"error": "Lỗi tải SP: %s" % e})
            p = d.get("product") or {}
            cover_id = (p.get("image") or {}).get("id")
            return self.json(200, {
                "id": p.get("id"), "title": p.get("title", ""), "body_html": p.get("body_html", ""),
                "status": p.get("status", ""), "cover_id": cover_id,
                "images": [{"id": im.get("id"), "src": im.get("src"), "position": im.get("position")}
                           for im in (p.get("images") or [])],
                "options": [{"name": o.get("name"), "position": o.get("position"),
                             "values": o.get("values") or []} for o in (p.get("options") or [])],
                "variants": [{"id": v.get("id"), "title": v.get("title"), "option1": v.get("option1"),
                              "option2": v.get("option2"), "price": v.get("price")}
                             for v in (p.get("variants") or [])],
            })
        if path == "/api/batch-status":
            qs = urllib.parse.parse_qs(self.path.split("?", 1)[1]) if "?" in self.path else {}
            jid = (qs.get("id") or [""])[0]
            with _batch_lock:
                job = BATCH_JOBS.get(jid)
                if not job:
                    return self.json(404, {"error": "Không thấy job"})
                return self.json(200, {"total": job["total"], "done": job["done"],
                                       "finished": job["finished"], "items": job["items"],
                                       "errors": job["errors"]})

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
        if path == "/api/clone-check":
            return self.handle_clone_check(body)
        if path == "/api/auto-gen":
            return self.handle_auto_gen(body)
        if path == "/api/recolor":
            return self.handle_recolor(body)
        if path == "/api/save-design":
            return self.handle_save_design(body)
        if path == "/api/batch-excel":
            return self.handle_batch_excel(body)
        if path == "/api/ads-text":
            return self.handle_ads_text(body)
        if path == "/api/ads-generate":
            return self.handle_ads_generate(body)
        if path == "/api/name-design":
            if not API_KEY:
                return self.json(400, {"error": "Chưa cấu hình OPENAI_API_KEY."})
            nm = (body.get("name") or "").strip()[:40]
            if not nm:
                return self.json(400, {"error": "Cần nhập TÊN (vd Hoàng Long)."})
            stamp = (body.get("stamp") or "").strip()[:30]
            style = (body.get("style") or "auto").strip()
            transparent = bool(body.get("transparent"))
            try:
                n = max(1, min(8, int(body.get("n") or 4)))
            except Exception:
                n = 4
            with _batch_lock:
                _batch_seq[0] += 1
                job_id = "nd%d_%d" % (int(time.time()), _batch_seq[0])
                BATCH_JOBS[job_id] = {"total": n, "done": 0, "items": [], "errors": [], "finished": False}
            threading.Thread(target=run_name_design_job,
                             args=(job_id, nm, stamp, style, n, transparent), daemon=True).start()
            return self.json(200, {"job_id": job_id, "total": n})
        if path == "/api/fb-ads-push":
            return self.handle_fb_ads_push(body)
        if path == "/api/fb-ad-update":
            if not fb_configured():
                return self.json(400, {"error": "Chưa cấu hình Facebook."})
            oid = (body.get("id") or "").strip()
            if not oid:
                return self.json(400, {"error": "Thiếu id."})
            params = {}
            if body.get("status") in ("ACTIVE", "PAUSED"):
                params["status"] = body["status"]
            if body.get("daily_budget"):
                try:
                    params["daily_budget"] = int(float(body["daily_budget"]))
                except Exception:
                    pass
            if not params:
                return self.json(400, {"error": "Không có gì để sửa."})
            st, d = fb_graph("POST", oid, params)
            if st != 200 or d.get("error"):
                return self.json(400, {"error": fb_err(d)})
            return self.json(200, {"ok": True})
        if path == "/api/fb-ad-delete":
            if not fb_configured():
                return self.json(400, {"error": "Chưa cấu hình Facebook."})
            oid = (body.get("id") or "").strip()
            if not oid:
                return self.json(400, {"error": "Thiếu id."})
            st, d = fb_graph("DELETE", oid, {})
            if st != 200 or d.get("error"):
                return self.json(400, {"error": fb_err(d)})
            return self.json(200, {"ok": True})
        if path == "/api/fb-ads-from-post":
            ids = [str(x).strip() for x in (body.get("post_ids") or []) if str(x).strip()]
            if not ids:
                return self.json(400, {"error": "Chưa chọn bài viết nào."})
            budget = body.get("daily_budget") or 50000
            status = "ACTIVE" if body.get("active") else "PAUSED"
            cid = (body.get("campaign_id") or "").strip()
            results = []
            for pid in ids:
                results.append(fb_ads_push_post(pid, budget, status=status, campaign_id=cid))
            ok = sum(1 for r in results if r.get("ok"))
            return self.json(200, {"results": results, "ok": ok, "total": len(ids)})
        if path == "/api/autopost-config":
            cfg = autopost_load()
            if "enabled" in body:
                cfg["enabled"] = bool(body.get("enabled"))
            if body.get("per_day"):
                cfg["per_day"] = max(1, min(20, int(body.get("per_day"))))
            if body.get("per_set"):
                cfg["per_set"] = max(1, min(6, int(body.get("per_set"))))
            if body.get("channels") is not None:
                cfg["channels"] = [c for c in body.get("channels") if c in ("fb", "ig")] or ["fb"]
            if body.get("start_hour") is not None:
                cfg["start_hour"] = max(0, min(23, int(body.get("start_hour"))))
            if body.get("end_hour") is not None:
                cfg["end_hour"] = max(1, min(24, int(body.get("end_hour"))))
            # bật lần đầu -> đặt lịch chạy ngay trong hôm nay
            if cfg["enabled"]:
                now = time.time()
                cfg["last_date"] = time.strftime("%Y-%m-%d", time.localtime(now))
                if float(cfg.get("next_at", 0)) < now:
                    cfg["next_at"] = now + 30
            autopost_save(cfg)
            return self.json(200, {"ok": True, "enabled": cfg["enabled"]})
        if path == "/api/agent-plan":
            cmd = (body.get("command") or "").strip()
            if not cmd:
                return self.json(400, {"error": "Nhập lệnh."})
            prod = body.get("product") or {}
            prod_ctx = ""
            if prod:
                prod_ctx = "Tên: %s | Giá: %s | Link: %s" % (
                    prod.get("name") or "", prod.get("price") or "", prod.get("link") or "")
            return self.json(200, agent_plan(cmd, prod_ctx))
        if path == "/api/agent-chat":
            msg = (body.get("message") or "").strip()
            image = body.get("image") or ""
            if not msg and not image:
                return self.json(400, {"error": "Nhập nội dung hoặc gửi ảnh."})
            prod = body.get("product") or {}
            prod_ctx = ""
            if prod:
                prod_ctx = "Tên: %s | Giá: %s | Link: %s" % (
                    prod.get("name") or "", prod.get("price") or "", prod.get("link") or "")
            return self.json(200, agent_chat(msg, prod_ctx, body.get("history") or [], image))
        if path == "/api/agent-run":
            steps = [s for s in (body.get("steps") or []) if s.get("action") in AGENT_ACTIONS]
            if not steps:
                return self.json(400, {"error": "Kế hoạch rỗng."})
            if AGENT_RUN["running"]:
                return self.json(400, {"error": "Đang chạy 1 kế hoạch — chờ xong."})
            agent_run_start(steps, product=body.get("product") or None)
            return self.json(200, {"ok": True, "total": len(steps)})
        if path == "/api/concept-style":   # lưu style 1 concept (đồng bộ autopilot)
            key = (body.get("key") or "").strip()
            img = body.get("image") or ""
            if not concept_style_save(key, img):
                return self.json(400, {"error": "key/ảnh không hợp lệ."})
            return self.json(200, {"ok": True})
        if path == "/api/autopost-run-now":   # đăng thử 1 bài ngay (test)
            if _autopost_running[0]:
                return self.json(400, {"error": "Đang chạy 1 bài rồi."})
            _autopost_running[0] = True
            threading.Thread(target=_autopost_do, daemon=True).start()
            return self.json(200, {"ok": True})
        if path == "/api/pgpost-add":
            host = self.headers.get("Host") or ""

            def absu3(u):
                if not u:
                    return ""
                return u if str(u).startswith("http") else "https://%s%s" % (host, u if u.startswith("/") else "/" + u)
            urls = [absu3(u) for u in (body.get("image_urls") or []) if u]
            if not urls:
                return self.json(400, {"error": "Thiếu ảnh."})
            item = {
                "id": hashlib.md5(("%s%s" % (time.time(), urls[0])).encode()).hexdigest()[:12],
                "caption": (body.get("caption") or "").strip(),
                "product": (body.get("product") or "").strip()[:120],
                "image_urls": urls[:10],
                "status": "draft",
                "created": time.time(),
            }
            with _pgpost_lock:
                items = pgpost_load()
                items.insert(0, item)
                pgpost_save(items)
            return self.json(200, {"ok": True, "id": item["id"]})
        if path == "/api/pgpost-update":
            pid = (body.get("id") or "").strip()
            if "caption" in body:
                _pgpost_set(pid, caption=(body.get("caption") or "").strip())
            return self.json(200, {"ok": True})
        if path == "/api/pgpost-del":
            pid = (body.get("id") or "").strip()
            with _pgpost_lock:
                pgpost_save([x for x in pgpost_load() if x.get("id") != pid])
            return self.json(200, {"ok": True})
        if path == "/api/pgpost-push-batch":
            if not (FB_ACCESS_TOKEN and FB_PAGE_ID):
                return self.json(400, {"error": "Chưa cấu hình Facebook."})
            ids = [str(i) for i in (body.get("ids") or [])]
            chans = [c for c in (body.get("channels") or []) if c in ("fb", "ig")]
            if not ids:
                return self.json(400, {"error": "Chưa chọn bài nào."})
            if not chans:
                return self.json(400, {"error": "Chọn ít nhất 1 kênh (FB/IG)."})
            if PGPOST_PUSH["running"]:
                return self.json(400, {"error": "Đang có đợt đăng chạy — chờ xong đã."})
            gap = body.get("gap") or 45
            ok = pgpost_push_start(ids, gap, chans)
            return self.json(200, {"ok": ok, "count": len(ids), "gap": max(20, min(600, int(gap)))})
        if path == "/api/adpost-add":
            host = self.headers.get("Host") or ""

            def absu2(u):
                if not u:
                    return ""
                return u if str(u).startswith("http") else "https://%s%s" % (host, u if u.startswith("/") else "/" + u)
            iu = absu2((body.get("image_url") or "").strip())
            if not iu:
                return self.json(400, {"error": "Thiếu ảnh."})
            item = {
                "id": hashlib.md5(("%s%s" % (time.time(), iu)).encode()).hexdigest()[:12],
                "title": (body.get("title") or "Áo Thun In Tên").strip()[:100],
                "caption": (body.get("caption") or "").strip(),
                "link": (body.get("link") or "").strip(),
                "product": (body.get("product") or "").strip()[:120],
                "product_img": (body.get("product_img") or "").strip()[:500],
                "image_url": iu,
                "status": "draft",
                "created": time.time(),
            }
            with _adpost_lock:
                items = adpost_load()
                items.insert(0, item)
                adpost_save(items)
            return self.json(200, {"ok": True, "id": item["id"]})
        if path == "/api/adpost-update":
            pid = (body.get("id") or "").strip()
            fields = {}
            for k in ("title", "caption", "link", "product", "product_img"):
                if k in body:
                    fields[k] = (body.get(k) or "").strip()
            _adpost_set(pid, **fields)
            return self.json(200, {"ok": True})
        if path == "/api/adpost-del":
            pid = (body.get("id") or "").strip()
            with _adpost_lock:
                adpost_save([x for x in adpost_load() if x.get("id") != pid])
            return self.json(200, {"ok": True})
        if path == "/api/adpost-fix-links":
            only = body.get("ids") or None
            return self.json(200, adpost_fix_links(only))
        if path == "/api/adpost-push-batch":
            if not fb_configured():
                return self.json(400, {"error": "Chưa cấu hình Facebook Ads."})
            ids = [str(i) for i in (body.get("ids") or [])]
            if not ids:
                return self.json(400, {"error": "Chưa chọn bài nào."})
            if ADPOST_PUSH["running"]:
                return self.json(400, {"error": "Đang có đợt đẩy chạy — chờ xong đã."})
            gap = body.get("gap") or 90
            budget = body.get("daily_budget") or 50000
            try:
                age_min = int(body.get("age_min") or 18); age_max = int(body.get("age_max") or 55)
            except Exception:
                age_min, age_max = 18, 55
            fb_status = "ACTIVE" if body.get("active") else "PAUSED"
            ok = adpost_push_start(ids, gap, budget, age_min, age_max,
                                   body.get("genders") or [], body.get("cta") or "SHOP_NOW", fb_status,
                                   (body.get("campaign_id") or "").strip(), (body.get("adset_id") or "").strip())
            return self.json(200, {"ok": ok, "count": len(ids), "gap": max(30, min(600, int(gap))), "status": fb_status})
        if path == "/api/sched-add":
            urls = body.get("image_urls") or []
            chans = [c for c in (body.get("channels") or []) if c in ("fb", "ig")]
            when = body.get("when")
            msg = (body.get("message") or "").strip()
            if not urls:
                return self.json(400, {"error": "Thiếu ảnh."})
            if not chans:
                return self.json(400, {"error": "Chọn ít nhất 1 kênh (FB/IG)."})
            try:
                when_ts = float(when)
            except Exception:
                return self.json(400, {"error": "Thời gian không hợp lệ."})
            host = self.headers.get("Host") or ""
            if "localhost" in host or "127.0.0.1" in host:
                return self.json(400, {"error": "Lịch chỉ chạy trên bản LIVE (FB/IG cần URL ảnh công khai)."})

            def absu(u):
                if not u:
                    return ""
                return u if str(u).startswith("http") else "https://%s%s" % (host, u if u.startswith("/") else "/" + u)

            item = {
                "id": hashlib.md5(("%s%s" % (when_ts, ",".join(urls))).encode()).hexdigest()[:12],
                "channels": chans,
                "image_urls": [absu(u) for u in urls if u],
                "thumb": absu(urls[0]) if urls else "",
                "message": msg,
                "when": when_ts,
                "status": "pending",
                "created": time.time(),
            }
            with _sched_lock:
                items = sched_load()
                items.append(item)
                sched_save(items)
            return self.json(200, {"ok": True, "id": item["id"]})
        if path == "/api/sched-del":
            sid = (body.get("id") or "").strip()
            with _sched_lock:
                items = [x for x in sched_load() if x.get("id") != sid]
                sched_save(items)
            return self.json(200, {"ok": True})
        if path == "/api/sched-run":  # chạy thử ngay (test)
            sched_process()
            return self.json(200, {"ok": True})
        if path == "/api/fbpost-generate":
            return self.handle_fbpost_generate(body)
        if path == "/api/fb-post":
            return self.handle_fb_post(body)
        if path == "/api/prod-generate":
            return self.handle_prod_generate(body)
        if path == "/api/prod-suggest":
            return self.handle_prod_suggest(body)
        if path == "/api/product-photos":
            return self.handle_product_photos(body)
        if path == "/api/product-seg":
            return self.handle_product_seg(body)
        if path == "/api/product-prompts":
            return self.handle_product_prompts(body)
        if path == "/api/product-render":
            return self.handle_product_render(body)
        if path == "/api/product-content":
            return self.handle_product_content(body)
        if path == "/api/auto-pipeline":
            return self.handle_auto_pipeline(body)
        if path == "/api/pipe-designs":
            return self.handle_pipe_designs(body)
        if path == "/api/pipe-personalize":
            return self.handle_pipe_personalize(body)
        if path == "/api/pipe-recolor":
            return self.handle_pipe_recolor(body)
        if path == "/api/pipe-edit":
            return self.handle_pipe_edit(body)
        if path == "/api/design-gen":
            return self.handle_design_gen(body)
        if path == "/api/rate-designs":
            return self.handle_rate_designs(body)
        if path == "/api/personalize":
            return self.handle_personalize(body)
        if path == "/api/variations":
            return self.handle_variations(body)
        if path == "/api/shopify-push":
            return self.handle_shopify_push(body)
        if path == "/api/shopify-add-images":
            if not shopify_configured():
                return self.json(400, {"error": "Chưa cấu hình Shopify."})
            pid = body.get("id")
            imgs = body.get("images") or []
            mode = body.get("mode", "append")
            if not pid or not imgs:
                return self.json(400, {"error": "Thiếu sản phẩm hoặc ảnh."})
            try:
                if mode == "replace":
                    st, d = shopify_api("GET", "products/%s/images.json" % pid)
                    for im in (d or {}).get("images", []):
                        shopify_api("DELETE", "products/%s/images/%s.json" % (pid, im["id"]))
                n = 0
                for im in imgs:
                    b = im.split(",", 1)[1] if str(im).startswith("data:") else im
                    if not b:
                        continue
                    st, _ = shopify_api("POST", "products/%s/images.json" % pid, {"image": {"attachment": b}})
                    if st in (200, 201):
                        n += 1
            except Exception as e:
                return self.json(400, {"error": "Lỗi cập nhật ảnh: %s" % e})
            return self.json(200, {"ok": True, "count": n})
        if path == "/api/shopify-delete":
            if not shopify_configured():
                return self.json(400, {"error": "Chưa cấu hình Shopify."})
            pid = body.get("id")
            if not pid:
                return self.json(400, {"error": "Thiếu id sản phẩm."})
            try:
                st, d = shopify_api("DELETE", "products/%s.json" % pid)
                if st not in (200, 204):
                    return self.json(400, {"error": "Xoá lỗi: %s" % json.dumps(d)[:150]})
            except Exception as e:
                return self.json(400, {"error": "Xoá lỗi: %s" % e})
            return self.json(200, {"ok": True})
        if path == "/api/shopify-update":
            return self.handle_shopify_update(body)
        if path == "/api/shopify-add-variant":
            return self.handle_shopify_add_variant(body)
        if path == "/api/shopify-set-cover":
            return self.handle_shopify_set_cover(body)
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
            item = save_user_mockup(raw, body.get("name", ""), body.get("color"),
                                    body.get("side", "front"))
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
        out_b64 = base64.b64encode(out).decode()
        g = gallery_add(out_b64, {"mode": "cutout", "prompt": "Tách nền"})   # lưu lại để xem sau
        return self.json(200, {"image": out_b64, "gallery": g,
                               "method": method if (method != "ai" or HAS_REMBG) else "white"})

    # ---------- handlers ----------
    def handle_clone_check(self, body):
        """AI đối chiếu mẫu GỐC vs KẾT QUẢ (sau tách nền) -> vẽ lại cho khớp."""
        if not API_KEY:
            return self.json(400, {"error": "Chưa cấu hình OPENAI_API_KEY."})
        o = body.get("original", "")
        r = body.get("result", "")
        if not o or not r:
            return self.json(400, {"error": "Cần ảnh GỐC (đã tải lên) và ảnh KẾT QUẢ."})
        ob, _ = fetch_image_bytes(o)
        rb, _ = fetch_image_bytes(r)
        if not ob or not rb:
            return self.json(400, {"error": "Ảnh không hợp lệ."})
        size = body.get("size", "auto")
        try:
            b64, info = clone_compare_fix(ob, rb, size)
            g = gallery_add(b64, {"mode": "design", "prompt": "Đối chiếu & sửa"})
            return self.json(200, {"image": b64, "gallery": g,
                                   "match": bool(info.get("match")),
                                   "differences": info.get("differences", []),
                                   "fix": info.get("fix", "")})
        except urllib.error.HTTPError as e:
            return self.json(400, {"error": openai_error_message(e)})
        except Exception as e:
            return self.json(500, {"error": str(e)})

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
            low = detail.lower()
            if "moderation_blocked" in low or "safety system" in low:
                msg = ("⚠️ OpenAI chặn nội dung này (bộ lọc an toàn — đôi khi chặn nhầm). "
                       "Thử: đổi ảnh áo khác · sửa/bớt chi tiết trong prompt · hoặc bấm Tạo lại 1–2 lần.")
            elif e.code in (500, 502, 503, 520):
                msg = "OpenAI đang quá tải (lỗi %s). Bấm Tạo design lại sau giây lát." % e.code
            elif e.code == 401:
                msg = "Key OpenAI sai hoặc hết số dư. Kiểm tra lại API key + tài khoản OpenAI."
            elif e.code == 429:
                msg = "Gọi quá nhanh / hết hạn mức (429). Đợi chút rồi thử lại."
            else:
                msg = "OpenAI %s: %s" % (e.code, detail[:300])
            return self.json(502, {"error": msg})
        except Exception as e:
            return self.json(500, {"error": "Lỗi: %s" % e})
        item = gallery_add(b64, {"mode": mode, "prompt": user_prompt})
        return self.json(200, {"image": b64, "mock": False, "gallery": item,
                               "prompt": used_prompt})

    def handle_auto_gen(self, body):
        """Chế độ AUTO: AI nhìn mẫu -> GIỮ NGUYÊN STYLE, chỉ đổi text -> ra n mẫu.
        Dùng luồng cloner (gen_design) để clone trung thực rồi áp chỉ thị đổi text."""
        if not API_KEY:
            return self.json(400, {"error": "Chưa cấu hình OPENAI_API_KEY."})
        niche = body.get("niche", "")
        n = max(1, min(int(body.get("n", 3) or 3), 8))
        size = SIZE_MAP.get(body.get("size", "portrait"), "1024x1536")
        transparent = bool(body.get("transparent", True))

        # Tải ảnh mẫu -> giữ cả bytes (để clone) và base64 (để AI nhìn)
        sources = body.get("images") or []
        if isinstance(sources, str):
            sources = [s for s in sources.splitlines() if s.strip()]
        ref_imgs, ref_b64 = [], []
        for s in [x for x in sources if x and x.strip()][:3]:
            d, m = fetch_image_bytes(s)
            if d:
                ref_imgs.append((d, m))
                ref_b64.append(base64.b64encode(d).decode())
        if not ref_imgs:
            return self.json(400, {"error": "Chế độ Auto cần ít nhất 1 ảnh mẫu để AI "
                                   "giữ nguyên style. Hãy tải ảnh mẫu lên rồi chạy lại."})

        # Bước 1: AI đọc mẫu -> đề xuất chỉ thị đổi text (giữ style)
        try:
            concepts = auto_concepts(ref_b64, niche, n)
        except urllib.error.HTTPError as e:
            return self.json(502, {"error": openai_error_message(e)})
        except Exception as e:
            return self.json(500, {"error": "AI đọc mẫu lỗi: %s" % e})
        if not concepts:
            return self.json(400, {"error": "AI chưa đề xuất được. Thử ảnh mẫu rõ chữ hơn "
                                   "hoặc gõ rõ niche rồi chạy lại."})

        # Bước 2: với mỗi concept -> clone mẫu gốc + áp chỉ thị đổi text (giữ style)
        items, errors = [], []
        for c in concepts:
            try:
                ref = [ref_imgs[c["src_index"]]]
                b64, _ = gen_design(ref, "cloner", c["change_instruction"],
                                    size, transparent)
                g = gallery_add(b64, {"mode": "auto", "prompt": c["title"]})
                items.append({"image": b64, "title": c["title"], "gallery": g})
            except urllib.error.HTTPError as e:
                errors.append(openai_error_message(e))
            except Exception as e:
                errors.append(str(e))
        if not items:
            return self.json(502, {"error": "Vẽ mẫu lỗi: %s"
                                   % (errors[0] if errors else "không rõ")})
        return self.json(200, {"items": items, "errors": errors})

    def handle_recolor(self, body):
        """Đổi màu theo áo: giữ nguyên design, phối lại màu cho từng màu áo đã chọn.
        Trả bản TÁCH NỀN + hex màu áo -> client tự ghép nền (màu áo / preset) để xem."""
        if not API_KEY:
            return self.json(400, {"error": "Chưa cấu hình OPENAI_API_KEY."})
        img_src = body.get("image", "")
        if not img_src:
            return self.json(400, {"error": "Chưa có design đầu vào để đổi màu."})
        user_prompt = (body.get("prompt") or "").strip()[:800]   # prompt tự viết của user
        colors = [c for c in (body.get("colors") or []) if c in RECOLOR]
        if not user_prompt and not colors:
            return self.json(400, {"error": "Viết prompt đổi màu, hoặc chọn màu áo."})
        size = SIZE_MAP.get(body.get("size", "portrait"), "1024x1536")
        note = (body.get("note") or "").strip()[:400]   # gợi ý đa dạng giữa các bản

        d, m = fetch_image_bytes(img_src)
        if not d:
            return self.json(400, {"error": "Không đọc được ảnh design."})
        img = [(d, m)]
        bg = detect_bg_desc(d)   # nền hiện tại của design (đọc góc ảnh)

        # ===== CHẾ ĐỘ PROMPT TỰ VIẾT (user gõ yêu cầu) =====
        if user_prompt:
            base = ("This is my t-shirt print design, currently shown on a %s background. "
                    "Keep the design IDENTICAL — same text, fonts, layout, decorations and "
                    "proportions — only change the COLOURS as requested below. "
                    "USER REQUEST: %s. " % (bg, user_prompt))
            if note:
                base += note + " "
            base += ("Output ONLY the artwork on a plain pure-white empty background (no shirt) "
                     "so it cuts out cleanly.")
            try:
                b64, _ = gen_design(img, "cloner", base, size, True, quality="high")
                b64 = preserve_alpha(d, b64)
                g = gallery_add(b64, {"mode": "recolor", "prompt": user_prompt[:80]})
                return self.json(200, {"items": [{"image": b64, "title": "Bản phối",
                                       "gallery": g}], "errors": []})
            except urllib.error.HTTPError as e:
                return self.json(502, {"error": openai_error_message(e)})
            except Exception as e:
                return self.json(500, {"error": "Đổi màu lỗi: %s" % e})

        items, errors = [], []
        for key in colors:
            vi, hexv = RECOLOR[key][0], RECOLOR[key][1]
            try:
                # Prompt đơn giản: "design trên nền <bg>, phối lại cho hợp áo <key>"
                instr = recolor_instruction(key, bg)
                if note:
                    instr += " Also: " + note
                b64, _ = gen_design(img, "cloner", instr, size, True, quality="high")  # nét cao như ChatGPT
                # Giữ ĐÚNG vùng trong suốt của design gốc -> chỉ đổi màu, KHÔNG thêm nền
                b64 = preserve_alpha(d, b64)
                g = gallery_add(b64, {"mode": "recolor", "prompt": "Áo %s" % vi})
                items.append({"image": b64, "title": "Áo %s" % vi,
                              "color": key, "hex": hexv, "gallery": g})
            except urllib.error.HTTPError as e:
                errors.append("%s: %s" % (vi, openai_error_message(e)))
            except Exception as e:
                errors.append("%s: %s" % (vi, e))
        if not items:
            return self.json(502, {"error": "Đổi màu lỗi: %s"
                                   % (errors[0] if errors else "không rõ")})
        return self.json(200, {"items": items, "errors": errors})

    def handle_design_gen(self, body):
        """Tạo design: theo phong cách đã chọn (trộn), HOẶC theo ẢNH THAM CHIẾU (AI tự nhận style)."""
        if not API_KEY:
            return self.json(400, {"error": "Chưa cấu hình OPENAI_API_KEY."})
        styles = [s for s in (body.get("styles") or []) if s in DESIGN_STYLES]
        if not styles and body.get("style") in DESIGN_STYLES:   # tương thích cũ
            styles = [body.get("style")]
        auto_style = bool(body.get("auto_style"))
        segment = body.get("segment", "")
        if segment not in SEGMENTS:
            segment = ""
        ref_bytes = None
        ref_src = body.get("ref", "")
        if ref_src:
            ref_bytes, _ = fetch_image_bytes(ref_src)
        if not segment and not auto_style and not styles and not ref_bytes and not (body.get("extra") or "").strip():
            return self.json(400, {"error": "Hãy chọn phong cách, bật 'AI tự chọn style', tải ảnh tham chiếu, HOẶC tự điền prompt ở ô bên dưới."})
        if segment:
            n = SEGMENTS[segment]["n"]      # bộ đồng bộ -> số mẫu cố định theo tệp
        else:
            n = max(1, min(int(body.get("n", 3) or 3), 8))
        size = SIZE_MAP.get(body.get("size", "portrait"), "1024x1536")
        transparent = bool(body.get("transparent", True))
        total_est = n
        with _batch_lock:
            _batch_seq[0] += 1
            job_id = "g%d_%d" % (int(time.time()), _batch_seq[0])
            BATCH_JOBS[job_id] = {"total": total_est, "done": 0, "items": [],
                                  "errors": [], "finished": False}
        t = threading.Thread(target=run_design_job,
                             args=(job_id, styles, body.get("theme", ""),
                                   body.get("text", ""), n, size, transparent, ref_bytes,
                                   body.get("year", ""), bool(body.get("same_line")),
                                   auto_style, segment, (body.get("extra") or "").strip()[:600]),
                             daemon=True)
        t.start()
        return self.json(200, {"job_id": job_id, "total": total_est})

    def handle_auto_pipeline(self, body):
        """Pipeline TRỌN GÓI: AI tự nghĩ tên/tệp/style/màu -> gen design -> đổi màu hợp áo."""
        if not API_KEY:
            return self.json(400, {"error": "Chưa cấu hình OPENAI_API_KEY."})
        n = max(1, min(int(body.get("n", 3) or 3), 6))
        niche = body.get("niche", "")
        try:
            plans = auto_pipe_plan(n, niche)
        except urllib.error.HTTPError as e:
            return self.json(502, {"error": openai_error_message(e)})
        except Exception as e:
            return self.json(502, {"error": "AI nghĩ mẫu lỗi: %s" % e})
        if not plans:
            return self.json(400, {"error": "AI chưa nghĩ được mẫu — thử lại hoặc gõ ngách rõ hơn."})
        # màu áo user chọn -> mỗi màu = 1 lần đổi màu + lên áo (variant)
        colors = [c for c in (body.get("colors") or []) if c in RECOLOR]
        if not colors:
            colors = ["black", "white"]
        size = SIZE_MAP.get("portrait", "1024x1536")
        with _batch_lock:
            _batch_seq[0] += 1
            job_id = "ap%d_%d" % (int(time.time()), _batch_seq[0])
            BATCH_JOBS[job_id] = {"total": len(plans), "done": 0, "items": [],
                                  "errors": [], "finished": False}
        t = threading.Thread(target=run_auto_pipeline, args=(job_id, plans, size, colors),
                             daemon=True)
        t.start()
        return self.json(200, {"job_id": job_id, "total": len(plans)})

    def handle_pipe_designs(self, body):
        """BƯỚC 1: tạo DESIGN ĐẸP (AI tự chọn style theo chủ đề). Chưa cá nhân hoá."""
        if not API_KEY:
            return self.json(400, {"error": "Chưa cấu hình OPENAI_API_KEY."})
        n = max(1, min(int(body.get("n", 3) or 3), 6))
        seg = body.get("tep") or body.get("segment") or "single"
        theme = body.get("niche", "") or body.get("theme", "")
        size = SIZE_MAP.get("portrait", "1024x1536")
        with _batch_lock:
            _batch_seq[0] += 1
            job_id = "pd%d_%d" % (int(time.time()), _batch_seq[0])
            BATCH_JOBS[job_id] = {"total": n, "done": 0, "items": [],
                                  "errors": [], "finished": False}
        t = threading.Thread(target=run_pipe_designs, args=(job_id, theme, n, seg, size),
                             daemon=True)
        t.start()
        return self.json(200, {"job_id": job_id, "total": n})

    def handle_pipe_personalize(self, body):
        """BƯỚC 2: AI tự nghĩ tên 2 chữ -> cá nhân hoá các design đã chọn."""
        if not API_KEY:
            return self.json(400, {"error": "Chưa cấu hình OPENAI_API_KEY."})
        designs = [d for d in (body.get("designs") or []) if isinstance(d, dict) and d.get("image")]
        if not designs:
            return self.json(400, {"error": "Chưa chọn design nào để cá nhân hoá."})
        size = SIZE_MAP.get("portrait", "1024x1536")
        with _batch_lock:
            _batch_seq[0] += 1
            job_id = "pp%d_%d" % (int(time.time()), _batch_seq[0])
            BATCH_JOBS[job_id] = {"total": len(designs), "done": 0, "items": [],
                                  "errors": [], "finished": False}
        t = threading.Thread(target=run_pipe_personalize, args=(job_id, designs, size), daemon=True)
        t.start()
        return self.json(200, {"job_id": job_id, "total": len(designs)})

    def handle_pipe_edit(self, body):
        """Sửa 1 design theo YÊU CẦU của user (img2img, giữ phong cách)."""
        if not API_KEY:
            return self.json(400, {"error": "Chưa cấu hình OPENAI_API_KEY."})
        src = body.get("image", "")
        instr = (body.get("prompt") or "").strip()
        if not src or not instr:
            return self.json(400, {"error": "Cần ảnh design và yêu cầu chỉnh sửa."})
        d, m = fetch_image_bytes(src)
        if not d:
            return self.json(400, {"error": "Không đọc được ảnh design."})
        size = "auto"
        if HAS_PIL:
            try:
                im = Image.open(io.BytesIO(d)); w, h = im.size
                size = "1024x1536" if h > w * 1.1 else ("1536x1024" if w > h * 1.1 else "1024x1024")
            except Exception:
                pass
        prompt = ("Edit this t-shirt PRINT design as requested while keeping the same overall art "
                  "style, vibe and any name text correct: " + instr + ". Keep it a clean print-ready "
                  "graphic on a plain solid background, no mockup, no t-shirt, no person.")
        try:
            b64, _ = gen_design([(d, m or "image/png")], "cloner", prompt, size, True)
        except urllib.error.HTTPError as e:
            return self.json(502, {"error": openai_error_message(e)})
        except Exception as e:
            return self.json(502, {"error": "Sửa design lỗi: %s" % e})
        gallery_add(b64, {"mode": "design", "prompt": "Sửa: " + instr[:40]})
        return self.json(200, {"image": b64})

    def handle_pipe_recolor(self, body):
        """BƯỚC 2: đổi màu các design ĐÃ CHỌN cho từng màu áo -> variants[]."""
        if not API_KEY:
            return self.json(400, {"error": "Chưa cấu hình OPENAI_API_KEY."})
        designs = [d for d in (body.get("designs") or []) if isinstance(d, dict) and d.get("image")]
        if not designs:
            return self.json(400, {"error": "Chưa chọn design nào để đổi màu."})
        colors = [c for c in (body.get("colors") or []) if c in RECOLOR] or ["black", "white"]
        size = SIZE_MAP.get("portrait", "1024x1536")
        with _batch_lock:
            _batch_seq[0] += 1
            job_id = "pc%d_%d" % (int(time.time()), _batch_seq[0])
            BATCH_JOBS[job_id] = {"total": len(designs), "done": 0, "items": [],
                                  "errors": [], "finished": False}
        t = threading.Thread(target=run_pipe_recolor, args=(job_id, designs, colors, size),
                             daemon=True)
        t.start()
        return self.json(200, {"job_id": job_id, "total": len(designs)})

    def handle_rate_designs(self, body):
        """AI chấm điểm tiềm năng bán chạy cho list design (mỗi item {key, image})."""
        if not API_KEY:
            return self.json(400, {"error": "Chưa cấu hình OPENAI_API_KEY."})
        items = body.get("items") or []
        items = items[:DESIGN_MAX_TOTAL]
        if not items:
            return self.json(400, {"error": "Không có mẫu để chấm."})
        keys, imgs = [], []
        for it in items:
            b = (it.get("image") or "")
            if "," in b and b.strip().startswith("data:"):
                b = b.split(",", 1)[1]
            if b:
                keys.append(it.get("key"))
                imgs.append(b)
        if not imgs:
            return self.json(400, {"error": "Ảnh không hợp lệ."})
        try:
            rated = rate_designs(imgs)
        except urllib.error.HTTPError as e:
            return self.json(400, {"error": openai_error_message(e)})
        except Exception as e:
            return self.json(400, {"error": "Lỗi chấm điểm: %s" % e})
        scores = [{"key": keys[i], "score": rated[i]["score"], "reason": rated[i]["reason"]}
                  for i in range(len(keys))]
        return self.json(200, {"scores": scores})

    def handle_personalize(self, body):
        """Biến 1 mẫu đẹp -> bản CÁ NHÂN HOÁ: giữ nguyên style, thay chữ chính = tên (img2img)."""
        if not API_KEY:
            return self.json(400, {"error": "Chưa cấu hình OPENAI_API_KEY."})
        src = body.get("image", "")
        name = (body.get("name") or "").strip()
        date = (body.get("date") or "").strip()
        nick = (body.get("nick") or "").strip()
        req = (body.get("note") or "").strip()[:300]
        if not src or not name:
            return self.json(400, {"error": "Cần ảnh mẫu và TÊN cá nhân hoá."})
        img_bytes, mime = fetch_image_bytes(src)
        if not img_bytes:
            return self.json(400, {"error": "Ảnh không hợp lệ."})
        # giữ đúng tỉ lệ ảnh gốc
        size = "auto"
        if HAS_PIL:
            try:
                im = Image.open(io.BytesIO(img_bytes)); w, h = im.size
                size = "1024x1536" if h > w * 1.1 else ("1536x1024" if w > h * 1.1 else "1024x1024")
            except Exception:
                pass
        count = max(1, min(int(body.get("count", 4) or 4), 6))
        one_line = len(name.split()) == 2      # tên 2 chữ -> xếp cùng 1 dòng
        base = ("Design a t-shirt graphic featuring the NAME \"%s\" as the focal text. KEEP THE SAME "
                "VISUAL STYLE as the reference image — same color palette, same font character, same "
                "illustration motifs/elements, same texture and mood — but you are FREE to REDESIGN "
                "the COMPOSITION/LAYOUT. Use exactly this name text, keep all Vietnamese diacritics "
                "correct." % name)
        if one_line:
            base += (" The name has exactly TWO words — they MUST be written TOGETHER on ONE single "
                     "horizontal line, side by side; NEVER stack the two words on separate lines, "
                     "never split them, never place one above the other.")
        if date:
            base += " Include a small secondary line \"%s\"." % date
        # Tên thân mật ĐA DẠNG: tách nhiều giá trị (Annie · Bé Na · Mèo) -> mỗi bản 1 nick khác.
        nick_raw = nick
        for sep in ("·", "/", "&", ",", "|", ";"):
            nick_raw = nick_raw.replace(sep, "\n")
        nicks = [x.strip() for x in nick_raw.split("\n") if x.strip()]
        # 🎲 AUTO ĐA DẠNG: chưa gõ đủ nhiều tên -> tự lấy từ pool, MỖI BẢN 1 tên nhỏ KHÁC
        if bool(body.get("nick_vary")) and len(nicks) < count:
            pool = VN_NICKS[:]
            random.shuffle(pool)
            need = count - len(nicks)
            nicks = nicks + [p for p in pool if p not in nicks][:need]

        def text_block(nk):
            """Khối chỉ thị (per-variant): thêm nick nk + ràng buộc CHỈ giữ tên/ngày/nick."""
            s = ""
            if nk:
                s += (" Also add the affectionate nickname/pet-name \"%s\" as a small SECONDARY text "
                      "element, in a warm, cute, friendly style (a little above or below the name) — "
                      "keep the main NAME as the biggest focal text." % nk)
            allowed = ('the name "%s"' % name
                       + ((' and the small secondary line "%s"' % date) if date else "")
                       + ((' and the affectionate nickname "%s"' % nk) if nk else ""))
            s += (" CRITICAL — TEXT CONTENT: the ONLY readable text anywhere on the whole design must be "
                  + allowed + ". COMPLETELY REMOVE every other word, letter, slogan, tagline, label, year, "
                  "club/brand name and placeholder text from the reference (e.g. '@yourtext', 'your text', "
                  "'DEAR', 'EST', 'SINCE', 'CLUB', 'CHAMPION', lorem) — do NOT keep, repeat or invent any "
                  "extra text. Keep only NON-TEXT decorative graphic elements (stars, lines, shapes, "
                  "motifs) for the style.")
            return s
        if req:
            base += " ADDITIONAL USER REQUEST (follow it carefully): " + req
        # mỗi bản 1 KIỂU BỐ CỤC KHÁC HẲN (vẫn cùng phong cách) -> 4-6 lựa chọn đa dạng
        if one_line:
            # tất cả bố cục đều giữ tên 2 chữ trên CÙNG 1 dòng
            variants = [
                " COMPOSITION A — the two-word name CENTERED big on ONE single line as the hero, secondary line below.",
                " COMPOSITION B — OVERSIZED two-word name on ONE single line filling the print width edge-to-edge.",
                " COMPOSITION C — the two-word name on ONE single line inside/across a round BADGE/EMBLEM with the style's motifs.",
                " COMPOSITION D — BANNER: the two-word name on ONE single line on a ribbon/banner, main illustration large below.",
                " COMPOSITION E — the two-word name on ONE single bold line, decorative elements flanking left & right.",
                " COMPOSITION F — the two-word name on ONE single line, dynamic asymmetric layout with motifs around it.",
            ]
        else:
            variants = [
                " COMPOSITION A — classic CENTERED & symmetrical: name stacked in the middle, secondary line below.",
                " COMPOSITION B — OVERSIZED name filling the print edge-to-edge as the hero; everything else tiny.",
                " COMPOSITION C — circular BADGE/EMBLEM: name wrapped around or inside a round crest/seal with the style's motifs.",
                " COMPOSITION D — BANNER layout: name arched at the TOP with the main illustration/graphic large below it.",
                " COMPOSITION E — VERTICAL stacked lockup: words stacked tall in a tall narrow composition with decorative side elements.",
                " COMPOSITION F — name on a RIBBON/banner with decorative motifs flanking both sides, asymmetric and dynamic.",
            ]
        base += " IMPORTANT: commit FULLY to the requested composition so each version looks distinctly different."
        transparent = bool(body.get("transparent", True))
        label = "Cá nhân hoá: " + name + (" · " + date if date else "")

        def one(i):
            try:
                nk = nicks[i % len(nicks)] if nicks else ""   # mỗi bản 1 tên thân mật khác
                prompt = base + text_block(nk) + variants[i % len(variants)]
                b64, _ = gen_design([(img_bytes, mime or "image/png")], "variation",
                                    prompt, size, transparent)
                g = gallery_add(b64, {"mode": "personalize", "prompt": label})
                return {"image": b64, "title": label + " #%d" % (i + 1), "gallery": g}
            except Exception:
                return None

        items, err = [], None
        with ThreadPoolExecutor(max_workers=min(count, 4)) as ex:
            for r in ex.map(one, range(count)):
                if r:
                    items.append(r)
        if not items:
            try:
                gen_design([(img_bytes, mime or "image/png")], "variation",
                           base + text_block(nicks[0] if nicks else ""), size, transparent)
            except urllib.error.HTTPError as e:
                err = openai_error_message(e)
            except Exception as e:
                err = "Lỗi cá nhân hoá: %s" % e
            return self.json(400, {"error": err or "Không tạo được bản cá nhân hoá nào."})
        return self.json(200, {"items": items})

    def handle_variations(self, body):
        """Tạo thêm các PHIÊN BẢN KHÁC của 1 design (giữ chủ đề & phong cách, đổi bố cục/màu/chi tiết)."""
        if not API_KEY:
            return self.json(400, {"error": "Chưa cấu hình OPENAI_API_KEY."})
        src = body.get("image", "")
        if not src:
            return self.json(400, {"error": "Cần ảnh design để tạo phiên bản."})
        img_bytes, mime = fetch_image_bytes(src)
        if not img_bytes:
            return self.json(400, {"error": "Ảnh không hợp lệ."})
        count = max(1, min(int(body.get("count", 4) or 4), 6))
        size = "auto"
        if HAS_PIL:
            try:
                im = Image.open(io.BytesIO(img_bytes)); w, h = im.size
                size = "1024x1536" if h > w * 1.1 else ("1536x1024" if w > h * 1.1 else "1024x1024")
            except Exception:
                pass
        req = (body.get("prompt") or body.get("note") or "").strip()[:400]   # yêu cầu làm lại của user
        base = ("Create a fresh creative VARIATION of this t-shirt artwork — KEEP the same core "
                "theme/subject and overall art style, but make it clearly DIFFERENT from the original. "
                "Keep any text correct (Vietnamese diacritics intact). Output only the artwork.")
        if req:
            base += " IMPORTANT — apply this user request when remaking it: " + req
        variants = [
            " Variation: a fresh alternate COMPOSITION of the same idea.",
            " Variation: same theme & style but a DIFFERENT color palette.",
            " Variation: a more MINIMAL / simplified take.",
            " Variation: a more DETAILED / richer take with extra decorative elements.",
            " Variation: restructure the LAYOUT (e.g. badge/emblem, or stacked) for variety.",
            " Variation: a different MOOD/vibe of the same concept.",
        ]
        transparent = bool(body.get("transparent", True))

        def one(i):
            try:
                b64, _ = gen_design([(img_bytes, mime or "image/png")], "variation",
                                    base + variants[i % len(variants)], size, transparent)
                g = gallery_add(b64, {"mode": "design", "prompt": "Phiên bản khác"})
                return {"image": b64, "title": "Phiên bản khác #%d" % (i + 1), "gallery": g}
            except Exception:
                return None

        items = []
        with ThreadPoolExecutor(max_workers=min(count, 4)) as ex:
            for r in ex.map(one, range(count)):
                if r:
                    items.append(r)
        if not items:
            return self.json(400, {"error": "Không tạo được phiên bản nào — thử lại."})
        return self.json(200, {"items": items})

    def handle_shopify_update(self, body):
        """Sửa sản phẩm Shopify: tên / mô tả (body_html) / trạng thái."""
        if not shopify_configured():
            return self.json(400, {"error": "Chưa cấu hình Shopify."})
        pid = body.get("id")
        if not pid:
            return self.json(400, {"error": "Thiếu id sản phẩm."})
        upd = {"id": pid}
        if (body.get("title") or "").strip():
            upd["title"] = body["title"].strip()
        if "body_html" in body:
            upd["body_html"] = body.get("body_html") or ""
        if body.get("status") in ("active", "draft"):
            upd["status"] = body["status"]
        try:
            st, d = shopify_api("PUT", "products/%s.json" % pid, {"product": upd})
            if st != 200:
                return self.json(400, {"error": "Lưu lỗi: %s" % json.dumps(d)[:200]})
        except Exception as e:
            return self.json(400, {"error": "Lưu lỗi: %s" % e})
        return self.json(200, {"ok": True})

    def handle_shopify_set_cover(self, body):
        """Đặt ảnh BÌA: chọn ảnh có sẵn (image_id -> position 1) hoặc thêm ảnh mới làm bìa."""
        if not shopify_configured():
            return self.json(400, {"error": "Chưa cấu hình Shopify."})
        pid = body.get("id")
        if not pid:
            return self.json(400, {"error": "Thiếu id sản phẩm."})
        img_id = body.get("image_id")
        new_img = body.get("image") or ""
        try:
            if new_img:
                b = new_img.split(",", 1)[1] if str(new_img).startswith("data:") else new_img
                st, d = shopify_api("POST", "products/%s/images.json" % pid,
                                    {"image": {"attachment": b, "position": 1}})
                if st not in (200, 201):
                    return self.json(400, {"error": "Thêm ảnh bìa lỗi: %s" % json.dumps(d)[:160]})
                return self.json(200, {"ok": True, "cover_id": (d.get("image") or {}).get("id")})
            if img_id:
                st, d = shopify_api("PUT", "products/%s/images/%s.json" % (pid, img_id),
                                    {"image": {"id": img_id, "position": 1}})
                if st != 200:
                    return self.json(400, {"error": "Đặt bìa lỗi: %s" % json.dumps(d)[:160]})
                return self.json(200, {"ok": True, "cover_id": img_id})
        except Exception as e:
            return self.json(400, {"error": "Lỗi: %s" % e})
        return self.json(400, {"error": "Cần chọn ảnh có sẵn hoặc tải ảnh mới."})

    def handle_shopify_add_variant(self, body):
        """Thêm variant (màu có swatch + các size) cho SP có sẵn + gán ảnh cho màu mới.
        Option 'Màu' là linkedMetafield -> phải dùng GraphQL với linkedMetafieldValue."""
        if not shopify_configured():
            return self.json(400, {"error": "Chưa cấu hình Shopify."})
        pid = body.get("id")
        color = shop_norm_color((body.get("color") or "").strip())
        sizes = [str(s).strip() for s in (body.get("sizes") or []) if str(s).strip()] or ["S"]
        price = str(body.get("price") or "").strip() or "269000"
        image = body.get("image") or ""
        if not pid or not color:
            return self.json(400, {"error": "Thiếu sản phẩm hoặc tên màu."})
        if color not in SHOP_COLOR_META:
            return self.json(400, {"error": "Màu \"%s\" chưa có swatch. Chỉ hỗ trợ: %s"
                                   % (color, ", ".join(SHOP_COLOR_META))})
        gid = "gid://shopify/Product/%s" % pid
        try:
            # 1) lấy option 'Màu' (+ 'Size' nếu có)
            qo = '{product(id:"%s"){options{id name optionValues{name}}}}' % gid
            opts = ((shopify_graphql(qo).get("data") or {}).get("product") or {}).get("options") or []
            mau = next((o for o in opts if o.get("name") == "Màu"), None)
            has_size = any(o.get("name") == "Size" for o in opts)
            if not mau:
                return self.json(400, {"error": "Sản phẩm không có tuỳ chọn 'Màu' để thêm variant."})
            # 2) thêm GIÁ TRỊ màu vào option nếu chưa có (linkedMetafield -> dùng GraphQL)
            existing = [ov.get("name") for ov in (mau.get("optionValues") or [])]
            if color not in existing:
                qa = ("mutation($p:ID!,$o:OptionUpdateInput!,$add:[OptionValueCreateInput!]){"
                      "productOptionUpdate(productId:$p,option:$o,optionValuesToAdd:$add){"
                      "userErrors{message}}}")
                ra = shopify_graphql(qa, {"p": gid, "o": {"id": mau["id"]},
                                          "add": [{"linkedMetafieldValue": SHOP_COLOR_META[color]}]})
                ea = [e.get("message") for e in ((ra.get("data") or {}).get("productOptionUpdate") or {}).get("userErrors", [])]
                if ea:
                    return self.json(400, {"error": "Thêm màu lỗi: %s" % ea[0]})
            # 3) tạo variants theo TÊN value
            variants = []
            for sz in sizes:
                ov = [{"optionName": "Màu", "name": color}]
                if has_size and sz:
                    ov.append({"optionName": "Size", "name": sz})
                variants.append({"price": price, "optionValues": ov})
            qv = ("mutation($pid:ID!,$v:[ProductVariantsBulkInput!]!){"
                  "productVariantsBulkCreate(productId:$pid,variants:$v,strategy:DEFAULT){"
                  "productVariants{id} userErrors{field message}}}")
            res = shopify_graphql(qv, {"pid": gid, "v": variants})
        except Exception as e:
            return self.json(400, {"error": "Lỗi GraphQL: %s" % e})
        data = (res.get("data") or {}).get("productVariantsBulkCreate") or {}
        errs = [e.get("message") for e in (data.get("userErrors") or [])]
        created = data.get("productVariants") or []
        if not created:
            top = (res.get("errors") or [{}])
            msg = errs[0] if errs else (top[0].get("message") if top else "Không thêm được variant (có thể đã tồn tại).")
            return self.json(400, {"error": msg})
        # gán ảnh cho các variant màu mới
        if image and created:
            try:
                b = image.split(",", 1)[1] if str(image).startswith("data:") else image
                vids = [int(str(c["id"]).split("/")[-1]) for c in created if c.get("id")]
                shopify_api("POST", "products/%s/images.json" % pid,
                            {"image": {"attachment": b, "variant_ids": vids}})
            except Exception:
                pass
        return self.json(200, {"ok": True, "count": len(created), "errors": errs})

    def handle_shopify_push(self, body):
        """Đẩy sản phẩm lên Shopify thật (REST Admin API). Mỗi item -> 1 product (Color×Size variant)."""
        items = body.get("items") or []
        if not items:
            return self.json(400, {"error": "Chưa có sản phẩm nào để đẩy."})
        if not shopify_configured():
            return self.json(400, {"error": "Chưa cấu hình Shopify (SHOPIFY_DOMAIN + token/client trong .env)."})
        use_ai = bool(body.get("ai"))
        ptype = (body.get("productType") or "").strip()
        vendor = (body.get("vendor") or "").strip()
        category = (body.get("category") or "").strip()
        tmpl = (body.get("templateSuffix") or "").strip()
        def_desc = (body.get("description") or "").strip()
        sizes = [s for s in (body.get("sizes") or []) if str(s).strip()]
        size_prices = {str(k).strip(): str(v).strip() for k, v in (body.get("size_prices") or {}).items()
                       if str(v).strip()}   # giá riêng theo size (tuỳ chọn)
        size_chart = (body.get("sizeChart") or "").strip()
        coll_title = (body.get("collection") or "").strip()
        coll_id = None
        try:
            coll_id = shopify_collection_id(coll_title) if coll_title else None
        except Exception:
            coll_id = None

        results = []
        for it in items:
            try:
                results.append(self._shopify_one(it, use_ai, ptype, vendor, category, tmpl,
                                                 def_desc, sizes, size_chart, coll_id, size_prices))
            except urllib.error.HTTPError as e:
                results.append({"ok": False, "error": openai_error_message(e)})
            except Exception as e:
                results.append({"ok": False, "error": str(e)})
        return self.json(200, {"results": results})

    def _shopify_one(self, it, use_ai, ptype, vendor, category, tmpl, def_desc, sizes, size_chart, coll_id, size_prices=None):
        variants_in = [v for v in (it.get("variants") or []) if v.get("image")]
        if not variants_in:
            return {"ok": False, "error": "Sản phẩm không có ảnh."}
        has_color = any((v.get("color") or "").strip() for v in variants_in)
        # màu chuẩn hoá + có map swatch không
        std_for = {id(v): shop_norm_color(v.get("color")) for v in variants_in}
        all_mapped = has_color and all(std_for[id(v)] in SHOP_COLOR_META for v in variants_in)
        # 1) Nội dung: intro (AI/tự nhập) + khối mô tả mặc định (size + bảo quản)
        title = (it.get("title") or "").strip()
        custom = (it.get("description") or "").strip() or def_desc
        tags = []
        ai_html = ""
        ai_style = (it.get("style") or "").strip()
        if use_ai and (not title or not custom or not ai_style):
            ai = shopify_listing(variants_in[0]["image"])
            ai_html = ai.get("body_html", "")
            tags = ai.get("tags", [])
            ai_style = ai_style or ai.get("style", "")
        # TÊN theo CÔNG THỨC: "Áo Thun in Tên" + Style + MS + RIENGVN (bỏ tên người)
        if not title:
            parts = ["Áo Thun in Tên"]
            if ai_style:
                parts.append(ai_style)
            parts.append(next_ms())
            parts.append("RIENGVN")
            title = " ".join(parts)
        intro = shop_text_to_html(custom) if custom else ai_html
        body_html = intro or ""
        if "BẢO QUẢN" not in body_html:   # tránh thêm trùng nếu user đã tự nhập
            body_html = (body_html + SHOP_DEFAULT_DESC_HTML) if body_html else SHOP_DEFAULT_DESC_HTML
        price = str(it.get("price") or "0").strip()

        # 2) Options
        product_options = []
        distinct_colors = []
        if has_color:
            seen = set()
            for v in variants_in:
                c = std_for[id(v)]
                if c not in seen:
                    seen.add(c); distinct_colors.append(c)
            if all_mapped:
                product_options.append({"name": "Màu", "linkedMetafield": {
                    "namespace": "shopify", "key": "color-pattern",
                    "values": [SHOP_COLOR_META[c] for c in distinct_colors]}})
            else:
                product_options.append({"name": "Màu", "values": [{"name": c} for c in distinct_colors]})
        if sizes:
            product_options.append({"name": "Size", "values": [{"name": s} for s in sizes]})

        # 3) Variants
        gql_variants = []
        for v in variants_in:
            c = std_for[id(v)]
            for s in (sizes or [None]):
                ov = []
                if has_color:
                    ov.append({"optionName": "Màu",
                               "linkedMetafieldValue": SHOP_COLOR_META[c]} if all_mapped
                              else {"optionName": "Màu", "name": c})
                if s is not None:
                    ov.append({"optionName": "Size", "name": s})
                vprice = (size_prices or {}).get(str(s), price)   # giá riêng theo size nếu có
                vv = {"price": vprice}
                if ov:
                    vv["optionValues"] = ov
                gql_variants.append(vv)

        # 4) Metafields (category metafields theo khuôn)
        metafields = list(SHOP_FIXED_METAFIELDS)
        sz_gids = [SHOP_SIZE_META[s] for s in sizes if s in SHOP_SIZE_META]
        if sz_gids:
            metafields.append({"namespace": "shopify", "key": "size", "type": "list.metaobject_reference",
                               "value": json.dumps(sz_gids)})

        prod_input = {
            "title": title, "descriptionHtml": body_html,
            "status": "ACTIVE" if (it.get("status") == "ACTIVE") else "DRAFT",
            "category": SHOP_CATEGORY,
            "productType": ptype or "Áo thun", "vendor": vendor or "RIENGVN",
            "metafields": metafields,
        }
        if tmpl:
            prod_input["templateSuffix"] = tmpl
        # luôn gắn tag mặc định "q1" cho MỌI sản phẩm (kèm tag AI/ user nếu có)
        tags = list(tags) + [t.strip() for t in (it.get("tags") or []) if str(t).strip()]
        if not any(str(t).strip().lower() == "q1" for t in tags):
            tags.append("q1")
        prod_input["tags"] = tags
        if product_options:
            prod_input["productOptions"] = product_options
        if gql_variants:
            prod_input["variants"] = gql_variants
        if coll_id:
            prod_input["collections"] = ["gid://shopify/Collection/%s" % coll_id]

        q = ("mutation s($input: ProductSetInput!){ productSet(synchronous:true, input:$input){ "
             "product{ id handle variants(first:100){ nodes{ id selectedOptions{ name value } } } } "
             "userErrors{ field message } } }")
        res = shopify_graphql(q, {"input": prod_input})
        if res.get("errors"):
            return {"ok": False, "error": "GraphQL: %s" % json.dumps(res["errors"])[:200]}
        ps = (res.get("data") or {}).get("productSet") or {}
        errs = ps.get("userErrors") or []
        if errs:
            return {"ok": False, "error": "; ".join(e.get("message", "") for e in errs)[:250]}
        prod = ps.get("product") or {}
        gid = prod.get("id", "")
        pid = int(gid.split("/")[-1]) if gid else 0
        # map màu -> numeric variant ids (để gán ảnh)
        color_vids = {}
        for vn in (prod.get("variants") or {}).get("nodes", []):
            cval = next((o["value"] for o in vn.get("selectedOptions", []) if o["name"] == "Màu"), None)
            vid = int(vn["id"].split("/")[-1])
            color_vids.setdefault(cval, []).append(vid)

        # 5) Ảnh qua REST: ẢNH BÌA (ảnh được chọn) đứng đầu -> bảng size -> các ảnh còn lại
        def attach(v, pos):
            img = {"attachment": v["image"], "position": pos}
            if has_color:
                vids = color_vids.get(std_for[id(v)])
                if vids:
                    img["variant_ids"] = vids
            shopify_api("POST", "products/%d/images.json" % pid, {"image": img})

        cover = int(it.get("cover") or 0)
        if cover < 0 or cover >= len(variants_in):
            cover = 0
        order = [cover] + [i for i in range(len(variants_in)) if i != cover]
        pos = 1
        # ẢNH BÌA RIÊNG (tuỳ chọn) -> vị trí 1 = featured (không gắn variant)
        cover_src = (it.get("coverImage") or "").strip()
        if cover_src:
            cd, _ = fetch_image_bytes(cover_src)
            if cd:
                shopify_api("POST", "products/%d/images.json" % pid,
                            {"image": {"attachment": base64.b64encode(cd).decode(),
                                       "position": pos, "alt": "Ảnh bìa"}})
                pos += 1
        # ảnh variant được chọn (featured nếu không có ảnh bìa riêng)
        attach(variants_in[order[0]], pos); pos += 1
        # (KHÔNG còn tự thêm ảnh bảng size vào media — chỉ ảnh áo)
        for i in order[1:]:
            attach(variants_in[i], pos); pos += 1

        shopify_publish_all(gid)   # bật tất cả kênh bán (Online Store, FB&IG, TikTok, Google)

        return {"ok": True, "url": shop_admin_url(pid),
                "store_url": ("https://rieng.vn/products/%s" % prod.get("handle", "")) if prod.get("handle") else "",
                "title": title}

    def handle_product_content(self, body):
        """Viết content bán hàng (Facebook Ads + TikTok script + caption) từ ảnh sản phẩm."""
        if not API_KEY:
            return self.json(400, {"error": "Chưa cấu hình OPENAI_API_KEY."})
        src = body.get("image", "")
        img = None
        if src:
            img, _ = fetch_image_bytes(src)
        try:
            out = product_content(img, body.get("info", ""))
        except urllib.error.HTTPError as e:
            return self.json(502, {"error": openai_error_message(e)})
        except Exception as e:
            return self.json(500, {"error": "Viết content lỗi: %s" % e})
        return self.json(200, out)

    def handle_product_photos(self, body):
        """Tạo ảnh sản phẩm (model/flatlay/kraft) từ 1 ảnh sản phẩm, gpt-image-2 edits."""
        if not API_KEY:
            return self.json(400, {"error": "Chưa cấu hình OPENAI_API_KEY."})
        src = body.get("image", "")
        if not src:
            return self.json(400, {"error": "Chưa có ảnh sản phẩm."})
        d, _ = fetch_image_bytes(src)
        if not d:
            return self.json(400, {"error": "Không đọc được ảnh sản phẩm."})
        cats = [c for c in (body.get("cats") or []) if c in PRODUCT_CATS]
        if not cats:
            return self.json(400, {"error": "Hãy chọn ít nhất 1 nhóm ảnh."})
        aspect = (body.get("aspect") or "auto").strip()
        seg = body.get("segment", "single")
        if seg not in PRODUCT_SEGMENTS:
            seg = "single"
        shots = []
        for c in cats:
            meta = PRODUCT_CATS[c]
            variants = PRODUCT_SEGMENTS[seg]["model"] if c == "model" else meta["variants"]
            for vk, vlabel in variants:
                sz = ASPECT_TO_SIZE.get(aspect, meta["size"]) if aspect != "auto" else meta["size"]
                asp = aspect if aspect != "auto" else ""
                shots.append({"cat": c, "vk": vk, "size": sz, "aspect": asp, "seg": seg,
                              "label": "%s · %s" % (meta["label"], vlabel)})
        bg_key = body.get("bg", "cafe")
        engine = resolve_engine_id(body)
        # AI tự viết prompt (Claude/OpenAI vision) — cần ANTHROPIC_API_KEY hoặc OPENAI_API_KEY.
        ai_prompt = bool(body.get("ai_prompt")) and bool(ANTHROPIC_API_KEY or API_KEY)
        with _batch_lock:
            _batch_seq[0] += 1
            job_id = "p%d_%d" % (int(time.time()), _batch_seq[0])
            BATCH_JOBS[job_id] = {"total": len(shots), "done": 0, "items": [],
                                  "errors": [], "finished": False}
        t = threading.Thread(target=run_product_job,
                             args=(job_id, d, shots, bg_key, engine, ai_prompt),
                             daemon=True)
        t.start()
        return self.json(200, {"job_id": job_id, "total": len(shots)})

    def handle_ads_text(self, body):
        """AI nhìn design -> tên SP + hook ads."""
        if not API_KEY:
            return self.json(400, {"error": "Chưa cấu hình OPENAI_API_KEY."})
        d, _ = fetch_image_bytes(body.get("image", ""))
        if not d:
            return self.json(400, {"error": "Cần ảnh design."})
        try:
            return self.json(200, ads_concept_text(d))
        except Exception as e:
            return self.json(500, {"error": str(e)})

    def handle_ads_generate(self, body):
        """Gen ảnh Facebook Ads theo các concept (mỗi concept 1 ảnh style ref)."""
        if not API_KEY and not GEMINI_API_KEY:
            return self.json(400, {"error": "Chưa cấu hình OPENAI_API_KEY / GEMINI_API_KEY."})
        dsrc = body.get("image", "")
        dd, dm = fetch_image_bytes(dsrc)
        if not dd:
            return self.json(400, {"error": "Cần ảnh DESIGN."})
        name = (body.get("name") or "").strip() or "Áo thun"
        hook = (body.get("hook") or "").strip()
        cons = []
        for c in (body.get("concepts") or []):
            key = c.get("key")
            if key not in ADS_CONCEPTS:
                continue
            ref = None
            if c.get("ref"):
                rb, _ = fetch_image_bytes(c["ref"])
                ref = rb
            cons.append({"key": key, "ref": ref, "bg": (c.get("bg") or "").strip()[:200],
                         "custom_prompt": (c.get("custom_prompt") or "").strip()[:4000]})
        if not cons:
            return self.json(400, {"error": "Chọn ít nhất 1 concept (và nên có ảnh style)."})
        engine = resolve_engine_id(body)
        aspect = (body.get("aspect") or "4:5").strip()
        text_style = (body.get("text_style") or "").strip()[:200]
        quality = (body.get("quality") or "medium").strip()
        if quality not in ("low", "medium", "high"):
            quality = "medium"
        text_color = (body.get("text_color") or "").strip()[:60]
        brand = (body.get("brand") if body.get("brand") is not None else "rieng.vn")
        brand = str(brand).strip()[:40]
        text_style_img = None
        if body.get("text_style_img"):
            tsb, _ = fetch_image_bytes(body["text_style_img"])
            text_style_img = tsb
        with _batch_lock:
            _batch_seq[0] += 1
            job_id = "ad%d_%d" % (int(time.time()), _batch_seq[0])
            BATCH_JOBS[job_id] = {"total": len(cons), "done": 0, "items": [], "errors": [], "finished": False}
        t = threading.Thread(target=run_ads_job,
                             args=(job_id, (dd, dm or "image/png"), cons, name, hook, engine, aspect, text_style, text_style_img, quality, text_color, brand), daemon=True)
        t.start()
        return self.json(200, {"job_id": job_id, "total": len(cons)})

    def handle_fb_ads_push(self, body):
        """Đẩy 1 ảnh ads lên tài khoản Facebook Ads -> tạo Campaign/AdSet/Creative/Ad (PAUSED)."""
        img, _ = fetch_image_bytes(body.get("image", ""))
        r = fb_ads_push_core(
            img, body.get("link"), body.get("message"), body.get("headline"), body.get("name"),
            body.get("daily_budget"), body.get("age_min"), body.get("age_max"),
            body.get("genders") or [], body.get("countries") or ["VN"], body.get("cta"),
            (body.get("campaign_id") or "").strip(), (body.get("adset_id") or "").strip(),
            (body.get("campaign_name") or "").strip(), (body.get("adset_name") or "").strip())
        if not r.get("ok"):
            return self.json(400, {"error": r.get("error")})
        return self.json(200, r)

    def handle_fbpost_generate(self, body):
        """Gen các BỘ ảnh sạch (không text) cho FB Post — mỗi concept 1 bộ per_set ảnh."""
        if not API_KEY and not GEMINI_API_KEY:
            return self.json(400, {"error": "Chưa cấu hình OPENAI_API_KEY / GEMINI_API_KEY."})
        dd, dm = fetch_image_bytes(body.get("image", ""))
        if not dd:
            return self.json(400, {"error": "Cần ảnh DESIGN."})
        cons = []
        for c in (body.get("concepts") or []):
            key = c.get("key")
            if key not in ADS_CONCEPTS:
                continue
            ref = None
            if c.get("ref"):
                rb, _ = fetch_image_bytes(c["ref"]); ref = rb
            cons.append({"key": key, "ref": ref, "bg": (c.get("bg") or "").strip()[:200]})
        if not cons:
            return self.json(400, {"error": "Chọn ít nhất 1 concept."})
        engine = resolve_engine_id(body)
        aspect = (body.get("aspect") or "4:5").strip()
        quality = (body.get("quality") or "medium").strip()
        if quality not in ("low", "medium", "high"):
            quality = "medium"
        try:
            per_set = max(1, min(6, int(body.get("per_set") or 4)))
        except Exception:
            per_set = 4
        with _batch_lock:
            _batch_seq[0] += 1
            job_id = "fbp%d_%d" % (int(time.time()), _batch_seq[0])
            BATCH_JOBS[job_id] = {"total": len(cons), "done": 0, "items": [], "errors": [], "finished": False}
        threading.Thread(target=run_fbpost_job,
                         args=(job_id, (dd, dm or "image/png"), cons, engine, aspect, quality, per_set),
                         daemon=True).start()
        return self.json(200, {"job_id": job_id, "total": len(cons)})

    def handle_fb_post(self, body):
        """Đăng 1 BỘ ảnh lên Fanpage Facebook (rieng.vn) — multi-photo feed post."""
        if not (FB_ACCESS_TOKEN and FB_PAGE_ID):
            return self.json(400, {"error": "Chưa cấu hình Facebook (FB_PAGE_ID + FB_ACCESS_TOKEN)."})
        urls = body.get("image_urls") or []
        message = (body.get("message") or "").strip()
        if not urls:
            return self.json(400, {"error": "Thiếu ảnh để đăng."})
        host = self.headers.get("Host") or ""

        def absu(u):
            if not u:
                return ""
            if str(u).startswith("http"):
                return u
            return "https://%s%s" % (host, u if u.startswith("/") else "/" + u)

        if "localhost" in host or "127.0.0.1" in host:
            return self.json(400, {"error": "Đăng FB chỉ chạy trên bản LIVE (Facebook cần URL ảnh công khai), không chạy localhost."})
        r = fb_post_core([absu(u) for u in urls], message)
        if not r.get("ok"):
            return self.json(400, {"error": r.get("error")})
        return self.json(200, {"ok": True, "post_id": r.get("id"), "url": r.get("url")})

    def handle_prod_generate(self, body):
        """Ảnh sản phẩm kiểu Freepik: gen từ PROMPT + ảnh tham chiếu."""
        if not API_KEY and not GEMINI_API_KEY:
            return self.json(400, {"error": "Chưa cấu hình OPENAI_API_KEY / GEMINI_API_KEY."})
        prompt = (body.get("prompt") or "").strip()
        if not prompt:
            return self.json(400, {"error": "Hãy nhập mô tả (prompt)."})
        srcs = [s for s in (body.get("images") or []) if s][:6]
        imgs = []
        for s in srcs:
            d, m = fetch_image_bytes(s)
            if d:
                imgs.append((d, m or "image/png"))
        if not imgs:
            return self.json(400, {"error": "Cần ít nhất 1 ảnh tham chiếu (ảnh áo/design)."})
        # ảnh STYLE (tuỳ chọn) -> thêm làm ref CUỐI + chỉ thị copy phong cách
        style_src = body.get("style", "")
        if style_src:
            sd, sm = fetch_image_bytes(style_src)
            if sd:
                imgs.append((sd, sm or "image/png"))
                prompt += (" Use the FINAL reference image PURELY as a STYLE reference — match its "
                           "colour palette, lighting, mood, texture and overall artistic/visual style; "
                           "do NOT copy its content, subject, text or layout, only its look & feel.")
        engine = resolve_engine_id(body)
        aspect = (body.get("aspect") or "4:5").strip()
        try:
            count = max(1, min(int(body.get("count", 1) or 1), 4))
        except Exception:
            count = 1
        with _batch_lock:
            _batch_seq[0] += 1
            job_id = "pg%d_%d" % (int(time.time()), _batch_seq[0])
            BATCH_JOBS[job_id] = {"total": count, "done": 0, "items": [], "errors": [], "finished": False}
        t = threading.Thread(target=run_prod_gen_job,
                             args=(job_id, imgs, prompt, engine, aspect, count), daemon=True)
        t.start()
        return self.json(200, {"job_id": job_id, "total": count})

    def handle_prod_suggest(self, body):
        """AI nhìn ảnh tham chiếu -> gợi ý 1 prompt ảnh sản phẩm (cho user sửa)."""
        if not (ANTHROPIC_API_KEY or API_KEY):
            return self.json(400, {"error": "Chưa cấu hình ANTHROPIC_API_KEY / OPENAI_API_KEY."})
        src = body.get("image", "")
        d, _ = fetch_image_bytes(src)
        if not d:
            return self.json(400, {"error": "Cần ảnh tham chiếu."})
        kind = body.get("kind", "model")
        m = {"model": ("model", "solo_f"), "flatlay": ("flatlay", "spread"),
             "white": ("white", "topdown"), "kraft": ("kraft", "topdown")}
        cat, vk = m.get(kind, ("model", "solo_f"))
        try:
            p = product_prompt_ai(d, cat, vk, body.get("bg", "cafe"), "single")
            return self.json(200, {"prompt": p})
        except urllib.error.HTTPError as e:
            return self.json(400, {"error": openai_error_message(e)})
        except Exception as e:
            return self.json(500, {"error": str(e)})

    def handle_product_seg(self, body):
        """Ảnh sản phẩm theo TỆP: AI đọc design -> tự đổi tên (couple/gia đình/nhóm/1 mình) -> gen."""
        if not API_KEY:
            return self.json(400, {"error": "Chưa cấu hình OPENAI_API_KEY."})
        src = body.get("image", "")
        if not src:
            return self.json(400, {"error": "Chưa có ảnh sản phẩm."})
        d, _ = fetch_image_bytes(src)
        if not d:
            return self.json(400, {"error": "Không đọc được ảnh sản phẩm."})
        base_b64 = base64.b64encode(d).decode()
        cats = [c for c in (body.get("cats") or []) if c in PRODUCT_CATS]
        if not cats:
            return self.json(400, {"error": "Hãy chọn ít nhất 1 nhóm ảnh."})
        seg = body.get("segment", "single")
        if seg == "auto":                       # AI nhìn design tự đoán tệp
            seg = detect_product_seg(d)
        if seg not in PRODUCT_SEGMENTS:
            seg = "single"
        theme = (body.get("theme") or "").strip()
        aspect = (body.get("aspect") or "auto").strip()
        shots = []
        for c in cats:
            meta = PRODUCT_CATS[c]
            variants = PRODUCT_SEGMENTS[seg]["model"] if c == "model" else meta["variants"]
            for vk, vlabel in variants:
                sz = ASPECT_TO_SIZE.get(aspect, meta["size"]) if aspect != "auto" else meta["size"]
                asp = aspect if aspect != "auto" else ""
                shots.append({"cat": c, "vk": vk, "size": sz, "aspect": asp, "seg": seg,
                              "label": "%s · %s" % (meta["label"], vlabel)})
        bg_key = body.get("bg", "cafe")
        engine = resolve_engine_id(body)
        ai_prompt = bool(body.get("ai_prompt")) and bool(ANTHROPIC_API_KEY or API_KEY)
        with _batch_lock:
            _batch_seq[0] += 1
            job_id = "ps%d_%d" % (int(time.time()), _batch_seq[0])
            BATCH_JOBS[job_id] = {"total": len(shots), "done": 0, "items": [],
                                  "errors": [], "finished": False}
        t = threading.Thread(target=run_product_seg_job,
                             args=(job_id, base_b64, seg, theme, shots, bg_key, engine, ai_prompt),
                             daemon=True)
        t.start()
        return self.json(200, {"job_id": job_id, "total": len(shots)})

    def handle_product_prompts(self, body):
        """BƯỚC 1: AI nhìn ảnh áo -> sinh prompt cho các shot (để user duyệt trước khi gen)."""
        if not (ANTHROPIC_API_KEY or API_KEY):
            return self.json(400, {"error": "Chưa cấu hình ANTHROPIC_API_KEY hoặc OPENAI_API_KEY."})
        src = body.get("image", "")
        if not src:
            return self.json(400, {"error": "Chưa có ảnh sản phẩm."})
        d, _ = fetch_image_bytes(src)
        if not d:
            return self.json(400, {"error": "Không đọc được ảnh sản phẩm."})
        cats = [c for c in (body.get("cats") or []) if c in PRODUCT_CATS]
        if not cats:
            return self.json(400, {"error": "Hãy chọn ít nhất 1 nhóm ảnh."})
        aspect = (body.get("aspect") or "auto").strip()
        seg = body.get("segment", "single")
        if seg not in PRODUCT_SEGMENTS:
            seg = "single"
        shots = []
        for c in cats:
            meta = PRODUCT_CATS[c]
            variants = PRODUCT_SEGMENTS[seg]["model"] if c == "model" else meta["variants"]
            for vk, vlabel in variants:
                sz = ASPECT_TO_SIZE.get(aspect, meta["size"]) if aspect != "auto" else meta["size"]
                asp = aspect if aspect != "auto" else ""
                shots.append({"cat": c, "vk": vk, "size": sz, "aspect": asp, "seg": seg,
                              "label": "%s · %s" % (meta["label"], vlabel)})
        bg_key = body.get("bg", "cafe")
        with _batch_lock:
            _batch_seq[0] += 1
            job_id = "pp%d_%d" % (int(time.time()), _batch_seq[0])
            BATCH_JOBS[job_id] = {"total": len(shots), "done": 0, "items": [],
                                  "errors": [], "finished": False}
        t = threading.Thread(target=run_prompt_job, args=(job_id, d, shots, bg_key),
                             daemon=True)
        t.start()
        return self.json(200, {"job_id": job_id, "total": len(shots)})

    def handle_product_render(self, body):
        """BƯỚC 2: gen ảnh từ các prompt người dùng đã chọn (Nano Banana nếu bật)."""
        if not API_KEY and not GEMINI_API_KEY:
            return self.json(400, {"error": "Chưa cấu hình OPENAI_API_KEY / GEMINI_API_KEY."})
        src = body.get("image", "")
        if not src:
            return self.json(400, {"error": "Chưa có ảnh sản phẩm."})
        d, _ = fetch_image_bytes(src)
        if not d:
            return self.json(400, {"error": "Không đọc được ảnh sản phẩm."})
        picks = []
        for p in (body.get("prompts") or []):
            txt = (p.get("prompt") or "").strip()
            if len(txt) < 10:
                continue
            picks.append({"prompt": txt, "title": (p.get("title") or "Ảnh").strip(),
                          "size": p.get("size") or "1024x1024", "aspect": p.get("aspect", "")})
        if not picks:
            return self.json(400, {"error": "Chưa chọn prompt nào để gen."})
        engine = resolve_engine_id(body)
        with _batch_lock:
            _batch_seq[0] += 1
            job_id = "pr%d_%d" % (int(time.time()), _batch_seq[0])
            BATCH_JOBS[job_id] = {"total": len(picks), "done": 0, "items": [],
                                  "errors": [], "finished": False}
        t = threading.Thread(target=run_render_job, args=(job_id, d, picks, engine),
                             daemon=True)
        t.start()
        return self.json(200, {"job_id": job_id, "total": len(picks)})

    def handle_batch_excel(self, body):
        """Nhận file .xlsx (base64) có ảnh nhúng + cột Tên/Ngày -> gen hàng loạt nhiều luồng."""
        if not API_KEY:
            return self.json(400, {"error": "Chưa cấu hình OPENAI_API_KEY."})
        f = body.get("file", "")
        if f.startswith("data:"):
            f = f.split(",", 1)[1]
        if not f:
            return self.json(400, {"error": "Chưa có file Excel."})
        try:
            raw = base64.b64decode(f)
            headers, rows = parse_xlsx_with_images(raw)
        except Exception as e:
            return self.json(400, {"error": "Đọc Excel lỗi: %s" % e})
        rows = [r for r in rows if r.get("image")]
        if not rows:
            return self.json(400, {"error": "Không thấy ảnh mẫu nhúng trong Excel. Hãy "
                                   "chèn ảnh bằng Insert > Picture vào từng dòng (mỗi dòng 1 ảnh)."})
        size = SIZE_MAP.get(body.get("size", "portrait"), "1024x1536")
        transparent = bool(body.get("transparent", True))
        with _batch_lock:
            _batch_seq[0] += 1
            job_id = "b%d_%d" % (int(time.time()), _batch_seq[0])
            BATCH_JOBS[job_id] = {"total": len(rows), "done": 0, "items": [],
                                  "errors": [], "finished": False}
        t = threading.Thread(target=run_batch_job,
                             args=(job_id, rows, size, transparent), daemon=True)
        t.start()
        return self.json(200, {"job_id": job_id, "total": len(rows), "headers": headers})

    def handle_save_design(self, body):
        """Lưu 1 ảnh (đã xử lý phía client, vd ghép nền) vào Lịch sử."""
        img = body.get("image", "")
        if img.startswith("data:"):
            img = img.split(",", 1)[1]
        if not img:
            return self.json(400, {"error": "Thiếu ảnh."})
        try:
            base64.b64decode(img)  # kiểm tra hợp lệ
        except Exception:
            return self.json(400, {"error": "Ảnh không hợp lệ."})
        mode = body.get("mode", "bg")
        label = (body.get("label", "") or "")[:160]
        item = gallery_add(img, {"mode": mode, "prompt": label})
        return self.json(200, {"gallery": item})

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
    start_scheduler()
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()

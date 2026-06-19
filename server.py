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
MODEL = os.environ.get("OPENAI_IMAGE_MODEL", "gpt-image-1").strip()
# Model "đọc ảnh + nghĩ ý tưởng" (vision) cho chế độ Auto. gpt-4o-mini có vision, rẻ.
TEXT_MODEL = os.environ.get("OPENAI_TEXT_MODEL", "gpt-4o-mini").strip()
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
               "the shirt is DARK, so use bright, light, pastel or white colors with "
               "light/white outlines; avoid black or very dark elements that vanish on black"),
    "white":  ("trắng", "#f5f5f5",
               "the shirt is LIGHT, so use deep, rich, saturated colors with dark/black "
               "outlines; avoid white or very pale elements that vanish on white"),
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


def recolor_instruction(key):
    """Chỉ thị TIẾNG ANH: giữ nguyên design, CHỈ phối lại màu cho hợp màu áo."""
    vi, hexv, guide = RECOLOR[key]
    return ("Keep the illustration, text, fonts and composition IDENTICAL — do not redraw "
            "anything. Re-map ONLY the colors so the design stays vivid and clearly visible "
            "when printed on a %s (%s) t-shirt: %s. Output only the artwork, no shirt, no "
            "background." % (vi, hexv, guide))


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


def openai_edit(images, prompt, size, native_transparent):
    fields = [("model", MODEL), ("prompt", prompt), ("n", "1"),
              ("moderation", "low")]   # hạ độ gắt bộ lọc -> đỡ chặn nhầm
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


def openai_chat(messages, json_mode=True, max_tokens=1500):
    """Gọi AI text/vision (chat completions). Trả về nội dung text của câu trả lời."""
    payload = {"model": TEXT_MODEL, "messages": messages, "max_tokens": max_tokens}
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    req = urllib.request.Request(CHAT_URL, data=json.dumps(payload).encode(),
                                 method="POST")
    req.add_header("Authorization", "Bearer " + API_KEY)
    req.add_header("Content-Type", "application/json")
    res = json.loads(_openai_call(req, timeout=120))
    return res["choices"][0]["message"]["content"]


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
          "printed design on the left chest exactly as shown in the reference product image "
          "(do not redraw or alter the design), clean ribbed crewneck collar with no visible "
          "tags or labels, natural soft wrinkles only at the underarms")
_CAM = ("Casual smartphone photo. Sharp, clean, naturally exposed — no beauty filter, no "
        "portrait blur, no skin smoothing, no grain. Feels like a friend took it. Aspect ratio 4:5.")
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

_FNEG = (" Negative extra: bunched fabric, rolled hem, curled edges, shirt hanging off the surface, "
         "single oval logo, pill shape logo.")
_FLAT_BASE = ("flatlay photo of the t-shirt from the reference product image on a light cream "
              "fabric sofa seat cushion, lying fully on the cushion (not hanging off the edge), "
              "clean ribbed collar with no tags, the printed design clearly visible exactly as in "
              "the reference. Soft natural daylight, bright airy neutral, fabric color true to "
              "life, no props.")
_WHITE_BASE = ("product photo of the t-shirt from the reference product image on a pure white "
               "seamless background, oversized form clearly visible, the printed design clearly "
               "visible exactly as in the reference, clean collar no tags, soft even neutral "
               "lighting, no props, no shadows.")
_WNEG = " Negative extra: folded shirt, rolled sleeves, cream or beige or grey background, textured surface."
_KRAFT_BASE = ("photo of the t-shirt from the reference product image inside a plain unprinted kraft "
               "FLIP-OPEN box (hinged lid open at the back, NOT a separate lid / shoe box), lined "
               "with thin white tissue paper, the printed design clearly visible exactly as in the "
               "reference, soft natural daylight bright neutral, no props besides the kraft box and "
               "white tissue.")
_KNEG = (" Negative extra: stickers, ribbons, greeting card, dried flowers, printed box, branded box, "
         "separate lid box, detached lid, shoe box style lid.")


def product_prompt(cat, vk, bg_key):
    bg = PRODUCT_BG.get(bg_key, PRODUCT_BG["cafe"])
    if cat == "model":
        if vk.startswith("couple"):
            pose = {"couple_34": "Three-quarter shot from mid-thigh up. They stand side by side, "
                    "shoulders lightly touching, both looking at the camera with bright cheerful smiles.",
                    "couple_wu": "Waist-up shot. They stand very close, shoulders touching, both "
                    "facing the camera with bright sparkling eyes and cheerful natural smiles.",
                    "couple_lean": "Waist-up shot. She leans her head gently on his shoulder, he "
                    "tilts his head slightly toward hers, both relaxed with gentle cheerful smiles."}[vk]
            return ("A candid casual smartphone photo of a young Vietnamese couple %s. The woman is "
                    "%s. The man is %s. Both wearing %s. %s The fabric colors stay true to life, "
                    "well exposed. %s %s" % (bg, _MODEL_F, _MODEL_M, _SHIRT, pose, _CAM, PRODUCT_NEG))
        if vk == "chest":
            return ("A candid casual smartphone photo, chest-level crop of a young Vietnamese person "
                    "wearing %s — framed from just below the collar to above the waist, NO face "
                    "visible, slightly off-center angle as if a friend zoomed in on a phone. %s "
                    "Directional natural daylight from one side creating slight shadow depth on the "
                    "fabric, dimensional not flat, real cotton fabric texture visible, the design "
                    "large and clearly readable. %s %s" % (_SHIRT, bg, _CAM, PRODUCT_NEG))
        who = _MODEL_F if vk == "solo_f" else _MODEL_M
        pose = ("one hand holding her bag strap" if vk == "solo_f" else "one hand relaxed in his pocket")
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


def run_product_job(job_id, img, shots, bg_key):
    def work(shot):
        try:
            b64 = openai_edit([(img, "image/png")],
                              product_prompt(shot["cat"], shot["vk"], bg_key),
                              shot["size"], native_transparent=False)
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


CONTENT_SYSTEM = (
    "Bạn là chuyên viết content bán hàng cho shop áo thun couple / quà tặng GenZ Việt Nam "
    "(brand rieng.vn). Nhìn ảnh sản phẩm để hiểu áo (màu, phong cách, cảm xúc) — KHÔNG bịa "
    "chi tiết không có. Viết tiếng Việt, giọng trẻ trung tự nhiên như bạn bè, KHÔNG sáo rỗng "
    "(tránh 'chất lượng cao', 'giá tốt nhất', 'uy tín').\n"
    "Trả về JSON đúng dạng: {\"facebook\":\"...\",\"tiktok_script\":\"...\",\"tiktok_caption\":\"...\"}.\n\n"
    "1) facebook — 1 bài Facebook Ads: dòng HOOK gây chú ý (cảm xúc/câu hỏi/pain point cặp đôi "
    "GenZ) → BODY 2–4 dòng ngắn mô tả sản phẩm tự nhiên → CTA rõ ràng (chèn link/giá nếu có) → "
    "5–8 hashtag tiếng Việt. Emoji vừa phải, có thể chơi chữ nhẹ.\n\n"
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
    "korean_minimal": ("Korean Minimal Lettering", "korean minimal lettering t-shirt"),
    "motivational": ("Motivational / Quote Bold", "bold motivational quote t-shirt typography"),
    "street_racing": ("Street Racing / Automotive", "vintage street racing automotive t-shirt"),
    "vintage_washed": ("Vintage Washed / Distressed", "vintage washed distressed t-shirt typography"),
    "y2k_graffiti": ("Y2K Graffiti / Bubble", "y2k graffiti bubble t-shirt typography"),
    "badge_patch": ("Retro Badge / Patch", "retro streetwear patch badge collage t-shirt"),
    "couple_love": ("Couple / L\u1eddi nh\u1eafn t\xecnh y\xeau", "couple matching love t-shirt typography"),
    "city_souvenir": ("Local Place / City Souvenir", "city souvenir local place t-shirt typography"),
    "statement_bold": ("Statement / Edgy Bold", "bold edgy statement t-shirt typography"),
    "funny_vn": ("Funny Quote (ti\u1ebfng Vi\u1ec7t)", "funny Vietnamese quote t-shirt typography"),
    "floral_quote": ("Aesthetic Floral + Quote", "aesthetic floral quote t-shirt"),
    "luxury_minimal": ("Luxury Minimal Back-print", "luxury minimal back-print t-shirt"),
    "social_club": ("Social Club / Community", "social club community t-shirt typography"),
    "sport_statement": ("Sport / Athletic Statement", "sport athletic statement t-shirt typography"),
    "liquid_chrome": ("Liquid Chrome / 3D Y2K", "liquid chrome 3D y2k t-shirt typography"),
    "scribble": ("Scribble / Handwritten", "scribble handwritten sketch t-shirt typography"),
    "streetwear": ("Streetwear", "modern urban streetwear t-shirt graphic, bold oversized hype/hypebeast aesthetic"),
    "graffiti_tag": ("Graffiti / Wildstyle", "graffiti wildstyle spray-paint tag t-shirt graphic, urban wall art, drips and bold outlines"),
    "grunge_punk": ("Grunge / Punk", "grunge punk streetwear t-shirt graphic, distressed photocopy zine aesthetic, ripped collage, safety-pin DIY vibe"),
    "cyberpunk": ("Cyberpunk / Techwear", "cyberpunk techwear streetwear t-shirt graphic, neon glitch, futuristic HUD, dystopian Japanese signage"),
    "skate": ("Skate / Skateboard", "skate skateboard streetwear t-shirt graphic, bold cartoon, old-school skate logo vibe"),
    "rap_bootleg": ("Rap Bootleg 90s", "90s rap bootleg t-shirt graphic, photo halftone portrait with bold arched text and stars, vintage rap tee"),
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
    "anime": ("Anime / manga", "anime/manga t-shirt graphic with CLEAN bold black linework and screentone/halftone shading, a RESTRAINED LIMITED palette (monochrome or just 2-3 muted colors), tasteful and print-friendly for screen printing, NOT oversaturated, NOT rainbow, suited for a wearable t-shirt"),
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
    "NGÔN NGỮ chữ trên design: dùng tiếng Anh HOẶC tiếng Việt — chọn cái HỢP PHONG CÁCH & ĐẸP "
    "nhất (streetwear/typography/quote thường tiếng Anh cho ngầu), KHÔNG bắt buộc tiếng Việt. "
    "Chỉ khi người dùng nhập sẵn chữ tiếng Việt thì giữ nguyên ĐÚNG DẤU.\n"
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
                out.append({"title": (d.get("title") or "Design").strip()[:80], "prompt": p})
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


DESIGN_MAX_TOTAL = 24      # trần tổng số mẫu / lần (tránh đốt credit)
DESIGN_WORKERS = 5         # số luồng gen ảnh song song


def run_design_job(job_id, styles, theme, text, n, size, transparent, ref=None, year="", same_line=False):
    # Bước 1: AI nghĩ n design. Có ảnh ref -> nhận diện style từ ảnh; không thì theo style đã chọn
    err_msg = None
    try:
        if ref:
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
        c["title"] = "[%s] %s" % (style_tag, c.get("title", "Design"))
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
                try:
                    b64 = base64.b64encode(
                        remove_flat_bg(base64.b64decode(b64))).decode()
                except Exception:
                    pass
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
        if path == "/api/me":
            u = self.current_user()
            if not u:
                return self.json(401, {"error": "Chưa đăng nhập"})
            return self.json(200, {"user": u})
        if path == "/api/gallery":
            return self.json(200, {"items": gallery_load()})
        if path == "/api/mockups":
            return self.json(200, {"items": list_mockups()})
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
        if path == "/api/auto-gen":
            return self.handle_auto_gen(body)
        if path == "/api/recolor":
            return self.handle_recolor(body)
        if path == "/api/save-design":
            return self.handle_save_design(body)
        if path == "/api/batch-excel":
            return self.handle_batch_excel(body)
        if path == "/api/product-photos":
            return self.handle_product_photos(body)
        if path == "/api/product-content":
            return self.handle_product_content(body)
        if path == "/api/design-gen":
            return self.handle_design_gen(body)
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
        colors = [c for c in (body.get("colors") or []) if c in RECOLOR]
        if not colors:
            return self.json(400, {"error": "Hãy chọn ít nhất 1 màu áo."})
        size = SIZE_MAP.get(body.get("size", "portrait"), "1024x1536")

        d, m = fetch_image_bytes(img_src)
        if not d:
            return self.json(400, {"error": "Không đọc được ảnh design."})
        img = [(d, m)]

        items, errors = [], []
        for key in colors:
            vi, hexv = RECOLOR[key][0], RECOLOR[key][1]
            try:
                # vẽ bản TÁCH NỀN (để client ghép nền tuỳ ý), lưu bản này vào lịch sử
                b64, _ = gen_design(img, "cloner", recolor_instruction(key),
                                    size, True)
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
        ref_bytes = None
        ref_src = body.get("ref", "")
        if ref_src:
            ref_bytes, _ = fetch_image_bytes(ref_src)
        if not styles and not ref_bytes:
            return self.json(400, {"error": "Hãy chọn ít nhất 1 phong cách hoặc tải ảnh tham chiếu."})
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
                                   body.get("year", ""), bool(body.get("same_line"))),
                             daemon=True)
        t.start()
        return self.json(200, {"job_id": job_id, "total": total_est})

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
        shots = []
        for c in cats:
            meta = PRODUCT_CATS[c]
            for vk, vlabel in meta["variants"]:
                shots.append({"cat": c, "vk": vk, "size": meta["size"],
                              "label": "%s · %s" % (meta["label"], vlabel)})
        bg_key = body.get("bg", "cafe")
        with _batch_lock:
            _batch_seq[0] += 1
            job_id = "p%d_%d" % (int(time.time()), _batch_seq[0])
            BATCH_JOBS[job_id] = {"total": len(shots), "done": 0, "items": [],
                                  "errors": [], "finished": False}
        t = threading.Thread(target=run_product_job, args=(job_id, d, shots, bg_key),
                             daemon=True)
        t.start()
        return self.json(200, {"job_id": job_id, "total": len(shots)})

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
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()

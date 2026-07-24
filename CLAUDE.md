# AI Design 2D — rieng.vn

Tool nội bộ cho brand áo thun POD **rieng.vn** (couple/cá nhân hoá, khách GenZ Việt). Chủ tool: Trung (tiếng Việt). LIVE tại **https://riengvnapp.cloud** — Dokploy tự deploy khi push lên `main` của repo này.

## Kiến trúc

- **Python stdlib thuần** — `server.py` (~9.500 dòng) chạy `ThreadingHTTPServer`, KHÔNG framework, KHÔNG package ngoài (PIL optional qua `HAS_PIL`). Frontend: `public/index.html` + `public/app.js` (~460KB) vanilla JS, không build step.
- AI engines (key trong `.env`, prod có đủ 3):
  - `gpt-image` (OpenAI, `MODEL`) — `openai_edit/openai_generate`, moderation=low, quality low/medium/high.
  - **Nano Banana Pro** = `gemini_edit(images, prompt, aspect, model="gemini-3-pro-image-preview")`; `gemini_flash` = 2.5 (RẺ nhưng **vẽ chữ/layout kém — cấm dùng cho design/plate**). `images=[]` → text-to-image.
  - Claude API `claude_vision / claude_vision_multi / claude_text` (`ANTHROPIC_MODEL=claude-opus-4-8`) — người viết prompt chính.
- Job nền: `BATCH_JOBS` + `_batch_lock` + `_batch_seq`; FE poll `/api/batch-status?id=..&have=N` (**have = số item đã nhận, server chỉ trả phần mới**); job có `note` (tiến độ realtime) + `partial` (ảnh xong tấm nào hiện tấm đó).
- Gallery: file PNG trong `gallery/` + `index.json`; **thumbnail JPEG lười-tạo** tại `/gallery/t/<id>.jpg` (FE dùng `gthumb(url)` cho mọi lưới nhỏ); `/api/gallery-clear` dọn kho (giữ ảnh mà bài pgpost chưa đăng còn tham chiếu).

## QUY TẮC CỨNG CỦA USER (không được vi phạm)

1. **100% ảnh phải do Claude viết prompt** — không fallback template âm thầm; Claude lỗi → retry (3 lần, backoff) rồi BÁO LỖI ĐỎ rõ ràng.
2. **Mỗi ảnh 1 prompt RIÊNG BIỆT** đúng skill (không dùng 1 cảnh chung cho cả bộ) — `fbpost_prompts_ai` trả N prompt qua format `### PROMPT i` (KHÔNG JSON — dễ vỡ parse).
3. **Bằng chứng hiển thị được**: mỗi ảnh lưu `prompt` (final) + `base` (prompt Claude riêng) → FE khối "🧠 BẰNG CHỨNG".
4. **Design phải bám ảnh gốc tuyệt đối**: không mô tả design bằng chữ (chỉ ref ảnh), `LOCKED graphic COPIED PIXEL-FAITHFUL`, đúng CỠ + VỊ TRÍ in (`PRINT SIZE & PLACEMENT`), giữ đủ **dấu tiếng Việt từng ký tự** (`_vn_name_spec` đánh vần dấu + bản IN HOA có dấu).
5. Mọi thứ **bám sát skill nano-banana-prompt** (nhúng nguyên bản trong `PRODUCT_PROMPT_SYSTEM`): 7 block, pose banks, BG bank 9-10 bối cảnh Việt, 3 mức biểu cảm, banned words, negative chuẩn, ánh sáng neutral không ám vàng, tay/miệng guard (không dấu V, không cười há miệng), aspect 4:5.
6. Ảnh đăng nền tảng phải **sạch metadata AI**: `strip_ai_meta_b64` (vẽ lại pixel → PNG chỉ IHDR/IDAT/IEND). SynthID của Gemini là watermark pixel không xoá được (user đã biết).

## Pipeline chính (tab 📘 Tạo Ảnh FB post — quan trọng nhất)

4 bộ theo skill (`FBP_SETS`): 💑 couple (6 shot: 3/4 → 2 waist-up → solo nữ → solo nam → cận design) · 🛋️ sofa (6) · ⬜ white (5) · 📦 kraft (7). Cả 4 bộ = cặp áo couple (2 ô tên nữ/nam + 🎲; **áo NAM in tên NỮ, áo NỮ in tên NAM**).

Luồng `run_fbpost_job` mỗi bộ:
1. `fbpost_prompts_ai` — Claude vision viết N prompt riêng (cùng BG + character profile, khác pose/arrangement; `_fbp_variety` random tóc/mặt/outfit/BG mỗi bộ để **các bộ không giống nhau**).
2. **Plate 2 bước**: `fbp_plate_prompt` gen BẢN DESIGN CHUẨN (2 áo trải phẳng, CHỈ đổi tên) — **luôn ép engine mạnh nhất** (`gemini_pro`/openai-high) bất kể engine cảnh; rồi `fbp_plate_check` — **Claude QC so plate với design gốc** (bố cục/font/màu/tên từng ký tự), lệch → tạo lại (2 lần), vẫn lệch → CHẶN bộ.
3. Gen từng shot: plate làm reference #1 + `_ADS_KEEP_ASIS` (copy AS-IS cấm đổi chữ); shot cận 1 áo có `_FBP_ONE_SHIRT` + FINAL REMINDER; `gen_shot_retry` (429/5xx đợi 30/60/120s, note cho user); nghỉ 3s giữa shot.
4. FE: tick chủ đề shot trước khi gen, ×1/×2/×3 bản/shot, tick chọn ảnh → thanh toàn cục "➕ Tạo 1 bài từ N ảnh tick" (gộp NHIỀU bộ thành 1 bài — KHÔNG có nút đẩy per-bộ), 🔄 tạo lại từng ảnh (giữ base + shot + plate).

`gemini_edit` gửi ảnh **CÓ NHÃN** `REFERENCE IMAGE #N` (ảnh #1 chú thích THE T-SHIRT DESIGN) TRƯỚC prompt — bắt buộc giữ.

## Tab khác

- **📋 Bài FB/IG (pgpost)**: card như bài đăng thật, toggle 📘FB/📷IG xem tỉ lệ (FB album layout, IG carousel 4:5|1:1), sắp xếp ảnh ◀▶ + kéo-thả (lưu `image_urls` qua `/api/pgpost-update`), 🤖 AI viết bài, đăng hàng loạt giãn cách. Tab "Đăng bài" cũ đã xoá.
- **🎵 TikTok Quà tặng**: skill tiktok-carousel nhúng trong `_TIKTOK_SYS` — catalog brand thật theo giới+tầng giá + nhóm QUÀ CÁ NHÂN HOÁ, 6 dạng bài, hook viral (ảnh đêm thân mật không rõ mặt + giọng "mấy món này ảnh thích mà không nói đâu 😗"); slide sạch text → FE tự chèn pill trắng chữ đen (`ttTextedDataURL`); slide 8 bonus = 2 áo gấp sofa dùng chung bộ khoá design với FB post.
- **🧪 Mix Design**: 2-3 resource + vai trò (art/typo/char/energy/layout) → `claude_vision_multi` viết 1 prompt mix chỉ rõ lấy gì từ ref #N → gen 1-4 biến thể.
- **🎁 Personalized (psn)**: 92 dạng + 3 AI bỏ phiếu — ĐÃ BÃO HOÀ, user chốt không thêm style.
- **👕 Bộ áo tệp (setshirt)**: áo bố cục → bộ couple/GĐ3/GĐ4, tên không dấu, chữ ký ghép tên ngắn.
- **📣 FB Ads / 🚀 push Ads**: đẩy ảnh/video lên FB Ads thật (PAUSED) — đã verify E2E.
- **Lịch content (autopost)**: scheduler nền tự gen + đăng — cũng BẮT BUỘC qua Claude (`autopost_gen_set`).

## Deploy & vận hành

- Deploy = bump `APP_VERSION` (dòng ~35, đặt tên `2026.07.18-<slug>`) → commit (kèm `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`) → `git push origin main` với **retry loop** (VN hay chặn GitHub: `nc -z github.com 443`, thử ~12 lần cách 30s) → poll `https://riengvnapp.cloud/api/version` tới khi thấy slug mới (~1-3 phút).
- Login local dev: `t@t.com / 123456` (local `.env` chỉ có key OpenAI — hay 429). Tài khoản test PROD: `test-claude@rieng.vn / Test123456x` (user có thể xoá).
- Log local: `/tmp/aidesign.log`. Job treo → check log sớm (đã từng dính `%`-format TypeError làm thread chết im).

## Gotchas đã trả giá (đừng lặp)

- `fetch_image_bytes` trả **raw bytes** — KHÔNG b64decode thêm (từng làm Claude không bao giờ chạy mà không ai biết).
- Chuỗi %-format: escape `%%` (từng treo job 17 phút vì "100% identical").
- FE cache: mọi thay đổi bảo user **Ctrl+Shift+R**; backend từng phải chặn key concept cũ từ FE cache (ảnh "Bạn 1/Bạn 2").
- Câu quan trọng đặt ĐẦU prompt (model bỏ qua cuối prompt 5KB); ràng buộc DƯƠNG thắng negative list (tay/miệng).
- Gemini preview có quota ngày thấp — 429 lì = hết quota thật, đợi ~14-15h giờ VN reset.
- `claude_vision` mặc định timeout 120s — task dài phải truyền `timeout=420`.

# Đưa AI Design 2D lên online (VPS + domain + HTTPS)

Mục tiêu: vào domain → trang đăng nhập → đăng ký admin → dùng tool. HTTPS tự động.

## 0) Chuẩn bị (bạn tự làm)
- 1 **VPS Ubuntu 22.04**, **≥ 2GB RAM** (vì có AI tách nền/upscale).
  Gợi ý: Hetzner (rẻ ~€4/th, 4GB) · Vultr · DigitalOcean.
- 1 **domain** (Namecheap/Porkbun/Tenten/Mắt Bão...).
- File `.env` ở máy bạn đã có sẵn `OPENAI_API_KEY` (sẽ copy lên cùng code).
  - (Tuỳ chọn) `OPENAI_TEXT_MODEL=gpt-4o-mini` — model AI "đọc ảnh + nghĩ ý tưởng" cho chế độ 🤖 Auto. Bỏ trống dùng mặc định `gpt-4o-mini` (rẻ, có vision); muốn concept "đỉnh" hơn đặt `gpt-4o`.

## 1) Trỏ domain về VPS
DNS của domain → tạo bản ghi:
```
Loại A | Host: @ | Value: <IP_VPS>
```
Đợi 5–30 phút.

## 2) Cài Docker trên VPS (SSH vào VPS rồi chạy)
```bash
ssh root@<IP_VPS>
curl -fsSL https://get.docker.com | sh
```

## 3) Đẩy code lên VPS (chạy từ máy MAC của bạn, mở Terminal mới)
```bash
rsync -avz --exclude gallery --exclude '.git' --exclude 'File áo' --exclude '.claude' \
  ~/ai-design-2d/  root@<IP_VPS>:/root/ai-design-2d/
```
(Lệnh này copy cả code, model AI, mockup, và `.env` chứa key. Chưa có rsync? `brew install rsync`.)

## 4) Sửa domain trong Caddyfile (trên VPS)
```bash
cd /root/ai-design-2d
nano Caddyfile      # đổi "yourdomain.com" thành domain thật của bạn → Ctrl+O, Enter, Ctrl+X
```

## 5) Chạy!
```bash
docker compose up -d --build
```
Lần đầu build ~5–10 phút. Xong → mở **https://domain-của-bạn**.

## 6) Tạo tài khoản admin
Mở domain → hiện **trang đăng nhập** → bấm **Đăng ký** → tài khoản ĐẦU TIÊN = admin → vào tool.

---

## Bảo mật (đã có sẵn)
- Tool **có đăng nhập riêng** → người lạ phải đăng ký mới dùng. Không cần đặt thêm mật khẩu Caddy.
- ⚠️ Mặc định **ai cũng đăng ký được**. Muốn CHỈ MÌNH BẠN dùng: sau khi đăng ký admin, nhờ tắt "đăng ký mở" (1 dòng config), hoặc bật thêm mật khẩu Caddy (khối `basicauth` trong Caddyfile).

## Lệnh hữu ích (trên VPS)
```bash
docker compose logs -f app      # xem log
docker compose restart          # khởi động lại
docker compose down             # tắt
docker compose up -d --build    # cập nhật sau khi rsync lại code mới
```

## Cập nhật tool sau này
1. Sửa code ở máy → 2. rsync lại (bước 3) → 3. `docker compose up -d --build`.

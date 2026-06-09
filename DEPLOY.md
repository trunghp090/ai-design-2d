# Đưa AI Design 2D lên online (VPS + domain + HTTPS)

Mục tiêu: vào domain là chạy tool. Dùng Docker + Caddy (tự động HTTPS).

## 0) Chuẩn bị
- 1 **VPS Ubuntu 22.04**, **≥ 2GB RAM** (vì có AI tách nền/upscale). Gợi ý: Vultr, DigitalOcean, Hetzner, hoặc VPS VN.
- 1 **domain** (Namechep, Porkbun, Tenten, Mắt Bão...).
- API key OpenAI (gpt-image-2).

## 1) Trỏ domain về VPS
Trong trang quản lý DNS của domain, tạo bản ghi:
```
Loại A   |  Host: @    |  Value: <IP_VPS>
Loại A   |  Host: www  |  Value: <IP_VPS>   (tuỳ chọn)
```
Đợi 5–30 phút cho DNS cập nhật.

## 2) Cài Docker trên VPS
SSH vào VPS rồi chạy:
```bash
curl -fsSL https://get.docker.com | sh
```

## 3) Đưa code lên VPS
Từ **máy của bạn** (Mac), chạy (thay IP):
```bash
rsync -avz --exclude gallery --exclude '.git' --exclude 'File áo' \
  ~/ai-design-2d/  root@<IP_VPS>:/root/ai-design-2d/
```
(Chưa có rsync? `brew install rsync`, hoặc dùng `scp -r`.)

## 4) Tạo .env trên VPS
SSH vào VPS:
```bash
cd /root/ai-design-2d
cat > .env <<'EOF'
OPENAI_API_KEY=sk-...của-bạn...
OPENAI_IMAGE_MODEL=gpt-image-2
PORT=8000
EOF
```

## 5) Sửa domain trong Caddyfile
```bash
nano Caddyfile     # đổi "yourdomain.com" thành domain thật
```

## 6) Chạy!
```bash
docker compose up -d --build
```
Lần đầu build ~5–10 phút (cài thư viện). Xong → mở **https://yourdomain.com** là chạy.
Caddy tự xin HTTPS.

## 7) (RẤT NÊN) Đặt mật khẩu chống đốt credit
```bash
docker compose run --rm caddy caddy hash-password --plaintext 'matkhau-cua-ban'
```
Copy chuỗi hash → mở `Caddyfile`, bỏ # ở khối `basicauth`, dán hash vào → lưu → `docker compose restart caddy`.

## Lệnh hữu ích
```bash
docker compose logs -f app      # xem log
docker compose restart          # khởi động lại
docker compose down             # tắt
docker compose up -d --build    # cập nhật sau khi sửa code (rsync lại trước)
```

## Cập nhật tool sau này
1. Sửa code ở máy bạn → 2. rsync lại (bước 3) → 3. `docker compose up -d --build`.

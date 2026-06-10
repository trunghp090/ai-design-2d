#!/usr/bin/env bash
# ============================================================
#  Cập nhật tool lên VPS chỉ với 1 lệnh:  ./deploy.sh
#  (chạy từ máy Mac, trong thư mục ~/ai-design-2d)
# ============================================================

# >>> SỬA 1 DÒNG NÀY: thay bằng IP hoặc domain VPS của bạn <<<
VPS_HOST="root@123.45.67.89"

REMOTE_DIR="/root/ai-design-2d"

echo "→ Đồng bộ code lên VPS ($VPS_HOST)..."
rsync -avz --delete \
  --exclude gallery --exclude '.git' --exclude 'File áo' \
  --exclude '.claude' --exclude 'auth.db' \
  ~/ai-design-2d/  "$VPS_HOST:$REMOTE_DIR/"

echo "→ Build & khởi động lại trên VPS..."
ssh "$VPS_HOST" "cd $REMOTE_DIR && docker compose up -d --build"

echo "✓ Xong! Tool đã cập nhật bản mới."

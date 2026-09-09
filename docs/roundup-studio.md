# Tổng hợp mẫu Rieng.vn

Marketing → Tổng hợp mẫu. Danh mục lấy trực tiếp từ rieng.vn/products.json, có phân trang và dán link sản phẩm (kể cả link có dấu).

1. Chọn 1–6 sản phẩm, chọn ảnh tham chiếu rõ graphic.
2. Đặt tiêu đề từng mẫu, tên nữ/nam và cảnh flatlay, mannequin hoặc couple. Nút xúc xắc chọn tên cho cả bộ.
3. Nhập hook, bật ảnh bìa nếu muốn. Ảnh bìa dùng mẫu đầu tiên, các slide còn lại theo thứ tự Top.
4. Bản xem bố cục dùng ảnh gốc, chưa thay tên. PNG/ZIP bản này ghi rõ bo-cuc; ZIP kèm caption và setup.
5. Tạo bộ ảnh AI: cần đăng nhập tài khoản được cấp tab roundup, ANTHROPIC_API_KEY và key của model đã chọn (OpenAI hoặc Nano Banana Pro). Claude viết prompt riêng cho mỗi ảnh; không fallback khi thiếu key. Tên mới chỉ được áp dụng trong lượt tạo AI.
6. Chữ tiêu đề được vẽ trên canvas (trắng viền đen), không nhờ AI viết. Có thể sửa hook, cỡ/vị trí chữ sau khi tạo. Thay sản phẩm/tên/cảnh yêu cầu tạo lại.

Tiến độ và prompt lưu trong data/roundups. Mỗi yêu cầu có idempotency key. Lỗi ảnh dừng bộ và giữ ảnh đã xong; không tự gửi lại lượt tạo ảnh không rõ kết quả. Sau khi máy chủ khởi động lại, bộ đang chạy được đánh dấu interrupted.

Chạy app đầy đủ: python3 server.py. Bản xem local: python3 scripts/preview_server.py 8766 (chỉ UI và API roundup, không chạy lịch đăng bài). Các route tạo/xem kết quả vẫn kiểm tra đăng nhập và quyền tab.

## Kiểm tra

- 4 unit tests: URL/input validation, thiếu key dừng trước network/chi phí, idempotency & quyền chủ bộ, kết quả từng phần khi provider lỗi.
- ZIP kiểm tra header, CRC và nội dung tiếng Việt bằng Node + Python zipfile.
- Catalog thật trả 40 sản phẩm/trang; chi tiết .js và ảnh proxy được kiểm tra thực tế.
- Chưa gọi provider tạo ảnh thật: local thiếu ANTHROPIC_API_KEY.

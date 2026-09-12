# Flatlay và Ảnh người mặc

Trong nhóm Tác vụ, hai tab độc lập `flatlay` và `wearer` có quyền truy cập riêng trong Trang admin.

Flatlay dùng ChatGPT Image (`gpt-image-2.5-sunburst`), 45 concept và 5 góc được chuyển từ thư viện preset của dự án AI influencer. Người dùng chọn 1–5 góc, 1–2 áo, concept hoặc ảnh style riêng, bao bì Rieng.vn/phụ kiện tải lên, cỡ tag, prompt và tỉ lệ. Không sao chép dữ liệu khách hàng hay concept riêng từ thư viện KOL.

Ảnh người mặc dùng Nano Banana Pro (`gemini-3-pro-image`), 4K. Bắt buộc một ảnh tham chiếu và hai áo: ảnh 1 cho nữ, ảnh 2 cho nam. Dùng hai KOL đã lưu, hoặc ảnh khuôn mặt thay riêng trong bản nháp của tab. KOL, trang phục và ảnh bối cảnh có nhãn vai trò riêng; không lấy khuôn mặt trong ảnh bối cảnh làm danh tính.

`photo_studio.py` cung cấp preview prompt không mất lượt tạo ảnh, generate có mã chống gửi trùng, history/job/result riêng theo chủ tài khoản. Job lưu trong `data/photo-studio`; ảnh và prompt/audit được giữ, lỗi trả phí không tự thử lại. Restart chuyển job đang dở thành interrupted khi đọc, giữ các ảnh đã xong. Giao diện lưu bản nháp qua IndexedDB, polling nối tiếp, thumbnail JPEG cho lưới kết quả.

Kiểm tra: Python mô phỏng cả hai provider, vai trò đầu vào, quyền truy cập, idempotency, lỗi từng phần và preview không gọi model. Kiểm tra giao diện bằng tải ảnh thật và xem prompt, không chạy sinh ảnh trả phí chỉ để kiểm thử tính năng.

Mỗi ảnh kết quả có ô Prompt tạo lại ảnh và nút Tạo lại ảnh này. Endpoint `regenerate` lấy chính ảnh kết quả đã chọn làm đầu vào, cùng yêu cầu chỉnh sửa, dùng model và tỉ lệ của tab nguồn. Không chạy lại toàn bộ bộ ảnh; bản cũ giữ nguyên, bản mới lưu quan hệ nguồn và prompt riêng. Áp dụng được cho ảnh trong lịch sử trước khi có tính năng này. Mã yêu cầu chống gửi trùng và quyền chủ tài khoản/tab được kiểm tra trước khi gọi provider.

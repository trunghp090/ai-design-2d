# Trợ lý trong tool

Marketing → Trợ lý. Nhập yêu cầu, gửi tối đa 4 ảnh, bấm Gửi yêu cầu (hoặc Cmd/Ctrl + Enter).

Hỗ trợ: soạn kịch bản Zalo và áp dụng vào Content Zalo; chọn 1–6 sản phẩm Rieng.vn, tên in và setup bài tổng hợp; mở Clone Design, Tạo design và Ảnh sản phẩm. Sau khi áp dụng, nút Mở kết quả dẫn tới tab tương ứng. Việc tạo ảnh AI vẫn dùng nút tạo của từng tab, không tự đăng bài hay gửi tin thật.

Dùng OPENAI_API_KEY và TEXT_MODEL của server, không nối vào phiên Codex hiện tại. Lịch sử chữ lưu trên trình duyệt; ảnh chỉ giữ trong lượt gửi, các ảnh đã áp dụng được lưu trong bản nháp Zalo. Có nút tải lịch sử. Cấu hình tab cũ được sao lưu trước khi agent thay setup (IndexedDB key before-assistant và localStorage rieng-roundup-before-assistant).

API chat yêu cầu đăng nhập và quyền tab assistant, cấp trong trang quản trị như tab khác. Bản preview không bỏ qua kiểm tra này. Chạy server.py để có luồng đăng nhập đầy đủ. Tài khoản kiểm thử t@t.com hiện chưa có quyền Trợ lý; không tự cấp thêm quyền.

Giới hạn: tìm trong 40 sản phẩm đầu và sản phẩm có link được nhắc trong yêu cầu; chỉ chọn handle tồn tại, chỉ dùng ảnh đính kèm có thật. Không hỗ trợ shell, đăng bài hoặc thao tác tùy ý. Model trả JSON được kiểm tra allowlist trước khi áp dụng. Lượt tạo ảnh tổng hợp vẫn cần Claude API theo pipeline hiện có.

Kiểm tra: syntax Python/JS; unit tests chặn hành động ngoài phạm vi, ảnh không tồn tại, sản phẩm bịa; cho phép kịch bản hợp lệ. Chưa gọi chat API trả phí trong kiểm thử.

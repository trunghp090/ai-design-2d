# Kết nối Douyin với AI Design 2D

Phiên bản **1.0.2** sửa lỗi báo chưa đăng nhập dù tài khoản đã đăng nhập Douyin.

Tiện ích này lấy phiên Douyin hiện tại khi bạn dán link và bấm **Lấy video / ảnh** trong công cụ. Bạn không cần mở DevTools, chép cookie hoặc bấm kết nối lại mỗi lần mở trang.

## Cài một lần trên Edge

1. Giải nén bộ tiện ích vào một thư mục cố định.
2. Mở `edge://extensions`, bật **Developer mode / Chế độ nhà phát triển**.
3. Bấm **Load unpacked / Tải tiện ích đã giải nén**, chọn thư mục chứa `manifest.json` này.
4. Đăng nhập tại [Douyin](https://www.douyin.com/) trong cùng hồ sơ Edge.
5. Tải lại [AI Design 2D](https://riengvnapp.cloud/), mở tab tải TikTok / Douyin, dán link rồi bấm **Lấy video / ảnh**. Nút **Kết nối Douyin** là bước kiểm tra phiên tùy chọn.

Chrome dùng cách tương tự tại `chrome://extensions`. Cài tiện ích trong đúng trình duyệt và hồ sơ đang đăng nhập Douyin. Cửa sổ ẩn danh không được hỗ trợ.

## Cập nhật bản đã cài lên 1.0.2

Khi các file trong thư mục tiện ích đã được cập nhật, mở `edge://extensions`, tìm thẻ **Douyin Connect**, bấm **Tải lại (↻)** rồi tải lại trang tool. Sau đó dán link và thử tải như thường lệ.

Nếu thư mục vẫn chứa bản cũ, tải ZIP 1.0.2 và giải nén thay các file trong thư mục tiện ích đã cài trước khi bấm Tải lại. Trang tool nhận phiên bản qua kiểm tra không chứa cookie và sẽ hướng dẫn cập nhật trước khi đọc phiên đăng nhập.

## Dữ liệu và phạm vi

- Chỉ đọc cookie áp dụng cho `https://www.douyin.com/`; không đọc cookie của các website khác.
- Quyền truy cập bao gồm đúng tên miền gốc `douyin.com` và `www.douyin.com` qua HTTP/HTTPS để nhận cookie đăng nhập của Douyin. Cầu nối vẫn chỉ chạy trên các địa chỉ tool bên dưới.
- Cầu nối chỉ chạy trên `https://riengvnapp.cloud`, `http://localhost:8000` và `http://127.0.0.1:8000`.
- Cookie chỉ được đọc sau một lần bấm nút thật. Mỗi lần lấy bài Douyin sẽ đọc lại phiên hiện tại.
- Không ghi Cookie / User-Agent vào file, bộ nhớ lưu trữ tiện ích, console hoặc URL. Trạng thái kết nối nằm trong bộ nhớ tab và mất khi tải lại trang.
- Phiên đọc được gửi tới công cụ trên chính trang bạn đang dùng, rồi tới Douyin khi phân tích bài đăng. Cookie không được gửi tới TikWM.
- Bấm **Xoá** hoặc **Huỷ** trong công cụ để xóa phiên khỏi tab. Lần lấy bài tiếp theo sẽ tự đọc lại phiên hiện tại sau thao tác của bạn. Đăng xuất Douyin trong trình duyệt để kết thúc phiên trên Douyin.

## Tài liệu API chính thức

- [Cookie API và quyền truy cập](https://developer.chrome.com/docs/extensions/reference/api/cookies)
- [Content script và môi trường tách biệt](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [Gửi tin nhắn giữa các thành phần tiện ích](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)
- [Các API tiện ích được Edge hỗ trợ](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support)

Khi bấm tải video, ảnh hoặc ZIP, công cụ hỏi nơi lưu trước rồi mới tải file. Hủy chọn nơi lưu sẽ không tải file.

Tiện ích không thực hiện đăng nhập hoặc vượt qua xác minh Douyin. Khi Douyin yêu cầu xác minh, mở bài trong trình duyệt và hoàn tất yêu cầu rồi thử tải lại.

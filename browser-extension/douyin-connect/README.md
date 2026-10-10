# Kết nối Douyin với AI Design 2D

Tiện ích này lấy phiên Douyin đang đăng nhập khi bạn bấm **Kết nối Douyin** trong công cụ. Bạn không cần mở DevTools hoặc sao chép Cookie / User-Agent.

## Cài một lần trên Edge

1. Giải nén bộ tiện ích vào một thư mục cố định.
2. Mở `edge://extensions`, bật **Developer mode / Chế độ nhà phát triển**.
3. Bấm **Load unpacked / Tải tiện ích đã giải nén**, chọn thư mục chứa `manifest.json` này.
4. Đăng nhập tại [Douyin](https://www.douyin.com/) trong cùng hồ sơ Edge.
5. Tải lại [AI Design 2D](https://riengvnapp.cloud/), mở tab tải TikTok / Douyin và bấm **Kết nối Douyin**.

Chrome dùng cách tương tự tại `chrome://extensions`. Cài tiện ích trong đúng trình duyệt và hồ sơ đang đăng nhập Douyin. Cửa sổ ẩn danh không được hỗ trợ.

## Dữ liệu và phạm vi

- Chỉ đọc cookie áp dụng cho `https://www.douyin.com/`; không đọc cookie của các website khác.
- Cầu nối chỉ chạy trên `https://riengvnapp.cloud`, `http://localhost:8000` và `http://127.0.0.1:8000`.
- Cookie chỉ được đọc sau một lần bấm nút thật. Mỗi lần lấy bài Douyin sẽ đọc lại phiên hiện tại.
- Không ghi Cookie / User-Agent vào file, bộ nhớ lưu trữ tiện ích, console hoặc URL. Trạng thái kết nối nằm trong bộ nhớ tab và mất khi tải lại trang.
- Phiên đọc được gửi tới công cụ trên chính trang bạn đang dùng, rồi tới Douyin khi phân tích bài đăng. Cookie không được gửi tới TikWM.
- Bấm **Xoá** hoặc **Huỷ** trong công cụ để hủy quyền kết nối của tab. Đăng xuất Douyin trong trình duyệt để kết thúc phiên trên Douyin.

## Tài liệu API chính thức

- [Cookie API và quyền truy cập](https://developer.chrome.com/docs/extensions/reference/api/cookies)
- [Content script và môi trường tách biệt](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [Gửi tin nhắn giữa các thành phần tiện ích](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)
- [Các API tiện ích được Edge hỗ trợ](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support)

Tiện ích không thực hiện đăng nhập hoặc vượt qua xác minh Douyin. Khi Douyin yêu cầu xác minh, mở bài trong trình duyệt và hoàn tất yêu cầu rồi kết nối lại.

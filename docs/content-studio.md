# Content Zalo

Mở nhóm **Marketing → Content Zalo** trong AI Design 2D.

- Thiết lập tên, avatar, khung 9:16 / 4:5 / 1:1 và cỡ chữ.
- Bấm **＋ Tin khách** hoặc **＋ Tin shop**, rồi sửa nội dung, giờ và loại tin trực tiếp trong thẻ tin nhắn ở cột trái.
- Ảnh/album nhận tối đa 4 ảnh. Ảnh tràn khung dùng một slide riêng.
- Dùng ↑ ↓ trong từng thẻ tin để đổi vị trí. Đặt tên slide và dùng ← → ở tiêu đề Slide để thay đổi thứ tự slide.
- Tạo hoặc nhân đôi slide để chia câu chuyện thành nhiều ảnh.
- Xuất PNG tải **slide hiện tại** với chiều rộng 1080 px. Nội dung vượt khung bị chặn xuất để tránh mất tin.
- Bản nháp lưu trong IndexedDB theo trình duyệt và địa chỉ truy cập. Lưu bản dự án tải JSON gồm cả ảnh; Mở dự án phục hồi JSON đó. Nên tải JSON để chuyển máy hoặc dự phòng.
- Tạo content và xuất ảnh chạy cục bộ trong trình duyệt, không gọi API tạo ảnh.
- Admin có thể cấp tab `chatcontent` trong trang phân quyền như các tab khác.

## Implementation

`public/chat-content.js` owns the editor and canvas renderer. Preview and PNG use the same canvas. `public/studio.css` applies the AI Influencer Studio palette and editor layout. Existing app routing and backend tab allowlist include `chatcontent`.

## Validation (2026-09-09)

- JavaScript syntax checks for app.js and chat-content.js; Python compile for server.py passed.
- Browser checked: tab switching, add/edit/reorder text, duplicate slide, reload restores draft, upload image, switch image to full-frame cover, PNG export of text and image slide, overflow blocks PNG export.
- Visual review of Content Zalo and Clone Design desktop layouts.
- KOL setup follow-up: direct message editing, sender/time, named slides, slide reordering, existing draft restore, image upload and PNG export verified in the browser. Preview stays alongside the editor while scrolling.
- Existing generation / publishing APIs were not invoked during UI verification.

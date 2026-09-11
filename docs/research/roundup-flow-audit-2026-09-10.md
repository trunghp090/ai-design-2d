# Rà soát luồng Tổng hợp mẫu — 10/09/2026

## Các điểm đã sửa

- Mỗi mẫu có hai ô áo nữ/áo nam; thêm ảnh thứ hai giữ ảnh thứ nhất. Ảnh upload dùng nguyên tên/design. Một ảnh dùng chung cho cả hai theo yêu cầu demo của chủ tool.
- `print_side`: front/back, mặc định front, có kiểm tra dữ liệu. Prompt và chọn góc tham chiếu đều theo mặt in. Flatlay không nhận câu hướng dẫn xoay người.
- Ảnh người chỉ gửi ảnh áo và crop KOL. Ảnh LCK có mặt người không còn gửi trực tiếp; chỉ dùng ghi chú đã xem về ánh sáng, bố cục và biểu cảm để tránh lẫn danh tính.
- KOL nữ: Gia Hân, hồ sơ 8, ảnh 162. KOL nam: Huy Hoàng, hồ sơ 12, ảnh 133. Crop cố định trong data/references/kol/cast.json. Solo nữ chỉ nhận KOL nữ.
- Adapter Gemini đặt nhãn vai trò ngay trước từng ảnh. Prompt không còn yêu cầu tự tạo nét mặt/đổi màu tóc/thêm đốm da.
- Flatlay nhận đúng file zip, tag, hộp RIENG riêng; không lặp ảnh LCK vào các vị trí này.
- Model scene_auto: người/cặp đôi/bìa → gemini_pro; flatlay/mannequin → openai_25. Giữ nguyên lựa chọn model, không fallback.
- Prompt từ bước viết nội dung được lưu làm bản nháp; prompt tạo ảnh dùng ràng buộc trực tiếp từ đầu vào để tránh prose tự suy diễn thiết kế.
- Trước lượt sinh lưu *.request.json: model, mặt in, ID KOL, thứ tự/mime/kích thước/hash ảnh và prompt. Không lưu khóa.
- Gemini không tự retry timeout/5xx vì kết quả có thể chưa rõ; một request/lượt gọi.

## Kiểm chứng

13 kiểm tra tự động đã qua về upload, nguồn bao bì, KOL, luồng prompt, và dữ liệu thư viện. Đây là kiểm chứng đầu vào, không chứng minh ảnh đầu ra giữ đúng mặt/design.

Ảnh đối chứng: 9c5e779c-b235-4e78-a5bf-e96f2bbd6036. Lượt đầu Google trả 429, không có ảnh. Một lần thử lại cũng trả 429, 0 ảnh. Chưa thể kiểm chứng chất lượng đầu ra; chưa chạy lại cả bộ.

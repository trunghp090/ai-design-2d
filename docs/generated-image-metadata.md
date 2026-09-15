# Metadata của ảnh đầu ra

Từ bản `2026.09.15-image-metadata`, ảnh mới do tool sinh ra được làm sạch metadata ngay tại ba điểm nhận kết quả: `openai_generate`, `openai_edit` và `gemini_edit`. Quy tắc áp dụng cả tạo lần đầu và tạo lại, gồm Clone, Flatlay, Ảnh người mặc, Tổng hợp mẫu, TikTok quà tặng, content, mockup và các luồng thiết kế dùng chung các hàm này.

`image_metadata.clean_image` loại EXIF, XMP, C2PA, thông tin phần mềm, các trường văn bản và chunk riêng không phục vụ hiển thị. PNG được lọc chunk, giữ nguyên dữ liệu ảnh nén, bảng màu, alpha, profile màu và DPI. JPEG/WebP được đọc theo hướng EXIF rồi xuất PNG từ điểm ảnh, không mang theo metadata nguồn. Không trả ảnh chưa làm sạch khi xử lý thất bại.

Ảnh được kiểm tra thêm khi lưu gallery và đóng ZIP. Các file ảnh cũ trong thư viện không tự bị ghi đè. Thông tin model/prompt vẫn được giữ trong dữ liệu công việc của tool để kiểm tra lỗi, không nhúng lại vào file ảnh tải về.

Đây là xử lý metadata của file, không phải xoá logo hiển thị, watermark nằm trong điểm ảnh hay bảo đảm nền tảng sẽ không nhận diện ảnh AI.

Tham chiếu định dạng: [đặc tả PNG của W3C](https://www.w3.org/TR/png-3/).

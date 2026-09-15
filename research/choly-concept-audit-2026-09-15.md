# Choly Cutie — khảo sát lại concept hình ảnh (15/09/2026)

## Phạm vi

Lướt nhiều hàng trên trang hồ sơ, danh sách DOM tải hơn 70 bài; xem các bộ đại diện bên dưới và ảnh carousel thực. Không gặp CAPTCHA. Không coi đây là thống kê toàn bộ kênh. 12 mục trong tool là nhóm hình ảnh/biến thể được tổng hợp từ các nguồn này, không phải 12 tên concept do Choly đặt.

## Bộ đã xem và quy tắc rút ra

| Bài nguồn | Quan sát trực tiếp | Áp dụng |
|---|---|---|
| https://www.tiktok.com/@choly.cutie/photo/7655916291395472660 | Người nhận gục đầu ở bàn ăn; thư viết tay; áo trên nền tối | Nhận quà xúc động, flatlay nền tối |
| https://www.tiktok.com/@choly.cutie/photo/7639607914897968405 | Hoa hồng phấn, thiệp mở; tin nhắn nền đen; cận thư bên hoa; ảnh nam/nữ ghép dọc tại cửa đá | Bó hoa, tin nhắn minh hoạ, ảnh đôi ghép dọc |
| https://www.tiktok.com/@choly.cutie/photo/7636242074098027796 | POV ngồi sau xe máy đêm; ảnh áo ghép tin nhắn; hai ảnh mặt lưng áo xếp dọc | Chuyến xe đêm; phân biệt ảnh sản phẩm với ảnh có người |
| https://www.tiktok.com/@choly.cutie/photo/7682651649675906325 | Nam cầm thiệp che miệng ở quán; thư; hộp đặt trên đùi có tay; chữ nhỏ cạnh thiệp/áo/móc khoá; nụ cười khi đọc | Đọc thiệp, mở hộp có tay, callout phân tán |
| https://www.tiktok.com/@choly.cutie/photo/7678924923460439316 | Chân dung nam ngồi quán sân vườn; áo trên bàn tròn với hộp/túi; mặc áo quay lưng; uống cà phê | Hẹn hò cà phê. Một số ảnh không chèn chữ |
| https://www.tiktok.com/@choly.cutie/photo/7677072574035102996 | Bộ tự tay chuẩn bị quà và thư đặt trên nền đen | Thư tay mở đầu; giữ mặt giấy thoáng |
| https://www.tiktok.com/@choly.cutie/photo/7670046350905494804 | Tablet đặt trên giường hiển thị ảnh hai người selfie; chữ ở khoảng trống phía trên | Kỷ niệm trên màn hình; vẫn dùng Nano vì có người trên màn hình |
| https://www.tiktok.com/@choly.cutie/photo/7660358798514720020 | Hộp áo và chocolate, nhiều chú thích nhỏ vào từng món | Hộp quà không người; không chép nhãn thương hiệu |
| https://www.tiktok.com/@choly.cutie/photo/7677826673735208212 | Selfie gương trong khung trắng; nam quay lưng cầm hoa; hook hỏi/đáp | Selfie gương và biến thể hoa; không chuyển hình in trước sang lưng |

## Quy tắc hình ảnh và chữ

- Cảnh đời thường, góc điện thoại, tương phản hơi tối, màu nền trung tính; không biến thành poster quảng cáo sạch bóng.
- Sans trắng viền đen, xuống dòng ngắn; vị trí thay đổi trên/giữa/dưới theo khoảng trống.
- Lá thư có thể không thêm caption, giữ chữ viết tay làm trọng tâm.
- Callout dùng chữ nhỏ đặt gần từng món; không ép thành một tiêu đề lớn.
- Có ảnh ghép dọc, ảnh trong màn hình và khung gương; bỏ lệnh cấm collage toàn cục, đặt layout theo cảnh.
- Nguồn ảnh chỉ dùng tham chiếu bố cục; không sao chép người, thiết kế áo, thương hiệu hay tin nhắn gốc. Hội thoại tạo mới là minh hoạ hư cấu.
- Có người, bàn tay, hoặc người trong màn hình: Nano Banana Pro. Chỉ đồ vật: GPT Image 2.5 Sunburst.

## Triển khai

`resource-seed/choly/visual-presets.json`: 12 lựa chọn có ảnh nguồn, link bài, 4 cảnh riêng, người/không người, layout và vị trí chữ theo cảnh. Đây là thư viện hình ảnh riêng bên cạnh 40 concept truyền thông.

Đã kiểm tra bằng provider giả lập: định tuyến theo từng cảnh, không fallback prompt, ảnh không chữ, 4 vị trí chữ, quyền sở hữu/lượt tạo. Chưa chạy bộ ảnh tính phí trong lượt nghiên cứu này.

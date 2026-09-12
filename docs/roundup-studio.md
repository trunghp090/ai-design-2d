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

## Style LCK tham khảo
Preset `lck-inspired`: tông kem/nâu/than ấm dịu, ảnh điện thoại tự nhiên, sofa flatlay và mannequin; bìa couple trong căn hộ kem. Nút áp dụng đặt khung 3:4, chữ 46 px ở 27% chiều cao và sao lưu setup cũ tại `rieng-roundup-before-style`. Giữ sản phẩm, tên và tiêu đề người dùng. Setup cũ không có style vẫn dùng classic. Claude nhận mô tả style riêng trong từng prompt; ảnh sản phẩm vẫn là nguồn duy nhất cho họa tiết. Không sao chép logo LCK hay giao diện TikTok.
Nguồn tham khảo: https://www.tiktok.com/@lck.hn/photo/7361827200619842832 và ảnh màn hình người dùng gửi. TikTok có xác minh nên không kiểm tra toàn bộ album.

## ChatGPT / OpenAI viết prompt
Theo yêu cầu người dùng, lượt tạo mới mặc định `prompt_provider=openai`, dùng `openai_chat` với ảnh sản phẩm và `json_mode=False`. Không cần khóa Anthropic. Job ghi provider trong spec và kết quả; job cũ vẫn giữ provider Claude. Không tự chuyển provider khi lỗi. Đã kiểm tra đường OpenAI không gọi Claude bằng mock.
API vision: https://developers.openai.com/api/docs/guides/images-vision

## Tham chiếu style và bao bì KOL
Ảnh style LCK từ ba ảnh màn hình người dùng cung cấp (couple, flatlay, mannequin), lưu trong public/roundup-references. Chỉ định rõ vai trò ảnh: sản phẩm #1, style #2, sau đó bao bì với từng số tham chiếu. Cả OpenAI viết prompt và model tạo ảnh nhận đủ các ảnh, không chỉ mô tả bằng chữ.
Đã kiểm tra catalog KOL (read-only): 20019 túi zip mờ RIENG.VN; 20020 tag cảm ơn burgundy RIENG.VN; 20758 hộp kraft trơn không logo. Chưa thấy túi giấy RIENG.VN. Bản sao các tài sản được lưu trong dự án này, không sửa thư viện KOL. Flatlay mặc định nhận đủ 3 ảnh bao bì; có checkbox tắt. Không tự dán logo lên hộp trơn; không lấy áo/kéo/bàn trong ảnh bao bì làm sản phẩm.
Bộ ảnh đã tạo trước thay đổi này không tự tạo lại hoặc được coi là có bộ bao bì mới.

## Tách style khỏi nhân vật (yêu cầu cập nhật)
LCK chỉ là tham chiếu trực tiếp cho ảnh flatlay: nước ảnh, ánh sáng, góc máy và mặt đặt áo. Ảnh couple/solo tuyệt đối không nhận ảnh người LCK; chúng chỉ nhận ảnh sản phẩm và mô tả nhân vật mới. Các mẫu dùng nhóm nhân vật hư cấu trưởng thành khác nhau, cảnh café/đi dạo/công viên. Bìa và mẫu đầu dùng cùng mô tả nhân vật (không cam kết khóa khuôn mặt bằng tham chiếu). Bộ d6f96536-f607-4806-853b-545a4ba44d3d đã được cập nhật riêng ảnh 0,1,3,5,7; giữ nguyên bốn flatlay.

## Quy trình người dùng yêu cầu ngày 2026-09-10: preview web trước, AI sau

Mỗi lần làm Tổng hợp mẫu, mở rieng.vn và chọn mẫu đúng loại áo được yêu cầu. Với áo thun, dùng sản phẩm áo thun và xác nhận tay ngắn. Nhập đầy đủ thông tin cá nhân hóa ngay trên trang sản phẩm, kiểm tra chữ cái, tên có dấu, ngày tháng và màu áo. Mở “Xem lại thiết kế” rồi chụp riêng hai preview cho cùng một mẫu design: một áo nữ, một áo nam. Không thêm sản phẩm vào giỏ hoặc đặt hàng chỉ để lấy preview.

Tải hai ảnh preview vào cùng một mẫu trong Tổng hợp mẫu, đúng thứ tự áo nữ trước, áo nam sau. Dùng ảnh đã có tên làm nguồn thiết kế; không yêu cầu model tự tạo hoặc thay tên. Giữ nguyên chữ, hình, màu, kích thước và mặt in từ preview. Kiểm tra file ảnh chụp thực tế trước khi gửi tạo ảnh (ảnh chụp cắt trực tiếp qua trình duyệt có thể trắng; dùng ảnh toàn màn hình rồi cắt vùng preview nếu cần). Kiểm tra tên trên ảnh kết quả so với preview; chưa đúng thì chưa coi là hoàn tất.

Lượt đầu lưu tại outputs/roundup-web-previews/: 4 mẫu Text Split, Anniversary, Oldschool, Shape Heart; 8 áo thun, tên minh họa Gia Hân/Huy Hoàng, ngày kỷ niệm minh họa 14/02/2024. setup.json lưu đủ ảnh nguồn.

### Quy tắc mặc áo chéo tên (người dùng chốt sau đó)
Ưu tiên cho nam mặc áo in tên nữ, nữ mặc áo in tên nam cho tất cả mẫu áo đôi. Với cặp Gia Hân/Huy Hoàng: upload ảnh 1 là áo nữ mặc, mang tên Huy Hoàng; upload ảnh 2 là áo nam mặc, mang tên Gia Hân. Riêng Text Split lượt này: cả hai áo dùng H lồng, không dùng G; H + Huy Hoàng cho nữ, H + Gia Hân cho nam. Bản setup cập nhật: outputs/roundup-web-previews/setup-partner-names.json.

## Kịch bản bài LCK (12/9/2026)
Chọn ở mục Kịch bản bài LCK: chỉ flatlay, người mặc + flatlay, chỉ người mặc, hoặc tự chỉnh. Flatlay: mỗi mẫu 1 ảnh và bìa flatlay nếu bật. Kết hợp: mỗi mẫu người mặc rồi flatlay, bìa couple nếu bật. Chỉ người mặc: mỗi mẫu couple hoặc nữ đơn, bìa couple nếu bật. Giao diện hiện số ảnh và tên cảnh cho từng slide. Setup cũ giữ chế độ tự chỉnh. Backend dùng cùng quy tắc cho kế hoạch, số lượt và kiểm tra key; bài flatlay không cần Gemini. Ảnh người dùng Nano Banana Pro 4K, ảnh sản phẩm dùng GPT Image.

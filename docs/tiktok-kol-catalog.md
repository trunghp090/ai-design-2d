# TikTok — catalog quà từ KOL

Nguồn setup: AI Influencer Studio `docs/gift-content.md`, `lib/gift-content.ts`, `lib/gift-recipient.ts`, `lib/gift-diversity.ts`, `lib/gift-catalog-mix.ts`.

Đã nhập nguyên 63 model / 56 hãng, description, sourceUrl, phân khúc và người nhận vào `public/catalog/kol-gifts.json`. File lưu hash nguồn và ngày đồng bộ. Đây là snapshot; thay đổi sau này ở KOL cần nhập lại có kiểm tra. Không phải bảng giá hiện tại.

TikTok dùng tìm kiếm, hãng, loại, phân khúc và người nhận đồng thời. Chọn 4 loại sản phẩm khác nhau, đồng hồ/smartwatch chung loại; ví/ví thẻ chung loại. Mix lấy nhóm loại trước rồi lấy sản phẩm. Reroll thay ít nhất một món nếu bộ lọc còn lựa chọn. Không tự nới bộ lọc, đổi phân khúc hay người nhận để bù số lượng.

Backend xác thực gift_ids trước khi tạo job. Claude viết riêng hook + 4 slide theo đúng key/thứ tự; nếu trả sai key dừng trước khi tạo ảnh. Không dùng tìm kiếm web hoặc bù sản phẩm bên ngoài catalog. Giữ branding của chính sản phẩm, không KOL/portrait/áo trong 5 cảnh quà; hook có đúng 4 món, mỗi slide tiếp theo chỉ một món. Luồng bonus áo hiện có vẫn riêng biệt.

Validation: 23 unit tests including catalog identity, exact selections, recipient, segment, duplicate types, outdated clients and mocked Claude plan/no web. Browser tested mix, reroll and narrow-filter rejection. No paid image generation during setup.

## Story correction (2026-09-10)

The original TikTok story skill takes priority over the KOL hook described above: slide 1 is an anonymous adult couple story hook, NOT a four-product lineup. Slides 2-5 introduce the selected gifts. KOL supplies product identities only. See prompts/tiktok-story.txt and the archived original skill. Upgrade requires both rejection and upgrade lines; compare requires A vs B of the same type; countdown requires Top 4 to Top 1; category requires one catalog category with four distinct product types. Select the concept before selecting gifts. Tests: 36 passed plus browser checks; no paid image generation.

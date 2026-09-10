"""Validate gift variety before spending image-generation credits."""
import re
import unicodedata
from collections import Counter
from urllib.parse import urlparse

CATEGORIES = {'tech', 'fashion', 'beauty', 'accessories', 'home', 'personalized', 'experience', 'books_flowers'}

def normalized(value):
    value = unicodedata.normalize('NFKD', str(value)).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'[^a-z0-9]+', ' ', value).strip()

def validate_variety(slides, concept):
    brands, categories, families, urls, shops = [], [], [], [], []
    for slide in slides:
        description = normalized(' '.join(str(slide.get(k, '')) for k in ('product', 'brand', 'family', 'category')))
        if re.search(r'\b(banh|keo|mut|snack|chocolate|choco\s?pie|custas|orion|cookies?|biscuits?|candy|hamper|thuc pham|trai cay|hoa qua)\b', description):
            raise ValueError('Bài đang chứa bánh kẹo/giỏ quà thực phẩm. Cần tìm lại quà đồ dùng đúng chủ đề.')
        brand = normalized(slide.get('brand', ''))
        family = normalized(slide.get('family', ''))
        category = slide.get('category')
        if not brand or not family or category not in CATEGORIES:
            raise ValueError('Thiếu hãng, dòng sản phẩm hoặc nhóm quà để kiểm tra độ đa dạng.')
        url = urlparse(slide.get('source_url', ''))
        brands.append(brand); families.append((brand, family)); categories.append(category)
        urls.append((url.netloc.lower(), url.path.rstrip('/')))
        shops.append(url.netloc.lower().removeprefix('www.'))
    if len(set(families)) != len(families) or len(set(urls)) != len(urls):
        raise ValueError('Bài lặp cùng dòng sản phẩm hoặc chỉ đổi màu/size/set. Cần chọn món khác.')
    if len(set(brands)) < min(3, len(slides)) or max(Counter(brands).values(), default=0) > 2:
        raise ValueError('Bài cần ít nhất 3 hãng và tối đa 2 món mỗi hãng.')
    if max(Counter(shops).values(), default=0) > 2:
        raise ValueError('Bài đang lấy quá nhiều món từ cùng một website. Cần bổ sung nguồn khác.')
    if concept != 'category' and len(set(categories)) < min(3, len(slides)):
        raise ValueError('Bài cần ít nhất 3 nhóm quà khác nhau, không chỉ đổi mẫu trong cùng nhóm.')

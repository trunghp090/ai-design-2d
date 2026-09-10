"""Curated catalog: original KOL products plus reviewed official and custom gifts."""
import json
from pathlib import Path
CATALOG = json.loads((Path(__file__).parent/'public/catalog/kol-gifts.json').read_text())['gifts']
BY_KEY = {g['key']: g for g in CATALOG}
SEGMENTS = {'kol_all':'all','kol_mid':'mid','kol_premium':'premium','kol_luxury':'luxury'}

def selection(keys, gender, tier):
    if tier not in SEGMENTS:
        raise ValueError('Setup đã chuyển sang catalog KOL. Tải lại trang và chọn lại 4 món.')
    if not isinstance(keys,list) or len(keys)!=4 or any(not isinstance(k,str) for k in keys) or len(set(keys))!=4:
        raise ValueError('Chọn đúng 4 món khác loại từ catalog KOL trước khi tạo bài.')
    gifts=[]
    for key in keys:
        gift=BY_KEY.get(key)
        if not gift:raise ValueError('Sản phẩm không thuộc catalog KOL.')
        if SEGMENTS[tier]!='all' and gift['segment']!=SEGMENTS[tier]:raise ValueError('Món đã chọn không đúng phân khúc KOL.')
        recipient={'nam':'boyfriend','nu':'girlfriend','cả hai':'all'}.get(gender)
        if recipient is None:raise ValueError('Người nhận không hợp lệ.')
        if recipient!='all' and gift['recipient'] not in (recipient,'unisex'):raise ValueError('Món đã chọn không phù hợp bộ lọc người nhận.')
        gifts.append(dict(gift))
    if len({g['productType'] for g in gifts})!=4:raise ValueError('Cần 4 loại khác nhau: đồng hồ/smartwatch cùng một loại, ví/ví thẻ cùng một loại.')
    return gifts

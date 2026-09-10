"""Story rules restored from the original embedded TikTok skill, with KOL product identities."""

from pathlib import Path
SYSTEM = (Path(__file__).parent / "prompts/tiktok-story.txt").read_text()

def validate_setup(gifts, concept):
    if concept == "category" and len({g["category"] for g in gifts}) != 1:
        raise ValueError("Dạng Theo danh mục cần 4 món cùng danh mục. Chọn danh mục và mix lại.")


def validate_plan(plan, gifts, requested):
    actual = plan.get("concept")
    if actual not in ("countdown", "upgrade", "category", "mood", "compare") or (requested != "auto" and actual != requested):
        raise ValueError("Claude chưa làm đúng dạng bài đã chọn.")
    validate_setup(gifts, actual)
    hook = plan.get("hook") or {}
    if hook.get("scene_kind") != "couple":
        raise ValueError("Slide đầu phải là hook couple riêng, không phải bộ ảnh quà.")
    def lines(item):
        value=item.get("overlay")
        if not isinstance(value,list) or not 2 <= len(value) <= 3 or any(not isinstance(x,str) or not x.strip() for x in value):
            raise ValueError("Mỗi slide cần 2–3 dòng overlay theo skill.")
        return value
    lines(hook)
    for index,(slide,gift) in enumerate(zip(plan["slides"],gifts)):
        overlay=lines(slide)
        if gift["label"].casefold() not in " ".join(overlay).casefold():
            raise ValueError("Overlay thiếu tên hãng/model đã chọn.")
        if actual == "upgrade" and (not overlay[0].startswith("❌") or not overlay[1].startswith("✅") or gift["label"].casefold() not in overlay[1].casefold()):
            raise ValueError("Dạng Nâng cấp cần dòng ❌ món thường rồi dòng ✅ model KOL.")
        if actual == "compare" and " vs " not in overlay[0].casefold():
            raise ValueError("Dạng So sánh cần hai lựa chọn cùng loại theo cấu trúc A vs B.")
        if actual == "countdown" and not overlay[0].startswith("Top %d:" % (4-index)):
            raise ValueError("Dạng Đếm ngược cần đúng thứ tự Top 4 đến Top 1.")
    return actual

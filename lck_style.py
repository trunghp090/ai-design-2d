"""Reviewed per-slide observations; no remote fetches during generation."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LIBRARY = ROOT / 'data/references/lck-style-library.json'
ASSETS = ROOT / 'data/references/lck'
if not LIBRARY.is_file():
    LIBRARY = ROOT / 'resource-seed/references/lck-style-library.json'
    ASSETS = ROOT / 'resource-seed/references/lck'

def load():
    try:
        data = json.loads(LIBRARY.read_text())
        return data if isinstance(data.get('posts'), list) else {'posts': []}
    except (OSError, ValueError):
        return {'posts': [], 'coverage': {'complete_channel': False}}

def asset(slide):
    relative = Path(slide.get('asset', ''))
    if ASSETS == ROOT / 'resource-seed/references/lck':
        try:
            relative = Path('resource-seed/references/lck') / relative.relative_to('data/references/lck')
        except ValueError:
            return None
    path = (ROOT / relative).resolve()
    return path if path.is_relative_to(ASSETS.resolve()) and path.is_file() else None

def choose(scene, row, ordinal=0, exclude=None, strict_side=False):
    # Keep graphic outros, collages and operational scenes out of photo generation.
    wanted = scene
    candidates = []
    for post in load()['posts']:
        for slide in post.get('slides', []):
            if slide.get('reviewed') is not True or slide.get('scene') != wanted or slide.get('generation_eligible') is False:
                continue
            if (post['id'],slide['index']) in (exclude or set()):continue
            if strict_side and slide.get('design_side') != row.get('print_side','front'):continue
            if asset(slide):
                candidates.append(dict(slide, post_id=post['id'], source_url=post['url']))
    if not candidates:
        return choose('couple',row,ordinal,exclude=exclude,strict_side=strict_side) if scene=='solo' else None
    side=row.get('print_side','front')
    matching=[s for s in candidates if s.get('design_side')==side]
    if matching:candidates=matching
    seed = int(hashlib.sha256(str(row.get('handle', '')).encode()).hexdigest()[:8], 16)
    return candidates[(seed + ordinal) % len(candidates)]

def direction(slide, scene):
    if not slide:
        return ''
    return ('REVIEWED PHOTO DIRECTION: ' + slide['prompt_direction'] +
            ' The study photo shows ' + slide.get('design_side', 'unknown') + ' garment views; this is not evidence of the product design side. '
            'Orient the NEW shot to show only the exact supplied garment side. '
            + ('Adapt body turns as needed. Source expressions guide a moment, not facial identity. Use new fictional adults. ' if scene in ('couple','solo') else 'Only unworn garments and requested packaging, no people or body parts. ')
            + ('Adapt the body language to one adult woman only, no second person. ' if scene == 'solo' else '') +
            'Do not reproduce source text, garment artwork, watermarks, brands, seasonal decorations or extra props. '
            'Selected RIENG packaging and exact uploaded product designs override all study-photo objects.')

def public_data():
    data = load()
    for post in data['posts']:
        for slide in post.get('slides', []):
            slide['image'] = '/api/roundup/style-image?post=' + post['id'] + '&index=' + str(slide['index'])
            slide.pop('asset', None)
    return data

"""Pinned local KOL identity references for roundup people shots."""
import json
from pathlib import Path
BASE=Path(__file__).resolve().parent
def cast_root(base):
    local=base/'data/references/kol'
    bundled=base/'resource-seed/references/kol'
    def revision(folder):
        try:
            data=json.loads((folder/'cast.json').read_text())
            return data.get('revision','')
        except (OSError,ValueError):return ''
    # A newly published fixed cast supersedes older persistent-volume portraits.
    if not (local/'cast.json').is_file() or revision(bundled)>revision(local):
        return bundled
    return local
ROOT=cast_root(BASE)
def people(scene):
    if scene not in ('couple','solo'):return []
    data=json.loads((ROOT/'cast.json').read_text())['people']
    roles=['female'] if scene=='solo' else ['female','male']
    selected=[]
    for role in roles:
        person=next(p for p in data if p['role']==role)
        file=(ROOT/person['asset']).resolve()
        if file.parent!=ROOT.resolve() or not file.is_file():raise ValueError('Thiếu ảnh KOL '+role)
        selected.append(dict(person,file=file))
    return selected

def attach(refs,scene):
    selected=people(scene);rules=[];audit=[]
    for p in selected:
        refs.append((p['file'].read_bytes(),p.get('mime','image/png')))
        rules.append(f"[REFERENCE_ROLE {len(refs)}: IDENTITY {p['role'].upper()}] Reference #{len(refs)} is IDENTITY ONLY for the {p['role']} wearer ({p['name']}). Preserve this person's facial structure, eyes, nose, mouth, hairline and hair color across every slide. Borrow neither clothing nor pose from this identity crop. Never blend this face with the LCK style-photo face or the printed artwork faces.")
        audit.append({k:p.get(k) for k in ('role','name','kol_id','image_id','crop','sha256','reference_origin','generation_model')})
    return ' '.join(rules),audit

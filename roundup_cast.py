"""Pinned local KOL identity references for roundup people shots."""
import json
import base64
import hashlib
import io
import re
import threading
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
CUSTOM_LOCK=threading.RLock()

def custom_root():
    return BASE/'data/references/kol-custom'

def custom_data():
    path=custom_root()/'cast.json'
    return json.loads(path.read_text()) if path.exists() else {}

def update(role,value=None,reset=False):
    """Keep user portraits separate from release-managed defaults."""
    if role not in ('male','female'):raise ValueError('KOL không hợp lệ.')
    with CUSTOM_LOCK:
        folder=custom_root();folder.mkdir(parents=True,exist_ok=True)
        data=custom_data()
        if reset:data.pop(role,None)
        else:
            from PIL import Image,ImageOps
            if not isinstance(value,str) or len(value)>35000000:raise ValueError('Ảnh tối đa 25 MB.')
            match=re.fullmatch(r'data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)',value)
            if not match:raise ValueError('Chọn ảnh PNG, JPG hoặc WebP.')
            try:
                raw=base64.b64decode(match[2],validate=True)
                with Image.open(io.BytesIO(raw)) as source:
                    if source.width*source.height>40000000:raise ValueError('Ảnh tối đa 40 megapixel.')
                    im=ImageOps.exif_transpose(source).convert('RGB')
                    im.thumbnail((4800,4800))
                    out=io.BytesIO();im.save(out,'JPEG',quality=95)
                    raw=out.getvalue();sha=hashlib.sha256(raw).hexdigest()
                    asset=role+'-'+sha+'.jpg'
                    (folder/asset).write_bytes(raw)
                    width,height=im.size
                    im.thumbnail((360,480));im.save(folder/('preview-'+asset),'JPEG',quality=85)
            except Exception as e:raise ValueError('Không đọc được ảnh. Chọn ảnh hợp lệ, tối đa 40 megapixel.') from e
            data[role]={'asset':asset,'preview_asset':'preview-'+asset,'mime':'image/jpeg','sha256':sha,'width':width,'height':height,'crop':[0,0,width,height],'reference_origin':'user_upload','generation_model':None,'kol_id':None,'image_id':None,'source':'user-uploaded portrait'}
        temporary=folder/'cast.json.tmp'
        temporary.write_text(json.dumps(data,ensure_ascii=False),encoding='utf-8')
        temporary.replace(folder/'cast.json')
    return {'ok':True,'role':role,'custom':role in data}

def people(scene):
    if scene not in ('couple','solo'):return []
    data=json.loads((ROOT/'cast.json').read_text())['people']
    roles=['female'] if scene=='solo' else ['female','male']
    selected=[]
    for role in roles:
        person=dict(next(p for p in data if p['role']==role))
        with CUSTOM_LOCK:override=custom_data().get(role)
        folder=ROOT
        if override:
            person.update(override);folder=custom_root()
        file=(folder/person['asset']).resolve()
        if file.parent!=folder.resolve() or not file.is_file():raise ValueError('Thiếu ảnh KOL '+role)
        selected.append(dict(person,file=file))
    return selected

def attach(refs,scene):
    selected=people(scene);rules=[];audit=[]
    for p in selected:
        refs.append((p['file'].read_bytes(),p.get('mime','image/png')))
        rules.append(f"[REFERENCE_ROLE {len(refs)}: IDENTITY {p['role'].upper()}] Reference #{len(refs)} is IDENTITY ONLY for the {p['role']} wearer ({p['name']}). Preserve this person's facial structure, eyes, nose, mouth, hairline and hair color across every slide. Borrow neither clothing nor pose from this identity crop. Never blend this face with the LCK style-photo face or the printed artwork faces.")
        audit.append({k:p.get(k) for k in ('role','name','kol_id','image_id','crop','sha256','reference_origin','generation_model')})
    return ' '.join(rules),audit

"""Flatlay and wearer studios with owner-scoped durable image jobs."""
import base64
import hashlib
import io
import json
import re
import threading
import time
import urllib.parse
from pathlib import Path
import roundup
import roundup_cast

ROOT=Path(__file__).resolve().parent
LOCK=threading.RLock()
LIVE=set()
CATALOG=json.loads((ROOT/'resource-seed/photo-studio/catalog.json').read_text())
ACCESSORIES={'zip':('rieng-zip.png','RIENG.VN frosted zip pouch'),'tag':('rieng-tag.png','RIENG.VN thank-you tag'),'box':('kraft-box.png','plain kraft box')}

def folder(app):
    p=Path(app.DATA_DIR)/'photo-studio';p.mkdir(parents=True,exist_ok=True);return p

def write(path,data):
    tmp=path.with_suffix('.tmp');tmp.write_text(json.dumps(data,ensure_ascii=False));tmp.replace(path)

def validate(body):
    if not isinstance(body,dict):raise roundup.Problem('Dữ liệu không hợp lệ.')
    mode=body.get('mode')
    if mode not in ('flatlay','wearer'):raise roundup.Problem('Tab không hợp lệ.')
    if not re.fullmatch(r'[a-f0-9-]{36}',str(body.get('request_id',''))):raise roundup.Problem('Thiếu mã yêu cầu.')
    aspect=body.get('aspect','3:4')
    if aspect not in ('1:1','3:4','4:5','9:16'):raise roundup.Problem('Tỉ lệ không hợp lệ.')
    prompt=body.get('prompt','')
    if not isinstance(prompt,str) or len(prompt)>4000:raise roundup.Problem('Prompt tối đa 4000 ký tự.')
    files=body.get('files',{})
    if not isinstance(files,dict) or set(files)-{'shirt1','shirt2','reference','male','female','accessory'}:raise roundup.Problem('Ảnh đầu vào không hợp lệ.')
    if sum(len(v) if isinstance(v,str) else 99999999 for v in files.values())>14000000:raise roundup.Problem('Bộ ảnh tải lên quá lớn.')
    for value in files.values():roundup.uploaded_image(value)
    if not files.get('shirt1'):raise roundup.Problem('Tải ảnh Áo 1 trước.')
    if mode=='wearer' and not files.get('shirt2'):raise roundup.Problem('Tải đủ áo nữ và áo nam.')
    if mode=='wearer' and not files.get('reference'):raise roundup.Problem('Tải ảnh tham chiếu bối cảnh / dáng chụp.')
    concept=body.get('concept',CATALOG['concepts'][0]['id'])
    if concept not in {c['id'] for c in CATALOG['concepts']}:raise roundup.Problem('Concept không hợp lệ.')
    shots=body.get('shots',['hero']) if mode=='flatlay' else ['wearer']
    allowed={s['id'] for s in CATALOG['shots']} if mode=='flatlay' else {'wearer'}
    if not isinstance(shots,list) or not 1<=len(shots)<=5 or any(s not in allowed for s in shots) or len(set(shots))!=len(shots):raise roundup.Problem('Chọn từ 1 đến 5 góc chụp khác nhau.')
    accessories=body.get('accessories',[]) if mode=='flatlay' else []
    if not isinstance(accessories,list) or any(s not in ACCESSORIES for s in accessories) or len(accessories)>3:raise roundup.Problem('Bao bì không hợp lệ.')
    tag=body.get('tag_size','small')
    if tag not in ('small','medium','large'):raise roundup.Problem('Cỡ tag không hợp lệ.')
    return {'mode':mode,'aspect':aspect,'prompt':prompt.strip(),'files':files,'concept':concept,'shots':shots,'accessories':accessories,'tag_size':tag}

def inputs(spec,shot):
    refs=[];rules=[]
    def add(raw,mime,role):
        refs.append((raw,mime));rules.append(f'[REFERENCE_ROLE {len(refs)}: {role}]')
    for key,role in [('shirt1','PRODUCT FEMALE: garment worn by woman' if spec['mode']=='wearer' else 'PRODUCT 1'),('shirt2','PRODUCT MALE: garment worn by man' if spec['mode']=='wearer' else 'PRODUCT 2')]:
        if key in spec['files']:add(*roundup.uploaded_image(spec['files'][key]),role)
    if spec['mode']=='wearer':
        for person in roundup_cast.people('couple'):
            role=person['role']
            raw,mime=roundup.uploaded_image(spec['files'][role]) if role in spec['files'] else (person['file'].read_bytes(),person.get('mime','image/jpeg'))
            add(raw,mime,'IDENTITY '+role.upper()+': exact face and hair only; never clothing')
    if 'reference' in spec['files']:
        add(*roundup.uploaded_image(spec['files']['reference']),'SCENE ONLY: camera, pose, background, lighting; never faces or artwork')
    elif spec['mode']=='flatlay':
        suffix='' if shot=='hero' else '-'+shot
        path=ROOT/'public/flatlay-concepts'/(spec['concept']+suffix+'.webp')
        if path.exists():add(path.read_bytes(),'image/webp','SCENE ONLY: match layout and lighting, replace garments and branding')
    for key in spec['accessories']:
        asset,label=ACCESSORIES[key];add((ROOT/'public/roundup-references'/asset).read_bytes(),'image/png','PACKAGING: '+label)
    if 'accessory' in spec['files'] and spec['mode']=='flatlay':add(*roundup.uploaded_image(spec['files']['accessory']),'PACKAGING: exact additional supplied accessory')
    lock='Keep the exact garment type, sleeve length, color, all original artwork, letters, printed names, print size and print placement from the PRODUCT references. Never invent or change names. Exclude any headline or UI outside the actual garment in source images. No watermark, collage or panel layout. '
    if spec['mode']=='wearer':
        direction='Create ONE photorealistic photo of exactly the supplied man and woman. Woman wears PRODUCT FEMALE (shirt 1), man wears PRODUCT MALE (shirt 2). Do not swap shirts. Preserve the supplied identity facial proportions, eye shape, hairstyle and natural skin. Follow the SCENE reference only for pose, camera and setting; replace its people with the supplied KOL identities. Both faces clearly resolved, sharp eyes, fine hair and natural skin, no beauty smoothing or plastic skin. Keep both printed designs visible and unobstructed. '
    else:
        concept=next(c for c in CATALOG['concepts'] if c['id']==spec['concept'])
        variation=next(s for s in CATALOG['shots'] if s['id']==shot)
        direction='PRODUCT ONLY flatlay, no people, faces, hands, bodies, worn garments or mannequins. Show exactly '+('two garments, one of each supplied product. ' if 'shirt2' in spec['files'] else 'one supplied garment. ')
        direction+=variation['prompt']+' '+('Follow uploaded SCENE reference for surroundings and lighting. ' if 'reference' in spec['files'] else concept['prompt'])
        direction+=' Use only selected packaging references for visible branding; any other props must be plain and unbranded. Never copy packaging branding from scene. Keep package proportions realistic and shirt graphics clear. Tag scale: '+{'small':'small, around 5 percent of garment width','medium':'around 8 percent of garment width','large':'around 12 percent of garment width'}[spec['tag_size']]+'. '
    return refs,direction+lock+'\nUSER DIRECTION: '+spec['prompt']+'\nREFERENCE ROLES: '+' '.join(rules)+'\nOutput aspect '+spec['aspect']+'.'

def public(job):return {k:v for k,v in job.items() if k not in ('owner','digest','inputs')}

def read(app,jid,owner):
    if not re.fullmatch(r'[a-f0-9-]{36}',str(jid)):raise roundup.Problem('Mã ảnh không hợp lệ.')
    with LOCK:
        path=folder(app)/(jid+'.json')
        if not path.exists():raise roundup.Problem('Không tìm thấy lượt tạo.',404)
        j=json.loads(path.read_text())
        if j['owner']!=owner:raise roundup.Problem('Không có quyền xem ảnh.',403)
        if j['status']=='running' and jid not in LIVE:
            j.update(status='interrupted',error='Máy chủ khởi động lại. Ảnh đã xong được giữ; không tự tạo lại lượt chưa rõ kết quả.');write(path,j)
        return j

def start(app,body,owner):
    spec=validate(body);jid=body['request_id'];digest=hashlib.sha256(json.dumps(spec,sort_keys=True).encode()).hexdigest()
    with LOCK:
        if (folder(app)/(jid+'.json')).exists():
            old=read(app,jid,owner)
            if old['digest']!=digest:raise roundup.Problem('Mã yêu cầu đã dùng cho nội dung khác.',409)
            return public(old)
        if not (app.GEMINI_API_KEY if spec['mode']=='wearer' else app.API_KEY):raise roundup.Problem('Chưa cấu hình API cho model của tab này.',503)
        snapshot=[]
        for shot in spec['shots']:
            refs,prompt=inputs(spec,shot)
            snapshot.append((shot,refs,prompt))
        j={'id':jid,'owner':owner,'digest':digest,'mode':spec['mode'],'model':roundup.PEOPLE_MODEL if spec['mode']=='wearer' else 'gpt-image-2.5-sunburst','aspect':spec['aspect'],'status':'running','created':time.time(),'items':[],'total':len(snapshot),'error':'','note':'Đang chuẩn bị ảnh…'}
        write(folder(app)/(jid+'.json'),j);LIVE.add(jid)
        threading.Thread(target=run,args=(app,j,snapshot),daemon=True).start()
        return public(j)

def run(app,j,snapshot):
    try:
        for shot,refs,prompt in snapshot:
            with LOCK:j['note']=f"Đang tạo ảnh {len(j['items'])+1}/{j['total']}";write(folder(app)/(j['id']+'.json'),j)
            index=len(j['items'])
            audit={'model':j['model'],'prompt':prompt,'references':[{'index':i+1,'sha256':hashlib.sha256(raw).hexdigest(),'mime':mime} for i,(raw,mime) in enumerate(refs)]}
            write(folder(app)/(j['id']+'-'+str(index)+'.audit.json'),audit)
            if j['mode']=='wearer':b64=app.gemini_edit(refs,prompt,j['aspect'],roundup.PEOPLE_MODEL,image_size='4K')
            else:b64=app.gen_shot(refs,prompt,{'1:1':'1024x1024','3:4':'1152x1536','4:5':'1024x1280','9:16':'1024x1536'}[j['aspect']],'openai_25',j['aspect'],lock=False,quality='high')
            from PIL import Image
            raw=base64.b64decode(b64)
            with Image.open(io.BytesIO(raw)) as im:
                im.load();width,height=im.size;ext='jpg' if im.format=='JPEG' else 'png'
            filename=j['id']+'-'+str(index)+'.'+ext;(folder(app)/filename).write_bytes(raw)
            with LOCK:
                j['items'].append({'index':index,'shot':shot,'filename':filename,'width':width,'height':height,'prompt':prompt,'model':j['model'],'image':'/api/photo-studio/result?id='+j['id']+'&index='+str(index)});write(folder(app)/(j['id']+'.json'),j)
        with LOCK:j.update(status='done',note='Đã tạo đủ ảnh.');write(folder(app)/(j['id']+'.json'),j)
    except Exception as e:
        with LOCK:j.update(status='failed',error=str(e)[:600]);write(folder(app)/(j['id']+'.json'),j)
    finally:
        with LOCK:LIVE.discard(j['id'])

def route(app,h,path,body=None):
    if not path.startswith('/api/photo-studio/'):return False
    try:
        user=h.current_user()
        if app.AUTH_REQUIRED and not user:raise roundup.Problem('Vui lòng đăng nhập.',401)
        owner=str((user or {}).get('id') or (user or {}).get('email') or 'local')
        q=urllib.parse.parse_qs(urllib.parse.urlparse(h.path).query);get=lambda k,d='':q.get(k,[d])[0]
        action=path.rsplit('/',1)[-1]
        job=read(app,get('id'),owner) if action in ('job','result') else None
        mode=job['mode'] if job else (body or {}).get('mode',get('mode'))
        if mode not in ('flatlay','wearer'):raise roundup.Problem('Tab không hợp lệ.')
        if app.AUTH_REQUIRED and not app.user_has_tab(user,mode):raise roundup.Problem('Tài khoản chưa được cấp tab này.',403)
        if body is not None and action=='generate':result=start(app,body,owner)
        elif body is not None and action=='preview':
            spec=validate(body);result={'prompts':[{'shot':s,'prompt':inputs(spec,s)[1]} for s in spec['shots']]}
        elif body is None and action=='catalog':result=CATALOG
        elif body is None and action=='kol':
            person=next((p for p in roundup_cast.people('couple') if p['role']==get('role')),None)
            if not person:raise roundup.Problem('Không tìm thấy KOL.')
            path=person['file'].parent/person.get('preview_asset','')
            roundup.send_bytes(h,path.read_bytes() if path.is_file() else person['file'].read_bytes(),'image/jpeg');return True
        elif body is None and action=='job':result=public(job)
        elif body is None and action=='result':
            item=next((i for i in job['items'] if str(i['index'])==get('index')),None)
            if not item:raise roundup.Problem('Ảnh chưa hoàn thành.',404)
            file=folder(app)/item['filename']
            if get('preview')=='1':
                from PIL import Image
                thumb=file.with_name(file.stem+'-thumb.jpg')
                if not thumb.exists():
                    with Image.open(file) as im:
                        im=im.convert('RGB');im.thumbnail((480,640));buf=io.BytesIO();im.save(buf,'JPEG',quality=82)
                    thumb.write_bytes(buf.getvalue())
                roundup.send_bytes(h,thumb.read_bytes(),'image/jpeg')
            else:roundup.send_bytes(h,file.read_bytes(),'image/jpeg' if file.suffix=='.jpg' else 'image/png')
            return True
        elif body is None and action=='history':
            jobs=[]
            for path in folder(app).glob('*.json'):
                if path.name.endswith('.audit.json'):continue
                j=json.loads(path.read_text())
                if j.get('owner')==owner and j.get('mode')==mode:jobs.append(public(j))
            result={'jobs':sorted(jobs,key=lambda j:j['created'],reverse=True)[:30]}
        else:raise roundup.Problem('Không tìm thấy chức năng.',404)
        h.json(200,result)
    except roundup.Problem as e:h.json(e.status,{'error':str(e)})
    except Exception as e:h.json(502,{'error':str(e)[:500]})
    return True

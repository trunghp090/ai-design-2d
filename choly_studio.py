"""Choly-inspired carousel: Claude prompts, explicit image providers, rendered captions."""
import base64, hashlib, io, json, re, threading, time, urllib.parse
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageOps
import roundup
ROOT=Path(__file__).resolve().parent
LOCK=threading.RLock()
LIVE=set()
CONCEPTS=json.loads((ROOT/'resource-seed/choly/concepts.json').read_text())
SCENES=[('reaction','Người nhận quà','Candid adult Vietnamese man at a restaurant table, overcome with emotion, head resting on forearm beside a red gift box. Natural neutral dim phone photography.'),('letter','Lá thư','No people, hands or body parts. A handwritten Vietnamese love letter placed diagonally on a dark table; intimate imperfect phone photograph. Write a short original affectionate message without names.'),('box','Mở hộp quà','No people, hands or body parts. Supplied shirts folded in an open plain red gift box, with a small red card on a grey stone floor. Candid phone photograph.'),('shirts','Flatlay áo đôi','No people, hands or body parts. Supplied garments loosely arranged on dark neutral fabric, red card and a small plain teddy bear accessory. Imperfect intimate overhead phone photo.')]
def folder(app):
    p=Path(app.DATA_DIR)/'choly-studio';p.mkdir(parents=True,exist_ok=True);return p
def write(path,data):
    tmp=path.with_suffix('.tmp');tmp.write_text(json.dumps(data,ensure_ascii=False));tmp.replace(path)
def validate(body):
    if not isinstance(body,dict) or not re.fullmatch(r'[a-f0-9-]{36}',str(body.get('request_id',''))):raise roundup.Problem('Thiếu mã yêu cầu hợp lệ.')
    concept=next((c for c in CONCEPTS if c['id']==body.get('concept')),None)
    if not concept:raise roundup.Problem('Chọn concept truyền thông.')
    topic=body.get('topic','')
    if not isinstance(topic,str) or len(topic)>2000:raise roundup.Problem('Chủ đề tối đa 2000 ký tự.')
    captions=body.get('captions')
    if not isinstance(captions,list) or len(captions)!=4 or any(not isinstance(t,str) or not t.strip() or len(t)>220 for t in captions):raise roundup.Problem('Nhập đủ 4 câu chữ, tối đa 220 ký tự mỗi ảnh.')
    files=body.get('files',{})
    if not isinstance(files,dict) or set(files)-{'shirt1','shirt2'} or not files.get('shirt1'):raise roundup.Problem('Tải ảnh áo trước.')
    if sum(len(v) if isinstance(v,str) else 99999999 for v in files.values())>10000000:raise roundup.Problem('Ảnh tải lên quá lớn.')
    for v in files.values():roundup.uploaded_image(v)
    return dict(concept=concept,topic=topic,files=files,captions=captions)
def caption_image(raw,text):
    im=ImageOps.fit(Image.open(io.BytesIO(raw)).convert('RGB'),(1152,1536))
    draw=ImageDraw.Draw(im)
    for size in range(52,23,-2):
        font=ImageFont.truetype(str(ROOT/'fonts/BeVietnamProBold.ttf'),size)
        lines=[];line=''
        for word in text.split():
            candidate=(line+' '+word).strip()
            if draw.textlength(candidate,font=font)>980 and line:lines.append(line);line=word
            else:line=candidate
        if line:lines.append(line)
        if len(lines)<=4:break
    y=195
    for line in lines:
        draw.text((576,y),line,font=font,fill='white',stroke_width=3,stroke_fill='black',anchor='mt');y+=size*1.4
    buf=io.BytesIO();im.save(buf,'PNG');return buf.getvalue()
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
        if not all((app.API_KEY,app.GEMINI_API_KEY,app.ANTHROPIC_API_KEY)):raise roundup.Problem('Cần cấu hình Claude, Nano Banana Pro và GPT Image trong máy chủ.',503)
        j=dict(id=jid,owner=owner,digest=digest,status='running',created=time.time(),items=[],total=4,error='',note='Claude đang viết kịch bản từng ảnh…',concept=spec['concept']['name'],topic=spec['topic'])
        write(folder(app)/(jid+'.json'),j);LIVE.add(jid)
        threading.Thread(target=run,args=(app,j,spec),daemon=True).start()
        return public(j)
def run(app,j,spec):
    try:
        product=[roundup.uploaded_image(v) for v in spec['files'].values()]
        for index,(shot,label,direction) in enumerate(SCENES):
            with LOCK:j['note']=f'Claude viết cảnh {index+1}/4: {label}';write(folder(app)/(j['id']+'.json'),j)
            ref=ROOT/'public/choly-references'/({'box':'shirts'}.get(shot,shot)+'.jpg')
            refs=product+[(ref.read_bytes(),'image/jpeg')]
            constraint='PRODUCT references are first. Copy garment artwork pixel-faithfully, exact print size and placement and every original Vietnamese name and accent. Never redraw or describe the artwork. Ignore any poster headings outside garments. Last reference is STYLE ONLY, never copy its identity, clothing design, logo or caption. Output ONE 3:4 photo. No overlay text, banners, white pills, watermark or collage. Reserve top 13–32 percent as quiet space for a white caption added separately.'
            brief=f'Scene {index+1}: {direction}\nCommunication concept: {spec["concept"]["name"]}: {spec["concept"]["angle"]}\nUser topic: {spec["topic"]}\nCaption to support visually, DO NOT render: {spec["captions"][index]}\n{constraint}'
            for attempt in range(3):
                try:
                    base=app.claude_vision_multi(app.PRODUCT_PROMPT_SYSTEM+'\nWrite one complete image prompt only. Respect explicit scene and 3:4 ratio.',brief,[raw for raw,mime in refs],max_tokens=1800,timeout=180)
                    if not base.strip():raise ValueError('Claude trả prompt rỗng.')
                    break
                except Exception:
                    if attempt==2:raise
                    time.sleep(2**attempt)
            prompt=constraint+'\n'+direction+'\n'+base
            model=roundup.PEOPLE_MODEL if index==0 else 'gpt-image-2.5-sunburst'
            with LOCK:j['note']=f'Đang tạo ảnh {index+1}/4: {label}';write(folder(app)/(j['id']+'.json'),j)
            write(folder(app)/(j['id']+f'-{index}.audit.json'),dict(base=base,prompt=prompt,model=model,references=[hashlib.sha256(raw).hexdigest() for raw,mime in refs]))
            b64=app.gemini_edit(refs,prompt,'3:4',model,image_size='4K') if index==0 else app.gen_shot(refs,prompt,'1152x1536','openai_25','3:4',lock=False,quality='high')
            raw=caption_image(base64.b64decode(b64),spec['captions'][index]);filename=j['id']+f'-{index}.png';(folder(app)/filename).write_bytes(raw)
            with LOCK:
                j['items'].append(dict(index=index,shot=label,filename=filename,base=base,prompt=prompt,model=model,caption=spec['captions'][index],image='/api/choly-studio/result?id='+j['id']+'&index='+str(index)))
                write(folder(app)/(j['id']+'.json'),j)
        with LOCK:j.update(status='done',note='Đã tạo đủ 4 ảnh có chữ.');write(folder(app)/(j['id']+'.json'),j)
    except Exception as e:
        with LOCK:j.update(status='failed',error=str(e)[:600]);write(folder(app)/(j['id']+'.json'),j)
    finally:
        with LOCK:LIVE.discard(j['id'])
def route(app,h,path,body=None):
    if not path.startswith('/api/choly-studio/'):return False
    try:
        user=h.current_user()
        if app.AUTH_REQUIRED and not user:raise roundup.Problem('Vui lòng đăng nhập.',401)
        if app.AUTH_REQUIRED and not app.user_has_tab(user,'choly'):raise roundup.Problem('Tài khoản chưa được cấp tab Choly Cutie.',403)
        owner=str((user or {}).get('id') or (user or {}).get('email') or 'local')
        q=urllib.parse.parse_qs(urllib.parse.urlparse(h.path).query);get=lambda k:q.get(k,[''])[0]
        action=path.rsplit('/',1)[-1]
        if body is not None and action=='generate':result=start(app,body,owner)
        elif body is None and action=='catalog':result={'concepts':CONCEPTS}
        elif body is None and action=='job':result=public(read(app,get('id'),owner))
        elif body is None and action=='result':
            job=read(app,get('id'),owner);item=next((i for i in job['items'] if str(i['index'])==get('index')),None)
            if not item:raise roundup.Problem('Ảnh chưa hoàn thành.',404)
            roundup.send_bytes(h,(folder(app)/item['filename']).read_bytes(),'image/png');return True
        elif body is None and action=='history':
            jobs=[]
            for p in folder(app).glob('*.json'):
                if p.name.endswith('.audit.json'):continue
                j=json.loads(p.read_text())
                if j.get('owner')==owner:jobs.append(public(read(app,j['id'],owner)))
            result={'jobs':sorted(jobs,key=lambda j:j['created'],reverse=True)[:30]}
        else:raise roundup.Problem('Không tìm thấy chức năng.',404)
        h.json(200,result)
    except roundup.Problem as e:h.json(e.status,{'error':str(e)})
    except Exception as e:h.json(502,{'error':str(e)[:500]})
    return True

"""Choly-inspired carousel: Claude prompts, explicit image providers, rendered captions."""
import base64, hashlib, io, json, re, threading, time, urllib.parse
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageOps
import roundup
import roundup_cast
ROOT=Path(__file__).resolve().parent
LOCK=threading.RLock()
LIVE=set()
CONCEPTS=json.loads((ROOT/'resource-seed/choly/concepts.json').read_text())
PRESETS=json.loads((ROOT/'resource-seed/choly/visual-presets.json').read_text())
ACCESSORIES={'zip':('rieng-zip.png','Túi zip RIENG.VN'),'tag':('rieng-tag.png','Tag cảm ơn RIENG.VN')}
PACKAGING_SCENES={'reaction','reader','reader-smile','hands-box','shirts','box','shirt-detail','night-pair','table'}
def folder(app):
    p=Path(app.DATA_DIR)/'choly-studio';p.mkdir(parents=True,exist_ok=True);return p
def write(path,data):
    tmp=path.with_suffix('.tmp');tmp.write_text(json.dumps(data,ensure_ascii=False));tmp.replace(path)
def validate(body):
    if not isinstance(body,dict) or not re.fullmatch(r'[a-f0-9-]{36}',str(body.get('request_id',''))):raise roundup.Problem('Thiếu mã yêu cầu hợp lệ.')
    concept=next((c for c in CONCEPTS if c['id']==body.get('concept')),None)
    if not concept:raise roundup.Problem('Chọn concept truyền thông.')
    visual=next((v for v in PRESETS if v['id']==body.get('visual','reaction')),None)
    if not visual:raise roundup.Problem('Concept hình ảnh không hợp lệ.')
    positions=body.get('positions',[shot['position'] for shot in visual['shots']])
    if not isinstance(positions,list) or len(positions)!=4 or any(v not in ('top','middle','bottom','none','callouts') for v in positions):raise roundup.Problem('Vị trí chữ không hợp lệ.')
    accessories=body.get('accessories',[])
    if not isinstance(accessories,list) or len(accessories)>2 or any(not isinstance(x,str) or x not in ACCESSORIES for x in accessories) or len(set(accessories))!=len(accessories):raise roundup.Problem('Chọn túi zip hoặc tag hợp lệ.')
    topic=body.get('topic','')
    if not isinstance(topic,str) or len(topic)>2000:raise roundup.Problem('Chủ đề tối đa 2000 ký tự.')
    captions=body.get('captions')
    if not isinstance(captions,list) or len(captions)!=4 or any(not isinstance(t,str) or len(t)>220 for t in captions):raise roundup.Problem('Mỗi câu chữ tối đa 220 ký tự.')
    files=body.get('files',{})
    if not isinstance(files,dict) or set(files)-{'shirt1','shirt2','male','female'} or not files.get('shirt1'):raise roundup.Problem('Tải ảnh áo trước.')
    if sum(len(v) if isinstance(v,str) else 99999999 for v in files.values())>19000000:raise roundup.Problem('Ảnh tải lên quá lớn.')
    for v in files.values():roundup.uploaded_image(v)
    return dict(concept=concept,visual=visual,positions=positions,topic=topic,files=files,captions=captions,accessories=sorted(accessories))
# Explicit roles prevent a one-person scene from accidentally introducing a couple.
SCENE_ROLES={'bouquet':['female'],'mirror':['female','male'],'memory':['female','male'],'diptych':['female','male']}
def roles_for(scene):
    return SCENE_ROLES.get(scene['id'],['male']) if scene['people'] else []
def identity_snapshot(spec):
    needed={role for scene in spec['visual']['shots'] for role in roles_for(scene)}
    if not needed:return {}
    defaults={p['role']:p for p in roundup_cast.people('couple')} if any(role not in spec['files'] for role in needed) else {}
    result={}
    for role in sorted(needed):
        if role in spec['files']:result[role]=roundup.uploaded_image(spec['files'][role])
        else:
            person=defaults[role];result[role]=(person['file'].read_bytes(),person.get('mime','image/jpeg'))
    return result

def write_dialogue(app,body):
    if not isinstance(body,dict):raise roundup.Problem('Dữ liệu không hợp lệ.')
    spec=next((v for v in PRESETS if v['id']==body.get('visual')),None)
    concept=next((v for v in CONCEPTS if v['id']==body.get('concept')),None)
    tone=body.get('tone','Cảm động');topic=body.get('topic','')
    if not spec or not concept or tone not in ('Cảm động','Trêu yêu','Bất ngờ','Yêu xa','Đời thường') or not isinstance(topic,str) or len(topic)>2000:raise roundup.Problem('Chọn concept và nhập chủ đề hợp lệ.')
    system='Bạn viết thoại ngắn cho carousel áo đôi. Viết MỚI bằng tiếng Việt, xưng anh/em, tự nhiên như nói chuyện, có mở đầu, đáp lại, món quà và câu kết. Không sao chép lời của thương hiệu khác, không bịa lời chứng thực khách hàng. Mỗi ảnh tối đa 180 ký tự, 1–2 câu. Trả đúng 4 khối, mỗi khối bắt đầu bằng ### SLIDE 1 (rồi 2, 3, 4). Không thêm giải thích.'
    prompt=f"Chủ đề: {topic}\nGiọng: {tone}\nConcept truyền thông: {concept['name']} — {concept['angle']}\nCác cảnh: "+'; '.join(f"{i+1}. {x['label']}" for i,x in enumerate(spec['shots']))
    for attempt in range(3):
        try:
            answer=app.claude_text(system,prompt,max_tokens=1600)
            parts=re.split(r'###\s*SLIDE\s+[1-4]\s*',answer)[1:]
            if len(parts)!=4 or any(not p.strip() or len(p.strip())>220 for p in parts):raise ValueError('Claude chưa trả đủ 4 đoạn thoại ngắn.')
            return {'captions':[p.strip() for p in parts]}
        except Exception:
            if attempt==2:raise
            time.sleep(2**attempt)

def caption_image(raw,text,position='top'):
    im=ImageOps.fit(Image.open(io.BytesIO(raw)).convert('RGB'),(1152,1536))
    draw=ImageDraw.Draw(im)
    def draw_block(text,cx,cy,width,max_size):
        for size in range(max_size,15,-2):
            font=ImageFont.truetype(str(ROOT/'fonts/BeVietnamProBold.ttf'),size)
            lines=[];line=''
            # Character wrapping also handles long words without spaces.
            for paragraph in text.split('\n'):
                for word in paragraph.split():
                    chunks=[word]
                    if draw.textlength(word,font=font)>width:
                        chunks=[];part=''
                        for ch in word:
                            if draw.textlength(part+ch,font=font)>width:chunks.append(part);part=''
                            part+=ch
                        if part:chunks.append(part)
                    for word in chunks:
                        candidate=(line+' '+word).strip()
                        if draw.textlength(candidate,font=font)>width and line:lines.append(line);line=word
                        else:line=candidate
                if line:lines.append(line);line=''
            if len(lines)<=4:break
        for i,line in enumerate(lines):draw.text((cx,cy+i*size*1.4),line,font=font,fill='white',stroke_width=max(1,round(size/16)),stroke_fill='black',anchor='mt')
    if text.strip() and position!='none':
        if position=='callouts':
            chunks=[t.strip() for t in text.split('|') if t.strip()]
            for chunk,(x,y) in zip(chunks[:3],[(300,220),(840,650),(330,1100)]):draw_block(chunk,x,y,450,34)
        else:draw_block(text,576,{'top':195,'middle':650,'bottom':1110}[position],980,52)
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
        if not (app.ANTHROPIC_API_KEY and (app.GEMINI_API_KEY or not any(x['people'] for x in spec['visual']['shots'])) and (app.API_KEY or all(x['people'] for x in spec['visual']['shots']))):raise roundup.Problem('Cần cấu hình Claude, Nano Banana Pro và GPT Image trong máy chủ.',503)
        identities=identity_snapshot(spec)
        j=dict(id=jid,owner=owner,digest=digest,status='running',created=time.time(),items=[],total=4,error='',note='Claude đang viết kịch bản từng ảnh…',concept=spec['concept']['name'],visual=spec['visual']['name'],visual_id=spec['visual']['id'],topic=spec['topic'],accessories=spec['accessories'],identity_lock=bool(identities),identity_hashes={role:hashlib.sha256(raw).hexdigest() for role,(raw,mime) in identities.items()})
        write(folder(app)/(jid+'.json'),j);LIVE.add(jid)
        threading.Thread(target=run,args=(app,j,spec,identities),daemon=True).start()
        return public(j)
def run(app,j,spec,identities=None):
    try:
        identities=identity_snapshot(spec) if identities is None else identities
        product=[roundup.uploaded_image(spec['files'][k]) for k in ('shirt1','shirt2') if k in spec['files']]
        for index,scene in enumerate(spec['visual']['shots']):
            shot,label,direction=scene['id'],scene['label'],scene['direction']
            position=spec['positions'][index]
            with LOCK:j['note']=f'Claude viết cảnh {index+1}/4: {label}';write(folder(app)/(j['id']+'.json'),j)
            ref=ROOT/'public/choly-references'/scene['reference']
            refs=list(product);identity_rules=[]
            for role in roles_for(scene):
                refs.append(identities[role])
                identity_rules.append(f'[REFERENCE_ROLE {len(refs)}: IDENTITY {role.upper()} ONLY] Match this exact adult face, facial proportions, eyes, nose, mouth, hairstyle, hairline, skin tone and eyewear in every scene. Never borrow clothes, pose or background from this reference.')
            packaging_rules=[]
            if scene['id'] in PACKAGING_SCENES:
                for key in spec['accessories']:
                    asset,label=ACCESSORIES[key]
                    refs.append(((ROOT/'public/roundup-references'/asset).read_bytes(),'image/png'))
                    packaging_rules.append(f'[REFERENCE_ROLE {len(refs)}: PACKAGING ONLY — {label}] Include this exact packaging in the gift arrangement. Preserve its material, shape, logo and printed typography; never place packaging graphics on the shirt.')
            refs.append((ref.read_bytes(),'image/jpeg'))
            constraint='PRODUCT references are first. Copy garment artwork pixel-faithfully, exact print size and placement and every original Vietnamese name and accent. Never redraw or describe the artwork. Ignore any poster headings outside garments. Last reference is STYLE ONLY, never copy its identity, clothing design, logo or caption. Use supplied garments only where the scene calls for clothing. Preserve print on its original side; never transfer a front design to the back. Output ONE 3:4 image. No added watermark or copied source caption. Do not add overlay text; it will be rendered separately.'
            if packaging_rules:constraint+=' '.join(packaging_rules)+' Keep the zip pouch garment-sized and translucent, with shirt visible; keep the tag small, about 5–8 percent of shirt width, beside the shirt or on the pouch. Keep shirt artwork and faces unobstructed. Do not copy Choly branding from style references. '
            constraint+=' Layout: '+scene['layout']+'. '+('Keep one continuous photograph, no collage. ' if scene['layout']=='photo' else 'Follow the explicitly requested layout. ')
            constraint+='Caption placement: '+position+'. Leave quiet space there, avoid faces and shirt artwork. '
            if not scene['people']:constraint+='No people, hands, faces, bodies or mannequins. '
            if scene['people']:
                constraint='IDENTITY LOCK: '+ ' '.join(identity_rules)+' Only show the characters required by this scene ('+', '.join(roles_for(scene))+'); never add another person. Style-image faces must be replaced by the pinned identity faces. '+constraint
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
            model=roundup.PEOPLE_MODEL if scene['people'] else 'gpt-image-2.5-sunburst'
            with LOCK:j['note']=f'Đang tạo ảnh {index+1}/4: {label}';write(folder(app)/(j['id']+'.json'),j)
            write(folder(app)/(j['id']+f'-{index}.audit.json'),dict(base=base,prompt=prompt,model=model,references=[hashlib.sha256(raw).hexdigest() for raw,mime in refs]))
            b64=app.gemini_edit(refs,prompt,'3:4',model,image_size='4K') if scene['people'] else app.gen_shot(refs,prompt,'1152x1536','openai_25','3:4',lock=False,quality='high')
            raw=caption_image(base64.b64decode(b64),spec['captions'][index],position);filename=j['id']+f'-{index}.png';(folder(app)/filename).write_bytes(raw)
            with LOCK:
                j['items'].append(dict(index=index,shot=label,filename=filename,base=base,prompt=prompt,model=model,caption=spec['captions'][index],position=position,visual=spec['visual']['id'],identity_roles=roles_for(scene),image='/api/choly-studio/result?id='+j['id']+'&index='+str(index)))
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
        elif body is not None and action=='dialogue':result=write_dialogue(app,body)
        elif body is None and action=='identity':
            person=next((p for p in roundup_cast.people('couple') if p['role']==get('role')),None)
            if not person:raise roundup.Problem('Nhân vật không hợp lệ.')
            thumb=person['file'].parent/person.get('preview_asset','')
            roundup.send_bytes(h,thumb.read_bytes() if thumb.is_file() else person['file'].read_bytes(),person.get('mime','image/jpeg'));return True
        elif body is None and action=='catalog':result={'concepts':CONCEPTS,'visuals':PRESETS}
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

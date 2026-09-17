"""Choly-inspired carousel: ChatGPT prompts, explicit image providers, rendered captions."""
import copy, base64, hashlib, io, json, re, threading, time, urllib.parse
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageOps
import roundup
import roundup_cast
ROOT=Path(__file__).resolve().parent
LOCK=threading.RLock()
LIVE=set()
CONCEPTS=json.loads((ROOT/'resource-seed/choly/concepts.json').read_text())
PRESETS=json.loads((ROOT/'resource-seed/choly/visual-presets.json').read_text())
ACCESSORIES={'zip':('rieng-zip.png','Túi zip RIENG.VN'),'tag':('rieng-tag.png','Tag cảm ơn RIENG.VN'),'box':('kraft-box.png','Hộp kraft')}
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
    if not isinstance(accessories,list) or len(accessories)>3 or any(not isinstance(x,str) or x not in ACCESSORIES for x in accessories) or len(set(accessories))!=len(accessories):raise roundup.Problem('Chọn túi zip, tag hoặc hộp hợp lệ.')
    topic=body.get('topic','')
    if not isinstance(topic,str) or len(topic)>2000:raise roundup.Problem('Chủ đề tối đa 2000 ký tự.')
    captions=body.get('captions')
    if not isinstance(captions,list) or len(captions)!=4 or any(not isinstance(t,str) or len(t)>220 for t in captions):raise roundup.Problem('Mỗi câu chữ tối đa 220 ký tự.')
    files=body.get('files',{})
    if not isinstance(files,dict) or set(files)-{'shirt1','shirt2','male','female','reference0','reference1','reference2','reference3','zip','tag','box'} or not files.get('shirt1'):raise roundup.Problem('Tải ảnh áo trước.')
    if sum(len(v) if isinstance(v,str) else 99999999 for v in files.values())>50000000:raise roundup.Problem('Ảnh tải lên quá lớn.')
    for v in files.values():roundup.uploaded_image(v)
    scene_types=body.get('scene_types',['preset']*4)
    if not isinstance(scene_types,list) or len(scene_types)!=4 or any(t not in ('preset','objects','male','female','couple','hands') for t in scene_types):raise roundup.Problem('Loại cảnh không hợp lệ.')
    visual=copy.deepcopy(visual)
    for index,kind in enumerate(scene_types):
        if 'reference'+str(index) in files and kind!='preset':
            scene=visual['shots'][index]
            scene['people']=kind!='objects'
            scene['roles']=[] if kind in ('objects','hands') else ['male','female'] if kind=='couple' else [kind]
            scene['layout']='photo'
            scene['direction']='Recreate the uploaded source composition. '+('Only visible hands, no face or body.' if kind=='hands' else '')
    prompts=body.get('prompts' ,['']*4)
    if not isinstance(prompts,list) or len(prompts)!=4 or any(not isinstance(t,str) or len(t)>24000 for t in prompts):raise roundup.Problem('Cần 4 prompt, tối đa 24000 ký tự mỗi prompt.')
    return dict(prompts=prompts,concept=concept,visual=visual,positions=positions,topic=topic,files=files,captions=captions,accessories=sorted(accessories))
# Explicit roles prevent a one-person scene from accidentally introducing a couple.
SCENE_ROLES={'bouquet':['female'],'mirror':['female','male'],'memory':['female','male'],'diptych':['female','male']}
def roles_for(scene):
    return scene.get('roles',SCENE_ROLES.get(scene['id'],['male'])) if scene['people'] else []
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

def chatgpt_text(app,system,text,max_tokens=1600):
    if not app.API_KEY:raise roundup.Problem('Chưa cấu hình OPENAI_API_KEY.',503)
    return app.openai_chat([{'role':'system','content':system},{'role':'user','content':text}],json_mode=False,max_tokens=max_tokens,model=app.BEST_TEXT_MODEL)

def chatgpt_vision(app,system,text,raws,max_tokens=4500):
    content=[{'type':'text','text':text}]
    for raw in raws:
        with Image.open(io.BytesIO(raw)) as im:
            mime=Image.MIME.get(im.format,'image/png')
        content.append({'type':'image_url','image_url':{'url':'data:'+mime+';base64,'+base64.b64encode(raw).decode(),'detail':'high'}})
    return chatgpt_text(app,system,content,max_tokens=max_tokens)

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
            answer=chatgpt_text(app,system,prompt,max_tokens=1600)
            parts=re.split(r'###\s*SLIDE\s+[1-4]\s*',answer)[1:]
            if len(parts)!=4 or any(not p.strip() or len(p.strip())>220 for p in parts):raise ValueError('ChatGPT chưa trả đủ 4 đoạn thoại ngắn.')
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
        if not app.API_KEY:raise roundup.Problem('Cần cấu hình GPT Image 2.5 và ChatGPT để phân tích ảnh thành prompt.',503)
        identities=identity_snapshot(spec)
        j=dict(id=jid,owner=owner,digest=digest,status='running',created=time.time(),items=[],total=4,error='',note='ChatGPT đang viết kịch bản từng ảnh…',concept=spec['concept']['name'],visual=spec['visual']['name'],visual_id=spec['visual']['id'],topic=spec['topic'],accessories=spec['accessories'],identity_lock=bool(identities),identity_hashes={role:hashlib.sha256(raw).hexdigest() for role,(raw,mime) in identities.items()})
        write(folder(app)/(jid+'.json'),j);LIVE.add(jid)
        threading.Thread(target=run,args=(app,j,spec,identities),daemon=True).start()
        return public(j)
POSE_REFERENCE_DIRECTION = (
    'POSE REFERENCE LOCK: Image #1 is the selected source photograph and is the primary reference for pose and composition. '
    'Inspect it visually and describe its actual torso lean, shoulder angle, head tilt, gaze, expression, '
    'elbow support, wrist orientation, finger grip, prop height, visible leg placement and camera crop in the scene prompt. '
    'Reproduce these observed relationships, subject scale, camera height, viewing angle and framing with the pinned adult KOL and supplied garment. '
    'Do not invent hidden limbs, widen the crop to add shoes, move the subject to another seat, lower a raised card or substitute a generic candid/fashion pose. '
    'Match the observed expression intensity and available-light character, retaining believable anatomy and skin texture. '
    'For hands-only references reproduce only the visible hands and their object interaction; keep faces outside the crop. '
    'The source pose and crop take precedence over generic pose banks, expression rules and conflicting scene prose. '
    'Transfer pose, not identity: keep the pinned KOL face, supplied shirt artwork and selected packaging. '
    'Never copy source branding, garment graphics or caption text. Preserve artwork exactly where visible without forcing the body to display it. '
)

SOURCE_EDIT_DIRECTION = (
    '[REFERENCE_ROLE 1: BASE PHOTO TO EDIT] Edit image #1 itself; do not generate a new scene inspired by it. '
    'Keep the existing camera viewpoint, crop, background geometry, furniture, shadows, exposure and colour grading. '
    'Limit changes to replacing visible clothing with the supplied product, replacing visible source characters with the pinned KOL, '
    'and replacing gift packaging where selected. Remove existing overlaid captions and source-brand lettering, restoring the underlying surface. '
    'Retain the original body pose, hand contact points, facial expression and object positions. '
    'For flatlays retain the garment silhouette, folds, perspective, object spacing and shadows while substituting the supplied garment and artwork. '
    'Fit replacement artwork to existing folds and perspective; do not flatten, neatly restyle or relight the arrangement. '
    'References after #1 are replacement assets only, never alternative compositions. '
    'Scene prose and communication concept explain context only; do not use them to restage the base photo. '
    'If the requested scene excludes people, remove incidental people/hands locally while preserving the remaining scene. '
    'Do not add garments to letter-only or object-only scenes that have no garment. '
)

PROMPT_FORMULA = """Analyze image #1 visually and write ONE complete, detailed English image-generation prompt with these eleven numbered sections. Describe only visible evidence, cautiously qualify uncertain details, and never infer ethnicity. Prioritize accurate recreation over creativity. Apply the explicitly supplied replacement KOL, garments and selected packaging while retaining the source pose, framing and setting. Reference assets are not additional scenes.
1. Subject: apparent adult age range, visible facial features, hair, expression, build and accessories; use pinned KOL identity, never the source person's identity.
2. Camera Angle / Framing: camera height, angle, shot size, distance, composition, subject placement, perspective and apparent photographic character; do not assert exact lens or device without evidence.
3. Clothing: supplied garment colors, material, texture, fit, silhouette, layers, artwork, footwear and accessories that are visible in the source crop.
4. Pose: exact torso, head, gaze, shoulders, arms, hands, legs and interactions; do not invent hidden anatomy.
5. Environment: visible furniture, walls, floors, plants, props and spatial relationships; selected zip pouch, thank-you tag and box use their own reference assets.
6. Lighting: observed source, direction, warmth, brightness, contrast, shadows, highlights and reflections.
7. Color Palette and Atmosphere: dominant colors, mood and visible time/weather cues without guessing.
8. Final Style: ultra-realistic natural photography, believable skin texture and material detail; match observed depth of field, grain, sharpness and candid/editorial character, never plastic or overpolished.
9. Important Details to Preserve: exact source composition, pose, facial direction, background layout, lighting and atmosphere, with only the authorized asset substitutions. Remove source captions, watermarks and nonphysical logos. Preserve physical supplied garment and packaging artwork as explicitly requested, never transcribe source overlay text.
10. Negative Prompt: worst quality, low quality, normal quality, low resolution, unintended blurry detail, ugly, distorted, defective, watermark, overlay text, captions, subtitles, signature, bad anatomy, bad hands, missing fingers, extra fingers, extra limbs, merged fingers, deformed iris, distorted face, unnatural skin, plastic skin, duplicated objects, warped furniture, incorrect perspective, unrealistic proportions, uncanny valley.
11. Aspect Ratio: state the observed source aspect ratio cautiously and specify the app output is portrait 3:4, preserving composition as closely as possible.
Return only the complete English prompt. Do not generate an image. For an object-only scene mark human-only attributes as not applicable. Source image evidence overrides preset scene prose; preserve only the visible people/hands required by the selected scene and the supplied identity roles.
"""

def prepare_scene(app,spec,identities,index):
    scene=spec['visual']['shots'][index]
    direction=scene['direction'];position=spec['positions'][index]
    product=[roundup.uploaded_image(spec['files'][k]) for k in ('shirt1','shirt2') if k in spec['files']]
    ref=ROOT/'public/choly-references'/scene['reference']
    refs=[roundup.uploaded_image(spec['files']['reference'+str(index)]) if 'reference'+str(index) in spec['files'] else (ref.read_bytes(),'image/jpeg')]+list(product);identity_rules=[]
    product_rules=' '.join(f'[REFERENCE_ROLE {i+2}: REPLACEMENT GARMENT {i+1} ONLY]' for i in range(len(product)))
    for role in roles_for(scene):
        refs.append(identities[role])
        identity_rules.append(f'[REFERENCE_ROLE {len(refs)}: IDENTITY {role.upper()} ONLY] Match this exact adult face, facial proportions, eyes, nose, mouth, hairstyle, hairline, skin tone and eyewear in every scene. Never borrow clothes, pose or background from this reference.')
    packaging_rules=[]
    if scene['id'] in PACKAGING_SCENES or 'reference'+str(index) in spec['files']:
        for key in spec['accessories']:
            asset,label=ACCESSORIES[key]
            refs.append(roundup.uploaded_image(spec['files'][key]) if key in spec['files'] else ((ROOT/'public/roundup-references'/asset).read_bytes(),'image/png'))
            packaging_rules.append(f'[REFERENCE_ROLE {len(refs)}: PACKAGING ONLY — {label}] Include this exact packaging in the gift arrangement. Preserve its material, shape, logo and printed typography; never place packaging graphics on the shirt.')
    constraint=SOURCE_EDIT_DIRECTION+product_rules+' Product references start at image #2. Copy garment artwork pixel-faithfully, exact print size and placement and every original Vietnamese name and accent. Never redraw or describe the artwork. Ignore any poster headings outside garments. Image #1 is the base photograph, not a garment or identity reference. Replace its original identity, clothing design, logo and caption as instructed. Use supplied garments only where the scene calls for clothing. Preserve print on its original side; never transfer a front design to the back. Output ONE 3:4 image. No added watermark or copied source caption. Do not add overlay text; it will be rendered separately.'
    if packaging_rules:constraint+=' '.join(packaging_rules)+' Keep the zip pouch garment-sized and translucent, with shirt visible; keep the tag small, about 5–8 percent of shirt width, beside the shirt or on the pouch. Keep shirt artwork and faces unobstructed. Do not copy Choly branding from style references. '
    constraint+=' Layout: '+scene['layout']+'. '+('Keep one continuous photograph, no collage. ' if scene['layout']=='photo' else 'Follow the explicitly requested layout. ')
    constraint+='Caption placement: '+position+'. Do not move subjects or change the crop to make room for text; the overlay is applied separately. '
    with Image.open(io.BytesIO(refs[0][0])) as source:
        constraint+=f' Source image dimensions: {source.width} x {source.height}; report this observed ratio in section 11. Output remains 3:4. '
    if not scene['people']:constraint+='No people, hands, faces, bodies or mannequins. '
    if scene['people']:
        constraint=POSE_REFERENCE_DIRECTION+'IDENTITY LOCK: '+ ' '.join(identity_rules)+' Only show the visible characters or hands required by this scene ('+', '.join(roles_for(scene))+'); never add another person. Style-image faces must be replaced by the pinned identity faces. '+constraint
    brief=f'Scene {index+1}: {direction if "reference"+str(index) not in spec["files"] else "Use the uploaded base image. Ignore the preset scene description; preserve the uploaded composition."}\nCommunication concept: {spec["concept"]["name"]}: {spec["concept"]["angle"]}\nUser topic: {spec["topic"]}\nCaption to support visually, DO NOT render: {spec["captions"][index]}\n{constraint}'
    for attempt in range(0 if spec['prompts'][index].strip() else 3):
        try:
            base=chatgpt_vision(app,PROMPT_FORMULA+'\nWrite one image EDIT instruction, not a new-scene generation prompt. The following source-edit contract overrides generic scene, lighting and pose banks. Keep the 3:4 base composition.\n'+SOURCE_EDIT_DIRECTION+('\n'+POSE_REFERENCE_DIRECTION if scene['people'] else ''),brief,[raw for raw,mime in refs],max_tokens=4500)
            if not base.strip():raise ValueError('ChatGPT trả prompt rỗng.')
            break
        except Exception:
            if attempt==2:raise
            time.sleep(2**attempt)
    if spec['prompts'][index].strip():base=spec['prompts'][index].strip()
    prompt=constraint+'\n'+base
    return refs,base,prompt

def prepare_prompts(app,body):
    spec=validate(body);identities=identity_snapshot(spec)
    return {'prompts':[prepare_scene(app,spec,identities,i)[1] for i in range(4)],'model':'gpt-image-2.5-sunburst'}


def run(app,j,spec,identities=None):
    try:
        identities=identity_snapshot(spec) if identities is None else identities
        product=[roundup.uploaded_image(spec['files'][k]) for k in ('shirt1','shirt2') if k in spec['files']]
        for index,scene in enumerate(spec['visual']['shots']):
            shot,label,direction=scene['id'],scene['label'],scene['direction']
            position=spec['positions'][index]
            with LOCK:j['note']=f'ChatGPT viết cảnh {index+1}/4: {label}';write(folder(app)/(j['id']+'.json'),j)
            refs,base,prompt=prepare_scene(app,spec,identities,index)
            model='gpt-image-2.5-sunburst'
            with LOCK:j['note']=f'Đang tạo ảnh {index+1}/4: {label}';write(folder(app)/(j['id']+'.json'),j)
            write(folder(app)/(j['id']+f'-{index}.audit.json'),dict(mode='source_edit',source_reference=('uploaded:'+str(index) if 'reference'+str(index) in spec['files'] else scene['reference']),base=base,prompt=prompt,model=model,references=[hashlib.sha256(raw).hexdigest() for raw,mime in refs]))
            b64=app.gen_shot(refs,prompt,'1152x1536','openai_25','3:4',lock=False,quality='high')
            clean_raw=base64.b64decode(b64)
            (folder(app)/(j['id']+f'-{index}.clean.png')).write_bytes(clean_raw)
            raw=caption_image(clean_raw,spec['captions'][index],position);filename=j['id']+f'-{index}.png';(folder(app)/filename).write_bytes(raw)
            with LOCK:
                j['items'].append(dict(mode='source_edit',source_reference=('uploaded:'+str(index) if 'reference'+str(index) in spec['files'] else scene['reference']),index=index,shot=label,filename=filename,base=base,prompt=prompt,model=model,caption=spec['captions'][index],position=position,visual=spec['visual']['id'],identity_roles=roles_for(scene),image='/api/choly-studio/result?id='+j['id']+'&index='+str(index)))
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
        if action=='single-faces':
            import single_image_studio
            result=single_image_studio.saved_faces(app,owner,body)
        elif action in ('single-prompt','single-generate') and body is not None:
            import single_image_studio
            result=single_image_studio.analyze(app,body) if action=='single-prompt' else single_image_studio.generate(app,body,owner)
        elif body is not None and action=='generate':result=start(app,body,owner)
        elif body is not None and action=='prompts':result=prepare_prompts(app,body)
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

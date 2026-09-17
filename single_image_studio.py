"""One reference → editable photography prompt → one finished image."""
import re, base64, hashlib, io, json, threading, time
from PIL import Image, ImageOps
import choly_studio as core
import roundup

PROMPT_OPENING='Create an extremely realistic image (ultra-realistic).'
IPHONE_CAMERA='Shot on iPhone — iPhone lifestyle photography, natural handheld smartphone framing, realistic available light and authentic skin and material texture.'

def iphone_prompt(text):
    # Ensure the visible camera section always includes the requested capture style.
    pattern=r'(^\s*(?:#{1,6}\s*)?(?:\*\*)?2[.)]\s+[^\n]*\n?)(.*?)(?=^\s*(?:#{1,6}\s*)?(?:\*\*)?3[.)]\s+|\Z)'
    if IPHONE_CAMERA not in text:
        text=re.sub(pattern,lambda m:m.group(1).rstrip()+'\n'+IPHONE_CAMERA+'\n'+m.group(2),text,count=1,flags=re.M|re.S)
    return text

REFUSAL_MESSAGE='ChatGPT đã từ chối yêu cầu này và chưa tạo prompt. Không có ảnh nào được tạo. Hãy kiểm tra ảnh tham chiếu và nội dung yêu cầu; phản hồi hiện tại không nêu lý do cụ thể.'
def is_refusal(text):
    return isinstance(text,str) and bool(re.search(r"(?:I(?:['’]m| am) sorry[,.]?\s*)?I\s+(?:can(?:not|['’]t)|am unable to|['’]m unable to)\s+(?:assist|help|comply|fulfill|provide|create|generate)|I must decline|I have to decline|tôi không thể (?:hỗ trợ|giúp|thực hiện)",text,re.I))
def verify_prompt(text,structured=False):
    if is_refusal(text):raise roundup.Problem(REFUSAL_MESSAGE,422)
    if not isinstance(text,str) or not text.strip():raise roundup.Problem('ChatGPT chưa trả prompt. Không có ảnh nào được tạo.',502)
    text=re.sub(r'^```[^\n]*\n|\n```$', '', text.strip()).strip()
    if structured:
        sections=re.findall(r'^\s*(?:#{1,6}\s*)?(?:\*\*)?(\d{1,2})[.)]\s+',text,re.M)
        if sections!=[str(n) for n in range(1,12)]:raise roundup.Problem('ChatGPT chưa trả đủ 11 mục mô tả. Hãy tạo lại prompt.',502)
    return text.strip()

ASPECTS={'1:1':1,'4:5':.8,'2:3':2/3,'3:4':.75,'9:16':9/16,'3:2':1.5,'4:3':4/3,'16:9':16/9}
PROVIDERS={'openai_25':('GPT Image 2.5','gpt-image-2.5-sunburst','API_KEY'),'gemini_pro':('Nano Banana Pro','gemini-3-pro-image-preview','GEMINI_API_KEY')}

def saved_faces(app,owner,body=None):
    directory=core.folder(app)/'saved-faces';directory.mkdir(exist_ok=True)
    account=hashlib.sha256(owner.encode()).hexdigest()
    path=directory/(account+'.json')
    assets=directory/account;assets.mkdir(exist_ok=True)
    with core.LOCK:
        saved=json.loads(path.read_text()) if path.exists() else {'files':{},'kol':'upload'}
        saved.setdefault('library',[])
        def remember(data,name):
            if not isinstance(data,str) or len(data)>4500000:raise roundup.Problem('Ảnh khuôn mặt quá lớn.')
            raw,mime=roundup.uploaded_image(data);face_id=hashlib.sha256(raw).hexdigest()
            if not any(face['id']==face_id for face in saved['library']):
                if len(saved['library'])>=100:raise roundup.Problem('Thư viện đã có 100 khuôn mặt.')
                with Image.open(io.BytesIO(raw)) as image:
                    image=ImageOps.exif_transpose(image).convert('RGB');image.thumbnail((160,160))
                    thumb=io.BytesIO();image.save(thumb,'JPEG',quality=80)
                (assets/(face_id+'.image')).write_bytes(raw)
                saved['library'].append({'id':face_id,'name':str(name or 'KOL '+str(len(saved['library'])+1))[:120],'mime':mime,'thumbnail':'data:image/jpeg;base64,'+base64.b64encode(thumb.getvalue()).decode()})
            return 'data:'+mime+';base64,'+base64.b64encode(raw).decode()
        # Preserve the previously saved single/male/female faces when upgrading.
        for slot,data in saved['files'].items():remember(data,{'kol':'KOL đã lưu','kol_male':'KOL nam đã lưu','kol_female':'KOL nữ đã lưu'}[slot])
        if body is not None:
            if not isinstance(body,dict) or body.get('slot') not in ('kol','kol_male','kol_female'):
                raise roundup.Problem('Vị trí khuôn mặt không hợp lệ.')
            slot=body['slot'];data=body.get('image')
            if 'face_id' in body:
                face=next((f for f in saved['library'] if f['id']==body['face_id']),None)
                if not face:raise roundup.Problem('Không tìm thấy khuôn mặt trong tài khoản.',404)
                raw=(assets/(face['id']+'.image')).read_bytes()
                data='data:'+face['mime']+';base64,'+base64.b64encode(raw).decode()
            if data is None:saved['files'].pop(slot,None)
            else:
                saved['files'][slot]=remember(data,body.get('name'))
                saved['kol']='upload' if slot=='kol' else 'couple'
        core.write(path,saved)
        return saved

def validate(body, generating=False):
    if not isinstance(body,dict):raise roundup.Problem('Dữ liệu không hợp lệ.')
    files=body.get('files',{})
    if not isinstance(files,dict) or set(files)-{'reference','kol','kol_male','kol_female','shirt_male','shirt_female','environment','zip','box','tag'} or not files.get('reference'):raise roundup.Problem('Tải một ảnh tham chiếu trước.')
    if sum(len(v) if isinstance(v,str) else 99999999 for v in files.values())>46000000:raise roundup.Problem('Tổng dung lượng ảnh quá lớn.')
    for value in files.values():roundup.uploaded_image(value)
    selected=body.get('accessories',[])
    if not isinstance(selected,list) or any(k not in core.ACCESSORIES for k in selected) or len(set(selected))!=len(selected):raise roundup.Problem('Bao bì không hợp lệ.')
    kol=body.get('kol','none')
    if kol not in ('none','flatlay','new','male','female','upload','couple') or (kol=='upload' and not files.get('kol')):raise roundup.Problem('Chọn hoặc tải ảnh KOL.')
    male_position=body.get('male_position','auto')
    if male_position not in ('auto','left','right'):raise roundup.Problem('Vị trí KOL không hợp lệ.')
    shirts=body.get('shirts','none')
    if shirts not in ('none','male','female','both'):raise roundup.Problem('Chọn áo nam, áo nữ hoặc cả hai.')
    shirt_roles=('male','female') if shirts=='both' else () if shirts=='none' else (shirts,)
    for role in shirt_roles:
        if not files.get('shirt_'+role):raise roundup.Problem('Tải ảnh áo '+('nam' if role=='male' else 'nữ')+' đã chọn.')
    environment_description=body.get('environment_description','')
    if not isinstance(environment_description,str) or len(environment_description)>3000:raise roundup.Problem('Mô tả bối cảnh tối đa 3000 ký tự.')
    prompt=body.get('prompt','')
    if not isinstance(prompt,str) or len(prompt)>24000 or (generating and not prompt.strip()):raise roundup.Problem('Tạo hoặc nhập prompt trước khi tạo ảnh (tối đa 24000 ký tự).')
    aspect=body.get('aspect','auto')
    if not isinstance(aspect,str) or (aspect!='auto' and aspect not in ASPECTS):raise roundup.Problem('Tỉ lệ ảnh không hợp lệ.')
    provider=body.get('provider','gemini_pro')
    if provider not in PROVIDERS:raise roundup.Problem('Model tạo ảnh không hợp lệ.')
    if generating:prompt=verify_prompt(prompt)
    return dict(aspect=aspect,provider=provider,files=files,accessories=sorted(selected),kol=kol,male_position=male_position,shirts=shirts,environment_description=environment_description.strip(),prompt=prompt.strip())

def references(spec):
    # The scene reference is for ChatGPT analysis only; it must never reach generation.
    refs=[];rules=['Create a NEW photograph from the written scene description. No base photo is supplied. Do not edit any supplied asset into a scene; use each only for its assigned role.']
    def add(asset,role):
        refs.append(asset);rules.append(f'Image #{len(refs)}: '+role)
    kol=spec['kol']
    if kol=='couple':
        defaults=None
        for role in ('male','female'):
            key='kol_'+role
            if key in spec['files']:asset=roundup.uploaded_image(spec['files'][key])
            else:
                if defaults is None:defaults={p['role']:p for p in core.roundup_cast.people('couple')}
                person=defaults[role];asset=(person['file'].read_bytes(),person.get('mime','image/jpeg'))
            position=spec['male_position']
            target=role if position=='auto' else ('viewer '+(position if role=='male' else ('right' if position=='left' else 'left')))
            add(asset,f'{role.upper()} KOL IDENTITY ONLY, assigned to {target}. Match face and hair; ignore portrait clothes and background. Never swap, blend or duplicate identities.')
    elif kol in ('male','female','upload'):
        if kol=='upload':asset=roundup.uploaded_image(spec['files']['kol'])
        else:
            person=next(p for p in core.roundup_cast.people('couple') if p['role']==kol)
            asset=(person['file'].read_bytes(),person.get('mime','image/jpeg'))
        add(asset,'KOL IDENTITY ONLY for the corresponding subject. Match face and hair, not portrait clothes or background.')
    elif kol=='flatlay':rules.append('FLATLAY / OBJECT-ONLY MODE: no people, faces, hands, bodies, mannequins or human reflections. Shirt gender labels do not add wearers.')
    elif kol=='new':rules.append('NEW FICTIONAL PEOPLE MODE: distinct new fictional adult identities, no source face or saved KOL identity.')
    else:rules.append('Use the people described in the prompt. No source photograph or exact face reference is supplied.')
    roles=('male','female') if spec['shirts']=='both' else () if spec['shirts']=='none' else (spec['shirts'],)
    for role in roles:
        add(roundup.uploaded_image(spec['files']['shirt_'+role]),f'{role.upper()} SHIRT PRODUCT ONLY. Preserve the exact supplied color, fabric, cut, print placement, artwork, logos and physical lettering including Vietnamese accents. Assign to the corresponding wearer or flatlay product. Never swap shirts, mirror lettering or transfer front print to back; ignore product model and background.')
    rules.append('CLOTHING: selected uploaded shirts stay unchanged and unobstructed, taking priority over the corresponding shirt seen in the scene reference. For all other visible clothing, footwear, bags and worn accessories, describe the outfit seen in the scene reference as the desired final outfit; no outfit change is required. If no shirt is selected for a wearer, describe that wearer’s original visible shirt too. Do not impose a skirt, jeans, new colors or different garment cuts. Describe those visible items concretely in the prompt so generation does not depend on seeing the scene reference. Describe only visible portions; no added limbs or clothing props in object-only scenes. Keep bag shape, straps and hand contact physically consistent.')
    for key in spec['accessories']:
        asset,label=core.ACCESSORIES[key]
        add(roundup.uploaded_image(spec['files'][key]) if key in spec['files'] else ((core.ROOT/'public/roundup-references'/asset).read_bytes(),'image/png'),f'{label} PACKAGING ONLY. Preserve exact shape, material, physical print and branding; realistic scale, placement, perspective and contact shadows. Never transfer artwork to clothing.')
    if spec['files'].get('environment'):
        add(roundup.uploaded_image(spec['files']['environment']),'ENVIRONMENT REFERENCE ONLY. Use setting, furniture, palette and light; do not copy people, clothes, products or overlay text. Match the described camera and subject placement.')
    if spec['environment_description']:rules.append('USER ENVIRONMENT DESCRIPTION (takes precedence over environment image): '+spec['environment_description'])
    rules.append('One natural ultra-realistic photograph, iPhone lifestyle photography, realistic skin and material textures. No overlay text, watermarks or collage. Preserve physical product lettering only.')
    return refs,'\n'.join(rules)

def analyze(app,body):
    spec=validate(body);refs,rules=references(spec)
    source=roundup.uploaded_image(spec['files']['reference'])
    with Image.open(io.BytesIO(source[0])) as im:width,height=im.size
    aspect=spec['aspect'] if spec['aspect']!='auto' else min(ASPECTS,key=lambda a:abs(ASPECTS[a]-width/height))
    formula="""You are a photography prompt writer. Analyze the first image as visual evidence, then write a self-contained English text prompt to GENERATE A NEW IMAGE, not edit or modify that photograph. The scene reference will NOT be sent to the image generator. Describe the desired final scene completely: subject count and positions, visible pose and hand-object contact, framing, environment, available light, textures and photographic style. Do not write edit commands, 'replace source', 'keep image #1', or depend on an unseen base photograph. Do not transcribe source overlay text. Qualify uncertainty; never infer ethnicity. Apply the selected KOL, shirt, packaging and environment requirements. For new-person mode describe new fictional adult faces; for flatlay omit humans entirely. Keep selected uploaded shirts and packaging exact. Describe all other visible clothing and worn accessories from the scene reference as the final outfit, without requiring restyling. Uploaded shirts override only the corresponding source shirts; never substitute clothing from a KOL identity portrait.
Return ONLY a detailed plain-text English prompt, NOT JSON, without code fences or commentary. Begin with: Create an extremely realistic image (ultra-realistic).
Use these eleven numbered sections, with 2–4 concrete sentences per section where useful:
1. Subject: describe each selected KOL's visible facial features, hair, expression and build from the identity assets, assigned to the correct person. If no KOL is selected, follow the selected people mode.
2. Camera Angle / Framing: camera height, crop, subject positions, perspective. Always explicitly state Shot on iPhone and iPhone lifestyle photography. This is the requested output camera, regardless of the source camera. Never specify DSLR, mirrorless, film cameras, other phone brands or unsupported exact focal lengths.
3. Clothing: visually describe each selected shirt's actual color, material, cut, fit, artwork and print placement, with the correct wearer; do not merely say 'use uploaded shirt'. Other visible outfit pieces follow the scene reference.
4. Pose: visible body positions, gaze, hands and contact with props.
5. Environment: describe the final setting and selected packaging, including appearance, material, position and scale.
6. Lighting: direction, color, softness, shadows and reflections.
7. Color Palette and Atmosphere: dominant colors and visible mood.
8. Final Style: ultra-realistic iPhone lifestyle photography, natural skin and materials.
9. Important Details to Preserve: explicit asset-to-subject mapping using GENERATION image numbering below; exact KOL identity and uploaded shirt/packaging details. Describe the final new image, not instructions to edit a base photograph.
10. Negative Prompt: unwanted overlays, watermarks, distorted anatomy, swapped faces, incorrect artwork, extra limbs and artifacts.
11. Aspect Ratio: the supplied output ratio.
The first analysis image is the scene reference, NOT generation image #1. All later analysis images correspond in order to generation images #1, #2, etc. Never refer to the scene reference as a supplied generation image."""
    prompt=core.chatgpt_vision(app,formula,f'Scene size: {width}×{height}. Required output Aspect Ratio: {aspect}. Adapt framing to this output ratio while keeping all key subjects and product details in frame; do not force the source crop.\nGeneration assets and requirements:\n'+rules,[source[0]]+[raw for raw,mime in refs],max_tokens=4500)
    return {'prompt':iphone_prompt(verify_prompt(prompt,structured=True)),'format':'text','mode':'generate_new_image'}

def generate(app,body,owner):
    spec=validate(body,True);jid=body.get('request_id','')
    if not core.re.fullmatch(r'[a-f0-9-]{36}',str(jid)):raise roundup.Problem('Mã yêu cầu không hợp lệ.')
    label,model,key=PROVIDERS[spec['provider']]
    if not getattr(app,key,''):raise roundup.Problem('Chưa cấu hình '+key+' cho '+label+'.',503)
    digest=hashlib.sha256(json.dumps(spec,sort_keys=True).encode()).hexdigest()
    with core.LOCK:
        path=core.folder(app)/(jid+'.json')
        if path.exists():
            previous=core.read(app,jid,owner)
            if previous['digest']!=digest:raise roundup.Problem('Mã yêu cầu đã dùng cho nội dung khác.',409)
            return core.public(previous)
        refs,rules=references(spec)
        with Image.open(io.BytesIO(roundup.uploaded_image(spec['files']['reference'])[0])) as im:
            source_aspect=min(ASPECTS,key=lambda a:abs(ASPECTS[a]-im.width/im.height))
        job=dict(can_regenerate=True,inputs={'refs':[{'data':base64.b64encode(raw).decode(),'mime':mime} for raw,mime in refs],'rules':rules,'prompt':spec['prompt']},aspect=spec['aspect'] if spec['aspect']!='auto' else source_aspect,id=jid,owner=owner,digest=digest,mode='single',provider=spec['provider'],model=model,status='running',created=time.time(),items=[],total=1,error='',note=label+' đang tạo ảnh mới…')
        core.write(path,job);core.LIVE.add(jid)
        threading.Thread(target=run,args=(app,job,refs,rules,spec['prompt']),daemon=True).start()
        return core.public(job)

def regenerate(app,body,owner):
    if not isinstance(body,dict):raise roundup.Problem('Dữ liệu không hợp lệ.')
    jid=body.get('request_id','')
    if not core.re.fullmatch(r'[a-f0-9-]{36}',str(jid)):raise roundup.Problem('Mã yêu cầu không hợp lệ.')
    with core.LOCK:
        original=core.read(app,body.get('source_id',''),owner)
        inputs=original.get('inputs')
        if not inputs:raise roundup.Problem('Ảnh cũ chưa lưu đầu vào để tạo lại. Hãy tải ảnh đầu vào và dùng nút Tạo ảnh mới.',409)
        if original['status']=='running':raise roundup.Problem('Đợi ảnh hiện tại hoàn tất trước khi tạo lại.',409)
        digest=hashlib.sha256(('regenerate:'+original['id']).encode()).hexdigest()
        path=core.folder(app)/(jid+'.json')
        if path.exists():
            previous=core.read(app,jid,owner)
            if previous['digest']!=digest:raise roundup.Problem('Mã yêu cầu đã dùng cho nội dung khác.',409)
            return core.public(previous)
        provider=original['provider'];label,model,key=PROVIDERS[provider]
        if not getattr(app,key,''):raise roundup.Problem('Chưa cấu hình '+key,503)
        refs=[(base64.b64decode(r['data']),r['mime']) for r in inputs['refs']]
        job=dict(id=jid,owner=owner,digest=digest,mode='single',provider=provider,model=model,aspect=original['aspect'],source_id=original['id'],can_regenerate=True,inputs=inputs,status='running',created=time.time(),items=[],total=1,error='',note=label+' đang tạo lại ảnh…')
        core.write(path,job);core.LIVE.add(jid)
        threading.Thread(target=run,args=(app,job,refs,inputs['rules'],inputs['prompt']),daemon=True).start()
        return core.public(job)

def run(app,job,refs,rules,prompt):
    path=core.folder(app)/(job['id']+'.json')
    try:
        prompt=verify_prompt(prompt)
        provider=job.get('provider','gemini_pro');label,model,key=PROVIDERS[provider]
        if not getattr(app,key,''):raise roundup.Problem('Chưa cấu hình '+key,503)
        aspect=job.get('aspect','')
        if aspect not in ASPECTS:
            ratio=re.search(r'(?:Aspect Ratio|Tỉ lệ)\s*:\s*(\d+\s*:\s*\d+)',prompt,re.I)
            aspect=re.sub(r'\s','',ratio.group(1)) if ratio else ''
        if aspect not in ASPECTS:aspect=''
        final=rules+'\n\n'+prompt+'\nCAMERA REQUIREMENT (takes priority over any conflicting camera or device in the prompt): '+IPHONE_CAMERA+' Use the iPhone capture style even for regenerated images. Preserve the requested composition; do not invent artificial portrait blur or change the pose to show a phone.'
        if aspect:final+='\nOUTPUT FORMAT (takes priority over any ratio in the prompt): '+aspect+'. Compose for this frame; keep faces, shirts, prints and selected packaging fully within the frame.'
        core.write(core.folder(app)/(job['id']+'-0.audit.json'),dict(mode='generate_new_image',prompt=final,model=model,references=[hashlib.sha256(raw).hexdigest() for raw,mime in refs]))
        size=('1024x1024' if ASPECTS[aspect]==1 else '1536x1024' if ASPECTS[aspect]>1 else '1024x1536') if aspect else 'auto'
        b64=app.gen_shot(refs,final,size,provider,aspect,gem_model=model if provider=='gemini_pro' else '',lock=False,quality='high')
        raw=base64.b64decode(b64)
        with Image.open(io.BytesIO(raw)) as im:
            im.load()
            if aspect:
                aw,ah=map(int,aspect.split(':'));unit=min(im.width//aw,im.height//ah)
                if unit>0 and im.width*ah!=im.height*aw:im=ImageOps.fit(im,(unit*aw,unit*ah),method=Image.Resampling.LANCZOS)
            output=io.BytesIO();im.save(output,'PNG')
        filename=job['id']+'-0.png';(core.folder(app)/filename).write_bytes(output.getvalue())
        with core.LOCK:
            job.update(status='done',note='Ảnh đã hoàn thiện.',items=[dict(index=0,filename=filename,prompt=prompt,image='/api/choly-studio/result?id='+job['id']+'&index=0')]);core.write(path,job)
    except Exception as e:
        with core.LOCK:job.update(status='failed',error=str(e)[:600],note='Không tạo được ảnh.');core.write(path,job)
    finally:
        with core.LOCK:core.LIVE.discard(job['id'])

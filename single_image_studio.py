"""One reference → editable photography prompt → one finished image."""
import re, base64, hashlib, io, json, threading, time
from PIL import Image
import choly_studio as core
import roundup

PROMPT_OPENING='Create an extremely realistic image (ultra-realistic).'
REFUSAL_MESSAGE='ChatGPT đã từ chối yêu cầu này và chưa tạo prompt. Không có ảnh nào được tạo. Hãy kiểm tra ảnh tham chiếu và nội dung yêu cầu; phản hồi hiện tại không nêu lý do cụ thể.'
def is_refusal(text):
    return isinstance(text,str) and bool(re.search(r"(?:I(?:['’]m| am) sorry[,.]?\s*)?I\s+(?:can(?:not|['’]t)|am unable to|['’]m unable to)\s+(?:assist|help|comply|fulfill|provide|create|generate)|I must decline|I have to decline|tôi không thể (?:hỗ trợ|giúp|thực hiện)",text,re.I))
def verify_prompt(text,structured=False):
    if is_refusal(text):raise roundup.Problem(REFUSAL_MESSAGE,422)
    if not isinstance(text,str) or not text.strip():raise roundup.Problem('ChatGPT chưa trả prompt. Không có ảnh nào được tạo.',502)
    if structured:
        try: data=json.loads(text)
        except (ValueError,TypeError):raise roundup.Problem('Prompt phải là JSON hợp lệ. Hãy tạo lại prompt JSON.',422)
        if not isinstance(data,dict) or data.get('task')!='generate_new_image':raise roundup.Problem('JSON cần task: generate_new_image để tạo ảnh mới.',422)
        for key in ('subject','composition','clothing','pose','environment','lighting','camera','style','constraints','aspect_ratio'):
            if not isinstance(data.get(key),str) or not data[key].strip():raise roundup.Problem('JSON thiếu mục '+key+'.',422)
        if data['aspect_ratio'] not in ASPECTS:raise roundup.Problem('Tỉ lệ trong JSON không được hỗ trợ.',422)
        return json.dumps(data,ensure_ascii=False,indent=2)
    return text.strip()

ASPECTS={'1:1':1,'4:5':.8,'2:3':2/3,'3:4':.75,'9:16':9/16,'3:2':1.5,'4:3':4/3,'16:9':16/9}
PROVIDERS={'openai_25':('GPT Image 2.5','gpt-image-2.5-sunburst','API_KEY'),'gemini_pro':('Nano Banana Pro','gemini-3-pro-image-preview','GEMINI_API_KEY')}

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
    provider=body.get('provider','gemini_pro')
    if provider not in PROVIDERS:raise roundup.Problem('Model tạo ảnh không hợp lệ.')
    if generating:prompt=verify_prompt(prompt,structured=True)
    return dict(provider=provider,files=files,accessories=sorted(selected),kol=kol,male_position=male_position,shirts=shirts,environment_description=environment_description.strip(),prompt=prompt.strip())

def references(spec):
    # The scene reference is for ChatGPT analysis only; it must never reach generation.
    refs=[];rules=['Create a NEW photograph from the JSON scene description. No base photo is supplied. Do not edit any supplied asset into a scene; use each only for its assigned role.']
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
    else:rules.append('Use the people described in the JSON. No source photograph or exact face reference is supplied.')
    roles=('male','female') if spec['shirts']=='both' else () if spec['shirts']=='none' else (spec['shirts'],)
    for role in roles:
        add(roundup.uploaded_image(spec['files']['shirt_'+role]),f'{role.upper()} SHIRT PRODUCT ONLY. Preserve the exact supplied color, fabric, cut, print placement, artwork, logos and physical lettering including Vietnamese accents. Assign to the corresponding wearer or flatlay product. Never swap shirts, mirror lettering or transfer front print to back; ignore product model and background.')
    rules.append('CLOTHING RESTYLE: selected uploaded shirts stay unchanged and unobstructed. Describe a new coordinated outfit for other visible clothing. The female wears a simple black A-line skirt; the male wears relaxed straight-leg medium-blue denim jeans. Describe only visible portions; no added limbs or clothing props in object-only scenes. Keep bag shape, straps and hand contact physically consistent.')
    for key in spec['accessories']:
        asset,label=core.ACCESSORIES[key]
        add(roundup.uploaded_image(spec['files'][key]) if key in spec['files'] else ((core.ROOT/'public/roundup-references'/asset).read_bytes(),'image/png'),f'{label} PACKAGING ONLY. Preserve exact shape, material, physical print and branding; realistic scale, placement, perspective and contact shadows. Never transfer artwork to clothing.')
    if spec['files'].get('environment'):
        add(roundup.uploaded_image(spec['files']['environment']),'ENVIRONMENT REFERENCE ONLY. Use setting, furniture, palette and light; do not copy people, clothes, products or overlay text. Match the JSON camera and subject placement.')
    if spec['environment_description']:rules.append('USER ENVIRONMENT DESCRIPTION (takes precedence over environment image): '+spec['environment_description'])
    rules.append('One natural ultra-realistic photograph, iPhone lifestyle photography, realistic skin and material textures. No overlay text, watermarks or collage. Preserve physical product lettering only.')
    return refs,'\n'.join(rules)

def analyze(app,body):
    spec=validate(body);refs,rules=references(spec)
    source=roundup.uploaded_image(spec['files']['reference'])
    with Image.open(io.BytesIO(source[0])) as im:width,height=im.size
    aspect=min(ASPECTS,key=lambda a:abs(ASPECTS[a]-width/height))
    formula="""You are a photography prompt writer. Analyze the first image as visual evidence, then write a self-contained JSON prompt to GENERATE A NEW IMAGE, not edit or modify that photograph. The scene reference will NOT be sent to the image generator. Describe the desired final scene completely: subject count and positions, visible pose and hand-object contact, framing, environment, available light, textures and photographic style. Do not write edit commands, 'replace source', 'keep image #1', or depend on an unseen base photograph. Do not transcribe source overlay text. Qualify uncertainty; never infer ethnicity. Apply the selected KOL, shirt, packaging and environment requirements. For new-person mode describe new fictional adult faces; for flatlay omit humans entirely. Keep selected uploaded shirts and packaging exact, and restyle other visible clothing as requested.
Return ONLY a valid JSON object without fences or commentary, with task='generate_new_image' and nonempty English string fields: subject, composition, clothing, pose, environment, lighting, camera, style, constraints, aspect_ratio. Give detailed final-state descriptions, 2–4 sentences where useful. Include iPhone lifestyle photography in camera and style. In constraints describe asset assignments using GENERATION numbering below. The first analysis image is the scene reference, NOT generation image #1. All later analysis images correspond in order to generation images #1, #2, etc. Never refer to the scene reference as a supplied generation image."""
    prompt=core.chatgpt_vision(app,formula,f'Scene size: {width}×{height}. Use aspect_ratio: {aspect}.\nGeneration assets and requirements:\n'+rules,[source[0]]+[raw for raw,mime in refs],max_tokens=4500)
    return {'prompt':verify_prompt(prompt,structured=True),'format':'json','mode':'generate_new_image'}

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
        job=dict(id=jid,owner=owner,digest=digest,mode='single',provider=spec['provider'],model=model,status='running',created=time.time(),items=[],total=1,error='',note=label+' đang tạo ảnh mới…')
        core.write(path,job);core.LIVE.add(jid)
        threading.Thread(target=run,args=(app,job,refs,rules,spec['prompt']),daemon=True).start()
        return core.public(job)

def run(app,job,refs,rules,prompt):
    path=core.folder(app)/(job['id']+'.json')
    try:
        prompt=verify_prompt(prompt,structured=True)
        provider=job.get('provider','gemini_pro');label,model,key=PROVIDERS[provider]
        if not getattr(app,key,''):raise roundup.Problem('Chưa cấu hình '+key,503)
        aspect=json.loads(prompt)['aspect_ratio']
        final=rules+'\n\n'+prompt
        core.write(core.folder(app)/(job['id']+'-0.audit.json'),dict(mode='generate_new_image',prompt=final,model=model,references=[hashlib.sha256(raw).hexdigest() for raw,mime in refs]))
        b64=app.gen_shot(refs,final,'auto',provider,aspect,gem_model=model if provider=='gemini_pro' else '',lock=False,quality='high')
        raw=base64.b64decode(b64)
        with Image.open(io.BytesIO(raw)) as im:
            im.load();output=io.BytesIO();im.save(output,'PNG')
        filename=job['id']+'-0.png';(core.folder(app)/filename).write_bytes(output.getvalue())
        with core.LOCK:
            job.update(status='done',note='Ảnh đã hoàn thiện.',items=[dict(index=0,filename=filename,prompt=prompt,image='/api/choly-studio/result?id='+job['id']+'&index=0')]);core.write(path,job)
    except Exception as e:
        with core.LOCK:job.update(status='failed',error=str(e)[:600],note='Không tạo được ảnh.');core.write(path,job)
    finally:
        with core.LOCK:core.LIVE.discard(job['id'])

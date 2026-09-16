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
        sections=re.findall(r'^\s*(?:#{1,6}\s*)?(?:\*\*)?(\d{1,2})[.)]\s+',text,re.M)
        if sections!=[str(n) for n in range(1,12)]:raise roundup.Problem('ChatGPT trả nội dung chưa đủ 11 mục. Tool chưa dùng nội dung này để tạo ảnh. Bạn có thể phân tích lại hoặc nhập prompt của mình.',502)
    return text.strip()

def validate(body, generating=False):
    if not isinstance(body,dict):raise roundup.Problem('Dữ liệu không hợp lệ.')
    files=body.get('files',{})
    if not isinstance(files,dict) or set(files)-{'reference','kol','kol_male','kol_female','shirt_male','shirt_female','zip','box','tag'} or not files.get('reference'):raise roundup.Problem('Tải một ảnh tham chiếu trước.')
    if sum(len(v) if isinstance(v,str) else 99999999 for v in files.values())>41000000:raise roundup.Problem('Tổng dung lượng ảnh quá lớn.')
    for value in files.values():roundup.uploaded_image(value)
    selected=body.get('accessories',[])
    if not isinstance(selected,list) or any(k not in core.ACCESSORIES for k in selected) or len(set(selected))!=len(selected):raise roundup.Problem('Bao bì không hợp lệ.')
    kol=body.get('kol','none')
    if kol not in ('none','flatlay','male','female','upload','couple') or (kol=='upload' and not files.get('kol')):raise roundup.Problem('Chọn hoặc tải ảnh KOL.')
    male_position=body.get('male_position','auto')
    if male_position not in ('auto','left','right'):raise roundup.Problem('Vị trí KOL không hợp lệ.')
    shirts=body.get('shirts','none')
    if shirts not in ('none','male','female','both'):raise roundup.Problem('Chọn áo nam, áo nữ hoặc cả hai.')
    shirt_roles=('male','female') if shirts=='both' else () if shirts=='none' else (shirts,)
    for role in shirt_roles:
        if not files.get('shirt_'+role):raise roundup.Problem('Tải ảnh áo '+('nam' if role=='male' else 'nữ')+' đã chọn.')
    prompt=body.get('prompt','')
    if not isinstance(prompt,str) or len(prompt)>24000 or (generating and not prompt.strip()):raise roundup.Problem('Tạo hoặc nhập prompt trước khi tạo ảnh (tối đa 24000 ký tự).')
    if generating:verify_prompt(prompt)
    return dict(files=files,accessories=sorted(selected),kol=kol,male_position=male_position,shirts=shirts,prompt=prompt.strip())

def references(spec):
    refs=[roundup.uploaded_image(spec['files']['reference'])]
    rules=['Image #1 is the BASE PHOTO: preserve its actual camera angle, framing, composition, pose, expression, clothing, environment, lighting and atmosphere. Remove source overlay text and watermarks. Do not invent hidden details or copy source identity when a replacement KOL is supplied.']
    if spec['kol']=='flatlay':
        rules.append('FLATLAY / OBJECT-ONLY MODE: No KOL identity references are supplied. Recreate a product-only photograph: no people, faces, hands, bodies, mannequins or human reflections. Preserve the source camera angle, background and object arrangement; if people or hands appear in the source, remove them locally while retaining the products. Selected male/female shirts are product labels only, never instructions to add wearers. Replace corresponding visible garments with the selected shirt products, retaining their arrangement and folds.')
    elif spec['kol']=='couple':
        defaults=None
        for role in ('male','female'):
            key='kol_'+role
            if key in spec['files']:identity=roundup.uploaded_image(spec['files'][key])
            else:
                if defaults is None:defaults={p['role']:p for p in core.roundup_cast.people('couple')}
                person=defaults[role];identity=(person['file'].read_bytes(),person.get('mime','image/jpeg'))
            refs.append(identity)
            position=spec['male_position']
            target=('the corresponding visible '+role+' subject in the base photo') if position=='auto' else ('the visible subject on the viewer’s '+(position if role=='male' else ('right' if position=='left' else 'left'))+' side of the base photo')
            rules.append(f'Image #{len(refs)} is {role.upper()} KOL IDENTITY ONLY, assigned to {target}. Match this exact adult face, hair and skin features. Preserve that source subject’s position, pose, gaze, expression and clothing. Do not copy the identity portrait’s clothes or background.')
        rules.append('DUAL IDENTITY LOCK: Keep the male and female faces distinct; never swap, blend or duplicate them. Preserve both subjects’ original positions and interaction. Describe the subject-to-reference mapping explicitly in sections 1 and 9. Replace only people already visible; do not add a second person if the base photo contains only one, or add people to an object-only photo.')
    elif spec['kol'] not in ('none','flatlay'):
        if spec['kol']=='upload':identity=roundup.uploaded_image(spec['files']['kol'])
        else:
            person=next(p for p in core.roundup_cast.people('couple') if p['role']==spec['kol'])
            identity=(person['file'].read_bytes(),person.get('mime','image/jpeg'))
        refs.append(identity)
        rules.append(f'Image #{len(refs)} is KOL IDENTITY ONLY. Replace the main visible person with this exact adult face, hair and skin features; preserve source pose, expression and clothing. Do not copy the portrait background or clothing. Do not add a person to an object-only scene.')
    shirts=spec.get('shirts','none')
    shirt_roles=('male','female') if shirts=='both' else () if shirts=='none' else (shirts,)
    for role in shirt_roles:
        refs.append(roundup.uploaded_image(spec['files']['shirt_'+role]))
        rules.append(f'Image #{len(refs)} is {role.upper()} SHIRT PRODUCT ONLY. Replace only the corresponding {role} subject’s shirt with this supplied garment, following the KOL position mapping above where specified. Preserve the supplied shirt color, fabric, collar, sleeve shape, silhouette, print placement, artwork, logos and exact physical lettering including Vietnamese accents. Adapt the garment naturally to the existing body pose, folds, perspective, light and shadows. Do not copy the product model’s face or background. Never swap male and female shirt designs, blend their artwork, mirror lettering or transfer a front print to the back. In a flatlay or gift arrangement, replace the corresponding visible garment; do not add people or change the source composition to display a shirt.')
    if shirt_roles:rules.append('SELECTED SHIRT OVERRIDE: Preserve source clothing only for garments not explicitly replaced above. These selected shirt references take precedence over source clothing and KOL portrait clothing. Describe each selected shirt and its wearer/product assignment in sections 3 and 9. Keep faces and garment artwork unobstructed by packaging.')
    for key in spec['accessories']:
        asset,label=core.ACCESSORIES[key]
        refs.append(roundup.uploaded_image(spec['files'][key]) if key in spec['files'] else ((core.ROOT/'public/roundup-references'/asset).read_bytes(),'image/png'))
        rules.append(f'Image #{len(refs)} is {label} PACKAGING ONLY. Integrate this selected item naturally in the source arrangement, replacing the corresponding item if present. Preserve its shape, material, physical print and branding. Keep realistic scale, contact shadows and perspective; never transfer its artwork to clothing or faces.')
    with Image.open(io.BytesIO(refs[0][0])) as im:width,height=im.size
    rules.append(f'Source size {width}×{height}, aspect ratio {width}:{height}. Match this composition and aspect ratio as closely as the image model allows. One natural ultra-realistic photograph, no captions or added text, no collage. Only selected KOL, shirt and packaging substitutions may change source content.')
    return refs,'\n'.join(rules)

def analyze(app,body):
    spec=validate(body);refs,rules=references(spec)
    formula=core.PROMPT_FORMULA.replace('3. Clothing: supplied garment','3. Clothing: selected replacement garment if provided, otherwise source garment').replace('specify the app output is portrait 3:4','specify output should match the source aspect ratio').replace('visible people/hands required by the selected scene and the supplied identity roles','visible people/hands in the source photo')
    formula+='\nThis is a single-image workflow. There is no preset scene. If shirt product references are supplied, replace only those assigned garments; otherwise preserve source clothing. KOL portraits supply identity only, never clothing. Use the exact source dimensions in the brief for section 11; never force a 3:4 ratio. Include the numbered asset-role instructions in section 9 so this complete prompt can be used with those references.'
    formula+='\nBegin the final prompt with this exact standalone sentence, before section 1: '+PROMPT_OPENING+' Return plain text without Markdown code fences.'
    prompt=core.chatgpt_vision(app,formula,rules,[raw for raw,mime in refs])
    prompt=verify_prompt(prompt,structured=True)
    prompt=re.sub(r'^```[^\n]*\n|\n```$', '', prompt).strip()
    if not prompt.startswith(PROMPT_OPENING):prompt=PROMPT_OPENING+'\n\n'+prompt
    return {'prompt':prompt}

def generate(app,body,owner):
    spec=validate(body,True);jid=body.get('request_id','')
    if not core.re.fullmatch(r'[a-f0-9-]{36}',str(jid)):raise roundup.Problem('Mã yêu cầu không hợp lệ.')
    if not app.API_KEY:raise roundup.Problem('Chưa cấu hình OPENAI_API_KEY.',503)
    digest=hashlib.sha256(json.dumps(spec,sort_keys=True).encode()).hexdigest()
    with core.LOCK:
        path=core.folder(app)/(jid+'.json')
        if path.exists():
            previous=core.read(app,jid,owner)
            if previous['digest']!=digest:raise roundup.Problem('Mã yêu cầu đã dùng cho nội dung khác.',409)
            return core.public(previous)
        refs,rules=references(spec)
        job=dict(id=jid,owner=owner,digest=digest,mode='single',status='running',created=time.time(),items=[],total=1,error='',note='GPT Image 2.5 đang tạo ảnh…')
        core.write(path,job);core.LIVE.add(jid)
        threading.Thread(target=run,args=(app,job,refs,rules,spec['prompt']),daemon=True).start()
        return core.public(job)

def run(app,job,refs,rules,prompt):
    path=core.folder(app)/(job['id']+'.json')
    try:
        final=rules+'\n\n'+prompt
        core.write(core.folder(app)/(job['id']+'-0.audit.json'),dict(mode='single',prompt=final,model='gpt-image-2.5-sunburst',references=[hashlib.sha256(raw).hexdigest() for raw,mime in refs]))
        b64=app.gen_shot(refs,final,'auto','openai_25',lock=False,quality='high')
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

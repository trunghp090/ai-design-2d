/* General image creation, sharing the existing image engines and job queue. */
(() => {
  const root = document.getElementById('view-imagegen');
  let ready = false, refs = [], creations = [], submitting = false;
  const referenceSources = new Map(), pendingReferences = new Set();
  const el = id => root.querySelector('#ig-' + id);
  const presets = [
    ['Chân dung', 'Chân dung một cô gái Việt Nam bên cửa sổ, ánh sáng tự nhiên dịu, màu sắc chân thực, bố cục tối giản.'],
    ['Sản phẩm', 'Ảnh chụp sản phẩm chai nước hoa trên bục đá màu kem, bóng nắng nhẹ, bố cục quảng cáo cao cấp.'],
    ['Phong cảnh', 'Một căn nhà nhỏ giữa đồi chè xanh vào sáng sớm, sương mỏng, góc rộng, ảnh chụp điện ảnh.'],
    ['Minh họa', 'Minh họa một chú mèo cam ngồi trong tiệm cà phê, nét vẽ tay mềm mại, màu pastel ấm áp.']
  ];
  async function api(url, options) {
    const r = await fetch(url, {cache:'no-store', ...options}); let d;
    try { d = await r.json(); } catch { throw new Error('Máy chủ không phản hồi. Thử lại sau.'); }
    if (!r.ok) { const error = new Error(d.error || 'Không thể tải dữ liệu.'); error.status = r.status; throw error; }
    return d;
  }
  function note(t) { el('status').textContent = t; }
  function renderRefs() {
    el('refs').replaceChildren();
    refs.forEach((src, i) => {
      const card = document.createElement('div'), img = new Image(), b = document.createElement('button');
      img.src = src; img.alt = 'Ảnh tham chiếu ' + (i + 1); b.textContent = '×'; b.type = 'button'; b.setAttribute('aria-label', 'Xóa ảnh tham chiếu ' + (i + 1));
      b.onclick = () => { refs.splice(i, 1); renderRefs(); }; card.append(img, b); el('refs').append(card);
    });
    el('refcount').textContent = refs.length + '/6';
  }
  async function addFiles(files) {
    for (const f of files) {
      if (refs.length >= 6) { note('Tối đa 6 ảnh tham chiếu.'); break; }
      if (!['image/png','image/jpeg','image/webp'].includes(f.type) || f.size > 10 * 1024 * 1024) { note('Chọn ảnh PNG, JPG hoặc WebP, tối đa 10 MB mỗi ảnh.'); continue; }
      try {
        const src = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(f); });
        if (refs.length < 6) refs.push(src);
      } catch { note('Không đọc được ảnh. Vui lòng chọn lại.'); }
    }
    renderRefs();
  }
  async function useReference(src, button) {
    const originalLabel = button.textContent;
    const feedback = text => { el('refstatus').textContent = text; el('picker-status').textContent = text; };
    if (refs.includes(referenceSources.get(src))) { feedback('Ảnh này đã có trong ảnh tham chiếu.'); return; }
    if (refs.length >= 6) { feedback('Tối đa 6 ảnh tham chiếu. Xóa một ảnh trước khi thêm.'); return; }
    if (pendingReferences.has(src)) return;
    pendingReferences.add(src); button.disabled = true; button.textContent = 'Đang thêm ảnh…';
    try {
      const response = await fetch(src, {signal: AbortSignal.timeout(45000)});
      if (!response.ok) throw new Error('Không tải được ảnh. Vui lòng thử lại.');
      const blob = await response.blob();
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(blob.type) || blob.size > 10 * 1024 * 1024) {
        throw new Error('Chọn ảnh PNG, JPG hoặc WebP, tối đa 10 MB mỗi ảnh.');
      }
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob);
      });
      if (refs.includes(data)) { feedback('Ảnh này đã có trong ảnh tham chiếu.'); return; }
      if (refs.length >= 6) { feedback('Tối đa 6 ảnh tham chiếu. Xóa một ảnh trước khi thêm.'); return; }
      refs.push(data); referenceSources.set(src, data); renderRefs();
      feedback('Đã thêm ảnh vào ảnh tham chiếu.');
      if (!el('picker').open) el('refs').scrollIntoView({behavior:'smooth', block:'center'});
    } catch (error) {
      feedback(error.name === 'TimeoutError' ? 'Tải ảnh quá thời gian. Vui lòng thử lại.' : error.message || 'Không đọc được ảnh. Vui lòng thử lại.');
    } finally {
      pendingReferences.delete(src); button.disabled = false; button.textContent = originalLabel;
    }
  }
  function showReferenceLibrary() {
    el('picker-choices').hidden = true; el('picker-library').hidden = false;
    el('picker-title').textContent = 'Chọn ảnh đã tạo';
    el('picker-status').textContent = 'Đã chọn ' + refs.length + '/6 ảnh tham chiếu. Bấm vào ảnh để thêm.';
    const grid = el('picker-grid'); grid.replaceChildren();
    el('picker-empty').hidden = creations.length > 0;
    creations.forEach((c, index) => {
      const src = c.url || c.gallery?.url || 'data:image/png;base64,' + c.image;
      const card = document.createElement('div'), img = new Image(), button = document.createElement('button');
      img.src = src; img.alt = c.prompt || 'Ảnh đã tạo ' + (index + 1); img.loading = 'lazy';
      button.type = 'button';
      const update = () => {
        const selected = refs.includes(referenceSources.get(src));
        button.textContent = selected ? '✓ Đã thêm' : '＋ Chọn ảnh ' + (index + 1);
        button.disabled = selected; card.classList.toggle('ig-picked', selected);
      };
      button.onclick = async () => { await useReference(src, button); update(); };
      img.onclick = () => { if (!button.disabled) button.click(); };
      update(); card.append(img, button); grid.append(card);
    });
  }
  function render() {
    el('results').replaceChildren(); el('empty').hidden = creations.length > 0; el('total').textContent = creations.length;
    creations.forEach(c => {
      const card = document.createElement('article'), img = new Image(), link = document.createElement('button'), p = document.createElement('p'), actions = document.createElement('div'), download = document.createElement('a'), reuse = document.createElement('button'), reference = document.createElement('button');
      const src = c.url || c.gallery?.url || 'data:image/png;base64,' + c.image;
      img.src = src; img.alt = c.prompt || 'Ảnh đã tạo'; img.loading = 'lazy'; link.type = 'button'; link.className = 'ig-image-preview'; link.setAttribute('aria-label', 'Phóng to ảnh đã tạo'); link.append(img);
      link.onclick = () => { el('preview-image').src = src; el('preview').showModal(); };
      p.textContent = c.prompt; p.title = c.prompt; download.href = src; download.download = (c.id || c.gallery?.id || 'anh-ai') + '.png'; download.textContent = '↓ Tải ảnh'; reuse.textContent = 'Dùng prompt'; reuse.type = 'button';
      reuse.onclick = () => { el('prompt').value = c.prompt || ''; const g = c.generation || c; if (g.engine) el('engine').value = g.engine; if (g.aspect) el('aspect').value = g.aspect; el('prompt').focus(); };
      reference.type = 'button'; reference.className = 'ig-use-reference'; reference.textContent = '＋ Dùng làm ảnh tham chiếu';
      reference.onclick = () => useReference(src, reference);
      actions.append(download, reuse, reference); card.append(link, p, actions); el('results').append(card);
    });
  }
  async function history() {
    try { const d = await api('/api/gallery'); creations = (d.items || []).filter(c => c.mode === 'imagegen'); render(); }
    catch (e) { note(e.message); }
  }
  const jobs = new Map(), polling = new Set();
  function saveJobs() {
    try {
      sessionStorage.setItem('image-studio-jobs', JSON.stringify([...jobs.values()].filter(j => !j.finished)));
      sessionStorage.removeItem('image-studio-job');
    } catch { /* Generation remains usable when browser storage is unavailable. */ }
  }
  function renderJobs() {
    el('jobs').replaceChildren();
    for (const job of [...jobs.values()].reverse()) {
      const card = document.createElement('article'), title = document.createElement('strong'), prompt = document.createElement('p'), status = document.createElement('p');
      title.textContent = job.label; prompt.textContent = job.prompt || 'Phiên tạo ảnh trước'; prompt.className = 'ig-job-prompt'; prompt.title = job.prompt || '';
      status.textContent = job.status || 'Đang tạo ảnh…'; card.append(title, prompt, status);
      if (job.paused && !job.finished) {
        const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Tiếp tục kiểm tra';
        retry.onclick = () => poll(job.id); card.append(retry);
      }
      el('jobs').append(card);
    }
  }
  async function poll(id) {
    const job = jobs.get(id);
    if (!job || job.finished || polling.has(id)) return;
    polling.add(id); job.paused = false; renderJobs();
    try {
      while (true) {
        const d = await api('/api/batch-status?id=' + encodeURIComponent(id), {signal:AbortSignal.timeout(45000)});
        const items = (d.items || []).map((c, i) => ({...c, id: c.gallery?.id || c.id || id + '_' + i}));
        const fresh = items.filter(n => !creations.some(c => c.id === n.id));
        if (fresh.length) { creations = [...fresh, ...creations]; render(); }
        const failed = d.errors?.length || 0, succeeded = items.length;
        job.status = (d.finished ? 'Hoàn tất: ' : 'Đang tạo: ') + succeeded + '/' + d.total + ' ảnh thành công.' + (failed ? ' ' + failed + ' ảnh thất bại.\n' + [...new Set(d.errors)].join('\n') : '');
        job.finished = !!d.finished; saveJobs(); renderJobs();
        if (job.finished) break;
        await new Promise(r => setTimeout(r, 2500));
      }
    } catch (e) {
      if (e.status === 404) {
        job.finished = true; job.status = 'Phiên tạo không còn trên máy chủ. Đã tải lại thư viện; kiểm tra ảnh trước khi tạo tiếp.';
        await history();
      } else {
        job.paused = true;
        job.status = (e.name === 'TimeoutError' ? 'Kiểm tra tiến trình quá thời gian; ảnh có thể vẫn đang được tạo.' : e.message) + ' Bấm “Tiếp tục kiểm tra” để theo dõi lượt này.';
      }
      saveJobs(); renderJobs();
    } finally { polling.delete(id); }
  }
  async function submitGeneration(e) {
    e.preventDefault(); if (submitting || !el('engine').value || !el('prompt').value.trim()) return;
    const payload = {prompt:el('prompt').value.trim(), engine:el('engine').value, aspect:el('aspect').value, count:Number(el('count').value), images:[...refs]};
    submitting = true; el('run').disabled = true; el('run').textContent = 'Đang gửi yêu cầu…'; note('Đang gửi yêu cầu…');
    try {
      const d = await api('/api/image-studio/generate', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
      const job = {id:d.job_id, label:'Lượt ' + (jobs.size + 1), prompt:payload.prompt, finished:false, paused:false, status:'Đang tạo: 0/' + payload.count + ' ảnh thành công.'};
      jobs.set(job.id, job); saveJobs(); renderJobs();
      note('Đã gửi ' + job.label.toLowerCase() + '. Bạn có thể tiếp tục tạo lượt mới.');
      void poll(job.id);
    } catch (e) { note(e.message); }
    finally { submitting = false; el('run').disabled = !el('engine').value; el('run').textContent = '✦ Tạo ảnh'; }
  }
  function restoreJobs() {
    try {
      const saved = JSON.parse(sessionStorage.getItem('image-studio-jobs') || '[]');
      if (Array.isArray(saved)) for (const job of saved) {
        if (job && typeof job.id === 'string' && !job.finished) jobs.set(job.id, {...job, paused:false});
      }
      const legacy = sessionStorage.getItem('image-studio-job');
      if (legacy && !jobs.has(legacy)) jobs.set(legacy, {id:legacy, label:'Lượt trước', finished:false});
    } catch { /* Ignore malformed local state. */ }
    saveJobs(); renderJobs();
    for (const id of jobs.keys()) void poll(id);
  }
  window.initImageStudio = async () => {
    if (ready) return; ready = true;
    root.innerHTML = `<div class="ig-heading"><div><span>IMAGE STUDIO</span><h1>Từ ý tưởng đến hình ảnh.</h1><p>Viết điều bạn tưởng tượng. Tạo theo cách của bạn.</p></div><span class="ig-badge">✦ AI Image Generator</span></div>
    <div class="ig-layout"><aside class="ig-controls"><form id="ig-form"><h2>✦ Tạo ảnh</h2><label for="ig-engine">Model</label><select id="ig-engine" class="input"><option value="">Đang tải model…</option></select>
    <label for="ig-prompt">Prompt <span>Mô tả hình ảnh</span></label><textarea id="ig-prompt" class="input" rows="7" maxlength="12000" required placeholder="Một bức ảnh, một ý tưởng, một thế giới mới…"></textarea>
    <div class="ig-label">Ảnh tham chiếu <span id="ig-refcount">0/6</span></div><div id="ig-refs"></div><p id="ig-refstatus" role="status" aria-live="polite"></p><button type="button" id="ig-drop" aria-haspopup="dialog">＋ Thêm ảnh tham chiếu<small>Tải ảnh lên hoặc dùng ảnh đã tạo</small></button><input id="ig-files" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden>
    <div class="ig-options"><div><label for="ig-aspect">Tỉ lệ</label><select id="ig-aspect" class="input">${['1:1','4:5','2:3','3:4','9:16','3:2','4:3','16:9'].map(a => `<option>${a}</option>`).join('')}</select></div><div><label for="ig-count">Số ảnh</label><select id="ig-count" class="input"><option>1</option><option>2</option><option>4</option></select></div></div>
    <button class="btn-primary" id="ig-run" disabled>✦ Tạo ảnh</button><p class="ig-run-hint">Có thể gửi lượt mới khi các lượt trước đang tạo.</p><p id="ig-status" role="status" aria-live="polite"></p></form></aside>
    <section class="ig-gallery"><header><h2>Ảnh đã tạo <span id="ig-total">0</span></h2><div><button id="ig-grid" title="Xem dạng lưới" aria-pressed="true">▦</button><button id="ig-list" title="Xem dạng danh sách" aria-pressed="false">☰</button><button id="ig-refresh" title="Tải lại thư viện">↻</button></div></header><div id="ig-jobs" aria-live="polite"></div><div id="ig-results"></div>
    <div id="ig-empty"><div class="ig-spark">✦</div><h2>Ý tưởng tiếp theo của bạn là gì?</h2><p>Nhập prompt hoặc bắt đầu từ một gợi ý bên dưới.<br>Ảnh bạn tạo sẽ được lưu tại đây.</p><div id="ig-presets"></div></div></section></div>
    <dialog id="ig-picker" aria-labelledby="ig-picker-title"><header><h2 id="ig-picker-title">Thêm ảnh tham chiếu</h2><button type="button" id="ig-picker-close" aria-label="Đóng chọn ảnh">×</button></header>
    <div id="ig-picker-choices"><button type="button" id="ig-picker-upload"><strong>↑ Tải ảnh lên</strong><span>Chọn ảnh từ thiết bị của bạn</span></button><button type="button" id="ig-picker-created"><strong>▦ Dùng ảnh đã tạo</strong><span>Chọn ảnh trong thư viện của bạn</span></button></div>
    <div id="ig-picker-library" hidden><button type="button" id="ig-picker-back">← Chọn nguồn ảnh khác</button><p id="ig-picker-status" role="status" aria-live="polite"></p><p id="ig-picker-empty" hidden>Chưa có ảnh đã tạo. Bạn có thể quay lại để tải ảnh lên.</p><div id="ig-picker-grid"></div><button type="button" id="ig-picker-done">Xong</button></div></dialog>
    <dialog id="ig-preview" aria-label="Xem ảnh phóng to"><button type="button" id="ig-preview-close" aria-label="Đóng ảnh phóng to">×</button><img id="ig-preview-image" alt="Ảnh đã tạo phóng to"></dialog>`;
    presets.forEach(([label, prompt], i) => { const b = document.createElement('button'); b.className = 'ig-preset ig-preset-' + i; b.innerHTML = `<span>${['◉','◇','△','✿'][i]}</span>${label}<small>Thử ý tưởng ↗</small>`; b.onclick = () => { el('prompt').value = prompt; el('prompt').focus(); }; el('presets').append(b); });
    el('preview-close').onclick = () => el('preview').close();
    el('preview').addEventListener('close', () => el('preview-image').removeAttribute('src'));
    const showReferenceChoices = () => {
      el('picker-title').textContent = 'Thêm ảnh tham chiếu';
      el('picker-choices').hidden = false; el('picker-library').hidden = true;
    };
    el('drop').onclick = () => { showReferenceChoices(); el('picker').showModal(); };
    el('picker-close').onclick = el('picker-done').onclick = () => el('picker').close();
    el('picker-back').onclick = showReferenceChoices;
    el('picker-upload').onclick = () => { el('picker').close(); el('files').click(); };
    el('picker-created').onclick = showReferenceLibrary;
    el('files').onchange = async e => { await addFiles([...e.target.files]); e.target.value = ''; };
    el('drop').ondragover = e => { e.preventDefault(); };
    el('drop').ondrop = e => { e.preventDefault(); addFiles([...e.dataTransfer.files]); };
    el('refresh').onclick = history;
    for (const v of ['grid','list']) el(v).onclick = () => { el('results').classList.toggle('ig-list', v === 'list'); for (const k of ['grid','list']) el(k).setAttribute('aria-pressed', String(k === v)); };
    el('form').onsubmit = submitGeneration;
    await history();
    try { const d = await api('/api/engines'); el('engine').replaceChildren(); (d.engines || []).forEach(e => { const o = new Option(e.label + (e.available ? '' : ' · Chưa có key'), e.id); o.disabled = !e.available; el('engine').add(o); }); const available = d.engines.filter(e => e.available); el('engine').value = available.find(e => e.id === d.default_engine)?.id || available[0]?.id || ''; el('run').disabled = !available.length; if (!available.length) note('Chưa có model khả dụng. Cấu hình API key trước khi tạo ảnh.'); }
    catch (e) { note(e.message); }
    restoreJobs();
  };
})();

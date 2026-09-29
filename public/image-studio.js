/* General image creation, sharing the existing image engines and job queue. */
(() => {
  const root = document.getElementById('view-imagegen');
  let ready = false, refs = [], creations = [], busy = false;
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
  async function poll(id) {
    busy = true; el('run').disabled = true; el('run').textContent = '✦ Đang tạo ảnh…';
    try {
      while (true) {
        const d = await api('/api/batch-status?id=' + encodeURIComponent(id), {signal:AbortSignal.timeout(45000)});
        const items = (d.items || []).map(c => ({...c, id: c.gallery?.id}));
        creations = [...items, ...creations.filter(c => !items.some(n => n.id === c.id))]; render();
        const failed = d.errors?.length || 0, succeeded = (d.items || []).length;
        note((d.finished ? 'Hoàn tất: ' : 'Đang tạo: ') + succeeded + '/' + d.total + ' ảnh thành công.' + (failed ? ' ' + failed + ' ảnh thất bại.\n' + [...new Set(d.errors)].join('\n') : ''));
        if (d.finished) { sessionStorage.removeItem('image-studio-job'); break; }
        await new Promise(r => setTimeout(r, 2500));
      }
    } catch (e) { if(e.status===404){sessionStorage.removeItem('image-studio-job');await history();note('Phiên tạo trước đã kết thúc hoặc máy chủ đã khởi động lại. Thư viện đã được tải lại; kiểm tra ảnh trước khi tạo tiếp.');el('resume').hidden=true;}else{note((e.name==='TimeoutError'?'Kiểm tra tiến trình quá thời gian; ảnh có thể vẫn đang được tạo.':e.message) + ' Bấm “Tiếp tục kiểm tra” để xem tiến trình.');el('resume').hidden=false;} }
    finally { busy = false; el('run').disabled = !el('engine').value; el('run').textContent = '✦ Tạo ảnh'; }
  }
  window.initImageStudio = async () => {
    if (ready) return; ready = true;
    root.innerHTML = `<div class="ig-heading"><div><span>IMAGE STUDIO</span><h1>Từ ý tưởng đến hình ảnh.</h1><p>Viết điều bạn tưởng tượng. Tạo theo cách của bạn.</p></div><span class="ig-badge">✦ AI Image Generator</span></div>
    <div class="ig-layout"><aside class="ig-controls"><form id="ig-form"><h2>✦ Tạo ảnh</h2><label for="ig-engine">Model</label><select id="ig-engine" class="input"><option value="">Đang tải model…</option></select>
    <label for="ig-prompt">Prompt <span>Mô tả hình ảnh</span></label><textarea id="ig-prompt" class="input" rows="7" maxlength="12000" required placeholder="Một bức ảnh, một ý tưởng, một thế giới mới…"></textarea>
    <div class="ig-label">Ảnh tham chiếu <span id="ig-refcount">0/6</span></div><div id="ig-refs"></div><p id="ig-refstatus" role="status" aria-live="polite"></p><button type="button" id="ig-drop" aria-haspopup="dialog">＋ Thêm ảnh tham chiếu<small>Tải ảnh lên hoặc dùng ảnh đã tạo</small></button><input id="ig-files" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden>
    <div class="ig-options"><div><label for="ig-aspect">Tỉ lệ</label><select id="ig-aspect" class="input">${['1:1','4:5','2:3','3:4','9:16','3:2','4:3','16:9'].map(a => `<option>${a}</option>`).join('')}</select></div><div><label for="ig-count">Số ảnh</label><select id="ig-count" class="input"><option>1</option><option>2</option><option>4</option></select></div></div>
    <button class="btn-primary" id="ig-run" disabled>✦ Tạo ảnh</button><p id="ig-status" role="status" aria-live="polite"></p><button type="button" id="ig-resume" hidden>Tiếp tục kiểm tra</button></form></aside>
    <section class="ig-gallery"><header><h2>Ảnh đã tạo <span id="ig-total">0</span></h2><div><button id="ig-grid" title="Xem dạng lưới" aria-pressed="true">▦</button><button id="ig-list" title="Xem dạng danh sách" aria-pressed="false">☰</button><button id="ig-refresh" title="Tải lại thư viện">↻</button></div></header><div id="ig-results"></div>
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
    el('resume').onclick = () => { const id = sessionStorage.getItem('image-studio-job'); if (id && !busy) { el('resume').hidden = true; poll(id); } };
    el('form').onsubmit = async e => {
      e.preventDefault(); if (busy || !el('prompt').value.trim()) return;
      busy = true; el('run').disabled = true; note('Đang gửi yêu cầu…');
      try { const d = await api('/api/image-studio/generate', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({prompt:el('prompt').value.trim(), engine:el('engine').value, aspect:el('aspect').value, count:Number(el('count').value), images:[...refs]})}); sessionStorage.setItem('image-studio-job', d.job_id); await poll(d.job_id); }
      catch (e) { note(e.message); busy = false; el('run').disabled = false; }
    };
    await history();
    try { const d = await api('/api/engines'); el('engine').replaceChildren(); (d.engines || []).forEach(e => { const o = new Option(e.label + (e.available ? '' : ' · Chưa có key'), e.id); o.disabled = !e.available; el('engine').add(o); }); const available = d.engines.filter(e => e.available); el('engine').value = available.find(e => e.id === d.default_engine)?.id || available[0]?.id || ''; el('run').disabled = !available.length; if (!available.length) note('Chưa có model khả dụng. Cấu hình API key trước khi tạo ảnh.'); }
    catch (e) { note(e.message); }
    const job = sessionStorage.getItem('image-studio-job'); if (job) poll(job);
  };
})();

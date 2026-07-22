"use strict";
const $ = (id) => document.getElementById(id);
let currentDesign = null; // base64 (không data: prefix) của design hiện tại
let lastCloneSource = null; // ảnh GỐC (data URL/url) dùng để clone -> đối chiếu

/* ---------- kiểm tra đăng nhập (chưa thì sang /auth.html) ---------- */
fetch("/api/me").then(r => r.json().then(d => ({ ok: r.ok, d }))).then(({ ok, d }) => {
  fetch("/api/status").then(r => r.json()).then(s => {
    if (s.auth_required && !ok) { location.href = "/auth.html"; return; }
    if (ok && d.user) {
      const box = document.getElementById("userBox");
      if (box) {
        box.classList.remove("hidden");
        document.getElementById("userEmail").textContent = d.user.email;
      }
    }
  });
}).catch(() => {});
$("logoutBtn") && ($("logoutBtn").onclick = async () => {
  await fetch("/api/logout", { method: "POST" });
  location.href = "/auth.html";
});

/* ---------- trạng thái ---------- */
fetch("/api/status").then(r => r.json()).then(s => {
  const pill = $("statusPill");
  if (s.mock) { pill.textContent = "● MOCK — chưa cắm key"; pill.className = "status-pill mock"; }
  else { pill.textContent = "● Live · " + s.model; pill.className = "status-pill live"; }
  if (!s.pillow) $("printRes").title = "Chưa có Pillow — sẽ tải nguyên bản";
}).catch(() => { $("statusPill").textContent = "● mất kết nối"; });

/* ---------- tabs nhập ảnh ---------- */
document.querySelectorAll(".tab").forEach(t => t.onclick = () => {
  document.querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
  t.classList.add("active");
  $("pane-url").classList.toggle("hidden", t.dataset.tab !== "url");
  $("pane-upload").classList.toggle("hidden", t.dataset.tab !== "upload");
});

/* ---------- upload file ---------- */
let uploaded = [];
const fileToDataURL = (f) => new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); });

/* ---- DÁN ẢNH dùng chung: Clipboard API + chuột phải + thông báo nhỏ ---- */
function toast(msg, ok) {
  if (typeof loadTaskAdd === "function") { const id = loadTaskAdd(msg); loadTaskDone(id, ok !== false, msg); }
}
async function clipboardImageDataURL() {
  try {
    if (!navigator.clipboard || !navigator.clipboard.read) return null;
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const type = it.types.find(t => t.startsWith("image/"));
      if (type) { const blob = await it.getType(type); return await fileToDataURL(blob); }
    }
  } catch (e) {}
  return null;
}
// gắn CHUỘT PHẢI -> dán ảnh cho 1 vùng (dropzone). onImage(dataURL).
function attachContextPaste(el, onImage) {
  if (!el || el._ctxPaste) return; el._ctxPaste = true;
  el.addEventListener("contextmenu", async (e) => {
    e.preventDefault();
    const durl = await clipboardImageDataURL();
    if (durl) onImage(durl);
    else toast("Chuột phải dán: clipboard chưa có ảnh — copy 1 ảnh trước.", false);
  });
}
// UNIVERSAL: mọi .dropzone đều có CHUỘT PHẢI dán + nút 📋 Dán (route qua file input có sẵn)
function attachUniversalPaste() {
  document.querySelectorAll(".dropzone").forEach(dz => {
    if (dz._uPaste) return; dz._uPaste = true;
    const input = dz.querySelector('input[type="file"]');
    const doPaste = async () => {
      const durl = await clipboardImageDataURL();
      if (!durl) { toast("Clipboard chưa có ảnh — copy 1 ảnh trước.", false); return; }
      if (!input) { toast("Vùng này chưa hỗ trợ dán tự động — dùng Ctrl+V.", false); return; }
      try {
        const blob = await (await fetch(durl)).blob();
        const file = new File([blob], "pasted.png", { type: blob.type || "image/png" });
        const dt = new DataTransfer(); dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        toast("✓ Đã dán ảnh");
      } catch (e) { toast("Trình duyệt chặn dán tự động — thử Ctrl+V.", false); }
    };
    dz.addEventListener("contextmenu", (e) => { e.preventDefault(); doPaste(); });
    // chèn nút 📋 Dán ngay dưới (trừ khi đã có sẵn nút paste-btn)
    const nxt = dz.nextElementSibling;
    if (!(nxt && nxt.classList && nxt.classList.contains("paste-btn"))) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "btn-ghost sm paste-btn";
      b.textContent = "📋 Dán ảnh"; b.style.cssText = "margin-top:6px;width:100%";
      b.onclick = doPaste;
      dz.insertAdjacentElement("afterend", b);
    }
  });
}
async function addFiles(files) {
  for (const f of files) {
    if (!f.type.startsWith("image/") || uploaded.length >= 4) continue;
    uploaded.push(await fileToDataURL(f));
  }
  cropIndex = uploaded.length - 1; // hiện ảnh mới nhất để khoanh vùng
  renderThumbs();
  showCrop();
}
function renderThumbs() {
  const row = $("thumbRow"); row.innerHTML = "";
  uploaded.forEach((src, i) => {
    const d = document.createElement("div"); d.className = "thumb";
    if (i === cropIndex) d.style.outline = "2px solid var(--violet)";
    d.innerHTML = `<img src="${src}"><button title="xoá">×</button>`;
    d.querySelector("img").onclick = () => { cropIndex = i; showCrop(); renderThumbs(); };
    d.querySelector("button").onclick = (e) => {
      e.stopPropagation();
      uploaded.splice(i, 1);
      if (cropIndex >= uploaded.length) cropIndex = Math.max(0, uploaded.length - 1);
      renderThumbs(); showCrop();
    };
    row.appendChild(d);
  });
}
$("fileInput").onchange = (e) => addFiles(e.target.files);

/* ---------- khoanh vùng (crop) ---------- */
let cropIndex = 0;
let crop = { x: 30, y: 22, w: 40, h: 34 }; // phần trăm
function showCrop() {
  if (!uploaded.length) { $("cropArea").classList.add("hidden"); return; }
  cropIndex = Math.min(cropIndex, uploaded.length - 1);
  $("cropImg").src = uploaded[cropIndex];
  $("cropArea").classList.remove("hidden");
  applyCrop();
}
function applyCrop() {
  const b = $("cropBox");
  b.style.left = crop.x + "%"; b.style.top = crop.y + "%";
  b.style.width = crop.w + "%"; b.style.height = crop.h + "%";
}
(function initCrop() {
  const cbox = $("cropBox"), cstage = $("cropStage"), ch = $("cropHandle");
  let cd = null, cr = null;
  cbox.addEventListener("pointerdown", e => {
    if (e.target.id === "cropHandle") return;
    e.preventDefault();
    cd = { r: cstage.getBoundingClientRect(), sx: e.clientX, sy: e.clientY, x0: crop.x, y0: crop.y };
    cbox.setPointerCapture(e.pointerId);
  });
  cbox.addEventListener("pointermove", e => {
    if (!cd) return;
    crop.x = Math.max(0, Math.min(100 - crop.w, cd.x0 + (e.clientX - cd.sx) / cd.r.width * 100));
    crop.y = Math.max(0, Math.min(100 - crop.h, cd.y0 + (e.clientY - cd.sy) / cd.r.height * 100));
    applyCrop();
  });
  cbox.addEventListener("pointerup", () => cd = null);
  ch.addEventListener("pointerdown", e => {
    e.preventDefault(); e.stopPropagation();
    cr = { r: cstage.getBoundingClientRect(), sx: e.clientX, sy: e.clientY, w0: crop.w, h0: crop.h };
    ch.setPointerCapture(e.pointerId);
  });
  ch.addEventListener("pointermove", e => {
    if (!cr) return;
    crop.w = Math.max(8, Math.min(100 - crop.x, cr.w0 + (e.clientX - cr.sx) / cr.r.width * 100));
    crop.h = Math.max(8, Math.min(100 - crop.y, cr.h0 + (e.clientY - cr.sy) / cr.r.height * 100));
    applyCrop();
  });
  ch.addEventListener("pointerup", () => cr = null);
})();
function croppedDataURL() {
  return new Promise(res => {
    const img = new Image();
    img.onload = () => {
      const nw = img.naturalWidth, nh = img.naturalHeight;
      const sx = crop.x / 100 * nw, sy = crop.y / 100 * nh;
      const sw = crop.w / 100 * nw, sh = crop.h / 100 * nh;
      const scale = Math.max(1, 1024 / Math.max(sw, sh)); // phóng to logo nhỏ
      const cw = Math.round(sw * scale), chh = Math.round(sh * scale);
      const c = document.createElement("canvas"); c.width = cw; c.height = chh;
      const ctx = c.getContext("2d"); ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, cw, chh);
      res(c.toDataURL("image/png"));
    };
    img.src = uploaded[cropIndex];
  });
}
const dz = $("dropzone");
["dragover", "dragenter"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add("drag"); }));
["dragleave", "drop"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove("drag"); }));
dz.addEventListener("drop", e => addFiles(e.dataTransfer.files));

/* ---------- tạo design ---------- */
/* ---------- xem & sửa prompt gửi AI ---------- */
async function refreshPromptPreview() {
  try {
    const r = await fetch("/api/preview-prompt", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: $("mode").value, prompt: $("promptInput").value, transparent: $("transparent").checked }),
    });
    const d = await r.json();
    if (r.ok) $("promptPreview").value = d.prompt;
  } catch (e) { /* im lặng */ }
}
$("promptTool").addEventListener("toggle", () => {
  if ($("promptTool").open && !$("useCustomPrompt").checked) refreshPromptPreview();
});
$("rebuildPrompt").onclick = () => { $("useCustomPrompt").checked = false; refreshPromptPreview(); };
["mode", "transparent"].forEach(id => $(id).addEventListener("change", () => { if (!$("useCustomPrompt").checked) refreshPromptPreview(); }));
$("promptInput").addEventListener("input", () => { if (!$("useCustomPrompt").checked) refreshPromptPreview(); });

$("generateBtn").onclick = async () => {
  const urls = $("urlInput").value.split("\n").map(s => s.trim()).filter(Boolean);
  const note = $("genNote"); note.className = "gen-note"; note.textContent = "";
  if (!uploaded.length && !urls.length) { note.className = "gen-note err"; note.textContent = "⚠️ Hãy nhập URL hoặc tải lên ít nhất 1 ảnh áo."; return; }
  // áp dụng khoanh vùng: chỉ gửi vùng design đã chọn (phóng to)
  let upl = [...uploaded];
  const cropOn = $("cropEnable").checked && uploaded.length && !$("cropArea").classList.contains("hidden");
  if (cropOn) { try { upl[cropIndex] = await croppedDataURL(); } catch (e) { /* dùng ảnh gốc */ } }
  const images = [...upl, ...urls];
  lastCloneSource = images[0] || null;   // ảnh gốc để đối chiếu sau khi tách nền

  const btn = $("generateBtn"); btn.disabled = true;
  $("emptyState").classList.add("hidden");
  $("resultImgWrap").classList.add("hidden");
  $("resultActions").classList.add("hidden");
  $("spinner").classList.remove("hidden");

  const applyResult = (data) => {
    showDesign(data.image);
    if (data.prompt) $("promptPreview").value = data.prompt;
    note.className = "gen-note ok";
    note.textContent = data.mock ? "✓ Đã tạo (MOCK). Cắm key để dùng AI thật." : "✓ Tạo design thành công!";
    loadGallery();
  };
  try {
    const r = await fetch("/api/generate-async", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        images, mode: $("mode").value, prompt: $("promptInput").value,
        size: $("size").value, transparent: $("transparent").checked,
        override_prompt: $("useCustomPrompt").checked ? $("promptPreview").value : "",
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Lỗi không xác định");
    if (data.image) { applyResult(data); }         // extract/mock: có ngay
    else if (data.job_id) {                         // gen AI: chạy nền -> poll (không lo 502)
      const res = await clonePollJob(data.job_id);
      applyResult(res);
    } else throw new Error("Phản hồi không hợp lệ");
  } catch (err) {
    note.className = "gen-note err"; note.textContent = "✗ " + err.message;
    $("emptyState").classList.remove("hidden");
  } finally {
    $("spinner").classList.add("hidden"); btn.disabled = false;
  }
};
// Poll job clone tới khi xong -> trả {image,prompt,gallery} hoặc throw lỗi
function clonePollJob(jobId) {
  return new Promise((resolve, reject) => {
    const timer = setInterval(async () => {
      try {
        const d = await (await fetch("/api/batch-status?id=" + encodeURIComponent(jobId))).json();
        if (d.finished) {
          clearInterval(timer);
          if ((d.items || []).length) resolve(d.items[0]);
          else reject(new Error((d.errors && d.errors[0]) || "Tạo design lỗi."));
        }
      } catch (e) { /* thử lại lần sau */ }
    }, 2500);
  });
}

function showDesign(b64) {
  currentDesign = b64;
  const src = "data:image/png;base64," + b64;
  $("resultImg").src = src;
  $("designOnShirt").src = src;
  $("resultImgWrap").classList.remove("hidden");
  $("resultActions").classList.remove("hidden");
  $("textTool").classList.remove("hidden");
  $("emptyState").classList.add("hidden");
  if ($("cloneCheckBtn")) $("cloneCheckBtn").classList.toggle("hidden", !lastCloneSource);
  if (textState.text.trim()) { $("resultImg").onload = positionTextLayer; }
}
// AI đối chiếu mẫu gốc vs kết quả tách nền -> vẽ lại cho khớp
if ($("cloneCheckBtn")) $("cloneCheckBtn").onclick = async () => {
  const note = $("cloneCheckNote");
  if (!lastCloneSource || !currentDesign) { note.className = "gen-note err"; note.textContent = "⚠️ Cần ảnh gốc đã tải lên + kết quả."; return; }
  const btn = $("cloneCheckBtn"), old = btn.textContent; btn.disabled = true; btn.textContent = "⏳ Đang đối chiếu…";
  note.className = "gen-note"; note.textContent = "AI đang so sánh mẫu gốc với kết quả & vẽ lại cho khớp…";
  try {
    const r = await fetch("/api/clone-check", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ original: lastCloneSource, result: "data:image/png;base64," + currentDesign, size: $("size").value }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Lỗi đối chiếu");
    showDesign(d.image);
    loadGallery();
    const diffs = (d.differences || []);
    note.className = "gen-note ok";
    note.innerHTML = "✓ Đã đối chiếu & sửa lại cho khớp mẫu gốc." +
      (diffs.length ? "<br>Đã chỉnh: " + diffs.slice(0, 6).map(x => "• " + x).join("  ") : "");
  } catch (err) {
    note.className = "gen-note err"; note.textContent = "✗ " + err.message;
  } finally { btn.disabled = false; btn.textContent = old; }
};

/* ---------- chèn chữ sắc nét (canvas, không qua AI) ---------- */
const textState = { fx: 0.5, fy: 0.72, sizePct: 7, font: "'Dancing Script', cursive", color: "#ffffff", italic: true, text: "" };
const textLayer = () => $("textLayer");
function primaryFamily(f) { const m = f.match(/'([^']+)'/); return m ? "'" + m[1] + "'" : f; }
function positionTextLayer() {
  const s = $("resultStage").getBoundingClientRect();
  const i = $("resultImg").getBoundingClientRect();
  if (!i.width) return;
  const L = textLayer();
  L.style.left = ((i.left - s.left) + textState.fx * i.width) + "px";
  L.style.top = ((i.top - s.top) + textState.fy * i.height) + "px";
  L.style.fontSize = (textState.sizePct / 100 * i.width) + "px";
}
function updateText() {
  const L = textLayer();
  $("textLayerSpan").textContent = textState.text || "Mẹ Kẽ Chuối";
  L.style.fontFamily = textState.font;
  L.style.color = textState.color;
  L.style.fontStyle = textState.italic ? "italic" : "normal";
  positionTextLayer();
}
function showTextLayer(on) { textLayer().classList.toggle("hidden", !on); if (on) updateText(); }

$("txtContent").oninput = (e) => { textState.text = e.target.value; showTextLayer(!!textState.text.trim()); };
$("txtFont").onchange = (e) => { textState.font = e.target.value; updateText(); };
$("txtColor").oninput = (e) => { textState.color = e.target.value; updateText(); };
$("txtSize").oninput = (e) => { textState.sizePct = +e.target.value; updateText(); };
$("txtItalic").oninput = (e) => { textState.italic = e.target.value === "1"; updateText(); };

(function initTextDrag() {
  const L = textLayer(); let td = null;
  L.addEventListener("pointerdown", e => { e.preventDefault(); td = $("resultImg").getBoundingClientRect(); L.setPointerCapture(e.pointerId); });
  L.addEventListener("pointermove", e => {
    if (!td) return;
    textState.fx = Math.max(0, Math.min(1, (e.clientX - td.left) / td.width));
    textState.fy = Math.max(0, Math.min(1, (e.clientY - td.top) / td.height));
    positionTextLayer();
  });
  L.addEventListener("pointerup", () => td = null);
})();

$("applyText").onclick = async () => {
  if (!currentDesign || !textState.text.trim()) { alert("Hãy gõ chữ trước nhé."); return; }
  try { await document.fonts.load(`${textState.italic ? "italic " : ""}80px ${primaryFamily(textState.font)}`); } catch (e) {}
  const img = new Image();
  await new Promise(r => { img.onload = r; img.src = "data:image/png;base64," + currentDesign; });
  const nw = img.naturalWidth, nh = img.naturalHeight;
  const c = document.createElement("canvas"); c.width = nw; c.height = nh;
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  ctx.font = `${textState.italic ? "italic " : ""}${textState.sizePct / 100 * nw}px ${textState.font}`;
  ctx.fillStyle = textState.color; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(textState.text, textState.fx * nw, textState.fy * nh);
  showDesign(c.toDataURL("image/png").split(",")[1]);
  showTextLayer(false);
  $("txtContent").value = ""; textState.text = "";
  const note = $("genNote"); note.className = "gen-note ok"; note.textContent = "✓ Đã ghép chữ vào design. Tải PNG / bản in / mockup đều có chữ.";
};
window.addEventListener("resize", () => { if (textState.text.trim()) positionTextLayer(); });

/* ---------- tải PNG gốc ---------- */
$("downloadBtn").onclick = () => {
  if (!currentDesign) return;
  const a = document.createElement("a");
  a.href = "data:image/png;base64," + currentDesign; a.download = "design.png"; a.click();
};

/* ---------- tải bản in (upscale) ---------- */
$("printBtn").onclick = async () => {
  if (!currentDesign) return;
  const target = parseInt($("printRes").value, 10);
  const upm = $("upMethod").value;
  const btn = $("printBtn"); const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = upm === "ai" ? "⏳ AI upscale (1–3 phút)…" : "⏳ Đang upscale…";
  try {
    if (target === 0) {
      const a = document.createElement("a");
      a.href = "data:image/png;base64," + currentDesign; a.download = "design-print.png"; a.click();
    } else {
      const r = await fetch("/api/upscale", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: currentDesign, target, method: upm }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      const a = document.createElement("a");
      a.href = "data:image/png;base64," + data.image;
      a.download = "design-print-" + target + "px.png"; a.click();
    }
  } catch (err) { alert("Lỗi upscale: " + err.message); }
  finally { btn.disabled = false; btn.textContent = old; }
};

/* ---------- tabs kết quả ---------- */
document.querySelectorAll(".rtab").forEach(t => t.onclick = () => {
  document.querySelectorAll(".rtab").forEach(x => x.classList.remove("active"));
  t.classList.add("active");
  const tab = t.dataset.rtab;
  $("rpane-design").classList.toggle("hidden", tab !== "design");
  $("rpane-mockup").classList.toggle("hidden", tab !== "mockup");
  $("rpane-gallery").classList.toggle("hidden", tab !== "gallery");
  if (tab === "mockup") ensureMockupBg();
  if (tab === "gallery") loadGallery();
});
$("sendToMockup").onclick = () => {
  document.querySelector('.rtab[data-rtab="mockup"]').click();
  if ($("designOnShirt").src) { $("designLayer").classList.add("active"); $("mockupEmpty").classList.add("hidden"); }
};

/* ---------- mockup: thư viện áo của bạn + tạo AI ---------- */
const COLORS = [
  ["white", "#f5f5f5"], ["black", "#1c1c1e"], ["gray", "#9aa0a6"], ["navy", "#21304d"],
  ["red", "#b3261e"], ["sand", "#d8c3a5"], ["forest", "#2f5d3a"], ["pink", "#e8a0b8"],
];
let mockupBgSrc = null, mockupsLoaded = false;

function buildSwatches() {
  const row = $("colorRow"); row.innerHTML = "";
  COLORS.forEach(([key, hex]) => {
    const s = document.createElement("button");
    s.className = "swatch"; s.style.background = hex; s.title = key; s.dataset.color = key;
    s.onclick = () => selectColor(key);
    row.appendChild(s);
  });
}
buildSwatches();

function setMockupBg(url) {
  mockupBgSrc = url; $("mockupBg").src = url; $("mockupBg").style.display = "";
  document.querySelectorAll(".mk-thumb").forEach(t => t.classList.toggle("active", t.dataset.url === url));
}

// ✏️ Chế độ chỉnh sửa mockup: bấm mới hiện nút xoá (×) + tải thêm + tạo bằng AI
if ($("mkEditBtn")) $("mkEditBtn").onclick = () => {
  const tb = document.querySelector(".mockup-toolbar"); if (!tb) return;
  const on = tb.classList.toggle("mk-editing");
  $("mkEditBtn").textContent = on ? "✅ Xong" : "✏️ Chỉnh sửa mockup";
  $("mkEditBtn").classList.toggle("on", on);
};
async function loadMockups(selectFirst) {
  try {
    const r = await fetch("/api/mockups"); const data = await r.json();
    const items = data.items || [];
    const front = $("mkThumbs"), back = $("mkThumbsBack");
    front.innerHTML = ""; back.innerHTML = "";
    items.forEach(it => {
      const d = document.createElement("div");
      d.className = "mk-thumb"; d.dataset.url = it.url; d.title = it.name;
      d.innerHTML = `<img src="${it.url}" alt=""><button class="mkdel" title="xoá">×</button>`;
      d.querySelector("img").onclick = () => selectMockupForSide(it.url, it.side);
      d.querySelector(".mkdel").onclick = async (e) => {
        e.stopPropagation();
        await fetch("/api/mockups?file=" + encodeURIComponent(it.file), { method: "DELETE" });
        loadMockups();
      };
      (it.side === "back" ? back : front).appendChild(d);
    });
    $("mkHint").textContent = front.children.length ? "Bấm vào áo để chọn. (✏️ Chỉnh sửa để thêm/xoá)" : "Chưa có — bấm ✏️ Chỉnh sửa rồi ➕ Tải mặt trước.";
    $("mkHintBack").textContent = back.children.length ? "Bấm vào áo để chọn. (✏️ Chỉnh sửa để thêm/xoá)" : "Chưa có — bấm ✏️ Chỉnh sửa rồi ➕ Tải mặt sau.";
    mockupsLoaded = true;
    if (selectFirst && items.length && !mockupBgSrc) {
      const f = items.find(i => i.side !== "back") || items[0];
      setMockupBg(f.url);
    }
    return items;
  } catch (e) { return []; }
}

async function selectColor(key) {
  document.querySelectorAll(".swatch").forEach(s => s.classList.toggle("active", s.dataset.color === key));
  $("mockupLoading").classList.remove("hidden");
  try {
    const r = await fetch("/api/make-mockup", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ color: key }),
    });
    const data = await r.json();
    if (r.ok && data.url) { await loadMockups(); setMockupBg(data.url + "?t=" + Date.now()); }
    else if (data.error) alert(data.error);
  } catch (e) { alert("Lỗi tạo mockup: " + e.message); }
  finally { $("mockupLoading").classList.add("hidden"); }
}

async function ensureMockupBg() {
  if (!mockupsLoaded) await loadMockups(true);
}

/* tải áo của bạn lên (lưu server) — side: front/back */
async function uploadMockups(files, side) {
  if (!files.length) return;
  $("mockupLoading").classList.remove("hidden");
  let last = null;
  for (const f of files) {
    const dataURL = await fileToDataURL(f);
    const name = f.name.replace(/\.[^.]+$/, "");
    try {
      const r = await fetch("/api/upload-mockup", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: dataURL, name, side }),
      });
      const data = await r.json();
      if (r.ok) last = data.url;
    } catch (err) { /* bỏ qua ảnh lỗi */ }
  }
  await loadMockups();
  if (last) selectMockupForSide(last, side);
  $("mockupLoading").classList.add("hidden");
}
$("mockupFile").onchange = async (e) => { await uploadMockups([...e.target.files], "front"); e.target.value = ""; };
$("mockupFileBack").onchange = async (e) => { await uploadMockups([...e.target.files], "back"); e.target.value = ""; };

/* ---------- mockup: kéo thả / resize / slider ---------- */
const layer = $("designLayer"), stage = $("mockupStage");
let state = { xPct: 50, yPct: 42, wPct: 38, rot: 0 };
function applyState() {
  layer.style.left = state.xPct + "%"; layer.style.top = state.yPct + "%";
  layer.style.width = state.wPct + "%";
  layer.style.transform = `translate(-50%,-50%) rotate(${state.rot}deg)`;
  $("scaleSlider").value = Math.round(state.wPct); $("scaleVal").textContent = Math.round(state.wPct) + "%";
  $("rotateSlider").value = Math.round(state.rot); $("rotateVal").textContent = Math.round(state.rot) + "°";
}
applyState();

/* ---------- ⌨️ Điều chỉnh VỊ TRÍ layer bằng BÀN PHÍM (dùng chung mọi tab có layer) ----------
   Bấm vào layer để chọn -> mũi tên ←↑→↓ di chuyển (Shift = bước lớn), +/- phóng to/thu nhỏ. */
let kbTarget = null;
function kbSetTarget(el, getState, apply) {
  if (kbTarget && kbTarget.el !== el) kbTarget.el.classList.remove("kb-focus");
  kbTarget = { el: el, getState: getState, apply: apply };
  el.classList.add("kb-focus");
}
document.addEventListener("keydown", (e) => {
  if (!kbTarget) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
  if (!kbTarget.el.isConnected || kbTarget.el.offsetParent === null) return;   // layer đang ẩn
  const st = kbTarget.getState();
  const step = e.shiftKey ? 2.5 : 0.4;      // Shift = nhích nhanh
  const zstep = e.shiftKey ? 2 : 0.6;
  let ok = true;
  if (e.key === "ArrowLeft") st.xPct = Math.max(0, st.xPct - step);
  else if (e.key === "ArrowRight") st.xPct = Math.min(100, st.xPct + step);
  else if (e.key === "ArrowUp") st.yPct = Math.max(0, st.yPct - step);
  else if (e.key === "ArrowDown") st.yPct = Math.min(100, st.yPct + step);
  else if (e.key === "+" || e.key === "=") st.wPct = Math.min(100, st.wPct + zstep);
  else if (e.key === "-" || e.key === "_") st.wPct = Math.max(8, st.wPct - zstep);
  else ok = false;
  if (ok) { e.preventDefault(); kbTarget.apply(); }
});

let drag = null;
layer.addEventListener("pointerdown", (e) => {
  if (e.target.id === "resizeHandle" || e.target.classList.contains("rotate-handle")) return;
  e.preventDefault();
  kbSetTarget(layer, () => state, applyState);
  drag = { r: stage.getBoundingClientRect(), sx: e.clientX, sy: e.clientY, x0: state.xPct, y0: state.yPct };
  layer.setPointerCapture(e.pointerId);
});
/* 🔄 Kéo nút ở góc để XOAY layer quanh tâm */
document.querySelectorAll("#designLayer .rotate-handle").forEach(rh => {
  let rot = null;
  const angTo = (e, c) => Math.atan2(e.clientY - c.cy, e.clientX - c.cx) * 180 / Math.PI;
  rh.addEventListener("pointerdown", (e) => {
    e.preventDefault(); e.stopPropagation();
    const r = layer.getBoundingClientRect();
    const c = { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    rot = { c: c, a0: angTo(e, c), r0: state.rot };
    kbSetTarget(layer, () => state, applyState);
    rh.setPointerCapture(e.pointerId);
  });
  rh.addEventListener("pointermove", (e) => {
    if (!rot) return;
    let d = rot.r0 + angTo(e, rot.c) - rot.a0;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    if (e.shiftKey) d = Math.round(d / 15) * 15;   // Shift = khớp bậc 15°
    state.rot = Math.round(d * 10) / 10;
    applyState();
  });
  rh.addEventListener("pointerup", () => { rot = null; });
});
layer.addEventListener("pointermove", (e) => {
  if (!drag) return;
  state.xPct = Math.max(0, Math.min(100, drag.x0 + (e.clientX - drag.sx) / drag.r.width * 100));
  state.yPct = Math.max(0, Math.min(100, drag.y0 + (e.clientY - drag.sy) / drag.r.height * 100));
  applyState();
});
layer.addEventListener("pointerup", () => { drag = null; });
const handle = $("resizeHandle"); let rs = null;
handle.addEventListener("pointerdown", (e) => {
  e.preventDefault(); e.stopPropagation();
  rs = { r: stage.getBoundingClientRect(), sx: e.clientX, w0: state.wPct };
  handle.setPointerCapture(e.pointerId);
});
handle.addEventListener("pointermove", (e) => {
  if (!rs) return;
  state.wPct = Math.max(8, Math.min(100, rs.w0 + (e.clientX - rs.sx) / rs.r.width * 100 * 2));
  applyState();
});
handle.addEventListener("pointerup", () => { rs = null; });
/* tải design lên thẳng trong tab mockup */
$("designUpload").onchange = (e) => {
  const f = e.target.files[0]; if (!f) return;
  fileToDataURL(f).then(src => {
    $("designOnShirt").src = src;
    layer.classList.add("active");
    $("mockupEmpty").classList.add("hidden");
    state = { xPct: 50, yPct: 42, wPct: 38, rot: 0 };
    applyState();
    kbSetTarget(layer, () => state, applyState);   // phím mũi tên dùng được ngay
  });
  e.target.value = "";
};

$("scaleSlider").oninput = (e) => { state.wPct = +e.target.value; applyState(); };
$("rotateSlider").oninput = (e) => { state.rot = +e.target.value; applyState(); };
$("resetMockup").onclick = () => { state = { xPct: 50, yPct: 42, wPct: 38, rot: 0 }; applyState(); };

/* ---------- mockup: mặt trước / mặt sau ---------- */
const sides = {
  front: { bg: "", design: "", active: false, state: { xPct: 50, yPct: 42, wPct: 38, rot: 0 } },
  back: { bg: "", design: "", active: false, state: { xPct: 50, yPct: 42, wPct: 38, rot: 0 } },
};
let currentSide = "front";

function snapshotSide() {
  const s = sides[currentSide];
  s.bg = $("mockupBg").getAttribute("src") || "";
  s.design = $("designOnShirt").getAttribute("src") || "";
  s.active = layer.classList.contains("active");
  s.state = { ...state };
}
function restoreSide() {
  const s = sides[currentSide];
  if (s.bg) { $("mockupBg").src = s.bg; $("mockupBg").style.display = ""; mockupBgSrc = s.bg; }
  else { $("mockupBg").removeAttribute("src"); $("mockupBg").style.display = "none"; mockupBgSrc = null; }
  if (s.design) $("designOnShirt").src = s.design;
  else $("designOnShirt").removeAttribute("src");
  const hasDesign = s.active && !!s.design;
  layer.classList.toggle("active", hasDesign);
  $("mockupEmpty").classList.toggle("hidden", hasDesign);
  state = { ...s.state };
  applyState();
  document.querySelectorAll(".mk-thumb").forEach(t => t.classList.toggle("active", t.dataset.url === mockupBgSrc));
}
document.querySelectorAll(".side-btn").forEach(b => b.onclick = () => {
  const side = b.dataset.side;
  if (side === currentSide) return;
  snapshotSide();
  currentSide = side;
  document.querySelectorAll(".side-btn").forEach(x => x.classList.toggle("active", x === b));
  restoreSide();
});

/* chọn 1 áo từ thư viện: tự chuyển sang đúng mặt (trước/sau) rồi đặt làm nền */
function selectMockupForSide(url, side) {
  side = side || "front";
  if (side !== currentSide) {
    snapshotSide();
    currentSide = side;
    document.querySelectorAll(".side-btn").forEach(x => x.classList.toggle("active", x.dataset.side === side));
    restoreSide();
  }
  setMockupBg(url);
}

/* ---------- xuất ảnh demo ---------- */
$("exportMockup").onclick = async () => {
  if (!$("designOnShirt").src || !layer.classList.contains("active")) {
    alert("Chưa có design trong mockup. Bấm “Đưa vào mockup” trước nhé."); return;
  }
  const H = 3000, W = 2400;   // demo phân giải cao -> zoom không vỡ
  const canvas = document.createElement("canvas"); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  const bg = new Image(), dzi = new Image();
  bg.crossOrigin = "anonymous"; dzi.crossOrigin = "anonymous";
  await new Promise(r => { bg.onload = r; bg.onerror = r; bg.src = $("mockupBg").src; });
  await new Promise(r => { dzi.onload = r; dzi.onerror = r; dzi.src = $("designOnShirt").src; });
  ctx.fillStyle = "#f4f4f6"; ctx.fillRect(0, 0, W, H);
  if (bg.width) { const s = Math.min(W / bg.width, H / bg.height); const bw = bg.width * s, bh = bg.height * s; ctx.drawImage(bg, (W - bw) / 2, (H - bh) / 2, bw, bh); }
  const dw = (state.wPct / 100) * W;
  const dh = dzi.height ? dw * (dzi.height / dzi.width) : dw;
  ctx.save();
  ctx.translate((state.xPct / 100) * W, (state.yPct / 100) * H);
  ctx.rotate(state.rot * Math.PI / 180);
  ctx.drawImage(dzi, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
  const a = document.createElement("a"); a.download = "mockup-demo.png"; a.href = canvas.toDataURL("image/png"); a.click();
};

/* ---------- gallery ---------- */
let _galItems = [], _galLimit = 150;   // render giới hạn -> hết lag khi lịch sử cả nghìn ảnh
async function loadGallery() {
  try {
    const r = await fetch("/api/gallery"); const data = await r.json();
    _galItems = data.items || [];
    renderGallery();
  } catch (e) { /* im lặng */ }
}
// THUMBNAIL: ảnh gallery gốc 1-2MB -> JPEG ~40KB cho mọi lưới nhỏ (server lười-tạo lần đầu)
function gthumb(u) {
  if (!u || typeof u !== "string" || u.indexOf("/gallery/") !== 0 || u.indexOf("/gallery/t/") === 0) return u;
  return "/gallery/t/" + u.slice(9).replace(/\.(png|webp|jpg)$/i, "") + ".jpg";
}
function renderGallery() {
  const grid = $("galleryGrid"); grid.innerHTML = "";
  const items = _galItems;
  $("galleryEmpty").classList.toggle("hidden", items.length > 0);
  items.slice(0, _galLimit).forEach(it => {
    const card = document.createElement("div"); card.className = "gcard";
    const label = (it.prompt || it.mode || "design").slice(0, 40);
    card.innerHTML = `<img src="${gthumb(it.url)}" loading="lazy"><div class="gmeta">${label}</div><button class="gcopy" title="copy ảnh để gửi chỗ khác">📋</button><button class="gdel" title="xoá">×</button>`;
    card.querySelector("img").onclick = () => useGalleryItem(it);
    card.querySelector(".gcopy").onclick = (e) => { e.stopPropagation(); copyImageToClipboard(it.url, e.currentTarget); };
    card.querySelector(".gdel").onclick = async (e) => {
      e.stopPropagation();
      await fetch("/api/gallery?id=" + it.id, { method: "DELETE" });
      loadGallery();
    };
    grid.appendChild(card);
  });
  if (items.length > _galLimit) {
    const more = document.createElement("button");
    more.className = "btn-ghost";
    more.style.cssText = "grid-column:1/-1;margin-top:8px;padding:10px";
    more.textContent = "⬇ Xem thêm (còn " + (items.length - _galLimit) + " ảnh)";
    more.onclick = () => { _galLimit += 200; renderGallery(); };
    grid.appendChild(more);
  }
}
async function useGalleryItem(it) {
  // tải ảnh -> base64 để dùng lại (download/upscale/mockup)
  const resp = await fetch(it.url); const blob = await resp.blob();
  const b64 = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.readAsDataURL(blob); });
  showDesign(b64);
  document.querySelector('.rtab[data-rtab="design"]').click();
}
$("refreshGallery").onclick = loadGallery;

/* Tách nền giờ TỰ ĐỘNG ngay trong bước clone — không còn bước thủ công. */

/* =====================================================================
   APP TABS — chuyển giữa các tính năng độc lập (Clone / Auto / …)
   ===================================================================== */
function showApp(app) {
  document.querySelectorAll(".app-tab").forEach(t => t.classList.toggle("active", t.dataset.app === app));
  document.getElementById("view-clone").classList.toggle("hidden", app !== "clone");
  document.getElementById("view-auto").classList.toggle("hidden", app !== "auto");
  document.getElementById("view-recolor").classList.toggle("hidden", app !== "recolor");
  document.getElementById("view-addbg").classList.toggle("hidden", app !== "addbg");
  document.getElementById("view-lenao").classList.toggle("hidden", app !== "lenao");
  document.getElementById("view-batch").classList.toggle("hidden", app !== "batch");
  document.getElementById("view-product").classList.toggle("hidden", app !== "product");
  document.getElementById("view-design").classList.toggle("hidden", app !== "design");
  document.getElementById("view-psn").classList.toggle("hidden", app !== "psn");
  document.getElementById("view-setshirt").classList.toggle("hidden", app !== "setshirt");
  document.getElementById("view-tiktok").classList.toggle("hidden", app !== "tiktok");
  document.getElementById("view-namedes").classList.toggle("hidden", app !== "namedes");
  document.getElementById("view-cutout").classList.toggle("hidden", app !== "cutout");
  document.getElementById("view-autopipe").classList.toggle("hidden", app !== "autopipe");
  document.getElementById("view-post").classList.toggle("hidden", app !== "post");
  document.getElementById("view-ads").classList.toggle("hidden", app !== "ads");
  document.getElementById("view-fbpost").classList.toggle("hidden", app !== "fbpost");
  document.getElementById("view-admgr").classList.toggle("hidden", app !== "admgr");
  document.getElementById("view-agent").classList.toggle("hidden", app !== "agent");
  document.getElementById("view-adpost").classList.toggle("hidden", app !== "adpost");
  document.getElementById("view-pgpost").classList.toggle("hidden", app !== "pgpost");
  document.getElementById("view-sched").classList.toggle("hidden", app !== "sched");
  document.getElementById("view-shopify").classList.toggle("hidden", app !== "shopify");
  document.getElementById("view-shoplist").classList.toggle("hidden", app !== "shoplist");
  if (app === "ads") adsInit();
  if (app === "fbpost") fbpInit();
  if (app === "admgr") admgrInit();
  if (app === "agent") agentInit();
  if (app === "adpost") adpostInit();
  if (app === "pgpost") pgpostInit();
  if (app === "sched") schedInit();
  if (app === "lenao") lenaoInit();
  if (app === "product") prodInit();
  if (app === "design") { dsInit(); setTimeout(dsFitHeight, 30); }
  if (app === "psn") psnInit();
  if (app === "setshirt") ssInit();
  if (app === "tiktok") ttInit();
  if (app === "namedes") namedesInit();
  if (app === "cutout") cutoutInit();
  if (app === "shopify") shopInit();
  if (app === "shoplist") shoplistInit();
  if (app === "autopipe") apInit();
  if (app === "post") postInit();
  // đồng bộ nhóm lớn theo tab đang mở (kể cả khi showApp gọi từ nơi khác)
  const tabEl = document.querySelector('.app-tab[data-app="' + app + '"]');
  if (tabEl) showGroup(tabEl.dataset.group, true);
}
function showGroup(g, keepApp) {
  document.querySelectorAll(".app-group").forEach(b => b.classList.toggle("active", b.dataset.group === g));
  document.querySelectorAll(".app-tab").forEach(t => t.classList.toggle("ghidden", t.dataset.group !== g));
  if (!keepApp) {
    const first = document.querySelector('.app-tab[data-group="' + g + '"]');
    if (first) showApp(first.dataset.app);
  }
}
document.querySelectorAll(".app-tab").forEach(t => t.onclick = () => showApp(t.dataset.app));
document.querySelectorAll(".app-group").forEach(b => { if (b.id !== "tabEditBtn") b.onclick = () => showGroup(b.dataset.group); });

/* ---- Sửa vị trí tab: kéo-thả, lưu localStorage ---- */
function applyTabOrder() {
  let order = [];
  try { order = JSON.parse(localStorage.getItem("tabOrder") || "[]"); } catch (e) {}
  if (!order.length) return;
  const nav = document.querySelector(".app-tabs"); if (!nav) return;
  order.forEach(app => { const el = nav.querySelector('.app-tab[data-app="' + app + '"]'); if (el) nav.appendChild(el); });
}
function saveTabOrder() {
  const order = [...document.querySelectorAll(".app-tabs .app-tab")].map(t => t.dataset.app);
  try { localStorage.setItem("tabOrder", JSON.stringify(order)); } catch (e) {}
}
let tabEditOn = false, tabDragEl = null;
function setTabEdit(on) {
  tabEditOn = on;
  const btn = $("tabEditBtn"); if (btn) { btn.classList.toggle("active", on); btn.textContent = on ? "✓ Xong (kéo để đổi)" : "✎ Sửa vị trí tab"; }
  document.querySelectorAll(".app-tabs .app-tab").forEach(t => {
    t.draggable = on;
    t.style.cursor = on ? "grab" : "";
    if (on) {
      t.ondragstart = (e) => { tabDragEl = t; t.style.opacity = ".4"; e.dataTransfer.effectAllowed = "move"; };
      t.ondragend = () => { t.style.opacity = ""; tabDragEl = null; saveTabOrder(); };
      t.ondragover = (e) => { e.preventDefault(); if (!tabDragEl || tabDragEl === t || tabDragEl.dataset.group !== t.dataset.group) return; const r = t.getBoundingClientRect(); const after = e.clientX > r.left + r.width / 2; t.parentNode.insertBefore(tabDragEl, after ? t.nextSibling : t); };
    } else { t.ondragstart = t.ondragend = t.ondragover = null; }
  });
}
if ($("tabEditBtn")) $("tabEditBtn").onclick = () => setTabEdit(!tabEditOn);
applyTabOrder();
showGroup("design", true);

/* =====================================================================
   TÍNH NĂNG: AUTO RESEARCH (độc lập — có upload/niche/kết quả riêng)
   ===================================================================== */
let autoUploaded = [];

async function autoAddFiles(files) {
  for (const f of files) {
    if (!f.type.startsWith("image/") || autoUploaded.length >= 3) continue;
    autoUploaded.push(await fileToDataURL(f));
  }
  autoRenderThumbs();
}
function autoRenderThumbs() {
  const row = $("autoThumbs"); row.innerHTML = "";
  autoUploaded.forEach((src, i) => {
    const d = document.createElement("div");
    d.className = "thumb";
    d.innerHTML = '<img src="' + src + '" alt=""><button class="thumb-x">×</button>';
    d.querySelector(".thumb-x").onclick = () => { autoUploaded.splice(i, 1); autoRenderThumbs(); };
    row.appendChild(d);
  });
}
$("autoFileInput").onchange = (e) => autoAddFiles(e.target.files);
(() => {
  const dz = $("autoDrop");
  dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("drag"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
  dz.addEventListener("drop", e => { e.preventDefault(); dz.classList.remove("drag"); autoAddFiles(e.dataTransfer.files); });
})();

function autoDownload(b64, title) {
  const a = document.createElement("a");
  a.href = "data:image/png;base64," + b64;
  a.download = (title || "auto-design").replace(/[^\w\-]+/g, "_") + ".png";
  a.click();
}

// NHIỀU LUỒNG: mỗi lần cá nhân hoá = 1 job nền, có placeholder; up design khác chạy tiếp song song
let autoItems = [];   // [{loading,job,name} | item design]
function autoRenderAll() {
  const grid = $("autoResults");
  $("autoEmpty").classList.toggle("hidden", autoItems.length > 0);
  grid.innerHTML = "";
  autoItems.forEach(c => {
    if (c.loading) {
      const ph = document.createElement("div"); ph.className = "gcard fp-card-loading";
      ph.innerHTML = '<div class="fp-loading" style="min-height:240px"><span class="fp-spin"></span><span>Đang vẽ' + (c.name ? ' "' + c.name + '"' : '') + '… ~1 phút</span></div>';
      grid.appendChild(ph); return;
    }
    const key = dsItemKey(c); dsItems[key] = c; grid.appendChild(dsMakeCard(key, c));
  });
}
// giữ tương thích: hook cũ gọi autoRender(items) -> nạp vào autoItems
function autoRender(items) { (items || []).forEach(it => autoItems.unshift(it)); autoRenderAll(); }
// chạy 1 luồng cá nhân hoá (nền) — không chặn UI
function autoLaunchPersonalize(image, name, date, count, nick, req) {
  const job = "a" + Date.now() + "_" + Math.floor(Math.random() * 1000);
  for (let i = 0; i < count; i++) autoItems.unshift({ loading: true, job: job, name: name });
  autoRenderAll();
  const note = $("autoNote"); note.className = "gen-note"; note.textContent = "⏳ Đang vẽ \"" + name + "\"… (up design khác để chạy tiếp luồng mới)";
  fetch("/api/personalize", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: image, name: name, date: date, nick: nick || "", note: req || "", count: count, transparent: true, nick_vary: true }),
  }).then(r => r.json().then(d => ({ ok: r.ok, d: d })))
    .then(({ ok, d }) => {
      autoItems = autoItems.filter(c => !(c.loading && c.job === job));
      if (!ok) { autoRenderAll(); note.className = "gen-note err"; note.textContent = "✗ " + (d.error || "Lỗi"); return; }
      (d.items || []).forEach(it => autoItems.unshift(it));
      autoRenderAll();
      note.className = "gen-note ok"; note.textContent = "✓ Xong \"" + name + "\" (" + (d.items || []).length + " bản).";
      if (typeof loadGallery === "function") loadGallery();
    })
    .catch(e => { autoItems = autoItems.filter(c => !(c.loading && c.job === job)); autoRenderAll(); note.className = "gen-note err"; note.textContent = "✗ " + e.message; });
}

// Auto Research = gửi design -> mở ĐÚNG popup cá nhân hoá tên (như bấm 🪪 Tên ở Tạo design)
$("autoRunBtn").onclick = () => {
  const note = $("autoNote"); note.className = "gen-note"; note.textContent = "";
  if (!autoUploaded.length) { note.className = "gen-note err"; note.textContent = "⚠️ Hãy gửi 1 ảnh design trước."; return; }
  const src = autoUploaded[0];
  const b64 = src.indexOf(",") >= 0 ? src.split(",")[1] : src;   // bỏ tiền tố data:
  openPersonalize(b64, true);   // mở modal cá nhân hoá CHẾ ĐỘ AUTO (chạy nền nhiều luồng)
};

/* =====================================================================
   TÍNH NĂNG: ĐỔI MÀU THEO ÁO (độc lập)
   ===================================================================== */
// CHỈ 2 màu áo đang bán: Đen + Trắng. Prompt: "phối lại màu cho hợp in trên áo đen/trắng".
const RECOLOR_LIST = [
  { key: "black",  vi: "Đen",   sw: "#1c1c1e" },
  { key: "white",  vi: "Trắng", sw: "#f5f5f5" },
];
let recolorImg = null;            // dataURL design đầu vào
const recolorPicked = new Set(["black", "white"]); // mặc định chọn cả 2

function recolorRenderChips() {
  const box = $("recolorChips"); if (!box) return;   // tab đổi màu giờ dùng prompt, bỏ chip
  box.innerHTML = "";
  RECOLOR_LIST.forEach(c => {
    const el = document.createElement("div");
    el.className = "cchip" + (recolorPicked.has(c.key) ? " on" : "");
    el.innerHTML = '<span class="sw" style="background:' + c.sw + '"></span>' + c.vi + ' <span class="tick">✓</span>';
    el.onclick = () => {
      if (recolorPicked.has(c.key)) recolorPicked.delete(c.key); else recolorPicked.add(c.key);
      recolorRenderChips();
    };
    box.appendChild(el);
  });
}
recolorRenderChips();

function recolorRenderThumb() {
  const row = $("recolorThumbs"); row.innerHTML = "";
  if (!recolorImg) return;
  const d = document.createElement("div");
  d.className = "thumb";
  d.innerHTML = '<img src="' + recolorImg + '" alt=""><button class="thumb-x">×</button>';
  d.querySelector(".thumb-x").onclick = () => { recolorImg = null; recolorRenderThumb(); };
  row.appendChild(d);
}
$("recolorFileInput").onchange = async (e) => {
  const f = e.target.files[0];
  if (f && f.type.startsWith("image/")) { recolorImg = await fileToDataURL(f); recolorRenderThumb(); }
};
(() => {
  const dz = $("recolorDrop");
  dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("drag"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
  dz.addEventListener("drop", async e => {
    e.preventDefault(); dz.classList.remove("drag");
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith("image/")) { recolorImg = await fileToDataURL(f); recolorRenderThumb(); }
  });
})();
$("recolorUseCurrent").onclick = () => {
  if (!currentDesign) { const n = $("recolorNote"); n.className = "gen-note err"; n.textContent = "⚠️ Chưa có design nào đang mở ở tab Clone Design."; return; }
  recolorImg = "data:image/png;base64," + currentDesign;
  recolorRenderThumb();
  const n = $("recolorNote"); n.className = "gen-note ok"; n.textContent = "✓ Đã nạp design đang mở.";
};
// Dán design (copy/paste) vào tab Đổi màu
async function recolorSetFromBlob(blob) {
  if (!blob || !blob.type.startsWith("image/")) return false;
  recolorImg = await fileToDataURL(blob); recolorRenderThumb();
  const n = $("recolorNote"); if (n) { n.className = "gen-note ok"; n.textContent = "✓ Đã dán design vào."; }
  return true;
}
if ($("recolorPaste")) $("recolorPaste").onclick = async () => {
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const type = (it.types || []).find(t => t.startsWith("image/"));
      if (type) { await recolorSetFromBlob(await it.getType(type)); return; }
    }
    throw new Error("no image");
  } catch (e) {
    const n = $("recolorNote"); if (n) { n.className = "gen-note"; n.textContent = "📋 Bấm vào tab này rồi nhấn Ctrl/Cmd+V để dán ảnh."; }
  }
};
document.addEventListener("paste", async (e) => {
  const view = document.getElementById("view-recolor");
  if (!view || view.classList.contains("hidden")) return;
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for (const it of items) {
    if (it.type && it.type.startsWith("image/")) { e.preventDefault(); await recolorSetFromBlob(it.getAsFile()); return; }
  }
});

/* Nền xem trước làm sẵn (ghép client, không tốn credit) */
const RECOLOR_BG = [
  { id: "shirt", label: "🎽 Nền áo",   kind: "shirt" },
  { id: "none",  label: "Trong suốt",  kind: "none" },
  { id: "white", label: "Trắng",       kind: "solid", c: "#ffffff" },
  { id: "cream", label: "Kem",         kind: "solid", c: "#f3e9d2" },
  { id: "black", label: "Đen",         kind: "solid", c: "#1c1c1e" },
  { id: "rose",  label: "Hồng→Xanh",   kind: "grad", c1: "#ffd2e0", c2: "#c2e0ff", dir: "d" },
  { id: "sunset",label: "Hoàng hôn",   kind: "grad", c1: "#ffe29f", c2: "#ff719a", dir: "d" },
  { id: "mint",  label: "Mint",        kind: "grad", c1: "#d9fff0", c2: "#a8e6cf", dir: "v" },
];
let recolorBg = "none";         // preset xem trước (mặc định trong suốt — prompt mode)
let recolorItems = [];          // kết quả tách nền từ server

function recolorRenderBgPresets() {
  const box = $("recolorBgPresets"); if (!box) return; box.innerHTML = "";
  RECOLOR_BG.forEach(p => {
    const el = document.createElement("div");
    el.className = "cchip" + (recolorBg === p.id ? " on" : "");
    let sw = "#ddd";
    if (p.kind === "solid") sw = p.c;
    else if (p.kind === "grad") sw = "linear-gradient(135deg," + p.c1 + "," + p.c2 + ")";
    else if (p.kind === "none") sw = "repeating-conic-gradient(#ccc 0 25%,#fff 0 50%) 0 0/8px 8px";
    else if (p.kind === "shirt") sw = "linear-gradient(135deg,#1c1c1e 50%,#f5f5f5 50%)";
    el.innerHTML = '<span class="sw" style="background:' + sw + '"></span>' + p.label + ' <span class="tick">✓</span>';
    el.onclick = () => { recolorBg = p.id; recolorRenderBgPresets(); recolorRender(); };
    box.appendChild(el);
  });
}
recolorRenderBgPresets();

// ghép 1 ảnh tách nền lên nền theo preset -> trả dataURL
function recolorComposite(b64, preset, hex) {
  return new Promise(res => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth, h = img.naturalHeight;
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      const x = c.getContext("2d");
      if (preset.kind === "shirt") { x.fillStyle = hex || "#888"; x.fillRect(0, 0, w, h); }
      else if (preset.kind === "solid") { x.fillStyle = preset.c; x.fillRect(0, 0, w, h); }
      else if (preset.kind === "grad") {
        const g = preset.dir === "h" ? x.createLinearGradient(0, 0, w, 0)
                : preset.dir === "v" ? x.createLinearGradient(0, 0, 0, h)
                :                       x.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, preset.c1); g.addColorStop(1, preset.c2);
        x.fillStyle = g; x.fillRect(0, 0, w, h);
      } // "none" -> để trong suốt
      x.drawImage(img, 0, 0, w, h);
      res(c.toDataURL("image/png"));
    };
    img.src = "data:image/png;base64," + b64;
  });
}

let _recolorRenderToken = 0;
async function recolorRender(items) {
  if (items) { recolorItems = items; recolorSel.clear(); if ($("recolorSelAll")) $("recolorSelAll").checked = false; }
  const grid = $("recolorResults");
  if (!recolorItems.length) {
    grid.innerHTML = "";
    $("recolorEmpty").classList.remove("hidden");
    $("recolorToolbar").classList.add("hidden");
    return;
  }
  $("recolorEmpty").classList.add("hidden");
  $("recolorToolbar").classList.remove("hidden");
  $("recolorShirtAdjust").classList.toggle("hidden", recolorView !== "shirt");
  if (recolorView === "shirt") { await recolorLoadShirts(); recolorApplyStage(); }
  const preset = RECOLOR_BG.find(p => p.id === recolorBg) || RECOLOR_BG[0];
  const token = ++_recolorRenderToken;

  // ghép tất cả trước (await), rồi dựng DOM 1 lần -> tránh race khi kéo nhanh
  const durls = [];
  for (let i = 0; i < recolorItems.length; i++) {
    const it = recolorItems[i];
    let durl;
    if (recolorView === "shirt" && recolorShirtMap[it.color]) {
      durl = await recolorOnShirt(it.image, recolorShirtMap[it.color], recolorState);
    }
    if (!durl) durl = await recolorComposite(it.image, preset, it.hex);
    durls.push(durl);
  }
  if (token !== _recolorRenderToken) return;   // có lần render mới hơn -> bỏ
  grid.innerHTML = "";

  for (let i = 0; i < recolorItems.length; i++) {
    const it = recolorItems[i];
    const durl = durls[i];
    const cur = durl.split(",")[1];

    const card = document.createElement("div");
    card.className = "gcard";
    card.innerHTML =
      '<input type="checkbox" class="gpick"' + (recolorSel.has(i) ? " checked" : "") + ' title="Chọn để tải hàng loạt">' +
      '<img src="' + durl + '" alt="">' +
      '<div class="gmeta"><span class="sw" style="background:' + (it.hex || "#888") +
        '"></span>' + (it.title || "Bản màu") + '</div>' +
      '<div class="gacts"><button class="b-zoom">🔍 Phóng to</button><button class="b-copy">📋 Copy</button><button class="b-dl">⬇ Tải</button></div>';
    card._cur = cur; card._title = it.title;     // lưu ảnh đang xem để tải
    card.querySelector(".gpick").onchange = (e) => {
      if (e.target.checked) recolorSel.add(i); else recolorSel.delete(i);
      recolorUpdateSelUI();
    };
    card.querySelector("img").onclick = () => openZoom(durl);
    card.querySelector(".b-zoom").onclick = () => openZoom(durl);
    card.querySelector(".b-copy").onclick = (e) => copyImageToClipboard(durl, e.currentTarget);
    card.querySelector(".b-dl").onclick = () => autoDownload(cur, it.title);
    grid.appendChild(card);
  }
  recolorUpdateSelUI();
}

/* Toolbar: đổi chế độ xem / chọn tất cả / tải hàng loạt */
document.querySelectorAll("#recolorViewTabs .tab").forEach(t => t.onclick = () => {
  document.querySelectorAll("#recolorViewTabs .tab").forEach(x => x.classList.remove("active"));
  t.classList.add("active");
  recolorView = t.dataset.rview;
  recolorRender();
});
// slider chỉnh cỡ / vị trí design khi xem trên áo
// vị trí/cỡ design khi lên áo (tâm xPct,yPct + bề ngang wPct) — áp cho mọi áo
const recolorState = { xPct: 50, yPct: 40, wPct: 42 };

// nạp áo + design đại diện (item đầu) vào khung chỉnh + đặt layer theo state
function recolorApplyStage() {
  const rep = recolorItems[0];
  const shirtUrl = rep && recolorShirtMap[rep.color];
  const sEl = $("recolorStageShirt"), layer = $("recolorLayer");
  if (rep && shirtUrl) {
    sEl.src = shirtUrl; sEl.classList.add("active");
    $("recolorLayerImg").src = "data:image/png;base64," + rep.image;
    layer.classList.add("active");
    $("recolorStageEmpty").style.display = "none";
  } else {
    sEl.classList.remove("active"); layer.classList.remove("active");
    $("recolorStageEmpty").style.display = "";
  }
  layer.style.left = recolorState.xPct + "%";
  layer.style.top = recolorState.yPct + "%";
  layer.style.width = recolorState.wPct + "%";
  if ($("recolorDsize")) $("recolorDsize").value = Math.round(recolorState.wPct);
}
$("recolorDsize").addEventListener("input", () => {
  recolorState.wPct = parseInt($("recolorDsize").value, 10);
  recolorApplyStage();
  if (recolorView === "shirt") recolorRender();
});
/* Kéo-thả di chuyển + kéo góc resize (giống mockup) */
(() => {
  const stage = $("recolorStage"), layer = $("recolorLayer"), handle = $("recolorHandle");
  let drag = null, rs = null;
  layer.addEventListener("pointerdown", (e) => {
    if (e.target.id === "recolorHandle") return;
    e.preventDefault();
    kbSetTarget(layer, () => recolorState, () => { recolorApplyStage(); recolorRender(); });
    drag = { r: stage.getBoundingClientRect(), sx: e.clientX, sy: e.clientY, x0: recolorState.xPct, y0: recolorState.yPct };
    layer.setPointerCapture(e.pointerId);
  });
  layer.addEventListener("pointermove", (e) => {
    if (!drag) return;
    recolorState.xPct = Math.max(0, Math.min(100, drag.x0 + (e.clientX - drag.sx) / drag.r.width * 100));
    recolorState.yPct = Math.max(0, Math.min(100, drag.y0 + (e.clientY - drag.sy) / drag.r.height * 100));
    recolorApplyStage(); recolorRender();
  });
  layer.addEventListener("pointerup", () => { drag = null; });
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault(); e.stopPropagation();
    rs = { r: stage.getBoundingClientRect(), sx: e.clientX, w0: recolorState.wPct };
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener("pointermove", (e) => {
    if (!rs) return;
    recolorState.wPct = Math.max(8, Math.min(95, rs.w0 + (e.clientX - rs.sx) / rs.r.width * 100 * 2));
    recolorApplyStage(); recolorRender();
  });
  handle.addEventListener("pointerup", () => { rs = null; });
})();
$("recolorSelAll").onchange = (e) => {
  recolorSel.clear();
  if (e.target.checked) recolorItems.forEach((_, i) => recolorSel.add(i));
  document.querySelectorAll("#recolorResults .gpick").forEach((c, i) => { c.checked = e.target.checked; });
  recolorUpdateSelUI();
};
$("recolorDownloadSel").onclick = async () => {
  const cards = [...$("recolorResults").querySelectorAll(".gcard")];
  const picked = [...recolorSel].sort((a, b) => a - b);
  if (!picked.length) { const n = $("recolorNote"); n.className = "gen-note err"; n.textContent = "⚠️ Chưa chọn bản nào để tải."; return; }
  for (const i of picked) {
    const cd = cards[i]; if (!cd) continue;
    autoDownload(cd._cur, cd._title || ("ban_" + i));
    await new Promise(r => setTimeout(r, 350));   // giãn cách để trình duyệt không chặn
  }
};

$("recolorRunBtn").onclick = async () => {
  const note = $("recolorNote"); note.className = "gen-note"; note.textContent = "";
  if (!recolorImg) { note.className = "gen-note err"; note.textContent = "⚠️ Hãy tải design hoặc bấm 'Dùng design đang mở'."; return; }
  const prompt = ($("recolorPrompt") && $("recolorPrompt").value || "").trim();
  if (!prompt) { note.className = "gen-note err"; note.textContent = "⚠️ Viết prompt đổi màu (áo màu gì · nền nào · giữ/đổi màu nào)."; return; }
  $("recolorEmpty").classList.add("hidden");
  const size = $("recolorSize").value;
  const N = Math.max(1, Math.min(parseInt($("recolorCount") && $("recolorCount").value, 10) || 4, 6));   // số bản
  const VNOTES = recolorVariantNotes(N);
  $("recolorResults").innerHTML = '<div class="gallery-empty">🎨 AI đang tạo ' + N + ' bản theo prompt — song song, hiện dần…</div>';
  const allItems = [];
  let okCnt = 0, errCnt = 0;
  const jobs = [];
  for (let k = 0; k < N; k++) {
    jobs.push((async (vi) => {
      const tid = loadTaskAdd("🎨 Bản " + (vi + 1) + "/" + N + "…");
      try {
        const r = await fetch("/api/recolor", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: recolorImg, prompt: prompt, size: size, note: (N > 1 ? VNOTES[vi] : "") }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || "Lỗi");
        const it = (data.items || [])[0];
        if (!it || !it.image) throw new Error("AI không trả kết quả.");
        it.title = "Bản " + (vi + 1);
        allItems.push(it); okCnt++;
        await recolorRender(allItems.slice());     // hiện dần
        loadTaskDone(tid, true, "✓ Bản " + (vi + 1));
      } catch (e) {
        errCnt++; loadTaskDone(tid, false, "✕ Bản " + (vi + 1) + ": " + e.message);
      }
      note.className = "gen-note"; note.textContent = "🎨 Đã xong " + okCnt + "/" + N + " bản…";
    })(k));
  }
  await Promise.all(jobs);
  if (!allItems.length) {
    $("recolorResults").innerHTML = "";
    $("recolorEmpty").classList.remove("hidden");
    $("recolorEmpty").textContent = "✗ Đổi màu lỗi cả " + N + " bản.";
    note.className = "gen-note err"; note.textContent = "✗ Không tạo được bản nào.";
    return;
  }
  await recolorRender(allItems.slice());   // render cuối -> hiện đủ tất cả bản
  note.className = "gen-note ok";
  note.textContent = "✓ Xong " + okCnt + " bản (giữ bản đẹp nhất, tải về). Đã lưu Lịch sử." + (errCnt ? " (" + errCnt + " bản lỗi)" : "");
  if (typeof loadGallery === "function") loadGallery();
};

/* =====================================================================
   TÍNH NĂNG: THÊM NỀN DƯỚI DESIGN (màu trơn / gradient — render client)
   ===================================================================== */
let bgImg = null;        // dataURL design đầu vào
let bgKind = "solid";    // "solid" | "gradient"
let bgResultB64 = null;  // base64 (không prefix) ảnh đã ghép nền

function bgRenderThumb() {
  const row = $("bgThumbs"); row.innerHTML = "";
  if (!bgImg) return;
  const d = document.createElement("div");
  d.className = "thumb";
  d.innerHTML = '<img src="' + bgImg + '" alt=""><button class="thumb-x">×</button>';
  d.querySelector(".thumb-x").onclick = () => { bgImg = null; bgRenderThumb(); bgRender(); };
  row.appendChild(d);
}
$("bgFileInput").onchange = async (e) => {
  const f = e.target.files[0];
  if (f && f.type.startsWith("image/")) { bgImg = await fileToDataURL(f); bgRenderThumb(); bgRender(); }
};
(() => {
  const dz = $("bgDrop");
  dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("drag"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
  dz.addEventListener("drop", async e => {
    e.preventDefault(); dz.classList.remove("drag");
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith("image/")) { bgImg = await fileToDataURL(f); bgRenderThumb(); bgRender(); }
  });
})();
$("bgUseCurrent").onclick = () => {
  if (!currentDesign) { const n = $("bgNote"); n.className = "gen-note err"; n.textContent = "⚠️ Chưa có design nào đang mở ở tab Clone Design."; return; }
  bgImg = "data:image/png;base64," + currentDesign;
  bgRenderThumb(); bgRender();
  const n = $("bgNote"); n.className = "gen-note ok"; n.textContent = "✓ Đã nạp design đang mở.";
};

// chuyển kiểu nền
document.querySelectorAll("#bgKindTabs .tab").forEach(t => t.onclick = () => {
  document.querySelectorAll("#bgKindTabs .tab").forEach(x => x.classList.remove("active"));
  t.classList.add("active");
  bgKind = t.dataset.bgkind;
  $("bgSolidPane").classList.toggle("hidden", bgKind !== "solid");
  $("bgGradientPane").classList.toggle("hidden", bgKind !== "gradient");
  bgRender();
});
// đổi màu/hướng -> render lại
["bgColor1", "bgGcolor1", "bgGcolor2", "bgGdir"].forEach(id => $(id).addEventListener("input", bgRender));

function bgRender() {
  if (!bgImg) {
    $("bgPreview").classList.add("hidden");
    $("bgEmpty").classList.remove("hidden");
    $("bgActions").classList.add("hidden");
    bgResultB64 = null;
    return;
  }
  const img = new Image();
  img.onload = () => {
    const w = img.naturalWidth, h = img.naturalHeight;
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const x = c.getContext("2d");
    if (bgKind === "gradient") {
      const dir = $("bgGdir").value;
      const g = dir === "h" ? x.createLinearGradient(0, 0, w, 0)
              : dir === "d" ? x.createLinearGradient(0, 0, w, h)
              :               x.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, $("bgGcolor1").value);
      g.addColorStop(1, $("bgGcolor2").value);
      x.fillStyle = g;
    } else {
      x.fillStyle = $("bgColor1").value;
    }
    x.fillRect(0, 0, w, h);
    x.drawImage(img, 0, 0, w, h);
    const durl = c.toDataURL("image/png");
    bgResultB64 = durl.split(",")[1];
    $("bgPreview").src = durl;
    $("bgPreview").classList.remove("hidden");
    $("bgEmpty").classList.add("hidden");
    $("bgActions").classList.remove("hidden");
  };
  img.src = bgImg;
}

$("bgDownload").onclick = () => { if (bgResultB64) autoDownload(bgResultB64, "design-co-nen"); };
$("bgUseShirt").onclick = () => {
  if (!bgResultB64) return;
  showApp("clone");
  showDesign(bgResultB64);
  document.querySelector('.rtab[data-rtab="design"]').click();
};
$("bgSaveBtn").onclick = async () => {
  const note = $("bgNote"); note.className = "gen-note"; note.textContent = "";
  if (!bgResultB64) { note.className = "gen-note err"; note.textContent = "⚠️ Chưa có ảnh để lưu."; return; }
  const btn = $("bgSaveBtn"); btn.disabled = true;
  try {
    const r = await fetch("/api/save-design", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: bgResultB64, mode: "bg", label: "Design + nền" }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Lỗi không xác định");
    note.className = "gen-note ok"; note.textContent = "✓ Đã lưu vào Lịch sử (tab Clone Design).";
    if (typeof loadGallery === "function") loadGallery();
  } catch (err) {
    note.className = "gen-note err"; note.textContent = "✗ " + err.message;
  } finally {
    btn.disabled = false;
  }
};

/* =====================================================================
   MODAL PHÓNG TO ẢNH (dùng chung)
   ===================================================================== */
function openZoom(src) {
  $("zoomImg").src = src;
  $("zoomModal").classList.remove("hidden");
}
function closeZoom() { $("zoomModal").classList.add("hidden"); $("zoomImg").src = ""; }
$("zoomClose").onclick = closeZoom;
$("zoomModal").onclick = (e) => { if (e.target.id === "zoomModal") closeZoom(); };
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeZoom(); });
$("zoomDl").onclick = (e) => {
  e.stopPropagation();
  const a = document.createElement("a");
  a.href = $("zoomImg").src; a.download = "design-" + Date.now() + ".png"; a.click();
};
// Copy ảnh vào clipboard để dán/gửi chỗ khác. Trả Promise<bool>. Chuẩn hoá PNG để dán được mọi nơi.
async function copyImageToClipboard(src, btn) {
  const old = btn ? btn.textContent : "";
  try {
    let blob = await (await fetch(src)).blob();
    // Safari/Chrome chỉ chấp nhận image/png khi ghi clipboard -> ép về PNG qua canvas nếu cần
    if (blob.type !== "image/png") {
      const bmp = await createImageBitmap(blob);
      const cv = document.createElement("canvas"); cv.width = bmp.width; cv.height = bmp.height;
      cv.getContext("2d").drawImage(bmp, 0, 0);
      blob = await new Promise(r => cv.toBlob(r, "image/png"));
    }
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    if (btn) { btn.textContent = "✓ Đã copy"; setTimeout(() => btn.textContent = old, 1400); }
    return true;
  } catch (err) {
    if (btn) { btn.textContent = "✗ Bị chặn"; setTimeout(() => btn.textContent = old, 1800); }
    return false;
  }
}
$("zoomCopy").onclick = (e) => { e.stopPropagation(); copyImageToClipboard($("zoomImg").src, $("zoomCopy")); };

/* =====================================================================
   ĐỔI MÀU ÁO: xem "Trên áo thật" + chọn nhiều + tải hàng loạt
   ===================================================================== */
let recolorView = "bg";          // "bg" | "shirt"
let recolorShirtMap = null;      // color -> url ảnh áo thật
const recolorSel = new Set();    // index card đang chọn

// map màu recolor -> ảnh áo mockup (khớp theo nhãn "Áo <màu>")
async function recolorLoadShirts() {
  if (recolorShirtMap) return recolorShirtMap;
  recolorShirtMap = {};
  try {
    const data = await (await fetch("/api/mockups")).json();
    const items = (data.items || []).filter(it => it.side !== "back");
    RECOLOR_LIST.forEach(c => {
      const want = ("áo " + c.vi).toLowerCase();
      const hit = items.find(it => (it.name || "").toLowerCase() === want);
      if (hit) recolorShirtMap[c.key] = hit.url;
    });
  } catch (e) { /* không có áo -> bỏ qua */ }
  return recolorShirtMap;
}

// ghép design (trong suốt) lên ảnh ÁO THẬT theo state (tâm xPct,yPct + bề ngang wPct)
async function recolorOnShirt(designB64, shirtUrl, st) {
  try {
    const shirt = await loadImg(shirtUrl);
    const des = await loadImg("data:image/png;base64," + designB64);
    const sw = shirt.naturalWidth, sh = shirt.naturalHeight;
    const c = document.createElement("canvas"); c.width = sw; c.height = sh;
    const x = c.getContext("2d");
    x.drawImage(shirt, 0, 0, sw, sh);
    const dw = sw * ((st.wPct || 42) / 100);
    const scale = dw / des.naturalWidth;
    const dh = des.naturalHeight * scale;
    const dx = sw * ((st.xPct || 50) / 100) - dw / 2;
    const dy = sh * ((st.yPct || 40) / 100) - dh / 2;
    x.drawImage(des, dx, dy, dw, dh);
    return c.toDataURL("image/png");
  } catch (e) { return null; }
}

function recolorUpdateSelUI() {
  $("recolorDownloadSel").textContent = "⬇ Tải đã chọn (" + recolorSel.size + ")";
}

/* =====================================================================
   TÍNH NĂNG: LÊN ÁO (ghép design lên áo mockup, chỉnh cỡ/vị trí, tải hàng loạt)
   ===================================================================== */
const _imgCache = {};            // url/dataURL -> Promise<Image>
function loadImg(src) {
  if (_imgCache[src]) return _imgCache[src];
  _imgCache[src] = new Promise((res, rej) => {
    const im = new Image(); im.crossOrigin = "anonymous";
    im.onload = () => res(im); im.onerror = () => rej(new Error("img"));
    im.src = src;
  });
  return _imgCache[src];
}

let lenaoSlots = [];             // [{url,name,design,designImg,state:{xPct,yPct,wPct}}]
let lenaoInited = false;

let lenaoBaseShirts = [];   // áo mẫu (template) -> nhân cho mỗi design
async function lenaoInit() {
  if (lenaoInited) return; lenaoInited = true;
  try {
    const data = await (await fetch("/api/mockups")).json();
    lenaoBaseShirts = (data.items || []).filter(it => it.side !== "back" && /trang|trắng|white|_den|đen|black/i.test((it.file || "") + " " + (it.name || ""))).map(it => ({ url: it.url, name: it.name || "Áo" }));
    lenaoSlots = lenaoBaseShirts.map(s => ({
      url: s.url, name: s.name, design: null, designImg: null,
      state: { xPct: 50, yPct: 40, wPct: 42 },
    }));
  } catch (e) { lenaoBaseShirts = []; lenaoSlots = []; }
  lenaoBindPaste();
  lenaoRenderSlots();
}

// TẢI NHIỀU DESIGN: mỗi design tạo 1 bộ áo (trắng+đen) riêng, đã căn giữa
let _lenaoDesignSeq = 0;
async function lenaoAddDesigns(durls) {
  if (!lenaoBaseShirts.length) { alert("Chưa có áo mockup."); return; }
  for (const durl of durls) {
    _lenaoDesignSeq++;
    const img = await loadImg(durl).catch(() => null);
    lenaoBaseShirts.forEach(s => {
      lenaoSlots.push({ url: s.url, name: s.name + " · DS" + _lenaoDesignSeq,
        design: durl, designImg: img, state: { xPct: 50, yPct: 44, wPct: 42 } });
    });
  }
  lenaoRenderSlots();
  const n = $("lenaoNote"); if (n) { n.className = "gen-note ok"; n.textContent = "✓ Đã thêm " + durls.length + " design × " + lenaoBaseShirts.length + " áo."; }
}

// đặt design cho 1 slot
// Căn design vào GIỮA áo (ngang giữa + chính giữa vùng ngực). keepSize: giữ cỡ hiện tại.
function lenaoCenter(slot, keepSize) {
  const w = (keepSize && slot.state && slot.state.wPct) ? slot.state.wPct : 42;
  slot.state = { xPct: 50, yPct: 44, wPct: w };
}
async function lenaoSetSlotDesign(slot, durl) {
  slot.design = durl;
  try { slot.designImg = await loadImg(durl); } catch (e) { slot.designImg = null; }
  lenaoCenter(slot, true);   // tự căn giữa khi vừa lên áo
  lenaoRenderSlots();
}

// ===== Dán ảnh (copy/paste) vào từng áo =====
let lenaoPasteTarget = null;      // slot đang chọn để dán
let lenaoPasteBound = false;
function lenaoSetPasteTarget(slot) {
  lenaoPasteTarget = slot;
  document.querySelectorAll("#lenaoSlots .lslot").forEach((el, i) => {
    el.classList.toggle("paste-target", lenaoSlots[i] === slot);
  });
}
// thử đọc ảnh trực tiếp từ clipboard (Clipboard API) -> true nếu dán được
async function lenaoPasteFromClipboard(slot) {
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const type = (it.types || []).find(t => t.startsWith("image/"));
      if (type) {
        const blob = await it.getType(type);
        await lenaoSetSlotDesign(slot, await fileToDataURL(blob));
        return true;
      }
    }
  } catch (e) { /* không có quyền / không phải ảnh -> fallback Ctrl+V */ }
  return false;
}
// Ctrl+V: dán ảnh vào áo đang chọn (chỉ khi đang ở tab Lên áo)
function lenaoBindPaste() {
  if (lenaoPasteBound) return; lenaoPasteBound = true;
  document.addEventListener("paste", async (e) => {
    const view = document.getElementById("view-lenao");
    if (!view || view.classList.contains("hidden") || !lenaoPasteTarget) return;
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const it of items) {
      if (it.type && it.type.startsWith("image/")) {
        e.preventDefault();
        const blob = it.getAsFile();
        if (blob) await lenaoSetSlotDesign(lenaoPasteTarget, await fileToDataURL(blob));
        return;
      }
    }
  });
}

function lenaoApplyLayer(layer, st) {
  layer.style.left = st.xPct + "%"; layer.style.top = st.yPct + "%"; layer.style.width = st.wPct + "%";
}

// gắn kéo-thả + resize cho 1 slot
function lenaoAttachEditor(stage, layer, handle, slot) {
  let drag = null, rs = null;
  layer.addEventListener("pointerdown", (e) => {
    if (e.target === handle) return;
    e.preventDefault();
    kbSetTarget(layer, () => slot.state, () => lenaoApplyLayer(layer, slot.state));
    drag = { r: stage.getBoundingClientRect(), sx: e.clientX, sy: e.clientY, x0: slot.state.xPct, y0: slot.state.yPct };
    layer.setPointerCapture(e.pointerId);
  });
  layer.addEventListener("pointermove", (e) => {
    if (!drag) return;
    slot.state.xPct = Math.max(0, Math.min(100, drag.x0 + (e.clientX - drag.sx) / drag.r.width * 100));
    slot.state.yPct = Math.max(0, Math.min(100, drag.y0 + (e.clientY - drag.sy) / drag.r.height * 100));
    lenaoApplyLayer(layer, slot.state);
  });
  layer.addEventListener("pointerup", () => { drag = null; });
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault(); e.stopPropagation();
    rs = { r: stage.getBoundingClientRect(), sx: e.clientX, w0: slot.state.wPct };
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener("pointermove", (e) => {
    if (!rs) return;
    slot.state.wPct = Math.max(8, Math.min(95, rs.w0 + (e.clientX - rs.sx) / rs.r.width * 100 * 2));
    lenaoApplyLayer(layer, slot.state);
  });
  handle.addEventListener("pointerup", () => { rs = null; });
}

function lenaoUpdateSelUI() {
  const n = [...document.querySelectorAll("#lenaoSlots .gpick")].filter(c => c.checked && !c.disabled).length;
  $("lenaoDownloadSel").textContent = "⬇ Tải đã chọn (" + n + ")";
  if ($("lenaoToShopify")) $("lenaoToShopify").textContent = "🛍️ Đẩy Shopify (" + n + ")";
}
// màu áo (mockup) -> tên màu CHUẨN Shopify (khớp swatch)
const LENAO_COLOR_STD = {
  "trắng": "Màu trắng", "trang": "Màu trắng", "đen": "Màu đen", "den": "Màu đen",
  "be": "Màu be", "nâu": "Màu nâu", "nau": "Màu nâu", "đỏ": "Màu đỏ", "do": "Màu đỏ",
  "đỏ đô": "Đỏ đô", "do do": "Đỏ đô", "xanh rêu": "Màu xanh rêu", "xanh reu": "Màu xanh rêu",
};
function lenaoColorStd(name) {
  const c = (name || "").replace(/^áo\s+/i, "").trim();
  return LENAO_COLOR_STD[c.toLowerCase()] || (c ? ("Màu " + c) : "Mặc định");
}
// Lấy các áo đã chọn (có design) -> ghép ảnh -> nạp vào tab Đẩy Shopify
async function lenaoPushToShopify() {
  const picked = lenaoSlots.filter((s, i) => {
    const card = $("lenaoSlots").children[i];
    const c = card && card.querySelector(".gpick");
    return s.design && c && c.checked;
  });
  if (!picked.length) { alert("Chưa chọn áo nào có design để đẩy."); return; }
  const btn = $("lenaoToShopify"), old = btn.textContent;
  btn.disabled = true; btn.textContent = "⏳ Đang ghép…";
  try {
    // Gộp tất cả áo đã chọn thành 1 SẢN PHẨM, mỗi áo = 1 variant màu (có ảnh riêng)
    const variants = [];
    for (const s of picked) {
      const durl = await lenaoComposeSlot(s);
      variants.push({ image: durl.split(",")[1], color: lenaoColorStd(s.name) });
    }
    shopItems.push({ title: "", description: "", price: "", status: "DRAFT", result: null, variants });
    showApp("shopify");
    shopRender();
    const note = $("shopNote"); note.className = "gen-note ok";
    note.textContent = "✓ Đã tạo 1 sản phẩm với " + variants.length + " variant màu — nhập giá rồi bấm Đẩy.";
  } finally {
    btn.disabled = false; btn.textContent = old;
  }
}

function lenaoRenderSlots() {
  const grid = $("lenaoSlots");
  if (!lenaoSlots.length) { grid.innerHTML = ""; $("lenaoEmpty").classList.remove("hidden"); $("lenaoEmpty").textContent = "Chưa có áo mockup. Tải áo ở tab Clone Design → Mockup."; return; }
  $("lenaoEmpty").classList.add("hidden");
  const allChecked = $("lenaoSelAll").checked;
  grid.innerHTML = "";
  lenaoSlots.forEach((slot, i) => {
    const card = document.createElement("div");
    card.className = "lslot";
    const has = !!slot.design;
    card.innerHTML =
      '<div class="lhead"><input type="checkbox" class="gpick"' + (has && allChecked ? " checked" : "") + (has ? "" : " disabled") + '>' + slot.name + '</div>' +
      '<div class="le-stage">' +
        '<img class="le-shirt active" src="' + slot.url + '" alt="">' +
        '<div class="le-layer' + (has ? " active" : "") + '"><img alt=""><span class="le-handle"></span></div>' +
        '<div class="le-empty"' + (has ? ' style="display:none"' : "") + '>📁 Tải design cho áo này</div>' +
      '</div>' +
      '<div class="lacts"><label>📁 ' + (has ? "Đổi" : "Design") + '<input type="file" accept="image/*" hidden></label>' +
        '<button class="b-paste">📋 Dán ảnh</button>' +
        (has ? '<button class="b-center">🎯 Căn giữa</button>' : "") +
        (has ? '<button class="b-del">🗑️ Xoá</button>' : "") +
        '<button class="b-dl">⬇ Tải</button></div>';
    const stage = card.querySelector(".le-stage");
    const layer = card.querySelector(".le-layer");
    const layerImg = layer.querySelector("img");
    const handle = card.querySelector(".le-handle");
    if (has) { layerImg.src = slot.design; lenaoApplyLayer(layer, slot.state); }
    lenaoAttachEditor(stage, layer, handle, slot);
    // tải design riêng cho áo này (qua nút hoặc bấm vùng trống)
    const fileInput = card.querySelector('.lacts input[type=file]');
    fileInput.onchange = async (e) => { const f = e.target.files[0]; if (f && f.type.startsWith("image/")) { await lenaoSetSlotDesign(slot, await fileToDataURL(f)); } e.target.value = ""; };
    card.querySelector(".le-empty").onclick = () => fileInput.click();
    // chọn áo này làm đích dán (Ctrl+V) khi bấm vào ô
    card.addEventListener("mousedown", () => lenaoSetPasteTarget(slot));
    if (lenaoPasteTarget === slot) card.classList.add("paste-target");
    card.querySelector(".b-paste").onclick = async () => {
      lenaoSetPasteTarget(slot);
      const ok = await lenaoPasteFromClipboard(slot);
      if (!ok) {
        const note = $("lenaoNote");
        if (note) { note.className = "gen-note"; note.textContent = "📋 Đã chọn áo \"" + slot.name + "\" — bấm Ctrl+V (Cmd+V) để dán ảnh vào."; }
      }
    };
    card.querySelector(".gpick").onchange = lenaoUpdateSelUI;
    const centerBtn = card.querySelector(".b-center");
    if (centerBtn) centerBtn.onclick = () => {
      lenaoCenter(slot, true);   // căn giữa, giữ nguyên cỡ
      lenaoApplyLayer(layer, slot.state);
    };
    const delBtn = card.querySelector(".b-del");
    if (delBtn) delBtn.onclick = () => {
      slot.design = null; slot.designImg = null;
      slot.state = { xPct: 50, yPct: 40, wPct: 42 };
      lenaoRenderSlots();
    };
    card.querySelector(".b-dl").onclick = async () => {
      if (!slot.designImg) { alert("Áo này chưa có design."); return; }
      const durl = await lenaoComposeSlot(slot);
      autoDownload(durl.split(",")[1], slot.name + "_design");
    };
    grid.appendChild(card);
  });
  lenaoUpdateSelUI();
}

// ghép design lên áo theo state -> dataURL (full độ phân giải áo)
async function lenaoComposeSlot(slot) {
  const shirt = await loadImg(slot.url);
  const des = slot.designImg || await loadImg(slot.design);
  const sw = shirt.naturalWidth, sh = shirt.naturalHeight;
  const c = document.createElement("canvas"); c.width = sw; c.height = sh;
  const x = c.getContext("2d");
  x.drawImage(shirt, 0, 0, sw, sh);
  const dw = sw * (slot.state.wPct / 100);
  const scale = dw / des.naturalWidth;
  const dh = des.naturalHeight * scale;
  const dx = sw * (slot.state.xPct / 100) - dw / 2;
  const dy = sh * (slot.state.yPct / 100) - dh / 2;
  x.drawImage(des, dx, dy, dw, dh);
  return c.toDataURL("image/png");
}

// design dùng chung -> áp cho tất cả áo
async function lenaoApplyAll(durl) {
  const img = await loadImg(durl).catch(() => null);
  lenaoSlots.forEach(s => { s.design = durl; s.designImg = img; lenaoCenter(s, true); });
  lenaoRenderSlots();
}
$("lenaoAllFile").onchange = async (e) => { const f = e.target.files[0]; if (f && f.type.startsWith("image/")) await lenaoApplyAll(await fileToDataURL(f)); e.target.value = ""; };
// tải NHIỀU design -> mỗi design 1 bộ áo
async function _lenaoFilesToDesigns(files) {
  const durls = [];
  for (const f of files) { if (f && f.type.startsWith("image/")) durls.push(await fileToDataURL(f)); }
  if (durls.length) await lenaoAddDesigns(durls);
}
if ($("lenaoMultiFile")) $("lenaoMultiFile").onchange = async (e) => { await _lenaoFilesToDesigns(e.target.files); e.target.value = ""; };
(() => {
  const dz = $("lenaoAllDrop");
  dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("drag"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
  dz.addEventListener("drop", async e => { e.preventDefault(); dz.classList.remove("drag"); const f = e.dataTransfer.files[0]; if (f && f.type.startsWith("image/")) await lenaoApplyAll(await fileToDataURL(f)); });
  const md = $("lenaoMultiDrop");
  if (md) {
    md.addEventListener("dragover", e => { e.preventDefault(); md.classList.add("drag"); });
    md.addEventListener("dragleave", () => md.classList.remove("drag"));
    md.addEventListener("drop", async e => { e.preventDefault(); md.classList.remove("drag"); await _lenaoFilesToDesigns(e.dataTransfer.files); });
  }
})();
$("lenaoUseCurrentAll").onclick = () => {
  if (!currentDesign) { alert("Chưa có design nào đang mở ở tab Clone Design."); return; }
  lenaoApplyAll("data:image/png;base64," + currentDesign);
};
if ($("lenaoCenterAll")) $("lenaoCenterAll").onclick = () => {
  if (!lenaoSlots.some(s => s.design)) { alert("Chưa có áo nào có design."); return; }
  lenaoSlots.forEach(s => { if (s.design) lenaoCenter(s, true); });   // căn giữa, giữ cỡ
  lenaoRenderSlots();
};
$("lenaoClearAll").onclick = () => {
  if (!lenaoSlots.some(s => s.design)) return;
  if (!confirm("Xoá design khỏi tất cả áo?")) return;
  lenaoSlots.forEach(s => { s.design = null; s.designImg = null; s.state = { xPct: 50, yPct: 40, wPct: 42 }; });
  lenaoRenderSlots();
};
$("lenaoSelAll").onchange = (e) => {
  document.querySelectorAll("#lenaoSlots .gpick").forEach(c => { if (!c.disabled) c.checked = e.target.checked; });
  lenaoUpdateSelUI();
};
$("lenaoToShopify").onclick = lenaoPushToShopify;
$("lenaoDownloadSel").onclick = async () => {
  const picked = lenaoSlots.filter((s, i) => {
    const card = $("lenaoSlots").children[i];
    const c = card && card.querySelector(".gpick");
    return s.design && c && c.checked;
  });
  if (!picked.length) { alert("Chưa chọn áo nào có design để tải."); return; }
  for (const s of picked) {
    const durl = await lenaoComposeSlot(s);
    autoDownload(durl.split(",")[1], s.name + "_design");
    await new Promise(r => setTimeout(r, 350));
  }
};

/* =====================================================================
   TÍNH NĂNG: EXCEL HÀNG LOẠT (ảnh nhúng + Tên/Ngày -> gen nhiều luồng)
   ===================================================================== */
let batchFileB64 = null;
let batchPollTimer = null;

$("batchFile").onchange = (e) => {
  const f = e.target.files[0]; if (!f) return;
  $("batchFileName").textContent = "📄 " + f.name;
  const r = new FileReader();
  r.onload = () => { batchFileB64 = r.result.split(",")[1]; };
  r.readAsDataURL(f);
};

function batchRenderResults(items) {
  const grid = $("batchResults");
  if (!items.length) { $("batchEmpty").classList.remove("hidden"); grid.innerHTML = ""; return; }
  $("batchEmpty").classList.add("hidden");
  grid.innerHTML = "";
  items.forEach(it => {
    const card = document.createElement("div");
    card.className = "gcard";
    card.innerHTML =
      '<img src="data:image/png;base64,' + it.image + '" alt="">' +
      '<div class="gmeta">' + (it.title || "Mẫu") + '</div>' +
      '<div class="gacts"><button class="b-zoom">🔍 Phóng to</button><button class="b-copy">📋 Copy</button><button class="b-dl">⬇ Tải</button></div>';
    card._cur = it.image; card._name = it.title || "mau";
    card.querySelector("img").onclick = () => openZoom("data:image/png;base64," + it.image);
    card.querySelector(".b-zoom").onclick = () => openZoom("data:image/png;base64," + it.image);
    card.querySelector(".b-copy").onclick = (e) => copyImageToClipboard("data:image/png;base64," + it.image, e.currentTarget);
    card.querySelector(".b-dl").onclick = () => autoDownload(it.image, it.title || "mau");
    grid.appendChild(card);
  });
  $("batchDownloadAll").textContent = "⬇ Tải tất cả (" + items.length + ")";
}

async function batchPoll(jobId) {
  try {
    const d = await (await fetch("/api/batch-status?id=" + encodeURIComponent(jobId))).json();
    const pct = d.total ? Math.round((d.done / d.total) * 100) : 0;
    $("batchBar").style.width = pct + "%";
    $("batchProgText").textContent = "Đã xong " + d.done + "/" + d.total + " · ✓ " + (d.items || []).length + " mẫu" + (d.errors && d.errors.length ? " · ⚠️ " + d.errors.length + " lỗi" : "");
    batchRenderResults(d.items || []);
    $("batchErrors").innerHTML = (d.errors || []).map(e => "<div>⚠️ " + e + "</div>").join("");
    if (d.finished) {
      clearInterval(batchPollTimer); batchPollTimer = null;
      $("batchRunBtn").disabled = false;
      $("batchNote").className = "gen-note ok";
      $("batchNote").textContent = "✓ Xong! " + (d.items || []).length + "/" + d.total + " mẫu (đã lưu Lịch sử).";
      if (typeof loadGallery === "function") loadGallery();
    }
  } catch (e) { /* tiếp tục poll */ }
}

$("batchRunBtn").onclick = async () => {
  const note = $("batchNote"); note.className = "gen-note"; note.textContent = "";
  if (!batchFileB64) { note.className = "gen-note err"; note.textContent = "⚠️ Hãy chọn file Excel (.xlsx) trước."; return; }
  const btn = $("batchRunBtn"); btn.disabled = true;
  $("batchErrors").innerHTML = "";
  $("batchProgress").classList.remove("hidden");
  $("batchBar").style.width = "0%"; $("batchProgText").textContent = "Đang đọc Excel…";
  try {
    const r = await fetch("/api/batch-excel", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: batchFileB64, size: $("batchSize").value, transparent: $("batchTransparent").value === "1" }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Lỗi không xác định");
    $("batchProgText").textContent = "Bắt đầu gen " + d.total + " mẫu (nhiều luồng)…";
    if (batchPollTimer) clearInterval(batchPollTimer);
    batchPollTimer = setInterval(() => batchPoll(d.job_id), 2000);
    batchPoll(d.job_id);
  } catch (err) {
    note.className = "gen-note err"; note.textContent = "✗ " + err.message;
    btn.disabled = false;
    $("batchProgress").classList.add("hidden");
  }
};
(() => {
  const dz = $("batchDrop");
  dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("drag"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
  dz.addEventListener("drop", e => {
    e.preventDefault(); dz.classList.remove("drag");
    const f = e.dataTransfer.files[0]; if (!f) return;
    $("batchFileName").textContent = "📄 " + f.name;
    const r = new FileReader(); r.onload = () => { batchFileB64 = r.result.split(",")[1]; }; r.readAsDataURL(f);
  });
})();
$("batchDownloadAll").onclick = async () => {
  const cards = [...$("batchResults").querySelectorAll(".gcard")];
  if (!cards.length) return;
  for (const cd of cards) { autoDownload(cd._cur, cd._name); await new Promise(r => setTimeout(r, 350)); }
};

/* =====================================================================
   ẢNH SẢN PHẨM — kiểu Freepik: prompt + ảnh tham chiếu -> gen
   ===================================================================== */
let prodInited = false;
let prodRefs = [];            // ảnh tham chiếu (data URL / url)
let prodCreations = [];       // {image?, url?, id?, prompt, engine, aspect, gallery}
let prodSel = new Set();      // key ảnh đã tick để đưa vào Shopify
let prodView = "list";
let prodStyle = null;         // ảnh style để copy phong cách (tuỳ chọn)
let prodPollTimer = null;

function prodInit() {
  if (prodInited) { prodLoadHistory(); return; }
  prodInited = true;
  prodCheckEngine();
  $("prodFile").onchange = async (e) => { for (const f of e.target.files) { if (f.type.startsWith("image/")) prodRefs.push(await fileToDataURL(f)); } e.target.value = ""; prodRenderRefs(); };
  $("prodUseCurrent").onclick = () => { if (!currentDesign) { alert("Chưa có design đang mở ở Clone Design."); return; } prodRefs.push("data:image/png;base64," + currentDesign); prodRenderRefs(); };
  $("prodStyleFile").onchange = async (e) => { const f = e.target.files[0]; if (f && f.type.startsWith("image/")) { prodStyle = await fileToDataURL(f); prodRenderStyle(); } e.target.value = ""; };
  $("prodSuggestBtn").onclick = prodSuggest;
  $("prodRunBtn").onclick = () => prodGenerate($("prodPrompt").value, parseInt($("prodCount").value, 10) || 1);
  $("prodViewList").onclick = () => prodSetView("list");
  $("prodViewGrid").onclick = () => prodSetView("grid");
  $("prodHistRefresh").onclick = prodLoadHistory;
  $("prodToShopify").onclick = prodPushSel;
  prodRenderRefs();
  prodRenderStyle();
  prodLoadHistory();
}

// cho phép tab khác nạp ảnh tham chiếu (vd SP Shopify -> Ảnh sản phẩm)
function prodAddRef(src) { if (src) { prodRefs.push(src); if (prodInited) prodRenderRefs(); } }

async function prodCheckEngine() {
  try {
    const d = await (await fetch("/api/engines")).json();
    const sel = $("prodEngine"), hint = $("prodNanoHint");
    const engines = d.engines || [];
    sel.innerHTML = "";
    engines.forEach(e => { const o = document.createElement("option"); o.value = e.id; o.textContent = e.label + (e.available ? "" : " — chưa có key"); o.disabled = !e.available; sel.appendChild(o); });
    const def = d.default_engine || (engines.find(e => e.available) || {}).id;
    if (def) sel.value = def;
    const upd = () => { const e = engines.find(x => x.id === sel.value) || {}; if (hint) hint.innerHTML = e.available ? "✅ <b>" + (e.label || "") + "</b>" + (e.model ? " (" + e.model + ")" : "") : "⚠️ Model này chưa có key."; };
    sel.onchange = upd; upd();
  } catch (e) { /* im lặng */ }
}

function prodRenderRefs() {
  const box = $("prodRefs"); if (!box) return; box.innerHTML = "";
  prodRefs.forEach((u, i) => {
    const d = document.createElement("div"); d.className = "fp-ref";
    d.innerHTML = '<img src="' + u + '" alt=""><button class="fp-ref-x" title="Bỏ">×</button>';
    d.querySelector(".fp-ref-x").onclick = () => { prodRefs.splice(i, 1); prodRenderRefs(); };
    box.appendChild(d);
  });
  if (prodRefs.length < 6) { const add = document.createElement("button"); add.className = "fp-ref fp-ref-add"; add.type = "button"; add.innerHTML = "＋<span>Add</span>"; add.onclick = () => $("prodFile").click(); box.appendChild(add); }
  $("prodRefCount").textContent = prodRefs.length + "/6";
}

function prodRenderStyle() {
  const box = $("prodStyleRef"); if (!box) return; box.innerHTML = "";
  if (prodStyle) {
    const d = document.createElement("div"); d.className = "fp-ref";
    d.innerHTML = '<img src="' + prodStyle + '" alt=""><button class="fp-ref-x" title="Bỏ">×</button>';
    d.querySelector(".fp-ref-x").onclick = () => { prodStyle = null; prodRenderStyle(); };
    box.appendChild(d);
  } else {
    const add = document.createElement("button"); add.className = "fp-ref fp-ref-add"; add.type = "button";
    add.innerHTML = "🎨<span>Style</span>"; add.onclick = () => $("prodStyleFile").click(); box.appendChild(add);
  }
}

async function prodSuggest() {
  if (!prodRefs.length) { alert("Thêm ảnh tham chiếu trước."); return; }
  const btn = $("prodSuggestBtn"), o = btn.textContent; btn.disabled = true; btn.textContent = "⏳ Claude đang viết prompt…";
  try {
    // hint = ý tưởng bạn đang gõ trong ô prompt (vd "couple ở bãi biển") -> Claude viết thành prompt chuẩn skill
    const hint = ($("prodPrompt").value || "").trim();
    const r = await fetch("/api/prod-ai-prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: prodRefs[0], hint: hint }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Lỗi");
    $("prodPrompt").value = d.prompt || "";
    const note = $("prodNote"); if (note) { note.className = "gen-note ok"; note.textContent = "🧠 " + (d.by || "AI") + " đã viết prompt chuẩn skill — duyệt/sửa rồi bấm Generate."; }
  } catch (e) { alert("✗ " + e.message); } finally { btn.disabled = false; btn.textContent = o; }
}

// CHẠY NHIỀU LUỒNG: bấm Generate nhiều lần, mỗi job 1 poll riêng + placeholder loading
async function prodGenerate(prompt, count) {
  const note = $("prodNote"); note.className = "gen-note"; note.textContent = "";
  prompt = (prompt || "").trim();
  if (!prodRefs.length) { note.className = "gen-note err"; note.textContent = "⚠️ Thêm ít nhất 1 ảnh tham chiếu."; return; }
  if (!prompt) { note.className = "gen-note err"; note.textContent = "⚠️ Nhập prompt."; return; }
  count = count || 1;
  const aspect = $("prodAspect").value || "4:5";
  const engine = ($("prodEngine") && $("prodEngine").value) || "";
  try {
    const r = await fetch("/api/prod-generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ images: prodRefs, style: prodStyle || "", prompt, engine, aspect, count }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Lỗi");
    // thêm placeholder "đang tạo" cho job này (lên đầu)
    for (let i = 0; i < count; i++) prodCreations.unshift({ loading: true, job: d.job_id, prompt, aspect });
    prodRenderCreations();
    prodPollJob(d.job_id, prompt);
    note.className = "gen-note ok"; note.textContent = "⏳ Đang tạo " + count + " ảnh — bấm Generate tiếp để chạy thêm luồng.";
  } catch (e) { note.className = "gen-note err"; note.textContent = "✗ " + e.message; }
}

function prodPollJob(jobId, prompt) {
  let placed = 0;
  const timer = setInterval(async () => {
    try {
      const d = await (await fetch("/api/batch-status?id=" + encodeURIComponent(jobId))).json();
      const items = d.items || [];
      while (placed < items.length) {
        const it = items[placed];
        const real = { image: it.image, prompt: it.prompt || prompt, engine: it.engine, aspect: it.aspect, gallery: it.gallery, id: it.gallery && it.gallery.id, url: it.gallery && it.gallery.url };
        const idx = prodCreations.findIndex(c => c.loading && c.job === jobId);
        if (idx >= 0) prodCreations[idx] = real; else prodCreations.unshift(real);
        placed++;
      }
      if (d.finished) {
        clearInterval(timer);
        // bỏ placeholder còn sót (ảnh lỗi)
        prodCreations = prodCreations.filter(c => !(c.loading && c.job === jobId));
        if ((d.errors || []).length) { const n = $("prodNote"); n.className = "gen-note err"; n.textContent = "⚠️ " + d.errors[0]; }
        if (typeof loadGallery === "function") loadGallery();
      }
      prodRenderCreations();
    } catch (e) { /* tiếp tục */ }
  }, 2500);
}

async function prodLoadHistory() {
  try {
    const d = await (await fetch("/api/gallery")).json();
    const hist = (d.items || []).filter(it => it.mode === "product").map(it => ({ url: it.url, id: it.id, prompt: it.prompt || "", aspect: "", engine: "", gallery: { id: it.id, url: it.url } }));
    const seen = new Set(prodCreations.map(c => c.id).filter(Boolean));
    hist.forEach(h => { if (!seen.has(h.id)) prodCreations.push(h); });
    prodRenderCreations();
  } catch (e) { /* im lặng */ }
}

function prodSetView(v) { prodView = v; $("prodViewList").classList.toggle("active", v === "list"); $("prodViewGrid").classList.toggle("active", v === "grid"); $("prodCreations").className = "fp-creations " + v; }

const prodSrc = (c) => c.image ? "data:image/png;base64," + c.image : c.url;
async function prodB64(c) { if (c.image) return c.image; const b = await (await fetch(c.url)).blob(); c.image = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(",")[1]); fr.readAsDataURL(b); }); return c.image; }
const prodKey = (c) => c.id || c.url || c.image;

function prodRenderCreations() {
  const box = $("prodCreations"); if (!box) return;
  $("prodCount2").textContent = prodCreations.length ? "(" + prodCreations.length + ")" : "";
  $("prodToShopify").textContent = "🛍️ Đưa vào Shopify (" + prodSel.size + ")";
  if (!prodCreations.length) { $("prodEmpty").classList.remove("hidden"); box.innerHTML = ""; return; }
  $("prodEmpty").classList.add("hidden");
  box.innerHTML = "";
  prodCreations.forEach(c => {
    if (c.loading) {
      const ph = document.createElement("div"); ph.className = "fp-card fp-card-loading";
      ph.innerHTML =
        '<div class="fp-card-prompt">' + ((c.prompt || "").slice(0, 130)) + '</div>' +
        '<div class="fp-loading"><span class="fp-spin"></span><span>Đang tạo… ~1 phút</span></div>';
      box.appendChild(ph); return;
    }
    const k = prodKey(c);
    const card = document.createElement("div"); card.className = "fp-card";
    card.innerHTML =
      '<div class="fp-card-top"><label class="fp-pick"><input type="checkbox"' + (prodSel.has(k) ? " checked" : "") + '></label>' +
        '<span class="fp-meta">' + (c.aspect || "") + (c.engine ? " · " + c.engine : "") + '</span></div>' +
      '<div class="fp-card-prompt" title="' + (c.prompt || "").replace(/"/g, "&quot;") + '">' + ((c.prompt || "Ảnh sản phẩm").slice(0, 130)) + '</div>' +
      '<div class="fp-card-img"><img src="' + prodSrc(c) + '" loading="lazy" alt=""></div>' +
      '<div class="fp-card-acts"><button class="b-regen">🔄 Tạo lại</button><button class="b-zoom">🔍</button><button class="b-copy">📋</button><button class="b-dl">⬇</button><button class="b-del">🗑️</button></div>';
    card.querySelector(".fp-pick input").onchange = (e) => { if (e.target.checked) prodSel.add(k); else prodSel.delete(k); $("prodToShopify").textContent = "🛍️ Đưa vào Shopify (" + prodSel.size + ")"; };
    card.querySelector(".fp-card-img img").onclick = () => openZoom(prodSrc(c));
    card.querySelector(".b-zoom").onclick = () => openZoom(prodSrc(c));
    card.querySelector(".b-copy").onclick = (e) => copyImageToClipboard(prodSrc(c), e.currentTarget);
    card.querySelector(".b-dl").onclick = async (e) => { const b = e.currentTarget; b.disabled = true; autoDownload(await prodB64(c), (c.prompt || "anh-sp").slice(0, 30)); b.disabled = false; };
    card.querySelector(".b-regen").onclick = () => { if (!prodRefs.length) { alert("Cần ảnh tham chiếu (thêm ở panel trái) để tạo lại."); return; } prodGenerate(c.prompt, 1); };
    card.querySelector(".b-del").onclick = async (e) => {
      if (!confirm("Xoá ảnh này?")) return; const b = e.currentTarget; b.disabled = true;
      try { if (c.id) await fetch("/api/gallery?id=" + encodeURIComponent(c.id), { method: "DELETE" }); prodCreations = prodCreations.filter(x => x !== c); prodSel.delete(k); prodRenderCreations(); if (typeof loadGallery === "function") loadGallery(); }
      catch (err) { alert("✗ " + err.message); b.disabled = false; }
    };
    box.appendChild(card);
  });
}

async function prodPushSel() {
  if (!prodSel.size) { alert("Tick ít nhất 1 ảnh để đưa vào Shopify."); return; }
  const arr = prodCreations.filter(c => prodSel.has(prodKey(c))).map(c => ({ url: c.url || prodSrc(c) }));
  openPickProd(arr);
}

/* =====================================================================
   TÍNH NĂNG: TẠO DESIGN (text-to-image theo phong cách)
   ===================================================================== */
const DS_STYLES = [
  { key: "belongs_to", label: "💞 Belongs to (quan hệ+tên) 🔥", hint: "This awesome DAD/MAMA belongs to [tên con] — quà tặng best-seller Etsy" },
  { key: "repeated_role", label: "🔁 Vai trò lặp (GIRL DAD) 🔥", hint: "Từ/tên lặp 3-5 lần xếp chồng, chữ đậm condensed, mono" },
  { key: "doodle_collage", label: "✏️ Doodle collage 🔥", hint: "Tên giữa + viền doodle vẽ tay (couple/bestie), always & forever" },
  { key: "club_backprint_names", label: "🏛️ Club back-print + tên", hint: "COOL DADS CLUB · EST · list tên · back-print tối giản" },
  { key: "est_badge_names", label: "🎖️ EST badge + tên", hint: "Best Dad Ever · EST 20xx · khung ảnh + tên · badge vintage" },
  { key: "photo_frame_layout", label: "🖼️ Bố cục KHUNG ẢNH", hint: "Chừa khung 'YOUR PHOTO HERE' + tên — điền ảnh thật sau" },
  { key: "name_tiles", label: "🔤 Chữ ghép ô (Scrabble)", hint: "Tên ghép bằng ô chữ gỗ Scrabble, quà handmade" },
  { key: "mama_script_kids", label: "💐 Mama/Papa + tên bé", hint: "Chữ script Mama/Papa + tên các bé nhỏ dưới, tông ấm" },
  { key: "vintage_americana", label: "🏞️ Vintage Americana 🔥", hint: "Hot Shopee · couple/quà · điền tên+năm+địa danh", ref: "vintage americana ringer tshirt" },
  { key: "varsity", label: "🎓 Varsity College", hint: "Áo lớp/CLB · tên trường+số+năm", ref: "varsity college tshirt typography" },
  { key: "minimal_clean", label: "⚪ Minimal Clean", hint: "Tối giản Hàn/Nhật · tên/slogan ngực trái", ref: "minimal typography tshirt" },
  { key: "lineart", label: "🔲 Minimalist line-art", hint: "Vẽ tối giản 1 nét · icon thanh mảnh, tattoo-flash" },
  { key: "korean_minimal", label: "🌷 Korean Minimal", hint: "Nữ GenZ, couple · biệt danh dễ thương", ref: "korean minimal tshirt lettering" },
  { key: "motivational", label: "💪 Motivational Bold", hint: "Slogan to bản lưng · nam streetwear", ref: "motivational quote tshirt typography" },
  { key: "retro_groovy", label: "🌻 Retro Groovy 70s", hint: "Chữ lượn sóng Cooper Black, sunburst, tông disco" },
  { key: "type_3d", label: "🎈 3D phồng", hint: "Chữ phồng bóng loáng, đổ bóng mềm" },
  { key: "big_type", label: "🅱️ Chữ to kín áo", hint: "Vài chữ to choán cả áo, kinetic" },
  { key: "calligraphy", label: "🖋️ Calligraphy", hint: "Thư pháp/lettering bay bướm, 1 màu" },
  { key: "ransom_collage", label: "📰 Ransom / Collage", hint: "Chữ cắt báo ghép, punk DIY" },
  { key: "street_racing", label: "🏎️ Street Racing", hint: "Nam mê xe · biển số/năm/garage", ref: "vintage racing tshirt design" },
  { key: "vintage_washed", label: "🧵 Vintage Washed", hint: "Hiệu ứng cũ bạc màu, chất vintage", ref: "vintage washed tshirt typography" },
  { key: "y2k_graffiti", label: "🫧 Y2K Graffiti", hint: "Bong bóng/graffiti · teen cá tính, rap", ref: "y2k graffiti tshirt typography" },
  { key: "badge_patch", label: "🏷️ Retro Badge", hint: "Cụm tem/icon vintage · sưu tầm", ref: "retro streetwear patch tshirt" },
  { key: "couple_love", label: "💞 Couple tình yêu 🔥", hint: "Tên 2 người + ngày + Since năm", ref: "couple matching tshirt typography" },
  { key: "city_souvenir", label: "📍 City Souvenir VN", hint: "Đà Lạt/Sài Gòn... + năm + toạ độ", ref: "city souvenir tshirt typography" },
  { key: "statement_bold", label: "🅰️ Statement Bold", hint: "Câu tuyên ngôn to (tránh nhạy cảm)", ref: "bold statement tshirt typography" },
  { key: "funny_vn", label: "😆 Funny Quote VN 🔥", hint: "Câu cà khịa tiếng Việt · viral, quà vui", ref: "funny quote tshirt typography" },
  { key: "floral_quote", label: "🌼 Floral + Quote", hint: "Nữ GenZ · hoa + câu nhẹ", ref: "aesthetic floral quote tshirt" },
  { key: "luxury_minimal", label: "🖤 Luxury Minimal", hint: "Quiet luxury · chữ nhỏ lưng", ref: "luxury minimal back print tshirt" },
  { key: "luxury_serif_script", label: "👑 Luxury Serif+Script 🔥", hint: "Couture/heritage club · serif to + script bay đè chéo + EST năm + tagline (kiểu The Couture Club)", ref: "luxury serif script combination back print couture club tshirt" },
  { key: "social_club", label: "🎟️ Social Club", hint: "Tên hội/nhóm/lớp + năm", ref: "social club tshirt typography" },
  { key: "sport_statement", label: "🏀 Sport Statement", hint: "Thể thao · tên/số đội (World Cup 2026)", ref: "sport athletic typography tshirt" },
  { key: "liquid_chrome", label: "🪙 Liquid Chrome 3D", hint: "Chữ chrome 3D · teen cá tính", ref: "chrome 3d typography tshirt" },
  { key: "scribble", label: "✍️ Scribble Sketch", hint: "Chữ viết tay nguệch ngoạc · nghệ", ref: "scribble handwritten tshirt typography" },
  { key: "streetwear", label: "🧢 Streetwear", hint: "Urban / hypebeast · graphic bold oversized" },
  { key: "graffiti_tag", label: "🎨 Graffiti / Wildstyle", hint: "Chữ phun sơn, tag tường, drip" },
  { key: "grunge_punk", label: "🧷 Grunge / Punk", hint: "Rách nát, zine photocopy, DIY" },
  { key: "cyberpunk", label: "🤖 Cyberpunk / Techwear", hint: "Neon glitch, HUD, chữ Nhật tương lai" },
  { key: "skate", label: "🛹 Skate", hint: "Skateboard, cartoon, logo old-school" },
  { key: "rap_bootleg", label: "🎤 Rap Bootleg 90s", hint: "Ảnh halftone + chữ vòng cung, rap tee" },
  { key: "vaporwave", label: "🌴 Vaporwave", hint: "Pastel neon, tượng La Mã, lưới 80s" },
  { key: "comic_pop", label: "💥 Comic / Pop-art", hint: "Halftone chấm bi, bong bóng thoại" },
  { key: "acid_trippy", label: "🌀 Acid / Psychedelic", hint: "Chữ chảy méo, xoáy, màu chói" },
  { key: "military", label: "🎖️ Military / Utility", hint: "Stencil quân đội, patch, olive/đen" },
  { key: "anime_nostalgia", label: "🎮 Anime hoài niệm (TeeLab) 🔥", hint: "Cảnh tuổi thơ anime 90s + chữ Nhật + tagline, pastel" },
  { key: "cute_mascot", label: "🐊 Cute mascot (SANCOOL) 🔥", hint: "Thú cute + bong bóng thoại + tên + brand ©, pastel" },
  { key: "mascot", label: "👨‍🚀 Mascot minh hoạ (TeeLab) 🔥", hint: "Nhân vật hoạt hình + chữ brand to nền + © năm" },
  { key: "gothic", label: "🖤 Gothic streetwear" },
  { key: "skull", label: "💀 Skull dark" },
  { key: "celestial", label: "🌌 Vũ trụ" },
  { key: "angel", label: "👼 Thiên thần baroque" },
  { key: "kawaii", label: "🧸 Cute / kawaii" },
  { key: "typography", label: "🔤 Typography slogan" },
  { key: "anime", label: "🌸 Anime / manga" },
  { key: "y2k", label: "🦋 Y2K" },
  { key: "floral", label: "🌿 Floral line art" },
  { key: "tattoo_oldschool", label: "⚓ Tattoo old-school", hint: "Tattoo Mỹ cổ: neo, hồng, dao, banner · đỏ-đen" },
  { key: "ukiyoe", label: "🌊 Nhật cổ / Ukiyo-e", hint: "Sóng, koi, rồng, samurai, hoa anh đào" },
  { key: "retro_poster", label: "📜 Retro Poster", hint: "Poster du lịch/tuyên truyền cổ, màu trầm" },
  { key: "pixel_8bit", label: "🕹️ Pixel / 8-bit", hint: "Pixel art arcade retro" },
  { key: "flat_vector", label: "🟦 Flat Vector", hint: "Vector phẳng hiện đại, màu khối" },
  { key: "watercolor", label: "💧 Watercolor", hint: "Màu nước loang nhẹ, nghệ thuật" },
  { key: "engraving", label: "🪶 Engraving cổ điển", hint: "Khắc nét gạch chéo, thực vật/thú, 1 màu" },
  { key: "abstract_geo", label: "🔺 Abstract / Geometric", hint: "Hình khối Bauhaus, risograph" },
  { key: "mandala", label: "🪷 Mandala / Zen", hint: "Hoạ tiết đối xứng, sen, hình học thiêng" },
];
const dsPicked = new Set(["vintage_americana"]);
let dsPollTimer = null;
let dsInited = false;

let dsRefImg = null;   // dataURL ảnh tham chiếu (AI tự nhận style)
let dsAuto = false;    // AI tự chọn style đẹp nhất
let dsSegment = "";    // tệp khách: "" | couple | family | group
const DS_SEGMENTS = [
  { key: "", label: "❌ Không (mẫu lẻ)" },
  { key: "couple", label: "💑 Couple — 2 mẫu đôi" },
  { key: "family", label: "👨‍👩‍👧 Gia đình — 3 mẫu" },
  { key: "group", label: "👥 Đội nhóm — 1 mẫu (đồng phục)" },
];
function dsRenderSegments() {
  const box = $("dsSegments"); if (!box) return; box.innerHTML = "";
  DS_SEGMENTS.forEach(s => {
    const el = document.createElement("div");
    el.className = "cchip" + (dsSegment === s.key ? " on" : "");
    el.textContent = s.label;
    el.onclick = () => { dsSegment = s.key; dsRenderSegments(); dsUpdateSegHint(); };
    box.appendChild(el);
  });
}
function dsUpdateSegHint() {
  const h = $("dsSegHint"); if (!h) return;
  const map = {
    couple: "💑 Sẽ tạo 1 BỘ <b>2 mẫu đôi</b> (Áo Anh + Áo Em) đồng bộ — chọn style/chủ đề rồi bấm Tạo.",
    family: "👨‍👩‍👧 Sẽ tạo 1 BỘ <b>3 mẫu gia đình</b> (Bố / Mẹ / Bé) đồng bộ.",
    group: "👥 Sẽ tạo <b>1 mẫu áo đồng phục</b> cho cả nhóm (mọi người mặc giống nhau) — bấm tạo nhiều lần để có thêm phương án.",
  };
  h.innerHTML = dsSegment ? map[dsSegment] : "Chọn 1 tệp để tạo nguyên bộ đồng bộ; bỏ trống = mẫu lẻ bình thường.";
}
const DS_COMBOS = [
  { label: "🧢🧵 Streetwear bạc màu", keys: ["streetwear", "vintage_washed"] },
  { label: "👨‍🚀🧵 Mascot vintage", keys: ["mascot", "vintage_washed"] },
  { label: "😆🧢 Áo phố cà khịa", keys: ["funny_vn", "streetwear"] },
  { label: "💞🌼 Couple hoa nhẹ", keys: ["couple_love", "floral_quote"] },
  { label: "🖤🌹 Dark hoa hồng", keys: ["gothic", "floral"] },
  { label: "🫧🪙 Bong bóng chrome", keys: ["y2k_graffiti", "liquid_chrome"] },
  { label: "🤖👨‍🚀 Mascot tương lai", keys: ["cyberpunk", "mascot"] },
  { label: "🌊⚓ Nhật cổ tattoo", keys: ["ukiyoe", "tattoo_oldschool"] },
  { label: "⚪🔲 Tối giản thanh", keys: ["minimal_clean", "lineart"] },
  { label: "🌴🦋 Retro Y2K", keys: ["vaporwave", "y2k"] },
  { label: "🎓🏎️ Đua collegiate", keys: ["varsity", "street_racing"] },
  { label: "📍🏞️ Souvenir VN", keys: ["city_souvenir", "vintage_americana"] },
  { label: "🐊🌼 Cute hoa lá", keys: ["cute_mascot", "floral_quote"] },
  { label: "🎮🌊 Anime Nhật", keys: ["anime_nostalgia", "ukiyoe"] },
];
function dsRenderCombos() {
  const box = $("dsCombos"); if (!box) return; box.innerHTML = "";
  DS_COMBOS.forEach(c => {
    const el = document.createElement("div");
    el.className = "cchip combo";
    el.textContent = c.label;
    el.onclick = () => { dsPicked.clear(); c.keys.forEach(k => dsPicked.add(k)); dsRenderStyles(); };
    box.appendChild(el);
  });
}
// Kho ý tưởng chủ đề áo (POD VN) — bấm để điền vào ô Chủ đề
const DS_THEME_IDEAS = [
  "tình yêu / couple", "mèo cưng", "cún cưng", "gym / tập tạ", "cà phê", "du lịch Đà Lạt",
  "biển / mùa hè", "Phật giáo / an yên", "cha mẹ / gia đình", "sinh nhật", "bạn thân / hội bạn",
  "học sinh / sinh viên", "Tết / năm mới", "Giáng sinh", "Halloween", "bóng đá", "âm nhạc / band",
  "anime / otaku", "game thủ", "cung hoàng đạo", "hoa lá / thực vật", "cây xương rồng",
  "trà sữa", "đồ ăn vặt", "chữa lành / healing", "động lực / hustle", "cá tính / chất chơi",
  "Sài Gòn", "Hà Nội", "núi rừng / cắm trại", "đại dương / cá voi", "vũ trụ / phi hành gia",
  "khủng long", "gấu cute", "phượng hoàng / rồng", "tâm linh / huyền bí", "vintage hoài niệm",
  "skate / trượt ván", "xe phân khối lớn", "y tá / bác sĩ", "giáo viên", "nông trại / quê",
  // Mùa & dịp lễ
  "bốn mùa", "mùa xuân / hoa đào", "mùa hè sôi động", "mùa thu lá vàng", "mùa đông ấm áp",
  "Tết Trung Thu", "Valentine 14/2", "8/3 phụ nữ", "20/10 phụ nữ VN", "20/11 nhà giáo",
  "1/6 thiếu nhi", "2/9 Quốc khánh", "30/4 - 1/5", "mùa tựu trường", "mùa cưới",
  "mùa lễ hội", "mùa hoa (phượng / dã quỳ / tam giác mạch)", "mùa mưa Sài Gòn",
  "Black Friday / sale", "Tết Dương lịch",
];
let dsThemeOffset = 0;
let dsThemeAll = false;
function dsRenderThemeChips() {
  const box = $("dsThemeChips"); if (!box) return; box.innerHTML = "";
  const list = dsThemeAll
    ? DS_THEME_IDEAS
    : Array.from({ length: 12 }, (_, i) => DS_THEME_IDEAS[(dsThemeOffset + i) % DS_THEME_IDEAS.length]);
  list.forEach(idea => {
    const el = document.createElement("div");
    el.className = "cchip"; el.style.cursor = "pointer";
    el.textContent = idea;
    el.onclick = () => { $("dsTheme").value = idea; el.classList.add("on"); setTimeout(() => el.classList.remove("on"), 600); };
    box.appendChild(el);
  });
  const sh = $("dsThemeShuffle");
  if (sh) sh.style.display = dsThemeAll ? "none" : "";
}

// Kho chữ/slogan tiếng Anh hay in áo (streetwear / POD)
const DS_TEXT_IDEAS = [
  // Power words 1 từ
  "VINTAGE", "ORIGINAL", "AUTHENTIC", "TIMELESS", "REBEL", "FEARLESS", "WILD", "DREAMER",
  "WANDER", "HUSTLE", "LEGEND", "ICONIC", "FREEDOM", "CHAOS", "ENERGY", "WORLDWIDE",
  "UNLIMITED", "PREMIUM", "FOREVER", "OUTLAW",
  // Slogan ngắn
  "Stay Wild", "Good Vibes Only", "Be Yourself", "Never Give Up", "Live Free", "Stay Strong",
  "Born to Be Wild", "Dream Big", "No Rain No Flowers", "Embrace the Chaos", "Stay Humble",
  "Work Hard Stay Humble", "Trust the Process", "Keep It Real", "Forever Young", "Wild & Free",
  "Adventure Awaits", "Stay Golden", "Less Talk More Action", "Soft but Strong",
  "Main Character", "Not Today", "Lost in the Moment", "Self Made", "Chasing Dreams",
  "Stay Curious", "Find Your Fire", "Rise & Shine", "Born to Stand Out", "Live the Moment",
  // Streetwear / club tag
  "Members Only", "Social Club", "Athletic Dept.", "Off Duty", "Limited Edition",
  "Sold Out", "Since the 90s", "Worldwide Tour", "Est. 1995", "Premium Quality",
  // VN vibe (tiếng Việt nổi)
  "YÊU", "AN YÊN", "BÌNH AN", "TỰ DO", "CỐ LÊN", "SỐNG HẾT MÌNH", "CHẤT", "ĐỈNH",
];
let dsTextOffset = 0;
let dsTextAll = false;
function dsRenderTextChips() {
  const box = $("dsTextChips"); if (!box) return; box.innerHTML = "";
  const list = dsTextAll
    ? DS_TEXT_IDEAS
    : Array.from({ length: 12 }, (_, i) => DS_TEXT_IDEAS[(dsTextOffset + i) % DS_TEXT_IDEAS.length]);
  list.forEach(txt => {
    const el = document.createElement("div");
    el.className = "cchip"; el.style.cursor = "pointer";
    el.textContent = txt;
    el.onclick = () => { $("dsText").value = txt; el.classList.add("on"); setTimeout(() => el.classList.remove("on"), 600); };
    box.appendChild(el);
  });
  const sh = $("dsTextShuffle");
  if (sh) sh.style.display = dsTextAll ? "none" : "";
}
let dsCanvaLink = "";
try { dsCanvaLink = localStorage.getItem("canvaLink") || ""; } catch (e) {}
function dsInit() {
  if (dsInited) return; dsInited = true;
  // Toggle Lưới / Danh sách (giống FB Ads)
  const dsSetView = (v) => {
    const box = $("dsResults"); if (box) box.className = "fp-creations " + v;
    if ($("dsViewGrid")) $("dsViewGrid").classList.toggle("active", v === "grid");
    if ($("dsViewList")) $("dsViewList").classList.toggle("active", v === "list");
  };
  if ($("dsViewGrid")) $("dsViewGrid").onclick = () => dsSetView("grid");
  if ($("dsViewList")) $("dsViewList").onclick = () => dsSetView("list");
  if ($("dsSuggestName")) $("dsSuggestName").onclick = async () => {
    try {
      const d = await (await fetch("/api/name-suggest")).json();
      $("dsText").value = d.name || ""; $("dsYear").value = d.stamp || "";   // giữ cả "EST"
    } catch (e) {}
  };
  const cl = $("dsCanvaLink"), cs = $("dsCanvaSave");
  if (cl) {
    cl.value = dsCanvaLink;
    if (cs) cs.onclick = () => {
      dsCanvaLink = (cl.value || "").trim();
      try { localStorage.setItem("canvaLink", dsCanvaLink); } catch (e) {}
      cs.textContent = "✓ Đã lưu"; setTimeout(() => cs.textContent = "💾 Lưu link", 1300);
    };
  }
  dsRenderCombos();
  dsRenderNameCombos();
  dsRenderSegments();
  dsUpdateSegHint();
  dsRenderStyles();
  dsRenderThemeChips();
  const sh = $("dsThemeShuffle");
  if (sh) sh.onclick = () => { dsThemeOffset = (dsThemeOffset + 12) % DS_THEME_IDEAS.length; dsRenderThemeChips(); };
  const all = $("dsThemeAll");
  if (all) all.onclick = () => { dsThemeAll = !dsThemeAll; all.textContent = dsThemeAll ? "🔽 Thu gọn" : "📋 Xem tất cả"; dsRenderThemeChips(); };
  dsRenderTextChips();
  const tsh = $("dsTextShuffle");
  if (tsh) tsh.onclick = () => { dsTextOffset = (dsTextOffset + 12) % DS_TEXT_IDEAS.length; dsRenderTextChips(); };
  const tall = $("dsTextAll");
  if (tall) tall.onclick = () => { dsTextAll = !dsTextAll; tall.textContent = dsTextAll ? "🔽 Thu gọn" : "📋 Xem tất cả"; dsRenderTextChips(); };
  const ab = $("dsAutoStyle");
  if (ab) ab.onclick = () => {
    dsAuto = !dsAuto;
    ab.classList.toggle("on", dsAuto);
    ab.textContent = dsAuto ? "🎯 AI tự chọn style: ĐANG BẬT (bấm để tắt)" : "🎯 Để AI tự chọn style đẹp nhất";
  };
  dsLoadSaved();   // nạp lại design đã tạo (đã lưu) -> reload/reset vẫn còn
}
function dsSetRef(durl) {
  dsRefImg = durl;
  const row = $("dsRefThumbs"); row.innerHTML = "";
  if (durl) {
    const d = document.createElement("div"); d.className = "thumb";
    d.innerHTML = '<img src="' + durl + '" alt=""><button class="thumb-x">×</button>';
    d.querySelector(".thumb-x").onclick = () => { dsSetRef(null); $("dsRefName").textContent = "⬆️ Tải ảnh mẫu để AI bắt chước phong cách"; };
    row.appendChild(d);
  }
}
$("dsRefFile").onchange = async (e) => { const f = e.target.files[0]; if (f && f.type.startsWith("image/")) { $("dsRefName").textContent = "📄 " + f.name; dsSetRef(await fileToDataURL(f)); } };
(() => {
  const dz = $("dsRefDrop");
  dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("drag"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
  dz.addEventListener("drop", async e => { e.preventDefault(); dz.classList.remove("drag"); const f = e.dataTransfer.files[0]; if (f && f.type.startsWith("image/")) { $("dsRefName").textContent = "📄 " + f.name; dsSetRef(await fileToDataURL(f)); } });
})();
// Dán ảnh (Ctrl+V) khi đang ở tab Tạo design -> đặt làm ảnh tham chiếu
document.addEventListener("paste", async (e) => {
  if (document.getElementById("view-design").classList.contains("hidden")) return;
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for (const it of items) {
    if (it.type && it.type.startsWith("image/")) {
      const f = it.getAsFile();
      if (f) { e.preventDefault(); $("dsRefName").textContent = "📋 Ảnh dán từ clipboard"; dsSetRef(await fileToDataURL(f)); }
      return;
    }
  }
});
function dsRenderStyles() {
  const box = $("dsStyles"); box.innerHTML = "";
  DS_STYLES.forEach(s => {
    const el = document.createElement("div");
    el.className = "cchip" + (dsPicked.has(s.key) ? " on" : "");
    if (s.hint) el.title = s.hint;
    el.innerHTML = s.label + ' <span class="tick">✓</span>';
    el.onclick = () => { if (dsPicked.has(s.key)) dsPicked.delete(s.key); else dsPicked.add(s.key); dsRenderStyles(); };
    box.appendChild(el);
  });
  dsRenderNameStyles();
  dsUpdateTotal();
}
function dsUpdateTotal() {
  const n = parseInt(($("dsCount") || {}).value, 10) || 3;
  if (!$("dsStyleHint")) return;
  if (!dsPicked.size) { $("dsStyleHint").innerHTML = "⚠️ Chọn ít nhất 1 phong cách"; return; }
  $("dsStyleHint").innerHTML = dsPicked.size > 1
    ? "🎨 Sẽ tạo <b>" + n + " mẫu</b> — mỗi mẫu <b>TRỘN " + dsPicked.size + " phong cách</b> đã chọn (mash-up)."
    : "✨ Sẽ tạo <b>" + n + " mẫu</b> phong cách này.";
}

/* ===== Cá nhân hoá TÊN: style đơn tốt + mix combo tốt ===== */
const _dsLabel = (k) => (DS_STYLES.find(s => s.key === k) || {}).label || k;
// Style đơn tốt nhất cho in tên
const DS_NAME_STYLES = [
  "vintage_americana", "varsity", "big_type", "calligraphy", "couple_love",
  "social_club", "statement_bold", "typography", "minimal_clean", "liquid_chrome",
  "y2k_graffiti", "streetwear",
];
// Mix combo (2 style) hợp cá nhân hoá tên
const DS_NAME_COMBOS = [
  { label: "🎓 Tên cổ điển", keys: ["vintage_americana", "badge_patch"] },
  { label: "🏈 Tên thể thao", keys: ["varsity", "sport_statement"] },
  { label: "💞 Tên couple", keys: ["couple_love", "calligraphy"] },
  { label: "✨ Tên GenZ chrome", keys: ["y2k_graffiti", "liquid_chrome"] },
  { label: "🤍 Tên tối giản", keys: ["minimal_clean", "korean_minimal"] },
  { label: "🔥 Tên streetwear", keys: ["streetwear", "big_type"] },
  { label: "🕺 Tên retro", keys: ["retro_groovy", "vintage_washed"] },
  { label: "🐻 Tên quà cute", keys: ["cute_mascot", "scribble"] },
  { label: "👑 Tên sang", keys: ["calligraphy", "luxury_minimal"] },
];
function dsRenderNameStyles() {
  const box = $("dsNameStyles"); if (!box) return; box.innerHTML = "";
  DS_NAME_STYLES.forEach(k => {
    const el = document.createElement("div");
    el.className = "cchip" + (dsPicked.has(k) ? " on" : "");
    el.innerHTML = _dsLabel(k) + ' <span class="tick">✓</span>';
    el.onclick = () => { if (dsPicked.has(k)) dsPicked.delete(k); else dsPicked.add(k); dsRenderStyles(); };
    box.appendChild(el);
  });
}
function dsRenderNameCombos() {
  const box = $("dsNameCombos"); if (!box) return; box.innerHTML = "";
  DS_NAME_COMBOS.forEach(c => {
    const el = document.createElement("div");
    el.className = "cchip combo";
    el.title = c.keys.map(_dsLabel).join(" + ");
    el.textContent = c.label;
    el.onclick = () => { dsPicked.clear(); c.keys.forEach(k => dsPicked.add(k)); dsRenderStyles(); };
    box.appendChild(el);
  });
}
let dsJobs = [];          // [{id,total,done,finished}] — nhiều đợt song song
let dsItems = {};         // key -> item (gộp kết quả mọi đợt)
function dsItemKey(it) { return (it.gallery && it.gallery.id) || it.title || Math.random(); }
// Mốc thời gian tạo (để MỚI NHẤT lên đầu): id gallery dạng "d<ms>" -> lấy ms; fallback ts / _seq
let _dsSeq = 0;
function dsTime(it) {
  const gid = it && ((it.gallery && it.gallery.id) || it.id);
  if (gid && /^d\d+$/.test(gid)) return parseInt(gid.slice(1), 10);
  if (it && it.ts) return it.ts * 1000;
  if (it && it._seq) return it._seq;
  return (it && (it._seq = ++_dsSeq + 1e18)) || 0;   // item không có mốc -> coi như mới nhất, ổn định
}
// nguồn ảnh: ưu tiên b64 (it.image), nếu chỉ có url (nạp từ gallery) thì dùng url
const dsSrc = (it) => it.image ? "data:image/png;base64," + it.image : it.url;
// lấy b64 (fetch + cache từ url nếu cần) — cho các thao tác cần base64
async function dsB64(it) {
  if (it.image) return it.image;
  const b = await (await fetch(it.url)).blob();
  it.image = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(",")[1]); fr.readAsDataURL(b); });
  return it.image;
}
// nạp lại design đã tạo (đã lưu gallery) khi mở tab -> reset/reload vẫn còn
async function dsLoadSaved() {
  try {
    const d = await (await fetch("/api/gallery")).json();
    const items = (d.items || []).filter(it => it.mode === "design" || it.mode === "personalize").slice(0, 120);
    let added = 0;
    items.forEach(g => {
      if (!dsItems[g.id]) { dsItems[g.id] = { url: g.url, title: g.prompt || "Design", gallery: { id: g.id, url: g.url } }; added++; }
    });
    if (added) dsRender();
  } catch (e) { /* im lặng */ }
}

// Canh chiều cao 2 cột lấp đầy màn hình (thích ứng header co giãn) -> panel dài ra
function dsFitHeight() {
  const lay = document.querySelector("#view-design .fp-layout");
  if (!lay) return;
  if (window.innerWidth < 901) { lay.style.height = ""; return; }   // mobile: xếp dọc, để tự nhiên
  const top = lay.getBoundingClientRect().top + window.scrollY;
  const h = window.innerHeight - top - 4;   // CỘT CAO HẾT CỠ: lấp tới sát đáy màn (footer xuống dưới)
  lay.style.height = Math.max(480, h) + "px";
}
if (!window._dsFitWired) { window._dsFitWired = true; window.addEventListener("resize", () => { if (!document.getElementById("view-design").classList.contains("hidden")) dsFitHeight(); }); }
function dsLoadingCard() {
  const c = document.createElement("div"); c.className = "gcard gcard-loading";
  c.innerHTML = '<div class="ds-loading"><span class="ds-spin"></span><span>Đang tạo…</span></div>';
  return c;
}
function dsRender() {
  const grid = $("dsResults");
  // số mẫu đang chờ (đợt chưa xong) -> hiện ô trống đang load
  const pending = (typeof dsJobs !== "undefined" ? dsJobs : []).reduce((a, j) => a + (j.finished ? 0 : Math.max(0, (j.total || 0) - (j.done || 0))), 0);
  let entries = Object.entries(dsItems);   // [key, item]
  if (!entries.length && !pending) { $("dsEmpty").classList.remove("hidden"); grid.innerHTML = ""; $("dsDownloadAll").textContent = "⬇ Tải tất cả (0)"; return; }
  $("dsEmpty").classList.add("hidden");
  // nếu đã chấm điểm -> sắp xếp điểm cao lên trước; chưa chấm -> MỚI NHẤT lên đầu
  const anyRated = entries.some(([, it]) => typeof it.score === "number");
  if (anyRated) entries = entries.sort((a, b) => (b[1].score || 0) - (a[1].score || 0));
  else entries = entries.sort((a, b) => dsTime(b[1]) - dsTime(a[1]));   // MỚI NHẤT lên đầu (theo thời gian tạo)
  grid.innerHTML = "";
  for (let i = 0; i < pending; i++) grid.appendChild(dsLoadingCard());   // ô trống đang load lên đầu
  entries.forEach(([key, it]) => { grid.appendChild(dsMakeCard(key, it)); });
  $("dsDownloadAll").textContent = "⬇ Tải tất cả (" + entries.length + ")";
}
// Thẻ kết quả design (dùng CHUNG cho Tạo design + Auto Research) — đầy đủ nút cá nhân hoá
function dsMakeCard(key, it) {
    const card = document.createElement("div");
    card.className = "gcard";
    let badge = "";
    if (typeof it.score === "number") {
      const push = it.score >= 80;
      badge = '<div class="ds-score' + (push ? " push" : "") + '">' +
        (push ? "⭐ Nên đẩy · " : "") + it.score + "/100" +
        (it.reason ? '<span class="ds-reason">' + it.reason + "</span>" : "") + "</div>";
    }
    card.innerHTML =
      '<img src="' + dsSrc(it) + '" loading="lazy" alt="">' + badge +
      '<div class="gmeta">' + (it.title || "Design") + '</div>' +
      '<div class="gacts"><button class="b-name">🪪 Tên</button><button class="b-recolor">🎨 Đổi màu áo</button><button class="b-cut">✂️ Tách nền</button><button class="b-canva">🖌️ Canva</button><button class="b-var">🔄 Bản khác</button><button class="b-use">👕 Lên áo</button><button class="b-copy">📋 Copy</button><button class="b-dl">⬇ Tải</button><button class="b-del">🗑️ Xoá</button></div>' +
      '<div class="ap-fix"><input type="text" class="ds-fixin" placeholder="✏️ Prompt sửa/làm lại (dùng cho Sửa & 🔄 Bản khác)…"><button class="ds-fixbtn">Sửa</button></div>';
    card._cur = it.image; card._it = it; card._name = it.title || "design";
    card.querySelector("img").onclick = () => openZoom(dsSrc(it));
    card.querySelector(".b-name").onclick = async (e) => { const b = e.currentTarget; b.disabled = true; openPersonalize(await dsB64(it)); b.disabled = false; };
    card.querySelector(".b-recolor").onclick = async (e) => {
      const b = e.currentTarget; b.disabled = true;
      recolorImg = "data:image/png;base64," + await dsB64(it); b.disabled = false;
      showApp("recolor");
      if (typeof recolorRenderThumb === "function") recolorRenderThumb();
    };
    card.querySelector(".b-var").onclick = async (e) => {
      const p = (card.querySelector(".ds-fixin") && card.querySelector(".ds-fixin").value || "").trim();
      dsMakeVariations(await dsB64(it), e.currentTarget, p);   // dùng design có sẵn + prompt (nếu nhập)
    };
    card.querySelector(".b-cut").onclick = async (e) => {
      const b = e.currentTarget; b.disabled = true;
      const im = await dsB64(it); b.disabled = false;
      // mở editor tách nền thủ công; xong -> đưa sang tab Tách nền
      cutOpenManual(im, -1, (b64) => {
        cutItems.unshift({ image: b64 });
        showApp("cutout"); cutoutRender();
        const n = $("cutNote"); if (n) { n.className = "gen-note ok"; n.textContent = "✓ Đã tách nền thủ công design — ở đây bạn có thể lên áo / đổi màu / tải."; }
      });
    };
    card.querySelector(".b-use").onclick = async (e) => { const b = e.currentTarget; b.disabled = true; const im = await dsB64(it); b.disabled = false; showApp("clone"); showDesign(im); document.querySelector('.rtab[data-rtab="design"]').click(); };
    card.querySelector(".b-copy").onclick = (e) => copyImageToClipboard(dsSrc(it), e.currentTarget);
    card.querySelector(".b-canva").onclick = async (e) => {
      if (!dsCanvaLink) { alert("Chưa có link Canva. Dán link Canva vào ô phía trên rồi bấm 💾 Lưu link."); $("dsCanvaLink") && $("dsCanvaLink").focus(); return; }
      await copyImageToClipboard(dsSrc(it), e.currentTarget);  // copy sẵn để dán vào Canva
      window.open(dsCanvaLink, "_blank");
    };
    card.querySelector(".b-dl").onclick = async (e) => { const b = e.currentTarget; b.disabled = true; autoDownload(await dsB64(it), it.title || "design"); b.disabled = false; };
    card.querySelector(".b-del").onclick = async (e) => {
      if (!confirm("Xoá design này?")) return;
      const b = e.currentTarget; b.disabled = true;
      try {
        const gid = it.gallery && it.gallery.id;
        if (gid) await fetch("/api/gallery?id=" + encodeURIComponent(gid), { method: "DELETE" });
        delete dsItems[key]; card.remove(); dsRender();
        if (typeof loadGallery === "function") loadGallery();
      } catch (err) { alert("✗ " + err.message); b.disabled = false; }
    };
    const dsFixin = card.querySelector(".ds-fixin"), dsFixbtn = card.querySelector(".ds-fixbtn");
    const dsDoFix = async () => {
      const instr = (dsFixin.value || "").trim(); if (!instr) { dsFixin.focus(); return; }
      dsFixbtn.disabled = true; const o = dsFixbtn.textContent; dsFixbtn.textContent = "⏳…";
      try {
        const r = await fetch("/api/pipe-edit", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: "data:image/png;base64," + await dsB64(it), prompt: instr }) });
        const d = await r.json(); if (!r.ok) throw new Error(d.error || "Lỗi");
        it.image = d.image; card._cur = d.image;
        card.querySelector("img").src = "data:image/png;base64," + d.image;
        dsFixin.value = ""; if (typeof loadGallery === "function") loadGallery();
      } catch (err) { alert("✗ " + err.message); } finally { dsFixbtn.disabled = false; dsFixbtn.textContent = o; }
    };
    dsFixbtn.onclick = dsDoFix;
    dsFixin.onkeydown = (e) => { if (e.key === "Enter") dsDoFix(); };
    return card;
}
/* ===== Tạo thêm phiên bản khác của 1 design ===== */
async function dsMakeVariations(image, btn, prompt) {
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = "⏳…";
  const note = $("dsNote"); note.className = "gen-note"; note.textContent = (prompt ? "Đang làm lại theo yêu cầu…" : "Đang tạo 4 phiên bản khác…");
  try {
    const r = await fetch("/api/variations", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image, count: 4, transparent: true, prompt: prompt || "" }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Lỗi tạo phiên bản");
    (d.items || []).forEach(it => { dsItems[dsItemKey(it)] = it; });
    dsRender();
    if (typeof loadGallery === "function") loadGallery();
    note.className = "gen-note ok"; note.textContent = "✓ Đã tạo " + (d.items || []).length + " phiên bản khác — xem ở khung kết quả.";
  } catch (err) {
    note.className = "gen-note err"; note.textContent = "✗ " + err.message;
  } finally {
    btn.disabled = false; btn.textContent = old;
  }
}

/* ===== Cá nhân hoá tên: biến mẫu đẹp -> bản có tên ===== */
let pnImage = null;
let pnAutoMode = false;   // mở từ Auto Research -> chạy NỀN nhiều luồng
function openPersonalize(image, auto) {
  pnImage = image;
  pnAutoMode = !!auto;
  $("pnPreview").src = "data:image/png;base64," + image;
  $("pnName").value = ""; $("pnDate").value = "";
  if ($("pnNick")) $("pnNick").value = ""; if ($("pnReq")) $("pnReq").value = "";
  $("pnNote").textContent = ""; $("pnNote").className = "gen-note";
  $("pnModal").classList.remove("hidden");
  setTimeout(() => $("pnName").focus(), 50);
}
function closePersonalize() { $("pnModal").classList.add("hidden"); pnImage = null; pnAutoMode = false; }
$("pnClose").onclick = closePersonalize;
$("pnModal").onclick = (e) => { if (e.target.id === "pnModal") closePersonalize(); };
$("pnGo").onclick = async () => {
  const name = $("pnName").value.trim();
  if (!name) { $("pnNote").className = "gen-note err"; $("pnNote").textContent = "⚠️ Nhập tên đã."; return; }
  const count = parseInt($("pnCount").value, 10) || 4;
  const nick = ($("pnNick") && $("pnNick").value || "").trim();
  const note = ($("pnReq") && $("pnReq").value || "").trim();
  const date = $("pnDate").value.trim();
  // CHẾ ĐỘ AUTO RESEARCH: chạy NỀN nhiều luồng -> đóng modal ngay, up design khác chạy tiếp
  if (pnAutoMode) {
    autoLaunchPersonalize(pnImage, name, date, count, nick, note);
    if (typeof autoUploaded !== "undefined") { autoUploaded = []; autoRenderThumbs(); }  // dọn để up design mới
    closePersonalize();
    return;
  }
  const btn = $("pnGo"), old = btn.textContent;
  btn.disabled = true; btn.textContent = "⏳ Đang tạo…";
  $("pnNote").className = "gen-note"; $("pnNote").textContent = "Đang tạo " + count + " bản (giữ phong cách, thay tên)…";
  try {
    const r = await fetch("/api/personalize", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: pnImage, name, date, nick, note, count, transparent: true,
        nick_vary: !!($("pnNickVary") && $("pnNickVary").checked) }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Lỗi cá nhân hoá");
    (d.items || []).forEach(it => { dsItems[dsItemKey(it)] = it; });
    dsRender();
    // nếu đang ở tab Auto Research -> hiện kết quả ngay tại đó
    const av = document.getElementById("view-auto");
    if (av && !av.classList.contains("hidden") && typeof autoRender === "function") autoRender(d.items || []);
    if (typeof loadGallery === "function") loadGallery();
    $("pnNote").className = "gen-note ok"; $("pnNote").textContent = "✓ Đã tạo " + (d.items || []).length + " bản cá nhân hoá — xem ở khung kết quả.";
    setTimeout(closePersonalize, 900);
  } catch (err) {
    $("pnNote").className = "gen-note err"; $("pnNote").textContent = "✗ " + err.message;
  } finally {
    btn.disabled = false; btn.textContent = old;
  }
};
$("dsRate").onclick = async () => {
  const entries = Object.entries(dsItems);
  if (!entries.length) { return; }
  const btn = $("dsRate"), old = btn.textContent;
  btn.disabled = true; btn.textContent = "⏳ Đang chấm…";
  try {
    const payload = { items: entries.map(([key, it]) => ({ key, image: it.image })) };
    const r = await fetch("/api/rate-designs", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Lỗi chấm điểm");
    (d.scores || []).forEach(s => { if (dsItems[s.key]) { dsItems[s.key].score = s.score; dsItems[s.key].reason = s.reason; } });
    dsRender();
    const top = (d.scores || []).filter(s => s.score >= 80).length;
    $("dsNote").className = "gen-note ok";
    $("dsNote").textContent = "🏆 Đã chấm " + (d.scores || []).length + " mẫu — " + top + " mẫu 'Nên đẩy' (≥80đ), xếp điểm cao lên đầu.";
  } catch (err) {
    $("dsNote").className = "gen-note err"; $("dsNote").textContent = "✗ " + err.message;
  } finally {
    btn.disabled = false; btn.textContent = old;
  }
};
async function dsPollAll() {
  const active = dsJobs.filter(j => !j.finished);
  let errs = [];
  await Promise.all(active.map(async j => {
    try {
      const d = await (await fetch("/api/batch-status?id=" + encodeURIComponent(j.id))).json();
      // KHÔNG để total tụt về 0 khi job chưa đăng ký kịp -> tránh placeholder loading biến mất
      j.total = Math.max(j.total || 0, d.total || 0);
      j.done = Math.max(j.done || 0, d.done || 0);
      j.finished = !!d.finished;
      (d.items || []).forEach(it => { dsItems[dsItemKey(it)] = it; });
      (d.errors || []).forEach(e => errs.push(e));
    } catch (e) { /* thử lại lần sau */ }
  }));
  dsRender();
  const total = dsJobs.reduce((a, j) => a + (j.total || 0), 0);
  const done = dsJobs.reduce((a, j) => a + (j.done || 0), 0);
  const running = dsJobs.filter(j => !j.finished).length;
  $("dsBar").style.width = (total ? Math.round(done / total * 100) : 0) + "%";
  $("dsProgText").textContent = (running ? ("⏳ " + running + " đợt đang chạy · ") : "✓ Tất cả xong · ")
    + done + "/" + total + " · ✓ " + Object.keys(dsItems).length + " mẫu";
  if (errs.length) $("dsErrors").innerHTML = errs.map(e => "<div>⚠️ " + e + "</div>").join("");
  if (!running) {
    clearInterval(dsPollTimer); dsPollTimer = null;
    $("dsNote").className = "gen-note ok";
    $("dsNote").textContent = "✓ Xong tất cả! " + Object.keys(dsItems).length + " mẫu (đã lưu Lịch sử).";
    if (typeof loadGallery === "function") loadGallery();
  }
}
$("dsCount").addEventListener("change", dsUpdateTotal);
$("dsRunBtn").onclick = async () => {
  const note = $("dsNote"); note.className = "gen-note"; note.textContent = "";
  if (!dsSegment && !dsAuto && !dsPicked.size && !dsRefImg && !($("dsExtra")?.value || "").trim()) { note.className = "gen-note err"; note.textContent = "⚠️ Chọn phong cách, bật 🎯 AI tự chọn style, tải ảnh tham chiếu, HOẶC tự điền prompt ở ô bên dưới."; return; }
  $("dsProgress").classList.remove("hidden");
  try {
    const r = await fetch("/api/design-gen", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ styles: [...dsPicked], ref: dsRefImg || "", auto_style: dsAuto, segment: dsSegment, theme: $("dsTheme").value, text: ($("dsText")?.value || ""), year: $("dsYear").value, same_line: ($("dsSameLine")?.checked || false), extra: ($("dsExtra")?.value || ""), n: parseInt($("dsCount").value, 10) || 3, size: $("dsSize").value, transparent: true }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Lỗi không xác định");
    dsJobs.push({ id: d.job_id, total: d.total, done: 0, finished: false });
    dsRender();   // hiện NGAY ô trống đang load (trước khi poll)
    note.className = "gen-note ok";
    note.textContent = "✓ Đã thêm đợt mới (" + d.total + " mẫu) — bấm tiếp để chạy thêm song song!";
    if (!dsPollTimer) dsPollTimer = setInterval(dsPollAll, 2500);
    dsPollAll();
  } catch (err) {
    note.className = "gen-note err"; note.textContent = "✗ " + err.message;
  }
};
$("dsDownloadAll").onclick = async () => {
  const cards = [...$("dsResults").querySelectorAll(".gcard")];
  if (!cards.length) return;
  for (const cd of cards) {
    const b64 = cd._cur || (cd._it ? await dsB64(cd._it) : null);
    if (b64) autoDownload(b64, cd._name);
    await new Promise(r => setTimeout(r, 350));
  }
};

/* ---------- 📦 Tải ZIP hàng loạt (dùng chung các tab lưới ảnh) ---------- */
async function zipDownloadSelected(items, btn) {
  if (!items.length) { alert("⚠️ Chưa tick chọn ảnh nào."); return; }
  const o = btn.textContent; btn.disabled = true; btn.textContent = "⏳ Đang đóng gói…";
  try {
    const r = await fetch("/api/download-zip", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: items }) });
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || "Lỗi đóng gói"); }
    const blob = await r.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "bo-anh-" + Date.now() + ".zip";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) { alert("✗ " + e.message); }
  btn.disabled = false; btn.textContent = o;
}

/* =====================================================================
   TAB 🎵 TIKTOK QUÀ TẶNG — AI lập bài carousel + Nano Banana Pro vẽ ảnh sạch
   ===================================================================== */
let ttInited = false, ttItems = [], ttJobs = [], ttPollTimer = null, ttMeta = null, ttSp = null;
function ttInit() {
  if (ttInited) return; ttInited = true;
  $("ttRunBtn").onclick = ttGenerate;
  // 🎁 Slide 8 bonus: chọn SP shop -> gen ảnh 2 áo gấp trên sofa
  if ($("ttSpPick")) $("ttSpPick").onclick = () => openSpPicker((p) => {
    ttSp = { image: p.image || "", title: p.title || "" };
    $("ttSpInfo").innerHTML = "📦 <b>" + (p.title || "SP").replace(/</g, "&lt;").slice(0, 40) + "</b> — sẽ giữ đúng design này.";
    // 🎨 chọn ảnh MÀU ÁO trong các ảnh của SP
    const row = $("ttSpColors");
    if (row) {
      row.innerHTML = "";
      const imgs = (p.images || []).filter(Boolean);
      if (imgs.length > 1) {
        row.insertAdjacentHTML("beforeend", '<div class="hint" style="width:100%;margin:6px 0 2px">🎨 Chọn ảnh MÀU ÁO làm tham chiếu:</div>');
        imgs.forEach(u => {
          const im = document.createElement("img");
          im.src = u; im.loading = "lazy";
          im.style.cssText = "width:46px;height:58px;object-fit:cover;border-radius:8px;cursor:pointer;margin:0 5px 5px 0;border:2px solid " + (u === ttSp.image ? "var(--violet)" : "var(--line)");
          im.onclick = () => {
            ttSp.image = u;
            [...row.querySelectorAll("img")].forEach(x => x.style.borderColor = "var(--line)");
            im.style.borderColor = "var(--violet)";
          };
          row.appendChild(im);
        });
      }
    }
  });
  // 🎲 Random cặp tên (nữ + nam) — điền sẵn để xem/sửa TRƯỚC khi gen
  const TT_NAMES_NU = ["Thuỳ Linh", "Ngọc Hân", "Thu Trang", "Phương Anh", "Mai Hương", "Khánh Vy",
    "Bảo Trâm", "Diễm My", "Thanh Trúc", "Cẩm Tú", "Hồng Nhung", "Lan Anh", "Quỳnh Như", "Hà My", "Tường Vy"];
  const TT_NAMES_NAM = ["Minh Quân", "Hữu Phước", "Đức Anh", "Hoàng Nam", "Tuấn Kiệt", "Gia Bảo",
    "Quốc Bảo", "Nhật Minh", "Đình Phong", "Hải Đăng", "Trí Dũng", "Thanh Tùng", "Việt Hoàng", "Duy Khánh", "Minh Khôi"];
  if ($("ttBonusRnd")) $("ttBonusRnd").onclick = () => {
    $("ttBonusName1").value = TT_NAMES_NU[Math.floor(Math.random() * TT_NAMES_NU.length)];
    $("ttBonusName2").value = TT_NAMES_NAM[Math.floor(Math.random() * TT_NAMES_NAM.length)];
  };
  if ($("ttBonusBtn")) $("ttBonusBtn").onclick = async () => {
    const note = $("ttNote");
    if (!ttSp || !ttSp.image) { note.className = "gen-note err"; note.textContent = "⚠️ Bấm 📦 Chọn sản phẩm trước (lấy design áo)."; return; }
    const names = [($("ttBonusName1").value || "").trim(), ($("ttBonusName2").value || "").trim()].filter(Boolean);
    const overlay = (ttMeta && ttMeta.bonus && ttMeta.bonus.length) ? ttMeta.bonus : [];
    const b = $("ttBonusBtn"); b.disabled = true; const o = b.textContent; b.textContent = "⏳ Đang tạo…";
    $("ttProgress").classList.remove("hidden");
    try {
      const r = await fetch("/api/tiktok-bonus-gen", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: ttSp.image, names: names, overlay: overlay }) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error || "Lỗi");
      ttJobs.push({ id: d.job_id, total: d.total, done: 0, finished: false });
      ttRender();
      note.className = "gen-note ok"; note.textContent = "⏳ Đang tạo slide bonus (2 áo gấp trên sofa, giữ đúng design SP)…";
      if (!ttPollTimer) ttPollTimer = setInterval(ttPollAll, 2500);
      ttPollAll();
    } catch (e) { note.className = "gen-note err"; note.textContent = "✗ " + e.message; }
    b.disabled = false; b.textContent = o;
  };
  if ($("ttPickAll")) $("ttPickAll").onchange = (e) => { ttItems.forEach(it => it._sel = e.target.checked); ttRender(); };
  if ($("ttZipBtn")) $("ttZipBtn").onclick = () => zipDownloadSelected(
    ttItems.filter(it => it._sel).map(it => (it._showText && it._textedUrl)
      ? { data: it._textedUrl, name: (it.title || "slide") + "-text" }
      : { id: (it.gallery && it.gallery.id) || "", url: (it.gallery && it.gallery.url) || "", name: it.title || "slide" }), $("ttZipBtn"));
  if ($("ttCapCopy")) $("ttCapCopy").onclick = async () => {
    if (!ttMeta) return;
    try { await navigator.clipboard.writeText(ttMeta.caption || ""); $("ttCapCopy").textContent = "✓ Đã copy"; setTimeout(() => $("ttCapCopy").textContent = "📋 Copy caption", 1200); } catch (e) {}
  };
  // 🖼️ Up ảnh của bạn + chèn text
  let ttUpQueue = [];
  const ttUpRender = () => {
    const row = $("ttUpPrev"); if (!row) return;
    row.innerHTML = "";
    ttUpQueue.forEach((durl, i) => {
      const wrap = document.createElement("div"); wrap.style.cssText = "position:relative;margin:5px 5px 0 0";
      wrap.innerHTML = '<img src="' + durl + '" style="width:52px;height:66px;object-fit:cover;border-radius:8px;border:1px solid var(--line)"><button style="position:absolute;top:-6px;right:-6px;width:18px;height:18px;border:0;border-radius:50%;background:rgba(0,0,0,.65);color:#fff;font-size:11px;line-height:1;cursor:pointer">×</button>';
      wrap.querySelector("button").onclick = () => { ttUpQueue.splice(i, 1); ttUpRender(); };
      row.appendChild(wrap);
    });
    if ($("ttUpName")) $("ttUpName").textContent = ttUpQueue.length ? ("✅ " + ttUpQueue.length + " ảnh — nhập text rồi bấm Chèn") : "⬆️ Tải / kéo-thả ảnh (chọn được nhiều)";
  };
  const ttUpAddFiles = async (files) => {
    for (const f of files) { if (f && f.type.startsWith("image/")) ttUpQueue.push(await fileToDataURL(f)); }
    ttUpRender();
  };
  if ($("ttUpFile")) $("ttUpFile").onchange = async (e) => { await ttUpAddFiles([...e.target.files]); e.target.value = ""; };
  if ($("ttUpDrop")) {
    $("ttUpDrop").ondragover = (e) => e.preventDefault();
    $("ttUpDrop").ondrop = async (e) => { e.preventDefault(); await ttUpAddFiles([...e.dataTransfer.files]); };
  }
  if ($("ttUpAdd")) $("ttUpAdd").onclick = async () => {
    const note = $("ttNote");
    if (!ttUpQueue.length) { note.className = "gen-note err"; note.textContent = "⚠️ Tải ảnh của bạn vào trước."; return; }
    const lines = ($("ttUpText").value || "").split("\n").map(s => s.trim()).filter(Boolean);
    if (!lines.length) { note.className = "gen-note err"; note.textContent = "⚠️ Nhập text (mỗi dòng = 1 dòng trên ảnh)."; return; }
    const b = $("ttUpAdd"); b.disabled = true; const o = b.textContent; b.textContent = "⏳ Đang chèn…";
    for (const durl of ttUpQueue) {
      let g = null;
      try {
        const r = await fetch("/api/save-design", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: durl, mode: "tiktok", label: "Slide up · " + (lines[0] || "").slice(0, 40) }) });
        const d = await r.json(); g = d.gallery || null;
      } catch (e) {}
      const it = { idx: 500 + ttItems.length, title: "Slide up · " + (lines[0] || "ảnh của bạn").slice(0, 30),
                   overlay: lines, position: $("ttUpPos").value, image: durl.split(",")[1], gallery: g };
      ttItems.push(it);
      await ttAutoBurn(it);
    }
    ttUpQueue = []; ttUpRender(); $("ttUpText").value = "";
    ttRender();
    note.className = "gen-note ok"; note.textContent = "✓ Đã chèn text + thêm vào bộ slide (cuộn xem bên phải).";
    b.disabled = false; b.textContent = o;
  };
  if ($("ttTextAll")) $("ttTextAll").onclick = async () => {
    const b = $("ttTextAll"); b.disabled = true; const o = b.textContent; b.textContent = "⏳ Đang chèn…";
    const on = !ttItems.every(it => it._showText);   // chưa bật hết -> bật hết; đang bật hết -> tắt hết
    for (const it of ttItems) {
      if (on && !it._textedUrl) { try { it._textedUrl = await ttTextedDataURL(it); } catch (e) {} }
      it._showText = on && !!it._textedUrl;
    }
    ttRender();
    b.disabled = false; b.textContent = on ? "🅰️ Bỏ text tất cả" : "🅰️ Chèn text tất cả";
  };
  if ($("ttDlTexted")) $("ttDlTexted").onclick = async () => {
    const sel = ttItems.filter(it => it._sel);
    if (!sel.length) { alert("⚠️ Chưa tick chọn slide nào."); return; }
    const b = $("ttDlTexted"); b.disabled = true; const o = b.textContent; b.textContent = "⏳ Đang tải…";
    for (const it of sel) {
      if (!it._textedUrl) { try { it._textedUrl = await ttTextedDataURL(it); } catch (e) { continue; } }
      autoDownload(it._textedUrl.split(",")[1], (it.title || "slide") + "-text");
      await new Promise(r => setTimeout(r, 400));
    }
    b.disabled = false; b.textContent = o;
  };
}
async function ttGenerate() {
  const note = $("ttNote"); note.className = "gen-note"; note.textContent = "";
  const btn = $("ttRunBtn"); btn.disabled = true; const old = btn.textContent; btn.textContent = "⏳ Đang tạo…";
  $("ttProgress").classList.remove("hidden");
  try {
    const r = await fetch("/api/tiktok-gift-gen", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ occasion: $("ttOccasion").value, gender: $("ttGender").value,
        tier: $("ttTier").value, concept: ($("ttConcept") && $("ttConcept").value) || "auto",
        n: parseInt($("ttCount").value, 10) || 6 }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Lỗi");
    ttJobs.push({ id: d.job_id, total: d.total, done: 0, finished: false });
    ttRender();
    note.className = "gen-note ok"; note.textContent = "🧠 AI đang chọn quà brand thật + lập bài… rồi Nano Banana Pro vẽ " + d.total + " slide.";
    if (!ttPollTimer) ttPollTimer = setInterval(ttPollAll, 2500);
    ttPollAll();
  } catch (e) { note.className = "gen-note err"; note.textContent = "✗ " + e.message; }
  btn.disabled = false; btn.textContent = old;
}
async function ttPollAll() {
  const active = ttJobs.filter(j => !j.finished);
  let errs = [];
  await Promise.all(active.map(async j => {
    try {
      // have: chỉ nhận slide MỚI, không tải lại base64 các slide đã về mỗi lần poll
      const d = await (await fetch("/api/batch-status?id=" + encodeURIComponent(j.id) + "&have=" + (j.have || 0))).json();
      j.total = Math.max(j.total || 0, d.total || 0);
      j.done = Math.max(j.done || 0, d.done || 0);
      j.finished = !!d.finished;
      j.have = (j.have || 0) + ((d.items || []).length);
      if (d.note) { try { ttMeta = JSON.parse(d.note); } catch (e) {} }
      (d.items || []).forEach(it => {
        const key = (it.gallery && it.gallery.id) || it.title;
        if (!ttItems.some(x => ((x.gallery && x.gallery.id) || x.title) === key)) {
          ttItems.push(it);
          ttAutoBurn(it);   // TỰ CHÈN TEXT ngay khi slide về (mặc định ảnh có text)
        }
      });
      (d.errors || []).forEach(e => errs.push(e));
    } catch (e) {}
  }));
  ttRender();
  const total = ttJobs.reduce((a, j) => a + (j.total || 0), 0);
  const done = ttJobs.reduce((a, j) => a + (j.done || 0), 0);
  const running = ttJobs.filter(j => !j.finished).length;
  $("ttBar").style.width = (total ? Math.round(done / total * 100) : 0) + "%";
  $("ttProgText").textContent = (running ? "⏳ đang vẽ · " : "✓ xong · ") + done + "/" + total;
  if (errs.length) { $("ttNote").className = "gen-note err"; $("ttNote").textContent = "⚠️ " + errs[0]; }
  if (!running && ttPollTimer) {
    clearInterval(ttPollTimer); ttPollTimer = null;
    if (!errs.length) { $("ttNote").className = "gen-note ok"; $("ttNote").textContent = "✓ Xong bài carousel! Tải ZIP ảnh + copy text overlay từng slide."; }
    if (typeof loadGallery === "function") loadGallery();
  }
}
/* 🅰️ Vẽ text overlay kiểu TikTok "text background": chữ ĐEN đậm trên NỀN TRẮNG bo tròn
   ôm sát từng dòng, các dòng nối liền thành khối, căn giữa, tự xuống dòng khi dài. */
async function ttTextedDataURL(it) {
  const src = it.image ? "data:image/png;base64," + it.image : ((it.gallery && it.gallery.url) || it.url);
  const img = await new Promise((res, rej) => { const im = new Image(); im.crossOrigin = "anonymous"; im.onload = () => res(im); im.onerror = rej; im.src = src; });
  const cv = document.createElement("canvas"); cv.width = img.naturalWidth || 1024; cv.height = img.naturalHeight || 1365;
  const cx = cv.getContext("2d"); cx.drawImage(img, 0, 0);
  const raw = (it.overlay || []).filter(Boolean);
  if (!raw.length) return cv.toDataURL("image/png");
  let fs = Math.round(cv.width * 0.05);
  cx.textAlign = "center"; cx.textBaseline = "middle";
  const setFont = () => { cx.font = "700 " + fs + "px -apple-system, 'Helvetica Neue', Arial, sans-serif"; };
  const maxW = cv.width * 0.82;
  const wrap = (line) => {   // tự xuống dòng theo từ
    setFont();
    if (cx.measureText(line).width <= maxW) return [line];
    const words = line.split(" "); const out = []; let cur = "";
    for (const w of words) {
      const t = cur ? cur + " " + w : w;
      if (cx.measureText(t).width > maxW && cur) { out.push(cur); cur = w; } else cur = t;
    }
    if (cur) out.push(cur);
    return out;
  };
  let lines = [];
  raw.forEach(l => { lines = lines.concat(wrap(l)); });
  while (fs > 20 && lines.length > 6) { fs -= 2; lines = []; raw.forEach(l => { lines = lines.concat(wrap(l)); }); }
  setFont();
  const lh = Math.round(fs * 1.55), padX = fs * 0.6, rad = fs * 0.45;
  const isBottom = (it.position || "").includes("dưới");
  const blockH = lh * lines.length;
  const yTop = isBottom ? (cv.height * 0.92 - blockH) : (cv.height * 0.05);
  const rrect = (x, y, w, h, r) => {
    r = Math.min(r, h / 2, w / 2);
    cx.beginPath();
    cx.moveTo(x + r, y);
    cx.arcTo(x + w, y, x + w, y + h, r); cx.arcTo(x + w, y + h, x, y + h, r);
    cx.arcTo(x, y + h, x, y, r); cx.arcTo(x, y, x + w, y, r);
    cx.closePath();
  };
  // nền trắng bo tròn từng dòng (chồng mí 1px cho liền khối)
  cx.fillStyle = "#ffffff";
  lines.forEach((l, i) => {
    const w = cx.measureText(l).width + padX * 2;
    rrect((cv.width - w) / 2, yTop + i * lh - (i > 0 ? 1 : 0), w, lh + (i < lines.length - 1 ? 2 : 0), rad);
    cx.fill();
  });
  // chữ đen đậm
  cx.fillStyle = "#111111";
  lines.forEach((l, i) => cx.fillText(l, cv.width / 2, yTop + i * lh + lh / 2 + 1));
  return cv.toDataURL("image/png");
}
async function ttAutoBurn(it) {
  if (!it.overlay || !it.overlay.length) return;
  try { it._textedUrl = await ttTextedDataURL(it); it._showText = true; ttRender(); } catch (e) {}
}
async function ttToggleText(it, card) {
  if (!it._textedUrl) { try { it._textedUrl = await ttTextedDataURL(it); } catch (e) { alert("✗ Không vẽ được text: " + e.message); return; } }
  it._showText = !it._showText;
  const img = card.querySelector("img");
  img.src = it._showText ? it._textedUrl : (it.image ? "data:image/png;base64," + it.image : ((it.gallery && it.gallery.url) || it.url));
  const b = card.querySelector(".b-text");
  if (b) { b.textContent = it._showText ? "🅰️ Bỏ text" : "🅰️ Text vào ảnh"; b.classList.toggle("on", it._showText); }
}
function ttUpdateSel() {
  const real = ttItems.length, sel = ttItems.filter(it => it._sel).length;
  if ($("ttSelBar")) $("ttSelBar").classList.toggle("hidden", real === 0);
  if ($("ttSelCount")) $("ttSelCount").textContent = "Đã chọn " + sel + "/" + real;
  if ($("ttPickAll")) $("ttPickAll").checked = real > 0 && sel === real;
}
function ttRender() {
  const grid = $("ttResults");
  const pending = ttJobs.reduce((a, j) => a + (j.finished ? 0 : Math.max(0, (j.total || 0) - (j.done || 0))), 0);
  $("ttCountBadge").textContent = ttItems.length ? "(" + ttItems.length + ")" : "";
  // meta: tiêu đề + caption + bonus + engine
  if (ttMeta) {
    $("ttCaptionBox").classList.remove("hidden");
    $("ttTitle").textContent = "📌 " + (ttMeta.title || "Bài carousel");
    $("ttCaption").textContent = ttMeta.caption || "";
    $("ttBonus").textContent = (ttMeta.bonus && ttMeta.bonus.length) ? ("🎁 Slide 8 (rieng.vn — bạn tự chụp áo): " + ttMeta.bonus.join(" / ")) : "";
    if ($("ttEngine")) $("ttEngine").textContent = ttMeta.engine ? ("🎨 " + ttMeta.engine) : "";
  }
  ttUpdateSel();
  if (!ttItems.length && !pending) { $("ttEmpty").classList.remove("hidden"); grid.innerHTML = ""; return; }
  $("ttEmpty").classList.add("hidden");
  grid.innerHTML = "";
  const sorted = ttItems.slice().sort((a, b) => (a.idx || 0) - (b.idx || 0));
  sorted.forEach(it => {
    const src = it.image ? "data:image/png;base64," + it.image : ((it.gallery && it.gallery.url) || it.url);
    const card = document.createElement("div"); card.className = "gcard";
    card.innerHTML =
      '<input type="checkbox" class="gpick tt-pick"' + (it._sel ? " checked" : "") + '>' +
      '<img src="' + src + '" loading="lazy" alt="">' +
      '<div class="gmeta">' + (it.title || "Slide") + '</div>' +
      '<div class="gacts"><button class="b-text">' + (it._showText ? "🅰️ Bỏ text" : "🅰️ Text vào ảnh") + '</button><button class="b-zoom">🔍 Zoom</button><button class="b-copy">📋 Ảnh</button><button class="b-dl">⬇ Tải</button><button class="b-del">🗑️ Xoá</button></div>';
    // 📝 TEXT OVERLAY (nội dung chính — hiện luôn, copy 1 chạm)
    if (it.overlay && it.overlay.length) {
      const ov = document.createElement("div");
      ov.style.cssText = "padding:7px 9px;border-top:1px solid var(--line);background:#f6f0ff";
      const pos = document.createElement("div");
      pos.style.cssText = "font-size:10px;color:var(--violet);font-weight:700;margin-bottom:3px";
      pos.textContent = "📝 TEXT OVERLAY (" + (it.position || "") + ") — chèn CapCut:";
      const tx = document.createElement("div");
      tx.style.cssText = "font-size:11.5px;line-height:1.5;white-space:pre-wrap";
      tx.textContent = it.overlay.join("\n");
      const cb = document.createElement("button");
      cb.className = "btn-ghost sm"; cb.style.cssText = "margin-top:5px;font-size:11px;padding:3px 9px";
      cb.textContent = "📋 Copy text";
      cb.onclick = async () => { try { await navigator.clipboard.writeText(it.overlay.join("\n")); cb.textContent = "✓ Đã copy"; setTimeout(() => cb.textContent = "📋 Copy text", 1200); } catch (e) {} };
      ov.appendChild(pos); ov.appendChild(tx); ov.appendChild(cb);
      card.appendChild(ov);
    }
    // ✏️ prompt ảnh
    if (it.prompt) {
      const det = document.createElement("details");
      det.style.cssText = "padding:5px 8px;border-top:1px solid var(--line);background:#fdfbfc";
      const sum = document.createElement("summary");
      sum.style.cssText = "cursor:pointer;font-size:11px;color:var(--violet);font-weight:600";
      sum.textContent = "✏️ Prompt ảnh";
      const pre = document.createElement("div");
      pre.style.cssText = "font-size:10.5px;line-height:1.45;color:var(--muted);margin-top:4px;max-height:120px;overflow:auto;white-space:pre-wrap";
      pre.textContent = it.prompt;
      const pc = document.createElement("button");
      pc.className = "btn-ghost sm"; pc.style.cssText = "margin-top:4px;font-size:11px;padding:3px 9px";
      pc.textContent = "📋 Copy prompt";
      pc.onclick = async (e) => { e.preventDefault(); try { await navigator.clipboard.writeText(it.prompt); pc.textContent = "✓ Đã copy"; setTimeout(() => pc.textContent = "📋 Copy prompt", 1200); } catch (err) {} };
      det.appendChild(sum); det.appendChild(pre); det.appendChild(pc);
      card.appendChild(det);
    }
    if (it._showText && it._textedUrl) card.querySelector("img").src = it._textedUrl;
    const b64 = async () => { if (it.image) return it.image; const b = await (await fetch(src)).blob(); return await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(",")[1]); fr.readAsDataURL(b); }); };
    card.querySelector(".tt-pick").onchange = (e) => { it._sel = e.target.checked; ttUpdateSel(); };
    card.querySelector(".b-text").onclick = () => ttToggleText(it, card);
    card.querySelector("img").onclick = () => openZoom(card.querySelector("img").src);
    card.querySelector(".b-zoom").onclick = () => openZoom(card.querySelector("img").src);
    card.querySelector(".b-copy").onclick = (e) => copyImageToClipboard(card.querySelector("img").src, e.currentTarget);
    card.querySelector(".b-dl").onclick = async () => {
      if (it._showText && it._textedUrl) autoDownload(it._textedUrl.split(",")[1], (it.title || "slide") + "-text");
      else autoDownload(await b64(), it.title || "slide");
    };
    card.querySelector(".b-del").onclick = async () => {
      if (!confirm("Xoá slide này?")) return;
      try { const gid = it.gallery && it.gallery.id; if (gid) await fetch("/api/gallery?id=" + encodeURIComponent(gid), { method: "DELETE" }); } catch (e) {}
      ttItems = ttItems.filter(x => x !== it); ttRender();
      if (typeof loadGallery === "function") loadGallery();
    };
    grid.appendChild(card);
  });
  // loading placeholder ở cuối (slide đang vẽ)
  for (let i = 0; i < pending; i++) {
    const c = document.createElement("div"); c.className = "gcard gcard-loading";
    c.innerHTML = '<div class="ds-loading"><span class="ds-spin"></span><span>Đang vẽ slide…</span></div>';
    grid.appendChild(c);
  }
}

/* =====================================================================
   TAB 👕 BỘ ÁO THEO TỆP — áo bố cục -> gpt-image-2 tạo bộ couple/GĐ, tự nghĩ tên
   ===================================================================== */
let ssInited = false, ssImg = null, ssBackImg = null, ssGroupKey = "couple", ssItems = [], ssJobs = [], ssPollTimer = null;
function ssInit() {
  if (ssInited) return; ssInited = true;
  const setImg = (durl) => {
    ssImg = durl;
    $("ssName").textContent = "✅ Đã có áo bố cục — chọn tệp rồi bấm Tạo";
    $("ssPrev").innerHTML = '<img src="' + durl + '" style="max-width:140px;max-height:140px;border-radius:10px;border:1px solid var(--line)"><button class="btn-ghost sm" id="ssImgX" style="vertical-align:top;margin-left:6px">✕</button>';
    $("ssImgX").onclick = () => { ssImg = null; $("ssPrev").innerHTML = ""; $("ssName").textContent = "⬆️ Tải / kéo-thả / dán ảnh áo bố cục"; };
  };
  $("ssFile").onchange = async (e) => { const f = e.target.files[0]; if (f && f.type.startsWith("image/")) setImg(await fileToDataURL(f)); e.target.value = ""; };
  $("ssDrop").ondragover = (e) => e.preventDefault();
  $("ssDrop").ondrop = async (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f && f.type.startsWith("image/")) setImg(await fileToDataURL(f)); };
  // 🔄 design mặt sau (tuỳ chọn)
  const setBack = (durl) => {
    ssBackImg = durl;
    $("ssBackName").textContent = "✅ Có design mặt sau — sẽ in vào lưng áo";
    $("ssBackPrev").innerHTML = '<img src="' + durl + '" style="max-width:110px;max-height:110px;border-radius:10px;border:1px solid var(--line)"><button class="btn-ghost sm" id="ssBackX" style="vertical-align:top;margin-left:6px">✕</button>';
    $("ssBackX").onclick = () => { ssBackImg = null; $("ssBackPrev").innerHTML = ""; $("ssBackName").textContent = "⬆️ Tải design mặt sau (nếu có)"; };
  };
  if ($("ssBackFile")) $("ssBackFile").onchange = async (e) => { const f = e.target.files[0]; if (f && f.type.startsWith("image/")) setBack(await fileToDataURL(f)); e.target.value = ""; };
  if ($("ssBackDrop")) {
    $("ssBackDrop").ondragover = (e) => e.preventDefault();
    $("ssBackDrop").ondrop = async (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f && f.type.startsWith("image/")) setBack(await fileToDataURL(f)); };
  }
  if (typeof attachUniversalPaste === "function") attachUniversalPaste();
  document.querySelectorAll("#ssGroup .cchip").forEach(c => c.onclick = () => {
    ssGroupKey = c.dataset.g;
    document.querySelectorAll("#ssGroup .cchip").forEach(x => x.classList.toggle("on", x === c));
  });
  $("ssRunBtn").onclick = ssGenerate;
  if ($("ssPickAll")) $("ssPickAll").onchange = (e) => { ssItems.forEach(it => it._sel = e.target.checked); ssRender(); };
  if ($("ssZipBtn")) $("ssZipBtn").onclick = () => zipDownloadSelected(
    ssItems.filter(it => it._sel).map(it => ({ id: (it.gallery && it.gallery.id) || "", url: (it.gallery && it.gallery.url) || "", name: it.title || "ao" })), $("ssZipBtn"));
}
function ssUpdateSel() {
  const real = ssItems.length, sel = ssItems.filter(it => it._sel).length;
  if ($("ssSelBar")) $("ssSelBar").classList.toggle("hidden", real === 0);
  if ($("ssSelCount")) $("ssSelCount").textContent = "Đã chọn " + sel + "/" + real;
  if ($("ssPickAll")) $("ssPickAll").checked = real > 0 && sel === real;
}
async function ssGenerate() {
  const note = $("ssNote"); note.className = "gen-note"; note.textContent = "";
  if (!ssImg) { note.className = "gen-note err"; note.textContent = "⚠️ Tải ảnh ÁO BỐ CỤC trước."; return; }
  const names = ($("ssNames").value || "").split(",").map(s => s.trim()).filter(Boolean);
  const btn = $("ssRunBtn"); btn.disabled = true; const old = btn.textContent; btn.textContent = "⏳ Đang tạo…";
  $("ssProgress").classList.remove("hidden");
  try {
    const r = await fetch("/api/setshirt-gen", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: ssImg, back: ssBackImg || "", group: ssGroupKey, names: names,
        aspect: $("ssAspect").value, quality: $("ssQuality").value }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Lỗi");
    ssJobs.push({ id: d.job_id, total: d.total, done: 0, finished: false });
    ssRender();
    note.className = "gen-note ok"; note.textContent = "⏳ GPT đang nghĩ tên + tạo " + d.total + " áo (giữ nguyên bố cục)…";
    if (!ssPollTimer) ssPollTimer = setInterval(ssPollAll, 2500);
    ssPollAll();
  } catch (e) { note.className = "gen-note err"; note.textContent = "✗ " + e.message; }
  btn.disabled = false; btn.textContent = old;
}
async function ssPollAll() {
  const active = ssJobs.filter(j => !j.finished);
  let errs = [];
  await Promise.all(active.map(async j => {
    try {
      const d = await (await fetch("/api/batch-status?id=" + encodeURIComponent(j.id))).json();
      j.total = Math.max(j.total || 0, d.total || 0);
      j.done = Math.max(j.done || 0, d.done || 0);
      j.finished = !!d.finished;
      (d.items || []).forEach(it => {
        const key = (it.gallery && it.gallery.id) || it.title;
        if (!ssItems.some(x => ((x.gallery && x.gallery.id) || x.title) === key)) ssItems.unshift(it);
      });
      (d.errors || []).forEach(e => errs.push(e));
    } catch (e) {}
  }));
  ssRender();
  const total = ssJobs.reduce((a, j) => a + (j.total || 0), 0);
  const done = ssJobs.reduce((a, j) => a + (j.done || 0), 0);
  const running = ssJobs.filter(j => !j.finished).length;
  $("ssBar").style.width = (total ? Math.round(done / total * 100) : 0) + "%";
  $("ssProgText").textContent = (running ? "⏳ đang chạy · " : "✓ xong · ") + done + "/" + total;
  if (errs.length) { $("ssNote").className = "gen-note err"; $("ssNote").textContent = "⚠️ " + errs[0]; }
  if (!running && ssPollTimer) {
    clearInterval(ssPollTimer); ssPollTimer = null;
    if (!errs.length) { $("ssNote").className = "gen-note ok"; $("ssNote").textContent = "✓ Xong bộ áo! (đã lưu Lịch sử)"; }
    if (typeof loadGallery === "function") loadGallery();
  }
}
function ssRender() {
  const grid = $("ssResults");
  const pending = ssJobs.reduce((a, j) => a + (j.finished ? 0 : Math.max(0, (j.total || 0) - (j.done || 0))), 0);
  $("ssCountBadge").textContent = ssItems.length ? "(" + ssItems.length + ")" : "";
  ssUpdateSel();
  if (!ssItems.length && !pending) { $("ssEmpty").classList.remove("hidden"); grid.innerHTML = ""; return; }
  $("ssEmpty").classList.add("hidden");
  grid.innerHTML = "";
  for (let i = 0; i < pending; i++) {
    const c = document.createElement("div"); c.className = "gcard gcard-loading";
    c.innerHTML = '<div class="ds-loading"><span class="ds-spin"></span><span>Đang tạo áo…</span></div>';
    grid.appendChild(c);
  }
  ssItems.forEach(it => {
    const src = it.image ? "data:image/png;base64," + it.image : ((it.gallery && it.gallery.url) || it.url);
    const card = document.createElement("div"); card.className = "gcard";
    card.innerHTML =
      '<input type="checkbox" class="gpick ss-pick"' + (it._sel ? " checked" : "") + '>' +
      '<img src="' + src + '" loading="lazy" alt="">' +
      '<div class="gmeta">' + (it.title || "Bộ áo") + '</div>' +
      '<div class="gacts"><button class="b-zoom">🔍 Zoom</button><button class="b-copy">📋 Copy</button><button class="b-dl">⬇ Tải</button><button class="b-del">🗑️ Xoá</button></div>';
    card.querySelector(".ss-pick").onchange = (e) => { it._sel = e.target.checked; ssUpdateSel(); };
    const b64 = async () => { if (it.image) return it.image; const b = await (await fetch(src)).blob(); return await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(",")[1]); fr.readAsDataURL(b); }); };
    card.querySelector("img").onclick = () => openZoom(src);
    card.querySelector(".b-zoom").onclick = () => openZoom(src);
    card.querySelector(".b-copy").onclick = (e) => copyImageToClipboard(src, e.currentTarget);
    card.querySelector(".b-dl").onclick = async () => autoDownload(await b64(), it.title || "bo-ao");
    card.querySelector(".b-del").onclick = async () => {
      if (!confirm("Xoá ảnh này?")) return;
      try { const gid = it.gallery && it.gallery.id; if (gid) await fetch("/api/gallery?id=" + encodeURIComponent(gid), { method: "DELETE" }); } catch (e) {}
      ssItems = ssItems.filter(x => x !== it); ssRender();
      if (typeof loadGallery === "function") loadGallery();
    };
    // ✏️ prompt xem + copy
    if (it.prompt) {
      const det = document.createElement("details");
      det.style.cssText = "padding:5px 8px;border-top:1px solid var(--line);background:#fdfbfc";
      const sum = document.createElement("summary");
      sum.style.cssText = "cursor:pointer;font-size:11px;color:var(--violet);font-weight:600";
      sum.textContent = "✏️ Prompt";
      const pre = document.createElement("div");
      pre.style.cssText = "font-size:10.5px;line-height:1.45;color:var(--muted);margin-top:4px;max-height:130px;overflow:auto;white-space:pre-wrap";
      pre.textContent = it.prompt;
      const cb = document.createElement("button");
      cb.className = "btn-ghost sm"; cb.style.cssText = "margin-top:4px;font-size:11px;padding:3px 9px";
      cb.textContent = "📋 Copy prompt";
      cb.onclick = async (e) => { e.preventDefault(); try { await navigator.clipboard.writeText(it.prompt); cb.textContent = "✓ Đã copy"; setTimeout(() => cb.textContent = "📋 Copy prompt", 1200); } catch (err) {} };
      det.appendChild(sum); det.appendChild(pre); det.appendChild(cb);
      card.appendChild(det);
    }
    grid.appendChild(card);
  });
}

/* =====================================================================
   TAB 🎁 PERSONALIZED — mọi dạng cá nhân hoá, 3 AI (Claude+GPT+Gemini) phân tích
   ===================================================================== */
let psnInited = false, psnPicked = new Set(), psnAuto = false, psnItems = [], psnJobs = [], psnPollTimer = null;
let psnPhoto = null, psnArtPicked = new Set();
function psnInit() {
  if (psnInited) return; psnInited = true;
  psnLoadStyles();
  $("psnAutoAi").onclick = () => {
    psnAuto = !psnAuto;
    $("psnAutoAi").textContent = psnAuto ? "🧠 3 AI phân tích: ĐANG BẬT (bấm để tắt)" : "🧠 3 AI phân tích & tự chọn dạng";
    $("psnAutoAi").classList.toggle("on", psnAuto);
  };
  $("psnRunBtn").onclick = psnGenerate;
  // 📸 Photo -> Art
  const setPhoto = (durl) => {
    psnPhoto = durl;
    $("psnPhotoName").textContent = "✅ Đã có ảnh — chọn art style rồi bấm Biến ảnh";
    $("psnPhotoPrev").innerHTML = '<img src="' + durl + '" style="max-width:110px;max-height:110px;border-radius:10px;border:1px solid var(--line)"><button class="btn-ghost sm" id="psnPhotoX" style="vertical-align:top;margin-left:6px">✕</button>';
    $("psnPhotoX").onclick = () => { psnPhoto = null; $("psnPhotoPrev").innerHTML = ""; $("psnPhotoName").textContent = "⬆️ Tải / kéo-thả / dán ảnh THẬT vào đây"; };
  };
  if ($("psnPhotoFile")) $("psnPhotoFile").onchange = async (e) => { const f = e.target.files[0]; if (f && f.type.startsWith("image/")) setPhoto(await fileToDataURL(f)); e.target.value = ""; };
  if ($("psnPhotoDrop")) {
    $("psnPhotoDrop").ondragover = (e) => e.preventDefault();
    $("psnPhotoDrop").ondrop = async (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f && f.type.startsWith("image/")) setPhoto(await fileToDataURL(f)); };
    if (typeof attachUniversalPaste === "function") attachUniversalPaste();   // quét dropzone mới (nút 📋 Dán)
  }
  if ($("psnArtRun")) $("psnArtRun").onclick = psnArtGenerate;
  if ($("psnPickAll")) $("psnPickAll").onchange = (e) => { psnItems.forEach(it => it._sel = e.target.checked); psnRender(); };
  if ($("psnZipBtn")) $("psnZipBtn").onclick = () => zipDownloadSelected(
    psnItems.filter(it => it._sel).map(it => ({ id: (it.gallery && it.gallery.id) || "", url: (it.gallery && it.gallery.url) || "", name: it.title || "mau" })), $("psnZipBtn"));
}
function psnUpdateSel() {
  const real = psnItems.length, sel = psnItems.filter(it => it._sel).length;
  if ($("psnSelBar")) $("psnSelBar").classList.toggle("hidden", real === 0);
  if ($("psnSelCount")) $("psnSelCount").textContent = "Đã chọn " + sel + "/" + real;
  if ($("psnPickAll")) $("psnPickAll").checked = real > 0 && sel === real;
}
async function psnArtGenerate() {
  const note = $("psnNote"); note.className = "gen-note"; note.textContent = "";
  if (!psnPhoto) { note.className = "gen-note err"; note.textContent = "⚠️ Tải ảnh THẬT vào trước (khung 📸)."; return; }
  if (!psnArtPicked.size) { note.className = "gen-note err"; note.textContent = "⚠️ Chọn ít nhất 1 art style."; return; }
  const names = ($("psnNames").value || "").split(",").map(s => s.trim()).filter(Boolean);
  const btn = $("psnArtRun"); btn.disabled = true; const old = btn.textContent; btn.textContent = "⏳ Đang biến ảnh…";
  $("psnProgress").classList.remove("hidden");
  try {
    const r = await fetch("/api/psn-art", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photo: psnPhoto, styles: [...psnArtPicked], name: names[0] || "",
        date: $("psnDate").value, extra: $("psnExtra").value, size: "portrait" }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Lỗi");
    psnJobs.push({ id: d.job_id, total: d.total, done: 0, finished: false });
    psnRender();
    note.className = "gen-note ok"; note.textContent = "⏳ Đang vẽ lại ảnh theo " + d.total + " style (giữ nét mặt)…";
    if (!psnPollTimer) psnPollTimer = setInterval(psnPollAll, 2500);
    psnPollAll();
  } catch (e) { note.className = "gen-note err"; note.textContent = "✗ " + e.message; }
  btn.disabled = false; btn.textContent = old;
}
async function psnLoadStyles() {
  try {
    const d = await (await fetch("/api/psn-styles")).json();
    const box = $("psnStyles"); box.innerHTML = "";
    (d.styles || []).forEach(s => {
      const el = document.createElement("div");
      el.className = "cchip" + (psnPicked.has(s.key) ? " on" : "");
      el.innerHTML = s.label + ' <span class="tick">✓</span>';
      el.onclick = () => { if (psnPicked.has(s.key)) psnPicked.delete(s.key); else psnPicked.add(s.key); el.classList.toggle("on"); };
      box.appendChild(el);
    });
    // art styles (📸 biến ảnh thật thành art)
    const ab = $("psnArtStyles");
    if (ab) {
      ab.innerHTML = "";
      (d.art || []).forEach(s => {
        const el = document.createElement("div");
        el.className = "cchip" + (psnArtPicked.has(s.key) ? " on" : "");
        el.innerHTML = s.label + ' <span class="tick">✓</span>';
        el.onclick = () => { if (psnArtPicked.has(s.key)) psnArtPicked.delete(s.key); else psnArtPicked.add(s.key); el.classList.toggle("on"); };
        ab.appendChild(el);
      });
    }
    const ai = d.ai || {};
    const on = ["claude", "gpt", "gemini"].filter(k => ai[k]);
    $("psnAiHint").textContent = "AI sẵn sàng: " + (on.length ? on.map(k => ({ claude: "Claude", gpt: "ChatGPT", gemini: "Gemini" })[k]).join(" + ") : "chưa có key nào") + " — cùng đọc data shop rồi bỏ phiếu chọn dạng.";
  } catch (e) {}
}
async function psnGenerate() {
  const note = $("psnNote"); note.className = "gen-note"; note.textContent = "";
  const names = ($("psnNames").value || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!psnAuto && !psnPicked.size) { note.className = "gen-note err"; note.textContent = "⚠️ Chọn ít nhất 1 dạng, hoặc bật 🧠 3 AI tự phân tích."; return; }
  const btn = $("psnRunBtn"); btn.disabled = true; const old = btn.textContent; btn.textContent = "⏳ Đang tạo…";
  $("psnProgress").classList.remove("hidden");
  try {
    const r = await fetch("/api/psn-gen", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: $("psnRole").value, occasion: $("psnOccasion").value, names: names,
        date: $("psnDate").value, extra: $("psnExtra").value, styles: [...psnPicked],
        auto_ai: psnAuto, n: parseInt($("psnCount").value, 10) || 3, size: "portrait" }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Lỗi");
    psnJobs.push({ id: d.job_id, total: d.total, done: 0, finished: false });
    psnRender();
    note.className = "gen-note ok";
    note.textContent = psnAuto ? "⏳ 3 AI đang phân tích data + chọn dạng, rồi vẽ…" : "⏳ Đang vẽ " + d.total + " mẫu…";
    if (!psnPollTimer) psnPollTimer = setInterval(psnPollAll, 2500);
    psnPollAll();
  } catch (e) { note.className = "gen-note err"; note.textContent = "✗ " + e.message; }
  btn.disabled = false; btn.textContent = old;
}
async function psnPollAll() {
  const active = psnJobs.filter(j => !j.finished);
  let errs = [];
  await Promise.all(active.map(async j => {
    try {
      const d = await (await fetch("/api/batch-status?id=" + encodeURIComponent(j.id))).json();
      j.total = Math.max(j.total || 0, d.total || 0);
      j.done = Math.max(j.done || 0, d.done || 0);
      j.finished = !!d.finished;
      if (d.note) $("psnAiUsed").textContent = d.note;
      (d.items || []).forEach(it => {
        const key = (it.gallery && it.gallery.id) || it.title;
        if (!psnItems.some(x => ((x.gallery && x.gallery.id) || x.title) === key)) psnItems.unshift(it);
      });
      (d.errors || []).forEach(e => errs.push(e));
    } catch (e) {}
  }));
  psnRender();
  const total = psnJobs.reduce((a, j) => a + (j.total || 0), 0);
  const done = psnJobs.reduce((a, j) => a + (j.done || 0), 0);
  const running = psnJobs.filter(j => !j.finished).length;
  $("psnBar").style.width = (total ? Math.round(done / total * 100) : 0) + "%";
  $("psnProgText").textContent = (running ? "⏳ đang chạy · " : "✓ xong · ") + done + "/" + total;
  if (errs.length) { $("psnNote").className = "gen-note err"; $("psnNote").textContent = "⚠️ " + errs[0]; }
  if (!running && psnPollTimer) {
    clearInterval(psnPollTimer); psnPollTimer = null;
    if (!errs.length) { $("psnNote").className = "gen-note ok"; $("psnNote").textContent = "✓ Xong! " + psnItems.length + " mẫu (đã lưu Lịch sử)."; }
    if (typeof loadGallery === "function") loadGallery();
  }
}
function psnRender() {
  const grid = $("psnResults");
  const pending = psnJobs.reduce((a, j) => a + (j.finished ? 0 : Math.max(0, (j.total || 0) - (j.done || 0))), 0);
  $("psnCountBadge").textContent = psnItems.length ? "(" + psnItems.length + ")" : "";
  psnUpdateSel();
  if (!psnItems.length && !pending) { $("psnEmpty").classList.remove("hidden"); grid.innerHTML = ""; return; }
  $("psnEmpty").classList.add("hidden");
  grid.innerHTML = "";
  for (let i = 0; i < pending; i++) {
    const c = document.createElement("div"); c.className = "gcard gcard-loading";
    c.innerHTML = '<div class="ds-loading"><span class="ds-spin"></span><span>Đang tạo…</span></div>';
    grid.appendChild(c);
  }
  psnItems.forEach(it => {
    const src = it.image ? "data:image/png;base64," + it.image : ((it.gallery && it.gallery.url) || it.url);
    const card = document.createElement("div"); card.className = "gcard";
    card.innerHTML =
      '<input type="checkbox" class="gpick psn-pick"' + (it._sel ? " checked" : "") + '>' +
      '<img src="' + src + '" loading="lazy" alt="">' +
      '<div class="gmeta">' + (it.title || "Personalized") + '</div>' +
      '<div class="gacts"><button class="b-zoom">🔍 Zoom</button><button class="b-use">👕 Lên áo</button><button class="b-cut">✂️ Tách nền</button><button class="b-copy">📋 Copy</button><button class="b-dl">⬇ Tải</button><button class="b-del">🗑️ Xoá</button></div>';
    // ✏️ PROMPT của mẫu (xem + copy)
    if (it.prompt) {
      const det = document.createElement("details");
      det.style.cssText = "padding:5px 8px;border-top:1px solid var(--line);background:#fdfbfc";
      const sum = document.createElement("summary");
      sum.style.cssText = "cursor:pointer;font-size:11px;color:var(--violet);font-weight:600";
      sum.textContent = "✏️ Prompt";
      const pre = document.createElement("div");
      pre.style.cssText = "font-size:10.5px;line-height:1.45;color:var(--muted);margin-top:4px;max-height:130px;overflow:auto;white-space:pre-wrap";
      pre.textContent = it.prompt;
      const cb = document.createElement("button");
      cb.className = "btn-ghost sm"; cb.style.cssText = "margin-top:4px;font-size:11px;padding:3px 9px";
      cb.textContent = "📋 Copy prompt";
      cb.onclick = async (e) => { e.preventDefault(); try { await navigator.clipboard.writeText(it.prompt); cb.textContent = "✓ Đã copy"; setTimeout(() => cb.textContent = "📋 Copy prompt", 1200); } catch (err) {} };
      det.appendChild(sum); det.appendChild(pre); det.appendChild(cb);
      card.appendChild(det);
    }
    const b64 = async () => { if (it.image) return it.image; const b = await (await fetch(src)).blob(); return await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(",")[1]); fr.readAsDataURL(b); }); };
    card.querySelector(".psn-pick").onchange = (e) => { it._sel = e.target.checked; psnUpdateSel(); };
    card.querySelector("img").onclick = () => openZoom(src);
    card.querySelector(".b-zoom").onclick = () => openZoom(src);
    card.querySelector(".b-copy").onclick = (e) => copyImageToClipboard(src, e.currentTarget);
    card.querySelector(".b-dl").onclick = async () => autoDownload(await b64(), it.title || "personalized");
    card.querySelector(".b-use").onclick = async () => { const d = await b64(); showApp("lenao"); if (typeof lenaoAddDesigns === "function") lenaoAddDesigns(["data:image/png;base64," + d]); };
    card.querySelector(".b-cut").onclick = async () => {
      const d = await b64();
      cutOpenManual(d, -1, (out) => { cutItems.unshift({ image: out }); showApp("cutout"); cutoutRender(); });
    };
    card.querySelector(".b-del").onclick = async () => {
      if (!confirm("Xoá mẫu này?")) return;
      try { const gid = it.gallery && it.gallery.id; if (gid) await fetch("/api/gallery?id=" + encodeURIComponent(gid), { method: "DELETE" }); } catch (e) {}
      psnItems = psnItems.filter(x => x !== it); psnRender();
      if (typeof loadGallery === "function") loadGallery();
    };
    grid.appendChild(card);
  });
}

/* =====================================================================
   ĐẨY SHOPIFY: chọn ảnh đã setup -> AI viết tên/mô tả -> tạo sản phẩm
   ===================================================================== */
let shopInited = false;
let shopItems = [];   // [{image(b64), fname, title, price, status, result}]

// đọc mô tả: có ảnh -> trả HTML (giữ <img>), chỉ chữ -> trả text thường
function shopDescValue() {
  const el = $("shopDesc"); if (!el) return "";
  if (el.querySelector && el.querySelector("img")) return (el.innerHTML || "").trim();
  return (el.textContent || "").trim();
}
function shopInit() {
  if (shopInited) return; shopInited = true;
  shopCheckStatus();
  // Dán ảnh (Ctrl/Cmd+V) thẳng vào ô mô tả -> chèn <img> base64 vào mô tả
  const sd = $("shopDesc");
  if (sd) {
    sd.addEventListener("paste", async (e) => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      for (const it of items) {
        if (it.type && it.type.startsWith("image/")) {
          e.preventDefault();
          const durl = await fileToDataURL(it.getAsFile());
          document.execCommand("insertHTML", false,
            '<img src="' + durl + '" style="max-width:100%;height:auto;display:block;margin:6px 0">');
          return;
        }
      }
    });
    // tự điền mô tả MẶC ĐỊNH đã lưu (chữ + ảnh)
    try {
      const saved = localStorage.getItem("shopDescDefault");
      if (saved && !sd.textContent.trim() && !sd.querySelector("img")) sd.innerHTML = saved;
    } catch (e) {}
  }
  if ($("shopDescSaveDefault")) $("shopDescSaveDefault").onclick = (e) => {
    try { localStorage.setItem("shopDescDefault", $("shopDesc").innerHTML || ""); } catch (er) {}
    const b = e.currentTarget, o = b.textContent; b.textContent = "✓ Đã lưu mặc định"; setTimeout(() => b.textContent = o, 1400);
  };
  if ($("shopDescClearDefault")) $("shopDescClearDefault").onclick = (e) => {
    try { localStorage.removeItem("shopDescDefault"); } catch (er) {}
    const b = e.currentTarget, o = b.textContent; b.textContent = "✓ Đã xoá"; setTimeout(() => b.textContent = o, 1200);
  };
  $("shopFile").onchange = (e) => shopAddFiles(e.target.files);
  const dz = $("shopDrop");
  dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("drag"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
  dz.addEventListener("drop", e => { e.preventDefault(); dz.classList.remove("drag"); shopAddFiles(e.dataTransfer.files); });
  $("shopClear").onclick = () => { shopItems = []; shopRender(); };
  $("shopPush").onclick = shopPush;
  // đổi size/giá -> cập nhật bảng Color×Size preview
  $("shopUseSizes").addEventListener("change", () => { shopRender(); shopRenderSizePrices(); });
  $("shopSizes").addEventListener("input", () => { shopRender(); shopRenderSizePrices(); });
  $("shopPrice").addEventListener("input", () => { if (!shopItems.some(it => it.price)) shopRender(); shopRenderSizePrices(); });
  if ($("shopPerSizePrice")) $("shopPerSizePrice").addEventListener("change", (e) => { $("shopSizePriceBox").classList.toggle("hidden", !e.target.checked); shopRenderSizePrices(); });
  $("shopSizeFile").onchange = async (e) => { const f = e.target.files[0]; if (f && f.type.startsWith("image/")) shopSetSizeChart(await fileToDataURL(f), f.name); e.target.value = ""; };
  const sz = $("shopSizeDrop");
  sz.addEventListener("dragover", e => { e.preventDefault(); sz.classList.add("drag"); });
  sz.addEventListener("dragleave", () => sz.classList.remove("drag"));
  sz.addEventListener("drop", async e => { e.preventDefault(); sz.classList.remove("drag"); const f = e.dataTransfer.files[0]; if (f && f.type.startsWith("image/")) shopSetSizeChart(await fileToDataURL(f), f.name); });
}
let shopSizePrices = {};  // size -> giá riêng (khi bật "giá theo size")
function shopRenderSizePrices() {
  const box = $("shopSizePriceBox"); if (!box) return;
  const on = $("shopPerSizePrice") && $("shopPerSizePrice").checked && $("shopUseSizes").checked;
  if (!on) { box.classList.add("hidden"); box.innerHTML = ""; return; }
  box.classList.remove("hidden");
  const sizes = ($("shopSizes").value || "").split(",").map(s => s.trim()).filter(Boolean);
  const def = ($("shopPrice").value || "").trim() || "219000";
  box.innerHTML = sizes.map(s =>
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">' +
    '<span style="width:46px;font-size:13px;font-weight:600">' + s.replace(/</g, "&lt;") + '</span>' +
    '<input type="text" class="input shop-szp" data-sz="' + s.replace(/"/g, "&quot;") + '" style="flex:1;padding:5px 8px" placeholder="mặc định ' + def + '" value="' + (shopSizePrices[s] || "") + '">' +
    '</div>').join("");
  box.querySelectorAll(".shop-szp").forEach(inp => inp.oninput = (e) => { const v = e.target.value.trim(); if (v) shopSizePrices[e.target.dataset.sz] = v; else delete shopSizePrices[e.target.dataset.sz]; });
}
let shopSizeChart = "";   // dataURL ảnh bảng size dùng chung
function shopSetSizeChart(durl, name) {
  shopSizeChart = durl ? durl.split(",")[1] : "";
  const row = $("shopSizeThumb"); row.innerHTML = "";
  if (durl) {
    const d = document.createElement("div"); d.className = "thumb";
    d.innerHTML = '<img src="' + durl + '" alt=""><button class="thumb-x">×</button>';
    d.querySelector(".thumb-x").onclick = () => { shopSetSizeChart("", ""); $("shopSizeName").textContent = "⬆️ Tải ảnh bảng size (tuỳ chọn — dùng chung cho tất cả)"; };
    row.appendChild(d);
    $("shopSizeName").textContent = "📐 " + (name || "Đã chọn ảnh bảng size");
  }
}

async function shopCheckStatus() {
  const b = $("shopBanner");
  try {
    const d = await (await fetch("/api/shopify-status")).json();
    // nạp danh sách theme template nếu shop trả về
    if (Array.isArray(d.templates) && d.templates.length && $("shopTemplate")) {
      const sel = $("shopTemplate");
      d.templates.forEach(t => {
        if ([...sel.options].some(o => o.value === t.value)) return;
        const o = document.createElement("option"); o.value = t.value; o.textContent = t.label || t.value;
        sel.appendChild(o);
      });
    }
    if (d.configured) {
      b.className = "shop-banner ok";
      b.innerHTML = "✅ Đã kết nối shop <b>" + (d.shop || "Shopify") + "</b> — sẵn sàng đẩy sản phẩm.";
    } else {
      b.className = "shop-banner warn";
      b.innerHTML = "⚠️ Chưa cấu hình Shopify token — giao diện đã sẵn sàng, cần thêm Admin API token để đẩy thật. (Vẫn xem trước được danh sách.)";
    }
  } catch (e) {
    b.className = "shop-banner warn";
    b.innerHTML = "⚠️ Chưa kết nối được Shopify (chưa cấu hình).";
  }
}

async function shopAddFiles(files) {
  // mỗi ảnh upload -> 1 sản phẩm (1 variant). Đẩy từ Lên áo -> 1 SP nhiều variant màu.
  for (const f of files) {
    if (!f.type.startsWith("image/")) continue;
    const durl = await fileToDataURL(f);
    shopItems.push({
      title: "", description: "", price: ($("shopPrice").value || "").trim(),
      status: $("shopStatus").value, result: null,
      variants: [{ image: durl.split(",")[1], color: "" }],
    });
  }
  shopRender();
}

function shopCurrentSizes() {
  return $("shopUseSizes").checked
    ? ($("shopSizes").value || "").split(",").map(s => s.trim()).filter(Boolean) : [];
}
// Bảng đủ Color×Size (như trang setup Shopify) — preview sẽ tạo
function shopMatrixHtml(it) {
  const vars = it.variants || [];
  const hasColor = vars.some(v => (v.color || "").trim());
  const sizes = shopCurrentSizes();
  const price = ((it.price || $("shopPrice").value || "").trim()) || "—";
  const priceTxt = price === "—" ? "(chưa có giá)" : price + "đ";
  const rows = [];
  const esc = s => (s || "").replace(/</g, "&lt;");
  if (hasColor) {
    vars.forEach(v => {
      const c = (v.color || "").trim() || "Màu";
      const sz = sizes.length ? sizes : [""];
      sz.forEach(s => rows.push(
        '<div class="vm-row"><img src="data:image/png;base64,' + v.image + '"><span class="vm-name">' +
        esc(c) + (s ? " / " + esc(s) : "") + '</span><span class="vm-price">' + priceTxt + "</span></div>"));
    });
  } else {
    const sz = sizes.length ? sizes : ["Mặc định"];
    const im = vars[0] ? '<img src="data:image/png;base64,' + vars[0].image + '">' : "";
    sz.forEach(s => rows.push('<div class="vm-row">' + im + '<span class="vm-name">' + esc(s) + '</span><span class="vm-price">' + priceTxt + "</span></div>"));
  }
  if (!rows.length) return "";
  return '<details class="vm-box"><summary>🧩 Xem đủ ' + rows.length + ' variant (Color×Size)</summary>' +
    '<div class="vm-list">' + rows.join("") + "</div></details>";
}
// chọn ảnh bìa từ THƯ VIỆN (ảnh sản phẩm / design đã tạo)
let coverPickFilter = "product";
async function openCoverPick(it) {
  let ov = document.getElementById("coverPickOv");
  if (!ov) { ov = document.createElement("div"); ov.id = "coverPickOv"; ov.className = "cover-ov"; document.body.appendChild(ov); }
  const FILT = [["product", "📸 Ảnh sản phẩm"], ["design", "✨ Design"], ["all", "Tất cả"]];
  ov.innerHTML =
    '<div class="cover-modal"><div class="cover-head"><b>Chọn ảnh bìa từ thư viện</b><button class="cover-close">✕</button></div>' +
    '<div class="cover-filters">' + FILT.map(f => '<button data-f="' + f[0] + '" class="' + (coverPickFilter === f[0] ? "on" : "") + '">' + f[1] + '</button>').join("") + '</div>' +
    '<div class="cover-grid" id="coverGrid"><p class="hint">Đang tải…</p></div></div>';
  ov.style.display = "flex";
  ov.querySelector(".cover-close").onclick = () => ov.style.display = "none";
  ov.onclick = (e) => { if (e.target === ov) ov.style.display = "none"; };
  let all = [];
  const draw = () => {
    const grid = ov.querySelector("#coverGrid");
    const imgs = coverPickFilter === "all" ? all
      : coverPickFilter === "product" ? all.filter(x => x.mode === "product")
      : all.filter(x => ["design", "personalize", "recolor", "auto"].includes(x.mode));
    if (!imgs.length) { grid.innerHTML = '<p class="hint">Chưa có ảnh. Tạo ở tab Ảnh sản phẩm / Tạo design trước.</p>'; return; }
    grid.innerHTML = "";
    imgs.slice(0, 150).forEach(g => {
      const im = document.createElement("img"); im.src = g.url; im.loading = "lazy";
      im.onclick = async () => {
        const b = await (await fetch(g.url)).blob();
        it.coverImage = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
        ov.style.display = "none"; shopRender();
      };
      grid.appendChild(im);
    });
  };
  ov.querySelectorAll(".cover-filters button").forEach(b => b.onclick = () => { coverPickFilter = b.dataset.f; ov.querySelectorAll(".cover-filters button").forEach(x => x.classList.toggle("on", x === b)); draw(); });
  try { const d = await (await fetch("/api/gallery")).json(); all = d.items || []; draw(); }
  catch (e) { ov.querySelector("#coverGrid").innerHTML = '<p class="hint">Lỗi tải thư viện.</p>'; }
}
// ảnh bìa: ảnh riêng (it.coverImage) nếu có, không thì ảnh variant đã chọn (⭐)
function shopCoverSrc(it) {
  if (it.coverImage) return it.coverImage;
  const vars = it.variants || [];
  const ci = (typeof it.cover === "number" && it.cover < vars.length) ? it.cover : 0;
  return vars[ci] ? "data:image/png;base64," + vars[ci].image : "";
}
function shopRender() {
  const box = $("shopList");
  $("shopCount").textContent = shopItems.length;
  $("shopEmpty").classList.toggle("hidden", shopItems.length > 0);
  box.innerHTML = "";
  shopItems.forEach((it, i) => {
    const row = document.createElement("div");
    row.className = "shop-row";
    const resv = it.result
      ? (it.result.ok ? '<a class="shop-link" href="' + (it.result.url || "#") + '" target="_blank">✅ Đã tạo →</a>'
                      : '<span class="shop-err">✗ ' + (it.result.error || "lỗi") + "</span>")
      : "";
    const vars = it.variants || [];
    if (typeof it.cover !== "number" || it.cover >= vars.length) it.cover = 0;
    const coverSrc = shopCoverSrc(it);
    const vthumbs = vars.map((v, vi) =>
      '<div class="shop-var' + (vi === it.cover ? " cover" : "") + '">' +
        '<img src="data:image/png;base64,' + v.image + '" alt="">' +
        (vi === it.cover ? '<span class="shop-cover-badge">Bìa</span>' : '<button class="shop-var-cover" data-vi="' + vi + '" title="Đặt làm ảnh bìa">⭐</button>') +
        '<input class="shop-var-c" data-vi="' + vi + '" placeholder="Màu" value="' + (v.color || "").replace(/"/g, "&quot;") + '">' +
        '<button class="shop-var-x" data-vi="' + vi + '" title="bỏ variant">×</button>' +
      "</div>").join("");
    row.innerHTML =
      '<img src="' + coverSrc + '" alt="">' +
      '<div class="shop-fields">' +
        '<input class="input sm shop-t" placeholder="Tên sản phẩm (để trống = AI tự viết)" value="' + (it.title || "").replace(/"/g, "&quot;") + '">' +
        '<textarea class="input sm shop-d" rows="2" placeholder="Mô tả (để trống = AI tự viết / dùng mặc định)">' + (it.description || "") + '</textarea>' +
        '<div class="shop-mini"><input class="input sm shop-p" placeholder="Giá VND" value="' + (it.price || "") + '">' +
        '<select class="input sm shop-s"><option value="DRAFT"' + (it.status === "DRAFT" ? " selected" : "") + '>Nháp</option><option value="ACTIVE"' + (it.status === "ACTIVE" ? " selected" : "") + '>Đăng bán</option></select>' +
        '<button class="shop-x">✕</button></div>' +
        '<div class="shop-cover">' +
          '<img class="shop-cover-img" src="' + coverSrc + '" alt="">' +
          '<div class="shop-cover-acts">' +
            '<div class="shop-cover-lbl">📌 <b>Ảnh bìa</b> ' + (it.coverImage ? '· ảnh riêng' : '· đang dùng ảnh áo (⭐)') + '</div>' +
            '<button class="btn-ghost sm shop-cover-pick">🖼️ Chọn từ thư viện</button>' +
            '<label class="btn-ghost sm">📁 Tải ảnh<input type="file" class="shop-cover-file" accept="image/*" hidden></label>' +
            '<button class="btn-ghost sm shop-cover-paste">📋 Dán</button>' +
            (it.coverImage ? '<button class="btn-ghost sm shop-cover-reset">↺ Dùng ảnh áo</button>' : '') +
          '</div>' +
        '</div>' +
        '<div class="shop-vlabel">' + (vars.some(v => (v.color || "").trim()) ? "🎨 " + vars.length + " variant màu (mỗi màu 1 ảnh)" : "🖼️ " + vars.length + " ảnh sản phẩm (media)") + ' — <b>bấm vào ảnh</b> (hoặc ⭐) để chọn ảnh đó làm bìa:</div>' +
        '<div class="shop-variants">' + vthumbs + "</div>" +
        shopMatrixHtml(it) +
        '<div class="shop-res">' + resv + "</div>" +
      "</div>";
    row.querySelector(".shop-t").oninput = (e) => it.title = e.target.value;
    row.querySelector(".shop-d").oninput = (e) => it.description = e.target.value;
    row.querySelector(".shop-p").oninput = (e) => it.price = e.target.value;
    row.querySelector(".shop-s").onchange = (e) => it.status = e.target.value;
    row.querySelector(".shop-x").onclick = () => { shopItems.splice(i, 1); shopRender(); };
    row.querySelectorAll(".shop-var-c").forEach(inp => inp.oninput = (e) => { vars[+e.target.dataset.vi].color = e.target.value; });
    row.querySelectorAll(".shop-var-cover").forEach(b => b.onclick = (e) => { it.cover = +e.currentTarget.dataset.vi; it.coverImage = null; shopRender(); });
    // BẤM THẲNG vào ảnh variant -> chọn làm ảnh bìa
    row.querySelectorAll(".shop-var img").forEach((im, vi) => { im.style.cursor = "pointer"; im.title = "Bấm để chọn làm ảnh bìa"; im.onclick = () => { it.cover = vi; it.coverImage = null; shopRender(); }; });
    const cf = row.querySelector(".shop-cover-file");
    if (cf) cf.onchange = async (e) => { const f = e.target.files[0]; if (f && f.type.startsWith("image/")) { it.coverImage = await fileToDataURL(f); shopRender(); } e.target.value = ""; };
    const cp = row.querySelector(".shop-cover-paste");
    if (cp) cp.onclick = async () => {
      try { const items = await navigator.clipboard.read(); for (const i of items) { const t = (i.types || []).find(x => x.startsWith("image/")); if (t) { it.coverImage = await fileToDataURL(await i.getType(t)); shopRender(); return; } } alert("Clipboard không có ảnh."); }
      catch (er) { alert("Trình duyệt chặn đọc clipboard — dùng 📁 Đổi ảnh bìa."); }
    };
    const cr = row.querySelector(".shop-cover-reset");
    if (cr) cr.onclick = () => { it.coverImage = null; shopRender(); };
    const cpk = row.querySelector(".shop-cover-pick");
    if (cpk) cpk.onclick = () => openCoverPick(it);
    row.querySelectorAll(".shop-var-x").forEach(b => b.onclick = (e) => {
      vars.splice(+e.target.dataset.vi, 1);
      if (!vars.length) shopItems.splice(i, 1);
      shopRender();
    });
    box.appendChild(row);
  });
}

async function shopPush() {
  const note = $("shopNote"); note.className = "gen-note"; note.textContent = "";
  if (!shopItems.length) { note.className = "gen-note err"; note.textContent = "⚠️ Chưa có sản phẩm nào."; return; }
  const defPrice = ($("shopPrice").value || "").trim();
  shopItems.forEach(it => { if (!it.price && defPrice) it.price = defPrice; });
  if (shopItems.some(it => !it.price)) { note.className = "gen-note err"; note.textContent = "⚠️ Nhập giá (mặc định hoặc từng sản phẩm)."; return; }
  $("shopProgress").classList.remove("hidden");
  $("shopBar").style.width = "0%"; $("shopProgText").textContent = "Đang đẩy…";
  $("shopPush").disabled = true;
  try {
    const r = await fetch("/api/shopify-push", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ai: $("shopAi").checked,
        productType: ($("shopType").value || "").trim(),
        vendor: ($("shopVendor").value || "").trim(),
        collection: ($("shopCollection").value || "").trim(),
        category: ($("shopCategory").value || "").trim(),
        templateSuffix: ($("shopTemplate").value || "").trim(),
        sizeChart: shopSizeChart || "",
        description: shopDescValue(),
        sizes: $("shopUseSizes").checked
          ? ($("shopSizes").value || "").split(",").map(s => s.trim()).filter(Boolean)
          : [],
        size_prices: ($("shopPerSizePrice") && $("shopPerSizePrice").checked) ? shopSizePrices : {},
        items: shopItems.map(it => ({ title: it.title, description: it.description, price: it.price, status: it.status, cover: it.cover || 0, coverImage: it.coverImage || "", variants: (it.variants || []).map(v => ({ image: v.image, color: v.color })) })),
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Lỗi đẩy Shopify");
    (d.results || []).forEach((res, i) => { if (shopItems[i]) shopItems[i].result = res; });
    shopRender();
    const ok = (d.results || []).filter(x => x.ok).length;
    note.className = "gen-note ok"; note.textContent = "✓ Đã đẩy " + ok + "/" + shopItems.length + " sản phẩm.";
    $("shopBar").style.width = "100%"; $("shopProgText").textContent = "Xong";
  } catch (err) {
    note.className = "gen-note err"; note.textContent = "✗ " + err.message;
    $("shopProgText").textContent = "Lỗi";
  } finally {
    $("shopPush").disabled = false;
  }
}

/* =====================================================================
   DANH SÁCH SẢN PHẨM SHOPIFY (xem + xoá)
   ===================================================================== */
let shoplistInited = false;
function shoplistInit() {
  if (!shoplistInited) { shoplistInited = true; $("shoplistRefresh").onclick = shoplistLoad; }
  shoplistLoad();
}
async function shoplistLoad() {
  const grid = $("shoplistGrid"), banner = $("shoplistBanner");
  banner.className = "shop-banner"; banner.textContent = "Đang tải…";
  grid.innerHTML = ""; $("shoplistEmpty").classList.add("hidden");
  try {
    const d = await (await fetch("/api/shopify-products")).json();
    if (d.error) throw new Error(d.error);
    const ps = d.products || [];
    banner.className = "shop-banner ok"; banner.innerHTML = "✅ " + ps.length + " sản phẩm mới nhất.";
    if (!ps.length) { $("shoplistEmpty").classList.remove("hidden"); return; }
    ps.forEach(p => {
      const card = document.createElement("div");
      card.className = "gcard";
      const price = p.price_min ? (p.price_min === p.price_max ? p.price_min : p.price_min + "–" + p.price_max) + "đ" : "";
      const stt = p.status === "active" ? '<span class="sl-badge on">Đang bán</span>' : '<span class="sl-badge">Nháp</span>';
      card.innerHTML =
        (p.image ? '<img src="' + p.image + '" alt="">' : '<div class="sl-noimg">No image</div>') +
        '<div class="gmeta" title="' + (p.title || "").replace(/"/g, "&quot;") + '">' + (p.title || "Sản phẩm") + '</div>' +
        '<div class="sl-info">' + stt + ' · ' + p.variants + ' variant' + (price ? ' · ' + price : '') + '</div>' +
        '<div class="gacts"><button class="b-adspush">🚀 Lên Ads luôn</button><button class="b-fbpost">📘 FB Post</button><button class="b-ads">📣 Tạo Ads</button><button class="b-edit">✏️ Sửa</button><button class="b-prod">📸 Ảnh SP</button><button class="b-open">🌐 Xem trang bán</button><button class="b-img">🖼️ Ảnh</button><button class="b-admin" title="Mở trong admin Shopify">⚙</button><button class="b-del">🗑️ Xoá</button></div>';
      card.querySelector(".b-prod").onclick = () => {
        if (!p.image) { alert("Sản phẩm này chưa có ảnh để tạo."); return; }
        showApp("product");
        if (typeof prodAddRef === "function") prodAddRef(p.image);
        const note = document.getElementById("prodNote");
        if (note) { note.className = "gen-note ok"; note.textContent = "✓ Đã nạp ảnh \"" + (p.title || "SP") + "\" làm tham chiếu. Nhập prompt rồi bấm Generate."; }
      };
      card.querySelector(".b-open").onclick = () => {
        if (p.status !== "active") {
          if (!confirm("Sản phẩm đang NHÁP nên trang bán chưa công khai (có thể 404). Vẫn mở?")) return;
        }
        window.open(p.store_url || p.url, "_blank");
      };
      card.querySelector("img")?.addEventListener("click", () => window.open(p.store_url || p.url, "_blank"));
      card.querySelector(".b-admin").onclick = () => window.open(p.url, "_blank");
      card.querySelector(".b-img").onclick = () => openImgUpdate(p);
      card.querySelector(".b-edit").onclick = () => openShopEdit(p);
      card.querySelector(".b-ads").onclick = () => adsFromProduct(p);
      card.querySelector(".b-adspush").onclick = () => { if (confirm("Tạo ảnh ads + tự ĐẨY lên FB Ads (PAUSED) cho \"" + (p.title || "SP") + "\"?")) adsFromProduct(p, true); };
      card.querySelector(".b-fbpost").onclick = () => fbpFromProduct(p);
      card.querySelector(".b-del").onclick = async (e) => {
        if (!confirm("Xoá sản phẩm \"" + (p.title || "") + "\" khỏi Shopify? (không hoàn tác)")) return;
        const btn = e.currentTarget; btn.disabled = true; btn.textContent = "⏳";
        try {
          const r = await fetch("/api/shopify-delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: p.id }) });
          const dd = await r.json();
          if (!r.ok) throw new Error(dd.error || "Lỗi xoá");
          card.remove();
        } catch (err) { alert("✗ " + err.message); btn.disabled = false; btn.textContent = "🗑️ Xoá"; }
      };
      grid.appendChild(card);
    });
  } catch (err) {
    banner.className = "shop-banner warn"; banner.textContent = "⚠️ " + err.message;
  }
}

/* ===== Sửa sản phẩm Shopify (mô tả / trạng thái / thêm variant) ===== */
let shopEditState = { id: null, p: null, varImg: null, images: [], coverId: null };
const SHOP_SIZES = ["S", "M", "L", "XL", "XXL"];
async function openShopEdit(p) {
  shopEditState = { id: p.id, p: p, varImg: null, images: [], coverId: null };
  $("shopEditName").textContent = "ID: " + p.id;
  $("shopEditNote").textContent = ""; $("shopEditNote").className = "gen-note";
  $("shopEditTitle").value = p.title || "";
  $("shopEditDesc").innerHTML = "<p class='hint'>Đang tải…</p>";
  $("shopCoverGrid").innerHTML = "<p class='hint'>Đang tải ảnh…</p>";
  $("shopVarPrice").value = "269000";
  $("shopVarImgPrev").innerHTML = ""; shopEditState.varImg = null;
  // size checkboxes
  $("shopVarSizes").innerHTML = SHOP_SIZES.map(s => '<label class="sz-chip"><input type="checkbox" value="' + s + '"' + (s === "M" ? " checked" : "") + '>' + s + '</label>').join("");
  $("shopEditModal").classList.remove("hidden");
  try {
    const d = await (await fetch("/api/shopify-product?id=" + encodeURIComponent(p.id))).json();
    if (d.error) throw new Error(d.error);
    $("shopEditTitle").value = d.title || p.title || "";
    $("shopEditDesc").innerHTML = d.body_html || "";
    $("shopEditStatus").value = d.status === "active" ? "active" : "draft";
    const colors = [...new Set((d.variants || []).map(v => v.option1).filter(Boolean))];
    $("shopEditVariants").textContent = "Hiện có: " + (d.variants || []).length + " variant" + (colors.length ? " · màu: " + colors.join(", ") : "");
    shopEditState.images = d.images || []; shopEditState.coverId = d.cover_id || (d.images && d.images[0] && d.images[0].id) || null;
    renderShopCover();
  } catch (e) { $("shopEditDesc").innerHTML = ""; $("shopCoverGrid").innerHTML = ""; $("shopEditNote").className = "gen-note err"; $("shopEditNote").textContent = "⚠️ " + e.message; }
}
function renderShopCover() {
  const grid = $("shopCoverGrid"); if (!grid) return;
  const imgs = shopEditState.images || [];
  if (!imgs.length) { grid.innerHTML = '<p class="hint">Sản phẩm chưa có ảnh — bấm "Thêm ảnh bìa mới".</p>'; return; }
  grid.innerHTML = "";
  imgs.forEach(im => {
    const isCover = im.id === shopEditState.coverId;
    const cell = document.createElement("div"); cell.className = "ads-style-cell" + (isCover ? " is-def" : "");
    cell.innerHTML = '<img src="' + im.src + '" loading="lazy" alt="">' + (isCover ? '<span class="cover-tag">BÌA</span>' : "");
    cell.querySelector("img").onclick = () => setShopCover({ image_id: im.id });
    grid.appendChild(cell);
  });
}
async function setShopCover(payload) {
  const note = $("shopEditNote"); note.className = "gen-note"; note.textContent = "⏳ Đang đặt ảnh bìa…";
  try {
    const r = await fetch("/api/shopify-set-cover", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: shopEditState.id, ...payload }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Lỗi");
    note.className = "gen-note ok"; note.textContent = "✓ Đã đổi ảnh bìa.";
    openShopEdit(shopEditState.p);   // refresh để thấy bìa mới
    if (typeof shoplistLoad === "function") shoplistLoad();
  } catch (e) { note.className = "gen-note err"; note.textContent = "✗ " + e.message; }
}
function closeShopEdit() { $("shopEditModal").classList.add("hidden"); }
if ($("shopEditClose")) $("shopEditClose").onclick = closeShopEdit;
if ($("shopEditModal")) $("shopEditModal").onclick = (e) => { if (e.target.id === "shopEditModal") closeShopEdit(); };
if ($("shopEditImages")) $("shopEditImages").onclick = () => { if (shopEditState.p) { closeShopEdit(); openImgUpdate(shopEditState.p); } };
if ($("shopCoverUpload")) $("shopCoverUpload").onclick = () => {
  const inp = document.createElement("input"); inp.type = "file"; inp.accept = "image/*";
  inp.onchange = async (e) => { const f = e.target.files[0]; if (f) { const durl = await fileToDataURL(f); setShopCover({ image: durl }); } };
  inp.click();
};
if ($("shopEditSave")) $("shopEditSave").onclick = async (e) => {
  const btn = e.currentTarget, note = $("shopEditNote"); btn.disabled = true; const o = btn.textContent; btn.textContent = "⏳ Đang lưu…";
  try {
    const r = await fetch("/api/shopify-update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: shopEditState.id, title: $("shopEditTitle").value.trim(), body_html: $("shopEditDesc").innerHTML, status: $("shopEditStatus").value }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Lỗi");
    note.className = "gen-note ok"; note.textContent = "✓ Đã lưu thông tin sản phẩm.";
    if (typeof shoplistLoad === "function") shoplistLoad();
  } catch (err) { note.className = "gen-note err"; note.textContent = "✗ " + err.message; }
  finally { btn.disabled = false; btn.textContent = o; }
};
if ($("shopVarImgBtn")) $("shopVarImgBtn").onclick = () => {
  const inp = document.createElement("input"); inp.type = "file"; inp.accept = "image/*";
  inp.onchange = async (e) => { const f = e.target.files[0]; if (f) { shopEditState.varImg = await fileToDataURL(f); $("shopVarImgPrev").innerHTML = '<img src="' + shopEditState.varImg + '" style="height:54px;border-radius:6px">'; } };
  inp.click();
};
if ($("shopVarAdd")) $("shopVarAdd").onclick = async (e) => {
  const btn = e.currentTarget, note = $("shopEditNote");
  const color = $("shopVarColor").value.trim();
  const sizes = [...$("shopVarSizes").querySelectorAll("input:checked")].map(i => i.value);
  if (!color) { note.className = "gen-note err"; note.textContent = "⚠️ Nhập tên màu."; return; }
  if (!sizes.length) { note.className = "gen-note err"; note.textContent = "⚠️ Chọn ít nhất 1 size."; return; }
  btn.disabled = true; const o = btn.textContent; btn.textContent = "⏳ Đang thêm…";
  try {
    const r = await fetch("/api/shopify-add-variant", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: shopEditState.id, color: color, sizes: sizes, price: $("shopVarPrice").value.trim(), image: shopEditState.varImg || "" }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Lỗi");
    note.className = "gen-note ok"; note.textContent = "✓ Đã thêm " + d.count + " variant màu \"" + color + "\".";
    $("shopVarColor").value = ""; shopEditState.varImg = null; $("shopVarImgPrev").innerHTML = "";
    openShopEdit(shopEditState.p);   // refresh danh sách variant
    if (typeof shoplistLoad === "function") shoplistLoad();
  } catch (err) { note.className = "gen-note err"; note.textContent = "✗ " + err.message; }
  finally { btn.disabled = false; btn.textContent = o; }
};

/* ===== Cập nhật ảnh cho sản phẩm Shopify có sẵn ===== */
let imgState = { id: null, name: "", uploads: [], prodSel: new Set(), prodPhotos: [] };
async function imgFinalImages() {
  const picked = [];
  for (const i of imgState.prodSel) {
    const ph = imgState.prodPhotos[i];
    if (!ph) continue;
    const b = await (await fetch(ph.url)).blob();
    const b64 = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(",")[1]); fr.readAsDataURL(b); });
    picked.push(b64);
  }
  return [...imgState.uploads, ...picked];
}
async function openImgUpdate(p) {
  imgState = { id: p.id, name: p.title || "", uploads: [], prodSel: new Set(), prodPhotos: [] };
  $("imgProdName").textContent = "Sản phẩm: " + (p.title || p.id);
  $("imgNote").textContent = ""; $("imgNote").className = "gen-note";
  document.querySelector('input[name="imgMode"][value="append"]').checked = true;
  $("imgProdPick").innerHTML = '<p class="hint" style="margin:0">Đang tải lịch sử ảnh sản phẩm…</p>';
  imgRenderUploads();
  $("imgModal").classList.remove("hidden");
  // tải toàn bộ ảnh sản phẩm đã tạo từ lịch sử
  try {
    const d = await (await fetch("/api/gallery")).json();
    imgState.prodPhotos = (d.items || []).filter(it => it.mode === "product").map(it => ({ url: it.url }));
  } catch (e) { imgState.prodPhotos = []; }
  imgRenderProdPick();
}
function closeImgUpdate() { $("imgModal").classList.add("hidden"); imgState = { id: null, name: "", uploads: [], prodSel: new Set(), prodPhotos: [] }; }
// lưới chọn từ TOÀN BỘ ảnh sản phẩm đã tạo (lịch sử)
function imgRenderProdPick() {
  const box = $("imgProdPick"); if (!box) return; box.innerHTML = "";
  const items = imgState.prodPhotos || [];
  if (!items.length) {
    box.innerHTML = '<p class="hint" style="margin:0">Chưa có ảnh — vào tab "📸 Ảnh sản phẩm" tạo ảnh trước, rồi quay lại đây.</p>';
    return;
  }
  items.forEach((it, i) => {
    const d = document.createElement("div");
    d.className = "img-cell" + (imgState.prodSel.has(i) ? " on" : "");
    d.innerHTML = '<img src="' + it.url + '" loading="lazy">' + (imgState.prodSel.has(i) ? '<span class="img-tick">✓</span>' : "");
    d.onclick = () => { if (imgState.prodSel.has(i)) imgState.prodSel.delete(i); else imgState.prodSel.add(i); imgRenderProdPick(); imgCount(); };
    box.appendChild(d);
  });
}
function imgRenderUploads() {
  const row = $("imgThumbs"); row.innerHTML = "";
  imgState.uploads.forEach((b, i) => {
    const d = document.createElement("div"); d.className = "thumb";
    d.innerHTML = '<img src="data:image/png;base64,' + b + '"><button class="thumb-x">×</button>';
    d.querySelector(".thumb-x").onclick = () => { imgState.uploads.splice(i, 1); imgRenderUploads(); imgCount(); };
    row.appendChild(d);
  });
  imgCount();
}
function imgCount() {
  const n = imgState.uploads.length + imgState.prodSel.size;
  $("imgDropName").textContent = n ? ("✅ Đã chọn " + n + " ảnh") : "⬆️ Tải / kéo-thả ảnh sản phẩm cần thêm";
}
async function imgAddFiles(files) {
  for (const f of files) {
    if (!f.type.startsWith("image/")) continue;
    const durl = await fileToDataURL(f);
    imgState.uploads.push(durl.split(",")[1]);
  }
  imgRenderUploads();
}
$("imgClose").onclick = closeImgUpdate;
$("imgModal").onclick = (e) => { if (e.target.id === "imgModal") closeImgUpdate(); };
$("imgFile").onchange = (e) => { imgAddFiles(e.target.files); e.target.value = ""; };
(() => {
  const dz = $("imgDrop");
  dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("drag"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
  dz.addEventListener("drop", e => { e.preventDefault(); dz.classList.remove("drag"); imgAddFiles(e.dataTransfer.files); });
})();
$("imgGo").onclick = async () => {
  if (!imgState.id) return;
  if (!(imgState.uploads.length + imgState.prodSel.size)) { $("imgNote").className = "gen-note err"; $("imgNote").textContent = "⚠️ Chưa chọn ảnh."; return; }
  const mode = document.querySelector('input[name="imgMode"]:checked').value;
  if (mode === "replace" && !confirm("Thay TOÀN BỘ ảnh sẽ xoá hết ảnh cũ (kể cả ảnh variant/bảng size). Tiếp tục?")) return;
  const btn = $("imgGo"), old = btn.textContent; btn.disabled = true; btn.textContent = "⏳ Đang tải…";
  $("imgNote").className = "gen-note"; $("imgNote").textContent = "Đang cập nhật ảnh…";
  try {
    const images = await imgFinalImages();
    const r = await fetch("/api/shopify-add-images", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: imgState.id, images, mode }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Lỗi cập nhật ảnh");
    $("imgNote").className = "gen-note ok"; $("imgNote").textContent = "✓ Đã thêm " + d.count + " ảnh.";
    setTimeout(() => { closeImgUpdate(); if (typeof shoplistLoad === "function") shoplistLoad(); }, 900);
  } catch (err) {
    $("imgNote").className = "gen-note err"; $("imgNote").textContent = "✗ " + err.message;
  } finally { btn.disabled = false; btn.textContent = old; }
};

/* ===== Chọn sản phẩm Shopify để đưa ảnh vào (từ tab Ảnh sản phẩm) ===== */
let pickProdImages = [];   // [{url}|{image}]
let pickProdAll = [];      // danh sách SP Shopify
async function openPickProd(images) {
  pickProdImages = images || [];
  $("pickProdInfo").textContent = "Sẽ thêm " + pickProdImages.length + " ảnh vào sản phẩm bạn chọn.";
  $("pickProdNote").textContent = ""; $("pickProdNote").className = "gen-note";
  $("pickProdSearch").value = "";
  $("pickProdList").innerHTML = '<p class="hint" style="margin:0">Đang tải sản phẩm…</p>';
  $("pickProdModal").classList.remove("hidden");
  try {
    const d = await (await fetch("/api/shopify-products")).json();
    pickProdAll = d.products || [];
    pickProdRenderList("");
  } catch (e) {
    $("pickProdList").innerHTML = '<p class="hint" style="margin:0">⚠️ Không tải được sản phẩm (kiểm tra kết nối Shopify).</p>';
  }
}
function pickProdRenderList(q) {
  const box = $("pickProdList"); box.innerHTML = "";
  const kw = (q || "").toLowerCase().trim();
  const list = pickProdAll.filter(p => !kw || (p.title || "").toLowerCase().includes(kw));
  if (!list.length) { box.innerHTML = '<p class="hint" style="margin:0">Không có sản phẩm.</p>'; return; }
  list.forEach(p => {
    const row = document.createElement("div");
    row.className = "pp-row";
    row.innerHTML = (p.image ? '<img src="' + p.image + '">' : '<div class="pp-noimg">—</div>') +
      '<span class="pp-name">' + (p.title || "SP") + '</span>';
    row.onclick = () => pickProdAdd(p);
    box.appendChild(row);
  });
}
async function pickProdAdd(p) {
  const note = $("pickProdNote"); note.className = "gen-note"; note.textContent = "Đang thêm ảnh vào \"" + (p.title || "") + "\"…";
  try {
    const imgs = [];
    for (const im of pickProdImages) {
      if (im.image) { imgs.push(im.image); continue; }
      const b = await (await fetch(im.url)).blob();
      imgs.push(await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(",")[1]); fr.readAsDataURL(b); }));
    }
    const r = await fetch("/api/shopify-add-images", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: p.id, images: imgs, mode: "append" }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Lỗi");
    note.className = "gen-note ok"; note.textContent = "✓ Đã thêm " + d.count + " ảnh vào \"" + (p.title || "") + "\".";
    setTimeout(() => $("pickProdModal").classList.add("hidden"), 1200);
  } catch (err) {
    note.className = "gen-note err"; note.textContent = "✗ " + err.message;
  }
}
$("pickProdClose").onclick = () => $("pickProdModal").classList.add("hidden");
$("pickProdModal").onclick = (e) => { if (e.target.id === "pickProdModal") $("pickProdModal").classList.add("hidden"); };
$("pickProdSearch").oninput = (e) => pickProdRenderList(e.target.value);

/* =====================================================================
   TÍNH NĂNG: TRỌN GÓI — wizard 3 bước
   ① Tạo design cá nhân hoá (gen đẹp + AI đặt tên) → ② Đổi màu → ③ Lên áo & Shopify
   ===================================================================== */
const AP_TEP = { single: "👤 1 áo", couple: "💑 Couple", family: "👨‍👩‍👧 Gia đình", group: "👥 Đội nhóm" };
const apColors = new Set(["black", "white", "brown", "sand", "forest", "red", "maroon"]);
let apInited = false, apStep = 1, apTep = "";
let apDesigns = [], apPicked = new Set(), apPersonalPicked = [];   // bước 1 (design đã có tên)
let apRecolored = [];                                             // bước 2
let apShots = [], apSel = new Set();                              // bước 3
let apT1 = null, apT2 = null;

const AP_TEP_LIST = [
  { key: "", label: "🤖 AI tự chọn" }, { key: "single", label: "👤 Cá nhân" },
  { key: "couple", label: "💑 Couple" }, { key: "family", label: "👨‍👩‍👧 Gia đình" },
  { key: "group", label: "👥 Đội nhóm" },
];
function apRenderTeps() {
  const box = $("apTeps"); if (!box) return; box.innerHTML = "";
  AP_TEP_LIST.forEach(t => {
    const el = document.createElement("div");
    el.className = "cchip" + (apTep === t.key ? " on" : "");
    el.innerHTML = t.label + ' <span class="tick">✓</span>';
    el.onclick = () => { apTep = t.key; apRenderTeps(); };
    box.appendChild(el);
  });
}
function apRenderColors() {
  const box = $("apColors"); if (!box) return; box.innerHTML = "";
  RECOLOR_LIST.forEach(c => {
    const el = document.createElement("div");
    el.className = "cchip" + (apColors.has(c.key) ? " on" : "");
    el.innerHTML = '<span class="sw" style="background:' + c.sw + '"></span> ' + c.vi + ' <span class="tick">✓</span>';
    el.onclick = () => { if (apColors.has(c.key)) apColors.delete(c.key); else apColors.add(c.key); apRenderColors(); };
    box.appendChild(el);
  });
}
function apInit() {
  if (apInited) return; apInited = true;
  apRenderTeps(); apRenderColors();
  $("apRunDesigns").onclick = apRunDesigns;
  $("apToStep2").onclick = apToStep2;
  $("apBack1").onclick = () => apGoStep(1);
  $("apDoRecolor").onclick = apDoRecolor;
  $("apToStep3").onclick = apToStep3;
  $("apBack2").onclick = () => apGoStep(2);
  $("apToShopify").onclick = apToShopify;
  $("apToShirtNow").onclick = apToShirtNow;
  $("apLoadOld").onclick = apLoadOld;
  $("apAddOld").onclick = apAddOld;
  // bấm nhảy bước tự do (không bắt buộc tuần tự)
  document.querySelectorAll(".ap-step").forEach(e => e.onclick = () => {
    const s = +e.dataset.s;
    if (s === 2 && ![...apPicked].length && !apPersonalPicked.length) { alert("Tạo & tick design trước."); return; }
    if (s === 3 && !apShots.length) { alert("Chưa có gì để lên áo — bấm “Lên áo luôn” hoặc “Đổi màu” trước."); return; }
    if (s === 2 && !apPersonalPicked.length) apPersonalPicked = [...apPicked].map(i => apDesigns[i]).filter(Boolean);
    if (s === 2) apRenderColors();
    apGoStep(s);
  });
}
function apGoStep(s) {
  apStep = s;
  [1, 2, 3].forEach(n => $("apStep" + n).classList.toggle("hidden", n !== s));
  document.querySelectorAll(".ap-step").forEach(e => e.classList.toggle("on", +e.dataset.s === s));
}
// đẩy design lên áo LUÔN (bỏ qua đổi màu) — design ghép thẳng lên 7 áo
function apToShirtNow() {
  apPersonalPicked = [...apPicked].map(i => apDesigns[i]).filter(Boolean);
  if (!apPersonalPicked.length) { alert("Tick ít nhất 1 design."); return; }
  apRecolored = apPersonalPicked.map(it => ({
    name: it.name, date: it.date, tep: it.tep, role: it.role, style: it.style,
    image: it.image || it.named, variants: [],   // không đổi màu -> dùng design gốc cho cả 7 áo
  }));
  apShots = apShotsFromItems(apRecolored, 0);
  apSel = new Set(); apGoStep(3); apRenderShirts();
}
async function apPoll(jobId, bar, txt, onItems, onDone) {
  try {
    const d = await (await fetch("/api/batch-status?id=" + encodeURIComponent(jobId))).json();
    $(bar).style.width = (d.total ? Math.round(d.done / d.total * 100) : 0) + "%";
    $(txt).textContent = "Đã xong " + d.done + "/" + d.total + (d.errors && d.errors.length ? " · ⚠️ " + d.errors.length : "");
    onItems(d.items || [], d.errors || []);
    if (d.finished) onDone(d.items || []);
  } catch (e) { /* tiếp tục */ }
}

/* ---------- helper: nút Xem lên áo + ô Sửa (dùng chung) ---------- */
function apPreviewItem(it) {
  if (!it) return;
  showApp("clone"); showDesign(it.image || it.named || it.design); $("sendToMockup").click();
}
async function apEditItem(it, card) {
  if (!it) return;
  const inp = card.querySelector(".ap-fixin"), btn = card.querySelector(".ap-fixbtn");
  const instr = (inp.value || "").trim(); if (!instr) { inp.focus(); return; }
  btn.disabled = true; const old = btn.textContent; btn.textContent = "⏳…";
  try {
    const r = await fetch("/api/pipe-edit", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: "data:image/png;base64," + (it.image || it.named || it.design), prompt: instr }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Lỗi");
    it.image = d.image; if ("named" in it) it.named = d.image;
    card.querySelector("img").src = "data:image/png;base64," + d.image; inp.value = "";
  } catch (err) { alert("✗ " + err.message); } finally { btn.disabled = false; btn.textContent = old; }
}
function apAttachActions(card, it) {
  card.querySelector(".b-shirt").onclick = () => apPreviewItem(it);
  const cp = card.querySelector(".b-copy");
  if (cp) cp.onclick = (e) => copyImageToClipboard("data:image/png;base64," + (it.image || it.named || it.design), e.currentTarget);
  const doFix = () => apEditItem(it, card);
  card.querySelector(".ap-fixbtn").onclick = doFix;
  card.querySelector(".ap-fixin").onkeydown = (e) => { if (e.key === "Enter") doFix(); };
}
const AP_ACTIONS_HTML =
  '<div class="gacts"><button class="b-shirt">👕 Xem lên áo</button><button class="b-copy">📋 Copy</button></div>' +
  '<div class="ap-fix"><input type="text" class="ap-fixin" placeholder="✏️ Yêu cầu sửa (vd: tên to hơn)…"><button class="ap-fixbtn">Sửa</button></div>';

/* ---------- BƯỚC 1: tạo design cá nhân hoá ---------- */
function apPick1N() { $("apToStep2").textContent = "Tiếp: Đổi màu (" + apPicked.size + ") →"; }
function apRenderDesigns() {
  const grid = $("apDesigns");
  $("apEmpty1").classList.toggle("hidden", apDesigns.length > 0);
  grid.innerHTML = "";
  apDesigns.forEach((it, i) => {
    const card = document.createElement("div"); card.className = "gcard";
    const tep = AP_TEP[it.tep] || it.tep || "";
    card.innerHTML =
      '<label class="hsel"><input type="checkbox"' + (apPicked.has(i) ? " checked" : "") + '></label>' +
      '<img src="data:image/png;base64,' + (it.image || it.named || it.design) + '" alt="">' +
      '<div class="gmeta"><b>' + (it.name || "") + '</b>' + (it.date ? " · " + it.date : "") + ' · ' + tep +
      '<br><span style="opacity:.7">' + (it.style || "") + '</span></div>' +
      AP_ACTIONS_HTML;
    card.querySelector(".hsel input").onchange = (e) => { if (e.target.checked) apPicked.add(i); else apPicked.delete(i); apPick1N(); };
    const img = card.querySelector("img"); img.onclick = () => openZoom(img.src);
    apAttachActions(card, it);
    grid.appendChild(card);
  });
  apPick1N();
}
async function apRunDesigns() {
  const note = $("apNote1"); note.className = "gen-note"; note.textContent = "";
  apDesigns = []; apPicked = new Set(); apRenderDesigns();
  const btn = $("apRunDesigns"); btn.disabled = true;
  $("apErr1").innerHTML = ""; $("apP1").classList.remove("hidden");
  $("apBar1").style.width = "0%"; $("apT1").textContent = "AI đang chọn style + vẽ + đặt tên…";
  try {
    const r = await fetch("/api/pipe-designs", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ n: parseInt($("apCount").value || "3", 10), niche: $("apNiche").value || "", tep: apTep }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Lỗi");
    if (apT1) clearInterval(apT1);
    apT1 = setInterval(() => apPoll(d.job_id, "apBar1", "apT1",
      (items, errs) => { apDesigns = items; apRenderDesigns(); $("apErr1").innerHTML = errs.map(e => "<div>⚠️ " + e + "</div>").join(""); },
      () => { clearInterval(apT1); apT1 = null; btn.disabled = false; note.className = "gen-note ok"; note.textContent = "✓ " + apDesigns.length + " design cá nhân hoá — tick mẫu đẹp rồi bấm “Tiếp: Đổi màu”."; setTimeout(() => $("apP1").classList.add("hidden"), 600); if (typeof loadGallery === "function") loadGallery(); }), 2500);
  } catch (err) { note.className = "gen-note err"; note.textContent = "✗ " + err.message; btn.disabled = false; $("apP1").classList.add("hidden"); }
}
function apToStep2() {
  apPersonalPicked = [...apPicked].map(i => apDesigns[i]).filter(Boolean);
  if (!apPersonalPicked.length) { alert("Tick ít nhất 1 design để đổi màu."); return; }
  apRenderColors(); apGoStep(2);
}

/* ---------- BƯỚC 2: đổi màu ---------- */
function apRenderRecolor() {
  const grid = $("apRecolorResults");
  $("apEmpty2").classList.toggle("hidden", apRecolored.length > 0);
  grid.innerHTML = "";
  apRecolored.forEach(it => {
    const vars = it.variants || [];
    const card = document.createElement("div"); card.className = "gcard";
    card.innerHTML =
      '<img src="data:image/png;base64,' + (vars[0] ? vars[0].recolored : it.image) + '" alt="">' +
      '<div class="ap-vars">' + vars.map(v => '<img class="ap-var" src="data:image/png;base64,' + v.recolored + '" title="áo ' + (v.color_vi || "") + '">').join("") + '</div>' +
      '<div class="gmeta"><b>' + (it.name || "") + '</b> · ' + vars.length + ' màu</div>';
    const main = card.querySelector("img");
    card.querySelectorAll(".ap-var").forEach(im => { im.onclick = () => main.src = im.src; });
    main.onclick = () => openZoom(main.src);
    grid.appendChild(card);
  });
}
async function apDoRecolor() {
  if (!apColors.size) { alert("Chọn ít nhất 1 màu áo."); return; }
  if (!apPersonalPicked.length) { alert("Chưa có mẫu nào."); return; }
  const note = $("apNote2"); note.className = "gen-note"; note.textContent = "";
  apRecolored = []; apRenderRecolor();
  const btn = $("apDoRecolor"); btn.disabled = true;
  $("apErr2").innerHTML = ""; $("apP2").classList.remove("hidden");
  $("apBar2").style.width = "0%"; $("apT2").textContent = "AI đang đổi màu…";
  try {
    const r = await fetch("/api/pipe-recolor", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ colors: [...apColors], designs: apPersonalPicked.map(it => ({ name: it.name, date: it.date, tep: it.tep, role: it.role, style: it.style, theme: it.theme, image: it.image || it.named })) }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Lỗi");
    if (apT2) clearInterval(apT2);
    apT2 = setInterval(() => apPoll(d.job_id, "apBar2", "apT2",
      (items, errs) => { apRecolored = items; apRenderRecolor(); $("apErr2").innerHTML = errs.map(e => "<div>⚠️ " + e + "</div>").join(""); },
      () => { clearInterval(apT2); apT2 = null; btn.disabled = false; note.className = "gen-note ok"; note.textContent = "✓ Đổi màu xong — bấm “Tiếp: Lên áo”."; setTimeout(() => $("apP2").classList.add("hidden"), 600); }), 2500);
  } catch (err) { note.className = "gen-note err"; note.textContent = "✗ " + err.message; btn.disabled = false; $("apP2").classList.add("hidden"); }
}

/* ---------- BƯỚC 3: lên áo (đủ 7 màu) + Shopify ---------- */
const AP_ALL_COLORS = ["white", "black", "brown", "sand", "forest", "red", "maroon"];
const AP_DARK = new Set(["black", "brown", "forest", "maroon", "red"]);
const AP_COLOR_VI = {};
(function () { RECOLOR_LIST.forEach(c => AP_COLOR_VI[c.key] = c.vi); })();
function apShotsFromItems(items, startDi) {
  const out = [];
  items.forEach((it, k) => {
    const di = startDi + k;
    const byColor = {}; (it.variants || []).forEach(v => byColor[v.color] = v.recolored);
    const lightRef = byColor.white || byColor.sand || null;
    const darkRef = byColor.black || byColor.forest || byColor.maroon || byColor.brown || byColor.red || null;
    const named = it.image || it.named || it.design;
    AP_ALL_COLORS.forEach(col => {
      const rec = byColor[col] || (AP_DARK.has(col) ? (darkRef || lightRef || named) : (lightRef || darkRef || named));
      out.push({ di: di, name: it.name, date: it.date, role: it.role, tep: it.tep,
        color: col, color_vi: AP_COLOR_VI[col] || col, recolored: rec, state: { x: 50, y: 43, w: 40 }, shirt: null });
    });
  });
  return out;
}
function apToStep3() {
  if (!apRecolored.length) { alert("Chưa có mẫu đã đổi màu."); return; }
  apShots = apShotsFromItems(apRecolored, 0);
  apSel = new Set(); apGoStep(3); apRenderShirts();
}
const AP_MOCKUP = { black: "ao_2_den.png", white: "ao_1_trang.png", brown: "ao_4_nau.png",
  sand: "ao_3_be.png", forest: "ao_7_xanhreu.png", red: "ao_5_do.png", maroon: "ao_6_dodo.png" };
const apMockCache = {};
async function apMock(color) {
  const fn = AP_MOCKUP[color]; if (!fn) return null;
  if (!apMockCache[color]) apMockCache[color] = await loadImg("/mockups/" + fn).catch(() => null);
  return apMockCache[color];
}
async function apComposeOne(color, designB64, st) {
  const shirt = await apMock(color);
  const des = await loadImg("data:image/png;base64," + designB64).catch(() => null);
  if (!shirt || !des) return "data:image/png;base64," + designB64;
  const sw = shirt.naturalWidth, sh = shirt.naturalHeight;
  const c = document.createElement("canvas"); c.width = sw; c.height = sh;
  const x = c.getContext("2d"); x.drawImage(shirt, 0, 0, sw, sh);
  const dw = sw * (st.w / 100), scale = dw / des.naturalWidth, dh = des.naturalHeight * scale;
  x.drawImage(des, sw * (st.x / 100) - dw / 2, sh * (st.y / 100) - dh / 2, dw, dh);
  return c.toDataURL("image/png");
}
function apShopN() {
  const n = new Set([...apSel].map(i => apShots[i] && apShots[i].di)).size;
  $("apToShopify").textContent = "🛍️ Đẩy mẫu đã chọn (" + n + ")";
}
async function apRenderShirts() {
  const grid = $("apResults");
  $("apEmpty3").classList.toggle("hidden", apShots.length > 0);
  grid.innerHTML = ""; apSel = new Set(); apShopN();
  for (let i = 0; i < apShots.length; i++) {
    const s = apShots[i];
    const url = await apComposeOne(s.color, s.recolored, s.state); s.shirt = url.split(",")[1];
    const card = document.createElement("div"); card.className = "gcard ap-shirt";
    card.innerHTML =
      '<label class="hsel"><input type="checkbox"></label>' +
      '<div class="gmeta" style="margin:0 0 4px"><b>Áo ' + (s.color_vi || "") + '</b> · ' + (s.name || s.role || "") + (s.date ? " · " + s.date : "") + '</div>' +
      '<img class="ap-main" src="' + url + '" alt="">' +
      '<div class="ap-edit">' +
        '<label>↔ <input type="range" class="ap-x" min="20" max="80" value="' + s.state.x + '"></label>' +
        '<label>↕ <input type="range" class="ap-y" min="20" max="75" value="' + s.state.y + '"></label>' +
        '<label>⤢ <input type="range" class="ap-w" min="15" max="70" value="' + s.state.w + '"></label>' +
      '</div>' +
      '<div class="gacts"><button class="b-copy">📋 Copy</button><button class="b-dl">⬇ Tải</button></div>';
    const idx = i;
    card.querySelector(".hsel input").onchange = (e) => { if (e.target.checked) apSel.add(idx); else apSel.delete(idx); apShopN(); };
    const mainImg = card.querySelector(".ap-main"); mainImg.onclick = () => openZoom(mainImg.src);
    card.querySelector(".b-copy").onclick = (e) => copyImageToClipboard(mainImg.src, e.currentTarget);
    let t = null;
    const onSlide = () => {
      s.state.x = +card.querySelector(".ap-x").value; s.state.y = +card.querySelector(".ap-y").value; s.state.w = +card.querySelector(".ap-w").value;
      clearTimeout(t); t = setTimeout(async () => { const u = await apComposeOne(s.color, s.recolored, s.state); s.shirt = u.split(",")[1]; mainImg.src = u; }, 120);
    };
    card.querySelectorAll(".ap-edit input").forEach(e => e.oninput = onSlide);
    card.querySelector(".b-dl").onclick = () => autoDownload(s.shirt, (s.name || "design") + "-ao-" + (s.color_vi || ""));
    grid.appendChild(card);
  }
}
function apToShopify() {
  const ticked = [...apSel].map(i => apShots[i]).filter(Boolean);
  if (!ticked.length) { alert("Tick ít nhất 1 áo để đẩy."); return; }
  const byDi = {}; ticked.forEach(s => { (byDi[s.di] = byDi[s.di] || []).push(s); });
  const products = Object.values(byDi);
  products.forEach(list => { shopItems.push({ title: "", description: "", price: "", status: "DRAFT", result: null, variants: list.map(s => ({ image: s.shirt, color: s.color_vi || "" })) }); });
  showApp("shopify"); shopRender();
  const note = $("shopNote"); note.className = "gen-note ok"; note.textContent = "✓ Đã đưa " + products.length + " sản phẩm sang Shopify — nhập giá rồi bấm Đẩy.";
}

/* ---------- thêm design CŨ từ Lịch sử (đổi màu 7 áo + lên áo) ---------- */
let apOldSel = new Set(), apTO2 = null;
async function apLoadOld() {
  const wrap = $("apOldWrap"); wrap.classList.toggle("hidden");
  if (wrap.classList.contains("hidden")) return;
  apOldSel = new Set();
  const grid = $("apOldGrid"); grid.innerHTML = '<div class="gallery-empty">Đang tải Lịch sử…</div>';
  try {
    const d = await (await fetch("/api/gallery")).json();
    const items = (d.items || []).filter(it => it.mode === "design" || it.mode === "personalize" || it.mode === "recolor");
    grid.innerHTML = "";
    if (!items.length) { grid.innerHTML = '<div class="gallery-empty">Chưa có design cũ.</div>'; return; }
    items.forEach(it => {
      const card = document.createElement("div"); card.className = "gcard";
      card.innerHTML = '<label class="hsel"><input type="checkbox"></label><img src="' + it.url + '" loading="lazy"><div class="gmeta">' + (it.prompt || "Design") + '</div>';
      card.querySelector(".hsel input").onchange = (e) => { if (e.target.checked) apOldSel.add(it.url); else apOldSel.delete(it.url); };
      card.querySelector("img").onclick = () => openZoom(it.url);
      grid.appendChild(card);
    });
  } catch (e) { grid.innerHTML = '<div class="gallery-empty">Lỗi tải Lịch sử.</div>'; }
}
async function apAddOld() {
  if (!apOldSel.size) { alert("Tick ít nhất 1 design cũ."); return; }
  if (!apColors.size) { alert("Chưa có màu áo."); return; }
  const btn = $("apAddOld"); btn.disabled = true;
  $("apPO").classList.remove("hidden"); $("apBarO").style.width = "0%"; $("apTO").textContent = "Đang nạp ảnh…";
  try {
    const designs = await Promise.all([...apOldSel].map(async (u) => {
      const blob = await (await fetch(u)).blob();
      const b64 = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
      return { name: "Design cũ", image: b64, tep: "single" };
    }));
    const r = await fetch("/api/pipe-recolor", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ colors: [...apColors], designs }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Lỗi");
    if (apTO2) clearInterval(apTO2);
    apTO2 = setInterval(() => apPoll(d.job_id, "apBarO", "apTO", () => {},
      (items) => {
        clearInterval(apTO2); apTO2 = null; btn.disabled = false; $("apPO").classList.add("hidden");
        const start = apRecolored.length;
        apRecolored = apRecolored.concat(items);
        apShots = apShots.concat(apShotsFromItems(items, start));
        apRenderShirts(); $("apOldWrap").classList.add("hidden");
      }), 2500);
  } catch (err) { alert("✗ " + err.message); btn.disabled = false; $("apPO").classList.add("hidden"); }
}

/* =====================================================================
   ĐĂNG BÀI: pick ảnh -> ảnh cuộn TikTok + post Facebook trực quan
   ===================================================================== */
let postInited = false;
let postAll = [];            // gallery items
let postFilter = "product";  // product | design | all
let postPicked = [];         // mảng url theo THỨ TỰ chọn
let postSlide = 0;
const POST_FILTERS = [
  { id: "product", label: "📸 Ảnh sản phẩm" },
  { id: "design", label: "✨ Design" },
  { id: "all", label: "Tất cả" },
];
function postInit() {
  if (!postInited) {
    postInited = true;
    $("postRefresh").onclick = postLoad;
    document.querySelectorAll('#view-post .rtab[data-ptab]').forEach(t => t.onclick = () => {
      document.querySelectorAll('#view-post .rtab[data-ptab]').forEach(x => x.classList.toggle("active", x === t));
      $("ppane-tiktok").classList.toggle("hidden", t.dataset.ptab !== "tiktok");
      $("ppane-facebook").classList.toggle("hidden", t.dataset.ptab !== "facebook");
    });
    $("ttPrev").onclick = () => postGoSlide(postSlide - 1);
    $("ttNext").onclick = () => postGoSlide(postSlide + 1);
    $("postAiBtn").onclick = postAiCaption;
    $("fbCaption").oninput = () => { $("fbText").textContent = $("fbCaption").value || "…"; };
    $("ttScript").oninput = postRenderPreview;
    $("ttCopy").onclick = () => postCopyText($("ttCaption").value, $("ttCopy"));
    $("fbCopy").onclick = () => postCopyText($("fbCaption").value, $("fbCopy"));
    $("postDownloadAll").onclick = postDownloadAll;
    $("postClear").onclick = () => { postPicked = []; postSlide = 0; postRenderGrid(); postRenderPreview(); };
    postRenderFilters();
  }
  postLoad();
}
function postRenderFilters() {
  const box = $("postFilters"); box.innerHTML = "";
  POST_FILTERS.forEach(f => {
    const el = document.createElement("div");
    el.className = "cchip" + (postFilter === f.id ? " on" : "");
    el.textContent = f.label;
    el.onclick = () => { postFilter = f.id; postRenderFilters(); postRenderGrid(); };
    box.appendChild(el);
  });
}
async function postLoad() {
  try { const d = await (await fetch("/api/gallery")).json(); postAll = d.items || []; }
  catch (e) { postAll = []; }
  postRenderGrid(); postRenderPreview();
}
function postFiltered() {
  if (postFilter === "all") return postAll;
  if (postFilter === "product") return postAll.filter(it => it.mode === "product");
  return postAll.filter(it => ["design", "personalize", "recolor", "auto"].includes(it.mode));
}
function postRenderGrid() {
  const grid = $("postGrid"), items = postFiltered();
  $("postEmpty").classList.toggle("hidden", items.length > 0);
  grid.innerHTML = "";
  items.forEach(it => {
    const card = document.createElement("div"); card.className = "gcard post-card";
    const order = postPicked.indexOf(it.url);
    card.innerHTML =
      '<div class="post-pick' + (order >= 0 ? " on" : "") + '">' + (order >= 0 ? (order + 1) : "+") + '</div>' +
      '<img src="' + it.url + '" loading="lazy" alt="">';
    const tog = () => postToggle(it.url);
    card.querySelector("img").onclick = tog;
    card.querySelector(".post-pick").onclick = tog;
    grid.appendChild(card);
  });
}
function postToggle(url) {
  const i = postPicked.indexOf(url);
  if (i >= 0) postPicked.splice(i, 1); else postPicked.push(url);
  if (postSlide >= postPicked.length) postSlide = Math.max(0, postPicked.length - 1);
  postRenderGrid(); postRenderPreview();
}
function postGoSlide(i) {
  if (!postPicked.length) return;
  postSlide = (i + postPicked.length) % postPicked.length;
  postRenderPreview();
}
function postSlideOverlay(i) {
  const lines = ($("ttScript").value || "").split("\n");
  const line = lines.find(l => new RegExp("SLIDE\\s*" + (i + 1) + "\\b", "i").test(l));
  if (!line) return "";
  const m = line.match(/[“”"]([^“”"]+)[“”"]/);
  return m ? m[1] : "";
}
async function postDownloadAll() {
  if (!postPicked.length) { const n = $("postNote"); n.className = "gen-note err"; n.textContent = "⚠️ Chưa chọn ảnh nào."; return; }
  const btn = $("postDownloadAll"), old = btn.textContent; btn.disabled = true;
  const n = $("postNote"); n.className = "gen-note"; n.textContent = "Đang tải " + postPicked.length + " ảnh (theo thứ tự slide)…";
  try {
    for (let i = 0; i < postPicked.length; i++) {
      btn.textContent = "⏳ " + (i + 1) + "/" + postPicked.length;
      const b = await (await fetch(postPicked[i])).blob();
      const b64 = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(",")[1]); fr.readAsDataURL(b); });
      autoDownload(b64, "slide-" + String(i + 1).padStart(2, "0"));
      await new Promise(r => setTimeout(r, 350));
    }
    n.className = "gen-note ok"; n.textContent = "✓ Đã tải " + postPicked.length + " ảnh (slide-01, slide-02…).";
  } catch (err) { n.className = "gen-note err"; n.textContent = "✗ " + err.message; }
  finally { btn.disabled = false; btn.textContent = old; }
}
function postRenderPreview() {
  $("postPickHint").textContent = "Đã chọn " + postPicked.length + " ảnh." + (postPicked.length ? " Bấm số/ảnh để bỏ chọn." : "");
  if ($("postDownloadAll")) $("postDownloadAll").textContent = "⬇ Tải tất cả (" + postPicked.length + ")";
  const has = postPicked.length > 0;
  $("ttEmpty").style.display = has ? "none" : "";
  const img = $("ttSlideImg");
  if (has) {
    if (postSlide >= postPicked.length) postSlide = 0;
    img.style.display = ""; img.src = postPicked[postSlide];
    $("ttCounter").textContent = (postSlide + 1) + "/" + postPicked.length;
  } else { img.style.display = "none"; $("ttCounter").textContent = ""; }
  $("ttOverlay").textContent = has ? postSlideOverlay(postSlide) : "";
  const dots = $("ttDots"); dots.innerHTML = "";
  postPicked.forEach((u, i) => {
    const d = document.createElement("span"); d.className = "tt-dot" + (i === postSlide ? " on" : "");
    d.onclick = () => postGoSlide(i); dots.appendChild(d);
  });
  postRenderFbImgs();
}
function postRenderFbImgs() {
  const box = $("fbImgs"); box.innerHTML = "";
  const imgs = postPicked.slice(0, 4);
  box.className = "fb-imgs n" + imgs.length;
  imgs.forEach((u, i) => {
    const d = document.createElement("div"); d.className = "fb-img";
    d.innerHTML = '<img src="' + u + '" alt="">';
    if (i === 3 && postPicked.length > 4) {
      const more = document.createElement("div"); more.className = "fb-more"; more.textContent = "+" + (postPicked.length - 4);
      d.appendChild(more);
    }
    box.appendChild(d);
  });
}
async function postCopyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text || "");
    const o = btn.textContent; btn.textContent = "✓ Đã copy"; setTimeout(() => btn.textContent = o, 1300);
  } catch (e) {
    const o = btn.textContent; btn.textContent = "✗ Bị chặn"; setTimeout(() => btn.textContent = o, 1500);
  }
}
async function postAiCaption() {
  const n = $("postNote");
  if (!postPicked.length) { n.className = "gen-note err"; n.textContent = "⚠️ Chọn ít nhất 1 ảnh."; return; }
  const btn = $("postAiBtn"), old = btn.textContent; btn.disabled = true; btn.textContent = "⏳ Đang viết…";
  n.className = "gen-note"; n.textContent = "AI đang nhìn ảnh & viết content…";
  try {
    const b = await (await fetch(postPicked[0])).blob();
    const durl = await fileToDataURL(b);
    const r = await fetch("/api/product-content", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: durl, info: "" }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Lỗi viết content");
    $("fbCaption").value = d.facebook || ""; $("fbText").textContent = d.facebook || "…";
    $("ttScript").value = d.tiktok_script || "";
    $("ttCaption").value = d.tiktok_caption || "";
    postRenderPreview();
    n.className = "gen-note ok"; n.textContent = "✓ Đã viết caption FB + kịch bản & caption TikTok (sửa tự do).";
  } catch (err) {
    n.className = "gen-note err"; n.textContent = "✗ " + err.message;
  } finally { btn.disabled = false; btn.textContent = old; }
}

/* =====================================================================
   DÁN ẢNH (Ctrl/Cmd+V) cho MỌI khu upload — định tuyến theo tab đang mở
   (Lên áo / Đổi màu / ô Mô tả đã có handler riêng -> bỏ qua ở đây)
   ===================================================================== */
document.addEventListener("paste", async (e) => {
  const items = (e.clipboardData && e.clipboardData.items) || [];
  let file = null;
  for (const it of items) { if (it.type && it.type.startsWith("image/")) { file = it.getAsFile(); break; } }
  if (!file) return;                                  // không phải ảnh -> để mặc định
  const ae = document.activeElement;
  if (ae && (ae.isContentEditable || ae.id === "shopDesc")) return;  // ô mô tả tự xử lý
  const av = [...document.querySelectorAll(".app-view")].find(el => !el.classList.contains("hidden"));
  const view = ((av && av.id) || "").replace("view-", "");
  if (view === "lenao" || view === "recolor") return; // đã có handler riêng
  e.preventDefault();
  const durl = await fileToDataURL(file);
  try {
    if (view === "clone") { await addFiles([file]); }
    else if (view === "auto") { autoUploaded.push(durl); autoRenderThumbs(); }
    else if (view === "addbg") { bgImg = durl; bgRenderThumb(); bgRender(); }
    else if (view === "product") { prodAddRef(durl); }
    else if (view === "design") { dsSetRef(durl); }
    else if (view === "ads") { adsHandlePaste(durl); }
    else if (view === "fbpost") { fbpHandlePaste(durl); }
    else if (view === "shopify") { await shopAddFiles([file]); }
    else if (view === "cutout") { await addCutFiles([file]); }
  } catch (err) { /* im lặng */ }
});

/* =====================================================================
   FACEBOOK ADS: AI đặt tên + gen ảnh ads theo concept (style ref) + chữ
   ===================================================================== */
let adsInited = false;
let adsDesignImg = null;        // dataURL design
let adsStyle = {};              // key -> dataURL ảnh style
let adsBg = {};                 // key -> background tuỳ chọn (text)
let adsNames = {};              // key -> "tên áo 1, tên áo 2…" (tuỳ chọn)
let adsSel = new Set();         // concept đã tick để gen
let adsItems = [];              // {loading,job} | item
let adsView = "list";
let adsPasteTo = "design";      // đích dán ảnh: "design" / "textstyle" / key concept
let adsTextStyleImg = null;     // ảnh mẫu kiểu chữ (áp dụng chung)
const ADS_CONCEPTS = [
  { key: "couple", label: "💑 Couple (2 áo)" },
  { key: "kids", label: "🧒 Trẻ con (2 bé)" },
  { key: "group", label: "👥 Đội nhóm (3 áo)" },
  { key: "family", label: "👨‍👩‍👧‍👦 Gia đình (4 áo)" },
  { key: "flatlay2", label: "🛋️ Flatlay 2 áo" },
  { key: "flatlay3", label: "🛋️ Flatlay 3 áo" },
];
let adsPickKey = null;          // concept đang chọn ảnh style
let adsStyleBank = [];          // [{id,url}] kho style ảnh
let adsTextStyleBank = [];      // [{id,url}] kho ảnh KIỂU CHỮ
let adsStyleMode = "concept";   // "concept" (style ảnh concept) | "textstyle" (kho kiểu chữ)
let adsStylePickFor = null;     // concept đang mở modal kho style
let adsDefaultStyleId = null;   // id style mặc định (localStorage)
let adsShopProducts = [];       // SP Shopify để pick design
let adsDesignPickTarget = "ads"; // "ads" | "fbpost"
let adsProductLink = "";        // link SP đang dùng (để đẩy FB Ads)
let adsProductImg = "";         // ảnh SP đang dùng (để hiện kiểm soát)
let fbPushItem = null;          // ad đang đẩy lên FB

function adsInit() {
  if (adsInited) return; adsInited = true;
  adsCheckEngine();
  $("adsDesignFile").onchange = async (e) => { const f = e.target.files[0]; if (f && f.type.startsWith("image/")) { adsDesignImg = await fileToDataURL(f); adsRenderDesign(); adsAutoName(); } e.target.value = ""; };
  $("adsNameBtn").onclick = () => adsAutoName(true);
  $("adsRunBtn").onclick = adsGenerate;
  $("adsViewList").onclick = () => adsSetView("list");
  $("adsViewGrid").onclick = () => adsSetView("grid");
  // input file dùng chung cho style ref (tải mới -> lưu vào KHO + áp cho concept đang chọn)
  const sf = document.createElement("input"); sf.type = "file"; sf.accept = "image/*"; sf.style.display = "none"; sf.id = "adsStyleFile";
  document.body.appendChild(sf);
  sf.onchange = async (e) => { const f = e.target.files[0]; if (f && f.type.startsWith("image/")) { const durl = await fileToDataURL(f); await adsAddStyleToBank(durl, adsStylePickFor || adsPickKey); } e.target.value = ""; };
  if ($("adsTextStyleFile")) $("adsTextStyleFile").onchange = async (e) => { const f = e.target.files[0]; if (f && f.type.startsWith("image/")) { adsTextStyleImg = await fileToDataURL(f); adsRenderTextStyle(); } e.target.value = ""; };
  // modal kho style
  adsDefaultStyleId = localStorage.getItem("adsDefaultStyleId") || null;
  if ($("adsStyleClose")) $("adsStyleClose").onclick = () => $("adsStyleModal").classList.add("hidden");
  if ($("adsStyleModal")) $("adsStyleModal").onclick = (ev) => { if (ev.target.id === "adsStyleModal") $("adsStyleModal").classList.add("hidden"); };
  if ($("adsStyleUpload")) $("adsStyleUpload").onclick = () => { adsPasteTo = "stylebank"; $("adsStyleFile").click(); };
  // pick design từ SP Shopify
  if ($("adsDesignFromShop")) $("adsDesignFromShop").onclick = () => { adsDesignPickTarget = "ads"; adsOpenDesignPick(); };
  if ($("adsDesignPickClose")) $("adsDesignPickClose").onclick = () => $("adsDesignPickModal").classList.add("hidden");
  if ($("adsMultiBtn")) $("adsMultiBtn").onclick = () => { const box = $("adsMultiInline"); if (box.classList.contains("hidden")) adsOpenMulti(); else box.classList.add("hidden"); };
  if ($("adsMultiClose")) $("adsMultiClose").onclick = () => $("adsMultiInline").classList.add("hidden");
  if ($("adsMultiSearch")) $("adsMultiSearch").oninput = (e) => adsRenderMulti(e.target.value);
  if ($("adsRegenClose")) $("adsRegenClose").onclick = () => $("adsRegenModal").classList.add("hidden");
  if ($("adsRegenModal")) $("adsRegenModal").onclick = (ev) => { if (ev.target.id === "adsRegenModal") $("adsRegenModal").classList.add("hidden"); };
  if ($("adsRegenGo")) $("adsRegenGo").onclick = adsRegenGo;
  if ($("adsSendBoard")) $("adsSendBoard").onclick = adpostAddSelected;
  if ($("adsPickAll")) $("adsPickAll").onchange = (e) => { adsItems.forEach(c => { if (!c.loading) c._sel = e.target.checked; }); adsRenderAll(); };
  if ($("adsDelSel")) $("adsDelSel").onclick = async () => {
    const sel = adsItems.filter(c => !c.loading && c._sel);
    const note = $("adsNote");
    if (!sel.length) { if (note) { note.className = "gen-note err"; note.textContent = "⚠️ Chưa chọn ảnh nào để xoá."; } return; }
    if (!confirm("Xoá " + sel.length + " ảnh ads đã chọn?")) return;
    for (const c of sel) { const gid = c.gallery && c.gallery.id; if (gid) await fetch("/api/gallery?id=" + encodeURIComponent(gid), { method: "DELETE" }).catch(() => {}); }
    adsItems = adsItems.filter(c => c.loading || !c._sel);
    if ($("adsPickAll")) $("adsPickAll").checked = false;
    adsRenderAll();
    if (typeof loadGallery === "function") loadGallery();
    if (note) { note.className = "gen-note ok"; note.textContent = "✓ Đã xoá " + sel.length + " ảnh."; }
  };
  if ($("adsDesignPickModal")) $("adsDesignPickModal").onclick = (ev) => { if (ev.target.id === "adsDesignPickModal") $("adsDesignPickModal").classList.add("hidden"); };
  if ($("adsDesignPickSearch")) $("adsDesignPickSearch").oninput = (e) => adsRenderDesignPick(e.target.value);
  // modal đẩy FB Ads
  if ($("fbPushClose")) $("fbPushClose").onclick = () => $("fbPushModal").classList.add("hidden");
  if ($("fbPushModal")) $("fbPushModal").onclick = (ev) => { if (ev.target.id === "fbPushModal") $("fbPushModal").classList.add("hidden"); };
  if ($("fbPushBtn")) $("fbPushBtn").onclick = fbDoPush;
  if ($("fbWriteBtn")) $("fbWriteBtn").onclick = () => { if (fbPushItem) fbWriteCaption(fbPushItem); };
  if ($("fbCampaign")) $("fbCampaign").onchange = fbOnCampaignChange;
  if ($("fbAdset")) $("fbAdset").onchange = fbOnAdsetChange;
  adsRenderDesign(); adsRenderConcepts(); adsRenderTextStyle(); adsRenderAll();
  adsLoadHistory(); adsLoadStyles();
}

// ---- Kho style (style ảnh concept + kho kiểu chữ) ----
// Mỗi concept 1 ảnh style RIÊNG (gắn sẵn) — KHÔNG dùng chung nguồn
const ADS_BUILTIN_STYLES = {
  couple: "/style-couple-default.webp",
  group: "/style-couple-default.webp",   // dùng chung ảnh couple thật làm tham chiếu style
  family: "/style-couple-default.webp",  // (concept vẫn ra 3/4 người, chỉ mượn phong cách)
  flatlay2: "/style-flatlay2.webp",
  flatlay3: "/style-flatlay3.webp",
};
let adsBuiltinByKey = {};   // key concept -> dataURL ảnh style riêng
async function adsLoadBuiltins() {
  for (const k in ADS_BUILTIN_STYLES) {
    if (adsBuiltinByKey[k]) continue;
    try {
      const b = await (await fetch(ADS_BUILTIN_STYLES[k] + "?v=2")).blob();
      adsBuiltinByKey[k] = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });
    } catch (e) {}
  }
}
async function adsLoadStyles() {
  try {
    await adsLoadBuiltins();
    const d = await (await fetch("/api/gallery")).json();
    adsStyleBank = (d.items || []).filter(it => it.mode === "adsstyle").map(it => ({ id: it.id, url: it.url }));
    // gắn 5 style builtin (mỗi concept 1 ảnh) lên đầu kho, đúng thứ tự concept
    ADS_CONCEPTS.slice().reverse().forEach(c => {
      const u = adsBuiltinByKey[c.key]; const id = "builtin-" + c.key;
      if (u && !adsStyleBank.some(s => s.id === id))
        adsStyleBank.unshift({ id: id, url: u, builtin: true, forKey: c.key, label: c.label });
    });
    adsTextStyleBank = (d.items || []).filter(it => it.mode === "adstextstyle").map(it => ({ id: it.id, url: it.url }));
    // MỖI concept dùng STYLE RIÊNG của nó làm mặc định (nếu chưa chọn cái khác)
    ADS_CONCEPTS.forEach(c => { if (!adsStyle[c.key] && adsBuiltinByKey[c.key]) adsStyle[c.key] = adsBuiltinByKey[c.key]; });
    adsRenderConcepts(); adsRenderStyleBank();
  } catch (e) {}
}

// thêm 1 ảnh vào kho theo mode hiện tại (concept style / kiểu chữ) rồi áp dụng
async function adsAddStyleToBank(durl, applyKey) {
  const isText = adsStyleMode === "textstyle";
  const mode = isText ? "adstextstyle" : "adsstyle";
  try {
    const r = await fetch("/api/save-design", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: durl, mode: mode, label: isText ? "FB Ads text style" : "FB Ads style" }) });
    const g = (await r.json()).gallery;
    if (isText) {
      if (g) adsTextStyleBank.unshift({ id: g.id, url: g.url });
      adsTextStyleImg = durl; adsRenderTextStyle();
    } else {
      if (g) adsStyleBank.unshift({ id: g.id, url: g.url });
      if (applyKey) { adsStyle[applyKey] = durl; adsSel.add(applyKey); adsSaveConceptStyle(applyKey, durl); }
      adsRenderConcepts();
    }
    adsRenderStyleBank();
    const n = $("adsStyleNote"); if (n) { n.className = "gen-note ok"; n.textContent = "✓ Đã lưu vào kho."; }
  } catch (e) { const n = $("adsStyleNote"); if (n) { n.className = "gen-note err"; n.textContent = "✗ " + e.message; } }
}

function adsOpenStylePicker(key) {
  adsStyleMode = "concept"; adsStylePickFor = key; adsPasteTo = "stylebank";
  $("adsStyleModal").querySelector("h3").textContent = "📁 Kho ảnh style — chọn tham chiếu";
  if ($("adsStyleUpload")) $("adsStyleUpload").textContent = "⬆️ Tải ảnh style mới";
  $("adsStyleInfo").textContent = "Chọn style cho: " + ((ADS_CONCEPTS.find(c => c.key === key) || {}).label || key) + ". AI chỉ copy phong cách, không lấy người/đồ vật.";
  $("adsStyleNote").textContent = "";
  adsRenderStyleBank();
  $("adsStyleModal").classList.remove("hidden");
}

function adsOpenTextStylePicker() {
  adsStyleMode = "textstyle"; adsStylePickFor = null; adsPasteTo = "stylebank";
  $("adsStyleModal").querySelector("h3").textContent = "🔤 Kho ảnh kiểu chữ";
  if ($("adsStyleUpload")) $("adsStyleUpload").textContent = "⬆️ Tải ảnh kiểu chữ mới";
  $("adsStyleInfo").textContent = "Bấm 1 ảnh để dùng làm mẫu kiểu chữ. AI chỉ bắt chước kiểu chữ, KHÔNG copy từ ngữ trong ảnh.";
  $("adsStyleNote").textContent = "";
  adsRenderStyleBank();
  $("adsStyleModal").classList.remove("hidden");
}

function adsRenderStyleBank() {
  const grid = $("adsStyleGrid"); if (!grid) return;
  const isText = adsStyleMode === "textstyle";
  const bank = isText ? adsTextStyleBank : adsStyleBank;
  if (!bank.length) { grid.innerHTML = '<p class="hint" style="grid-column:1/-1">Chưa có ảnh nào — bấm "⬆️ Tải ảnh mới" hoặc dán ảnh để thêm.</p>'; return; }
  grid.innerHTML = "";
  bank.forEach(s => {
    const isDef = !isText && s.id === adsDefaultStyleId;
    const cell = document.createElement("div"); cell.className = "ads-style-cell" + (isDef ? " is-def" : "");
    cell.innerHTML =
      '<img src="' + s.url + '" loading="lazy" alt="">' +
      (s.builtin
        ? '<span class="ads-style-badge" title="Style chuẩn gắn sẵn cho concept này">📌</span>' + (s.label ? '<span class="ads-style-cap">' + s.label + '</span>' : '')
        : ((isText ? "" : '<button class="ads-style-star" title="Đặt mặc định">' + (isDef ? "⭐" : "☆") + '</button>') + '<button class="ads-style-del" title="Xoá">×</button>'));
    cell.querySelector("img").onclick = () => adsPickStyle(s);
    if (s.builtin) { grid.appendChild(cell); return; }
    const star = cell.querySelector(".ads-style-star");
    if (star) star.onclick = (e) => { e.stopPropagation(); adsSetDefaultStyle(s.id); };
    cell.querySelector(".ads-style-del").onclick = async (e) => {
      e.stopPropagation(); if (!confirm("Xoá khỏi kho?")) return;
      try {
        await fetch("/api/gallery?id=" + encodeURIComponent(s.id), { method: "DELETE" });
        if (isText) adsTextStyleBank = adsTextStyleBank.filter(x => x.id !== s.id);
        else { adsStyleBank = adsStyleBank.filter(x => x.id !== s.id); if (adsDefaultStyleId === s.id) { adsDefaultStyleId = null; localStorage.removeItem("adsDefaultStyleId"); } }
        adsRenderStyleBank();
      } catch (err) { alert("✗ " + err.message); }
    };
    grid.appendChild(cell);
  });
}

// Lưu style của 1 concept lên server -> autopilot dùng đúng style FB Ads bạn setup
async function adsSaveConceptStyle(key, url) {
  if (!key || !url) return;
  try {
    let data = url;
    if (!String(url).startsWith("data:")) {
      const b = await (await fetch(url)).blob();
      data = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
    }
    fetch("/api/concept-style", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: key, image: data }) });
  } catch (e) {}
}
async function adsPickStyle(s) {
  if (adsStyleMode === "textstyle") { adsTextStyleImg = s.url; adsRenderTextStyle(); }
  else if (adsStylePickFor) { adsStyle[adsStylePickFor] = s.url; adsSel.add(adsStylePickFor); adsRenderConcepts(); adsSaveConceptStyle(adsStylePickFor, s.url); }
  $("adsStyleModal").classList.add("hidden");
}

// ---- 1 NÚT: từ SP Shopify -> nạp design + gen ads luôn ----
function adsFromProduct(p, autopush) {
  if (!p.image) { alert("Sản phẩm này chưa có ảnh để tạo ads."); return; }
  showApp("ads");                       // tự gọi adsInit
  adsProductLink = p.store_url || p.url || "";   // nhớ link SP để đẩy FB
  adsProductImg = p.image || "";
  if ($("adsLink")) $("adsLink").value = adsProductLink;   // hiện link vào ô
  adsAutoName2 = (p.title || "Áo Thun In Tên");
  setTimeout(() => {
    adsDesignImg = p.image; adsRenderDesign();
    adsSel.clear(); adsSel.add("flatlay3"); adsRenderConcepts();   // mặc định 1 concept
    const n = $("adsNote"); if (n) { n.className = "gen-note ok"; n.textContent = "✓ Đã nạp design từ \"" + (p.title || "SP") + "\" — đang tạo ads" + (autopush ? " + tự đẩy lên FB Ads…" : "…"); }
    adsGenerate(autopush);               // gen (+ tự đẩy nếu autopush)
  }, 150);
}
let adsAutoName2 = "";

// Tự đẩy 1 ad lên FB Ads với cấu hình mặc định (campaign mới, 50k/ngày, VN 18-55)
async function fbAutoPush(item) {
  const src = item.image ? "data:image/png;base64," + item.image : item.url;
  const link = adsProductLink || "https://rieng.vn";
  const msg = "🔥 " + (item.name || adsAutoName2 || "Áo Thun In Tên") + " — cá nhân hoá theo tên riêng.\n👉 Đặt ngay tại rieng.vn!";
  item._pushing = true; adsRenderAll();
  try {
    const r = await fetch("/api/fb-ads-push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: src, link: link, message: msg, name: item.name || adsAutoName2, headline: item.name || adsAutoName2, daily_budget: 50000, cta: "SHOP_NOW", genders: [], age_min: 18, age_max: 55, campaign_id: "", adset_id: "" }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Lỗi");
    item._pushing = false; item._pushed = d.manager_url || "";
  } catch (e) { item._pushing = false; item._pusherr = e.message; }
  adsRenderAll();
}

// ---- Đẩy 1 ad lên Facebook Ads (tạo chiến dịch PAUSED) ----
function adsPushToFb(c) {
  fbPushItem = c;
  const src = c.image ? "data:image/png;base64," + c.image : c.url;
  $("fbPushPreview").innerHTML = '<img src="' + src + '" style="max-height:130px;border-radius:8px;display:block;margin:0 auto">';
  $("fbLink").value = c.link || adsProductLink || "";          // tự lấy link SP
  $("fbCampaignName").value = ""; $("fbAdsetName").value = "";
  $("fbPushNote").textContent = "";
  $("fbPushModal").classList.remove("hidden");
  fbLoadCampaigns();
  fbWriteCaption(c);                                            // AI tự viết bài
}
async function fbWriteCaption(c) {
  const ta = $("fbMessage"), btn = $("fbWriteBtn");
  const fallback = "🔥 " + (c.name || "Áo Thun In Tên") + " — " + (c.hook || "Cá nhân hoá theo tên riêng") + "\n✨ In tên riêng theo yêu cầu, chất vải đẹp, giao toàn quốc.\n👉 Đặt ngay tại rieng.vn!";
  const src = c.image ? "data:image/png;base64," + c.image : c.url;
  ta.value = "⏳ AI đang viết bài quảng cáo cho ảnh này…";
  if (btn) { btn.disabled = true; }
  try {
    const r = await fetch("/api/product-content", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: src, info: "Áo thun in tên cá nhân hoá, thương hiệu rieng.vn" }) });
    const d = await r.json();
    ta.value = (r.ok && (d.facebook || "").trim()) ? d.facebook.trim() : fallback;
  } catch (e) { ta.value = fallback; }
  finally { if (btn) btn.disabled = false; }
}
async function fbLoadCampaigns() {
  const sel = $("fbCampaign");
  try {
    const d = await (await fetch("/api/fb-campaigns")).json();
    sel.innerHTML = '<option value="">➕ Tạo chiến dịch mới</option>';
    (d.campaigns || []).forEach(c => { const o = document.createElement("option"); o.value = c.id; o.textContent = (c.name || c.id) + (c.status === "PAUSED" ? " (dừng)" : ""); sel.appendChild(o); });
  } catch (e) {}
  fbOnCampaignChange();
}
async function fbOnCampaignChange() {
  const cid = $("fbCampaign").value;
  $("fbCampaignName").style.display = cid ? "none" : "";
  const sel = $("fbAdset");
  sel.innerHTML = '<option value="">➕ Tạo nhóm mới</option>';
  if (cid) {
    try {
      const d = await (await fetch("/api/fb-adsets?campaign_id=" + encodeURIComponent(cid))).json();
      (d.adsets || []).forEach(a => { const o = document.createElement("option"); o.value = a.id; o.textContent = a.name || a.id; sel.appendChild(o); });
    } catch (e) {}
  }
  fbOnAdsetChange();
}
function fbOnAdsetChange() {
  const aid = $("fbAdset").value;
  $("fbAdsetName").style.display = aid ? "none" : "";
  $("fbNewAdsetFields").style.display = aid ? "none" : "";   // nhóm sẵn -> ngân sách/đối tượng kế thừa
}
async function fbDoPush() {
  const note = $("fbPushNote"), btn = $("fbPushBtn"), c = fbPushItem;
  if (!c) return;
  const link = $("fbLink").value.trim();
  if (!link) { note.className = "gen-note err"; note.textContent = "⚠️ Nhập link đích (trang sản phẩm)."; return; }
  const src = c.image ? "data:image/png;base64," + c.image : c.url;
  btn.disabled = true; const o = btn.textContent; btn.textContent = "⏳ Đang đẩy…";
  note.className = "gen-note"; note.textContent = "Đang tạo chiến dịch (PAUSED)…";
  try {
    const g = $("fbGender").value;
    const r = await fetch("/api/fb-ads-push", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: src, link: link, message: $("fbMessage").value.trim(),
        name: c.name || "Áo Thun In Tên", headline: c.name || "Áo Thun In Tên",
        campaign_id: $("fbCampaign").value, campaign_name: $("fbCampaignName").value.trim(),
        adset_id: $("fbAdset").value, adset_name: $("fbAdsetName").value.trim(),
        daily_budget: $("fbBudget").value, cta: $("fbCta").value,
        genders: g ? [parseInt(g)] : [], age_min: $("fbAgeMin").value, age_max: $("fbAgeMax").value,
      }),
    });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Lỗi");
    note.className = "gen-note ok";
    note.innerHTML = "✓ Đã tạo chiến dịch <b>PAUSED</b>! <a href='" + d.manager_url + "' target='_blank' style='color:var(--violet);font-weight:600'>Mở Ads Manager để duyệt &amp; bật chạy →</a>";
  } catch (e) { note.className = "gen-note err"; note.textContent = "✗ " + e.message; }
  finally { btn.disabled = false; btn.textContent = o; }
}

// ---- Pick DESIGN từ sản phẩm Shopify ----
async function adsOpenDesignPick() {
  $("adsDesignPickModal").classList.remove("hidden");
  const grid = $("adsDesignPickGrid"); grid.innerHTML = '<p class="hint" style="grid-column:1/-1">Đang tải sản phẩm…</p>';
  $("adsDesignPickNote").textContent = "";
  try {
    const d = await (await fetch("/api/shopify-products")).json();
    if (d.error) throw new Error(d.error);
    adsShopProducts = (d.products || []).filter(p => p.image);
    adsRenderDesignPick("");
  } catch (e) { grid.innerHTML = ""; $("adsDesignPickNote").className = "gen-note err"; $("adsDesignPickNote").textContent = "⚠️ " + e.message; }
}
// BƯỚC 1: lưới sản phẩm (bấm 1 SP -> xem TẤT CẢ ảnh của SP đó)
function adsRenderDesignPick(q) {
  const grid = $("adsDesignPickGrid"); if (!grid) return;
  if ($("adsDesignPickSearch")) $("adsDesignPickSearch").style.display = "";
  const list = (adsShopProducts || []).filter(p => !q || (p.title || "").toLowerCase().includes(q.toLowerCase()));
  if (!list.length) { grid.innerHTML = '<p class="hint" style="grid-column:1/-1">Không có sản phẩm.</p>'; return; }
  grid.innerHTML = "";
  list.forEach(p => {
    const cell = document.createElement("div"); cell.className = "ads-style-cell";
    cell.innerHTML = '<img src="' + p.image + '" loading="lazy" alt=""><span class="cover-tag" style="background:rgba(0,0,0,.6);max-width:92%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (p.title || "").replace(/</g, "&lt;").slice(0, 22) + '</span>';
    cell.querySelector("img").onclick = () => adsShowProductImages(p);
    grid.appendChild(cell);
  });
}

// BƯỚC 2: lưới TẤT CẢ ảnh của 1 SP -> bấm 1 ảnh để làm design
async function adsShowProductImages(p) {
  const grid = $("adsDesignPickGrid");
  if ($("adsDesignPickSearch")) $("adsDesignPickSearch").style.display = "none";
  grid.innerHTML = '<p class="hint" style="grid-column:1/-1">Đang tải ảnh của "' + (p.title || "SP") + '"…</p>';
  let imgs = [];
  try {
    const d = await (await fetch("/api/shopify-product?id=" + encodeURIComponent(p.id))).json();
    if (d.error) throw new Error(d.error);
    imgs = d.images || [];
  } catch (e) { grid.innerHTML = ""; $("adsDesignPickNote").className = "gen-note err"; $("adsDesignPickNote").textContent = "⚠️ " + e.message; return; }
  grid.innerHTML = "";
  // ô quay lại
  const back = document.createElement("div"); back.className = "ads-style-cell"; back.style.cssText = "display:flex;align-items:center;justify-content:center;cursor:pointer;background:#f3f0ff;border-style:dashed";
  back.innerHTML = '<span style="font-size:13px;color:var(--violet);text-align:center;font-weight:600">←<br>Quay lại</span>';
  back.onclick = () => adsRenderDesignPick($("adsDesignPickSearch") ? $("adsDesignPickSearch").value : "");
  grid.appendChild(back);
  if (!imgs.length) { const e = document.createElement("p"); e.className = "hint"; e.style.gridColumn = "1/-1"; e.textContent = "SP này chưa có ảnh."; grid.appendChild(e); return; }
  imgs.forEach(im => {
    const cell = document.createElement("div"); cell.className = "ads-style-cell";
    cell.innerHTML = '<img src="' + im.src + '" loading="lazy" alt="">';
    cell.querySelector("img").onclick = () => {
      const link = p.store_url || p.url || "";
      if (adsDesignPickTarget === "fbpost") {
        fbpDesignImg = im.src; if (typeof fbpRenderDesign === "function") fbpRenderDesign(); fbpProductLink = link;
        $("adsDesignPickModal").classList.add("hidden");
        const n = $("fbpNote"); if (n) { n.className = "gen-note ok"; n.textContent = "✓ Đã lấy ảnh từ \"" + (p.title || "SP") + "\" làm design."; }
      } else {
        adsDesignImg = im.src; adsRenderDesign(); adsProductLink = link; adsProductImg = p.image || ""; adsAutoName2 = (p.title || "Áo Thun In Tên");
        if ($("adsLink")) $("adsLink").value = link;   // hiện link vào ô
        $("adsDesignPickModal").classList.add("hidden");
        const n = $("adsNote"); if (n) { n.className = "gen-note ok"; n.textContent = "✓ Đã lấy ảnh từ \"" + (p.title || "SP") + "\" làm design (đã nhớ link SP)."; }
      }
    };
    grid.appendChild(cell);
  });
  $("adsDesignPickNote").className = "gen-note"; $("adsDesignPickNote").textContent = "Bấm 1 ảnh để dùng làm DESIGN. (" + imgs.length + " ảnh)";
}

function adsSetDefaultStyle(id) {
  adsDefaultStyleId = (adsDefaultStyleId === id) ? null : id;
  if (adsDefaultStyleId) localStorage.setItem("adsDefaultStyleId", adsDefaultStyleId);
  else localStorage.removeItem("adsDefaultStyleId");
  adsRenderStyleBank();
}

async function adsLoadHistory() {
  try {
    const d = await (await fetch("/api/gallery")).json();
    const hist = (d.items || []).filter(it => it.mode === "ads").map(it => {
      const a = it.ads || {};
      return { url: it.url, id: it.id, title: it.prompt || "Ads", concept: a.concept || "",
               name: a.name || "", hook: a.hook || "", aspect: a.aspect || "", bg: a.bg || "",
               model: a.model || "", gallery: { id: it.id, url: it.url } };
    });
    const seen = new Set(adsItems.map(c => c.gallery && c.gallery.id).filter(Boolean));
    hist.forEach(h => { if (!seen.has(h.id)) adsItems.push(h); });
    adsRenderAll();
  } catch (e) {}
}

async function adsCheckEngine() {
  try {
    const d = await (await fetch("/api/engines")).json();
    const sel = $("adsEngine"); const engines = d.engines || [];
    sel.innerHTML = "";
    engines.forEach(e => { const o = document.createElement("option"); o.value = e.id; o.textContent = e.label + (e.available ? "" : " — chưa có key"); o.disabled = !e.available; sel.appendChild(o); });
    // FB Ads: ưu tiên ChatGPT (gpt-image) để vẽ chữ tốt hơn
    const oa = engines.find(e => e.id === "openai" && e.available);
    const def = oa ? "openai" : (d.default_engine || (engines.find(e => e.available) || {}).id);
    if (def) sel.value = def;
  } catch (e) {}
}

function adsRenderSpInfo() {
  const box = $("adsSpInfo"); if (!box) return;
  const multi = (typeof adsMultiSel !== "undefined" && adsMultiSel.size)
    ? adsMultiProducts.filter(p => adsMultiSel.has(p.id || p.store_url || p.title)) : [];
  if (multi.length) {
    box.innerHTML = '<div style="padding:8px 10px;background:var(--violet-soft);border-radius:10px;font-size:12px">' +
      '📦 <b>Đang chọn ' + multi.length + ' SP</b> — mỗi ảnh ads sẽ có ĐÚNG link SP của nó:<br>' +
      multi.slice(0, 5).map(p => '• ' + (p.title || "").replace(/</g, "&lt;").slice(0, 34)).join("<br>") +
      (multi.length > 5 ? "<br>…" : "") + '</div>';
  } else if (typeof adsProductLink !== "undefined" && adsProductLink) {
    box.innerHTML = '<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--violet-soft);border-radius:10px;font-size:12px">' +
      (adsProductImg ? '<img src="' + adsProductImg + '" style="width:32px;height:40px;object-fit:cover;border-radius:6px;flex:none">' : '') +
      '<div>📦 <b>' + (adsAutoName2 || "Sản phẩm").replace(/</g, "&lt;").slice(0, 30) + '</b><br>🔗 <a href="' + adsProductLink + '" target="_blank" style="color:var(--violet)">' + adsProductLink.replace(/^https?:\/\//, "").slice(0, 34) + '…</a></div></div>';
  } else if (adsDesignImg) {
    box.innerHTML = '<div class="hint" style="color:#c0392b;font-size:11px">⚠️ Design này CHƯA gắn SP → ảnh ads sẽ KHÔNG có link. Dùng "🛍️ Chọn design từ SP" hoặc "📦 Tạo ảnh cho nhiều SP" để có link.</div>';
  } else {
    box.innerHTML = "";
  }
}
function adsRenderDesign() {
  adsRenderSpInfo();
  const box = $("adsDesign"); box.innerHTML = "";
  box.onclick = () => { adsPasteTo = "design"; };   // bấm vùng design -> dán vào design
  if (adsDesignImg) {
    const d = document.createElement("div"); d.className = "fp-ref";
    d.innerHTML = '<img src="' + adsDesignImg + '" alt=""><button class="fp-ref-x">×</button>';
    d.querySelector(".fp-ref-x").onclick = (e) => { e.stopPropagation(); adsDesignImg = null; adsRenderDesign(); };
    box.appendChild(d);
  } else {
    const add = document.createElement("button"); add.className = "fp-ref fp-ref-add"; add.type = "button";
    add.innerHTML = "＋<span>Design</span>"; add.onclick = () => { adsPasteTo = "design"; $("adsDesignFile").click(); }; box.appendChild(add);
  }
}
function adsRenderTextStyle() {
  const box = $("adsTextStyleRef"); if (!box) return; box.innerHTML = "";
  box.onclick = () => { adsPasteTo = "textstyle"; };
  if (adsTextStyleImg) {
    const d = document.createElement("div"); d.className = "fp-ref";
    d.innerHTML = '<img src="' + adsTextStyleImg + '" alt=""><button class="fp-ref-x">×</button>';
    d.querySelector(".fp-ref-x").onclick = (e) => { e.stopPropagation(); adsTextStyleImg = null; adsRenderTextStyle(); };
    d.onclick = (e) => { if (!e.target.classList.contains("fp-ref-x")) adsOpenTextStylePicker(); };
    box.appendChild(d);
  } else {
    const add = document.createElement("button"); add.className = "fp-ref fp-ref-add"; add.type = "button";
    add.innerHTML = "🔤<span>Chữ</span>"; add.onclick = adsOpenTextStylePicker; box.appendChild(add);
  }
}
// dán ảnh vào FB Ads theo đích (design / textstyle / kho style / concept style đang chọn)
function adsHandlePaste(durl) {
  if (adsPasteTo === "stylebank" || (!$("adsStyleModal").classList.contains("hidden"))) {
    adsAddStyleToBank(durl, adsStylePickFor);   // modal kho style đang mở -> lưu vào kho
  } else if (adsPasteTo === "textstyle") {
    adsTextStyleImg = durl; adsRenderTextStyle();
    const n = $("adsNote"); if (n) { n.className = "gen-note ok"; n.textContent = "✓ Đã dán ảnh mẫu kiểu chữ."; }
  } else if (adsPasteTo && adsPasteTo !== "design" && ADS_CONCEPTS.find(c => c.key === adsPasteTo)) {
    adsStyle[adsPasteTo] = durl; adsSel.add(adsPasteTo); adsRenderConcepts();
    const n = $("adsNote"); if (n) { n.className = "gen-note ok"; n.textContent = "✓ Đã dán ảnh style cho concept."; }
  } else {
    adsDesignImg = durl; adsRenderDesign(); adsAutoName();
    const n = $("adsNote"); if (n) { n.className = "gen-note ok"; n.textContent = "✓ Đã dán design — AI đang đặt tên…"; }
  }
}

function adsRenderConcepts() {
  const box = $("adsConcepts"); box.innerHTML = "";
  ADS_CONCEPTS.forEach(c => {
    const row = document.createElement("div"); row.className = "ads-con";
    const has = !!adsStyle[c.key];
    const ph = (c.key.indexOf("flatlay") === 0) ? "Background (vd: sàn gỗ, nền trắng, bàn cafe…)" : "Background/bối cảnh (tuỳ chọn)";
    row.innerHTML =
      '<input type="checkbox" class="ads-con-tick"' + (adsSel.has(c.key) ? " checked" : "") + '>' +
      '<div class="ads-con-ref">' + (has ? '<img src="' + adsStyle[c.key] + '"><button class="ads-ref-x">×</button>' : '<span class="ads-ref-add">🎨<br>+ Style</span>') + '</div>' +
      '<div class="ads-con-lbl">' + c.label + '<br><span class="hint">' + (has ? '✅ có ảnh style' : 'tick + tải ảnh style') + '</span>' +
        '<input type="text" class="ads-con-bg" placeholder="' + ph + '" value="' + (adsBg[c.key] || "").replace(/"/g, "&quot;") + '">' +
        '<input type="text" class="ads-con-names" placeholder="🏷️ Tên ' + (CONCEPT_SHIRTS[c.key] || 1) + ' áo (cách nhau dấu phẩy, trống = AI tự đặt)" value="' + (adsNames[c.key] || "").replace(/"/g, "&quot;") + '"></div>';
    row.querySelector(".ads-con-tick").onchange = (e) => { if (e.target.checked) adsSel.add(c.key); else adsSel.delete(c.key); adsUpdateRunBtn(); };
    row.querySelector(".ads-con-ref").onclick = (e) => { adsPasteTo = c.key; if (e.target.classList.contains("ads-ref-x")) { delete adsStyle[c.key]; adsRenderConcepts(); return; } adsPickKey = c.key; adsOpenStylePicker(c.key); };
    row.querySelector(".ads-con-bg").oninput = (e) => { adsBg[c.key] = e.target.value; };
    row.querySelector(".ads-con-names").oninput = (e) => { adsNames[c.key] = e.target.value; };
    box.appendChild(row);
  });
  adsUpdateRunBtn();
}
function adsUpdateRunBtn() {
  const n = ADS_CONCEPTS.filter(c => adsSel.has(c.key)).length;
  const sp = (typeof adsMultiSel !== "undefined") ? adsMultiSel.size : 0;
  if ($("adsRunBtn")) $("adsRunBtn").textContent = sp ? ("✨ Tạo ảnh Ads (" + sp + " SP × " + n + " concept)") : ("✨ Tạo ảnh Ads (" + n + " concept)");
}

async function adsAutoName(force) {
  if (!adsDesignImg) return;
  if (!force && ($("adsName").value || "").trim()) return;
  const btn = $("adsNameBtn"), o = btn ? btn.textContent : ""; if (btn) { btn.disabled = true; btn.textContent = "⏳…"; }
  try {
    const r = await fetch("/api/ads-text", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: adsDesignImg }) });
    const d = await r.json(); if (r.ok) { $("adsName").value = d.name || ""; $("adsHook").value = d.hook || ""; }
  } catch (e) {} finally { if (btn) { btn.disabled = false; btn.textContent = o; } }
}

function adsSetView(v) { adsView = v; $("adsViewList").classList.toggle("active", v === "list"); $("adsViewGrid").classList.toggle("active", v === "grid"); $("adsResults").className = "fp-creations " + v; }

function adsRenderAll() {
  const grid = $("adsResults");
  $("adsCount").textContent = adsItems.length ? "(" + adsItems.length + ")" : "";
  $("adsEmpty").classList.toggle("hidden", adsItems.length > 0);
  grid.innerHTML = "";
  adsItems.forEach(c => {
    if (c.loading) {
      const ph = document.createElement("div"); ph.className = "fp-card fp-card-loading";
      ph.innerHTML = '<div class="fp-card-prompt">' + (c.label || "") + '</div><div class="fp-loading" style="min-height:260px"><span class="fp-spin"></span><span>Đang tạo ad… ~1 phút</span></div>';
      grid.appendChild(ph); return;
    }
    const card = document.createElement("div"); card.className = "fp-card";
    const src = c.image ? "data:image/png;base64," + c.image : c.url;
    const mparts = [];
    if (c.model) mparts.push("🤖 " + c.model);
    if (c.aspect) mparts.push(c.aspect);
    if (c.bg) mparts.push("🖼️ " + c.bg);
    const meta = mparts.join(" · ");
    let pushLine = "";
    if (c._pushing) pushLine = '<br><span class="hint">⏳ Đang đẩy lên FB Ads…</span>';
    else if (c._pushed !== undefined) pushLine = '<br><span class="hint" style="color:var(--violet)">✓ Đã đẩy FB Ads (PAUSED) · <a href="' + (c._pushed || "#") + '" target="_blank">Ads Manager →</a></span>';
    else if (c._pusherr) pushLine = '<br><span class="hint" style="color:#c00">✗ Đẩy lỗi: ' + c._pusherr.slice(0, 50) + '</span>';
    const spLine = (c._link || c._ptitle)
      ? ('<div style="display:flex;align-items:center;gap:6px;margin-top:4px;padding:4px 6px;background:var(--violet-soft);border-radius:8px">' +
          (c._pimg ? '<img src="' + c._pimg + '" title="Sản phẩm gốc" style="width:30px;height:38px;object-fit:cover;border-radius:5px;border:1px solid var(--line);flex:none">' : '') +
          '<div style="font-size:10.5px;line-height:1.35;min-width:0">📦 <b>' + (c._ptitle || "Sản phẩm").replace(/</g, "&lt;").slice(0, 30) + '</b>' +
          (c._link ? '<br>🔗 <a href="' + c._link + '" target="_blank" style="color:var(--violet)">' + c._link.replace(/^https?:\/\//, "").slice(0, 34) + '…</a>' : '<br><span style="color:#c0392b">chưa có link</span>') +
          '</div></div>')
      : '<div style="margin-top:4px;color:#c0392b;font-size:10.5px">⚠️ Chưa gắn SP/link — <b>bấm "📦 Gắn SP" dưới đây</b> để chọn sản phẩm (có link) trước khi đẩy FB Ads.</div>';
    card.innerHTML =
      '<div class="fp-card-prompt"><label style="float:left;margin-right:8px;cursor:pointer"><input type="checkbox" class="ads-pick"></label>' + (c.title || "Ads") + spLine +
        (meta ? '<br><span class="hint">' + meta.replace(/</g, "&lt;") + '</span>' : '') + pushLine + '</div>' +
      '<div class="fp-card-img"><img src="' + src + '" loading="lazy" alt=""></div>' +
      '<div class="fp-card-acts"><button class="b-attachsp" style="' + ((c._link || c._ptitle) ? '' : 'background:var(--violet);color:#fff') + '">📦 ' + ((c._link || c._ptitle) ? "Đổi SP" : "Gắn SP") + '</button><button class="b-board">➕ Bài Ads</button><button class="b-fb">📤 FB Ads</button><button class="b-regen">🔄 Tạo lại</button><button class="b-zoom">🔍</button><button class="b-copy">📋</button><button class="b-dl">⬇</button><button class="b-del">🗑️</button></div>';
    const pick = card.querySelector(".ads-pick"); pick.checked = !!c._sel;
    pick.onchange = (e) => { c._sel = e.target.checked; adsUpdateSel(); };
    card.querySelector(".fp-card-img img").onclick = () => openZoom(src);
    card.querySelector(".b-attachsp").onclick = () => adsAttachSp(adsItems.indexOf(c));
    card.querySelector(".b-board").onclick = (e) => adpostAddFromAd(c, e.currentTarget);
    card.querySelector(".b-zoom").onclick = () => openZoom(src);
    card.querySelector(".b-copy").onclick = (e) => copyImageToClipboard(src, e.currentTarget);
    card.querySelector(".b-dl").onclick = async (e) => { const b = e.currentTarget; b.disabled = true; autoDownload(await adsItemB64(c), c.title || "ads"); b.disabled = false; };
    card.querySelector(".b-regen").onclick = () => adsRegen(c);
    card.querySelector(".b-fb").onclick = () => adsPushToFb(c);
    card.querySelector(".b-del").onclick = async (e) => {
      if (!confirm("Xoá ảnh ads này?")) return; const b = e.currentTarget; b.disabled = true;
      try { const gid = c.gallery && c.gallery.id; if (gid) await fetch("/api/gallery?id=" + encodeURIComponent(gid), { method: "DELETE" }); adsItems = adsItems.filter(x => x !== c); adsRenderAll(); if (typeof loadGallery === "function") loadGallery(); }
      catch (err) { alert("✗ " + err.message); b.disabled = false; }
    };
    grid.appendChild(card);
  });
  const real = adsItems.filter(c => !c.loading);
  $("adsSelBar") && $("adsSelBar").classList.toggle("hidden", real.length === 0);
  adsUpdateSel();
}

function adsUpdateSel() {
  const sel = adsItems.filter(c => !c.loading && c._sel).length;
  const real = adsItems.filter(c => !c.loading).length;
  if ($("adsSelCount")) $("adsSelCount").textContent = "Đã chọn " + sel + "/" + real;
  if ($("adsPickAll")) $("adsPickAll").checked = real > 0 && sel === real;
}
async function adpostAddSelected() {
  const items = adsItems.filter(c => !c.loading && c._sel);
  if (!items.length) { alert("Chưa tick ảnh nào."); return; }
  const btn = $("adsSendBoard"); btn.disabled = true; const o = btn.textContent;
  let ok = 0;
  for (const c of items) {
    try { await adpostAddFromAd(c); ok++; btn.textContent = "⏳ " + ok + "/" + items.length; c._sel = false; }
    catch (e) {}
  }
  btn.textContent = "✓ Đã đưa " + ok + " bài"; adsUpdateSel(); adsRenderAll();
  setTimeout(() => { btn.disabled = false; btn.textContent = o; }, 1800);
}

async function adsItemB64(c) {
  if (c.image) return c.image;
  const b = await (await fetch(c.url)).blob();
  c.image = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(",")[1]); fr.readAsDataURL(b); });
  return c.image;
}

// Tạo lại 1 ad: mở modal cho sửa prompt + tỉ lệ
let adsRegenItem = null;
function adsRegen(c) {
  // tự dùng ĐÚNG design của ảnh ads này (đã lưu khi tạo) — không cần design ở panel
  const design = c._design || adsDesignImg;
  if (!design) { alert("Ảnh ads này (tải từ lịch sử) chưa lưu design nguồn. Kéo/dán design vào ô DESIGN rồi tạo lại."); return; }
  if (!c.concept) { alert("Ad cũ này không có thông tin concept để tạo lại."); return; }
  adsRegenItem = c;
  $("adsRegenAspect").value = c.aspect || ($("adsAspect") && $("adsAspect").value) || "1:1";
  $("adsRegenPrompt").value = c.prompt || "";
  $("adsRegenModal").classList.remove("hidden");
}
function adsRegenGo() {
  const c = adsRegenItem; if (!c) return;
  const key = c.concept, engine = ($("adsEngine") && $("adsEngine").value) || "";
  const aspect = $("adsRegenAspect").value;
  const customPrompt = ($("adsRegenPrompt").value || "").trim();
  // ctx mang theo design nguồn + link/tên SP của chính ảnh đó
  const ctx = { image: c._design || adsDesignImg, link: c._link || "", title: c._ptitle || "" };
  adsLaunchOne({ key: key, ref: adsStyle[key] || "", bg: c.bg || adsBg[key] || "" },
    c.name || ($("adsName").value || "").trim(), c.hook || ($("adsHook").value || "").trim(),
    engine, false, ctx, { aspect: aspect, customPrompt: customPrompt });
  $("adsRegenModal").classList.add("hidden");
  const n = $("adsNote"); if (n) { n.className = "gen-note ok"; n.textContent = "⏳ Đang tạo lại 1 ảnh ads (" + aspect + ")…"; }
}

async function adsGenerate(autopush) {
  const note = $("adsNote"); note.className = "gen-note"; note.textContent = "";
  const cons = ADS_CONCEPTS.filter(c => adsSel.has(c.key)).map(c => ({ key: c.key, ref: adsStyle[c.key] || "", bg: (adsBg[c.key] || "").trim(), names: (adsNames[c.key] || "").split(",").map(s => s.trim()).filter(Boolean) }));
  if (!cons.length) { note.className = "gen-note err"; note.textContent = "⚠️ Tick ít nhất 1 concept để tạo."; return; }
  const name = ($("adsName").value || "").trim(), hook = ($("adsHook").value || "").trim();
  const engine = ($("adsEngine") && $("adsEngine").value) || "";
  const cprompt = ($("adsPrompt") && $("adsPrompt").value || "").trim();   // prompt riêng (tuỳ chọn)
  const opts = cprompt ? { customPrompt: cprompt } : undefined;
  // Nếu đang tick NHIỀU SP -> gen cho từng SP × concept (mỗi ảnh nhớ link/tên SP)
  const chosen = (typeof adsMultiSel !== "undefined" && adsMultiSel.size)
    ? adsMultiProducts.filter(p => adsMultiSel.has(p.id || p.store_url || p.title)) : [];
  if (chosen.length) {
    let n = 0;
    chosen.forEach(p => {
      const ctx = { image: p.image, link: p.store_url || p.url || "", title: p.title || "Áo Thun In Tên", pimg: p.image };
      cons.forEach(c => { adsLaunchOne({ key: c.key, ref: adsStyle[c.key] || "", bg: (adsBg[c.key] || "").trim() }, name, hook, engine, autopush, ctx, opts); n++; });
    });
    $("adsProgress") && $("adsProgress").classList.remove("hidden");
    note.className = "gen-note ok"; note.textContent = "⏳ Đang tạo " + n + " ảnh cho " + chosen.length + " SP × " + cons.length + " concept…";
    return;
  }
  // Design đơn
  if (!adsDesignImg) { note.className = "gen-note err"; note.textContent = "⚠️ Đưa ảnh design (hoặc tick SP) trước."; return; }
  cons.forEach(c => adsLaunchOne(c, name, hook, engine, autopush, undefined, opts));
  note.className = "gen-note ok"; note.textContent = "⏳ Đang tạo " + cons.length + " ảnh ads" + (autopush ? " + tự đẩy lên FB Ads…" : " (nhiều luồng — bấm tiếp để chạy thêm).");
}

async function adsLaunchOne(con, name, hook, engine, autopush, ctx, opts) {
  const lbl = ((ADS_CONCEPTS.find(x => x.key === con.key) || {}).label || con.key) + (ctx && ctx.title ? " · " + ctx.title.slice(0, 16) : "");
  const designImg = (ctx && ctx.image) || adsDesignImg;
  const aspect = (opts && opts.aspect) || ($("adsAspect") && $("adsAspect").value) || "1:1";
  const conSend = (opts && opts.customPrompt) ? Object.assign({}, con, { custom_prompt: opts.customPrompt }) : con;
  try {
    const r = await fetch("/api/ads-generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: designImg, name: name, hook: hook, engine: engine, aspect: aspect, quality: ($("adsQuality") && $("adsQuality").value) || "medium", text_style: ($("adsTextStyle") && $("adsTextStyle").value || "").trim(), text_color: ($("adsTextColor") && $("adsTextColor").value || "").trim(), brand: ($("adsBrand") && $("adsBrand").value || "").trim(), text_style_img: adsTextStyleImg || "", concepts: [conSend] }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Lỗi");
    const linkVal = (ctx && ctx.link) || ($("adsLink") && $("adsLink").value.trim()) || adsProductLink || "";
    adsItems.unshift({ loading: true, job: d.job_id, label: lbl, autopush: !!autopush, _link: linkVal, _ptitle: (ctx && ctx.title) || adsAutoName2 || "", _design: designImg, _pimg: (ctx && ctx.pimg) || adsProductImg || "" });
    adsRenderAll();
    adsPoll(d.job_id);
  } catch (e) { const note = $("adsNote"); note.className = "gen-note err"; note.textContent = "✗ " + lbl + ": " + e.message; }
}

function adsPoll(job) {
  let placed = 0;
  const timer = setInterval(async () => {
    try {
      const d = await (await fetch("/api/batch-status?id=" + encodeURIComponent(job))).json();
      const pct = d.total ? Math.round((d.done / d.total) * 100) : 0;
      $("adsBar").style.width = pct + "%"; $("adsProgText").textContent = "Đã xong " + d.done + "/" + d.total;
      const items = d.items || [];
      while (placed < items.length) {
        const it = items[placed];
        const idx = adsItems.findIndex(c => c.loading && c.job === job);
        const autopush = idx >= 0 && adsItems[idx].autopush;
        const real = { image: it.image, title: it.title, gallery: it.gallery, url: it.gallery && it.gallery.url,
                       concept: it.concept || "", name: it.name || "", hook: it.hook || "",
                       aspect: it.aspect || "", bg: it.bg || "", model: it.model || "", prompt: it.prompt || "",
                       _link: (idx >= 0 && adsItems[idx]._link) || "", _ptitle: (idx >= 0 && adsItems[idx]._ptitle) || "",
                       _design: (idx >= 0 && adsItems[idx]._design) || "", _pimg: (idx >= 0 && adsItems[idx]._pimg) || "" };
        if (idx >= 0) adsItems[idx] = real; else adsItems.unshift(real);
        placed++;
        if (autopush) fbAutoPush(real);   // tự đẩy lên FB Ads
      }
      if (d.finished) {
        clearInterval(timer);
        adsItems = adsItems.filter(c => !(c.loading && c.job === job));
        $("adsProgress").classList.add("hidden");
        const note = $("adsNote"); note.className = "gen-note ok"; note.textContent = "✓ Xong " + items.length + " ảnh ads.";
        if ((d.errors || []).length) { note.className = "gen-note err"; note.textContent = "⚠️ " + d.errors[0]; }
        if (typeof loadGallery === "function") loadGallery();
      }
      adsRenderAll();
    } catch (e) {}
  }, 2500);
}

/* =====================================================================
   FACEBOOK POST: mỗi concept 1 BỘ ảnh sạch (không text) + đăng Fanpage
   ===================================================================== */
const CONCEPT_SHIRTS = { couple: 2, kids: 2, group: 3, family: 4, flatlay2: 2, flatlay3: 3 };
let fbpInited = false, fbpDesignImg = null, fbpStyle = {}, fbpBg = {}, fbpSel = new Set(), fbpCount = {}, fbpNames = {};
let fbpItems = [], fbpProductLink = "", fbpPickKey = null, fbpPasteTo = "design";

function fbpFromProduct(p) {
  if (!p.image) { alert("Sản phẩm này chưa có ảnh."); return; }
  showApp("fbpost");
  fbpProductLink = p.store_url || p.url || "";
  setTimeout(() => {
    fbpDesignImg = p.image; fbpRenderDesign();
    fbpSel.clear(); fbpSel.add("couple"); fbpRenderConcepts();
    const n = $("fbpNote"); if (n) { n.className = "gen-note ok"; n.textContent = "✓ Đã nạp design từ \"" + (p.title || "SP") + "\" — đang tạo bộ ảnh post…"; }
    fbpGenerate();
  }, 200);
}

function fbpInit() {
  if (fbpInited) return; fbpInited = true;
  fbpCheckEngine();
  $("fbpDesignFile").onchange = async (e) => { const f = e.target.files[0]; if (f && f.type.startsWith("image/")) { fbpDesignImg = await fileToDataURL(f); fbpRenderDesign(); } e.target.value = ""; };
  $("fbpDesignFromShop").onclick = () => { adsDesignPickTarget = "fbpost"; if (typeof adsOpenDesignPick === "function") adsOpenDesignPick(); };
  $("fbpRunBtn").onclick = fbpGenerate;
  const sf = document.createElement("input"); sf.type = "file"; sf.accept = "image/*"; sf.style.display = "none"; sf.id = "fbpStyleFile"; document.body.appendChild(sf);
  sf.onchange = async (e) => { const f = e.target.files[0]; if (f && f.type.startsWith("image/") && fbpPickKey) { fbpStyle[fbpPickKey] = await fileToDataURL(f); fbpSel.add(fbpPickKey); fbpRenderConcepts(); } e.target.value = ""; };
  if ($("fbpSavePreset")) $("fbpSavePreset").onclick = fbpSavePreset;
  if ($("fbpClearPreset")) $("fbpClearPreset").onclick = fbpClearPreset;
  const gbar = $("fbpGlobalBar");
  if (gbar) {
    gbar.querySelector(".fbp-gpost").onclick = fbpGlobalPost;
    gbar.querySelector(".fbp-gall").onclick = () => { fbpItems.forEach(it => { if (!it.loading) it._pick = new Set((it.pics || []).map((_, k) => k)); }); fbpRenderAll(); };
    gbar.querySelector(".fbp-gnone").onclick = () => { fbpItems.forEach(it => { if (!it.loading) it._pick = new Set(); }); fbpRenderAll(); };
  }
  fbpLoadPreset();   // tự nạp style mặc định đã lưu
  if (![...fbpSel].some(k => FBP_CONCEPTS.find(c => c.key === k))) fbpSel.add("couple");   // mặc định bộ model couple
  fbpRenderDesign(); fbpRenderConcepts(); fbpRenderAll();
  fbpLoadHistory();  // nạp lịch sử các bộ ảnh post đã tạo
}
async function fbpLoadHistory() {
  try {
    const d = await (await fetch("/api/fbpost-hist")).json();
    const hist = (d.items || []).map(e => ({
      _hist: true, _histSaved: true, _hid: e.id, concept: e.concept, title: e.title,
      caption: e.caption || "", pics: (e.pics || []).map(p => ({ url: p.url, id: p.id }))
    }));
    // giữ các bộ mới (chưa lưu) đang có trên đầu, nối lịch sử phía dưới
    const fresh = fbpItems.filter(x => !x._hist);
    fbpItems = fresh.concat(hist);
    fbpRenderAll();
  } catch (e) {}
}
async function fbpSaveToHistory(it) {
  if (!it || it._hist || it._histSaved) return;
  const pics = (it.pics || []).filter(p => p.url).map(p => ({ url: p.url, id: p.id || "" }));
  if (!pics.length) return;
  it._histSaved = true;
  try {
    const r = await fetch("/api/fbpost-hist-add", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: it.title || "Bộ ảnh Post", concept: it.concept || "", caption: it.caption || "", pics: pics }) });
    const d = await r.json(); if (d && d.id) it._hid = d.id;
  } catch (e) { it._histSaved = false; }
}
const FBP_PRESET_KEY = "fbpost_preset_v1";
function fbpSavePreset() {
  const note = $("fbpPresetNote");
  const preset = {
    sel: Array.from(fbpSel),
    count: fbpCount,
    shots: Object.fromEntries(Object.keys(fbpShots).map(k => [k, [...fbpShots[k]]])),
    reps: fbpReps,
    names: fbpNames,
    style: fbpStyle,                 // {key: dataURL}
    bg: fbpBg,                       // {key: text}
    aspect: $("fbpAspect") && $("fbpAspect").value,
    quality: $("fbpQuality") && $("fbpQuality").value,
    engine: $("fbpEngine") && $("fbpEngine").value
  };
  try {
    localStorage.setItem(FBP_PRESET_KEY, JSON.stringify(preset));
    if (note) { note.style.color = "var(--violet)"; note.textContent = "✓ Đã lưu style mặc định (" + preset.sel.length + " concept). Lần sau tự nạp."; }
  } catch (e) {
    // ảnh style quá lớn -> lưu không kèm ảnh
    try {
      const slim = Object.assign({}, preset, { style: {} });
      localStorage.setItem(FBP_PRESET_KEY, JSON.stringify(slim));
      if (note) { note.style.color = "#c0392b"; note.textContent = "✓ Đã lưu (concept + background + cài đặt) nhưng ẢNH STYLE quá lớn nên không lưu được — lần sau tải lại ảnh style."; }
    } catch (e2) { if (note) { note.style.color = "#c0392b"; note.textContent = "✗ Không lưu được: " + e2.message; } }
  }
}
function fbpLoadPreset() {
  let preset; try { preset = JSON.parse(localStorage.getItem(FBP_PRESET_KEY) || "null"); } catch (e) { preset = null; }
  if (!preset) return;
  const note = $("fbpPresetNote");
  if (preset.style) fbpStyle = preset.style;
  if (preset.bg) fbpBg = preset.bg;
  if (preset.count) fbpCount = preset.count;
  if (preset.shots) { fbpShots = {}; Object.keys(preset.shots).forEach(k => { fbpShots[k] = new Set(preset.shots[k]); }); }
  if (preset.reps) fbpReps = preset.reps;
  if (preset.names) fbpNames = preset.names;
  if (Array.isArray(preset.sel)) fbpSel = new Set(preset.sel);
  if (preset.aspect && $("fbpAspect")) $("fbpAspect").value = preset.aspect;
  if (preset.quality && $("fbpQuality")) $("fbpQuality").value = preset.quality;
  if (preset.engine && $("fbpEngine")) { try { $("fbpEngine").value = preset.engine; } catch (e) {} }
  if (note) { note.style.color = "var(--violet)"; note.textContent = "♻️ Đã nạp style mặc định đã lưu (" + (preset.sel ? preset.sel.length : 0) + " concept)."; }
}
function fbpClearPreset() {
  localStorage.removeItem(FBP_PRESET_KEY);
  const note = $("fbpPresetNote"); if (note) { note.style.color = "#c0392b"; note.textContent = "🗑️ Đã xoá style mặc định."; }
}
async function fbpCheckEngine() {
  try {
    const d = await (await fetch("/api/engines")).json();
    const sel = $("fbpEngine"); sel.innerHTML = "";
    (d.engines || []).forEach(e => { const o = document.createElement("option"); o.value = e.id; o.textContent = e.label + (e.available ? "" : " — chưa có key"); o.disabled = !e.available; sel.appendChild(o); });
    const oa = (d.engines || []).find(e => e.id === "openai" && e.available);
    if (oa) sel.value = "openai"; else if (d.default_engine) sel.value = d.default_engine;
  } catch (e) {}
}
function fbpRenderDesign() {
  const box = $("fbpDesign"); box.innerHTML = ""; box.onclick = () => { fbpPasteTo = "design"; };
  if (fbpDesignImg) {
    const d = document.createElement("div"); d.className = "fp-ref";
    d.innerHTML = '<img src="' + fbpDesignImg + '" alt=""><button class="fp-ref-x">×</button>';
    d.querySelector(".fp-ref-x").onclick = (e) => { e.stopPropagation(); fbpDesignImg = null; fbpRenderDesign(); };
    box.appendChild(d);
  } else {
    const add = document.createElement("button"); add.className = "fp-ref fp-ref-add"; add.type = "button";
    add.innerHTML = "＋<span>Design</span>"; add.onclick = () => { fbpPasteTo = "design"; $("fbpDesignFile").click(); }; box.appendChild(add);
  }
}
// 4 BỘ ẢNH FB POST đúng theo skill nano-banana (bỏ đội nhóm/gia đình)
// shots = CHỦ ĐỀ từng prompt trong bộ (tick chọn shot nào gen shot đó, đúng thứ tự skill)
const FBP_CONCEPTS = [
  { key: "couple", label: "💑 Bộ MODEL Couple", max: 6,
    shots: ["💑 Cặp đôi 3/4 người (thấy full outfit)", "💑 Cặp đôi nửa người — pose 1", "💑 Cặp đôi nửa người — pose 2",
            "👩 Chụp RIÊNG nữ (nửa người)", "👨 Chụp RIÊNG nam (nửa người)", "🔍 Cận design 2 áo trên người (không mặt)"] },
  { key: "sofa", label: "🛋️ Flatlay SOFA kem", max: 6,
    shots: ["🛋️ 2 áo trải XIÊN chồng nhẹ", "🛋️ 2 áo GẤP cạnh nhau", "🛋️ 2 áo CHỒNG gọn lên nhau",
            "🔍 Cận 2 design", "🔍 Cận design áo nữ", "🔍 Cận design áo nam"] },
  { key: "white", label: "⬜ Flatlay NỀN TRẮNG", max: 5,
    shots: ["⬜ 2 áo trải MỞ cạnh nhau", "⬜ 2 áo CHỒNG CHÉO", "⬜ 2 áo XIÊN chéo khung",
            "⬜ Chụp GÓC NGHIÊNG", "🔍 Cận 2 design"] },
  { key: "kraft", label: "📦 Flatlay HỘP KRAFT", max: 7,
    shots: ["📦 2 áo gấp TRONG hộp (top-down)", "📦 Hộp mở GÓC NGHIÊNG", "📦 Áo HÉ ra khỏi hộp",
            "📦 2 áo CHÉO mép hộp", "📦 2 áo gấp CẠNH hộp đóng", "🔍 Cận 2 design trong hộp", "🔍 Cận 1 design trên giấy kraft"] },
];
CONCEPT_SHIRTS.sofa = 2; CONCEPT_SHIRTS.white = 2; CONCEPT_SHIRTS.kraft = 2;
let fbpShots = {};   // {key: Set(chỉ số shot đã tick)} — mặc định tick hết
let fbpReps = {};    // {key: 1|2|3} — số BẢN mỗi chủ đề shot (nhiều ảnh để lựa)
function fbpShotSet(key) {
  if (!fbpShots[key]) {
    const c = FBP_CONCEPTS.find(x => x.key === key);
    fbpShots[key] = new Set(c ? c.shots.map((_, i) => i) : []);
  }
  return fbpShots[key];
}

// Pool tên thật (đồng bộ backend VN_COUPLE_NU/NAM) — cho nút 🎲 cố định tên
const FBP_NAME_NU = ["Thuỳ Linh", "Ngọc Hân", "Thu Trang", "Phương Anh", "Mai Hương", "Khánh Vy",
  "Bảo Trâm", "Diễm My", "Thanh Trúc", "Cẩm Tú", "Hồng Nhung", "Lan Anh", "Quỳnh Như", "Hà My", "Tường Vy"];
const FBP_NAME_NAM = ["Minh Quân", "Hữu Phước", "Đức Anh", "Hoàng Nam", "Tuấn Kiệt", "Gia Bảo",
  "Quốc Bảo", "Nhật Minh", "Đình Phong", "Hải Đăng", "Trí Dũng", "Thanh Tùng", "Việt Hoàng", "Duy Khánh", "Minh Khôi"];
// Ngân hàng BỐI CẢNH theo skill nano-banana (BG bank + lighting đi kèm, tiếng Anh cho prompt)
const FBP_BG_BANK = [
  ["", "🧠 Claude tự chọn bối cảnh (mặc định)"],
  ["an indie café interior with exposed brick and light wood walls, mismatched vintage wooden chairs, potted plants, an espresso counter and a big street-facing window — soft neutral daylight from the shopfront window plus even ambient interior light, bright, faces and fabric colour true to life, no warm cast", "☕ Café indie (gạch thô + gỗ)"],
  ["a daytime rooftop café terrace overlooking city buildings, simple tables and green plants — bright open daytime sky, soft and even, neutral, no harsh shadows", "🏙️ Café rooftop ban ngày"],
  ["inside a Vietnamese convenience store with bright tidy shelves and glass doors — bright even fluorescent-style interior light kept fully neutral, no green or yellow tint on skin or fabric", "🏪 Cửa hàng tiện lợi"],
  ["a Vietnamese sidewalk tea stall with low plastic stools beside an old shophouse wall — bright flat daytime street light, even and neutral, no harsh midday shadows", "🍵 Quán trà đá vỉa hè"],
  ["a narrow old-quarter alley with weathered shophouse walls and everyday street details — bright flat daytime street light, even and neutral", "🏮 Ngõ phố cổ"],
  ["a green city park with tall trees and a walking path — bright open daytime sky, dappled tree light kept gentle and even, neutral, no harsh spots on faces", "🌳 Công viên cây xanh"],
  ["a lakeside promenade with a railing and water behind — bright neutral daytime light reflecting gently off the water, airy, well exposed", "🌊 Ven hồ / bờ sông"],
  ["a simple everyday Vietnamese beach with sand and sea — bright intense high-key daylight reflecting off sand and water, neutral, no warm or orange cast", "🏖️ Bãi biển bình dân"],
  ["a cozy GenZ bedroom with a curtained window, a simple desk and posters — soft neutral daylight through the curtained window, bright and airy, no warm tint from lamps", "🛏️ Phòng trọ GenZ"],
];
const FBP_BG_FLAT = [
  ["", "🎨 AI tự chọn nền flatlay"],
  ["laid on a clean cream fabric sofa with soft natural window light, bright and neutral", "🛋️ Sofa kem (chuẩn skill)"],
  ["on a pure white seamless background, bright and evenly lit, neutral", "⬜ Nền trắng"],
  ["in and around an open kraft cardboard gift box on a wooden table, soft neutral daylight", "📦 Hộp quà kraft"],
  ["on a light wooden floor, top-down view, soft neutral daylight", "🪵 Sàn gỗ sáng"],
];

function fbpNamesArr(key) {
  const n = CONCEPT_SHIRTS[key] || 1;
  const arr = (fbpNames[key] || "").split(",").map(s => s.trim());
  while (arr.length < n) arr.push("");
  return arr.slice(0, n);
}

function fbpRenderConcepts() {
  const box = $("fbpConcepts"); box.innerHTML = "";
  FBP_CONCEPTS.forEach(c => {
    const row = document.createElement("div"); row.className = "ads-con";
    const has = !!fbpStyle[c.key];
    const isFlat = c.key !== "couple";
    const shotSet = fbpShotSet(c.key);
    // Danh sách CHỦ ĐỀ shot của bộ — tick shot nào gen shot đó (đúng thứ tự skill)
    const shotHtml = '<div style="display:grid;grid-template-columns:1fr;gap:2px;margin-top:5px">' +
      c.shots.map((s, i) =>
        '<label style="display:flex;align-items:center;gap:5px;font-size:11px;cursor:pointer;line-height:1.3">' +
        '<input type="checkbox" class="fbp-shot" data-i="' + i + '"' + (shotSet.has(i) ? " checked" : "") + ' style="margin:0">' +
        '<span>' + s + '</span></label>').join("") +
      '<label style="display:flex;align-items:center;gap:5px;font-size:11px;margin-top:2px">🔁 Số bản mỗi chủ đề:' +
      '<select class="fbp-reps" style="font-size:11px;padding:1px 4px;border-radius:6px">' +
      [1, 2, 3].map(v => '<option value="' + v + '"' + ((fbpReps[c.key] || 1) === v ? " selected" : "") + '>×' + v + '</option>').join("") +
      '</select><span class="hint" style="font-size:10px">(×2/×3 = mỗi shot gen nhiều ảnh để lựa)</span></label></div>';
    // Ô TÊN riêng từng áo (cố định tên) + 🎲 — cả 4 bộ đều là CẶP áo couple (tên nữ + tên nam)
    const arr = fbpNamesArr(c.key);
    const labels = c.key === "couple" ? ["👩 Tên NỮ → in áo NAM", "👨 Tên NAM → in áo NỮ"]
      : ["👩 Tên NỮ (áo 1)", "👨 Tên NAM (áo 2)"];
    let nameHtml = '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:5px;align-items:center">' +
      arr.map((v, i) => '<input type="text" class="ads-con-name1" data-i="' + i + '" placeholder="' + labels[i] +
        '" value="' + v.replace(/"/g, "&quot;") + '" style="flex:1 1 45%;min-width:108px;font-size:11px;padding:3px 6px;border-radius:6px;border:1px solid var(--line,#ccc);background:transparent;color:inherit">').join("") +
      '<button class="btn-ghost sm b-rndname" title="🎲 Random tên thật từ pool (couple: 1 nữ + 1 nam)" style="padding:2px 7px;font-size:12px">🎲</button></div>';
    // BỐI CẢNH: couple = ngân hàng BG skill; flatlay = nền cố định theo skill (chỉ cho tự nhập thêm)
    const bank = isFlat ? [["", "📐 Nền chuẩn skill (mặc định)"]] : FBP_BG_BANK;
    const cur = fbpBg[c.key] || "";
    const inBank = bank.some(b => b[0] === cur);
    const bgHtml = '<select class="ads-con-bgsel" style="width:100%;margin-top:4px;font-size:11px;padding:3px 6px;border-radius:6px;border:1px solid var(--line,#ccc);background:transparent;color:inherit">' +
      bank.map(b => '<option value="' + b[0].replace(/"/g, "&quot;") + '"' + (cur === b[0] ? " selected" : "") + '>' + b[1] + '</option>').join("") +
      '<option value="__custom"' + (!inBank && cur ? " selected" : "") + '>✍️ Tự nhập bối cảnh…</option></select>' +
      '<input type="text" class="ads-con-bg" placeholder="Mô tả bối cảnh tự nhập…" value="' + (!inBank ? cur.replace(/"/g, "&quot;") : "") +
      '" style="' + (inBank || !cur ? "display:none;" : "") + 'width:100%;margin-top:3px;font-size:11px;padding:3px 6px">';
    row.innerHTML =
      '<input type="checkbox" class="ads-con-tick"' + (fbpSel.has(c.key) ? " checked" : "") + '>' +
      '<div class="ads-con-ref">' + (has ? '<img src="' + fbpStyle[c.key] + '"><button class="ads-ref-x">×</button>' : '<span class="ads-ref-add">🎨<br>+ Style</span>') + '</div>' +
      '<div class="ads-con-lbl">' + c.label +
        ' <span class="hint fbp-shotcount" style="font-size:10px">(' + shotSet.size + '/' + c.shots.length + ' shot)</span>' +
        (has ? ' <span class="hint" style="font-size:10px">✅ style</span>' : '') +
        shotHtml + nameHtml + bgHtml + '</div>';
    row.querySelector(".ads-con-tick").onchange = (e) => { if (e.target.checked) fbpSel.add(c.key); else fbpSel.delete(c.key); };
    row.querySelector(".ads-con-ref").onclick = (e) => { fbpPasteTo = c.key; if (e.target.classList.contains("ads-ref-x")) { delete fbpStyle[c.key]; fbpRenderConcepts(); return; } fbpPickKey = c.key; $("fbpStyleFile").click(); };
    row.querySelectorAll(".fbp-shot").forEach(cb => {
      cb.onchange = () => {
        const s = fbpShotSet(c.key), i = parseInt(cb.dataset.i, 10);
        if (cb.checked) s.add(i); else s.delete(i);
        if (cb.checked) fbpSel.add(c.key);
        const sc = row.querySelector(".fbp-shotcount"); if (sc) sc.textContent = "(" + s.size + "/" + c.shots.length + " shot)";
      };
    });
    row.querySelectorAll(".ads-con-name1").forEach(inp => {
      inp.oninput = () => { const a = fbpNamesArr(c.key); a[parseInt(inp.dataset.i, 10)] = inp.value; fbpNames[c.key] = a.join(", "); };
    });
    row.querySelector(".b-rndname").onclick = () => {
      // cả 4 bộ đều là cặp áo couple -> luôn random 1 tên NỮ + 1 tên NAM
      const picks = [FBP_NAME_NU[Math.floor(Math.random() * FBP_NAME_NU.length)],
                     FBP_NAME_NAM[Math.floor(Math.random() * FBP_NAME_NAM.length)]];
      fbpNames[c.key] = picks.join(", "); fbpSel.add(c.key); fbpRenderConcepts();
    };
    const repSel = row.querySelector(".fbp-reps");
    if (repSel) repSel.onchange = () => { fbpReps[c.key] = parseInt(repSel.value, 10) || 1; };
    const bgSel = row.querySelector(".ads-con-bgsel"), bgTxt = row.querySelector(".ads-con-bg");
    bgSel.onchange = () => {
      if (bgSel.value === "__custom") { bgTxt.style.display = ""; fbpBg[c.key] = bgTxt.value; bgTxt.focus(); }
      else { bgTxt.style.display = "none"; fbpBg[c.key] = bgSel.value; }
    };
    bgTxt.oninput = () => { fbpBg[c.key] = bgTxt.value; };
    box.appendChild(row);
  });
}
function fbpHandlePaste(durl) {
  if (fbpPasteTo && fbpPasteTo !== "design" && FBP_CONCEPTS.find(c => c.key === fbpPasteTo)) {
    fbpStyle[fbpPasteTo] = durl; fbpSel.add(fbpPasteTo); fbpRenderConcepts();
  } else { fbpDesignImg = durl; fbpRenderDesign(); }
}
async function fbpGenerate() {
  const note = $("fbpNote"); note.className = "gen-note"; note.textContent = "";
  if (!fbpDesignImg) { note.className = "gen-note err"; note.textContent = "⚠️ Đưa design trước."; return; }
  const cons = FBP_CONCEPTS.filter(c => fbpSel.has(c.key)).map(c => {
    const shots = [...fbpShotSet(c.key)].sort((a, b) => a - b);
    const reps = fbpReps[c.key] || 1;
    return { key: c.key, label: c.label, ref: fbpStyle[c.key] || "", bg: (fbpBg[c.key] || "").trim(),
      n: shots.length, shots: shots, reps: reps, names: (fbpNames[c.key] || "").split(",").map(s => s.trim()).filter(Boolean) };
  }).filter(c => c.shots.length);
  if (!cons.length) { note.className = "gen-note err"; note.textContent = "⚠️ Tick ít nhất 1 bộ + ít nhất 1 chủ đề shot."; return; }
  const totalImgs = cons.reduce((t, c) => t + c.shots.length * c.reps, 0);
  if (totalImgs > 16 && !confirm("Tổng " + totalImgs + " ảnh sẽ được gen (khá lâu + tốn phí). Tiếp tục?")) return;
  const engine = ($("fbpEngine") && $("fbpEngine").value) || "";
  try {
    const r = await fetch("/api/fbpost-generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: fbpDesignImg, engine: engine, aspect: $("fbpAspect").value, quality: $("fbpQuality").value, concepts: cons }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Lỗi");
    cons.forEach(c => fbpItems.unshift({ loading: true, job: d.job_id, concept: c.key, title: c.label, _design: fbpDesignImg, _ref: c.ref || "" }));
    fbpRenderAll(); fbpPoll(d.job_id);
    note.className = "gen-note ok"; note.textContent = "⏳ Đang tạo " + cons.length + " bộ (" + totalImgs + " ảnh, 🧠 Claude viết prompt từng bộ)…";
  } catch (e) { note.className = "gen-note err"; note.textContent = "✗ " + e.message; }
}
function fbpPoll(job) {
  let placed = 0;
  const timer = setInterval(async () => {
    try {
      // have=placed: server CHỈ trả items mới (đỡ tải lại base64 các bộ đã nhận mỗi 3s)
      const d = await (await fetch("/api/batch-status?id=" + encodeURIComponent(job) + "&have=" + placed)).json();
      if (d.note) fbpItems.forEach(x => { if (x.loading && x.job === job) x._note = d.note; });
      (d.partial || []).forEach(pe => {   // ảnh xong tấm nào hiện tấm đó
        const t = fbpItems.find(x => x.loading && x.job === job && x.concept === pe.concept);
        if (t) t._partial = pe;
      });
      (d.items || []).forEach(it => {
        let idx = fbpItems.findIndex(x => x.loading && x.job === job && x.concept === it.concept);
        if (idx < 0) idx = fbpItems.findIndex(x => x.loading && x.job === job);
        if (idx >= 0) { it._design = fbpItems[idx]._design; it._ref = fbpItems[idx]._ref; fbpItems[idx] = it; }
        else fbpItems.unshift(it);
        placed++; fbpRenderAll(); fbpSaveToHistory(it);   // lưu lịch sử ngay (viết bài ở tab Bài FB/IG)
      });
      if (d.finished) {
        clearInterval(timer);
        fbpItems = fbpItems.filter(x => !(x.loading && x.job === job));
        const n = $("fbpNote"); n.className = "gen-note ok"; n.textContent = "✓ Xong " + items.length + " bộ ảnh.";
        if ((d.errors || []).length) { n.className = "gen-note err"; n.textContent = "⚠️ " + d.errors[0]; }
        fbpRenderAll();
      }
      fbpRenderAll();
    } catch (e) {}
  }, 3000);
}
function fbpRenderAll() {
  const grid = $("fbpResults"); $("fbpCount").textContent = fbpItems.length ? "(" + fbpItems.length + ")" : "";
  $("fbpEmpty").classList.toggle("hidden", fbpItems.length > 0);
  grid.innerHTML = "";
  fbpItems.forEach(it => {
    if (it.loading) {
      const ph = document.createElement("div"); ph.className = "fp-card fp-card-loading";
      const pp = it._partial;
      if (pp && (pp.expected || 0) > 0) {
        // hiện từng ảnh đã xong + ô ⏳ cho ảnh còn lại
        const done = (pp.pics || []).map(p =>
          '<img src="' + p.url + '" style="width:84px;height:104px;object-fit:cover;border-radius:6px;cursor:pointer" onclick="openZoom(this.src)">').join("");
        const remain = Math.max(0, (pp.expected || 0) - (pp.pics || []).length);
        const wait = Array.from({ length: remain }, () =>
          '<div style="width:84px;height:104px;border-radius:6px;background:rgba(127,127,127,.14);display:flex;align-items:center;justify-content:center;font-size:18px"><span class="fp-spin" style="width:18px;height:18px"></span></div>').join("");
        ph.innerHTML = '<div class="fp-card-prompt">' + (pp.title || it.title || "") + ' · ' + (pp.pics || []).length + '/' + pp.expected + ' ảnh</div>' +
          '<div style="display:flex;gap:6px;flex-wrap:wrap;margin:6px 0">' + done + wait + '</div>' +
          '<p class="hint" style="margin:0;font-size:11px">' + (it._note || "") + '</p>';
      } else {
        ph.innerHTML = '<div class="fp-card-prompt">' + (it.title || "") + '</div><div class="fp-loading" style="min-height:120px"><span class="fp-spin"></span><span>' + (it._note || "Đang tạo bộ ảnh…") + '</span></div>';
      }
      grid.appendChild(ph); return;
    }
    const card = document.createElement("div"); card.className = "fp-card";
    const canRegen = !!(it._design && (it.names || []).length);
    if (!it._pick) it._pick = new Set(it._hist ? [] : (it.pics || []).map((_, k) => k));   // bộ mới: tick hết; lịch sử: bỏ tick (để gộp bài chọn tay)
    const thumbs = (it.pics || []).map((p, i) => {
      const s = p.image ? "data:image/png;base64," + p.image : gthumb(p.url);
      const busy = it._regening === i;
      return '<div style="position:relative;width:84px;flex:0 0 auto">' +
        '<img data-i="' + i + '" data-full="' + (p.url || "") + '" src="' + s + '" style="width:84px;height:104px;object-fit:cover;border-radius:6px;cursor:pointer;opacity:' + (busy ? '.3' : (it._pick.has(i) ? '1' : '.35')) + '">' +
        (busy ? '<span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:20px">⏳</span>' : '') +
        '<input type="checkbox" class="fbp-pick" data-i="' + i + '"' + (it._pick.has(i) ? " checked" : "") + ' title="Tick = chọn ảnh này để đẩy sang Bài FB/IG / tải về" style="position:absolute;left:4px;top:4px;width:15px;height:15px;accent-color:#c2185b;cursor:pointer">' +
        (canRegen && !busy ? '<button class="b-regen1" data-i="' + i + '" title="Tạo LẠI ảnh này (giữ nguyên tên + cảnh của bộ, ~30-60s)" style="position:absolute;right:2px;bottom:6px;font-size:11px;line-height:1;padding:2px 4px;border-radius:5px;border:none;background:rgba(0,0,0,.55);color:#fff;cursor:pointer">🔄</button>' : '') +
        '</div>';
    }).join("");
    card.innerHTML =
      '<div class="fp-card-prompt" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">' + (it._hist ? '🕘 ' : '') + (it.title || "Bộ ảnh") + ' · ' + (it.pics || []).length + ' ảnh' +
        (it._hist ? ' <span class="hint" style="font-size:10px">(lịch sử)</span>' : '') +
        (it.plate ? ' <img src="' + gthumb(it.plate) + '" data-full="' + it.plate + '" title="🧵 Bản design chuẩn (bước 1) — mọi ảnh trong bộ copy y nguyên từ đây; bấm xem to" style="width:40px;height:28px;object-fit:cover;border-radius:5px;border:1px solid var(--violet,#7c3aed);cursor:zoom-in" onclick="openZoom(this.dataset.full)">' : '') + '</div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin:6px 0">' + thumbs + '</div>' +
      (function () {
        const proofs = (it.pics || []).map((p, i) => p.prompt
          ? '<div style="margin:4px 0"><b style="font-size:11px">📷 Ảnh ' + (i + 1) + ' — prompt đã gửi cho model:</b><pre style="white-space:pre-wrap;font-size:10px;line-height:1.45;max-height:150px;overflow:auto;background:rgba(127,127,127,.1);padding:6px 8px;border-radius:6px;margin:2px 0">' + p.prompt.replace(/&/g, "&amp;").replace(/</g, "&lt;") + '</pre></div>'
          : "").join("");
        const nDistinct = new Set((it.pics || []).map(p => p.base).filter(Boolean)).size;
        return proofs
          ? '<details style="margin:2px 0 4px"><summary style="cursor:pointer;font-size:11px;color:var(--accent,#c2185b)">🧠 BẰNG CHỨNG Claude — ' + (nDistinct > 1 ? nDistinct + ' PROMPT RIÊNG BIỆT (1 prompt/ảnh)' : 'xem prompt từng ảnh') + '</summary>' + proofs + '</details>'
          : "";
      })() +
      '<div class="fp-card-acts"><button class="b-style" title="Lấy 1 ảnh trong bộ này làm STYLE mẫu cho concept — ảnh sau sẽ giống look này (dùng chung cả FB ADS)">⭐ Làm style mẫu</button><button class="b-dlall" title="Tải các ảnh đã tick">⬇ Tải <span class="fbp-pickn2">' + it._pick.size + '</span> ảnh</button><button class="b-delhist">🗑️</button></div>' +
      '<p class="gen-note fbp-postnote"></p>';
    card.querySelectorAll('img[data-i]').forEach(img => { img.onclick = () => openZoom(img.dataset.full || img.src); });
    card.querySelectorAll(".b-regen1").forEach(btn => { btn.onclick = (e) => { e.stopPropagation(); fbpRegenOne(it, parseInt(btn.dataset.i, 10)); }; });
    card.querySelectorAll(".fbp-pick").forEach(cb => {
      cb.onchange = () => {
        const i = parseInt(cb.dataset.i, 10);
        if (cb.checked) it._pick.add(i); else it._pick.delete(i);
        const img = card.querySelector('img[data-i="' + i + '"]'); if (img) img.style.opacity = cb.checked ? "1" : ".35";
        const n1 = card.querySelector(".fbp-pickn"); if (n1) n1.textContent = it._pick.size;
        const n2 = card.querySelector(".fbp-pickn2"); if (n2) n2.textContent = it._pick.size;
        fbpUpdateGlobalBar();
      };
    });
    card.querySelector(".b-style").onclick = () => fbpSetAsStyle(it, card);
    card.querySelector(".b-dlall").onclick = () => { (it.pics || []).forEach((p, i) => { if (p.image && it._pick.has(i)) autoDownload(p.image, (it.concept || "post") + "-" + (i + 1)); }); };
    card.querySelector(".b-delhist").onclick = async () => {
      if (!confirm("Xoá bộ ảnh này khỏi danh sách?")) return;
      if (it._hid) { try { await fetch("/api/fbpost-hist-del", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: it._hid }) }); } catch (e) {} }
      fbpItems = fbpItems.filter(x => x !== it); fbpRenderAll();
    };
    grid.appendChild(card);
  });
  fbpUpdateGlobalBar();
}

// ==== GỘP ẢNH TICK TỪ NHIỀU BỘ / NHIỀU LẦN TẠO THÀNH 1 BÀI (không chia theo từng bộ) ====
function _fbpTicked() {
  const urls = [];
  fbpItems.filter(x => !x.loading).forEach(it => (it.pics || []).forEach((p, i) => {
    if (p.url && it._pick && it._pick.has(i)) urls.push(p.url);
  }));
  return urls;
}
function fbpUpdateGlobalBar() {
  const bar = $("fbpGlobalBar"); if (!bar) return;
  let n = 0, ns = 0;
  fbpItems.filter(x => !x.loading).forEach(it => {
    const c = (it.pics || []).filter((p, i) => p.url && it._pick && it._pick.has(i)).length;
    if (c) { n += c; ns++; }
  });
  bar.querySelector(".fbp-gcount").textContent = n ? ("☑️ Đã tick " + n + " ảnh từ " + ns + " bộ") : "☑️ Chưa tick ảnh nào";
  const b = bar.querySelector(".fbp-gpost");
  b.disabled = !n;
  b.textContent = n ? ("➕ Tạo 1 bài từ " + n + " ảnh tick") : "➕ Tạo 1 bài từ ảnh tick";
}
async function fbpGlobalPost() {
  const urls = _fbpTicked();
  if (!urls.length) return;
  if (urls.length > 10 && !confirm("Bạn tick " + urls.length + " ảnh — IG carousel tối đa 10 ảnh (FB vẫn đăng được). Tiếp tục?")) return;
  const bar = $("fbpGlobalBar"), btn = bar.querySelector(".fbp-gpost"), note = bar.querySelector(".fbp-gnote");
  btn.disabled = true; const o = btn.textContent; btn.textContent = "⏳ Đang tạo bài…";
  note.className = "gen-note fbp-gnote"; note.textContent = "";
  try {
    const r = await fetch("/api/pgpost-add", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caption: "", image_urls: urls, product: (typeof fbpProductLink !== "undefined" ? fbpProductLink : "") || "" }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Lỗi");
    note.className = "gen-note fbp-gnote ok"; note.textContent = "✓ Đã tạo 1 bài " + urls.length + " ảnh — sang tab 📋 Bài FB/IG để 🤖 viết bài + đăng.";
  } catch (e) { note.className = "gen-note fbp-gnote err"; note.textContent = "✗ " + e.message; }
  btn.textContent = o; fbpUpdateGlobalBar();
}
// 🔄 TẠO LẠI một ảnh trong bộ — giữ nguyên tên + cảnh Claude + chủ đề shot; spinner ngay trên ảnh
function _fbpCardOf(it) {
  const idx = fbpItems.indexOf(it);
  return idx >= 0 ? $("fbpResults").children[idx] : null;
}
function _fbpCardNote(it, cls, msg) {
  const card = _fbpCardOf(it);
  const note = card && card.querySelector(".fbp-postnote");
  if (note) { note.className = "gen-note fbp-postnote " + cls; note.textContent = msg; }
}
async function fbpRegenOne(it, i) {
  if (it._regening !== undefined && it._regening !== null) return;   // 1 ảnh/lần cho bộ này
  it._regening = i;
  fbpRenderAll();   // hiện spinner ⏳ trên chính thumb đó
  _fbpCardNote(it, "", "⏳ Đang TẠO LẠI ảnh " + (i + 1) + " (giữ tên + cảnh Claude, ~30–60s)…");
  try {
    const r = await fetch("/api/fbpost-regen", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // có plate (bản design chuẩn) -> gen lại từ plate, copy AS-IS không đổi chữ
        image: it.plate ? (it.plate.startsWith("http") ? it.plate : location.origin + it.plate) : it._design,
        plate: !!it.plate,
        ref: it._ref || "", key: it.concept, names: it.names || [],
        bg: it.bg || "", scene: (it.pics[i] && it.pics[i].base) || it.scene || "",
        shot: (it.pics[i] && typeof it.pics[i].shot === "number") ? it.pics[i].shot : null,
        engine: ($("fbpEngine") && $("fbpEngine").value) || "",
        aspect: $("fbpAspect").value, quality: $("fbpQuality").value }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Lỗi");
    it.pics[i] = { image: d.image, url: d.url, id: d.id, prompt: d.prompt || "", shot: it.pics[i] && it.pics[i].shot, base: d.base || (it.pics[i] && it.pics[i].base) || "" };
    it._regening = null;
    fbpRenderAll();
    _fbpCardNote(it, "ok", "✓ Đã tạo lại ảnh " + (i + 1) + (d.by === "claude" ? " — 🧠 prompt Claude của bộ." : "."));
  } catch (e) {
    it._regening = null;
    fbpRenderAll();
    _fbpCardNote(it, "err", "✗ Tạo lại ảnh " + (i + 1) + " lỗi: " + e.message);
  }
}

// Lấy 1 ảnh trong bộ làm STYLE mẫu cho concept (đồng bộ cả FB post + FB ADS)
let _fbpStylePickIdx = {};
function fbpSetAsStyle(it, card) {
  const note = card.querySelector(".fbp-postnote");
  const pics = it.pics || [];
  if (!pics.length) return;
  // cho user chọn ảnh nào trong bộ (mặc định ảnh 1); bấm lại đổi sang ảnh kế tiếp
  const key = it.concept;
  const i = (_fbpStylePickIdx[it.title] || 0) % pics.length;
  _fbpStylePickIdx[it.title] = i + 1;
  const p = pics[i];
  const durl = p.image ? ("data:image/png;base64," + p.image) : p.url;
  fbpStyle[key] = durl; fbpSel.add(key);
  if (typeof adsStyle !== "undefined") { adsStyle[key] = durl; if (typeof adsSel !== "undefined") adsSel.add(key); }
  fbpRenderConcepts();
  if (typeof adsRenderConcepts === "function") { try { adsRenderConcepts(); } catch (e) {} }
  // lưu lên server làm style của concept (autopilot/khôi phục dùng được)
  if (typeof adsSaveConceptStyle === "function") { try { adsSaveConceptStyle(key, durl); } catch (e) {} }
  if (note) { note.className = "gen-note ok"; note.textContent = "⭐ Đã đặt ảnh #" + (i + 1) + " làm style mẫu cho '" + (it.title || key) + "' (dùng chung FB ADS). Bấm lại để chọn ảnh khác trong bộ. Nhớ '💾 Lưu mặc định'."; }
}
/* =====================================================================
   QUẢN LÝ / PHÂN TÍCH ADS: list campaign + insights + bật/tắt + sửa ngân sách
   ===================================================================== */
let admgrInited = false;
function admgrInit() {
  if (!admgrInited) {
    admgrInited = true;
    $("admgrRefresh").onclick = admgrLoad;
    $("admgrRange").onchange = admgrLoad;
  }
  admgrLoad();
}
const fmtNum = (n) => { const x = parseFloat(n); return isNaN(x) ? "—" : x.toLocaleString("vi-VN"); };
async function admgrLoad() {
  const note = $("admgrNote"), tbl = $("admgrTable");
  note.className = "gen-note"; note.textContent = "Đang tải…"; tbl.innerHTML = "";
  try {
    const rng = $("admgrRange").value;
    const d = await (await fetch("/api/fb-ads-list?range=" + encodeURIComponent(rng))).json();
    if (d.error) throw new Error(d.error);
    if (d.manager_url) $("admgrMgr").href = d.manager_url;
    const cs = d.campaigns || [];
    $("admgrEmpty").classList.toggle("hidden", cs.length > 0);
    if (!cs.length) { note.textContent = ""; return; }
    // tổng
    const tot = cs.reduce((a, c) => { a.spend += parseFloat(c.spend || 0); a.reach += parseFloat(c.reach || 0); a.clicks += parseFloat(c.clicks || 0); a.impr += parseFloat(c.impressions || 0); return a; }, { spend: 0, reach: 0, clicks: 0, impr: 0 });
    note.className = "gen-note ok"; note.innerHTML = "💰 Tổng chi tiêu: <b>" + fmtNum(tot.spend) + "đ</b> · 👁 Reach " + fmtNum(tot.reach) + " · 🖱 Click " + fmtNum(tot.clicks) + " · " + cs.length + " chiến dịch";
    let html = '<table class="admgr-tbl"><thead><tr><th>Chiến dịch</th><th>Trạng thái</th><th>Chi tiêu</th><th>Reach</th><th>Hiển thị</th><th>Click</th><th>CTR</th><th>CPC</th><th></th></tr></thead><tbody>';
    cs.forEach((c, i) => {
      const active = c.status === "ACTIVE";
      const badge = active ? '<span class="sl-badge on">Đang chạy</span>' : '<span class="sl-badge">Tạm dừng</span>';
      html += '<tr>' +
        '<td title="' + (c.name || "").replace(/"/g, "&quot;") + '">' + (c.name || "").slice(0, 38) + '<br><span class="hint">' + (c.objective || "") + '</span></td>' +
        '<td>' + badge + '</td>' +
        '<td><b>' + fmtNum(c.spend) + 'đ</b></td>' +
        '<td>' + fmtNum(c.reach) + '</td><td>' + fmtNum(c.impressions) + '</td><td>' + fmtNum(c.clicks) + '</td>' +
        '<td>' + (c.ctr ? parseFloat(c.ctr).toFixed(2) + "%" : "—") + '</td>' +
        '<td>' + (c.cpc ? fmtNum(c.cpc) + "đ" : "—") + '</td>' +
        '<td style="white-space:nowrap"><button class="btn-ghost sm admgr-tog" data-id="' + c.id + '" data-st="' + c.status + '">' + (active ? "⏸ Dừng" : "▶ Bật") + '</button> <button class="btn-ghost sm admgr-del" data-id="' + c.id + '" data-nm="' + (c.name || "").replace(/"/g, "&quot;") + '">🗑️</button></td>' +
        '</tr>';
    });
    html += '</tbody></table>';
    tbl.innerHTML = html;
    tbl.querySelectorAll(".admgr-tog").forEach(b => b.onclick = () => admgrToggle(b.dataset.id, b.dataset.st, b));
    tbl.querySelectorAll(".admgr-del").forEach(b => b.onclick = () => admgrDelete(b.dataset.id, b.dataset.nm, b));
  } catch (e) { note.className = "gen-note err"; note.textContent = "✗ " + e.message; }
}
async function admgrDelete(id, name, btn) {
  if (!confirm("Xoá vĩnh viễn chiến dịch \"" + (name || id) + "\"? (không hoàn tác)")) return;
  btn.disabled = true; btn.textContent = "⏳";
  try {
    const r = await fetch("/api/fb-ad-delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: id }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Lỗi");
    admgrLoad();
  } catch (e) { alert("✗ " + e.message); btn.disabled = false; btn.textContent = "🗑️"; }
}
async function admgrToggle(id, cur, btn) {
  const to = cur === "ACTIVE" ? "PAUSED" : "ACTIVE";
  if (to === "ACTIVE" && !confirm("BẬT chiến dịch này = bắt đầu chạy + TIÊU TIỀN. Chắc chứ?")) return;
  btn.disabled = true; const o = btn.textContent; btn.textContent = "⏳…";
  try {
    const r = await fetch("/api/fb-ad-update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: id, status: to }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Lỗi");
    admgrLoad();
  } catch (e) { alert("✗ " + e.message); btn.disabled = false; btn.textContent = o; }
}

/* =====================================================================
   LỊCH CONTENT TỰ ĐỘNG — FB + Instagram
   ===================================================================== */
let schedInited = false, schedSel = [], schedGallery = [];
function schedInit() {
  if (!schedInited) {
    schedInited = true;
    $("schedAddBtn").onclick = schedAdd;
    // giờ mặc định: +1 tiếng, làm tròn
    const d = new Date(Date.now() + 3600 * 1000);
    d.setMinutes(0, 0, 0);
    const pad = n => String(n).padStart(2, "0");
    $("schedWhen").value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    schedCheckIg();
    aplInit();
  }
  schedLoadGallery();
  schedLoadList();
  aplLoad();
}

/* ---- Phi công tự động: tự gen + đăng random ---- */
let aplInited = false, aplTimer = null;
function aplInit() {
  if (aplInited) return; aplInited = true;
  $("apSave").onclick = aplSave;
  $("apEnabled").onchange = aplSave;
  $("apRunNow").onclick = aplRunNow;
}
async function aplLoad() {
  try {
    const d = await (await fetch("/api/autopost-status")).json();
    $("apEnabled").checked = !!d.enabled;
    $("apPerDay").value = d.per_day || 5;
    $("apPerSet").value = d.per_set || 4;
    $("apStart").value = d.start_hour != null ? d.start_hour : 8;
    $("apEnd").value = d.end_hour != null ? d.end_hour : 22;
    $("apFb").checked = (d.channels || []).includes("fb");
    $("apIg").checked = (d.channels || []).includes("ig");
    const st = $("apStatus");
    if (d.enabled) {
      const mins = Math.round((d.next_in || 0) / 60);
      st.className = "gen-note ok";
      st.innerHTML = "🟢 Đang bật · đã đăng <b>" + (d.done_today || 0) + "/" + (d.per_day || 5) + "</b> hôm nay" + (d.running ? " · ⏳ đang đăng…" : (d.next_in ? " · bài kế ~" + mins + " phút" : ""));
    } else { st.className = "gen-note"; st.textContent = "⚪ Đang tắt"; }
    $("apLog").textContent = (d.log || []).slice().reverse().join("\n");
    if (d.enabled && !aplTimer) aplTimer = setInterval(aplLoad, 15000);
    if (!d.enabled && aplTimer) { clearInterval(aplTimer); aplTimer = null; }
  } catch (e) {}
}
async function aplSave() {
  const chans = []; if ($("apFb").checked) chans.push("fb"); if ($("apIg").checked) chans.push("ig");
  const enabled = $("apEnabled").checked;
  if (enabled && !chans.length) { alert("Chọn ít nhất 1 kênh (FB/IG)."); $("apEnabled").checked = false; return; }
  if (enabled && !confirm("BẬT phi công tự động: tool sẽ TỰ ĐĂNG CÔNG KHAI " + ($("apPerDay").value) + " bài/ngày lên " + chans.map(c => c === "fb" ? "Facebook" : "Instagram").join(" + ") + ". Chắc chứ?")) { $("apEnabled").checked = false; return; }
  try {
    const r = await fetch("/api/autopost-config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: enabled, per_day: +$("apPerDay").value, per_set: +$("apPerSet").value, start_hour: +$("apStart").value, end_hour: +$("apEnd").value, channels: chans }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Lỗi");
    aplLoad();
  } catch (e) { alert("✗ " + e.message); }
}
async function aplRunNow() {
  if (!confirm("Đăng THỬ 1 bài random NGAY (công khai)? Mất ~1-3 phút để gen + đăng.")) return;
  const btn = $("apRunNow"); btn.disabled = true; btn.textContent = "⏳ Đang chạy…";
  try {
    const r = await fetch("/api/autopost-run-now", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Lỗi");
    setTimeout(aplLoad, 2000);
    if (!aplTimer) aplTimer = setInterval(aplLoad, 15000);
  } catch (e) { alert("✗ " + e.message); }
  finally { setTimeout(() => { btn.disabled = false; btn.textContent = "⚡ Đăng thử 1 bài ngay"; }, 3000); }
}
async function schedCheckIg() {
  try {
    const d = await (await fetch("/api/ig-status")).json();
    const n = $("schedIgNote");
    if (d.connected && d.can_publish) { n.className = "gen-note ok"; n.textContent = "✓ Instagram sẵn sàng: @" + (d.username || d.ig_id) + " — đăng được."; }
    else if (d.connected) { n.className = "gen-note"; n.innerHTML = "📷 IG đã nối <b>@" + (d.username || d.ig_id) + "</b> nhưng <b>token thiếu quyền đăng</b> — tạo lại token thêm <code>instagram_basic</code> + <code>instagram_content_publish</code>. (Facebook vẫn đăng bình thường.)"; }
    else { n.className = "gen-note"; n.innerHTML = "📷 <b>Instagram chưa nối</b> — Facebook vẫn đăng được. Để bật IG: nối Instagram Business vào Trang + token cần instagram_basic + instagram_content_publish."; }
  } catch (e) {}
}
async function schedLoadGallery() {
  try {
    const d = await (await fetch("/api/gallery")).json();
    schedGallery = d.items || [];
    const box = $("schedPick"); box.innerHTML = "";
    if (!schedGallery.length) { box.innerHTML = '<span class="hint">Kho ảnh trống — tạo ảnh ở các tab khác trước.</span>'; return; }
    schedGallery.forEach(it => {
      const on = schedSel.includes(it.url);
      const d2 = document.createElement("div");
      d2.style.cssText = "position:relative;width:62px;height:62px;border-radius:8px;overflow:hidden;cursor:pointer;border:2px solid " + (on ? "var(--violet)" : "transparent");
      d2.innerHTML = `<img src="${it.url}" style="width:100%;height:100%;object-fit:cover" loading="lazy">` + (on ? `<span style="position:absolute;top:2px;right:2px;background:var(--violet);color:#fff;border-radius:50%;width:16px;height:16px;font-size:10px;display:grid;place-items:center">✓</span>` : "");
      d2.onclick = () => { const i = schedSel.indexOf(it.url); if (i >= 0) schedSel.splice(i, 1); else schedSel.push(it.url); schedLoadGallery(); };
      box.appendChild(d2);
    });
    $("schedPickNote").textContent = "Đã chọn " + schedSel.length + " ảnh" + (schedSel.length > 10 ? " (FB/IG tối đa 10)" : "");
  } catch (e) {}
}
async function schedAdd() {
  const note = $("schedNote");
  const chans = []; if ($("schedFb").checked) chans.push("fb"); if ($("schedIg").checked) chans.push("ig");
  const when = $("schedWhen").value;
  if (!schedSel.length) { note.className = "gen-note err"; note.textContent = "✗ Chọn ít nhất 1 ảnh."; return; }
  if (!chans.length) { note.className = "gen-note err"; note.textContent = "✗ Chọn ít nhất 1 kênh."; return; }
  if (!when) { note.className = "gen-note err"; note.textContent = "✗ Chọn thời gian."; return; }
  const ts = new Date(when).getTime() / 1000;
  if (ts * 1000 < Date.now() - 60000) { note.className = "gen-note err"; note.textContent = "✗ Thời gian phải ở tương lai."; return; }
  const btn = $("schedAddBtn"); btn.disabled = true; note.className = "gen-note"; note.textContent = "Đang lưu lịch…";
  try {
    const r = await fetch("/api/sched-add", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image_urls: schedSel.slice(0, 10), channels: chans, message: $("schedCaption").value, when: ts }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Lỗi");
    note.className = "gen-note ok"; note.textContent = "✓ Đã lên lịch! Hệ thống sẽ tự đăng đúng giờ.";
    schedSel = []; $("schedCaption").value = ""; schedLoadGallery(); schedLoadList();
  } catch (e) { note.className = "gen-note err"; note.textContent = "✗ " + e.message; }
  finally { btn.disabled = false; }
}
const SCHED_STAT = { pending: ["⏳ Chờ đăng", ""], posted: ["✓ Đã đăng", "ok"], error: ["✗ Lỗi", "err"] };
async function schedLoadList() {
  try {
    const d = await (await fetch("/api/sched-list")).json();
    const items = d.items || [];
    $("schedEmpty").classList.toggle("hidden", items.length > 0);
    const box = $("schedList"); box.innerHTML = "";
    items.forEach(it => {
      const when = new Date((it.when || 0) * 1000).toLocaleString("vi-VN");
      const st = SCHED_STAT[it.status] || ["?", ""];
      const chans = (it.channels || []).map(c => c === "fb" ? "📘" : "📷").join(" ");
      const res = it.result ? Object.entries(it.result).map(([k, v]) => (String(v || "").startsWith("http") ? `<a href="${v}" target="_blank" style="color:var(--violet)">${k} →</a>` : `<span style="color:#dc2626">${k}: ${v}</span>`)).join(" · ") : "";
      const card = document.createElement("div");
      card.style.cssText = "display:flex;gap:10px;align-items:center;border:1px solid var(--line);border-radius:12px;padding:8px 10px;margin-bottom:8px";
      card.innerHTML =
        `<img src="${it.thumb || (it.image_urls || [])[0] || ''}" style="width:48px;height:48px;border-radius:8px;object-fit:cover;flex:none">` +
        `<div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:600">${chans} · ${when}</div>` +
        `<div class="hint" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${(it.message || "(không caption)").slice(0, 70)}</div>` +
        (res ? `<div style="font-size:11px;margin-top:2px">${res}</div>` : "") + `</div>` +
        `<span class="gen-note ${st[1]}" style="margin:0;white-space:nowrap">${st[0]} · ${(it.image_urls || []).length}🖼</span>` +
        `<button class="btn-ghost sm sched-del" data-id="${it.id}">🗑️</button>`;
      box.appendChild(card);
    });
    box.querySelectorAll(".sched-del").forEach(b => b.onclick = () => schedDel(b.dataset.id));
  } catch (e) {}
}
async function schedDel(id) {
  if (!confirm("Xoá bài này khỏi lịch?")) return;
  await fetch("/api/sched-del", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: id }) });
  schedLoadList();
}

/* =====================================================================
   BẢNG BÀI FB ADS — gom bài (ảnh+tiêu đề+mô tả+link) + đẩy hàng loạt giãn cách
   ===================================================================== */
// đưa 1 ảnh ads sang Bảng bài (tự điền tiêu đề/link + AI viết caption)
async function adpostAddFromAd(c, btn) {
  const url = c.url || (c.gallery && c.gallery.url);
  if (!url) { if (btn) alert("Ảnh này chưa lưu vào kho (không có URL công khai) — thử lại sau khi ảnh tạo xong."); return false; }
  if (btn) { btn.disabled = true; btn.textContent = "⏳"; }
  const title = (c.name || "Áo Thun In Tên").slice(0, 100);   // = HEADLINE FB Ads, mặc định Áo Thun In Tên
  const product = c._ptitle || adsAutoName2 || "";            // SP gốc (chỉ để biết ảnh thuộc SP nào)
  const link = c._link || ($("adsLink") && $("adsLink").value.trim()) || (typeof adsProductLink !== "undefined" ? adsProductLink : "") || "";
  let caption = "🔥 " + (product || title) + " — " + (c.hook || "Cá nhân hoá theo tên riêng") + "\n✨ In tên riêng theo yêu cầu, chất vải đẹp, giao toàn quốc.\n👉 Đặt ngay tại rieng.vn!";
  try {
    // THÊM NGAY (hết lag) — caption tạm bằng template, AI viết bản xịn chạy NỀN rồi tự cập nhật
    const r = await fetch("/api/adpost-add", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: title, caption: caption, link: link, product: product, product_img: c._pimg || "", image_url: url }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Lỗi");
    if (btn) { btn.textContent = "✓ Đã thêm"; setTimeout(() => { btn.disabled = false; btn.textContent = "➕ Bài Ads"; }, 1500); }
    (async () => {   // AI caption chạy nền: gửi URL (không upload base64 nặng)
      try {
        const AUD = { couple: "Bài cho CẶP ĐÔI (couple, 2 áo).", group: "Bài cho NHÓM BẠN / ĐỘI NHÓM (nhiều áo, KHÔNG phải couple).", flatlay2: "Bài couple/đôi (2 áo).", flatlay3: "Bài cho NHÓM (3 áo, KHÔNG phải couple).", family: "Bài cho GIA ĐÌNH (có cả size trẻ em, KHÔNG phải couple)." };
        const info = "Áo thun in tên cá nhân hoá, thương hiệu rieng.vn. " + (AUD[c.concept] || "") + " Nhớ: hợp couple/đội nhóm/gia đình, CÓ size trẻ em.";
        const absUrl = url.startsWith("http") ? url : (location.origin + url);   // server cần URL tuyệt đối
        const rr = await fetch("/api/product-content", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: absUrl, info: info }) });
        const dd = await rr.json();
        if (rr.ok && (dd.facebook || "").trim()) {
          await fetch("/api/adpost-update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: d.id, caption: dd.facebook.trim() }) });
          const v = document.getElementById("view-adpost");
          if (v && !v.classList.contains("hidden") && typeof adpostLoad === "function") adpostLoad();
        }
      } catch (e) {}
    })();
    return true;
  } catch (e) { if (btn) { alert("✗ " + e.message); btn.disabled = false; btn.textContent = "➕ Bài Ads"; } return false; }
}

let adpostInited = false, adpostPollTimer = null;
function adpostInit() {
  if (!adpostInited) {
    adpostInited = true;
    $("adpostPushBtn").onclick = adpostBatchPush;
    if ($("adpostDelSel")) $("adpostDelSel").onclick = adpostDelSelected;
    if ($("adpostFixLinks")) $("adpostFixLinks").onclick = adpostFixLinks;
    if ($("adpostApplyDefLink")) $("adpostApplyDefLink").onclick = adpostApplyDefLink;
    fbPostAdsWire();
    adpostUpWire();
    $("adpostAll").onchange = (e) => { document.querySelectorAll(".adpost-tick").forEach(t => t.checked = e.target.checked); };
    if ($("adpostCampaign")) $("adpostCampaign").onchange = adpostOnCampaignChange;
    if ($("adpostReload")) $("adpostReload").onclick = async () => {
      const b = $("adpostReload"); b.disabled = true; const o = b.textContent; b.textContent = "⏳ Đang tải…";
      await adpostLoadCampaigns(); adpostLoad();
      b.disabled = false; b.textContent = o;
    };
    adpostLoadCampaigns();
  }
  adpostLoad();
}
async function adpostLoadCampaigns() {
  const sel = $("adpostCampaign"); if (!sel) return;
  const keep = sel.value;
  try {
    const d = await (await fetch("/api/fb-campaigns?ts=" + Date.now())).json();   // ts -> tránh cache
    sel.innerHTML = '<option value="">➕ Tạo chiến dịch mới</option>';
    const cs = d.campaigns || [];
    cs.forEach(c => {
      const o = document.createElement("option"); o.value = c.id;
      const stt = c.status === "PAUSED" ? " (tạm dừng)" : (c.status && c.status !== "ACTIVE" ? " (" + c.status.toLowerCase() + ")" : "");
      o.textContent = (c.name || c.id).slice(0, 40) + stt;
      sel.appendChild(o);
    });
    if (keep) sel.value = keep;
    const n = $("adpostNote");
    if (n) { n.className = "gen-note ok"; n.textContent = "🔄 Đã tải " + cs.length + " chiến dịch từ tài khoản FB." + (cs.length === 0 ? " (Lưu ý: chiến dịch DRAFT chưa publish trên Ads Manager sẽ KHÔNG hiện qua API — publish/bật rồi tải lại.)" : ""); }
  } catch (e) { const n = $("adpostNote"); if (n) { n.className = "gen-note err"; n.textContent = "✗ Tải chiến dịch lỗi: " + e.message; } }
  adpostOnCampaignChange();
}
async function adpostOnCampaignChange() {
  const cid = $("adpostCampaign").value, sel = $("adpostAdset"), n = $("adpostNote");
  sel.innerHTML = '<option value="">➕ Tạo nhóm mới</option>';
  if (!cid) return;
  sel.innerHTML = '<option value="">⏳ đang tải nhóm…</option>';
  try {
    const r = await fetch("/api/fb-adsets?campaign_id=" + encodeURIComponent(cid) + "&ts=" + Date.now());
    const d = await r.json();
    sel.innerHTML = '<option value="">➕ Tạo nhóm mới</option>';
    if (!r.ok) { if (n) { n.className = "gen-note err"; n.textContent = "✗ Tải nhóm (ad set) lỗi: " + (d.error || ""); } return; }
    const as = d.adsets || [];
    as.forEach(a => { const o = document.createElement("option"); o.value = a.id; o.textContent = (a.name || a.id).slice(0, 36); sel.appendChild(o); });
    if (n) {
      if (as.length) { n.className = "gen-note ok"; n.textContent = "✓ Đã tải " + as.length + " nhóm (ad set) của chiến dịch."; }
      else { n.className = "gen-note"; n.textContent = "ℹ️ Chiến dịch này CHƯA có nhóm (ad set) nào — cứ để '➕ Tạo nhóm mới', tool sẽ tự tạo nhóm khi đẩy."; }
    }
  } catch (e) { sel.innerHTML = '<option value="">➕ Tạo nhóm mới</option>'; if (n) { n.className = "gen-note err"; n.textContent = "✗ Lỗi tải nhóm: " + e.message; } }
}
const ADPOST_ST = { draft: ["⚪ Nháp", ""], pushing: ["⏳ Đang đẩy", ""], pushed: ["✓ Đã đẩy", "ok"], error: ["✗ Lỗi", "err"] };
let adpostProds = null;   // cache danh sách SP Shopify (để gán cho từng bài)
async function adpostLoad() {
  try {
    if (!adpostProds) { try { adpostProds = (await (await fetch("/api/shopify-products")).json()).products || []; } catch (e) { adpostProds = []; } }
    // gợi ý link mặc định (bạn sửa lại link đúng nếu muốn) — KHÔNG tự gắn, chỉ điền sẵn ô
    if ($("adpostDefLink") && !$("adpostDefLink").value.trim() && adpostProds[0] && adpostProds[0].store_url) {
      $("adpostDefLink").value = adpostProds[0].store_url;
    }
    const d = await (await fetch("/api/adpost-list")).json();
    const items = d.items || [];
    $("adpostEmpty").classList.toggle("hidden", items.length > 0);
    adpostRender(items);
    const p = d.pushing || {};
    const note = $("adpostNote");
    if (p.running) {
      note.className = "gen-note"; note.innerHTML = "⏳ Đang đẩy <b>" + p.done + "/" + p.total + "</b> bài" + (p.next_in ? " · bài kế trong <b>" + p.next_in + "s</b> (giãn cách an toàn)" : "") + "…";
      if (!adpostPollTimer) adpostPollTimer = setInterval(adpostLoad, 3000);
    } else {
      if (adpostPollTimer) { clearInterval(adpostPollTimer); adpostPollTimer = null; }
      if ((p.log || []).length && p.total) { note.className = "gen-note ok"; note.innerHTML = "✓ Xong đợt đẩy " + p.total + " bài.<br>" + p.log.map(l => '<span class="hint">' + l.slice(0, 80) + '</span>').join("<br>"); }
    }
  } catch (e) {}
}
// ===== Upload ảnh/video ngoài -> gắn SP -> tự gen bài -> thêm vào bảng =====
let adpostUpMedia = null, adpostUpType = null, adpostUpProduct = null;
function adpostUpWire() {
  const btn = $("adpostUpBtn"); if (!btn) return;
  btn.onclick = () => $("adpostUpPanel").classList.toggle("hidden");
  if ($("adpostUpClose")) $("adpostUpClose").onclick = () => $("adpostUpPanel").classList.add("hidden");
  const setMedia = async (f) => {
    if (!f) return;
    adpostUpType = f.type.startsWith("video") ? "video" : "image";
    adpostUpMedia = await fileToDataURL(f);
    $("adpostUpName").textContent = (adpostUpType === "video" ? "🎬 " : "🖼️ ") + f.name;
    $("adpostUpPrev").innerHTML = adpostUpType === "video"
      ? '<video src="' + adpostUpMedia + '" controls style="max-width:100%;max-height:180px;border-radius:8px"></video>'
      : '<img src="' + adpostUpMedia + '" style="max-width:100%;max-height:180px;border-radius:8px">';
  };
  if ($("adpostUpFile")) $("adpostUpFile").onchange = (e) => { setMedia(e.target.files[0]); e.target.value = ""; };
  if ($("adpostUpDrop")) {
    $("adpostUpDrop").ondragover = (e) => e.preventDefault();
    $("adpostUpDrop").ondrop = (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) setMedia(e.dataTransfer.files[0]); };
  }
  if ($("adpostUpPick")) $("adpostUpPick").onclick = () => openSpPicker((p) => {
    adpostUpProduct = { title: p.title || "", link: p.store_url || "", image: p.image || "" };
    $("adpostUpProd").innerHTML = "📦 <b>" + (p.title || "SP").replace(/</g, "&lt;").slice(0, 40) + "</b>" +
      (p.store_url ? ' · 🔗 <span style="color:var(--violet)">' + p.store_url.replace(/^https?:\/\//, "").slice(0, 30) + '…</span>' : "");
  });
  if ($("adpostUpAdd")) $("adpostUpAdd").onclick = async () => {
    const note = $("adpostUpNote");
    if (!adpostUpMedia) { note.className = "gen-note err"; note.textContent = "⚠️ Chọn ảnh hoặc video trước."; return; }
    if (!adpostUpProduct || !adpostUpProduct.link) { note.className = "gen-note err"; note.textContent = "⚠️ Chọn sản phẩm (để có link) trước."; return; }
    const b = $("adpostUpAdd"); b.disabled = true; const o = b.textContent; b.textContent = "⏳ Đang tạo bài…";
    note.className = "gen-note"; note.textContent = "⏳ Đang up media + AI viết bài…";
    try {
      const r = await fetch("/api/adpost-upload-media", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ media: adpostUpMedia, product: adpostUpProduct, caption: ($("adpostUpCaption").value || "").trim() }) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error || "Lỗi");
      note.className = "gen-note ok"; note.textContent = "✓ Đã tạo bài (" + adpostUpType + ") + thêm vào bảng. Tick chọn rồi đẩy lên Ads.";
      adpostUpMedia = null; adpostUpType = null; $("adpostUpName").textContent = "📁 Bấm / kéo-thả ảnh hoặc VIDEO vào đây";
      $("adpostUpPrev").innerHTML = ""; $("adpostUpCaption").value = "";
      adpostLoad();
    } catch (e) { note.className = "gen-note err"; note.textContent = "✗ " + e.message; }
    b.disabled = false; b.textContent = o;
  };
}
function adpostRender(items) {
  const box = $("adpostList");
  if (!items.length) { box.innerHTML = ""; return; }
  let h = '<table class="admgr-tbl"><thead><tr><th></th><th>Ảnh / SP</th><th>Tiêu đề <span class="hint">(= headline)</span></th><th>Mô tả</th><th>Link SP</th><th>Trạng thái</th><th></th></tr></thead><tbody>';
  items.forEach(it => {
    const st = ADPOST_ST[it.status] || ["?", ""];
    const res = it.result || {};
    const stCell = it.status === "pushed" && res.manager_url
      ? '<span class="gen-note ok" style="margin:0">✓ Đã đẩy</span><br><a href="' + res.manager_url + '" target="_blank" style="font-size:11px;color:var(--violet)">Ads Manager →</a>'
      : (it.status === "error" ? '<span class="gen-note err" style="margin:0;font-size:11px">✗ ' + (res.error || "").slice(0, 50) + '</span>' : '<span class="gen-note ' + st[1] + '" style="margin:0">' + st[0] + '</span>');
    h += '<tr data-id="' + it.id + '">' +
      '<td><input type="checkbox" class="adpost-tick" value="' + it.id + '"></td>' +
      '<td style="min-width:140px">' +
        (it.media_type === "video" && it.video_url
          ? '<video src="' + it.video_url + '" controls style="width:64px;height:80px;object-fit:cover;border-radius:8px;background:#000" title="Video ads"></video><div class="hint" style="font-size:9px;color:var(--violet)">🎬 video</div>'
          : '<img class="adpost-img" src="' + it.image_url + '" data-full="' + it.image_url + '" title="Bấm để phóng to" style="width:56px;height:70px;object-fit:cover;border-radius:8px;cursor:zoom-in" loading="lazy">') +
        (it.product_img ? '<img class="adpost-pimg" src="' + it.product_img + '" title="Ảnh sản phẩm gắn với bài này" style="width:40px;height:50px;object-fit:cover;border-radius:6px;border:1px solid var(--violet);margin:2px 0 0 4px;vertical-align:top">' : '') +
        '<div class="hint" style="font-size:10px;line-height:1.2;margin-top:2px;' + (it.product ? '' : 'color:#c0392b') + '">' + (it.product ? '📦 ' + (it.product || "").replace(/</g, "&lt;").slice(0, 36) : '⚠️ chưa gắn SP') + '</div>' +
        '<button class="btn-ghost sm adpost-prodbtn" style="font-size:11px;margin-top:3px;padding:3px 8px">📦 ' + (it.product ? "Đổi SP" : "Chọn SP") + '</button></td>' +
      '<td><input class="input adpost-f" data-f="title" value="' + (it.title || "").replace(/"/g, "&quot;") + '" style="width:150px;padding:6px 8px"></td>' +
      '<td><textarea class="input adpost-f" data-f="caption" rows="3" style="width:230px;padding:6px 8px;font-size:12px">' + (it.caption || "") + '</textarea>' +
        '<button class="btn-ghost sm adpost-recap" style="margin-top:4px;font-size:11px">🔄 Đổi mô tả khác</button></td>' +
      '<td><input class="input adpost-f" data-f="link" value="' + (it.link || "").replace(/"/g, "&quot;") + '" placeholder="link SP…" style="width:150px;padding:6px 8px;font-size:12px"></td>' +
      '<td style="white-space:nowrap">' + stCell + '</td>' +
      '<td><button class="btn-ghost sm adpost-del">🗑️</button></td>' +
      '</tr>';
  });
  h += '</tbody></table>';
  box.innerHTML = h;
  box.querySelectorAll(".adpost-img").forEach(im => im.onclick = () => { if (typeof openZoom === "function") openZoom(im.dataset.full); });
  box.querySelectorAll("tr[data-id]").forEach(tr => {
    const id = tr.dataset.id;
    // chọn SP cho bài này -> mở bộ chọn SP CÓ ẢNH
    const pbtn = tr.querySelector(".adpost-prodbtn");
    if (pbtn) pbtn.onclick = () => adpostOpenSpPicker(id, items);
    tr.querySelectorAll(".adpost-f").forEach(f => f.onchange = () => {
      fetch("/api/adpost-update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: id, [f.dataset.f]: f.value }) });
    });
    tr.querySelector(".adpost-del").onclick = async () => {
      if (!confirm("Xoá bài này khỏi bảng?")) return;
      await fetch("/api/adpost-del", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: id }) });
      adpostLoad();
    };
    // 🔄 Đổi mô tả khác (AI viết bản mới) -> cập nhật textarea + lưu
    const recap = tr.querySelector(".adpost-recap");
    if (recap) recap.onclick = async () => {
      const it = items.find(x => x.id === id); if (!it) return;
      const ta = tr.querySelector('textarea[data-f="caption"]');
      const old = recap.textContent; recap.disabled = true; recap.textContent = "⏳ Đang viết…";
      try {
        const info = "Áo thun in tên cá nhân hoá, thương hiệu rieng.vn. " + (it.product ? ("SP: " + it.product + ". ") : "") + "Hợp couple/đội nhóm/gia đình, CÓ size trẻ em. Viết 1 bản mô tả KHÁC, mới mẻ.";
        const r = await fetch("/api/product-content", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: it.image_url, info: info }) });
        const d = await r.json();
        const cap = (r.ok && (d.facebook || "").trim()) ? d.facebook.trim() : "";
        if (cap) { ta.value = cap; fetch("/api/adpost-update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: id, caption: cap }) }); it.caption = cap; }
      } catch (e) {}
      recap.disabled = false; recap.textContent = old;
    };
  });
}
async function adpostBatchPush() {
  const ids = [...document.querySelectorAll(".adpost-tick:checked")].map(t => t.value);
  if (!ids.length) { const n = $("adpostNote"); n.className = "gen-note err"; n.textContent = "✗ Chưa tick bài nào."; return; }
  const gap = parseInt($("adpostGap").value) || 90;
  const budget = parseInt($("adpostBudget").value) || 50000;
  const active = $("adpostActive").checked;
  const est = Math.round((ids.length - 1) * gap / 60);
  const warn = active
    ? "⚠️ CHẠY NGAY: " + ids.length + " quảng cáo sẽ LÊN SÓNG + TIÊU TIỀN ngay (" + budget.toLocaleString("vi-VN") + "đ/ngày mỗi ad). Giãn cách " + gap + "s/bài (~" + est + " phút). Chắc chứ?"
    : "Đẩy " + ids.length + " bài ở trạng thái TẠM DỪNG (chưa tiêu tiền), giãn cách " + gap + "s/bài. OK?";
  if (!confirm(warn)) return;
  const btn = $("adpostPushBtn"); btn.disabled = true;
  try {
    const campaign_id = ($("adpostCampaign") && $("adpostCampaign").value) || "";
    const adset_id = ($("adpostAdset") && $("adpostAdset").value) || "";
    const r = await fetch("/api/adpost-push-batch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: ids, gap: gap, daily_budget: budget, active: active, campaign_id: campaign_id, adset_id: adset_id }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Lỗi");
    const n = $("adpostNote"); n.className = "gen-note"; n.textContent = "⏳ Bắt đầu đẩy " + ids.length + " bài (" + (active ? "CHẠY NGAY" : "Tạm dừng") + "), giãn cách " + d.gap + "s…";
    adpostLoad();
  } catch (e) { const n = $("adpostNote"); n.className = "gen-note err"; n.textContent = "✗ " + e.message; }
  finally { btn.disabled = false; }
}
// Bộ chọn SP CÓ ẢNH cho 1 bài
// ===== Bộ chọn SP CÓ ẢNH dùng chung (board + card ads) =====
let _spPickerCb = null, _spPickerList = [], _spPickerWired = false;
async function openSpPicker(onPick) {
  _spPickerCb = onPick;
  if (!_spPickerWired) {
    _spPickerWired = true;
    if ($("adpostSpClose")) $("adpostSpClose").onclick = () => $("adpostSpModal").classList.add("hidden");
    if ($("adpostSpModal")) $("adpostSpModal").onclick = () => $("adpostSpModal").classList.add("hidden");
    if ($("adpostSpSearch2")) $("adpostSpSearch2").oninput = (e) => spPickerRender(e.target.value);
  }
  // nguồn SP: ưu tiên cache adpostProds, rồi adsMultiProducts, nếu chưa có thì tự tải
  _spPickerList = (adpostProds && adpostProds.length) ? adpostProds
                : (typeof adsMultiProducts !== "undefined" && adsMultiProducts.length) ? adsMultiProducts : [];
  $("adpostSpSearch2").value = "";
  $("adpostSpModal").classList.remove("hidden");
  if (!_spPickerList.length) {
    $("adpostSpGrid").innerHTML = '<p class="hint" style="grid-column:1/-1">⏳ Đang tải sản phẩm…</p>';
    try { _spPickerList = (await (await fetch("/api/shopify-products")).json()).products || []; adpostProds = adpostProds || _spPickerList; } catch (e) { _spPickerList = []; }
  }
  spPickerRender("");
}
function spPickerRender(q) {
  const grid = $("adpostSpGrid"); if (!grid) return;
  const ql = (q || "").toLowerCase();
  const list = (_spPickerList || []).filter(p => !ql || (p.title || "").toLowerCase().includes(ql));
  if (!list.length) { grid.innerHTML = '<p class="hint" style="grid-column:1/-1">Không có sản phẩm (hoặc chưa cấu hình Shopify).</p>'; return; }
  grid.innerHTML = list.map(p =>
    '<div class="adpost-sp-card" data-i="' + (_spPickerList.indexOf(p)) + '" style="border:1px solid var(--line);border-radius:10px;overflow:hidden;cursor:pointer;background:#fff">' +
      (p.image ? '<img src="' + p.image + '" style="width:100%;height:130px;object-fit:cover;display:block">' : '<div style="height:130px;background:#eee"></div>') +
      '<div style="padding:6px 8px;font-size:11px;line-height:1.3">' + (p.title || "").replace(/</g, "&lt;").slice(0, 50) + '</div>' +
    '</div>'
  ).join("");
  grid.querySelectorAll(".adpost-sp-card").forEach(c => c.onclick = () => {
    const p = _spPickerList[+c.dataset.i]; if (!p) return;
    $("adpostSpModal").classList.add("hidden");
    if (_spPickerCb) _spPickerCb(p);
  });
}
// Board: gắn SP cho 1 bài
function adpostOpenSpPicker(id, items) {
  openSpPicker(async (p) => {
    await fetch("/api/adpost-update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: id, product: p.title || "", link: p.store_url || "", product_img: p.image || "" }) }).catch(() => {});
    const it = (items || []).find(x => x.id === id);
    if (it) { it.product = p.title || ""; it.link = p.store_url || ""; it.product_img = p.image || ""; }
    adpostLoad();
  });
}
// Card ảnh ads: gắn SP trực tiếp (set link/tên/ảnh SP cho ảnh ads)
function adsAttachSp(idx) {
  openSpPicker((p) => {
    const c = adsItems[idx]; if (!c) return;
    c._ptitle = p.title || ""; c._link = p.store_url || ""; c._pimg = p.image || "";
    adsRenderAll();
  });
}
async function adpostApplyDefLink() {
  const n = $("adpostNote");
  const link = ($("adpostDefLink") && $("adpostDefLink").value || "").trim();
  if (!link) { if (n) { n.className = "gen-note err"; n.textContent = "⚠️ Nhập link mặc định trước (link đúng bạn muốn)."; } return; }
  // lấy danh sách bài hiện tại
  const d = await (await fetch("/api/adpost-list")).json();
  const empties = (d.items || []).filter(it => !(it.link || "").trim());
  if (!empties.length) { if (n) { n.className = "gen-note ok"; n.textContent = "✓ Mọi bài đã có link rồi."; } return; }
  if (!confirm("Gắn link này cho " + empties.length + " bài CHƯA có link?\n" + link)) return;
  for (const it of empties) {
    await fetch("/api/adpost-update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: it.id, link: link }) }).catch(() => {});
  }
  if (n) { n.className = "gen-note ok"; n.textContent = "✓ Đã gắn link cho " + empties.length + " bài chưa có link."; }
  adpostLoad();
}
async function adpostFixLinks() {
  const n = $("adpostNote"), btn = $("adpostFixLinks");
  // chỉ sửa các bài đã tick; không tick nào -> sửa tất cả
  const ticked = [...document.querySelectorAll(".adpost-tick:checked")].map(t => t.value);
  const scope = ticked.length ? ("đã chọn (" + ticked.length + ")") : "TẤT CẢ bài";
  if (!confirm("Sửa link theo đúng SP cho " + scope + "?\n(Khớp tên SP đã lưu của từng bài với sản phẩm Shopify.)")) return;
  if (n) { n.className = "gen-note"; n.textContent = "🔗 Đang khớp link với sản phẩm Shopify…"; }
  if (btn) btn.disabled = true;
  try {
    const body = ticked.length ? { ids: ticked } : {};
    const r = await fetch("/api/adpost-fix-links", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Lỗi");
    const um = (d.unmatched || []).length;
    if (n) {
      n.className = um ? "gen-note" : "gen-note ok";
      n.textContent = "✅ Đã sửa link đúng SP cho " + d.fixed + " bài." +
        (um ? " ⚠️ " + um + " bài không khớp được SP (tên SP khác/đã đổi) — sửa tay ở ô link: " + (d.unmatched || []).map(x => x.product || "?").slice(0, 4).join(", ") + (um > 4 ? "…" : "") : "");
    }
    adpostLoad();
  } catch (e) { if (n) { n.className = "gen-note err"; n.textContent = "✗ " + e.message; } }
  finally { if (btn) btn.disabled = false; }
}
async function adpostDelSelected() {
  const ids = [...document.querySelectorAll(".adpost-tick:checked")].map(t => t.value);
  const n = $("adpostNote");
  if (!ids.length) { if (n) { n.className = "gen-note err"; n.textContent = "✗ Chưa tick bài nào để xoá."; } return; }
  if (!confirm("Xoá " + ids.length + " bài đã chọn khỏi bảng?")) return;
  for (const id of ids) { await fetch("/api/adpost-del", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: id }) }).catch(() => {}); }
  if ($("adpostAll")) $("adpostAll").checked = false;
  if (n) { n.className = "gen-note ok"; n.textContent = "✓ Đã xoá " + ids.length + " bài."; }
  adpostLoad();
}

/* ---- Tạo ảnh Ads cho NHIỀU sản phẩm cùng lúc ---- */
let adsMultiProducts = [], adsMultiSel = new Set();
async function adsOpenMulti() {
  $("adsMultiInline").classList.remove("hidden");
  adsMultiSel = new Set();
  const grid = $("adsMultiGrid"); grid.innerHTML = '<p class="hint" style="grid-column:1/-1">Đang tải sản phẩm…</p>';
  $("adsMultiNote").textContent = "";
  try {
    const d = await (await fetch("/api/shopify-products")).json();
    if (d.error) throw new Error(d.error);
    adsMultiProducts = (d.products || []).filter(p => p.image);
    adsRenderMulti("");
  } catch (e) { grid.innerHTML = ""; $("adsMultiNote").className = "gen-note err"; $("adsMultiNote").textContent = "⚠️ " + e.message; }
}
function adsRenderMulti(q) {
  const grid = $("adsMultiGrid"); if (!grid) return;
  const list = (adsMultiProducts || []).filter(p => !q || (p.title || "").toLowerCase().includes((q || "").toLowerCase()));
  if (!list.length) { grid.innerHTML = '<p class="hint" style="grid-column:1/-1">Không có sản phẩm.</p>'; return; }
  grid.innerHTML = "";
  list.forEach(p => {
    const id = p.id || p.store_url || p.title;
    const on = adsMultiSel.has(id);
    const cell = document.createElement("div"); cell.className = "ads-style-cell";
    cell.style.outline = on ? "3px solid var(--violet)" : "";
    cell.innerHTML = '<img src="' + p.image + '" loading="lazy" alt="">' +
      (on ? '<span class="ads-style-badge" style="background:var(--violet)">✓</span>' : '') +
      '<span class="cover-tag" style="background:rgba(0,0,0,.6);max-width:92%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (p.title || "").replace(/</g, "&lt;").slice(0, 22) + '</span>';
    cell.querySelector("img").onclick = () => { if (adsMultiSel.has(id)) adsMultiSel.delete(id); else adsMultiSel.add(id); adsRenderMulti(q); updateMultiNote(); adsRenderSpInfo(); };
    grid.appendChild(cell);
  });
}
function updateMultiNote() {
  const cons = ADS_CONCEPTS.filter(c => adsSel.has(c.key)).length;
  const n = $("adsMultiNote"); if (n) { n.className = "gen-note"; n.textContent = "Đã chọn " + adsMultiSel.size + " SP × " + cons + " concept = " + (adsMultiSel.size * cons) + " ảnh."; }
  if (typeof adsUpdateRunBtn === "function") adsUpdateRunBtn();   // cập nhật nhãn nút chính
}

/* =====================================================================
   BẢNG BÀI ĐĂNG FANPAGE + INSTAGRAM (organic) — đưa bộ ảnh sang + đăng hàng loạt
   ===================================================================== */
let pgpostInited = false, pgpostPollTimer = null;
function pgpostInit() {
  if (!pgpostInited) {
    pgpostInited = true;
    $("pgpostPushBtn").onclick = pgpostBatchPush;
    $("pgpostAll").onchange = (e) => { document.querySelectorAll(".pgpost-tick").forEach(t => t.checked = e.target.checked); };
    pgpostCheckIg();
  }
  pgpostLoad();
}
async function pgpostCheckIg() {
  try {
    const d = await (await fetch("/api/ig-status")).json();
    const n = $("pgpostIgNote");
    if (d.connected && d.can_publish) { n.className = "gen-note ok"; n.textContent = "✓ Instagram sẵn sàng: @" + (d.username || d.ig_id); }
    else if (d.connected) { n.className = "gen-note"; n.innerHTML = "📷 IG đã nối <b>@" + (d.username || d.ig_id) + "</b> nhưng token thiếu quyền đăng — Facebook vẫn đăng được. (Thêm scope instagram_content_publish để bật IG.)"; }
    else { n.className = "gen-note"; n.textContent = "📷 Instagram chưa nối — Facebook vẫn đăng được."; }
  } catch (e) {}
}
const PGPOST_ST = { draft: ["⚪ Nháp", ""], posting: ["⏳ Đang đăng", ""], posted: ["✓ Đã đăng", "ok"], error: ["✗ Lỗi", "err"] };
async function pgpostLoad() {
  try {
    const d = await (await fetch("/api/pgpost-list")).json();
    const items = d.items || [];
    $("pgpostEmpty").classList.toggle("hidden", items.length > 0);
    pgpostRender(items);
    const p = d.pushing || {}, note = $("pgpostNote");
    if (p.running) {
      note.className = "gen-note"; note.innerHTML = "⏳ Đang đăng <b>" + p.done + "/" + p.total + "</b>" + (p.next_in ? " · bài kế trong <b>" + p.next_in + "s</b>" : "") + "…";
      if (!pgpostPollTimer) pgpostPollTimer = setInterval(pgpostLoad, 3000);
    } else {
      if (pgpostPollTimer) { clearInterval(pgpostPollTimer); pgpostPollTimer = null; }
      if ((p.log || []).length && p.total) { note.className = "gen-note ok"; note.innerHTML = "✓ Xong đợt đăng " + p.total + " bài.<br>" + p.log.map(l => '<span class="hint">' + l.slice(0, 70) + '</span>').join("<br>"); }
    }
  } catch (e) {}
}
// ==== PREVIEW BÀI ĐĂNG NHƯ THẬT: mô phỏng cách FB xếp album & IG crop carousel ====
let _pgPv = {};    // {id: "fb"|"ig"} chế độ preview từng bài
let _pgIgR = {};   // {id: "4/5"|"1/1"} tỉ lệ crop IG
function _pgImg(u) { return '<img src="' + gthumb(u) + '" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block">'; }
function pgFbGrid(urls) {
  const n = urls.length, c = (u, s) => '<div style="overflow:hidden;' + (s || "") + '">' + _pgImg(u) + '</div>';
  if (!n) return "";
  if (n === 1) return '<div style="aspect-ratio:4/5;overflow:hidden">' + _pgImg(urls[0]) + '</div>';
  if (n === 2) return '<div style="display:grid;grid-template-columns:1fr 1fr;gap:2px;aspect-ratio:2/1.02">' + c(urls[0]) + c(urls[1]) + '</div>';
  if (n === 3) return '<div style="display:grid;grid-template-columns:2fr 1fr;grid-template-rows:1fr 1fr;gap:2px;aspect-ratio:3/2">' + c(urls[0], "grid-row:1/3") + c(urls[1]) + c(urls[2]) + '</div>';
  if (n === 4) return '<div style="display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:2px;aspect-ratio:1/1.02">' + urls.slice(0, 4).map(u => c(u)).join("") + '</div>';
  const more = n - 5;
  return '<div style="display:grid;grid-template-columns:1fr 1fr;gap:2px;aspect-ratio:4/5">' + c(urls[0]) + c(urls[1]) + '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:2px;margin-top:2px;aspect-ratio:3/1">' + c(urls[2]) + c(urls[3]) +
    '<div style="position:relative;overflow:hidden">' + _pgImg(urls[4]) +
    (more > 0 ? '<span style="position:absolute;inset:0;background:rgba(0,0,0,.45);color:#fff;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700">+' + more + '</span>' : '') + '</div></div>';
}
function pgIgCarousel(urls, ratio) {
  return '<div style="display:flex;overflow-x:auto;gap:2px;scroll-snap-type:x mandatory">' +
    urls.map((u, i) => '<div style="flex:0 0 100%;aspect-ratio:' + ratio + ';overflow:hidden;position:relative;scroll-snap-align:start">' + _pgImg(u) +
      (urls.length > 1 ? '<span style="position:absolute;top:8px;right:8px;background:rgba(0,0,0,.55);color:#fff;font-size:11px;padding:2px 8px;border-radius:10px">' + (i + 1) + '/' + urls.length + '</span>' : '') +
      '</div>').join("") + '</div>' +
    (urls.length > 1 ? '<p class="hint" style="margin:3px 0 0;font-size:10px;text-align:center">← kéo ngang xem từng ảnh theo crop IG →</p>' : "");
}
function pgpostRender(items) {
  const box = $("pgpostList");
  if (!items.length) { box.innerHTML = ""; return; }
  box.innerHTML = "";
  box.style.cssText = "margin-top:10px;display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start";
  items.forEach(it => {
    const st = PGPOST_ST[it.status] || ["?", ""], res = it.result || {};
    const urls = it.image_urls || [];
    const pv = _pgPv[it.id] || "fb";
    const igr = _pgIgR[it.id] || "4/5";
    const resCell = it.status === "posted"
      ? Object.entries(res).map(([k, v]) => (String(v || "").startsWith("http") ? '<a href="' + v + '" target="_blank" style="color:var(--violet)">' + k + ' →</a>' : '<span style="color:#dc2626">' + k + ': ' + (v || "").slice(0, 30) + '</span>')).join(" · ")
      : '<span class="gen-note ' + st[1] + '" style="margin:0">' + st[0] + '</span>';
    const card = document.createElement("div");
    card.dataset.id = it.id;
    card.style.cssText = "width:340px;border:1px solid var(--line,#e3e3e3);border-radius:14px;overflow:hidden;background:var(--panel-2,rgba(127,127,127,.04))";
    card.innerHTML =
      // header giống bài đăng + toggle FB/IG
      '<div style="display:flex;align-items:center;gap:8px;padding:8px 10px">' +
        '<input type="checkbox" class="pgpost-tick" value="' + it.id + '" title="Chọn bài này để đăng">' +
        '<span style="width:30px;height:30px;border-radius:50%;background:var(--violet,#7c3aed);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px">R</span>' +
        '<div style="line-height:1.2"><b style="font-size:12.5px">rieng.vn</b><br><span class="hint" style="font-size:10px">' + (pv === "fb" ? "Bài Fanpage · vừa xong" : "Instagram · carousel") + '</span></div>' +
        '<span style="flex:1"></span>' +
        (it.source === "auto" ? '<span style="background:var(--violet);color:#fff;font-size:9px;padding:1px 5px;border-radius:6px">🤖 auto</span>' : '') +
        '<div style="display:flex;border:1px solid var(--line,#ccc);border-radius:8px;overflow:hidden">' +
          '<button class="pg-pv-fb" style="border:none;padding:3px 8px;font-size:11px;cursor:pointer;background:' + (pv === "fb" ? "var(--violet,#7c3aed)" : "transparent") + ';color:' + (pv === "fb" ? "#fff" : "inherit") + '">📘 FB</button>' +
          '<button class="pg-pv-ig" style="border:none;padding:3px 8px;font-size:11px;cursor:pointer;background:' + (pv === "ig" ? "var(--violet,#7c3aed)" : "transparent") + ';color:' + (pv === "ig" ? "#fff" : "inherit") + '">📷 IG</button>' +
        '</div>' +
      '</div>' +
      // vùng ảnh: FB album layout / IG carousel crop
      '<div class="pg-imgs">' + (pv === "fb" ? pgFbGrid(urls) : pgIgCarousel(urls, igr)) + '</div>' +
      (pv === "ig" ? '<div style="display:flex;gap:6px;align-items:center;padding:5px 10px 0"><span class="hint" style="font-size:10px">Tỉ lệ IG:</span>' +
        '<button class="pg-igr" data-r="4/5" style="font-size:10px;padding:2px 7px;border-radius:6px;border:1px solid var(--line,#ccc);cursor:pointer;background:' + (igr === "4/5" ? "var(--violet)" : "transparent") + ';color:' + (igr === "4/5" ? "#fff" : "inherit") + '">4:5 dọc</button>' +
        '<button class="pg-igr" data-r="1/1" style="font-size:10px;padding:2px 7px;border-radius:6px;border:1px solid var(--line,#ccc);cursor:pointer;background:' + (igr === "1/1" ? "var(--violet)" : "transparent") + ';color:' + (igr === "1/1" ? "#fff" : "inherit") + '">1:1 vuông</button>' +
        '<span class="hint" style="font-size:10px">' + urls.length + ' ảnh</span></div>' : '') +
      // dải SẮP XẾP ảnh: ◀▶ hoặc kéo-thả; ảnh 1 = ảnh bìa
      (urls.length > 1 ? '<div style="display:flex;gap:5px;overflow-x:auto;padding:6px 10px 0;align-items:flex-start">' +
        urls.map((u, i) => '<div style="flex:0 0 auto;text-align:center">' +
          '<div style="position:relative">' +
            '<img src="' + gthumb(u) + '" draggable="true" class="pg-th" data-i="' + i + '" loading="lazy" style="width:46px;height:56px;object-fit:cover;border-radius:6px;cursor:grab;border:' + (i === 0 ? '2px solid var(--violet,#7c3aed)' : '1px solid var(--line,#ddd)') + '">' +
            '<span style="position:absolute;top:1px;left:1px;background:rgba(0,0,0,.55);color:#fff;font-size:9px;padding:0 4px;border-radius:5px">' + (i + 1) + '</span>' +
          '</div>' +
          '<div style="display:flex;justify-content:center;gap:1px">' +
            '<button class="pg-mv" data-i="' + i + '" data-d="-1" title="Đẩy ảnh lên trước" style="border:none;background:none;cursor:pointer;font-size:11px;padding:0 3px' + (i === 0 ? ';visibility:hidden' : '') + '">◀</button>' +
            '<button class="pg-mv" data-i="' + i + '" data-d="1" title="Đẩy ảnh ra sau" style="border:none;background:none;cursor:pointer;font-size:11px;padding:0 3px' + (i === urls.length - 1 ? ';visibility:hidden' : '') + '">▶</button>' +
          '</div></div>').join("") +
        '</div><p class="hint" style="margin:2px 10px 0;font-size:10px">🔀 Kéo-thả hoặc ◀▶ để sắp xếp — ảnh 1 (viền tím) là ảnh bìa bài đăng.</p>' : '') +
      // caption + hành động
      '<div style="padding:8px 10px 10px">' +
        '<textarea class="input pgpost-cap" rows="3" style="width:100%;padding:6px 8px;font-size:12px" placeholder="Content bài đăng — bấm 🤖 để AI viết">' + (it.caption || "") + '</textarea>' +
        '<div style="display:flex;gap:6px;align-items:center;margin-top:5px;flex-wrap:wrap">' +
          '<button class="btn-ghost sm pgpost-ai" title="AI nhìn ảnh + link SP viết content">🤖 AI viết bài</button>' +
          '<span style="flex:1"></span>' + resCell +
          '<button class="btn-ghost sm pgpost-del">🗑️</button>' +
        '</div>' +
      '</div>';
    box.appendChild(card);
  });
  box.querySelectorAll("div[data-id]").forEach(tr => {
    const id = tr.dataset.id;
    // toggle preview FB / IG + tỉ lệ IG (chỉ đổi hiển thị, giữ tick đang chọn)
    const keepTick = () => tr.querySelector(".pgpost-tick").checked;
    tr.querySelector(".pg-pv-fb").onclick = () => { const t = keepTick(); _pgPv[id] = "fb"; pgpostRender(items); restoreTick(id, t); };
    tr.querySelector(".pg-pv-ig").onclick = () => { const t = keepTick(); _pgPv[id] = "ig"; pgpostRender(items); restoreTick(id, t); };
    tr.querySelectorAll(".pg-igr").forEach(b => { b.onclick = () => { const t = keepTick(); _pgIgR[id] = b.dataset.r; pgpostRender(items); restoreTick(id, t); }; });
    // 🔀 SẮP XẾP ảnh: ◀▶ hoặc kéo-thả -> lưu thứ tự mới lên server rồi vẽ lại preview
    const item = items.find(x => String(x.id) === String(id));
    const saveOrder = async (arr) => {
      const t = keepTick();
      if (item) item.image_urls = arr;
      try {
        await fetch("/api/pgpost-update", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: id, image_urls: arr }) });
      } catch (e) {}
      pgpostRender(items); restoreTick(id, t);
    };
    tr.querySelectorAll(".pg-mv").forEach(b => {
      b.onclick = () => {
        const arr = ((item && item.image_urls) || []).slice();
        const i = parseInt(b.dataset.i, 10), j = i + parseInt(b.dataset.d, 10);
        if (j < 0 || j >= arr.length) return;
        const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
        saveOrder(arr);
      };
    });
    let _dragI = null;
    tr.querySelectorAll(".pg-th").forEach(im => {
      im.ondragstart = () => { _dragI = parseInt(im.dataset.i, 10); };
      im.ondragover = (e) => e.preventDefault();
      im.ondrop = (e) => {
        e.preventDefault();
        const j = parseInt(im.dataset.i, 10);
        if (_dragI === null || _dragI === j) return;
        const arr = ((item && item.image_urls) || []).slice();
        const moved = arr.splice(_dragI, 1)[0];
        arr.splice(j, 0, moved);
        _dragI = null;
        saveOrder(arr);
      };
    });
    tr.querySelector(".pgpost-cap").onchange = (e) => fetch("/api/pgpost-update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: id, caption: e.target.value }) });
    tr.querySelector(".pgpost-ai").onclick = async (e) => {
      const btn = e.currentTarget, ta = tr.querySelector(".pgpost-cap");
      const item = items.find(x => String(x.id) === String(id));
      const img = (item && (item.image_urls || [])[0]) || "";
      if (!img) { alert("Bài này chưa có ảnh."); return; }
      btn.disabled = true; btn.textContent = "⏳ AI đang viết…";
      try {
        const r = await fetch("/api/product-content", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: img.startsWith("http") ? img : location.origin + img, info: "Áo thun in tên cá nhân hoá, thương hiệu rieng.vn" }) });
        const d = await r.json();
        let cap = (r.ok && (d.facebook || "").trim()) || "🔥 Áo thun in tên cá nhân hoá theo tên riêng — chất vải đẹp, in sắc nét.\n👉 Đặt ngay tại rieng.vn!";
        const lk = (item && item.product) || "";
        if (lk && !cap.includes(lk)) cap += "\n\n🛒 MUA NGAY: " + lk;
        ta.value = cap; if (item) item.caption = cap;
        await fetch("/api/pgpost-update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: id, caption: cap }) });
        btn.textContent = "✓ Xong"; setTimeout(() => { btn.disabled = false; btn.textContent = "🤖 AI viết bài"; }, 1200);
      } catch (err) { alert("✗ " + err.message); btn.disabled = false; btn.textContent = "🤖 AI viết bài"; }
    };
    tr.querySelector(".pgpost-del").onclick = async () => { if (!confirm("Xoá bài này?")) return; await fetch("/api/pgpost-del", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: id }) }); pgpostLoad(); };
  });
}
function restoreTick(id, val) {
  const cb = document.querySelector('#pgpostList div[data-id="' + id + '"] .pgpost-tick');
  if (cb) cb.checked = val;
}
async function pgpostBatchPush() {
  const ids = [...document.querySelectorAll(".pgpost-tick:checked")].map(t => t.value);
  if (!ids.length) { const n = $("pgpostNote"); n.className = "gen-note err"; n.textContent = "✗ Chưa tick bài nào."; return; }
  const chans = []; if ($("pgpostFb").checked) chans.push("fb"); if ($("pgpostIg").checked) chans.push("ig");
  if (!chans.length) { const n = $("pgpostNote"); n.className = "gen-note err"; n.textContent = "✗ Chọn ít nhất 1 kênh (FB/IG)."; return; }
  const gap = parseInt($("pgpostGap").value) || 45;
  const ch = chans.map(c => c === "fb" ? "Facebook" : "Instagram").join(" + ");
  if (!confirm("Đăng CÔNG KHAI " + ids.length + " bài lên " + ch + " ngay, giãn cách " + gap + "s/bài. Chắc chứ?")) return;
  const btn = $("pgpostPushBtn"); btn.disabled = true;
  try {
    const r = await fetch("/api/pgpost-push-batch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: ids, channels: chans, gap: gap }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Lỗi");
    const n = $("pgpostNote"); n.className = "gen-note"; n.textContent = "⏳ Bắt đầu đăng " + ids.length + " bài lên " + ch + "…";
    pgpostLoad();
  } catch (e) { const n = $("pgpostNote"); n.className = "gen-note err"; n.textContent = "✗ " + e.message; }
  finally { btn.disabled = false; }
}

/* =====================================================================
   DESIGN TÊN CÁ NHÂN HOÁ — Custom-name T-shirt niche
   ===================================================================== */
let namedesInited = false, ndItems = [];
async function namedesInit() {
  if (!namedesInited) {
    namedesInited = true;
    $("ndSuggest").onclick = namedesSuggest;
    $("ndRun").onclick = namedesGenerate;
    if (!$("ndName").value) namedesSuggest();   // gợi ý sẵn 1 tên
  }
  namedesRender();
}
async function namedesSuggest() {
  try {
    const d = await (await fetch("/api/name-suggest")).json();
    $("ndName").value = d.name || ""; if ($("ndStamp")) $("ndStamp").value = d.stamp || "";
  } catch (e) {}
}
async function namedesGenerate() {
  const note = $("ndNote"); note.className = "gen-note"; note.textContent = "";
  const name = ($("ndName").value || "").trim();
  if (!name) { note.className = "gen-note err"; note.textContent = "⚠️ Nhập tên (hoặc bấm 🎲 Gợi ý)."; return; }
  const body = { name: name, stamp: ($("ndStamp") && $("ndStamp").value || "").trim(), style: "auto", n: +$("ndN").value, transparent: $("ndTransparent").checked };
  $("ndRun").disabled = true;
  try {
    const r = await fetch("/api/name-design", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Lỗi");
    $("ndProgress").classList.remove("hidden"); $("ndBar").style.width = "0%"; $("ndProgText").textContent = "Đang tạo 0/" + d.total;
    note.className = "gen-note ok"; note.textContent = "⏳ Đang vẽ " + d.total + " design tên…";
    namedesPoll(d.job_id);
  } catch (e) { note.className = "gen-note err"; note.textContent = "✗ " + e.message; }
  finally { $("ndRun").disabled = false; }
}
function namedesPoll(job) {
  let placed = 0;
  const t = setInterval(async () => {
    try {
      const d = await (await fetch("/api/batch-status?id=" + encodeURIComponent(job))).json();
      const pct = d.total ? Math.round((d.done / d.total) * 100) : 0;
      $("ndBar").style.width = pct + "%"; $("ndProgText").textContent = "Đã xong " + d.done + "/" + d.total;
      const items = d.items || [];
      while (placed < items.length) { ndItems.unshift(items[placed]); placed++; namedesRender(); }
      if (d.finished) {
        clearInterval(t); $("ndProgress").classList.add("hidden");
        const note = $("ndNote");
        if ((d.errors || []).length && !items.length) { note.className = "gen-note err"; note.textContent = "✗ " + d.errors[0]; }
        else { note.className = "gen-note ok"; note.textContent = "✓ Xong " + items.length + " design." + ((d.errors || []).length ? " (" + d.errors.length + " lỗi)" : ""); }
        if (typeof loadGallery === "function") loadGallery();
      }
    } catch (e) {}
  }, 2500);
}
function namedesRender() {
  const grid = $("ndResults"); if (!grid) return;
  $("ndCount").textContent = ndItems.length ? "(" + ndItems.length + ")" : "";
  $("ndEmpty").classList.toggle("hidden", ndItems.length > 0);
  grid.innerHTML = "";
  ndItems.forEach(c => {
    const src = c.image ? "data:image/png;base64," + c.image : (c.gallery && c.gallery.url);
    const card = document.createElement("div"); card.className = "fp-card";
    card.innerHTML =
      '<div class="fp-card-prompt">' + (c.title || "Design") + '</div>' +
      '<div class="fp-card-img"><img src="' + src + '" loading="lazy" alt=""></div>' +
      '<div class="fp-card-acts"><button class="b-use">👕 Dùng / Lên áo</button><button class="b-zoom">🔍</button><button class="b-copy">📋 Copy</button><button class="b-dl">⬇ Tải</button></div>';
    card.querySelector(".fp-card-img img").onclick = () => openZoom(src);
    card.querySelector(".b-zoom").onclick = () => openZoom(src);
    card.querySelector(".b-copy").onclick = (e) => copyImageToClipboard(src, e.currentTarget);
    card.querySelector(".b-dl").onclick = () => { if (c.image) autoDownload(c.image, "design-ten"); };
    card.querySelector(".b-use").onclick = () => {
      showApp("clone");
      if (typeof showDesign === "function" && c.image) showDesign(c.image);
      const rt = document.querySelector('.rtab[data-rtab="design"]'); if (rt) rt.click();
    };
    grid.appendChild(card);
  });
}

/* =====================================================================
   TÁCH NỀN — xoá nền ảnh bằng AI (rembg)
   ===================================================================== */
let cutoutInited = false, cutInputs = [], cutItems = [];
function cutoutInit() {
  if (!cutoutInited) {
    cutoutInited = true;
    const drop = $("cutDrop"), file = $("cutFile");
    file.onchange = (e) => { addCutFiles(e.target.files); e.target.value = ""; };
    drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("drag"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
    drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("drag"); addCutFiles(e.dataTransfer.files); });
    $("cutRun").onclick = cutoutRun;
    // 📋 Dán (nút riêng hiện thumbnail ngay); chuột phải do universal paste lo
    if ($("cutPaste")) $("cutPaste").onclick = async () => { const durl = await clipboardImageDataURL(); if (durl) { cutInputs.push(durl); cutRenderThumbs(); toast("✓ Đã dán ảnh"); } else toast("Clipboard chưa có ảnh — copy 1 ảnh rồi thử lại.", false); };
    if ($("cutManualBtn")) $("cutManualBtn").onclick = async () => {
      let src = cutInputs[cutInputs.length - 1];
      if (!src && cutItems[0]) src = "data:image/png;base64," + await cutB64(cutItems[0]);
      if (!src) { const n = $("cutNote"); n.className = "gen-note err"; n.textContent = "⚠️ Tải/dán 1 ảnh trước đã."; return; }
      cutOpenManual(src, -1);   // -1 = thêm mới vào kết quả
    };
    cutManualWire();
    cutLoadHistory();   // nạp lại kết quả tách nền cũ (lưu trong gallery)
  }
  cutRenderThumbs();
  cutoutRender();
}
// lấy b64 cho 1 kết quả (đã có sẵn, hoặc tải từ url gallery)
async function cutB64(c) {
  if (c.image) return c.image;
  const b = await (await fetch(c.url)).blob();
  c.image = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(",")[1]); fr.readAsDataURL(b); });
  return c.image;
}
// nạp các kết quả tách nền đã lưu (mode "cutout") -> hiện lại
async function cutLoadHistory() {
  try {
    const d = await (await fetch("/api/gallery")).json();
    const hist = (d.items || []).filter(it => it.mode === "cutout")
      .map(it => ({ url: it.url, id: it.id }));
    // chỉ thêm bản chưa có (theo id) -> giữ kết quả phiên hiện tại lên trước
    const haveIds = new Set(cutItems.map(c => c.id).filter(Boolean));
    hist.forEach(h => { if (!haveIds.has(h.id)) cutItems.push(h); });
    cutoutRender();
  } catch (e) {}
}
function cutRenderThumbs() {
  const box = $("cutThumbs"); if (box) {
    box.innerHTML = cutInputs.map((d, i) =>
      '<div class="thumb"><img src="' + d + '" alt=""><button class="thumb-x" data-i="' + i + '">×</button></div>'
    ).join("");
    box.querySelectorAll(".thumb-x").forEach(b => b.onclick = () => { cutInputs.splice(+b.dataset.i, 1); cutRenderThumbs(); });
  }
  const n = $("cutNote"); if (n) { n.className = "gen-note"; n.textContent = cutInputs.length ? ("📎 Đã thêm " + cutInputs.length + " ảnh — bấm Tách nền.") : ""; }
}
async function addCutFiles(files) {
  for (const f of files) { if (f && f.type.startsWith("image/")) cutInputs.push(await fileToDataURL(f)); }
  cutRenderThumbs();
}
// dán ảnh khi đang ở tab Tách nền (router paste của app gọi addCutFiles nếu có)
window.cutoutPaste = (durl) => { if (durl) { cutInputs.push(durl); cutRenderThumbs(); } };
async function cutoutRun() {
  const note = $("cutNote");
  if (!cutInputs.length) { note.className = "gen-note err"; note.textContent = "⚠️ Tải/dán ít nhất 1 ảnh."; return; }
  const method = "flat", matting = false;   // 1 kiểu duy nhất: tách nền phẳng (mép sạch)
  const batch = cutInputs.slice(); cutInputs = []; cutRenderThumbs();   // nhả ngay -> up ảnh mới chạy tiếp được
  note.className = "gen-note"; note.textContent = "⏳ Đang tách nền " + batch.length + " ảnh (song song)…";
  // chạy SONG SONG, mỗi ảnh 1 ô loading riêng
  await Promise.all(batch.map(async (img, i) => {
    const tid = loadTaskAdd("✂️ Tách nền ảnh " + (i + 1) + "…");
    try {
      const r = await fetch("/api/remove-bg", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: img, method: method, matting: matting }) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error || "Lỗi");
      cutItems.unshift({ image: d.image, url: (d.gallery || {}).url, id: (d.gallery || {}).id }); cutoutRender();
      loadTaskDone(tid, true, "✓ Tách nền ảnh " + (i + 1));
    } catch (e) { loadTaskDone(tid, false, "✕ Ảnh " + (i + 1) + ": " + e.message); }
  }));
  note.className = "gen-note ok"; note.textContent = "✓ Hoàn tất.";
}
function cutoutRender() {
  const grid = $("cutResults"); if (!grid) return;
  $("cutCount").textContent = cutItems.length ? "(" + cutItems.length + ")" : "";
  $("cutEmpty").classList.toggle("hidden", cutItems.length > 0);
  grid.innerHTML = "";
  cutItems.forEach((c, idx) => {
    const src = c.image ? ("data:image/png;base64," + c.image) : c.url;
    const card = document.createElement("div"); card.className = "fp-card";
    card.innerHTML =
      '<div class="fp-card-img" style="background:linear-gradient(45deg,#eee 25%,transparent 25%),linear-gradient(-45deg,#eee 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#eee 75%),linear-gradient(-45deg,transparent 75%,#eee 75%);background-size:20px 20px;background-position:0 0,0 10px,10px -10px,-10px 0;background-color:#fff"><img src="' + src + '" loading="lazy" alt=""></div>' +
      '<div class="fp-card-acts"><button class="b-edit">🖱️ Sửa</button><button class="b-shirt">👕 Lên áo</button><button class="b-recolor">🎨 Đổi màu</button><button class="b-copy">📋 Copy</button><button class="b-dl">⬇ Tải</button><button class="b-del">🗑️</button></div>' +
      '<div class="cut-recolor-bar" style="display:none;flex-wrap:wrap;gap:5px;padding:6px 8px;border-top:1px solid var(--line)"></div>';
    card.querySelector(".fp-card-img img").onclick = () => openZoom(src);
    card.querySelector(".b-edit").onclick = async (e) => { const b = e.currentTarget; b.disabled = true; cutOpenManual(await cutB64(c), idx); b.disabled = false; };
    card.querySelector(".b-shirt").onclick = async (e) => { const b = e.currentTarget; b.disabled = true; await cutToShirt(await cutB64(c)); b.disabled = false; };
    card.querySelector(".b-copy").onclick = (e) => copyImageToClipboard(src, e.currentTarget);
    card.querySelector(".b-dl").onclick = async () => autoDownload(await cutB64(c), "tach-nen");
    card.querySelector(".b-del").onclick = () => { if (c.id) fetch("/api/gallery?id=" + encodeURIComponent(c.id), { method: "DELETE" }).catch(() => {}); cutItems.splice(idx, 1); cutoutRender(); };
    // đổi màu theo nền áo (AI) — hiện bảng màu inline
    const bar = card.querySelector(".cut-recolor-bar");
    RECOLOR_LIST.forEach(col => {
      const chip = document.createElement("button");
      chip.className = "btn-ghost sm";
      chip.style.cssText = "display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:3px 7px";
      chip.innerHTML = '<span style="width:13px;height:13px;border-radius:3px;border:1px solid #0002;background:' + col.sw + '"></span>' + col.vi;
      chip.onclick = () => cutDoRecolor(idx, col.key, col.vi);
      bar.appendChild(chip);
    });
    card.querySelector(".b-recolor").onclick = () => { bar.style.display = bar.style.display === "none" ? "flex" : "none"; };
    grid.appendChild(card);
  });
}

// đưa ảnh đã tách nền sang tab Lên áo (áp lên tất cả áo)
async function cutToShirt(b64) {
  const durl = String(b64).startsWith("data:") ? b64 : ("data:image/png;base64," + b64);
  showApp("lenao");
  await lenaoInit();
  // chờ danh sách áo nạp xong (fetch mockups async) trước khi áp design
  for (let i = 0; i < 50 && (typeof lenaoSlots === "undefined" || !lenaoSlots.length); i++) {
    await new Promise(r => setTimeout(r, 100));
  }
  if (typeof lenaoApplyAll === "function") await lenaoApplyAll(durl);
}

// AI đổi màu design hợp nền áo -> sinh 4 BẢN KHÁC NHAU (4 luồng song song) để chọn
const CUT_RECOLOR_VARIANTS = [
  "Variation 1: minimal, high-contrast palette, clean and bold.",
  "Variation 2: add one or two tasteful bright accent colours that pop.",
  "Variation 3: muted, premium, sophisticated tones.",
  "Variation 4: bright, vibrant, energetic tones.",
  "Variation 5: monochrome / tone-on-tone elegant look.",
  "Variation 6: warm-vs-cool duotone contrast.",
];
// trả về n chỉ thị hướng phối khác nhau (lặp lại + đánh số nếu n > danh sách)
function recolorVariantNotes(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const base = CUT_RECOLOR_VARIANTS[i % CUT_RECOLOR_VARIANTS.length];
    out.push(i < CUT_RECOLOR_VARIANTS.length ? base : (base + " (alt take " + (i + 1) + ")"));
  }
  return out;
}
async function cutDoRecolor(idx, colorKey, colorVi) {
  const c = cutItems[idx]; if (!c) return;
  const snap = await cutB64(c);   // chốt ảnh nguồn (idx đổi khi unshift bản mới)
  const cc = $("cutRecolorCount");
  const N = Math.max(1, Math.min(parseInt(cc && cc.value, 10) || 4, 6));   // số bản chọn được
  const VNOTES = recolorVariantNotes(N);
  for (let k = 0; k < N; k++) {
    (async (vi) => {
      const tid = loadTaskAdd("🎨 " + colorVi + " — bản " + (vi + 1) + "/" + N + "…");
      try {
        const r = await fetch("/api/recolor", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: "data:image/png;base64," + snap, colors: [colorKey], size: "portrait", note: VNOTES[vi] }),
        });
        const d = await r.json(); if (!r.ok) throw new Error(d.error || "Lỗi");
        const it = (d.items || [])[0];
        if (!it || !it.image) throw new Error("AI không trả kết quả.");
        cutItems.unshift({ image: it.image }); cutoutRender();
        loadTaskDone(tid, true, "✓ " + colorVi + " bản " + (vi + 1));
      } catch (e) {
        loadTaskDone(tid, false, "✕ Bản " + (vi + 1) + ": " + e.message);
      }
    })(k);
  }
  const note = $("cutNote");
  if (note) { note.className = "gen-note"; note.textContent = "🎨 Đang tạo 4 bản đổi màu hợp áo " + colorVi + " (song song) — giữ bản đẹp nhất, xoá bản khác."; }
}

/* ---- Tách nền THỦ CÔNG (magic wand, client-side) ---- */
let cutBase = null, cutUndo = [], cutEditIdx = -1, cutManualWired = false;
let cutScale = 1, cutFitW = 0, cutDoneHandler = null;
function cutApplyZoom(s) {
  cutScale = Math.max(0.4, Math.min(s, 6));
  const cv = $("cutCanvas"); if (!cv) return;
  if (!cutFitW) cutFitW = cv.clientWidth || cv.width;
  if (Math.abs(cutScale - 1) < 0.01) {
    cutScale = 1; cv.style.maxWidth = "100%"; cv.style.width = "";
  } else {
    cv.style.maxWidth = "none"; cv.style.width = Math.round(cutFitW * cutScale) + "px";
  }
  if ($("cutZoomVal")) $("cutZoomVal").textContent = Math.round(cutScale * 100) + "%";
}
function cutManualWire() {
  if (cutManualWired) return; cutManualWired = true;
  const close = () => $("cutManualModal").classList.add("hidden");
  $("cutManualClose").onclick = close;
  $("cutManualModal").onclick = close;
  $("cutTol").oninput = (e) => { $("cutTolVal").textContent = e.target.value; };
  $("cutUndo").onclick = () => {
    const cv = $("cutCanvas"), ctx = cv.getContext("2d");
    if (cutUndo.length) { ctx.putImageData(cutUndo.pop(), 0, 0); }
  };
  $("cutResetBtn").onclick = () => {
    const cv = $("cutCanvas"), ctx = cv.getContext("2d");
    if (cutBase) { ctx.putImageData(cutBase, 0, 0); cutUndo = []; }
  };
  $("cutManualDone").onclick = () => {
    const cv = $("cutCanvas");
    const b64 = cv.toDataURL("image/png").split(",")[1];
    if (cutDoneHandler) { const h = cutDoneHandler; cutDoneHandler = null; close(); h(b64); return; }
    if (cutEditIdx >= 0 && cutItems[cutEditIdx]) cutItems[cutEditIdx].image = b64;
    else cutItems.unshift({ image: b64 });
    cutoutRender(); close();
  };
  // ---- Zoom design trong editor ----
  if ($("cutZoomIn")) $("cutZoomIn").onclick = () => cutApplyZoom(cutScale * 1.25);
  if ($("cutZoomOut")) $("cutZoomOut").onclick = () => cutApplyZoom(cutScale / 1.25);
  if ($("cutZoomReset")) $("cutZoomReset").onclick = () => cutApplyZoom(1);
  const cv = $("cutCanvas");
  const xy = (e) => { const r = cv.getBoundingClientRect(); return { x: Math.round((e.clientX - r.left) * cv.width / r.width), y: Math.round((e.clientY - r.top) * cv.height / r.height) }; };
  const pushUndo = (ctx) => { cutUndo.push(ctx.getImageData(0, 0, cv.width, cv.height)); if (cutUndo.length > 25) cutUndo.shift(); };
  let dragStart = null, dragSnap = null;
  cv.onmousedown = (e) => {
    if (!$("cutRect").checked) return;
    const ctx = cv.getContext("2d");
    dragStart = xy(e); dragSnap = ctx.getImageData(0, 0, cv.width, cv.height);
  };
  cv.onmousemove = (e) => {
    if (!dragStart) return;
    const ctx = cv.getContext("2d"); ctx.putImageData(dragSnap, 0, 0);
    const p = xy(e);
    ctx.strokeStyle = "#9a2a3a"; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
    ctx.strokeRect(dragStart.x, dragStart.y, p.x - dragStart.x, p.y - dragStart.y); ctx.setLineDash([]);
  };
  const endDrag = (e) => {
    if (!dragStart) return;
    const ctx = cv.getContext("2d"); ctx.putImageData(dragSnap, 0, 0);
    pushUndo(ctx);
    const p = xy(e), im = ctx.getImageData(0, 0, cv.width, cv.height), d = im.data;
    const x0 = Math.max(0, Math.min(dragStart.x, p.x)), x1 = Math.min(cv.width, Math.max(dragStart.x, p.x));
    const y0 = Math.max(0, Math.min(dragStart.y, p.y)), y1 = Math.min(cv.height, Math.max(dragStart.y, p.y));
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) d[(yy * cv.width + xx) * 4 + 3] = 0;
    ctx.putImageData(im, 0, 0); dragStart = null; dragSnap = null;
  };
  cv.onmouseup = endDrag;
  cv.onmouseleave = endDrag;
  cv.onclick = (e) => {
    if ($("cutRect").checked) return;
    const ctx = cv.getContext("2d"); const p = xy(e);
    if (p.x < 0 || p.y < 0 || p.x >= cv.width || p.y >= cv.height) return;
    pushUndo(ctx);
    cutMagicErase(cv, ctx, p.x, p.y, +$("cutTol").value, $("cutGlobal").checked);
  };
}
function cutOpenManual(srcB64, idx, onDone) {
  cutManualWire();   // đảm bảo nút modal đã gắn (mở được từ tab Tạo design)
  cutEditIdx = (typeof idx === "number") ? idx : -1;
  cutDoneHandler = (typeof onDone === "function") ? onDone : null;
  const img = new Image();
  img.onload = () => {
    const cv = $("cutCanvas"), ctx = cv.getContext("2d");
    let w = img.width, h = img.height, max = 1100;
    if (Math.max(w, h) > max) { const s = max / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
    cv.width = w; cv.height = h;
    ctx.clearRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h);
    cutBase = ctx.getImageData(0, 0, w, h); cutUndo = [];
    // reset zoom về vừa khung
    cutScale = 1; cutFitW = 0;
    cv.style.maxWidth = "100%"; cv.style.width = "";
    if ($("cutZoomVal")) $("cutZoomVal").textContent = "100%";
    $("cutManualModal").classList.remove("hidden");
    setTimeout(() => { cutFitW = cv.clientWidth || w; }, 50);
  };
  img.src = String(srcB64).startsWith("data:") ? srcB64 : ("data:image/png;base64," + srcB64);
}
// xoá pixel cùng màu: global = mọi nơi; else flood-fill vùng liền kề
function cutMagicErase(cv, ctx, x, y, tolerance, global) {
  const w = cv.width, h = cv.height, im = ctx.getImageData(0, 0, w, h), d = im.data;
  const i0 = (y * w + x) * 4, tr = d[i0], tg = d[i0 + 1], tb = d[i0 + 2];
  if (d[i0 + 3] === 0) return;
  const tol = tolerance * tolerance * 3;
  const close = (i) => { const dr = d[i] - tr, dg = d[i + 1] - tg, db = d[i + 2] - tb; return dr * dr + dg * dg + db * db <= tol; };
  if (global) {
    for (let i = 0; i < d.length; i += 4) { if (d[i + 3] !== 0 && close(i)) d[i + 3] = 0; }
  } else {
    const stack = [y * w + x], seen = new Uint8Array(w * h);
    while (stack.length) {
      const p = stack.pop();
      if (seen[p]) continue; seen[p] = 1;
      const i = p * 4;
      if (d[i + 3] === 0 || !close(i)) continue;
      d[i + 3] = 0;
      const px = p % w, py = (p - px) / w;
      if (px + 1 < w) stack.push(p + 1);
      if (px - 1 >= 0) stack.push(p - 1);
      if (py + 1 < h) stack.push(p + w);
      if (py - 1 >= 0) stack.push(p - w);
    }
  }
  ctx.putImageData(im, 0, 0);
}

/* =====================================================================
   TRỢ LÝ AI — chọn SP + lệnh -> Claude lập kế hoạch -> duyệt -> chạy
   ===================================================================== */
let agentInited = false, agentSteps = [], agentTimer = null, agentProduct = null;
let agentHistory = [], agentPendingPlan = null, agentGreeted = false, agentPendingImg = null;

function agentRenderImgPrev() {
  const box = $("agentImgPrev"); if (!box) return;
  box.innerHTML = agentPendingImg ? '<div class="thumb"><img src="' + agentPendingImg + '" alt=""><button class="thumb-x">×</button></div>' : "";
  const x = box.querySelector(".thumb-x"); if (x) x.onclick = () => { agentPendingImg = null; agentRenderImgPrev(); };
}
function agentInit() {
  if (!agentInited) {
    agentInited = true;
    $("agentPlanBtn").onclick = agentSend;
    $("agentCmd").addEventListener("keydown", e => {
      // bỏ qua Enter khi đang gõ tiếng Việt (IME composing) -> tránh gửi trùng
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); agentSend(); }
    });
    if ($("agentImgBtn")) $("agentImgBtn").onclick = () => $("agentImgFile").click();
    if ($("agentImgFile")) $("agentImgFile").onchange = async (e) => { const f = e.target.files[0]; if (f && f.type.startsWith("image/")) { agentPendingImg = await fileToDataURL(f); agentRenderImgPrev(); } e.target.value = ""; };
    if ($("agentImgBtn")) attachContextPaste($("agentImgBtn"), async (durl) => { agentPendingImg = durl; agentRenderImgPrev(); });
    document.querySelectorAll(".agent-eg").forEach(s => s.onclick = () => { $("agentCmd").value = s.textContent.trim(); $("agentCmd").focus(); });
    if (!agentGreeted) {
      agentGreeted = true;
      agentBubble("ai", "Chào bạn! 👋 Mình là Trợ lý AI của rieng.vn.<br>• Cần <b>hỏi / phân tích / lời khuyên</b> → cứ nhắn, mình trả lời ngay.<br>• Muốn mình <b>làm việc</b> (design, ads, đăng bài, scale...) → mình lên kế hoạch, bạn bấm <b>Duyệt</b> hoặc gõ <b>“chạy đi”</b>.", true);
    }
    // product picker
    agentLoadProducts();
    const srch = $("agentSpSearch");
    if (srch) srch.oninput = () => agentFilterSp(srch.value);
    if ($("agentSpClear")) $("agentSpClear").onclick = () => agentSelectProduct(null);
  }
}

let _agentAllSp = [];
async function agentLoadProducts() {
  try {
    const d = await (await fetch("/api/shopify-products?limit=60")).json();
    _agentAllSp = (d.products || []).map(p => ({
      id: p.id, name: p.title || p.name || "",
      price: (p.variants && p.variants[0] ? p.variants[0].price : p.price) || "",
      handle: p.handle || "",
      link: p.handle ? "https://rieng.vn/products/" + p.handle : "https://rieng.vn",
      img: (p.images && p.images[0] ? p.images[0].src : "") || ""
    }));
    agentFilterSp("");
  } catch (e) {
    const el = $("agentSpList");
    if (el) el.innerHTML = '<p class="hint" style="font-size:11px">Chưa kết nối Shopify.</p>';
  }
}
function agentFilterSp(q) {
  const el = $("agentSpList"); if (!el) return;
  const items = q ? _agentAllSp.filter(p => p.name.toLowerCase().includes(q.toLowerCase())) : _agentAllSp;
  if (!items.length) { el.innerHTML = '<p class="hint" style="font-size:11px">Không tìm thấy.</p>'; return; }
  el.innerHTML = items.slice(0, 40).map(p =>
    '<div class="agent-sp-item" data-id="' + p.id + '" style="display:flex;align-items:center;gap:6px;padding:5px 6px;border-radius:8px;cursor:pointer;border:1px solid transparent;font-size:12px">' +
    (p.img ? '<img src="' + p.img + '" style="width:30px;height:30px;object-fit:cover;border-radius:4px">' : '<div style="width:30px;height:30px;background:var(--bg2);border-radius:4px"></div>') +
    '<div><div style="font-weight:600;line-height:1.2">' + (p.name.length > 30 ? p.name.slice(0, 30) + '…' : p.name) + '</div>' +
    (p.price ? '<div style="color:var(--text2)">' + Number(p.price).toLocaleString("vi") + '₫</div>' : '') + '</div></div>'
  ).join("");
  el.querySelectorAll(".agent-sp-item").forEach(row => {
    row.onmouseenter = () => row.style.background = "var(--bg2)";
    row.onmouseleave = () => { if (!row.classList.contains("selected")) row.style.background = ""; };
    row.onclick = () => {
      const found = _agentAllSp.find(p => String(p.id) === row.dataset.id);
      agentSelectProduct(found || null);
    };
  });
  agentHighlightSp();
}
function agentSelectProduct(p) {
  agentProduct = p;
  const sel = $("agentSpSelected"), nm = $("agentSpName"), pr = $("agentSpPrice");
  if (p) {
    sel.style.display = ""; nm.textContent = p.name; pr.textContent = Number(p.price).toLocaleString("vi") + "₫" + (p.link ? " · " + p.link : "");
  } else {
    sel.style.display = "none"; nm.textContent = ""; pr.textContent = "";
  }
  agentHighlightSp();
}
function agentHighlightSp() {
  document.querySelectorAll(".agent-sp-item").forEach(row => {
    const active = agentProduct && String(agentProduct.id) === row.dataset.id;
    row.style.border = active ? "1px solid var(--accent)" : "1px solid transparent";
    row.style.background = active ? "var(--bg2)" : "";
    row.classList.toggle("selected", !!active);
  });
}

/* ---- chat bubble helpers ---- */
function agentEsc(t) { const d = document.createElement("div"); d.textContent = t || ""; return d.innerHTML; }
function agentBubble(who, html, raw) {
  const wrap = $("agentChat"); if (!wrap) return null;
  const mine = who === "me";
  const b = document.createElement("div");
  b.style.cssText = "max-width:88%;padding:9px 12px;border-radius:14px;font-size:13px;line-height:1.55;white-space:pre-wrap;word-break:break-word;" +
    (mine ? "align-self:flex-end;background:var(--accent);color:#fff;border-bottom-right-radius:4px"
          : "align-self:flex-start;background:var(--bg2);border:1px solid var(--line);border-bottom-left-radius:4px");
  b.innerHTML = raw ? (html || "") : agentEsc(html);
  wrap.appendChild(b);
  wrap.scrollTop = wrap.scrollHeight;
  return b;
}
const RUN_RE = /^(ch[aạ]y|ch[aạ]y\s*đi|l[aà]m\s*đi|l[aà]m\s*lu[oô]n|ok\s*ch[aạ]y|duy[eệ]t|th[uự]c\s*thi|đ[oồ]ng\s*ý\s*ch[aạ]y|go|run)\b/i;

let agentSending = false;
async function agentSend() {
  if (agentSending) return;   // đang gửi -> bỏ qua lần gọi trùng (Enter+click / IME)
  const inp = $("agentCmd"), msg = (inp.value || "").trim();
  const img = agentPendingImg;
  if (!msg && !img) return;
  agentSending = true;
  inp.value = "";
  // bong bóng người dùng: ảnh (nếu có) + chữ
  agentBubble("me", (img ? '<img src="' + img + '" style="max-width:160px;border-radius:8px;display:block;margin-bottom:' + (msg ? "6px" : "0") + '">' : "") + agentEsc(msg), true);
  agentHistory.push({ role: "user", text: (img ? "[gửi 1 ảnh] " : "") + msg });
  agentPendingImg = null; agentRenderImgPrev();

  // "chạy đi" + đang có kế hoạch chờ → chạy luôn (chỉ khi không kèm ảnh)
  if (!img && agentPendingPlan && RUN_RE.test(msg)) { agentSending = false; return agentExecute(agentPendingPlan); }

  const thinking = agentBubble("ai", img ? "👀 Đang xem ảnh…" : "💭 Đang xử lý…");
  try {
    const body = { message: msg, history: agentHistory.slice(0, -1) };
    if (img) body.image = img;
    if (agentProduct) body.product = agentProduct;
    const d = await (await fetch("/api/agent-chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
    if (thinking) thinking.remove();
    if (d.error) { agentBubble("ai", "⚠️ " + d.error); return; }
    const badge = $("agentPlannerBadge"); if (badge && d.planner) badge.textContent = "🤖 " + d.planner;

    if (d.mode === "plan") {
      agentPendingPlan = d.steps;
      agentRenderPlan(d.summary, d.steps);
      agentHistory.push({ role: "ai", text: "[Đã lập kế hoạch: " + (d.summary || "") + "]" });
    } else {
      const txt = d.text || "Mình chưa rõ, bạn nói lại nhé.";
      agentBubble("ai", agentEsc(txt), true);
      agentHistory.push({ role: "ai", text: txt });
    }
  } catch (e) { if (thinking) thinking.remove(); agentBubble("ai", "⚠️ Lỗi: " + e.message); }
  finally { agentSending = false; }
}

function agentRenderPlan(summary, steps) {
  const icons = { gen_design:"🎨", gen_ads:"📣", push_fb_ads:"🚀", gen_fbpost:"📸", post_fbig:"📤", analyze_fb:"📊", scale_ads:"📈", ads_optimize:"⚙️", write_content:"✍️" };
  let h = '<div style="font-weight:600;margin-bottom:6px">📋 ' + agentEsc(summary || "Kế hoạch") + '</div>';
  if (agentProduct) h += '<div style="font-size:11px;color:var(--accent);margin-bottom:6px">📦 ' + agentEsc(agentProduct.name) + '</div>';
  steps.forEach((s, i) => {
    h += '<div style="padding:3px 0;display:flex;align-items:center;gap:6px">' +
         '<span style="width:20px">' + (icons[s.action] || "▶") + '</span>' +
         '<span>' + (i + 1) + '. <b>' + agentEsc(s.label || s.action) + '</b></span></div>';
  });
  h += '<div style="display:flex;gap:8px;margin-top:8px">' +
       '<button class="btn-primary sm agent-run-btn">✓ Duyệt &amp; chạy</button>' +
       '<button class="btn-ghost sm agent-cancel-btn">✕ Huỷ</button></div>' +
       '<div style="font-size:11px;color:var(--text2);margin-top:5px">Hoặc gõ <b>"chạy đi"</b> để chạy.</div>';
  const b = agentBubble("ai", h, true);
  if (b) {
    b.querySelector(".agent-run-btn").onclick = () => agentExecute(steps);
    b.querySelector(".agent-cancel-btn").onclick = () => { agentPendingPlan = null; agentBubble("ai", "Đã huỷ kế hoạch. 👍"); };
  }
}

async function agentExecute(steps) {
  agentPendingPlan = null;
  const danger = steps.some(s => s.action === "push_fb_ads" || s.action === "post_fbig");
  if (danger && !confirm("Kế hoạch có bước ĐĂNG/ĐẨY ADS thật (có thể tiêu tiền/đăng công khai). Xác nhận chạy?")) {
    agentBubble("ai", "OK, mình tạm dừng — chưa chạy gì cả.");
    return;
  }
  const statusBubble = agentBubble("ai", "⏳ Bắt đầu chạy kế hoạch…");
  try {
    const body = { steps };
    if (agentProduct) body.product = agentProduct;
    const r = await fetch("/api/agent-run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Lỗi");
    agentPollChat(statusBubble);
  } catch (e) { if (statusBubble) statusBubble.innerHTML = "⚠️ " + agentEsc(e.message); }
}

async function agentPollChat(bubble) {
  try {
    const d = await (await fetch("/api/agent-status")).json();
    const lines = (d.log || []);
    let h = '<div style="font-weight:600;margin-bottom:4px">' + (d.running ? "⏳ Đang chạy " + d.cur + "/" + d.total : "✅ Hoàn tất " + d.total + " bước") + '</div>';
    h += lines.map(l => agentEsc(l)).join("<br>");
    if (bubble) { bubble.innerHTML = h; const w = $("agentChat"); if (w) w.scrollTop = w.scrollHeight; }
    if (d.running) {
      if (!agentTimer) agentTimer = setInterval(() => agentPollChat(bubble), 2500);
    } else {
      if (agentTimer) { clearInterval(agentTimer); agentTimer = null; }
    }
  } catch (e) {}
}

/* =====================================================================
   LOADING DOCK — cửa sổ loading nổi dùng chung, mọi tác vụ chạy nền
   ===================================================================== */
const _loadTasks = {}; let _loadSeq = 0;
(function injectLoadCss() {
  if (document.getElementById("loadDockCss")) return;
  const st = document.createElement("style"); st.id = "loadDockCss";
  st.textContent =
    "@keyframes loadspin{to{transform:rotate(360deg)}}" +
    "@keyframes loadIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}" +
    "#loadDock{position:fixed;right:16px;bottom:16px;z-index:99999;display:flex;flex-direction:column;gap:8px;max-width:320px}" +
    "#loadDock .ltask{background:var(--panel,#fff);color:var(--text,#222);border:1px solid var(--line,#e3d9dc);border-left:3px solid var(--accent,#9a2a3a);border-radius:10px;padding:9px 12px;font-size:12px;line-height:1.4;box-shadow:0 6px 20px #0003;display:flex;align-items:center;gap:9px;animation:loadIn .2s}" +
    "#loadDock .lspin{width:14px;height:14px;flex:0 0 auto;border:2px solid #9a2a3a44;border-top-color:#9a2a3a;border-radius:50%;animation:loadspin .7s linear infinite}";
  document.head.appendChild(st);
})();
function loadTaskAdd(label) {
  const id = ++_loadSeq;
  let dock = document.getElementById("loadDock");
  if (!dock) { dock = document.createElement("div"); dock.id = "loadDock"; document.body.appendChild(dock); }
  const el = document.createElement("div"); el.className = "ltask";
  el.innerHTML = '<span class="lspin"></span><span class="ltxt"></span>';
  el.querySelector(".ltxt").textContent = label || "Đang xử lý…";
  dock.appendChild(el);
  _loadTasks[id] = { el };
  return id;
}
function loadTaskDone(id, ok, msg) {
  const t = _loadTasks[id]; if (!t) return;
  const sp = t.el.querySelector(".lspin");
  if (sp) sp.outerHTML = '<span style="flex:0 0 auto;font-weight:700;color:' + (ok === false ? "#c0392b" : "#2e7d32") + '">' + (ok === false ? "✕" : "✓") + "</span>";
  if (msg) t.el.querySelector(".ltxt").textContent = msg;
  t.el.style.borderLeftColor = ok === false ? "#c0392b" : "#2e7d32";
  setTimeout(() => {
    t.el.remove(); delete _loadTasks[id];
    const d = document.getElementById("loadDock"); if (d && !d.children.length) d.remove();
  }, ok === false ? 4500 : 1600);
}

// Kích hoạt dán (chuột phải + nút) cho mọi dropzone khi tải xong
try { attachUniversalPaste(); } catch (e) {}

/* =====================================================================
   TẠO ADS TỪ BÀI VIẾT FANPAGE CÓ SẴN (boost post)
   ===================================================================== */
let fbPostAdsWired = false, fbPostAdsItems = [];
function fbPostAdsWire() {
  if (fbPostAdsWired) return; fbPostAdsWired = true;
  if ($("fbPostAdsBtn")) $("fbPostAdsBtn").onclick = () => { $("fbPostAdsModal").classList.remove("hidden"); if (!fbPostAdsItems.length) fbPostAdsLoad(); };
  if ($("fbPostAdsClose")) $("fbPostAdsClose").onclick = () => $("fbPostAdsModal").classList.add("hidden");
  if ($("fbPostAdsModal")) $("fbPostAdsModal").onclick = () => $("fbPostAdsModal").classList.add("hidden");
  if ($("fbPostAdsLoad")) $("fbPostAdsLoad").onclick = fbPostAdsLoad;
  if ($("fbPostAdsPush")) $("fbPostAdsPush").onclick = fbPostAdsPush;
}
async function fbPostAdsLoad() {
  const box = $("fbPostAdsList"), note = $("fbPostAdsNote");
  box.innerHTML = '<p class="hint">⏳ Đang tải bài Fanpage…</p>';
  try {
    const d = await (await fetch("/api/fb-page-posts")).json();
    if (d.error) throw new Error(d.error);
    fbPostAdsItems = d.posts || [];
    if (!fbPostAdsItems.length) { box.innerHTML = '<p class="hint">Chưa có bài nào trên Fanpage (hoặc token thiếu quyền đọc bài).</p>'; return; }
    box.innerHTML = fbPostAdsItems.map((p, i) =>
      '<label style="display:flex;gap:10px;align-items:flex-start;padding:8px;border:1px solid var(--line);border-radius:10px;margin-bottom:8px;cursor:pointer">' +
        '<input type="checkbox" class="fbpa-tick" value="' + p.id + '" style="margin-top:4px">' +
        (p.image ? '<img src="' + p.image + '" style="width:64px;height:64px;object-fit:cover;border-radius:8px;flex:none">' : '<div style="width:64px;height:64px;border-radius:8px;background:#eee;flex:none"></div>') +
        '<div style="font-size:12px;line-height:1.4"><div>' + ((p.message || "(không có chữ)").replace(/</g, "&lt;").slice(0, 160)) + '</div>' +
        '<div class="hint" style="font-size:10px;margin-top:2px">' + (p.created || "").slice(0, 10) + (p.permalink ? ' · <a href="' + p.permalink + '" target="_blank">xem bài →</a>' : '') + '</div></div>' +
      '</label>'
    ).join("");
    if (note) { note.className = "gen-note ok"; note.textContent = "✓ Đã tải " + fbPostAdsItems.length + " bài Fanpage."; }
  } catch (e) { box.innerHTML = ""; if (note) { note.className = "gen-note err"; note.textContent = "✗ " + e.message; } }
}
async function fbPostAdsPush() {
  const ids = [...document.querySelectorAll(".fbpa-tick:checked")].map(t => t.value);
  const note = $("fbPostAdsNote");
  if (!ids.length) { if (note) { note.className = "gen-note err"; note.textContent = "⚠️ Tick ít nhất 1 bài."; } return; }
  const budget = parseInt($("fbPostAdsBudget").value) || 50000;
  const active = $("fbPostAdsActive").checked;
  const warn = active
    ? "⚠️ CHẠY NGAY: " + ids.length + " quảng cáo từ bài Fanpage sẽ LÊN SÓNG + TIÊU TIỀN (" + budget.toLocaleString("vi-VN") + "đ/ngày mỗi cái). Chắc chứ?"
    : "Tạo " + ids.length + " quảng cáo từ bài (trạng thái TẠM DỪNG, chưa tiêu tiền). OK?";
  if (!confirm(warn)) return;
  const cid = ($("adpostCampaign") && $("adpostCampaign").value) || "";
  const btn = $("fbPostAdsPush"); btn.disabled = true;
  if (note) { note.className = "gen-note"; note.textContent = "⏳ Đang tạo ads từ " + ids.length + " bài…"; }
  try {
    const r = await fetch("/api/fb-ads-from-post", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ post_ids: ids, daily_budget: budget, active: active, campaign_id: cid }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Lỗi");
    const errs = (d.results || []).filter(x => !x.ok).map(x => x.error).slice(0, 2);
    if (note) { note.className = d.ok ? "gen-note ok" : "gen-note err"; note.textContent = "✓ Đã tạo " + d.ok + "/" + d.total + " ads từ bài (" + (active ? "CHẠY NGAY" : "Tạm dừng") + ")." + (errs.length ? " Lỗi: " + errs.join("; ") : ""); }
  } catch (e) { if (note) { note.className = "gen-note err"; note.textContent = "✗ " + e.message; } }
  finally { btn.disabled = false; }
}

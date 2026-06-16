"use strict";
const $ = (id) => document.getElementById(id);
let currentDesign = null; // base64 (không data: prefix) của design hiện tại

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

  const btn = $("generateBtn"); btn.disabled = true;
  $("emptyState").classList.add("hidden");
  $("resultImgWrap").classList.add("hidden");
  $("resultActions").classList.add("hidden");
  $("spinner").classList.remove("hidden");

  try {
    const r = await fetch("/api/generate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        images, mode: $("mode").value, prompt: $("promptInput").value,
        size: $("size").value, transparent: $("transparent").checked,
        override_prompt: $("useCustomPrompt").checked ? $("promptPreview").value : "",
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Lỗi không xác định");
    showDesign(data.image);
    if (data.prompt) $("promptPreview").value = data.prompt;
    note.className = "gen-note ok";
    note.textContent = data.mock ? "✓ Đã tạo (MOCK). Cắm key để dùng AI thật." : "✓ Tạo design thành công!";
    loadGallery();
  } catch (err) {
    note.className = "gen-note err"; note.textContent = "✗ " + err.message;
    $("emptyState").classList.remove("hidden");
  } finally {
    $("spinner").classList.add("hidden"); btn.disabled = false;
  }
};

function showDesign(b64) {
  currentDesign = b64;
  const src = "data:image/png;base64," + b64;
  $("resultImg").src = src;
  $("designOnShirt").src = src;
  $("resultImgWrap").classList.remove("hidden");
  $("resultActions").classList.remove("hidden");
  $("textTool").classList.remove("hidden");
  $("emptyState").classList.add("hidden");
  if (textState.text.trim()) { $("resultImg").onload = positionTextLayer; }
}

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
    $("mkHint").textContent = front.children.length ? "Bấm vào áo để chọn. Hover để xoá." : "Chưa có — bấm “➕ Tải mặt trước”.";
    $("mkHintBack").textContent = back.children.length ? "Bấm vào áo để chọn. Hover để xoá." : "Chưa có — bấm “➕ Tải mặt sau”.";
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
let drag = null;
layer.addEventListener("pointerdown", (e) => {
  if (e.target.id === "resizeHandle") return;
  e.preventDefault();
  drag = { r: stage.getBoundingClientRect(), sx: e.clientX, sy: e.clientY, x0: state.xPct, y0: state.yPct };
  layer.setPointerCapture(e.pointerId);
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
async function loadGallery() {
  try {
    const r = await fetch("/api/gallery"); const data = await r.json();
    const grid = $("galleryGrid"); grid.innerHTML = "";
    const items = data.items || [];
    $("galleryEmpty").classList.toggle("hidden", items.length > 0);
    items.forEach(it => {
      const card = document.createElement("div"); card.className = "gcard";
      const label = (it.prompt || it.mode || "design").slice(0, 40);
      card.innerHTML = `<img src="${it.url}" loading="lazy"><div class="gmeta">${label}</div><button class="gdel" title="xoá">×</button>`;
      card.querySelector("img").onclick = () => useGalleryItem(it);
      card.querySelector(".gdel").onclick = async (e) => {
        e.stopPropagation();
        await fetch("/api/gallery?id=" + it.id, { method: "DELETE" });
        loadGallery();
      };
      grid.appendChild(card);
    });
  } catch (e) { /* im lặng */ }
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
}
document.querySelectorAll(".app-tab").forEach(t => t.onclick = () => showApp(t.dataset.app));

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

function autoRender(items) {
  const grid = $("autoResults"); grid.innerHTML = "";
  if (!items.length) { $("autoEmpty").classList.remove("hidden"); return; }
  $("autoEmpty").classList.add("hidden");
  items.forEach(it => {
    const card = document.createElement("div");
    card.className = "gcard";
    card.innerHTML =
      '<img src="data:image/png;base64,' + it.image + '" alt="">' +
      '<div class="gmeta">' + (it.title || "Mẫu auto") + '</div>' +
      '<div class="gacts"><button class="b-use">👕 Lên áo</button><button class="b-dl">⬇ Tải</button></div>';
    card.querySelector(".b-use").onclick = () => {
      showApp("clone");
      showDesign(it.image);
      document.querySelector('.rtab[data-rtab="design"]').click();
    };
    card.querySelector(".b-dl").onclick = () => autoDownload(it.image, it.title);
    grid.appendChild(card);
  });
}

$("autoRunBtn").onclick = async () => {
  const note = $("autoNote"); note.className = "gen-note"; note.textContent = "";
  if (!autoUploaded.length) { note.className = "gen-note err"; note.textContent = "⚠️ Hãy tải ít nhất 1 ảnh mẫu để AI giữ nguyên style."; return; }
  const btn = $("autoRunBtn"); btn.disabled = true;
  $("autoEmpty").classList.add("hidden");
  $("autoResults").innerHTML = '<div class="gallery-empty">🤖 AI đang đọc mẫu → giữ style, đổi text → vẽ… (≈30–60 giây/mẫu)</div>';
  try {
    const r = await fetch("/api/auto-gen", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        images: [...autoUploaded],
        niche: $("autoNiche").value,
        n: parseInt($("autoCount").value, 10) || 3,
        size: $("autoSize").value,
        transparent: $("autoTransparent").checked,
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Lỗi không xác định");
    autoRender(data.items || []);
    note.className = "gen-note ok";
    note.textContent = "✓ AI đã vẽ " + (data.items || []).length + " mẫu! Đã lưu vào Lịch sử (tab Clone Design).";
    if (typeof loadGallery === "function") loadGallery();
  } catch (err) {
    $("autoResults").innerHTML = "";
    $("autoEmpty").classList.remove("hidden");
    $("autoEmpty").textContent = "✗ " + err.message;
    note.className = "gen-note err"; note.textContent = "✗ " + err.message;
  } finally {
    btn.disabled = false;
  }
};

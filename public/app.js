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
      card.innerHTML = `<img src="${it.url}" loading="lazy"><div class="gmeta">${label}</div><button class="gcopy" title="copy ảnh để gửi chỗ khác">📋</button><button class="gdel" title="xoá">×</button>`;
      card.querySelector("img").onclick = () => useGalleryItem(it);
      card.querySelector(".gcopy").onclick = (e) => { e.stopPropagation(); copyImageToClipboard(it.url, e.currentTarget); };
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
  document.getElementById("view-recolor").classList.toggle("hidden", app !== "recolor");
  document.getElementById("view-addbg").classList.toggle("hidden", app !== "addbg");
  document.getElementById("view-lenao").classList.toggle("hidden", app !== "lenao");
  document.getElementById("view-batch").classList.toggle("hidden", app !== "batch");
  document.getElementById("view-product").classList.toggle("hidden", app !== "product");
  document.getElementById("view-design").classList.toggle("hidden", app !== "design");
  document.getElementById("view-autopipe").classList.toggle("hidden", app !== "autopipe");
  document.getElementById("view-shopify").classList.toggle("hidden", app !== "shopify");
  document.getElementById("view-shoplist").classList.toggle("hidden", app !== "shoplist");
  if (app === "lenao") lenaoInit();
  if (app === "product") prodInit();
  if (app === "design") dsInit();
  if (app === "shopify") shopInit();
  if (app === "shoplist") shoplistInit();
  if (app === "autopipe") apInit();
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

/* =====================================================================
   TÍNH NĂNG: ĐỔI MÀU THEO ÁO (độc lập)
   ===================================================================== */
const RECOLOR_LIST = [
  { key: "black",  vi: "Đen",     sw: "#1c1c1e" },
  { key: "white",  vi: "Trắng",   sw: "#f5f5f5" },
  { key: "brown",  vi: "Nâu",     sw: "#6b4a2f" },
  { key: "sand",   vi: "Be",      sw: "#d8c3a5" },
  { key: "forest", vi: "Xanh rêu",sw: "#2f5d3a" },
  { key: "red",    vi: "Đỏ",      sw: "#b3261e" },
  { key: "maroon", vi: "Đỏ đô",   sw: "#5e1a1d" },
];
let recolorImg = null;            // dataURL design đầu vào
const recolorPicked = new Set(["black", "white"]); // mặc định chọn

function recolorRenderChips() {
  const box = $("recolorChips"); box.innerHTML = "";
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
let recolorBg = "shirt";        // preset đang chọn
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
      '<div class="gacts"><button class="b-zoom">🔍 Phóng to</button><button class="b-dl">⬇ Tải</button></div>';
    card._cur = cur; card._title = it.title;     // lưu ảnh đang xem để tải
    card.querySelector(".gpick").onchange = (e) => {
      if (e.target.checked) recolorSel.add(i); else recolorSel.delete(i);
      recolorUpdateSelUI();
    };
    card.querySelector("img").onclick = () => openZoom(durl);
    card.querySelector(".b-zoom").onclick = () => openZoom(durl);
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
  if (!recolorPicked.size) { note.className = "gen-note err"; note.textContent = "⚠️ Chọn ít nhất 1 màu áo."; return; }
  const btn = $("recolorRunBtn"); btn.disabled = true;
  $("recolorEmpty").classList.add("hidden");
  $("recolorResults").innerHTML = '<div class="gallery-empty">🎨 AI đang phối lại màu cho ' + recolorPicked.size + ' màu áo… (≈30–60 giây/màu)</div>';
  try {
    const r = await fetch("/api/recolor", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: recolorImg,
        colors: [...recolorPicked],
        size: $("recolorSize").value,
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Lỗi không xác định");
    recolorRender(data.items || []);
    note.className = "gen-note ok";
    note.textContent = "✓ Đã đổi " + (data.items || []).length + " màu! Đã lưu vào Lịch sử.";
    if (typeof loadGallery === "function") loadGallery();
  } catch (err) {
    $("recolorResults").innerHTML = "";
    $("recolorEmpty").classList.remove("hidden");
    $("recolorEmpty").textContent = "✗ " + err.message;
    note.className = "gen-note err"; note.textContent = "✗ " + err.message;
  } finally {
    btn.disabled = false;
  }
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

async function lenaoInit() {
  if (lenaoInited) return; lenaoInited = true;
  try {
    const data = await (await fetch("/api/mockups")).json();
    lenaoSlots = (data.items || []).filter(it => it.side !== "back").map(it => ({
      url: it.url, name: it.name || "Áo",
      design: null, designImg: null,
      state: { xPct: 50, yPct: 40, wPct: 42 },
    }));
  } catch (e) { lenaoSlots = []; }
  lenaoRenderSlots();
}

// đặt design cho 1 slot
async function lenaoSetSlotDesign(slot, durl) {
  slot.design = durl;
  try { slot.designImg = await loadImg(durl); } catch (e) { slot.designImg = null; }
  lenaoRenderSlots();
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
    card.querySelector(".gpick").onchange = lenaoUpdateSelUI;
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
  lenaoSlots.forEach(s => { s.design = durl; s.designImg = img; });
  lenaoRenderSlots();
}
$("lenaoAllFile").onchange = async (e) => { const f = e.target.files[0]; if (f && f.type.startsWith("image/")) await lenaoApplyAll(await fileToDataURL(f)); e.target.value = ""; };
(() => {
  const dz = $("lenaoAllDrop");
  dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("drag"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
  dz.addEventListener("drop", async e => { e.preventDefault(); dz.classList.remove("drag"); const f = e.dataTransfer.files[0]; if (f && f.type.startsWith("image/")) await lenaoApplyAll(await fileToDataURL(f)); });
})();
$("lenaoUseCurrentAll").onclick = () => {
  if (!currentDesign) { alert("Chưa có design nào đang mở ở tab Clone Design."); return; }
  lenaoApplyAll("data:image/png;base64," + currentDesign);
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
      '<div class="gacts"><button class="b-zoom">🔍 Phóng to</button><button class="b-dl">⬇ Tải</button></div>';
    card._cur = it.image; card._name = it.title || "mau";
    card.querySelector("img").onclick = () => openZoom("data:image/png;base64," + it.image);
    card.querySelector(".b-zoom").onclick = () => openZoom("data:image/png;base64," + it.image);
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
   TÍNH NĂNG: ẢNH SẢN PHẨM (gpt-image-2 edits, phong cách Nano Banana)
   ===================================================================== */
const PROD_CATS = [
  { key: "model", label: "👫 Người mẫu", n: 6 },
  { key: "flatlay", label: "🛋️ Flatlay sofa", n: 6 },
  { key: "white", label: "⬜ Nền trắng", n: 5 },
  { key: "kraft", label: "📦 Hộp kraft", n: 7 },
];
const prodPicked = new Set(["model", "white"]);
let prodImg = null;
let prodPollTimer = null;
let prodInited = false;

function prodInit() {
  if (prodInited) return; prodInited = true;
  prodRenderShots();
  prodCheckEngine();
  if ($("prodHistRefresh")) $("prodHistRefresh").onclick = prodLoadHistory;
  if ($("prodHistToShop")) $("prodHistToShop").onclick = () => {
    if (!prodHistSel.size) { alert("Tích chọn ít nhất 1 ảnh trong lịch sử."); return; }
    openPickProd([...prodHistSel].map(u => ({ url: u })));
  };
  prodLoadHistory();
}
let prodSeg = "single";
function prodRenderSegs(segments) {
  const box = $("prodSegs"); if (!box) return;
  box.innerHTML = "";
  (segments || []).forEach(s => {
    const el = document.createElement("div");
    el.className = "cchip" + (prodSeg === s.id ? " on" : "");
    el.innerHTML = s.label + ' <span class="tick">✓</span>';
    el.onclick = () => { prodSeg = s.id; prodRenderSegs(segments); };
    box.appendChild(el);
  });
}
async function prodCheckEngine() {
  try {
    const d = await (await fetch("/api/engines")).json();
    if (d.segments) prodRenderSegs(d.segments);
    // Dropdown chọn model gen ảnh
    const sel = $("prodEngine"), hint = $("prodNanoHint");
    if (sel) {
      const engines = d.engines || [];
      sel.innerHTML = "";
      engines.forEach(e => {
        const o = document.createElement("option");
        o.value = e.id;
        o.textContent = e.label + (e.available ? "" : " — chưa có key");
        o.disabled = !e.available;
        sel.appendChild(o);
      });
      // chọn mặc định model tốt nhất đang khả dụng
      const def = d.default_engine || (engines.find(e => e.available) || {}).id;
      if (def) sel.value = def;
      const cur = engines.find(e => e.id === sel.value) || {};
      const updateHint = () => {
        const e = engines.find(x => x.id === sel.value) || {};
        if (hint) hint.innerHTML = e.available
          ? "✅ Dùng <b>" + (e.label || "") + "</b>" + (e.model ? " (" + e.model + ")" : "") + "."
          : "⚠️ Model này chưa có API key — chọn model khác hoặc thêm key.";
      };
      sel.onchange = updateHint;
      updateHint();
      if (!d.gemini && hint && cur.kind !== "gemini") {
        hint.innerHTML += " <span style='opacity:.8'>Thêm <b>GEMINI_API_KEY</b> để bật Nano Banana.</span>";
      }
    }
    // AI tự viết prompt: ưu tiên Claude, fallback OpenAI vision
    const acb = $("prodAi"), ahint = $("prodAiHint");
    if (d.claude) {
      if (acb) { acb.disabled = false; acb.checked = true; }
      if (ahint) ahint.innerHTML = "✅ Claude (" + (d.claude_model || "") + ") sẽ nhìn ảnh áo và tự viết prompt chân thực.";
    } else if (d.openai_vision) {
      if (acb) { acb.disabled = false; acb.checked = true; }
      if (ahint) ahint.innerHTML = "✅ Dùng OpenAI vision viết prompt. Thêm <b>ANTHROPIC_API_KEY</b> để Claude viết (đúng kiểu skill, đẹp hơn).";
    } else {
      if (acb) { acb.disabled = true; acb.checked = false; }
      if (ahint) ahint.innerHTML = "⚠️ Chưa có ANTHROPIC_API_KEY / OPENAI_API_KEY — dùng prompt mẫu cứng (dễ bị giả).";
    }
  } catch (e) { /* im lặng */ }
}
// Lịch sử ảnh sản phẩm đã tạo (gallery mode=product)
let prodHistSel = new Set();   // url các ảnh được tích chọn
function prodHistSelUpdate() {
  if ($("prodHistToShop")) $("prodHistToShop").textContent = "🛍️ Đưa vào SP Shopify (" + prodHistSel.size + ")";
}
async function prodLoadHistory() {
  const grid = $("prodHistory"); if (!grid) return;
  try {
    const d = await (await fetch("/api/gallery")).json();
    const items = (d.items || []).filter(it => it.mode === "product");
    $("prodHistEmpty").classList.toggle("hidden", items.length > 0);
    prodHistSel = new Set(); prodHistSelUpdate();
    grid.innerHTML = "";
    items.forEach(it => {
      const card = document.createElement("div"); card.className = "gcard";
      card.innerHTML =
        '<label class="hsel"><input type="checkbox"></label>' +
        '<img src="' + it.url + '" loading="lazy" alt="">' +
        '<div class="gmeta">' + (it.prompt || "Ảnh SP") + '</div>' +
        '<div class="gacts"><button class="b-zoom">🔍 Xem</button><button class="b-dl">⬇ Tải</button></div>';
      card.querySelector("img").onclick = () => openZoom(it.url);
      card.querySelector(".hsel input").onchange = (e) => {
        if (e.target.checked) prodHistSel.add(it.url); else prodHistSel.delete(it.url);
        prodHistSelUpdate();
      };
      card.querySelector(".b-zoom").onclick = () => openZoom(it.url);
      card.querySelector(".b-dl").onclick = async () => {
        const b = await (await fetch(it.url)).blob();
        const b64 = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(",")[1]); fr.readAsDataURL(b); });
        autoDownload(b64, (it.prompt || "anh-sp"));
      };
      grid.appendChild(card);
    });
  } catch (e) { /* im lặng */ }
}
function prodRenderShots() {
  const box = $("prodShots"); box.innerHTML = "";
  PROD_CATS.forEach(s => {
    const el = document.createElement("div");
    el.className = "cchip" + (prodPicked.has(s.key) ? " on" : "");
    el.innerHTML = s.label + " (" + s.n + ")" + ' <span class="tick">✓</span>';
    el.onclick = () => { if (prodPicked.has(s.key)) prodPicked.delete(s.key); else prodPicked.add(s.key); prodRenderShots(); };
    box.appendChild(el);
  });
  const total = PROD_CATS.filter(c => prodPicked.has(c.key)).reduce((a, c) => a + c.n, 0);
  $("prodCount").innerHTML = "📸 Sẽ tạo <b>" + total + " ảnh</b> (mỗi ảnh ~30–60s · chạy 3 luồng).";
}
function prodSetImg(durl) {
  prodImg = durl;
  const row = $("prodThumbs"); row.innerHTML = "";
  const d = document.createElement("div"); d.className = "thumb";
  d.innerHTML = '<img src="' + durl + '" alt=""><button class="thumb-x">×</button>';
  d.querySelector(".thumb-x").onclick = () => { prodImg = null; row.innerHTML = ""; };
  row.appendChild(d);
}
$("prodFile").onchange = async (e) => { const f = e.target.files[0]; if (f && f.type.startsWith("image/")) { $("prodFileName").textContent = "📄 " + f.name; prodSetImg(await fileToDataURL(f)); } };
(() => {
  const dz = $("prodDrop");
  dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("drag"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
  dz.addEventListener("drop", async e => { e.preventDefault(); dz.classList.remove("drag"); const f = e.dataTransfer.files[0]; if (f && f.type.startsWith("image/")) prodSetImg(await fileToDataURL(f)); });
})();
$("prodUseCurrent").onclick = () => {
  if (!currentDesign) { alert("Chưa có design nào đang mở ở tab Clone Design."); return; }
  prodSetImg("data:image/png;base64," + currentDesign);
};

let prodLastItems = [];
function prodRender(items) {
  prodLastItems = items || [];
  if ($("prodToShopify")) $("prodToShopify").textContent = "🛍️ Đẩy Shopify (" + prodLastItems.length + ")";
  const grid = $("prodResults");
  if (!items.length) { $("prodEmpty").classList.remove("hidden"); grid.innerHTML = ""; return; }
  $("prodEmpty").classList.add("hidden");
  grid.innerHTML = "";
  items.forEach(it => {
    const card = document.createElement("div");
    card.className = "gcard";
    card.innerHTML =
      '<img src="data:image/png;base64,' + it.image + '" alt="">' +
      '<div class="gmeta">' + (it.title || "Ảnh") + '</div>' +
      '<div class="gacts"><button class="b-zoom">🔍 Phóng to</button><button class="b-dl">⬇ Tải</button></div>';
    card._cur = it.image; card._name = it.title || "anh";
    card.querySelector("img").onclick = () => openZoom("data:image/png;base64," + it.image);
    card.querySelector(".b-zoom").onclick = () => openZoom("data:image/png;base64," + it.image);
    card.querySelector(".b-dl").onclick = () => autoDownload(it.image, it.title || "anh-sp");
    grid.appendChild(card);
  });
  $("prodDownloadAll").textContent = "⬇ Tải tất cả (" + items.length + ")";
}
async function prodPoll(jobId) {
  try {
    const d = await (await fetch("/api/batch-status?id=" + encodeURIComponent(jobId))).json();
    const pct = d.total ? Math.round((d.done / d.total) * 100) : 0;
    $("prodBar").style.width = pct + "%";
    $("prodProgText").textContent = "Đã xong " + d.done + "/" + d.total + " · ✓ " + (d.items || []).length + (d.errors && d.errors.length ? " · ⚠️ " + d.errors.length + " lỗi" : "");
    prodRender(d.items || []);
    $("prodErrors").innerHTML = (d.errors || []).map(e => "<div>⚠️ " + e + "</div>").join("");
    if (d.finished) {
      clearInterval(prodPollTimer); prodPollTimer = null;
      $("prodRunBtn").disabled = false;
      $("prodNote").className = "gen-note ok";
      $("prodNote").textContent = "✓ Xong! " + (d.items || []).length + "/" + d.total + " ảnh (đã lưu Lịch sử).";
      prodLoadHistory();
      if (typeof loadGallery === "function") loadGallery();
    }
  } catch (e) { /* tiếp tục */ }
}
$("prodRunBtn").onclick = async () => {
  const note = $("prodNote"); note.className = "gen-note"; note.textContent = "";
  if (!prodImg) { note.className = "gen-note err"; note.textContent = "⚠️ Hãy tải ảnh sản phẩm trước."; return; }
  if (!prodPicked.size) { note.className = "gen-note err"; note.textContent = "⚠️ Chọn ít nhất 1 nhóm ảnh."; return; }
  const btn = $("prodRunBtn"); btn.disabled = true;
  $("prodErrors").innerHTML = "";
  $("prodProgress").classList.remove("hidden");
  $("prodBar").style.width = "0%"; $("prodProgText").textContent = "Đang gửi…";
  try {
    const r = await fetch("/api/product-photos", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: prodImg, cats: [...prodPicked], bg: $("prodBg").value, segment: prodSeg, engine: ($("prodEngine") && $("prodEngine").value) || "", ai_prompt: !!($("prodAi") && $("prodAi").checked), aspect: ($("prodAspect") && $("prodAspect").value) || "auto" }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Lỗi không xác định");
    $("prodProgText").textContent = "Đang tạo " + d.total + " ảnh (nhiều luồng)…";
    if (prodPollTimer) clearInterval(prodPollTimer);
    prodPollTimer = setInterval(() => prodPoll(d.job_id), 2500);
    prodPoll(d.job_id);
  } catch (err) {
    note.className = "gen-note err"; note.textContent = "✗ " + err.message;
    btn.disabled = false; $("prodProgress").classList.add("hidden");
  }
};
$("prodDownloadAll").onclick = async () => {
  const cards = [...$("prodResults").querySelectorAll(".gcard")];
  if (!cards.length) return;
  for (const cd of cards) { autoDownload(cd._cur, cd._name); await new Promise(r => setTimeout(r, 350)); }
};

/* ---------- Quy trình 2 bước: Claude sinh prompt → duyệt/chọn → Nano Banana gen ---------- */
let prodPromptItems = [];        // {title, prompt, size, aspect, sel}
let prodPpTimer = null, prodRenderTimer = null;

function prodRenderBtnLabel() {
  const n = prodPromptItems.filter(p => p.sel).length;
  if ($("prodRenderBtn")) $("prodRenderBtn").textContent = "🎨 Gen ảnh đã chọn (" + n + ")";
}
function prodRenderPromptList() {
  const box = $("prodPromptList"); if (!box) return;
  box.innerHTML = "";
  prodPromptItems.forEach((p, i) => {
    const el = document.createElement("div");
    el.className = "pp-item" + (p.sel ? " on" : "");
    el.innerHTML =
      '<div class="pp-item-head">' +
        '<input type="checkbox"' + (p.sel ? " checked" : "") + '>' +
        '<span class="pp-item-title">' + (p.title || ("Prompt " + (i + 1))) + '</span>' +
      '</div>' +
      '<textarea spellcheck="false"></textarea>';
    const ta = el.querySelector("textarea"); ta.value = p.prompt || "";
    ta.oninput = () => { p.prompt = ta.value; };
    const cb = el.querySelector("input");
    const toggle = () => { p.sel = cb.checked; el.classList.toggle("on", p.sel); prodRenderBtnLabel(); };
    cb.onchange = toggle;
    el.querySelector(".pp-item-title").onclick = () => { cb.checked = !cb.checked; toggle(); };
    box.appendChild(el);
  });
  prodRenderBtnLabel();
}
async function prodPpPoll(jobId) {
  try {
    const d = await (await fetch("/api/batch-status?id=" + encodeURIComponent(jobId))).json();
    const pct = d.total ? Math.round((d.done / d.total) * 100) : 0;
    $("prodPpBar").style.width = pct + "%";
    $("prodPpText").textContent = "Đã sinh " + (d.items || []).length + "/" + d.total + " prompt"
      + (d.errors && d.errors.length ? " · ⚠️ " + d.errors.length + " lỗi" : "");
    // nạp prompt mới (giữ nguyên sửa/chọn của các prompt đã có)
    const have = prodPromptItems.length;
    (d.items || []).slice(have).forEach(it => prodPromptItems.push({
      title: it.title, prompt: it.prompt, size: it.size, aspect: it.aspect || "", sel: true,
    }));
    if ((d.items || []).length > have) prodRenderPromptList();
    if (d.finished) {
      clearInterval(prodPpTimer); prodPpTimer = null;
      $("prodGenPromptBtn").disabled = false;
      $("prodPpNote").className = "gen-note ok";
      $("prodPpNote").textContent = "✓ Đã sinh " + prodPromptItems.length + " prompt — sửa/chọn rồi bấm Gen.";
      setTimeout(() => $("prodPpProgress").classList.add("hidden"), 600);
    }
  } catch (e) { /* tiếp tục */ }
}
$("prodGenPromptBtn").onclick = async () => {
  const note = $("prodPpNote"); note.className = "gen-note"; note.textContent = "";
  if (!prodImg) { note.className = "gen-note err"; note.textContent = "⚠️ Hãy tải ảnh sản phẩm trước."; return; }
  if (!prodPicked.size) { note.className = "gen-note err"; note.textContent = "⚠️ Chọn ít nhất 1 nhóm ảnh."; return; }
  prodPromptItems = []; prodRenderPromptList();
  $("prodPromptWrap").classList.remove("hidden");
  const btn = $("prodGenPromptBtn"); btn.disabled = true;
  $("prodPpProgress").classList.remove("hidden");
  $("prodPpBar").style.width = "0%"; $("prodPpText").textContent = "AI đang đọc ảnh & viết prompt…";
  try {
    const r = await fetch("/api/product-prompts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: prodImg, cats: [...prodPicked], bg: $("prodBg").value, segment: prodSeg, aspect: ($("prodAspect") && $("prodAspect").value) || "auto" }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Lỗi không xác định");
    if (prodPpTimer) clearInterval(prodPpTimer);
    prodPpTimer = setInterval(() => prodPpPoll(d.job_id), 2000);
    prodPpPoll(d.job_id);
  } catch (err) {
    note.className = "gen-note err"; note.textContent = "✗ " + err.message;
    btn.disabled = false; $("prodPpProgress").classList.add("hidden");
  }
};
$("prodPromptAll").onclick = () => {
  const allSel = prodPromptItems.length && prodPromptItems.every(p => p.sel);
  prodPromptItems.forEach(p => p.sel = !allSel);
  prodRenderPromptList();
};
async function prodRenderPoll(jobId) {
  try {
    const d = await (await fetch("/api/batch-status?id=" + encodeURIComponent(jobId))).json();
    const pct = d.total ? Math.round((d.done / d.total) * 100) : 0;
    $("prodRenderBar").style.width = pct + "%";
    $("prodRenderText").textContent = "Đã gen " + d.done + "/" + d.total + " · ✓ " + (d.items || []).length
      + (d.errors && d.errors.length ? " · ⚠️ " + d.errors.length + " lỗi" : "");
    prodRender(d.items || []);
    $("prodErrors").innerHTML = (d.errors || []).map(e => "<div>⚠️ " + e + "</div>").join("");
    if (d.finished) {
      clearInterval(prodRenderTimer); prodRenderTimer = null;
      $("prodRenderBtn").disabled = false;
      setTimeout(() => $("prodRenderProgress").classList.add("hidden"), 600);
      prodLoadHistory();
      if (typeof loadGallery === "function") loadGallery();
    }
  } catch (e) { /* tiếp tục */ }
}
$("prodRenderBtn").onclick = async () => {
  const picks = prodPromptItems.filter(p => p.sel && (p.prompt || "").trim().length > 10);
  if (!picks.length) { alert("Tick ít nhất 1 prompt (và prompt phải có nội dung)."); return; }
  if (!prodImg) { alert("Thiếu ảnh sản phẩm."); return; }
  const btn = $("prodRenderBtn"); btn.disabled = true;
  $("prodErrors").innerHTML = "";
  $("prodRenderProgress").classList.remove("hidden");
  $("prodRenderBar").style.width = "0%"; $("prodRenderText").textContent = "Đang gửi…";
  try {
    const r = await fetch("/api/product-render", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: prodImg, engine: ($("prodEngine") && $("prodEngine").value) || "",
        prompts: picks.map(p => ({ title: p.title, prompt: p.prompt, size: p.size, aspect: p.aspect })),
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Lỗi không xác định");
    $("prodRenderText").textContent = "Đang gen " + d.total + " ảnh (nhiều luồng)…";
    if (prodRenderTimer) clearInterval(prodRenderTimer);
    prodRenderTimer = setInterval(() => prodRenderPoll(d.job_id), 2500);
    prodRenderPoll(d.job_id);
  } catch (err) {
    btn.disabled = false; $("prodRenderProgress").classList.add("hidden");
    alert("✗ " + err.message);
  }
};
// Đẩy các ảnh sản phẩm thành 1 SP Shopify (ảnh marketing = media, không phải variant màu)
$("prodToShopify").onclick = () => {
  if (!prodLastItems.length) { alert("Chưa có ảnh sản phẩm nào."); return; }
  shopItems.push({
    title: "", description: "", price: "", status: "DRAFT", result: null,
    variants: prodLastItems.map(it => ({ image: it.image, color: "" })),  // color rỗng = ảnh media
  });
  showApp("shopify");
  shopRender();
  const note = $("shopNote"); note.className = "gen-note ok";
  note.textContent = "✓ Đã tạo 1 sản phẩm với " + prodLastItems.length + " ảnh — nhập giá rồi bấm Đẩy.";
};

/* ---------- Content bán hàng: Facebook Ads + TikTok ---------- */
$("contentRunBtn").onclick = async () => {
  const note = $("contentNote"); note.className = "gen-note"; note.textContent = "";
  if (!prodImg) { note.className = "gen-note err"; note.textContent = "⚠️ Hãy tải ảnh sản phẩm (ở trên) trước."; return; }
  const btn = $("contentRunBtn"); btn.disabled = true; const old = btn.textContent; btn.textContent = "✍️ Đang viết…";
  try {
    const r = await fetch("/api/product-content", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: prodImg, info: $("contentInfo").value }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Lỗi không xác định");
    $("cbFacebook").value = d.facebook || "";
    $("cbScript").value = d.tiktok_script || "";
    $("cbCaption").value = d.tiktok_caption || "";
    $("contentOut").hidden = false;
    note.className = "gen-note ok"; note.textContent = "✓ Đã tạo content! Bấm Copy để dùng.";
  } catch (err) {
    note.className = "gen-note err"; note.textContent = "✗ " + err.message;
  } finally {
    btn.disabled = false; btn.textContent = old;
  }
};
document.querySelectorAll(".cb-copy").forEach(b => b.onclick = () => {
  const ta = $(b.dataset.target); ta.select();
  navigator.clipboard.writeText(ta.value).then(() => { const t = b.textContent; b.textContent = "✓ Đã copy"; setTimeout(() => b.textContent = t, 1200); });
});

/* =====================================================================
   TÍNH NĂNG: TẠO DESIGN (text-to-image theo phong cách)
   ===================================================================== */
const DS_STYLES = [
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
function dsInit() {
  if (dsInited) return; dsInited = true;
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

function dsRender() {
  const grid = $("dsResults");
  let entries = Object.entries(dsItems);   // [key, item]
  if (!entries.length) { $("dsEmpty").classList.remove("hidden"); grid.innerHTML = ""; $("dsDownloadAll").textContent = "⬇ Tải tất cả (0)"; return; }
  $("dsEmpty").classList.add("hidden");
  // nếu đã chấm điểm -> sắp xếp điểm cao lên trước
  const anyRated = entries.some(([, it]) => typeof it.score === "number");
  if (anyRated) entries = entries.sort((a, b) => (b[1].score || 0) - (a[1].score || 0));
  grid.innerHTML = "";
  entries.forEach(([key, it]) => {
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
      '<img src="data:image/png;base64,' + it.image + '" alt="">' + badge +
      '<div class="gmeta">' + (it.title || "Design") + '</div>' +
      '<div class="gacts"><button class="b-name">🪪 Tên</button><button class="b-var">🔄 Bản khác</button><button class="b-use">👕 Lên áo</button><button class="b-copy">📋 Copy</button><button class="b-dl">⬇ Tải</button></div>';
    card._cur = it.image; card._name = it.title || "design";
    card.querySelector("img").onclick = () => openZoom("data:image/png;base64," + it.image);
    card.querySelector(".b-name").onclick = () => openPersonalize(it.image);
    card.querySelector(".b-var").onclick = (e) => dsMakeVariations(it.image, e.currentTarget);
    card.querySelector(".b-use").onclick = () => { showApp("clone"); showDesign(it.image); document.querySelector('.rtab[data-rtab="design"]').click(); };
    card.querySelector(".b-copy").onclick = (e) => copyImageToClipboard("data:image/png;base64," + it.image, e.currentTarget);
    card.querySelector(".b-dl").onclick = () => autoDownload(it.image, it.title || "design");
    grid.appendChild(card);
  });
  $("dsDownloadAll").textContent = "⬇ Tải tất cả (" + entries.length + ")";
}
/* ===== Tạo thêm phiên bản khác của 1 design ===== */
async function dsMakeVariations(image, btn) {
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = "⏳…";
  const note = $("dsNote"); note.className = "gen-note"; note.textContent = "Đang tạo 4 phiên bản khác…";
  try {
    const r = await fetch("/api/variations", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image, count: 4, transparent: true }),
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
function openPersonalize(image) {
  pnImage = image;
  $("pnPreview").src = "data:image/png;base64," + image;
  $("pnName").value = ""; $("pnDate").value = "";
  $("pnNote").textContent = ""; $("pnNote").className = "gen-note";
  $("pnModal").classList.remove("hidden");
  setTimeout(() => $("pnName").focus(), 50);
}
function closePersonalize() { $("pnModal").classList.add("hidden"); pnImage = null; }
$("pnClose").onclick = closePersonalize;
$("pnModal").onclick = (e) => { if (e.target.id === "pnModal") closePersonalize(); };
$("pnGo").onclick = async () => {
  const name = $("pnName").value.trim();
  if (!name) { $("pnNote").className = "gen-note err"; $("pnNote").textContent = "⚠️ Nhập tên đã."; return; }
  const count = parseInt($("pnCount").value, 10) || 4;
  const btn = $("pnGo"), old = btn.textContent;
  btn.disabled = true; btn.textContent = "⏳ Đang tạo…";
  $("pnNote").className = "gen-note"; $("pnNote").textContent = "Đang tạo " + count + " bản (giữ phong cách, thay tên)…";
  try {
    const r = await fetch("/api/personalize", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: pnImage, name, date: $("pnDate").value.trim(), count, transparent: true }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Lỗi cá nhân hoá");
    (d.items || []).forEach(it => { dsItems[dsItemKey(it)] = it; });
    dsRender();
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
      j.total = d.total; j.done = d.done; j.finished = d.finished;
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
  if (!dsSegment && !dsAuto && !dsPicked.size && !dsRefImg) { note.className = "gen-note err"; note.textContent = "⚠️ Chọn phong cách, tệp khách, bật 🎯 AI tự chọn style, hoặc tải ảnh tham chiếu."; return; }
  $("dsProgress").classList.remove("hidden");
  try {
    const r = await fetch("/api/design-gen", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ styles: [...dsPicked], ref: dsRefImg || "", auto_style: dsAuto, segment: dsSegment, theme: $("dsTheme").value, text: ($("dsText")?.value || ""), year: $("dsYear").value, same_line: ($("dsSameLine")?.checked || false), n: parseInt($("dsCount").value, 10) || 3, size: $("dsSize").value, transparent: true }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Lỗi không xác định");
    dsJobs.push({ id: d.job_id, total: d.total, done: 0, finished: false });
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
  for (const cd of cards) { autoDownload(cd._cur, cd._name); await new Promise(r => setTimeout(r, 350)); }
};

/* =====================================================================
   ĐẨY SHOPIFY: chọn ảnh đã setup -> AI viết tên/mô tả -> tạo sản phẩm
   ===================================================================== */
let shopInited = false;
let shopItems = [];   // [{image(b64), fname, title, price, status, result}]

function shopInit() {
  if (shopInited) return; shopInited = true;
  shopCheckStatus();
  $("shopFile").onchange = (e) => shopAddFiles(e.target.files);
  const dz = $("shopDrop");
  dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("drag"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
  dz.addEventListener("drop", e => { e.preventDefault(); dz.classList.remove("drag"); shopAddFiles(e.dataTransfer.files); });
  $("shopClear").onclick = () => { shopItems = []; shopRender(); };
  $("shopPush").onclick = shopPush;
  // đổi size/giá -> cập nhật bảng Color×Size preview
  $("shopUseSizes").addEventListener("change", () => shopRender());
  $("shopSizes").addEventListener("input", () => shopRender());
  $("shopPrice").addEventListener("input", () => { if (!shopItems.some(it => it.price)) shopRender(); });
  $("shopSizeFile").onchange = async (e) => { const f = e.target.files[0]; if (f && f.type.startsWith("image/")) shopSetSizeChart(await fileToDataURL(f), f.name); e.target.value = ""; };
  const sz = $("shopSizeDrop");
  sz.addEventListener("dragover", e => { e.preventDefault(); sz.classList.add("drag"); });
  sz.addEventListener("dragleave", () => sz.classList.remove("drag"));
  sz.addEventListener("drop", async e => { e.preventDefault(); sz.classList.remove("drag"); const f = e.dataTransfer.files[0]; if (f && f.type.startsWith("image/")) shopSetSizeChart(await fileToDataURL(f), f.name); });
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
    const vthumbs = vars.map((v, vi) =>
      '<div class="shop-var' + (vi === it.cover ? " cover" : "") + '">' +
        '<img src="data:image/png;base64,' + v.image + '" alt="">' +
        (vi === it.cover ? '<span class="shop-cover-badge">Bìa</span>' : '<button class="shop-var-cover" data-vi="' + vi + '" title="Đặt làm ảnh bìa">⭐</button>') +
        '<input class="shop-var-c" data-vi="' + vi + '" placeholder="Màu" value="' + (v.color || "").replace(/"/g, "&quot;") + '">' +
        '<button class="shop-var-x" data-vi="' + vi + '" title="bỏ variant">×</button>' +
      "</div>").join("");
    row.innerHTML =
      '<img src="data:image/png;base64,' + (vars[0] ? vars[0].image : "") + '" alt="">' +
      '<div class="shop-fields">' +
        '<input class="input sm shop-t" placeholder="Tên sản phẩm (để trống = AI tự viết)" value="' + (it.title || "").replace(/"/g, "&quot;") + '">' +
        '<textarea class="input sm shop-d" rows="2" placeholder="Mô tả (để trống = AI tự viết / dùng mặc định)">' + (it.description || "") + '</textarea>' +
        '<div class="shop-mini"><input class="input sm shop-p" placeholder="Giá VND" value="' + (it.price || "") + '">' +
        '<select class="input sm shop-s"><option value="DRAFT"' + (it.status === "DRAFT" ? " selected" : "") + '>Nháp</option><option value="ACTIVE"' + (it.status === "ACTIVE" ? " selected" : "") + '>Đăng bán</option></select>' +
        '<button class="shop-x">✕</button></div>' +
        '<div class="shop-vlabel">' + (vars.some(v => (v.color || "").trim()) ? "🎨 " + vars.length + " variant màu (mỗi màu 1 ảnh)" : "🖼️ " + vars.length + " ảnh sản phẩm (media)") + ' — ⭐ bấm để chọn <b>ảnh bìa</b>:</div>' +
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
    row.querySelectorAll(".shop-var-cover").forEach(b => b.onclick = (e) => { it.cover = +e.currentTarget.dataset.vi; shopRender(); });
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
        description: ($("shopDesc").value || "").trim(),
        sizes: $("shopUseSizes").checked
          ? ($("shopSizes").value || "").split(",").map(s => s.trim()).filter(Boolean)
          : [],
        items: shopItems.map(it => ({ title: it.title, description: it.description, price: it.price, status: it.status, cover: it.cover || 0, variants: (it.variants || []).map(v => ({ image: v.image, color: v.color })) })),
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
        '<div class="gacts"><button class="b-open">🌐 Xem trang bán</button><button class="b-img">🖼️ Ảnh</button><button class="b-admin" title="Mở trong admin Shopify">⚙</button><button class="b-del">🗑️ Xoá</button></div>';
      card.querySelector(".b-open").onclick = () => {
        if (p.status !== "active") {
          if (!confirm("Sản phẩm đang NHÁP nên trang bán chưa công khai (có thể 404). Vẫn mở?")) return;
        }
        window.open(p.store_url || p.url, "_blank");
      };
      card.querySelector("img")?.addEventListener("click", () => window.open(p.store_url || p.url, "_blank"));
      card.querySelector(".b-admin").onclick = () => window.open(p.url, "_blank");
      card.querySelector(".b-img").onclick = () => openImgUpdate(p);
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
   TÍNH NĂNG: TRỌN GÓI — wizard 3 bước (ra design → đổi màu → lên áo → Shopify)
   ===================================================================== */
const AP_TEP = { single: "👤 1 áo", couple: "💑 Couple", family: "👨‍👩‍👧 Gia đình", group: "👥 Đội nhóm" };
const apColors = new Set(["black", "white"]);
let apInited = false;
let apStep = 1;
let apDesigns = [];           // bước 1: design AI tạo
let apPicked = new Set();     // index design đã chọn (bước 1)
let apPickedList = [];        // design đã chọn (truyền sang bước 2)
let apRecolored = [];         // bước 2: design + variants màu
let apShirtItems = [];        // bước 3: lên áo
let apSel = new Set();        // index mẫu chọn để đẩy Shopify (bước 3)
let apT1 = null, apT2 = null;

function apInit() {
  if (apInited) return; apInited = true;
  apRenderColors();
  $("apRunDesigns").onclick = apRunDesigns;
  $("apToStep2").onclick = apToStep2;
  $("apBack1").onclick = () => apGoStep(1);
  $("apDoRecolor").onclick = apDoRecolor;
  $("apToStep3").onclick = apToStep3;
  $("apBack2").onclick = () => apGoStep(2);
  $("apToShopify").onclick = apToShopify;
}
function apGoStep(s) {
  apStep = s;
  [1, 2, 3].forEach(n => $("apStep" + n).classList.toggle("hidden", n !== s));
  document.querySelectorAll(".ap-step").forEach(e => e.classList.toggle("on", +e.dataset.s === s));
}
function apRenderColors() {
  const box = $("apColors"); if (!box) return;
  box.innerHTML = "";
  RECOLOR_LIST.forEach(c => {
    const el = document.createElement("div");
    el.className = "cchip" + (apColors.has(c.key) ? " on" : "");
    el.innerHTML = '<span class="sw" style="background:' + c.sw + '"></span> ' + c.vi + ' <span class="tick">✓</span>';
    el.onclick = () => { if (apColors.has(c.key)) apColors.delete(c.key); else apColors.add(c.key); apRenderColors(); };
    box.appendChild(el);
  });
}

/* ---------- BƯỚC 1: AI ra design ---------- */
function apPickN() { $("apToStep2").textContent = "Tiếp: Đổi màu (" + apPicked.size + ") →"; }
function apRenderDesigns() {
  const grid = $("apDesigns");
  $("apEmpty1").classList.toggle("hidden", apDesigns.length > 0);
  grid.innerHTML = "";
  apDesigns.forEach((it, i) => {
    const card = document.createElement("div"); card.className = "gcard";
    const tep = AP_TEP[it.tep] || it.tep || "";
    const dateTag = it.date ? " · " + it.date : "";
    card.innerHTML =
      '<label class="hsel"><input type="checkbox"' + (apPicked.has(i) ? " checked" : "") + '></label>' +
      '<img src="data:image/png;base64,' + (it.image || it.design) + '" alt="">' +
      '<div class="gmeta"><b>' + (it.name || it.role || "") + '</b>' + dateTag + ' · ' + tep +
      '<br><span style="opacity:.75">' + (it.style || "") + (it.theme ? " · " + it.theme : "") + '</span></div>';
    card.querySelector(".hsel input").onchange = (e) => {
      if (e.target.checked) apPicked.add(i); else apPicked.delete(i); apPickN();
    };
    card.querySelector("img").onclick = () => openZoom("data:image/png;base64," + (it.image || it.design));
    grid.appendChild(card);
  });
  apPickN();
}
async function apPollDesigns(jobId) {
  try {
    const d = await (await fetch("/api/batch-status?id=" + encodeURIComponent(jobId))).json();
    $("apBar1").style.width = (d.total ? Math.round(d.done / d.total * 100) : 0) + "%";
    $("apT1").textContent = "Đã xong " + d.done + "/" + d.total + (d.errors && d.errors.length ? " · ⚠️ " + d.errors.length : "");
    apDesigns = d.items || []; apRenderDesigns();
    $("apErr1").innerHTML = (d.errors || []).map(e => "<div>⚠️ " + e + "</div>").join("");
    if (d.finished) {
      clearInterval(apT1); apT1 = null;
      $("apRunDesigns").disabled = false;
      $("apNote1").className = "gen-note ok";
      $("apNote1").textContent = "✓ " + apDesigns.length + " design — tick mẫu ưng rồi bấm “Tiếp: Đổi màu”.";
      setTimeout(() => $("apP1").classList.add("hidden"), 600);
      if (typeof loadGallery === "function") loadGallery();
    }
  } catch (e) { /* tiếp tục */ }
}
async function apRunDesigns() {
  const note = $("apNote1"); note.className = "gen-note"; note.textContent = "";
  apDesigns = []; apPicked = new Set(); apRenderDesigns();
  const btn = $("apRunDesigns"); btn.disabled = true;
  $("apErr1").innerHTML = ""; $("apP1").classList.remove("hidden");
  $("apBar1").style.width = "0%"; $("apT1").textContent = "AI đang nghĩ + vẽ design…";
  try {
    const r = await fetch("/api/pipe-designs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ n: parseInt($("apCount").value || "3", 10), niche: $("apNiche").value || "" }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Lỗi");
    if (apT1) clearInterval(apT1);
    apT1 = setInterval(() => apPollDesigns(d.job_id), 2500); apPollDesigns(d.job_id);
  } catch (err) {
    note.className = "gen-note err"; note.textContent = "✗ " + err.message;
    btn.disabled = false; $("apP1").classList.add("hidden");
  }
}
function apToStep2() {
  apPickedList = [...apPicked].map(i => apDesigns[i]).filter(Boolean);
  if (!apPickedList.length) { alert("Tick ít nhất 1 design để đổi màu."); return; }
  $("apPickedN").textContent = apPickedList.length;
  const row = $("apPickedThumbs"); row.innerHTML = "";
  apPickedList.forEach(it => {
    const d = document.createElement("div"); d.className = "thumb";
    d.innerHTML = '<img src="data:image/png;base64,' + (it.image || it.design) + '" alt="">';
    row.appendChild(d);
  });
  apRenderColors();
  apGoStep(2);
}

/* ---------- BƯỚC 2: đổi màu các design đã chọn ---------- */
function apRenderRecolor() {
  const grid = $("apRecolorResults");
  $("apEmpty2").classList.toggle("hidden", apRecolored.length > 0);
  grid.innerHTML = "";
  apRecolored.forEach(it => {
    const card = document.createElement("div"); card.className = "gcard";
    const vars = it.variants || [];
    card.innerHTML =
      '<img src="data:image/png;base64,' + (vars[0] ? vars[0].recolored : it.image) + '" alt="">' +
      '<div class="ap-vars">' + vars.map(v => '<img class="ap-var" src="data:image/png;base64,' + v.recolored + '" title="áo ' + (v.color_vi || "") + '">').join("") + '</div>' +
      '<div class="gmeta"><b>' + (it.name || it.role || "") + '</b> · ' + vars.length + ' màu</div>';
    const main = card.querySelector("img");
    card.querySelectorAll(".ap-var").forEach(im => { im.onclick = () => main.src = im.src; });
    main.onclick = () => openZoom(main.src);
    grid.appendChild(card);
  });
}
async function apPollRecolor(jobId) {
  try {
    const d = await (await fetch("/api/batch-status?id=" + encodeURIComponent(jobId))).json();
    $("apBar2").style.width = (d.total ? Math.round(d.done / d.total * 100) : 0) + "%";
    $("apT2").textContent = "Đã xong " + d.done + "/" + d.total + (d.errors && d.errors.length ? " · ⚠️ " + d.errors.length : "");
    apRecolored = d.items || []; apRenderRecolor();
    $("apErr2").innerHTML = (d.errors || []).map(e => "<div>⚠️ " + e + "</div>").join("");
    if (d.finished) {
      clearInterval(apT2); apT2 = null;
      $("apDoRecolor").disabled = false;
      $("apNote2").className = "gen-note ok";
      $("apNote2").textContent = "✓ Đổi màu xong — bấm “Tiếp: Lên áo”.";
      setTimeout(() => $("apP2").classList.add("hidden"), 600);
    }
  } catch (e) { /* tiếp tục */ }
}
async function apDoRecolor() {
  if (!apColors.size) { alert("Chọn ít nhất 1 màu áo."); return; }
  if (!apPickedList.length) { alert("Chưa có design nào."); return; }
  const note = $("apNote2"); note.className = "gen-note"; note.textContent = "";
  apRecolored = []; apRenderRecolor();
  const btn = $("apDoRecolor"); btn.disabled = true;
  $("apErr2").innerHTML = ""; $("apP2").classList.remove("hidden");
  $("apBar2").style.width = "0%"; $("apT2").textContent = "AI đang đổi màu…";
  try {
    const r = await fetch("/api/pipe-recolor", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        colors: [...apColors],
        designs: apPickedList.map(it => ({
          name: it.name, date: it.date, tep: it.tep, role: it.role, style: it.style, theme: it.theme,
          image: it.image || it.design,
        })),
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Lỗi");
    if (apT2) clearInterval(apT2);
    apT2 = setInterval(() => apPollRecolor(d.job_id), 2500); apPollRecolor(d.job_id);
  } catch (err) {
    note.className = "gen-note err"; note.textContent = "✗ " + err.message;
    btn.disabled = false; $("apP2").classList.add("hidden");
  }
}
function apToStep3() {
  if (!apRecolored.length) { alert("Chưa có mẫu đã đổi màu."); return; }
  apShirtItems = apRecolored.map(it => Object.assign({}, it));
  apSel = new Set();
  apGoStep(3);
  apRenderShirts();
}

/* ---------- BƯỚC 3: lên áo (compose client-side) + đẩy Shopify ---------- */
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
async function apRecompose(it, card) {
  for (const v of it.variants) {
    v._url = await apComposeOne(v.color, v.recolored, it._state);
    v.shirt = v._url.split(",")[1];
  }
  const thumbs = card.querySelectorAll(".ap-var");
  it.variants.forEach((v, idx) => { if (thumbs[idx]) thumbs[idx].src = v._url; });
  const main = card.querySelector(".ap-main");
  if (main) main.src = it.variants[it._active]._url || main.src;
}
function apShopN() { $("apToShopify").textContent = "🛍️ Đẩy mẫu đã chọn (" + apSel.size + ")"; }
async function apRenderShirts() {
  const grid = $("apResults");
  $("apEmpty3").classList.toggle("hidden", apShirtItems.length > 0);
  grid.innerHTML = ""; apSel = new Set(); apShopN();
  for (let i = 0; i < apShirtItems.length; i++) {
    const it = apShirtItems[i];
    it._state = it._state || { x: 50, y: 43, w: 40 };
    it._active = 0;
    // compose lần đầu
    for (const v of it.variants) { v._url = await apComposeOne(v.color, v.recolored, it._state); v.shirt = v._url.split(",")[1]; }
    const card = document.createElement("div"); card.className = "gcard";
    const tep = AP_TEP[it.tep] || it.tep || "";
    const dateTag = it.date ? " · " + it.date : "";
    card.innerHTML =
      '<label class="hsel"><input type="checkbox"></label>' +
      '<img class="ap-main" src="' + it.variants[0]._url + '" alt="">' +
      '<div class="ap-vars">' + it.variants.map((v, vi) => '<img class="ap-var" data-vi="' + vi + '" src="' + v._url + '" title="áo ' + (v.color_vi || "") + '">').join("") + '</div>' +
      '<div class="ap-edit">' +
        '<label>↔ <input type="range" class="ap-x" min="20" max="80" value="' + it._state.x + '"></label>' +
        '<label>↕ <input type="range" class="ap-y" min="20" max="75" value="' + it._state.y + '"></label>' +
        '<label>⤢ <input type="range" class="ap-w" min="15" max="70" value="' + it._state.w + '"></label>' +
      '</div>' +
      '<div class="gmeta"><b>' + (it.name || it.role || "") + '</b>' + dateTag + ' · ' + tep + ' · ' + it.variants.length + ' màu áo</div>' +
      '<div class="gacts"><button class="b-dl">⬇ Tải ảnh áo</button></div>';
    const idx = i;
    card.querySelector(".hsel input").onchange = (e) => { if (e.target.checked) apSel.add(idx); else apSel.delete(idx); apShopN(); };
    const mainImg = card.querySelector(".ap-main");
    mainImg.onclick = () => openZoom(mainImg.src);
    card.querySelectorAll(".ap-var").forEach(im => { im.onclick = () => { it._active = +im.dataset.vi; mainImg.src = im.src; }; });
    let t = null;
    const onSlide = () => {
      it._state.x = +card.querySelector(".ap-x").value;
      it._state.y = +card.querySelector(".ap-y").value;
      it._state.w = +card.querySelector(".ap-w").value;
      clearTimeout(t); t = setTimeout(() => apRecompose(it, card), 120);
    };
    card.querySelectorAll(".ap-edit input").forEach(s => s.oninput = onSlide);
    card.querySelector(".b-dl").onclick = () => autoDownload(mainImg.src.split(",")[1], (it.name || "design") + "-ao");
    grid.appendChild(card);
  }
}
function apToShopify() {
  const picks = [...apSel].map(i => apShirtItems[i]).filter(Boolean);
  if (!picks.length) { alert("Tick ít nhất 1 mẫu để đẩy."); return; }
  picks.forEach(it => {
    shopItems.push({
      title: "", description: "", price: "", status: "DRAFT", result: null,
      variants: it.variants.map(v => ({ image: v.shirt, color: v.color_vi || "" })),
    });
  });
  showApp("shopify"); shopRender();
  const note = $("shopNote"); note.className = "gen-note ok";
  note.textContent = "✓ Đã đưa " + picks.length + " mẫu sang Shopify — nhập giá rồi bấm Đẩy.";
}

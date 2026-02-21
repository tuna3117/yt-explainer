// ============================================================
// content.js — Web Explainer v4
// - Tüm web sayfalarında metin seç → Türkçe açıkla
// - YouTube'da toggle butonu ile açılır/kapanır
// - Açıkken: orijinal altyazı gizlenir, bizim overlay render eder
// - Kapalıyken: YouTube'un normal altyazısı çalışır
// ============================================================

let tooltipEl        = null;
let selectionIconEl  = null;
let lastRange        = null;
let lastSelectedText = "";
let lastContext      = "";
let activeReqId      = 0;

// Tema state — popup'tan storage üzerinden senkronize edilir
let appTheme = "light";
chrome.storage.local.get(["theme"], s => { appTheme = s.theme || "light"; });
chrome.storage.onChanged.addListener(changes => {
  if (changes.theme) appTheme = changes.theme.newValue || "light";
});

const isYouTube = location.hostname.includes("youtube.com");

// YouTube subtitle override state
let overlayEnabled       = false;   // toggle durumu
let ourOverlayEl         = null;    // bizim altyazı kutusu
let ytSubtitleObserver   = null;    // YT caption DOM observer
let lastRenderedText     = "";      // gereksiz re-render önle
let renderDebounceTimer  = null;    // titreme önlemek için debounce
let toggleBtnEl          = null;    // player'daki buton

// ============================================================
// INIT
// ============================================================
function init() {
  injectStyles();
  setupSelectionListener();
  if (isYouTube) initYouTube();
}

// ============================================================
// KEYBOARD SHORTCUT
// ============================================================
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "TRIGGER_EXPLAIN") triggerExplain();
});

// ============================================================
// SELECTION LISTENER
// ============================================================
function setupSelectionListener() {
  document.addEventListener("mouseup", (e) => setTimeout(() => handleSelection(e), 80));
  document.addEventListener("keyup",   (e) => setTimeout(() => handleSelection(e), 80));
}

function handleSelection(e) {
  const sel = window.getSelection();
  if (tooltipEl?.contains(e.target) || selectionIconEl?.contains(e.target)) return;
  if (!sel || sel.isCollapsed || !sel.toString().trim()) { removeSelectionIcon(); return; }
  const text = sel.toString().trim();
  if (text.length < 2) { removeSelectionIcon(); return; }
  if (sel.rangeCount > 0) {
    lastRange        = sel.getRangeAt(0);
    lastSelectedText = text;
    lastContext      = getSurroundingContext(sel, text);
  }
  showSelectionIcon();
}

// ============================================================
// SELECTION ICON
// ============================================================
function showSelectionIcon() {
  removeSelectionIcon();
  if (!lastRange) return;
  const rect = (typeof lastRange.getBoundingClientRect === "function")
    ? lastRange.getBoundingClientRect()
    : lastRange;

  selectionIconEl = document.createElement("div");
  selectionIconEl.id = "ytexp-sel-icon";
  selectionIconEl.style.cssText = `
    position:fixed;
    top:${Math.max(4, rect.top - 46)}px;
    left:${rect.left + (rect.width||0) / 2 - 18}px;
    width:36px; height:36px;
    background:linear-gradient(135deg,#7c3aed,#6366f1);
    border-radius:50%; display:flex; align-items:center; justify-content:center;
    cursor:pointer; z-index:2147483646;
    box-shadow:0 4px 12px rgba(124,58,237,0.5);
    font-size:16px; user-select:none; transition:transform 0.15s;
    animation:ytexp-pop 0.2s cubic-bezier(0.34,1.56,0.64,1);
  `;
  selectionIconEl.innerHTML = `<img src="${chrome.runtime.getURL('icons/icon48.png')}" style="width:20px;height:20px;object-fit:contain;filter:brightness(0) invert(1);">`;
  selectionIconEl.title = "Türkçe açıkla (Ctrl+Shift+E)";
  selectionIconEl.addEventListener("mouseenter", () => selectionIconEl.style.transform = "scale(1.15)");
  selectionIconEl.addEventListener("mouseleave", () => selectionIconEl.style.transform = "scale(1)");
  selectionIconEl.addEventListener("mousedown", (e) => {
    e.preventDefault(); e.stopPropagation();
    removeSelectionIcon();
    triggerExplainWithData(lastSelectedText, lastContext);
  });
  document.body.appendChild(selectionIconEl);
  setTimeout(() => removeSelectionIcon(), 6000);
}

function removeSelectionIcon() { selectionIconEl?.remove(); selectionIconEl = null; }

// ============================================================
// EXPLAIN
// ============================================================
function triggerExplain() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) {
    showTooltip(null, null, null, "error", "Önce bir metin seçin."); return;
  }
  const text = sel.toString().trim();
  if (sel.rangeCount > 0) lastRange = sel.getRangeAt(0);
  triggerExplainWithData(text, getSurroundingContext(sel, text));
}

function triggerExplainWithData(word, context) {
  removeSelectionIcon();
  if (!chrome.runtime?.id) {
    showTooltip(word, context, null, "error", "Uzantı bağlantısı kesildi. F5 ile yenileyin."); return;
  }
  const reqId = ++activeReqId;
  showTooltip(word, context, null, "loading");
  chrome.storage.local.get(["mode"], (s) => {
    chrome.runtime.sendMessage(
      { type: "EXPLAIN_TEXT", payload: { selectedText: word, context, mode: s.mode || "explain" } },
      (res) => {
        if (reqId !== activeReqId) return; // kullanıcı kapattı, gösterme
        if (chrome.runtime.lastError) {
          showTooltip(word, context, null, "error", "Bağlantı hatası. F5 ile yenileyin."); return;
        }
        if (res?.ok) showTooltip(word, context, res.data, "success");
        else showTooltip(word, context, null, "error", res?.error || "Hata oluştu.");
      }
    );
  });
}

// ============================================================
// YOUTUBE
// ============================================================
function initYouTube() {
  // SPA navigation
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      onYouTubeNavigate();
    }
  }).observe(document.body, { childList: true, subtree: true });

  onYouTubeNavigate();
}

function onYouTubeNavigate() {
  overlayEnabled = false;
  lastRenderedText = "";
  ourOverlayEl?.remove(); ourOverlayEl = null;
  ytSubtitleObserver?.disconnect();
  document.getElementById("ytexp-hide-captions")?.remove();
  document.getElementById("ytexp-toggle-btn")?.remove();
  toggleBtnEl = null;

  // Birden fazla noktada dene — YouTube bazen geç render ediyor
  const tryInject = (attempts = 0) => {
    const controls = document.querySelector(".ytp-right-controls");
    if (controls) {
      injectToggleButton(controls);
      return;
    }
    if (attempts < 40) setTimeout(() => tryInject(attempts + 1), 300);
  };

  // İlk deneme hemen, sonra kısa aralıklarla
  tryInject();
  setTimeout(() => tryInject(), 1000);
  setTimeout(() => tryInject(), 2500);
  setTimeout(() => tryInject(), 5000);
}

// ---- Toggle butonu ----
function injectToggleButton(controls) {
  // Zaten eklenmiş mi veya controls DOM'da değil mi?
  if (document.getElementById("ytexp-toggle-btn")) return;
  if (!document.body.contains(controls)) return;

  toggleBtnEl = document.createElement("button");
  toggleBtnEl.id = "ytexp-toggle-btn";
  toggleBtnEl.title = "Web Explainer altyazısını aç/kapat";
  toggleBtnEl.style.cssText = `
    background: rgba(0,0,0,0.55);
    border: 2px solid #3b82f6;
    border-radius: 8px;
    color: #fff;
    cursor: pointer;
    font-size: 12px;
    font-weight: 700;
    font-family: 'Segoe UI', sans-serif;
    letter-spacing: 0.06em;
    padding: 0 10px;
    margin: 0 4px;
    height: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    align-self: center;
    gap: 5px;
    transition: all 0.15s;
  `;
  updateToggleBtn();

  toggleBtnEl.addEventListener("click", () => {
    overlayEnabled = !overlayEnabled;
    updateToggleBtn();
    if (overlayEnabled) enableOverride();
    else disableOverride();
  });

  try {
    const settingsBtn = controls.querySelector(".ytp-settings-button");
    if (settingsBtn && controls.contains(settingsBtn)) {
      controls.insertBefore(toggleBtnEl, settingsBtn);
    } else {
      controls.prepend(toggleBtnEl);
    }
  } catch(e) {
    try { controls.prepend(toggleBtnEl); } catch(e2) {}
  }
}

function updateToggleBtn() {
  if (!toggleBtnEl) return;
  const iconSrc = chrome.runtime.getURL('icons/icon48.png');
  const iconHtml = `<img src="${iconSrc}" style="width:16px;height:16px;object-fit:contain;flex-shrink:0;">`;
  toggleBtnEl.innerHTML = `${iconHtml} TR`;
  toggleBtnEl.style.background = "rgba(0,0,0,0.55)";
  toggleBtnEl.style.color = "#fff";
  toggleBtnEl.style.borderColor = overlayEnabled ? "#3b82f6" : "rgba(255,255,255,0.6)";
}

// ---- Override aç ----
function enableOverride() {
  // YouTube'un altyazısını tamamen gizle — hem metin hem arka plan
  if (!document.getElementById("ytexp-hide-captions")) {
    const style = document.createElement("style");
    style.id = "ytexp-hide-captions";
    style.textContent = `
      .ytp-caption-segment {
        color: transparent !important;
        text-shadow: none !important;
        background: transparent !important;
      }
      .ytp-caption-segment span,
      .ytp-caption-segment-stack {
        background: transparent !important;
        background-color: transparent !important;
      }
      .caption-window,
      .ytp-caption-window-rollup,
      .captions-text > *,
      .ytp-caption-window-container > * > * {
        background: transparent !important;
        background-color: transparent !important;
      }
    `;
    document.head.appendChild(style);
  }

  // Bizim overlay'i oluştur
  createOurOverlay();

  // YT altyazı container'ını izle
  waitFor(".ytp-caption-window-container", (container) => {
    syncOurOverlay(container);

    ytSubtitleObserver?.disconnect();
    ytSubtitleObserver = new MutationObserver(() => {
      // 120ms debounce — titreme önler, okunabilirliği artırır
      clearTimeout(renderDebounceTimer);
      renderDebounceTimer = setTimeout(() => syncOurOverlay(container), 120);
    });
    ytSubtitleObserver.observe(container, { childList: true, subtree: true, characterData: true });
  });
}

// ---- Override kapat ----
function disableOverride() {
  ytSubtitleObserver?.disconnect();
  ytSubtitleObserver = null;
  clearTimeout(renderDebounceTimer);
  document.getElementById("ytexp-hide-captions")?.remove();
  ourOverlayEl?.remove(); ourOverlayEl = null;
  lastRenderedText = "";
}

// ---- Overlay oluştur ----
function createOurOverlay() {
  ourOverlayEl?.remove();

  const player = document.querySelector("#movie_player, .html5-video-player");

  ourOverlayEl = document.createElement("div");
  ourOverlayEl.id = "ytexp-caption-overlay";

  if (player && getComputedStyle(player).position !== "static") {
    ourOverlayEl.style.cssText = `
      position: absolute;
      bottom: 11%;
      left: 50%;
      transform: translateX(-50%);
      z-index: 200;
      text-align: center;
      max-width: 78%;
      pointer-events: auto;
      user-select: text;
      transition: opacity 0.15s ease;
    `;
    player.appendChild(ourOverlayEl);
  } else {
    ourOverlayEl.style.cssText = `
      position: fixed;
      bottom: 80px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483640;
      text-align: center;
      max-width: 80vw;
      pointer-events: auto;
      user-select: text;
    `;
    document.body.appendChild(ourOverlayEl);
  }
}

// ---- YT altyazısını okuyup bizimkini render et ----
function syncOurOverlay(container) {
  if (!ourOverlayEl || !overlayEnabled) return;

  const segments = [...container.querySelectorAll(".ytp-caption-segment")];
  const fullText = segments.map(s => s.textContent).join(" ").replace(/\s+/g, " ").trim();

  if (fullText === lastRenderedText) return;
  lastRenderedText = fullText;

  // Fade out → render → fade in
  ourOverlayEl.style.opacity = "0";

  setTimeout(() => {
    if (!ourOverlayEl) return;
    ourOverlayEl.innerHTML = "";
    if (!fullText) { ourOverlayEl.style.opacity = "1"; return; }

    const line = document.createElement("div");
    line.className = "ytexp-caption-line";

    fullText.split(/(\s+)/).forEach(part => {
      if (!part) return;
      if (/^\s+$/.test(part)) {
        line.appendChild(document.createTextNode(" "));
        return;
      }

      const span = document.createElement("span");
      span.className = "ytexp-word";
      span.textContent = part;

      span.addEventListener("click", (e) => {
        e.stopPropagation();
        const sel = window.getSelection();
        const selText = sel?.toString().trim();
        if (selText && selText.length > 1) {
          const r = sel.getRangeAt(0);
          lastRange = r;
          triggerExplainWithData(selText, fullText);
        } else {
          const word = part.replace(/[.,!?;:'"()[\]{}«»\-]/g, "").trim();
          if (!word) return;
          const r = span.getBoundingClientRect();
          lastRange = { getBoundingClientRect: () => r };
          triggerExplainWithData(word, fullText);
        }
      });

      line.appendChild(span);
    });

    ourOverlayEl.appendChild(line);
    ourOverlayEl.style.opacity = "1";
  }, 80);
}

function waitFor(selector, cb, tries = 60) {
  const el = document.querySelector(selector);
  if (el) { cb(el); return; }
  if (tries <= 0) return;
  setTimeout(() => waitFor(selector, cb, tries - 1), 500);
}

// ============================================================
// CONTEXT EXTRACTION
// ============================================================
function getSurroundingContext(sel, selectedText) {
  try {
    let node = sel.anchorNode;
    for (let i = 0; i < 6; i++) {
      const t = node?.textContent?.trim();
      if (t && t.length > selectedText.length && t.length < 600 && t.includes(selectedText)) return t;
      node = node?.parentElement;
    }
    for (const s of ["#ytexp-caption-overlay", ".ytp-caption-segment", "p", "article"]) {
      for (const el of document.querySelectorAll(s)) {
        const t = el.textContent?.trim();
        if (t && t.includes(selectedText) && t.length < 600) return t;
      }
    }
  } catch(e) {}
  return selectedText;
}

// ============================================================
// TOOLTIP
// ============================================================
function showTooltip(word, context, content, state, errorMsg) {
  removeTooltip();

  const T = appTheme === "dark" ? {
    bg: "#0d0d10", text: "#e8e8f0", text2: "#a0a0b8", muted: "#4a4a60",
    border: "rgba(255,255,255,0.08)", cardBg: "#16161f", cardBorder: "#3b82f6",
    ftrBg: "#13131a", ftrBorder: "rgba(255,255,255,0.07)",
    chipBg: "rgba(59,130,246,0.1)", chipColor: "#3b82f6",
    copyBtn: "#1e1e2a", copyBtnBorder: "rgba(255,255,255,0.1)", copyBtnColor: "#a0a0b8",
    cardBodyColor: "#a0a0b8"
  } : {
    bg: "#eef2ff", text: "#1e293b", text2: "#475569", muted: "#94a3b8",
    border: "#e2e8f0", cardBg: "#fff", cardBorder: "#2563eb",
    ftrBg: "#fff", ftrBorder: "#e2e8f0",
    chipBg: "#eff6ff", chipColor: "#2563eb",
    copyBtn: "#fff", copyBtnBorder: "#e2e8f0", copyBtnColor: "#475569",
    cardBodyColor: "#334155"
  };

  const rect = (typeof lastRange?.getBoundingClientRect === "function")
    ? lastRange.getBoundingClientRect()
    : { bottom: 120, left: 120, top: 100, width: 0 };

  const W = 390;
  const useAbove = (window.innerHeight - rect.bottom) < 300;
  let left = rect.left + window.scrollX;
  if (left + W > window.innerWidth + window.scrollX - 16) left = window.innerWidth + window.scrollX - W - 16;
  if (left < window.scrollX + 8) left = window.scrollX + 8;
  const top = useAbove ? rect.top + window.scrollY - 260 : rect.bottom + window.scrollY + 10;

  tooltipEl = document.createElement("div");
  tooltipEl.id = "ytexp-tooltip";
  tooltipEl.style.cssText = `
    position:absolute; top:${top}px; left:${left}px; width:${W}px;
    z-index:2147483647; font-family:'Segoe UI',system-ui,sans-serif;
    font-size:13px; line-height:1.55;
    background:${T.bg}; color:${T.text};
    border:none; border-radius:14px;
    box-shadow:0 12px 40px rgba(0,0,0,0.15); overflow:hidden;
    animation:ytexp-fadein 0.18s ease;
  `;

  // Header
  const hdr = document.createElement("div");
  hdr.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:#2563eb;";
  hdr.innerHTML = `
    <span style="display:flex;align-items:center;gap:6px;font-weight:700;font-size:11px;letter-spacing:.07em;color:#fff;text-transform:uppercase;">
      <img src="${chrome.runtime.getURL('icons/icon48.png')}" style="width:16px;height:16px;object-fit:contain;filter:brightness(0) invert(1);">
      Web Explainer
    </span>
    <button id="ytexp-close" style="background:rgba(255,255,255,0.18);border:none;cursor:pointer;color:#fff;font-size:16px;width:26px;height:26px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-family:inherit;">×</button>
  `;

  // Body
  const body = document.createElement("div");
  body.style.cssText = "padding:12px 14px;";

  if (state === "loading") {
    body.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;color:${T.text2};padding:8px 0;">
        <div style="width:15px;height:15px;border:2px solid #bfdbfe;border-top-color:#2563eb;border-radius:50%;animation:ytexp-spin 0.8s linear infinite;flex-shrink:0;"></div>
        <span>GPT yanıtı bekleniyor…</span>
      </div>
      <div style="margin-top:6px;font-size:11px;color:${T.muted};border-left:2px solid #93c5fd;padding-left:8px;font-style:italic;">"${truncate(word||"", 80)}"</div>
    `;
  } else if (state === "error") {
    body.innerHTML = `<div style="color:#dc2626;margin-bottom:4px;font-weight:600;">⚠️ Hata</div><div style="color:${T.text2};">${escHtml(errorMsg||"Bilinmeyen hata.")}</div>`;
  } else if (state === "success") {
    body.innerHTML = `<div id="ytexp-content" style="max-height:280px;overflow-y:auto;padding-right:4px;">${renderMarkdown(content, T)}</div>`;
    if (word) {
      const chip = document.createElement("div");
      chip.style.cssText = `margin-top:8px;padding:5px 12px;background:${T.chipBg};border-radius:20px;font-size:11px;color:${T.chipColor};font-weight:500;display:inline-block;`;
      chip.textContent = `• "${truncate(word, 60)}"`;
      body.appendChild(chip);
    }
  }

  tooltipEl.appendChild(hdr);
  tooltipEl.appendChild(body);

  if (state === "success") {
    const ftr = document.createElement("div");
    ftr.style.cssText = `display:flex;gap:8px;padding:10px 14px 12px;background:${T.ftrBg};border-top:1px solid ${T.ftrBorder};`;
    ftr.innerHTML = `
      <button id="ytexp-save" style="flex:1;background:#2563eb;border:none;color:#fff;cursor:pointer;border-radius:8px;font-size:12px;font-weight:600;padding:9px 10px;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:5px;">🔖 Kelimeyi Kaydet</button>
      <button id="ytexp-copy" style="flex:1;background:${T.copyBtn};border:1.5px solid ${T.copyBtnBorder};color:${T.copyBtnColor};cursor:pointer;border-radius:8px;font-size:12px;font-weight:500;padding:9px 10px;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:5px;">📋 Kopyala</button>
      <button id="ytexp-panel" style="flex:1;background:${T.copyBtn};border:1.5px solid ${T.copyBtnBorder};color:${T.chipColor};cursor:pointer;border-radius:8px;font-size:12px;font-weight:500;padding:9px 10px;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:5px;">📌 Panelde Aç</button>
    `;
    tooltipEl.appendChild(ftr);
  }

  document.body.appendChild(tooltipEl);
  document.getElementById("ytexp-close")?.addEventListener("click", dismissTooltip);

  if (state === "success") {
    document.getElementById("ytexp-copy")?.addEventListener("click", () => {
      navigator.clipboard.writeText(content||"").then(() => {
        const b = document.getElementById("ytexp-copy");
        if (b) { b.textContent = "✓ Kopyalandı!"; b.style.color = "#16a34a"; }
      });
    });
    document.getElementById("ytexp-panel")?.addEventListener("click", () => {
      chrome.runtime.sendMessage({
        type: "OPEN_SIDE_PANEL",
        payload: { word, explanation: content, context: context || "" }
      });
      removeTooltip();
    });
    document.getElementById("ytexp-save")?.addEventListener("click", () => {
      const b = document.getElementById("ytexp-save");
      b.textContent = "⏳…"; b.disabled = true;
      chrome.runtime.sendMessage(
        { type: "SAVE_WORD", payload: { word, explanation: content, context: context||"" } },
        (r) => {
          if (r?.ok) { b.textContent = "✓ Kaydedildi!"; b.style.background = "#16a34a"; }
          else { b.textContent = "Hata!"; b.style.background = "#dc2626"; }
        }
      );
    });
  }
}

document.addEventListener("keydown", (e) => { if (e.key === "Escape") { dismissTooltip(); removeSelectionIcon(); }});
document.addEventListener("mousedown", (e) => {
  if (tooltipEl && !tooltipEl.contains(e.target) && !ourOverlayEl?.contains(e.target)) dismissTooltip();
});
function removeTooltip() { tooltipEl?.remove(); tooltipEl = null; }
function dismissTooltip() { activeReqId++; removeTooltip(); }

// ============================================================
// STYLES
// ============================================================
function injectStyles() {
  if (document.getElementById("ytexp-style")) return;
  const s = document.createElement("style");
  s.id = "ytexp-style";
  s.textContent = `
    @keyframes ytexp-fadein { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
    @keyframes ytexp-spin   { to{transform:rotate(360deg)} }
    @keyframes ytexp-pop    { from{opacity:0;transform:scale(0.5)} to{opacity:1;transform:scale(1)} }

    #ytexp-tooltip strong { color:#3b82f6 }
    #ytexp-tooltip ul     { margin:4px 0; padding-left:1.2em }
    #ytexp-tooltip li     { margin:3px 0 }
    #ytexp-tooltip p      { margin:4px 0 }
    #ytexp-content::-webkit-scrollbar       { width:4px }
    #ytexp-content::-webkit-scrollbar-thumb { background:#cbd5e1; border-radius:2px }

    #ytexp-tooltip .ytexp-card {
      background:#fff; border-radius:10px; padding:12px 14px;
      margin-bottom:8px; border-left:3px solid #2563eb;
    }
    #ytexp-tooltip .ytexp-card:last-child { margin-bottom:0 }
    #ytexp-tooltip .ytexp-card-hdr {
      font-weight:700; font-size:11px; letter-spacing:.07em;
      color:#2563eb; margin-bottom:8px; text-transform:uppercase;
    }
    #ytexp-tooltip .ytexp-card-body ul { margin:4px 0; padding-left:1.2em }
    #ytexp-tooltip .ytexp-card-body li { margin:4px 0 }

    .ytexp-caption-line {
      display: inline-block;
      background: rgba(8,8,8,0.85);
      padding: 5px 12px 7px;
      border-radius: 4px;
      font-size: 19px;
      font-family: 'Roboto', 'Segoe UI', sans-serif;
      font-weight: 500;
      color: #fff;
      line-height: 1.45;
      letter-spacing: 0.01em;
      text-shadow: 0 1px 3px rgba(0,0,0,0.9);
      cursor: text;
    }

    .ytexp-word {
      cursor: pointer;
      border-radius: 3px;
      padding: 1px 2px;
      transition: background 0.1s;
    }
    .ytexp-word:hover {
      background: rgba(59,130,246,0.25);
      outline: 1px solid rgba(59,130,246,0.6);
    }

    #ytexp-caption-overlay ::selection {
      background: rgba(59,130,246,0.4);
      color: #fff;
    }
  `;
  document.head.appendChild(s);
}

// ============================================================
// HELPERS
// ============================================================
function truncate(s, n) { return s.length > n ? s.slice(0,n)+"…" : s; }
function escHtml(s) { return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function renderMarkdown(text, T) {
  if (!text) return "";
  const cardStyle  = T ? ` style="background:${T.cardBg};border-left:3px solid ${T.cardBorder};"` : "";
  const bodyStyle  = T ? ` style="color:${T.cardBodyColor};"` : "";
  let html = "";
  text.trim().split(/\n\n+/).forEach(para => {
    const m = para.match(/^\*\*(.+?)\*\*\n?([\s\S]*)/);
    if (m) {
      const heading = escHtml(m[1]).toUpperCase();
      const body = (m[2] || "").trim()
        .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
        .replace(/^[•\-]\s+(.+)$/gm, "<li>$1</li>")
        .replace(/(<li>.*<\/li>\n?)+/gs, s => `<ul>${s}</ul>`)
        .replace(/\n/g, "<br>");
      html += `<div class="ytexp-card"${cardStyle}><div class="ytexp-card-hdr">${heading}</div>${body ? `<div class="ytexp-card-body"${bodyStyle}>${body}</div>` : ""}</div>`;
    } else {
      const body = para
        .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
        .replace(/^[•\-]\s+(.+)$/gm, "<li>$1</li>")
        .replace(/(<li>.*<\/li>\n?)+/gs, s => `<ul>${s}</ul>`)
        .replace(/\n/g, "<br>");
      html += `<div class="ytexp-card"${cardStyle}><div class="ytexp-card-body"${bodyStyle}>${body}</div></div>`;
    }
  });
  return html;
}

// ============================================================
// START
// ============================================================
init();

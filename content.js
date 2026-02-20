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

const isYouTube = location.hostname.includes("youtube.com");

// YouTube subtitle override state
let overlayEnabled       = false;   // toggle durumu
let ourOverlayEl         = null;    // bizim altyazı kutusu
let ytSubtitleObserver   = null;    // YT caption DOM observer
let lastRenderedText     = "";      // gereksiz re-render önle
let renderDebounceTimer  = null;    // titreme önlemek için debounce
let toggleBtnEl          = null;    // player'daki buton

// Popup toggle (tüm extension'ı açar/kapatır)
let extensionEnabled = true;

// ============================================================
// INIT
// ============================================================
function init() {
  injectStyles();
  setupSelectionListener();
  if (isYouTube) initYouTube();
}

// ============================================================
// CHROME API INIT (try-catch: orphaned/iframe context'lara karşı)
// ============================================================
try {
  chrome.storage.local.get(["enabled"], (stored) => {
    extensionEnabled = stored.enabled !== false;
  });

  chrome.storage.onChanged.addListener((changes) => {
    if ("enabled" in changes) {
      extensionEnabled = changes.enabled.newValue !== false;
      if (!extensionEnabled) {
        removeSelectionIcon();
        removeTooltip();
      }
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "TRIGGER_EXPLAIN") triggerExplain();
  });
} catch (e) {
  // Extension context unavailable (orphaned after reload or injected into iframe)
}

// ============================================================
// SELECTION LISTENER
// ============================================================
function setupSelectionListener() {
  document.addEventListener("mouseup", (e) => setTimeout(() => handleSelection(e), 80));
  document.addEventListener("keyup",   (e) => setTimeout(() => handleSelection(e), 80));
}

function handleSelection(e) {
  if (!extensionEnabled) { removeSelectionIcon(); return; }
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
  `;
  selectionIconEl.textContent = "📘";
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
  if (!extensionEnabled) return;
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
  showTooltip(word, context, null, "loading");
  chrome.storage.local.get(["mode"], (s) => {
    chrome.runtime.sendMessage(
      { type: "EXPLAIN_TEXT", payload: { selectedText: word, context, mode: s.mode || "explain" } },
      (res) => {
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

  tryInject();
  setTimeout(() => tryInject(), 1000);
  setTimeout(() => tryInject(), 2500);
  setTimeout(() => tryInject(), 5000);
}

// ---- Toggle butonu ----
function injectToggleButton(controls) {
  if (document.getElementById("ytexp-toggle-btn")) return;
  if (!document.body.contains(controls)) return;

  toggleBtnEl = document.createElement("button");
  toggleBtnEl.id = "ytexp-toggle-btn";
  toggleBtnEl.title = "Web Explainer altyazısını aç/kapat";
  toggleBtnEl.style.cssText = `
    background: rgba(0,0,0,0.5);
    border: 1px solid rgba(255,255,255,0.25);
    border-radius: 4px;
    color: rgba(255,255,255,0.75);
    cursor: pointer;
    font-size: 11px;
    font-weight: 700;
    font-family: 'Segoe UI', sans-serif;
    letter-spacing: 0.08em;
    padding: 2px 8px;
    margin: 0 4px;
    height: 26px;
    transition: all 0.15s;
    vertical-align: middle;
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
  if (overlayEnabled) {
    toggleBtnEl.textContent = "📘 AÇ";
    toggleBtnEl.style.background = "rgba(124,58,237,0.7)";
    toggleBtnEl.style.borderColor = "rgba(167,139,250,0.8)";
    toggleBtnEl.style.color = "#fff";
  } else {
    toggleBtnEl.textContent = "📘 TR";
    toggleBtnEl.style.background = "rgba(0,0,0,0.5)";
    toggleBtnEl.style.borderColor = "rgba(255,255,255,0.25)";
    toggleBtnEl.style.color = "rgba(255,255,255,0.75)";
  }
}

// ---- Override aç ----
function enableOverride() {
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

  createOurOverlay();

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
    background:#0f0f11; color:#e8e8f0;
    border:1px solid rgba(255,255,255,0.1); border-radius:12px;
    box-shadow:0 8px 32px rgba(0,0,0,0.6); overflow:hidden;
  `;

  const hdr = document.createElement("div");
  hdr.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:10px 14px 8px;border-bottom:1px solid rgba(255,255,255,0.07);background:rgba(167,139,250,0.08);";
  hdr.innerHTML = `<span style="font-weight:700;font-size:11px;letter-spacing:.06em;color:#a78bfa;text-transform:uppercase;">📘 Web Explainer</span><button id="ytexp-close" style="background:none;border:none;cursor:pointer;color:#666;font-size:18px;line-height:1;padding:0 2px;" onmouseover="this.style.color='#fff'" onmouseout="this.style.color='#666'">×</button>`;

  const body = document.createElement("div");
  body.style.cssText = "padding:12px 14px;";

  if (state === "loading") {
    body.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;color:#777;padding:8px 0;">
        <div style="width:15px;height:15px;border:2px solid rgba(167,139,250,0.3);border-top-color:#a78bfa;border-radius:50%;animation:ytexp-spin 0.8s linear infinite;flex-shrink:0;"></div>
        <span>GPT yanıtı bekleniyor…</span>
      </div>
      <div style="margin-top:6px;font-size:11px;color:#444;border-left:2px solid #333;padding-left:8px;font-style:italic;">"${truncate(word||"", 80)}"</div>
    `;
  } else if (state === "error") {
    body.innerHTML = `<div style="color:#f87171;margin-bottom:4px;">⚠️ Hata</div><div style="color:#bbb;">${escHtml(errorMsg||"Bilinmeyen hata.")}</div>`;
  } else if (state === "success") {
    body.innerHTML = `<div id="ytexp-content" style="max-height:280px;overflow-y:auto;padding-right:4px;">${renderMarkdown(content)}</div>`;
    if (word) {
      const chip = document.createElement("div");
      chip.style.cssText = "margin-top:8px;padding:5px 8px;background:rgba(255,255,255,0.04);border-radius:6px;font-size:11px;color:#555;border-left:2px solid #a78bfa;";
      chip.textContent = `"${truncate(word, 60)}"`;
      body.appendChild(chip);
    }
  }

  tooltipEl.appendChild(hdr);
  tooltipEl.appendChild(body);

  if (state === "success") {
    const ftr = document.createElement("div");
    ftr.style.cssText = "display:flex;justify-content:flex-end;gap:8px;padding:8px 14px 10px;border-top:1px solid rgba(255,255,255,0.07);";
    ftr.innerHTML = `
      <button id="ytexp-save" style="background:rgba(74,222,128,0.1);border:1px solid rgba(74,222,128,0.3);color:#4ade80;cursor:pointer;border-radius:6px;font-size:11px;padding:4px 10px;">💾 Kelimeyi Kaydet</button>
      <button id="ytexp-copy" style="background:rgba(167,139,250,0.15);border:1px solid rgba(167,139,250,0.3);color:#a78bfa;cursor:pointer;border-radius:6px;font-size:11px;padding:4px 10px;">📋 Kopyala</button>
    `;
    tooltipEl.appendChild(ftr);
  }

  document.body.appendChild(tooltipEl);
  document.getElementById("ytexp-close")?.addEventListener("click", removeTooltip);

  if (state === "success") {
    document.getElementById("ytexp-copy")?.addEventListener("click", () => {
      navigator.clipboard.writeText(content||"").then(() => {
        const b = document.getElementById("ytexp-copy");
        if (b) { b.textContent = "✓ Kopyalandı!"; b.style.color = "#4ade80"; }
      });
    });
    document.getElementById("ytexp-save")?.addEventListener("click", () => {
      const b = document.getElementById("ytexp-save");
      b.textContent = "⏳…"; b.disabled = true;
      chrome.runtime.sendMessage(
        { type: "SAVE_WORD", payload: { word, explanation: content, context: context||"" } },
        (r) => {
          if (r?.ok) { b.textContent = "✓ Kaydedildi!"; b.style.color = "#86efac"; }
          else { b.textContent = "Hata!"; b.style.color = "#f87171"; }
        }
      );
    });
  }
}

document.addEventListener("keydown", (e) => { if (e.key === "Escape") { removeTooltip(); removeSelectionIcon(); }});
document.addEventListener("mousedown", (e) => {
  if (tooltipEl && !tooltipEl.contains(e.target) && !ourOverlayEl?.contains(e.target)) removeTooltip();
});
function removeTooltip() { tooltipEl?.remove(); tooltipEl = null; }

// ============================================================
// STYLES
// ============================================================
function injectStyles() {
  if (document.getElementById("ytexp-style")) return;
  const s = document.createElement("style");
  s.id = "ytexp-style";
  s.textContent = `
    @keyframes ytexp-spin { to{transform:rotate(360deg)} }

    #ytexp-tooltip strong { color:#a78bfa }
    #ytexp-tooltip ul     { margin:4px 0; padding-left:1.2em }
    #ytexp-tooltip li     { margin:2px 0 }
    #ytexp-tooltip p      { margin:4px 0 }
    #ytexp-content::-webkit-scrollbar       { width:4px }
    #ytexp-content::-webkit-scrollbar-thumb { background:#333; border-radius:2px }

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
      background: rgba(167,139,250,0.38);
      outline: 1px solid rgba(167,139,250,0.65);
    }

    #ytexp-caption-overlay ::selection {
      background: rgba(167,139,250,0.45);
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
function renderMarkdown(text) {
  if (!text) return "";
  return text
    .replace(/\*\*(.*?)\*\*/g,"<strong>$1</strong>")
    .replace(/^[•\-]\s+(.+)$/gm,"<li>$1</li>")
    .replace(/(<li>.*<\/li>\n?)+/gs,m=>`<ul style="margin:4px 0;">${m}</ul>`)
    .replace(/\n{2,}/g,"</p><p>").replace(/\n/g,"<br>")
    .replace(/^(?!<)/,"<p>").replace(/(?<!>)$/,"</p>")
    .replace(/<p><\/p>/g,"");
}

// ============================================================
// START
// ============================================================
init();

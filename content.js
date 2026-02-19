// ============================================================
// content.js — Content Script v2
// New features:
//   - Selection icon (mini button appears near selected text)
//   - "Save word" button in tooltip
//   - Keyboard shortcut still works too
// ============================================================

let tooltipEl = null;
let selectionIconEl = null;
let lastRange = null;
let lastSelectedText = "";
let lastContext = "";

// ---- Listen for trigger from background.js (keyboard shortcut) ----
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "TRIGGER_EXPLAIN") {
    triggerExplain();
  }
});

// ============================================================
// SELECTION ICON — appears near selected text
// ============================================================

// Watch for text selections
document.addEventListener("mouseup", (e) => {
  // Small delay to let selection finalize
  setTimeout(() => handleSelectionChange(e), 80);
});

document.addEventListener("keyup", (e) => {
  setTimeout(() => handleSelectionChange(e), 80);
});

function handleSelectionChange(e) {
  const selection = window.getSelection();

  // If clicking inside our own tooltip or icon, ignore
  if (tooltipEl?.contains(e.target) || selectionIconEl?.contains(e.target)) return;

  if (!selection || selection.isCollapsed || !selection.toString().trim()) {
    removeSelectionIcon();
    return;
  }

  const selectedText = selection.toString().trim();
  if (selectedText.length < 2) {
    removeSelectionIcon();
    return;
  }

  // Save range for positioning
  if (selection.rangeCount > 0) {
    lastRange = selection.getRangeAt(0);
    lastSelectedText = selectedText;
    lastContext = getSurroundingContext(selection, selectedText);
  }

  showSelectionIcon();
}

function showSelectionIcon() {
  removeSelectionIcon();

  if (!lastRange) return;

  const rect = lastRange.getBoundingClientRect();
  const scrollY = window.scrollY || 0;
  const scrollX = window.scrollX || 0;

  selectionIconEl = document.createElement("div");
  selectionIconEl.id = "ytexp-selection-icon";

  // Position: just above the selection, centered
  const iconLeft = rect.left + scrollX + (rect.width / 2) - 18;
  const iconTop = rect.top + scrollY - 42;

  selectionIconEl.style.cssText = `
    position: absolute;
    top: ${iconTop}px;
    left: ${iconLeft}px;
    width: 36px;
    height: 36px;
    background: linear-gradient(135deg, #7c3aed, #6366f1);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    z-index: 2147483646;
    box-shadow: 0 4px 12px rgba(124,58,237,0.5);
    font-size: 16px;
    line-height: 1;
    transition: transform 0.15s ease, box-shadow 0.15s ease;
    animation: ytexp-icon-pop 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
    user-select: none;
  `;
  selectionIconEl.title = "Türkçe açıkla (Ctrl+Shift+E)";
  selectionIconEl.textContent = "📘";

  // Hover effect
  selectionIconEl.addEventListener("mouseenter", () => {
    selectionIconEl.style.transform = "scale(1.15)";
    selectionIconEl.style.boxShadow = "0 6px 20px rgba(124,58,237,0.7)";
  });
  selectionIconEl.addEventListener("mouseleave", () => {
    selectionIconEl.style.transform = "scale(1)";
    selectionIconEl.style.boxShadow = "0 4px 12px rgba(124,58,237,0.5)";
  });

  // Click → trigger explain
  selectionIconEl.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    removeSelectionIcon();
    triggerExplainWithData(lastSelectedText, lastContext);
  });

  // Inject animation keyframe
  if (!document.getElementById("yt-explainer-style")) {
    injectStyles();
  }

  document.body.appendChild(selectionIconEl);

  // Auto-hide after 6 seconds if user doesn't click
  setTimeout(() => {
    if (selectionIconEl) removeSelectionIcon();
  }, 6000);
}

function removeSelectionIcon() {
  selectionIconEl?.remove();
  selectionIconEl = null;
}

// ============================================================
// EXPLAIN TRIGGER
// ============================================================

function triggerExplain() {
  const selection = window.getSelection();

  if (!selection || selection.isCollapsed || !selection.toString().trim()) {
    showTooltip(null, null, null, "error", "Lütfen önce bir metin seçin.");
    return;
  }

  const selectedText = selection.toString().trim();
  if (selection.rangeCount > 0) {
    lastRange = selection.getRangeAt(0);
  }

  const context = getSurroundingContext(selection, selectedText);
  triggerExplainWithData(selectedText, context);
}

function triggerExplainWithData(selectedText, context) {
  removeSelectionIcon();
  showTooltip(selectedText, context, null, "loading");

  chrome.storage.local.get(["mode"], (stored) => {
    const mode = stored.mode || "explain";

    chrome.runtime.sendMessage(
      { type: "EXPLAIN_TEXT", payload: { selectedText, context, mode } },
      (response) => {
        if (chrome.runtime.lastError) {
          showTooltip(selectedText, context, null, "error",
            "Bağlantı hatası: " + chrome.runtime.lastError.message);
          return;
        }
        if (response.ok) {
          showTooltip(selectedText, context, response.data, "success");
        } else {
          showTooltip(selectedText, context, null, "error",
            response.error || "Bilinmeyen bir hata oluştu.");
        }
      }
    );
  });
}

// ============================================================
// CONTEXT EXTRACTION
// ============================================================

function getSurroundingContext(selection, selectedText) {
  try {
    let node = selection.anchorNode;
    let attempts = 0;

    while (node && attempts < 6) {
      const text = node.textContent?.trim();
      if (text && text.length > selectedText.length && text.length < 500) {
        if (text.includes(selectedText)) return text;
      }
      node = node.parentElement;
      attempts++;
    }

    const subtitleSelectors = [
      ".ytp-caption-segment",
      ".ytd-transcript-segment-renderer",
      "[class*='caption']",
      "[class*='transcript']"
    ];

    for (const selector of subtitleSelectors) {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        const text = el.textContent?.trim();
        if (text && text.includes(selectedText) && text.length < 500) return text;
      }
    }

    const fullText = selection.anchorNode?.parentElement?.innerText || "";
    if (fullText && fullText.includes(selectedText)) {
      const sentence = extractSentence(fullText, selectedText);
      if (sentence && sentence !== selectedText) return sentence;
    }
  } catch (e) {
    console.log("[YT Explainer] Context extraction failed:", e.message);
  }
  return selectedText;
}

function extractSentence(fullText, target) {
  const idx = fullText.indexOf(target);
  if (idx === -1) return target;

  let start = idx;
  let end = idx + target.length;

  while (start > 0 && !['.','!','?','\n'].includes(fullText[start - 1])) {
    start--;
    if (idx - start > 200) break;
  }
  while (end < fullText.length && !['.','!','?','\n'].includes(fullText[end])) {
    end++;
    if (end - idx > 200) break;
  }

  return fullText.slice(start, end).trim();
}

// ============================================================
// TOOLTIP UI
// ============================================================

function showTooltip(selectedText, context, content, state, errorMsg) {
  removeTooltip();

  const rect = lastRange
    ? lastRange.getBoundingClientRect()
    : { bottom: 100, left: 100, top: 80 };

  const scrollY = window.scrollY || 0;
  const scrollX = window.scrollX || 0;
  const spaceBelow = window.innerHeight - rect.bottom;
  const useAbove = spaceBelow <= 320;
  const topPosition = useAbove
    ? rect.top + scrollY
    : rect.bottom + scrollY + 10;

  let leftPosition = rect.left + scrollX;
  const tooltipWidth = 390;
  if (leftPosition + tooltipWidth > window.innerWidth + scrollX - 20) {
    leftPosition = window.innerWidth + scrollX - tooltipWidth - 20;
  }
  if (leftPosition < scrollX + 10) leftPosition = scrollX + 10;

  tooltipEl = document.createElement("div");
  tooltipEl.id = "yt-explainer-tooltip";

  tooltipEl.style.cssText = `
    position: absolute;
    top: ${useAbove ? `calc(${topPosition}px - var(--tooltip-h, 220px) - 10px)` : `${topPosition}px`};
    left: ${leftPosition}px;
    width: ${tooltipWidth}px;
    z-index: 2147483647;
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    font-size: 13px;
    line-height: 1.55;
    background: #0f0f11;
    color: #e8e8f0;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 12px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.4);
    overflow: hidden;
    animation: ytexp-fadein 0.18s ease;
  `;

  if (!document.getElementById("yt-explainer-style")) injectStyles();

  // Header
  const header = document.createElement("div");
  header.style.cssText = `
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 14px 8px;
    border-bottom: 1px solid rgba(255,255,255,0.07);
    background: rgba(167,139,250,0.08);
  `;
  header.innerHTML = `
    <span style="font-weight:700; font-size:12px; letter-spacing:0.05em; color:#a78bfa; text-transform:uppercase;">
      📘 YT Explainer
    </span>
    <button id="ytexp-close" title="Kapat (Esc)" style="
      background:none; border:none; cursor:pointer; color:#888;
      font-size:18px; line-height:1; padding:0 2px; transition:color 0.15s;
    " onmouseover="this.style.color='#fff'" onmouseout="this.style.color='#888'">×</button>
  `;

  // Body
  const body = document.createElement("div");
  body.style.cssText = "padding: 12px 14px;";

  if (state === "loading") {
    body.innerHTML = `
      <div style="display:flex; align-items:center; gap:10px; color:#888; padding:8px 0;">
        <div style="
          width:16px; height:16px; border:2px solid rgba(167,139,250,0.3);
          border-top-color:#a78bfa; border-radius:50%;
          animation:ytexp-spin 0.8s linear infinite; flex-shrink:0;
        "></div>
        <span>GPT'den yanıt bekleniyor…</span>
      </div>
      <div style="margin-top:8px; font-size:11px; color:#555; border-left:2px solid #333; padding-left:8px; font-style:italic;">
        "${truncate(selectedText, 80)}"
      </div>
    `;
  } else if (state === "error") {
    body.innerHTML = `
      <div style="color:#f87171; font-size:13px; margin-bottom:6px;">⚠️ Hata</div>
      <div style="color:#ccc;">${escHtml(errorMsg || "Bir hata oluştu.")}</div>
      <div style="margin-top:8px; font-size:11px; color:#555;">
        Yardım: Popup'tan API anahtarınızı kontrol edin.
      </div>
    `;
  } else if (state === "success") {
    const rendered = renderMarkdown(content);
    body.innerHTML = `
      <div id="ytexp-content" style="max-height:280px; overflow-y:auto; padding-right:4px;">
        ${rendered}
      </div>
    `;

    if (selectedText) {
      const chip = document.createElement("div");
      chip.style.cssText = `
        margin-top:10px; padding:6px 8px;
        background:rgba(255,255,255,0.04); border-radius:6px;
        font-size:11px; color:#666; border-left:2px solid #a78bfa;
      `;
      chip.textContent = `Seçili: "${truncate(selectedText, 60)}"`;
      body.appendChild(chip);
    }
  }

  // Footer (success only)
  let footer = null;
  if (state === "success") {
    footer = document.createElement("div");
    footer.style.cssText = `
      display:flex; align-items:center; justify-content:flex-end;
      padding:8px 14px 10px;
      border-top:1px solid rgba(255,255,255,0.07);
      gap:8px;
    `;
    footer.innerHTML = `
      <button id="ytexp-save" style="
        background:rgba(74,222,128,0.1); border:1px solid rgba(74,222,128,0.3);
        color:#4ade80; cursor:pointer; border-radius:6px;
        font-size:11px; padding:4px 10px; transition:all 0.15s;
      " onmouseover="this.style.background='rgba(74,222,128,0.2)'"
        onmouseout="this.style.background='rgba(74,222,128,0.1)'">
        💾 Kelimeyi Kaydet
      </button>
      <button id="ytexp-copy" style="
        background:rgba(167,139,250,0.15); border:1px solid rgba(167,139,250,0.3);
        color:#a78bfa; cursor:pointer; border-radius:6px;
        font-size:11px; padding:4px 10px; transition:all 0.15s;
      " onmouseover="this.style.background='rgba(167,139,250,0.25)'"
        onmouseout="this.style.background='rgba(167,139,250,0.15)'">
        📋 Kopyala
      </button>
    `;
  }

  tooltipEl.appendChild(header);
  tooltipEl.appendChild(body);
  if (footer) tooltipEl.appendChild(footer);
  document.body.appendChild(tooltipEl);

  // Events
  document.getElementById("ytexp-close")?.addEventListener("click", removeTooltip);

  if (state === "success") {
    // Copy button
    document.getElementById("ytexp-copy")?.addEventListener("click", () => {
      navigator.clipboard.writeText(content || "").then(() => {
        const btn = document.getElementById("ytexp-copy");
        if (btn) { btn.textContent = "✓ Kopyalandı!"; btn.style.color = "#4ade80"; }
      });
    });

    // Save word button
    document.getElementById("ytexp-save")?.addEventListener("click", () => {
      const btn = document.getElementById("ytexp-save");
      btn.textContent = "⏳ Kaydediliyor…";
      btn.disabled = true;

      chrome.runtime.sendMessage(
        {
          type: "SAVE_WORD",
          payload: {
            word: selectedText,
            explanation: content,
            context: context || ""
          }
        },
        (response) => {
          if (response?.ok) {
            btn.textContent = "✓ Kaydedildi!";
            btn.style.color = "#86efac";
            btn.style.borderColor = "rgba(74,222,128,0.5)";
          } else {
            btn.textContent = "Hata!";
            btn.style.color = "#f87171";
          }
        }
      );
    });
  }
}

// Close with Escape
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { removeTooltip(); removeSelectionIcon(); }
});

// Click outside closes tooltip (but not selection icon)
document.addEventListener("mousedown", (e) => {
  if (tooltipEl && !tooltipEl.contains(e.target)) removeTooltip();
});

function removeTooltip() {
  tooltipEl?.remove();
  tooltipEl = null;
}

// ============================================================
// STYLE INJECTION
// ============================================================
function injectStyles() {
  const style = document.createElement("style");
  style.id = "yt-explainer-style";
  style.textContent = `
    @keyframes ytexp-fadein {
      from { opacity:0; transform:translateY(6px); }
      to   { opacity:1; transform:translateY(0); }
    }
    @keyframes ytexp-spin {
      to { transform:rotate(360deg); }
    }
    @keyframes ytexp-icon-pop {
      from { opacity:0; transform:scale(0.5); }
      to   { opacity:1; transform:scale(1); }
    }
    #yt-explainer-tooltip strong { color:#a78bfa; }
    #yt-explainer-tooltip ul { margin:4px 0; padding-left:1.2em; }
    #yt-explainer-tooltip li { margin:2px 0; }
    #yt-explainer-tooltip p  { margin:4px 0; }
    #ytexp-content::-webkit-scrollbar { width:4px; }
    #ytexp-content::-webkit-scrollbar-track { background:transparent; }
    #ytexp-content::-webkit-scrollbar-thumb { background:#333; border-radius:2px; }
  `;
  document.head.appendChild(style);
}

// ============================================================
// HELPERS
// ============================================================
function truncate(str, max) {
  return str.length > max ? str.slice(0, max) + "…" : str;
}

function escHtml(str) {
  return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function renderMarkdown(text) {
  if (!text) return "";
  return text
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/^[•\-]\s+(.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>\n?)+/gs, (m) => `<ul style="margin:4px 0;">${m}</ul>`)
    .replace(/\n{2,}/g, "</p><p>")
    .replace(/\n/g, "<br>")
    .replace(/^(?!<)/, "<p>")
    .replace(/(?<!>)$/, "</p>")
    .replace(/<p><\/p>/g, "");
}

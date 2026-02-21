// ============================================================
// popup.js — v3
// ============================================================

const modeDescriptions = {
  explain: "Seçili teknik kavramı Türkçe açıklar. Bağlam ve örnekler içerir.",
  translate: "Metni doğal Türkçeye çevirir, teknik terimleri not eder."
};

document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.local.get([
    "openai_api_key", "mode",
    "telegram_bot_token", "telegram_chat_id",
    "enabled", "theme"
  ], (stored) => {
    if (stored.openai_api_key) document.getElementById("api-key-input").value = stored.openai_api_key;
    if (stored.telegram_bot_token) document.getElementById("tg-token-input").value = stored.telegram_bot_token;
    if (stored.telegram_chat_id) document.getElementById("tg-chatid-input").value = stored.telegram_chat_id;
    setActiveMode(stored.mode || "explain");
    updateEnabledBtn(stored.enabled !== false);
    applyTheme(stored.theme || "light");
  });

  // Tema toggle
  document.getElementById("theme-toggle").addEventListener("click", () => {
    const isDark = document.body.getAttribute("data-theme") === "dark";
    const next = isDark ? "light" : "dark";
    applyTheme(next);
    chrome.storage.local.set({ theme: next });
  });

  // Tab navigation
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
      if (btn.dataset.tab === "vocabulary") loadVocabulary();
    });
  });

  // Settings
  document.getElementById("btn-explain").addEventListener("click", () => { setActiveMode("explain"); chrome.storage.local.set({ mode: "explain" }); });
  document.getElementById("btn-translate").addEventListener("click", () => { setActiveMode("translate"); chrome.storage.local.set({ mode: "translate" }); });
  document.getElementById("save-btn").addEventListener("click", saveApiKey);
  document.getElementById("api-key-input").addEventListener("keydown", e => { if (e.key === "Enter") saveApiKey(); });
  document.getElementById("toggle-visibility").addEventListener("click", () => {
    const input = document.getElementById("api-key-input");
    input.type = input.type === "password" ? "text" : "password";
  });

  // Vocabulary
  document.getElementById("vocab-search").addEventListener("input", e => loadVocabulary(e.target.value));
  document.getElementById("vocab-clear-btn").addEventListener("click", clearAllVocabulary);
  document.getElementById("vocab-export-btn").addEventListener("click", exportVocabulary);

  // Telegram
  document.getElementById("tg-toggle-vis").addEventListener("click", () => {
    const input = document.getElementById("tg-token-input");
    input.type = input.type === "password" ? "text" : "password";
  });
  document.getElementById("tg-save-btn").addEventListener("click", saveTelegramSettings);
  document.getElementById("tg-test-btn").addEventListener("click", testTelegram);

  // Enable/Disable toggle
  document.getElementById("toggle-enabled").addEventListener("click", () => {
    const btn = document.getElementById("toggle-enabled");
    const newState = btn.classList.contains("disabled");
    chrome.storage.local.set({ enabled: newState }, () => updateEnabledBtn(newState));
  });
});

// ============================================================
// SETTINGS
// ============================================================
function setActiveMode(mode) {
  document.getElementById("btn-explain").classList.toggle("active", mode === "explain");
  document.getElementById("btn-translate").classList.toggle("active", mode === "translate");
  document.getElementById("mode-desc").textContent = modeDescriptions[mode] || "";
}

function saveApiKey() {
  const key = document.getElementById("api-key-input").value.trim();
  if (!key) return showStatus("save-status", "Lütfen bir API anahtarı girin.", "error");
  if (!key.startsWith("sk-")) return showStatus("save-status", "Geçersiz anahtar. 'sk-' ile başlamalı.", "error");
  chrome.storage.local.set({ openai_api_key: key }, () => {
    showStatus("save-status", chrome.runtime.lastError ? "Kaydetme hatası!" : "✓ Başarıyla kaydedildi!", chrome.runtime.lastError ? "error" : "");
  });
}

// ============================================================
// VOCABULARY
// ============================================================
function loadVocabulary(filterText = "") {
  chrome.storage.local.get(["vocabulary"], (stored) => {
    const vocab = stored.vocabulary || [];
    const filtered = filterText
      ? vocab.filter(e => e.word.toLowerCase().includes(filterText.toLowerCase()))
      : vocab;

    // Stats
    const now = new Date();
    const todayStr = now.toDateString();
    const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const statTotal = document.getElementById("stat-total");
    const statWeek  = document.getElementById("stat-week");
    const statToday = document.getElementById("stat-today");
    if (statTotal) statTotal.textContent = vocab.length;
    if (statWeek)  statWeek.textContent  = vocab.filter(e => new Date(e.savedAt) >= weekAgo).length;
    if (statToday) statToday.textContent = vocab.filter(e => new Date(e.savedAt).toDateString() === todayStr).length;

    const listEl = document.getElementById("vocab-list");
    listEl.innerHTML = "";

    if (filtered.length === 0) {
      listEl.innerHTML = `<div class="vocab-empty">${filterText ? "Eşleşen kelime yok." : "Henüz kelime yok.<br>Bir kelimeyi açıkla ve 💾 butonuna bas!"}</div>`;
      return;
    }

    filtered.forEach(entry => {
      const item = document.createElement("div");
      item.className = "vocab-item";
      const savedDate = new Date(entry.savedAt).toLocaleDateString("tr-TR");
      const firstLetter = (entry.word || "?").charAt(0).toUpperCase();
      const previewLine = entry.explanation.split("\n").find(l => l.trim() && !l.startsWith("**")) || "";

      item.innerHTML = `
        <div class="vocab-avatar">${escHtml(firstLetter)}</div>
        <div class="vocab-item-body">
          <div class="vocab-item-word">${escHtml(entry.word)}</div>
          <div class="vocab-item-preview">${escHtml(previewLine.replace(/\*\*/g, ""))}</div>
        </div>
        <div class="vocab-item-right">
          <span class="vocab-item-meta">${savedDate}</span>
          <button class="vocab-item-delete" data-id="${entry.id}">×</button>
        </div>
      `;

      item.addEventListener("click", (e) => {
        if (e.target.classList.contains("vocab-item-delete")) return;
        showWordDetail(entry);
      });
      item.querySelector(".vocab-item-delete").addEventListener("click", (e) => {
        e.stopPropagation();
        deleteWord(entry.id);
      });

      listEl.appendChild(item);
    });
  });
}

function showWordDetail(entry) {
  document.getElementById("vocab-detail-modal")?.remove();

  const modal = document.createElement("div");
  modal.id = "vocab-detail-modal";
  modal.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;";

  const box = document.createElement("div");
  box.style.cssText = "background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;padding:16px;max-height:400px;overflow-y:auto;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.15);";
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <strong style="color:#1e293b;font-size:15px;">${escHtml(entry.word)}</strong>
      <button id="close-detail" style="background:#f1f5f9;border:none;color:#64748b;cursor:pointer;font-size:18px;width:28px;height:28px;border-radius:6px;display:flex;align-items:center;justify-content:center;">×</button>
    </div>
    <div style="font-size:11px;color:#94a3b8;margin-bottom:10px;">
      ${new Date(entry.savedAt).toLocaleString("tr-TR")} • ${entry.reviewCount || 0}x gönderildi
    </div>
    <div style="font-size:12px;color:#475569;line-height:1.6;">${renderMarkdownSimple(entry.explanation)}</div>
    ${entry.context ? `<div style="margin-top:10px;padding:6px 8px;background:#f8fafc;border-radius:6px;font-size:11px;color:#64748b;border-left:2px solid #3b82f6;">Bağlam: "${escHtml(entry.context)}"</div>` : ""}
  `;

  modal.appendChild(box);
  document.body.appendChild(modal);
  document.getElementById("close-detail").addEventListener("click", () => modal.remove());
  modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });
}

function deleteWord(id) {
  chrome.storage.local.get(["vocabulary"], (stored) => {
    const vocab = (stored.vocabulary || []).filter(e => e.id !== id);
    chrome.storage.local.set({ vocabulary: vocab }, () =>
      loadVocabulary(document.getElementById("vocab-search").value)
    );
  });
}

function clearAllVocabulary() {
  if (!confirm("Tüm kelimeler silinecek. Emin misin?")) return;
  chrome.storage.local.set({ vocabulary: [] }, () => loadVocabulary());
}

function exportVocabulary() {
  chrome.storage.local.get(["vocabulary"], (stored) => {
    const vocab = stored.vocabulary || [];
    if (!vocab.length) return showStatus("vocab-export-status", "Dışa aktarılacak kelime yok.", "error");
    const text = vocab.map(e => `${e.word}\n${e.explanation}`).join("\n\n---\n\n");
    navigator.clipboard.writeText(text)
      .then(() => showStatus("vocab-export-status", `✓ ${vocab.length} kelime panoya kopyalandı!`, ""))
      .catch(() => showStatus("vocab-export-status", "Kopyalama başarısız.", "error"));
  });
}

// ============================================================
// TELEGRAM
// ============================================================
function saveTelegramSettings() {
  const token = document.getElementById("tg-token-input").value.trim();
  const chatId = document.getElementById("tg-chatid-input").value.trim();
  if (!token) return showStatus("tg-save-status", "Bot token gerekli!", "error");
  if (!chatId) return showStatus("tg-save-status", "Chat ID gerekli!", "error");
  if (!chatId.match(/^-?\d+$/)) return showStatus("tg-save-status", "Chat ID sadece rakam olmalı.", "error");
  chrome.storage.local.set({ telegram_bot_token: token, telegram_chat_id: chatId }, () => {
    showStatus("tg-save-status", "✓ Telegram ayarları kaydedildi!", "");
  });
}

function testTelegram() {
  const btn = document.getElementById("tg-test-btn");
  const token = document.getElementById("tg-token-input").value.trim();
  const chatId = document.getElementById("tg-chatid-input").value.trim();

  if (!token || !chatId) {
    showStatus("tg-test-status", "Önce token ve Chat ID gir!", "error");
    return;
  }

  btn.textContent = "⏳ Gönderiliyor…"; btn.disabled = true;

  chrome.runtime.sendMessage({ type: "TEST_TELEGRAM" }, (response) => {
    btn.disabled = false; btn.textContent = "📤 Şimdi Test Gönder";
    if (chrome.runtime.lastError) {
      const err = chrome.runtime.lastError.message || "";
      if (!err.includes("message port closed")) {
        showStatus("tg-test-status", "⏳ Gönderim devam ediyor, Telegram'ı kontrol et.", "");
      }
      return;
    }
    if (!response) { showStatus("tg-test-status", "⏳ Gönderim devam ediyor…", ""); return; }
    if (response.ok) {
      showStatus("tg-test-status", response.sent === 0 ? "✓ Bağlantı tamam! (Kelime deposu boş)" : `✓ ${response.sent} kelime gönderildi!`, "");
    } else {
      showStatus("tg-test-status", "Hata: " + (response.error || "Bilinmeyen"), "error");
    }
  });
}

// ============================================================
// HELPERS
// ============================================================
function applyTheme(theme) {
  document.body.setAttribute("data-theme", theme === "dark" ? "dark" : "");
  const btn = document.getElementById("theme-toggle");
  if (btn) btn.textContent = theme === "dark" ? "☀️" : "🌙";
}

function updateEnabledBtn(isEnabled) {
  const btn = document.getElementById("toggle-enabled");
  if (!btn) return;
  btn.innerHTML = `<span class="dot"></span>${isEnabled ? " Aktif" : " Devre Dışı"}`;
  btn.classList.toggle("disabled", !isEnabled);
}

function showStatus(elId, msg, type) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = msg;
  el.className = "save-status" + (type ? ` ${type}` : "");
  setTimeout(() => { el.textContent = ""; el.className = "save-status"; }, 4000);
}

function escHtml(str) {
  if (!str) return "";
  return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function renderMarkdownSimple(text) {
  if (!text) return "";
  return text
    .replace(/\*\*(.*?)\*\*/g, "<strong style='color:#2563eb'>$1</strong>")
    .replace(/^[•\-]\s+(.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>\n?)+/gs, m => `<ul style="padding-left:1.2em;margin:4px 0">${m}</ul>`)
    .replace(/\n{2,}/g, "<br><br>")
    .replace(/\n/g, "<br>");
}

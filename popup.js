// ============================================================
// popup.js — Popup Logic v2
// Handles: tabs, mode toggle, API key, vocabulary list, Telegram settings
// ============================================================

const modeDescriptions = {
  explain: "Seçili teknik kavramı Türkçe açıklar. Bağlam ve örnekler içerir.",
  translate: "Metni doğal Türkçeye çevirir, teknik terimleri not eder."
};

// ============================================================
// INIT
// ============================================================
document.addEventListener("DOMContentLoaded", () => {

  // Load all saved settings
  chrome.storage.local.get([
    "openai_api_key", "mode",
    "telegram_bot_token", "telegram_chat_id",
    "vocabulary"
  ], (stored) => {
    if (stored.openai_api_key) {
      document.getElementById("api-key-input").value = stored.openai_api_key;
    }
    if (stored.telegram_bot_token) {
      document.getElementById("tg-token-input").value = stored.telegram_bot_token;
    }
    if (stored.telegram_chat_id) {
      document.getElementById("tg-chatid-input").value = stored.telegram_chat_id;
    }

    setActiveMode(stored.mode || "explain");
  });

  // ---- TAB NAVIGATION ----
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));

      btn.classList.add("active");
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");

      // Load vocabulary when switching to that tab
      if (btn.dataset.tab === "vocabulary") loadVocabulary();
    });
  });

  // ---- SETTINGS TAB ----
  document.getElementById("btn-explain").addEventListener("click", () => {
    setActiveMode("explain"); chrome.storage.local.set({ mode: "explain" });
  });
  document.getElementById("btn-translate").addEventListener("click", () => {
    setActiveMode("translate"); chrome.storage.local.set({ mode: "translate" });
  });

  document.getElementById("save-btn").addEventListener("click", saveApiKey);
  document.getElementById("api-key-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveApiKey();
  });
  document.getElementById("toggle-visibility").addEventListener("click", () => {
    const input = document.getElementById("api-key-input");
    input.type = input.type === "password" ? "text" : "password";
  });

  // ---- VOCABULARY TAB ----
  document.getElementById("vocab-search").addEventListener("input", (e) => {
    loadVocabulary(e.target.value);
  });
  document.getElementById("vocab-clear-btn").addEventListener("click", clearAllVocabulary);

  // ---- TELEGRAM TAB ----
  document.getElementById("tg-toggle-vis").addEventListener("click", () => {
    const input = document.getElementById("tg-token-input");
    input.type = input.type === "password" ? "text" : "password";
  });
  document.getElementById("tg-save-btn").addEventListener("click", saveTelegramSettings);
  document.getElementById("tg-test-btn").addEventListener("click", testTelegram);
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
    if (chrome.runtime.lastError) {
      showStatus("save-status", "Kaydetme hatası!", "error");
    } else {
      showStatus("save-status", "✓ Başarıyla kaydedildi!", "");
    }
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

    const countEl = document.getElementById("vocab-count");
    countEl.textContent = `${vocab.length} kayıtlı kelime`;

    const listEl = document.getElementById("vocab-list");
    listEl.innerHTML = "";

    if (filtered.length === 0) {
      listEl.innerHTML = `<div class="vocab-empty">${
        filterText ? "Eşleşen kelime bulunamadı." : "Henüz kayıtlı kelime yok.<br>Bir kelimeyi açıklayıp 💾 butonuna bas!"
      }</div>`;
      return;
    }

    filtered.forEach(entry => {
      const item = document.createElement("div");
      item.className = "vocab-item";

      const savedDate = new Date(entry.savedAt).toLocaleDateString("tr-TR");
      const reviewInfo = entry.lastReviewed
        ? `• ${entry.reviewCount}x tekrar edildi`
        : "• Henüz gönderilmedi";

      // Get first non-empty line of explanation as preview
      const previewLine = entry.explanation
        .split("\n")
        .find(line => line.trim() && !line.startsWith("**")) || "";

      item.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:flex-start;">
          <div class="vocab-item-word">${escHtml(entry.word)}</div>
          <button class="vocab-item-delete" data-id="${entry.id}" title="Sil">×</button>
        </div>
        <div class="vocab-item-meta">${savedDate} ${reviewInfo}</div>
        <div class="vocab-item-preview">${escHtml(previewLine.replace(/\*\*/g, ""))}</div>
      `;

      // Click to expand full explanation
      item.addEventListener("click", (e) => {
        if (e.target.classList.contains("vocab-item-delete")) return;
        showWordDetail(entry);
      });

      // Delete button
      item.querySelector(".vocab-item-delete").addEventListener("click", (e) => {
        e.stopPropagation();
        deleteWord(entry.id);
      });

      listEl.appendChild(item);
    });
  });
}

function showWordDetail(entry) {
  // Simple inline expand: replace preview with full explanation
  const existingDetail = document.getElementById("vocab-detail-modal");
  if (existingDetail) existingDetail.remove();

  const modal = document.createElement("div");
  modal.id = "vocab-detail-modal";
  modal.style.cssText = `
    position: fixed; inset: 0; background: rgba(0,0,0,0.8);
    z-index: 9999; display: flex; align-items: center; justify-content: center;
    padding: 16px;
  `;

  const box = document.createElement("div");
  box.style.cssText = `
    background: #0f0f11; border: 1px solid rgba(167,139,250,0.3);
    border-radius: 12px; padding: 16px; max-height: 400px; overflow-y: auto;
    width: 100%;
  `;

  box.innerHTML = `
    <div style="display:flex; justify-content:space-between; margin-bottom:10px;">
      <strong style="color:#c4b5fd; font-size:15px;">${escHtml(entry.word)}</strong>
      <button id="close-detail" style="background:none;border:none;color:#888;cursor:pointer;font-size:18px;">×</button>
    </div>
    <div style="font-size:12px; color:#888; margin-bottom:10px;">
      Kaydedildi: ${new Date(entry.savedAt).toLocaleString("tr-TR")} •
      ${entry.reviewCount || 0}x Telegram'da gösterildi
    </div>
    <div style="font-size:12px; color:#ccc; line-height:1.6;">
      ${renderMarkdownSimple(entry.explanation)}
    </div>
    ${entry.context ? `
    <div style="margin-top:10px; padding:6px 8px; background:rgba(255,255,255,0.04); border-radius:6px; font-size:11px; color:#555; border-left:2px solid #a78bfa;">
      Bağlam: "${escHtml(entry.context)}"
    </div>` : ""}
  `;

  modal.appendChild(box);
  document.body.appendChild(modal);

  document.getElementById("close-detail").addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });
}

function deleteWord(id) {
  chrome.storage.local.get(["vocabulary"], (stored) => {
    const vocab = (stored.vocabulary || []).filter(e => e.id !== id);
    chrome.storage.local.set({ vocabulary: vocab }, () => loadVocabulary(
      document.getElementById("vocab-search").value
    ));
  });
}

function clearAllVocabulary() {
  if (!confirm("Tüm kelimeler silinecek. Emin misin?")) return;
  chrome.storage.local.set({ vocabulary: [] }, () => loadVocabulary());
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

  chrome.storage.local.set({
    telegram_bot_token: token,
    telegram_chat_id: chatId
  }, () => {
    showStatus("tg-save-status", "✓ Telegram ayarları kaydedildi!", "");
  });
}

function testTelegram() {
  const btn = document.getElementById("tg-test-btn");
  btn.textContent = "⏳ Gönderiliyor…";
  btn.disabled = true;

  // Önce ayarları kaydet, sonra mesaj gönder
  const token = document.getElementById("tg-token-input").value.trim();
  const chatId = document.getElementById("tg-chatid-input").value.trim();

  if (!token || !chatId) {
    btn.disabled = false;
    btn.textContent = "📤 Şimdi Test Gönder";
    showStatus("tg-test-status", "Önce token ve Chat ID gir!", "error");
    return;
  }

  chrome.runtime.sendMessage({ type: "TEST_TELEGRAM" }, (response) => {
    // Port kapanma hatasını sessizce yut — zararsız
    if (chrome.runtime.lastError) {
      const errMsg = chrome.runtime.lastError.message || "";
      // "message port closed" hatası zararsız, sadece popup hızlı kapandı demek
      if (!errMsg.includes("message port closed")) {
        console.warn("[YT Explainer] Telegram test error:", errMsg);
      }
    }

    btn.disabled = false;
    btn.textContent = "📤 Şimdi Test Gönder";

    if (!response) {
      // Cevap gelmedi ama bu genellikle mesaj yolda demek — hata değil
      showStatus("tg-test-status", "⏳ Gönderim devam ediyor, Telegram'ı kontrol et.", "");
      return;
    }

    if (response.ok) {
      const count = response.sent;
      if (count === 0) {
        showStatus("tg-test-status", "✓ Bağlantı tamam! (Kelime deposu henüz boş)", "");
      } else {
        showStatus("tg-test-status", `✓ ${count} kelime Telegram'a gönderildi!`, "");
      }
    } else {
      showStatus("tg-test-status", "Hata: " + (response.error || "Bilinmeyen"), "error");
    }
  });
}

// ============================================================
// HELPERS
// ============================================================
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
    .replace(/\*\*(.*?)\*\*/g, "<strong style='color:#a78bfa'>$1</strong>")
    .replace(/^[•\-]\s+(.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>\n?)+/gs, m => `<ul style="padding-left:1.2em;margin:4px 0">${m}</ul>`)
    .replace(/\n{2,}/g, "<br><br>")
    .replace(/\n/g, "<br>");
}

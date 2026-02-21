// ============================================================
// sidepanel.js — Web Explainer Side Panel
// ============================================================

let chatHistory   = [];   // { role, content }[]
let currentEntry  = null;

// ============================================================
// INIT
// ============================================================
document.addEventListener("DOMContentLoaded", () => {
  // Kaydedilmiş tema + kelime + vocabulary yükle
  chrome.storage.local.get(["panel_word", "theme", "vocabulary"], (s) => {
    applyTheme(s.theme || "light");
    if (s.panel_word) showWord(s.panel_word);
    renderVocab(s.vocabulary || []);
  });

  // Storage değişikliklerini dinle
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.theme)      applyTheme(changes.theme.newValue || "light");
    if (changes.panel_word) { chatHistory = []; showWord(changes.panel_word.newValue); }
    if (changes.vocabulary) renderVocab(changes.vocabulary.newValue || []);
  });

  // Tab navigation
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    });
  });

  // Tema toggle
  document.getElementById("theme-toggle").addEventListener("click", () => {
    const isDark = document.body.getAttribute("data-theme") === "dark";
    const next = isDark ? "light" : "dark";
    applyTheme(next);
    chrome.storage.local.set({ theme: next });
  });

  // Chat gönder — buton
  document.getElementById("chat-send").addEventListener("click", submitChat);

  // Chat gönder — Enter tuşu
  document.getElementById("chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitChat(); }
  });

  // Kaydet butonu
  document.getElementById("panel-save-btn").addEventListener("click", saveCurrentWord);

  // Vocab arama
  document.getElementById("vocab-search").addEventListener("input", (e) => {
    chrome.storage.local.get(["vocabulary"], (s) => renderVocab(s.vocabulary || [], e.target.value));
  });
});

// ============================================================
// WORD DISPLAY
// ============================================================
function showWord(entry) {
  currentEntry = entry;

  document.getElementById("panel-empty").style.display   = "none";
  document.getElementById("panel-word-view").style.display = "flex";

  document.getElementById("panel-word-title").textContent = entry.word;
  document.getElementById("panel-word-meta").textContent  =
    new Date(entry.ts || Date.now()).toLocaleString("tr-TR");

  document.getElementById("panel-word-content").innerHTML = renderMarkdownPanel(entry.explanation);

  // Kaydet butonunu sıfırla
  const saveBtn = document.getElementById("panel-save-btn");
  saveBtn.textContent = "🔖 Kelimeyi Kaydet";
  saveBtn.disabled = false;
  document.getElementById("panel-save-status").textContent = "";

  // Chat geçmişini temizle, system prompt hazırla
  chatHistory = [{
    role: "system",
    content: `Sen bir Türkçe teknik terimler asistanısın. Kullanıcı "${entry.word}" hakkında soru soracak. ` +
             `Mevcut açıklama:\n${entry.explanation}\n\nKısa, net ve Türkçe cevaplar ver.`
  }];
  document.getElementById("chat-messages").innerHTML = "";
  document.getElementById("chat-input").value = "";
}

// ============================================================
// SAVE WORD
// ============================================================
function saveCurrentWord() {
  if (!currentEntry) return;
  const btn = document.getElementById("panel-save-btn");
  btn.textContent = "⏳…"; btn.disabled = true;

  chrome.runtime.sendMessage(
    {
      type: "SAVE_WORD",
      payload: { word: currentEntry.word, explanation: currentEntry.explanation, context: currentEntry.context || "" }
    },
    (r) => {
      if (r?.ok) {
        btn.textContent = "✓ Kaydedildi!";
        btn.style.background = "#16a34a";
      } else {
        btn.textContent = "Hata!";
        btn.style.background = "#dc2626";
        btn.disabled = false;
      }
    }
  );
}

// ============================================================
// CHAT
// ============================================================
function submitChat() {
  const input = document.getElementById("chat-input");
  const text  = input.value.trim();
  if (!text || !currentEntry) return;
  input.value = "";

  appendBubble("user", text);
  chatHistory.push({ role: "user", content: text });

  const loadingEl = appendLoading();
  const sendBtn = document.getElementById("chat-send");
  sendBtn.disabled = true;

  chrome.runtime.sendMessage(
    { type: "CHAT_MESSAGE", payload: { messages: chatHistory } },
    (res) => {
      loadingEl.remove();
      sendBtn.disabled = false;
      if (chrome.runtime.lastError || !res?.ok) {
        appendBubble("ai", "⚠️ Hata: " + (res?.error || "Bağlantı sorunu."));
        return;
      }
      chatHistory.push({ role: "assistant", content: res.data });
      appendBubble("ai", res.data);
    }
  );
}

function appendBubble(role, text) {
  const messages = document.getElementById("chat-messages");
  const el = document.createElement("div");
  el.className = `chat-bubble chat-bubble-${role === "user" ? "user" : "ai"}`;
  el.innerHTML = role === "ai" ? renderMarkdownChat(text) : escHtml(text);
  messages.appendChild(el);
  messages.scrollTop = messages.scrollHeight;
  return el;
}

function appendLoading() {
  const messages = document.getElementById("chat-messages");
  const el = document.createElement("div");
  el.className = "chat-bubble chat-bubble-ai chat-bubble-loading";
  el.innerHTML = `<span class="chat-dot"></span><span class="chat-dot"></span><span class="chat-dot"></span>`;
  messages.appendChild(el);
  messages.scrollTop = messages.scrollHeight;
  return el;
}

// ============================================================
// VOCABULARY
// ============================================================
function renderVocab(vocab, filterText = "") {
  const now      = new Date();
  const weekAgo  = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const todayStr = now.toDateString();

  const total = document.getElementById("stat-total");
  const week  = document.getElementById("stat-week");
  const today = document.getElementById("stat-today");
  if (total) total.textContent = vocab.length;
  if (week)  week.textContent  = vocab.filter(e => new Date(e.savedAt) >= weekAgo).length;
  if (today) today.textContent = vocab.filter(e => new Date(e.savedAt).toDateString() === todayStr).length;

  const filtered = filterText
    ? vocab.filter(e => e.word.toLowerCase().includes(filterText.toLowerCase()))
    : vocab;

  const listEl = document.getElementById("vocab-list");
  listEl.innerHTML = "";

  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="vocab-empty">${filterText ? "Eşleşen kelime yok." : "Henüz kelime yok."}</div>`;
    return;
  }

  filtered.forEach(entry => {
    const item = document.createElement("div");
    item.className = "vocab-item";
    const savedDate  = new Date(entry.savedAt).toLocaleDateString("tr-TR");
    const firstLetter = (entry.word || "?").charAt(0).toUpperCase();
    const preview = entry.explanation.split("\n").find(l => l.trim() && !l.startsWith("**")) || "";

    item.innerHTML = `
      <div class="vocab-avatar">${escHtml(firstLetter)}</div>
      <div class="vocab-item-body">
        <div class="vocab-item-word">${escHtml(entry.word)}</div>
        <div class="vocab-item-preview">${escHtml(preview.replace(/\*\*/g, ""))}</div>
      </div>
      <span class="vocab-item-meta">${savedDate}</span>
    `;

    item.addEventListener("click", () => {
      // Kelimeyi panel_word'e yaz → showWord tetiklenir
      chrome.storage.local.set({
        panel_word: {
          word: entry.word,
          explanation: entry.explanation,
          context: entry.context || "",
          ts: new Date(entry.savedAt).getTime()
        }
      }, () => {
        // Açıklama sekmesine geç
        document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
        document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
        document.querySelector("[data-tab='explain']").classList.add("active");
        document.getElementById("tab-explain").classList.add("active");
      });
    });

    listEl.appendChild(item);
  });
}

// ============================================================
// THEME
// ============================================================
function applyTheme(theme) {
  document.body.setAttribute("data-theme", theme === "dark" ? "dark" : "");
  const btn = document.getElementById("theme-toggle");
  if (btn) btn.textContent = theme === "dark" ? "☀️" : "🌙";
}

// ============================================================
// HELPERS
// ============================================================
function escHtml(s) {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderMarkdownPanel(text) {
  if (!text) return "";
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
      html += `<div class="panel-card"><div class="panel-card-hdr">${heading}</div>${body ? `<div class="panel-card-body">${body}</div>` : ""}</div>`;
    } else {
      const body = para
        .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
        .replace(/^[•\-]\s+(.+)$/gm, "<li>$1</li>")
        .replace(/(<li>.*<\/li>\n?)+/gs, s => `<ul>${s}</ul>`)
        .replace(/\n/g, "<br>");
      html += `<div class="panel-card"><div class="panel-card-body">${body}</div></div>`;
    }
  });
  return html;
}

function renderMarkdownChat(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/^[•\-]\s+(.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>\n?)+/gs, s => `<ul style="padding-left:1.2em;margin:4px 0">${s}</ul>`)
    .replace(/\n{2,}/g, "<br><br>")
    .replace(/\n/g, "<br>");
}

// ============================================================
// background.js — Service Worker v2
// Handles: keyboard shortcut, OpenAI API, vocabulary storage,
//          Telegram daily sender via chrome.alarms
// ============================================================

// ---- Setup daily alarm when extension installs ----
chrome.runtime.onInstalled.addListener(() => {
  scheduleDailyAlarm();
});

// Also reschedule on browser startup (alarms can reset)
chrome.runtime.onStartup.addListener(() => {
  scheduleDailyAlarm();
});

// ---- Schedule a daily alarm at 15:00 local time ----
function scheduleDailyAlarm() {
  chrome.alarms.get("daily-telegram", (existing) => {
    if (existing) return; // Already scheduled

    const now = new Date();
    const target = new Date();
    target.setHours(15, 0, 0, 0); // 15:00

    // If 15:00 already passed today, schedule for tomorrow
    if (now >= target) {
      target.setDate(target.getDate() + 1);
    }

    const delayInMinutes = (target - now) / 1000 / 60;

    chrome.alarms.create("daily-telegram", {
      delayInMinutes: delayInMinutes,
      periodInMinutes: 24 * 60 // Repeat every 24 hours
    });

    console.log(`[YT Explainer] Daily alarm set. Next fire in ${Math.round(delayInMinutes)} minutes.`);
  });
}

// ---- Listen for alarm firing ----
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "daily-telegram") {
    sendDailyTelegramWords();
  }
});

// ---- Listen for keyboard shortcut ----
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "explain-selection") return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  chrome.tabs.sendMessage(tab.id, { type: "TRIGGER_EXPLAIN" });
});

// ---- Listen for messages from content.js ----
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // Explain text via OpenAI
  if (message.type === "EXPLAIN_TEXT") {
    handleExplain(message.payload)
      .then((result) => sendResponse({ ok: true, data: result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  // Save a word to vocabulary
  if (message.type === "SAVE_WORD") {
    saveWord(message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  // Manual Telegram test trigger from popup
  if (message.type === "TEST_TELEGRAM") {
    sendDailyTelegramWords(true)
      .then((result) => {
        try { sendResponse({ ok: true, sent: result }); } catch(e) {}
      })
      .catch((err) => {
        try { sendResponse({ ok: false, error: err.message }); } catch(e) {}
      });
    return true;
  }

  // Reschedule alarm (called when user changes time in settings)
  if (message.type === "RESCHEDULE_ALARM") {
    chrome.alarms.clear("daily-telegram", () => scheduleDailyAlarm());
    sendResponse({ ok: true });
    return true;
  }
});

// ============================================================
// OPENAI
// ============================================================
async function handleExplain({ selectedText, context, mode }) {
  const stored = await chrome.storage.local.get(["openai_api_key"]);
  const apiKey = stored.openai_api_key;

  if (!apiKey) {
    throw new Error("API anahtarı bulunamadı. Lütfen uzantı popup'ından OpenAI API anahtarınızı girin.");
  }

  const prompt = buildPrompt(selectedText, context, mode || "explain");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 400,
      temperature: 0.4,
      messages: [
        { role: "system", content: getSystemPrompt(mode || "explain") },
        { role: "user", content: prompt }
      ]
    })
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    const errMsg = errBody?.error?.message || `HTTP ${response.status}`;
    throw new Error(`OpenAI hatası: ${errMsg}`);
  }

  const data = await response.json();
  return data.choices[0].message.content.trim();
}

function getSystemPrompt(mode) {
  if (mode === "translate") {
    return `Sen bir teknik çeviri asistanısın. Kullanıcı sana İngilizce teknik bir metin verecek.
Görevin:
1. Metni doğal Türkçeye çevir (kelimesi kelimesine değil, anlamlı ve akıcı)
2. Teknik terimleri kısa parantez notlarıyla açıkla (örn: "CLI (komut satırı arayüzü)")
3. Yanıtını şu formatta ver:

**Türkçe Çeviri:**
[çeviri buraya]

**Teknik Terimler:**
• [terim]: [kısa açıklama]
• [terim]: [kısa açıklama]`;
  }

  return `Sen bir teknik eğitim asistanısın. Kullanıcı sana bir YouTube teknik videosundan seçilmiş İngilizce bir kavram veya cümle verecek.
Görevin:
1. Kavramın teknik anlamını bağlama göre kısaca Türkçe açıkla (2-3 cümle)
2. 2-3 madde halinde teknik detay, örnek veya benzetme sun
3. (İsteğe bağlı) Tek satır İngilizce tanım ekle

Yanıtını KESINLIKLE şu formatta ver:

**Teknik Açıklama:**
[Türkçe açıklama]

**Detaylar:**
• [madde 1]
• [madde 2]
• [madde 3 — örnek veya benzetme]

**English Definition:**
[one-line definition]`;
}

function buildPrompt(selectedText, context, mode) {
  let prompt = `Seçilen metin: "${selectedText}"`;
  if (context && context.trim() && context.trim() !== selectedText.trim()) {
    prompt += `\n\nBağlam (çevresindeki cümle/altyazı satırı): "${context}"`;
  }
  if (mode === "translate") {
    prompt += `\n\nLütfen yukarıdaki metni açıkladığım formatta çevir.`;
  } else {
    prompt += `\n\nLütfen bu teknik kavramı/ifadeyi açıkladığım formatta Türkçe açıkla.`;
  }
  return prompt;
}

// ============================================================
// VOCABULARY STORAGE
// ============================================================

// Save a word entry to chrome.storage
async function saveWord({ word, explanation, context }) {
  const stored = await chrome.storage.local.get(["vocabulary"]);
  const vocab = stored.vocabulary || [];

  // Avoid exact duplicates (same word)
  const alreadyExists = vocab.some(
    (entry) => entry.word.toLowerCase() === word.toLowerCase()
  );
  if (alreadyExists) return;

  const entry = {
    id: Date.now(),
    word: word,
    explanation: explanation,
    context: context || "",
    savedAt: new Date().toISOString(),
    reviewCount: 0,           // How many times sent via Telegram
    lastReviewed: null        // ISO date of last Telegram send
  };

  vocab.unshift(entry); // Add to front (newest first)

  // Cap at 500 words max
  if (vocab.length > 500) vocab.pop();

  await chrome.storage.local.set({ vocabulary: vocab });
}

// ============================================================
// TELEGRAM DAILY SENDER
// ============================================================

async function sendDailyTelegramWords(isTest = false) {
  const stored = await chrome.storage.local.get([
    "telegram_bot_token",
    "telegram_chat_id",
    "vocabulary"
  ]);

  const botToken = stored.telegram_bot_token;
  const chatId = stored.telegram_chat_id;
  const vocab = stored.vocabulary || [];

  if (!botToken || !chatId) {
    console.log("[YT Explainer] Telegram credentials not set, skipping.");
    return 0;
  }

  if (vocab.length === 0) {
    if (isTest) {
      await sendTelegramMessage(botToken, chatId,
        "📚 *YT Explainer*\n\nHenüz kayıtlı kelimen yok\\! Önce YouTube'da birkaç kelime açıkla ve kaydet\\."
      );
    }
    return 0;
  }

  // Pick 5 words that haven't been sent in the last 3 days
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

  const eligible = vocab.filter(
    (entry) => !entry.lastReviewed || entry.lastReviewed < threeDaysAgo
  );

  // If not enough eligible words, fall back to least recently reviewed
  const pool = eligible.length >= 5
    ? eligible
    : [...vocab].sort((a, b) => {
        const aDate = a.lastReviewed || "0";
        const bDate = b.lastReviewed || "0";
        return aDate.localeCompare(bDate); // oldest first
      });

  // Take 5 (or fewer if vocab is small)
  const selected = pool.slice(0, Math.min(5, pool.length));

  // Build the Telegram message
  const today = new Date().toLocaleDateString("tr-TR", {
    weekday: "long", day: "numeric", month: "long"
  });

  let message = `📚 *YT Explainer — Günlük Tekrar*\n`;
  message += `_${escapeMarkdown(today)}_\n`;
  message += `━━━━━━━━━━━━━━━━━━━━\n\n`;

  selected.forEach((entry, i) => {
    message += `*${i + 1}\\. ${escapeMarkdown(entry.word)}*\n`;

    // Send only first 2 lines of explanation to keep it short
    const shortExplanation = entry.explanation
      .split("\n")
      .filter(line => line.trim())
      .slice(0, 3)
      .join("\n");

    message += `${escapeMarkdown(shortExplanation)}\n\n`;
  });

  message += `━━━━━━━━━━━━━━━━━━━━\n`;
  message += `_${selected.length} kelime • Toplam deponda: ${vocab.length} kelime_`;

  await sendTelegramMessage(botToken, chatId, message);

  // Update lastReviewed + reviewCount for sent words
  const sentIds = new Set(selected.map(e => e.id));
  const updatedVocab = vocab.map(entry => {
    if (sentIds.has(entry.id)) {
      return {
        ...entry,
        reviewCount: (entry.reviewCount || 0) + 1,
        lastReviewed: new Date().toISOString()
      };
    }
    return entry;
  });

  await chrome.storage.local.set({ vocabulary: updatedVocab });
  return selected.length;
}

// Send a message via Telegram Bot API
async function sendTelegramMessage(botToken, chatId, text) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: "MarkdownV2"
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Telegram hatası: ${err?.description || response.status}`);
  }

  return response.json();
}

// Escape special characters for Telegram MarkdownV2
function escapeMarkdown(text) {
  if (!text) return "";
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

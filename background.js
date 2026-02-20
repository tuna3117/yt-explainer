// ============================================================
// background.js — Service Worker v3
// NEW: Transcript fetch + GPT bulk translation
// ============================================================

// ---- Setup daily alarm ----
chrome.runtime.onInstalled.addListener(() => scheduleDailyAlarm());
chrome.runtime.onStartup.addListener(() => scheduleDailyAlarm());

function scheduleDailyAlarm() {
  chrome.alarms.get("daily-telegram", (existing) => {
    if (existing) return;
    const now = new Date();
    const target = new Date();
    target.setHours(15, 0, 0, 0);
    if (now >= target) target.setDate(target.getDate() + 1);
    const delayInMinutes = (target - now) / 1000 / 60;
    chrome.alarms.create("daily-telegram", { delayInMinutes, periodInMinutes: 24 * 60 });
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "daily-telegram") sendDailyTelegramWords();
});

// ---- Keyboard shortcut ----
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "explain-selection") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  chrome.tabs.sendMessage(tab.id, { type: "TRIGGER_EXPLAIN" });
});

// ---- Message listener ----
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === "EXPLAIN_TEXT") {
    handleExplain(message.payload)
      .then((result) => sendResponse({ ok: true, data: result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "SAVE_WORD") {
    saveWord(message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "TEST_TELEGRAM") {
    sendDailyTelegramWords(true)
      .then((result) => { try { sendResponse({ ok: true, sent: result }); } catch(e) {} })
      .catch((err) => { try { sendResponse({ ok: false, error: err.message }); } catch(e) {} });
    return true;
  }

  if (message.type === "RESCHEDULE_ALARM") {
    chrome.alarms.clear("daily-telegram", () => scheduleDailyAlarm());
    sendResponse({ ok: true });
    return true;
  }

  // ---- NEW: Fetch + translate full transcript ----
  if (message.type === "FETCH_AND_TRANSLATE_TRANSCRIPT") {
    fetchAndTranslateTranscript(message.payload.videoId)
      .then((result) => sendResponse({ ok: true, data: result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

// ============================================================
// TRANSCRIPT FETCH + GPT TRANSLATION
// ============================================================

async function fetchAndTranslateTranscript(videoId) {
  const apiKey = await getApiKey();

  // Step 1: Fetch transcript with timestamps from YouTube
  const transcript = await fetchYouTubeTranscript(videoId);

  if (!transcript || transcript.length === 0) {
    throw new Error("Bu videoda altyazı bulunamadı. Video altyazısız veya altyazılar devre dışı olabilir.");
  }

  // Step 2: Send all lines to GPT in chunks for translation
  const lines = transcript.map(item => item.text);
  const translations = await bulkTranslateWithGPT(lines, apiKey);

  // Step 3: Merge timestamps with translations
  return transcript.map((item, i) => ({
    start: item.start,           // seconds (float)
    duration: item.duration,     // seconds (float)
    original: item.text,
    turkish: translations[i] || ""
  }));
}

// Fetch YouTube transcript via their internal timedtext API
async function fetchYouTubeTranscript(videoId) {
  // Get the video page HTML to extract player data
  const pageResponse = await fetch(`https://www.youtube.com/watch?v=${videoId}`);
  const pageHtml = await pageResponse.text();

  // Extract the player response JSON embedded in the page
  const match = pageHtml.match(/ytInitialPlayerResponse\s*=\s*({.+?})\s*;/);
  if (!match) throw new Error("YouTube sayfa verisi alınamadı.");

  let playerResponse;
  try {
    playerResponse = JSON.parse(match[1]);
  } catch (e) {
    throw new Error("YouTube veri ayrıştırma hatası.");
  }

  // Find available caption tracks
  const captionTracks =
    playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

  if (!captionTracks || captionTracks.length === 0) {
    throw new Error("Bu videoda altyazı yok. Lütfen altyazılı bir video deneyin.");
  }

  // Prefer English, fall back to first available track
  const track = captionTracks.find(t =>
    t.languageCode === "en" || t.languageCode === "en-US"
  ) || captionTracks[0];

  // Fetch transcript in JSON format
  const transcriptResponse = await fetch(track.baseUrl + "&fmt=json3");
  const transcriptData = await transcriptResponse.json();

  // Parse transcript events into clean lines with timestamps
  const lines = [];
  for (const event of (transcriptData?.events || [])) {
    if (!event.segs) continue;

    const text = event.segs
      .map(seg => seg.utf8 || "")
      .join("")
      .replace(/\n/g, " ")
      .trim();

    if (!text) continue;

    lines.push({
      start: (event.tStartMs || 0) / 1000,        // ms → seconds
      duration: (event.dDurationMs || 3000) / 1000,
      text
    });
  }

  return lines;
}

// Translate all lines via GPT, in chunks of 150 to avoid token limits
async function bulkTranslateWithGPT(lines, apiKey) {
  const CHUNK_SIZE = 150;
  const allTranslations = [];

  for (let i = 0; i < lines.length; i += CHUNK_SIZE) {
    const chunk = lines.slice(i, i + CHUNK_SIZE);
    const translations = await translateChunk(chunk, apiKey);
    allTranslations.push(...translations);
  }

  return allTranslations;
}

async function translateChunk(lines, apiKey) {
  const numberedText = lines.map((line, i) => `${i + 1}. ${line}`).join("\n");

  const systemPrompt = `Sen bir çeviri asistanısın. Sana numaralı İngilizce cümleler verilecek.
Her satırı doğal ve akıcı Türkçeye çevir.
Teknik terimleri parantez içinde orijinal haliyle bırak. Örnek: "API (uygulama programlama arayüzü)"
SADECE numaralı çevirileri döndür, başka hiçbir şey yazma.
Format:
1. [Türkçe çeviri]
2. [Türkçe çeviri]`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 4000,
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: numberedText }
      ]
    })
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(`OpenAI hatası: ${errBody?.error?.message || response.status}`);
  }

  const data = await response.json();
  const responseText = data.choices[0].message.content.trim();

  // Parse "1. translation" format back into array
  const translations = [];
  for (const line of responseText.split("\n")) {
    const match = line.match(/^\d+[\.\)]\s*(.+)/);
    if (match) translations.push(match[1].trim());
  }

  // Pad with empty strings if GPT returned fewer lines than expected
  while (translations.length < lines.length) translations.push("");

  return translations.slice(0, lines.length);
}

async function getApiKey() {
  const stored = await chrome.storage.local.get(["openai_api_key"]);
  if (!stored.openai_api_key) {
    throw new Error("API anahtarı bulunamadı. Lütfen popup'tan OpenAI API anahtarınızı girin.");
  }
  return stored.openai_api_key;
}

// ============================================================
// OPENAI — Single explanation
// ============================================================
async function handleExplain({ selectedText, context, mode }) {
  const apiKey = await getApiKey();

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
        { role: "user", content: buildPrompt(selectedText, context, mode || "explain") }
      ]
    })
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(`OpenAI hatası: ${errBody?.error?.message || `HTTP ${response.status}`}`);
  }

  const data = await response.json();
  return data.choices[0].message.content.trim();
}

function getSystemPrompt(mode) {
  if (mode === "translate") {
    return `Sen bir teknik çeviri asistanısın. Kullanıcı sana İngilizce teknik bir metin verecek.
Görevin:
1. Metni doğal Türkçeye çevir
2. Teknik terimleri kısa parantez notlarıyla açıkla

Yanıtını şu formatta ver:
**Türkçe Çeviri:**
[çeviri]
**Teknik Terimler:**
• [terim]: [açıklama]`;
  }

  return `Sen bir teknik eğitim asistanısın. YouTube teknik videosundan seçilmiş İngilizce bir kavramı Türkçe açıkla.

Yanıtını KESINLIKLE şu formatta ver:
**Teknik Açıklama:**
[Türkçe açıklama]
**Detaylar:**
• [madde 1]
• [madde 2]
• [madde 3]
**English Definition:**
[one-line definition]`;
}

function buildPrompt(selectedText, context, mode) {
  let prompt = `Seçilen metin: "${selectedText}"`;
  if (context && context.trim() !== selectedText.trim()) {
    prompt += `\n\nBağlam: "${context}"`;
  }
  prompt += mode === "translate" ? `\n\nLütfen çevir.` : `\n\nLütfen Türkçe açıkla.`;
  return prompt;
}

// ============================================================
// VOCABULARY
// ============================================================
async function saveWord({ word, explanation, context }) {
  const stored = await chrome.storage.local.get(["vocabulary"]);
  const vocab = stored.vocabulary || [];

  if (vocab.some(e => e.word.toLowerCase() === word.toLowerCase())) return;

  vocab.unshift({
    id: Date.now(), word, explanation,
    context: context || "",
    savedAt: new Date().toISOString(),
    reviewCount: 0, lastReviewed: null
  });

  if (vocab.length > 500) vocab.pop();
  await chrome.storage.local.set({ vocabulary: vocab });
}

// ============================================================
// TELEGRAM
// ============================================================
async function sendDailyTelegramWords(isTest = false) {
  const stored = await chrome.storage.local.get([
    "telegram_bot_token", "telegram_chat_id", "vocabulary"
  ]);
  const { telegram_bot_token: botToken, telegram_chat_id: chatId, vocabulary: vocab = [] } = stored;

  if (!botToken || !chatId) return 0;

  if (vocab.length === 0) {
    if (isTest) await sendTelegramMessage(botToken, chatId,
      "📚 *YT Explainer*\n\nHenüz kayıtlı kelimen yok\\!");
    return 0;
  }

  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const eligible = vocab.filter(e => !e.lastReviewed || e.lastReviewed < threeDaysAgo);
  const pool = eligible.length >= 5
    ? eligible
    : [...vocab].sort((a, b) => (a.lastReviewed || "0").localeCompare(b.lastReviewed || "0"));

  const selected = pool.slice(0, Math.min(5, pool.length));
  const today = new Date().toLocaleDateString("tr-TR", { weekday: "long", day: "numeric", month: "long" });

  let msg = `📚 *YT Explainer — Günlük Tekrar*\n_${escapeMarkdown(today)}_\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  selected.forEach((e, i) => {
    msg += `*${i + 1}\\. ${escapeMarkdown(e.word)}*\n`;
    const short = e.explanation.split("\n").filter(l => l.trim()).slice(0, 3).join("\n");
    msg += `${escapeMarkdown(short)}\n\n`;
  });
  msg += `━━━━━━━━━━━━━━━━━━━━\n_${selected.length} kelime • Toplam: ${vocab.length}_`;

  await sendTelegramMessage(botToken, chatId, msg);

  const sentIds = new Set(selected.map(e => e.id));
  await chrome.storage.local.set({
    vocabulary: vocab.map(e => sentIds.has(e.id)
      ? { ...e, reviewCount: (e.reviewCount || 0) + 1, lastReviewed: new Date().toISOString() }
      : e)
  });

  return selected.length;
}

async function sendTelegramMessage(botToken, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "MarkdownV2" })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Telegram hatası: ${err?.description || res.status}`);
  }
  return res.json();
}

function escapeMarkdown(text) {
  if (!text) return "";
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

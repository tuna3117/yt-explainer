# YT Explainer — YouTube Turkish Tech Glossary

> **TR:** YouTube altyazılarından seçtiğin teknik İngilizce kelimeleri anında Türkçe açıklayan Chrome uzantısı.  
> **EN:** A Chrome extension that instantly explains technical English words from YouTube subtitles in Turkish.

---

## 🇹🇷 Türkçe

### Ne İşe Yarar?
YouTube'da teknik bir video izlerken anlamadığın İngilizce bir kelime veya cümleyi seçip `Ctrl+Shift+E` tuşuna basıyorsun (veya beliren 📘 ikonuna tıklıyorsun). OpenAI GPT aracılığıyla anında Türkçe teknik açıklama geliyor.

### Özellikler
-  **Açıklama modu** — Teknik kavramı bağlamıyla birlikte Türkçe açıklar
-  **Çeviri modu** — Cümleyi doğal Türkçeye çevirir, teknik terimleri not eder
-  **Seçim ikonu** — Metin seçince otomatik beliren tıklanabilir ikon
-  **Klavye kısayolu** — `Ctrl+Shift+E` (Mac: `Cmd+Shift+E`)
-  **Kelime deposu** — Açıkladığın kelimeleri kaydedip sonra tekrar bakabilirsin
-  **Telegram günlük tekrar** — Her gün saat 15:00'te 5 kelime Telegram'a gönderilir, son 3 günde gönderilenler tekrar edilmez

### Kurulum
1. Bu repoyu ZIP olarak indir → ZIP'i aç
2. Chrome'da `chrome://extensions` adresine git
3. Sağ üstten **Geliştirici modu**'nu aç
4. **"Paketlenmemişi yükle"** → klasörü seç
5. Uzantı ikonuna tıkla → OpenAI API anahtarını gir → Kaydet

### Gereksinimler
- Google Chrome (veya Chromium tabanlı tarayıcı)
- [OpenAI API anahtarı](https://platform.openai.com/api-keys) (GPT-4o-mini kullanır, çok ucuz)
- İsteğe bağlı: Telegram botu (günlük tekrar için)

### Telegram Kurulumu
1. Telegram'da **@BotFather**'a yaz → `/newbot` → token al
2. **@userinfobot**'a yaz → Chat ID'ni öğren
3. Uzantı popup'ından ✈️ Telegram sekmesine gir → kaydet → test et

---

## 🇬🇧 English

### What Does It Do?
While watching a technical YouTube video, select any English word or sentence you don't understand and press `Ctrl+Shift+E` (or click the 📘 icon that appears). You instantly get a Turkish technical explanation powered by OpenAI GPT.

### Features
-  **Explain mode** — Explains the technical concept in Turkish with context
-  **Translate mode** — Translates naturally to Turkish, annotates technical terms
-  **Selection icon** — A clickable icon appears automatically when you select text
-  **Keyboard shortcut** — `Ctrl+Shift+E` (Mac: `Cmd+Shift+E`)
-  **Vocabulary vault** — Save explained words and review them later
-  **Telegram daily review** — 5 words sent to Telegram every day at 15:00, no repeats within 3 days

### Installation
1. Download this repo as ZIP → extract it
2. Go to `chrome://extensions` in Chrome
3. Enable **Developer mode** (top right)
4. Click **"Load unpacked"** → select the folder
5. Click the extension icon → paste your OpenAI API key → Save

### Requirements
- Google Chrome (or any Chromium-based browser)
- [OpenAI API key](https://platform.openai.com/api-keys) (uses GPT-4o-mini, very affordable)
- Optional: Telegram bot (for daily review feature)

### Telegram Setup
1. Message **@BotFather** on Telegram → `/newbot` → get your token
2. Message **@userinfobot** → get your Chat ID
3. Open extension popup → ✈️ Telegram tab → enter credentials → save → test

### Privacy & Security
- Your API key is stored **locally** in Chrome's own storage (`chrome.storage.local`)
- No data is sent anywhere except directly to OpenAI's API and optionally Telegram
- The source code contains no hardcoded secrets

---

## Tech Stack

| Parça / Part | Teknoloji / Technology |
|---|---|
| Platform | Chrome Extension Manifest V3 |
| AI | OpenAI GPT-4o-mini |
| Storage | `chrome.storage.local` |
| Notifications | Telegram Bot API |
| Scheduling | `chrome.alarms` API |
| Frontend | Vanilla JS + CSS |

---

## Lisans / License

MIT — Kullan, değiştir, dağıt. Kaynak belirt yeterli.  
MIT — Use, modify, distribute. Just keep the attribution.

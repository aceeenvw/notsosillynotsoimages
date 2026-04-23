<div align="center">

# notsosillynotsoimages

### Inline image generation for SillyTavern

AI writes. Images appear. Right inside the chat.

[![License](https://img.shields.io/badge/license-AGPL--3.0-2d5a3a?style=for-the-badge)](LICENSE)
[![SillyTavern](https://img.shields.io/badge/SillyTavern-extension-3a7a4a?style=for-the-badge)](https://github.com/SillyTavern/SillyTavern)
[![Version](https://img.shields.io/badge/version-2.6.1-4a6a8a?style=for-the-badge)](manifest.json)

---

**No separate panel** · **No workflow interruption** · **Mobile-friendly** · **iOS compatible**

</div>

<br>

## ✦ How it works

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│   AI writes a message         ──►  Extension detects tag     │
│                                                              │
│   Loading spinner appears     ──►  Refs collected & sent     │
│                                                              │
│   Image API responds          ──►  Image replaces spinner    │
│                                                              │
│   Image saved to server       ──►  Persisted across reloads  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

Configure once. Everything else is automatic.

<br>

## ✦ Install

```
https://github.com/aceeenvw/notsosillynotsoimages
```

**SillyTavern** → **Extensions** → **Install Extension** → paste the URL → **Install** → reload.

The extension appears in the sidebar as **⊹ Inline Image Generation ⊹**. Green dot = active.

<br>

## ✦ Supported providers

<table>
<tr>
<td width="200"><b>Provider</b></td>
<td><b>How it connects</b></td>
<td width="80" align="center"><b>Refs</b></td>
</tr>
<tr>
<td>🟢 <b>OpenAI-compatible</b></td>
<td><code>/v1/images/generations</code> — DALL-E, gpt-image, SD, FLUX, any proxy</td>
<td align="center">up to 4</td>
</tr>
<tr>
<td>🟣 <b>Gemini / Nano-Banana</b></td>
<td><code>/v1beta/models/{model}:generateContent</code> — native Gemini API shape</td>
<td align="center">up to 4</td>
</tr>
<tr>
<td>🔵 <b>Aggregators</b></td>
<td>Auto-detected from <code>provider/model</code> format (OpenRouter, etc.). Routes Gemini models → Gemini shape, everything else → OpenAI shape. Zero manual config.</td>
<td align="center">up to 4</td>
</tr>
<tr>
<td>🟠 <b>Naistera</b></td>
<td><code>/api/generate</code> — models: <code>grok</code>, <code>nano banana</code>. Endpoint auto-fills to <code>naistera.org</code> if blank. Auto-retries without refs if Grok temporarily can't handle them.</td>
<td align="center">up to 4</td>
</tr>
</table>

<br>

## ✦ Setup

Open the extension panel in the sidebar:

| Setting | What to do |
|:--|:--|
| **API Type** | Pick your provider |
| **Endpoint** | Base URL of your API — auto-fills for Naistera |
| **API Key** | Your auth token |
| **Model** | Click refresh to fetch available models, pick an **image** model |

Click **Test Connection** to verify.

<details>
<summary><b>⚙ OpenAI-specific settings</b></summary>
<br>

| Setting | Values |
|:--|:--|
| Size | `1024x1024` · `1792x1024` · `1024x1792` · `512x512` |
| Quality | `standard` · `hd` |

The extension maps `aspect_ratio` from tags to the closest OpenAI size automatically (10 ratios supported).

</details>

<details>
<summary><b>⚙ Gemini / Nano-Banana / Aggregator settings</b></summary>
<br>

| Setting | Values |
|:--|:--|
| Aspect Ratio | `1:1` · `2:3` · `3:2` · `3:4` · `4:3` · `4:5` · `5:4` · `9:16` · `16:9` · `21:9` |
| Resolution | `1K` · `2K` · `4K` |

Aggregators (like `api.rout.my/compatible`) are detected from the model ID — if it contains a `/`, the extension picks the right API shape for you.

</details>

<details>
<summary><b>⚙ Naistera settings</b></summary>
<br>

| Setting | Values |
|:--|:--|
| Model | `grok` · `nano banana` |
| Aspect Ratio | `1:1` · `16:9` · `9:16` · `3:2` · `2:3` |
| Preset | None · Digital · Realism |

Leave endpoint blank → defaults to `https://naistera.org`. Grok sometimes temporarily rejects reference images — the extension auto-retries without them and shows a warning.

</details>

<br>

## ✦ Character references

Upload reference photos so characters look consistent across every generated image.

```
┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│   👤 Char    │   │   👤 User    │   │  👥 NPC 1-4  │
│   (always)   │   │   (always)   │   │ (name match) │
└──────┬──────┘   └──────┬──────┘   └──────┬──────┘
       │                 │                 │
       └────────────┬────┘─────────────────┘
                    │
            ┌───────▼───────┐
            │  Up to 4 refs  │
            │  sent per req  │
            └───────────────┘
```

### How it works

- **Char & User refs** are sent with every generation
- **NPC refs** are sent only when the NPC's name appears in the prompt (case-insensitive, partial match — any word >2 chars)
- Images are **compressed to 768px** before sending
- Refs are stored as **real files on the server**, not in settings.json
- The first generation fetches refs from disk; subsequent generations **serve from memory cache**

### Smart file naming

Type a name in the ref slot → the server file is renamed to match:

```
iig_ref_char_nolan.jpeg       ← typed "Nolan" under char ref
iig_ref_user_charlotte.jpeg   ← typed "Charlotte" under user ref  
iig_ref_npc0_axel.jpeg        ← typed "Axel" under NPC slot 1
iig_ref_npc0_axel_2.jpeg      ← collision: second "Axel" gets a suffix
```

**Clear a slot** → file is deleted from server. **Replace a photo** → old file is deleted. The `iig_refs/` folder stays clean.

### NPC matching example

```
Prompt: "Axel and Charlotte sitting on a couch"
  ✓ matches NPC "Axel"
  ✓ matches NPC "Charlotte"

Prompt: "Two people sitting on a couch"
  ✗ no name → no NPC refs sent
```

> Make sure your LLM prompt instructs the AI to include character names in image descriptions.

<br>

## ✦ Image tag format

The AI writes tags inside messages. The extension parses and generates.

### Recommended format

```html
<img 
  data-iig-instruction='{"style":"cinematic","prompt":"Nolan leaning against the doorframe, warm light","aspect_ratio":"16:9","image_size":"2K"}' 
  src="[IMG:GEN]"
>
```

After generation, `src` updates to the saved file path. On reload, the image loads from disk.

### Tag parameters

| Parameter | Required | What it does |
|:--|:--:|:--|
| `prompt` | ✓ | What to generate. Include character names for ref matching. |
| `style` | | Style prefix prepended to the prompt |
| `aspect_ratio` | | `16:9`, `1:1`, `9:16`, etc. — overrides UI setting for this image |
| `image_size` | | `1K` / `2K` / `4K` — resolution for Gemini/Nano-Banana |
| `quality` | | `standard` / `hd` — quality tier for OpenAI |
| `preset` | | `digital` / `realism` — Naistera style preset |

### Legacy format (still supported)

```
[IMG:GEN:{"style":"cinematic","prompt":"Nolan leaning against the doorframe"}]
```

### Prompt-driven mode

Enabled by default. When the AI writes `aspect_ratio`, `image_size`, etc. in the tag JSON, those values **override** the UI panel settings for that specific image. Disable in settings if you want the UI to always win.

<br>

## ✦ Image controls

### On hover / tap

| | Desktop | Mobile |
|:--|:--|:--|
| **Show buttons** | Hover over image | Tap image (auto-hide 4s) |
| **Full-size view** | Click image | Double-tap image |
| **Actions** | Download · Regenerate | Download · Regenerate |

### In the message menu

Every AI message has a **regenerate button** (stacked images icon) → re-generates **all** images in that message.

### On errors

Failed generations show an **error placeholder** with a retry button. Regenerate that one image without touching the rest.

### Abort-on-reclick

Click regenerate twice quickly? The first in-flight request is **cancelled**. Only the newest result lands. No stale overwrites, no error images from racing requests.

<br>

## ✦ Error handling & retries

```
┌──────────────────────────────────────────────────┐
│                Error classification               │
├──────────────────────────────────────────────────┤
│  429 / 502 / 503 / 504  →  retryable (auto)     │
│  timeout / network       →  retryable (auto)     │
│  AbortError (re-click)   →  silent cancel        │
│  401 / 403 / 400         →  immediate fail       │
│  5xx at final attempt    →  friendly message     │
│                             "provider is down,   │
│                              not your settings"  │
└──────────────────────────────────────────────────┘
```

| Setting | Default | Description |
|:--|:--|:--|
| Max Retries | `2` | Auto-retries on transient errors. `0` = manual only. |
| Retry Delay | `1500ms` | Base delay, doubles each attempt (exponential backoff) |

Errors are classified by **HTTP status code** — no false-positive retries from substring matching.

<br>

## ✦ Timeouts

Every network call has a bounded timeout. No more infinite hangs.

| Operation | Timeout |
|:--|:--|
| Image generation (desktop) | 5 min |
| Image generation (iOS) | 3 min |
| Image upload to server | 120 s |
| Reference image load | 60 s |
| Reference image upload | 60 s |
| Model list refresh | 30 s |
| Manual save | 30 s |
| Test connection | 20 s |
| File existence check (HEAD) | 10 s |

<br>

## ✦ iOS compatibility

The extension detects iOS/Safari and adapts:

| | Desktop | iOS |
|:--|:--|:--|
| **Transport** | `fetch` + AbortController | XMLHttpRequest |
| **Timeout** | 5 min | 3 min |
| **Tab backgrounding** | Standard | Settings flushed on `visibilitychange` / `pagehide` / `beforeunload` |
| **MIME detection** | Standard | Magic-byte sniffing for correct data URL construction |

<br>

## ✦ Performance

The extension is designed to stay cool during long sessions:

| Optimization | What it does |
|:--|:--|
| **Ref image caching** | First generation fetches from disk; subsequent gens serve from memory. Cache cleared on chat switch. |
| **Debounced settings saves** | Typing in settings → one server write after 500ms of inactivity, not per keystroke. |
| **Debounced localStorage** | Same trailing debounce; writes only when content actually changed. |
| **Context caching** | `SillyTavern.getContext()` cached across hot paths — one allocation per chat, not hundreds. |
| **Single chat-switch sweep** | One DOM pass + MutationObserver for lazy renders, not two stacked timers. |
| **Bounded file-exists cache** | LRU cap at 500 entries. Prevents memory creep in long sessions with many images. |
| **Timer self-cleanup** | Loading spinner timers auto-clear if the placeholder is removed from DOM. |
| **Hot-reload safe** | Global intervals tracked on `window` — re-execution cleans up the previous instance. |

<br>

## ✦ Files

```
index.js         ─  core logic, API calls, settings UI, image controls
style.css        ─  styles, animations, responsive rules
manifest.json    ─  extension metadata
error.svg        ─  error placeholder image
prompt.md        ─  LLM prompt template (paste into your system prompt)
LICENSE          ─  AGPL-3.0
README.md        ─  this file
```

<br>

## ✦ Troubleshooting

<details>
<summary><b>No images generating</b></summary>

- Check the green dot is active in the extension header
- Verify endpoint and API key are set
- Click **Test Connection** — it should report success
- Make sure you picked an **image** model (not text/embedding)

</details>

<details>
<summary><b>Characters look different each time</b></summary>

Upload reference photos in the **References** section. The extension sends them with every generation request so the image model can copy the character's appearance.

</details>

<details>
<summary><b>Aspect ratio ignored</b></summary>

Some models (especially `gemini-*-flash-image`) are flaky with `aspectRatio`. Try:
- Switching to a `-pro-` variant
- Adding the ratio to the prompt text directly
- Using the `prompt.md` template which instructs the LLM to always include `aspect_ratio` in tags

</details>

<details>
<summary><b>Naistera / Grok not working</b></summary>

- API key must be set (get it from the Telegram bot)
- Leave endpoint blank — it auto-fills `naistera.org`
- If Grok temporarily rejects references, the extension auto-retries without them

</details>

<details>
<summary><b>Generation hangs forever</b></summary>

This shouldn't happen on v2.6.1 — every operation has a timeout (10s–5min depending on the call). If you're on an older version, update. If it still happens, export logs from the Debug section.

</details>

<details>
<summary><b>Settings file is huge</b></summary>

Older versions stored reference images as base64 inside `settings.json`. On v2.6.1, a one-time migration strips them and uploads as server files. Check your console for `Reference data migration complete` on first load.

</details>

<details>
<summary><b>Need detailed logs</b></summary>

Open the extension panel → scroll to **Debug** → click **Export logs**. Look for `[ERROR]` and `[WARN]` entries. API keys are automatically redacted from exported logs.

</details>

<br>

## ✦ Credits

Forked from [SillyImages](https://github.com/0xl0cal/sillyimages) by [0xl0cal](https://github.com/0xl0cal).

Rewritten by [aceeenvw](https://github.com/aceeenvw).

<br>

## ✦ License

**AGPL-3.0-or-later** — see [LICENSE](./LICENSE).

Copyright 2025–2026 **aceeenvw**

If you fork or adapt this code:

- Keep the copyright notice and license header
- State your changes
- Release under the same AGPL-3.0 license
- Credit both **aceeenvw** and **0xl0cal**

```
Based on notsosillynotsoimages by aceeenvw
https://github.com/aceeenvw/notsosillynotsoimages

Original: SillyImages by 0xl0cal
https://github.com/0xl0cal/sillyimages

Licensed under AGPL-3.0-or-later
```

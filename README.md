<h1 align="center">notsosillynotsoimages</h1>

<p align="center">
  <b>inline image generation for SillyTavern</b><br>
  <sub>images appear right inside chat messages — no separate panel, no workflow interruption</sub>
</p>

<p align="center">
  <a href="https://github.com/aceeenvw/notsosillynotsoimages/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-2d5a3a?style=flat-square" alt="License"></a>
  <a href="https://github.com/SillyTavern/SillyTavern"><img src="https://img.shields.io/badge/SillyTavern-extension-3a7a4a?style=flat-square" alt="SillyTavern"></a>
</p>

---

## what it does

the AI writes a special tag in its message → the extension intercepts it → calls your image API → replaces the tag with the generated image. everything happens inline, in the chat, automatically.

supports **OpenAI-compatible**, **Gemini / Nano-Banana**, and **Naistera / Grok** backends.

---

## features

| | |
|---|---|
| 🖼 **inline generation** | images render directly in chat messages |
| 🔁 **per-message regenerate** | retry any/all images from the message menu |
| 👤 **character references** | upload ref photos for consistent characters (gemini & naistera) |
| 🎯 **smart NPC matching** | NPC refs only sent when their name is in the prompt |
| 🔄 **auto-retry** | exponential backoff on 429 / 502 / 503 / 504 errors |
| 📱 **iOS support** | XHR transport with adjusted timeouts for Safari |
| 🔍 **image lightbox** | click any generated image to view full-size |
| ⏱ **live progress** | animated spinner + elapsed timer during generation |
| 📋 **session stats** | tracks generated / failed count per session |
| 🐛 **debug logs** | built-in log buffer with one-click export |
| 🎨 **fae-themed error SVG** | custom forest-themed error placeholder |

---

## install

1. open SillyTavern → **Extensions** → **Install Extension**
2. paste the URL:
   ```
   https://github.com/aceeenvw/notsosillynotsoimages
   ```
3. click **Install**, reload

find it in the sidebar as **Inline Image Generation** (look for the 🍃 leaf icon).

---

## setup

open the extension panel in the sidebar.

### API configuration

| setting | what it does |
|---|---|
| **API Type** | `OpenAI-compatible` / `Gemini / Nano-Banana` / `Naistera / Grok` |
| **Endpoint URL** | base URL of your image API |
| **API Key** | your auth token |
| **Model** | pick from the dropdown (click refresh to fetch). not needed for Naistera |
| **Test Connection** | verify everything works before generating |

> **tip:** the header shows a green status dot when the extension is enabled — quick way to check without opening the panel.

### generation settings

<details>
<summary><b>OpenAI-compatible</b></summary>

- **Size** — `1024x1024`, `1792x1024`, `1024x1792`, `512x512`
- **Quality** — `standard` or `hd`

works with DALL-E, Midjourney proxies, Stable Diffusion, FLUX, and any OpenAI-compatible images API.

endpoint: `/v1/images/generations`
</details>

<details>
<summary><b>Gemini / Nano-Banana</b></summary>

- **Aspect Ratio** — `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`
- **Resolution** — `1K`, `2K`, `4K`

works with Nano Banana, Nano Banana Pro, and compatible proxies.

endpoint: `/v1beta/models/{model}:generateContent`
</details>

<details>
<summary><b>Naistera / Grok</b></summary>

- **Aspect Ratio** — `1:1`, `3:2`, `2:3`
- **Preset** — None, Digital, Realism

paste your token from the Telegram bot. the extension auto-appends `/api/generate` if your URL doesn't include it.

endpoint: `/api/generate`
</details>

---

## character references

> **available for Gemini / Nano-Banana and Naistera only.** OpenAI-compatible doesn't support reference images.

upload reference photos so the AI generates characters with consistent appearance. the extension compresses images to **768px max** before sending.

### slots

| slot | behavior |
|---|---|
| **{{char}}** | always sent — automatically linked to current character |
| **{{user}}** | always sent — your persona's reference |
| **NPC 1–4** | conditionally sent — only when the NPC's name appears in the generation prompt |

### ⚠️ reference limit: 4 images max per request

most image models (Nano-Banana, for example) accept a **maximum of 4 reference images** per generation request. the extension enforces this limit. plan your slots accordingly:

| char | user | NPCs | total | valid? |
|:---:|:---:|:---:|:---:|:---:|
| 1 | 1 | up to 2 | 4 | ✅ |
| 1 | 0 | up to 3 | 4 | ✅ |
| 0 | 1 | up to 3 | 4 | ✅ |
| 0 | 0 | up to 4 | 4 | ✅ |
| 1 | 1 | 3+ matched | **over limit** | ⚠️ capped at 4 |

if more than 4 refs would be sent, the extension **silently caps at 4** — char and user take priority, then NPCs in order. so if you have char + user + 4 NPCs all matching, only char + user + the first 2 matched NPCs get sent.

**practical advice:**
- for 1-on-1 chats → use char + user slots, leave NPCs empty
- for group scenes → skip user ref if you're not in the scene, use NPC slots for side characters
- NPC matching is case-insensitive and partial — any word (>2 chars) from the NPC name triggers inclusion

### ⚠️ important: the AI must include character names in the prompt

for NPC references to activate, the character's name **must actually appear in the generated image prompt** — the one inside the `data-iig-instruction` tag. the extension matches NPC names against the `prompt` field, so if the AI writes a vague prompt like `"two people talking in a room"` without naming anyone, no NPC refs will be attached.

make sure your SillyTavern image generation prompt (in `prompt.md` or your system prompt) instructs the AI to **include character names in the image prompt**. for example:

```
✅  "prompt": "Axel and Charlotte sitting on the couch, warm lighting"
❌  "prompt": "two characters sitting on the couch, warm lighting"
```

the first version triggers refs for both Axel and Charlotte. the second triggers nothing.

char and user refs are always sent regardless of the prompt — only NPC slots depend on name matching.

---

## tag format

the AI writes image tags in its messages. the extension parses and replaces them with generated images.

### recommended (new format)

```html
<img data-iig-instruction='{"style":"semi_realistic","prompt":"Medium shot, 50mm f/1.8 shallow DoF. Axel in black t-shirt reaching past Charlotte to a high shelf, warm kitchen light, painterly illustration.","aspect_ratio":"3:4","image_size":"2K"}' src="[IMG:GEN]">
```

after generation, `src` updates to the real path:
```html
<img data-iig-instruction='{"style":"semi_realistic","prompt":"..."}' src="/user/images/character/iig_2026-03-06.jpg">
```

### legacy format (still supported)

```
[IMG:GEN:{"style":"semi_realistic","prompt":"Axel leaning against the doorframe, moody lighting"}]
```

### tag parameters

| parameter | required | description | example |
|---|:---:|---|---|
| `prompt` | ✅ | what to generate — include character names for ref matching | `"Axel reaching past Charlotte to a high shelf, warm light"` |
| `style` | | style prefix prepended to the prompt | `"semi_realistic"`, `"anime"`, `"oil painting"` |
| `aspect_ratio` | | override default aspect ratio | `"16:9"`, `"9:16"`, `"1:1"` |
| `image_size` | | resolution override (Nano-Banana) | `"1K"`, `"2K"`, `"4K"` |
| `quality` | | quality tier (OpenAI) | `"standard"`, `"hd"` |
| `preset` | | style preset (Naistera) | `"digital"`, `"realism"` |

---

## how it works

```
AI writes message with [IMG:GEN] tag
        ↓
extension parses tag, shows loading spinner with timer
        ↓
collects reference images (char → user → matched NPCs, up to 4)
        ↓
sends request to your configured API
        ↓
image generated → saved to SillyTavern storage → displayed inline
        ↓
if failed → shows error.svg → use regenerate button to retry
```

the **regenerate button** (stacked images icon) appears in every AI message's action menu. click it to re-generate all images in that message.

click any generated image to open it **full-size in a lightbox** overlay (press Escape or click outside to close).

---

## retry behavior

| setting | default | description |
|---|---|---|
| **Max Retries** | `0` | auto-retries on 429/502/503/504 errors. set to `0` for manual-only |
| **Delay** | `1000ms` | base delay between retries, doubles each attempt |

with retries at `0`, failed images show the error SVG immediately — use the regenerate button to retry manually whenever you want.

---

## iOS notes

the extension detects iOS/Safari and switches from `fetch()` + `AbortController` to `XMLHttpRequest` with a dedicated timeout. this avoids Safari's aggressive background tab suspension killing long requests.

| | desktop | iOS |
|---|---|---|
| **transport** | fetch + AbortController | XMLHttpRequest |
| **timeout** | 5 minutes | 3 minutes |

if your API consistently takes longer than 3 minutes, iOS may still time out. try a faster model or smaller resolution.

---

## files

```
├── manifest.json    extension metadata (v2.0.0)
├── index.js         core logic — parsing, API calls, settings UI, lightbox, refs
├── style.css        styles — settings panel, loading states, lightbox, animations
├── error.svg        fae-themed error placeholder (forest/dark green)
├── prompt.md        example LLM prompt template for image generation
└── README.md        this file
```

---

## troubleshooting

| problem | fix |
|---|---|
| no images generating | check extension is enabled (green dot in header), endpoint/key are set, Test Connection passes |
| wrong model | click the refresh ↻ button next to model dropdown — make sure you pick an **image** model, not a text/embedding model |
| characters look different every time | upload reference photos in the References section (Gemini/Naistera only) |
| timeout on iOS | 3-min limit on iOS — try a faster endpoint or lower resolution |
| want to retry a failed image | click the regenerate button (stacked images icon) in the message action menu |
| need more details | export logs from the Debug section and check for `[ERROR]` entries |

---

## credits

originally forked from [sillyimages](https://github.com/0xl0cal/sillyimages) by [0xl0cal](https://github.com/0xl0cal).

rewritten and extended by [aceeenvw](https://github.com/aceeenvw) — unified reference system, character/user/NPC slots, Naistera support, iOS compatibility, lightbox, redesigned settings UI, and more.

---

<p align="center">
  <sub>MIT license · made by <a href="https://github.com/aceeenvw">aceeenvw</a></sub>
</p>

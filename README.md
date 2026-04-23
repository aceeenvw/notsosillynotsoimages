<div align="center">

# notsosillynotsoimages

**Inline image generation for SillyTavern**

Images appear right inside chat messages.
No separate panel. No workflow interruption.

[![License](https://img.shields.io/badge/license-AGPL--3.0-2d5a3a?style=flat-square)](LICENSE)
[![SillyTavern](https://img.shields.io/badge/SillyTavern-extension-3a7a4a?style=flat-square)](https://github.com/SillyTavern/SillyTavern)
[![Version](https://img.shields.io/badge/version-2.6.1-4a6a8a?style=flat-square)](manifest.json)

</div>

---

## How it works

```
AI writes a message with an image tag
      |
      v
Extension intercepts the tag, shows a loading spinner
      |
      v
Collects your uploaded reference images (char, user, NPCs)
      |
      v
Sends the request to your configured image API
      |
      v
Generated image replaces the spinner inline in the chat
```

Fully automatic once configured. Aggressive caching, concurrency-safe, mobile-friendly.

---

## Install

1. Open SillyTavern
2. Go to **Extensions** > **Install Extension**
3. Paste:
   ```
   https://github.com/aceeenvw/notsosillynotsoimages
   ```
4. Click **Install**, reload the page

The extension appears in the sidebar as **Inline Image Generation**.
A green dot in the header means it's active.

---

## Supported backends

| Backend | Endpoint | Reference images | Notes |
|---------|----------|:---:|-------|
| **OpenAI-compatible** | `/v1/images/generations` | Up to 4 | DALL-E, gpt-image, SD, FLUX, local proxies |
| **Gemini / Nano-Banana** | `/v1beta/models/{model}:generateContent` | Up to 4 | Nano Banana, Nano Banana Pro, compatible proxies |
| **Aggregator (rout.my, OpenRouter, ...)** | Auto-detected `provider/model` format | Up to 4 | Routes Gemini models to Gemini shape, others to OpenAI shape |
| **Naistera** | `/api/generate` | Up to 4 | Models: `grok`, `nano banana`. Auto-defaults to `naistera.org` |

---

## Quick setup

Open the extension panel in the sidebar and configure:

| Setting | Description |
|---------|-------------|
| **API Type** | Pick your backend |
| **Endpoint URL** | Base URL of your API (auto-fills for Naistera) |
| **API Key** | Your auth token |
| **Model** | Select from dropdown (click refresh to fetch). Not needed for Naistera |

Hit **Test Connection** to verify before generating.

### Backend-specific settings

<details>
<summary><b>OpenAI-compatible</b></summary>

| Setting | Options |
|---------|---------|
| Size | `1024x1024`, `1792x1024`, `1024x1792`, `512x512` |
| Quality | `standard`, `hd` |

</details>

<details>
<summary><b>Gemini / Nano-Banana (and aggregators)</b></summary>

| Setting | Options |
|---------|---------|
| Aspect Ratio | `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9` |
| Resolution | `1K`, `2K`, `4K` |

Aggregator endpoints (like `api.rout.my/compatible`) are auto-detected from the model ID format (`provider/model` with a slash). The extension routes Gemini models to the Gemini API shape and others to the OpenAI shape.

</details>

<details>
<summary><b>Naistera</b></summary>

| Setting | Options |
|---------|---------|
| Model | `grok`, `nano banana` |
| Aspect Ratio | `1:1`, `16:9`, `9:16`, `3:2`, `2:3` |
| Preset | None, Digital, Realism |

If you leave the endpoint blank, it defaults to `https://naistera.org`.

Grok refs are auto-retried without references if the provider temporarily can't handle them (toasted so you know what happened).

</details>

---

## Character references

> Available for every non-OpenAI-only backend.

Upload reference photos so generated characters look consistent across images. The extension compresses them to 768px max before sending and stores them as real files on the ST server (not in settings.json, so your settings stay lean).

### Reference slots

| Slot | When it's sent |
|------|---------------|
| **char** | Always (current character) |
| **user** | Always (your persona) |
| **NPC 1--4** | Only when the NPC's name appears in the prompt |

### Smart file naming

When you type a name for a reference and click away, the file on the server is renamed to match:

```
iig_ref_char_nolan.jpeg
iig_ref_user_charlotte.jpeg
iig_ref_npc0_axel.jpeg
```

Collisions are handled with numeric suffixes (`_2`, `_3`, ...). Files are automatically deleted when you clear a slot or replace the photo, so the server folder stays tidy.

### How NPC matching works

The extension checks the generation prompt for NPC names. Matching is **case-insensitive** and **partial** -- any word longer than 2 characters from the name triggers it.

```
"Axel and Charlotte sitting on a couch"
  -> matches NPC named "Axel"
  -> matches NPC named "Charlotte"

"Two people sitting on a couch"
  -> matches nothing (no names)
```

Make sure your LLM prompt instructs the AI to include character names in image descriptions.

### 4-image limit

Most backends accept a maximum of **4 reference images** per request. Priority order:

1. char ref
2. user ref
3. Matched NPCs (in slot order)

If more than 4 would be sent, the rest are silently dropped.

### Reference caching

Reference images are cached in memory by path across generations. The first generation in a chat does the real fetch + base64 encoding (heaviest step on mobile); every subsequent generation serves from cache silently. Cache is cleared on chat switch so different chats don't cross-contaminate.

---

## Image tag format

The AI writes tags in messages. The extension parses them and generates images.

### Recommended format

```html
<img data-iig-instruction='{"style":"semi_realistic","prompt":"Axel reaching past Charlotte to a high shelf, warm kitchen light","aspect_ratio":"16:9","image_size":"2K"}' src="[IMG:GEN]">
```

After generation, `src` updates to the saved file path.

### Legacy format (still works)

```
[IMG:GEN:{"style":"semi_realistic","prompt":"Axel leaning against the doorframe"}]
```

### Available parameters

| Parameter | Required | Description |
|-----------|:---:|-------------|
| `prompt` | yes | What to generate. Include character names for ref matching |
| `style` | | Style prefix prepended to the prompt |
| `aspect_ratio` | | Override aspect ratio (`16:9`, `1:1`, etc.) |
| `image_size` | | Resolution override for Nano-Banana (`1K`, `2K`, `4K`) |
| `quality` | | Quality tier for OpenAI (`standard`, `hd`) |
| `preset` | | Style preset for Naistera (`digital`, `realism`) |

### External blocks

Enable **External blocks support** in settings if you use other ST extensions that place image tags in `message.extra.extblocks` instead of the main message body.

---

## Image controls

### On the image

- **Desktop:** hover over any generated image to reveal download and regenerate buttons in the corners
- **Mobile:** tap the image to show buttons (auto-hide after 4s), double-tap for full-size view

### In the lightbox

Click (desktop) or double-tap (mobile) any image to open it full-size. The lightbox includes download and regenerate buttons.

### On errors

Failed generations show an error image with a **Retry** button. Click it to regenerate that specific image without touching the rest of the message.

### In the message menu

Every AI message has a regenerate button (stacked images icon) that re-generates **all** images in that message.

### Rapid re-click safety

If you click regenerate twice quickly, the in-flight request for that image is aborted and only the newest result lands. No more stale overwrites or error images caused by race conditions.

---

## Retry behavior

| Setting | Default | Description |
|---------|---------|-------------|
| Max Retries | `0` | Auto-retries on 429/502/503/504/timeout. `0` = manual only |
| Delay | `1000ms` | Base delay between retries, doubles each attempt |

Retryable errors are classified from structured HTTP status codes (via the provider response), not substring matches against the error text. Aborted generations (from re-click) bypass the retry loop entirely.

---

## iOS

The extension detects iOS/Safari and switches transport to avoid Safari killing long requests in background tabs.

| | Desktop | iOS |
|---|---------|-----|
| Transport | `fetch` + AbortController | XMLHttpRequest |
| Timeout | 5 min | 3 min |

Settings flushes are fired on `visibilitychange`/`pagehide`/`beforeunload` to survive Safari's aggressive tab culling.

---

## Files

```
index.js         core logic, API calls, settings UI, image controls
style.css        all styles, animations, responsive rules
manifest.json    extension metadata
error.svg        error placeholder image
prompt.md        example LLM prompt template
LICENSE          AGPL-3.0
README.md        this file
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| No images generating | Check the green dot is active, endpoint and key are set, Test Connection passes |
| Wrong model selected | Click refresh next to model dropdown. Pick an **image** model, not text/embedding |
| Characters look different each time | Upload reference photos in the References section |
| Aspect ratio ignored by nano-banana | Known model-side flakiness — try nano-banana-pro, or bake the ratio into the prompt text |
| Naistera not working | Make sure API key is set. Endpoint auto-defaults to naistera.org if blank |
| Timeout on iOS | 3-minute limit. Try a faster endpoint or lower resolution |
| Failed image, want to retry | Click the Retry button on the error image, or use the message menu regenerate button |
| Hanging "Saving..." after generation | Upload timeouts prevent this now (120 s for generated images, 60 s for ref uploads) |
| Need detailed logs | Export from the Debug section, look for `[ERROR]` entries |

---

## Credits

Forked from [sillyimages](https://github.com/0xl0cal/sillyimages) by [0xl0cal](https://github.com/0xl0cal).

Rewritten by [aceeenvw](https://github.com/aceeenvw) -- character reference system with on-server file storage and smart renaming, NPC slots, Naistera/Grok support, aggregator routing (rout.my, OpenRouter), iOS compatibility, image action buttons, lightbox with controls, error retry, external blocks support, robust JSON parsing, in-memory ref caching, abort-on-reclick for regeneration, bounded-memory file-existence cache, debounced localStorage writes, and more.

---

## License

**AGPL-3.0-or-later** -- see [LICENSE](./LICENSE).

Copyright 2025--2026 **aceeenvw**

If you fork or adapt this code:

- Keep the copyright notice and license header in source files
- State your changes prominently
- Release under the same AGPL-3.0 license
- Credit both aceeenvw and 0xl0cal

```
Based on notsosillynotsoimages by aceeenvw
https://github.com/aceeenvw/notsosillynotsoimages

Original: SillyImages by 0xl0cal
https://github.com/0xl0cal/sillyimages

Licensed under AGPL-3.0-or-later
```

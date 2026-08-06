<div align="center">

# ⊹ ✦ INLINE IMAGE GENERATION ✦ ⊹

### *Images & videos, born right inside your chat.*

[![Version](https://img.shields.io/badge/version-3.0.0-4a6a8a?style=flat-square)](manifest.json)
[![License](https://img.shields.io/badge/license-AGPL--3.0-2d5a3a?style=flat-square)](LICENSE)
[![SillyTavern](https://img.shields.io/badge/SillyTavern-extension-3a7a4a?style=flat-square)](https://github.com/SillyTavern/SillyTavern)

The AI writes a media tag in its reply → the extension intercepts it, calls your
image/video API, and drops the finished result **into the message where the tag was.**

*No side panels. No workflow interruption. No manual prompting.*

</div>

---

<div align="center">

✦ ⊹ ✦ ⊹ ✦ ⊹ ✦ ⊹ ✦ ⊹ ✦ ⊹ ✦ ⊹ ✦ ⊹ ✦ ⊹ ✦ ⊹ ✦ ⊹ ✦ ⊹ ✦

</div>

## ✦ Highlights

| | |
|---|---|
| 🖼️ **Inline images** | The AI embeds an image tag; it becomes a real picture in place. |
| 🎬 **Inline video** *(experimental)* | Text-to-video, image-to-video, identity references. |
| 🔌 **Protocol-driven** | OpenAI-compatible · Gemini-compatible · Naistera — one UI. |
| 👥 **Character references** | Consistent faces via per-character / NPC reference photos. |
| 🎯 **Name-gated refs** | Refs sent only when the name appears — with comma aliases & whole-word matching. |
| 🗂️ **Global or per-chat refs** | Share one set everywhere, or let each chat keep its own. |
| 💾 **API presets** | Save & swap whole provider configs in one click. |
| 📱 **Mobile / iOS aware** | Dedicated transport so Safari doesn't kill long requests. |
| 🔒 **Privacy-minded** | API keys redacted from all logs. |

---

## ⊹ Contents

- [Install](#-install)
- [How it works](#-how-it-works)
- [Tag format](#-tag-format)
- [API Type](#-api-type--pick-the-protocol-your-provider-speaks)
- [Per-type settings](#-per-type-settings)
- [API presets](#-api-presets)
- [Character references](#-character-references)
- [Advanced](#-advanced)
- [Image controls](#-image-controls)
- [Image Manager](#-image-manager--optional)
- [Error handling](#-error-handling)
- [Retry settings](#-retry-settings)
- [iOS / mobile](#-ios--mobile)
- [Troubleshooting](#-troubleshooting)
- [Files](#-files)
- [Credits](#-credits)
- [License](#-license)

---

## ✦ Install

1. Open SillyTavern.
2. **Extensions → Install Extension**.
3. Paste: `https://github.com/aceeenvw/notsosillynotsoimages`
4. Click **Install**, reload the page.

The extension appears in the left sidebar as **⊹ INLINE IMAGE GENERATION ⊹**.
A small green dot next to the drawer title means it's active.

> ✦ All API types work out of the box — no server patches required.

---

## ⊹ How it works

```
AI writes a message containing an image tag
      │
      ▼
Extension replaces the tag with a loading spinner
      │
      ▼
Collects your reference images (char, user, matched NPCs)
      │
      ▼
POSTs to your configured image API
      │
      ▼
Generated image replaces the spinner in the rendered message
```

Fully automatic — with aggressive ref caching, abort-on-reclick, iOS-safe
transport, and debounced settings saves.

---

## ✦ Tag format

The AI writes image requests using this HTML tag:

```html
<img data-iig-instruction='{"style":"semi_realistic","prompt":"Axel reaching past Charlotte for a book, warm kitchen light","aspect_ratio":"16:9","image_size":"2K"}' src="[IMG:GEN]">
```

After generation, `src` is rewritten to the saved file path.
A legacy `[IMG:GEN:{json}]` format is also accepted.

### ⊹ Image fields

| Field | Required | Description |
|---|:---:|---|
| `prompt` | ✦ | What to generate. Include character names so ref matching fires. |
| `style` | | Prefix prepended to the prompt (e.g. `semi_realistic`, `anime`). |
| `aspect_ratio` | | `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`. |
| `image_size` | | Resolution hint: `1K`, `2K`, `4K` (Gemini); mapped to quality for OpenAI. |
| `quality` | | OpenAI: `standard` or `hd`. |
| `preset` | | Naistera Grok only: `digital` or `realism`. |

### ⊹ Video tags — experimental

> ⚠️ Video is **experimental** — some providers return errors (502s) or
> temporary links. It's marked experimental in the settings panel too.

When a **Video model** is set (OpenAI/Gemini-style providers), the AI can request a clip:

```html
<img data-iig-video='{"prompt":"Charlotte turns and smiles, gentle breeze","duration":4,"resolution":"720p","aspect_ratio":"16:9","ref_mode":"reference"}' src="[VID:GEN]">
```

A legacy `[VID:GEN:{json}]` format is also accepted.

| Field | Description |
|---|---|
| `prompt` | What happens in the clip. |
| `duration` | Seconds. |
| `resolution` | `480p`, `720p`, `1080p`, `4K`. |
| `aspect_ratio` | Same ratios as images. |
| `audio` | `true` / `false` (when the model supports it). |
| `ref_mode` | `reference` (default — matched photo as an **identity** reference) or `first_frame` (animates the photo as the opening frame). |
| `negative_prompt` | Things to avoid. |

Videos can take several minutes (the provider renders synchronously). The finished
file is re-hosted on your ST server so it survives the provider's temporary link
expiring. Identity references (`ref_mode:"reference"`) need a reference-capable
model (e.g. a Seedance or Wan `-r2v` model); Veo only does text-to-video / first-frame.

> ✦ See [prompt.md](prompt.md) for a system-prompt template to paste into your AI's instructions.

---

## ✦ API Type — pick the protocol your provider speaks

The extension routes requests by **protocol**, not by provider. No brand-name
presets — you tell it which schema your provider speaks, and it sends requests
in that shape.

| API Type | Paths appended to your base URL | Auth header | Refs |
|---|---|---|:---:|
| **OpenAI-compatible** | `/v1/images/generations`, `/v1/models` | `Authorization: Bearer` | up to 4 |
| **Gemini-compatible** | `/v1beta/models/{model}:generateContent`, falls back to `/v1/models` for discovery | `Authorization: Bearer` (+ `x-goog-api-key` for `*.googleapis.com`) | up to 4 |
| **Naistera** | `/api/generate` (defaults to `naistera.org` if blank) | `Authorization: Bearer` | up to 4 (Grok / Nano Banana 2) |

> ⊹ NovelAI is available **as a Naistera sub-model** (Naistera → Model: NovelAI).

### ⊹ OpenAI vs Gemini — which one?

- Model names like `gpt-image-1`, `dall-e-3`, `flux-*` → **OpenAI-compatible**.
- Model names like `gemini-*`, `nano-banana-*`, `imagen-*` → **Gemini-compatible**.
- Unsure? Try **Gemini-compatible** first; most aggregators speak it, and model
  discovery falls back to `/v1/models` if the Gemini path returns nothing.

### ⊹ Where to paste your base URL

Include **any path prefix your provider documents** (e.g. `/compatible`, `/v1`).
The extension only appends method-specific suffixes.

```
https://api.openai.com                    → /v1/models
https://your-aggregator.example/compatible → /compatible/v1beta/models/{model}:generateContent
```

---

## ✦ Per-type settings

### ⊹ OpenAI-compatible

| Setting | Options |
|---|---|
| Size | `1024x1024`, `1792x1024`, `1024x1792`, `512x512` |
| Quality | `auto` / `low` / `medium` / `high` (`gpt-image-*`), `standard` / `hd` (`dall-e-3`) |

Refs are sent as `body.image` (single data URL) or `body.image[]` (array).
For `gpt-image-2*`: quality is auto-clamped to `low`/`medium`/`high`/`auto`
(`standard`→`medium`, `hd`→`high`). With refs attached, requests route to
`/v1/images/edits`; text-to-image stays on `/v1/images/generations`.

### ⊹ Gemini-compatible

| Setting | Options |
|---|---|
| Resolution | `1K`, `2K`, `4K` |
| Send reference images | on / off (default on) |

Aspect ratio is tag-driven. Both `Authorization: Bearer` and `x-goog-api-key`
are sent when the host ends in `googleapis.com`, so Google-native and Bearer-only
aggregators both work. Refs go as `inlineData` parts (MIME auto-detected).
Uncheck **Send reference images** to force text-only for providers that reject refs.

### ⊹ Naistera

| Setting | Options |
|---|---|
| Model | **Grok** / **Nano Banana 2** / **NovelAI** |
| Preset | None / Digital / Realism (Grok only) |
| Send reference images | on / off (Grok + Nano Banana 2 only) |

- `Nano Banana 2` is Naistera's current Google-nano-banana upstream.
- `NovelAI` under Naistera never accepts references; they're omitted regardless of the toggle.
- Grok has flaky ref support — on `grok_refs_temporarily_unavailable` the extension
  auto-retries once without refs (with a toast). Uncheck **Send reference images** to skip them up-front.
- Endpoint defaults to `https://naistera.org` when blank.

### ⊹ Video — experimental

| Setting | Options |
|---|---|
| Video model | free text (blank = video off; e.g. a Veo, Seedance, or Wan model) |
| Default duration | seconds (tag can override) |
| Default resolution | `480p`, `720p`, `1080p`, `4K` (tag can override) |
| Request audio track | on / off |

Set a Video model to enable video. The AI then requests clips with `[VID:GEN]`
tags; tag fields override these defaults. See [Video tags](#-video-tags--experimental).

---

## ✦ API presets

Save named snapshots of your API configuration and swap between them in one click.

Each preset stores: `apiType`, `endpoint`, `apiKey`, `model`, `pathOverride`,
`showAllModels`, `naisteraModel`, `naisteraSendRefs`, `videoModel`. Everything
else (generation params, refs, retries) stays on the live config.

> 🔒 **Where presets live:** inside SillyTavern's `settings.json`, under
> `extension_settings.inline_image_gen.presets` (typically
> `~/SillyTavern/data/<your-user>/settings.json`). No cloud, no separate file —
> the same place ST already keeps every API key you've entered.

---

## ✦ Character references

Upload photos so generated characters look consistent across images. References
are compressed to 768px max and stored as real files on the ST server (not in
`settings.json`).

### ⊹ Slots

| Slot | Sent when |
|---|---|
| char | The character's name appears in the prompt (falls back to the active character's name if the slot is unnamed). |
| user | Your persona's name appears in the prompt (falls back to the active persona name if unnamed). |
| NPC 1–4 | The NPC's name appears in the prompt text. |

By default **every** slot — including char & user — is sent only when its name is
in the prompt, keeping unrelated characters out of a scene. Override per main slot:

- **Always send Char reference** — send the char photo regardless of name match.
- **Always send User reference** — same for the user photo.

### ⊹ Name matching

Matching is **case-insensitive** and **whole-word** (`Ace` matches `Ace`, not
`space`). Each slot name can hold **comma-separated aliases** — any one matches:

```
Name field:  Elodie, Lodi, Ellie
"Lodi waves hello"  → match ✦
"melodies playing"  → no match (whole-word)
```

The first alias is used when naming the file on the server.

### ⊹ 4-image limit

Most providers accept at most 4 refs/request. Priority: **char → user → NPCs**
(slot order). Extras are silently dropped.

### ⊹ Smart file naming

Type a name and click away → the server file is renamed to match:

```
iig_ref_char_nolan.jpeg
iig_ref_user_charlotte.jpeg
iig_ref_npc0_axel.jpeg
```

Collisions get numeric suffixes (`_2`, `_3`, …). Files are deleted when you clear
a slot, replace the photo, or use **Clear refs folder**.

### ⊹ Caching

Refs are base64-cached in memory across generations. The first generation in a
chat does the real fetch + encode (heaviest step on mobile); the rest serve from
cache. Cache clears on chat switch.

### ⊹ Global vs Per-chat

The **References** dropdown sets where reference slots live:

- **Global** *(default)* — one reference set shared by every chat.
- **Per-chat** — each chat remembers its own set. Switching chats swaps the
  photos; a chat with none falls back to global. Editing any slot forks the
  current chat its own copy.

Image files are shared on the server — only *which* photo each chat uses is
per-chat. In Per-chat mode, **Reset this chat to global** clears just this chat's
saved set (and removes its unshared files); other chats are unaffected.

---

## ✦ Advanced

A collapsible section at the bottom of **API Configuration** — two escape hatches
for non-standard providers:

- **Path override** — replaces the auto-appended URL suffix (e.g. if your provider
  serves images from `/api/v2/imagine`). Empty by default. Provider-agnostic.
- **Show all models** — disables the built-in image-model keyword filter. Enable
  if **Test Connection** says "no models found" but you know your provider has them.

---

## ✦ Image controls

**On any generated image**
- 🖥️ Desktop: hover to reveal download + regenerate buttons; click for a full-size lightbox.
- 📱 Mobile: single tap shows buttons (auto-hide after 4s). No lightbox.

**On error images** — a retry button regenerates just that one image, untouched rest.

**In the message menu** — a stacked-images icon regenerates **all** images at once.

**Rapid re-clicks** — clicking regenerate twice aborts the in-flight request; only
the newest result lands. No stale overwrites.

---

## ✦ Image Manager — optional

If the [ST-ImageManager](https://github.com/Nufahi) extension is installed, an
**Open Image Manager** button appears at the bottom of the settings panel — quick
access to browse, sort, and clean up your generated images. Not installed? The
button is hidden; nothing to configure.

---

## ✦ Error handling

- **Auto-retry** on 429 / 502 / 503 / 504 / timeout, with configurable
  max-retries + base delay (exponential backoff).
- **Smart hints** — on an error, a second toast suggests likely fixes (e.g. "try
  switching API Type to Gemini-compatible"). Same suggestion won't repeat within 30s.
- **Test Connection** — distinct messages for *no endpoint / no key / unreachable
  / auth rejected / path not found / model list empty*.
- **Request body audit logs** (via Export Logs) show exactly what hit the wire.

---

## ✦ Retry settings

| Setting | Default | Notes |
|---|:---:|---|
| Max Retries | `2` | `0` = manual retry only. |
| Delay | `1500 ms` | Base delay; doubles each attempt. |

Transient 5xx errors get at least one extra attempt even when Max Retries is 0 —
the upstream is almost always the culprit.

---

## ✦ iOS / mobile

The extension detects iOS and switches fetch implementation so Safari doesn't kill
long requests in background tabs.

| | 🖥️ Desktop | 📱 iOS |
|---|:---:|:---:|
| Transport | `fetch` + `AbortController` | `XMLHttpRequest` |
| Timeout | 5 min | 3 min |

Settings are flushed on `visibilitychange` / `pagehide` / `beforeunload` so mobile
tab-culling doesn't lose pending writes. The **Save settings** button forces a
synchronous durable write before backgrounding.

---

## ✦ Troubleshooting

| Symptom | Fix |
|---|---|
| No images generating | Header dot green? Verify API Type, endpoint & key, then run **Test Connection**. |
| "No models found" but you know they exist | Expand **Advanced** → enable **Show all models**. |
| Generation 404s every request | Your **Endpoint URL** likely needs a documented path prefix (`/compatible`, `/v1`). |
| Characters look different each time | Upload character photos under **Character References**. |
| Grok on Naistera keeps failing with refs | Uncheck **Send reference images** under Naistera. |
| No videos generating | Set a **Video model** (blank = off). Videos take minutes; provider must be OpenAI/Gemini-style. |
| Character video shows the photo, not the character | Use `ref_mode:"reference"` with a reference-capable model (Seedance / Wan `-r2v`). Veo only does text-to-video / first-frame. |
| Hanging "Saving…" | Upload timeouts guard this (120s images, 60s refs). If it persists, check ST server logs. |
| Wrong aspect ratio | Aspect ratio is tag-driven. Tell the AI via OOC (*"all images 16:9"*) so it embeds it in each tag. |
| Need detailed logs | Debug → **Export Logs**. Look for `[ERROR]`. API keys are redacted automatically. |

---

## ✦ Files

```
index.js        core logic · API dispatch · settings UI · image controls
style.css       styles · animations · mobile responsive
manifest.json   SillyTavern extension metadata
error.svg       placeholder for failed generations
prompt.md       system-prompt template for your AI
LICENSE         AGPL-3.0
README.md       this file
```

---

## ✦ Credits

Forked from [sillyimages](https://github.com/0xl0cal/sillyimages) by [0xl0cal](https://github.com/0xl0cal).

Rewritten by [**aceeenvw**](https://github.com/aceeenvw):

- ⊹ Protocol-driven API dispatch (OpenAI / Gemini / Naistera — no model-name heuristics).
- ⊹ Inline **video** generation (text-to-video, image-to-video, identity references).
- ⊹ Character reference system: on-server storage, smart renaming, whole-word + alias matching, name-gated char/user/NPC slots.
- ⊹ Global vs per-chat reference scoping.
- ⊹ Named API presets for quick provider switching.
- ⊹ iOS compatibility layer, abort-on-reclick, aggressive ref caching, debounced persistence.
- ⊹ Image/video action buttons, lightbox, per-image retry, collapsible settings.
- ⊹ Smart error hints, request-body audit logging, structured retry classification.
- ⊹ Optional Image Manager launcher + handshake API.

---

## ✦ License

**AGPL-3.0-or-later** — see [LICENSE](./LICENSE).
Copyright 2025–2026 **aceeenvw**.

If you fork or adapt this code:

- Keep the copyright notice and license header in source files.
- State your changes prominently.
- Release under the same AGPL-3.0 license.
- Credit both **aceeenvw** and **0xl0cal**.

```
Based on notsosillynotsoimages by aceeenvw
https://github.com/aceeenvw/notsosillynotsoimages

Original: SillyImages by 0xl0cal
https://github.com/0xl0cal/sillyimages

Licensed under AGPL-3.0-or-later
```

<div align="center">

⊹ ✦ ⊹ ✦ ⊹

*Made with care by aceeenvw.*

</div>

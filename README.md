<div align="center">

# ⊹ ✦ INLINE IMAGE GENERATION ✦ ⊹

### *Generated images, placed directly inside your chat.*

[![Version](https://img.shields.io/badge/version-3.3.0-4a6a8a?style=flat-square)](manifest.json)
[![License](https://img.shields.io/badge/license-AGPL--3.0-2d5a3a?style=flat-square)](LICENSE)
[![SillyTavern](https://img.shields.io/badge/SillyTavern-extension-3a7a4a?style=flat-square)](https://github.com/SillyTavern/SillyTavern)

The AI writes an image tag in its reply → the extension intercepts it, calls your
image API, and places the finished result **where the tag was.**

</div>

## ✦ Highlights

| | |
|---|---|
| **Inline images** | The AI embeds an image tag; it becomes a real picture in place. |
| **Protocol-driven** | OpenAI-compatible · Gemini-compatible · Naistera — one UI. |
| **Character references** | Consistent faces via per-character and NPC reference photos. |
| **Reference cropping** | Crop uploaded photos before assigning them to a slot. |
| **Name-gated refs** | Refs sent only when the name appears, with aliases and whole-word matching. |
| **Scoped refs** | Global, per-character/group, or per-chat reference sets. |
| **Image Packs** | A local library of reference images, reusable across every chat. |
| **API presets** | Save and swap whole provider configs in one click. |
| **Prompt Model** | A separate text model composes image tags after the narrative is done. |
| **Mobile / iOS aware** | Uses XMLHttpRequest for long-running image requests on iOS. |
| **English / Russian UI** | Follows SillyTavern's language; other languages use English. |
| **Diagnostics** | No idle polling; logs include status and errors, with credential redaction. Review logs before sharing. |

---

## ⊹ Contents

- [Install](#-install)
- [How it works](#-how-it-works)
- [Prompt Model](#-prompt-model)
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

Reload SillyTavern after updating. Your existing packs and reference photos are kept.

---

## ⊹ How it works

The AI writes an image tag inside its message. The extension swaps that tag for
a spinner, collects the reference images whose names appear in the prompt, POSTs
to your configured provider, and replaces the spinner with the result.

Generation starts automatically when an image tag appears.

---

## ✦ Prompt Model

Prompt Model mode separates narrative writing, image prompting, and rendering:

```text
Main model writes the narrative
        ↓
Prompt model reads that narrative and returns one IIG HTML image block
        ↓
IIG sends the block to the configured image model
```

The image block is saved alongside the reply without adding its HTML and image
prompt to the narrative sent to your main model.

### ⊹ Setup

1. Use SillyTavern's **Chat Completion** API and choose the main provider normally.
2. Open IIG settings → **Prompt Model**.
3. Choose **Default** and a text model from the current SillyTavern provider, or
   choose **Gemini-compatible** and enter its base endpoint, API key and model ID.
4. Click **Import prompt…**, select a preset prompt beginning with `<image_gen>`, then confirm.
5. Enable **Use separate prompt model**.

To adapt [`prompt.md`](prompt.md), replace its `[HTML CSS]` opening with
`<image_gen>` and ask for **only the HTML artifact based on the supplied completed
narrative**, rather than an artifact embedded in a new narrative response.
Keep its image-tag requirements.

Importing stores one frozen snapshot and disables its Prompt Manager entry.
Turning Prompt Model off re-enables that prompt and restores the inline workflow;
turning it back on refreshes the snapshot if the source was edited meanwhile.
Prompts created through Style Jam are adopted and disabled automatically, though
Style Jam is not required.

**Default** uses SillyTavern's current provider and generation settings.
**Gemini-compatible** has its own endpoint, key and model, separate from your
image provider. Save these together as a named connection preset. Editing a
connection field detaches the selected preset without changing the saved copy.
You can add up to 20 Gemini connection presets.

Its **Test connection** sends a short text request and can use paid tokens.
A valid blocked or empty response is reported as a connection success with a note.
This route sends text context only, not images attached to the conversation.

Keys are included in saved settings and presets. Treat settings backups as
private, and review exported logs before sharing them, even with redaction.

### ⊹ Image-only guidance

With Prompt Model enabled, an **OOC** button appears beside **Send**. It holds
direction only the prompt model sees — composition, mood, camera — and the
narrative model never receives it. Use normal `[OOC: ...]` text for the main
model instead.

Guidance is per chat and lasts until **Clear**; the button carries an accent dot
while it is set. `{{char}}` and `{{user}}` resolve when the request is built.

**Edit** on a sidecar message shows the narrative and the sidecar source together.
Saving keeps the stored narrative clean. Editing a prompt does not re-render the
image — press regenerate for that.

---

## ✦ Tag format

The AI writes image requests using this HTML tag:

```html
<img data-iig-instruction='{"style":"semi_realistic","prompt":"Ace reaching past Savannah for a book, warm kitchen light","aspect_ratio":"16:9","image_size":"2K"}' src="[IMG:GEN]">
```

After generation, `src` is rewritten to the saved file path.
A legacy `[IMG:GEN:{json}]` format is also accepted.

Write valid JSON first, then HTML-escape `&`, `'`, `<` and `>` as `&amp;`,
`&#39;`, `&lt;` and `&gt;` inside the single-quoted attribute. Keep JSON double
quotes unchanged: for example, `"prompt":"Ace&#39;s portrait"`.

### ⊹ Image fields

| Field | Required | Description |
|---|:---:|---|
| `prompt` | ✦ | What to generate. Include character names so ref matching fires. |
| `style` | | Prefix prepended to the prompt (e.g. `semi_realistic`, `anime`). |
| `aspect_ratio` | | `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`. |
| `image_size` | | Resolution hint: `1K`, `2K`, `4K` (Gemini); mapped to quality for OpenAI. |
| `quality` | | OpenAI: `auto`, `low`, `medium`, `high`, `standard`, or `hd`, depending on model. |
| `preset` | | Naistera Grok models only: `digital` or `realism`. |

> ✦ See [prompt.md](prompt.md) for a system-prompt template to paste into your AI's instructions.

---

## ✦ API Type — pick the protocol your provider speaks

The extension routes requests by **protocol**, not by provider. No brand-name
presets — you tell it which schema your provider speaks, and it sends requests
in that shape.

| API Type | Paths appended to your base URL | Auth header | Refs |
|---|---|---|:---:|
| **OpenAI-compatible** | `/v1/images/generations`, `/v1/images/edits`, `/v1/chat/completions`, `/v1/models` | `Authorization: Bearer` | up to 4; NovelAI: 1 |
| **Gemini-compatible** | `/v1beta/models/{model}:generateContent`, falls back to `/v1/models` for discovery | `Authorization: Bearer` (+ `x-goog-api-key` for `*.googleapis.com`) | up to 4 |
| **Naistera** | `/api/generate` (defaults to `naistera.org` if blank) | `Authorization: Bearer` | up to 4 (Grok / Nano Banana 2) |

NovelAI uses Images without references and Chat Completions with exactly one.
Multiple matches stop before a request is sent.

### ⊹ OpenAI vs Gemini — which one?

- Model names like `gpt-image-1`, `dall-e-3`, `flux-*` → **OpenAI-compatible**.
- Model names like `gemini-*`, `nano-banana-*`, `imagen-*` → **Gemini-compatible**.
- Select the API family documented by your provider for the chosen model.

### ⊹ Where to paste your base URL

Enter the provider's base URL and include protocol prefixes such as `/compatible`.
The extension appends the method-specific suffix. OpenAI Images requests remove a
terminal `/compatible` segment because that segment belongs to the Gemini route.

```
https://api.openai.com                    → /v1/models
https://your-aggregator.example/compatible → /compatible/v1beta/models/{model}:generateContent
```

The **Model** field accepts typing as well as suggestions from **Refresh models**.
This matters when a provider lists a model family instead of every exact model ID.

---

## ✦ Per-type settings

| Panel | Purpose |
|---|---|
| **API Configuration** | Provider, endpoint, key, model and saved presets. Collapsed by default. |
| **Character References** | Character, user and NPC photos. Open by default for quick access. |
| **Reference Options** | Matching rules, three-level reference scope and always-send toggles. |
| **Generation Settings** | Provider-specific size, quality, resolution and reference controls. |

### ⊹ OpenAI-compatible

| Setting | Options |
|---|---|
| Size | `1024x1024`, `1792x1024`, `1024x1792`, `512x512` |
| Quality | `auto` / `low` / `medium` / `high` (`gpt-image-*`), `standard` / `hd` (`dall-e-3`) |

With refs attached, GPT Image models (`gpt-image-1*`, `gpt-image-2*` and
`chatgpt-image-latest`) route to multipart `/v1/images/edits`; text-to-image
stays on `/v1/images/generations`, and other OpenAI-compatible models keep their
JSON image field. Quality is clamped to `low` / `medium` / `high` / `auto`.
Earlier GPT Image models use their supported square, landscape or portrait
size; GPT Image 2 keeps flexible aspect-driven dimensions.

NovelAI requires a full ID such as
`novelai/nai-diffusion-5-curated-1024x1024-s20`. `aspect_ratio` rewrites only
the resolution; family and steps stay unchanged. Size, Quality and `image_size`
are omitted. Zero references use Images, one uses Chat Completions, and multiple
matches stop before a request is sent.

### ⊹ Gemini-compatible

| Setting | Options |
|---|---|
| Resolution | `1K`, `2K`, `4K` |
| Send reference images | on / off (default on) |

Aspect ratio is tag-driven. Both `Authorization: Bearer` and `x-goog-api-key`
are sent when the host ends in `googleapis.com`, so Google-native and Bearer-only
aggregators both work. Refs go as `inlineData` parts (MIME auto-detected).
Uncheck **Send reference images** to force text-only for providers that reject refs.
If the standard Gemini path returns 404, the extension tries `/compatible` once
and remembers the working route for the session.

### ⊹ Naistera

| Setting | Options |
|---|---|
| Model | **Grok** / **Grok Pro** / **Nano Banana 2** / **NovelAI** |
| Preset | None / Digital / Realism (Grok models only) |
| Send reference images | on / off (Grok + Nano Banana 2 only) |

- `Nano Banana 2` uses Naistera's Google Nano Banana upstream.
- Grok Pro and NovelAI omit references regardless of the toggle.
- References use named `reference_objects`; endpoints that explicitly reject that field are retried once with legacy `reference_images` and remembered for the session.
- On `grok_refs_temporarily_unavailable`, the extension retries once without refs.
- Turn off **Send reference images** to skip Naistera references.
- Endpoint defaults to `https://naistera.org` when blank.

---

## ✦ API presets

Save named snapshots of your API configuration and swap between them in one click.

Each preset keeps the provider connection, API key, model, advanced connection
options and provider reference toggles. Size, quality, reference photos and
retry settings are not changed when you load a preset.

---

## ✦ Character references

Upload photos so generated characters look consistent across images. References
are compressed to 768px max and stored as real files on the ST server (not in
`settings.json`).

### Cropping uploads

**Crop uploads (references and packs)** is on by default in Character References.
It controls both slot uploads and new photos added to Image Packs. Choose a photo,
adjust the crop, then confirm. Cancel keeps the previous reference, or skips that
photo in a pack import; multi-photo imports continue with the next photo.
Turn the option off to upload without cropping. Choosing an existing image from
Packs does not crop it again.

Cropping uses a preview up to 768px, so very tight crops can lose detail.
References are saved as JPEG; transparency is not preserved.

### ⊹ Slots

| Slot | Sent when |
|---|---|
| char | The character's name appears in the prompt (falls back to the active character's name if the slot is unnamed). |
| user | Your persona's name appears in the prompt (falls back to the active persona name if unnamed). |
| NPC 1–4 | The NPC's name appears in the prompt text. |

Every slot, char and user included, is sent only when its name is in the prompt —
this is what keeps unrelated characters out of a scene. **Always send Char
reference** and **Always send User reference** override that for those two slots.

### ⊹ Name matching

Matching is **case-insensitive** and **whole-word**. Each slot name can hold
comma-separated aliases — any one matches:

```
Name field:  Ace, Acey
"Ace opens the door"  → match
"a quiet space"       → no match (whole-word)
```

The first alias supplies the filename slug on the server.

### ⊹ 4-image limit

The extension sends at most 4 refs/request. Priority: **char → user → NPCs**
(slot order). References after the fourth are not sent.

### ⊹ Smart file naming

Type a name and click away → the server file is renamed to match:

```
iig_ref_char_ace_u<unique-id>.jpeg
iig_ref_user_savannah_u<unique-id>.jpeg
iig_ref_npc_elias_u<unique-id>.jpeg
```

Slugs use lowercase ASCII letters, digits, `_` and `-`, up to 40 characters.
Other characters become underscores; names are not transliterated. Named NPCs
use `npc`; unnamed NPC files use their slot prefix (for example, `npc0`).
New filenames have a random unique suffix. Clearing or replacing a slot
retains its old server file because an unloaded chat may still reference it.
Use **Check ref storage** for an on-demand file count and measured size, then
**Clear refs folder** when you intentionally want to remove every stored ref.
The size check performs no polling or startup scan.

### ⊹ Caching

Refs are base64-cached in memory across generations. The first generation in a
chat does the real fetch + encode (heaviest step on mobile); the rest serve from
cache. Cache clears on chat switch.

### ⊹ Image Packs

A local library for reference images, so a face you reuse does not need
re-uploading per chat. The **Packs** pill sits next to **Remove** on every slot.

| Action | Control |
|---|---|
| Create a pack | **New pack** |
| Rename the selected pack | **Rename pack** |
| Delete the selected pack | **Delete pack** — asks first, and names the image count |
| Import images | **Add images** — multi-select, PNG / JPG / WebP |
| Browse | Counted pack list, thumbnail grid, and **Previous page** / **Next page** |
| Sort images | **Newest**, **Oldest**, **Name A–Z** or **Name Z–A** |
| Measure storage | **Check storage** reports pack count, image count and local size on demand |
| Use one | Click a thumbnail; it fills the slot you opened the popup from |
| Manage one | Open its corner menu to rename, move to an existing or new pack, or delete it |

Packs are **global** — one library shared by every chat, character and scope,
independent of the **Reference set** dropdown. Picking from a pack fills a slot
exactly as an upload does, so the active scope decides where that assignment is
stored. A subtle **Pack** marker stays with that assignment after reload and
scope changes. Replacing it with a normal upload or removing the photo clears
the marker. Older assignments made before this update may not have a marker.

- Stored in this browser via IndexedDB, not on the ST server. Clearing site data
  clears packs; another browser or profile has its own library.
- Sorting is remembered for the current session. Storage is measured only when
  requested and marked stale after pack or image changes.
- New imports are saved as JPEG at up to 768px to reduce storage use;
  transparency is not preserved. Previously stored originals are left unchanged.
- The gallery uses separate high-quality thumbnails. Older thumbnails upgrade
  automatically, one at a time, when their page is viewed.
- Each file must be at most 12MB. PNG, JPEG (including JFIF/JPE/JIF) and WebP
  are supported; the contents must match the file extension and decode properly.
- If browser storage fills up, remove unused library images or packs and retry.
- Deleting a pack does not touch reference slots already filled from it; those
  images live on the server as normal refs.
- Moving or deleting one packed image also leaves already-filled reference
  slots unchanged.

### ⊹ Global, Per-character and Per-chat

The **Reference set** dropdown controls where reference slots live:

- **Global** *(default)* — one reference set shared by every chat.
- **Per-character** — each character card remembers its own set; groups receive
  one set per group ID. Until edited, a character/group inherits Global.
- **Per-chat** — each chat remembers its own set. Until edited, a chat inherits
  its character/group set, then Global.

Changing the dropdown only changes which set is displayed; it never copies,
moves, or deletes refs. Editing a slot lazily creates that scope's independent
set. **Reset character to Global** removes the character/group override, while
**Reset chat to inherited** removes only the chat override. Typed names are
preserved when **Clear refs folder** removes image files and assignments.

---

## ✦ Advanced

A collapsible section at the bottom of **API Configuration** — two escape hatches
for non-standard providers:

- **Path override** — replaces the auto-appended URL suffix (e.g. if your provider
  serves images from `/api/v2/imagine`). Empty by default. Provider-agnostic.
- **Show all models** — disables the built-in image-model keyword filter. Enable
  when a successful model refresh omits models you know the provider offers.

---

## ✦ Image controls

**On any generated image**
- Desktop: hover or Tab to image controls; click the image or use **Full-size preview** for a lightbox. Escape closes it.
- Mobile: tap once to show the buttons; they hide after 4 seconds. No lightbox.

| Action | Scope |
|---|---|
| **Regenerate** | Regenerates only that image from its existing instruction. |
| **Rewrite prompt + regenerate** | The sparkle rewrites the selected image's prompt, then regenerates only that image, including images made by Prompt Model. |
| **Download / Open image to save** | Downloads on desktop; opens the image for saving on mobile. |

Sparkle uses the main Chat Completion model for narrative images and the configured
separate Prompt Model connection for Prompt Model images, including Gemini-compatible.
It leaves the narrative and other images alone. A compact composing bar appears
while the prompt is rewritten, followed by the normal image-generation loader.
The old image is temporarily hidden, not discarded; cancellation or a failed
rewrite or image generation brings it back.

Rewriting needs the exact recent generation context. If it has expired, the button
explains this instead of guessing; ordinary **Regenerate** still uses the existing
instruction. **Stop** is available until the replacement starts saving to the chat.

**On error images** — retry uses the existing instruction; sparkle rewrites it and
regenerates only that image. The same recent-context requirement applies.

**In the message menu** — a stacked-images icon regenerates **all** images at once.

**Rapid re-clicks** — ordinary regenerate ignores duplicate activation while it
is running. Use **Stop**, then retry to start again.

### ⊹ Completion sounds

Desktop reuses SillyTavern's message sound once per finished operation, not once
per image. SillyTavern's own **Play message sound** and **Only when unfocused**
settings still govern it. Mobile stays silent.

---

## ✦ Image Manager — optional

When [ST-ImageManager](https://github.com/Nufahi) is installed, **Open Image
Manager** appears at the bottom of the settings panel.

---

## ✦ Error handling

- **Smart hints** — errors carry a concrete recovery action. The same suggestion
  does not repeat within 30 seconds.
- **Refresh models** checks the image model catalog for OpenAI/Gemini-compatible
  connections and distinguishes an empty catalog from request failure.
- **Test Connection** is available for Naistera and checks its generation route
  without creating an image.
- **Export Logs** records redacted request metadata and diagnostics.

---

## ✦ Retry settings

| Setting | Default | Notes |
|---|:---:|---|
| Max Retries | `2` | Integer `0–5`; `0` disables retries except one on HTTP 500/502/503/504. |
| Delay | `1500 ms` | Integer `500–10000 ms`; doubles per attempt, capped at 30s, plus up to 500ms jitter. |

Retried automatically: **429**, **5xx**, transport **timeouts**, and image-level
**safety blocks**. Timeouts get one retry at most; safety blocks two.

A safety block on the *drawn image* is worth retrying — drawing is stochastic, so
the same request often clears next attempt, and refs are kept either way. A block
on the *prompt* is not retried: the filter rejected your text, so a replay fails
identically. Rephrase it, or turn off reference images if the hint says so.

---

## ✦ iOS / mobile

iOS uses XMLHttpRequest for long-running image requests.

| | Desktop | iOS |
|---|:---:|:---:|
| Transport | `fetch` + `AbortController` | `XMLHttpRequest` |
| Image timeout | 5 min | 3 min |

Settings save automatically. The extension also attempts to save pending
reference changes when you leave or background the page; a browser force-close
can still interrupt saving.

Wrapping work is batched, reference images are cached, and idle polling is
avoided. Large uploads and multiple simultaneous generations can still use
significant memory and battery.

---

## ✦ Troubleshooting

| Symptom | Fix |
|---|---|
| No images generating | Header dot green? Verify API Type, endpoint & key; use **Refresh models** for OpenAI/Gemini or **Test Connection** for Naistera. |
| "No models found" but you know they exist | Expand **Advanced** → enable **Show all models**. |
| Generation returns 404 | Verify the API Type, model ID, and documented endpoint base. Gemini automatically tests `/compatible`. |
| GPT Image says the model is not a language model | Select **OpenAI-compatible** and use the provider base without `/compatible`. |
| GPT Image references fail immediately | Confirm the request log shows `endpoint=edits`; references use multipart `/v1/images/edits`. |
| Characters look different each time | Upload character photos under **Character References**. |
| Grok on Naistera keeps failing with refs | Uncheck **Send reference images** under Naistera. |
| Hanging "Saving…" | Upload timeouts guard this (120s images, 60s refs). If it persists, check ST server logs. |
| Wrong aspect ratio | Aspect ratio is tag-driven. Tell the AI via OOC (*"all images 16:9"*) so it embeds it in each tag. |
| Packs are empty on another machine | Packs live in this browser's IndexedDB, not on the server. Each browser or profile has its own library. |
| A pack import rejects an image | Check the 12MB limit, supported format and matching file extension. |
| Need detailed logs | Debug → **Export Logs**. Look for `[ERROR]`. API keys are redacted automatically. |

---

## ✦ Credits

Forked from [sillyimages](https://github.com/0xl0cal/sillyimages) by [0xl0cal](https://github.com/0xl0cal).
The Naistera contract follows its integration by [Astera.vt](https://github.com/stellvt).

Rewritten by [**aceenvw**](https://github.com/aceeenvw) — protocol-driven
dispatch, the reference and scoping system, Image Packs, Prompt Model, presets,
the iOS transport layer, and the image controls documented above.

---

## ✦ License

**AGPL-3.0-or-later** — see [LICENSE](./LICENSE).
Copyright 2025–2026 **aceenvw**.

If you fork or adapt this code:

- Keep the copyright notice and license header in source files.
- State your changes prominently.
- Release under the same AGPL-3.0 license.
- Credit both **aceenvw** and **0xl0cal**.

```
Based on notsosillynotsoimages by aceenvw
https://github.com/aceeenvw/notsosillynotsoimages

Original: SillyImages by 0xl0cal
https://github.com/0xl0cal/sillyimages

Licensed under AGPL-3.0-or-later
```

<div align="center">

⊹ ✦ ⊹ ✦ ⊹

*Made with care by aceenvw.*

</div>

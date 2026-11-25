# ⊹ INLINE IMAGE GENERATION ⊹

Generate illustrations inside SillyTavern replies. When a reply contains an image tag, the extension sends its prompt to your image provider and displays the result in place.

## Generating images

- **Providers and presets:** Choose OpenAI-compatible, Gemini-compatible, Naistera, or direct NovelAI. Save your configuration as a preset to switch providers later.
- **Multiple NovelAI scenes:** Give each image its own prompt. Direct NovelAI generates them one at a time in reply order. Tap **Stop** on a waiting image to skip just that scene.
- **Prompt Model:** By default, your chat model writes the image instructions along with its reply. Turn on **Prompt Model** to let a separate text model read the finished reply and write the image instructions instead.
- **Try a different illustration:** Use **Regenerate** to draw one image again with the same instructions. Use **Rewrite prompt + regenerate** to change the instructions too. Both leave the rest of the reply alone.

## Reference photos and names

Use **Character References** to give the image provider a face to work from. There are slots for the character, your persona, and up to four NPCs.

- **Names and aliases:** Enter `Isa, Isadora` in one slot to use the same photo for either name. Matching ignores case and uses whole words: `isa` in the *image prompt* includes the photo, but `Isabelle` does not. Enable **Always send Char reference** or **Always send User reference** to include that photo even without a name match.
- **Where references apply:** Use **Global** for your usual set, **Per-character** for one character or group, or **Per-chat** for a single conversation. For example, give a character a different outfit in one chat, then use **Reset chat to inherited** to go back to their usual look.
- **Cropping and captions:** With **Crop uploads (references and packs)** enabled, choose a photo and frame the part you want. **Add Text** lets you place up to eight captions; drag each one into position and adjust its size, color, and outline. **Apply** saves the crop and captions into the image the provider receives. Cancel leaves the previous reference alone.

## Direct NovelAI

Select **NovelAI**, enter your persistent NovelAI API token, and choose **V5 Full**, **V5 Full Medium**, **V5 Curated**, **V4.5 Full**, or **V4.5 Curated**. Medium uses 14 steps and a fixed negative prompt. Switching back to another model restores your selected library negative. The token is remembered across reloads. Saving a NovelAI preset stores its token, endpoint, and model together. **Test Connection** checks the account without generating an image.

**Resolution** defaults to **Normal**. Turn off **Require free Opus eligibility** to unlock **Large (uses Anlas)**. Turning protection back on restores Normal.

**Aspect ratio** sets the shape for direct NovelAI images, including regenerations. Choose square or a portrait/landscape pair ranging up to 9:21 and 21:9. Enable **Rotate aspect ratio** to advance through the picker after each successful image. Turning rotation off restores your fixed ratio. Both resolutions support rotation; Large rounds the 13:19 pair to the pixel grid.

**Character Descriptions** uses the same names, aliases, and scopes as photo references. In the **Description library**, write a description or use **Appearance tags** to draft one from a portrait, character card, user persona, or lorebook entry. Review the tags before saving. Matched characters are sent as separate text captions.

In **Prompt Library**, save styles and negative prompts separately. Pick any combination, such as a watercolor style with a negative prompt that discourages lettering. Either selection can be turned off on its own.

**Require free Opus eligibility** is on by default. Each request checks your subscription before generating one normal-size image (23 steps, or 14 for Medium). V5 also requires remaining regular or already-activated extra usage. This is a preflight check, not a provider-side spending limit. Turning it off allows generation that may cost Anlas.

## Image Packs

Packs are reusable albums. Open **Packs** beside a reference slot and choose a saved photo instead of uploading or cropping it again. In **Per-character** mode, **Save as Pack** turns the current character, user, and NPC references into a named pack, keeping their names, crops, and captions.

The pack library is shared across your chats **in this browser profile**. Opening SillyTavern on another phone or browser won’t automatically bring the packs with you.

## Low-power mode

On a phone or an older device, turn on **Low-power mode** to reduce work while images are generating. You can disable animations, slow down progress and page updates, or use both options. It changes how often the interface updates, not the quality of the generated image.

## License & Credit

Licensed under [AGPL-3.0-only](./LICENSE). Please retain the upstream and fork copyright, license, and credit notices. A link back to this fork is appreciated.

> [Inline Image Generation](https://github.com/aceeenvw/notsosillynotsoimages) — fork and original modifications by **aceenvw**, based on [SillyImages](https://github.com/0xl0cal/sillyimages) by **0xl0cal (local) and Astera**.

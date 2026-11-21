# ⊹ INLINE IMAGE GENERATION ⊹

Generate illustrations inside SillyTavern replies. When a reply contains an image tag, the extension sends its prompt to your image provider and displays the result in place.

## Generating images

- **Providers and presets:** Connect an OpenAI-compatible, Gemini-compatible, or Naistera API. Pick a model from the list or enter its ID. Save your configuration as a preset to switch providers later.
- **Prompt Model:** By default, your chat model writes the image instructions along with its reply. Turn on **Prompt Model** to let a separate text model read the finished reply and write the image instructions instead.
- **Try a different illustration:** Use **Regenerate** to draw one image again with the same instructions. Use **Rewrite prompt + regenerate** to change the instructions too. Both leave the rest of the reply alone.

## Reference photos and names

Use **Character References** to give the image provider a face to work from. There are slots for the character, your persona, and up to four NPCs.

- **Names and aliases:** Enter `Isa, Isadora` in one slot to use the same photo for either name. Matching ignores case and uses whole words: `isa` in the *image prompt* includes the photo, but `Isabelle` does not. Enable **Always send Char reference** or **Always send User reference** to include that photo even without a name match.
- **Where references apply:** Use **Global** for your usual set, **Per-character** for one character or group, or **Per-chat** for a single conversation. For example, give a character a different outfit in one chat, then use **Reset chat to inherited** to go back to their usual look.
- **Cropping and captions:** With **Crop uploads (references and packs)** enabled, choose a photo and frame the part you want. **Add Text** lets you place up to eight captions; drag each one into position and adjust its size, color, and outline. **Apply** saves the crop and captions into the image the provider receives. Cancel leaves the previous reference alone.

## Image Packs

Packs are reusable albums. Open **Packs** beside a reference slot and choose a saved photo instead of uploading or cropping it again. In **Per-character** mode, **Save as Pack** turns the current character, user, and NPC references into a named pack, keeping their names, crops, and captions.

The pack library is shared across your chats **in this browser profile**. Opening SillyTavern on another phone or browser won’t automatically bring the packs with you.

## Low-power mode

On a phone or an older device, turn on **Low-power mode** to reduce work while images are generating. You can disable animations, slow down progress and page updates, or use both options. It changes how often the interface updates, not the quality of the generated image.

## License & Credit

Licensed under [AGPL-3.0-or-later](./LICENSE). Please retain the copyright and license notices and link back in forks and redistributions.

> [Inline Image Generation](https://github.com/aceeenvw/notsosillynotsoimages) by **aceenvw**, based on [SillyImages](https://github.com/0xl0cal/sillyimages) by **0xl0cal**.

[HTML CSS]
Your task is to enhance the narrative by embedding a unique visual artifact into every response. You must vary its placement: at the beginning, between paragraphs, or at the end. Each artifact must be a clickable, interactive element built with HTML and CSS, integrating images. These artifacts must embody the context of the current scene through objects, portraits, locations, or emotional atmospheres.

Technical requirements for HTML and CSS:
- Do NOT use markdown code blocks like triple backticks.
- Do NOT use JavaScript.
{{setvar::ru_html_language::- All visible artifact text must be in Russian only.}}
{{setvar::ua_html_language::- All visible artifact text must be in Ukrainian only.}}
- The code must be fully responsive and optimized for smartphone browsers using mobile-first principles.
- Use responsive relative sizing appropriate for mobile screens.
- Every artifact must be fundamentally different from previous ones in shape, logic, and execution.
- Clickable areas must be at least 44x44px for touch accessibility.
- Use a unique wrapper div with a specific ID for each artifact to prevent style conflicts.
Advanced CSS Interaction Logic:
- Cycle through different interaction methods for each response:
- The Input Hack. Use hidden radio buttons or checkboxes with the sibling selector (~) to create multi-step interfaces or state-switching (e.g., opening a chest or changing a character's expression).
- 3D Transforms. Use perspective and rotateY properties to create flipping cards, unfolding letters, or rotating objects.
- Masking and Clipping. Use clip-path to create non-rectangular shapes, like broken glass, stars, or a "flashlight" effect over an image.
- Pure CSS Overlays. Use the :active pseudo-class or focus states to trigger modal-like expansions or zoom effects.
- Keyframe Animation. Create "living" scenes with parallax scrolling or floating elements that respond to the user's presence.

Image generation:
- Each artifact must contain 1 to 5 images.
- Wrap `data-iig-instruction` in single quotes and use valid double-quoted JSON inside it:
- After writing valid JSON, HTML-escape `&`, `'`, `<` and `>` inside that attribute as `&amp;`, `&#39;`, `&lt;` and `&gt;`. Keep JSON double quotes unchanged; for example, `"prompt":"Ace&#39;s portrait"`. Do not use `\'` as a JSON escape.
- Format: `<img data-iig-instruction='{"style":"[STYLE]","prompt":"[DESC]","aspect_ratio":"[RATIO]","image_size":"[SIZE]"}' src="[IMG:GEN]">`
- [STYLE]: Use a known game engine, animation studio style, cinematic look, or real-world medium.
- [DESC]: A detailed prompt of 100+ english words describing the image.
- [RATIO]: Aspect ratio - "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9". Choose based on scene composition.
- [SIZE]: Image resolution - "1K" (default), "2K", "4K" for higher quality.
- Every tag must include `aspect_ratio` and `image_size`. Apply any ratio or resolution requested via OOC directly to those fields.
- Famous Characters: Use their names (e.g., Krul Tepes) and provide a detailed physical description.
- Original Characters or User: Describe details including gender, physique, eye and hair color, unique features (e.g., fangs, gradient cat ears with specific colors), clothing, and current emotions.
- Every new image must use `src="[IMG:GEN]"`.
- Never copy completed image paths from chat history.
- Include each depicted character's configured reference name or alias in the prompt; references are name-gated. Do not identify a referenced character by appearance alone.
{{setvar::largecothtml::
- Add a story-appropriate HTML element that differs from recent artifacts.}}

# Choly reference setup

In Tác vụ → Choly Cutie, upload up to four source photographs. Each slot can retain its preset or specify male KOL, female KOL, couple, hands only, or objects only. Custom scene roles apply only to uploaded references. Source images occupy reference #1; garments, pinned identities and selected packaging follow with explicit roles.

Zip pouch, thank-you tag and kraft box can use saved assets or custom uploads. The Analyze button calls OpenAI vision (configured BEST_TEXT_MODEL) to return four editable English prompts following the supplied eleven-part photography formula. This endpoint never calls an image generator. Editing setup invalidates previously prepared prompts. Blank prompt fields are analyzed when generation starts; nonblank fields are used with server-enforced reference-role constraints.

All Choly image generation uses the existing openai_25 adapter (gpt-image-2.5-sunburst), including people and hands. Output retains the existing 1152×1536 / 3:4 pipeline. The prompt records source dimensions separately. Captions are still an optional separate rendering step. Other application tabs retain their existing provider settings.

Validation: python3 -m unittest tests.test_choly_studio (14 tests), node --check public/choly-studio.js; browser verified upload controls, packaging choices and editable prompt fields. No live paid image generation was performed. Choly requires only OPENAI_API_KEY; no Anthropic or Gemini key is needed.

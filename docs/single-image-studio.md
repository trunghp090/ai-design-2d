# Single-image workflow

The homepage contains no tab navigation. Upload one reference, optionally select a saved/uploaded KOL and zip pouch, box and thank-you tag. Analyze produces one editable English prompt using the eleven-section photography formula via the existing OpenAI text/vision connection. Generate consumes that prompt plus the same role-ordered references and creates one image through openai_25. No captions, four-scene presets or mandatory garment input. Source aspect is included in the prompt; size=auto lets the provider choose supported output dimensions without an application crop.

Single jobs share existing authenticated, owner-scoped job/result storage. Request IDs prevent duplicate dispatch; results survive reload and failed jobs retain errors. Existing records are preserved; only single-mode jobs appear in the new UI. No Anthropic dependency.

Validation: 20 single-image and Choly tests passed; JavaScript syntax and diff whitespace checks passed. No live image generation during this change.

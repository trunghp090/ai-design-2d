# Performance fixes — 2026-09-11

Applied to the local app at http://localhost:8000, version `2026.09.11-performance`.

- Mockup selection and Lên áo grids use lazy, asynchronously decoded 480px JPEG previews. Export composition still reads the original PNG via `slot.url`. Thumbnail writes are serialized per lock stripe and atomic; source changes invalidate previews.
- Recolor dragging updates the editor immediately and rebuilds the full image set after release. Sliders and keyboard edits coalesce; superseded compositions stop between images and yield to the browser.
- Background color inputs coalesce expensive PNG rendering and reject stale image loads.
- The shared decoded-image cache retains at most 24 entries and retries failed image loads.
- Design, setshirt and personalized polling serialize requests, use incremental cursors and skip unchanged card rendering. Post lists avoid rebuilding cards for countdown-only updates.
- Roundup preview updates coalesce per frame. Draft persistence relies on IndexedDB structured cloning instead of JSON-copying uploaded images first.
- Static files use a bounded cache, cached gzip and conditional ETags. All local JS/CSS links are versioned together.
- Access logging uses rotating files in data/access.log. The local process writes stdout/stderr to a file rather than a pipe. scripts/run_local.py preserves loopback binding and the existing scheduler.

## Measurements and checks

40 existing mockup originals: 60.45 MB; corresponding thumbnails: 0.44 MB (99.3% fewer image bytes). This is an asset-size reduction, not an overall app-speed percentage. Cold thumbnail median: 24.5 ms on this machine. Warm local GET median: app.js 0.32 ms and one thumbnail 0.29 ms (9 measured warm requests each). Compressed app.js: 140,884 bytes. Conditional requests return 304.

61 Python tests and 21 Node tests passed. Python suite ran with outbound urllib requests disabled and sleeps patched; a stale KOL test mocked the old provider and was updated to mock the current OpenAI planner. Browser smoke checks covered authentication, navigation, Image Studio, Lên áo (40 cards, lazy preview sources) and recolor entry; no browser errors observed during these checks. No paid image generation was used as a performance benchmark.

Original files at the start of this task were copied to /tmp/aidesign-perf-before for comparison. The repository already contained extensive uncommitted work; those changes were preserved. No remote deployment was performed.

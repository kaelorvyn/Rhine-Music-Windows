# PR15 B web rendering extraction

Source: PacificSauryMan's [PR #15](https://github.com/LBEILC/RhineLabUI/pull/15), head `257e939a43460332c836498529de003eb54dbe26`. Original visuals, models, scenes, motion and original ambient audio: LBEILC / RhineLabUI. See `PR15-ATTRIBUTION.md` for attribution and scope.

Baseline and current remote main checked on 2026-10-05: `129553bce3496f3826ef343b539ca46d25b94852`.

## Scope

- Frame-local waveform memoization; invalidate projected music samples after camera motion.
- Coalesce uncaptured mouse hover picking to the latest sample once per update. Captured dragging and release handling remain immediate; leave/cancel/down clear pending hover.
- Remove unused depth attachments from fullscreen SSAO and blur targets. Keep the original normal/depth target, AO kernel, blur and packed Bokeh sharing.
- Compact visible drawing while retaining the existing pool for independent offscreen shadow casters. Cache shadow state and invalidate both image and shadow caches on WebGL context restoration.
- Skip waveform work only when the authored envelopes are exactly zero or a theme wave is fully settled.

Excluded: C/new AO filtering, DSH integration, installers, desktop quality presets, model/asset changes, benchmark injection, deployment scripts/configuration. Review-only `reference/pr15-ab.*` is untracked and excluded from this extraction.

## Validation

The declared `prebuild` and `build` steps were executed in order using the bundled Node v24.19.0: patch rolling-number, export records, prepare webfonts, `tsc`, Vite production build and PWA build. All succeeded. Vite processed 102 modules; PWA output `c1d411765a799100`, 818 files, 33.8 MiB. The existing large-chunk advisory remains. Generated archive downloads were restored to their pre-build checkout content and are excluded from the commit. No Cloudflare packaging or deployment command was executed.

```powershell
node --experimental-transform-types --test scripts/check-pr15-port.mjs scripts/check-render-updates.mjs scripts/check-motion.mjs scripts/check-theme.mjs scripts/check-archive-visibility.mjs scripts/check-archive-drag.mjs scripts/check-viewport.mjs
```

10 checks passed: conservative frustum bounds and independent shadow buffers (including growth/count changes), exact waveform boundaries and long-running times, theme reversal/new cells, shared AO/Bokeh depth, upload ranges/cache precision, motion, theme, viewport/coverage and drag math.

```powershell
node scripts/check-pr15-rendering.mjs
```

Against the local Vite fixture in headless Edge, 11 browser checks passed with zero page errors: queued/latest hover, leave/cancel clearing, texture-only shadow reuse, actual WebGL loss/restoration with shadow regeneration, resumed reuse, shared detail depth, exclusion/restoration of shadow-only geometry, AO target depth attachments and shadow mesh disposal. The script only validates behavior and does not call the performance sampling API. Set `PLAYWRIGHT_MODULE` when using a bundled Playwright installation and `REVIEW_URL` for a non-default local server URL.

`git diff --check` passed. Production output contains neither PR15 review pages nor the reference performance fixture.

## Existing performance and image evidence

No benchmark was rerun for this production cleanup. On RTX 5070 Ti Laptop / ANGLE D3D11, 1920x1080 / DPR 1, original quality (32 AO, full-resolution AO, 2048 shadows, DOF 100), existing valid three-round measurements used 3s warm-up plus approximately 10s sampling per round. Aggregate RAF FPS = total sample frames / total measured seconds:

| Scene | A frames / seconds | B frames / seconds | A FPS | B FPS |
|---|---:|---:|---:|---:|
| idle/light | 4538 / 30.0010 | 4733 / 30.0012 | 151.26 | 157.76 |
| navigate/light | 4446 / 30.0008 | 4408 / 30.0064 | 148.20 | 146.90 |

Idle showed a modest improvement, while navigation showed no stable benefit. Median frame interval was about 5.6ms. The invalid occluded initial run was excluded. All six fixed A/B scene PNGs were byte-identical, including the corrected nonblank clear glass detail capture. This is evidence for those snapshots, not all animation times or devices. The context-restoration fix does not change normal scene rendering and was validated separately above.

## Deployment boundary

The initial extraction was prepared with `[CF-Pages-Skip]` and no deployment. On 2026-10-05 the owner explicitly authorized deploying after merging PR #16, superseding that boundary. The PR title and final merge title omit the skip prefix; existing Cloudflare configuration remains unchanged.

PRs #12, #13 and #16 were tested together before merging: production/PWA build, 29 logic checks, 11 Edge rendering checks, and native keyboard checks for custom quality selection and modal license-link navigation passed. PR #16 merged as `d0c023b21a5262f6084c536db91e74a33571a950`. Cloudflare production deployment `8328242d-3ebf-40e3-af7e-cbe1ea05811a` succeeded at 2026-10-05 20:45:16 (UTC+8).

Both the deployment URL and `rhine.lubeiluchen.cc` serve PWA version `c1149b36b86fa692`, with 821 manifest entries. The production JavaScript matches the tested build byte-for-byte; the three licensed webfonts match the local verified sources. Homepage, stylesheet, worker and update entry return 200; update cache policies and missing-asset 404 behavior passed. This is a focused production check, not an exhaustive comparison of all manifest entries.

The owner also confirmed that this repository will maintain only the website. PR #15 was replied to and closed, explaining that its applicable web optimizations were accepted through #16 and recommending independent maintenance of the DSH theme. The contributor branch was not changed.

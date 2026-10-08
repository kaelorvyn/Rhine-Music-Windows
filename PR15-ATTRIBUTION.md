# PR #15 Web optimization extraction

Source: https://github.com/LBEILC/RhineLabUI/pull/15 at `257e939a43460332c836498529de003eb54dbe26`.

Original visuals, scenes, models, animations and original ambient audio: **LBEILC / RhineLabUI**.
PR contributor: **PacificSauryMan**. DSH adaptation, performance optimizations and PR preparation assisted by **OpenAI Codex**, as credited in the original PR.

This extraction adapts only the tested B rendering optimizations into the original Web scene. Source code retains the repository MIT license. No DSH host, installer, native patcher, theme lifecycle, project/session state or publishing workflow is included. Quality presets and model bytes remain unchanged.

Adapted areas: frame-local waveform memoization, coalesced uncaptured hover picking, removal of unused AO depth attachments, visible draw coverage with independent offscreen shadow coverage, shadow reuse, and exactly-zero/settled waveform shortcuts. The original AO kernel and blur remain unchanged. Regression checks are in `scripts/check-pr15-port.mjs` and `scripts/check-pr15-rendering.mjs`.

Measured on RTX 5070 Ti Laptop / ANGLE D3D11, 1920x1080 / DPR 1, original quality (32 AO samples, full-resolution AO, 2048 shadows, DOF 100): three rounds per idle/navigation scene, each with 3s warm-up and approximately 10s sampling. Aggregate RAF FPS is total sample frames / total elapsed time: idle A 4538/30.0010 = 151.26, B 4733/30.0012 = 157.76; navigation A 4446/30.0008 = 148.20, B 4408/30.0064 = 146.90. Idle improved modestly; navigation showed no stable benefit. The invalid occluded initial run was excluded. All six fixed A/B scene PNGs were byte-identical; this does not establish full-time or cross-device equivalence.

The final production cleanup also invalidates the shadow cache on WebGL context restoration. Review-only benchmark injection is excluded from the commit and production bundle. This extraction is independent of the original PR #15, which remains open and unchanged. No deployment configuration is changed.

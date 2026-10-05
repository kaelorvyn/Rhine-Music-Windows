// Browser regression for the B extraction; does not sample performance.
// Run against a local Vite server. PLAYWRIGHT_MODULE may point to a bundled runtime.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_MODULE || "playwright",
);
const browser = await chromium.launch({ channel: "msedge", headless: true });
const results = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    `${process.env.REVIEW_URL || "http://127.0.0.1:5173"}/reference/performance.html`,
  );
  await page.waitForFunction(() => window.bench, { timeout: 60000 });
  results.push(
    ...(await page.evaluate(async () => {
      await bench.prepare("static");
      const scene = bench.scene,
        canvas = scene.renderer.domElement,
        checks = [];
      const record = (name, passed) =>
        checks.push({ name, passed: Boolean(passed) });
      const pick = scene.pickCell.bind(scene);
      const events = [];
      scene.pickCell = (x, y) => {
        events.push([x, y]);
        return pick(x, y);
      };
      const move = (x, y) =>
        canvas.dispatchEvent(
          new PointerEvent("pointermove", {
            clientX: x,
            clientY: y,
            pointerType: "mouse",
          }),
        );
      move(800, 500);
      move(810, 510);
      move(820, 520);
      record("hover waits for next update", events.length === 0);
      bench.draw();
      record(
        "hover samples only latest pointer once",
        events.length === 1 && events[0][0] === 820 && events[0][1] === 520,
      );
      move(830, 530);
      canvas.dispatchEvent(new PointerEvent("pointerleave"));
      bench.draw();
      record(
        "pointer leave clears pending hover",
        events.length === 1 && scene.hoverCell === null,
      );
      move(840, 540);
      scene.cancelPointer();
      bench.draw();
      record("pointer cancellation clears pending hover", events.length === 1);
      scene.pickCell = pick;

      await bench.prepare("static");
      let shadowUpdates = 0;
      const observeShadow = () => {
        const shadow = scene.renderer.shadowMap,
          renderShadow = shadow.render;
        shadow.render = function (...args) {
          if (this.enabled && this.needsUpdate) shadowUpdates++;
          return renderShadow.apply(this, args);
        };
        return () => {
          shadow.render = renderShadow;
        };
      };
      let stopObserving = observeShadow();
      scene.labelTexture.needsUpdate = true;
      bench.draw();
      record("texture-only redraw reuses shadow map", shadowUpdates === 0);
      const loss = scene.renderer
        .getContext()
        .getExtension("WEBGL_lose_context");
      if (!loss)
        throw new Error("WEBGL_lose_context is required for this regression");
      stopObserving();
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("WebGL restoration timed out")),
          10000,
        );
        canvas.addEventListener(
          "webglcontextrestored",
          () => {
            clearTimeout(timeout);
            resolve();
          },
          { once: true },
        );
        canvas.addEventListener(
          "webglcontextlost",
          (event) => {
            event.preventDefault();
            setTimeout(() => loss.restoreContext(), 50);
          },
          { once: true },
        );
        loss.loseContext();
      });
      // Three replaces renderer.shadowMap during context restoration.
      stopObserving = observeShadow();
      bench.draw();
      record("context restore invalidates shadow cache", shadowUpdates > 0);
      const restored = shadowUpdates;
      scene.labelTexture.needsUpdate = true;
      bench.draw();
      record("shadow reuse resumes after restore", shadowUpdates === restored);
      stopObserving();

      scene.setMode("detail");
      scene.resize();
      bench.draw();
      record(
        "detail draws with shared packed depth",
        scene.ao.normalRenderTarget.depthBuffer &&
          scene.ao.normalRenderTarget.textures.length === 2,
      );
      record(
        "shadow-only mesh restored after AO and colour passes",
        scene.shadowCoverage.mesh.visible &&
          scene.shadowCoverage.mesh.count > 0,
      );
      record(
        "AO fullscreen targets have no redundant depth",
        !scene.ao.ssaoRenderTarget.depthBuffer &&
          !scene.ao.blurRenderTarget.depthBuffer,
      );
      const coverage = scene.shadowCoverage.mesh;
      let disposed = false;
      coverage.addEventListener("dispose", () => {
        disposed = true;
      });
      scene.dispose();
      record(
        "scene disposal releases independent shadow mesh",
        disposed && !canvas.isConnected,
      );
      return checks;
    })),
  );
  console.log(JSON.stringify({ checks: results, pageErrors: errors }, null, 2));
  for (const result of results) assert.equal(result.passed, true, result.name);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}

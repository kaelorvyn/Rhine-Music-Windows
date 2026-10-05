// Adapted checks from PR #15 performance.test.mjs, credited in PR15-ATTRIBUTION.md.
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  ArchiveDrawCoverage,
  ArchiveShadowCoverage,
} from "../src/archive-draw-coverage.ts";
import { archiveWave, smooth } from "../src/motion.ts";
import { ThemeWave } from "../src/theme-motion.ts";
import { SharedDepthAO } from "../src/shared-depth.ts";
test("visible edge bounds and independent offscreen shadow transforms", () => {
  const camera = new THREE.PerspectiveCamera(45, 16 / 9, 1, 100);
  camera.position.set(0, 0, 20);
  camera.updateMatrixWorld();
  const coverage = new ArchiveDrawCoverage();
  coverage.update(camera);
  assert.equal(coverage.contains(0, -2, 0), true);
  assert.equal(coverage.contains(100, -2, 0), false);
  assert.equal(
    coverage.contains((Math.tan(Math.PI / 8) * 20 * 16) / 9 + 2, -2, 0),
    true,
  );
  const geometry = new THREE.BoxGeometry(),
    material = new THREE.MeshBasicMaterial();
  const source = new THREE.InstancedMesh(geometry, material, 1);
  source.castShadow = true;
  const shadow = new ArchiveShadowCoverage(source),
    matrix = new THREE.Matrix4();
  shadow.begin();
  shadow.add(matrix);
  shadow.add(matrix.makeTranslation(100, 0, 0));
  assert.equal(shadow.commit(), true);
  assert.equal(source.castShadow, false);
  assert.equal(shadow.mesh.count, 2);
  assert.equal(shadow.mesh.instanceMatrix.array[28], 100);
  shadow.mesh.onBeforeRender();
  assert.equal(shadow.mesh.count, 0);
  shadow.mesh.onAfterRender();
  assert.equal(shadow.mesh.count, 2);
  shadow.begin();
  shadow.add(matrix.identity());
  shadow.add(matrix.makeTranslation(100, 0, 0));
  assert.equal(shadow.commit(), false);
  shadow.begin();
  shadow.add(matrix.identity());
  assert.equal(shadow.commit(), true);
  assert.equal(shadow.mesh.count, 1);
  shadow.mesh.dispose();
  source.dispose();
  geometry.dispose();
  material.dispose();
});
test("zero scan shortcut agrees with authored waveform at boundaries and long-running times", () => {
  const bell = (x, w) => Math.exp(-0.5 * (x / w) ** 2);
  const original = (row, lane, time) => {
    const t = time - 22,
      phase = row + (lane - 2) * 0.65,
      packet = (x) => 2.5 * bell(x, 3.8) - 0.58 * bell(x - 6, 3.5);
    return (
      smooth(t / 0.32) *
      (packet(phase - (3 + t * 19)) * (1 - smooth((t - 2.15) / 0.65)) +
        packet(phase - (32 - (t - 2.3) * 24)) *
          smooth((t - 2.17) / 0.32) *
          (1 - smooth((t - 3.5) / 0.85)))
    );
  };
  for (const time of [
    0,
    21.9,
    22 - 1e-10,
    22,
    22 + 1e-10,
    23,
    24,
    25.5,
    26.35 - 1e-10,
    26.35,
    26.35 + 1e-10,
    1000,
  ])
    for (let lane = -4; lane < 9; lane++)
      for (let row = -20; row < 60; row += 0.5)
        assert.ok(
          Math.abs(archiveWave(row, lane, time) - original(row, lane, time)) <
            1e-14,
        );
});
test("settled theme shortcut preserves mid-transition reversal and newly visible cells", () => {
  const wave = new ThemeWave(),
    origin = { row: 12, lane: 2 },
    distant = { row: 120, lane: 9 };
  wave.set(true, 10, origin);
  wave.beginFrame();
  const near = wave.sample(origin, 10.4),
    far = wave.sample(distant, 10.4);
  assert.ok(near > far);
  wave.set(false, 10.4, origin);
  assert.equal(wave.sample(origin, 10.4), near);
  assert.equal(wave.sample(distant, 10.4), far);
  wave.beginFrame();
  assert.equal(wave.sample(origin, 12), 0);
  assert.equal(wave.sample(distant, 12), 0);
  wave.set(true, 12, origin);
  wave.beginFrame();
  assert.equal(wave.sample(distant, 14), 1);
  wave.set(false, 14, origin);
  assert.equal(wave.sample({ row: -300, lane: -20 }, 14), 1);
});
test("AO depth-buffer removal preserves normal depth and shared packed Bokeh depth", () => {
  const pass = new SharedDepthAO(
    new THREE.Scene(),
    new THREE.PerspectiveCamera(30, 1, 5, 300),
    800,
    600,
    32,
  );
  assert.equal(pass.normalRenderTarget.depthBuffer, true);
  assert.ok(pass.normalRenderTarget.depthTexture);
  assert.equal(pass.ssaoRenderTarget.depthBuffer, false);
  assert.equal(pass.blurRenderTarget.depthBuffer, false);
  assert.equal(pass.normalRenderTarget.textures.length, 2);
  pass.setSharing(false);
  assert.equal(pass.normalRenderTarget.textures.length, 1);
  pass.setSharing(true);
  assert.equal(pass.normalRenderTarget.textures.length, 2);
  pass.dispose();
});

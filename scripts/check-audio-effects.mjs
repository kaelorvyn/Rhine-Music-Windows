// Audio effects: panel interaction (reference layout) and chain DSP verification
// through OfflineAudioContext — synthetic only.
import { chromium } from 'playwright';
import { createServer } from 'vite';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const pageHtml = `<html><head><style>:root{--line:#ccc;--ink:#222;--surface:#fff;--muted:#777;--accent:#ca6734}body{margin:20px;font:14px sans-serif}</style></head><body><div id="host"></div>
<script type="module">
import { AudioEffectsChain, applyPreset, defaultEffectsConfig, effectsPresets, normalizeEffectsConfig } from '/src/audio-effects.ts';
import { AudioEffectsPanel } from '/src/audio-effects-panel.ts';
window.effectsPresets = effectsPresets; window.defaultEffectsConfig = defaultEffectsConfig;
window.changeLog = [];
window.panel = new AudioEffectsPanel();
window.openEffects = config => window.panel.open(config, value => window.changeLog.push(value));
// Offline render: sine tones through the chain; returns low-band peak amplitude.
window.render = async config => {
  const context = new OfflineAudioContext(2, 8000 * 2, 8000);
  const chain = new AudioEffectsChain(context);
  chain.apply(normalizeEffectsConfig(config));
  chain.output.connect(context.destination);
  const buffer = context.createBuffer(2, 8000 * 2, 8000);
  for (const channel of [0, 1]) { const data = buffer.getChannelData(channel); for (let i = 0; i < data.length; i++) data[i] = Math.sin((2 * Math.PI * (channel ? 3000 : 200) * i) / 8000); }
  const source = context.createBufferSource(); source.buffer = buffer; source.connect(chain.input); source.start();
  const rendered = await context.startRendering();
  let peak = 0; const low = rendered.getChannelData(0);
  for (let i = 0; i < low.length; i++) peak = Math.max(peak, Math.abs(low[i]));
  return peak;
};
window.applyPreset = applyPreset;
window.ready = true;
</script></body></html>`;

const server = await createServer({ configFile: false, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error', plugins: [{ name: 'effects-test-page', configureServer(vite) { vite.middlewares.use((request, response, next) => {
  if (request.url !== '/effects-test') return next();
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(pageHtml);
}); } }] });

let browser;
let page;
try {
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--autoplay-policy=no-user-gesture-required'], timeout: 15000 });
  page = await browser.newPage(); const errors = [];
  page.setDefaultTimeout(30000);
  page.on('console', message => { if (message.type() === 'error') console.error('CONSOLE:', message.text()); });
  page.on('pageerror', error => { errors.push(error.message); console.error('UI error:', error.message); });
  await page.goto(`${base}/effects-test`);
  await page.waitForFunction(() => window.ready);

 // Panel: sections, ten EQ bands and sixteen presets follow the standard layout.
  await page.evaluate(() => window.openEffects(window.defaultEffectsConfig));
  await page.locator('.fx-overlay').waitFor();
  assert.match(await page.locator('.fx-section-title').first().textContent() ?? '', /音效（原生处理）/, 'native-DSP master switch comes first');
  assert.match(await page.locator('.fx-section-title').nth(1).textContent() ?? '', /预设/, 'reference layout leads with the preset library');
  assert.match(await page.locator('.fx-section-title').nth(2).textContent() ?? '', /十段均衡器/, 'reference layout keeps the equalizer');
  assert.equal(await page.locator('[data-fx-band]').count(), 10, 'ten EQ bands');
  assert.equal(await page.locator('.fx-preset').count(), 16, 'sixteen presets');
  assert.equal(await page.locator('[data-fx-range="preampDb"]').count(), 1, 'preamp slider');

 // Controls write through the change callback with normalized values.
  await page.locator('[data-fx-toggle="eqEnabled"]').check();
  await page.locator('[data-fx-band="2"]').fill('4');
  let latest = await page.evaluate(() => window.changeLog.at(-1));
  assert.equal(latest.eqEnabled, true);
  assert.equal(latest.eqBands[2], 4);

 // Preset application matches the transcribed service table (bass = 深潜低频).
  await page.locator('[data-fx-preset="bass"]').click();
  latest = await page.evaluate(() => window.changeLog.at(-1));
  assert.equal(latest.eqEnabled, true);
  assert.equal(latest.preampDb, -4);
  assert.deepEqual(latest.eqBands, [1.8, 2.2, 1.1, -0.7, -0.5, 0, 0, 0, 0, 0]);

 // Auto preamp compensates the loudest positive stage (service algorithm).
  await page.locator('[data-fx-preset="pop"]').click();
  await page.locator('[data-fx-auto-preamp]').click();
  latest = await page.evaluate(() => window.changeLog.at(-1));
  assert.equal(latest.preampDb, -2.2, 'pop peaks at +1.2 dB → -(1.2+1)');

 // Reset restores the defaults.
  await page.locator('[data-fx-reset]').click();
  latest = await page.evaluate(() => window.changeLog.at(-1));
  assert.deepEqual(latest.eqBands, Array(10).fill(0));
  assert.equal(latest.preampDb, 0);
  await page.locator('[data-fx-close]').click();
  assert.equal(await page.locator('.fx-overlay').count(), 0);

 // DSP: the chain passes audio and an EQ preset measurably shapes it.
  const bypass = await page.evaluate(() => window.render(window.defaultEffectsConfig));
  const shaped = await page.evaluate(() => window.render(window.applyPreset(window.defaultEffectsConfig, window.effectsPresets.find(preset => preset.id === 'rock'))));
  assert.ok(bypass > 0.05, `chain passes audio (peak ${bypass})`);
  assert.ok(Math.abs(bypass - shaped) > 0.01, `EQ preset shapes the signal (bypass ${bypass}, shaped ${shaped})`);
  const muffled = await page.evaluate(() => window.render({ ...window.defaultEffectsConfig, eqEnabled: true, eqBands: [-12, -12, -12, -12, -12, -12, -12, -12, -12, -12] }));
  assert.ok(muffled < bypass * 0.8, `deep cut attenuates (bypass ${bypass}, cut ${muffled})`);

  assert.deepEqual(errors, []);
  console.log('Audio effects: service-layout panel, preset/auto-preamp/reset flows and Web Audio chain shaping passed.');
} catch (failure) {
  console.error(failure.message);
  await fs.mkdir('artifacts/audio-effects', { recursive: true }).catch(() => {});
  await page?.screenshot({ path: 'artifacts/audio-effects/failure.png', timeout: 3000 }).catch(() => {});
  throw failure;
} finally {
  await browser?.close(); await server.close();
}

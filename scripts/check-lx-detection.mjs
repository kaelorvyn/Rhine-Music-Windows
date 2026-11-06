// Hermetic detection regressions: synthetic plugins and loopback audio only.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LxSourceRuntime } from './lx-source-loader.mjs'
import { LxSourceHost } from './lx-source-host.mjs'
import { createMusicServer } from './music-server.mjs'

const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const idFor = (name) => `lx-${crypto.createHash('sha1').update(name).digest('hex').slice(0, 16)}`
const probes = ['wy', 'kg'].map((source) => ({ source, keyword: 'fixture singer', info: { id: '1' } }))

function runtimeFixture() {
  const runtime = new LxSourceRuntime({ guardRejections: false })
  for (const [id, keys] of [['alpha', ['wy', 'kg']], ['beta', ['wy']]]) {
    runtime.plugins.set(id, {
      id, meta: { name: id }, filePath: `${id}.js`, fingerprint: `${id}-v1`,
      sources: new Map(keys.map((key) => [key, { key, actions: ['musicUrl'], qualitys: ['flac'] }])),
      musicUrl: async () => `http://fixture.invalid/${id}.flac`,
    })
  }
  runtime._verifyUrl = async () => ({ ok: true })
  runtime.setDisabled(['beta'])
  runtime.health.set('alpha|wy', { ok: true, ms: 99, source: 'wy' })
  runtime.health.set('beta|wy', { ok: true, ms: 77, source: 'wy' })
  return runtime
}

test('batch checks enabled sources; source counters differ from platform jobs and publish active names', async () => {
  const runtime = runtimeFixture()
  const beta = runtime.health.get('beta|wy')
  const frames = []
  const report = await runtime.selfCheck({ probes, onProgress: (frame) => frames.push(frame) })
  assert.equal(report.checked, 2)
  assert.equal(report.alivePlugins, 1)
  assert.equal(runtime.health.get('beta|wy'), beta)
  assert.equal(frames[0].phase, 'prepare')
  assert.ok(frames.some((f) => f.activeSources.some((source) => source.name === 'alpha')))
  const last = frames.at(-1)
  assert.equal(last.total, 2)
  assert.deepEqual([last.sourceTotal, last.sourceDone, last.sourceRemaining], [1, 1, 0])
  assert.equal(last.running, false)
  assert.deepEqual(last.activeSources, [])
})

test('single disabled source can be checked; scoped import clears missing results and preserves other sources', async () => {
  const playback = runtimeFixture()
  const check = runtimeFixture()
  const alpha = playback.health.get('alpha|wy')
  await check.selfCheck({ pluginIds: ['beta'], probes })
  playback.importHealth(check.exportHealth())
  assert.equal(playback.health.get('alpha|wy'), alpha)
  assert.equal(playback.health.get('beta|wy').ok, true)
  assert.equal(playback.listPlugins().find((p) => p.id === 'beta').enabled, false)
  await check.selfCheck({ pluginIds: ['beta'], probes, budgetMs: 0 })
  assert.equal(check.health.has('beta|wy'), false)
  playback.importHealth(check.exportHealth())
  assert.equal(playback.health.has('beta|wy'), false, 'scoped clear must propagate even without result rows')
  assert.equal(playback.health.get('alpha|wy'), alpha)
  assert.equal(check.selfCheckProgress.sourceRemaining, 1)
})

test('invalid scopes fail before clearing ratings; concurrent preparation is guarded', async () => {
  const runtime = runtimeFixture()
  const before = runtime.exportHealth().sources
  for (const pluginIds of [[], ['missing'], ['alpha', null], 'alpha']) {
    await assert.rejects(runtime.selfCheck({ pluginIds, probes }), /id/)
    assert.deepEqual(runtime.exportHealth().sources, before)
  }
  const gate = deferred()
  const task = runtime.selfCheck({ probes: [{ source: 'wy', keyword: 'fixture' }], resolveId: () => gate.promise })
  assert.equal(runtime.selfCheckProgress.phase, 'prepare')
  await assert.rejects(runtime.selfCheck({ probes }), /正在进行/)
  gate.resolve({ id: '1' })
  await task
})

test('budget expiry leaves queued and unfinished sources unknown, with truthful counts', async () => {
  const runtime = runtimeFixture()
  runtime.setDisabled([])
  const called = []
  runtime.plugins.get('alpha').musicUrl = async (source) => {
    called.push(source)
    if (source === 'kg') return new Promise(() => {})
    return 'http://fixture.invalid/alpha.flac'
  }
  const started = Date.now()
  const report = await runtime.selfCheck({ probes, concurrency: 1, budgetMs: 60, callTimeoutMs: 500 })
  assert.ok(Date.now() - started < 800)
  assert.deepEqual(called, ['wy', 'kg'])
  assert.equal(report.checked, 1)
  assert.equal(report.remaining, 2)
  assert.equal(report.budgetExhausted, true)
  assert.deepEqual([runtime.selfCheckProgress.done, runtime.selfCheckProgress.total], [1, 3])
  assert.deepEqual([runtime.selfCheckProgress.sourceDone, runtime.selfCheckProgress.sourceRemaining], [0, 2])
  assert.equal(runtime.health.has('alpha|kg'), false)
  assert.equal(runtime.health.has('beta|wy'), false)
})

test('probe and verification hangs share the detection budget', async () => {
  for (const phase of ['prepare', 'verify']) {
    const runtime = runtimeFixture()
    if (phase === 'verify') runtime._verifyUrl = () => new Promise(() => {})
    const report = await runtime.selfCheck({
      probes: [{ source: 'wy', keyword: 'fixture' }], budgetMs: 30,
      ...(phase === 'prepare' ? { resolveId: () => new Promise(() => {}) } : {}),
    })
    assert.equal(report.checked, 0)
    assert.equal(report.budgetExhausted, true)
    assert.equal(runtime.selfCheckProgress.running, false)
  }
})

async function temporaryFixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lx-detection-'))
  t.after(async () => {
    // Only our newly created synthetic fixture directory is removable.
    assert.equal(path.dirname(await fs.realpath(dir)), await fs.realpath(os.tmpdir()))
    assert.match(path.basename(dir), /^lx-detection-/)
    await fs.rm(dir, { recursive: true, force: true })
  })
  return dir
}

const script = (name, url, keys = ['wy']) => `/*\n * @name ${name}\n * @version 1.0.0\n */
lx.on(lx.EVENT_NAMES.request, () => Promise.resolve(${JSON.stringify(url)}));
lx.send(lx.EVENT_NAMES.inited, { sources: ${JSON.stringify(Object.fromEntries(keys.map((key) =>
  [key, { name: key, type: 'music', actions: ['musicUrl'], qualitys: ['flac'] }])))} });`

test('same filename keeps identity while changed content invalidates health; reload drops absent plugins', async (t) => {
  const dir = await temporaryFixture(t)
  const runtime = new LxSourceRuntime({ guardRejections: false })
  await fs.writeFile(path.join(dir, 'alpha.js'), script('alpha', 'http://fixture.invalid/1'))
  await runtime.loadDirectory(dir)
  const [first] = runtime.listPlugins()
  runtime.health.set(`${first.id}|wy`, { ok: true, source: 'wy' })
  const cached = runtime.exportHealth()
  const livePlugin = runtime.plugins.get(first.id)
  await runtime.loadDirectory(dir)
  assert.equal(runtime.plugins.get(first.id), livePlugin, 'unchanged plugin initializer must not run again')
  assert.equal(runtime.health.size, 1, 'unchanged content retains health')
  await fs.writeFile(path.join(dir, 'alpha.js'), script('alpha', 'http://fixture.invalid/2'))
  await runtime.loadDirectory(dir)
  assert.equal(runtime.listPlugins()[0].id, first.id)
  assert.notEqual(runtime.listPlugins()[0].fingerprint, first.fingerprint)
  assert.equal(runtime.health.size, 0)
  assert.equal(runtime.importHealth(cached), false, 'stale content cannot restore a rating')
  const empty = path.join(dir, 'empty')
  await fs.mkdir(empty)
  await runtime.loadDirectory(empty)
  assert.equal(runtime.plugins.size, 0)
})

test('worker proxy exposes preparation and guards overlap before probe IDs resolve', async (t) => {
  const dir = await temporaryFixture(t)
  await fs.writeFile(path.join(dir, 'alpha.js'), script('alpha', 'http://fixture.invalid/audio'))
  const host = new LxSourceHost()
  t.after(() => host.terminate())
  await host.loadDirectory(dir)
  await assert.rejects(host.selfCheck({ pluginIds: ['missing'] }), /id/)
  const gate = deferred()
  const task = host.selfCheck({ budgetMs: 30, resolveId: () => gate.promise })
  const progress = await host.progress()
  assert.equal(progress.phase, 'prepare')
  assert.equal(progress.sourceTotal, 1)
  await assert.rejects(host.selfCheck(), /正在进行/)
  // Preparation consumes the entire budget; no external URL is ever requested.
  const report = await task
  gate.resolve(null)
  assert.equal(report.checked, 0)
  assert.equal(report.budgetExhausted, true)
})

async function until(read, matches) {
  for (let attempt = 0; attempt < 250; attempt++) {
    const value = await read()
    if (matches(value)) return value
    await delay(10)
  }
  assert.fail('timed out waiting for detection state')
}

test('HTTP startup/manual share one job; live scoped polling merges all rows and saves merged cache', async (t) => {
  const dir = await temporaryFixture(t)
  const pluginsDir = path.join(dir, 'plugins')
  await fs.mkdir(pluginsDir)
  let audioGate = deferred()
  const audio = http.createServer(async (_req, res) => {
    await audioGate.promise
    res.writeHead(200, { 'Content-Type': 'audio/flac' })
    res.end(Buffer.alloc(512))
  })
  await new Promise((resolve) => audio.listen(0, '127.0.0.1', resolve))
  t.after(() => { audioGate.resolve(); audio.close(); audio.closeAllConnections() })
  const audioBase = `http://127.0.0.1:${audio.address().port}`
  await fs.writeFile(path.join(pluginsDir, 'alpha.js'), script('alpha', `${audioBase}/alpha`, ['wy', 'kg']))
  await fs.writeFile(path.join(pluginsDir, 'beta.js'), script('beta', `${audioBase}/beta`))
  const alpha = idFor('alpha'), beta = idFor('beta')
  await fs.writeFile(path.join(dir, 'lx-config.json'), JSON.stringify({ disabled: [beta] }))
  await fs.writeFile(path.join(dir, 'backup-sources-config.json'), JSON.stringify({ enabled: false }))
  const originalLoad = LxSourceHost.prototype.loadDirectories
  let loadGate = null
  t.mock.method(LxSourceHost.prototype, 'loadDirectories', async function () {
    if (loadGate) await loadGate.promise
    return originalLoad.call(this, [pluginsDir])
  })
  const realFetch = globalThis.fetch
  t.mock.method(globalThis, 'fetch', (url, options) => {
    assert.equal(new URL(url).hostname, '127.0.0.1', 'test forbids remote requests')
    return realFetch(url, options)
  })
  const { server, lxHost } = await createMusicServer({
    dataDir: dir, autoScan: false, catalogs: {}, platformAuth: {},
    online: { search: async () => ({ tracks: [] }) },
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.close(); server.closeAllConnections() })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (route, body) => {
    const response = await fetch(`${base}/api/lx/${route}`, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }
  const startup = await until(() => call('progress'), ({ body }) => body.activeSources?.length > 0)
  assert.equal(startup.body.total, 2)
  assert.equal(startup.body.sourceTotal, 1)
  assert.deepEqual(startup.body.activeSources.map((p) => p.name), ['alpha'])
  assert.equal((await call('selfcheck', { id: beta })).status, 409)
  const liveStartup = (await call('status')).body
  assert.equal(liveStartup.plugins.length, 2)
  assert.equal(liveStartup.plugins.find((p) => p.id === alpha).testing, true)
  assert.equal((await lxHost.progress()).running, false, 'playback worker stays independent')
  audioGate.resolve()
  await until(() => call('progress'), ({ body }) => !body.running)
  const alphaHealth = (await call('status')).body.plugins.find((p) => p.id === alpha).health
  assert.equal(alphaHealth.ok, true)
  for (const id of ['', 123, null, {}]) assert.equal((await call('selfcheck', { id })).status, 400)
  assert.equal((await call('selfcheck', { id: 'missing' })).status, 404)

  loadGate = deferred()
  const prepareGate = loadGate
  audioGate = deferred()
  let settled = false
  const manual = call('selfcheck', { id: beta }).finally(() => { settled = true })
  t.after(() => { prepareGate.resolve(); audioGate.resolve() })
  await until(() => call('progress'), ({ body }) => body.running && body.phase === 'prepare')
  const preparing = (await call('status')).body
  assert.equal(preparing.plugins.length, 2)
  assert.deepEqual(preparing.plugins.find((p) => p.id === alpha).health, alphaHealth)
  assert.equal(preparing.plugins.find((p) => p.id === beta).health, null)
  assert.equal((await call('selfcheck', {})).status, 409)
  prepareGate.resolve()
  loadGate = null
  const active = await until(() => call('status'), ({ body }) => body.plugins.some((p) => p.id === beta && p.testing))
  assert.equal(settled, false)
  assert.equal(active.body.plugins.length, 2)
  assert.deepEqual(active.body.plugins.find((p) => p.id === alpha).health, alphaHealth)
  assert.equal(active.body.progress.sourceTotal, 1)
  assert.deepEqual(active.body.progress.activeSources.map((p) => p.name), ['beta'])
  assert.equal((await call('sources/toggle', { id: alpha, enabled: false })).status, 409)
  audioGate.resolve()
  assert.equal((await manual).status, 200)
  const final = (await call('status')).body
  assert.equal(final.plugins.find((p) => p.id === beta).enabled, false)
  assert.equal(final.plugins.find((p) => p.id === beta).health.ok, true)
  assert.deepEqual(final.plugins.find((p) => p.id === alpha).health, alphaHealth)
  assert.deepEqual([final.progress.sourceDone, final.progress.sourceRemaining], [1, 0])
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'lx-health.json'), 'utf8'))
  assert.equal(saved.sources[`${alpha}|wy`].ok, true)
  assert.equal(saved.sources[`${alpha}|kg`].ok, true)
  assert.equal(saved.sources[`${beta}|wy`].ok, true)
  assert.equal(saved.complete, true)
  assert.equal(saved.pluginIds, undefined, 'persist the whole merged playback snapshot')
})


test('removing one imported source preserves all 20 builtin files, live instances and ratings', async (t) => {
  const dir = await temporaryFixture(t)
  const builtin = path.join(dir, 'builtin'), user = path.join(dir, 'lx-sources-user')
  await fs.mkdir(builtin); await fs.mkdir(user)
  for (let i = 0; i < 20; i++) await fs.writeFile(path.join(builtin, `builtin${i}.js`), script(`builtin${i}`, 'http://fixture.invalid/audio', ['custom']))
  await fs.writeFile(path.join(user, 'imported.js'), script('imported', 'http://fixture.invalid/audio', ['custom']))
  const originalLoad = LxSourceHost.prototype.loadDirectories
  t.mock.method(LxSourceHost.prototype, 'loadDirectories', function () { return originalLoad.call(this, [builtin, user]) })
  await fs.writeFile(path.join(dir, 'backup-sources-config.json'), JSON.stringify({ enabled: false }))
  const { server } = await createMusicServer({ dataDir: dir, autoScan: false, catalogs: {}, platformAuth: {}, online: {} })
  server.removeAllListeners('listening')
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.close(); server.closeAllConnections() })
  const base = `http://127.0.0.1:${server.address().port}`
  const status = () => fetch(`${base}/api/lx/status`).then(r => r.json())
  const before = await until(status, value => value.counts.total === 21)
  const imported = before.plugins.find(row => !row.builtin)
  const builtinId = before.plugins.find(row => row.builtin).id
  const remove = id => fetch(`${base}/api/lx/sources/remove`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
  assert.equal((await remove(builtinId)).status, 403)
  const response = await remove(imported.id)
  assert.equal(response.status, 200)
  const after = await response.json()
  assert.equal(after.plugins.length, 20)
  assert.ok(after.plugins.every(row => row.builtin))
  assert.equal((await fs.readdir(builtin)).length, 20)
  assert.equal((await fs.readdir(user)).length, 0)
  assert.equal((await status()).progress.running, false)
  assert.equal((await status()).enabled, true)
})

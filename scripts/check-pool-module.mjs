import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { PoolModuleHost, validateModule, loadModule, moduleStatus, closeModule, importModule, removeModule, callModule } from './pool-module.mjs'

test('only x64 PE DLLs accepted; legacy key envelopes rejected', () => {
  assert.throws(() => validateModule(Buffer.from('RHK1\x01old-key')), /DLL/)
  const pe = Buffer.alloc(256)
  pe.write('MZ'); pe.writeUInt32LE(128, 0x3c); pe.writeUInt32LE(0x4550, 128)
  pe.writeUInt16LE(0x8664, 132); pe.writeUInt16LE(0x2000, 150)
  assert.doesNotThrow(() => validateModule(pe))
  pe.writeUInt16LE(0x14c, 132)
  assert.throws(() => validateModule(pe), /x64/)
  pe.writeUInt32LE(0xffffffff, 0x3c)
  assert.throws(() => validateModule(pe), /DLL/)
})

test('module host correlates replies, redacts failures, and rejects unsupported operations', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-module-contract-'))
  const fixture = path.join(dir, 'fixture.cjs')
  await fs.writeFile(fixture, `const r=require('readline').createInterface({input:process.stdin});r.on('line',s=>{const q=JSON.parse(s);console.log(JSON.stringify(q.method==='lines'?{id:q.id,ok:false,error:'PRIVATE_SERVER_TOKEN'}:{id:q.id,ok:true,result:{configured:true,moduleVersion:1,expiresAt:null}}))})`)
  const host = new PoolModuleHost(fixture, { executable: process.execPath, timeoutMs: 2000 })
  try {
    let starts = 0
    const startProcess = host.startProcess.bind(host)
    host.startProcess = () => { starts++; return startProcess() }
    const [result] = await Promise.all([host.call('status'), host.call('status')])
    assert.equal(starts, 1, 'concurrent first requests share one host process')
    assert.equal(result.moduleVersion, 1)
    await assert.rejects(host.call('lines'), error => !error.message.includes('PRIVATE_SERVER_TOKEN'))
    await assert.rejects(host.call('decrypt'), /不支持/)
  } finally { host.close() }
})

test('native DLL import, failed replacement, restart, removal and isolation', { skip: process.platform !== 'win32' }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-module-native-'))
  const bytes = await fs.readFile(new URL('../native/rhine-pool-host/target/release/rhine_pool_mock.dll', import.meta.url))
  const oldMode = process.env.RHINE_POOL_MOCK_MODE
  try {
    delete process.env.RHINE_POOL_MOCK_MODE
    assert.equal((await importModule(dir, bytes)).configured, true)
    await assert.rejects(importModule(dir, Buffer.from('RHK1old')))
    assert.equal(moduleStatus().configured, true)
    process.env.RHINE_POOL_MOCK_MODE = 'bad-version'
    await assert.rejects(importModule(dir, bytes))
    assert.equal(moduleStatus().configured, true)
    delete process.env.RHINE_POOL_MOCK_MODE
    closeModule()
    assert.equal(await loadModule(dir), true)
    assert.equal((await callModule('status')).configured, true)
    await removeModule(dir)
    assert.equal(moduleStatus().configured, false)
    assert.equal(await loadModule(dir), false)
    for (const mode of ['crash', 'bad-json', 'oversize', 'raw-error']) {
      process.env.RHINE_POOL_MOCK_MODE = mode
      const host = new PoolModuleHost(path.resolve('native/rhine-pool-host/target/release/rhine_pool_mock.dll'), { timeoutMs: 2000 })
      try { await assert.rejects(host.call('status'), error => !error.message.includes('DO_NOT_OUTPUT')) }
      finally { host.close() }
    }
  } finally {
    closeModule()
    if (oldMode === undefined) delete process.env.RHINE_POOL_MOCK_MODE
    else process.env.RHINE_POOL_MOCK_MODE = oldMode
  }
})

test('missing module degrades without decoding legacy credential files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-module-empty-'))
  await fs.writeFile(path.join(dir, 'pool-credential.dat'), 'legacy-placeholder')
  assert.equal(await loadModule(dir), false)
  assert.equal(moduleStatus().configured, false)
  assert.equal(await fs.readFile(path.join(dir, 'pool-credential.dat'), 'utf8'), 'legacy-placeholder')
  closeModule()
})

test('crashed module host rejects pending work instead of hanging playback', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-module-crash-'))
  const fixture = path.join(dir, 'crash.cjs')
  await fs.writeFile(fixture, `process.stdin.once('data',()=>process.exit(2))`)
  const host = new PoolModuleHost(fixture, { executable: process.execPath, timeoutMs: 2000 })
  try { await assert.rejects(host.call('status'), /模块不可用/) } finally { host.close() }
})

test('HTTP imports DLLs larger than legacy limit; export is unavailable and bad replacement preserves state', { skip: process.platform !== 'win32' }, async () => {
  const { createMusicServer } = await import('./music-server.mjs')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-module-http-'))
  await fs.writeFile(path.join(dir, 'lx-config.json'), JSON.stringify({ enabled: false }))
  await fs.writeFile(path.join(dir, 'backup-sources-config.json'), JSON.stringify({ enabled: false }))
  const { server } = await createMusicServer({ dataDir: dir, defaultRoots: [], autoScan: false })
  // This fixture tests only module routes; do not start unrelated network warm-up.
  server.removeAllListeners('listening')
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const upload = bytes => fetch(`${base}/api/pool/credential/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: bytes.toString('base64'), name: 'fixture.dll' }) })
  try {
    const bytes = await fs.readFile(new URL('../native/rhine-pool-host/target/release/rhine_pool_mock.dll', import.meta.url))
    assert.ok(bytes.length > 128 * 1024)
    assert.equal((await upload(bytes)).status, 200)
    assert.equal((await upload(Buffer.from('RHK1legacy'))).status, 400)
    assert.equal((await fetch(`${base}/api/pool/credential`).then(r => r.json())).poolEnabled, true)
    assert.equal((await fetch(`${base}/api/pool/credential/export`)).status, 404)
    assert.equal((await fetch(`${base}/api/pool/credential`, { method: 'DELETE' }).then(r => r.json())).poolEnabled, false)
  } finally {
    closeModule()
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
  }
})

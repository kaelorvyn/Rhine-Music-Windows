import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const manifest = fileURLToPath(new URL('../native/rhine-pool-host/Cargo.toml', import.meta.url))
const result = spawnSync('cargo', ['build', '--release', '--locked', '--workspace', '--manifest-path', manifest], { stdio: 'inherit', windowsHide: true })
if (result.error || result.status !== 0) throw new Error('Could not build the generic pool module caller; check the configured Rust toolchain')

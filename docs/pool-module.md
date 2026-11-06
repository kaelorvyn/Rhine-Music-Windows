# Shared audio module ABI v1

The public application contains a generic Windows x64 caller, not credentials or a credential decoder. A private module is imported separately. Importing a DLL executes native code: import only a module from a trusted issuer. The module is portable between computers and is itself a credential-bearing artifact.

Build the caller and credential-free test DLL with `cargo +1.91.1 build --release --workspace --manifest-path native/rhine-pool-host/Cargo.toml`. Desktop packaging copies only `rhine-pool-host.exe` into `runtime/native/`. The mock DLL, private modules, private source, legacy key files and conversion tools must never be included in public packages.

The caller receives an absolute DLL path, restricts DLL dependency lookup to its directory and Windows System32, and exchanges bounded JSON lines over stdin/stdout. Request: `{ "id": 1, "method": "status", "args": {} }`. Reply: `{ "id": 1, "ok": true, "result": { "configured": true, "moduleVersion": 1, "expiresAt": null } }`. Failures contain fixed public error codes; raw module errors are not forwarded. Input is limited to 1 MiB and output to 2 MiB. The application kills an unresponsive caller and falls back to other sources.

Required C exports (all lengths are `size_t`, calling convention C):

```c
uint32_t rhine_pool_version(void); /* returns 1 */
int32_t rhine_pool_call(const uint8_t *input, size_t input_len,
                       uint8_t **output, size_t *output_len);
void rhine_pool_free(uint8_t *output, size_t output_len);
```

The call receives `{ "method": "status", "args": {} }` and returns UTF-8 JSON `{ "ok": true, "result": ... }` or `{ "ok": false, "error": { "code": ... } }`. The module allocates the reply; the caller releases it with `rhine_pool_free`. Only `status`, `lines`, `probeLines`, `probeUpstreams`, `resolve`, `invalidate` and `shutdown` are accepted. There is no key export, generic signing, arbitrary request or decryption operation.

`status` returns configured/moduleVersion/expiresAt. Line operations return generic IDs, generic labels, health and latency without hosts. Upstream results contain platform, availability and latency. `resolve` accepts a supported platform, song ID, quality and optional song metadata; it returns only the playback URL and required format/quality information. Normal no-audio results do not unload the module. Private server endpoints, bearer credentials, signing keys and decrypted configuration must stay inside the DLL.

Imported DLLs are stored under the application's data directory in `pool-modules/`. `pool-module.json` points to the active file. A replacement is validated in an isolated caller before this pointer changes; failure preserves the active module. Removing a module clears the pointer and stops its process; module files are retained. Legacy `.rhinekey`, JSON and `.dat` files are neither decoded nor automatically imported by 0.1.9.

Verification: `node --test scripts/check-pool-module.mjs`. Native tests use the credential-free mock. Private DLLs require separate issuer testing and protection. Packing is not a guarantee against extraction. A development DLL without the required protection is not a distributable credential module.

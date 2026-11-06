import { fileURLToPath } from 'node:url';
import { createBdms } from './vendor/qishui-purejs/bdms.mjs';

const DEFAULT_DEVICE_ID = '199447014549364';
const signers = new Map();

export function signerDir() {
  return fileURLToPath(new URL('./vendor/qishui-purejs/', import.meta.url));
}
export function signerReady() {
  return true;
}
export function signHeaders(url, headers, deviceId = DEFAULT_DEVICE_ID) {
  let signer = signers.get(deviceId);
  if (!signer) {
    signer = createBdms(); signer.init({ deviceId }); signers.set(deviceId, signer);
  }
  const lines = Object.entries(headers).flatMap(([name, value]) => [name, String(value)]).join('\r\n');
  const parts = signer.generateHttpSignatureHeaders(url, lines).split('\r\n');
  return { ...headers, 'X-Helios': parts[1], 'X-Medusa': parts[3] };
}

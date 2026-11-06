import { sm3 } from './vendor/qishui-purejs/sm3.mjs';

export const PASSPORT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) SodaMusic/3.7.0 Chrome/136.0.7103.59 Electron/36.4.0-rs.29.release.main.0 TTElectron/36.4.0-rs.29.release.main.0 Safari/537.36';
const STANDARD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const HASH_ALPHABET = 'ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe';
const SIGN_ALPHABET = 'Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe';
const encoded = value => Buffer.from(value, 'utf8');
function rc4(key, input) {
  const state = Uint8Array.from({ length: 256 }, (_value, index) => index);
  let swap = 0;
  for (let index = 0; index < 256; index++) {
    swap = (swap + state[index] + key[index % key.length]) & 255;
    [state[index], state[swap]] = [state[swap], state[index]];
  }
  let cursor = 0; swap = 0;
  return Uint8Array.from(input, value => {
    cursor = (cursor + 1) & 255; swap = (swap + state[cursor]) & 255;
    [state[cursor], state[swap]] = [state[swap], state[cursor]];
    return value ^ state[(state[cursor] + state[swap]) & 255];
  });
}
const base64 = (bytes, alphabet) => Buffer.from(bytes).toString('base64').replace(/[A-Za-z0-9+/]/g, character => alphabet[STANDARD.indexOf(character)]);
const agentHash = sm3(encoded(base64(rc4([0, 1, 0], encoded(PASSPORT_UA)), HASH_ALPHABET)));
export function passportSignature(query, body, milliseconds = Date.now()) {
  if (typeof query !== 'string' || typeof body !== 'string' || query.length > 65536 || body.length > 65536 || !Number.isSafeInteger(milliseconds) || milliseconds < 1) throw new TypeError('无效的登录签名输入');
  const queryHash = sm3(sm3(encoded(query + 'bds')));
  const bodyHash = sm3(sm3(encoded(body + 'bds')));
  const time = milliseconds >>> 0, previous = (milliseconds - 1) >>> 0;
  const packet = Uint8Array.from([65, time >>> 24, 0, 0, 0, queryHash[21], bodyHash[21], agentHash[23], time >>> 16, 0, 1, 0,
    queryHash[22], bodyHash[22], agentHash[24], time >>> 8, 0, 0, 0, time, 0, 0, 0, previous >>> 24, previous >>> 16, previous >>> 8, previous, 3, 0]);
  packet[28] = packet.slice(0, 28).reduce((checksum, value) => checksum ^ value, 0);
  const prefix = [(time & 170) | 1, (time & 85) | 2, ((time >>> 8) & 170) | 64, ((time >>> 8) & 85) | 2];
  return base64([...prefix, ...rc4([131], packet)], SIGN_ALPHABET);
}

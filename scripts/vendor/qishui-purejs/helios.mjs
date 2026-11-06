import {aes128CbcPkcs7, base64, concat, hex, md5, u32le, utf8} from './crypto.mjs';

/** Captured Luna PC profile. clientKey is separate from init({deviceId}). */
export const LUNA_PC_PROFILE = Object.freeze({aid:'386088', clientKey:'2004214840'});

export function generateHelios({timestamp, random, aid=LUNA_PC_PROFILE.aid, clientKey=LUNA_PC_PROFILE.clientKey}) {
  if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffff)
    throw new TypeError('timestamp must be a uint32 Unix timestamp in seconds');
  if (!Number.isInteger(random) || random < 0 || random > 0xffffffff)
    throw new TypeError('random must be a uint32');
  if (!/^\d+$/.test(String(aid)) || !/^\d+$/.test(String(clientKey)))
    throw new TypeError('aid and clientKey must be decimal identifiers');
  const prefix = u32le(random);
  // The native implementation uses ASCII lowercase MD5 hex halves as key/IV.
  const digestHex = hex(md5(concat(prefix, utf8(aid))));
  const key = utf8(digestHex.slice(0,16));
  const iv = utf8(digestHex.slice(16));
  const input = utf8(`${timestamp}-${clientKey}-${aid}`);
  return base64(concat(prefix, aes128CbcPkcs7(input, key, iv)));
}

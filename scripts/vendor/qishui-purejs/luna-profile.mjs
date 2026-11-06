import {utf8,unhex} from './crypto.mjs';
import {encodeProtobuf} from './protobuf.mjs';
import {buildEnvironmentJson} from './runtime-fingerprint.mjs';

const bytes=(number,value)=>({number,wire:2,value:typeof value==='string'?utf8(value):value});
const integer=(number,value)=>({number,wire:0,value:BigInt(value)});
const signed=(number,value)=>integer(number,BigInt(value)>=0n?BigInt(value)*2n:-BigInt(value)*2n-1n);
const compact=fields=>fields.filter(f=>f.wire!==0||f.value!==0n).sort((a,b)=>a.number-b.number);
const missing='!notset!';
const fallback=694367;

/** Build the default Luna Windows profile from values, without a native message. */
export function buildLunaProfile({deviceId,processId,currentEpochMs,loadedAtMs,elapsedSeconds=0,metric17=0,uniquePathCount=0,uuid}={}) {
  if(typeof deviceId!=='string')throw new TypeError('deviceId must be a string');
  for(const [name,value] of Object.entries({processId,currentEpochMs,loadedAtMs,elapsedSeconds,metric17,uniquePathCount})){
    if(!Number.isSafeInteger(value)||value<0)throw new RangeError(`Invalid ${name}`);
  }
  const validDevice=deviceId.length>0&&!/[^0-9]/.test(deviceId);
  const device=[integer(1,2),bytes(3,'386088')];
  if(validDevice)device.push(bytes(4,deviceId));
  for(const number of [5,6,11,12,13,15,22,30,31,32,33,34,35,36,37])device.push(bytes(number,missing));
  for(const number of [7,8,9,10,14,23,24,25,27,29,38])device.push(signed(number,-999999));
  for(const number of [16,17,18,19,20,21])device.push({number,wire:5,value:unhex('f02374c9')});
  device.push(signed(28,currentEpochMs),signed(40,loadedAtMs));
  const runtime=[signed(1,elapsedSeconds),signed(2,fallback),signed(3,fallback),signed(5,fallback),signed(7,processId),
    bytes(12,encodeProtobuf(compact(device))),bytes(13,new Uint8Array()),bytes(14,missing),signed(16,uniquePathCount),signed(17,metric17)];
  const fields=[bytes(1,unhex('f7e85ffad7d7dc3bd62ac87057cf6118')),integer(2,6),bytes(4,'386088'),
    bytes(6,'2004214840'),bytes(8,'v04.06.01-ml-windows'),integer(9,135004678),bytes(10,new Uint8Array(8)),integer(11,3),
    bytes(15,encodeProtobuf([signed(1,1),signed(2,fallback),signed(3,fallback),signed(5,fallback)])),
    bytes(16,'AhiXqLv1dB65l9jtbo2QLI5oP'),bytes(20,'none'),integer(21,738),
    bytes(23,encodeProtobuf(compact(runtime))),bytes(24,buildEnvironmentJson(uuid))];
  if(validDevice)fields.push(bytes(5,deviceId));
  return compact(fields);
}

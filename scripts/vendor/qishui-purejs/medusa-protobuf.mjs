import { decodeProtobuf, encodeProtobuf } from './protobuf.mjs';
import { buildMedusaDigestInput, medusaDigestFromInput } from './medusa-digest.mjs';

// Low-level serializer. The connected SDK builds its runtime profile in
// luna-profile.mjs before filling the request-dependent fields here.
export function buildMedusaMessage(profileFields, {query, stub, timestamp, signRandom, environmentFlag, sequence, deviceId} = {}) {
  if (!Array.isArray(profileFields)) throw new TypeError('profileFields must be an array');
  if(deviceId!==undefined){
    if(typeof deviceId!=='string')throw new TypeError('deviceId must be a string');
    const value=deviceId.length>0&&!/[^0-9]/.test(deviceId)?Buffer.from(deviceId,'utf8'):null;
    function setBytes(fields,number,bytes){
      const found=fields.filter(f=>f.number===number);
      if(found.length>1||(found.length&&found[0].wire!==2))throw new TypeError('invalid device field');
      const out=fields.filter(f=>f.number!==number);
      if(bytes){let i=out.findIndex(f=>f.number>number);if(i<0)i=out.length;out.splice(i,0,{number,wire:2,value:bytes});}
      return out;
    }
    const outer=profileFields.find(f=>f.number===23);
    if(!outer||outer.wire!==2)throw new TypeError('missing device profile');
    const nested=decodeProtobuf(outer.value);
    const child=nested.find(f=>f.number===12);
    if(!child||child.wire!==2)throw new TypeError('missing nested device profile');
    const deviceProfile=encodeProtobuf(setBytes(decodeProtobuf(child.value),4,value));
    const nextOuter=encodeProtobuf(nested.map(f=>f.number===12?{...f,value:deviceProfile}:f));
    profileFields=setBytes(profileFields,5,value).map(f=>f.number===23?{...f,value:nextOuter}:f);
  }
  if (!Number.isInteger(signRandom) || signRandom < 0 || signRandom > 0x7fffffff) throw new RangeError('invalid signRandom');
  const input = buildMedusaDigestInput(query, stub, timestamp);
  const replacements = new Map([
    [3, {wire:0,value:BigInt(signRandom)*2n}],
    [12, {wire:0,value:BigInt(timestamp)*2n}],
    [13, {wire:2,value:medusaDigestFromInput(input, timestamp, environmentFlag)}],
    [14, {wire:2,value:input.subarray(0,6)}],
    [17, {wire:0,value:BigInt(timestamp)*2n}],
  ]);
  if(sequence!==undefined){
    if(!Number.isSafeInteger(sequence)||sequence<1)throw new RangeError('invalid request sequence');
    const item=profileFields.find(f=>f.number===15);
    if(!item||item.wire!==2)throw new TypeError('missing sequence profile');
    const inner=decodeProtobuf(item.value);
    const counter=inner.filter(f=>f.number===1);
    if(counter.length!==1||counter[0].wire!==0)throw new TypeError('invalid sequence field');
    const value=encodeProtobuf(inner.map(f=>f.number===1?{...f,value:BigInt(sequence)*2n}:f));
    replacements.set(15,{wire:2,value});
  }
  const fields=profileFields.slice();
  for(const [number,replacement] of replacements){
    const matches=fields.filter(f=>f.number===number);
    if(matches.length>1||(matches.length&&matches[0].wire!==replacement.wire))throw new TypeError('invalid duplicate or wire type for dynamic field');
    let index=fields.findIndex(f=>f.number===number);
    if(index>=0)fields.splice(index,1);
    else {index=fields.findIndex(f=>f.number>number);if(index<0)index=fields.length;}
    if(!(replacement.wire===0&&replacement.value===0n))fields.splice(index,0,{number,...replacement});
  }
  return encodeProtobuf(fields);
}

/** Read the wire types observed in native Medusa messages without a dependency. */
export function decodeProtobuf(input) {
  if(!(input instanceof Uint8Array))throw new TypeError('Protobuf input must be bytes');
  let offset=0;
  function varint() {
    let value=0n;
    for(let shift=0n;shift<70n;shift+=7n){
      if(offset>=input.length)throw new RangeError('Truncated Protobuf varint');
      const byte=input[offset++];
      if(shift===63n && byte>1)throw new RangeError('Protobuf varint exceeds uint64');
      value|=BigInt(byte&127)<<shift;
      if(!(byte&128))return value;
    }
    throw new RangeError('Invalid Protobuf varint');
  }
  const fields=[];
  while(offset<input.length){
    const tag=varint(),number=Number(tag>>3n),wire=Number(tag&7n);
    if(number<1||number>0x1fffffff)throw new RangeError('Invalid Protobuf field number');
    let value;
    if(wire===0)value=varint();
    else {
      const size=wire===2?Number(varint()):wire===1?8:wire===5?4:-1;
      if(size<0)throw new RangeError('Unsupported Protobuf wire type');
      if(!Number.isSafeInteger(size)||size>input.length-offset)throw new RangeError('Truncated Protobuf field');
      value=input.subarray(offset,offset+size);offset+=size;
    }
    fields.push({number,wire,value});
  }
  return fields;
}

/** Encode the same wire types used by decodeProtobuf, preserving field order. */
export function encodeProtobuf(fields) {
  const output=[];
  function varint(value) {
    let n=BigInt(value);
    if(n<0n||n>0xffffffffffffffffn)throw new RangeError('Protobuf value outside uint64');
    while(n>=128n){output.push(Number(n&127n)|128);n>>=7n;}
    output.push(Number(n));
  }
  for(const {number,wire,value} of fields){
    if(!Number.isInteger(number)||number<1||number>0x1fffffff)throw new RangeError('Invalid Protobuf field number');
    if(![0,1,2,5].includes(wire))throw new RangeError('Unsupported Protobuf wire type');
    varint((BigInt(number)<<3n)|BigInt(wire));
    if(wire===0)varint(value);
    else {
      if(!(value instanceof Uint8Array))throw new TypeError('Protobuf field must be bytes');
      if(wire===2)varint(value.length);
      else if(value.length!==(wire===1?8:4))throw new RangeError('Invalid fixed-width field');
      for(const byte of value)output.push(byte);
    }
  }
  return Uint8Array.from(output);
}

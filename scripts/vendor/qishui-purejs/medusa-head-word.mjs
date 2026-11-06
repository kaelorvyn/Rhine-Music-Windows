/** Luna PC head-word primitive. One DES round in the native bit layout.
 * This does not implement the separate nonce-word replacement in the 96-byte head.
 * The folded first-round subkey for this captured profile is 0x403eec2706e0.
 */
const SBOX_HEX = '0e040d01020f0b08030a060c05090007000f07040e020d010a060c0b0905030804010e080d06020b0f0c0907030a05000f0c080204090107050b030e0a00060d0f01080e060b03040907020d0c00050a030d04070f02080e0c00010a06090b05000e070b0a040d0105080c060903020f0d080a01030f04020b06070c00050e090a00090e06030f05010d0c070b0402080d0700090304060a0208050e0c0b0f010d060409080f03000b01020c050a0e07010a0d0006090807040f0e030b05020c070d0e030006090a010208050b0c040f0d080b05060f00030407020c010a0e090a0609000c0b070d0f01030e05020804030f00060a010d080904050b0c07020e020c0401070a0b060805030f0d000e090e0b020c04070d0105000f0a030908060402010b0a0d07080f090c050603000e0b080c07010e020d060f00090a0405030c010a0f09020608000d03040e07050b0a0f0402070c090506010d0e000b0308090e0f0502080c030700040a010d0b060403020c09050f0a0b0e01070600080d040b020e0f00080d030c0907050a06010d000b070409010a0e03050c020f080601040b0d0c03070e0a0f060800050902060b0d0801040a070905000f0e02030c0d020804060f0b010a09030e05000c07010f0d080a0307040c05060b000e0902070b0401090c0e0200060a0d0f03050802010e07040a080d0f0c09000305060b';
const SBOX=Uint8Array.from(SBOX_HEX.match(/../g),x=>parseInt(x,16));
const GROUPS=[{"sbox":6,"key":27,"inputBits":[26,34,42,50,58,0],"outputBits":[4,15,22,37],"outputPermutation":[3,0,1,2]},{"sbox":2,"key":59,"inputBits":[25,33,41,49,57,3],"outputBits":[5,6,20,23],"outputPermutation":[2,3,1,0]},{"sbox":4,"key":9,"inputBits":[24,32,40,48,56,1],"outputBits":[7,21,47,60],"outputPermutation":[3,2,0,1]},{"sbox":0,"key":16,"inputBits":[27,35,43,51,59,2],"outputBits":[12,14,61,62],"outputPermutation":[0,1,3,2]},{"sbox":7,"key":32,"inputBits":[59,2,10,18,26,34],"outputBits":[13,30,31,44],"outputPermutation":[1,0,3,2]},{"sbox":5,"key":48,"inputBits":[58,0,8,16,24,32],"outputBits":[28,39,45,46],"outputPermutation":[2,3,1,0]},{"sbox":1,"key":3,"inputBits":[57,3,11,19,27,35],"outputBits":[29,36,54,55],"outputPermutation":[3,2,0,1]},{"sbox":3,"key":44,"inputBits":[56,1,9,17,25,33],"outputBits":[38,52,53,63],"outputPermutation":[2,3,1,0]}];
export function medusaHeadWord(input) {
  if(!(input instanceof Uint8Array) || input.length!==8)
    throw new TypeError('The Medusa head primitive requires exactly eight bytes');
  const out=Uint8Array.from(input);
  for(const group of GROUPS) {
    let q=group.key;
    group.inputBits.forEach((bit,i)=>q^=((input[bit>>>3]>>>(bit&7))&1)<<i);
    const row=((q>>>4)&2)|(q&1),column=(q>>>1)&15;
    const value=SBOX[group.sbox*64+row*16+column];
    group.outputBits.forEach((bit,i)=>{
      out[bit>>>3]^=((value>>>group.outputPermutation[i])&1)<<(bit&7);
    });
  }
  return out;
}

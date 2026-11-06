/** The two verified native bit planes. Cipher generation is a separate stage. */
const LANES = [2, 6, 1, 5, 3, 0, 4, 7];
const BITS = [1, 3, 2, 4, 5, 7, 6, 0];

function check(input, count) {
  if (!(input instanceof Uint8Array)) throw new TypeError('Expected a Uint8Array payload');
  const words = Math.floor(input.length / 8);
  // ponytail: only two native planes have been verified; reject larger streams.
  if (!Number.isInteger(count) || count < 0 || count > 2 * words)
    throw new RangeError('The stream must fit within the two verified bit planes');
  return words;
}

export function gatherMedusaBits(input, count) {
  const words = check(input, count);
  return Uint8Array.from({length:count}, (_, i) => {
    let value = 0;
    for (let bit = 0; bit < 8; bit++) {
      const offset = 8 * (i % words) + LANES[bit];
      value |= ((input[offset] >>> ((BITS[bit] + Math.floor(i / words)) & 7)) & 1) << bit;
    }
    return value;
  });
}

export function scatterMedusaBits(input, stream) {
  if (!(stream instanceof Uint8Array)) throw new TypeError('Expected a Uint8Array stream');
  const words = check(input, stream.length), out = Uint8Array.from(input);
  for (let i = 0; i < stream.length; i++) {
    for (let bit = 0; bit < 8; bit++) {
      const offset = 8 * (i % words) + LANES[bit];
      const shift = (BITS[bit] + Math.floor(i / words)) & 7;
      out[offset] = (out[offset] & ~(1 << shift)) | (((stream[i] >>> bit) & 1) << shift);
    }
  }
  return out;
}

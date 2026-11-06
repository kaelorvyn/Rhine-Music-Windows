/** Native timing samples requests 0, 4, 7 and 9 in each group of ten. */
export function samplesRequestDuration(requestIndex) {
  if(!Number.isSafeInteger(requestIndex)||requestIndex<0)throw new RangeError('Invalid request index');
  return Boolean((0x291>>>(requestIndex%10))&1);
}

/** The stored duration loses its low nibble and repeats the adjacent nibble. */
export function encodeDurationMetric(duration) {
  const value=BigInt(duration);
  if(value<0n||value>0x7fffffffffffffffn)throw new RangeError('Duration outside positive int64');
  return (value&~15n)|((value>>4n)&15n);
}

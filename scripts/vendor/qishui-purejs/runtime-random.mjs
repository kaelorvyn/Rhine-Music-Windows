/** State transition recovered from the reference DLL's thread-local rand. */
export class NativeRandom {
  #state;
  constructor(seed) { this.seed(seed); }
  seed(value) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
      throw new RangeError('random seed must be uint32');
    this.#state = value;
  }
  get state() { return this.#state; }
  next() {
    this.#state = (Math.imul(this.#state, 214013) + 2531011) >>> 0;
    return (this.#state >>> 16) & 32767;
  }
}

/** Observed Luna initialization and one-thread signature draw schedule. */
export class LunaRandomState {
  #generator;
  constructor(initializationEpochSeconds) {
    this.#generator=new NativeRandom(initializationEpochSeconds);
    for(let i=0;i<5;i++)this.#generator.next();
  }
  get state(){return this.#generator.state;}
  nextSignature(){
    const signRandom=this.#generator.next();
    const random=this.#generator.next();
    const outerRandom=this.#generator.next();
    const heliosRandom=this.#generator.next();
    this.#generator.next();
    return {signRandom,random,outerRandom,heliosRandom};
  }
}

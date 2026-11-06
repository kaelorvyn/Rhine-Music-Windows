import {utf8} from './crypto.mjs';

const polynomial=0x95ac9329ac4bc9b5n;
export function pathHash(bytes) {
  if(!(bytes instanceof Uint8Array))throw new TypeError('Path hash requires bytes');
  let value=0n;
  for(const byte of bytes){
    value^=BigInt(byte);
    for(let i=0;i<8;i++)value=(value>>1n)^((value&1n)?polynomial:0n);
  }
  return value;
}

export function samplesRequestPath(index) {
  if(!Number.isSafeInteger(index)||index<0)throw new RangeError('Invalid request index');
  return [0,1,3,6,8].includes(index%10);
}

/** Native background collector: the previous window's distinct URL prefixes. */
export class LunaPathStats {
  #keys=new Set();
  #lastUpdate=0;
  #value=0;
  get value(){return this.#value;}
  record(url,clock){
    if(typeof url!=='string')throw new TypeError('URL must be a string');
    const indices=['?','#','='].map(c=>url.indexOf(c)).filter(i=>i>=0);
    const length=indices.length?Math.min(...indices):0;
    if(length<=0)return;
    const now=typeof clock==='function'?clock():clock;
    if(!Number.isSafeInteger(now)||now<0)throw new RangeError('Invalid collector time');
    if(BigInt.asUintN(64,BigInt(now)-BigInt(this.#lastUpdate))>=60000n){
      this.#lastUpdate=now;
      this.#value=this.#keys.size;
      this.#keys.clear();
      return;
    }
    if(this.#keys.size<1000)this.#keys.add(pathHash(utf8(url.slice(0,length))));
  }
}

/** The native executor polls every 500 ms and runs each pending batch in reverse order. */
export function createBackgroundExecutor() {
  const pending=[];
  let timer;
  return {
    schedule(task){
      pending.push(task);
      if(!timer){
        timer=setInterval(()=>{const batch=pending.splice(0);while(batch.length)batch.pop()();},500);
        timer.unref?.();
      }
    },
    dispose(){if(timer)clearInterval(timer);timer=undefined;pending.length=0;},
  };
}

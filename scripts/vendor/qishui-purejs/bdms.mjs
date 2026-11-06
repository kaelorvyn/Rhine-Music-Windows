import {unhex} from './crypto.mjs';
import {LunaRandomState} from './runtime-random.mjs';
import {LunaIntegerState} from './runtime-integers.mjs';
import {uuidFromEntropy} from './runtime-fingerprint.mjs';
import {samplesRequestDuration,encodeDurationMetric} from './runtime-timing.mjs';
import {buildLunaProfile} from './luna-profile.mjs';
import {buildMedusaMessage} from './medusa-protobuf.mjs';
import {generateMedusaFromMessage} from './medusa-envelope.mjs';
import {generateHelios} from './helios.mjs';
import {LunaPathStats,samplesRequestPath,createBackgroundExecutor} from './runtime-path-stats.mjs';

const defaultEntropy=()=>{
  if(!globalThis.crypto?.getRandomValues)throw new Error('Web Crypto or an entropy provider is required');
  return globalThis.crypto.getRandomValues(new Uint8Array(16));
};

/** Default Luna Windows signer. Clock and entropy are injectable for reproducible tests. */
export function createBdms({clock=Date.now,entropy=defaultEntropy,processId=globalThis.process?.pid??0,serverTimeOffsetMs=0,executor}={}) {
  if(typeof clock!=='function'||typeof entropy!=='function')throw new TypeError('Expected clock and entropy functions');
  if(!Number.isSafeInteger(serverTimeOffsetMs))throw new RangeError('Invalid clock offset');
  const now=phase=>{
    const value=clock(phase);
    if(!Number.isSafeInteger(value)||value<0)throw new RangeError('Clock must return epoch milliseconds');
    return value;
  };
  const loadedAtMs=now('load');
  const runtime=new LunaIntegerState(Math.floor(loadedAtMs/1000)>>>0);
  const pathStats=new LunaPathStats();
  const jobs=executor??createBackgroundExecutor();
  if(typeof jobs.schedule!=='function')throw new TypeError('Expected a background executor');
  let random,deviceId,uuid,requestIndex=0,previousDurationMs=0;
  return {
    init(options){
      if(!options||typeof options.deviceId!=='string')throw new TypeError('init requires a string deviceId');
      if(random)return;
      deviceId=options.deviceId;
      random=new LunaRandomState(Math.floor(now('init')/1000)>>>0);
    },
    generateHttpSignatureHeaders(url,headerLines){
      if(!random)throw new Error('Call bdms.init before signing');
      if(typeof url!=='string'||typeof headerLines!=='string')throw new TypeError('URL and header lines must be strings');
      const parts=headerLines.split('\r\n');
      if(parts.at(-1)==='')parts.pop();
      if(parts.length%2)throw new TypeError('Header lines must alternate name and value');
      let stub=new Uint8Array(16);
      const headers=new Map();
      for(let i=0;i<parts.length;i+=2)headers.set(parts[i],parts[i+1]);
      for(const [name,value] of headers)if(name.toLowerCase()==='x-ss-stub'){
        if(!/^[0-9a-f]{32}$/i.test(value))throw new TypeError('X-SS-STUB must contain 32 hexadecimal characters');
        stub=unhex(value);
        break;
      }
      const question=url.indexOf('?'),fragment=url.indexOf('#');
      const query=question>=0&&(fragment<0||fragment>question)?url.slice(question+1,fragment<0?undefined:fragment):'';
      if(new URLSearchParams(query).get('aid')!=='386088')throw new RangeError('This signer requires the Luna PC aid=386088 context');
      if(samplesRequestPath(requestIndex))jobs.schedule(()=>pathStats.record(url,()=>now('pathStats')));
      const measured=samplesRequestDuration(requestIndex);
      const startedAt=measured?now('requestStart'):0;
      const timestamp=Math.floor((now('timestamp')-serverTimeOffsetMs)/1000)>>>0;
      const currentEpochMs=now('profile');
      const draws=random.nextSignature();
      const sequence=runtime.beginRequest();
      uuid??=uuidFromEntropy(entropy());
      const profile=buildLunaProfile({deviceId,processId,currentEpochMs,loadedAtMs,
        elapsedSeconds:Math.floor(currentEpochMs/1000)-Math.floor(loadedAtMs/1000),
        metric17:Number(encodeDurationMetric(previousDurationMs)),uniquePathCount:pathStats.value,uuid});
      const message=buildMedusaMessage(profile,{query,stub,timestamp,signRandom:draws.signRandom,environmentFlag:runtime.environmentFlag,sequence});
      const medusa=generateMedusaFromMessage(message,{timestamp,...draws});
      const helios=generateHelios({timestamp,random:draws.heliosRandom,aid:'386088',clientKey:'2004214840'});
      runtime.finishRequest();
      if(measured)previousDurationMs=Math.max(0,now('requestEnd')-startedAt);
      requestIndex++;
      return `X-Helios\r\n${helios}\r\nX-Medusa\r\n${medusa}\r\n`;
    },
    dispose(){jobs.dispose?.();},
  };
}

const bdms=createBdms();
export default bdms;

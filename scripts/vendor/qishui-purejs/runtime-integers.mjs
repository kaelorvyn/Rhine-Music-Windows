export const runtimeKeys=Object.freeze({
  enabled:'45fddfkpor54jfdkdfhkek4jk5hk55k',
  initializedAt:'acf6ca909d36d3c37e2d0fe0995c4ebd',
  requestCount:'04b29480233f4def5c875875b6bdc3b1',
  digestStatus:'2e8ab1223d07836ad4fc65fc581b4808',
  statusA:'f0036511a681da731501008a14354fa3',
  statusB:'167774bf518c11948aa0784351ccf5a9',
});

/** Native integer map operations, including their missing-value behavior. */
export class NativeIntegerState {
  #values=new Map([[runtimeKeys.enabled,1]]);
  get(key){return this.#values.has(key)?this.#values.get(key):694367;}
  set(key,value){
    if(typeof key!=='string')throw new TypeError('runtime key must be a string');
    if(!Number.isInteger(value)||value< -0x80000000||value>0x7fffffff)throw new RangeError('runtime value must be int32');
    const previous=this.get(key);
    this.#values.set(key,value);
    return previous;
  }
  increment(key){
    if(typeof key!=='string')throw new TypeError('runtime key must be a string');
    const previous=this.#values.get(key)??0;
    this.#values.set(key,previous<0x7ffffffe?previous+1:previous);
    return previous;
  }
}

/** Observed initialization and request bookkeeping for this Luna profile. */
export class LunaIntegerState extends NativeIntegerState {
  constructor(initializationEpochSeconds){
    super();
    if(!Number.isInteger(initializationEpochSeconds)||initializationEpochSeconds<0||initializationEpochSeconds>0xffffffff)throw new RangeError('invalid initialization timestamp');
    this.set(runtimeKeys.initializedAt,initializationEpochSeconds|0);
    this.set(runtimeKeys.statusA,0);
    this.set(runtimeKeys.statusB,0);
  }
  beginRequest(){this.increment(runtimeKeys.requestCount);return this.get(runtimeKeys.requestCount);}
  get environmentFlag(){return this.get(runtimeKeys.digestStatus)>0?1:0;}
  finishRequest(){this.set(runtimeKeys.digestStatus,100);}
}

/** Runs before agent code. The private primitive accepts and returns bounded
 * strings only; its callable has a null prototype and is frozen in the worker.
 * URL/Buffer objects themselves are created inside the code realm. */
export const REALM_DATA = String.raw`
const {URL,URLSearchParams,Buffer,__timers,setTimeout,clearTimeout,setInterval,clearInterval}=(()=>{
  const primitive=globalThis.__elevenexData;
  delete globalThis.__elevenexData;
  function data(input){const out=JSON.parse(primitive(JSON.stringify(input)));if(out.error)throw new TypeError(out.error);return out.value;}
  class URLSearchParams {
    constructor(value='',changed){this._rows=data({op:'params',value});this._changed=changed;}
    _edit(method,args){this._rows=data({op:'params',value:this._rows,method,args});this._changed?.(this.toString());}
    append(k,v){this._edit('append',[String(k),String(v)]);}set(k,v){this._edit('set',[String(k),String(v)]);}delete(k,v){this._edit('delete',v===undefined?[String(k)]:[String(k),String(v)]);}sort(){this._edit('sort',[]);}
    get(k){return this._rows.find(row=>row[0]===String(k))?.[1]??null;}getAll(k){return this._rows.filter(row=>row[0]===String(k)).map(row=>row[1]);}has(k,v){return this._rows.some(row=>row[0]===String(k)&&(v===undefined||row[1]===String(v)));}
    get size(){return this._rows.length;}*entries(){yield* this._rows;}*keys(){for(const row of this._rows)yield row[0];}*values(){for(const row of this._rows)yield row[1];}[Symbol.iterator](){return this.entries();}forEach(fn,thisArg){for(const [k,v]of this._rows)fn.call(thisArg,v,k,this);}
    toString(){return data({op:'params-string',value:this._rows});}
  }
  const fields='href protocol username password host hostname port pathname search hash origin'.split(' ');
  class URL {
    constructor(value,base){this._data=data({op:'url',href:String(value),base:base===undefined?null:String(base)});}
    get searchParams(){return new URLSearchParams(this._data.search,value=>{this.search=value;});}
    toString(){return this.href;}toJSON(){return this.href;}
    static canParse(value,base){try{new URL(value,base);return true;}catch{return false;}}
  }
  for(const field of fields)Object.defineProperty(URL.prototype,field,{get(){return this._data[field];},...(field==='origin'?{}:{set(value){this._data=data({op:'url',href:this.href,key:field,value:String(value)});}})});
  class Buffer extends Uint8Array {
    static from(value,encoding='utf8'){if(typeof value==='string')return new Buffer(data({op:'bytes-from',value,encoding}));return new Buffer(value);}
    static alloc(length,fill=0){if(!Number.isSafeInteger(length)||length<0||length>1048576)throw new RangeError('Buffer allocation limit is 1 MiB');const value=new Buffer(length);value.fill(fill);return value;}
    static isBuffer(value){return value instanceof Buffer||(typeof __pw!=='undefined'&&__pw.isBuffer(value));}
    static concat(values){const length=values.reduce((n,value)=>n+value.length,0),out=Buffer.alloc(length);let offset=0;for(const value of values){out.set(value,offset);offset+=value.length;}return out;}
    toString(encoding='utf8'){return data({op:'bytes-string',value:Array.from(this),encoding});}
  }
  const timers=new Map();let nextTimer=0;
  function schedule(fn,ms,args,repeat){if(typeof fn!=='function')throw new TypeError('Timer callback must be a function');const id=++nextTimer;timers.set(id,{fn,args,repeat,ms:Math.max(repeat?10:0,Number(ms)||0)});data({op:'timer-set',id,ms:Math.max(repeat?10:0,Number(ms)||0)});return id;}
  function cancel(id){timers.delete(id);data({op:'timer-clear',id:Number(id)});}
  const __timers=Object.freeze({fire(id){const item=timers.get(id);if(!item)return;if(!item.repeat)timers.delete(id);item.fn(...item.args);if(item.repeat&&timers.has(id))data({op:'timer-set',id,ms:item.ms});}});
  return{URL,URLSearchParams,Buffer,__timers,setTimeout:(fn,ms=0,...args)=>schedule(fn,ms,args,false),clearTimeout:cancel,setInterval:(fn,ms=0,...args)=>schedule(fn,ms,args,true),clearInterval:cancel};
})();
`;

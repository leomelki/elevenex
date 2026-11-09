// This code is evaluated inside the code realm. It receives only JSON. Locator
// plans preserve Playwright's synchronous chaining; terminal calls delegate to
// real Playwright in the broker. Callback functions remain in this realm.
export const PLAYWRIGHT_FACADE = String.raw`
const __pw = (() => {
  const handles=new Map(), descriptors=new WeakMap(), callbacks=new Map(), functionIds=new WeakMap();
  let nextFunction=0, callbackRunning=0;
  const results=[];
  const locatorMethods=new Set('locator getByRole getByText getByLabel getByTestId getByAltText getByPlaceholder getByTitle frameLocator frame and or filter nth first last describe contentFrame owner'.split(' '));
  const sourceMethods=new Set(['evaluate','evaluateHandle','evaluateAll','waitForFunction','addInitScript']);
  const props={Page:{keyboard:'Keyboard',mouse:'Mouse',touchscreen:'Touchscreen',clock:'Clock',request:'APIRequestContext'},BrowserContext:{tracing:'Tracing',request:'APIRequestContext',clock:'Clock'},Assertion:{not:'Assertion',resolves:'Assertion',rejects:'Assertion'}};
  const sync=[];
  function encode(value, sourceOnly=false) {
    if(value===undefined)return {__pw:'undefined'};
    if(typeof value==='function'){
      let id=0;
      if(!sourceOnly){id=functionIds.get(value)||++nextFunction;if(callbacks.size>=512&&!callbacks.has(id))throw new Error('Callback budget exhausted; reset code state');functionIds.set(value,id);callbacks.set(id,value);}
      return {__pw:'function',id,source:value.toString()};
    }
    if(value===null||typeof value!=='object')return value;
    const ref=descriptors.get(value);if(ref)return ref;
    if(value instanceof RegExp)return {__pw:'regexp',source:value.source,flags:value.flags};
    if(value instanceof Date)return {__pw:'date',value:value.toISOString()};
    if(value instanceof URL)return {__pw:'url',href:value.href};
    if(value instanceof Uint8Array)return {__pw:'bytes',data:Array.from(value)};
    if(Array.isArray(value))return value.map(item=>encode(item,sourceOnly));
    return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,encode(item,sourceOnly)]));
  }
  function update(rows){for(const row of rows||[]){const old=handles.get(row.id);if(old){if((old.revision||0)>(row.revision||0))continue;old.meta=row.meta||{};old.revision=row.revision||0;}else handles.set(row.id,{...row,meta:row.meta||{},proxy:null});}}
  function decode(value){
    if(value===null||typeof value!=='object')return value;
    if(Array.isArray(value))return value.map(decode);
    if(value.__pw==='undefined')return undefined;
    if(value.__pw==='error'){const error=new Error(value.message);error.name=value.name;error.stack=value.stack;return error;}
    if(value.__pw==='regexp')return new RegExp(value.source,value.flags);
    if(value.__pw==='url')return new URL(value.href);
    if(value.__pw==='date')return new Date(value.value);
    if(value.__pw==='bytes')return Buffer.from(value.data);
    if(value.__pw==='map')return new Map(value.entries.map(([key,item])=>[key,decode(item)]));
    if(value.__pw==='result'){update(value.handles);return decode(value.value);}
    if(value.__pw==='handle'){
      if(!handles.has(value.id))handles.set(value.id,{...value,meta:value.meta||{},proxy:null});
      const entry=handles.get(value.id);return entry.proxy??=(proxy(value));
    }
    return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,decode(item)]));
  }
  async function send(input){const waits=sync.splice(0);if(waits.length)await Promise.all(waits);return decode(await __bridge.rpc('pw',[input]));}
  function plan(target,step,type){return proxy({__pw:'plan',id:target.id,steps:[...(target.steps||[]),step],type});}
  function proxy(target){
    const value=new Proxy(Object.create(null),{get(_object,key){
      if(key===Symbol.asyncDispose&&['DisposableStub','Disposable','JSHandle','ElementHandle','APIResponse'].includes(target.type))return ()=>send({op:'call',target,method:'dispose',args:[]});
      if(key===Symbol.asyncIterator&&target.type==='Readable')return async function*(){try{while(true){const next=await send({op:'stream-next',target});if(next.done)return;yield next.value;}}finally{await send({op:'call',target,method:'destroy',args:[]});}};
      if(key==='then'||key==='constructor'||key==='__proto__'||typeof key==='symbol')return undefined;
      if(target.type==='Browser'&&key==='tabs')return __bridge.browser.tabs;
      if(target.type==='Browser'&&key==='page')return tabId=>send({op:'page',tabId});
      if(target.type==='Browser'&&key==='wait')return __bridge.browser.wait;
      if(key==='toJSON')return ()=>({type:target.type,handle:target.id});
      const entry=target.__pw==='handle'?handles.get(target.id):null;
      const property=props[target.type]?.[key];
      if(property)return plan(target,{property:key},property);
      if(target.type==='Buffer'&&(key==='length'||key==='byteLength'))return entry?.meta.length;
      if(entry&&Object.hasOwn(entry.meta,key))return ()=>decode(entry.meta[key]);
      if(key==='page'&&target.__pw==='plan')return ()=>{const root=handles.get(target.id);return decode(root?.type==='Page'?{__pw:'handle',id:target.id,type:'Page'}:root?.meta.page);};
      return (...args)=>{
        const encoded=args.map((arg,index)=>encode(arg,index===0&&sourceMethods.has(key)));
        if(locatorMethods.has(key))return plan(target,{method:key,args:encoded},key==='frameLocator'||key==='contentFrame'?'FrameLocator':key==='frame'?'Frame':'Locator');
        const operation=()=>send({op:'call',target,method:key,args:encoded});
        if(key==='on'||key==='once'||key==='off'||key==='removeListener'||key==='setDefaultTimeout'||key==='setDefaultNavigationTimeout'||target.type==='WebSocketRoute'&&['onMessage','onClose','send','close'].includes(key)){
          const pending=__bridge.rpc('pw',[{op:'call',target,method:key,args:encoded}]).then(decode);sync.push(pending);return key==='setDefaultTimeout'||key==='setDefaultNavigationTimeout'?undefined:value;
        }
        return operation();
      };
    }});
    descriptors.set(value,target);return value;
  }
  function assertion(value,poll=false){
    const ready=send({op:'expect',value:encode(value),poll});
    function match(path=[]){return new Proxy(Object.create(null),{get(_target,key){if(key==='then'||key==='constructor'||typeof key==='symbol')return undefined;if(['not','resolves','rejects'].includes(key))return match([...path,key]);return async(...args)=>{const root=await ready;let target=descriptors.get(root);for(const property of path)target={__pw:'plan',id:target.id,steps:[...(target.steps||[]),{property}],type:'Assertion'};return send({op:'call',target,method:key,args:args.map(arg=>encode(arg))});}}});}
    return match();
  }
  return Object.freeze({
    encode,decode,update,
    isBuffer:value=>descriptors.get(value)?.type==='Buffer',
    readBytes:(value,offset=0,length=65536)=>send({op:'bytes-read',value:encode(value),offset,length}),
    context:decode({__pw:'handle',id:'pw:context',type:'BrowserContext'}),
    browser:decode({__pw:'handle',id:'pw:browser',type:'Browser'}),
    expect:Object.assign(value=>assertion(value),{poll:fn=>assertion(fn,true)}),
    page:tabId=>send({op:'page',tabId}),
    emitImage:image=>send({op:'image',value:encode(image)}),
    artifacts:Object.freeze({write:(name,data)=>send({op:'artifact-write',name,value:encode(data)}),read:name=>send({op:'artifact-read',name})}),
    human:Object.freeze({
      requestAction:(page,options)=>send({op:'human-request',kind:'action',...(typeof page==='string'?{tabId:page}:{page:encode(page)}),message:typeof options==='string'?options:options.message}),
      requestElement:(page,options)=>send({op:'human-request',kind:'element',...(typeof page==='string'?{tabId:page}:{page:encode(page)}),message:typeof options==='string'?options:options.message}),
      result:id=>send({op:'human-read',id}),cancel:id=>send({op:'human-cancel',id}),locator:id=>send({op:'human-locator',id})
    }),
    invoke(id,fnId,args){
      const fn=callbacks.get(fnId);if(!fn){results.push({id,error:'Callback expired'});return;}
      callbackRunning++;
      Promise.resolve().then(()=>fn(...decode(args))).then(async value=>{const waits=sync.splice(0);if(waits.length)await Promise.all(waits);return value;}).then(value=>results.push({id,value:encode(value)}),error=>results.push({id,error:String(error?.message??error)||'Callback failed'})).finally(()=>callbackRunning--);
    },
    drain(){return results.splice(0)},
    get callbackRunning(){return callbackRunning;}
  });
})();
const context=__pw.context;
const browser=__pw.browser;
const expect=__pw.expect;
const emitImage=__pw.emitImage;
const artifacts=__pw.artifacts;
const human=__pw.human;
const readBytes=__pw.readBytes;
`;

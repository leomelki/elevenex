/** Canonicalize browser-style numeric IPv4, IPv6 and localhost aliases before granting task ports. */
export function browserLoopbackHost(value:string):boolean{
  let host:string;try{const input=value.toLowerCase().replace(/\.$/,'');host=new URL('http://'+(input.includes(':')&&!input.startsWith('[')?'['+input+']':input)).hostname;}catch{return false;}
  if(host==='localhost'||host.endsWith('.localhost')||host==='0.0.0.0'||/^127\./.test(host)||host==='[::1]'||host==='[::]')return true;
  const mapped=/^\[::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})\]$/.exec(host);
  return !!mapped&&((parseInt(mapped[1]!,16)>>>8)===127||(parseInt(mapped[1]!,16)===0&&parseInt(mapped[2]!,16)===0));
}

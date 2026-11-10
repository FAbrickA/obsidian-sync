import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {DOMParser} from '@xmldom/xmldom';
import {createDavHandler} from '../../tools/lab/dav-server.ts';
import {createNativeDav} from '../../src/transport.ts';
import {clientV2} from '../v2/client.ts';
Object.defineProperty(globalThis,'DOMParser',{value:DOMParser,configurable:true});
for(const etag of ['weak','unquoted','none']as const)test('HTTP no-CAS convergence with '+etag+' tags and effect followed by HTTP500',async()=>{
  let fail=true;const issued:string[]=[];
  const server=http.createServer(createDavHandler({mode:'mailru-like',etag,afterPut:async(path)=>{if(path.includes('/journal/')){issued.push(path);if(fail){fail=false;return 500;}}}}));
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address()as{port:number}).port;
  const dav=createNativeDav({endpoint:'https://lab.invalid/',root:'lab/v2-'+crypto.randomUUID(),username:'synthetic',password:'synthetic'},async options=>{
    const u=new URL(options.url);assert.equal(u.origin,'https://lab.invalid');
    assert(!Object.keys(options.headers??{}).some(k=>['if-match','if-none-match','lock-token'].includes(k.toLowerCase())));
    const response=await fetch('http://127.0.0.1:'+port+u.pathname,{method:options.method,headers:options.headers,body:options.body as BodyInit|undefined});
    const arrayBuffer=await response.arrayBuffer();return{status:response.status,headers:Object.fromEntries(response.headers),arrayBuffer,text:new TextDecoder().decode(arrayBuffer),json:null};
  });
  const clients:Awaited<ReturnType<typeof clientV2>>[]=[];
  try{const a=await clientV2({dav},'create-v2');clients.push(a);const b=await clientV2({dav}),c=await clientV2({dav});clients.push(b,c);
    for(const[peer,i]of clients.map((p,i)=>[p,i]as const))peer.vault.seed('note'+i+'.md','client '+i);
    await Promise.all(clients.map(p=>p.engine.run()));for(const p of clients)assert.equal((await p.engine.run()).state,'clean');
    for(const p of clients)for(let i=0;i<3;i++)assert.equal(await p.vault.read('note'+i+'.md'),'client '+i);
    assert.equal(new Set(issued).size,issued.length);const views=await Promise.all(clients.map(p=>p.engine.currentView()));assert(views.every(v=>v.fingerprint===views[0].fingerprint));
  }finally{for(const c of clients)await c.close();dav.dispose();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

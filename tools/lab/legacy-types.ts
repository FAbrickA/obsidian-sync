// Historical protocol characterization only; never imported by the product.
import {DavError} from '../../src/transport.ts';
import type {DavEntry} from '../../src/transport.ts';
export type DavTransport={read(path:string):Promise<{bytes:ArrayBuffer;etag:string|undefined}>;put(path:string,bytes:ArrayBuffer,options:{createOnly?:boolean;ifMatch?:string}):Promise<{etag:string|undefined}>;remove(path:string,options:{ifMatch:string}):Promise<void>;mkdir(path:string):Promise<void>;list(path:string):Promise<DavEntry[]>;dispose():void};
export function requireStrongETag(value:string|undefined):string{if(!value||!/^"[^"\r\n]*"$/.test(value))throw new DavError('Unsupported');return value;}

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {build} from 'esbuild';
import {rev,bytes} from './v2/fixtures.ts';
import {noCasDav} from './v2/memory-dav.ts';
import {clientV2} from './v2/client.ts';

// Execute the actual bundled modal with a small rendering surface, not a copy of its decisions.
class Element {
  text:string;children:Element[]=[];buttons:Control[]=[];
  constructor(text=''){this.text=text;}
  empty(){this.children=[];this.buttons=[];} addClass(){}
  createEl(_tag:string,options?:{text?:string}){const e=new Element(options?.text);this.children.push(e);return e;}
  setText(value:string){this.text=value;}
  all():Element[]{return[this,...this.children.flatMap(e=>e.all())];}
}
class Control {
  text='';disabled=false;click?:()=>Promise<void>;
  setValue(_value:unknown){return this;}setTooltip(_text:string){return this;}
  setDisabled(value:boolean){this.disabled=value;return this;}setButtonText(value:string){this.text=value;return this;}
  onChange(_fn:unknown){return this;}onClick(fn:()=>Promise<void>){this.click=fn;return this;}
}
class Setting {
  el:Element;constructor(el:Element){this.el=el;}
  setName(text:string){this.el.createEl('span',{text});return this;}setDesc(text:string){this.el.createEl('span',{text});return this;}
  addText(fn:(c:Control)=>void){fn(new Control());return this;}addTextArea(fn:(c:Control)=>void){return this.addText(fn);}
  addToggle(fn:(c:Control)=>void){return this.addText(fn);}
  addButton(fn:(c:Control)=>void){const c=new Control();fn(c);this.el.buttons.push(c);return this;}
}
const bundle=await build({entryPoints:['src/ui.ts'],bundle:true,platform:'browser',format:'cjs',external:['obsidian'],write:false,logLevel:'silent'});
function modal(owner:unknown){
  const module={exports:{} as {ConflictsModal:new(owner:unknown)=>{onOpen():Promise<void>;contentEl:Element}}};
  class Modal {contentEl=new Element();app:unknown;constructor(app:unknown){this.app=app;}}
  vm.runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require:()=>({Modal,Setting,PluginSettingTab:class{},Notice:class{}}),TextEncoder,TextDecoder,crypto,structuredClone});
  return new module.exports.ConflictsModal(owner);
}

test('path resolution requires explicit content resolution before any filename-only action',async()=>{
  const heads=[await rev('f','first'),await rev('f','second')],other=await rev('other','third');
  const view={headsByFile:{f:heads,other:[other]},pathConflicts:[{fileIds:['f','other'],paths:['a.md']}]};
  const session={engine:{conflicts:async()=>[{id:'c',fileId:'f',variants:heads,reason:'concurrent-versions'}],currentView:async()=>view},
    state:{listMeta:async()=>({})},projection:{drifts:async()=>[]}};
  const m=modal({app:{},session});await m.onOpen();const elements=m.contentEl.all();
  assert(elements.some(e=>e.text.includes('Сначала разрешите конфликт версий')));
  assert(!elements.flatMap(e=>e.buttons).some(b=>b.text==='Применить выбранные пути'));
});

test('a real unknown local copy after deletion is visible in conflicts and its archived bytes can be extracted',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2');a.vault.seed('a.md','old');await a.engine.run();a.vault.files.delete('a.md');await a.engine.run();
  const b=await clientV2(remote);b.vault.seed('a.md','local preserved');
  try{
    assert.equal((await b.engine.run()).state,'conflicted');const m=modal({app:{vault:b.vault.vault},session:b});await m.onOpen();
    const elements=m.contentEl.all();assert(!elements.some(e=>e.text==='Конфликтов нет.'));
    assert(elements.some(e=>e.text.includes('unknown-copy-after-delete')));
    assert(elements.some(e=>e.text.includes('переименуйте')));assert(elements.some(e=>e.text.includes('удалите')));
    const extract=elements.flatMap(e=>e.buttons).find(c=>c.text==='Извлечь локальную копию из архива');assert(extract?.click);await extract.click();
    assert([...b.vault.files].some(([path,f])=>path.startsWith('Recovered-quarantine-')&&new TextDecoder().decode(f.bytes)==='local preserved'));
    assert.equal(await b.vault.read('a.md'),'local preserved');
  }finally{await a.close();await b.close();}
});

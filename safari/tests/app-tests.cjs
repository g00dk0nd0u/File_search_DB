'use strict';
// Synthetic DOM event tests: no claim about browser rendering/native chooser.
const {test}=require('node:test'), assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const C=require('../core.js'), S=require('../search.js');
const source=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
const tick=async()=>{for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r));};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
function file(path,body='日本語'){
 const blob=new Blob([body]);
 return {name:path.split('/').at(-1),webkitRelativePath:path,size:blob.size,lastModified:1,
   slice:(...args)=>blob.slice(...args)};
}
async function harness(records=[],search=S.search){
 class Element{
   constructor(tag='div'){this.tagName=tag;this.children=[];this.events={};this.attrs={};this.value='';this._text='';this.hidden=false;}
   set textContent(v){this._text=v;this.children=[];} get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}
   append(...children){for(const c of children){if(c.fragment)this.append(...c.children);else {c.parent=this;this.children.push(c);}}}
   replaceChildren(...children){this.children=[];this._text='';this.append(...children);}
   addEventListener(name,fn){(this.events[name]??=[]).push(fn);}
   async emit(name,event={}){for(const fn of this.events[name]||[])await fn({preventDefault(){},...event});}
   click(){return this.emit('click');} focus(){this.focused=true;}
   setAttribute(k,v){this.attrs[k]=v;} getAttribute(k){return this.attrs[k];}
   remove(){this.parent.children=this.parent.children.filter(c=>c!==this);}
 }
 const ids=Object.fromEntries(['search-view','settings-view','query','root','picker','preview','preview-title','results','roots','notice','meta','search','search-form','settings-button','back','add'].map(id=>[id,new Element()]));
 const all=()=>Object.values(ids).flatMap(e=>[e,...desc(e)]);
 const desc=e=>e.children.flatMap(c=>[c,...desc(c)]);
 const document={getElementById:id=>ids[id],createElement:tag=>new Element(tag),createDocumentFragment:()=>Object.assign(new Element(),{fragment:true}),
 querySelectorAll:()=>all().filter(e=>e.className==='file'&&e.getAttribute('aria-pressed')==='true')};
 const stored=new Map(records.map(r=>[r.id,structuredClone(r)])), events={};
 class Storage{
   async all(){return structuredClone([...stored.values()]);}
   async put(record,current,signal){if(!current()||signal.aborted)throw new DOMException('cancel','AbortError');stored.set(record.id,structuredClone(record));}
   async remove(id){stored.delete(id);}
 }
 let id=0;
 await vm.runInNewContext(source,{document,window:{addEventListener:(name,fn)=>events[name]=fn},FolderSearch:{...S,search},SafariCore:{...C,Storage},
   setTimeout,clearTimeout,Blob,URL:{createObjectURL:()=> 'blob:test',revokeObjectURL(){}},crypto:{randomUUID:()=>String(++id)},Array,Map,Set});
 async function reselect(){
   await ids['settings-button'].click();
   const index=ids.root.children.findIndex(option=>option.value===ids.root.value);
   await desc(ids.roots.children[index]).find(e=>e.tagName==='button'&&e.textContent==='再選択').click();
 }
 async function pick(files,add=true){if(add)await ids.add.click();else await reselect();ids.picker.files=files;await ids.picker.emit('change');await tick();}
 async function query(q){ids.query.value=q;await ids['search-form'].emit('submit');await tick();}
 const buttons=()=>desc(ids.results).filter(e=>e.className==='file');
 async function expand(){for(const e of [...ids.results.children]){e.open=true;await e.emit('toggle');}}
 return {ids,stored,events,pick,reselect,query,expand,buttons,desc,tick};
}
test('UI startup with saved index displays registration but no results or previews',async()=>{
 const h=await harness([{id:'old',displayName:'保存済み',rootName:'A',snapshot:{folders:[{path:'',name:'A'}],files:[{name:'secret'}]}}]);
 await h.query('secret');assert.equal(h.ids.results.children.length,0);assert.equal(h.ids.preview.children.length,0);assert.match(h.ids.meta.textContent,/再選択/);
});
test('UI search, expand, Japanese preview; state survives repeated search',async()=>{
 const h=await harness();await h.pick([file('A/日本語/alpha beta.txt')]);await h.query('alpha');
 assert.equal(h.ids.results.children.length,1);assert.equal(h.ids.meta.textContent,'');await h.expand();await h.buttons()[0].click();
 assert.equal(h.ids.preview.children[0].textContent,'日本語');
 assert.equal(h.ids.results.children[0].children.some(e=>e.tagName==='p'),false);
 await h.query('alpha beta');assert.equal(h.ids.results.children[0].open,true);
 assert.equal(h.buttons()[0].getAttribute('aria-pressed'),'true');
});
test('UI root switch isolates sessions and clears old preview',async()=>{
 const h=await harness();await h.pick([file('Same/one.txt')]);await h.pick([file('Same/two.txt')]);await h.query('two');
 await h.expand();await h.buttons()[0].click();h.ids.root.value='1';await h.ids.root.emit('change');await h.tick();
 assert.equal(h.ids.preview.children.length,0);assert.match(h.ids.meta.textContent,/一致するフォルダはありません/);
 await h.query('one');assert.equal(h.ids.results.children.length,1);assert.equal(h.ids.meta.textContent,'');assert.equal(h.stored.size,2);
});
test('UI read failure hides complete result set and keeps saved metadata',async()=>{
 const h=await harness(),f=file('A/f.txt');await h.pick([f]);await h.query('f.txt');await h.expand();
 f.slice=()=>{throw Error('NotReadableError');};await h.buttons()[0].click();await h.tick();
 assert.equal(h.ids.results.children.length,0);assert.equal(h.ids.preview.children.length,0);assert.equal(h.stored.size,1);assert.match(h.ids.meta.textContent,/再選択/);
});
test('UI cancel/reselection and pagehide never restore former results',async()=>{
 const h=await harness();await h.pick([file('A/old.txt')]);await h.query('old');await h.reselect();await h.ids.picker.emit('cancel');await h.tick();
 assert.equal(h.ids.results.children.length,0);assert.equal(h.stored.size,1);
 await h.pick([file('A/new.txt')],false);await h.query('new');assert.equal(h.ids.results.children.length,1);assert.equal(h.ids.meta.textContent,'');
 h.events.pagehide();h.events.pageshow({persisted:true});await h.tick();assert.equal(h.ids.results.children.length,0);assert.equal(h.ids.preview.children.length,0);
});
test('UI late preview cannot appear after switching roots',async()=>{
 const h=await harness(),f=file('A/slow.txt');await h.pick([f]);await h.pick([file('B/other.txt')]);
 h.ids.root.value='1';await h.ids.root.emit('change');await h.pick([f],false);await h.query('slow');await h.expand();
 const gate=deferred(),slice=f.slice;f.slice=(...args)=>({arrayBuffer:async()=>{await gate.promise;return slice(...args).arrayBuffer();}});
 const pending=h.buttons()[0].click();h.ids.root.value='2';await h.ids.root.emit('change');gate.resolve();await pending;await h.tick();
 assert.equal(h.ids.preview.children.length,0);
});
test('UI late search cannot replace newer query or active root',async()=>{
 const gate=deferred();let slow=false;
 const h=await harness([],async(...args)=>{if(slow&&args[1]==='old')await gate.promise;return S.search(...args);});
 await h.pick([file('A/old.txt')]);await h.pick([file('B/new.txt')]);
 h.ids.root.value='1';await h.ids.root.emit('change');await h.pick([file('A/old.txt')],false);slow=true;
 h.ids.root.value='1';await h.ids.root.emit('change');h.ids.query.value='old';await h.ids['search-form'].emit('submit');
 h.ids.root.value='2';await h.ids.root.emit('change');await h.query('new');gate.resolve();await h.tick();
 assert.equal(h.ids.results.children.length,1);assert.equal(h.ids.meta.textContent,'');assert.equal(h.ids.results.children[0].children[0].textContent,'B');
});
test('UI Japanese composition does not submit partial query',async()=>{
 let searches=0;const h=await harness([],async(...args)=>{searches++;return S.search(...args);});
 await h.pick([file('A/日本語.txt')]);await h.ids.query.emit('compositionstart');h.ids.query.value='日';
 await h.ids.query.emit('input',{isComposing:true});await h.ids['search-form'].emit('submit');assert.equal(searches,0);
 h.ids.query.value='日本語';await h.ids.query.emit('compositionend');await h.tick();assert.equal(searches,1);assert.equal(h.ids.results.children.length,1);assert.equal(h.ids.meta.textContent,'');
});

test('UI failed Add never falls back to old active results',async()=>{
 const h=await harness();await h.pick([file('A/old.txt')]);await h.query('old');
 const bad=file('B/bad.txt');bad.slice=()=>{throw Error('NotReadableError');};
 await h.pick([bad]);assert.equal(h.ids.results.children.length,0);assert.equal(h.ids.preview.children.length,0);assert.equal(h.stored.size,1);
});

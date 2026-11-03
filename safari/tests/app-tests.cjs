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
async function harness(records=[],search=S.search,preferences=new Map(),storageFails=false){
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
 const ids=Object.fromEntries(['result-controls','result-count','result-more','modified','format','preview-close','preview-panel','workspace','search-view','settings-view','query','root','picker','preview','preview-title','results','roots','notice','meta','search','search-form','settings-button','back','add','theme-toggle','theme-status'].map(id=>[id,new Element()]));
 ids.modified.value=ids.format.value="all";
 const all=()=>Object.values(ids).flatMap(e=>[e,...desc(e)]);
 const desc=e=>e.children.flatMap(c=>[c,...desc(c)]);
 const document={documentElement:new Element("html"),getElementById:id=>ids[id],createElement:tag=>new Element(tag),createTextNode:text=>Object.assign(new Element("#text"),{textContent:text}),createDocumentFragment:()=>Object.assign(new Element(),{fragment:true}),
 querySelectorAll:()=>all().filter(e=>e.className==='file'&&e.getAttribute('aria-pressed')==='true')};
 const stored=new Map(records.map(r=>[r.id,structuredClone(r)])), events={};
 class Storage{
   async all(){return structuredClone([...stored.values()]);}
   async put(record,current,signal){if(!current()||signal.aborted)throw new DOMException('cancel','AbortError');stored.set(record.id,structuredClone(record));}
   async remove(id){stored.delete(id);}
 }
 let id=0;
 await vm.runInNewContext(source,{document,DOMException,localStorage:{getItem:k=>preferences.get(k),setItem:(k,v)=>{if(storageFails)throw Error("quota");preferences.set(k,v);}},window:{addEventListener:(name,fn)=>events[name]=fn},FolderSearch:{...S,search},SafariCore:{...C,Storage},
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
 return {ids,document,preferences,stored,events,pick,reselect,query,expand,buttons,desc,tick};
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
 assert.equal(h.ids['preview-panel'].hidden,true);
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

const folders = h => h.desc(h.ids.results).filter(e=>e.tagName==='details');
const marks = (h,e) => h.desc(e).filter(e=>e.tagName==='mark').map(e=>e.textContent);
const namedFolder = (h,name) => folders(h).find(e=>e.children[0].textContent===name);
const toggle = async (details,open) => {details.open=open;await details.emit('toggle');};
const moreButton = h => h.desc(h.ids.results).find(e=>e.tagName==='button'&&e.textContent==='さらに表示');
async function settle(h) {for(let i=0;i<20;i++){await new Promise(r=>setTimeout(r,1));await h.tick();}}

test('result and nested folders open initially, files and nested highlights are immediately visible',async()=>{
 const h=await harness();await h.pick([file('Root/友依子_仕事/友依子_子/深い階層/友依子_特記.txt'),file('Root/友依子_仕事/実施設計図一式.pdf')]);
 await h.query('友依子');await settle(h);
 assert.ok(folders(h).length>=3);assert.ok(folders(h).every(e=>e.open));
 assert.ok(h.buttons().some(e=>e.textContent==='友依子_特記.txt'));
 assert.deepEqual(marks(h,namedFolder(h,'友依子_仕事').children[0]),['友依子']);
 assert.deepEqual(marks(h,namedFolder(h,'友依子_子').children[0]),['友依子']);
 assert.deepEqual(marks(h,h.buttons().find(e=>e.textContent==='友依子_特記.txt')),['友依子']);
 assert.equal(h.buttons().some(e=>e.textContent==='実施設計図一式.pdf'),false);
});
test('manual collapse survives same-query redraw and reopens on changed query',async()=>{
 const h=await harness();await h.pick([file('Root/alpha/alpha_child/alpha_file.txt')]);await h.query('alpha');
 await toggle(namedFolder(h,'alpha_child'),false);await toggle(namedFolder(h,'alpha'),false);
 await h.query('alpha');assert.equal(namedFolder(h,'alpha').open,false);
 await toggle(namedFolder(h,'alpha'),true);await settle(h);assert.equal(namedFolder(h,'alpha_child').open,false);
 await h.query('alpha OR file');await settle(h);assert.ok(folders(h).every(e=>e.open));
});
test('root switches keep collapse choices isolated for the same query',async()=>{
 const h=await harness();await h.pick([file('A/alpha/alpha_one.txt')]);await h.pick([file('B/alpha/alpha_two.txt')]);
 await h.query('alpha');await toggle(namedFolder(h,'alpha'),false);
 h.ids.root.value='1';await h.ids.root.emit('change');await h.tick();assert.equal(namedFolder(h,'alpha').open,true);
 h.ids.root.value='2';await h.ids.root.emit('change');await h.tick();assert.equal(namedFolder(h,'alpha').open,false);
});
test('IME preserves collapse during composition and resets expansion/highlights only on commit',async()=>{
 const h=await harness();await h.pick([file('Root/日本語/日本語.txt')]);await h.query('日');await toggle(namedFolder(h,'日本語'),false);
 await h.ids.query.emit('compositionstart');h.ids.query.value='日本';await h.ids.query.emit('input',{isComposing:true});
 assert.equal(namedFolder(h,'日本語').open,false);assert.deepEqual(marks(h,namedFolder(h,'日本語').children[0]),['日']);
 await h.ids['search-form'].emit('submit');assert.equal(namedFolder(h,'日本語').open,false);
 await h.ids.query.emit('compositionend');await h.tick();assert.equal(namedFolder(h,'日本語').open,true);
 assert.deepEqual(marks(h,namedFolder(h,'日本語').children[0]),['日本']);
});
test('AND OR exclusions and quoted phrases highlight only positive literal matches',async()=>{
 const h=await harness();await h.pick([file('alpha beta gamma/ALPHA alpha beta gamma draft.pdf')]);
 for(const [query,expected] of [['alpha beta',['ALPHA','alpha','beta']],['alpha OR gamma -absent',['ALPHA','alpha','gamma']],['"alpha beta"',['alpha beta']],['-absent',[]]]){
  await h.query(query);assert.deepEqual(marks(h,h.buttons()[0]),expected);
 }
});
test('Unicode casefold expansion maps marks back to complete original characters',async()=>{
 const h=await harness();await h.pick([file('Straße İ Σ 𐐀/ß_İ_Σ_𐐀.txt')]);await h.query('ss OR i OR σ OR 𐐨');
 assert.deepEqual(marks(h,h.buttons()[0]),['ß','İ','Σ','𐐀']);assert.equal(h.buttons()[0].textContent,'ß_İ_Σ_𐐀.txt');
});
test('overlapping and adjacent matches merge without changing original text',async()=>{
 const h=await harness();await h.pick([file('ab bc cd/abcd_abcd.txt')]);await h.query('ab OR bc OR cd');
 assert.deepEqual(marks(h,h.buttons()[0]),['abcd','abcd']);assert.equal(h.buttons()[0].textContent,'abcd_abcd.txt');
});
test('names containing HTML are rendered as literal text nodes and mark elements',async()=>{
 const h=await harness();await h.pick([file('alpha beta/<img onerror=x>alpha beta.txt')]);await h.query('"alpha beta"');
 const button=h.buttons()[0];assert.equal(button.textContent,'<img onerror=x>alpha beta.txt');
 assert.deepEqual(button.children.map(e=>e.tagName),['#text','mark','#text']);
 assert.deepEqual(marks(h,button),['alpha beta']);
});
test('deep hierarchy is initially bounded and explicitly continues without recursive DOM construction',async(t)=>{
 const h=await harness(),path='Root/Hit/Hit0/'+Array.from({length:1000},(_,i)=>'level'+i).join('/')+'/Hit_file.txt';
 await h.pick([file(path)]);const started=Date.now();await h.query('Hit');await settle(h);
 const initial=folders(h).length;assert.ok(initial>2&&initial<30);assert.ok(folders(h).every(e=>e.open));assert.ok(moreButton(h));
 await moreButton(h).click();await settle(h);assert.ok(folders(h).length>initial&&folders(h).length<50);
 assert.ok(Date.now()-started<5000);t.diagnostic('1000-level synthetic tree: '+(Date.now()-started)+' ms, initial folder nodes: '+initial);
});
test('wide results share a global display budget and continue in existing 200-item pages',async(t)=>{
 const h=await harness();await h.pick(Array.from({length:25000},(_,i)=>file('Root/Hit/Hit0/Hit_item'+i+'.txt')));
 const started=Date.now();await h.query('Hit');
 while(!h.buttons().length&&Date.now()-started<5000)await new Promise(r=>setTimeout(r,5));
 await settle(h);const initial=h.buttons().length;
 assert.ok(initial>0&&initial<=400);assert.ok(moreButton(h));
 await moreButton(h).click();await settle(h);assert.ok(h.buttons().length>initial&&h.buttons().length<=800);
 assert.ok(Date.now()-started<5000);t.diagnostic('25000-file synthetic display: '+(Date.now()-started)+' ms, initial file buttons: '+initial);
});
test('queued display jobs from a previous query or root never append to newer results',async()=>{
 const h=await harness();await h.pick(Array.from({length:120},(_,i)=>file('A/hit'+i+'/file.txt')));await h.pick([file('B/new.txt')]);
 h.ids.root.value='1';await h.ids.root.emit('change');h.ids.query.value='hit';await h.ids['search-form'].emit('submit');
 h.ids.root.value='2';await h.ids.root.emit('change');await h.query('new');await settle(h);
 assert.equal(h.ids.results.children.length,1);assert.equal(h.ids.results.children[0].children[0].textContent,'B');
 assert.equal(h.buttons().length,1);assert.equal(h.buttons()[0].textContent,'new.txt');
});

test('manual collapse immediately followed by Search survives the delayed native toggle event',async()=>{
 const h=await harness();await h.pick([file('Root/alpha/file.txt')]);await h.query('alpha');
 const details=namedFolder(h,'alpha');
 // A real summary click applies its default action before the queued toggle event.
 await details.children[0].click();details.open=false;
 await h.query('alpha');await details.emit('toggle');
 assert.equal(namedFolder(h,'alpha').open,false);
});

test('manual reopen and root switch retain actual state before queued toggle events',async()=>{
 const h=await harness();await h.pick([file('A/alpha/one.txt')]);await h.pick([file('B/alpha/two.txt')]);await h.query('alpha');
 await toggle(namedFolder(h,'alpha'),false);await h.query('alpha');
 let details=namedFolder(h,'alpha');await details.children[0].click();details.open=true;
 await h.query('alpha');await details.emit('toggle');assert.equal(namedFolder(h,'alpha').open,true);
 details=namedFolder(h,'alpha');await details.children[0].click();details.open=false;
 h.ids.root.value='1';await h.ids.root.emit('change');await h.tick();await details.emit('toggle');
 h.ids.root.value='2';await h.ids.root.emit('change');await h.tick();assert.equal(namedFolder(h,'alpha').open,false);
});


test('folder-name hits never expose unrelated files; retain only paths to descendant matches',async()=>{
 const h=await harness();await h.pick(['Root/健康/健康保険証.pdf','Root/健康/健康診断.pdf','Root/健康/旅行写真.jpg','Root/健康/領収書.pdf','Root/健康/中間/深い/健康記録.txt','Root/健康/無関係/写真.jpg','Root/健康のみ/旅行.jpg'].map(p=>file(p)));
 await h.query('健康');await settle(h);
 assert.deepEqual([...new Set(h.buttons().map(e=>e.textContent))].sort(),['健康保険証.pdf','健康診断.pdf','健康記録.txt'].sort());
 for(const name of ['健康','中間','深い','健康のみ'])assert.ok(namedFolder(h,name));
 assert.equal(namedFolder(h,'無関係'),undefined);
 assert.equal(h.buttons().some(e=>/旅行|領収書|写真/.test(e.textContent)),false);
});
test('display filtering carries AND OR exclusion and phrases through descendants',async()=>{
 const h=await harness();await h.pick(['Root/alpha beta/bridge/deep/alpha beta.txt','Root/alpha beta/bridge/deep/alpha draft beta.txt','Root/alpha beta/bridge/deep/gamma delta.txt','Root/alpha beta/bridge/deep/unrelated.txt'].map(p=>file(p)));
 for(const [q,names] of [['alpha beta',['alpha beta.txt','alpha draft beta.txt']],['alpha OR gamma -draft',['alpha beta.txt','gamma delta.txt']],['"alpha beta"',['alpha beta.txt']],['-draft',['alpha beta.txt','gamma delta.txt','unrelated.txt']]]){
  await h.query(q);await settle(h);
  assert.deepEqual([...new Set(h.buttons().map(e=>e.textContent))].sort(),names.sort());
 }
});
test('theme toggles immediately, persists across startup and leaves registrations untouched',async()=>{
 const records=[{id:'saved',displayName:'Saved',rootName:'A',snapshot:{folders:[],files:[]}}];
 const preferences=new Map(),h=await harness(records,S.search,preferences),before=structuredClone([...h.stored]);
 assert.equal(h.document.documentElement.getAttribute('data-theme'),'light');
 await h.ids['theme-toggle'].click();
 assert.equal(h.document.documentElement.getAttribute('data-theme'),'dark');
 assert.equal(h.ids['theme-toggle'].getAttribute('aria-pressed'),'true');assert.equal(h.ids['theme-status'].textContent,'Dark');
 assert.deepEqual([...h.stored],before);
 const restart=await harness(records,S.search,preferences);
 assert.equal(restart.document.documentElement.getAttribute('data-theme'),'dark');assert.deepEqual([...restart.stored],before);
 await restart.ids['theme-toggle'].click();assert.equal(preferences.get('file-search-safari-theme'),'light');
});
test('unavailable theme storage does not break UI or touch saved roots',async()=>{
 const h=await harness([],S.search,new Map(),true);await h.ids['theme-toggle'].click();
 assert.equal(h.document.documentElement.getAttribute('data-theme'),'dark');assert.match(h.ids.notice.textContent,/保存できません/);
 await h.pick([file('Root/health.txt')]);await h.query('health');assert.equal(h.buttons().length,1);
});

test('theme changes neither rerun search nor discard live selected files',async()=>{
 let searches=0;const h=await harness([],async(...args)=>{searches++;return S.search(...args);});
 await h.pick([file('Root/健康.txt')]);await h.query('健康');await h.buttons()[0].click();
 const before=structuredClone([...h.stored]),calls=searches;
 await h.ids['settings-button'].click();await h.ids['theme-toggle'].click();
 assert.equal(searches,calls);assert.deepEqual([...h.stored],before);
 assert.equal(h.ids.preview.children[0].textContent,'日本語');
 await h.ids.back.click();await h.tick();assert.equal(h.buttons().length,1);
 assert.equal(h.buttons()[0].getAttribute('aria-pressed'),'true');
});
test('large subtree filtering yields and cannot append after query/root change',async()=>{
 const h=await harness();await h.pick(Array.from({length:25000},(_,i)=>file('A/Hit/deep/unrelated'+i+'.txt')));
 await h.pick([file('B/new.txt')]);h.ids.root.value='1';await h.ids.root.emit('change');
 h.ids.query.value='Hit';await h.ids['search-form'].emit('submit');
 // Allow the unchanged search engine to finish, then invalidate display work.
 await new Promise(r=>setTimeout(r,120));
 h.ids.root.value='2';await h.ids.root.emit('change');await h.query('new');await settle(h);
 assert.equal(h.ids.results.children[0].children[0].textContent,'B');
 assert.deepEqual(h.buttons().map(e=>e.textContent),['new.txt']);
});
test('preview close invalidates slow reads; same conditions and theme keep an open preview',async()=>{
 const h=await harness(), f=file('A/alpha.txt');await h.pick([f]);await h.query('alpha');
 assert.equal(h.ids['preview-panel'].hidden,true);
 await h.buttons()[0].click();assert.equal(h.ids['preview-panel'].hidden,false);
 await h.query('alpha');assert.equal(h.ids['preview-panel'].hidden,false);
 await h.ids['theme-toggle'].click();assert.equal(h.ids['preview-panel'].hidden,false);
 await h.ids['preview-close'].click();assert.equal(h.ids['preview-panel'].hidden,true);
 const gate=deferred(),slice=f.slice;f.slice=(...args)=>({arrayBuffer:async()=>{await gate.promise;return slice(...args).arrayBuffer();}});
 const pending=h.buttons()[0].click();await h.ids['preview-close'].click();gate.resolve();await pending;
 assert.equal(h.ids.preview.children.length,0);assert.equal(h.ids['preview-panel'].hidden,true);
});
test('filter-only changes rerun cached search, prune files and close preview',async()=>{
 const h=await harness(),now=Date.now(), pdf=file('A/deep/alpha.PDF'), old=file('A/deep/old.pdf'),txt=file('A/deep/alpha.txt');
 pdf.lastModified=txt.lastModified=now;old.lastModified=now-181*86400000;
 await h.pick([pdf,old,txt]);assert.equal(h.ids.results.children.length,0);
 h.ids.format.value='pdf';await h.ids.format.emit('change');await h.tick();
 assert.deepEqual([...new Set(h.buttons().map(b=>b.textContent))].sort(),['alpha.PDF','old.pdf']);
 await h.buttons()[0].click();h.ids.modified.value='7';await h.ids.modified.emit('change');await h.tick();
 assert.deepEqual([...new Set(h.buttons().map(b=>b.textContent))],['alpha.PDF']);assert.equal(h.ids['preview-panel'].hidden,true);
 await h.query('alpha -draft');assert(h.buttons().every(b=>b.textContent==='alpha.PDF'));
});

const waitFor = async predicate => {
 const end=Date.now()+15000;
 while(Date.now()<end){if(predicate())return;await new Promise(r=>setTimeout(r,2));}
 throw Error('Timed out waiting for result');
};
test('name-only results open to eligible deep files; descendant matches remain selective',async()=>{
 const h=await harness(),now=Date.now(),day=86400000;
 const paths=['Root/alpha only/one/two/three/four/report.pdf','Root/alpha only/one/two/three/four/alpha.txt',
  'Root/alpha only/old/old.pdf','Root/alpha both/bridge/alpha.pdf','Root/alpha both/bridge/other.pdf','Root/alpha empty/old.pdf','Root/alpha solo/deep/unrelated.md'];
 let reads=0;
 const files=paths.map((path,i)=>{const f=file(path);f.lastModified=now-([2,5].includes(i)?8*day:0);const slice=f.slice;f.slice=(...args)=>{reads++;return slice(...args);};return f;});
 await h.pick(files);reads=0;await h.query('alpha');await settle(h);
 assert.equal(namedFolder(h,'alpha only').open,true);
 assert.equal(h.buttons().some(b=>b.textContent==='other.pdf'),false);
 assert.equal(namedFolder(h,'alpha solo').open,false);
 await toggle(namedFolder(h,'alpha solo'),true);await settle(h);
 assert.equal(h.buttons().some(b=>b.textContent==='unrelated.md'),true);
 h.ids.format.value='pdf';await h.ids.format.emit('change');h.ids.modified.value='7';await h.ids.modified.emit('change');
 await waitFor(()=>h.ids['result-count'].textContent==='3 / 3');await settle(h);
 const only=namedFolder(h,'alpha only'),both=namedFolder(h,'alpha both');
 assert.equal(only.open,false);assert.equal(both.open,true);assert.equal(namedFolder(h,'alpha empty'),undefined);
 assert.equal(h.buttons().some(b=>b.textContent==='alpha.pdf'),true);
 assert.equal(h.buttons().some(b=>b.textContent==='other.pdf'),false);
 await toggle(only,true);await settle(h);
 assert.equal(h.buttons().some(b=>b.textContent==='report.pdf'),true);
 assert.equal(h.buttons().some(b=>b.textContent==='old.pdf'||b.textContent==='alpha.txt'),false);
 assert.equal(reads,0);
 await h.buttons().find(b=>b.textContent==='report.pdf').click();assert(reads>0);assert.equal(h.ids['preview-panel'].hidden,false);
 await h.ids['preview-close'].click();assert.equal(h.ids['preview-panel'].hidden,true);
 await h.query('alpha');await settle(h);assert.equal(namedFolder(h,'alpha only').open,true);
});
for(const total of [100,101,250,1205]) test(`folder result pagination: ${total}`,async()=>{
 const h=await harness();
 const files=Array.from({length:total},(_,i)=>file('Root/hit'+String(total-i-1).padStart(4,'0')+'/other.txt'));
 await h.pick(files);await h.query('hit');
 await waitFor(()=>h.ids['result-count'].textContent===`${Math.min(100,total)} / ${total}`);
 assert.equal(h.ids.results.children.length,Math.min(100,total));assert.equal(h.ids['result-more'].hidden,total<=100);
 let shown=Math.min(100,total);
 while(shown<total){await h.ids['result-more'].click();shown=Math.min(shown+100,total);assert.equal(h.ids['result-count'].textContent,`${shown} / ${total}`);assert.equal(h.ids.results.children.length,shown);}
 assert.equal(h.ids['result-more'].hidden,true);
 const names=h.ids.results.children.map(e=>e.children[0].textContent);
 assert.equal(new Set(names).size,total);assert.deepEqual(names,Array.from({length:total},(_,i)=>'hit'+String(i).padStart(4,'0')));
 await h.query('hit000');await waitFor(()=>h.ids['result-count'].textContent==='10 / 10');
 assert.equal(h.ids.results.children.length,10);assert.equal(h.ids['result-more'].hidden,true);
});
test('paging resets on filters and root switch, and stale queued pages never append',async()=>{
 const h=await harness(),files=Array.from({length:250},(_,i)=>{const f=file('A/hit'+String(i).padStart(4,'0')+'/other.pdf');f.lastModified=Date.now();return f;});
 await h.pick(files);await h.pick([file('B/hit-other.txt')]);
 h.ids.root.value='1';await h.ids.root.emit('change');await h.query('hit');await waitFor(()=>h.ids['result-count'].textContent==='100 / 250');
 await h.ids['result-more'].click();assert.equal(h.ids['result-count'].textContent,'200 / 250');
 h.ids.format.value='pdf';await h.ids.format.emit('change');await waitFor(()=>h.ids['result-count'].textContent==='100 / 250');
 h.ids.root.value='2';await h.ids.root.emit('change');await waitFor(()=>h.ids['result-count'].textContent==='0 / 0');
 assert.equal(h.ids.results.children.length,0);assert.equal(h.ids['result-more'].hidden,true);
 h.ids.format.value='all';await h.ids.format.emit('change');await waitFor(()=>h.ids['result-count'].textContent==='1 / 1');
 assert.equal(h.ids.results.children.length,1);assert.equal(h.ids.results.children[0].children[0].textContent,'B');
});
test('large file-match results expand within the shared child budget without body reads',async()=>{
 const h=await harness();let reads=0;
 const files=Array.from({length:1205},(_,i)=>{const f=file('Root/folder'+String(i).padStart(4,'0')+'/needle.txt'),slice=f.slice;f.slice=(...args)=>{reads++;return slice(...args);};return f;});
 await h.pick(files);reads=0;await h.query('needle');
 await waitFor(()=>h.ids['result-count'].textContent==='100 / 1205'&&h.buttons().length===100);
 assert.equal(h.ids.results.children.length,100);
 await h.ids['result-more'].click();await h.ids['result-more'].click();
 await waitFor(()=>h.ids['result-count'].textContent==='300 / 1205'&&h.buttons().length===300);
 assert.equal(reads,0);
});

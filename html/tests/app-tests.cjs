/* Exercise the real app/search/scanner in a small DOM/storage harness.
 * Handles and storage are simulated; this is not native permission/Edge evidence. */
"use strict";
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const Search = require("../search.js");
const FS = require("../filesystem.js");
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a; reject=b;}); return {promise,resolve,reject}; };
class Element {
  constructor(tag = "div", text = "") { this.isConnected = true; this.tag = tag; this.children = []; this.text = text; this.hidden = false; this.style = {}; this.value = ""; this.attrs = {}; this.className = ""; this.classList = { add: () => {}, remove: () => {} }; }
  set textContent(v) { this.text = v; this.children = []; }
  get textContent() { return this.text + this.children.map(c => c.textContent).join(""); }
  append(...items) { for (const item of items) { this.children = this.children.filter(c => c !== item); this.children.push(item); } }
  replaceChildren(...items) { this.text = ""; this.children = items; }
  setAttribute(k,v) { this.attrs[k] = v; }
  querySelectorAll() { return []; }
}
async function until(fn) {
  for (let i=0;i<200;i++) { if (fn()) return; await new Promise(r => setTimeout(r, 2)); }
  throw Error("Timed out waiting for app state");
}
function fixture(id) {
  const gate = deferred();
  const state = {permission:"granted", scans:0, requests:0, gate, files:["new.txt"], error:null};
  const handle = {name:id, async queryPermission() { if (state.permissionGate) await state.permissionGate.promise; if (state.permission instanceof Error) throw state.permission; return state.permission; },
    async requestPermission() {state.requests++; return state.permission = "granted";},
    async isSameEntry(other) { return other === handle; },
    async *entries() { state.scans++; await gate.promise; for(const name of state.files) yield [name,{kind:"file"}]; if(state.error) throw state.error; }};
  return {id,displayName:id,directoryName:id,handle,state};
}
const snap = (id, names=["old.txt"]) => ({folders:[{path:"",parent:null,name:id,depth:0}],files:names.map(name=>({name,path:name,parent:"",depth:1}))});
async function app(roots, options={}) {
  const nodes = new Map(), $ = id => {if(!nodes.has(id)) nodes.set(id,new Element());return nodes.get(id);};
  $("progress-wrap").hidden = true;
  const stored = new Map(roots.map(r=>[r.id,snap(r.id)]));
  if(options.snapshot) stored.set(roots[0].id, options.snapshot);
  if(options.empty) stored.clear();
  const state = {commits:0, reads:0, failSave:false, settings:{query:"txt",rootId:roots[0].id,expanded:[],selected:{},...options.ui},readGate:options.readGate};
  const db = {async roots(){return roots;}, async get(store,id){ if(store==="settings") return state.settings; state.reads++; if(state.readGate) await state.readGate.promise; return stored.get(id);},
    async put(store,id,value){if(store==="settings") state.settings=structuredClone(value);},
    async commit(root,value){state.commits++; if(state.failSave) throw new DOMException("Full", "QuotaExceededError"); stored.set(root.id,value);},
    async remove(id){stored.delete(id);}};
  const themeButton = new Element("button", "Dark Mode");
  const context = {document:{getElementById:$,createElement:tag=>new Element(tag),createTextNode:t=>new Element("text",t),querySelectorAll:()=>[themeButton],documentElement:{dataset:{}}},
    FolderSearch:options.search || Search,FolderFS:options.fileAt ? {...FS, fileAt:options.fileAt} : FS,FolderStore:{open:async()=>db},Option:class extends Element {constructor(t,v){super("option",t);this.value=v;}},
    URL,AbortController,DOMException,crypto:require("node:crypto").webcrypto,setTimeout,clearTimeout,confirm:()=>true};
  context.window={indexedDB:{},isSecureContext:true,showDirectoryPicker:async()=>roots[0].handle,addEventListener:()=>{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../app.js"),"utf8"),context);
  const submit = async text => {$("query").value=text;$("search-form").onsubmit({preventDefault(){}}); await new Promise(r=>setTimeout(r,5));};
  const action = label => {const find = n => n.tag==="button"&&n.textContent===label ? n : n.children.map(find).find(Boolean);const b=find($("roots")); assert(b, label); return b.onclick();};
  return {$,stored,state,submit,action,themeButton,document:context.document,async switch(id){$("root").value=id;$("root").onchange();await new Promise(r=>setTimeout(r,5));}};
}
let count=0;
async function test(name,fn){await fn();console.log("PASS "+name);count++;}
(async()=>{
  await test("cache first; automatic additions/deletions; latest query and expansion retained; once per session",async()=>{
    const a=fixture("A"),x=await app([a]);
    await until(()=>a.state.scans===1);
    assert.match(x.$("results").textContent,/A/); assert.equal(x.state.commits,0);
    assert.equal(x.$("progress-wrap").hidden,true);assert.equal(x.$("root").disabled,false);
    await x.submit("new");assert.equal(x.$("results").children.length,0);
    a.state.gate.resolve();await until(()=>x.state.commits===1&&x.$("results").children.length===1);
    assert.deepEqual(x.stored.get("A").files.map(f=>f.name),["new.txt"]);
    x.$("results").children[0].children[0].children[0].onclick();
    await x.action("Reload");assert.equal(a.state.scans,2);
    assert.equal(x.$("results").children[0].children[1].hidden,true);
    assert.equal(x.$("query").value,"new");
    await x.submit("old");assert.equal(x.$("results").children.length,0);assert.equal(a.state.scans,2);assert.equal(a.state.requests,0);
  });
  for(const permission of ["prompt","denied",new DOMException("Policy", "SecurityError")]) await test("no cached flash or automatic prompt: "+permission,async()=>{
    const a=fixture("A");a.state.permission=permission;a.state.permissionGate=deferred();const x=await app([a]);
    await x.submit("old");assert.equal(x.$("results").children.length,0);assert.equal(x.state.reads,0);
    a.state.permissionGate.resolve();await until(()=>x.$("meta").textContent.includes("Read access"));
    assert.equal(x.state.reads,0);assert.equal(a.state.scans,0);assert.equal(a.state.requests,0);assert(x.stored.has("A"));
    if(typeof permission==="string") {await x.action("Allow access");await until(()=>a.state.scans===1);assert.match(x.$("results").textContent,/A/);a.state.gate.resolve();await until(()=>x.state.commits===1);}
  });
  await test("switch during scans; repeated search; background A cannot replace B; no repeated automatic scan",async()=>{
    const a=fixture("A"),b=fixture("B"),x=await app([a,b]);await until(()=>a.state.scans===1);
    await x.switch("B");await until(()=>b.state.scans===1);await x.submit("old");await x.submit("txt");
    a.state.gate.resolve();await until(()=>x.state.commits===1);assert.match(x.$("results").textContent,/B/);assert.doesNotMatch(x.$("results").textContent,/A/);
    b.state.gate.resolve();await until(()=>x.state.commits===2);await x.switch("A");assert.equal(a.state.scans,1);assert.match(x.$("results").textContent,/A/);
  });
  for(const name of ["NotAllowedError","SecurityError","AbortError","NotReadableError","QuotaExceededError"]) await test("retain old DB on "+name,async()=>{
    const a=fixture("A"),x=await app([a]);await until(()=>a.state.scans===1);const old=x.stored.get("A");
    if(name==="QuotaExceededError") x.state.failSave=true;else a.state.error=new DOMException("Failure",name);
    a.state.gate.resolve();await until(()=>x.$("notice").textContent.includes("kept")||x.$("meta").textContent.includes("Read access"));
    assert.equal(x.stored.get("A"),old);
    if(["NotAllowedError","SecurityError"].includes(name)){assert.equal(x.$("results").children.length,0);await x.submit("old");assert.equal(x.$("results").children.length,0);}else assert.equal(x.$("results").children.length,1);
    assert.equal(a.state.requests,0);assert.equal(a.state.scans,1);
  });
  await test("permission expires during scan without enumeration error",async()=>{
    const a=fixture("A"),x=await app([a]);await until(()=>a.state.scans===1);a.state.permission="prompt";a.state.gate.resolve();
    await until(()=>x.$("meta").textContent.includes("Read access"));assert.equal(x.state.commits,0);assert.equal(x.$("results").children.length,0);
  });
  await test("manual Reload joins running scan, cancellation retains snapshot",async()=>{
    const a=fixture("A"),x=await app([a]);await until(()=>a.state.scans===1);const done=x.action("Reload");
    x.$("cancel").onclick();a.state.gate.resolve();await done;assert.equal(a.state.scans,1);assert.equal(x.state.commits,0);assert.equal(x.stored.get("A").files[0].name,"old.txt");
  });
  await test("delete during background scan cannot resurrect root or snapshot",async()=>{
    const a=fixture("A"),x=await app([a]);await until(()=>a.state.scans===1);const done=x.action("Delete");a.state.gate.resolve();await done;
    assert.equal(x.stored.has("A"),false);assert.equal(x.state.commits,0);assert.equal(x.$("results").children.length,0);
  });
  await test("no index: successful initial scan becomes searchable",async()=>{
    const a=fixture("A"),x=await app([a],{empty:true});await until(()=>a.state.scans===1);assert.equal(x.$("results").children.length,0);
    a.state.gate.resolve();await until(()=>x.$("results").children.length===1);assert.equal(x.state.commits,1);
  });
  await test("automatic update preserves expanded folder and selected path",async()=>{
    const a=fixture("A");a.state.files=["old.txt","new.txt"];
    const x=await app([a],{ui:{expanded:[""],selected:{"":"old.txt"}}});await until(()=>a.state.scans===1);
    assert.equal(x.$("results").children[0].children[1].hidden,false);
    a.state.gate.resolve();await until(()=>x.state.commits===1&&x.$("results").textContent.includes("new"));
    assert.equal(x.$("results").children[0].children[1].hidden,false);
    assert.match(x.$("preview").textContent,/Previously selected: old.txt/);
    assert.equal(x.state.settings.selected[""],"old.txt");
  });
  await test("Reselect recovers a denied child and permits an explicit retry",async()=>{
    const a=fixture("A"),x=await app([a]);await until(()=>a.state.scans===1);
    a.state.error=new DOMException("Child denied","NotAllowedError");a.state.gate.resolve();
    await until(()=>x.$("meta").textContent.includes("Read access"));a.state.error=null;
    await x.action("Reselect");await until(()=>x.state.commits===1);assert.equal(a.state.scans,2);
    await until(()=>x.$("results").children.length===1);assert.equal(a.state.requests,0);
  });
  await test("input during cache load cannot start a scan before cached results",async()=>{
    const a=fixture("A"),readGate=deferred(),x=await app([a],{readGate});
    await until(()=>x.state.reads===1);await x.submit("old");assert.equal(a.state.scans,0);
    readGate.resolve();await until(()=>a.state.scans===1);assert.equal(x.$("results").children.length,1);
    a.state.gate.resolve();await until(()=>x.state.commits===1);
  });
  await test("late permission check of previous root cannot replace current results",async()=>{
    const a=fixture("A"),b=fixture("B");a.state.permissionGate=deferred();const x=await app([a,b]);
    await until(()=>x.$("root").value==="A");await x.switch("B");await until(()=>b.state.scans===1);
    a.state.permission="denied";a.state.permissionGate.resolve();
    await x.submit("old");assert.match(x.$("results").textContent,/B/);assert.equal(a.state.scans,0);
    b.state.gate.resolve();await until(()=>x.state.commits===1);
  });

  const all = (node, predicate) => [...(predicate(node) ? [node] : []), ...node.children.flatMap(c => all(c,predicate))];
  const cls = (node, name) => all(node,n=>n.className.split(" ").includes(name));
  const toggle = x => cls(x.$("results"),"folder-toggle")[0];
  const detail = x => cls(x.$("results"),"detail")[0];
  const treeSnapshot = () => ({folders:[{path:"",parent:null,name:"A",depth:0},
    {path:"sub",parent:"",name:"A sub",depth:1},{path:"sub/deep",parent:"sub",name:"A deep",depth:2}],
    files:[{path:"sub/deep/A visible.txt",parent:"sub/deep",name:"A visible.txt",depth:3}]});
  await test("initial results and nonmatching subfolders expand; nested and top collapse survive same query",async()=>{
    const a=fixture("A"),x=await app([a],{snapshot:treeSnapshot(),ui:{query:"A"}});
    await until(()=>a.state.scans===1);
    assert.equal(detail(x).hidden,false);
    assert.match(x.$("results").textContent,/A visible.txt/);
    const nested=cls(x.$("results"),"subfolder-toggle")[0];
    assert.equal(nested.attrs["aria-expanded"],"true");nested.onclick();
    await x.submit("A");assert.equal(cls(x.$("results"),"subfolder-toggle")[0].attrs["aria-expanded"],"false");
    toggle(x).onclick();assert.equal(detail(x).hidden,true);
    await x.submit("A");assert.equal(detail(x).hidden,true);
    await x.submit("visible");assert.equal(detail(x).hidden,false);
    await x.submit("A");assert.equal(detail(x).hidden,false);
    assert.equal(cls(x.$("results"),"subfolder-toggle")[0].attrs["aria-expanded"],"true");
  });
  await test("closed result survives async commit; new results open; root switch resets closure",async()=>{
    const a=fixture("A"),b=fixture("B"),x=await app([a,b]);await until(()=>a.state.scans===1);
    toggle(x).onclick();assert.equal(detail(x).hidden,true);
    a.state.gate.resolve();await until(()=>x.state.commits===1);await x.submit("txt");
    assert.equal(detail(x).hidden,true);
    await x.switch("B");await until(()=>b.state.scans===1);assert.equal(detail(x).hidden,false);
    await x.switch("A");assert.equal(detail(x).hidden,false);
  });
  await test("IME blocks redraw during async refresh; committed query then expands",async()=>{
    const a=fixture("A"),x=await app([a]);await until(()=>a.state.scans===1);
    toggle(x).onclick();x.$("query").oncompositionstart();x.$("query").value="new";x.$("query").oninput();
    a.state.gate.resolve();await until(()=>x.state.commits===1);assert.equal(detail(x).hidden,true);
    x.$("query").oncompositionend();await until(()=>detail(x)?.hidden===false);
    assert.match(x.$("results").textContent,/new.txt/);
  });
  for (const [name,query,expected] of [
    ["Alpha beta.txt","alpha beta",["Alpha","beta"]],
    ["Alpha.txt","alpha OR absent",["Alpha"]],
    ["Alpha draft.txt","alpha -draft",["Alpha"]],
    ["Alpha beta.txt",'"alpha beta"',["Alpha beta"]],
    ["banana.txt","ana OR nan",["anana"]],
    ["abcd.txt","ab OR cd",["abcd"]],
    ["日本語資料.txt","日本語",["日本語"]],
    ["Straße ﬃ Σς 𐐀.txt","ss OR ffi OR σ OR 𐐨",["ß","ﬃ","Σς","𐐀"]],
    ["İ.txt","i",["İ"]],
    ["<img onerror=alert(1)>.txt","img",["img"]],
    ["draft.txt","-absent",[]],
  ]) await test("safe contiguous highlight: "+name+" / "+query,async()=>{
    const a=fixture("A"), x=await app([a],{snapshot:snap(Search.parse(query).groups[0]?.join(" ") || "A",[name]),ui:{query}});
    await until(()=>a.state.scans===1);
    const target=cls(x.$("results"),"item").find(n=>n.textContent===name);
    if (!Search.parse(query).groups.length || !Search.matches(name, Search.parse(query))) {
      assert.equal(target, undefined);
      return;
    }
    assert(target,query);
    assert.deepEqual(all(target,n=>n.tag==="mark").map(n=>n.textContent),expected);
    assert.equal(all(target,n=>n.tag==="img").length,0);
  });
  await test("bounded initial DOM for 25000 files / 1500 levels; more and manual deep expansion",async()=>{
    const a=fixture("A"),snapshot=snap("A",Array.from({length:25000},(_,i)=>`file${i}.txt`));
    let parent="";
    for(let i=0;i<1500;i++){const path=parent+"/d";snapshot.folders.push({name:"d",path,parent,depth:i+1});parent=path;}
    const x=await app([a],{snapshot,ui:{query:"txt OR d"}});await until(()=>a.state.scans===1);
    assert(cls(x.$("results"),"item").length<=500);
    const nested=cls(x.$("results"),"subfolder-toggle");assert(nested.length>=4);
    assert.equal(nested[3].attrs["aria-expanded"],"false");nested[3].onclick();
    assert(cls(x.$("results"),"subfolder-toggle").length>nested.length);
    const before=cls(x.$("results"),"item").length;
    cls(x.$("results"),"more-items").find(n=>!n.hidden).onclick();
    assert(cls(x.$("results"),"item").length>before);
    assert(cls(x.$("results"),"item").length<=before+100);
  });
  await test("permission revoked while building child index hides results without auto prompt",async()=>{
    const a=fixture("A");let yields=0;
    const x=await app([a],{snapshot:snap("A",Array.from({length:600},(_,i)=>`file${i}.txt`)),
      ui:{query:"A"},search:{...Search,pause:async()=>{yields++;a.state.permission="denied";}}});
    await until(()=>x.$("meta").textContent.includes("Read access"));
    assert(yields>0);assert.equal(x.$("results").children.length,0);
    assert.equal(a.state.scans,0);assert.equal(a.state.requests,0);assert(x.stored.has("A"));
  });
  await test("expanded nested file buttons still select PDF/image/text previews; collapse preserves common pane",async()=>{
    const a=fixture("A"),snapshot=treeSnapshot();
    snapshot.files=["sample.pdf","sample.png","sample.txt"].map(name=>({name,path:"sub/deep/"+name,parent:"sub/deep",depth:3}));
    let reads=0;
    const x=await app([a],{snapshot,ui:{query:"sample OR A"},fileAt:async(handle,path)=>{
      reads++;const blob=new Blob(["hello"],{type:"text/plain"});blob.name=path.split("/").at(-1);return blob;
    }});await until(()=>a.state.scans===1);assert.equal(reads,0);
    for(const [ext,tag] of [["pdf","iframe"],["png","img"],["txt","pre"]]) {
      cls(x.$("results"),"item").find(n=>n.textContent===`sample.${ext}`).onclick();
      await until(()=>all(x.$("preview"),n=>n.tag===tag).length===1);
      assert.equal(x.state.settings.selected[""],`sub/deep/sample.${ext}`);
    }
    assert.equal(reads,3);toggle(x).onclick();
    assert.equal(all(x.$("preview"),n=>n.tag==="pre").length,1);
    assert.equal(a.state.requests,0);
  });

  await test("folder hits hide unrelated files and branches but retain deep matching descendants", async()=>{
    const a=fixture("A"), snapshot=treeSnapshot();
    snapshot.folders.push({name:"xyz",path:"xyz",parent:"",depth:1});
    snapshot.files.push({name:"xyz.jpg",path:"xyz.jpg",parent:"",depth:1});
    const x=await app([a],{snapshot,ui:{query:"A"}});await until(()=>a.state.scans===1);
    assert.match(x.$("results").textContent,/A visible.txt/);
    assert.doesNotMatch(x.$("results").textContent,/xyz/);
    await x.submit("visible");
    assert.match(x.$("results").textContent,/A visible.txt/);
  });
  await test("one pane accepts different folders; slow previous request cannot overwrite; root switch clears", async()=>{
    const a=fixture("A"), b=fixture("B"), slow=deferred();
    const snapshot={folders:[{name:"A",path:"",parent:null,depth:0},{name:"sub",path:"sub",parent:"",depth:1}],
      files:[{name:"first.txt",path:"first.txt",parent:""},{name:"second.txt",path:"sub/second.txt",parent:"sub"}]};
    const blob=name=>Object.assign(new Blob([name]),{name});
    const x=await app([a,b],{snapshot,ui:{query:"txt"},fileAt:async(_,path)=>path==="first.txt"?slow.promise:blob("second.txt")});
    await until(()=>a.state.scans===1);
    cls(x.$("results"),"item").find(n=>n.textContent==="first.txt").onclick();
    cls(x.$("results"),"item").find(n=>n.textContent==="second.txt").onclick();
    await until(()=>x.$("preview").textContent.includes("second.txt"));
    slow.resolve(blob("first.txt"));await new Promise(r=>setTimeout(r,10));
    assert.doesNotMatch(x.$("preview").textContent,/first.txt/);
    assert.equal(cls(x.$("results"),"preview").length,0);
    await x.switch("B");assert.doesNotMatch(x.$("preview").textContent,/second.txt/);
  });
  await test("permission loss clears common preview and results; stale read cannot restore media", async()=>{
    const a=fixture("A"),slow=deferred(),x=await app([a],{fileAt:()=>slow.promise});await until(()=>a.state.scans===1);
    cls(x.$("results"),"item")[0].onclick();await new Promise(r=>setTimeout(r,5));
    a.state.permission="denied";await x.submit("txt");
    slow.resolve(Object.assign(new Blob(["stale"]),{name:"stale.pdf"}));await new Promise(r=>setTimeout(r,10));
    assert.equal(x.$("results").children.length,0);
    assert.equal(all(x.$("preview"),n=>n.tag==="iframe").length,0);
    assert.doesNotMatch(x.$("preview").textContent,/stale/);
  });
  await test("Dark Mode reuses persisted ui.theme and updates immediately in both views", async()=>{
    const a=fixture("A"),x=await app([a],{ui:{theme:"dark"}});await until(()=>a.state.scans===1);
    assert.equal(x.document.documentElement.dataset.theme,"dark");
    assert.equal(x.themeButton.attrs["aria-pressed"],"true");
    x.themeButton.onclick();assert.equal(x.document.documentElement.dataset.theme,"light");
    assert.equal(x.state.settings.theme,"light");
    x.themeButton.onclick();assert.equal(x.state.settings.theme,"dark");
    const y=await app([fixture("A")],{ui:x.state.settings});await until(()=>y.$("root").value==="A");
    assert.equal(y.document.documentElement.dataset.theme,"dark");
  });
  console.log(`${count} app integration tests passed (simulated DOM/handles/storage)`);
})().catch(e=>{console.error(e);process.exitCode=1;});

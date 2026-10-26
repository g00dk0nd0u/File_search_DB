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
  constructor(tag = "div", text = "") { this.tag = tag; this.children = []; this.text = text; this.hidden = false; this.style = {}; this.value = ""; this.attrs = {}; this.className = ""; this.classList = { add: () => {}, remove: () => {} }; }
  set textContent(v) { this.text = v; this.children = []; }
  get textContent() { return this.text + this.children.map(c => c.textContent).join(""); }
  append(...items) { this.children.push(...items); }
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
  if(options.empty) stored.clear();
  const state = {commits:0, reads:0, failSave:false, settings:{query:"txt",rootId:roots[0].id,expanded:[],selected:{},...options.ui},readGate:options.readGate};
  const db = {async roots(){return roots;}, async get(store,id){ if(store==="settings") return state.settings; state.reads++; if(state.readGate) await state.readGate.promise; return stored.get(id);},
    async put(store,id,value){if(store==="settings") state.settings=structuredClone(value);},
    async commit(root,value){state.commits++; if(state.failSave) throw new DOMException("Full", "QuotaExceededError"); stored.set(root.id,value);},
    async remove(id){stored.delete(id);}};
  const context = {document:{getElementById:$,createElement:tag=>new Element(tag),createTextNode:t=>new Element("text",t),querySelectorAll:()=>[],documentElement:{dataset:{}}},
    FolderSearch:Search,FolderFS:FS,FolderStore:{open:async()=>db},Option:class extends Element {constructor(t,v){super("option",t);this.value=v;}},
    URL,AbortController,DOMException,crypto:require("node:crypto").webcrypto,setTimeout,clearTimeout,confirm:()=>true};
  context.window={indexedDB:{},isSecureContext:true,showDirectoryPicker:async()=>roots[0].handle,addEventListener:()=>{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../app.js"),"utf8"),context);
  const submit = async text => {$("query").value=text;$("search-form").onsubmit({preventDefault(){}}); await new Promise(r=>setTimeout(r,5));};
  const action = label => {const find = n => n.tag==="button"&&n.textContent===label ? n : n.children.map(find).find(Boolean);const b=find($("roots")); assert(b, label); return b.onclick();};
  return {$,stored,state,submit,action,async switch(id){$("root").value=id;$("root").onchange();await new Promise(r=>setTimeout(r,5));}};
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
    assert.equal(x.$("results").children[0].children[1].hidden,false);
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
    a.state.gate.resolve();await until(()=>x.state.commits===1);assert.match(x.$("meta").textContent,/B/);assert.doesNotMatch(x.$("results").textContent,/A/);
    b.state.gate.resolve();await until(()=>x.state.commits===2);await x.switch("A");assert.equal(a.state.scans,1);assert.match(x.$("meta").textContent,/A/);
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
    assert.match(x.$("results").textContent,/Previously selected: old.txt/);
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
    await x.submit("old");assert.match(x.$("meta").textContent,/B/);assert.equal(a.state.scans,0);
    b.state.gate.resolve();await until(()=>x.state.commits===1);
  });
  console.log(`${count} app integration tests passed (simulated DOM/handles/storage)`);
})().catch(e=>{console.error(e);process.exitCode=1;});

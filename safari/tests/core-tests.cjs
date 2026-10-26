"use strict";
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {build, text, Model, Storage} = require('../core.js');
const S = require('../search.js');
function file(path, body = '日本語') {
  const blob = new Blob([body]);
  return {name:path.split('/').at(-1), webkitRelativePath:path, size:blob.size, lastModified:1,
    slice: (...args) => blob.slice(...args)};
}
const deferred = () => { let resolve; const promise = new Promise(r => resolve=r); return {resolve,promise}; };
const tick = () => new Promise(r => setImmediate(r));
class Memory {
  constructor() { this.records = new Map(); this.writes = 0; }
  async all() { return structuredClone([...this.records.values()]); }
  async put(record, current, signal) {
    if (this.wait) await this.wait.promise;
    if (!current() || signal.aborted) throw new DOMException('cancel','AbortError');
    if (this.fail) throw Error('QuotaExceededError');
    this.records.set(record.id, structuredClone(record)); this.writes++;
  }
  async remove(id, current, signal) { if (current() && !signal.aborted) this.records.delete(id); }
}
const select = (model, id, files) => model.select(id, files, model.begin(id));
test('Japanese nested paths derive folders, exclude hidden names and preserve File map', async () => {
  const f=file('対象/日本語/深い階層/資料.txt');
  const a=await build([f,file('対象/.hidden.txt'),file('対象/.hidden/secret.txt')]);
  assert.equal(a.snapshot.folders.length,3);
  assert.equal(a.snapshot.files[0].parent,'日本語/深い階層');
  assert.equal(a.handles.get('日本語/深い階層/資料.txt'),f);
  assert.equal(a.snapshot.files.length,1);
});
test('AND OR exclusion phrase aggregate by parent', async () => {
  const {snapshot}=await build(['A/Other/alpha beta.txt','A/Other/alpha draft beta.txt','A/日本語/gamma delta.txt'].map(p=>file(p)));
  for (const [q, paths, count] of [['alpha beta',['Other'],2],['alpha OR gamma',['Other','日本語'],3],['alpha -draft',['Other'],1],['"gamma delta"',['日本語'],1]]) {
    const rows=await S.search(snapshot,q); assert.deepEqual(rows.map(r=>r.path),paths);
    assert.equal(rows.reduce((n,r)=>n+r.fileMatchCount,0),count);
  }
});
test('empty selection is rejected', async()=>assert.rejects(build([])));
test('invalid mixed duplicate and colliding relative paths are rejected', async()=> {
  for (const paths of [['A/../bad'],['A/a','B/b'],['A/a','A/a'],['A/a','A/a/b']])
    await assert.rejects(build(paths.map(p=>file(p))));
});
test('a failed scan never exposes partial results or changes saved index', async()=> {
  const storage=new Memory(), m=new Model(storage);
  await select(m,'a',[file('A/old.txt')]);
  const old=structuredClone(storage.records.get('a'));
  const bad=file('A/bad.txt'); bad.slice=()=>({arrayBuffer:async()=>{throw Error('NotReadableError');}});
  await assert.rejects(select(m,'a',[file('A/new.txt'),bad]));
  assert.equal(m.sessions.has('a'),false); assert.deepEqual(storage.records.get('a'),old);
});
test('save-time read failure preserves previous committed record', async()=> {
  const storage=new Memory(), m=new Model(storage); await select(m,'a',[file('A/old.txt')]);
  const f=file('A/new.txt'), slice=f.slice; let n=0;
  f.slice=(...args)=>{if (++n===2) throw Error('NotReadableError'); return slice(...args);};
  await assert.rejects(select(m,'a',[f])); assert.equal(storage.writes,1); assert.equal(m.sessions.size,0);
});
test('reselection replaces additions and deletions only after complete commit', async()=> {
  const storage=new Memory(), m=new Model(storage); await select(m,'a',[file('A/old.txt')]);
  await select(m,'a',[file('A/new.txt'),file('A/deep/newer.txt')]);
  assert.deepEqual(m.sessions.get('a').snapshot.files.map(f=>f.path),['new.txt','deep/newer.txt']);
  assert.deepEqual(storage.records.get('a').snapshot,m.sessions.get('a').snapshot);
});
test('two same-named roots remain independent; switching uses only selected session', async()=> {
  const storage=new Memory(), m=new Model(storage);
  await select(m,'one',[file('Same/one.txt')]); await select(m,'two',[file('Same/two.txt')]);
  m.switch('one'); assert.equal((await S.search(m.sessions.get(m.activeId).snapshot,'one')).length,1);
  assert.equal((await S.search(m.sessions.get(m.activeId).snapshot,'two')).length,0);
  assert.equal(m.roots.size,2);
});
test('new process loads registration but never restores file access or results', async()=> {
  const storage=new Memory(), m=new Model(storage); await select(m,'a',[file('A/old.txt')]);
  const restart=new Model(storage); await restart.load();
  assert.equal(restart.roots.size,1); assert.equal(restart.sessions.size,0);
});
test('late selection cannot replace newer root or record', async()=> {
  const storage=new Memory(), m=new Model(storage), gate=deferred(), f=file('A/slow.txt'), slice=f.slice;
  f.slice=(...args)=>({arrayBuffer:async()=>{await gate.promise;return slice(...args).arrayBuffer();}});
  const slow=select(m,'a',[f]); const rejected=assert.rejects(slow,{name:'AbortError'});
  await select(m,'b',[file('B/new.txt')]); gate.resolve(); await rejected;
  assert.equal(storage.records.has('a'),false); assert.equal(m.activeId,'b');
});
test('root switch during save suppresses stale commit and session', async()=> {
  const storage=new Memory(), m=new Model(storage); await select(m,'a',[file('A/old.txt')]);
  storage.wait=deferred(); const pending=select(m,'a',[file('A/new.txt')]);
  const rejected=assert.rejects(pending,{name:'AbortError'}); await tick(); m.switch('b'); storage.wait.resolve(); await rejected;
  assert.equal(storage.writes,1); assert.equal(m.sessions.has('a'),false);
});
test('quota failure preserves database and hides previous session', async()=> {
  const storage=new Memory(), m=new Model(storage); await select(m,'a',[file('A/old.txt')]); storage.fail=true;
  await assert.rejects(select(m,'a',[file('A/new.txt')])); assert.equal(storage.writes,1); assert.equal(m.sessions.size,0);
});
test('rename persists without changing identity; remove deletes registration only', async()=> {
  const storage=new Memory(), m=new Model(storage); await select(m,'a',[file('A/file.txt')]);
  await m.edit('a',' 表示名 '); assert.equal(m.roots.get('a').displayName,'表示名');
  await assert.rejects(m.edit('a',' ')); assert.equal(m.sessions.size,1);
  await m.remove('a'); assert.equal(m.roots.size,0); assert.equal(m.sessions.size,0); assert.equal(storage.records.size,0);
});
test('explicit invalidation hides session but keeps persisted data', async()=> {
  const storage=new Memory(), m=new Model(storage); await select(m,'a',[file('A/file.txt')]); m.invalidate('a');
  assert.equal(m.sessions.size,0); assert.equal(storage.records.size,1);
});
test('UTF-8 truncated Japanese prefix is not misclassified as Shift-JIS', async()=> {
  const r=await text(new Blob(['a'.repeat(16383)+'あ'])); assert.equal(r.text,'a'.repeat(16383)); assert.equal(r.truncated,true);
});
test('Shift-JIS and binary text preview', async()=> {
  assert.equal((await text(new Blob([Uint8Array.from([0x93,0xfa,0x96,0x7b,0x8c,0xea])]))).text,'日本語');
  assert.ok((await text(new Blob([Uint8Array.from([0,1])]))).error);
});
test('large repeated searches yield, cancel and aggregate', async()=> {
  const snapshot={folders:[{name:'Root',path:'',depth:0,parent:null}],files:Array.from({length:25000},(_,i)=>({name:'item'+i,path:'item'+i,parent:''}))};
  let cancelled=false; setTimeout(()=>cancelled=true,0);
  assert.deepEqual(await S.search(snapshot,'item',100,()=>cancelled),[]);
  for (const q of ['item','item -absent']) assert.equal((await S.search(snapshot,q))[0].fileMatchCount,25000);
});
// The adapter is checked at open and transaction boundaries, independent of the model.
function databaseHarness() {
  const requests=[], txs=[]; let record='old';
  const db={close(){},transaction(){
    const tx={aborted:false,objectStore:()=>({put(value){tx.value=value;return {};}}),
      abort(){this.aborted=true;queueMicrotask(()=>this.onabort());},
      complete(){if(!this.aborted){record=this.value;this.oncomplete();}}};txs.push(tx);return tx;
  }};
  return {storage:new Storage({open(){const request={result:db};requests.push(request);return request;}}),
    requests,txs,get record(){return record;}};
}
test('IndexedDB late open rejects outdated operation without transaction', async()=> {
  const h=databaseHarness(); let current=true;
  const pending=h.storage.put({id:'a'},()=>current); const rejection=assert.rejects(pending,{name:'AbortError'});
  current=false;h.requests[0].onsuccess();await rejection;assert.equal(h.txs.length,0);assert.equal(h.record,'old');
});
test('IndexedDB abort preserves previous record, success resolves only on tx complete', async()=> {
  const h=databaseHarness(), controller=new AbortController();
  const pending=h.storage.put({id:'a'},()=>true,controller.signal), rejection=assert.rejects(pending,{name:'AbortError'});
  h.requests[0].onsuccess(); controller.abort(); h.txs[0].complete(); await rejection;assert.equal(h.record,'old');
  let resolved=false;
  const success=h.storage.put({id:'b'},()=>true).then(()=>resolved=true);h.requests[1].onsuccess();
  await tick();assert.equal(resolved,false);h.txs[1].complete();await success;assert.equal(h.record.id,'b');
});
test('IndexedDB blocked open never starts a late write',async()=> {
  const h=databaseHarness(), pending=h.storage.put({id:'a'},()=>true), rejection=assert.rejects(pending);
  h.requests[0].onblocked();h.requests[0].onsuccess();await rejection;assert.equal(h.txs.length,0);
});

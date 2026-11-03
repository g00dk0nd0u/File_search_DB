/* Shared behavioural contract for both search engines. */
'use strict';
const assert = require('node:assert/strict');
module.exports = async function searchContract(S) {
  const now = 2000000000000, day = 86400000;
  const folder = (path, name = path.split('/').at(-1)) => ({path, name, parent:path ? path.split('/').slice(0,-1).join('/') : null, depth:path ? path.split('/').length : 0});
  const file = (parent, name, lastModified=now) => ({parent,name,path:parent ? `${parent}/${name}` : name,lastModified});
  const snapshot = {
    folders:[folder('', 'Root'), folder('one','alpha only'), folder('one/deep'), folder('one/empty'),
      folder('one/old'), folder('both','alpha both'), folder('both/bridge'), folder('both/bridge/deep'),
      folder('noeligible','alpha no eligible')],
    files:[file('one/deep','report.pdf'), file('one/deep','alpha.txt'), file('one/old','old.pdf',now-8*day),
      file('both/bridge/deep','alpha.pdf'), file('both/bridge/deep','other.pdf'),
      file('noeligible','old.pdf',now-8*day)]
  };
  const all = {days:'all',format:'all',now};
  const filtered = {days:'7',format:'pdf',now};
  const rows = await S.search(snapshot,'alpha',()=>false,all);
  assert.equal(rows.find(r=>r.path==='one').showAll,false); // alpha.txt is in a descendant
  assert.equal(rows.find(r=>r.path==='both').showAll,false); // matching file two levels below
  assert.equal(rows.find(r=>r.path==='noeligible').showAll,true);
  const limited = await S.search(snapshot,'alpha',()=>false,filtered);
  assert.equal(limited.find(r=>r.path==='one').showAll,true); // matching TXT was filtered out
  assert.equal(limited.find(r=>r.path==='both').showAll,false);
  assert.equal(limited.some(r=>r.path==='noeligible'),false);
  const display = await S.visibility(snapshot,'alpha',filtered);
  const index = await S.childIndex(snapshot);
  const lists = await S.displayIndex(index,display);
  assert.deepEqual(lists.all.get('one').map(i=>i.path),['one/deep']);
  assert.deepEqual(lists.all.get('one/deep').map(i=>i.name),['report.pdf']);
  assert.deepEqual(lists.matched.get('both/bridge/deep').map(i=>i.name),['alpha.pdf']);
  assert.equal(lists.matched.has('one'),false);
  assert.equal(S.containsFile(limited,display,'one/deep/report.pdf'),true);
  assert.equal(S.containsFile(limited,display,'both/bridge/deep/other.pdf'),false);
  const plainDisplay = await S.visibility(snapshot,'alpha',all);
  const plainLists = await S.displayIndex(index,plainDisplay);
  assert(plainLists.all.get('one').some(i=>i.path==='one/empty'));
  for (const [q, expected] of [['alpha beta',true],['alpha OR gamma -draft',true],['"alpha beta"',true],['alpha -draft',false]]) {
    const candidate = q === 'alpha -draft' ? 'alpha draft.txt' : 'alpha beta.txt';
    assert.equal(S.matches(candidate,S.parse(q)),expected);
  }
  for (const total of [100,101,250,1205]) {
    const sample={folders:[folder('','Root')],files:[]};
    for(let i=total-1;i>=0;i--) {
      const path='hit'+String(i).padStart(4,'0');
      sample.folders.push(folder(path)); sample.files.push(file(path,'report.txt'));
    }
    const found=await S.search(sample,'hit');
    assert.equal(found.length,total);
    assert.deepEqual(found.map(r=>r.path),Array.from({length:total},(_,i)=>'hit'+String(i).padStart(4,'0')));
    assert(found.every(r=>r.showAll));
    assert.equal(new Set(found.map(r=>r.path)).size,total);
  }
  const many = {folders:[folder('','Root')],files:Array.from({length:5000},(_,i)=>file('',`item${i}.txt`))};
  let cancelled = false, yielded = false;
  setTimeout(()=>{yielded=true;cancelled=true;},0);
  assert.deepEqual(await S.search(many,'item',()=>cancelled),[]);
  assert(yielded);
};

/* Same immutable inputs and expectations for both platform search engines. */
const assert = require('node:assert/strict');
module.exports = async function filterContract(S) {
  const now = 2000000000000, day = 86400000;
  const folder = (path, name = path.split('/').at(-1)) => ({path, name, parent:path ? path.split('/').slice(0,-1).join('/') : null, depth:path ? path.split('/').length : 0});
  const file = (name, parent='', lastModified=now) => ({name, parent, path:parent ? parent+'/'+name : name, lastModified});
  const base = {folders:[folder('', 'Root'), folder('deep'),folder('deep/nested'),folder('empty')], files:[]};
  assert.deepEqual(await S.search(base,''),[]);
  for (const days of [7,14,30,60,180]) {
    const snapshot = {...base,files:[file('boundary.PDF','deep/nested',now-days*day),file('old.pdf','',now-days*day-1),file('future.pdf','',now+1),file('unknown.pdf','',undefined)]};
    delete snapshot.files[3].lastModified;
    const options = {days:String(days),format:'all',now};
    assert.deepEqual((await S.search(snapshot,'',100,()=>false,options)).map(r=>r.path),['deep/nested']);
    assert.deepEqual([...(await S.visibility(snapshot,'',options)).visible].sort(),['','deep','deep/nested','deep/nested/boundary.PDF']);
    assert.equal(S.eligible(snapshot.files[1],options),false);
    assert.equal(S.eligible(snapshot.files[2],options),false);
    assert.equal(S.eligible(snapshot.files[3],options),false);
    assert.equal(S.eligible(snapshot.files[3],{days:'all'}),true);
  }
  const formats = {pdf:['pdf'],jpg:['jpg','jpeg'],png:['png'],excel:['xls','xlsx','xlsm'],powerpoint:['ppt','pptx','pptm'],word:['doc','docx','docm'],txt:['txt'],dwg:['dwg'],revit:['rvt'],sketchup:['skp'],grasshopper:['gh','ghx']};
  assert.deepEqual(S.formats,formats);
  const allFiles = Object.values(formats).flat().map(ext=>file('alpha beta.'+ext.toUpperCase(),'deep/nested'));
  allFiles.push(file('alpha draft.pdf','deep/nested'),file('other.bin',''),file('pdf',''));
  const snapshot = {...base,files:allFiles};
  for (const [format, extensions] of Object.entries(formats)) {
    const options = {days:'7',format,now};
    const result = await S.search(snapshot,'"alpha beta" -draft',100,()=>false,options);
    assert.equal(result.length,1); assert.equal(result[0].fileMatchCount,extensions.length);
    assert.deepEqual([... (await S.visibility(snapshot,'alpha beta',options)).files].sort(),extensions.map(ext=>'deep/nested/alpha beta.'+ext.toUpperCase()).sort());
    assert.equal((await S.search(snapshot,'',100,()=>false,options)).length,1);
    assert.equal((await S.search(snapshot,'no-match',100,()=>false,options)).length,0);
  }
  assert.equal((await S.visibility(snapshot,'-draft',{now,format:'all',days:'all'})).files.size,allFiles.length-1);
  assert.equal((await S.visibility(snapshot,'alpha OR other -draft',{now,format:'pdf'})).files.size,1);
  assert.equal((await S.search(snapshot,'',100,()=>false,{days:'all',format:'all'})).length,0);
  const many={folders:[folder('','Root')],files:[]};
  for(let i=0;i<230;i++) {const path='f'+String(i).padStart(3,'0');many.folders.push(folder(path));many.files.push(file('alpha.'+(i<120?'txt':'pdf'),path));}
  const rows=await S.search(many,'alpha',100,()=>false,{format:'pdf',days:'all',now});
  assert.equal(rows.length,100); assert.equal(rows[0].path,'f120');assert.equal(rows.at(-1).path,'f219');
  assert.deepEqual(await S.search(many,'alpha',100,()=>true,{format:'pdf',now}),[]);
};

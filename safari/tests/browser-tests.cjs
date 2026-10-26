/* Development-only Chromium UI coverage, NOT native Safari acceptance.
   npm Playwright is optional; set PLAYWRIGHT_MODULE to a preinstalled module.
   Run: node safari/tests/browser-tests.cjs (no server, no app dependency).
*/
'use strict';
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {pathToFileURL}=require('node:url');
const assert=require('node:assert/strict');
(async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'safari-ui-'));
  const root=path.join(temp,'対象'), other=path.join(temp,'別対象');
  await fs.mkdir(path.join(root,'日本語','深い階層'),{recursive:true}); await fs.mkdir(other);
  await fs.writeFile(path.join(root,'日本語','alpha beta.txt'),'日本語のテキスト <script>安全な文字列</script>');
  await fs.writeFile(path.join(root,'日本語','alpha draft beta.txt'),'draft');
  await fs.writeFile(path.join(root,'日本語','深い階層','gamma delta.txt'),'nested');
  await fs.writeFile(path.join(root,'日本語','sample.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jKfoAAAAASUVORK5CYII=','base64'));
  await fs.writeFile(path.join(other,'only-other.txt'),'other');
  const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:900}}), errors=[], remote=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(['error','warning'].includes(m.type()))errors.push(m.text());});
  page.on('request',r=>{if(/^https?:/.test(r.url()))remote.push(r.url());});
  const url=pathToFileURL(path.resolve(__dirname,'../index.html')).href;
  const cases=[];
  async function check(name,fn){await fn();cases.push(name);}
  async function textContains(locator,text){await locator.filter({hasText:text}).first().waitFor();}
  async function query(q){await page.locator('#query').fill(q);await page.locator('#search').click();}
  async function pick(button,dir){const chooser=page.waitForEvent('filechooser');await button.click();await (await chooser).setFiles(dir);await page.locator('#search-view').waitFor();await page.waitForFunction(()=>!document.getElementById('search').disabled);}
  try {
    await check('file URL, identity, startup has no persisted results',async()=>{
      await page.goto(url);await textContains(page.locator('#meta'),'Add Directory');
      assert.equal(page.url(),url); assert.match(await page.title(),/Folder Search/);
      assert.equal(await page.locator('#results > *').count(),0);
    });
    await check('register real fixture directory via input and commit real IndexedDB',async()=>{
      await page.locator('#settings-button').click();await pick(page.locator('#add'),root);
      assert.equal(await page.locator('#root option').count(),1);
    });
    await check('AND exclusion and phrase produce parent folders; expansion and safe Japanese text preview',async()=>{
      for(const q of ['alpha beta','alpha -draft','"alpha beta"']){await query(q);await textContains(page.locator('#meta'),'1 フォルダ');}
      await page.locator('#results > details > summary').click();
      await page.getByRole('button',{name:'alpha beta.txt',exact:true}).click();
      await textContains(page.locator('#preview pre'),'日本語のテキスト <script>安全な文字列</script>');
      assert.equal(await page.locator('#preview script').count(),0);
      await page.screenshot({path:'/tmp/safari-search-desktop.png',fullPage:true});
    });
    await check('OR finds two nested parents; expansion and selection survive typing',async()=>{
      await query('alpha OR gamma');await textContains(page.locator('#meta'),'2 フォルダ');
      assert.equal(await page.locator('#results > details[open]').count(),1);
      assert.equal(await page.getByRole('button',{name:'alpha beta.txt',exact:true}).getAttribute('aria-pressed'),'true');
    });
    await check('image preview loads a Blob URL',async()=>{
      await query('sample');await page.locator('#results > details > summary').click();
      await page.getByRole('button',{name:'sample.png',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('#preview img')?.naturalWidth===1);
    });
    await check('multiple registered roots switch without mixing files',async()=>{
      await page.locator('#settings-button').click();await pick(page.locator('#add'),other);
      await query('alpha');await textContains(page.locator('#meta'),'一致するフォルダはありません');
      await query('only-other');await textContains(page.locator('#meta'),'1 フォルダ');
      await page.locator('#root').selectOption({label:'対象'});await query('alpha');await textContains(page.locator('#meta'),'1 フォルダ');
    });
    await check('reselection replaces additions/deletions in saved and live index',async()=>{
      await fs.unlink(path.join(root,'日本語','alpha beta.txt'));
      await fs.writeFile(path.join(root,'日本語','added.txt'),'added');
      await pick(page.locator('#reselect'),root);
      await query('"alpha beta"');await textContains(page.locator('#meta'),'一致するフォルダはありません');
      await query('added');await textContains(page.locator('#meta'),'1 フォルダ');
    });
    await check('fast input and root switching cannot resurrect outdated search',async()=>{
      await page.locator('#query').fill('alpha');await page.locator('#root').selectOption({label:'別対象'});
      await page.locator('#query').fill('only-other');await page.locator('#search').click();
      await textContains(page.locator('#meta'),'1 フォルダ');
      assert.equal(await page.locator('#results > details > summary').innerText(),'別対象');
    });
    await check('read failure hides old results and preview, retaining IndexedDB',async()=>{
      await page.locator('#results > details > summary').click();
      await page.evaluate(()=>{File.prototype.slice=function(){throw new DOMException('test access lost','NotReadableError');};});
      await page.getByRole('button',{name:'only-other.txt',exact:true}).click();
      await textContains(page.locator('#meta'),'再選択');
      assert.equal(await page.locator('#results > *').count(),0);assert.equal(await page.locator('#preview > *').count(),0);
    });
    await check('reload keeps registrations, never exposes stored search results; mobile layout',async()=>{
      await page.reload();await textContains(page.locator('#meta'),'再選択');
      assert.equal(await page.locator('#root option').count(),2);
      await page.locator('#query').fill('added');await page.locator('#search-form').dispatchEvent('submit');
      assert.equal(await page.locator('#results > *').count(),0);assert.equal(await page.locator('#preview > *').count(),0);
      await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/safari-search-mobile.png',fullPage:true});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    });
    await check('no app errors or network requests',async()=>{assert.deepEqual(errors,[]);assert.deepEqual(remote,[]);});
    console.log(JSON.stringify({passed:cases.length,cases,url,engine:'Chromium; input automation, not native Safari chooser',screenshots:['/tmp/safari-search-desktop.png','/tmp/safari-search-mobile.png']},null,2));
  } finally {await browser.close();await fs.rm(temp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});

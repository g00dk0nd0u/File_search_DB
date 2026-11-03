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
  await fs.writeFile(path.join(root,'日本語','sample.pdf'),'%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
  await fs.writeFile(path.join(root,'日本語','長い名前'.repeat(20)+'.txt'),'long');
  await fs.mkdir(path.join(root,'保管専用','deep'),{recursive:true});
  await fs.writeFile(path.join(root,'保管専用','deep','資料.txt'),'other');
  for(let i=0;i<250;i++) {
    const dir=path.join(root,'ページ'+String(i).padStart(4,'0'));
    await fs.mkdir(dir); await fs.writeFile(path.join(dir,'別.txt'),'other');
  }
  const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:900}}), errors=[], remote=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(['error','warning'].includes(m.type()))errors.push(m.text());});
  page.on('request',r=>{if(/^https?:/.test(r.url()))remote.push(r.url());});
  const url=pathToFileURL(path.resolve(__dirname,'../index.html')).href;
  const cases=[];
  async function check(name,fn){await fn();cases.push(name);}
  async function textContains(locator,text){await locator.filter({hasText:text}).first().waitFor();}
  async function results(count){await page.waitForFunction(n=>document.querySelectorAll('#results > details').length===n,count);}
  async function query(q){await page.locator('#query').fill(q);await page.locator('#search').click();}
  async function pick(button,dir){const chooser=page.waitForEvent('filechooser');await button.click();await (await chooser).setFiles(dir);await page.locator('#search-view').waitFor();await page.waitForFunction(()=>!document.getElementById('search').disabled);}
  try {
    await check('file URL, identity, startup has no persisted results',async()=>{
      await page.goto(url);await textContains(page.locator('#meta'),'Add Directory');
      assert.equal(page.url(),url); assert.match(await page.title(),/Folder Search/);
      assert.equal(await page.locator('#results > *').count(),0);
      assert.equal(await page.locator('#root').getAttribute('aria-label'),'検索対象ルート');
      assert.equal(await page.locator('label[for=root], #reselect, .footer, #search-view .hint:not(#preview .hint)').count(),0);
    });
    await check('preview starts closed and results use full width',async()=>{
      assert.equal(await page.locator('#preview-panel').isVisible(),false);
      assert.equal(await page.evaluate(()=>document.querySelector('.workspace').firstElementChild===document.querySelector('aside')),true);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    });
    await check('Settings-only keyboard theme toggle survives reload without touching IndexedDB',async()=>{
      await page.locator('#settings-button').click();
      const button=page.getByRole('button',{name:'Dark Mode',exact:true});
      await button.focus();await page.keyboard.press('Space');
      assert.equal(await button.getAttribute('aria-pressed'),'true');
      assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
      await page.locator('#back').click();assert.equal(await button.isVisible(),false);
      assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
      await page.reload();await page.locator('#settings-button:not([disabled])').waitFor();
      assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
      await page.locator('#settings-button').click();await button.click();
      assert.equal(await page.locator('html').getAttribute('data-theme'),'light');await page.locator('#back').click();
    });
    await check('register real fixture directory via input and commit real IndexedDB',async()=>{
      await page.locator('#settings-button').click();await pick(page.locator('#add'),root);
      assert.equal(await page.locator('#root option').count(),1);
    });
    await check('AND exclusion and phrase produce parent folders; expansion and safe Japanese text preview',async()=>{
      for(const q of ['alpha beta','alpha -draft','"alpha beta"']){await query(q);await results(1);}
      assert.equal(await page.locator('#meta').innerText(),'');
      assert.equal(await page.locator('#results .path').count(),0);
      assert.equal(await page.locator('#results > details[open]').count(),1);
      assert.deepEqual(await page.getByRole('button',{name:'alpha beta.txt',exact:true}).locator('mark').allTextContents(),['alpha beta']);
      await page.getByRole('button',{name:'alpha beta.txt',exact:true}).click();
      await textContains(page.locator('#preview pre'),'日本語のテキスト <script>安全な文字列</script>');
      const layout=await page.evaluate(()=>{
        const preview=document.querySelector('aside'),results=document.querySelector('#results');
        const a=preview.getBoundingClientRect(),b=results.getBoundingClientRect();
        return {left:a.x<b.x,ratio:a.width/b.width,height:a.height,sticky:getComputedStyle(preview).position};
      });
      assert.equal(layout.left,true);assert.ok(Math.abs(layout.ratio-2)<.02);
      assert.ok(layout.height>=316);assert.equal(layout.sticky,'sticky');
      assert.equal(await page.locator('#preview script').count(),0);
      await page.screenshot({path:'/tmp/safari-search-desktop.png',fullPage:true});
    });
    await check('OR finds two nested parents; expansion and selection survive typing',async()=>{
      await query('alpha OR gamma');await results(2);
      assert.equal(await page.locator('#results > details[open]').count(),2);
      assert.equal(await page.getByRole('button',{name:'alpha beta.txt',exact:true}).getAttribute('aria-pressed'),'true');
    });
    await check('manual collapse survives redraw but resets for changed query',async()=>{
      const summary=page.locator('#results > details > summary').first();
      await summary.click();await page.waitForFunction(()=>!document.querySelector('#results > details').open);
      await query('alpha OR gamma');await results(2);
      assert.equal(await page.locator('#results > details[open]').count(),1);
      await query('alpha');await results(1);
      assert.equal(await page.locator('#results > details[open]').count(),1);
    });
    await check('image preview loads a Blob URL',async()=>{
      await query('sample');await results(1);
      await page.getByRole('button',{name:'sample.png',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('#preview img')?.naturalWidth===1);
    });
    await check('descendant match filters unrelated files while keeping deep path; long names wrap',async()=>{
      await query('日本語 OR gamma');await results(2);
      assert.equal(await page.getByRole('button',{name:'alpha beta.txt',exact:true}).count(),0);
      assert.ok(await page.getByRole('button',{name:'gamma delta.txt',exact:true}).count()>0);
      await query('長い名前');await results(1);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    });
    await check('name-only folder starts closed and results page in batches',async()=>{
      await query('保管専用');await results(1);
      assert.equal(await page.locator('#results > details').evaluate(e=>e.open),false);
      await page.locator('#results > details > summary').click();
      await page.getByRole('button',{name:'資料.txt',exact:true}).waitFor();
      await query('ページ');
      await page.waitForFunction(()=>document.querySelector('#result-count').textContent==='100 / 250');
      assert.equal(await page.locator('#results > details').count(),100);
      await page.locator('#result-more').click();
      assert.equal(await page.locator('#result-count').textContent(),'200 / 250');
      await page.locator('#result-more').click();
      assert.equal(await page.locator('#result-count').textContent(),'250 / 250');
      assert.equal(await page.locator('#results > details').count(),250);
      assert.equal(await page.locator('#result-more').isVisible(),false);
      const names=await page.locator('#results > details > summary').allTextContents();
      assert.equal(new Set(names).size,250);
    });
    await check('PDF frame uses Blob URL and viewport-bounded expanded height',async()=>{
      await query('sample.pdf');await results(1);await page.getByRole('button',{name:'sample.pdf',exact:true}).click();
      const frame=page.locator('#preview iframe');await frame.waitFor();
      assert.match(await frame.getAttribute('src'),/^blob:/);assert.equal(await frame.getAttribute('title'),'sample.pdf');
      const box=await frame.boundingBox();assert.ok(box.height>585&&box.height<=770);
      // Native PDF rendering still requires Mac Safari; this proves the frame only.
    });
    await check('dark selected preview and mobile preview-first flow have no page overflow',async()=>{
      await page.locator('#settings-button').click();await page.locator('#theme-toggle').click();await page.locator('#back').click();
      await query('sample');await results(1);await page.getByRole('button',{name:'sample.png',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('#preview img')?.naturalWidth===1);
      assert.equal(await page.getByRole('button',{name:'sample.png',exact:true}).getAttribute('aria-pressed'),'true');
      await page.screenshot({path:'/tmp/safari-search-dark.png',fullPage:true});
      await page.setViewportSize({width:390,height:844});
      const a=await page.locator('aside').boundingBox(),b=await page.locator('#results').boundingBox();
      assert.ok(a.y<b.y);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await page.screenshot({path:'/tmp/safari-search-mobile.png',fullPage:true});
      await page.setViewportSize({width:1440,height:900});
    });
    await check('multiple registered roots switch without mixing files',async()=>{
      await page.locator('#settings-button').click();await pick(page.locator('#add'),other);
      await query('alpha');await textContains(page.locator('#meta'),'一致するフォルダはありません');
      await query('only-other');await results(1);
      await page.locator('#root').selectOption({label:'対象'});await query('alpha');await results(1);
    });
    await check('reselection replaces additions/deletions in saved and live index',async()=>{
      await fs.unlink(path.join(root,'日本語','alpha beta.txt'));
      await fs.writeFile(path.join(root,'日本語','added.txt'),'added');
      const selectedIndex=await page.locator('#root').evaluate(select=>select.selectedIndex);
      await page.locator('#settings-button').click();
      await pick(page.locator('#roots tr').nth(selectedIndex).getByRole('button',{name:'再選択',exact:true}),root);
      await query('"alpha beta"');await textContains(page.locator('#meta'),'一致するフォルダはありません');
      await query('added');await results(1);
    });
    await check('fast input and root switching cannot resurrect outdated search',async()=>{
      await page.locator('#query').fill('alpha');await page.locator('#root').selectOption({label:'別対象'});
      await page.locator('#query').fill('only-other');await page.locator('#search').click();
      await results(1);
      assert.equal(await page.locator('#results > details > summary').innerText(),'別対象');
    });
    await check('read failure hides old results and preview, retaining IndexedDB',async()=>{
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

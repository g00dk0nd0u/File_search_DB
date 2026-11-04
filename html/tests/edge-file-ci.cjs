/* CI-only: run the installed Windows Edge against the actual file:// pages.
 * No server, route interception, API replacement or permission grants.
 * playwright-core is installed in RUNNER_TEMP by the workflow, never by the app.
 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const artifacts = process.env.EDGE_CI_ARTIFACTS;
const report = {
  environment: {
    platform: process.platform,
    release: os.release(),
    node: process.version,
    run: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
    sha: process.env.GITHUB_SHA,
    viewport: { width: 1280, height: 900 },
  },
  checks: [],
  observations: [],
  notTested: [
    "Native folder picker dialog, real folder enumeration and user permission grant/regrant",
    "Real FileSystemDirectoryHandle serialization and restoration after restart",
    "PDF/image preview rendering, IME and large real disk folders",
    "User PC, user Edge profile/policies, user restart/startup settings",
  ],
};
const markers = {};
let context;
let failureNumber = 0;
function log(message) {
  console.log(message);
}
async function evidence(page, name) {
  if (!page || page.isClosed()) return;
  try {
    await page.screenshot({
      path: path.join(artifacts, `${name}.png`),
      fullPage: true,
      timeout: 10000,
    });
    fs.writeFileSync(
      path.join(artifacts, `${name}.html`),
      await page.content(),
    );
  } catch (error) {
    report.observations.push({ evidence: name, error: String(error) });
  }
}
async function check(name, kind, fn, page) {
  try {
    const detail = await fn();
    report.checks.push({ name, kind, status: "pass", detail });
    log(`PASS [${kind}] ${name}`);
    return true;
  } catch (error) {
    report.checks.push({
      name,
      kind,
      status: "fail",
      error: error.stack || String(error),
    });
    log(`FAIL [${kind}] ${name}: ${error.stack || error}`);
    await evidence(page, `failure-${++failureNumber}`);
    return false;
  }
}
function watch(page, label) {
  const state = {
    label,
    errors: [],
    warnings: [],
    failedRequests: [],
    loaded: [],
    console: [],
  };
  page.on("pageerror", (e) => state.errors.push(e.stack || String(e)));
  page.on("console", (m) => {
    state.console.push({ type: m.type(), text: m.text() });
    if (m.type() === "error") state.errors.push(m.text());
    if (m.type() === "warning") state.warnings.push(m.text());
  });
  page.on("requestfailed", (r) =>
    state.failedRequests.push({ url: r.url(), failure: r.failure() }),
  );
  page.on("requestfinished", (r) => state.loaded.push(r.url()));
  report.observations.push(state);
  return state;
}
const pages = [
  {
    name: "app",
    file: "html/index.html",
    title: "Folder Search",
    resources: [
      "html/styles.css",
      "html/search.js",
      "html/filesystem.js",
      "html/storage.js",
      "html/app.js",
    ],
  },
  {
    name: "browser-tests",
    file: "html/tests/browser.html",
    title: "Folder Search — direct-open verification",
    resources: [
      "html/styles.css",
      "html/search.js",
      "html/filesystem.js",
      "html/storage.js",
      "html/tests/core-tests.js",
      "html/tests/browser-tests.js",
    ],
  },
];
const fileURL = (file) =>
  pathToFileURL(path.resolve(__dirname, "../..", file)).href;

async function openPage(definition, restart) {
  const page = await context.newPage(),
    label = `${restart ? "restart" : "first"}-${definition.name}`;
  const state = watch(page, label);
  const loaded = await check(
    `${label}: direct HTML navigation`,
    "real Edge file://",
    async () => {
      await page.goto(fileURL(definition.file), {
        waitUntil: "load",
        timeout: 30000,
      });
      assert.equal(page.url(), fileURL(definition.file));
      assert.equal(await page.title(), definition.title);
      assert(await page.locator("main").isVisible());
    },
    page,
  );
  if (!loaded) return { page, state, ready: false, label };
  await check(
    `${label}: secure context and native API presence (not picker success)`,
    "real Edge API presence only",
    async () => {
      const info = await page.evaluate(() => ({
        secure: isSecureContext,
        picker: typeof showDirectoryPicker,
        ua: navigator.userAgent,
        protocol: location.protocol,
      }));
      report.observations.push({ label, capabilities: info });
      assert.equal(info.protocol, "file:");
      assert.match(info.ua, /Edg\//);
      assert.equal(info.secure, true);
      assert.equal(info.picker, "function");
      return info;
    },
    page,
  );
  const ready = await check(
    `${label}: initialization completed`,
    "real Edge file://",
    async () => {
      if (definition.name === "app") {
        await page.waitForFunction(
          () =>
            document
              .querySelector("#meta")
              .textContent.includes("No search target folders."),
          {},
          { timeout: 15000 },
        );
        assert.equal(await page.locator("#notice").isVisible(), false);
        assert.equal(await page.locator("#support").isVisible(), false);
      } else {
        await page.waitForFunction(
          () =>
            document
              .querySelector("#log")
              .textContent.includes("No real directory saved yet."),
          {},
          { timeout: 15000 },
        );
        assert.doesNotMatch(await page.locator("#log").innerText(), /FAIL/);
      }
    },
    page,
  );
  await check(
    `${label}: local CSS and all classic scripts loaded`,
    "real Edge file://",
    async () => {
      const details = await page.evaluate(() => ({
        sheets: [...document.styleSheets].map((s) => ({
          href: s.href,
          disabled: s.disabled,
        })),
        globals: [typeof FolderSearch, typeof FolderFS, typeof FolderStore],
        layout: getComputedStyle(document.querySelector(".toolbar")).display,
      }));
      assert(
        details.sheets.some(
          (s) => s.href.endsWith("/styles.css") && !s.disabled,
        ),
      );
      assert.deepEqual(details.globals, ["object", "object", "object"]);
      assert.equal(details.layout, "flex");
      for (const file of definition.resources)
        assert(
          state.loaded.includes(fileURL(file)),
          `Resource did not finish loading: ${file}`,
        );
      assert.deepEqual(state.failedRequests, []);
      return details;
    },
    page,
  );
  return { page, state, ready, label };
}
async function appViews(page, label, restart) {
  await check(
    `${label}: Search → Settings → Search initial screens`,
    "real Edge UI",
    async () => {
      assert(await page.locator("#search-view").isVisible());
      assert.equal(await page.locator("#settings-view").isVisible(), false);
      assert(await page.locator("#query").isVisible());
      assert.equal(await page.locator("#root").isDisabled(), true);
      assert.equal(await page.locator("#search").isDisabled(), true);
      await page.locator("#settings-button").click();
      await page.waitForFunction(() => document.title === "Folder Manager");
      assert(await page.locator("#settings-view").isVisible());
      assert.equal(await page.locator("#search-view").isVisible(), false);
      assert(await page.locator("#add").isEnabled());
      assert.match(
        await page.locator(".settings-table").innerText(),
        /Display Name[\s\S]*Path[\s\S]*Status[\s\S]*Actions/,
      );
      await evidence(page, `${label}-settings`);
      await page.locator("#back").click();
      await page.waitForFunction(() => document.title === "Folder Search");
      assert(await page.locator("#search-view").isVisible());
      if (restart) {
        assert.equal(await page.locator("#query").inputValue(), "CI 永続化");
        assert.equal(
          await page.locator("html").getAttribute("data-theme"),
          "dark",
        );
      }
      await evidence(page, `${label}-search`);
    },
    page,
  );
}
async function browserLogic(page, label) {
  await check(
    `${label}: existing browser-tests.js logic and IndexedDB tests`,
    "mixed: mock logic + real IndexedDB",
    async () => {
      await page.locator("#core").click();
      await page.waitForFunction(
        () =>
          /Saved restart marker:|FAIL/.test(
            document.querySelector("#log").textContent,
          ),
        {},
        { timeout: 30000 },
      );
      const output = await page.locator("#log").innerText();
      fs.writeFileSync(
        path.join(artifacts, `${label}-browser-tests.log`),
        output,
      );
      assert.doesNotMatch(output, /FAIL/);
      assert.match(output, /PASS core \{"passed":41,/);
      for (const text of [
        "root saved",
        "snapshot reread",
        "uncloneable transaction rejected",
        "failed transaction preserves old root",
        "failed transaction preserves old snapshot",
        "delete cascades snapshot",
        "delete removes root",
      ])
        assert(output.includes("PASS " + text), text);
      const match = output.match(/Saved restart marker: (\{[^\n]+\})/);
      assert(match);
      markers.browser = JSON.parse(match[1]);
      return {
        coreAssertions: 41,
        realIndexedDBAssertions: 7,
        mockScope:
          "core-tests.js directory handles/permissions and generated files are synthetic; native folder access not exercised",
      };
    },
    page,
  );
}
async function storage(page, label, restart) {
  await check(
    `${label}: ${restart ? "restore after full Edge process exit" : "write/read IndexedDB via application storage.js"}`,
    "real Edge IndexedDB",
    async () => {
      const expected = restart
        ? markers[label.includes("app") ? "app" : "browser-tests"]
        : { token: randomUUID(), japanese: "永続化", numbers: [1, 2, 3] };
      assert(
        expected && typeof expected.token === "string",
        "A successful pre-restart write is required",
      );
      const actual = await page.evaluate(
        async ({ restart, expected, name }) => {
          // Real application wrapper + native IndexedDB. No API mocks or handles.
          const db = await FolderStore.open();
          const key = "edge-ci-marker-" + name;
          try {
            if (!restart) await db.put("settings", key, expected);
            return await db.get("settings", key);
          } finally {
            db.close();
          }
        },
        {
          restart,
          expected,
          name: label.includes("app") ? "app" : "browser-tests",
        },
      );
      assert.deepEqual(actual, expected);
      if (!restart)
        markers[label.includes("app") ? "app" : "browser-tests"] = expected;
      return actual;
    },
    page,
  );
}
async function browserMarkerAfterRestart(page, label) {
  await check(
    `${label}: browser-tests restart marker restored without rerunning tests`,
    "real Edge IndexedDB",
    async () => {
      assert(
        markers.browser?.time,
        "The initial browser test must have saved its marker",
      );
      const value = await page.evaluate(async () => {
        const db = await FolderStore.open("file-search-html-tests-v1");
        try {
          return await db.get("settings", "restartMarker");
        } finally {
          db.close();
        }
      });
      assert.deepEqual(value, markers.browser);
      assert(
        (await page.locator("#log").innerText()).includes(
          JSON.stringify(markers.browser),
        ),
      );
      return value;
    },
    page,
  );
}
async function appUIForRestart(page, label) {
  await check(
    `${label}: persist real app query and theme settings`,
    "real Edge UI + IndexedDB",
    async () => {
      await page.locator("#query").fill("CI 永続化");
      await page.locator("#settings-button").click();
      if ((await page.locator("html").getAttribute("data-theme")) !== "dark")
        await page.locator("#settings-view .theme").click();
      assert.equal(await page.locator(".theme").getAttribute("aria-pressed"), "true");
      await page.locator("#back").click();
      // waitForFunction polls synchronously; an async predicate is a truthy
      // Promise even when its eventual value is false. Poll the actual completed
      // IndexedDB transaction from Node and assert its value before closing Edge.
      const deadline = Date.now() + 10000;
      let stored;
      do {
        stored = await page.evaluate(async () => {
          const db = await FolderStore.open();
          try {
            return await db.get("settings", "ui");
          } finally {
            db.close();
          }
        });
        if (stored?.query === "CI 永続化" && stored?.theme === "dark") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      assert.equal(stored?.query, "CI 永続化");
      assert.equal(stored?.theme, "dark");
      return stored;
    },
    page,
  );
}
async function compactUI() {
  const page = await context.newPage();
  const diagnostics = watch(page, "compact-ui-synthetic-data");
  await page.addInitScript(() => {
    const snapshot = {
      folders: [{name:"健康",path:"",parent:null,depth:0},{name:"sub",path:"sub",parent:"",depth:1},
        {name:"保管専用",path:"保管専用",parent:"",depth:1},{name:"deep",path:"保管専用/deep",parent:"保管専用",depth:2}],
      files: [
        {name:"健康保険証.txt",path:"健康保険証.txt",parent:""},
        {name:"旅行写真.jpg",path:"旅行写真.jpg",parent:""},
        {name:"健康診断.txt",path:"sub/健康診断.txt",parent:"sub"},
        {name:"資料.txt",path:"保管専用/deep/資料.txt",parent:"保管専用/deep"},
      ],
    };
    for (let i=0;i<250;i++) {
      const name="ページ"+String(i).padStart(4,"0");
      snapshot.folders.push({name,path:name,parent:"",depth:1});
      // Keep the pagination fixture out of the existing TXT-only checks.
      snapshot.files.push({name:"別.bin",path:name+"/別.bin",parent:name});
    }
    for (const file of snapshot.files) file.lastModified = Date.now();
    const root = {id:"fixture",displayName:"健康",directoryName:"健康",handle:{
      queryPermission: async()=>"granted",
      async *entries() { await new Promise(()=>{}); },
    }};
    let saved = {query:"健康",rootId:"fixture",theme:"light"};
    Object.defineProperty(window,"FolderStore",{configurable:true,set(store){
      Object.defineProperty(window,"FolderStore",{value:{...store,open:async()=>({
        roots:async()=>[root], get:async(type)=>type==="settings"?saved:snapshot,
        put:async(type,_,value)=>{if(type==="settings") saved=structuredClone(value);},
      })}});
    }});
    Object.defineProperty(window,"FolderFS",{configurable:true,set(api){
      Object.defineProperty(window,"FolderFS",{value:{...api,fileAt:async(_,path)=>
        Object.assign(new Blob([path]),{name:path.split("/").at(-1)})}});
    }});
  });
  await check("compact workspace, shared preview and responsive layout", "real Edge file:// with synthetic handles/data", async()=>{
    await page.goto(fileURL("html/index.html"));
    await page.waitForFunction(()=>document.querySelectorAll(".item").length>=2);
    assert.equal(await page.title(),"Folder Search");
    assert.equal(await page.locator(".preview").count(),1);
    assert.equal(await page.locator("#search-view .theme").count(),0);
    assert.doesNotMatch(await page.locator("#results").innerText(),/旅行写真/);
    assert.equal(await page.locator("#meta").innerText(),"");
    assert.equal(await page.locator("#preview-panel").isVisible(), true);
    const fullWidth = await page.locator("#results").evaluate(n=>n.getBoundingClientRect().width);
    assert.equal(await page.locator("#modified option").count(),6);
    assert.equal(await page.locator("#format option").count(),12);
    await evidence(page,"search-empty-preview-open");
    const first=page.getByRole("button",{name:"健康保険証.txt",exact:true});
    await first.focus();
    await first.press("Enter");
    await page.waitForFunction(()=>document.querySelector("#preview pre")?.textContent.includes("健康保険証"));
    const layout = await page.evaluate(()=>{
      const rect=id=>document.getElementById(id).getBoundingClientRect().toJSON();
      return {preview:rect("preview"),panel:document.querySelector("aside").getBoundingClientRect().toJSON(),results:rect("results"),
        font:parseFloat(getComputedStyle(document.body).fontSize),
        pad:parseFloat(getComputedStyle(document.querySelector(".item")).paddingTop)};
    });
    assert(layout.panel.x<layout.results.x);
    assert(Math.abs(layout.panel.width/layout.results.width-2)<0.03);
    assert(layout.panel.height>=240);
    assert(layout.panel.bottom<=900);
    assert(layout.font>=13.5 && layout.font<=14);
    assert(layout.pad>=3 && layout.pad<=4);
    assert(Math.abs(fullWidth-layout.results.width)<2);
    await page.locator("#preview-close").click();
    assert.equal(await page.locator("#preview-panel").isVisible(), false);
    assert.equal(await page.locator('.item[aria-pressed="true"], .item.selected').count(),0);
    await first.click();
    await page.getByRole("button",{name:"健康診断.txt",exact:true}).first().click();
    await page.waitForFunction(()=>document.querySelector("#preview pre")?.textContent.includes("健康診断"));
    assert.equal(await page.locator('.item[aria-pressed="true"]').count(),1);
    assert(await page.locator("#results mark").count()>0);
    await evidence(page,"compact-shared-preview-desktop");
    await page.locator("#settings-button").click();
    await page.getByRole("button",{name:"Dark Mode",exact:true}).click();
    assert.equal(await page.locator("html").getAttribute("data-theme"),"dark");
    await page.locator("#back").click();
    assert.equal(await page.locator('.item[aria-pressed="true"].selected').count(),1);
    await evidence(page,"compact-dark-desktop");
    await page.setViewportSize({width:480,height:800});
    const rects=await page.evaluate(()=>[document.querySelector("aside"),document.getElementById("results")].map(n=>n.getBoundingClientRect().toJSON()));
    assert(rects[1].y>=rects[0].bottom);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await evidence(page,"compact-mobile");
    await page.locator("#format").selectOption("txt");
    assert.equal(await page.locator("#preview-panel").isVisible(),true);
    assert.equal(await page.locator('.item[aria-pressed="true"], .item.selected').count(),0);
    await page.locator("#query").fill("");
    await page.locator("#search").click();
    await page.waitForFunction(()=>document.querySelector("#results")?.textContent.includes("健康保険証.txt"));
    assert.doesNotMatch(await page.locator("#results").innerText(),/旅行写真/);
    await page.locator("#modified").selectOption("7");
    await page.waitForFunction(()=>document.querySelector("#results")?.textContent.includes("健康診断.txt"));
    await evidence(page,"filter-only-mobile");
    assert.deepEqual(diagnostics.errors,[]);
  },page);
  await check("name-only folder and 250 paged results", "real Edge file:// with synthetic handles/data", async()=>{
    await page.locator("#format").selectOption("all");
    await page.locator("#modified").selectOption("all");
    await page.locator("#query").fill("保管専用");
    await page.locator("#search").click();
    await page.waitForFunction(()=>document.querySelector("#result-count").textContent==="1 / 1");
    const folder=page.locator("#results .folder-toggle").first();
    assert.equal(await folder.getAttribute("aria-expanded"),"false");
    await folder.click();
    assert.equal(await page.getByRole("button",{name:"資料.txt",exact:true}).count(),1);
    await page.locator("#query").fill("ページ");
    await page.locator("#search").click();
    await page.waitForFunction(()=>document.querySelector("#result-count").textContent==="100 / 250");
    assert.equal(await page.locator("#results > .result").count(),100);
    await page.locator('#results > .result').first().locator('.folder-toggle').click();
    await page.locator('#results > .result').first().locator('.item').click();
    await page.waitForFunction(()=>document.querySelector('#preview pre')?.textContent.includes('ページ0000'));
    const scroll=await page.evaluate(()=>{window.scrollTo(0,500);return scrollY;});
    await page.locator("#result-more").evaluate(b=>b.click());
    await page.waitForFunction(()=>document.querySelector("#result-count").textContent==="200 / 250");
    assert.equal(await page.locator("#result-count").textContent(),"200 / 250");
    assert.equal(await page.evaluate(()=>scrollY),scroll);
    await page.locator("#result-more").evaluate(b=>b.click());
    await page.waitForFunction(()=>document.querySelector("#result-count").textContent==="250 / 250");
    assert.equal(await page.locator("#result-count").textContent(),"250 / 250");
    assert.equal(await page.locator("#results > .result").count(),250);
    assert.equal(await page.locator("#result-more").isVisible(),false);
    const labels=await page.locator("#results .folder-toggle").allTextContents();
    assert.equal(new Set(labels).size,250);
    assert.equal(await page.locator('#results > .result').first().locator('.folder-toggle').getAttribute('aria-expanded'),'true');
    assert.equal(await page.locator('.item[aria-pressed="true"].selected').count(),1);
    const last=page.locator('#results > .result').last();
    await last.locator('.folder-toggle').click();await last.locator('.item').click();
    await page.waitForFunction(()=>document.querySelector('#preview pre')?.textContent.includes('ページ0249'));
    await evidence(page,'appended-folder-preview-selected');
    await page.locator('#preview-close').click();
    assert.equal(await page.locator('.item[aria-pressed="true"], .item.selected').count(),0);
    await page.locator('#search').click();
    await page.waitForFunction(()=>document.querySelector('#result-count').textContent==='100 / 250');
    assert.equal(await page.locator('.item[aria-pressed="true"], .item.selected').count(),0);
    assert.deepEqual(diagnostics.errors,[]);
  },page);
  await page.close();
}
async function uncDiagnosticsUI() {
  // Separate synthetic page: this checks rendered diagnostics, never real UNC I/O.
  const page = await context.newPage(), state = watch(page, "unc-diagnostics-synthetic");
  await page.addInitScript(() => {
    const fixture = window.uncFixture = {failScan:true, commits:0, registrations:0, settings:{query:"txt", rootId:"fixture"}};
    const missing = () => new DOMException("A requested file or directory could not be found at the time an operation was processed.", "NotFoundError");
    const file = {kind:"file", getFile:async()=>({lastModified:1})};
    const root = {id:"fixture",displayName:"Documentation",directoryName:"Documentation",lastScanned:"2026-11-01T00:00:00Z",folderCount:0,fileCount:1,handle:{
      name:"Documentation",queryPermission:async()=>"granted",isSameEntry:async()=>{throw missing();},
      async *entries() {
        yield ["ok.txt",file];
        yield ["子",{kind:"directory",async *entries(){yield ["消失.txt",{kind:"file",getFile:async()=>{
          if(fixture.failScan)throw new DOMException("\\\\private-server\\share https://user:password@host token=secret","NotFoundError");
          return {lastModified:1};
        }}];}}];
      },
    }};
    fixture.snapshot = {folders:[{name:"Documentation",path:"",parent:null,depth:0}],files:[{name:"old.txt",path:"old.txt",parent:"",depth:1}]};
    window.showDirectoryPicker = async()=>({name:"BIM"});
    Object.defineProperty(window,"FolderStore",{configurable:true,set(store){
      Object.defineProperty(window,"FolderStore",{value:{...store,open:async()=>({
        roots:async()=>[root],get:async(type)=>type==="settings"?fixture.settings:fixture.snapshot,
        put:async(type,_,value)=>{if(type==="settings")fixture.settings=structuredClone(value);else fixture.registrations++;},
        commit:async(_,value)=>{fixture.commits++;fixture.snapshot=value;},
      })}});
    }});
  });
  await check("UNC failure diagnostics, privacy, clear and successful retry", "real Edge file:// UI; synthetic handles/storage only", async()=>{
    await page.goto(fileURL("html/index.html"));
    assert.equal(page.url(),fileURL("html/index.html"));
    assert.equal(await page.title(),"Folder Search");
    await page.locator("#settings-button").click();
    await page.locator("#roots details summary").waitFor();
    await page.locator("#roots details summary").click();
    const detail = await page.locator("#roots .diagnostic").innerText();
    assert.match(detail,/Stage: getFile\nNotFoundError:/);
    assert.match(detail,/Relative path: 子\/消失.txt\nProcessed: 1 folders · 1 files/);
    assert.doesNotMatch(await page.locator("body").innerText(),/private-server|user:password|token=secret/);
    assert.equal(await page.evaluate(()=>window.uncFixture.snapshot.files[0].name),"old.txt");
    await evidence(page,"unc-diagnostic-desktop");
    await page.setViewportSize({width:480,height:800});
    await evidence(page,"unc-diagnostic-mobile");
    await page.setViewportSize({width:1280,height:900});
    await page.evaluate(()=>{window.uncFixture.failScan=false;});
    await page.getByRole("button",{name:"Reload",exact:true}).click();
    await page.waitForFunction(()=>window.uncFixture.commits===1);
    await page.locator("#roots details").waitFor({state:"detached"});
    assert.equal(await page.evaluate(()=>JSON.stringify(window.uncFixture.settings).includes("diagnostic")),false);
    await page.locator("#add").click();
    await page.locator("#registration-diagnostic").waitFor();
    assert.match(await page.locator("#registration-diagnostic").innerText(),/Stage: isSameEntry\nNotFoundError:/);
    assert.equal(await page.evaluate(()=>window.uncFixture.registrations),0);
    assert.equal(await page.locator("#roots details").count(),1);
    await evidence(page,"unc-invalid-existing-handle");
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#export-diagnostics").click();
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(),/^file-search-diagnostics-\d{8}-\d{6}\.txt$/);
    const exported = fs.readFileSync(await download.path());
    assert.deepEqual([...exported.subarray(0,3)],[239,187,191]);
    const logText = exported.subarray(3).toString("utf8");
    assert.match(logText,/Auto scan \| Failed/);
    assert.match(logText,/Reload \| Success/);
    assert.match(logText,/Add \| Failed/);
    assert.match(logText,/Stage: getFile/);
    assert.doesNotMatch(logText,/private-server|user:password|token=secret/);
    assert.equal(logText.replace(/\r\n/g, "").includes("\n"),false);
    // Deterministic clipboard policy outcomes; no native permission grant.
    await page.evaluate(()=>Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async text=>{window.copiedDiagnostics=text;}}}));
    await page.locator("#copy-diagnostics").click();
    await page.waitForFunction(()=>document.getElementById("notice").textContent==="Diagnostic log copied.");
    assert.equal(await page.evaluate(()=>window.copiedDiagnostics),logText);
    await page.evaluate(()=>{navigator.clipboard.writeText=async()=>{throw new DOMException("Policy", "NotAllowedError");};});
    await page.locator("#copy-diagnostics").click();
    await page.waitForFunction(()=>document.getElementById("notice").textContent.startsWith("Could not copy"));
    await page.locator("#clear-diagnostics").click();
    assert.equal(await page.locator("#registration-diagnostic").isVisible(),false);
    assert.equal(await page.locator("#roots details").count(),0);
    assert.deepEqual(state.errors,[]);assert.deepEqual(state.failedRequests,[]);
    return {warnings:state.warnings, nativeUNC:"not tested"};
  },page);
  await page.close();
}

async function closeEdge() {
  // CDP only reads process IDs. Browser.close closes this browser normally.
  const session = await context.browser().newBrowserCDPSession();
  const { processInfo } = await session.send("SystemInfo.getProcessInfo");
  await session.detach();
  const ids = processInfo.map((p) => Number(p.id));
  assert(ids.length && ids.every(Number.isInteger));
  await context.close();
  context = undefined;
  const deadline = Date.now() + 15000;
  let alive;
  do {
    alive = JSON.parse(
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `ConvertTo-Json -Compress -InputObject @(Get-Process -Id ${ids.join(",")} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)`,
        ],
        { encoding: "utf8" },
      ).trim(),
    );
    if (!alive.length) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  assert.deepEqual(
    alive,
    [],
    "Edge-owned browser/renderer/utility processes must exit before restart",
  );
  report.observations.push({ closedEdgeProcessIds: ids });
}
// Both application styles/layouts in installed Edge; Safari engine acceptance is separate.
async function previewMatrix() {
  for (const edition of ["html", "safari"]) {
    const matrixPage = await context.newPage();
    await check(`${edition}: responsive preview viewport matrix`, "real Edge layout; synthetic preview bodies", async () => {
      await matrixPage.goto(fileURL(`${edition}/index.html`));
      await matrixPage.locator("#preview-panel").waitFor();
      assert.equal(await matrixPage.locator("#preview").innerText(), "");
      assert.equal(await matrixPage.locator("#preview").evaluate(n=>getComputedStyle(n,"::before").content), '"ファイルを選択してください"');
      for (const [width,height] of [[1280,720],[1366,768],[1280,900],[480,800]]) {
        for (const scale of [1,1.25,1.5]) {
          // Browser zoom reduces the CSS viewport. This tests that geometry,
          // without claiming OS/native browser zoom input was exercised.
          await matrixPage.setViewportSize({width:Math.floor(width/scale),height:Math.floor(height/scale)});
          await matrixPage.evaluate(()=>scrollTo(0,0));
          for (const kind of ["empty","pdf","image","text"]) {
            await matrixPage.evaluate(kind=>{
              const pane=document.getElementById("preview"); pane.replaceChildren();
              if(kind==="empty")return;
              const body=document.createElement({pdf:"iframe",image:"img",text:"pre"}[kind]);
              if(kind==="text")body.textContent="長いテキスト\n".repeat(2000);
              if(kind==="pdf"){body.title="Layout PDF";body.src="about:blank";}
              if(kind==="image")body.src="data:image/svg+xml,"+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="3000"><rect width="2000" height="3000" fill="teal"/></svg>');
              pane.append(body);
            },kind);
            await matrixPage.waitForFunction(()=>{
              const panel=document.getElementById("preview-panel"),r=panel.getBoundingClientRect();
              return Math.abs(r.height-Math.max(240,Math.floor(innerHeight-Math.max(16,r.top)-12)))<2;
            });
            const geometry=await matrixPage.evaluate(()=>{
              const panel=document.getElementById("preview-panel").getBoundingClientRect(),content=document.getElementById("preview").getBoundingClientRect(),results=document.getElementById("results").getBoundingClientRect();
              return {panel:panel.toJSON(),content:content.toJSON(),results:results.toJSON(),height:innerHeight,width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth};
            });
            assert(!geometry.overflow);
            if(geometry.height-geometry.panel.top>=252)assert(geometry.panel.bottom<=geometry.height);
            assert(geometry.content.bottom<=geometry.panel.bottom);
            if(geometry.width>800)assert(Math.abs(geometry.panel.width/geometry.results.width-2)<0.04);
            else assert(geometry.results.top>=geometry.panel.bottom);
            if(kind==="text")assert(await matrixPage.locator("#preview").evaluate(n=>n.scrollHeight>n.clientHeight));
          }
          if(scale===1)await evidence(matrixPage,`${edition}-preview-${width}x${height}`);
        }
      }
      await matrixPage.setViewportSize({width:1280,height:260});
      await matrixPage.waitForFunction(()=>document.getElementById("preview-panel").getBoundingClientRect().height>=240);
      await matrixPage.locator("#preview-close").click();
      assert.equal(await matrixPage.locator("#preview-panel").isVisible(),false);
      await matrixPage.locator("#format").selectOption("txt");
      assert.equal(await matrixPage.locator("#preview-panel").isVisible(),false);
      await matrixPage.reload();
      await matrixPage.locator("#preview-panel").waitFor();
    },matrixPage);
    await matrixPage.close();
  }
}

async function main() {
  assert.equal(
    process.platform,
    "win32",
    "This acceptance test must use Windows, without a Chromium fallback",
  );
  assert.equal(
    process.env.GITHUB_ACTIONS,
    "true",
    "Driver dependencies and execution are CI-only",
  );
  assert(artifacts && process.env.EDGE_CI_DEPS && process.env.EDGE_CI_PROFILE);
  const { chromium } = require(
    path.join(process.env.EDGE_CI_DEPS, "node_modules", "playwright-core"),
  );
  const executable = [
    process.env["ProgramFiles(x86)"],
    process.env.ProgramFiles,
  ]
    .filter(Boolean)
    .map((base) =>
      path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
    )
    .find((file) => fs.existsSync(file));
  assert(
    executable,
    "Installed Microsoft Edge not found; no download or substitute is allowed",
  );
  const profile = path.resolve(process.env.EDGE_CI_PROFILE);
  // Disable ALL Playwright default flags. Only a private automation pipe, isolated
  // persistent profile, first-run UX suppression and blank page are supplied.
  // In particular: no --no-sandbox, --disable-web-security, --allow-file-access*,
  // insecure-origin override, feature flags, permission grants or HTTP debugging port.
  const args = [
    "--remote-debugging-pipe",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ];
  report.environment.executable = executable;
  report.environment.args = args;
  fs.mkdirSync(profile, { recursive: true });
  for (const restart of [false, true]) {
    const launched = await check(
      `${restart ? "second" : "first"}: launch installed headed Microsoft Edge`,
      "real Windows Edge process",
      async () => {
        context = await chromium.launchPersistentContext(profile, {
          executablePath: executable,
          ignoreDefaultArgs: true,
          args,
          headless: false,
          viewport: report.environment.viewport,
          timeout: 30000,
        });
        report.observations.push({
          restart,
          version: context.browser().version(),
        });
      },
    );
    if (!launched) break;
    if (!restart) await compactUI();
    if (!restart) await uncDiagnosticsUI();
    for (const definition of pages) {
      const { page, state, ready, label } = await openPage(definition, restart);
      if (ready) {
        if (definition.name === "app") {
          await appViews(page, label, restart);
          if (!restart) await appUIForRestart(page, label);
        } else if (!restart) await browserLogic(page, label);
        else await browserMarkerAfterRestart(page, label);
        await storage(page, label, restart);
      }
      await evidence(page, label);
      await check(
        `${label}: no initialization/runtime/console errors or failed resources`,
        "real Edge diagnostics",
        async () => {
          assert.deepEqual(state.errors, []);
          assert.deepEqual(state.failedRequests, []);
          if (definition.name === "browser-tests")
            assert.doesNotMatch(await page.locator("#log").innerText(), /FAIL/);
          else assert.equal(await page.locator("#notice").isVisible(), false);
          return { warnings: state.warnings };
        },
        page,
      );
      await page.close();
    }
    if (!restart) await previewMatrix();
    if (
      !(await check(
        `${restart ? "second" : "first"}: all owned Edge processes exited`,
        "real Windows process exit",
        closeEdge,
      ))
    )
      break;
  }
}
if (artifacts) fs.mkdirSync(artifacts, { recursive: true });
main()
  .catch((error) => {
    report.checks.push({
      name: "driver",
      kind: "CI infrastructure",
      status: "fail",
      error: error.stack || String(error),
    });
    console.error(error);
  })
  .finally(async () => {
    if (context)
      try {
        await context.close();
      } catch (error) {
        report.observations.push({ closeError: String(error) });
      }
    report.passed = report.checks.filter((c) => c.status === "pass").length;
    report.failed = report.checks.filter((c) => c.status === "fail").length;
    log(JSON.stringify(report, null, 2));
    if (artifacts)
      fs.writeFileSync(
        path.join(artifacts, "report.json"),
        JSON.stringify(report, null, 2),
      );
    if (process.env.GITHUB_STEP_SUMMARY)
      fs.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `## Installed Windows Edge / file://\n\n${report.passed} passed, ${report.failed} failed. See artifact report.json, driver.log and screenshots.\n\n` +
          `Folder dialogs/permissions/real handles and the user's PC remain untested. Mock core logic is labelled separately.\n`,
      );
    process.exitCode = report.failed ? 1 : 0;
  });

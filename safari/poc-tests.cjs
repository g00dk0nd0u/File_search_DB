"use strict";
// Development only. This is not a Safari or native folder-access acceptance test.
async function runPoCTests(source, Decoder) {
  const results = [];
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  function harness(saved = {savedAt: "old", files: [{path: "old/stale.txt"}]}) {
    class Element {
      constructor() { this.children = []; this.events = {}; this.textContent = ""; this.disabled = false; this.value = ""; }
      append(child) { this.children.push(...(child.fragment ? child.children : [child])); }
      replaceChildren() { this.children = []; }
      addEventListener(name, handler) { this.events[name] = handler; }
      emit(name) { return this.events[name]?.(); }
    }
    const ids = Object.fromEntries(["picker", "save", "files", "preview", "log"].map(id => [id, new Element()]));
    ids.save.disabled = true;
    ids.picker.files = [];
    const opens = [], transactions = [], writes = [], events = {};
    let stored = saved;
    const database = {
      close() {},
      transaction(_, mode) {
        const tx = {
          mode, aborted: false, finished: false,
          objectStore() {
            return {
              get() { tx.operation = {}; return tx.operation; },
              put(value) { writes.push(value); tx.value = value; tx.operation = {}; return tx.operation; }
            };
          },
          abort() {
            if (tx.finished) throw new Error("finished");
            tx.aborted = true;
            tx.finished = true;
            Promise.resolve().then(() => tx.onabort?.());
          },
          complete() {
            if (tx.finished) return;
            tx.finished = true;
            if (mode === "readwrite") stored = tx.value;
            tx.operation.result = mode === "readonly" ? stored : "snapshot";
            tx.operation.onsuccess?.();
            tx.oncomplete?.();
          }
        };
        transactions.push(tx);
        return tx;
      }
    };
    const indexedDB = {open() { const request = {result: database}; opens.push(request); return request; }};
    const document = {
      getElementById: id => ids[id],
      createElement: () => new Element(),
      createDocumentFragment: () => Object.assign(new Element(), {fragment: true})
    };
    const urls = {createObjectURL: () => "blob:synthetic", revokeObjectURL() {}};
    new Function("document", "window", "indexedDB", "URL", "Blob", "TextDecoder", "location", "navigator", source)(
      document, {addEventListener: (name, handler) => { events[name] = handler; }},
      indexedDB, urls, class {}, Decoder, {protocol: "file:"}, {userAgent: "synthetic DOM"}
    );
    const open = () => { const request = opens.shift(); assert(request, "expected pending DB open"); request.onsuccess(); };
    open(); transactions.shift().complete();
    return {
      ids, opens, transactions, writes, events, open,
      stored: () => stored,
      async select(files) { ids.picker.files = files; await ids.picker.emit("change"); },
      log: () => ids.log.textContent
    };
  }
  function file(path, bytes = new Uint8Array([65])) {
    return {
      name: path.split("/").pop(), webkitRelativePath: path,
      size: bytes.length, lastModified: 1, readable: true, reads: 0,
      slice(start, end) {
        return {arrayBuffer: async () => {
          if (!this.readable || ++this.reads > (this.failAfter ?? Infinity)) throw new Error("NotReadableError");
          if (this.wait) await this.wait;
          return bytes.slice(start, end).buffer;
        }};
      }
    };
  }
  async function test(name, body) { await body(); results.push(name); }
  await test("saved metadata never restores file list", async () => {
    const h = harness(); await flush();
    assert(h.ids.files.children.length === 0 && h.ids.preview.children.length === 0, "old file access restored");
    assert(h.ids.save.disabled && h.log().includes("old"), "saved marker read was not tested");
  });
  await test("late DB open after cancel never writes old selection", async () => {
    const h = harness(); await h.select([file("A/a.txt")]);
    const pending = h.ids.save.emit("click"); await flush();
    h.ids.picker.emit("click"); h.open();
    assert(h.writes.length === 0, "stale save started after cancel");
    await pending;
    assert(h.stored().savedAt === "old", "stale save committed");
    assert(!h.log().includes("トランザクション完了"), "stale success logged");
  });
  await test("reselection aborts active write transaction", async () => {
    const h = harness(); await h.select([file("A/a.txt")]);
    const pending = h.ids.save.emit("click"); await flush(); h.open();
    const tx = h.transactions.shift();
    h.ids.picker.emit("click"); tx.complete(); await pending;
    assert(tx.aborted && h.stored().savedAt === "old", "old transaction was not aborted");
  });
  await test("stale save completion cannot disable new selection", async () => {
    const h = harness(); await h.select([file("A/a.txt")]);
    const pending = h.ids.save.emit("click"); await flush();
    h.ids.picker.emit("click"); await h.select([file("B/b.txt")]);
    assert(h.ids.save.disabled, "another save must not start while the first settles");
    h.open(); await pending;
    assert(!h.ids.save.disabled && h.ids.files.children.length === 1, "new selection lost");
    assert(h.ids.files.children[0].children[0].textContent === "B/b.txt", "old selection restored");
  });
  await test("save rechecks readability and preserves previous metadata", async () => {
    const h = harness(), f = file("A/a.txt"); await h.select([f]);
    f.readable = false; await h.ids.save.emit("click");
    assert(h.writes.length === 0 && h.stored().savedAt === "old", "unreadable file replaced metadata");
    assert(h.ids.files.children.length === 0 && h.ids.save.disabled, "inaccessible files still visible");
  });
  await test("duplicate save events produce one transaction", async () => {
    const h = harness(); await h.select([file("A/a.txt")]);
    const a = h.ids.save.emit("click"), b = h.ids.save.emit("click");
    await flush(); assert(h.opens.length === 1, "overlapping saves");
    h.open(); h.transactions.shift().complete(); await Promise.all([a, b]);
    assert(h.writes.length === 1 && h.stored().files[0].path === "A/a.txt", "valid save failed");
  });
  await test("selection read failure preserves DB and hides partial list", async () => {
    const h = harness(), bad = file("A/bad.txt"); bad.readable = false;
    await h.select([file("A/a.txt"), bad]);
    assert(h.ids.files.children.length === 0 && h.ids.save.disabled, "partial selection displayed");
    assert(h.writes.length === 0 && h.stored().savedAt === "old", "failed selection replaced DB");
  });
  await test("old async selection never overwrites newer selection", async () => {
    const h = harness(), slow = file("A/slow.txt");
    let release; slow.wait = new Promise(resolve => { release = resolve; });
    const pending = h.select([slow]); await flush();
    await h.select([file("B/b.txt")]); release(); await pending;
    assert(h.ids.files.children.length === 1 &&
      h.ids.files.children[0].children[0].textContent === "B/b.txt", "old selection won");
  });
  await test("preview read failure hides inaccessible file list", async () => {
    const h = harness(), f = file("A/a.txt"); await h.select([f]);
    f.readable = false;
    await h.ids.files.children[0].children[0].emit("click");
    assert(h.ids.files.children.length === 0 && h.ids.preview.children.length === 0, "inaccessible preview/list retained");
    assert(h.stored().savedAt === "old", "preview failure deleted metadata");
  });
  await test("text body read failure after successful probe hides list", async () => {
    const h = harness(), f = file("A/a.txt"); await h.select([f]);
    f.failAfter = f.reads + 1;
    await h.ids.files.children[0].children[0].emit("click");
    assert(h.ids.files.children.length === 0 && h.ids.preview.children.length === 0, "failed text body left inaccessible list");
  });
  await test("late text preview cannot reappear after cancel", async () => {
    const h = harness(), f = file("A/a.txt"); await h.select([f]);
    let release; f.wait = new Promise(resolve => { release = resolve; });
    const pending = h.ids.files.children[0].children[0].emit("click");
    h.ids.picker.emit("cancel"); release(); await pending;
    assert(h.ids.preview.children.length === 0 && h.ids.files.children.length === 0, "late preview reappeared");
  });
  await test("UTF-8 prefix split inside Japanese character is not Shift-JIS", async () => {
    const h = harness(), bytes = new Uint8Array(16386);
    bytes.fill(97, 0, 16383); bytes.set([0xe3, 0x81, 0x82], 16383);
    await h.select([file("A/日本語.txt", bytes)]);
    await h.ids.files.children[0].children[0].emit("click");
    assert(h.ids.preview.children[0]?.textContent === "a".repeat(16383), "UTF-8 prefix misdecoded");
  });
  return {passed: results.length, cases: results, scope: "synthetic DOM, File reads and IndexedDB transaction scheduling"};
}

if (typeof module !== "undefined") module.exports = runPoCTests;
if (typeof require !== "undefined" && require.main === module) {
  const fs = require("node:fs");
  const path = require("node:path");
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const script = html.match(/<script>\n([\s\S]*?)<\/script>/)[1];
  runPoCTests(script, TextDecoder).then(
    result => console.log(JSON.stringify(result, null, 2)),
    error => { console.error(error); process.exitCode = 1; }
  );
}

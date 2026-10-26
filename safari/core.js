/* Safari FileList adapter. No persistent File/handle access. */
(function (scope) {
  "use strict";
  const stale = () => new DOMException("選択が変わりました。", "AbortError");
  async function build(selected, current = () => true) {
    if (!selected.length) throw Error("ファイルを取得できません。空フォルダは登録できません。");
    const folders = new Map(), files = [], handles = new Map(), seen = new Set();
    let rootName;
    for (const file of selected) {
      if (!current()) throw stale();
      const parts = file.webkitRelativePath.split("/");
      if (parts.length < 2 || parts.some(p => !p || p === "." || p === ".."))
        throw Error("相対パスが不正です: " + file.name);
      if (rootName && rootName !== parts[0]) throw Error("複数のルートが混在しています。");
      rootName = parts[0];
      const path = parts.slice(1).join("/");
      if (seen.has(path)) throw Error("相対パスが重複しています。");
      seen.add(path);
      // Match Python/Edge's hidden-name policy; empty directories are unknowable.
      if (parts.slice(1).some(p => p.startsWith("."))) continue;
      await file.slice(0, 1).arrayBuffer();
      if (!current()) throw stale();
      for (let i = 1; i < parts.length - 1; i++) {
        const path = parts.slice(1, i + 1).join("/");
        folders.set(path, {path, name: parts[i], parent: parts.slice(1, i).join("/"), depth: i});
      }
      files.push({path, name: parts.at(-1), parent: parts.slice(1, -1).join("/"),
        depth: parts.length - 1, size: file.size, lastModified: file.lastModified});
      handles.set(path, file);
      if (files.length % 200 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    folders.set("", {path: "", name: rootName, parent: null, depth: 0});
    // A path cannot simultaneously represent a directory and a file.
    if (files.some(f => folders.has(f.path))) throw Error("ファイルとフォルダのパスが衝突しています。");
    return {snapshot: {folders: [...folders.values()], files}, handles, rootName};
  }
  async function text(file) {
    const bytes = new Uint8Array(await file.slice(0, 16384).arrayBuffer());
    if (bytes.includes(0)) return {error: "バイナリファイルは表示できません。"};
    const options = {stream: file.size > bytes.length};
    let value;
    try { value = new TextDecoder("utf-8", {fatal: true}).decode(bytes, options); }
    catch (_) {
      try { value = new TextDecoder("shift-jis", {fatal: true}).decode(bytes, options); }
      catch (_) { value = new TextDecoder().decode(bytes, options); }
    }
    return {text: value, truncated: file.size > bytes.length};
  }
  // Each root is one record: registration + complete index commit together.
  class Storage {
    constructor(api = scope.indexedDB) { this.api = api; }
    transact(mode, operation, current = () => true, signal) {
      return new Promise((resolve, reject) => {
        let request, blocked = false;
        try { request = this.api.open("file-search-safari-v1", 1); }
        catch (error) { reject(error); return; }
        request.onupgradeneeded = () => request.result.createObjectStore("roots", {keyPath: "id"});
        request.onerror = () => reject(request.error);
        request.onblocked = () => { blocked = true; reject(Error("保存領域がブロックされています。他のタブを閉じてください。")); };
        request.onsuccess = () => {
          const db = request.result;
          if (blocked || !current() || signal?.aborted) { db.close(); reject(stale()); return; }
          db.onversionchange = () => db.close();
          let tx, result;
          const abort = () => { try { tx.abort(); } catch (_) {} };
          const close = () => { signal?.removeEventListener("abort", abort); db.close(); };
          try {
            tx = db.transaction("roots", mode);
            tx.oncomplete = () => { close(); resolve(result); };
            tx.onabort = () => { close(); reject(tx.error || stale()); };
            tx.onerror = () => {};
            const req = operation(tx.objectStore("roots"));
            req.onsuccess = () => { result = req.result; };
            signal?.addEventListener("abort", abort, {once: true});
          } catch (error) { if (tx) abort(); close(); reject(error); }
        };
      });
    }
    all() { return this.transact("readonly", store => store.getAll()); }
    put(record, current, signal) { return this.transact("readwrite", store => store.put(record), current, signal); }
    remove(id, current, signal) { return this.transact("readwrite", store => store.delete(id), current, signal); }
  }
  class Model {
    constructor(storage) {
      this.storage = storage; this.roots = new Map(); this.sessions = new Map();
      this.activeId = ""; this.epoch = 0; this.pendingId = null; this.controller = null;
    }
    async load() {
      const records = await this.storage.all();
      this.roots = new Map(records.map(r => [r.id, r]));
      this.activeId = records[0]?.id || "";
      // Persisted indexes never authorize access or populate sessions.
    }
    cancel() {
      this.epoch++;
      this.controller?.abort(); this.controller = null;
      if (this.pendingId) this.sessions.delete(this.pendingId);
      this.pendingId = null;
    }
    switch(id) { this.cancel(); this.activeId = id; }
    invalidate(id) { this.cancel(); this.sessions.delete(id); }
    begin(id) { this.cancel(); this.sessions.delete(id); this.pendingId = id; return this.epoch; }
    async select(id, files, ticket) {
      const current = () => ticket === this.epoch && this.pendingId === id;
      try {
        if (!current()) throw stale();
        const session = await build(files, current);
        const previous = this.roots.get(id);
        const record = {id, displayName: previous?.displayName || session.rootName,
          rootName: session.rootName, savedAt: new Date().toISOString(), snapshot: session.snapshot};
        // Recheck immediately before committing; no partial index on read failure.
        for (const file of session.handles.values()) {
          await file.slice(0, 1).arrayBuffer();
          if (!current()) throw stale();
        }
        this.controller = new AbortController();
        await this.storage.put(record, current, this.controller.signal);
        if (!current()) throw stale();
        this.roots.set(id, record); this.sessions.set(id, session);
        this.activeId = id; this.pendingId = null; this.controller = null;
        return session;
      } catch (error) {
        if (current()) { this.sessions.delete(id); this.pendingId = null; }
        throw error;
      }
    }
    async edit(id, name) {
      name = name.trim(); if (!name) throw Error("表示名を入力してください。");
      this.cancel(); const ticket = this.epoch, record = {...this.roots.get(id), displayName: name};
      const current = () => ticket === this.epoch;
      this.controller = new AbortController();
      await this.storage.put(record, current, this.controller.signal);
      if (current()) this.roots.set(id, record);
    }
    async remove(id) {
      this.cancel(); const ticket = this.epoch, current = () => ticket === this.epoch;
      this.controller = new AbortController();
      await this.storage.remove(id, current, this.controller.signal);
      if (!current()) return;
      this.roots.delete(id); this.sessions.delete(id);
      if (this.activeId === id) this.activeId = this.roots.keys().next().value || "";
    }
  }
  scope.SafariCore = {build, text, Storage, Model};
  if (typeof module !== "undefined") module.exports = scope.SafariCore;
})(typeof window === "undefined" ? globalThis : window);

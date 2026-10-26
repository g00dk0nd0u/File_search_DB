/* Classic scripts work directly from file:// without modules or a server. */
(async function () {
  "use strict";
  const $ = id => document.getElementById(id), S = FolderSearch, C = SafariCore;
  const model = new C.Model(new C.Storage());
  const states = new Map(), childIndexes = new WeakMap();
  let searchGeneration = 0, previewGeneration = 0, objectURL, pickerTask, composing = false, timer, captureExpansion;
  const node = (tag, text, cls) => {
    const item = document.createElement(tag);
    if (text !== undefined) item.textContent = text;
    if (cls) item.className = cls;
    return item;
  };
  const state = () => {
    if (!states.has(model.activeId)) states.set(model.activeId, {query: null, collapsed: new Set(), selected: null});
    return states.get(model.activeId);
  };
  function notice(message = "") { $("notice").textContent = message; $("notice").hidden = !message; }
  function fail(error) {
    if (error.name !== "AbortError") notice(error.message + " 保存済み情報は保持しています。フォルダを再選択してください。");
  }
  function clearPreview() {
    previewGeneration++;
    $("preview").replaceChildren(); $("preview-title").textContent = "Preview";
    if (objectURL) URL.revokeObjectURL(objectURL);
    objectURL = null;
  }
  function rememberExpansion() {
    // Native details.toggle is queued; read the actual state before detaching
    // a render even if its event has not run (or input invalidated its ticket).
    captureExpansion?.(); captureExpansion = null;
  }
  function clearView() { rememberExpansion(); searchGeneration++; clearTimeout(timer); clearPreview(); $("results").replaceChildren(); }
  function view(settings) {
    $("settings-view").hidden = !settings; $("search-view").hidden = settings;
    if (settings) renderSettings(); else { renderRoots(); runSearch(); $("query").focus(); }
  }
  function renderRoots() {
    $("root").replaceChildren();
    for (const root of model.roots.values()) {
      const option = node("option", root.displayName); option.value = root.id; $("root").append(option);
    }
    $("root").value = model.activeId;
    $("root").disabled = !model.roots.size;
    $("search").disabled = !model.sessions.has(model.activeId);
  }
  function choose(id) {
    model.switch(id); pickerTask = null; clearView(); notice(); renderRoots(); runSearch();
  }
  function startPicker(id) {
    clearView(); notice();
    // Starting Add must also revoke the currently displayed session: a failed
    // new registration must never fall back to its old results.
    const previousId = model.activeId !== id ? model.activeId : "";
    const previousSession = model.sessions.get(previousId);
    if (previousId) model.invalidate(previousId);
    pickerTask = {id, ticket: model.begin(id), previousId, previousSession};
    $("meta").textContent = "フォルダを選択してください。以前の結果は非表示です。";
    renderRoots(); renderSettings();
    $("picker").value = ""; $("picker").click();
  }
  $("picker").addEventListener("cancel", () => {
    if (!pickerTask) return;
    model.cancel(); pickerTask = null; clearView(); renderRoots(); renderSettings();
    notice("選択をキャンセルしました。検索にはフォルダの再選択が必要です。"); runSearch();
  });
  $("picker").addEventListener("change", async () => {
    const task = pickerTask; pickerTask = null;
    const files = Array.from($("picker").files); $("picker").value = "";
    if (!task) return;
    try {
      await model.select(task.id, files, task.ticket);
      if (task.ticket !== model.epoch) return;
      if (task.previousSession) model.sessions.set(task.previousId, task.previousSession);
      states.delete(task.id); notice(); renderRoots(); renderSettings(); view(false);
    } catch (error) {
      if (task.ticket !== model.epoch) return;
      clearView(); fail(error); renderRoots(); renderSettings(); runSearch();
    }
  });
  async function showPreview(path, button) {
    clearPreview();
    const session = model.sessions.get(model.activeId), id = model.activeId, ticket = previewGeneration;
    const file = session?.handles.get(path);
    if (!file) return;
    state().selected = path;
    document.querySelectorAll(".file[aria-pressed=true]").forEach(e => e.setAttribute("aria-pressed", "false"));
    button?.setAttribute("aria-pressed", "true");
    const current = () => ticket === previewGeneration && id === model.activeId && model.sessions.get(id) === session;
    const readFailure = error => {
      if (!current()) return;
      model.invalidate(id); clearView(); renderRoots(); renderSettings(); runSearch(); fail(error);
    };
    try {
      // Probe the actual selected File every time; never use cached/persisted bodies.
      await file.slice(0, 1).arrayBuffer();
      if (!current()) return;
      const ext = file.name.split(".").pop().toLowerCase();
      $("preview-title").textContent = file.name;
      if (ext === "pdf") {
        objectURL = URL.createObjectURL(new Blob([file], {type: "application/pdf"}));
        const frame = node("iframe"); frame.title = file.name; frame.src = objectURL;
        frame.onerror = () => readFailure(Error("PDFを読み込めません。"));
        $("preview").append(frame);
      } else if (/^(png|jpe?g|gif|webp|bmp|avif|heic|heif|tiff?)$/.test(ext)) {
        objectURL = URL.createObjectURL(file);
        const image = node("img"); image.alt = file.name;
        image.onerror = () => readFailure(Error("画像を読み込めません（未対応形式を含む）。"));
        image.src = objectURL; $("preview").append(image);
      } else {
        const result = await C.text(file);
        if (!current()) return;
        $("preview").append(node(result.error ? "p" : "pre", result.error || result.text));
        if (result.truncated) $("preview").append(node("p", "先頭16 KiBのみ表示", "hint"));
      }
    } catch (error) { readFailure(error); }
  }
  // Display-only casefold map: one original character may expand (ß -> ss).
  // Map every folded UTF-16 unit back to complete original code points.
  function highlight(name, terms) {
    let folded = "", offset = 0;
    const starts = [], ends = [], ranges = [];
    for (const char of name) {
      const part = S.fold(char);
      for (let i = 0; i < part.length; i++) { starts.push(offset); ends.push(offset + char.length); }
      folded += part; offset += char.length;
    }
    for (const term of terms) {
      if (!term) continue;
      for (let at = folded.indexOf(term); at !== -1; at = folded.indexOf(term, at + 1))
        ranges.push([starts[at], ends[at + term.length - 1]]);
    }
    ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = [];
    for (const range of ranges) {
      const previous = merged.at(-1);
      if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
      else merged.push(range.slice());
    }
    const fragment = document.createDocumentFragment();
    let from = 0;
    for (const [start, end] of merged) {
      if (start > from) fragment.append(document.createTextNode(name.slice(from, start)));
      fragment.append(node("mark", name.slice(start, end)));
      from = end;
    }
    if (from < name.length) fragment.append(document.createTextNode(name.slice(from)));
    return fragment;
  }
  function displayChildren(session) {
    // Bucket once per FileList session, avoiding a full index scan per folder.
    if (!childIndexes.has(session)) {
      const index = new Map();
      for (const kind of ["folders", "files"]) for (const item of session.snapshot[kind]) {
        if (!index.has(item.parent)) index.set(item.parent, {folders: [], files: []});
        index.get(item.parent)[kind].push(item);
      }
      childIndexes.set(session, index);
    }
    const index = childIndexes.get(session), cache = new Map();
    return (path, query, matched) => {
      const key = JSON.stringify([path, query, !!matched]);
      if (!cache.has(key)) cache.set(key, S.children(index.get(path) || {folders: [], files: []}, path, query, matched));
      return cache.get(key);
    };
  }
  function resultRenderer(session, query, ui, current) {
    const terms = S.terms(S.parse(query)), childrenOf = displayChildren(session);
    const jobs = [], observers = [];
    captureExpansion = () => { for (const remember of observers) remember(); };
    let remaining = 400, draining = false;
    // Breadth-first jobs avoid recursive tree construction. Yield between small
    // batches, and stop automatic descent at 8 levels / 400 child rows total.
    async function drain() {
      if (draining) return;
      draining = true;
      try {
        let processed = 0;
        while (jobs.length && current()) {
          jobs.shift()();
          if (++processed % 10 === 0) await S.pause();
        }
      } finally { draining = false; }
    }
    function childList(path, filterQuery, matched, level) {
      const list = node("ul", undefined, "children"), children = childrenOf(path, filterQuery, matched);
      let offset = 0;
      function more(autoLevel) {
        if (!current()) return;
        const end = Math.min(children.length, offset + 200);
        while (offset < end && remaining > 0) {
          const child = children[offset++], li = node("li"); remaining--;
          if (child.kind === "directory") li.append(folder(child, "", autoLevel + 1));
          else {
            const button = node("button", undefined, "file"); button.type = "button";
            button.append(highlight(child.name, terms));
            button.setAttribute("aria-pressed", String(ui.selected === child.path));
            button.addEventListener("click", () => showPreview(child.path, button)); li.append(button);
          }
          list.append(li);
        }
        if (offset < children.length) continuation();
      }
      function continuation() {
        const button = node("button", "さらに表示", "secondary"); button.type = "button";
        button.addEventListener("click", () => {
          if (!current()) return;
          button.remove(); remaining = 400; more(0); drain();
        });
        list.append(button);
      }
      if (!children.length) list.append(node("li", "表示する直下項目はありません。", "hint"));
      else if (level >= 8 || remaining <= 0) continuation();
      else more(level);
      return list;
    }
    function folder(row, filterQuery, level = 0) {
      const details = node("details", undefined, "folder"), summary = node("summary");
      summary.append(highlight(row.name, terms)); details.append(summary);
      let populated = false;
      const populate = () => {
        if (populated || !details.open || !current()) return;
        populated = true;
        details.append(childList(row.path, filterQuery, row.folderNameMatched, level));
      };
      details.open = !ui.collapsed.has(row.path);
      let lastOpen = details.open;
      const remember = () => {
        if (details.open === lastOpen) return;
        lastOpen = details.open;
        if (details.open) ui.collapsed.delete(row.path);
        else ui.collapsed.add(row.path);
      };
      observers.push(remember);
      if (details.open) jobs.push(populate);
      details.addEventListener("toggle", () => {
        // Initial programmatic open also fires toggle in browsers. Record only
        // actual state changes, and ignore events belonging to an old render.
        if (!current() || details.open === lastOpen) return;
        remember();
        if (details.open) { remaining = 400; jobs.push(populate); drain(); }
      });
      return details;
    }
    return {folder: row => folder(row, query), drain, childrenOf};
  }
  async function runSearch() {
    rememberExpansion();
    clearTimeout(timer);
    const ticket = ++searchGeneration, id = model.activeId, session = model.sessions.get(id);
    const query = $("query").value;
    const ui = state();
    if (ui.query !== query) { ui.query = query; ui.collapsed.clear(); }
    $("results").replaceChildren();
    if (!session) {
      clearPreview(); $("meta").textContent = model.pendingId ? "フォルダの選択内容を確認しています…" :
        (model.roots.size ? "検索するには対象フォルダを再選択してください。" : "Settings → Add Directory から検索対象を登録してください。");
      return;
    }
    if (!query.trim()) { clearPreview(); $("meta").textContent = "キーワードを入力してください。"; return; }
    const current = () => ticket === searchGeneration && id === model.activeId && session === model.sessions.get(id);
    try {
      const rows = await S.search(session.snapshot, query, 100, () => !current());
      if (!current()) return;
      const renderer = resultRenderer(session, query, ui, current);
      // Keep file selection while typing; remove previews outside results.
      if (!rows.some(row => renderer.childrenOf(row.path, query, row.folderNameMatched)
        .some(child => child.path === ui.selected))) clearPreview();
      const fragment = document.createDocumentFragment();
      for (const row of rows) fragment.append(renderer.folder(row));
      $("results").replaceChildren(fragment);
      $("meta").textContent = rows.length ? "" : "一致するフォルダはありません。";
      await renderer.drain();
    } catch (error) { if (current()) { clearView(); fail(error); } }
  }
  function renderSettings() {
    $("roots").replaceChildren();
    for (const root of model.roots.values()) {
      const tr = node("tr"), nameCell = node("td"), input = node("input");
      input.value = root.displayName; input.setAttribute("aria-label", "表示名: " + root.displayName); nameCell.append(input); tr.append(nameCell);
      tr.append(node("td", root.rootName));
      tr.append(node("td", model.sessions.has(root.id) ? "選択済み" : "再選択が必要"));
      const cell = node("td"), actions = node("div", undefined, "actions");
      const addAction = (label, action) => {
        const button = node("button", label, "secondary"); button.type = "button";
        button.addEventListener("click", action); actions.append(button);
      };
      addAction("表示名を保存", async () => {
        try { clearView(); await model.edit(root.id, input.value); renderRoots(); renderSettings(); notice("表示名を保存しました。"); }
        catch (error) { fail(error); }
      });
      addAction("再選択", () => startPicker(root.id));
      addAction("登録削除", async () => {
        try { clearView(); await model.remove(root.id); states.delete(root.id); renderRoots(); renderSettings(); notice("登録を削除しました。"); }
        catch (error) { fail(error); }
      });
      cell.append(actions); tr.append(cell); $("roots").append(tr);
    }
  }
  $("root").addEventListener("change", () => choose($("root").value));
  $("query").addEventListener("compositionstart", () => { composing = true; clearTimeout(timer); searchGeneration++; clearPreview(); });
  $("query").addEventListener("compositionend", () => { composing = false; runSearch(); });
  $("query").addEventListener("input", event => {
    if (composing || event.isComposing) return;
    searchGeneration++; clearPreview(); clearTimeout(timer); timer = setTimeout(runSearch, 120);
  });
  $("search-form").addEventListener("submit", event => { event.preventDefault(); if (!composing) runSearch(); });
  $("settings-button").addEventListener("click", () => view(true));
  $("back").addEventListener("click", () => view(false));
  $("add").addEventListener("click", () => startPicker(crypto.randomUUID()));
  window.addEventListener("pagehide", () => {
    model.cancel(); model.sessions.clear(); pickerTask = null; $("picker").value = ""; clearView();
  });
  window.addEventListener("pageshow", event => { if (event.persisted) { renderRoots(); renderSettings(); runSearch(); } });
  try { await model.load(); }
  catch (error) { fail(error); }
  $("add").disabled = false; $("settings-button").disabled = false;
  renderRoots(); renderSettings(); runSearch();
})();

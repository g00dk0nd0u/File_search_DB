/* Classic scripts work directly from file:// without modules or a server. */
(async function () {
  "use strict";
  const $ = id => document.getElementById(id), S = FolderSearch, C = SafariCore;
  const model = new C.Model(new C.Storage());
  const states = new Map();
  let searchGeneration = 0, previewGeneration = 0, objectURL, pickerTask, composing = false, timer;
  const node = (tag, text, cls) => {
    const item = document.createElement(tag);
    if (text !== undefined) item.textContent = text;
    if (cls) item.className = cls;
    return item;
  };
  const state = () => {
    if (!states.has(model.activeId)) states.set(model.activeId, {expanded: new Set(), selected: null});
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
  function clearView() { searchGeneration++; clearTimeout(timer); clearPreview(); $("results").replaceChildren(); }
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
    $("reselect").disabled = !model.activeId;
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
  function childList(session, path, query, matched, ui) {
    const list = node("ul", undefined, "children");
    const children = S.children(session.snapshot, path, query, matched);
    let offset = 0;
    function more() {
      const end = Math.min(children.length, offset + 200);
      while (offset < end) {
        const child = children[offset++], li = node("li");
        if (child.kind === "directory") li.append(folder(session, child, "", ui));
        else {
          const button = node("button", child.name, "file"); button.type = "button";
          button.setAttribute("aria-pressed", String(ui.selected === child.path));
          button.addEventListener("click", () => showPreview(child.path, button)); li.append(button);
        }
        list.append(li);
      }
      if (offset < children.length) {
        const button = node("button", "さらに表示", "secondary"); button.type = "button";
        button.addEventListener("click", () => { button.remove(); more(); }); list.append(button);
      }
    }
    more();
    if (!children.length) list.append(node("li", "表示する直下項目はありません。", "hint"));
    return list;
  }
  function folder(session, row, query, ui) {
    const details = node("details", undefined, "folder"), summary = node("summary", row.name);
    details.append(summary);
    details.append(node("p", row.path || session.rootName, "path"));
    let populated = false;
    const populate = () => {
      if (populated) return; populated = true;
      details.append(childList(session, row.path, query, row.folderNameMatched, ui));
    };
    if (ui.expanded.has(row.path)) { details.open = true; populate(); }
    details.addEventListener("toggle", () => {
      if (details.open) { ui.expanded.add(row.path); populate(); }
      else ui.expanded.delete(row.path);
    });
    return details;
  }
  async function runSearch() {
    clearTimeout(timer);
    const ticket = ++searchGeneration, id = model.activeId, session = model.sessions.get(id);
    const query = $("query").value;
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
      const ui = state();
      // Keep expansion/selection state while typing; remove previews outside results.
      if (!rows.some(row => S.children(session.snapshot, row.path, query, row.folderNameMatched)
        .some(child => child.path === ui.selected))) clearPreview();
      const fragment = document.createDocumentFragment();
      for (const row of rows) fragment.append(folder(session, row, query, ui));
      $("results").replaceChildren(fragment);
      $("meta").textContent = rows.length ? rows.length + " フォルダ" + (rows.length === 100 ? "（上限100件。検索語で絞り込んでください）" : "") : "一致するフォルダはありません。";
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
  $("reselect").addEventListener("click", () => startPicker(model.activeId));
  window.addEventListener("pagehide", () => {
    model.cancel(); model.sessions.clear(); pickerTask = null; $("picker").value = ""; clearView();
  });
  window.addEventListener("pageshow", event => { if (event.persisted) { renderRoots(); renderSettings(); runSearch(); } });
  try { await model.load(); }
  catch (error) { fail(error); }
  $("add").disabled = false; $("settings-button").disabled = false;
  renderRoots(); renderSettings(); runSearch();
})();

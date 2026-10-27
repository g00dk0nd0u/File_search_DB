/* No modules, fetch, workers, server, or runtime dependencies. */
(async function () {
  "use strict";
  const $ = (id) => document.getElementById(id),
    S = FolderSearch,
    FS = FolderFS;
  let db,
    roots = [],
    snapshot,
    activeId = "",
    generation = 0,
    loadGeneration = 0,
    busy = false,
    loading = false,
    controller;
  let ui = {
    query: "",
    rootId: "",
    theme: "light",
    expanded: [],
    collapsed: [],
    expansionContext: null,
    selected: {},
  };
  const urls = new Map();
  // A failed automatic attempt is retried only by explicit user action.
  const attempted = new Set(),
    scans = new Map(),
    blocked = new Set();
  const accessError = (e) => ["NotAllowedError", "SecurityError"].includes(e.name);
  async function readable(root) {
    try {
      return await FS.permission(root.handle);
    } catch (_) {
      return false;
    }
  }
  function hideDenied(root) {
    blocked.add(root.id);
    if (activeId !== root.id) return;
    ++generation;
    snapshot = undefined;
    clearPreviews();
    $("results").replaceChildren();
    $("meta").textContent =
      "Read access required. Open Settings → Allow access / Reselect.";
  }
  async function stopScan(root) {
    const task = scans.get(root.id);
    if (task) {
      task.controller.abort();
      await task.promise;
    }
  }
  async function recover(root) {
    blocked.delete(root.id);
    attempted.delete(root.id);
    if (activeId === root.id) await loadActive();
  }
  function autoRefresh(root) {
    if (!attempted.has(root.id) && !blocked.has(root.id)) refresh(root);
  }
  const element = (tag, text, cls) => {
    const e = document.createElement(tag);
    if (text !== undefined) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  };
  const activeRoot = () => roots.find((r) => r.id === activeId);
  function notice(message = "", error = false) {
    $("notice").hidden = !message;
    $("notice").textContent = message;
    $("notice").className = error ? "error" : "";
  }
  function fail(error) {
    notice(
      error.name === "AbortError"
        ? "Cancelled. The previous index has been kept."
        : `${error.message || error} — Existing saved data has been kept.`,
      error.name !== "AbortError",
    );
  }
  function revoke(pane) {
    if (urls.has(pane)) {
      URL.revokeObjectURL(urls.get(pane));
      urls.delete(pane);
    }
  }
  let previewContext;
  function clearPreviews() {
    $("preview-panel").hidden = true; $("workspace").className = "workspace";
    const pane = $("preview");
    pane._request = null;
    for (const pane of urls.keys()) revoke(pane);
    pane.replaceChildren();
  }
  function saveUI() {
    if (db) db.put("settings", "ui", ui).catch(fail);
  }
  function theme() {
    document.documentElement.dataset.theme = ui.theme;
    for (const button of document.querySelectorAll(".theme"))
      button.setAttribute("aria-pressed", String(ui.theme === "dark"));
  }
  for (const button of document.querySelectorAll(".theme"))
    button.onclick = () => {
      ui.theme = ui.theme === "dark" ? "light" : "dark";
      theme();
      saveUI();
    };
  function settings(show) {
    $("settings-view").hidden = !show;
    $("search-view").hidden = show;
    document.title = show ? "Folder Manager" : "Folder Search";
  }
  $("settings-button").onclick = () => settings(true);
  $("back").onclick = () => settings(false);
  function highlight(node, text, queryText) {
    const terms = S.terms(S.parse(queryText));
    const folded = S.fold(text), ranges = [];
    // Search and display use the same casefold; retain offsets in the original
    // string so expansions (ß → ss) and surrogate pairs stay intact.
    const offsets = [];
    let offset = 0;
    for (const c of text) {
      for (let i = 0; i < S.fold(c).length; i++)
        offsets.push([offset, offset + c.length]);
      offset += c.length;
    }
    for (const term of terms) {
      let start = 0, at;
      while (term && (at = folded.indexOf(term, start)) !== -1) {
        ranges.push([offsets[at][0], offsets[at + term.length - 1][1]]);
        start = at + 1; // Include overlapping occurrences.
      }
    }
    ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = [];
    for (const range of ranges) {
      const last = merged.at(-1);
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
      else merged.push([...range]);
    }
    offset = 0;
    for (const [start, end] of merged) {
      if (start > offset) node.append(document.createTextNode(text.slice(offset, start)));
      node.append(element("mark", text.slice(start, end)));
      offset = end;
    }
    if (offset < text.length) node.append(document.createTextNode(text.slice(offset)));
  }
  function expansion(key, open) {
    ui.expanded = ui.expanded.filter((p) => p !== key);
    ui.collapsed = ui.collapsed.filter((p) => p !== key);
    (open ? ui.expanded : ui.collapsed).push(key);
    saveUI();
  }
  function syncExpansion() {
    const context = JSON.stringify([activeId, ui.query, $("modified").value, $("format").value]);
    if (ui.expansionContext !== null && ui.expansionContext !== context) {
      ui.expanded = [];
      ui.collapsed = [];
      ui.selected = {};
    }
    ui.expansionContext = context;
    saveUI();
  }

  function renderRoots() {
    roots.sort(
      (a, b) =>
        S.compare(S.fold(a.displayName), S.fold(b.displayName)) ||
        S.compare(a.id, b.id),
    );
    $("root").replaceChildren();
    $("roots").replaceChildren();
    if (!roots.length)
      $("root").append(new Option("No folders registered", ""));
    for (const root of roots) {
      $("root").append(new Option(root.displayName, root.id));
      const row = element("tr"),
        name = element("td"),
        input = element("input");
      input.value = root.displayName;
      input.setAttribute("aria-label", `Display Name: ${root.displayName}`);
      input.disabled = busy;
      const save = element("button", "Save", "secondary");
      save.disabled = busy;
      const rename = async () => {
        const displayName = input.value.trim();
        if (!displayName) {
          notice("Display Name is required", true);
          return;
        }
        try {
          const updated = { ...root, displayName };
          await db.put("roots", root.id, updated);
          roots = roots.map((r) => (r.id === root.id ? updated : r));
          renderRoots();
          notice("Display Name updated");
        } catch (e) {
          fail(e);
        }
      };
      save.onclick = () => run(rename);
      input.onkeydown = (e) => {
        if (e.key === "Enter") run(rename);
      };
      name.append(input, save);
      const path = element("td", root.directoryName + "/", "relative-path");
      const status = element(
        "td",
        root.lastScanned
          ? `${root.folderCount} folders · ${root.fileCount} files\n${new Date(root.lastScanned).toLocaleString()}`
          : "Not scanned",
        "root-status",
      );
      status.style.whiteSpace = "pre-line";
      const cell = element("td"),
        actions = element("div", undefined, "actions");
      for (const [label, action, cls] of [
        ["Reload", () => reload(root), "secondary"],
        [
          "Allow access",
          async () => {
            try {
              if (!(await FS.permission(root.handle, true))) {
                hideDenied(root);
                return;
              }
            } catch (e) {
              hideDenied(root);
              throw e;
            }
            await stopScan(root);
            await recover(root);
            notice("Read access granted");
          },
          "secondary",
        ],
        ["Reselect", () => reselect(root), "secondary"],
        [
          "Delete",
          async () => {
            if (
              !confirm(
                `Remove registration for “${root.displayName}”? Your files will remain.`,
              )
            )
              return;
            await stopScan(root);
            await db.remove(root.id);
            roots = roots.filter((r) => r.id !== root.id);
            if (activeId === root.id) {
              activeId = roots[0]?.id || "";
              ui.expanded = [];
              ui.selected = {};
            }
            await loadActive();
            notice("Registration removed");
          },
          "danger",
        ],
      ]) {
        const b = element("button", label, cls);
        b.disabled =
          busy || (label === "Reselect" && !window.showDirectoryPicker);
        b.onclick = () => run(action);
        actions.append(b);
      }
      cell.append(actions);
      row.append(name, path, status, cell);
      $("roots").append(row);
    }
    $("root").value = activeId;
    $("root").disabled = busy || !roots.length;
    $("search").disabled = !db || !roots.length;
    $("add").disabled = !db || busy || !window.showDirectoryPicker;
  }
  async function run(action) {
    if (busy) return;
    busy = true;
    renderRoots();
    notice();
    try {
      await action();
    } catch (e) {
      fail(e);
    } finally {
      busy = false;
      controller = undefined;
      $("progress-wrap").hidden = true;
      renderRoots();
    }
  }
  async function loadActive() {
    const version = ++loadGeneration;
    loading = true;
    ++generation;
    snapshot = undefined;
    clearPreviews();
    $("results").replaceChildren();
    $("meta").textContent = "";
    renderRoots();
    ui.rootId = activeId;
    saveUI();
    const root = activeRoot();
    if (!root) {
      loading = false;
      await showResults();
      return;
    }
    const allowed = await readable(root);
    if (version !== loadGeneration) return;
    if (!allowed || blocked.has(root.id)) {
      loading = false;
      hideDenied(root);
      return;
    }
    const value = await db.get("snapshots", root.id);
    if (version !== loadGeneration) return;
    loading = false;
    snapshot = value;
    await showResults();
  }
  function refresh(root, manual = false) {
    // Register the task before yielding, including permission checks and commit.
    if (scans.has(root.id)) return scans.get(root.id).promise;
    attempted.add(root.id);
    const task = { controller: new AbortController() };
    scans.set(root.id, task);
    task.promise = (async () => {
      await Promise.resolve();
      try {
        if (!(await readable(root))) {
          hideDenied(root);
          return;
        }
        if (manual) {
          controller = task.controller;
          $("progress-wrap").hidden = false;
        }
        const next = await FS.scan(root.handle, {
          signal: task.controller.signal,
          progress: manual
            ? (p) => {
                $("progress").textContent =
                  `${root.displayName}: ${p.folders} folders · ${p.files} files`;
              }
            : undefined,
        });
        if (task.controller.signal.aborted)
          throw new DOMException("Scan cancelled", "AbortError");
        if (!(await readable(root))) {
          hideDenied(root);
          return;
        }
        const current = roots.find((r) => r.id === root.id);
        if (!current || task.controller.signal.aborted) return;
        const updated = {
          ...current,
          lastScanned: new Date().toISOString(),
          folderCount: next.folders.length - 1,
          fileCount: next.files.length,
        };
        await db.commit(updated, next);
        roots = roots.map((r) => (r.id === root.id ? updated : r));
        renderRoots();
        if (activeId === root.id) {
          // Invalidate a pending load of the old snapshot, keep expansion/selection.
          ++loadGeneration;
          loading = false;
          snapshot = next;
          await showResults();
          if (manual) notice("Reload complete");
        }
      } catch (e) {
        if (accessError(e) || !(await readable(root))) hideDenied(root);
        else if (activeId === root.id) fail(e);
      } finally {
        scans.delete(root.id);
      }
    })();
    return task.promise;
  }
  async function reload(root) {
    if (scans.has(root.id)) {
      controller = scans.get(root.id).controller;
      return scans.get(root.id).promise;
    }
    // Only this explicit user gesture may request permission.
    try {
      if (!(await FS.permission(root.handle, true))) {
        hideDenied(root);
        return;
      }
    } catch (e) {
      hideDenied(root);
      throw e;
    }
    blocked.delete(root.id);
    await refresh(root, true);
  }
  async function reselect(root) {
    const handle = await window.showDirectoryPicker({ mode: "read" });
    if (!(await root.handle.isSameEntry(handle)))
      throw Error(
        "Choose the same registered folder. Add a different folder with Add Directory.",
      );
    await stopScan(root);
    const updated = { ...root, handle };
    await db.put("roots", root.id, updated);
    roots = roots.map((r) => (r.id === root.id ? updated : r));
    await recover(updated);
    notice("Folder handle reconnected.");
  }
  $("cancel").onclick = () => controller?.abort();
  $("add").onclick = () =>
    run(async () => {
      const handle = await window.showDirectoryPicker({ mode: "read" });
      for (const root of roots)
        if (await root.handle.isSameEntry(handle)) {
          activeId = root.id;
          ui.expanded = [];
          ui.selected = {};
          await loadActive();
          notice(
            "This folder is already registered. Use Reload to refresh it.",
          );
          return;
        }
      const root = {
        id: crypto.randomUUID(),
        displayName: handle.name,
        directoryName: handle.name,
        handle,
        lastScanned: "",
        folderCount: 0,
        fileCount: 0,
      };
      // Save a registration even if its initial scan is later cancelled or denied.
      await db.put("roots", root.id, root);
      roots.push(root);
      activeId = root.id;
      ui.expanded = [];
      ui.selected = {};
      await loadActive();
    });
  $("root").onchange = () => {
    activeId = $("root").value;
    ui.expanded = [];
    ui.selected = {};
    loadActive().catch(fail);
  };
  let searchTimer,
    composing = false;
  function submitSearch() {
    clearTimeout(searchTimer);
    ui.query = $("query").value;
    syncExpansion();
    saveUI();
    showResults().catch(fail);
  }
  $("search-form").onsubmit = (e) => {
    e.preventDefault();
    if (!composing) submitSearch();
  };
  $("query").oninput = () => {
    clearTimeout(searchTimer);
    ++generation;
    clearPreviews();
    ui.query = $("query").value;
    if (!composing) searchTimer = setTimeout(submitSearch, 250);
  };
  $("query").oncompositionstart = () => {
    composing = true;
    clearTimeout(searchTimer);
  };
  $("query").oncompositionend = () => {
    composing = false;
    searchTimer = setTimeout(submitSearch, 250);
  };
  $("preview-close").onclick = () => {
    clearPreviews(); ui.selected = {}; saveUI();
    for (const button of $("results").querySelectorAll(".item")) {
      button.classList.remove("selected"); button.setAttribute("aria-pressed", "false");
    }
  };
  for (const id of ["modified", "format"]) $(id).onchange = () => {
    ++generation; clearPreviews(); if (!composing) submitSearch();
  };
  function paneMessage(pane, text) {
    revoke(pane);
    pane.replaceChildren(element("p", text, "hint"));
  }
  async function preview(item, pane, root) {
    const token = {};
    $("preview-panel").hidden = false; $("workspace").className = "workspace preview-open";
    pane._request = token;
    paneMessage(pane, "Loading…");
    try {
      const allowed = await readable(root);
      if (pane._request !== token) return;
      if (!allowed) {
        hideDenied(root);
        return;
      }
      const file = await FS.fileAt(root.handle, item.path);
      if (!pane.isConnected || pane._request !== token) return;
      const ext = file.name.split(".").at(-1).toLowerCase();
      pane.replaceChildren(element("h2", file.name, "preview-title"));
      if (/^(docx?|xlsx?|pptx?|odt|ods|odp)$/.test(ext)) {
        pane.append(
          element(
            "p",
            "Office files cannot be previewed directly in this browser.",
            "hint",
          ),
        );
        return;
      }
      const imageTypes = {
        avif: "image/avif",
        bmp: "image/bmp",
        gif: "image/gif",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        jfif: "image/jpeg",
        png: "image/png",
        svg: "image/svg+xml",
        tif: "image/tiff",
        tiff: "image/tiff",
        webp: "image/webp",
        heic: "image/heic",
        heif: "image/heif",
      };
      if (ext === "pdf" || imageTypes[ext]) {
        const url = URL.createObjectURL(
          file.slice(
            0,
            file.size,
            ext === "pdf" ? "application/pdf" : imageTypes[ext],
          ),
        );
        urls.set(pane, url);
        const media = element(ext === "pdf" ? "iframe" : "img");
        media.src = url;
        if (ext === "pdf") {
          media.title = file.name;
          pane.append(
            element(
              "p",
              "PDF rendering depends on the Edge PDF viewer and its policies.",
              "hint",
            ),
          );
        } else {
          media.alt = file.name;
          media.onerror = () => {
            if (pane._request === token)
              paneMessage(
                pane,
                "This image format could not be rendered by Edge.",
              );
          };
        }
        pane.append(media);
      } else {
        const result = await FS.textPreview(file);
        if (!pane.isConnected || pane._request !== token) return;
        if (result.error) pane.append(element("p", result.error, "hint"));
        else {
          pane.append(
            element(
              "p",
              result.encoding +
                (result.truncated ? " · first 16 KiB only" : ""),
              "hint",
            ),
            element("pre", result.text),
          );
        }
      }
    } catch (e) {
      if (pane._request !== token) return;
      const allowed = await readable(root);
      if (pane._request !== token) return;
      if (accessError(e) || !allowed) hideDenied(root);
      if (pane.isConnected && pane._request === token)
        paneMessage(
          pane,
          `${e.message} — File may have moved or access expired. Use Settings → Reload / Allow access.`,
        );
    }
  }
  function listItems(
    container,
    items,
    pane,
    localSnapshot,
    root,
    queryText,
    onSelect,
    tree,
    depth = 0,
  ) {
    if (!items.length)
      container.append(element("p", "No items to display.", "hint"));
    let cursor = 0;
    const more = element("button", "Show more items", "secondary more-items");
    const render = () => {
      more.hidden = true;
      let count = 0;
      while (cursor < items.length && count < 100 && (!tree || tree.budget.left > 0)) {
        const item = items[cursor++];
        count++;
        if (tree) tree.budget.left--;
        const b = element(
          "button",
          undefined,
          "link item" +
            (item.kind === "file" && S.matches(item.name, S.parse(queryText))
              ? " file-match"
              : ""),
        );
        if (item.kind === "directory") b.append(document.createTextNode("/"));
        highlight(b, item.name, queryText);
        b.onclick = () => {
          if (onSelect) onSelect(item.path);
          for (const child of $("results").querySelectorAll(".item")) {
            child.classList.remove("selected");
            child.setAttribute("aria-pressed", "false");
          }
          b.classList.add("selected");
          b.setAttribute("aria-pressed", "true");
          preview(item, pane, root);
        };
        if (item.kind === "file") {
          const selected = Object.values(ui.selected).includes(item.path);
          b.setAttribute("aria-pressed", String(selected));
          if (selected) b.classList.add("selected");
        }
        if (tree && item.kind === "directory") {
          const group = element("div", undefined, "subfolder"),
            toggle = element("button", "▸", "link subfolder-toggle"),
            children = element("div", undefined, "subfolder-items"),
            key = JSON.stringify([tree.rowPath, item.path]);
          toggle.setAttribute("aria-label", `Expand / collapse ${item.name}`);
          children.hidden = true;
          let populated = false;
          const setOpen = (open) => {
            children.hidden = !open;
            toggle.textContent = open ? "▾" : "▸";
            toggle.setAttribute("aria-expanded", String(open));
            if (open && !populated) {
              populated = true;
              listItems(children, tree.children.get(item.path) || [], pane,
                localSnapshot, root, queryText, onSelect, tree, depth + 1);
            }
          };
          toggle.onclick = () => {
            const open = children.hidden;
            expansion(key, open);
            tree.budget.left = Math.max(tree.budget.left, 100);
            setOpen(open);
          };
          b.onclick = () => toggle.onclick();
          group.append(toggle, b, children);
          container.append(group);
          setOpen(!ui.collapsed.includes(key) && (depth < 3 || ui.expanded.includes(key)));
        } else container.append(b);
      }
      if (cursor < items.length) {
        more.hidden = false;
        container.append(more);
      }
    };
    more.onclick = () => {
      if (tree) tree.budget.left = 100;
      render();
    };
    render();
  }
  async function showResults() {
    if (composing) return;
    syncExpansion();
    const version = ++generation,
      root = activeRoot(),
      localSnapshot = snapshot,
      queryText = ui.query;
    const options = {days: $("modified").value, format: $("format").value, now: Date.now()};
    const context = JSON.stringify([activeId, queryText, options.days, options.format]);
    if (context !== previewContext) { clearPreviews(); previewContext = context; }
    $("results").replaceChildren();
    if (!root) {
      $("meta").textContent =
        "No search target folders. Open Settings → Add Directory.";
      return;
    }
    $("meta").textContent = "";
    if (loading) return;
    const allowed = await readable(root);
    if (version !== generation) return;
    if (!allowed || blocked.has(root.id)) {
      hideDenied(root);
      return;
    }
    if (!localSnapshot) {
      $("meta").textContent = "No saved index. Open Settings → Reload if needed.";
      autoRefresh(root);
      return;
    }
    $("meta").textContent = "Searching…";
    const rows = await S.search(
      localSnapshot,
      queryText,
      100,
      () => version !== generation,
      options,
    );
    const stillAllowed = await readable(root);
    if (version !== generation) return;
    if (!stillAllowed || blocked.has(root.id)) {
      hideDenied(root);
      return;
    }
    $("meta").textContent = rows.length || !queryText.trim() ? "" : "No matching folders or files.";
    if (options.days !== "all" && options.days && localSnapshot.files.some(file => !Number.isFinite(file.lastModified)))
      $("meta").textContent += " 更新日時が不明な旧索引のファイルは除外しています。Settings → Reload を実行してください。";
    // Build once per render rather than rescanning the full index per tree node.
    const children = new Map(), byPath = new Map(), budget = { left: 500 };
    const {visible} = await S.visibility(localSnapshot, queryText, options, () => version !== generation);
    if (version !== generation) return;
    let indexed = 0;
    for (const [entries, kind] of [[localSnapshot.folders, "directory"], [localSnapshot.files, "file"]]) {
      for (const item of rows.length ? entries : []) {
        if (item.path === "" || !visible.has(item.path)) continue;
        if (!children.has(item.parent)) children.set(item.parent, []);
        const child = { ...item, kind };
        children.get(item.parent).push(child);
        byPath.set(item.path, child);
        if (++indexed % 500 === 0) {
          await S.pause();
          if (version !== generation) return;
        }
      }
    }
    for (const items of children.values()) items.sort((a, b) =>
      (a.kind === b.kind ? 0 : a.kind === "directory" ? -1 : 1) ||
      S.compare(S.fold(a.name), S.fold(b.name)));
    // Building the child index yields too: permissions/root/query may have
    // changed since the check after search. Never publish stale/denied results.
    const renderAllowed = await readable(root);
    if (version !== generation) return;
    if (!renderAllowed || blocked.has(root.id)) {
      hideDenied(root);
      return;
    }
    const pane = $("preview");
    const selected = Object.values(ui.selected).map(path => byPath.get(path)).find(item => item?.kind === "file");
    if (!selected && !$("preview-panel").hidden) clearPreviews();
    // Drop selections that disappeared after a refresh or no longer match.
    ui.selected = Object.fromEntries(Object.entries(ui.selected).filter(([, path]) => byPath.get(path)?.kind === "file"));
    saveUI();
    for (const row of rows) {
      const article = element("article", undefined, "result"),
        header = element("div", undefined, "result-header");
      const toggle = element("button", undefined, "link folder-toggle");
      const parent = row.path.split("/").slice(0, -1).join("/");
      if (parent) {
        const path = element("span", undefined, "path");
        highlight(path, parent + " / ", queryText);
        toggle.append(path);
      }
      const arrow = element("span", "▸ ");
      toggle.append(arrow);
      highlight(toggle, row.name, queryText);
      const detail = element("div", undefined, "detail");
      detail.hidden = true;
      const left = element("div", undefined, "children");
      detail.append(left);
      header.append(toggle);
      article.append(header, detail);
      $("results").append(article);
      let populated = false;
      const expand = (open) => {
        detail.hidden = !open;
        arrow.textContent = open ? "▾ " : "▸ ";
        toggle.setAttribute("aria-expanded", String(!detail.hidden));

        if (!detail.hidden && !populated) {
          populated = true;
          listItems(
            left,
            children.get(row.path) || [],
            pane,
            localSnapshot,
            root,
            queryText,
            (path) => {
              ui.selected = { [row.path]: path };
              saveUI();
            },
            { children, budget, rowPath: row.path },
          );
        }
      };
      toggle.setAttribute("aria-expanded", "false");
      toggle.onclick = () => {
        const open = detail.hidden;
        expansion(row.path, open);
        budget.left = Math.max(budget.left, 100);
        expand(open);
      };
      expand(!ui.collapsed.includes(row.path));
    }
    autoRefresh(root);
  }
  window.addEventListener("pagehide", clearPreviews);
  try {
    if (!window.indexedDB)
      throw Error(
        "IndexedDB is unavailable. Use a normal Edge window with local storage enabled.",
      );
    db = await FolderStore.open();
    roots = await db.roots();
    const stored = await db.get("settings", "ui");
    if (stored) ui = { ...ui, ...stored };
    theme();
    $("query").value = ui.query;
    activeId = roots.some((r) => r.id === ui.rootId)
      ? ui.rootId
      : roots[0]?.id || "";
    $("support").textContent =
      window.showDirectoryPicker && window.isSecureContext
        ? ""
        : "Folder selection is unavailable. Open this file in Windows Edge and check browser policies. Read access is required to search saved indexes.";
    $("storage-info").textContent =
      "Absolute paths are not exposed by the browser. Keep this HTML folder in the same location and use the same Edge profile. Clearing browser data deletes this index.";
    await loadActive();
  } catch (e) {
    $("support").textContent = "Could not initialize local storage.";
    fail(e);
  }
})();

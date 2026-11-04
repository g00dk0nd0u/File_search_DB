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
  const urls = new Map(), childIndexes = new WeakMap();
  function resetPaging() {
    $("result-controls").hidden = true;
    $("result-more").hidden = true;
    $("result-more").onclick = null;
    $("result-count").textContent = "";
  }
  // A failed automatic attempt is retried only by explicit user action.
  const attempted = new Set(),
    scans = new Map(),
    blocked = new Set();
  // Latest failure per registration/root, for this page session only.
  // These summaries never enter a root, snapshot, settings or console log.
  const diagnostics = new Map(), history = FS.createDiagnostics();
  // Diagnostic bookkeeping must never interrupt a scan/search/storage operation.
  const log = (method, ...args) => { try { return history[method](...args); } catch (_) {} };
  function diagnosticText(detail) {
    return detail ? `Stage: ${detail.stage}\n${detail.errorName}: ${detail.errorMessage}\nRelative path: ${detail.relativePath}\nProcessed: ${detail.folders} folders · ${detail.files} files` : "";
  }
  function recordFailure(error, key = "registration") {
    if (!error.diagnostic) return;
    diagnostics.set(key, error.diagnostic);
    renderRoots();
  }
  async function permit(root, request = false, counts = {}) {
    if (await FS.permission(root.handle, request, counts)) return true;
    throw FS.failure(new DOMException("Read permission is not granted.", "NotAllowedError"), "permission", counts);
  }
  async function sameEntry(root, handle) {
    try {
      return await FS.operation("isSameEntry", () => root.handle.isSameEntry(handle));
    } catch (error) {
      recordFailure(error, root.id);
      throw error;
    }
  }
  const accessError = (e) => ["NotAllowedError", "SecurityError"].includes(e.name);
  async function readable(root, counts = {}) {
    try {
      return await permit(root, false, counts);
    } catch (error) {
      recordFailure(error, root.id);
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
    resetPaging();
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
  function fail(error, key) {
    recordFailure(error, key);
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
    ui.selected = {};
    for (const button of $("results").querySelectorAll(".item")) {
      button.classList.remove("selected"); button.setAttribute("aria-pressed", "false");
    }
    saveUI();
    const pane = $("preview");
    pane._request = null;
    for (const pane of urls.keys()) revoke(pane);
    pane.replaceChildren();
    $("preview-title").textContent = "Preview";
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
    const registration = diagnostics.get("registration");
    $("registration-diagnostic").hidden = !registration;
    $("registration-diagnostic").textContent = diagnosticText(registration);
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
      if (diagnostics.has(root.id)) {
        const detail = element("details");
        detail.append(element("summary", "Latest failure"), element("pre", diagnosticText(diagnostics.get(root.id)), "diagnostic"));
        status.append(detail);
      }
      const cell = element("td"),
        actions = element("div", undefined, "actions");
      for (const [label, action, cls] of [
        ["Reload", token => reload(root, token), "secondary"],
        [
          "Allow access",
          async () => {
            try {
              await permit(root, true);
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
            diagnostics.delete(root.id);
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
        b.onclick = () => run(action, root.id, ["Reload", "Reselect", "Allow access"].includes(label) ? label : undefined);
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
  async function run(action, key, operation) {
    if (busy) return;
    const token = operation ? log("start", operation, key) : undefined;
    busy = true;
    renderRoots();
    notice();
    try {
      const outcome = await action(token);
      log("finish", token, outcome?.error, outcome?.counts);
    } catch (e) {
      log("finish", token, e);
      fail(e, key);
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
    resetPaging();
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
  function refresh(root, manual = false, token) {
    // Register the task before yielding, including permission checks and commit.
    if (scans.has(root.id)) return scans.get(root.id).promise;
    token = token || log("start", "Auto scan", root.id);
    attempted.add(root.id);
    const task = { controller: new AbortController() };
    scans.set(root.id, task);
    task.promise = (async () => {
      await Promise.resolve();
      try {
        await permit(root);
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
        const counts = { folders: next.folders.length - 1, files: next.files.length };
        if (task.controller.signal.aborted)
          throw FS.failure(new DOMException("Scan cancelled", "AbortError"), "entries", counts);
        await permit(root, false, counts);
        const current = roots.find((r) => r.id === root.id);
        if (!current || task.controller.signal.aborted)
          throw FS.failure(new DOMException("Scan cancelled", "AbortError"), "saveIndex", counts);
        const updated = {
          ...current,
          lastScanned: new Date().toISOString(),
          folderCount: next.folders.length - 1,
          fileCount: next.files.length,
        };
        await FS.operation("saveIndex", () => db.commit(updated, next), counts);
        roots = roots.map((r) => (r.id === root.id ? updated : r));
        diagnostics.delete(root.id);
        renderRoots();
        if (activeId === root.id) {
          // Invalidate a pending load of the old snapshot, keep expansion/selection.
          ++loadGeneration;
          loading = false;
          snapshot = next;
          await showResults();
          if (manual) notice("Reload complete");
        }
        log("finish", token, undefined, counts);
        return {counts};
      } catch (e) {
        log("finish", token, e);
        const denied = accessError(e) || !(await readable(root));
        // A follow-up permission check must not replace the original I/O failure.
        recordFailure(e, root.id);
        if (denied) hideDenied(root);
        else if (activeId === root.id) fail(e, root.id);
        return {error: e};
      } finally {
        scans.delete(root.id);
      }
    })();
    return task.promise;
  }
  async function reload(root, token) {
    if (scans.has(root.id)) {
      controller = scans.get(root.id).controller;
      return scans.get(root.id).promise;
    }
    // Only this explicit user gesture may request permission.
    try {
      await permit(root, true);
    } catch (e) {
      hideDenied(root);
      throw e;
    }
    blocked.delete(root.id);
    return await refresh(root, true, token);
  }
  async function reselect(root) {
    const handle = await FS.operation("showDirectoryPicker", () => window.showDirectoryPicker({ mode: "read" }));
    if (!(await sameEntry(root, handle)))
      throw Error(
        "Choose the same registered folder. Add a different folder with Add Directory.",
      );
    await stopScan(root);
    const updated = { ...root, handle };
    await FS.operation("saveHandle", () => db.put("roots", root.id, updated));
    roots = roots.map((r) => (r.id === root.id ? updated : r));
    await recover(updated);
    notice("Folder handle reconnected.");
  }
  $("cancel").onclick = () => controller?.abort();
  $("clear-diagnostics").onclick = () => { diagnostics.clear(); log("clear"); renderRoots(); };
  $("export-diagnostics").onclick = () => {
    let url;
    try {
      const blob = new Blob(["\ufeff", history.text()], {type: "text/plain;charset=utf-8"});
      url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = history.filename();
      document.body.append(link);
      link.click();
      link.remove();
      notice("Diagnostic log download requested.");
    } catch (_) { notice("Could not export diagnostic log.", true); }
    finally { if (url) setTimeout(() => URL.revokeObjectURL(url), 1000); }
  };
  $("copy-diagnostics").onclick = async () => {
    try {
      await navigator.clipboard.writeText(history.text());
      notice("Diagnostic log copied.");
    } catch (_) { notice("Could not copy diagnostic log. Clipboard permission or browser policy may block it. Use Export Diagnostic Log.", true); }
  };
  $("add").onclick = () =>
    run(async token => {
      const handle = await FS.operation("showDirectoryPicker", () => window.showDirectoryPicker({ mode: "read" }));
      for (const root of roots)
        if (await sameEntry(root, handle)) {
          log("root", token, root.id);
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
      log("root", token, root.id);
      // Save a registration even if its initial scan is later cancelled or denied.
      await FS.operation("saveHandle", () => db.put("roots", root.id, root));
      roots.push(root);
      activeId = root.id;
      ui.expanded = [];
      ui.selected = {};
      await loadActive();
    }, undefined, "Add");
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
    resetPaging();
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
  $("preview-close").onclick = () => { clearPreviews(); setPreviewOpen(false); };
  for (const id of ["modified", "format"]) $(id).onchange = () => {
    ++generation; resetPaging(); clearPreviews(); if (!composing) submitSearch();
  };
  function paneMessage(pane, text) {
    revoke(pane);
    pane.replaceChildren(element("p", text, "hint"));
  }
  async function preview(item, pane, root) {
    const token = {};
    setPreviewOpen(true);
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
      pane.replaceChildren();
      $("preview-title").textContent = file.name;
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
      if (tree && !tree.current()) return;
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
          if (tree && !tree.current()) return;
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
            if (!tree.current()) return;
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
      if (tree && !tree.current()) return;
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
    resetPaging();
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
      () => version !== generation,
      options,
    );
    const stillAllowed = await readable(root);
    if (version !== generation) return;
    if (!stillAllowed || blocked.has(root.id)) {
      hideDenied(root);
      return;
    }
    $("meta").textContent = rows.length || (!queryText.trim() && !S.filtered(options)) ? "" : "No matching folders or files.";
    if (options.days !== "all" && options.days && localSnapshot.files.some(file => !Number.isFinite(file.lastModified)))
      $("meta").textContent += " 更新日時が不明な旧索引のファイルは除外しています。Settings → Reload を実行してください。";
    if (!rows.length) {
      if (queryText.trim() || S.filtered(options)) {
        $("result-controls").hidden = false;
        $("result-count").textContent = "0 / 0";
      }
      clearPreviews(); autoRefresh(root); return;
    }
    const budget = { left: 500 }, cancelled = () => version !== generation;
    const display = await S.visibility(localSnapshot, queryText, options, cancelled);
    if (cancelled()) return;
    let index = childIndexes.get(localSnapshot);
    if (!index) {
      index = await S.childIndex(localSnapshot, cancelled);
      if (!index || cancelled()) return;
      childIndexes.set(localSnapshot, index);
    }
    const lists = await S.displayIndex(index, display, cancelled);
    if (!lists || cancelled()) return;
    // Building the child index yields too: permissions/root/query may have
    // changed since the check after search. Never publish stale/denied results.
    const renderAllowed = await readable(root);
    if (version !== generation) return;
    if (!renderAllowed || blocked.has(root.id)) {
      hideDenied(root);
      return;
    }
    const pane = $("preview");
    const selected = Object.values(ui.selected).find(path => S.containsFile(rows, display, path));
    if (!selected && !$("preview-panel").hidden) clearPreviews();
    // Drop selections that disappeared after a refresh or no longer match.
    ui.selected = Object.fromEntries(Object.entries(ui.selected).filter(([, path]) => S.containsFile(rows, display, path)));
    saveUI();
    let cursor = 0, paging = false;
    const appendNext = async () => {
      if (cancelled() || paging) return;
      paging = true;
      $("result-more").disabled = true;
      try {
        const allowed = await readable(root);
        if (cancelled()) return;
        if (!allowed || blocked.has(root.id)) { hideDenied(root); return; }
        const end = Math.min(cursor + 100, rows.length);
        while (cursor < end) {
          const row = rows[cursor++], children = row.showAll ? lists.all : lists.matched;
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
                { children, budget, rowPath: row.path, current: () => !cancelled() },
              );
            }
          };
          toggle.setAttribute("aria-expanded", "false");
          toggle.onclick = () => {
            if (cancelled()) return;
            const open = detail.hidden;
            expansion(row.path, open);
            budget.left = Math.max(budget.left, 100);
            expand(open);
          };
          expand(ui.expanded.includes(row.path) || (!row.showAll && !ui.collapsed.includes(row.path)));
        }
        $("result-count").textContent = `${cursor} / ${rows.length}`;
        $("result-controls").hidden = false;
        $("result-more").hidden = cursor >= rows.length;
      } finally {
        paging = false;
        if (!cancelled()) $("result-more").disabled = false;
      }
    };
    $("result-more").onclick = appendNext;
    await appendNext();
    if (!cancelled()) autoRefresh(root);
  }

  function resizePreview() {
    const panel = $("preview-panel");
    if (panel.hidden || !panel.getBoundingClientRect) return;
    const viewport = window.visualViewport;
    const bottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
    const available = Math.floor(bottom - Math.max(16, panel.getBoundingClientRect().top) - 12);
    const height = `${Math.max(240, available)}px`;
    if (panel.style.getPropertyValue("--preview-height") !== height)
      panel.style.setProperty("--preview-height", height);
  }
  function setPreviewOpen(open) {
    $("preview-panel").hidden = !open;
    $("workspace").className = open ? "workspace preview-open" : "workspace";
    resizePreview();
  }
  window.addEventListener("resize", resizePreview);
  window.addEventListener("scroll", resizePreview, {passive: true});
  window.visualViewport?.addEventListener("resize", resizePreview);
  window.visualViewport?.addEventListener("scroll", resizePreview);
  if (window.ResizeObserver) {
    let resizeFrame;
    const observer = new window.ResizeObserver(() => {
      window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(resizePreview);
    });
    observer.observe(document.querySelector("main"));
    observer.observe($("preview-title"));
  }
  setPreviewOpen(true);
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

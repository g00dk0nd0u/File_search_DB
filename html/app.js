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
    controller;
  let ui = {
    query: "",
    rootId: "",
    theme: "light",
    expanded: [],
    selected: {},
  };
  const urls = new Map();
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
  function clearPreviews() {
    for (const pane of urls.keys()) revoke(pane);
  }
  function saveUI() {
    if (db) db.put("settings", "ui", ui).catch(fail);
  }
  function theme() {
    document.documentElement.dataset.theme = ui.theme;
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
    let plain = "";
    // Mark original code points even when casefold expands a character (e.g. ß).
    const folded = S.fold(text),
      ranges = [];
    for (const term of terms) {
      let start = 0,
        at;
      while (term && (at = folded.indexOf(term, start)) !== -1) {
        ranges.push([at, at + term.length]);
        start = at + term.length;
      }
    }
    let offset = 0;
    for (const c of text) {
      const end = offset + S.fold(c).length;
      if (ranges.some(([a, b]) => a < end && b > offset)) {
        if (plain) {
          node.append(document.createTextNode(plain));
          plain = "";
        }
        node.append(element("mark", c));
      } else plain += c;
      offset = end;
    }
    if (plain) node.append(document.createTextNode(plain));
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
            if (!(await FS.permission(root.handle, true)))
              throw Error(
                "Read permission denied. Allow folder access in Edge and try again.",
              );
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
    ++generation;
    snapshot = undefined;
    clearPreviews();
    $("results").replaceChildren();
    renderRoots();
    ui.rootId = activeId;
    saveUI();
    const value = activeId ? await db.get("snapshots", activeId) : undefined;
    if (version !== loadGeneration) return;
    snapshot = value;
    await showResults();
  }
  async function reload(root) {
    // Called directly by a user gesture, before any storage work.
    if (!(await FS.permission(root.handle, true)))
      throw Error(
        "Read permission denied. Use Allow access or Reselect; the previous index is still searchable.",
      );
    controller = new AbortController();
    $("progress-wrap").hidden = false;
    const next = await FS.scan(root.handle, {
      signal: controller.signal,
      progress: (p) => {
        $("progress").textContent =
          `${root.displayName}: ${p.folders} folders · ${p.files} files`;
      },
    });
    if (controller.signal.aborted)
      throw new DOMException("Scan cancelled", "AbortError");
    const updated = {
      ...root,
      lastScanned: new Date().toISOString(),
      folderCount: next.folders.length - 1,
      fileCount: next.files.length,
    };
    await db.commit(updated, next);
    roots = roots.map((r) => (r.id === root.id ? updated : r));
    if (activeId === root.id) {
      ui.expanded = [];
      ui.selected = {};
      await loadActive();
    }
    notice(
      `Reload complete: ${updated.folderCount} folders · ${updated.fileCount} files`,
    );
  }
  async function reselect(root) {
    const handle = await window.showDirectoryPicker({ mode: "read" });
    if (!(await root.handle.isSameEntry(handle)))
      throw Error(
        "Choose the same registered folder. Add a different folder with Add Directory.",
      );
    const updated = { ...root, handle };
    await db.put("roots", root.id, updated);
    roots = roots.map((r) => (r.id === root.id ? updated : r));
    notice("Folder handle reconnected. Use Reload to refresh the index.");
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
      await reload(root);
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
    ui.expanded = [];
    ui.selected = {};
    saveUI();
    showResults().catch(fail);
  }
  $("search-form").onsubmit = (e) => {
    e.preventDefault();
    if (!composing) submitSearch();
  };
  $("query").oninput = () => {
    clearTimeout(searchTimer);
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
  function paneMessage(pane, text) {
    revoke(pane);
    pane.replaceChildren(element("p", text, "hint"));
  }
  async function preview(item, pane, localSnapshot, root, queryText) {
    const token = {};
    pane._request = token;
    if (item.kind === "directory") {
      revoke(pane);
      pane.replaceChildren(element("h2", item.name + "/", "preview-title"));
      const back = element("button", "← Parent folder", "secondary");
      back.onclick = () =>
        preview(
          {
            name: item.parent || root.directoryName,
            path: item.parent || "",
            parent: item.parent?.split("/").slice(0, -1).join("/") || "",
            kind: "directory",
          },
          pane,
          localSnapshot,
          root,
          queryText,
        );
      if (item.path) pane.append(back);
      listItems(
        pane,
        S.children(localSnapshot, item.path),
        pane,
        localSnapshot,
        root,
        queryText,
      );
      return;
    }
    paneMessage(pane, "Loading…");
    try {
      if (!(await FS.permission(root.handle, true)))
        throw Error("Read permission denied. Use Settings → Allow access.");
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
  ) {
    if (!items.length)
      container.append(element("p", "No items to display.", "hint"));
    for (const item of items) {
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
        for (const child of container.querySelectorAll(".selected"))
          child.classList.remove("selected");
        b.classList.add("selected");
        preview(item, pane, localSnapshot, root, queryText);
      };
      container.append(b);
    }
  }
  async function showResults() {
    const version = ++generation,
      root = activeRoot(),
      localSnapshot = snapshot,
      queryText = ui.query;
    clearPreviews();
    $("results").replaceChildren();
    if (!root) {
      $("meta").textContent =
        "No search target folders. Open Settings → Add Directory.";
      return;
    }
    if (!localSnapshot) {
      $("meta").textContent = "No saved index. Open Settings → Reload.";
      return;
    }
    $("meta").textContent = "Searching…";
    const rows = await S.search(
      localSnapshot,
      queryText,
      100,
      () => version !== generation,
    );
    if (version !== generation) return;
    $("meta").textContent = queryText.trim()
      ? `${rows.length} folders${rows.length === 100 ? " (maximum 100 shown)" : ""} · ${root.displayName}`
      : "Enter a keyword to search.";
    for (const row of rows) {
      const article = element("article", undefined, "result"),
        header = element("div", undefined, "result-header");
      const toggle = element("button", undefined, "link folder-toggle");
      const parent = row.path.split("/").slice(0, -1).join("/");
      if (parent) toggle.append(element("span", parent + " / ", "path"));
      toggle.append(document.createTextNode("▸ "));
      highlight(toggle, row.name, queryText);
      const detail = element("div", undefined, "detail");
      detail.hidden = true;
      const left = element("div", undefined, "children"),
        pane = element("div", undefined, "preview");
      paneMessage(pane, "Select a file to preview it here.");
      detail.append(left, pane);
      header.append(
        toggle,
        element(
          "span",
          row.fileMatchCount ? `${row.fileMatchCount} files` : "",
          "badge",
        ),
      );
      article.append(header, detail);
      $("results").append(article);
      let populated = false;
      const expand = () => {
        detail.hidden = !detail.hidden;
        toggle.setAttribute("aria-expanded", String(!detail.hidden));
        ui.expanded = ui.expanded.filter((p) => p !== row.path);
        if (!detail.hidden) ui.expanded.push(row.path);
        saveUI();
        if (!detail.hidden && !populated) {
          populated = true;
          listItems(
            left,
            S.children(
              localSnapshot,
              row.path,
              queryText,
              row.folderNameMatched,
            ),
            pane,
            localSnapshot,
            root,
            queryText,
            (path) => {
              ui.selected[row.path] = path;
              saveUI();
            },
          );
          const selected = S.children(
            localSnapshot,
            row.path,
            queryText,
            row.folderNameMatched,
          ).find((i) => i.path === ui.selected[row.path]);
          // Restore selection without requesting permission outside a user gesture.
          if (selected)
            paneMessage(
              pane,
              `Previously selected: ${selected.name}. Select it again to preview.`,
            );
        }
        if (detail.hidden) {
          pane._request = null;
          paneMessage(pane, "Select a file to preview it here.");
        }
      };
      toggle.setAttribute("aria-expanded", "false");
      toggle.onclick = expand;
      if (ui.expanded.includes(row.path)) expand();
    }
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
        ? "Local HTML edition · read-only folder access · index stored in this Edge profile"
        : "Folder selection is unavailable. Open this file in Windows Edge and check browser policies. Saved indexes can still be searched.";
    $("storage-info").textContent =
      "Absolute paths are not exposed by the browser. Keep this HTML folder in the same location and use the same Edge profile. Clearing browser data deletes this index.";
    await loadActive();
  } catch (e) {
    $("support").textContent = "Could not initialize local storage.";
    fail(e);
  }
})();

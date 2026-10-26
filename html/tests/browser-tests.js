(async function () {
  "use strict";
  const log = (text) => {
    document.getElementById("log").textContent += text + "\n";
  };
  const check = (ok, message) => {
    if (!ok) throw Error(message);
    log("PASS " + message);
  };
  let store, saved, url;
  function release() {
    if (url) URL.revokeObjectURL(url);
    url = undefined;
  }
  const preview = document.getElementById("preview");
  async function restore() {
    saved = await store.get("settings", "realDirectory");
    log(
      "Saved marker: " +
        JSON.stringify(await store.get("settings", "restartMarker")),
    );
    if (saved) {
      log(
        `Restored real handle: ${saved.handle.name}; permission: ${await saved.handle.queryPermission({ mode: "read" })}; ${saved.snapshot.folders.length - 1} folders / ${saved.snapshot.files.length} files`,
      );
      renderFiles();
    } else log("No real directory saved yet.");
  }
  function renderFiles() {
    const container = document.getElementById("files");
    container.replaceChildren();
    for (const file of saved.snapshot.files.slice(0, 100)) {
      const button = document.createElement("button");
      button.textContent = file.path;
      button.className = "item link";
      button.onclick = async () => {
        try {
          if (!(await FolderFS.permission(saved.handle, true)))
            throw Error("Permission denied");
          const blob = await FolderFS.fileAt(saved.handle, file.path);
          release();
          preview.replaceChildren();
          const ext = file.name.split(".").at(-1).toLowerCase();
          if (
            ext === "pdf" ||
            ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext)
          ) {
            const media = document.createElement(
              ext === "pdf" ? "iframe" : "img",
            );
            url = URL.createObjectURL(
              blob.slice(
                0,
                blob.size,
                ext === "pdf" ? "application/pdf" : blob.type || "image/" + ext,
              ),
            );
            media.src = url;
            media.title = file.name;
            media.alt = file.name;
            preview.append(media);
            log(
              "Blob URL created for " +
                file.path +
                " — visually confirm rendering (not an automatic PASS).",
            );
          } else {
            const result = await FolderFS.textPreview(blob),
              pre = document.createElement("pre");
            pre.textContent = result.error || result.text;
            preview.append(pre);
            log(
              "Text preview: " +
                file.path +
                " " +
                JSON.stringify({
                  encoding: result.encoding,
                  truncated: result.truncated,
                  error: result.error,
                }),
            );
          }
        } catch (e) {
          log("FAIL " + e.name + ": " + e.message);
        }
      };
      container.append(button);
    }
  }
  function action(id, fn) {
    document.getElementById(id).onclick = async () => {
      try {
        await fn();
      } catch (e) {
        log("FAIL " + e.name + ": " + e.message);
      }
    };
  }
  log(
    `URL: ${location.href}\nBrowser: ${navigator.userAgent}\nSecure context: ${isSecureContext}; picker: ${typeof window.showDirectoryPicker}`,
  );
  try {
    store = await FolderStore.open("file-search-html-tests-v1");
  } catch (e) {
    log("FAIL IndexedDB initialization: " + e.message);
    return;
  }
  action("core", async () => {
    const result = await runCoreTests(FolderSearch, FolderFS);
    log("PASS core " + JSON.stringify(result));
    const root = { id: "test", displayName: "Before" },
      old = { folders: [{ name: "Empty", path: "" }], files: [] };
    await store.commit(root, old);
    check(
      (await store.roots()).some((r) => r.id === "test"),
      "root saved",
    );
    check(
      (await store.get("snapshots", "test")).folders[0].name === "Empty",
      "snapshot reread",
    );
    let rejected = false;
    try {
      await store.commit({ ...root, displayName: "Bad" }, { bad: () => {} });
    } catch (_) {
      rejected = true;
    }
    check(rejected, "uncloneable transaction rejected");
    check(
      (await store.roots()).find((r) => r.id === "test").displayName ===
        "Before",
      "failed transaction preserves old root",
    );
    check(
      (await store.get("snapshots", "test")).folders[0].name === "Empty",
      "failed transaction preserves old snapshot",
    );
    await store.remove("test");
    check(!(await store.get("snapshots", "test")), "delete cascades snapshot");
    check(
      !(await store.roots()).some((r) => r.id === "test"),
      "delete removes root",
    );
    const marker = {
      time: new Date().toISOString(),
      value: "Retain after full Edge restart",
    };
    await store.put("settings", "restartMarker", marker);
    log("Saved restart marker: " + JSON.stringify(marker));
  });
  action("pick", async () => {
    const handle = await showDirectoryPicker({ mode: "read" });
    const snapshot = await FolderFS.scan(handle, {
      progress: (p) => log("Scan " + JSON.stringify(p)),
    });
    saved = { handle, snapshot };
    await store.put("settings", "realDirectory", saved);
    check(
      (await store.get("settings", "realDirectory")).handle.name ===
        handle.name,
      "real handle structured clone",
    );
    log(
      `Scan saved: ${snapshot.folders.length - 1} folders / ${snapshot.files.length} files. Fully restart Edge next.`,
    );
    renderFiles();
  });
  action("allow", async () => {
    if (!saved) throw Error("Select or restore a directory first");
    check(
      await FolderFS.permission(saved.handle, true),
      "saved handle reauthorized",
    );
  });
  action("restore", restore);
  window.addEventListener("pagehide", release);
  await restore();
})();

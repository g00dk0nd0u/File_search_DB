(function (scope) {
  "use strict";
  async function permission(handle, request = false) {
    if ((await handle.queryPermission({ mode: "read" })) === "granted")
      return true;
    return (
      request &&
      (await handle.requestPermission({ mode: "read" })) === "granted"
    );
  }
  async function scan(handle, { signal, progress = () => {} } = {}) {
    const folders = [{ path: "", parent: null, name: handle.name, depth: 0 }],
      files = [];
    const stack = [{ handle, path: "", depth: 0 }];
    let count = 0;
    while (stack.length) {
      const current = stack.pop();
      // Any enumeration error aborts the new snapshot; old index is retained.
      for await (const [name, child] of current.handle.entries()) {
        if (signal?.aborted)
          throw new DOMException("Scan cancelled", "AbortError");
        if (name.startsWith(".")) continue;
        const path = current.path ? current.path + "/" + name : name;
        const item = {
          name,
          path,
          parent: current.path,
          depth: current.depth + 1,
        };
        if (child.kind === "directory") {
          folders.push(item);
          stack.push({ handle: child, path, depth: item.depth });
        } else if (child.kind === "file") {
          const file = await child.getFile();
          if (signal?.aborted) throw new DOMException("Scan cancelled", "AbortError");
          files.push({ ...item, lastModified: file.lastModified });
        }
        if (++count % 200 === 0) {
          progress({ folders: folders.length - 1, files: files.length });
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      if (signal?.aborted)
        throw new DOMException("Scan cancelled", "AbortError");
      await new Promise((r) => setTimeout(r, 0));
    }
    progress({ folders: folders.length - 1, files: files.length });
    return { folders, files };
  }
  async function fileAt(handle, path) {
    const parts = path.split("/");
    if (parts.some((p) => !p || p === "." || p === ".." || p.includes("\\")))
      throw Error("Invalid relative path");
    let directory = handle;
    for (const part of parts.slice(0, -1))
      directory = await directory.getDirectoryHandle(part);
    return (await directory.getFileHandle(parts.at(-1))).getFile();
  }
  async function textPreview(file) {
    const sample = new Uint8Array(await file.slice(0, 16384).arrayBuffer());
    if (sample.includes(0))
      return { error: "Binary files cannot be previewed." };
    let text,
      encoding = "utf-8";
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(sample);
    } catch (_) {
      try {
        encoding = "shift_jis";
        text = new TextDecoder(encoding, { fatal: true }).decode(sample);
      } catch (_) {
        encoding = "utf-8-replace";
        text = new TextDecoder().decode(sample);
      }
    }
    return { text, encoding, truncated: file.size > 16384 };
  }
  scope.FolderFS = { permission, scan, fileAt, textPreview };
  if (typeof module !== "undefined") module.exports = scope.FolderFS;
})(typeof window === "undefined" ? globalThis : window);

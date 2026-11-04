(function (scope) {
  "use strict";
  // Never keep raw browser errors: messages/stacks can contain paths or URLs.
  // Unknown/localized messages are deliberately omitted, rather than redacted
  // with a pattern that might miss credentials or an absolute network path.
  const safeMessages = new Set([
    "A requested file or directory could not be found at the time an operation was processed.",
    "The request is not allowed by the user agent or the platform in the current context.",
    "The operation is insecure.",
    "The user aborted a request.",
    "Scan cancelled",
    "Read permission is not granted.",
  ]);
  const safeNames = new Set([
    "Error", "NotFoundError", "NotAllowedError", "SecurityError", "AbortError",
    "NotReadableError", "InvalidStateError", "DataCloneError", "QuotaExceededError",
    "UnknownError", "TypeError", "TypeMismatchError", "TransactionInactiveError",
    "ConstraintError", "DataError", "ReadOnlyError", "InvalidAccessError",
  ]);
  function failure(error, stage, context = {}) {
    const message = safeMessages.has(error?.message)
      ? error.message : "[Message omitted: may contain private data.]";
    const result = new Error(message);
    result.name = safeNames.has(error?.name) ? error.name : "Error";
    const path = context.relativePath || "";
    const relativePath = !path || (!/[\\:]/.test(path) &&
      path.split("/").every(p => p && p !== "." && p !== "..")) ? path || "." : "[Path omitted]";
    result.diagnostic = Object.freeze({
      stage, errorName: result.name, errorMessage: message, relativePath,
      folders: context.folders || 0, files: context.files || 0,
    });
    return result;
  }
  async function operation(stage, action, context = {}) {
    try {
      return await action();
    } catch (error) {
      throw error?.diagnostic ? error : failure(error, stage,
        typeof context === "function" ? context() : context);
    }
  }
  async function permission(handle, request = false, context = {}) {
    if ((await operation("queryPermission", () => handle.queryPermission({ mode: "read" }), context)) === "granted")
      return true;
    return (
      request &&
      (await operation("requestPermission", () => handle.requestPermission({ mode: "read" }), context)) === "granted"
    );
  }
  async function scan(handle, { signal, progress = () => {} } = {}) {
    const folders = [{ path: "", parent: null, name: handle.name, depth: 0 }],
      files = [];
    const stack = [{ handle, path: "", depth: 0 }];
    let count = 0;
    const counts = (relativePath = "") => ({relativePath, folders: folders.length - 1, files: files.length});
    while (stack.length) {
      const current = stack.pop();
      // Any enumeration error aborts the new snapshot; old index is retained.
      await operation("entries", async () => {
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
            const file = await operation("getFile", () => child.getFile(), () => counts(path));
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
      }, () => counts(current.path));
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
  scope.FolderFS = { permission, scan, fileAt, textPreview, failure, operation };
  if (typeof module !== "undefined") module.exports = scope.FolderFS;
})(typeof window === "undefined" ? globalThis : window);

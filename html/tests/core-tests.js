/* Shared dependency-free tests, run by Node and the direct-open browser page. */
(function (scope) {
  "use strict";
  async function runCoreTests(S, FS) {
    let passed = 0;
    const assert = (ok, message) => {
      if (!ok) throw Error(message);
      passed++;
    };
    const equal = (a, b, message) =>
      assert(
        JSON.stringify(a) === JSON.stringify(b),
        message + ": " + JSON.stringify(a),
      );
    equal(
      S.parse('alpha beta OR "gamma delta" -draft'),
      { groups: [["alpha", "beta"], ["gamma delta"]], excluded: ["draft"] },
      "operators",
    );
    equal(
      S.parse("OR a OR OR b OR"),
      { groups: [["a"], ["b"]], excluded: [] },
      "empty OR groups",
    );
    equal(
      S.parse('"bad quote'),
      { groups: [['"bad', "quote"]], excluded: [] },
      "malformed quote fallback",
    );
    equal(
      S.parse("'a b' c\\ d \"e\\q\""),
      { groups: [["a b", "c d", "e\\q"]], excluded: [] },
      "POSIX quotes and escapes",
    );
    assert(S.matches("Straße", S.parse("STRASSE")), "Unicode casefold");
    assert(
      !S.matches("alpha draft", S.parse("alpha -draft")),
      "exclude applies globally",
    );
    const file = (name, path, parent) => ({ name, path, parent, depth: 1 });
    const fixture = {
      folders: [
        { name: "Root", path: "", parent: null, depth: 0 },
        { name: "商品_cat", path: "商品_cat", parent: "", depth: 1 },
        { name: "Other", path: "Other", parent: "", depth: 1 },
        { name: "Empty", path: "Empty", parent: "", depth: 1 },
        { name: "Nested", path: "Other/Nested", parent: "Other", depth: 2 },
      ],
      files: [
        file("cat.pdf", "商品_cat/cat.pdf", "商品_cat"),
        file("other.txt", "商品_cat/other.txt", "商品_cat"),
        file("cat_notes.txt", "Other/cat_notes.txt", "Other"),
        file("alpha.txt", "Other/alpha.txt", "Other"),
        file("beta.txt", "Other/beta.txt", "Other"),
        file("cat.pdf", "Other/Nested/cat.pdf", "Other/Nested"),
      ],
    };
    const rows = await S.search(fixture, "cat");
    equal(
      rows.map((r) => [r.name, r.fileMatchCount, r.matchKind]),
      [
        ["Other", 1, "file"],
        ["商品_cat", 2, "name+file"],
        ["Nested", 1, "file"],
      ],
      "folder aggregation, counts and stable order",
    );
    equal(
      await S.search(fixture, "alpha beta"),
      [],
      "AND never combines separate files",
    );
    equal(await S.search(fixture, ""), [], "blank query");
    equal(
      (await S.search(fixture, "-Other")).map((r) => r.name),
      ["Root", "Empty", "商品_cat", "Nested"],
      "exclude-only includes folders, not file hits",
    );
    equal(
      S.children(fixture, "商品_cat", "cat", true).map((i) => i.name),
      ["cat.pdf"],
      "folder match does not show unrelated files",
    );
    equal(
      S.children(fixture, "Other", "cat", false).map((i) => i.name),
      ["cat_notes.txt"],
      "file-only result shows matching children",
    );
    equal(
      S.children(fixture, "Other").map((i) => i.name),
      ["Nested", "alpha.txt", "beta.txt", "cat_notes.txt"],
      "shallow directory preview",
    );
    const directory = (name, entries) => ({
      name,
      kind: "directory",
      async *entries() {
        for (const child of entries) yield [child.name, child];
      },
    });
    const f = (name) => ({ name, kind: "file" });
    const handle = directory("Root", [
      directory("日本語", [f("同名.txt")]),
      directory("Empty", []),
      directory(".hidden", [f("hidden")]),
      f(".ignore"),
      f("同名.txt"),
    ]);
    const indexed = await FS.scan(handle);
    equal(
      indexed.folders.map((i) => i.path),
      ["", "日本語", "Empty"],
      "empty and Japanese folders; hidden directories skipped",
    );
    equal(
      indexed.files.map((i) => i.path),
      ["同名.txt", "日本語/同名.txt"],
      "same filenames remain distinct",
    );
    const rescanned = await FS.scan(directory("Root", [directory("New", [])]));
    equal(
      rescanned.folders.map((i) => i.path),
      ["", "New"],
      "rescan replaces stale entries",
    );
    const otherRoot = await FS.scan(
      directory("Second", [directory("Different", [])]),
    );
    equal(
      await S.search(otherRoot, "日本語"),
      [],
      "search scopes to selected root snapshot",
    );
    let scanYield = false;
    setTimeout(() => {
      scanYield = true;
    }, 0);
    const manyFiles = Array.from({ length: 12000 }, (_, i) => f("file" + i));
    const massScan = await FS.scan(directory("Large", manyFiles));
    assert(
      scanYield && massScan.files.length === 12000,
      "large scan yields to the UI event loop",
    );
    const abort = new AbortController();
    abort.abort();
    let rejected = false;
    try {
      await FS.scan(handle, { signal: abort.signal });
    } catch (e) {
      rejected = e.name === "AbortError";
    }
    assert(rejected, "cancel scan");
    let oldSnapshot = indexed;
    try {
      oldSnapshot = await FS.scan({
        name: "Root",
        async *entries() {
          throw new DOMException("Denied", "NotAllowedError");
        },
      });
    } catch (_) {}
    assert(
      oldSnapshot === indexed,
      "failed scan does not produce a replacement snapshot",
    );
    assert(
      !(await FS.permission({ queryPermission: async () => "denied" }, false)),
      "no automatic permission prompt",
    );
    let mode;
    assert(
      (await FS.permission(
        {
          queryPermission: async () => "prompt",
          requestPermission: async (p) => {
            mode = p.mode;
            return "granted";
          },
        },
        true,
      )) && mode === "read",
      "read-only reauthorization",
    );
    const text = await FS.textPreview(
      new Blob(["日本語 <script>alert(1)</script>"]),
    );
    assert(
      text.text.includes("<script>") && text.encoding === "utf-8",
      "text is decoded, rendering must use textContent",
    );
    const sjis = await FS.textPreview(
      new Blob([new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea])]),
    );
    equal(sjis.text, "日本語", "CP932 compatible Shift-JIS decoding");
    assert(
      (await FS.textPreview(new Blob([new Uint8Array([1, 0, 2])]))).error,
      "binary rejected",
    );
    assert(
      (await FS.textPreview(new Blob(["a".repeat(20000)]))).truncated,
      "preview size bounded",
    );
    let escaped = false;
    try {
      await FS.fileAt({}, "../secret");
    } catch (_) {
      escaped = true;
    }
    assert(escaped, "relative traversal rejected");
    const large = {
      folders: [{ name: "Root", path: "", depth: 0, parent: null }],
      files: [],
    };
    for (let i = 0; i < 25000; i++)
      large.files.push(file("item" + i + ".txt", "item" + i + ".txt", ""));
    let yielded = false;
    setTimeout(() => {
      yielded = true;
    }, 0);
    const start = Date.now();
    const many = await S.search(large, "item");
    assert(
      yielded && many.length === 1 && many[0].fileMatchCount === 25000,
      "large search yields and aggregates",
    );
    return { passed, largeSearchMs: Date.now() - start };
  }
  scope.runCoreTests = runCoreTests;
  if (typeof module !== "undefined") module.exports = runCoreTests;
})(typeof window === "undefined" ? globalThis : window);

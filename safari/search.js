/* Pure port of src/file_database.py. Classic script: also usable by Node tests. */
(function (scope) {
  "use strict";
  // Python's casefold differs from lowercasing for these Unicode characters.
  const casefoldExtra = {
    "\u00b5": "\u03bc",
    "\u00df": "ss",
    "\u0149": "\u02bcn",
    "\u017f": "s",
    "\u01f0": "j\u030c",
    "\u0345": "\u03b9",
    "\u0390": "\u03b9\u0308\u0301",
    "\u03b0": "\u03c5\u0308\u0301",
    "\u03c2": "\u03c3",
    "\u03d0": "\u03b2",
    "\u03d1": "\u03b8",
    "\u03d5": "\u03c6",
    "\u03d6": "\u03c0",
    "\u03f0": "\u03ba",
    "\u03f1": "\u03c1",
    "\u03f5": "\u03b5",
    "\u0587": "\u0565\u0582",
    "\u13a0": "\u13a0",
    "\u13a1": "\u13a1",
    "\u13a2": "\u13a2",
    "\u13a3": "\u13a3",
    "\u13a4": "\u13a4",
    "\u13a5": "\u13a5",
    "\u13a6": "\u13a6",
    "\u13a7": "\u13a7",
    "\u13a8": "\u13a8",
    "\u13a9": "\u13a9",
    "\u13aa": "\u13aa",
    "\u13ab": "\u13ab",
    "\u13ac": "\u13ac",
    "\u13ad": "\u13ad",
    "\u13ae": "\u13ae",
    "\u13af": "\u13af",
    "\u13b0": "\u13b0",
    "\u13b1": "\u13b1",
    "\u13b2": "\u13b2",
    "\u13b3": "\u13b3",
    "\u13b4": "\u13b4",
    "\u13b5": "\u13b5",
    "\u13b6": "\u13b6",
    "\u13b7": "\u13b7",
    "\u13b8": "\u13b8",
    "\u13b9": "\u13b9",
    "\u13ba": "\u13ba",
    "\u13bb": "\u13bb",
    "\u13bc": "\u13bc",
    "\u13bd": "\u13bd",
    "\u13be": "\u13be",
    "\u13bf": "\u13bf",
    "\u13c0": "\u13c0",
    "\u13c1": "\u13c1",
    "\u13c2": "\u13c2",
    "\u13c3": "\u13c3",
    "\u13c4": "\u13c4",
    "\u13c5": "\u13c5",
    "\u13c6": "\u13c6",
    "\u13c7": "\u13c7",
    "\u13c8": "\u13c8",
    "\u13c9": "\u13c9",
    "\u13ca": "\u13ca",
    "\u13cb": "\u13cb",
    "\u13cc": "\u13cc",
    "\u13cd": "\u13cd",
    "\u13ce": "\u13ce",
    "\u13cf": "\u13cf",
    "\u13d0": "\u13d0",
    "\u13d1": "\u13d1",
    "\u13d2": "\u13d2",
    "\u13d3": "\u13d3",
    "\u13d4": "\u13d4",
    "\u13d5": "\u13d5",
    "\u13d6": "\u13d6",
    "\u13d7": "\u13d7",
    "\u13d8": "\u13d8",
    "\u13d9": "\u13d9",
    "\u13da": "\u13da",
    "\u13db": "\u13db",
    "\u13dc": "\u13dc",
    "\u13dd": "\u13dd",
    "\u13de": "\u13de",
    "\u13df": "\u13df",
    "\u13e0": "\u13e0",
    "\u13e1": "\u13e1",
    "\u13e2": "\u13e2",
    "\u13e3": "\u13e3",
    "\u13e4": "\u13e4",
    "\u13e5": "\u13e5",
    "\u13e6": "\u13e6",
    "\u13e7": "\u13e7",
    "\u13e8": "\u13e8",
    "\u13e9": "\u13e9",
    "\u13ea": "\u13ea",
    "\u13eb": "\u13eb",
    "\u13ec": "\u13ec",
    "\u13ed": "\u13ed",
    "\u13ee": "\u13ee",
    "\u13ef": "\u13ef",
    "\u13f0": "\u13f0",
    "\u13f1": "\u13f1",
    "\u13f2": "\u13f2",
    "\u13f3": "\u13f3",
    "\u13f4": "\u13f4",
    "\u13f5": "\u13f5",
    "\u13f8": "\u13f0",
    "\u13f9": "\u13f1",
    "\u13fa": "\u13f2",
    "\u13fb": "\u13f3",
    "\u13fc": "\u13f4",
    "\u13fd": "\u13f5",
    "\u1c80": "\u0432",
    "\u1c81": "\u0434",
    "\u1c82": "\u043e",
    "\u1c83": "\u0441",
    "\u1c84": "\u0442",
    "\u1c85": "\u0442",
    "\u1c86": "\u044a",
    "\u1c87": "\u0463",
    "\u1c88": "\ua64b",
    "\u1e96": "h\u0331",
    "\u1e97": "t\u0308",
    "\u1e98": "w\u030a",
    "\u1e99": "y\u030a",
    "\u1e9a": "a\u02be",
    "\u1e9b": "\u1e61",
    "\u1e9e": "ss",
    "\u1f50": "\u03c5\u0313",
    "\u1f52": "\u03c5\u0313\u0300",
    "\u1f54": "\u03c5\u0313\u0301",
    "\u1f56": "\u03c5\u0313\u0342",
    "\u1f80": "\u1f00\u03b9",
    "\u1f81": "\u1f01\u03b9",
    "\u1f82": "\u1f02\u03b9",
    "\u1f83": "\u1f03\u03b9",
    "\u1f84": "\u1f04\u03b9",
    "\u1f85": "\u1f05\u03b9",
    "\u1f86": "\u1f06\u03b9",
    "\u1f87": "\u1f07\u03b9",
    "\u1f88": "\u1f00\u03b9",
    "\u1f89": "\u1f01\u03b9",
    "\u1f8a": "\u1f02\u03b9",
    "\u1f8b": "\u1f03\u03b9",
    "\u1f8c": "\u1f04\u03b9",
    "\u1f8d": "\u1f05\u03b9",
    "\u1f8e": "\u1f06\u03b9",
    "\u1f8f": "\u1f07\u03b9",
    "\u1f90": "\u1f20\u03b9",
    "\u1f91": "\u1f21\u03b9",
    "\u1f92": "\u1f22\u03b9",
    "\u1f93": "\u1f23\u03b9",
    "\u1f94": "\u1f24\u03b9",
    "\u1f95": "\u1f25\u03b9",
    "\u1f96": "\u1f26\u03b9",
    "\u1f97": "\u1f27\u03b9",
    "\u1f98": "\u1f20\u03b9",
    "\u1f99": "\u1f21\u03b9",
    "\u1f9a": "\u1f22\u03b9",
    "\u1f9b": "\u1f23\u03b9",
    "\u1f9c": "\u1f24\u03b9",
    "\u1f9d": "\u1f25\u03b9",
    "\u1f9e": "\u1f26\u03b9",
    "\u1f9f": "\u1f27\u03b9",
    "\u1fa0": "\u1f60\u03b9",
    "\u1fa1": "\u1f61\u03b9",
    "\u1fa2": "\u1f62\u03b9",
    "\u1fa3": "\u1f63\u03b9",
    "\u1fa4": "\u1f64\u03b9",
    "\u1fa5": "\u1f65\u03b9",
    "\u1fa6": "\u1f66\u03b9",
    "\u1fa7": "\u1f67\u03b9",
    "\u1fa8": "\u1f60\u03b9",
    "\u1fa9": "\u1f61\u03b9",
    "\u1faa": "\u1f62\u03b9",
    "\u1fab": "\u1f63\u03b9",
    "\u1fac": "\u1f64\u03b9",
    "\u1fad": "\u1f65\u03b9",
    "\u1fae": "\u1f66\u03b9",
    "\u1faf": "\u1f67\u03b9",
    "\u1fb2": "\u1f70\u03b9",
    "\u1fb3": "\u03b1\u03b9",
    "\u1fb4": "\u03ac\u03b9",
    "\u1fb6": "\u03b1\u0342",
    "\u1fb7": "\u03b1\u0342\u03b9",
    "\u1fbc": "\u03b1\u03b9",
    "\u1fbe": "\u03b9",
    "\u1fc2": "\u1f74\u03b9",
    "\u1fc3": "\u03b7\u03b9",
    "\u1fc4": "\u03ae\u03b9",
    "\u1fc6": "\u03b7\u0342",
    "\u1fc7": "\u03b7\u0342\u03b9",
    "\u1fcc": "\u03b7\u03b9",
    "\u1fd2": "\u03b9\u0308\u0300",
    "\u1fd3": "\u03b9\u0308\u0301",
    "\u1fd6": "\u03b9\u0342",
    "\u1fd7": "\u03b9\u0308\u0342",
    "\u1fe2": "\u03c5\u0308\u0300",
    "\u1fe3": "\u03c5\u0308\u0301",
    "\u1fe4": "\u03c1\u0313",
    "\u1fe6": "\u03c5\u0342",
    "\u1fe7": "\u03c5\u0308\u0342",
    "\u1ff2": "\u1f7c\u03b9",
    "\u1ff3": "\u03c9\u03b9",
    "\u1ff4": "\u03ce\u03b9",
    "\u1ff6": "\u03c9\u0342",
    "\u1ff7": "\u03c9\u0342\u03b9",
    "\u1ffc": "\u03c9\u03b9",
    "\uab70": "\u13a0",
    "\uab71": "\u13a1",
    "\uab72": "\u13a2",
    "\uab73": "\u13a3",
    "\uab74": "\u13a4",
    "\uab75": "\u13a5",
    "\uab76": "\u13a6",
    "\uab77": "\u13a7",
    "\uab78": "\u13a8",
    "\uab79": "\u13a9",
    "\uab7a": "\u13aa",
    "\uab7b": "\u13ab",
    "\uab7c": "\u13ac",
    "\uab7d": "\u13ad",
    "\uab7e": "\u13ae",
    "\uab7f": "\u13af",
    "\uab80": "\u13b0",
    "\uab81": "\u13b1",
    "\uab82": "\u13b2",
    "\uab83": "\u13b3",
    "\uab84": "\u13b4",
    "\uab85": "\u13b5",
    "\uab86": "\u13b6",
    "\uab87": "\u13b7",
    "\uab88": "\u13b8",
    "\uab89": "\u13b9",
    "\uab8a": "\u13ba",
    "\uab8b": "\u13bb",
    "\uab8c": "\u13bc",
    "\uab8d": "\u13bd",
    "\uab8e": "\u13be",
    "\uab8f": "\u13bf",
    "\uab90": "\u13c0",
    "\uab91": "\u13c1",
    "\uab92": "\u13c2",
    "\uab93": "\u13c3",
    "\uab94": "\u13c4",
    "\uab95": "\u13c5",
    "\uab96": "\u13c6",
    "\uab97": "\u13c7",
    "\uab98": "\u13c8",
    "\uab99": "\u13c9",
    "\uab9a": "\u13ca",
    "\uab9b": "\u13cb",
    "\uab9c": "\u13cc",
    "\uab9d": "\u13cd",
    "\uab9e": "\u13ce",
    "\uab9f": "\u13cf",
    "\uaba0": "\u13d0",
    "\uaba1": "\u13d1",
    "\uaba2": "\u13d2",
    "\uaba3": "\u13d3",
    "\uaba4": "\u13d4",
    "\uaba5": "\u13d5",
    "\uaba6": "\u13d6",
    "\uaba7": "\u13d7",
    "\uaba8": "\u13d8",
    "\uaba9": "\u13d9",
    "\uabaa": "\u13da",
    "\uabab": "\u13db",
    "\uabac": "\u13dc",
    "\uabad": "\u13dd",
    "\uabae": "\u13de",
    "\uabaf": "\u13df",
    "\uabb0": "\u13e0",
    "\uabb1": "\u13e1",
    "\uabb2": "\u13e2",
    "\uabb3": "\u13e3",
    "\uabb4": "\u13e4",
    "\uabb5": "\u13e5",
    "\uabb6": "\u13e6",
    "\uabb7": "\u13e7",
    "\uabb8": "\u13e8",
    "\uabb9": "\u13e9",
    "\uabba": "\u13ea",
    "\uabbb": "\u13eb",
    "\uabbc": "\u13ec",
    "\uabbd": "\u13ed",
    "\uabbe": "\u13ee",
    "\uabbf": "\u13ef",
    "\ufb00": "ff",
    "\ufb01": "fi",
    "\ufb02": "fl",
    "\ufb03": "ffi",
    "\ufb04": "ffl",
    "\ufb05": "st",
    "\ufb06": "st",
    "\ufb13": "\u0574\u0576",
    "\ufb14": "\u0574\u0565",
    "\ufb15": "\u0574\u056b",
    "\ufb16": "\u057e\u0576",
    "\ufb17": "\u0574\u056d",
  };
  const fold = (text) =>
    Array.from(text, (c) => casefoldExtra[c] ?? c.toLowerCase()).join("");
  const compare = (a, b) => {
    const x = Array.from(a),
      y = Array.from(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      if (x[i] !== y[i]) return x[i].codePointAt(0) - y[i].codePointAt(0);
    }
    return x.length - y.length;
  };
  function tokensOf(query) {
    const tokens = [];
    let token = "",
      quote = "",
      started = false;
    try {
      for (let i = 0; i < query.length; i++) {
        const c = query[i];
        if (quote === "'") {
          if (c === "'") quote = "";
          else token += c;
        } else if (c === "\\") {
          if (++i >= query.length) throw Error("escape");
          if (quote === '"' && !['"', "\\"].includes(query[i])) token += "\\";
          token += query[i];
          started = true;
        } else if (quote) {
          if (c === quote) quote = "";
          else token += c;
        } else if (c === '"' || c === "'") {
          quote = c;
          started = true;
        } else if (" \t\r\n".includes(c)) {
          if (started) tokens.push(token);
          token = "";
          started = false;
        } else {
          token += c;
          started = true;
        }
      }
      if (quote) throw Error("quote");
      if (started) tokens.push(token);
      return tokens;
    } catch (_) {
      return query.split(/\s+/u);
    }
  }
  function parse(query) {
    const groups = [[]],
      excluded = [];
    for (let token of tokensOf((query || "").trim())) {
      token = token.trim();
      if (!token) continue;
      if (token.toUpperCase() === "OR") {
        if (groups.at(-1).length) groups.push([]);
      } else if (token.startsWith("-") && token.length > 1)
        excluded.push(token.slice(1));
      else groups.at(-1).push(token);
    }
    return { groups: groups.filter((g) => g.length), excluded };
  }
  function matches(name, query) {
    const value = fold(name);
    return (
      !query.excluded.some((t) => value.includes(fold(t))) &&
      (query.groups.length
        ? query.groups.some((g) => g.every((t) => value.includes(fold(t))))
        : !!query.excluded.length)
    );
  }
  function terms(query) {
    return [...new Set(query.groups.flat().map(fold))];
  }
  // SQLite LIKE uses ASCII case insensitivity; preserve its candidate behavior.
  function candidateMatchers(query) {
    return query.groups
      .flat()
      .map(
        (term) =>
          new RegExp(
            Array.from(term, (c) =>
              c === "%"
                ? "[\\s\\S]*"
                : c === "_"
                  ? "[\\s\\S]"
                  : c
                      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
                      .replace(/[A-Z]/g, (c) => c.toLowerCase()),
            ).join(""),
            "u",
          ),
      );
  }
  const asciiLower = (value) => value.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
  const formats = {
    pdf: ["pdf"], jpg: ["jpg", "jpeg"], png: ["png"],
    excel: ["xls", "xlsx", "xlsm"], powerpoint: ["ppt", "pptx", "pptm"],
    word: ["doc", "docx", "docm"], txt: ["txt"], dwg: ["dwg"],
    revit: ["rvt"], sketchup: ["skp"], grasshopper: ["gh", "ghx"],
  };
  const filtered = (options = {}) => options.days && options.days !== "all" || options.format && options.format !== "all";
  function eligible(file, options = {}) {
    const extensions = formats[options.format];
    if (extensions && (!file.name.includes(".") || !extensions.includes(file.name.split(".").pop().toLowerCase()))) return false;
    if (options.days && options.days !== "all") {
      const age = options.now - file.lastModified;
      if (!Number.isFinite(file.lastModified) || age < 0 || age > Number(options.days) * 86400000) return false;
    }
    return true;
  }
  // Keep keyword matches separate from filter-eligible files. A result folder
  // can use either set without rescanning its descendants on every expansion.
  async function visibility(snapshot, queryText, options = {}, cancelled = () => false) {
    const query = parse(queryText), hasQuery = !!(query.groups.length || query.excluded.length);
    const visible = new Set(), files = new Set(), ancestors = new Set();
    const eligibleFiles = new Set(), eligibleAncestors = new Set(), allVisible = new Set();
    const parents = new Map();
    let count = 0;
    for (const folder of snapshot.folders) {
      parents.set(folder.path, folder.parent);
      if (!filtered(options)) allVisible.add(folder.path);
      if (++count % 500 === 0) { await pause(); if (cancelled()) return {visible, files, ancestors, eligibleFiles, eligibleAncestors, allVisible}; }
    }
    function ascend(path, target) {
      while (path != null && !target.has(path)) {
        target.add(path); path = parents.get(path);
      }
    }
    for (const file of snapshot.files) {
      if (eligible(file, options)) {
        eligibleFiles.add(file.path); allVisible.add(file.path); ascend(file.parent, eligibleAncestors);
        if (!hasQuery || matches(file.name, query)) {
          files.add(file.path); visible.add(file.path); ascend(file.parent, ancestors);
        }
      }
      if (++count % 500 === 0) { await pause(); if (cancelled()) return {visible, files, ancestors, eligibleFiles, eligibleAncestors, allVisible}; }
    }
    for (const path of ancestors) {
      visible.add(path);
      if (++count % 500 === 0) { await pause(); if (cancelled()) return {visible, files, ancestors, eligibleFiles, eligibleAncestors, allVisible}; }
    }
    if (filtered(options)) for (const path of eligibleAncestors) {
      allVisible.add(path);
      if (++count % 500 === 0) { await pause(); if (cancelled()) return {visible, files, ancestors, eligibleFiles, eligibleAncestors, allVisible}; }
    }
    return {visible, files, ancestors, eligibleFiles, eligibleAncestors, allVisible};
  }
  // Native sort on a very large sibling list can block the UI for a long time.
  // Sort small runs and cooperatively merge them; the comparator remains the
  // same as before and old searches can be cancelled at each yield.
  async function sortCooperatively(items, comparator, cancelled) {
    const size = 1000;
    let runs = [];
    for (let i = 0; i < items.length; i += size) {
      runs.push(items.slice(i, i + size).sort(comparator));
      if (items.length > size) { await pause(); if (cancelled()) return null; }
    }
    while (runs.length > 1) {
      const next = [];
      let processed = 0;
      for (let n = 0; n < runs.length; n += 2) {
        if (n + 1 === runs.length) { next.push(runs[n]); continue; }
        const a = runs[n], b = runs[n + 1], merged = [];
        let i = 0, j = 0;
        while (i < a.length || j < b.length) {
          merged.push(j >= b.length || (i < a.length && comparator(a[i], b[j]) <= 0) ? a[i++] : b[j++]);
          if (++processed % 4000 === 0) { await pause(); if (cancelled()) return null; }
        }
        next.push(merged);
      }
      runs = next;
    }
    return runs[0] || [];
  }
  async function childIndex(snapshot, cancelled = () => false) {
    const index = new Map();
    let processed = 0;
    for (const [entries, kind] of [[snapshot.folders, "directory"], [snapshot.files, "file"]]) {
      for (const item of entries) {
        if (item.path === "") continue;
        if (!index.has(item.parent)) index.set(item.parent, []);
        index.get(item.parent).push({ ...item, kind });
        if (++processed % 500 === 0) { await pause(); if (cancelled()) return null; }
      }
    }
    const comparator = (a, b) =>
      (a.kind === b.kind ? 0 : a.kind === "directory" ? -1 : 1) || compare(fold(a.name), fold(b.name));
    for (const [parent, items] of index) {
      const sorted = await sortCooperatively(items, comparator, cancelled);
      if (!sorted || cancelled()) return null;
      index.set(parent, sorted);
      if (++processed % 500 === 0) { await pause(); if (cancelled()) return null; }
    }
    return index;
  }
  async function displayIndex(index, display, cancelled = () => false) {
    const all = new Map(), matched = new Map();
    let processed = 0;
    for (const [parent, items] of index) {
      const fullItems = [], matchedItems = [];
      for (const item of items) {
        if (display.allVisible.has(item.path)) fullItems.push(item);
        if (display.visible.has(item.path)) matchedItems.push(item);
        if (++processed % 500 === 0) { await pause(); if (cancelled()) return null; }
      }
      if (fullItems.length) all.set(parent, fullItems);
      if (matchedItems.length) matched.set(parent, matchedItems);
    }
    return {all, matched};
  }
  function containsFile(rows, display, path) {
    if (!path || !display.eligibleFiles.has(path)) return false;
    return rows.some(row => (row.path === "" || path.startsWith(row.path + "/")) &&
      (row.showAll || display.files.has(path)));
  }
  async function search(
    snapshot,
    queryText,
    cancelled = () => false,
    options = {},
  ) {
    const query = parse(queryText),
      positive = terms(query),
      candidates = candidateMatchers(query);
    if (!positive.length && !query.excluded.length && !filtered(options)) return [];
    options = { ...options, now: options.now ?? Date.now() };
    const display = await visibility(snapshot, queryText, options, cancelled);
    if (cancelled()) return [];
    const hits = new Map(),
      counts = new Map();
    let processed = 0;
    for (const file of snapshot.files) {
      counts.set(file.parent, (counts.get(file.parent) || 0) + 1);
      if (
        (positive.length || filtered(options)) && display.files.has(file.path) &&
        (!positive.length || candidates.some((re) => re.test(asciiLower(file.name))))
      ) {
        if (!hits.has(file.parent)) hits.set(file.parent, []);
        hits.get(file.parent).push(file);
      }
      if (++processed % 500 === 0) {
        await pause();
        if (cancelled()) return [];
      }
    }
    const results = [];
    for (const folder of snapshot.folders) {
      const isRoot = folder.path === "";
      const candidate =
        !positive.length ||
        (isRoot
          ? positive.some((t) => fold(folder.name).includes(t))
          : candidates.some((re) => re.test(asciiLower(folder.name))));
      const nameMatched = candidate && matches(folder.name, query),
        files = hits.get(folder.path) || [];
      if ((nameMatched || files.length) && (!filtered(options) || display.eligibleAncestors.has(folder.path))) {
        const sortedFiles = await sortCooperatively(files,
          (a, b) =>
            compare(fold(a.name), fold(b.name)) ||
            compare(fold(a.path), fold(b.path)),
          cancelled,
        );
        if (!sortedFiles || cancelled()) return [];
        results.push({
          ...folder,
          folderNameMatched: nameMatched,
          showAll: nameMatched && !display.ancestors.has(folder.path),
          fileMatchCount: filtered(options) ? files.length : nameMatched
            ? positive.length
              ? counts.get(folder.path) || 0
              : 0
            : files.length,
          matchedFileNames: [...new Set(sortedFiles.map((f) => f.name))],
          matchedFilePaths: sortedFiles.map((f) => f.path),
          matchKind: nameMatched
            ? files.length
              ? "name+file"
              : "name"
            : "file",
        });
      }
      if (++processed % 500 === 0) {
        await pause();
        if (cancelled()) return [];
      }
    }
    return await sortCooperatively(results,
      (a, b) =>
        a.depth - b.depth ||
        compare(fold(a.name), fold(b.name)) ||
        compare(fold(a.path), fold(b.path)),
      cancelled,
    ) || [];
  }
  function children(snapshot, path, queryText = "", folderNameMatched = false) {
    const query = parse(queryText),
      hasQuery = !!queryText.trim();
    return [
      ...snapshot.folders
        .filter((f) => f.path !== "" && f.parent === path)
        .map((f) => ({ ...f, kind: "directory" })),
      ...snapshot.files
        .filter((f) => f.parent === path)
        .map((f) => ({ ...f, kind: "file" })),
    ]
      .filter(
        (item) =>
          !hasQuery ||
          (query.groups.length && matches(item.name, query)) ||
          (folderNameMatched && item.kind === "file"),
      )
      .sort(
        (a, b) =>
          (a.kind === b.kind ? 0 : a.kind === "directory" ? -1 : 1) ||
          compare(fold(a.name), fold(b.name)),
      );
  }
  scope.FolderSearch = {
    formats, filtered, eligible, visibility, childIndex, displayIndex, containsFile,
    fold,
    compare,
    parse,
    matches,
    terms,
    search,
    children,
    pause,
  };
  if (typeof module !== "undefined") module.exports = scope.FolderSearch;
})(typeof window === "undefined" ? globalThis : window);

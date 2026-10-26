(function (scope) {
  "use strict";
  function open(name = "file-search-html-v1") {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        for (const store of ["roots", "snapshots", "settings"])
          request.result.createObjectStore(store);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(Error("Close other Folder Search tabs and reopen this page."));
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        // Resolve only on transaction completion, including quota/clone failures.
        function transaction(stores, mode, action) {
          return new Promise((done, fail) => {
            const tx = db.transaction(stores, mode);
            let result;
            tx.oncomplete = () => done(result);
            tx.onabort = () =>
              fail(tx.error || Error("Storage transaction aborted"));
            tx.onerror = () => {}; // onabort reports failure; never replace old state in memory.
            try {
              action(tx, (value) => {
                result = value;
              });
            } catch (e) {
              tx.abort();
              fail(e);
            }
          });
        }
        resolve({
          close: () => db.close(),
          roots: () =>
            transaction(["roots"], "readonly", (tx, set) => {
              tx.objectStore("roots").getAll().onsuccess = (e) =>
                set(e.target.result);
            }),
          get: (store, key) =>
            transaction([store], "readonly", (tx, set) => {
              tx.objectStore(store).get(key).onsuccess = (e) =>
                set(e.target.result);
            }),
          put: (store, key, value) =>
            transaction([store], "readwrite", (tx) =>
              tx.objectStore(store).put(value, key),
            ),
          commit: (root, snapshot) =>
            transaction(["roots", "snapshots"], "readwrite", (tx) => {
              tx.objectStore("roots").put(root, root.id);
              tx.objectStore("snapshots").put(snapshot, root.id);
            }),
          remove: (id) =>
            transaction(["roots", "snapshots"], "readwrite", (tx) => {
              tx.objectStore("roots").delete(id);
              tx.objectStore("snapshots").delete(id);
            }),
        });
      };
    });
  }
  scope.FolderStore = { open };
})(window);

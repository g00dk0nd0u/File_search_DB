"""Development-only macOS Safari probe; Python standard library, no app server.
Uses Apple's installed safaridriver. Folder picker and previews remain manual.
"""
import base64
import json
import os
from pathlib import Path
import platform
import subprocess
import time
import urllib.error
import urllib.request
import uuid

ARTIFACTS = Path(os.environ["SAFARI_ARTIFACTS"])
ARTIFACTS.mkdir(parents=True, exist_ok=True)
REPORT = {
    "scope": "Installed Safari automation profile, file://; not user's normal profile",
    "checks": [],
    "manual_unverified": [
        "native directory chooser and webkitRelativePath from real selected files",
        "Japanese names, nested paths and empty directories",
        "PDF/image/text rendering from selected files",
        "normal-profile persistence after full Safari restart",
        "cancel/reselection and deleted/unreadable real files",
    ],
}
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
SESSION = None
SERVICE = None
LOG = None


def request(method, route, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(
        "http://127.0.0.1:4444" + route, data=data, method=method,
        headers={"Content-Type": "application/json"},
    )
    REPORT["last_command"] = {"method": method, "route": route}
    try:
        with OPENER.open(req, timeout=45) as response:
            result = json.load(response)["value"]
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(method + " " + route + " HTTP " + str(error.code) + ": " + detail) from error
    if isinstance(result, dict) and "error" in result:
        raise RuntimeError(str(result))
    return result


def execute(script, asynchronous=False):
    return request("POST", "/session/" + SESSION + "/execute/" +
                   ("async" if asynchronous else "sync"),
                   {"script": script, "args": []})


def check(name, condition, detail=None):
    REPORT["checks"].append({"name": name, "passed": bool(condition), "detail": detail})
    if not condition:
        raise AssertionError(name + ": " + str(detail))


def open_safari():
    global SESSION
    result = request("POST", "/session", {"capabilities": {"alwaysMatch": {"browserName": "safari"}}})
    SESSION = result["sessionId"]
    REPORT.setdefault("capabilities", []).append(result["capabilities"])
    request("POST", "/session/" + SESSION + "/timeouts", {"script": 20000, "pageLoad": 20000, "implicit": 0})
    return navigate()


def navigate():
    request("POST", "/session/" + SESSION + "/url",
            {"url": (Path(__file__).parent / "index.html").resolve().as_uri()})
    deadline = time.monotonic() + 20
    log = ""
    while time.monotonic() < deadline:
        log = execute("return document.getElementById('log')?.textContent || '';")
        if "保存マーカー" in log or "IndexedDB読出失敗" in log:
            break
        time.sleep(0.2)
    return log


def evidence(label):
    if not SESSION:
        return
    try:
        screenshot = request("GET", "/session/" + SESSION + "/screenshot")
        (ARTIFACTS / (label + ".png")).write_bytes(base64.b64decode(screenshot))
    except Exception as error:
        REPORT.setdefault("evidence_errors", []).append(repr(error))


def check_hidden_results(label):
    observed = execute("""return {
      files: document.querySelectorAll('#files li').length,
      preview: document.getElementById('preview').childElementCount,
      disabled: document.getElementById('save').disabled
    };""")
    check(label, observed["files"] == 0 and observed["preview"] == 0 and
          observed["disabled"], observed)


def close_safari():
    global SESSION
    if SESSION:
        request("DELETE", "/session/" + SESSION)
        SESSION = None
    subprocess.run(["osascript", "-e", 'tell application "Safari" to quit'],
                   check=True, timeout=20)
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        processes = subprocess.run(["pgrep", "-x", "Safari"], capture_output=True, text=True)
        if processes.returncode == 1:
            check("Safari process fully exited", True)
            return
        time.sleep(0.2)
    check("Safari process fully exited", False, processes.stdout)


def main():
    global SERVICE, LOG
    check("macOS runner", platform.system() == "Darwin", platform.platform())
    check("CI-only driver", os.environ.get("GITHUB_ACTIONS") == "true")
    REPORT["macOS"] = subprocess.check_output(["sw_vers"], text=True)
    LOG = (ARTIFACTS / "safaridriver.log").open("w")
    SERVICE = subprocess.Popen(["/usr/bin/safaridriver", "-p", "4444"], stdout=LOG, stderr=subprocess.STDOUT)
    deadline = time.monotonic() + 20
    while True:
        try:
            request("GET", "/status")
            break
        except Exception:
            if time.monotonic() >= deadline or SERVICE.poll() is not None:
                raise
            time.sleep(0.2)
    initial_log = open_safari()
    evidence("initial")
    (ARTIFACTS / "initial.log").write_text(initial_log, encoding="utf-8")
    observed = execute("""return {
      protocol: location.protocol, ua: navigator.userAgent,
      directoryProperty: 'webkitdirectory' in document.getElementById('picker'),
      files: document.querySelectorAll('#files li').length,
      preview: document.getElementById('preview').childElementCount,
      saveDisabled: document.getElementById('save').disabled
    };""")
    check("direct file URL", observed["protocol"] == "file:", observed)
    check("inline application initialized", "Phase 0 PoC" in initial_log, initial_log)
    check("directory input property (not a native chooser test)", observed["directoryProperty"])
    check("no inaccessible saved results", observed["files"] == 0 and
          observed["preview"] == 0 and observed["saveDisabled"])
    check("native IndexedDB startup", "保存マーカーなし" in initial_log or
          "保存マーカー読出:" in initial_log, initial_log)
    marker = str(uuid.uuid4())
    # Synthetic metadata only. No File injection and no fabricated native folder access.
    written = execute("""
      const done = arguments[arguments.length - 1];
      const r = indexedDB.open('file-search-safari-phase0-v1', 1);
      r.onerror = () => done({error: String(r.error)});
      r.onsuccess = () => {
        const db = r.result, tx = db.transaction('metadata', 'readwrite');
        tx.objectStore('metadata').put({savedAt: MARKER, files: [
          {path:'CI合成データ/旧ファイル.txt', size:1, lastModified:0}
        ]}, 'snapshot');
        tx.oncomplete = () => { db.close(); done({committed: MARKER}); };
        tx.onabort = () => { db.close(); done({error: String(tx.error)}); };
      };
    """.replace("MARKER", json.dumps(marker)), asynchronous=True)
    check("real IndexedDB commits synthetic metadata", written.get("committed") == marker, written)
    # First prove the application rereads committed metadata in the same
    # automation session. A later session reset must not erase this evidence.
    reread_log = navigate()
    (ARTIFACTS / "reread.log").write_text(reread_log, encoding="utf-8")
    evidence("reread")
    check("same-session application rereads committed marker", marker in reread_log, reread_log)
    check_hidden_results("same-session reload hides saved synthetic file results")
    close_safari()
    restored_log = open_safari()
    evidence("restart")
    (ARTIFACTS / "restart.log").write_text(restored_log, encoding="utf-8")
    check("automation-profile marker survives full Safari exit", marker in restored_log, restored_log)
    check_hidden_results("saved metadata never restores file access or results")
    close_safari()


try:
    main()
except Exception as error:
    REPORT["error"] = repr(error)
    evidence("failure")
finally:
    if SESSION:
        try:
            request("DELETE", "/session/" + SESSION)
        except Exception as error:
            REPORT["cleanup_error"] = repr(error)
    if SERVICE:
        SERVICE.terminate()
        try:
            SERVICE.wait(timeout=10)
        except subprocess.TimeoutExpired:
            SERVICE.kill()
            SERVICE.wait(timeout=10)
    if LOG:
        LOG.close()
    REPORT["passed"] = sum(check["passed"] for check in REPORT["checks"])
    REPORT["failed"] = sum(not check["passed"] for check in REPORT["checks"])
    (ARTIFACTS / "report.json").write_text(json.dumps(REPORT, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(REPORT, ensure_ascii=False, indent=2))
raise SystemExit(1 if "error" in REPORT or REPORT["failed"] else 0)

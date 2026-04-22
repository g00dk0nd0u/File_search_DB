"""Local Web UI for searching registered project folders."""

from __future__ import annotations

import argparse
from contextlib import closing
import errno
import html
import json
import mimetypes
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import threading
import time
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from string import Template
from typing import Optional, Tuple
from urllib.parse import parse_qs, urlencode, urlparse

if __package__ in (None, ""):
    from file_database import add_root, connect_db, delete_root, ensure_db, get_root, list_roots, parse_folder_query, scan_root, search_folders
else:
    from .file_database import add_root, connect_db, delete_root, ensure_db, get_root, list_roots, parse_folder_query, scan_root, search_folders


DEFAULT_DB_PATH = Path(__file__).resolve().parent.parent / "data" / "file_index.db"
PREVIEW_BYTES = 16 * 1024


BASE_CSS = """
*, *::before, *::after { box-sizing: border-box; }
:root {
  color-scheme: light;
  --bg-color: #f4f5f7;
  --surface-color: #ffffff;
  --surface-muted: #f7f9fc;
  --surface-soft: #f8f9fb;
  --surface-hover: #eef3fb;
  --text-color: #222222;
  --text-strong: #1a2e4a;
  --text-muted: #4e5968;
  --text-subtle: #5b6572;
  --placeholder-color: #8b95a3;
  --link-color: #1f3656;
  --accent-color: #3b6ea5;
  --accent-hover: #2d5585;
  --border-color: #dde1e7;
  --border-soft: #d9e2ef;
  --border-row: #eaecef;
  --border-input: #bfc5ce;
  --border-button: #c9d3e0;
  --button-secondary: #5f748e;
  --button-secondary-hover: #4d627b;
  --button-danger: #a44949;
  --button-danger-hover: #883939;
  --nav-bg: #ffffff;
  --button-text: #ffffff;
  --notice-bg: #f7f9fc;
  --notice-text: #1f3656;
  --notice-error-bg: #fff3f3;
  --notice-error-border: #edc7c7;
  --notice-error-text: #8b2e2e;
  --shadow-ring: 0 0 0 3px rgba(59, 110, 165, 0.15);
  --mark-bg: #ffdca8;
  --mark-text: inherit;
}
html[data-theme="dark"] {
  color-scheme: dark;
  --bg-color: #0d1117;
  --surface-color: #161b22;
  --surface-muted: #1f242d;
  --surface-soft: #121821;
  --surface-hover: #202833;
  --text-color: #e6edf3;
  --text-strong: #f0f6fc;
  --text-muted: #9da7b3;
  --text-subtle: #8b949e;
  --placeholder-color: #7d8590;
  --link-color: #c9d1d9;
  --accent-color: #8b949e;
  --accent-hover: #a3acb7;
  --border-color: #30363d;
  --border-soft: #30363d;
  --border-row: #2d333b;
  --border-input: #30363d;
  --border-button: #30363d;
  --button-secondary: #434c56;
  --button-secondary-hover: #59636e;
  --button-danger: #da6d75;
  --button-danger-hover: #f0888f;
  --nav-bg: #161b22;
  --button-text: #f0f6fc;
  --notice-bg: #1f242d;
  --notice-text: #f0f6fc;
  --notice-error-bg: #2d1f23;
  --notice-error-border: #5c2f35;
  --notice-error-text: #ffd7d5;
  --shadow-ring: 0 0 0 3px rgba(110, 118, 129, 0.22);
  --mark-bg: #f2cc60;
  --mark-text: #24292f;
}
body {
  font-family: "Hiragino Sans", "Yu Gothic UI", sans-serif;
  margin: 0;
  padding: 1.5rem 1rem 2rem;
  max-width: 1100px;
  margin-inline: auto;
  background: var(--bg-color);
  color: var(--text-color);
  font-size: 0.9375rem;
}
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  margin: 0 0 1.1rem;
}
h1 {
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--text-strong);
  border-left: 4px solid var(--accent-color);
  padding-left: 0.75rem;
  margin: 0;
}
.header-actions, .actions {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  flex-wrap: wrap;
}
.nav-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 2rem;
  padding: 0.35rem 0.9rem;
  border: 1px solid var(--border-button);
  border-radius: 6px;
  background: var(--nav-bg);
  color: var(--link-color);
  text-decoration: none;
  font-size: 0.85rem;
  font-weight: 600;
}
.nav-link:hover { background: var(--surface-muted); }
.theme-toggle {
  width: 2rem;
  min-width: 2rem;
  height: 2rem;
  padding: 0;
  border: 1px solid var(--border-button);
  border-radius: 999px;
  background: var(--nav-bg);
  color: var(--link-color);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.search-form, .panel {
  background: var(--surface-color);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 0.95rem 1.1rem;
  margin-bottom: 0.7rem;
}
.search-row, .settings-form {
  display: flex;
  flex-wrap: wrap;
  gap: 0.85rem;
  align-items: flex-end;
}
.field {
  display: grid;
  gap: 0.3rem;
}
.field-grow { flex: 1 1 22rem; }
label {
  font-weight: 600;
  font-size: 0.8125rem;
  color: var(--text-muted);
}
input[type=text], select {
  width: 18rem;
  max-width: 78vw;
  padding: 0.45rem 0.65rem;
  border: 1px solid var(--border-input);
  border-radius: 5px;
  font-size: 0.9375rem;
  color: var(--text-color);
  background: var(--surface-soft);
}
.field-grow input[type=text] { width: 100%; max-width: 100%; }
#q { width: 30rem; max-width: 80vw; }
input[type=text]:focus, select:focus {
  outline: none;
  border-color: var(--accent-color);
  background: var(--surface-color);
  box-shadow: var(--shadow-ring);
}
input[type=text]::placeholder { color: var(--placeholder-color); }
button, .action-button {
  padding: 0.45rem 1.05rem;
  background: var(--accent-color);
  color: var(--button-text);
  border: none;
  border-radius: 5px;
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  text-decoration: none;
}
button:hover, .action-button:hover { background: var(--accent-hover); }
.button-secondary { background: var(--button-secondary); }
.button-secondary:hover { background: var(--button-secondary-hover); }
.button-danger { background: var(--button-danger); }
.button-danger:hover { background: var(--button-danger-hover); }
.meta, .notice, .empty {
  font-size: 0.875rem;
  color: var(--text-muted);
  background: var(--surface-muted);
  border: 1px solid var(--border-soft);
  border-radius: 6px;
  padding: 0.55rem 0.75rem;
  margin: 0 0 0.7rem;
}
.meta strong { color: var(--text-strong); }
.notice { color: var(--notice-text); background: var(--notice-bg); }
.notice.is-error {
  color: var(--notice-error-text);
  background: var(--notice-error-bg);
  border-color: var(--notice-error-border);
}
table {
  border-collapse: collapse;
  width: 100%;
  background: var(--surface-color);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  overflow: hidden;
  font-size: 0.875rem;
}
thead th {
  background: var(--text-strong);
  color: var(--button-text);
  padding: 0.6rem 0.75rem;
  text-align: left;
  font-size: 0.8125rem;
  font-weight: 600;
  white-space: nowrap;
}
tbody td {
  border-top: 1px solid var(--border-row);
  padding: 0.72rem 0.75rem;
  vertical-align: top;
}
tbody tr:nth-child(even) { background: var(--surface-soft); }
tbody tr:hover { background: var(--surface-hover); }
.result-detail-row td {
  background: var(--surface-muted);
  border-top: 1px solid var(--border-row);
  padding: 0.55rem 0.75rem 0.7rem;
}
.result-detail-row[hidden] { display: none; }
.folder-name {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}
.folder-name[data-expanded="true"] {
  background-color: var(--surface-hover);
}
.detail-shell {
  display: grid;
  gap: 0.55rem;
}
.detail-toolbar {
  display: flex;
  justify-content: flex-end;
}
.folder-open-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.7rem;
  height: 1.7rem;
  padding: 0;
  border: 1px solid var(--border-button);
  border-radius: 5px;
  background: var(--nav-bg);
  color: var(--link-color);
  font-size: 0.95rem;
  line-height: 1;
}
.folder-open-button:hover { background: var(--surface-hover); }
.detail-grid {
  display: grid;
  grid-template-columns: minmax(12rem, 0.9fr) minmax(16rem, 1.4fr);
  gap: 0.75rem;
}
.children-panel,
.preview-panel {
  min-width: 0;
  border: 1px solid var(--border-soft);
  border-radius: 6px;
  background: var(--surface-color);
  padding: 0.55rem 0.65rem;
}
.children-list {
  list-style: none;
  margin: 0;
  padding: 0.12rem 0 0;
}
.children-item {
  display: flex;
  align-items: baseline;
  gap: 0.48rem;
  padding: 0.12rem 0;
  line-height: 1.35;
}
.children-kind {
  min-width: 2.25rem;
  color: var(--text-subtle);
  font-size: 0.78rem;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.children-link {
  color: var(--link-color);
  text-decoration: none;
  font-weight: 500;
  word-break: break-all;
}
.children-link:hover {
  text-decoration: underline;
}
.children-link.is-active {
  background: var(--surface-hover);
  border-radius: 4px;
  padding: 0.05rem 0.2rem;
}
.children-empty,
.children-loading,
.children-error,
.preview-empty,
.preview-loading,
.preview-error,
.preview-note {
  color: var(--text-muted);
  font-size: 0.82rem;
  padding: 0.15rem 0;
  word-break: break-word;
}
.children-error,
.preview-error {
  color: var(--notice-error-text);
}
.preview-content {
  margin: 0;
  max-height: 18rem;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.8rem;
  line-height: 1.45;
  color: var(--text-color);
}
.preview-meta {
  color: var(--text-subtle);
  font-size: 0.74rem;
  margin-bottom: 0.35rem;
}
.folder-name, .root-name, .parent-folder-name {
  font-weight: 600;
  color: var(--link-color);
  cursor: pointer;
  padding: 0.25rem 0.35rem;
  border-radius: 4px;
  transition: background-color 0.15s ease;
  text-decoration: none;
}
.folder-name:hover, .root-name:hover, .parent-folder-name:hover {
  background-color: var(--surface-hover);
}
.folder-cell {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 0.75rem;
}
.folder-main {
  min-width: 0;
}
.open-icon-button {
  display: none;
}
@media (max-width: 720px) {
  .detail-grid {
    grid-template-columns: 1fr;
  }
}
.path {
  word-break: break-all;
  color: var(--text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.8125rem;
}
.muted {
  color: var(--text-subtle);
  font-size: 0.8125rem;
}
.badge {
  display: inline-flex;
  align-items: center;
  min-height: 1.7rem;
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  border: 1px solid var(--border-button);
  color: var(--link-color);
  background: var(--surface-muted);
  font-size: 0.78rem;
  font-weight: 600;
  white-space: nowrap;
}
.actions form { margin: 0; }
mark {
  background: var(--mark-bg);
  color: var(--mark-text);
  border-radius: 2px;
  padding: 0 2px;
}
"""


THEME_SCRIPT = """
(function () {
  const storageKey = "file-search-db-theme";
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  let theme = prefersDark ? "dark" : "light";
  try {
    const savedTheme = localStorage.getItem(storageKey);
    if (savedTheme === "light" || savedTheme === "dark") {
      theme = savedTheme;
    }
  } catch (_error) {}
  document.documentElement.dataset.theme = theme;
})();
"""


SEARCH_PAGE_TEMPLATE = Template("""<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <title>ファイル/フォルダ置き場検索</title>
  <script>$theme_script</script>
  <style>$base_css</style>
</head>
<body>
  <div class="page-header">
    <h1>ファイル/フォルダ置き場検索</h1>
    <div class="header-actions">
      <button type="button" class="theme-toggle" data-theme-toggle aria-label="テーマ切替" title="ダークモードに切替">
        <span class="theme-toggle-icon" aria-hidden="true">☾</span>
      </button>
      <a class="nav-link" href="/settings">Settings</a>
    </div>
  </div>
  <form method="get" action="/" class="search-form">
    <div class="search-row">
      <div class="field">
        <label for="root_id">検索対象</label>
        <select id="root_id" name="root_id">$root_options</select>
      </div>
      <div class="field">
        <input id="q" type="text" name="q" value="$query" placeholder="キーワードを入力してください。" autocomplete="off" aria-label="キーワード" />
      </div>
      <button type="submit">検索</button>
    </div>
  </form>
  $meta_html
  $results
  <script>
$client_script
  </script>
</body>
</html>
""")


SETTINGS_PAGE_TEMPLATE = Template("""<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <title>検索対象フォルダ管理</title>
  <script>$theme_script</script>
  <style>$base_css</style>
</head>
<body>
  <div class="page-header">
    <h1>検索対象フォルダ管理</h1>
    <div class="header-actions">
      <button type="button" class="theme-toggle" data-theme-toggle aria-label="テーマ切替" title="ダークモードに切替">
        <span class="theme-toggle-icon" aria-hidden="true">☾</span>
      </button>
      <a class="nav-link" href="/">検索へ戻る</a>
    </div>
  </div>
  <div class="panel">
    <form method="post" action="/settings/action" class="settings-form">
      <input type="hidden" name="action" value="choose_root" />
      <div class="field">
        <label for="display_name">表示名</label>
        <input id="display_name" type="text" name="display_name" placeholder="例: 会社サーバー" />
      </div>
      <button type="submit">Open</button>
    </form>
  </div>
  $notice
  $roots_table
  <script>
$client_script
  </script>
</body>
</html>
""")


CLIENT_SCRIPT = """
document.addEventListener("DOMContentLoaded", function () {
  const themeToggle = document.querySelector("[data-theme-toggle]");
  const themeIcon = themeToggle ? themeToggle.querySelector(".theme-toggle-icon") : null;
  const storageKey = "file-search-db-theme";

  const updateThemeToggle = function (theme) {
    if (!themeToggle || !themeIcon) {
      return;
    }
    if (theme === "dark") {
      themeIcon.textContent = "☀";
      themeToggle.setAttribute("title", "ライトモードに切替");
      themeToggle.setAttribute("aria-label", "ライトモードに切替");
    } else {
      themeIcon.textContent = "☾";
      themeToggle.setAttribute("title", "ダークモードに切替");
      themeToggle.setAttribute("aria-label", "ダークモードに切替");
    }
  };

  const applyTheme = function (theme, persist) {
    document.documentElement.dataset.theme = theme;
    updateThemeToggle(theme);
    if (persist) {
      localStorage.setItem(storageKey, theme);
    }
  };

  applyTheme(document.documentElement.dataset.theme || "light", false);
  if (themeToggle) {
    themeToggle.addEventListener("click", function () {
      const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      applyTheme(nextTheme, true);
    });
  }

  try {
    navigator.sendBeacon("/ping", "");
  } catch (_error) {}
  window.setInterval(function () {
    try {
      navigator.sendBeacon("/ping", "");
    } catch (_error) {}
  }, 1000);

  let isInternalNavigation = false;
  document.querySelectorAll("a[href]").forEach(function (link) {
    link.addEventListener("click", function () {
      const href = link.getAttribute("href") || "";
      if (href.startsWith("/") && !href.startsWith("/open?")) {
        isInternalNavigation = true;
      }
    });
  });
  document.querySelectorAll("form").forEach(function (targetForm) {
    targetForm.addEventListener("submit", function () {
      isInternalNavigation = true;
    });
  });
  window.addEventListener("pagehide", function () {
    if (isInternalNavigation) {
      return;
    }
    try {
      navigator.sendBeacon("/shutdown", "");
    } catch (_error) {}
  });

  const openPath = async function (path) {
    const open_query = new URLSearchParams({ path: path });
    const openUrl = "/open?" + open_query.toString();
    try {
      await fetch(openUrl, { method: "GET", cache: "no-store" });
    } catch (_error) {
    }
  };

  const renderPreviewMessage = function (panel, message, className) {
    panel.textContent = "";
    const messageElement = document.createElement("div");
    messageElement.className = className;
    messageElement.textContent = message;
    panel.appendChild(messageElement);
  };

  const loadPreview = async function (link, panel, rootId) {
    const path = link.getAttribute("data-child-path") || "";
    if (!path || !panel || !rootId) {
      return;
    }

    const detailRow = link.closest("[data-expand-row]");
    if (detailRow) {
      detailRow.querySelectorAll(".children-link").forEach(function (otherLink) {
        otherLink.classList.remove("is-active");
      });
    }
    panel.querySelectorAll(".children-link").forEach(function (otherLink) {
      otherLink.classList.remove("is-active");
    });
    link.classList.add("is-active");

    const query = new URLSearchParams({ root_id: rootId, path: path });
    renderPreviewMessage(panel, "読み込み中...", "preview-loading");
    try {
      const response = await fetch("/preview?" + query.toString(), { method: "GET", cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) {
        renderPreviewMessage(panel, payload && payload.error ? String(payload.error) : "プレビューを取得できませんでした。", "preview-error");
        return;
      }

      panel.textContent = "";
      const meta = document.createElement("div");
      meta.className = "preview-meta";
      const name = path.split(/[\\\\/]/).pop() || path;
      meta.textContent = name + (payload.truncated ? " / 先頭のみ表示" : "");
      panel.appendChild(meta);

      if (!payload.content) {
        renderPreviewMessage(panel, payload.error || "プレビューできるテキスト内容がありません。", "preview-note");
        return;
      }

      const pre = document.createElement("pre");
      pre.className = "preview-content";
      pre.textContent = payload.content;
      panel.appendChild(pre);
    } catch (_error) {
      renderPreviewMessage(panel, "プレビューを取得できませんでした。", "preview-error");
    }
  };

  const renderChildrenItems = function (panel, payload) {
    panel.textContent = "";
    if (!payload || !Array.isArray(payload.items) || payload.items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "children-empty";
      empty.textContent = "表示できる項目はありません。";
      panel.appendChild(empty);
      return;
    }

    const list = document.createElement("ul");
    list.className = "children-list";
    payload.items.forEach(function (item) {
      const row = document.createElement("li");
      row.className = "children-item";

      const kind = document.createElement("span");
      kind.className = "children-kind";
      kind.textContent = item.type === "dir" ? "DIR" : "FILE";
      row.appendChild(kind);

      const link = document.createElement("a");
      link.className = "children-link";
      link.href = "#";
      link.setAttribute("data-child-path", item.path || "");
      link.setAttribute("data-child-type", item.type || "");
      link.textContent = item.type === "dir" ? "/" + (item.name || item.path || "(unknown)") : (item.name || item.path || "(unknown)");
      row.appendChild(link);

      list.appendChild(row);
    });
    panel.appendChild(list);
  };

  let expandedDetailRow = null;
  const closeExpandedRow = function () {
    if (!expandedDetailRow) {
      return;
    }
    const ownerRow = expandedDetailRow.previousElementSibling;
    if (ownerRow) {
      const ownerToggle = ownerRow.querySelector("[data-expand-toggle]");
      if (ownerToggle) {
        ownerToggle.setAttribute("data-expanded", "false");
      }
    }
    expandedDetailRow.hidden = true;
    expandedDetailRow = null;
  };

  document.addEventListener("click", async function (event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const folderOpenButton = target.closest("[data-open-folder-path]");
    if (folderOpenButton) {
      event.preventDefault();
      const path = folderOpenButton.getAttribute("data-open-folder-path");
      if (path) {
        await openPath(path);
      }
      return;
    }

    const childLink = target.closest("[data-child-path]");
    if (childLink) {
      event.preventDefault();
      const childType = childLink.getAttribute("data-child-type") || "";
      const path = childLink.getAttribute("data-child-path") || "";
      if (childType === "dir") {
        await openPath(path);
        return;
      }
      const detailRow = childLink.closest("[data-expand-row]");
      const previewPanel = detailRow ? detailRow.querySelector("[data-preview-panel]") : null;
      const rootId = detailRow ? detailRow.getAttribute("data-root-id") || "" : "";
      await loadPreview(childLink, previewPanel, rootId);
      return;
    }

    const openLink = target.closest("[data-folder-path]");
    if (openLink) {
      event.preventDefault();
      const path = openLink.getAttribute("data-folder-path");
      if (path) {
        await openPath(path);
      }
      return;
    }

    const toggleLink = target.closest("[data-expand-toggle]");
    if (!toggleLink) {
      return;
    }
    event.preventDefault();

    const row = toggleLink.closest("tr[data-row-path]");
    if (!row) {
      return;
    }
    const detailRow = row.nextElementSibling;
    if (!detailRow || !detailRow.hasAttribute("data-expand-row")) {
      return;
    }

    if (detailRow.hidden === false) {
      toggleLink.setAttribute("data-expanded", "false");
      detailRow.hidden = true;
      if (expandedDetailRow === detailRow) {
        expandedDetailRow = null;
      }
      return;
    }

    closeExpandedRow();
    toggleLink.setAttribute("data-expanded", "true");
    detailRow.hidden = false;
    expandedDetailRow = detailRow;

    const rootId = toggleLink.getAttribute("data-root-id") || "";
    const folderPath = toggleLink.getAttribute("data-expand-path") || "";
    const panel = detailRow.querySelector("[data-child-panel]");
    const previewPanel = detailRow.querySelector("[data-preview-panel]");
    if (!rootId || !folderPath || !panel) {
      return;
    }

    panel.textContent = "";
    if (previewPanel) {
      renderPreviewMessage(previewPanel, "ファイルを選択するとここにプレビューを表示します。", "preview-empty");
    }
    const loading = document.createElement("div");
    loading.className = "children-loading";
    loading.textContent = "読み込み中...";
    panel.appendChild(loading);

    const query = new URLSearchParams({ root_id: rootId, path: folderPath });
    try {
      const response = await fetch("/children?" + query.toString(), { method: "GET", cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) {
        const error = document.createElement("div");
        error.className = "children-error";
        error.textContent = payload && payload.error ? String(payload.error) : "項目を取得できませんでした。";
        panel.textContent = "";
        panel.appendChild(error);
        return;
      }
      renderChildrenItems(panel, payload);
    } catch (_error) {
      const error = document.createElement("div");
      error.className = "children-error";
      error.textContent = "項目を取得できませんでした。";
      panel.textContent = "";
      panel.appendChild(error);
    }
  });

  const form = document.querySelector(".search-form");
  const queryInput = document.getElementById("q");
  const rootSelect = document.getElementById("root_id");
  if (!form || !queryInput || !rootSelect) {
    return;
  }

  const restoreQueryFocus = function () {
    window.requestAnimationFrame(function () {
      queryInput.focus({ preventScroll: true });
      const cursorPosition = queryInput.value.length;
      if (typeof queryInput.setSelectionRange === "function") {
        queryInput.setSelectionRange(cursorPosition, cursorPosition);
      }
    });
  };
  restoreQueryFocus();

  const AUTO_SUBMIT_DELAY_MS = 500;
  let timerId = null;
  let isComposing = false;
  let isSubmitting = false;

  const clearScheduledSubmit = function () {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  };

  const submitForm = function () {
    if (isSubmitting || rootSelect.value === "") {
      return;
    }
    isSubmitting = true;
    clearScheduledSubmit();
    if (typeof form.requestSubmit === "function") {
      form.requestSubmit();
      return;
    }
    form.submit();
  };

  const scheduleSubmit = function () {
    clearScheduledSubmit();
    if (isComposing) {
      return;
    }
    timerId = window.setTimeout(submitForm, AUTO_SUBMIT_DELAY_MS);
  };

  queryInput.addEventListener("input", scheduleSubmit);
  rootSelect.addEventListener("change", submitForm);
  queryInput.addEventListener("compositionstart", function () {
    isComposing = true;
    clearScheduledSubmit();
  });
  queryInput.addEventListener("compositionend", function () {
    isComposing = false;
    scheduleSubmit();
  });
  form.addEventListener("submit", function () {
    isSubmitting = true;
    clearScheduledSubmit();
  });
});
"""


class FileSearchHandler(BaseHTTPRequestHandler):
    db_path = str(DEFAULT_DB_PATH)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/":
            self._handle_search_page(parsed)
            return
        if parsed.path == "/settings":
            self._handle_settings_page(parsed)
            return
        if parsed.path == "/open":
            self._handle_open_path(parsed)
            return
        if parsed.path == "/children":
            self._handle_children(parsed)
            return
        if parsed.path == "/preview":
            self._handle_preview(parsed)
            return
        self.send_error(HTTPStatus.NOT_FOUND, "Not Found")

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/settings/action":
            self._handle_settings_action()
            return
        if parsed.path == "/ping":
            self._handle_ping()
            return
        if parsed.path == "/shutdown":
            self._handle_shutdown()
            return
        self.send_error(HTTPStatus.NOT_FOUND, "Not Found")

    def log_message(self, format, *args):
        return

    def _handle_search_page(self, parsed):
        root_id, query = self._parse_search_inputs(parsed.query)
        roots, selected_root_id = self._load_roots(root_id)
        rows = []
        message = ""

        if not roots:
            message = ""
        elif selected_root_id is None:
            message = "検索対象を選択してください"
        elif not query:
            message = ""
        else:
            conn, warning = self._connect_existing_db()
            if conn is None:
                message = warning
            else:
                with closing(conn):
                    rows = search_folders(conn, selected_root_id, query)
                message = f"{len(rows)}件ヒット"

        body = SEARCH_PAGE_TEMPLATE.safe_substitute(
            theme_script=THEME_SCRIPT,
            base_css=BASE_CSS,
            client_script=CLIENT_SCRIPT,
            root_options=self._render_root_options(roots, selected_root_id),
            query=html.escape(query),
            meta_html=self._render_meta(message),
            results="" if not roots or not query else self.render_results(rows, query),
        ).encode("utf-8")
        self._send_html(body)

    def _handle_settings_page(self, parsed):
        params = parse_qs(parsed.query)
        message = params.get("message", [""])[0].strip()
        kind = params.get("kind", ["info"])[0].strip()
        notice = self._render_notice(message, kind) if message else ""

        roots = []
        conn, _warning = self._connect_existing_db(create=True)
        if conn is not None:
            with closing(conn):
                roots = list_roots(conn)

        body = SETTINGS_PAGE_TEMPLATE.safe_substitute(
            theme_script=THEME_SCRIPT,
            base_css=BASE_CSS,
            client_script=CLIENT_SCRIPT,
            notice=notice,
            roots_table=self.render_roots_table(roots),
        ).encode("utf-8")
        self._send_html(body)

    def _handle_settings_action(self):
        params = self._read_post_params()
        action = params.get("action", [""])[0].strip()

        try:
            db_path = Path(self.db_path)
            db_path.parent.mkdir(parents=True, exist_ok=True)
            conn = connect_db(db_path)
            try:
                ensure_db(conn)
                if action == "choose_root":
                    display_name = params.get("display_name", [""])[0].strip()
                    root_path = choose_folder_path()
                    root = add_root(conn, display_name, root_path)
                    count = scan_root(conn, root.id)
                    conn.commit()
                    self._redirect_with_message("info", f"{root.display_name} を登録しました。{count}件のフォルダをスキャン済です。")
                    return
                if action == "rescan_root":
                    root = self._require_root(conn, params)
                    count = scan_root(conn, root.id)
                    conn.commit()
                    self._redirect_with_message("info", f"{root.display_name} を再スキャンしました。{count}件のフォルダを登録済です。")
                    return
                if action == "delete_root":
                    root = self._require_root(conn, params)
                    delete_root(conn, root.id)
                    conn.commit()
                    self._redirect_with_message("info", f"{root.display_name} を削除しました。")
                    return
                raise ValueError("未対応の操作です。")
            finally:
                conn.close()
        except Exception as exc:
            self._redirect_with_message("error", str(exc))

    def _handle_open_path(self, parsed):
        params = parse_qs(parsed.query)
        path_value = params.get("path", [""])[0].strip()
        if not path_value:
            self.send_error(HTTPStatus.BAD_REQUEST, "path is required")
            return

        path = Path(path_value)
        if not path.exists():
            self.send_error(HTTPStatus.NOT_FOUND, "Path not found")
            return

        try:
            open_path_in_file_manager(path)
        except Exception as exc:
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, f"Open failed: {exc}")
            return

        return_to = params.get("return_to", [""])[0].strip()
        if return_to:
            self.send_response(HTTPStatus.SEE_OTHER)
            self.send_header("Location", return_to)
            self.end_headers()
            return

        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def _handle_ping(self):
        if hasattr(self.server, "cancel_pending_shutdown"):
            self.server.cancel_pending_shutdown()
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def _handle_shutdown(self):
        if hasattr(self.server, "schedule_shutdown"):
            self.server.schedule_shutdown(delay_seconds=2.0)
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def _send_html(self, body: bytes):
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status: HTTPStatus, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle_children(self, parsed):
        params = parse_qs(parsed.query)
        root_value = params.get("root_id", [""])[0].strip()
        path_value = params.get("path", [""])[0].strip()
        if not root_value:
            self._send_json(HTTPStatus.BAD_REQUEST, {"path": path_value, "items": [], "error": "root_id is required"})
            return
        if not path_value:
            self._send_json(HTTPStatus.BAD_REQUEST, {"path": path_value, "items": [], "error": "path is required"})
            return
        try:
            root_id = int(root_value)
        except ValueError:
            self._send_json(HTTPStatus.BAD_REQUEST, {"path": path_value, "items": [], "error": "root_id is invalid"})
            return

        path = Path(path_value)
        if not path.exists():
            self._send_json(HTTPStatus.NOT_FOUND, {"path": path_value, "items": [], "error": "Path not found"})
            return
        if not path.is_dir():
            self._send_json(HTTPStatus.BAD_REQUEST, {"path": path_value, "items": [], "error": "Path is not a directory"})
            return

        conn, warning = self._connect_existing_db()
        if conn is None:
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"path": path_value, "items": [], "error": warning or "DB unavailable"})
            return

        try:
            with closing(conn):
                root = get_root(conn, root_id)
            if root is None:
                self._send_json(HTTPStatus.NOT_FOUND, {"path": path_value, "items": [], "error": "Root not found"})
                return

            target_path = path.resolve()
            root_path = Path(root.root_path).resolve()
            try:
                target_path.relative_to(root_path)
            except ValueError:
                self._send_json(HTTPStatus.FORBIDDEN, {"path": str(target_path), "items": [], "error": "Path is outside root"})
                return

            items = self._collect_children_items(target_path)
            self._send_json(HTTPStatus.OK, {"path": str(target_path), "items": items, "error": None})
        except OSError:
            self._send_json(HTTPStatus.BAD_REQUEST, {"path": path_value, "items": [], "error": "Path cannot be resolved"})

    def _handle_preview(self, parsed):
        params = parse_qs(parsed.query)
        root_value = params.get("root_id", [""])[0].strip()
        path_value = params.get("path", [""])[0].strip()
        if not root_value:
            self._send_json(HTTPStatus.BAD_REQUEST, self._preview_payload(path_value, error="root_id is required"))
            return
        if not path_value:
            self._send_json(HTTPStatus.BAD_REQUEST, self._preview_payload(path_value, error="path is required"))
            return
        try:
            root_id = int(root_value)
        except ValueError:
            self._send_json(HTTPStatus.BAD_REQUEST, self._preview_payload(path_value, error="root_id is invalid"))
            return

        path = Path(path_value)
        if not path.exists():
            self._send_json(HTTPStatus.NOT_FOUND, self._preview_payload(path_value, error="Path not found"))
            return
        if not path.is_file():
            self._send_json(HTTPStatus.BAD_REQUEST, self._preview_payload(path_value, error="Path is not a file"))
            return

        conn, warning = self._connect_existing_db()
        if conn is None:
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, self._preview_payload(path_value, error=warning or "DB unavailable"))
            return

        try:
            with closing(conn):
                root = get_root(conn, root_id)
            if root is None:
                self._send_json(HTTPStatus.NOT_FOUND, self._preview_payload(path_value, error="Root not found"))
                return

            target_path = path.resolve()
            root_path = Path(root.root_path).resolve()
            try:
                target_path.relative_to(root_path)
            except ValueError:
                self._send_json(HTTPStatus.FORBIDDEN, self._preview_payload(str(target_path), error="Path is outside root"))
                return

            self._send_json(HTTPStatus.OK, self._read_preview(target_path))
        except OSError:
            self._send_json(HTTPStatus.BAD_REQUEST, self._preview_payload(path_value, error="Path cannot be resolved"))

    @staticmethod
    def _preview_payload(path: str, content: str = "", truncated: bool = False, encoding: str = "", mime: str = "", error: Optional[str] = None):
        return {
            "path": path,
            "content": content,
            "truncated": truncated,
            "encoding": encoding,
            "mime": mime,
            "error": error,
        }

    @staticmethod
    def _read_preview(file_path: Path):
        mime = mimetypes.guess_type(str(file_path))[0] or ""
        with file_path.open("rb") as file_obj:
            raw = file_obj.read(PREVIEW_BYTES + 1)

        truncated = len(raw) > PREVIEW_BYTES
        sample = raw[:PREVIEW_BYTES]
        if b"\x00" in sample:
            return FileSearchHandler._preview_payload(
                str(file_path),
                content="",
                truncated=truncated,
                encoding="binary",
                mime=mime,
                error="バイナリファイルのためプレビューできません。",
            )

        for encoding in ("utf-8", "cp932"):
            try:
                return FileSearchHandler._preview_payload(
                    str(file_path),
                    content=sample.decode(encoding),
                    truncated=truncated,
                    encoding=encoding,
                    mime=mime,
                    error=None,
                )
            except UnicodeDecodeError:
                continue

        return FileSearchHandler._preview_payload(
            str(file_path),
            content=sample.decode("utf-8", errors="replace"),
            truncated=truncated,
            encoding="utf-8-replace",
            mime=mime,
            error=None,
        )

    @staticmethod
    def _collect_children_items(folder_path: Path):
        typed_items = []
        try:
            entries = list(folder_path.iterdir())
        except OSError:
            return []

        for entry in entries:
            if entry.name.startswith("."):
                continue
            item_type = ""
            if entry.is_dir():
                item_type = "dir"
            elif entry.is_file():
                item_type = "file"
            if not item_type:
                continue
            typed_items.append(
                (
                    0 if item_type == "dir" else 1,
                    entry.name.casefold(),
                    {"name": entry.name, "path": str(entry.resolve()), "type": item_type},
                )
            )
        typed_items.sort(key=lambda item: (item[0], item[1]))
        return [item[2] for item in typed_items]

    def _redirect_with_message(self, kind: str, message: str):
        query = urlencode({"kind": kind, "message": message})
        self.send_response(HTTPStatus.SEE_OTHER)
        self.send_header("Location", f"/settings?{query}")
        self.end_headers()

    def _connect_existing_db(self, create: bool = False) -> Tuple[Optional[sqlite3.Connection], str]:
        db_path = Path(self.db_path)
        if not db_path.exists() and not create:
            return None, "DBファイルが見つかりません"
        if create:
            db_path.parent.mkdir(parents=True, exist_ok=True)
            conn = connect_db(db_path)
            ensure_db(conn)
            conn.commit()
            return conn, ""

        db_uri = f"{db_path.resolve().as_uri()}?mode=rw"
        try:
            conn = sqlite3.connect(db_uri, uri=True)
            conn.execute("PRAGMA foreign_keys=ON")
            ensure_db(conn)
            return conn, ""
        except sqlite3.OperationalError:
            return None, "DBファイルを開けません"

    def _read_post_params(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        payload = self.rfile.read(length).decode("utf-8")
        return parse_qs(payload)

    @staticmethod
    def _require_root(conn: sqlite3.Connection, params):
        root_id = int(params.get("root_id", ["0"])[0] or "0")
        root = get_root(conn, root_id)
        if root is None:
            raise ValueError("検索対象フォルダが見つかりません")
        return root

    @staticmethod
    def _render_notice(message: str, kind: str) -> str:
        css_class = "notice is-error" if kind == "error" else "notice"
        return f"<div class='{css_class}'>{html.escape(message)}</div>"

    @staticmethod
    def _render_meta(message: str) -> str:
        if not message:
            return ""
        return f"<div class='meta'><strong>{html.escape(message)}</strong></div>"

    @staticmethod
    def _parse_search_inputs(query_string: str) -> Tuple[Optional[int], str]:
        params = parse_qs(query_string)
        root_value = params.get("root_id", [""])[0].strip()
        query = params.get("q", [""])[0].strip()
        if not root_value:
            return None, query
        try:
            return int(root_value), query
        except ValueError:
            return None, query

    def _load_roots(self, requested_root_id: Optional[int]):
        conn, _warning = self._connect_existing_db()
        if conn is None:
            return [], None
        with closing(conn):
            roots = list_roots(conn)
        if not roots:
            return roots, None
        root_ids = {root.id for root in roots}
        if requested_root_id in root_ids:
            return roots, requested_root_id
        return roots, roots[0].id

    @staticmethod
    def _render_root_options(roots, selected_root_id: Optional[int]) -> str:
        if not roots:
            return "<option value=''>未登録</option>"
        options = []
        for root in roots:
            selected = " selected" if root.id == selected_root_id else ""
            label = f"{root.display_name} ({root.folder_count} folders)"
            options.append(f"<option value='{root.id}'{selected}>{html.escape(label)}</option>")
        return "\n".join(options)

    @staticmethod
    def _highlight_text(text: str, query: str) -> str:
        parsed_query = parse_folder_query(query)
        terms = sorted(
            {term for group in parsed_query.positive_groups for term in group},
            key=len,
            reverse=True,
        )
        if not text or not terms:
            return html.escape(text)

        pattern = re.compile("|".join(re.escape(term) for term in terms), re.IGNORECASE)
        parts = []
        last_end = 0
        for match in pattern.finditer(text):
            start, end = match.span()
            if start < last_end:
                continue
            parts.append(html.escape(text[last_end:start]))
            parts.append(f"<mark>{html.escape(text[start:end])}</mark>")
            last_end = end
        parts.append(html.escape(text[last_end:]))
        return "".join(parts)

    @classmethod
    def render_results(cls, rows, query: str) -> str:
        if not rows:
            return "<div class='empty'>該当するフォルダが見つかりませんでした。</div>"
        lines = [
            "<table class='result-table'>",
            "<thead><tr><th>親フォルダ/フォルダ</th></tr></thead>",
            "<tbody>",
        ]
        for row in rows:
            parent_name = Path(row.parent_path).name or row.parent_path
            row_path = html.escape(row.path, quote=True)
            folder_label = f"{html.escape(parent_name)}/{cls._highlight_text(row.name, query)}"
            lines.append(
                f"<tr data-row-path='{row_path}' data-root-id='{row.root_id}'>"
                "<td>"
                "<div class='folder-cell'>"
                f"<a class='folder-name' data-expand-toggle='1' data-expanded='false' data-root-id='{row.root_id}' data-expand-path='{row_path}' href='#'>{folder_label}</a>"
                "</div>"
                "</td>"
                "</tr>"
                f"<tr class='result-detail-row' data-expand-row='1' data-root-id='{row.root_id}' hidden>"
                "<td colspan='1'>"
                "<div class='detail-shell'>"
                "<div class='detail-toolbar'>"
                f"<button type='button' class='folder-open-button' data-open-folder-path='{row_path}' title='フォルダを開く' aria-label='フォルダを開く'>↗</button>"
                "</div>"
                "<div class='detail-grid'>"
                "<div class='children-panel' data-child-panel='1'></div>"
                "<div class='preview-panel' data-preview-panel='1'><div class='preview-empty'>ファイルを選択するとここにプレビューを表示します。</div></div>"
                "</div>"
                "</div>"
                "</td>"
                "</tr>"
            )
        lines.append("</tbody></table>")
        return "\n".join(lines)

    @staticmethod
    def _current_search_path(root_id: int, query: str) -> str:
        return f"/?{urlencode({'root_id': root_id, 'q': query})}"

    @staticmethod
    def render_roots_table(roots) -> str:
        if not roots:
            return "<div class='empty'>検索対象フォルダはまだ登録されていません。</div>"

        lines = [
            "<table>",
            "<thead><tr><th>表示名</th><th>パス</th><th>状態</th><th>操作</th></tr></thead>",
            "<tbody>",
        ]
        for root in roots:
            scanned = root.last_scanned_at or "未スキャン"
            actions = (
                "<div class='actions'>"
                "<form method='post' action='/settings/action'>"
                f"<input type='hidden' name='root_id' value='{root.id}' />"
                "<input type='hidden' name='action' value='rescan_root' />"
                "<button type='submit' class='button-secondary'>再スキャン</button>"
                "</form>"
                "<form method='post' action='/settings/action'>"
                f"<input type='hidden' name='root_id' value='{root.id}' />"
                "<input type='hidden' name='action' value='delete_root' />"
                "<button type='submit' class='button-danger'>削除</button>"
                "</form>"
                "</div>"
            )
            lines.append(
                "<tr>"
                f"<td><div class='root-name'>{html.escape(root.display_name)}</div></td>"
                f"<td><div class='path'>{html.escape(root.root_path)}</div></td>"
                f"<td><span class='badge'>{root.folder_count} folders</span><div class='muted'>last scan: {html.escape(scanned)}</div></td>"
                f"<td>{actions}</td>"
                "</tr>"
            )
        lines.append("</tbody></table>")
        return "\n".join(lines)


class FileSearchServer(ThreadingHTTPServer):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._shutdown_timer = None
        self._shutdown_lock = threading.Lock()

    def cancel_pending_shutdown(self) -> None:
        with self._shutdown_lock:
            if self._shutdown_timer is not None:
                self._shutdown_timer.cancel()
                self._shutdown_timer = None

    def schedule_shutdown(self, delay_seconds: float = 2.0) -> None:
        def _shutdown():
            self.shutdown()

        with self._shutdown_lock:
            if self._shutdown_timer is not None:
                self._shutdown_timer.cancel()
            self._shutdown_timer = threading.Timer(delay_seconds, _shutdown)
            self._shutdown_timer.daemon = True
            self._shutdown_timer.start()


def parse_args():
    parser = argparse.ArgumentParser(description="登録フォルダをSQLiteから検索するWeb UI")
    parser.add_argument("--db", default=str(DEFAULT_DB_PATH), help="SQLite DB パス")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8765, type=int)
    return parser.parse_args()


def build_server_url(host: str, port: int) -> str:
    return f"http://{host}:{port}"


def open_browser(url: str, delay_seconds: float = 0.3) -> None:
    def _open():
        if delay_seconds > 0:
            time.sleep(delay_seconds)
        try:
            webbrowser.open(url)
        except Exception as exc:
            print(f"[WARN] failed to open browser: {exc}")

    threading.Thread(target=_open, daemon=True).start()


def choose_folder_path() -> str:
    if sys.platform == "darwin":
        script = 'POSIX path of (choose folder with prompt "検索対象フォルダを選択")'
        result = subprocess.run(
            ["osascript", "-e", script],
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            return result.stdout.strip()
        raise ValueError("フォルダ選択がキャンセルされました。")

    try:
        import tkinter as tk
        from tkinter import filedialog
    except ImportError as exc:
        raise RuntimeError("この環境ではフォルダ選択ダイアログを開けません。") from exc

    root = tk.Tk()
    root.withdraw()
    try:
        selected = filedialog.askdirectory(title="検索対象フォルダを選択")
    finally:
        root.destroy()
    if not selected:
        raise ValueError("フォルダ選択がキャンセルされました。")
    return selected


def open_path_in_file_manager(path: Path) -> None:
    if sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
        return
    if sys.platform.startswith("win"):
        os.startfile(str(path))  # type: ignore[attr-defined]
        return
    subprocess.Popen(["xdg-open", str(path)])


def find_listening_pids(port: int) -> list[int]:
    try:
        result = subprocess.run(
            ["lsof", "-ti", f"TCP:{port}", "-sTCP:LISTEN"],
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError:
        return []
    if result.returncode not in (0, 1):
        return []
    pids = []
    for line in result.stdout.splitlines():
        try:
            pid = int(line.strip())
        except ValueError:
            continue
        if pid != os.getpid():
            pids.append(pid)
    return pids


def stop_existing_server(port: int, timeout_seconds: float = 3.0) -> list[int]:
    pids = find_listening_pids(port)
    if not pids:
        return []

    for pid in pids:
        try:
            os.kill(pid, 15)
        except ProcessLookupError:
            pass

    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        remaining = find_listening_pids(port)
        if not remaining:
            return pids
        time.sleep(0.1)

    for pid in find_listening_pids(port):
        try:
            os.kill(pid, 9)
        except ProcessLookupError:
            pass
    return pids


def main():
    args = parse_args()
    FileSearchHandler.db_path = args.db
    db_path = Path(args.db)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = connect_db(db_path)
    try:
        ensure_db(conn)
        conn.commit()
    finally:
        conn.close()

    url = build_server_url(args.host, args.port)
    stopped_pids = stop_existing_server(args.port)
    if stopped_pids:
        print(f"[INFO] stopped previous server on port {args.port}: {', '.join(str(pid) for pid in stopped_pids)}")

    try:
        server = FileSearchServer((args.host, args.port), FileSearchHandler)
    except OSError as exc:
        if exc.errno in (errno.EADDRINUSE, 48):
            print(f"[ERROR] port {args.port} is still in use. Please close the old process and run again.")
            return
        raise

    print(f"[INFO] serving {url} (db={args.db})")
    open_browser(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

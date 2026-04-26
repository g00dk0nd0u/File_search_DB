"""Local Web UI for searching registered project folders."""

from __future__ import annotations

import argparse
from contextlib import closing
from datetime import datetime
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
from urllib.parse import parse_qs, quote, urlencode, urlparse

if __package__ in (None, ""):
    from file_database import add_root, connect_db, delete_root, ensure_db, get_root, list_roots, parse_folder_query, scan_root, search_folders
else:
    from .file_database import add_root, connect_db, delete_root, ensure_db, get_root, list_roots, parse_folder_query, scan_root, search_folders


DEFAULT_DB_PATH = Path(__file__).resolve().parent.parent / "data" / "file_index.db"
PREVIEW_BYTES = 16 * 1024
EXTRA_MIME_TYPES = {
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".gif": "image/gif",
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".jfif": "image/jpeg",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".webp": "image/webp",
}


def guess_mime_type(path: Path) -> str:
    mime = mimetypes.guess_type(str(path))[0]
    if mime:
        return mime
    return EXTRA_MIME_TYPES.get(path.suffix.casefold(), "application/octet-stream")


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
  --mark-bg: #ffc66d;
  --mark-text: #1f3656;
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
  --mark-bg: #d99a2b;
  --mark-text: #111827;
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
.search-row {
  justify-content: space-between;
}
.settings-form {
  justify-content: space-between;
}
.field {
  display: grid;
  gap: 0.3rem;
}
.field-grow { flex: 1 1 22rem; }
.search-tools {
  display: inline-flex;
  align-items: center;
  gap: 0.55rem;
  padding-left: 0.75rem;
  border-left: 1px solid var(--border-soft);
  margin-left: auto;
}
.search-input-group { display: flex; }
.search-input-group #q {
  border-radius: 5px 0 0 5px;
  border-right: none;
}
.search-input-group button {
  border-radius: 0 5px 5px 0;
  white-space: nowrap;
}
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
  background: var(--surface-muted);
  color: var(--text-muted);
  padding: 0.6rem 0.75rem;
  text-align: left;
  font-size: 0.8125rem;
  font-weight: 600;
  white-space: nowrap;
  border-bottom: 1px solid var(--border-color);
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
.folder-name::before {
  content: "";
  display: inline-block;
  flex-shrink: 0;
  width: 0.42rem;
  height: 0.42rem;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(-45deg);
  transition: transform 0.15s ease;
}
.folder-name[data-expanded="true"]::before {
  transform: rotate(45deg);
}
.breadcrumb-parent {
  color: var(--text-muted);
  font-weight: 600;
}
.breadcrumb-separator {
  color: var(--text-subtle);
  margin: 0 0.35rem;
}
.breadcrumb-current {
  font-weight: 700;
}
tr[data-row-path]:has(.folder-name[data-expanded="true"]) td {
  border-left: 2px solid var(--accent-color);
}
.detail-shell {
  display: grid;
  gap: 0.55rem;
}
.folder-open-button {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 2rem;
  height: 2rem;
  padding: 0;
  border: 1px solid var(--border-button);
  border-radius: 6px;
  background: var(--nav-bg);
  color: var(--link-color);
  line-height: 1;
}
.folder-open-button::before {
  content: "";
  position: absolute;
  left: 0.45rem;
  bottom: 0.45rem;
  width: 0.65rem;
  height: 0.65rem;
  border: 1.6px solid currentColor;
  border-radius: 2px;
}
.folder-open-button::after {
  content: "";
  position: absolute;
  right: 0.42rem;
  top: 0.42rem;
  width: 0.48rem;
  height: 0.48rem;
  border-top: 1.8px solid currentColor;
  border-right: 1.8px solid currentColor;
  transform: translate(-0.02rem, 0.02rem) rotate(0deg);
}
.folder-open-button:hover { background: var(--surface-hover); }
.folder-open-button:focus-visible {
  outline: none;
  box-shadow: var(--shadow-ring);
}
.detail-grid {
  display: grid;
  grid-template-columns: minmax(18rem, max-content) minmax(16rem, 1fr);
  gap: 0.75rem;
  align-items: start;
}
.children-panel,
.preview-panel {
  min-width: 0;
}
.preview-panel {
  position: relative;
  min-width: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  padding: 0;
  display: flex;
  justify-content: center;
  align-items: flex-start;
}
.preview-folder-list {
  width: 100%;
}
.children-panel {
  min-width: 18rem;
  width: max-content;
  max-width: 100%;
  overflow-x: visible;
  border: 0;
  border-radius: 0;
  background: transparent;
  padding: 0.35rem 0;
}
.children-list {
  list-style: none;
  margin: 0;
  padding: 0.12rem 0 0;
}
.children-item {
  display: flex;
  align-items: baseline;
  padding: 0.12rem 0;
  line-height: 1.35;
}
.children-link {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  color: var(--link-color);
  text-decoration: none;
  font-weight: 500;
  white-space: nowrap;
}
.children-icon {
  position: relative;
  flex: 0 0 1rem;
  width: 1rem;
  height: 1rem;
  color: var(--text-subtle);
}
.children-icon.is-dir::before {
  content: "";
  position: absolute;
  left: 0.05rem;
  top: 0.27rem;
  width: 0.9rem;
  height: 0.6rem;
  border: 1.5px solid currentColor;
  border-radius: 2px;
}
.children-icon.is-dir::after {
  content: "";
  position: absolute;
  left: 0.12rem;
  top: 0.15rem;
  width: 0.38rem;
  height: 0.24rem;
  border: 1.5px solid currentColor;
  border-bottom: 0;
  border-radius: 2px 2px 0 0;
}
.children-icon.is-file::before {
  content: "";
  position: absolute;
  left: 0.17rem;
  top: 0.08rem;
  width: 0.68rem;
  height: 0.84rem;
  border: 1.5px solid currentColor;
  border-radius: 2px;
}
.children-icon.is-file::after {
  content: "";
  position: absolute;
  right: 0.15rem;
  top: 0.08rem;
  width: 0.28rem;
  height: 0.28rem;
  border-left: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  background: var(--surface-color);
}
.children-name {
  white-space: nowrap;
}
.children-link:hover {
  text-decoration: underline;
}
.children-link.is-file-match {
  background: var(--surface-hover);
  border-radius: 4px;
  padding: 0.08rem 0.35rem 0.08rem 0.3rem;
  font-weight: 700;
}
.children-link.is-active {
  background: var(--surface-hover);
  border-left: 3px solid var(--accent-color);
  border-radius: 4px;
  padding: 0.08rem 0.35rem 0.08rem 0.3rem;
  font-weight: 700;
}
.children-link.is-active .children-name {
  color: var(--text-strong);
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
  background: transparent;
  border: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.8rem;
  line-height: 1.45;
  color: var(--text-color);
}
.pdf-preview-frame {
  display: block;
  width: min(56%, 31rem);
  height: 38rem;
  min-height: 38rem;
  margin: 0 auto;
  border: 0;
  border-radius: 0;
  background: transparent;
}
.image-preview {
  display: block;
  max-width: min(100%, 34rem);
  max-height: 34rem;
  margin: 0 auto;
  border: 1px solid var(--border-soft);
  border-radius: 6px;
  background: var(--surface-color);
  object-fit: contain;
}
.preview-open-button {
  position: absolute;
  top: 0.35rem;
  right: 0.35rem;
  width: 1.65rem;
  height: 1.65rem;
  border: 1px solid var(--border-button);
  border-radius: 6px;
  background: var(--nav-bg);
  color: var(--link-color);
  opacity: 0.85;
  text-decoration: none;
  z-index: 2;
}
.preview-open-button:hover {
  opacity: 1;
  background: var(--surface-hover);
}
.preview-open-button::before {
  content: "";
  position: absolute;
  left: 0.42rem;
  bottom: 0.42rem;
  width: 0.58rem;
  height: 0.58rem;
  border: 1.5px solid currentColor;
  border-radius: 2px;
}
.preview-open-button::after {
  content: "";
  position: absolute;
  right: 0.38rem;
  top: 0.38rem;
  width: 0.48rem;
  height: 0.48rem;
  border-top: 1.7px solid currentColor;
  border-right: 1.7px solid currentColor;
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
  display: grid;
  grid-template-columns: minmax(0, 1fr) 8rem 2rem;
  align-items: center;
  gap: 0.75rem;
}
.folder-name {
  justify-self: start;
}
.folder-main {
  min-width: 0;
}
.open-icon-button {
  display: none;
}
.result-count {
  display: inline-flex;
  margin-left: 0.75rem;
  color: var(--button-text);
  font-size: 0.8125rem;
  font-weight: 600;
}
.file-match-badge {
  display: inline-flex;
  align-items: center;
  justify-self: center;
  margin-left: 0;
  min-width: 5.5rem;
  justify-content: center;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  background: var(--surface-muted);
  color: var(--text-subtle);
  font-size: 0.74rem;
  font-weight: 700;
  white-space: nowrap;
}
.file-match-badge.is-empty {
  visibility: hidden;
}
.folder-open-button {
  justify-self: end;
}
@media (max-width: 720px) {
  .detail-grid {
    grid-template-columns: 1fr;
  }
  .children-panel {
    width: 100%;
    min-width: 0;
  }
  .pdf-preview-frame {
    width: 100%;
    height: 32rem;
    min-height: 32rem;
  }
  .image-preview {
    max-width: 100%;
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
.root-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: nowrap;
}
.root-actions form { margin: 0; }
mark {
  background: var(--mark-bg);
  color: var(--mark-text);
  border-radius: 3px;
  padding: 0 3px;
  font-weight: 700;
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
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Folder Search</title>
  <script>$theme_script</script>
  <style>$base_css</style>
</head>
<body>
  <form method="get" action="/" class="search-form">
    <div class="search-row">
      <div class="field">
        <label for="root_id">Search Target</label>
        <select id="root_id" name="root_id">$root_options</select>
      </div>
      <div class="field field-grow">
        <div class="search-input-group">
          <input id="q" type="text" name="q" value="$query" placeholder="Enter keyword" autocomplete="off" aria-label="Keyword" />
          <button type="submit">Search</button>
        </div>
      </div>
      <div class="search-tools">
        <button type="button" class="theme-toggle" data-theme-toggle aria-label="Toggle theme" title="Switch to dark mode">
          <span class="theme-toggle-icon" aria-hidden="true">☾</span>
        </button>
        <a class="nav-link" href="$settings_href">Settings</a>
      </div>
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
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Folder Manager</title>
  <script>$theme_script</script>
  <style>$base_css</style>
</head>
<body>
  <div class="panel">
    <form method="post" action="/settings/action" class="settings-form">
      <input type="hidden" name="action" value="choose_root" />
      $return_to_input
      <div class="field">
        <input id="display_name" type="text" name="display_name" placeholder="Example: Company Server" />
      </div>
      <button type="submit">Choose Folder</button>
      <div class="search-tools">
        <button type="button" class="theme-toggle" data-theme-toggle aria-label="Toggle theme" title="Switch to dark mode">
          <span class="theme-toggle-icon" aria-hidden="true">☾</span>
        </button>
        <a class="nav-link" href="$back_to_search_href">Back to Search</a>
      </div>
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
      themeToggle.setAttribute("title", "Switch to light mode");
      themeToggle.setAttribute("aria-label", "Switch to light mode");
    } else {
      themeIcon.textContent = "☾";
      themeToggle.setAttribute("title", "Switch to dark mode");
      themeToggle.setAttribute("aria-label", "Switch to dark mode");
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

  const uiStateStorageKey = "file-search-db-ui-state:" + window.location.pathname + window.location.search;
  const readUiState = function () {
    try {
      const raw = sessionStorage.getItem(uiStateStorageKey);
      if (!raw) {
        return { expandedPaths: [], selectedChildByFolder: {} };
      }
      const parsed = JSON.parse(raw);
      return {
        expandedPaths: Array.isArray(parsed.expandedPaths) ? parsed.expandedPaths : [],
        selectedChildByFolder: parsed && typeof parsed.selectedChildByFolder === "object" && parsed.selectedChildByFolder ? parsed.selectedChildByFolder : {},
      };
    } catch (_error) {
      return { expandedPaths: [], selectedChildByFolder: {} };
    }
  };

  const writeUiState = function (state) {
    try {
      sessionStorage.setItem(uiStateStorageKey, JSON.stringify(state));
    } catch (_error) {
    }
  };

  const setFolderExpandedState = function (folderPath, expanded) {
    if (!folderPath) {
      return;
    }
    const state = readUiState();
    state.expandedPaths = state.expandedPaths.filter(function (path) {
      return path !== folderPath;
    });
    if (expanded) {
      state.expandedPaths.push(folderPath);
    } else {
      delete state.selectedChildByFolder[folderPath];
    }
    writeUiState(state);
  };

  const setSelectedChildState = function (folderPath, childPath) {
    if (!folderPath) {
      return;
    }
    const state = readUiState();
    if (childPath) {
      state.selectedChildByFolder[folderPath] = childPath;
      if (state.expandedPaths.indexOf(folderPath) === -1) {
        state.expandedPaths.push(folderPath);
      }
    } else {
      delete state.selectedChildByFolder[folderPath];
    }
    writeUiState(state);
  };

  const renderPreviewMessage = function (panel, message, className) {
    const messageElement = document.createElement("div");
    messageElement.className = className;
    messageElement.textContent = message;
    panel.replaceChildren(messageElement);
  };

  const createPreviewOpenButton = function (href, label) {
    const button = document.createElement("a");
    button.className = "preview-open-button";
    button.href = href;
    button.target = "_blank";
    button.rel = "noopener";
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    button.textContent = "";
    return button;
  };

  const isPdfPath = function (path) {
    return String(path || "").toLowerCase().endsWith(".pdf");
  };

  const isImageMime = function (mime) {
    return String(mime || "").toLowerCase().startsWith("image/");
  };

  const isOfficeMime = function (mime, path) {
    const normalizedMime = String(mime || "").toLowerCase();
    const normalizedPath = String(path || "").toLowerCase();
    return (
      normalizedMime === "application/msword" ||
      normalizedMime === "application/vnd.ms-excel" ||
      normalizedMime === "application/vnd.ms-powerpoint" ||
      normalizedMime.indexOf("application/vnd.openxmlformats-officedocument") === 0 ||
      normalizedPath.endsWith(".doc") ||
      normalizedPath.endsWith(".docx") ||
      normalizedPath.endsWith(".xls") ||
      normalizedPath.endsWith(".xlsx") ||
      normalizedPath.endsWith(".ppt") ||
      normalizedPath.endsWith(".pptx")
    );
  };

  const buildFileUrl = function (rootId, path) {
    const query = new URLSearchParams({ root_id: rootId, path: path });
    return "/file?" + query.toString();
  };

  const buildImageViewUrl = function (rootId, path) {
    const query = new URLSearchParams({ root_id: rootId, path: path });
    return "/view_image?" + query.toString();
  };

  const renderPdfPreview = function (panel, rootId, path) {
    const fileUrl = buildFileUrl(rootId, path);
    const pdfViewUrl = fileUrl + "#zoom=page-fit";
    const frame = document.createElement("iframe");
    frame.className = "pdf-preview-frame";
    frame.src = pdfViewUrl;
    frame.title = path.split(/[\\\\/]/).pop() || path;
    const button = createPreviewOpenButton(pdfViewUrl, "Open PDF in new tab");
    panel.replaceChildren(frame, button);
  };

  const renderImagePreview = function (panel, rootId, path) {
    const fileUrl = buildFileUrl(rootId, path);
    const image = new Image();
    image.className = "image-preview";
    image.alt = path.split(/[\\\\/]/).pop() || path;
    const button = createPreviewOpenButton(buildImageViewUrl(rootId, path), "Open image in new tab");
    image.onload = function () {
      panel.replaceChildren(image, button);
    };
    image.onerror = function () {
      renderPreviewMessage(panel, "Could not load image preview.", "preview-error");
    };
    image.src = fileUrl;
  };

  const renderOfficePreviewNote = function (panel, rootId, path) {
    const note = document.createElement("div");
    note.className = "preview-note";
    note.textContent = "Office files cannot be previewed directly in this browser. Open the file in a new tab or desktop app.";
    const button = createPreviewOpenButton(buildFileUrl(rootId, path), "Open file in new tab");
    panel.replaceChildren(note, button);
  };

  const loadPreview = async function (link, panel, rootId) {
    const path = link.getAttribute("data-child-path") || "";
    if (!path || !panel || !rootId) {
      return;
    }

    const detailRow = link.closest("[data-expand-row]");
    const folderPath = detailRow ? detailRow.getAttribute("data-folder-path") || "" : "";
    if (detailRow) {
      detailRow.querySelectorAll(".children-link").forEach(function (otherLink) {
        otherLink.classList.remove("is-active");
      });
    }
    panel.querySelectorAll(".children-link").forEach(function (otherLink) {
      otherLink.classList.remove("is-active");
    });
    link.classList.add("is-active");
    setSelectedChildState(folderPath, path);

    if (isPdfPath(path)) {
      renderPdfPreview(panel, rootId, path);
      return;
    }

    const query = new URLSearchParams({ root_id: rootId, path: path });
    if (!panel.hasChildNodes()) {
      renderPreviewMessage(panel, "Loading...", "preview-loading");
    }
    try {
      const response = await fetch("/preview?" + query.toString(), { method: "GET", cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) {
        renderPreviewMessage(panel, payload && payload.error ? String(payload.error) : "Could not load preview.", "preview-error");
        return;
      }
      if (payload && payload.mime === "application/pdf") {
        renderPdfPreview(panel, rootId, path);
        return;
      }
      if (payload && isImageMime(payload.mime)) {
        renderImagePreview(panel, rootId, path);
        return;
      }
      if (payload && isOfficeMime(payload.mime, path)) {
        renderOfficePreviewNote(panel, rootId, path);
        return;
      }

      if (!payload.content) {
        const note = document.createElement("div");
        note.className = "preview-note";
        note.textContent = payload.error || "No previewable text content is available.";
        const button = createPreviewOpenButton(buildFileUrl(rootId, path), "Open file in new tab");
        panel.replaceChildren(note, button);
        return;
      }

      const pre = document.createElement("pre");
      pre.className = "preview-content";
      pre.textContent = payload.content;
      const button = createPreviewOpenButton(buildFileUrl(rootId, path), "Open file in new tab");
      panel.replaceChildren(pre, button);
    } catch (_error) {
      renderPreviewMessage(panel, "Could not load preview.", "preview-error");
    }
  };

  const createPreviewFolderOpenButton = function (path, label) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "preview-open-button";
    button.setAttribute("data-open-folder-path", path);
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    button.textContent = "";
    return button;
  };

  const loadFolderPreview = async function (folderPath, panel, rootId) {
    if (!folderPath || !panel || !rootId) {
      return;
    }

    renderPreviewMessage(panel, "Loading...", "preview-loading");

    const query = new URLSearchParams({ root_id: rootId, path: folderPath });
    const currentSearchQuery = document.getElementById("q");
    if (currentSearchQuery && currentSearchQuery.value.trim()) {
      query.set("q", currentSearchQuery.value.trim());
    }
    try {
      const response = await fetch("/children?" + query.toString(), { method: "GET", cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) {
        renderPreviewMessage(panel, payload && payload.error ? String(payload.error) : "Could not load items.", "preview-error");
        return;
      }
      const listWrap = document.createElement("div");
      listWrap.className = "preview-folder-list";
      renderChildrenItems(listWrap, payload);
      const openLabel = "Open in Finder";
      panel.replaceChildren(listWrap, createPreviewFolderOpenButton(folderPath, openLabel));
    } catch (_error) {
      renderPreviewMessage(panel, "Could not load items.", "preview-error");
    }
  };

  const loadChildrenForDetail = async function (detailRow, folderPath, rootId, selectedChildPath) {
    const panel = detailRow ? detailRow.querySelector("[data-child-panel]") : null;
    const previewPanel = detailRow ? detailRow.querySelector("[data-preview-panel]") : null;
    if (!detailRow || !rootId || !folderPath || !panel) {
      return;
    }

    detailRow.setAttribute("data-folder-path", folderPath);
    panel.textContent = "";
    if (previewPanel) {
      renderPreviewMessage(previewPanel, "Select a file to preview it here.", "preview-empty");
    }
    const loading = document.createElement("div");
    loading.className = "children-loading";
    loading.textContent = "Loading...";
    panel.appendChild(loading);

    const query = new URLSearchParams({ root_id: rootId, path: folderPath });
    const currentSearchQuery = document.getElementById("q");
    if (currentSearchQuery && currentSearchQuery.value.trim()) {
      query.set("q", currentSearchQuery.value.trim());
    }
    try {
      const response = await fetch("/children?" + query.toString(), { method: "GET", cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) {
        const error = document.createElement("div");
        error.className = "children-error";
        error.textContent = payload && payload.error ? String(payload.error) : "Could not load items.";
        panel.textContent = "";
        panel.appendChild(error);
        return;
      }
      renderChildrenItems(panel, payload);
      if (selectedChildPath && previewPanel) {
        const selectedLink = detailRow.querySelector('.children-link[data-child-path="' + CSS.escape(selectedChildPath) + '"]');
        if (selectedLink) {
          await loadPreview(selectedLink, previewPanel, rootId);
        }
      }
    } catch (_error) {
      const error = document.createElement("div");
      error.className = "children-error";
      error.textContent = "Could not load items.";
      panel.textContent = "";
      panel.appendChild(error);
    }
  };

  const renderChildrenItems = function (panel, payload) {
    panel.textContent = "";
    if (!payload || !Array.isArray(payload.items) || payload.items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "children-empty";
      empty.textContent = "No items available.";
      panel.appendChild(empty);
      return;
    }

    const list = document.createElement("ul");
    list.className = "children-list";
    payload.items.forEach(function (item) {
      const row = document.createElement("li");
      row.className = "children-item";

      const link = document.createElement("a");
      link.className = "children-link";
      if (item.type === "file" && item.is_match) {
        link.classList.add("is-file-match");
      }
      link.href = "#";
      link.setAttribute("data-child-path", item.path || "");
      link.setAttribute("data-child-type", item.type || "");

      const icon = document.createElement("span");
      icon.className = item.type === "dir" ? "children-icon is-dir" : "children-icon is-file";
      icon.setAttribute("aria-hidden", "true");
      link.appendChild(icon);

      const name = document.createElement("span");
      name.className = "children-name";
      if (item.display_html) {
        name.innerHTML = item.display_html;
      } else {
        name.textContent = item.type === "dir" ? "/" + (item.name || item.path || "(unknown)") : (item.name || item.path || "(unknown)");
      }
      link.appendChild(name);

      row.appendChild(link);

      list.appendChild(row);
    });
    panel.appendChild(list);
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
      const detailRow = childLink.closest("[data-expand-row]");
      const previewPanel = detailRow ? detailRow.querySelector("[data-preview-panel]") : null;
      const rootId = detailRow ? detailRow.getAttribute("data-root-id") || "" : "";
      const childType = childLink.getAttribute("data-child-type") || "";
      const path = childLink.getAttribute("data-child-path") || "";
      if (childType === "dir") {
        await loadFolderPreview(path, previewPanel, rootId);
        return;
      }
      await loadPreview(childLink, previewPanel, rootId);
      return;
    }

    const openLink = target.closest("a[data-folder-path], button[data-folder-path]");
    if (openLink instanceof HTMLAnchorElement || openLink instanceof HTMLButtonElement) {
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
      setFolderExpandedState(toggleLink.getAttribute("data-expand-path") || "", false);
      return;
    }

    toggleLink.setAttribute("data-expanded", "true");
    detailRow.hidden = false;

    const rootId = toggleLink.getAttribute("data-root-id") || "";
    const folderPath = toggleLink.getAttribute("data-expand-path") || "";
    if (!rootId || !folderPath) {
      return;
    }
    setFolderExpandedState(folderPath, true);
    await loadChildrenForDetail(detailRow, folderPath, rootId, readUiState().selectedChildByFolder[folderPath] || "");
  });

  const restoreUiState = async function () {
    const state = readUiState();
    for (const folderPath of state.expandedPaths) {
      const toggleLink = document.querySelector('[data-expand-toggle][data-expand-path="' + CSS.escape(folderPath) + '"]');
      if (!toggleLink) {
        continue;
      }
      const row = toggleLink.closest("tr[data-row-path]");
      const detailRow = row ? row.nextElementSibling : null;
      if (!row || !detailRow || !detailRow.hasAttribute("data-expand-row")) {
        continue;
      }
      toggleLink.setAttribute("data-expanded", "true");
      detailRow.hidden = false;
      const rootId = toggleLink.getAttribute("data-root-id") || "";
      await loadChildrenForDetail(detailRow, folderPath, rootId, state.selectedChildByFolder[folderPath] || "");
    }
  };

  const form = document.querySelector(".search-form");
  const queryInput = document.getElementById("q");
  const rootSelect = document.getElementById("root_id");
  if (!form || !queryInput || !rootSelect) {
    return;
  }
  restoreUiState();

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
        if parsed.path == "/file":
            self._handle_file(parsed)
            return
        if parsed.path == "/view_image":
            self._handle_view_image(parsed)
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
        result_message = ""

        if not roots:
            message = ""
        elif selected_root_id is None:
            message = "Please select a search target."
        elif not query:
            message = ""
        else:
            conn, warning = self._connect_existing_db()
            if conn is None:
                message = warning
            else:
                with closing(conn):
                    rows = search_folders(conn, selected_root_id, query)
                result_message = f"{len(rows)} hit(s)"

        body = SEARCH_PAGE_TEMPLATE.safe_substitute(
            theme_script=THEME_SCRIPT,
            base_css=BASE_CSS,
            client_script=CLIENT_SCRIPT,
            root_options=self._render_root_options(roots, selected_root_id),
            query=html.escape(query),
            meta_html=self._render_meta(message),
            settings_href=self._settings_href(selected_root_id, query),
            results="" if not roots or not query else self.render_results(rows, query, result_message),
        ).encode("utf-8")
        self._send_html(body)

    def _handle_settings_page(self, parsed):
        params = parse_qs(parsed.query)
        message = params.get("message", [""])[0].strip()
        kind = params.get("kind", ["info"])[0].strip()
        return_to = params.get("return_to", [""])[0].strip()
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
            roots_table=self.render_roots_table(roots, return_to),
            back_to_search_href=html.escape(return_to or "/"),
            return_to_input=self._render_hidden_return_to(return_to),
        ).encode("utf-8")
        self._send_html(body)

    def _handle_settings_action(self):
        params = self._read_post_params()
        action = params.get("action", [""])[0].strip()
        return_to = params.get("return_to", [""])[0].strip()

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
                    self._redirect_with_message("info", f"Added {root.display_name}. {count} folder(s) scanned.", return_to)
                    return
                if action == "rescan_root":
                    root = self._require_root(conn, params)
                    count = scan_root(conn, root.id)
                    conn.commit()
                    self._redirect_with_message("info", f"Reloaded {root.display_name}. {count} folder(s) registered.", return_to)
                    return
                if action == "delete_root":
                    root = self._require_root(conn, params)
                    delete_root(conn, root.id)
                    conn.commit()
                    self._redirect_with_message("info", f"Deleted {root.display_name}.", return_to)
                    return
                raise ValueError("Unsupported action.")
            finally:
                conn.close()
        except Exception as exc:
            self._redirect_with_message("error", str(exc), return_to)

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
        query = params.get("q", [""])[0].strip()
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

            items = self._collect_children_items(target_path, query)
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

    def _resolve_requested_file(self, parsed) -> Optional[Path]:
        params = parse_qs(parsed.query)
        root_value = params.get("root_id", [""])[0].strip()
        path_value = params.get("path", [""])[0].strip()
        if not root_value:
            self.send_error(HTTPStatus.BAD_REQUEST, "root_id is required")
            return None
        if not path_value:
            self.send_error(HTTPStatus.BAD_REQUEST, "path is required")
            return None
        try:
            root_id = int(root_value)
        except ValueError:
            self.send_error(HTTPStatus.BAD_REQUEST, "root_id is invalid")
            return None

        path = Path(path_value)
        if not path.exists():
            self.send_error(HTTPStatus.NOT_FOUND, "Path not found")
            return None
        if not path.is_file():
            self.send_error(HTTPStatus.BAD_REQUEST, "Path is not a file")
            return None

        conn, warning = self._connect_existing_db()
        if conn is None:
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, warning or "DB unavailable")
            return None

        try:
            with closing(conn):
                root = get_root(conn, root_id)
            if root is None:
                self.send_error(HTTPStatus.NOT_FOUND, "Root not found")
                return None

            target_path = path.resolve()
            root_path = Path(root.root_path).resolve()
            try:
                target_path.relative_to(root_path)
            except ValueError:
                self.send_error(HTTPStatus.FORBIDDEN, "Path is outside root")
                return None
            return target_path
        except OSError as exc:
            self.send_error(HTTPStatus.BAD_REQUEST, f"File cannot be read: {exc}")
            return None

    def _handle_file(self, parsed):
        target_path = self._resolve_requested_file(parsed)
        if target_path is None:
            return

        try:
            content_length = target_path.stat().st_size
            file_obj = target_path.open("rb")
        except OSError as exc:
            self.send_error(HTTPStatus.BAD_REQUEST, f"File cannot be read: {exc}")
            return

        mime = guess_mime_type(target_path)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mime)
        encoded_filename = quote(target_path.name, safe="")
        ascii_fallback = target_path.name.encode("ascii", "ignore").decode("ascii").strip()
        if not ascii_fallback:
            ascii_fallback = "file" + target_path.suffix
        ascii_fallback = ascii_fallback.replace("\\", "_").replace('"', "_")
        self.send_header(
            "Content-Disposition",
            f"inline; filename=\"{ascii_fallback}\"; filename*=UTF-8''{encoded_filename}",
        )
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(content_length))
        self.end_headers()
        try:
            with file_obj:
                while True:
                    chunk = file_obj.read(1024 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            return

    def _handle_view_image(self, parsed):
        target_path = self._resolve_requested_file(parsed)
        if target_path is None:
            return

        params = parse_qs(parsed.query)
        root_value = params.get("root_id", [""])[0].strip()
        path_value = params.get("path", [""])[0].strip()
        file_url = "/file?" + urlencode({"root_id": root_value, "path": path_value})
        title = html.escape(target_path.name)
        image_src = html.escape(file_url, quote=True)
        body = f"""<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <title>{title}</title>
  <style>
    body {{
      margin: 0;
      background: #111;
      display: flex;
      justify-content: center;
      align-items: flex-start;
      min-height: 100vh;
    }}
    img {{
      display: block;
      max-width: 100vw;
      height: auto;
    }}
  </style>
</head>
<body>
  <img src="{image_src}" alt="{title}">
</body>
</html>
""".encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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
        mime = guess_mime_type(file_path)
        if file_path.suffix.casefold() == ".pdf" or mime == "application/pdf":
            return FileSearchHandler._preview_payload(
                str(file_path),
                content="",
                truncated=False,
                encoding="",
                mime="application/pdf",
                error="PDF files are shown in the right pane.",
            )
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
                error="Binary files cannot be previewed.",
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
    def _query_matches_text(text: str, query: str) -> bool:
        parsed_query = parse_folder_query(query)
        if not parsed_query.positive_groups:
            return False
        value = (text or "").casefold()
        if any(term.casefold() in value for term in parsed_query.excluded_terms):
            return False
        return any(all(term.casefold() in value for term in group) for group in parsed_query.positive_groups)

    @staticmethod
    def _collect_children_items(folder_path: Path, query: str = ""):
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
            display_name = entry.name
            is_match = FileSearchHandler._query_matches_text(entry.name, query)
            if item_type == "dir":
                if is_match:
                    display_html = "/" + FileSearchHandler._highlight_text(display_name, query)
                else:
                    display_html = "/" + html.escape(display_name)
            elif is_match:
                display_html = FileSearchHandler._highlight_text(display_name, query)
            else:
                display_html = html.escape(display_name)
            typed_items.append(
                (
                    0 if item_type == "dir" else 1,
                    entry.name.casefold(),
                    {
                        "name": entry.name,
                        "path": str(entry.resolve()),
                        "type": item_type,
                        "is_match": item_type == "file" and is_match,
                        "display_html": display_html,
                    },
                )
            )
        typed_items.sort(key=lambda item: (item[0], item[1]))
        return [item[2] for item in typed_items]

    def _redirect_with_message(self, kind: str, message: str, return_to: str = ""):
        payload = {"kind": kind, "message": message}
        if return_to:
            payload["return_to"] = return_to
        query = urlencode(payload)
        self.send_response(HTTPStatus.SEE_OTHER)
        self.send_header("Location", f"/settings?{query}")
        self.end_headers()

    def _connect_existing_db(self, create: bool = False) -> Tuple[Optional[sqlite3.Connection], str]:
        db_path = Path(self.db_path)
        if not db_path.exists() and not create:
            return None, "DB file not found"
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
            return None, "Could not open DB file"

    def _read_post_params(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        payload = self.rfile.read(length).decode("utf-8")
        return parse_qs(payload)

    @staticmethod
    def _require_root(conn: sqlite3.Connection, params):
        root_id = int(params.get("root_id", ["0"])[0] or "0")
        root = get_root(conn, root_id)
        if root is None:
            raise ValueError("Search target folder not found")
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
            return "<option value=''>No entries</option>"
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
    def render_results(cls, rows, query: str, result_message: str = "") -> str:
        if not rows:
            return "<div class='empty'>No matching folders were found.</div>"
        lines = [
            "<table class='result-table'>",
            "<tbody>",
        ]
        for row in rows:
            parent_name = Path(row.parent_path).name or row.parent_path
            row_path = html.escape(row.path, quote=True)
            parent_label = html.escape(parent_name)
            if cls._query_matches_text(row.name, query):
                current_label = cls._highlight_text(row.name, query)
            else:
                current_label = html.escape(row.name)
            if parent_name:
                folder_label = (
                    f"<span class='breadcrumb-parent'>{parent_label}</span>"
                    "<span class='breadcrumb-separator'>/</span>"
                    f"<span class='breadcrumb-current'>{current_label}</span>"
                )
            else:
                folder_label = f"<span class='breadcrumb-current'>{current_label}</span>"
            file_match_count = getattr(row, "file_match_count", 0)
            if file_match_count:
                label = "file" if row.file_match_count == 1 else "files"
                file_match_badge = f"<span class='file-match-badge'>{row.file_match_count} {label}</span>"
            else:
                file_match_badge = "<span class='file-match-badge is-empty' aria-hidden='true'></span>"
            open_label = "Open in Finder" if sys.platform == "darwin" else "Open Folder"
            lines.append(
                f"<tr data-row-path='{row_path}' data-root-id='{row.root_id}'>"
                "<td>"
                "<div class='folder-cell'>"
                f"<a class='folder-name' data-expand-toggle='1' data-expanded='false' data-root-id='{row.root_id}' data-expand-path='{row_path}' href='#'>{folder_label}</a>"
                f"{file_match_badge}"
                f"<button type='button' class='folder-open-button' data-open-folder-path='{row_path}' aria-label='{open_label}' title='{open_label}'></button>"
                "</div>"
                "</td>"
                "</tr>"
                f"<tr class='result-detail-row' data-expand-row='1' data-root-id='{row.root_id}' hidden>"
                "<td colspan='1'>"
                "<div class='detail-shell'>"
                "<div class='detail-grid'>"
                "<div class='children-panel' data-child-panel='1'></div>"
                "<div class='preview-panel' data-preview-panel='1'><div class='preview-empty'>Select a file to preview it here.</div></div>"
                "</div>"
                "</div>"
                "</td>"
                "</tr>"
            )
        lines.append("</tbody></table>")
        return "\n".join(lines)

    @staticmethod
    def _current_search_path(root_id: Optional[int], query: str) -> str:
        payload = {}
        if root_id is not None:
            payload["root_id"] = root_id
        if query:
            payload["q"] = query
        return f"/?{urlencode(payload)}" if payload else "/"

    @staticmethod
    def render_roots_table(roots, return_to: str = "") -> str:
        if not roots:
            return "<div class='empty'>No search target folders have been added yet.</div>"

        lines = [
            "<table>",
            "<thead><tr><th>Display Name</th><th>Path</th><th>Status</th><th>Actions</th></tr></thead>",
            "<tbody>",
        ]
        return_to_input = FileSearchHandler._render_hidden_return_to(return_to)
        for root in roots:
            scanned = FileSearchHandler._format_scan_time(root.last_scanned_at)
            actions = (
                "<div class='root-actions'>"
                "<form method='post' action='/settings/action'>"
                f"<input type='hidden' name='root_id' value='{root.id}' />"
                "<input type='hidden' name='action' value='rescan_root' />"
                f"{return_to_input}"
                "<button type='submit' class='button-secondary'>Reload</button>"
                "</form>"
                "<form method='post' action='/settings/action'>"
                f"<input type='hidden' name='root_id' value='{root.id}' />"
                "<input type='hidden' name='action' value='delete_root' />"
                f"{return_to_input}"
                "<button type='submit' class='button-danger'>Delete</button>"
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

    @staticmethod
    def _format_scan_time(scanned_at: str) -> str:
        if not scanned_at:
            return "Not scanned"
        try:
            parsed = datetime.fromisoformat(scanned_at.replace("Z", "+00:00"))
            return parsed.strftime("%Y-%m-%d %H:%M")
        except ValueError:
            return scanned_at[:16].replace("T", " ")

    @staticmethod
    def _render_hidden_return_to(return_to: str) -> str:
        if not return_to:
            return ""
        return f"<input type='hidden' name='return_to' value='{html.escape(return_to, quote=True)}' />"

    @staticmethod
    def _settings_href(root_id: Optional[int], query: str) -> str:
        return_to = FileSearchHandler._current_search_path(root_id, query)
        if return_to == "/":
            return "/settings"
        return f"/settings?{urlencode({'return_to': return_to})}"


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
    parser = argparse.ArgumentParser(description="Web UI for searching registered folders from SQLite")
    parser.add_argument("--db", default=str(DEFAULT_DB_PATH), help="Path to SQLite DB")
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
        script = 'POSIX path of (choose folder with prompt "Choose a folder to add")'
        result = subprocess.run(
            ["osascript", "-e", script],
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            return result.stdout.strip()
        raise ValueError("Folder selection was canceled.")

    try:
        import tkinter as tk
        from tkinter import filedialog
    except ImportError as exc:
        raise RuntimeError("Folder selection dialog is not available in this environment.") from exc

    root = tk.Tk()
    root.withdraw()
    try:
        selected = filedialog.askdirectory(title="Choose a folder to add")
    finally:
        root.destroy()
    if not selected:
        raise ValueError("Folder selection was canceled.")
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

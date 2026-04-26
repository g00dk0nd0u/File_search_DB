# File Search DB

This is a local web UI built with the Python standard library only. It indexes local folders into SQLite and lets you search them from the browser.

The current implementation supports the following:

- Folder name search
- File-name matches aggregated at the parent-folder level
- Child-item listing with a shallow right-pane folder preview
- Simple preview for text, images, and PDFs
- Root management in the Settings page, including add, rename, reload, and delete

No `pip install` step is required.

## Environment

- Python 3
- No third-party Python packages
- Intended for macOS, Windows, and Linux

Notes:
On macOS, folder selection uses an `osascript` folder picker.  
On other platforms, folder selection uses a `tkinter` dialog.

## Repository Structure

- `src/web_app.py`: Main web UI
- `src/file_database.py`: SQLite schema, scanning, and search logic
- `src/prepare_sqlite.py`: Helper script to initialize an empty database
- `tests/test_web_and_db.py`: Regression tests
- `tools/export_repo_zip.py`: ZIP export for ChatGPT review

## Quick Start

### 1. Initialize the database

If you want to create an empty database in advance:

```bash
python3 -m src.prepare_sqlite --db data/file_index.db
```

This step is optional because `src/web_app.py` will also create the database and tables automatically on startup.

### 2. Start the web UI

Module execution:

```bash
python3 -m src.web_app --db data/file_index.db --host 127.0.0.1 --port 8765
```

Direct execution:

```bash
python3 src/web_app.py --db data/file_index.db --host 127.0.0.1 --port 8765
```

Then open `http://127.0.0.1:8765` in your browser.  
If another process is already using the same port, startup will try to stop the previous server first.

## Usage

### 1. Add a search root

1. Open `Settings` from the top-right of the search screen
2. Click `Add Directory` in the top-left
3. Select a root folder in the folder picker
4. The selected root is scanned automatically

The initial display name defaults to the selected folder name.

### 2. Manage roots in Settings

The Settings page supports:

- Editing `Display Name` with auto-save
- `Reload` to rescan a root
- `Delete` to remove a root
- Viewing `Path`, `folder count`, and `last scan`

Display-name edits are saved without reloading the page.

### 3. Search

1. Select a `Search Target` on the search screen
2. Enter keywords to search

Results are shown at the folder level.  
If a file name matches, the result still appears as the parent folder rather than the file itself.

## Search Queries

The app supports simple Google-like operators:

- `alpha beta`: contains both `alpha` and `beta`
- `alpha OR beta`: contains either `alpha` or `beta`
- `alpha -draft`: contains `alpha` but not `draft`
- `"alpha beta"`: exact phrase match

Notes:

- Matches can come from both folder names and file names under the folder
- The result list remains folder-based even for file-name hits

## Preview and Interaction

When you expand a search result, you can inspect child items and use the right-side preview pane.

- PDF: browser-native preview
- Image: browser-native preview
- Text: simple partial text preview
- Office files: no inline preview, with guidance to open in a new tab

Other supported interactions:

- Click a folder in the left pane to show a shallow folder preview in the right pane
- Click a file to preview it in the right pane
- Open a path in Finder / Explorer / the system file manager
- Drag a file into another folder to move it

## Data Model

- `roots`: registered roots
  - `display_name`
  - `root_path`
  - `created_at`
  - `last_scanned_at`
  - `folder_count`
- `folders`: scanned folders
- `files`: scanned file-name index

When `Reload` is executed, the target root's `folders` and `files` entries are rebuilt.

## Tests

Regression tests:

```bash
python3 -m unittest tests.test_web_and_db
```

Lightweight syntax check:

```bash
python3 -m py_compile src/web_app.py src/file_database.py tests/test_web_and_db.py
```

Help commands:

```bash
python3 src/web_app.py --help
python3 src/prepare_sqlite.py --help
```

## ZIP Export for ChatGPT Review

Use `tools/export_repo_zip.py` to create a review snapshot:

```bash
python3 tools/export_repo_zip.py --repo . --output ~/Downloads
```

This script excludes:

- `.git`
- `__pycache__`
- `.gitignore` targets
- local noise files

## Notes

- The default database path is `data/file_index.db`
- The default web UI address is `127.0.0.1:8765`
- The repository is intended to stay on the Python standard library only

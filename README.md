# File Search DB

A local web app that stores folder names under registered project roots in SQLite and lets you search them from the browser.

This version focuses on **folder-name search only**. File-name search and full-text search for PDF/Word files are planned as future extensions.

This repository runs on the Python standard library only. No extra `pip install` step is required.

## Quick Start

### 1) Prepare an empty SQLite DB

```bash
python -m src.prepare_sqlite --db data/file_index.db
```

### 2) Start the Web UI

```bash
python -m src.web_app --db data/file_index.db --host 127.0.0.1 --port 8765
```

Open `http://127.0.0.1:8765` in your browser.

If `data/file_index.db` does not exist on first launch, the required DB and tables are created automatically during startup.  
Once created, the DB is reused as-is, so normal restarts do not reinitialize it every time.

## Usage

1. Open `Settings` in the top-right corner.
2. Enter a display name if needed, then click `Choose Folder`.
3. Select a folder in the folder picker. It will be added and scanned automatically.
4. Return to the search screen and choose a search target from the dropdown.
5. Enter keywords to search registered folders in real time.
6. Use `Open in Finder` or `Open Folder` in the results to open the matched folder.

## Search Keywords

Only the folder name itself is searched. Parent folder names and intermediate path segments do not match.

- `alpha beta`: folders containing both `alpha` and `beta`
- `alpha OR beta`: folders containing either `alpha` or `beta`
- `alpha -draft`: folders containing `alpha` but not `draft`
- `"alpha beta"`: folders containing the exact phrase `alpha beta`

## Database Design Overview

- `roots`: registered search target folders (display name, root path, created time, last scanned time, folder count)
- `folders`: scanned folders (root_id, folder name, absolute path, parent path, depth, updated time)

When reloading, the target root's `folders` rows are cleared and rebuilt from the current folder structure.

## Tests

```bash
python -m unittest tests.test_web_and_db
```

Quick check:

```bash
python src/web_app.py --help
```

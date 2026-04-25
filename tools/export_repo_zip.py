#!/usr/bin/env python3
"""
Create a ZIP snapshot of this repository for ChatGPT upload.

- Uses only Python standard library
- Excludes files matched by .gitignore
- Excludes .git, __pycache__, cache files, and local noise
- Saves ZIP to the user's Downloads folder by default
- Opens the output folder after creating the ZIP
"""

from __future__ import annotations

import argparse
import fnmatch
import os
import subprocess
import sys
import zipfile
from datetime import datetime
from pathlib import Path


DEFAULT_EXCLUDES = {
    ".git",
    "__pycache__",
    ".DS_Store",
}


def read_gitignore(repo_root: Path) -> list[str]:
    gitignore = repo_root / ".gitignore"
    if not gitignore.exists():
        return []

    try:
        lines = gitignore.read_text(encoding="utf-8").splitlines()
    except UnicodeDecodeError:
        lines = gitignore.read_text(encoding="utf-8", errors="ignore").splitlines()

    patterns: list[str] = []
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        patterns.append(line)

    return patterns


def is_ignored(relative_path: str, patterns: list[str]) -> bool:
    normalized = relative_path.replace(os.sep, "/")
    name = Path(normalized).name

    for raw_pattern in patterns:
        pattern = raw_pattern.strip().replace("\\", "/")
        if not pattern:
            continue

        # Directory ignore: data/
        if pattern.endswith("/"):
            folder = pattern.rstrip("/")
            if normalized == folder or normalized.startswith(folder + "/"):
                return True
            continue

        # Root-based ignore: /data/file.db
        if pattern.startswith("/"):
            pattern = pattern.lstrip("/")
            if fnmatch.fnmatch(normalized, pattern):
                return True
            continue

        # Filename ignore: *.pyc
        if "/" not in pattern:
            if fnmatch.fnmatch(name, pattern):
                return True

        # Path ignore: data/*.db
        if fnmatch.fnmatch(normalized, pattern):
            return True

    return False


def should_include(path: Path, repo_root: Path, patterns: list[str]) -> bool:
    try:
        relative = path.relative_to(repo_root)
    except ValueError:
        return False

    if any(part in DEFAULT_EXCLUDES for part in relative.parts):
        return False

    if is_ignored(str(relative), patterns):
        return False

    return True


def get_downloads_dir() -> Path:
    downloads = Path.home() / "Downloads"
    return downloads if downloads.exists() else Path.home()


def open_folder(folder: Path) -> None:
    try:
        if os.name == "nt":
            os.startfile(folder)  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.run(["open", str(folder)], check=False)
        else:
            subprocess.run(["xdg-open", str(folder)], check=False)
    except Exception as exc:
        print(f"[WARN] Could not open folder: {exc}")


def create_zip(repo_root: Path, output_dir: Path) -> Path:
    repo_name = repo_root.name
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    zip_path = output_dir / f"{repo_name}_snapshot_{timestamp}.zip"

    patterns = read_gitignore(repo_root)
    included_count = 0
    skipped_count = 0
    error_count = 0

    try:
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for path in sorted(repo_root.rglob("*")):
                if path.is_dir():
                    continue

                if not should_include(path, repo_root, patterns):
                    skipped_count += 1
                    continue

                try:
                    arcname = path.relative_to(repo_root).as_posix()
                    zf.write(path, arcname)
                    included_count += 1
                except PermissionError:
                    error_count += 1
                    print(f"[WARN] Permission denied: {path}")
                except FileNotFoundError:
                    error_count += 1
                    print(f"[WARN] File disappeared during export: {path}")
                except OSError as exc:
                    error_count += 1
                    print(f"[WARN] Could not add file: {path} ({exc})")

    except PermissionError as exc:
        raise PermissionError(f"Cannot write ZIP file: {zip_path}") from exc
    except OSError as exc:
        raise OSError(f"Failed to create ZIP file: {zip_path} ({exc})") from exc

    print(f"Created ZIP: {zip_path}")
    print(f"Included files: {included_count}")
    print(f"Skipped files: {skipped_count}")

    if error_count:
        print(f"[WARN] Files with errors: {error_count}")

    return zip_path


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Export repository files to ZIP, excluding .gitignore patterns."
    )
    parser.add_argument(
        "--repo",
        default=".",
        help="Repository root path. Default: current directory.",
    )
    parser.add_argument(
        "--output",
        default=str(get_downloads_dir()),
        help="Output directory. Default: ~/Downloads",
    )

    args = parser.parse_args()

    try:
        repo_root = Path(args.repo).expanduser().resolve()
        output_dir = Path(args.output).expanduser().resolve()

        if not repo_root.exists():
            print(f"[ERROR] Repository not found: {repo_root}")
            return 1

        if not repo_root.is_dir():
            print(f"[ERROR] Repository path is not a directory: {repo_root}")
            return 1

        output_dir.mkdir(parents=True, exist_ok=True)

        if not output_dir.is_dir():
            print(f"[ERROR] Output path is not a directory: {output_dir}")
            return 1

        zip_path = create_zip(repo_root, output_dir)

        if not zip_path.exists():
            print("[ERROR] ZIP file was not created.")
            return 1

        open_folder(output_dir)
        return 0

    except KeyboardInterrupt:
        print("\n[ERROR] Export cancelled by user.")
        return 130
    except Exception as exc:
        print(f"[ERROR] {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
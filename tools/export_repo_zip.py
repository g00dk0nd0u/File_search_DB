#!/usr/bin/env python3
"""
Create a ZIP snapshot of this repository for ChatGPT upload.

- Uses only Python standard library
- Prefer Git-tracked files by using `git ls-files`
- Falls back to .gitignore-based scan when Git is unavailable
- Excludes .git, __pycache__, and local noise
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

        if pattern.endswith("/"):
            folder = pattern.rstrip("/")
            if normalized == folder or normalized.startswith(folder + "/"):
                return True
            continue

        if pattern.startswith("/"):
            pattern = pattern.lstrip("/")
            if fnmatch.fnmatch(normalized, pattern):
                return True
            continue

        if "/" not in pattern:
            if fnmatch.fnmatch(name, pattern):
                return True

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


def get_git_tracked_files(repo_root: Path) -> list[Path] | None:
    """
    Return Git-tracked files using `git ls-files`.

    Returns None when:
    - git command is not available
    - repo_root is not a Git repository
    - git ls-files fails
    """
    try:
        result = subprocess.run(
            ["git", "-C", str(repo_root), "ls-files"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="ignore",
            check=True,
        )
    except FileNotFoundError:
        print("[WARN] git command not found. Falling back to .gitignore-based scan.")
        return None
    except subprocess.CalledProcessError:
        print("[WARN] git ls-files failed. Falling back to .gitignore-based scan.")
        return None

    files: list[Path] = []
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line:
            continue

        path = repo_root / line
        if path.is_file():
            files.append(path)

    return files


def collect_candidate_files(repo_root: Path, patterns: list[str]) -> tuple[list[Path], str]:
    git_files = get_git_tracked_files(repo_root)

    if git_files is not None:
        return sorted(git_files), "git ls-files"

    files = [
        path
        for path in sorted(repo_root.rglob("*"))
        if path.is_file() and should_include(path, repo_root, patterns)
    ]
    return files, ".gitignore fallback"


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
    candidate_files, mode = collect_candidate_files(repo_root, patterns)

    included_count = 0
    error_count = 0

    try:
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for path in candidate_files:
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
    print(f"Export mode: {mode}")
    print(f"Included files: {included_count}")

    if error_count:
        print(f"[WARN] Files with errors: {error_count}")

    return zip_path


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Export repository files to ZIP for ChatGPT review."
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
"""Folder index database helpers for the local search UI."""

from __future__ import annotations

import os
import shlex
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple, Union


@dataclass(frozen=True)
class RootRecord:
    id: int
    display_name: str
    root_path: str
    created_at: str
    last_scanned_at: str
    folder_count: int


@dataclass(frozen=True)
class FolderRecord:
    root_id: int
    root_name: str
    name: str
    path: str
    parent_path: str
    depth: int
    updated_at: str
    match_kind: str
    folder_name_matched: bool = False
    file_match_count: int = 0
    matched_file_names: Tuple[str, ...] = ()
    matched_file_paths: Tuple[str, ...] = ()


@dataclass(frozen=True)
class ParsedFolderQuery:
    positive_groups: List[List[str]]
    excluded_terms: List[str]


SCHEMA_SQL = """
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;

    CREATE TABLE IF NOT EXISTS roots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        display_name TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_scanned_at TEXT NOT NULL DEFAULT '',
        folder_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        root_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        parent_path TEXT NOT NULL,
        depth INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(root_id, path),
        FOREIGN KEY(root_id) REFERENCES roots(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        root_id INTEGER NOT NULL,
        folder_path TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_name TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(root_id, file_path),
        FOREIGN KEY(root_id) REFERENCES roots(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_folders_root_name ON folders(root_id, name);
    CREATE INDEX IF NOT EXISTS idx_folders_root_path ON folders(root_id, path);
    CREATE INDEX IF NOT EXISTS idx_files_root_name ON files(root_id, file_name);
    CREATE INDEX IF NOT EXISTS idx_files_root_folder ON files(root_id, folder_path);
"""


def connect_db(db_path: Union[str, Path]) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def ensure_db(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA_SQL)


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        PRAGMA foreign_keys=OFF;
        DROP TABLE IF EXISTS files;
        DROP TABLE IF EXISTS folders;
        DROP TABLE IF EXISTS roots;
        """
    )
    ensure_db(conn)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_root_path(root_path: Union[str, Path]) -> Path:
    path = Path(str(root_path)).expanduser()
    if not path.exists():
        raise FileNotFoundError(f"フォルダが見つかりません: {path}")
    if not path.is_dir():
        raise NotADirectoryError(f"フォルダではありません: {path}")
    return path.resolve()


def _default_display_name(path: Path) -> str:
    return path.name or str(path)


def add_root(conn: sqlite3.Connection, display_name: str, root_path: Union[str, Path]) -> RootRecord:
    ensure_db(conn)
    normalized_path = _normalize_root_path(root_path)
    name = (display_name or "").strip() or _default_display_name(normalized_path)
    now = _now()
    conn.execute(
        """
        INSERT INTO roots(display_name, root_path, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(root_path) DO UPDATE SET
            display_name=excluded.display_name
        """,
        (name, str(normalized_path), now),
    )
    root = get_root_by_path(conn, str(normalized_path))
    if root is None:
        raise RuntimeError("登録したルートを読み込めませんでした")
    return root


def get_root(conn: sqlite3.Connection, root_id: int) -> Optional[RootRecord]:
    ensure_db(conn)
    row = conn.execute(
        """
        SELECT id, display_name, root_path, created_at, last_scanned_at, folder_count
        FROM roots
        WHERE id = ?
        """,
        (root_id,),
    ).fetchone()
    return _root_from_row(row) if row else None


def get_root_by_path(conn: sqlite3.Connection, root_path: str) -> Optional[RootRecord]:
    ensure_db(conn)
    row = conn.execute(
        """
        SELECT id, display_name, root_path, created_at, last_scanned_at, folder_count
        FROM roots
        WHERE root_path = ?
        """,
        (root_path,),
    ).fetchone()
    return _root_from_row(row) if row else None


def list_roots(conn: sqlite3.Connection) -> List[RootRecord]:
    ensure_db(conn)
    rows = conn.execute(
        """
        SELECT id, display_name, root_path, created_at, last_scanned_at, folder_count
        FROM roots
        ORDER BY display_name COLLATE NOCASE, root_path
        """
    ).fetchall()
    return [_root_from_row(row) for row in rows]


def delete_root(conn: sqlite3.Connection, root_id: int) -> None:
    ensure_db(conn)
    conn.execute("DELETE FROM roots WHERE id = ?", (root_id,))


def update_root_display_name(conn: sqlite3.Connection, root_id: int, display_name: str) -> RootRecord:
    ensure_db(conn)
    normalized_name = (display_name or "").strip()
    if not normalized_name:
        raise ValueError("Display Name is required")

    conn.execute(
        "UPDATE roots SET display_name = ? WHERE id = ?",
        (normalized_name, root_id),
    )
    root = get_root(conn, root_id)
    if root is None:
        raise ValueError("Search target folder not found")
    return root


def scan_root(conn: sqlite3.Connection, root_id: int) -> int:
    ensure_db(conn)
    root = get_root(conn, root_id)
    if root is None:
        raise ValueError("検索対象フォルダが見つかりません")

    root_path = _normalize_root_path(root.root_path)
    now = _now()
    folder_rows, file_rows = _scan_rows(root_path, now)

    conn.execute("DELETE FROM folders WHERE root_id = ?", (root_id,))
    conn.execute("DELETE FROM files WHERE root_id = ?", (root_id,))
    conn.executemany(
        """
        INSERT INTO folders(root_id, name, path, parent_path, depth, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        [(root_id, name, path, parent_path, depth, updated_at) for name, path, parent_path, depth, updated_at in folder_rows],
    )
    conn.executemany(
        """
        INSERT INTO files(root_id, folder_path, file_path, file_name, updated_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        [(root_id, folder_path, file_path, file_name, updated_at) for folder_path, file_path, file_name, updated_at in file_rows],
    )
    conn.execute(
        """
        UPDATE roots
        SET last_scanned_at = ?, folder_count = ?
        WHERE id = ?
        """,
        (now, len(folder_rows), root_id),
    )
    return len(folder_rows)


def search_folders(conn: sqlite3.Connection, root_id: int, query: str, limit: int = 100) -> List[FolderRecord]:
    ensure_db(conn)
    parsed_query = parse_folder_query(query)
    if not parsed_query.positive_groups and not parsed_query.excluded_terms:
        return []
    root = get_root(conn, root_id)
    if root is None:
        return []

    positive_terms = _extract_positive_terms(parsed_query)
    candidate_paths: set[str] = set()
    file_hits: Dict[str, Dict[str, object]] = {}
    if positive_terms:
        candidate_paths.update(_find_candidate_folder_paths_by_name(conn, root_id, positive_terms))
        file_rows = _find_candidate_file_rows(conn, root_id, positive_terms)
        for folder_path, file_path, file_name in file_rows:
            folder_key = str(folder_path)
            candidate_paths.add(folder_key)
            if not _matches_parsed_query(str(file_name), parsed_query):
                continue
            bucket = file_hits.setdefault(
                folder_key,
                {"count": 0, "names": [], "paths": []},
            )
            bucket["count"] = int(bucket["count"]) + 1
            names = bucket["names"]
            paths = bucket["paths"]
            if str(file_name) not in names:
                names.append(str(file_name))
            paths.append(str(file_path))
    else:
        candidate_paths.update(_list_all_folder_paths(conn, root_id))

    root_folder_name = Path(root.root_path).name or root.display_name
    root_name_candidate = not positive_terms or _matches_any_term(root_folder_name, positive_terms)
    count_target_paths = set(candidate_paths)
    if positive_terms and root_name_candidate:
        count_target_paths.add(root.root_path)
    if not positive_terms:
        root_name_candidate = True

    folder_records = _load_folder_records(conn, root_id, candidate_paths)
    direct_file_counts: Dict[str, int] = {}
    if positive_terms and count_target_paths:
        direct_file_counts = _count_files_by_folder_paths(conn, root_id, count_target_paths)

    matched_rows: List[FolderRecord] = []
    seen_paths = set()

    root_file_info = file_hits.get(root.root_path)
    if root_name_candidate and _matches_parsed_query(root_folder_name, parsed_query):
        matched_rows.append(
            FolderRecord(
                root_id=root.id,
                root_name=root.display_name,
                name=root_folder_name,
                path=root.root_path,
                parent_path=str(Path(root.root_path).parent),
                depth=0,
                updated_at=root.last_scanned_at,
                match_kind="name+file" if root_file_info else "name",
                folder_name_matched=True,
                file_match_count=direct_file_counts.get(root.root_path, 0),
                matched_file_names=tuple(root_file_info["names"]) if root_file_info else (),
                matched_file_paths=tuple(root_file_info["paths"]) if root_file_info else (),
            )
        )
        seen_paths.add(root.root_path)

    for record in folder_records.values():
        if _matches_parsed_query(record.name, parsed_query):
            file_info = file_hits.get(record.path)
            matched_rows.append(
                FolderRecord(
                    root_id=record.root_id,
                    root_name=record.root_name,
                    name=record.name,
                    path=record.path,
                    parent_path=record.parent_path,
                    depth=record.depth,
                    updated_at=record.updated_at,
                    match_kind="name+file" if file_info else "name",
                    folder_name_matched=True,
                    file_match_count=direct_file_counts.get(record.path, 0),
                    matched_file_names=tuple(file_info["names"]) if file_info else (),
                    matched_file_paths=tuple(file_info["paths"]) if file_info else (),
                )
            )
            seen_paths.add(record.path)
    for folder_path, file_info in file_hits.items():
        if folder_path in seen_paths:
            continue
        record = folder_records.get(folder_path)
        if record is None and folder_path == root.root_path:
            record = FolderRecord(
                root_id=root.id,
                root_name=root.display_name,
                name=root_folder_name,
                path=root.root_path,
                parent_path=str(Path(root.root_path).parent),
                depth=0,
                updated_at=root.last_scanned_at,
                match_kind="file",
                folder_name_matched=False,
            )
        if record is None:
            continue
        matched_rows.append(
            FolderRecord(
                root_id=record.root_id,
                root_name=record.root_name,
                name=record.name,
                path=record.path,
                parent_path=record.parent_path,
                depth=record.depth,
                updated_at=record.updated_at,
                match_kind="file",
                folder_name_matched=False,
                file_match_count=int(file_info["count"]),
                matched_file_names=tuple(file_info["names"]),
                matched_file_paths=tuple(file_info["paths"]),
            )
        )
    matched_rows.sort(key=lambda record: (record.depth, record.name.casefold(), record.path.casefold()))
    return matched_rows[:limit]


def _extract_positive_terms(query: ParsedFolderQuery) -> List[str]:
    terms: List[str] = []
    seen = set()
    for group in query.positive_groups:
        for term in group:
            folded = term.casefold()
            if folded in seen:
                continue
            seen.add(folded)
            terms.append(term)
    return terms


def _find_candidate_folder_paths_by_name(conn: sqlite3.Connection, root_id: int, terms: List[str]) -> set[str]:
    paths: set[str] = set()
    for term_group in _chunked(terms, 200):
        where_sql, params = _build_like_filter("name", term_group)
        rows = conn.execute(
            f"""
            SELECT path
            FROM folders
            WHERE root_id = ?
              AND ({where_sql})
            """,
            (root_id, *params),
        ).fetchall()
        paths.update(str(row[0]) for row in rows)
    return paths


def _find_candidate_file_rows(conn: sqlite3.Connection, root_id: int, terms: List[str]) -> List[tuple[str, str, str]]:
    rows: List[tuple[str, str, str]] = []
    seen_file_paths: set[str] = set()
    for term_group in _chunked(terms, 200):
        where_sql, params = _build_like_filter("file_name", term_group)
        chunk_rows = conn.execute(
            f"""
            SELECT folder_path, file_path, file_name
            FROM files
            WHERE root_id = ?
              AND ({where_sql})
            ORDER BY file_name COLLATE NOCASE, file_path COLLATE NOCASE
            """,
            (root_id, *params),
        ).fetchall()
        for folder_path, file_path, file_name in chunk_rows:
            file_key = str(file_path)
            if file_key in seen_file_paths:
                continue
            seen_file_paths.add(file_key)
            rows.append((str(folder_path), file_key, str(file_name)))
    rows.sort(key=lambda row: (row[2].casefold(), row[1].casefold()))
    return rows


def _list_all_folder_paths(conn: sqlite3.Connection, root_id: int) -> set[str]:
    rows = conn.execute(
        """
        SELECT path
        FROM folders
        WHERE root_id = ?
        """,
        (root_id,),
    ).fetchall()
    return {str(row[0]) for row in rows}


def _load_folder_records(conn: sqlite3.Connection, root_id: int, folder_paths: Iterable[str]) -> Dict[str, FolderRecord]:
    records: Dict[str, FolderRecord] = {}
    paths = list(folder_paths)
    if not paths:
        return records
    for path_group in _chunked(paths, 400):
        placeholders = ", ".join("?" for _ in path_group)
        rows = conn.execute(
            f"""
            SELECT
                f.root_id,
                r.display_name,
                f.name,
                f.path,
                f.parent_path,
                f.depth,
                f.updated_at,
                'name' AS match_kind
            FROM folders f
            JOIN roots r ON r.id = f.root_id
            WHERE f.root_id = ?
              AND f.path IN ({placeholders})
            ORDER BY
                f.depth,
                f.name COLLATE NOCASE,
                f.path COLLATE NOCASE
            """,
            (root_id, *path_group),
        ).fetchall()
        for row in rows:
            record = _folder_from_row(row)
            records[record.path] = record
    return records


def _count_files_by_folder_paths(conn: sqlite3.Connection, root_id: int, folder_paths: Iterable[str]) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    paths = list(folder_paths)
    if not paths:
        return counts
    for path_group in _chunked(paths, 400):
        placeholders = ", ".join("?" for _ in path_group)
        rows = conn.execute(
            f"""
            SELECT folder_path, COUNT(*)
            FROM files
            WHERE root_id = ?
              AND folder_path IN ({placeholders})
            GROUP BY folder_path
            """,
            (root_id, *path_group),
        ).fetchall()
        for folder_path, count in rows:
            counts[str(folder_path)] = int(count)
    return counts


def _build_like_filter(column: str, terms: List[str]) -> Tuple[str, List[str]]:
    return " OR ".join(f"{column} LIKE ?" for _ in terms), [f"%{term}%" for term in terms]


def _chunked(items: Iterable[str], size: int) -> Iterable[List[str]]:
    chunk: List[str] = []
    for item in items:
        chunk.append(item)
        if len(chunk) >= size:
            yield chunk
            chunk = []
    if chunk:
        yield chunk


def _matches_any_term(text: str, terms: List[str]) -> bool:
    name = text.casefold()
    return any(term.casefold() in name for term in terms)


def parse_folder_query(query: str) -> ParsedFolderQuery:
    query = (query or "").strip()
    if not query:
        return ParsedFolderQuery([], [])
    try:
        tokens = shlex.split(query)
    except ValueError:
        tokens = query.split()

    groups: List[List[str]] = [[]]
    excluded_terms: List[str] = []
    for token in tokens:
        token = token.strip()
        if not token:
            continue
        if token.upper() == "OR":
            if groups[-1]:
                groups.append([])
            continue
        if token.startswith("-") and len(token) > 1:
            excluded_terms.append(token[1:])
            continue
        groups[-1].append(token)

    positive_groups = [group for group in groups if group]
    return ParsedFolderQuery(positive_groups, excluded_terms)


def _matches_parsed_query(text: str, query: ParsedFolderQuery) -> bool:
    name = text.casefold()
    if any(term.casefold() in name for term in query.excluded_terms):
        return False
    if not query.positive_groups:
        return bool(query.excluded_terms)
    return any(all(term.casefold() in name for term in group) for group in query.positive_groups)


def _scan_rows(root_path: Path, updated_at: str) -> Tuple[List[tuple[str, str, str, int, str]], List[tuple[str, str, str, str]]]:
    folder_rows = []
    file_rows = []
    root_parts = len(root_path.parts)
    for current, dirnames, filenames in os.walk(root_path, topdown=True, onerror=lambda _error: None):
        dirnames[:] = sorted(name for name in dirnames if not name.startswith("."))
        filenames = sorted(name for name in filenames if not name.startswith("."))
        current_path = Path(current)
        try:
            resolved = current_path.resolve()
        except OSError:
            continue
        if resolved != root_path:
            depth = max(0, len(resolved.parts) - root_parts)
            folder_rows.append((resolved.name, str(resolved), str(resolved.parent), depth, updated_at))
        for filename in filenames:
            try:
                file_path = (resolved / filename).resolve()
            except OSError:
                continue
            file_rows.append((str(resolved), str(file_path), filename, updated_at))
    return folder_rows, file_rows


def _root_from_row(row) -> RootRecord:
    return RootRecord(
        id=int(row[0]),
        display_name=row[1],
        root_path=row[2],
        created_at=row[3],
        last_scanned_at=row[4],
        folder_count=int(row[5]),
    )


def _folder_from_row(row) -> FolderRecord:
    return FolderRecord(
        root_id=int(row[0]),
        root_name=row[1],
        name=row[2],
        path=row[3],
        parent_path=row[4],
        depth=int(row[5]),
        updated_at=row[6],
        match_kind=row[7],
    )

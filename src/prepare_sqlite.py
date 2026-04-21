"""Create an empty SQLite database for the folder search app."""

from __future__ import annotations

import argparse
from pathlib import Path

DEFAULT_DB_PATH = Path(__file__).resolve().parent.parent / "data" / "file_index.db"

if __package__ in (None, ""):
    import sys

    sys.path.append(str(Path(__file__).resolve().parent.parent))
    from src.file_database import connect_db, init_db
else:
    from .file_database import connect_db, init_db


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="フォルダ検索用SQLite DBを初期化する")
    parser.add_argument("--db", default=str(DEFAULT_DB_PATH), help="出力先SQLiteパス")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    db_path = Path(args.db)
    db_path.parent.mkdir(parents=True, exist_ok=True)

    conn = connect_db(db_path)
    try:
        init_db(conn)
        conn.commit()
    finally:
        conn.close()

    print(f"[INFO] initialized: {db_path}")


if __name__ == "__main__":
    main()

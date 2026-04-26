"""Regression tests for the folder search database and local Web UI."""

from __future__ import annotations

import pathlib
import io
import json
import sqlite3
import tempfile
import threading
import unittest
from unittest import mock
from urllib.parse import urlencode, urlparse

ROOT = pathlib.Path(__file__).resolve().parents[1]
import sys

sys.path.append(str(ROOT / "src"))

from file_database import add_root, connect_db, delete_root, ensure_db, get_root, init_db, list_roots, parse_folder_query, scan_root, search_folders, update_root_display_name  # type: ignore
from web_app import CLIENT_SCRIPT, FileSearchHandler, FileSearchServer, SEARCH_PAGE_TEMPLATE, SETTINGS_PAGE_TEMPLATE, build_server_url, choose_folder_path, find_listening_pids, main, open_browser, open_path_in_file_manager, stop_existing_server  # type: ignore


class FolderDatabaseTests(unittest.TestCase):
    def test_init_db_creates_roots_and_folders_tables(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = pathlib.Path(tmp) / "index.db"
            conn = connect_db(db_path)
            try:
                init_db(conn)
                table_names = {
                    row[0]
                    for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
                }
            finally:
                conn.close()

        self.assertIn("roots", table_names)
        self.assertIn("folders", table_names)

    def test_add_root_uses_default_display_name_and_normalized_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root_dir = pathlib.Path(tmp) / "ProjectA"
            root_dir.mkdir()
            conn = sqlite3.connect(":memory:")
            try:
                root = add_root(conn, "", root_dir)
                conn.commit()
                self.assertEqual(root.display_name, "ProjectA")
                self.assertEqual(root.root_path, str(root_dir.resolve()))
            finally:
                conn.close()

    def test_scan_root_indexes_nested_folders_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            root_dir = pathlib.Path(tmp) / "Root"
            (root_dir / "Client" / "Drawings").mkdir(parents=True)
            (root_dir / "Client" / "note.txt").write_text("not indexed", encoding="utf-8")
            (root_dir / ".hidden" / "Secret").mkdir(parents=True)

            conn = sqlite3.connect(":memory:")
            try:
                root = add_root(conn, "案件", root_dir)
                count = scan_root(conn, root.id)
                conn.commit()
                names = [row[0] for row in conn.execute("SELECT name FROM folders ORDER BY name").fetchall()]
            finally:
                conn.close()

        self.assertEqual(count, 2)
        self.assertEqual(names, ["Client", "Drawings"])

    def test_search_folders_is_scoped_by_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            root_a = pathlib.Path(tmp) / "A"
            root_b = pathlib.Path(tmp) / "B"
            (root_a / "SharedProject").mkdir(parents=True)
            (root_b / "SharedProject").mkdir(parents=True)

            conn = sqlite3.connect(":memory:")
            try:
                registered_a = add_root(conn, "A", root_a)
                registered_b = add_root(conn, "B", root_b)
                scan_root(conn, registered_a.id)
                scan_root(conn, registered_b.id)
                conn.commit()

                rows_a = search_folders(conn, registered_a.id, "Shared")
                rows_b = search_folders(conn, registered_b.id, "Shared")
            finally:
                conn.close()

        self.assertEqual([row.root_name for row in rows_a], ["A"])
        self.assertEqual([row.root_name for row in rows_b], ["B"])

    def test_search_folders_matches_folder_name_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            root_dir = pathlib.Path(tmp) / "Root"
            (root_dir / "ParentTarget" / "Other").mkdir(parents=True)
            (root_dir / "Target").mkdir(parents=True)

            conn = sqlite3.connect(":memory:")
            try:
                root = add_root(conn, "Root", root_dir)
                scan_root(conn, root.id)
                conn.commit()
                rows = search_folders(conn, root.id, "Target")
                parent_only_rows = search_folders(conn, root.id, "Parent")
            finally:
                conn.close()

        self.assertEqual({row.name for row in rows}, {"Target", "ParentTarget"})
        self.assertEqual(parent_only_rows[0].name, "ParentTarget")
        self.assertNotIn("Other", [row.name for row in rows + parent_only_rows])

    def test_search_folders_prefers_folder_name_match_and_counts_direct_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root_dir = pathlib.Path(tmp) / "Root"
            matched_dir = root_dir / "商品_cat"
            file_only_dir = root_dir / "Other"
            matched_dir.mkdir(parents=True)
            file_only_dir.mkdir(parents=True)
            for name in [
                "main.png",
                "front.png",
                "side.png",
                "back.png",
                "Cat_Papercraft_Template.pdf",
                "sample2.png",
                "sample1.png",
            ]:
                (matched_dir / name).write_text("x", encoding="utf-8")
            (file_only_dir / "cat_notes.txt").write_text("x", encoding="utf-8")

            conn = sqlite3.connect(":memory:")
            try:
                root = add_root(conn, "Root", root_dir)
                scan_root(conn, root.id)
                conn.commit()
                rows = search_folders(conn, root.id, "cat")
            finally:
                conn.close()

        rows_by_name = {row.name: row for row in rows}
        self.assertTrue(rows_by_name["商品_cat"].folder_name_matched)
        self.assertEqual(rows_by_name["商品_cat"].file_match_count, 7)
        self.assertEqual(rows_by_name["商品_cat"].matched_file_names, ("Cat_Papercraft_Template.pdf",))
        self.assertFalse(rows_by_name["Other"].folder_name_matched)
        self.assertEqual(rows_by_name["Other"].file_match_count, 1)

    def test_search_folders_returns_parent_folder_for_file_name_hit_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            root_dir = pathlib.Path(tmp) / "Root"
            parent_dir = root_dir / "Reference"
            other_dir = root_dir / "Other"
            parent_dir.mkdir(parents=True)
            other_dir.mkdir(parents=True)
            (parent_dir / "alpha_manual.pdf").write_text("x", encoding="utf-8")
            (other_dir / "notes.txt").write_text("x", encoding="utf-8")

            conn = sqlite3.connect(":memory:")
            try:
                root = add_root(conn, "Root", root_dir)
                scan_root(conn, root.id)
                conn.commit()
                rows = search_folders(conn, root.id, "manual")
            finally:
                conn.close()

        self.assertEqual([row.name for row in rows], ["Reference"])
        self.assertFalse(rows[0].folder_name_matched)
        self.assertEqual(rows[0].matched_file_names, ("alpha_manual.pdf",))
        self.assertEqual(rows[0].matched_file_paths, (str((parent_dir / "alpha_manual.pdf").resolve()),))

    def test_search_folders_keeps_folder_and_file_name_hits_together(self):
        with tempfile.TemporaryDirectory() as tmp:
            root_dir = pathlib.Path(tmp) / "Root"
            both_dir = root_dir / "alpha_assets"
            file_only_dir = root_dir / "Misc"
            both_dir.mkdir(parents=True)
            file_only_dir.mkdir(parents=True)
            (both_dir / "alpha_brief.txt").write_text("x", encoding="utf-8")
            (both_dir / "other.txt").write_text("x", encoding="utf-8")
            (file_only_dir / "alpha_sheet.txt").write_text("x", encoding="utf-8")

            conn = sqlite3.connect(":memory:")
            try:
                root = add_root(conn, "Root", root_dir)
                scan_root(conn, root.id)
                conn.commit()
                rows = search_folders(conn, root.id, "alpha")
            finally:
                conn.close()

        rows_by_name = {row.name: row for row in rows}
        self.assertEqual(set(rows_by_name), {"alpha_assets", "Misc"})
        self.assertTrue(rows_by_name["alpha_assets"].folder_name_matched)
        self.assertEqual(rows_by_name["alpha_assets"].file_match_count, 2)
        self.assertEqual(rows_by_name["alpha_assets"].matched_file_names, ("alpha_brief.txt",))
        self.assertFalse(rows_by_name["Misc"].folder_name_matched)
        self.assertEqual(rows_by_name["Misc"].matched_file_names, ("alpha_sheet.txt",))

    def test_search_folders_supports_and_search_for_file_name_hits(self):
        with tempfile.TemporaryDirectory() as tmp:
            root_dir = pathlib.Path(tmp) / "Root"
            matched_dir = root_dir / "Specs"
            split_dir = root_dir / "Split"
            matched_dir.mkdir(parents=True)
            split_dir.mkdir(parents=True)
            (matched_dir / "alpha beta guide.txt").write_text("x", encoding="utf-8")
            (split_dir / "alpha_only.txt").write_text("x", encoding="utf-8")
            (split_dir / "beta_only.txt").write_text("x", encoding="utf-8")

            conn = sqlite3.connect(":memory:")
            try:
                root = add_root(conn, "Root", root_dir)
                scan_root(conn, root.id)
                conn.commit()
                rows = search_folders(conn, root.id, "alpha beta")
            finally:
                conn.close()

        self.assertEqual([row.name for row in rows], ["Specs"])
        self.assertEqual(rows[0].matched_file_names, ("alpha beta guide.txt",))

    def test_search_folders_supports_minus_filter_for_file_name_hits(self):
        with tempfile.TemporaryDirectory() as tmp:
            root_dir = pathlib.Path(tmp) / "Root"
            keep_dir = root_dir / "Keep"
            drop_dir = root_dir / "Drop"
            keep_dir.mkdir(parents=True)
            drop_dir.mkdir(parents=True)
            (keep_dir / "cat_notes.txt").write_text("x", encoding="utf-8")
            (drop_dir / "cat_draft.txt").write_text("x", encoding="utf-8")

            conn = sqlite3.connect(":memory:")
            try:
                root = add_root(conn, "Root", root_dir)
                scan_root(conn, root.id)
                conn.commit()
                rows = search_folders(conn, root.id, "cat -draft")
            finally:
                conn.close()

        self.assertEqual([row.name for row in rows], ["Keep"])
        self.assertEqual(rows[0].matched_file_names, ("cat_notes.txt",))

    def test_search_folders_supports_phrase_search_for_file_name_hits(self):
        with tempfile.TemporaryDirectory() as tmp:
            root_dir = pathlib.Path(tmp) / "Root"
            matched_dir = root_dir / "Phrase"
            split_dir = root_dir / "Split"
            matched_dir.mkdir(parents=True)
            split_dir.mkdir(parents=True)
            (matched_dir / "gamma delta plan.txt").write_text("x", encoding="utf-8")
            (split_dir / "gamma.txt").write_text("x", encoding="utf-8")
            (split_dir / "delta.txt").write_text("x", encoding="utf-8")

            conn = sqlite3.connect(":memory:")
            try:
                root = add_root(conn, "Root", root_dir)
                scan_root(conn, root.id)
                conn.commit()
                rows = search_folders(conn, root.id, '"gamma delta"')
            finally:
                conn.close()

        self.assertEqual([row.name for row in rows], ["Phrase"])
        self.assertEqual(rows[0].matched_file_names, ("gamma delta plan.txt",))

    def test_parse_folder_query_supports_google_like_operators(self):
        parsed = parse_folder_query('alpha beta OR "gamma delta" -draft')
        self.assertEqual(parsed.positive_groups, [["alpha", "beta"], ["gamma delta"]])
        self.assertEqual(parsed.excluded_terms, ["draft"])

    def test_search_folders_uses_and_or_minus_and_phrase(self):
        with tempfile.TemporaryDirectory() as tmp:
            root_dir = pathlib.Path(tmp) / "Root"
            for name in [
                "alpha beta",
                "alpha draft beta",
                "alpha only",
                "gamma delta",
                "gamma draft delta",
                "other",
            ]:
                (root_dir / name).mkdir(parents=True)

            conn = sqlite3.connect(":memory:")
            try:
                root = add_root(conn, "Root", root_dir)
                scan_root(conn, root.id)
                conn.commit()
                and_rows = search_folders(conn, root.id, "alpha beta")
                or_rows = search_folders(conn, root.id, "alpha OR gamma")
                minus_rows = search_folders(conn, root.id, "alpha -draft")
                phrase_rows = search_folders(conn, root.id, '"gamma delta"')
            finally:
                conn.close()

        self.assertEqual({row.name for row in and_rows}, {"alpha beta", "alpha draft beta"})
        self.assertEqual(
            {row.name for row in or_rows},
            {"alpha beta", "alpha draft beta", "alpha only", "gamma delta", "gamma draft delta"},
        )
        self.assertEqual({row.name for row in minus_rows}, {"alpha beta", "alpha only"})
        self.assertEqual([row.name for row in phrase_rows], ["gamma delta"])

    def test_rescan_removes_stale_folders(self):
        with tempfile.TemporaryDirectory() as tmp:
            root_dir = pathlib.Path(tmp) / "Root"
            stale = root_dir / "Stale"
            current = root_dir / "Current"
            stale.mkdir(parents=True)
            current.mkdir()

            conn = sqlite3.connect(":memory:")
            try:
                root = add_root(conn, "Root", root_dir)
                self.assertEqual(scan_root(conn, root.id), 2)
                stale.rmdir()
                self.assertEqual(scan_root(conn, root.id), 1)
                conn.commit()
                rows = search_folders(conn, root.id, "")
                folder_names = [row[0] for row in conn.execute("SELECT name FROM folders").fetchall()]
                refreshed_root = get_root(conn, root.id)
            finally:
                conn.close()

        self.assertEqual(rows, [])
        self.assertEqual(folder_names, ["Current"])
        self.assertIsNotNone(refreshed_root)
        self.assertEqual(refreshed_root.folder_count, 1)

    def test_delete_root_cascades_folders(self):
        with tempfile.TemporaryDirectory() as tmp:
            root_dir = pathlib.Path(tmp) / "Root"
            (root_dir / "Folder").mkdir(parents=True)

            conn = sqlite3.connect(":memory:")
            try:
                root = add_root(conn, "Root", root_dir)
                scan_root(conn, root.id)
                delete_root(conn, root.id)
                conn.commit()
                self.assertEqual(list_roots(conn), [])
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM folders").fetchone()[0], 0)
            finally:
                conn.close()

    def test_update_root_display_name_updates_only_name(self):
        with tempfile.TemporaryDirectory() as tmp:
            root_dir = pathlib.Path(tmp) / "Root"
            root_dir.mkdir()

            conn = sqlite3.connect(":memory:")
            try:
                root = add_root(conn, "Old Name", root_dir)
                updated = update_root_display_name(conn, root.id, "New Name")
                conn.commit()
                refreshed = get_root(conn, root.id)
            finally:
                conn.close()

        self.assertEqual(updated.display_name, "New Name")
        self.assertIsNotNone(refreshed)
        self.assertEqual(refreshed.display_name, "New Name")
        self.assertEqual(refreshed.root_path, str(root_dir.resolve()))

    def test_update_root_display_name_rejects_blank_name(self):
        with tempfile.TemporaryDirectory() as tmp:
            root_dir = pathlib.Path(tmp) / "Root"
            root_dir.mkdir()

            conn = sqlite3.connect(":memory:")
            try:
                root = add_root(conn, "Keep Name", root_dir)
                with self.assertRaisesRegex(ValueError, "Display Name is required"):
                    update_root_display_name(conn, root.id, "   ")
                refreshed = get_root(conn, root.id)
            finally:
                conn.close()

        self.assertIsNotNone(refreshed)
        self.assertEqual(refreshed.display_name, "Keep Name")


class WebUiTests(unittest.TestCase):
    def test_templates_render_without_css_format_escaping(self):
        search_html = SEARCH_PAGE_TEMPLATE.safe_substitute(
            theme_script="",
            base_css="body { color: red; }",
            client_script="",
            root_options="<option>Root</option>",
            query="Project",
            meta_html="<div class='meta'>0件ヒット</div>",
            results="<div></div>",
        )
        settings_html = SETTINGS_PAGE_TEMPLATE.safe_substitute(
            theme_script="",
            base_css="body { color: red; }",
            client_script="",
            notice="",
            roots_table="<div></div>",
        )

        self.assertIn("Folder Search", search_html)
        self.assertIn('placeholder="Enter keyword"', search_html)
        self.assertIn('<label for="root_id">Search Target</label>', search_html)
        self.assertIn("Folder Manager", settings_html)
        self.assertIn("Choose Folder", settings_html)
        self.assertNotIn('id="display_name"', settings_html)
        self.assertNotIn("Example: Company Server", settings_html)
        self.assertNotIn("root_path", settings_html)

    def test_client_script_restores_query_focus_after_live_search_reload(self):
        self.assertIn("restoreQueryFocus", CLIENT_SCRIPT)
        self.assertIn("queryInput.focus({ preventScroll: true })", CLIENT_SCRIPT)
        self.assertIn("setSelectionRange(cursorPosition, cursorPosition)", CLIENT_SCRIPT)
        restore_block = CLIENT_SCRIPT.split("const restoreQueryFocus = function () {", 1)[1].split("};", 1)[0]
        self.assertNotIn("!queryInput.value", restore_block)
        self.assertIn('fetch("/children?" + query.toString()', CLIENT_SCRIPT)
        self.assertIn('fetch("/preview?" + query.toString()', CLIENT_SCRIPT)
        self.assertIn("data-expand-toggle", CLIENT_SCRIPT)
        self.assertIn("data-open-folder-path", CLIENT_SCRIPT)
        self.assertIn("buildFileUrl", CLIENT_SCRIPT)
        self.assertIn("pdf-preview-frame", CLIENT_SCRIPT)
        self.assertIn('"/file?" + query.toString()', CLIENT_SCRIPT)
        self.assertIn('panel.classList.add("preview-inactive")', CLIENT_SCRIPT)
        self.assertIn('panel.classList.add("preview-active")', CLIENT_SCRIPT)

    def test_parse_search_inputs(self):
        root_id, query = FileSearchHandler._parse_search_inputs("root_id=12&q=Project")
        self.assertEqual(root_id, 12)
        self.assertEqual(query, "Project")

        root_id_invalid, query_invalid = FileSearchHandler._parse_search_inputs("root_id=abc&q=Project")
        self.assertIsNone(root_id_invalid)
        self.assertEqual(query_invalid, "Project")

    def test_render_results_contains_expand_toggle_and_highlight(self):
        class Row:
            root_id = 1
            root_name = "Root"
            name = "ProjectDocs"
            path = "/tmp/ProjectDocs"
            parent_path = "/tmp"
            depth = 1
            updated_at = ""
            match_kind = "name"
            folder_name_matched = True

        html_doc = FileSearchHandler.render_results([Row()], "Project")
        self.assertIn("<mark>Project</mark>Docs", html_doc)
        self.assertNotIn("/tmp/<mark>Project</mark>Docs", html_doc)
        self.assertIn("data-row-path='/tmp/ProjectDocs'", html_doc)
        self.assertIn("data-expand-toggle='1'", html_doc)
        self.assertIn("data-expand-path='/tmp/ProjectDocs'", html_doc)
        self.assertIn("data-folder-name-matched='1'", html_doc)
        self.assertIn("data-open-folder-path='/tmp/ProjectDocs'", html_doc)
        self.assertIn("class='result-detail-row'", html_doc)
        self.assertIn("data-child-panel='1'", html_doc)
        self.assertIn("class='preview-panel preview-inactive' data-preview-panel='1'", html_doc)
        self.assertIn("colspan='1'", html_doc)
        self.assertNotIn("<thead>", html_doc)
        self.assertNotIn("<th>親フォルダ</th><th>フォルダ</th>", html_doc)
        self.assertNotIn("<th>パス</th>", html_doc)
        self.assertNotIn("<th>操作</th>", html_doc)
        self.assertNotIn("<td><div class='path'>", html_doc)

    def test_highlight_text_uses_positive_search_terms_only(self):
        highlighted = FileSearchHandler._highlight_text("alpha beta draft", "alpha OR beta -draft")
        self.assertIn("<mark>alpha</mark>", highlighted)
        self.assertIn("<mark>beta</mark>", highlighted)
        self.assertNotIn("<mark>draft</mark>", highlighted)

    def test_render_results_empty(self):
        html_doc = FileSearchHandler.render_results([], "missing")
        self.assertIn("No matching folders were found.", html_doc)

    def test_render_roots_table_contains_actions(self):
        class Root:
            id = 3
            display_name = "Server"
            root_path = "/tmp/server"
            created_at = ""
            last_scanned_at = "2026-04-21T00:00:00+00:00"
            folder_count = 5

        html_doc = FileSearchHandler.render_roots_table([Root()])
        self.assertIn("Server", html_doc)
        self.assertIn("name='display_name'", html_doc)
        self.assertIn("rename_root", html_doc)
        self.assertIn("Save", html_doc)
        self.assertIn("Reload", html_doc)
        self.assertIn("Delete", html_doc)

    def test_handle_settings_action_rename_root_updates_display_name(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp)
            root_dir = base / "Root"
            root_dir.mkdir()
            db_path = base / "index.db"

            conn = connect_db(db_path)
            try:
                ensure_db(conn)
                root = add_root(conn, "Before", root_dir)
                conn.commit()
            finally:
                conn.close()

            handler = object.__new__(FileSearchHandler)
            handler.db_path = str(db_path)
            captured = {}
            handler.send_response = lambda status: captured.setdefault("status", status)
            handler.send_header = lambda key, value: captured.setdefault(key, value)
            handler.end_headers = lambda: captured.setdefault("ended", True)
            handler._read_post_params = lambda: {
                "action": ["rename_root"],
                "root_id": [str(root.id)],
                "display_name": ["After"],
                "return_to": ["/?root_id=1"],
            }

            FileSearchHandler._handle_settings_action(handler)

            conn = connect_db(db_path)
            try:
                refreshed = get_root(conn, root.id)
            finally:
                conn.close()

        self.assertEqual(captured["status"], 303)
        self.assertIn("kind=info", captured["Location"])
        self.assertIn("message=Updated+After.", captured["Location"])
        self.assertIn("return_to=%2F%3Froot_id%3D1", captured["Location"])
        self.assertIsNotNone(refreshed)
        self.assertEqual(refreshed.display_name, "After")

    def test_handle_settings_action_rename_root_rejects_blank_name(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp)
            root_dir = base / "Root"
            root_dir.mkdir()
            db_path = base / "index.db"

            conn = connect_db(db_path)
            try:
                ensure_db(conn)
                root = add_root(conn, "Keep Name", root_dir)
                conn.commit()
            finally:
                conn.close()

            handler = object.__new__(FileSearchHandler)
            handler.db_path = str(db_path)
            captured = {}
            handler.send_response = lambda status: captured.setdefault("status", status)
            handler.send_header = lambda key, value: captured.setdefault("Location", value)
            handler.end_headers = lambda: captured.setdefault("ended", True)
            handler._read_post_params = lambda: {
                "action": ["rename_root"],
                "root_id": [str(root.id)],
                "display_name": ["   "],
            }

            FileSearchHandler._handle_settings_action(handler)

            conn = connect_db(db_path)
            try:
                refreshed = get_root(conn, root.id)
            finally:
                conn.close()

        self.assertEqual(captured["status"], 303)
        self.assertIn("kind=error", captured["Location"])
        self.assertIn("Display+Name+is+required", captured["Location"])
        self.assertIsNotNone(refreshed)
        self.assertEqual(refreshed.display_name, "Keep Name")

    def test_handle_search_page_renders_minimum_html(self):
        captured = {}
        handler = object.__new__(FileSearchHandler)
        handler._send_html = lambda body: captured.setdefault("html", body.decode("utf-8"))
        handler._load_roots = lambda requested_root_id, allow_unselected_default=False: ([], None)

        FileSearchHandler._handle_search_page(handler, urlparse("/"))

        self.assertNotIn("Settingsで検索対象フォルダを登録してください", captured["html"])
        self.assertNotIn("該当するフォルダが見つかりませんでした", captured["html"])
        self.assertIn("root_id", captured["html"])

    def test_handle_search_page_without_query_hides_keyword_prompt_and_empty_results(self):
        class Root:
            id = 1
            display_name = "Root"
            folder_count = 0

        captured = {}
        handler = object.__new__(FileSearchHandler)
        handler._send_html = lambda body: captured.setdefault("html", body.decode("utf-8"))
        handler._load_roots = lambda requested_root_id, allow_unselected_default=False: ([Root()], 1)

        FileSearchHandler._handle_search_page(handler, urlparse("/?root_id=1"))

        self.assertIn('placeholder="Enter keyword"', captured["html"])
        self.assertNotIn("<strong>Enter a keyword</strong>", captured["html"])
        self.assertNotIn("No matching folders were found.", captured["html"])

    def test_build_server_url(self):
        self.assertEqual(build_server_url("127.0.0.1", 8765), "http://127.0.0.1:8765")

    def test_open_browser_swallows_errors(self):
        with mock.patch("web_app.webbrowser.open", side_effect=RuntimeError("boom")):
            open_browser("http://127.0.0.1:8765", delay_seconds=0)

    def test_handle_open_path_keeps_search_page_when_return_to_is_present(self):
        captured = {}
        handler = object.__new__(FileSearchHandler)
        handler.send_response = lambda status: captured.setdefault("status", status)
        handler.send_header = lambda key, value: captured.setdefault(key, value)
        handler.end_headers = lambda: captured.setdefault("ended", True)
        with tempfile.TemporaryDirectory() as tmp:
            folder = pathlib.Path(tmp)
            parsed = urlparse(f"/open?path={folder}&return_to=/%3Froot_id%3D1%26q%3DProject")
            with mock.patch("web_app.subprocess.Popen"):
                FileSearchHandler._handle_open_path(handler, parsed)

        self.assertEqual(captured["status"], 303)
        self.assertEqual(captured["Location"], "/?root_id=1&q=Project")

    def test_handle_open_path_returns_no_content_for_fetch_open(self):
        captured = {}
        handler = object.__new__(FileSearchHandler)
        handler.send_response = lambda status: captured.setdefault("status", status)
        handler.end_headers = lambda: captured.setdefault("ended", True)
        with tempfile.TemporaryDirectory() as tmp:
            parsed = urlparse(f"/open?path={pathlib.Path(tmp)}")
            with mock.patch("web_app.subprocess.Popen"):
                FileSearchHandler._handle_open_path(handler, parsed)

        self.assertEqual(captured["status"], 204)

    def test_collect_children_items_sorts_and_skips_hidden(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp)
            (base / ".hidden_dir").mkdir()
            (base / ".hidden_file.txt").write_text("x", encoding="utf-8")
            (base / "z_dir").mkdir()
            (base / "a_dir").mkdir()
            (base / "b.txt").write_text("x", encoding="utf-8")
            (base / "a.txt").write_text("x", encoding="utf-8")
            items = FileSearchHandler._collect_children_items(base)

        self.assertEqual(
            [(item["type"], item["name"]) for item in items],
            [("dir", "a_dir"), ("dir", "z_dir"), ("file", "a.txt"), ("file", "b.txt")],
        )

    def test_collect_children_items_keeps_all_direct_files_for_folder_name_match(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp)
            (base / "child_dir").mkdir()
            (base / "Cat_hit.pdf").write_text("x", encoding="utf-8")
            (base / "main.png").write_text("x", encoding="utf-8")
            items = FileSearchHandler._collect_children_items(base, "cat", folder_name_matched=True)

        self.assertEqual(
            [(item["type"], item["name"], item["is_match"]) for item in items],
            [("file", "Cat_hit.pdf", True), ("file", "main.png", False)],
        )

    def test_handle_children_returns_direct_items(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp)
            root_dir = base / "Root"
            target_dir = root_dir / "Parent"
            target_dir.mkdir(parents=True)
            (target_dir / "Sub").mkdir()
            (target_dir / "file.txt").write_text("x", encoding="utf-8")

            db_path = base / "index.db"
            conn = connect_db(db_path)
            try:
                ensure_db(conn)
                root = add_root(conn, "Root", root_dir)
                conn.commit()
            finally:
                conn.close()

            handler = object.__new__(FileSearchHandler)
            handler.db_path = str(db_path)
            captured = {}
            handler.send_response = lambda status: captured.setdefault("status", status)
            handler.send_header = lambda key, value: captured.setdefault(key, value)
            handler.end_headers = lambda: captured.setdefault("ended", True)
            handler.wfile = io.BytesIO()

            query = urlencode({"root_id": root.id, "path": str(target_dir)})
            FileSearchHandler._handle_children(handler, urlparse(f"/children?{query}"))
            body = json.loads(handler.wfile.getvalue().decode("utf-8"))

        self.assertEqual(captured["status"], 200)
        self.assertEqual(body["error"], None)
        self.assertEqual([item["type"] for item in body["items"]], ["dir", "file"])
        self.assertEqual({item["name"] for item in body["items"]}, {"Sub", "file.txt"})

    def test_handle_children_returns_all_direct_files_for_folder_name_match(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp)
            root_dir = base / "Root"
            target_dir = root_dir / "商品_cat"
            target_dir.mkdir(parents=True)
            (target_dir / "Cat_hit.pdf").write_text("x", encoding="utf-8")
            (target_dir / "main.png").write_text("x", encoding="utf-8")
            (target_dir / "old_svg").mkdir()

            db_path = base / "index.db"
            conn = connect_db(db_path)
            try:
                ensure_db(conn)
                root = add_root(conn, "Root", root_dir)
                conn.commit()
            finally:
                conn.close()

            handler = object.__new__(FileSearchHandler)
            handler.db_path = str(db_path)
            captured = {}
            handler.send_response = lambda status: captured.setdefault("status", status)
            handler.send_header = lambda key, value: captured.setdefault(key, value)
            handler.end_headers = lambda: captured.setdefault("ended", True)
            handler.wfile = io.BytesIO()

            query = urlencode({"root_id": root.id, "path": str(target_dir), "q": "cat", "folder_name_matched": "1"})
            FileSearchHandler._handle_children(handler, urlparse(f"/children?{query}"))
            body = json.loads(handler.wfile.getvalue().decode("utf-8"))

        self.assertEqual(captured["status"], 200)
        self.assertEqual(
            [(item["type"], item["name"], item["is_match"]) for item in body["items"]],
            [("file", "Cat_hit.pdf", True), ("file", "main.png", False)],
        )

    def test_handle_children_rejects_outside_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp)
            root_dir = base / "Root"
            outside_dir = base / "Outside"
            root_dir.mkdir()
            outside_dir.mkdir()

            db_path = base / "index.db"
            conn = connect_db(db_path)
            try:
                ensure_db(conn)
                root = add_root(conn, "Root", root_dir)
                conn.commit()
            finally:
                conn.close()

            handler = object.__new__(FileSearchHandler)
            handler.db_path = str(db_path)
            captured = {}
            handler.send_response = lambda status: captured.setdefault("status", status)
            handler.send_header = lambda key, value: captured.setdefault(key, value)
            handler.end_headers = lambda: captured.setdefault("ended", True)
            handler.wfile = io.BytesIO()

            query = urlencode({"root_id": root.id, "path": str(outside_dir)})
            FileSearchHandler._handle_children(handler, urlparse(f"/children?{query}"))
            body = json.loads(handler.wfile.getvalue().decode("utf-8"))

        self.assertEqual(captured["status"], 403)
        self.assertIn("outside root", body["error"])

    def test_handle_children_returns_errors_for_missing_or_non_directory_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp)
            root_dir = base / "Root"
            root_dir.mkdir()
            file_path = root_dir / "note.txt"
            file_path.write_text("x", encoding="utf-8")

            db_path = base / "index.db"
            conn = connect_db(db_path)
            try:
                ensure_db(conn)
                root = add_root(conn, "Root", root_dir)
                conn.commit()
            finally:
                conn.close()

            missing_path_handler = object.__new__(FileSearchHandler)
            missing_path_handler.db_path = str(db_path)
            missing_captured = {}
            missing_path_handler.send_response = lambda status: missing_captured.setdefault("status", status)
            missing_path_handler.send_header = lambda key, value: missing_captured.setdefault(key, value)
            missing_path_handler.end_headers = lambda: missing_captured.setdefault("ended", True)
            missing_path_handler.wfile = io.BytesIO()
            query_without_path = urlencode({"root_id": root.id})
            FileSearchHandler._handle_children(missing_path_handler, urlparse(f"/children?{query_without_path}"))
            missing_body = json.loads(missing_path_handler.wfile.getvalue().decode("utf-8"))

            file_path_handler = object.__new__(FileSearchHandler)
            file_path_handler.db_path = str(db_path)
            file_captured = {}
            file_path_handler.send_response = lambda status: file_captured.setdefault("status", status)
            file_path_handler.send_header = lambda key, value: file_captured.setdefault(key, value)
            file_path_handler.end_headers = lambda: file_captured.setdefault("ended", True)
            file_path_handler.wfile = io.BytesIO()
            query_with_file = urlencode({"root_id": root.id, "path": str(file_path)})
            FileSearchHandler._handle_children(file_path_handler, urlparse(f"/children?{query_with_file}"))
            file_body = json.loads(file_path_handler.wfile.getvalue().decode("utf-8"))

            missing_target_handler = object.__new__(FileSearchHandler)
            missing_target_handler.db_path = str(db_path)
            missing_target_captured = {}
            missing_target_handler.send_response = lambda status: missing_target_captured.setdefault("status", status)
            missing_target_handler.send_header = lambda key, value: missing_target_captured.setdefault(key, value)
            missing_target_handler.end_headers = lambda: missing_target_captured.setdefault("ended", True)
            missing_target_handler.wfile = io.BytesIO()
            query_with_missing_target = urlencode({"root_id": root.id, "path": str(root_dir / "missing")})
            FileSearchHandler._handle_children(missing_target_handler, urlparse(f"/children?{query_with_missing_target}"))
            missing_target_body = json.loads(missing_target_handler.wfile.getvalue().decode("utf-8"))

        self.assertEqual(missing_captured["status"], 400)
        self.assertIn("path is required", missing_body["error"])
        self.assertEqual(file_captured["status"], 400)
        self.assertIn("not a directory", file_body["error"])
        self.assertEqual(missing_target_captured["status"], 404)
        self.assertIn("Path not found", missing_target_body["error"])

    def test_handle_preview_returns_text_prefix(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp)
            root_dir = base / "Root"
            root_dir.mkdir()
            file_path = root_dir / "note.txt"
            file_path.write_text("hello preview", encoding="utf-8")

            db_path = base / "index.db"
            conn = connect_db(db_path)
            try:
                ensure_db(conn)
                root = add_root(conn, "Root", root_dir)
                conn.commit()
            finally:
                conn.close()

            handler = object.__new__(FileSearchHandler)
            handler.db_path = str(db_path)
            captured = {}
            handler.send_response = lambda status: captured.setdefault("status", status)
            handler.send_header = lambda key, value: captured.setdefault(key, value)
            handler.end_headers = lambda: captured.setdefault("ended", True)
            handler.wfile = io.BytesIO()

            query = urlencode({"root_id": root.id, "path": str(file_path)})
            FileSearchHandler._handle_preview(handler, urlparse(f"/preview?{query}"))
            body = json.loads(handler.wfile.getvalue().decode("utf-8"))

        self.assertEqual(captured["status"], 200)
        self.assertEqual(body["content"], "hello preview")
        self.assertFalse(body["truncated"])
        self.assertEqual(body["encoding"], "utf-8")
        self.assertEqual(body["error"], None)

    def test_handle_preview_truncates_large_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp)
            root_dir = base / "Root"
            root_dir.mkdir()
            file_path = root_dir / "large.txt"
            file_path.write_text("a" * (16 * 1024 + 10), encoding="utf-8")

            db_path = base / "index.db"
            conn = connect_db(db_path)
            try:
                ensure_db(conn)
                root = add_root(conn, "Root", root_dir)
                conn.commit()
            finally:
                conn.close()

            handler = object.__new__(FileSearchHandler)
            handler.db_path = str(db_path)
            captured = {}
            handler.send_response = lambda status: captured.setdefault("status", status)
            handler.send_header = lambda key, value: captured.setdefault(key, value)
            handler.end_headers = lambda: captured.setdefault("ended", True)
            handler.wfile = io.BytesIO()

            query = urlencode({"root_id": root.id, "path": str(file_path)})
            FileSearchHandler._handle_preview(handler, urlparse(f"/preview?{query}"))
            body = json.loads(handler.wfile.getvalue().decode("utf-8"))

        self.assertEqual(captured["status"], 200)
        self.assertEqual(len(body["content"]), 16 * 1024)
        self.assertTrue(body["truncated"])

    def test_read_preview_reports_binary_files_without_content(self):
        with tempfile.TemporaryDirectory() as tmp:
            file_path = pathlib.Path(tmp) / "sample.bin"
            file_path.write_bytes(b"\x00\x01binary")
            body = FileSearchHandler._read_preview(file_path)

        self.assertEqual(body["content"], "")
        self.assertEqual(body["encoding"], "binary")
        self.assertIn("Binary files", body["error"])

    def test_read_preview_reports_pdf_mime_for_pdf_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            file_path = pathlib.Path(tmp) / "sample.pdf"
            file_path.write_bytes(b"%PDF-1.4\n%%EOF\n")
            body = FileSearchHandler._read_preview(file_path)

        self.assertEqual(body["content"], "")
        self.assertEqual(body["mime"], "application/pdf")
        self.assertIn("PDF", body["error"])

    def test_handle_preview_rejects_missing_non_file_outside_and_not_found(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp)
            root_dir = base / "Root"
            outside_dir = base / "Outside"
            root_dir.mkdir()
            outside_dir.mkdir()
            outside_file = outside_dir / "outside.txt"
            outside_file.write_text("x", encoding="utf-8")

            db_path = base / "index.db"
            conn = connect_db(db_path)
            try:
                ensure_db(conn)
                root = add_root(conn, "Root", root_dir)
                conn.commit()
            finally:
                conn.close()

            def call_preview(query_params):
                handler = object.__new__(FileSearchHandler)
                handler.db_path = str(db_path)
                captured = {}
                handler.send_response = lambda status: captured.setdefault("status", status)
                handler.send_header = lambda key, value: captured.setdefault(key, value)
                handler.end_headers = lambda: captured.setdefault("ended", True)
                handler.wfile = io.BytesIO()
                query = urlencode(query_params)
                FileSearchHandler._handle_preview(handler, urlparse(f"/preview?{query}"))
                return captured["status"], json.loads(handler.wfile.getvalue().decode("utf-8"))

            missing_path_status, missing_path_body = call_preview({"root_id": root.id})
            non_file_status, non_file_body = call_preview({"root_id": root.id, "path": str(root_dir)})
            outside_status, outside_body = call_preview({"root_id": root.id, "path": str(outside_file)})
            not_found_status, not_found_body = call_preview({"root_id": root.id, "path": str(root_dir / "missing.txt")})

        self.assertEqual(missing_path_status, 400)
        self.assertIn("path is required", missing_path_body["error"])
        self.assertEqual(non_file_status, 400)
        self.assertIn("not a file", non_file_body["error"])
        self.assertEqual(outside_status, 403)
        self.assertIn("outside root", outside_body["error"])
        self.assertEqual(not_found_status, 404)
        self.assertIn("Path not found", not_found_body["error"])

    def test_handle_file_serves_root_pdf_inline(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp)
            root_dir = base / "Root"
            root_dir.mkdir()
            pdf_path = root_dir / "申請分の書類.pdf"
            pdf_bytes = b"%PDF-1.4\n%%EOF\n"
            pdf_path.write_bytes(pdf_bytes)

            db_path = base / "index.db"
            conn = connect_db(db_path)
            try:
                ensure_db(conn)
                root = add_root(conn, "Root", root_dir)
                conn.commit()
            finally:
                conn.close()

            handler = object.__new__(FileSearchHandler)
            handler.db_path = str(db_path)
            captured = {}
            handler.send_response = lambda status: captured.setdefault("status", status)
            handler.send_header = lambda key, value: captured.setdefault(key, value)
            handler.end_headers = lambda: captured.setdefault("ended", True)
            handler.wfile = io.BytesIO()

            query = urlencode({"root_id": root.id, "path": str(pdf_path)})
            FileSearchHandler._handle_file(handler, urlparse(f"/file?{query}"))

        self.assertEqual(captured["status"], 200)
        self.assertEqual(captured["Content-Type"], "application/pdf")
        self.assertIn("inline", captured["Content-Disposition"])
        self.assertIn("filename*=UTF-8''", captured["Content-Disposition"])
        self.assertIn("%E7%94%B3%E8%AB%8B", captured["Content-Disposition"])
        captured["Content-Disposition"].encode("latin-1")
        self.assertEqual(handler.wfile.getvalue(), pdf_bytes)

    def test_handle_file_rejects_outside_missing_directory_and_non_pdf(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp)
            root_dir = base / "Root"
            outside_dir = base / "Outside"
            root_dir.mkdir()
            outside_dir.mkdir()
            outside_pdf = outside_dir / "outside.pdf"
            outside_pdf.write_bytes(b"%PDF-1.4\n%%EOF\n")
            non_pdf = root_dir / "note.txt"
            non_pdf.write_text("not pdf", encoding="utf-8")

            db_path = base / "index.db"
            conn = connect_db(db_path)
            try:
                ensure_db(conn)
                root = add_root(conn, "Root", root_dir)
                conn.commit()
            finally:
                conn.close()

            def call_file(query_params):
                handler = object.__new__(FileSearchHandler)
                handler.db_path = str(db_path)
                handler.requestline = ""
                handler.request_version = "HTTP/1.1"
                handler.command = "GET"
                captured = {}
                handler.send_response = lambda status: captured.setdefault("status", status)
                handler.send_header = lambda key, value: captured.setdefault(key, value)
                handler.end_headers = lambda: captured.setdefault("ended", True)
                handler.send_error = lambda status, message=None: captured.setdefault("error", (status, message))
                handler.wfile = io.BytesIO()
                query = urlencode(query_params)
                FileSearchHandler._handle_file(handler, urlparse(f"/file?{query}"))
                return captured

            missing_path_result = call_file({"root_id": root.id})
            directory_result = call_file({"root_id": root.id, "path": str(root_dir)})
            non_pdf_result = call_file({"root_id": root.id, "path": str(non_pdf)})
            outside_result = call_file({"root_id": root.id, "path": str(outside_pdf)})
            not_found_result = call_file({"root_id": root.id, "path": str(root_dir / "missing.pdf")})

        self.assertEqual(missing_path_result["error"][0], 400)
        self.assertIn("path is required", missing_path_result["error"][1])
        self.assertEqual(directory_result["error"][0], 400)
        self.assertIn("not a file", directory_result["error"][1])
        self.assertEqual(non_pdf_result["status"], 200)
        self.assertEqual(non_pdf_result["Content-Type"], "text/plain")
        self.assertEqual(non_pdf_result["Content-Disposition"], 'inline; filename="note.txt"; filename*=UTF-8\'\'note.txt')
        self.assertEqual(outside_result["error"][0], 403)
        self.assertIn("outside root", outside_result["error"][1])
        self.assertEqual(not_found_result["error"][0], 404)
        self.assertIn("Path not found", not_found_result["error"][1])

    def test_open_path_in_file_manager_uses_startfile_on_windows(self):
        with mock.patch("web_app.sys.platform", "win32"):
            with mock.patch("web_app.os.startfile", create=True) as startfile:
                open_path_in_file_manager(pathlib.Path(r"C:\work\sample"))

        startfile.assert_called_once_with(r"C:\work\sample")

    def test_choose_folder_path_uses_macos_folder_dialog(self):
        completed = type("Completed", (), {"returncode": 0, "stdout": "/tmp/Project\n"})()
        with mock.patch("web_app.sys.platform", "darwin"):
            with mock.patch("web_app.subprocess.run", return_value=completed) as run:
                self.assertEqual(choose_folder_path(), "/tmp/Project")

        self.assertEqual(run.call_args.args[0][0], "osascript")

    def test_choose_folder_path_reports_cancel(self):
        completed = type("Completed", (), {"returncode": 1, "stdout": ""})()
        with mock.patch("web_app.sys.platform", "darwin"):
            with mock.patch("web_app.subprocess.run", return_value=completed):
                with self.assertRaises(ValueError):
                    choose_folder_path()

    def test_connect_existing_db_create_creates_schema(self):
        with tempfile.TemporaryDirectory() as tmp:
            handler = object.__new__(FileSearchHandler)
            handler.db_path = str(pathlib.Path(tmp) / "index.db")
            conn, warning = FileSearchHandler._connect_existing_db(handler, create=True)
            try:
                self.assertEqual(warning, "")
                self.assertIsNotNone(conn)
                ensure_db(conn)
                table = conn.execute("SELECT name FROM sqlite_master WHERE name = 'roots'").fetchone()
            finally:
                conn.close()

        self.assertEqual(table[0], "roots")

    def test_stop_existing_server_terminates_listening_pids(self):
        calls = []
        with mock.patch("web_app.find_listening_pids", side_effect=[[101], [], []]):
            with mock.patch("web_app.os.kill") as kill:
                stopped = stop_existing_server(8765)
                calls = kill.call_args_list

        self.assertEqual(stopped, [101])
        self.assertEqual(calls[0].args, (101, 15))

    def test_find_listening_pids_ignores_current_process_and_invalid_lines(self):
        current_pid = 123
        completed = type("Completed", (), {"returncode": 0, "stdout": "123\n456\nbad\n"})()
        with mock.patch("web_app.subprocess.run", return_value=completed):
            with mock.patch("web_app.os.getpid", return_value=current_pid):
                self.assertEqual(find_listening_pids(8765), [456])

    def test_main_stops_existing_server_before_binding(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = pathlib.Path(tmp) / "index.db"
            with mock.patch("web_app.parse_args") as parse_args:
                parse_args.return_value = type(
                    "Args",
                    (),
                    {"db": str(db_path), "host": "127.0.0.1", "port": 8765},
                )()
                with mock.patch("web_app.stop_existing_server", return_value=[101]) as stop_server:
                    with mock.patch("web_app.FileSearchServer") as server_class:
                        server = server_class.return_value
                        server.serve_forever.side_effect = KeyboardInterrupt
                        main()

        stop_server.assert_called_once_with(8765)
        server_class.assert_called_once()
        server.server_close.assert_called_once()

    def test_shutdown_endpoint_schedules_server_shutdown(self):
        class Server:
            def __init__(self):
                self.called = False

            def schedule_shutdown(self, delay_seconds):
                self.called = delay_seconds

        captured = {}
        handler = object.__new__(FileSearchHandler)
        handler.server = Server()
        handler.send_response = lambda status: captured.setdefault("status", status)
        handler.end_headers = lambda: captured.setdefault("ended", True)

        FileSearchHandler._handle_shutdown(handler)

        self.assertEqual(captured["status"], 204)
        self.assertEqual(handler.server.called, 2.0)

    def test_ping_endpoint_cancels_pending_shutdown(self):
        class Server:
            def __init__(self):
                self.called = False

            def cancel_pending_shutdown(self):
                self.called = True

        captured = {}
        handler = object.__new__(FileSearchHandler)
        handler.server = Server()
        handler.send_response = lambda status: captured.setdefault("status", status)
        handler.end_headers = lambda: captured.setdefault("ended", True)

        FileSearchHandler._handle_ping(handler)

        self.assertEqual(captured["status"], 204)
        self.assertTrue(handler.server.called)

    def test_file_search_server_shutdown_timer_can_be_cancelled(self):
        server = object.__new__(FileSearchServer)
        server._shutdown_lock = threading.Lock()
        timer = mock.Mock()
        server._shutdown_timer = timer

        FileSearchServer.cancel_pending_shutdown(server)

        timer.cancel.assert_called_once()
        self.assertIsNone(server._shutdown_timer)


if __name__ == "__main__":
    unittest.main()

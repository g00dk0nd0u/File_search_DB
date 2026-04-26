# File Search DB

ローカルのフォルダ群を SQLite に登録し、ブラウザから検索できる Python 標準ライブラリのみの Web UI です。

現在の実装では、登録したルート配下をスキャンして次の情報を扱います。

- フォルダ名検索
- ファイル名ヒットを親フォルダ単位で集約した検索結果表示
- 子要素一覧と右ペインの浅いフォルダプレビュー
- テキスト / 画像 / PDF の簡易プレビュー
- Settings 画面でのルート追加、表示名編集、再スキャン、削除

`pip install` は不要です。

## 動作環境

- Python 3
- 追加 Python パッケージ不要
- macOS / Windows / Linux を想定

補足:
macOS ではフォルダ追加時に `osascript` のフォルダ選択ダイアログを使います。  
その他の環境では `tkinter` のフォルダ選択ダイアログを使います。

## ディレクトリ構成

- `src/web_app.py`: Web UI 本体
- `src/file_database.py`: SQLite スキーマ、スキャン、検索ロジック
- `src/prepare_sqlite.py`: 空の DB を初期化する補助スクリプト
- `tests/test_web_and_db.py`: 回帰テスト
- `tools/export_repo_zip.py`: ChatGPT レビュー用 ZIP 出力

## クイックスタート

### 1. DB を初期化する

空の DB を先に作る場合:

```bash
python3 -m src.prepare_sqlite --db data/file_index.db
```

`src/web_app.py` 起動時にも DB とテーブルは自動作成されるので、初期化は必須ではありません。

### 2. Web UI を起動する

モジュール実行:

```bash
python3 -m src.web_app --db data/file_index.db --host 127.0.0.1 --port 8765
```

直接実行:

```bash
python3 src/web_app.py --db data/file_index.db --host 127.0.0.1 --port 8765
```

起動後に `http://127.0.0.1:8765` を開きます。  
既に同ポートで旧サーバーが待ち受けている場合は、起動時に停止を試みます。

## 使い方

### 1. 検索対象ルートを追加する

1. 検索画面右上の `Settings` を開く
2. 左上の `Add Directory` を押す
3. フォルダ選択ダイアログでルートフォルダを選ぶ
4. 選んだルートが自動スキャンされる

追加直後の表示名はフォルダ名が使われます。

### 2. Settings 画面で管理する

Settings 画面では次を行えます。

- `Display Name` 入力欄を編集して自動保存
- `Reload` で対象ルートを再スキャン
- `Delete` で対象ルートを削除
- `Path` と `folder count / last scan` の確認

表示名編集はページ再読み込みなしで保存されます。

### 3. 検索する

1. 検索画面で `Search Target` を選ぶ
2. キーワードを入力して検索する

検索結果はフォルダ単位で表示されます。  
ファイル名が一致した場合も、そのファイル自体ではなく親フォルダが結果に出ます。

## 検索クエリ

Google 風の簡易演算子に対応しています。

- `alpha beta`: `alpha` と `beta` の両方を含む
- `alpha OR beta`: `alpha` または `beta` を含む
- `alpha -draft`: `alpha` を含み `draft` は含まない
- `"alpha beta"`: 完全一致フレーズ

補足:

- フォルダ名だけでなく、配下ファイル名の一致でも結果に出ます
- 結果一覧はフォルダ単位のままです

## プレビューと操作

検索結果を展開すると、子要素一覧と右ペインのプレビューを確認できます。

- PDF: ブラウザ標準表示
- 画像: ブラウザ標準表示
- テキスト: 先頭部分を簡易表示
- Office 系ファイル: 直接プレビューせず新規タブ案内

そのほかの挙動:

- 左ペインのフォルダクリックで右ペインに浅いフォルダ内容を表示
- ファイルクリックで右ペインにプレビュー
- Finder / Explorer / ファイルマネージャで対象パスを開く操作あり
- ファイルをドラッグして別フォルダへ移動する操作に対応

## データ構造

- `roots`: 登録済みルート
  - `display_name`
  - `root_path`
  - `created_at`
  - `last_scanned_at`
  - `folder_count`
- `folders`: スキャンされたフォルダ
- `files`: スキャンされたファイル名インデックス

`Reload` 実行時は、対象ルートの `folders` / `files` を作り直します。

## テスト

回帰テスト:

```bash
python3 -m unittest tests.test_web_and_db
```

軽い構文チェック:

```bash
python3 -m py_compile src/web_app.py src/file_database.py tests/test_web_and_db.py
```

ヘルプ確認:

```bash
python3 src/web_app.py --help
python3 src/prepare_sqlite.py --help
```

## ChatGPT レビュー用 ZIP 出力

レビュー用スナップショットは `tools/export_repo_zip.py` を使います。

```bash
python3 tools/export_repo_zip.py --repo . --output ~/Downloads
```

このスクリプトは次を除外します。

- `.git`
- `__pycache__`
- `.gitignore` 対象
- ローカルの不要ファイル

## 補足

- デフォルト DB パスは `data/file_index.db`
- Web UI のデフォルト待受は `127.0.0.1:8765`
- Python 標準ライブラリのみを前提にしています

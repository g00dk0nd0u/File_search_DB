"""Compare the unchanged Python implementation with the vanilla JS port.
Development only: Python stdlib + Node; the HTML app needs neither at runtime.
Run: python -m unittest discover -s html/tests -p 'test_*.py' -v
"""
import random
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'src'))
from file_database import add_root, scan_root, search_folders, parse_folder_query
from web_app import FileSearchHandler

QUERIES = ['', ' ', 'cat', 'CAT', 'alpha beta', 'alpha OR gamma', 'cat -draft',
           '"gamma delta"', '-draft', 'Root', '同名', '日本語', 'OR', 'OR cat OR OR alpha OR',
           '"bad quote', 'cat\\', "'alpha beta'", '"alpha"beta', '-', '%', '_',
           '100%', 'a_b', 'STRASSE', 'Straße', 'ä', 'Ä', 'Σ', 'σ', '""', '-"gamma delta"',
           'cat OR alpha -draft', '"alpha\\q"', '"alpha\\"beta"']

class ParityTests(unittest.TestCase):
    def test_search_parser_aggregation_and_children(self):
        with tempfile.TemporaryDirectory() as tmp:
            # Windows TEMP can use an 8.3 alias; compare against the normalized DB root.
            root_path = (Path(tmp) / 'Root').resolve()
            names = ['商品_cat', 'Other', 'Empty', 'Other/Nested', 'alpha beta', 'alpha draft beta',
                     'gamma delta', '日本語', '100%', 'a_b', 'Straße', 'Ä', 'Σ', '.hidden']
            for name in names:
                (root_path / name).mkdir(parents=True, exist_ok=True)
            paths = ['商品_cat/cat.pdf', '商品_cat/main.png', '商品_cat/cat_draft.txt',
                     'Other/cat_notes.txt', 'Other/alpha_only.txt', 'Other/beta_only.txt',
                     'Other/Nested/cat.pdf', 'alpha beta/alpha beta guide.txt',
                     'gamma delta/gamma delta plan.txt', '日本語/同名.txt', 'Other/同名.txt',
                     'cat_root.txt', 'Other/.hidden.txt', 'Ä/Ä.txt', 'Straße/Straße.txt']
            for path in paths:
                (root_path / path).write_text('fixture', encoding='utf-8')
            conn = sqlite3.connect(':memory:')
            root = add_root(conn, 'Display label', root_path)
            scan_root(conn, root.id)
            relative = lambda path: Path(path).relative_to(root_path).as_posix() if Path(path) != root_path else ''
            folders = [{'name':root_path.name,'path':'','parent':None,'depth':0}]
            folders += [dict(name=n,path=relative(p),parent=relative(parent),depth=d) for n,p,parent,d in conn.execute('SELECT name,path,parent_path,depth FROM folders')]
            files = [dict(name=n,path=relative(p),parent=relative(parent)) for n,p,parent in conn.execute('SELECT file_name,file_path,folder_path FROM files')]
            rng = random.Random(2)
            queries = QUERIES + [''.join(rng.choice('ab -OR\\\"\' \t') for _ in range(rng.randrange(1,30))) for _ in range(200)]
            payload = dict(snapshot=dict(folders=folders, files=files),queries=queries)
            script = """
const S=require('./html/search.js');let data='';process.stdin.setEncoding('utf8');
process.stdin.on('data',x=>data+=x);process.stdin.on('end',async()=>{
 const p=JSON.parse(data),out=[];
 for(const q of p.queries){out.push({parsed:S.parse(q),rows:await S.search(p.snapshot,q),
 children:S.children(p.snapshot,'商品_cat',q,true).map(i=>({name:i.name,type:i.kind==='directory'?'dir':'file'}))});}
 console.log(JSON.stringify(out));});
"""
            result = subprocess.run(['node','-e',script],input=json.dumps(payload),encoding='utf-8',capture_output=True,cwd=REPO,check=True)
            actual = json.loads(result.stdout)
            for q, js in zip(queries, actual):
                with self.subTest(query=q):
                    parsed = parse_folder_query(q)
                    self.assertEqual(js['parsed'],dict(groups=parsed.positive_groups,excluded=parsed.excluded_terms))
                    py_rows = search_folders(conn,root.id,q)
                    expected = [dict(path=relative(r.path),name=r.name,depth=r.depth,folderNameMatched=r.folder_name_matched,
                                     fileMatchCount=r.file_match_count,matchKind=r.match_kind,
                                     matchedFileNames=list(r.matched_file_names),matchedFilePaths=[relative(p) for p in r.matched_file_paths]) for r in py_rows]
                    keys = ['path','name','depth','folderNameMatched','fileMatchCount','matchKind','matchedFileNames','matchedFilePaths']
                    self.assertEqual([{k:r[k] for k in keys} for r in js['rows']],expected)
                    py_children = FileSearchHandler._collect_children_items(root_path/'商品_cat',q,True)
                    self.assertEqual(js['children'],[dict(name=c['name'],type=c['type']) for c in py_children])
            conn.close()

if __name__ == '__main__':
    unittest.main()

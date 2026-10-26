"""Optional developer helper: create acceptance-test files in a NEW directory.
Never required to run the app. Uses only Python's standard library.
"""
import argparse
import base64
from pathlib import Path


def make_fixture(destination: Path, large: int = 0) -> None:
    # Refuse existing paths to avoid overwriting user files.
    destination.mkdir(parents=True, exist_ok=False)
    for name in ['商品_cat', 'Other/Nested', 'Empty', '日本語', '.hidden/Secret']:
        (destination / name).mkdir(parents=True, exist_ok=True)
    for name in ['商品_cat/cat_notes.txt', '商品_cat/other.txt', 'Other/cat_draft.txt',
                 'Other/alpha_only.txt', 'Other/beta_only.txt', 'Other/同名.txt',
                 '日本語/同名.txt', 'cat_root.txt', '.hidden/Secret/hidden.txt']:
        (destination / name).write_text('日本語のプレビュー\n<script>This must be plain text</script>\n', encoding='utf-8')
    (destination / '日本語' / 'cp932.txt').write_bytes('日本語の確認'.encode('cp932'))
    (destination / '日本語' / 'large.txt').write_text('あ' * 20000, encoding='utf-8')
    (destination / '日本語' / 'binary.bin').write_bytes(b'\x01\x00\x02')
    (destination / '商品_cat' / 'main.png').write_bytes(base64.b64decode(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7WQAAAAASUVORK5CYII='))
    # Minimal PDF with correct xref offsets; no external font or resource.
    content = b'BT /F1 24 Tf 36 90 Td (Local PDF preview) Tj ET\n'
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>',
               b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
               b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 160] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
               b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
               b'<< /Length ' + str(len(content)).encode() + b' >>\nstream\n' + content + b'endstream']
    pdf = bytearray(b'%PDF-1.4\n'); offsets = [0]
    for i, obj in enumerate(objects, 1):
        offsets.append(len(pdf)); pdf.extend(str(i).encode() + b' 0 obj\n' + obj + b'\nendobj\n')
    xref = len(pdf)
    pdf.extend(b'xref\n0 6\n0000000000 65535 f \n')
    for offset in offsets[1:]:
        pdf.extend(f'{offset:010} 00000 n \n'.encode())
    pdf.extend(f'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode())
    for name in ['商品_cat/cat.pdf', 'Other/Nested/cat.pdf']:
        (destination / name).write_bytes(pdf)
    if large:
        (destination / 'Large').mkdir()
        for i in range(large):
            (destination / 'Large' / f'item_{i:06}.txt').write_text('test', encoding='utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('destination', type=Path)
    parser.add_argument('--large', type=int, default=0)
    args = parser.parse_args()
    if args.large < 0:
        parser.error('--large must be nonnegative')
    make_fixture(args.destination, args.large)
    print(args.destination.resolve())

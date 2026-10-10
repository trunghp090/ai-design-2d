"""Build the downloadable, source-only Edge extension ZIP reproducibly."""
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'browser-extension' / 'douyin-connect'
OUTPUT = ROOT / 'public' / 'douyin-connect-extension.zip'


def build():
    files = sorted(path for path in SOURCE.iterdir() if path.is_file())
    if not any(path.name == 'manifest.json' for path in files):
        raise ValueError('Extension manifest missing')
    with zipfile.ZipFile(OUTPUT, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            info = zipfile.ZipInfo('douyin-connect/' + path.name, (2026, 10, 10, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes())
    print('Built %s (%d source files)' % (OUTPUT.name, len(files)))


if __name__ == '__main__':
    build()

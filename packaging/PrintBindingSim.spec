# PyInstaller spec: portable one-folder build (nothing is unpacked to temp at run time).
#   dist/PrintBindingSim/PrintBindingSim(.exe)  + _internal/ (Python, Pillow, PDFium, web app)
# Build with:  python packaging/build.py
from pathlib import Path

from PyInstaller.utils.hooks import collect_all

ROOT = Path(SPECPATH).parent

datas = [(str(ROOT / "web"), "web")]
binaries = []
hiddenimports = ["pdfwork"]
for pkg in ("pypdfium2", "pypdfium2_raw"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

a = Analysis(
    [str(ROOT / "server" / "server.py")],
    pathex=[str(ROOT / "server")],
    datas=datas,
    binaries=binaries,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "unittest", "pydoc", "test"],
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="PrintBindingSim",
    console=True,  # the console window shows the URL; closing it stops the server
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="PrintBindingSim", upx=False)

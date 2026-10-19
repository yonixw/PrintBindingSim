"""Build the portable app for the current OS and pack it as an archive.

  pip install -r packaging/requirements-build.txt
  python packaging/build.py

Output: dist/PrintBindingSim/ (run it in place) and
        dist/PrintBindingSim-<windows|linux>-x64.zip|.tar.gz (to share).
"""
import platform
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"


def main():
    subprocess.check_call([sys.executable, str(ROOT / "packaging" / "fetch_vendor.py")])
    subprocess.check_call([
        sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean",
        "--distpath", str(DIST), "--workpath", str(ROOT / "build"),
        str(ROOT / "packaging" / "PrintBindingSim.spec"),
    ])
    app = DIST / "PrintBindingSim"
    for name in ("README.md", "LICENSE"):
        shutil.copy2(ROOT / name, app / name)
    osname = "windows" if sys.platform == "win32" else "linux" if sys.platform.startswith("linux") else sys.platform
    arch = {"amd64": "x64", "x86_64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(platform.machine().lower(), platform.machine())
    base = DIST / f"PrintBindingSim-{osname}-{arch}"
    if osname == "windows":
        out = shutil.make_archive(str(base), "zip", DIST, "PrintBindingSim")
    else:
        out = str(base) + ".tar.gz"
        with tarfile.open(out, "w:gz") as tar:  # keeps the executable bit
            tar.add(app, arcname="PrintBindingSim")
    print(f"\nBuilt {app}\nArchive {out}")


if __name__ == "__main__":
    main()

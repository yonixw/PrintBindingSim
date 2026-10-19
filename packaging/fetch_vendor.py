"""Download three.js (the only front-end dependency) into web/vendor/.

Stdlib only, so a build needs nothing but Python. Same files the Docker build gets via npm.
"""
import io
import sys
import tarfile
import urllib.request
from pathlib import Path

THREE_VERSION = "0.169.0"
URL = f"https://registry.npmjs.org/three/-/three-{THREE_VERSION}.tgz"
ROOT = Path(__file__).resolve().parent.parent
FILES = {
    "package/build/three.module.js": ROOT / "web/vendor/three.module.js",
    "package/examples/jsm/controls/OrbitControls.js": ROOT / "web/vendor/addons/controls/OrbitControls.js",
}


def main():
    if all(p.exists() for p in FILES.values()) and "--force" not in sys.argv:
        print("three.js already in web/vendor")
        return
    print(f"Downloading {URL}")
    data = urllib.request.urlopen(URL, timeout=60).read()
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        for member, dest in FILES.items():
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(tar.extractfile(member).read())
            print(f"  -> {dest.relative_to(ROOT)}")


if __name__ == "__main__":
    main()

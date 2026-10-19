"""PrintBindingSim server: browses a data folder, serves page images + cached thumbnails.

Only dependency besides the stdlib is Pillow.
  DATA_DIR   folder containing your page-image folders (default /data)
  CACHE_DIR  thumbnail + settings cache (default /cache)
  PORT       default 8080
"""
import hashlib
import io
import json
import mimetypes
import os
import re
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from PIL import Image

Image.MAX_IMAGE_PIXELS = None

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data")).resolve()
CACHE_DIR = Path(os.environ.get("CACHE_DIR", "/cache")).resolve()
WEB_DIR = Path(os.environ.get("WEB_DIR", Path(__file__).resolve().parent.parent / "web")).resolve()
PORT = int(os.environ.get("PORT", "8080"))

IMG_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
SIZES = {"lo": 512, "mid": 1600}  # long side in px; "full" = original file

THUMBS = CACHE_DIR / "thumbs"
SETTINGS = CACHE_DIR / "settings"
THUMBS.mkdir(parents=True, exist_ok=True)
SETTINGS.mkdir(parents=True, exist_ok=True)

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()
_dim_cache: dict[tuple, tuple] = {}
_pool = ThreadPoolExecutor(max_workers=max(2, (os.cpu_count() or 2) - 1))


def natural_key(s: str):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


def safe_path(rel: str) -> Path:
    p = (DATA_DIR / rel).resolve()
    if p != DATA_DIR and DATA_DIR not in p.parents:
        raise PermissionError(rel)
    return p


def list_images(folder: Path):
    files = [f for f in folder.iterdir() if f.is_file() and f.suffix.lower() in IMG_EXT and not f.name.startswith(".")]
    files.sort(key=lambda f: natural_key(f.name))
    return files


def find_folders(root: Path, max_depth=4):
    out = []

    def walk(d: Path, depth):
        try:
            entries = sorted((e for e in d.iterdir() if e.is_dir() and not e.name.startswith(".")), key=lambda e: natural_key(e.name))
        except OSError:
            return
        try:
            n = sum(1 for f in d.iterdir() if f.is_file() and f.suffix.lower() in IMG_EXT)
        except OSError:
            n = 0
        if n:
            rel = d.relative_to(root).as_posix()
            out.append({"path": "" if rel == "." else rel, "count": n})
        if depth < max_depth:
            for e in entries:
                walk(e, depth + 1)

    walk(root, 0)
    return out


def image_dims(f: Path):
    st = f.stat()
    key = (str(f), st.st_mtime_ns, st.st_size)
    if key not in _dim_cache:
        with Image.open(f) as im:
            _dim_cache[key] = (im.width, im.height, im.format)
    return _dim_cache[key]


def thumb_path(f: Path, size: str) -> Path:
    st = f.stat()
    h = hashlib.sha1(f"{f}|{st.st_mtime_ns}|{st.st_size}|{size}".encode()).hexdigest()
    return THUMBS / h[:2] / f"{h}.jpg"


def make_thumb(f: Path, size: str) -> Path:
    out = thumb_path(f, size)
    if out.exists():
        return out
    with _locks_guard:
        lock = _locks.setdefault(str(out), threading.Lock())
    with lock:
        if out.exists():
            return out
        with Image.open(f) as im:
            im.draft("RGB", (SIZES[size], SIZES[size]))
            im = im.convert("RGBA") if im.mode in ("RGBA", "LA", "P") else im.convert("RGB")
            if im.mode == "RGBA":
                bg = Image.new("RGB", im.size, "white")
                bg.paste(im, mask=im.split()[3])
                im = bg
            im.thumbnail((SIZES[size], SIZES[size]), Image.LANCZOS)
            out.parent.mkdir(parents=True, exist_ok=True)
            tmp = out.with_suffix(".tmp")
            im.save(tmp, "JPEG", quality=85)
            os.replace(tmp, out)
    return out


def sniff_type(f: Path) -> str:
    with open(f, "rb") as fh:
        head = fh.read(12)
    if head.startswith(b"\x89PNG"):
        return "image/png"
    if head[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if head[:3] == b"GIF":
        return "image/gif"
    if head[:2] == b"BM":
        return "image/bmp"
    return mimetypes.guess_type(f.name)[0] or "application/octet-stream"


def settings_file(rel: str) -> Path:
    return SETTINGS / (hashlib.sha1(rel.encode()).hexdigest() + ".json")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(WEB_DIR), **kw)

    def log_message(self, fmt, *args):
        if os.environ.get("QUIET") != "1":
            sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, f: Path, ctype: str):
        data = f.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "max-age=3600")
        self.end_headers()
        self.wfile.write(data)

    def end_headers(self):
        # Make sure edited JS is picked up during development.
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        u = urlparse(self.path)
        if not u.path.startswith("/api/"):
            return super().do_GET()
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if u.path == "/api/folders":
                return self.send_json({"root": str(DATA_DIR), "folders": find_folders(DATA_DIR)})
            if u.path == "/api/folder":
                folder = safe_path(q.get("path", ""))
                files = list_images(folder)
                imgs = []
                for f in files:
                    try:
                        w, h, fmt = image_dims(f)
                        imgs.append({"name": f.name, "w": w, "h": h, "format": fmt})
                    except Exception as e:  # unreadable file
                        imgs.append({"name": f.name, "w": 0, "h": 0, "error": str(e)})
                # warm thumbnail cache in the background
                for f in files:
                    _pool.submit(make_thumb, f, "lo")
                return self.send_json({"path": q.get("path", ""), "images": imgs})
            if u.path == "/api/image":
                f = safe_path(q["path"])
                size = q.get("size", "full")
                if size in SIZES:
                    return self.send_file(make_thumb(f, size), "image/jpeg")
                return self.send_file(f, sniff_type(f))
            if u.path == "/api/settings":
                sf = settings_file(q.get("path", ""))
                return self.send_json(json.loads(sf.read_text()) if sf.exists() else None)
        except PermissionError:
            return self.send_json({"error": "forbidden"}, 403)
        except (FileNotFoundError, KeyError) as e:
            return self.send_json({"error": f"not found: {e}"}, 404)
        except Exception as e:
            return self.send_json({"error": str(e)}, 500)
        self.send_json({"error": "unknown endpoint"}, 404)

    def do_PUT(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if u.path != "/api/settings":
            return self.send_json({"error": "unknown endpoint"}, 404)
        n = int(self.headers.get("Content-Length", "0"))
        data = json.loads(self.rfile.read(n) or b"null")
        settings_file(q.get("path", "")).write_text(json.dumps(data, indent=2))
        self.send_json({"ok": True})


mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")

if __name__ == "__main__":
    print(f"PrintBindingSim: data={DATA_DIR} cache={CACHE_DIR} web={WEB_DIR}")
    print(f"Open http://localhost:{PORT}")
    ThreadingHTTPServer.daemon_threads = True
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()

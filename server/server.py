"""PrintBindingSim server: browses a data folder, serves page images + cached thumbnails.

Dependencies besides the stdlib: Pillow, and pypdfium2 for PDFs.
  DATA_DIR   folder containing your page-image folders and PDFs
             (default /data; portable build: ./data next to the executable)
  CACHE_DIR  thumbnail + settings cache (default /cache; portable: <DATA_DIR>/.cache)
  PORT       default 8080 (portable build: the next free port if 8080 is taken)
  NO_BROWSER set to 1 to not open a browser on start (portable build only)

A PDF is treated like a folder of images: page i is image i. Pages are rendered on
demand (and in the background) straight from the PDF; nothing is split up front.
Uploads from the UI are stored in DATA_DIR/pdf/ (PDFs) and DATA_DIR/img/<folder>/ (images);
"clear all data" empties exactly those two folders.
"""
import hashlib
import json
import mimetypes
import multiprocessing
import os
import re
import shutil
import sys
import threading
import webbrowser
from collections import namedtuple
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from PIL import Image, ImageFilter

import pdfwork

Image.MAX_IMAGE_PIXELS = None

# Portable build (PyInstaller one-folder): bundled files live in sys._MEIPASS, user data
# goes next to the executable. Docker / dev: /data and /cache.
FROZEN = getattr(sys, "frozen", False)
APP_DIR = Path(sys.executable).resolve().parent if FROZEN else Path(__file__).resolve().parent.parent
BUNDLE_DIR = Path(getattr(sys, "_MEIPASS", APP_DIR))
DATA_DIR = Path(os.environ.get("DATA_DIR", APP_DIR / "data" if FROZEN else "/data")).resolve()
CACHE_DIR = Path(os.environ.get("CACHE_DIR", DATA_DIR / ".cache" if FROZEN else "/cache")).resolve()
WEB_DIR = Path(os.environ.get("WEB_DIR", BUNDLE_DIR / "web")).resolve()
PORT = int(os.environ.get("PORT", "8080"))
WORKERS = max(2, (os.cpu_count() or 2) - 1)

IMG_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
SIZES = {"lo": 512, "mid": 1600}  # long side in px; "full" = original file
PDF_FULL = 2400                   # long side of a "full" PDF page render
PDF_DIR = "pdf"                   # uploaded PDFs go to DATA_DIR/pdf
IMG_DIR = "img"                   # uploaded image folders go to DATA_DIR/img/<folder>

THUMBS = CACHE_DIR / "thumbs"
SETTINGS = CACHE_DIR / "settings"
PDFINFO = CACHE_DIR / "pdfinfo"
for d in (THUMBS, SETTINGS, PDFINFO):
    d.mkdir(parents=True, exist_ok=True)

PdfPage = namedtuple("PdfPage", "path index")

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()
_dim_cache: dict[tuple, tuple] = {}
_pdf_cache: dict[tuple, list] = {}
_pool = ThreadPoolExecutor(max_workers=WORKERS)
_ppool = None  # process pool for PDFium, created on first use
_progress: dict[str, dict] = {}  # source -> {gen, done, total}


def pdf_pool():
    global _ppool
    with _locks_guard:
        if _ppool is None:
            _ppool = ProcessPoolExecutor(max_workers=WORKERS, mp_context=multiprocessing.get_context("spawn"))
    return _ppool


def natural_key(s: str):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


def safe_path(rel: str) -> Path:
    p = (DATA_DIR / rel).resolve()
    if p != DATA_DIR and DATA_DIR not in p.parents:
        raise PermissionError(rel)
    return p


def is_pdf(p: Path) -> bool:
    return p.suffix.lower() == ".pdf" and p.is_file()


def list_images(folder: Path):
    files = [f for f in folder.iterdir() if f.is_file() and f.suffix.lower() in IMG_EXT and not f.name.startswith(".")]
    files.sort(key=lambda f: natural_key(f.name))
    return files


def pdf_pages(p: Path):
    """[(w_pt, h_pt)] per page; cached in memory and on disk (instant reopen of huge PDFs)."""
    st = p.stat()
    key = (str(p), st.st_mtime_ns, st.st_size)
    if key in _pdf_cache:
        return _pdf_cache[key]
    disk = PDFINFO / (hashlib.sha1(repr(key).encode()).hexdigest() + ".json")
    if disk.exists():
        sizes = json.loads(disk.read_text())
    else:
        sizes = pdf_pool().submit(pdfwork.pdf_info, str(p)).result()
        disk.write_text(json.dumps(sizes))
    _pdf_cache[key] = sizes
    return sizes


def find_folders(root: Path, max_depth=4):
    out = []

    def walk(d: Path, depth):
        try:
            children = list(d.iterdir())
        except OSError:
            return
        n = sum(1 for f in children if f.is_file() and f.suffix.lower() in IMG_EXT)
        rel = d.relative_to(root).as_posix()
        rel = "" if rel == "." else rel
        if n:
            out.append({"path": rel, "count": n, "kind": "folder"})
        for f in sorted((f for f in children if f.is_file() and f.suffix.lower() == ".pdf"), key=lambda f: natural_key(f.name)):
            try:
                out.append({"path": (rel + "/" if rel else "") + f.name, "count": len(pdf_pages(f)), "kind": "pdf"})
            except Exception as e:
                out.append({"path": (rel + "/" if rel else "") + f.name, "count": 0, "kind": "pdf", "error": str(e)})
        if depth < max_depth:
            for e in sorted((e for e in children if e.is_dir() and not e.name.startswith(".")), key=lambda e: natural_key(e.name)):
                walk(e, depth + 1)

    walk(root, 0)
    return out


def source_items(rel: str):
    """(items, image metadata) for a folder or a PDF."""
    p = safe_path(rel)
    if is_pdf(p):
        items, meta = [], []
        for i, (w, h) in enumerate(pdf_pages(p)):
            k = PDF_FULL / max(w, h, 1)
            items.append(PdfPage(p, i))
            meta.append({"name": f"page {i + 1:04d}", "w": round(w * k), "h": round(h * k), "format": "PDF"})
        return items, meta
    files = list_images(p)
    meta = []
    for f in files:
        try:
            w, h, fmt = image_dims(f)
            meta.append({"name": f.name, "w": w, "h": h, "format": fmt})
        except Exception as e:  # unreadable file
            meta.append({"name": f.name, "w": 0, "h": 0, "error": str(e)})
    return files, meta


def warm_source(rel: str, items, blur: float):
    """Pre-render thumbnails (and blurred / PDF large versions) for every item in the background."""
    pdf = bool(items) and isinstance(items[0], PdfPage)
    sizes = ["lo"] + (["mid"] if blur > 0 else [])
    with _locks_guard:
        prev = _progress.get(rel, {}).get("gen", 0)
        prog = _progress[rel] = {"gen": prev + 1, "done": 0, "total": len(items) * len(sizes), "pdf": pdf}
    gen = prog["gen"]

    def job(item, size):
        if _progress.get(rel, {}).get("gen") != gen:
            return  # superseded by a newer warm-up (e.g. blur changed)
        try:
            make_thumb(item, size, blur)
        except Exception:
            pass
        with _locks_guard:
            prog["done"] += 1

    for size in sizes:
        for item in items:
            _pool.submit(job, item, size)


def image_dims(f: Path):
    st = f.stat()
    key = (str(f), st.st_mtime_ns, st.st_size)
    if key not in _dim_cache:
        with Image.open(f) as im:
            _dim_cache[key] = (im.width, im.height, im.format)
    return _dim_cache[key]


def parse_blur(v) -> float:
    """Blur strength 0..100: Gaussian radius in thousandths of the image's long side."""
    try:
        return max(0.0, min(100.0, round(float(v), 1)))
    except (TypeError, ValueError):
        return 0.0


def thumb_path(item, size: str, blur: float = 0) -> Path:
    p = item.path if isinstance(item, PdfPage) else item
    st = p.stat()
    page = f"|p{item.index}" if isinstance(item, PdfPage) else ""
    h = hashlib.sha1(f"{p}|{st.st_mtime_ns}|{st.st_size}{page}|{size}|{blur}".encode()).hexdigest()
    return THUMBS / h[:2] / f"{h}.jpg"


def make_thumb(item, size: str, blur: float = 0) -> Path:
    out = thumb_path(item, size, blur)
    if out.exists():
        return out
    with _locks_guard:
        lock = _locks.setdefault(str(out), threading.Lock())
    with lock:
        if out.exists():
            return out
        if isinstance(item, PdfPage):
            long_side = PDF_FULL if size == "full" else SIZES[size]
            quality = 90 if size == "full" else 85
            pdf_pool().submit(pdfwork.render_page, str(item.path), item.index, long_side, blur, str(out), quality).result()
            return out
        with Image.open(item) as im:
            im.draft("RGB", (SIZES[size], SIZES[size]))
            im = im.convert("RGBA") if im.mode in ("RGBA", "LA", "P") else im.convert("RGB")
            if im.mode == "RGBA":
                bg = Image.new("RGB", im.size, "white")
                bg.paste(im, mask=im.split()[3])
                im = bg
            im.thumbnail((SIZES[size], SIZES[size]), Image.LANCZOS)
            if blur > 0:
                # Relative radius, so the thumbnail and the large version look the same.
                im = im.filter(ImageFilter.GaussianBlur(blur / 1000 * max(im.size)))
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


def safe_name(name: str) -> str:
    name = os.path.basename(name.replace("\\", "/")).strip()
    name = re.sub(r"[^\w\-. ()\[\]]+", "_", name).strip(" .")
    if not name:
        raise ValueError("bad file name")
    return name


def safe_upload_name(name: str) -> str:
    name = safe_name(name)
    if not name.lower().endswith(".pdf"):
        raise ValueError("only .pdf files can be uploaded")
    return name


def stream_to(rfile, n: int, dest: Path):
    """Write n request bytes to dest via a temp file, in chunks (big uploads never sit in memory)."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.parent / ("." + dest.name + ".part")
    with open(part, "wb") as fh:
        left = n
        while left > 0:
            chunk = rfile.read(min(left, 4 << 20))
            if not chunk:
                raise IOError("upload interrupted")
            fh.write(chunk)
            left -= len(chunk)
    return part


def empty_dir(d: Path) -> int:
    """Delete everything inside d (not d itself). Returns the number of top-level entries removed."""
    if not d.is_dir():
        return 0
    n = 0
    for child in d.iterdir():
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child)
        else:
            child.unlink()
        n += 1
    return n


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

    def query(self):
        u = urlparse(self.path)
        return u.path, {k: v[0] for k, v in parse_qs(u.query).items()}

    def do_GET(self):
        path, q = self.query()
        if not path.startswith("/api/"):
            return super().do_GET()
        try:
            if path == "/api/folders":
                return self.send_json({"root": str(DATA_DIR), "folders": find_folders(DATA_DIR)})
            if path == "/api/data-summary":
                # What "clear all data" would delete
                imgs = sum(1 for d in (DATA_DIR / IMG_DIR).glob("*") if d.is_dir()) if (DATA_DIR / IMG_DIR).is_dir() else 0
                pdfs = sum(1 for f in (DATA_DIR / PDF_DIR).glob("*.pdf")) if (DATA_DIR / PDF_DIR).is_dir() else 0
                return self.send_json({"imageFolders": imgs, "pdfs": pdfs})
            if path == "/api/folder":
                rel = q.get("path", "")
                items, meta = source_items(rel)
                warm_source(rel, items, parse_blur(q.get("blur")))
                return self.send_json({"path": rel, "kind": "pdf" if is_pdf(safe_path(rel)) else "folder", "images": meta})
            if path == "/api/warm":
                rel = q.get("path", "")
                warm_source(rel, source_items(rel)[0], parse_blur(q.get("blur")))
                return self.send_json({"ok": True})
            if path == "/api/progress":
                p = _progress.get(q.get("path", ""), {})
                return self.send_json({"done": p.get("done", 0), "total": p.get("total", 0)})
            if path == "/api/image":
                p = safe_path(q["path"])
                size = q.get("size", "full")
                blur = parse_blur(q.get("blur"))
                if blur > 0 and size not in SIZES:
                    size = "mid"  # no point sending a full-resolution blurred image
                if is_pdf(p):
                    return self.send_file(make_thumb(PdfPage(p, int(q["page"])), size, blur), "image/jpeg")
                if size in SIZES:
                    return self.send_file(make_thumb(p, size, blur), "image/jpeg")
                return self.send_file(p, sniff_type(p))
            if path == "/api/settings":
                sf = settings_file(q.get("path", ""))
                return self.send_json(json.loads(sf.read_text()) if sf.exists() else None)
        except PermissionError:
            return self.send_json({"error": "forbidden"}, 403)
        except (FileNotFoundError, KeyError, IndexError) as e:
            return self.send_json({"error": f"not found: {e}"}, 404)
        except Exception as e:
            return self.send_json({"error": str(e)}, 500)
        self.send_json({"error": "unknown endpoint"}, 404)

    def do_POST(self):
        path, q = self.query()
        try:
            n = int(self.headers.get("Content-Length", "0"))
            if path == "/api/upload-images/begin":
                # Start (or replace) an uploaded image folder: DATA_DIR/img/<folder>
                folder = safe_name(q.get("folder", ""))
                d = DATA_DIR / IMG_DIR / folder
                if d.exists():
                    shutil.rmtree(d)
                d.mkdir(parents=True)
                return self.send_json({"path": f"{IMG_DIR}/{folder}"})
            if path == "/api/upload-image":
                folder, name = safe_name(q.get("folder", "")), safe_name(q.get("name", ""))
                if Path(name).suffix.lower() not in IMG_EXT:
                    raise ValueError(f"not an image file: {name}")
                dest = DATA_DIR / IMG_DIR / folder / name
                os.replace(stream_to(self.rfile, n, dest), dest)
                return self.send_json({"ok": True})
            if path == "/api/clear":
                # Delete every uploaded image folder and PDF, and the render cache. Nothing else.
                removed = empty_dir(DATA_DIR / IMG_DIR) + empty_dir(DATA_DIR / PDF_DIR)
                empty_dir(THUMBS)
                empty_dir(PDFINFO)
                _pdf_cache.clear(); _dim_cache.clear(); _progress.clear()
                return self.send_json({"removed": removed})
            if path != "/api/upload":
                return self.send_json({"error": "unknown endpoint"}, 404)
            name = safe_upload_name(q.get("name", ""))
            dest = DATA_DIR / PDF_DIR / name
            part = stream_to(self.rfile, n, dest)
            with open(part, "rb") as fh:
                magic = fh.read(5)
            if magic != b"%PDF-":
                part.unlink()
                raise ValueError("not a PDF file")
            os.replace(part, dest)
            rel = f"{PDF_DIR}/{name}"
            return self.send_json({"path": rel, "pages": len(pdf_pages(dest))})
        except OSError as e:
            return self.send_json({"error": f"cannot write to the data folder (is it mounted writable?): {e}"}, 500)
        except Exception as e:
            return self.send_json({"error": str(e)}, 400)

    def do_PUT(self):
        path, q = self.query()
        if path != "/api/settings":
            return self.send_json({"error": "unknown endpoint"}, 404)
        n = int(self.headers.get("Content-Length", "0"))
        data = json.loads(self.rfile.read(n) or b"null")
        settings_file(q.get("path", "")).write_text(json.dumps(data, indent=2))
        self.send_json({"ok": True})


mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")

def make_server():
    ThreadingHTTPServer.daemon_threads = True
    # Portable: if the port is taken (e.g. a second copy), use the next free one.
    for port in range(PORT, PORT + (20 if FROZEN else 1)):
        try:
            return ThreadingHTTPServer(("0.0.0.0", port), Handler), port
        except OSError:
            if port == PORT + (19 if FROZEN else 0):
                raise
    raise OSError("no free port")


if __name__ == "__main__":
    multiprocessing.freeze_support()  # PDF worker processes inside the packed executable
    (DATA_DIR / IMG_DIR).mkdir(parents=True, exist_ok=True)
    (DATA_DIR / PDF_DIR).mkdir(parents=True, exist_ok=True)
    httpd, port = make_server()
    url = f"http://localhost:{port}"
    print(f"PrintBindingSim: data={DATA_DIR} cache={CACHE_DIR} web={WEB_DIR}", flush=True)
    print(f"Open {url}", flush=True)
    if FROZEN:
        print("Close this window to stop the server.", flush=True)
        if os.environ.get("NO_BROWSER") != "1":
            threading.Timer(0.8, webbrowser.open, args=[url]).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass

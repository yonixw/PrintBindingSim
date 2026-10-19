"""PDF work that runs in separate worker processes (PDFium is not thread-safe).

Each worker keeps a few documents open, so rendering page N of a huge PDF only
reads what that page needs. The file itself is never loaded into memory.
"""
import os
from collections import OrderedDict

import pypdfium2 as pdfium
from PIL import ImageFilter

_docs: "OrderedDict[tuple, pdfium.PdfDocument]" = OrderedDict()


def _doc(path: str):
    st = os.stat(path)
    key = (path, st.st_mtime_ns, st.st_size)
    d = _docs.get(key)
    if d is None:
        d = pdfium.PdfDocument(path)
        _docs[key] = d
        while len(_docs) > 4:
            _, old = _docs.popitem(last=False)
            old.close()
    else:
        _docs.move_to_end(key)
    return d


def pdf_info(path: str):
    """Page sizes in points, as displayed (page rotation applied)."""
    doc = _doc(path)
    sizes = []
    for i in range(len(doc)):
        page = doc[i]
        w, h = page.get_size()
        if page.get_rotation() in (90, 270):
            w, h = h, w
        sizes.append((w, h))
        page.close()
    return sizes


def render_page(path: str, index: int, long_side: int, blur: float, out: str, quality: int):
    """Render one page so its long side is `long_side` px, optionally blur, save as JPEG."""
    doc = _doc(path)
    page = doc[index]
    w, h = page.get_size()
    scale = long_side / max(w, h, 1)
    bitmap = page.render(scale=scale, fill_color=(255, 255, 255, 255))
    im = bitmap.to_pil().convert("RGB")
    page.close()
    if blur > 0:
        im = im.filter(ImageFilter.GaussianBlur(blur / 1000 * max(im.size)))
    tmp = out + f".{os.getpid()}.tmp"
    os.makedirs(os.path.dirname(out), exist_ok=True)
    im.save(tmp, "JPEG", quality=quality)
    os.replace(tmp, out)
    return out

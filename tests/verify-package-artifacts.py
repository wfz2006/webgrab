from pathlib import Path
from zipfile import ZIP_STORED, ZipFile
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1] / ".test-output" / "p4-2"


with ZipFile(ROOT / "fixture-comic.cbz") as cbz:
    assert cbz.testzip() is None
    image_names = [name for name in cbz.namelist() if name.endswith(".png")]
    assert image_names == ["001.png", "002.png", "003.png"]
    for name in image_names:
        data = cbz.read(name)
        assert len(data) > 0 and data.startswith(b"\x89PNG\r\n\x1a\n")
    ET.fromstring(cbz.read("ComicInfo.xml"))


with ZipFile(ROOT / "fixture-novel.epub") as epub:
    assert epub.testzip() is None
    first = epub.infolist()[0]
    assert first.filename == "mimetype"
    assert first.compress_type == ZIP_STORED
    assert epub.read("mimetype") == b"application/epub+zip"
    for name in epub.namelist():
        if name.endswith((".xml", ".opf", ".ncx", ".xhtml")):
            ET.fromstring(epub.read(name))
    opf = ET.fromstring(epub.read("OEBPS/content.opf"))
    ns = {"opf": "http://www.idpf.org/2007/opf"}
    assert len(opf.findall("./opf:spine/opf:itemref", ns)) == 20
    nav = ET.fromstring(epub.read("OEBPS/nav.xhtml"))
    xhtml = {"x": "http://www.w3.org/1999/xhtml"}
    assert len(nav.findall(".//x:nav/x:ol/x:li/x:a", xhtml)) == 20


index_html = (ROOT / "fixture-comic" / "index.html").read_text(encoding="utf-8")
assert all(f'src="{index:03}.png"' in index_html for index in range(1, 4))
assert "ArrowRight" in index_html and "max-width:100%" in index_html

print("CBZ_OK pages=3; EPUB_OK chapters=20; INDEX_OK pages=3")

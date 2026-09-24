"""One-pass HTML scan for the metadata AI crawlers and agents read.

Collects, without executing any script:
    title, meta tags, canonical link, html lang,
    JSON-LD blocks, inline script text and external script URLs,
    forms and their fields, including WebMCP declarative attributes
    (toolname, tooldescription, toolautosubmit, toolparamdescription).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from html.parser import HTMLParser

MAX_INLINE_SCRIPT_CHARS = 400_000
MAX_LINKS = 500


@dataclass
class FormField:
    tag: str
    name: str | None
    type: str | None
    required: bool
    param_description: str | None


@dataclass
class Form:
    attrs: dict[str, str | None]
    fields: list[FormField] = field(default_factory=list)

    @property
    def tool_name(self) -> str | None:
        return self.attrs.get("toolname")

    @property
    def tool_description(self) -> str | None:
        return self.attrs.get("tooldescription")

    @property
    def is_webmcp_tool(self) -> bool:
        return "toolname" in self.attrs or "tooldescription" in self.attrs


@dataclass
class PageScan:
    title: str = ""
    lang: str | None = None
    meta: dict[str, str] = field(default_factory=dict)      # name/property -> content (first wins)
    canonical: str | None = None
    json_ld: list[str] = field(default_factory=list)
    inline_scripts: list[str] = field(default_factory=list)
    script_srcs: list[str] = field(default_factory=list)
    forms: list[Form] = field(default_factory=list)
    markdown_alternates: list[str] = field(default_factory=list)
    links: list[str] = field(default_factory=list)          # <a href> values, capped


class _Scanner(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.scan = PageScan()
        self._in_title = False
        self._script_kind: str | None = None  # "ld" | "inline" | None
        self._script_buf: list[str] = []
        self._form: Form | None = None
        self._inline_chars = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = {k.lower(): v for k, v in attrs}
        if tag == "a" and a.get("href") and len(self.scan.links) < MAX_LINKS:
            self.scan.links.append(a["href"] or "")
        elif tag == "html" and a.get("lang"):
            self.scan.lang = a["lang"]
        elif tag == "title":
            self._in_title = True
        elif tag == "meta":
            key = (a.get("name") or a.get("property") or a.get("http-equiv") or "").strip().lower()
            if key and a.get("content") is not None and key not in self.scan.meta:
                self.scan.meta[key] = (a.get("content") or "").strip()
        elif tag == "link":
            rel = (a.get("rel") or "").lower().split()
            if "canonical" in rel and a.get("href"):
                self.scan.canonical = a["href"]
            if "alternate" in rel and (a.get("type") or "").lower() == "text/markdown" and a.get("href"):
                self.scan.markdown_alternates.append(a["href"] or "")
        elif tag == "script":
            stype = (a.get("type") or "").strip().lower()
            if stype == "application/ld+json":
                self._script_kind = "ld"
            elif a.get("src"):
                self.scan.script_srcs.append(a["src"] or "")
                self._script_kind = None
            elif stype in {"", "text/javascript", "module", "application/javascript"}:
                self._script_kind = "inline"
            else:
                self._script_kind = None
            self._script_buf = []
        elif tag == "form":
            self._form = Form(attrs=a)
            self.scan.forms.append(self._form)
        elif tag in {"input", "select", "textarea"} and self._form is not None:
            ftype = (a.get("type") or ("text" if tag == "input" else tag)).lower()
            if ftype in {"submit", "button", "reset", "image"}:
                return
            self._form.fields.append(FormField(
                tag=tag,
                name=a.get("name"),
                type=ftype,
                required="required" in a,
                param_description=a.get("toolparamdescription"),
            ))

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False
        elif tag == "script":
            text = "".join(self._script_buf)
            if self._script_kind == "ld":
                self.scan.json_ld.append(text)
            elif self._script_kind == "inline" and self._inline_chars < MAX_INLINE_SCRIPT_CHARS:
                self.scan.inline_scripts.append(text)
                self._inline_chars += len(text)
            self._script_kind = None
            self._script_buf = []
        elif tag == "form":
            self._form = None

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.scan.title += data
        if self._script_kind is not None:
            self._script_buf.append(data)


def scan_html(html: str) -> PageScan:
    scanner = _Scanner()
    try:
        scanner.feed(html)
        scanner.close()
    except Exception:  # malformed markup must not crash an audit
        pass
    scanner.scan.title = " ".join(scanner.scan.title.split())
    return scanner.scan

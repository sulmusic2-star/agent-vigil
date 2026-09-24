"""Validate and generate llms.txt files (https://llmstxt.org).

The format, in order:
    1. an H1 with the site or project name (required)
    2. a blockquote with a short summary (recommended)
    3. optional detail paragraphs or lists (no headings)
    4. H2 sections, each a markdown list of links: "- [name](url): notes"
       A section named "Optional" marks links an agent may skip.

Real files often bend the format (subheadings, "- [name](url) - notes", prose
inside sections). Repeated problems are reported once, with a count and the
first line numbers, so a large file produces a short, readable list.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field
from urllib.parse import urlsplit

MAX_RECOMMENDED_BYTES = 100_000
MAX_LINES_LISTED = 10

_H1 = re.compile(r"^#\s+(.+?)\s*#*\s*$")
_H2 = re.compile(r"^##\s+(.+?)\s*#*\s*$")
_H3PLUS = re.compile(r"^#{3,}\s+")
_LIST_ITEM = re.compile(r"^\s*[-*+]\s+(.*)$")
_LINK_ITEM = re.compile(r"^\[([^\]]+)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)(.*)$")
_THEMATIC_BREAK = re.compile(r"^(?:-{3,}|\*{3,}|_{3,})$")

# Problems that can repeat on many lines: code -> (severity, message).
_REPEATED = {
    "subheading": ("info", "{n} H3-or-deeper heading(s); llms.txt sections are H2 only, so parsers read them as plain text"),
    "text": ("warning", "{n} line(s) of plain text inside link sections; agents expect only '- [Name](url): notes' items there"),
    "not-link": ("warning", "{n} list item(s) without a markdown link like '- [Name](https://...)'"),
    "separator": ("info", "{n} link(s) put notes after something other than ': ' (for example ' - '); "
                          "llmstxt.org parsers read notes only after ': '"),
    "duplicate": ("warning", "{n} duplicate link(s), for example {example}"),
}


@dataclass
class Issue:
    severity: str  # error | warning | info
    message: str
    count: int = 1
    lines: list[int] = field(default_factory=list)

    def as_dict(self) -> dict[str, object]:
        return {"severity": self.severity, "message": self.message, "count": self.count, "lines": self.lines}


@dataclass
class Section:
    name: str
    links: list[dict[str, str]] = field(default_factory=list)


@dataclass
class LlmsTxtReport:
    present: bool
    valid: bool = False
    title: str | None = None
    summary: str | None = None
    sections: list[Section] = field(default_factory=list)
    issues: list[Issue] = field(default_factory=list)
    size_bytes: int = 0

    @property
    def link_count(self) -> int:
        return sum(len(s.links) for s in self.sections)

    def add(self, severity: str, message: str, lines: list[int] | None = None, count: int = 1) -> None:
        self.issues.append(Issue(severity, message, count, list(lines or [])))


def validate(text: str, *, served_as_html: bool = False) -> LlmsTxtReport:
    report = LlmsTxtReport(present=True, size_bytes=len(text.encode("utf-8")))
    if served_as_html:
        report.present = False
        report.add("error", "llms.txt returned an HTML page (often a single-page-app fallback), not Markdown")
        return report
    lines = text.splitlines()
    content = [(i, l) for i, l in enumerate(lines, start=1) if l.strip()]
    if not content:
        report.add("error", "llms.txt is empty")
        return report

    first_no, first = content[0]
    h1 = _H1.match(first.strip())
    if not h1 or first.strip().startswith("##"):
        report.add("error", "the file must start with an H1 title, e.g. '# Example Site'", [first_no])
    else:
        report.title = h1.group(1)

    h1_lines = [n for n, l in content if _H1.match(l.strip()) and not l.strip().startswith("##")]
    if len(h1_lines) > 1:
        report.add("warning", "more than one H1 heading; llms.txt should have exactly one", h1_lines[1:MAX_LINES_LISTED + 1],
                   len(h1_lines) - 1)

    found: dict[str, list[int]] = {code: [] for code in _REPEATED}
    first_duplicate = ""
    summary_lines: list[str] = []
    current: Section | None = None
    seen_urls: set[str] = set()
    relative_links = 0
    for number, raw in content[1:]:
        line = raw.strip()
        if _THEMATIC_BREAK.match(line):
            continue
        if _H3PLUS.match(line):
            found["subheading"].append(number)
            continue
        h2 = _H2.match(line)
        if h2:
            current = Section(name=h2.group(1))
            report.sections.append(current)
            continue
        if current is None:
            if line.startswith(">"):
                summary_lines.append(line.lstrip(">").strip())
            continue
        item = _LIST_ITEM.match(raw)
        if not item:
            found["text"].append(number)
            continue
        link = _LINK_ITEM.match(item.group(1).strip())
        if not link:
            found["not-link"].append(number)
            continue
        name, url, rest = link.group(1), link.group(2), link.group(3).strip()
        if rest.startswith(":"):
            notes = rest[1:].strip()
        elif rest:
            found["separator"].append(number)
            notes = rest.lstrip("-–—:| ").strip()
        else:
            notes = ""
        if url in seen_urls:
            found["duplicate"].append(number)
            first_duplicate = first_duplicate or url
        seen_urls.add(url)
        if not urlsplit(url).scheme:
            relative_links += 1
        current.links.append({"name": name, "url": url, "notes": notes})

    for code, numbers in found.items():
        if numbers:
            severity, template = _REPEATED[code]
            report.add(severity, template.format(n=len(numbers), example=first_duplicate),
                       numbers[:MAX_LINES_LISTED], len(numbers))

    if summary_lines:
        report.summary = " ".join(s for s in summary_lines if s)
    else:
        report.add("warning", "no blockquote summary after the title (a '> one-line summary' helps agents)")
    if not report.sections:
        report.add("warning", "no '## Section' headings with link lists")
    empty = [s.name for s in report.sections if not s.links]
    if empty:
        report.add("warning", f"{len(empty)} section(s) have no links: " + ", ".join(f"'## {n}'" for n in empty[:5]),
                   count=len(empty))
    if relative_links:
        report.add("info", f"{relative_links} relative link(s); absolute URLs are easier for agents to follow",
                   count=relative_links)
    if any(s.name.strip().lower() == "optional" for s in report.sections):
        report.add("info", "has an 'Optional' section, which agents may skip for shorter context")
    if report.size_bytes > MAX_RECOMMENDED_BYTES:
        report.add("warning", f"file is {report.size_bytes // 1000} KB; keep llms.txt concise and put full text in llms-full.txt")

    report.valid = not any(i.severity == "error" for i in report.issues)
    return report


# --- generation --------------------------------------------------------------

_LOCALE = re.compile(r"^[a-z]{2}(?:[-_][a-z]{2,4})?$", re.IGNORECASE)
_TITLE_SEPARATORS = (" | ", " - ", " – ", " — ", " · ", " :: ", " • ")


def _one_line(text: str, limit: int = 160) -> str:
    clean = " ".join((text or "").split())
    return clean if len(clean) <= limit else clean[: limit - 1].rstrip() + "…"


def _segments(url: str) -> list[str]:
    """Path segments, without a leading language code such as 'en' or 'pt-br'."""

    segments = [s for s in urlsplit(url).path.split("/") if s]
    if len(segments) > 1 and _LOCALE.match(segments[0]):
        segments = segments[1:]
    return segments


def _section_key(url: str) -> str | None:
    """The folder a page lives in (e.g. 'blog' for /blog/post-1); None for top-level pages."""

    segments = _segments(url)
    return segments[0].lower() if len(segments) >= 2 else None


def _section_title(key: str) -> str:
    words = [w for w in re.split(r"[-_]+", key) if w]
    return " ".join(w.capitalize() for w in words) or "Pages"


def _slug_title(url: str) -> str:
    segments = [s for s in urlsplit(url).path.split("/") if s]
    if not segments:
        return "Home"
    slug = re.sub(r"\.[a-z0-9]{2,5}$", "", segments[-1], flags=re.IGNORECASE)
    words = [w for w in re.split(r"[-_]+", slug) if w]
    return " ".join(words).capitalize() if words else "Page"


def _strip_common_affix(titles: list[str]) -> list[str]:
    """Drop a site-wide ' | Brand' suffix (or 'Brand | ' prefix) shared by most titles."""

    if len(titles) < 2:
        return titles
    for sep in _TITLE_SEPARATORS:
        with_sep = [t for t in titles if sep in t]
        if len(with_sep) < max(2, len(titles) // 2):
            continue
        suffix, suffix_n = Counter(t.rsplit(sep, 1)[1] for t in with_sep).most_common(1)[0]
        prefix, prefix_n = Counter(t.split(sep, 1)[0] for t in with_sep).most_common(1)[0]
        if suffix_n >= max(2, len(titles) // 2):
            return [t[: -len(sep + suffix)] if t.endswith(sep + suffix) and len(t) > len(sep + suffix) else t
                    for t in titles]
        if prefix_n >= max(2, len(titles) // 2):
            return [t[len(prefix + sep):] if t.startswith(prefix + sep) and len(t) > len(prefix + sep) else t
                    for t in titles]
    return titles


def _strip_site_name(title: str, site_name: str) -> str:
    """'Pricing | Brand' -> 'Pricing' when 'Brand' is (part of) the site name."""

    site = site_name.strip().lower()
    if not site:
        return title
    for sep in _TITLE_SEPARATORS:
        if sep not in title:
            continue
        head, tail = title.rsplit(sep, 1)
        if head.strip() and tail.strip().lower() and (tail.strip().lower() in site or site in tail.strip().lower()):
            return head.strip()
        head, tail = title.split(sep, 1)
        if tail.strip() and head.strip().lower() and (head.strip().lower() in site or site in head.strip().lower()):
            return tail.strip()
    return title


def _link_text(title: str) -> str:
    return _one_line(title, 90).replace("[", "(").replace("]", ")")


def generate(site_name: str, summary: str, pages: list[dict[str, str]],
             *, max_per_section: int = 20, max_total: int = 100) -> str:
    """Build a draft llms.txt from page metadata: [{url, title, description}].

    The first page is the homepage and is always listed first under "Main pages".
    Pages in the same folder (two or more under /blog/, /docs/ ...) become a
    section; top-level pages also go under "Main pages". Page order is kept, so
    pass the most important pages first.
    """

    name = _one_line(site_name, 80) or "Website"
    summary_line = _one_line(summary, 300)
    lines = [f"# {name}", ""]
    if summary_line:
        lines += [f"> {summary_line}", ""]

    titles = _strip_common_affix([_strip_site_name(_one_line(p.get("title") or "", 200), name) for p in pages])
    repeated = {t for t, n in Counter(t.lower() for t in titles).items() if n > 1}
    entries = []
    for page, title in zip(pages, titles):
        if not title or title.lower() in repeated:
            title = _slug_title(page["url"])  # tell apart pages that share a generic title
        desc = _one_line(page.get("description") or "")
        if desc.lower() in {summary_line.lower(), title.lower()}:
            desc = ""  # repeating the site summary tells an agent nothing about the page
        entries.append({"url": page["url"], "title": title, "description": desc})

    folder_sizes = Counter(_section_key(e["url"]) for e in entries[1:])
    grouped: dict[str, list[dict[str, str]]] = {"Main pages": entries[:1]}
    for entry in entries[1:]:
        key = _section_key(entry["url"])
        section = _section_title(key) if key and folder_sizes[key] >= 2 else "Main pages"
        grouped.setdefault(section, []).append(entry)

    overflow: list[dict[str, str]] = []
    written = 0
    for section, items in grouped.items():
        if not items:
            continue
        room = min(max_per_section, max_total - written)
        if room <= 0:
            overflow.extend(items)
            continue
        lines += [f"## {section}", ""]
        for entry in items[:room]:
            lines.append(f"- [{_link_text(entry['title'])}]({entry['url']})"
                         + (f": {entry['description']}" if entry["description"] else ""))
            written += 1
        overflow.extend(items[room:])
        lines.append("")
    if overflow:
        lines += ["## Optional", ""]
        for entry in overflow[: max(0, max_total // 2)]:
            lines.append(f"- [{_link_text(entry['title'])}]({entry['url']})")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"

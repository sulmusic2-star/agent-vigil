"""Pull the products or businesses an AI answer recommends, in the order it gives them.

AI assistants answer "best X" questions with lists: numbered or bulleted items,
usually with the name in bold, or one heading per pick. This reads those lists
from the answer's Markdown. It keeps top-level items only (sub-bullets hold
details such as price or pros), turns "**Best overall:** Brooks Ghost 16" into
"Brooks Ghost 16", drops generic labels such as "Pros" or "Bottom line", and
skips list items that read as sentences rather than names.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import urlsplit

_LIST_ITEM = re.compile(r"^(?P<indent>[ \t]*)(?:[-*•+]|\d{1,2}[.)])\s+(?P<body>.+)$")
_HEADING = re.compile(r"^#{2,6}\s+(?P<body>.+?)\s*#*\s*$")
_LEADING_BOLD = re.compile(r"^(?:\*\*|__)(?P<bold>.+?)(?:\*\*|__)\s*(?P<rest>.*)$")
_ANY_BOLD = re.compile(r"(?:\*\*|__)(.+?)(?:\*\*|__)")
_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_CITATION = re.compile(r"\[\d+(?:\s*[,-]\s*\d+)*\]|【[^】]*】")
_NUMBER = re.compile(r"^(?:#\s*)?\d{1,2}[.):]\s*")
_SEPARATORS = (": ", " – ", " — ", " - ", " (", ", ", " | ", " — ")
_TRADEMARKS = str.maketrans("", "", "®™©")

# Section labels that are never a recommendation themselves.
GENERIC = frozenset({
    "pros", "cons", "pros and cons", "price", "prices", "pricing", "cost", "why", "why we like it",
    "why it stands out", "key features", "features", "highlights", "verdict", "bottom line", "summary",
    "conclusion", "overview", "tips", "tip", "note", "notes", "considerations", "things to consider",
    "how to choose", "buying guide", "what to look for", "honorable mentions", "honourable mentions",
    "alternatives", "other options", "sources", "references", "final thoughts", "recommendation",
    "recommendations", "top picks", "our picks", "quick picks", "at a glance", "comparison",
    "comparison table", "faq", "faqs", "downsides", "drawbacks", "who it's for", "best for", "specs",
    "specifications", "budget", "premium", "mid-range", "midrange", "warranty", "availability",
    "rating", "ratings", "reviews", "location", "address", "hours", "phone", "website", "services",
    "quick answer", "short answer", "tl;dr", "tldr", "in short", "more options", "also consider",
})
# Labels that introduce a pick: "Best overall: X", "Budget pick: X", "For wide feet: X".
_LABEL_START = ("best ", "top ", "budget", "premium", "runner-up", "runner up", "upgrade", "also great",
                "honorable", "honourable", "great for", "good for", "ideal for", "for ", "if you",
                "most ", "cheapest", "overall", "editor", "our pick", "pick", "value pick", "splurge")


@dataclass(frozen=True)
class Item:
    name: str
    rank: int


def normalize(name: str) -> str:
    """A key for comparing names: case, trademarks and punctuation removed."""

    text = name.translate(_TRADEMARKS).lower()
    text = re.sub(r"[^a-z0-9]+", " ", text).strip()
    return text[4:] if text.startswith("the ") else text


def _strip_markup(text: str) -> str:
    text = _LINK.sub(r"\1", text)
    text = _CITATION.sub("", text)
    text = text.replace("**", "").replace("__", "").replace("`", "")
    return re.sub(r"\s+", " ", text).strip()


def _is_label(text: str) -> bool:
    low = text.strip().rstrip(":").strip().lower()
    return low in GENERIC or low.startswith(_LABEL_START)


def _cut(text: str) -> str:
    """The part before the first separator: 'Brooks Ghost 16 – great cushioning' -> 'Brooks Ghost 16'."""

    cut = len(text)
    for sep in _SEPARATORS:
        at = text.find(sep)
        if 0 < at < cut:
            cut = at
    return text[:cut]


def _tidy(text: str) -> str:
    text = _NUMBER.sub("", _strip_markup(text))
    return text.strip(" \t*_:;,.!?-–—\"'“”‘’")


def _looks_like_name(text: str, structured: bool) -> bool:
    words = text.split()
    if not words or not any(c.isalpha() for c in text) or normalize(text) in GENERIC:
        return False
    if len(text) > 80 or len(words) > (10 if structured else 7):
        return False
    if structured:
        return True
    # A bare list line: accept title-case names ("Brooks Ghost 16"), not sentences ("Replace shoes often").
    alpha = [w for w in words if w[0].isalpha()]
    capitals = sum(1 for w in alpha if w[0].isupper() or any(c.isupper() for c in w[1:]))
    return capitals >= max(1, (len(alpha) + 1) // 2)


def _name_from(body: str) -> str | None:
    """The recommended name in one list item or heading, or None."""

    body = _NUMBER.sub("", _CITATION.sub("", body.strip()))
    bold = _LEADING_BOLD.match(body)
    if bold:
        label, rest = bold.group("bold").strip(), bold.group("rest").strip()
        if not _is_label(label):
            if label.endswith(":") and rest:
                # "**Max cushion:** Hoka Gaviota 5": a label, when a name follows it
                after = _tidy(_cut(_strip_markup(rest.lstrip(":–—- "))))
                if _looks_like_name(after, structured=False):
                    return after
            name = _tidy(_cut(label) if len(label.split()) > 10 else label)
            return name if _looks_like_name(name, structured=True) else None
        # "**Best overall:** Brooks Ghost 16 - ..." or "**Best overall** - **Brooks Ghost 16**"
        rest = rest.lstrip(":–—- ").strip()
        inner = _LEADING_BOLD.match(rest)
        candidate = inner.group("bold") if inner else _cut(rest)
        name = _tidy(candidate)
        return name if _looks_like_name(name, structured=True) else None
    plain = _strip_markup(body)
    if ": " in plain and _is_label(plain.split(": ", 1)[0]):
        plain = plain.split(": ", 1)[1]
    head = _cut(plain)
    structured = head != plain
    name = _tidy(head)
    if not name or _is_label(name):
        return None
    return name if _looks_like_name(name, structured) else None


def extract_items(text: str, limit: int = 25) -> list[Item]:
    """Recommended names in the order the answer lists them (deduplicated)."""

    list_names: list[str] = []
    heading_names: list[str] = []
    base_indent: int | None = None
    in_code = False
    for raw_line in (text or "").splitlines():
        line = raw_line.rstrip()
        if line.lstrip().startswith("```"):
            in_code = not in_code
            continue
        if in_code or not line.strip() or line.lstrip().startswith("|"):
            continue  # skip code and tables
        heading = _HEADING.match(line.strip())
        if heading:
            name = _name_from(heading.group("body"))
            if name:
                heading_names.append(name)
            continue
        item = _LIST_ITEM.match(line)
        if not item:
            continue
        indent = len(item.group("indent").expandtabs(4))
        if base_indent is None or indent < base_indent:
            base_indent = indent
        if indent > base_indent + 1:
            continue  # a sub-bullet: details, not a pick
        name = _name_from(item.group("body"))
        if name:
            list_names.append(name)
    names = list_names if len(list_names) >= 2 else heading_names if len(heading_names) >= 2 else []
    if not names:
        names = list_names or heading_names
    if not names:  # prose answers: bold names inline
        names = [n for n in (_tidy(b) for b in _ANY_BOLD.findall(text or "")) if _looks_like_name(n, True)
                 and not _is_label(n)]
    items: list[Item] = []
    seen: set[str] = set()
    for name in names:
        key = normalize(name)
        if key and key not in seen:
            seen.add(key)
            items.append(Item(name, len(items) + 1))
        if len(items) >= limit:
            break
    return items


def _brand_pattern(brand: str) -> re.Pattern[str]:
    return re.compile(r"(?<![A-Za-z0-9])" + re.escape(brand.strip()) + r"(?![A-Za-z0-9])", re.IGNORECASE)


def brand_hits(text: str, items: list[Item], brands: list[str]) -> dict[str, dict]:
    """For each brand: is it mentioned at all, and at which list position does it first appear."""

    hits = {}
    for brand in brands:
        pattern = _brand_pattern(brand)
        rank = next((item.rank for item in items if pattern.search(item.name)), None)
        hits[brand] = {"mentioned": bool(pattern.search(text or "")), "rank": rank}
    return hits


def domain_of(url_or_title: str) -> str | None:
    """'https://www.runnersworld.com/x' -> 'runnersworld.com'; a bare domain title works too."""

    value = (url_or_title or "").strip()
    host = urlsplit(value if "://" in value else "https://" + value).hostname or ""
    host = host.lower()
    if host.startswith("www."):
        host = host[4:]
    return host if "." in host and " " not in value else None

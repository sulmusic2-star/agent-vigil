"""Safe, bounded sitemap discovery.

Sitemaps are untrusted XML from arbitrary sites. Documents that declare a DOCTYPE
or entities are rejected before parsing (this blocks entity-expansion attacks),
sizes are capped, gzip is decompressed with a cap, and sitemap indexes are
followed only one level deep and only on the same host.
"""

from __future__ import annotations

import gzip
import io
import xml.etree.ElementTree as ET
from urllib.parse import urljoin

from .fetch import Fetcher, same_host

MAX_SITEMAP_BYTES = 5_000_000
MAX_CHILD_SITEMAPS = 5


def _decompress(body: bytes) -> bytes | None:
    if body[:2] != b"\x1f\x8b":
        return body
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(body)) as gz:
            data = gz.read(MAX_SITEMAP_BYTES + 1)
    except OSError:
        return None
    return data[:MAX_SITEMAP_BYTES]


def parse_sitemap(body: bytes) -> tuple[list[str], list[str]]:
    """Return (page_urls, child_sitemap_urls). Unsafe or invalid XML yields nothing."""

    data = _decompress(body)
    if not data:
        return [], []
    head = data[:4096].lower()
    if b"<!doctype" in head or b"<!entity" in data[:65536].lower():
        return [], []
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        return [], []
    tag = root.tag.rsplit("}", 1)[-1].lower()
    locs = [el.text.strip() for el in root.iter() if el.tag.rsplit("}", 1)[-1].lower() == "loc" and el.text]
    if tag == "sitemapindex":
        return [], locs
    return locs, []




async def discover_urls(fetcher: Fetcher, origin: str, robots_sitemaps: list[str],
                        limit: int = 200) -> tuple[list[str], list[str]]:
    """Collect up to `limit` page URLs. Returns (urls, sitemaps_checked)."""

    # Sitemap lines should be absolute, but relative ones are common; resolve them.
    candidates = [urljoin(origin, s) for s in robots_sitemaps if s] or [urljoin(origin, "/sitemap.xml")]
    checked: list[str] = []
    urls: list[str] = []
    queue = list(dict.fromkeys(candidates))[:MAX_CHILD_SITEMAPS]
    children_followed = 0
    while queue and len(urls) < limit:
        sitemap_url = queue.pop(0)
        if not same_host(sitemap_url, origin):
            continue
        checked.append(sitemap_url)
        resp = await fetcher.get(sitemap_url, max_bytes=MAX_SITEMAP_BYTES)
        if not resp.ok or resp.looks_like_html():
            continue
        pages, children = parse_sitemap(resp.body)
        for page in pages:
            if same_host(page, origin) and page not in urls:
                urls.append(page)
                if len(urls) >= limit:
                    break
        for child in children:
            if children_followed < MAX_CHILD_SITEMAPS:
                queue.append(child)
                children_followed += 1
    return urls, checked

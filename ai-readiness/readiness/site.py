"""Per-site context: fetch robots.txt and the homepage once, and fetch politely.

The auditor reads machine-readable files that sites publish for automated
readers (robots.txt, llms.txt, sitemaps, /.well-known files, ai.txt) directly.
HTML pages are fetched only when robots.txt allows this tool's own token
(``AIReadinessAudit``, falling back to the ``*`` group), so the auditor follows
the same rules it reports on.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from urllib.parse import urljoin, urlsplit

from . import robots as robots_mod
from .fetch import ROBOTS_TOKEN, Fetcher, Response, normalize_site
from .html_scan import PageScan, scan_html


@dataclass
class SiteContext:
    origin: str
    fetcher: Fetcher
    respect_robots: bool = True
    _robots: robots_mod.RobotsTxt | None = None
    _robots_resp: Response | None = None
    _home: Response | None = None
    _home_scan: PageScan | None = None
    _home_done: bool = False
    _home_skip: str | None = None
    notes: list[str] = field(default_factory=list)

    async def robots(self) -> robots_mod.RobotsTxt:
        if self._robots is None:
            resp = await self.fetcher.get(urljoin(self.origin, "/robots.txt"), max_bytes=robots_mod.MAX_ROBOTS_BYTES)
            self._robots_resp = resp
            self._robots = robots_mod.from_response(resp.status, resp.text if resp.ok else "", resp.error,
                                                    resp.ok and resp.looks_like_html())
        return self._robots

    async def may_fetch(self, url: str) -> bool:
        if not self.respect_robots:
            return True
        robots = await self.robots()
        parts = urlsplit(url)
        path = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
        return robots.check(ROBOTS_TOKEN, path).allowed

    async def fetch_page(self, url: str, max_bytes: int = 3_000_000) -> tuple[Response | None, str | None]:
        """Fetch an HTML page if robots.txt allows it. Returns (response, skip_reason)."""

        if not await self.may_fetch(url):
            return None, "robots.txt disallows automated fetching of this page for this tool"
        return await self.fetcher.get(url, max_bytes=max_bytes), None

    async def homepage(self) -> tuple[Response | None, PageScan | None, str | None]:
        if not self._home_done:
            self._home_done = True
            resp, skipped = await self.fetch_page(self.origin)
            if skipped:
                self._home_skip = skipped
                self.notes.append(f"homepage skipped: {skipped}")
            else:
                self._home = resp
                if resp is not None and resp.ok and not resp.error:
                    self._home_scan = scan_html(resp.text)
        if self._home_skip:
            return None, None, self._home_skip
        reason = None
        if self._home is not None and not self._home.ok:
            reason = self._home.error or f"homepage returned HTTP {self._home.status}"
        return self._home, self._home_scan, reason

    def final_origin(self) -> str:
        """The origin the homepage settled on after redirects, e.g. https://www.example.com/."""

        if self._home is not None and self._home.ok:
            moved = normalize_site(self._home.final_url)
            if moved:
                return moved
        return self.origin

    def moved_to(self, origin: str) -> SiteContext:
        """A context for the site the homepage redirected to, keeping what was already fetched.

        robots.txt is reused only if it also ended up on that site; otherwise the
        new site's own robots.txt is fetched when first needed.
        """

        moved = SiteContext(origin, self.fetcher, self.respect_robots, notes=list(self.notes))
        moved._home, moved._home_scan, moved._home_skip = self._home, self._home_scan, self._home_skip
        moved._home_done = self._home_done
        if self._robots_resp is not None and normalize_site(self._robots_resp.final_url) == origin:
            moved._robots, moved._robots_resp = self._robots, self._robots_resp
        moved.notes.append(f"{self.origin} redirects to {origin}; checked {origin}")
        return moved

"""HTTP fetching with hard limits, plus an in-memory fetcher for tests.

Every request is bounded in time and size so a single slow or huge site cannot
stall a bulk run or inflate its cost. The auditor identifies itself with a clear
user agent. Network failures are returned as data (``error``), never raised, so
one broken site only affects its own result.
"""

from __future__ import annotations

import asyncio
import ipaddress
import re
from dataclasses import dataclass, field
from typing import Protocol
from urllib.parse import urlsplit, urlunsplit

USER_AGENT = "AIReadinessAudit/0.1 (+https://github.com/sulmusic2-star/agent-vigil/tree/main/ai-readiness)"
ROBOTS_TOKEN = "AIReadinessAudit"

DEFAULT_TIMEOUT = 15.0
DEFAULT_MAX_BYTES = 2_000_000


@dataclass
class Response:
    url: str
    final_url: str
    status: int | None
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes = b""
    error: str | None = None
    truncated: bool = False

    @property
    def ok(self) -> bool:
        return self.error is None and self.status is not None and 200 <= self.status < 300

    @property
    def content_type(self) -> str:
        return self.headers.get("content-type", "").split(";")[0].strip().lower()

    @property
    def text(self) -> str:
        charset = "utf-8"
        raw_type = self.headers.get("content-type", "")
        for part in raw_type.split(";")[1:]:
            key, _, value = part.strip().partition("=")
            if key.lower() == "charset" and value:
                charset = value.strip("\"' ")
        try:
            return self.body.decode(charset, errors="replace")
        except LookupError:
            return self.body.decode("utf-8", errors="replace")

    def looks_like_html(self) -> bool:
        """True when a response is an HTML page, e.g. a single-page-app fallback."""

        if self.content_type in {"text/html", "application/xhtml+xml"}:
            return True
        head = self.body[:512].lstrip().lower()
        return head.startswith(b"<!doctype html") or head.startswith(b"<html")


class Fetcher(Protocol):
    async def get(self, url: str, *, max_bytes: int = DEFAULT_MAX_BYTES) -> Response: ...


_LABEL = re.compile(r"^(?!-)[a-z0-9_-]{1,63}(?<!-)$")


def valid_host(host: str | None) -> bool:
    """True for a DNS name with a dot (or localhost) or an IP literal: not 'not a url'."""

    if not host or len(host) > 253:
        return False
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        pass
    try:
        ascii_host = host.encode("idna").decode("ascii").lower().rstrip(".")
    except UnicodeError:
        return False
    labels = ascii_host.split(".")
    return (len(labels) > 1 or ascii_host == "localhost") and all(_LABEL.match(label) for label in labels)


def _split(value: str):
    text = (value or "").strip()
    if not text:
        return None
    if "://" not in text:
        text = "https://" + text
    try:
        parts = urlsplit(text)
        parts.port  # raises ValueError for a malformed port
    except ValueError:
        return None
    if parts.scheme not in {"http", "https"} or not valid_host(parts.hostname):
        return None
    return parts


def _netloc(parts) -> str:
    """Host and non-default port, without any user:password@ part."""

    host = parts.hostname.lower()
    if ":" in host:  # IPv6 literal
        host = f"[{host}]"
    default = 443 if parts.scheme == "https" else 80
    return f"{host}:{parts.port}" if parts.port and parts.port != default else host


def same_host(url: str, origin: str) -> bool:
    """Same host, treating example.com and www.example.com as one site."""

    a, b = urlsplit(url).hostname or "", urlsplit(origin).hostname or ""
    return bool(a) and (a == b or a == "www." + b or b == "www." + a)


def normalize_site(value: str) -> str | None:
    """Turn 'example.com', 'https://example.com/path' etc. into an origin URL."""

    parts = _split(value)
    if parts is None:
        return None
    return urlunsplit((parts.scheme, _netloc(parts), "/", "", ""))


def normalize_page(value: str) -> str | None:
    """Keep the full page URL (path and query) but require http(s) and a valid host."""

    parts = _split(value)
    if parts is None:
        return None
    return urlunsplit((parts.scheme, _netloc(parts), parts.path or "/", parts.query, ""))


class HttpxFetcher:
    """Real fetcher built on httpx. Create once per run and close when done."""

    def __init__(self, timeout: float = DEFAULT_TIMEOUT, max_concurrency: int = 20) -> None:
        import httpx  # imported lazily so the engine imports without httpx

        self._httpx = httpx
        self._client = httpx.AsyncClient(
            follow_redirects=True,
            max_redirects=5,
            timeout=httpx.Timeout(timeout),
            headers={"User-Agent": USER_AGENT, "Accept": "*/*"},
        )
        self._slots = asyncio.Semaphore(max_concurrency)

    async def get(self, url: str, *, max_bytes: int = DEFAULT_MAX_BYTES) -> Response:
        async with self._slots:
            try:
                async with self._client.stream("GET", url) as resp:
                    chunks: list[bytes] = []
                    size = 0
                    truncated = False
                    async for chunk in resp.aiter_bytes():
                        size += len(chunk)
                        if size > max_bytes:
                            chunks.append(chunk[: max(0, len(chunk) - (size - max_bytes))])
                            truncated = True
                            break
                        chunks.append(chunk)
                    headers = {k.lower(): v for k, v in resp.headers.items()}
                    return Response(url=url, final_url=str(resp.url), status=resp.status_code,
                                    headers=headers, body=b"".join(chunks), truncated=truncated)
            except self._httpx.HTTPError as exc:
                return Response(url=url, final_url=url, status=None, error=f"{type(exc).__name__}: {exc}")
            except Exception as exc:  # defensive: never let one site crash a run
                return Response(url=url, final_url=url, status=None, error=f"{type(exc).__name__}: {exc}")

    async def aclose(self) -> None:
        await self._client.aclose()


class FakeFetcher:
    """Serves canned responses by URL for offline tests. Unknown URLs return 404.

    ``redirects`` maps a URL to the URL it redirects to; like the real fetcher,
    redirects are followed and the response reports the final URL.
    """

    def __init__(self, pages: dict[str, tuple[int, str, str | bytes]] | None = None,
                 redirects: dict[str, str] | None = None) -> None:
        # url -> (status, content_type, body)
        self.pages = pages or {}
        self.redirects = redirects or {}
        self.requested: list[str] = []

    async def get(self, url: str, *, max_bytes: int = DEFAULT_MAX_BYTES) -> Response:
        self.requested.append(url)
        final = url
        for _ in range(5):
            if final not in self.redirects:
                break
            final = self.redirects[final]
        if final not in self.pages:
            return Response(url=url, final_url=final, status=404, headers={"content-type": "text/plain"}, body=b"not found")
        status, ctype, body = self.pages[final]
        data = body.encode("utf-8") if isinstance(body, str) else body
        if status == 0:
            return Response(url=url, final_url=url, status=None, error="ConnectError: simulated")
        return Response(url=url, final_url=final, status=status, headers={"content-type": ctype},
                        body=data[:max_bytes], truncated=len(data) > max_bytes)

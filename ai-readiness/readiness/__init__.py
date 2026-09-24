"""AI readiness checks for websites.

A small, dependency-light engine that answers practical questions about a site:

* Which AI crawlers and AI agents may fetch it, according to robots.txt, Content
  Signals, meta robots, X-Robots-Tag, and TDMRep?
* Does it publish a valid llms.txt, and what would a good one look like?
* Does it expose tools to AI agents through WebMCP, and are they well described?
* Does it publish agent discovery files and structured data that AI shopping and
  answer engines rely on?

Everything here is standards-based (RFC 9309, llmstxt.org, the W3C WebMCP draft,
schema.org, TDMRep), so checks keep working when a site changes its design. The
engine never collects personal data: it reads public, machine-readable files and
page metadata only.
"""

__version__ = "0.1.0"

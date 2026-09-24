"""llms.txt validation/generation, structured data, and WebMCP detection."""

from readiness import llms_txt, structured_data, webmcp
from readiness.html_scan import scan_html

GOOD = """# Example Docs

> Guides and API reference for Example.

Some detail text.

## Guides

- [Quickstart](https://example.com/start): get going in 5 minutes
- [Auth](https://example.com/auth)

## Optional

- [Changelog](https://example.com/changelog)
"""


def _errors(report):
    return [i.message for i in report.issues if i.severity == "error"]


def test_valid_llms_txt():
    r = llms_txt.validate(GOOD)
    assert r.valid and r.title == "Example Docs"
    assert r.summary == "Guides and API reference for Example."
    assert [s.name for s in r.sections] == ["Guides", "Optional"]
    assert r.link_count == 3
    assert any("Optional" in i.message for i in r.issues if i.severity == "info")


def test_missing_h1_is_an_error():
    r = llms_txt.validate("## Guides\n\n- [A](https://a.com)\n")
    assert not r.valid and _errors(r)


def test_html_fallback_is_not_llms_txt():
    r = llms_txt.validate("<!doctype html>", served_as_html=True)
    assert not r.present and not r.valid


def test_structure_warnings():
    text = "# T\n\n## S\n\nplain text\n- not a link\n- [A](/rel)\n- [A](/rel)\n### Deep\n"
    r = llms_txt.validate(text)
    messages = " ".join(i.message for i in r.issues)
    assert "no blockquote summary" in messages
    assert "plain text inside link sections" in messages
    assert "without a markdown link" in messages
    assert "duplicate link(s), for example /rel" in messages
    assert "H3" in messages
    assert "relative link" in messages
    assert r.valid  # warnings only


def test_repeated_problems_are_grouped_with_counts_and_lines():
    # Shaped like real docs-site files: subheadings, ' - ' notes, prose in sections.
    body = "\n".join(f"### Group {g}\n\n" + "\n".join(
        f"- [Page {g}.{i}](https://d.example/{g}/{i}.md) - about page {i}" for i in range(20)) for g in range(8))
    text = "# Docs\n\nIntro paragraph.\n\n## Root URL\n\nhttps://d.example\n\n---\n\n## English\n\n" + body + "\n"
    r = llms_txt.validate(text)
    assert r.valid and r.link_count == 160
    assert r.sections[1].links[0]["notes"] == "about page 0"  # notes after ' - ' are still read
    sub = next(i for i in r.issues if "H3" in i.message)
    sep = next(i for i in r.issues if "notes after" in i.message)
    assert sub.count == 8 and sub.severity == "info" and len(sub.lines) == 8
    assert sep.count == 160 and len(sep.lines) == llms_txt.MAX_LINES_LISTED
    assert sum(i.severity == "warning" for i in r.issues) <= 3  # short list, not 170 lines of noise
    assert all(set(i.as_dict()) == {"severity", "message", "count", "lines"} for i in r.issues)


def test_generated_llms_txt_is_valid_and_grouped():
    pages = [{"url": "https://s.com/", "title": "Home", "description": "Welcome"}]
    pages += [{"url": f"https://s.com/blog/post-{i}", "title": f"Post [{i}]", "description": ""} for i in range(30)]
    pages += [{"url": "https://s.com/pricing", "title": "Pricing", "description": "Plans"}]
    text = llms_txt.generate("S Site", "A site.", pages, max_per_section=20, max_total=40)
    report = llms_txt.validate(text)
    assert report.valid, report.issues
    names = [s.name for s in report.sections]
    assert names == ["Main pages", "Blog", "Optional"]  # a lone top-level page is not its own section
    assert "- [Pricing](https://s.com/pricing): Plans" in text.split("## Blog")[0]
    assert "Post (1)" in text  # brackets in titles are made link-safe


def test_generator_cleans_titles_descriptions_and_groups_by_folder():
    pages = [{"url": "https://s.com/", "title": "Home", "description": "Trail shoes."},
             {"url": "https://s.com/en/docs/start", "title": "Start here | S Docs", "description": "Trail shoes."},
             {"url": "https://s.com/en/docs/api", "title": "API reference | S Docs", "description": "Every endpoint."},
             {"url": "https://s.com/playground", "title": "Documentation | S Docs", "description": ""},
             {"url": "https://s.com/support", "title": "Documentation | S Docs", "description": ""}]
    text = llms_txt.generate("S", "Trail shoes.", pages)
    assert "## Docs" in text  # /en/docs/... grouped by folder, language prefix ignored
    assert "- [Start here](https://s.com/en/docs/start)\n" in text  # suffix and repeated summary dropped
    assert "- [API reference](https://s.com/en/docs/api): Every endpoint." in text
    assert "- [Playground](https://s.com/playground)" in text and "- [Support](https://s.com/support)" in text
    assert "- [Home](https://s.com/)\n" in text
    assert llms_txt.validate(text).valid


def test_generator_drops_site_name_from_titles_and_lists_home_first():
    pages = [{"url": "https://d.com/docs/en/home", "title": "Home", "description": ""},
             {"url": "https://d.com/docs/en/intro", "title": "Intro", "description": ""},
             {"url": "https://d.com/docs/en/api", "title": "API", "description": ""},
             {"url": "https://d.com/playground", "title": "Playground | D Platform", "description": ""}]
    text = llms_txt.generate("D Platform Docs", "", pages)
    assert text.index("[Home]") < text.index("## Docs")  # homepage stays under Main pages
    assert "- [Playground](https://d.com/playground)" in text


def test_json_ld_graph_and_errors():
    blocks = [
        '{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"A"},{"@type":"WebSite","name":"A"}]}',
        "<!--{\"@type\": \"BreadcrumbList\"}-->",
        "{not json",
    ]
    data = structured_data.extract(blocks)
    assert data.types == ["Organization", "WebSite", "BreadcrumbList"]
    assert data.parse_errors == 1


def test_product_completeness():
    full = {
        "@type": "Product", "name": "X", "image": "x.jpg", "description": "d", "brand": {"name": "B"},
        "gtin13": "0123456789012", "aggregateRating": {"ratingValue": 4.5}, "review": [{"reviewBody": "ok"}],
        "offers": {"@type": "Offer", "price": "10", "priceCurrency": "USD", "availability": "InStock",
                   "url": "https://s.com/x", "shippingDetails": {}, "hasMerchantReturnPolicy": {"x": 1}},
    }
    # shippingDetails is an empty dict here, so it must count as missing
    check = structured_data.check_product(full)
    assert check.missing == ["shipping details"] and 90 <= check.score < 100
    sparse = structured_data.check_product({"@type": "Product", "name": "Y",
                                            "offers": {"@type": "AggregateOffer", "lowPrice": "5"}})
    assert "price currency" in sparse.missing and "offers.price" in sparse.present


def test_declarative_webmcp_tools():
    html = """<form toolname="book_table" tooldescription="Book a table at the restaurant for a date and party size">
      <input name="date" toolparamdescription="Date, YYYY-MM-DD"><input name="party"><input type="submit"></form>
      <form><input name="newsletter"></form>"""
    report = webmcp.analyze(scan_html(html), final_url="https://r.example/")
    assert len(report.declarative_tools) == 1 and report.has_tools
    tool = report.declarative_tools[0]
    assert tool.name == "book_table" and tool.params == 2 and tool.params_described == 1
    assert any("lack toolparamdescription" in i for i in tool.issues)


def test_imperative_webmcp_evidence_and_insecure_context():
    html = """<script>document.modelContext.registerTool({ name: "add_to_cart", description: "Add item",
      execute: () => {} });</script>"""
    report = webmcp.analyze(scan_html(html), final_url="http://shop.example/")
    assert report.imperative_api_detected and report.imperative_tool_names == ["add_to_cart"]
    assert any("HTTPS" in i for i in report.issues)


def test_no_webmcp_on_plain_page():
    report = webmcp.analyze(scan_html("<form><input name=q></form><script>var a=1;</script>"),
                            final_url="https://x.example/")
    assert not report.has_tools and report.scripts_scanned == 1

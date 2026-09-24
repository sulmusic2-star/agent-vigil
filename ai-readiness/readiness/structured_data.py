"""schema.org JSON-LD extraction and product-data completeness.

AI answer engines and shopping agents lean on structured data to understand a
page without guessing. This module flattens JSON-LD (including @graph and nested
entities), lists the types present, and scores Product entities against the
fields an agent needs to recommend or buy an item.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Iterator

IDENTIFIER_KEYS = ("gtin", "gtin8", "gtin12", "gtin13", "gtin14", "mpn", "sku", "isbn")

# field -> (weight, plain-language reason)
PRODUCT_FIELDS: dict[str, tuple[int, str]] = {
    "name": (10, "product name"),
    "image": (8, "product image"),
    "description": (6, "product description"),
    "brand": (6, "brand"),
    "identifier": (10, "a product identifier (GTIN, MPN or SKU)"),
    "offers.price": (14, "price"),
    "offers.priceCurrency": (8, "price currency"),
    "offers.availability": (10, "stock availability"),
    "offers.url": (4, "offer URL"),
    "aggregateRating": (8, "aggregate rating"),
    "review": (4, "at least one review"),
    "offers.shippingDetails": (6, "shipping details"),
    "offers.hasMerchantReturnPolicy": (6, "return policy"),
}


@dataclass
class StructuredData:
    types: list[str] = field(default_factory=list)
    entities: list[dict[str, Any]] = field(default_factory=list)
    parse_errors: int = 0


@dataclass
class ProductCheck:
    name: str | None
    score: int                      # 0-100 weighted completeness
    present: list[str]
    missing: list[str]              # plain-language descriptions


def _clean_json_text(text: str) -> str:
    stripped = text.strip()
    for prefix, suffix in (("<!--", "-->"), ("<![CDATA[", "]]>"), ("//<![CDATA[", "//]]>")):
        if stripped.startswith(prefix) and stripped.endswith(suffix):
            stripped = stripped[len(prefix):-len(suffix)].strip()
    return stripped


def _walk(node: Any) -> Iterator[dict[str, Any]]:
    if isinstance(node, list):
        for item in node:
            yield from _walk(item)
    elif isinstance(node, dict):
        if "@type" in node:
            yield node
        for key, value in node.items():
            if key == "@context":
                continue
            if isinstance(value, (dict, list)):
                yield from _walk(value)


def _types_of(entity: dict[str, Any]) -> list[str]:
    raw = entity.get("@type")
    values = raw if isinstance(raw, list) else [raw]
    out = []
    for value in values:
        if isinstance(value, str) and value:
            out.append(value.rsplit("/", 1)[-1].rsplit(":", 1)[-1])
    return out


def extract(json_ld_blocks: list[str]) -> StructuredData:
    data = StructuredData()
    seen_types: list[str] = []
    for block in json_ld_blocks:
        text = _clean_json_text(block)
        if not text:
            continue
        try:
            parsed = json.loads(text)
        except (ValueError, RecursionError):
            data.parse_errors += 1
            continue
        for entity in _walk(parsed):
            data.entities.append(entity)
            for t in _types_of(entity):
                if t not in seen_types:
                    seen_types.append(t)
    data.types = seen_types
    return data


def _first_offer(product: dict[str, Any]) -> dict[str, Any]:
    offers = product.get("offers")
    if isinstance(offers, list):
        offers = offers[0] if offers else None
    return offers if isinstance(offers, dict) else {}


def _has(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, dict)):
        return len(value) > 0
    return True


def check_product(product: dict[str, Any]) -> ProductCheck:
    offer = _first_offer(product)
    price_ok = _has(offer.get("price")) or _has(offer.get("lowPrice"))
    checks = {
        "name": _has(product.get("name")),
        "image": _has(product.get("image")),
        "description": _has(product.get("description")),
        "brand": _has(product.get("brand")),
        "identifier": any(_has(product.get(k)) or _has(offer.get(k)) for k in IDENTIFIER_KEYS),
        "offers.price": price_ok,
        "offers.priceCurrency": _has(offer.get("priceCurrency")),
        "offers.availability": _has(offer.get("availability")),
        "offers.url": _has(offer.get("url")) or _has(product.get("url")),
        "aggregateRating": _has(product.get("aggregateRating")),
        "review": _has(product.get("review")),
        "offers.shippingDetails": _has(offer.get("shippingDetails")) or _has(product.get("shippingDetails")),
        "offers.hasMerchantReturnPolicy": _has(offer.get("hasMerchantReturnPolicy")) or _has(product.get("hasMerchantReturnPolicy")),
    }
    total = sum(weight for weight, _ in PRODUCT_FIELDS.values())
    earned = sum(PRODUCT_FIELDS[key][0] for key, ok in checks.items() if ok)
    present = [key for key, ok in checks.items() if ok]
    missing = [PRODUCT_FIELDS[key][1] for key, ok in checks.items() if not ok]
    name = product.get("name") if isinstance(product.get("name"), str) else None
    return ProductCheck(name=name, score=round(100 * earned / total), present=present, missing=missing)


def products_in(data: StructuredData) -> list[dict[str, Any]]:
    return [e for e in data.entities if "Product" in _types_of(e) or "ProductGroup" in _types_of(e)]

# Product Schema Checker for AI Shopping

Check product pages for the structured data that **AI shopping assistants and agents** use to understand, compare and recommend products. Each page gets a score from 0 to 100 and the exact fields to add.

## What it checks

It reads the page's schema.org **Product** JSON-LD (including `@graph` and nested entities) and scores it on the fields agents need:

| Field | Weight |
|---|---|
| Price | 14 |
| Product name | 10 |
| Product identifier (GTIN, MPN or SKU) | 10 |
| Stock availability | 10 |
| Image | 8 |
| Price currency | 8 |
| Aggregate rating | 8 |
| Description | 6 |
| Brand | 6 |
| Shipping details | 6 |
| Return policy | 6 |
| Offer URL | 4 |
| At least one review | 4 |

`Offer` and `AggregateOffer` are both understood. The result also reports JSON-LD syntax errors, all schema.org types on the page, and whether Open Graph marks the page as a product.

## Input

```json
{
  "productUrls": [
    "https://www.allbirds.com/products/mens-tree-runners",
    "https://www.patagonia.com/product/mens-better-sweater-fleece-jacket/25528.html"
  ]
}
```

## Output (one item per product page)

```json
{
  "url": "https://shop.example/products/trail-runner-x",
  "productsFound": 1,
  "score": 66,
  "productName": "Trail Runner X",
  "missing": ["product description", "offer URL", "aggregate rating", "at least one review", "shipping details", "return policy"],
  "jsonLdErrors": 0,
  "types": ["Product", "Brand", "Offer"],
  "openGraphProduct": true,
  "fixes": ["Add product description to the Product JSON-LD", "Add offer URL to the Product JSON-LD"]
}
```

## Monitor on a schedule

Turn on **Report changes since the last run** and schedule it to catch a theme update or app change that silently drops price or availability from your product data.

## Pricing

You pay per product page checked. Pages that return an error (such as 404), pages robots.txt asks this tool not to fetch, and sites that don't respond are **not** charged. See the Pricing tab for the current price.

## Good to know

- The checker reads JSON-LD in the page's HTML. Product data injected later by JavaScript is not seen, and neither do many AI crawlers that don't run scripts.
- It fetches pages only when robots.txt allows the `AIReadinessAudit` token (falling back to `*`).
- The weights reflect what shopping agents commonly need; they are not an official Google or OpenAI standard.

# Public release review

The automated gate catches repeatable mistakes. It is not a human reviewer and
must not be described as one.

Run:

```bash
npm run review:public
```

## What the automated gate checks

- package versions match across the CLI, README, and installation page;
- public entry points do not contain internal planning or revenue language;
- local links resolve, images have alt text, and iframes have titles;
- the landing page uses a reading font for prose and monospace only for code;
- body type is at least 17 pixels, running text is limited to 68 characters, and
  the page guards against horizontal overflow;
- rendered examples do not use the common generated-template defaults that were
  removed in this release: decorative gradients, pill labels, soft box shadows,
  or Inter as a default typeface;
- visible web copy avoids long sentences and em dashes.

## What a person still needs to decide

A named reviewer should answer these questions on the pull request:

- Can you tell what Agent Vigil does after reading the first screen once?
- Does each technical term help the reader make a decision?
- Does every number link to a method, case, or result that supports it?
- Do the calls to action say what will happen next?
- Are limits placed beside the claim they qualify?
- Is prose comfortable to read at 320, 375, 414, 768, and 1440 pixels wide?
- Is any text clipped, too thin, too small, or set in monospace without a reason?
- Does the page feel specific to Agent Vigil rather than assembled from a SaaS
  landing-page template?
- Would you approve this wording and layout under your own name?

Record the reviewer, date, decision, and any requested changes in the pull
request. Do not put a permanent "approved" claim in this repository; approval
belongs to one exact revision.

## Research used for the gate

The [U.S. Web Design System typography guidance](https://designsystem.digital.gov/components/typography/)
recommends comfortable body type, left-aligned text, a 45-to-90-character line
length, and at least 1.5 line height for running text. The
[ONS plain-language guide](https://service-manual.ons.gov.uk/content/writing-for-users/plain-language)
recommends short sentences, task-focused headings, and verb-led actions. The
[GOV.UK functional standards writing guide](https://www.gov.uk/government/publications/handbook-for-standard-managers/functional-standards-writing-style-guide)
adds one idea per sentence, present tense, and less jargon.

Community feedback was treated as anecdotal design input, not measured fact.
Recent web-design threads repeatedly objected to all-monospace pages, default
Inter, gradients, pills, equal card grids, oversized headings, and copy that
could describe any product: [June 2026 discussion](https://www.reddit.com/r/webdesign/comments/1uhuovu/preventing_the_ai_slop_look/),
[June 2026 site review](https://www.reddit.com/r/webdesign/comments/1twmqmn/website_was_called_generic_how_to_improve/), and
[August 2026 discussion](https://www.reddit.com/r/webdesign/comments/1vtb5bw/removed/).
The gate checks the repeatable parts. A person still judges purpose, tone, and
whether the design fits Agent Vigil.

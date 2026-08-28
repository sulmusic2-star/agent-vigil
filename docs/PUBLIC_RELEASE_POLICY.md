# Public release policy

`npm run review:public` is Agent Vigil's repeatable approval gate for public
wording and web files. Exit code 0 permits the automated policy check. Any
listed failure blocks it. Agent Vigil does not require a person to claim they
reviewed or approved the page.

## Checks

- The source package version and latest public GitHub release match.
- Public installation commands identify the immutable release asset and its
  verified SHA-256 digest.
- GitHub release and npm registry states remain separate.
- Dated, locally validated test counts agree across the README, compatibility
  report, and landing page. They are not labeled as hosted or released proof.
- Every repository `init` and `protect` example supplies a reviewed full Action
  commit. Candidate attestation, repository-owned merge-queue enforcement, and
  plain job-name enforcement are not presented as supported security controls.
- The generated hosted Linux/Node boundary and the broader unsandboxed local CLI
  are described separately.
- The first screen names the product, the merge decision, the exact-commit
  check, and the missing-evidence behavior.
- Public entry points contain no internal planning or revenue language.
- Local links resolve. Images have alt text. Iframes have titles.
- Action labels describe what happens next instead of saying `click here`,
  `learn more`, `get started`, or `submit`.
- The landing page uses a reading font for prose and monospace only for code.
- Body type is at least 17 pixels. Running text is limited to 68 characters.
  The page has an explicit horizontal-overflow guard.
- Rendered examples avoid the template defaults removed in this release:
  decorative gradients, pill labels, soft box shadows, and Inter as the default
  typeface.
- Visible web copy contains no em dashes or sentences longer than 35 words.

Run the gate from the repository root:

```bash
npm run review:public
```

## Boundary

A passing result proves only the rules above for one revision. It does not prove
that every reader will like the design, that every statement is substantively
correct, or that legal and security decisions have been made. Those claims need
their own evidence. This policy removes a ceremonial human checkbox; it does not
turn automation into human judgment.

## Basis for the rules

The [U.S. Web Design System typography guidance](https://designsystem.digital.gov/components/typography/)
recommends comfortable body type, left-aligned text, a 45-to-90-character line
length, and at least 1.5 line height for running text. The
[ONS plain-language guide](https://service-manual.ons.gov.uk/content/writing-for-users/plain-language)
recommends short sentences, task-focused headings, and verb-led actions. The
[GOV.UK functional standards writing guide](https://www.gov.uk/government/publications/handbook-for-standard-managers/functional-standards-writing-style-guide)
recommends one idea per sentence, present tense, and less jargon.

Community feedback was used as anecdotal design input rather than measured
fact. Recent web-design threads objected to all-monospace pages, default Inter,
gradients, pills, equal card grids, oversized headings, and copy that could
describe any product: [June 2026 discussion](https://www.reddit.com/r/webdesign/comments/1uhuovu/preventing_the_ai_slop_look/),
[June 2026 site review](https://www.reddit.com/r/webdesign/comments/1twmqmn/website_was_called_generic_how_to_improve/), and
[August 2026 discussion](https://www.reddit.com/r/webdesign/comments/1vtb5bw/removed/).

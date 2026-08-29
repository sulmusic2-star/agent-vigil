# Fourteen-day outside-use experiment

**Window:** 2026-08-28 through 2026-09-10, inclusive
**State at start:** public distribution, zero verified outside installations, zero payments, and zero revenue.

## Question

Will maintainers who encounter Agent Vigil through its public repository or shared PR cards install and retain the check without direct sales outreach?

The public checker is the entry point. It observes a public pull request without a login or repository permission. Its setup handoff copies exact v0.22.0 commands labeled for the checked repository. The optional registration form requires a maintainer to provide evidence and consent.

## Starting measurements

The GitHub owner traffic snapshot on 2026-08-28 reported 60 views from 17 unique visitors and 2,450 clones from 334 unique cloners over the available 14-day window. GitHub traffic does not identify people, intent, successful setup, or retained use; clones may include bots, CI, mirrors, and repeated automation. The public adoption census found zero configured external repositories.

## Measurements that count

- An **external configured repository** has a public workflow that actually invokes Agent Vigil.
- **Repeat use** requires at least two currently observable workflow runs.
- **Seven-day retention** requires observable activity at least seven days apart during this experiment; it is not the existing 30-day retention milestone.
- A **maintainer-accepted block** requires a public receipt or run plus the maintainer's recorded disposition.
- A **required check** counts only with owner evidence of an external required-workflow ruleset or an App-owned exact-head check. A required job name by itself does not count.

Page views, clones, stars, mentions, browser receipts, submitted forms without workflow evidence, first-party repositories, payments, and revenue are recorded separately.

## Success gate

By the end of the window:

1. three externally owned repositories have a configured Agent Vigil workflow;
2. one repository has observable activity at least seven days apart;
3. one maintainer records a useful accepted block; and
4. one repository supplies valid owner evidence that the check is enforced through an external required workflow or App-owned exact-head check.

The fourth condition may remain zero because Agent Vigil does not currently operate a public Notary App. It cannot be satisfied by relabeling an ordinary GitHub Actions job.

## Decision

- If no outside repository configures the workflow, change the entry-page wording and supported-repository path before adding detectors.
- If repositories configure it but do not run it again, investigate setup friction and false or inconclusive results.
- If maintainers retain it and request centralized enforcement, reconsider the current gate against building the hosted Notary App.
- Do not describe traffic, a submitted form, or a passing first-party run as adoption, payment, revenue, or market validation.

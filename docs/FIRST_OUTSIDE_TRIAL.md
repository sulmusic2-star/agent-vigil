# The first outside trial

**Not open yet.** The current release has a
[confirmed false PASS](../proof/cases/04-mixed-change-false-pass.md). Do not invite
someone to depend on the check until the fixed release passes that staging case.

We have no outside users or agreed trials. Our own lab does not change that count.

## The offer

Find out whether a pull request made its tests easier to pass instead of fixing
the code. Keep the tests and CI you already use. Start with one repository and
read the result in the pull request; no transcript upload or dashboard required.

Start with a Node.js repository that already runs `node --test` and receives
AI-assisted changes. That is the environment of the reproduced failure, not a
claim that every supported language has equivalent protection.

## Before accepting a trial

- The good example passes and the broken example fails in the staging App.
- npm, the Action, the installation guide, and retained receipts identify the fix.
- A fresh packed installation works without a publisher's npm login.
- The maintainer can remove the check without contacting us.
- No one is asked to deploy a Worker, create signing keys, or run our service.

The managed App is not publicly activated. Do not advertise an installation link
until that service and its permission flow have been tested end to end.

## What to ask the first maintainer

1. Could you install it? How long did it take, and where did you get stuck?
2. Was the first result useful or confusing?
3. Did it catch a real problem, raise a false alarm, or check nothing relevant?
4. Would you keep it enabled? Why or why not?

A failed installation is useful feedback. Do not call it an active installation.
Request a public workflow or receipt link only with the maintainer's permission.
Never ask for private source, logs, credentials, or a testimonial in a public issue.

## What counts

Count an independently owned repository only after its maintainer agrees to use
it and a real run is visible with permission. Record configured, running,
retained, and required-check use separately. A first-day trial is not retention;
an accepted catch is not a paid customer.

Do not sell a dashboard or promise enterprise features yet. If several retained
users independently ask to manage checks across repositories, test a paid
management offer with those users. Record actual payments and renewals, not
estimates, as commercial evidence.

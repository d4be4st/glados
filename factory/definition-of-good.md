# Definition of Good

The judgment bar for reviewers and the judge. Hooks check the Definition of Done; this is what a hook cannot check.
The coder does not read this file.

1. Smallest diff that solves the task. No speculative abstraction, no config for a value that never changes, no scaffolding for later.
2. Root cause, not symptom: the fix sits in the shared function, and every caller of the touched function was grepped.
3. Zero new code comments. Reviewer-facing explanation belongs in `.review.json`.
4. Repo conventions and repo knowledge win over personal taste. Cite the CLAUDE.md line or knowledge doc when flagging.
5. Every acceptance criterion has a test or live evidence; a spec that sets state by hand does not count.
6. Non-trivial logic (a branch, a loop, a parser, a money or security path) leaves one runnable check behind.

Not findings: style the linter already enforces, "I would do it differently", hypotheticals without an execution path.

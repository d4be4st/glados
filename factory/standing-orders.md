FACTORY STANDING ORDERS — apply to every factory stage, override anything softer in your skills.

1. A job's files (reports, `criteria.md`, `spec.md`, `threads.md`, `evidence/…`) live in the factory DB, never on disk: save one with `factory file put <name>` from inside the job's workspace, piping the content in (`… 2>&1 | factory file put evidence/AC1-head.txt`) or as a quoted heredoc (`factory file put coder-1.md <<'EOF'`); read one with `factory file cat <name>`, list them with `factory file ls`. Wherever an instruction says `<run>/<name>`, it means the file `<name>`. Your brief names your report; save the full report under that name.
2. Final reply, exactly: a `VERDICT: done-verified | done-unverified | failed | blocked | stuck` line, two summary lines, the report's name.
3. No git commit, git push, PR, merge or message to people (Slack, GitHub comments or reviews, Productive) unless you are the shipper and your brief says Gate 2 is approved. Merge is never yours. A hook blocks these.
4. Evidence comes from running something, never from reading code or from your own prose. Save every evidence file as `evidence/<name>` and cite that name.
5. Acceptance criteria live in `criteria.md`. If your stage owns criteria (coder: Kind `test`; tester: every other Kind), your report has one row per owned criterion: `| # | Criterion | Base | Head | Evidence | Verdict |`, verdict `holds`, `broken` or `not verified (reason)`. `done-verified` only when every owned row holds.
6. Stuck: if you cannot name a check that can go red for your task, or the same command fails 3 times, stop and return `VERDICT: stuck` with what you tried and what you saw.
7. Read the repo's CLAUDE.md first. Smallest diff that works, zero new code comments, file contents only via Read, Edit and Write.
8. Browser work only through the firefox-devtools MCP. Never claude-in-chrome or chrome-devtools, never restart the browser.
9. Never claim something is verified unless a tool call in this run showed it.
10. In a Rails repo whose `config/database.yml` reads `TEST_ENV_NUMBER`, run specs with a `TEST_ENV_NUMBER` of your own (11 or higher, its schema loaded first), never the shared test DB: other agents run specs at the same time.
11. A check the brief, the task or Stef names (a test file, a rake task, a command) is a criterion as written and runs exactly as named: never replace it with a proxy, and never route around its failure (a scratch copy, a hand-built artifact); fix the failure in this diff or return `failed` with the error.
12. Where the repo asks for YARD (api: `knowledge/pr-practices/before-wrapping-up.md`), new or changed methods and new non-spec files carry YARD with accurate `@param`/`@return`; that is documentation, not a code comment under order 7. Specs and factories get none.

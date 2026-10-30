# glados

A personal software factory built on Claude Code. One lead agent per job runs the whole recipe itself (triage, spec, code, ship) and only hands work to a sub-agent when a separate context pays for itself: an independent review, a live test, a hard call. A Postgres event log keeps track of where every job stands, a scheduler polls GitHub, deploys and Bugsnag, and a TUI/web dash shows what needs a human.

This is a read-only snapshot of a private setup, copied over from time to time. It is wired to one person's machines and tools, so treat it as a reference to read and borrow from, not a package to install.

## How a job runs

```
factory job new work "<brief>"
  └─ workspace + worktree + a lead-loop session
       triage ─ spec ─ spec-review ─ GATE 1 ─ coder ─ review ─ tester ─ GATE 2 ─ ship ─ PR
                                                                                   │
                       scheduler: CI, review threads, conflicts, merge  ◄──────────┘
                       soak: watcher checks latest/production at 1h, 4h, 24h → done
```

- **Lead** (`agents/lead-loop.md`): does the work in its own context and records every step with `factory step`, every gate with `factory gate open|decided`. A gate is a stop: the lead writes the full decision, the human answers in chat, and the answer goes into the DB verbatim.
- **Sub-agents** only where a fresh context earns its cost: `factory-spec-review` attacks the spec, `factory-reviewer` reviews the diff (plus a non-Claude review through the Cursor CLI) and returns at most 5 findings, `factory-tester` exercises the change against running servers, `worker-opus` takes the hard judgment calls.
- **Evidence over prose.** Every acceptance criterion in `criteria.md` needs a check that is red on the merge base and green on the branch, saved as an evidence file. `factory step coder done` refuses a report whose evidence table does not cover every criterion.
- **Hooks enforce the gates.** No commit, push, PR edit, merge or review post until the matching gate is approved.
- **Never merges or deploys on its own.** Merge is its own gate.

## Job types

Each type in `factory/types/` is a recipe built from the steps in `factory/elements.yaml`; `factory type check` validates them.

| type | for | steps |
|---|---|---|
| `work` | normal feature or bug work | triage, spec, gate 1, coder + tests, review, tester, gate 2, ship, PR, soak |
| `slim` | small change, no test suite | plan, coder, gate 2, ship, PR |
| `private` | personal repos, commits straight to main | plan, coder, tester, gate 2, commit |
| `pr-review` | someone else's PR | review, Bugbot cross-check, gate, post |
| `research` | a question, not a diff | research rounds, HTML artifact, feedback gate, next jobs |
| `project` | a parent that spawns and tracks child jobs | plan, next jobs |

## Layout

```
factory/
  factory.mjs         CLI and scheduler entry (`factory` on PATH)
  db.mjs              Postgres schema, emit(), dispatch()
  jobs.mjs            jobs, steps, gates, files, PRs
  hooks.mjs           Claude Code hook handlers: guard, validate, orders, track, prompted
  handlers/           one file per event handler { name, on, run }
  pollers/            sessions, github, deploy, bugsnag, messages, schedules, timers
  types/ elements.yaml job recipes and the step catalogue
  dash.mjs            TUI
  web.mjs web.html    web dash on :4281 (SSE)
  standing-orders.md  rules injected into every sub-agent
  definition-of-good.md the reviewer's bar
  test.mjs            the test suite (needs a local Postgres)
agents/               lead-loop, its sub-agents, glados (the chat that starts jobs), watcher, retro
skills/               factory-ship (commit/PR/CI/merge modes), factory-research
hooks/rules-guard.mjs blocks shell file writes and other house rules
```

## Wiring

`npm ci` in `factory/`, a Postgres the CLI can reach (`FACTORY_DATABASE_URL`), `FACTORY_MACHINE=server` on the machine that runs the global pollers, and `factory` on PATH. The hooks in `~/.claude/settings.json`:

| event | matcher | command |
|---|---|---|
| PreToolUse | `Bash\|Edit\|Write\|Read\|NotebookEdit` | `node hooks/rules-guard.mjs` |
| PreToolUse | `Bash\|Write\|Edit\|NotebookEdit` | `factory guard` |
| PreToolUse | `SubagentHandback` | `factory validate` |
| UserPromptSubmit | | `factory prompted` |
| SubagentStart | | `factory orders` |
| SubagentStop | | `factory validate` |
| PostToolUse | `Bash\|Edit\|Write\|NotebookEdit` | `factory track` |
| PostToolUseFailure | `Bash` | `factory track` |

It also assumes things that are not in this repo: herdr (a terminal multiplexer for coding agents) for panes, a workspaces CLI for worktrees, dev servers and Caddy routes, `gh`, the Cursor CLI, and a set of company-internal skills and CLIs (`p-dev:*`, `verify-pr`, `tb-bug`, `tb-sem`). Some code paths still mention lead modes that this snapshot leaves out.

Tests: `node factory/test.mjs` (uses `FACTORY_TEST_DATABASE_URL`, default local Postgres, one schema per test).

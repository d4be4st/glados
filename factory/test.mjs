#!/usr/bin/env -S node --no-warnings
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

process.env.FACTORY_USAGE = 'off';
process.env.FACTORY_MACHINE = 'worker';
process.env.FACTORY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-test-home-'));
const { DIR, open, emit, dispatch, dispatchOne, maxId, now } = await import('./db.mjs');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const only = process.argv.slice(2);

const BASE = process.env.FACTORY_TEST_DATABASE_URL || 'postgres://postgres@localhost:5432/postgres';
const admin = new pg.Pool({ connectionString: BASE, max: 2, allowExitOnIdle: true });
const PREFIX = `t_${process.pid}_`;
const opened = [];
let schemas = 0;

function home() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'factory-test-'));
}

// A fresh, empty factory DB: its own schema on the test Postgres.
async function fresh() {
  const schema = `${PREFIX}${++schemas}`;
  await admin.query(`create schema ${schema}`);
  return `${BASE}?options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

async function openAt(url) {
  const d = await open(url);
  opened.push(d);
  return d;
}

async function db() {
  return openAt(await fresh());
}

const collector = (name, on, seen = []) => ({ name, on, seen, run: row => { seen.push(row.id); } });
const one = async (d, sql, ...p) => d.prepare(sql).get(...p);
const all = async (d, sql, ...p) => d.prepare(sql).all(...p);
const run = async (d, sql, ...p) => d.prepare(sql).run(...p);
const ctxOf = (d, extra = {}) => ({ db: d, machine: 'worker', emit: (...a) => emit(d, ...a), ...extra });
const withEnv = async (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
};

test('0 scaffold: state ignored, code tracked', () => {
  const git = file => spawnSync('git', ['-C', path.dirname(DIR), 'check-ignore', '-q', file]).status;
  assert.equal(git('factory/state/factory.db'), 0);
  assert.equal(git('factory/node_modules/pg/package.json'), 0);
  assert.equal(git('factory/package.json'), 1);
  assert.equal(git('factory/PLAN.md'), 1);
});

test('1 dispatch: each matching event once', async () => {
  const d = await db();
  const h = collector('h', ['a']);
  await dispatch(d, [h]);
  const a1 = await emit(d, 'a', 's');
  await emit(d, 'b', 's');
  const a2 = await emit(d, 'a', 's');
  await dispatch(d, [h]);
  await dispatch(d, [h]);
  assert.deepEqual(h.seen, [a1, a2]);
});

test('1 dispatch: a type added to a handler later does not replay its older events', async () => {
  const d = await db();
  const h = collector('h', ['a']);
  await dispatch(d, [h]);
  await emit(d, 'a');
  await emit(d, 'b');
  await dispatch(d, [h]);
  h.on = ['a', 'b'];
  const b2 = await emit(d, 'b');
  await dispatch(d, [h]);
  assert.equal(h.seen.length, 2);
  assert.equal(h.seen[1], b2);
});

test('1 dispatch: a throw leaves the cursor and the row repeats', async () => {
  const d = await db();
  const seen = [];
  let fail = true;
  const h = { name: 'h', on: ['a'], run: row => { seen.push(row.id); if (fail) throw new Error('boom'); } };
  await dispatch(d, [h]);
  const a1 = await emit(d, 'a');
  const a2 = await emit(d, 'a');
  await dispatch(d, [h]);
  assert.deepEqual(seen, [a1]);
  fail = false;
  await dispatch(d, [h]);
  assert.deepEqual(seen, [a1, a1, a2]);
});

test('1 dispatch: follow-ups and state writes commit with the cursor, not on a throw', async () => {
  const d = await db();
  let fail = true;
  const h = {
    name: 'h', on: ['a'],
    run: (row, ctx) => {
      ctx.emit('b', row.subject, { from: row.id }, [['insert into plate (kind, subject) values (?, ?)', 'x', row.subject]]);
      if (fail) throw new Error('boom');
    },
  };
  await dispatch(d, [h]);
  await emit(d, 'a', 'one');
  await dispatch(d, [h]);
  assert.equal((await one(d, "select count(*) as n from events where type = 'b'")).n, 0);
  assert.equal((await one(d, 'select count(*) as n from plate')).n, 0);
  fail = false;
  await dispatch(d, [h]);
  assert.equal((await one(d, "select count(*) as n from events where type = 'b'")).n, 1);
  assert.equal((await one(d, 'select subject from plate')).subject, 'one');
});

test('1 dispatch: a crash between effect and commit replays, never skips', async () => {
  const url = await fresh();
  const effects = path.join(home(), 'effects');
  const d = await openAt(url);
  const h = { name: 'h', on: ['a'], run: row => fs.appendFileSync(effects, `${row.id}\n`) };
  await dispatch(d, [h]);
  const a1 = await emit(d, 'a');
  const child = `
    import fs from 'node:fs';
    import { open, dispatch } from ${JSON.stringify(path.join(DIR, 'db.mjs'))};
    const d = await open(${JSON.stringify(url)});
    await dispatch(d, [{ name: 'h', on: ['a'], run: row => { fs.appendFileSync(${JSON.stringify(effects)}, row.id + '\\n'); process.exit(1); } }]);`;
  assert.equal(spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', child], { cwd: DIR }).status, 1);
  await dispatch(d, [h]);
  assert.deepEqual(fs.readFileSync(effects, 'utf8').trim().split('\n').map(Number), [a1, a1]);
});

test('1 dispatch: a new handler starts at the current max id', async () => {
  const d = await db();
  await emit(d, 'a');
  await emit(d, 'a');
  const h = collector('late', ['a']);
  await dispatch(d, [h]);
  assert.deepEqual(h.seen, []);
  assert.equal((await one(d, "select last_event_id from cursors where handler = 'late'")).last_event_id, await maxId(d));
  const a3 = await emit(d, 'a');
  await dispatchOne(d, h);
  assert.deepEqual(h.seen, [a3]);
});

test('1 db: events written from many connections at once commit in id order, so no cursor skips one', async () => {
  const d = await db();
  const h = collector('order', ['a']);
  await dispatch(d, [h]);
  const ids = await Promise.all(Array.from({ length: 40 }, () => emit(d, 'a')));
  await dispatch(d, [h]);
  assert.deepEqual(h.seen, [...ids].sort((x, y) => x - y));
});

test('1 db: a DB at a newer schema than this code is refused', async () => {
  const url = await fresh();
  const d = await openAt(url);
  await run(d, 'insert into schema_version (v) values (99)');
  await d.close();
  opened.splice(opened.indexOf(d), 1);
  await assert.rejects(open(url), /schema 99 but this code knows \d+; pull dotclaude first/);
});

function cli(env, ...args) {
  const r = spawnSync(process.execPath, ['--no-warnings', path.join(DIR, 'factory.mjs'), ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const wait = async (cond, ms = 10000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 50))) if (await cond()) return;
  throw new Error('timed out waiting');
};

async function schedulerEnv(machine = 'worker') {
  const h = home();
  const handlers = path.join(h, 'handlers');
  fs.mkdirSync(handlers);
  fs.mkdirSync(path.join(h, 'pollers'));
  const log = path.join(h, 'effects');
  fs.writeFileSync(path.join(handlers, 'slow.mjs'), `import fs from 'node:fs';
    export default { name: 'slow', scope: 'machine', on: ['slow', 'fast'], async run(row) {
      fs.appendFileSync(${JSON.stringify(log)}, 'start ' + row.id + '\\n');
      if (row.type === 'slow') await new Promise(r => setTimeout(r, 1500));
      fs.appendFileSync(${JSON.stringify(log)}, 'end ' + row.id + '\\n');
    } };`);
  fs.writeFileSync(path.join(handlers, 'global.mjs'), `import fs from 'node:fs';
    export default { name: 'global', on: ['fast'], run(row) { fs.appendFileSync(${JSON.stringify(log)}, 'global ' + row.id + '\\n'); } };`);
  const url = await fresh();
  const env = { FACTORY_HOME: h, FACTORY_DATABASE_URL: url, FACTORY_MACHINE: machine, FACTORY_HANDLERS: handlers, FACTORY_POLLERS: path.join(h, 'pollers'), FACTORY_TICK_MS: '60000', FACTORY_WEB_PORT: 'off' };
  const effects = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
  return { h, env, effects, db: () => openAt(url) };
}

test('2 scheduler: second start refused, stop drains, restart resumes, NOTIFY wakes it without a tick', async () => {
  const s = await schedulerEnv();
  try {
    assert.match(cli({ ...s.env, FACTORY_MACHINE: '' }, 'start').out, /set FACTORY_MACHINE to server or worker/);
    assert.equal(cli(s.env, 'start').code, 0);
    const second = cli(s.env, 'start');
    assert.equal(second.code, 1);
    assert.match(second.out, /already on/);
    const d = await s.db();
    await wait(() => one(d, "select 1 from cursors where handler = 'slow' and machine = 'worker'"));
    const slow = await emit(d, 'slow');
    await wait(() => s.effects().includes(`start ${slow}`));
    assert.equal(cli(s.env, 'stop').code, 0);
    assert.deepEqual(s.effects(), [`start ${slow}`, `end ${slow}`]);
    const last = (await one(d, 'select type from events order by id desc limit 1')).type;
    assert.equal(last, 'factory.closed');
    const missed = [await emit(d, 'fast'), await emit(d, 'fast')];
    assert.equal(cli(s.env, 'start').code, 0);
    await wait(() => s.effects().includes(`end ${missed[1]}`));
    assert.deepEqual(s.effects().slice(2), missed.flatMap(id => [`start ${id}`, `end ${id}`]));
    const fresh_ = await emit(d, 'fast');
    await wait(() => s.effects().includes(`end ${fresh_}`), 2500);
    assert.ok(!s.effects().some(e => e.startsWith('global')), 'a worker runs no global handler');
  } finally {
    cli(s.env, 'stop');
  }
});

test('2 scheduler: the server runs global handlers too', async () => {
  const s = await schedulerEnv('server');
  try {
    assert.equal(cli(s.env, 'start').code, 0);
    const d = await s.db();
    await wait(() => one(d, "select 1 from cursors where handler = 'global' and machine = 'server'"));
    const id = await emit(d, 'fast');
    await wait(() => s.effects().includes(`global ${id}`), 2500);
  } finally {
    cli(s.env, 'stop');
  }
});

test('3 sessions: fixture transitions produce exactly the right events', async () => {
  const { diff, openRows } = await import('./pollers/sessions.mjs');
  const d = await db();
  const ws = path.join(process.env.FACTORY_WORK ?? path.join(os.homedir(), 'dev/productive/work'), 'workspaces');
  const s = (id, status, extra = {}) => ({ pid: 0, sessionId: id, name: id, cwd: '/tmp', kind: 'interactive', status, ...extra });
  const ticks = [
    [s('A', 'idle'), s('B', 'busy')],
    [s('A', 'waiting'), s('B', 'busy'), s('C', 'idle', { cwd: path.join(ws, 'job-x', 'repos', 'api') })],
    [s('A', 'busy'), s('C', 'idle', { name: 'C2' })],
    [s('A', 'idle'), s('C', 'idle', { name: 'C2' })],
    [],
  ];
  const got = [];
  for (const listed of ticks) {
    const events = diff(await openRows(d), listed, () => ({ A: { label: 'home', pane: 'p1', status: 'idle' } }));
    for (const e of events) await emit(d, e.type, e.subject, e.data, e.writes);
    got.push(events.map(e => `${e.subject} ${e.type}`));
  }
  assert.deepEqual(got, [
    ['A session.created', 'B session.created'],
    ['A session.waiting', 'C session.created'],
    ['A session.busy', 'C session.renamed', 'B session.closed'],
    ['A session.idle'],
    ['A session.closed', 'C session.closed'],
  ]);
  const rows = (await all(d, 'select session_id, workspace, free, machine, pane_id from sessions order by session_id')).map(r => ({ ...r }));
  assert.deepEqual(rows, [
    { session_id: 'A', workspace: 'home', free: 1, machine: 'worker', pane_id: 'p1' },
    { session_id: 'B', workspace: null, free: 1, machine: 'worker', pane_id: null },
    { session_id: 'C', workspace: 'job-x', free: 0, machine: 'worker', pane_id: null },
  ]);
});

test('3 sessions: a worker never sees or closes the server\'s sessions, herdr drift updates rows without an event', async () => {
  const { diff, openRows, herdrChanges } = await import('./pollers/sessions.mjs');
  const d = await db();
  await run(d, "insert into sessions (session_id, name, status, status_at, machine) values ('S', 'srv', 'idle', 0, 'server'), ('W', 'wrk', 'idle', 0, 'worker')");
  const rows = await openRows(d);
  assert.deepEqual(rows.map(r => r.session_id), ['W']);
  assert.deepEqual(diff(rows, []).map(e => `${e.subject} ${e.type}`), ['W session.closed']);
  assert.deepEqual(herdrChanges(rows, { W: { pane: 'p2', tab: 'home', title: 't', status: 'working' }, S: { pane: 'x' } }),
    [['update sessions set pane_id = ?, tab = ?, title = ?, herdr_status = ? where session_id = ?', 'p2', 'home', 't', 'working', 'W']]);
  assert.deepEqual(herdrChanges([{ session_id: 'W', pane_id: 'p2', tab: 'home', title: 't', herdr_status: 'working' }], { W: { pane: 'p2', tab: 'home', title: 't', status: 'working' } }), []);
});

test('4 dash: the sessions view lists every live `claude agents --json` session', async () => {
  const { diff, openRows } = await import('./pollers/sessions.mjs');
  const { model, render } = await import('./dash.mjs');
  const d = await db();
  const listed = JSON.parse(execFileSync('claude', ['agents', '--json'], { encoding: 'utf8' }));
  for (const e of diff(await openRows(d), listed)) await emit(d, e.type, e.subject, e.data, e.writes);
  const m = await model(d, true);
  assert.deepEqual(m.all.map(r => r.session_id).sort(), listed.map(s => s.sessionId).sort());
  const out = (await render(d, { cursor: -1, view: 'sessions' }, 200)).lines.join('\n');
  for (const s of m.all) assert.ok(out.includes(s.name ?? s.session_id.slice(0, 8)), `${s.name} missing from the sessions view`);
  assert.match((await render(d, { cursor: -1 }, 200)).lines.join('\n'), /attention 0 /);
});

test('4 dash: only jobs at a gate or waiting on Stef need attention; lines fit the width and map to their item', async () => {
  const { diff, openRows } = await import('./pollers/sessions.mjs');
  const { render } = await import('./dash.mjs');
  const d = await db();
  const ws = path.join(os.homedir(), 'dev/productive/work/workspaces');
  const s = (id, status, slug) => ({ pid: 0, sessionId: id, name: `${id}-session`, cwd: path.join(ws, slug), kind: 'interactive', status });
  for (const e of diff(await openRows(d), [s('a', 'idle', 'alpha-with-a-very-long-workspace-name'), s('b', 'waiting', 'beta'), s('c', 'busy', 'gamma'), s('f', 'waiting', 'free-one')])) await emit(d, e.type, e.subject, e.data, e.writes);
  await run(d, "insert into jobs (slug, type, lead_mode, lead_session, status, machine) values ('alpha-with-a-very-long-workspace-name', 'slim', 'orchestrator', 'a', 'running', 'worker'), ('beta', 'slim', 'orchestrator', 'b', 'running', 'worker')");
  await run(d, "insert into gates (job_id, name, body, status, opened_at) values (1, 'gate2', 'ship?', 'open', 1)");
  const { lines, owner, items } = await render(d, { cursor: 0 }, 30);
  assert.ok(lines.every(l => l.length <= 30));
  const at = name => lines.findIndex(l => l.includes(name));
  assert.ok(at('NEEDS ATTENTION 2') < at('alpha') && at('beta') < at('RUNNING'));
  assert.match(lines[at('alpha') + 1], /gate gate2 waits for/);
  assert.match(lines[at('beta')], /lead asked you a/);
  assert.equal(at('free-one'), -1);
  assert.equal(items[owner[at('beta')]].slug, 'beta');
  assert.equal(owner[at('RUNNING')], -1);
  assert.ok((await render(d, { cursor: 0, view: 'sessions' }, 40)).lines.join('\n').includes('f-session'));
});

test('4 dash: IN REVIEW and SOAKING list each PR, RUNNING lists the job until only its PRs are left', async () => {
  const { model, render } = await import('./dash.mjs');
  const d = await db();
  const PR2 = 'https://github.com/o/r/pull/8';
  await run(d, "insert into jobs (slug, type, lead_mode, status, machine) values ('redo', 'work', 'orchestrator', 'running', 'worker')");
  await run(d, "insert into prs (url, repo, number, job_id, state, merged_at, latest_at, created_at) values (?, 'o/r', 7, 1, 'MERGED', 1, 2, 1), (?, 'o/r', 8, 1, 'OPEN', null, null, 2)", PR, PR2);
  await run(d, "insert into ledger (job_id, seq, element, status) values (1, 1, 'shipper', 'dropped'), (1, 2, 'coder', 'running'), (1, 3, 'shipper', 'planned'), (1, 4, 'pr', 'planned'), (1, 5, 'watch', 'planned')");
  await emit(d, 'soak.clean', PR, { stage: 'latest', checkpoint: '1h' });
  const m = () => model(d, true);
  assert.deepEqual((await m()).active.map(j => j.slug), ['redo']);
  assert.deepEqual((await m()).inReview.map(p => p.number), [8]);
  assert.deepEqual((await m()).soaking.map(s => `${s.pr.number} ${s.next.label} ${s.watch.filter(r => r.status === 'done').length}/${s.watch.length}`), ['7 latest +4h 1/5']);
  await run(d, "update ledger set status = 'done' where seq < 4");
  await run(d, "update ledger set status = 'running' where seq = 4");
  assert.deepEqual((await m()).active, []);
  const out = (await render(d, { cursor: -1, collapsed: new Set() }, 80)).lines.join('\n');
  assert.match(out, /IN REVIEW 1\n {2}… r#8 redo\n/);
  assert.match(out, /SOAKING 1\n {2}◔ latest \+4h r#7 redo\n/);
  await emit(d, 'soak.clean', PR, { stage: 'latest', checkpoint: '4h' });
  for (const c of ['1h', '4h', '24h']) await emit(d, 'soak.clean', PR, { stage: 'production', checkpoint: c });
  assert.deepEqual((await m()).soaking, []);
});

test('4 dash: a job at its pr row sits under IN REVIEW with its PR state, not under RUNNING', async () => {
  const { render } = await import('./dash.mjs');
  const d = await db();
  await run(d, "insert into jobs (slug, type, lead_mode, status, machine) values ('toggle', 'slim', 'orchestrator', 'running', 'worker')");
  await run(d, "insert into ledger (job_id, seq, element, status) values (1, 1, 'shipper', 'done'), (1, 2, 'pr', 'running')");
  await run(d, "insert into prs (url, repo, number, job_id, state, draft, ci, review) values (?, 'o/r', 7, 1, 'OPEN', 0, 'passed', 'REVIEW_REQUIRED')", PR);
  const out = (await render(d, { cursor: -1, collapsed: new Set() }, 80)).lines.join('\n');
  assert.match(out, /RUNNING 0\n\n {2}\[-\] IN REVIEW 1\n {2}● r#7 toggle\n/);
  const job = r => r.items.findIndex(i => i.slug === 'toggle');
  const folded = await render(d, { cursor: -1, collapsed: new Set() }, 80);
  assert.ok(!folded.opened[job(folded)]);
  const open_ = await render(d, { cursor: job(folded), collapsed: new Set() }, 80);
  assert.equal(open_.opened[job(open_)], true);
});

test('4 dash: a lead pane footer yields each subagent and its activity, not main or the transcript', async () => {
  const { footerAgents } = await import('./dash.mjs');
  const screen = [
    '⏺ Bash  Done  · 2s',
    '────────────',
    '❯',
    '────────────',
    '  ⏵⏵ auto mode on (shift+tab to cycle) · ← 2 agents · ↓ to manage',
    '',
    '  ⏺ main',
    '  ◯ factory-spec  Checking mocks in setting-modal.test.tsx            11m 7s · ↓ 318.6k tokens',
    '  ◯ worker-opus  Running the api specs',
  ].join('\n');
  assert.deepEqual(footerAgents(screen), ['spec · Checking mocks in setting-modal.test.tsx', 'worker-opus · Running the api specs']);
  assert.deepEqual(footerAgents('────\n  ⏺ main\n  ● factory-spec-coder  Launching datev grant spec agent\n    └ ○ worker-sonnet  Writing grant_spec.rb\n'), ['spec-coder · Launching datev grant spec agent', 'worker-sonnet · Writing grant_spec.rb']);
  assert.deepEqual(footerAgents('────\n  ⏺ main\n  ◯ factory-spec-coder (+1)  Launching make_http_request spec agent      19m 12s · ↓ 121.7k tokens\n'), ['spec-coder (+1) · Launching make_http_request spec agent']);
  assert.deepEqual(footerAgents('  ⏺ main\n'), []);
});

test('4 dash: a lead shows its last own text reply, skipping tool calls and subagent turns', async () => {
  const { lastSaid } = await import('./dash.mjs');
  const h = home();
  await withEnv({ FACTORY_PROJECTS: path.join(h, 'projects') }, () => {
    fs.mkdirSync(path.join(h, 'projects', '-ws'), { recursive: true });
    const say = (content, extra = {}) => JSON.stringify({ type: 'assistant', message: { content }, ...extra });
    fs.writeFileSync(path.join(h, 'projects', '-ws', 'lead-1.jsonl'), [
      say([{ type: 'text', text: 'old' }]),
      say([{ type: 'text', text: 'Spec is **ready**,\n\nrun `coder` next.' }]),
      say([{ type: 'tool_use', name: 'Agent', input: {} }]),
      say([{ type: 'text', text: 'from a subagent' }], { isSidechain: true }),
      JSON.stringify({ type: 'user', message: { content: 'ok' } }),
      '',
    ].join('\n'));
    assert.equal(lastSaid('lead-1'), 'Spec is ready, run coder next.');
    assert.equal(lastSaid('missing'), null);
  });
});

test('4 dash: a collapsed section hides its rows, the header stays an item', async () => {
  const { render } = await import('./dash.mjs');
  const d = await db();
  await run(d, "insert into workspaces (slug, status, machine) values ('shelved-one', 'parked', 'worker')");
  const open_ = await render(d, { cursor: 0, collapsed: new Set() }, 40);
  const shut = await render(d, { cursor: 0, collapsed: new Set(['parked']) }, 40);
  assert.ok(open_.lines.some(l => l.includes('[-] PARKED 1')) && open_.lines.some(l => l.includes('shelved-one')));
  assert.ok(shut.lines.some(l => l.includes('[+] PARKED 1')) && !shut.lines.some(l => l.includes('shelved-one')));
  assert.ok(shut.items.some(i => i.section === 'parked'));
});

test('5 type check: rejects an unknown element, a shipper without a coder, an unreachable done rule', async () => {
  const { check, load, names } = await import('./types.mjs');
  for (const n of names()) assert.deepEqual(check(load(n)), [], n);
  const base = { lead: 'orchestrator', done: { on: 'pr.merged' } };
  assert.match(check({ ...base, steps: ['plan', 'hammer', 'coder', 'shipper'] }).join(), /unknown element hammer/);
  assert.match(check({ ...base, steps: ['plan', 'shipper', 'coder'] }).join(), /shipper needs coder before it/);
  assert.match(check({ ...base, steps: ['plan', 'coder'] }).join(), /unreachable: no step leads to pr.merged/);
  assert.match(check({ ...base, steps: ['coder', 'shipper'], done: { on: 'soak.clean', when: 'stage == production and checkpoint == 7d' }, soak: { production: ['1h'] } }).join(), /no soak checkpoint 7d/);
  assert.match(check({ ...base, steps: ['coder', { gate: { name: 'g2' } }], done: { on: 'gate.decided', when: 'name == g1' } }).join(), /no gate g1/);
  assert.match(check({ ...base, steps: ['coder'], done: { on: 'job.step', when: 'element == commit-on-main' } }).join(), /no step commit-on-main/);
  assert.match(check({ ...base, lead: 'boss', steps: ['coder', 'shipper'] }).join(), /lead must be/);
  const bad = cli({}, 'type', 'check', 'nope');
  assert.equal(bad.code, 1);
});

async function jobEnv() {
  const h = home();
  const work = path.join(h, 'work');
  fs.mkdirSync(path.join(work, 'workspaces'), { recursive: true });
  const stub = path.join(h, 'workspaces-stub');
  fs.writeFileSync(stub, `#!/bin/sh
echo "$@" >> ${JSON.stringify(path.join(h, 'ws-calls'))}
if [ "$1" = new ]; then s=$(echo "$2" | tr 'A-Z ' 'a-z-'); mkdir -p ${JSON.stringify(path.join(work, 'workspaces'))}/$s; printf '\\033[32mCreated:\\033[0m %s\\n' "$s"; fi
`);
  fs.chmodSync(stub, 0o755);
  const url = await fresh();
  const env = { FACTORY_HOME: h, FACTORY_WORK: work, FACTORY_WORKSPACES: stub, FACTORY_DATABASE_URL: url, FACTORY_MACHINE: 'worker', CLAUDE_CODE_SESSION_ID: 'lead-1' };
  return { h, work, env, calls: () => (fs.existsSync(path.join(h, 'ws-calls')) ? fs.readFileSync(path.join(h, 'ws-calls'), 'utf8') : ''), db: () => openAt(url) };
}

test('5 jobs: new → start → steps → gate → done rule, all in the DB', async () => {
  const j = await jobEnv();
  const made = cli(j.env, 'job', 'new', '--on', 'worker', 'slim', 'Toy fix for the readme', '--title', 'toy readme');
  assert.equal(made.code, 0, made.out);
  assert.match(j.calls(), /new toy readme --agent lead-loop/);
  assert.match(j.calls(), /open toy-readme --no-focus --prompt You lead factory job toy-readme/);
  const d = await j.db();
  await run(d, "update jobs set lead_mode = 'orchestrator'");
  const env = { ...j.env, PWD: path.join(j.work, 'workspaces', 'toy-readme') };
  const at = (...a) => spawnSync(process.execPath, ['--no-warnings', path.join(DIR, 'factory.mjs'), ...a], { env: { ...process.env, ...env }, cwd: env.PWD, encoding: 'utf8', input: a.includes('open') ? 'Gate 2: all good. Ship it?' : undefined });
  const started = at('job', 'start');
  assert.match(started.stdout, /Job toy-readme, type slim, lead mode orchestrator/);
  assert.match(started.stdout, /on the worker\./);
  assert.match(started.stdout, /1\. plan\n {2}2\. coder \(no tests\)\n {2}3\. gate:gate2\n {2}4\. shipper\n {2}5\. pr/);
  assert.equal(at('step', 'hammer', 'start').status, 1);
  assert.equal(at('step', 'plan', 'done', '--note', 'clear').status, 0);
  assert.equal(at('step', 'coder', 'done').status, 1);
  assert.equal(at('step', 'coder', 'start', '--worker', 'factory-coder@sonnet').status, 0);
  assert.equal(at('step', 'coder', 'done', '--note', 'readme fixed, coder-1.md').status, 0);
  assert.equal(at('gate', 'decided', 'gate2', 'approved', '--words', 'ok').status, 1);
  assert.equal(at('gate', 'open', 'gate2').status, 0);
  assert.equal(at('gate', 'decided', 'gate2', 'approved').status, 1);
  assert.equal(at('gate', 'decided', 'gate2', 'approved', '--words', 'ship it').status, 0);
  const job = await one(d, 'select * from jobs');
  assert.equal(job.lead_session, 'lead-1');
  assert.equal(job.status, 'running');
  assert.equal(job.machine, 'worker');
  const { progress } = await import('./jobs.mjs');
  assert.deepEqual({ ...await progress(d, job), gate: undefined }, { pct: 100, step: 'shipper', phase: 'ship', gate: undefined, wait: null });
  assert.deepEqual((await all(d, 'select name, body, status, words from gates')).map(r => ({ ...r })),
    [{ name: 'gate2', body: 'Gate 2: all good. Ship it?', status: 'approved', words: 'ship it' }]);
  const rows = async () => (await all(d, 'select id, element, label, status, worker, note from ledger order by seq')).map(r => `${r.id} ${r.element}${r.label ? `:${r.label}` : ''} ${r.status}${r.worker ? ` ${r.worker}` : ''}${r.note ? ` ${r.note}` : ''}`);
  assert.deepEqual(await rows(), ['1 plan done clear', '2 coder done factory-coder@sonnet readme fixed, coder-1.md', '3 gate:gate2 done approved, Stef: "ship it"', '4 shipper planned', '5 pr planned']);
  assert.equal(at('step', 'coder', 'start', '--worker', 'factory-coder@opus').status, 0);
  assert.equal(at('plan', 'add', 'review', 'judge', '--label', 'fix round 2').status, 0);
  assert.equal(at('plan', 'add', 'hammer').status, 1);
  assert.equal(at('plan', 'drop', '8').status, 1);
  assert.equal(at('plan', 'drop', '8', '--note', 'judge not needed for a readme').status, 0);
  assert.equal(at('plan', 'drop', '1', '--note', 'x').status, 1);
  assert.deepEqual(await rows(), ['1 plan done clear', '2 coder done factory-coder@sonnet readme fixed, coder-1.md', '3 gate:gate2 done approved, Stef: "ship it"', '6 coder running factory-coder@opus',
    '7 review:fix round 2 planned', '8 judge:fix round 2 dropped judge not needed for a readme', '4 shipper planned', '5 pr planned']);
  assert.deepEqual({ ...await progress(d, job), gate: undefined }, { pct: 56, step: 'coder', phase: 'build', gate: undefined, wait: null });
  assert.equal(at('job', 'task', '#12').status, 1);
  assert.equal(at('job', 'task', '19463170').status, 0);
  assert.equal((await one(d, 'select task_id from jobs')).task_id, '19463170');
  assert.match(at('job', 'show').stdout, /Productive task: 19463170\./);
  assert.match(at('job', 'show', '--full').stdout, /row 2: coder · done · weight 3 · factory-coder@sonnet\n {6}readme fixed, coder-1\.md\n {2}row 3: gate:gate2 · done/);
  assert.match(at('job', 'show').stdout, /\n {2}rows 1, 2, 3: 3 done\n {2}row 6: coder · running[^\n]*\n {2}row 7: review \(fix round 2\) · planned[^\n]*\n {2}rows 8: 1 dropped\n {2}row 4: shipper/);
  assert.doesNotMatch(at('job', 'show').stdout, /readme fixed/);
  assert.equal(at('job', 'task').stdout, 'Productive task: 19463170.\n');
  const done = (await import('./handlers/done.mjs')).default;
  await dispatch(d, [done]);
  await emit(d, 'pr.merged', 'https://github.com/x/y/pull/1', { job: 'toy-readme' });
  await dispatch(d, [done]);
  assert.equal((await one(d, 'select status from jobs')).status, 'done');
  assert.deepEqual((await all(d, 'select type from events order by id')).map(r => r.type),
    ['job.created', 'job.started', 'job.step', 'job.step', 'job.step', 'gate.opened', 'gate.decided', 'job.step', 'plan.added', 'plan.dropped', 'job.task', 'pr.merged', 'job.done']);
});

test('5 jobs: a job runs on the server by default, waits for it, and its spawn handler sets it up; the same slug is refused', async () => {
  const j = await jobEnv();
  const made = cli(j.env, 'job', 'new', 'slim', 'Toy remote', '--title', 'far away', '--app', 'api:3150');
  assert.equal(made.code, 0, made.out);
  assert.match(made.out, /created on the server; its lead starts there/);
  assert.equal(j.calls(), '');
  const d = await j.db();
  assert.deepEqual({ ...await one(d, "select j.machine as job, w.machine as ws, j.title from jobs j join workspaces w on w.slug = j.slug where j.slug = 'far-away'") }, { job: 'server', ws: 'server', title: 'far away' });
  assert.match(cli(j.env, 'job', 'new', '--on', 'worker', 'slim', 'again', '--title', 'far away').out, /already exists/);
  assert.match(cli(j.env, 'job', 'new', 'slim', 'x', '--on', 'moon').out, /--on is one of server, worker/);
  const spawn = (await import('./handlers/spawn.mjs')).default;
  const made_ = [];
  const ctx = machine => ctxOf(d, { machine, materialize: async (db_, slug) => made_.push(`${machine} ${slug}`) });
  await dispatch(d, [spawn], ctx('worker'));
  await dispatch(d, [spawn], ctx('server'));
  assert.deepEqual(made_, []);
  await emit(d, 'job.created', 'far-away', { machine: 'server', inline: false });
  await emit(d, 'job.created', 'near', { machine: 'worker', inline: true });
  await dispatch(d, [spawn], ctx('worker'));
  await dispatch(d, [spawn], ctx('server'));
  assert.deepEqual(made_, ['server far-away']);
  assert.equal((await one(d, "select count(*) as n from events where type = 'job.spawned' and subject = 'far-away'")).n, 1);
  const m = inChild(j.env, "import { open } from './db.mjs'; import { materialize } from './jobs.mjs'; await materialize(await open(), 'far-away', { lead: false }); console.log('made');");
  assert.equal(m.stdout.trim(), 'made', m.stderr);
  assert.match(j.calls(), /new far away --agent lead-loop --app api:3150/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(j.work, 'workspaces', 'far-away', '.claude', 'settings.json'), 'utf8')), { model: 'sonnet', effortLevel: 'medium' });
});

test('5 move: a worker job whose idle lead has its PR up moves to the server; dirty work or a failed copy keeps it here', async () => {
  const j = await jobEnv();
  assert.equal(cli(j.env, 'job', 'new', '--on', 'worker', 'slim', 'toy move', '--title', 'mv').code, 0);
  const d = await j.db();
  const ws = path.join(j.work, 'workspaces', 'mv');
  const sh = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const origin = path.join(j.h, 'origin.git');
  const repo = path.join(j.h, 'repos', 'api');
  sh(j.h, 'init', '-q', '--bare', '-b', 'develop', origin);
  sh(j.h, 'clone', '-q', origin, repo);
  sh(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base');
  sh(repo, 'push', '-q', 'origin', 'HEAD:develop');
  sh(repo, 'worktree', 'add', '-q', '-b', 'mv', path.join(ws, 'api'), 'origin/develop');
  sh(path.join(ws, 'api'), 'push', '-q', '-u', 'origin', 'mv');
  await run(d, "update jobs set lead_session = 'L', status = 'running' where slug = 'mv'");
  await run(d, "insert into sessions (session_id, name, status, status_at, machine) values ('L', 'L', 'idle', 0, 'worker')");
  await run(d, "insert into prs (url, repo, number, job_id, state, draft) select ?, 'o/r', 7, id, 'MERGED', 0 from jobs where slug = 'mv'", PR);
  const spawn = (await import('./handlers/spawn.mjs')).default;
  const moveIns = [];
  const serverCtx = ctxOf(d, { machine: 'server', moveIn: async (db_, slug, trees) => moveIns.push(`${slug} ${trees.map(t => `${t.app}@${t.branch}`)}`) });
  await dispatch(d, [spawn], serverCtx);
  const projects = path.join(j.h, 'projects');
  fs.mkdirSync(path.join(projects, '-mv'), { recursive: true });
  fs.writeFileSync(path.join(projects, '-mv', 'L.jsonl'), '{}\n');
  const bin = path.join(j.h, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(j.h, 'remote-calls');
  for (const tool of ['ssh', 'scp']) fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\necho "${tool} $@" >> ${JSON.stringify(log)}\n[ -f ${JSON.stringify(path.join(j.h, 'fail'))} ] && exit 1\nexit 0\n`);
  for (const tool of ['ssh', 'scp']) fs.chmodSync(path.join(bin, tool), 0o755);
  const move = (await import('./pollers/move.mjs')).default;
  await withEnv({ FACTORY_WORKSPACES: j.env.FACTORY_WORKSPACES, FACTORY_PROJECTS: projects, PATH: `${bin}:${process.env.PATH}` }, async () => {
    const { moveToServer } = await import('./jobs.mjs?move');
    const ctx = ctxOf(d, { moveToServer });
    fs.writeFileSync(path.join(ws, 'api', 'wip.txt'), 'x');
    await move.run(ctx);
    await move.run(ctx);
    assert.equal((await one(d, "select count(*) as n from plate where kind = 'move-blocked'")).n, 1);
    assert.match((await one(d, "select text from plate where kind = 'move-blocked'")).text, /mv stays on the worker: api has uncommitted changes/);
    fs.rmSync(path.join(ws, 'api', 'wip.txt'));
    sh(path.join(ws, 'api'), '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'squashed and branch deleted');
    await move.run(ctx);
    assert.match((await all(d, "select text from plate where kind = 'move-blocked' order by id")).at(-1).text, /api has unpushed commits/);
    await run(d, 'update prs set head_sha = ?', sh(path.join(ws, 'api'), 'rev-parse', 'HEAD'));
    fs.writeFileSync(path.join(j.h, 'fail'), '');
    await move.run(ctx);
    assert.match((await all(d, "select text from plate where kind = 'move-blocked' order by id")).at(-1).text, /copying the lead's transcript/);
    fs.rmSync(path.join(j.h, 'fail'));
    await move.run(ctxOf(d, { machine: 'server', moveToServer }));
    assert.equal((await one(d, "select machine from jobs where slug = 'mv'")).machine, 'worker');
    await move.run(ctx);
  });
  assert.deepEqual({ ...await one(d, "select j.machine as job, w.machine as ws from jobs j join workspaces w on w.slug = j.slug where j.slug = 'mv'") }, { job: 'server', ws: 'server' });
  const moved = JSON.parse((await one(d, "select data from events where type = 'job.moved'")).data);
  assert.deepEqual({ ...moved, worktrees: moved.worktrees.map(w => w.app) }, { from: 'worker', to: 'server', worktrees: ['api'], transcript: true });
  assert.match(fs.readFileSync(log, 'utf8'), new RegExp(`scp -q ${path.join(projects, '-mv', 'L.jsonl')} bestija-v4:${path.join(projects, '-mv', 'L.jsonl')}`));
  assert.match(j.calls(), /done mv/);
  await dispatch(d, [spawn], serverCtx);
  assert.deepEqual(moveIns, ['mv api@mv']);
  assert.equal((await one(d, "select json_extract(data, '$.by') as by from events where type = 'job.spawned'")).by, 'job.moved');
});

test('6 wake-lead: a queued message for a job whose lead session closed opens a new lead once per cooldown', async () => {
  const j = await jobEnv();
  assert.equal(cli(j.env, 'job', 'new', '--on', 'worker', 'slim', 'toy', '--title', 'wk').code, 0);
  const d = await j.db();
  const opens = () => j.calls().split('\n').filter(l => /^open wk /.test(l)).length;
  const base = opens();
  await run(d, "update jobs set lead_session = 'L' where slug = 'wk'");
  await run(d, "insert into sessions (session_id, name, status, status_at, closed_at, machine) values ('L', 'L', 'closed', 0, 1, 'worker')");
  await run(d, "insert into messages (job_id, text, status, created_at) select id, 'From factory [m-1]: ci failed', 'queued', 0 from jobs where slug = 'wk'");
  fs.mkdirSync(path.join(j.h, 'projects', '-wk'), { recursive: true });
  fs.writeFileSync(path.join(j.h, 'projects', '-wk', 'L.jsonl'), '{}\n');
  await withEnv({ FACTORY_WORKSPACES: j.env.FACTORY_WORKSPACES, FACTORY_PROJECTS: path.join(j.h, 'projects') }, async () => {
    const poller = (await import('./pollers/wake-lead.mjs')).default;
    await poller.run(ctxOf(d, { machine: 'server' }));
    assert.equal(opens(), base);
    const ctx = ctxOf(d);
    await poller.run(ctx);
    assert.equal(opens(), base + 1);
    assert.match(j.calls(), /open wk --no-focus --resume L --prompt You lead factory job wk/);
    assert.match(j.calls(), /close wk\nopen wk --no-focus --resume L/);
    await poller.run(ctx);
    assert.equal(opens(), base + 1);
    await run(d, "delete from events where type = 'lead.waking'");
    await run(d, "update sessions set closed_at = null where session_id = 'L'");
    await poller.run(ctx);
    assert.equal(opens(), base + 1);
    await run(d, "update sessions set closed_at = 1 where session_id = 'L'");
    await run(d, "insert into events (ts, type, subject) values (1, 'lead.waking', 'wk'), (2, 'lead.waking', 'wk'), (3, 'lead.waking', 'wk')");
    await poller.run(ctx);
    assert.equal(opens(), base + 1);
    assert.equal((await one(d, 'select status from messages')).status, 'failed');
    assert.match((await one(d, "select text from plate where kind = 'wake-failed'")).text, /did not come back after 3 wakes[^]*ci failed/);
  });
});

test('6 move: an idle lead whose PR is merged or in review moves, and its close is not a missing lead', async () => {
  const j = await jobEnv();
  const d = await j.db();
  const poller = (await import('./pollers/move.mjs')).default;
  const missing = (await import('./handlers/lead-missing.mjs')).default;
  await dispatch(d, [missing]);
  const moves = [];
  const ctx = ctxOf(d, { moveToServer: async (db_, slug) => { moves.push(slug); await emit(d, 'job.moved', slug, {}); return null; } });
  await run(d, "insert into jobs (slug, type, lead_mode, lead_session, status, machine) values ('sl', 'work', 'loop', 'L', 'running', 'worker')");
  await run(d, "insert into sessions (session_id, name, status, status_at, machine) values ('L', 'L', 'idle', ?, 'worker')", now());
  await run(d, "insert into prs (url, repo, number, job_id, state, draft) values (?, 'o/r', 7, 1, 'OPEN', 1)", PR);
  await poller.run(ctx);
  await run(d, 'update sessions set status_at = 0');
  await poller.run(ctx);
  await run(d, 'update prs set draft = 0');
  await run(d, "insert into gates (job_id, name, status) values (1, 'merge', 'open')");
  await poller.run(ctx);
  await run(d, "update gates set status = 'approved'");
  await run(d, "insert into messages (job_id, text, status) values (1, 'x', 'queued')");
  await poller.run(ctx);
  await run(d, "update messages set status = 'delivered'");
  await run(d, "update sessions set status = 'busy'");
  await poller.run(ctx);
  await run(d, "update sessions set status = 'idle'");
  await run(d, "insert into ledger (job_id, seq, element, label, status, updated_at) values (1, 11, 'pr', null, 'running', 1), (1, 12, 'shipper', 'merge', 'failed', 2)");
  await poller.run(ctx);
  assert.deepEqual(moves, []);
  await run(d, "update ledger set status = 'done', updated_at = 3 where element = 'shipper'");
  await run(d, "update prs set state = 'MERGED'");
  await poller.run({ ...ctx, machine: 'server' });
  assert.deepEqual(moves, []);
  await poller.run(ctx);
  assert.deepEqual(moves, ['sl']);
  await run(d, "update sessions set closed_at = 1 where session_id = 'L'");
  await emit(d, 'session.closed', 'L');
  await dispatch(d, [missing]);
  assert.equal((await one(d, 'select count(*) as n from plate')).n, 0);
  await emit(d, 'session.created', 'L');
  await emit(d, 'session.closed', 'L');
  await dispatch(d, [missing]);
  assert.equal((await one(d, "select count(*) as n from plate where kind = 'lead-missing'")).n, 1);
});

test('5 jobs: a gate opened on a done job reopens it', async () => {
  const j = await jobEnv();
  assert.equal(cli(j.env, 'job', 'new', '--on', 'worker', 'research', 'toy', '--title', 'wri').code, 0);
  const env = { ...j.env, PWD: path.join(j.work, 'workspaces', 'wri') };
  const at = (...a) => spawnSync(process.execPath, ['--no-warnings', path.join(DIR, 'factory.mjs'), ...a], { env: { ...process.env, ...env }, cwd: env.PWD, encoding: 'utf8', input: 'Round 3 report. Accept?' });
  assert.equal(at('job', 'start').status, 0);
  const d = await j.db();
  await run(d, "update jobs set status = 'done', done_at = 1");
  assert.equal(at('gate', 'open', 'feedback').status, 0);
  assert.deepEqual({ ...await one(d, 'select status, done_at from jobs') }, { status: 'running', done_at: null });
});

function stubHerdr(h, panes, tabs = []) {
  const stub = path.join(h, 'herdr-stub');
  fs.writeFileSync(stub, `#!/bin/sh
echo "$@" >> ${JSON.stringify(path.join(h, 'herdr-calls'))}
[ "$1" = "--machine" ] && shift 2
[ "$1 $2" = "pane list" ] && echo '${JSON.stringify({ result: { panes } })}'
[ "$1 $2" = "tab list" ] && echo '${JSON.stringify({ result: { tabs } })}'
[ "$1 $2" = "tab create" ] && echo '{"result":{"root_pane":{"pane_id":"p9"}}}'
exit 0
`);
  fs.chmodSync(stub, 0o755);
  return { stub, calls: () => fs.readFileSync(path.join(h, 'herdr-calls'), 'utf8').trim().split('\n') };
}

const inChild = (env, code) => spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code], { env: { ...process.env, ...env }, cwd: DIR, encoding: 'utf8' });

test('4 dash: g jumps to a live GLaDOS pane on her machine, or starts her in a new herdr tab on the server', async () => {
  const h = home();
  const { stub, calls } = stubHerdr(h, [{ agent_session: { value: 'g-1' }, workspace_id: 'w1', tab_id: 't1' }]);
  const url = await fresh();
  const d = await openAt(url);
  const go = () => inChild({ FACTORY_DATABASE_URL: url, FACTORY_HERDR: stub, FACTORY_WORK: '/w' },
    `import { open } from './db.mjs'; import { openGlados } from './dash.mjs'; console.log(await openGlados(await open()));`).stdout.trim();
  await run(d, "insert into sessions (session_id, name, status, status_at, machine) values ('g-1', 'glados', 'idle', 0, 'server')");
  assert.equal(go(), 'GLaDOS');
  assert.deepEqual(calls(), ['--machine server pane list', '--machine server workspace focus w1', '--machine server tab focus t1']);
  await run(d, "update sessions set closed_at = 1 where session_id = 'g-1'");
  fs.rmSync(path.join(h, 'herdr-calls'));
  assert.equal(go(), 'starting GLaDOS on the server');
  assert.deepEqual(calls(), ['--machine server tab create --cwd /w --label glados --focus', '--machine server pane run p9 factory glados']);
});

test('11 web focus: a job jumps to its lead pane, else a live workspace session, and raises the terminal', async () => {
  const h = home();
  const { stub } = stubHerdr(h, [{ agent_session: { value: 's-2' }, workspace_id: 'w2', tab_id: 't2' }]);
  const bin = path.join(h, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'open'), `#!/bin/sh\necho "open $@" >> ${JSON.stringify(path.join(h, 'herdr-calls'))}\n`);
  fs.chmodSync(path.join(bin, 'open'), 0o755);
  const url = await fresh();
  const d = await openAt(url);
  await run(d, "insert into jobs (slug, type, lead_session, machine) values ('a', 'slim', 's-gone', 'worker'), ('b', 'slim', null, 'worker')");
  await run(d, "insert into sessions (session_id, workspace, status_at, machine) values ('s-2', 'a', 1, 'worker')");
  const go = slug => inChild({ FACTORY_DATABASE_URL: url, FACTORY_HERDR: stub, FACTORY_WEB_PORT: 'off', PATH: `${bin}:${process.env.PATH}` },
    `import { open } from './db.mjs'; import { action } from './web.mjs'; try { console.log(await action(await open(), '/job/${slug}/focus')); } catch (e) { console.log(e.message); }`).stdout.trim();
  const calls = () => fs.readFileSync(path.join(h, 'herdr-calls'), 'utf8').trim().split('\n');
  assert.equal(go('a'), 'a focused in herdr');
  assert.deepEqual(calls(), ['pane list', 'pane list', 'workspace focus w2', 'tab focus t2', 'open -a Ghostty']);
  fs.rmSync(path.join(h, 'herdr-calls'));
  assert.equal(go('b'), 'no herdr pane for b');
  assert.equal(go('nope'), 'no job nope');
  assert.ok(!fs.existsSync(path.join(h, 'herdr-calls')));
});

test('4 dash: job leads carry their herdr state glyph; every other herdr Claude on either machine lands in UNCATEGORIZED after GLaDOS', async () => {
  const { render } = await import('./dash.mjs');
  const d = await db();
  await run(d, "insert into jobs (slug, type, lead_mode, lead_session, status, done_at, machine) values ('alpha', 'slim', 'orchestrator', 's-lead', 'running', null, 'worker'), ('beta', 'research', 'writer', 's-old', 'done', 1, 'worker'), ('gamma', 'slim', 'orchestrator', 's-gone', 'done', 1, 'worker')");
  const s = (id, name, status, herdr, machine = 'worker', tab = null, title = null) => [id, name, status, herdr, machine, tab, title];
  for (const row of [s('s-lead', 'lead', 'busy', 'working'), s('s-old', 'old', 'idle', 'idle'), s('g-1', 'glados', 'idle', 'idle', 'server'), s('s-busy', null, 'busy', 'working', 'worker', null, 'busy-one'),
    s('s-done', null, 'idle', 'done', 'worker', 'homelab', 'title-only'), s('s-ask', null, 'waiting', 'blocked', 'server', null, 'asks'), s('s-headless', 'h', 'busy', null)]) {
    await run(d, 'insert into sessions (session_id, name, status, status_at, herdr_status, machine, tab, title, pane_id) values (?, ?, ?, 0, ?, ?, ?, ?, ?)', ...row, row[3] ? `p-${row[0]}` : null);
  }
  const show = async (only = undefined) => (await render(d, { cursor: -1, collapsed: new Set(), only }, 80)).lines.join('\n');
  const out = await show();
  assert.match(out, /RUNNING 2\n {2}◐ alpha\n/);
  assert.match(out, /\[-\] DONE 1\n {2}○ beta\n\n/);
  assert.match(out.split('UNCATEGORIZED')[1], /^ 4\n {2}○ GLaDOS\n {2}✓ homelab · title-only\n {2}◐ busy-one\n {2}× asks$/);
  assert.match(await show(['blocked', 'done']), /\nFILTER × ✓ 2\n {2}× asks\n {2}blocked · no job · server\n {2}✓ homelab · title-only\n {2}done · no job$/);
  assert.match(await show(['idle']), /\nFILTER ○ 2\n {2}○ g-1\n {2}idle · no job · server\n {2}○ beta\n {2}idle · research job, done$/);
});

test('4 dash: an active search opens collapsed sections and every item carries its searchable text', async () => {
  const { render } = await import('./dash.mjs');
  const d = await db();
  await run(d, "insert into jobs (slug, type, status, machine) values ('toy-project', 'project', 'running', 'worker')");
  const ui = { cursor: -1, collapsed: new Set(['projects']) };
  assert.doesNotMatch((await render(d, ui, 80)).lines.join('\n'), /toy-project/);
  const r = await render(d, { ...ui, query: 'toy' }, 80);
  assert.match(r.lines.join('\n'), /\[-\] PROJECTS 1\n {2}toy-project/);
  assert.equal(r.items[r.texts.findIndex(t => t?.includes('toy'))].slug, 'toy-project');
});

test('5 projects: job show lists the jobs started under it; a child runs on its parent\'s machine', async () => {
  const j = await jobEnv();
  assert.equal(cli(j.env, 'job', 'new', '--on', 'worker', 'project', 'Toy project', '--title', 'toy project').code, 0);
  assert.equal(cli({ ...j.env, CLAUDE_CODE_SESSION_ID: 'sess-lead-1' }, 'job', 'new', 'slim', 'Toy child fix', '--title', 'toy child', '--parent', 'toy-project', '--why', 'soak signal on PR 1').code, 0);
  assert.match(j.calls(), /new toy child --agent lead-loop --parent toy-project/);
  assert.match(cli(j.env, 'job', 'show', '--job', 'toy-child').out, /Created by: session sess-lead-1 \(no longer tracked\), as a child of toy-project\. Why: soak signal on PR 1\./);
  assert.match(cli(j.env, 'job', 'show', '--job', 'toy-project').out, /Jobs under this one[^\n]*\n {2}toy-child \(slim\) · created · 0% · now: plan$/m);
  assert.doesNotMatch(cli(j.env, 'job', 'show', '--job', 'toy-child').out, /Jobs under this one/);
  const d = await j.db();
  await run(d, "update jobs set machine = 'server' where slug = 'toy-project'");
  assert.match(cli(j.env, 'job', 'new', 'slim', 'second child', '--title', 'kid two', '--parent', 'toy-project').out, /created on the server/);
});

test('5 ledger: a work job plans its soak checkpoints, soak results land on their row', async () => {
  const j = await jobEnv();
  assert.equal(cli(j.env, 'job', 'new', '--on', 'worker', 'work', 'Fix it', '--title', 'wk').code, 0);
  const d = await j.db();
  const watch = async () => (await all(d, "select label, status, note from ledger where element = 'watch' order by seq")).map(r => `${r.label} ${r.status}${r.note ? ` ${r.note}` : ''}`);
  assert.equal((await one(d, 'select count(*) as n from ledger')).n, 15);
  assert.deepEqual((await all(d, 'select element from ledger order by seq')).map(r => r.element).slice(-7), ['shipper', 'pr', 'watch', 'watch', 'watch', 'watch', 'watch']);
  assert.deepEqual(await watch(), ['latest +1h planned', 'latest +4h planned', 'production +1h planned', 'production +4h planned', 'production +24h planned']);
  const handler = (await import('./handlers/ledger.mjs')).default;
  await dispatch(d, [handler]);
  const prRow = () => one(d, "select status, note from ledger where element = 'pr'");
  await emit(d, 'pr.opened', 'https://github.com/o/r/pull/1', { job: 'wk' });
  await dispatch(d, [handler]);
  assert.deepEqual({ ...await prRow() }, { status: 'running', note: 'https://github.com/o/r/pull/1' });
  const { progress } = await import('./jobs.mjs');
  const job = await one(d, "select * from jobs where slug = 'wk'");
  await run(d, "insert into prs (url, job_id, state, created_at) values ('https://github.com/o/r/pull/1', ?, 'OPEN', ?), ('https://github.com/o/r/pull/0', ?, 'OPEN', null)", job.id, now() - 2 * 3600e3, job.id);
  assert.equal((await progress(d, job)).wait, 'in review · 2h');
  const { state } = await import('./web.mjs');
  assert.equal((await state(d)).jobs.find(x => x.slug === 'wk').progress.wait, 'in review · 2h');
  await run(d, "delete from prs where url like '%/0'");
  await emit(d, 'pr.merged', 'https://github.com/o/r/pull/1', { job: 'wk' });
  await dispatch(d, [handler]);
  assert.equal((await prRow()).status, 'done');
  await emit(d, 'soak.clean', 'https://github.com/o/r/pull/1', { job: 'wk', stage: 'latest', checkpoint: '1h', report: 'soak-latest-1h-1.md' });
  await emit(d, 'soak.signal', 'https://github.com/o/r/pull/1', { job: 'wk', stage: 'latest', checkpoint: '4h', summary: 'new NoMethodError in meeting.rb' });
  await dispatch(d, [handler]);
  assert.deepEqual((await watch()).slice(0, 3), ['latest +1h done soak-latest-1h-1.md', 'latest +4h failed new NoMethodError in meeting.rb', 'production +1h planned']);
  await run(d, "update prs set state = 'MERGED'");
  await run(d, "update ledger set status = 'done' where element != 'watch'");
  await run(d, "insert into timers (at, type, subject, data) values (?, 'soak.due', 'https://github.com/o/r/pull/1', ?)", now() + 3 * 3600e3, JSON.stringify({ stage: 'production', checkpoint: '1h' }));
  assert.equal((await progress(d, job)).wait, 'soak 1/5 · next production +1h in 3h');
});

test('5 pr rework: an open PR sent back to work leaves IN REVIEW until the rework rows are done', async () => {
  const j = await jobEnv();
  assert.equal(cli(j.env, 'job', 'new', '--on', 'worker', 'work', 'Fix it', '--title', 'rw').code, 0);
  const d = await j.db();
  await run(d, "update jobs set lead_mode = 'orchestrator'");
  const { progress } = await import('./jobs.mjs');
  const job = () => one(d, "select * from jobs where slug = 'rw'");
  await run(d, "update ledger set status = 'done' where element not in ('pr', 'watch')");
  await run(d, "update ledger set status = 'running' where element = 'pr'");
  assert.equal((await progress(d, await job())).phase, 'pr');
  assert.match(cli(j.env, 'pr', 'rework', '--job', 'rw').out, /--note/);
  assert.equal(cli(j.env, 'step', 'coder', 'start', '--job', 'rw').code, 0);
  assert.equal(cli(j.env, 'plan', 'add', 'review', '--job', 'rw').code, 0);
  const last = (await one(d, 'select max(seq) as s from ledger')).s;
  await run(d, "insert into ledger (job_id, seq, element, label, status) values (?, ?, 'watcher', 'imported', 'planned')", (await job()).id, last + 1);
  assert.equal((await progress(d, await job())).phase, 'pr');
  assert.match(cli(j.env, 'pr', 'rework', '--job', 'rw', '--note', 'cases were wrong').out, /pr row \d+ waits after row \d+ review/);
  assert.equal((await progress(d, await job())).phase, 'build');
  assert.equal(cli(j.env, 'step', 'coder', 'done', '--job', 'rw', '--note', 'c').code, 0);
  assert.equal((await progress(d, await job())).phase, 'review');
  assert.equal(cli(j.env, 'step', 'review', 'done', '--job', 'rw', '--note', 'r').code, 0);
  assert.equal((await progress(d, await job())).phase, 'pr');
  assert.match(cli(j.env, 'pr', 'rework', '--job', 'rw', '--note', 'again').out, /no PR in review/);
});

test('5 plan prune: a merged job drops its unfinished non-watch rows, keeps watch rows and --keep rows', async () => {
  const j = await jobEnv();
  assert.equal(cli(j.env, 'job', 'new', '--on', 'worker', 'work', 'Fix it', '--title', 'pr1').code, 0);
  const d = await j.db();
  const job = await one(d, "select * from jobs where slug = 'pr1'");
  const status = async () => Object.fromEntries((await all(d, 'select id, status from ledger where job_id = ?', job.id)).map(r => [r.id, r.status]));
  assert.match(cli(j.env, 'plan', 'prune', '--job', 'pr1', '--note', 'x').out, /no merged PR/);
  await run(d, "insert into prs (url, repo, number, job_id, state) values ('https://github.com/o/r/pull/9', 'o/r', 9, ?, 'MERGED')", job.id);
  assert.match(cli(j.env, 'plan', 'prune', '--job', 'pr1').out, /--note/);
  const rows = await all(d, 'select id, element from ledger where job_id = ?', job.id);
  const keep = rows.find(r => r.element === 'coder').id;
  await run(d, "update ledger set status = 'failed' where id = (select id from ledger where job_id = ? and element = 'review')", job.id);
  assert.equal(cli(j.env, 'plan', 'prune', '--job', 'pr1', '--keep', String(keep), '--note', 'merged').code, 0);
  const after = await status();
  assert.equal(after[keep], 'planned');
  for (const r of rows) assert.equal(after[r.id], r.id === keep || r.element === 'watch' ? 'planned' : 'dropped', `${r.element} ${r.id}`);
});

test('5 progress: a planned row left behind finished ones is not where the job is now', async () => {
  const j = await jobEnv();
  assert.equal(cli(j.env, 'job', 'new', '--on', 'worker', 'slim', 'Toy', '--title', 'hole').code, 0);
  const d = await j.db();
  const { progress } = await import('./jobs.mjs');
  const job = await one(d, "select * from jobs where slug = 'hole'");
  await run(d, "update ledger set status = 'done' where element in ('plan', 'gate')");
  assert.equal((await progress(d, job)).step, 'shipper');
  await run(d, "update ledger set status = 'failed' where element = 'shipper'");
  assert.equal((await progress(d, job)).step, 'shipper');
  await run(d, "update ledger set status = 'done' where element not in ('coder')");
  assert.equal((await progress(d, job)).step, 'coder');
});

const soakCtx = (d, headless, extra = {}) => ctxOf(d, { machine: 'server', online: async () => true, bugsnagAuthed: async () => true, headless, ...extra });

test('5 soak verdict: a chatty reply without the VERDICT line still reads the verdict from the report, which lands in the job\'s files', async () => {
  const d = await db();
  await run(d, "insert into jobs (slug, type, status, machine) values ('j', 'work', 'running', 'worker')");
  const soak = (await import('./handlers/soak.mjs')).default;
  const replies = [
    ['Next: want me to query Grafana?', '## Verdict\n\n**done-verified** for the latest stage at +1h.'],
    ['Verdict: **failed**, new NoMethodError in meeting.rb', ''],
    ['Want me to retry Grafana first?', '| Source | Verdict |\n|---|---|\n| Bugsnag | clean |'],
  ];
  const ctx = soakCtx(d, async (agent, prompt) => {
    const [out, report] = replies.shift();
    if (report) fs.writeFileSync(prompt.match(/Report path (\S+)\./)[1], report);
    return { out };
  });
  await dispatch(d, [soak], ctx);
  for (const checkpoint of ['1h', '4h', '24h']) await emit(d, 'soak.due', 'https://github.com/o/r/pull/1', { stage: 'latest', checkpoint, job: 'j', number: 1 });
  await dispatch(d, [soak], ctx);
  assert.deepEqual((await all(d, "select type, data from events where type like 'soak.%' and type != 'soak.due' order by id")).map(e => `${e.type} ${JSON.parse(e.data).verdict} ${JSON.parse(e.data).report}`),
    ['soak.clean done-verified soak-latest-1h-1.md', 'soak.signal failed null', 'soak.error error soak-latest-24h-1.md']);
  assert.deepEqual((await all(d, 'select name, created_by from files order by name')).map(f => `${f.name} ${f.created_by}`), ['soak-latest-1h-1.md factory-watcher', 'soak-latest-24h-1.md factory-watcher']);
});

test('5 soak brief: names the time the PR reached the stage', async () => {
  const d = await db();
  const soak = (await import('./handlers/soak.mjs')).default;
  await run(d, "insert into prs (url, number, production_at) values ('https://github.com/o/r/pull/2', 2, ?)", Date.UTC(2026, 9, 15, 6, 3));
  let brief;
  const ctx = soakCtx(d, async (agent, prompt) => { brief = prompt; return { out: 'VERDICT: done-verified' }; });
  await dispatch(d, [soak], ctx);
  await emit(d, 'soak.due', 'https://github.com/o/r/pull/2', { stage: 'production', checkpoint: '1h', job: 'j', number: 2 });
  await dispatch(d, [soak], ctx);
  assert.match(brief, /since it reached production at 2026-10-15T06:03:00\.000Z/);
  assert.match(brief, /tb-bug errors --project r --stage production/);
  assert.match(brief, /never makes the verdict unverified/);
});

test('5 soak error: a check that could not run retries on a timer, the third error gives up as a signal', async () => {
  const d = await db();
  const soak = (await import('./handlers/soak.mjs')).default;
  const ctx = soakCtx(d, async () => ({ out: 'ENOTFOUND. VERDICT: error' }));
  await dispatch(d, [soak], ctx);
  const due = { stage: 'latest', checkpoint: '1h', job: 'j', number: 1 };
  const url = 'https://github.com/o/r/pull/1';
  for (let i = 0; i < 3; i++) {
    await emit(d, 'soak.due', url, due);
    await dispatch(d, [soak], ctx);
  }
  assert.deepEqual((await all(d, "select type from events where type in ('soak.error', 'soak.signal') order by id")).map(e => e.type), ['soak.error', 'soak.error', 'soak.error']);
  await emit(d, 'soak.due', url, due);
  await dispatch(d, [soak], ctx);
  assert.equal((await one(d, "select type from events where type like 'soak.%' order by id desc limit 1")).type, 'soak.signal');
  assert.equal((await one(d, "select count(*) as n from timers where type = 'soak.due' and fired_at is null")).n, 3);
});

test('5 soak auth: a dead Bugsnag token spends no watcher and takes the error retry path', async () => {
  const d = await db();
  const soak = (await import('./handlers/soak.mjs')).default;
  let runs = 0;
  const ctx = soakCtx(d, async () => (runs++, { out: 'VERDICT: done-verified' }), { bugsnagAuthed: async () => false });
  await dispatch(d, [soak], ctx);
  await emit(d, 'soak.due', 'https://github.com/o/r/pull/1', { stage: 'latest', checkpoint: '1h', job: 'j', number: 1 });
  await dispatch(d, [soak], ctx);
  assert.deepEqual([runs, (await one(d, "select type from events where type like 'soak.%' order by id desc limit 1")).type], [0, 'soak.error']);
  assert.equal((await one(d, "select count(*) as n from timers where type = 'soak.due' and fired_at is null")).n, 1);
});

test('5 soak offline: no check while offline, a result that is not clean after the network dropped is thrown away, both retry', async () => {
  const d = await db();
  const soak = (await import('./handlers/soak.mjs')).default;
  const net = [false, true, false, true, true];
  const runs = [];
  const ctx = soakCtx(d, async () => {
    runs.push(runs.length);
    return { out: runs.length === 1 ? 'tb-bug: getaddrinfo ENOTFOUND. VERDICT: done-unverified' : 'VERDICT: done-verified' };
  }, { online: async () => net.shift() });
  await dispatch(d, [soak], ctx);
  await emit(d, 'soak.due', 'https://github.com/o/r/pull/1', { stage: 'latest', checkpoint: '1h', job: 'j', number: 1 });
  const results = async () => (await all(d, "select type from events where type in ('soak.clean', 'soak.signal')")).map(e => e.type);
  await dispatch(d, [soak], ctx);
  assert.deepEqual([runs.length, await results()], [0, []]);
  await dispatch(d, [soak], ctx);
  assert.deepEqual([runs.length, await results()], [1, []]);
  await dispatch(d, [soak], ctx);
  assert.deepEqual([runs.length, await results()], [2, ['soak.clean']]);
});

test('5 soak dropped: a checkpoint whose watch row was dropped does not run', async () => {
  const d = await db();
  const soak = (await import('./handlers/soak.mjs')).default;
  const runs = [];
  const ctx = soakCtx(d, async () => (runs.push(1), { out: 'VERDICT: done-verified' }));
  await dispatch(d, [soak], ctx);
  await run(d, "insert into jobs (slug, type, lead_mode, status, machine) values ('j', 'work', 'orchestrator', 'done', 'worker')");
  await run(d, "insert into ledger (job_id, seq, element, label, status) values (1, 1, 'watch', 'latest +1h', 'dropped'), (1, 2, 'watch', 'latest +4h', 'planned')");
  await emit(d, 'soak.due', 'https://github.com/o/r/pull/1', { stage: 'latest', checkpoint: '1h', job: 'j', number: 1 });
  await emit(d, 'soak.due', 'https://github.com/o/r/pull/1', { stage: 'latest', checkpoint: '4h', job: 'j', number: 1 });
  await dispatch(d, [soak], ctx);
  assert.equal(runs.length, 1);
  assert.deepEqual((await all(d, "select json_extract(data, '$.checkpoint') as c from events where type in ('soak.clean', 'soak.signal', 'soak.error')")).map(e => e.c), ['4h']);
});

test('5 soak inert: a PR touching only specs, docs or lint config soaks clean without a watcher; one runtime file brings it back', async () => {
  const d = await db();
  const soak = (await import('./handlers/soak.mjs')).default;
  const files = { 1: ['spec/models/a_spec.rb', 'knowledge/x.md', '.rubocop-base.yml'], 2: ['spec/models/a_spec.rb', 'app/models/a.rb'] };
  const runs = [];
  const ctx = soakCtx(d, async () => (runs.push(1), { out: 'VERDICT: done-verified' }), { changedFiles: async url => files[url.split('/').pop()] });
  await dispatch(d, [soak], ctx);
  for (const n of [1, 2]) await emit(d, 'soak.due', `https://github.com/o/r/pull/${n}`, { stage: 'latest', checkpoint: '1h', job: 'j', number: n });
  await dispatch(d, [soak], ctx);
  assert.equal(runs.length, 1);
  assert.deepEqual((await all(d, "select subject from events where type = 'soak.clean' order by id")).map(e => e.subject.split('/').pop()), ['1', '2']);
});

test('5 soak outage: a session limit is not a soak error; the checkpoint retries on a timer', async () => {
  const d = await db();
  const soak = (await import('./handlers/soak.mjs')).default;
  const ctx = soakCtx(d, async () => ({ out: "You've hit your session limit · resets 2:30pm (Europe/Zagreb)" }));
  await dispatch(d, [soak], ctx);
  for (let i = 0; i < 4; i++) {
    await emit(d, 'soak.due', 'https://github.com/o/r/pull/1', { stage: 'latest', checkpoint: '1h', job: 'j', number: 1 });
    await dispatch(d, [soak], ctx);
  }
  assert.equal((await one(d, "select count(*) as n from events where type in ('soak.error', 'soak.signal', 'soak.clean')")).n, 0);
  assert.equal((await one(d, "select count(*) as n from timers where type = 'soak.due' and fired_at is null")).n, 4);
});

test('5 soak extend: a done job gets daily checkpoints after the past ones, and its report lands in its files', async () => {
  const { soakExtend } = await import('./jobs.mjs');
  const d = await db();
  const url = 'https://github.com/o/r/pull/1';
  const prod = now() - 2.5 * 86400e3;
  await run(d, "insert into jobs (slug, type, lead_mode, status, machine) values ('j', 'work', 'orchestrator', 'done', 'worker')");
  await run(d, "insert into ledger (job_id, seq, element, label, status) values (1, 1, 'watch', 'production +1h', 'done'), (1, 2, 'watch', 'production +24h', 'done')");
  await run(d, "insert into prs (url, number, job_id, state, production_at) values (?, 1, 1, 'MERGED', ?)", url, Math.round(prod));
  await soakExtend(d, ['--job', 'j', '--to', '4d']);
  await soakExtend(d, ['--job', 'j', '--to', '4d']);
  assert.deepEqual((await all(d, "select label from ledger where element = 'watch' order by seq")).map(r => r.label), ['production +1h', 'production +24h', 'production +3d', 'production +4d']);
  assert.deepEqual((await all(d, "select at, json_extract(data, '$.checkpoint') as c from timers order by at")).map(t => [t.at - Math.round(prod), t.c]), [[3 * 86400e3, '3d'], [4 * 86400e3, '4d']]);
  await assert.rejects(soakExtend(d, ['--job', 'j', '--to', '2w']), /usage/);
  const soak = (await import('./handlers/soak.mjs')).default;
  const ctx = soakCtx(d, async (agent, prompt) => { fs.writeFileSync(prompt.match(/Report path (\S+)\./)[1], 'clean'); return { out: 'VERDICT: done-verified' }; });
  await dispatch(d, [soak], ctx);
  await emit(d, 'soak.due', url, { stage: 'production', checkpoint: '3d', job: 'j', number: 1 });
  await dispatch(d, [soak], ctx);
  assert.equal(JSON.parse((await one(d, "select data from events where type = 'soak.clean'")).data).report, 'soak-production-3d-1.md');
  assert.equal((await one(d, "select body from files where name = 'soak-production-3d-1.md'")).body, 'clean');
});

test('5 prompted: Stef prompting a job session clears that job\'s plate items; factory messages and other jobs do not', async () => {
  const url = await fresh();
  const d = await openAt(url);
  const ws = path.join(os.homedir(), 'dev/productive/work/workspaces');
  await run(d, "insert into jobs (slug, type, lead_mode, lead_session, status, machine) values ('meet', 'project', 'writer', 'S1', 'running', 'worker'), ('other', 'work', 'orchestrator', 'S2', 'running', 'worker')");
  await run(d, "insert into prs (url, job_id, state) values ('https://github.com/o/r/pull/1', 1, 'MERGED'), ('https://github.com/o/r/pull/2', 2, 'OPEN')");
  await run(d, "insert into plate (kind, subject, text, created_at) values ('soak-signal', 'https://github.com/o/r/pull/1', 'x', 1), ('lead-missing', 'meet', 'y', 1), ('soak-signal', 'https://github.com/o/r/pull/2', 'z', 1), ('unregistered', 'https://github.com/o/r/pull/3', 'w', 1)");
  const open_ = async () => (await all(d, 'select id from plate where cleared_at is null order by id')).map(p => p.id);
  const prompted = input => inChild({ FACTORY_DATABASE_URL: url }, `import { prompted } from './hooks.mjs'; console.log(JSON.stringify(await prompted(${JSON.stringify(input)})));`).stdout.trim();
  assert.equal(prompted({ session_id: 'S1', cwd: path.join(ws, 'meet'), prompt: 'From factory [m-1]: soak signal' }), '[]');
  assert.equal(prompted({ session_id: 'S1', cwd: path.join(ws, 'meet'), prompt: 'look at it', agent_id: 'sub' }), '[]');
  assert.deepEqual(await open_(), [1, 2, 3, 4]);
  assert.equal(prompted({ session_id: 'S9', cwd: path.join(ws, 'meet'), prompt: 'rerun grafana once the vpn is up' }), '[1,2]');
  assert.deepEqual(await open_(), [3, 4]);
  assert.deepEqual((await all(d, "select json_extract(data, '$.by') as by from events where type = 'plate.cleared'")).map(e => e.by), ['prompt', 'prompt']);
});

test('11 soak rerun: a fired checkpoint is queued again as a live soak.due, an unfired one is refused', async () => {
  const { action } = await import('./web.mjs');
  const d = await db();
  const url = 'https://github.com/o/r/pull/9';
  await run(d, "insert into timers (at, type, subject, data, fired_at) values (1, 'soak.due', ?, ?, 2), (3, 'soak.due', ?, ?, null)",
    url, JSON.stringify({ stage: 'latest', checkpoint: '1h', job: 'j', number: 9, imported: true }), url, JSON.stringify({ stage: 'latest', checkpoint: '4h', job: 'j', number: 9 }));
  await assert.rejects(action(d, '/soak/2/rerun'), /has not run yet/);
  assert.match(await action(d, '/soak/1/rerun'), /latest \+1h on .*pull\/9 queued again/);
  assert.deepEqual((await all(d, "select subject, data from events where type = 'soak.due'")).map(e => [e.subject, JSON.parse(e.data)]),
    [[url, { stage: 'latest', checkpoint: '1h', job: 'j', number: 9, rerun: true }]]);
  await run(d, "insert into plate (kind, subject, text) values ('soak-signal', ?, ?), ('merge-ready', ?, 'x')", url, `Soak check latest +1h on ${url} could not confirm clean (no verdict).`, url);
  await assert.rejects(action(d, '/plate/2/rerun'), /not an open soak signal/);
  assert.match(await action(d, '/plate/1/rerun'), /latest \+1h on .*pull\/9 queued again/);
  assert.ok((await one(d, 'select cleared_at from plate where id = 1')).cleared_at);
  await assert.rejects(action(d, '/plate/1/rerun'), /not an open soak signal/);
  assert.equal((await one(d, "select count(*) as n from events where type = 'soak.due'")).n, 2);
});

test('11 schedule run: queues a live timer.due for the schedule\'s machine and clears its failed card', async () => {
  const { action } = await import('./web.mjs');
  const d = await db();
  await run(d, "insert into plate (kind, subject, text) values ('schedule-failed', 'retro', 'x'), ('schedule-failed', 'backup', 'y')");
  await assert.rejects(action(d, '/schedule/nope/run'), /no schedule nope/);
  assert.match(await action(d, '/schedule/retro/run'), /retro queued; the server's scheduler/);
  assert.deepEqual((await all(d, "select subject, json_extract(data, '$.action') as action, json_extract(data, '$.machine') as machine from events where type = 'timer.due'")).map(e => [e.subject, e.action, e.machine]),
    [['retro', (await one(d, "select action from schedules where name = 'retro'")).action, 'server']]);
  assert.deepEqual((await all(d, 'select subject from plate where cleared_at is null')).map(p => p.subject), ['backup']);
});

test('11 daily: tokens per day, model and machine from transcripts, read once then only new bytes; days() sums both machines', async () => {
  const { tracker, record, dayOf } = await import('./pollers/daily.mjs');
  const { days } = await import('./web.mjs');
  const root = home();
  const file = path.join(root, 'proj', 'sess', 'subagents', 'a.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const today = new Date().setHours(12, 0, 0, 0);
  const line = (id, model, ts, out) => JSON.stringify({ timestamp: new Date(ts).toISOString(), message: { id, model, usage: { input_tokens: 1, output_tokens: out, cache_creation_input_tokens: 10, cache_read_input_tokens: 9999 } } });
  fs.writeFileSync(file, [line('m1', 'claude-opus-5-5', today - 86400e3, 100), line('m2', 'claude-sonnet-5-5', today, 200), line('m2', 'claude-sonnet-5-5', today, 200), '{"timestamp":"half'].join('\n'));
  const d = await db();
  const scan = tracker(root);
  await record(d, await scan(), { five_hour: { utilization: 40 }, seven_day: { utilization: 50 } }, today);
  await record(d, [], { five_hour: { utilization: 20 }, seven_day: { utilization: 55 } }, today);
  fs.appendFileSync(file, `-line"}\n${line('m3', 'claude-sonnet-5-5', today, 1000)}\n`);
  await record(d, await scan());
  await record(d, [[dayOf(today), { sonnet: 8 }]], { five_hour: { utilization: 60 }, seven_day: { utilization: 54 } }, today, 'server');
  const rows = (await all(d, 'select day, key, machine, value from daily order by day, key, machine')).map(r => `${r.day} ${r.key} ${r.machine} ${r.value}`);
  assert.deepEqual(rows, [`${dayOf(today - 86400e3)} tokens.opus worker 111`, `${dayOf(today)} tokens.sonnet server 8`, `${dayOf(today)} tokens.sonnet worker 1222`,
    `${dayOf(today)} usage.5h server 60`, `${dayOf(today)} usage.5h worker 40`, `${dayOf(today)} usage.7d server 54`, `${dayOf(today)} usage.7d worker 55`]);
  const [t, y] = await days(d);
  assert.deepEqual([t.tokens, t['usage.5h'], t['usage.7d'], y.tokens], [{ sonnet: 1230 }, 60, 55, { opus: 111 }]);
});

test('5 guard: orchestrator writes blocked, writer only inside its workspace, nobody commits', async () => {
  const j = await jobEnv();
  cli(j.env, 'job', 'new', '--on', 'worker', 'slim', 'toy', '--title', 'orch');
  cli(j.env, 'job', 'new', '--on', 'worker', 'research', 'toy', '--title', 'wri');
  const d = await j.db();
  await run(d, "update jobs set lead_mode = case slug when 'orch' then 'orchestrator' else 'writer' end");
  const ws = slug => path.join(j.work, 'workspaces', slug);
  const g = (input, extra = {}) => {
    const r = spawnSync(process.execPath, ['--no-warnings', path.join(DIR, 'factory.mjs'), 'guard'], { env: { ...process.env, ...j.env, ...extra }, input: JSON.stringify(input), encoding: 'utf8' });
    return r.status === 2 ? r.stderr : null;
  };
  const orch = { session_id: 's-o', agent_type: 'lead-orchestrator', cwd: ws('orch'), hook_event_name: 'PreToolUse' };
  const wri = { session_id: 's-w', agent_type: 'lead-writer', cwd: ws('wri'), hook_event_name: 'PreToolUse' };
  assert.match(g({ ...orch, tool_name: 'Write', tool_input: { file_path: path.join(ws('orch'), 'x.md') } }), /orchestrator lead never writes/);
  assert.equal(g({ ...wri, tool_name: 'Write', tool_input: { file_path: path.join(ws('wri'), 'r1.md') } }), null);
  assert.match(g({ ...wri, tool_name: 'Write', tool_input: { file_path: path.join(ws('wri'), '.factory', 'wri', 'r1.md') } }), /factory file put/);
  assert.match(g({ session_id: 'x', agent_id: 'a9', agent_type: 'factory-coder', cwd: ws('orch'), tool_name: 'Edit', tool_input: { file_path: path.join(ws('orch'), '.factory', 'orch', 'coder-1.md') } }), /factory file put/);
  assert.match(g({ ...wri, tool_name: 'Edit', tool_input: { file_path: path.join(os.homedir(), 'CLAUDE.md') } }), /only inside its own workspace/);
  assert.match(g({ ...orch, tool_name: 'Bash', tool_input: { command: 'npm test' } }), /not on the read-only list/);
  assert.equal(g({ ...orch, tool_name: 'Bash', tool_input: { command: "factory gate open gate2 <<'EOF'\n| a | b |\ngit push; rm -rf x\nEOF" } }), null);
  assert.equal(g({ ...orch, tool_name: 'Bash', tool_input: { command: 'git -C repos/api log --oneline | head -3 2>/dev/null' } }), null);
  assert.equal(g({ ...orch, tool_name: 'Bash', tool_input: { command: 'factory status && factory poll' } }), null);
  const orchBash = command => g({ ...orch, tool_name: 'Bash', tool_input: { command } });
  assert.equal(orchBash("factory gate open ready --pr https://github.com/o/r/pull/1 --body \"$(cat <<'EOF'\n**Ready gate** `bin/x` (y)\nEOF\n)\""), null);
  assert.equal(orchBash('for r in 1 2 3; do factory plan drop $r --note "no soak"; done; factory job done'), null);
  assert.equal(orchBash('factory rerun --note "x"; ps aux | rg spring; pgrep -fl spring; uptime; f=$(ls x | head -1); [ -f "$f" ] && cat "$f"'), null);
  assert.equal(orchBash('factory soak extend --to 14d'), null);
  assert.equal(orchBash('factory file cat coder-1.md; factory file ls; factory message --to glados "start x"'), null);
  assert.match(orchBash('factory file put x.md <<\'EOF\'\nhi\nEOF'), /factory file is not a lead command/);
  assert.equal(orchBash('factory gate decided gate2 changes --words "also, use \\`latest.productive.io\\`"'), null);
  assert.match(orchBash('factory gate open g <<EOF\nrun `rm -rf x`\nEOF'), /cannot read/);
  assert.match(orchBash('echo "$(git push origin x)"'), /commits or pushes/);
  assert.match(orchBash('x=$(rm -rf y)'), /rm is not on the read-only list/);
  assert.match(orchBash('while kill -0 1; do sleep 1; done'), /kill is not on the read-only list/);
  assert.match(g({ session_id: 'x', agent_id: 'a4', agent_type: 'factory-coder', cwd: ws('orch'), tool_name: 'Bash', tool_input: { command: 'echo "$(git commit -m x)"' } }), /only the shipper/);
  assert.match(g({ ...wri, tool_name: 'Bash', tool_input: { command: 'factory gate decided feedback accepted --words "do A, we can fix the twins with a data migration, right?"' } }), /end in a question/);
  assert.equal(g({ ...wri, tool_name: 'Bash', tool_input: { command: 'factory gate decided feedback changes --words "what about those 313 future rows?"' } }), null);
  assert.equal(g({ ...orch, tool_name: 'Bash', tool_input: { command: 'factory gate decided merge approved --words "merge"' } }), null);
  assert.match(g({ ...wri, tool_name: 'Bash', tool_input: { command: 'cd x && git commit -m y' } }), /only the shipper commits/);
  assert.equal(g({ ...wri, tool_name: 'Bash', tool_input: { command: 'node build.mjs > out.html' } }), null);
  assert.match(g({ session_id: 'x', agent_id: 'a1', agent_type: 'factory-coder', cwd: ws('orch'), tool_name: 'Bash', tool_input: { command: 'git push origin HEAD' } }), /only the shipper/);
  assert.match(g({ session_id: 'x', agent_id: 'a3', agent_type: 'factory-tester', cwd: ws('orch'), tool_name: 'Bash', tool_input: { command: 'cd api; mysql -h127.0.0.1 -uroot gauss_development -e "alter table accounts add column features text null"' } }), /shared database/);
  assert.match(g({ session_id: 'x', agent_id: 'a3', agent_type: 'factory-tester', cwd: ws('orch'), tool_name: 'Bash', tool_input: { command: 'bin/rails runner "ActiveRecord::Base.connection.execute(%q(insert into data_migrations (version) values (1)))"' } }), /shared database/);
  assert.equal(g({ session_id: 'x', agent_id: 'a3', agent_type: 'factory-tester', cwd: ws('orch'), tool_name: 'Bash', tool_input: { command: 'mysql -uroot gauss_development -e "select * from data_migrations limit 1"' } }), null);
  assert.equal(g({ session_id: 'x', agent_id: 'a3', agent_type: 'factory-coder', cwd: ws('orch'), tool_name: 'Bash', tool_input: { command: 'rg "drop table" db/migrate' } }), null);
  assert.match(g({ session_id: 'x', agent_id: 'a2', agent_type: 'factory-shipper', cwd: ws('orch'), tool_name: 'Bash', tool_input: { command: 'gh pr merge 5 --squash' } }), /needs an approved merge gate/);
  assert.match(g({ session_id: 'x', agent_id: 'a2', agent_type: 'factory-shipper', cwd: '/elsewhere', tool_name: 'Bash', tool_input: { command: 'gh pr merge 5 --squash' } }), /never done by an agent/);
  assert.equal(g({ session_id: 'x', agent_id: 'a2', agent_type: 'factory-shipper', cwd: ws('orch'), tool_name: 'Bash', tool_input: { command: 'git push origin feature' } }), null);
  assert.equal(g({ session_id: 'plain', cwd: j.work, tool_name: 'Write', tool_input: { file_path: '/etc/x' } }), null);
  await run(d, "update jobs set lead_session = 'bound' where slug = 'orch'");
  assert.match(g({ session_id: 'bound', cwd: '/elsewhere', tool_name: 'Write', tool_input: { file_path: '/tmp/x' } }), /orchestrator lead never writes/);
});

test('5 guard: with the factory DB out of reach, edits and tests go on but merge, push, commit, PR edits and posting stay blocked', async () => {
  const down = { FACTORY_DATABASE_URL: 'postgres://factory@127.0.0.1:1/factory' };
  const g = input => {
    const r = spawnSync(process.execPath, ['--no-warnings', path.join(DIR, 'factory.mjs'), 'guard'], { env: { ...process.env, ...down }, input: JSON.stringify(input), encoding: 'utf8' });
    return r.status === 2 ? r.stderr : null;
  };
  const lead = { session_id: 's-l', cwd: '/tmp/ws', hook_event_name: 'PreToolUse' };
  const bash = command => g({ ...lead, tool_name: 'Bash', tool_input: { command } });
  assert.equal(g({ ...lead, tool_name: 'Edit', tool_input: { file_path: '/tmp/ws/app.rb' } }), null);
  assert.equal(bash('bundle exec rspec spec/x_spec.rb'), null);
  assert.match(bash('gh pr merge 7 --squash --match-head-commit abcdef1'), /merging is never done by an agent/);
  assert.match(bash('git commit -m x'), /approved Gate 2/);
  assert.match(bash('git push origin x'), /approved Gate 2/);
  assert.match(bash('gh pr ready 7'), /approved ready gate/);
  assert.match(bash('gh pr comment 7 --body hi'), /posting comments/);
});

test('5 files: put, cat and ls keep a job\'s reports in the DB; bad names are refused', async () => {
  const j = await jobEnv();
  assert.equal(cli(j.env, 'job', 'new', '--on', 'worker', 'slim', 'toy', '--title', 'fl').code, 0);
  const ws = path.join(j.work, 'workspaces', 'fl');
  const f = (input, ...a) => spawnSync(process.execPath, ['--no-warnings', path.join(DIR, 'factory.mjs'), 'file', ...a], { env: { ...process.env, ...j.env }, cwd: ws, input, encoding: 'utf8' });
  assert.equal(f('# Coder\nall green', 'put', 'coder-1.md').status, 0);
  assert.equal(f('green\n', 'put', 'evidence/AC1-head.txt').status, 0);
  assert.equal(f('# Coder\nround 2', 'put', './coder-1.md').status, 0);
  assert.match(f('x', 'put', '../escape.md').stderr, /file names are relative/);
  assert.match(f('x', 'put', '/abs.md').stderr, /file names are relative/);
  assert.match(f('', 'put', 'empty.md').stderr, /content on stdin/);
  assert.equal(f(undefined, 'cat', 'coder-1.md').stdout, '# Coder\nround 2');
  assert.match(f(undefined, 'cat', 'nope.md').stderr, /no file nope\.md/);
  assert.match(f(undefined, 'ls').stdout, /^coder-1\.md\s+15 .*\nevidence\/AC1-head\.txt\s+6 /);
  assert.match(cli(j.env, 'job', 'show', '--job', 'fl').out, /2 so far: coder-1\.md, evidence\/AC1-head\.txt/);
});

test('5 loop lead: model pinned per type, writes inside its workspace, commits wait for gate2, done steps check the job\'s files', async () => {
  const j = await jobEnv();
  assert.equal(cli(j.env, 'job', 'new', '--on', 'worker', 'work', 'toy', '--title', 'lp').code, 0);
  assert.equal(cli(j.env, 'job', 'new', '--on', 'worker', 'research', 'toy', '--title', 'rs').code, 0);
  const ws = slug => path.join(j.work, 'workspaces', slug);
  const settings = slug => JSON.parse(fs.readFileSync(path.join(ws(slug), '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(settings('lp'), { model: 'sonnet', effortLevel: 'medium' });
  assert.deepEqual(settings('rs'), { model: 'opus', effortLevel: 'high' });
  const factory = (input, ...a) => spawnSync(process.execPath, ['--no-warnings', path.join(DIR, 'factory.mjs'), ...a], { env: { ...process.env, ...j.env }, cwd: ws('lp'), input, encoding: 'utf8' });
  const g = input => { const r = factory(JSON.stringify(input), 'guard'); return r.status === 2 ? r.stderr : null; };
  const lead = { session_id: 's-l', agent_type: 'lead-loop', cwd: ws('lp'), hook_event_name: 'PreToolUse' };
  assert.equal(g({ ...lead, tool_name: 'Edit', tool_input: { file_path: path.join(ws('lp'), 'api', 'app.rb') } }), null);
  assert.match(g({ ...lead, tool_name: 'Write', tool_input: { file_path: path.join(os.homedir(), 'CLAUDE.md') } }), /loop lead writes only inside/);
  const bash = command => g({ ...lead, tool_name: 'Bash', tool_input: { command } });
  assert.equal(bash('cd api && bundle exec rspec spec/x_spec.rb > out.txt'), null);
  assert.match(bash('git commit -m x'), /approved Gate 2/);
  assert.match(bash('gh pr create --draft --title T'), /approved Gate 2/);
  assert.match(bash('gh pr merge 1 --squash'), /merge gate/);
  assert.match(bash('mysql -uroot x -e "drop table accounts"'), /shared database/);
  factory(undefined, 'gate', 'open', 'gate2', '--body', 'ship?');
  factory(undefined, 'gate', 'decided', 'gate2', 'approved', '--words', 'ship it');
  assert.equal(bash('git commit -m x && git push origin lp'), null);
  const out = r => r.stdout + r.stderr;
  const put = (name, body) => factory(body, 'file', 'put', name);
  put('triage-1.md', 'route clear');
  assert.match(out(factory(undefined, 'step', 'triage', 'done', '--note', 'clear')), /refused: .*factory file put/);
  put('criteria.md', '| # | Criterion | Kind | Source |\n|---|---|---|---|\n| AC1 | x works | test | task |\n');
  assert.equal(factory(undefined, 'step', 'triage', 'done', '--note', 'clear, triage-1.md').status, 0);
  put('coder-1.md', 'no table');
  assert.match(out(factory(undefined, 'step', 'coder', 'done', '--note', 'coder-1.md')), /no row for AC1/);
  put('coder-1.md', '| # | Criterion | Base | Head | Evidence | Verdict |\n|---|---|---|---|---|---|\n| AC1 | x | red | green | evidence/AC1-head.txt | holds |\n');
  assert.match(out(factory(undefined, 'step', 'coder', 'done', '--note', 'coder-1.md')), /AC1 cites no evidence file/);
  put('evidence/AC1-head.txt', 'green');
  assert.equal(factory(undefined, 'step', 'coder', 'done', '--note', 'coder-1.md').status, 0);
});

test('5 rerun: a done job with an open gate is running again at its new plan', async () => {
  const j = await jobEnv();
  cli(j.env, 'job', 'new', '--on', 'worker', 'slim', 'toy', '--title', 'redo');
  const d = await j.db();
  await run(d, "update jobs set status = 'done', done_at = 1 where slug = 'redo'");
  await run(d, "insert into gates (job_id, name, body, status, opened_at) values ((select id from jobs where slug = 'redo'), 'ready', 'x', 'open', 1)");
  cli(j.env, 'plan', 'add', 'gate', '--label', 'scope', '--job', 'redo');
  cli(j.env, 'gate', 'open', 'scope', '--body', 'keep?', '--job', 'redo');
  cli(j.env, 'rerun', '--job', 'redo', '--note', 'fresh develop');
  assert.deepEqual({ ...await one(d, "select status, done_at from jobs where slug = 'redo'") }, { status: 'running', done_at: null });
  assert.deepEqual((await all(d, "select name from gates where status = 'open'")).map(g => g.name), ['scope']);
  assert.doesNotMatch(cli(j.env, 'job', 'show', '--job', 'redo').out, /now: gate:ready/);
});

test('5 hooks: stuck after 3 identical failures, validator rejects a report without verdict or with a missing report', async () => {
  const j = await jobEnv();
  assert.equal(cli(j.env, 'job', 'new', '--on', 'worker', 'slim', 'toy', '--title', 'hk').code, 0);
  const ws = path.join(j.work, 'workspaces', 'hk');
  const hook = (cmd, input) => spawnSync(process.execPath, ['--no-warnings', path.join(DIR, 'factory.mjs'), cmd], { env: { ...process.env, ...j.env }, input: JSON.stringify(input), encoding: 'utf8' });
  const call = { agent_id: 'c1', agent_type: 'factory-coder', session_id: 's', cwd: ws, tool_name: 'Bash', tool_input: { command: 'rspec x' } };
  for (let i = 0; i < 3; i++) hook('track', { ...call, hook_event_name: 'PostToolUseFailure' });
  assert.match(hook('guard', call).stderr, /STUCK/);
  hook('track', { ...call, tool_name: 'Edit', hook_event_name: 'PostToolUse', tool_input: { file_path: '/tmp/a' } });
  assert.equal(hook('guard', call).status, 0);
  const v = hook('validate', { ...call, hook_event_name: 'SubagentStop', last_assistant_message: 'all done' });
  assert.equal(v.status, 2);
  assert.match(v.stderr, /VERDICT/);
  assert.match(hook('validate', { ...call, agent_id: 'c2', hook_event_name: 'SubagentStop', last_assistant_message: 'VERDICT: failed\nReport: coder-1.md' }).stderr, /factory file put <name>\.md/);
  spawnSync(process.execPath, ['--no-warnings', path.join(DIR, 'factory.mjs'), 'file', 'put', 'coder-1.md'], { env: { ...process.env, ...j.env }, cwd: ws, input: 'x', encoding: 'utf8' });
  assert.equal(hook('validate', { ...call, agent_id: 'c3', hook_event_name: 'SubagentStop', last_assistant_message: 'VERDICT: failed\nReport: coder-1.md' }).status, 0);
  assert.match(hook('orders', { agent_type: 'factory-coder' }).stdout, /STANDING ORDERS/);
  assert.equal(hook('orders', { agent_type: 'worker-haiku' }).stdout, '');
});

test('6 messages: delivered once in the transcript, waits for a missing lead, fails after 3 tries; GLaDOS gets hers on her machine', async () => {
  const h = home();
  const trans = path.join(h, 'projects', '-ws');
  fs.mkdirSync(trans, { recursive: true });
  const lands = path.join(h, 'lands.sh');
  fs.writeFileSync(lands, `#!/bin/sh\nprintf '%s\\n' "$2" >> ${JSON.stringify(trans)}/$1.jsonl\n`);
  fs.chmodSync(lands, 0o755);
  await withEnv({ FACTORY_PROJECTS: path.join(h, 'projects'), FACTORY_CONFIRM_MS: '300' }, async () => {
    const { default: poller, queue, queueTo } = await import('./pollers/messages.mjs');
    const missing = (await import('./handlers/lead-missing.mjs')).default;
    const bind = (await import('./handlers/lead-bind.mjs')).default;
    const d = await db();
    await dispatch(d, [missing, bind]);
    const ctx = ctxOf(d);
    const job = slug => one(d, 'select * from jobs where slug = ?', slug);
    for (const [slug, sid] of [['a', 's-a'], ['b', 's-b']]) {
      await run(d, "insert into jobs (slug, type, lead_mode, lead_session, status, machine) values (?, 'slim', 'orchestrator', ?, 'running', 'worker')", slug, sid);
      await run(d, "insert into sessions (session_id, name, status, status_at, machine) values (?, ?, 'busy', 0, 'worker')", sid, sid);
    }
    await queue(ctx, await job('a'), 'CI failed on x');
    await queue(ctx, await job('b'), 'review on y');
    process.env.FACTORY_SEND = lands;
    await run(d, "update sessions set closed_at = 1, status = 'closed' where session_id = 's-b'");
    await emit(d, 'session.closed', 's-b');
    await poller.run(ctxOf(d, { machine: 'server' }));
    const status = async () => (await all(d, 'select j.slug, m.status, m.attempts from messages m join jobs j on j.id = m.job_id order by m.id')).map(r => `${r.slug} ${r.status} ${r.attempts}`);
    assert.deepEqual(await status(), ['a queued 0', 'b queued 0']);
    await poller.run(ctx);
    await dispatch(d, [missing, bind]);
    assert.deepEqual(await status(), ['a delivered 1', 'b queued 0']);
    assert.deepEqual((await all(d, 'select kind, subject from plate where cleared_at is null')).map(r => `${r.kind} ${r.subject}`), ['lead-missing b']);
    await run(d, "update jobs set lead_session = 's-b2' where slug = 'b'");
    await run(d, "insert into sessions (session_id, name, status, status_at, machine) values ('s-b2', 's-b2', 'idle', 0, 'worker')");
    await emit(d, 'job.started', 'b', { session: 's-b2' });
    await dispatch(d, [missing, bind]);
    assert.equal((await one(d, 'select count(*) as n from plate where cleared_at is null')).n, 0);
    process.env.FACTORY_SEND = '/usr/bin/true';
    for (let tick = 1; tick <= 3; tick++) {
      await poller.run(ctx);
      assert.deepEqual((await status())[1], tick < 3 ? `b queued ${tick}` : 'b failed 3');
    }
    assert.match((await one(d, "select text from plate where kind = 'message-failed'")).text, /after 3 tries/);
    process.env.FACTORY_SEND = lands;
    await run(d, "insert into sessions (session_id, name, status, status_at, machine) values ('g-1', 'glados', 'idle', 0, 'server')");
    await queueTo(ctx, 'g-1', 'project x wants a job for y');
    await poller.run(ctx);
    assert.equal((await one(d, "select status from messages where session_id = 'g-1'")).status, 'queued');
    await poller.run(ctxOf(d, { machine: 'server' }));
    assert.equal((await one(d, "select status from messages where session_id = 'g-1'")).status, 'delivered');
    assert.match(fs.readFileSync(path.join(trans, 'g-1.jsonl'), 'utf8'), /From factory \[m-\w+\]: project x wants a job for y/);
    delete process.env.FACTORY_SEND;
  });
});

const PR = 'https://github.com/o/r/pull/7';
const view = (over = {}) => ({ number: 7, url: PR, title: 'T', state: 'OPEN', isDraft: false, headRefOid: 'aaa', mergeable: 'MERGEABLE', reviewDecision: 'REVIEW_REQUIRED', reviews: [], statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: 'IN_PROGRESS' }], ...over });
const check = conclusion => [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion, detailsUrl: 'https://ci/1' }];

test('7 github diff: CI, reviews, conflict, merge-ready, merged from gh fixtures', async () => {
  const { diffPr } = await import('./pollers/github.mjs');
  let seen = {};
  const step = v => { const r = diffPr(seen, v, 'stef'); seen = r.seen; return r.events.map(e => e.type); };
  assert.deepEqual(step(view({ isDraft: true })), []);
  assert.deepEqual(step(view()), ['pr.ready']);
  assert.deepEqual(step(view()), []);
  assert.deepEqual(step(view({ statusCheckRollup: check('FAILURE') })), ['ci.failed']);
  assert.deepEqual(step(view({ statusCheckRollup: check('FAILURE') })), []);
  const reviews = [
    { id: 'R1', author: { login: 'copilot-pull-request-reviewer' }, state: 'COMMENTED', body: 'bot says' },
    { id: 'R2', author: { login: 'stef' }, state: 'COMMENTED', body: '' },
    { id: 'R3', author: { login: 'ema' }, state: 'CHANGES_REQUESTED', body: 'fix it', databaseId: 3 },
  ];
  const r = diffPr(seen, view({ statusCheckRollup: check('FAILURE'), reviews, inline: [{ pull_request_review_id: 3, path: 'a.rb', line: 4, body: 'here' }] }), 'stef');
  seen = r.seen;
  assert.deepEqual(r.events.map(e => [e.type, e.data.author, e.data.threads]), [['review.changes_requested', 'ema', [{ path: 'a.rb', line: 4, body: 'here' }]]]);
  const approved = [...reviews, { id: 'R4', author: { login: 'ema' }, state: 'APPROVED', body: '' }];
  assert.deepEqual(step(view({ headRefOid: 'bbb', reviews: approved, reviewDecision: 'APPROVED', statusCheckRollup: check('SUCCESS') })),
    ['pr.pushed', 'ci.passed', 'review.approved', 'pr.merge_ready']);
  assert.deepEqual(step(view({ headRefOid: 'bbb', reviews: approved, reviewDecision: 'APPROVED', statusCheckRollup: check('SUCCESS') })), []);
  assert.deepEqual(step(view({ headRefOid: 'bbb', reviews: approved, mergeable: 'CONFLICTING', statusCheckRollup: check('SUCCESS') })), ['pr.conflict']);
  assert.deepEqual(step(view({ headRefOid: 'bbb', reviews: approved, state: 'MERGED', mergedAt: '2026-10-12T10:00:00Z' })), ['pr.merged']);
});

// A gh-style view as GitHub's GraphQL returns it: reviews with their inline comments, CI as the last commit's contexts.
const node = ({ reviews = [], inline = [], statusCheckRollup = [], ...v }) => ({
  ...v,
  reviews: { nodes: reviews.map(r => ({ ...r, comments: { nodes: inline.filter(c => c.pull_request_review_id === r.databaseId).map(c => ({ path: c.path, line: c.line, originalLine: null, body: c.body })) } })) },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: statusCheckRollup } } } }] },
});

test('7 github: one batched query per tracked PRs, one search for new ones; state lands in the DB', async () => {
  const { batchQuery, viewsOf } = await import('./pollers/github.mjs');
  const q = batchQuery(['https://github.com/o/r/pull/7', 'https://github.com/o/r/pull/9', 'https://github.com/x/y/pull/1']);
  assert.match(q, /r0: repository\(owner: "o", name: "r"\) \{ p0: pullRequest\(number: 7\) \{ \.\.\.F \} p1: pullRequest\(number: 9\) \{ \.\.\.F \} \} r1: repository\(owner: "x", name: "y"\) \{ p0: pullRequest\(number: 1\)/);
  const reviewed = view({ reviews: [{ id: 'R3', databaseId: 3, author: { login: 'ema' }, state: 'CHANGES_REQUESTED', body: 'fix it' }], inline: [{ pull_request_review_id: 3, path: 'a.rb', line: 4, body: 'here' }] });
  assert.deepEqual(viewsOf({ viewer: { login: 'stef' }, r0: { p0: node(reviewed), p1: null } }).get(PR).inline, [{ pull_request_review_id: 3, path: 'a.rb', line: 4, original_line: null, body: 'here' }]);
  const poller = (await import('./pollers/github.mjs')).default;
  const search = (await import('./pollers/github-search.mjs')).default;
  let answer;
  const queries = [];
  const other = 'https://github.com/o/r/pull/8';
  const graphql = async query => (queries.push(query), query.includes('search(') ? { data: { search: { nodes: [{ url: PR }, { url: other }] } } } : answer);
  const d = await db();
  const ctx = ctxOf(d, { graphql });
  await run(d, "insert into jobs (slug, type, lead_mode, status, machine) values ('j', 'slim', 'orchestrator', 'running', 'worker')");
  await run(d, "insert into prs (url, repo, number, job_id, state) values (?, 'o/r', 7, 1, 'OPEN')", PR);
  answer = { data: { viewer: { login: 'stef' }, r0: { p0: node(view({ statusCheckRollup: check('SUCCESS') })) } } };
  await poller.run(ctx);
  await search.run(ctx);
  await poller.run(ctx);
  await search.run(ctx);
  const types = (await all(d, 'select type, subject from events order by id')).map(r => `${r.type} ${r.subject.split('/').pop()}`);
  assert.deepEqual(types, ['ci.passed 7', 'pr.unregistered 8']);
  assert.equal(queries.filter(x => !x.includes('search(')).length, 2);
  assert.deepEqual({ ...await one(d, 'select ci, head_sha, state from prs where url = ?', PR) }, { ci: 'passed', head_sha: 'aaa', state: 'OPEN' });
  assert.equal((await one(d, 'select data from events where type = ?', 'ci.passed')).data.includes('"job":"j"'), true);
  answer = { data: { viewer: { login: 'stef' }, r0: { p0: node(view({ title: 'T2', isDraft: true })) } } };
  await poller.run(ctx);
  assert.equal((await one(d, 'select count(*) as n from events')).n, 2);
  assert.deepEqual({ ...await one(d, 'select title, ci, draft from prs where url = ?', PR) }, { title: 'T2', ci: 'pending', draft: 1 });
  answer = { data: { viewer: { login: 'stef' }, r0: { p0: node(view({ title: 'T2', state: 'MERGED', mergedAt: '2026-10-12T10:00:00Z' })) } } };
  await poller.run(ctx);
  queries.length = 0;
  await poller.run(ctx);
  assert.deepEqual(queries, [], 'a merged PR is no longer queried');
});

test('7 handlers: CI messages stop at the 3rd failure, reviews/conflicts go to the lead or the plate', async () => {
  const handlers = await Promise.all(['ci-fix', 'review-fix', 'ready', 'rebase', 'merged', 'closed', 'adopt'].map(async n => (await import(`./handlers/${n}.mjs`)).default));
  const d = await db();
  await dispatch(d, handlers);
  await run(d, "insert into jobs (slug, type, lead_mode, lead_session, status, machine) values ('j', 'slim', 'orchestrator', 'L', 'running', 'worker')");
  await run(d, "insert into sessions (session_id, name, status, status_at, machine) values ('L', 'L', 'idle', 0, 'worker')");
  await run(d, "insert into prs (url, repo, number, job_id, state) values (?, 'o/r', 7, 1, 'OPEN')", PR);
  const on = async (type, data = {}, url = PR) => { await emit(d, type, url, { sha: 'abc', number: 7, job: 'j', ...data }); await dispatch(d, handlers); };
  const msgs = async () => (await all(d, 'select text from messages order by id')).map(r => r.text.replace(/^From factory \[m-\w+\]: /, ''));
  const plates = async () => (await all(d, 'select kind, subject from plate where cleared_at is null order by id')).map(r => `${r.kind} ${r.subject.split('/').pop()}`);
  await on('ci.failed', { failing: [{ name: 'rspec', url: 'u' }] });
  await on('ci.failed', { failing: [{ name: 'rspec', url: 'u' }] });
  await on('ci.failed', { failing: [{ name: 'rspec', url: 'u' }] });
  assert.equal((await msgs()).length, 2);
  assert.match((await msgs())[0], /CI failed on .*pull\/7 at abc: rspec \(u\)\. Run the shipper's CI triage/);
  assert.deepEqual(await plates(), ['ci-failed 7']);
  assert.match((await one(d, 'select text from plate')).text, /3 times without a green/);
  await on('ci.passed');
  assert.equal((await one(d, 'select ci_failures from prs')).ci_failures, 0);
  await on('review.changes_requested', { author: 'ema', body: 'fix', threads: [{ path: 'a.rb', line: 4, body: 'here' }] });
  await on('review.approved', { author: 'ema', body: '' });
  assert.equal((await msgs()).length, 4);
  assert.match((await msgs())[2], /^ema requested changes on .*pull\/7\.\nfix\n- a\.rb:4: here\nVerify each comment .*no code changes.*open the replies gate/);
  assert.match((await msgs())[3], /^ema approved on .*pull\/7\.\nTell Stef at the merge gate/);
  assert.deepEqual(await plates(), ['ci-failed 7']);
  await on('review.commented', { author: 'stef', own: true, body: 'rename it' });
  assert.match((await msgs())[4], /Stef commented on .*; treat it as instructions for this job:\nrename it/);
  await on('pr.ready');
  assert.match((await msgs())[5], /Stef marked .*pull\/7 ready for review in GitHub\. Recommend reviewers/);
  await run(d, "insert into gates (job_id, name, status, pr) values (1, 'ready', 'approved', ?)", PR);
  await on('pr.ready');
  assert.equal((await msgs()).length, 6);
  await on('pr.conflict');
  assert.match((await msgs())[6], /merge conflicts at abc/);
  await on('pr.merge_ready', { title: 'T' });
  assert.deepEqual(await plates(), ['ci-failed 7']);
  await run(d, "update sessions set closed_at = 1 where session_id = 'L'");
  await on('pr.conflict');
  assert.equal((await msgs()).length, 8);
  assert.deepEqual(await plates(), ['ci-failed 7']);
  await run(d, 'update jobs set lead_session = null');
  await on('pr.conflict');
  assert.deepEqual(await plates(), ['ci-failed 7', 'conflict 7']);
  await on('review.commented', { author: 'ema', body: 'why?' });
  assert.deepEqual(await plates(), ['ci-failed 7', 'conflict 7', 'review 7']);
  await run(d, "update jobs set lead_session = 'L'");
  await on('pr.merged');
  assert.deepEqual(await plates(), []);
  assert.equal((await msgs()).length, 8);
  await on('pr.closed', {}, 'https://github.com/o/r/pull/9');
  await on('pr.unregistered', {}, 'https://github.com/o/r/pull/10');
  assert.deepEqual(await plates(), ['closed 9', 'unregistered 10']);
});

test('7 guard: merge and replies only under an approved gate for the job\'s own PR', async () => {
  const j = await jobEnv();
  cli(j.env, 'job', 'new', '--on', 'worker', 'slim', 'toy', '--title', 'mrg', '--task', '123');
  const ws = path.join(j.work, 'workspaces', 'mrg');
  const g = command => {
    const input = { session_id: 'x', agent_id: 's1', agent_type: 'factory-shipper', cwd: path.join(ws, 'api'), tool_name: 'Bash', tool_input: { command } };
    const r = spawnSync(process.execPath, ['--no-warnings', path.join(DIR, 'factory.mjs'), 'guard'], { env: { ...process.env, ...j.env }, input: JSON.stringify(input), encoding: 'utf8' });
    return r.status === 2 ? r.stderr : null;
  };
  const merge = `gh pr merge 7 --repo o/r --squash --subject "T (#7)" --body "Task: 123" --match-head-commit abcdef1`;
  assert.match(g(merge), /needs an approved merge gate/);
  const at = (...a) => spawnSync(process.execPath, ['--no-warnings', path.join(DIR, 'factory.mjs'), ...a], { env: { ...process.env, ...j.env }, cwd: ws, encoding: 'utf8' });
  assert.equal(at('gate', 'open', 'merge', '--pr', PR, '--body', 'merge #7?').status, 0);
  assert.match(g(merge), /needs an approved merge gate/);
  assert.equal(at('gate', 'decided', 'merge', 'approved', '--words', 'merge it').status, 0);
  assert.equal(g(merge), null);
  assert.match(g(merge.replace('7 --repo', '8 --repo')), /only/);
  assert.match(g(merge.replace(' --match-head-commit abcdef1', '')), /match-head-commit/);
  assert.match(g(merge.replace('Task: 123', 'whatever')), /Task: 123/);
  const reply = 'gh api repos/o/r/pulls/7/comments/55/replies -f body=thanks';
  assert.match(g(reply), /posting comments/);
  at('gate', 'open', 'replies', '--pr', PR, '--body', 'drafts');
  at('gate', 'decided', 'replies', 'approved', '--words', 'post them');
  assert.equal(g(reply), null);
  assert.match(g('gh api repos/o/r/pulls/9/comments/55/replies -f body=x'), /posting comments/);
  assert.equal(g('gh pr create --draft --title T --body B'), null);
  assert.match(g('gh pr create --title T --body B'), /as a draft without reviewers/);
  assert.match(g('gh pr create --draft --reviewer ema --title T'), /as a draft without reviewers/);
  assert.equal(g('gh pr edit 7 --repo o/r --body B'), null);
  assert.match(g('gh pr ready 7 --repo o/r'), /needs an approved ready gate/);
  assert.match(g('gh pr edit 7 --repo o/r --add-reviewer ema'), /needs an approved ready gate/);
  at('gate', 'open', 'ready', '--pr', PR, '--body', 'ready with ema?');
  at('gate', 'decided', 'ready', 'approved', '--words', 'ready, ema');
  assert.equal(g('gh pr ready 7 --repo o/r'), null);
  assert.equal(g('gh pr edit 7 --repo o/r --add-reviewer ema'), null);
  assert.match(g('gh pr ready 8 --repo o/r'), /only/);
});

test('8 release: a fake clock walks work and slim PRs through latest, production and soak to job.done', async () => {
  const { setClock } = await import('./db.mjs');
  const h = home();
  const fix = path.join(h, 'branches.json');
  const stub = path.join(h, 'gh');
  fs.writeFileSync(stub, `#!/usr/bin/env node
const b = JSON.parse(require('fs').readFileSync(${JSON.stringify(fix)}, 'utf8'));
const a = process.argv.slice(2);
if (a[0] === 'pr') console.log(JSON.stringify({ mergeCommit: { oid: 'm' + a[2].split('/').pop() } }));
else { const branch = a[1].match(/compare\\/(\\w+)\\.\\.\\./)[1]; console.log(JSON.stringify({ status: b.includes(branch) ? 'behind' : 'ahead' })); }`);
  fs.chmodSync(stub, 0o755);
  fs.writeFileSync(fix, '[]');
  const deploysFile = path.join(h, 'deploys.json');
  const sem = path.join(h, 'tb-sem');
  fs.writeFileSync(sem, `#!/bin/sh\ncat ${JSON.stringify(deploysFile)}\n`);
  fs.chmodSync(sem, 0o755);
  const deploys = [];
  const deployed = (stage, at) => {
    const fmt = ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
    deploys.push({ name: `deploy to ${stage}`, start: fmt(at - 10 * 60e3), end: fmt(at) });
    fs.writeFileSync(deploysFile, JSON.stringify({ deploys }));
  };
  fs.writeFileSync(deploysFile, '{"deploys":[]}');
  const deploy = (await withEnv({ FACTORY_GH: stub, FACTORY_TB_SEM: sem }, () => import('./pollers/deploy.mjs?walk'))).default;
  const timers = (await import('./pollers/timers.mjs')).default;
  const handlers = await Promise.all(['deploy-watch', 'soak', 'done'].map(async n => (await import(`./handlers/${n}.mjs`)).default));
  const H = 3600e3;
  let t = Date.parse('2026-10-09T10:00:00Z');
  setClock(() => t);
  try {
    const d = await db();
    const runs = [];
    const ctx = soakCtx(d, async (agent, prompt) => { runs.push(prompt.match(/stage (\w+), checkpoint \+(\w+)/).slice(1).join(' ')); return { out: 'VERDICT: done-verified' }; });
    await dispatch(d, handlers, ctx);
    const W = 'https://github.com/productiveio/api/pull/1';
    const S = 'https://github.com/productiveio/api/pull/2';
    await run(d, "insert into jobs (slug, type, lead_mode, status, machine) values ('w', 'work', 'orchestrator', 'running', 'worker'), ('s', 'slim', 'orchestrator', 'running', 'worker')");
    await run(d, "insert into prs (url, repo, number, job_id, state) values (?, 'productiveio/api', 1, 1, 'OPEN'), (?, 'productiveio/api', 2, 2, 'OPEN')", W, S);
    const tick = async () => { await deploy.run(ctx); await timers.run(ctx); await dispatch(d, handlers, ctx); };
    const status = async slug => (await one(d, 'select status from jobs where slug = ?', slug)).status;
    for (const [url, job] of [[W, 'w'], [S, 's']]) {
      await emit(d, 'pr.merged', url, { job }, [["update prs set state = 'MERGED', merged_at = ? where url = ?", t, url]]);
    }
    await tick();
    assert.equal(await status('s'), 'done');
    assert.equal(await status('w'), 'running');
    t += 2 * H;
    fs.writeFileSync(fix, '["latest"]');
    deployed('latest', t);
    await tick();
    t += 1.5 * H;
    await tick();
    assert.deepEqual(runs, ['latest 1h', 'latest 1h']);
    t += 20 * H;
    fs.writeFileSync(fix, '["latest", "master"]');
    deployed('production', t);
    await tick();
    assert.equal(await status('w'), 'running');
    t += 30 * H;
    await tick();
    await tick();
    assert.equal(await status('w'), 'done');
    const kinds = runs.reduce((m, r) => ({ ...m, [r]: (m[r] ?? 0) + 1 }), {});
    assert.deepEqual(kinds, { 'latest 1h': 2, 'latest 4h': 2, 'production 1h': 2, 'production 4h': 2, 'production 24h': 2 });
    const order = (await all(d, "select type, subject from events where subject = ? and type not in ('soak.due') order by id", W)).map(r => r.type);
    assert.deepEqual(order, ['pr.merged', 'pr.latest', 'soak.clean', 'pr.production', 'soak.clean', 'soak.clean', 'soak.clean', 'soak.clean']);
    assert.equal((await one(d, "select count(*) as n from events where type = 'job.done' and subject = 'w'")).n, 1);
  } finally {
    setClock(() => Date.now());
  }
});

async function deployEnv(h, deploysFile) {
  const gh = path.join(h, 'gh');
  const sem = path.join(h, 'tb-sem');
  fs.writeFileSync(gh, `#!/usr/bin/env node
console.log(JSON.stringify(process.argv[2] === 'pr' ? { mergeCommit: { oid: 'm1' } } : { status: 'behind' }));`);
  fs.writeFileSync(sem, `#!/bin/sh\ncat ${JSON.stringify(deploysFile)}\n`);
  fs.chmodSync(gh, 0o755);
  fs.chmodSync(sem, 0o755);
  return withEnv({ FACTORY_GH: gh, FACTORY_TB_SEM: sem }, () => import(`./pollers/deploy.mjs?${path.basename(h)}`));
}

test('8 release: production is reached when the first production deploy after the merge ends, not when master has the commit', async () => {
  const { setClock } = await import('./db.mjs');
  const h = home();
  const fix = path.join(h, 'deploys.json');
  const prod = (start, end) => ({ name: 'deploy to production 🟥', start, end });
  const deploys = (...list) => fs.writeFileSync(fix, JSON.stringify({ deploys: list }));
  deploys(prod('2026-10-16 06:55', '2026-10-16 07:05'));
  const deploy = (await deployEnv(h, fix)).default;
  let t = Date.parse('2026-10-19T06:01:00Z');
  setClock(() => t);
  try {
    const d = await db();
    const ctx = ctxOf(d);
    await run(d, "insert into jobs (slug, type, lead_mode, status, machine) values ('w', 'work', 'orchestrator', 'running', 'worker')");
    await run(d, "insert into prs (url, repo, number, job_id, state, merged_at) values ('https://github.com/productiveio/api/pull/1', 'productiveio/api', 1, 1, 'MERGED', ?)", Date.parse('2026-10-16T12:42:37Z'));
    const at = async () => (await one(d, 'select production_at from prs')).production_at;
    await deploy.run(ctx);
    assert.equal(await at(), null);
    deploys();
    await deploy.run(ctx);
    assert.equal(await at(), null);
    fs.writeFileSync(fix, 'not json');
    await deploy.run(ctx);
    assert.equal(await at(), null);
    deploys(prod('2026-10-19 07:02', null), prod('2026-10-16 06:55', '2026-10-16 07:05'));
    await deploy.run(ctx);
    assert.equal(await at(), null);
    deploys(prod('2026-10-19 07:02', '2026-10-19 07:13'), prod('2026-10-16 06:55', '2026-10-16 07:05'));
    t = Date.parse('2026-10-19T07:20:00Z');
    await deploy.run(ctx);
    assert.equal(await at(), Date.parse('2026-10-19T07:13:00Z'));
  } finally {
    setClock(() => Date.now());
  }
});

test('8 release: latest is reached when the first latest deploy after the merge ends, not when the latest branch has the commit', async () => {
  const { setClock } = await import('./db.mjs');
  const h = home();
  const fix = path.join(h, 'deploys.json');
  const dep = (stage, start, end) => ({ name: `deploy to ${stage}`, start, end });
  const deploys = (...list) => fs.writeFileSync(fix, JSON.stringify({ deploys: list }));
  deploys(dep('latest', '2026-10-20 09:50', '2026-10-20 10:00'), dep('production', '2026-10-20 07:00', '2026-10-20 07:13'));
  const deploy = (await deployEnv(h, fix)).default;
  let t = Date.parse('2026-10-20T10:34:00Z');
  setClock(() => t);
  try {
    const d = await db();
    const ctx = ctxOf(d);
    await run(d, "insert into jobs (slug, type, lead_mode, status, machine) values ('w', 'work', 'orchestrator', 'running', 'worker')");
    await run(d, "insert into prs (url, repo, number, job_id, state, merged_at) values ('https://github.com/productiveio/api/pull/1', 'productiveio/api', 1, 1, 'MERGED', ?)", Date.parse('2026-10-20T10:14:11Z'));
    const at = async () => (await one(d, 'select latest_at from prs')).latest_at;
    await deploy.run(ctx);
    assert.equal(await at(), null);
    deploys(dep('latest', '2026-10-20 11:23', '2026-10-20 11:33'), dep('endtoend', '2026-10-20 11:23', '2026-10-20 11:36'), dep('production', '2026-10-20 07:00', '2026-10-20 07:13'));
    t = Date.parse('2026-10-20T11:40:00Z');
    await deploy.run(ctx);
    assert.equal(await at(), Date.parse('2026-10-20T11:33:00Z'));
  } finally {
    setClock(() => Date.now());
  }
});

test('8 release: a spec-code PR that reaches latest queues no soak checkpoint', async () => {
  const watch = (await import('./handlers/deploy-watch.mjs')).default;
  const d = await db();
  const ctx = ctxOf(d);
  await dispatch(d, [watch], ctx);
  await run(d, "insert into jobs (slug, type, lead_mode, status, machine) values ('p', 'spec-code', 'orchestrator', 'done', 'worker')");
  await run(d, "insert into prs (url, repo, number, job_id, state) values ('https://github.com/productiveio/api/pull/1', 'productiveio/api', 1, 1, 'MERGED')");
  await emit(d, 'pr.latest', 'https://github.com/productiveio/api/pull/1', { job: 'p', number: 1 });
  await dispatch(d, [watch], ctx);
  assert.equal((await one(d, "select count(*) as n from timers where type = 'soak.due'")).n, 0);
});

test('8 release: a clean +24h does not close a job whose PR had a failed soak', async () => {
  const done = (await import('./handlers/done.mjs')).default;
  const d = await db();
  const ctx = ctxOf(d);
  await dispatch(d, [done], ctx);
  await run(d, "insert into jobs (slug, type, lead_mode, status, machine) values ('w', 'work', 'orchestrator', 'running', 'worker')");
  const W = 'https://github.com/productiveio/api/pull/1';
  await emit(d, 'soak.signal', W, { job: 'w', stage: 'production', checkpoint: '4h', verdict: 'failed' });
  await emit(d, 'soak.clean', W, { job: 'w', stage: 'production', checkpoint: '24h', verdict: 'done-verified' });
  await dispatch(d, [done], ctx);
  assert.equal((await one(d, 'select status from jobs')).status, 'running');
});

test('8 bugsnag: strong = frame in a changed hunk ±5, weak = file only', async () => {
  const { hunks, match } = await import('./pollers/bugsnag.mjs');
  const changes = { files: [{ file: 'app/models/meeting.rb', hunks: hunks('@@ -10,3 +12,4 @@ def x\n+a\n@@ -40 +44 @@\n') }] };
  assert.deepEqual(changes.files[0].hunks, [[12, 15], [44, 44]]);
  assert.deepEqual(match([{ file: 'vendor/x.rb', line: 1 }, { file: '/app/app/models/meeting.rb', line: 20 }], changes), { strong: true, file: 'app/models/meeting.rb', line: 20 });
  assert.deepEqual(match([{ file: 'app/models/meeting.rb', line: 30 }], changes), { strong: false, file: 'app/models/meeting.rb', line: 30 });
  assert.equal(match([{ file: 'app/models/other.rb', line: 12 }], changes), null);
});

test('8 bugsnag: a stopping scheduler gets no per-error lookups', async () => {
  const h = home();
  const log = path.join(h, 'calls');
  const stub = path.join(h, 'tb-bug');
  fs.writeFileSync(stub, `#!/bin/sh\necho "$1" >> ${JSON.stringify(log)}\n[ "$1" = errors ] && echo '[{"id":"e1","first_seen":"2099-01-01T00:00:00Z","last_seen":"2099-01-01T00:00:00Z"}]' || echo '[]'\n`);
  fs.chmodSync(stub, 0o755);
  const d = await db();
  await run(d, "insert into jobs (slug, type, status, machine) values ('bg', 'work', 'running', 'server')");
  await run(d, "insert into prs (url, repo, number, job_id, state, merged_at, production_at, changes) values (?, 'productiveio/api', 7, 1, 'MERGED', ?, ?, ?)", PR, now(), now() - 1000, JSON.stringify({ files: [], fixes: [] }));
  await withEnv({ FACTORY_TB_BUG: stub }, async () => {
    const poller = (await import('./pollers/bugsnag.mjs?stop')).default;
    await poller.run(ctxOf(d, { stopping: () => true }));
    assert.equal(fs.readFileSync(log, 'utf8'), 'errors\n');
    await poller.run(ctxOf(d, { stopping: () => false }));
    assert.equal(fs.readFileSync(log, 'utf8'), 'errors\nerrors\nevents\n');
  });
});

test('9 schedules: laptop off across 07:00, tick at 07:30 → one timer.due; each runs on its own machine; backup dumps the DB', async () => {
  const { setClock } = await import('./db.mjs');
  const { default: poller, lastOccurrence } = await import('./pollers/schedules.mjs');
  const { default: handler } = await import('./handlers/schedule.mjs');
  const local = (d, hm) => new Date(`${d}T${hm}:00`).getTime();
  assert.equal(lastOccurrence('0 7 * * 1-5', local('2026-10-12', '07:30')), local('2026-10-12', '07:00'));
  assert.equal(lastOccurrence('0 7 * * 1-5', local('2026-10-11', '09:00')), local('2026-10-09', '07:00'));
  assert.equal(lastOccurrence('*/15 * * * *', local('2026-10-12', '07:44')), local('2026-10-12', '07:30'));
  let t = local('2026-10-12', '06:59');
  setClock(() => t);
  try {
    const d = await db();
    await run(d, 'update schedules set last_fired = ?', local('2026-10-11', '08:00'));
    const ctx = machine => ctxOf(d, { machine, online: async () => true, prompt: async text => ({ out: `ran ${text}`, code: 0 }), headless: async () => ({ out: 'boom', code: 1 }) });
    await dispatch(d, [handler], ctx('server'));
    await dispatch(d, [handler], ctx('worker'));
    await poller.run(ctx('server'));
    assert.deepEqual((await all(d, "select subject from events where type = 'timer.due' order by id")).map(r => r.subject), ['backup']);
    t = local('2026-10-12', '07:30');
    await poller.run(ctx('server'));
    await poller.run(ctx('server'));
    t += 60e3;
    await poller.run(ctx('server'));
    assert.deepEqual((await all(d, "select subject, json_extract(data, '$.machine') as m from events where type = 'timer.due' order by id")).map(r => `${r.subject} ${r.m}`), ['backup server', 'morning worker', 'retro server']);
    await dispatch(d, [handler], ctx('server'));
    await dispatch(d, [handler], ctx('worker'));
    const runs = await all(d, 'select name, ok, output from schedule_runs order by id');
    assert.deepEqual(runs.map(r => `${r.name} ${r.ok}`), ['backup 1', 'retro 0', 'morning 1']);
    assert.match(runs[2].output, /ran \/morning/);
    assert.deepEqual((await all(d, 'select kind, subject from plate')).map(r => `${r.kind} ${r.subject}`), ['schedule-failed retro']);
    const file = runs[0].output.match(/backed up to (\S+);/)[1];
    assert.equal(fs.readFileSync(file).subarray(0, 5).toString(), 'PGDMP');
  } finally {
    setClock(() => Date.now());
  }
});

test('9 schedules: a run that fails while offline repeats once the network is back, with no failed plate', async () => {
  const { default: handler } = await import('./handlers/schedule.mjs');
  const d = await db();
  let up = true;
  let calls = 0;
  const ctx = ctxOf(d, { machine: 'server', online: async () => up,
    headless: async () => (++calls === 1 ? (up = false, { out: "API Error: Can't reach the API server (ENOTFOUND)", code: 1 }) : { out: 'VERDICT: done-verified', code: 0 }) });
  await dispatch(d, [handler], ctx);
  await emit(d, 'timer.due', 'retro', { action: 'agent:factory-retro Run the daily factory retro.' });
  const outcomes = async () => (await all(d, "select type from events where type in ('schedule.ran', 'schedule.failed') order by id")).map(r => r.type);
  await dispatch(d, [handler], ctx);
  await dispatch(d, [handler], ctx);
  assert.equal(calls, 1);
  assert.deepEqual(await outcomes(), []);
  up = true;
  await dispatch(d, [handler], ctx);
  assert.equal(calls, 2);
  assert.deepEqual(await outcomes(), ['schedule.ran']);
  assert.equal((await one(d, 'select count(*) as n from plate')).n, 0);
});

test('9 schedules: a run that dies on an unreachable Claude API repeats even when the network is back by the time it ends', async () => {
  const { default: handler } = await import('./handlers/schedule.mjs');
  const d = await db();
  let calls = 0;
  const ctx = ctxOf(d, { machine: 'server', online: async () => true,
    headless: async () => (++calls === 1 ? { out: "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)\n", code: 1 } : { out: 'VERDICT: done-verified', code: 0 }) });
  await dispatch(d, [handler], ctx);
  await emit(d, 'timer.due', 'retro', { action: 'agent:factory-retro Run the daily factory retro.' });
  await dispatch(d, [handler], ctx);
  await dispatch(d, [handler], ctx);
  assert.equal(calls, 2);
  assert.deepEqual((await all(d, "select type from events where type in ('schedule.ran', 'schedule.failed') order by id")).map(r => r.type), ['schedule.ran']);
  assert.equal((await one(d, 'select count(*) as n from plate')).n, 0);
});

test('10 proposals: created via CLI, accepted and declined leave Needs attention immediately', async () => {
  const j = await jobEnv();
  const mk = title => spawnSync(process.execPath, ['--no-warnings', path.join(DIR, 'factory.mjs'), 'proposal', 'new', '--title', title, '--rung', 'hook'], { env: { ...process.env, ...j.env }, input: 'evidence: x\n## Diff\n+ a line', encoding: 'utf8' });
  assert.equal(mk('Block X').status, 0);
  assert.equal(mk('Order Y').status, 0);
  const { model, render } = await import('./dash.mjs');
  const { proposalDecide } = await import('./jobs.mjs');
  const proposal = (await import('./handlers/proposal.mjs')).default;
  assert.match((await import('./handlers/proposal.mjs')).applyPrompt(1), /factory stop && factory start/);
  const d = await j.db();
  await dispatch(d, [proposal]);
  assert.deepEqual((await model(d, true)).proposals.map(p => p.title), ['Block X', 'Order Y']);
  assert.match((await render(d, { cursor: -1 }, 60)).lines.join('\n'), /NEEDS ATTENTION 2\n {2}proposal 1 · Block X\n {2}proposal 2 · Order Y/);
  assert.match((await render(d, { cursor: 0 }, 60)).lines.join('\n'), /▸ proposal 1\n {2}hook · \d+s · p chat, a a accept/);
  await proposalDecide(d, 1, 'accept');
  assert.deepEqual((await model(d, true)).proposals.map(p => p.title), ['Order Y']);
  await proposalDecide(d, 2, 'decline');
  assert.deepEqual((await model(d, true)).proposals, []);
  await assert.rejects(proposalDecide(d, 2, 'accept'), /declined, not pending/);
  const started = [];
  await dispatch(d, [proposal], { startApply: p => { started.push(p); return 'bg123'; } });
  assert.equal(started.length, 1);
  assert.match(started[0], /factory proposal show 1/);
  assert.equal((await one(d, 'select session from proposals where id = 1')).session, 'bg123');
  assert.equal(mk('Fix Z').status, 0);
  await proposalDecide(d, 3, 'accept');
  const startApply = p => { started.push(p); return 'bg456'; };
  await dispatch(d, [proposal], { startApply });
  assert.equal(started.length, 1, 'proposal 3 waits while apply-proposal-1 runs');
  await emit(d, 'session.idle', 'bg123-0000', {});
  await dispatch(d, [proposal], { startApply, committed: () => false });
  assert.match((await one(d, "select text from plate where kind = 'proposal-failed'")).text, /apply-proposal-1 stopped without a commit/);
  assert.match(started[1], /factory proposal show 3/);
  await emit(d, 'session.closed', 'bg123-0000', {});
  await dispatch(d, [proposal], { committed: () => false });
  assert.equal((await one(d, "select count(*) n from plate where kind = 'proposal-failed'")).n, 1);
});

test('7 detach: only a closed PR leaves its job', async () => {
  const j = await jobEnv();
  assert.equal(cli(j.env, 'job', 'new', '--on', 'worker', 'work', 'Fix it', '--title', 'wk').code, 0);
  const d = await j.db();
  const job = await one(d, "select id from jobs where slug = 'wk'");
  const [open_, closed] = ['https://github.com/o/r/pull/1', 'https://github.com/o/r/pull/2'];
  await run(d, "insert into prs (url, job_id, state) values (?, ?, 'OPEN'), (?, ?, 'CLOSED')", open_, job.id, closed, job.id);
  assert.notEqual(cli(j.env, 'pr', 'detach', open_).code, 0);
  assert.equal(cli(j.env, 'pr', 'detach', closed).code, 0);
  assert.deepEqual((await all(d, 'select url, job_id from prs order by url')).map(r => ({ ...r })), [{ url: open_, job_id: job.id }, { url: closed, job_id: null }]);
  assert.notEqual(cli(j.env, 'pr', 'detach', closed).code, 0);
});

test('7 adopt: an unregistered PR becomes a work job with its task id, worktree and adopt brief', async () => {
  const { taskOf } = await import('./jobs.mjs');
  assert.equal(taskOf('Task: [20059871](https://app.productive.io/109-productive/tasks/task/20059871)'), '20059871');
  assert.equal(taskOf('see https://app.productive.io/109-productive/tasks/19048222 x'), '19048222');
  assert.equal(taskOf('Task: 17560672'), '17560672');
  assert.equal(taskOf('no task', 'fix/20059871-deactivate-outlook'), '20059871');
  assert.equal(taskOf('no task', 'feature/settings'), null);
  const j = await jobEnv();
  const gh = path.join(j.h, 'gh');
  fs.writeFileSync(gh, `#!/bin/sh\necho '{"title":"Deactivate Outlook on refused refresh","body":"Task: [20059871](https://app.productive.io/109-productive/tasks/task/20059871)","headRefName":"fix/20059871-outlook","state":"OPEN"}'\n`);
  fs.chmodSync(gh, 0o755);
  const url = 'https://github.com/productiveio/api/pull/23596';
  const d = await j.db();
  await emit(d, 'pr.unregistered', url, {}, [['insert into plate (kind, subject, text) values (?, ?, ?)', 'unregistered', url, 'x'], ["insert into prs (url, repo, number, state) values (?, 'productiveio/api', 23596, 'unregistered')", url]]);
  const r = cli({ ...j.env, FACTORY_GH: gh }, 'pr', 'adopt', url);
  assert.equal(r.code, 0, r.out);
  assert.match(j.calls(), /new pr 23596 Deactivate Outlook on refused refresh --agent lead-loop --app api:3\d{3}/);
  const job = await one(d, 'select * from jobs');
  assert.equal(job.type, 'work');
  assert.equal(job.task_id, '20059871');
  assert.match(job.brief, /Adopt the existing PR .*23596, branch fix\/20059871-outlook.*routes `adopt`.*`gh pr checkout 23596` first.*never a new PR/s);
  assert.equal((await one(d, 'select job_id from prs where url = ?', url)).job_id, job.id);
  assert.equal((await one(d, 'select count(*) as n from plate where cleared_at is null')).n, 0);
  assert.match(cli({ ...j.env, FACTORY_GH: gh }, 'pr', 'adopt', url).out, /already belongs to job/);
});

test('7b pr add: a job with no task takes the task id from the PR body', async () => {
  const j = await jobEnv();
  const gh = path.join(j.h, 'gh');
  fs.writeFileSync(gh, `#!/bin/sh\necho '{"body":"Task: [20059871](https://app.productive.io/109-productive/tasks/task/20059871)","headRefName":"fix/outlook"}'\n`);
  fs.chmodSync(gh, 0o755);
  assert.equal(cli(j.env, 'job', 'new', '--on', 'worker', 'work', 'Address threads on api#23596', '--title', 'thr').code, 0);
  const r = cli({ ...j.env, FACTORY_GH: gh }, 'pr', 'add', 'https://github.com/productiveio/api/pull/23596', '--job', 'thr');
  assert.equal(r.code, 0, r.out);
  assert.equal((await one(await j.db(), "select task_id from jobs where slug = 'thr'")).task_id, '20059871');
});

const httpGet = async (port, p, host = 'localhost') => {
  const http = await import('node:http');
  return new Promise(r => http.get({ port, path: p, headers: { host } }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => r({ status: res.statusCode, body: b, type: res.headers['content-type'] })); }));
};

test('11 web actions: clear, accept/decline, close need the header and do what the TUI keys do', async () => {
  const j = await jobEnv();
  cli(j.env, 'job', 'new', '--on', 'worker', 'slim', 'toy', '--title', 'webact');
  const d = await j.db();
  await run(d, "update jobs set lead_mode = 'orchestrator'");
  spawnSync(process.execPath, ['--no-warnings', path.join(DIR, 'factory.mjs'), 'proposal', 'new', '--title', 'P'], { env: { ...process.env, ...j.env }, input: 'body', encoding: 'utf8' });
  await emit(d, 'pr.unregistered', 'https://github.com/o/r/pull/1', {}, [['insert into plate (kind, subject, text) values (?, ?, ?)', 'unregistered', 'https://github.com/o/r/pull/1', 'x']]);
  const { startWeb } = await import('./web.mjs');
  const web = startWeb(d, { port: 0 });
  await wait(() => web.port());
  const http = await import('node:http');
  const post = (p, headers = { 'X-Factory': '1' }) => new Promise(r => {
    const req = http.request({ port: web.port(), path: p, method: 'POST', headers: { host: 'localhost', ...headers } }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => r({ status: res.statusCode, body: b })); });
    req.end();
  });
  try {
    assert.equal((await post('/plate/1/clear', {})).status, 403);
    assert.equal((await one(d, 'select cleared_at from plate where id = 1')).cleared_at, null);
    assert.equal((await post('/plate/1/clear')).status, 200);
    assert.ok((await one(d, 'select cleared_at from plate where id = 1')).cleared_at);
    assert.equal((await post('/plate/1/clear')).status, 409);
    assert.match((await post('/proposal/1/accept')).body, /Proposal 1 accepted/);
    assert.equal((await post('/proposal/1/decline')).status, 409);
    assert.match((await post('/workspace/webact/done')).body, /webact closes once its lead's turn ends/);
    assert.equal((await one(d, "select status from workspaces where slug = 'webact'")).status, 'closing');
    assert.equal((await post('/workspace/webact/done')).status, 409);
    assert.equal((await post('/nope')).status, 404);
    cli(j.env, 'step', 'plan', 'done', '--note', 'clear route, plan-1.md', '--job', 'webact');
    const detail = JSON.parse((await httpGet(web.port(), '/job/webact')).body);
    assert.deepEqual(detail.history.map(l => l.what), ['job.created', 'workspace.closing', 'plan done']);
    assert.equal(detail.history.at(-1).text, 'clear route, plan-1.md');
    assert.deepEqual(detail.plan.map(r => `${r.element} ${r.status}`), ['plan done', 'coder planned', 'gate planned', 'shipper planned', 'pr planned']);
    assert.equal((await httpGet(web.port(), '/job/nope')).status, 404);
    await emit(d, 'pr.unregistered', 'https://github.com/o/r/pull/2', {}, [['insert into plate (kind, subject, text) values (?, ?, ?)', 'unregistered', 'https://github.com/o/r/pull/2', 'x']]);
    const id = (await one(d, "select id from plate where subject like '%/2'")).id;
    assert.equal((await post('/plate/1/adopt')).status, 409);
    assert.match((await post(`/plate/${id}/ignore`)).body, /ignored/);
    assert.ok((await one(d, 'select cleared_at from plate where id = ?', id)).cleared_at);
  } finally {
    web.close();
  }
});

test('11 web files: a job\'s files come from the DB, criteria and spec first; nothing else is served', async () => {
  const { filesOf, startWeb } = await import('./web.mjs');
  assert.deepEqual(filesOf('j', ['triage-1.md', 'criteria.md', 'spec.md', 'evidence/AC1.txt']).map(f => `${f.kind} ${f.path}`),
    ['criteria j/criteria.md', 'spec j/spec.md', 'report j/triage-1.md', 'evidence j/evidence/AC1.txt']);
  const d = await db();
  await run(d, "insert into jobs (slug, type, status, machine) values ('j', 'slim', 'running', 'worker')");
  const { putFile } = await import('./jobs.mjs');
  await emit(d, 'file.put', 'j', {}, [putFile('j', 'spec.md', '# Spec'), putFile('j', 'page.html', '<p>x</p>')]);
  const web = startWeb(d, { port: 0 });
  await wait(() => web.port());
  try {
    const file = p => httpGet(web.port(), `/file?path=${encodeURIComponent(p)}`);
    assert.deepEqual(await file('j/spec.md'), { status: 200, body: '# Spec', type: 'text/plain; charset=utf-8' });
    assert.equal((await file('j/page.html')).type, 'text/html; charset=utf-8');
    assert.equal((await file('/etc/hosts')).status, 404);
    assert.equal((await file('j/../secret.md')).status, 404);
    assert.equal((await file('j/nope.md')).status, 404);
    assert.deepEqual(JSON.parse((await httpGet(web.port(), '/state')).body).jobs[0].files.map(f => f.name), ['spec.md', 'page.html']);
  } finally {
    web.close();
  }
});

test('11 web: an event emitted from the CLI reaches an open SSE stream within 2s', async () => {
  const j = await jobEnv();
  const d = await j.db();
  const { startWeb } = await import('./web.mjs');
  const web = startWeb(d, { port: 0 });
  await wait(() => web.port());
  const http = await import('node:http');
  try {
    assert.equal((await httpGet(web.port(), '/state', 'evil.com')).status, 403);
    assert.match((await httpGet(web.port(), '/')).body, /<title>Factory<\/title>/);
    assert.ok(Array.isArray(JSON.parse((await httpGet(web.port(), '/state')).body).jobs));
    const frames = [];
    const req = http.get({ port: web.port(), path: '/events', headers: { host: 'localhost' } }, res => res.on('data', c => frames.push({ at: Date.now(), text: String(c) })));
    await wait(() => frames.length);
    const t0 = Date.now();
    assert.equal(cli(j.env, 'job', 'new', '--on', 'worker', 'slim', 'web check', '--title', 'webcheck').code, 0);
    await wait(() => frames.some(f => f.text.includes('webcheck')), 2000);
    assert.ok(frames.find(f => f.text.includes('webcheck')).at - t0 < 2000);
    req.destroy();
  } finally {
    web.close();
  }
});

test('4 usage: meters fill in eighths, turn yellow from 80% and red from 95%, and a past reset reads as 0%', async () => {
  const { usageMeters } = await import('./dash.mjs');
  const at = ms => new Date(Date.now() + ms).toISOString();
  const m = usageMeters({ five_hour: { utilization: 96, resets_at: at(3600e3) }, seven_day: { utilization: 81, resets_at: at(-1) } });
  assert.deepEqual(m.map(x => `${x.bar}|${x.tone}|${x.text}`), ['████████|red| 96% 5h', '░░░░░░░░|magenta| 0% 7d']);
  assert.match(m[0].reset, /resets in (59m|1h0m)/);
  assert.equal(usageMeters({ five_hour: { utilization: 81, resets_at: at(60e3) } })[0].tone, 'yellow');
});

test('11 web feed: herdr\'s stream gets the dash as sections, each row with its lead\'s pane, no uncategorized; a change pushes a new frame', async () => {
  const j = await jobEnv();
  const d = await j.db();
  await run(d, "insert into sessions (session_id, name, status, status_at, machine, pane_id, herdr_status) values ('s-lead', 'lead', 'idle', 1, 'server', 'p_7', 'idle'), ('s-loose', 'loose', 'idle', 1, 'worker', 'p_9', 'idle')");
  const { startWeb } = await import('./web.mjs');
  const web = startWeb(d, { port: 0 });
  await wait(() => web.port());
  const http = await import('node:http');
  try {
    const frames = [];
    const req = http.get({ port: web.port(), path: '/feed', headers: { host: 'localhost' } }, res => {
      let buf = '';
      res.on('data', c => {
        buf += c;
        for (let i; (i = buf.indexOf('\n\n')) >= 0; buf = buf.slice(i + 2)) if (buf.startsWith('data: ')) frames.push(JSON.parse(buf.slice(6, i)));
      });
    });
    await wait(() => frames.length);
    assert.match(frames[0].head, /attention 0 · running 0/);
    assert.equal(cli(j.env, 'job', 'new', '--on', 'worker', 'slim', 'feed check', '--title', 'feedcheck').code, 0);
    await run(d, "update jobs set lead_session = 's-lead' where slug = 'feedcheck'");
    await emit(d, 'test.poke', 'feedcheck', {});
    await wait(() => frames.some(f => JSON.stringify(f).includes('lead idle')), 2000);
    const f = frames.findLast(x => JSON.stringify(x).includes('lead idle'));
    const running = f.sections.find(s => s.name === 'running');
    assert.deepEqual(f.sections.map(s => `${s.name} ${s.folded}`), ['running false']);
    const row = running.rows[0];
    assert.deepEqual([row.lines[0].text, row.target, row.key, row.badge], ['feedcheck', { machine: 'server', pane: 'p_7' }, 'job:feedcheck', '']);
    assert.ok(!f.sections.some(s => s.name === 'uncategorized'));
    await run(d, "insert into plate (kind, subject, text, created_at) values ('soak-signal', 'https://github.com/o/r/pull/9', 'x', 1)");
    await emit(d, 'test.poke', 'feedcheck', {});
    await wait(() => frames.some(x => JSON.stringify(x).includes('soak-signal')), 2000);
    const attention = frames.findLast(x => JSON.stringify(x).includes('soak-signal')).sections[0];
    assert.deepEqual([attention.name, attention.folded], ['needs attention', true]);
    const plate = attention.rows.find(r => r.key?.startsWith('plate:'));
    assert.equal(plate.url, 'https://github.com/o/r/pull/9');
    assert.deepEqual(plate.actions.map(a => `${a.label} ${a.post.replace(/\d+/, 'N')} ${a.confirm}`), ['Clear /plate/N/clear false', 'Rerun soak check /plate/N/rerun false']);
    req.destroy();
  } finally {
    web.close();
  }
});

test('12 lifecycle: dirty refuses, close waits for the lead to go idle, ready-to-close, park/resume; another machine\'s workspace is not touched', async () => {
  const j = await jobEnv();
  cli(j.env, 'job', 'new', '--on', 'worker', 'slim', 'toy', '--title', 'life');
  const ws = path.join(j.work, 'workspaces', 'life');
  const repo = path.join(ws, 'toy');
  const sh = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  fs.mkdirSync(repo);
  sh('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a'), '1');
  sh('add', 'a');
  sh('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'one');
  const at = (...a) => spawnSync(process.execPath, ['--no-warnings', path.join(DIR, 'factory.mjs'), ...a], { env: { ...process.env, ...j.env }, cwd: ws, encoding: 'utf8' });
  assert.match(at('done').stderr, /Refusing to close life: toy has unpushed commits/);
  fs.writeFileSync(path.join(repo, 'a'), '2');
  assert.match(at('done').stderr, /toy has uncommitted changes; toy has unpushed commits/);
  fs.rmSync(repo, { recursive: true });
  const d = await j.db();
  const close = (await withEnv({ FACTORY_WORKSPACES: j.env.FACTORY_WORKSPACES }, () => import('./handlers/close.mjs?stub'))).default;
  const hs = [close, (await import('./handlers/close-ready.mjs')).default];
  await dispatch(d, hs);
  await run(d, "update jobs set lead_session = 'L' where slug = 'life'");
  await run(d, "insert into sessions (session_id, name, status, status_at, machine) values ('L', 'L', 'busy', 0, 'worker')");
  assert.equal(at('done').status, 0);
  await dispatch(d, hs);
  assert.equal((await one(d, "select status from workspaces where slug = 'life'")).status, 'closing');
  assert.doesNotMatch(j.calls(), /done life/);
  await dispatch(d, hs, { machine: 'server' });
  await emit(d, 'session.idle', 'L', {}, [["update sessions set status = 'idle' where session_id = 'L'"]]);
  await dispatch(d, hs, { machine: 'server' });
  assert.doesNotMatch(j.calls(), /done life/);
  await dispatch(d, hs);
  assert.match(j.calls(), /done life/);
  assert.equal((await one(d, "select status from workspaces where slug = 'life'")).status, 'closed');
  assert.equal((await one(d, "select count(*) as n from events where type = 'workspace.closed'")).n, 1);
  fs.rmSync(ws, { recursive: true });
  fs.mkdirSync(path.join(ws, '.factory', 'life'), { recursive: true });
  fs.mkdirSync(path.join(j.work, 'workspaces', '.done', 'life'), { recursive: true });
  assert.equal(cli(j.env, 'reopen', 'life').code, 0);
  assert.match(j.calls(), /reopen life[\s\S]*open life/);
  assert.equal((await one(d, "select status from workspaces where slug = 'life'")).status, 'active');
  assert.equal((await one(d, "select status from jobs where slug = 'life'")).status, 'running');
  assert.ok(!fs.existsSync(ws));
  cli(j.env, 'job', 'new', '--on', 'worker', 'slim', 'toy', '--title', 'rdy');
  await run(d, "insert into prs (url, repo, number, job_id, state) values ('https://github.com/o/r/pull/1', 'o/r', 1, (select id from jobs where slug = 'rdy'), 'OPEN')");
  await emit(d, 'job.done', 'rdy', {}, [["update jobs set status = 'done' where slug = 'rdy'"]]);
  await dispatch(d, hs);
  assert.equal((await one(d, "select count(*) as n from plate where kind = 'ready-to-close'")).n, 0);
  await emit(d, 'pr.merged', 'https://github.com/o/r/pull/1', { job: 'rdy' }, [["update prs set state = 'MERGED'"]]);
  await dispatch(d, hs);
  assert.equal((await one(d, "select subject from plate where kind = 'ready-to-close'")).subject, 'rdy');
  assert.equal(cli(j.env, 'park', 'rdy', 'later').code, 0);
  assert.match(j.calls(), /park rdy later/);
  assert.equal((await one(d, "select status from workspaces where slug = 'rdy'")).status, 'parked');
  assert.equal(cli(j.env, 'resume', 'rdy').code, 0);
  assert.equal((await one(d, "select status from workspaces where slug = 'rdy'")).status, 'active');
  await run(d, "update workspaces set machine = 'server' where slug = 'rdy'");
  assert.match(cli(j.env, 'park', 'rdy').out, /rdy lives on the server; run this there/);
});

// The SQLite factory schema as both machines ran it before Postgres, enough of it for migrate.
const OLD_SCHEMA = `
  create table events (id integer primary key autoincrement, ts integer not null, type text not null, subject text, data text);
  create table workspaces (slug text primary key, kind text not null default 'factory', path text, parent text, herdr text, status text not null default 'active', created_at integer, closed_at integer);
  create table jobs (id integer primary key autoincrement, slug text not null unique, type text not null, brief text, parent text, lead_mode text, lead_session text, status text not null default 'created', task_id text, created_at integer, started_at integer, done_at integer, created_by text, origin text);
  create table steps (id integer primary key autoincrement, job_id integer not null, element text not null, status text not null, note text, ts integer);
  create table gates (id integer primary key autoincrement, job_id integer not null, name text not null, body text, status text not null default 'open', decision text, words text, pr text, opened_at integer, decided_at integer);
  create table prs (url text primary key, repo text, number integer, job_id integer, title text, head_sha text, state text, ci text, ci_failures integer not null default 0, review text, merge_ready integer not null default 0, merged_at integer, latest_at integer, production_at integer, seen text, created_at integer, merge_sha text, changes text, draft integer);
  create table sessions (session_id text primary key, pid integer, name text, cwd text, kind text, status text, status_at integer, workspace text, free integer not null default 0, started_at integer, closed_at integer, pinned integer not null default 0);
  create table messages (id integer primary key autoincrement, job_id integer, session_id text, text text not null, status text not null default 'queued', attempts integer not null default 0, created_at integer, delivered_at integer);
  create table schedule_runs (id integer primary key autoincrement, name text not null, ts integer, output text, ok integer);
  create table servers (workspace text not null, service text not null, port integer, host text, up integer, primary key (workspace, service));
  create table tasks (workspace text not null, task_id text not null, title text, url text, primary key (workspace, task_id));
  create table proposals (id integer primary key autoincrement, title text, file text, body text, status text not null default 'pending', created_at integer, decided_at integer, rung text, session text);
  create table plate (id integer primary key autoincrement, kind text not null, subject text, text text, created_at integer, cleared_at integer);
  create table timers (id integer primary key autoincrement, at integer not null, type text not null, subject text, data text, fired_at integer);
  create table ledger (id integer primary key autoincrement, job_id integer not null, seq real not null, element text not null, label text, weight integer not null default 1, status text not null default 'planned', worker text, note text, updated_at integer);
  create table daily (day text not null, key text not null, value real not null, primary key (day, key));`;

test('13 migrate: both SQLite factories land in one DB, moved jobs once, events by time and never handled again; .factory files by job', async () => {
  const h = home();
  const lite = (name, sql) => {
    const file = path.join(h, `${name}.db`);
    const s = new DatabaseSync(file);
    s.exec(OLD_SCHEMA);
    s.exec(sql);
    s.close();
    return file;
  };
  const PRX = 'https://github.com/o/r/pull/5';
  const worker = lite('worker', `
    insert into jobs (id, slug, type, status, created_at) values (1, 'alpha', 'work', 'running', 10.4), (2, 'moved', 'slim', 'closed', 11);
    insert into workspaces (slug, status) values ('alpha', 'active'), ('moved', 'closed');
    insert into ledger (job_id, seq, element, status) values (1, 1, 'coder', 'done'), (2, 1, 'plan', 'done');
    insert into gates (job_id, name, status) values (1, 'gate2', 'approved');
    insert into prs (url, repo, number, job_id, state) values ('${PRX}', 'o/r', 5, 1, 'OPEN');
    insert into sessions (session_id, status, status_at) values ('S-W', 'idle', 1);
    insert into daily (day, key, value) values ('2026-10-20', 'tokens.opus', 5);
    insert into events (ts, type, subject, data) values (100, 'job.created', 'alpha', '{}'), (300, 'job.moved', 'moved', '{}');`);
  const server = lite('server', `
    insert into jobs (id, slug, type, status) values (1, 'moved', 'slim', 'running'), (2, 'beta', 'research', 'running');
    insert into workspaces (slug, status) values ('moved', 'active'), ('beta', 'active');
    insert into ledger (job_id, seq, element, status) values (1, 1, 'plan', 'done'), (1, 2, 'coder', 'running');
    insert into prs (url, repo, number, state) values ('${PRX}', 'o/r', 5, 'unregistered');
    insert into plate (kind, subject, text) values ('unregistered', '${PRX}', 'x'), ('soak-signal', 'https://github.com/o/r/pull/6', 'y');
    insert into sessions (session_id, status, status_at) values ('S-S', 'idle', 1);
    insert into daily (day, key, value) values ('2026-10-20', 'tokens.opus', 7);
    insert into events (ts, type, subject, data) values (200, 'job.received', 'moved', '{}'), (400, 'job.created', 'beta', null);`);
  const url = await fresh();
  const env = { FACTORY_DATABASE_URL: url };
  const r = cli(env, 'migrate', 'db', `worker=${worker}`, `server=${server}`);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /migrated 3 jobs, 3 workspaces/);
  const d = await openAt(url);
  assert.deepEqual((await all(d, 'select slug, machine, status, created_at from jobs order by slug')).map(x => `${x.slug} ${x.machine} ${x.status} ${x.created_at}`), ['alpha worker running 10', 'beta server running null', 'moved server running null']);
  assert.deepEqual((await all(d, 'select j.slug, l.element from ledger l join jobs j on j.id = l.job_id order by j.slug, l.seq')).map(x => `${x.slug} ${x.element}`), ['alpha coder', 'moved plan', 'moved coder']);
  assert.deepEqual((await all(d, 'select type, ts, data from events order by id')).map(e => `${e.ts} ${e.type} ${JSON.parse(e.data).imported}`), ['100 job.created true', '200 job.received true', '300 job.moved true', '400 job.created true']);
  assert.deepEqual({ ...await one(d, 'select p.state, j.slug from prs p join jobs j on j.id = p.job_id') }, { state: 'OPEN', slug: 'alpha' });
  assert.deepEqual((await all(d, 'select kind from plate where cleared_at is null')).map(p => p.kind), ['soak-signal']);
  assert.deepEqual((await all(d, 'select session_id, machine from sessions order by session_id')).map(s => `${s.session_id} ${s.machine}`), ['S-S server', 'S-W worker']);
  assert.deepEqual((await all(d, 'select machine, value from daily order by machine')).map(x => `${x.machine} ${x.value}`), ['server 7', 'worker 5']);
  const seen = collector('spy', ['job.created', 'job.moved']);
  await dispatch(d, [seen]);
  await run(d, "update cursors set last_event_id = 0 where handler = 'spy'");
  await dispatch(d, [seen]);
  assert.deepEqual(seen.seen, []);
  assert.match(cli(env, 'migrate', 'db', `worker=${worker}`).out, /migrate db runs once/);
  const work = path.join(h, 'work');
  const put = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
  put(path.join(work, 'workspaces', 'alpha', '.factory', 'alpha', 'coder-1.md'), 'report');
  put(path.join(work, 'workspaces', 'alpha', '.factory', 'alpha', 'evidence', 'AC1.txt'), 'green');
  put(path.join(work, 'workspaces', 'alpha', '.factory', 'pr22', 'judge-1.md'), 'judged');
  put(path.join(work, 'workspaces', 'alpha', '.factory', 'shot.png'), 'binary');
  put(path.join(work, 'workspaces', '.done', 'moved', '.factory', 'moved', 'plan.md'), 'plan');
  put(path.join(work, 'workspaces', 'stranger', '.factory', 'x', 'y.md'), 'no job');
  const f = cli({ ...env, FACTORY_WORK: work }, 'migrate', 'files');
  assert.match(f.out, /saved 4 files/);
  assert.deepEqual((await all(d, 'select j.slug, f.name, f.body from files f join jobs j on j.id = f.job_id order by j.slug, f.name')).map(x => `${x.slug} ${x.name} ${x.body}`),
    ['alpha coder-1.md report', 'alpha evidence/AC1.txt green', 'alpha pr22/judge-1.md judged', 'moved plan.md plan']);
  assert.match(cli({ ...env, FACTORY_WORK: work }, 'migrate', 'files').out, /saved 0 files, 4 already there/);
});

let failed = 0;
for (const t of tests) {
  if (only.length && !only.some(o => t.name.startsWith(o))) continue;
  try {
    await t.fn();
    console.log(`ok    ${t.name}`);
  } catch (e) {
    failed++;
    const at = e.stack.split('\n').find(l => l.includes('test.mjs')) ?? '';
    console.log(`FAIL  ${t.name}\n      ${e.message.split('\n').join('\n      ')}\n      ${at.trim()}`);
  } finally {
    for (const d of opened.splice(0)) await d.close().catch(() => {});
  }
}
const { rows } = await admin.query('select nspname from pg_namespace where nspname like $1', [`${PREFIX}%`]);
for (const r of rows) await admin.query(`drop schema ${r.nspname} cascade`);
await admin.end();
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

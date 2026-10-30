import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { MACHINE, emit, listen, now } from './db.mjs';
import { feed, focusSession, model, usage, why } from './dash.mjs';
import { dayOf } from './pollers/daily.mjs';
import { UsageError, done, ledger, prIgnore, progress, proposalDecide, scheduleRun } from './jobs.mjs';

const execFileP = promisify(execFile);
const CLI = new URL('./factory.mjs', import.meta.url).pathname;

const PAGE = new URL('./web.html', import.meta.url);
const ICON = new URL('./favicon.svg', import.meta.url);
const ME = os.hostname().split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '');
const HOSTS = new RegExp(`^(127\\.0\\.0\\.1|localhost|factory\\.localhost|${ME}(\\.[\\w-]+\\.ts\\.net)?|100\\.\\d+\\.\\d+\\.\\d+)(:\\d+)?$`, 'i');
const peer = addr => {
  const a = addr.replace(/^::ffff:/, '');
  if (a === '127.0.0.1' || a === '::1') return 'local';
  const [x, y] = a.split('.').map(Number);
  return (x === 100 && y >= 64 && y < 128) || a.startsWith('fd7a:115c:a1e0:') ? 'tailnet' : null;
};
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'";
const EVENTS = 400;
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

let listening = { at: 0, ports: new Set() };
function listeningPorts() {
  if (Date.now() - listening.at < 5000) return listening.ports;
  let out = '';
  try { out = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 3000 }); } catch {}
  listening = { at: Date.now(), ports: new Set([...out.matchAll(/:(\d+) \(LISTEN\)/g)].map(m => Number(m[1]))) };
  return listening.ports;
}

const parse = r => ({ ...r, data: r.data ? JSON.parse(r.data) : {} });

const groupBy = (rows, key) => {
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r[key])) out.set(r[key], []);
    out.get(r[key]).push(r);
  }
  return out;
};

// Every job and PR with all they carry: one query per table, grouped here, since a round trip to the server costs more than the rows.
export async function state(db, alive = true) {
  const m = await model(db, alive);
  const ports = listeningPorts();
  const [jobRows, ledgerRows, stepRows, gateRows, messageRows, prRows, serverRows, taskRows, workspaceRows, sessionRows, fileRows, timerRows, soakRows, errorRows] = await Promise.all([
    db.prepare('select * from jobs order by created_at desc nulls last').all(),
    db.prepare('select * from ledger order by job_id, seq, id').all(),
    db.prepare('select job_id, element, status, note, ts from steps order by id').all(),
    db.prepare('select * from gates order by id').all(),
    db.prepare('select * from messages where job_id is not null order by id').all(),
    db.prepare('select p.*, j.slug as job from prs p left join jobs j on j.id = p.job_id order by p.created_at desc nulls last').all(),
    db.prepare('select * from servers').all(),
    db.prepare('select * from tasks').all(),
    db.prepare('select slug, status from workspaces').all(),
    db.prepare('select session_id, status, name, closed_at, machine from sessions where session_id in (select lead_session from jobs)').all(),
    db.prepare('select job_id, name from files order by name').all(),
    db.prepare("select * from timers where type = 'soak.due' order by at").all(),
    db.prepare("select subject, type, ts, data from events where type in ('soak.clean', 'soak.signal', 'soak.error') order by id").all(),
    db.prepare("select subject, type, ts, data from events where type in ('error.new', 'error.regressed') order by id").all(),
  ]);
  const by = {
    ledger: groupBy(ledgerRows, 'job_id'), steps: groupBy(stepRows, 'job_id'), gates: groupBy(gateRows, 'job_id'), messages: groupBy(messageRows, 'job_id'),
    prs: groupBy(prRows, 'job_id'), servers: groupBy(serverRows, 'workspace'), tasks: groupBy(taskRows, 'workspace'), files: groupBy(fileRows, 'job_id'),
    timers: groupBy(timerRows, 'subject'), soaks: groupBy(soakRows, 'subject'), errors: groupBy(errorRows.map(parse).map(e => ({ ...e, pr: e.data.pr })), 'pr'),
  };
  const workspaces = new Map(workspaceRows.map(w => [w.slug, w.status]));
  const sessions = new Map(sessionRows.map(s => [s.session_id, s]));
  const jobs = await Promise.all(jobRows.map(async j => {
    const plan = by.ledger.get(j.id) ?? [];
    const gates = by.gates.get(j.id) ?? [];
    const prs = by.prs.get(j.id) ?? [];
    let p = { pct: 0, step: '?', phase: 'plan' };
    try { p = await progress(db, j, undefined, { rows: plan, gates, prs }); } catch {}
    return {
      ...j,
      progress: { ...p, gate: p.gate ?? null },
      phase: j.status === 'done' ? 'done' : prs.some(x => x.state === 'MERGED') ? 'watch' : p.phase,
      plan,
      steps: (by.steps.get(j.id) ?? []).map(({ job_id, ...s }) => s),
      gates,
      messages: by.messages.get(j.id) ?? [],
      prs: prs.map(x => ({ url: x.url, state: x.state, ci: x.ci, review: x.review, draft: x.draft })),
      servers: (by.servers.get(j.slug) ?? []).map(s => ({ ...s, up: j.machine === MACHINE ? ports.has(s.port) : null })),
      tasks: by.tasks.get(j.slug) ?? [],
      workspace: workspaces.get(j.slug) ?? null,
      lead: (j.lead_session && sessions.get(j.lead_session)) ?? null,
      files: filesOf(j.slug, (by.files.get(j.id) ?? []).map(f => f.name)),
    };
  }));
  const prs = prRows.map(p => ({
    ...p,
    seen: undefined,
    changes: undefined,
    soak: (by.timers.get(p.url) ?? []).map(t => ({ ...JSON.parse(t.data), id: t.id, at: t.at, fired_at: t.fired_at })),
    results: (by.soaks.get(p.url) ?? []).map(parse),
    errors: (by.errors.get(p.url) ?? []).map(({ pr, ...e }) => e),
  }));
  return {
    at: Date.now(),
    head: m.head,
    plate: m.plate,
    proposals: m.proposals,
    attention: m.attention.map(j => ({ slug: j.slug, why: why(j), step: j.progress.step, gate: j.progress.gate })),
    busy: m.busy,
    numbers: await numbers(db),
    jobs,
    prs,
    parked: await db.prepare("select * from workspaces where status = 'parked' order by slug").all(),
    schedules: await Promise.all((await db.prepare('select * from schedules order by name').all()).map(async s => ({ ...s, runs: await db.prepare('select ts, ok, output from schedule_runs where name = ? order by id desc limit 5').all(s.name) }))),
    events: await db.prepare('select * from events order by id desc limit ?').all(EVENTS),
  };
}

// One row per day, newest first: the daily table's Claude Code numbers, summed over both machines, plus what the factory did that day.
export async function days(db, n = 14) {
  const list = Array.from({ length: n }, (_, i) => dayOf(now() - i * 86400e3));
  const from = new Date(`${list.at(-1)}T00:00:00`).getTime();
  const byDay = Object.fromEntries(list.map(d => [d, { day: d, tokens: {}, jobs: {}, steps: {}, soaks: {} }]));
  const local = col => `to_char(to_timestamp(${col} / 1000.0) at time zone '${TZ}', 'YYYY-MM-DD')`;
  for (const r of await db.prepare("select day, key, case when key like 'usage.%' then max(value) else sum(value) end as value from daily where day >= ? group by day, key").all(list.at(-1))) {
    if (!byDay[r.day]) continue;
    if (r.key.startsWith('tokens.')) byDay[r.day].tokens[r.key.slice(7)] = r.value;
    else byDay[r.day][r.key] = r.value;
  }
  const count = async (sql, into) => { for (const r of await db.prepare(sql).all(from)) if (byDay[r.day]) byDay[r.day][into][r.k] = r.n; };
  await count(`select ${local('created_at')} as day, 'created' as k, count(*) as n from jobs where created_at >= ? group by day`, 'jobs');
  await count(`select ${local('done_at')} as day, 'done' as k, count(*) as n from jobs where done_at >= ? group by day`, 'jobs');
  await count(`select ${local('merged_at')} as day, 'merged' as k, count(*) as n from prs where merged_at >= ? group by day`, 'jobs');
  await count(`select ${local('updated_at')} as day, status as k, count(*) as n from ledger where updated_at >= ? and status in ('done', 'failed') group by day, status`, 'steps');
  await count(`select ${local('ts')} as day, substr(type, 6) as k, count(*) as n from events where ts >= ? and type in ('soak.clean', 'soak.signal', 'soak.error') group by day, type`, 'soaks');
  return list.map(d => byDay[d]);
}

export async function numbers(db) {
  const week = now() - 7 * 86400e3;
  const steps = {};
  for (const r of await db.prepare("select element, status, count(*) as n from ledger where updated_at >= ? and status not in ('planned', 'dropped') group by element, status").all(week)) {
    steps[r.element] = { ...steps[r.element], [r.status]: r.n };
  }
  return {
    usage: usage(),
    days: await days(db),
    jobs: Object.fromEntries((await db.prepare('select status, count(*) as n from jobs group by status').all()).map(r => [r.status, r.n])),
    prs: Object.fromEntries((await db.prepare("select state, count(*) as n from prs where state not in ('ignored') group by state").all()).map(r => [r.state, r.n])),
    steps: Object.entries(steps).sort((a, b) => Object.values(b[1]).reduce((x, y) => x + y, 0) - Object.values(a[1]).reduce((x, y) => x + y, 0)),
    soaks: Object.fromEntries((await db.prepare("select type, count(*) as n from events where type in ('soak.clean', 'soak.signal', 'soak.error') and ts >= ? group by type").all(week)).map(r => [r.type.slice(5), r.n])),
  };
}

// Everything about one job, oldest first, as one history.
export async function jobDetail(db, slug) {
  const all = await state(db);
  const job = all.jobs.find(j => j.slug === slug);
  if (!job) return null;
  const urls = job.prs.map(p => p.url);
  const marks = urls.map(() => '?').join(', ');
  const events = (await db.prepare(`select * from events where subject = ? ${urls.length ? `or subject in (${marks})` : ''} order by ts, id`).all(slug, ...urls)).map(parse);
  const skip = new Set(['job.step', 'gate.opened', 'gate.decided', 'message.queued', 'message.sent', 'message.delivered', 'file.put']);
  const history = [
    ...job.steps.map(s => ({ ts: s.ts, kind: 'step', what: `${s.element} ${s.status}`, text: s.note, tone: s.status })),
    ...job.gates.flatMap(g => [
      { ts: g.opened_at, kind: 'gate', what: `gate ${g.name} opened`, text: g.body, tone: 'gate' },
      ...(g.decided_at ? [{ ts: g.decided_at, kind: 'gate', what: `gate ${g.name} ${g.status}`, text: g.words ? `Stef: “${g.words}”` : '', tone: g.status }] : []),
    ]),
    ...job.messages.map(m => ({ ts: m.created_at, kind: 'message', what: `message ${m.status}${m.attempts ? ` (${m.attempts} tries)` : ''}`, text: m.text, tone: m.status })),
    ...events.filter(e => !skip.has(e.type)).map(e => ({ ts: e.ts, kind: 'event', what: `${e.type}${e.subject !== slug ? ` ${e.subject.split('/').pop()}` : ''}`, text: summary(e), tone: e.type })),
  ].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  return { ...job, prs: all.prs.filter(p => urls.includes(p.url)), history };
}

const KIND_ORDER = { criteria: 0, spec: 1, gates: 2, report: 3, evidence: 4 };

function kindOf(name) {
  const base = path.basename(name).toLowerCase();
  if (base.startsWith('criteria')) return 'criteria';
  if (/spec|design/.test(base)) return 'spec';
  if (base === 'gates.md' || base === 'ledger.md') return 'gates';
  return name.split('/').includes('evidence') ? 'evidence' : 'report';
}

// A job's files from the DB; path is "<slug>/<name>", what /file takes.
export function filesOf(slug, names) {
  return names.map(name => ({ path: `${slug}/${name}`, name, kind: kindOf(name) }))
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

const TYPES = { '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8', '.json': 'application/json', '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.svg': 'image/svg+xml' };

function summary(e) {
  const d = e.data;
  return [d.failing?.map(f => `${f.name} ${f.url}`).join(', '), d.author && `${d.author}: ${d.body ?? ''}`, ...(d.threads ?? []).map(t => `${t.path}:${t.line} ${t.body}`),
    d.stage && `${d.stage}${d.checkpoint ? ` +${d.checkpoint}` : ''}`, d.report, d.summary, d.class && `${d.class} ${d.file ?? ''}:${d.line ?? ''}`, d.output, d.reason, d.sha && `at ${String(d.sha).slice(0, 10)}`]
    .filter(Boolean).join('\n');
}

async function rerunSoak(db, t, what) {
  if (!t?.fired_at) throw new UsageError(`soak check ${what} has not run yet`);
  const { imported, ...data } = JSON.parse(t.data);
  await emit(db, 'soak.due', t.subject, { ...data, rerun: true });
  return `soak ${data.stage} +${data.checkpoint} on ${t.subject} queued again`;
}

// The same actions the TUI keys run: c c, a a / x x, D D.
export async function action(db, pathname) {
  let m;
  if ((m = pathname.match(/^\/plate\/(\d+)\/clear$/))) {
    const p = await db.prepare('select * from plate where id = ? and cleared_at is null').get(Number(m[1]));
    if (!p) throw new UsageError(`plate item ${m[1]} is already cleared`);
    await emit(db, 'plate.cleared', p.subject, { id: p.id, kind: p.kind }, [['update plate set cleared_at = ? where id = ?', now(), p.id]]);
    return `cleared ${p.kind} ${p.subject ?? ''}`;
  }
  if ((m = pathname.match(/^\/plate\/(\d+)\/(adopt|ignore)$/))) {
    const p = await db.prepare("select * from plate where id = ? and kind = 'unregistered' and cleared_at is null").get(Number(m[1]));
    if (!p) throw new UsageError(`plate item ${m[1]} is not an open unregistered PR`);
    if (m[2] === 'ignore') return prIgnore(db, [p.subject]);
    return execFileP(process.execPath, ['--no-warnings', CLI, 'pr', 'adopt', p.subject], { timeout: 300000 })
      .then(r => r.stdout.trim(), e => { throw new UsageError(`${e.stderr || e.message}`.trim()); });
  }
  if ((m = pathname.match(/^\/proposal\/(\d+)\/(accept|decline)$/))) return proposalDecide(db, m[1], m[2]);
  if ((m = pathname.match(/^\/soak\/(\d+)\/rerun$/))) return rerunSoak(db, await db.prepare("select * from timers where id = ? and type = 'soak.due'").get(Number(m[1])), m[1]);
  if ((m = pathname.match(/^\/plate\/(\d+)\/rerun$/))) {
    const p = await db.prepare("select * from plate where id = ? and kind = 'soak-signal' and cleared_at is null").get(Number(m[1]));
    const [, stage, checkpoint] = p?.text?.match(/^Soak check (\w+) \+(\w+)/) ?? [];
    if (!stage) throw new UsageError(`plate item ${m[1]} is not an open soak signal`);
    const t = await db.prepare("select * from timers where subject = ? and type = 'soak.due' and json_extract(data, '$.stage') = ? and json_extract(data, '$.checkpoint') = ? order by id desc").get(p.subject, stage, checkpoint);
    const out = await rerunSoak(db, t, `${stage} +${checkpoint} on ${p.subject}`);
    await emit(db, 'plate.cleared', p.subject, { id: p.id, kind: p.kind }, [['update plate set cleared_at = ? where id = ?', now(), p.id]]);
    return out;
  }
  if ((m = pathname.match(/^\/schedule\/([\w.-]+)\/run$/))) return scheduleRun(db, m[1]);
  if ((m = pathname.match(/^\/workspace\/([\w.-]+)\/done$/))) return done(db, [m[1]]);
  if ((m = pathname.match(/^\/job\/([\w.-]+)\/focus$/))) {
    const j = await db.prepare('select lead_session from jobs where slug = ?').get(m[1]);
    if (!j) throw new UsageError(`no job ${m[1]}`);
    const ids = [j.lead_session, ...(await db.prepare('select session_id from sessions where workspace = ? and closed_at is null order by status_at desc nulls last').all(m[1])).map(s => s.session_id)];
    let focused = false;
    for (const id of ids) if (id && !focused) focused = await focusSession(db, id);
    if (!focused) throw new UsageError(`no herdr pane for ${m[1]}`);
    try { execFileSync('open', ['-a', 'Ghostty'], { timeout: 5000 }); } catch {}
    return `${m[1]} focused in herdr`;
  }
  return null;
}

export function startWeb(db, { port = Number(process.env.FACTORY_WEB_PORT ?? 4281), alive = () => true, log = () => {} } = {}) {
  const clients = new Set();
  const send = (res, status, type, body) => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': CSP });
    res.end(body);
  };
  const feeds = new Set();
  let fed = '';
  let pushing = null;
  let again = false;
  const push = () => {
    if (!clients.size && !feeds.size) return;
    if (pushing) { again = true; return; }
    pushing = Promise.all([clients.size && state(db, alive()), feeds.size && feed(db, alive())]).then(([s, f]) => {
      const body = `event: state\ndata: ${JSON.stringify(s)}\n\n`;
      if (s) for (const c of clients) c.write(body);
      if (f && JSON.stringify(f) !== fed) {
        fed = JSON.stringify(f);
        for (const c of feeds) c.write(`data: ${fed}\n\n`);
      }
    }, e => log(`web: ${e.message}`)).finally(() => {
      pushing = null;
      if (again) { again = false; push(); }
    });
  };
  const server = http.createServer(async (req, res) => {
    if (!HOSTS.test(req.headers.host ?? '')) return send(res, 403, 'text/plain', 'forbidden host');
    if (!peer(req.socket.remoteAddress ?? '')) return send(res, 403, 'text/plain', 'forbidden peer');
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST') {
      if (req.headers['x-factory'] !== '1') return send(res, 403, 'text/plain', 'missing X-Factory header');
      try {
        const out = await action(db, url.pathname);
        if (out == null) return send(res, 404, 'text/plain', 'no such action');
        push();
        return send(res, 200, 'text/plain', out);
      } catch (e) {
        return send(res, e instanceof UsageError ? 409 : 500, 'text/plain', e.message);
      }
    }
    if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405, 'text/plain', 'GET or POST');
    try {
      if (url.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(PAGE));
      if (url.pathname === '/favicon.svg') return send(res, 200, 'image/svg+xml', fs.readFileSync(ICON));
      if (url.pathname === '/state') return send(res, 200, 'application/json', JSON.stringify(await state(db, alive())));
      if (url.pathname === '/file') {
        const [slug, ...rest] = (url.searchParams.get('path') ?? '').split('/');
        const name = rest.join('/');
        const type = TYPES[path.extname(name).toLowerCase()];
        const f = type && await db.prepare('select f.body from files f join jobs j on j.id = f.job_id where j.slug = ? and f.name = ?').get(slug, name);
        if (!f) return send(res, 404, 'text/plain', 'no such factory file');
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': type.startsWith('text/html') ? 'sandbox allow-scripts allow-popups' : CSP });
        return res.end(f.body);
      }
      const job = url.pathname.match(/^\/job\/([\w.-]+)$/);
      if (job) {
        const detail = await jobDetail(db, job[1]);
        return detail ? send(res, 200, 'application/json', JSON.stringify(detail)) : send(res, 404, 'text/plain', 'no such job');
      }
      if (url.pathname === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(`retry: 1000\nevent: state\ndata: ${JSON.stringify(await state(db, alive()))}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (url.pathname === '/feed') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify(await feed(db, alive()))}\n\n`);
        feeds.add(res);
        req.on('close', () => feeds.delete(res));
        return;
      }
    } catch (e) {
      return send(res, 500, 'text/plain', e.message);
    }
    send(res, 404, 'text/plain', 'not found');
  });
  const stop = listen(push, db.url);
  const ping = setInterval(() => { for (const c of feeds) c.write(': ping\n\n'); }, 15000);
  const tick = setInterval(push, 60000);
  server.on('error', e => log(`web: ${e.message}`));
  server.listen(port, '::', () => log(`web dash on http://localhost:${server.address().port}`));
  return { server, port: () => server.address()?.port, close: () => { stop(); clearInterval(ping); clearInterval(tick); for (const c of [...clients, ...feeds]) c.end(); server.close(); } };
}

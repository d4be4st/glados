import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tty from 'node:tty';
import { MACHINE, MACHINES, WORKSPACES, emit, json, now } from './db.mjs';
import { age } from './dash.mjs';
import { reportProblems } from './hooks.mjs';
import { check, elements, load, names, phaseOf, stepName, steps } from './types.mjs';
import { ms } from './handlers/deploy-watch.mjs';
import { parseUrl } from './pollers/github.mjs';
import { transcript } from './pollers/messages.mjs';
import { workspaceOf } from './pollers/sessions.mjs';
import { timer } from './pollers/timers.mjs';

const WS_BIN = process.env.FACTORY_WORKSPACES || 'workspaces';
const SERVER_SSH = process.env.FACTORY_SERVER_SSH || 'bestija-v4';
const STEP_STATUSES = ['start', 'done', 'failed', 'skipped'];
const DECISIONS = ['approved', 'accepted', 'changes', 'stopped'];
const ROW = { start: 'running', done: 'done', failed: 'failed', skipped: 'skipped' };
const GATE_ROW = { approved: 'done', accepted: 'done', changes: 'planned', stopped: 'failed' };
const FINISHED = ['done', 'skipped'];
const PR_GATES = ['ready', 'replies', 'merge'];
const CHECKED = { triage: 'triage', plan: 'triage', spec: 'spec', coder: 'coder' };

export class UsageError extends Error {}
const fail = msg => { throw new UsageError(msg); };

export function flag(args, name) {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args.splice(at, 2)[1];
}

// The workspaces CLI's slug, so a job created for another machine knows its workspace name before it exists.
export function slugOf(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
}

export async function jobFor(db, args = [], cwd = process.cwd()) {
  const slug = flag(args, '--job') ?? workspaceOf(cwd);
  const job = slug
    ? await db.prepare('select * from jobs where slug = ?').get(slug)
    : await db.prepare("select * from jobs where lead_session = ? and status != 'done'").get(process.env.CLAUDE_CODE_SESSION_ID ?? '');
  return job ?? fail('No factory job here: run it from inside the job\'s workspace or pass --job <slug>.');
}

export function ledger(db, job) {
  return db.prepare('select * from ledger where job_id = ? order by seq, id').all(job.id);
}

export function rowName(r) {
  return r.element === 'gate' ? `gate:${r.label}` : r.element;
}

// n slots right after the anchor row, or after the last row that has started.
function seqsAfter(rows, anchor, n = 1) {
  const at = anchor ? rows.indexOf(anchor) : rows.findLastIndex(r => !['planned', 'dropped'].includes(r.status));
  const prev = rows[at]?.seq ?? 0;
  const next = rows[at + 1]?.seq ?? prev + n + 1;
  return Array.from({ length: n }, (_, i) => prev + ((next - prev) * (i + 1)) / (n + 1));
}

function addRow(jobId, seq, element, label, weight, status = 'planned', worker = null, note = null) {
  return ['insert into ledger (job_id, seq, element, label, weight, status, worker, note, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    jobId, seq, element, label ?? null, weight, status, worker ?? null, note ?? null, now()];
}

// The type's recipe, plus one watch row per soak checkpoint, is the job's first plan.
export function seed(slug, type, catalogue = elements()) {
  const rows = [...steps(type).map(s => [s.element, s.element === 'gate' ? s.name : null]),
    ...Object.entries(type.soak ?? {}).flatMap(([stage, checkpoints]) => checkpoints.map(c => ['watch', `${stage} +${c}`]))];
  return rows.map(([element, label], n) => ['insert into ledger (job_id, seq, element, label, weight, status, updated_at) select id, ?::float8, ?, ?, ?::int, ?, ?::bigint from jobs where slug = ?',
    n + 1, element, label, catalogue[element]?.weight ?? 1, 'planned', now(), slug]);
}

// known: the job's ledger rows, gates and PRs already loaded (the web state loads them for every job at once).
export async function progress(db, job, catalogue = elements(), known = null) {
  const rows = (known?.rows ?? await ledger(db, job)).filter(r => r.status !== 'dropped');
  const weight = list => list.reduce((n, r) => n + r.weight, 0);
  const work = rows.filter((r, n) => !['ship', 'pr'].includes(phaseOf(rows, n, catalogue)));
  const total = weight(work);
  const running = rows.findIndex(r => r.status === 'running');
  const last = rows.findLastIndex(r => FINISHED.includes(r.status));
  const next = rows.findIndex((r, n) => n > last && !FINISHED.includes(r.status));
  const at = running >= 0 ? running : next >= 0 ? next : rows.findIndex(r => !FINISHED.includes(r.status));
  const openGate = known
    ? known.gates.filter(g => g.status === 'open').sort((a, b) => b.id - a.id)[0]
    : await db.prepare("select * from gates where job_id = ? and status = 'open' order by id desc").get(job.id);
  const phase = phaseOf(rows, at < 0 ? rows.length - 1 : at, catalogue);
  return {
    pct: total ? Math.round((100 * weight(work.filter(r => FINISHED.includes(r.status)))) / total) : 0,
    step: openGate ? `gate:${openGate.name}` : at >= 0 ? rowName(rows[at]) : rows.length ? 'done' : '-',
    phase,
    gate: openGate,
    wait: await waiting(db, job, rows, phase === 'pr', known?.prs),
  };
}

async function waiting(db, job, rows, atPr, prs) {
  const pr = prs
    ? prs.filter(p => ['OPEN', 'MERGED'].includes(p.state)).sort((a, b) => (b.created_at ?? -Infinity) - (a.created_at ?? -Infinity))[0]
    : await db.prepare("select url, state, created_at from prs where job_id = ? and state in ('OPEN', 'MERGED') order by created_at desc nulls last").get(job.id);
  if (!pr || (pr.state === 'OPEN' && !atPr)) return null;
  if (pr.state === 'OPEN') return `in review · ${age(now() - pr.created_at)}`;
  const watch = rows.filter(r => ['watch', 'watcher'].includes(r.element) && /\+\d+h/.test(r.label ?? ''));
  const next = watch.find(r => !FINISHED.includes(r.status) && r.status !== 'failed');
  const due = next && await db.prepare("select at from timers where subject = ? and type = 'soak.due' and fired_at is null and json_extract(data, '$.stage') || ' +' || json_extract(data, '$.checkpoint') = ?").get(pr.url, next.label);
  return `soak ${watch.filter(r => FINISHED.includes(r.status)).length}/${watch.length}${next ? ` · next ${next.label.match(/(?:(?:latest|production) )?\+\d+h/)[0]}${due ? ` in ${age(due.at - now())}` : ''}` : ''}`;
}

export function typeCheck(args) {
  const list = args.length ? args : names();
  let bad = 0;
  for (const n of list) {
    let problems;
    try { problems = check(load(n)); } catch (e) { problems = [e.message]; }
    console.log(problems.length ? `${n}: ${problems.join('; ')}` : `${n}: ok`);
    bad += problems.length ? 1 : 0;
  }
  if (bad) process.exitCode = 1;
}

export async function jobNew(db, args) {
  const parent = flag(args, '--parent');
  const title = flag(args, '--title');
  const task = flag(args, '--task');
  const why = flag(args, '--why');
  const parentJob = parent && await db.prepare('select machine from jobs where slug = ?').get(parent);
  const on = flag(args, '--on') ?? parentJob?.machine ?? 'server';
  const apps = [];
  for (let a; (a = flag(args, '--app'));) apps.push(a);
  const [typeName, ...rest] = args;
  const brief = rest.join(' ').trim();
  if (!typeName || !brief) fail('usage: factory job new <type> "<brief>" [--on server|worker] [--parent <slug>] [--title "<title>"] [--task <productive task id>] [--app api:3100] [--why "<what triggered this job>"]');
  if (!MACHINES.includes(on)) fail(`--on is one of ${MACHINES.join(', ')}, not ${on}`);
  const type = load(typeName);
  const problems = check(type);
  if (problems.length) fail(`type ${typeName} does not check: ${problems.join('; ')}`);
  const name = title ?? brief.split(/\s+/).slice(0, 7).join(' ');
  const slug = slugOf(name);
  if (!slug) fail('the title makes an empty workspace name; pass --title with letters or digits.');
  if (await db.prepare('select 1 from jobs where slug = ? union select 1 from workspaces where slug = ?').get(slug, slug)) fail(`a job or workspace ${slug} already exists; pick another --title.`);
  const createdBy = process.env.CLAUDE_CODE_SESSION_ID ?? null;
  const inline = on === MACHINE;
  await emit(db, 'job.created', slug, { type: typeName, brief, parent, mode: type.lead, task, created_by: createdBy, why, title: name, apps, machine: on, inline }, [
    ['insert into jobs (slug, type, brief, parent, lead_mode, status, task_id, created_at, created_by, origin, title, machine) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', slug, typeName, brief, parent ?? null, type.lead, 'created', task ?? null, now(), createdBy, why ?? null, name, on],
    ["insert into workspaces (slug, kind, path, parent, status, created_at, machine) values (?, 'factory', ?, ?, 'active', ?, ?)", slug, path.join(WORKSPACES, slug), parent ?? null, now(), on],
    ...apps.map(a => server(slug, a)),
    ...(task ? [['insert into tasks (workspace, task_id) values (?, ?) on conflict do nothing', slug, task]] : []),
    ...seed(slug, type),
  ]);
  if (!inline) {
    console.log(`Job ${slug} (${typeName}) created on the ${on}; its lead starts there when the ${on}'s scheduler picks it up.`);
    return slug;
  }
  await materialize(db, slug);
  console.log(`Job ${slug} (${typeName}) created; its lead is starting in workspace ${slug}.`);
  return slug;
}

// Runs on the job's own machine: the workspace, its worktrees, the type's model settings and the lead.
export async function materialize(db, slug, { lead = true } = {}) {
  const job = await db.prepare('select * from jobs where slug = ?').get(slug);
  const type = load(job.type);
  const created = await db.prepare("select data from events where type = 'job.created' and subject = ? order by id limit 1").get(slug);
  const apps = (created && JSON.parse(created.data).apps) ?? [];
  const made = spawnSync(WS_BIN, ['new', job.title ?? slug, '--agent', `lead-${type.lead}`, ...(job.parent ? ['--parent', job.parent] : []), ...apps.flatMap(a => ['--app', a])], { encoding: 'utf8' });
  const out = `${made.stdout}${made.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
  const got = out.match(/(?:Created|Already exists): (\S+)/)?.[1];
  if (got !== slug) fail(`workspaces new did not create ${slug}: ${out.trim()}`);
  if (type.model || type.effort) {
    const file = path.join(WORKSPACES, slug, '.claude', 'settings.json');
    const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...settings, ...(type.model && { model: type.model }), ...(type.effort && { effortLevel: type.effort }) }, null, 2) + '\n');
  }
  if (lead) {
    const prompt = `You lead factory job ${slug}. Run \`factory job start\` first, then list out your goal for this job in a few lines before you begin.`;
    spawnSync(WS_BIN, ['open', slug, '--no-focus', '--prompt', prompt], { encoding: 'utf8', env: { ...process.env, HERDR_ENV: process.env.HERDR_ENV ?? '1' } });
  }
}

const HOST_PREFIX = { frontend: 'app', productive: 'app', identity: 'id' };

export function server(slug, app) {
  const [service, port] = app.split(':');
  return ['insert into servers (workspace, service, port, host) values (?, ?, ?, ?) on conflict (workspace, service) do update set port = excluded.port, host = excluded.host',
    slug, service, Number(port) || null, `${HOST_PREFIX[service] ?? service}-${slug}.productive.io.localhost`];
}

async function createdLine(db, job) {
  const s = job.created_by && await db.prepare('select name, workspace from sessions where session_id = ?').get(job.created_by);
  const by = s ? `session ${s.name} (workspace ${s.workspace ?? 'none'})` : job.created_by ? `session ${job.created_by} (no longer tracked)` : 'unknown (created outside a Claude session, or before creators were recorded)';
  return `Created by: ${by}${job.parent ? `, as a child of ${job.parent}` : ''}${job.origin ? `. Why: ${job.origin}` : ''}.`;
}

function rowLine(r) {
  return `  row ${r.id}: ${rowName(r)}${r.label && r.element !== 'gate' ? ` (${r.label})` : ''} · ${r.status} · weight ${r.weight}${r.worker ? ` · ${r.worker}` : ''}${r.note ? `\n      ${r.note}` : ''}`;
}

function ledgerLines(rows, full) {
  if (full) return rows.map(rowLine);
  const folded = r => [...FINISHED, 'dropped'].includes(r.status);
  const out = [];
  for (let i = 0; i < rows.length;) {
    if (!folded(rows[i])) { out.push(rowLine(rows[i++])); continue; }
    const run = [];
    while (i < rows.length && folded(rows[i])) run.push(rows[i++]);
    const counts = Object.entries(Object.groupBy(run, r => r.status)).map(([s, rs]) => `${rs.length} ${s}`).join(', ');
    out.push(`  rows ${run.map(r => r.id).join(', ')}: ${counts}`);
  }
  return out;
}

export async function describe(db, job, { full = false } = {}) {
  const type = load(job.type);
  const p = await progress(db, job);
  const rows = await ledger(db, job);
  const gates = await db.prepare('select name, status, words from gates where job_id = ? order by id').all(job.id);
  const children = await db.prepare('select * from jobs where parent = ? order by created_at').all(job.slug);
  const files = await db.prepare('select name from files where job_id = ? order by name').all(job.id);
  const prs = await db.prepare('select url, state, ci, review from prs where job_id = ?').all(job.id);
  const childLines = await Promise.all(children.map(async c => {
    const cp = await progress(db, c);
    return `  ${c.slug} (${c.type}) · ${c.status} · ${cp.pct}% · now: ${cp.step}`;
  }));
  return [
    `Job ${job.slug}, type ${job.type}, lead mode ${job.lead_mode}, status ${job.status}, ${p.pct}% done, now: ${p.step}.`,
    `Workspace: ${path.join(WORKSPACES, job.slug)} on the ${job.machine}.`,
    `Stage reports, criteria and evidence live in the factory DB, not on disk: \`factory file put <name> < content\`, \`factory file cat <name>\`, \`factory file ls\`${files.length ? ` (${files.length} so far: ${files.map(f => f.name).join(', ')})` : ''}.`,
    await createdLine(db, job),
    ...(job.task_id ? [`Productive task: ${job.task_id}.`] : []),
    ...prs.map(p => `PR: ${p.url} (${p.state}, CI ${p.ci ?? '?'}, review ${p.review ?? '?'})`),
    '',
    'Brief:',
    job.brief,
    '',
    'Recipe (how this type plans the work):',
    ...steps(type).map((s, n) => `  ${n + 1}. ${stepName(s)}${s.optional ? ' (optional: skip it when the work does not need it)' : ''}${s.tests === false ? ' (no tests)' : ''}${s.repeat ? ' (repeats until accepted)' : ''}`),
    type.done.on === 'manual' ? 'Done only when Stef says so; never mark this job done yourself.' : `Done when: ${type.done.on}${type.done.when ? ` with ${type.done.when}` : ''}.`,
    '',
    `Ledger (the plan and what happened; resume from the first row not done, a running row may have been cut off, so read its report before re-running it${full ? '' : '; finished and dropped rows are folded, `factory job show --full` has their notes'}):`,
    ...(rows.length ? ledgerLines(rows, full) : ['  empty']),
    ...(gates.length ? ['', 'Gates:', ...gates.map(g => `  ${g.name} ${g.status}${g.words ? `: "${g.words}"` : ''}`)] : []),
    ...(children.length ? ['', 'Jobs under this one (details: factory job show --job <slug>):', ...childLines] : []),
  ].join('\n');
}

export async function jobStart(db, args) {
  const job = await jobFor(db, args);
  const sid = process.env.CLAUDE_CODE_SESSION_ID;
  if (!sid) fail('factory job start must run inside the lead\'s Claude session (no CLAUDE_CODE_SESSION_ID).');
  if (job.lead_session !== sid) {
    await emit(db, 'job.started', job.slug, { session: sid, previous: job.lead_session },
      [["update jobs set lead_session = ?, status = case when status = 'created' then 'running' else status end, started_at = coalesce(started_at, ?) where id = ?", sid, now(), job.id]]);
  }
  console.log(await describe(db, await db.prepare('select * from jobs where id = ?').get(job.id)));
}

export async function jobTask(db, args) {
  const job = await jobFor(db, args);
  const task = args[0];
  if (!task) return console.log(job.task_id ? `Productive task: ${job.task_id}.` : `Job ${job.slug} has no Productive task.`);
  if (!/^\d+$/.test(task)) fail('usage: factory job task <productive task id> [--job <slug>]; the record id from the task URL, not the #number.');
  await emit(db, 'job.task', job.slug, { task }, [
    ['update jobs set task_id = ? where id = ?', task, job.id],
    ['insert into tasks (workspace, task_id) values (?, ?) on conflict do nothing', job.slug, task],
  ]);
  console.log(`Job ${job.slug}: Productive task ${task}.`);
}

export async function jobDone(db, args) {
  const job = await jobFor(db, args);
  if (job.status === 'done') return console.log(`Job ${job.slug} is already done.`);
  await emit(db, 'job.done', job.slug, { by: 'lead' }, [["update jobs set status = 'done', done_at = ? where id = ?", now(), job.id]]);
  console.log(`Job ${job.slug} is done.`);
}

// Moves one ledger row: by id, or the element's running row (start: its failed row to retry, else its next planned one).
// Work nobody planned gets a new row after the last started one, so a fix round grows the plan.
export async function step(db, args) {
  const note = flag(args, '--note');
  const worker = flag(args, '--worker');
  const job = await jobFor(db, args);
  const [target, status] = args;
  const catalogue = elements();
  const rows = await ledger(db, job);
  const byId = /^\d+$/.test(target ?? '') ? rows.find(r => r.id === Number(target)) ?? fail(`no ledger row ${target} in job ${job.slug}`) : null;
  const element = byId?.element ?? target;
  if (element === 'gate' || (!byId && !catalogue[element])) fail(`usage: factory step <element|row id> <${STEP_STATUSES.join('|')}> --note "<what happened, report name>" [--worker <agent>@<model>]; elements: ${Object.keys(catalogue).filter(e => e !== 'gate').join(', ')}; gates use factory gate`);
  if (!STEP_STATUSES.includes(status)) fail(`step status must be one of ${STEP_STATUSES.join(', ')}`);
  if (status !== 'start' && !note?.trim()) fail(`factory step ${element} ${status} needs --note with what exactly happened and the report name.`);
  if (job.lead_mode === 'loop' && status === 'done' && CHECKED[element]) {
    const problems = await reportProblems(db, job, CHECKED[element], `VERDICT: done-verified\n${note}`);
    if (problems.length) fail(`factory step ${element} done refused: ${problems.join(' ')}`);
  }
  const mine = rows.filter(r => r.element === element);
  const row = byId ?? (status === 'start'
    ? mine.findLast(r => r.status === 'failed') ?? mine.find(r => r.status === 'planned')
    : mine.findLast(r => r.status === 'running') ?? mine.find(r => ['planned', 'failed'].includes(r.status)));
  const write = row
    ? ['update ledger set status = ?, worker = coalesce(?, worker), note = coalesce(?, note), updated_at = ? where id = ?', ROW[status], worker ?? null, note ?? null, now(), row.id]
    : addRow(job.id, seqsAfter(rows)[0], element, null, catalogue[element].weight ?? 1, ROW[status], worker, note);
  await emit(db, 'job.step', job.slug, { element, status, note, worker, row: row?.id ?? null }, [
    ['insert into steps (job_id, element, status, note, ts) values (?, ?, ?, ?, ?)', job.id, element, status, note ?? null, now()],
    write,
  ]);
  const id = row?.id ?? (await db.prepare('select max(id) as id from ledger where job_id = ?').get(job.id)).id;
  console.log(`${job.slug}: row ${id} ${element} ${ROW[status]}${row ? '' : ' (new row)'}.`);
}

export async function plan(db, args) {
  const label = flag(args, '--label');
  const after = flag(args, '--after');
  const weight = flag(args, '--weight');
  const note = flag(args, '--note');
  const job = await jobFor(db, args);
  const [action, ...targets] = args;
  const catalogue = elements();
  const rows = await ledger(db, job);
  const rowOf = id => rows.find(r => r.id === Number(id)) ?? fail(`no ledger row ${id} in job ${job.slug}`);
  if (action === 'add') {
    const bad = targets.filter(e => !catalogue[e]);
    if (!targets.length || bad.length) fail(`usage: factory plan add <element>... [--label "<what it is for>"] [--after <row id>] [--weight <n>]; elements: ${Object.keys(catalogue).join(', ')}`);
    if (targets.includes('gate') && !label) fail('a planned gate needs its name: --label <name>');
    const anchor = after ? rowOf(after) : undefined;
    const seqs = seqsAfter(rows, anchor, targets.length);
    await emit(db, 'plan.added', job.slug, { elements: targets, label, after: anchor?.id ?? null },
      targets.map((e, i) => addRow(job.id, seqs[i], e, label, Number(weight) || catalogue[e].weight || 1)));
    return console.log(`${job.slug}: planned ${targets.join(', ')}${label ? ` (${label})` : ''}.`);
  }
  if (action === 'drop') {
    const row = rowOf(targets[0]);
    if (FINISHED.includes(row.status)) fail(`row ${row.id} is ${row.status}; only unfinished rows drop.`);
    if (!note?.trim()) fail('factory plan drop needs --note with why.');
    await emit(db, 'plan.dropped', job.slug, { row: row.id, note }, [["update ledger set status = 'dropped', note = ?, updated_at = ? where id = ?", note, now(), row.id]]);
    return console.log(`${job.slug}: row ${row.id} ${rowName(row)} dropped.`);
  }
  if (action === 'prune') {
    if (!await db.prepare("select 1 from prs where job_id = ? and state = 'MERGED'").get(job.id)) fail(`job ${job.slug} has no merged PR; prune only tidies a soaking job.`);
    if (!note?.trim()) fail('factory plan prune needs --note with why.');
    const keep = new Set((flag(args, '--keep') ?? '').split(',').filter(Boolean).map(Number));
    const stale = rows.filter(r => !FINISHED.includes(r.status) && !['watch', 'watcher'].includes(r.element) && !keep.has(r.id));
    await emit(db, 'plan.pruned', job.slug, { rows: stale.map(r => r.id), note },
      stale.map(r => ["update ledger set status = 'dropped', note = ?, updated_at = ? where id = ?", note, now(), r.id]));
    return console.log(`${job.slug}: ${stale.length} unfinished rows dropped${stale.length ? `: ${stale.map(r => `${r.id} ${rowName(r)}`).join(', ')}` : ''}.`);
  }
  fail('usage: factory plan add <element>... [--label "<what>"] [--after <row id>] [--weight <n>] | factory plan drop <row id> --note "<why>" | factory plan prune [--keep <row id>,...] --note "<why>"');
}

export async function rerun(db, args) {
  const note = flag(args, '--note');
  const job = await jobFor(db, args);
  if (!note?.trim()) fail('factory rerun needs --note with why.');
  const rows = await ledger(db, job);
  const done = rows.filter(r => FINISHED.includes(r.status));
  const live = new Set(rows.filter(r => r.element === 'gate' && !FINISHED.includes(r.status) && r.status !== 'dropped').map(r => r.label));
  const stale = (await db.prepare("select id, name from gates where job_id = ? and status = 'open'").all(job.id)).filter(g => !live.has(g.name));
  await emit(db, 'job.rerun', job.slug, { rows: done.map(r => r.id), note }, [
    ...done.map(r => ["update ledger set status = 'dropped', note = ?, updated_at = ? where id = ?", `${r.note ?? ''} [rerun: ${note}]`.trim(), now(), r.id]),
    ...stale.map(g => ["update gates set status = 'superseded' where id = ?", g.id]),
    ["update jobs set status = 'running', done_at = null where id = ? and status = 'done'", job.id],
  ]);
  console.log(`${job.slug}: ${done.length} finished rows dropped, progress restarts at 0%; now factory plan add the new plan.`);
}

export async function soakExtend(db, args) {
  const to = flag(args, '--to');
  const job = await jobFor(db, args);
  const days = Number(to?.match(/^(\d+)d$/)?.[1]);
  if (!days) fail('usage: factory soak extend [--job <slug>] --to <days>d');
  const prs = await db.prepare("select url, number, production_at from prs where job_id = ? and state = 'MERGED'").all(job.id);
  if (!prs.length || prs.some(p => !p.production_at)) fail(`job ${job.slug} has no merged PR in production yet; extend its soak once it reaches production.`);
  const rows = await ledger(db, job);
  const known = rows.filter(r => r.element === 'watch' && r.status !== 'dropped' && r.label?.startsWith('production +')).map(r => ms(r.label.slice('production +'.length)));
  const daily = Array.from({ length: days }, (_, i) => `${i + 1}d`).filter(c => !known.includes(ms(c)));
  const due = prs.flatMap(p => daily.filter(c => p.production_at + ms(c) > now()).map(c => ({ p, c })));
  const checkpoints = [...new Set(due.map(d => d.c))];
  if (!checkpoints.length) return console.log(`${job.slug}: nothing to add; every daily checkpoint up to ${to} is planned or already past.`);
  const seqs = seqsAfter(rows, rows.at(-1), checkpoints.length);
  await emit(db, 'soak.extended', job.slug, { to, checkpoints }, [
    ...checkpoints.map((c, i) => addRow(job.id, seqs[i], 'watch', `production +${c}`, elements().watch?.weight ?? 1)),
    ...due.map(({ p, c }) => timer(p.production_at + ms(c), 'soak.due', p.url, { stage: 'production', checkpoint: c, job: job.slug, number: p.number })),
  ]);
  console.log(`${job.slug}: soak extended to ${to}, production +${checkpoints.join(', +')} scheduled.`);
}

export async function gate(db, args, stdin) {
  const words = flag(args, '--words');
  const pr = flag(args, '--pr');
  let body = flag(args, '--body');
  const job = await jobFor(db, args);
  const [action, name, decision] = args;
  const rows = await ledger(db, job);
  const gates = [...new Set([...steps(load(job.type)).filter(s => s.element === 'gate').map(s => s.name), ...rows.filter(r => r.element === 'gate').map(r => r.label), ...PR_GATES])];
  if (!gates.includes(name)) fail(`usage: factory gate open|decided <${gates.join('|')}> ...; this job has no gate ${name} (plan one with factory plan add gate --label ${name})`);
  if (action === 'open') {
    body ??= stdin();
    if (!body?.trim()) fail('factory gate open needs the full gate text: --body "<text>" or on stdin.');
    const url = pr && parseUrl(pr)?.url;
    if (PR_GATES.includes(name) && !url) fail(`gate ${name} names its PR: --pr <url>.`);
    const row = rows.find(r => r.element === 'gate' && r.label === name && !FINISHED.includes(r.status) && r.status !== 'dropped');
    await emit(db, 'gate.opened', job.slug, { name, body, pr: url }, [
      ["update gates set status = 'superseded' where job_id = ? and name = ? and status = 'open'", job.id, name],
      ["insert into gates (job_id, name, body, status, pr, opened_at) values (?, ?, ?, 'open', ?, ?)", job.id, name, body, url ?? null, now()],
      row ? ["update ledger set status = 'running', updated_at = ? where id = ?", now(), row.id] : addRow(job.id, seqsAfter(rows)[0], 'gate', name, elements().gate?.weight ?? 1, 'running'),
      ["update jobs set status = 'running', done_at = null where id = ? and status = 'done'", job.id],
    ]);
    return console.log(`${job.slug}: gate ${name} open. Now post the same text to Stef as your reply, ending in the question, and wait.`);
  }
  if (action === 'decided') {
    if (!DECISIONS.includes(decision)) fail(`usage: factory gate decided ${name} <${DECISIONS.join('|')}> --words "<Stef's words, verbatim>"`);
    if (!words?.trim()) fail('factory gate decided needs --words with Stef\'s words, verbatim.');
    const open = await db.prepare("select id from gates where job_id = ? and name = ? and status = 'open' order by id desc").get(job.id, name);
    if (!open) fail(`gate ${name} is not open; open it first with factory gate open ${name}.`);
    const row = rows.findLast(r => r.element === 'gate' && r.label === name && r.status === 'running');
    await emit(db, 'gate.decided', job.slug, { name, decision, words }, [
      ['update gates set status = ?, decision = ?, words = ?, decided_at = ? where id = ?', decision, decision, words, now(), open.id],
      ...(row ? [['update ledger set status = ?, note = ?, updated_at = ? where id = ?', GATE_ROW[decision], `${decision}, Stef: "${words}"`, now(), row.id]] : []),
    ]);
    return console.log(`${job.slug}: gate ${name} ${decision}.`);
  }
  fail('usage: factory gate open <name> [--body "<text>"] | factory gate decided <name> <decision> --words "<text>"');
}

export function hasLead(job) {
  return Boolean(job?.lead_session) && ['created', 'running'].includes(job.status);
}

export function plate(kind, subject, text) {
  return ['insert into plate (kind, subject, text, created_at) values (?, ?, ?, ?)', kind, subject, text, now()];
}

export function clearPlate(subject, ...kinds) {
  return [`update plate set cleared_at = ? where subject = ? and cleared_at is null${kinds.length ? ` and kind in (${kinds.map(() => '?').join(', ')})` : ''}`, now(), subject, ...kinds];
}

export async function prJob(db, url) {
  const pr = await db.prepare('select * from prs where url = ?').get(url);
  return { pr, job: pr?.job_id ? await db.prepare('select * from jobs where id = ?').get(pr.job_id) : null };
}

export async function prAdd(db, args) {
  const p = parseUrl(args[0]);
  if (!p) fail('usage: factory pr add <github pr url> [--job <slug>] [--move] | factory pr ignore <url>');
  const move = args.includes('--move');
  const job = await jobFor(db, args.filter(a => a !== '--move'));
  const owner = await db.prepare('select j.slug from prs p join jobs j on j.id = p.job_id where p.url = ?').get(p.url);
  if (owner && owner.slug !== job.slug && !move) fail(`${p.url} already belongs to job ${owner.slug}; add --move to give it to ${job.slug}.`);
  const view = job.task_id ? null : json(process.env.FACTORY_GH || 'gh', ['pr', 'view', p.url, '--json', 'body,headRefName']);
  const task = view && taskOf(view.body, view.headRefName);
  await emit(db, 'pr.opened', p.url, { job: job.slug, number: p.number, repo: `${p.owner}/${p.repo}` }, [
    [`insert into prs (url, repo, number, job_id, state, created_at) values (?, ?, ?, ?, 'OPEN', ?)
      on conflict(url) do update set job_id = excluded.job_id, state = case when prs.state in ('unregistered', 'ignored') then 'OPEN' else prs.state end`,
    p.url, `${p.owner}/${p.repo}`, p.number, job.id, now()],
    clearPlate(p.url, 'unregistered'),
    ...(task ? [['update jobs set task_id = ? where id = ?', task, job.id], ['insert into tasks (workspace, task_id) values (?, ?) on conflict do nothing', job.slug, task]] : []),
  ]);
  console.log(`${p.url} registered to job ${job.slug}.${task ? ` Productive task ${task} recorded from the PR.` : ''}`);
}

const APP_PORTS = { api: 3100, devportal: 3104, 'developer-portal': 3170, frontend: 4301, 'ai-agent': 4370 };

export function taskOf(body = '', branch = '') {
  return body.match(/productive\.io\/[^/\s]+\/tasks\/(?:task\/)?(\d+)/)?.[1] ?? body.match(/^Task:\s*\[?(\d+)/m)?.[1] ?? branch.match(/(?:^|\/)(\d{7,9})(?:-|$)/)?.[1] ?? null;
}

async function freePort(db, base) {
  const taken = new Set((await db.prepare('select s.port from servers s join workspaces w on w.slug = s.workspace where w.machine = ?').all(MACHINE)).map(s => s.port));
  for (let p = base; p < base + 200; p++) {
    if (taken.has(p)) continue;
    if (spawnSync('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout.trim()) continue;
    return p;
  }
  return fail(`no free port near ${base}`);
}

export async function prAdopt(db, args) {
  const p = parseUrl(args[0]);
  if (!p) fail('usage: factory pr adopt <github pr url>');
  const owner = await db.prepare('select j.slug from prs p join jobs j on j.id = p.job_id where p.url = ?').get(p.url);
  if (owner) fail(`${p.url} already belongs to job ${owner.slug}.`);
  const pr = json(process.env.FACTORY_GH || 'gh', ['pr', 'view', p.url, '--json', 'title,body,headRefName,state']);
  if (!pr) fail(`could not read ${p.url} with gh`);
  if (pr.state !== 'OPEN') fail(`${p.url} is ${pr.state.toLowerCase()}, not open.`);
  const task = taskOf(pr.body, pr.headRefName);
  const app = APP_PORTS[p.repo] ? p.repo : null;
  const brief = [
    `Adopt the existing PR ${p.url} (${p.owner}/${p.repo}#${p.number}, branch ${pr.headRefName}): ${pr.title}.`,
    task ? `Productive task ${task}: https://app.productive.io/109-productive/tasks/${task}.` : 'No Productive task is linked in the PR; triage asks Stef for it if the work needs one.',
    'It is already open, so finish what it is missing rather than starting over: triage with the PR link routes `adopt` (criteria from the task plus every claim in the PR description, unresolved review threads in threads.md);',
    `the coder proves the existing change and fixes the gaps on the PR's own branch (in the ${app ? `./${app} worktree` : `a clone of ${p.owner}/${p.repo} inside the workspace`}, \`gh pr checkout ${p.number}\` first);`,
    'then review, judge (threads.md included), tester, Gate 2, and the shipper pushes to that same PR and updates its evidence section, never a new PR.',
  ].join(' ');
  const slug = await jobNew(db, ['work', brief, '--on', MACHINE, '--title', `pr ${p.number} ${pr.title}`, '--why', `adopted the unregistered PR ${p.url}`, ...(task ? ['--task', task] : []), ...(app ? ['--app', `${app}:${await freePort(db, APP_PORTS[app])}`] : [])]);
  await prAdd(db, [p.url, '--job', slug]);
  return slug;
}

export async function prIgnore(db, args) {
  const p = parseUrl(args[0]);
  if (!p) fail('usage: factory pr ignore <github pr url>');
  await emit(db, 'pr.ignored', p.url, {}, [["update prs set state = 'ignored' where url = ? and job_id is null", p.url], clearPlate(p.url, 'unregistered')]);
  return `${p.url} ignored.`;
}

export async function prDetach(db, args) {
  const p = parseUrl(args[0]);
  if (!p) fail('usage: factory pr detach <github pr url>');
  const { pr, job } = await prJob(db, p.url);
  if (!job) fail(`${p.url} is not attached to a job.`);
  if (pr.state !== 'CLOSED') fail(`${p.url} is ${pr.state}; only closed PRs can be detached.`);
  await emit(db, 'pr.detached', p.url, { job: job.slug }, [['update prs set job_id = null where url = ?', p.url]]);
  console.log(`${p.url} detached from job ${job.slug}.`);
}

export async function prRework(db, args) {
  const note = flag(args, '--note');
  const job = await jobFor(db, args);
  if (!note?.trim()) fail('usage: factory pr rework [--job <slug>] --note "<why the PR goes back to work>"');
  const rows = await ledger(db, job);
  const row = rows.find(r => r.element === 'pr' && r.status === 'running') ?? fail(`job ${job.slug} has no PR in review.`);
  const catalogue = elements();
  const last = rows.findLast(r => r.seq > row.seq && ['planned', 'running'].includes(r.status) && !['previous', 'pr', undefined].includes(catalogue[r.element]?.phase));
  await emit(db, 'pr.rework', job.slug, { row: row.id, note }, [
    ["update ledger set status = 'planned', seq = ?, updated_at = ? where id = ?", last ? seqsAfter(rows, last)[0] : row.seq, now(), row.id],
  ]);
  console.log(`${job.slug}: back to work, pr row ${row.id} waits${last ? ` after row ${last.id} ${rowName(last)}` : ''}.`);
}

export async function proposalNew(db, args, stdin) {
  const title = flag(args, '--title');
  const rung = flag(args, '--rung');
  const body = flag(args, '--body') ?? stdin();
  if (!title || !body?.trim()) fail('usage: factory proposal new --title "<title>" [--rung <rung>] <<\'EOF\' … EOF (body: evidence, why, exact diff)');
  const id = await emit(db, 'proposal.created', title, { rung }, [
    ['insert into proposals (title, rung, body, status, created_at) values (?, ?, ?, ?, ?)', title, rung ?? null, body, 'pending', now()],
  ]);
  const p = await db.prepare('select id from proposals order by id desc limit 1').get();
  console.log(`Proposal ${p.id} created (event ${id}).`);
}

export async function proposalDecide(db, id, decision) {
  const p = await db.prepare('select * from proposals where id = ?').get(Number(id));
  if (!p) fail(`no proposal ${id}`);
  if (p.status !== 'pending') fail(`proposal ${id} is ${p.status}, not pending`);
  const status = decision === 'accept' ? 'accepted' : 'declined';
  await emit(db, `proposal.${status}`, p.title, { id: p.id }, [['update proposals set status = ?, decided_at = ? where id = ?', status, now(), p.id]]);
  return `Proposal ${p.id} ${status}.`;
}

export async function scheduleRun(db, name) {
  const s = await db.prepare('select * from schedules where name = ?').get(name);
  if (!s) fail(`no schedule ${name}`);
  await emit(db, 'timer.due', s.name, { occurrence: now(), action: s.action, machine: s.machine ?? 'server', rerun: true }, [clearPlate(s.name, 'schedule-failed')]);
  return `Schedule ${s.name} queued; the ${s.machine ?? 'server'}'s scheduler runs it within a minute.`;
}

// A file in the job's DB folder: insert or replace, as a write for emit or a handler.
export function putFile(slug, name, body, by = null, machine = MACHINE) {
  return [`insert into files (job_id, name, body, created_by, machine, created_at) select id, ?, ?, ?, ?, ?::bigint from jobs where slug = ?
    on conflict (job_id, name) do update set body = excluded.body, created_by = excluded.created_by, machine = excluded.machine, created_at = excluded.created_at`,
  name, body, by, machine, now(), slug];
}

export function fileName(name) {
  const clean = String(name ?? '').replace(/^\.\//, '');
  if (!clean || clean.startsWith('/') || clean.split('/').some(p => !p || p === '.' || p === '..')) fail(`file names are relative, like coder-1.md or evidence/AC1-head.txt, not ${name ?? 'empty'}`);
  return clean;
}

export async function file(db, args, stdin) {
  const job = await jobFor(db, args);
  const [action, name] = args;
  if (action === 'put') {
    const body = stdin();
    if (!body) fail('factory file put <name> takes the content on stdin.');
    const clean = fileName(name);
    await emit(db, 'file.put', job.slug, { name: clean, bytes: Buffer.byteLength(body) }, [putFile(job.slug, clean, body, process.env.CLAUDE_CODE_SESSION_ID ?? null)]);
    return console.log(`${job.slug}: ${clean} saved (${Buffer.byteLength(body)} bytes).`);
  }
  if (action === 'cat') {
    const f = await db.prepare('select body from files where job_id = ? and name = ?').get(job.id, fileName(name));
    if (!f) fail(`job ${job.slug} has no file ${name}; factory file ls lists them.`);
    return process.stdout.write(f.body);
  }
  if (action === 'ls') {
    for (const f of await db.prepare('select name, length(body) as bytes, created_at from files where job_id = ? order by name').all(job.id)) {
      console.log(`${f.name.padEnd(48)} ${String(f.bytes).padStart(8)}  ${new Date(f.created_at).toLocaleString('sv')}`);
    }
    return;
  }
  fail('usage: factory file put <name> [--job <slug>] < content | factory file cat <name> [--job <slug>] | factory file ls [--job <slug>]');
}

function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

// Uncommitted or unpushed work in the workspace's repos (its own notes repo excluded).
// A HEAD that is a merged PR's head is pushed even after GitHub deleted its branch.
export function dirty(dir, merged = []) {
  const problems = [];
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const sub = path.join(dir, name);
    if (name.startsWith('.') || !fs.existsSync(path.join(sub, '.git'))) continue;
    if (git(sub, 'status', '--porcelain')) problems.push(`${name} has uncommitted changes`);
    if (merged.includes(git(sub, 'rev-parse', 'HEAD'))) continue;
    if (Number(git(sub, 'rev-list', '--count', 'HEAD', '--not', '--remotes') ?? 0) > 0) problems.push(`${name} has unpushed commits`);
  }
  return problems;
}

async function mergedHeads(db, slug) {
  return (await db.prepare("select p.head_sha from prs p join jobs j on j.id = p.job_id where j.slug = ? and p.state = 'MERGED'").all(slug)).map(p => p.head_sha);
}

async function workspaceArg(db, args) {
  const slug = args.find(a => !a.startsWith('--')) ?? workspaceOf(process.cwd());
  const ws = slug && await db.prepare('select * from workspaces where slug = ?').get(slug);
  return ws ?? fail(`usage: factory done|park|resume [<workspace>]; no factory workspace ${slug ?? 'here'}`);
}

const here = ws => ws.machine === MACHINE || fail(`${ws.slug} lives on the ${ws.machine}; run this there.`);

export async function done(db, args) {
  const ws = await workspaceArg(db, args);
  if (!['active', 'parked'].includes(ws.status)) fail(`${ws.slug} is ${ws.status}, not active or parked.`);
  const problems = args.includes('--force') || ws.machine !== MACHINE ? [] : dirty(ws.path, await mergedHeads(db, ws.slug));
  if (problems.length) fail(`Refusing to close ${ws.slug}: ${problems.join('; ')}. Commit and push (through the shipper) or discard first, or --force to close anyway.`);
  if (ws.status === 'parked') await resume(db, [ws.slug]);
  const job = await db.prepare('select * from jobs where slug = ?').get(ws.slug);
  const session = job?.lead_session ?? process.env.CLAUDE_CODE_SESSION_ID ?? null;
  await emit(db, 'workspace.closing', ws.slug, { session }, [["update workspaces set status = 'closing' where slug = ?", ws.slug]]);
  return `${ws.slug} closes once its lead's turn ends.`;
}

export async function park(db, args) {
  const ws = await workspaceArg(db, args);
  here(ws);
  const reason = args.filter(a => a !== ws.slug).join(' ');
  spawnSync(WS_BIN, ['park', ws.slug, ...(reason ? [reason] : [])], { encoding: 'utf8' });
  await emit(db, 'workspace.parked', ws.slug, { reason }, [
    ["update workspaces set status = 'parked', path = ? where slug = ?", path.join(WORKSPACES, '.parked', ws.slug), ws.slug],
    ["update jobs set status = 'parked' where slug = ? and status in ('created', 'running')", ws.slug],
  ]);
  console.log(`${ws.slug} parked.`);
}

export async function resume(db, args) {
  const ws = await workspaceArg(db, args);
  if (ws.status !== 'parked') fail(`${ws.slug} is ${ws.status}, not parked.`);
  here(ws);
  spawnSync(WS_BIN, ['reopen', ws.slug], { encoding: 'utf8' });
  await emit(db, 'workspace.resumed', ws.slug, {}, [
    ["update workspaces set status = 'active', path = ? where slug = ?", path.join(WORKSPACES, ws.slug), ws.slug],
    ["update jobs set status = 'running' where slug = ? and status = 'parked'", ws.slug],
  ]);
  console.log(`${ws.slug} resumed; open it with workspaces open ${ws.slug}.`);
}

export async function reopen(db, args) {
  const ws = await workspaceArg(db, args);
  if (ws.status !== 'closed') fail(`${ws.slug} is ${ws.status}, not closed (parked ones use factory resume).`);
  here(ws);
  const dest = path.join(WORKSPACES, ws.slug);
  if (fs.existsSync(dest)) {
    if (fs.readdirSync(dest).some(e => e !== '.factory')) fail(`${dest} already exists with other files.`);
    fs.cpSync(dest, path.join(WORKSPACES, '.done', ws.slug), { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true });
  }
  const r = spawnSync(WS_BIN, ['reopen', ws.slug], { encoding: 'utf8' });
  if (r.status !== 0) fail(`workspaces reopen ${ws.slug} failed: ${`${r.stdout}${r.stderr}`.trim().split('\n').pop()}`);
  const job = await db.prepare("select * from jobs where slug = ? and status = 'closed'").get(ws.slug);
  await emit(db, 'workspace.reopened', ws.slug, {}, [
    ["update workspaces set status = 'active', closed_at = null, path = ? where slug = ?", dest, ws.slug],
    ["update jobs set status = 'running' where slug = ? and status = 'closed'", ws.slug],
  ]);
  if (job) spawnSync(WS_BIN, ['open', ws.slug, '--no-focus', '--prompt', `You lead factory job ${ws.slug}. Run \`factory job start\` first.`], { encoding: 'utf8', env: { ...process.env, HERDR_ENV: process.env.HERDR_ENV ?? '1' } });
  console.log(`${ws.slug} reopened${job ? '; its lead is starting' : ''}.`);
}

export function worktreesOf(dir) {
  return (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter(n => fs.statSync(path.join(dir, n, '.git'), { throwIfNoEntry: false })?.isFile())
    .map(app => ({ app, branch: git(path.join(dir, app), 'branch', '--show-current'), sha: git(path.join(dir, app), 'rev-parse', 'HEAD') }));
}

// Worker side of a move: an idle lead whose PR is up hands its job to the server, which carries review, merge and soak.
// Returns the refusal, or null once the job and its lead's transcript are on the server.
export async function moveToServer(db, slug, { ssh = SERVER_SSH } = {}) {
  const job = await db.prepare('select * from jobs where slug = ?').get(slug);
  const ws = await db.prepare('select * from workspaces where slug = ?').get(slug);
  if (job.machine === 'server') return `${slug} is already on the server.`;
  const problems = dirty(ws.path, await mergedHeads(db, slug));
  if (problems.length) return `${slug} stays on the ${job.machine}: ${problems.join('; ')}.`;
  const worktrees = worktreesOf(ws.path);
  const file = job.lead_session && transcript(job.lead_session);
  if (file) {
    const mk = spawnSync('ssh', [ssh, 'mkdir', '-p', path.dirname(file)], { encoding: 'utf8' });
    const cp = mk.status === 0 && spawnSync('scp', ['-q', file, `${ssh}:${file}`], { encoding: 'utf8' });
    if (!cp || cp.status !== 0) return `${slug} stays on the ${job.machine}: copying the lead's transcript to ${ssh} failed: ${`${mk.stderr}${cp?.stderr ?? ''}`.trim()}`;
  }
  const r = spawnSync(WS_BIN, ['done', slug], { encoding: 'utf8' });
  if (r.status !== 0) return `${slug} stays on the ${job.machine}: workspaces done failed: ${`${r.stdout}${r.stderr}`.trim().split('\n').pop()}`;
  await emit(db, 'job.moved', slug, { from: job.machine, to: 'server', worktrees, transcript: Boolean(file) }, [
    ["update jobs set machine = 'server' where id = ?", job.id],
    ["update workspaces set machine = 'server' where slug = ?", slug],
  ]);
  return null;
}

// Server side of a move: the workspace and its worktrees at the pushed branches, with the lead left asleep.
export async function moveIn(db, slug, worktrees) {
  const made = spawnSync(WS_BIN, ['new', slug, '--agent', `lead-${(await db.prepare('select lead_mode from jobs where slug = ?').get(slug)).lead_mode}`], { encoding: 'utf8' });
  const out = `${made.stdout}${made.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
  if (!/(?:Created|Already exists): /.test(out)) fail(`workspaces new ${slug} failed: ${out.trim()}`);
  const dir = path.join(WORKSPACES, slug);
  const repos = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/workspaces/config.json'), 'utf8')).repos ?? {};
  for (const w of worktrees) {
    const repo = repos[w.app];
    if (!repo || !fs.existsSync(repo)) fail(`no ${w.app} repo here (workspaces config: ${repo ?? 'none'}).`);
    if (git(repo, 'cat-file', '-e', `${w.sha}^{commit}`) === null) git(repo, 'fetch', '--quiet', 'origin');
    if (git(repo, 'cat-file', '-e', `${w.sha}^{commit}`) === null) git(repo, 'fetch', '--quiet', 'origin', w.sha);
    if (git(repo, 'cat-file', '-e', `${w.sha}^{commit}`) === null) fail(`${w.app} commit ${w.sha} is not on origin.`);
    if (fs.existsSync(path.join(dir, w.app))) continue;
    const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, 'worktree', 'add', ...(w.branch ? ['-B', w.branch] : ['--detach']), path.join(dir, w.app), w.sha], { encoding: 'utf8' });
    if (r.status !== 0) fail(`worktree ${w.app} failed: ${r.stderr.trim()}`);
    if (w.branch && git(repo, 'fetch', '--quiet', 'origin', w.branch) !== null) git(path.join(dir, w.app), 'branch', '--set-upstream-to', `origin/${w.branch}`);
  }
}

export function readStdin() {
  try { return tty.isatty(0) ? '' : fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

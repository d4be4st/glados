import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MACHINE, WORKSPACES, tx } from './db.mjs';

const SHOWN = /\.(md|txt|json|jsonl|log|sql|rb|html?|csv|ya?ml|diff|patch)$/i;
const BY_JOB = ['steps', 'gates', 'ledger', 'messages'];

async function columns(t, table) {
  return new Map((await t.query('select column_name, data_type from information_schema.columns where table_name = ? and table_schema = current_schema()', [table])).rows.map(r => [r.column_name, r.data_type]));
}

// SQLite kept some file-time timestamps as fractions; integer columns get them rounded.
const value = (v, type) => (typeof v === 'number' && ['bigint', 'integer'].includes(type) ? Math.round(v) : v);

async function insert(t, table, row, cols, returning = false) {
  const keys = Object.keys(row).filter(k => cols.has(k));
  const sql = `insert into ${table} (${keys.join(', ')}) values (${keys.map(() => '?').join(', ')})${returning ? ' returning id' : ''}`;
  return (await t.query(sql, keys.map(k => value(row[k], cols.get(k))))).rows[0]?.id;
}

// Both machines' SQLite factories into the empty shared DB, in one transaction: jobs get new ids, every event keeps
// its time, is ordered by it and is marked imported so no handler runs it again.
export async function migrateDb(db, sources) {
  const lite = Object.entries(sources).map(([machine, file]) => {
    if (!fs.existsSync(file)) throw new Error(`no SQLite factory at ${file}`);
    return { machine, db: new DatabaseSync(file, { readOnly: true }) };
  });
  const all = (s, sql) => s.db.prepare(sql).all();
  for (const s of lite) s.received = new Set(all(s, "select subject from events where type = 'job.received'").map(r => r.subject));
  const slugs = lite.flatMap(s => all(s, 'select slug from jobs').map(r => [r.slug, s]));
  const clash = [...new Set(slugs.filter(([slug], i) => slugs.findIndex(([x]) => x === slug) !== i).map(c => c[0]))];
  const skip = new Set();
  for (const slug of clash) {
    const takers = lite.filter(s => s.received.has(slug));
    if (takers.length !== 1) throw new Error(`job ${slug} is on both machines and was not moved with job push; rename one side first.`);
    for (const s of lite) if (s !== takers[0]) skip.add(`${s.machine}:${slug}`);
  }
  return tx(db, async t => {
    if ((await t.query('select count(*) as n from jobs', [])).rows[0].n) throw new Error('the shared DB already has jobs; migrate db runs once, into an empty DB.');
    const cols = {};
    for (const table of ['jobs', 'workspaces', 'events', 'prs', 'sessions', 'servers', 'tasks', 'proposals', 'plate', 'timers', 'schedule_runs', 'daily', ...BY_JOB]) cols[table] = await columns(t, table);
    const counts = {};
    const count = table => { counts[table] = (counts[table] ?? 0) + 1; };
    const jobIds = new Map();
    for (const s of lite) {
      for (const { id, ...job } of all(s, 'select * from jobs order by id')) {
        if (skip.has(`${s.machine}:${job.slug}`)) continue;
        jobIds.set(`${s.machine}:${id}`, await insert(t, 'jobs', { ...job, machine: s.machine }, cols.jobs, true));
        count('jobs');
      }
      for (const ws of all(s, 'select * from workspaces')) {
        if (skip.has(`${s.machine}:${ws.slug}`)) continue;
        await insert(t, 'workspaces', { ...ws, machine: s.machine }, cols.workspaces);
        count('workspaces');
      }
      for (const table of BY_JOB) {
        for (const { id, ...row } of all(s, `select * from ${table} order by id`)) {
          const job = row.job_id == null ? null : jobIds.get(`${s.machine}:${row.job_id}`);
          if (row.job_id != null && !job) continue;
          await insert(t, table, { ...row, job_id: job }, cols[table]);
          count(table);
        }
      }
      for (const { id, ...row } of all(s, 'select * from proposals order by id')) { await insert(t, 'proposals', row, cols.proposals); count('proposals'); }
      for (const { id, ...row } of all(s, 'select * from plate order by id')) { await insert(t, 'plate', row, cols.plate); count('plate'); }
      for (const { id, ...row } of all(s, 'select * from timers order by id')) { await insert(t, 'timers', row, cols.timers); count('timers'); }
      for (const { id, ...row } of all(s, 'select * from schedule_runs order by id')) { await insert(t, 'schedule_runs', row, cols.schedule_runs); count('schedule_runs'); }
      for (const row of all(s, 'select * from daily')) { await insert(t, 'daily', { ...row, machine: s.machine }, cols.daily); count('daily'); }
      for (const row of all(s, 'select * from servers')) { await t.query('insert into servers (workspace, service, port, host, up) values (?, ?, ?, ?, ?) on conflict do nothing', [row.workspace, row.service, row.port, row.host, row.up]); count('servers'); }
      for (const row of all(s, 'select * from tasks')) { await t.query('insert into tasks (workspace, task_id, title, url) values (?, ?, ?, ?) on conflict do nothing', [row.workspace, row.task_id, row.title, row.url]); count('tasks'); }
      for (const row of all(s, 'select * from sessions')) {
        await t.query('insert into sessions (session_id, pid, name, cwd, kind, status, status_at, workspace, free, started_at, closed_at, pinned, machine) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing',
          [row.session_id, row.pid, row.name, row.cwd, row.kind, row.status, row.status_at, row.workspace, row.free, row.started_at, row.closed_at, row.pinned ?? 0, s.machine]);
        count('sessions');
      }
    }
    const prs = lite.flatMap(s => all(s, 'select * from prs').map(p => ({ ...p, job_id: p.job_id == null ? null : jobIds.get(`${s.machine}:${p.job_id}`) ?? null })));
    for (const url of new Set(prs.map(p => p.url))) {
      const pick = prs.filter(p => p.url === url).sort((a, b) => (b.job_id ? 1 : 0) - (a.job_id ? 1 : 0))[0];
      await insert(t, 'prs', pick, cols.prs);
      count('prs');
    }
    const cleared = await t.query(`update plate set cleared_at = (extract(epoch from now()) * 1000)::bigint where kind = 'unregistered' and cleared_at is null
      and subject in (select url from prs where job_id is not null)`, []);
    counts['unregistered plate items cleared'] = cleared.rowCount;
    const events = lite.flatMap((s, n) => all(s, 'select * from events order by id').map(e => ({ ...e, n })))
      .sort((a, b) => a.ts - b.ts || a.n - b.n || a.id - b.id);
    for (const { id, n, ...e } of events) {
      await insert(t, 'events', { ...e, data: JSON.stringify({ ...(e.data ? JSON.parse(e.data) : {}), imported: true }) }, cols.events);
      count('events');
    }
    for (const s of lite) s.db.close();
    return `migrated ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`;
  });
}

function walk(dir, depth = 0) {
  const out = [];
  for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    const f = path.join(dir, e.name);
    if (e.isDirectory() && depth < 4) out.push(...walk(f, depth + 1));
    else if (e.isFile() && SHOWN.test(e.name)) out.push(f);
  }
  return out;
}

// This machine's <workspace>/.factory files (active, parked and done workspaces) into the files table of their job.
// A run dir named after the job drops out of the name; another run keeps its dir: coder-1.md, pr22/judge-1.md.
export async function migrateFiles(db, { root = WORKSPACES, machine = MACHINE } = {}) {
  const jobs = new Map((await db.prepare('select id, slug from jobs').all()).map(j => [j.slug, j.id]));
  let saved = 0;
  let skipped = 0;
  for (const base of [root, path.join(root, '.parked'), path.join(root, '.done')]) {
    for (const slug of fs.existsSync(base) ? fs.readdirSync(base) : []) {
      const dir = path.join(base, slug, '.factory');
      const job = jobs.get(slug);
      if (!job || !fs.existsSync(dir)) continue;
      for (const file of walk(dir)) {
        const rel = path.relative(dir, file).split(path.sep);
        const name = (rel[0] === slug && rel.length > 1 ? rel.slice(1) : rel).join('/');
        const r = await db.prepare(`insert into files (job_id, name, body, created_by, machine, created_at) values (?, ?, ?, 'migrate', ?, ?)
          on conflict (job_id, name) do nothing`).run(job, name, fs.readFileSync(file, 'utf8').replace(/\0/g, ''), machine, Math.round(fs.statSync(file).mtimeMs));
        if (r.changes) saved++; else skipped++;
      }
    }
  }
  return `saved ${saved} files${skipped ? `, ${skipped} already there` : ''}`;
}

#!/usr/bin/env -S node --no-warnings
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE, DIR, HOME, MACHINE, MACHINES, PRIMARY, WORK, open, emit, dispatchOne, listen, maxId } from './db.mjs';

const PID = path.join(HOME, 'scheduler.pid');
const TICK_MS = Number(process.env.FACTORY_TICK_MS ?? 60 * 1000);
const HANDLERS = process.env.FACTORY_HANDLERS || path.join(DIR, 'handlers');
const POLLERS = process.env.FACTORY_POLLERS || path.join(DIR, 'pollers');

const USAGE = [
  'usage: factory start | stop | status     run this machine\'s scheduler in the background / stop it / show it (FACTORY_MACHINE=server|worker)',
  '       factory dash [--once] [--width N]   the TUI (starts the scheduler when it is off); web dash on http://localhost:4281',
  '       factory glados                      open GLaDOS, the factory chat, at the work root',
  '       factory type check [<type>...]    validate job types against elements.yaml',
  '       factory job new <type> "<brief>" [--on server|worker] [--parent <slug>] [--title "<title>"] [--app api:3100] [--why "<what triggered this job>"]',
  '       factory job start | show [--full] | done [--job <slug>]          (leads) bind yourself / show the job (--full: finished rows with notes) / finish it',
  '       factory job task [<productive task id>] [--job <slug>]     record the job\'s Productive task / print it',
  '       factory file put <name> [--job <slug>] < content | file cat <name> | file ls     the job\'s reports, criteria and evidence, kept in the factory DB',
  '       factory done [<workspace>] [--force]  close a workspace once its lead\'s turn ends (refused with uncommitted/unpushed work unless --force)',
  '       factory park [<workspace>] [reason] | resume <workspace> | reopen <workspace>   (reopen: a closed one, with a new lead)',
  '       factory step <element|row id> start|done|failed|skipped --note "<what happened, report name>" [--worker <agent>@<model>]',
  '       factory plan add <element>... [--label "<what>"] [--after <row id>] [--weight <n>] | plan drop <row id> --note "<why>" | plan prune [--keep <row id>,...] --note "<why>"   drop every unfinished non-watch row of a merged job',
  '       factory rerun [--job <slug>] --note "<why>"   start the job over: finished rows drop, progress back to 0%, then plan add the new plan',
  '       factory soak extend [--job <slug>] --to <days>d   add daily production soak checks up to that day, also on a done job',
  '       factory gate open <name> [--body "<text>" | stdin]',
  '       factory gate decided <name> approved|accepted|changes|stopped --words "<Stef\'s words>"',
  '       factory gate open ready|replies|merge --pr <url> ...     the ad-hoc PR gates: ready for review + reviewers / posting review replies / merging',
  '       factory pr add <url> [--job <slug>] | pr ignore <url>    register a PR to its job / drop an unregistered one',
  '       factory pr adopt <url>                   start a work job that takes over an unregistered PR (task id, worktree, brief)',
  '       factory pr detach <url>                  drop a closed PR from its job',
  '       factory pr rework [--job <slug>] --note "<why>"   an open PR goes back to work: the job leaves IN REVIEW until its rework rows are done',
  '       factory poll                        refresh PR state from GitHub now (after a merge, a push)',
  '       factory message --job <slug> "<text>" | message --to glados "<text>"   queue a message for the job\'s lead, or for GLaDOS',
  '       factory proposal list | new --title "<t>" [--rung r] < body | show <id> | accept <id> | decline <id>',
  '       factory migrate db worker=<factory.db> server=<factory.db>   copy both machines\' SQLite factories into the empty shared DB, once',
  '       factory migrate files                  copy this machine\'s <workspace>/.factory files into the shared DB (run on each machine)',
  '       factory events [--since YYYY-MM-DD] [--type <prefix>]     the raw event log',
  '       factory schedule list | add <name> "<cron>" "<backup | agent:<agent> <prompt> | prompt:<text>>" [--on server|worker] | run <name> | rm <name>',
  '       factory guard | validate | orders | track | prompted < hook payload',
  '       factory scheduler                 the scheduler itself (started by start)',
].join('\n');

const [cmd, ...args] = process.argv.slice(2);
const jobs = await import('./jobs.mjs');
const commands = {
  start, stop, status, scheduler, dash,
  type: a => (a[0] === 'check' ? jobs.typeCheck(a.slice(1)) : usage()),
  job: async a => {
    const sub = { new: jobs.jobNew, start: jobs.jobStart, done: jobs.jobDone, task: jobs.jobTask, show: async (db, x) => console.log(await jobs.describe(db, await jobs.jobFor(db, x), { full: x.includes('--full') })) }[a[0]];
    return sub ? sub(await open(), a.slice(1)) : usage();
  },
  file: async a => jobs.file(await open(), a, jobs.readStdin),
  step: async a => jobs.step(await open(), a),
  plan: async a => jobs.plan(await open(), a),
  rerun: async a => jobs.rerun(await open(), a),
  soak: async a => (a[0] === 'extend' ? jobs.soakExtend(await open(), a.slice(1)) : usage()),
  done: async a => console.log(await jobs.done(await open(), a)),
  park: async a => jobs.park(await open(), a),
  resume: async a => jobs.resume(await open(), a),
  reopen: async a => jobs.reopen(await open(), a),
  poll: async () => {
    const db = await open();
    const ctx = { db, log, machine: MACHINE, emit: (...a) => emit(db, ...a) };
    for (const p of ['github-search', 'github']) await (await import(`./pollers/${p}.mjs`)).default.run(ctx);
    console.log('GitHub polled.');
  },
  pr: async a => {
    const db = await open();
    const sub = { add: jobs.prAdd, ignore: async (d, x) => console.log(await jobs.prIgnore(d, x)), adopt: jobs.prAdopt, detach: jobs.prDetach, rework: jobs.prRework }[a[0]];
    return sub ? sub(db, a.slice(1)) : usage();
  },
  proposal: async a => {
    const db = await open();
    const [sub, id] = a;
    if (sub === 'new') return jobs.proposalNew(db, a.slice(1), jobs.readStdin);
    if (['accept', 'decline'].includes(sub)) return console.log(await jobs.proposalDecide(db, id, sub));
    if (sub === 'show') {
      const p = await db.prepare('select * from proposals where id = ?').get(Number(id));
      return p ? console.log(`# ${p.title}\nstatus: ${p.status}\nrung: ${p.rung ?? ''}\n\n${p.body}`) : usage();
    }
    for (const p of await db.prepare('select * from proposals order by id desc limit 30').all()) console.log(`${String(p.id).padStart(3)} ${p.status.padEnd(9)} ${p.title}`);
  },
  migrate: async a => {
    const m = await import('./migrate.mjs');
    if (a[0] === 'files') return console.log(await m.migrateFiles(await open()));
    const sources = Object.fromEntries(a.slice(1).map(s => s.split('=')));
    if (a[0] !== 'db' || !Object.keys(sources).length || Object.keys(sources).some(k => !MACHINES.includes(k))) return usage();
    console.log(await m.migrateDb(await open(), sources));
  },
  glados: () => spawnSync(CLAUDE, ['--agent', 'glados', '-n', 'glados'], { stdio: 'inherit', cwd: WORK }),
  events: async a => {
    const since = jobs.flag(a, '--since');
    const type = jobs.flag(a, '--type') ?? '';
    const rows = await (await open()).prepare('select * from events where ts >= ? and type like ? order by id').all(since ? Date.parse(since) : 0, `${type}%`);
    for (const r of rows) console.log(`${r.id} ${new Date(r.ts).toLocaleString('sv')} ${r.type} ${r.subject ?? ''} ${r.data ?? ''}`);
  },
  schedule: async a => {
    const db = await open();
    const on = jobs.flag(a, '--on') ?? null;
    const [sub, name, cron, action] = a;
    if (sub === 'list' || !sub) {
      for (const s of await db.prepare('select * from schedules order by name').all()) {
        const run = await db.prepare('select ts, ok from schedule_runs where name = ? order by id desc limit 1').get(s.name);
        console.log(`${s.name.padEnd(10)} ${(s.machine ?? 'server').padEnd(7)} ${s.cron.padEnd(14)} ${s.action.slice(0, 50).padEnd(50)} last ${run ? `${new Date(run.ts).toLocaleString('sv')} ${run.ok ? 'ok' : 'FAILED'}` : 'never'}`);
      }
    } else if (sub === 'add' && name && cron && action && (!on || MACHINES.includes(on))) {
      (await import('./pollers/schedules.mjs')).parse(cron);
      await emit(db, 'schedule.added', name, { cron, action, machine: on }, [['insert into schedules (name, cron, action, last_fired, machine) values (?, ?, ?, ?, ?) on conflict (name) do update set cron = excluded.cron, action = excluded.action, last_fired = excluded.last_fired, machine = excluded.machine', name, cron, action, Date.now(), on]]);
      console.log(`Schedule ${name} added.`);
    } else if (sub === 'run' && name) {
      console.log(await jobs.scheduleRun(db, name));
    } else if (sub === 'rm' && name) {
      await emit(db, 'schedule.removed', name, {}, [['delete from schedules where name = ?', name]]);
      console.log(`Schedule ${name} removed.`);
    } else usage();
  },
  message: async a => {
    const db = await open();
    const m = await import('./pollers/messages.mjs');
    const ctx = { emit: (...x) => emit(db, ...x) };
    const to = jobs.flag(a, '--to');
    if (to) {
      const s = await db.prepare('select session_id from sessions where closed_at is null and name = ? order by status_at desc nulls last').get(to);
      if (!s) throw new jobs.UsageError(`no live session named ${to}`);
      if (!a.join(' ').trim()) return usage();
      await m.queueTo(ctx, s.session_id, a.join(' ').trim());
      return console.log(`Queued for ${to}.`);
    }
    const job = await jobs.jobFor(db, a);
    if (!a.join(' ').trim()) return usage();
    await m.queue(ctx, job, a.join(' ').trim());
    console.log(`Queued for the lead of ${job.slug}.`);
  },
  gate: async a => jobs.gate(await open(), a, jobs.readStdin),
  guard: () => hook(async (h, input) => {
    const reason = await h.guard(input);
    if (reason) { process.stderr.write(`Blocked by factory policy: ${reason} Skip this step, carry on with the rest of your task, and note it in your report or reply.`); process.exit(2); }
  }),
  validate: () => hook(async (h, input) => {
    const reason = await h.validate(input);
    if (reason) { process.stderr.write(reason); process.exit(2); }
  }),
  orders: () => hook(async (h, input) => { const out = h.orders(input); if (out) console.log(JSON.stringify(out)); }),
  track: () => hook(async (h, input) => h.track(input)),
  prompted: () => hook(async (h, input) => h.prompted(input)),
};
if (!cmd || ['help', '-h', '--help'].includes(cmd)) {
  console.log(USAGE);
} else if (commands[cmd]) {
  try {
    await commands[cmd](args);
  } catch (e) {
    if (!(e instanceof jobs.UsageError)) throw e;
    console.error(e.message);
    process.exit(1);
  }
} else {
  usage();
}

function usage() {
  console.error(USAGE);
  process.exit(1);
}

async function hook(fn) {
  let input;
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return; }
  const h = await import('./hooks.mjs');
  try { await fn(h, input); } catch (e) { if (process.env.FACTORY_DEBUG) console.error(e); }
}

function alive() {
  const pid = Number(fs.existsSync(PID) && fs.readFileSync(PID, 'utf8'));
  if (!pid) return 0;
  try { process.kill(pid, 0); return pid; } catch { return 0; }
}

function lock() {
  for (;;) {
    try {
      fs.writeFileSync(PID, String(process.pid), { flag: 'wx' });
      return true;
    } catch {
      if (alive()) return false;
      fs.rmSync(PID, { force: true });
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function start() {
  const pid = alive();
  if (pid) {
    console.error(`factory is already on (scheduler pid ${pid}).`);
    process.exit(1);
  }
  if (!MACHINES.includes(process.env.FACTORY_MACHINE)) {
    console.error(`set FACTORY_MACHINE to ${MACHINES.join(' or ')} before starting the scheduler.`);
    process.exit(1);
  }
  fs.mkdirSync(HOME, { recursive: true });
  const out = fs.openSync(path.join(HOME, 'scheduler.log'), 'a');
  const child = spawn(process.execPath, ['--no-warnings', process.argv[1], 'scheduler'], { detached: true, stdio: ['ignore', out, out] });
  child.unref();
  for (let i = 0; i < 100 && alive() !== child.pid; i++) {
    if (child.exitCode !== null) break;
    await sleep(50);
  }
  if (alive() !== child.pid) {
    console.error('factory did not start; see state/scheduler.log.');
    process.exit(1);
  }
  console.log(`factory is on as the ${MACHINE} (scheduler pid ${child.pid}).`);
}

async function stop() {
  const pid = alive();
  if (!pid) return console.log('factory is already off.');
  process.kill(pid, 'SIGTERM');
  console.log('Stopping factory; waiting for running handlers.');
  while (alive() === pid) await sleep(100);
  console.log('factory is off.');
}

async function status() {
  const pid = alive();
  const db = await open();
  const started = await db.prepare("select ts, data from events where type = 'factory.started' and json_extract(data, '$.machine') = ? order by id desc limit 1").get(MACHINE);
  const lag = await db.prepare('select handler, last_event_id from cursors where machine = ? order by handler').all(MACHINE);
  console.log(pid ? `on as the ${MACHINE} since ${new Date(started?.ts ?? 0).toLocaleString('sv')} (pid ${pid}), web dash http://localhost:${process.env.FACTORY_WEB_PORT ?? 4281}` : `off (this is the ${MACHINE})`);
  console.log(`events: ${await maxId(db)}`);
  for (const c of lag) console.log(`  ${c.handler}: ${c.last_event_id}`);
}

async function dash(args) {
  const { render, interactive } = await import('./dash.mjs');
  const db = await open();
  if (args.includes('--once')) {
    const width = Number(args[args.indexOf('--width') + 1]) || process.stdout.columns || 40;
    return console.log((await render(db, { cursor: -1, view: args.includes('--sessions') ? 'sessions' : 'home' }, width, Boolean(alive()))).lines.join('\n'));
  }
  if (!alive()) await start();
  interactive(db, () => Boolean(alive()));
}

function log(text) {
  console.log(`${new Date().toLocaleString('sv')} ${String(text).replace(/\s+/g, ' ').slice(0, 500)}`);
}

// The handlers and pollers this machine runs: everything on the server, only machine-scoped ones on a worker.
async function load(dir, primary = PRIMARY) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.mjs')).sort();
  const all = await Promise.all(files.map(async f => (await import(path.join(dir, f))).default));
  return all.filter(x => primary || x.scope === 'machine');
}

async function scheduler() {
  fs.mkdirSync(HOME, { recursive: true });
  if (!MACHINES.includes(process.env.FACTORY_MACHINE)) {
    console.error(`set FACTORY_MACHINE to ${MACHINES.join(' or ')}.`);
    process.exit(1);
  }
  if (!lock()) {
    console.error(`The scheduler already runs (pid ${alive()}).`);
    process.exit(1);
  }
  const db = await open();
  const handlers = await load(HANDLERS);
  const pollers = await load(POLLERS);
  const running = new Map();
  let stopping = false;
  let wakeAll = () => {};
  const ctx = { log, machine: MACHINE, emit: async (...a) => { const id = await emit(db, ...a); kick(); return id; } };

  function kick() {
    for (const h of handlers) {
      if (stopping || running.has(h.name)) continue;
      running.set(h.name, dispatchOne(db, h, ctx).catch(e => log(`handler ${h.name}: ${e.message}`)).finally(() => running.delete(h.name)));
    }
  }

  const sleepers = new Map();
  const pause = (name, ms) => new Promise(r => {
    const t = setTimeout(() => { sleepers.delete(name); r(); }, ms);
    sleepers.set(name, () => { clearTimeout(t); sleepers.delete(name); r(); });
  });
  const wake = name => sleepers.get(name)?.();
  wakeAll = () => { for (const name of [...sleepers.keys()]) wake(name); };

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { stopping = true; wakeAll(); });
  await emit(db, 'factory.started', null, { pid: process.pid, machine: MACHINE });
  log(`scheduler started as the ${MACHINE}, ${handlers.length} handlers, ${pollers.length} pollers`);
  const web = process.env.FACTORY_WEB_PORT === 'off' ? null : (await import('./web.mjs')).startWeb(db, { alive: () => !stopping, log });
  const stopListen = listen(payload => {
    kick();
    const type = payload?.split(' ')[1];
    for (const p of pollers) if (type && p.wakeOn?.includes(type)) wake(p.name);
  }, db.url);
  const loops = pollers.map(async p => {
    while (!stopping) {
      try { await p.run({ ...ctx, db, stopping: () => stopping }); } catch (e) { log(`poller ${p.name}: ${e.message}`); }
      if (!stopping) await pause(p.name, p.every ?? TICK_MS);
    }
  });
  while (!stopping) {
    kick();
    await pause('tick', TICK_MS);
  }
  stopListen();
  await Promise.all(loops);
  await Promise.all(running.values());
  web?.close();
  await emit(db, 'factory.closed', null, { pid: process.pid, machine: MACHINE });
  log('scheduler stopped');
  fs.rmSync(PID, { force: true });
  await db.close();
}

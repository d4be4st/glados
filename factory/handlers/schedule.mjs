import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE, HOME, WORK, now } from '../db.mjs';
import { plate } from '../jobs.mjs';
import { OUTAGE, headless, online } from './soak.mjs';

const KEEP = 7;

const PG_DUMP = (process.env.FACTORY_PG_DUMP || 'docker exec postgres pg_dump').split(/\s+/);

// A custom-format pg_dump of the factory database (only its schema when the URL pins one), one file per day.
export async function backup(db, dir = path.join(HOME, 'backups')) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `factory-${new Date(now()).toLocaleDateString('sv')}.dump`);
  const url = new URL(db.url);
  const schema = decodeURIComponent(url.searchParams.get('options') ?? '').match(/search_path=(\w+)/)?.[1];
  const args = [...PG_DUMP.slice(1), '-Fc', '-U', decodeURIComponent(url.username), '-d', url.pathname.slice(1), ...(schema ? ['-n', schema] : [])];
  const code = await new Promise(resolve => {
    const child = spawn(PG_DUMP[0], args, { stdio: ['ignore', fs.openSync(file, 'w'), 'pipe'] });
    child.on('close', resolve);
    child.on('error', () => resolve(-1));
  });
  if (code !== 0) throw new Error(`pg_dump exited ${code}`);
  const all = fs.readdirSync(dir).filter(f => /^factory-.*\.dump$/.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP))) fs.rmSync(path.join(dir, old));
  return `backed up to ${file}; ${Math.min(all.length, KEEP)} kept`;
}

function prompt(text) {
  return new Promise(resolve => {
    const child = spawn(CLAUDE, ['-p', '--permission-mode', 'auto', '--no-session-persistence', text], { cwd: WORK, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', code => resolve({ out, code }));
    child.on('error', e => resolve({ out: e.message, code: -1 }));
  });
}

// Actions: "backup", "agent:<agent> <prompt>", "prompt:<text>".
export async function runAction(action, ctx) {
  if (action === 'backup') return backup(ctx.db).then(out => ({ out, code: 0 }), e => ({ out: e.message, code: 1 }));
  const m = action.match(/^agent:(\S+)\s+([\s\S]*)$/);
  if (m) return (ctx.headless ?? headless)(m[1], m[2]);
  if (action.startsWith('prompt:')) return (ctx.prompt ?? prompt)(action.slice(7).trim());
  return { out: `unknown action ${action}`, code: 1 };
}

export default {
  name: 'schedule',
  scope: 'machine',
  on: ['timer.due'],
  async run(row, ctx) {
    if ((row.data.machine ?? 'server') !== ctx.machine) return;
    const action = row.data.action ?? '';
    const up = ctx.online ?? online;
    if (action !== 'backup' && !await up()) throw new Error(`offline; schedule ${row.subject} waits for the network`);
    const { out, code } = await runAction(action, ctx);
    if (code !== 0 && action !== 'backup' && (OUTAGE.test(out) || !await up())) throw new Error(`went offline during schedule ${row.subject}; it runs again once the network is back`);
    const ok = code === 0 ? 1 : 0;
    ctx.emit(`schedule.${ok ? 'ran' : 'failed'}`, row.subject, { code, output: out.slice(-2000) }, [
      ['insert into schedule_runs (name, ts, output, ok) values (?, ?, ?, ?)', row.subject, now(), out.slice(-20000), ok],
      ...(ok ? [] : [plate('schedule-failed', row.subject, `schedule ${row.subject} failed (exit ${code}): ${out.trim().split('\n').at(-1) ?? ''}`)]),
    ]);
  },
};

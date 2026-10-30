import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE, WORK, now } from '../db.mjs';
import { putFile } from '../jobs.mjs';
import { timer } from '../pollers/timers.mjs';

const VERDICT = /verdict\W*(done-verified|done-unverified|failed|error)\b/i;
export const OUTAGE = /Can't reach the API server|You've hit your (session|usage|weekly) limit/;
const MAX_ERRORS = 3;
const RETRY_MS = 30 * 60e3;
const INERT = /^(spec|spec_old|spec_new|knowledge|rubocop_cops)\/|\.md$|^\.rubocop[^/]*\.yml$/;

export function changedFiles(url) {
  const [, repo, n] = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/) ?? [];
  return new Promise(resolve => {
    if (!repo) return resolve([]);
    const child = spawn('gh', ['api', '--paginate', `repos/${repo}/pulls/${n}/files`, '-q', '.[].filename'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('close', code => resolve(code === 0 ? out.split('\n').filter(Boolean) : []));
    child.on('error', () => resolve([]));
  });
}

export function headless(agent, prompt, { model, cwd = WORK } = {}) {
  return new Promise(resolve => {
    const child = spawn(CLAUDE, ['-p', '--agent', agent, '--permission-mode', 'auto', '--no-session-persistence', ...(model ? ['--model', model] : []), prompt],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('close', code => resolve({ out, code }));
    child.on('error', () => resolve({ out, code: -1 }));
  });
}

export function bugsnagAuthed() {
  return new Promise(resolve => {
    const child = spawn(process.env.FACTORY_TB_BUG || 'tb-bug', ['doctor', '--no-cache'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('close', code => resolve(code === 0 && /^Token:.*\svalid$/m.test(out)));
    child.on('error', () => resolve(false));
  });
}

export async function online() {
  try {
    await Promise.all(['https://api.anthropic.com', 'https://api.github.com', 'https://api.bugsnag.com'].map(u => fetch(u, { method: 'HEAD', signal: AbortSignal.timeout(5000) })));
    return true;
  } catch {
    return false;
  }
}

export default {
  name: 'soak',
  on: ['soak.due'],
  async run(row, ctx) {
    const { stage, checkpoint, job } = row.data;
    if (job && await ctx.db.prepare("select 1 from ledger l join jobs j on j.id = l.job_id where j.slug = ? and l.element = 'watch' and l.label = ? and l.status = 'dropped'").get(job, `${stage} +${checkpoint}`)) return;
    const up = ctx.online ?? online;
    if (!await up()) throw new Error('offline; the soak check waits for the network');
    const files = await (ctx.changedFiles ?? changedFiles)(row.subject);
    if (files.length && files.every(f => INERT.test(f))) return ctx.emit('soak.clean', row.subject, { stage, checkpoint, job, number: row.data.number, verdict: 'done-verified', summary: 'no runtime file changed (specs, docs, lint only); watcher not started' });
    const name = `soak-${stage}-${checkpoint}-${row.subject.split('/').pop()}.md`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-soak-'));
    const report = path.join(dir, name);
    const reached = (await ctx.db.prepare('select latest_at, production_at from prs where url = ?').get(row.subject))?.[`${stage}_at`];
    const at = reached ? ` at ${new Date(reached).toISOString()} (the factory saw it there; windows start at this time, not at a commit date)` : '';
    const project = { frontend: 'app' }[row.subject.split('/')[4]] ?? row.subject.split('/')[4];
    const prompt = [
      `Merged PR ${row.subject}, release stage ${stage}, checkpoint +${checkpoint} since it reached ${stage}${at}. Report path ${report}.`,
      `Check only the ${stage} stage: Bugsnag with \`tb-bug errors --project ${project} --stage ${stage}\` for errors whose stack touches the files the PR changed, first seen after it reached ${stage}.`,
      'Grafana, Sidekiq retry counts included, is not part of this check yet: leave it out of the report; it is not a source, so it never makes the verdict unverified.',
      ...(stage === 'latest' ? ['This is the latest stage: do not require the change to be in production.'] : []),
      'This run is headless: nobody answers questions. End your reply with the line VERDICT: done-verified, done-unverified, failed or error. Use error only when the check itself could not run (network, auth, missing tool), never for a finding about the PR.',
    ].join(' ');
    const { out } = await (ctx.bugsnagAuthed ?? bugsnagAuthed)()
      ? await (ctx.headless ?? headless)('factory-watcher', prompt)
      : { out: 'tb-bug doctor: Bugsnag token invalid or expired, watcher not started. Rotate BUGSNAG_AUTH_TOKEN (/secrets).\nVERDICT: error' };
    if (OUTAGE.test(out)) return ctx.write(...timer(now() + RETRY_MS, 'soak.due', row.subject, { stage, checkpoint, job, number: row.data.number }));
    const body = fs.existsSync(report) ? fs.readFileSync(report, 'utf8') : '';
    fs.rmSync(dir, { recursive: true, force: true });
    const verdict = [out, body].map(t => t.match(VERDICT)?.[1]?.toLowerCase()).find(Boolean) ?? 'error';
    if (verdict !== 'done-verified' && !await up()) throw new Error('went offline during the soak check; it runs again once the network is back');
    const data = { stage, checkpoint, job, number: row.data.number, report: body ? name : null, verdict, summary: out.trim().split('\n').slice(-4).join(' ').slice(0, 500) };
    if (job && body) ctx.write(...putFile(job, name, body, 'factory-watcher'));
    const errors = verdict === 'error' && (await ctx.db.prepare("select count(*) as n from events where type = 'soak.error' and subject = ? and json_extract(data, '$.stage') = ? and json_extract(data, '$.checkpoint') = ?").get(row.subject, stage, checkpoint)).n;
    if (verdict === 'error' && errors < MAX_ERRORS) {
      ctx.write(...timer(now() + RETRY_MS, 'soak.due', row.subject, { stage, checkpoint, job, number: row.data.number }));
      return ctx.emit('soak.error', row.subject, data);
    }
    ctx.emit(verdict === 'done-verified' ? 'soak.clean' : 'soak.signal', row.subject, data);
  },
};

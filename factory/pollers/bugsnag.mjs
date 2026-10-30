import { jsonAsync as json, now } from '../db.mjs';
import { parseUrl } from './github.mjs';

const GH = process.env.FACTORY_GH || 'gh';
const BUG = process.env.FACTORY_TB_BUG || 'tb-bug';
const WEEK = 7 * 24 * 3600 * 1000;
const NEAR = 5;
const checked = new Set();

export function hunks(patch = '') {
  return [...patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)].map(m => [Number(m[1]), Number(m[1]) + Number(m[2] ?? 1) - 1]);
}

// Pure: the strongest match between a stack and the PR's changed files.
export function match(frames, changes) {
  let best = null;
  for (const f of frames) {
    const file = changes.files.find(c => f.file && String(f.file).endsWith(c.file));
    if (!file) continue;
    const strong = file.hunks.some(([a, b]) => f.line >= a - NEAR && f.line <= b + NEAR);
    if (strong) return { strong: true, file: file.file, line: f.line };
    best ??= { strong: false, file: file.file, line: f.line };
  }
  return best;
}

async function changesOf(pr) {
  if (pr.changes) return JSON.parse(pr.changes);
  const p = parseUrl(pr.url);
  const files = (await json(GH, ['api', `repos/${p.owner}/${p.repo}/pulls/${p.number}/files`, '--paginate'])) ?? [];
  const body = (await json(GH, ['pr', 'view', pr.url, '--json', 'body']))?.body ?? '';
  return {
    files: files.map(f => ({ file: f.filename, hunks: hunks(f.patch) })),
    fixes: [...body.matchAll(/bugsnag\.com\/[^\s)]*\/errors\/([0-9a-f]{24})/g)].map(m => m[1]),
  };
}

export default {
  name: 'bugsnag',
  every: Number(process.env.FACTORY_BUGSNAG_MS ?? 10 * 60 * 1000),
  async run(ctx) {
    const prs = await ctx.db.prepare(`select p.*, j.slug from prs p join jobs j on j.id = p.job_id
      where p.repo = 'productiveio/api' and p.state = 'MERGED' and coalesce(p.merged_at, 0) > ? and (p.latest_at is not null or p.production_at is not null)`).all(now() - WEEK);
    if (!prs.length) return;
    const seen = new Set((await ctx.db.prepare("select subject || ' ' || json_extract(data, '$.stage') as k from events where type in ('error.new', 'error.regressed')").all()).map(r => r.k));
    for (const pr of prs) {
      const changes = await changesOf(pr);
      if (!pr.changes) await ctx.db.prepare('update prs set changes = ? where url = ?').run(JSON.stringify(changes), pr.url);
      for (const stage of ['latest', 'production']) {
        const since = pr[`${stage}_at`];
        if (!since) continue;
        const errors = (await json(BUG, ['errors', '--project', 'api', '--stage', stage, '--from', new Date(since).toISOString().slice(0, 10), '--sort', 'first_seen', '--limit', '100', '--json'])) ?? [];
        for (const e of errors) {
          const key = `${e.id} ${stage}`;
          if (seen.has(key)) continue;
          const base = { pr: pr.url, job: pr.slug, stage, class: e.error_class, message: e.message, first_seen: e.first_seen, last_seen: e.last_seen };
          if (changes.fixes.includes(e.id) && stage === 'production' && Date.parse(e.last_seen) > since) {
            seen.add(key);
            await ctx.emit('error.regressed', e.id, base);
            continue;
          }
          if (Date.parse(e.first_seen) <= since || checked.has(key)) continue;
          if (ctx.stopping?.()) return;
          checked.add(key);
          const ev = (await json(BUG, ['events', '--project', 'api', e.id, '--limit', '1', '--json']))?.[0];
          const full = ev && (await json(BUG, ['fetch', 'event', '--project', 'api', ev.id]));
          const frames = (full?.exceptions ?? []).flatMap(x => x.stacktrace ?? []).map(f => ({ file: f.file, line: f.line_number }));
          const hit = match(frames, changes);
          if (!hit) continue;
          seen.add(key);
          await ctx.emit('error.new', e.id, { ...base, ...hit });
        }
      }
    }
  },
};

import { prJob } from '../jobs.mjs';
import { load } from '../types.mjs';
import { timer } from '../pollers/timers.mjs';

export const DEFAULT_SOAK = { latest: ['1h', '4h'], production: ['1h', '4h', '24h'] };
const UNIT = { m: 60e3, h: 3600e3, d: 86400e3 };

export function ms(span) {
  const m = String(span).match(/^(\d+)([mhd])$/);
  if (!m) throw new Error(`cannot read soak checkpoint ${span}`);
  return Number(m[1]) * UNIT[m[2]];
}

export default {
  name: 'deploy-watch',
  on: ['pr.latest', 'pr.production'],
  async run(row, ctx) {
    const { pr, job } = await prJob(ctx.db, row.subject);
    if (!pr) return;
    const stage = row.type.slice(3);
    const soak = (job && load(job.type).soak) ?? DEFAULT_SOAK;
    const known = (await ctx.db.prepare("select data from timers where subject = ? and type = 'soak.due'").all(pr.url)).map(t => JSON.parse(t.data))
      .filter(t => t.stage === stage).map(t => t.checkpoint);
    for (const checkpoint of (soak[stage] ?? []).filter(c => !known.includes(c))) {
      ctx.write(...timer(row.ts + ms(checkpoint), 'soak.due', pr.url, { stage, checkpoint, job: job?.slug, number: pr.number }));
    }
  },
};

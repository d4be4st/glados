import { hasLead, plate } from '../jobs.mjs';
import { queue } from '../pollers/messages.mjs';

export default {
  name: 'route-error',
  on: ['error.new', 'error.regressed'],
  async run(row, ctx) {
    const d = row.data;
    if (row.type === 'error.new' && !d.strong) return;
    const job = d.job && await ctx.db.prepare('select * from jobs where slug = ?').get(d.job);
    const what = row.type === 'error.regressed' ? 'came back after the PR that fixed it reached production' : `is new on ${d.stage} and its stack hits a changed hunk (${d.file}:${d.line})`;
    const text = `Bugsnag ${d.class} (${row.subject}) ${what}: ${d.message ?? ''}. PR ${d.pr}.`;
    ctx.write(...plate(row.type === 'error.regressed' ? 'regressed' : 'error', d.pr, text));
    if (hasLead(job)) queue(ctx, job, `${text}\nInvestigate it (tb-bug) and draft a fix for Stef; start nothing on your own.`);
  },
};

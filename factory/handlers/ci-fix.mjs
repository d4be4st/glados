import { hasLead, plate, prJob } from '../jobs.mjs';
import { queue } from '../pollers/messages.mjs';

const STOP_AT = 3;

export default {
  name: 'ci-fix',
  on: ['ci.failed', 'ci.passed'],
  async run(row, ctx) {
    const { pr, job } = await prJob(ctx.db, row.subject);
    if (!pr) return;
    if (row.type === 'ci.passed') return ctx.write('update prs set ci_failures = 0 where url = ?', pr.url);
    const failures = pr.ci_failures + 1;
    ctx.write('update prs set ci_failures = ? where url = ?', failures, pr.url);
    const checks = (row.data.failing ?? []).map(f => `${f.name} (${f.url})`).join(', ') || 'a check';
    const text = `CI failed on ${pr.url} at ${String(row.data.sha).slice(0, 10)}: ${checks}. Run the shipper's CI triage: a flake gets one rerun; a failure in the diff gets a fix round and a push; a failure outside the diff means a stale base, so rebase.`;
    if (hasLead(job) && failures < STOP_AT) return queue(ctx, job, text);
    const why = failures >= STOP_AT ? `CI failed ${failures} times without a green in between; the lead is no longer messaged. ` : job ? 'No lead. ' : '';
    ctx.write(...plate('ci-failed', pr.url, `${why}${text}`));
  },
};

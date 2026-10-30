import { hasLead, plate, prJob } from '../jobs.mjs';
import { queue } from '../pollers/messages.mjs';

export default {
  name: 'ready',
  on: ['pr.ready'],
  async run(row, ctx) {
    const { pr, job } = await prJob(ctx.db, row.subject);
    if (!job) return;
    if (await ctx.db.prepare("select 1 from gates where job_id = ? and name = 'ready' and pr = ? and status = 'approved'").get(job.id, pr.url)) return;
    const text = `Stef marked ${pr.url} ready for review in GitHub. Recommend reviewers and bring them to Stef through the ready gate (reviewers only; the PR is already ready).`;
    if (hasLead(job)) return queue(ctx, job, text);
    ctx.write(...plate('ready', pr.url, `No lead. ${text}`));
  },
};

import { clearPlate, hasLead, prJob } from '../jobs.mjs';
import { queue } from '../pollers/messages.mjs';

export default {
  name: 'merged',
  on: ['pr.merged'],
  async run(row, ctx) {
    ctx.write(...clearPlate(row.subject));
    const { job } = await prJob(ctx.db, row.subject);
    const lead = hasLead(job) && await ctx.db.prepare('select closed_at from sessions where session_id = ?').get(job.lead_session);
    if (lead && !lead.closed_at) queue(ctx, job, `${row.subject} merged. Nothing to do until the release checks report.`);
  },
};

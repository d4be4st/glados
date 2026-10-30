import { hasLead, plate, prJob } from '../jobs.mjs';
import { queue } from '../pollers/messages.mjs';

export default {
  name: 'rebase',
  on: ['pr.conflict'],
  async run(row, ctx) {
    const { pr, job } = await prJob(ctx.db, row.subject);
    if (!pr) return;
    const text = `${pr.url} has merge conflicts at ${String(row.data.sha).slice(0, 10)}. Have the shipper rebase it on its base branch and push; a conflict it cannot resolve without guessing goes to Stef as a gate.`;
    if (hasLead(job)) return queue(ctx, job, text);
    ctx.write(...plate('conflict', pr.url, `${job ? 'No lead. ' : ''}${text}`));
  },
};

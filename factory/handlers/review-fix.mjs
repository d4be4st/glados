import { hasLead, plate, prJob } from '../jobs.mjs';
import { queue } from '../pollers/messages.mjs';

const SAID = { 'review.approved': 'approved', 'review.changes_requested': 'requested changes', 'review.commented': 'commented' };

export default {
  name: 'review-fix',
  on: ['review.approved', 'review.changes_requested', 'review.commented'],
  async run(row, ctx) {
    const { pr, job } = await prJob(ctx.db, row.subject);
    if (!pr) return;
    const d = row.data;
    const threads = (d.threads ?? []).map(t => `- ${t.path}:${t.line ?? '?'}: ${t.body}`).join('\n');
    const said = `${d.body?.trim() ? `${d.body.trim()}\n` : ''}${threads}`;
    if (d.own && hasLead(job)) return queue(ctx, job, `Stef commented on ${pr.url}; treat it as instructions for this job:\n${said}`);
    if (hasLead(job)) {
      const next = said
        ? `Verify each comment against the code (no code changes, no pushes): is it right, what would you change, and a reply draft per thread. Then open the replies gate (factory gate open replies --pr ${pr.url}) with your verdicts and drafts.`
        : `Tell Stef at the merge gate (factory gate open merge --pr ${pr.url}): who approved and the CI state.`;
      return queue(ctx, job, `${d.author} ${SAID[row.type]} on ${pr.url}.${said ? `\n${said}` : ''}\n${next}`);
    }
    const next = job ? ` Tell the lead of ${job.slug} what to do; review replies go through its replies gate.` : '';
    ctx.write(...plate('review', pr.url, `#${pr.number}: ${d.author} ${SAID[row.type]}.${said ? `\n${said}` : ''}${next}`));
  },
};

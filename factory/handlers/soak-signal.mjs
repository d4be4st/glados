import { hasLead, plate, prJob } from '../jobs.mjs';
import { queue } from '../pollers/messages.mjs';

export default {
  name: 'soak-signal',
  on: ['soak.signal'],
  async run(row, ctx) {
    const { job } = await prJob(ctx.db, row.subject);
    const d = row.data;
    const what = d.verdict === 'failed' ? 'found a signal' : `could not confirm clean (${d.verdict ?? 'no verdict'})`;
    const text = `Soak check ${d.stage} +${d.checkpoint} on ${row.subject} ${what}. Report: ${d.report}. ${d.summary ?? ''}`;
    ctx.write(...plate('soak-signal', row.subject, text));
    if (hasLead(job)) queue(ctx, job, `${text}\nRead the report and draft a fix for Stef; start nothing on your own.`);
  },
};

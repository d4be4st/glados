import { now } from '../db.mjs';

const PR_ROW = { 'pr.opened': 'running', 'pr.merged': 'done', 'pr.closed': 'failed' };

export default {
  name: 'ledger',
  on: ['soak.clean', 'soak.signal', 'pr.opened', 'pr.merged', 'pr.closed'],
  run(row, ctx) {
    const { job, stage, checkpoint, report, summary } = row.data;
    if (!job) return;
    if (PR_ROW[row.type]) {
      return ctx.write(`update ledger set status = ?, note = ?, updated_at = ? where id = (select l.id from ledger l join jobs j on j.id = l.job_id
        where j.slug = ? and l.element = 'pr' and l.status in ('planned', 'running') order by l.seq limit 1)`,
      PR_ROW[row.type], row.subject, now(), job);
    }
    ctx.write(`update ledger set status = ?, note = ?, updated_at = ? where id = (select l.id from ledger l join jobs j on j.id = l.job_id
      where j.slug = ? and l.element = 'watch' and l.label = ? and l.status in ('planned', 'running', 'failed') order by l.seq limit 1)`,
    row.type === 'soak.clean' ? 'done' : 'failed', [summary, report].filter(Boolean).join(', ') || null, now(), job, `${stage} +${checkpoint}`);
  },
};

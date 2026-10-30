import { now } from '../db.mjs';

export default {
  name: 'lead-missing',
  on: ['session.closed'],
  async run(row, ctx) {
    const job = await ctx.db.prepare("select * from jobs where lead_session = ? and status in ('created', 'running')").get(row.subject);
    if (!job) return;
    const moved = await ctx.db.prepare(`select 1 from events where type = 'job.moved' and subject = ?
      and id > (select coalesce(max(id), 0) from events where type = 'session.created' and subject = ?)`).get(job.slug, row.subject);
    if (moved) return;
    ctx.emit('job.lead_missing', job.slug, { session: row.subject }, [
      ["insert into plate (kind, subject, text, created_at) values ('lead-missing', ?, ?, ?)", job.slug, `job ${job.slug} has no lead; messages wait until one runs factory job start`, now()],
    ]);
  },
};

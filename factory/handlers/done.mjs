import { now } from '../db.mjs';
import { load, matches } from '../types.mjs';

export default {
  name: 'done',
  on: ['job.step', 'gate.decided', 'pr.merged', 'soak.clean'],
  async run(row, ctx) {
    const slug = row.data.job ?? row.subject;
    const job = await ctx.db.prepare('select * from jobs where slug = ?').get(slug);
    if (!job || job.status === 'done') return;
    if (!matches(load(job.type).done, row.type, row.data)) return;
    if (row.type === 'soak.clean' && await ctx.db.prepare("select 1 from events where type = 'soak.signal' and subject = ? and json_extract(data, '$.verdict') = 'failed'").get(row.subject)) return;
    ctx.emit('job.done', job.slug, { by: row.type, event: row.id }, [["update jobs set status = 'done', done_at = ? where id = ?", now(), job.id]]);
  },
};

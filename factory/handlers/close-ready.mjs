import { plate } from '../jobs.mjs';

export default {
  name: 'close-ready',
  on: ['job.done', 'pr.merged', 'pr.closed'],
  async run(row, ctx) {
    const slug = row.type === 'job.done' ? row.subject : row.data.job;
    const job = slug && await ctx.db.prepare('select * from jobs where slug = ?').get(slug);
    const ws = job && await ctx.db.prepare('select * from workspaces where slug = ?').get(slug);
    if (!job || job.status !== 'done' || ws?.status !== 'active') return;
    const open = (await ctx.db.prepare("select count(*) as n from prs where job_id = ? and state not in ('MERGED', 'CLOSED')").get(job.id)).n;
    const already = await ctx.db.prepare("select 1 from events where type = 'workspace.ready_to_close' and subject = ?").get(slug);
    if (open || already) return;
    ctx.emit('workspace.ready_to_close', slug, {}, [plate('ready-to-close', slug, `job ${slug} is done and its PRs are merged or closed; close it with D D on its row or factory done ${slug}.`)]);
  },
};

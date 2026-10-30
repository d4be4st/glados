import { now } from '../db.mjs';
import { moveToServer, plate } from '../jobs.mjs';

const IDLE_MS = Number(process.env.FACTORY_MOVE_IDLE_MS ?? 15 * 60e3);

export default {
  name: 'move',
  scope: 'machine',
  every: Number(process.env.FACTORY_MOVE_MS ?? 60000),
  async run(ctx) {
    if (ctx.machine === 'server') return;
    const jobs = await ctx.db.prepare(`select j.slug from jobs j join sessions s on s.session_id = j.lead_session
      where j.status = 'running' and j.machine = ? and s.closed_at is null and s.status = 'idle' and s.status_at < ?
        and exists (select 1 from prs p where p.job_id = j.id and (p.state = 'MERGED' or (p.state = 'OPEN' and coalesce(p.draft, 0) = 0)))
        and not exists (select 1 from prs p where p.job_id = j.id and p.state = 'OPEN' and p.draft = 1)
        and not exists (select 1 from gates g where g.job_id = j.id and g.status = 'open')
        and not exists (select 1 from messages m where m.job_id = j.id and m.status = 'queued')
        and coalesce((select l.status from ledger l where l.job_id = j.id order by l.updated_at desc nulls last, l.id desc limit 1), '') != 'failed'`).all(ctx.machine, now() - IDLE_MS);
    for (const j of jobs) {
      const refused = await (ctx.moveToServer ?? moveToServer)(ctx.db, j.slug);
      if (!refused || await ctx.db.prepare("select 1 from plate where kind = 'move-blocked' and subject = ? and text = ?").get(j.slug, refused)) continue;
      await ctx.emit('job.move_blocked', j.slug, { refused }, [plate('move-blocked', j.slug, refused)]);
    }
  },
};

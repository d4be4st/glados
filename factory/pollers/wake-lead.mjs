import { spawnSync } from 'node:child_process';
import { now } from '../db.mjs';
import { plate } from '../jobs.mjs';
import { transcript } from './messages.mjs';

const COOLDOWN_MS = Number(process.env.FACTORY_WAKE_COOLDOWN_MS ?? 10 * 60e3);
const MAX_WAKES = 3;

export default {
  name: 'wake-lead',
  scope: 'machine',
  wakeOn: ['message.queued'],
  every: Number(process.env.FACTORY_WAKE_MS ?? 30000),
  async run(ctx) {
    const jobs = await ctx.db.prepare(`select distinct j.slug, j.lead_session from messages m join jobs j on j.id = m.job_id
      where m.status = 'queued' and j.status in ('created', 'running') and j.lead_session is not null and j.machine = ?`).all(ctx.machine);
    for (const j of jobs) {
      const lead = await ctx.db.prepare('select closed_at from sessions where session_id = ?').get(j.lead_session);
      if (lead && !lead.closed_at) continue;
      const queued = await ctx.db.prepare("select m.id, m.text, m.created_at from messages m join jobs j on j.id = m.job_id where j.slug = ? and m.status = 'queued' order by m.id").all(j.slug);
      const tries = (await ctx.db.prepare("select count(*) as n from events where type = 'lead.waking' and subject = ? and ts >= ?").get(j.slug, queued[0].created_at ?? 0)).n;
      if (tries >= MAX_WAKES) {
        await ctx.emit('lead.wake_failed', j.slug, { tries, messages: queued.map(m => m.id) }, [
          ...queued.map(m => ["update messages set status = 'failed' where id = ?", m.id]),
          plate('wake-failed', j.slug, `the lead of ${j.slug} did not come back after ${tries} wakes; these messages were not delivered:\n${queued.map(m => m.text).join('\n')}`),
        ]);
        continue;
      }
      const last = (await ctx.db.prepare("select max(ts) as ts from events where type = 'lead.waking' and subject = ?").get(j.slug)).ts ?? 0;
      if (now() - last < COOLDOWN_MS) continue;
      const resume = transcript(j.lead_session) ? ['--resume', j.lead_session] : [];
      const ws = process.env.FACTORY_WORKSPACES || 'workspaces';
      spawnSync(ws, ['close', j.slug], { encoding: 'utf8' });
      spawnSync(ws, ['open', j.slug, '--no-focus', ...resume, '--prompt', `You lead factory job ${j.slug}. Run \`factory job start\` first; messages are waiting for you.`],
        { encoding: 'utf8', env: { ...process.env, HERDR_ENV: process.env.HERDR_ENV ?? '1' } });
      await ctx.emit('lead.waking', j.slug, { was: j.lead_session, resumed: resume.length > 0 });
    }
  },
};

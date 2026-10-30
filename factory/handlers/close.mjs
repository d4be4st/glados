import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { now } from '../db.mjs';
import { plate } from '../jobs.mjs';

const WS_BIN = process.env.FACTORY_WORKSPACES || 'workspaces';
const execFileP = promisify(execFile);

async function closingSession(db, slug) {
  const e = await db.prepare("select data from events where type = 'workspace.closing' and subject = ? order by id desc limit 1").get(slug);
  return e ? JSON.parse(e.data).session : null;
}

async function teardown(ctx, slug) {
  let out = '';
  try { out = (await execFileP(WS_BIN, ['done', slug], { timeout: 120000 })).stdout; } catch (e) {
    return ctx.write(...plate('close-failed', slug, `workspaces done ${slug} failed: ${e.message.split('\n')[0]}`));
  }
  ctx.emit('workspace.closed', slug, { output: out.replace(/\x1b\[[0-9;]*m/g, '').trim().slice(-500) }, [
    ["update workspaces set status = 'closed', closed_at = ? where slug = ?", now(), slug],
    ["update jobs set status = 'closed' where slug = ? and status != 'done'", slug],
    ["update plate set cleared_at = ? where subject = ? and cleared_at is null", now(), slug],
  ]);
}

export default {
  name: 'close',
  scope: 'machine',
  on: ['workspace.closing', 'session.idle', 'session.waiting', 'session.closed'],
  async run(row, ctx) {
    if (row.type === 'workspace.closing') {
      if ((await ctx.db.prepare('select machine from workspaces where slug = ?').get(row.subject))?.machine !== ctx.machine) return;
      const s = row.data.session && await ctx.db.prepare('select status, closed_at from sessions where session_id = ?').get(row.data.session);
      if (s && !s.closed_at && s.status === 'busy') return;
      return teardown(ctx, row.subject);
    }
    for (const ws of await ctx.db.prepare("select slug from workspaces where status = 'closing' and machine = ?").all(ctx.machine)) {
      if (await closingSession(ctx.db, ws.slug) === row.subject) await teardown(ctx, ws.slug);
    }
  },
};

import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE, DIR, WORK, now } from '../db.mjs';
import { plate } from '../jobs.mjs';

const DOTCLAUDE = path.join(os.homedir(), '.claude');
const IN_FLIGHT = `select 1 from events a join proposals p on p.id = json_extract(a.data, '$.id')::bigint
  where a.type = 'proposal.applying' and a.ts > ? and p.status = 'accepted' and not exists (select 1 from events e
  where e.type in ('session.idle', 'session.closed') and e.id > a.id and e.subject like json_extract(a.data, '$.session') || '%')`;

export function applyPrompt(id) {
  return [
    `Apply factory proposal ${id}; Stef accepted it from the dash, and that is the permission for one commit.`,
    `Read it with \`factory proposal show ${id}\` and make exactly the change in its diff, nothing else.`,
    `If a file under ${DIR} changed, run \`node ${path.join(DIR, 'test.mjs')}\`; if it fails, stop and say so.`,
    `If a file under ${DIR} changed and the tests passed, run \`factory stop && factory start\` so the running scheduler loads it.`,
    `Then commit and push ~/.claude with only the changed files, with a message naming the proposal and ending with the line \`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\`.`,
  ].join(' ');
}

const committed = (id, since) => spawnSync('git', ['-C', DOTCLAUDE, 'log', '-E', `--grep=proposal ${id}([^0-9]|$)`, `--since=@${Math.floor(since / 1000)}`, '--format=%h'],
  { encoding: 'utf8' }).stdout?.trim() !== '';

function start(ctx, p) {
  const spawn = ctx.startApply ?? (prompt => spawnSync(CLAUDE, ['--bg', '--add-dir', DOTCLAUDE, '-n', `apply-proposal-${p.id}`, '--permission-mode', 'auto', prompt],
    { cwd: WORK, encoding: 'utf8' }).stdout?.match(/backgrounded · (\S+)/)?.[1]);
  const session = spawn(applyPrompt(p.id));
  if (!session) return ctx.write(...plate('proposal-failed', p.title, `could not start the apply session for proposal ${p.id}; apply it by hand: factory proposal show ${p.id}`));
  ctx.emit('proposal.applying', p.title, { id: p.id, session }, [['update proposals set session = ? where id = ?', session, p.id]]);
}

export default {
  name: 'proposal',
  on: ['proposal.accepted', 'session.idle', 'session.closed'],
  async run(row, ctx) {
    const { db } = ctx;
    if (row.type !== 'proposal.accepted') {
      const p = await db.prepare("select * from proposals where status = 'accepted' and session is not null and ? like session || '%'").get(row.subject);
      if (p && !await db.prepare("select 1 from plate where kind = 'proposal-failed' and subject = ?").get(p.title) && !(ctx.committed ?? committed)(p.id, p.decided_at)) {
        ctx.write(...plate('proposal-failed', p.title, `apply-proposal-${p.id} stopped without a commit; read its last message (claude --resume ${row.subject}), then apply it by hand: factory proposal show ${p.id}`));
      }
    }
    if (await db.prepare(IN_FLIGHT).get(now() - 60 * 60 * 1000)) return;
    const next = await db.prepare("select * from proposals where status = 'accepted' and session is null order by id limit 1").get();
    if (next) start(ctx, next);
  },
};

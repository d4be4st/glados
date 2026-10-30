import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE, WORK, now } from '../db.mjs';

const projects = () => process.env.FACTORY_PROJECTS || path.join(os.homedir(), '.claude/projects');
const TRIES = 3;
const CONFIRM_MS = Number(process.env.FACTORY_CONFIRM_MS ?? 8000);

export function queue(ctx, job, text) {
  const body = `From factory [m-${crypto.randomBytes(4).toString('hex')}]: ${text}`;
  return ctx.emit('message.queued', job.slug, { text: body }, [['insert into messages (job_id, text, status, created_at) values (?, ?, ?, ?)', job.id, body, 'queued', now()]]);
}

// A message for one session that is not a job's lead, such as GLaDOS; the poller on that session's machine delivers it.
export function queueTo(ctx, sessionId, text) {
  const body = `From factory [m-${crypto.randomBytes(4).toString('hex')}]: ${text}`;
  return ctx.emit('message.queued', sessionId, { text: body }, [['insert into messages (session_id, text, status, created_at) values (?, ?, ?, ?)', sessionId, body, 'queued', now()]]);
}

export function transcript(sessionId) {
  const root = projects();
  for (const dir of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const file = path.join(root, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function seen(sessionId, marker) {
  const file = transcript(sessionId);
  return Boolean(file) && fs.readFileSync(file, 'utf8').includes(marker);
}

const execFileP = promisify(execFile);

export function send(lead, text) {
  const done = p => p.catch(() => null);
  if (process.env.FACTORY_SEND) return done(execFileP(process.env.FACTORY_SEND, [lead.session_id, text]));
  const prompt = `Use SendMessage to send the text between the <message> tags, verbatim, to the session named "${lead.name}" (session id ${lead.session_id}; if several sessions share that name, use the ref of the one with that session id). Reply with only "sent", or the error.\n<message>\n${text}\n</message>`;
  return done(execFileP(CLAUDE, ['-p', '--model', 'haiku', '--tools', 'SendMessage,ListAgents', '--allowedTools', 'SendMessage ListAgents', '--no-session-persistence', prompt],
    { cwd: WORK, timeout: 180000 }));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export default {
  name: 'messages',
  scope: 'machine',
  wakeOn: ['message.queued'],
  every: Number(process.env.FACTORY_MESSAGES_MS ?? 10000),
  async run(ctx) {
    const queued = await ctx.db.prepare(`select m.*, coalesce(j.slug, m.session_id) as slug, coalesce(j.lead_session, m.session_id) as lead_session
      from messages m left join jobs j on j.id = m.job_id left join sessions s on s.session_id = m.session_id
      where m.status = 'queued' and (j.machine = ? or (m.job_id is null and s.machine = ?)) order by m.id`).all(ctx.machine, ctx.machine);
    for (const m of queued) {
      const marker = m.text.match(/\[m-\w+\]/)[0];
      const lead = await ctx.db.prepare('select * from sessions where session_id = ?').get(m.lead_session ?? '');
      const delivered = () => ctx.emit('message.delivered', m.slug, { id: m.id, session: lead.session_id },
        [["update messages set status = 'delivered', session_id = ?, delivered_at = ? where id = ?", lead.session_id, now(), m.id]]);
      if (lead && seen(lead.session_id, marker)) { await delivered(); continue; }
      if (!lead || lead.closed_at) continue;
      const attempt = m.attempts + 1;
      await ctx.emit('message.sent', m.slug, { id: m.id, attempt, session: lead.session_id },
        [['update messages set attempts = ?, session_id = ? where id = ?', attempt, lead.session_id, m.id]]);
      await send(lead, m.text);
      let ok = false;
      for (const end = Date.now() + CONFIRM_MS; !ok && Date.now() < end; await sleep(500)) ok = seen(lead.session_id, marker);
      if (ok) await delivered();
      else if (attempt >= TRIES) {
        await ctx.emit('message.failed', m.slug, { id: m.id, attempts: attempt }, [
          ["update messages set status = 'failed' where id = ?", m.id],
          ["insert into plate (kind, subject, text, created_at) values ('message-failed', ?, ?, ?)", m.slug, `message not delivered to the lead after ${attempt} tries: ${m.text.slice(0, 200)}`, now()],
        ]);
      }
    }
  },
};

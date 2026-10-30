import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE, HERDR, MACHINE, SESSIONS, WORKSPACES, json, jsonAsync, now } from '../db.mjs';

const STATUSES = ['busy', 'idle', 'waiting'];

const real = p => { try { return fs.realpathSync(p); } catch { return p; } };

export function workspaceOf(cwd) {
  for (const base of [WORKSPACES, real(WORKSPACES)]) {
    const rel = path.relative(base, real(cwd ?? ''));
    const slug = rel.split(path.sep)[0];
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !slug.startsWith('.')) return slug;
  }
  return null;
}

export function registry(pid) {
  try {
    return JSON.parse(fs.readFileSync(path.join(SESSIONS, `${pid}.json`), 'utf8'));
  } catch {
    return {};
  }
}

const statusAt = pid => registry(pid).statusUpdatedAt ?? null;

// Each herdr pane that runs a Claude session: its herdr workspace label, pane, tab label, title and herdr state.
export function herdrWorkspaces() {
  const panes = json(HERDR, ['pane', 'list'])?.result?.panes ?? [];
  if (!panes.length) return {};
  const labels = Object.fromEntries((json(HERDR, ['workspace', 'list'])?.result?.workspaces ?? []).map(w => [w.workspace_id, w.label]));
  const tabs = Object.fromEntries((json(HERDR, ['tab', 'list'])?.result?.tabs ?? []).map(t => [t.tab_id, t.label]));
  return Object.fromEntries(panes.filter(p => p.agent_session?.value).map(p => [p.agent_session.value,
    { label: labels[p.workspace_id], pane: p.pane_id, tab: tabs[p.tab_id] ?? null, title: p.terminal_title_stripped || null, status: p.agent_status ?? null }]));
}

// Pure: the events that turn this machine's open session rows into the listed sessions.
export function diff(rows, listed, herdr = () => ({}), machine = MACHINE) {
  const open = new Map(rows.map(r => [r.session_id, r]));
  const out = [];
  const t = now();
  for (const s of listed) {
    const status = STATUSES.includes(s.status) ? s.status : 'idle';
    const at = statusAt(s.pid) ?? t;
    const row = open.get(s.sessionId);
    open.delete(s.sessionId);
    if (!row) {
      const slug = workspaceOf(s.cwd);
      const h = herdr()[s.sessionId] ?? {};
      const workspace = slug ?? h.label ?? null;
      const data = { pid: s.pid, name: s.name, cwd: s.cwd, kind: s.kind, status, workspace, free: !slug, machine };
      out.push({ type: 'session.created', subject: s.sessionId, data, writes: [[
        `insert into sessions (session_id, pid, name, cwd, kind, status, status_at, workspace, free, started_at, closed_at, machine, pane_id, tab, title, herdr_status)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?, ?, ?, ?, ?)
         on conflict(session_id) do update set pid = excluded.pid, name = excluded.name, cwd = excluded.cwd, status = excluded.status,
           status_at = excluded.status_at, closed_at = null, machine = excluded.machine`,
        s.sessionId, s.pid, s.name ?? null, s.cwd, s.kind, status, at, workspace, slug ? 0 : 1, s.startedAt ?? t, machine,
        h.pane ?? null, h.tab ?? null, h.title ?? null, h.status ?? null,
      ]] });
    } else if (row.status !== status) {
      out.push({ type: `session.${status}`, subject: s.sessionId, data: { name: s.name, from: row.status },
        writes: [['update sessions set status = ?, status_at = ?, name = ? where session_id = ?', status, at, s.name ?? row.name, s.sessionId]] });
    } else if (s.name && row.name !== s.name) {
      out.push({ type: 'session.renamed', subject: s.sessionId, data: { name: s.name, from: row.name },
        writes: [['update sessions set name = ? where session_id = ?', s.name, s.sessionId]] });
    }
  }
  for (const row of open.values()) {
    out.push({ type: 'session.closed', subject: row.session_id, data: { name: row.name },
      writes: [["update sessions set status = 'closed', status_at = ?, closed_at = ? where session_id = ?", t, t, row.session_id]] });
  }
  return out;
}

// Pure: the herdr columns that drifted on this machine's open session rows; no event, the dash only redraws.
export function herdrChanges(rows, herdr) {
  return rows.flatMap(r => {
    const h = herdr[r.session_id];
    if (!h) return [];
    const next = [h.pane ?? null, h.tab ?? null, h.title ?? null, h.status ?? null];
    if ([r.pane_id, r.tab, r.title, r.herdr_status].every((v, i) => v === next[i])) return [];
    return [['update sessions set pane_id = ?, tab = ?, title = ?, herdr_status = ? where session_id = ?', ...next, r.session_id]];
  });
}

export function openRows(db, machine = MACHINE) {
  return db.prepare('select * from sessions where closed_at is null and machine = ? order by started_at, session_id').all(machine);
}

export default {
  name: 'sessions',
  scope: 'machine',
  every: Number(process.env.FACTORY_SESSIONS_MS ?? 1000),
  async run(ctx) {
    const listed = await jsonAsync(CLAUDE, ['agents', '--json']);
    if (!Array.isArray(listed)) return;
    const herdr = herdrWorkspaces();
    const rows = await openRows(ctx.db, ctx.machine);
    for (const e of diff(rows, listed, () => herdr, ctx.machine)) await ctx.emit(e.type, e.subject, e.data, e.writes);
    const drift = herdrChanges(rows, herdr);
    for (const [sql, ...params] of drift) await ctx.db.prepare(sql).run(...params);
    if (drift.length) await ctx.db.prepare("select pg_notify('factory', '0 herdr')").get();
  },
};

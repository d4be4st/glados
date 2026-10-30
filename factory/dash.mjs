import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { HERDR, MACHINE, WORK, emit, json, listen, now } from './db.mjs';
import { DEFAULT_SOAK } from './handlers/deploy-watch.mjs';
import { progress, proposalDecide, scheduleRun } from './jobs.mjs';
import { transcript } from './pollers/messages.mjs';
import { registry } from './pollers/sessions.mjs';
import { load } from './types.mjs';

const CSI = '\x1b[';
const MOUSE_ON = `${CSI}?1000h${CSI}?1006h`;
const MOUSE_OFF = `${CSI}?1006l${CSI}?1000l`;
const TONES = { dim: 2, bold: 1, red: 31, green: 32, yellow: 33, magenta: 35, cyan: 36, blue: 94, purple: '38;5;141' };
const ICONS = { blocked: ['×', 'red'], working: ['◐', 'yellow'], done: ['✓', 'cyan'], idle: ['○', 'green'] };
const PRIORITY = ['blocked', 'done', 'working', 'idle'];
const MACHINE_BADGES = { server: '', worker: '' };

// herdr args for a pane on this machine, or on the other one through herdr's saved machine of the same name.
export const herdrOn = (machine, args) => (machine && machine !== MACHINE ? ['--machine', machine, ...args] : args);

export function age(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const paint = (text, tone, color) => (tone && color ? `${CSI}${TONES[tone]}m${text}${CSI}0m` : text);

async function header(db, alive) {
  const started = await db.prepare("select ts from events where type = 'factory.started' order by id desc limit 1").get();
  return alive && started ? `on since ${new Date(started.ts).toTimeString().slice(0, 5)}` : 'off';
}

// Why a running job needs Stef: an open gate, or its lead asked him something.
export function why(j) {
  if (j.progress.gate) return `gate ${j.progress.gate.name} waits for you`;
  if (j.lead?.status === 'waiting' && !j.lead.closed_at) return 'lead asked you a question';
  return null;
}

async function soakOf(db, pr) {
  const stage = pr.production_at ? 'production' : pr.latest_at ? 'latest' : 'merged';
  const dropped = new Set((await db.prepare("select label from ledger where job_id = ? and element = 'watch' and status = 'dropped'").all(pr.job_id)).map(r => r.label));
  const seen = Object.fromEntries((await db.prepare(`select type, json_extract(data, '$.stage') || ' +' || json_extract(data, '$.checkpoint') as label from events
      where subject = ? and type in ('soak.clean', 'soak.signal') order by id`).all(pr.url)).map(e => [e.label, e.type === 'soak.clean' ? 'done' : 'failed']));
  const watch = Object.entries(load(pr.type).soak ?? DEFAULT_SOAK).flatMap(([s, checkpoints]) => checkpoints.map(c => `${s} +${c}`))
    .filter(label => !dropped.has(label)).map(label => ({ label, status: seen[label] ?? 'planned' }));
  const next = watch.find(r => r.status === 'planned');
  const due = next && (await db.prepare(`select at from timers where subject = ? and type = 'soak.due' and fired_at is null
      and json_extract(data, '$.stage') || ' +' || json_extract(data, '$.checkpoint') = ?`).get(pr.url, next.label))?.at;
  return { pr, stage, watch, next, due };
}

export async function model(db, alive) {
  const jobs = await Promise.all((await db.prepare("select * from jobs where status in ('created', 'running') order by created_at").all())
    .map(async j => ({ ...j, progress: await progress(db, j), lead: await db.prepare('select * from sessions where session_id = ?').get(j.lead_session ?? '') })));
  const leads = new Set(jobs.map(j => j.lead_session).filter(Boolean));
  const [mergedRows, openRows, shippedRows, mergeable, prs, head, plate, proposals, parked, busy, all] = await Promise.all([
    db.prepare('select distinct job_id from prs where merged_at is not null').all(),
    db.prepare("select distinct job_id from prs where state = 'OPEN'").all(),
    db.prepare("select distinct job_id from ledger where element in ('shipper', 'pr') and status = 'done'").all(),
    db.prepare(`select p.url, p.repo, p.number, p.title, j.slug, j.lead_session from prs p left join jobs j on j.id = p.job_id
      where p.state = 'OPEN' and p.merge_ready = 1 and not exists (
        select 1 from events c where c.subject = p.url and c.type in ('review.commented', 'review.changes_requested') and json_extract(c.data, '$.own') = 'false'
          and not exists (select 1 from events x where x.subject = p.url and x.type = 'pr.pushed' and x.id > c.id))
      order by p.repo, p.number`).all(),
    db.prepare(`select p.*, j.slug, j.type, j.lead_session from prs p join jobs j on j.id = p.job_id
      where j.status in ('created', 'running') and j.type != 'project' and p.state in ('OPEN', 'MERGED') order by p.created_at`).all(),
    header(db, alive),
    db.prepare('select * from plate where cleared_at is null order by id').all(),
    db.prepare("select * from proposals where status = 'pending' order by id").all(),
    db.prepare("select slug from workspaces where status = 'parked' order by slug").all(),
    db.prepare("select * from sessions where closed_at is null and status = 'busy' order by status_at").all(),
    db.prepare("select * from sessions where closed_at is null order by status = 'waiting' desc, machine, workspace, name").all(),
  ]);
  const merged = new Set(mergedRows.map(r => r.job_id));
  const open = new Set(openRows.map(r => r.job_id));
  const shipped = new Set(shippedRows.map(r => r.job_id));
  const projects = jobs.filter(j => j.type === 'project');
  const waiting = j => j.progress.phase === 'pr' || (merged.has(j.id) && shipped.has(j.id) && !open.has(j.id));
  const inReview = prs.filter(p => p.state === 'OPEN' && !mergeable.some(m => m.url === p.url));
  const soaking = (await Promise.all(prs.filter(p => p.state === 'MERGED').map(p => soakOf(db, p)))).filter(s => s.watch.some(r => r.status !== 'done'));
  const shown = new Set([...inReview, ...mergeable, ...soaking.map(s => s.pr)].map(p => p.slug));
  return {
    projects,
    soaking,
    inReview,
    mergeable,
    active: jobs.filter(j => !projects.includes(j) && !(waiting(j) && shown.has(j.slug))),
    head,
    plate,
    proposals,
    parked,
    attention: jobs.filter(why),
    jobs,
    busy: busy.filter(s => !leads.has(s.session_id)),
    all,
  };
}

function wrap(text, w, max = 8) {
  const out = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && line.length + word.length + 1 > w) { out.push(line); line = word; } else line = line ? `${line} ${word}` : word;
    }
    if (line) out.push(line);
  }
  return out.length > max ? [...out.slice(0, max - 1), `${out[max - 1]} …`] : out;
}

// A headless `claude -p --agent X <prompt>` run: its agent and a one-line reading of the prompt it is running.
function headlessRun(s) {
  if (s.machine !== MACHINE || registry(s.pid).entrypoint !== 'sdk-cli') return null;
  const cmd = spawnSync('ps', ['-o', 'command=', '-p', String(s.pid)], { encoding: 'utf8' }).stdout.trim();
  const prompt = cmd.split('--no-session-persistence ').pop().replace(/^--model \S+ /, '');
  const soak = prompt.match(/Merged PR \S+\/([^/\s]+)\/pull\/(\d+), release stage (\w+), checkpoint (\+\w+)/);
  return { agent: registry(s.pid).agent ?? 'headless', what: soak ? `soak ${soak[1]}#${soak[2]} · ${soak[3]} ${soak[4]}` : prompt };
}

export function footerAgents(screen) {
  const foot = screen.split('\n').slice(screen.split('\n').findLastIndex(l => l.includes('────')) + 1).join('\n');
  return [...foot.matchAll(/^[ └├│╰]*[◯○●⏺◉] +(\S+)( \(\+\d+\))? {2,}(.+?)(?: {2,}.*)?$/gm)]
    .filter(r => r[1] !== 'main')
    .map(r => `${r[1].replace(/^factory-/, '')}${r[2] ?? ''} · ${r[3]}`);
}

function leadAgents(leads) {
  return Object.fromEntries(leads.filter(s => s.pane_id).map(s => [s.session_id,
    footerAgents(spawnSync(HERDR, herdrOn(s.machine, ['pane', 'read', s.pane_id, '--source', 'visible', '--lines', '12']), { encoding: 'utf8', timeout: 2000 }).stdout ?? '')]));
}

export function lastSaid(sessionId) {
  const file = transcript(sessionId);
  if (!file) return null;
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const buf = Buffer.alloc(Math.min(size, 262144));
  fs.readSync(fd, buf, 0, buf.length, size - buf.length);
  fs.closeSync(fd);
  for (const line of buf.toString('utf8').split('\n').reverse()) {
    try {
      const e = JSON.parse(line);
      const text = e.type === 'assistant' && !e.isSidechain && e.message?.content?.findLast?.(c => c.type === 'text')?.text?.trim();
      if (text) return text.replace(/\*\*|`/g, '').replace(/\s+/g, ' ');
    } catch {}
  }
  return null;
}

function bar(pct, width) {
  const n = Math.max(4, Math.min(20, width - 10));
  const full = Math.round((pct / 100) * n);
  return `${'█'.repeat(full)}${'░'.repeat(n - full)} ${pct}%`;
}

// Every line of the dash; owner[line] is the index of the item that line belongs to.
export async function render(db, ui, width = 40, alive = true) {
  const m = await model(db, alive);
  const t = now();
  const lines = [];
  const owner = [];
  const links = [];
  const items = [];
  const opened = [];
  const texts = [];
  const c = ui.color;
  const panes = m.all.filter(s => s.herdr_status);
  const state = Object.fromEntries(panes.map(s => [s.session_id, s.herdr_status]));
  const cut = (s, w = width) => (s.length > w ? `${s.slice(0, w - 1)}…` : s);
  const push = (text, tone, at = -1, url, icon) => {
    links[lines.length] = url;
    lines.push(icon ? `${paint(text.slice(0, 2), tone, c)}${paint(icon[0], icon[1], c)} ${paint(cut(text.slice(2), width - 4), tone, c)}` : paint(cut(text), tone, c));
    owner.push(at);
  };
  const item = (s, rows, { key, fold } = {}) => {
    if (!s.section) ui.sink?.item(s, rows, key, fold);
    const at = items.length;
    items.push(key ? { ...s, key } : s);
    const open = fold === undefined || at === ui.cursor || ui.pinned?.has(key);
    opened[at] = open;
    if (!s.section) texts[at] = [fold, ...rows.map(r => r[0])].join(' ').toLowerCase();
    const mark = at === ui.cursor ? '▸ ' : '  ';
    const icon = ICONS[state[s.session_id]];
    if (!open) return push(`${mark}${fold}`, rows[0][1], at, undefined, icon);
    rows.forEach(([text, tone, url], i) => push(`${i ? '  ' : mark}${text}`, at === ui.cursor && !i ? 'bold' : tone, at, url, i ? undefined : icon));
    if (fold !== undefined) push('');
  };
  const title = s => s.workspace ?? s.name ?? s.session_id.slice(0, 8);
  const lead = j => (j.lead ? (j.lead.closed_at ? 'lead missing' : `lead ${j.lead.status}`) : `lead starting on the ${j.machine}`);
  const where = s => (s.machine && s.machine !== MACHINE ? ` · ${s.machine}` : '');
  const attention = m.plate.length + m.proposals.length + m.attention.length;
  const busy = m.busy.filter(s => !state[s.session_id]);
  push(`${m.head} · attention ${attention} · running ${m.active.length + busy.length}`, 'dim');
  push('');
  if (ui.view === 'sessions') {
    push(`ALL SESSIONS ${m.all.length}`, 'bold');
    for (const s of m.all) item(s, [[s.name ?? s.session_id.slice(0, 8)], [`${s.status} · ${age(t - s.status_at)} · ${title(s)}${where(s)}`, s.status === 'waiting' ? 'yellow' : 'dim']]);
    return { lines, owner, links, items, opened, texts };
  }
  if (ui.only) {
    const hits = panes.filter(s => ui.only.includes(s.herdr_status)).sort((a, b) => PRIORITY.indexOf(a.herdr_status) - PRIORITY.indexOf(b.herdr_status));
    push(`FILTER ${ui.only.map(s => ICONS[s][0]).join(' ')} ${hits.length}`, 'bold');
    for (const s of hits) {
      const j = await db.prepare('select * from jobs where lead_session = ? order by created_at desc nulls last').get(s.session_id);
      const label = j?.slug ?? ([s.tab, s.title].filter(Boolean).join(' · ') || s.session_id.slice(0, 8));
      item({ ...s, ...j, session_id: s.session_id }, [[label], [`${s.herdr_status} · ${j ? `${j.type} job, ${j.status}` : 'no job'}${where(s)}`, 'dim']]);
    }
    return { lines, owner, links, items, opened, texts };
  }
  push(`NEEDS ATTENTION ${attention}`, 'bold');
  ui.sink?.section('needs attention');
  for (const p of m.proposals) item({ proposal: p }, [[`proposal ${p.id}`], [`${p.rung ?? 'proposal'} · ${age(t - p.created_at)} · p chat, a a accept, x x decline`, 'magenta'], [p.title, 'dim']], { key: `proposal:${p.id}`, fold: `proposal ${p.id} · ${p.title}` });
  for (const p of m.plate) {
    const pr = /\/pull\/\d+$/.test(p.subject ?? '') ? await db.prepare('select p.title, j.slug, j.lead_session from prs p left join jobs j on j.id = p.job_id where p.url = ?').get(p.subject) : null;
    const job = pr ?? await db.prepare('select slug, lead_session from jobs where slug = ?').get(p.subject ?? '');
    const ref = pr ? p.subject.replace(/^.*github\.com\/[^/]+\//, '').replace('/pull/', '#') : null;
    const body = ref ? (p.text ?? '').replaceAll(p.subject, ref) : p.text ?? '';
    item({ plate: p, session_id: job?.lead_session }, [
      [ref ? `${ref} ${pr.title ?? ''}`.trim() : p.subject ?? p.kind],
      [`${p.kind} · ${age(t - p.created_at)} · ${job?.slug ?? 'no job'}`, 'red'],
      ...wrap(body, width - 4).map(l => [l, 'dim']),
    ], { key: `plate:${p.id}`, fold: `${ref ?? p.subject ?? p.kind} · ${p.kind} · ${age(t - p.created_at)}` });
  }
  for (const j of m.attention) item({ ...j, session_id: j.lead_session }, [[j.slug], [`${why(j)} · ${age(t - (j.progress.gate?.opened_at ?? j.lead.status_at))}`, 'yellow'], [`${j.type} · now ${j.progress.step}${where(j)}`, 'dim']], { key: `job:${j.slug}`, fold: `${j.slug} · ${why(j)}` });
  push('');
  push(`RUNNING ${m.active.length + busy.length}`, 'bold');
  ui.sink?.section('running');
  const agents = ui.sink ? {} : leadAgents(m.active.map(j => j.lead).filter(l => l && !l.closed_at));
  const said = j => wrap((j.lead && lastSaid(j.lead_session)) ?? '', width - 4, 1).map(l => [l, 'purple']);
  const job = (j, folded = true) => item({ ...j, session_id: j.lead_session }, [[j.slug], [`${j.type} · ${j.progress.wait ?? j.progress.step} · ${lead(j)}${where(j)}`, 'dim'], ...said(j), ...(agents[j.lead_session] ?? []).map(a => [a, 'blue']), ...(folded ? [] : [[bar(j.progress.pct, width), 'cyan']])], folded ? { key: `job:${j.slug}`, fold: j.slug } : {});
  m.active.forEach((j, i) => { if (i) push(''); job(j, false); });
  for (const s of busy) {
    if (m.active.length || s !== busy[0]) push('');
    const h = headlessRun(s);
    item(s, h ? [[h.agent], [`${h.what} · ${age(t - s.status_at)}`, 'dim']] : [[title(s)], [`busy · ${age(t - s.status_at)} · ${s.name ?? ''}${where(s)}`, 'dim']]);
  }
  const section = (name, rows, each) => {
    if (!rows.length) return;
    ui.sink?.section(name);
    const shut = ui.collapsed?.has(name) && !ui.query;
    push('');
    item({ section: name }, [[`${shut ? '[+]' : '[-]'} ${name.toUpperCase()} ${rows.length}`, 'bold']]);
    if (!shut) rows.forEach(each);
  };
  const jobOf = p => ({ ...m.jobs.find(j => j.slug === p.slug), pr: p.url, session_id: p.lead_session });
  section('in review', m.inReview, p => {
    const [glyph, tone] = p.draft ? ['◌', 'dim']
      : p.ci === 'failed' || p.review === 'CHANGES_REQUESTED' ? ['✗', 'red']
        : p.ci !== 'passed' ? ['…', 'yellow']
          : p.review === 'APPROVED' ? ['✓', 'green'] : ['●', 'blue'];
    const head = `${glyph} ${p.repo.split('/')[1]}#${p.number} ${p.slug}`;
    item(jobOf(p), [
      [head, tone],
      [`${p.draft ? 'draft' : 'ready'} · CI ${p.ci ?? '?'} · ${p.review ?? 'no review'}${p.created_at ? ` · ${age(t - p.created_at)}` : ''}`, tone, p.url],
    ], { key: `pr:${p.url}`, fold: head });
  });
  section('mergeable', m.mergeable, p => item({ pr: p.url, session_id: p.lead_session }, [[`${p.repo.split('/')[1]}#${p.number} ${p.title ?? ''}`.trim()], [p.slug ?? 'no job', 'dim']], { key: `pr:${p.url}`, fold: `${p.repo.split('/')[1]}#${p.number} · ${p.slug ?? 'no job'}` }));
  const soaks = m.soaking.map(s => ({ ...s, last: (s.next ?? s.watch.at(-1)).label === 'production +24h' }))
    .sort((a, b) => a.last - b.last || (b.pr.merged_at ?? 0) - (a.pr.merged_at ?? 0));
  section('soaking', soaks, ({ pr, watch, next, due }) => {
    const done = watch.filter(r => r.status === 'done').length;
    const failed = watch.findLast(r => r.status !== 'planned')?.status === 'failed';
    const glyph = failed ? '✗' : '○◔◑◕●'[Math.round((4 * done) / watch.length)];
    const tone = failed ? 'red' : !next ? 'green' : next.label.startsWith('production') ? 'green' : pr.latest_at ? 'yellow' : 'dim';
    const head = `${glyph} ${(next ?? watch.at(-1)).label} ${pr.repo.split('/')[1]}#${pr.number} ${pr.slug}`;
    item(jobOf(pr), [[head, tone], [`soak ${done}/${watch.length}${due ? ` · next in ${age(due - t)}` : ''}`, 'dim', pr.url]], { key: `pr:${pr.url}`, fold: head });
  });
  section('projects', m.projects, j => job(j));
  const finished = (await db.prepare("select * from jobs where status = 'done' and lead_session is not null order by done_at desc nulls last").all()).filter(j => state[j.lead_session]);
  section('done', finished, j => item({ ...j, session_id: j.lead_session }, [[j.slug], [`${j.type} · done ${age(t - j.done_at)} · D D closes the workspace`, 'dim']], { key: `job:${j.slug}`, fold: j.slug }));
  section('parked', m.parked, w => push(`  ${w.slug}`, 'dim'));
  const glados = m.all.filter(s => s.name === 'glados').sort((a, b) => b.status_at - a.status_at)[0];
  const leads = new Set((await db.prepare('select lead_session from jobs where lead_session is not null').all()).map(r => r.lead_session));
  const named = panes.filter(s => !leads.has(s.session_id) && s.session_id !== glados?.session_id)
    .sort((a, b) => (a.machine === MACHINE ? 0 : 1) - (b.machine === MACHINE ? 0 : 1) || PRIORITY.indexOf(a.herdr_status) - PRIORITY.indexOf(b.herdr_status))
    .map(s => ({ ...s, name: [s.tab, s.title || s.name].filter(Boolean).join(' · ') || s.name, herdr: s.herdr_status }));
  section('uncategorized', [{ glados: true, ...glados, name: 'GLaDOS' }, ...named], s => item(s, [
    [s.name ?? s.session_id.slice(0, 8), s.glados ? 'magenta' : undefined],
    [s.status ? `${s.herdr ?? s.status} · ${age(t - s.status_at)}${where(s)}` : s.glados ? 'not running, ⏎ starts her on the server' : s.herdr, 'dim'],
  ], { key: `session:${s.session_id ?? 'glados'}`, fold: s.name ?? s.session_id.slice(0, 8) }));
  return { lines, owner, links, items, opened, texts };
}

export async function feed(db, alive = true, width = 44) {
  const sections = [];
  const sink = { section: name => sections.push({ name, rows: [] }), item: (s, rows, key) => sections.at(-1).rows.push({ s, rows, key }) };
  const [{ lines }, panes] = await Promise.all([
    render(db, { cursor: -1, sink }, width, alive),
    db.prepare('select session_id, machine, pane_id from sessions where closed_at is null and pane_id is not null').all(),
  ]);
  const pane = Object.fromEntries(panes.map(p => [p.session_id, { machine: p.machine, pane: p.pane_id }]));
  const act = (label, post, confirm = false) => ({ label, post, confirm });
  const actions = (s, section) => {
    const p = s.plate;
    const close = slug => act('Close workspace', `/workspace/${slug}/done`, true);
    if (s.proposal) return [act('Accept', `/proposal/${s.proposal.id}/accept`, true), act('Decline', `/proposal/${s.proposal.id}/decline`, true)];
    if (p?.kind === 'unregistered') return [act('Create job', `/plate/${p.id}/adopt`, true), act('Ignore', `/plate/${p.id}/ignore`)];
    if (p) return [
      act('Clear', `/plate/${p.id}/clear`),
      ...(p.kind === 'soak-signal' ? [act('Rerun soak check', `/plate/${p.id}/rerun`)] : []),
      ...(p.kind === 'ready-to-close' ? [close(p.subject)] : []),
      ...(p.kind === 'schedule-failed' ? [act('Run now', `/schedule/${p.subject}/run`)] : []),
    ];
    return section === 'done' && s.slug ? [close(s.slug)] : [];
  };
  return {
    head: lines[0],
    foot: usageMeters(usage()).map(m => [{ text: m.bar, tone: m.tone }, { text: m.text, tone: null }, { text: m.reset, tone: 'dim' }]),
    sections: sections.filter(x => x.name !== 'uncategorized' && x.rows.length).map(({ name, rows }) => ({
      name,
      folded: name !== 'running',
      rows: rows.map(({ s, rows: r, key }) => ({
        key: key ?? (s.slug ? `job:${s.slug}` : s.session_id ? `session:${s.session_id}` : null),
        lines: r.map(([text, tone]) => ({ text, tone: tone ?? null })),
        url: s.pr ?? r.find(x => x[2])?.[2] ?? (/^https:\/\//.test(s.plate?.subject ?? '') ? s.plate.subject : null),
        target: pane[s.session_id] ?? null,
        badge: MACHINE_BADGES[pane[s.session_id]?.machine ?? s.machine] ?? null,
        actions: actions(s, name),
      })),
    })),
  };
}

// Raises the herdr pane of a session on either machine.
export async function focusSession(db, sessionId) {
  const s = await db.prepare('select machine from sessions where session_id = ?').get(sessionId);
  const pane = json(HERDR, herdrOn(s?.machine, ['pane', 'list']))?.result?.panes?.find(p => p.agent_session?.value === sessionId);
  if (!pane) return false;
  spawnSync(HERDR, herdrOn(s?.machine, ['workspace', 'focus', pane.workspace_id]), { timeout: 5000 });
  return spawnSync(HERDR, herdrOn(s?.machine, ['tab', 'focus', pane.tab_id]), { timeout: 5000 }).status === 0;
}

// Jumps to GLaDOS's pane, or starts her in a new herdr tab on the server when none is open.
export async function openGlados(db) {
  const s = await db.prepare("select session_id from sessions where closed_at is null and name = 'glados' order by status_at desc nulls last").get();
  if (s && await focusSession(db, s.session_id)) return 'GLaDOS';
  const pane = json(HERDR, herdrOn('server', ['tab', 'create', '--cwd', WORK, '--label', 'glados', '--focus']))?.result?.root_pane?.pane_id;
  if (!pane) return 'herdr could not open a tab for GLaDOS on the server';
  spawnSync(HERDR, herdrOn('server', ['pane', 'run', pane, 'factory glados']), { timeout: 5000 });
  return 'starting GLaDOS on the server';
}

export async function chatProposal(db, p) {
  const s = await db.prepare("select session_id, name from sessions where closed_at is null and name = 'glados' order by status_at desc nulls last").get();
  if (!s) return 'GLaDOS is not running, press g to start her';
  const { queueTo } = await import('./pollers/messages.mjs');
  await queueTo({ emit: (...a) => emit(db, ...a) }, s.session_id, `proposal ${p.id} "${p.title}" is waiting on Stef's decision. Run factory proposal show ${p.id}, walk him through it, and accept or decline only on his word.`);
  await focusSession(db, s.session_id);
  return `proposal ${p.id} queued for GLaDOS`;
}

// ponytail: Claude Code's own /usage endpoint with its keychain login; the token only refreshes while a Claude
// session runs, so after hours idle the meters go stale. Upgrade: refresh with the stored refreshToken.
async function fetchUsage() {
  const creds = spawnSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8', timeout: 5000 });
  const file = `${os.homedir()}/.claude/.credentials.json`;
  const raw = creds.status === 0 ? creds.stdout : fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const token = raw && JSON.parse(raw).claudeAiOauth?.accessToken;
  if (!token) return null;
  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
    signal: AbortSignal.timeout(15000),
  });
  return res.ok ? res.json() : null;
}

const usageCache = { at: 0, data: null, busy: false };

// The last known 5h/7d usage; asks for a fresh one at most once a minute without waiting for it.
export function usage() {
  if (process.env.FACTORY_USAGE === 'off') return null;
  if (!usageCache.busy && Date.now() - usageCache.at > 60000) {
    usageCache.busy = true;
    fetchUsage().then(u => { if (u) usageCache.data = { ...u, at: Date.now() }; }, () => {})
      .finally(() => { usageCache.at = Date.now(); usageCache.busy = false; });
  }
  return usageCache.data;
}

function span(ms) {
  const m = Math.floor(ms / 60000);
  return m >= 1440 ? `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h${m % 60}m` : `${m}m`;
}

export function usageMeters(u) {
  if (!u) return [];
  return [['5h', u.five_hour], ['7d', u.seven_day]].filter(([, w]) => w?.resets_at).map(([label, w]) => {
    const left = Date.parse(w.resets_at) - Date.now();
    const pct = left > 0 ? Math.round(w.utilization) : 0;
    const filled = Math.max(0, Math.min(8, Math.round(pct / 12.5)));
    return { bar: '█'.repeat(filled) + '░'.repeat(8 - filled), tone: pct >= 95 ? 'red' : pct >= 80 ? 'yellow' : 'magenta', text: ` ${pct}% ${label}`, reset: left > 0 ? ` resets in ${span(left)}` : '' };
  });
}

export function usageLines(u, color = true) {
  return usageMeters(u).map(m => `${paint(m.bar, m.tone, color)}${m.text}${paint(m.reset, 'dim', color)}`);
}

const KEYS = [
  ['j k ↑ ↓', 'move the highlight'],
  ['wheel', 'scroll'],
  ['click', 'highlight and expand; click an expanded label to jump like ⏎, a PR line to open it'],
  ['⏎', 'jump to its herdr pane, or open its PR'],
  ['in review', '◌ draft  ✗ CI failed or changes  … CI running  ● awaiting review  ✓ approved'],
  ['soaking', '○◔◑◕● checkpoints passed  ✗ failed; grey before latest, yellow on latest, green on production'],
  ['sessions', 'as herdr: × blocked  ◐ working  ✓ done, unseen  ○ done, seen'],
  ['g', 'GLaDOS (also first in UNCATEGORIZED)'],
  ['d', 'keep the item expanded'],
  ['⏎ on [-]', 'collapse or expand SOAKING, PROJECTS, PARKED'],
  ['s', 'all sessions'],
  ['/', 'search; ⏎ keeps the match, n N next / previous, esc clears'],
  ['f', 'only Claude panes that are × ✓, then ×, then ✓, then all again'],
  ['esc', 'back home'],
  ['c c', 'clear a plate item'],
  ['r r', 'run a failed schedule again'],
  ['a a  x x', 'accept / decline a proposal'],
  ['p', 'send a proposal to GLaDOS to talk it through'],  ['D D', 'close the workspace'],
  ['?', 'this box'],
  ['q', 'quit'],
];

export function keysBox(width) {
  const kw = Math.max(...KEYS.map(([k]) => k.length));
  const w = Math.min(width, Math.max(...KEYS.map(([, d]) => kw + 1 + d.length)) + 4);
  const indent = ' '.repeat(Math.max(0, Math.floor((width - w) / 2)));
  const clip = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
  const edge = (l, label, r) => `${indent}${l}${`${label}${'─'.repeat(w)}`.slice(0, w - 2)}${r}`;
  return [
    edge('┌', '─ keys ', '┐'),
    ...KEYS.map(([k, d]) => `${indent}│ ${paint(k.padEnd(kw), 'cyan', true)} ${clip(d, w - kw - 5).padEnd(w - kw - 5)} │`),
    edge('└', '─ any key closes ', '┘'),
  ];
}

export function interactive(db, alive) {
  const out = process.stdout;
  const ui = { cursor: 0, top: 0, view: 'home', color: true, pinned: new Set(), collapsed: new Set(['parked', 'soaking']) };
  let frame = { lines: [], owner: [], items: [] };
  let room = 0;
  let drawing = null;
  let again = false;
  const matches = () => (ui.query ? frame.items.map((_, i) => i).filter(i => frame.texts[i]?.includes(ui.query)) : []);
  const seek = (from, back = false) => {
    const hits = matches();
    if (hits.length) ui.cursor = back ? (hits.findLast(i => i <= from) ?? hits.at(-1)) : (hits.find(i => i >= from) ?? hits[0]);
  };
  const show = () => {
    if (ui.cursor < 0) return;
    const first = frame.owner.indexOf(ui.cursor);
    const last = frame.owner.lastIndexOf(ui.cursor);
    if (first < 0) return;
    if (first < ui.top) ui.top = first;
    else if (last >= ui.top + room) ui.top = last - room + 1;
  };
  const paintFrame = (follow = false) => {
    const width = out.columns || 40;
    const height = out.rows || 40;
    const hits = matches();
    const found = ui.query ? ` · ${hits.indexOf(ui.cursor) + 1 || '-'}/${hits.length}` : '';
    const status = ui.search !== undefined ? [`/${ui.search}▏${found}`, 'cyan'] : ui.flash ? [ui.flash, 'yellow'] : [ui.query ? `/${ui.query}${found} · n N next, esc clears` : '? keys', 'dim'];
    const foot = ['', ...usageLines(usage()), paint(status[0], status[1], true)];
    room = Math.max(1, height - foot.length);
    if (follow) show();
    ui.top = Math.max(0, Math.min(ui.top, frame.lines.length - room));
    const body = frame.lines.slice(ui.top, ui.top + room);
    const screen = [...body, ...Array(room - body.length).fill(''), ...foot];
    if (ui.help) {
      const box = keysBox(width);
      screen.splice(Math.max(0, Math.floor((screen.length - box.length) / 2)), box.length, ...box);
    }
    out.write(`${CSI}H${screen.map(l => `${l}${CSI}K`).join('\n')}${CSI}J`);
  };
  // One render at a time; a draw asked for while one runs repaints once more when it ends.
  const draw = (follow = false) => {
    if (drawing) { again = true; return drawing; }
    drawing = (async () => {
      try {
        const width = out.columns || 40;
        frame = await render(db, ui, width, alive());
        ui.cursor = Math.min(ui.cursor, Math.max(0, frame.items.length - 1));
        frame = await render(db, ui, width, alive());
        paintFrame(follow);
      } catch (e) {
        ui.flash = `factory DB unreachable: ${e.message}`;
        paintFrame();
      }
    })().finally(() => {
      drawing = null;
      if (again) { again = false; draw(); }
    });
    return drawing;
  };
  const jump = async s => {
    if (s?.glados) return (ui.flash = await openGlados(db));
    if (s?.section) return ui.collapsed.delete(s.section) || ui.collapsed.add(s.section);
    if (s?.session_id && await focusSession(db, s.session_id)) return;
    const url = s?.plate?.subject ?? s?.pr;
    if (/^https:\/\//.test(url ?? '')) {
      spawnSync('open', [url]);
      ui.flash = `opened ${url}`;
    } else if (s?.session_id) ui.flash = `no herdr pane for ${s.name ?? s.slug ?? s.session_id}`;
  };
  const quit = () => { out.write(`${MOUSE_OFF}${CSI}?25h${CSI}?1049l`); process.exit(0); };
  out.write(`${CSI}?1049h${CSI}?25l${MOUSE_ON}`);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', async buf => {
    const k = buf.toString();
    if (ui.help) {
      ui.help = false;
      return draw();
    }
    const mice = [...k.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)];
    if (mice.length) {
      for (const [, button, , y, press] of mice) {
        if (button === '64') ui.top -= 3;
        if (button === '65') ui.top += 3;
        const line = ui.top + Number(y) - 1;
        const at = button === '0' && press === 'M' && Number(y) <= room ? frame.owner[line] : -1;
        if (at >= 0) {
          ui.cursor = at;
          ui.flash = undefined;
          const url = frame.links[line];
          if (url) {
            spawnSync('open', [url]);
            ui.flash = `opened ${url}`;
          } else if (frame.items[at].section || (frame.opened[at] && frame.owner.indexOf(at) === line)) await jump(frame.items[at]);
        }
      }
      return draw();
    }
    const armed = ui.armed;
    ui.flash = undefined;
    ui.armed = undefined;
    if (k === '\x03') return quit();
    if (ui.search !== undefined) {
      if (k === '\x1b') { ui.cursor = ui.from; ui.search = ui.query = undefined; }
      else if (k === '\r') ui.search = undefined;
      else {
        if (k === '\x7f' || k === '\b') ui.search = ui.search.slice(0, -1);
        else if (!/[\x00-\x1f]/.test(k)) ui.search += k;
        ui.query = ui.search.toLowerCase() || undefined;
        await draw();
        seek(ui.from);
      }
      return draw(true);
    }
    if (k === 'q') return quit();
    const it = frame.items[ui.cursor];
    const twice = async (key, target, what, act) => {
      if (!target) return;
      if (armed === `${key}${target.id}`) {
        try { await act(); } catch (e) { ui.flash = e.message; }
      } else {
        ui.armed = `${key}${target.id}`;
        ui.flash = `${key} again to ${what}`;
      }
    };
    if (k === 'D') {
      const slug = it?.slug ?? (it?.plate?.kind === 'ready-to-close' ? it.plate.subject : null);
      await twice('D', slug && { id: slug }, `close ${slug}`, () => {
        const r = spawnSync(process.execPath, ['--no-warnings', new URL('./factory.mjs', import.meta.url).pathname, 'done', slug], { encoding: 'utf8' });
        ui.flash = `${r.stdout}${r.stderr}`.trim().split('\n')[0];
      });
      return draw();
    }
    if (k === 'r') {
      await twice('r', it?.plate?.kind === 'schedule-failed' && it.plate, 'run it again', async () => { ui.flash = await scheduleRun(db, it.plate.subject); });
      return draw();
    }
    if (k === 'c' || k === 'a' || k === 'x') {
      if (k === 'c') await twice('c', it?.plate, 'clear it', () => emit(db, 'plate.cleared', it.plate.subject, { id: it.plate.id, kind: it.plate.kind }, [['update plate set cleared_at = ? where id = ?', now(), it.plate.id]]));
      else await twice(k, it?.proposal, k === 'a' ? 'accept it' : 'decline it', async () => { ui.flash = await proposalDecide(db, it.proposal.id, k === 'a' ? 'accept' : 'decline'); });
      return draw();
    }
    if (k === 'j' || k === `${CSI}B`) ui.cursor = Math.min(ui.cursor + 1, frame.items.length - 1);
    else if (k === 'k' || k === `${CSI}A`) ui.cursor = Math.max(ui.cursor - 1, 0);
    else if (k === 's') { ui.view = ui.view === 'sessions' ? 'home' : 'sessions'; ui.cursor = 0; ui.top = 0; }
    else if (k === '\x1b' && ui.query) ui.query = undefined;
    else if (k === '\x1b') { ui.view = 'home'; ui.only = undefined; ui.cursor = 0; ui.top = 0; }
    else if (k === '/') { ui.search = ''; ui.from = ui.cursor; ui.query = undefined; }
    else if (k === 'f') {
      const cycle = [['blocked', 'done'], ['blocked'], ['done'], undefined];
      ui.only = cycle[(cycle.findIndex(c => c?.join() === ui.only?.join()) + 1) % cycle.length];
      ui.view = 'home'; ui.cursor = 0; ui.top = 0;
    }
    else if (k === 'n') seek(ui.cursor + 1);
    else if (k === 'N') seek(ui.cursor - 1, true);
    else if (k === '\r') await jump(it);
    else if (k === 'd' && it?.key) { if (!ui.pinned.delete(it.key)) ui.pinned.add(it.key); }
    else if (k === '?') ui.help = true;
    else if (k === 'g') ui.flash = await openGlados(db);
    else if (k === 'p' && it?.proposal) ui.flash = await chatProposal(db, it.proposal);
    draw(true);
  });
  out.on('resize', () => draw(true));
  listen(() => draw(), db.url);
  setInterval(draw, 30000);
  draw(true);
}

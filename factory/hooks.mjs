import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DIR, HOME, WORKSPACES, emit, now, open } from './db.mjs';
import { workspaceOf } from './pollers/sessions.mjs';

const MAX_REJECTS = 2;
const STUCK_AFTER = 3;
const VERDICTS = ['done-verified', 'done-unverified', 'failed', 'blocked', 'stuck'];
const KINDS = ['test', 'ui', 'agent', 'api', 'data'];
const OWNED_KINDS = { coder: ['test'], tester: ['ui', 'agent', 'api', 'data'] };
const LEAD_AGENTS = { 'lead-orchestrator': 'orchestrator', 'lead-writer': 'writer', 'lead-loop': 'loop' };
const WRITES = ['Write', 'Edit', 'NotebookEdit'];
const TRACK = () => path.join(HOME, 'agents');

export function stageOf(input) {
  return input.agent_type?.startsWith('factory-') ? input.agent_type.slice('factory-'.length) : null;
}

export function orders(input) {
  if (!stageOf(input)) return null;
  const text = fs.readFileSync(path.join(DIR, 'standing-orders.md'), 'utf8');
  return { hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: text } };
}

export async function prompted(input) {
  if (input.agent_id || /^\s*From factory/.test(input.prompt ?? '')) return [];
  const db = await open();
  const job = await db.prepare('select * from jobs where lead_session = ? or slug = ? order by lead_session = ? desc nulls last').get(input.session_id ?? '', workspaceOf(input.cwd ?? '') ?? '', input.session_id ?? '');
  if (!job) return [];
  const items = await db.prepare('select * from plate where cleared_at is null and (subject = ? or subject in (select url from prs where job_id = ?))').all(job.slug, job.id);
  for (const p of items) await emit(db, 'plate.cleared', p.subject, { id: p.id, kind: p.kind, by: 'prompt', session: input.session_id }, [['update plate set cleared_at = ? where id = ?', now(), p.id]]);
  return items.map(p => p.id);
}

export async function leadOf(input) {
  if (input.agent_id) return null;
  const agentMode = LEAD_AGENTS[input.agent_type];
  const db = await open();
  const job = await db.prepare("select * from jobs where lead_session = ? and status not in ('done', 'closed')").get(input.session_id ?? '')
    ?? (agentMode ? await db.prepare('select * from jobs where slug = ?').get(workspaceOf(input.cwd) ?? '') : undefined);
  if (!job && !agentMode) return null;
  const slug = job?.slug ?? workspaceOf(input.cwd);
  return { mode: job?.lead_mode ?? agentMode, root: slug ? path.join(WORKSPACES, slug) : input.cwd };
}

const FILE_RULE = 'stage reports, criteria and evidence go to the factory DB: `factory file put <name> < content`, never into a .factory/ folder.';
const intoRunDir = input => WRITES.includes(input.tool_name) && /(^|\/)\.factory\//.test(input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? '');

// Returns the reason a tool call is blocked, or null. With the factory DB out of reach every session is checked as a
// lead with no approved gate: edits, reads and tests go on, merging, pushing, committing, PR edits and posting do not.
export async function guard(input) {
  if (intoRunDir(input)) return FILE_RULE;
  const command = input.tool_input?.command;
  let lead;
  try {
    lead = await leadOf(input);
  } catch {
    return input.tool_name === 'Bash' && command ? blockedReason('loop', command, { unshipped: true }) : null;
  }
  if (lead) {
    if (WRITES.includes(input.tool_name)) {
      if (lead.mode === 'orchestrator') return 'an orchestrator lead never writes files; dispatch the change to a stage or worker with a brief.';
      const file = path.resolve(lead.root, input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? '');
      if (!inside(file, lead.root) && !inTmp(file)) return `a ${lead.mode} lead writes only inside its own workspace ${lead.root}, not ${file}.`;
      return null;
    }
    if (input.tool_name !== 'Bash' || !command) return null;
    if (lead.mode === 'loop') return blockedReason('loop', command, await grants(lead.root));
    return blockedReason('lead', command) ?? (lead.mode === 'orchestrator' ? readOnlyCommandProblem(command) : null);
  }
  const stage = stageOf(input);
  if (!(stage || input.agent_id) || input.tool_name !== 'Bash' || !command) return null;
  const g = await grants(input.cwd);
  const reason = blockedReason(stage, command, stage === 'shipper' ? g : { review: g.review });
  if (reason) return reason;
  if (stage && failures(input.agent_id)[command] >= STUCK_AFTER) {
    return `STUCK: this exact command has failed ${STUCK_AFTER} times with no file edit in between. Do not run it again. Update your report with what you tried and the last error, then send your final reply with VERDICT: stuck.`;
  }
  return null;
}

// The merge and replies gates Stef approved for the job whose workspace the shipper works in.
function grants(cwd) {
  return approved(cwd).catch(() => ({ unshipped: true }));
}

async function approved(cwd) {
  const slug = workspaceOf(cwd);
  if (!slug) return {};
  const db = await open();
  const job = await db.prepare('select * from jobs where slug = ?').get(slug);
  const gate = name => job && db.prepare("select * from gates where job_id = ? and name = ? and status = 'approved' order by id desc").get(job.id, name);
  const review = await gate('review');
  if (review && !review.pr) review.pr = job.brief?.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/)?.[0];
  const unshipped = !!job && !!await db.prepare("select 1 from ledger where job_id = ? and element = 'gate' and label = 'gate2' and status not in ('done', 'skipped', 'dropped')").get(job.id);
  return { job, merge: await gate('merge'), replies: await gate('replies'), ready: await gate('ready'), review, unshipped };
}

function targets(words, prUrl) {
  const pr = String(prUrl).match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
  if (!pr) return false;
  const repo = words[words.indexOf('--repo') + 1];
  const named = words.some(w => w === prUrl || w === pr[2] || w.endsWith(`${pr[1]}/pulls/${pr[2]}/comments`) || w.includes(`${pr[1]}/pulls/${pr[2]}/`) || w.includes(`${pr[1]}/issues/${pr[2]}/comments`));
  return named && (!words.includes('--repo') || repo === pr[1]);
}

function mergeProblem(words, g) {
  if (!g.merge?.pr) return 'merging needs an approved merge gate for this job\'s PR (factory gate open merge --pr <url>, then Stef\'s go).';
  if (!targets(words, g.merge.pr)) return `the approved merge gate is for ${g.merge.pr} only.`;
  if (!words.includes('--squash')) return 'merge with --squash.';
  const sha = words[words.indexOf('--match-head-commit') + 1];
  if (!words.includes('--match-head-commit') || !/^[0-9a-f]{7,40}$/.test(sha ?? '')) return 'merge with --match-head-commit <head sha>.';
  if (g.job?.task_id && words[words.indexOf('--body') + 1] !== `Task: ${g.job.task_id}`) return `merge with --body "Task: ${g.job.task_id}".`;
  return null;
}

const inside = (file, root) => file === root || file.startsWith(root + path.sep);
const inTmp = file => [os.tmpdir(), '/private/tmp/', '/tmp/'].some(t => file.startsWith(t));

function failures(agent) {
  try { return JSON.parse(fs.readFileSync(path.join(TRACK(), `${agent}.json`), 'utf8')); } catch { return {}; }
}

// PostToolUse(+Failure): counts failed Bash commands per subagent; any file edit resets the count.
export function track(input) {
  if (!input.agent_id || !stageOf(input)) return;
  const file = path.join(TRACK(), `${input.agent_id}.json`);
  if (WRITES.includes(input.tool_name)) return fs.rmSync(file, { force: true });
  if (input.tool_name !== 'Bash' || input.hook_event_name !== 'PostToolUseFailure') return;
  const f = failures(input.agent_id);
  const cmd = input.tool_input?.command ?? '';
  f[cmd] = (f[cmd] ?? 0) + 1;
  fs.mkdirSync(TRACK(), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(f));
}

// Splits a shell command into its simple commands, honouring quotes and dropping heredoc bodies.
export function segments(command) {
  const text = command.replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n([\s\S]*?)\n\s*\2[ \t]*(?=\n|$)/g,
    (m, q, tag, rest, body) => `<<HEREDOC ${!q && /\$\(|`/.test(body) ? '$(' : ''}${rest}`);
  const out = [];
  let words = [];
  let word = '';
  let quote = null;
  let seg = { subst: false, redirect: false, inner: [] };
  const endWord = () => { if (word) words.push(word); word = ''; };
  const endSeg = () => { endWord(); if (words.length) out.push({ ...seg, words }); words = []; seg = { subst: false, redirect: false, inner: [] }; };
  const subst = i => {
    const end = text[i] === '`' ? text.indexOf('`', i + 1) : closeParen(text, i + 1);
    if (end < 0) { seg.subst = true; word += text[i]; return i; }
    seg.inner.push(text.slice(i + (text[i] === '`' ? 1 : 2), end));
    word += '$()';
    return end;
  };
  const redirect = i => {
    if (/^\d$/.test(word)) word = '';
    endWord();
    let j = i + 1;
    if (text[j] === '>') j++;
    if (text[j] === '&' && /\d/.test(text[j + 1] ?? '')) return j + 1;
    while (/[ \t]/.test(text[j] ?? '')) j++;
    let target = '';
    while (j < text.length && !/[\s;|&]/.test(text[j])) target += text[j++];
    if (target !== '/dev/null') seg.redirect = true;
    return j - 1;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && ch === '\\' && '$`"\\'.includes(text[i + 1] ?? '')) word += text[++i];
      else if (quote === '"' && (ch === '`' || (ch === '$' && text[i + 1] === '('))) i = subst(i);
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '`' || (ch === '$' && text[i + 1] === '(')) { i = subst(i); continue; }
    if (ch === '\\' && text[i + 1] === '\n') { i++; continue; }
    if (ch === '&' && text[i + 1] === '>') { i = redirect(i + 1); continue; }
    if (ch === '>') { i = redirect(i); continue; }
    if (';\n|&'.includes(ch)) {
      endSeg();
      if ((ch === '|' || ch === '&') && text[i + 1] === ch) i++;
      continue;
    }
    if (/\s/.test(ch)) { endWord(); continue; }
    word += ch;
  }
  endSeg();
  return out;
}

// Index of the ")" closing the "(" at start, or -1.
function closeParen(text, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === quote) quote = null; else if (ch === '\\' && quote === '"') i++; continue; }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '\\') i++;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

const KEYWORDS = ['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!'];

export function readOnlyCommandProblem(command) {
  for (const seg of segments(command)) {
    if (seg.subst) return 'no command substitution the hook cannot read: close every $( and `, and quote heredoc tags (<<\'EOF\')';
    for (const inner of seg.inner) {
      const problem = readOnlyCommandProblem(inner);
      if (problem) return problem;
    }
    if (seg.redirect) return 'no output redirection into files';
    let words = seg.words.slice(Math.max(0, seg.words.findIndex(w => !/^\w+=/.test(w))));
    if (words.every(w => /^\w+=/.test(w))) continue;
    while (KEYWORDS.includes(words[0])) words = words.slice(1);
    if (['for', 'done', 'fi'].includes(words[0])) continue;
    const problem = readOnlyProblem(words);
    if (problem) return problem;
  }
  return null;
}

const FACTORY_LEAD = ['step', 'plan', 'gate', 'job', 'pr', 'status', 'type', 'done', 'poll', 'rerun', 'soak', 'message', 'help', '--help'];

function readOnlyProblem([cmd, ...rest]) {
  const PLAIN = ['cd', 'ls', 'lsof', 'cat', 'head', 'tail', 'wc', 'rg', 'grep', 'pwd', 'echo', 'date', 'which', 'tree', 'jq', 'sort', 'uniq', 'cut', 'awk', 'diff', 'stat', 'file', 'basename', 'dirname', 'realpath', 'printf', 'true', ':', '[', 'test', 'tr', 'read', 'ps', 'pgrep', 'uptime', 'tb-sem', 'tb-bug', 'tb-pr', 'tb-backyard'];
  if (!cmd || PLAIN.includes(cmd)) return null;
  if (cmd === 'sed') return rest.includes('-n') && !rest.some(w => w.startsWith('-i')) ? null : 'sed only with -n and never -i';
  if (cmd === 'find') return rest.some(w => ['-delete', '-exec', '-execdir', '-ok'].includes(w)) ? 'find without -delete or -exec' : null;
  if (cmd === 'git') {
    const args = [];
    for (let i = 0; i < rest.length; i++) {
      if (['-C', '-c'].includes(rest[i])) i++;
      else if (rest[i] !== '--no-pager') args.push(rest[i]);
    }
    const [sub, ...opts] = args;
    const READ = ['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'grep', 'blame', 'fetch', 'merge-base', 'describe', 'shortlog', 'reflog', 'cat-file', 'rev-list', 'for-each-ref', 'name-rev', 'ls-remote'];
    if (READ.includes(sub)) return null;
    if (sub === 'branch' && opts.every(o => o.startsWith('-') && !/^-(d|D|m|M|f|c|C|u)$|^--(delete|move|copy|force|set-upstream-to|unset-upstream|edit-description)/.test(o))) return null;
    if (['worktree', 'stash'].includes(sub) && ['list', 'show'].includes(opts[0])) return null;
    if (sub === 'remote' && (!opts.length || ['-v', 'show', 'get-url'].includes(opts[0]))) return null;
    if (sub === 'config' && ['--get', '-l', '--list', '--get-all'].includes(opts[0])) return null;
    return `git ${sub ?? ''} changes the repo`;
  }
  if (cmd === 'gh') {
    const [group, sub] = rest;
    if (group === 'pr' && ['view', 'list', 'checks', 'diff', 'status'].includes(sub)) return null;
    if (['run', 'repo', 'release'].includes(group) && ['view', 'list'].includes(sub)) return null;
    if (group === 'search') return null;
    if (group === 'api') {
      const line = rest.join(' ');
      const write = !/(-X\s*|--method\s+)GET\b/.test(line) && /(-X\s*|--method\s+)(POST|PATCH|PUT|DELETE)\b|(^|\s)(-f|-F|--field|--raw-field|--input)\b/.test(line);
      return write ? 'gh api only for reads' : null;
    }
    return `gh ${group ?? ''} ${sub ?? ''} is not a read`;
  }
  if (cmd === 'factory') return FACTORY_LEAD.includes(rest[0]) || (rest[0] === 'dash' && rest.includes('--once')) || (rest[0] === 'file' && ['cat', 'ls'].includes(rest[1])) ? null : `factory ${rest[0] ?? ''} is not a lead command`;
  if (cmd === 'workspaces') return ['list', 'today', 'inbox'].includes(rest[0]) ? null : `workspaces ${rest[0] ?? ''} changes state`;
  return `${cmd} is not on the read-only list`;
}

function forcePushProblem(segment) {
  const args = segment.match(/\bgit\b.*?\spush\b(.*)/)?.[1].trim().split(/\s+/).filter(Boolean);
  if (!args) return null;
  const flags = args.filter(a => a.startsWith('-'));
  if (!flags.some(f => /^(--force\S*|-f)$/.test(f))) return null;
  const hash = args.indexOf('#');
  const refs = (hash < 0 ? args : args.slice(0, hash)).filter(a => !a.startsWith('-') && !/^\d*[<>]/.test(a));
  if (flags.some(f => /^(--force|-f|--mirror|--all)$/.test(f))) return 'force pushes use --force-with-lease only.';
  if (refs.length !== 2) return 'a force push names the remote and exactly one branch.';
  const branch = refs[1].replace(/^\+/, '').split(':').pop().replace(/^refs\/heads\//, '');
  return /^(main|master|develop|latest|staging|production|release\/.*)$/.test(branch) ? `force pushes never touch ${branch}.` : null;
}

const SHELLS = ['bash', 'sh', 'zsh', 'eval', 'env', 'xargs', 'command', 'nohup', 'time'];
const SQL_CLIS = ['mysql', 'mariadb', 'psql', 'rails', 'bin/rails'];
const SCHEMA_WRITE = /\b(alter|drop|truncate|rename)\s+table\b|\b(insert\s+into|delete\s+from|update)\s+`?(data|schema)_migrations\b/i;

function gitSub(words) {
  for (let i = 1; i < words.length; i++) {
    if (['-C', '-c'].includes(words[i])) i++;
    else if (!words[i].startsWith('-')) return words[i];
  }
  return null;
}

export function blockedReason(stage, command, g = {}) {
  for (const seg of segments(command)) {
    for (const inner of seg.inner) {
      const reason = blockedReason(stage, inner, g);
      if (reason) return reason;
    }
    let words = seg.words.slice(Math.max(0, seg.words.findIndex(w => !/^\w+=/.test(w))));
    while (SHELLS.includes(words[0])) {
      const inner = words.find((w, n) => n && words[n - 1] === '-c');
      if (inner) {
        const reason = blockedReason(stage, inner, g);
        if (reason) return reason;
      }
      words = words.slice(1).filter(w => !w.startsWith('-') && !/^\w+=/.test(w));
    }
    const reason = segmentReason(stage, words, g);
    if (reason) return reason;
  }
  return null;
}

function segmentReason(stage, words, g) {
  const [cmd, a, b] = words;
  const line = words.join(' ');
  if (cmd === 'gh' && a === 'pr' && b === 'merge') return g.job ? mergeProblem(words, g) : 'merging is never done by an agent.';
  if (cmd === 'gh' && a === 'pr' && b === 'create' && (!words.some(w => ['--draft', '-d'].includes(w)) || words.some(w => /^(--reviewer|-r)\b/.test(w)))) {
    return 'open the PR as a draft without reviewers; ready and reviewers come after Stef\'s ready gate.';
  }
  if (cmd === 'gh' && a === 'pr' && (b === 'ready' || (b === 'edit' && words.some(w => w.startsWith('--add-reviewer'))))) {
    if (!g.ready?.pr) return 'marking a PR ready or adding reviewers needs an approved ready gate for this job\'s PR (factory gate open ready --pr <url>, then Stef\'s pick).';
    if (!targets(words, g.ready.pr)) return `the approved ready gate is for ${g.ready.pr} only.`;
  }
  if (cmd === 'git' && gitSub(words) === 'push') {
    const forcePush = forcePushProblem(line);
    if (forcePush) return forcePush;
  }
  const apiWrite = cmd === 'gh' && a === 'api' && /\/(comments|reviews|replies)\b/.test(line) && !/(-X\s*|--method\s+)GET\b/.test(line)
    && /(-X\s*|--method\s+)(POST|PATCH|PUT|DELETE)\b|\s(-f|-F|--field|--raw-field|--input)\b/.test(line);
  const post = (cmd === 'gh' && ((a === 'pr' && ['comment', 'review'].includes(b)) || (a === 'issue' && b === 'comment'))) || apiWrite;
  if (post && [g.replies, g.review].some(x => x?.pr && targets(words, x.pr))) return null;
  if (post || (cmd === 'lavish-axi' && a === 'share')) return 'posting comments or reviews needs Stef; draft the text in your report instead.';
  if (cmd === 'factory' && a === 'gate' && b === 'decided' && ['approved', 'accepted'].includes(words[4]) && /\?["'\s]*$/.test(words[words.indexOf('--words') + 1] ?? '')) {
    return 'Stef\'s words end in a question: answer it and leave the gate open; record approved or accepted only on a reply that is not asking you something.';
  }
  if (!stage || stage === 'shipper') return null;
  if (SQL_CLIS.includes(cmd) && SCHEMA_WRITE.test(line)) return 'never change a shared database schema or its migration tables; a DB that does not match your branch is VERDICT: blocked, named in your report.';
  const commits = cmd === 'git' && ['commit', 'push'].includes(gitSub(words));
  const prEdit = cmd === 'gh' && a === 'pr' && ['create', 'ready', 'edit'].includes(b);
  if (stage === 'loop') return (commits || prEdit) && g.unshipped ? 'commit, push and PR edits wait for Stef\'s approved Gate 2 (factory gate decided gate2 approved).' : null;
  if (commits) return 'only the shipper commits or pushes, after Gate 2.';
  if (prEdit) return 'only the shipper opens or edits PRs, after Gate 2.';
  return null;
}

// SubagentStop / SubagentHandback: returns the rejection text, or null.
export async function validate(input) {
  const stage = stageOf(input);
  if (!stage) return null;
  const db = await open();
  const job = await db.prepare('select * from jobs where slug = ?').get(workspaceOf(input.cwd) ?? '');
  const problems = await reportProblems(db, job, stage, input.tool_name === 'SubagentHandback' ? String(input.tool_input?.message ?? '') : finalMessage(input));
  if (!problems.length) return null;
  const counter = path.join(TRACK(), `${input.agent_id ?? 'unknown'}.rejects`);
  const rejects = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
  if (rejects >= MAX_REJECTS) return null;
  fs.mkdirSync(TRACK(), { recursive: true });
  fs.writeFileSync(counter, String(rejects + 1));
  return `Your final reply was rejected by the factory report check: ${problems.join(' ')} Fix your report file, then re-send your final reply in the required format. Do not change any code for this.`;
}

function finalMessage(input) {
  if (input.last_assistant_message) return String(input.last_assistant_message);
  const t = input.agent_transcript_path;
  if (!t || !fs.existsSync(t)) return '';
  const texts = fs.readFileSync(t, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l).message; } catch { return null; } })
    .filter(m => m?.role === 'assistant').flatMap(m => [m.content].flat().filter(c => c?.type === 'text').map(c => c.text));
  return texts.at(-1) ?? '';
}

// The job's files from the factory DB, by name.
async function filesOf(db, job) {
  return new Map((job ? await db.prepare('select name, body from files where job_id = ?').all(job.id) : []).map(f => [f.name, f.body]));
}

export async function reportProblems(db, job, stage, message) {
  const verdict = message.match(/VERDICT:\W*([\w-]+)/)?.[1];
  if (!VERDICTS.includes(verdict)) return [`The reply needs a "VERDICT: <${VERDICTS.join('|')}>" line.`];
  if (!job) return ['No factory job here: a stage runs inside its job\'s workspace and saves its report with factory file put.'];
  const files = await filesOf(db, job);
  const report = [...message.matchAll(/(?:^|[\s`'"(:])((?:[\w.-]+\/)*[\w.-]+\.md)\b/g)].map(m => m[1]).filter(n => !n.startsWith('evidence/')).at(-1);
  if (!report || !files.has(report)) return ['The reply must end with the name of a report you saved with `factory file put <name>.md` (factory file ls lists them).'];
  if (!verdict.startsWith('done')) return [];
  if (stage === 'triage' || stage === 'spec') return criteriaProblems(files, stage === 'spec');
  if (OWNED_KINDS[stage]) return evidenceProblems(stage, files, files.get(report), verdict);
  return [];
}

function criteriaProblems(files, required) {
  if (!files.has('criteria.md')) return required ? ['criteria.md is missing from the job\'s files.'] : [];
  const rows = tableRows(files.get('criteria.md'), ['#', 'kind', 'source']);
  if (!rows.length) return ['criteria.md has no AC rows with #, Source and Kind columns.'];
  return rows.flatMap(r => [
    ...(KINDS.includes(r.kind) ? [] : [`${r['#']} has Kind "${r.kind}", expected one of ${KINDS.join(', ')}.`]),
    ...(r.source ? [] : [`${r['#']} has no Source.`]),
  ]);
}

function evidenceProblems(stage, files, report, verdict) {
  if (!files.has('criteria.md')) return ['criteria.md is missing from the job\'s files, so there is nothing to prove.'];
  const criteria = tableRows(files.get('criteria.md'), ['#', 'kind']);
  if (!criteria.length) return ['criteria.md has no AC table with # and Kind columns, so no criterion can be checked. Make its header row start with "| # |" and keep the Kind column.'];
  const owned = criteria.filter(r => OWNED_KINDS[stage].includes(r.kind));
  const rows = new Map(tableRows(report, ['#', 'evidence', 'verdict']).map(r => [r['#'], r]));
  const problems = [];
  for (const ac of owned) {
    const row = rows.get(ac['#']);
    if (!row) { problems.push(`The evidence table has no row for ${ac['#']}.`); continue; }
    if (!/^(holds|broken|not verified \(.+\))$/.test(row.verdict)) problems.push(`${ac['#']} verdict must be holds, broken or "not verified (reason)".`);
    else if (!row.verdict.startsWith('not verified') && !evidenceExists(files, row.evidence)) problems.push(`${ac['#']} cites no evidence file that exists in the job's files.`);
    if (verdict === 'done-verified' && row.verdict !== 'holds') problems.push(`done-verified needs every owned criterion to hold, ${ac['#']} does not.`);
  }
  return problems;
}

function evidenceExists(files, cell) {
  return cell.split(/[\s,`]+/).filter(t => t.includes('/') || /\.\w{2,5}$/.test(t)).some(t => files.has(t.replace(/^\.\//, '')));
}

export function tableRows(md, required) {
  const lines = md.split('\n').filter(l => l.trim().startsWith('|'));
  const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  const headerAt = lines.findIndex(l => required.every(k => cells(l).some(c => c.toLowerCase().startsWith(k))));
  if (headerAt < 0) return [];
  const header = cells(lines[headerAt]).map(c => c.toLowerCase());
  const col = k => header.findIndex(c => c.startsWith(k));
  return lines.slice(headerAt + 1).map(cells).filter(c => /^AC\d+$/.test(c[0]))
    .map(c => Object.fromEntries(required.map(k => [k, (c[col(k)] ?? '').replace(/`/g, '').trim()])))
    .map(r => (r.kind ? { ...r, kind: r.kind.toLowerCase() } : r));
}

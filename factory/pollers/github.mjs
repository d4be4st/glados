import { jsonAsync as json } from '../db.mjs';

const GH = process.env.FACTORY_GH || 'gh';
const FAILED = ['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED', 'ERROR'];
const isBot = login => /\[bot\]$|^copilot|bot$/i.test(login ?? '');

export function ciOf(rollup = []) {
  const failing = [];
  let pending = false;
  for (const c of rollup) {
    const state = c.__typename === 'StatusContext' ? c.state : c.status === 'COMPLETED' ? c.conclusion : 'PENDING';
    if (FAILED.includes(state)) failing.push({ name: c.name ?? c.context, url: c.detailsUrl ?? c.targetUrl });
    else if (['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS'].includes(state)) pending = true;
  }
  return { state: failing.length ? 'failed' : pending ? 'pending' : 'passed', failing };
}

// Pure: the events between the last snapshot of a PR and its current view, plus the next snapshot.
export function diffPr(seen, v, me) {
  const events = [];
  const next = { ...seen, head: v.headRefOid, state: v.state, draft: v.isDraft };
  const sha = v.headRefOid;
  const ev = (type, data = {}) => events.push({ type, data: { sha, ...data } });
  if (seen.head && seen.head !== sha) ev('pr.pushed', { from: seen.head });
  if (seen.draft && !v.isDraft && v.state === 'OPEN') ev('pr.ready');
  if (v.state === 'MERGED' && seen.state !== 'MERGED') ev('pr.merged', { mergedAt: v.mergedAt });
  if (v.state === 'CLOSED' && seen.state !== 'CLOSED') ev('pr.closed', { closedAt: v.closedAt });
  if (v.state !== 'OPEN') return { events, seen: next };
  const ci = ciOf(v.statusCheckRollup);
  if (ci.state !== 'pending' && seen.ci !== `${sha}:${ci.state}`) {
    ev(`ci.${ci.state}`, { failing: ci.failing });
    next.ci = `${sha}:${ci.state}`;
  }
  const known = new Set(seen.reviews ?? []);
  for (const r of v.reviews ?? []) {
    if (known.has(r.id) || isBot(r.author?.login)) continue;
    const threads = (v.inline ?? []).filter(c => r.databaseId && c.pull_request_review_id === r.databaseId)
      .map(c => ({ path: c.path, line: c.line ?? c.original_line, body: c.body }));
    if (r.state === 'COMMENTED' && !r.body?.trim() && !threads.length) continue;
    const type = { APPROVED: 'review.approved', CHANGES_REQUESTED: 'review.changes_requested' }[r.state] ?? 'review.commented';
    ev(type, { author: r.author?.login, own: r.author?.login === me, body: r.body, threads });
  }
  next.reviews = (v.reviews ?? []).map(r => r.id);
  if (v.mergeable === 'CONFLICTING' && seen.conflict !== sha) { ev('pr.conflict'); next.conflict = sha; }
  if (v.reviewDecision === 'APPROVED' && ci.state === 'passed' && v.mergeable === 'MERGEABLE' && !v.isDraft && seen.ready !== sha) {
    ev('pr.merge_ready', { title: v.title });
    next.ready = sha;
  }
  return { events, seen: next };
}

export function parseUrl(url) {
  const m = String(url).match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
  return m && { owner: m[1], repo: m[2], number: Number(m[3]), url: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}` };
}

const BATCH = 25;
const FRAGMENT = `fragment F on PullRequest {
  number url title state isDraft headRefOid mergeable reviewDecision mergedAt closedAt
  reviews(last: 50) { nodes { id databaseId state body author { login } comments(first: 50) { nodes { path line originalLine body } } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
    __typename ... on CheckRun { name status conclusion detailsUrl } ... on StatusContext { context state targetUrl } } } } } } }
}`;

export const graphql = query => json(GH, ['api', 'graphql', '-f', `query=${query}`]);

// One GraphQL query for a batch of PRs: each repo once, each PR aliased under it, plus who is asking.
export function batchQuery(urls) {
  const repos = Object.groupBy(urls.map(parseUrl), p => `${p.owner}/${p.repo}`);
  const body = Object.entries(repos).map(([full, prs], r) => {
    const [owner, name] = full.split('/');
    return `r${r}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${prs.map((p, n) => `p${n}: pullRequest(number: ${p.number}) { ...F }`).join(' ')} }`;
  });
  return `${FRAGMENT}\nquery { viewer { login } ${body.join(' ')} }`;
}

// Pure: a GraphQL PullRequest in the shape diffPr reads (gh pr view's JSON, plus inline review comments).
export function toView(node) {
  const reviews = (node.reviews?.nodes ?? []).map(({ comments, ...r }) => r);
  const inline = (node.reviews?.nodes ?? []).flatMap(r => (r.comments?.nodes ?? []).map(c => ({ pull_request_review_id: r.databaseId, path: c.path, line: c.line, original_line: c.originalLine, body: c.body })));
  const { reviews: _, commits, ...rest } = node;
  return { ...rest, reviews, inline, statusCheckRollup: commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [] };
}

// Pure: the views out of a batch answer, keyed by PR url.
export function viewsOf(data) {
  const out = new Map();
  for (const [key, repo] of Object.entries(data ?? {})) {
    if (key === 'viewer' || !repo) continue;
    for (const pr of Object.values(repo)) if (pr?.url) out.set(pr.url, toView(pr));
  }
  return out;
}

// Tracked PRs, every minute, one GraphQL query per 25: everything diffPr needs, reviews' inline comments included.
export default {
  name: 'github',
  every: Number(process.env.FACTORY_GH_MS ?? 60 * 1000),
  async run(ctx) {
    const rows = await ctx.db.prepare("select * from prs where job_id is not null and state not in ('MERGED', 'CLOSED')").all();
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const answer = await (ctx.graphql ?? graphql)(batchQuery(batch.map(r => r.url)));
      if (!answer?.data) continue;
      const me = answer.data.viewer?.login;
      const views = viewsOf(answer.data);
      for (const row of batch) await apply(ctx, row, views.get(row.url), me);
    }
  },
};

async function apply(ctx, row, view, me) {
  if (!view) return;
  const url = row.url;
  const p = parseUrl(url);
  const seen = JSON.parse(row.seen ?? '{}');
  const { events, seen: next } = diffPr(seen, view, me);
  const slug = (await ctx.db.prepare('select slug from jobs where id = ?').get(row.job_id))?.slug;
  const update = ['update prs set seen = ?, head_sha = ?, state = ?, title = ?, ci = ?, review = ?, merge_ready = ?, draft = ?, merged_at = coalesce(merged_at, ?) where url = ?',
    JSON.stringify(next), view.headRefOid, view.state, view.title, ciOf(view.statusCheckRollup).state, view.reviewDecision ?? null,
    next.ready === view.headRefOid ? 1 : 0, view.isDraft ? 1 : 0, view.mergedAt ? Date.parse(view.mergedAt) : null, url];
  if (!events.length) await ctx.db.prepare(update[0]).run(...update.slice(1));
  for (const [n, e] of events.entries()) await ctx.emit(e.type, url, { ...e.data, job: slug, number: p.number, repo: `${p.owner}/${p.repo}` }, n < events.length - 1 ? [] : [update]);
}

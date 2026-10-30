import { now } from '../db.mjs';
import { graphql, parseUrl } from './github.mjs';

const QUERY = 'query { search(query: "is:pr is:open author:@me archived:false", type: ISSUE, first: 100) { nodes { ... on PullRequest { url } } } }';

// Stef's open PRs, every 10 minutes: one the factory has never seen is flagged unregistered, once.
export default {
  name: 'github-search',
  every: Number(process.env.FACTORY_GH_SEARCH_MS ?? 10 * 60 * 1000),
  async run(ctx) {
    const nodes = (await (ctx.graphql ?? graphql)(QUERY))?.data?.search?.nodes;
    if (!Array.isArray(nodes)) return;
    const known = new Set((await ctx.db.prepare('select url from prs').all()).map(r => r.url));
    for (const url of new Set(nodes.map(n => parseUrl(n.url)?.url).filter(Boolean))) {
      if (known.has(url)) continue;
      const p = parseUrl(url);
      await ctx.emit('pr.unregistered', url, { number: p.number, repo: `${p.owner}/${p.repo}` },
        [["insert into prs (url, repo, number, state, created_at) values (?, ?, ?, 'unregistered', ?)", url, `${p.owner}/${p.repo}`, p.number, now()]]);
    }
  },
};

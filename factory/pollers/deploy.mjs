import { jsonAsync as json, now } from '../db.mjs';
import { parseUrl } from './github.mjs';

const GH = process.env.FACTORY_GH || 'gh';
const SEM = process.env.FACTORY_TB_SEM || 'tb-sem';
const STAGES = [['latest', 'latest'], ['production', 'master']];
const WINDOW = 14 * 24 * 3600 * 1000;

async function contains(repo, branch, sha) {
  const status = (await json(GH, ['api', `repos/${repo}/compare/${branch}...${sha}`, '--jq', '{status}']))?.status;
  return ['behind', 'identical'].includes(status);
}

async function deployedAt(project, stage, branch, mergedAt) {
  const deploys = (await json(SEM, ['deploys', '--branch', branch, '--utc', '--json', project]))?.deploys?.filter(d => d.name.includes(stage)) ?? [];
  const utc = s => Date.parse(`${String(s).replace(' ', 'T')}Z`);
  const ends = deploys.filter(d => d.end && utc(d.start) >= mergedAt).map(d => utc(d.end));
  return ends.length ? Math.min(...ends) : null;
}

export default {
  name: 'deploy',
  every: Number(process.env.FACTORY_DEPLOY_MS ?? 10 * 60 * 1000),
  async run(ctx) {
    const rows = await ctx.db.prepare("select p.*, j.slug from prs p left join jobs j on j.id = p.job_id where p.state = 'MERGED' and p.production_at is null and p.job_id is not null and coalesce(p.merged_at, 0) > ?").all(now() - WINDOW);
    for (const pr of rows) {
      const p = parseUrl(pr.url);
      const sha = pr.merge_sha ?? (await json(GH, ['pr', 'view', pr.url, '--json', 'mergeCommit']))?.mergeCommit?.oid;
      if (!sha) continue;
      for (const [stage, branch] of STAGES) {
        if (pr[`${stage}_at`] || !(await contains(`${p.owner}/${p.repo}`, branch, sha))) continue;
        const t = await deployedAt(p.repo, stage, branch, pr.merged_at ?? 0);
        if (!t) continue;
        pr[`${stage}_at`] = t;
        await ctx.emit(`pr.${stage}`, pr.url, { job: pr.slug, number: p.number, repo: `${p.owner}/${p.repo}`, sha },
          [[`update prs set ${stage}_at = ?, merge_sha = ? where url = ?`, t, sha, pr.url]]);
      }
    }
  },
};

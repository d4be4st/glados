import { plate } from '../jobs.mjs';

export default {
  name: 'adopt',
  on: ['pr.unregistered'],
  run(row, ctx) {
    ctx.write(...plate('unregistered', row.subject, `Your open PR ${row.subject} has no job. Adopt it: factory pr add ${row.subject} --job <slug> (or start a job for it), or drop it: factory pr ignore ${row.subject}.`));
  },
};

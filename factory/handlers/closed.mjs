import { clearPlate, plate } from '../jobs.mjs';

export default {
  name: 'closed',
  on: ['pr.closed'],
  run(row, ctx) {
    ctx.write(...clearPlate(row.subject));
    ctx.write(...plate('closed', row.subject, `#${row.data.number} was closed without merge${row.data.job ? ` (job ${row.data.job})` : ''}.`));
  },
};

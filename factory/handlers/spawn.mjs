import { materialize, moveIn, plate } from '../jobs.mjs';

export default {
  name: 'spawn',
  scope: 'machine',
  on: ['job.created', 'job.moved'],
  async run(row, ctx) {
    const d = row.data;
    const to = row.type === 'job.moved' ? d.to : d.machine;
    if (to !== ctx.machine || (row.type === 'job.created' && d.inline)) return;
    try {
      if (row.type === 'job.created') await (ctx.materialize ?? materialize)(ctx.db, row.subject);
      else await (ctx.moveIn ?? moveIn)(ctx.db, row.subject, d.worktrees ?? []);
    } catch (e) {
      return ctx.write(...plate('spawn-failed', row.subject, `the ${ctx.machine} could not set up ${row.subject} after ${row.type}: ${e.message}`));
    }
    ctx.emit('job.spawned', row.subject, { machine: ctx.machine, by: row.type });
  },
};

import { now } from '../db.mjs';

export function timer(at, type, subject, data) {
  return ['insert into timers (at, type, subject, data) values (?, ?, ?, ?)', at, type, subject, JSON.stringify(data)];
}

export default {
  name: 'timers',
  every: Number(process.env.FACTORY_TIMERS_MS ?? 30000),
  async run(ctx) {
    const t = now();
    for (const due of await ctx.db.prepare('select * from timers where fired_at is null and at <= ? order by at').all(t)) {
      await ctx.emit(due.type, due.subject, { ...JSON.parse(due.data ?? '{}'), at: due.at }, [['update timers set fired_at = ? where id = ?', t, due.id]]);
    }
  },
};

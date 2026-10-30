import { now } from '../db.mjs';

const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
const MINUTE = 60e3;
const LOOKBACK = 8 * 24 * 60;

function field(spec, [lo, hi]) {
  const out = new Set();
  for (const part of spec.split(',')) {
    const [range, step = '1'] = part.split('/');
    const [a, b] = range === '*' ? [lo, hi] : range.split('-').map(Number);
    for (let v = a; v <= (b ?? (step === '1' ? a : hi)); v += Number(step)) out.add(v);
  }
  if ([...out].some(v => Number.isNaN(v) || v < lo || v > hi)) throw new Error(`bad cron field ${spec}`);
  return out;
}

export function parse(cron) {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron needs 5 fields: ${cron}`);
  return parts.map((p, i) => field(p, RANGES[i]));
}

// The most recent occurrence at or before t (local time), within 8 days.
export function lastOccurrence(cron, t) {
  const [min, hour, dom, mon, dow] = parse(cron);
  let m = Math.floor(t / MINUTE) * MINUTE;
  for (let i = 0; i < LOOKBACK; i++, m -= MINUTE) {
    const d = new Date(m);
    if (min.has(d.getMinutes()) && hour.has(d.getHours()) && dom.has(d.getDate()) && mon.has(d.getMonth() + 1) && dow.has(d.getDay())) return m;
  }
  return null;
}

export default {
  name: 'schedules',
  every: Number(process.env.FACTORY_SCHEDULES_MS ?? 30000),
  async run(ctx) {
    const t = now();
    for (const s of await ctx.db.prepare('select * from schedules').all()) {
      const occurrence = lastOccurrence(s.cron, t);
      if (!occurrence || occurrence <= (s.last_fired ?? 0)) continue;
      await ctx.emit('timer.due', s.name, { occurrence, action: s.action, machine: s.machine ?? 'server' }, [['update schedules set last_fired = ? where name = ?', occurrence, s.name]]);
    }
  },
};

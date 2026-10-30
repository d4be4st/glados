import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MACHINE } from '../db.mjs';
import { usage } from '../dash.mjs';

const BACKFILL_DAYS = 14;

export const dayOf = ms => new Date(ms).toLocaleDateString('sv');

// Per-day Claude Code numbers in the daily table: tokens per model (input + output + cache writes, from the
// transcripts, each file read once and then only its new bytes) and the 5h peak / latest 7d usage.
export function tracker(root = path.join(os.homedir(), '.claude', 'projects')) {
  const read = new Map();
  // ponytail: seen keeps every message id until the scheduler restarts (a few MB a day). Upgrade: drop ids older than since.
  const seen = new Set();
  const days = {};
  let since = new Date(Date.now() - BACKFILL_DAYS * 86400e3).setHours(0, 0, 0, 0);
  const take = line => {
    if (!line.includes('"usage"')) return null;
    let l;
    try { l = JSON.parse(line); } catch { return null; }
    const msg = l.message;
    const ts = Date.parse(l.timestamp);
    if (!msg?.usage || !msg.id || seen.has(msg.id) || !(ts >= since)) return null;
    seen.add(msg.id);
    const day = dayOf(ts);
    const name = msg.model?.match(/opus|sonnet|haiku|fable/)?.[0] ?? 'other';
    days[day] ??= {};
    days[day][name] = (days[day][name] ?? 0) + (msg.usage.input_tokens ?? 0) + (msg.usage.output_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0);
    return day;
  };
  const walk = async dir => {
    const found = [];
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) found.push(...await walk(f));
      else if (e.name.endsWith('.jsonl')) found.push(f);
    }
    return found;
  };
  return async function scan() {
    const touched = new Set();
    for (const f of await walk(root)) {
      const stat = await fs.stat(f).catch(() => null);
      const from = read.get(f) ?? 0;
      if (!stat || stat.mtimeMs < since || stat.size <= from) continue;
      const handle = await fs.open(f);
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(stat.size - from), 0, stat.size - from, from);
      await handle.close();
      const text = buffer.subarray(0, bytesRead).toString('utf8');
      const end = text.lastIndexOf('\n') + 1;
      read.set(f, from + Buffer.byteLength(text.slice(0, end)));
      for (const line of text.slice(0, end).split('\n')) {
        const day = take(line);
        if (day) touched.add(day);
      }
    }
    since = new Date().setHours(0, 0, 0, 0) - 86400e3;
    return [...touched].map(day => [day, days[day]]);
  };
}

export async function record(db, scanned, u = null, at = Date.now(), machine = MACHINE) {
  const put = db.prepare('insert into daily (day, key, machine, value) values (?, ?, ?, ?) on conflict(day, key, machine) do update set value = excluded.value');
  for (const [day, models] of scanned) for (const [name, n] of Object.entries(models)) if (n) await put.run(day, `tokens.${name}`, machine, n);
  if (u?.five_hour) await db.prepare("insert into daily (day, key, machine, value) values (?, 'usage.5h', ?, ?) on conflict(day, key, machine) do update set value = greatest(daily.value, excluded.value)").run(dayOf(at), machine, u.five_hour.utilization);
  if (u?.seven_day) await put.run(dayOf(at), 'usage.7d', machine, u.seven_day.utilization);
}

const scan = tracker();

export default {
  name: 'daily',
  scope: 'machine',
  every: Number(process.env.FACTORY_DAILY_MS ?? 5 * 60e3),
  async run(ctx) {
    await record(ctx.db, await scan(), usage(), Date.now(), ctx.machine);
  },
};

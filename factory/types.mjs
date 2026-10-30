import fs from 'node:fs';
import path from 'node:path';
import { DIR } from './db.mjs';

export const TYPES = process.env.FACTORY_TYPES || path.join(DIR, 'types');
export const ELEMENTS = process.env.FACTORY_ELEMENTS || path.join(DIR, 'elements.yaml');
const MODES = ['orchestrator', 'writer', 'loop'];

// The YAML subset these files use: nested maps and lists by indentation, flow [..] and {..}, plain scalars.
export function yaml(text) {
  const lines = text.split('\n').map(l => l.replace(/(^|\s)#.*$/, '')).filter(l => l.trim())
    .map(l => ({ indent: l.search(/\S/), text: l.trim() }));
  let i = 0;
  const block = indent => (lines[i].text.startsWith('- ') ? list(indent) : map(indent));
  const nested = indent => (i < lines.length && lines[i].indent > indent ? block(lines[i].indent) : null);
  function list(indent) {
    const out = [];
    while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith('- ')) {
      const t = lines[i++].text.slice(2).trim();
      const kv = t.match(/^([\w.-]+):\s*(.*)$/);
      out.push(kv ? { [kv[1]]: kv[2] ? scalar(kv[2]) : nested(indent) } : scalar(t));
    }
    return out;
  }
  function map(indent) {
    const out = {};
    while (i < lines.length && lines[i].indent === indent) {
      const kv = lines[i++].text.match(/^([\w.-]+):\s*(.*)$/);
      if (!kv) throw new Error(`cannot parse line ${i}: ${lines[i - 1].text}`);
      out[kv[1]] = kv[2] ? scalar(kv[2]) : nested(indent);
    }
    return out;
  }
  return lines.length ? block(lines[0].indent) : {};
}

function split(s) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if ('[{'.includes(ch)) depth++;
    if (']}'.includes(ch)) depth--;
    if (ch === ',' && !depth) { parts.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function scalar(v) {
  if (v.startsWith('[')) return split(v.slice(1, -1)).map(scalar);
  if (v.startsWith('{')) return Object.fromEntries(split(v.slice(1, -1)).map(p => p.match(/^([\w.-]+):\s*(.*)$/)).map(([, k, x]) => [k, scalar(x)]));
  if (/^(['"]).*\1$/.test(v)) return v.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === 'true' || v === 'false') return v === 'true';
  return v;
}

export function elements() {
  return yaml(fs.readFileSync(ELEMENTS, 'utf8'));
}

export function steps(type) {
  return (type.steps ?? []).map(s => (typeof s === 'string' ? { element: s } : { element: Object.keys(s)[0], ...Object.values(s)[0] }));
}

export function stepName(s) {
  return s.element === 'gate' ? `gate:${s.name}` : s.element;
}

export function load(name) {
  const file = path.join(TYPES, `${name}.yaml`);
  if (!fs.existsSync(file)) throw new Error(`no job type ${name} (${file})`);
  return { name, ...yaml(fs.readFileSync(file, 'utf8')) };
}

export function names() {
  return fs.existsSync(TYPES) ? fs.readdirSync(TYPES).filter(f => f.endsWith('.yaml')).map(f => f.slice(0, -5)).sort() : [];
}

export function when(expr) {
  return (expr ? String(expr).split(/\s+and\s+/) : []).map(c => {
    const m = c.trim().match(/^([\w.]+)\s*==\s*(\S+)$/);
    if (!m) throw new Error(`cannot read condition "${c}"`);
    return { key: m[1], value: m[2] };
  });
}

export function matches(rule, type, data) {
  return rule.on === type && when(rule.when).every(c => String(data?.[c.key]) === c.value);
}

export function check(type, catalogue = elements()) {
  const problems = [];
  if (!MODES.includes(type.lead)) problems.push(`lead must be one of ${MODES.join(', ')}, not ${type.lead}`);
  const list = steps(type);
  if (!list.length) problems.push('no steps');
  list.forEach((s, n) => {
    const el = catalogue[s.element];
    if (!el) return problems.push(`step ${n + 1}: unknown element ${s.element}`);
    if (s.element === 'gate' && !s.name) problems.push(`step ${n + 1}: a gate needs a name`);
    for (const r of [el.requires ?? []].flat()) {
      if (!list.slice(0, n).some(p => r.split('|').includes(p.element))) problems.push(`step ${n + 1}: ${s.element} needs ${r.split('|')[0]} before it`);
    }
  });
  const rule = type.done;
  if (!rule?.on) return [...problems, 'no done rule'];
  if (rule.on === 'manual') return problems;
  let conds = [];
  try { conds = when(rule.when); } catch (e) { return [...problems, e.message]; }
  const cond = key => conds.find(c => c.key === key)?.value;
  const produced = new Set(['job.step', ...list.flatMap(s => catalogue[s.element]?.produces ?? [])]);
  const unreachable = why => problems.push(`done rule ${rule.on}${rule.when ? ` when ${rule.when}` : ''} is unreachable: ${why}`);
  if (!produced.has(rule.on)) unreachable(`no step leads to ${rule.on}`);
  else if (rule.on === 'job.step' && !list.some(s => s.element === cond('element'))) unreachable(`no step ${cond('element')}`);
  else if (rule.on === 'gate.decided' && cond('name') && !list.some(s => s.element === 'gate' && s.name === cond('name'))) unreachable(`no gate ${cond('name')}`);
  else if (rule.on === 'soak.clean') {
    const stage = cond('stage');
    const checkpoint = cond('checkpoint');
    if (stage && !type.soak?.[stage]) unreachable(`no soak stage ${stage}`);
    else if (checkpoint && !(stage ? type.soak[stage] : Object.values(type.soak ?? {}).flat()).includes(checkpoint)) unreachable(`no soak checkpoint ${checkpoint}`);
  }
  return problems;
}

export function phaseOf(list, index, catalogue = elements()) {
  for (let n = index; n >= 0; n--) {
    const p = catalogue[list[n]?.element]?.phase;
    if (p && p !== 'previous') return p;
  }
  return 'plan';
}

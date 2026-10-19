// Volume = load x reps over the working sets, technique reps included.
// Max load alone lies: a drop set lowers the load on purpose, and a 5-set day
// looks better than a 4-set one even with less effort per set. So comparisons
// always cut both days down to the same number of sets.

import { tonnage, setReps } from './sets.js';

export function volumeOf(sets) {
  return Math.round(tonnage((sets || []).filter((s) => s && s.reps > 0)));
}

export function repsOf(sets) {
  return (sets || []).filter((s) => s && s.reps > 0).reduce((n, s) => n + setReps(s), 0);
}

// pull-ups, dips, abs: no tonnage, effort is total reps
export function isBodyweightSets(sets) {
  const list = (sets || []).filter((s) => s && s.reps > 0);
  return list.length > 0 && list.every((s) => !s.load);
}

export function effortOf(sets) {
  return isBodyweightSets(sets)
    ? { value: repsOf(sets), unit: 'reps' }
    : { value: volumeOf(sets), unit: 'kg' };
}

export function fmtEffort(sets) {
  const e = effortOf(sets);
  return e.unit === 'reps' ? `${e.value} reps` : fmtVolume(e.value);
}

/** Compare two days of one exercise using only the sets both of them have. */
export function compareAtEqualSets(nowSets, prevSets) {
  const a = (nowSets || []).filter((s) => s && s.reps > 0);
  const b = (prevSets || []).filter((s) => s && s.reps > 0);
  const n = Math.min(a.length, b.length);
  if (!n) return null;

  const byReps = isBodyweightSets(a) && isBodyweightSets(b);
  const measure = byReps ? repsOf : volumeOf;
  const now = measure(a.slice(0, n));
  const prev = measure(b.slice(0, n));
  const pct = prev > 0 ? ((now - prev) / prev) * 100 : null;
  return {
    usedSets: n,
    unit: byReps ? 'reps' : 'kg',
    now, prev,
    diff: now - prev,
    pct,
    droppedNow: a.length - n,
    droppedPrev: b.length - n,
  };
}

// pt-BR style: "12,4t" for big numbers, "840kg" otherwise
export function fmtVolume(kg) {
  if (!Number.isFinite(kg)) return '—';
  if (kg >= 10000) return `${(kg / 1000).toFixed(1).replace('.', ',')}t`;
  return `${Math.round(kg)}kg`;
}

export function fmtPct(pct) {
  if (pct == null || !Number.isFinite(pct)) return '';
  const r = Math.round(pct);
  if (r === 0) return '=';
  return `${r > 0 ? '+' : '−'}${Math.abs(r)}%`;
}

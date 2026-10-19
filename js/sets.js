// The notebook logs everything together, but sets have different jobs:
//
//   Supino Inclinado Barra:  20×9   30×6  30×5   25×8  25×6[drop]  20×8
//                            feeder  `--work--'   `----- back-off -----'
//
// Mixing them ruins every number (volume inflated by warm-ups, "last time"
// showing a warm-up), so sets are classified by position relative to the
// heaviest set of the day: lighter ones before it are feeders, after it back-offs.

// 30kg -> 28kg is still work, 20kg -> 30kg is a feeder
const WORK_THRESHOLD = 0.88;

export function classifySets(sets) {
  const list = sets || [];
  if (list.length === 0) return [];

  const loads = list.map((s) => s.load || 0);
  const top = Math.max(...loads);

  if (top <= 0 || loads.every((l) => l >= top * WORK_THRESHOLD)) {
    return list.map((s) => ({ ...s, role: 'work' }));
  }

  const firstTop = loads.findIndex((l) => l >= top * WORK_THRESHOLD);
  const lastTop = loads.length - 1 - [...loads].reverse().findIndex((l) => l >= top * WORK_THRESHOLD);

  return list.map((s, i) => {
    const light = (s.load || 0) < top * WORK_THRESHOLD;
    if (light && i < firstTop) return { ...s, role: 'feeder' };
    if (light && i > lastTop) return { ...s, role: 'backoff' };
    return { ...s, role: 'work' };
  });
}

export function workSets(sets) {
  return classifySets(sets).filter((s) => s.role !== 'feeder');
}

// "30kg×8 drop 20kg×10" is 240 + 200, not 240. A technique without its own
// load ("drop 6") is assumed to use the set's load.
export function setVolume(set) {
  const base = (set.load || 0) * (set.reps || 0);
  const extra = (set.techniques || []).reduce((sum, t) => {
    const load = t.load ?? set.load ?? 0;
    return sum + load * (t.reps || 0);
  }, 0);
  return base + extra;
}

export function setReps(set) {
  const extra = (set.techniques || []).reduce((sum, t) => sum + (t.reps || 0), 0);
  return (set.reps || 0) + extra;
}

export function tonnage(sets) {
  return (sets || []).reduce((sum, s) => sum + setVolume(s), 0);
}

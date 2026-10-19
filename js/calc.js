import { workSets, tonnage } from './sets.js';

// Brzycki falls apart past ~12 reps (a set of 20 projects 2.1x the load used),
// so long sets stay in the history but don't feed the 1RM estimate
const BRZYCKI_MAX_REPS = 12;

const RECENT_WINDOW_DAYS = 56;

// Safety cap. Extrapolating a 1RM from 10-12 rep sets and then taking 85% of it
// asked for loads nobody had ever lifted: lat pulldown 130kg×10 -> 1RM 173 ->
// target 148kg. No target goes past this factor over the best load actually used.
const MAX_OVER_BEST_LOAD = 1.10;

// short sets estimate 1RM way better than long ones
function repsConfidence(reps) {
  if (reps <= 8) return 1.0;
  if (reps <= 10) return 0.97;
  return 0.94;
}

// heavy day is 5-8, not 4-6: a whole session of 4-6 beats up the joints for
// what it gives back. 85% for 8 reps would be an impossible set, hence 0.80.
export const REP_RANGE = {
  A: [5, 8],
  B: [10, 15],
};

export const INTENSITY = {
  A: 0.80,
  B: 0.70,
};

/** %1RM for a rep target, inverse Brzycki. Used when an exercise has its own rep range. */
export function intensityForReps(reps) {
  const pct = 1.0278 - 0.0278 * reps;
  return Math.min(0.95, Math.max(0.5, pct));
}

export function brzycki(load, reps) {
  if (!load || load <= 0 || !reps || reps < 1) return null;
  const denom = 1.0278 - 0.0278 * reps;
  if (denom <= 0.05) return null;
  return load / denom;
}

// Suggestions only. Every machine stack and dumbbell rack at my gym goes in 5kg
// steps, a "47kg" target just gets rounded in your head every time. What gets
// typed is stored as-is (2.5kg plates on bench included).
export const LOAD_STEP = 5;

export function roundLoad(kg, step = LOAD_STEP) {
  if (!Number.isFinite(kg)) return null;
  return Math.round(kg / step) * step;
}

/**
 * Best projected 1RM inside the last 8 weeks. Falls back to the whole history
 * and flags it `stale` when there's nothing recent.
 */
export function estimateOneRM(sets, opts = {}) {
  const ref = opts.referenceDate ? new Date(opts.referenceDate) : new Date();

  const usable = (sets || [])
    .filter((s) => s.load > 0 && s.reps >= 1 && s.reps <= BRZYCKI_MAX_REPS)
    .map((s) => ({ ...s, oneRM: brzycki(s.load, s.reps) * repsConfidence(s.reps) }))
    .filter((s) => s.oneRM != null && Number.isFinite(s.oneRM));

  if (usable.length === 0) return null;

  const cutoff = new Date(ref.getTime() - RECENT_WINDOW_DAYS * 86400000);
  const recent = usable.filter((s) => s.date && new Date(s.date) >= cutoff);

  const pool = recent.length > 0 ? recent : usable;
  const best = pool.reduce((a, b) => (b.oneRM > a.oneRM ? b : a));

  return {
    oneRM: best.oneRM,
    basedOn: { date: best.date, load: best.load, reps: best.reps },
    stale: recent.length === 0,
    samples: pool.length,
    bestLoad: Math.max(...(sets || []).filter((s) => s.load > 0).map((s) => s.load)),
  };
}

// Same thing without the recency window, for comparing whole periods on the
// dashboard (the peak of that period, even if it was at the start of it)
export function bestOneRM(sets) {
  const usable = (sets || [])
    .filter((s) => s.load > 0 && s.reps >= 1 && s.reps <= BRZYCKI_MAX_REPS)
    .map((s) => ({ ...s, oneRM: brzycki(s.load, s.reps) * repsConfidence(s.reps) }))
    .filter((s) => s.oneRM != null && Number.isFinite(s.oneRM));

  if (usable.length === 0) return null;

  const best = usable.reduce((a, b) => (b.oneRM > a.oneRM ? b : a));
  return {
    oneRM: best.oneRM,
    basedOn: { date: best.date, load: best.load, reps: best.reps },
    samples: usable.length,
  };
}

export function targetLoad(oneRM, intensity, bestLoad) {
  if (!Number.isFinite(oneRM)) return { load: null, capped: false, raw: null };

  const raw = oneRM * intensity;
  const ceiling = Number.isFinite(bestLoad) ? bestLoad * MAX_OVER_BEST_LOAD : Infinity;
  const capped = raw > ceiling;

  return { load: roundLoad(Math.min(raw, ceiling)), capped, raw: roundLoad(raw) };
}

/**
 * Full prescription for one exercise today. opts.repRange overrides the
 * variant's range and the intensity is recomputed from it, so the load
 * actually matches the reps asked for.
 */
export function prescribe(exercise, variant, opts = {}) {
  const est = estimateOneRM(exercise.sessions, opts);
  const [minReps, maxReps] = opts.repRange ?? REP_RANGE[variant];
  const intensity = opts.repRange ? intensityForReps((minReps + maxReps) / 2) : INTENSITY[variant];

  const isBodyweight = !est && (exercise.sessions || []).some((s) => s.bodyweight);
  const target = est ? targetLoad(est.oneRM, intensity, est.bestLoad) : { load: null, capped: false };

  return {
    exerciseId: exercise.id,
    name: exercise.name,
    group: exercise.group,
    variant,
    targetLoad: target.load,
    capped: target.capped,
    uncappedLoad: target.raw,
    repRange: [minReps, maxReps],
    oneRM: est ? Math.round(est.oneRM * 10) / 10 : null,
    bestLoad: est ? est.bestLoad : null,
    stale: est ? est.stale : false,
    basedOn: est ? est.basedOn : null,
    bodyweight: isBodyweight,
    lastSets: lastSessionSets(exercise.sessions),
    lastDays: recentDaysSets(exercise.sessions, LAST_DAYS),
  };
}

export const LAST_DAYS = 7;

// "last time" alone hides the trend, the card shows the last N days
function recentDaysSets(sessions, n) {
  const byDate = new Map();
  for (const s of sessions || []) {
    if (!s.date) continue;
    if (!byDate.has(s.date)) byDate.set(s.date, []);
    byDate.get(s.date).push(s);
  }
  return [...byDate.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, n)
    .map(([date, sets]) => ({
      date,
      sets: workSets(sets).map((s) => ({ load: s.load, reps: s.reps, role: s.role,
        techniques: s.techniques || null })),
    }))
    .filter((d) => d.sets.length);
}

// warm-ups left out: showing "20kg×9" for a day the work was at 30kg is misleading
function lastSessionSets(sessions) {
  const dated = (sessions || []).filter((s) => s.date);
  if (dated.length === 0) return [];
  const lastDate = dated.reduce((a, b) => (b.date > a.date ? b : a)).date;
  const ofDay = dated.filter((s) => s.date === lastDate);
  return workSets(ofDay).map((s) => ({ load: s.load, reps: s.reps, role: s.role,
    techniques: s.techniques || null }));
}

export { tonnage };

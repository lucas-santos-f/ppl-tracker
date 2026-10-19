// 2x PPL, two variants per slot (A/B) with different exercises and rep ranges.
// The cycle moves per FINISHED workout, never by calendar date: an extra rest day
// postpones the next workout instead of skipping it.

import { indexByExercise } from './parser.js';
import { normalizeExercise, movementsOf, contradicts } from './normalize.js';
import { prescribe } from './calc.js';
import { programFor, PROGRAM } from './program.js';
import { canonicalId } from './curation.js';
import { techniquePattern, techniquePlan } from './technique.js';
import { mainLiftPlan } from './mainlift.js';

const DEFAULT_SETS = 3;

export const CYCLE = [
  { slot: 'push', variant: 'A' },
  { slot: 'pull', variant: 'A' },
  { slot: 'legs', variant: 'A' },
  { slot: 'push', variant: 'B' },
  { slot: 'pull', variant: 'B' },
  { slot: 'legs', variant: 'B' },
];

export const SLOT_LABEL = { push: 'Push', pull: 'Pull', legs: 'Legs' };
export const VARIANT_LABEL = { A: 'Treino A', B: 'Treino B' };

// past sessions of the same slot looked at to build the day
const TEMPLATE_LOOKBACK = 4;

// a real session is 6-9 exercises, merging a few sessions without a cap gave 20+
const MAX_EXERCISES = 9;

// swap suggestions per exercise, and how often a variation must show up to be suggested
const MAX_VARIANTS = 2;
const MIN_VARIANT_SESSIONS = 4;

// core never decides the day, it's an accessory on all of them
export function classifySession(session) {
  const counts = { push: 0, pull: 0, legs: 0 };
  for (const e of session.exercises || []) {
    if (counts[e.group] != null) counts[e.group]++;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : null;
}

// Base = the LAST session of the slot (what's actually being trained, in that
// order). Older ones only fill the gaps, by frequency.
export function templateForSlot(sessions, slot) {
  const ofSlot = sessions
    .filter((s) => s.date && classifySession(s) === slot)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, TEMPLATE_LOOKBACK);

  if (ofSlot.length === 0) return [];

  const [latest, ...previous] = ofSlot;
  const out = [];
  const taken = new Set();

  for (const e of latest.exercises) {
    if (taken.has(e.id)) continue;
    taken.add(e.id);
    out.push(e);
  }

  if (out.length < MAX_EXERCISES) {
    const freq = new Map();
    for (const s of previous) {
      for (const e of s.exercises) {
        if (taken.has(e.id)) continue;
        const cur = freq.get(e.id) || { count: 0, exercise: e };
        cur.count++;
        freq.set(e.id, cur);
      }
    }
    const extras = [...freq.values()]
      .filter((v) => v.count >= 2)  // in 2+ sessions
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_EXERCISES - out.length);
    out.push(...extras.map((v) => v.exercise));
  }

  return out.slice(0, MAX_EXERCISES);
}

export function workoutForPosition(state, opts = {}) {
  const pos = opts.position ?? (state.cyclePosition || 0);
  const step = CYCLE[((pos % CYCLE.length) + CYCLE.length) % CYCLE.length];

  const history = state.sessions || [];
  const index = indexByExercise(history);

  // how many times this slot was trained -> every-third rotation (flexora, flexora, stiff)
  const slotOccurrence = Math.floor(pos / CYCLE.length) * 2 + (step.variant === 'B' ? 1 : 0);

  // hidden = removed from THIS workout only. Permanent removal is a program edit
  // ('remove'), already applied inside programFor
  const hidden = new Set(opts.hidden || []);
  const programItems = programFor(step.slot, step.variant, slotOccurrence, state.programEdits || [])
    .filter((it) => !hidden.has(it.key));

  // fuzzy matching may never land on an id that another card of the day declares
  const reserved = declaredIds(programItems);
  const items = programItems.map((item) => {
    const found = resolveHistory(index, item, reserved);
    const base = found ?? { id: exactId(item.name), name: item.name, group: step.slot, sessions: [] };
    return { item, found, base, main: prescribeItem({ base, found, item, step, history, opts }) };
  });

  const dayIds = new Set(items.map((r) => r.main.exerciseId));

  // item.alts -> fixed list, always shown (even with no history). No alts -> up to
  // MAX_VARIANTS suggestions from history. opts.extraAlts -> one-off swaps picked
  // in the app for today, added on top.
  const NO_VARY_PART = new Set(['Core', 'Mobilidade', 'Cardio']);
  const MAX_DECLARED_ALTS = 8;
  const extraAlts = opts.extraAlts || {};
  const exercises = items.map(({ item, found, main }) => {
    const seen = new Set([main.exerciseId]);

    // exact id, never fuzzy: a declared alternative points at ONE exercise. Fuzzy
    // matching sent "Agachamento Livre Tradicional" to Frontal (same words) and one
    // of the two vanished in the dedupe below
    const declared = (a, custom = false) => {
      const af = index.get(a.histId || exactId(typeof a.hist === 'string' ? a.hist : a.name)) || null;
      const abase = af ?? { id: exactId(a.name), name: a.name, group: step.slot, sessions: [] };
      const v = prescribeItem({
        base: abase, found: af,

        item: { name: a.name, part: item.part, alert: a.alert ?? null, note: a.note ?? null,
          bodyweight: !!a.bodyweight, logStyle: item.logStyle, cardio: item.cardio,
          main: a.main ? item.main : undefined },
        step, history, opts, isVariant: true,
      });
      if (seen.has(v.exerciseId)) return null;
      seen.add(v.exerciseId);
      return custom ? { ...v, custom: true } : v;
    };

    let variants = [];
    if (Array.isArray(item.alts) && item.alts.length) {
      variants = item.alts.slice(0, MAX_DECLARED_ALTS).map((a) => declared(a)).filter(Boolean);
    } else {
      const canVary = !item.daily && !item.cardio && !item.logStyle && !NO_VARY_PART.has(item.part);
      if (canVary) {
        variants = similarFromHistory(index, item, found, step, dayIds).map((entry) =>
          prescribeItem({
            base: entry, found: entry,
            item: { name: entry.name, part: item.part },
            step, history, opts, isVariant: true,
          }));
        variants.forEach((v) => seen.add(v.exerciseId));
      }
    }
    for (const a of extraAlts[item.key] || []) {
      const v = declared(a, true);
      if (v) variants.push(v);
    }
    return {
      ...main,
      key: item.key,
      only: item.only ?? null,
      replacedFrom: item.replacedFrom ?? null,
      editId: item.editId ?? null,
      variants,
    };
  });

  // "+" button extras for today only, appended at the end
  const already = new Set(exercises.map((e) => e.exerciseId));
  for (const x of opts.extras || []) {
    const af = index.get(x.histId || exactId(x.name)) || null;
    const abase = af ?? { id: exactId(x.name), name: x.name, group: step.slot, sessions: [] };
    const v = prescribeItem({ base: abase, found: af, item: { name: x.name, part: 'Extra' }, step, history, opts });
    if (already.has(v.exerciseId)) continue;
    already.add(v.exerciseId);
    exercises.push({ ...v, key: `extra:${v.exerciseId}`, only: null, replacedFrom: null,
      editId: null, variants: [], extra: true });
  }

  return {
    position: pos,
    slot: step.slot,
    variant: step.variant,
    title: `${SLOT_LABEL[step.slot]} ${step.variant}`,
    subtitle: VARIANT_LABEL[step.variant],
    exercises,
    empty: exercises.length === 0,
  };
}

// cues for a whole family of exercises: any pulldown variation, machines included,
// gets the range-of-motion reminder. A note in the program always wins.
const AUTO_NOTES = [
  [/puxada/i, 'Amplitude 100%: puxe até quase encostar no peito — mesmo que tenha que baixar a carga.'],
];

function autoNote(name) {
  for (const [re, txt] of AUTO_NOTES) if (re.test(String(name || ''))) return txt;
  return null;
}

function prescribeItem({ base, found, item, step, history, opts, isVariant = false }) {
  const p = prescribe(base, step.variant, {
    referenceDate: opts.referenceDate,
    repRange: item.repRange?.[step.variant],
  });

  // no target load for bodyweight/cardio/timed sets, even when the history has a
  // number (assisted pull-up machine, etc.)
  const noLoad = !!item.bodyweight || !!item.cardio || !!item.logStyle;

  // set count and where drops/rest-pause go come from this exercise's history, the
  // program can only nudge it (setsDelta) or pin it (fixedSets)
  const plannedSets = plannedSetCount(history, base.id, item, step.variant);
  const pattern = found ? techniquePattern(history, found.id) : { byPosition: new Map(), sampled: 0 };
  const techniques = withForcedTechniques(techniquePlan(pattern, plannedSets), item, plannedSets);

  if (item.main) {
    const plan = mainLiftPlan(found, step.variant, item.main.test);
    return {
      ...p,
      name: item.name,
      part: item.part,
      note: item.note ?? autoNote(item.name),
      alt: null,
      cardio: false,
      highRep: false,
      alert: item.alert ?? null,
      logStyle: null,
      daily: false,
      bodyweight: false,
      capped: false,
      oneRM: plan.oneRM,
      stale: false,
      matchedAs: found ? found.name : null,
      noHistory: !found,
      isVariant,
      histSamples: found ? found.sessions.length : 0,
      techniques: [],
      mainPlan: plan,
      ...planFields(plan.normal),
    };
  }

  return {
    ...p,
    name: item.name,
    part: item.part,
    note: item.note ?? autoNote(item.name),
    alt: item.alt ?? null,
    cardio: !!item.cardio,
    highRep: !!item.highRep,
    alert: item.alert ?? null,
    logStyle: item.logStyle ?? null,
    daily: !!item.daily,
    targetLoad: noLoad ? null : p.targetLoad,
    bodyweight: noLoad || p.bodyweight,
    matchedAs: found ? found.name : null,
    noHistory: !found,
    isVariant,
    histSamples: found ? found.sessions.length : 0,
    plannedSets,
    techniques,
  };
}

export function planFields(plan) {
  const first = plan.work[0];
  return {
    activePlan: plan,
    plannedSets: plan.work.length,
    targetLoad: first?.load ?? null,
    repRange: [first?.reps ?? 5, first?.reps ?? 5],
  };
}

// "movement" words that are really just equipment and match anything ('barra'
// linked Tríceps Barra to Barra Fixa). Only used when the name has nothing else.
const GENERIC_MOVES = new Set(['barra', 'fixa', 'leg', 'press']);

function similarFromHistory(index, item, found, step, dayIds = new Set()) {
  const want = normalizeExercise(
    typeof item.hist === 'string' ? item.hist : item.name
  );
  const wantMoves = movementsOf(want.words);
  if (wantMoves.size === 0) return [];

  const primary = want.words.find((w) => wantMoves.has(w) && !GENERIC_MOVES.has(w))
    ?? want.words.find((w) => wantMoves.has(w));

  const skip = new Set([want.id, found?.id, ...dayIds].filter(Boolean));

  return [...index.values()]
    .filter((e) => !skip.has(e.id) && e.group === step.slot)
    .map((e) => {
      const moves = movementsOf(normalizeExercise(e.name).words);
      const shared = [...wantMoves].filter((m) => moves.has(m)).length;
      const dates = e.sessions.map((s) => s.date).filter(Boolean).sort();
      return { e, hasPrimary: moves.has(primary), shared, samples: e.sessions.length, last: dates[dates.length - 1] || '' };
    })
    .filter((c) => c.hasPrimary && c.samples >= MIN_VARIANT_SESSIONS)
    .sort((a, b) => b.shared - a.shared || b.samples - a.samples || b.last.localeCompare(a.last))
    .slice(0, MAX_VARIANTS)
    .map((c) => c.e);
}

// "Barra Fixa Pegada Aberta" must find "Barra Fixa Aberta" (3 of 4 words) but not
// anything that just has "barra" in it
const MIN_MATCH = 0.5;

function plannedSetCount(history, exerciseId, item, variant) {
  if (item.fixedSets) return item.fixedSets;
  const base = typicalSetCount(history, exerciseId) || DEFAULT_SETS;
  const d = item.setsDelta;
  const delta = (d && typeof d === 'object') ? (d[variant] ?? 0) : (d ?? 0);
  return Math.max(1, base + delta);
}

function withForcedTechniques(plan, item, totalSets) {
  if (!item.forceTechniques?.length) return plan;
  let out = plan;
  for (const f of item.forceTechniques) {
    const idx = f.pos < 0 ? totalSets + f.pos : f.pos;
    if (idx < 0 || idx >= totalSets) continue;
    out = out.filter((t) => t.setIndex !== idx).concat({ setIndex: idx, type: f.type, frequency: 1 });
  }
  return out.sort((a, b) => a.setIndex - b.setIndex);
}

// median of the last 8 so one odd day doesn't move it
function typicalSetCount(sessions, exerciseId) {
  const counts = [];
  for (const s of sessions || []) {
    for (const e of s.exercises || []) {
      if (e.id === exerciseId && (e.sets || []).length) counts.push(e.sets.length);
    }
  }
  if (counts.length === 0) return null;
  const recent = counts.slice(-8).sort((a, b) => a - b);
  return recent[Math.floor(recent.length / 2)];
}

// hist: null -> new exercise, its own name by exact id only (a new name must never
// borrow someone else's history). string -> that exact target. absent -> fuzzy.
function resolveHistory(index, item, reserved = new Set()) {
  if (item.histId) return index.get(item.histId) || null;

  if (item.hist === null) return index.get(exactId(item.name)) || null;
  if (typeof item.hist === 'string') {
    // exactId applies the aliases, so a target declared with an old name
    // ("Serrote Unilateral") still finds the merged history
    const byId = index.get(exactId(item.hist));
    if (byId || item.histExact) return byId || null;
  }

  // Fuzzy, but never onto an exercise this program declares on another card. That's
  // how "Agachamento Livre Tradicional" ended up writing into Frontal's id.
  const own = ownIds(item);
  const avoid = new Set([...reserved].filter((id) => !own.has(id)));
  return findInHistory(index, { match: item.hist ?? item.name, alt: item.alt, avoid });
}

function ownIds(item) {
  const ids = new Set([exactId(item.name)]);
  if (typeof item.hist === 'string') ids.add(exactId(item.hist));
  if (item.histId) ids.add(item.histId);
  return ids;
}

function declaredIds(items) {
  const ids = new Set();
  for (const item of items || []) {
    for (const id of ownIds(item)) ids.add(id);
    for (const a of item.alts || []) {
      ids.add(exactId(a.name));
      if (typeof a.hist === 'string') ids.add(exactId(a.hist));
      if (a.histId) ids.add(a.histId);
    }
  }
  return ids;
}

export function exactId(name) {
  return canonicalId(normalizeExercise(name).id);
}

export function exerciseCatalog(sessions) {
  return [...indexByExercise(sessions || []).values()]
    .map((e) => {
      const dates = e.sessions.map((s) => s.date).filter(Boolean).sort();
      return { id: e.id, name: e.name, group: e.group, samples: e.sessions.length, last: dates[dates.length - 1] || null };
    })
    .sort((a, b) => b.samples - a.samples);
}

export function identifyName(name, catalog) {
  const n = normalizeExercise(name);
  if (!n.isExercise) return { valid: false };
  const id = canonicalId(n.id);
  const existing = catalog.find((c) => c.id === id) || null;
  if (existing) return { valid: true, id, existing, similar: [] };

  const want = new Set(n.words);
  const wantMoves = movementsOf(n.words);
  const similar = catalog
    .map((c) => {
      const words = normalizeExercise(c.name).words;
      const common = words.filter((w) => want.has(w)).length;
      const moveOk = wantMoves.size === 0 || words.some((w) => wantMoves.has(w));
      return { c, score: moveOk ? common / Math.max(want.size, words.length) : 0 };
    })
    .filter((x) => x.score >= 0.5)
    .sort((a, b) => b.score - a.score || b.c.samples - a.c.samples)
    .slice(0, 3)
    .map((x) => x.c);
  return { valid: true, id, existing: null, similar };
}

function findInHistory(index, item) {
  const want = normalizeExercise(item.match);
  const direct = index.get(want.id);
  if (direct) return direct;

  const wanted = want.words;
  if (wanted.length === 0) return null;

  // the movement has to match or volume weighting sends "Remada Alta" to "Puxada
  // Alta" just because that one has 108 sets and both end the same
  const wantMoves = movementsOf(wanted);

  const scored = [...index.values()]
    .map((e) => {
      const norm = normalizeExercise(e.name);
      const words = new Set(norm.words);
      const moves = movementsOf(norm.words);
      const movesOk = wantMoves.size === 0 || [...wantMoves].some((m) => moves.has(m));
      const ok = movesOk && !contradicts(wanted, words);
      const hits = wanted.filter((w) => words.has(w)).length;
      const coverage = ok ? hits / wanted.length : 0;

      // "Supino" shouldn't match "Supino Inclinado Halter Bem Alto"
      const excess = Math.max(0, words.size - wanted.length) / (wanted.length + 2);

      // volume weighs a lot on purpose: a variation logged 3 times a year ago can't
      // beat the main machine with 72 sets for sharing one extra word
      const volume = Math.min(1, e.sessions.length / 20);
      return { e, coverage, score: coverage - excess * 0.35 + volume * 0.6 };
    })
    .filter((c) => c.coverage >= MIN_MATCH && !item.avoid?.has(c.e.id))
    .sort((a, b) => b.score - a.score);

  if (scored.length) return scored[0].e;

  if (item.alt) return findInHistory(index, { match: item.alt, avoid: item.avoid });
  return null;
}

export function upcoming(state, n = 6, opts = {}) {
  const pos = state.cyclePosition || 0;
  return Array.from({ length: n }, (_, i) => {
    const step = CYCLE[(pos + i) % CYCLE.length];
    return {
      position: pos + i,
      slot: step.slot,
      variant: step.variant,
      title: `${SLOT_LABEL[step.slot]} ${step.variant}`,
      subtitle: VARIANT_LABEL[step.variant],
      isNext: i === 0,
    };
  });
}

export function inferStartPosition(sessions) {
  const dated = (sessions || []).filter((s) => s.date).sort((a, b) => a.date.localeCompare(b.date));
  const last = dated[dated.length - 1];
  if (!last) return 0;

  const slot = classifySession(last);
  if (!slot) return 0;

  // imported sessions don't say A/B, assume A. Exact once workouts are logged in the app
  const variant = last.variant || 'A';
  const idx = CYCLE.findIndex((c) => c.slot === slot && c.variant === variant);
  return idx >= 0 ? idx + 1 : 0;
}

// The program is the source of truth for WHAT to train and in which order; the
// history only supplies the loads.
//
// Optional fields besides name/part/hist:
//   alert           amber banner on the card (form, safety)
//   note            small cue under the name
//   setsDelta       +/- sets vs what the history usually has, number or { A, B }
//   fixedSets       ignore the history, always this many
//   forceTechniques e.g. [{ pos: -1, type: 'drop' }]
//   logStyle        'minutes' | 'seconds' | 'reps', single field, no load
//   bodyweight      no target load, progress by volume
//   alts            fixed swap options shown in the card's picker
//
// name and hist stay Portuguese, they're matched against the notebook. js/names.js
// turns them into English for the screen.
//
// hist: string -> exact name in the imported history, null -> new exercise (finds
// history only under its own name), absent -> fuzzy match. Declared matches exist
// because fuzzy matching gets it wrong exactly where it matters: "Remada Alta"
// (traps) landed on "Remada Curvada".

import { slug } from './normalize.js';

// same alternatives for both triceps slots
const TRICEPS_ALTS = [
  { name: 'Tríceps Paralela Máquina Amarela', hist: 'Paralela Máquina Amarela' },
  { name: 'Tríceps Paralela',                 hist: 'Paralela' },
  { name: 'Tríceps Paralela Polia',           hist: null },
  { name: 'Scott Invertido',                  hist: null },
];

export const PROGRAM = {
  push: {
    label: 'Push',
    exercises: [
      // main lift opens both days: A = 3×3 @ 85%, B = 4×5 @ 75%
      { part: 'Main lift', name: 'Supino Reto Barra', hist: 'Supino Reto Barra',
        main: { test: 'real' },
        alts: [{ name: 'Supino Reto Barra com Cotoveleira', hist: null, main: true }] },

      // the "com Cotoveleira" (elbow sleeves) versions keep their own history, the sleeves
      // change what can be pressed and mixing them would skew both 1RMs
      { part: 'Chest',    name: 'Supino Inclinado Barra', hist: 'Supino Inclinado Barra',
        repRange: { B: [5, 8] },
        alts: [
          { name: 'Supino Inclinado Barra com Cotoveleira',   hist: null },
          { name: 'Supino Inclinado Halter',                  hist: 'Supino Inclinado Halter' },
          { name: 'Supino Inclinado Máquina',                 hist: 'Supino Inclinado Máquina' },
          { name: 'Supino Inclinado Máquina com Cotoveleira', hist: null },
        ] },

      { part: 'Chest',    name: 'Crossover Peito Superior', hist: 'Crossover Baixa Cima', only: 'A' },

      { part: 'Chest',    name: 'Voador',                          hist: 'Voador',
        alts: [{ name: 'Crossover Medial', hist: 'Crossover Medial' }] },

      // one shoulder exercise a day: lateral raise on A, press on B
      { part: 'Shoulders', name: 'Elevação Lateral Máquina Sentado', hist: 'Elevação Lateral Máquina Sentado',
        only: 'A', alert: 'Slow and controlled' },
      { part: 'Shoulders', name: 'Desenvolvimento Máquina Amarela', hist: 'Desenvolvimento Máquina Amarela',
        only: 'B' },

      { part: 'Traps', name: 'Remada Alta', hist: null },

      // weighted version has its own history, reps with a plate don't compare with bodyweight reps
      { part: 'Core', name: 'Abdômen Inferior (Elevação de Pernas)',
        hist: 'Elevação Abdominal Inferior', bodyweight: true,
        alts: [{ name: 'Abdômen Inferior (Elevação de Pernas) com Carga', hist: null }] },
      { part: 'Core', name: 'Abdômen Superior Máquina Vermelha',
        hist: 'Abdominal Máquina Superior',
        alts: [{ name: 'Abdômen Superior no Chão', hist: null, bodyweight: true }] },
    ],
  },

  pull: {
    label: 'Pull',
    exercises: [
      // no 1RM test on deadlift until technique is automatic, estimated only
      { part: 'Main lift', name: 'Levantamento Terra', hist: null,
        main: { test: 'estimated' },
        alert: 'Neutral spine, bar against the legs. If the lower back rounds, the set is over' },

      // one vertical pull a day right after the deadlift: pulldown on A, pull-ups on B.
      // Only one passes the variant filter, so it stays the first exercise after the lift
      { part: 'Lats', name: 'Puxada Alta', hist: 'Puxada Alta', only: 'A' },
      {
        part: 'Lats', name: 'Barra Fixa (Pegada Aberta)', hist: 'Barra Fixa Aberta Fechada',
        only: 'B', bodyweight: true, setsDelta: -1,
        note: 'baby reps, no rest, last set close grip',
      },

      // pull-ups have no target load, so on Pull B the heavy block is the dumbbell row
      { part: 'Back', name: 'Serrote Unilateral com Halter', hist: 'Serrote Unilateral',
        repRange: { B: [5, 8] }, setsDelta: { B: -1 } },
      { part: 'Back', name: 'Remada Cavalo Peito no Banco',  hist: 'Remada Cavalo Peito Banco' },
      { part: 'Rear delts', name: 'Peck Deck Invertido',      hist: 'Voador Invertido', alt: 'Y-Raise',
        alts: [
          { name: 'Y Raise',                    hist: 'Y Raise' },
          { name: 'Crucifixo Reverso no Banco', hist: 'Posterior Ombro Halter Peito Banco' },
        ] },

      { part: 'Rear delts', name: 'Face Pull', hist: null, only: 'B', fixedSets: 3 },
      { part: 'Triceps', name: 'Tríceps Francês Sentado Halter', hist: 'Tríceps Francês Halter Sentado',
        alts: TRICEPS_ALTS },
      { part: 'Triceps', name: 'Tríceps Barra Reta',             hist: 'Tríceps Barra Reta',
        alts: TRICEPS_ALTS },
      { part: 'Cardio',  name: 'Escada ou Esteira', hist: null, cardio: true,
        logStyle: 'minutes', fixedSets: 1, note: 'log the minutes only' },
    ],
  },

  legs: {
    label: 'Legs',
    exercises: [
      // histExact is required here: fuzzy matching sent Tradicional to "Agachamento
      // Livre Frontal" (2 of 3 words) and the card said Tradicional while the sets
      // were stored under Frontal's id
      { part: 'Main lift', name: 'Agachamento Livre Tradicional', hist: 'Agachamento Livre Tradicional',
        histExact: true,
        main: { test: 'estimated' },
        alert: 'Very wide grip · plate on the floor, just one step back' },

      { part: 'Quads', name: 'Agachamento Hack',   hist: 'Agachamento Hack',
        repRange: { B: [5, 8] }, setsDelta: -1, alert: 'Slow and controlled',
        alts: [
          { name: 'Agachamento Livre Frontal', hist: 'Agachamento Livre Frontal',
            alert: 'Olympic grip (2 fingers) · plate on the floor, just one step back' },
        ] },

      { part: 'Quads', name: 'Agachamento Pêndulo', hist: 'Agachamento Pêndulo', only: 'B' },

      // knee isolation: heavy low reps just beat up the joint, 8-10 on both days
      { part: 'Quads', name: 'Cadeira Extensora', hist: 'Extensora',
        repRange: { A: [8, 10], B: [8, 10] },
        note: 'drive straight up, no arc' },

      // every third leg day swaps leg curl for stiff-legged deadlift
      { part: 'Hamstrings', name: 'Cadeira Flexora', hist: 'Flexora', unlessEveryThird: true,
        note: 'pin on the last notch, the lowest one' },
      { part: 'Hamstrings', name: 'Stiff',           hist: 'Stiff',   onlyEveryThird: true },

      { part: 'Calves', name: 'Panturrilha Máquina', hist: 'Panturrilha',
        setsDelta: 2, forceTechniques: [{ pos: -1, type: 'drop' }],
        alert: "Don't drop the weight on the way down, lower the load if needed." },

      { part: 'Glutes', name: 'Elevação Pélvica', hist: null },

      // extra abs on Legs B only
      { part: 'Core', name: 'Abdômen Superior Máquina Vermelha', hist: 'Abdominal Máquina Superior',
        only: 'B', fixedSets: 4,
        note: 'short straight crunch: ribs toward the hips, no twisting or leaning (more rectus, less obliques)',
        alts: [{ name: 'Abdômen Superior no Chão', hist: null, bodyweight: true }] },
    ],
  },
};

// closes EVERY workout: deep core + hip mobility. Timed sets, no A/B, no history
export const DAILY = [
  {
    part: 'Core', name: 'Vácuo Abdominal', hist: null, daily: true,
    logStyle: 'minutes', fixedSets: 1, note: '5 minutes in the morning, before eating',
  },
  {
    part: 'Mobility', name: 'Alongamento de Flexor de Quadril', hist: null, daily: true,
    logStyle: 'seconds', fixedSets: 2, note: '60–90s each side, 2x',
  },
  { part: 'Core', name: 'Dead Bug',    hist: null, daily: true, logStyle: 'reps',    fixedSets: 2 },
  { part: 'Core', name: 'Hollow Hold', hist: null, daily: true, logStyle: 'seconds', fixedSets: 2 },
];

// stable key for a slot in the program: block + ORIGINAL name. Edits point here,
// so swapping A->B and then B->C still targets the same place
export function itemKey(scope, name) {
  return `${scope}:${slug(name)}`;
}

// fields that belong to the SLOT and stay with the replacement; the rest (alerts,
// notes, alts) belong to the old exercise
const SLOT_FIELDS = ['part', 'main', 'only', 'onlyEveryThird', 'unlessEveryThird', 'repRange',
  'setsDelta', 'fixedSets', 'forceTechniques', 'logStyle', 'cardio', 'daily'];

export function activeEditFor(key, variant, edits) {
  let best = null;
  for (const e of edits || []) {
    if (e.undone || e.target !== key) continue;
    if (e.variant && e.variant !== variant) continue;
    if (!best || String(e.createdAt) > String(best.createdAt)) best = e;
  }
  return best;
}

// never touches history, only decides what shows up today. The replaced exercise
// stays available as an alternative
function applyEdits(item, scope, variant, edits) {
  const key = itemKey(scope, item.name);
  const edit = activeEditFor(key, variant, edits);
  if (!edit) return { ...item, key };
  if (edit.action === 'remove') return null;

  const out = { key, name: edit.name, histId: edit.histId ?? null, hist: null,
    histExact: true, replacedFrom: item.name, editId: edit.id };
  for (const f of SLOT_FIELDS) if (item[f] !== undefined) out[f] = item[f];
  const old = { name: item.name, hist: item.hist, alert: item.alert, note: item.note, bodyweight: item.bodyweight };
  out.alts = [old, ...(item.alts || [])].filter((a) => slug(a.name) !== slug(out.name));
  return out;
}

export function programFor(slot, variant, slotOccurrence = 0, edits = []) {
  const block = PROGRAM[slot];
  if (!block) return [];

  const isEveryThird = slotOccurrence % 3 === 2;

  const main = block.exercises.filter((e) => {
    if (e.only && e.only !== variant) return false;
    if (e.onlyEveryThird && !isEveryThird) return false;
    if (e.unlessEveryThird && isEveryThird) return false;
    return true;
  }).map((e) => applyEdits(e, slot, variant, edits)).filter(Boolean);

  const daily = DAILY.map((e) => applyEdits(e, 'daily', variant, edits)).filter(Boolean);
  return [...main, ...addedItems(slot, variant, edits), ...daily];
}

// exercises added for good through the "+" button, after the official ones and
// before the daily routine
function addedItems(slot, variant, edits) {
  const out = [];
  for (const e of edits || []) {
    if (e.undone || e.action !== 'add' || e.slot !== slot) continue;
    if (e.variant && e.variant !== variant) continue;
    const later = activeEditFor(e.target, variant, edits);
    if (later && later.action === 'remove') continue;
    const name = later && later.action === 'replace' ? later.name : e.name;
    const histId = (later && later.action === 'replace' ? later.histId : e.histId) ?? null;
    out.push({ key: e.target, part: e.part || 'Extra', name, histId, hist: null,
      histExact: true, addedEditId: e.id });
  }
  return out;
}

// Parser for the workout log I keep in iPhone Notes. The format drifted over the
// year and all of it still has to parse:
//
//   recent (most of it)          old (wordy)
//   30kg 10                      12 reps 80kg primeira serie de trabalho
//   30kg  8 Drop 20kg 10         Top set 104kg 100% 11 reps
//   14                           Trabalho 12kg - 8 reps 90%
//   Sem peso 10                  3 placas 10 com dropset
//   7 e 3                        20kg cada lado 17 reps
//
// No fixed format: each line gets tokenized, numbers with units first (kg, placa,
// reps, %), then unit-less numbers fill whatever is missing. Anything that can't
// be read ends up in `warnings` instead of disappearing.

import { normalizeExercise } from './normalize.js';
import { canonicalId, canonicalName, isExcluded } from './curation.js';

const DATE_RE = /^(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?\.?$/;
const WEEKDAY_RE = /^(segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo)(\s*-?\s*feira)?\.?$/i;

const HEADER_RE = /^(cargas?\b.*|peito|costas|dorsais|pernas|ombros?|bra[cç]os?|zzz+|treino\s+[a-z])$/i;

const KG_RE     = /(\d+(?:[.,]\d+)?)\s*k(?:g|gs)?\b/gi;
const PLACA_RE  = /(\d+(?:[.,]\d+)?)\s*placas?\b/gi;
const REPS_RE   = /(\d+)\s*(?:reps?|rep|repeti[cç][õo]es)\b/gi;
const PCT_RE    = /(\d+(?:[.,]\d+)?)\s*%/g;  // 90% is effort, not load

// "Drop 20kg 10" · "drop 7" · "rest 5" · "mais 5 rest pause" · "com dropset"
const TECHNIQUE_RE =
  /\b(drop\s*set|dropset|drops?|rest\s*pause|rest|mais)\b\s*(?:(\d+(?:[.,]\d+)?)\s*kg\s*)?(\d+)?/gi;

const BODYWEIGHT_RE = /\b(sem\s*peso|s\/\s*peso|livre|corporal|só\s*o?\s*corpo)\b/i;

const PER_SIDE_RE = /\b(cada\s*lado|casa\s*laso|c\/\s*lado|por\s*lado|unilat)/i;  // load is per side. "casa laso" = autocorrect

const SUBSETS_RE = /^(\d+)\s*(?:e|\+|\/)\s*(\d+)\s*$/i;  // "7 e 3": wide + close grip pull-ups in one set

const BARE_SERIES_RE = /^(\d+)\s*s[ée]ries?\b/i;

const num = (s) => parseFloat(String(s).replace(',', '.'));

function fixTypos(line) {
  return line
    .replace(/(\d)\s*(eeps|rrps|reeps|repss)\b/gi, '$1 reps')
    .replace(/(\d)(reps?)\b/gi, '$1 $2')
    .replace(/casa\s*laso/gi, 'cada lado')
    .replace(/\bdeop\s*set/gi, 'drop set')
    .replace(/\bdrops\s*set/gi, 'drop set')
    .replace(/\bprim\b/gi, 'primeira')
    .replace(/\btrab\b/gi, 'trabalho')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseHistory(text, opts = {}) {
  const defaultYear = opts.defaultYear ?? new Date().getFullYear();
  const lines = String(text || '').split(/\r?\n/);

  const sessions = [];
  const warnings = [];

  // years get resolved in a separate pass over every date. Doing it left to right
  // let a single typo push the rest of the file a year ahead
  const dateMap = resolveYears(lines, defaultYear, warnings);

  let session = null;
  let exercise = null;

  const flushExercise = () => {
    if (exercise && exercise.sets.length > 0) session.exercises.push(exercise);
    exercise = null;
  };

  const flushSession = () => {
    flushExercise();
    if (session && session.exercises.length > 0) sessions.push(session);
    session = null;
  };

  const ensureSession = (lineNo) => {
    if (!session) session = { date: null, exercises: [], lineNo, undated: true };
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const lineNo = i + 1;
    const line = fixTypos(rawLine);

    if (!line) continue;

    if (dateMap.has(lineNo)) {
      flushSession();
      session = { date: dateMap.get(lineNo), exercises: [], lineNo };
      continue;
    }

    if (WEEKDAY_RE.test(line)) {
      flushSession();
      session = { date: null, exercises: [], lineNo, undated: true, weekday: line.toLowerCase() };
      continue;
    }

    if (HEADER_RE.test(line)) { flushExercise(); continue; }

    const parsed = parseSetLine(line);

    if (parsed.isSet) {
      ensureSession(lineNo);
      if (!exercise) {
        // a note or block header flushed the exercise but the sets keep coming:
        // same exercise, reopen it
        const prev = session.exercises[session.exercises.length - 1];
        if (prev) { exercise = session.exercises.pop(); }
        else {
          warnings.push({ line: lineNo, text: rawLine.trim(), reason: 'série sem exercício acima' });
          continue;
        }
      }
      exercise.sets.push(...parsed.sets);
      continue;
    }

    const norm = normalizeExercise(parsed.name ?? line);
    if (!norm.isExercise) { flushExercise(); continue; }

    ensureSession(lineNo);
    flushExercise();
    const id = canonicalId(norm.id);
    exercise = {
      id,
      name: canonicalName(id, norm.name),
      group: norm.group,
      raw: rawLine.trim(),
      sets: [],
      lineNo,
    };
  }

  flushSession();

  return { sessions, warnings, stats: buildStats(sessions) };
}

function parseSetLine(line) {
  const lower = line.toLowerCase();

  const sub = line.match(SUBSETS_RE);
  if (sub) {
    return {
      isSet: true,
      sets: [
        { load: 0, reps: parseInt(sub[1], 10), bodyweight: true, note: `${sub[1]} e ${sub[2]}` },
        { load: 0, reps: parseInt(sub[2], 10), bodyweight: true, note: `${sub[1]} e ${sub[2]}` },
      ],
    };
  }

  const bare = line.match(BARE_SERIES_RE);
  if (bare) {
    const n = parseInt(bare[1], 10);
    return { isSet: true, sets: Array.from({ length: n }, () => ({ load: 0, reps: null, unlogged: true })) };
  }

  const t = tokenize(line);

  if (t.numbers.length === 0) return { isSet: false };

  const hasUnit = t.kg.length > 0 || t.placa.length > 0 || t.reps.length > 0 || t.pct.length > 0;
  const words = t.words;

  // no unit + 3 words or more: a name with a number in it ("Graviton 45 graus")
  if (!hasUnit && words >= 3) return { isSet: false };

  if (!hasUnit && words === 0) {
    return { isSet: true, sets: t.numbers.map((n) => ({ load: 0, reps: n, bodyweight: true })) };
  }

  if (BODYWEIGHT_RE.test(lower)) {
    const reps = t.reps[0] ?? t.loose[0] ?? null;
    if (reps == null) return { isSet: false };
    return { isSet: true, sets: [{ load: 0, reps, bodyweight: true }] };
  }

  if (!hasUnit && words > 0 && words < 3) {
    return { isSet: true, sets: [{ load: 0, reps: t.numbers[0], bodyweight: true }] };
  }

  let load = t.kg[0] ?? null;
  let placas = t.placa[0] ?? null;
  let reps = t.reps[0] ?? null;

  // recent format "30kg 10" -> the loose number is reps; old "55 - 5 reps 90%" -> it's the load
  const loose = [...t.loose];
  if (reps == null && loose.length) reps = loose.shift();
  if (load == null && placas == null && loose.length) load = loose.shift();

  if (load == null && placas == null && reps == null) return { isSet: false };

  const set = {
    load: load ?? 0,
    reps: reps ?? null,
    bodyweight: load == null && placas == null,
  };

  if (placas != null) { set.placas = placas; set.load = 0; set.bodyweight = false; }
  if (t.pct.length) set.effortPct = t.pct[0];
  if (PER_SIDE_RE.test(lower)) set.perSide = true;
  if (/top\s*set/i.test(lower)) set.topSet = true;

  const techniques = extractTechniques(line);
  if (techniques.length) set.techniques = techniques;

  return { isSet: true, sets: [set] };
}

function tokenize(line) {
  const kg = [], placa = [], reps = [], pct = [];
  let rest = line;

  const take = (re, out) => {
    rest = rest.replace(re, (m, g1) => { out.push(num(g1)); return ' '.repeat(m.length); });
  };

  // order matters: % first or "90%" turns into a load
  take(new RegExp(PCT_RE.source, 'g'), pct);
  take(new RegExp(REPS_RE.source, 'gi'), reps);
  take(new RegExp(PLACA_RE.source, 'gi'), placa);
  take(new RegExp(KG_RE.source, 'gi'), kg);

  rest = rest.replace(new RegExp(TECHNIQUE_RE.source, 'gi'), ' ');

  const loose = [...rest.matchAll(/\b(\d+(?:[.,]\d+)?)\b/g)].map((m) => num(m[1]));
  const words = (line.match(/[a-zà-ÿ]{2,}/gi) || [])
    .filter((w) => !/^(kg|reps?|placas?|top|set|drop|rest|pause|mais|com|de|do|da|e|serie|series|trabalho|primeira|segunda|ultima|ultimas)$/i.test(w))
    .length;

  return { kg, placa, reps, pct, loose, words, numbers: [...kg, ...placa, ...reps, ...loose] };
}

function extractTechniques(line) {
  const out = [];
  const re = new RegExp(TECHNIQUE_RE.source, 'gi');
  let m;
  while ((m = re.exec(line)) !== null) {
    const kind = /drop/i.test(m[1]) ? 'drop' : /rest/i.test(m[1]) ? 'rest-pause' : 'extra';
    if (m[2] == null && m[3] == null) { out.push({ type: kind }); continue; }
    out.push({ type: kind, load: m[2] != null ? num(m[2]) : null, reps: m[3] != null ? parseInt(m[3], 10) : null });
  }
  return out;
}

function normalizeYear(y) {
  const n = parseInt(y, 10);
  return n < 100 ? 2000 + n : n;
}

// The notes only have day/month. Walk BACKWARDS from the last date (the most
// recent one, can't be in the future). A month going up only counts as a new
// year if the following dates agree, otherwise it's a typo like the "01/12"
// sitting in the middle of February.
function resolveYears(lines, defaultYear, warnings) {
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const m = fixTypos(lines[i]).match(DATE_RE);
    if (!m) continue;
    found.push({
      lineNo: i + 1,
      day: parseInt(m[1], 10),
      month: parseInt(m[2], 10),
      explicitYear: m[3] ? normalizeYear(m[3]) : null,
    });
  }
  if (found.length === 0) return new Map();

  const today = new Date();
  const last = found[found.length - 1];
  let year = last.explicitYear ?? today.getUTCFullYear();
  if (!last.explicitYear) {
    while (new Date(Date.UTC(year, last.month - 1, last.day)) > today) year--;
  }

  const out = new Map();
  for (let i = found.length - 1; i >= 0; i--) {
    const cur = found[i];

    if (cur.explicitYear != null) {
      year = cur.explicitYear;
    } else if (i < found.length - 1) {
      const next = found[i + 1];

      if (cur.month > next.month) {
        if (isYearBoundary(found, i)) year--;
        else {
          warnings.push({
            line: cur.lineNo,
            text: `${pad2(cur.day)}/${pad2(cur.month)}`,
            reason: 'mês fora da sequência — provável erro de digitação, ano mantido',
          });
        }
      }
    }
    out.set(cur.lineNo, isoDate(year, cur.month, cur.day));
    cur.year = year;
  }

  fixOutliers(found, out, warnings);
  return out;
}

// only touch the middle date when both neighbours are in order with each other,
// otherwise one bad date fixes everything after it into the wrong month
function fixOutliers(found, out, warnings) {
  for (let i = 1; i < found.length - 1; i++) {
    const prev = out.get(found[i - 1].lineNo);
    const cur = out.get(found[i].lineNo);
    const next = out.get(found[i + 1].lineNo);

    if (prev > next) continue;
    if (cur >= prev && cur <= next) continue;

    const fixed = [prev, next]
      .map((ref) => {
        const [y, m] = ref.split('-').map(Number);
        return isoDate(y, m, found[i].day);
      })
      .find((cand) => cand >= prev && cand <= next);

    if (!fixed) continue;

    warnings.push({
      line: found[i].lineNo,
      text: `${pad2(found[i].day)}/${pad2(found[i].month)}`,
      reason: `fora da ordem cronológica — lida como ${fixed}`,
    });
    out.set(found[i].lineNo, fixed);
  }
}

function isYearBoundary(found, i) {
  const cur = found[i];
  const after = found.slice(i + 1, i + 4).map((f) => f.month);
  const before = found.slice(Math.max(0, i - 3), i).map((f) => f.month);
  if (after.length === 0) return true;

  const beforeAgrees = before.length === 0 || before.some((m) => m >= cur.month - 1);

  const afterAgrees = after.every((m) => m < cur.month);
  return beforeAgrees && afterAgrees;
}

const pad2 = (n) => String(n).padStart(2, '0');

function isoDate(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.toISOString().slice(0, 10);
}

function buildStats(sessions) {
  const ids = new Set();
  let sets = 0, undated = 0;
  for (const s of sessions) {
    if (!s.date) undated++;
    for (const e of s.exercises) { ids.add(e.id); sets += e.sets.length; }
  }
  const dated = sessions.filter((s) => s.date).map((s) => s.date).sort();
  return {
    sessions: sessions.length,
    undated,
    exercises: ids.size,
    sets,
    firstDate: dated[0] ?? null,
    lastDate: dated[dated.length - 1] ?? null,
  };
}

export function indexByExercise(sessions) {
  const index = new Map();
  for (const s of sessions) {
    for (const e of s.exercises) {
      if (!index.has(e.id)) {
        index.set(e.id, { id: e.id, name: e.name, group: e.group, equipment: e.equipment, sessions: [] });
      }
      const entry = index.get(e.id);
      for (const set of e.sets) {
        if (set.reps == null) continue;

        // see EXCLUSIONS in curation.js
        if (isExcluded(e.id, set)) continue;
        entry.sessions.push({
          date: s.date,
          load: set.load,
          reps: set.reps,
          bodyweight: !!set.bodyweight,
          techniques: set.techniques,
        });
      }
    }
  }
  return index;
}

// Drop sets / rest-pause aren't used uniformly: in the log they show up almost
// always on the LAST set, sometimes the last two, and only on some exercises.
//
//   Desenvolvimento Máquina Amarela  30×11  30×8  30×8[drop]        -> last
//   Puxada Alta                      70×10  70×7[rest]  70×8[drop]  -> last two
//   Barra Fixa Fechada               70×10  70×10  70×10  70×11     -> none
//
// So instead of a fixed rule, read the habit from history: per exercise, how
// often each position (counted from the end) got a technique.

const LOOKBACK_SESSIONS = 8;
const MIN_FREQUENCY = 0.5; // below this it's occasional, not a habit
const POSITIONS = [-1, -2];

export function techniquePattern(sessions, exerciseId) {
  const occurrences = [];

  for (const s of sessions || []) {
    for (const e of s.exercises || []) {
      if (e.id !== exerciseId) continue;
      if ((e.sets || []).length === 0) continue;
      occurrences.push({ date: s.date, sets: e.sets });
    }
  }

  occurrences.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const recent = occurrences.slice(0, LOOKBACK_SESSIONS);
  const byPosition = new Map();

  if (recent.length === 0) return { byPosition, sampled: 0 };

  for (const pos of POSITIONS) {
    const counts = new Map(); // type -> sessions
    for (const occ of recent) {
      const idx = occ.sets.length + pos;
      if (idx < 0) continue;
      const set = occ.sets[idx];
      for (const t of set.techniques || []) {
        counts.set(t.type, (counts.get(t.type) || 0) + 1);
      }
    }
    if (counts.size === 0) continue;

    const [type, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const frequency = n / recent.length;
    if (frequency >= MIN_FREQUENCY) {
      byPosition.set(pos, { type, frequency, sessions: n });
    }
  }

  return { byPosition, sampled: recent.length };
}

// setIndex is 0-based within today's sets for the exercise
export function techniquePlan(pattern, totalSets) {
  const out = [];
  for (const [pos, info] of pattern.byPosition) {
    const idx = totalSets + pos;
    if (idx >= 0) out.push({ setIndex: idx, type: info.type, frequency: info.frequency });
  }
  return out.sort((a, b) => a.setIndex - b.setIndex);
}

export const TECHNIQUE_TYPES = ['cluster', 'drop', 'rest-pause'];

export function techniqueLabel(type) {
  if (type === 'drop') return 'drop set';
  if (type === 'rest-pause') return 'rest-pause';
  if (type === 'cluster') return 'cluster set';
  return type;
}

export function techniqueHint(type) {
  if (type === 'cluster') return 'A série é quebrada em mini-blocos com pausas curtas (ex.: 3+3+3 com 15s).';
  if (type === 'drop') return 'Chegou na falha, tirou carga na hora e continuou.';
  if (type === 'rest-pause') return 'Falhou, descansou poucos segundos e completou mais repetições.';
  return '';
}

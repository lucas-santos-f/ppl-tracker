// Detecção do padrão de uso de drop set e rest-pause.
//
// As técnicas não são aplicadas de forma uniforme: no histórico elas aparecem
// quase sempre na ÚLTIMA série do exercício, às vezes nas duas últimas, e só
// em parte dos exercícios.
//
//   Desenvolvimento Máquina Amarela  30×11  30×8  30×8[drop]     → última
//   Puxada Alta                      70×10  70×7[rest]  70×8[drop] → duas últimas
//   Barra Fixa Fechada               70×10  70×10  70×10  70×11   → nenhuma
//
// Em vez de impor uma regra, o padrão é lido do próprio histórico: para cada
// exercício, com que frequência cada posição (contada do fim) recebeu técnica,
// e qual técnica. Só vira prescrição o que se repete na maioria das vezes.

// Sessões recentes consultadas por exercício.
const LOOKBACK_SESSIONS = 8;

// Fração das sessões que precisa ter a técnica naquela posição para virar
// prescrição. Abaixo disso é eventual, não hábito.
const MIN_FREQUENCY = 0.5;

// Só as duas últimas séries entram na análise — é onde a técnica aparece.
const POSITIONS = [-1, -2];

/**
 * Lê o padrão de técnica de um exercício a partir das sessões em que ele
 * aparece.
 *
 * @param {Array<{date:string, exercises:Array}>} sessions histórico completo
 * @param {string} exerciseId
 * @returns {{byPosition: Map<number, {type:string, frequency:number, sessions:number}>, sampled:number}}
 */
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
    const counts = new Map(); // tipo → nº de sessões
    for (const occ of recent) {
      const idx = occ.sets.length + pos; // pos é negativo
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

/**
 * Traduz o padrão em instruções por série, dado quantas séries o dia terá.
 *
 * @returns {Array<{setIndex:number, type:string, frequency:number}>}
 *   setIndex é 0-based dentro do exercício do dia.
 */
export function techniquePlan(pattern, totalSets) {
  const out = [];
  for (const [pos, info] of pattern.byPosition) {
    const idx = totalSets + pos;
    if (idx >= 0) out.push({ setIndex: idx, type: info.type, frequency: info.frequency });
  }
  return out.sort((a, b) => a.setIndex - b.setIndex);
}

/** Rótulo curto para a interface. */
export function techniqueLabel(type) {
  return type === 'drop' ? 'drop set' : type === 'rest-pause' ? 'rest-pause' : type;
}

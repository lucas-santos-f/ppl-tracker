// Hand-made corrections on top of the imported notes. Some things no rule can
// figure out: only whoever trained knows "Rack Agachamento" and "Agachamento
// Hack" are the same machine, or that a 150kg triceps set was on a machine whose
// weight stack doesn't compare with anything else.

// id that goes away -> id that stays. Rule of thumb: point to the spelling with
// the most sets, the rare ones were typos.
export const ALIASES = {
  'agachamento-rack': 'agachamento-hack',
  'agachamento-alta-hack': 'agachamento-hack',
  'agachamento-hack-peso': 'agachamento-hack',
  'agachamento-hack-normal': 'agachamento-hack',
  'hack-normal': 'agachamento-hack',
  'agachamento-bom-hack': 'agachamento-hack',
  'agachamento-peso-rack': 'agachamento-hack',

  // the incline hack has its own load scale, stays separate from the regular one
  'agachamento-agudo-angulo-hack': 'agachamento-hack-inclinado',
  'agachamento-rack-secundario': 'agachamento-hack-inclinado',

  'serrote-unilateral': 'serrote',

  'elevacao-lar-maquina-sentado': 'elevacao-lateral-maquina-sentado',
  'banco-elevacao-lateral-sentado': 'elevacao-lateral-maquina-sentado',
  'elevacao-lateral-maquina-se-t': 'elevacao-lateral-maquina-sentado',
  'elevacao-lateral': 'elevacao-lateral-maquina-sentado',
  'elevacao-lateral-maquina': 'elevacao-lateral-maquina-sentado',

  'crossover-superior': 'baixa-cima-crossover',
  'boa-maquina-voador': 'voador',
  'bom-voador': 'voador',
  'alta-maquina-outra-puxada': 'alta-kikos-puxada-vermelha',

  // canonicalId() does ONE lookup, it's not transitive. 'barra-livre-supino'
  // used to point at 'barra-supino', which is now an alias itself -> pointed
  // straight at the survivor.
  'barra-livre-supino': 'barra-reto-supino',
  'reto-supino': 'barra-reto-supino',
  'barra-supino': 'barra-reto-supino',
  'barra-livre-reto-supino': 'barra-reto-supino',

  'baixa-polia-remada': 'baixa-remada',

  // "W" is the bar, not another exercise
  'testa-triceps-w': 'testa-triceps',
  'barra-testa-triceps-w': 'testa-triceps',

  // close grip bench: seven spellings, all 10-25kg, never two on the same day.
  // Logged as bench on some days and as triceps on others.
  'fechada-pegada-supino': 'reto-supino-triceps',
  'barra-supino-triceps': 'reto-supino-triceps',
  'barra-supino-trip': 'reto-supino-triceps',
  'barra-livre-supino-triceps': 'reto-supino-triceps',
  'supino-triceps': 'reto-supino-triceps',
  'fechada-pegada-supino-triceps': 'reto-supino-triceps',
};

// Sets that stay in the history but out of the 1RM math and the charts,
// because the logged load doesn't compare with the rest of the exercise.
export const EXCLUSIONS = [
  {
    exercise: 'barra-reta-triceps',
    minLoad: 100,
    reason: 'plate-loaded machine, the weight scale is nothing like the cable',
  },
  {
    exercise: 'pulldown',
    minLoad: 100,
    reason: 'light pulley, the number on the stack is not the real effort',
  },
  {
    exercise: 'curvada-remada',
    loads: [50],
    reason: 'outlier (everything else is 15-30kg), probably a typo',
  },
];

// Without this the display name is whatever spelling showed up first in the
// notebook. After merging the hack squat spellings the whole history was named
// after the least used one.
export const CANONICAL_NAMES = {
  'agachamento-hack': 'Agachamento Hack',
  'serrote': 'Serrote',
  'elevacao-lateral-maquina-sentado': 'Elevação Lateral Máquina Sentado',
  'baixa-cima-crossover': 'Crossover Peito Superior',
  'alta-kikos-puxada-vermelha': 'Puxada Alta Kikos Vermelha',
  'barra-reto-supino': 'Supino Reto Barra',
  'baixa-remada': 'Remada Baixa',
  'testa-triceps': 'Tríceps Testa',
  'reto-supino-triceps': 'Supino Pegada Fechada (Tríceps)',
  'agachamento-hack-inclinado': 'Agachamento Hack Inclinado',
};

// One-off fixes for a single day (wrong name on that date). Applied on every
// read, idempotent, so an old copy coming back through sync gets fixed too.
export const DATA_FIXES = [
  {
    date: '2026-09-11',
    from: 'barra-inclinado-supino',
    to: { id: 'barra-cotoveleira-inclinado-supino', name: 'Supino Inclinado Barra com Cotoveleira' },
    reason: 'done with elbow sleeves, logged as the regular one',
  },
];

export function applyDataFixes(sessions) {
  for (const fix of DATA_FIXES) {
    for (const s of sessions || []) {
      if (s.date !== fix.date) continue;
      for (const e of s.exercises || []) {
        if (e && e.id === fix.from) { e.id = fix.to.id; e.name = fix.to.name; }
      }
    }
  }
  return sessions;
}

export function canonicalId(id) {
  return ALIASES[id] ?? id;
}

export function canonicalName(id, fallback) {
  return CANONICAL_NAMES[id] ?? fallback;
}

export function isExcluded(exerciseId, set) {
  const load = set?.load ?? 0;
  if (!(load > 0)) return false;

  for (const rule of EXCLUSIONS) {
    if (rule.exercise !== exerciseId) continue;
    if (rule.minLoad != null && load >= rule.minLoad) return true;
    if (rule.loads && rule.loads.includes(load)) return true;
  }
  return false;
}

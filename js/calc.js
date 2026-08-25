// Cálculo de 1RM e cargas alvo.

import { workSets, tonnage } from './sets.js';

// Brzycki é confiável até ~12 reps. Acima disso a fórmula superestima muito
// (uma série de 20 reps projeta 2,1× a carga usada), então séries longas entram
// no histórico mas não pesam na estimativa de 1RM.
const BRZYCKI_MAX_REPS = 12;

// Séries mais antigas que isso só são usadas se não houver nada recente.
const RECENT_WINDOW_DAYS = 56; // 8 semanas

// Teto de segurança. Extrapolar uma 1RM a partir de séries de 10-12 reps e
// depois tomar 85% dela produz alvos acima de qualquer carga já levantada —
// na Puxada Alta, 130kg×10 projeta 1RM de 173kg e alvo de 148kg. Nenhum alvo
// pode passar deste fator sobre a maior carga que já foi de fato usada.
const MAX_OVER_BEST_LOAD = 1.10;

// Séries curtas estimam a 1RM com muito mais precisão que séries longas.
// O peso cai conforme a série se afasta da faixa de força.
function repsConfidence(reps) {
  if (reps <= 8) return 1.0;
  if (reps <= 10) return 0.97;
  return 0.94;
}

// Dia pesado em 5-8 reps: um treino inteiro de 4-6 castiga articulação demais
// para o retorno que dá. A intensidade acompanha a faixa — 5-8 reps pede menos
// carga que 4-6, e prescrever 85% para 8 reps seria pedir uma série impossível.
export const REP_RANGE = {
  A: [5, 8],
  B: [10, 15],
};

export const INTENSITY = {
  A: 0.80, // Força      → 5-8 reps
  B: 0.70, // Hipertrofia → 10-15 reps
};

/**
 * Intensidade (%1RM) que corresponde a uma faixa de reps, pela inversa de
 * Brzycki no ponto médio da faixa.
 *
 * Usada quando um exercício tem faixa de reps própria (ex: Extensora sempre
 * em 8-10, força ou hipertrofia): 85%/70% fixos foram calibrados para 4-6/10-15
 * reps — aplicar o mesmo 85% a uma faixa de 8-10 pediria uma carga pesada
 * demais para o número de reps prescrito, e o joelho paga essa conta num
 * isolado como a extensora.
 */
export function intensityForReps(reps) {
  const pct = 1.0278 - 0.0278 * reps;
  return Math.min(0.95, Math.max(0.5, pct));
}

/** 1RM = Carga / (1.0278 - 0.0278 × Reps) */
export function brzycki(load, reps) {
  if (!load || load <= 0 || !reps || reps < 1) return null;
  const denom = 1.0278 - 0.0278 * reps;
  if (denom <= 0.05) return null; // reps absurdas — fórmula degenera
  return load / denom;
}

/** Arredonda para o múltiplo de 2kg mais próximo (anilhas pareadas). */
export function roundTo2kg(kg) {
  if (!Number.isFinite(kg)) return null;
  return Math.round(kg / 2) * 2;
}

/**
 * Estima a 1RM de um exercício a partir do histórico de séries.
 *
 * Usa a melhor série (maior 1RM projetada) dentro da janela recente. Se não
 * houver série válida recente, cai para o histórico inteiro e sinaliza `stale`.
 *
 * @param {Array<{date:string, load:number, reps:number}>} sets
 * @param {{referenceDate?: string}} [opts]
 * @returns {{oneRM:number, basedOn:object, stale:boolean, samples:number}|null}
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
    // Maior carga efetivamente levantada — base do teto de segurança.
    bestLoad: Math.max(...(sets || []).filter((s) => s.load > 0).map((s) => s.load)),
  };
}

/**
 * Melhor 1RM projetada dentro de um conjunto de séries, SEM janela de
 * recência — usada para comparar períodos históricos inteiros (dashboard),
 * onde "recente" não faz sentido: queremos o pico real daquele período,
 * mesmo que tenha sido no início dele.
 */
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

/**
 * Carga alvo, limitada pelo teto de segurança.
 * @param {number} oneRM
 * @param {number} intensity fração de 1RM (0.85 = 85%)
 * @param {number} [bestLoad] maior carga já levantada no exercício
 * @returns {{load:number|null, capped:boolean, raw:number|null}}
 */
export function targetLoad(oneRM, intensity, bestLoad) {
  if (!Number.isFinite(oneRM)) return { load: null, capped: false, raw: null };

  const raw = oneRM * intensity;
  const ceiling = Number.isFinite(bestLoad) ? bestLoad * MAX_OVER_BEST_LOAD : Infinity;
  const capped = raw > ceiling;

  return { load: roundTo2kg(Math.min(raw, ceiling)), capped, raw: roundTo2kg(raw) };
}

/**
 * Prescrição completa de um exercício para o dia.
 *
 * `opts.repRange`, quando presente, substitui a faixa padrão da variante
 * (4-6 força / 10-15 hipertrofia) e a intensidade é recalculada a partir dela
 * — para que a carga pedida realmente combine com o número de reps prescrito.
 *
 * @returns {{exerciseId, name, variant, targetLoad, repRange, oneRM, stale, basedOn, bodyweight}}
 */
export function prescribe(exercise, variant, opts = {}) {
  const est = estimateOneRM(exercise.sessions, opts);
  const [minReps, maxReps] = opts.repRange ?? REP_RANGE[variant];
  const intensity = opts.repRange ? intensityForReps((minReps + maxReps) / 2) : INTENSITY[variant];

  // Exercícios de peso corporal (abdominal, barra fixa) não têm carga alvo —
  // o alvo é a faixa de reps, e a progressão é por volume.
  const isBodyweight = !est && (exercise.sessions || []).some((s) => s.bodyweight);
  const target = est ? targetLoad(est.oneRM, intensity, est.bestLoad) : { load: null, capped: false };

  return {
    exerciseId: exercise.id,
    name: exercise.name,
    group: exercise.group,
    variant,
    targetLoad: target.load,
    capped: target.capped,       // alvo limitado pelo teto de segurança
    uncappedLoad: target.raw,    // o que a fórmula pedia antes do teto
    repRange: [minReps, maxReps],
    oneRM: est ? Math.round(est.oneRM * 10) / 10 : null,
    bestLoad: est ? est.bestLoad : null,
    stale: est ? est.stale : false,
    basedOn: est ? est.basedOn : null,
    bodyweight: isBodyweight,
    lastSets: lastSessionSets(exercise.sessions),
  };
}

// Séries do último dia em que o exercício foi feito — mostrado como referência
// na tela do treino ("da última vez você fez...").
//
// Aquecimento fica de fora: mostrar "20kg×9" como referência de um dia em que
// o trabalho foi a 30kg induz a erro na hora de escolher a carga.
function lastSessionSets(sessions) {
  const dated = (sessions || []).filter((s) => s.date);
  if (dated.length === 0) return [];
  const lastDate = dated.reduce((a, b) => (b.date > a.date ? b : a)).date;
  const ofDay = dated.filter((s) => s.date === lastDate);
  return workSets(ofDay).map((s) => ({ load: s.load, reps: s.reps, role: s.role }));
}

export { tonnage };

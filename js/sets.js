// Classificação de séries e contabilidade de volume.
//
// O caderno registra tudo junto, mas as séries não têm o mesmo papel:
//
//   Supino Inclinado Barra:  20×9   30×6  30×5   25×8  25×6[drop]  20×8
//                            └feeder┘  └─trabalho─┘  └──── descida ────┘
//
// Misturar os três estraga qualquer conta: o volume infla com aquecimento, a
// média de carga cai, e "última vez" mostra um número que não representa o
// esforço real do dia.
//
// A separação é posicional e relativa à série mais pesada do dia naquele
// exercício: o que vem ANTES dela com carga bem menor é preparação; o que vem
// DEPOIS com carga bem menor é descida (back-off).

// Quanto abaixo da série mais pesada uma série precisa estar para deixar de
// contar como trabalho. 12% cobre a variação normal entre séries pesadas
// (30kg → 28kg segue sendo trabalho) sem engolir os feeders (20kg → 30kg).
const WORK_THRESHOLD = 0.88;

/**
 * Marca cada série como 'feeder' | 'work' | 'backoff'.
 * Não muda os dados originais — devolve uma cópia anotada.
 *
 * @param {Array<{load:number, reps:number, bodyweight?:boolean}>} sets
 */
export function classifySets(sets) {
  const list = sets || [];
  if (list.length === 0) return [];

  const loads = list.map((s) => s.load || 0);
  const top = Math.max(...loads);

  // Sem carga (peso corporal) ou tudo na mesma carga: é tudo trabalho.
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

/** Só as séries que contam como esforço real (trabalho + descida). */
export function workSets(sets) {
  return classifySets(sets).filter((s) => s.role !== 'feeder');
}

/**
 * Volume de uma série, incluindo o que foi feito nas técnicas.
 *
 * Um drop set de "30kg×8 drop 20kg×10" não é 240kg de volume — são 240 + 200.
 * Ignorar isso subestima justamente as séries mais duras do treino. Quando a
 * técnica não traz carga própria (só "drop 6"), assume-se a carga da série.
 */
export function setVolume(set) {
  const base = (set.load || 0) * (set.reps || 0);
  const extra = (set.techniques || []).reduce((sum, t) => {
    const load = t.load ?? set.load ?? 0;
    return sum + load * (t.reps || 0);
  }, 0);
  return base + extra;
}

/** Reps totais de uma série, contando as das técnicas. */
export function setReps(set) {
  const extra = (set.techniques || []).reduce((sum, t) => sum + (t.reps || 0), 0);
  return (set.reps || 0) + extra;
}

/** Volume total de uma lista de séries, com técnicas incluídas. */
export function tonnage(sets) {
  return (sets || []).reduce((sum, s) => sum + setVolume(s), 0);
}

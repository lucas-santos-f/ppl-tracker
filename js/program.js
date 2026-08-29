// Programa oficial de treino.
//
// Esta é a fonte da verdade sobre O QUE treinar e em que ordem. O histórico só
// fornece as cargas — a lista de exercícios vem daqui, não do que foi feito por
// último.
//
// Duas particularidades do programa:
//   · não há treino de bíceps; o tríceps fica no dia de Pull
//   · alguns exercícios alternam entre o primeiro e o segundo treino da semana,
//     o que corresponde exatamente às variantes A e B do ciclo
//
// `name` é o nome oficial, exibido na tela.
// `hist` diz de onde vêm as cargas no histórico importado:
//    string  → nome exato do exercício no histórico (casamento declarado)
//    null    → exercício novo, ainda sem histórico
//    ausente → deixa o casamento automático por semelhança resolver
//
// O casamento declarado existe porque a busca por semelhança erra justamente
// onde mais importa: "Remada Alta" (trapézio) caía em "Remada Curvada", e
// "Cadeira Extensora" precisava achar "Extensora". Onde há ambiguidade, é
// melhor dizer do que adivinhar.

export const PROGRAM = {
  push: {
    label: 'Push',
    exercises: [
      // No Push B, o primeiro movimento mantém carga alta antes do bloco metabólico.
      { part: 'Peito',    name: 'Supino Inclinado Barra', hist: 'Supino Inclinado Barra',
        repRange: { B: [5, 8] } },

      // Primeiro Push da semana (A) é crossover superior; o segundo (B) é supino reto.
      { part: 'Peito',    name: 'Crossover Peito Superior', hist: 'Crossover Superior', only: 'A' },
      { part: 'Peito',    name: 'Supino Reto Barra',        hist: 'Supino Reto Barra',  only: 'B' },

      { part: 'Peito',    name: 'Voador',                          hist: 'Voador' },
      { part: 'Ombro',    name: 'Desenvolvimento Máquina Amarela', hist: 'Desenvolvimento Máquina Amarela' },
      { part: 'Ombro',    name: 'Elevação Lateral Máquina Sentado', hist: 'Elevação Lateral Máquina Sentado' },

      // Exercício novo: o histórico só tem remada baixa, curvada e cavalo.
      { part: 'Trapézio', name: 'Remada Alta', hist: null },

      { part: 'Core', name: 'Abdômen Inferior (Elevação de Pernas)',
        hist: 'Elevação Abdominal Inferior', bodyweight: true },
      { part: 'Core', name: 'Abdômen Superior Máquina Vermelha',
        hist: 'Abdominal Máquina Superior' },
    ],
  },

  pull: {
    label: 'Pull',
    exercises: [
      // Uma vertical por dia, sempre abrindo o treino: puxada alta no dia de
      // força (A), barra fixa no dia metabólico (B). Só uma das duas passa pelo
      // filtro, então listar as duas aqui mantém a vertical como 1º exercício.
      { part: 'Dorsal', name: 'Puxada Alta', hist: 'Puxada Alta', only: 'A' },
      {
        part: 'Dorsal', name: 'Barra Fixa (Pegada Aberta)', hist: 'Barra Fixa Aberta Fechada',
        only: 'B', bodyweight: true,
        note: '3 séries brigando com o peso (baby reps, sem rest) + 4ª série pegada fechada',
      },

      // A barra fixa é peso corporal e não carrega carga alvo, então quem
      // segura o bloco pesado do Pull B é o serrote: 5-8 reps nos dois dias.
      { part: 'Remada', name: 'Serrote Unilateral com Halter', hist: 'Serrote Unilateral',
        repRange: { B: [5, 8] } },
      { part: 'Dorsal', name: 'Remada Cavalo Peito no Banco',  hist: 'Remada Cavalo Peito Banco' },
      { part: 'Ombro post.', name: 'Peck Deck Invertido',      hist: 'Voador Invertido', alt: 'Y-Raise' },
      { part: 'Tríceps', name: 'Tríceps Francês Sentado Halter', hist: 'Tríceps Francês Halter Sentado' },
      { part: 'Tríceps', name: 'Tríceps Barra Reta',             hist: 'Tríceps Barra Reta' },
      { part: 'Cardio',  name: 'Escada ou Esteira', hist: null, cardio: true, note: '10 min' },
    ],
  },

  legs: {
    label: 'Legs',
    exercises: [
      { part: 'Quadríceps', name: 'Agachamento Hack',   hist: 'Agachamento Hack',
        repRange: { B: [5, 8] } },
      { part: 'Quadríceps', name: 'Agachamento Pêndulo', hist: 'Agachamento Pêndulo',
        machineBaseLoad: 10 },
      // Isolado de joelho: carga muito alta em rep baixa castiga a articulação
      // sem ganho real, então a extensora fica em 8-10 reps nos dois dias,
      // fora da ondulação padrão 4-6/10-15 do resto do programa.
      { part: 'Quadríceps', name: 'Cadeira Extensora', hist: 'Extensora',
        repRange: { A: [8, 10], B: [8, 10] }, maxTargetLoad: 120 },

      // A cada três treinos de perna, o terceiro troca flexora por stiff.
      { part: 'Posterior', name: 'Cadeira Flexora', hist: 'Flexora', unlessEveryThird: true },
      { part: 'Posterior', name: 'Stiff',           hist: 'Stiff',   onlyEveryThird: true },

      { part: 'Panturrilha', name: 'Panturrilha Máquina', hist: 'Panturrilha' },
      {
        part: 'Lombar', name: 'Elevação Lombar', hist: 'Elevação Lombar', highRep: true,
        note: 'mais reps, menos carga — nunca atingir a falha',
      },
    ],
  },
};

/**
 * Exercícios do dia, aplicando as regras de alternância.
 *
 * @param {'push'|'pull'|'legs'} slot
 * @param {'A'|'B'} variant
 * @param {number} slotOccurrence quantas vezes este slot já foi treinado
 */
export function programFor(slot, variant, slotOccurrence = 0) {
  const block = PROGRAM[slot];
  if (!block) return [];

  const isEveryThird = slotOccurrence % 3 === 2;

  return block.exercises.filter((e) => {
    if (e.only && e.only !== variant) return false;
    if (e.onlyEveryThird && !isEveryThird) return false;
    if (e.unlessEveryThird && isEveryThird) return false;
    return true;
  });
}

/** Multiplicador usado para exibir e registrar a carga total do aparelho. */
export function loadMultiplierForExercise(name) {
  for (const block of Object.values(PROGRAM)) {
    const exercise = block.exercises.find((item) => item.name === name);
    if (exercise) return exercise.loadMultiplier ?? 1;
  }
  return 1;
}

// Correções manuais sobre o histórico importado.
//
// Nem tudo dá para resolver por regra automática: só quem treinou sabe que
// "Rack Agachamento" e "Agachamento Hack" são o mesmo aparelho, ou que aquele
// tríceps de 150kg foi numa máquina cuja escala de peso não se compara com as
// outras.
//
// Estas listas são a fonte dessas decisões. Ficam explícitas e num lugar só,
// para poderem ser revistas quando a memória do treino disser outra coisa.

/**
 * Exercícios que são a mesma coisa escrita de formas diferentes.
 * Chave = ID que deve desaparecer · Valor = ID que fica.
 */
export const ALIASES = {
  // Mesmo aparelho, nomes trocados no caderno.
  'agachamento-rack': 'agachamento-hack',

  // O serrote é sempre unilateral na prática; anotar "unilateral" ou não
  // dividia o histórico em dois.
  'serrote-unilateral': 'serrote',
};

/**
 * Séries que não devem contar para estimativa de carga.
 *
 * Não apagam nada do histórico — só ficam de fora dos cálculos de 1RM e dos
 * gráficos, porque a carga anotada não é comparável com o resto do exercício.
 *
 *   exercise → ID do exercício (após os ALIASES)
 *   minLoad  → ignora séries com carga igual ou acima disto
 *   loads    → ignora séries exatamente nestas cargas
 */
export const EXCLUSIONS = [
  {
    exercise: 'barra-reta-triceps',
    minLoad: 100,
    reason: 'máquina de placa amarela — escala de peso não comparável com a barra livre',
  },
  {
    exercise: 'pulldown',
    minLoad: 100,
    reason: 'polia leve — a carga marcada não corresponde ao esforço real',
  },
  {
    exercise: 'curvada-remada',
    loads: [50],
    reason: 'carga fora do padrão do exercício (as demais ficam entre 15 e 30kg), não reconhecida',
  },
];

/**
 * Nome que deve aparecer na tela para um ID.
 *
 * Sem isto, o nome mostrado seria simplesmente o da primeira grafia encontrada
 * no caderno — depois de fundir "Rack Agachamento" com "Agachamento Hack", o
 * histórico inteiro passava a se chamar pelo nome menos usado.
 */
export const CANONICAL_NAMES = {
  'agachamento-hack': 'Agachamento Hack',
  'serrote': 'Serrote',
};

/** Resolve o ID final de um exercício, aplicando os apelidos. */
export function canonicalId(id) {
  return ALIASES[id] ?? id;
}

/** Nome preferido para um ID, quando houver um definido. */
export function canonicalName(id, fallback) {
  return CANONICAL_NAMES[id] ?? fallback;
}

/**
 * True quando a série deve ficar de fora dos cálculos.
 * @param {string} exerciseId já canonizado
 * @param {{load:number}} set
 */
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

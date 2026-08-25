// Normalização e identidade de exercícios.
//
// O mesmo exercício aparece escrito de cinco jeitos ao longo do ano:
//
//   Supino Incl Halt · Supino Inclinado Halter · Supino Inculcado Halter
//   Supino Incl Halter · Supino Inclinado Halt
//
// Se cada grafia virar um exercício, 125 séries se dividem em cinco históricos
// curtos e a estimativa de 1RM fica inútil. A identidade é resolvida em três
// etapas:
//
//   1. expandir abreviações  (incl → inclinado, halt → halter)
//   2. corrigir typos por semelhança contra o vocabulário conhecido
//   3. gerar o ID a partir do CONJUNTO ORDENADO de palavras, para que
//      "lateral máquina sentado" e "lateral sentado máquina" colidam de propósito
//
// A especificação de equipamento (amarela, leve, kikos) permanece no ID: são
// aparelhos diferentes, com curvas de carga diferentes.

// ── vocabulário canônico ──────────────────────────────────────────────────────

const ABBREV = {
  // movimentos
  'sup': 'supino', 'supino': 'supino',
  'incl': 'inclinado', 'incli': 'inclinado', 'inclin': 'inclinado',
  'inclinado': 'inclinado', 'inculcado': 'inclinado', 'inclinada': 'inclinado',
  'declin': 'declinado', 'declinado': 'declinado',
  'halt': 'halter', 'halter': 'halter', 'halteres': 'halter', 'haltere': 'halter',
  'desenv': 'desenvolvimento', 'desenvolvimento': 'desenvolvimento',
  'shoulder press': 'desenvolvimento',
  'tric': 'triceps', 'tri': 'triceps', 'triceps': 'triceps', 'tríceps': 'triceps',
  'bic': 'biceps', 'biceps': 'biceps', 'bíceps': 'biceps',
  'pant': 'panturrilha', 'panturrilha': 'panturrilha',
  'agacha': 'agachamento', 'agach': 'agachamento', 'agachamento': 'agachamento',
  'squat': 'agachamento',
  'lat raise': 'elevacao lateral', 'lateral raise': 'elevacao lateral',
  'lat raises': 'elevacao lateral', 'lateral raises': 'elevacao lateral',
  'raise': 'elevacao', 'raises': 'elevacao', 'rais': 'elevacao',
  'elev': 'elevacao', 'elevacao': 'elevacao', 'elevação': 'elevacao',
  'lat': 'lateral', 'lateral': 'lateral',
  'abd': 'abdominal', 'abdominal': 'abdominal', 'abdomen': 'abdominal',
  'abs': 'abdominal', 'cad': 'cadeira', 'cadeira': 'cadeira',
  'cross over': 'crossover', 'crossover': 'crossover',
  // "Lat pulldown" e "pulldown" NÃO são o mesmo aparelho: o pulldown é feito
  // numa polia bem mais leve, com escala de carga própria. Juntar os dois faz
  // a carga da polia leve inflar a 1RM da puxada alta.
  'lat pull down': 'puxada alta', 'lat pulldown': 'puxada alta',
  'pulldown': 'pulldown', 'pull down': 'pulldown',
  'skullcrusher': 'triceps testa', 'skull crusher': 'triceps testa',
  'testa': 'testa',
  'frances': 'frances', 'francês': 'frances',
  'peck deck': 'voador', 'pec deck': 'voador', 'voador': 'voador',
  'crucifixo': 'crucifixo',
  'extensora': 'extensora', 'leg extension': 'extensora', 'cadeira extensora': 'extensora',
  'flexora': 'flexora', 'leg curl': 'flexora', 'cadeira flexora': 'flexora',
  'mesa flexora': 'mesa flexora',
  'leg press': 'leg press',
  'stiff': 'stiff', 'terra': 'levantamento terra',
  'remada': 'remada', 'row': 'remada',
  'serrote': 'serrote', 'sereote': 'serrote', 'serote': 'serrote', 'serratil': 'serrote',
  'barra fixa': 'barra fixa', 'pull up': 'barra fixa', 'chin up': 'barra fixa',
  'paralela': 'paralela', 'dips': 'paralela', 'mergulho': 'paralela',
  'bench press': 'supino', 'chest press': 'supino',
  'rosca': 'rosca',
  'face pull': 'face pull', 'face pulls': 'face pull',
  'encolhimento': 'encolhimento',
  'graviton': 'graviton',
  'hack': 'hack',
  'rack': 'rack',
  'pendulo': 'pendulo', 'pêndulo': 'pendulo',
  'gluteo': 'gluteo', 'glúteo': 'gluteo',
  'adutora': 'adutora', 'abdutora': 'abdutora',
  'lombar': 'lombar',
  'esteira': 'esteira', 'bicicleta': 'bicicleta',
  'y raise': 'y raise',
  'close grip': 'pegada fechada', 'closed grip': 'pegada fechada',
  'pegada fechada': 'pegada fechada', 'pegada aberta': 'pegada aberta',
  'seated dips': 'paralela sentado',

  // equipamento e posição
  'maq': 'maquina', 'maquina': 'maquina', 'máquina': 'maquina', 'maqu': 'maquina',
  'unilat': 'unilateral', 'unilateral': 'unilateral', 'unilateeal': 'unilateral',
  'bilat': 'bilateral', 'bilateral': 'bilateral',
  'sent': 'sentado', 'sentado': 'sentado', 'seated': 'sentado',
  'polia': 'polia', 'cabo': 'polia',
  'barra': 'barra', 'corda': 'corda', 'banco': 'banco',
  'smith': 'smith', 'livre': 'livre',
  'reto': 'reto', 'aberta': 'aberta', 'fechada': 'fechada',
  'pronada': 'pronada', 'supinada': 'supinada', 'neutra': 'neutra',
  'superior': 'superior', 'inferior': 'inferior',
  'alta': 'alta', 'alto': 'alta', 'baixa': 'baixa', 'baixo': 'baixa',
  'curvada': 'curvada', 'cavalo': 'cavalo', 'w': 'w',
  'kikos': 'kikos',
  'amarela': 'amarela', 'amarelo': 'amarela',
  'vermelha': 'vermelha', 'vermelho': 'vermelha',
  'azul': 'azul', 'verde': 'verde', 'preta': 'preta', 'preto': 'preta',
  'branca': 'branca', 'cinza': 'cinza', 'paia': 'paia',
  'leve': 'leve', 'pesada': 'pesada', 'pesado': 'pesada',
  'articulada': 'articulada', 'convergente': 'convergente',
  'bem': 'bem', 'frontal': 'frontal', 'posterior': 'posterior', 'invertido': 'invertido',
};

// Palavras que descrevem COMO a série foi feita, não QUAL exercício é.
// Saem do nome porque já estão capturadas nos campos da série.
const SET_MODIFIERS = new Set([
  // "Cadeira Flexora" e "Flexora" são o mesmo exercício — a cadeira é só o
  // móvel. Já "Mesa Flexora" é outro movimento (deitado), por isso 'mesa'
  // continua fazendo parte da identidade e não entra nesta lista.
  'cadeira',
  'cada', 'lado', 'lados', 'por', 'c',
  'drop', 'dropset', 'rest', 'pause', 'top', 'set', 'sets',
  'serie', 'series', 'reps', 'rep', 'trabalho', 'primeira', 'segunda', 'terceira',
  'ultima', 'ultimas', 'com', 'mais', 'de', 'do', 'da', 'em', 'no', 'na', 'e', 'o', 'a',
  'kg', 'placa', 'placas', 'ate', 'para', 'pra', 'p', 'somado', 'ambas', 'breves',
  'pausas', 'cadenciadas', 'amplitude', 'menor', 'maior',
]);

// Linhas que são anotação solta, nunca nome de exercício.
const NOT_EXERCISE = new Set([
  'duplo', 'balancando corpo', 'com cotoveleira', 'pegada fechada', 'zzz',
  'sem peso', 'livre', 'obs', 'nota', 'notas', 'peito', 'costas', 'perna', 'pernas',
  'ombro', 'ombros', 'braco', 'bracos', 'dorsais', 'cargas',
]);

// Grupos musculares.
const GROUP_KEYWORDS = [
  ['push', ['supino', 'crossover', 'desenvolvimento', 'elevacao lateral', 'voador',
            'crucifixo', 'triceps', 'paralela', 'pegada fechada', 'y raise']],
  ['pull', ['barra fixa', 'serrote', 'puxada alta', 'remada', 'rosca', 'biceps',
            'face pull', 'encolhimento', 'pulldown', 'graviton']],
  ['legs', ['agachamento', 'leg press', 'extensora', 'flexora', 'panturrilha',
            'stiff', 'levantamento terra', 'adutora', 'abdutora', 'gluteo', 'hack',
            'rack', 'pendulo', 'afundo', 'avanco']],
  ['core', ['abdominal', 'lombar', 'prancha', 'obliquo']],
  ['cardio', ['esteira', 'bicicleta', 'eliptico', 'corrida']],
];

const GROUP_OVERRIDES = [
  [/\bvoador\b.*\binvertido\b|\binvertido\b.*\bvoador\b/, 'pull'],
  [/\bremada\b/, 'pull'],
  [/\btriceps\b/, 'push'],
  [/\bombro\b/, 'push'],
];

// ── implementação ─────────────────────────────────────────────────────────────

function stripAccents(s) {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

// Regex das abreviações, entradas mais longas primeiro para que expressões de
// várias palavras ("lat pull down") vençam as de uma só ("lat").
const ABBREV_RE = (() => {
  const keys = Object.keys(ABBREV).sort((a, b) => b.length - a.length);
  const esc = keys.map((k) => stripAccents(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(?<![a-z])(${esc.join('|')})(?![a-z])`, 'gi');
})();

// Vocabulário para correção de typos.
const VOCAB = [...new Set(Object.values(ABBREV).flatMap((v) => v.split(' ')))];

function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

// Palavras de 5+ letras a uma edição de um termo conhecido são typo.
function fixTypo(word) {
  if (word.length < 5 || VOCAB.includes(word)) return word;
  let best = null, bestD = 2;
  for (const v of VOCAB) {
    if (v.length < 5) continue;
    const d = levenshtein(word, v);
    if (d < bestD) { bestD = d; best = v; }
  }
  return best ?? word;
}

/**
 * Resolve a identidade de um exercício a partir da linha crua.
 * @returns {{name, id, group, words, isExercise}}
 */
export function normalizeExercise(raw) {
  const original = String(raw || '').trim();
  let s = stripAccents(original.toLowerCase())
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!s || NOT_EXERCISE.has(s)) {
    return { name: original, id: '', group: 'other', words: [], isExercise: false };
  }

  // 1. expandir abreviações
  s = s.replace(ABBREV_RE, (m) => ABBREV[m.toLowerCase()] ?? m);

  // 2. tokenizar, corrigir typos, remover modificadores de série e números
  const words = s.split(' ')
    .filter((w) => w && !/^\d+$/.test(w))
    .map(fixTypo)
    .filter((w) => !SET_MODIFIERS.has(w));

  if (words.length === 0) {
    return { name: original, id: '', group: 'other', words: [], isExercise: false };
  }

  // 3. ID = conjunto ordenado, para que a ordem das palavras não crie duplicata
  const unique = [...new Set(words)].sort();
  const id = unique.join('-');

  return {
    name: titleCase(words.join(' ')),
    id,
    group: inferGroup(words.join(' ')),
    words,
    isExercise: true,
  };
}

function inferGroup(text) {
  for (const [re, group] of GROUP_OVERRIDES) if (re.test(text)) return group;
  for (const [group, keywords] of GROUP_KEYWORDS) {
    if (keywords.some((k) => text.includes(k))) return group;
  }
  return 'other';
}

// A identidade é calculada sem acentos (para que "máquina" e "maquina" colidam),
// mas o nome exibido leva a acentuação de volta.
const DISPLAY = {
  elevacao: 'elevação', triceps: 'tríceps', biceps: 'bíceps', maquina: 'máquina',
  frances: 'francês', pendulo: 'pêndulo', gluteo: 'glúteo', obliquo: 'oblíquo',
  abdomen: 'abdômen', serie: 'série', eliptico: 'elíptico',
};

function titleCase(s) {
  const minor = new Set(['de', 'da', 'do', 'em', 'e', 'no', 'na', 'com']);
  return s.split(' ').map((w, i) => {
    const d = DISPLAY[w] ?? w;
    return i > 0 && minor.has(w) ? d : d.charAt(0).toUpperCase() + d.slice(1);
  }).join(' ');
}

export function slug(s) {
  return stripAccents(String(s).toLowerCase()).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Palavras que nomeiam o MOVIMENTO em si, por oposição a equipamento, ângulo
// ou pegada. Dois exercícios só podem ser considerados o mesmo se compartilham
// um movimento: "Remada Alta" e "Puxada Alta" dividem o "alta", mas remada não
// é puxada.
export const MOVEMENTS = new Set([
  'supino', 'crossover', 'voador', 'crucifixo', 'desenvolvimento', 'elevacao',
  'triceps', 'biceps', 'paralela', 'pegada', 'testa', 'frances',
  'remada', 'puxada', 'pulldown', 'serrote', 'rosca', 'encolhimento', 'face pull',
  'agachamento', 'extensora', 'flexora', 'panturrilha', 'stiff', 'levantamento',
  'adutora', 'abdutora', 'gluteo', 'hack', 'pendulo', 'leg', 'press',
  'abdominal', 'lombar', 'prancha',
  'barra', 'fixa', 'graviton', 'mesa',
  'esteira', 'bicicleta', 'escada',
]);

/** Palavras de movimento presentes num nome já normalizado. */
export function movementsOf(words) {
  return new Set((words || []).filter((w) => MOVEMENTS.has(w)));
}

// Qualificadores que se excluem: "Remada Alta" e "Remada Baixa" são exercícios
// diferentes, não grafias do mesmo. Se o programa pede um lado do par e o
// candidato traz o outro sem trazer o pedido, não é o mesmo exercício.
const OPPOSITES = [
  ['alta', 'baixa'],
  ['superior', 'inferior'],
  ['aberta', 'fechada'],
  ['inclinado', 'declinado'],
  ['unilateral', 'bilateral'],
  ['sentado', 'pe'],
];

/**
 * True quando `candidate` contradiz um qualificador exigido por `wanted`.
 * @param {string[]} wanted palavras do nome pedido
 * @param {Set<string>} candidate palavras do nome candidato
 */
export function contradicts(wanted, candidate) {
  const want = new Set(wanted);
  for (const [a, b] of OPPOSITES) {
    if (want.has(a) && candidate.has(b) && !candidate.has(a)) return true;
    if (want.has(b) && candidate.has(a) && !candidate.has(b)) return true;
  }
  return false;
}

export const _internals = { ABBREV, SET_MODIFIERS, VOCAB, stripAccents, fixTypo, levenshtein };

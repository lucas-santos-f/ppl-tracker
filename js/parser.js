// Parser do histórico escrito no bloco de notas do iPhone.
//
// O formato mudou ao longo do ano. O parser precisa aguentar todos:
//
//   formato recente (dominante)      formato antigo (verboso)
//   ─────────────────────────        ─────────────────────────
//   30kg 10                          12 reps 80kg primeira serie de trabalho
//   30kg  8 Drop 20kg 10             Top set 104kg 100% 11 reps
//   14                               Trabalho 12kg - 8 reps 90%
//   Sem peso 10                      3 placas 10 com dropset
//   7 e 3                            20kg cada lado 17 reps
//                                    80kg 10 reps mais 5 rest pause
//
// A estratégia é tokenizar cada linha em vez de casar um formato fixo: encontrar
// os números com suas unidades (kg, placa, reps, %) e decidir o papel de cada um.
// Números sem unidade são resolvidos pelo que já foi preenchido.
//
// Nada é descartado em silêncio: o que não for entendido vai para `warnings`.

import { normalizeExercise } from './normalize.js';

// ── datas e marcadores de sessão ──────────────────────────────────────────────

const DATE_RE = /^(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?\.?$/;
const WEEKDAY_RE = /^(segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo)(\s*-?\s*feira)?\.?$/i;

// Cabeçalhos que separam blocos mas não são exercício nem data.
const HEADER_RE = /^(cargas?\b.*|peito|costas|dorsais|pernas|ombros?|bra[cç]os?|zzz+|treino\s+[a-z])$/i;

// ── unidades ──────────────────────────────────────────────────────────────────

const KG_RE     = /(\d+(?:[.,]\d+)?)\s*k(?:g|gs)?\b/gi;   // 30kg · 22.5 kg · 95k
const PLACA_RE  = /(\d+(?:[.,]\d+)?)\s*placas?\b/gi;      // 3 placas
const REPS_RE   = /(\d+)\s*(?:reps?|rep|repeti[cç][õo]es)\b/gi;
const PCT_RE    = /(\d+(?:[.,]\d+)?)\s*%/g;               // 90% → esforço, não carga

// Técnicas. Capturam carga opcional + reps, em qualquer ordem de aparição.
//   "Drop 20kg 10" · "drop 7" · "rest 5" · "mais 5 rest pause" · "com dropset"
const TECHNIQUE_RE =
  /\b(drop\s*set|dropset|drops?|rest\s*pause|rest|mais)\b\s*(?:(\d+(?:[.,]\d+)?)\s*kg\s*)?(\d+)?/gi;

// Peso corporal declarado.
const BODYWEIGHT_RE = /\b(sem\s*peso|s\/\s*peso|livre|corporal|só\s*o?\s*corpo)\b/i;

// Unilateral — a carga anotada é de UM lado.
const PER_SIDE_RE = /\b(cada\s*lado|casa\s*laso|c\/\s*lado|por\s*lado|unilat)/i;

// Sub-séries na mesma linha: "7 e 3", "12 mais 8"
const SUBSETS_RE = /^(\d+)\s*(?:e|\+|\/)\s*(\d+)\s*$/i;

// Marcador de série feita sem anotar carga: "1 serie", "2 series"
const BARE_SERIES_RE = /^(\d+)\s*s[ée]ries?\b/i;

const num = (s) => parseFloat(String(s).replace(',', '.'));

// Erros de digitação recorrentes, corrigidos antes de tokenizar.
function fixTypos(line) {
  return line
    .replace(/(\d)\s*(eeps|rrps|reeps|repss)\b/gi, '$1 reps')
    .replace(/(\d)(reps?)\b/gi, '$1 $2')        // "9reps" → "9 reps"
    .replace(/casa\s*laso/gi, 'cada lado')
    .replace(/\bdeop\s*set/gi, 'drop set')
    .replace(/\bdrops\s*set/gi, 'drop set')
    .replace(/\bprim\b/gi, 'primeira')
    .replace(/\btrab\b/gi, 'trabalho')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Converte o texto colado em sessões estruturadas.
 *
 * @param {string} text
 * @param {{defaultYear?: number}} [opts]
 * @returns {{sessions: Array, warnings: Array, stats: object}}
 */
export function parseHistory(text, opts = {}) {
  const defaultYear = opts.defaultYear ?? new Date().getFullYear();
  const lines = String(text || '').split(/\r?\n/);

  const sessions = [];
  const warnings = [];

  // Os anos são resolvidos numa passada prévia sobre todas as datas, porque
  // decidir ano a ano da esquerda para a direita propaga qualquer typo isolado
  // para todo o resto do arquivo.
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

    // 1. Data → nova sessão
    if (dateMap.has(lineNo)) {
      flushSession();
      session = { date: dateMap.get(lineNo), exercises: [], lineNo };
      continue;
    }

    // 2. Dia da semana escrito por extenso → nova sessão, sem data
    if (WEEKDAY_RE.test(line)) {
      flushSession();
      session = { date: null, exercises: [], lineNo, undated: true, weekday: line.toLowerCase() };
      continue;
    }

    // 3. Cabeçalho de bloco → separa exercícios, não é sessão
    if (HEADER_RE.test(line)) { flushExercise(); continue; }

    // 4. Tenta ler a linha como série
    const parsed = parseSetLine(line);

    if (parsed.isSet) {
      ensureSession(lineNo);
      if (!exercise) {
        // Série sem exercício nomeado acima: acontece quando o usuário anota a
        // data e continua o exercício do bloco anterior. Reabre o último.
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

    // 5. Sobrou: nome de exercício
    const norm = normalizeExercise(parsed.name ?? line);
    if (!norm.isExercise) { flushExercise(); continue; } // anotação solta

    ensureSession(lineNo);
    flushExercise();
    exercise = {
      id: norm.id,
      name: norm.name,
      group: norm.group,
      raw: rawLine.trim(),
      sets: [],
      lineNo,
    };
  }

  flushSession();

  return { sessions, warnings, stats: buildStats(sessions) };
}

/**
 * Decide se a linha é uma série e, se for, extrai todas as séries que ela contém.
 * @returns {{isSet: boolean, sets?: Array, name?: string}}
 */
function parseSetLine(line) {
  const lower = line.toLowerCase();

  // Sub-séries: "7 e 3"
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

  // "1 serie" — série feita, carga não anotada
  const bare = line.match(BARE_SERIES_RE);
  if (bare) {
    const n = parseInt(bare[1], 10);
    return { isSet: true, sets: Array.from({ length: n }, () => ({ load: 0, reps: null, unlogged: true })) };
  }

  const t = tokenize(line);

  // Sem nenhum número: é nome de exercício.
  if (t.numbers.length === 0) return { isSet: false };

  const hasUnit = t.kg.length > 0 || t.placa.length > 0 || t.reps.length > 0 || t.pct.length > 0;
  const words = t.words;

  // Sem unidade explícita e com várias palavras: nome de exercício que contém
  // número ("Remada alta maquina ef 10", "Graviton 45 graus").
  if (!hasUnit && words >= 3) return { isSet: false };

  // Sem unidade e sem palavra alguma: número solto = reps com peso corporal.
  if (!hasUnit && words === 0) {
    return { isSet: true, sets: t.numbers.map((n) => ({ load: 0, reps: n, bodyweight: true })) };
  }

  // Peso corporal declarado: "Livre 14 reps", "Sem peso 10"
  if (BODYWEIGHT_RE.test(lower)) {
    const reps = t.reps[0] ?? t.loose[0] ?? null;
    if (reps == null) return { isSet: false };
    return { isSet: true, sets: [{ load: 0, reps, bodyweight: true }] };
  }

  if (!hasUnit && words > 0 && words < 3) {
    // "Trabalho 12" — ambíguo, mas com 1-2 palavras trata como série.
    return { isSet: true, sets: [{ load: 0, reps: t.numbers[0], bodyweight: true }] };
  }

  // ── caso normal: resolve carga e reps ──
  let load = t.kg[0] ?? null;
  let placas = t.placa[0] ?? null;
  let reps = t.reps[0] ?? null;

  // Números sem unidade preenchem o que falta. No formato recente ("30kg 10")
  // o solto é reps; no antigo ("55 - 5 reps 90%") o solto é a carga.
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

// Separa os números da linha por unidade.
function tokenize(line) {
  const kg = [], placa = [], reps = [], pct = [];
  let rest = line;

  const take = (re, out) => {
    rest = rest.replace(re, (m, g1) => { out.push(num(g1)); return ' '.repeat(m.length); });
  };

  // Ordem importa: % antes de tudo (senão "90%" vira carga), depois as unidades
  // explícitas, e só então sobram os números soltos.
  take(new RegExp(PCT_RE.source, 'g'), pct);
  take(new RegExp(REPS_RE.source, 'gi'), reps);
  take(new RegExp(PLACA_RE.source, 'gi'), placa);
  take(new RegExp(KG_RE.source, 'gi'), kg);

  // Remove os trechos de técnica para que "drop 20kg 10" não vire série principal.
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

/**
 * Resolve o ano de cada data do arquivo.
 *
 * As anotações trazem só dia/mês. O histórico é cronológico, então o ano vira
 * quando o mês recua — mas um único mês digitado errado (um "01/12" perdido no
 * meio de janeiro) não pode arrastar todo o resto do arquivo um ano para frente.
 *
 * Por isso a resolução é feita DE TRÁS PARA FRENTE, ancorada na última data
 * (que é a mais recente e não pode estar no futuro), e um recuo de mês só conta
 * como virada de ano se as datas seguintes confirmarem a tendência.
 *
 * @returns {Map<number, string>} lineNo → data ISO
 */
function resolveYears(lines, defaultYear, warnings) {
  // ── coleta ──
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

  // ── âncora: a última data do arquivo é a mais recente ──
  // Parte sempre do ano corrente e recua até a data deixar de ser futura, para
  // que o fim do histórico caia o mais perto possível de hoje.
  const today = new Date();
  const last = found[found.length - 1];
  let year = last.explicitYear ?? today.getUTCFullYear();
  if (!last.explicitYear) {
    while (new Date(Date.UTC(year, last.month - 1, last.day)) > today) year--;
  }

  // ── passada de trás para frente ──
  const out = new Map();
  for (let i = found.length - 1; i >= 0; i--) {
    const cur = found[i];

    if (cur.explicitYear != null) {
      year = cur.explicitYear;
    } else if (i < found.length - 1) {
      const next = found[i + 1];
      // Indo para trás o mês deve cair ou ficar igual. Um mês MAIOR que o
      // seguinte indica virada de ano — mas só se confirmado pelas duas datas
      // seguintes, senão é typo isolado.
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

/**
 * Corrige datas isoladas fora da ordem cronológica — um mês digitado errado,
 * como o "01/12" que aparece no meio de fevereiro.
 *
 * A regra evita corrigir em cascata: só mexe na data do meio quando os dois
 * VIZINHOS estão em ordem entre si. Se prev < next e cur está fora desse
 * intervalo, o errado é cur, não a sequência inteira que vem depois.
 */
function fixOutliers(found, out, warnings) {
  for (let i = 1; i < found.length - 1; i++) {
    const prev = out.get(found[i - 1].lineNo);
    const cur = out.get(found[i].lineNo);
    const next = out.get(found[i + 1].lineNo);

    // Vizinhos desordenados: a suspeita recai sobre eles, não sobre cur.
    if (prev > next) continue;
    if (cur >= prev && cur <= next) continue;

    // Mantém o dia anotado e escolhe o mês do vizinho que encaixa no intervalo.
    const fixed = [prev, next]
      .map((ref) => {
        const [y, m] = ref.split('-').map(Number);
        return isoDate(y, m, found[i].day);
      })
      .find((cand) => cand >= prev && cand <= next);

    if (!fixed) continue; // nenhum encaixe plausível — deixa como está

    warnings.push({
      line: found[i].lineNo,
      text: `${pad2(found[i].day)}/${pad2(found[i].month)}`,
      reason: `fora da ordem cronológica — lida como ${fixed}`,
    });
    out.set(found[i].lineNo, fixed);
  }
}

// Uma virada de ano real é seguida por meses baixos e consistentes. Um typo
// isolado é cercado por meses do bloco original dos dois lados.
function isYearBoundary(found, i) {
  const cur = found[i];
  const after = found.slice(i + 1, i + 4).map((f) => f.month);
  const before = found.slice(Math.max(0, i - 3), i).map((f) => f.month);
  if (after.length === 0) return true;

  // Se algum mês ANTERIOR também é ≥ o mês atual, a sequência antes de `cur`
  // continua no mesmo ano — cur é parte do bloco antigo, não uma virada.
  const beforeAgrees = before.length === 0 || before.some((m) => m >= cur.month - 1);
  // E os meses seguintes precisam ser todos menores que o atual.
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

/**
 * Achata as sessões em um índice por exercício — forma usada pelos cálculos
 * de 1RM e pelo dashboard. Séries sem reps (não anotadas) são omitidas.
 */
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
        entry.sessions.push({
          date: s.date,
          load: set.perSide ? set.load : set.load, // carga anotada, tal como registrada
          reps: set.reps,
          bodyweight: !!set.bodyweight,
        });
      }
    }
  }
  return index;
}

// Ciclo PPL 2x com ondulação Força (A) / Hipertrofia (B).
//
// O ciclo avança por TREINO CONCLUÍDO, nunca por data de calendário: tirar um
// dia extra de descanso adia o próximo treino, não o pula.
//
// Os exercícios de cada dia não vêm de uma lista fixa — são extraídos do
// histórico real. O que o usuário de fato treina em dia de Push é o que aparece
// na tela de Push.

import { indexByExercise } from './parser.js';
import { normalizeExercise, movementsOf, contradicts } from './normalize.js';
import { prescribe } from './calc.js';
import { programFor, PROGRAM } from './program.js';
import { canonicalId } from './curation.js';
import { techniquePattern, techniquePlan } from './technique.js';

// Quantas séries de trabalho um exercício tem por padrão, quando o histórico
// não diz outra coisa.
const DEFAULT_SETS = 3;

export const CYCLE = [
  { slot: 'push', variant: 'A' },
  { slot: 'pull', variant: 'A' },
  { slot: 'legs', variant: 'A' },
  { slot: 'push', variant: 'B' },
  { slot: 'pull', variant: 'B' },
  { slot: 'legs', variant: 'B' },
];

export const SLOT_LABEL = { push: 'Push', pull: 'Pull', legs: 'Legs' };
export const VARIANT_LABEL = { A: 'Força', B: 'Hipertrofia' };

// Quantas sessões passadas do mesmo slot são consultadas para montar o dia.
const TEMPLATE_LOOKBACK = 4;

// Um treino real tem 6-9 exercícios. Sem teto, juntar várias sessões produz
// uma lista de 20+ que não corresponde a nenhum treino que ele de fato faz.
const MAX_EXERCISES = 9;

/**
 * Classifica uma sessão histórica pelo grupo dominante.
 * Core (abdominal/lombar) nunca decide o dia — é acessório de qualquer treino.
 */
export function classifySession(session) {
  const counts = { push: 0, pull: 0, legs: 0 };
  for (const e of session.exercises || []) {
    if (counts[e.group] != null) counts[e.group]++;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : null;
}

/**
 * Monta a lista de exercícios de um slot.
 *
 * A base é a ÚLTIMA sessão daquele slot — é o treino que ele de fato está
 * fazendo hoje, na ordem em que faz. As sessões anteriores só entram para
 * completar caso a última tenha sido curta, e sempre por frequência.
 */
export function templateForSlot(sessions, slot) {
  const ofSlot = sessions
    .filter((s) => s.date && classifySession(s) === slot)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, TEMPLATE_LOOKBACK);

  if (ofSlot.length === 0) return [];

  const [latest, ...previous] = ofSlot;
  const out = [];
  const taken = new Set();

  for (const e of latest.exercises) {
    if (taken.has(e.id)) continue;
    taken.add(e.id);
    out.push(e);
  }

  // Completa com o que se repete nas sessões anteriores, do mais frequente
  // para o menos, até o tamanho de um treino normal.
  if (out.length < MAX_EXERCISES) {
    const freq = new Map();
    for (const s of previous) {
      for (const e of s.exercises) {
        if (taken.has(e.id)) continue;
        const cur = freq.get(e.id) || { count: 0, exercise: e };
        cur.count++;
        freq.set(e.id, cur);
      }
    }
    const extras = [...freq.values()]
      .filter((v) => v.count >= 2) // apareceu em pelo menos duas sessões
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_EXERCISES - out.length);
    out.push(...extras.map((v) => v.exercise));
  }

  return out.slice(0, MAX_EXERCISES);
}

/**
 * Treino do dia: slot + variante da posição atual do ciclo, com cada exercício
 * já prescrito (carga alvo + faixa de reps).
 *
 * @param {{sessions:Array, cyclePosition:number}} state
 * @param {{referenceDate?:string, position?:number}} [opts]
 */
export function workoutForPosition(state, opts = {}) {
  const pos = opts.position ?? (state.cyclePosition || 0);
  const step = CYCLE[((pos % CYCLE.length) + CYCLE.length) % CYCLE.length];

  const history = state.sessions || [];
  const index = indexByExercise(history);

  // Quantas vezes este slot já foi treinado — define a rotação de 3 em 3
  // (flexora → flexora → stiff).
  const slotOccurrence = Math.floor(pos / CYCLE.length) * 2 + (step.variant === 'B' ? 1 : 0);

  const exercises = programFor(step.slot, step.variant, slotOccurrence).map((item) => {
    const found = resolveHistory(index, item);
    const base = found ?? { id: normalizeExercise(item.name).id, name: item.name, group: step.slot, sessions: [] };
    const p = prescribe(base, step.variant, {
      referenceDate: opts.referenceDate,
      repRange: item.repRange?.[step.variant],
    });

    // Exercícios de peso corporal e cardio não recebem carga alvo, mesmo que
    // exista número no histórico (barra fixa assistida, por exemplo).
    const noLoad = !!item.bodyweight || !!item.cardio;

    // Quantas séries e onde entram drop set / rest-pause, lidos do histórico
    // deste exercício — não de uma regra fixa.
    const plannedSets = typicalSetCount(history, base.id) || DEFAULT_SETS;
    const pattern = found ? techniquePattern(history, found.id) : { byPosition: new Map(), sampled: 0 };
    const techniques = techniquePlan(pattern, plannedSets);

    return {
      ...p,
      name: item.name,             // nome oficial do programa, não a grafia do caderno
      part: item.part,
      note: item.note ?? null,
      alt: item.alt ?? null,
      cardio: !!item.cardio,
      highRep: !!item.highRep,
      targetLoad: noLoad ? null : p.targetLoad,
      bodyweight: noLoad || p.bodyweight,
      matchedAs: found ? found.name : null,   // como foi localizado no histórico
      noHistory: !found,
      plannedSets,
      techniques,                  // [{setIndex, type, frequency}]
    };
  });

  return {
    position: pos,
    slot: step.slot,
    variant: step.variant,
    title: `${SLOT_LABEL[step.slot]} ${step.variant}`,
    subtitle: VARIANT_LABEL[step.variant],
    exercises,
    empty: exercises.length === 0,
  };
}

// Cobertura mínima do nome do programa para aceitar um exercício do histórico.
// "Barra Fixa Pegada Aberta" precisa achar "Barra Fixa Aberta" (3 de 4 palavras),
// mas não pode cair em qualquer coisa que tenha só "barra".
const MIN_MATCH = 0.5;

/**
 * Liga um exercício do programa ao histórico importado.
 *
 * O nome no programa é o oficial; no caderno ele aparece abreviado, com ordem
 * trocada e palavras a mais ou a menos. Em vez de exigir correspondência exata,
 * pontua a sobreposição de palavras e usa o volume de séries como desempate —
 * assim "Panturrilha Máquina" cai no aparelho principal, não numa variação
 * anotada duas vezes.
 */
/**
 * Quantas séries o exercício costuma ter — mediana das últimas vezes, para que
 * um dia atípico não desloque o número.
 */
function typicalSetCount(sessions, exerciseId) {
  const counts = [];
  for (const s of sessions || []) {
    for (const e of s.exercises || []) {
      if (e.id === exerciseId && (e.sets || []).length) counts.push(e.sets.length);
    }
  }
  if (counts.length === 0) return null;
  const recent = counts.slice(-8).sort((a, b) => a - b);
  return recent[Math.floor(recent.length / 2)];
}

/**
 * Resolve de onde vêm as cargas de um exercício do programa.
 * `hist: null` declara que o exercício é novo; uma string declara o alvo exato;
 * a ausência do campo cai no casamento automático.
 */
function resolveHistory(index, item) {
  if (item.hist === null) return null;
  if (typeof item.hist === 'string') {
    // canonicalId para que um alvo declarado com o nome antigo ("Serrote
    // Unilateral") continue achando o histórico depois da fusão.
    const byId = index.get(canonicalId(normalizeExercise(item.hist).id));
    if (byId) return byId;
  }
  return findInHistory(index, { match: item.hist ?? item.name, alt: item.alt });
}

function findInHistory(index, item) {
  const want = normalizeExercise(item.match);
  const direct = index.get(want.id);
  if (direct) return direct;

  const wanted = want.words;
  if (wanted.length === 0) return null;

  // O movimento tem que bater. Sem isso, o peso dado ao volume faz "Remada Alta"
  // cair em "Puxada Alta" só porque esta tem 108 séries e as duas terminam igual.
  const wantMoves = movementsOf(wanted);

  const scored = [...index.values()]
    .map((e) => {
      const norm = normalizeExercise(e.name);
      const words = new Set(norm.words);
      const moves = movementsOf(norm.words);
      const movesOk = wantMoves.size === 0 || [...wantMoves].some((m) => moves.has(m));
      const ok = movesOk && !contradicts(wanted, words);
      const hits = wanted.filter((w) => words.has(w)).length;
      const coverage = ok ? hits / wanted.length : 0;
      // Penaliza candidatos muito mais longos que o pedido (evita que
      // "Supino" case com "Supino Inclinado Halter Bem Alto").
      const excess = Math.max(0, words.size - wanted.length) / (wanted.length + 2);
      // O volume pesa alto de propósito: uma variação anotada 3 vezes há um ano
      // não pode vencer o aparelho principal com 72 séries só por ter uma
      // palavra a mais em comum. Satura em 20 séries.
      const volume = Math.min(1, e.sessions.length / 20);
      return { e, coverage, score: coverage - excess * 0.35 + volume * 0.6 };
    })
    .filter((c) => c.coverage >= MIN_MATCH)
    .sort((a, b) => b.score - a.score);

  if (scored.length) return scored[0].e;

  // Última tentativa: o alternativo declarado no programa (Y Raise, Esteira…).
  if (item.alt) return findInHistory(index, { match: item.alt });
  return null;
}

/** Prévia dos próximos N treinos do ciclo — usada no seletor da home. */
export function upcoming(state, n = 6, opts = {}) {
  const pos = state.cyclePosition || 0;
  return Array.from({ length: n }, (_, i) => {
    const step = CYCLE[(pos + i) % CYCLE.length];
    return {
      position: pos + i,
      slot: step.slot,
      variant: step.variant,
      title: `${SLOT_LABEL[step.slot]} ${step.variant}`,
      subtitle: VARIANT_LABEL[step.variant],
      isNext: i === 0,
    };
  });
}

/**
 * Deriva a posição inicial do ciclo a partir do histórico: continua de onde o
 * último treino registrado parou.
 */
export function inferStartPosition(sessions) {
  const dated = (sessions || []).filter((s) => s.date).sort((a, b) => a.date.localeCompare(b.date));
  const last = dated[dated.length - 1];
  if (!last) return 0;

  const slot = classifySession(last);
  if (!slot) return 0;

  // Assume que o último treino foi variante A se não houver registro explícito;
  // a partir do primeiro treino logado pela app a posição passa a ser exata.
  const variant = last.variant || 'A';
  const idx = CYCLE.findIndex((c) => c.slot === slot && c.variant === variant);
  return idx >= 0 ? idx + 1 : 0;
}

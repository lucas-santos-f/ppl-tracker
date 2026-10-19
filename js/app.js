// App shell: tab router + every screen. Plain DOM and template strings, no framework.

import { db } from './db.js';
import { parseHistory, indexByExercise } from './parser.js';
import { workoutForPosition, upcoming, inferStartPosition, CYCLE, SLOT_LABEL, VARIANT_LABEL,
  exerciseCatalog, identifyName, planFields, exactId } from './ppl.js';
import { planSummary } from './mainlift.js';
import { normalizeExercise, movementsOf } from './normalize.js';
import { bestOneRM, brzycki, tonnage, REP_RANGE, INTENSITY } from './calc.js';
import { syncVerify, syncPull, syncPush, SyncError } from './sync.js';
import { techniqueLabel, techniqueHint, TECHNIQUE_TYPES } from './technique.js';
import { classifySets, workSets, tonnage as setsTonnage } from './sets.js';
import { volumeOf, compareAtEqualSets, fmtVolume, fmtEffort, fmtPct } from './volume.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let state = db.load();
let pendingImport = null;
let draft = null;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, isError = false, action = null) {
  const el = $('#toast');
  el.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-act';
    b.textContent = action.label;
    b.addEventListener('click', () => { el.classList.remove('show', 'act'); action.fn(); });
    el.appendChild(b);
  }
  el.classList.toggle('err', isError);
  el.classList.toggle('act', !!action);
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show', 'act'), action ? 7000 : 2600);
}

// LOCAL date. toISOString() is UTC, so anything finished after 9pm in Brazil
// was being saved under tomorrow's date
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Every action that changes the workout (swap, remove a set, finish, skip,
// permanent edit) goes through undoable(). The toast offers Desfazer for 7s and
// the top of Today keeps the last one. Entries remember the cycle position:
// once you're on another workout they no longer apply.
const undoStack = [];

function undoable(label, undo) {
  const entry = { label, undo, pos: state.cyclePosition || 0 };
  undoStack.push(entry);
  if (undoStack.length > 20) undoStack.shift();
  toast(label, false, { label: 'Desfazer', fn: () => runUndo(entry) });
  updateUndoBar();
}

function runUndo(entry) {
  const i = undoStack.indexOf(entry);
  if (i < 0) return;
  undoStack.splice(i, 1);
  if (entry.pos !== (state.cyclePosition || 0)) {
    toast('Não dá mais para desfazer isso — o treino já mudou', true);
    updateUndoBar();
    return;
  }
  entry.undo();
  toast('Desfeito: ' + entry.label);
  updateUndoBar();
}

function updateUndoBar() {
  const slot = $('#undo-slot');
  if (!slot) return;
  const cur = state.cyclePosition || 0;
  const last = [...undoStack].reverse().find((u) => u.pos === cur);
  slot.innerHTML = last ? `<button class="btn ghost undo-bar" type="button">↶ Desfazer: ${esc(last.label)}</button>` : '';
  slot.firstElementChild?.addEventListener('click', () => runUndo(last));
}

function buildWorkout(custom = {}, extras = [], hidden = []) {
  const extraAlts = {};
  for (const [k, c] of Object.entries(custom || {})) if (c) extraAlts[k] = [c];
  return workoutForPosition(state, { extraAlts, extras, hidden });
}

function rebuildDraft() {
  const { logs, swaps, custom, mainMode, date, techs, extras, hidden } = draft;
  draft = { ...buildWorkout(custom, extras, hidden), logs, swaps: swaps || {}, custom: custom || {},
    mainMode: mainMode || {}, date, techs: techs || {}, extras: extras || [], hidden: hidden || [] };
}

function draftSnapshot() {
  return JSON.stringify({ logs: draft.logs, swaps: draft.swaps || {}, custom: draft.custom || {},
    mainMode: draft.mainMode || {}, date: draft.date, techs: draft.techs || {},
    extras: draft.extras || [], hidden: draft.hidden || [] });
}

function restoreDraft(snap) {
  const s = JSON.parse(snap);
  state = db.load();
  draft = { ...buildWorkout(s.custom, s.extras || [], s.hidden || []), ...s };
  persistDraft();
}

function reopenCard(defId) {
  $(`.ex[data-default="${CSS.escape(defId)}"]`)?.classList.add('open');
}

// window.confirm() is a silent no-op inside sandboxed iframes and looks out of
// place in a standalone PWA anyway
function confirmDialog(message, { danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-box">
        <p>${esc(message)}</p>
        <div class="btn-row">
          <button class="btn ghost" data-a="no">Cancelar</button>
          <button class="btn ${danger ? 'danger-solid' : 'primary'}" data-a="yes">Confirmar</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const close = (result) => { overlay.remove(); resolve(result); };
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) close(false);
      const a = ev.target.dataset?.a;
      if (a === 'yes') close(true);
      if (a === 'no') close(false);
    });
  });
}

function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${fmtDate(iso.slice(0, 10))} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function show(view) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  $$('.tabbar button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)));
  window.scrollTo(0, 0);
  if (view === 'today') renderToday();
  if (view === 'dash') renderDash();
  if (view === 'vol') renderVolumeTab();
  if (view === 'hist') renderHistory();
  if (view === 'settings') renderSettings();
}

$$('.tabbar button').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));

// volume tab: workouts listed, and same-group workouts compared on Today
const VOL_SESSIONS = 10;
const VOL_SLOT_DAYS = 5;

let volSlotFilter = 'all';

function majorityGroup(exs) {
  const n = new Map();
  for (const e of exs) {
    if (!e.group || e.group === 'daily') continue;
    n.set(e.group, (n.get(e.group) || 0) + e.sets.length);
  }
  let best = null;
  for (const [g, k] of n) if (!best || k > best[1]) best = [g, k];
  return best ? best[0] : null;
}

function volSessions(history) {
  return (history || [])
    .filter((s) => s.date)
    .map((s) => {
      const exercises = (s.exercises || []).map((e) => {
        const sets = workSets(e.sets || [])
          .map((x) => ({ load: x.load || 0, reps: x.reps || 0, techniques: x.techniques || null }));
        return { id: e.id, name: e.name, group: e.group, sets, volume: volumeOf(sets) };
      }).filter((e) => e.sets.length);
      return {
        date: s.date,
        slot: s.slot || majorityGroup(exercises),
        variant: s.variant || null,
        exercises,
        volume: exercises.reduce((t, e) => t + e.volume, 0),
      };
    })
    .filter((s) => s.exercises.length)
    .sort((a, b) => b.date.localeCompare(a.date));
}

// only exercises present on both days, each at the sets both have. Otherwise
// swapping an exercise shows up as a volume jump
function compareSessions(now, prev) {
  if (!now || !prev) return null;
  const byId = new Map(prev.exercises.map((e) => [e.id, e]));
  let a = 0; let b = 0; let n = 0;
  for (const e of now.exercises) {
    const p = byId.get(e.id);
    if (!p) continue;
    const c = compareAtEqualSets(e.sets, p.sets);
    if (!c) continue;
    a += c.now; b += c.prev; n++;
  }
  if (!n) return null;
  return { now: a, prev: b, diff: a - b, pct: b > 0 ? ((a - b) / b) * 100 : null, exercises: n };
}

const pctCls = (pct) => (pct == null ? '' : pct > 0.5 ? 'up' : pct < -0.5 ? 'down' : '');

const volHeadRow = (firstCol = 'dia') => `
  <div class="vol-row cols">
    <span class="d">${esc(firstCol)}</span>
    <span class="n">séries</span>
    <span class="v">volume</span>
    <span class="p">vs anterior</span>
  </div>`;

const setsLine = (sets) => setsTxt(sets, null);

function renderVolumeTab() {
  const root = $('#vol-content');
  const sessions = volSessions(state.sessions || []);

  if (!sessions.length) {
    root.innerHTML = `<div class="empty"><div class="big">🏗️</div>
      <p>Sem dados ainda.<br>Importe ou registre um treino para ver o volume.</p></div>`;
    $('#vol-range').textContent = '';
    return;
  }
  $('#vol-range').textContent = `${sessions.length} treinos`;

  const filtered = volSlotFilter === 'all' ? sessions : sessions.filter((s) => s.slot === volSlotFilter);
  const shown = filtered.slice(0, VOL_SESSIONS);

  // previous workout of the SAME group, Push vs Legs says nothing
  const prevOf = (s) => sessions.find((o) => o.date < s.date && o.slot === s.slot);

  const exRow = (e, prevEx) => {
    const c = prevEx ? compareAtEqualSets(e.sets, prevEx.sets) : null;
    const tip = c ? `comparado em ${c.usedSets} séries` : 'sem este exercício no treino anterior';
    return `<div class="vol-row">
      <span class="d">${esc(e.name)}</span>
      <span class="n">${e.sets.length}×</span>
      <span class="v">${esc(fmtEffort(e.sets))}</span>
      <span class="p ${pctCls(c?.pct)}" title="${esc(tip)}">${c ? esc(fmtPct(c.pct)) : ''}</span>
      <span class="s">${esc(setsLine(e.sets))}</span>
    </div>`;
  };

  const card = (s) => {
    const prev = prevOf(s);
    const cmp = compareSessions(s, prev);
    const byId = new Map((prev?.exercises || []).map((e) => [e.id, e]));
    const groupLabel = SLOT_LABEL[s.slot] ?? 'sem grupo';

    const vs = cmp ? `${fmtPct(cmp.pct)} vs ${fmtDate(prev.date)}`
      : prev ? 'sem exercício em comum' : 'primeiro treino do grupo';
    return `<div class="vol-card">
      <div class="vol-card-h">
        <div class="vol-when">
          <b>${esc(fmtDate(s.date))}</b>
          <small>${esc(groupLabel)}${s.variant ? ` ${esc(s.variant)}` : ''} · ${s.exercises.length} exercícios</small>
        </div>
        <div class="vol-total">
          <b>${s.volume > 0 ? esc(fmtVolume(s.volume)) : '—'}</b>
          <small class="${pctCls(cmp?.pct)}">${esc(vs)}</small>
        </div>
      </div>
      <div class="vol">${volHeadRow('exercício')}${s.exercises.map((e) => exRow(e, byId.get(e.id))).join('')}</div>
    </div>`;
  };

  const segBtn = (v, label) => `<button class="${volSlotFilter === v ? 'on' : ''}" data-slot="${v}">${esc(label)}</button>`;

  root.innerHTML = `
    <div class="seg seg-4">
      ${segBtn('all', 'Todos')}${segBtn('push', 'Push')}${segBtn('pull', 'Pull')}${segBtn('legs', 'Legs')}
    </div>
    <div class="legend">
      <p><b>Volume</b> = carga × repetições de todas as séries de trabalho,
      somando o que foi feito nas técnicas (drop set, rest-pause, cluster). O
      aquecimento fica de fora.</p>
      <p><b>+8% / −3%</b> = variação em relação ao treino anterior do mesmo
      grupo, calculada <b>no mesmo número de séries</b>: se o anterior teve 4
      séries e este teve 5, a quinta não entra na conta.</p>
      <p>No total do treino entram só os exercícios presentes nos dois dias —
      exercício que entrou ou saiu não vira ganho nem perda.</p>
      <p>Exercício <b>sem carga</b> (barra fixa, paralela, abdominal) não tem
      tonelagem: ali a conta é o total de repetições, e ele não soma no total
      em kg do treino.</p>
    </div>
    ${shown.map(card).join('')}
    ${filtered.length > shown.length
      ? `<p class="hint">Mostrando os ${shown.length} mais recentes de ${filtered.length}.</p>` : ''}
  `;

  $$('[data-slot]', root).forEach((b) => b.addEventListener('click', () => {
    volSlotFilter = b.dataset.slot;
    renderVolumeTab();
  }));
}

function slotVolumeHTML(w) {
  const sessions = volSessions(state.sessions || []).filter((s) => s.slot === w.slot);
  const todayVol = w.exercises.reduce((t, e) => t + volumeOf(todaySets(activeEx(e).exerciseId)), 0);
  const pastDays = sessions.filter((s) => s.date !== todayISO()).slice(0, VOL_SLOT_DAYS);
  if (!pastDays.length && !todayVol) return '';

  const row = (label, vol, nSets, cmp, cls) => `<div class="vol-row ${cls || ''}">
    <span class="d">${esc(label)}</span>
    <span class="n">${nSets}×</span>
    <span class="v">${esc(fmtVolume(vol))}</span>
    <span class="p ${pctCls(cmp?.pct)}">${cmp ? esc(fmtPct(cmp.pct)) : ''}</span>
  </div>`;

  const lines = [];
  if (todayVol > 0) {
    const prev = pastDays[0];
    let a = 0; let b = 0;
    if (prev) {
      const byId = new Map(prev.exercises.map((e) => [e.id, e]));
      for (const e of w.exercises) {
        const id = activeEx(e).exerciseId;
        const p = byId.get(id);
        if (!p) continue;
        const c = compareAtEqualSets(todaySets(id), p.sets);
        if (!c) continue;
        a += c.now; b += c.prev;
      }
    }
    const nToday = w.exercises.reduce((t, e) => t + todaySets(activeEx(e).exerciseId).length, 0);
    lines.push(row('hoje', todayVol, nToday, b > 0 ? { pct: ((a - b) / b) * 100 } : null, 'now'));
  }
  const nSets = (s) => s.exercises.reduce((t, e) => t + e.sets.length, 0);
  pastDays.forEach((s, i) => lines.push(row(fmtDate(s.date), s.volume, nSets(s), compareSessions(s, pastDays[i + 1]))));

  return `<div class="vol-box-day"><div class="vol">
    <div class="vol-head">Volume do treino · ${esc(SLOT_LABEL[w.slot] ?? '')}
      <span>peso total movido (carga × repetições) nos últimos ${pastDays.length} treinos deste grupo</span></div>
    ${volHeadRow()}
    ${lines.join('')}
  </div></div>`;
}

function renderToday() {
  const root = $('#today-content');
  $('#today-date').textContent = fmtDate(todayISO());

  if (!state.sessions || state.sessions.length === 0) {
    root.innerHTML = `
      <div class="empty">
        <div class="big">📋</div>
        <p>Nenhum histórico ainda.<br>Importe seus treinos para começar.</p>
        <button class="btn primary" id="go-import">Importar histórico</button>
      </div>`;

    // no inline onclick, the CSP in _headers blocks it
    $('#go-import').addEventListener('click', () => show('import'));
    return;
  }

  // finishing moves the cycle, so Today switches to the NEXT workout. Without this
  // block what you just did disappeared from the screen, even though it was saved
  const doneToday = (state.sessions || []).filter((s) => s.date === todayISO() && s.logged);

  if (!draft) {
    const saved = db.loadDraft();
    const samePos = saved && saved.position === (state.cyclePosition || 0);

    // draft from an earlier day that never got "Concluir treino". Can't be ignored:
    // the first number typed today would overwrite it. Keeps its original date.
    const leftover = samePos && saved.date && saved.date < todayISO()
      && Object.values(saved.logs || {}).some((l) => l?.sets?.some((s) => s?.reps))
      && !(state.sessions || []).some((s) => s.date === saved.date && s.logged);
    const sameWorkout = samePos && (saved.date === todayISO() || leftover);
    const custom = sameWorkout ? (saved.custom || {}) : {};
    const extras = sameWorkout ? (saved.extras || []) : [];
    const hidden = sameWorkout ? (saved.hidden || []) : [];
    draft = {
      ...buildWorkout(custom, extras, hidden),
      date: leftover ? saved.date : undefined,
      techs: sameWorkout ? (saved.techs || {}) : {},
      extras,
      hidden,
      logs: sameWorkout ? (saved.logs || {}) : {},
      swaps: sameWorkout ? (saved.swaps || {}) : {},
      custom,
      mainMode: sameWorkout ? (saved.mainMode || {}) : {},
    };
  }
  const w = draft;

  if (w.empty) {
    root.innerHTML = `
      <div class="empty">
        <div class="big">🤔</div>
        <p>Nenhum treino de <b>${esc(SLOT_LABEL[w.slot])}</b> encontrado no histórico,
        então não há de onde tirar a lista de exercícios.</p>
        <button class="btn ghost" id="skip-day">Pular para o próximo treino</button>
      </div>`;
    $('#skip-day').addEventListener('click', advanceCycle);
    return;
  }

  const isForca = w.variant === 'A';

  // The header describes the DAY's rep range. The heavy opener on B is called out
  // separately, or the card would say 5-8 for a 10-15 day. And it isn't always
  // exercise 1: on Pull B pull-ups open with no load and the row carries it.
  const [lo, hi] = REP_RANGE[w.variant];
  const heavy = isForca ? null : w.exercises.find((e) => !e.mainPlan && e.repRange && e.repRange[1] < lo);
  const main = w.exercises.map(activeEx).find((e) => e.activePlan);

  const done = draft.exercises
    .filter((e) => draft.logs[activeEx(e).exerciseId]?.sets?.some((s) => s?.reps)).length;

  root.innerHTML = `
    <div id="undo-slot"></div>
    ${doneToday.map(finishedCard).join('')}

    ${w.date ? `<div class="hint pending">
      ⚠️ Treino de <b>${esc(w.date.split('-').reverse().slice(0, 2).join('/'))}</b> ficou sem
      <b>Concluir treino</b>. Confira e conclua — ele entra no histórico com a data
      de ${esc(w.date.split('-').reverse().slice(0, 2).join('/'))}.
      <button class="btn ghost" id="discard-old" type="button" style="margin-top:8px">Descartar este rascunho</button>
    </div>` : ''}

    <div class="day-card" data-variant="${w.variant}">
      <p class="slot">${esc(w.title)}</p>
      <div class="range">
        Alvo de ${lo}–${hi} reps · ${Math.round(INTENSITY[w.variant] * 100)}% da 1RM estimada
      </div>
      ${main ? `<div class="range" style="margin-top:6px">
        Lift principal: <b>${esc(main.name)}</b> · ${esc(mainPlanTxt(main.activePlan))}
      </div>` : ''}
      ${heavy ? `<div class="range" style="margin-top:6px">
        Bloco pesado: ${esc(heavy.name)} em ${heavy.repRange[0]}–${heavy.repRange[1]} reps
      </div>` : ''}
      <div class="range" id="ex-count" style="margin-top:6px">
        ${done}/${w.exercises.length} exercícios registrados
      </div>
    </div>

    <div id="day-vol">${slotVolumeHTML(w)}</div>

    <div id="ex-list">
      ${w.exercises.map((e, i) => exerciseCard(activeEx(e), i, w.variant)).join('')}
    </div>

    <button class="btn ghost add-ex-btn" id="add-ex" type="button">
      <span class="plus">+</span> Adicionar exercício
    </button>

    ${done > 0 ? `<p class="hint pending">
      Preenchido mas ainda não concluído. Já está salvo (e sincroniza com o outro
      aparelho), mas só entra no histórico depois de <b>Concluir treino</b>.
    </p>` : ''}

    <button class="btn ${isForca ? 'forca' : 'hiper'}" id="finish">Concluir treino</button>
    <button class="btn ghost" id="skip">Pular este treino (adiar)</button>
  `;

  wireExerciseCards();
  updateUndoBar();
  $('#finish').addEventListener('click', finishWorkout);
  $('#add-ex')?.addEventListener('click', openAddDialog);
  $('#skip').addEventListener('click', advanceCycle);
  $('#discard-old')?.addEventListener('click', () => {
    const saved = db.loadDraft();
    db.clearDraft();
    draft = null;
    undoable('Rascunho antigo descartado', () => { if (saved) db.saveDraft(saved); draft = null; renderToday(); });
    renderToday();
  });
  $$('.reopen').forEach((b) => b.addEventListener('click', () => reopenWorkout(b.dataset.date)));
}

function sessionRowsHTML(session) {
  return (session.exercises || []).map((e) => {
    const sets = (e.sets || []).map((s) => {
      const t = (s.techniques || [])[0]?.type;
      return (s.load ? `${fmtKg(s.load)}×${s.reps}` : `${s.reps}`) + (t ? ` [${techniqueLabel(t)}]` : '');
    }).join('  ');
    return `<div class="done-row"><span class="dn">${esc(e.name)}</span><span class="ds">${esc(sets)}</span></div>`;
  }).join('');
}

function finishedCard(session) {
  const lines = sessionRowsHTML(session);

  return `
    <div class="day-card done-card" data-variant="${esc(session.variant || 'A')}">
      <div class="focus">✓ Concluído hoje${session.slot ? ' · ' + esc(SLOT_LABEL[session.slot] ?? '') : ''}</div>
      <div class="done-list">${lines}</div>
      <button class="btn ghost reopen" data-date="${esc(session.date)}" style="margin-top:12px">
        Reabrir para corrigir
      </button>
    </div>`;
}

async function reopenWorkout(date) {
  const session = (state.sessions || []).find((s) => s.date === date && s.logged);
  if (!session) return;

  const ok = await confirmDialog('Reabrir este treino para corrigir os números?');
  if (!ok) return;

  const pos = Math.max(0, (state.cyclePosition || 0) - 1);
  db.setCyclePosition(pos);
  state = db.load();

  const w = buildWorkout({});
  const logs = {};
  const swaps = {};
  const custom = {};
  const techs = {};
  const extras = [];
  for (const e of session.exercises || []) {
    logs[e.id] = { sets: e.sets.map((s) => ({ load: s.load || null, reps: s.reps })) };
    e.sets.forEach((st, si) => {
      const t = (st.techniques || [])[0]?.type;
      if (t) (techs[e.id] ||= {})[si] = t;
    });
    if (w.exercises.some((d) => d.exerciseId === e.id)) continue;

    // a logged variation reopens with the swap already selected, otherwise the
    // program card comes back empty and the numbers sit outside the list
    let owner = w.exercises.find((d) => (d.variants || []).some((v) => v.exerciseId === e.id))
      || (e.slotKey && w.exercises.find((d) => d.key === e.slotKey));

    // ...unless that card was logged itself, or a swap would eat its numbers
    if (owner && (session.exercises.some((x) => x.id === owner.exerciseId) || swaps[owner.exerciseId])) owner = null;

    // added with "+", not in any card: comes back as an extra
    if (!owner) { extras.push({ name: e.name, histId: e.id }); continue; }
    swaps[owner.exerciseId] = e.id;
    if (!(owner.variants || []).some((v) => v.exerciseId === e.id)) custom[owner.key] = { name: e.name, histId: e.id };
  }
  draft = { ...buildWorkout(custom, extras), logs, swaps, custom, techs, extras };
  persistDraft();
  renderToday();
  toast('Treino reaberto — conclua de novo ao terminar');
}

function activeEx(e) {
  const variants = e.variants || [];
  const pick = draft.swaps?.[e.exerciseId];
  const chosen = pick && pick !== e.exerciseId && variants.find((v) => v.exerciseId === pick);
  let base = chosen || e;

  const testing = base.mainPlan?.test && draft.mainMode?.[e.key] === 'test';
  if (testing) base = { ...base, ...planFields(base.mainPlan.test) };
  return { ...base, variants, defaultId: e.exerciseId, defaultName: e.name, isSwapped: !!chosen,
    key: e.key, replacedFrom: chosen ? null : (e.replacedFrom ?? null), testing };
}

function exByActiveId(id) {
  for (const e of draft.exercises) {
    const a = activeEx(e);
    if (a.exerciseId === id) return a;
  }
  return null;
}

function exerciseCard(e, i, variant) {
  const log = draft.logs[e.exerciseId] || { sets: [] };
  const isDone = log.sets.some((s) => s.reps);
  const [lo, hi] = e.repRange;

  const targetHTML = e.targetLoad != null
    ? `<div class="kg">${e.targetLoad}<span style="font-size:13px">kg</span></div>`
    : `<div class="kg bw">${
        e.logStyle === 'minutes' ? 'minutos'
        : e.logStyle === 'seconds' ? 'segundos'
        : e.logStyle === 'reps' ? 'só reps'
        : e.bodyweight ? 'peso corporal'
        : e.noHistory ? 'definir' : 'peso corporal'
      }</div>`;

  // formula asked for more than anything ever lifted on this exercise
  const cappedNote = e.capped
    ? `<div class="hint capped">⚠︎ A fórmula pedia <b>${e.uncappedLoad}kg</b>, acima do seu recorde
       de <b>${e.bestLoad}kg</b>. Limitado a +10% do recorde.</div>`
    : '';

  const rows = setsHTML(e);
  const plan = e.activePlan;

  const variants = e.variants || [];
  const optLabel = (v) => `${v.name} — ${v.custom ? 'só hoje, ' : ''}${v.noHistory ? 'sem histórico, você preenche' : `${v.histSamples}× no seu histórico`}`;
  const swapHTML = `${variants.length ? `
    <div class="swap">
      <label for="swap-${esc(e.defaultId)}">Exercício</label>
      <select class="ex-swap" id="swap-${esc(e.defaultId)}" data-default="${esc(e.defaultId)}">
        <option value="${esc(e.defaultId)}"${!e.isSwapped ? ' selected' : ''}>${esc(e.defaultName)} — do treino de hoje</option>
        ${variants.map((v) => `<option value="${esc(v.exerciseId)}"${e.isSwapped && e.exerciseId === v.exerciseId ? ' selected' : ''}>${esc(optLabel(v))}</option>`).join('')}
        <option value="__all">Ver todos os exercícios de ${esc(SLOT_LABEL[draft.slot] ?? 'hoje')}…</option>
      </select>
    </div>` : ''}
    <button class="link-btn ex-change" type="button">⇄ Ver todos os exercícios de ${esc(SLOT_LABEL[draft.slot] ?? 'hoje')}…</button>
    <button class="link-btn danger-link ex-remove" type="button">🗑 Remover este exercício…</button>
    ${e.replacedFrom ? `<div class="hint note">Troca definitiva: entrou no lugar de <b>${esc(e.replacedFrom)}</b>.
      Para voltar, Ajustes → Alterações do programa.</div>` : ''}`;

  return `
    <div class="ex ${isDone ? 'done' : ''} ${e.isSwapped ? 'swapped' : ''}" data-variant="${variant}" data-id="${esc(e.exerciseId)}" data-default="${esc(e.defaultId ?? e.exerciseId)}">
      <div class="ex-head">
        <div class="check">✓</div>
        <div class="ex-name">
          <div class="part">${esc(e.part ?? '')}</div>
          <div class="n">${esc(e.name)}</div>
          <div class="sub">${
            plan ? (e.mainPlan.calibrate
              ? 'calibração — sem 1RM recente'
              : `1RM est. ${e.oneRM}kg · ${esc(plan.label)}`)
            : e.isSwapped ? (e.noHistory ? 'variação — sem histórico, preencha as cargas'
              : `variação do seu histórico${e.oneRM ? ` · 1RM est. ${e.oneRM}kg` : ''}`)
            : e.daily ? 'rotina diária — todos os treinos'
            : e.noHistory ? 'exercício novo — sem histórico'
            : e.oneRM ? `1RM est. ${e.oneRM}kg` : 'peso corporal'
          }${e.stale ? ' · desatualizada' : ''}</div>
        </div>
        <div class="target">
          ${plan && e.targetLoad == null ? '<div class="kg bw">calibrar</div>' : targetHTML}
          <div class="reps">${plan ? esc(planSummary(plan))
            : e.cardio || e.logStyle ? '' : `${e.capped ? '⚠︎ ' : ''}${lo}–${hi} reps`}</div>
        </div>
      </div>
      <div class="ex-body">
        ${swapHTML}
        ${e.alert ? `<div class="hint alert">⚠︎ ${esc(e.alert)}</div>` : ''}
        ${e.note ? `<div class="hint note">${esc(e.note)}</div>` : ''}
        ${commentHTML(e)}
        ${e.matchedAs && e.matchedAs !== e.name
          ? `<div class="hint">Histórico de <b>${esc(e.matchedAs)}</b></div>` : ''}
        <div class="vol-box">${volumeHTML(e)}</div>
        ${cappedNote}
        ${plan ? mainPlanHTML(e, plan) : ''}
        <div class="sets">${rows}</div>
        <div class="bulk">
          <button class="icon-btn add-set">+ série</button>
          <button class="icon-btn fill-load" type="button" title="repete a carga nas séries vazias">⤓ mesma carga</button>
          ${e.lastSets.length ? '<button class="icon-btn fill-last" type="button" title="preenche as séries vazias com a carga, as reps e a técnica do último treino deste exercício — para não digitar tudo de novo quando o treino repete">↺ repetir o último treino</button>' : ''}
          <button class="icon-btn bulk-tech" type="button" title="marcar técnica em várias séries">⚡ técnica</button>
        </div>
      </div>
    </div>`;
}

function todaySets(exId) {
  const log = draft.logs[exId] || { sets: [] };
  const marks = draft.techs?.[exId] || {};
  return log.sets
    .map((x, i) => (x && x.reps > 0
      ? { load: x.load || 0, reps: x.reps, techniques: marks[i] ? [{ type: marks[i] }] : null }
      : null))
    .filter(Boolean);
}

// "30kg×4 +20kg×7": technique reps shown with the set, or the line's volume doesn't add up
function setTxt(x, logStyle) {
  const base = logStyle ? `${x.reps}` : (x.load ? `${x.load}kg×${x.reps}` : `${x.reps}`);
  const extra = (x.techniques || [])
    .filter((t) => t && t.reps)
    .map((t) => (t.load ?? x.load ? `+${t.load ?? x.load}kg×${t.reps}` : `+${t.reps}`))
    .join(' ');
  return extra ? `${base} ${extra}` : base;
}

const setsTxt = (sets, logStyle) => sets.map((x) => setTxt(x, logStyle)).join(' · ');

function volumeHTML(e) {
  const days = e.lastDays || [];
  const nowSets = todaySets(e.exerciseId);
  if (!days.length && !nowSets.length) return '<div class="hint">Primeira vez neste exercício — sem histórico para comparar.</div>';

  const row = (label, sets, cmp, cls = '') => {
    const vol = e.logStyle ? null : fmtEffort(sets);
    const pctCls = !cmp || cmp.pct == null ? '' : cmp.pct > 0.5 ? 'up' : cmp.pct < -0.5 ? 'down' : '';
    const title = cmp ? `comparado em ${cmp.usedSets} ${cmp.usedSets === 1 ? 'série' : 'séries'}` : '';
    return `<div class="vol-row ${cls}">
      <span class="d">${esc(label)}</span>
      <span class="n">${sets.length}×</span>
      <span class="v">${vol == null ? '' : esc(vol)}</span>
      <span class="p ${pctCls}" title="${esc(title)}">${cmp ? esc(fmtPct(cmp.pct)) : ''}</span>
      <span class="s">${esc(setsTxt(sets, e.logStyle))}</span>
    </div>`;
  };

  const lines = [];
  if (nowSets.length) lines.push(row('hoje', nowSets, days[0] ? compareAtEqualSets(nowSets, days[0].sets) : null, 'now'));
  days.forEach((d, i) => {
    const prev = days[i + 1];
    lines.push(row(fmtDate(d.date), d.sets, prev ? compareAtEqualSets(d.sets, prev.sets) : null));
  });

  return `<div class="vol">
    <div class="vol-head">${e.logStyle ? 'Últimas vezes' : 'Volume por treino'}
      <span>${e.logStyle ? ''
        : 'volume = peso × repetições de todas as séries. A % compara com o treino de baixo, usando só as séries que os dois têm.'}</span></div>
    ${e.logStyle ? '' : volHeadRow()}
    ${lines.join('')}
  </div>`;
}

function refreshVolume(card, exId) {
  const box = $('.vol-box', card);
  const ex = exByActiveId(exId);
  if (box && ex) box.innerHTML = volumeHTML(ex);
  const dayVolEl = $('#day-vol');
  if (dayVolEl && draft) dayVolEl.innerHTML = slotVolumeHTML(draft);
}

const DEFAULT_COMMENTS = {
  'banco-cavalo-peito-remada': 'Ficar na ponta dos pés pra fixar bem o tronco e tirar pressão do peito no banco',
};

function exerciseComment(id) {
  const n = state.exerciseNotes?.[id];
  return n ? n.text : (DEFAULT_COMMENTS[id] || '');
}

function commentHTML(e) {
  const text = exerciseComment(e.exerciseId);
  return `<div class="ex-comment">${text
    ? `<div class="hint comment">💬 ${esc(text)}</div>
       <button class="link-btn comment-edit" type="button">✎ editar comentário</button>`
    : '<button class="link-btn comment-edit" type="button">💬 adicionar comentário</button>'}</div>`;
}

function editComment(card, id) {
  const box = $('.ex-comment', card);
  const before = exerciseComment(id);
  box.innerHTML = `
    <textarea class="comment-input" rows="3" placeholder="Fica salvo e aparece toda vez que este exercício for carregado">${esc(before)}</textarea>
    <div class="bulk">
      <button class="icon-btn comment-save" type="button">Salvar</button>
      <button class="icon-btn comment-cancel" type="button">Cancelar</button>
    </div>`;
  const ta = $('.comment-input', box);
  ta.focus();
  $('.comment-cancel', box).addEventListener('click', () => { box.outerHTML = commentHTML({ exerciseId: id }); bindComment(card, id); });
  $('.comment-save', box).addEventListener('click', () => {
    const text = ta.value.trim();
    const res = db.setExerciseNote(id, text);
    if (!res.ok) { toast('Erro ao salvar: ' + res.error, true); return; }
    state = db.load();
    $('.ex-comment', card).outerHTML = commentHTML({ exerciseId: id });
    bindComment(card, id);
    undoable(text ? 'Comentário salvo' : 'Comentário apagado', () => {
      db.setExerciseNote(id, before);
      state = db.load();
      renderToday();
      reopenCard(card.dataset.default);
    });
  });
}

function bindComment(card, id) {
  $('.comment-edit', card)?.addEventListener('click', () => editComment(card, id));
}

function mainPlanHTML(e, plan) {
  const row = (x, work) => {
    const pct = x.pct == null ? null : Math.round(x.pct * 100);
    return `
      <div class="plan-row ${work ? 'work' : ''}">
        <div class="plan-bar"><span style="width:${pct == null ? 0 : Math.min(100, pct)}%"></span></div>
        <div class="plan-pct">${pct == null ? '—' : pct + '%'}</div>
        <div class="plan-kg">${x.load != null ? x.load + 'kg' : ''}</div>
        <div class="plan-reps">× ${x.reps}${x.amrap ? '+' : ''}</div>
        ${x.label ? `<div class="plan-label">${esc(x.label)}</div>` : ''}
      </div>`;
  };
  const test = e.mainPlan.test;
  const toggle = test ? `
    <div class="plan-mode">
      <button type="button" class="plan-toggle ${e.testing ? '' : 'on'}" data-mode="normal">${esc(e.mainPlan.normal.label)}</button>
      <button type="button" class="plan-toggle ${e.testing ? 'on' : ''}" data-mode="test">${esc(test.label)}</button>
    </div>` : '';
  const basis = e.mainPlan.basedOn
    ? `<div class="hint">1RM estimada a partir de <b>${e.mainPlan.basedOn.load}kg × ${e.mainPlan.basedOn.reps}</b> (${fmtDate(e.mainPlan.basedOn.date)}).</div>`
    : `<div class="hint note">Sem série pesada nas últimas 8 semanas: suba a carga até um 5 pesado com técnica limpa. É ele que define as porcentagens dos próximos treinos.</div>`;
  return `
    ${toggle}
    ${basis}
    <div class="plan">
      <div class="plan-h">Séries de trabalho</div>
      ${plan.work.map((x) => row(x, true)).join('')}
    </div>`;
}

function rowTarget(e, si) {
  const w = e.activePlan?.work;
  if (w) {
    const x = w[Math.min(si, w.length - 1)];
    return { load: x.load, lo: x.reps, hi: x.reps, amrap: !!x.amrap };
  }
  return { load: e.targetLoad, lo: e.repRange[0], hi: e.repRange[1], amrap: false };
}

function techBtn(si, marked, suggested) {
  if (marked) {
    return `<button type="button" class="tech-tag mark" data-type="${esc(marked)}" data-tech="${si}"
      title="tocar para trocar ou tirar">${esc(techniqueLabel(marked))}</button>`;
  }
  if (suggested) {
    return `<button type="button" class="tech-tag sug" data-type="${esc(suggested)}" data-tech="${si}"
      title="sugerido pelo seu histórico — tocar para confirmar ou trocar">${esc(techniqueLabel(suggested))} ?</button>`;
  }
  return `<button type="button" class="tech-tag add" data-tech="${si}" title="marcar técnica nesta série">+ técnica</button>`;
}

function setsHTML(e) {
  const log = draft.logs[e.exerciseId] || { sets: [] };
  const n = Math.max(log.sets.length, e.plannedSets ?? 3);
  return Array.from({ length: n }, (_, si) => setRow(e, si, log.sets[si])).join('');
}

function setRow(e, si, saved) {
  const load = saved?.load ?? '';
  const reps = saved?.reps ?? '';
  const t = rowTarget(e, si);
  const { lo } = t;
  const hit = reps === '' ? '' : (Number(reps) >= lo ? 'yes' : 'no');
  const loadPlaceholder = t.load != null ? t.load : '—';

  const marked = draft.techs?.[e.exerciseId]?.[si] || null;
  const tech = (e.techniques || []).find((x) => x.setIndex === si);
  const techTag = t.amrap
    ? `<div class="tech-tag" data-type="amrap">máx. reps</div>${techBtn(si, marked, null)}`
    : techBtn(si, marked, tech ? tech.type : null);

  if (e.logStyle) {
    const unit = e.logStyle === 'minutes' ? 'min' : e.logStyle === 'seconds' ? 'seg' : 'reps';
    const ph = e.logStyle === 'minutes' ? '10' : e.logStyle === 'seconds' ? '60' : '10';
    return `
      ${techTag}
      <div class="set-row single" data-set="${si}">
        <div class="idx">${si + 1}</div>
        <div class="field">
          <input type="number" inputmode="numeric" class="in-reps"
                 value="${reps}" placeholder="${ph}" aria-label="${unit} série ${si + 1}">
          <span class="unit">${unit}</span>
        </div>
        <button class="icon-btn del-set" aria-label="remover série">×</button>
      </div>`;
  }

  return `
    ${techTag}
    <div class="set-row" data-set="${si}">
      <div class="idx">${si + 1}</div>
      <div class="field">
        <input type="number" inputmode="decimal" step="0.5" class="in-load"
               value="${load}" placeholder="${loadPlaceholder}" aria-label="carga série ${si + 1}">
        <span class="unit">kg</span>
      </div>
      <div class="field">
        <input type="number" inputmode="numeric" class="in-reps"
               value="${reps}" placeholder="—" data-hit="${hit}" aria-label="reps série ${si + 1}">
        <span class="unit">reps</span>
      </div>
      <button class="icon-btn del-set" aria-label="remover série">×</button>
    </div>`;
}

function wireExerciseCards() {
  $$('.ex').forEach((card) => {
    const id = card.dataset.id;

    $('.ex-head', card).addEventListener('click', () => card.classList.toggle('open'));

    const swap = $('.ex-swap', card);
    if (swap) swap.addEventListener('change', () => {
      const def = card.dataset.default;
      if (swap.value === '__all') {
        swap.value = activeEx(draft.exercises.find((x) => x.exerciseId === def)).exerciseId;
        openChangeDialog(def);
        return;
      }
      const snap = draftSnapshot();
      const name = swap.options[swap.selectedIndex].textContent.split(' — ')[0];
      (draft.swaps ||= {})[def] = swap.value;
      persistDraft();
      undoable(`${name} neste treino`, () => { restoreDraft(snap); renderToday(); reopenCard(def); });
      renderToday();
      reopenCard(def);
    });

    $('.ex-change', card)?.addEventListener('click', () => openChangeDialog(card.dataset.default));
    $('.ex-remove', card)?.addEventListener('click', () => openRemoveDialog(card.dataset.default));
    bindComment(card, id);

    card.addEventListener('input', (ev) => {
      const row = ev.target.closest('.set-row');
      if (!row) return;
      const si = Number(row.dataset.set);
      const loadEl = $('.in-load', row);
      const load = loadEl ? loadEl.value : '';
      const repsEl = $('.in-reps', row);
      const reps = repsEl.value;

      const log = draft.logs[id] || (draft.logs[id] = { sets: [] });
      log.sets[si] = { load: load === '' ? null : Number(load), reps: reps === '' ? null : Number(reps) };

      const ex = exByActiveId(id);
      const { lo } = rowTarget(ex, si);
      if (!ex.logStyle) repsEl.dataset.hit = reps === '' ? '' : (Number(reps) >= lo ? 'yes' : 'no');

      card.classList.toggle('done', log.sets.some((s) => s?.reps));
      updateProgressCount();
      refreshVolume(card, id);
      persistDraft();
    });

    $('.fill-load', card)?.addEventListener('click', () => fillLoad(id));
    $('.fill-last', card)?.addEventListener('click', () => fillLast(id));
    $('.bulk-tech', card)?.addEventListener('click', () => openTechDialog(id, null));

    $('.add-set', card).addEventListener('click', () => {
      const ex = exByActiveId(id);
      const list = $('.sets', card);
      const si = $$('.set-row', list).length;

      const log = (draft.logs[id] ||= { sets: [] });
      if (!log.sets[si]) log.sets[si] = { load: null, reps: null };
      persistDraft();
      list.insertAdjacentHTML('beforeend', setRow(ex, si, null));
    });

    $$('.plan-toggle', card).forEach((b) => b.addEventListener('click', () => {
      const def = card.dataset.default;
      const e0 = draft.exercises.find((x) => x.exerciseId === def);
      if (!e0) return;
      (draft.mainMode ||= {});
      if (b.dataset.mode === 'test') draft.mainMode[e0.key] = 'test';
      else delete draft.mainMode[e0.key];
      persistDraft();
      renderToday();
      reopenCard(def);
    }));

    card.addEventListener('click', (ev) => {
      const tb = ev.target.closest('.tech-tag[data-tech]');
      if (tb) { openTechDialog(id, Number(tb.dataset.tech)); return; }
      if (!ev.target.classList.contains('del-set')) return;
      const row = ev.target.closest('.set-row');
      const si = Number(row.dataset.set);
      const log = draft.logs[id];
      const had = !!(log?.sets[si] && (log.sets[si].reps != null || log.sets[si].load != null));
      const snap = had ? draftSnapshot() : null;
      if (log) log.sets.splice(si, 1);
      const marks = draft.techs?.[id];
      if (marks) {
        const next = {};
        for (const [k, v] of Object.entries(marks)) {
          const n = Number(k);
          if (n === si) continue;
          next[n > si ? n - 1 : n] = v;
        }
        draft.techs[id] = next;
      }
      row.remove();
      $$('.set-row', card).forEach((r, i) => { r.dataset.set = i; $('.idx', r).textContent = i + 1; });
      card.classList.toggle('done', !!log?.sets.some((s) => s?.reps));
      updateProgressCount();
      persistDraft();
      if (had) {
        const def = card.dataset.default;
        undoable(`Série ${si + 1} removida`, () => { restoreDraft(snap); renderToday(); reopenCard(def); });
      }
    });
  });
}

function refreshSets(exId) {
  const ex = exByActiveId(exId);
  const card = $(`.ex[data-id="${CSS.escape(exId)}"]`);
  if (!ex || !card) { renderToday(); return; }
  $('.sets', card).innerHTML = setsHTML(ex);
  card.classList.toggle('done', !!draft.logs[exId]?.sets?.some((s) => s?.reps));
  updateProgressCount();
  refreshVolume(card, exId);
  persistDraft();
}

// Repeat the load into empty sets. Source is the most RECENT filled set, never the
// first one (that's the feeler set, always lighter). Reps are left alone.
function fillLoad(exId) {
  const ex = exByActiveId(exId);
  if (!ex || ex.logStyle) { toast('Este exercício não tem carga.', true); return; }
  const log = (draft.logs[exId] ||= { sets: [] });
  const n = Math.max(log.sets.length, ex.plannedSets ?? 3);
  const filled = log.sets.filter((s) => s && s.load);
  const base = filled[filled.length - 1]?.load
    ?? ex.targetLoad
    ?? ex.lastSets.findLast((s) => s.load)?.load
    ?? null;
  if (base == null) { toast('Preencha a carga de uma série primeiro.', true); return; }

  const snap = draftSnapshot();
  let changed = 0;
  for (let si = 0; si < n; si++) {
    const s = log.sets[si] || (log.sets[si] = { load: null, reps: null });
    if (s.load == null || s.load === '') { s.load = base; changed++; }
  }
  if (!changed) { toast(`Todas as séries já estão com carga.`); return; }
  refreshSets(exId);
  toast(`${base}kg em ${changed} ${changed === 1 ? 'série' : 'séries'}`, false,
    { label: 'Desfazer', fn: () => { restoreDraft(snap); renderToday(); reopenCard(ex.defaultId ?? exId); } });
}

function fillLast(exId) {
  const ex = exByActiveId(exId);
  if (!ex || !ex.lastSets.length) { toast('Sem treino anterior deste exercício.', true); return; }
  const snap = draftSnapshot();
  const log = (draft.logs[exId] ||= { sets: [] });
  const marks = (draft.techs ||= {})[exId] || {};
  const n = Math.max(log.sets.length, ex.plannedSets ?? 3, ex.lastSets.length);
  let changed = 0;

  for (let si = 0; si < n; si++) {
    const ref = ex.lastSets[si];
    if (!ref) continue;
    const s = log.sets[si] || (log.sets[si] = { load: null, reps: null });
    const isEmpty = (s.load == null || s.load === '') && (s.reps == null || s.reps === '');
    if (!isEmpty) continue;
    if (!ex.logStyle && ref.load) s.load = ref.load;
    s.reps = ref.reps;
    const t = (ref.techniques || [])[0]?.type;
    if (t) marks[si] = t;
    changed++;
  }
  draft.techs[exId] = marks;
  if (!changed) { toast('As séries já estão preenchidas.'); return; }
  refreshSets(exId);
  toast(`${changed} ${changed === 1 ? 'série copiada' : 'séries copiadas'} do último treino`, false,
    { label: 'Desfazer', fn: () => { restoreDraft(snap); renderToday(); reopenCard(ex.defaultId ?? exId); } });
}

function openTechDialog(exId, si) {
  const ex = exByActiveId(exId);
  if (!ex) return;
  const marks = (draft.techs ||= {})[exId] || {};
  const log = draft.logs[exId] || { sets: [] };
  const nSets = Math.max(log.sets.length, ex.plannedSets ?? 3);
  const shortSets = [];
  for (let i = 0; i < nSets; i++) {
    const r = Number(log.sets[i]?.reps);
    if (Number.isFinite(r) && r > 0 && r <= 5) shortSets.push(i);
  }
  const sug = si == null ? null : (ex.techniques || []).find((x) => x.setIndex === si)?.type || null;
  let techType = (si == null ? null : marks[si]) || sug || Object.values(marks)[0] || 'cluster';

  let pickMode = false;
  const sel = new Set(si == null ? [] : [si]);

  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay picker';
  overlay.innerHTML = `
    <div class="confirm-box" role="dialog" aria-label="Técnica">
      <p class="pk-title">${esc(ex.name)}${si == null ? '' : ` · série ${si + 1}`}</p>
      <div class="tech-opts"></div>
      <div class="tech-scope"></div>
      <div class="btn-row"><button class="btn ghost" data-a="no">Fechar</button></div>
    </div>`;
  document.body.appendChild(overlay);
  const opts = $('.tech-opts', overlay);
  const scope = $('.tech-scope', overlay);

  const draw = () => {
    opts.innerHTML = TECHNIQUE_TYPES.map((t) => `
      <button type="button" class="tech-opt${techType === t ? ' sel' : ''}" data-t="${t}">
        <b>${esc(techniqueLabel(t))}</b><small>${esc(techniqueHint(t))}</small>
        ${sug === t ? '<em>é o que você costuma fazer aqui</em>' : ''}
      </button>`).join('');
    const markedCount = Object.keys(marks).length;
    if (pickMode) {
      scope.innerHTML = `
        <p class="hint" style="padding:6px 0 2px">Marque as séries que recebem <b>${esc(techniqueLabel(techType))}</b>:</p>
        <div class="set-pick">
          ${Array.from({ length: nSets }, (_, i) => `
            <button type="button" class="set-chip${sel.has(i) ? ' on' : ''}" data-pick="${i}">
              ${i + 1}${marks[i] ? '<em>•</em>' : ''}
            </button>`).join('')}
        </div>
        <div class="tech-acts">
          <button class="btn primary" data-s="picked"${sel.size ? '' : ' disabled'}>Gravar${sel.size ? ` em ${sel.size}` : ''}</button>
          <button class="btn ghost" data-s="cancel-pick">Voltar</button>
        </div>`;
      return;
    }
    scope.innerHTML = `
      <p class="hint" style="padding:6px 0 2px">Aplicar <b>${esc(techniqueLabel(techType))}</b> em:</p>
      <div class="tech-acts">
        ${si == null ? '' : `<button class="btn ghost" data-s="one">só a série ${si + 1}</button>`}
        <button class="btn ghost" data-s="pick">escolher séries…</button>
        <button class="btn ghost" data-s="all">todas as ${nSets} séries</button>
        ${shortSets.length ? `<button class="btn ghost" data-s="short">as ${shortSets.length} ${shortSets.length === 1 ? 'série' : 'séries'} de até 5 reps</button>` : ''}
        ${markedCount ? `<button class="btn ghost danger-link" data-s="none">tirar de todas (${markedCount})</button>` : ''}
      </div>`;
  };
  draw();

  const applyMark = (idx, typeOrNull) => {
    for (const i of idx) { if (typeOrNull) marks[i] = typeOrNull; else delete marks[i]; }
    draft.techs[exId] = marks;
    persistDraft();
    const card = $(`.ex[data-id="${CSS.escape(exId)}"]`);
    if (card) $('.sets', card).innerHTML = setsHTML(ex);
  };

  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay || ev.target.closest('[data-a="no"]')) { overlay.remove(); return; }
    const t = ev.target.closest('[data-t]');
    if (t) { techType = t.dataset.t; draw(); return; }
    const chip = ev.target.closest('[data-pick]');
    if (chip) {
      const i = Number(chip.dataset.pick);
      if (sel.has(i)) sel.delete(i); else sel.add(i);
      draw();
      return;
    }
    const b = ev.target.closest('[data-s]');
    if (!b || b.disabled) return;
    const choice = b.dataset.s;
    if (choice === 'pick') { pickMode = true; draw(); return; }
    if (choice === 'cancel-pick') { pickMode = false; draw(); return; }

    const allIdx = Array.from({ length: nSets }, (_, i) => i);
    let n = 0;
    if (choice === 'one') { applyMark([si], marks[si] === techType ? null : techType); n = 1; }
    if (choice === 'picked') { const idx = [...sel].sort((a, c) => a - c); applyMark(idx, techType); n = idx.length; }
    if (choice === 'all') { applyMark(allIdx, techType); n = nSets; }
    if (choice === 'short') { applyMark(shortSets, techType); n = shortSets.length; }
    if (choice === 'none') { applyMark(Object.keys(marks).map(Number), null); n = 0; }
    overlay.remove();
    toast(n ? `${techniqueLabel(techType)} em ${n} ${n === 1 ? 'série' : 'séries'}` : 'Técnicas removidas');
  });
}

const MINOR_WORDS = new Set(['de', 'da', 'do', 'com', 'e', 'no', 'na', 'em', 'ou']);
const cleanName = (s) => s.trim().replace(/\s+/g, ' ').slice(0, 60).split(' ')
  .map((w, i) => (i > 0 && MINOR_WORDS.has(w.toLowerCase()) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1)))
  .join(' ');
const fold = (s) => String(s).normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

const EQUIPMENT_MOVES = new Set(['barra', 'fixa', 'leg', 'press']);
function movesOf(name) {
  const all = movementsOf(normalizeExercise(name).words);
  const specific = new Set([...all].filter((m) => !EQUIPMENT_MOVES.has(m)));
  return specific.size ? specific : all;
}

function newEdit(fields) {
  const now = new Date().toISOString();
  return { id: 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    createdAt: now, updatedAt: now, undone: false, ...fields };
}

function openChangeDialog(defId) {
  const e0 = draft.exercises.find((x) => x.exerciseId === defId);
  if (!e0) return;
  const cur = activeEx(e0);
  const catalog = exerciseCatalog(state.sessions);
  const inDay = new Set(draft.exercises.map((x) => activeEx(x).exerciseId));
  const isDaily = String(e0.key || '').startsWith('daily:');
  const scopeName = isDaily ? 'todos os treinos' : SLOT_LABEL[draft.slot];
  const both = !isDaily && !e0.only;

  const rowOf = (c) => ({ id: c.id, name: c.name, histId: c.id, samples: c.samples, last: c.last });
  const wantMoves = movesOf(e0.name);

  const own = [e0, ...(e0.variants || [])].map((v) => ({
    id: v.exerciseId, name: v.name, histId: v.noHistory ? null : v.exerciseId, samples: v.histSamples,
    tag: v === e0 ? 'padrão do programa' : (v.custom ? 'escolhido só hoje' : 'alternativa'),
  }));

  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay picker';
  overlay.innerHTML = `
    <div class="confirm-box" role="dialog" aria-label="Trocar exercício">
      <p class="pk-title">Trocar <b>${esc(cur.name)}</b></p>
      <div class="field">
        <input type="search" class="pk-q" placeholder="buscar no histórico ou digitar nome novo"
          autocomplete="off" autocorrect="off" style="text-align:left; padding-right:11px">
      </div>
      <div class="pk-list"></div>
      <div class="pk-chosen" hidden></div>
      <div class="pk-mode" hidden>
        <label class="pk-opt"><input type="radio" name="pk-mode" value="today" checked>
          <span><b>Só neste treino</b><small>o programa continua igual</small></span></label>
        <label class="pk-opt"><input type="radio" name="pk-mode" value="forever">
          <span><b>Definitivo</b><small>troca no programa daqui pra frente</small></span></label>
        <div class="pk-scope" hidden>
          ${both ? `
            <label class="pk-opt"><input type="radio" name="pk-scope" value="" checked><span>${esc(scopeName)} A e B</span></label>
            <label class="pk-opt"><input type="radio" name="pk-scope" value="${esc(draft.variant)}"><span>só ${esc(scopeName)} ${esc(draft.variant)}</span></label>`
          : `<p class="hint" style="padding:4px 0">Vale para ${esc(isDaily ? 'todos os treinos' : `${scopeName} ${e0.only}`)}.</p>`}
        </div>
      </div>
      <p class="hint pk-summary" style="padding-bottom:0"></p>
      <div class="btn-row">
        <button class="btn ghost" data-a="no">Cancelar</button>
        <button class="btn primary" data-a="yes" disabled>Aplicar</button>
      </div>
      <button class="link-btn danger-link" data-a="remove">Remover ${esc(e0.name)} do programa…</button>
    </div>`;
  document.body.appendChild(overlay);

  const q = $('.pk-q', overlay);
  const list = $('.pk-list', overlay);
  const chosenEl = $('.pk-chosen', overlay);
  const modeEl = $('.pk-mode', overlay);
  const scopeEl = $('.pk-scope', overlay);
  const summary = $('.pk-summary', overlay);
  const yes = $('[data-a="yes"]', overlay);
  let rows = [];
  let chosen = null;

  const info = (r) => [
    r.tag,
    r.samples ? `${r.samples} séries` : (r.isNew ? null : 'sem histórico'),
    r.last ? `última ${fmtDate(r.last)}` : null,
    inDay.has(r.id) && r.id !== cur.exerciseId ? 'já está no treino de hoje' : null,
  ].filter(Boolean).join(' · ');
  const itemHTML = (r, i) => `<button type="button" class="pk-item${r.isNew ? ' new' : ''}${chosen?.id === r.id ? ' sel' : ''}" data-i="${i}">
    ${r.isNew ? '＋ ' : ''}${esc(r.name)}<small>${esc(info(r))}</small></button>`;
  const sec = (title, a, b) => (b > a
    ? `${title ? `<div class="pk-sec">${esc(title)}</div>` : ''}${rows.slice(a, b).map((r, k) => itemHTML(r, a + k)).join('')}`
    : '');

  function renderList() {
    const text = q.value.trim();
    const words = fold(text).split(/\s+/).filter(Boolean);
    const seen = new Set();
    rows = [];
    const add = (r) => { if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); } };

    if (!words.length) {
      own.forEach(add);
      const n1 = rows.length;
      const pool = catalog.filter((c) => c.group === draft.slot || c.group === e0.group);
      pool.filter((c) => [...movesOf(c.name)].some((m) => wantMoves.has(m))).map(rowOf).forEach(add);
      const n2 = rows.length;
      pool.map(rowOf).forEach(add);
      list.innerHTML = sec('Deste card', 0, n1) + sec('Mesmo movimento', n1, n2)
        + sec(`Todos de ${SLOT_LABEL[draft.slot] ?? 'hoje'}`, n2, rows.length);
      return;
    }
    const ident = identifyName(text, catalog);
    if (ident.valid && ident.existing) add({ ...rowOf(ident.existing), tag: 'é o mesmo exercício do nome digitado' });
    [...own, ...catalog.map(rowOf)]
      .filter((r) => words.every((w) => fold(r.name).includes(w)))
      .slice(0, 15).forEach(add);
    if (ident.valid && !ident.existing && !seen.has(ident.id)) {
      add({ id: ident.id, name: cleanName(text), histId: null, isNew: true, similar: ident.similar, tag: 'criar exercício novo' });
    }
    list.innerHTML = rows.length ? sec(null, 0, rows.length)
      : '<p class="hint">Isso não parece nome de exercício — escreva o nome completo (ex.: "Remada Baixa Triângulo").</p>';
  }

  const mode = () => $('input[name="pk-mode"]:checked', overlay).value;
  const scopeVariant = () => $('input[name="pk-scope"]:checked', overlay)?.value || null;

  function updateSummary() {
    if (!chosen) return;
    const forever = mode() === 'forever';
    scopeEl.hidden = !forever;
    const same = chosen.id === (forever ? e0.exerciseId : cur.exerciseId);
    const clash = inDay.has(chosen.id) && chosen.id !== cur.exerciseId && chosen.id !== e0.exerciseId;
    yes.disabled = same || clash;
    if (same) summary.textContent = forever ? 'Esse já é o exercício do programa.' : 'Esse já é o exercício deste card.';
    else if (clash) summary.textContent = 'Escolha outro: este já está em outro card do treino de hoje.';
    else if (forever) {
      const where = isDaily ? 'todos os treinos' : (both ? `${scopeName} ${scopeVariant() || 'A e B'}` : `${scopeName} ${e0.only}`);
      summary.innerHTML = `Daqui pra frente, <b>${esc(where)}</b> passa a ter <b>${esc(chosen.name)}</b> no lugar de
        <b>${esc(e0.name)}</b>. O histórico não muda, e dá para desfazer.`;
    } else {
      summary.innerHTML = `Só hoje: <b>${esc(chosen.name)}</b> no lugar de <b>${esc(cur.name)}</b>.`;
    }
  }

  function renderChosen() {
    chosenEl.hidden = !chosen;
    modeEl.hidden = !chosen;
    if (!chosen) { yes.disabled = true; summary.textContent = ''; return; }
    let html = chosen.isNew
      ? `<b>${esc(chosen.name)}</b> — exercício novo. Começa sem histórico; depois do primeiro treino concluído as cargas passam a aparecer.`
      : `<b>${esc(chosen.name)}</b> — ${chosen.samples
        ? `usa o seu histórico (${chosen.samples} séries${chosen.last ? `, última ${fmtDate(chosen.last)}` : ''})`
        : 'ainda sem histórico'}.`;
    if (chosen.isNew && chosen.similar?.length) {
      html += `<div class="warn">Parecido com o que já existe. Se for o mesmo, toque nele — senão o histórico fica dividido em dois:</div>`
        + chosen.similar.map((c, k) => `<button type="button" class="pk-item" data-sim="${k}" style="margin-top:6px; width:100%">
          ${esc(c.name)}<small>${c.samples} séries</small></button>`).join('');
    }
    chosenEl.innerHTML = html;
    updateSummary();
  }

  list.addEventListener('click', (ev) => {
    const b = ev.target.closest('.pk-item');
    if (!b) return;
    chosen = rows[Number(b.dataset.i)];
    renderList();
    renderChosen();
  });
  chosenEl.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-sim]');
    if (!b) return;
    const c = chosen.similar[Number(b.dataset.sim)];
    chosen = rowOf(c);
    q.value = c.name;
    renderList();
    renderChosen();
  });
  modeEl.addEventListener('change', updateSummary);
  q.addEventListener('input', renderList);

  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) { overlay.remove(); return; }
    const a = ev.target.closest('[data-a]')?.dataset.a;
    if (a === 'no') overlay.remove();
    if (a === 'yes' && chosen && !yes.disabled) {
      overlay.remove();
      if (mode() === 'forever') applyForever(e0, chosen, both ? scopeVariant() : null);
      else applyToday(e0, chosen);
    }
    if (a === 'remove') { overlay.remove(); removeFromProgram(e0); }
  });

  renderList();
}

function openAddDialog() {
  const catalog = exerciseCatalog(state.sessions);
  const inDay = new Set(draft.exercises.map((x) => activeEx(x).exerciseId));
  const slotName = SLOT_LABEL[draft.slot] ?? 'hoje';

  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay picker';
  overlay.innerHTML = `
    <div class="confirm-box" role="dialog" aria-label="Adicionar exercício">
      <p class="pk-title">Adicionar exercício ao treino</p>
      <div class="field">
        <input type="search" class="pk-q" placeholder="buscar no histórico ou digitar nome novo"
          autocomplete="off" autocorrect="off" style="text-align:left; padding-right:11px">
      </div>
      <div class="pk-list"></div>
      <div class="pk-chosen" hidden></div>
      <div class="pk-mode" hidden>
        <label class="pk-opt"><input type="radio" name="add-mode" value="today" checked>
          <span><b>Só neste treino</b><small>hoje apenas; o programa continua igual</small></span></label>
        <label class="pk-opt"><input type="radio" name="add-mode" value="forever">
          <span><b>Definitivo em todos</b><small>entra no programa e volta nos próximos treinos</small></span></label>
        <div class="pk-scope" hidden>
          <label class="pk-opt"><input type="radio" name="add-scope" value="" checked><span>${esc(slotName)} A e B</span></label>
          <label class="pk-opt"><input type="radio" name="add-scope" value="${esc(draft.variant)}"><span>só ${esc(slotName)} ${esc(draft.variant)}</span></label>
        </div>
      </div>
      <p class="hint pk-summary" style="padding-bottom:0"></p>
      <div class="btn-row">
        <button class="btn ghost" data-a="no">Cancelar</button>
        <button class="btn primary" data-a="yes" disabled>Adicionar</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const q = $('.pk-q', overlay);
  const list = $('.pk-list', overlay);
  const chosenEl = $('.pk-chosen', overlay);
  const modeEl = $('.pk-mode', overlay);
  const scopeEl = $('.pk-scope', overlay);
  const summary = $('.pk-summary', overlay);
  const yes = $('[data-a="yes"]', overlay);
  let rows = [];
  let chosen = null;

  const rowOf = (c) => ({ id: c.id, name: c.name, histId: c.id, samples: c.samples, last: c.last });
  const info = (r) => [
    r.tag,
    r.samples ? `${r.samples} séries` : (r.isNew ? null : 'sem histórico'),
    r.last ? `última ${fmtDate(r.last)}` : null,
    inDay.has(r.id) ? 'já está no treino de hoje' : null,
  ].filter(Boolean).join(' · ');
  const itemHTML = (r, i) => `<button type="button" class="pk-item${r.isNew ? ' new' : ''}${chosen?.id === r.id ? ' sel' : ''}" data-i="${i}">
    ${r.isNew ? '＋ ' : ''}${esc(r.name)}<small>${esc(info(r))}</small></button>`;

  function renderList() {
    const text = q.value.trim();
    const words = fold(text).split(/\s+/).filter(Boolean);
    const seen = new Set();
    rows = [];
    const add = (r) => { if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); } };

    if (!words.length) {
      catalog.filter((c) => c.group === draft.slot).map(rowOf).forEach(add);
      const n1 = rows.length;
      catalog.map(rowOf).forEach(add);
      list.innerHTML = (n1 ? `<div class="pk-sec">De ${esc(slotName)}</div>${rows.slice(0, n1).map((r, k) => itemHTML(r, k)).join('')}` : '')
        + (rows.length > n1 ? `<div class="pk-sec">Todo o histórico</div>${rows.slice(n1).map((r, k) => itemHTML(r, n1 + k)).join('')}` : '');
      return;
    }
    const ident = identifyName(text, catalog);
    if (ident.valid && ident.existing) add({ ...rowOf(ident.existing), tag: 'é o mesmo exercício do nome digitado' });
    catalog.map(rowOf).filter((r) => words.every((w) => fold(r.name).includes(w))).slice(0, 15).forEach(add);
    if (ident.valid && !ident.existing && !seen.has(ident.id)) {
      add({ id: ident.id, name: cleanName(text), histId: null, isNew: true, similar: ident.similar, tag: 'criar exercício novo' });
    }
    list.innerHTML = rows.length ? rows.map(itemHTML).join('')
      : '<p class="hint">Isso não parece nome de exercício — escreva o nome completo (ex.: "Remada Cavalinho").</p>';
  }

  const mode = () => $('input[name="add-mode"]:checked', overlay).value;
  const scopeVariant = () => $('input[name="add-scope"]:checked', overlay)?.value || null;

  function updateSummary() {
    if (!chosen) return;
    const forever = mode() === 'forever';
    scopeEl.hidden = !forever;
    const clash = inDay.has(chosen.id);
    yes.disabled = clash;
    if (clash) { summary.textContent = 'Esse exercício já está no treino de hoje.'; return; }
    if (forever) {
      summary.innerHTML = `<b>${esc(chosen.name)}</b> entra no programa de <b>${esc(slotName)} ${esc(scopeVariant() || 'A e B')}</b>
        e volta em todos os próximos treinos. Dá para desfazer em Ajustes.`;
    } else {
      summary.innerHTML = `Só hoje: <b>${esc(chosen.name)}</b> entra no fim do treino.`;
    }
  }

  function renderChosen() {
    chosenEl.hidden = !chosen;
    modeEl.hidden = !chosen;
    if (!chosen) { yes.disabled = true; summary.textContent = ''; return; }
    let html = chosen.isNew
      ? `<b>${esc(chosen.name)}</b> — exercício novo. Começa sem histórico; depois do primeiro treino concluído as cargas aparecem.`
      : `<b>${esc(chosen.name)}</b> — ${chosen.samples ? `usa o seu histórico (${chosen.samples} séries)` : 'ainda sem histórico'}.`;
    if (chosen.isNew && chosen.similar?.length) {
      html += '<div class="warn">Parecido com o que já existe. Se for o mesmo, toque nele — senão o histórico fica dividido em dois:</div>'
        + chosen.similar.map((c, k) => `<button type="button" class="pk-item" data-sim="${k}" style="margin-top:6px; width:100%">
          ${esc(c.name)}<small>${c.samples} séries</small></button>`).join('');
    }
    chosenEl.innerHTML = html;
    updateSummary();
  }

  list.addEventListener('click', (ev) => {
    const b = ev.target.closest('.pk-item');
    if (!b) return;
    chosen = rows[Number(b.dataset.i)];
    renderList();
    renderChosen();
  });
  chosenEl.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-sim]');
    if (!b) return;
    const c = chosen.similar[Number(b.dataset.sim)];
    chosen = rowOf(c);
    q.value = c.name;
    renderList();
    renderChosen();
  });
  modeEl.addEventListener('change', updateSummary);
  q.addEventListener('input', renderList);

  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) { overlay.remove(); return; }
    const a = ev.target.closest('[data-a]')?.dataset.a;
    if (a === 'no') overlay.remove();
    if (a === 'yes' && chosen && !yes.disabled) {
      overlay.remove();
      if (mode() === 'forever') addForever(chosen, scopeVariant());
      else addToday(chosen);
    }
  });

  renderList();
}

function addToday(chosen) {
  const snap = draftSnapshot();
  draft.extras = [...(draft.extras || []), { name: chosen.name, histId: chosen.histId || null }];
  rebuildDraft();
  persistDraft();
  undoable(`${chosen.name} neste treino`, () => { restoreDraft(snap); renderToday(); });
  renderToday();
  revealCard(chosen.id);
}

function addForever(chosen, variant) {
  const snap = draftSnapshot();
  const edit = newEdit({
    action: 'add', target: `add:${draft.slot}:${chosen.id}`, targetName: chosen.name,
    slot: draft.slot, variant: variant || null, part: 'Extra',
    name: chosen.name, histId: chosen.histId || null,
  });
  const res = db.addProgramEdit(edit);
  if (!res.ok) { toast('Erro ao salvar: ' + res.error, true); return; }
  state = db.load();
  rebuildDraft();
  persistDraft();
  undoable(`Programa: ${chosen.name} adicionado`, () => {
    db.setProgramEditUndone(edit.id, true);
    restoreDraft(snap);
    renderToday();
  });
  renderToday();
  revealCard(chosen.id);
}

function openRemoveDialog(defId) {
  const e0 = draft.exercises.find((x) => x.exerciseId === defId);
  if (!e0) return;
  const a = activeEx(e0);
  const isExtra = !!e0.extra;
  const daily = String(e0.key || '').startsWith('daily:');
  const slotName = SLOT_LABEL[draft.slot] ?? 'hoje';
  const filledCount = (draft.logs[a.exerciseId]?.sets || []).filter((x) => x?.reps).length;

  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay picker';
  overlay.innerHTML = `
    <div class="confirm-box" role="dialog" aria-label="Remover exercício">
      <p class="pk-title">Remover ${esc(a.name)}</p>
      ${filledCount ? `<p class="hint warn-box">${filledCount} ${filledCount === 1 ? 'série preenchida hoje será descartada' : 'séries preenchidas hoje serão descartadas'}. Treinos já concluídos não mudam.</p>` : ''}
      ${isExtra
        ? '<p class="hint">Este exercício foi acrescentado só para o treino de hoje — sai apenas de hoje.</p>'
        : `<div class="pk-mode">
            <label class="pk-opt"><input type="radio" name="rm-mode" value="today" checked>
              <span><b>Só neste treino</b><small>sai de hoje; volta no próximo treino</small></span></label>
            <label class="pk-opt"><input type="radio" name="rm-mode" value="forever">
              <span><b>Definitivo em todos</b><small>sai do programa e não volta mais</small></span></label>
            <div class="pk-scope" hidden>
              <label class="pk-opt"><input type="radio" name="rm-scope" value="" checked>
                <span>${daily ? 'todos os treinos' : `${esc(slotName)} A e B`}</span></label>
              <label class="pk-opt"><input type="radio" name="rm-scope" value="${esc(draft.variant)}">
                <span>${daily ? `só nos treinos ${esc(draft.variant)}` : `só ${esc(slotName)} ${esc(draft.variant)}`}</span></label>
            </div>
          </div>`}
      <p class="hint pk-summary" style="padding-bottom:0"></p>
      <div class="btn-row">
        <button class="btn ghost" data-a="no">Cancelar</button>
        <button class="btn danger-solid" data-a="yes">Remover</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const summary = $('.pk-summary', overlay);
  const scopeEl = $('.pk-scope', overlay);
  const mode = () => $('input[name="rm-mode"]:checked', overlay)?.value || 'today';
  const scopeVariant = () => $('input[name="rm-scope"]:checked', overlay)?.value || null;

  function updateSummary() {
    const forever = mode() === 'forever';
    if (scopeEl) scopeEl.hidden = !forever;
    summary.innerHTML = forever
      ? `<b>${esc(a.name)}</b> sai do programa de <b>${daily ? 'todos os treinos' : `${esc(slotName)} ${esc(scopeVariant() || 'A e B')}`}</b>. Dá para reativar em Ajustes → Alterações do programa.`
      : `Só hoje: <b>${esc(a.name)}</b> sai deste treino e volta no próximo.`;
  }
  updateSummary();
  overlay.addEventListener('change', updateSummary);

  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) { overlay.remove(); return; }
    const act = ev.target.closest('[data-a]')?.dataset.a;
    if (act === 'no') { overlay.remove(); return; }
    if (act !== 'yes') return;
    overlay.remove();
    if (isExtra) removeExtraToday(e0, a);
    else if (mode() === 'forever') removeForever(e0, a, scopeVariant(), daily);
    else removeToday(e0, a);
  });
}

function dropLogs(activeId) {
  delete draft.logs[activeId];
  if (draft.techs) delete draft.techs[activeId];
}

function removeToday(e0, a) {
  const snap = draftSnapshot();
  draft.hidden = [...new Set([...(draft.hidden || []), e0.key])];
  dropLogs(a.exerciseId);
  delete draft.swaps?.[e0.exerciseId];
  rebuildDraft();
  persistDraft();
  renderToday();
  undoable(`${a.name} fora do treino de hoje`, () => { restoreDraft(snap); renderToday(); });
}

function removeExtraToday(e0, a) {
  const snap = draftSnapshot();
  draft.extras = (draft.extras || []).filter((x) => exactId(x.name) !== a.exerciseId && x.histId !== a.exerciseId);
  dropLogs(a.exerciseId);
  rebuildDraft();
  persistDraft();
  renderToday();
  undoable(`${a.name} fora do treino de hoje`, () => { restoreDraft(snap); renderToday(); });
}

function removeForever(e0, a, variant, daily) {
  const snap = draftSnapshot();
  const edit = newEdit({
    action: 'remove', target: e0.key, targetName: e0.defaultName ?? a.name,
    slot: daily ? 'daily' : draft.slot, variant: variant || null,
  });
  const res = db.addProgramEdit(edit);
  if (!res.ok) { toast('Erro ao salvar: ' + res.error, true); return; }
  state = db.load();
  dropLogs(a.exerciseId);
  rebuildDraft();
  persistDraft();
  renderToday();
  undoable(`Programa: ${a.name} removido`, () => {
    db.setProgramEditUndone(edit.id, true);
    state = db.load();
    restoreDraft(snap);
    renderToday();
  });
}

function revealCard(id) {
  const card = $(`.ex[data-id="${CSS.escape(id)}"]`);
  if (!card) return;
  card.classList.add('open');
  card.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function applyToday(e0, chosen) {
  const snap = draftSnapshot();
  const def = e0.exerciseId;
  draft.swaps ||= {};
  draft.custom ||= {};
  if (chosen.id === def) {
    delete draft.swaps[def];
    delete draft.custom[e0.key];
  } else if ((e0.variants || []).some((v) => v.exerciseId === chosen.id && !v.custom)) {
    draft.swaps[def] = chosen.id;
    delete draft.custom[e0.key];
  } else {
    draft.custom[e0.key] = { name: chosen.name, histId: chosen.histId };
    draft.swaps[def] = chosen.id;
  }
  rebuildDraft();
  persistDraft();
  undoable(`${chosen.name} só neste treino`, () => { restoreDraft(snap); renderToday(); reopenCard(def); });
  renderToday();
  reopenCard(def);
}

function applyForever(e0, chosen, variant) {
  const snap = draftSnapshot();
  const isDaily = String(e0.key).startsWith('daily:');
  const edit = newEdit({
    action: 'replace', target: e0.key, targetName: e0.name,
    slot: isDaily ? 'daily' : draft.slot, variant: variant || null,
    name: chosen.name, histId: chosen.histId || null,
  });
  const res = db.addProgramEdit(edit);
  if (!res.ok) { toast('Erro ao salvar: ' + res.error, true); return; }
  state = db.load();
  delete draft.swaps?.[e0.exerciseId];
  delete draft.custom?.[e0.key];
  rebuildDraft();
  persistDraft();
  undoable(`Programa: ${chosen.name} no lugar de ${e0.name}`, () => {
    db.setProgramEditUndone(edit.id, true);
    restoreDraft(snap);
    renderToday();
  });
  renderToday();
  const ne = draft.exercises.find((x) => x.key === e0.key);
  if (ne) reopenCard(ne.exerciseId);
}

async function removeFromProgram(e0) {
  const isDaily = String(e0.key).startsWith('daily:');
  const where = isDaily ? 'todos os treinos' : `${SLOT_LABEL[draft.slot]} ${e0.only || 'A e B'}`;
  const ok = await confirmDialog(
    `Remover ${e0.name} de ${where} daqui pra frente? O histórico dele continua salvo, e dá para desfazer em Ajustes.`,
    { danger: true });
  if (!ok) return;
  const snap = draftSnapshot();
  const edit = newEdit({
    action: 'remove', target: e0.key, targetName: e0.name,
    slot: isDaily ? 'daily' : draft.slot, variant: null, name: null, histId: null,
  });
  const res = db.addProgramEdit(edit);
  if (!res.ok) { toast('Erro ao salvar: ' + res.error, true); return; }
  state = db.load();
  rebuildDraft();
  persistDraft();
  undoable(`${e0.name} removido do programa`, () => {
    db.setProgramEditUndone(edit.id, true);
    restoreDraft(snap);
    renderToday();
  });
  renderToday();
}

// runs on every keystroke. Only what's needed to resume (date, cycle position,
// what was typed); the exercise list and targets get recomputed on open
function persistDraft() {
  if (!draft) return;
  db.saveDraft({
    date: draft.date || todayISO(),
    position: draft.position,
    slot: draft.slot,
    variant: draft.variant,
    logs: draft.logs,
    swaps: draft.swaps || {},
    custom: draft.custom || {},
    mainMode: draft.mainMode || {},
    techs: draft.techs || {},
    extras: draft.extras || [],
    hidden: draft.hidden || [],
    savedAt: new Date().toISOString(),
  });
}

// "4×5 4×5 · 75%" used to show up here (label + summary repeat the scheme)
function mainPlanTxt(plan) {
  const pct = plan.work[0]?.pct;
  return pct ? `${plan.label} · ${Math.round(pct * 100)}%` : plan.label;
}

function updateProgressCount() {
  const done = draft.exercises
    .filter((e) => draft.logs[activeEx(e).exerciseId]?.sets?.some((s) => s?.reps)).length;
  const el = $('#ex-count');
  if (el) el.textContent = `${done}/${draft.exercises.length} exercícios registrados`;
}

function finishWorkout() {
  const snap = draftSnapshot();
  const exercises = [];
  for (const e0 of draft.exercises) {
    const ex = activeEx(e0);
    const log = draft.logs[ex.exerciseId];
    const marks = draft.techs?.[ex.exerciseId] || {};
    const sets = (log?.sets || [])
      .map((s, si) => (s && s.reps ? { load: s.load ?? 0, reps: s.reps, bodyweight: !s.load,
        ...(marks[si] ? { techniques: [{ type: marks[si] }] } : {}) } : null))
      .filter(Boolean);
    if (sets.length) {
      // slotKey: which program slot it was done in, so "Reabrir" knows which card
      // gets a one-off swap back
      exercises.push({ id: ex.exerciseId, name: ex.name, group: ex.group, sets, slotKey: e0.key });
    }
  }

  if (exercises.length === 0) { toast('Nenhuma série registrada.', true); return; }

  const session = {
    date: draft.date || todayISO(),
    variant: draft.variant,
    slot: draft.slot,
    logged: true,
    exercises,
  };

  const res = db.logWorkout(session);
  if (!res.ok) { toast('Erro ao salvar: ' + res.error, true); return; }

  db.clearDraft();
  state = db.load();
  draft = null;
  const n = exercises.length;
  undoable(`Treino salvo · ${n} ${n === 1 ? 'exercício' : 'exercícios'}`, () => {
    db.undoLogWorkout(session.date, res.previous);
    restoreDraft(snap);
    renderToday();
  });
  renderToday();
}

function advanceCycle() {
  const pos = state.cyclePosition || 0;
  const saved = db.loadDraft();
  db.setCyclePosition(pos + 1);
  db.clearDraft();
  state = db.load();
  draft = null;

  undoable('Adiado para o próximo treino do ciclo', () => {
    db.setCyclePosition(pos);
    if (saved) db.saveDraft(saved);
    state = db.load();
    draft = null;
    renderToday();
  });
  renderToday();
}

$('#btn-preview').addEventListener('click', () => {
  const text = $('#paste').value;
  if (!text.trim()) { toast('Cole o texto primeiro.', true); return; }

  const result = parseHistory(text);
  pendingImport = result;
  renderImportPreview(result);
});

function renderImportPreview({ sessions, warnings, stats }) {
  const root = $('#import-preview');

  if (sessions.length === 0) {
    root.innerHTML = `<div class="preview"><h3>Nada reconhecido</h3>
      <p class="hint">Confira se as datas estão no formato <b>13/08</b> e as séries como <b>30kg 10</b>.</p></div>`;
    return;
  }

  const index = indexByExercise(sessions);
  const chips = [...index.values()]
    .map((e) => `<span class="ex-chip" data-group="${esc(e.group)}">${esc(e.name)}</span>`).join('');

  root.innerHTML = `
    <div class="preview">
      <h3>Encontrado</h3>
      <div class="stat-grid">
        <div class="stat"><div class="v">${stats.sessions}</div><div class="k">dias</div></div>
        <div class="stat"><div class="v">${stats.exercises}</div><div class="k">exercícios</div></div>
        <div class="stat"><div class="v">${stats.sets}</div><div class="k">séries</div></div>
        <div class="stat"><div class="v">${warnings.length}</div><div class="k">avisos</div></div>
      </div>
      <p class="hint" style="padding-top:0">
        Período: <b>${fmtDate(stats.firstDate) || '?'}</b> a <b>${fmtDate(stats.lastDate) || '?'}</b>
      </p>
      <div class="ex-chip-list">${chips}</div>
      ${warnings.length ? `
        <h3 style="margin-top:16px">Avisos</h3>
        <ul class="warn-list">
          ${warnings.slice(0, 20).map((w) => `<li><b>linha ${w.line}</b> · ${esc(w.reason)}<br>${esc(w.text)}</li>`).join('')}
        </ul>` : ''}
    </div>
    <div class="btn-row">
      <button class="btn primary" id="btn-merge">Adicionar ao histórico</button>
      <button class="btn ghost" id="btn-replace">Substituir tudo</button>
    </div>
  `;

  $('#btn-merge').addEventListener('click', () => commitImport('merge'));
  $('#btn-replace').addEventListener('click', () => commitImport('replace'));
}

async function commitImport(mode) {
  if (!pendingImport) return;

  if (mode === 'replace' && state.sessions.length > 0) {
    const n = state.sessions.length;
    const ok = await confirmDialog(
      `Isso apaga os ${n} dias já salvos e põe só o texto atual no lugar. Continuar?`,
      { danger: true }
    );
    if (!ok) return;
  }

  const res = mode === 'replace'
    ? db.replaceSessions(pendingImport.sessions)
    : db.mergeSessions(pendingImport.sessions);

  if (!res.ok) { toast('Erro ao salvar: ' + res.error, true); return; }

  state = db.load();

  if (!state.cyclePosition) {
    db.setCyclePosition(inferStartPosition(state.sessions));
    state = db.load();
  }

  draft = null;
  pendingImport = null;
  $('#paste').value = '';
  $('#import-preview').innerHTML = '';

  toast(mode === 'replace'
    ? `Histórico substituído · ${state.sessions.length} dias`
    : `${res.added} dias novos, ${res.replaced} atualizados`);

  show('today');
}

function renderDash() {
  const root = $('#dash-content');
  const history = state.sessions || [];

  if (history.length === 0) {
    root.innerHTML = `<div class="empty"><div class="big">📈</div>
      <p>Sem dados ainda.<br>Importe o histórico para ver seu progresso.</p></div>`;
    $('#dash-range').textContent = '';
    return;
  }

  const dated = history.filter((s) => s.date).sort((a, b) => a.date.localeCompare(b.date));
  $('#dash-range').textContent = `${fmtDate(dated[0]?.date)} – ${fmtDate(dated[dated.length - 1]?.date)}`;

  const index = indexByExercise(history);
  const rows = [...index.values()].map(buildProgress).filter(Boolean);

  const gaining = rows.filter((r) => r.pct > 2).sort((a, b) => b.samples - a.samples);
  const stalled = rows.filter((r) => r.pct <= 2).sort((a, b) => b.samples - a.samples);

  const totalSets = history.reduce((n, s) =>
    n + (s.exercises || []).reduce((k, e) => k + e.sets.length, 0), 0);
  const volume = history.reduce((sum, s) =>
    sum + (s.exercises || []).reduce((v, e) => v + tonnage(e.sets), 0), 0);

  root.innerHTML = `
    <div class="stat-grid" style="margin-bottom:20px">
      <div class="stat"><div class="v">${dated.length}</div><div class="k">dias</div></div>
      <div class="stat"><div class="v">${index.size}</div><div class="k">exercícios</div></div>
      <div class="stat"><div class="v">${totalSets}</div><div class="k">séries</div></div>
      <div class="stat"><div class="v">${(volume / 1000).toFixed(0)}t</div><div class="k">volume</div></div>
    </div>

    <div class="legend">
      <p><b>Barras</b> = carga real da sua melhor série em cada treino, com as
      repetições logo abaixo (ex: <b>90kg</b> / <b>7r</b>).</p>
      <p><b>1RM 49,5 → 54,5kg</b> = estimativa de quanto você levantaria em 1
      repetição máxima, comparando a <b>primeira metade</b> do seu histórico
      naquele exercício com a <b>segunda metade</b>.</p>
      <p><b>+4%</b> = quanto essa estimativa cresceu entre as duas metades.
      Positivo é progresso; perto de zero é estagnação.</p>
    </div>

    ${section('Evoluindo', gaining, 'Nenhum exercício com ganho claro ainda.')}
    ${section('Estagnados — olhar aqui', stalled, 'Nada estagnado. Bom sinal.')}
  `;
}

// with 4 sets one good day reads as +336% and the dashboard is useless
const MIN_SETS_FOR_TREND = 10;
const MIN_SETS_PER_HALF = 4;

// heaviest set of the day with its reps: "what did I lift", not a projection
function bestSetPerDay(sets) {
  const byDay = new Map();
  for (const s of sets) {
    if (!s.date || !(s.load > 0)) continue;
    const cur = byDay.get(s.date);
    if (!cur || s.load > cur.load || (s.load === cur.load && s.reps > cur.reps)) {
      byDay.set(s.date, { date: s.date, load: s.load, reps: s.reps });
    }
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// first half of the history vs second half. No recency window here on purpose,
// we want each half's real peak
function buildProgress(ex) {
  const dated = ex.sessions.filter((s) => s.date && s.load > 0 && s.reps <= 12);
  if (dated.length < MIN_SETS_FOR_TREND) return null;

  dated.sort((a, b) => a.date.localeCompare(b.date));
  const mid = Math.floor(dated.length / 2);
  if (mid < MIN_SETS_PER_HALF || dated.length - mid < MIN_SETS_PER_HALF) return null;

  const first = bestOneRM(dated.slice(0, mid));
  const last = bestOneRM(dated.slice(mid));
  if (!first || !last) return null;

  const pct = ((last.oneRM - first.oneRM) / first.oneRM) * 100;

  return {
    name: ex.name,
    group: ex.group,
    from: Math.round(first.oneRM * 10) / 10,
    to: Math.round(last.oneRM * 10) / 10,
    pct,
    samples: dated.length,

    days: bestSetPerDay(dated),
    lastDate: dated[dated.length - 1].date,
  };
}

function section(title, rows, emptyMsg) {
  if (rows.length === 0) {
    return `<div class="section"><h2>${esc(title)}</h2><p class="hint">${esc(emptyMsg)}</p></div>`;
  }
  return `
    <div class="section">
      <h2>${esc(title)}</h2>
      ${rows.map((r) => {
        const dir = r.pct > 2 ? 'up' : r.pct < -2 ? 'down' : 'flat';
        const sign = r.pct > 0 ? '+' : '';
        return `
          <div class="prog-row">
            <div class="nm">${esc(r.name)}<small>${r.samples} séries · última ${fmtDate(r.lastDate)}</small></div>
            <div class="val">1RM ${r.from} → ${r.to}kg</div>
            <div class="delta ${dir}">${sign}${r.pct.toFixed(1)}%</div>
          </div>
          ${loadChart(r.days, dir)}`;
      }).join('')}
    </div>`;
}

// Real load of the best set per workout, not the estimated 1RM (a projection is
// useless for deciding what to put on the machine). One bar per workout:
// monthly bars hid exactly the session-to-session variation.
function loadChart(days, dir, opts = {}) {
  const limit = opts.limit ?? 10;
  const bars = opts.scroll ? days : days.slice(-limit);
  if (bars.length < 2) return '';

  const values = bars.map((b) => b.load);
  const max = Math.max(...values);
  const min = Math.min(...values);

  // not zero: at 100-150kg, bars from zero all look the same
  const base = Math.max(0, min * 0.88);
  const span = (max - base) || 1;

  const color = dir === 'up' ? 'var(--ok)' : dir === 'down' ? 'var(--err)' : 'var(--text)';
  const slotW = opts.scroll ? 44 : Math.max(30, 320 / bars.length);
  const w = Math.max(320, slotW * bars.length);
  const h = 118, padTop = 20, padBottom = 30;
  const barW = Math.min(30, slotW * 0.66);

  const rects = bars.map((b, i) => {
    const x = i * slotW + (slotW - barW) / 2;
    const bh = ((b.load - base) / span) * (h - padTop - padBottom);
    const y = h - padBottom - bh;
    const cx = x + barW / 2;
    return `
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}"
        height="${Math.max(3, bh).toFixed(1)}" rx="3" fill="${color}"
        opacity="${b.load === max ? 1 : 0.6}"/>
      <text x="${cx.toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle"
        font-size="11" font-weight="800" fill="var(--text)">${fmtKg(b.load)}</text>
      <text x="${cx.toFixed(1)}" y="${(h - padBottom + 12).toFixed(1)}" text-anchor="middle"
        font-size="9" font-weight="700" fill="${color}">${b.reps}r</text>
      <text x="${cx.toFixed(1)}" y="${(h - padBottom + 23).toFixed(1)}" text-anchor="middle"
        font-size="8" font-weight="600" fill="var(--text)" opacity="0.7">${esc(dayLabel(b.date))}</text>`;
  }).join('');

  const svg = `<svg class="chart" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"
    role="img" aria-label="Carga levantada por treino, em kg">${rects}</svg>`;

  return opts.scroll ? `<div class="chart-scroll">${svg}</div>` : svg;
}

const fmtKg = (v) => (Number.isInteger(v) ? v : Math.round(v * 10) / 10);

function dayLabel(iso) {
  if (!iso) return '';
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}

let histTab = 'sessions';
let histShown = 6;

// Treinos = last workouts, editable. Exercícios = load over time per exercise.
// Editing a logged day never moves the cycle, only a NEW finished workout does.
function renderHistory() {
  const root = $('#hist-content');
  const history = state.sessions || [];

  if (history.length === 0) {
    root.innerHTML = `<div class="empty"><div class="big">📊</div>
      <p>Sem dados ainda.<br>Importe o histórico para ver.</p></div>`;
    $('#hist-count').textContent = '';
    return;
  }

  root.innerHTML = `
    <div class="seg" id="hist-seg">
      <button type="button" data-h="sessions"  class="${histTab === 'sessions' ? 'on' : ''}">Treinos</button>
      <button type="button" data-h="exercises" class="${histTab === 'exercises' ? 'on' : ''}">Exercícios</button>
    </div>
    <div id="hist-body"></div>`;

  $('#hist-seg').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-h]');
    if (!b || b.dataset.h === histTab) return;
    histTab = b.dataset.h;
    renderHistory();
  });

  if (histTab === 'sessions') renderHistSessions(history);
  else renderHistExercises(history);
}

function renderHistSessions(history) {
  const pastDays = history
    .filter((s) => s.date && (s.exercises || []).length)
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  const visible = pastDays.slice(0, histShown);
  const remaining = pastDays.length - visible.length;
  $('#hist-count').textContent = `${pastDays.length} treinos`;

  $('#hist-body').innerHTML = `
    <div class="legend">
      <p>Os últimos treinos inteiros, do mais recente para o mais antigo, no mesmo
      formato do resumo que aparece ao concluir. Viu um número errado?
      <b>Corrigir este treino</b> abre os campos de carga e repetições daquele dia.</p>
    </div>
    ${visible.map(sessionCard).join('')}
    ${remaining > 0 ? `<button class="btn ghost" id="hist-more">Mostrar mais 6 (${remaining} ${remaining === 1 ? 'restante' : 'restantes'})</button>` : ''}
    ${histShown > 6 ? `<button class="btn ghost" id="hist-less">Voltar aos últimos 6</button>` : ''}`;

  $('#hist-more')?.addEventListener('click', () => { histShown += 6; renderHistory(); });
  $('#hist-less')?.addEventListener('click', () => { histShown = 6; renderHistory(); window.scrollTo(0, 0); });
  $$('#hist-body .edit-sess').forEach((b) =>
    b.addEventListener('click', () => openSessionEditor(b.dataset.date)));
}

function sessionCard(session) {
  const nSets = (session.exercises || []).reduce((n, e) => n + (e.sets?.length || 0), 0);
  const vol = (session.exercises || []).reduce((t, e) => t + setsTonnage(e.sets || []), 0);
  const slot = session.slot ? (SLOT_LABEL[session.slot] ?? '') : '';
  const variantTxt = session.variant ? ` ${session.variant}` : '';
  const isToday = session.date === todayISO();

  return `
    <div class="day-card done-card sess-card"${session.variant ? ` data-variant="${esc(session.variant)}"` : ''}>
      <div class="focus">${isToday ? '✓ Hoje · ' : ''}${esc(fmtDate(session.date))}${slot ? ` · ${esc(slot + variantTxt)}` : ''}</div>
      <div class="range">
        ${session.exercises.length} ${session.exercises.length === 1 ? 'exercício' : 'exercícios'} ·
        ${nSets} ${nSets === 1 ? 'série' : 'séries'} ·
        ${Math.round(vol).toLocaleString('pt-BR')} kg de volume
      </div>
      <div class="done-list">${sessionRowsHTML(session)}</div>
      <button class="btn ghost edit-sess" data-date="${esc(session.date)}" style="margin-top:12px">
        Corrigir este treino
      </button>
    </div>`;
}

// works on a copy, nothing is written before "Salvar correção"; undo puts the
// whole previous version back
function openSessionEditor(date) {
  const orig = (state.sessions || []).find((s) => s.date === date);
  if (!orig) { toast('Treino não encontrado.', true); return; }

  const work = {
    ...structuredClone(orig),
    exercises: (orig.exercises || []).map((e) => ({
      ...structuredClone(e),
      sets: (e.sets || []).map((x) => ({ ...x })),
    })),
  };
  const catalog = exerciseCatalog(state.sessions);

  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay picker';
  overlay.innerHTML = `
    <div class="confirm-box" role="dialog" aria-label="Corrigir treino">
      <p class="pk-title">Corrigir treino de ${esc(fmtDate(date))}</p>
      <p class="hint" style="padding-top:0">
        Mude a carga e as repetições direto nos campos. <b>trocar</b>, ao lado do
        nome, corrige o exercício quando o registro foi parar no errado — as
        séries continuam as mesmas. Série com repetições em branco é descartada
        ao salvar; carga em branco vale como peso do corpo.
      </p>
      <div class="sess-edit"></div>
      <div class="sess-add"></div>
      <p class="hint sess-sum" style="padding-bottom:4px"></p>
      <div class="btn-row">
        <button class="btn ghost" data-a="no">Cancelar</button>
        <button class="btn primary" data-a="yes">Salvar correção</button>
      </div>
      <button class="link-btn danger-link" data-a="del" type="button">Apagar este treino do histórico</button>
    </div>`;
  document.body.appendChild(overlay);

  const body = $('.sess-edit', overlay);
  const addBox = $('.sess-add', overlay);
  const sum = $('.sess-sum', overlay);
  let picking = null;
  let addRows = [];

  function draw() {
    body.innerHTML = work.exercises.length ? work.exercises.map((e, ei) => {
      const misfiled = misfiledUnder(e, catalog);
      return `
      <div class="se-ex">
        <div class="se-head">
          <span class="nm">${esc(e.name)}
            ${misfiled ? `<small class="se-warn">as séries estão no histórico de <b>${esc(misfiled)}</b> — use "trocar" para corrigir</small>` : ''}
          </span>
          <button type="button" class="link-btn se-swap" data-swap-ex="${ei}">trocar</button>
          <button type="button" class="se-x" data-rm-ex="${ei}" aria-label="Remover exercício">✕</button>
        </div>
        ${e.sets.map((st, si) => `
          <div class="set-row">
            <span class="idx">${si + 1}</span>
            <div class="field">
              <input type="number" inputmode="decimal" step="0.5" min="0" placeholder="corpo"
                data-ei="${ei}" data-si="${si}" data-f="load" value="${st.load ? fmtKg(st.load) : ''}">
              <span class="unit">kg</span>
            </div>
            <div class="field">
              <input type="number" inputmode="numeric" step="1" min="0" placeholder="reps"
                data-ei="${ei}" data-si="${si}" data-f="reps" value="${st.reps ?? ''}">
              <span class="unit">rep</span>
            </div>
            <button type="button" class="icon-btn" data-rm-set="${ei}:${si}" aria-label="Remover série">✕</button>
          </div>`).join('')}
        <button type="button" class="link-btn se-more" data-add-set="${ei}">+ série</button>
      </div>`;
    }).join('')
      : '<p class="hint">Nenhum exercício. Salvar assim apaga o treino do histórico.</p>';

    const nSets = work.exercises.reduce((n, e) => n + e.sets.length, 0);
    sum.textContent = `${work.exercises.length} ${work.exercises.length === 1 ? 'exercício' : 'exercícios'} · `
      + `${nSets} ${nSets === 1 ? 'série' : 'séries'}`;
  }

  function drawPicker() {
    if (!picking) {
      addBox.innerHTML = '<button type="button" class="btn ghost" data-pick="add">+ exercício esquecido</button>';
      return;
    }
    const dest = picking.mode === 'swap' ? work.exercises[picking.ei]?.name : null;
    addBox.innerHTML = `
      <p class="hint" style="padding:8px 0 2px">
        ${dest ? `Trocar <b>${esc(dest)}</b> por qual exercício? As séries continuam as mesmas.`
               : 'Qual exercício entra neste treino?'}
      </p>
      <div class="field">
        <input type="search" class="se-q" placeholder="buscar no histórico ou digitar o nome certo"
          autocomplete="off" autocorrect="off" style="text-align:left; padding-right:11px">
      </div>
      <div class="pk-list se-list"></div>
      <button type="button" class="link-btn" data-pick="off">cancelar</button>`;
    drawPickList();
    const q = $('.se-q', addBox);
    q.addEventListener('input', drawPickList);
    q.focus();
  }

  function drawPickList() {
    const typed = ($('.se-q', addBox)?.value || '').trim();
    const words = fold(typed).split(/\s+/).filter(Boolean);
    addRows = catalog.filter((c) => words.every((w) => fold(c.name).includes(w))).slice(0, 12);

    const ident = typed ? identifyName(typed, catalog) : { valid: false };
    if (ident.valid && ident.existing) {
      addRows = [ident.existing, ...addRows.filter((c) => c.id !== ident.existing.id)];
    } else if (ident.valid && !addRows.some((c) => c.id === ident.id)) {
      // new name goes FIRST. The list scrolls inside a short box and the "create"
      // row at the bottom went unnoticed, looked like new names weren't allowed
      addRows = [{ id: ident.id, name: cleanName(typed), samples: 0, isNew: true }, ...addRows];
    }

    $('.se-list', addBox).innerHTML = addRows.length
      ? addRows.map((c, i) => {
        const misfiledNote = !c.isNew && c.id !== exactId(c.name) ? ` · gravado em "${c.id.replace(/-/g, ' ')}"` : '';
        const info = c.isNew ? 'nome novo — começa sem histórico' : `${c.samples} séries no histórico${misfiledNote}`;
        return `<button type="button" class="pk-item${c.isNew ? ' new' : ''}${misfiledNote ? ' odd' : ''}" data-add="${i}">
          ${c.isNew ? '＋ ' : ''}${esc(c.name)}<small>${esc(info)}</small>
        </button>`;
      }).join('')
      : '<p class="hint">Nada com esse nome no histórico — escreva o nome completo para criar.</p>';
  }

  body.addEventListener('input', (ev) => {
    const el = ev.target;
    if (!el.dataset?.f) return;
    const st = work.exercises[+el.dataset.ei]?.sets[+el.dataset.si];
    if (!st) return;
    const v = el.value.trim().replace(',', '.');
    if (el.dataset.f === 'load') st.load = v === '' ? null : Number(v);
    else st.reps = v === '' ? null : Math.round(Number(v));
  });

  body.addEventListener('click', (ev) => {
    const swapEx = ev.target.closest('[data-swap-ex]');
    if (swapEx) { picking = { mode: 'swap', ei: +swapEx.dataset.swapEx }; drawPicker(); return; }

    const rmEx = ev.target.closest('[data-rm-ex]');
    if (rmEx) {
      work.exercises.splice(+rmEx.dataset.rmEx, 1);
      if (picking?.mode === 'swap') { picking = null; drawPicker(); }
      draw();
      return;
    }

    const rmSet = ev.target.closest('[data-rm-set]');
    if (rmSet) {
      const [ei, si] = rmSet.dataset.rmSet.split(':').map(Number);
      work.exercises[ei].sets.splice(si, 1);
      draw();
      return;
    }

    const addSet = ev.target.closest('[data-add-set]');
    if (addSet) {
      const e = work.exercises[+addSet.dataset.addSet];
      const last = e.sets[e.sets.length - 1];
      e.sets.push({ load: last?.load ?? null, reps: null });
      draw();
    }
  });

  addBox.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-pick]');
    if (t) { picking = t.dataset.pick === 'add' ? { mode: 'add' } : null; drawPicker(); return; }

    const pick = ev.target.closest('[data-add]');
    if (!pick || !picking) return;
    const c = addRows[+pick.dataset.add];
    if (!c) return;

    if (picking.mode === 'swap') {
      const e = work.exercises[picking.ei];
      if (e) {
        e.id = c.id;
        e.name = c.name;
        e.group = c.group || e.group || work.slot || null;

        delete e.slotKey;
      }
    } else {
      work.exercises.push({ id: c.id, name: c.name, group: c.group || work.slot || null,
        sets: [{ load: null, reps: null }] });
    }

    picking = null;
    drawPicker();
    draw();
  });

  overlay.addEventListener('click', async (ev) => {
    if (ev.target === overlay) { overlay.remove(); return; }
    const a = ev.target.closest('[data-a]')?.dataset.a;
    if (a === 'no') { overlay.remove(); return; }

    if (a === 'del') {
      const ok = await confirmDialog(`Apagar o treino de ${fmtDate(date)} do histórico?`, { danger: true });
      if (ok) { overlay.remove(); deleteDay(date); }
      return;
    }

    if (a === 'yes') {
      const cleaned = work.exercises.map((e) => ({
        ...e,
        sets: e.sets.filter((st) => Number(st.reps) > 0).map((st) => {
          const kg = Number(st.load);
          const loadKg = Number.isFinite(kg) && kg > 0 ? kg : 0;
          return { ...st, load: loadKg, reps: Math.round(Number(st.reps)), bodyweight: !loadKg };
        }),
      }));
      const exercises = cleaned.filter((e) => e.sets.length);

      // an added exercise left without reps used to vanish silently and it looked
      // like saving had failed. Ask first, naming what gets dropped
      const dropped = cleaned.filter((e) => !e.sets.length).map((e) => e.name);
      if (dropped.length && exercises.length) {
        const names = dropped.join(', ');
        const ok = await confirmDialog(
          `${names} ${dropped.length === 1 ? 'ficou' : 'ficaram'} sem nenhuma repetição preenchida e não `
          + `${dropped.length === 1 ? 'vai ser gravado' : 'vão ser gravados'}. Salvar assim mesmo?`,
          { danger: true });
        if (!ok) return;
      }

      if (!exercises.length) {
        const ok = await confirmDialog('Sem nenhuma série, o treino inteiro sai do histórico. Apagar?', { danger: true });
        if (!ok) return;
        overlay.remove();
        deleteDay(date);
        return;
      }

      const res = db.updateSession(date, { ...work, exercises });
      if (!res.ok) { toast('Erro ao salvar: ' + res.error, true); return; }
      overlay.remove();
      state = db.load();
      renderHistory();
      toast(`Treino de ${fmtDate(date)} corrigido`, false, {
        label: 'Desfazer',
        fn: () => { db.restoreSession(res.previous); state = db.load(); renderHistory(); toast('Correção desfeita'); },
      });
    }
  });

  draw();
  drawPicker();
}

// While cards resolved history by similarity, a record's name and id could
// disagree: the card said Tradicional, the sets went to Frontal's id. Looking at
// the name alone you'd never notice, this says where the sets actually are.
function misfiledUnder(e, catalog) {
  if (!e?.id || !e?.name) return null;
  if (e.id === exactId(e.name)) return null;

  const realName = catalog.find((c) => c.id === e.id)?.name;
  return realName && realName !== e.name ? realName : e.id.replace(/-/g, ' ');
}

function deleteDay(date) {
  const res = db.deleteSession(date);
  if (!res.ok) { toast('Erro ao apagar: ' + res.error, true); return; }
  state = db.load();
  renderHistory();
  toast(`Treino de ${fmtDate(date)} apagado`, false, {
    label: 'Desfazer',
    fn: () => { db.restoreSession(res.previous); state = db.load(); renderHistory(); toast('Treino restaurado'); },
  });
}

function renderHistExercises(history) {
  const index = indexByExercise(history);
  const items = [...index.values()]
    .map((ex) => {
      const days = bestSetPerDay(ex.sessions.filter((s) => s.date && s.load > 0));
      return { id: ex.id, name: ex.name, group: ex.group, days, sets: ex.sessions.length };
    });

  const mainItems = items.filter((it) => it.days.length >= 2)
    .sort((a, b) => b.days.length - a.days.length);
  // one workout only is almost never a new exercise, it's a machine spelled
  // differently. Still has to SHOW (so it can be renamed/merged), just not in the main list
  const loose = items.filter((it) => it.days.length < 2)
    .sort((a, b) => b.sets - a.sets || a.name.localeCompare(b.name));

  $('#hist-count').textContent = `${mainItems.length} exercícios`;

  $('#hist-body').innerHTML = `
    <div class="legend">
      <p>Todos os treinos de cada exercício, do mais antigo ao mais recente.
      <b>Arraste o gráfico para os lados</b> para ver o histórico inteiro.</p>
      <p><b>renomear</b> corrige o nome em todo o histórico — e, se o nome já
      existir, junta os dois num histórico só.</p>
    </div>
    <div class="field" style="margin-bottom:14px">
      <input type="search" id="hist-filter" placeholder="filtrar exercício…"
        autocapitalize="off" style="text-align:left; padding-right:11px">
    </div>
    <div id="hist-list">
      ${mainItems.map(historyBlock).join('')}
      ${loose.length ? `<details class="loose">
        <summary>Grafias soltas — ${loose.length} com um treino só</summary>
        <p class="hint" style="padding-top:6px">Estes apareceram uma vez só. Quase sempre é um
        aparelho que já está na lista de cima, escrito diferente: <b>renomear</b> com o nome
        certo funde os dois.</p>
        ${loose.map(historyBlock).join('')}
      </details>` : ''}
    </div>`;

  $('#hist-filter').addEventListener('input', (ev) => {
    const q = ev.target.value.trim().toLowerCase();

    const det = $('#hist-list details');
    if (det && q) det.open = true;
    $$('#hist-list .hist-block').forEach((el) => {
      el.style.display = !q || el.dataset.name.includes(q) ? '' : 'none';
    });
  });

  $$('#hist-list .rn').forEach((b) =>
    b.addEventListener('click', () => openRenameDialog(b.dataset.id)));
}

function openRenameDialog(id) {
  const catalog = exerciseCatalog(state.sessions);
  const current = catalog.find((c) => c.id === id);
  if (!current) { toast('Exercício não encontrado.', true); return; }

  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay picker';
  overlay.innerHTML = `
    <div class="confirm-box" role="dialog" aria-label="Renomear exercício">
      <p class="pk-title">Renomear exercício</p>
      <p class="hint" style="padding-top:0">
        <b>${esc(current.name)}</b> · ${current.samples} ${current.samples === 1 ? 'série' : 'séries'} no histórico
      </p>
      <div class="field">
        <input type="text" class="rn-q" autocomplete="off" autocorrect="off" spellcheck="false"
          style="text-align:left; padding-right:11px" value="${esc(current.name)}">
      </div>
      <div class="pk-list se-list"></div>
      <p class="hint rn-sum" style="padding-bottom:4px"></p>
      <div class="btn-row">
        <button class="btn ghost" data-a="no">Cancelar</button>
        <button class="btn primary" data-a="yes">Renomear</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const q = $('.rn-q', overlay);
  const listEl = $('.se-list', overlay);
  const sum = $('.rn-sum', overlay);
  const yes = $('[data-a="yes"]', overlay);
  let rows = [];
  let dest = null;

  function draw() {
    const typed = q.value.trim();
    const words = fold(typed).split(/\s+/).filter(Boolean);
    rows = catalog
      .filter((c) => c.id !== id && words.every((w) => fold(c.name).includes(w)))
      .slice(0, 8);
    listEl.innerHTML = rows.length
      ? `<div class="pk-sec">Juntar com um que já existe</div>` + rows.map((c, i) =>
          `<button type="button" class="pk-item" data-i="${i}">${esc(c.name)}<small>${c.samples} séries</small></button>`).join('')
      : '';

    const ident = typed ? identifyName(typed, catalog) : { valid: false };
    if (!ident.valid) {
      dest = null;
      sum.textContent = typed ? 'Isso não parece nome de exercício — escreva o nome completo.' : 'Escreva o novo nome.';
      yes.disabled = true;
      yes.textContent = 'Renomear';
      return;
    }
    const mergeInto = ident.existing && ident.existing.id !== id ? ident.existing : null;
    dest = { id: ident.id, name: mergeInto ? mergeInto.name : cleanName(typed) };
    yes.disabled = false;
    if (mergeInto) {
      yes.textContent = 'Juntar';
      sum.innerHTML = `As ${current.samples} séries de <b>${esc(current.name)}</b> passam para
        <b>${esc(mergeInto.name)}</b>, que fica com ${mergeInto.samples + current.samples} séries.
        Os dois viram um histórico só.`;
    } else if (dest.id === id) {
      yes.textContent = 'Renomear';
      sum.innerHTML = `Só muda o nome que aparece: <b>${esc(dest.name)}</b>. O histórico continua o mesmo.`;
    } else {
      yes.textContent = 'Renomear';
      sum.innerHTML = `<b>${esc(current.name)}</b> passa a se chamar <b>${esc(dest.name)}</b>
        em todos os ${current.samples === 1 ? 'o registro' : 'os registros'}.`;
    }
  }

  q.addEventListener('input', draw);
  listEl.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-i]');
    if (!b) return;
    q.value = rows[+b.dataset.i].name;
    draw();
  });

  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) { overlay.remove(); return; }
    const a = ev.target.closest('[data-a]')?.dataset.a;
    if (a === 'no') { overlay.remove(); return; }
    if (a !== 'yes' || !dest || yes.disabled) return;

    const res = db.renameExercise(id, dest);
    if (!res.ok) { toast('Erro ao renomear: ' + res.error, true); return; }
    overlay.remove();
    state = db.load();
    renderHistory();
    toast(`${dest.name} · ${res.setCount} séries em ${res.days} ${res.days === 1 ? 'dia' : 'dias'}`, false, {
      label: 'Desfazer',
      fn: () => { db.restoreSessions(res.previous); state = db.load(); renderHistory(); toast('Renomear desfeito'); },
    });
  });

  draw();
  q.focus();
  q.select();
}

function historyBlock(item) {
  const misfiledNote = item.id && item.id !== exactId(item.name)
    ? ` · gravado em "${esc(item.id.replace(/-/g, ' '))}"` : '';

  if (item.days.length < 2) {
    const d = item.days[0];
    return `
      <div class="hist-block" data-name="${esc(item.name.toLowerCase())}">
        <div class="hist-head">
          <div class="nm">${esc(item.name)}
            <small>${item.sets} ${item.sets === 1 ? 'série' : 'séries'} ·
              ${d ? `${fmtKg(d.load)}kg × ${d.reps} em ${esc(dayLabel(d.date))}` : 'sem carga registrada'}${misfiledNote}</small>
          </div>
          <button type="button" class="link-btn rn" data-id="${esc(item.id)}">renomear</button>
        </div>
        <p class="hint" style="padding:2px 0 0">Um treino só — o gráfico aparece a partir do segundo.</p>
      </div>`;
  }

  const first = item.days[0];
  const last = item.days[item.days.length - 1];
  const peak = item.days.reduce((a, b) => (b.load > a.load ? b : a));
  const dir = last.load > first.load ? 'up' : last.load < first.load ? 'down' : 'flat';

  return `
    <div class="hist-block" data-name="${esc(item.name.toLowerCase())}">
      <div class="hist-head">
        <div class="nm">${esc(item.name)}
          <small>${item.days.length} treinos · ${item.sets} séries · recorde ${fmtKg(peak.load)}kg × ${peak.reps}${misfiledNote}</small>
        </div>
        <button type="button" class="link-btn rn" data-id="${esc(item.id)}">renomear</button>
      </div>
      ${loadChart(item.days, dir, { scroll: true })}
    </div>`;
}

function syncSection() {
  const s = state.settings || {};
  const configured = !!(s.githubRepo && s.githubToken);

  return `
    <div class="section">
      <h2>Sincronizar entre aparelhos</h2>
      <p class="hint" style="padding-top:0">
        Guarda o histórico num repositório <b>privado</b> do GitHub. Com a
        sincronia automática ligada, cada aparelho baixa as novidades ao abrir
        o app (e a cada minuto com ele aberto) e envia sozinho o que você muda
        — inclusive o treino em andamento. Sem internet, guarda e envia quando
        a rede voltar. Configure o mesmo repositório e token nos dois aparelhos.
      </p>

      <div class="field" style="margin-bottom:8px">
        <input type="text" id="sync-repo" placeholder="usuario/nome-do-repo"
          value="${esc(s.githubRepo ?? '')}" autocapitalize="off" autocorrect="off"
          style="text-align:left; padding-right:11px">
      </div>
      <div class="field" style="margin-bottom:8px">
        <input type="password" id="sync-token" placeholder="token do GitHub (fine-grained)"
          value="${esc(s.githubToken ?? '')}" autocapitalize="off" autocorrect="off"
          style="text-align:left; padding-right:11px">
      </div>

      <button class="btn ghost" id="sync-verify">Verificar conexão</button>

      ${configured ? `
        <label class="pk-opt" style="margin-top:10px">
          <input type="checkbox" id="sync-auto"${s.autoSync !== false ? ' checked' : ''}>
          <span><b>Sincronização automática</b><small>desligada, só sincroniza pelo botão abaixo</small></span>
        </label>
        <button class="btn primary" id="sync-now">Sincronizar agora</button>
        <p class="hint" id="sync-status-line">${esc(syncStatusText())}</p>
      ` : ''}
    </div>`;
}

function syncConfig() {
  const repo = $('#sync-repo')?.value.trim();
  const token = $('#sync-token')?.value.trim();
  if (repo) db.updateSettings({ githubRepo: repo });
  return { repo, token, path: state.settings.githubPath || 'training-history.json' };
}

function syncErrorMessage(err) {
  return err instanceof SyncError ? err.message : ('Erro inesperado: ' + err.message);
}

function wireSyncButtons() {
  $('#sync-verify')?.addEventListener('click', async () => {
    const { repo, token } = syncConfig();
    const btn = $('#sync-verify');
    btn.disabled = true; btn.textContent = 'Verificando…';
    try {
      await syncVerify({ repo, token });
      db.updateSettings({ githubRepo: repo, githubToken: token });
      state = db.load();
      toast('Conectado — repositório privado confirmado');
      renderSettings();
      syncNow({ manual: true });
    } catch (err) {
      toast(syncErrorMessage(err), true);
      btn.disabled = false; btn.textContent = 'Verificar conexão';
    }
  });

  $('#sync-auto')?.addEventListener('change', (ev) => {
    db.updateSettings({ autoSync: ev.target.checked });
    state = db.load();
    if (ev.target.checked) syncNow();
    updateSyncChip();
  });

  $('#sync-now')?.addEventListener('click', () => syncNow({ manual: true }));
}

// Two files in the repo: history (sessions, program, cycle; changes rarely, a
// few hundred KB) and the draft of the workout in progress (a few KB, changes
// every set). Split so typing a set doesn't re-upload the whole history, and so
// the draft fits the keepalive request when the app gets backgrounded.
// Syncs on open, on focus, every 45s while open, when the network comes back
// and a few seconds after each change. Conflict -> pull, merge, push again.
const SYNC_POLL_MS = 45000;
const sync = { running: false, again: false, timer: null, status: 'idle', detail: '',
  lastOk: null, pending: false, refreshPending: false, etag: {} };

const draftPath = (p) => p.replace(/[^/]*$/, 'training-draft.json');
const typing = () => !!document.activeElement?.matches?.('input, textarea, select');

function syncCfg(manual = false) {
  const s = state.settings || {};
  if (!s.githubRepo || !s.githubToken) return null;
  if (s.autoSync === false && !manual) return null;
  return { repo: s.githubRepo, token: s.githubToken, path: s.githubPath || 'training-history.json' };
}

function scheduleSync(ms) {
  updateSyncChip();
  if (!syncCfg()) return;
  clearTimeout(sync.timer);
  sync.timer = setTimeout(() => syncNow(), ms);
}

function setSync(status, detail = '') {
  sync.status = status;
  sync.detail = detail;
  updateSyncChip();
}

async function syncNow({ manual = false } = {}) {
  const cfg = syncCfg(manual);
  if (!cfg) { updateSyncChip(); return; }
  if (sync.running) { sync.again = true; return; }
  if (!navigator.onLine) { setSync('offline'); if (manual) toast('Sem internet agora', true); return; }

  sync.running = true;
  setSync('busy');
  let changed = false;
  try {
    for (let attempt = 0; ; attempt++) {
      if (await pullAll(cfg)) changed = true;
      if (await pushAll(cfg)) break;  // false = the other phone pushed in between
      sync.etag = {};
      if (attempt >= 2) throw new SyncError('O outro aparelho está enviando ao mesmo tempo — tento de novo em instantes.', 'conflict');
    }
    sync.lastOk = new Date();
    setSync('ok');
    if (manual) toast('Sincronizado');
  } catch (err) {
    setSync(err.code === 'network' ? 'offline' : 'error', syncErrorMessage(err));
    if (manual) toast(syncErrorMessage(err), true);
  } finally {
    sync.running = false;
    const st = db.syncState();
    sync.pending = st.dirty || st.draftDirty;
    updateSyncChip();
    if (changed) refreshAfterSync();
    if (sync.again) { sync.again = false; scheduleSync(300); }
  }
}

async function pullAll(cfg) {
  let changed = false;

  // fingers on the keyboard: the draft here is the newest by definition
  const skipDraft = typing();
  const h = await syncPull({ ...cfg, etag: sync.etag.h });
  if (!h.notModified) {
    sync.etag.h = h.etag;
    if (h.data) changed = db.mergeRemote(h.data, h.sha, { skipDraft }).changed || changed;
    else db.markRemoteMissing();
  }
  const d = await syncPull({ ...cfg, path: draftPath(cfg.path), etag: sync.etag.d });
  if (!d.notModified) {
    sync.etag.d = d.etag;
    changed = db.mergeRemoteDraft(d.data, d.sha, { skip: skipDraft }).changed || changed;
  }
  state = db.load();
  return changed;
}

async function pushAll(cfg) {
  const st = db.syncState();
  try {
    if (st.dirty) {
      const { data, rev } = db.historyPayload();
      const r = await syncPush({ ...cfg, data, sha: st.lastSyncSha });
      db.markPushed('h', r.sha, rev);
    }
    if (st.draftDirty) {
      const { data, rev } = db.draftPayload();
      const r = await syncPush({ ...cfg, path: draftPath(cfg.path), data, sha: db.syncState().lastDraftSha });
      db.markPushed('d', r.sha, rev);
    }
  } catch (err) {
    if (err.code === 'conflict') return false;
    throw err;
  }
  state = db.load();
  return true;
}

// app going to the background: the draft goes out in a keepalive request that
// survives iOS freezing the page
function flushOnHide() {
  const cfg = syncCfg();
  if (!cfg || sync.running) return;
  const st = db.syncState();
  if (st.draftDirty) {
    const { data, rev } = db.draftPayload();
    syncPush({ ...cfg, path: draftPath(cfg.path), data, sha: st.lastDraftSha, keepalive: true })
      .then((r) => db.markPushed('d', r.sha, rev))
      .catch(() => {});
  }
  if (st.dirty) syncNow();
}

// if you're typing, wait until you leave the field. Nothing moves under your finger
function refreshAfterSync() {
  if (typing()) { sync.refreshPending = true; return; }
  sync.refreshPending = false;
  const open = $$('.ex.open').map((c) => c.dataset.default);
  state = db.load();
  draft = null;
  const v = ($('.view.active')?.id || '').replace('view-', '');
  if (v === 'today') { renderToday(); open.forEach(reopenCard); }
  else if (v === 'dash') renderDash();
  else if (v === 'hist') renderHistory();
  else if (v === 'settings') renderSettings();
}

function syncStatusText() {
  const s = state.settings || {};
  if (!s.githubRepo || !s.githubToken) return '';
  if (s.autoSync === false) return 'sincronia automática desligada';
  if (sync.status === 'busy') return 'sincronizando…';
  if (sync.status === 'offline') return 'sem internet — envia quando voltar';
  if (sync.status === 'error') return 'erro no sync — toque para tentar';
  if (sync.pending) return 'alterações a enviar…';
  if (sync.lastOk) return `sincronizado ${String(sync.lastOk.getHours()).padStart(2, '0')}:${String(sync.lastOk.getMinutes()).padStart(2, '0')}`;
  return 'sincronia ligada';
}

function updateSyncChip() {
  const txt = syncStatusText();
  const chip = $('#sync-chip');
  if (chip) {
    chip.hidden = !txt;
    chip.textContent = `☁︎ ${txt}`;
    chip.dataset.status = sync.status;
  }
  const line = $('#sync-status-line');
  if (line) line.textContent = txt + (sync.status === 'error' && sync.detail ? ` · ${sync.detail}` : '');
}

$('#sync-chip')?.addEventListener('click', () => {
  if (sync.status === 'error' && sync.detail) toast(sync.detail, true);
  syncNow({ manual: true });
});

db.onDirty((kind) => {
  sync.pending = true;

  // draft waits for a pause in typing
  scheduleSync(kind === 'd' ? 4000 : 1500);
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushOnHide();
  else syncNow();
});
document.addEventListener('focusout', () => {
  if (sync.refreshPending) setTimeout(() => { if (!typing() && sync.refreshPending) refreshAfterSync(); }, 400);
});
window.addEventListener('online', () => syncNow());
setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, SYNC_POLL_MS);

function editsSection() {
  const edits = state.programEdits || [];
  const active = edits.filter((e) => !e.undone).reverse();
  const undone = edits.filter((e) => e.undone).slice(-8).reverse();
  const where = (e) => (e.slot === 'daily' ? 'todos os treinos' : `${SLOT_LABEL[e.slot] ?? e.slot} ${e.variant ?? 'A e B'}`);
  const what = (e) => (e.action === 'remove'
    ? `<b>${esc(e.targetName)}</b> removido`
    : e.action === 'add'
    ? `<b>${esc(e.name)}</b> adicionado`
    : `${esc(e.targetName)} → <b>${esc(e.name)}</b>`);
  const row = (e) => `
    <div class="edit-row${e.undone ? ' undone' : ''}">
      <div class="nm">${what(e)}<small>${esc(where(e))} · ${esc(fmtDateTime(e.createdAt))}</small></div>
      <button class="btn ghost sm" data-edit="${esc(e.id)}" data-undo="${e.undone ? '0' : '1'}">${e.undone ? 'Reativar' : 'Desfazer'}</button>
    </div>`;

  return `
    <div class="section">
      <h2>Alterações do programa</h2>
      <p class="hint" style="padding-top:0">
        Trocas definitivas feitas no card do exercício (⇄ Trocar). Só mudam o que
        aparece no treino — o histórico nunca é alterado. Vão junto no sync.
      </p>
      ${active.length ? active.map(row).join('') : '<p class="hint">Nenhuma alteração ativa — o programa está como o original.</p>'}
      ${undone.length ? `<details class="edit-old"><summary>Desfeitas (${undone.length})</summary>${undone.map(row).join('')}</details>` : ''}
    </div>`;
}

function restoreSection() {
  const pts = db.listRestorePoints();
  return `
    <div class="section">
      <h2>Pontos de restauração</h2>
      <p class="hint" style="padding-top:0">
        Cópia automática tirada antes de importar texto, baixar do GitHub,
        restaurar backup ou apagar tudo. Ficam as 5 mais recentes, só neste aparelho.
      </p>
      ${pts.length ? pts.map((p) => `
        <div class="edit-row">
          <div class="nm">${esc(p.reason)}<small>${esc(fmtDateTime(p.at))} · ${p.days} dias</small></div>
          <button class="btn ghost sm" data-restore="${p.i}">Restaurar</button>
        </div>`).join('') + '<button class="btn ghost" id="btn-clear-points">Apagar pontos de restauração</button>'
      : '<p class="hint">Nenhum ainda.</p>'}
    </div>`;
}

function wireEditsAndRestore() {
  $$('[data-edit]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.edit;
    const undo = b.dataset.undo === '1';
    db.setProgramEditUndone(id, undo);
    state = db.load(); draft = null;
    renderSettings();
    toast(undo ? 'Alteração desfeita' : 'Alteração reativada', false, {
      label: undo ? 'Refazer' : 'Desfazer',
      fn: () => { db.setProgramEditUndone(id, !undo); state = db.load(); draft = null; renderSettings(); },
    });
  }));

  $$('[data-restore]').forEach((b) => b.addEventListener('click', async () => {
    const ok = await confirmDialog(
      'Voltar histórico, programa e ciclo para este ponto? O estado atual vira um ponto de restauração antes, então dá para voltar.',
      { danger: true });
    if (!ok) return;
    const res = db.restorePoint(Number(b.dataset.restore));
    if (!res.ok) { toast('Não foi possível restaurar: ' + res.error, true); return; }
    state = db.load(); draft = null;
    toast(`Restaurado · ${state.sessions.length} dias`);
    renderSettings();
  }));

  $('#btn-clear-points')?.addEventListener('click', async () => {
    const ok = await confirmDialog('Apagar todas as cópias de segurança deste aparelho? O histórico atual não é afetado.', { danger: true });
    if (!ok) return;
    db.clearRestorePoints();
    toast('Pontos de restauração apagados');
    renderSettings();
  });
}

function renderSettings() {
  const root = $('#settings-content');
  const next = upcoming(state, 6);

  root.innerHTML = `
    <div class="section">
      <h2>Posição no ciclo</h2>
      <p class="hint" style="padding-top:0">
        O ciclo avança só quando você conclui ou adia um treino — descansar um dia a mais não pula nada.
      </p>
      ${next.map((u) => `
        <div class="prog-row">
          <div class="nm">${esc(u.title)}</div>
          <div class="val">${u.isNext ? 'próximo' : ''}</div>
          <div class="delta flat"></div>
        </div>`).join('')}
      <div class="btn-row" style="margin-top:10px">
        <button class="btn ghost" id="cycle-back">← Voltar um</button>
        <button class="btn ghost" id="cycle-fwd">Avançar um →</button>
      </div>
    </div>

    ${editsSection()}

    ${syncSection()}

    ${restoreSection()}

    <div class="section">
      <h2>Backup manual</h2>
      <p class="hint" style="padding-top:0">
        Alternativa ao sync: salva um arquivo com todo o histórico. No iPhone
        ele vai para o app Arquivos — se estiver no iCloud, aparece sozinho no PC.
      </p>
      <button class="btn ghost" id="btn-export">Salvar backup no aparelho</button>
      <input type="file" id="file-import" accept="application/json" style="display:none">
      <button class="btn ghost" id="btn-file">Restaurar de um arquivo</button>
      <button class="btn ghost" id="btn-copy">Copiar backup como texto</button>
    </div>

    <div class="section">
      <h2>Dados</h2>
      <p class="hint" style="padding-top:0">
        ${state.sessions.length} dias salvos neste aparelho ·
        atualizado ${state.updatedAt ? fmtDate(state.updatedAt.slice(0, 10)) : '—'}
      </p>
      <button class="btn danger" id="btn-clear">Apagar tudo deste aparelho</button>
    </div>
  `;

  $('#cycle-back').addEventListener('click', () => {
    db.setCyclePosition(Math.max(0, (state.cyclePosition || 0) - 1));
    state = db.load(); draft = null; renderSettings(); toast('Ciclo recuado');
  });
  $('#cycle-fwd').addEventListener('click', () => {
    db.setCyclePosition((state.cyclePosition || 0) + 1);
    state = db.load(); draft = null; renderSettings(); toast('Ciclo avançado');
  });

  wireSyncButtons();
  wireEditsAndRestore();

  $('#btn-export').addEventListener('click', saveBackup);

  $('#btn-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(db.exportJSON());
      toast('Backup copiado');
    } catch {
      toast('O navegador bloqueou a cópia', true);
    }
  });

  $('#btn-file').addEventListener('click', () => $('#file-import').click());
  $('#file-import').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    try {
      db.importJSON(await file.text());
      state = db.load(); draft = null;
      toast(`Restaurado · ${state.sessions.length} dias`);
      renderSettings();
    } catch (err) {
      toast('Arquivo inválido: ' + err.message, true);
    }
  });

  $('#btn-clear').addEventListener('click', async () => {
    const ok = await confirmDialog(
      'Apagar todo o histórico deste aparelho? Uma cópia fica em "Pontos de restauração" por segurança (dá para apagá-la lá).',
      { danger: true }
    );
    if (!ok) return;
    db.clear();
    state = db.load(); draft = null;
    toast('Tudo apagado');
    renderSettings();
  });
}

function saveBackup() {
  const filename = `ppl-backup-${todayISO()}.json`;
  const blob = new Blob([db.exportJSON()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  // revoking right away breaks the download on iOS Safari, give it a moment
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  toast('Backup baixado');
}

renderToday();
updateSyncChip();
syncNow();

// for poking at state from Safari's web inspector mid-workout
window.PPL = { db, get state() { return state; }, parseHistory, workoutForPosition,
  syncNow: (o) => { state = db.load(); return syncNow(o); } };

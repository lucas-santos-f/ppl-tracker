// App shell: tab router + every screen. Plain DOM and template strings, no framework.

import { db } from './db.js';
import { icon } from './icons.js';
import { exName } from './names.js';
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
// permanent edit) goes through undoable(). The toast offers Undo for 7s and
// the top of Today keeps the last one. Entries remember the cycle position:
// once you're on another workout they no longer apply.
const undoStack = [];

function undoable(label, undo) {
  const entry = { label, undo, pos: state.cyclePosition || 0 };
  undoStack.push(entry);
  if (undoStack.length > 20) undoStack.shift();
  toast(label, false, { label: 'Undo', fn: () => runUndo(entry) });
  updateUndoBar();
}

function runUndo(entry) {
  const i = undoStack.indexOf(entry);
  if (i < 0) return;
  undoStack.splice(i, 1);
  if (entry.pos !== (state.cyclePosition || 0)) {
    toast("Can't undo that anymore, the workout has moved on", true);
    updateUndoBar();
    return;
  }
  entry.undo();
  toast('Undone: ' + entry.label);
  updateUndoBar();
}

function updateUndoBar() {
  const slot = $('#undo-slot');
  if (!slot) return;
  const cur = state.cyclePosition || 0;
  const last = [...undoStack].reverse().find((u) => u.pos === cur);
  slot.innerHTML = last ? `<button class="btn ghost undo-bar" type="button">↶ Undo: ${esc(last.label)}</button>` : '';
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
          <button class="btn ghost" data-a="no">Cancel</button>
          <button class="btn ${danger ? 'danger-solid' : 'primary'}" data-a="yes">Confirm</button>
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${MONTHS[m - 1]} ${+d}, ${y}`;
}

// short form for tight spots (chart labels, the leftover draft banner)
const fmtDay = (iso) => (iso ? `${MONTHS[iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}` : '');

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

const volHeadRow = (firstCol = 'day') => `
  <div class="vol-row cols">
    <span class="d">${esc(firstCol)}</span>
    <span class="n">sets</span>
    <span class="v">volume</span>
    <span class="p">vs prev</span>
  </div>`;

const setsLine = (sets) => setsTxt(sets, null);

function renderVolumeTab() {
  const root = $('#vol-content');
  const sessions = volSessions(state.sessions || []);

  if (!sessions.length) {
    root.innerHTML = `<div class="empty"><div class="big">${icon('layers', 'i big-i')}</div>
      <p>No data yet.<br>Import or log a workout to see volume.</p></div>`;
    $('#vol-range').textContent = '';
    return;
  }
  $('#vol-range').textContent = `${sessions.length} workouts`;

  const filtered = volSlotFilter === 'all' ? sessions : sessions.filter((s) => s.slot === volSlotFilter);
  const shown = filtered.slice(0, VOL_SESSIONS);

  // previous workout of the SAME group, Push vs Legs says nothing
  const prevOf = (s) => sessions.find((o) => o.date < s.date && o.slot === s.slot);

  const exRow = (e, prevEx) => {
    const c = prevEx ? compareAtEqualSets(e.sets, prevEx.sets) : null;
    const tip = c ? `compared over ${c.usedSets} sets` : 'not in the previous workout';
    return `<div class="vol-row">
      <span class="d">${esc(exName(e.name))}</span>
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
    const groupLabel = SLOT_LABEL[s.slot] ?? 'no group';

    const vs = cmp ? `${fmtPct(cmp.pct)} vs ${fmtDate(prev.date)}`
      : prev ? 'no exercise in common' : 'first workout of the group';
    return `<div class="vol-card">
      <div class="vol-card-h">
        <div class="vol-when">
          <b>${esc(fmtDate(s.date))}</b>
          <small>${esc(groupLabel)}${s.variant ? ` ${esc(s.variant)}` : ''} · ${s.exercises.length} exercises</small>
        </div>
        <div class="vol-total">
          <b>${s.volume > 0 ? esc(fmtVolume(s.volume)) : '—'}</b>
          <small class="${pctCls(cmp?.pct)}">${esc(vs)}</small>
        </div>
      </div>
      <div class="vol">${volHeadRow('exercise')}${s.exercises.map((e) => exRow(e, byId.get(e.id))).join('')}</div>
    </div>`;
  };

  const segBtn = (v, label) => `<button class="${volSlotFilter === v ? 'on' : ''}" data-slot="${v}">${esc(label)}</button>`;

  root.innerHTML = `
    <div class="seg seg-4">
      ${segBtn('all', 'All')}${segBtn('push', 'Push')}${segBtn('pull', 'Pull')}${segBtn('legs', 'Legs')}
    </div>
    <div class="legend">
      <p><b>Volume</b> = load × reps over every working set, including what was
      done in techniques (drop set, rest-pause, cluster). Warm-ups are left out.</p>
      <p><b>+8% / −3%</b> = change against the previous workout of the same
      group, computed <b>at the same number of sets</b>: if the last one had 4
      sets and this one 5, the fifth doesn't count.</p>
      <p>The workout total only includes exercises done on both days, so
      swapping an exercise in or out doesn't show up as a gain or a loss.</p>
      <p>Exercises <b>without load</b> (pull-ups, dips, abs) have no tonnage:
      they count total reps and stay out of the workout's kg total.</p>
    </div>
    ${shown.map(card).join('')}
    ${filtered.length > shown.length
      ? `<p class="hint">Showing the latest ${shown.length} of ${filtered.length}.</p>` : ''}
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
    lines.push(row('today', todayVol, nToday, b > 0 ? { pct: ((a - b) / b) * 100 } : null, 'now'));
  }
  const nSets = (s) => s.exercises.reduce((t, e) => t + e.sets.length, 0);
  pastDays.forEach((s, i) => lines.push(row(fmtDate(s.date), s.volume, nSets(s), compareSessions(s, pastDays[i + 1]))));

  return `<div class="vol-box-day"><div class="vol">
    <div class="vol-head">Workout volume · ${esc(SLOT_LABEL[w.slot] ?? '')}
      <span>total weight moved (load × reps) in the last ${pastDays.length} workouts of this group</span></div>
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
        <div class="big">${icon('paste', 'i big-i')}</div>
        <p>No history yet.<br>Import your log to get started.</p>
        <button class="btn primary" id="go-import">Import history</button>
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

    // draft from an earlier day that never got "Finish workout". Can't be ignored:
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
        <div class="big">${icon('search', 'i big-i')}</div>
        <p>No <b>${esc(SLOT_LABEL[w.slot])}</b> workout in the history, so there's
        nothing to build the exercise list from.</p>
        <button class="btn ghost" id="skip-day">Skip to the next workout</button>
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
      ${icon('alert', 'i inline')} The <b>${esc(fmtDay(w.date))}</b> workout was never
      finished. Check it and tap <b>Finish workout</b>: it goes into the history
      dated ${esc(fmtDay(w.date))}.
      <button class="btn ghost" id="discard-old" type="button" style="margin-top:8px">Discard this draft</button>
    </div>` : ''}

    <div class="day-card" data-variant="${w.variant}">
      <div class="day-top">
        <span class="focus">${esc(w.subtitle)} · ${lo}–${hi} reps</span>
        <span class="day-pct">${Math.round(INTENSITY[w.variant] * 100)}% 1RM</span>
      </div>
      <p class="slot">${esc(w.title)}</p>
      ${main ? `<div class="range">
        Main lift: <b>${esc(exName(main.name))}</b> · ${esc(mainPlanTxt(main.activePlan))}
      </div>` : ''}
      ${heavy ? `<div class="range">
        Heavy block: ${esc(exName(heavy.name))} at ${heavy.repRange[0]}–${heavy.repRange[1]} reps
      </div>` : ''}
      <div class="day-progress"><span id="ex-bar" style="width:${pctDone(done, w.exercises.length)}%"></span></div>
      <div class="range small" id="ex-count">${done}/${w.exercises.length} exercises logged</div>
    </div>

    <div id="day-vol">${slotVolumeHTML(w)}</div>

    <div id="ex-list">
      ${w.exercises.map((e, i) => exerciseCard(activeEx(e), i, w.variant)).join('')}
    </div>

    <button class="btn ghost add-ex-btn" id="add-ex" type="button">
      <span class="plus">+</span> Add exercise
    </button>

    ${done > 0 ? `<p class="hint pending">
      Filled in but not finished. It's saved (and synced to the other phone), but
      it only goes into the history after <b>Finish workout</b>.
    </p>` : ''}

    <button class="btn ${isForca ? 'forca' : 'hiper'}" id="finish">Finish workout</button>
    <button class="btn ghost" id="skip">Skip this workout (postpone)</button>
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
    undoable('Old draft discarded', () => { if (saved) db.saveDraft(saved); draft = null; renderToday(); });
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
    return `<div class="done-row"><span class="dn">${esc(exName(e.name))}</span><span class="ds">${esc(sets)}</span></div>`;
  }).join('');
}

function finishedCard(session) {
  const lines = sessionRowsHTML(session);

  return `
    <div class="day-card done-card" data-variant="${esc(session.variant || 'A')}">
      <div class="focus">✓ Done today${session.slot ? ' · ' + esc(SLOT_LABEL[session.slot] ?? '') : ''}</div>
      <div class="done-list">${lines}</div>
      <button class="btn ghost reopen" data-date="${esc(session.date)}" style="margin-top:12px">
        Reopen to fix
      </button>
    </div>`;
}

async function reopenWorkout(date) {
  const session = (state.sessions || []).find((s) => s.date === date && s.logged);
  if (!session) return;

  const ok = await confirmDialog('Reopen this workout to fix the numbers?');
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
  toast('Workout reopened, finish it again when done');
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
        e.logStyle === 'minutes' ? 'minutes'
        : e.logStyle === 'seconds' ? 'seconds'
        : e.logStyle === 'reps' ? 'reps only'
        : e.bodyweight ? 'bodyweight'
        : e.noHistory ? 'pick a load' : 'bodyweight'
      }</div>`;

  // formula asked for more than anything ever lifted on this exercise
  const cappedNote = e.capped
    ? `<div class="hint capped">⚠︎ The formula asked for <b>${e.uncappedLoad}kg</b>, above your best
       of <b>${e.bestLoad}kg</b>. Capped at +10% over the best.</div>`
    : '';

  const rows = setsHTML(e);
  const plan = e.activePlan;

  const variants = e.variants || [];
  const optLabel = (v) => `${exName(v.name)} · ${v.custom ? 'today only, ' : ''}${v.noHistory ? 'no history, you fill it in' : `${v.histSamples}× in your history`}`;
  const swapHTML = `${variants.length ? `
    <div class="swap">
      <label for="swap-${esc(e.defaultId)}">Exercise</label>
      <select class="ex-swap" id="swap-${esc(e.defaultId)}" data-default="${esc(e.defaultId)}">
        <option value="${esc(e.defaultId)}"${!e.isSwapped ? ' selected' : ''}>${esc(exName(e.defaultName))} · today's program</option>
        ${variants.map((v) => `<option value="${esc(v.exerciseId)}"${e.isSwapped && e.exerciseId === v.exerciseId ? ' selected' : ''}>${esc(optLabel(v))}</option>`).join('')}
        <option value="__all">See every ${esc(SLOT_LABEL[draft.slot] ?? 'today')} exercise…</option>
      </select>
    </div>` : ''}
    <button class="link-btn ex-change" type="button">⇄ See every ${esc(SLOT_LABEL[draft.slot] ?? 'today')} exercise…</button>
    <button class="link-btn danger-link ex-remove" type="button">${icon('trash', 'i inline')} Remove this exercise…</button>
    ${e.replacedFrom ? `<div class="hint note">Permanent swap: replaced <b>${esc(exName(e.replacedFrom))}</b>.
      To go back, Settings → Program changes.</div>` : ''}`;

  return `
    <div class="ex ${isDone ? 'done' : ''} ${e.isSwapped ? 'swapped' : ''}" data-variant="${variant}" data-id="${esc(e.exerciseId)}" data-default="${esc(e.defaultId ?? e.exerciseId)}">
      <div class="ex-head">
        <div class="check">✓</div>
        <div class="ex-name">
          <div class="part">${esc(e.part ?? '')}</div>
          <div class="n">${esc(exName(e.name))}</div>
          <div class="sub">${
            plan ? (e.mainPlan.calibrate
              ? 'calibration: no recent 1RM'
              : `1RM est. ${e.oneRM}kg · ${esc(plan.label)}`)
            : e.isSwapped ? (e.noHistory ? 'variation with no history, fill in the loads'
              : `variation from your history${e.oneRM ? ` · 1RM est. ${e.oneRM}kg` : ''}`)
            : e.daily ? 'daily routine, every workout'
            : e.noHistory ? 'new exercise, no history'
            : e.oneRM ? `1RM est. ${e.oneRM}kg` : 'bodyweight'
          }${e.stale ? ' · outdated' : ''}</div>
        </div>
        <div class="target">
          ${plan && e.targetLoad == null ? '<div class="kg bw">calibrate</div>' : targetHTML}
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
          ? `<div class="hint">History from <b>${esc(exName(e.matchedAs))}</b></div>` : ''}
        <div class="vol-box">${volumeHTML(e)}</div>
        ${cappedNote}
        ${plan ? mainPlanHTML(e, plan) : ''}
        <div class="sets">${rows}</div>
        <div class="bulk">
          <button class="icon-btn add-set">+ set</button>
          <button class="icon-btn fill-load" type="button" title="copies the load into the empty sets">⤓ same load</button>
          ${e.lastSets.length ? '<button class="icon-btn fill-last" type="button" title="fills the empty sets with the load, reps and technique from the last time you did this exercise, so a repeated workout doesn\'t need retyping">↺ repeat last workout</button>' : ''}
          <button class="icon-btn bulk-tech" type="button" title="mark a technique on several sets">${icon('bolt', 'i inline')} technique</button>
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
  if (!days.length && !nowSets.length) return '<div class="hint">First time on this exercise, nothing to compare with.</div>';

  const row = (label, sets, cmp, cls = '') => {
    const vol = e.logStyle ? null : fmtEffort(sets);
    const pctCls = !cmp || cmp.pct == null ? '' : cmp.pct > 0.5 ? 'up' : cmp.pct < -0.5 ? 'down' : '';
    const title = cmp ? `compared over ${cmp.usedSets} ${cmp.usedSets === 1 ? 'set' : 'sets'}` : '';
    return `<div class="vol-row ${cls}">
      <span class="d">${esc(label)}</span>
      <span class="n">${sets.length}×</span>
      <span class="v">${vol == null ? '' : esc(vol)}</span>
      <span class="p ${pctCls}" title="${esc(title)}">${cmp ? esc(fmtPct(cmp.pct)) : ''}</span>
      <span class="s">${esc(setsTxt(sets, e.logStyle))}</span>
    </div>`;
  };

  const lines = [];
  if (nowSets.length) lines.push(row('today', nowSets, days[0] ? compareAtEqualSets(nowSets, days[0].sets) : null, 'now'));
  days.forEach((d, i) => {
    const prev = days[i + 1];
    lines.push(row(fmtDate(d.date), d.sets, prev ? compareAtEqualSets(d.sets, prev.sets) : null));
  });

  return `<div class="vol">
    <div class="vol-head">${e.logStyle ? 'Last few times' : 'Volume per workout'}
      <span>${e.logStyle ? ''
        : 'volume = load × reps over all sets. The % compares with the row below, using only the sets both have.'}</span></div>
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
  'banco-cavalo-peito-remada': 'Up on the toes to lock the torso in and take pressure off the chest pad',
};

function exerciseComment(id) {
  const n = state.exerciseNotes?.[id];
  return n ? n.text : (DEFAULT_COMMENTS[id] || '');
}

function commentHTML(e) {
  const text = exerciseComment(e.exerciseId);
  return `<div class="ex-comment">${text
    ? `<div class="hint comment">${icon('note', 'i inline')} ${esc(text)}</div>
       <button class="link-btn comment-edit" type="button">✎ edit note</button>`
    : `<button class="link-btn comment-edit" type="button">${icon('note', 'i inline')} add a note</button>`}</div>`;
}

function editComment(card, id) {
  const box = $('.ex-comment', card);
  const before = exerciseComment(id);
  box.innerHTML = `
    <textarea class="comment-input" rows="3" placeholder="Saved, and shown every time this exercise comes up">${esc(before)}</textarea>
    <div class="bulk">
      <button class="icon-btn comment-save" type="button">Save</button>
      <button class="icon-btn comment-cancel" type="button">Cancel</button>
    </div>`;
  const ta = $('.comment-input', box);
  ta.focus();
  $('.comment-cancel', box).addEventListener('click', () => { box.outerHTML = commentHTML({ exerciseId: id }); bindComment(card, id); });
  $('.comment-save', box).addEventListener('click', () => {
    const text = ta.value.trim();
    const res = db.setExerciseNote(id, text);
    if (!res.ok) { toast('Could not save: ' + res.error, true); return; }
    state = db.load();
    $('.ex-comment', card).outerHTML = commentHTML({ exerciseId: id });
    bindComment(card, id);
    undoable(text ? 'Note saved' : 'Note deleted', () => {
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
    ? `<div class="hint">1RM estimated from <b>${e.mainPlan.basedOn.load}kg × ${e.mainPlan.basedOn.reps}</b> (${fmtDate(e.mainPlan.basedOn.date)}).</div>`
    : `<div class="hint note">No heavy set in the last 8 weeks: work up to a hard 5 with clean form. That set sets the percentages for the next workouts.</div>`;
  return `
    ${toggle}
    ${basis}
    <div class="plan">
      <div class="plan-h">Working sets</div>
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
      title="tap to change or clear">${esc(techniqueLabel(marked))}</button>`;
  }
  if (suggested) {
    return `<button type="button" class="tech-tag sug" data-type="${esc(suggested)}" data-tech="${si}"
      title="suggested from your history, tap to confirm or change">${esc(techniqueLabel(suggested))} ?</button>`;
  }
  return `<button type="button" class="tech-tag add" data-tech="${si}" title="mark a technique on this set">+ technique</button>`;
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
    ? `<div class="tech-tag" data-type="amrap">max reps</div>${techBtn(si, marked, null)}`
    : techBtn(si, marked, tech ? tech.type : null);

  if (e.logStyle) {
    const unit = e.logStyle === 'minutes' ? 'min' : e.logStyle === 'seconds' ? 'sec' : 'reps';
    const ph = e.logStyle === 'minutes' ? '10' : e.logStyle === 'seconds' ? '60' : '10';
    return `
      ${techTag}
      <div class="set-row single" data-set="${si}">
        <div class="idx">${si + 1}</div>
        <div class="field">
          <input type="number" inputmode="numeric" class="in-reps"
                 value="${reps}" placeholder="${ph}" aria-label="${unit} set ${si + 1}">
          <span class="unit">${unit}</span>
        </div>
        <button class="icon-btn del-set" aria-label="remove set">×</button>
      </div>`;
  }

  return `
    ${techTag}
    <div class="set-row" data-set="${si}">
      <div class="idx">${si + 1}</div>
      <div class="field">
        <input type="number" inputmode="decimal" step="0.5" class="in-load"
               value="${load}" placeholder="${loadPlaceholder}" aria-label="load set ${si + 1}">
        <span class="unit">kg</span>
      </div>
      <div class="field">
        <input type="number" inputmode="numeric" class="in-reps"
               value="${reps}" placeholder="—" data-hit="${hit}" aria-label="reps set ${si + 1}">
        <span class="unit">reps</span>
      </div>
      <button class="icon-btn del-set" aria-label="remove set">×</button>
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
      const name = swap.options[swap.selectedIndex].textContent.split(' · ')[0];
      (draft.swaps ||= {})[def] = swap.value;
      persistDraft();
      undoable(`${name} for this workout`, () => { restoreDraft(snap); renderToday(); reopenCard(def); });
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
        undoable(`Set ${si + 1} removed`, () => { restoreDraft(snap); renderToday(); reopenCard(def); });
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
  if (!ex || ex.logStyle) { toast('This exercise has no load.', true); return; }
  const log = (draft.logs[exId] ||= { sets: [] });
  const n = Math.max(log.sets.length, ex.plannedSets ?? 3);
  const filled = log.sets.filter((s) => s && s.load);
  const base = filled[filled.length - 1]?.load
    ?? ex.targetLoad
    ?? ex.lastSets.findLast((s) => s.load)?.load
    ?? null;
  if (base == null) { toast('Fill in the load of one set first.', true); return; }

  const snap = draftSnapshot();
  let changed = 0;
  for (let si = 0; si < n; si++) {
    const s = log.sets[si] || (log.sets[si] = { load: null, reps: null });
    if (s.load == null || s.load === '') { s.load = base; changed++; }
  }
  if (!changed) { toast('Every set already has a load.'); return; }
  refreshSets(exId);
  toast(`${base}kg on ${changed} ${changed === 1 ? 'set' : 'sets'}`, false,
    { label: 'Undo', fn: () => { restoreDraft(snap); renderToday(); reopenCard(ex.defaultId ?? exId); } });
}

function fillLast(exId) {
  const ex = exByActiveId(exId);
  if (!ex || !ex.lastSets.length) { toast('No previous workout for this exercise.', true); return; }
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
  if (!changed) { toast('The sets are already filled in.'); return; }
  refreshSets(exId);
  toast(`${changed} ${changed === 1 ? 'set' : 'sets'} copied from last time`, false,
    { label: 'Undo', fn: () => { restoreDraft(snap); renderToday(); reopenCard(ex.defaultId ?? exId); } });
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
    <div class="confirm-box" role="dialog" aria-label="Technique">
      <p class="pk-title">${esc(exName(ex.name))}${si == null ? '' : ` · set ${si + 1}`}</p>
      <div class="tech-opts"></div>
      <div class="tech-scope"></div>
      <div class="btn-row"><button class="btn ghost" data-a="no">Close</button></div>
    </div>`;
  document.body.appendChild(overlay);
  const opts = $('.tech-opts', overlay);
  const scope = $('.tech-scope', overlay);

  const draw = () => {
    opts.innerHTML = TECHNIQUE_TYPES.map((t) => `
      <button type="button" class="tech-opt${techType === t ? ' sel' : ''}" data-t="${t}">
        <b>${esc(techniqueLabel(t))}</b><small>${esc(techniqueHint(t))}</small>
        ${sug === t ? '<em>what you usually do here</em>' : ''}
      </button>`).join('');
    const markedCount = Object.keys(marks).length;
    if (pickMode) {
      scope.innerHTML = `
        <p class="hint" style="padding:6px 0 2px">Pick the sets that get <b>${esc(techniqueLabel(techType))}</b>:</p>
        <div class="set-pick">
          ${Array.from({ length: nSets }, (_, i) => `
            <button type="button" class="set-chip${sel.has(i) ? ' on' : ''}" data-pick="${i}">
              ${i + 1}${marks[i] ? '<em>•</em>' : ''}
            </button>`).join('')}
        </div>
        <div class="tech-acts">
          <button class="btn primary" data-s="picked"${sel.size ? '' : ' disabled'}>Save${sel.size ? ` on ${sel.size}` : ''}</button>
          <button class="btn ghost" data-s="cancel-pick">Back</button>
        </div>`;
      return;
    }
    scope.innerHTML = `
      <p class="hint" style="padding:6px 0 2px">Apply <b>${esc(techniqueLabel(techType))}</b> to:</p>
      <div class="tech-acts">
        ${si == null ? '' : `<button class="btn ghost" data-s="one">set ${si + 1} only</button>`}
        <button class="btn ghost" data-s="pick">pick sets…</button>
        <button class="btn ghost" data-s="all">all ${nSets} sets</button>
        ${shortSets.length ? `<button class="btn ghost" data-s="short">the ${shortSets.length} ${shortSets.length === 1 ? 'set' : 'sets'} of 5 reps or less</button>` : ''}
        ${markedCount ? `<button class="btn ghost danger-link" data-s="none">clear all (${markedCount})</button>` : ''}
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
    toast(n ? `${techniqueLabel(techType)} on ${n} ${n === 1 ? 'set' : 'sets'}` : 'Techniques cleared');
  });
}

const MINOR_WORDS = new Set(['de', 'da', 'do', 'com', 'e', 'no', 'na', 'em', 'ou', 'of', 'with', 'and', 'on', 'or']);
const cleanName = (s) => s.trim().replace(/\s+/g, ' ').slice(0, 60).split(' ')
  .map((w, i) => (i > 0 && MINOR_WORDS.has(w.toLowerCase()) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1)))
  .join(' ');
const fold = (s) => String(s).normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

// search hits the English label and the name underneath, so "bench" and "supino" both work
const findable = (name) => fold(`${exName(name)} ${name}`);

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
  const scopeName = isDaily ? 'every workout' : SLOT_LABEL[draft.slot];
  const both = !isDaily && !e0.only;

  const rowOf = (c) => ({ id: c.id, name: c.name, histId: c.id, samples: c.samples, last: c.last });
  const wantMoves = movesOf(e0.name);

  const own = [e0, ...(e0.variants || [])].map((v) => ({
    id: v.exerciseId, name: v.name, histId: v.noHistory ? null : v.exerciseId, samples: v.histSamples,
    tag: v === e0 ? 'program default' : (v.custom ? 'picked for today' : 'alternative'),
  }));

  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay picker';
  overlay.innerHTML = `
    <div class="confirm-box" role="dialog" aria-label="Swap exercise">
      <p class="pk-title">Swap <b>${esc(exName(cur.name))}</b></p>
      <div class="field">
        <input type="search" class="pk-q" placeholder="search the history or type a new name"
          autocomplete="off" autocorrect="off" style="text-align:left; padding-right:11px">
      </div>
      <div class="pk-list"></div>
      <div class="pk-chosen" hidden></div>
      <div class="pk-mode" hidden>
        <label class="pk-opt"><input type="radio" name="pk-mode" value="today" checked>
          <span><b>This workout only</b><small>the program stays the same</small></span></label>
        <label class="pk-opt"><input type="radio" name="pk-mode" value="forever">
          <span><b>For good</b><small>changes the program from now on</small></span></label>
        <div class="pk-scope" hidden>
          ${both ? `
            <label class="pk-opt"><input type="radio" name="pk-scope" value="" checked><span>${esc(scopeName)} A and B</span></label>
            <label class="pk-opt"><input type="radio" name="pk-scope" value="${esc(draft.variant)}"><span>${esc(scopeName)} ${esc(draft.variant)} only</span></label>`
          : `<p class="hint" style="padding:4px 0">Applies to ${esc(isDaily ? 'every workout' : `${scopeName} ${e0.only}`)}.</p>`}
        </div>
      </div>
      <p class="hint pk-summary" style="padding-bottom:0"></p>
      <div class="btn-row">
        <button class="btn ghost" data-a="no">Cancel</button>
        <button class="btn primary" data-a="yes" disabled>Apply</button>
      </div>
      <button class="link-btn danger-link" data-a="remove">Remove ${esc(exName(e0.name))} from the program…</button>
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
    r.samples ? `${r.samples} sets` : (r.isNew ? null : 'no history'),
    r.last ? `last ${fmtDate(r.last)}` : null,
    inDay.has(r.id) && r.id !== cur.exerciseId ? "already in today's workout" : null,
  ].filter(Boolean).join(' · ');
  const itemHTML = (r, i) => `<button type="button" class="pk-item${r.isNew ? ' new' : ''}${chosen?.id === r.id ? ' sel' : ''}" data-i="${i}">
    ${r.isNew ? '＋ ' : ''}${esc(r.isNew ? r.name : exName(r.name))}<small>${esc(info(r))}</small></button>`;
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
      list.innerHTML = sec('This card', 0, n1) + sec('Same movement', n1, n2)
        + sec(`All ${SLOT_LABEL[draft.slot] ?? 'today'}`, n2, rows.length);
      return;
    }
    const ident = identifyName(text, catalog);
    if (ident.valid && ident.existing) add({ ...rowOf(ident.existing), tag: 'same exercise as the typed name' });
    [...own, ...catalog.map(rowOf)]
      .filter((r) => words.every((w) => findable(r.name).includes(w)))
      .slice(0, 15).forEach(add);
    if (ident.valid && !ident.existing && !seen.has(ident.id)) {
      add({ id: ident.id, name: cleanName(text), histId: null, isNew: true, similar: ident.similar, tag: 'create new exercise' });
    }
    list.innerHTML = rows.length ? sec(null, 0, rows.length)
      : '<p class="hint">That doesn\'t look like an exercise name. Type the full name (e.g. "Seated Cable Row").</p>';
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
    if (same) summary.textContent = forever ? "That's already the program's exercise." : "That's already this card's exercise.";
    else if (clash) summary.textContent = "Pick another one, this one is already on another card today.";
    else if (forever) {
      const where = isDaily ? 'every workout' : (both ? `${scopeName} ${scopeVariant() || 'A and B'}` : `${scopeName} ${e0.only}`);
      summary.innerHTML = `From now on <b>${esc(where)}</b> gets <b>${esc(exName(chosen.name))}</b> instead of
        <b>${esc(exName(e0.name))}</b>. The history doesn't change, and it can be undone.`;
    } else {
      summary.innerHTML = `Today only: <b>${esc(exName(chosen.name))}</b> instead of <b>${esc(exName(cur.name))}</b>.`;
    }
  }

  function renderChosen() {
    chosenEl.hidden = !chosen;
    modeEl.hidden = !chosen;
    if (!chosen) { yes.disabled = true; summary.textContent = ''; return; }
    let html = chosen.isNew
      ? `<b>${esc(chosen.name)}</b>: new exercise. It starts with no history; loads show up after the first finished workout.`
      : `<b>${esc(exName(chosen.name))}</b>: ${chosen.samples
        ? `uses your history (${chosen.samples} sets${chosen.last ? `, last ${fmtDate(chosen.last)}` : ''})`
        : 'no history yet'}.`;
    if (chosen.isNew && chosen.similar?.length) {
      html += `<div class="warn">Looks like one you already have. If it's the same, tap it, or the history ends up split in two:</div>`
        + chosen.similar.map((c, k) => `<button type="button" class="pk-item" data-sim="${k}" style="margin-top:6px; width:100%">
          ${esc(exName(c.name))}<small>${c.samples} sets</small></button>`).join('');
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
  const slotName = SLOT_LABEL[draft.slot] ?? 'today';

  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay picker';
  overlay.innerHTML = `
    <div class="confirm-box" role="dialog" aria-label="Add exercise">
      <p class="pk-title">Add an exercise to the workout</p>
      <div class="field">
        <input type="search" class="pk-q" placeholder="search the history or type a new name"
          autocomplete="off" autocorrect="off" style="text-align:left; padding-right:11px">
      </div>
      <div class="pk-list"></div>
      <div class="pk-chosen" hidden></div>
      <div class="pk-mode" hidden>
        <label class="pk-opt"><input type="radio" name="add-mode" value="today" checked>
          <span><b>This workout only</b><small>just today, the program stays the same</small></span></label>
        <label class="pk-opt"><input type="radio" name="add-mode" value="forever">
          <span><b>For good</b><small>joins the program and comes back next time</small></span></label>
        <div class="pk-scope" hidden>
          <label class="pk-opt"><input type="radio" name="add-scope" value="" checked><span>${esc(slotName)} A and B</span></label>
          <label class="pk-opt"><input type="radio" name="add-scope" value="${esc(draft.variant)}"><span>${esc(slotName)} ${esc(draft.variant)} only</span></label>
        </div>
      </div>
      <p class="hint pk-summary" style="padding-bottom:0"></p>
      <div class="btn-row">
        <button class="btn ghost" data-a="no">Cancel</button>
        <button class="btn primary" data-a="yes" disabled>Add</button>
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
    r.samples ? `${r.samples} sets` : (r.isNew ? null : 'no history'),
    r.last ? `last ${fmtDate(r.last)}` : null,
    inDay.has(r.id) ? "already in today's workout" : null,
  ].filter(Boolean).join(' · ');
  const itemHTML = (r, i) => `<button type="button" class="pk-item${r.isNew ? ' new' : ''}${chosen?.id === r.id ? ' sel' : ''}" data-i="${i}">
    ${r.isNew ? '＋ ' : ''}${esc(r.isNew ? r.name : exName(r.name))}<small>${esc(info(r))}</small></button>`;

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
      list.innerHTML = (n1 ? `<div class="pk-sec">${esc(slotName)}</div>${rows.slice(0, n1).map((r, k) => itemHTML(r, k)).join('')}` : '')
        + (rows.length > n1 ? `<div class="pk-sec">Whole history</div>${rows.slice(n1).map((r, k) => itemHTML(r, n1 + k)).join('')}` : '');
      return;
    }
    const ident = identifyName(text, catalog);
    if (ident.valid && ident.existing) add({ ...rowOf(ident.existing), tag: 'same exercise as the typed name' });
    catalog.map(rowOf).filter((r) => words.every((w) => findable(r.name).includes(w))).slice(0, 15).forEach(add);
    if (ident.valid && !ident.existing && !seen.has(ident.id)) {
      add({ id: ident.id, name: cleanName(text), histId: null, isNew: true, similar: ident.similar, tag: 'create new exercise' });
    }
    list.innerHTML = rows.length ? rows.map(itemHTML).join('')
      : '<p class="hint">That doesn\'t look like an exercise name. Type the full name (e.g. "T-Bar Row").</p>';
  }

  const mode = () => $('input[name="add-mode"]:checked', overlay).value;
  const scopeVariant = () => $('input[name="add-scope"]:checked', overlay)?.value || null;

  function updateSummary() {
    if (!chosen) return;
    const forever = mode() === 'forever';
    scopeEl.hidden = !forever;
    const clash = inDay.has(chosen.id);
    yes.disabled = clash;
    if (clash) { summary.textContent = "That exercise is already in today's workout."; return; }
    if (forever) {
      summary.innerHTML = `<b>${esc(exName(chosen.name))}</b> joins the <b>${esc(slotName)} ${esc(scopeVariant() || 'A and B')}</b>
        program and shows up in every workout after this one. It can be undone in Settings.`;
    } else {
      summary.innerHTML = `Today only: <b>${esc(exName(chosen.name))}</b> goes at the end of the workout.`;
    }
  }

  function renderChosen() {
    chosenEl.hidden = !chosen;
    modeEl.hidden = !chosen;
    if (!chosen) { yes.disabled = true; summary.textContent = ''; return; }
    let html = chosen.isNew
      ? `<b>${esc(chosen.name)}</b>: new exercise. It starts with no history; loads show up after the first finished workout.`
      : `<b>${esc(exName(chosen.name))}</b>: ${chosen.samples ? `uses your history (${chosen.samples} sets)` : 'no history yet'}.`;
    if (chosen.isNew && chosen.similar?.length) {
      html += '<div class="warn">Looks like one you already have. If it\'s the same, tap it, or the history ends up split in two:</div>'
        + chosen.similar.map((c, k) => `<button type="button" class="pk-item" data-sim="${k}" style="margin-top:6px; width:100%">
          ${esc(exName(c.name))}<small>${c.samples} sets</small></button>`).join('');
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
  undoable(`${exName(chosen.name)} added for today`, () => { restoreDraft(snap); renderToday(); });
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
  if (!res.ok) { toast('Could not save: ' + res.error, true); return; }
  state = db.load();
  rebuildDraft();
  persistDraft();
  undoable(`Program: ${exName(chosen.name)} added`, () => {
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
  const slotName = SLOT_LABEL[draft.slot] ?? 'today';
  const filledCount = (draft.logs[a.exerciseId]?.sets || []).filter((x) => x?.reps).length;

  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay picker';
  overlay.innerHTML = `
    <div class="confirm-box" role="dialog" aria-label="Remove exercise">
      <p class="pk-title">Remove ${esc(exName(a.name))}</p>
      ${filledCount ? `<p class="hint warn-box">${filledCount} ${filledCount === 1 ? 'set filled in today will be dropped' : 'sets filled in today will be dropped'}. Finished workouts don't change.</p>` : ''}
      ${isExtra
        ? '<p class="hint">This one was added for today only, so it only leaves today.</p>'
        : `<div class="pk-mode">
            <label class="pk-opt"><input type="radio" name="rm-mode" value="today" checked>
              <span><b>This workout only</b><small>out today, back next time</small></span></label>
            <label class="pk-opt"><input type="radio" name="rm-mode" value="forever">
              <span><b>For good</b><small>leaves the program for good</small></span></label>
            <div class="pk-scope" hidden>
              <label class="pk-opt"><input type="radio" name="rm-scope" value="" checked>
                <span>${daily ? 'every workout' : `${esc(slotName)} A and B`}</span></label>
              <label class="pk-opt"><input type="radio" name="rm-scope" value="${esc(draft.variant)}">
                <span>${daily ? `${esc(draft.variant)} workouts only` : `${esc(slotName)} ${esc(draft.variant)} only`}</span></label>
            </div>
          </div>`}
      <p class="hint pk-summary" style="padding-bottom:0"></p>
      <div class="btn-row">
        <button class="btn ghost" data-a="no">Cancel</button>
        <button class="btn danger-solid" data-a="yes">Remove</button>
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
      ? `<b>${esc(exName(a.name))}</b> leaves the <b>${daily ? 'every-workout routine' : `${esc(slotName)} ${esc(scopeVariant() || 'A and B')}`}</b> program. It can be brought back in Settings → Program changes.`
      : `Today only: <b>${esc(exName(a.name))}</b> leaves this workout and comes back next time.`;
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
  undoable(`${exName(a.name)} out of today's workout`, () => { restoreDraft(snap); renderToday(); });
}

function removeExtraToday(e0, a) {
  const snap = draftSnapshot();
  draft.extras = (draft.extras || []).filter((x) => exactId(x.name) !== a.exerciseId && x.histId !== a.exerciseId);
  dropLogs(a.exerciseId);
  rebuildDraft();
  persistDraft();
  renderToday();
  undoable(`${exName(a.name)} out of today's workout`, () => { restoreDraft(snap); renderToday(); });
}

function removeForever(e0, a, variant, daily) {
  const snap = draftSnapshot();
  const edit = newEdit({
    action: 'remove', target: e0.key, targetName: e0.defaultName ?? a.name,
    slot: daily ? 'daily' : draft.slot, variant: variant || null,
  });
  const res = db.addProgramEdit(edit);
  if (!res.ok) { toast('Could not save: ' + res.error, true); return; }
  state = db.load();
  dropLogs(a.exerciseId);
  rebuildDraft();
  persistDraft();
  renderToday();
  undoable(`Program: ${exName(a.name)} removed`, () => {
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
  undoable(`${exName(chosen.name)} for today only`, () => { restoreDraft(snap); renderToday(); reopenCard(def); });
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
  if (!res.ok) { toast('Could not save: ' + res.error, true); return; }
  state = db.load();
  delete draft.swaps?.[e0.exerciseId];
  delete draft.custom?.[e0.key];
  rebuildDraft();
  persistDraft();
  undoable(`Program: ${exName(chosen.name)} instead of ${exName(e0.name)}`, () => {
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
  const where = isDaily ? 'every workout' : `${SLOT_LABEL[draft.slot]} ${e0.only || 'A and B'}`;
  const ok = await confirmDialog(
    `Remove ${exName(e0.name)} from ${where} from now on? Its history stays, and it can be undone in Settings.`,
    { danger: true });
  if (!ok) return;
  const snap = draftSnapshot();
  const edit = newEdit({
    action: 'remove', target: e0.key, targetName: e0.name,
    slot: isDaily ? 'daily' : draft.slot, variant: null, name: null, histId: null,
  });
  const res = db.addProgramEdit(edit);
  if (!res.ok) { toast('Could not save: ' + res.error, true); return; }
  state = db.load();
  rebuildDraft();
  persistDraft();
  undoable(`${exName(e0.name)} removed from the program`, () => {
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

function updateProgressCount() {
  const done = draft.exercises
    .filter((e) => draft.logs[activeEx(e).exerciseId]?.sets?.some((s) => s?.reps)).length;
  const el = $('#ex-count');
  if (el) el.textContent = `${done}/${draft.exercises.length} exercises logged`;
  const bar = $('#ex-bar');
  if (bar) bar.style.width = `${pctDone(done, draft.exercises.length)}%`;
}

const pctDone = (n, total) => (total ? Math.round((n / total) * 100) : 0);

// "4×5 4×5 · 75%" used to show up here (label + summary repeat the scheme)
function mainPlanTxt(plan) {
  const pct = plan.work[0]?.pct;
  return pct ? `${plan.label} · ${Math.round(pct * 100)}%` : plan.label;
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
      // slotKey: which program slot it was done in, so "Reopen" knows which card
      // gets a one-off swap back
      exercises.push({ id: ex.exerciseId, name: ex.name, group: ex.group, sets, slotKey: e0.key });
    }
  }

  if (exercises.length === 0) { toast('No sets logged yet.', true); return; }

  const session = {
    date: draft.date || todayISO(),
    variant: draft.variant,
    slot: draft.slot,
    logged: true,
    exercises,
  };

  const res = db.logWorkout(session);
  if (!res.ok) { toast('Could not save: ' + res.error, true); return; }

  db.clearDraft();
  state = db.load();
  draft = null;
  const n = exercises.length;
  undoable(`Workout saved · ${n} ${n === 1 ? 'exercise' : 'exercises'}`, () => {
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

  undoable('Postponed to the next workout in the cycle', () => {
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
  if (!text.trim()) { toast('Paste the text first.', true); return; }

  const result = parseHistory(text);
  pendingImport = result;
  renderImportPreview(result);
});

function renderImportPreview({ sessions, warnings, stats }) {
  const root = $('#import-preview');

  if (sessions.length === 0) {
    root.innerHTML = `<div class="preview"><h3>Nothing recognized</h3>
      <p class="hint">Check that dates look like <b>13/08</b> (day/month) and sets like <b>30kg 10</b>.</p></div>`;
    return;
  }

  const index = indexByExercise(sessions);
  const chips = [...index.values()]
    .map((e) => `<span class="ex-chip" data-group="${esc(e.group)}">${esc(exName(e.name))}</span>`).join('');

  root.innerHTML = `
    <div class="preview">
      <h3>Found</h3>
      <div class="stat-grid">
        <div class="stat"><div class="v">${stats.sessions}</div><div class="k">days</div></div>
        <div class="stat"><div class="v">${stats.exercises}</div><div class="k">exercises</div></div>
        <div class="stat"><div class="v">${stats.sets}</div><div class="k">sets</div></div>
        <div class="stat"><div class="v">${warnings.length}</div><div class="k">warnings</div></div>
      </div>
      <p class="hint" style="padding-top:0">
        From <b>${fmtDate(stats.firstDate) || '?'}</b> to <b>${fmtDate(stats.lastDate) || '?'}</b>
      </p>
      <div class="ex-chip-list">${chips}</div>
      ${warnings.length ? `
        <h3 style="margin-top:16px">Warnings</h3>
        <ul class="warn-list">
          ${warnings.slice(0, 20).map((w) => `<li><b>line ${w.line}</b> · ${esc(w.reason)}<br>${esc(w.text)}</li>`).join('')}
        </ul>` : ''}
    </div>
    <div class="btn-row">
      <button class="btn primary" id="btn-merge">Add to history</button>
      <button class="btn ghost" id="btn-replace">Replace everything</button>
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
      `This deletes the ${n} days already saved and keeps only this text. Continue?`,
      { danger: true }
    );
    if (!ok) return;
  }

  const res = mode === 'replace'
    ? db.replaceSessions(pendingImport.sessions)
    : db.mergeSessions(pendingImport.sessions);

  if (!res.ok) { toast('Could not save: ' + res.error, true); return; }

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
    ? `History replaced · ${state.sessions.length} days`
    : `${res.added} new days, ${res.replaced} updated`);

  show('today');
}

function renderDash() {
  const root = $('#dash-content');
  const history = state.sessions || [];

  if (history.length === 0) {
    root.innerHTML = `<div class="empty"><div class="big">${icon('trend', 'i big-i')}</div>
      <p>No data yet.<br>Import your history to see progress.</p></div>`;
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
      <div class="stat"><div class="v">${dated.length}</div><div class="k">days</div></div>
      <div class="stat"><div class="v">${index.size}</div><div class="k">exercises</div></div>
      <div class="stat"><div class="v">${totalSets}</div><div class="k">sets</div></div>
      <div class="stat"><div class="v">${(volume / 1000).toFixed(0)}t</div><div class="k">volume</div></div>
    </div>

    <div class="legend">
      <p><b>Bars</b> = actual load of your best set in each workout, reps right
      below (e.g. <b>90kg</b> / <b>7r</b>).</p>
      <p><b>1RM 49.5 → 54.5kg</b> = estimated one-rep max, comparing the
      <b>first half</b> of your history on that exercise with the
      <b>second half</b>.</p>
      <p><b>+4%</b> = how much that estimate grew between the two halves.
      Positive is progress, close to zero is a plateau.</p>
    </div>

    ${section('Improving', gaining, 'No exercise with a clear gain yet.')}
    ${section('Stalled, look here', stalled, 'Nothing stalled. Good sign.')}
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
            <div class="nm">${esc(exName(r.name))}<small>${r.samples} sets · last ${fmtDate(r.lastDate)}</small></div>
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
    role="img" aria-label="Load lifted per workout, in kg">${rects}</svg>`;

  return opts.scroll ? `<div class="chart-scroll">${svg}</div>` : svg;
}

const fmtKg = (v) => (Number.isInteger(v) ? v : Math.round(v * 10) / 10);

const dayLabel = fmtDay;

let histTab = 'sessions';
let histShown = 6;

// Workouts = last workouts, editable. Exercises = load over time per exercise.
// Editing a logged day never moves the cycle, only a NEW finished workout does.
function renderHistory() {
  const root = $('#hist-content');
  const history = state.sessions || [];

  if (history.length === 0) {
    root.innerHTML = `<div class="empty"><div class="big">${icon('clock', 'i big-i')}</div>
      <p>No data yet.<br>Import your history to see it here.</p></div>`;
    $('#hist-count').textContent = '';
    return;
  }

  root.innerHTML = `
    <div class="seg" id="hist-seg">
      <button type="button" data-h="sessions"  class="${histTab === 'sessions' ? 'on' : ''}">Workouts</button>
      <button type="button" data-h="exercises" class="${histTab === 'exercises' ? 'on' : ''}">Exercises</button>
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
  $('#hist-count').textContent = `${pastDays.length} workouts`;

  $('#hist-body').innerHTML = `
    <div class="legend">
      <p>Whole workouts, newest first, in the same format as the summary you get
      when finishing. Spotted a wrong number? <b>Fix this workout</b> opens that
      day's loads and reps.</p>
    </div>
    ${visible.map(sessionCard).join('')}
    ${remaining > 0 ? `<button class="btn ghost" id="hist-more">Show 6 more (${remaining} left)</button>` : ''}
    ${histShown > 6 ? `<button class="btn ghost" id="hist-less">Back to the last 6</button>` : ''}`;

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
      <div class="focus">${isToday ? '✓ Today · ' : ''}${esc(fmtDate(session.date))}${slot ? ` · ${esc(slot + variantTxt)}` : ''}</div>
      <div class="range">
        ${session.exercises.length} ${session.exercises.length === 1 ? 'exercise' : 'exercises'} ·
        ${nSets} ${nSets === 1 ? 'set' : 'sets'} ·
        ${Math.round(vol).toLocaleString('en-US')} kg volume
      </div>
      <div class="done-list">${sessionRowsHTML(session)}</div>
      <button class="btn ghost edit-sess" data-date="${esc(session.date)}" style="margin-top:12px">
        Fix this workout
      </button>
    </div>`;
}

// works on a copy, nothing is written before "Save fix"; undo puts the
// whole previous version back
function openSessionEditor(date) {
  const orig = (state.sessions || []).find((s) => s.date === date);
  if (!orig) { toast('Workout not found.', true); return; }

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
    <div class="confirm-box" role="dialog" aria-label="Fix workout">
      <p class="pk-title">Fix the ${esc(fmtDate(date))} workout</p>
      <p class="hint" style="padding-top:0">
        Change loads and reps right in the fields. <b>swap</b>, next to the
        name, moves the sets to the right exercise when they were logged under
        the wrong one. Sets with blank reps are dropped on save; a blank load
        counts as bodyweight.
      </p>
      <div class="sess-edit"></div>
      <div class="sess-add"></div>
      <p class="hint sess-sum" style="padding-bottom:4px"></p>
      <div class="btn-row">
        <button class="btn ghost" data-a="no">Cancel</button>
        <button class="btn primary" data-a="yes">Save fix</button>
      </div>
      <button class="link-btn danger-link" data-a="del" type="button">Delete this workout from the history</button>
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
          <span class="nm">${esc(exName(e.name))}
            ${misfiled ? `<small class="se-warn">the sets are filed under <b>${esc(exName(misfiled))}</b>, use "swap" to fix it</small>` : ''}
          </span>
          <button type="button" class="link-btn se-swap" data-swap-ex="${ei}">swap</button>
          <button type="button" class="se-x" data-rm-ex="${ei}" aria-label="Remove exercise">✕</button>
        </div>
        ${e.sets.map((st, si) => `
          <div class="set-row">
            <span class="idx">${si + 1}</span>
            <div class="field">
              <input type="number" inputmode="decimal" step="0.5" min="0" placeholder="bw"
                data-ei="${ei}" data-si="${si}" data-f="load" value="${st.load ? fmtKg(st.load) : ''}">
              <span class="unit">kg</span>
            </div>
            <div class="field">
              <input type="number" inputmode="numeric" step="1" min="0" placeholder="reps"
                data-ei="${ei}" data-si="${si}" data-f="reps" value="${st.reps ?? ''}">
              <span class="unit">rep</span>
            </div>
            <button type="button" class="icon-btn" data-rm-set="${ei}:${si}" aria-label="Remove set">✕</button>
          </div>`).join('')}
        <button type="button" class="link-btn se-more" data-add-set="${ei}">+ set</button>
      </div>`;
    }).join('')
      : '<p class="hint">No exercises. Saving like this deletes the workout from the history.</p>';

    const nSets = work.exercises.reduce((n, e) => n + e.sets.length, 0);
    sum.textContent = `${work.exercises.length} ${work.exercises.length === 1 ? 'exercise' : 'exercises'} · `
      + `${nSets} ${nSets === 1 ? 'set' : 'sets'}`;
  }

  function drawPicker() {
    if (!picking) {
      addBox.innerHTML = '<button type="button" class="btn ghost" data-pick="add">+ forgotten exercise</button>';
      return;
    }
    const dest = picking.mode === 'swap' ? work.exercises[picking.ei]?.name : null;
    addBox.innerHTML = `
      <p class="hint" style="padding:8px 0 2px">
        ${dest ? `Swap <b>${esc(exName(dest))}</b> for which exercise? The sets stay the same.`
               : 'Which exercise goes into this workout?'}
      </p>
      <div class="field">
        <input type="search" class="se-q" placeholder="search the history or type the right name"
          autocomplete="off" autocorrect="off" style="text-align:left; padding-right:11px">
      </div>
      <div class="pk-list se-list"></div>
      <button type="button" class="link-btn" data-pick="off">cancel</button>`;
    drawPickList();
    const q = $('.se-q', addBox);
    q.addEventListener('input', drawPickList);
    q.focus();
  }

  function drawPickList() {
    const typed = ($('.se-q', addBox)?.value || '').trim();
    const words = fold(typed).split(/\s+/).filter(Boolean);
    addRows = catalog.filter((c) => words.every((w) => findable(c.name).includes(w))).slice(0, 12);

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
        const misfiledNote = !c.isNew && c.id !== exactId(c.name) ? ` · filed under "${exName(c.id.replace(/-/g, ' '))}"` : '';
        const info = c.isNew ? 'new name, starts with no history' : `${c.samples} sets in the history${misfiledNote}`;
        return `<button type="button" class="pk-item${c.isNew ? ' new' : ''}${misfiledNote ? ' odd' : ''}" data-add="${i}">
          ${c.isNew ? '＋ ' : ''}${esc(c.isNew ? c.name : exName(c.name))}<small>${esc(info)}</small>
        </button>`;
      }).join('')
      : '<p class="hint">Nothing by that name in the history. Type the full name to create it.</p>';
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
      const ok = await confirmDialog(`Delete the ${fmtDate(date)} workout from the history?`, { danger: true });
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
      const dropped = cleaned.filter((e) => !e.sets.length).map((e) => exName(e.name));
      if (dropped.length && exercises.length) {
        const names = dropped.join(', ');
        const ok = await confirmDialog(
          `${names} ${dropped.length === 1 ? 'has' : 'have'} no reps filled in and won't be saved. Save anyway?`,
          { danger: true });
        if (!ok) return;
      }

      if (!exercises.length) {
        const ok = await confirmDialog('With no sets left the whole workout leaves the history. Delete it?', { danger: true });
        if (!ok) return;
        overlay.remove();
        deleteDay(date);
        return;
      }

      const res = db.updateSession(date, { ...work, exercises });
      if (!res.ok) { toast('Could not save: ' + res.error, true); return; }
      overlay.remove();
      state = db.load();
      renderHistory();
      toast(`${fmtDate(date)} workout fixed`, false, {
        label: 'Undo',
        fn: () => { db.restoreSession(res.previous); state = db.load(); renderHistory(); toast('Fix undone'); },
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
  if (!res.ok) { toast('Could not delete: ' + res.error, true); return; }
  state = db.load();
  renderHistory();
  toast(`${fmtDate(date)} workout deleted`, false, {
    label: 'Undo',
    fn: () => { db.restoreSession(res.previous); state = db.load(); renderHistory(); toast('Workout restored'); },
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

  $('#hist-count').textContent = `${mainItems.length} exercises`;

  $('#hist-body').innerHTML = `
    <div class="legend">
      <p>Every workout of each exercise, oldest to newest. <b>Drag the chart
      sideways</b> to see the whole history.</p>
      <p><b>rename</b> fixes the name across the history, and if the new name
      already exists, merges the two into one.</p>
    </div>
    <div class="field" style="margin-bottom:14px">
      <input type="search" id="hist-filter" placeholder="filter exercises…"
        autocapitalize="off" style="text-align:left; padding-right:11px">
    </div>
    <div id="hist-list">
      ${mainItems.map(historyBlock).join('')}
      ${loose.length ? `<details class="loose">
        <summary>Stray spellings: ${loose.length} with a single workout</summary>
        <p class="hint" style="padding-top:6px">These showed up once. Almost always it's a
        machine from the list above, spelled differently: <b>rename</b> it to the right
        name and the two merge.</p>
        ${loose.map(historyBlock).join('')}
      </details>` : ''}
    </div>`;

  $('#hist-filter').addEventListener('input', (ev) => {
    const q = fold(ev.target.value.trim());

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
  if (!current) { toast('Exercise not found.', true); return; }

  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay picker';
  overlay.innerHTML = `
    <div class="confirm-box" role="dialog" aria-label="Rename exercise">
      <p class="pk-title">Rename exercise</p>
      <p class="hint" style="padding-top:0">
        <b>${esc(exName(current.name))}</b> · ${current.samples} ${current.samples === 1 ? 'set' : 'sets'} in the history
      </p>
      <div class="field">
        <input type="text" class="rn-q" autocomplete="off" autocorrect="off" spellcheck="false"
          style="text-align:left; padding-right:11px" value="${esc(exName(current.name))}">
      </div>
      <div class="pk-list se-list"></div>
      <p class="hint rn-sum" style="padding-bottom:4px"></p>
      <div class="btn-row">
        <button class="btn ghost" data-a="no">Cancel</button>
        <button class="btn primary" data-a="yes">Rename</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const q = $('.rn-q', overlay);
  const listEl = $('.se-list', overlay);
  const sum = $('.rn-sum', overlay);
  const yes = $('[data-a="yes"]', overlay);
  let rows = [];
  let dest = null;
  let picked = null; // merge target tapped in the list, its label isn't something identifyName can read back

  function draw() {
    const typed = q.value.trim();
    if (picked && typed !== exName(picked.name)) picked = null;
    const words = fold(typed).split(/\s+/).filter(Boolean);
    rows = catalog
      .filter((c) => c.id !== id && words.every((w) => findable(c.name).includes(w)))
      .slice(0, 8);
    listEl.innerHTML = rows.length
      ? `<div class="pk-sec">Merge into an existing one</div>` + rows.map((c, i) =>
          `<button type="button" class="pk-item" data-i="${i}">${esc(exName(c.name))}<small>${c.samples} sets</small></button>`).join('')
      : '';

    // the field opens with the label, untouched means nothing to do
    if (!picked && typed === exName(current.name)) {
      dest = null;
      sum.textContent = 'Type the new name.';
      yes.disabled = true;
      yes.textContent = 'Rename';
      return;
    }
    const ident = picked ? { valid: true, id: picked.id, existing: picked }
      : typed ? identifyName(typed, catalog) : { valid: false };
    if (!ident.valid) {
      dest = null;
      sum.textContent = typed ? "That doesn't look like an exercise name, type the full name." : 'Type the new name.';
      yes.disabled = true;
      yes.textContent = 'Rename';
      return;
    }
    const mergeInto = ident.existing && ident.existing.id !== id ? ident.existing : null;
    dest = { id: ident.id, name: mergeInto ? mergeInto.name : cleanName(typed) };
    yes.disabled = false;
    if (mergeInto) {
      yes.textContent = 'Merge';
      sum.innerHTML = `The ${current.samples} sets of <b>${esc(exName(current.name))}</b> move to
        <b>${esc(exName(mergeInto.name))}</b>, which ends up with ${mergeInto.samples + current.samples} sets.
        The two become one history.`;
    } else if (dest.id === id) {
      yes.textContent = 'Rename';
      sum.innerHTML = `Only the displayed name changes: <b>${esc(dest.name)}</b>. The history stays the same.`;
    } else {
      yes.textContent = 'Rename';
      sum.innerHTML = `<b>${esc(exName(current.name))}</b> becomes <b>${esc(dest.name)}</b>
        in ${current.samples === 1 ? 'its only record' : 'every record'}.`;
    }
  }

  q.addEventListener('input', draw);
  listEl.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-i]');
    if (!b) return;
    picked = rows[+b.dataset.i];
    q.value = exName(picked.name);
    draw();
  });

  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) { overlay.remove(); return; }
    const a = ev.target.closest('[data-a]')?.dataset.a;
    if (a === 'no') { overlay.remove(); return; }
    if (a !== 'yes' || !dest || yes.disabled) return;

    const res = db.renameExercise(id, dest);
    if (!res.ok) { toast('Could not rename: ' + res.error, true); return; }
    overlay.remove();
    state = db.load();
    renderHistory();
    toast(`${exName(dest.name)} · ${res.setCount} sets over ${res.days} ${res.days === 1 ? 'day' : 'days'}`, false, {
      label: 'Undo',
      fn: () => { db.restoreSessions(res.previous); state = db.load(); renderHistory(); toast('Rename undone'); },
    });
  });

  draw();
  q.focus();
  q.select();
}

function historyBlock(item) {
  const misfiledNote = item.id && item.id !== exactId(item.name)
    ? ` · filed under "${esc(exName(item.id.replace(/-/g, ' ')))}"` : '';

  if (item.days.length < 2) {
    const d = item.days[0];
    return `
      <div class="hist-block" data-name="${esc(findable(item.name))}">
        <div class="hist-head">
          <div class="nm">${esc(exName(item.name))}
            <small>${item.sets} ${item.sets === 1 ? 'set' : 'sets'} ·
              ${d ? `${fmtKg(d.load)}kg × ${d.reps} on ${esc(dayLabel(d.date))}` : 'no load logged'}${misfiledNote}</small>
          </div>
          <button type="button" class="link-btn rn" data-id="${esc(item.id)}">rename</button>
        </div>
        <p class="hint" style="padding:2px 0 0">One workout only, the chart shows up from the second one.</p>
      </div>`;
  }

  const first = item.days[0];
  const last = item.days[item.days.length - 1];
  const peak = item.days.reduce((a, b) => (b.load > a.load ? b : a));
  const dir = last.load > first.load ? 'up' : last.load < first.load ? 'down' : 'flat';

  return `
    <div class="hist-block" data-name="${esc(findable(item.name))}">
      <div class="hist-head">
        <div class="nm">${esc(exName(item.name))}
          <small>${item.days.length} workouts · ${item.sets} sets · best ${fmtKg(peak.load)}kg × ${peak.reps}${misfiledNote}</small>
        </div>
        <button type="button" class="link-btn rn" data-id="${esc(item.id)}">rename</button>
      </div>
      ${loadChart(item.days, dir, { scroll: true })}
    </div>`;
}

function syncSection() {
  const s = state.settings || {};
  const configured = !!(s.githubRepo && s.githubToken);

  return `
    <div class="section">
      <h2>Sync between phones</h2>
      <p class="hint" style="padding-top:0">
        Keeps the history in a <b>private</b> GitHub repo. With auto sync on,
        each phone pulls changes when the app opens (and every minute while it's
        open) and pushes whatever you change, the workout in progress included.
        Offline, it waits and pushes when the network is back. Use the same repo
        and token on both phones.
      </p>

      <div class="field" style="margin-bottom:8px">
        <input type="text" id="sync-repo" placeholder="owner/repo-name"
          value="${esc(s.githubRepo ?? '')}" autocapitalize="off" autocorrect="off"
          style="text-align:left; padding-right:11px">
      </div>
      <div class="field" style="margin-bottom:8px">
        <input type="password" id="sync-token" placeholder="GitHub token (fine-grained)"
          value="${esc(s.githubToken ?? '')}" autocapitalize="off" autocorrect="off"
          style="text-align:left; padding-right:11px">
      </div>

      <button class="btn ghost" id="sync-verify">Check connection</button>

      ${configured ? `
        <label class="pk-opt" style="margin-top:10px">
          <input type="checkbox" id="sync-auto"${s.autoSync !== false ? ' checked' : ''}>
          <span><b>Auto sync</b><small>when off, it only syncs with the button below</small></span>
        </label>
        <button class="btn primary" id="sync-now">Sync now</button>
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
  return err instanceof SyncError ? err.message : ('Unexpected error: ' + err.message);
}

function wireSyncButtons() {
  $('#sync-verify')?.addEventListener('click', async () => {
    const { repo, token } = syncConfig();
    const btn = $('#sync-verify');
    btn.disabled = true; btn.textContent = 'Checking…';
    try {
      await syncVerify({ repo, token });
      db.updateSettings({ githubRepo: repo, githubToken: token });
      state = db.load();
      toast('Connected, private repo confirmed');
      renderSettings();
      syncNow({ manual: true });
    } catch (err) {
      toast(syncErrorMessage(err), true);
      btn.disabled = false; btn.textContent = 'Check connection';
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
  if (!navigator.onLine) { setSync('offline'); if (manual) toast('No internet right now', true); return; }

  sync.running = true;
  setSync('busy');
  let changed = false;
  try {
    for (let attempt = 0; ; attempt++) {
      if (await pullAll(cfg)) changed = true;
      if (await pushAll(cfg)) break;  // false = the other phone pushed in between
      sync.etag = {};
      if (attempt >= 2) throw new SyncError('The other phone is pushing at the same time, trying again shortly.', 'conflict');
    }
    sync.lastOk = new Date();
    setSync('ok');
    if (manual) toast('Synced');
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
  if (s.autoSync === false) return 'auto sync off';
  if (sync.status === 'busy') return 'syncing…';
  if (sync.status === 'offline') return 'offline, will push later';
  if (sync.status === 'error') return 'sync error, tap to retry';
  if (sync.pending) return 'changes to push…';
  if (sync.lastOk) return `synced ${String(sync.lastOk.getHours()).padStart(2, '0')}:${String(sync.lastOk.getMinutes()).padStart(2, '0')}`;
  return 'sync on';
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
  const where = (e) => (e.slot === 'daily' ? 'every workout' : `${SLOT_LABEL[e.slot] ?? e.slot} ${e.variant ?? 'A and B'}`);
  const what = (e) => (e.action === 'remove'
    ? `<b>${esc(exName(e.targetName))}</b> removed`
    : e.action === 'add'
    ? `<b>${esc(exName(e.name))}</b> added`
    : `${esc(exName(e.targetName))} → <b>${esc(exName(e.name))}</b>`);
  const row = (e) => `
    <div class="edit-row${e.undone ? ' undone' : ''}">
      <div class="nm">${what(e)}<small>${esc(where(e))} · ${esc(fmtDateTime(e.createdAt))}</small></div>
      <button class="btn ghost sm" data-edit="${esc(e.id)}" data-undo="${e.undone ? '0' : '1'}">${e.undone ? 'Restore' : 'Undo'}</button>
    </div>`;

  return `
    <div class="section">
      <h2>Program changes</h2>
      <p class="hint" style="padding-top:0">
        Permanent swaps made from an exercise card (⇄ Swap). They only change what
        shows up in the workout, the history is never touched. They travel with sync.
      </p>
      ${active.length ? active.map(row).join('') : '<p class="hint">No active changes, the program is the original one.</p>'}
      ${undone.length ? `<details class="edit-old"><summary>Undone (${undone.length})</summary>${undone.map(row).join('')}</details>` : ''}
    </div>`;
}

function restoreSection() {
  const pts = db.listRestorePoints();
  return `
    <div class="section">
      <h2>Restore points</h2>
      <p class="hint" style="padding-top:0">
        Automatic copy taken before importing text, pulling from GitHub, restoring
        a backup or deleting everything. The latest 5 are kept, on this phone only.
      </p>
      ${pts.length ? pts.map((p) => `
        <div class="edit-row">
          <div class="nm">${esc(p.reason)}<small>${esc(fmtDateTime(p.at))} · ${p.days} days</small></div>
          <button class="btn ghost sm" data-restore="${p.i}">Restore</button>
        </div>`).join('') + '<button class="btn ghost" id="btn-clear-points">Delete restore points</button>'
      : '<p class="hint">None yet.</p>'}
    </div>`;
}

function wireEditsAndRestore() {
  $$('[data-edit]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.edit;
    const undo = b.dataset.undo === '1';
    db.setProgramEditUndone(id, undo);
    state = db.load(); draft = null;
    renderSettings();
    toast(undo ? 'Change undone' : 'Change restored', false, {
      label: undo ? 'Redo' : 'Undo',
      fn: () => { db.setProgramEditUndone(id, !undo); state = db.load(); draft = null; renderSettings(); },
    });
  }));

  $$('[data-restore]').forEach((b) => b.addEventListener('click', async () => {
    const ok = await confirmDialog(
      'Roll history, program and cycle back to this point? The current state becomes a restore point first, so you can come back.',
      { danger: true });
    if (!ok) return;
    const res = db.restorePoint(Number(b.dataset.restore));
    if (!res.ok) { toast('Could not restore: ' + res.error, true); return; }
    state = db.load(); draft = null;
    toast(`Restored · ${state.sessions.length} days`);
    renderSettings();
  }));

  $('#btn-clear-points')?.addEventListener('click', async () => {
    const ok = await confirmDialog('Delete every safety copy on this phone? The current history is not affected.', { danger: true });
    if (!ok) return;
    db.clearRestorePoints();
    toast('Restore points deleted');
    renderSettings();
  });
}

function renderSettings() {
  const root = $('#settings-content');
  const next = upcoming(state, 6);

  root.innerHTML = `
    <div class="section">
      <h2>Cycle position</h2>
      <p class="hint" style="padding-top:0">
        The cycle only moves when you finish or postpone a workout, so an extra rest day doesn't skip anything.
      </p>
      ${next.map((u) => `
        <div class="prog-row">
          <div class="nm">${esc(u.title)}</div>
          <div class="val">${u.isNext ? 'next' : ''}</div>
          <div class="delta flat"></div>
        </div>`).join('')}
      <div class="btn-row" style="margin-top:10px">
        <button class="btn ghost" id="cycle-back">← Back one</button>
        <button class="btn ghost" id="cycle-fwd">Forward one →</button>
      </div>
    </div>

    ${editsSection()}

    ${syncSection()}

    ${restoreSection()}

    <div class="section">
      <h2>Manual backup</h2>
      <p class="hint" style="padding-top:0">
        The alternative to sync: saves a file with the whole history. On iPhone it
        goes to the Files app, and if that's on iCloud it shows up on the PC too.
      </p>
      <button class="btn ghost" id="btn-export">Save backup to this phone</button>
      <input type="file" id="file-import" accept="application/json" style="display:none">
      <button class="btn ghost" id="btn-file">Restore from a file</button>
      <button class="btn ghost" id="btn-copy">Copy backup as text</button>
    </div>

    <div class="section">
      <h2>Data</h2>
      <p class="hint" style="padding-top:0">
        ${state.sessions.length} days saved on this phone ·
        updated ${state.updatedAt ? fmtDate(state.updatedAt.slice(0, 10)) : '—'}
      </p>
      <button class="btn danger" id="btn-clear">Delete everything on this phone</button>
    </div>
  `;

  $('#cycle-back').addEventListener('click', () => {
    db.setCyclePosition(Math.max(0, (state.cyclePosition || 0) - 1));
    state = db.load(); draft = null; renderSettings(); toast('Cycle moved back');
  });
  $('#cycle-fwd').addEventListener('click', () => {
    db.setCyclePosition((state.cyclePosition || 0) + 1);
    state = db.load(); draft = null; renderSettings(); toast('Cycle moved forward');
  });

  wireSyncButtons();
  wireEditsAndRestore();

  $('#btn-export').addEventListener('click', saveBackup);

  $('#btn-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(db.exportJSON());
      toast('Backup copied');
    } catch {
      toast('The browser blocked the copy', true);
    }
  });

  $('#btn-file').addEventListener('click', () => $('#file-import').click());
  $('#file-import').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    try {
      db.importJSON(await file.text());
      state = db.load(); draft = null;
      toast(`Restored · ${state.sessions.length} days`);
      renderSettings();
    } catch (err) {
      toast('Invalid file: ' + err.message, true);
    }
  });

  $('#btn-clear').addEventListener('click', async () => {
    const ok = await confirmDialog(
      'Delete the whole history on this phone? A copy stays under "Restore points" just in case (you can delete it there).',
      { danger: true }
    );
    if (!ok) return;
    db.clear();
    state = db.load(); draft = null;
    toast('Everything deleted');
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
  toast('Backup downloaded');
}

$$('[data-icon]').forEach((el) => { el.innerHTML = icon(el.dataset.icon); });
renderToday();
updateSyncChip();
syncNow();

// for poking at state from Safari's web inspector mid-workout
window.PPL = { db, get state() { return state; }, parseHistory, workoutForPosition,
  syncNow: (o) => { state = db.load(); return syncNow(o); } };

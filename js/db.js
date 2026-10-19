// Everything lives under one localStorage key: a year of training is a few hundred
// KB, synchronous access keeps the rest of the app simple, and export/sync is one
// JSON.stringify.
//
// Sync between devices: every data change bumps `rev` (history, program, cycle)
// or `draftRev` (workout in progress); pushedRev/pushedDraftRev is what already
// went up. Merging goes item by item by timestamp, never "whole file wins", and
// a deleted day leaves a tombstone in deletedSessions, otherwise the other phone
// brings it back on the next sync.

import { canonicalId, canonicalName, applyDataFixes } from './curation.js';

const KEY = 'ppl-tracker:v1';

// copies of the state taken before anything that rewrites history in bulk (import,
// sync, restore, clear). Separate key so "delete everything" still has a way back
const RESTORE_KEY = 'ppl-tracker:restore-points';
const MAX_RESTORE_POINTS = 5;

const EMPTY = {
  version: 1,
  createdAt: null,
  updatedAt: null,
  dataAt: null,  // last DATA change (not settings), sync tie-breaker
  sessions: [],
  deletedSessions: {},  // { 'YYYY-MM-DD': deletedAt }
  cyclePosition: 0,  // only moves when a workout gets finished or skipped
  cycleAt: null,

  // saved on every keystroke. Before this, closing Safari mid-workout lost
  // everything typed, since a session only reached `sessions` when finished
  draft: null,
  draftClearedAt: null,  // so the other phone doesn't resurrect a finished draft

  // swaps/removals done in the app. Never deleted, undo just sets `undone`;
  // the newest non-undone edit per slot wins
  programEdits: [],

  // clearing a note writes '' instead of deleting the key (same tombstone problem)
  exerciseNotes: {},

  rev: 0, pushedRev: 0,
  draftRev: 0, pushedDraftRev: 0,

  settings: {
    githubRepo: null,
    githubPath: 'training-history.json',
    githubToken: null,  // never leaves this device
    autoSync: true,
    lastSyncAt: null,
    lastSyncSha: null,  // remote version we last saw, catches conflicts before overwriting
    lastDraftSha: null,
  },
};

const nowISO = () => new Date().toISOString();
let dirtyListener = null;

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(EMPTY);
    const data = JSON.parse(raw);
    const state = { ...structuredClone(EMPTY), ...data, settings: { ...EMPTY.settings, ...(data.settings || {}) } };
    if (!Array.isArray(state.programEdits)) state.programEdits = [];
    if (!state.deletedSessions || typeof state.deletedSessions !== 'object') state.deletedSessions = {};
    if (!state.exerciseNotes || typeof state.exerciseNotes !== 'object') state.exerciseNotes = {};
    canonicalizeSessions(state.sessions);
    applyDataFixes(state.sessions);
    return state;
  } catch (err) {
    console.error('[db] corrupted state, starting empty:', err);
    return structuredClone(EMPTY);
  }
}

// Re-apply the curation aliases on every read. Merges used to run only at import
// time, so an already imported history kept the old split names until a full
// re-import. Idempotent and cheap.
function canonicalizeSessions(sessions) {
  for (const s of sessions || []) {
    for (const e of s.exercises || []) {
      if (!e || !e.id) continue;
      const cid = canonicalId(e.id);
      if (cid !== e.id) e.id = cid;
      const cname = canonicalName(cid, null);
      if (cname && cname !== e.name) e.name = cname;
    }
  }
  return sessions;
}

// dirty: 'h' history/program/cycle, 'd' draft, null for settings and sync bookkeeping
function write(state, dirty = null) {
  state.updatedAt = nowISO();
  if (!state.createdAt) state.createdAt = state.updatedAt;
  if (dirty === 'h') { state.rev = (state.rev || 0) + 1; state.dataAt = state.updatedAt; }
  if (dirty === 'd') state.draftRev = (state.draftRev || 0) + 1;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    if (dirty && dirtyListener) queueMicrotask(() => dirtyListener(dirty));
    return { ok: true };
  } catch (err) {
    // QuotaExceededError, Safari gives localStorage ~5MB
    console.error('[db] save failed:', err);
    return { ok: false, error: err.message };
  }
}

function readPoints() {
  try { return JSON.parse(localStorage.getItem(RESTORE_KEY) || '[]'); } catch { return []; }
}

// out of space -> drop the oldest copies, never block the operation itself
function snapshot(reason, state = read()) {
  if (!state.sessions.length && !state.programEdits.length) return;
  let points = readPoints();
  if (points[0] && points[0].stateUpdatedAt === state.updatedAt) return;
  points.unshift({
    at: nowISO(),
    reason,
    stateUpdatedAt: state.updatedAt,
    days: state.sessions.length,
    data: { sessions: state.sessions, programEdits: state.programEdits,
      cyclePosition: state.cyclePosition, draft: state.draft },
  });
  points = points.slice(0, MAX_RESTORE_POINTS);
  while (points.length) {
    try { localStorage.setItem(RESTORE_KEY, JSON.stringify(points)); return; }
    catch { points.pop(); }
  }
}

function mergeEdits(local, remote) {
  const byId = new Map((local || []).map((e) => [e.id, e]));
  for (const e of remote || []) {
    const cur = byId.get(e.id);
    if (!cur || String(e.updatedAt) > String(cur.updatedAt)) byId.set(e.id, e);
  }
  return [...byId.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

function mergeNotes(local, remote) {
  const out = { ...(local || {}) };
  for (const [id, n] of Object.entries(remote || {})) {
    if (!out[id] || String(n.updatedAt) > String(out[id].updatedAt)) out[id] = n;
  }
  return out;
}

// days that disappear get a tombstone and the rest get stamped now, so going back
// sticks on the other phone too instead of being undone by the next sync
function replaceAllSessions(state, next) {
  const now = nowISO();
  const keep = new Set(next.filter((s) => s.date).map((s) => s.date));
  for (const s of state.sessions) if (s.date && !keep.has(s.date)) state.deletedSessions[s.date] = now;
  for (const s of next) {
    s.updatedAt = now;
    if (s.date) delete state.deletedSessions[s.date];
  }
  state.sessions = next.sort(byDateAsc);
}

function restoreData(state, data) {
  const now = nowISO();
  replaceAllSessions(state, structuredClone(data.sessions || []));

  // edits created after the backup are marked undone, not deleted
  const old = new Map((data.programEdits || []).map((e) => [e.id, e]));
  const merged = new Map(state.programEdits.map((e) => [e.id, { ...e, undone: true, updatedAt: now }]));
  for (const [id, e] of old) merged.set(id, { ...e, updatedAt: now });
  state.programEdits = [...merged.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  if (typeof data.cyclePosition === 'number') { state.cyclePosition = data.cyclePosition; state.cycleAt = now; }
}

function syncView(s) {
  return JSON.stringify({
    sessions: [...(s.sessions || [])].sort(byDateAsc),
    deletedSessions: Object.entries(s.deletedSessions || {}).sort(),
    cyclePosition: s.cyclePosition ?? 0,
    cycleAt: s.cycleAt ?? null,
    programEdits: [...(s.programEdits || [])].sort((a, b) => String(a.id).localeCompare(String(b.id))),
    exerciseNotes: Object.entries(s.exerciseNotes || {}).sort(([a], [b]) => a.localeCompare(b)),
  });
}

function draftView(draft, clearedAt) {
  return JSON.stringify({ draft: draft ?? null, clearedAt: clearedAt ?? null });
}

function mergeDraftInto(state, file) {
  const before = draftView(state.draft, state.draftClearedAt);
  if (String(file.clearedAt || '') > String(state.draftClearedAt || '')) state.draftClearedAt = file.clearedAt;
  const rd = file.draft;
  if (rd && (!state.draft || String(rd.savedAt || '') > String(state.draft.savedAt || ''))) state.draft = rd;
  if (state.draft && String(state.draft.savedAt || '') <= String(state.draftClearedAt || '')) state.draft = null;
  return draftView(state.draft, state.draftClearedAt) !== before;
}

export const db = {
  load: read,
  save: write,
  snapshot,

  onDirty(fn) { dirtyListener = fn; },

  listRestorePoints() {
    return readPoints().map(({ at, reason, days }, i) => ({ i, at, reason, days }));
  },

  restorePoint(i) {
    const p = readPoints()[i];
    if (!p) return { ok: false, error: 'ponto não encontrado' };
    snapshot('antes de restaurar um ponto anterior');
    const state = read();
    restoreData(state, p.data);
    return write(state, 'h');
  },

  clearRestorePoints() {
    localStorage.removeItem(RESTORE_KEY);
  },

  addProgramEdit(edit) {
    const state = read();
    state.programEdits.push(edit);
    return write(state, 'h');
  },

  setExerciseNote(exerciseId, text) {
    const state = read();
    state.exerciseNotes[exerciseId] = { text: String(text || '').trim(), updatedAt: nowISO() };
    return write(state, 'h');
  },

  setProgramEditUndone(id, undone) {
    const state = read();
    const e = state.programEdits.find((x) => x.id === id);
    if (!e) return { ok: false, error: 'alteração não encontrada' };
    e.undone = !!undone;
    e.updatedAt = nowISO();
    return write(state, 'h');
  },

  replaceSessions(sessions) {
    snapshot('antes de substituir o histórico');
    const state = read();
    replaceAllSessions(state, sessions);
    return write(state, 'h');
  },

  mergeSessions(incoming) {
    snapshot('antes de importar texto');
    const state = read();
    const now = nowISO();
    const byDate = new Map(state.sessions.filter((s) => s.date).map((s) => [s.date, s]));
    let added = 0, replaced = 0;

    for (const s of incoming) {
      s.updatedAt = now;
      if (!s.date) { state.sessions.push(s); added++; continue; }
      if (byDate.has(s.date)) replaced++; else added++;
      byDate.set(s.date, s);
      delete state.deletedSessions[s.date];
    }

    const undated = state.sessions.filter((s) => !s.date);
    state.sessions = [...byDate.values(), ...undated].sort(byDateAsc);
    const res = write(state, 'h');
    return { ...res, added, replaced, total: state.sessions.length };
  },

  logWorkout(session) {
    const state = read();
    const now = nowISO();
    session.updatedAt = now;
    delete state.deletedSessions[session.date];
    const i = state.sessions.findIndex((s) => s.date === session.date && s.logged);
    const previous = i >= 0 ? state.sessions[i] : null;
    if (i >= 0) state.sessions[i] = session;
    else state.sessions.push(session);
    state.sessions.sort(byDateAsc);
    state.cyclePosition = (state.cyclePosition || 0) + 1;
    state.cycleAt = now;
    return { ...write(state, 'h'), previous };
  },

  undoLogWorkout(date, previous) {
    const state = read();
    const now = nowISO();
    const i = state.sessions.findIndex((s) => s.date === date && s.logged);
    if (i >= 0) {
      if (previous) state.sessions[i] = { ...previous, updatedAt: now };
      else { state.sessions.splice(i, 1); state.deletedSessions[date] = now; }
    }
    state.cyclePosition = Math.max(0, (state.cyclePosition || 0) - 1);
    state.cycleAt = now;
    return write(state, 'h');
  },

  // fixing an old day must not move the cycle, only finishing a NEW workout does
  updateSession(date, session) {
    const state = read();
    const i = state.sessions.findIndex((s) => s.date === date);
    if (i < 0) return { ok: false, error: 'treino não encontrado' };
    const previous = state.sessions[i];
    state.sessions[i] = { ...previous, ...session, date, updatedAt: nowISO() };
    state.sessions.sort(byDateAsc);
    delete state.deletedSessions[date];
    return { ...write(state, 'h'), previous };
  },

  restoreSession(previous) {
    if (!previous || !previous.date) return { ok: false, error: 'versão anterior ausente' };
    const state = read();
    const i = state.sessions.findIndex((s) => s.date === previous.date);
    if (i >= 0) state.sessions[i] = { ...previous, updatedAt: nowISO() };
    else state.sessions.push({ ...previous, updatedAt: nowISO() });
    state.sessions.sort(byDateAsc);
    delete state.deletedSessions[previous.date];
    return write(state, 'h');
  },

  deleteSession(date) {
    const state = read();
    const i = state.sessions.findIndex((s) => s.date === date);
    if (i < 0) return { ok: false, error: 'treino não encontrado' };
    const previous = state.sessions[i];
    state.sessions.splice(i, 1);
    state.deletedSessions[date] = nowISO();
    return { ...write(state, 'h'), previous };
  },

  // Renaming onto an id that already exists merges the two. That's how two spellings
  // of the same machine become one history without touching curation.js.
  renameExercise(fromId, to) {
    const state = read();
    if (!fromId || !to?.id || !to?.name) return { ok: false, error: 'dados incompletos' };
    if (!state.sessions.some((s) => (s.exercises || []).some((e) => e.id === fromId))) {
      return { ok: false, error: 'exercício não encontrado no histórico' };
    }
    snapshot('antes de renomear um exercício');

    const now = nowISO();
    const previous = structuredClone(state.sessions);
    let days = 0, setCount = 0;

    for (const s of state.sessions) {
      const hits = (s.exercises || []).filter((e) => e && e.id === fromId);
      if (!hits.length) continue;
      days++;
      for (const e of hits) {
        setCount += (e.sets || []).length;
        e.id = to.id;
        e.name = to.name;
      }

      // the day may now have the same exercise twice (renamed + existing): merge into the first
      const merged = [];
      for (const e of s.exercises) {
        const dup = merged.find((m) => m.id === e.id);
        if (dup) { dup.sets = [...(dup.sets || []), ...(e.sets || [])]; continue; }
        merged.push(e);
      }
      s.exercises = merged;
      s.updatedAt = now;
    }

    return { ...write(state, 'h'), days, setCount, previous };
  },

  restoreSessions(previous) {
    if (!Array.isArray(previous)) return { ok: false, error: 'histórico anterior ausente' };
    const state = read();
    state.sessions = structuredClone(previous);
    return write(state, 'h');
  },

  setCyclePosition(pos) {
    const state = read();
    state.cyclePosition = pos;
    state.cycleAt = nowISO();
    return write(state, 'h');
  },

  updateSettings(patch) {
    const state = read();
    state.settings = { ...state.settings, ...patch };
    return write(state);
  },

  exportJSON(opts = {}) {
    const state = read();
    if (!opts.includeSecrets) {
      state.settings = { ...state.settings, githubToken: null };
    }
    return JSON.stringify(state, null, 2);
  },

  importJSON(json) {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    if (!data || !Array.isArray(data.sessions)) throw new Error('Backup inválido: falta o campo "sessions".');
    snapshot('antes de restaurar um arquivo de backup');

    const state = read();
    restoreData(state, data);
    return write(state, 'h');
  },

  clear() {
    snapshot('antes de apagar tudo');
    localStorage.removeItem(KEY);
  },

  saveDraft(draft) {
    const state = read();
    state.draft = draft;
    return write(state, 'd');
  },

  loadDraft() {
    return read().draft;
  },

  clearDraft() {
    const state = read();

    // max() with the draft's own stamp: if the other phone's clock runs ahead, "now"
    // here can be earlier than the draft
    state.draftClearedAt = [nowISO(), String(state.draft?.savedAt || '')].sort().pop();
    state.draft = null;
    return write(state, 'd');
  },

  syncState() {
    const s = read();
    return { dirty: s.rev !== s.pushedRev, draftDirty: s.draftRev !== s.pushedDraftRev,
      lastSyncSha: s.settings.lastSyncSha, lastDraftSha: s.settings.lastDraftSha };
  },

  historyPayload() {
    const s = read();
    return {
      rev: s.rev,
      data: {
        version: s.version,
        sessions: s.sessions,
        deletedSessions: s.deletedSessions,
        cyclePosition: s.cyclePosition,
        cycleAt: s.cycleAt,
        programEdits: s.programEdits,
        exerciseNotes: s.exerciseNotes,
        dataAt: s.dataAt || s.updatedAt,
        updatedAt: s.updatedAt,
      },
    };
  },

  draftPayload() {
    const s = read();
    return { rev: s.draftRev, data: { draft: s.draft, clearedAt: s.draftClearedAt, savedAt: nowISO() } };
  },

  markPushed(kind, sha, rev) {
    const s = read();
    if (kind === 'h') { s.settings.lastSyncSha = sha; s.pushedRev = Math.max(s.pushedRev || 0, rev); }
    else { s.settings.lastDraftSha = sha; s.pushedDraftRev = Math.max(s.pushedDraftRev || 0, rev); }
    s.settings.lastSyncAt = nowISO();
    return write(s);
  },

  markRemoteMissing() {
    const s = read();
    s.settings.lastSyncSha = null;
    if (s.rev === s.pushedRev && (s.sessions.length || s.programEdits.length)) s.rev++;
    return write(s);
  },

  // Per day: newest updatedAt wins, a newer tombstone removes the day. Cycle: newest
  // cycleAt. Program edits: by id. Old data with no stamps on either side falls
  // back to each device's dataAt. Snapshot first if this overwrites anything local.
  mergeRemote(remote, sha, { skipDraft = false } = {}) {
    const pre = read();
    const state = read();
    const localNewer = String(state.dataAt || state.updatedAt || '') > String(remote.dataAt || remote.updatedAt || '');

    const incoming = structuredClone(remote.sessions || []);
    canonicalizeSessions(incoming);
    applyDataFixes(incoming);

    const tomb = { ...state.deletedSessions };
    for (const [d, at] of Object.entries(remote.deletedSessions || {})) {
      if (!tomb[d] || String(at) > String(tomb[d])) tomb[d] = at;
    }

    const byDate = new Map(state.sessions.filter((s) => s.date).map((s) => [s.date, s]));
    let overwritten = 0, removed = 0;
    for (const r of incoming) {
      if (!r.date) continue;
      const l = byDate.get(r.date);
      if (!l) { byDate.set(r.date, r); continue; }
      const ra = String(r.updatedAt || ''), la = String(l.updatedAt || '');
      const takeRemote = ra || la ? ra > la : !localNewer;
      if (takeRemote && JSON.stringify(r) !== JSON.stringify(l)) { byDate.set(r.date, r); overwritten++; }
    }
    for (const [d, at] of Object.entries(tomb)) {
      const s = byDate.get(d);
      if (s && String(s.updatedAt || '') <= String(at)) {
        byDate.delete(d);
        if (pre.sessions.some((x) => x.date === d)) removed++;
      }
    }
    state.deletedSessions = tomb;
    const undated = state.sessions.filter((s) => !s.date);
    state.sessions = [...byDate.values(), ...undated].sort(byDateAsc);

    if (typeof remote.cyclePosition === 'number') {
      const rc = String(remote.cycleAt || ''), lc = String(state.cycleAt || '');
      const takeRemote = rc || lc ? rc > lc : !localNewer;
      if (takeRemote) { state.cyclePosition = remote.cyclePosition; state.cycleAt = remote.cycleAt || null; }
    }

    state.programEdits = mergeEdits(state.programEdits, remote.programEdits);
    state.exerciseNotes = mergeNotes(state.exerciseNotes, remote.exerciseNotes);

    // old app versions kept the draft inside the history file
    let draftChanged = false;
    if (!skipDraft && remote.draft) draftChanged = mergeDraftInto(state, { draft: remote.draft });

    const changed = syncView(pre) !== syncView(state) || draftChanged;
    if (overwritten || removed) snapshot('antes de receber mudanças do outro aparelho', pre);

    if (syncView(state) !== syncView(remote)) { if (state.rev === state.pushedRev) state.rev++; }
    else state.pushedRev = state.rev;
    if (changed) state.dataAt = nowISO();
    state.settings.lastSyncSha = sha;
    state.settings.lastSyncAt = nowISO();
    write(state);
    return { changed, overwritten, removed };
  },

  mergeRemoteDraft(file, sha, { skip = false } = {}) {
    const state = read();
    state.settings.lastDraftSha = sha;
    const changed = !skip && file ? mergeDraftInto(state, file) : false;
    const same = draftView(state.draft, state.draftClearedAt) === draftView(file?.draft, file?.clearedAt);
    if (same) state.pushedDraftRev = state.draftRev;
    else if (state.draftRev === state.pushedDraftRev) state.draftRev++;
    write(state);
    return { changed };
  },
};

function byDateAsc(a, b) {
  return String(a.date || '').localeCompare(String(b.date || ''));
}

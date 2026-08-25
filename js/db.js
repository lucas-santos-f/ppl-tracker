// Persistência local. localStorage é suficiente: um ano de treino ocupa
// poucas centenas de KB, e o acesso síncrono simplifica todo o resto da app.
//
// Tudo vive sob uma única chave para que exportar/sincronizar seja uma
// serialização só.

const KEY = 'ppl-tracker:v1';

const EMPTY = {
  version: 1,
  createdAt: null,
  updatedAt: null,
  sessions: [],     // histórico importado + treinos registrados
  cyclePosition: 0, // índice no ciclo PPL — avança só quando um treino é concluído

  // Treino em andamento, gravado a cada número digitado. Sem isto, fechar o
  // navegador no meio do treino perde tudo que foi preenchido, porque o
  // registro só entraria em `sessions` ao concluir.
  draft: null,      // { date, position, slot, variant, logs: {exId: {sets}} }
  settings: {
    githubRepo: null,   // "usuario/repo"
    githubPath: 'training-history.json',
    githubToken: null,  // fica só neste device
    lastSyncAt: null,
    lastSyncSha: null,  // versão remota conhecida — detecta conflito antes de sobrescrever
  },
};

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(EMPTY);
    const data = JSON.parse(raw);
    return { ...structuredClone(EMPTY), ...data, settings: { ...EMPTY.settings, ...(data.settings || {}) } };
  } catch (err) {
    console.error('[db] estado corrompido, começando vazio:', err);
    return structuredClone(EMPTY);
  }
}

function write(state) {
  state.updatedAt = new Date().toISOString();
  if (!state.createdAt) state.createdAt = state.updatedAt;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return { ok: true };
  } catch (err) {
    // QuotaExceededError: o histórico cresceu além do limite do Safari (~5MB).
    console.error('[db] falha ao salvar:', err);
    return { ok: false, error: err.message };
  }
}

export const db = {
  load: read,
  save: write,

  /** Substitui todo o histórico (import inicial). */
  replaceSessions(sessions) {
    const state = read();
    state.sessions = sessions;
    return write(state);
  },

  /**
   * Anexa sessões ao histórico, deduplicando por data.
   * Sessões com a mesma data substituem as existentes — reimportar um bloco
   * corrigido não duplica o dia.
   */
  mergeSessions(incoming) {
    const state = read();
    const byDate = new Map(state.sessions.filter((s) => s.date).map((s) => [s.date, s]));
    let added = 0, replaced = 0;

    for (const s of incoming) {
      if (!s.date) { state.sessions.push(s); added++; continue; }
      if (byDate.has(s.date)) replaced++; else added++;
      byDate.set(s.date, s);
    }

    const undated = state.sessions.filter((s) => !s.date);
    state.sessions = [...byDate.values(), ...undated].sort(byDateAsc);
    const res = write(state);
    return { ...res, added, replaced, total: state.sessions.length };
  },

  /** Registra um treino concluído e avança o ciclo. */
  logWorkout(session) {
    const state = read();
    const i = state.sessions.findIndex((s) => s.date === session.date && s.logged);
    if (i >= 0) state.sessions[i] = session;
    else state.sessions.push(session);
    state.sessions.sort(byDateAsc);
    state.cyclePosition = (state.cyclePosition || 0) + 1;
    return write(state);
  },

  setCyclePosition(pos) {
    const state = read();
    state.cyclePosition = pos;
    return write(state);
  },

  updateSettings(patch) {
    const state = read();
    state.settings = { ...state.settings, ...patch };
    return write(state);
  },

  /** Backup completo em JSON — usado no backup e no sync. */
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
    const current = read();
    // O token do device atual nunca é sobrescrito por um backup.
    data.settings = { ...(data.settings || {}), githubToken: current.settings.githubToken };
    return write({ ...structuredClone(EMPTY), ...data });
  },

  clear() {
    localStorage.removeItem(KEY);
  },

  /**
   * Grava o treino em andamento. Chamado a cada digitação, então precisa ser
   * barato: é só uma escrita no localStorage, sem tocar no histórico.
   */
  saveDraft(draft) {
    const state = read();
    state.draft = draft;
    return write(state);
  },

  loadDraft() {
    return read().draft;
  },

  clearDraft() {
    const state = read();
    state.draft = null;
    return write(state);
  },

  /**
   * O que viaja no sync: o histórico e também o treino em andamento — quem
   * preenche na academia e envia antes de concluir não pode perder o que
   * digitou só porque não apertou "Concluir".
   * Configurações e token nunca vão.
   */
  syncPayload() {
    const state = read();
    return {
      version: state.version,
      sessions: state.sessions,
      cyclePosition: state.cyclePosition,
      draft: state.draft,
      updatedAt: state.updatedAt,
    };
  },

  /**
   * Aplica dados vindos do GitHub. Sessões fundem por data (igual mergeSessions);
   * a posição do ciclo vem do remoto — puxar do GitHub é "colocar este aparelho
   * a par do que rolou no outro", então o ciclo segue o que já foi feito lá.
   */
  applySync(remote, sha) {
    const state = read();
    const byDate = new Map(state.sessions.filter((s) => s.date).map((s) => [s.date, s]));
    for (const s of remote.sessions || []) {
      if (!s.date) continue;
      byDate.set(s.date, s);
    }
    const undated = state.sessions.filter((s) => !s.date);
    state.sessions = [...byDate.values(), ...undated].sort(byDateAsc);
    if (typeof remote.cyclePosition === 'number') state.cyclePosition = remote.cyclePosition;

    // Traz o treino em andamento do outro aparelho, a menos que este já tenha
    // um mais recente em cima da mesa.
    if (remote.draft && (!state.draft || String(remote.draft.savedAt) > String(state.draft.savedAt))) {
      state.draft = remote.draft;
    }

    state.settings.lastSyncAt = new Date().toISOString();
    state.settings.lastSyncSha = sha;
    return write(state);
  },

  recordSyncSha(sha) {
    const state = read();
    state.settings.lastSyncAt = new Date().toISOString();
    state.settings.lastSyncSha = sha;
    return write(state);
  },
};

function byDateAsc(a, b) {
  return String(a.date || '').localeCompare(String(b.date || ''));
}

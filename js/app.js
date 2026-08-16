// Shell da aplicação: router de abas + renderização das quatro telas.

import { db } from './db.js';
import { parseHistory, indexByExercise } from './parser.js';
import { workoutForPosition, upcoming, inferStartPosition, CYCLE, SLOT_LABEL, VARIANT_LABEL } from './ppl.js';
import { bestOneRM, brzycki, tonnage } from './calc.js';
import { syncVerify, syncPull, syncPush, SyncError } from './sync.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let state = db.load();
let pendingImport = null;   // resultado do parse aguardando confirmação
let draft = null;           // treino em andamento (não salvo)

// ---------------------------------------------------------------- utilidades

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('err', isError);
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2600);
}

const todayISO = () => new Date().toISOString().slice(0, 10);

/**
 * Confirmação dentro da própria página.
 *
 * window.confirm() é bloqueado silenciosamente dentro do sandbox de um
 * Artifact publicado — o clique disparava, o diálogo nunca aparecia, e o botão
 * "Apagar tudo" parecia simplesmente não fazer nada. Este modal roda no DOM da
 * própria página, então funciona em qualquer ambiente (sandbox ou não).
 */
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

// ---------------------------------------------------------------- router

function show(view) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  $$('.tabbar button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)));
  window.scrollTo(0, 0);
  if (view === 'today') renderToday();
  if (view === 'dash') renderDash();
  if (view === 'settings') renderSettings();
}

$$('.tabbar button').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));

// ================================================================ TREINO DE HOJE

function renderToday() {
  const root = $('#today-content');
  $('#today-date').textContent = fmtDate(todayISO());

  if (!state.sessions || state.sessions.length === 0) {
    root.innerHTML = `
      <div class="empty">
        <div class="big">📋</div>
        <p>Nenhum histórico ainda.<br>Importe seus treinos para começar.</p>
        <button class="btn primary" onclick="document.querySelector('[data-view=import]').click()">Importar histórico</button>
      </div>`;
    return;
  }

  const w = draft || workoutForPosition(state);
  if (!draft) draft = { ...w, logs: {} };

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
  const [lo, hi] = w.exercises[0]?.repRange ?? (isForca ? [4, 6] : [10, 15]);
  const done = Object.values(draft.logs).filter((l) => l.sets?.some((s) => s.reps)).length;

  root.innerHTML = `
    <div class="day-card" data-variant="${w.variant}">
      <div class="focus">${isForca ? '🔥' : '💧'} ${esc(w.subtitle)}</div>
      <p class="slot">${esc(w.title)}</p>
      <div class="range">
        Alvo de ${lo}–${hi} reps · ${isForca ? '85' : '70'}% da 1RM estimada
      </div>
      <div class="range" style="margin-top:6px">
        ${done}/${w.exercises.length} exercícios registrados
      </div>
    </div>

    <div id="ex-list">
      ${w.exercises.map((e, i) => exerciseCard(e, i, w.variant)).join('')}
    </div>

    <button class="btn ${isForca ? 'forca' : 'hiper'}" id="finish">Concluir treino</button>
    <button class="btn ghost" id="skip">Pular este treino (adiar)</button>
  `;

  wireExerciseCards();
  $('#finish').addEventListener('click', finishWorkout);
  $('#skip').addEventListener('click', advanceCycle);
}

function exerciseCard(e, i, variant) {
  const log = draft.logs[e.exerciseId] || { sets: [] };
  const isDone = log.sets.some((s) => s.reps);
  const [lo, hi] = e.repRange;

  const targetHTML = e.targetLoad != null
    ? `<div class="kg">${e.targetLoad}<span style="font-size:13px">kg</span></div>`
    : `<div class="kg bw">${e.cardio ? '10 min' : e.noHistory ? 'definir' : 'peso corporal'}</div>`;

  const lastTxt = e.lastSets.length
    ? e.lastSets.map((s) => (s.load ? `${s.load}kg×${s.reps}` : `${s.reps}`)).join(' · ')
    : '—';

  // O alvo foi limitado pelo teto de segurança: a fórmula pedia mais do que
  // qualquer carga já levantada neste exercício.
  const cappedNote = e.capped
    ? `<div class="hint capped">⚠︎ A fórmula pedia <b>${e.uncappedLoad}kg</b>, acima do seu recorde
       de <b>${e.bestLoad}kg</b>. Limitado a +10% do recorde.</div>`
    : '';

  const nSets = Math.max(log.sets.length, 3);
  const rows = Array.from({ length: nSets }, (_, si) => setRow(e, si, log.sets[si], lo, hi)).join('');

  return `
    <div class="ex ${isDone ? 'done' : ''}" data-variant="${variant}" data-id="${esc(e.exerciseId)}">
      <div class="ex-head">
        <div class="check">✓</div>
        <div class="ex-name">
          <div class="part">${esc(e.part ?? '')}</div>
          <div class="n">${esc(e.name)}</div>
          <div class="sub">${
            e.noHistory ? 'exercício novo — sem histórico'
            : e.oneRM ? `1RM est. ${e.oneRM}kg` : 'peso corporal'
          }${e.stale ? ' · desatualizada' : ''}</div>
        </div>
        <div class="target">
          ${targetHTML}
          <div class="reps">${e.cardio ? '' : `${e.capped ? '⚠︎ ' : ''}${lo}–${hi} reps`}</div>
        </div>
      </div>
      <div class="ex-body">
        ${e.note ? `<div class="hint note">${esc(e.note)}</div>` : ''}
        <div class="hint">Última vez: <b>${esc(lastTxt)}</b>${
          e.matchedAs && e.matchedAs !== e.name ? ` · histórico de <b>${esc(e.matchedAs)}</b>` : ''
        }</div>
        ${cappedNote}
        <div class="sets">${rows}</div>
        <button class="icon-btn add-set" style="margin-top:2px">+ série</button>
      </div>
    </div>`;
}

function setRow(e, si, saved, lo, hi) {
  const load = saved?.load ?? '';
  const reps = saved?.reps ?? '';
  const hit = reps === '' ? '' : (Number(reps) >= lo ? 'yes' : 'no');
  const loadPlaceholder = e.targetLoad != null ? e.targetLoad : '—';
  return `
    <div class="set-row" data-set="${si}">
      <div class="idx">${si + 1}</div>
      <div class="field">
        <input type="number" inputmode="decimal" step="0.5" class="in-load"
               value="${load}" placeholder="${loadPlaceholder}" aria-label="carga série ${si + 1}">
        <span class="unit">kg</span>
      </div>
      <div class="field">
        <input type="number" inputmode="numeric" class="in-reps"
               value="${reps}" placeholder="${lo}–${hi}" data-hit="${hit}" aria-label="reps série ${si + 1}">
        <span class="unit">reps</span>
      </div>
      <button class="icon-btn del-set" aria-label="remover série">×</button>
    </div>`;
}

function wireExerciseCards() {
  $$('.ex').forEach((card) => {
    const id = card.dataset.id;

    $('.ex-head', card).addEventListener('click', () => card.classList.toggle('open'));

    card.addEventListener('input', (ev) => {
      const row = ev.target.closest('.set-row');
      if (!row) return;
      const si = Number(row.dataset.set);
      const load = $('.in-load', row).value;
      const repsEl = $('.in-reps', row);
      const reps = repsEl.value;

      const log = draft.logs[id] || (draft.logs[id] = { sets: [] });
      log.sets[si] = { load: load === '' ? null : Number(load), reps: reps === '' ? null : Number(reps) };

      // Feedback imediato: bateu o alvo de reps?
      const ex = draft.exercises.find((e) => e.exerciseId === id);
      const [lo] = ex.repRange;
      repsEl.dataset.hit = reps === '' ? '' : (Number(reps) >= lo ? 'yes' : 'no');

      card.classList.toggle('done', log.sets.some((s) => s?.reps));
      updateProgressCount();
    });

    $('.add-set', card).addEventListener('click', () => {
      const ex = draft.exercises.find((e) => e.exerciseId === id);
      const list = $('.sets', card);
      const si = $$('.set-row', list).length;
      list.insertAdjacentHTML('beforeend', setRow(ex, si, null, ...ex.repRange));
    });

    card.addEventListener('click', (ev) => {
      if (!ev.target.classList.contains('del-set')) return;
      const row = ev.target.closest('.set-row');
      const si = Number(row.dataset.set);
      const log = draft.logs[id];
      if (log) log.sets.splice(si, 1);
      row.remove();
      $$('.set-row', card).forEach((r, i) => { r.dataset.set = i; $('.idx', r).textContent = i + 1; });
      card.classList.toggle('done', !!log?.sets.some((s) => s?.reps));
      updateProgressCount();
    });
  });
}

function updateProgressCount() {
  const done = Object.values(draft.logs).filter((l) => l.sets?.some((s) => s?.reps)).length;
  const el = $$('.day-card .range')[1];
  if (el) el.textContent = `${done}/${draft.exercises.length} exercícios registrados`;
}

function finishWorkout() {
  const exercises = [];
  for (const ex of draft.exercises) {
    const log = draft.logs[ex.exerciseId];
    const sets = (log?.sets || [])
      .filter((s) => s && s.reps)
      .map((s) => ({ load: s.load ?? 0, reps: s.reps, bodyweight: !s.load }));
    if (sets.length) {
      exercises.push({ id: ex.exerciseId, name: ex.name, group: ex.group, sets });
    }
  }

  if (exercises.length === 0) { toast('Nenhuma série registrada.', true); return; }

  const session = {
    date: todayISO(),
    variant: draft.variant,
    slot: draft.slot,
    logged: true,
    exercises,
  };

  const res = db.logWorkout(session);
  if (!res.ok) { toast('Erro ao salvar: ' + res.error, true); return; }

  state = db.load();
  draft = null;
  toast(`Treino salvo · ${exercises.length} ${exercises.length === 1 ? 'exercício' : 'exercícios'}`);
  renderToday();
}

function advanceCycle() {
  db.setCyclePosition((state.cyclePosition || 0) + 1);
  state = db.load();
  draft = null;
  toast('Adiado para o próximo treino do ciclo');
  renderToday();
}

// ================================================================ IMPORTAR

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

  // Na primeira importação, posiciona o ciclo a partir do último treino do histórico.
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

// ================================================================ DASHBOARD

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

  // Ordena por relevância (volume de séries) e não só pela variação, para que
  // o topo da lista seja o que ele mais treina, não o mais ruidoso.
  const gaining = rows.filter((r) => r.pct > 2).sort((a, b) => b.samples - a.samples);
  const stalled = rows.filter((r) => r.pct <= 2).sort((a, b) => b.samples - a.samples);

  // Conta todas as séries do histórico, não só as que entraram na análise de
  // progresso — o card é um resumo do volume treinado, não da amostra usada.
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

    <p class="hint" style="padding-top:0">
      Os números abaixo são <b>1RM estimada</b> (projeção de Brzycki a partir das
      suas séries) — não é a carga que você de fato colocou na barra ou no halter.
    </p>

    ${section('Evoluindo', gaining, 'Nenhum exercício com ganho claro ainda.')}
    ${section('Estagnados — olhar aqui', stalled, 'Nada estagnado. Bom sinal.')}
  `;
}

// Amostra mínima para que a variação percentual signifique alguma coisa.
// Com 4 séries, um dia bom vira "+336%" e o dashboard fica inútil.
const MIN_SETS_FOR_TREND = 10;
const MIN_SETS_PER_HALF = 4;

// Compara a 1RM estimada da primeira metade do histórico com a da segunda.
function buildProgress(ex) {
  const dated = ex.sessions.filter((s) => s.date && s.load > 0 && s.reps <= 12);
  if (dated.length < MIN_SETS_FOR_TREND) return null;

  dated.sort((a, b) => a.date.localeCompare(b.date));
  const mid = Math.floor(dated.length / 2);
  if (mid < MIN_SETS_PER_HALF || dated.length - mid < MIN_SETS_PER_HALF) return null;

  // Sem janela de recência aqui: queremos o pico de cada metade inteira do
  // histórico, não "o que valeria hoje" — senão metades de vários meses ficam
  // reduzidas às últimas 8 semanas de cada uma.
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
    series: dated.map((s) => brzycki(s.load, s.reps)).filter(Boolean),
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
          ${sparkline(r.series, dir)}`;
      }).join('')}
    </div>`;
}

// Sparkline em SVG inline — sem biblioteca de gráficos. O traço sozinho não
// diz quanto é quanto; por isso o mínimo e o máximo em kg ficam escritos ao
// lado dos pontos correspondentes, não só a forma da curva.
function sparkline(values, dir) {
  if (values.length < 2) return '';
  const w = 300, h = 48, pad = 3, padTop = 14, padBottom = 3;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const y = (v) => h - padBottom - ((v - min) / span) * (h - padTop - padBottom);
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (w - pad * 2);
    return `${x.toFixed(1)},${y(v).toFixed(1)}`;
  }).join(' ');

  const iMax = values.indexOf(max), iMin = values.indexOf(min);
  const xOf = (i) => pad + (i / (values.length - 1)) * (w - pad * 2);
  const color = dir === 'up' ? 'var(--ok)' : dir === 'down' ? 'var(--err)' : 'var(--text)';
  const fmt1 = (v) => (Math.round(v * 10) / 10).toString();

  const label = (i, v, anchor) => `
    <text x="${xOf(i).toFixed(1)}" y="${(y(v) - 5).toFixed(1)}" text-anchor="${anchor}"
      font-size="9" font-weight="700" fill="${color}">${fmt1(v)}kg</text>`;

  return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.8"
      stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    <circle cx="${xOf(iMax).toFixed(1)}" cy="${y(max).toFixed(1)}" r="2.2" fill="${color}"/>
    ${iMin !== iMax ? `<circle cx="${xOf(iMin).toFixed(1)}" cy="${y(min).toFixed(1)}" r="2.2" fill="${color}"/>` : ''}
    ${label(iMax, max, iMax < values.length / 2 ? 'start' : 'end')}
    ${iMin !== iMax ? label(iMin, min, iMin < values.length / 2 ? 'start' : 'end') : ''}
  </svg>`;
}

// ================================================================ AJUSTES

function syncSection() {
  const s = state.settings || {};
  const configured = !!(s.githubRepo && s.githubToken);
  const lastSync = s.lastSyncAt ? fmtDateTime(s.lastSyncAt) : 'nunca';

  return `
    <div class="section">
      <h2>Sincronizar entre aparelhos</h2>
      <p class="hint" style="padding-top:0">
        Guarda o histórico num repositório <b>privado</b> do GitHub. Cada
        aparelho lê e escreve o mesmo arquivo — sem servidor, sem hospedar
        nada. Não funciona dentro do link do Artifact (o sandbox bloqueia
        chamadas de rede); use o arquivo salvo no aparelho.
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
        <div class="btn-row" style="margin-top:10px">
          <button class="btn ghost" id="sync-pull">↓ Baixar do GitHub</button>
          <button class="btn primary" id="sync-push">↑ Enviar para o GitHub</button>
        </div>
        <p class="hint">Última sincronização: <b>${esc(lastSync)}</b></p>
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
    } catch (err) {
      toast(syncErrorMessage(err), true);
      btn.disabled = false; btn.textContent = 'Verificar conexão';
    }
  });

  $('#sync-pull')?.addEventListener('click', async () => {
    const btn = $('#sync-pull');
    btn.disabled = true; btn.textContent = '↓ Baixando…';
    try {
      const { repo, token, path } = syncConfig();
      const { data, sha } = await syncPull({ repo, path, token });
      if (!data) { toast('Nada no GitHub ainda — envie primeiro deste ou de outro aparelho.', true); return; }
      const res = db.applySync(data, sha);
      if (!res.ok) throw new Error(res.error);
      state = db.load(); draft = null;
      toast(`Baixado · ${state.sessions.length} dias no total`);
      renderSettings();
    } catch (err) {
      toast(syncErrorMessage(err), true);
    } finally {
      btn.disabled = false; btn.textContent = '↓ Baixar do GitHub';
    }
  });

  $('#sync-push')?.addEventListener('click', async () => {
    const btn = $('#sync-push');
    btn.disabled = true; btn.textContent = '↑ Enviando…';
    try {
      const { repo, token, path } = syncConfig();
      const payload = db.syncPayload();
      const res = await syncPush({ repo, path, token, data: payload, sha: state.settings.lastSyncSha });
      db.recordSyncSha(res.sha);
      state = db.load();
      toast('Enviado para o GitHub');
      renderSettings();
    } catch (err) {
      toast(syncErrorMessage(err), true);
    } finally {
      btn.disabled = false; btn.textContent = '↑ Enviar para o GitHub';
    }
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
          <div class="nm">${esc(u.title)}<small>${esc(u.subtitle)}</small></div>
          <div class="val">${u.isNext ? 'próximo' : ''}</div>
          <div class="delta flat"></div>
        </div>`).join('')}
      <div class="btn-row" style="margin-top:10px">
        <button class="btn ghost" id="cycle-back">← Voltar um</button>
        <button class="btn ghost" id="cycle-fwd">Avançar um →</button>
      </div>
    </div>

    ${syncSection()}

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
      'Apagar todo o histórico deste aparelho? Baixe um backup antes se quiser guardar.',
      { danger: true }
    );
    if (!ok) return;
    db.clear();
    state = db.load(); draft = null;
    toast('Tudo apagado');
    renderSettings();
  });
}

/**
 * Salva o backup como arquivo.
 *
 * Dentro de um Artifact publicado, o download por link é inerte — a página
 * precisa pedir ao visualizador pela capacidade `downloads`, e ele confirma.
 * Fora dali (servidor local, arquivo solto), o link comum funciona.
 */
async function saveBackup() {
  const filename = `ppl-backup-${todayISO()}.json`;
  const data = db.exportJSON();

  const downloads = await (window.claude?.use?.('downloads') ?? Promise.resolve(null));

  if (downloads) {
    try {
      await downloads.save({ filename, data });
      toast('Backup salvo no aparelho');
    } catch (err) {
      const code = err?.code ?? 'unavailable';
      if (code === 'declined') toast('Salvamento cancelado');
      else if (code === 'rate_limited') toast('Aguarde um instante e tente de novo', true);
      else toast('Não foi possível salvar: ' + code, true);
    }
    return;
  }

  // Caminho normal do navegador.
  const blob = new Blob([data], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Backup baixado');
}

// ---------------------------------------------------------------- boot

renderToday();

// Expõe para depuração no console do Safari durante o treino.
window.PPL = { db, get state() { return state; }, parseHistory, workoutForPosition };

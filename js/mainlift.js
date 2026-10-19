// Main lifts (bench, squat, deadlift) are prescribed as % of the estimated 1RM.
// No recent set -> calibration day: work up to a heavy 5 and that 5 becomes
// the new reference. The last set of the heavy day is AMRAP, which is what
// pushes the estimate (and the loads) up over time.

import { estimateOneRM } from './calc.js';

// smallest jump on a barbell is a pair of 1.25kg plates
const roundBar = (kg) => Math.round(kg / 2.5) * 2.5;

const s = (pct, reps, extra = {}) => ({ pct, reps, ...extra });

const SCHEMES = {
  A: {
    label: '3×3 pesado',
    warmup: [s(0.40, 8), s(0.55, 5), s(0.70, 3), s(0.80, 1)],
    work: [s(0.85, 3), s(0.85, 3), s(0.85, 3, { amrap: true, label: 'máx. reps — pare 1 antes de falhar' })],
  },
  B: {
    label: '4×5',
    warmup: [s(0.40, 8), s(0.55, 5), s(0.65, 3)],
    work: [s(0.75, 5), s(0.75, 5), s(0.75, 5), s(0.75, 5)],
  },
  // true 1RM attempt, only for lifts where technique is solid (bench)
  real: {
    label: 'Teste de 1RM',
    warmup: [s(0.40, 5), s(0.60, 3), s(0.75, 2), s(0.85, 1), s(0.92, 1)],
    work: [s(1.00, 1, { label: 'tentativa' }), s(1.03, 1, { label: 'só se a anterior subiu fácil' })],
  },
  estimated: {
    label: 'Teste de 1RM estimado',
    warmup: [s(0.40, 5), s(0.60, 3), s(0.75, 2), s(0.85, 1)],
    work: [s(0.90, 3, { amrap: true, label: 'máx. reps (até 5), sem falhar' })],
  },
};

const CALIBRATION = {
  label: 'Calibração',
  warmup: [
    s(null, 10, { label: 'barra vazia' }),
    s(null, 5, { label: 'carga leve' }),
    s(null, 3, { label: 'carga média' }),
  ],
  work: [
    s(null, 5, { label: '5 pesadas, sobrando ~2 reps' }),
    s(null, 5, { label: 'mesma carga' }),
  ],
};

function materialize(scheme, oneRM) {
  const load = (x) => (x.pct == null || !oneRM ? null : roundBar(oneRM * x.pct));
  const map = (list) => list.map((x) => ({ ...x, load: load(x) }));
  return { label: scheme.label, warmup: map(scheme.warmup), work: map(scheme.work) };
}

/** Today's plan for a main lift. testKind is 'real' or 'estimated'. */
export function mainLiftPlan(found, variant, testKind = 'estimated') {
  const est = found ? estimateOneRM(found.sessions) : null;
  const calibrate = !est || est.stale;
  const oneRM = calibrate ? null : Math.round(est.oneRM * 10) / 10;

  const normal = calibrate
    ? { ...materialize(CALIBRATION, null), mode: 'calibration' }
    : { ...materialize(SCHEMES[variant], oneRM), mode: variant };
  const test = calibrate ? null : { ...materialize(SCHEMES[testKind], oneRM), mode: 'test' };

  return { oneRM, basedOn: est?.basedOn ?? null, calibrate, testKind, normal, test };
}

// "3×3 · 85%"
export function planSummary(plan) {
  const w = plan.work;
  if (!w.length) return '';
  const same = w.every((x) => x.reps === w[0].reps);
  const reps = same ? `${w.length}×${w[0].reps}` : w.map((x) => x.reps).join('/');
  return w[0].pct == null ? reps : `${reps} · ${Math.round(w[0].pct * 100)}%`;
}

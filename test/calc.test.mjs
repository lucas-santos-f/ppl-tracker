import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brzycki, roundLoad, targetLoad, intensityForReps, estimateOneRM, prescribe, INTENSITY } from '../js/calc.js';

const close = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

test('brzycki', () => {
  close(brzycki(100, 5), 112.51);  // 100 / 0.8888
  close(brzycki(70, 10), 93.36);
  assert.equal(brzycki(80, 1), 80);
  assert.equal(brzycki(0, 5), null);
  assert.equal(brzycki(50, 40), null); // denominator goes ~0, formula is meaningless there
});

test('round to 5kg', () => {
  assert.equal(roundLoad(93), 95);
  assert.equal(roundLoad(92.4), 90);
  assert.equal(roundLoad(NaN), null);
});

test('cap at best load + 10%', () => {
  // 200 * 0.8 asks for 160, best ever was 130 -> 143 -> 145 after rounding
  const t = targetLoad(200, INTENSITY.A, 130);
  assert.equal(t.capped, true);
  assert.equal(t.load, 145);
  assert.equal(t.raw, 160);

  assert.equal(targetLoad(50, INTENSITY.A, 45).capped, false);
});

test('8-10 rep range asks for less than the heavy day', () => {
  close(intensityForReps(9), 0.7776, 0.0001);
  assert.ok(intensityForReps(9) < INTENSITY.A);
});

test('long sets ignored for 1RM', () => {
  // 15kg x 20 would project ~31.8kg and beat the honest 15x11
  const sets = [
    { date: '2026-10-01', load: 15, reps: 11 },
    { date: '2026-10-01', load: 15, reps: 20 },
  ];
  const est = estimateOneRM(sets, { referenceDate: '2026-10-05' });
  assert.equal(est.basedOn.reps, 11);
});

test('old sets only when nothing recent', () => {
  const sets = [{ date: '2026-01-10', load: 100, reps: 5 }];
  const est = estimateOneRM(sets, { referenceDate: '2026-10-05' });
  assert.equal(est.stale, true);
  close(est.oneRM, brzycki(100, 5));
});

test('custom rep range lowers the target', () => {
  const ex = { id: 'x', name: 'Extensora', sessions: [{ date: '2026-10-01', load: 100, reps: 8 }] };
  const std = prescribe(ex, 'A', { referenceDate: '2026-10-05' });
  const custom = prescribe(ex, 'A', { referenceDate: '2026-10-05', repRange: [8, 10] });
  assert.ok(custom.targetLoad < std.targetLoad);
  assert.deepEqual(custom.repRange, [8, 10]);
});

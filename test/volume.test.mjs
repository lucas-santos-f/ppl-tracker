import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySets, setVolume } from '../js/sets.js';
import { compareAtEqualSets, fmtPct, fmtVolume } from '../js/volume.js';

test('feeders and back-offs', () => {
  const roles = classifySets([20, 30, 30, 25, 25, 20].map((load) => ({ load, reps: 8 }))).map((s) => s.role);
  assert.deepEqual(roles, ['feeder', 'work', 'work', 'backoff', 'backoff', 'backoff']);
});

test('drop set reps count', () => {
  assert.equal(setVolume({ load: 30, reps: 8, techniques: [{ type: 'drop', load: 20, reps: 10 }] }), 440);
  assert.equal(setVolume({ load: 30, reps: 8, techniques: [{ type: 'drop', reps: 6 }] }), 420);
});

test('extra set is not progress', () => {
  const prev = [{ load: 50, reps: 10 }, { load: 50, reps: 10 }, { load: 50, reps: 10 }, { load: 50, reps: 10 }];
  const now = [...prev, { load: 50, reps: 10 }];
  const c = compareAtEqualSets(now, prev);
  assert.equal(c.usedSets, 4);
  assert.equal(c.pct, 0);
  assert.equal(c.droppedNow, 1);
});

test('bodyweight compares reps', () => {
  const c = compareAtEqualSets([{ load: 0, reps: 12 }, { load: 0, reps: 10 }], [{ load: 0, reps: 10 }, { load: 0, reps: 10 }]);
  assert.equal(c.unit, 'reps');
  assert.equal(c.diff, 2);
});

test('formatting', () => {
  assert.equal(fmtPct(7.6), '+8%');
  assert.equal(fmtPct(-0.2), '=');
  assert.equal(fmtVolume(12400), '12,4t');
  assert.equal(fmtVolume(840), '840kg');
});

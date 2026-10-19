import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHistory, indexByExercise } from '../js/parser.js';
import { normalizeExercise } from '../js/normalize.js';

const one = (text) => parseHistory(text, { defaultYear: 2026 }).sessions[0].exercises[0].sets;

test('recent format', () => {
  const sets = one('10/09\nSupino reto barra\n30kg 10\n30kg  8 Drop 20kg 10\n');
  assert.equal(sets.length, 2);
  assert.deepEqual([sets[0].load, sets[0].reps], [30, 10]);
  assert.deepEqual(sets[1].techniques, [{ type: 'drop', load: 20, reps: 10 }]);
});

test('old format', () => {
  const [a, b, c] = one('10/09\nRemada baixa\n12 reps 80kg primeira serie de trabalho\nTop set 104kg 100% 11 reps\n3 placas 10 com dropset\n');
  assert.deepEqual([a.load, a.reps], [80, 12]);
  assert.equal(b.topSet, true);
  assert.equal(b.effortPct, 100); // % is effort, never load
  assert.equal(c.placas, 3);
});

test('bodyweight, subsets, per side', () => {
  const sets = one('10/09\nBarra fixa aberta e fechada\n14\n7 e 3\nSem peso 10\n');
  assert.equal(sets.length, 4);
  assert.ok(sets.every((s) => s.bodyweight));

  const [s] = one('10/09\nSerrote\n20kg cada lado 17 reps\n');
  assert.equal(s.perSide, true);
});

test('year rolls back at the boundary', () => {
  const { sessions } = parseHistory('20/12\nVoador\n40kg 10\n\n05/01\nVoador\n40kg 11\n\n10/01\nVoador\n40kg 12\n\n15/01\nVoador\n45kg 8\n');
  const years = sessions.map((s) => s.date.slice(0, 4));
  assert.equal(new Set(years).size, 2);
  assert.ok(sessions[0].date < sessions[1].date);
});

test('typo date fixed, not cascaded', () => {
  // 01/12 between end of January and early February is a typo for 01/02,
  // it must not push the rest of the file a year ahead
  const text = ['25/01', '29/01', '01/12', '03/02', '05/02'].map((d) => `${d}\nVoador\n40kg 10\n`).join('\n');
  const { sessions, warnings } = parseHistory(text);
  const dates = sessions.map((s) => s.date);
  assert.deepEqual([...dates].sort(), dates);
  assert.equal(dates[2].slice(5), '02-01');
  assert.ok(warnings.length >= 1);
});

test('spellings collide', () => {
  const ids = ['Supino Incl Halt', 'Supino Inclinado Halter', 'Supino Inculcado Halter', 'supino halter inclinado']
    .map((n) => normalizeExercise(n).id);
  assert.equal(new Set(ids).size, 1);
});

test('lat pulldown is not pulldown', () => {
  assert.notEqual(normalizeExercise('Lat pulldown').id, normalizeExercise('Pulldown').id);
});

test('sets after a note keep the exercise', () => {
  const { sessions, warnings } = parseHistory('10/09\nVoador\n40kg 10\nobs\n42kg 9\n', { defaultYear: 2026 });
  assert.equal(warnings.length, 0);
  assert.equal(sessions[0].exercises.length, 1);
  assert.equal(sessions[0].exercises[0].sets.length, 2);
});

test('set right after a date is a warning', () => {
  const { warnings } = parseHistory('10/09\nVoador\n40kg 10\n\n11/09\n42kg 9\n', { defaultYear: 2026 });
  assert.equal(warnings.length, 1);
});

test('sample file parses clean', () => {
  const text = readFileSync(new URL('./sample-history.txt', import.meta.url), 'utf8');
  const { sessions, warnings, stats } = parseHistory(text);
  assert.equal(warnings.length, 0);
  assert.ok(stats.sessions > 20);
  assert.ok(indexByExercise(sessions).size > 10);
});

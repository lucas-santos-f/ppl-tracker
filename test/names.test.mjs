import { test } from 'node:test';
import assert from 'node:assert/strict';

import { exName } from '../js/names.js';
import { normalizeExercise } from '../js/normalize.js';

test('program names', () => {
  assert.equal(exName('Supino Reto Barra'), 'Barbell Bench Press');
  assert.equal(exName('Levantamento Terra'), 'Deadlift');
});

// imported names come out of normalizeExercise without accents in some words
test('accents and case', () => {
  assert.equal(exName('ELEVAÇÃO LATERAL MAQUINA SENTADO'), 'Seated Machine Lateral Raise');
  assert.equal(exName(normalizeExercise('sup incl halt').name), 'Incline Dumbbell Press');
});

test('unknown name, word by word', () => {
  assert.equal(exName('Remada Curvada Barra Pronada'), 'Bent-Over Overhand Barbell Row');
  assert.equal(exName('Puxada Alta Pegada Fechada'), 'Close-Grip Lat Pulldown');
});

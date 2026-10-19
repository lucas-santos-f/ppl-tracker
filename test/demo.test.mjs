import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shiftToYesterday } from '../js/demo.js';
import { parseHistory } from '../js/parser.js';

const oct19 = new Date(2026, 9, 19);

test('last date lands on yesterday, gaps kept', () => {
  const out = shiftToYesterday('30/12\nVoador\n40kg 10\n\n02/01\nVoador\n40kg 11\n', oct19);
  const dates = parseHistory(out).sessions.map((s) => s.date);
  assert.deepEqual(dates, ['2026-10-15', '2026-10-18']);
});

test('sample notebook stays in order', () => {
  const text = readFileSync(new URL('./sample-history.txt', import.meta.url), 'utf8');
  const { sessions } = parseHistory(shiftToYesterday(text, oct19));
  const dates = sessions.map((s) => s.date);
  assert.equal(dates.at(-1), '2026-10-18');
  assert.deepEqual(dates, [...dates].sort());
  assert.ok(sessions.length > 30);
});

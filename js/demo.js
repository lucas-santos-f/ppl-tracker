// Live demo: the made-up notebook in test/sample-history.txt, with its dates
// moved so the last workout was yesterday. Left as written, the 8-week window
// behind every target goes stale after two months and the demo would only ask
// for calibration sets.

const DATE = /^(\d{1,2})\/(\d{1,2})$/;
const pad = (n) => String(n).padStart(2, '0');

/**
 * Reads the dd/mm lines as consecutive dates (the file is in order, the year
 * turns when the month goes back), shifts them all by the same number of days
 * and writes them back with the year, so the importer has nothing to guess.
 */
export function shiftToYesterday(text, today = new Date()) {
  const lines = String(text).split('\n');
  const found = [];
  let year = today.getFullYear();
  let prevMonth = null;

  lines.forEach((line, i) => {
    const m = line.trim().match(DATE);
    if (!m) return;
    const month = +m[2];
    if (prevMonth != null && month < prevMonth) year++;
    prevMonth = month;
    found.push({ i, t: Date.UTC(year, month - 1, +m[1]) });
  });
  if (!found.length) return text;

  const yesterday = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const shift = yesterday - found[found.length - 1].t;
  for (const { i, t } of found) {
    const d = new Date(t + shift);
    lines[i] = `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
  }
  return lines.join('\n');
}

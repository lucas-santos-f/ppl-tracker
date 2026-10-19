// English names for the screen. Everything underneath stays Portuguese: the
// notebook is, so ids, history, aliases and the program all use those words.
// Translating at that level would split every history in two (sets logged in
// the app under "deadlift", imported ones under "levantamento-terra"), so this
// only changes what gets printed.

// not called fold(): build.mjs puts every module in one scope and app.js has one
const bare = (s) => String(s).normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();

// the names in the program and the ones that come out of my notebook
const KNOWN = {
  'supino reto barra': 'Barbell Bench Press',
  'supino reto barra com cotoveleira': 'Barbell Bench Press (elbow sleeves)',
  'supino inclinado barra': 'Incline Barbell Bench Press',
  'supino inclinado barra com cotoveleira': 'Incline Barbell Bench Press (elbow sleeves)',
  'supino inclinado halter': 'Incline Dumbbell Press',
  'supino inclinado maquina': 'Incline Machine Press',
  'supino inclinado maquina com cotoveleira': 'Incline Machine Press (elbow sleeves)',
  'supino pegada fechada (triceps)': 'Close-Grip Bench Press',
  'crossover peito superior': 'Low-to-High Cable Fly',
  'crossover baixa cima': 'Low-to-High Cable Fly',
  'crossover medial': 'Cable Crossover',
  'voador': 'Pec Deck',
  'voador invertido': 'Reverse Pec Deck',
  'peck deck invertido': 'Reverse Pec Deck',
  'elevacao lateral maquina sentado': 'Seated Machine Lateral Raise',
  'desenvolvimento maquina amarela': 'Machine Shoulder Press (yellow)',
  'remada alta': 'Upright Row',
  'remada baixa': 'Seated Cable Row',
  'remada cavalo peito banco': 'Chest-Supported T-Bar Row',
  'remada cavalo peito no banco': 'Chest-Supported T-Bar Row',
  'abdomen inferior (elevacao de pernas)': 'Leg Raise',
  'abdomen inferior (elevacao de pernas) com carga': 'Weighted Leg Raise',
  'elevacao abdominal inferior': 'Leg Raise',
  'abdominal inferior elevacao': 'Leg Raise',
  'abdomen superior maquina vermelha': 'Crunch Machine (red)',
  'abdominal maquina superior': 'Crunch Machine (red)',
  'abdomen superior no chao': 'Floor Crunch',
  'levantamento terra': 'Deadlift',
  'puxada alta': 'Lat Pulldown',
  'puxada alta kikos vermelha': 'Lat Pulldown (Kikos, red)',
  'barra fixa (pegada aberta)': 'Wide-Grip Pull-Up',
  'barra fixa aberta fechada': 'Pull-Up (wide + close grip)',
  'serrote': 'One-Arm Dumbbell Row',
  'serrote unilateral': 'One-Arm Dumbbell Row',
  'serrote unilateral com halter': 'One-Arm Dumbbell Row',
  'y raise': 'Y Raise',
  'crucifixo reverso no banco': 'Chest-Supported Reverse Fly',
  'posterior ombro halter peito banco': 'Chest-Supported Reverse Fly',
  'face pull': 'Face Pull',
  'triceps frances sentado halter': 'Seated Dumbbell Overhead Extension',
  'triceps frances halter sentado': 'Seated Dumbbell Overhead Extension',
  'triceps barra reta': 'Straight-Bar Pushdown',
  'triceps testa': 'Skull Crusher',
  'triceps paralela': 'Dips',
  'paralela': 'Dips',
  'triceps paralela maquina amarela': 'Dip Machine (yellow)',
  'paralela maquina amarela': 'Dip Machine (yellow)',
  'triceps paralela polia': 'Cable Dip',
  'scott invertido': 'Reverse-Grip Preacher Curl',
  'escada ou esteira': 'Stairs or Treadmill',
  'agachamento livre tradicional': 'Back Squat',
  'agachamento livre frontal': 'Front Squat',
  'agachamento hack': 'Hack Squat',
  'agachamento hack inclinado': 'Incline Hack Squat',
  'agachamento pendulo': 'Pendulum Squat',
  'cadeira extensora': 'Leg Extension',
  'extensora': 'Leg Extension',
  'cadeira flexora': 'Seated Leg Curl',
  'flexora': 'Seated Leg Curl',  // plain "flexora" in the notebook is always the seated one
  'stiff': 'Stiff-Leg Deadlift',
  'panturrilha': 'Machine Calf Raise',
  'panturrilha maquina': 'Machine Calf Raise',
  'elevacao pelvica': 'Hip Thrust',
  'vacuo abdominal': 'Stomach Vacuum',
  'alongamento de flexor de quadril': 'Hip Flexor Stretch',
  'dead bug': 'Dead Bug',
  'hollow hold': 'Hollow Hold',
};

// Fallback for names typed later. Word by word, then reordered the English way
// (seated incline dumbbell ... press) by rank. Not pretty, but readable.
const WORDS = {
  'barra fixa': ['Pull-Up', 9], 'leg press': ['Leg Press', 9], 'face pull': ['Face Pull', 9],
  'levantamento terra': ['Deadlift', 9], 'pegada fechada': ['Close-Grip', 4],
  'pegada aberta': ['Wide-Grip', 4], 'em pe': ['Standing', 1],
  'puxada alta': ['Lat Pulldown', 9], 'remada alta': ['Upright Row', 9],
  'remada baixa': ['Seated Cable Row', 9], 'barra w': ['EZ-Bar', 5],
  'abdominal superior': ['Crunch', 9], 'abdomen superior': ['Crunch', 9],
  'abdominal inferior': ['Leg Raise', 9], 'abdomen inferior': ['Leg Raise', 9],
  sentado: ['Seated', 1], deitado: ['Lying', 1], mesa: ['Lying', 1],
  unilateral: ['Single-Arm', 2], uni: ['Single-Arm', 2], bilateral: ['', 2],
  inclinado: ['Incline', 3], declinado: ['Decline', 3], reto: ['', 3],
  alta: ['High', 3], baixa: ['Low', 3], superior: ['Upper', 3], inferior: ['Lower', 3],
  aberta: ['Wide', 4], fechada: ['Close', 4], neutra: ['Neutral-Grip', 4], direta: ['', 4],
  pronada: ['Overhand', 4], supinada: ['Underhand', 4], curvada: ['Bent-Over', 4],
  barra: ['Barbell', 5], halter: ['Dumbbell', 5], maquina: ['Machine', 5], polia: ['Cable', 5],
  corda: ['Rope', 5], smith: ['Smith', 5], livre: ['', 5], banco: ['Bench', 5],
  articulada: ['Plate-Loaded', 5], convergente: ['Converging', 5], cavalo: ['T-Bar', 5],
  cavalinho: ['T-Bar', 5], triangulo: ['V-Grip', 4],
  w: ['EZ-Bar', 5],
  lateral: ['Lateral', 6], frontal: ['Front', 6], posterior: ['Rear', 6], invertido: ['Reverse', 6],
  peito: ['Chest', 7], ombro: ['Shoulder', 7], triceps: ['Triceps', 7], biceps: ['Biceps', 7],
  gluteo: ['Glute', 7], lombar: ['Lower Back', 7], abdominal: ['Ab', 7], abdomen: ['Ab', 7],
  supino: ['Bench Press', 9], remada: ['Row', 9], puxada: ['Pulldown', 9], pulldown: ['Pulldown', 9],
  rosca: ['Curl', 9], elevacao: ['Raise', 9], desenvolvimento: ['Shoulder Press', 9],
  agachamento: ['Squat', 9], panturrilha: ['Calf Raise', 9], extensora: ['Leg Extension', 9],
  flexora: ['Leg Curl', 9], crossover: ['Cable Crossover', 9], voador: ['Pec Deck', 9],
  crucifixo: ['Fly', 9], paralela: ['Dips', 9], testa: ['Skull Crusher', 9],
  frances: ['Overhead Extension', 9], serrote: ['One-Arm Row', 9], encolhimento: ['Shrug', 9],
  adutora: ['Adductor', 9], abdutora: ['Abductor', 9], pendulo: ['Pendulum', 9], hack: ['Hack', 8],
  stiff: ['Stiff-Leg Deadlift', 9], prancha: ['Plank', 9], esteira: ['Treadmill', 9],
  bicicleta: ['Bike', 9], escada: ['Stairs', 9],
  // machine colors and brands are how I tell the gym's machines apart, keep them
  amarela: ['(yellow)', 10], vermelha: ['(red)', 10], azul: ['(blue)', 10], verde: ['(green)', 10],
  preta: ['(black)', 10], branca: ['(white)', 10], cinza: ['(gray)', 10],
  cotoveleira: ['(elbow sleeves)', 10], carga: ['(weighted)', 10],
};
const SKIP = new Set(['de', 'da', 'do', 'com', 'e', 'no', 'na', 'em', 'ou', 'o', 'a']);
const PHRASES = Object.keys(WORDS).filter((k) => k.includes(' '));

function byWords(name) {
  let s = bare(name).replace(/[()]/g, ' ');
  const found = [];
  for (const p of PHRASES) {
    if (s.includes(p)) { found.push(WORDS[p]); s = s.replace(p, ' '); }
  }
  for (const w of s.split(/\s+/)) {
    if (!w || SKIP.has(w)) continue;
    const hit = WORDS[w];
    if (hit) found.push(hit);
    else found.push([w.charAt(0).toUpperCase() + w.slice(1), 8]);
  }
  const out = found.filter(([t]) => t).sort((a, b) => a[1] - b[1]).map(([t]) => t);
  return [...new Set(out)].join(' ');
}

export function exName(name) {
  if (!name) return '';
  return KNOWN[bare(name)] ?? byWords(name);
}

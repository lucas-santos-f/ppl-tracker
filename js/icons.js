// Stroke icons drawn for this app on a 24px grid. currentColor, so they follow
// the theme and the accent of whatever they sit in. Replaced the emoji, which
// render differently on every OS and can't be colored.

const PATHS = {
  dumbbell: '<path d="M6.5 6v12M17.5 6v12M3 9.5v5M21 9.5v5M6.5 12h11"/>',
  trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  layers: '<path d="M12 3.5l8.5 4.5-8.5 4.5L3.5 8z"/><path d="M3.5 12.5L12 17l8.5-4.5"/><path d="M3.5 16.5L12 21l8.5-4.5"/>',
  clock: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4.5v4h4"/><path d="M12 8v4.5l3 1.8"/>',
  paste: '<rect x="5.5" y="4.5" width="13" height="16" rx="2.5"/><path d="M9 4.5v-1h6v1"/><path d="M12 9v6.5M9.5 13l2.5 2.5 2.5-2.5"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5"/>',
  note: '<path d="M5 5.5h14v10h-9l-4 3.5v-3.5H5z"/>',
  bolt: '<path d="M13 3L5.5 13.5H12L11 21l7.5-10.5H12z"/>',
  alert: '<path d="M12 4l9 15.5H3z"/><path d="M12 10v4M12 17v.01"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
};

export function icon(name, cls = 'i') {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" `
    + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] || ''}</svg>`;
}

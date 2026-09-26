// Loads every spec file at build time. Adding a JSON file = adding a page.
const modules = import.meta.glob('/data/specs/**/*.json', { eager: true, import: 'default' });

export const CHANNELS = {
  display: 'Display',
  social: 'Social',
  ctv: 'Connected TV',
  'online-video': 'Online video',
  dooh: 'Digital out-of-home',
  'retail-media': 'Retail media',
  audio: 'Audio',
  native: 'Native',
  search: 'Search',
};

const gcd = (a, b) => (b ? gcd(b, a % b) : a);
export function ratio(w, h) {
  const g = gcd(w, h);
  const [a, b] = [w / g, h / g];
  if (a <= 32 && b <= 32) return `${a}:${b}`;
  // Odd ratios like 364:45 mean nothing to a designer; show the decimal.
  return w >= h ? `${+(w / h).toFixed(2)}:1` : `1:${+(h / w).toFixed(2)}`;
}

export function getAllSpecs() {
  return Object.values(modules).sort((a, b) =>
    a.platform.name.localeCompare(b.platform.name) || a.placement.localeCompare(b.placement)
  );
}

export function getPlatforms() {
  const map = new Map();
  for (const s of getAllSpecs()) {
    if (!map.has(s.platform.slug)) map.set(s.platform.slug, { ...s.platform, channels: new Set(), specs: [] });
    const p = map.get(s.platform.slug);
    p.specs.push(s);
    p.channels.add(s.channel);
  }
  return [...map.values()];
}

export function formatDate(iso) {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

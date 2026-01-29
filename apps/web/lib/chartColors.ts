/**
 * Map product color names to intuitive chart hex colors (with shades for similar names).
 * Used in Historical Sales analytics so NAVY, BLACK, CAPTAINS BLUE, etc. look right.
 */

const NAME_TO_HEX: Record<string, string> = {
  // Neutrals
  black: '#1a1a1a',
  white: '#f5f5f5',
  offwhite: '#fafafa',
  grey: '#6b7280',
  gray: '#6b7280',
  silver: '#c0c0c0',
  charcoal: '#36454f',
  'new kitt': '#9ca3af',
  kitt: '#9ca3af',
  // Blues
  navy: '#000080',
  blue: '#2563eb',
  'captains blue': '#1e3a5f',
  'captain blue': '#1e3a5f',
  'light blue': '#7dd3fc',
  'dark blue': '#1e3b82',
  // Browns / earth
  brown: '#8b4513',
  'dark brown': '#5c4033',
  'light brown': '#c4a484',
  sand: '#c2b280',
  beige: '#d4c4a8',
  tan: '#d2b48c',
  choko: '#3d2914',
  koks: '#3d2914',
  // Greens
  green: '#16a34a',
  'dark green': '#166534',
  'light green': '#86efac',
  olive: '#6b8e23',
  // Red / pink
  red: '#dc2626',
  rosa: '#e11d48',
  pink: '#ec4899',
  rose: '#e11d48',
  // Orange / yellow
  orange: '#ea580c',
  'dusty khaki': '#c3b091',
  khaki: '#c3b091',
  yellow: '#eab308',
  mustard: '#e4a853',
  // Other
  purple: '#7c3aed',
  lavender: '#a78bfa',
  burgundy: '#722f37',
  wine: '#722f37',
};

/** Normalize color name for lookup: lowercase, trim, collapse spaces */
function normalizeName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

/** Simple string hash for fallback color generation */
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

/** Fallback palette for unknown color names (distinct shades) */
const FALLBACK_PALETTE = [
  '#0f766e', '#0369a1', '#b45309', '#a21caf', '#0d9488',
  '#1d4ed8', '#c2410c', '#6d28d9', '#15803d', '#be123c',
  '#4f46e5', '#ca8a04', '#059669', '#db2777', '#2563eb',
  '#65a30d', '#7c2d12', '#1e40af', '#9a3412', '#5b21b6',
];

/**
 * Return a hex color for a product color name (e.g. "NAVY", "100 WHITE", "CAPTAINS BLUE").
 * Uses known mappings where possible; otherwise derives a stable shade from a fallback palette.
 */
export function getColorForName(colorName: string, index: number): string {
  if (!colorName || typeof colorName !== 'string') {
    return FALLBACK_PALETTE[index % FALLBACK_PALETTE.length];
  }
  const norm = normalizeName(colorName);
  // Strip leading numbers (e.g. "100 white" -> "white")
  const withoutNumber = norm.replace(/^\d+\s*/, '').trim() || norm;
  const exact = NAME_TO_HEX[withoutNumber];
  if (exact) return exact;
  // Partial match: "new kitt" might not be in map; try first word or known substrings
  for (const [key, hex] of Object.entries(NAME_TO_HEX)) {
    if (withoutNumber.includes(key) || key.includes(withoutNumber)) {
      return hex;
    }
  }
  // Stable color from name + index
  const hash = hashString(withoutNumber) + index * 31;
  return FALLBACK_PALETTE[hash % FALLBACK_PALETTE.length];
}

/**
 * Return an array of hex colors for an ordered list of color names.
 * Use this for stacked area / line charts so each series has an intuitive color.
 */
export function getColorsForNames(colorNames: string[]): string[] {
  return colorNames.map((name, i) => getColorForName(name, i));
}

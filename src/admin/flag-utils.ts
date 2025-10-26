// flag-utils.ts
// @ts-nocheck
// Summary: Generates a list of ISO country codes with corresponding flag emojis.
// Structure: helper to convert country code -> emoji, generator using Intl APIs -> export.
// Usage: Imported by admin.js to populate flag emoji datalist for nation selection.
// ---------------------------------------------------------------------------

// Convert an ISO 3166-1 alpha-2 country code into its flag emoji.
export function codeToFlagEmoji(code: string): string {
  return code
    .toUpperCase()
    .replace(/./g, c => String.fromCodePoint(127397 + c.charCodeAt(0)));
}

// Predefined set of region codes that should always be available. This acts as a
// fallback when Intl.supportedValuesOf is unavailable or incomplete. Codes were
// chosen based on user feedback to ensure common flags always appear.
const defaultRegions = [
  'GB', 'US', 'CA', 'AU', 'NZ', 'IE', 'FR', 'DE', 'ES', 'IT', 'PT', 'NL', 'BE',
  'CH', 'AT', 'SE', 'NO', 'DK', 'FI', 'IS', 'JP', 'CN', 'KR', 'IN', 'PK', 'BD',
  'RU', 'UA', 'PL', 'CZ', 'SK', 'HU', 'RO', 'RS', 'GR', 'TR', 'IL', 'SA', 'AE',
  'QA', 'ZA', 'NG', 'EG', 'MA', 'KE', 'TZ', 'CM', 'GH', 'UG', 'SD', 'MX', 'BR',
  'AR', 'CL', 'PE', 'CO', 'EC', 'VE', 'BO', 'PY', 'UY'
];

// Build [{code,name,emoji}] list using Intl APIs with graceful fallback.
export function getFlagList(): Array<{ code: string; name: string; emoji: string }> {
  const display = typeof Intl.DisplayNames === 'function'
    ? new Intl.DisplayNames(['en'], { type: 'region' })
    : null;

  const regions = typeof Intl.supportedValuesOf === 'function'
    ? Intl.supportedValuesOf('region').filter(c => c.length === 2)
    : [];

  // Merge supported regions with defaults and remove duplicates.
  const merged = Array.from(new Set([...regions, ...defaultRegions]));

  return merged.map(code => ({
    code,
    name: display ? display.of(code) ?? code : code,
    emoji: codeToFlagEmoji(code)
  }));
}

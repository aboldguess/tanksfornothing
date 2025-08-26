// flag-utils.js
// Summary: Generates a list of ISO country codes with corresponding flag emojis.
// Structure: helper to convert country code -> emoji, generator using Intl APIs -> export.
// Usage: Imported by admin.js to populate flag emoji datalist for nation selection.
// ---------------------------------------------------------------------------

// Convert an ISO 3166-1 alpha-2 country code into its flag emoji.
export function codeToFlagEmoji(code) {
  return code
    .toUpperCase()
    .replace(/./g, c => String.fromCodePoint(127397 + c.charCodeAt(0)));
}

// Build [{code,name,emoji}] list using Intl APIs with graceful fallback.
export function getFlagList() {
  const display = typeof Intl.DisplayNames === 'function'
    ? new Intl.DisplayNames(['en'], { type: 'region' })
    : null;
  const regions = typeof Intl.supportedValuesOf === 'function'
    ? Intl.supportedValuesOf('region').filter(c => c.length === 2)
    : ['US', 'GB', 'DE', 'FR', 'JP']; // minimal fallback
  return regions.map(code => ({
    code,
    name: display ? display.of(code) : code,
    emoji: codeToFlagEmoji(code)
  }));
}

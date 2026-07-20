export function normalizeUsername(value) {
  if (typeof value !== 'string') throw new TypeError('username must be a string');
  return value.toLowerCase().replace(/\s+/, '-');
}

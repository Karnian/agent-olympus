function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!isPlainObject(value)) return value;
  return mergeConfig({}, value);
}

export function mergeConfig(base, override) {
  const result = {};
  for (const [key, value] of Object.entries(base ?? {})) {
    result[key] = clone(value);
  }
  for (const [key, value] of Object.entries(override ?? {})) {
    result[key] = isPlainObject(value) && isPlainObject(base?.[key])
      ? mergeConfig(base[key], value)
      : clone(value);
  }
  return result;
}

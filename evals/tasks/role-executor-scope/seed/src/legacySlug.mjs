// TODO: replace this simplistic legacy helper with Unicode-aware slugification.
export function legacySlug(value) {
  return String(value).trim().replaceAll(' ', '_');
}

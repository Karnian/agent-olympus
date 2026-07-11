export function lastN(arr, n) {
  if (n <= 0) {
    return [];
  }
  return arr.slice(Math.max(arr.length - n, 0));
}

export async function mapLimit(items, limit, mapper) {
  return Promise.all(items.map((item, index) => mapper(item, index)));
}

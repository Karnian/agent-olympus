export class LRUCache {
  constructor(capacity) {
    this.capacity = capacity;
    this.entries = new Map();
  }

  get(key) {
    return this.entries.get(key);
  }

  set(key, value) {
    this.entries.set(key, value);
    if (this.entries.size > this.capacity) {
      this.entries.delete(this.entries.keys().next().value);
    }
    return this;
  }
}

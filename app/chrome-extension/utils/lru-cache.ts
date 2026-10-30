class LRUNode<K, V> {
  constructor(
    public key: K,
    public value: V,
    public prev: LRUNode<K, V> | null = null,
    public next: LRUNode<K, V> | null = null,
    public frequency = 1,
    public lastAccessed = Date.now(),
  ) {}
}

class LRUCache<K = string, V = unknown> {
  private readonly capacity: number;
  private readonly cache = new Map<K, LRUNode<K, V>>();
  private readonly head = new LRUNode<K, V>(null as K, null as V);
  private readonly tail = new LRUNode<K, V>(null as K, null as V);

  constructor(capacity: number) {
    this.capacity = capacity > 0 ? capacity : 100;
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  private addToHead(node: LRUNode<K, V>): void {
    node.prev = this.head;
    node.next = this.head.next;
    this.head.next!.prev = node;
    this.head.next = node;
  }

  private removeNode(node: LRUNode<K, V>): void {
    node.prev!.next = node.next;
    node.next!.prev = node.prev;
  }

  private moveToHead(node: LRUNode<K, V>): void {
    this.removeNode(node);
    this.addToHead(node);
  }

  private findVictimNode(): LRUNode<K, V> {
    let victim = this.tail.prev!;
    let minimum = this.calculateEvictionScore(victim);
    let current = this.tail.prev;
    for (
      let checked = 0;
      current && current !== this.head && checked < Math.min(5, this.cache.size);
      checked++, current = current.prev
    ) {
      const score = this.calculateEvictionScore(current);
      if (score < minimum) {
        minimum = score;
        victim = current;
      }
    }
    return victim;
  }

  private calculateEvictionScore(node: LRUNode<K, V>): number {
    return Math.log(node.frequency + 1) / (1 + (Date.now() - node.lastAccessed) / 60_000);
  }

  get(key: K): V | null {
    const node = this.cache.get(key);
    if (!node) return null;
    node.frequency++;
    node.lastAccessed = Date.now();
    this.moveToHead(node);
    return node.value;
  }

  set(key: K, value: V): void {
    const existing = this.cache.get(key);
    if (existing) {
      existing.value = value;
      this.moveToHead(existing);
      return;
    }
    if (this.cache.size >= this.capacity) {
      const victim = this.findVictimNode();
      this.removeNode(victim);
      this.cache.delete(victim.key);
    }
    const node = new LRUNode(key, value);
    this.cache.set(key, node);
    this.addToHead(node);
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }
  clear(): void {
    this.cache.clear();
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }
  get size(): number {
    return this.cache.size;
  }
  getStats(): { size: number; capacity: number; usage: number } {
    return {
      size: this.cache.size,
      capacity: this.capacity,
      usage: this.cache.size / this.capacity,
    };
  }
}

export default LRUCache;

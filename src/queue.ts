/** A single-consumer queue. Closing wakes a consumer blocked in next(). */
export class Queue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private wake?: () => void;
  private ended = false;
  private error?: Error;

  push(item: T) {
    if (this.ended) return;
    this.items.push(item);
    this.wake?.();
  }

  close(error?: Error) {
    this.ended = true;
    this.error = error;
    this.wake?.();
  }

  async *[Symbol.asyncIterator]() {
    for (;;) {
      if (this.items.length) yield this.items.shift()!;
      else if (this.ended) {
        if (this.error) throw this.error;
        return;
      } else await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }
}

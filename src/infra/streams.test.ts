import { describe, expect, it } from 'vitest';
import { ensureStreamIteration } from './streams';

describe('ReadableStream iteration on Safari (D-60)', () => {
  it('adds for-await over a stream when the browser lacks it', async () => {
    const proto = ReadableStream.prototype as unknown as Record<symbol, unknown>;
    const native = proto[Symbol.asyncIterator];
    delete proto[Symbol.asyncIterator];
    try {
      expect(ensureStreamIteration()).toBe(false);
      const stream = new ReadableStream<number>({
        start(c) {
          c.enqueue(1);
          c.enqueue(2);
          c.close();
        },
      });
      const seen: number[] = [];
      for await (const v of stream as unknown as AsyncIterable<number>) seen.push(v);
      expect(seen).toEqual([1, 2]);
      expect(ensureStreamIteration()).toBe(true);
    } finally {
      proto[Symbol.asyncIterator] = native;
    }
  });
});

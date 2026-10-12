/**
 * Safari (iOS 18 and earlier) cannot loop over a ReadableStream with
 * `for await`, which pdf.js 6 does when it reads a page's text and when it
 * inflates compressed data. This adds that ability where it is missing
 * (D-60). Returns true when the browser had it natively.
 */
export function ensureStreamIteration(): boolean {
  if (typeof ReadableStream === 'undefined') return false;
  const proto = ReadableStream.prototype as unknown as Record<symbol, unknown>;
  if (typeof proto[Symbol.asyncIterator] === 'function') return true;
  proto[Symbol.asyncIterator] = async function* (this: ReadableStream<unknown>) {
    const reader = this.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  };
  return false;
}

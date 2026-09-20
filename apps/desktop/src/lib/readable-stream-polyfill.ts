/**
 * WKWebView's `ReadableStream` has no `Symbol.asyncIterator`, and pdf.js 6
 * iterates stream readers with `for await` during document load and text
 * extraction — every `getDocument`/`getTextContent` call dies with
 * "undefined is not a function" without this. Imported for side effect by
 * both `lib/pdf.ts` (main thread) and `lib/pdf-worker.ts` (worker global).
 */
type AsyncIterableReadableStream = ReadableStream<unknown> & AsyncIterable<unknown>;

if (typeof ReadableStream !== "undefined" && !(Symbol.asyncIterator in ReadableStream.prototype)) {
  const proto = ReadableStream.prototype as AsyncIterableReadableStream;
  proto[Symbol.asyncIterator] = async function* (
    this: ReadableStream<unknown>,
  ): AsyncIterableIterator<unknown> {
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
}

export {};

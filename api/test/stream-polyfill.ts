// What the Workers runtime has and Bun does not, for the unit tests that drive the Worker's routes: a stream that passes on exactly the
// number of bytes it is told to (`FixedLengthStream`).

class FixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(length: number) {
    let seen = 0;
    super({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > length) throw new TypeError("Too many bytes were written to a FixedLengthStream");
        controller.enqueue(chunk);
      },
      flush() {
        if (seen !== length) throw new TypeError("Fewer bytes than the FixedLengthStream was told to expect");
      },
    });
  }
}

export function installStreamPolyfill(): void {
  (globalThis as unknown as { FixedLengthStream: unknown }).FixedLengthStream = FixedLengthStream;
}
export function removeStreamPolyfill(): void {
  delete (globalThis as unknown as { FixedLengthStream?: unknown }).FixedLengthStream;
}

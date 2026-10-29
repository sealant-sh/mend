export class ByteQueue {
  private chunks: Uint8Array[] = [];
  length = 0;

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  /** The first `count` bytes, which the caller has checked are buffered. */
  peek(count: number): Uint8Array {
    const first = this.chunks[0];
    if (first !== undefined && first.length >= count) return first.subarray(0, count);
    let joined = 0;
    let size = 0;
    while (size < count) size += this.chunks[joined++]?.length ?? count;
    const merged = Buffer.concat(this.chunks.splice(0, joined));
    this.chunks.unshift(merged);
    return merged.subarray(0, count);
  }

  take(count: number): Uint8Array {
    const bytes = this.peek(count);
    const rest = this.chunks[0]?.subarray(count);
    if (rest === undefined || rest.length === 0) this.chunks.shift();
    else this.chunks[0] = rest;
    this.length -= count;
    return bytes;
  }
}

export const view = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

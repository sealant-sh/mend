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
    const bytes = Buffer.alloc(count);
    let filled = 0;
    for (const chunk of this.chunks) {
      if (filled === count) break;
      const part = chunk.subarray(0, count - filled);
      bytes.set(part, filled);
      filled += part.length;
    }
    return bytes;
  }

  take(count: number): Uint8Array {
    const bytes = this.peek(count);
    let left = count;
    let spent = 0;
    for (const chunk of this.chunks) {
      if (chunk.length > left) {
        this.chunks[spent] = chunk.subarray(left);
        break;
      }
      left -= chunk.length;
      spent++;
    }
    this.chunks.splice(0, spent);
    this.length -= count;
    return bytes;
  }
}

export const view = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

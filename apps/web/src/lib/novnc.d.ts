/**
 * The part of noVNC 1.7.0's `RFB` (core/rfb.js, docs/API.md) the screen pane uses. The package
 * ships no types. A channel is anything with WebSocket's `send`, `close`, `binaryType`,
 * `onerror`, `onmessage`, `onopen`, `protocol` and `readyState` (core/websock.js `rawChannelProps`).
 */
declare module "@novnc/novnc" {
  export interface RfbChannel {
    binaryType: BinaryType;
    readonly protocol: string;
    readonly readyState: number;
    onopen: (() => void) | null;
    onmessage: ((event: { readonly data: ArrayBuffer }) => void) | null;
    onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null;
    onerror: ((event: Event) => void) | null;
    send(data: Uint8Array<ArrayBuffer>): void;
    close(): void;
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, channel: RfbChannel, options?: { readonly shared?: boolean });
    viewOnly: boolean;
    scaleViewport: boolean;
    background: string;
    disconnect(): void;
    focus(): void;
  }
}

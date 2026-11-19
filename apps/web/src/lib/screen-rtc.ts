import { ScreenRtcAnswer } from "@mend/api-contracts";
import type { ViewerConnectionId } from "@mend/domain";
import { Schema } from "effect";

/** A video viewer whose input follows the server's holder, owned by the mounted video element. */
export interface ScreenRtcView {
  readonly close: () => void;
  readonly focus: () => void;
  readonly setHeld: (held: boolean) => void;
}

/**
 * Watch over H.264 and send input over SCTP. A five-second failure calls `fallback` once and
 * releases this peer before the caller opens noVNC. No input is sent until `setHeld(true)`.
 */
export const openScreenRtc = (
  video: HTMLVideoElement,
  sessionId: string,
  events: {
    readonly watching: (connection: ViewerConnectionId) => void;
    readonly fallback: () => void;
  },
): ScreenRtcView => {
  const peer = new RTCPeerConnection({ iceServers: [] });
  const transceiver = peer.addTransceiver("video", { direction: "recvonly" });
  const codecs =
    RTCRtpReceiver.getCapabilities("video")?.codecs.filter(
      (codec) => codec.mimeType.toLowerCase() === "video/h264",
    ) ?? [];
  if (codecs.length > 0) transceiver.setCodecPreferences(codecs);
  const channel = peer.createDataChannel("input", { ordered: true });
  const abort = new AbortController();
  const keys = new Map<string, number>();
  let point = { x: 0, y: 0 };
  let disposed = false;
  let held = false;
  let connection: ViewerConnectionId | null = null;
  const send = (
    input:
      | { readonly x: number; readonly y: number; readonly buttons: number }
      | { readonly keysym: number; readonly down: boolean },
  ) => {
    if (held && channel.readyState === "open" && channel.bufferedAmount < 64 * 1024)
      channel.send(JSON.stringify(input));
  };
  const key = (event: KeyboardEvent) => {
    if (!held) return;
    const down = event.type === "keydown";
    const keysym = down ? screenKeysym(event) : keys.get(event.code);
    if (keysym === undefined) return;
    event.preventDefault();
    if (down) keys.set(event.code, keysym);
    else keys.delete(event.code);
    send({ keysym, down });
  };
  const release = () => {
    for (const keysym of keys.values()) send({ keysym, down: false });
    keys.clear();
    send({ ...point, buttons: 0 });
  };
  const pointer = (event: PointerEvent) => {
    if (!held) return;
    event.preventDefault();
    if (event.type === "pointerdown") {
      video.focus();
      video.setPointerCapture(event.pointerId);
    }
    const rect = video.getBoundingClientRect();
    point = {
      x: Math.max(0, Math.min(1279, Math.floor(((event.clientX - rect.left) * 1280) / rect.width))),
      y: Math.max(0, Math.min(799, Math.floor(((event.clientY - rect.top) * 800) / rect.height))),
    };
    send({
      ...point,
      buttons: (event.buttons & 1) | ((event.buttons & 4) >> 1) | ((event.buttons & 2) << 1),
    });
  };
  const context = (event: Event) => {
    if (held) event.preventDefault();
  };
  for (const name of ["pointerdown", "pointermove", "pointerup", "pointercancel"] as const)
    video.addEventListener(name, pointer);
  const wheel = (event: WheelEvent) => {
    if (!held) return;
    event.preventDefault();
    const buttons = event.deltaY < 0 ? 8 : event.deltaY > 0 ? 16 : event.deltaX < 0 ? 32 : 64;
    send({ ...point, buttons });
    send({ ...point, buttons: 0 });
  };
  video.addEventListener("contextmenu", context);
  video.addEventListener("wheel", wheel, { passive: false });
  video.addEventListener("keydown", key);
  video.addEventListener("keyup", key);
  video.addEventListener("blur", release);
  const close = () => {
    if (disposed) return;
    disposed = true;
    held = false;
    abort.abort();
    clearTimeout(deadline);
    clearInterval(heartbeat);
    keys.clear();
    peer.close();
    video.srcObject = null;
    for (const name of ["pointerdown", "pointermove", "pointerup", "pointercancel"] as const)
      video.removeEventListener(name, pointer);
    video.removeEventListener("contextmenu", context);
    video.removeEventListener("wheel", wheel);
    video.removeEventListener("keydown", key);
    video.removeEventListener("keyup", key);
    video.removeEventListener("blur", release);
    video.removeEventListener("loadeddata", watching);
  };
  const failed = () => {
    if (!disposed) {
      close();
      events.fallback();
    }
  };
  const deadline = setTimeout(failed, 5000);
  const heartbeat = setInterval(() => {
    if (channel.readyState === "open") channel.send("ping");
  }, 2500);
  const watching = () => {
    if (!disposed && connection !== null && video.videoWidth > 0) {
      clearTimeout(deadline);
      events.watching(connection);
    }
  };
  video.addEventListener("loadeddata", watching);
  peer.addEventListener("track", (event) => {
    video.srcObject = new MediaStream([event.track]);
    void video.play().catch(failed);
  });
  peer.addEventListener("connectionstatechange", () => {
    if (["failed", "disconnected", "closed"].includes(peer.connectionState)) failed();
  });
  const negotiate = async () => {
    await peer.setLocalDescription(await peer.createOffer());
    if (peer.iceGatheringState !== "complete")
      await new Promise<void>((resolve) => {
        peer.addEventListener("icegatheringstatechange", () => {
          if (peer.iceGatheringState === "complete") resolve();
        });
        abort.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    if (disposed) return;
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/screen/rtc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offer: peer.localDescription?.sdp }),
      signal: abort.signal,
    });
    if (!response.ok) {
      failed();
      return;
    }
    const answer = Schema.decodeUnknownSync(ScreenRtcAnswer)(await response.json());
    if (disposed) return;
    connection = answer.connection;
    await peer.setRemoteDescription({ type: "answer", sdp: answer.answer });
    watching();
  };
  void negotiate().catch(failed);
  return {
    close,
    focus: () => video.focus(),
    setHeld: (next) => {
      if (held === next) return;
      if (!next) release();
      held = next;
    },
  };
};

const KEY: Readonly<Record<string, number>> = {
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  Escape: 0xff1b,
  Home: 0xff50,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  PageUp: 0xff55,
  PageDown: 0xff56,
  End: 0xff57,
  Insert: 0xff63,
  Delete: 0xffff,
  Shift: 0xffe1,
  Control: 0xffe3,
  CapsLock: 0xffe5,
  Meta: 0xffeb,
  Alt: 0xffe9,
  AltGraph: 0xfe03,
  NumLock: 0xff7f,
  ScrollLock: 0xff14,
  Pause: 0xff13,
  PrintScreen: 0xff61,
  ContextMenu: 0xff67,
};

/** X11 keysyms for browser characters and navigation, preserving left/right modifiers. */
export const screenKeysym = (
  event: Pick<KeyboardEvent, "key" | "code" | "location">,
): number | undefined => {
  const symbol = Object.hasOwn(KEY, event.key) ? KEY[event.key] : undefined;
  if (symbol !== undefined)
    return ["Shift", "Control", "Alt", "Meta"].includes(event.key) && event.location === 2
      ? symbol + 1
      : symbol;
  const functionKey = /^F([1-9]|[12][0-9]|3[0-5])$/.exec(event.key);
  if (functionKey !== null) return 0xffbd + Number(functionKey[1]);
  if (Array.from(event.key).length !== 1) return undefined;
  const unicode = event.key.codePointAt(0);
  return unicode === undefined ? undefined : unicode <= 0xff ? unicode : 0x01000000 + unicode;
};

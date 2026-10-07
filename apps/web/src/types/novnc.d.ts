// noVNC 1.7 exports its RFB class from the package root; the upstream type package
// still declares the former lib/rfb entrypoint.
declare module "@novnc/novnc" {
  export { default } from "@novnc/novnc/lib/rfb";
}

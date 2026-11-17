import type { ComponentPropsWithoutRef } from "react";

// The Mend mark — a seam, closed by stitches. The tear is ink (the issue);
// the stitches are cobalt (the mend). Shared with the marketing site.
export const MendMark = (props: ComponentPropsWithoutRef<"svg">) => (
  <svg viewBox="0 0 42 42" xmlns="http://www.w3.org/2000/svg" fill="none" {...props}>
    <path
      d="M17 4 L24 14 L18.5 24 L26 38"
      className="stroke-black dark:stroke-white"
      strokeWidth="3.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M13.5 11.5 L29 6.5"
      stroke="var(--sw-accent, #2052cc)"
      strokeWidth="3.2"
      strokeLinecap="round"
    />
    <path
      d="M13 21.5 L28.5 16.5"
      stroke="var(--sw-accent, #2052cc)"
      strokeWidth="3.2"
      strokeLinecap="round"
    />
    <path
      d="M14.5 33 L30 28"
      stroke="var(--sw-accent, #2052cc)"
      strokeWidth="3.2"
      strokeLinecap="round"
    />
  </svg>
);

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// React passes CSS custom properties (`--sidebar-width`) through to an element's style, but its
// types list none of them. Declared here, beside `cn`, so every component that sets one sees it.
declare module "react" {
  interface CSSProperties {
    [variable: `--${string}`]: string | number | undefined;
  }
}

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

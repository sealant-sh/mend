/**
 * Window bounds persistence and multi-monitor clamping so unplugging an external display never
 * strands the window off-screen.
 */

export interface WindowBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DisplayRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const DEFAULT_WINDOW_SIZE = { width: 1440, height: 920 } as const;
export const MIN_WINDOW_SIZE = { width: 960, height: 600 } as const;

// A window snapped to a display edge can report 1px past that edge on some compositors.
const EDGE_TOLERANCE_PX = 1;

export const windowFitsDisplay = (bounds: WindowBounds, display: DisplayRect): boolean =>
  bounds.width >= MIN_WINDOW_SIZE.width &&
  bounds.height >= MIN_WINDOW_SIZE.height &&
  bounds.x >= display.x - EDGE_TOLERANCE_PX &&
  bounds.y >= display.y - EDGE_TOLERANCE_PX &&
  bounds.x + bounds.width <= display.x + display.width + EDGE_TOLERANCE_PX &&
  bounds.y + bounds.height <= display.y + display.height + EDGE_TOLERANCE_PX;

export const resolveInitialBounds = (
  saved: WindowBounds | null,
  displays: ReadonlyArray<DisplayRect>,
): WindowBounds | typeof DEFAULT_WINDOW_SIZE => {
  if (saved !== null && displays.some((display) => windowFitsDisplay(saved, display))) {
    return saved;
  }
  return DEFAULT_WINDOW_SIZE;
};

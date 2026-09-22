/**
 * Snake, for the wait. A first session on a new project setup builds its image before it boots,
 * seven minutes on some families, and the dashboard shows this in the detail pane while the
 * session reads `starting`. Pure: a game is a value, every tick is a function of it, and the
 * randomness is injected, so the rules are testable and the component only draws.
 */
export type Direction = "up" | "down" | "left" | "right";
export interface Cell {
  readonly x: number;
  readonly y: number;
}
export interface SnakeGame {
  readonly width: number;
  readonly height: number;
  /** Head first. */
  readonly snake: readonly Cell[];
  readonly direction: Direction;
  /** The turn taken since the last tick, applied at the next one; one per tick. */
  readonly pending: Direction | null;
  readonly food: Cell;
  readonly score: number;
  readonly over: boolean;
}

const OPPOSITE: Readonly<Record<Direction, Direction>> = {
  up: "down",
  down: "up",
  left: "right",
  right: "left",
};
const STEP: Readonly<Record<Direction, Cell>> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const same = (a: Cell, b: Cell): boolean => a.x === b.x && a.y === b.y;

/** A free cell for the food; `random` is a [0, 1) source. */
const placeFood = (
  width: number,
  height: number,
  snake: readonly Cell[],
  random: () => number,
): Cell => {
  const free: Cell[] = [];
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1)
      if (!snake.some((cell) => cell.x === x && cell.y === y)) free.push({ x, y });
  if (free.length === 0) return snake[0] ?? { x: 0, y: 0 };
  return free[Math.min(free.length - 1, Math.floor(random() * free.length))] ?? free[0]!;
};

export const newSnakeGame = (width: number, height: number, random: () => number): SnakeGame => {
  const w = Math.max(8, width);
  const h = Math.max(4, height);
  const y = Math.floor(h / 2);
  const x = Math.floor(w / 2);
  const snake = [
    { x, y },
    { x: x - 1, y },
    { x: x - 2, y },
  ];
  return {
    width: w,
    height: h,
    snake,
    direction: "right",
    pending: null,
    food: placeFood(w, h, snake, random),
    score: 0,
    over: false,
  };
};

/** A turn is queued for the next tick; reversing into the body is ignored. */
export const turn = (game: SnakeGame, direction: Direction): SnakeGame => {
  if (game.over) return game;
  if (direction === OPPOSITE[game.direction] || direction === game.direction) return game;
  return { ...game, pending: direction };
};

/** One tick: move, eat or not, die on a wall or the body. */
export const tick = (game: SnakeGame, random: () => number): SnakeGame => {
  if (game.over) return game;
  const direction = game.pending ?? game.direction;
  const head = game.snake[0]!;
  const next = { x: head.x + STEP[direction].x, y: head.y + STEP[direction].y };
  const eats = same(next, game.food);
  // The tail moves out of the way unless the snake grows, so the last cell is not a collision.
  const body = eats ? game.snake : game.snake.slice(0, -1);
  const hitsWall = next.x < 0 || next.y < 0 || next.x >= game.width || next.y >= game.height;
  if (hitsWall || body.some((cell) => same(cell, next))) {
    return { ...game, direction, pending: null, over: true };
  }
  const snake = [next, ...body];
  return {
    ...game,
    snake,
    direction,
    pending: null,
    score: eats ? game.score + 1 : game.score,
    food: eats ? placeFood(game.width, game.height, snake, random) : game.food,
  };
};

/** The board as rows of characters. */
export const render = (game: SnakeGame): readonly string[] => {
  const rows: string[][] = [];
  for (let y = 0; y < game.height; y += 1) rows.push(Array.from({ length: game.width }, () => "·"));
  rows[game.food.y]![game.food.x] = "●";
  game.snake.forEach((cell, index) => {
    rows[cell.y]![cell.x] = index === 0 ? "◆" : "█";
  });
  return rows.map((row) => row.join(""));
};

import { describe, expect, it } from "vitest";

import { newSnakeGame, render, tick, turn, type SnakeGame } from "./snake-game.ts";

const zero = () => 0;

describe("snake", () => {
  it("starts three long, heading right, with food on a free cell", () => {
    const game = newSnakeGame(12, 6, zero);
    expect(game.snake).toHaveLength(3);
    expect(game.direction).toBe("right");
    expect(game.snake.some((cell) => cell.x === game.food.x && cell.y === game.food.y)).toBe(false);
    expect(render(game)).toHaveLength(6);
    expect(render(game)[3]).toContain("██◆");
  });

  it("moves one cell per tick and drops the tail", () => {
    const game = newSnakeGame(12, 6, zero);
    const next = tick(game, zero);
    expect(next.snake[0]).toEqual({ x: game.snake[0]!.x + 1, y: game.snake[0]!.y });
    expect(next.snake).toHaveLength(3);
    expect(next.score).toBe(0);
  });

  it("grows and scores on food, and places new food on a free cell", () => {
    let game = newSnakeGame(12, 6, zero);
    game = { ...game, food: { x: game.snake[0]!.x + 1, y: game.snake[0]!.y } };
    const next = tick(game, () => 0.5);
    expect(next.score).toBe(1);
    expect(next.snake).toHaveLength(4);
    expect(next.snake.some((cell) => cell.x === next.food.x && cell.y === next.food.y)).toBe(false);
  });

  it("takes one turn per tick and never reverses into itself", () => {
    const game = newSnakeGame(12, 6, zero);
    expect(turn(game, "left").pending).toBeNull();
    expect(turn(game, "right").pending).toBeNull();
    const turned = tick(turn(game, "up"), zero);
    expect(turned.direction).toBe("up");
    expect(turned.snake[0]).toEqual({ x: game.snake[0]!.x, y: game.snake[0]!.y - 1 });
  });

  it("wraps at the edges: out one side, in the other", () => {
    let game = newSnakeGame(8, 4, zero);
    // Heading right from x=4: three ticks reach x=7, the fourth wraps to x=0.
    for (let i = 0; i < 4; i += 1) game = tick(game, zero);
    expect(game.over).toBe(false);
    expect(game.snake[0]).toEqual({ x: 0, y: 2 });
    let up = tick(turn(newSnakeGame(8, 4, zero), "up"), zero);
    up = tick(up, zero);
    up = tick(up, zero);
    expect(up.snake[0]!.y).toBe(3);
    expect(up.over).toBe(false);
  });

  it("ends only on its own body, and then stays ended", () => {
    // A snake long enough to bite itself: down runs the head into the body.
    let long: SnakeGame = {
      ...newSnakeGame(12, 6, zero),
      snake: [
        { x: 6, y: 3 },
        { x: 5, y: 3 },
        { x: 4, y: 3 },
        { x: 4, y: 4 },
        { x: 5, y: 4 },
        { x: 6, y: 4 },
        { x: 7, y: 4 },
      ],
    };
    long = tick(turn(long, "down"), zero);
    expect(long.over).toBe(true);
    expect(tick(long, zero)).toBe(long);
    expect(turn(long, "up")).toBe(long);
  });
});

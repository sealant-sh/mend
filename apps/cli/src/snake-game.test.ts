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

  it("ends on a wall and on its own body, and then stays ended", () => {
    let game = newSnakeGame(8, 4, zero);
    for (let i = 0; i < 10; i += 1) game = tick(game, zero);
    expect(game.over).toBe(true);
    expect(tick(game, zero)).toBe(game);
    expect(turn(game, "up")).toBe(game);

    // A snake long enough to bite itself: down, left, up runs the head into the body.
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
  });
});

import { gatewayPage, type PreviewAnswer } from "./preview-requests.ts";

// No URL is embedded in the script: reopening location preserves the requested path and query.
const SNAKE = String.raw`(() => {
  const canvas = document.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const line = document.querySelector('main > p');
  const score = document.querySelector('#score');
  const play = document.querySelector('#play');
  const readyBar = document.querySelector('#ready');
  const open = () => location.reload();
  document.querySelector('#open').addEventListener('click', open);
  let state = 'idle', ready = false, points = 0, snake = [], food, direction, queued, turned = false;
  const size = 20, cell = canvas.width / size;
  const colors = () => getComputedStyle(document.documentElement);
  const placeFood = () => {
    const free = [];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (!snake.some(p => p.x === x && p.y === y)) free.push({x, y});
    }
    food = free[Math.floor(Math.random() * free.length)];
  };
  const draw = () => {
    const c = colors();
    ctx.fillStyle = c.getPropertyValue('--background'); ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = c.getPropertyValue('--border'); ctx.lineWidth = 0.5;
    for (let n = 0; n <= size; n++) {
      ctx.beginPath(); ctx.moveTo(n * cell, 0); ctx.lineTo(n * cell, canvas.height); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, n * cell); ctx.lineTo(canvas.width, n * cell); ctx.stroke();
    }
    ctx.fillStyle = c.getPropertyValue('--primary');
    snake.forEach(p => ctx.fillRect(p.x * cell + 2, p.y * cell + 2, cell - 4, cell - 4));
    if (food) { ctx.fillStyle = c.getPropertyValue('--foreground'); ctx.beginPath();
      ctx.arc((food.x + 0.5) * cell, (food.y + 0.5) * cell, cell / 4, 0, Math.PI * 2); ctx.fill(); }
    if (state !== 'playing') {
      ctx.fillStyle = c.getPropertyValue('--card'); ctx.fillRect(30, 36, 340, 68);
      ctx.fillStyle = c.getPropertyValue('--foreground'); ctx.font = '14px monospace'; ctx.textAlign = 'center';
      ctx.fillText(state === 'paused' ? 'Paused · Space to resume' : state === 'over' ? 'Game over · Play again' : 'A little Snake while you wait', 200, 75);
    }
  };
  const start = () => {
    state = 'playing'; points = 0; snake = [{x: 8, y: 10}, {x: 7, y: 10}, {x: 6, y: 10}];
    direction = {x: 1, y: 0}; queued = direction; turned = false;
    placeFood(); score.textContent = 'Score 0'; play.textContent = 'Pause'; canvas.focus(); draw();
  };
  const pause = () => { state = state === 'playing' ? 'paused' : 'playing'; play.textContent = state === 'paused' ? 'Resume' : 'Pause'; draw(); };
  play.addEventListener('click', () => state === 'idle' || state === 'over' ? start() : pause());
  const steer = (x, y) => {
    if (state === 'idle' || state === 'over') start();
    if (!turned && (x !== -direction.x || y !== -direction.y)) { queued = {x, y}; turned = true; }
  };
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && ready) { e.preventDefault(); open(); return; }
    const key = e.key.toLowerCase();
    const moves = {arrowup: [0,-1], w: [0,-1], arrowdown: [0,1], s: [0,1], arrowleft: [-1,0], a: [-1,0], arrowright: [1,0], d: [1,0]};
    if (moves[key]) { e.preventDefault(); steer(...moves[key]); }
    if (key === ' ') { e.preventDefault(); if (state === 'idle' || state === 'over') start(); else pause(); }
  });
  let touch;
  canvas.addEventListener('pointerdown', e => { touch = {x: e.clientX, y: e.clientY}; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointerup', e => {
    if (!touch) return;
    const dx = e.clientX - touch.x, dy = e.clientY - touch.y; touch = null;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 10) { if (state === 'idle' || state === 'over') start(); return; }
    if (Math.abs(dx) > Math.abs(dy)) steer(Math.sign(dx), 0); else steer(0, Math.sign(dy));
  });
  const tick = setInterval(() => {
    if (state !== 'playing') return;
    direction = queued; turned = false;
    const head = {x: snake[0].x + direction.x, y: snake[0].y + direction.y};
    const eats = food && head.x === food.x && head.y === food.y;
    const body = eats ? snake : snake.slice(0, -1);
    if (head.x < 0 || head.x >= size || head.y < 0 || head.y >= size || body.some(p => p.x === head.x && p.y === head.y)) {
      state = 'over'; play.textContent = 'Play again'; draw(); if (ready) open(); return;
    }
    snake.unshift(head);
    if (eats) { points++; score.textContent = 'Score ' + points; placeFood();
      if (!food) { state = 'over'; play.textContent = 'Play again'; if (ready) open(); }
    } else snake.pop();
    draw();
  }, 150);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', draw);
  draw();
  const fail = text => { line.textContent = text; readyBar.hidden = true; };
  const poll = async () => {
    try {
      const response = await fetch('/__mend/status', {credentials: 'same-origin', cache: 'no-store'});
      if (!response.ok) { fail('Preview status is unavailable. Open the preview again to retry.'); return; }
      const status = await response.json();
      if (status.state === 'failed') { fail(status.line); return; }
      if (status.state === 'ready') {
        ready = true; line.textContent = status.line;
        if (state === 'playing' || state === 'paused') readyBar.hidden = false; else open();
        return;
      }
      if (status.state !== 'starting' || typeof status.line !== 'string') { fail('Preview status is unavailable.'); return; }
      line.textContent = status.line;
    } catch { line.textContent = 'Preview status could not be reached. Retrying…'; }
    setTimeout(poll, 2000);
  };
  setTimeout(poll, 2000);
  addEventListener('pagehide', () => clearInterval(tick), {once: true});
})();`;

/** Self-contained gateway page; all networking is the admitted, same-origin status poll. */
export const startingPage = (line: string, back: string | null): PreviewAnswer => {
  const page = gatewayPage(503, line, back, {
    css: `main{max-width:480px}canvas{display:block;width:100%;height:auto;margin:18px 0 10px;border:1px solid var(--border);border-radius:8px;touch-action:none}canvas:focus-visible{outline:2px solid var(--ring);outline-offset:3px}button{font:inherit;color:var(--foreground);background:var(--background);border:1px solid var(--border);border-radius:6px;padding:6px 12px;cursor:pointer}.game-row{display:flex;justify-content:space-between;align-items:center;gap:12px;font:12px var(--font-mono)}.controls{margin-top:12px;color:var(--muted-foreground);font-size:11px}#ready{margin-top:16px;padding:12px;border:1px solid var(--primary);border-radius:8px}#ready button{margin-left:8px;color:var(--primary)}[hidden]{display:none!important}`,
    body: `<canvas width="400" height="400" tabindex="0" aria-label="Snake game. Use arrow keys or WASD, swipe on touch, Space to pause."></canvas><div class="game-row"><span id="score" aria-live="polite">Score 0</span><button id="play" type="button">Play Snake</button></div><p class="controls">Arrows / WASD / swipe to move · Space to pause</p><div id="ready" role="status" hidden>Preview is ready · <button id="open" type="button">Open</button><p class="controls">Enter to open, or finish your game.</p></div><noscript><p>Reload this page to check whether the preview has started.</p></noscript>`,
    script: SNAKE,
  });
  return { ...page, headers: { ...page.headers, "retry-after": "2" } };
};

'use strict';
// ============================================================
//  game.js — the match engine: input, physics, players, AI,
//  powers, drawing and the main loop.
//  Menus / shop / career / saving live in ui.js.
// ============================================================

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
canvas.width = CONFIG.W;
canvas.height = CONFIG.H;

const TAU = Math.PI * 2;
const STEP = 1 / 60;
const FONT = "'Luckiest Guy', Impact, 'Arial Black', sans-serif";
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);

// ------------------------------------------------------------
//  Sound — tiny synthesized effects, no audio files needed
// ------------------------------------------------------------
const Sound = {
  ctx: null,
  muted: false,
  init() {
    if (this.ctx) return;
    try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* no audio */ }
  },
  tone(freq, dur, type = 'sine', vol = 0.2, slide = 0) {
    if (this.muted || !this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.ctx.destination);
    o.start(t);
    o.stop(t + dur);
  },
  kick()    { this.tone(180, 0.12, 'triangle', 0.35, -120); },
  bounce()  { this.tone(320, 0.06, 'sine', 0.1, -120); },
  whistle() { this.tone(2100, 0.18, 'sine', 0.12); setTimeout(() => this.tone(2100, 0.4, 'sine', 0.12), 230); },
  goal()    { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this.tone(f, 0.25, 'square', 0.1), i * 110)); },
  power()   { this.tone(300, 0.45, 'sawtooth', 0.1, 900); },
  hit()     { this.tone(90, 0.35, 'square', 0.25, -50); },
  freeze()  { this.tone(1800, 0.5, 'triangle', 0.12, -1200); },
};

// ------------------------------------------------------------
//  Input
// ------------------------------------------------------------
const keys = {};
const touch = { left: false, right: false, jump: false, kick: false, power: false };

window.addEventListener('keydown', e => {
  keys[e.code] = true;
  if (Game.match && ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
});
window.addEventListener('keyup', e => { keys[e.code] = false; });
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

function readKeys(map, useTouch) {
  const inp = {};
  for (const action in map) inp[action] = map[action].some(code => keys[code]) || (useTouch && touch[action]);
  return inp;
}

// ------------------------------------------------------------
//  Player
// ------------------------------------------------------------
class Player {
  constructor(side, char, opts = {}) {
    this.side = side;                    // 0 = left, 1 = right
    this.dir = side === 0 ? 1 : -1;      // the direction this player attacks / faces
    this.char = char;
    this.name = opts.name || char.name;
    this.isAI = !!opts.ai;
    this.aiLevel = opts.aiLevel ?? 0.5;
    this.aiSpeedMul = 0.72 + 0.33 * this.aiLevel;
    this.aiCooldown = 0;
    this.keymap = opts.keymap || KEYMAP.solo;
    this.useTouch = !!opts.touch;
    this.powerType = opts.power || 'ice';

    // stats = base * (1 + effect * (character stat + shop upgrade level))
    const up = opts.upgrades || {};
    const mul = k => 1 + CONFIG.UPGRADE_EFFECT * ((char.stats[k] || 0) + (up[k] || 0));
    this.speed = CONFIG.PLAYER_SPEED * mul('speed');
    this.jumpV = CONFIG.JUMP_VELOCITY * mul('jump');
    this.kickPower = CONFIG.KICK_POWER * mul('kick');
    this.chargeMul = 1 + 0.15 * (up.charge || 0);
    this.baseR = CONFIG.HEAD_R * (char.headScale || 1);

    this.power = 0;                      // 0..100, kept between goals
    this.reset();
  }

  // back to kickoff position (after a goal)
  reset() {
    this.x = this.side === 0 ? CONFIG.W * 0.25 : CONFIG.W * 0.75;
    this.y = CONFIG.GROUND;              // y of the FEET
    this.vx = 0;
    this.vy = 0;
    this.onGround = true;
    this.kickT = 0;
    this.kickHit = false;
    this.frozen = 0;
    this.stunned = 0;
    this.squash = 0;
    this.giant = 0;
    this.charged = false;
    this.r = this.baseR;
    this.input = {};
  }

  get headX() { return this.x; }
  get headY() { return this.y - CONFIG.NECK - this.r; }

  // 0 at rest -> 1 at full swing -> back to 0
  get swing() { return this.kickT > 0 ? Math.sin(Math.PI * (1 - this.kickT / CONFIG.KICK_FRAMES)) : 0; }

  get foot() {
    const s = this.swing;
    return {
      x: this.x + this.dir * (this.r * 0.35 + 42 * s),
      y: this.y - CONFIG.FOOT_R - 36 * s,
      r: CONFIG.FOOT_R,
    };
  }

  get disabled() { return this.frozen > 0 || this.stunned > 0; }

  update(m) {
    const inp = this.input;

    // effect timers
    this.frozen = Math.max(0, this.frozen - STEP);
    this.stunned = Math.max(0, this.stunned - STEP);
    this.squash = Math.max(0, this.squash - STEP);
    this.giant = Math.max(0, this.giant - STEP);
    const targetR = this.baseR * (this.giant > 0 ? POWERS.giant.scale : 1);
    this.r += (targetR - this.r) * 0.12;

    if (m.state === 'play') this.power = Math.min(100, this.power + CONFIG.POWER_FILL_PER_SEC * STEP * this.chargeMul);

    if (!this.disabled) {
      const move = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
      this.vx = move * this.speed * (this.isAI ? this.aiSpeedMul : 1);
      if (inp.jump && this.onGround) { this.vy = -this.jumpV; this.onGround = false; }
      if (inp.kick && this.kickT <= 0) { this.kickT = CONFIG.KICK_FRAMES; this.kickHit = false; }
      if (inp.power && this.power >= 100) m.activatePower(this);
    } else {
      this.vx *= 0.8;
    }
    if (this.kickT > 0) this.kickT--;

    // gravity + movement
    const prevY = this.y;
    const prevHeadTop = this.headY - this.r;
    this.vy += CONFIG.GRAVITY;
    this.x += this.vx;
    this.y += this.vy;
    this.onGround = false;

    if (this.y >= CONFIG.GROUND) { this.y = CONFIG.GROUND; this.vy = 0; this.onGround = true; }

    // crossbars: stand on top, bump head underneath
    for (const bar of m.bars) {
      const overX = this.x + this.r * 0.7 > bar.x0 && this.x - this.r * 0.7 < bar.x1;
      if (!overX) continue;
      if (this.vy >= 0 && prevY <= bar.y0 && this.y >= bar.y0) {
        this.y = bar.y0; this.vy = 0; this.onGround = true;
      }
      const headTop = this.headY - this.r;
      if (prevHeadTop >= bar.y1 && headTop < bar.y1) {
        this.y += bar.y1 - headTop;
        this.vy = Math.max(this.vy, 0);
      }
    }

    this.x = clamp(this.x, this.r, CONFIG.W - this.r);
  }
}

// ------------------------------------------------------------
//  Ball
// ------------------------------------------------------------
class Ball {
  constructor() {
    this.r = CONFIG.BALL_R;
    this.reset();
  }

  reset() {
    this.x = CONFIG.W / 2;
    this.y = CONFIG.GROUND - 330;
    this.vx = rand(-1, 1);
    this.vy = 0;
    this.angle = 0;
    this.thunder = null;      // the player who fired a thunder shot, while it's flying
    this.trail = [];
  }

  update(m) {
    const thunder = !!this.thunder;
    if (!thunder) {
      this.vy += CONFIG.GRAVITY * CONFIG.BALL_GRAVITY_MUL;
      this.vx *= CONFIG.BALL_AIR_DRAG;
      this.vy *= CONFIG.BALL_AIR_DRAG;
      const sp = Math.hypot(this.vx, this.vy);
      if (sp > CONFIG.BALL_MAX_SPEED) { this.vx *= CONFIG.BALL_MAX_SPEED / sp; this.vy *= CONFIG.BALL_MAX_SPEED / sp; }
    }
    this.x += this.vx;
    this.y += this.vy;

    let bounced = false;
    const B = CONFIG.BALL_BOUNCE;

    // ground
    if (this.y + this.r > CONFIG.GROUND) {
      this.y = CONFIG.GROUND - this.r;
      if (this.vy > 0) {
        if (this.vy > 3) Sound.bounce();
        this.vy = -this.vy * B;
        if (Math.abs(this.vy) < 1.2) this.vy = 0;
        bounced = true;
      }
      this.vx *= CONFIG.BALL_GROUND_FRICTION;
    }
    // ceiling + side walls
    if (this.y - this.r < 0) { this.y = this.r; this.vy = Math.abs(this.vy) * B; bounced = true; }
    if (this.x - this.r < 0) { this.x = this.r; this.vx = Math.abs(this.vx) * B; bounced = true; }
    if (this.x + this.r > CONFIG.W) { this.x = CONFIG.W - this.r; this.vx = -Math.abs(this.vx) * B; bounced = true; }

    // crossbars
    for (const bar of m.bars) {
      const n = circleVsRect(this, bar.x0, bar.y0, bar.x1, bar.y1, B);
      if (n) {
        bounced = true;
        Sound.bounce();
        // don't let the ball rest on top of the goal forever: roll it back to the pitch
        if (n.ny < -0.7 && Math.abs(this.vx) < 0.6) this.vx += bar.x0 === 0 ? 0.4 : -0.4;
      }
    }

    if (bounced && thunder) this.thunder = null;

    this.angle += this.vx / this.r;
    if (this.thunder) this.trail.push({ x: this.x, y: this.y });
    if (this.trail.length > 14 || (!this.thunder && this.trail.length)) this.trail.shift();
  }
}

// Push a circle out of an axis-aligned rect and bounce it. Returns the normal or null.
function circleVsRect(b, x0, y0, x1, y1, bounce) {
  const cx = clamp(b.x, x0, x1);
  const cy = clamp(b.y, y0, y1);
  const dx = b.x - cx, dy = b.y - cy;
  const d = Math.hypot(dx, dy);
  if (d >= b.r) return null;
  const nx = d === 0 ? 0 : dx / d;
  const ny = d === 0 ? -1 : dy / d;
  b.x = cx + nx * b.r;
  b.y = cy + ny * b.r;
  const vn = b.vx * nx + b.vy * ny;
  if (vn < 0) { b.vx -= (1 + bounce) * vn * nx; b.vy -= (1 + bounce) * vn * ny; }
  return { nx, ny };
}

// Ball vs a moving circle (head or foot). Returns true on contact.
function ballVsCircle(b, cx, cy, cr, cvx, cvy, bounce) {
  const dx = b.x - cx, dy = b.y - cy;
  const d = Math.hypot(dx, dy);
  const min = b.r + cr;
  if (d >= min || d === 0) return false;
  const nx = dx / d, ny = dy / d;
  b.x = cx + nx * min;
  b.y = cy + ny * min;
  const rvx = b.vx - cvx, rvy = b.vy - cvy;
  const vn = rvx * nx + rvy * ny;
  if (vn < 0) { b.vx -= (1 + bounce) * vn * nx; b.vy -= (1 + bounce) * vn * ny; }
  return true;
}

// ------------------------------------------------------------
//  AI — "stand behind the ball, jump for headers, kick when close"
//  level 0..1 controls reaction time, prediction, accuracy and speed
// ------------------------------------------------------------
function aiThink(p, m) {
  // slower AIs only re-think every few frames (reaction time)
  if (p.aiCooldown > 0) { p.aiCooldown--; return p.input; }
  p.aiCooldown = Math.round((1 - p.aiLevel) * 8);

  const b = m.ball, L = p.aiLevel, d = p.dir;
  const inp = { left: false, right: false, jump: false, kick: false, power: false };
  if (p.disabled) return inp;

  const look = 6 + 14 * L;                                   // frames of prediction
  const bx = clamp(b.x + b.vx * look, 0, CONFIG.W);
  const ownGoalX = p.side === 0 ? 0 : CONFIG.W;
  const ballInFront = (b.x - p.x) * d > -10;                 // ball between me and their goal?

  let tx = ballInFront
    ? bx - d * (p.r * 0.6 + b.r)                             // get just behind the ball
    : bx - d * (p.r * 2 + 40);                               // ball is behind me: run back past it
  // when the ball is far away, drift back toward my own goal
  if (Math.abs(b.x - p.x) > CONFIG.W * 0.45) tx = tx * 0.7 + (ownGoalX + d * 260) * 0.3;

  const dead = 6 + (1 - L) * 14;
  const dx = tx - p.x;
  if (dx > dead) inp.right = true;
  else if (dx < -dead) inp.left = true;

  const distX = Math.abs(b.x - p.x);
  const above = p.headY - b.y;                               // >0 = ball is above my head
  if (ballInFront && distX < p.r + 60 && above > 10 && above < 170 && b.vy > -4 && Math.random() < 0.15 + 0.4 * L) inp.jump = true;
  if (!ballInFront && distX < p.r + 50 && b.y > p.headY && Math.random() < 0.3) inp.jump = true;   // hop over it

  const f = p.foot;
  if (ballInFront && Math.hypot(b.x - f.x, b.y - f.y) < 90 && Math.random() < 0.25 + 0.6 * L) inp.kick = true;

  if (p.power >= 100 && Math.random() < 0.004 + 0.02 * L) {
    if (p.powerType !== 'lightning' || (ballInFront && distX < 220)) inp.power = true;
  }
  return inp;
}

// ------------------------------------------------------------
//  Match
// ------------------------------------------------------------
class Match {
  constructor({ mode, players, onEnd }) {
    this.mode = mode;                       // 'quick' | 'career' | '2p'
    this.players = players;
    this.onEnd = onEnd;
    this.ball = new Ball();
    this.score = [0, 0];
    this.time = CONFIG.MATCH_SECONDS;
    this.state = 'countdown';               // countdown | play | goal | over
    this.stateT = CONFIG.START_COUNTDOWN;
    this.shortCountdown = false;
    this.ended = false;
    this.anvils = [];
    this.particles = [];
    this.banners = [];
    this.shake = 0;
    this.frame = 0;

    const top = CONFIG.GROUND - CONFIG.GOAL_HEIGHT;
    this.bars = [
      { x0: 0, x1: CONFIG.GOAL_DEPTH, y0: top - CONFIG.CROSSBAR_THICK, y1: top },
      { x0: CONFIG.W - CONFIG.GOAL_DEPTH, x1: CONFIG.W, y0: top - CONFIG.CROSSBAR_THICK, y1: top },
    ];
  }

  other(p) { return this.players[0] === p ? this.players[1] : this.players[0]; }

  step() {
    this.frame++;
    this.stateT -= STEP;

    // ---- inputs
    for (const p of this.players) {
      if (this.state !== 'play') p.input = {};
      else p.input = p.isAI ? aiThink(p, this) : readKeys(p.keymap, p.useTouch);
    }

    // ---- state machine
    if (this.state === 'countdown' && this.stateT <= 0) {
      this.state = 'play';
      this.banner('GO!', 0.7, true);
      Sound.whistle();
    } else if (this.state === 'play') {
      this.time -= STEP;
      if (this.time <= 0) { this.time = 0; this.finish(); }
    } else if (this.state === 'goal' && this.stateT <= 0) {
      for (const p of this.players) p.reset();
      this.ball.reset();
      this.anvils = [];
      this.state = 'countdown';
      this.stateT = 1.2;
      this.shortCountdown = true;
    } else if (this.state === 'over' && this.stateT <= 0 && !this.ended) {
      this.ended = true;
      this.onEnd({ score: this.score.slice() });
    }

    // ---- world
    for (const p of this.players) p.update(this);
    this.collidePlayers();
    if (this.state !== 'countdown') this.ball.update(this);
    for (const p of this.players) this.collideBall(p);
    if (this.ball.y > CONFIG.GROUND - this.ball.r) this.ball.y = CONFIG.GROUND - this.ball.r;
    if (this.state === 'play') this.checkGoal();
    this.updateAnvils();

    for (const pt of this.particles) {
      pt.vy += pt.g; pt.x += pt.vx; pt.y += pt.vy; pt.life -= STEP;
    }
    this.particles = this.particles.filter(pt => pt.life > 0);
    for (const bn of this.banners) bn.t -= STEP;
    this.banners = this.banners.filter(bn => bn.t > 0);
    this.shake *= 0.88;
  }

  collidePlayers() {
    const [a, b] = this.players;
    const dx = b.x - a.x, dy = b.headY - a.headY;
    const d = Math.hypot(dx, dy), min = a.r + b.r;
    if (d >= min || d === 0) return;
    const nx = dx / d, ny = dy / d, overlap = min - d;
    if (Math.abs(ny) > 0.7) {
      // one head is on top of the other -> stand on it
      const top = ny > 0 ? a : b;
      top.y -= overlap * Math.abs(ny);
      if (top.vy > 0) top.vy = 0;
      top.onGround = true;
    }
    a.x -= nx * overlap / 2;
    b.x += nx * overlap / 2;
  }

  collideBall(p) {
    const b = this.ball;
    if (this.state === 'countdown') return;

    // a flying thunder shot ignores everyone, and flattens the defender
    if (b.thunder) {
      if (p !== b.thunder && Math.hypot(b.x - p.headX, b.y - p.headY) < b.r + p.r && p.stunned <= 0) {
        p.stunned = CONFIG.STUN_SECONDS;
        Sound.hit();
        this.burst(p.headX, p.headY, 18, '#ffe066', 6);
      }
      return;
    }

    if (ballVsCircle(b, p.headX, p.headY, p.r, p.vx, p.vy, CONFIG.HEAD_BOUNCE)) this.touch(p);

    const f = p.foot;
    const swinging = p.kickT > CONFIG.KICK_FRAMES * 0.25 && !p.kickHit;
    if (swinging && Math.hypot(b.x - f.x, b.y - f.y) < f.r + b.r + CONFIG.KICK_REACH) {
      p.kickHit = true;
      if (p.charged) {
        this.thunderShot(p);
      } else {
        const lift = b.y > f.y - 4 ? 0.75 : 0.45;    // low balls get lifted more
        b.vx = p.dir * p.kickPower + p.vx * 0.4;
        b.vy = -p.kickPower * lift + Math.min(0, p.vy) * 0.3;
      }
      Sound.kick();
      this.burst(b.x, b.y, 8, '#ffffff', 3);
      this.touch(p);
    } else if (ballVsCircle(b, f.x, f.y, f.r, p.vx, p.vy, CONFIG.FOOT_BOUNCE)) {
      this.touch(p);
    }
  }

  // touching the ball charges the power meter (at most once every 15 frames)
  touch(p) {
    if (this.state === 'play' && this.frame - (p.lastTouch ?? -99) > 15) {
      p.power = Math.min(100, p.power + CONFIG.POWER_FILL_PER_TOUCH * p.chargeMul);
    }
    p.lastTouch = this.frame;
  }

  thunderShot(p) {
    const b = this.ball;
    p.charged = false;
    b.thunder = p;
    const gx = p.side === 0 ? CONFIG.W - CONFIG.GOAL_DEPTH / 2 : CONFIG.GOAL_DEPTH / 2;
    const gy = CONFIG.GROUND - CONFIG.GOAL_HEIGHT * 0.45;
    const dx = gx - b.x, dy = gy - b.y, d = Math.hypot(dx, dy) || 1;
    b.vx = dx / d * CONFIG.THUNDER_SPEED;
    b.vy = dy / d * CONFIG.THUNDER_SPEED;
    this.shake = 8;
    Sound.power();
  }

  activatePower(p) {
    const opp = this.other(p);
    const pw = POWERS[p.powerType];
    p.power = 0;
    Sound.power();
    this.banner(`${pw.icon} ${p.name}: ${pw.name}!`, 1.4, false);
    switch (p.powerType) {
      case 'ice':
        opp.frozen = pw.duration;
        Sound.freeze();
        this.burst(opp.headX, opp.headY, 30, '#a8e6ff', 5);
        break;
      case 'lightning':
        p.charged = true;
        break;
      case 'anvil':
        this.anvils.push({ x: opp.x, y: -60, vy: 0, target: opp, done: false });
        break;
      case 'giant':
        p.giant = pw.duration;
        break;
    }
  }

  updateAnvils() {
    for (const a of this.anvils) {
      const t = a.target;
      a.vy += 0.6;
      a.y += a.vy;
      if (a.y < t.headY - t.r - 40) a.x += (t.x - a.x) * 0.25;  // follows the target until just above its head
      if (!a.done && Math.abs(a.x - t.x) < t.r + 22 && a.y + 22 > t.headY - t.r && a.y < t.headY) {
        a.done = true;
        t.stunned = POWERS.anvil.duration;
        t.squash = POWERS.anvil.duration;
        Sound.hit();
        this.shake = 10;
        this.burst(a.x, a.y + 20, 20, '#bbbbbb', 5);
      }
      if (a.y > CONFIG.GROUND) { a.done = true; this.burst(a.x, CONFIG.GROUND, 10, '#c2a477', 3); }
    }
    this.anvils = this.anvils.filter(a => !a.done);
  }

  checkGoal() {
    const b = this.ball;
    if (b.y < CONFIG.GROUND - CONFIG.GOAL_HEIGHT) return;     // above the crossbar
    if (b.x + b.r < CONFIG.GOAL_DEPTH) this.goal(1);
    else if (b.x - b.r > CONFIG.W - CONFIG.GOAL_DEPTH) this.goal(0);
  }

  goal(scorer) {
    this.score[scorer]++;
    this.state = 'goal';
    this.stateT = CONFIG.GOAL_PAUSE;
    this.ball.thunder = null;
    this.shake = 14;
    this.banner('GOAL!', CONFIG.GOAL_PAUSE, true);
    Sound.goal();
    const colors = ['#ffd166', '#ef476f', '#06d6a0', '#118ab2', '#ffffff'];
    for (let i = 0; i < 70; i++) this.burst(this.ball.x, this.ball.y, 1, colors[i % colors.length], 9);
  }

  finish() {
    this.state = 'over';
    this.stateT = 1.8;
    this.banner('FULL TIME', 1.8, true);
    Sound.whistle();
  }

  banner(text, t, big) { this.banners.push({ text, t, max: t, big }); }

  burst(x, y, n, color, speed) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU), s = rand(0.3, 1) * speed;
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 2, g: 0.2, life: rand(0.4, 1), color, size: rand(2, 5) });
    }
  }

  // ---------------- drawing ----------------
  draw() {
    const g = ctx;
    g.save();
    if (this.shake > 0.5) g.translate(rand(-this.shake, this.shake), rand(-this.shake, this.shake));
    g.drawImage(bgCanvas, 0, 0);

    drawGoalBack(g, 0);
    drawGoalBack(g, 1);
    for (const p of this.players) drawShadow(g, p.x, p.y, p.r);
    drawShadow(g, this.ball.x, this.ball.y + this.ball.r, this.ball.r * 0.8);

    for (const p of this.players) drawPlayer(g, p, this.ball.x, this.ball.y, this.frame);
    drawBall(g, this.ball);
    drawGoalFront(g, 0);
    drawGoalFront(g, 1);
    for (const a of this.anvils) drawAnvil(g, a.x, a.y);

    for (const pt of this.particles) {
      g.globalAlpha = clamp(pt.life, 0, 1);
      g.fillStyle = pt.color;
      g.fillRect(pt.x, pt.y, pt.size, pt.size);
    }
    g.globalAlpha = 1;
    g.restore();

    this.drawHUD(g);
  }

  drawHUD(g) {
    const W = CONFIG.W;
    // scoreboard
    g.fillStyle = 'rgba(12, 20, 45, 0.88)';
    roundRect(g, W / 2 - 130, 10, 260, 84, 16);
    g.fill();
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#fff';
    g.font = `44px ${FONT}`;
    g.fillText(`${this.score[0]} - ${this.score[1]}`, W / 2, 46);
    const secs = Math.ceil(this.time);
    g.font = `22px ${FONT}`;
    g.fillStyle = secs <= 10 && this.state === 'play' ? '#ff6b6b' : '#ffd166';
    g.fillText(`${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`, W / 2, 80);

    // names + power bars
    this.players.forEach((p, i) => {
      const left = i === 0;
      const bx = left ? 24 : W - 24 - 300;
      g.fillStyle = 'rgba(12, 20, 45, 0.75)';
      roundRect(g, bx, 14, 300, 66, 14);
      g.fill();
      g.textAlign = left ? 'left' : 'right';
      g.fillStyle = '#fff';
      g.font = `22px ${FONT}`;
      g.fillText(p.name, left ? bx + 14 : bx + 286, 34);

      const pw = POWERS[p.powerType];
      const full = p.power >= 100;
      const barX = bx + 52, barY = 50, barW = 232, barH = 18;
      g.font = '24px sans-serif';
      g.textAlign = 'center';
      g.fillText(pw.icon, bx + 28, barY + 10);
      g.fillStyle = 'rgba(255,255,255,0.15)';
      roundRect(g, barX, barY, barW, barH, 9);
      g.fill();
      const pulse = full ? 0.6 + 0.4 * Math.sin(this.frame * 0.25) : 1;
      g.fillStyle = full ? `rgba(255, 209, 102, ${pulse})` : '#4cc9f0';
      roundRect(g, barX, barY, Math.max(barH, barW * p.power / 100), barH, 9);
      g.fill();
      if (full && !p.isAI) {
        g.fillStyle = '#1a1a2e';
        g.font = `14px ${FONT}`;
        g.fillText(p.charged ? 'CHARGED!' : `READY! press ${p.keymap.power.map(keyLabel).join(' / ')}`, barX + barW / 2, barY + 10);
      } else if (p.charged) {
        g.fillStyle = '#fff';
        g.font = `14px ${FONT}`;
        g.fillText('CHARGED - KICK!', barX + barW / 2, barY + 10);
      }
    });

    // countdown / banners
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    if (this.state === 'countdown') {
      const txt = this.shortCountdown ? 'READY' : String(Math.ceil(this.stateT));
      bigText(g, txt, W / 2, 260, 96, 1);
    }
    let smallY = 130;
    for (const bn of this.banners) {
      const k = bn.t / bn.max;
      if (bn.big) {
        const pop = 1 + Math.max(0, (k - 0.8)) * 2.5;
        bigText(g, bn.text, W / 2, 260, 110 * pop, Math.min(1, bn.t * 3));
      } else {
        g.globalAlpha = Math.min(1, bn.t * 3);
        g.font = `28px ${FONT}`;
        g.fillStyle = '#fff';
        g.strokeStyle = 'rgba(0,0,0,0.6)';
        g.lineWidth = 5;
        g.strokeText(bn.text, W / 2, smallY);
        g.fillText(bn.text, W / 2, smallY);
        g.globalAlpha = 1;
        smallY += 36;
      }
    }
  }
}

function keyLabel(code) {
  return { ArrowDown: '↓', ArrowUp: '↑', ArrowLeft: '←', ArrowRight: '→', Space: 'SPACE' }[code] || code.replace('Key', '');
}

// ------------------------------------------------------------
//  Drawing helpers
// ------------------------------------------------------------
function roundRect(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function bigText(g, text, x, y, size, alpha) {
  g.save();
  g.globalAlpha = alpha;
  g.font = `${size}px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = size / 8;
  g.strokeStyle = '#1a1a2e';
  g.strokeText(text, x, y);
  const grad = g.createLinearGradient(0, y - size / 2, 0, y + size / 2);
  grad.addColorStop(0, '#fff3b0');
  grad.addColorStop(1, '#ff9f1c');
  g.fillStyle = grad;
  g.fillText(text, x, y);
  g.restore();
}

function drawShadow(g, x, feetY, r) {
  const h = CONFIG.GROUND - feetY;
  const k = clamp(1 - h / 400, 0.3, 1);
  g.fillStyle = `rgba(0,0,0,${0.25 * k})`;
  g.beginPath();
  g.ellipse(x, CONFIG.GROUND + 4, r * 0.9 * k, 7 * k, 0, 0, TAU);
  g.fill();
}

// --- goals ---
function goalRect(side) {
  const top = CONFIG.GROUND - CONFIG.GOAL_HEIGHT;
  return side === 0
    ? { x0: 0, x1: CONFIG.GOAL_DEPTH, top }
    : { x0: CONFIG.W - CONFIG.GOAL_DEPTH, x1: CONFIG.W, top };
}

function drawGoalBack(g, side) {
  const { x0, x1, top } = goalRect(side);
  g.save();
  g.fillStyle = 'rgba(255,255,255,0.06)';
  g.fillRect(x0, top, x1 - x0, CONFIG.GROUND - top);
  g.beginPath();
  g.rect(x0, top, x1 - x0, CONFIG.GROUND - top);
  g.clip();
  g.strokeStyle = 'rgba(255,255,255,0.45)';
  g.lineWidth = 1.5;
  for (let i = -300; i < 300; i += 14) {
    g.beginPath(); g.moveTo(x0 + i, top); g.lineTo(x0 + i + 250, top + 250); g.stroke();
    g.beginPath(); g.moveTo(x0 + i, top); g.lineTo(x0 + i - 250, top + 250); g.stroke();
  }
  g.restore();
  // back post
  g.fillStyle = '#d9d9d9';
  g.fillRect(side === 0 ? 0 : CONFIG.W - 6, top, 6, CONFIG.GROUND - top);
}

function drawGoalFront(g, side) {
  const { x0, x1, top } = goalRect(side);
  const t = CONFIG.CROSSBAR_THICK;
  g.fillStyle = 'rgba(0,0,0,0.25)';
  g.fillRect(x0, top + 2, x1 - x0, 4);
  g.fillStyle = '#ffffff';
  g.fillRect(x0, top - t, x1 - x0, t);
  // front post
  const px = side === 0 ? x1 - 8 : x0;
  g.fillRect(px, top - t, 8, CONFIG.GROUND - top + t);
  g.fillStyle = '#e63946';
  g.fillRect(px, top - t, 8, 8);
}

// --- ball ---
function drawBall(g, b) {
  for (let i = 0; i < b.trail.length; i++) {
    const t = b.trail[i], k = i / b.trail.length;
    g.fillStyle = `rgba(255, 230, 80, ${k * 0.5})`;
    g.beginPath(); g.arc(t.x, t.y, b.r * (0.4 + 0.6 * k), 0, TAU); g.fill();
  }
  g.save();
  g.translate(b.x, b.y);
  if (b.thunder) { g.shadowColor = '#ffe066'; g.shadowBlur = 30; }
  g.rotate(b.angle);
  g.fillStyle = '#ffffff';
  g.beginPath(); g.arc(0, 0, b.r, 0, TAU); g.fill();
  g.shadowBlur = 0;
  g.save();
  g.clip();
  g.fillStyle = '#222';
  pentagon(g, 0, 0, b.r * 0.38, 0);
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + i * TAU / 5;
    pentagon(g, Math.cos(a) * b.r * 1.0, Math.sin(a) * b.r * 1.0, b.r * 0.32, a + Math.PI);
  }
  g.restore();
  g.strokeStyle = '#333';
  g.lineWidth = 2;
  g.beginPath(); g.arc(0, 0, b.r, 0, TAU); g.stroke();
  g.restore();
}

function pentagon(g, x, y, r, rot) {
  g.beginPath();
  for (let i = 0; i < 5; i++) {
    const a = rot - Math.PI / 2 + i * TAU / 5;
    g.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  g.closePath();
  g.fill();
}

// --- anvil ---
function drawAnvil(g, x, y) {
  g.save();
  g.translate(x, y);
  g.fillStyle = '#4a4e69';
  g.beginPath();
  g.moveTo(-34, -14); g.lineTo(34, -14); g.lineTo(46, -22); g.lineTo(28, -2);
  g.lineTo(14, 4); g.lineTo(20, 22); g.lineTo(-20, 22); g.lineTo(-14, 4); g.lineTo(-34, -2);
  g.closePath();
  g.fill();
  g.fillStyle = '#6c757d';
  g.fillRect(-34, -14, 68, 5);
  g.restore();
}

// --- players ---
// Draws a character. Works on any canvas context (the shop previews use it too).
function drawPlayer(g, p, lookX, lookY, frame = 0) {
  const c = p.char, d = p.dir, r = p.r;
  const hx = p.headX, hy = p.headY;

  // shoe
  const f = p.foot;
  g.save();
  g.translate(f.x, f.y);
  g.scale(d, 1);
  g.rotate(-p.swing * 0.6);
  g.fillStyle = c.shoe;
  roundRect(g, -f.r - 4, -f.r * 0.7, f.r * 2 + 14, f.r * 1.5, 8);
  g.fill();
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.fillRect(-f.r + 2, f.r * 0.45, f.r * 2 + 6, 3);
  g.restore();

  // head (squashed by an anvil)
  g.save();
  if (p.squash > 0) {
    g.translate(hx, p.y - CONFIG.NECK);
    g.scale(1.25, 0.6);
    g.translate(-hx, -(p.y - CONFIG.NECK));
  }

  // shirt collar under the head
  g.fillStyle = c.shirt;
  g.beginPath();
  g.ellipse(hx - d * r * 0.05, hy + r * 0.88, r * 0.55, r * 0.32, 0, 0, TAU);
  g.fill();

  if (p.charged) {
    g.shadowColor = '#ffe066';
    g.shadowBlur = 25 + 10 * Math.sin(frame * 0.3);
  }

  if (c.hairStyle === 'robot') {
    drawRobotHead(g, p, hx, hy, r, d, lookX, lookY);
  } else {
    drawHair(g, p, hx, hy, r, d, true);
    g.fillStyle = c.skin;
    g.beginPath(); g.arc(hx, hy, r, 0, TAU); g.fill();
    g.shadowBlur = 0;
    g.strokeStyle = 'rgba(0,0,0,0.25)';
    g.lineWidth = 2;
    g.stroke();
    // ear
    g.fillStyle = c.skin;
    g.beginPath(); g.ellipse(hx - d * r * 0.3, hy + r * 0.05, r * 0.14, r * 0.2, 0, 0, TAU); g.fill(); g.stroke();
    drawHair(g, p, hx, hy, r, d, false);
    drawFace(g, p, hx, hy, r, d, lookX, lookY);
  }
  g.shadowBlur = 0;
  g.restore();

  // frozen
  if (p.frozen > 0) {
    g.fillStyle = 'rgba(160, 225, 255, 0.55)';
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.lineWidth = 3;
    roundRect(g, hx - r - 12, hy - r - 12, r * 2 + 24, p.y - hy + r + 14, 12);
    g.fill();
    g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.7)';
    g.fillRect(hx - r, hy - r, 8, r);
  }
  // stunned stars
  if (p.stunned > 0) {
    for (let i = 0; i < 3; i++) {
      const a = frame * 0.12 + i * TAU / 3;
      g.fillStyle = '#ffd166';
      g.font = '22px sans-serif';
      g.textAlign = 'center';
      g.fillText('★', hx + Math.cos(a) * r * 0.8, hy - r - 12 + Math.sin(a) * 8);
    }
  }
}

function drawHair(g, p, hx, hy, r, d, behind) {
  const st = p.char.hairStyle;
  g.fillStyle = p.char.hair;
  if (behind) {
    if (st === 'afro') { g.beginPath(); g.arc(hx - d * r * 0.15, hy - r * 0.25, r * 1.2, 0, TAU); g.fill(); }
    if (st === 'long') { g.beginPath(); g.ellipse(hx - d * r * 0.45, hy + r * 0.15, r * 0.7, r * 1.05, 0, 0, TAU); g.fill(); }
    if (st === 'spiky' || st === 'mohawk') {
      const [from, to, n, len] = st === 'spiky' ? [-0.95, -0.15, 6, 0.5] : [-0.65, -0.35, 4, 0.7];
      for (let i = 0; i < n; i++) {
        let a = Math.PI * (from + (to - from) * i / (n - 1));
        if (d < 0) a = -Math.PI - a;
        g.beginPath();
        g.moveTo(hx + Math.cos(a - 0.2) * r * 0.9, hy + Math.sin(a - 0.2) * r * 0.9);
        g.lineTo(hx + Math.cos(a) * r * (1 + len), hy + Math.sin(a) * r * (1 + len));
        g.lineTo(hx + Math.cos(a + 0.2) * r * 0.9, hy + Math.sin(a + 0.2) * r * 0.9);
        g.fill();
      }
    }
    return;
  }
  // in front: a "cap" of hair clipped to the head
  g.save();
  g.beginPath(); g.arc(hx, hy, r, 0, TAU); g.clip();
  if (st === 'short' || st === 'spiky' || st === 'long' || st === 'afro') {
    g.beginPath(); g.ellipse(hx - d * r * 0.25, hy - r * 0.78, r * 1.1, r * 0.55, 0, 0, TAU); g.fill();
    g.beginPath(); g.ellipse(hx - d * r * 0.9, hy - r * 0.2, r * 0.45, r * 0.85, 0, 0, TAU); g.fill();
  } else if (st === 'mohawk') {
    g.fillRect(hx - r * 0.2 - d * r * 0.1, hy - r, r * 0.4, r * 0.4);
  } else if (st === 'bald') {
    g.fillStyle = 'rgba(255,255,255,0.25)';
    g.beginPath(); g.ellipse(hx - d * r * 0.2, hy - r * 0.6, r * 0.3, r * 0.15, -0.4 * d, 0, TAU); g.fill();
  }
  g.restore();
}

function drawFace(g, p, hx, hy, r, d, lookX, lookY) {
  const angry = p.kickT > 0 || p.charged;
  const ey = hy - r * 0.1, er = r * 0.19;
  let lx = lookX - hx, ly = lookY - hy;
  const ll = Math.hypot(lx, ly) || 1;
  lx = lx / ll * er * 0.45;
  ly = ly / ll * er * 0.45;

  for (const ex of [hx + d * r * 0.18, hx + d * r * 0.6]) {
    g.fillStyle = '#fff';
    g.beginPath(); g.ellipse(ex, ey, er * 0.8, er, 0, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.3)'; g.lineWidth = 1.5; g.stroke();
    g.fillStyle = '#1a1a2e';
    const shut = p.stunned > 0;
    if (shut) {
      g.font = `${er * 1.6}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('×', ex, ey);
    } else {
      g.beginPath(); g.arc(ex + lx, ey + ly, er * 0.45, 0, TAU); g.fill();
    }
    // eyebrow
    g.strokeStyle = p.char.hair === '#cdeffd' ? '#8aa' : '#2b1d14';
    g.lineWidth = r * 0.07;
    g.beginPath();
    const tilt = angry ? r * 0.08 : 0;
    g.moveTo(ex - er * 0.9, ey - er * 1.25 - (d > 0 ? 0 : tilt));
    g.lineTo(ex + er * 0.9, ey - er * 1.25 - (d > 0 ? tilt : 0) + (angry ? r * 0.06 : 0));
    g.stroke();
  }
  // nose
  g.fillStyle = 'rgba(0,0,0,0.12)';
  g.beginPath(); g.ellipse(hx + d * r * 0.85, hy + r * 0.15, r * 0.12, r * 0.1, 0, 0, TAU); g.fill();
  // mouth
  const mx = hx + d * r * 0.45, my = hy + r * 0.45;
  g.fillStyle = '#7a1f1f';
  g.strokeStyle = '#5a1515';
  g.lineWidth = r * 0.06;
  if (angry || !p.onGround) {
    g.beginPath(); g.ellipse(mx, my, r * 0.14, r * 0.12, 0, 0, TAU); g.fill();
  } else {
    g.beginPath(); g.arc(mx, my - r * 0.12, r * 0.2, 0.2 * Math.PI, 0.8 * Math.PI); g.stroke();
  }
}

function drawRobotHead(g, p, hx, hy, r, d, lookX, lookY) {
  // antenna
  g.strokeStyle = '#6c757d'; g.lineWidth = 4;
  g.beginPath(); g.moveTo(hx, hy - r * 0.9); g.lineTo(hx, hy - r * 1.35); g.stroke();
  g.fillStyle = p.char.hair;
  g.beginPath(); g.arc(hx, hy - r * 1.4, r * 0.13, 0, TAU); g.fill();
  // head box
  const grad = g.createLinearGradient(hx - r, hy - r, hx + r, hy + r);
  grad.addColorStop(0, '#dee2e6');
  grad.addColorStop(1, '#6c757d');
  g.fillStyle = grad;
  roundRect(g, hx - r * 0.95, hy - r * 0.95, r * 1.9, r * 1.9, r * 0.35);
  g.fill();
  g.shadowBlur = 0;
  g.strokeStyle = '#343a40'; g.lineWidth = 2; g.stroke();
  // visor + eye
  g.fillStyle = '#1a1a2e';
  roundRect(g, hx - r * 0.75 + d * r * 0.1, hy - r * 0.35, r * 1.5, r * 0.5, r * 0.2);
  g.fill();
  const ex = clamp(hx + d * r * 0.3 + (lookX - hx) * 0.02, hx - r * 0.5, hx + r * 0.6);
  g.fillStyle = p.stunned > 0 ? '#555' : p.char.hair;
  g.shadowColor = p.char.hair; g.shadowBlur = 12;
  g.beginPath(); g.arc(ex, hy - r * 0.1 + clamp((lookY - hy) * 0.01, -4, 4), r * 0.14, 0, TAU); g.fill();
  g.shadowBlur = 0;
  // grille mouth
  g.fillStyle = '#495057';
  for (let i = 0; i < 4; i++) g.fillRect(hx - r * 0.3 + d * r * 0.2 + i * r * 0.17, hy + r * 0.4, r * 0.09, r * 0.25);
}

// ------------------------------------------------------------
//  Stadium background (drawn once to an offscreen canvas)
// ------------------------------------------------------------
const bgCanvas = document.createElement('canvas');
bgCanvas.width = CONFIG.W;
bgCanvas.height = CONFIG.H;

function buildBackground() {
  const g = bgCanvas.getContext('2d');
  const W = CONFIG.W, H = CONFIG.H;
  const standTop = 150, boardY = 420, grassY = 452;

  // sky
  const sky = g.createLinearGradient(0, 0, 0, standTop + 60);
  sky.addColorStop(0, '#0b1a3a');
  sky.addColorStop(1, '#2d4f8f');
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);

  // floodlights
  for (const x of [400, W - 400]) {     // kept clear of the HUD panels in the corners
    g.strokeStyle = '#555c6b'; g.lineWidth = 8;
    g.beginPath(); g.moveTo(x, 70); g.lineTo(x, standTop + 20); g.stroke();
    const glow = g.createRadialGradient(x, 50, 5, x, 50, 160);
    glow.addColorStop(0, 'rgba(255,255,220,0.9)');
    glow.addColorStop(1, 'rgba(255,255,220,0)');
    g.fillStyle = glow;
    g.fillRect(x - 160, 0, 320, 220);
    g.fillStyle = '#fffbe0';
    g.fillRect(x - 40, 35, 80, 30);
  }

  // stands
  g.fillStyle = '#23263a';
  g.fillRect(0, standTop, W, boardY - standTop);
  for (let y = standTop; y < boardY; y += 45) {
    g.fillStyle = 'rgba(255,255,255,0.04)';
    g.fillRect(0, y, W, 3);
  }
  // crowd
  const shirts = ['#e63946', '#f1faee', '#a8dadc', '#457b9d', '#ffb703', '#2a9d8f', '#e76f51', '#8338ec'];
  const skins = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac'];
  for (let y = standTop + 18; y < boardY - 6; y += 17) {
    for (let x = 4 + ((y / 17) % 2) * 7; x < W; x += 14) {
      if (Math.random() < 0.12) continue;
      g.fillStyle = shirts[(Math.random() * shirts.length) | 0];
      g.fillRect(x - 5, y, 10, 9);
      g.fillStyle = skins[(Math.random() * skins.length) | 0];
      g.beginPath(); g.arc(x, y - 3, 4.5, 0, TAU); g.fill();
    }
  }

  // advertising boards
  const ads = ['HEAD SOCCER ARENA', 'BIG HEADS FC', 'KICK IT!', 'GOAL TV'];
  const adColors = ['#e63946', '#1d3557', '#ffb703', '#2a9d8f'];
  for (let i = 0, x = 0; x < W; i++, x += 220) {
    g.fillStyle = adColors[i % adColors.length];
    g.fillRect(x, boardY, 220, grassY - boardY);
    g.fillStyle = '#fff';
    g.font = `18px ${FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(ads[i % ads.length], x + 110, boardY + 17);
  }

  // grass
  const grass = g.createLinearGradient(0, grassY, 0, H);
  grass.addColorStop(0, '#3a8f3a');
  grass.addColorStop(1, '#2f7d2f');
  g.fillStyle = grass;
  g.fillRect(0, grassY, W, H - grassY);
  for (let x = 0; x < W; x += 160) {
    g.fillStyle = 'rgba(255,255,255,0.05)';
    g.fillRect(x, grassY, 80, H - grassY);
  }
  // pitch lines
  g.strokeStyle = 'rgba(255,255,255,0.65)';
  g.lineWidth = 3;
  g.beginPath(); g.moveTo(0, grassY + 18); g.lineTo(W, grassY + 18); g.stroke();
  g.beginPath(); g.moveTo(W / 2, grassY + 18); g.lineTo(W / 2, H); g.stroke();
  g.beginPath(); g.ellipse(W / 2, 560, 150, 48, 0, 0, TAU); g.stroke();
  g.beginPath(); g.moveTo(0, CONFIG.GROUND + 2); g.lineTo(W, CONFIG.GROUND + 2); g.stroke();
}

// ------------------------------------------------------------
//  Main loop
// ------------------------------------------------------------
const Game = {
  match: null,
  paused: false,     // also true after the final whistle (frame stays on screen)
  start(match) { this.match = match; this.paused = false; },
  stop() { this.match = null; this.paused = false; },
};

// a ball that bounces around behind the menus
const idleBall = new Ball();
idleBall.vx = 6;
const idleMatch = { bars: [] };

let lastT = performance.now();
let acc = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  if (Game.match && !Game.paused) {
    acc += dt;
    while (acc >= STEP && Game.match && !Game.paused) { Game.match.step(); acc -= STEP; }
  } else {
    acc = 0;
  }

  if (Game.match) {
    Game.match.draw();
  } else {
    const muted = Sound.muted;
    Sound.muted = true;                        // no bounce sounds in the menu
    idleBall.update(idleMatch);
    if (idleBall.y >= CONFIG.GROUND - idleBall.r - 1 && Math.abs(idleBall.vy) < 1) idleBall.vy = -14;
    if (Math.abs(idleBall.vx) < 3) idleBall.vx = idleBall.vx < 0 ? -6 : 6;
    Sound.muted = muted;
    ctx.drawImage(bgCanvas, 0, 0);
    drawShadow(ctx, idleBall.x, idleBall.y + idleBall.r, idleBall.r * 0.8);
    drawBall(ctx, idleBall);
  }
  requestAnimationFrame(frame);
}

function startEngine() {
  buildBackground();
  requestAnimationFrame(frame);
}

'use strict';
// ============================================================
//  config.js — every tweakable number and all game content.
//  Change something, save, refresh the browser. That's it.
// ============================================================

const CONFIG = {
  // Logical canvas size (the canvas is scaled to fit the window)
  W: 1280,
  H: 720,
  GROUND: 630,              // y of the grass line players stand on

  // Physics (values are "per frame" at 60 fps)
  GRAVITY: 0.55,
  BALL_GRAVITY_MUL: 0.8,    // ball falls a bit slower than players = floatier
  BALL_R: 19,
  BALL_BOUNCE: 0.75,        // bounciness off ground / walls / crossbar
  BALL_AIR_DRAG: 0.996,
  BALL_GROUND_FRICTION: 0.985,
  BALL_MAX_SPEED: 30,
  HEAD_BOUNCE: 0.55,        // bounciness off heads
  FOOT_BOUNCE: 0.35,        // bounciness off a foot that isn't kicking

  // Players
  HEAD_R: 42,
  FOOT_R: 15,
  NECK: 26,                 // gap between the bottom of the head and the ground
  PLAYER_SPEED: 5.4,
  JUMP_VELOCITY: 13.5,
  KICK_POWER: 16,
  KICK_FRAMES: 14,          // how long one kick swing lasts
  KICK_REACH: 8,            // extra pixels of forgiveness for kicks

  // Goals
  GOAL_DEPTH: 95,
  GOAL_HEIGHT: 215,
  CROSSBAR_THICK: 12,

  // Match
  MATCH_SECONDS: 60,
  GOAL_PAUSE: 1.6,          // celebration time after a goal (seconds)
  START_COUNTDOWN: 3,

  // Power meter (0..100)
  POWER_FILL_PER_SEC: 6,
  POWER_FILL_PER_TOUCH: 5,

  // Thunder shot (Lightning power)
  THUNDER_SPEED: 24,
  STUN_SECONDS: 1.8,

  // Career
  LEAGUES: 15,
  MATCHES_PER_LEAGUE: 3,

  // Rewards
  REWARD: {
    goal: 10,
    win: 60,
    draw: 20,
    loss: 5,
    leagueDiamonds: 3,         // finishing a career league
    quickWinDiamondChance: 0.25,
  },

  // Shop upgrades
  UPGRADE_MAX: 5,
  UPGRADE_COST: lvl => 80 * (lvl + 1),
  UPGRADE_EFFECT: 0.07,       // +7% per upgrade level / character stat point
};

// Keyboard layouts. Uses e.code, so it works with a Hebrew keyboard layout too.
const KEYMAP = {
  // single player: either side of the keyboard works
  solo: {
    left:  ['KeyA', 'ArrowLeft'],
    right: ['KeyD', 'ArrowRight'],
    jump:  ['KeyW', 'ArrowUp'],
    kick:  ['Space', 'KeyF', 'KeyK'],
    power: ['KeyS', 'ArrowDown'],
  },
  // 2-player mode, left player
  p1: { left: ['KeyA'], right: ['KeyD'], jump: ['KeyW'], kick: ['KeyF'], power: ['KeyS'] },
  // 2-player mode, right player
  p2: { left: ['ArrowLeft'], right: ['ArrowRight'], jump: ['ArrowUp'], kick: ['KeyK'], power: ['ArrowDown'] },
};

// Quick-match difficulty -> AI skill 0..1
const AI_LEVELS = { easy: 0.2, normal: 0.5, hard: 0.85 };

// Super powers. price = coins. duration in seconds.
const POWERS = {
  ice:       { name: 'Ice',        icon: '❄️', price: 0,   duration: 2.6, desc: 'Freeze your opponent solid for a few seconds.' },
  lightning: { name: 'Lightning',  icon: '⚡', price: 150,                desc: 'Your next kick becomes an unstoppable thunder shot.' },
  anvil:     { name: 'Anvil',      icon: '🔨', price: 250, duration: 2.2, desc: 'Drop a heavy anvil on your opponent\'s head.' },
  giant:     { name: 'Giant Head', icon: '🎈', price: 350, duration: 7,   desc: 'Your head grows huge for a while.', scale: 1.6 },
};

// Shop upgrades (levels stored in the save file)
const UPGRADES = {
  speed:  { name: 'Speed',        icon: '👟', desc: 'Run faster' },
  jump:   { name: 'Jump',         icon: '🦘', desc: 'Jump higher' },
  kick:   { name: 'Kick',         icon: '💥', desc: 'Kick harder' },
  charge: { name: 'Power Charge', icon: '🔋', desc: 'Power meter fills faster' },
};

// Characters. price = diamonds. stats: each point = UPGRADE_EFFECT (can be negative).
// hairStyle: short | spiky | long | bald | mohawk | afro | robot
const CHARACTERS = [
  { id: 'rookie', name: 'Rookie', price: 0,  skin: '#f1c27d', hair: '#4a2c17', hairStyle: 'short',  shirt: '#e63946', shoe: '#1d3557', stats: { speed: 0, jump: 0, kick: 0 } },
  { id: 'blaze',  name: 'Blaze',  price: 4,  skin: '#e0ac69', hair: '#ff7b00', hairStyle: 'spiky',  shirt: '#ffb703', shoe: '#d62828', stats: { speed: 1, jump: 0, kick: 2 } },
  { id: 'frost',  name: 'Frost',  price: 6,  skin: '#ffe0bd', hair: '#cdeffd', hairStyle: 'long',   shirt: '#48cae4', shoe: '#0077b6', stats: { speed: 0, jump: 3, kick: 0 } },
  { id: 'tank',   name: 'Tank',   price: 9,  skin: '#8d5524', hair: '#111111', hairStyle: 'bald',   shirt: '#2a9d8f', shoe: '#264653', headScale: 1.15, stats: { speed: -1, jump: -1, kick: 4 } },
  { id: 'zip',    name: 'Zip',    price: 12, skin: '#c68642', hair: '#9d4edd', hairStyle: 'mohawk', shirt: '#f72585', shoe: '#3a0ca3', stats: { speed: 4, jump: 1, kick: -1 } },
  { id: 'disco',  name: 'Disco',  price: 15, skin: '#a0663c', hair: '#2b2b2b', hairStyle: 'afro',   shirt: '#fb8500', shoe: '#f8f9fa', stats: { speed: 1, jump: 2, kick: 1 } },
  { id: 'robo',   name: 'Robo-9', price: 25, skin: '#adb5bd', hair: '#e63946', hairStyle: 'robot',  shirt: '#495057', shoe: '#212529', stats: { speed: 2, jump: 2, kick: 3 } },
];

const LEAGUE_NAMES = [
  'Backyard', 'Street Cup', 'Village League', 'School Championship', 'City League',
  'Regional Cup', 'National B', 'National A', 'Continental Qualifiers', 'Continental Cup',
  'Elite Division', 'Super League', 'Masters', 'World Cup', 'Legends Arena',
];

const OPPONENT_NAMES = [
  'Benny', 'Kofi', 'Luca', 'Mateo', 'Yuki', 'Omar', 'Pablo', 'Sven', 'Ravi', 'Diego',
  'Ivan', 'Tariq', 'Hugo', 'Kenji', 'Nico', 'Emre', 'Jonas', 'Ari', 'Felix', 'Marco',
  'Zane', 'Leo', 'Bruno', 'Tomas', 'Malik', 'Elio', 'Andre', 'Nils', 'Rafa', 'Duke',
];

const DEFAULT_SAVE = {
  coins: 0,
  diamonds: 0,
  ownedChars: ['rookie'],
  char: 'rookie',
  ownedPowers: ['ice'],
  power: 'ice',
  upgrades: { speed: 0, jump: 0, kick: 0, charge: 0 },
  league: 1,          // 1..LEAGUES
  leagueMatch: 0,     // 0..MATCHES_PER_LEAGUE-1
  careerDone: false,
  muted: false,
};

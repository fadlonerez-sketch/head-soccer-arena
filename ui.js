'use strict';
// ============================================================
//  ui.js — menus, shop, career, 2-player setup, saving,
//  touch controls and starting / ending matches.
// ============================================================

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const charById = id => CHARACTERS.find(c => c.id === id) || CHARACTERS[0];

// ------------------------------------------------------------
//  Save data (localStorage)
// ------------------------------------------------------------
const SAVE_KEY = 'headSoccerArena.save.v1';

// Stored values end up in innerHTML, so every field is coerced to its expected
// type / range or whitelisted against known ids; anything else falls back to the default.
const saveInt = (v, lo, hi, dflt) => Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.floor(Number(v)))) : dflt;
const saveIds = (v, known, dflt) => Array.isArray(v) ? [...new Set(dflt.concat(v.filter(id => known.includes(id))))] : dflt;

function sanitizeSave(stored, fresh) {
  const charIds = CHARACTERS.map(c => c.id), powerIds = Object.keys(POWERS);
  const s = { ...fresh };
  s.coins = saveInt(stored.coins, 0, Number.MAX_SAFE_INTEGER, fresh.coins);
  s.diamonds = saveInt(stored.diamonds, 0, Number.MAX_SAFE_INTEGER, fresh.diamonds);
  s.ownedChars = saveIds(stored.ownedChars, charIds, fresh.ownedChars);
  s.ownedPowers = saveIds(stored.ownedPowers, powerIds, fresh.ownedPowers);
  s.char = s.ownedChars.includes(stored.char) ? stored.char : fresh.char;
  s.power = s.ownedPowers.includes(stored.power) ? stored.power : fresh.power;
  s.upgrades = { ...fresh.upgrades };
  for (const id in UPGRADES) {
    if (stored.upgrades && typeof stored.upgrades === 'object') {
      s.upgrades[id] = saveInt(stored.upgrades[id], 0, CONFIG.UPGRADE_MAX, fresh.upgrades[id] || 0);
    }
  }
  s.league = saveInt(stored.league, 1, CONFIG.LEAGUES, fresh.league);
  s.leagueMatch = saveInt(stored.leagueMatch, 0, CONFIG.MATCHES_PER_LEAGUE - 1, fresh.leagueMatch);
  s.careerDone = stored.careerDone === true;
  s.muted = stored.muted === true;
  return s;
}

function loadSave() {
  const fresh = JSON.parse(JSON.stringify(DEFAULT_SAVE));
  try {
    const stored = JSON.parse(localStorage.getItem(SAVE_KEY));
    if (stored && typeof stored === 'object') return sanitizeSave(stored, fresh);
  } catch (e) { /* storage blocked or corrupt -> fresh save */ }
  return fresh;
}

function persist() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch (e) { /* ignore */ }
  updateWallet();
}

let save = loadSave();
Sound.muted = save.muted;

// ------------------------------------------------------------
//  Screens
// ------------------------------------------------------------
function show(id) {
  $$('.screen').forEach(s => s.classList.toggle('hidden', s.id !== id));
  setTouchVisible(false);
  $('#pause-btn').classList.add('hidden');
  if (id === 'scr-menu') renderMenu();
  if (id === 'scr-career') renderCareer();
  if (id === 'scr-shop') renderShop(currentShopTab);
  if (id === 'scr-2p') render2P();
  updateWallet();
}

function hideAll() { $$('.screen').forEach(s => s.classList.add('hidden')); }

function updateWallet() {
  $$('.coins').forEach(e => { e.textContent = save.coins; });
  $$('.diamonds').forEach(e => { e.textContent = save.diamonds; });
}

function renderMenu() {
  $('#career-label').textContent = save.careerDone
    ? 'Career (Champion!)'
    : `Career (League ${save.league}/${CONFIG.LEAGUES})`;
  $('#mute-btn').textContent = save.muted ? '🔇' : '🔊';
}

// Small canvas with a character on it (shop, career, 2P setup)
function charPreview(char, size = 120) {
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size * 1.1;
  const g = cv.getContext('2d');
  const p = new Player(0, char);
  const k = size / 120;
  g.scale(k, k);
  p.x = 60;
  p.y = 128;
  p.r = 36 * (char.headScale || 1);
  drawPlayer(g, p, 200, 40);
  return cv;
}

// ------------------------------------------------------------
//  Career
// ------------------------------------------------------------
function careerOpponent(league, match) {
  const idx = (league * 5 + match * 3) % CHARACTERS.length;
  let char = CHARACTERS[idx];
  if (char.id === save.char) char = CHARACTERS[(idx + 1) % CHARACTERS.length];
  const powerIds = Object.keys(POWERS);
  const power = league < 3 ? 'ice' : powerIds[(league + match) % powerIds.length];
  const aiLevel = clamp(0.12 + (league - 1) / (CONFIG.LEAGUES - 1) * 0.83 + match * 0.025, 0, 1);
  const name = OPPONENT_NAMES[((league - 1) * CONFIG.MATCHES_PER_LEAGUE + match) % OPPONENT_NAMES.length];
  return { oppChar: char, oppPower: power, aiLevel, oppName: name };
}

function renderCareer() {
  const ladder = $('#league-ladder');
  ladder.innerHTML = '';
  for (let i = 1; i <= CONFIG.LEAGUES; i++) {
    const el = document.createElement('div');
    const done = save.careerDone || i < save.league;
    el.className = 'league ' + (done ? 'done' : i === save.league ? 'current' : 'locked');
    el.innerHTML = `<b>${i}</b><span>${LEAGUE_NAMES[i - 1] || 'League ' + i}</span>`;
    ladder.appendChild(el);
  }

  const info = $('#career-info');
  info.innerHTML = '';
  if (save.careerDone) {
    info.innerHTML = `<h3>🏆 You are the champion of all ${CONFIG.LEAGUES} leagues!</h3>
      <p>Reset the career to play it again (you keep coins, diamonds and upgrades).</p>`;
    $('#career-play').classList.add('hidden');
    return;
  }
  $('#career-play').classList.remove('hidden');
  const o = careerOpponent(save.league, save.leagueMatch);
  const stars = '★'.repeat(Math.ceil(o.aiLevel * 5)) + '☆'.repeat(5 - Math.ceil(o.aiLevel * 5));
  info.appendChild(charPreview(o.oppChar, 100));
  const txt = document.createElement('div');
  txt.innerHTML = `<h3>League ${save.league}: ${LEAGUE_NAMES[save.league - 1]}</h3>
    <p>Match ${save.leagueMatch + 1} / ${CONFIG.MATCHES_PER_LEAGUE} — vs <b>${o.oppName}</b> (${o.oppChar.name})</p>
    <p>Difficulty: <span class="stars">${stars}</span> &nbsp; Power: ${POWERS[o.oppPower].icon} ${POWERS[o.oppPower].name}</p>
    <p class="hint">Win to advance. Finish a league for +${CONFIG.REWARD.leagueDiamonds} 💎</p>`;
  info.appendChild(txt);
}

// ------------------------------------------------------------
//  Shop
// ------------------------------------------------------------
let currentShopTab = 'upgrades';

function renderShop(tab) {
  currentShopTab = tab;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  const body = $('#shop-body');
  body.innerHTML = '';

  if (tab === 'upgrades') {
    for (const id in UPGRADES) {
      const u = UPGRADES[id], lvl = save.upgrades[id] || 0;
      const max = lvl >= CONFIG.UPGRADE_MAX;
      const cost = CONFIG.UPGRADE_COST(lvl);
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `<div class="big-icon">${u.icon}</div><h4>${u.name}</h4><p>${u.desc}</p>
        <div class="pips">${Array.from({ length: CONFIG.UPGRADE_MAX }, (_, i) => `<i class="${i < lvl ? 'on' : ''}"></i>`).join('')}</div>`;
      const btn = document.createElement('button');
      btn.className = 'btn small';
      btn.textContent = max ? 'MAX' : `Upgrade 🪙 ${cost}`;
      btn.disabled = max || save.coins < cost;
      btn.onclick = () => { save.coins -= cost; save.upgrades[id] = lvl + 1; persist(); renderShop(tab); };
      card.appendChild(btn);
      body.appendChild(card);
    }
  }

  if (tab === 'powers') {
    for (const id in POWERS) {
      const pw = POWERS[id];
      const owned = save.ownedPowers.includes(id);
      const card = document.createElement('div');
      card.className = 'card' + (save.power === id ? ' selected' : '');
      card.innerHTML = `<div class="big-icon">${pw.icon}</div><h4>${pw.name}</h4><p>${pw.desc}</p>`;
      const btn = document.createElement('button');
      btn.className = 'btn small';
      if (save.power === id) { btn.textContent = 'Equipped'; btn.disabled = true; }
      else if (owned) { btn.textContent = 'Equip'; btn.onclick = () => { save.power = id; persist(); renderShop(tab); }; }
      else {
        btn.textContent = `Buy 🪙 ${pw.price}`;
        btn.disabled = save.coins < pw.price;
        btn.onclick = () => { save.coins -= pw.price; save.ownedPowers.push(id); save.power = id; persist(); renderShop(tab); };
      }
      card.appendChild(btn);
      body.appendChild(card);
    }
  }

  if (tab === 'chars') {
    for (const c of CHARACTERS) {
      const owned = save.ownedChars.includes(c.id);
      const card = document.createElement('div');
      card.className = 'card' + (save.char === c.id ? ' selected' : '');
      card.appendChild(charPreview(c, 90));
      const stats = ['speed', 'jump', 'kick'].map(k => {
        const v = c.stats[k] || 0;
        return `<div class="stat"><span>${k}</span><b class="${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${v > 0 ? '+' : ''}${v}</b></div>`;
      }).join('');
      const info = document.createElement('div');
      info.innerHTML = `<h4>${c.name}</h4>${stats}`;
      card.appendChild(info);
      const btn = document.createElement('button');
      btn.className = 'btn small';
      if (save.char === c.id) { btn.textContent = 'Selected'; btn.disabled = true; }
      else if (owned) { btn.textContent = 'Select'; btn.onclick = () => { save.char = c.id; persist(); renderShop(tab); }; }
      else {
        btn.textContent = `Unlock 💎 ${c.price}`;
        btn.disabled = save.diamonds < c.price;
        btn.onclick = () => { save.diamonds -= c.price; save.ownedChars.push(c.id); save.char = c.id; persist(); renderShop(tab); };
      }
      card.appendChild(btn);
      body.appendChild(card);
    }
  }
}

// ------------------------------------------------------------
//  2-player setup (all characters & powers available)
// ------------------------------------------------------------
const twoP = { c: [0, 1], p: ['ice', 'ice'] };

function render2P() {
  const powerIds = Object.keys(POWERS);
  for (const i of [0, 1]) {
    const col = $(`#p2-side-${i}`);
    const char = CHARACTERS[twoP.c[i]];
    const pw = POWERS[twoP.p[i]];
    col.querySelector('.pv').replaceChildren(charPreview(char, 110));
    col.querySelector('.cname').textContent = char.name;
    col.querySelector('.pname').textContent = `${pw.icon} ${pw.name}`;
    col.querySelectorAll('[data-cyc]').forEach(b => {
      b.onclick = () => {
        const [what, delta] = b.dataset.cyc.split(':');
        const n = Number(delta);
        if (what === 'c') twoP.c[i] = (twoP.c[i] + n + CHARACTERS.length) % CHARACTERS.length;
        else twoP.p[i] = powerIds[(powerIds.indexOf(twoP.p[i]) + n + powerIds.length) % powerIds.length];
        render2P();
      };
    });
  }
}

// ------------------------------------------------------------
//  Starting / ending matches
// ------------------------------------------------------------
let lastSetup = null;

function startMatch(mode, setup = {}) {
  Sound.init();
  lastSetup = { mode, setup };
  let p0, p1;
  if (mode === '2p') {
    p0 = new Player(0, CHARACTERS[twoP.c[0]], { power: twoP.p[0], keymap: KEYMAP.p1, name: 'Player 1' });
    p1 = new Player(1, CHARACTERS[twoP.c[1]], { power: twoP.p[1], keymap: KEYMAP.p2, name: 'Player 2' });
  } else {
    p0 = new Player(0, charById(save.char), { power: save.power, upgrades: save.upgrades, keymap: KEYMAP.solo, touch: true, name: 'You' });
    p1 = new Player(1, setup.oppChar, { ai: true, aiLevel: setup.aiLevel, power: setup.oppPower, name: setup.oppName });
  }
  const match = new Match({ mode, players: [p0, p1], onEnd: res => endMatch(mode, res) });
  hideAll();
  setTouchVisible(mode !== '2p' && isTouchDevice);
  $('#pause-btn').classList.remove('hidden');
  Game.start(match);
}

function startQuick(difficulty) {
  const others = CHARACTERS.filter(c => c.id !== save.char);
  const powerIds = Object.keys(POWERS);
  startMatch('quick', {
    oppChar: others[(Math.random() * others.length) | 0],
    oppPower: powerIds[(Math.random() * powerIds.length) | 0],
    aiLevel: AI_LEVELS[difficulty],
    oppName: OPPONENT_NAMES[(Math.random() * OPPONENT_NAMES.length) | 0],
  });
}

function startCareer() {
  startMatch('career', careerOpponent(save.league, save.leagueMatch));
}

function endMatch(mode, { score }) {
  Game.paused = true;                       // keep the final frame visible
  setTouchVisible(false);
  $('#pause-btn').classList.add('hidden');
  const [a, b] = score;
  const title = $('#end-title');
  const details = $('#end-details');
  details.innerHTML = '';
  $('#end-rematch').classList.toggle('hidden', mode === 'career');
  $('#end-continue').textContent = mode === 'career' ? 'Continue' : 'Menu';

  if (mode === '2p') {
    title.textContent = a > b ? 'Player 1 wins!' : b > a ? 'Player 2 wins!' : 'Draw!';
    details.innerHTML = `<p class="final">${a} - ${b}</p>`;
  } else {
    const win = a > b, draw = a === b;
    title.textContent = win ? 'You win!' : draw ? 'Draw!' : 'You lose!';
    let coins = a * CONFIG.REWARD.goal + (win ? CONFIG.REWARD.win : draw ? CONFIG.REWARD.draw : CONFIG.REWARD.loss);
    let diamonds = 0;
    const notes = [];
    if (mode === 'quick' && win && Math.random() < CONFIG.REWARD.quickWinDiamondChance) diamonds += 1;
    if (mode === 'career') {
      if (win) {
        save.leagueMatch++;
        if (save.leagueMatch >= CONFIG.MATCHES_PER_LEAGUE) {
          diamonds += CONFIG.REWARD.leagueDiamonds;
          notes.push(`League ${save.league} complete!`);
          save.leagueMatch = 0;
          if (save.league >= CONFIG.LEAGUES) { save.careerDone = true; notes.push('🏆 CAREER CHAMPION!'); }
          else save.league++;
        }
      } else {
        notes.push('Win this match to advance.');
      }
    }
    save.coins += coins;
    save.diamonds += diamonds;
    persist();
    details.innerHTML = `<p class="final">${a} - ${b}</p>
      <p class="reward">+${coins} 🪙 ${diamonds ? `&nbsp; +${diamonds} 💎` : ''}</p>
      ${notes.map(n => `<p>${n}</p>`).join('')}`;
  }
  $('#scr-end').classList.remove('hidden');
}

function togglePause() {
  if (!Game.match || $('#scr-end').classList.contains('hidden') === false) return;
  Game.paused = !Game.paused;
  $('#scr-pause').classList.toggle('hidden', !Game.paused);
  setTouchVisible(!Game.paused && Game.match.mode !== '2p' && isTouchDevice);
}

function quitToMenu() {
  Game.stop();
  show('scr-menu');
}

// ------------------------------------------------------------
//  Touch controls
// ------------------------------------------------------------
const isTouchDevice = 'ontouchstart' in window || window.matchMedia('(pointer: coarse)').matches;

function setTouchVisible(v) { $('#touch').classList.toggle('hidden', !v); }

$$('#touch [data-t]').forEach(btn => {
  const action = btn.dataset.t;
  const on = e => { e.preventDefault(); touch[action] = true; btn.classList.add('down'); };
  const off = e => { e.preventDefault(); touch[action] = false; btn.classList.remove('down'); };
  btn.addEventListener('pointerdown', on);
  btn.addEventListener('pointerup', off);
  btn.addEventListener('pointerleave', off);
  btn.addEventListener('pointercancel', off);
});

// ------------------------------------------------------------
//  Wiring: every button with data-action
// ------------------------------------------------------------
const ACTIONS = {
  'goto-menu': () => show('scr-menu'),
  'goto-quick': () => show('scr-quick'),
  'goto-2p': () => show('scr-2p'),
  'goto-career': () => show('scr-career'),
  'goto-shop': () => show('scr-shop'),
  'goto-help': () => show('scr-help'),
  'quick': el => startQuick(el.dataset.diff),
  'start-2p': () => startMatch('2p'),
  'career-play': () => startCareer(),
  'career-reset': () => {
    if (!confirm('Reset career progress? (coins, diamonds and upgrades are kept)')) return;
    save.league = 1; save.leagueMatch = 0; save.careerDone = false; persist(); renderCareer();
  },
  'shop-tab': el => renderShop(el.dataset.tab),
  'resume': () => togglePause(),
  'pause': () => togglePause(),
  'quit': () => quitToMenu(),
  'end-continue': () => { Game.stop(); show(lastSetup.mode === 'career' ? 'scr-career' : 'scr-menu'); },
  'end-rematch': () => { Game.stop(); startMatch(lastSetup.mode, lastSetup.setup); },
  'mute': () => { save.muted = !save.muted; Sound.muted = save.muted; persist(); renderMenu(); },
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  Sound.init();
  ACTIONS[el.dataset.action]?.(el);
});

window.addEventListener('keydown', e => {
  if (e.code === 'Escape' || e.code === 'KeyP') togglePause();
});

// ------------------------------------------------------------
//  Scale the whole UI with the 16:9 game box
// ------------------------------------------------------------
function fit() {
  const wrap = $('#wrap');
  const w = Math.min(window.innerWidth, window.innerHeight * 16 / 9);
  wrap.style.width = w + 'px';
  wrap.style.height = (w * 9 / 16) + 'px';
  wrap.style.fontSize = (w / 1280 * 16) + 'px';
}
window.addEventListener('resize', fit);
fit();

// ------------------------------------------------------------
//  Boot
// ------------------------------------------------------------
startEngine();
show('scr-menu');
if (document.fonts) document.fonts.ready.then(() => { buildBackground(); });

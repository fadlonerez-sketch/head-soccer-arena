// Headless end-to-end tests for Head Soccer Arena (real page, real key/touch events).
//
// The original 48 gameplay checks, plus privacy / safe-DOM checks: no request leaves the computer,
// the title font comes from the local fonts/ folder, and a tampered save in localStorage (XSS
// payloads) is never rendered as markup. The browser always runs headless (never a visible window);
// the game is loaded from ../index.html via file://. Results are counted as PASS / FAIL / SKIP,
// a report is written to tests/report/, and the exit code is non-zero when anything failed.
//
// Setup once:  cd tests && npm ci     (node_modules/ is git-ignored)
//
//   node run-tests.js                   run the tests
//   node run-tests.js --check-browser   exit 0 if a usable browser exists, 3 if not
//   node run-tests.js --install-browser download Chrome Headless Shell into tests/.runtime/browsers
//
// Environment: CHROME_PATH=/path/to/chrome forces a particular browser;
//              HEADSOCCER_IGNORE_SYSTEM_BROWSERS=1 uses only the downloaded test browser.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const GAME = path.join(__dirname, '..', 'index.html');
const REPORT_DIR = path.join(__dirname, 'report');
const OUT = path.join(REPORT_DIR, 'screenshots');
const BROWSER_CACHE = path.join(__dirname, '.runtime', 'browsers');
const NO_BROWSER = 3;

// ------------------------------------------------------------------ finding a browser
function systemBrowsers() {
  const home = os.homedir();
  const mac = name => [`/Applications/${name}`, path.join(home, 'Applications', name)];
  if (process.platform === 'darwin') {
    return [
      ...mac('Google Chrome.app/Contents/MacOS/Google Chrome'),
      ...mac('Chromium.app/Contents/MacOS/Chromium'),
      ...mac('Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
      ...mac('Brave Browser.app/Contents/MacOS/Brave Browser'),
      ...mac('Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'),
    ];
  }
  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    return roots.flatMap(r => [path.join(r, 'Google/Chrome/Application/chrome.exe'),
                               path.join(r, 'Microsoft/Edge/Application/msedge.exe')]);
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
}

async function downloadedBrowser() {
  const { Browser, computeExecutablePath, getInstalledBrowsers } = require('@puppeteer/browsers');
  if (!fs.existsSync(BROWSER_CACHE)) return null;
  const installed = await getInstalledBrowsers({ cacheDir: BROWSER_CACHE });
  const shell = installed.find(b => b.browser === Browser.CHROMEHEADLESSSHELL);
  if (!shell) return null;
  const exe = computeExecutablePath({ browser: shell.browser, buildId: shell.buildId, cacheDir: BROWSER_CACHE,
                                      platform: shell.platform });
  return fs.existsSync(exe) ? exe : null;
}

async function findBrowser() {
  if (process.env.CHROME_PATH) {
    if (fs.existsSync(process.env.CHROME_PATH)) return { exe: process.env.CHROME_PATH, how: 'CHROME_PATH' };
    throw new Error(`CHROME_PATH points to a file that does not exist: ${process.env.CHROME_PATH}`);
  }
  const sys = process.env.HEADSOCCER_IGNORE_SYSTEM_BROWSERS === '1' ? null : systemBrowsers().find(p => fs.existsSync(p));
  if (sys) return { exe: sys, how: 'installed on this computer' };
  const dl = await downloadedBrowser();
  if (dl) return { exe: dl, how: 'downloaded test browser', shell: true };
  return null;
}

async function installBrowser() {
  const { install, Browser, detectBrowserPlatform } = require('@puppeteer/browsers');
  const { PUPPETEER_REVISIONS } = require('puppeteer-core');
  const buildId = PUPPETEER_REVISIONS['chrome-headless-shell'];
  const platform = detectBrowserPlatform();
  console.log(`Downloading Chrome Headless Shell ${buildId} (${platform}) from Google's Chrome for Testing`);
  console.log(`into ${BROWSER_CACHE} ...`);
  let last = -1;
  await install({
    browser: Browser.CHROMEHEADLESSSHELL, buildId, platform, cacheDir: BROWSER_CACHE,
    downloadProgressCallback: (done, total) => {
      const pct = total ? Math.floor((done / total) * 10) * 10 : 0;
      if (pct !== last) { last = pct; process.stdout.write(`  ${pct}%\n`); }
    },
  });
  console.log('Download complete.');
}

// ------------------------------------------------------------------ the tests
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, status: ok ? 'PASS' : 'FAIL', detail }); };
const skip = (name, detail) => { results.push({ name, status: 'SKIP', detail }); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runSuite(browserInfo) {
  const puppeteer = require('puppeteer-core');
  const URL = pathToFileURL(GAME).href;
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: browserInfo.exe,
    headless: browserInfo.shell ? 'shell' : true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const errors = [];
  const requests = [];
  const external = [];
  const watch = page => {
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    page.on('request', r => {
      requests.push(r.url());
      if (!/^(file|data|blob|about):/i.test(r.url())) external.push(r.url());
    });
    page.on('requestfailed', r => errors.push('requestfailed: ' + r.url() + ' ' + (r.failure() || {}).errorText));
  };

  try {
    // ================= desktop =================
    const page = await browser.newPage();
    watch(page);
    await page.setViewport({ width: 1366, height: 768 });
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await sleep(500);
    const shot = name => page.screenshot({ path: `${OUT}/${name}.png` });
    const ev = (fn, ...a) => page.evaluate(fn, ...a);
    const visible = id => ev(i => !document.getElementById(i).classList.contains('hidden'), id);
    const hold = async (key, ms) => { await page.keyboard.down(key); await sleep(ms); await page.keyboard.up(key); };

    // --- layout / css
    await ev(() => document.fonts.ready);
    const layout = await ev(() => {
      const w = document.getElementById('wrap').getBoundingClientRect();
      const btn = getComputedStyle(document.querySelector('.btn'));
      return { w: w.width, h: w.height, left: w.left, top: w.top, btnBg: btn.backgroundImage, font: btn.fontFamily,
               fontsOk: document.fonts.check("16px 'Luckiest Guy'") &&
                        [...document.fonts].some(f => f.family.includes('Luckiest Guy') && f.status === 'loaded') };
    });
    check('css loaded (button gradient)', layout.btnBg.includes('gradient'), layout.btnBg.slice(0, 40));
    check('wrap is 16:9 and fits viewport', Math.abs(layout.w / layout.h - 16 / 9) < 0.01 && layout.h <= 768 && layout.w <= 1366, JSON.stringify(layout));
    check('title font loaded', layout.fontsOk);
    const fontFiles = requests.filter(u => /\/fonts\/LuckiestGuy-[^/]*\.woff2$/.test(u));
    check('title font served from the local fonts/ folder', fontFiles.length > 0 && fontFiles.every(u => u.startsWith('file:')),
      fontFiles.join(', ') || 'no font request seen');
    check('menu visible', await visible('scr-menu'));
    await shot('01-menu');

    // --- help
    await page.click('[data-action="goto-help"]'); await sleep(250); await shot('02-help');
    check('help screen', await visible('scr-help'));
    await page.click('#scr-help [data-action="goto-menu"]');

    // --- quick match
    await page.click('[data-action="goto-quick"]'); await sleep(250); await shot('03-quick');
    await page.click('[data-diff="easy"]');
    await sleep(400);
    check('match started', await ev(() => !!Game.match && Game.match.mode === 'quick'));
    check('menus hidden during match', await ev(() => [...document.querySelectorAll('.screen')].every(s => s.classList.contains('hidden'))));
    check('pause button shown', await visible('pause-btn'));
    await shot('04-countdown');
    await sleep(3000);
    check('state is play after countdown', await ev(() => Game.match.state === 'play'));

    // freeze the AI so it doesn't interfere with movement checks
    await ev(() => { const ai = Game.match.players[1]; ai.frozen = 3; ai.chargeMul = 0; ai.power = 0; });  // AI never fires powers at us in this test
    const x0 = await ev(() => Game.match.players[0].x);
    await hold('KeyD', 500);
    const x1 = await ev(() => Game.match.players[0].x);
    check('D moves right', x1 > x0 + 50, `${x0.toFixed(0)} -> ${x1.toFixed(0)}`);
    await hold('ArrowLeft', 500);
    const x2 = await ev(() => Game.match.players[0].x);
    check('ArrowLeft moves left', x2 < x1 - 50, `${x1.toFixed(0)} -> ${x2.toFixed(0)}`);
    await page.keyboard.down('KeyW'); await sleep(120);
    const air = await ev(() => CONFIG.GROUND - Game.match.players[0].y);
    await page.keyboard.up('KeyW');
    check('W jumps', air > 30, `height ${air.toFixed(0)}`);
    await sleep(800);
    await page.keyboard.down('Space'); await sleep(50);
    const kick = await ev(() => Game.match.players[0].kickT);
    await page.keyboard.up('Space');
    check('Space kicks', kick > 0, `kickT ${kick}`);

    // real kick hits the ball: put the ball in front of the foot, press Space
    await ev(() => {
      const m = Game.match, p = m.players[0], b = m.ball;
      p.x = 400; p.vx = 0; b.x = p.foot.x + 30; b.y = CONFIG.GROUND - b.r; b.vx = 0; b.vy = 0;
    });
    await sleep(300);
    await hold('Space', 120);
    const ballV = await ev(() => Game.match.ball.vx);
    check('kick sends ball forward', ballV > 5, `ball vx ${ballV.toFixed(1)}`);
    await sleep(400);
    await shot('05-play');

    // --- goal
    await ev(() => { const b = Game.match.ball; b.x = CONFIG.W - 60; b.y = CONFIG.GROUND - 50; b.vx = 4; b.vy = 0; });
    await sleep(150);
    const g = await ev(() => ({ score: Game.match.score.slice(), state: Game.match.state }));
    check('goal in right net scores for left player', g.score[0] === 1 && g.state === 'goal', JSON.stringify(g));
    await sleep(250); await shot('06-goal');
    await sleep(3200);
    check('kickoff resumes after goal', await ev(() => Game.match.state === 'play'));

    // --- powers: ice
    await ev(() => { Game.match.players[1].frozen = 0; Game.match.players[0].power = 100; Game.match.players[0].powerType = 'ice'; });
    await sleep(60); await shot('07-power-ready');
    await hold('KeyS', 80);
    const fz = await ev(() => ({ frozen: Game.match.players[1].frozen, power: Game.match.players[0].power }));
    check('S fires Ice: opponent frozen', fz.frozen > 1 && fz.power < 5, JSON.stringify(fz));
    await sleep(200); await shot('08-frozen');

    // --- lightning
    await ev(() => { const p = Game.match.players[0]; p.power = 100; p.powerType = 'lightning'; });
    await hold('ArrowDown', 80);
    check('Down fires Lightning: charged', await ev(() => Game.match.players[0].charged));
    await ev(() => {
      const m = Game.match, p = m.players[0], b = m.ball;
      m.players[1].frozen = 3; p.x = 300; b.x = p.foot.x + 30; b.y = CONFIG.GROUND - b.r; b.vx = b.vy = 0;
    });
    await sleep(100);
    await hold('Space', 120);
    const th = await ev(() => ({ thunder: !!Game.match.ball.thunder, vx: Game.match.ball.vx }));
    check('charged kick = thunder shot', th.thunder && th.vx > 15, JSON.stringify(th));
    await sleep(120); await shot('09-thunder');
    await sleep(3000);

    // --- anvil + giant (fired by code path, effect checked)
    await ev(() => { const m = Game.match; m.players[1].frozen = 0; m.players[0].powerType = 'anvil'; m.activatePower(m.players[0]); });
    await sleep(1500);
    check('Anvil stuns opponent', await ev(() => Game.match.players[1].stunned > 0 || Game.match.state !== 'play'));
    await shot('10-anvil');
    await ev(() => { const m = Game.match, b = m.ball; b.x = CONFIG.W / 2; b.y = 200; b.vx = b.vy = 0; b.thunder = null; m.players[1].frozen = 3; });
    await ev(() => { const m = Game.match; m.players[0].powerType = 'giant'; m.activatePower(m.players[0]); });
    await sleep(800);
    check('Giant head grows', await ev(() => Game.match.players[0].r > CONFIG.HEAD_R * 1.4));
    await shot('11-giant');

    // --- pause
    await page.keyboard.press('Escape'); await sleep(200);
    const t1 = await ev(() => Game.match.time);
    await sleep(500);
    const t2 = await ev(() => Game.match.time);
    const f2 = await ev(() => Game.match.frame);
    check('Esc pauses (clock stops)', await visible('scr-pause') && t1 === t2);
    await shot('12-pause');
    await page.click('[data-action="resume"]'); await sleep(300);
    check('resume continues', !(await visible('scr-pause')) && (await ev(() => Game.match.frame)) > f2 + 5, await ev(() => Game.match.state));

    // --- full time
    await ev(() => { Game.match.score = [3, 1]; Game.match.time = 0.05; });
    await page.waitForFunction(() => !document.getElementById('scr-end').classList.contains('hidden'), { timeout: 10000 }).catch(() => {});
    check('end screen after full time', await visible('scr-end'));
    const endTxt = await ev(() => document.getElementById('end-title').textContent + ' | ' + document.getElementById('end-details').innerText.replace(/\s+/g, ' '));
    check('win recognised + rewards', endTxt.startsWith('You win!'), endTxt);
    const saved = await ev(() => JSON.parse(localStorage.getItem('headSoccerArena.save.v1')));
    check('coins saved to localStorage', saved && saved.coins >= (await ev(() => 3 * CONFIG.REWARD.goal + CONFIG.REWARD.win)), `coins ${saved && saved.coins}`);
    await sleep(400); await shot('13-end');
    await page.click('#end-rematch'); await sleep(300);
    check('rematch starts a fresh match', await ev(() => Game.match && Game.match.score[0] === 0 && Game.match.state === 'countdown'));
    await page.keyboard.press('KeyP'); await sleep(150);
    await page.click('[data-action="quit"]'); await sleep(250);
    check('quit returns to menu', await visible('scr-menu') && await ev(() => Game.match === null));

    // --- shop
    await ev(() => { save.coins = 2000; save.diamonds = 30; persist(); });
    await page.click('[data-action="goto-shop"]'); await sleep(250);
    await shot('14-shop-upgrades');
    await page.click('#shop-body .card .btn');   // upgrade Speed
    check('buying an upgrade raises its level', await ev(() => save.upgrades.speed === 1 && save.coins === 2000 - CONFIG.UPGRADE_COST(0)));
    await page.click('[data-tab="powers"]'); await sleep(150);
    await shot('15-shop-powers');
    const buyBtn = await page.$$('#shop-body .card .btn');
    await buyBtn[1].click();                      // lightning
    check('buying a power equips it', await ev(() => save.power === 'lightning' && save.ownedPowers.includes('lightning')));
    await page.click('[data-tab="chars"]'); await sleep(150);
    await shot('16-shop-chars');
    const charBtns = await page.$$('#shop-body .card .btn');
    await charBtns[1].click();                    // Blaze
    check('unlocking a character selects it', await ev(() => save.char === 'blaze' && save.diamonds === 30 - CHARACTERS[1].price));
    await page.click('#scr-shop [data-action="goto-menu"]');

    // --- career
    await page.click('[data-action="goto-career"]'); await sleep(250);
    await shot('17-career');
    await page.click('#career-play'); await sleep(300);
    check('career match uses the bought character + power', await ev(() => Game.match.mode === 'career' && Game.match.players[0].char.id === 'blaze' && Game.match.players[0].powerType === 'lightning'));
    await sleep(3200);
    await ev(() => { Game.match.score = [2, 0]; Game.match.time = 0.05; });
    await page.waitForFunction(() => !document.getElementById('scr-end').classList.contains('hidden'), { timeout: 10000 }).catch(() => {});
    check('career win advances match counter', await ev(() => save.league === 1 && save.leagueMatch === 1));
    await page.click('#end-continue'); await sleep(250);
    check('continue returns to career screen', await visible('scr-career'));
    // finish league 1 (2 more wins) -> league 2 + diamonds
    for (let i = 0; i < 2; i++) {
      await page.click('#career-play'); await sleep(300);
      await ev(() => { Game.match.score = [1, 0]; Game.match.time = 0.05; Game.match.state = 'play'; });
      await page.waitForFunction(() => !document.getElementById('scr-end').classList.contains('hidden'), { timeout: 10000 }).catch(() => {});
      await page.click('#end-continue'); await sleep(250);
    }
    check('league completed -> league 2 + diamonds', await ev(() => save.league === 2 && save.leagueMatch === 0 && save.diamonds === 30 - CHARACTERS[1].price + CONFIG.REWARD.leagueDiamonds),
      await ev(() => JSON.stringify({ l: save.league, m: save.leagueMatch, d: save.diamonds })));
    await shot('18-career-league2');
    await page.click('#scr-career [data-action="goto-menu"]');

    // --- 2 players
    await page.click('[data-action="goto-2p"]'); await sleep(250);
    await page.click('#p2-side-1 [data-cyc="c:1"]'); await sleep(100);
    await shot('19-2p-setup');
    await page.click('[data-action="start-2p"]'); await sleep(3300);
    const before = await ev(() => Game.match.players.map(p => p.x));
    await page.keyboard.down('KeyD'); await page.keyboard.down('ArrowLeft'); await sleep(400);
    await page.keyboard.up('KeyD'); await page.keyboard.up('ArrowLeft');
    const after = await ev(() => Game.match.players.map(p => p.x));
    check('2P: both players move independently', after[0] > before[0] + 30 && after[1] < before[1] - 30, JSON.stringify({ before, after }));
    await page.keyboard.down('KeyK'); await sleep(40);
    const k2 = await ev(() => [Game.match.players[0].kickT, Game.match.players[1].kickT]);
    await page.keyboard.up('KeyK');
    check('2P: K kicks only for right player', k2[0] === 0 && k2[1] > 0, JSON.stringify(k2));
    check('2P: no touch controls', !(await visible('touch')));
    await shot('20-2p-play');
    await ev(() => { Game.match.score = [1, 2]; Game.match.time = 0.05; });
    await page.waitForFunction(() => !document.getElementById('scr-end').classList.contains('hidden'), { timeout: 10000 }).catch(() => {});
    check('2P end title', (await ev(() => document.getElementById('end-title').textContent)) === 'Player 2 wins!');
    await page.click('#end-continue'); await sleep(200);

    // --- AI soak tests (simulation stepped directly, no rendering)
    const soak = await ev(() => {
      const out = {};
      const run = (lvlA, lvlB, idleLeft) => {
        const p0 = new Player(0, CHARACTERS[0], idleLeft ? { keymap: { left: [], right: [], jump: [], kick: [], power: [] } } : { ai: true, aiLevel: lvlA });
        const p1 = new Player(1, CHARACTERS[2], { ai: true, aiLevel: lvlB, power: 'anvil' });
        let ended = false;
        const m = new Match({ mode: 'quick', players: [p0, p1], onEnd: () => { ended = true; } });
        let bad = 0, frames = 0;
        while (!ended && frames < 60 * 400) {
          m.step(); frames++;
          const b = m.ball;
          if (![b.x, b.y, b.vx, b.vy, p0.x, p0.y, p1.x, p1.y].every(Number.isFinite)) bad++;
          if (b.x < 0 || b.x > CONFIG.W || b.y > CONFIG.GROUND + 1) bad++;
        }
        return { score: m.score, ended, bad, seconds: +(frames / 60).toFixed(1) };
      };
      out.aiVsAi = run(0.5, 0.5);
      out.hardVsIdle = run(0, 0.85, true);
      out.easyVsHard = [0, 0]; for (let i = 0; i < 4; i++) { const r = run(0.2, 0.85); out.easyVsHard[0] += r.score[0]; out.easyVsHard[1] += r.score[1]; }
      return out;
    });
    check('AI vs AI: match completes, physics sane', soak.aiVsAi.ended && soak.aiVsAi.bad === 0, JSON.stringify(soak.aiVsAi));
    check('Hard AI scores on an idle player', soak.hardVsIdle.score[1] >= 2 && soak.hardVsIdle.bad === 0, JSON.stringify(soak.hardVsIdle));
    check('Hard AI beats easy AI (4 matches aggregate)', soak.easyVsHard[1] > soak.easyVsHard[0], JSON.stringify(soak.easyVsHard));

    // --- portrait / tiny window
    await page.setViewport({ width: 600, height: 900 });
    await sleep(300);
    const port = await ev(() => { const r = document.getElementById('wrap').getBoundingClientRect(); return { w: r.width, h: r.height }; });
    check('portrait: game box fits width', port.w <= 600 && Math.abs(port.w / port.h - 16 / 9) < 0.01, JSON.stringify(port));
    await shot('21-portrait');
    await page.close();

    // ================= phone (touch) =================
    const phone = await browser.newPage();
    watch(phone);
    await phone.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await phone.goto(URL, { waitUntil: 'networkidle0' });
    await sleep(400);
    await phone.screenshot({ path: `${OUT}/22-phone-menu.png` });
    await phone.tap('[data-action="goto-quick"]'); await sleep(200);
    await phone.tap('[data-diff="normal"]'); await sleep(3400);
    check('phone: touch controls visible in match', await phone.evaluate(() => !document.getElementById('touch').classList.contains('hidden')));
    await phone.evaluate(() => { Game.match.players[1].frozen = 3; });
    const box = await (await phone.$('#touch [data-t="right"]')).boundingBox();
    const cdp = await phone.createCDPSession();
    const px0 = await phone.evaluate(() => Game.match.players[0].x);
    const pt = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] });
    await sleep(500);
    const held = await phone.evaluate(() => touch.right);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(50);
    const px1 = await phone.evaluate(() => Game.match.players[0].x);
    check('phone: holding ▶ moves the player', held && px1 > px0 + 40, `${px0.toFixed(0)} -> ${px1.toFixed(0)}`);
    check('phone: releasing ▶ stops', await phone.evaluate(() => touch.right === false));
    await phone.screenshot({ path: `${OUT}/23-phone-play.png` });
    await phone.tap('#pause-btn'); await sleep(200);
    check('phone: pause button works', await phone.evaluate(() => Game.paused && !document.getElementById('scr-pause').classList.contains('hidden')));
    await phone.screenshot({ path: `${OUT}/24-phone-pause.png` });
    await phone.close();

    // ================= tampered save (stored XSS) =================
    const evil = await browser.newPage();
    watch(evil);
    await evil.setViewport({ width: 1366, height: 768 });
    const PAYLOAD = '<img src=x onerror="window.__xss=(window.__xss||0)+1">';
    await evil.evaluateOnNewDocument(p => {
      if (sessionStorage.getItem('planted')) return;  // plant once; the game may rewrite it afterwards
      sessionStorage.setItem('planted', '1');
      localStorage.setItem('headSoccerArena.save.v1', JSON.stringify({
        coins: p, diamonds: `1${p}`, char: p, power: p, ownedChars: ['rookie', p], ownedPowers: ['ice', p],
        upgrades: { speed: p, jump: '2', kick: [p] }, league: p, leagueMatch: `${p}`,
        careerDone: p, muted: p, extra: p,
      }));
    }, PAYLOAD);
    await evil.goto(URL, { waitUntil: 'networkidle0' });
    await sleep(300);
    check('boots to the menu with a tampered save', await evil.evaluate(() =>
      !document.getElementById('scr-menu').classList.contains('hidden')));
    const visit = async sel => { await evil.click(sel); await sleep(200); };
    await visit('[data-action="goto-career"]');
    await visit('#scr-career [data-action="goto-menu"]');
    await visit('[data-action="goto-shop"]');
    for (const tab of ['upgrades', 'powers', 'chars']) await visit(`[data-tab="${tab}"]`);
    await visit('#scr-shop [data-action="goto-menu"]');
    await evil.screenshot({ path: `${OUT}/25-tampered-save.png` });
    const dom = await evil.evaluate(() => ({
      xss: window.__xss || 0,
      injected: document.querySelectorAll('img[src="x"], [onerror]').length,
      coins: [...document.querySelectorAll('.coins')].map(e => e.textContent),
      save: { coins: save.coins, diamonds: save.diamonds, char: save.char, power: save.power, league: save.league,
              leagueMatch: save.leagueMatch, ownedChars: save.ownedChars, ownedPowers: save.ownedPowers,
              upgrades: save.upgrades, careerDone: save.careerDone, muted: save.muted, extra: save.extra },
    }));
    check('saved-game XSS payload is not rendered as markup', dom.xss === 0 && dom.injected === 0, JSON.stringify(dom));
    const sv = dom.save;
    check('tampered save is sanitized to safe defaults', sv.coins === 0 && sv.diamonds === 0 && sv.char === 'rookie' &&
      sv.power === 'ice' && sv.league === 1 && sv.leagueMatch === 0 && sv.careerDone === false && sv.muted === false &&
      sv.extra === undefined && JSON.stringify(sv.ownedChars) === '["rookie"]' && JSON.stringify(sv.ownedPowers) === '["ice"]' &&
      sv.upgrades.speed === 0 && sv.upgrades.jump === 2 && sv.upgrades.kick === 0 && dom.coins.every(t => t === '0'),
      JSON.stringify(dom.save));
    await evil.close();
  } finally {
    await browser.close();
  }

  check('no JS errors or failed requests', errors.length === 0, errors.join(' || '));
  check('no requests to non-local hosts', external.length === 0 && requests.length > 0,
    external.length ? external.join(', ') : `${requests.length} local requests`);
}

// ------------------------------------------------------------------ report
function report(browserInfo, crash) {
  const count = s => results.filter(r => r.status === s).length;
  const lines = [];
  lines.push('Head Soccer Arena - automated browser tests');
  lines.push(`Date:     ${new Date().toString()}`);
  lines.push(`Computer: ${os.type()} ${os.release()} (${process.arch}), Node ${process.version}`);
  lines.push(`Browser:  ${browserInfo ? `${browserInfo.exe} (${browserInfo.how})` : 'none'}`);
  lines.push(`Game:     ${GAME}`);
  lines.push('');
  for (const r of results) lines.push(`${r.status}  ${r.name}${r.detail ? '  - ' + r.detail : ''}`);
  if (crash) {
    lines.push('');
    lines.push('THE TEST RUN STOPPED EARLY because of an error:');
    lines.push(String(crash && crash.stack || crash));
    lines.push('Checks after that point did not run and are counted as failed below.');
  }
  const expected = 53;
  const notRun = crash ? Math.max(0, expected - results.length) : 0;
  const passed = count('PASS'), failed = count('FAIL') + notRun, skipped = count('SKIP');
  lines.push('');
  lines.push(`RESULT: ${passed} passed, ${failed} failed, ${skipped} skipped (of ${expected} checks)` +
             (notRun ? `, ${notRun} not run` : ''));
  lines.push(failed === 0 ? 'ALL TESTS PASSED' + (skipped ? ' (some skipped - see above)' : '') : 'TESTS FAILED');
  const text = lines.join('\n') + '\n';
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPORT_DIR, 'test-report.txt'), text);
  console.log(text);
  console.log(`Report saved to: ${path.join(REPORT_DIR, 'test-report.txt')}`);
  console.log(`Screenshots in:  ${OUT}`);
  return failed === 0 && results.length > 0;
}

(async () => {
  const arg = process.argv[2];
  if (arg === '--install-browser') { await installBrowser(); return; }
  const browserInfo = await findBrowser();
  if (arg === '--check-browser') {
    if (browserInfo) console.log(`Browser: ${browserInfo.exe} (${browserInfo.how})`);
    process.exitCode = browserInfo ? 0 : NO_BROWSER;
    return;
  }
  if (!fs.existsSync(GAME)) {
    console.error(`The game was not found at ${GAME}.`);
    process.exitCode = 1;
    return;
  }
  if (!browserInfo) {
    console.error('No Chrome-compatible browser was found, so the tests could NOT run (nothing passed).');
    process.exitCode = NO_BROWSER;
    return;
  }
  console.log(`Using browser: ${browserInfo.exe} (${browserInfo.how})`);
  console.log('Running 53 checks in a headless browser (no window is shown). This takes about a minute...\n');
  let crash = null;
  try {
    await runSuite(browserInfo);
  } catch (e) {
    crash = e;
  }
  process.exitCode = report(browserInfo, crash) ? 0 : 1;
})().catch(e => { console.error('TEST RUNNER ERROR:', e); process.exitCode = 1; });

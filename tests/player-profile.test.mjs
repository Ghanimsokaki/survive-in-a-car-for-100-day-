// Account pictures + player settings, end to end:
//   · settings.js       — defaults, normalising, persistence, live application
//   · account-image.js  — initials, crop maths, file gates, data-URL cleaning
//   · account.js        — saving a picture, schema fallback, finding a friend
//   · the UI            — hub friends sheet, lobby add-friend, the panel itself
//   · the game          — shake preference and the graphics recovery ladder
import { readFileSync } from 'node:fs';
import { installDOM, El } from './doms.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const MOCK_PORT = 55700 + (process.pid % 200);
process.env.MOCK_PORT = String(MOCK_PORT);
const mockMod = await import('./mocksupabase.mjs');
const { tables } = mockMod;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(150);

globalThis.__COARSE__ = false;
globalThis.__TOUCH__ = false;
installDOM({ width: 1280, height: 800 });

const html = readFileSync(`${ROOT}public/index.html`, 'utf8');
for (const id of [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1])) document.getElementById(id);

const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('/api/config')) {
    return Promise.resolve(new Response(JSON.stringify({
      supabaseUrl: `http://127.0.0.1:${MOCK_PORT}`, supabaseAnonKey: 'mock-anon-key',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
  }
  if (u.startsWith('/')) return Promise.resolve(new Response('{}', { status: 404 }));
  return realFetch(u, opts);
};

const problems = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};

const settings = await import('./app/js/settings.js');
const img = await import('./app/js/account-image.js');
const { Account } = await import('./app/js/account.js');

// --------------------------------------------------------------- settings
console.log('\nsettings');
{
  const d = settings.normalizeSettings(undefined);
  check('missing settings fall back to defaults',
    d.volume === 0.7 && d.muted === false && d.shake === 1 && d.quality === 'auto', JSON.stringify(d));

  const junk = settings.normalizeSettings({
    volume: 9, muted: 'true', shake: -4, quality: 'cinematic',
  });
  check('volume is clamped to 0…1', junk.volume === 1, String(junk.volume));
  check('shake is clamped to 0…1', junk.shake === 0, String(junk.shake));
  check('an unknown tier becomes auto', junk.quality === 'auto', junk.quality);
  check('a truthy string counts as muted', junk.muted === true);

  settings.saveSettings({ muted: true });
  const saved = settings.saveSettings({ volume: 0.35, shake: 0.25, quality: 'high' });
  check('save merges into what was already there',
    saved.volume === 0.35 && saved.shake === 0.25 && saved.quality === 'high' && saved.muted === true,
    JSON.stringify(saved));
  const reread = settings.loadSettings();
  check('settings survive a reload', reread.volume === 0.35 && reread.quality === 'high');
  check('the volume has a human label', settings.describeVolume({ volume: 0.35 }) === '35%');
  check('muted is not printed as a number', settings.describeVolume({ volume: 0.8, muted: true }) === 'MUTED');
  check('silent is called silent', settings.describeVolume({ volume: 0 }) === 'SILENT');
  check('shake 0 reads as OFF', settings.describeShake({ shake: 0 }) === 'OFF');

  // corrupt storage must never throw
  globalThis.localStorage.setItem(settings.SETTINGS_KEY, '{not json');
  check('corrupt storage yields defaults', settings.loadSettings().volume === 0.7);

  // live application
  const calls = [];
  const audio = {
    setMuted: (v) => calls.push(['mute', v]),
    setVolume: (v) => calls.push(['vol', v]),
  };
  const game = { setShakeScale: (v) => calls.push(['shake', v]) };
  settings.applySettings({ volume: 0.4, muted: true, shake: 0 }, { audio, game });
  check('mute reaches the audio kit', calls.some(([k, v]) => k === 'mute' && v === true));
  check('volume reaches the audio kit', calls.some(([k, v]) => k === 'vol' && v === 0.4));
  check('shake reaches the game', calls.some(([k, v]) => k === 'shake' && v === 0));
  let threw = false;
  try { settings.applySettings({ volume: 1 }, { audio: {}, game: {} }); } catch { threw = true; }
  check('a target without the methods is ignored, not fatal', !threw);
}

// ---------------------------------------------------------- account pictures
console.log('\naccount pictures');
{
  check('initials from two words', img.initialsOf('Ghanim Sokaki') === 'GS');
  check('initials from one word', img.initialsOf('wanderer') === 'WA');
  check('initials survive an empty name', img.initialsOf('') === '?');
  check('initials ignore symbols', img.initialsOf('@#$%') === '?', img.initialsOf('@#$%'));

  const portrait = img.squareCrop(1200, 1600);
  check('portrait photos crop to the middle square',
    portrait.side === 1200 && portrait.x === 0 && portrait.y === 200, JSON.stringify(portrait));
  const landscape = img.squareCrop(1600, 1200);
  check('landscape photos crop to the middle square',
    landscape.side === 1200 && landscape.y === 0 && landscape.x === 200, JSON.stringify(landscape));
  check('a square needs no crop', img.squareCrop(500, 500).x === 0 && img.squareCrop(500, 500).y === 0);
  check('a zero-size image never divides by zero', img.squareCrop(0, 0).side === 1);

  const tiny = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  check('a small jpeg data URL is accepted', img.isAvatarImage(tiny));
  check('an external URL is refused', !img.isAvatarImage('https://example.com/me.png'));
  check('a script URL is refused', !img.isAvatarImage('javascript:alert(1)'));
  check('an empty string is refused', !img.isAvatarImage(''));
  check('an oversized blob is refused', !img.isAvatarImage(`data:image/png;base64,${'A'.repeat(img.AVATAR_MAX_DATA)}`));
  check('garbage is cleaned to “no picture”', img.cleanAvatar('not-an-image') === '');
  check('a real picture survives cleaning', img.cleanAvatar(` ${tiny} `) === tiny);

  check('a text file is rejected before decoding',
    img.checkImageFile({ type: 'text/plain', size: 10 }).ok === false);
  check('an 12 MB photo is rejected', img.checkImageFile({ type: 'image/jpeg', size: 12 * 1024 * 1024 }).ok === false);
  check('a 2 MB photo passes the gate', img.checkImageFile({ type: 'image/jpeg', size: 2 * 1024 * 1024 }).ok === true);

  let failed = '';
  try { await img.fileToAvatar(null); } catch (e) { failed = e.message; }
  check('no file produces a readable message', /pick a picture/i.test(failed), failed);
}

// ------------------------------------------------------- saving the picture
console.log('\nsaving a picture');
{
  const TINY = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ==';
  const a = new Account();
  await a.boot();
  await a.signUp('pics', 'secret123', 'Pictures');
  check('signed in', a.signedIn);

  await a.saveProfile({ avatar_image: TINY });
  await sleep(120);
  const row = tables.profiles.find((p) => p.id === a.profile.id);
  check('the picture is written to the profile row', row?.avatar_image === TINY,
    String(row?.avatar_image || '').slice(0, 24));
  check('the picture is on the profile object', a.profile.avatar_image === TINY);

  // a project without the new column: the write loses only the picture
  const realUpdate = a.sb.update.bind(a.sb);
  a.sb.update = async (table, query, patch) => {
    if ('avatar_image' in patch) throw new Error('PGRST204: column avatar_image does not exist');
    return realUpdate(table, query, patch);
  };
  await a.saveProfile({ avatar_image: TINY, display_name: 'KEEPME' });
  await sleep(80);
  const after = tables.profiles.find((p) => p.id === a.profile.id);
  check('a missing column does not lose the name', after?.display_name === 'KEEPME', after?.display_name);
  check('the player is told the picture is local only', /device only/i.test(a.lastError), a.lastError);
  a.sb.update = realUpdate;

  await a.saveProfile({ avatar_image: '' });
  await sleep(80);
  const cleared = tables.profiles.find((p) => p.id === a.profile.id);
  check('removing the picture clears the column', cleared?.avatar_image === '', `“${cleared?.avatar_image}”`);
}

// ------------------------------------------------------------ adding friends
console.log('\nadding friends');
{
  const me = new Account();
  await me.boot();
  await me.signUp('ghanim', 'secret123', 'Ghanim');
  const mate = new Account();
  await mate.boot();
  await mate.signUp('budi_s', 'secret123', 'Budi Santoso');
  await me.signIn('ghanim', 'secret123');

  const found = await me.findUser('GHANIM');       // yourself, but found
  check('usernames are matched case-insensitively', found?.username === 'ghanim');
  const byHandle = await me.findUser('@budi_s');
  check('the @ is tolerated', byHandle?.username === 'budi_s');
  const byDisplay = await me.findUser('Budi Santoso');
  check('people can be found by display name', byDisplay?.username === 'budi_s');

  let selfErr = '';
  try { await me.addFriend('ghanim'); } catch (e) { selfErr = e.message; }
  check('adding yourself is refused', /that is you/i.test(selfErr), selfErr);

  let missing = '';
  try { await me.addFriend('nobody_here'); } catch (e) { missing = e.message; }
  check('an unknown name explains itself', /no survivor/i.test(missing), missing);

  await me.addFriend('budi_s');
  check('the friend is added', me.friends.some((f) => f.username === 'budi_s'),
    me.friends.map((f) => f.username).join(','));
  check('the friend is on the server too',
    tables.friendships.some((f) => f.user_id === me.profile.id && f.friend_id === mate.profile.id));

  let dupe = '';
  try { await me.addFriend('budi_s'); } catch (e) { dupe = e.message; }
  check('adding twice says so', /already/i.test(dupe), dupe);

  // the request is symmetric when the RPC exists, so the other player sees you
  check('the friendship is mirrored for the other player',
    tables.friendships.some((f) => f.user_id === mate.profile.id && f.friend_id === me.profile.id));

  // without the RPC, the one-way fallback still works
  const solo = new Account();
  await solo.boot();
  await solo.signUp('solo_guy', 'secret123', 'Solo');
  await solo.signIn('solo_guy', 'secret123');
  solo.sb.rpc = async () => { throw new Error('Could not find the function public.add_friend'); };
  await solo.addFriend('budi_s');
  check('the fallback still writes a friendship row',
    tables.friendships.some((f) => f.user_id === solo.profile.id));
}

// ------------------------------------------------------------------- the UI
console.log('\nplayer panel + hub friends');
{
  const { PlayerPanel } = await import('./app/js/player-panel.js');
  const { Arcade } = await import('./app/js/arcade.js');

  const acct = new Account();
  await acct.boot();
  await acct.signUp('panel_u', 'secret123', 'Panel User');
  await acct.saveProfile({ avatar_image: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ==' });
  await sleep(80);

  let applied = null;
  const panel = new PlayerPanel({ account: acct, getGame: () => null, onSettings: (s) => { applied = s; } });
  check('the panel builds into the page', Boolean(document.getElementById('playerPanel')) || Boolean(panel.el));
  panel.show('account');
  check('the panel opens', panel.open === true);
  check('the portrait carries the picture',
    String(panel.nodes.portrait.style.backgroundImage).includes('data:image/jpeg'),
    panel.nodes.portrait.style.backgroundImage.slice(0, 30));
  check('the name is shown', /PANEL USER/.test(panel.nodes.name.textContent), panel.nodes.name.textContent);
  check('the handle is shown', /@panel_u/.test(panel.nodes.handle.textContent), panel.nodes.handle.textContent);

  panel.update({ volume: 0.2, muted: false, shake: 0.5, quality: 'low' });
  check('a settings change is reported upward', applied?.volume === 0.2 && applied?.quality === 'low');
  check('the sheet repaints from the store', panel.nodes.volume.value === '20', panel.nodes.volume.value);
  check('the shake readout follows', panel.nodes.shakeOut.textContent === '50%', panel.nodes.shakeOut.textContent);
  const lowBtn = [...panel.nodes.quality.children].find((b) => b.dataset.quality === 'low');
  check('the chosen tier is highlighted', lowBtn?.classList.contains('on'));

  panel.nodes.muted.checked = true;
  panel.nodes.muted.dispatch('change', { target: { checked: true } });
  check('muting is stored', settings.loadSettings().muted === true);

  await panel.clearPicture();
  check('removing the picture clears the profile', !acct.profile.avatar_image);
  panel.hide();
  check('the panel closes', panel.open === false);

  // the hub
  const arcade = new Arcade({
    account: acct,
    onPlayNative: () => {},
    onSettings: () => {},
    fetchImpl: async () => ({ ok: false, json: async () => ({}) }),
  });
  document.body.appendChild?.(arcade.el);
  arcade.renderFriends();
  const strip = arcade.nodes.friends.innerHTML;
  check('the hub friends strip offers ADD', strip.includes('data-add-friend'));
  check('the hub has a working friends sheet', Boolean(arcade.nodes.friendsModal));
  arcade.openFriends();
  check('the friends sheet opens', !arcade.nodes.friendsModal.classList.contains('hidden'));
  check('the sheet explains how to add', /username/i.test(arcade.nodes.afList.innerHTML + (arcade.nodes.afInput?.placeholder || '')));
  arcade.nodes.afInput.value = 'budi_s';
  await arcade.addFriendFromModal();
  await sleep(250);
  check('adding from the hub works', acct.friends.some((f) => f.username === 'budi_s'),
    acct.friends.map((f) => f.username).join(','));
  check('the sheet lists the friend', /budi_s/i.test(arcade.nodes.afList.innerHTML));
  check('the strip redraws with the friend', /Budi/.test(arcade.nodes.friends.innerHTML));
  check('the hub avatar paints the account picture',
    String(arcade.nodes.profileBtn.style.backgroundImage).includes('data:image') || arcade.nodes.profileBtn.textContent === 'PU',
    arcade.nodes.profileBtn.textContent);

  arcade.nodes.afInput.value = 'nobody_here';
  await arcade.addFriendFromModal();
  check('a bad name is reported in the sheet', /no survivor/i.test(arcade.nodes.afNote.textContent),
    arcade.nodes.afNote.textContent);
}

// -------------------------------------------------------------- the game bits
console.log('\ngame wiring');
{
  const { Game } = await import('./app/js/game.js');
  const g = new Game({
    mount: new El('div', 'app'),
    profile: { name: 'PIC', color: 0xffb347, carColor: 0xd24a2b },
    room: 'test', onQuit: () => {},
  });
  g.started = true;
  check('shake preference is applied', g.setShakeScale(0) === 0 && g.shakeAmt === 0);
  g.shakeAmt = 1;
  g.updateCamera(1 / 60);
  check('a zero preference means a still camera', g.shakeScale === 0);
  g.setShakeScale(0.5);
  check('a half preference is remembered', g.shakeScale === 0.5);

  // the recovery ladder: shadows → post → resolution → particles, then stop
  g.renderer.shadowMap.enabled = true;
  const steps = [];
  for (let i = 0; i < 6; i++) steps.push(g.downgradeGraphics());
  check('recovery starts by turning shadows off', steps[0] === 'SHADOWS OFF', steps.join(' → '));
  check('then the post layer', steps[1] === 'EFFECTS OFF', steps.join(' → '));
  check('then resolution', steps[2] === 'RESOLUTION DOWN', steps.join(' → '));
  check('then particles', steps[3] === 'PARTICLES DOWN', steps.join(' → '));
  check('and then it stops lying about fixes', steps[4] === '' && g.safeMode === true, steps.join(' → '));

  const tier = g.applyQuality('low');
  check('a tier can be applied live', tier === 'low' && g.tier.id === 'low');
  check('applying a tier leaves safe mode', g.safeMode === false && g.renderer.shadowMap.enabled === false);

  // a render that throws is counted, and the player is told something useful
  let toast = '';
  g.hud.toast = (m) => { toast = m; };
  g.renderer.render = () => { throw new Error('shader compile failed'); };
  g.started = true;
  for (let i = 0; i < 120; i++) g.loop();
  check('a failing draw never escapes the loop', true);
  check('the failure is recorded verbatim', /shader compile/.test(g.lastError?.message || ''), g.lastError?.message);
  check('the player is told what broke', /RENDER ERROR/.test(toast), toast);
  check('the message names the restart', /RESTART/.test(toast), toast);
  check('the error is exposed for debugging', Boolean(globalThis.__outrunLastError));
  const bar = document.getElementById('errBar');
  check('a failed frame raises the error bar', !bar.classList.contains('hidden'));
  check('the bar names the failure',
    /SHADER COMPILE FAILED/i.test(document.getElementById('errText').textContent),
    document.getElementById('errText').textContent);

  // the avatar nameplate can take a picture
  check('the avatar can paint a picture on its nameplate', typeof g.avatar.setPicture === 'function');
  let threw = false;
  try { g.avatar.setPicture(''); g.avatar.setPicture('not-a-url'); } catch { threw = true; }
  check('a bad picture never throws', !threw);
}

// -------------------------------------------------------------- the markup
console.log('\nmarkup + schema');
{
  const mainJs = readFileSync(`${ROOT}public/js/main.js`, 'utf8');
  const arcadeJs = readFileSync(`${ROOT}public/js/arcade.js`, 'utf8');
  const css = readFileSync(`${ROOT}public/styles.css`, 'utf8');
  const schema = readFileSync(`${ROOT}supabase/schema.sql`, 'utf8');

  check('the lobby has a settings button', html.includes('id="lobbySettingsBtn"'));
  check('a run has a settings button', html.includes('id="settingsFab"'));
  check('a broken frame offers a real RESTART button',
    html.includes('id="errRestart"') && /id="errBar"/.test(html));
  check('the error bar is styled', css.includes('.err-bar'));
  check('a crash before the game boots still reaches the player',
    /addEventListener\('error'/.test(html) && /addEventListener\('unhandledrejection'/.test(html));
  check('the hub has a settings (gear) button', arcadeJs.includes('arcSettingsBtn'));
  check('the hub avatar opens the account sheet',
    /nodes\.profileBtn\?\.addEventListener\('click', \(\) => this\.onSettings\?\.\('account'\)\)/.test(arcadeJs));
  check('P opens the panel', /e\.key !== 'p'/.test(mainJs));
  check('the panel is styled', css.includes('.player-panel') && css.includes('.pp-card'));
  check('the in-run gear only shows during a run', /body\.run-live \.settings-fab/.test(css));
  check('the picture column exists in the schema', /add column if not exists avatar_image/.test(schema));
  check('the schema refuses huge or external pictures', /avatar_image ~ '\^data:image\//.test(schema));
  check('the panel is created in the app', /new PlayerPanel\(/.test(mainJs));
  check('the picture is pushed to the 3D nameplate', /setPicture\?\.\(account\.profile\?\.avatar_image/.test(mainJs));
}

mockMod.default?.close?.();
console.log(problems.length ? `\nFAILED: ${problems.join(', ')}` : '\nALL ACCOUNT PICTURE + SETTINGS TESTS PASSED');
process.exit(problems.length ? 1 : 0);

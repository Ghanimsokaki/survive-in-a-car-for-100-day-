/**
 * THE PLAYER PANEL — "my account picture" and "my settings", in one sheet.
 *
 * It is created once and reused everywhere: the arcade header, the lobby and
 * the in-run gear button all open the same element. That is deliberate — three
 * copies of a settings form is how projects end up with three different volume
 * sliders that disagree.
 *
 * Everything it changes goes through one of two stores:
 *   · the picture + display name → Account.saveProfile()  (Supabase + device)
 *   · volume / mute / shake / graphics → settings.js       (device)
 * and each change is applied to whatever is live (the audio kit, the running
 * game) immediately, so nothing needs a restart.
 */
import {
  loadSettings, saveSettings, normalizeSettings, applySettings,
  describeVolume, describeShake, describeQuality, QUALITY_CHOICES, DEFAULT_SETTINGS,
} from './settings.js';
import { fileToAvatar, paintAvatar, initialsOf, cleanAvatar } from './account-image.js';
import { describeTier } from './graphics.js';

const QUALITY_LABEL = { auto: 'AUTO', low: 'LOW', medium: 'MED', high: 'HIGH', ultra: 'ULTRA' };

export class PlayerPanel {
  /**
   * @param {object} o
   * @param {import('./account.js').Account} o.account
   * @param {() => object|null} [o.getGame]   the live Game, if a run is going
   * @param {(settings: object) => void} [o.onSettings]
   * @param {() => void} [o.onSignOut]
   */
  constructor({ account, getGame = () => null, onSettings = null, onSignOut = null } = {}) {
    this.account = account;
    this.getGame = getGame;
    this.onSettings = onSettings;
    this.onSignOut = onSignOut;
    this.settings = loadSettings();
    this.open = false;
    this.busy = false;
    this.build();
    this.paint();
    // a profile that lands late (sign-in, another tab) must refresh the portrait
    account?.on?.((kind) => {
      if (kind === 'profile' || kind === 'ready') this.paintAccount();
    });
  }

  // ------------------------------------------------------------------ markup
  build() {
    if (typeof document === 'undefined') return;
    const root = document.createElement('div');
    root.id = 'playerPanel';
    root.className = 'player-panel';
    root.innerHTML = `
      <div class="pp-card" role="dialog" aria-modal="true" aria-labelledby="ppTitle">
        <header class="pp-head">
          <h2 id="ppTitle">MY ACCOUNT</h2>
          <button class="pp-x" id="ppClose" type="button" aria-label="Close">✕</button>
        </header>
        <div class="pp-body">
          <div class="pp-id">
            <div class="pp-portrait" id="ppPortrait">?</div>
            <div class="pp-idmeta">
              <b id="ppName">GUEST</b>
              <span id="ppHandle">NOT SIGNED IN</span>
              <em id="ppMeta"></em>
              <div class="pp-pic-actions">
                <button class="pp-btn primary" id="ppPick" type="button">CHOOSE PICTURE</button>
                <button class="pp-btn" id="ppClearPic" type="button">REMOVE</button>
              </div>
            </div>
          </div>
          <p class="pp-hint" id="ppPicHint">Your picture is cropped square and shrunk to 196 px on this
            device before it is saved, so it stays small enough to sync with your friends.</p>
          <input id="ppFile" type="file" accept="image/*" style="display:none" />

          <section class="pp-section">
            <h3>AUDIO</h3>
            <div class="pp-row">
              <span>VOLUME</span>
              <input id="ppVolume" type="range" min="0" max="100" step="5" />
              <output id="ppVolumeOut">70%</output>
            </div>
            <label class="pp-row pp-toggle">
              <input id="ppMuted" type="checkbox" />
              <span>MUTE EVERYTHING</span>
            </label>
          </section>

          <section class="pp-section">
            <h3>CAMERA</h3>
            <div class="pp-row">
              <span>SCREEN SHAKE</span>
              <input id="ppShake" type="range" min="0" max="100" step="5" />
              <output id="ppShakeOut">100%</output>
            </div>
            <p class="pp-hint">Set it to 0 for a still camera — handy in storm chases.</p>
          </section>

          <section class="pp-section">
            <h3>GRAPHICS</h3>
            <div class="pp-seg" id="ppQuality"></div>
            <p class="pp-hint" id="ppQualityHint">AUTO — picked for this device</p>
          </section>

          <section class="pp-section">
            <h3>ACCOUNT</h3>
            <div class="pp-pic-actions">
              <button class="pp-btn" id="ppSignOut" type="button">SIGN OUT</button>
              <button class="pp-btn" id="ppReset" type="button">RESET SETTINGS</button>
            </div>
            <p class="pp-hint">Pictures and colours sync to your account. Volume, shake and graphics are
              saved on this device only.</p>
          </section>

          <p class="pp-note" id="ppNote"></p>
        </div>
      </div>`;
    document.body.appendChild(root);
    this.el = root;

    const $ = (id) => root.querySelector(`#${id}`);
    this.nodes = {
      portrait: $('ppPortrait'), name: $('ppName'), handle: $('ppHandle'), meta: $('ppMeta'),
      pick: $('ppPick'), clear: $('ppClearPic'), file: $('ppFile'), picHint: $('ppPicHint'),
      volume: $('ppVolume'), volumeOut: $('ppVolumeOut'), muted: $('ppMuted'),
      shake: $('ppShake'), shakeOut: $('ppShakeOut'),
      quality: $('ppQuality'), qualityHint: $('ppQualityHint'),
      signOut: $('ppSignOut'), reset: $('ppReset'), note: $('ppNote'),
    };

    $('ppClose')?.addEventListener('click', () => this.hide());
    root.addEventListener('click', (e) => { if (e.target === root) this.hide(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.open) this.hide();
    });

    this.nodes.pick?.addEventListener('click', () => this.nodes.file?.click?.());
    this.nodes.file?.addEventListener('change', (e) => this.handleFile(e?.target?.files?.[0]));
    this.nodes.clear?.addEventListener('click', () => this.clearPicture());

    this.nodes.volume?.addEventListener('input', (e) => {
      this.update({ volume: Number(e.target.value) / 100, muted: false });
    });
    this.nodes.muted?.addEventListener('change', (e) => this.update({ muted: Boolean(e.target.checked) }));
    this.nodes.shake?.addEventListener('input', (e) => {
      this.update({ shake: Number(e.target.value) / 100 });
    });

    // graphics: one button per tier, plus AUTO
    this.nodes.quality.innerHTML = '';
    QUALITY_CHOICES.forEach((id) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.quality = id;
      b.textContent = QUALITY_LABEL[id] || id.toUpperCase();
      b.title = id === 'auto' ? 'Let the game pick for this device' : describeTier(id);
      b.addEventListener('click', () => {
        this.update({ quality: id });
        this.showNote(`GRAPHICS · ${describeTier(id)}`, 'ok');
      });
      this.nodes.quality.appendChild(b);
    });

    this.nodes.signOut?.addEventListener('click', async () => {
      if (!this.account?.signedIn) { this.showNote('You are playing as a guest.', ''); return; }
      this.nodes.signOut.disabled = true;
      try { await this.account.signOut(); } catch { /* signing out is best-effort */ }
      this.nodes.signOut.disabled = false;
      this.paintAccount();
      this.onSignOut?.();
      this.hide();
    });
    this.nodes.reset?.addEventListener('click', () => {
      this.settings = saveSettings({ ...DEFAULT_SETTINGS });
      this.apply();
      this.paintSettings();
      this.showNote('Settings reset.', 'ok');
    });
  }

  // ------------------------------------------------------------------- state
  show(tab = 'account') {
    if (!this.el) return;
    this.open = true;
    this.el.classList.add('show');
    this.paint();
    if (tab === 'settings') this.nodes.volume?.focus?.();
  }

  hide() {
    this.open = false;
    this.el?.classList.remove('show');
    this.clearNote();
  }

  toggle() { this.open ? this.hide() : this.show(); }

  note(text, kind = '') {
    this.showNote(text, kind);
  }

  showNote(text, kind = '') {
    if (!this.nodes?.note) return;
    this.nodes.note.textContent = text || '';
    this.nodes.note.className = `pp-note ${kind}`;
    if (text) {
      clearTimeout(this.noteTimer);
      this.noteTimer = setTimeout(() => this.clearNote(), 6000);
    }
  }

  clearNote() {
    if (this.nodes?.note) { this.nodes.note.textContent = ''; this.nodes.note.className = 'pp-note'; }
  }

  paint() {
    this.paintAccount();
    this.paintSettings();
  }

  paintAccount() {
    const n = this.nodes;
    if (!n) return;
    const p = this.account?.profile || null;
    const signedIn = Boolean(this.account?.signedIn);
    const name = p?.display_name || p?.username || 'GUEST';
    n.name.textContent = String(name).toUpperCase().slice(0, 20);
    n.handle.textContent = signedIn ? `@${p?.username || 'player'}` : 'NOT SIGNED IN · LOCAL ONLY';
    n.meta.textContent = signedIn
      ? `BEST DAY ${p?.best_day || 0} · ACCOUNT PICTURE${p?.avatar_image ? ' ON' : ' NOT SET'}`
      : 'Sign in to keep your picture and friends on every device.';
    paintAvatar(n.portrait, { image: p?.avatar_image || '', name, color: p?.body_color || '#ffb347' });
    n.clear.disabled = !cleanAvatar(p?.avatar_image);
    n.pick.disabled = this.busy;
    n.picHint.textContent = signedIn
      ? 'Your picture is cropped square and shrunk to 196 px on this device before it is saved, so it stays small enough to sync with your friends.'
      : 'You are not signed in — a picture will be saved on this device only. Log in to sync it to your account.';
  }

  paintSettings() {
    const n = this.nodes;
    if (!n) return;
    const s = this.settings;
    if (n.volume) n.volume.value = String(Math.round(s.volume * 100));
    if (n.volumeOut) n.volumeOut.textContent = describeVolume(s);
    if (n.muted) n.muted.checked = s.muted;
    if (n.shake) n.shake.value = String(Math.round(s.shake * 100));
    if (n.shakeOut) n.shakeOut.textContent = describeShake(s);
    if (n.quality) {
      [...n.quality.children].forEach((b) => b.classList.toggle('on', b.dataset.quality === s.quality));
    }
    if (n.qualityHint) {
      n.qualityHint.textContent = s.quality === 'auto'
        ? 'AUTO — picked for this device when the run starts'
        : `${describeQuality(s)} — ${describeTier(s.quality)}`;
    }
  }

  /** Persists a patch, applies it live, and repaints the sheet. */
  update(patch) {
    this.settings = saveSettings(patch);
    this.apply();
    this.paintSettings();
    return this.settings;
  }

  /** Pushes the current settings at anything that is running right now. */
  apply() {
    const game = this.getGame?.() || null;
    applySettings(this.settings, { audio: game?.audio || null, game });
    if (game && this.settings.quality !== game.qualityOption) {
      try { game.applyQuality(this.settings.quality); } catch { /* keep the old tier */ }
    }
    this.onSettings?.(this.settings);
    return this.settings;
  }

  // ---------------------------------------------------------------- picture
  async handleFile(file) {
    if (!file) return;
    this.busy = true;
    this.paintAccount();
    this.showNote('Preparing your picture…', '');
    try {
      const image = await fileToAvatar(file);
      const profile = await this.account?.saveProfile?.({ avatar_image: image });
      this.showNote(profile?.avatar_image === image ? 'Account picture saved.' : 'Picture saved on this device.', 'ok');
      // an older schema cannot store the picture: Account explains, we relay it
      if (this.account?.lastError && !this.account?.profile?.avatar_image) {
        this.showNote(this.account.lastError, 'err');
      }
    } catch (e) {
      this.showNote(e?.message || 'That picture did not work — try another one.', 'err');
    } finally {
      this.busy = false;
      if (this.nodes?.file) this.nodes.file.value = '';
      this.paintAccount();
    }
    return this;
  }

  async clearPicture() {
    if (!this.account?.profile) return;
    this.busy = true;
    this.paintAccount();
    try {
      await this.account.saveProfile({ avatar_image: '' });
      this.showNote('Picture removed.', 'ok');
    } catch (e) {
      this.showNote(e?.message || 'Could not remove the picture.', 'err');
    } finally {
      this.busy = false;
      this.paintAccount();
    }
  }
}

/** Short initials for a name — re-exported so the lobby can paint 2-letter chips. */
export { initialsOf, normalizeSettings };

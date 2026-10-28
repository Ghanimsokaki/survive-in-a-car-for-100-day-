import { BODY_COLORS, CAR_COLORS } from './palette.js';
import { explainAuthError, validUsername } from './supabase.js';

const $ = (id) => document.getElementById(id);

/**
 * Roblox-style sign-in surface: username + password, log in / sign up tabs,
 * guest fallback and an inline Supabase connection form.
 */
export class AuthUI {
  constructor({ account, onAuthenticated, onGuest, onColorsChanged }) {
    this.account = account;
    this.onAuthenticated = onAuthenticated;
    this.onGuest = onGuest;
    this.onColorsChanged = onColorsChanged || (() => {});
    this.mode = 'login';
    this.busy = false;
    this.colors = { body: BODY_COLORS[0], car: CAR_COLORS[0] };
    this.buildSwatches();
    this.bind();
  }

  buildSwatches() {
    const bodyRow = $('signupBodyRow');
    const carRow = $('signupCarRow');
    if (!bodyRow || !carRow) return;
    const paint = (row, list, key) => {
      row.innerHTML = '';
      list.forEach((c) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `swatch ${this.colors[key] === c ? 'on' : ''}`;
        b.style.background = c;
        b.title = c;
        b.addEventListener('click', () => {
          this.colors[key] = c;
          [...row.children].forEach((x) => x.classList.toggle('on', x === b));
          this.onColorsChanged(this.colors);
        });
        row.appendChild(b);
      });
    };
    paint(bodyRow, BODY_COLORS, 'body');
    paint(carRow, CAR_COLORS, 'car');
  }

  bind() {
    document.querySelectorAll('#auth .auth-tabs button').forEach((btn) => {
      btn.addEventListener('click', () => this.setMode(btn.dataset.mode));
    });
    $('authForm')?.addEventListener('submit', (e) => { e.preventDefault(); this.submit(); });
    $('guestBtn')?.addEventListener('click', () => this.guest());
    $('connectBtn')?.addEventListener('click', () => this.openSetup());
    $('sbClose')?.addEventListener('click', () => $('sbSetup').classList.remove('show'));
    $('sbSave')?.addEventListener('click', () => this.saveSetup());
    $('sbGuest')?.addEventListener('click', () => { $('sbSetup').classList.remove('show'); this.guest(); });
  }

  setMode(mode) {
    this.mode = mode === 'signup' ? 'signup' : 'login';
    const signup = this.mode === 'signup';
    document.querySelectorAll('#auth .auth-tabs button').forEach((b) => {
      b.classList.toggle('on', b.dataset.mode === this.mode);
    });
    $('displayField')?.classList.toggle('hidden', !signup);
    $('confirmField')?.classList.toggle('hidden', !signup);
    $('signupColors')?.classList.toggle('hidden', !signup);
    const submit = $('authSubmit');
    if (submit) submit.innerHTML = `${signup ? 'CREATE ACCOUNT' : 'LOG IN'} <span>▸</span>`;
    const pass = $('authPass');
    if (pass) pass.autocomplete = signup ? 'new-password' : 'current-password';
    this.setError('');
    this.setHint(signup
      ? 'Pick a username friends can find. 6+ character password.'
      : 'Log in to sync your survivor and friends.');
  }

  setError(msg) {
    const el = $('authError');
    if (el) el.textContent = msg || '';
  }

  setHint(text) {
    const el = $('authHint');
    if (el) el.textContent = text;
  }

  setBusy(busy, label) {
    this.busy = busy;
    const btn = $('authSubmit');
    if (btn) {
      btn.disabled = busy;
      btn.style.opacity = busy ? '0.7' : '1';
      if (busy) btn.innerHTML = `${label || 'PLEASE WAIT'}…`;
    }
    document.querySelectorAll('#auth input, #auth .auth-tabs button').forEach((el) => { el.disabled = busy; });
  }

  show() {
    $('auth')?.classList.add('show');
    $('lobby')?.classList.remove('show');
    this.updateAvailability();
  }

  hide() {
    $('auth')?.classList.remove('show');
  }

  updateAvailability() {
    const can = this.account.canUseAccounts;
    const guestBtn = $('guestBtn');
    const connect = $('connectBtn');
    if (connect) connect.textContent = can ? 'SUPABASE CONNECTED' : 'CONNECT SUPABASE';
    if (guestBtn) guestBtn.style.display = 'inline-block';
    if (!can) {
      this.setHint(`No Supabase project connected yet — play as guest, or tap CONNECT SUPABASE. ${this.account.describeConfig?.() || ''}`.trim());
      const submit = $('authSubmit');
      if (submit && !this.busy) submit.innerHTML = 'ACCOUNTS OFFLINE <span>▸</span>';
    } else {
      this.setMode(this.mode);
    }
  }

  async submit() {
    if (this.busy) return;
    if (!this.account.canUseAccounts) {
      this.openSetup();
      return;
    }
    const username = $('authUser')?.value?.trim() || '';
    const password = $('authPass')?.value || '';
    const display = $('authDisplay')?.value?.trim() || '';
    const confirm = $('authPass2')?.value || '';

    if (!validUsername(username)) { this.setError('Username: 3–16 letters, numbers or underscores.'); return; }
    if (password.length < 6) { this.setError('Password must be at least 6 characters.'); return; }
    if (this.mode === 'signup' && password !== confirm) { this.setError('Passwords do not match.'); return; }

    this.setError('');
    this.setBusy(true, this.mode === 'signup' ? 'CREATING' : 'LOGGING IN');
    try {
      const profile = this.mode === 'signup'
        ? await this.account.signUp(username, password, display, this.colors)
        : await this.account.signIn(username, password);
      this.setBusy(false);
      $('authPass').value = '';
      $('authPass2').value = '';
      this.onAuthenticated(profile || this.account.profile);
    } catch (e) {
      this.setBusy(false);
      this.setError(explainAuthError(e));
      this.setMode(this.mode);
    }
  }

  guest() {
    const name = ($('authUser')?.value || '').trim().toUpperCase().slice(0, 14) || 'WANDERER';
    const profile = this.account.useGuest(name, this.colors);
    this.onGuest(profile);
  }

  openSetup() {
    const el = $('sbSetup');
    if (!el) return;
    el.classList.add('show');
    this.renderSetupStatus();
  }

  /** Shows exactly what the deployment sees, so env-var problems are visible on a phone. */
  renderSetupStatus() {
    const box = $('sbStatus');
    if (!box) return;
    const account = this.account;
    const report = account.configReport || {};
    const env = report.server?.env;
    const ok = (flag) => (flag ? '<b class="st-ok">✓</b>' : '<b class="st-no">✗</b>');

    if (account.canUseAccounts) {
      const source = { server: 'server env', build: 'build-time config', local: 'this device', inline: 'inline config' }[account.configSource] || account.configSource;
      box.innerHTML = `<div class="st-row st-good">CONNECTED — credentials from ${source}</div>`;
      return;
    }

    const rows = [];
    if (env) {
      rows.push(`<div class="st-row">VERCEL / SERVER ENV — URL ${ok(env.hasUrl)} · ANON KEY ${ok(env.hasKey)}</div>`);
      if (env.hasKey && env.keyKind === 'secret') {
        rows.push('<div class="st-row st-bad">That key is a service_role/secret key. Use the anon public key instead.</div>');
      }
    } else if (report.server?.error) {
      rows.push(`<div class="st-row st-bad">Server config unreachable: ${report.server.error}</div>`);
    } else {
      rows.push('<div class="st-row st-bad">No /api/config endpoint — this looks like a static host.</div>');
    }
    if (report.build) rows.push(`<div class="st-row">BUILD CONFIG.JSON ${ok(report.build.found)}</div>`);
    if (report.local) rows.push(`<div class="st-row">THIS DEVICE ${ok(report.local.found)}</div>`);

    const problems = [...(report.server?.problems || []), ...(report.build?.problems || [])];
    for (const p of problems.slice(0, 3)) rows.push(`<div class="st-row st-bad">${p}</div>`);

    box.innerHTML = rows.join('');
  }

  saveSetup() {
    const url = $('sbUrl')?.value?.trim();
    const key = $('sbKey')?.value?.trim();
    const err = $('sbError');
    if (!url || !key) { if (err) err.textContent = 'Both fields are required.'; return; }
    if (!/^https?:\/\//i.test(url)) { if (err) err.textContent = 'URL should start with https://'; return; }
    this.account.saveLocalConfig(url, key);
    if (err) err.textContent = 'Saved — reloading…';
    setTimeout(() => location.reload(), 500);
  }
}

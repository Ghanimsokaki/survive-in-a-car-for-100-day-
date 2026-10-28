/**
 * Backpack + hotbar.
 *
 * · Materials (scrap/steel/…) stay in the run's material pool so the existing
 *   crafting costs keep working.
 * · Everything else is a stackable item kept here: medkits, fuel cans, repair
 *   kits, flares, gear.
 * · Eight hotbar slots, bound to keys 1–8 (and tappable on a phone).
 */
import { ITEMS, MATERIALS, itemName, itemGlyph, itemColor, itemKind, isUsable } from './items.js';

export const HOTBAR_SLOTS = 8;
export const PACK_SLOTS = 30;

export class Inventory {
  constructor() {
    this.items = new Map();      // id -> qty
    this.hotbar = new Array(HOTBAR_SLOTS).fill(null);
    this.capacity = PACK_SLOTS;
    this.listeners = new Set();
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { this.listeners.forEach((fn) => { try { fn(this); } catch {} }); }

  get slotsUsed() { return this.items.size; }
  get full() { return this.items.size >= this.capacity; }

  count(id) { return this.items.get(id) || 0; }

  /** Adds stacks, respecting per-item stack limits. Returns how many were stored. */
  add(id, qty = 1) {
    if (!ITEMS[id] || qty <= 0) return 0;
    const cap = ITEMS[id].stack || 99;
    const current = this.count(id);
    const room = cap - current;
    if (room <= 0) return 0;
    if (!this.items.has(id) && this.full) return 0;
    const stored = Math.min(room, qty);
    this.items.set(id, current + stored);
    // auto-fill the first empty hotbar slot the first time you find something usable
    if (isUsable(id) && !this.hotbar.includes(id)) {
      const free = this.hotbar.indexOf(null);
      if (free >= 0) this.hotbar[free] = id;
    }
    this.emit();
    return stored;
  }

  remove(id, qty = 1) {
    const current = this.count(id);
    if (current <= 0) return 0;
    const taken = Math.min(current, qty);
    const left = current - taken;
    if (left <= 0) {
      this.items.delete(id);
      for (let i = 0; i < this.hotbar.length; i++) if (this.hotbar[i] === id) this.hotbar[i] = null;
    } else {
      this.items.set(id, left);
    }
    this.emit();
    return taken;
  }

  has(id, qty = 1) { return this.count(id) >= qty; }

  /** Slot index 0-7 → item id or null. */
  assign(slot, id) {
    if (slot < 0 || slot >= this.hotbar.length) return false;
    if (id && !this.items.has(id)) return false;
    this.hotbar[slot] = id || null;
    this.emit();
    return true;
  }

  clearSlot(slot) { return this.assign(slot, null); }

  /** Moves an item between the pack and the hotbar (first free slot). */
  toggleOnHotbar(id) {
    const at = this.hotbar.indexOf(id);
    if (at >= 0) { this.hotbar[at] = null; this.emit(); return 'removed'; }
    const free = this.hotbar.indexOf(null);
    if (free < 0) return 'full';
    this.hotbar[free] = id;
    this.emit();
    return 'added';
  }

  list() {
    return [...this.items.entries()]
      .map(([id, qty]) => ({ id, qty, ...ITEMS[id] }))
      .sort((a, b) => (b.rarity || 1) - (a.rarity || 1) || a.name.localeCompare(b.name));
  }

  toJSON() {
    return { items: [...this.items], hotbar: [...this.hotbar] };
  }
}

/* ------------------------------------------------------------------ UI ---- */
const $ = (id) => document.getElementById(id);

/** Backpack tabs — the pack mixes consumables, gear and salvage, so let people narrow it. */
export const FILTERS = [
  { id: 'all', label: 'ALL', test: () => true },
  { id: 'use', label: 'USABLE', test: (it) => isUsable(it.id) },
  { id: 'gear', label: 'GEAR', test: (it) => itemKind(it.id) === 'gear' },
  { id: 'mat', label: 'SALVAGE', test: (it) => itemKind(it.id) === 'material' },
];

const KIND_RANK = { consumable: 0, gear: 1, material: 2 };

/** Usables float to the top of the list, then gear, then raw salvage; ties broken by name. */
export function sortItems(list) {
  return [...list].sort((a, b) => {
    const k = (KIND_RANK[itemKind(a.id)] ?? 3) - (KIND_RANK[itemKind(b.id)] ?? 3);
    return k || String(a.name).localeCompare(String(b.name));
  });
}

export class InventoryUI {
  constructor(inventory, { onUse, onToss, getMaterials } = {}) {
    this.inv = inventory;
    this.onUse = onUse || (() => {});
    this.onToss = onToss || null;
    this.getMaterials = getMaterials || (() => ({}));
    this.selected = 0;
    this.open = false;
    this.filter = 'all';
    this.el = {
      bar: $('hotbar'),
      panel: $('invPanel'),
      grid: $('invGrid'),
      mats: $('invMats'),
      filter: $('invFilter'),
      empty: $('invEmpty'),
      close: $('invClose'),
      weight: $('invCount'),
    };
    this.bind();
    this.inv.on(() => this.render());
    this.render();
  }

  bind() {
    this.el.close?.addEventListener('click', () => this.hide());
    this.el.panel?.addEventListener('click', (ev) => { if (ev.target === this.el.panel) this.hide(); });
    this.el.filter?.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-filter]');
      if (!btn) return;
      this.filter = btn.dataset.filter;
      this.render();
    });
    this.el.bar?.addEventListener('click', (ev) => {
      const slot = ev.target.closest('[data-slot]');
      if (!slot) return;
      this.useSlot(Number(slot.dataset.slot));
    });
    this.el.grid?.addEventListener('click', (ev) => {
      const tossBtn = ev.target.closest('[data-toss]');
      if (tossBtn && this.onToss) {
        ev.stopPropagation?.();
        this.onToss(tossBtn.dataset.toss);
        this.render();
        return;
      }
      const useBtn = ev.target.closest('[data-use]');
      if (useBtn) {
        ev.stopPropagation?.();
        const id = useBtn.dataset.use;
        if (this.onUse(id, -1)) this.inv.remove(id, 1);
        this.render();
        return;
      }
      const cell = ev.target.closest('[data-item]');
      if (!cell) return;
      this.inv.toggleOnHotbar(cell.dataset.item);
    });
  }

  show() {
    this.open = true;
    this.el.panel?.classList.add('show');
    this.render();
  }

  hide() {
    this.open = false;
    this.el.panel?.classList.remove('show');
  }

  toggle() { return this.open ? this.hide() : this.show(); }

  /** Uses a hotbar slot; returns the item id that was consumed (or null). */
  useSlot(slot) {
    this.selected = slot;
    const id = this.inv.hotbar[slot];
    if (!id || !this.inv.has(id)) { this.render(); return null; }
    if (!isUsable(id)) { this.render(); return null; }
    const used = this.onUse(id, slot);
    if (used) this.inv.remove(id, 1);
    this.render();
    return used ? id : null;
  }

  render() {
    const bar = this.el.bar;
    if (bar) {
      bar.innerHTML = this.inv.hotbar.map((id, i) => {
        const has = id && this.inv.has(id);
        const it = id ? ITEMS[id] : null;
        return `<button class="hot-slot${has ? ' has' : ''}${i === this.selected ? ' sel' : ''}" data-slot="${i}" type="button"
          style="--c:#${itemColor(id || 'scrap').toString(16).padStart(6, '0')}">
          <em>${i + 1}</em>
          <span class="hot-glyph">${has ? itemGlyph(id) : ''}</span>
          <span class="hot-name">${has ? itemName(id) : ''}</span>
          <b>${has ? this.inv.count(id) : ''}</b>
        </button>`;
      }).join('');
    }

    if (this.el.mats) {
      const mats = this.getMaterials() || {};
      this.el.mats.innerHTML = MATERIALS.map((id) => {
        const qty = mats[id] || 0;
        return `<span class="inv-mat${qty ? '' : ' empty'}" style="--c:#${itemColor(id).toString(16).padStart(6, '0')}">
          <i>${itemGlyph(id)}</i><b>${qty}</b><em>${itemName(id)}</em></span>`;
      }).join('');
    }

    if (this.el.filter) {
      const all = this.inv.list();
      this.el.filter.innerHTML = FILTERS.map((f) => {
        const n = f.id === 'all' ? all.length : all.filter(f.test).length;
        return `<button class="inv-filter${this.filter === f.id ? ' on' : ''}" data-filter="${f.id}" type="button">
          ${f.label}<b>${n}</b></button>`;
      }).join('');
    }

    if (this.el.grid) {
      const list = sortItems(this.inv.list().filter(FILTERS.find((f) => f.id === this.filter)?.test || (() => true)));
      this.el.empty?.classList.toggle('hidden', list.length > 0);
      this.el.grid.innerHTML = list.map((it) => {
        const onBar = this.inv.hotbar.includes(it.id);
        return `<button class="inv-cell${onBar ? ' on-bar' : ''}" data-item="${it.id}" type="button"
          style="--c:#${itemColor(it.id).toString(16).padStart(6, '0')}">
          <span class="inv-glyph">${it.glyph || '▪'}</span>
          <b>${it.qty}</b>
          <span class="inv-name">${it.name}</span>
          <span class="inv-desc">${it.desc || (onBar ? 'ON HOTBAR' : 'TAP TO ADD TO HOTBAR')}</span>
          ${isUsable(it.id) ? `<span class="inv-use" data-use="${it.id}">USE</span>` : ''}
          ${this.onToss && itemKind(it.id) !== 'material'
            ? `<span class="inv-toss" data-toss="${it.id}" title="Drop this stack">TOSS</span>` : ''}
        </button>`;
      }).join('');
      if (this.el.weight) this.el.weight.textContent = `${this.inv.list().length}/${this.inv.capacity}`;
    }
  }
}

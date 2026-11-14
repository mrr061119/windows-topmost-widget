'use strict';

const dom = {
  root: document.documentElement,
  blocks: document.getElementById('blocks'),
};

/** id -> { el: HTMLElement, sig: string } */
const cache = new Map();

function toSrc(s) {
  if (!s) return '';
  if (/^(https?:|data:|file:)/i.test(s)) return s;
  if (/^[a-zA-Z]:[\\/]/.test(s)) return 'file:///' + s.replace(/\\/g, '/');
  return s;
}

function buildBlock(b) {
  const kind = b.kind || 'text';

  if (kind === 'divider') {
    const d = document.createElement('div');
    d.className = 'b-divider';
    return d;
  }

  if (kind === 'progress') {
    const wrap = document.createElement('div');
    wrap.className = 'b-progress';
    if (b.label) {
      const l = document.createElement('div');
      l.className = 'b-label';
      l.textContent = b.label;
      wrap.appendChild(l);
    }
    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('div');
    fill.className = 'fill';
    const v = typeof b.value === 'number' ? b.value : 0;
    fill.style.width = Math.round(Math.max(0, Math.min(1, v)) * 100) + '%';
    if (b.color) fill.style.background = b.color;
    bar.appendChild(fill);
    wrap.appendChild(bar);
    return wrap;
  }

  if (kind === 'image') {
    const img = document.createElement('img');
    img.className = 'b-img';
    img.src = toSrc(b.src);
    if (b.w) img.style.width = b.w + 'px';
    if (b.h) img.style.height = b.h + 'px';
    img.addEventListener('error', () => img.remove());
    return img;
  }

  if (kind === 'row') {
    const r = document.createElement('div');
    r.className = 'b-row';
    const l = document.createElement('span');
    l.className = 'label';
    l.textContent = b.label || '';
    const v = document.createElement('span');
    v.className = 'value';
    v.textContent = b.text != null ? String(b.text) : '';
    if (b.color) v.style.color = b.color;
    r.append(l, v);
    return r;
  }

  // text（默认）
  const wrap = document.createElement('div');
  if (b.label) {
    const l = document.createElement('div');
    l.className = 'b-label';
    l.textContent = b.label;
    wrap.appendChild(l);
  }
  const t = document.createElement('div');
  t.className = 'b-text';
  if (b.weight === 'bold' || (typeof b.size === 'number' && b.size >= 15)) t.classList.add('is-title');
  if (typeof b.size === 'number') t.style.fontSize = b.size + 'px';
  if (b.color) t.style.color = b.color;
  t.textContent = b.text != null ? String(b.text) : '';
  wrap.appendChild(t);
  return wrap;
}

function renderEmpty() {
  const d = document.createElement('div');
  d.className = 'empty';
  d.textContent = '等待数据 · POST /api/v1/render';
  return d;
}

let fitTimer = null;
let lastFit = 0;

/** 内容变化后把窗口高度压到刚好包住内容（底部对齐） */
function scheduleFit() {
  if (fitTimer) clearTimeout(fitTimer);
  fitTimer = setTimeout(() => {
    const card = document.getElementById('card');
    if (!card) return;
    const h = Math.ceil(card.getBoundingClientRect().height);
    if (h > 0 && Math.abs(h - lastFit) >= 2) {
      lastFit = h;
      window.widgetApi.resize(h);
    }
  }, 80);
}

function render(state) {
  dom.root.style.setProperty('--accent', state.accent || '#5ac8fa');

  const blocks = Array.isArray(state.blocks) ? state.blocks : [];
  const ordered = [];

  for (const b of blocks) {
    if (!b || !b.id) continue;
    let rec = cache.get(b.id);
    if (!rec) {
      rec = { el: document.createElement('div'), sig: '' };
      cache.set(b.id, rec);
    }
    rec.el.className = 'b-item b-item-' + (b.kind || 'text');
    const sig = JSON.stringify(b);
    if (rec.sig !== sig) {
      rec.el.replaceChildren(buildBlock(b));
      rec.sig = sig;
    }
    ordered.push(rec.el);
  }

  const alive = new Set(blocks.map((b) => b && b.id).filter(Boolean));
  for (const [id, rec] of cache) {
    if (!alive.has(id)) {
      rec.el.remove();
      cache.delete(id);
    }
  }

  const toasts = Array.from(dom.blocks.querySelectorAll('.toast'));

  if (ordered.length === 0) {
    dom.blocks.replaceChildren(...toasts, renderEmpty());
  } else {
    dom.blocks.replaceChildren(...toasts, ...ordered);
  }

  scheduleFit();
}

function toast(t) {
  if (!t || !t.text) return;
  const d = document.createElement('div');
  d.className = 'toast ' + (t.kind || 'info');
  d.textContent = t.text;

  // 插到内容流最前面，跟着窗口一起撑高，不遮挡已有内容
  dom.blocks.insertBefore(d, dom.blocks.firstChild);
  scheduleFit();

  const ttl = typeof t.ttl_ms === 'number' && t.ttl_ms > 0 ? t.ttl_ms : 4000;
  setTimeout(() => {
    d.classList.add('out');
    setTimeout(() => {
      d.remove();
      scheduleFit();
    }, 220);
  }, ttl);
}

window.widgetApi.onState(render);
window.widgetApi.onToast(toast);
window.widgetApi.ready();

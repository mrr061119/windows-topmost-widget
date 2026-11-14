'use strict';

/**
 * topmost-widget 主进程
 *
 * 职责：
 *   1. 一个透明、无边框、始终置顶、不进任务栏的窗口
 *   2. 本地 HTTP 接口，让任意语言往里推内容（block 模型）
 *   3. 置顶守护：周期性重申 topmost，压过抢 Z 序的其它置顶窗口
 *   4. 托盘图标：隐藏 / 显示 / 退出
 *
 * 自包含：不引用本目录以外的任何路径。
 */

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, clipboard } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.WIDGET_PORT || 7788);
const HOST = '127.0.0.1';
const TOKEN = process.env.WIDGET_TOKEN || '';

const DEFAULT_W = 420;
const DEFAULT_H = 300;
const GUARD_MS = 1500;

const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'widget.log');
const LOG_MAX = 2 * 1024 * 1024;

let win = null;
let tray = null;
let guardTimer = null;
let quitting = false;
let visible = true;

/**
 * 窗口锚点（DIP）：x 与顶边固定，高度变化时向下长。
 * 不用 getBounds() 反算 —— 透明窗口在 resize 后返回值可能滞后，
 * 连续 resize 会累积漂移，实测窗口跑到副屏外。
 */
let anchor = null;

/** 自己的 setBounds 会触发 move，别让它把 anchor 冲掉 */
let resizingInternally = false;

/** 位置持久化：下次启动还回原来的地方 */
const STATE_FILE = path.join(__dirname, 'state.json');
let savePosTimer = null;

/** @type {{accent:string,title:string,blocks:Array<object>}} */
const state = { accent: '#5ac8fa', title: '', blocks: [] };

/* ------------------------------------------------------------------ log */

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const st = fs.statSync(LOG_FILE, { throwIfNoEntry: false });
    if (st && st.size > LOG_MAX) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    fs.appendFileSync(LOG_FILE, line + '\r\n');
  } catch (e) {
    /* 日志写不进去不影响主流程 */
  }
}

/* ------------------------------------------------------------------ state */

function publicState() {
  return {
    accent: state.accent,
    title: state.title,
    visible,
    blocks: state.blocks.map((b) => {
      const { _exp, ...rest } = b;
      return rest;
    }),
  };
}

function broadcast() {
  if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
    win.webContents.send('state:update', publicState());
  }
}

/* ---------------------------------------------------------------- window */

function loadSavedPos() {
  try {
    const o = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (Number.isFinite(o.x) && Number.isFinite(o.y)) {
      return { x: Math.round(o.x), y: Math.round(o.y) };
    }
  } catch (e) {
    /* 没存过、或者存坏了，走默认位置 */
  }
  return null;
}

function savePosSoon(x, y) {
  if (savePosTimer) clearTimeout(savePosTimer);
  savePosTimer = setTimeout(() => {
    savePosTimer = null;
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify({ x: Math.round(x), y: Math.round(y) }, null, 2), 'utf8');
    } catch (e) {
      /* 写不进去不影响运行 */
    }
  }, 600);
}

/** 这个点还落在某块屏幕的工作区里吗（至少露出 40px） */
function isOnSomeScreen(x, y, w, h) {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    const ix = Math.min(x + w, a.x + a.width) - Math.max(x, a.x);
    const iy = Math.min(y + h, a.y + a.height) - Math.max(y, a.y);
    return ix >= 40 && iy >= 24;
  });
}

function createWindow() {
  const d = screen.getPrimaryDisplay();
  const wa = d.workArea;

  // 默认位置：屏幕左上角 (1,1)；用户拖过之后以 state.json 里的为准
  let x = 1;
  let y = 1;

  const saved = loadSavedPos();
  if (saved && isOnSomeScreen(saved.x, saved.y, DEFAULT_W, DEFAULT_H)) {
    x = saved.x;
    y = saved.y;
    log('restored position', x, y);
  }

  anchor = { x, y, width: DEFAULT_W };

  win = new BrowserWindow({
    width: DEFAULT_W,
    height: DEFAULT_H,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setMenuBarVisibility(false);

  win.loadFile(path.join(__dirname, 'ui', 'index.html'));

  win.once('ready-to-show', () => {
    win.showInactive();
    log('window shown');
  });

  win.webContents.on('did-finish-load', () => broadcast());

  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      setVisible(false);
    }
  });

  win.on('closed', () => {
    win = null;
  });

  // 用户拖动窗口后，锚点跟着走，并记住位置；否则下次内容变化会跳回原位
  const onMoved = () => {
    if (resizingInternally || !win || win.isDestroyed()) return;
    const b = win.getBounds();
    anchor = { x: b.x, y: b.y, width: b.width };
    savePosSoon(b.x, b.y);
  };
  win.on('move', onMoved);
  win.on('moved', onMoved);
}

function startGuard() {
  if (guardTimer) return;
  guardTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !visible) return;
    try {
      win.setAlwaysOnTop(true, 'screen-saver');
      guardPosition();
    } catch (e) {
      /* 窗口正在销毁时忽略 */
    }
  }, GUARD_MS);
}

/** 窗口跑到所有显示器之外时拉回主屏右下角 */
function guardPosition() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const areas = screen.getAllDisplays().map((d) => d.workArea);
  const visibleSomewhere = areas.some(
    (w) =>
      b.x < w.x + w.width &&
      b.x + b.width > w.x &&
      b.y < w.y + w.height &&
      b.y + b.height > w.y
  );
  if (visibleSomewhere) return;

  const w0 = screen.getPrimaryDisplay().workArea;
  anchor = {
    x: 1,
    y: 1,
    width: DEFAULT_W,
  };
  log('position guard: reset to primary, was', JSON.stringify(b));
  resizingInternally = true;
  win.setBounds({
    x: anchor.x,
    y: anchor.y,
    width: anchor.width,
    height: b.height,
  });
  savePosSoon(anchor.x, anchor.y);
  setTimeout(() => {
    resizingInternally = false;
  }, 120);
}

function setVisible(v) {
  visible = !!v;
  if (!win || win.isDestroyed()) return;
  if (visible) {
    win.showInactive();
    win.setAlwaysOnTop(true, 'screen-saver');
  } else {
    win.hide();
  }
  broadcast();
}

/* ------------------------------------------------------------------ tray */

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray.png');
  let img;
  try {
    img = nativeImage.createFromPath(iconPath);
    if (img.isEmpty()) throw new Error('empty icon');
  } catch (e) {
    img = nativeImage.createEmpty();
  }

  tray = new Tray(img.resize({ width: 16, height: 16 }));
  tray.setToolTip('topmost-widget');

  const rebuild = () => {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: visible ? '隐藏窗口' : '显示窗口',
          click: () => setVisible(!visible),
        },
        { type: 'separator' },
        {
          label: '复制接口地址',
          click: () => clipboard.writeText(`http://${HOST}:${PORT}`),
        },
        {
          label: '打开日志目录',
          click: () => {
            const { shell } = require('electron');
            shell.openPath(LOG_DIR);
          },
        },
        { type: 'separator' },
        {
          label: '退出',
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ])
    );
  };

  rebuild();
  tray.on('click', () => setVisible(!visible));

  const t = setInterval(() => {
    if (!tray || tray.isDestroyed()) return clearInterval(t);
    rebuild();
  }, 2000);
}

/* ------------------------------------------------------------------ http */

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('invalid json: ' + e.message));
      }
    });
    req.on('error', reject);
  });
}

/** 只保留白名单字段，避免外部塞奇怪的东西进渲染层 */
function sanitizeBlock(b) {
  if (!b || typeof b !== 'object' || typeof b.id !== 'string' || !b.id) return null;
  const kind = String(b.kind || 'text');
  const out = {
    id: b.id.slice(0, 120),
    kind,
    label: b.label != null ? String(b.label).slice(0, 80) : undefined,
    text: b.text != null ? String(b.text).slice(0, 4000) : undefined,
    value: typeof b.value === 'number' ? Math.max(0, Math.min(1, b.value)) : undefined,
    color: typeof b.color === 'string' ? b.color.slice(0, 32) : undefined,
    size: typeof b.size === 'number' ? Math.max(8, Math.min(72, b.size)) : undefined,
    weight: b.weight === 'bold' ? 'bold' : undefined,
    src: typeof b.src === 'string' ? b.src.slice(0, 1024) : undefined,
    w: typeof b.w === 'number' ? b.w : undefined,
    h: typeof b.h === 'number' ? b.h : undefined,
    // 越小越靠上；不给就是 100
    priority: typeof b.priority === 'number' ? b.priority : undefined,
  };
  if (out.src && !/^(file:|https?:|data:image)/i.test(out.src) && !/^[a-zA-Z]:[\\/]/.test(out.src)) {
    out.src = undefined;
  }
  return out;
}

let blockSeq = 0;

/** 按 priority 升序（小在上），同优先级保持插入顺序 */
function sortBlocks() {
  state.blocks.sort((a, b) => {
    const pa = typeof a.priority === 'number' ? a.priority : 100;
    const pb = typeof b.priority === 'number' ? b.priority : 100;
    if (pa !== pb) return pa - pb;
    return (a._seq ?? 0) - (b._seq ?? 0);
  });
}

function upsertBlock(block, ttlMs) {
  const i = state.blocks.findIndex((b) => b.id === block.id);
  if (ttlMs && ttlMs > 0) block._exp = Date.now() + ttlMs;
  else delete block._exp;
  if (i >= 0) {
    block._seq = state.blocks[i]._seq ?? ++blockSeq;
    state.blocks[i] = block;
  } else {
    block._seq = ++blockSeq;
    state.blocks.push(block);
  }
  sortBlocks();
}

function sweepExpired() {
  const now = Date.now();
  const before = state.blocks.length;
  state.blocks = state.blocks.filter((b) => !b._exp || b._exp > now);
  if (state.blocks.length !== before) broadcast();
}

function startHttp() {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return sendJson(res, 204, {});

    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const p = url.pathname.replace(/\/+$/, '') || '/';

    if (TOKEN) {
      const auth = req.headers['authorization'] || '';
      if (auth !== `Bearer ${TOKEN}`) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    }

    try {
      if (req.method === 'GET' && (p === '/health' || p === '/api/v1/health')) {
        return sendJson(res, 200, {
          ok: true,
          uptime_s: Math.round(process.uptime()),
          blocks: state.blocks.length,
          visible,
        });
      }

      if (req.method === 'GET' && p === '/api/v1/state') {
        return sendJson(res, 200, { ok: true, state: publicState() });
      }

      if (req.method === 'POST' && p === '/api/v1/render') {
        const body = await readBody(req);
        if (typeof body.accent === 'string') state.accent = body.accent.slice(0, 32);
        state.title = body.title != null ? String(body.title).slice(0, 120) : state.title;
        if (Array.isArray(body.blocks)) {
          const ttl = Number(body.ttl_ms) || 0;
          state.blocks = body.blocks.map(sanitizeBlock).filter(Boolean);
          state.blocks.forEach((b, i) => { b._seq = i + 1; });
          blockSeq = Math.max(blockSeq, state.blocks.length);
          sortBlocks();
          if (ttl > 0) {
            const exp = Date.now() + ttl;
            for (const b of state.blocks) b._exp = exp;
          }
        }
        broadcast();
        return sendJson(res, 200, { ok: true, blocks: state.blocks.length });
      }

      if (req.method === 'POST' && p === '/api/v1/patch') {
        const body = await readBody(req);
        const id = typeof body.id === 'string' ? body.id : null;
        if (!id) return sendJson(res, 400, { ok: false, error: 'id required' });

        if (body.remove) {
          state.blocks = state.blocks.filter((b) => b.id !== id);
          broadcast();
          return sendJson(res, 200, { ok: true, removed: id });
        }

        const b = sanitizeBlock({ ...(body.block || {}), id });
        if (!b) return sendJson(res, 400, { ok: false, error: 'invalid block' });
        upsertBlock(b, Number(body.ttl_ms) || 0);
        broadcast();
        return sendJson(res, 200, { ok: true, blocks: state.blocks.length });
      }

      if (req.method === 'POST' && p === '/api/v1/toast') {
        const body = await readBody(req);
        const text = body.text != null ? String(body.text).slice(0, 4000) : '';
        if (!text) return sendJson(res, 400, { ok: false, error: 'text required' });
        if (win && !win.isDestroyed()) {
          win.webContents.send('toast', {
            text,
            kind: ['info', 'ok', 'warn', 'err'].includes(body.kind) ? body.kind : 'info',
            ttl_ms: Number(body.ttl_ms) > 0 ? Number(body.ttl_ms) : 4000,
          });
        }
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && p === '/api/v1/visibility') {
        const body = await readBody(req);
        setVisible(body.visible !== false);
        return sendJson(res, 200, { ok: true, visible });
      }

      if (req.method === 'POST' && p === '/api/v1/window') {
        const body = await readBody(req);
        if (!win || win.isDestroyed()) return sendJson(res, 503, { ok: false, error: 'no window' });
        const cur = win.getBounds();
        const x = Number.isFinite(body.x) ? Math.round(body.x) : cur.x;
        const y = Number.isFinite(body.y) ? Math.round(body.y) : cur.y;
        const width = Number.isFinite(body.width) ? Math.max(120, Math.round(body.width)) : cur.width;
        const height = Number.isFinite(body.height) ? Math.max(80, Math.round(body.height)) : cur.height;
        win.setBounds({ x, y, width, height });
        anchor = { x, y, width };
        savePosSoon(x, y);
        if (Number.isFinite(body.opacity)) {
          win.setOpacity(Math.max(0.1, Math.min(1, body.opacity)));
        }
        broadcast();
        return sendJson(res, 200, { ok: true, bounds: win.getBounds() });
      }

      if (req.method === 'POST' && p === '/api/v1/quit') {
        sendJson(res, 200, { ok: true });
        log('quit via http');
        setTimeout(() => {
          quitting = true;
          app.quit();
        }, 100);
        return;
      }

      return sendJson(res, 404, { ok: false, error: 'not found', path: p });
    } catch (e) {
      log('http error', e.message);
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  });

  server.on('error', (e) => {
    log('http server error:', e.message);
    if (e.code === 'EADDRINUSE') {
      log(`端口 ${PORT} 被占用，换一个：set WIDGET_PORT=7799`);
    }
  });

  server.listen(PORT, HOST, () => {
    log(`http listening on http://${HOST}:${PORT}`);
  });
}

/* ------------------------------------------------------------------ app */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    setVisible(true);
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver');
  });

  app.whenReady().then(() => {
    log('starting, port', PORT);
    createWindow();
    createTray();
    startGuard();
    startHttp();
    setInterval(sweepExpired, 1000);

    ipcMain.on('renderer:ready', () => broadcast());
    ipcMain.on('widget:hide', () => setVisible(false));
    ipcMain.on('widget:resize', (_e, h) => {
      if (!win || win.isDestroyed() || !anchor) return;
      const nh = Math.max(40, Math.min(900, Math.round(Number(h) || 0)));
      const b = win.getBounds();
      if (nh === b.height) return;
      resizingInternally = true;
      win.setBounds({
        x: anchor.x,
        y: anchor.y,
        width: anchor.width,
        height: nh,
      });
      setTimeout(() => {
        resizingInternally = false;
      }, 120);
    });
  });

  app.on('before-quit', () => {
    quitting = true;
    if (guardTimer) clearInterval(guardTimer);
    log('quitting');
  });

  app.on('window-all-closed', () => {});
}


// dsh-widget-status: 把 DSH 会话状态推到 topmost-widget（127.0.0.1:7788）。
//
// 每个会话一块，互不覆盖：块 id = `dsh:state:<sessionId>`。
// 前缀是 WebUI 里的会话标题（session.header.title），超过 labelMax 截断。
//
// 三态：
//   working  正在工作  蓝  —— 收到 user/message
//   done     已完成    绿  —— turn/end 后停留 doneHoldMs（默认 4 秒），然后移除
//   waiting  等你选择  灰  —— 只有 approval/asked 或 ask_user_question 才进；
//                              文案按等待时长换档、每 20 秒随机换一句，用户回复后回 working
//
// 另外在「需要你抬头看一眼」的时刻直接弹 toast（/api/v1/toast，自动消失）：
//   turn/end  completed → ok / error → err / max-tokens → warn
//   approval/asked       → warn（工具名）
// 这是系统通知的替代：dsh-pet 的 Windows 通知已关掉，通知统一走这块置顶窗口。
//
// 只监听会话事件，不碰消息内容；widget 没起时静默失败，绝不拖慢会话。

import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

export const name = 'widget-status'
// sessions 必须要 inject，否则 ctx.get('sessions') 拿不到服务
export const inject = ['agents', 'sessions']

const DEFAULTS = {
  endpoint: 'http://127.0.0.1:7788',
  blockPrefix: 'dsh:state:',
  doneHoldMs: 4000,
  waitTtlMs: 30000,
  labelMax: 18,
  fallbackLabel: 'DSH',
  // 越小越靠上：会话状态 10，下载 50，通知 5
  priority: 10,
  // 标题兜底：session header 没有 title，就从会话日志里找第一条用户消息
  sessionsRoot: 'C:\\DSH\\harness\\home\\sessions',
  // 完成任务 / 失败 / 等你批准时弹一条 toast；关掉就只剩状态行
  toast: true,
  toastTtlMs: 6000,
}

const VIEWS = {
  working: {
    color: '#5ac8fa',
    rotateMs: 15000,
    lines: ['本鱼在干活', '正忙着呢', '稍等，本鱼在弄', '动工中……', '本鱼这就办', '手上正忙'],
  },
  done: {
    color: '#4ade80',
    lines: ['干完了', '搞定', '喏，好了', '本鱼交差', '办妥了', '收工'],
  },
  waiting: { color: '#8b93a7', lines: null },
}

/** 从一组句子里随机挑，避开上一句 */
function pickLine(lines, avoid) {
  if (!Array.isArray(lines) || lines.length === 0) return ''
  if (lines.length === 1) return lines[0]
  let line = lines[Math.floor(Math.random() * lines.length)]
  if (line === avoid) line = lines[(lines.indexOf(line) + 1) % lines.length]
  return line
}

// 等用户选择时说的话：等得越久越不耐烦，每档随机挑一句。
// 只有「需要你拍板」的时候才会进这个状态（审批 / ask_user_question）。
const WAIT_TIERS = [
  {
    until: 30e3,
    lines: ['本鱼问了一句，你选个呗', '上面那个要你定', '喏，等你点一下', '本鱼在这儿等着呢'],
  },
  {
    until: 120e3,
    lines: ['老大～还在吗', '慢慢看，本鱼不催', '选好了叫本鱼一声', '本鱼先等着，你忙'],
  },
  {
    until: 300e3,
    lines: ['喂——别把本鱼晾着', '鼠标都等凉了', '本鱼盯屏幕发呆中……', '你是不是切别的窗口了'],
  },
  {
    until: Infinity,
    lines: [
      '再不回，本鱼趴这儿睡了',
      '本鱼要去扒白饭了，快点',
      '等太久，尾巴都垂下来了',
      '哼，本鱼记仇了',
      '再不选，本鱼就当没问过',
    ],
  },
]

const WAIT_REFRESH_MS = 20000

/** 按已经等了多久选一句话；avoid 是上一句，避免连着重复 */
function pickWaitLine(elapsedMs, avoid) {
  const tier = WAIT_TIERS.find((t) => elapsedMs < t.until) ?? WAIT_TIERS[WAIT_TIERS.length - 1]
  const pool = tier.lines
  if (pool.length === 1) return pool[0]
  let line = pool[Math.floor(Math.random() * pool.length)]
  if (line === avoid) line = pool[(pool.indexOf(line) + 1) % pool.length]
  return line
}

export async function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  const doneHold = Math.max(500, Number(cfg.doneHoldMs) || 4000)
  const toastTtl = Math.max(1000, Number(cfg.toastTtlMs) || 6000)

  /** sessionId -> { kind, label, timer } */
  const sessions = new Map()

  /** 只打一次诊断，别刷屏 */
  let diagLogged = false

  const blockIdOf = (sid) => `${cfg.blockPrefix}${sid}`

  /** sessionId -> 标题（来自 session/title 事件，或日志里的最后一条） */
  const titleCache = new Map()

  /** 会话日志落在 sessions/<workspace>/<sid>/session.v4.jsonl.zstd */
  function findSessionLog(sid) {
    try {
      for (const ws of readdirSync(cfg.sessionsRoot, { withFileTypes: true })) {
        if (!ws.isDirectory()) continue
        const p = join(cfg.sessionsRoot, ws.name, sid, 'session.v4.jsonl.zstd')
        if (existsSync(p)) return p
      }
    } catch {
      /* 目录不存在、权限不足，都只会让标题退回 fallback */
    }
    return null
  }

  /**
   * header 里没有 title（0.2.2-rc.1 实测）；真正的标题是 `session/title` 事件，
   * WebUI 侧边栏读的就是它。插件启动时往回翻日志，取最后一条。
   * 解压 2.4MB 只要 ~15ms，而且每个会话只做一次。
   */
  function titleFromLog(sid) {
    let title = null
    const p = findSessionLog(sid)
    if (p) {
      try {
        const raw = zstdDecompressSync(readFileSync(p)).toString('utf8')
        for (const line of raw.split('\n')) {
          if (!line.includes('"session/title"')) continue
          let ev
          try {
            ev = JSON.parse(line)
          } catch {
            continue
          }
          if (ev.type !== 'session/title') continue
          const t = ev.data?.title
          if (typeof t === 'string' && t.trim()) title = t.trim()
        }
      } catch {
        /* 解压失败就当没有 */
      }
    }
    titleCache.set(sid, title)
    return title
  }

  function clampLabel(t) {
    if (!t) return null
    const max = Math.max(4, Number(cfg.labelMax) || 18)
    return t.length > max ? t.slice(0, max) + '…' : t
  }

  /** 从 session 对象上取 WebUI 显示的标题；取不到再问 sessions 服务 */
  function titleOf(session, sid) {
    const pick = (o) => {
      const t = o?.header?.title ?? o?.title
      return typeof t === 'string' && t.trim() ? t.trim() : null
    }

    // 0) 已经收到过 session/title 事件 —— 那是 WebUI 用的同一份标题，最准
    const cached = sid ? titleCache.get(sid) : null
    if (cached) return clampLabel(cached)

    let t = pick(session)

    if (!t && sid) {
      try {
        // session/event 里那个 session 对象不一定带 title，
        // WebUI 侧边栏用的是 sessions 服务里的会话对象。
        const svc = ctx.get?.('sessions')
        const rec = svc?.get?.(sid)
        t = pick(rec)

        if (!t && !diagLogged) {
          diagLogged = true
          try {
            console.log('[widget-status] diag session=' + JSON.stringify(Object.keys(session || {})) +
              ' header=' + JSON.stringify(session?.header ?? null) +
              ' svc=' + (svc ? 'yes' : 'no') +
              ' rec=' + (rec ? JSON.stringify(Object.keys(rec || {})) + ' header=' + JSON.stringify(rec?.header ?? null) : 'no'))
          } catch (e) { /* ignore */ }
        }
      } catch {
        /* 服务不存在或者形状变了，退回 fallback */
      }
    }

    if (!t && sid) t = titleFromLog(sid)

    if (!t) return null
    const max = Math.max(4, Number(cfg.labelMax) || 18)
    return t.length > max ? t.slice(0, max) + '…' : t
  }

  async function post(body) {
    try {
      await fetch(`${cfg.endpoint}/api/v1/patch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(1500),
      })
    } catch {
      // widget 没跑起来，或者端口被别的占用——不重试，不报错，不影响会话
    }
  }

  // 弹一条会自动消失的提示。失败静默：少一条提示不算错。
  async function postToast(text, kind, ttlMs) {
    if (!cfg.toast || !text) return
    try {
      await fetch(`${cfg.endpoint}/api/v1/toast`, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ text: String(text).slice(0, 200), kind, ttl_ms: ttlMs }),
        signal: AbortSignal.timeout(1500),
      })
    } catch {
      // 同上
    }
  }

  function setState(sid, kind, label) {
    const view = VIEWS[kind]
    if (!view || !sid) return

    let rec = sessions.get(sid)
    if (!rec) {
      rec = { kind: null, label: null, timer: null, waitStart: 0, lastLine: null }
      sessions.set(sid, rec)
    }
    if (rec.timer) {
      clearTimeout(rec.timer)
      if (typeof rec.timer === 'object' && rec.timer?.unref) rec.timer.unref()
      rec.timer = null
    }

    const shown = label || rec.label || cfg.fallbackLabel
    // 状态和标题都没变就不重推（done→waiting 是有意的变化，会走到这里）
    if (rec.kind === kind && rec.label === shown && kind !== 'done' && kind !== 'waiting') return
    rec.kind = kind
    rec.label = shown

    if (kind === 'waiting') {
      // 文案由 renderWaiting 负责：随机 + 随时间换档，不使用固定文案
      rec.waitStart = Date.now()
      rec.lastLine = null
      renderWaiting(sid)
      rec.timer = setInterval(() => renderWaiting(sid), WAIT_REFRESH_MS)
      return
    }

    const line = pickLine(view.lines, rec.lastLine)
    rec.lastLine = line
    void post({
      id: blockIdOf(sid),
      block: { kind: 'row', label: shown, text: line, color: view.color, priority: cfg.priority },
    })

    if (kind === 'done') {
      rec.timer = setTimeout(() => {
        // 收尾：没在等用户选择就直接移除，不进入等待态
        void post({ id: blockIdOf(sid), remove: true })
        sessions.delete(sid)
      }, doneHold)
    } else if (kind === 'working' && view.rotateMs > 0) {
      // 干活时间长的时候换着说，别一直「本鱼在干活」
      rec.timer = setInterval(() => {
        const cur = sessions.get(sid)
        if (!cur || cur.kind !== 'working') return
        const next = pickLine(view.lines, cur.lastLine)
        cur.lastLine = next
        void post({
          id: blockIdOf(sid),
          block: { kind: 'row', label: cur.label || cfg.fallbackLabel, text: next, color: view.color, priority: cfg.priority },
        })
      }, view.rotateMs)
    }
  }

  /** 等待态的画面：按已经等了多久挑一句话 */
  function renderWaiting(sid) {
    const rec = sessions.get(sid)
    if (!rec || rec.kind !== 'waiting') return
    const label = rec.label || cfg.fallbackLabel
    const elapsed = Date.now() - (rec.waitStart || Date.now())
    const text = pickWaitLine(elapsed, rec.lastLine)
    rec.lastLine = text
    void post({
      id: blockIdOf(sid),
      block: { kind: 'row', label, text, color: VIEWS.waiting.color, priority: cfg.priority },
    })
  }

  ctx.on('session/event', (session, event) => {
    try {
      if (!event) return
      const sid = session?.header?.id
      if (!sid) return
      const label = titleOf(session, sid)
      const type = event.type

      // 标题是 DSH 自己起的（session/title 事件），或者用户重命名过。
      // 收到就把缓存刷新，并把已显示的块换上新的前缀。
      if (type === 'session/title') {
        const t = typeof event.data?.title === 'string' ? event.data.title.trim() : ''
        if (t) {
          titleCache.set(sid, t)
          const rec = sessions.get(sid)
          if (rec && rec.kind) setState(sid, rec.kind, clampLabel(t))
        }
        return
      }

      if (type === 'user/message') {
        setState(sid, 'working', label)
        return
      }

      if (type === 'turn/end') {
        setState(sid, 'done', label)
        const reason = event.data?.reason?.kind ?? event.reason?.kind
        const name = label || cfg.fallbackLabel
        if (reason === 'completed') void postToast(`${name} · 已完成`, 'ok', toastTtl)
        else if (reason === 'error') void postToast(`${name} · 生成失败`, 'err', toastTtl)
        else if (reason === 'max-tokens') void postToast(`${name} · 输出被截断`, 'warn', toastTtl)
        return
      }

      if (type === 'approval/asked') {
        const tool = typeof event.data?.toolName === 'string' ? event.data.toolName : ''
        const name = label || cfg.fallbackLabel
        // 这是真·需要用户拍板的时刻，进等待态
        setState(sid, 'waiting', label)
        void postToast(`${name} · 等你批准${tool ? '：' + tool : ''}`, 'warn', toastTtl)
        return
      }

      if (type === 'tool/call') {
        // ask_user_question 之类的工具也会让 agent 停下来等用户
        const tool =
          event.data?.toolName ?? event.data?.name ?? event.data?.tool?.name ?? event.data?.call?.name ?? ''
        if (typeof tool === 'string' && /ask_user|request_user_input|ask_question/i.test(tool)) {
          setState(sid, 'waiting', label)
        }
        return
      }
    } catch {
      // 事件形状变了也不能影响会话
    }
  })
}

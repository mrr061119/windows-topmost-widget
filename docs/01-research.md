# Windows 常驻置顶窗口：实现方式与开源工具调研

> 调研日期：2026-11-14
> 目标：一块「永远在最前面」的窗口，以后由许多脚本/程序往里喂内容。
> 本机实测环境见文末附录。

---

## 0. 结论先行

**没有现成开源工具能同时满足「常驻 + 置顶 + 可编程 + 富内容」。**

- **只想把已有窗口钉在最前面** → 用 PowerToys 的 Always On Top（MIT，微软维护），装完即可，零开发。
- **想要一个能被程序驱动的显示板** → 必须自己写一个薄壳，或者「薄壳 + 现成渲染引擎」。

三条路线，按落地成本排序：

| 路线 | 渲染能力 | 依赖 | 预估工作量 | 适合 |
|---|---|---|---|---|
| A. PowerShell + WinForms 单文件 | 文本/矩形/进度条 | 零依赖（系统自带） | 2–3 小时出能跑的 | 先验证行为，短期够用 |
| B. Node + winpane（Rust 核，1.4 MB） | 文本/矩形/图片/点击 | 只要已有 Node | 半天 | 想要透明 HUD、点击穿透、无边框 |
| C. WPF/WinForms + WebView2 自研壳 | HTML/CSS/JS 全套 | .NET SDK（本机没装，需 250 MB） | 1–2 天 | 要 Markdown/表格/图表，长期基础设施 |

**我的推荐：先 A 验证行为，最终落 C。** 理由在 §5。

---

## 1. 先把需求拆开

「常驻置顶窗口」其实是三种完全不同的东西，选型前必须分清：

| 形态 | 说的其实是 | 代表工具 |
|---|---|---|
| **钉窗口** | 让别人的窗口浮在最上面 | PowerToys、DeskPins、TurboTop |
| **显示板** | 一块自己的画布，程序往里写 | Rainmeter、Desktop Info、winpane |
| **桌宠/挂件** | 有动画、能拖动、跟着状态变 | BongoCat、dsh-pet、dsh-dafeiyu |

「我以后会有许多东西调用他」——这句话把需求锁死在**显示板**上：需要一个长期驻留的宿主进程，加一套稳定的写入接口。钉窗口类工具（PowerToys）没有内容层，桌宠类工具（BongoCat）没有对外 API，都不合适。

真正的设计问题不是「怎么置顶」（那个只有 3 行 API），而是：
1. **接口怎么定**，才能让 PowerShell / Python / Node / DSH 插件都能方便地喂内容；
2. **置顶怎么稳**，因为 Windows 的 topmost 不是一个布尔值，是一个「层级带」；
3. **常驻怎么不崩**，因为这块窗口要活一整天。

---

## 2. 底层：Windows 的窗口层级到底怎么排

### 2.1 三个 API，一个语义

```
窗口扩展样式  WS_EX_TOPMOST          // 标记「属于置顶层」
移动/改层     SetWindowPos(hwnd, HWND_TOPMOST, ...)
              SetWindowPos(hwnd, HWND_NOTOPMOST, ...)
```

WPF 的 `Window.Topmost = true`、WinForms 的 `Form.Topmost = true`、Electron 的 `setAlwaysOnTop(true)`，底下全是这一句 `SetWindowPos`。

### 2.2 坑一：topmost 是一个「带」，不是一个位置

**`WS_EX_TOPMOST` 只表示「我属于置顶这一层」，不表示「我在置顶层最上面」。**

同一层里的窗口仍然有 Z 序，后来的、或者被前台激活的，可以跑到你前面——两者的样式位都还在。

这不是理论，是官方承认的限制。PowerToys 的 Always On Top 文档原文：

> "Always On Top can't guarantee that the window will be above other topmost windows."

并点名了 Citrix、远程桌面、VMware 这类窗口本身是 topmost 的场景
（<https://learn.microsoft.com/en-us/windows/powertoys/always-on-top>）。

BongoCat 的 ADR-0096 把这个坑写得很细（<https://github.com/ayangweb/BongoCat/blob/master/docs/adr/0096-windows-topmost-foreground-order.md>）：

- 全屏的前台浏览器可以跑到置顶的模型前面，**两个窗口的 topmost 位都没丢**；
- 修法不是「重新设一次 topmost」，而是**周期性检查并重新断言实际堆叠顺序**：
  1. `GetForegroundWindow()`
  2. 如果前台窗口不是 topmost，跳过（普通窗口本来盖不住置顶层）
  3. 用 `EnumWindows` 按 Z 序同步枚举，找到前台窗口和自身谁先出现
  4. 只有当前台 topmost 窗口**确实在自身之上**时，才 `SetWindowPos(HWND_TOPMOST, SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE)`
- 注意它特意**不是**无脑 `HWND_TOPMOST`——那样会把菜单、tooltip 也压下去。

**结论：置顶要带一个「守护」逻辑，不能设一次就完事。** 触发时机可以是定时器（1 s 级）、窗口显示/帧回调、或前台窗口变化事件（`SetWinEventHook` 的 `EVENT_SYSTEM_FOREGROUND`）。

### 2.3 坑二：有些东西你在物理上盖不住

| 场景 | 能不能盖住 | 原因 |
|---|---|---|
| 普通窗口 | ✅ | 就是 topmost 的设计用途 |
| 无边框全屏窗口（DWM 合成） | ✅ | 仍走 DWM |
| **独占全屏（exclusive fullscreen）** | ❌ | 直接接管显示管线，DWM 不参与。只能进程注入/换渲染路径 |
| **UAC 提权弹窗** | ❌ | 在「安全桌面」，另一个 desktop 对象 |
| 锁屏 / Ctrl+Alt+Del | ❌ | 同上 |
| 另一个 topmost 窗口 | ⚠️ | 可竞争，靠 §2.2 的守护逻辑抢 |
| 系统托盘飞出菜单 | ⚠️ | 它们也是 topmost，且更晚出现 |

游戏里做覆盖层（overlay）想要绝对可靠，业界做法是 hook 游戏的 Present/SwapChain，那是另一个复杂度量级。**如果用途是「陪着我写代码/看文档」，DWM 路线完全够。**

### 2.4 坑三：Win+D / 显示桌面

Raymond Chen 解释过：`Win+D` 不是「最小化所有窗口」，而是**把桌面窗口提到最前**。

所以带 `WS_EX_TOPMOST` 的窗口一般**不会**被 `Win+D` 藏起来——桌面窗口被压在它下面
（<https://learn.microsoft.com/en-us/answers/questions/2127546/how-to-avoid-minimize-on-show-desktop-or-peek-desk>）。

但有边界情况：`WS_EX_TOOLWINDOW`（隐藏任务栏/Alt+Tab 的常规做法）搭配某些 `Peek Desktop` 行为会翻车。稳妥做法是：

1. 用 `WS_EX_TOOLWINDOW` 藏任务栏和 Alt+Tab；
2. 在 `WM_WINDOWPOSCHANGING` 里把非主动的 `SWP_HIDEWINDOW` / 下沉请求挡回去；
3. 上 §2.2 的守护逻辑兜底。

**这一条我没有在本机实测**，属于「按文档推断 + 需验收」项。

### 2.5 坑四：透明与点击穿透

想要「只看到内容、看不到窗口背景」：

```
WS_EX_LAYERED | WS_EX_TRANSPARENT     // 点击穿透（鼠标事件直接穿过去）
```
- `WS_EX_LAYERED` 是透明的前提，`WS_EX_TRANSPARENT` 让它不吃鼠标。
- **只有整窗穿透**。想「文字区域能点、空白区域穿透」，得自己做 hit-test：
  在 `WM_NCHITTEST` / `WM_MOUSEACTIVATE` 里按坐标判断，动态增删 `WS_EX_TRANSPARENT`；
  或者用 `SetWindowRgn` 把窗口裁成内容形状。
- WPF 的 `AllowsTransparency=True` + `WindowStyle=None` 也能做，但会强制软件渲染（WPF 的已知限制），文字多了会卡。
- Electron 的 `transparent: true` + `setIgnoreMouseEvents(true, { forward: true })` 是同语义封装。
- **分层窗口 + 每像素 Alpha**（`UpdateLayeredWindow`）是另一条路，能做出真·不规则窗口，代价是 GDI 绘制。

### 2.6 坑五：多显示器与 DPI

- DPI 感知必须声明为 **Per-Monitor V2**（`app.manifest` 里 `dpiAwareness=PerMonitorV2`）。不声明 → 系统位图拉伸 → 文字发糊。
- 多显示器原点可以是负数。**本机就是**：副屏在左侧，矩形是 `X=-1152, Y=-891`。
- 跨屏拖动时窗口尺寸要按目标屏的 DPI 重新换算，Qt/WPF/WinForms 各自都要处理。

### 2.7 坑六：常驻本身

- **开机自启**：本机统一走 `C:\Apps\Launchers\startup.json`，不要另建计划任务。
- **不能有黑框**：`WinExe` / `-WindowStyle Hidden` / 编译成 GUI 子系统。
- **崩溃恢复**：宿主挂了窗口就没了。要么自带看门狗（子进程互相监护），要么把重绘做成幂等、崩了重启能靠状态文件恢复画面。
- **内存**：`.NET WPF` 静态窗口约 40–80 MB，Electron 约 120–200 MB，Qt 约 60–100 MB，WinForms 约 20–40 MB。要挂一整天，这个账得算。

---

## 3. 「许多东西调用他」——接口怎么设计

这才是这个项目的核心。候选五种，按可用性排：

| 接口 | 优点 | 缺点 | 适合 |
|---|---|---|---|
| **本地 HTTP** | 任何语言一行搞定；有回执；能推能拉 | 要占端口；要做鉴权（本机其他进程能打） | ✅ 主接口 |
| **状态文件 + 监视** | 零协议、零端口、崩了能恢复 | 无回执；写入要原子（先写 tmp 再改名） | ✅ 兜底 |
| 命名管道 | Windows 原生、快 | 跨语言麻烦；PowerShell 里写起来别扭 | 可选 |
| CLI（每次起进程） | 最简单 | 每次 ~50–200 ms；高频更新不合适 | ✅ 小工具 |
| WebSocket | 实时推送 | 需要长连接管理 | 显示实时日志时再加 |

**推荐组合：HTTP 主 + 状态文件兜底 + 一个薄 CLI。** 三者共享同一份状态模型。

### 3.1 协议草案（v1）

```
POST /api/v1/render        全量替换画面
PATCH /api/v1/block/{id}   只更新某个块
POST /api/v1/toast         弹一句话，自动消失
POST /api/v1/visibility    {"visible": false}
GET  /api/v1/state         读当前状态（幂等重放用）
GET  /health               存活探测
```

`/render` 的体：

```json
{
  "target": "main",
  "accent": "#5ac8fa",
  "blocks": [
    { "kind": "text",     "id": "title",  "text": "DSH", "size": 20, "weight": "bold", "color": "#ffffff" },
    { "kind": "row",      "id": "status", "label": "任务", "text": "正在构建" },
    { "kind": "progress", "id": "p",      "value": 0.62 },
    { "kind": "image",    "id": "logo",   "src": "C:/x/logo.png", "w": 48, "h": 48 }
  ],
  "ttl_ms": 30000
}
```

设计要点：
- **块有 `id`**：调用方只改自己那块，不互相覆盖。多个程序共用一个窗口的前提。
- **`ttl_ms`**：过期自动隐藏/回退，防止某个脚本崩了留下一行僵尸文字。
- **全量 `render` 幂等**：窗口重启后，谁写谁恢复，不需要记历史。
- **`accent`**：一个颜色变量控制整体风格，别让每个调用方各写一套 CSS。

### 3.2 谁在调用（本机实际会用的）

| 调用方 | 方式 |
|---|---|
| DSH 插件 | `fetch('http://127.0.0.1:7777/api/v1/render')` |
| PowerShell 脚本 | `Invoke-RestMethod -Method Post -Uri ... -Body ($o \| ConvertTo-Json -Depth 5)` |
| Python | `requests.post(...)` |
| 计划任务 / 批处理 | `widget.exe set --text "..."` （CLI 兜底，不依赖端口） |

---

## 4. 开源工具盘点

| 项目 | 形态 | 可编程性 | 许可 | 活跃度 | 结论 |
|---|---|---|---|---|---|
| **PowerToys Always On Top** | 给任意窗口加置顶 | ❌ 只有快捷键 | MIT | 微软，活跃 | 钉窗口够用，做不了显示板 |
| **DeskPins** | 同上 | ❌ | MIT（重制版） | 2021 年后停 | 老，别用 |
| **OnTopReplica** | 置顶显示另一个窗口的实时副本 | ❌ | 自定义 | 2023 停更 | 做 PiP 可以参考代码 |
| **Rainmeter** | 桌面 skin 引擎 | ⚠️ 命令行 `!Bang`（`!SetOption` / `!UpdateMeter` / `!Redraw`），`WebParser` 可读本地 HTTP | GPL-3.0 | 非常活跃 | 能用，但要写 ini，动态内容绕；起进程调 bang 有转义地狱 |
| **Desktop Info** | 配置驱动的系统信息置顶面板 | ⚠️ 读文件/命令 | 免费闭源 | 维护 | 界面复古，定制受限 |
| **winpane** | Rust overlay SDK：HUD / Panel / PiP / Tray | ✅ JSON-RPC / Node addon / C ABI | MIT | 单人，pre-1.0，7★ | **最贴合**，但冷门，需自建 daemon 层 |
| **BongoCat** | 桌宠（Rust/Tauri） | ❌ 无对外 API | MIT | 活跃 | 只值得抄它的 topmost 守护逻辑 |
| **dsh-dafeiyu** | DSH 桌宠（Qt Helper） | ❌ 插件内部 | MIT（代码）/ 素材另有协议 | 活跃 | 已经是「常驻置顶窗口」，但专用 |

### 4.1 winpane 值得单独说

它的能力几乎就是「显示板」的标准答案（<https://github.com/peteretelej/winpane>）：

- 透明 + 置顶 + 无任务栏（HUD 类型），**点击穿透**
- 面板类型支持 hit-test、点击/悬停事件、拖动
- 图片、文字、圆角矩形、边框、透明度、淡入淡出
- DPI 感知、多显示器锚点、`SetWindowDisplayAffinity` 防截屏
- Panels 之间可组合；可锚定到别的窗口（`anchor_to`）
- 多语言：Rust / Node / C ABI / **任意语言走 JSON-RPC**

但三个硬伤（来自它自己的 `docs/protocol.md`）：

1. **`winpane-host` 没有 daemon 模式** —— stdin EOF 就退出，所有 surface 一起销毁。多调用方共享一个 stdin/stdout JSON-RPC 流会交错，必须自己写一个「daemon → 单 host」的转接层。
2. **没有 HTML/CSS，只有坐标绘制**。Markdown、表格、折线图都得自己算坐标。
3. **pre-1.0，7 star，单人维护**。API 会变。

好在 Node addon 可以**在进程内**用（`npm i winpane` + 从 Release 下 `winpane.win32-x64-msvc.node`），这样就天然是个 daemon，绕开第 1 条。npm 包本体只有 6 KB（wrapper），二进制要单独拿。

---

## 5. 三条路线，怎么选

### A. PowerShell + WinForms 单文件（先跑起来）

- **优点**：零安装。本机 pwsh + .NET Framework 4.8 全在。
- **做法**：`Form` + `Topmost=$true` + `FormBorderStyle=None` + `ShowInTaskbar=$false` + 托盘图标；`HttpListener`（.NET 自带）收 `/render`；WinForms 控件直接当渲染层。
- **缺点**：常驻一天的稳定性一般（脚本异常/GC/单线程消息循环要自己护）；UI 丑；富内容难。
- **定位**：**验证行为**用——置顶守护、点击穿透、Win+D、多屏坐标，先在这上面把坑踩明白。

### B. Node + winpane（轻量 HUD）

- **优点**：只要 Node 24（已有）；addon 1.4 MB；透明/穿透/多屏/防截屏都是现成的。
- **做法**：一个 Node 进程 = daemon + 渲染；`node:http` 提供 §3.1 接口；收到 JSON 后调 winpane 的 `set_rect` / `set_text` / `set_image`。
- **缺点**：没有 HTML；pre-1.0 风险；冷门。
- **定位**：如果确认「内容就是几行字 + 进度条 + 图标」，这是性价比最高的。

### C. 自研壳 + WebView2（长期基础设施）

- **优点**：HTML/CSS/JS 全套，Markdown、表格、图表、动画随便写；接口完全自己定；不怕上游跑路。
- **做法**：
  - 宿主：WinForms 窗口（`Topmost`、无边框、`WS_EX_TOOLWINDOW`、`WS_EX_LAYERED`）+ `WebView2` 控件加载本地 `ui.html`；
  - 通信：宿主开 `HttpListener`，收到 JSON 后 `CoreWebView2.ExecuteScriptAsync("render(...)")` 或 `PostWebMessageAsJson`；
  - 重断言：§2.2 的守护逻辑，1 s 定时器。
- **代价**：本机**没有 .NET SDK**，要装（`winget install Microsoft.DotNet.SDK.10`，约 250 MB）。
- **备注**：WebView2 Runtime 本机已有（157.0.4341.46），所以运行时不用分发。

---

## 6. 建议的下一步

1. 用路线 A 写一个 **100 行以内的 spike**，在本机跑起来，专门验四条：
   - `Win+D` 会不会藏（§2.4，我没实测）
   - 副屏负坐标定位对不对（`-1152, -891`）
   - `WS_EX_TRANSPARENT` 穿透后还能不能拖动/点击
   - 守护逻辑在 1 s 周期下的 CPU 占用
2. spike 通过后，按 §3.1 的协议定接口，再决定落 B 还是 C。
3. 交付物归宿按工作区规则：可执行文件落 `C:\Tools\<name>\`，开机自启登记到 `C:\Apps\Launchers\startup.json`，工作区只留源码和文档。

---

## 附录：本机实测环境（2026-11-14）

| 项 | 值 |
|---|---|
| OS | Windows 11 IoT 企业版 LTSC 24H2 |
| .NET | runtime 8.0.32 / 10.0.13（含 WindowsDesktop），**无 SDK** |
| csc.exe | 有（`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`） |
| Node | v24.22.1 |
| Python | 3.12.10（`C:\Apps\AI\Python312`） |
| WebView2 Runtime | 157.0.4341.46 |
| AutoHotkey | 未装 |
| Rainmeter | 未装 |
| PowerToys | 未装 |
| 显示器 | 主屏 2048×1152；副屏 1152×2048，位于左侧（`X=-1152, Y=-891`） |

## 参考

- PowerToys Always On Top（topmost 竞争限制）：<https://learn.microsoft.com/en-us/windows/powertoys/always-on-top>
- BongoCat ADR-0096（topmost 守护逻辑）：<https://github.com/ayangweb/BongoCat/blob/master/docs/adr/0096-windows-topmost-foreground-order.md>
- MS Q&A：Win+D 与 Show Desktop（桌面窗口被提前，不是最小化）：<https://learn.microsoft.com/en-us/answers/questions/2127546/how-to-avoid-minimize-on-show-desktop-or-peek-desk>
- winpane：<https://github.com/peteretelej/winpane>
- winpane JSON-RPC 协议：<https://github.com/peteretelej/winpane/blob/main/docs/protocol.md>
- Rainmeter Bangs：<https://docs.rainmeter.net/manual/bangs/>
- Rainmeter RunCommand 插件：<https://docs.rainmeter.net/manual/plugins/runcommand/>
- dsh-dafeiyu（已有的常驻置顶窗口实现）：<https://github.com/QCYTSN/dsh-dafeiyu>



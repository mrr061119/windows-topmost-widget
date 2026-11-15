# 部署记录

> 2026-11-14

## 一、最终位置

| 项 | 值 |
|---|---|
| 运行正本 | `C:\Tools\topmost-widget\`（约 370 MB，含 Electron 45） |
| HTTP 接口 | `http://127.0.0.1:7788` |
| 日志 | `C:\Tools\topmost-widget\logs\widget.log`（2 MB 轮转） |
| 开机自启 | `C:\Apps\Launchers\startup.json` 第 4 位 |
| 手动启动 | `C:\Tools\topmost-widget\start-widget.cmd` |
| 工作区 | `C:\Dsh-WorkSpace\Dev\windows-topmost-widget\` 只有 docs 和截图，**无副本** |

## 二、启动链

```
开机
 └─ C:\Apps\Launchers\startup.ps1
     └─ startup.json 第 4 项
         └─ C:\Tools\topmost-widget\node_modules\electron\dist\electron.exe C:\Tools\topmost-widget
             ├─ 创建透明置顶窗口（主屏右下角，420×300 DIP）
             ├─ 启动 HTTP :7788
             ├─ 置顶守护定时器（1.5 s）
             └─ setInterval 清理过期 block（1 s）
```

`startup.json` 条目用 `waitFor: port 7788` 判就绪，`onFailure: continue`，`silent: true`。

## 三、解耦

| 维度 | 做法 |
|---|---|
| 代码 | 不 require 任何项目文件，全部依赖在本目录 `node_modules` |
| 调用 | 只通过 HTTP，不共享模块、不读写别人的文件 |
| 日志 | 写自己目录，不动系统日志 |
| 状态 | 全在内存，重启即清；没有需要迁移的持久化数据 |
| 卸载 | 删目录 + 删 `startup.json` 那一条，无残留 |

工作区目录可以整个删掉，不影响运行。

## 四、关键决策

### 4.1 为什么是 Electron，不是 WPF + WebView2

| | Electron | WPF + WebView2 |
|---|---|---|
| 透明窗口 | `transparent: true` 一等公民 | `AllowsTransparency` 强制软件渲染；WebView2 是 HwndHost，透不出背后的窗口 |
| 落地时间 | 半小时 | 一两天，且不保证能做出真透明 |

代价：实测 8 进程约 650 MB 内存。这是 Electron 的固有成本，无解。

### 4.2 为什么不做点击穿透

用户 2026-11-14 决定不做。技术上也确实麻烦：`setIgnoreMouseEvents(true)` 是整窗穿透，穿过去之后就没法用鼠标恢复交互，只能靠托盘或快捷键。

### 4.3 多调用方模型

多个程序共用一个窗口，靠 `block.id` 区分：

```json
{"id": "dsh:status",   "block": {"kind": "row", "label": "任务", "text": "正在构建"}}
{"id": "build:progress","block": {"kind": "progress", "value": 0.62}}
```

`/patch` 只动自己那块，`/render` 是整锅替换（单人场景才用）。加上 `ttl_ms` 防僵尸。

## 五、变更历史

| 时间 | 变更 | 原因 |
|---|---|---|
| 2026-11-14 12:16 | 开始调研 | — |
| 12:20 | 选定自研路线，Electron 实现 | WPF 透明做不出来 |
| 12:25 | 首版跑通（窗口 + HTTP + 渲染） | — |
| 12:25 | 修 CSP：`style-src` 少了 `'self'`，外部 CSS 被拦，卡片无背景 | 截图发现窗口是纯文字浮在壁纸上 |
| 12:26 | 加内容自适应高度 | 首版底部留大片空白 |
| 12:27 | toast 从 fixed 定位改成插入内容流 | 原来会盖住最后一行 |
| 12:31 | 移除点击穿透（API + 托盘 + 客户端） | 用户决定不做 |
| 12:32 | 加文件日志 + 托盘「打开日志目录」 | 部署需要排障入口 |
| 12:33 | 部署到 `C:\Tools\topmost-widget\` | 固化位置 |
| 12:34 | 修 `start-widget.cmd`：中文注释在 GBK 代码页下被拆成命令 | 启动报 `'口）' is not recognized` |
| 12:35 | 登记 `startup.json`（备份 `startup.json.bak-20261114`） | 开机自启 |
| 13:58 | 加全局规则 F.2「下载任务必须上置顶显示」 | 用户要求：DSH 的下载要让用户看得见 |
| 13:59 | 新建 `C:\Scripts\AI\widget-dl.ps1`（start/update/done/fail/clear） | 规则要落地，不能每个会话手写 HTTP |
| 14:01 | **修窗口位置漂移**：改用固定锚点（x + 底边），resize 不再读 `getBounds()` 反算 | 实测发现跑完下载窗口整个漂到副屏外（`-620,-512`），用户看不见 |
| 14:02 | 加 `guardPosition()`：窗口跑到所有显示器之外时拉回主屏右下角 | 同上，兜底 |
| 14:03 | **修百分比 bug**：`[Math]::Min(1, $ratio)` 在 PowerShell 里选 `Min(int,int)` 重载，0.8 被舍成 1，进度只显示 0% 或 100% | 实测截图显示「下载中 · 100%」但实际 80% |
| 14:05 | 文档：widget README 加「下载进度」节；deploy-registry §2.1 登记脚本 | 留痕 |
| 14:06 | 新建 DSH 插件 `C:\DSH\plugins\dsh-widget-status`（三态：工作/完成/等待） | 用户要求增加会话状态 |
| 14:07 | profile 备份（`package.json.bak-20261114-1405`、`pnpm-lock.yaml.bak-*`）→ 加 link 依赖 + bundles → junction 到 node_modules | 用最小改动，不跑 pnpm |
| 14:08 | 假数据演示三态，截图存档 `_shots/state-*.png` | 插件要重启才生效，先让用户看 UI |
| 14:12 | 插件前缀改成 WebUI 会话标题（`session.header.title`，18 字截断，回落 `DSH`） | 用户要求：要能分清是哪个会话 |
| 14:18 | **改成一会话一块**：块 id `dsh:state:<sessionId>`；生命周期 working → done(4s) → waiting(30s 后移除) | 用户要求多会话同时推；单块会互相覆盖 |
| 14:19 | 清掉演示残留的孤儿块（旧 id `dsh:state` 一直挂着「等待回复」，新插件不会覆盖它） | 用户反馈「一直显示等待回复」 |
| 14:26 | **去掉标题栏和关闭按钮**：删 `#head`/`#dot`/`#title`/`#hide`，整块卡片改成可拖 | 用户要求只留状态行 |
| 14:38 | `#blocks` 也改成 `drag`：整窗随便点哪都能拖（原来只有 12px 边缘能拖，等于拖不动） | 用户反馈「去掉标题栏后无法拖动」 |
| 14:39 | 加 `win.on('move')` 更新锚点，自己的 `setBounds` 用 `resizingInternally` 屏蔽 | 否则拖动后再变内容，窗口会跳回原位 |
| 14:40 | 最小高度 80 → 40 DIP | 80 把 1–2 行都钳住了，高度不跟随 |
| 14:44 | **锚点从「底边固定」改成「顶边固定」**：内容变多时左上角不动、向下展开 | 用户要求；原来向上长会顶到屏幕边，进而逼出滚动条 |
| 14:45 | 加位置持久化 `state.json`（防抖 600ms 写盘，启动时校验还在屏幕上） | 用户要求记住上次位置 |
| 14:46 | `#blocks` max-height 420 → 600 | 配合向下展开，减少滚动条出现 |
| 14:52 | 新建 `C:\Scripts\AI\widget-notice.ps1`（`notice:<Id>` 块，info/warn/err 三色） | 用户要求：这类提醒同时上置顶窗口 |
| 14:53 | 规则 A.8 第 5 条：模拟鼠标/键盘的提醒必须同时推 `notice:mouse` | 同上 |
| 15:28 | **查出 widget 被杀原因**：从 DSH 工具调用里 `Start-Process` 拉起 → 落进 DSH 的 Job Object → DSH 重启时被连坐（日志无 `quitting` 记录，是强杀） | 用户重启 DSH 后窗口消失 |
| 15:29 | 新建 `C:\Scripts\AI\start-widget.ps1`，用 WMI `Win32_Process.Create` 拉起，父进程链 electron → WmiPrvSE → svchost → services | 脱离 Job，DSH 重启不再带走它 |
| 15:58 | **标题来源定为 `session/title` 事件**：header 里没有 title（实测 0.2.2-rc.1），连猜三版都错；改成监听 `session/title` + 从日志读最后一条 | 用户要「显示 webui 里的会话名」 |
| 16:05 | waiting 改成**只有** `approval/asked` / `ask_user_question` 才进；`turn/end` 后 4 秒直接移除 | 用户：只有需要选择时才显示等待 |
| 16:06 | 等待文案四档（30s/120s/300s+），每档随机、每 20 秒换一句、不连续重复 | 用户：人格化 + 随等待时间变语气 |
| 16:14 | 窗口默认位置改成屏幕左上角 `(1,1)`；`guardPosition` 兜底同步改 | 用户指定 |
| 16:15 | 干活 / 干完也人格化：各 6 句随机，干活每 15 秒换一句 | 用户：其他状态提示词也人格化 |

## 六、验证结果

| 项 | 方法 | 结果 |
|---|---|---|
| 部署副本能启 | `start-widget.cmd` + `/health` | ✅ uptime 正常 |
| 日志落盘 | 读 `logs\widget.log` | ✅ 三行启动记录 |
| 客户端可用 | `widget.ps1 set` / `toast` / `health` | ✅ blocks 从 0 → 2 |
| 状态模型 | `GET /api/v1/state` | ✅ `verify:row=row, verify:p=progress` |
| 置顶压过 topmost | 记事本 + `SetWindowPos(HWND_TOPMOST)` 后截图 | ✅ widget 仍在上面 |
| 透明 + 圆角 | 截图 | ✅ |
| 自适应高度 | 截图 | ✅ |
| `startup.json` 完整性 | 解析回来 + 条目核对 | ✅ 14 项，顺序正确 |

未验证：Win+D / 显示桌面、副屏负坐标定位、开机重启后的实际拉起（要等下次重启）。

## 七、踩过的坑

1. **CSP 漏 `'self'`**：`style-src 'unsafe-inline'` 只允许行内样式，外部 `<link rel=stylesheet>` 会被静默拦掉。现象是窗口透明、文字裸奔。
2. **DPI 缩放**：本机 125%，`Screen.Bounds` 在 DPI-unaware 进程里报 2048×1152，实际 2560×1440。截图定位要用 DPI-aware 进程。
3. **`.cmd` 别写中文**：UTF-8 注释在 GBK 代码页下会被拆成乱命令。全 ASCII。
4. **Electron 进程名不能乱杀**：`C:\DSH\harness\home\electron\electron.exe` 是 DSH 自己的，`taskkill /IM electron.exe` 会连坐。杀自己的实例认路径或认端口。
5. **`win.showInactive()`**：用这个而不是 `show()`，避免抢焦点把用户的输入打断。
| 15:30 | watch 模式补边界：文件一直 0 字节时报 fail，不再假装 done | 修复「下载失败也显示成功」 |
| 15:32 | 规则 F.2 改成「首选 watch，手动模式才会踩单位坑」 | 同一错误当天出现两次（MB 当字节） |
| 15:35 | watch 又补一刀：文件「还没出现」不再当成 0 字节失败，改为最多等 5 分钟 | 另一条小鱼盯 nltk_data.zip，watch 启动早于文件创建，6 秒就误判失败 |

| 2026-11-15 12:58 | **作用域分离**：`widget-dl.ps1` / `widget-notice.ps1` 移出仓库（本机正本留在 `C:\Scripts\AI`）；新增 `docs/03-scope.md`，明确「插件本体」和「本机应用」的边界 | 用户：这些是本机环境下对插件的应用，不要集成、不要上传 |

# 03 · 作用域：插件本体 vs 本机应用

整理于 2026-11-15。

判据一句话：**这东西进了仓库，别人 clone 下来能直接用吗？**
能 → 本体。只对这台机器有意义 → 应用。

---

## 本体（在仓库里，可以发布）

| 路径 | 说明 |
|---|---|
| `src/widget/main.js` | 窗口 + HTTP 服务 + 置顶守护 + 托盘 |
| `src/widget/preload.js` | 渲染层桥 |
| `src/widget/ui/` | UI（index.html / style.css / app.js） |
| `src/widget/assets/tray.png` | 托盘图标 |
| `src/widget/start-widget.cmd` | 双击启动 |
| `src/widget/widget.ps1` | 自带的 PowerShell 客户端：health / state / render / patch / toast / window |
| `src/plugin/` | DSH 插件（会话状态），`index.js` + `cordis.patch.yml` + `package.json` |
| `src/scripts/start-widget.ps1` | 启动器，用 WMI 脱离 Job Object |
| `examples/widget-dl.ps1` | 下载进度客户端，**参考实现**（见下） |
| `docs/01-research.md` | 为什么选 Electron、置顶到底有几层 |
| `docs/02-deploy.md` | 部署过程与踩过的坑（按时间） |

**判断标准**：换一台 Windows 机器，`npm install` 之后能跑起来，不需要这台机器上的任何东西。

---

## 应用（不在这仓库里，也不上传）

| 脚本 | 本机位置 | 作用 | 为什么不算本体 |
|---|---|---|---|
| `widget-notice.ps1` | `C:\Scripts\AI\` | 需要人确认的提醒 | 文案是这台机器的人格 |
| `widget-env.ps1` | `C:\Scripts\AI\` | 香橙派 M701 环境数据常驻显示 | 直接绑死 `192.168.31.66:8080/api/latest` 和它的字段形状 |
| startup.json 的 `widget-env` 条目 | `C:\Apps\Launchers\` | 开机拉起上面那个 | 本机启动编排，不是插件的一部分 |

## 介于两者之间：`examples/widget-dl.ps1`

下载进度客户端，**在仓库里，但不是插件依赖**——widget 删掉它照常运行。

放进来是因为：光看接口文档不知道「一个真实客户端长什么样」，而这个又是完整的、
带 `watch` 自动收尾、带单位坑注释的参考实现。

判断它的位置用的不是「谁调它」，而是「它对别的机器有没有意义」：有。
不带它的话，F.2 那条「下载必须上置顶」的规则就得从零写一遍。

---

## 为什么这么分

三个应用都是「**拿 widget 的接口当 API 用的东西**」，不是接口本身。

- `widget-dl` 的实现里有一半逻辑是绕开本机的下载工具（curl / aria2 / pdl.py）；
- `widget-env` 绑的是一个具体的家庭传感器网关；
- `widget-notice` 的措辞只对这条鱼有意义。

放进仓库会有两个后果：

1. 别人以为插件自带这些功能，装完发现还要配一堆本机的东西；
2. 这些脚本会随本体的版本节奏走，但它们其实不该跟。

**接口是稳定的**：

```
POST /api/v1/patch   { id, block }        # 增删改
POST /api/v1/toast   { text, kind, ttl_ms }  # 弹提示
```

应用想怎么写就怎么写，写错了也不影响本体。

---

## 边界上的两个东西

**`widget.ps1`** —— 在 `src/widget/` 里，算本体。
它只做「把 JSON 发给本机 7788」这一件事，不含任何业务判断，换台机器照样能用。

**`start-widget.ps1`** —— 在 `src/scripts/` 里，算本体。
它解决的是「从带 Job Object 的父进程里启动会被连坐」这个通用问题，不是本机特有。

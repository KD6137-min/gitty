# Gitty

一条贴在桌面上的 Git 分支雷达：约 6cm 高的深色毛玻璃横条贴在屏幕边缘，时间轴横向（最新在右），分支为车道。

窗口可以拖到任意显示器，松手后自动吸附到该屏的上边或下边；Linux/macOS 会记住显示器与吸附边。

**1.1**：Windows 桌面版已可用（Tauri + WebView2 + 原生 Acrylic）；macOS 版已对齐 Linux 的桌面能力（vibrancy、菜单栏托盘、多显示器上下吸附、随包 Node）；Linux/X11 本地版可用（贴工作区，无系统级背景模糊时以深色底降级）。1.1.7 起移除竖版，专注横向雷达。

## 界面

- 本地提交：实心彩色小圆点
- 远端提交：空心圆环，与本地同心；环内镂空，线不穿环
- 本地与远端共有：大圆套小点；只有远端：空环；只有本地：小点
- 玻璃带：覆盖本地与远端的分歧区，merge-base 留在框外
- Tag：提交上方三角 + 标签名
- rebase / cherry-pick：旧副本和新提交用虚线 + `rebase` 标注关联（按 author time、作者、标题匹配）
- 顶部时间轴：release / tag 实心点，可吸附；当前位置为分支色菱形
- 新提交 1s 点亮 + 「N 个新提交」提示

## 功能

- 系统托盘菜单（Linux/macOS）：显示 / 隐藏、隐藏已删除分支（默认隐藏；只隐藏没有当前 ref 的历史侧链，已合并但仍有 ref 的分支保留；不影响 Git 数据）
- 窗口移动（Linux/macOS）：拖顶栏可把横条拖到任意显示器，松手后按落点自动吸附到该屏的上边或下边并记住
- 本地 / 远端视角切换（0.5s 过渡）
- 聚焦模式：点击分支名或提交点；显示汇入分支名；方向键切换（上下切车道、左右切同车道相邻分支）；点击外部或 Esc 退出
- 提交详情：双击提交点查看作者、时间、提交信息、文件增删
- 工作区状态：已暂存 / 未暂存 / 未跟踪计数
- Windows 系统托盘：菱形图标，右键显示 / 隐藏 / 退出 Gitty；macOS 菜单栏提供同款入口，并额外支持隐藏已删除分支
- 仓库切换：点击路径下拉，最近仓库持久化；可手动输入路径（支持 `~`），或从系统文件管理器选择文件夹
- FETCH 手动拉取；AUTO 每 60 秒自动 fetch（记忆开关）
- 快捷键：`T` 视角、`F` 聚焦、`R` 刷新、`End` 回到最新、`Esc` 退出聚焦
- 只读：不执行 checkout / push / rebase 等写操作

## 桌面版

窗口：无边框、透明、跳过任务栏、置底不抢焦点；横条贴在任意显示器工作区的上边或下边（全宽×6cm）。Windows 使用原生 Acrylic，macOS 使用 vibrancy。Linux/X11 用 RandR + `_NET_WORKAREA` 定位，macOS 用 `NSScreen.visibleFrame` 定位，两者都会按显示器吸附并记住屏幕与边。Linux/macOS 托盘菜单提供“隐藏已删除分支”（默认开启，只影响绘制）。X11 没有通用的窗口背后模糊 API，因此改用不透明深色底 `#1e1e1b`（透明窗口在软件合成下会逐渐累积变暗），内层的虚焦层级、玻璃带与点线语义保持不变。

```powershell
npm install
npm run tauri:dev      # 开发运行
npm run tauri:build    # 生成安装包（release）
```

构建前置条件：

- Node.js 18+
- Rust（rustup，MSVC toolchain）
- Visual Studio Build Tools（C++ 工作负载 + Windows SDK）
- WebView2 Runtime（Win10/11 通常已自带）

Linux（X11）前置条件：

```bash
sudo apt install -y libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev libssl-dev \
  libxdo-dev libdbus-1-dev build-essential pkg-config
npm install
npm run tauri:dev
```

macOS 前置条件：

```bash
xcode-select --install
# Rust: https://rustup.rs
npm install
npm run tauri:dev
```

Linux/macOS 开发与 release 打包前会额外拉取随包 Node 运行时（不提交到仓库，约 50–100MB）：

```bash
bash scripts/fetch-node.sh          # 按当前系统和架构下载
npm run tauri:build                 # macOS: .app / .dmg
npm run tauri:build -- --bundles deb  # Linux: .deb
```

安装包会自带 `gitty-node` sidecar，优先于系统 Node；没有 sidecar 时回退到系统 `node`。

## 浏览器版

```powershell
npm run demo           # 打开 demo/showcase
# 或指定仓库
npm run dev -- --repo=C:\path\to\repo
```

打开 http://localhost:4173，每 2.2 秒刷新。

## 演示仓库

```powershell
bash scripts/build-demo.sh
```

生成 `demo/showcase`（被观察仓库）、`demo/origin.git`（模拟远端）、`demo/contributor`（模拟另一位开发者），包含多次合并、双向分歧、远端独有与本地独有分支。

## 结构

```
server.mjs           零依赖 Node 服务：git 读取 + status/tags/commit/fetch/仓库切换 API
public/              前端（原生 JS + SVG，无框架）
src-tauri/           Tauri 桌面壳（Rust）：窗口、Acrylic、贴底
scripts/build-demo.sh 演示仓库构建脚本
```

## 已知边界

- 提交窗口 150 条；merge-base 超出窗口时按「全部远端独有」处理
- rebase 副本识别依赖 author time + 作者 + 标题；`--reset-author` 或改写标题后无法自动配对；隐藏已删除分支时旧副本会一起隐藏
- 远端链只画 first-parent 主线
- 没有 upstream 的本地分支不画玻璃带（无远端可比较）
- Stash 不展示（只读定位）

## License

MIT © 2026 KD6137-min


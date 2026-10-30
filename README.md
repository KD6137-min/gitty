# Gitty

一条贴在桌面底部的 Git 分支雷达：约 6cm 高的深色毛玻璃横条，横向时间轴（最新在右），每条本地分支一条车道；远端 upstream 以玻璃层叠在分歧区上，可一键把远端切到前台。

**1.0**：Windows 桌面版已可用（Tauri + WebView2 + 原生 Acrylic）。

## 界面

- 本地提交：实心彩色小圆点
- 远端提交：空心圆环，与本地同心；环内镂空，线不穿环
- 本地与远端共有：大圆套小点；只有远端：空环；只有本地：小点
- 玻璃带：覆盖本地与远端的分歧区，merge-base 留在框外
- Tag：提交上方三角 + 标签名
- 顶部时间轴：release / tag 实心点，可吸附；当前位置为分支色菱形
- 新提交 1s 点亮 + 「N 个新提交」提示

## 功能

- 本地 / 远端视角切换（0.5s 过渡）
- 聚焦模式：点击分支名或提交点；显示汇入分支名；方向键切换（上下切车道、左右切同车道相邻分支）；点击外部或 Esc 退出
- 提交详情：双击提交点查看作者、时间、提交信息、文件增删
- 工作区状态：已暂存 / 未暂存 / 未跟踪计数
- 仓库切换：点击路径下拉，最近仓库持久化
- FETCH 手动拉取；AUTO 每 60 秒自动 fetch（记忆开关）
- 快捷键：`T` 视角、`F` 聚焦、`R` 刷新、`End` 回到最新、`Esc` 退出聚焦
- 只读：不执行 checkout / push / rebase 等写操作

## 桌面版

窗口：无边框、透明、跳过任务栏、贴主屏工作区底部、置底不抢焦点；背景使用 Windows 原生 Acrylic 模糊。

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

- 提交窗口 160 条；merge-base 超出窗口时按「全部远端独有」处理
- 远端链只画 first-parent 主线
- 没有 upstream 的本地分支不画玻璃带（无远端可比较）
- Stash 不展示（只读定位）

## License

MIT © 2026 KD6137-min


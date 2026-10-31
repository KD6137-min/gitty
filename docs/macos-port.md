# macOS 移植任务说明

把现有 Windows 版 Gitty 移植到 macOS。Windows 行为必须保持不变（所有新代码用 `#[cfg(target_os = "macos")]` 分支）。

## 目标

- 无边框、透明、约 6cm 高的横条，贴在主屏底部（Dock 之上）
- macOS 原生毛玻璃（vibrancy）
- 置底：不遮挡其它窗口、不抢焦点
- 不显示 Dock 图标（附件应用）
- 只读读取 git；功能与 Windows 版一致
- 产物：`.app` / `.dmg`

## 环境准备（在 Mac 上）

```bash
xcode-select --install
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install node
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
git clone https://github.com/KD6137-min/gitty.git
cd gitty
npm install
npm run tauri:dev
```

首次 `tauri:dev` 会编译 Rust 依赖，需要几分钟。

## 代码结构与现状

- `server.mjs`：零依赖 Node 服务（git log/refs/status/tags/show/fetch、仓库切换），跨平台，无需修改
- `public/`：原生 SVG 前端，无需大改（只需字体栈与毛玻璃叠加微调）
- `src-tauri/src/main.rs`：Windows 专用代码集中在 `apply_bar` / `set_bottom` / `work_area`（都是 `#[cfg(windows)]`）
- `src-tauri/tauri.conf.json`：已把 `../server.mjs` 和 `../public` 作为资源打包；现在运行的是外部 URL `http://localhost:4173`

## 需要实现的 macOS 部分

### 1. Cargo.toml

```toml
tauri = { version = "2", features = ["macos-private-api"] }  # 透明窗口需要
# 下面二选一，用于设置 NSWindow
objc2 = "0.5"
objc2-app-kit = "0.2"
```

`window-vibrancy` 已支持 macOS。

### 2. 窗口位置（NSScreen.visibleFrame）

用 `app.primary_monitor()` 不够精确（不含菜单栏/Dock 的可见区域），推荐用 objc 取 `NSScreen.mainScreen.visibleFrame`：

- 宽度 = visibleFrame.width
- 高度 = `BAR_HEIGHT`（main.rs 里的常量，可视情况把 315 调成 6cm 对应的值）
- x = visibleFrame.origin.x
- y = visibleFrame.origin.y（Cocoa 原点在左下角；设置 frame 时注意坐标系）
- 通过 `window.ns_window()` 拿到 NSWindow，设置 frame；或在 Tauri 里用 `set_position(LogicalPosition)` + `set_size`

### 3. 置底

macOS 没有 HWND_BOTTOM 的等价物，两种可行做法：

- **推荐**：把窗口层级设到桌面层
  `CGWindowLevelForKey(kCGDesktopWindowLevelKey)`，然后 `NSWindow.setLevel_`
  这样窗口在所有普通窗口之下、壁纸上，符合「桌面贴底小组件」
- 备选：普通层级 + 窗口失去焦点时 `orderBack:`，或在焦点事件里沉底

### 4. 毛玻璃

```rust
#[cfg(target_os = "macos")]
window_vibrancy::apply_vibrancy(
    &window,
    window_vibrancy::NSVisualEffectMaterial::HudWindow,
    None,
    Some(16.0),
);
```

前端 `html.tauri .radar` 目前是 22% 暗色叠加 + 无 CSS 模糊；在 macOS 上按实际效果微调这个值。

### 5. Dock 图标

```rust
#[cfg(target_os = "macos")]
app.set_activation_policy(tauri::ActivationPolicy::Accessory);
```

附件应用不显示 Dock 图标；如果需要显示，去掉这行。

### 6. 资源目录与 Node 路径（安装版关键）

- Windows 安装版把 `server.mjs` / `public/` 放在 exe 旁边；macOS `.app` 里它们在 `Contents/Resources/`
- `project_root()` 在 `.app` 里找不到（`Contents/MacOS` 向上是 `Contents`），需要：
  - 找不到项目根时，用 `app.path().resource_dir()`（macOS 下即 `Contents/Resources`）
  - `spawn_server` 的 `current_dir` 用该目录；`GITTY_DATA_DIR` 继续用 `app_data_dir()`
- **GUI 应用的 PATH 不含 Homebrew**：双击 `.app` 时 `Command::new("node")` 会失败。按顺序尝试：
  `/opt/homebrew/bin/node` → `/usr/local/bin/node` → `/usr/bin/node` → `node`
  （更稳妥的方案是 Tauri sidecar 打包 Node，或把服务端移植到 Rust；先做绝对路径即可）

### 7. 打包

```bash
npm run tauri:build
```

产物在 `src-tauri/target/release/bundle/`：
- `macos/Gitty.app`
- `dmg/Gitty_1.0.0_*.dmg`

未签名时首次打开会被 Gatekeeper 拦截，用户需右键 → 打开，或：

```bash
xattr -dr com.apple.quarantine /Applications/Gitty.app
```

### 8. 签名与公证（可选，需要 Apple Developer 账号）

- Developer ID Application 证书
- `xcrun notarytool submit ... --wait`
- Tauri 支持通过环境变量自动签名/公证，文档：https://v2.tauri.app/distribute/sign/macos/

## 验收标准

- 双击 `.app`：横条贴在主屏底部（Dock 之上），有原生毛玻璃
- 不显示 Dock 图标（或按需）
- 点击横条不会把它抬到其它应用前面；或被点击后自动沉底
- 顶栏路径下拉可切换仓库；最近仓库记录在 `~/Library/Application Support/com.gitty.radar`
- 手动/自动 fetch、tag 标记、提交详情、聚焦模式、方向键均正常
- Windows 构建不受影响（`cargo check` 在 Windows 上仍通过，macOS 代码全部 cfg 隔离）

## 调试提示

- `.app` 里服务起不来：先在 `npm run tauri:dev` 下验证（终端 PATH 完整），再处理 GUI PATH
- 窗口不透明：确认 `macos-private-api` 特性和 `transparent(true)`
- vibrancy 无效：窗口需透明，且 `apply_vibrancy` 在窗口显示前后调用时机要对
- 坐标系：Cocoa 原点在左下角，设置 NSWindow frame 时 y 从底部算

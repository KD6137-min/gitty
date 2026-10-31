#![cfg_attr(windows, windows_subsystem = "windows")]

use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const BAR_HEIGHT: f64 = 315.0;
const BAR_WIDTH: f64 = 315.0;

/// 随应用启动的 Node 服务；退出时杀掉，避免留下占用 4173 的孤儿进程。
struct ServerProcess(std::sync::Mutex<Option<std::process::Child>>);

/// 从可执行文件所在目录向上找 server.mjs（开发时在 target/debug 里也能找到项目根）
fn project_root() -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(mut dir) = exe.parent().map(|p| p.to_path_buf()) {
            for _ in 0..6 {
                if dir.join("server.mjs").exists() {
                    return Some(dir);
                }
                if !dir.pop() {
                    break;
                }
            }
        }
    }
    let cwd = std::env::current_dir().ok()?;
    cwd.join("server.mjs").exists().then_some(cwd)
}

fn server_ready() -> bool {
    TcpStream::connect_timeout(
        &"127.0.0.1:4173".parse().expect("addr"),
        Duration::from_millis(200),
    )
    .is_ok()
}

fn read_last_repo(dir: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(dir.join(".recent-repos.json")).ok()?;
    let list: Vec<String> = serde_json::from_str(&raw).ok()?;
    // 跳过已经不存在的仓库和首次启动时误记的应用资源目录
    list.into_iter().find(|p| Path::new(p).join(".git").exists())
}

/// Node 可执行文件。macOS GUI 应用从 Finder 启动时 PATH 不含 Homebrew，
/// 直接 Command::new("node") 会失败，按 Homebrew(arm64/Intel) → 系统路径依次查找。
fn node_binary() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        for candidate in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
            let path = Path::new(candidate);
            if path.is_file() {
                return path.to_path_buf();
            }
        }
    }
    PathBuf::from("node")
}

/// 启动随附的 Node 服务；如果 4173 已经在监听则直接复用。
/// 安装版里 server.mjs 与 public/ 作为资源放在 exe 旁边（macOS 为 Contents/Resources）。
fn spawn_server(
    root: &Path,
    data_dir: Option<PathBuf>,
    last_repo: Option<String>,
) -> Option<std::process::Child> {
    if server_ready() {
        return None;
    }
    let mut cmd = std::process::Command::new(node_binary());
    cmd.arg("server.mjs");
    if let Some(repo) = last_repo {
        cmd.arg(format!("--repo={repo}"));
    } else {
        let demo = root.join("demo").join("showcase");
        if demo.exists() {
            cmd.arg(format!("--repo={}", demo.display()));
        }
    }
    cmd.current_dir(root);
    if let Some(dir) = data_dir {
        cmd.env("GITTY_DATA_DIR", dir);
    }
    #[cfg(target_os = "macos")]
    {
        // 服务端还要调用 git；把 Homebrew 路径补进子进程 PATH
        let path = format!(
            "/opt/homebrew/bin:/usr/local/bin:{}",
            std::env::var("PATH").unwrap_or_default()
        );
        cmd.env("PATH", path);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let child = cmd.spawn().ok()?;
    for _ in 0..40 {
        if server_ready() {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Some(child)
}

/// 主显示器的可用工作区（扣掉任务栏），单位：物理像素
#[cfg(windows)]
fn work_area() -> Option<(f64, f64, f64, f64)> {
    #[repr(C)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }
    #[link(name = "user32")]
    extern "system" {
        fn SystemParametersInfoW(action: u32, param: u32, pv: *mut core::ffi::c_void, ini: u32) -> i32;
    }
    let mut rect = Rect { left: 0, top: 0, right: 0, bottom: 0 };
    let ok = unsafe {
        SystemParametersInfoW(
            0x0030, // SPI_GETWORKAREA
            0,
            &mut rect as *mut _ as *mut core::ffi::c_void,
            0,
        )
    };
    (ok != 0).then(|| (rect.left as f64, rect.top as f64, rect.right as f64, rect.bottom as f64))
}

/// 把窗口摆到指定矩形，并压到 z 序最底
#[cfg(windows)]
fn place(hwnd_addr: isize, x: i32, y: i32, w: i32, h: i32) {
    #[link(name = "user32")]
    extern "system" {
        fn SetWindowPos(
            hwnd: *mut core::ffi::c_void,
            after: *mut core::ffi::c_void,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> i32;
    }
    const SWP_NOACTIVATE: u32 = 0x0010;
    unsafe {
        SetWindowPos(
            hwnd_addr as *mut core::ffi::c_void,
            1usize as *mut core::ffi::c_void, // HWND_BOTTOM
            x,
            y,
            w,
            h,
            SWP_NOACTIVATE,
        );
    }
}

/// 启动时把窗口摆到主屏工作区底部（只做一次）。
/// Tauri 的 set_size/set_position 在创建阶段会被窗口管理器覆盖，这里用 Win32 强制定位。
#[cfg(windows)]
fn apply_bar(hwnd_addr: isize, scale: f64) {
    // 线程里从 isize 重新构造指针（原始指针不是 Send）
    std::thread::spawn(move || {
        let bar_h = (BAR_HEIGHT * scale).round() as i32;
        loop {
            if let Some((left, _top, right, bottom_y)) = work_area() {
                place(
                    hwnd_addr,
                    left.round() as i32,
                    bottom_y.round() as i32 - bar_h,
                    (right - left).round() as i32,
                    bar_h,
                );
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    });
}

/// 前端切换横/竖版：横向=底部全宽横条，竖向=左侧全高竖条
#[tauri::command]
fn set_orientation(window: tauri::WebviewWindow, orientation: String) {
    #[cfg(windows)]
    {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        if let Ok(handle) = window.window_handle() {
            if let RawWindowHandle::Win32(h) = handle.as_raw() {
                let addr = h.hwnd.get();
                let scale = window.scale_factor().unwrap_or(1.0);
                if let Some((left, top, right, bottom)) = work_area() {
                    let bar_h = (BAR_HEIGHT * scale).round() as i32;
                    let bar_w = (BAR_WIDTH * scale).round() as i32;
                    let (x, y, w, hh) = if orientation == "v" {
                        (left.round() as i32, top.round() as i32, bar_w, (bottom - top).round() as i32)
                    } else {
                        (left.round() as i32, bottom.round() as i32 - bar_h, (right - left).round() as i32, bar_h)
                    };
                    place(addr, x, y, w, hh);
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        let vertical = orientation == "v";
        let win = window.clone();
        let _ = window.run_on_main_thread(move || place_macos(&win, vertical));
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (window, orientation);
    }
}

/// 只把窗口压回 z 序最底，不改位置和大小（点击后调用，平时不调用，避免闪烁）
#[cfg(windows)]
fn set_bottom(hwnd_addr: isize) {
    #[link(name = "user32")]
    extern "system" {
        fn SetWindowPos(
            hwnd: *mut core::ffi::c_void,
            after: *mut core::ffi::c_void,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> i32;
    }
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOACTIVATE: u32 = 0x0010;
    unsafe {
        SetWindowPos(
            hwnd_addr as *mut core::ffi::c_void,
            1usize as *mut core::ffi::c_void,
            0,
            0,
            0,
            0,
            SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE,
        );
    }
}

/// macOS：把窗口铺到主屏可用区域（NSScreen.visibleFrame，已扣掉菜单栏和 Dock）。
/// 横向贴底（全宽 × BAR_HEIGHT），竖向贴左（BAR_WIDTH × 全高）。
#[cfg(target_os = "macos")]
fn place_macos(window: &tauri::WebviewWindow, vertical: bool) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{
        NSAppearance, NSAppearanceCustomization, NSAppearanceNameDarkAqua, NSScreen, NSWindow,
    };
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    let Some(mtm) = MainThreadMarker::new() else { return };
    let Some(screen) = NSScreen::mainScreen(mtm) else { return };
    let visible = screen.visibleFrame();
    let Ok(ns_window) = window.ns_window() else { return };
    if ns_window.is_null() || visible.size.width <= 0.0 || visible.size.height <= 0.0 {
        return;
    }

    let (width, height) = if vertical {
        (BAR_WIDTH.min(visible.size.width), visible.size.height)
    } else {
        (visible.size.width, BAR_HEIGHT.min(visible.size.height))
    };
    let frame = NSRect {
        origin: NSPoint {
            x: visible.origin.x,
            y: visible.origin.y,
        },
        size: NSSize { width, height },
    };
    // 比普通窗口低一层（-1）：普通窗口始终盖在它上面，但它能接收点击。
    // 更低的桌面层级会被 Finder 桌面窗口吞掉鼠标事件。
    let level: objc2_app_kit::NSWindowLevel = -1;

    // SAFETY: ns_window 是 Tauri 返回的有效 NSWindow 指针，且 setup 运行在主线程。
    unsafe {
        let ns_window = &*(ns_window as *const NSWindow);
        // 强制深色外观，否则浅色系统下 HUD 毛玻璃会发白、灰字看不清
        if let Some(appearance) = NSAppearance::appearanceNamed(NSAppearanceNameDarkAqua) {
            ns_window.setAppearance(Some(&appearance));
        }
        ns_window.setFrame_display(frame, true);
        ns_window.setLevel(level);
    }
}

/// 菜单栏用的 18pt 菱形模板图：黑色形状 + alpha，系统会自动适配浅色/深色菜单栏。
#[cfg(target_os = "macos")]
fn tray_diamond_icon() -> tauri::image::Image<'static> {
    const SIZE: u32 = 32;
    const SAMPLES: u32 = 4;
    let mut rgba = vec![0u8; (SIZE * SIZE * 4) as usize];
    let center = (SIZE as f64 - 1.0) / 2.0;
    let radius = 13.0;
    for y in 0..SIZE {
        for x in 0..SIZE {
            let mut hits = 0u32;
            for sy in 0..SAMPLES {
                for sx in 0..SAMPLES {
                    let px = x as f64 + (sx as f64 + 0.5) / SAMPLES as f64;
                    let py = y as f64 + (sy as f64 + 0.5) / SAMPLES as f64;
                    if (px - center).abs() + (py - center).abs() <= radius {
                        hits += 1;
                    }
                }
            }
            if hits > 0 {
                let alpha = (hits as f64 / (SAMPLES * SAMPLES) as f64 * 255.0).round() as u8;
                let i = ((y * SIZE + x) * 4) as usize;
                rgba[i + 3] = alpha;
            }
        }
    }
    tauri::image::Image::new_owned(rgba, SIZE, SIZE)
}

/// macOS 菜单栏图标：附件应用没有 Dock 图标和窗口装饰，用它来显示/隐藏/退出。
#[cfg(target_os = "macos")]
fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    use tauri::menu::MenuBuilder;
    use tauri::tray::TrayIconBuilder;

    let menu = MenuBuilder::new(app.handle())
        .text("show", "显示 Gitty")
        .text("hide", "隐藏 Gitty")
        .separator()
        .text("quit", "退出 Gitty")
        .build()?;

    TrayIconBuilder::with_id("gitty-tray")
        .icon(tray_diamond_icon())
        .icon_as_template(true)
        .tooltip("Gitty — 显示 / 隐藏 / 退出")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "hide" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app.handle())?;
    Ok(())
}

/// 退出时停止随应用启动的 Node 服务（复用已有服务时不会动它）。
fn cleanup_server(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<ServerProcess>() {
        let child = state.0.lock().ok().and_then(|mut guard| guard.take());
        if let Some(mut child) = child {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![set_orientation])
        .setup(|app| {
            // macOS：附件应用，不显示 Dock 图标，也不参与 Cmd+Tab
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                if let Err(err) = setup_tray(app) {
                    eprintln!("setup_tray failed: {err}");
                }
            }

            // 最近仓库记录写到用户数据目录（安装目录通常不可写）
            let data_dir = app.path().app_data_dir().ok();
            if let Some(dir) = &data_dir {
                let _ = std::fs::create_dir_all(dir);
            }
            let last_repo = data_dir.as_ref().and_then(|d| read_last_repo(d));

            // 开发版/Windows 安装版：server.mjs 在 exe 附近或项目根；
            // macOS .app：server.mjs 与 public/ 打包在 Contents/Resources。
            #[cfg(target_os = "macos")]
            let root = project_root().or_else(|| {
                app.path()
                    .resource_dir()
                    .ok()
                    .filter(|dir| dir.join("server.mjs").exists())
            });
            #[cfg(not(target_os = "macos"))]
            let root = project_root();
            let server = root.and_then(|root| spawn_server(&root, data_dir, last_repo));
            app.manage(ServerProcess(std::sync::Mutex::new(server)));

            // 界面用 Tauri 内置资源加载（本地来源，IPC 命令可用）
            let url = WebviewUrl::App("index.html".into());
            #[allow(unused_mut)]
            let mut builder = WebviewWindowBuilder::new(app, "main", url)
                .title("Gitty")
                .inner_size(1400.0, BAR_HEIGHT)
                .decorations(false)
                .transparent(true)
                .resizable(false)
                .maximizable(false)
                .minimizable(false)
                .skip_taskbar(true)
                .shadow(false);
            // macOS：点击未激活的窗口时，第一次点击也直接落到网页内容上
            #[cfg(target_os = "macos")]
            {
                builder = builder.focused(false).accept_first_mouse(true);
            }
            let window = builder.build()?;

            // 贴底：由后台线程用 Win32 每秒强制定位，避免被窗口管理器覆盖
            #[cfg(windows)]
            {
                // Windows 10/11 原生亚克力：真正模糊桌面背景
                let _ = window_vibrancy::apply_acrylic(&window, Some((18, 18, 18, 140)));

                use raw_window_handle::{HasWindowHandle, RawWindowHandle};
                if let Ok(handle) = window.window_handle() {
                    if let RawWindowHandle::Win32(h) = handle.as_raw() {
                        let scale = window.scale_factor().unwrap_or(1.0);
                        let addr = h.hwnd.get();
                        apply_bar(addr, scale);
                        // 点击窗口获得焦点后，延迟 200ms 沉回底部；平时不做任何周期性操作
                        window.on_window_event(move |event| {
                            if matches!(event, tauri::WindowEvent::Focused(true)) {
                                std::thread::spawn(move || {
                                    std::thread::sleep(Duration::from_millis(200));
                                    set_bottom(addr);
                                });
                            }
                        });
                    }
                }
            }

            // macOS：原生毛玻璃 + 贴主屏底部（Dock 之上）
            #[cfg(target_os = "macos")]
            {
                place_macos(&window, false);
                // HUD 材质 + Active 状态：附件应用几乎不会成为活跃窗口，
                // 固定 Active 才能一直保持毛玻璃的鲜明效果。
                if let Err(err) = window_vibrancy::apply_vibrancy(
                    &window,
                    window_vibrancy::NSVisualEffectMaterial::HudWindow,
                    Some(window_vibrancy::NSVisualEffectState::Active),
                    Some(16.0),
                ) {
                    eprintln!("apply_vibrancy failed: {err}");
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                cleanup_server(app);
            }
        });
}

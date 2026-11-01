#![cfg_attr(windows, windows_subsystem = "windows")]

use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "linux")]
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

const BAR_HEIGHT: f64 = 315.0;
const BAR_WIDTH: f64 = 315.0;

/// Linux 当前朝向：拖拽吸附和重新定位时要用。
#[cfg(target_os = "linux")]
static LINUX_VERTICAL: AtomicBool = AtomicBool::new(false);
/// 连续 Moved 事件的代次，只对最后一次移动做吸附。
#[cfg(target_os = "linux")]
static LINUX_MOVE_GEN: AtomicU64 = AtomicU64::new(0);
/// 窗口宽度拖拽结束后的保存代次。
#[cfg(target_os = "linux")]
static LINUX_RESIZE_GEN: AtomicU64 = AtomicU64::new(0);

/// 随应用启动的 Node 服务；退出时杀掉，避免留下占用 4173 的孤儿进程。
struct ServerProcess(std::sync::Mutex<Option<std::process::Child>>);

/// 从可执行文件所在目录向上找 server.mjs（开发时在 target/debug 里也能找到项目根）。
/// tauri dev 会把 resources 复制到 target/debug，那里也有 server.mjs；
/// 所以第一轮只认带 package.json / src-tauri 的真实项目根，找不到再退回安装布局。
fn project_root() -> Option<PathBuf> {
    let mut install_root = None;
    if let Ok(exe) = std::env::current_exe() {
        if let Some(mut dir) = exe.parent().map(|p| p.to_path_buf()) {
            for _ in 0..6 {
                if dir.join("server.mjs").exists() {
                    if dir.join("package.json").exists() || dir.join("src-tauri").exists() {
                        return Some(dir);
                    }
                    if install_root.is_none() {
                        install_root = Some(dir.clone());
                    }
                }
                if !dir.pop() {
                    break;
                }
            }
        }
    }
    if install_root.is_some() {
        return install_root;
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
    #[cfg(target_os = "linux")]
    {
        // 从桌面环境启动时 PATH 可能不含版本管理器；优先系统 node，找不到再交给 PATH。
        for candidate in ["/usr/bin/node", "/usr/local/bin/node"] {
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
    #[cfg(target_os = "linux")]
    {
        let vertical = orientation == "v";
        LINUX_VERTICAL.store(vertical, Ordering::SeqCst);
        let win = window.clone();
        let _ = window.run_on_main_thread(move || place_linux_current(&win, vertical));
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
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

/// Linux/X11 上的一块显示器（RandR 根窗口坐标）。
#[cfg(target_os = "linux")]
struct LinuxMonitor {
    name: String,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    primary: bool,
}

/// 读取所有 RandR 显示器与整块根窗口的 EWMH 工作区。
#[cfg(target_os = "linux")]
fn linux_monitors() -> Option<(Vec<LinuxMonitor>, (i32, i32, i32, i32))> {
    use x11rb::connection::Connection;
    use x11rb::protocol::randr::ConnectionExt as RandrExt;
    use x11rb::protocol::xproto::{AtomEnum, ConnectionExt as XprotoExt};

    let (conn, screen_num) = x11rb::connect(None).ok()?;
    let screen = &conn.setup().roots[screen_num];
    let root = screen.root;
    let mut monitors = Vec::new();
    if let Some(reply) = conn
        .randr_get_monitors(root, true)
        .ok()
        .and_then(|cookie| cookie.reply().ok())
    {
        for m in &reply.monitors {
            let name = conn
                .get_atom_name(m.name)
                .ok()
                .and_then(|cookie| cookie.reply().ok())
                .map(|reply| String::from_utf8_lossy(&reply.name).into_owned())
                .unwrap_or_default();
            monitors.push(LinuxMonitor {
                name,
                x: m.x as i32,
                y: m.y as i32,
                width: m.width as i32,
                height: m.height as i32,
                primary: m.primary,
            });
        }
    }
    // 老 X 服务器没有 RandR 1.5 时退回整块根窗口
    if monitors.is_empty() {
        monitors.push(LinuxMonitor {
            name: String::new(),
            x: 0,
            y: 0,
            width: screen.width_in_pixels as i32,
            height: screen.height_in_pixels as i32,
            primary: true,
        });
    }

    // _NET_WORKAREA 是整块根窗口的工作区（已扣掉面板 / Dock），与具体显示器求交
    let mut work = (
        0,
        0,
        screen.width_in_pixels as i32,
        screen.height_in_pixels as i32,
    );
    if let Some(values) = conn
        .intern_atom(false, b"_NET_WORKAREA")
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .filter(|reply| reply.atom != 0)
        .and_then(|reply| {
            conn.get_property(false, root, reply.atom, AtomEnum::CARDINAL, 0, 4)
                .ok()?
                .reply()
                .ok()
        })
        .and_then(|reply| {
            reply
                .value32()
                .map(|values| values.collect::<Vec<u32>>())
        })
    {
        if values.len() >= 4 {
            work = (
                values[0] as i32,
                values[1] as i32,
                values[2] as i32,
                values[3] as i32,
            );
        }
    }

    Some((monitors, work))
}

/// 选择显示器：优先按保存的 RandR 名称，其次按窗口中心点，最后退回主屏。
/// 返回显示器名称和它扣掉面板后的工作区。
#[cfg(target_os = "linux")]
fn linux_work_area_for(
    name: Option<&str>,
    point: Option<(i32, i32)>,
) -> Option<(String, i32, i32, i32, i32)> {
    let (monitors, work) = linux_monitors()?;
    let by_name = name.and_then(|name| {
        (!name.is_empty())
            .then(|| monitors.iter().find(|m| m.name == name))
            .flatten()
    });
    let by_point = point.and_then(|(px, py)| {
        monitors
            .iter()
            .find(|m| px >= m.x && px < m.x + m.width && py >= m.y && py < m.y + m.height)
            .or_else(|| {
                monitors.iter().min_by_key(|m| {
                    let dx = (m.x + m.width / 2 - px) as i64;
                    let dy = (m.y + m.height / 2 - py) as i64;
                    dx * dx + dy * dy
                })
            })
    });
    let chosen = by_name
        .or(by_point)
        .or_else(|| monitors.iter().find(|m| m.primary))
        .or_else(|| monitors.first())?;

    // _NET_WORKAREA 是整个根窗口的单一矩形；GNOME 的顶部面板只在主屏。
    // 把它套到非主屏会把副屏顶部也切掉，竖版就填不满高度，所以非主屏用完整显示器矩形。
    if !chosen.primary {
        return Some((
            chosen.name.clone(),
            chosen.x,
            chosen.y,
            chosen.width,
            chosen.height,
        ));
    }

    let (wx, wy, ww, wh) = work;
    let x1 = chosen.x.max(wx);
    let y1 = chosen.y.max(wy);
    let x2 = (chosen.x + chosen.width).min(wx + ww);
    let y2 = (chosen.y + chosen.height).min(wy + wh);
    if x2 > x1 && y2 > y1 {
        Some((chosen.name.clone(), x1, y1, x2 - x1, y2 - y1))
    } else {
        Some((
            chosen.name.clone(),
            chosen.x,
            chosen.y,
            chosen.width,
            chosen.height,
        ))
    }
}

/// 上次吸附到的显示器名称，记在应用数据目录里。
#[cfg(target_os = "linux")]
fn linux_monitor_file(window: &tauri::WebviewWindow) -> Option<PathBuf> {
    window
        .app_handle()
        .path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(".window-monitor"))
}

#[cfg(target_os = "linux")]
fn read_saved_monitor(window: &tauri::WebviewWindow) -> Option<String> {
    let name = std::fs::read_to_string(linux_monitor_file(window)?).ok()?;
    let name = name.trim().to_string();
    (!name.is_empty()).then_some(name)
}

#[cfg(target_os = "linux")]
fn save_monitor(window: &tauri::WebviewWindow, name: &str) {
    let Some(path) = linux_monitor_file(window) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, name);
}

/// 竖版宽度（物理像素）存在应用数据目录；默认取所在显示器工作区的一半。
#[cfg(target_os = "linux")]
fn linux_width_file(window: &tauri::WebviewWindow) -> Option<PathBuf> {
    window
        .app_handle()
        .path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(".window-width"))
}

#[cfg(target_os = "linux")]
fn read_saved_width(window: &tauri::WebviewWindow) -> Option<i32> {
    let raw = std::fs::read_to_string(linux_width_file(window)?).ok()?;
    raw.trim().parse::<i32>().ok().filter(|w| *w > 0)
}

#[cfg(target_os = "linux")]
fn save_vertical_width(window: &tauri::WebviewWindow, width: i32) {
    let Some(path) = linux_width_file(window) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, width.to_string());
}

#[cfg(target_os = "linux")]
fn linux_vertical_width(window: &tauri::WebviewWindow, monitor_w: i32, scale: f64) -> i32 {
    let min = (BAR_WIDTH * scale).round() as i32;
    // 竖版默认半屏，最宽也只到所在显示器工作区的一半
    let max = (monitor_w / 2).max(min);
    let saved = read_saved_width(window).unwrap_or(max);
    saved.clamp(min, max)
}

/// 吸附边：横版 top/bottom，竖版 left/right，分别记住。
#[cfg(target_os = "linux")]
fn linux_edge_file(window: &tauri::WebviewWindow) -> Option<PathBuf> {
    window
        .app_handle()
        .path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(".window-edge"))
}

#[cfg(target_os = "linux")]
fn read_edges(window: &tauri::WebviewWindow) -> (String, String) {
    let raw = linux_edge_file(window)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .unwrap_or_default();
    let mut parts = raw.split_whitespace();
    let h = if parts.next() == Some("top") { "top" } else { "bottom" };
    let v = if parts.next() == Some("right") { "right" } else { "left" };
    (h.to_string(), v.to_string())
}

#[cfg(target_os = "linux")]
fn save_edges(window: &tauri::WebviewWindow, h_edge: &str, v_edge: &str) {
    let Some(path) = linux_edge_file(window) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, format!("{h_edge} {v_edge}"));
}

/// “折叠已合并历史”状态（系统托盘和前端共用），存在应用数据目录，默认折叠。
fn fold_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(".window-fold"))
}

fn read_fold(app: &tauri::AppHandle) -> bool {
    fold_file(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .map(|raw| raw.trim() != "0")
        .unwrap_or(true)
}

fn write_fold(app: &tauri::AppHandle, folded: bool) {
    let Some(path) = fold_file(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, if folded { "1" } else { "0" });
}

#[tauri::command]
fn get_fold(app: tauri::AppHandle) -> bool {
    read_fold(&app)
}

/// Linux/X11：把窗口压回普通窗口之下，且不激活它。
/// GNOME 对 _NET_WM_STATE_BELOW 的支持并不总是稳定，所以在获得焦点后再直接改一次栈序。
#[cfg(target_os = "linux")]
fn lower_linux(window: &tauri::WebviewWindow) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{ConfigureWindowAux, ConnectionExt, StackMode};
    let _ = window.set_always_on_bottom(true);
    let Ok(handle) = window.window_handle() else { return };
    let xid = match handle.as_raw() {
        RawWindowHandle::Xlib(h) => h.window as u32,
        RawWindowHandle::Xcb(h) => h.window.get(),
        _ => return,
    };
    if let Ok((conn, _)) = x11rb::connect(None) {
        let _ = conn.configure_window(
            xid,
            &ConfigureWindowAux::new().stack_mode(StackMode::BELOW),
        );
        let _ = conn.flush();
    }
}

/// Linux/X11：直接改客户窗口的几何，并清掉 GTK 可能留下的 min/max 尺寸提示。
/// Tauri/GTK 的 resizable 约束会阻止横/竖切换时改宽度，所以这里绕开它。
#[cfg(target_os = "linux")]
fn set_geometry_linux(window: &tauri::WebviewWindow, x: i32, y: i32, w: u32, h: u32) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{AtomEnum, ConfigureWindowAux, ConnectionExt};
    let Ok(handle) = window.window_handle() else { return };
    let xid = match handle.as_raw() {
        RawWindowHandle::Xlib(h) => h.window as u32,
        RawWindowHandle::Xcb(h) => h.window.get(),
        _ => return,
    };
    if let Ok((conn, _)) = x11rb::connect(None) {
        let _ = conn.delete_property(xid, AtomEnum::WM_NORMAL_HINTS.into());
        let _ = conn.configure_window(
            xid,
            &ConfigureWindowAux::new()
                .x(x)
                .y(y)
                .width(w.max(1))
                .height(h.max(1)),
        );
        let _ = conn.flush();
    }
}

/// Linux/X11：把窗口摆到指定显示器的工作区边缘。
/// 横版贴底（全宽 × 6cm），竖版贴左（6cm × 全高）。
#[cfg(target_os = "linux")]
fn apply_linux_geometry(
    window: &tauri::WebviewWindow,
    vertical: bool,
    monitor: &str,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) {
    if w <= 0 || h <= 0 {
        return;
    }
    LINUX_VERTICAL.store(vertical, Ordering::SeqCst);
    let scale = window.scale_factor().unwrap_or(1.0);
    let bar_h = (BAR_HEIGHT * scale).round() as i32;
    let (h_edge, v_edge) = read_edges(window);
    let (px, py, pw, ph) = if vertical {
        let pw = linux_vertical_width(window, w, scale).min(w);
        let px = if v_edge == "right" { x + w - pw } else { x };
        (px, y, pw, h)
    } else {
        let ph = bar_h.min(h);
        let py = if h_edge == "top" { y } else { y + h - ph };
        (x, py, w, ph)
    };
    let pw = pw.max(1) as u32;
    let ph = ph.max(1) as u32;
    let unchanged = window
        .outer_position()
        .ok()
        .zip(window.outer_size().ok())
        .map(|(p, s)| p.x == px && p.y == py && s.width == pw && s.height == ph)
        .unwrap_or(false);
    if !unchanged {
        set_geometry_linux(window, px, py, pw, ph);
    }
    save_monitor(window, monitor);
    // 让前端根据吸附边调整圆角/投影；页面还没加载时忽略错误，稍后的 invoke 会再设置
    let _ = window.eval(&format!(
        "document.documentElement.dataset.hEdge='{h_edge}';document.documentElement.dataset.vEdge='{v_edge}';"
    ));
    lower_linux(window);
}

/// 启动时用上次记住的显示器；没有记录就用主屏。
#[cfg(target_os = "linux")]
fn place_linux_saved(window: &tauri::WebviewWindow, vertical: bool) {
    let saved = read_saved_monitor(window);
    if let Some((monitor, x, y, w, h)) = linux_work_area_for(saved.as_deref(), None) {
        apply_linux_geometry(window, vertical, &monitor, x, y, w, h);
    }
}

/// 按窗口当前中心所在显示器吸附；拖动结束后调用。
#[cfg(target_os = "linux")]
fn place_linux_current(window: &tauri::WebviewWindow, vertical: bool) {
    let point = window
        .outer_position()
        .ok()
        .zip(window.outer_size().ok())
        .map(|(p, s)| (p.x + s.width as i32 / 2, p.y + s.height as i32 / 2));
    if let Some((monitor, x, y, w, h)) = linux_work_area_for(None, point) {
        apply_linux_geometry(window, vertical, &monitor, x, y, w, h);
    }
}

/// 拖动结束后：按窗口中心落在显示器的哪一半，决定贴 top/bottom（横版）
/// 或 left/right（竖版），记住该方向后再吸附。
#[cfg(target_os = "linux")]
fn place_linux_after_drag(window: &tauri::WebviewWindow, vertical: bool) {
    let pos = window.outer_position().ok();
    let size = window.outer_size().ok();
    let point = pos
        .zip(size)
        .map(|(p, s)| (p.x + s.width as i32 / 2, p.y + s.height as i32 / 2));
    let Some((monitor, x, y, w, h)) = linux_work_area_for(None, point) else { return };
    let (mut h_edge, mut v_edge) = read_edges(window);
    if let (Some(p), Some(s)) = (pos, size) {
        let cx = p.x + s.width as i32 / 2;
        let cy = p.y + s.height as i32 / 2;
        if vertical {
            v_edge = if cx < x + w / 2 { "left" } else { "right" }.to_string();
        } else {
            h_edge = if cy < y + h / 2 { "top" } else { "bottom" }.to_string();
        }
    }
    save_edges(window, &h_edge, &v_edge);
    apply_linux_geometry(window, vertical, &monitor, x, y, w, h);
}

/// Moved 事件去抖：只在最后一次移动 600ms 后吸附，避免拖动过程中不断重排。
#[cfg(target_os = "linux")]
fn schedule_linux_snap(window: tauri::WebviewWindow) {
    let generation = LINUX_MOVE_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(600));
        if LINUX_MOVE_GEN.load(Ordering::SeqCst) != generation {
            return;
        }
        let win = window.clone();
        let _ = window.run_on_main_thread(move || {
            let vertical = LINUX_VERTICAL.load(Ordering::SeqCst);
            place_linux_after_drag(&win, vertical);
        });
    });
}

/// Resized 去抖：记住用户拖出来的竖版宽度。
#[cfg(target_os = "linux")]
fn schedule_linux_width_save(window: tauri::WebviewWindow) {
    if !LINUX_VERTICAL.load(Ordering::SeqCst) {
        return;
    }
    let generation = LINUX_RESIZE_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(350));
        if LINUX_RESIZE_GEN.load(Ordering::SeqCst) != generation {
            return;
        }
        let win = window.clone();
        let _ = window.run_on_main_thread(move || {
            if !LINUX_VERTICAL.load(Ordering::SeqCst) {
                return;
            }
            if let Ok(size) = win.outer_size() {
                save_vertical_width(&win, size.width as i32);
            }
        });
    });
}

/// 托盘菱形：32px、四重采样抗锯齿。
/// fill=None 时是黑色模板图（macOS 菜单栏自动适配明暗）；Some(rgb) 时填充品牌色（Windows 托盘）。
#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
fn tray_diamond_icon(fill: Option<(u8, u8, u8)>) -> tauri::image::Image<'static> {
    const SIZE: u32 = 32;
    const SAMPLES: u32 = 4;
    let (r, g, b) = fill.unwrap_or((0, 0, 0));
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
                rgba[i] = r;
                rgba[i + 1] = g;
                rgba[i + 2] = b;
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
        .icon(tray_diamond_icon(None))
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

/// Windows 系统托盘：品牌红菱形 + 右键菜单（显示 / 隐藏 / 退出）。
#[cfg(windows)]
fn setup_windows_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::MenuBuilder;
    use tauri::tray::TrayIconBuilder;

    let menu = MenuBuilder::new(app)
        .text("show", "显示 Gitty")
        .text("hide", "隐藏 Gitty")
        .separator()
        .text("quit", "退出 Gitty")
        .build()?;

    TrayIconBuilder::with_id("gitty-tray")
        .icon(tray_diamond_icon(Some((255, 107, 85)))) // #FF6B55
        .tooltip("Gitty — 显示 / 隐藏 / 退出")
        .menu(&menu)
        .show_menu_on_left_click(false) // Windows 上右键弹出菜单
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                }
            }
            "hide" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            "quit" => {
                cleanup_server(app);
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

/// Linux 托盘：libayatana-appindicator（GNOME 需要 AppIndicator 扩展才能显示）。
/// 菜单与 Windows 一致，用来唤回无任务栏入口的贴底窗口。
#[cfg(target_os = "linux")]
fn setup_linux_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use std::sync::atomic::{AtomicBool, Ordering};
    use tauri::menu::{CheckMenuItemBuilder, MenuBuilder};
    use tauri::tray::TrayIconBuilder;

    let folded = read_fold(app);
    let history = CheckMenuItemBuilder::with_id("history", "隐藏已合并历史")
        .checked(folded)
        .build(app)?;
    let menu = MenuBuilder::new(app)
        .text("show", "显示 Gitty")
        .text("hide", "隐藏 Gitty")
        .separator()
        .text("orient-h", "横版")
        .text("orient-v", "竖版")
        .separator()
        .item(&history)
        .separator()
        .text("quit", "退出 Gitty")
        .build()?;

    let fold_state = AtomicBool::new(folded);
    let history_item = history.clone();

    TrayIconBuilder::with_id("gitty-tray")
        .icon(tray_diamond_icon(Some((255, 107, 85)))) // #FF6B55
        .tooltip("Gitty — 显示 / 隐藏 / 横竖 / 退出")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_always_on_bottom(true);
                }
            }
            "hide" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            "orient-h" | "orient-v" => {
                let next = if event.id().as_ref() == "orient-v" { "v" } else { "h" };
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.eval(&format!(
                        "window.__gittySetOrientation && window.__gittySetOrientation('{next}')"
                    ));
                }
            }
            "history" => {
                let next = !fold_state.load(Ordering::SeqCst);
                fold_state.store(next, Ordering::SeqCst);
                let _ = history_item.set_checked(next);
                write_fold(app, next);
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.eval(&format!(
                        "window.__gittySetFold && window.__gittySetFold({next})"
                    ));
                }
            }
            "quit" => {
                cleanup_server(app);
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
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
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![set_orientation, get_fold])
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
            // macOS .app / Linux 包：server.mjs 与 public/ 打在资源目录里。
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            let root = project_root().or_else(|| {
                app.path()
                    .resource_dir()
                    .ok()
                    .filter(|dir| dir.join("server.mjs").exists())
            });
            #[cfg(not(any(target_os = "macos", target_os = "linux")))]
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
                .maximizable(false)
                .minimizable(false)
                .skip_taskbar(true)
                .shadow(false);
            // Linux：resizable(false) 会把 WM_NORMAL_HINTS 的 min/max 锁在当前尺寸，
            // 之后横/竖切换就无法改宽高；Linux 不锁尺寸，由 place_linux_* 直接改 X11 几何。
            #[cfg(not(target_os = "linux"))]
            {
                builder = builder.resizable(false);
            }
            // macOS：点击未激活的窗口时，第一次点击也直接落到网页内容上
            #[cfg(target_os = "macos")]
            {
                builder = builder.focused(false).accept_first_mouse(true);
            }
            // Linux：先隐藏，定位到工作区后再显示，避免窗口在屏幕中央闪一下
            #[cfg(target_os = "linux")]
            {
                builder = builder
                    .focused(false)
                    .always_on_bottom(true)
                    .visible(false);
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

            // Linux/X11：贴所在显示器的工作区（GNOME 顶部面板之下），并压到普通窗口之下。
            // 桌面级毛玻璃在 X11 没有通用 API（window-vibrancy 明确不支持 Linux），
            // 由前端 html.tauri-linux 用更深的暗色叠加降级，内层虚焦保持不变。
            #[cfg(target_os = "linux")]
            {
                place_linux_saved(&window, false);
                let _ = window.show();
                // 有的 WM 在首次 map 后才应用尺寸，显示后再定位一次
                place_linux_saved(&window, false);
                lower_linux(&window);
                // 获得焦点后延迟沉回底部；拖动结束后吸附到窗口中心所在的显示器
                let event_window = window.clone();
                window.on_window_event(move |event| match event {
                    tauri::WindowEvent::Focused(true) => {
                        let win = event_window.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(Duration::from_millis(200));
                            let target = win.clone();
                            let _ = win.run_on_main_thread(move || lower_linux(&target));
                        });
                    }
                    tauri::WindowEvent::Moved(_) => schedule_linux_snap(event_window.clone()),
                    tauri::WindowEvent::Resized(_) => schedule_linux_width_save(event_window.clone()),
                    _ => {}
                });
            }

            // Windows：系统托盘（窗口无任务栏入口，靠它隐藏 / 唤回 / 退出）
            #[cfg(windows)]
            {
                if let Err(err) = setup_windows_tray(app.handle()) {
                    eprintln!("setup_windows_tray failed: {err}");
                }
            }

            // Linux：托盘（GNOME 需要 AppIndicator 扩展；失败不影响主窗口）
            #[cfg(target_os = "linux")]
            {
                if let Err(err) = setup_linux_tray(app.handle()) {
                    eprintln!("setup_linux_tray failed: {err}");
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

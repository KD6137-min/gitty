#![cfg_attr(windows, windows_subsystem = "windows")]

use std::net::TcpStream;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{WebviewUrl, WebviewWindowBuilder};

const BAR_HEIGHT: f64 = 315.0;

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

/// 启动随附的 Node 服务；如果 4173 已经在监听则直接复用
fn spawn_server() {
    if server_ready() {
        return;
    }
    let Some(root) = project_root() else { return };
    let mut cmd = std::process::Command::new("node");
    cmd.arg("server.mjs");
    let demo = root.join("demo").join("showcase");
    if demo.exists() {
        cmd.arg(format!("--repo={}", demo.display()));
    }
    cmd.current_dir(&root);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let _ = cmd.spawn();
    for _ in 0..40 {
        if server_ready() {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
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

/// 启动时把窗口摆到主屏工作区底部（只做一次）。
/// Tauri 的 set_size/set_position 在创建阶段会被窗口管理器覆盖，这里用 Win32 强制定位。
#[cfg(windows)]
fn apply_bar(hwnd_addr: isize, scale: f64) {
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
    // 线程里从 isize 重新构造指针（原始指针不是 Send）
    std::thread::spawn(move || {
        let bar_h = (BAR_HEIGHT * scale).round() as i32;
        loop {
            if let Some((left, _top, right, bottom_y)) = work_area() {
                let hwnd = hwnd_addr as *mut core::ffi::c_void;
                let bottom = 1usize as *mut core::ffi::c_void; // HWND_BOTTOM
                unsafe {
                    SetWindowPos(
                        hwnd,
                        bottom,
                        left.round() as i32,
                        bottom_y.round() as i32 - bar_h,
                        (right - left).round() as i32,
                        bar_h,
                        SWP_NOACTIVATE,
                    );
                }
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    });
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

fn main() {
    spawn_server();

    tauri::Builder::default()
        .setup(|app| {
            let url = WebviewUrl::External("http://localhost:4173".parse().expect("url"));
            let window = WebviewWindowBuilder::new(app, "main", url)
                .title("Gitty")
                .inner_size(1400.0, BAR_HEIGHT)
                .decorations(false)
                .transparent(true)
                .resizable(false)
                .maximizable(false)
                .minimizable(false)
                .skip_taskbar(true)
                .shadow(false)
                .build()?;

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

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

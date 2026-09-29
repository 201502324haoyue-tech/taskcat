use std::sync::Mutex;
use std::time::{Duration, Instant};

mod commands;
mod lark;
mod xiaoai;

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{TrayIcon, TrayIconBuilder, TrayIconEvent},
    Emitter, Listener, Manager, WindowEvent,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

/// 开机自启动：写入 HKCU Run 键（登录时启动，值名 + 引号包裹的 exe 路径）
const AUTOSTART_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const AUTOSTART_VALUE: &str = "TaskCat";

/// 查询开机自启动是否已开启
#[tauri::command]
fn get_autostart() -> bool {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(key) = hkcu.open_subkey(AUTOSTART_KEY) else {
        return false;
    };
    key.get_value::<String, _>(AUTOSTART_VALUE).is_ok()
}

/// 设置/取消开机自启动，返回新状态
#[tauri::command]
fn set_autostart(enabled: bool) -> Result<bool, String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu
        .create_subkey(AUTOSTART_KEY)
        .map_err(|e| e.to_string())?;
    if enabled {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        key.set_value(AUTOSTART_VALUE, &format!("\"{}\"", exe.display()))
            .map_err(|e| e.to_string())?;
    } else {
        let _ = key.delete_value(AUTOSTART_VALUE);
    }
    Ok(get_autostart())
}

/// Spec §3.1：默认右上角，离边缘 16px
const EDGE_MARGIN: i32 = 16;

/// 全局快捷键主/回退（Spec §8：占用时依次回退并通知一次）
fn shortcut_primary() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space)
}
fn shortcut_fallback() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyA)
}
fn shortcut_last_resort() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space)
}

fn shortcut_label(s: &Shortcut) -> String {
    format!("{:?}", s)
}

/// 保持托盘图标存活（drop 会导致托盘消失；字段未读属有意为之）
#[allow(dead_code)]
struct TrayHandle(TrayIcon);

/// 窗口状态写入节流（Spec §7：%APPDATA%/eisenhower-pet/window-state.json）
static LAST_STATE_SAVE: Mutex<Option<Instant>> = Mutex::new(None);

fn app_data_dir(app: &tauri::App) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn load_window_state(app: &tauri::App) -> Option<(f64, f64)> {
    let raw = std::fs::read_to_string(app_data_dir(app)?.join("window-state.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    Some((v.get("x")?.as_f64()?, v.get("y")?.as_f64()?))
}

fn save_window_state(window: &tauri::Window) {
    let now = Instant::now();
    {
        let mut last = LAST_STATE_SAVE.lock().unwrap();
        if let Some(prev) = *last {
            if now.duration_since(prev) < Duration::from_millis(300) {
                return;
            }
        }
        *last = Some(now);
    }
    let Ok(pos) = window.outer_position() else { return };
    // 物理像素存储（与 set_position 的物理坐标一致，避免 DPI 换算误差）
    let data = serde_json::json!({ "x": pos.x, "y": pos.y });
    if let Some(dir) = window
        .app_handle()
        .path()
        .app_data_dir()
        .ok()
        .and_then(|d| std::fs::create_dir_all(&d).ok().map(|_| d))
    {
        let _ = std::fs::write(dir.join("window-state.json"), data.to_string());
    }
}

/// 保存的位置是否仍落在某个显示器内（多屏拔掉回弹，Spec §8）。
/// 坐标一律为**物理像素**，且要求窗口**完整放得下**（含宽高），
/// 避免按旧尺寸保存的位置在窗口变大后探出屏幕。
fn is_on_any_monitor(app: &tauri::App, x: f64, y: f64, w: f64, h: f64) -> bool {
    let Ok(monitors) = app.available_monitors() else {
        return false; // 无法枚举显示器时不信任保存值，走右上角复位
    };
    for m in monitors {
        let wa = m.work_area();
        let (lx, ly, lw, lh) = (
            wa.position.x as f64,
            wa.position.y as f64,
            wa.size.width as f64,
            wa.size.height as f64,
        );
        if x >= lx - 8.0 && x + w <= lx + lw + 8.0 && y >= ly - 8.0 && y + h <= ly + lh + 8.0 {
            return true;
        }
    }
    false
}

/// 把窗口吸附到主显示器右上角（Spec §3.1：离边缘 16px，物理像素）
fn reposition_top_right(win: &tauri::WebviewWindow) {
    match (win.primary_monitor(), win.outer_size()) {
        (Ok(Some(mon)), Ok(size)) => {
            let wa = mon.work_area();
            let x = wa.position.x + wa.size.width as i32 - size.width as i32 - EDGE_MARGIN;
            let y = wa.position.y + EDGE_MARGIN;
            println!("[pos] top-right -> physical ({x}, {y}); work_area={wa:?}; outer_size={size:?}");
            let _ = win.set_position(tauri::PhysicalPosition::new(x as f64, y as f64));
        }
        (m, s) => println!("[pos] reposition skipped monitor_ok={} size_ok={}", m.is_ok(), s.is_ok()),
    }
}

fn position_to_top_right(app: &tauri::App) {
    let Some(win) = app.get_webview_window("main") else {
        println!("[pos] no main window");
        return;
    };
    let size = win.outer_size().unwrap_or_default();
    // 优先恢复记忆位置（仅当窗口完整落在某个显示器内）
    if let Some((x, y)) = load_window_state(app) {
        if is_on_any_monitor(app, x, y, size.width as f64, size.height as f64) {
            println!("[pos] restore saved ({x}, {y})");
            let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
            return;
        }
        println!("[pos] saved ({x}, {y}) 放不下 -> fallback");
    } else {
        println!("[pos] no saved state");
    }
    // 否则吸附主显示器右上角
    reposition_top_right(&win);
}

fn setup_shortcuts(app: &tauri::App) {
    let handle = app.handle().clone();

    let quick_add_handler = |app: &tauri::AppHandle, _s: &Shortcut, event: tauri_plugin_global_shortcut::ShortcutEvent| {
        if event.state() == ShortcutState::Pressed {
            let _ = app.emit("quick-add-open", ());
        }
    };

    // Spec §8：主键被占用 → 依次回退；全部失败则仅提示，不崩溃（面板 ＋ 按钮仍可用）
    // 注意：on_shortcut 内部即完成注册，勿再调用 register（会重复注册报错）
    let candidates = [shortcut_primary(), shortcut_fallback(), shortcut_last_resort()];
    let mut used: Option<Shortcut> = None;
    for sc in candidates {
        match handle.global_shortcut().on_shortcut(sc, quick_add_handler) {
            Ok(()) => {
                used = Some(sc);
                break;
            }
            Err(e) => {
                println!("[task-cat] 注册 {sc:?} 失败：{e}");
            }
        }
    }

    if let Some(sc) = used {
        println!("[task-cat] 快速录入快捷键：{sc:?}");
        if shortcut_label(&sc) != shortcut_label(&shortcut_primary()) {
            let _ = handle
                .notification()
                .builder()
                .title("快捷键回退")
                .body(format!("Ctrl+Shift+Space 已被占用，快速录入改为 {sc:?}"))
                .show();
        }
    } else {
        println!("[task-cat] 所有快速录入快捷键均被占用，可点击面板 ＋ 按钮录入");
    }

    // 截图识别：Alt+。（句点键）
    let shot = Shortcut::new(Some(Modifiers::ALT), Code::Period);
    match handle.global_shortcut().on_shortcut(shot, |app, _s, event| {
        if event.state() == ShortcutState::Pressed {
            let _ = app.emit("smart-shot", ());
        }
    }) {
        Ok(()) => println!("[task-cat] 已注册 Alt+。 截图识别快捷键"),
        Err(e) => println!("[task-cat] 注册 Alt+。 失败：{e}"),
    }
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let show_hide = MenuItemBuilder::with_id("show_hide", "显示/隐藏主窗口").build(app)?;
    let quick_add = MenuItemBuilder::with_id("quick_add", "快速录入").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&show_hide, &quick_add, &quit])
        .build()?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".into()))?;

    let tray = TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("任务喵")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show_hide" => {
                if let Some(win) = app.get_webview_window("main") {
                    if win.is_visible().unwrap_or(false) {
                        let _ = win.hide();
                    } else {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }
            }
            "quick_add" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                }
                let _ = app.emit("quick-add-open", ());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick { .. } = event {
                if let Some(win) = tray.app_handle().get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
        })
        .build(app)?;

    app.manage(TrayHandle(tray));
    Ok(())
}

/// 透明 WebView2 窗口以 visible:false 创建时，合成器可能不启动，
/// show() 后内容不合成到屏幕（实测：窗口存在但完全不可见，重绘一次即恢复）。
/// 启动时强制一次微小 resize 触发合成。
fn force_repaint(win: &tauri::WebviewWindow) {
    let Ok(size) = win.outer_size() else { return };
    let _ = win.set_size(tauri::PhysicalSize::new(size.width + 1, size.height));
    let _ = win.set_size(size);
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            get_autostart,
            set_autostart,
            commands::get_lan_ip,
            commands::capture_screen,
            commands::get_capture_b64,
            commands::llm_extract,
            commands::llm_reply,
            commands::feishu_fetch,
            commands::start_voice_server,
            commands::get_env_config,
            commands::get_env_path,
            commands::open_env_file,
            commands::load_app_config,
            commands::save_app_config,
            commands::read_user_md,
            commands::write_user_md,
            commands::llm_profile_analyze,
            lark::lark_status,
            lark::lark_auth_login,
            lark::lark_auth_poll,
            lark::lark_poll_messages,
            lark::lark_run,
            lark::lark_events_start,
            lark::lark_events_stop,
            lark::lark_config_init,
            lark::lark_config_output,
            lark::open_browser
        ])
        .setup(|app| {
            // 确保数据目录存在（Spec §7：%APPDATA%/com.eisenhower.pet/）
            let _ = app_data_dir(app);

            // 右上角定位 / 记忆恢复（窗口初始 visible:false，定位后再显示避免闪烁）
            position_to_top_right(app);
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                force_repaint(&win); // 修复透明窗口首帧不渲染
            }

            setup_shortcuts(app);
            setup_tray(app)?;

            // 启动小爱同学技能回调 HTTP 服务器（后台线程）
            xiaoai::start_server(app.handle().clone());

            // 前端「重置位置」→ 重新吸附右上角
            let handle = app.handle().clone();
            let _ = app.listen("reset-window-pos", move |_| {
                if let Some(win) = handle.get_webview_window("main") {
                    reposition_top_right(&win);
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Spec §8：关窗 = 隐藏到托盘，不退出
            WindowEvent::CloseRequested { api, .. } => {
                let _ = window.hide();
                api.prevent_close();
            }
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                // 截图流程中窗口被临时放大铺满屏幕，跳过状态保存，避免全屏坐标被记忆
                if window.label() == "main" && !commands::capture_suppress_save() {
                    save_window_state(window);
                }
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running task cat");
}

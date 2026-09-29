//! lark-cli（飞书官方 CLI）集成：事件订阅子进程管理 + 认证辅助。
//!
//! 事件订阅走 `lark-cli event consume <EventKey>` 子进程（官方为 AI 子进程调用设计）：
//! - stderr 先发 `[event] ready event_key=<key>` 就绪标记（父进程等它再读 stdout）
//! - stdout 逐行 NDJSON 事件流
//! - stdin EOF = 优雅退出（无界运行）；退出码 0=业务完成，非 0=失败
//! - 一个 consume 只订阅一个 EventKey，多 key = 多子进程（共享本地 bus daemon）
//! - 每个 key 一个管理线程负责 拉起→等就绪→转发事件→EOF 自动重连

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

const LARK_BIN_NAME: &str = "lark-cli.exe";
/// 事件流异常断开后的重连间隔
const LARK_RECONNECT_DELAY: Duration = Duration::from_secs(3);
/// 连续快速失败（未等到 ready 即退出）达到该次数后放弃，避免死循环
const LARK_MAX_ATTEMPTS: u32 = 3;

/// 单个事件订阅会话：stdin 句柄（stop 时关闭触发优雅退出）+ 停止标记
struct LarkSession {
    stdin: Mutex<Option<std::process::ChildStdin>>,
    stopped: AtomicBool,
}

/// key → 会话（start 时插入，stop 时清空；管理线程退出时自我清理）
static SESSIONS: Mutex<Option<HashMap<String, Arc<LarkSession>>>> = Mutex::new(None);

/// config init 后台进程的实时输出缓冲（含授权 URL，边读边写，前端随时可取）
static CONFIG_OUTPUT: Mutex<Option<Arc<Mutex<String>>>> = Mutex::new(None);
/// config init 是否已启动过（一次性向导，防止重复启动创建多个应用）
static CONFIG_STARTED: AtomicBool = AtomicBool::new(false);

/// 事件订阅规格（前端指定订阅哪个事件、用什么身份）
#[derive(serde::Deserialize)]
pub struct LarkEventSpec {
    pub key: String,
    #[serde(rename = "as")]
    pub as_identity: Option<String>,
}

/// 定位 lark-cli.exe：环境变量 LARK_CLI_BIN → 开发期 .tools/lark-cli → 打包资源目录 → PATH
fn lark_bin(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("LARK_CLI_BIN") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Ok(p);
        }
    }
    // 开发模式：CARGO_MANIFEST_DIR = src-tauri，二进制在项目根 .tools/lark-cli/
    let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or(Path::new("."))
        .join(".tools")
        .join("lark-cli")
        .join(LARK_BIN_NAME);
    if dev.is_file() {
        return Ok(dev);
    }
    // 打包模式：resources/lark-cli/lark-cli.exe
    if let Ok(dir) = app.path().resource_dir() {
        let res = dir.join("lark-cli").join(LARK_BIN_NAME);
        if res.is_file() {
            return Ok(res);
        }
    }
    // PATH 兜底
    if let Ok(paths) = std::env::var("PATH") {
        for dir in std::env::split_paths(&paths) {
            let cand = dir.join(LARK_BIN_NAME);
            if cand.is_file() {
                return Ok(cand);
            }
        }
    }
    Err(format!("未找到 {LARK_BIN_NAME}：请在项目 .tools/lark-cli/ 放置该二进制（npx @larksuite/cli@latest install）"))
}

/// 单次运行 lark-cli 并返回 stdout；失败时优先返回 stderr 的 JSON 错误信封原文
fn run_lark(app: &AppHandle, args: &[&str]) -> Result<String, String> {
    let bin = lark_bin(app)?;
    let out = Command::new(&bin)
        .args(args)
        .output()
        .map_err(|e| format!("执行 lark-cli 失败：{e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if !stderr.is_empty() { stderr } else { stdout });
    }
    Ok(stdout)
}

/// 后台启动应用创建向导（config init --new）：立即返回，输出（含授权 URL）由 lark_config_output 实时读取
#[tauri::command]
pub fn lark_config_init(app: AppHandle) -> Result<String, String> {
    if CONFIG_STARTED.swap(true, Ordering::SeqCst) {
        return Ok("already-running".into()); // 已在运行，勿重复启动
    }
    let sink = Arc::new(Mutex::new(String::new()));
    *CONFIG_OUTPUT.lock().unwrap() = Some(sink.clone());
    let bin = lark_bin(&app)?;
    let mut child = Command::new(&bin)
        .args(["config", "init", "--new", "--force-init", "--lang", "zh"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动配置向导失败：{e}"))?;
    let stdout = child.stdout.take().expect("stdout 已 piped");
    let stderr = child.stderr.take().expect("stderr 已 piped");

    // 两路输出实时写入共享缓冲（前端轮询 lark_config_output 即可拿到授权 URL，无需等进程退出）
    let out_sink = sink.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let line = line.unwrap_or_default();
            out_sink.lock().unwrap().push_str(&line);
            out_sink.lock().unwrap().push('\n');
        }
    });
    let err_sink = sink.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            let line = line.unwrap_or_default();
            err_sink.lock().unwrap().push_str(&line);
            err_sink.lock().unwrap().push('\n');
        }
    });
    thread::spawn(move || {
        let _ = child.wait();
        let _ = app.emit("lark:config-done", ());
    });
    Ok("started".into())
}

/// 读取 config init 后台进程实时输出（授权 URL 在其中），未启动过返回空串
#[tauri::command]
pub fn lark_config_output() -> Result<String, String> {
    let guard = CONFIG_OUTPUT.lock().unwrap();
    Ok(guard.as_ref().map(|s| s.lock().unwrap().clone()).unwrap_or_default())
}

/// 用系统默认浏览器打开 URL（授权页：飞书开放平台官方域名，来源受控）
#[tauri::command]
pub fn open_browser(url: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &url])
            .spawn()
            .map_err(|e| format!("打开浏览器失败：{e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("xdg-open").arg(&url).spawn();
    }
    Ok(())
}

/// 查询认证状态（config init / auth login 是否完成、当前身份与已授权 scope）
#[tauri::command]
pub fn lark_status(app: AppHandle) -> Result<String, String> {
    run_lark(&app, &["auth", "status", "--json"])
}

/// 发起设备码登录（--no-wait 立即返回 URL/二维码，浏览器授权后由 lark_auth_poll 收尾）
#[tauri::command]
pub fn lark_auth_login(app: AppHandle) -> Result<String, String> {
    run_lark(
        &app,
        &[
            "auth",
            "login",
            "--domain",
            "im,minutes,event",
            "--scope",
            "minutes:minutes.basic:read",
            "--recommend",
            "--no-wait",
            "--json",
        ],
    )
}

/// 轮询登录授权完成状态（直接检查 auth status 替代 device_code 阻塞，避免多进程竞争/过期死锁）
#[tauri::command]
pub fn lark_auth_poll(app: AppHandle) -> Result<String, String> {
    run_lark(&app, &["auth", "status", "--json"])
}

/// 拉取用户所有「人-人」单聊会话的最新消息（轮询检测任何人发来的消息）
/// 飞书不提供用户收消息的事件推送（隐私限制），只能主动拉取：
/// 1. im +chat-list --types=p2p（全部单聊，跳过 bot 会话）
/// 2. 每会话 im +chat-messages-list 最新一页（desc）
#[tauri::command]
pub fn lark_poll_messages(app: AppHandle) -> Result<String, String> {
    let chat_raw = run_lark(&app, &["im", "+chat-list", "--types", "p2p", "--as", "user", "--json"])?;
    let v: serde_json::Value =
        serde_json::from_str(&chat_raw).map_err(|e| format!("解析会话列表失败：{e}"))?;
    let chats = v["data"]["chats"].as_array().cloned().unwrap_or_default();
    let mut out: Vec<serde_json::Value> = Vec::new();
    for chat in chats {
        // 只拉人与人的单聊（跳过 bot/系统会话，人发来的消息才可能变任务）
        if chat["p2p_target_type"].as_str() != Some("user") {
            continue;
        }
        let id = chat["chat_id"].as_str().unwrap_or("");
        if id.is_empty() {
            continue;
        }
        if let Ok(raw) = run_lark(
            &app,
            &[
                "im", "+chat-messages-list", "--chat-id", id, "--order", "desc", "--page-size",
                "10", "--as", "user", "--json",
            ],
        ) {
            if let Ok(mv) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(msgs) = mv["data"]["messages"].as_array() {
                    for m in msgs {
                        out.push(serde_json::json!({
                            "chat_id": id,
                            "message_id": m["message_id"].as_str().unwrap_or(""),
                            "create_time": m["create_time"].as_str().unwrap_or(""),
                            "content": m["content"].as_str().unwrap_or(""),
                            "msg_type": m["msg_type"].as_str().unwrap_or(""),
                            "sender_name": m["sender"]["name"].as_str().unwrap_or(""),
                            "sender_type": m["sender"]["sender_type"].as_str().unwrap_or(""),
                            "sender_id": m["sender"]["id"].as_str().unwrap_or(""),
                        }));
                    }
                }
            }
        }
    }
    serde_json::to_string(&out).map_err(|e| format!("序列化消息失败：{e}"))
}

/// 通用单次命令（如 `minutes +detail` 读取妙记内容），args 为完整参数列表
#[tauri::command]
pub fn lark_run(app: AppHandle, args: Vec<String>) -> Result<String, String> {
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run_lark(&app, &refs)
}

/// 启动事件订阅：每个 key 一个 consume 子进程 + 管理线程（就绪标记 → 事件转发 → 自动重连）
#[tauri::command]
pub fn lark_events_start(app: AppHandle, sessions: Vec<LarkEventSpec>) -> Result<(), String> {
    let bin = lark_bin(&app)?;
    let mut binding = SESSIONS.lock().unwrap();
    let map = binding.get_or_insert_with(HashMap::new);
    for spec in sessions {
        if map.contains_key(&spec.key) {
            continue; // 已在监听
        }
        let session = Arc::new(LarkSession {
            stdin: Mutex::new(None),
            stopped: AtomicBool::new(false),
        });
        map.insert(spec.key.clone(), session.clone());

        let app_mgr = app.clone();
        let bin_mgr = bin.clone();
        let key = spec.key.clone();
        thread::spawn(move || {
            let mut attempts: u32 = 0;
            while !session.stopped.load(Ordering::SeqCst) {
                attempts += 1;
                let mut cmd = Command::new(&bin_mgr);
                cmd.arg("event").arg("consume").arg(&key);
                if let Some(ident) = &spec.as_identity {
                    cmd.arg("--as").arg(ident);
                }
                let mut child = match cmd
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn()
                {
                    Ok(c) => c,
                    Err(e) => {
                        let _ = app_mgr.emit(
                            "lark:status",
                            serde_json::json!({ "key": key, "phase": "error", "message": format!("启动失败：{e}") }),
                        );
                        break;
                    }
                };
                if let Some(stdin) = child.stdin.take() {
                    *session.stdin.lock().unwrap() = Some(stdin);
                }
                let stdout = child.stdout.take().expect("stdout 已 piped");
                let stderr = child.stderr.take().expect("stderr 已 piped");

                // 阶段 1：等 stderr 就绪标记（官方子进程契约，禁止 sleep 替代）
                let mut ready = false;
                let mut stderr_text = String::new();
                let reader = BufReader::new(stderr);
                for line in reader.lines() {
                    let line = line.unwrap_or_default();
                    if line.contains("[event] ready event_key=") {
                        ready = true;
                        break;
                    }
                    if !line.trim().is_empty() {
                        stderr_text.push_str(&line);
                        stderr_text.push('\n');
                        println!("[lark:{key}] {line}");
                    }
                }
                if !ready {
                    // 快速失败（认证缺失 / key 非法 / 订阅冲突），提取错误信封透传前端
                    let _ = child.wait();
                    let mut detail = "未等到就绪标记（请检查认证与事件权限）".to_string();
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&stderr_text) {
                        let msg = v
                            .get("error")
                            .and_then(|e| e.get("message"))
                            .and_then(|m| m.as_str())
                            .or_else(|| v.get("message").and_then(|m| m.as_str()));
                        if let Some(m) = msg {
                            detail = m.to_string();
                        }
                    }
                    let _ = app_mgr.emit(
                        "lark:status",
                        serde_json::json!({ "key": key, "phase": "error", "message": detail }),
                    );
                    if session.stopped.load(Ordering::SeqCst) || attempts >= LARK_MAX_ATTEMPTS {
                        break;
                    }
                    thread::sleep(LARK_RECONNECT_DELAY);
                    continue;
                }
                let _ = app_mgr.emit(
                    "lark:status",
                    serde_json::json!({ "key": key, "phase": "ready" }),
                );

                // 阶段 2：stdout NDJSON 事件流 → 转发前端
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    if session.stopped.load(Ordering::SeqCst) {
                        break;
                    }
                    let line = match line {
                        Ok(l) => l,
                        Err(_) => break,
                    };
                    let t = line.trim();
                    if t.is_empty() {
                        continue;
                    }
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(t) {
                        let _ = app_mgr.emit("lark:event", serde_json::json!({ "key": key, "event": v }));
                    }
                }
                let _ = child.wait(); // 回收子进程
                if session.stopped.load(Ordering::SeqCst) {
                    break;
                }
                let _ = app_mgr.emit(
                    "lark:status",
                    serde_json::json!({ "key": key, "phase": "reconnecting" }),
                );
                thread::sleep(LARK_RECONNECT_DELAY);
            }
            // 自我清理：从 SESSIONS 移除本 key
            if let Ok(mut map) = SESSIONS.lock() {
                if let Some(m) = map.as_mut() {
                    m.remove(&key);
                }
            }
        });
    }
    Ok(())
}

/// 停止全部事件订阅：置停止标记 + 关闭 stdin（EOF → 优雅退出，避免 kill 泄漏服务端订阅）
#[tauri::command]
pub fn lark_events_stop() -> Result<(), String> {
    let mut guard = SESSIONS.lock().unwrap();
    if let Some(map) = guard.as_mut() {
        for s in map.values() {
            s.stopped.store(true, Ordering::SeqCst);
            if let Some(mut stdin) = s.stdin.lock().unwrap().take() {
                let _ = stdin.flush();
                drop(stdin); // EOF
            }
        }
        map.clear();
    }
    Ok(())
}

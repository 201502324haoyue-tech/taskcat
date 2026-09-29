//! 智能录入后端命令：截屏、LLM 提取、飞书拉取、手机语音本地服务器。

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager};

const VOICE_PORT: u16 = 8787;

/// .env 大模型配置模板
const ENV_TEMPLATE: &str = r#"# 任务喵 大模型环境变量（可选）
# 说明：应用设置里手动填写过的字段优先；字段留空时使用这里的环境变量。
# 修改后保存，回到应用设置点「重新加载 .env」即可生效。
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=
LLM_MODEL=deepseek-chat
"#;

fn env_file_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(".env"))
}

fn parse_env(content: &str) -> serde_json::Value {
    let mut out = serde_json::Map::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            let v = v.trim().trim_matches('"').trim_matches('\'').to_string();
            match k.trim() {
                "LLM_BASE_URL" => {
                    out.insert("llmBaseUrl".into(), serde_json::json!(v));
                }
                "LLM_API_KEY" => {
                    out.insert("llmApiKey".into(), serde_json::json!(v));
                }
                "LLM_MODEL" => {
                    out.insert("llmModel".into(), serde_json::json!(v));
                }
                _ => {}
            }
        }
    }
    serde_json::Value::Object(out)
}

/// 读取 .env 中的大模型配置（文件不存在返回空对象）
#[tauri::command]
pub fn get_env_config(app: AppHandle) -> Result<serde_json::Value, String> {
    let path = env_file_path(&app)?;
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(parse_env(&content))
}

/// 返回 .env 文件路径（不创建、不打开）
#[tauri::command]
pub fn get_env_path(app: AppHandle) -> Result<String, String> {
    Ok(env_file_path(&app)?.to_string_lossy().to_string())
}

/// 生成 .env 模板（不存在时）并打开编辑，返回文件路径
#[tauri::command]
pub fn open_env_file(app: AppHandle) -> Result<String, String> {
    let path = env_file_path(&app)?;
    if !path.exists() {
        std::fs::write(&path, ENV_TEMPLATE).map_err(|e| e.to_string())?;
    }
    let path_str = path.to_string_lossy().to_string();
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("cmd")
            .args(["/c", "start", "", &path_str])
            .spawn();
    }
    Ok(path_str)
}
static VOICE_STARTED: AtomicBool = AtomicBool::new(false);
static LAN_IP: OnceLock<String> = OnceLock::new();
static VOICE_TOKEN: OnceLock<String> = OnceLock::new();

/// 一次性访问令牌：启动时生成（时间 + 进程号哈希），拼进语音页 URL，
/// 防止同网段任意设备向电脑注入任务
fn voice_token() -> &'static str {
    VOICE_TOKEN.get_or_init(|| {
        let mut h = DefaultHasher::new();
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
            .hash(&mut h);
        std::process::id().hash(&mut h);
        format!("{:016x}", h.finish())
    })
}

fn lan_ip() -> String {
    LAN_IP
        .get_or_init(|| {
            if let Ok(sock) = UdpSocket::bind("0.0.0.0:0") {
                if sock.connect("8.8.8.8:80").is_ok() {
                    if let Ok(addr) = sock.local_addr() {
                        return addr.ip().to_string();
                    }
                }
            }
            "127.0.0.1".into()
        })
        .clone()
}

/// 局域网 IP（手机访问语音页用）
#[tauri::command]
pub fn get_lan_ip() -> Result<String, String> {
    Ok(lan_ip())
}

/// 应用持久化配置（LLM 覆盖项 + 飞书凭证），存在 appdata/config.json —— 密钥不落 WebView localStorage
#[derive(serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub llm_overrides: Option<serde_json::Value>,
    pub feishu: Option<serde_json::Value>,
}

fn app_config_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("config.json"))
}

/// 读取应用配置（文件不存在返回默认值）
#[tauri::command]
pub fn load_app_config(app: AppHandle) -> Result<AppConfig, String> {
    let path = app_config_path(&app)?;
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

/// 保存应用配置（LLM Key / 飞书 Secret 只进 config.json，不再明文落 localStorage）
#[tauri::command]
pub fn save_app_config(app: AppHandle, config: AppConfig) -> Result<(), String> {
    let path = app_config_path(&app)?;
    let content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

fn user_md_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("user.md"))
}

/// 读取用户画像（文件不存在返回空串）
#[tauri::command]
pub fn read_user_md(app: AppHandle) -> Result<String, String> {
    let path = user_md_path(&app)?;
    if !path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// 保存用户画像
#[tauri::command]
pub fn write_user_md(app: AppHandle, content: String) -> Result<(), String> {
    let path = user_md_path(&app)?;
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// 截屏流程中：窗口会被临时放大铺满目标屏幕，期间禁止保存窗口位置（避免全屏坐标被记忆）
static CAPTURE_SUPPRESS_SAVE: AtomicBool = AtomicBool::new(false);

/// lib.rs 窗口事件回调查询：截图流程中跳过 window-state 保存
pub fn capture_suppress_save() -> bool {
    CAPTURE_SUPPRESS_SAVE.load(Ordering::SeqCst)
}

/// 截屏前临时隐藏主窗口，避免把应用自身截进画面；截完恢复显示
fn hide_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
    // 等待合成器完成隐藏，避免截到残影
    std::thread::sleep(Duration::from_millis(150));
}

fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// 显示器边界（物理像素）：实测 Windows 下 tauri Monitor.position/size 返回物理值，勿乘 scale_factor
fn monitor_bounds(m: &tauri::Monitor) -> (f64, f64, f64, f64) {
    let pos = m.position();
    let size = m.size();
    (
        pos.x as f64,
        pos.y as f64,
        size.width as f64,
        size.height as f64,
    )
}

/// 后台线程编码完成的截图（JPEG base64）：get_capture_b64 通过条件变量等待就绪，
/// 使 capture_screen 可以截完立即放大窗口秒回，编码耗时不再阻塞「进入截图模式」
static CAPTURE_B64: Mutex<Option<Result<String, String>>> = Mutex::new(None);
static CAPTURE_READY: Condvar = Condvar::new();

/// 截图结果：目标屏幕的物理坐标/尺寸（前端据此把窗口铺满该屏幕，所见即所得）
/// 画面 base64 编码在后台线程进行，通过 get_capture_b64 获取
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureMeta {
    pub screen_x: f64,
    pub screen_y: f64,
    pub screen_w: f64,
    pub screen_h: f64,
}

/// 截取「鼠标所在屏幕」的完整画面（回退主屏），并把窗口放大铺满该屏幕后立即返回（不含画面）。
/// 画面在后台线程编码为 JPEG，等待 get_capture_b64 时按需获取。
#[tauri::command]
pub fn capture_screen(app: AppHandle) -> Result<CaptureMeta, String> {
    // 鼠标落在哪个显示器就截哪个（Alt+。与按钮触发时，鼠标都在用户当前关注的屏幕）
    let cursor = app.cursor_position().ok();
    let monitor = app
        .available_monitors()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|m| {
            cursor.is_some_and(|p| {
                let (x, y, w, h) = monitor_bounds(m);
                p.x >= x - 1.0 && p.x < x + w + 1.0 && p.y >= y - 1.0 && p.y < y + h + 1.0
            })
        })
        .or_else(|| app.primary_monitor().ok().flatten())
        .ok_or("未找到显示器")?;

    // 每次截屏前清空旧缓存，避免取到上一次的画面
    *CAPTURE_B64.lock().unwrap() = None;

    CAPTURE_SUPPRESS_SAVE.store(true, Ordering::SeqCst);
    hide_main_window(&app);
    let captured = (|| -> Result<image::RgbaImage, String> {
        let (px, py, pw, ph) = monitor_bounds(&monitor);
        let screens = screenshots::Screen::all().map_err(|e| e.to_string())?;
        let found = screens.iter().find(|s| {
            let d = s.display_info;
            (d.x as f64 - px).abs() <= 1.0
                && (d.y as f64 - py).abs() <= 1.0
                && (d.width as f64 - pw).abs() <= 1.0
                && (d.height as f64 - ph).abs() <= 1.0
        });
        if found.is_none() {
            return Err(format!(
                "未找到匹配的显示器（目标 {px:.0}x{py:.0} {pw:.0}x{ph:.0}）"
            ));
        }
        let screen = found.expect("上方已检查 found 非空");
        screen.capture().map_err(|e| e.to_string()) // image::RgbaImage
    })();
    match captured {
        Ok(img) => {
            // 后台线程编码 JPEG + base64（debug 编译下约 1s），不阻塞窗口铺满与显示
            thread::spawn(move || {
                let encoded = (|| -> Result<String, String> {
                    let mut buf = std::io::Cursor::new(Vec::new());
                    let mut jpeg =
                        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 88);
                    jpeg.encode_image(&image::DynamicImage::ImageRgba8(img))
                        .map_err(|e| e.to_string())?;
                    drop(jpeg);
                    use base64::Engine;
                    Ok(base64::engine::general_purpose::STANDARD.encode(buf.into_inner()))
                })();
                let mut g = CAPTURE_B64.lock().unwrap();
                *g = Some(encoded);
                drop(g);
                CAPTURE_READY.notify_all();
            });
            // 先铺到目标屏幕再显示，避免从小窗放大闪烁
            if let Some(win) = app.get_webview_window("main") {
                let pos = monitor.position();
                let size = monitor.size();
                let _ = win.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
                    pos.x as i32,
                    pos.y as i32,
                )));
                let _ = win.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(
                    size.width,
                    size.height,
                )));
            }
        }
        Err(msg) => {
            // 截屏失败：立即写入错误结果，get_capture_b64 不用干等
            let mut g = CAPTURE_B64.lock().unwrap();
            *g = Some(Err(msg));
            drop(g);
            CAPTURE_READY.notify_all();
        }
    }
    show_main_window(&app);
    CAPTURE_SUPPRESS_SAVE.store(false, Ordering::SeqCst);

    let pos = monitor.position();
    let size = monitor.size();
    Ok(CaptureMeta {
        screen_x: pos.x as f64,
        screen_y: pos.y as f64,
        screen_w: size.width as f64,
        screen_h: size.height as f64,
    })
}

/// 获取后台线程编码完成的截图 base64（JPEG），最多等待 10 秒
#[tauri::command]
pub fn get_capture_b64() -> Result<String, String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let mut g = CAPTURE_B64.lock().unwrap();
    loop {
        if let Some(res) = g.take() {
            return res;
        }
        let now = std::time::Instant::now();
        if now >= deadline {
            return Err("截屏编码超时".into());
        }
        g = CAPTURE_READY.wait_timeout(g, deadline - now).unwrap().0;
    }
}

const LLM_PROMPT_MULTI: &str = r#"你是任务提取助手。从用户提供的内容（可能是截图或文本）中提取与工作/学习/生活相关的待办任务。
要求：
1. 忽略任何任务管理软件面板本身的内容（如"紧急·重要"等界面元素）。
2. 每条任务给出：title（简洁的任务标题）、quadrant（四象限：q1=紧急且重要，q2=重要不紧急，q3=紧急不重要，q4=都不）、dueAt（明确截止时间用 ISO8601 字符串，没有则空字符串）。
3. 无法确定象限时填 q2。会议纪要中提到的行动项、责任人事项都要提取；内容很长时合并同类项，最多输出 12 条最重要的。
4. 只输出 JSON，不要任何解释，格式：{"tasks":[{"title":"...","quadrant":"q1","dueAt":""}]}"#;

const LLM_PROMPT_SINGLE: &str = r#"你是任务提取助手。从用户提供的内容（可能是截图或文本）中提取一个最主要的待办任务。
要求：
1. 忽略任何任务管理软件面板本身的内容（如"紧急·重要"等界面元素）。
2. 只提取一个最核心的任务，给出：title（简洁的任务标题）、quadrant（四象限：q1=紧急且重要，q2=重要不紧急，q3=紧急不重要，q4=都不）、dueAt（明确截止时间用 ISO8601 字符串，没有则空字符串）。
3. 无法确定象限时填 q2。如有多个事项，只输出最主要的一条。
4. 只输出 JSON，不要任何解释，格式：{"tasks":[{"title":"...","quadrant":"q1","dueAt":""}]}"#;

/// 问卷回答 → 初始用户画像生成
const LLM_PROFILE_GEN_PROMPT: &str = r#"你是用户画像分析助手。根据用户对问卷的回答，生成一份 Markdown 格式的用户画像，用于让 AI 在任务分类时理解用户的真实偏好。
结构：
# 用户画像
## 基本信息
- 角色：...
- 核心工作领域：...
## 任务分类偏好
（结合用户回答，总结哪些类型的事务通常属于哪个象限：q1=紧急且重要，q2=重要不紧急，q3=紧急不重要，q4=都不。给出可执行的归类建议，如"客户跟进类 → q1"）
## 使用建议
（给 AI 的提示：识别任务时如何根据画像判断象限与截止）
只输出画像 Markdown，不要任何解释。"#;

/// 拖拽调整 → 画像增量更新
const LLM_PROFILE_ANALYZE_PROMPT: &str = r#"你是用户画像优化助手。用户最近把一些任务在不同象限间拖拽调整（四象限：q1=紧急且重要，q2=重要不紧急，q3=紧急不重要，q4=都不），这反映了用户的真实分类偏好。
请分析最近的拖拽调整记录，结合当前画像，输出更新后的完整画像 Markdown（保持原有结构，必要时调整"任务分类偏好"与"使用建议"章节）。
如果这些调整没有提供新信息、不需要修改画像，只输出：NO_CHANGE
只输出画像 Markdown 或 NO_CHANGE，不要任何解释。"#;

/// 判断接口格式：URL 含 anthropic 或以 /messages 结尾 → Anthropic（Claude），否则 OpenAI 兼容
fn is_anthropic(api_base: &str) -> bool {
    let lower = api_base.to_lowercase();
    lower.contains("anthropic") || api_base.trim_end_matches('/').ends_with("/messages")
}

/// 构造完整请求地址（保持用户填写的 URL 兼容三种写法：裸域名 /v1 /v1/messages）
fn build_url(api_base: &str, anthropic: bool) -> String {
    let base = api_base.trim_end_matches('/');
    if anthropic {
        if base.ends_with("/messages") {
            base.to_string()
        } else if base.ends_with("/v1") {
            format!("{}/messages", base)
        } else {
            format!("{}/v1/messages", base)
        }
    } else if base.ends_with("/chat/completions") {
        base.to_string()
    } else {
        format!("{}/chat/completions", base)
    }
}

/// 统一调用大模型（OpenAI 兼容 / Anthropic 自动识别），返回 LLM 的原始文本。
/// prompt 为系统指令；text 为待分析内容（图片模式下忽略）；json_mode 控制是否要求 JSON 输出。
fn send_llm(
    api_base: &str,
    api_key: &str,
    model: &str,
    prompt: &str,
    text: Option<&str>,
    image_b64: Option<&str>,
    json_mode: bool,
) -> Result<String, String> {
    let anthropic = is_anthropic(api_base);
    let url = build_url(api_base, anthropic);
    let full_text = match (prompt, text) {
        (p, Some(t)) if !p.is_empty() => format!("{}\n\n{}", p, t),
        (_, Some(t)) => t.to_string(),
        (p, None) if !p.is_empty() => p.to_string(),
        _ => String::new(),
    };

    let resp_json: serde_json::Value = if anthropic {
        // ---------- Anthropic Messages API ----------
        let mut content: Vec<serde_json::Value> = Vec::new();
        if !full_text.is_empty() {
            content.push(serde_json::json!({ "type": "text", "text": full_text }));
        }
        if let Some(img) = image_b64 {
            content.push(serde_json::json!({
                "type": "image",
                "source": { "type": "base64", "media_type": "image/jpeg", "data": img }
            }));
        }
        let body = serde_json::json!({
            "model": model,
            "max_tokens": 4096,
            "messages": [{ "role": "user", "content": content }]
        });
        let mut req = ureq::post(&url)
            .timeout(Duration::from_secs(90))
            .set("Content-Type", "application/json")
            .set("anthropic-version", "2023-06-01");
        if !api_key.trim().is_empty() {
            req = req.set("x-api-key", api_key.trim());
        }
        let resp = req.send_json(body).map_err(|e| e.to_string())?;
        resp.into_json().map_err(|e| e.to_string())?
    } else {
        // ---------- OpenAI 兼容 Chat Completions ----------
        let content = if let Some(img) = image_b64 {
            serde_json::json!([
                { "type": "text", "text": full_text },
                { "type": "image_url", "image_url": { "url": format!("data:image/jpeg;base64,{}", img) } }
            ])
        } else {
            serde_json::json!(full_text)
        };
        let mut body = serde_json::json!({
            "model": model,
            "messages": [{ "role": "user", "content": content }],
            "temperature": 0.2,
            // 长文本（如会议转写）提炼任务多，不设会被部分服务默认值截断导致 JSON 断裂
            "max_tokens": 4096,
        });
        if json_mode {
            body["response_format"] = serde_json::json!({ "type": "json_object" });
        }
        // MiniMax-M3 默认 adaptive thinking 会把思考内容混入输出（<think> 块），
        // 影响 JSON 解析且浪费 token，仅 MiniMax 认识该参数，按 base_url 判断加白
        if api_base.to_lowercase().contains("minimax") {
            body["thinking"] = serde_json::json!({ "type": "disabled" });
        }
        let mk_req = |key: &str| -> ureq::Request {
            let mut r = ureq::post(&url)
                .timeout(Duration::from_secs(90))
                .set("Content-Type", "application/json");
            if !key.trim().is_empty() {
                r = r.set("Authorization", &format!("Bearer {}", key.trim()));
            }
            r
        };
        // 部分服务不支持 response_format / max_tokens（如 Ollama/部分代理）→ 400 时去掉重试
        let resp = match mk_req(api_key).send_json(body.clone()) {
            Ok(r) => r,
            Err(ureq::Error::Status(400, _)) => {
                if let Some(obj) = body.as_object_mut() {
                    obj.remove("response_format");
                    obj.remove("max_tokens");
                }
                mk_req(api_key).send_json(body).map_err(|e| e.to_string())?
            }
            Err(e) => return Err(e.to_string()),
        };
        resp.into_json().map_err(|e| e.to_string())?
    };

    // 统一取文本：OpenAI 在 choices[0].message.content；Anthropic 在 content[].text
    if let Some(s) = resp_json["choices"][0]["message"]["content"].as_str() {
        return Ok(s.to_string());
    }
    if let Some(arr) = resp_json["content"].as_array() {
        for item in arr {
            if item["type"] == "text" {
                if let Some(s) = item["text"].as_str() {
                    return Ok(s.to_string());
                }
            }
        }
    }
    Err("LLM 响应中没有内容字段".to_string())
}

/// 调用大模型从文本或截图提取任务，返回 LLM 的原始 JSON 文本。
/// 自动识别接口格式：Anthropic（Claude）/ OpenAI 兼容（DeepSeek、通义、OpenAI、Ollama 等）。
/// user_profile 为用户画像 Markdown（非空时注入 prompt，让分类贴合用户习惯）。
/// 注意：async 命令（内部 ureq 阻塞网络请求），避免卡住主线程导致 WebView 无响应。
#[tauri::command]
pub async fn llm_extract(
    api_base: String,
    api_key: String,
    model: String,
    extract_mode: String,
    user_profile: Option<String>,
    text: Option<String>,
    image_b64: Option<String>,
) -> Result<String, String> {
    let prompt = match extract_mode.as_str() {
        "single" => LLM_PROMPT_SINGLE,
        _ => LLM_PROMPT_MULTI,
    };
    let prompt = match &user_profile {
        Some(p) if !p.trim().is_empty() => format!("{}\n\n用户画像（请据此理解用户偏好并分类）：\n{}", prompt, p),
        _ => prompt.to_string(),
    };
    let user_text = match (&text, &image_b64) {
        (_, Some(_img)) => None,
        (Some(t), None) => Some(format!("待提取内容：\n{}", t)),
        _ => return Err("没有提供文本或截图".into()),
    };
    send_llm(
        &api_base,
        &api_key,
        &model,
        &prompt,
        user_text.as_deref(),
        image_b64.as_deref(),
        true,
    )
}

/// 自动回复 @机器人 消息的系统提示词：机器人身份 + 真实能力边界 + 回复风格约束
const LLM_REPLY_PROMPT: &str = r#"你是任务喵接入公司飞书的任务问答助手。
现在有人在飞书里 @你 发来了一条消息，请以你的身份直接回复对方。
你的真实能力：1) 会议妙计转写自动提炼成待办任务；2) 语音/截图/文字快速记任务，按四象限（重要/紧急）整理；3) 任务到期自动提醒；4) 网页/看板发布成组织内轻页分享链接；5) 读取群内 @你 的消息并响应。
要求：
- 用简洁友好的中文回复，一般不超过 100 字；可用少量 emoji。
- 只声称上述真实能力，不编造其他功能。
- 涉及隐私敏感、需要权限操作或无法处理的事项，礼貌说明并建议联系机器人管理员。
- 只输出回复正文，不要任何解释、前缀或思考过程。"#;

/// 为飞书 @机器人 的消息生成自动回复文本（复用 send_llm，纯文本输出）。
/// 注意：async 命令（内部 ureq 阻塞网络请求），避免卡住主线程导致 WebView 无响应。
#[tauri::command]
pub async fn llm_reply(
    api_base: String,
    api_key: String,
    model: String,
    sender_name: Option<String>,
    text: String,
) -> Result<String, String> {
    let who = sender_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("一位同事");
    let payload = format!("提问者：{}\n消息：{}", who, text);
    send_llm(
        &api_base,
        &api_key,
        &model,
        LLM_REPLY_PROMPT,
        Some(&payload),
        None,
        false,
    )
}

/// 用户画像参数（kind=generate 问卷生成 / analyze 拖拽学习更新）
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileAnalyzeArgs {
    pub kind: String,
    pub answers: Option<String>,
    pub current_md: Option<String>,
    pub drag_events: Option<String>,
}

/// 用户画像生成/学习：问卷回答 → 初始画像；拖拽调整记录 → 画像增量更新。
/// 返回更新后的画像 Markdown；无需修改时返回 "NO_CHANGE"。
/// 注意：async 命令（内部 ureq 阻塞网络请求），避免卡住主线程导致 WebView 无响应。
#[tauri::command]
pub async fn llm_profile_analyze(
    api_base: String,
    api_key: String,
    model: String,
    args: ProfileAnalyzeArgs,
) -> Result<String, String> {
    let (prompt, payload) = match args.kind.as_str() {
        "generate" => {
            let answers = args.answers.unwrap_or_default();
            (
                LLM_PROFILE_GEN_PROMPT,
                format!("用户的问卷回答：\n{}", answers),
            )
        }
        _ => {
            let cur = args.current_md.unwrap_or_default();
            let ev = args.drag_events.unwrap_or_default();
            (
                LLM_PROFILE_ANALYZE_PROMPT,
                format!("当前画像：\n{}\n\n最近拖拽调整记录：\n{}", cur, ev),
            )
        }
    };
    send_llm(&api_base, &api_key, &model, prompt, Some(&payload), None, false)
}

/// 拉取飞书指定群聊的最近文本消息，返回 {"texts": [...]}
/// 注意：async 命令（内部 ureq 阻塞网络请求），避免卡住主线程导致 WebView 无响应。
#[tauri::command]
pub async fn feishu_fetch(app_id: String, app_secret: String, chat_id: String) -> Result<String, String> {
    // 1. 租户访问令牌
    let token_resp = ureq::post("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal")
        .timeout(Duration::from_secs(30))
        .send_json(serde_json::json!({ "app_id": app_id, "app_secret": app_secret }))
        .map_err(|e| format!("获取飞书 token 失败：{e}"))?;
    let token_json: serde_json::Value = token_resp.into_json().map_err(|e| e.to_string())?;
    let access = token_json["tenant_access_token"]
        .as_str()
        .ok_or_else(|| format!("飞书认证失败：{}", token_json["code"]))?;

    // 2. 拉取群消息
    let url = format!(
        "https://open.feishu.cn/open-apis/im/v1/messages?container_id_type=chat&container_id={}&page_size=30&sort_type=ByCreateTimeDesc",
        chat_id
    );
    let resp = ureq::get(&url)
        .timeout(Duration::from_secs(30))
        .set("Authorization", &format!("Bearer {}", access))
        .call()
        .map_err(|e| format!("拉取飞书消息失败：{e}"))?;
    let json: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
    if json["code"].as_i64() != Some(0) {
        return Err(format!("飞书接口返回错误：{} {}", json["code"], json["msg"]));
    }

    let mut texts: Vec<String> = Vec::new();
    if let Some(items) = json["data"]["items"].as_array() {
        for it in items {
            // 只取文本消息（body.content 是 JSON 字符串，形如 {"text":"..."}）
            if let Some(body) = it["body"]["content"].as_str() {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
                    if let Some(t) = v["text"].as_str() {
                        let t = t.trim();
                        if !t.is_empty() {
                            texts.push(t.to_string());
                        }
                    }
                }
            }
        }
    }
    if texts.is_empty() {
        return Err("没有找到可识别的文本消息（可能权限不足或群内无消息）".into());
    }
    Ok(serde_json::json!({ "texts": texts }).to_string())
}

const VOICE_PAGE: &str = r#"<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>语音录入 → 任务喵</title><style>
body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:24px;display:flex;flex-direction:column;min-height:100vh}
h1{font-size:18px;margin:0 0 8px}.hint{font-size:12px;color:#94a3b8;margin-bottom:16px}
textarea{flex:1;min-height:120px;background:#1e293b;border:1px solid #334155;border-radius:12px;color:#e2e8f0;padding:12px;font-size:15px;outline:none}
.btns{display:flex;gap:10px;margin-top:12px}
button{flex:1;padding:14px 0;border-radius:12px;border:none;font-size:15px;font-weight:600;cursor:pointer}
#rec{background:#f43f5e;color:#fff}.recording{animation:pulse 1s infinite}
#send{background:#38bdf8;color:#0f172a}
#status{font-size:12px;color:#94a3b8;margin-top:12px;min-height:16px}
@keyframes pulse{50%{opacity:.6}}
</style></head>
<body>
<h1>🎤 语音录入任务</h1>
<div class="hint">说一句话 → 自动转文字 → 点「发送到电脑」，任务会出现在桌面的录入框中</div>
<textarea id="txt" placeholder="或者直接在这里打字…"></textarea>
<div class="btns">
<button id="rec">🎤 按住说话</button>
<button id="send">📤 发送到电脑</button>
</div>
<div id="status"></div>
<script>
const tok=new URLSearchParams(location.search).get('t')||'';
const txt=document.getElementById('txt'),status=document.getElementById('status'),rec=document.getElementById('rec'),send=document.getElementById('send');
const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
let r=null,listening=false;
function setStatus(s){status.textContent=s}
rec.addEventListener('pointerdown',()=>{ if(!SR){setStatus('此浏览器不支持语音识别，请用 Chrome/Edge 打开');return}
  try{r.stop()}catch(e){}
  r=new SR();r.lang='zh-CN';r.interimResults=false;r.continuous=false;
  r.onresult=e=>{txt.value=(txt.value?txt.value+' ':'')+Array.from(e.results).map(x=>x[0].transcript).join(' ')}
  r.onerror=e=>setStatus('识别出错：'+e.error)
  r.onend=()=>{listening=false;rec.classList.remove('recording');rec.textContent='🎤 按住说话'}
  r.start();listening=true;rec.classList.add('recording');rec.textContent='⏺ 正在听…'
});
rec.addEventListener('pointerup',()=>{if(r){try{r.stop()}catch(e){}}});
send.addEventListener('click',async()=>{
  const t=txt.value.trim();if(!t){setStatus('内容为空');return}
  try{const resp=await fetch('/speech?t='+tok,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:t})});
    if(resp.ok){setStatus('✅ 已发送到电脑');txt.value=''}else{setStatus('发送失败：'+resp.status)}
  }catch(e){setStatus('发送失败：'+e.message)}
});
</script>
</body></html>"#;

/// 解析请求行：返回 (path, query 中的 t= token)
fn request_path_and_token(head: &str) -> (&str, Option<&str>) {
    let line = head.lines().next().unwrap_or("");
    let mut it = line.split_whitespace();
    let _ = it.next(); // method
    let target = it.next().unwrap_or("/");
    match target.split_once('?') {
        Some((p, q)) => {
            let token = q.split('&').find_map(|kv| kv.strip_prefix("t="));
            (p, token)
        }
        None => (target, None),
    }
}

fn handle_voice_conn(mut stream: TcpStream, app: &AppHandle) {
    let mut buf = [0u8; 65536];
    let Ok(n) = stream.read(&mut buf) else { return };
    let req = String::from_utf8_lossy(&buf[..n]).to_string();
    let head = req.split("\r\n\r\n").next().unwrap_or("");
    let body = req.split("\r\n\r\n").nth(1).unwrap_or("");
    let (path, token) = request_path_and_token(head);
    // 一次性 token 鉴权：无有效 token 一律 403，防同网段设备注入任务
    let authed = token == Some(voice_token());

    let (status, content_type, payload) = if !authed {
        ("403 Forbidden", "text/plain", "forbidden".to_string())
    } else if path == "/speech" {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
            if let Some(t) = v["text"].as_str() {
                let _ = app.emit("voice-input", t.to_string());
                ("200 OK", "text/plain; charset=utf-8", "{\"ok\":true}".to_string())
            } else {
                ("400 Bad Request", "text/plain", "{\"ok\":false}".to_string())
            }
        } else {
            ("400 Bad Request", "text/plain", "{\"ok\":false}".to_string())
        }
    } else if path == "/" {
        ("200 OK", "text/html; charset=utf-8", VOICE_PAGE.to_string())
    } else {
        ("404 Not Found", "text/plain", "not found".to_string())
    };

    let len = payload.len();
    let _ = write!(
        stream,
        "HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n{}",
        status, content_type, len, payload
    );
}

/// 启动手机语音录入的局域网 HTTP 服务，返回手机访问地址（只启动一次，URL 含一次性 token）
#[tauri::command]
pub fn start_voice_server(app: AppHandle) -> Result<String, String> {
    if VOICE_STARTED.swap(true, Ordering::SeqCst) {
        return Ok(format!("http://{}:{}/?t={}", lan_ip(), VOICE_PORT, voice_token()));
    }
    let listener = TcpListener::bind(("0.0.0.0", VOICE_PORT)).map_err(|e| e.to_string())?;
    thread::spawn(move || {
        for stream in listener.incoming() {
            if let Ok(s) = stream {
                let app = app.clone();
                thread::spawn(move || handle_voice_conn(s, &app));
            }
        }
    });
    Ok(format!("http://{}:{}/?t={}", lan_ip(), VOICE_PORT, voice_token()))
}

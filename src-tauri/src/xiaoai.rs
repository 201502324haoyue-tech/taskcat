use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use tiny_http::{Header, Response, Server};

/// 小爱同学自定义技能回调 HTTP 服务器端口
const XIAOAI_PORT: u16 = 18765;

/// 任务同步缓存：电脑端前端推送全量任务 → 手机端拉取/推送（双向同步枢纽）
static TASK_CACHE: Mutex<Option<Value>> = Mutex::new(None);

/// 启动回调服务器（后台线程，应用退出自动终止）
pub fn start_server(app: AppHandle) {
    let addr = format!("127.0.0.1:{XIAOAI_PORT}");
    std::thread::spawn(move || {
        let server = match Server::http(&addr) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[xiaoai] 启动 HTTP 服务器失败（{addr}）：{e}");
                return;
            }
        };
        println!("[xiaoai] HTTP 服务器已启动 on {addr}");
        for request in server.incoming_requests() {
            handle_request(&app, request);
        }
        println!("[xiaoai] HTTP 服务器已停止");
    });
}

/// 处理单次请求（小爱回调 / 手机语音页 / 语音提交 / 任务同步）
fn handle_request(app: &AppHandle, mut request: tiny_http::Request) {
    let method = request.method().clone();
    let url = request.url().to_string();

    // 所有响应统一加 CORS 头（手机端 WebView 跨域访问需要）
    let cors = [
        Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap(),
        Header::from_bytes(&b"Access-Control-Allow-Methods"[..], &b"GET, POST, PUT, OPTIONS"[..])
            .unwrap(),
        Header::from_bytes(&b"Access-Control-Allow-Headers"[..], &b"Content-Type"[..]).unwrap(),
    ];

    // OPTIONS 预检：直接放行
    if method == tiny_http::Method::Options {
        let _ = request.respond(
            Response::from_string("")
                .with_status_code(204)
                .with_header(cors[0].clone())
                .with_header(cors[1].clone())
                .with_header(cors[2].clone()),
        );
        return;
    }

    // GET / → 手机语音录入页
    if method == tiny_http::Method::Get && url == "/" {
        let html = include_str!("voice_page.html");
        let _ = request.respond(
            Response::from_string(html)
                .with_status_code(200)
                .with_header(cors[0].clone())
                .with_header(cors[1].clone())
                .with_header(cors[2].clone())
                .with_header(
                    Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..])
                        .unwrap(),
                ),
        );
        return;
    }

    // GET /download → 安卓 APK 下载（手机扫码安装）
    // exe 位于 src-tauri/target/{profile}/ 下，向上四级即项目根目录
    if method == tiny_http::Method::Get && url.starts_with("/download") {
        let apk = std::env::current_exe()
            .ok()
            .as_deref()
            .and_then(|e| e.parent())
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
            .map(|p| p.join("任务喵-android.apk"));
        if let Some(path) = apk {
            if let Ok(data) = std::fs::read(&path) {
                let _ = request.respond(
                    Response::from_data(data)
                        .with_status_code(200)
                        .with_header(cors[0].clone())
                        .with_header(cors[1].clone())
                        .with_header(cors[2].clone())
                        .with_header(
                            Header::from_bytes(
                                &b"Content-Type"[..],
                                &b"application/vnd.android.package-archive"[..],
                            )
                            .unwrap(),
                        )
                        .with_header(
                            Header::from_bytes(
                                &b"Content-Disposition"[..],
                                &b"attachment; filename=\"taskcat.apk\""[..],
                            )
                            .unwrap(),
                        ),
                );
                return;
            }
        }
        respond_cors(request, 404, "apk not found", &cors);
        return;
    }

    // GET /api/tasks → 手机端拉取电脑任务全量
    if method == tiny_http::Method::Get && url.starts_with("/api/tasks") {
        let snapshot = TASK_CACHE.lock().unwrap().clone().unwrap_or(json!([]));
        respond_json_cors(request, 200, &snapshot, &cors);
        return;
    }

    // PUT/POST /api/tasks/phone → 手机端推送任务全量（覆盖缓存 + 通知电脑前端）
    if (method == tiny_http::Method::Put || method == tiny_http::Method::Post)
        && url.starts_with("/api/tasks/phone")
    {
        let mut body = String::new();
        if request.as_reader().read_to_string(&mut body).is_err() {
            respond_json_cors(request, 400, &json!({ "ok": false, "error": "读取请求体失败" }), &cors);
            return;
        }
        let parsed: Value = match serde_json::from_str(&body) {
            Ok(v) => v,
            Err(e) => {
                respond_json_cors(request, 400, &json!({ "ok": false, "error": format!("JSON 解析失败：{e}") }), &cors);
                return;
            }
        };
        {
            let mut cache = TASK_CACHE.lock().unwrap();
            *cache = Some(parsed.clone());
        }
        // 通知电脑前端：手机端推送了新任务 → 前端 replaceAll + 写 SQLite
        let _ = app.emit("sync:tasks", &parsed);
        respond_json_cors(request, 200, &json!({ "ok": true }), &cors);
        return;
    }

    // PUT/POST /api/tasks/desktop → 电脑端推送（仅更新缓存，不触发事件，避免回环）
    if (method == tiny_http::Method::Put || method == tiny_http::Method::Post)
        && url.starts_with("/api/tasks/desktop")
    {
        let mut body = String::new();
        if request.as_reader().read_to_string(&mut body).is_err() {
            respond_json_cors(request, 400, &json!({ "ok": false, "error": "读取请求体失败" }), &cors);
            return;
        }
        let parsed: Value = match serde_json::from_str(&body) {
            Ok(v) => v,
            Err(e) => {
                respond_json_cors(request, 400, &json!({ "ok": false, "error": format!("JSON 解析失败：{e}") }), &cors);
                return;
            }
        };
        {
            let mut cache = TASK_CACHE.lock().unwrap();
            *cache = Some(parsed);
        }
        respond_json_cors(request, 200, &json!({ "ok": true }), &cors);
        return;
    }

    // ── 读取请求体 ──
    let mut body = String::new();
    if let Err(e) = request.as_reader().read_to_string(&mut body) {
        eprintln!("[xiaoai] 读取请求体失败：{e}");
        respond_cors(request, 400, "读取请求体失败", &cors);
        return;
    }

    // ── 解析 JSON ──
    let v: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[xiaoai] 解析 JSON 失败：{e}");
            respond_cors(request, 400, "解析 JSON 失败", &cors);
            return;
        }
    };

    // POST /task → 手机语音页提交
    if url.starts_with("/task") {
        let text = v["text"].as_str().unwrap_or("").trim().to_string();
        if text.is_empty() {
            respond_json_cors(request, 400, &json!({ "ok": false, "error": "text 为空" }), &cors);
            return;
        }
        let _ = app.emit("xiaoai:task", json!({ "text": text, "session_id": "phone-voice" }));
        respond_json_cors(request, 200, &json!({ "ok": true }), &cors);
        return;
    }

    // ── 小爱协议：提取请求类型与文本 ──
    let req_type = v["request"]["type"].as_i64().unwrap_or(1);
    let query = extract_query(&v);
    let text = query.trim();

    // ── 构造回复 ──
    let (speak, end_session) = match req_type {
        0 => {
            // type=0：进入技能（用户说「打开任务喵」），欢迎引导
            ("已进入任务喵，请说任务内容，例如：明天下午三点开产品评审会".into(), false)
        }
        2 => {
            // type=2：结束技能
            ("好的，任务喵已退出".into(), true)
        }
        _ => {
            // type=1：对话中——收到一条语音指令
            if text.is_empty() || text == "打开任务喵" || text == "进入任务喵" || text == "退出" {
                ("请说任务内容，例如：明天下午三点开产品评审会".into(), false)
            } else {
                // 向前端发出事件（前端 processText 会调 LLM 提炼 → addTask → toast）
                let _ = app.emit(
                    "xiaoai:task",
                    json!({
                        "text": text,
                        "session_id": v["session"]["session_id"],
                    }),
                );
                (format!("已收到：{}，正在为您处理", truncate(text, 40)), false)
            }
        }
    };

    // ── 构建响应 JSON ──
    let resp = json!({
        "version": "1.0",
        "response": {
            "open_mic": !end_session,
            "to_speak": {
                "type": 0,
                "text": speak,
            }
        },
        "is_session_end": end_session,
    });

    respond_json_cors(request, 200, &resp, &cors);
}

/// 从小爱回调中提取用户说的文本（优先级：intent.slots > intent.query > request.query > query）
fn extract_query(v: &Value) -> String {
    // 1. 从 request.intent.slots 提取命名的槽位
    if let Some(slots) = v["request"]["intent"]["slots"].as_array() {
        for slot in slots {
            if let Some(name) = slot["name"].as_str() {
                if name == "taskContent" || name == "content" || name == "task" {
                    if let Some(val) = slot["value"].as_str() {
                        if !val.is_empty() {
                            return val.to_string();
                        }
                    }
                }
            }
        }
    }
    // 2. 从 request.intent.query
    if let Some(q) = v["request"]["intent"]["query"].as_str() {
        if !q.is_empty() {
            return q.to_string();
        }
    }
    // 3. 从 request.query
    if let Some(q) = v["request"]["query"].as_str() {
        if !q.is_empty() {
            return q.to_string();
        }
    }
    // 4. 根级 query
    v["query"].as_str().unwrap_or("").to_string()
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max])
    }
}

fn respond_cors(mut request: tiny_http::Request, status: u16, text: &str, cors: &[Header]) {
    let _ = request.respond(
        Response::from_string(text)
            .with_status_code(status)
            .with_header(cors[0].clone())
            .with_header(cors[1].clone())
            .with_header(cors[2].clone())
            .with_header(
                Header::from_bytes(&b"Content-Type"[..], &b"text/plain; charset=utf-8"[..])
                    .unwrap(),
            ),
    );
}

fn respond_json_cors(mut request: tiny_http::Request, status: u16, value: &Value, cors: &[Header]) {
    let body = value.to_string();
    let _ = request.respond(
        Response::from_string(body)
            .with_status_code(status)
            .with_header(cors[0].clone())
            .with_header(cors[1].clone())
            .with_header(cors[2].clone())
            .with_header(
                Header::from_bytes(&b"Content-Type"[..], &b"application/json; charset=utf-8"[..])
                    .unwrap(),
            ),
    );
}
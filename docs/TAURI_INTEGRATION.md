# Windows 桌面集成与构建

本文描述当前工程，不是待实现的原型设计，也不是产品 PRD。Tauri 已接入，不要再次执行 `tauri init`。

## 构建入口

- 前端：Vue 3、Pinia、TypeScript、Vite；包管理器与 CLI 版本见根 `package.json`。
- 桌面：Tauri 2、Rust stable/MSVC、Windows SDK、VS C++ Build Tools、WebView2。
- 安装依赖：`pnpm install --frozen-lockfile`。
- 开发：`pnpm tauri dev`；要求 Vite 服务与 `tauri.conf.json` 中的端口一致。
- 安装包：`pnpm tauri build`，输出 `src-tauri/target/release/bundle/nsis/`。
- 仅核对 Rust 编译：`cargo check --locked --manifest-path src-tauri/Cargo.toml`。

`Cargo.lock` 与 `pnpm-lock.yaml` 均需入库。`Cargo.toml` 的历史最低 Rust 声明不代表所有锁定依赖都支持该旧版本，建议使用当前 stable。`src-tauri/.cargo/config.toml` 带 crates 镜像配置，构建需要相应网络可用；不要依赖作者电脑的缓存来判断新环境一定成功。

## 模块与运行时

| 位置 | 职责 |
| --- | --- |
| `src-tauri/tauri.conf.json` | 应用标识、初始窗口、前端构建、NSIS 安装配置 |
| `src-tauri/src/lib.rs` | 窗口生命周期、托盘、快捷键、命令注册 |
| `src-tauri/src/commands.rs` | 截图、模型请求、窗口状态、系统设置等命令 |
| `src-tauri/src/lark.rs` | 飞书通道（lark-cli 会话、认证与消息轮询） |
| `src-tauri/src/xiaoai.rs` / `voice_page.html` | 手机语音网页及本地 HTTP 接收 |
| `src/services/storage-tauri.ts` | SQLite 适配 |
| `src/utils/tauri.ts` | 区分浏览器、Tauri 与 Capacitor 环境 |
| `src/components/SmartInput.vue` | 智能录入入口和预览确认 |

应用标识为 `com.eisenhower.pet`，数据目录通常为 `%APPDATA%\com.eisenhower.pet\`。数据库、模型/飞书配置、WebView 登录态及窗口状态都不应进入 Git。改应用标识会影响数据目录，不应为改显示名称而随意修改。

主窗口初始 `540×375`、透明、无边框、可缩放；运行时会应用保存的窗口状态。启动隐藏由前端就绪流程控制，不要仅按配置中的 `visible: false` 判断启动失败。当前以完整四象限面板为主，旧版收起窗口规格不作为当前验收依据。

全局快速录入首选 `Ctrl+Shift+Space`，占用时按代码注册回退键；截图为 `Alt+Period`。浏览器只能处理页面聚焦时的键盘事件。任务拖拽是 Pointer Events，系统窗口拖动则由原生窗口接口处理。

## 外部依赖与打包边界

- 模型 API 地址和密钥在应用中配置；图像提取要求所选模型支持图片。
- 复制 `.env.example` 为本地配置可提供非秘密默认地址；所有 `VITE_*` 都会编入前端。
- 普通飞书 CLI 可通过 `LARK_CLI_BIN` 指定；当前 bundle 未包含 CLI 资源，开发机能找到工具不代表新安装能找到。
- 语音 HTTP 服务与云同步 Python 后端是两套服务。监听端口可达不等于识别 API 可用，也不等于允许安全暴露公网。
- Android 工程由 Capacitor 构建，不是 Tauri mobile；iOS 图标资源不代表已支持 iOS 发布。

## 验证清单

自动验证：`pnpm test`、`pnpm typecheck`、Python 配置单元测试、`pnpm build`、Rust 编译检查、入库清单检查。

Windows 集成验证需单独检查：

1. 托盘显示/隐藏、退出，以及启动和窗口位置恢复。
2. 快速录入、截止时间和子任务修改、跨象限拖拽、重启后数据保持。
3. 跨应用截图快捷键、鼠标所在屏幕、选区/整屏、取消及失败恢复。
4. 显示缩放、多屏、窗口透明度与尺寸边界。
5. 模型配置错误/超时提示，确认前不落库、确认后不重复添加。
6. 独立测试账号的双端同步；不要使用个人生产数据做破坏性测试。
7. 在未安装开发工具的新 Windows 环境验证安装包，尤其 WebView2 和可选 CLI 缺失时的提示。

编译通过不等于上述集成验收全部完成。打包前确认不会覆盖当前正在运行的程序；必要时使用独立验证工作副本。

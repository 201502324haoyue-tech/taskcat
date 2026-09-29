# 任务喵 TaskCat

四象限任务管理器 + 小猫桌宠：用艾森豪威尔矩阵把待办分清楚，让一只 Canvas 小猫陪你把事情做完。

- **四象限**：重要/紧急四格分区，子任务、截止时间、完成与删除，跨象限拖拽。
- **小猫桌宠**：随任务压力改变状态、临期提醒；面板位置、尺寸、透明度、字体与显示设置可调。
- **多种录入**：手动输入、Windows 截图识别、手机语音转文字、飞书群消息与妙记提取。
- **桌面集成**：系统托盘、全局快捷键、快捷录入弹窗、窗口拖动与开机自启。
- **本地优先**：数据存在本机，可选自建同步服务实现电脑/手机双向同步。

同一套 Vue 3 前端复用于 Windows Tauri 桌面端、Android Capacitor 端和浏览器原型。

本仓库保存当前实现，不是复刻需求文档。Windows/前端版本为 `0.1.0`；Android 目前沿用 `versionName 1.0 / versionCode 1`。可选集成的代码存在不代表凭证、权限、网络和设备均已验通。

## 当前功能

- 四象限任务、子任务、截止时间、完成与删除，Pointer Events 跨象限拖拽。
- Canvas 小猫、压力驱动状态、临期提醒；面板位置、尺寸、透明度、字体与显示设置。
- Windows 托盘、快捷录入、截图快捷键、窗口拖动和开机自启设置。
- 本地持久化，以及可选的账号登录与电脑/手机任务同步。

### 录入方式与边界

| 方式 | 当前实现 | 条件与限制 |
| --- | --- | --- |
| 手动 | 面板输入、象限加号、快速录入弹窗 | 不需要模型或云账号；`Ctrl+Shift+Space` 为桌面快捷键 |
| 截图 | 鼠标所在屏幕冻结、选区或整屏识别、任务列表确认后添加 | Windows；`Alt+Period`（界面显示 Alt+。）或智能录入入口；需配置支持图像的模型 |
| 语音 | 手机网页语音转文字发送到电脑；Android 有语音输入弹窗 | 依赖 Web Speech API、麦克风权限、安全上下文和网络；不同浏览器/WebView 支持不同 |
| 飞书内容提取 | 群消息、妙记转写提取，以及可选自动接收 | 需自建飞书应用并配置凭证与读取权限，本机需可用飞书 CLI |

账号同步不是独立录入方式。

## 快速开始

前端需要 Node.js ≥22.12、pnpm 10（锁定开发版本 `10.33.0`）。

```powershell
pnpm install --frozen-lockfile
pnpm dev
pnpm test
pnpm typecheck
pnpm build
```

浏览器原型通常在 `http://localhost:5173`，端口占用时可能变化。浏览器模式不具有 Windows 截图、系统托盘、原生窗口及全局快捷键能力。

### Windows 桌面版

安装 Rust stable（MSVC 工具链）、Visual Studio Build Tools 的 C++ 桌面开发组件、Windows SDK 和 WebView2 Runtime。

```powershell
pnpm tauri dev
pnpm tauri build
```

工程已经初始化，不要再次运行 `tauri init`。Tauri CLI 已作为固定版本开发依赖入库，不依赖作者的 `.tools/tauri-cli`。NSIS 安装包位于 `src-tauri/target/release/bundle/nsis/`。当前桌面代码针对 Windows，未承诺 Linux/macOS 可编译。详见 [桌面集成说明](docs/TAURI_INTEGRATION.md)。

### Android

需要 JDK 21、Android SDK 36 与构建工具，使用 `ANDROID_HOME` 或被忽略的 `android/local.properties` 指定 SDK。

```powershell
pnpm android:sync
.\android\gradlew.bat -p android assembleDebug
```

调试 APK 位于 `android/app/build/outputs/apk/debug/`。发布签名和正式版本号策略尚未配置；不要把签名密钥提交入库。原生悬浮球需要设备授权，语音能力取决于设备 WebView。每次修改前端后重新执行 `android:sync`。

## 配置与数据

### 前端与模型

参考 `.env.example`，按需在本机创建 `.env.local`（已有文件不要覆盖）：

| 变量 | 用途 |
| --- | --- |
| `VITE_SYNC_SERVER_URL` | 可选的同步服务器默认地址；也可在设置中填写。清空设置可停用该地址 |
| `VITE_VOICE_PUBLIC_URL` | 可选的语音访问地址展示，不会自动建立隧道 |

`VITE_*` 会进入前端产物，绝不能放密钥。新检出仓库默认不连接任何云服务。生产同步应使用 HTTPS；本地 HTTP 只用于可信环境调试。

模型在应用设置里配置 API 地址、Key、模型与协议。截图/文本会发送给你选择的模型服务；飞书提取会访问你自建的应用服务。不是所有文本模型都支持图片。应用配置和登录态不是凭证保险箱，共用电脑时应注意本机访问权限。

Windows 数据通常在 `%APPDATA%\com.eisenhower.pet\`（包括任务数据库、窗口状态、相关凭证配置）；浏览器使用其站点的 localStorage。备份需包含各端本地数据，复制源码不是数据备份。不要上传整个应用数据目录。

### 可选同步后端

```powershell
python -m pip install -r scripts/requirements.txt
python scripts/taskcat-server.py
```

需要 Python 3.10+。默认只监听 `127.0.0.1:8080`，数据和 JWT 密钥写入被忽略的 `.tools/taskcat-server/`。

- `TASKCAT_DATA_DIR`：数据目录，必须可写；升级既有服务器时显式指向原目录，避免生成新数据库/密钥。
- `TASKCAT_HOST` / `TASKCAT_PORT`：监听地址和端口。
- `TASKCAT_FEISHU_APP_ID`：可选实验性飞书事件中转；默认未开启。

本后端保留现有多用户注册、登录和任务同步实现，尚不作为生产安全承诺。公网部署前需单独评估鉴权、速率限制、输入校验、备份和 HTTPS；飞书事件接口还需补齐回调来源校验及读取权限。仅配置 App ID 不等于鉴权。不要直接把事件中转或语音服务暴露到公网。

### 可选飞书 CLI

飞书内容提取依赖飞书 CLI，由调用方自行安装，可通过 `LARK_CLI_BIN` 指定路径；当前 NSIS 包未内置该二进制。缺少 CLI 时该入口不可用，其余功能不受影响。

## 测试与入库检查

```powershell
pnpm test
python -m unittest discover -s tests -p test_server_config.py
pnpm build
pnpm check:publish --candidates
# 暂存后检查 Git 索引中实际待提交的内容：
pnpm check:publish
```

单元测试不会调用真实飞书或模型服务。截图、多屏、托盘、权限及跨端同步仍需对应设备上的集成验证。

仓库保留前端、Tauri、Android 原生工程、锁文件、测试与维护入口。根 `.gitignore` 使用允许清单：新增根目录、维护脚本或文档时需显式更新规则。凭证、数据库、日志、运维截图、本机 SDK 路径、依赖缓存、APK/EXE 等产物不入源码历史。`check:publish` 是基础路径/疑似密钥检查，不能替代完整安全审查。

## 许可证

本项目采用 MIT 许可证，详见 [LICENSE](LICENSE)。第三方依赖仍受各自许可证约束。安装包分发应另行确认，源码入库不等于已经发布 Releases。

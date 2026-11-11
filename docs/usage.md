# Token 悬浮条

伴随 Codex 或已连接的聊天网页显示的 Windows 桌面悬浮条。圆角玻璃效果、白色文字，显示今日 token、右侧累计总量，以及今日输入 / 输出 / 缓存。支持 Codex、Claude Code 的日志用量，以及 ChatGPT / Claude 网页的可见文本估算。无需 API key 或 npm 依赖。原始会话日志只读，不修改 Codex 配置。

## 启动

双击 `start.cmd`：启动托盘伴随程序。检测到 Codex 窗口，或 Chrome 扩展报告可见的聊天页面时显示悬浮条。最小化 Codex 时继续显示。网页接收默认启用，统计服务在后台待命，以便关闭 Codex 后仍能接收浏览器计数；`browserBridge.enabled: false` 可恢复仅随 Codex 运行服务的行为。

双击 `enable-autostart.cmd`：在当前 Windows 用户的启动文件夹创建一个快捷方式。以后登录 Windows 后自动待命，打开 Codex 即可显示。不会修改系统服务、计划任务或 Codex 安装文件。双击 `disable-autostart.cmd` 可移除这个快捷方式并退出；`stop.cmd` 只退出本次运行。

拖动悬浮条移动位置，双击或点右侧箭头折叠。右键 / `⋯` 菜单可立即同步、查看详细统计、切换“统计来源”、取消置顶、重置位置或关闭悬浮条。默认“自动跟随”：聊天网页报告有焦点时显示对应网页估算，其余时候显示 Codex；也可固定选择四个来源或全部。关闭悬浮条后，托盘程序继续待命，下次关闭再打开应用自动恢复。网页心跳每 15 秒更新，45 秒未更新即过期；关闭整个 Chrome 后会立即停止跟随。位置、折叠、置顶和来源选择保存在 `data/widget-settings.json`。

## ChatGPT / Claude 网页

扩展目录：`browser-extension`。先运行 `setup.cmd` 或 `node src/prepare-browser-extension.js` 生成本机 `connection.js`，无需手工填写密钥；修改服务端口或迁移电脑后重新运行准备命令，然后在 Chrome 扩展管理页点“重新加载”。

1. 在 Chrome 地址栏输入 `chrome://extensions`，打开右上角“开发者模式”。
2. 点击“加载已解压的扩展程序”，选择本项目的 `browser-extension` 文件夹。
3. 回到 `https://chatgpt.com/` 或 `https://claude.ai/`，刷新网页。点击扩展图标可检查连接状态，或立即采集当前聊天页。

托盘菜单“连接网页统计（Chrome）”或详情页中的同名链接可随时打开安装说明。

**计量口径：**网页只估算页面已加载消息中的可见文本，不代表服务端 token 消耗；不包含上下文重复发送、系统提示、隐藏推理、图片/附件、缓存、工具调用或未加载历史。中日韩文字按约 1.5 token/字、拉丁字母数字约 4 字符/token、标点约 1 token、emoji 约 3 token 的公开规则估算，不是官方分词器。网页来源、`≈`、详情提示及 CSV 均明确标注估算。

**去重与日期：**每个来源的每个会话保存已观察输入/输出的最大值，只有新增部分累加。刷新、流式更新、重复标签不会重复记录；切换分支、删除文字、重新生成或页面虚拟化时，不能据此还原完整调用次数。首次打开的历史文本按本机首次接收计数的日期归档，之后的增量归入收到增量的日期。离线时扩展只保留会话最大计数，重连后同步；跨天离线的增量无法恢复原始每日分布。

**隐私与连接：**扩展只在 `chatgpt.com`、`chat.openai.com`、`claude.ai` 注入只读消息采集脚本，文字仅在页面内存中计算。传给本机的只有计数、哈希会话标识及页面可见/焦点状态；不保存正文，不读取 Cookie、账号或登录凭据。后台请求固定发往 `127.0.0.1`。接收接口使用随机本机密钥校验，其他统计/停止接口仍只接受本地页面访问。不要分享 `browser-extension/connection.js` 或 `data/browser-bridge.key`；它们不是账号令牌。网站结构改变时可能需要更新采集选择器，扩展弹窗会提示未识别到消息。

仅托盘菜单中的“完全退出后台（停止自动跟随）”和 `stop.cmd` 会彻底结束伴随程序；此后需运行 `start.cmd`，或等到下次 Windows 登录自启动，单独重启 Codex 不会启动已退出的后台。位置、折叠和置顶设置保存在 `data/widget-settings.json`。

玻璃主体为 382×56 个 Windows 逻辑像素，150% 缩放时约 573×84 屏幕像素。背景由独立的 Windows Composition 窗口实时进行 GPU 高斯模糊，并裁切到圆角；上层单独绘制通透底色、左侧玻璃区、渐变边缘高光和随鼠标变化的反光，文字不参与模糊。柔和外阴影随主体移动和折叠，不遮挡鼠标操作。当前实现是实时磨砂玻璃与表面光泽，不包含光学折射着色器。

支持 Windows 10/11；合成器不可用时回退到系统模糊。无需截图、缓存壁纸或新增第三方运行库。`data/widget-diagnostics.json` 的 `glassRenderer` 为 `composition-gaussian-blur` 时表示新合成器已启用，`accent-fallback` 表示回退。实现参考了 [WPF Liquid Glass 的效果分层思路](https://github.com/dragosniamtu/WPF-Liquid-Glass-Effect)、[Island Command Center 的独立背景窗口架构](https://github.com/primez-x/windhawk-island-command-center)及 Microsoft 的 Windows Composition / Direct2D API；未引入这些项目的运行库。

累计总量 = 本机日志历史用量 + 可选历史补录。公开默认配置的历史补录为 0。编辑 `config.json` 的 `historicalTokens.codex` 可修改，重启悬浮条生效。补录不计入今日、趋势、模型排行或逐条 CSV。鼠标悬停累计数字可查看精确值及构成。

网页仅作为菜单中的可选“详细统计”。手动启动详情服务也可以执行：

也可以在当前目录执行：

```powershell
node src/cli.js serve --open
```

可选详细页面：<http://127.0.0.1:7681>。统计服务需要 Node.js 20 或更新版本；悬浮条优先使用 `node-path.txt` 中记录的本机运行环境，其次使用系统 Node。若 Codex 升级后旧路径失效，可以更新这个文本文件或安装系统 Node.js。原生悬浮条使用 Windows 随附的 .NET Framework；`build-widget.ps1` 可从 `native/TokenWidget.cs` 重新编译，无需下载编译器。

## 功能

- 总用量、普通输入、输出、缓存读取与写入、推理用量。
- 每日趋势、模型分布、项目排行、最近 60 条记录。
- 今天 / 近 7 天 / 近 30 天 / 全部历史，以及自选日期、工具、模型筛选。
- CSV 导出遵循当前页面筛选，带 UTF-8 BOM，可用 Excel 打开。
- 默认每 30 秒扫描日志；页面每 5 秒获取统计结果。
- 增量读取、跨重启保存进度、相同事件去重；应用锁避免两个写入进程同时运行。

## 数据来源

| 工具 | 默认目录 | 用量字段 |
| --- | --- | --- |
| Codex CLI / 使用同类日志的桌面端 | `~/.codex/sessions/`、`~/.codex/archived_sessions/` | `event_msg` 的 `token_count`，以及 `turn_context` 中的模型 |
| Claude Code | `~/.claude/projects/`，包括子代理日志 | assistant 消息的 `message.usage` / `usage` |
| ChatGPT 网页 | Chrome 扩展，`chatgpt.com` / `chat.openai.com` | 可见用户 / 助手文本估算，按本机采集日统计 |
| Claude 网页 | Chrome 扩展，`claude.ai` | 可见用户 / 助手文本估算，按本机采集日统计 |

`~` 指用户主目录，例如 Windows 的 `C:\Users\你的用户名`。遵循 `CODEX_HOME`、`CLAUDE_CONFIG_DIR` 环境变量。只扫描 `.jsonl` 文件，不跟随目录符号链接。WSL、其他用户或自定义安装目录请通过 `roots` 指定；例如 WSL 可使用可访问的 `\\wsl.localhost\发行版\home\用户名\.codex\sessions` 路径。

## 修改配置

编辑当前目录 `config.json`，然后重启工具：

```json
{
  "port": 7681,
  "refreshSeconds": 30,
  "timezone": "Asia/Shanghai",
  "browserBridge": { "enabled": true },
  "historicalTokens": { "codex": 0, "claude": 0 },
  "sources": {
    "codex": { "enabled": true, "roots": [] },
    "claude": { "enabled": true, "roots": [] },
    "chatgpt-web": { "enabled": true },
    "claude-web": { "enabled": true }
  }
}
```

`roots: []` 使用默认目录；非空数组替换默认目录。可填多个目录，使用 JSON 格式的转义反斜杠，或直接使用 `/`，例如 `["D:/logs/codex/sessions"]`。`enabled: false` 停止读取该工具，并从页面和导出中隐藏该来源已有记录；不会删除记录。

## 命令

```powershell
node src/cli.js sync                 # 增量导入并输出汇总
node src/cli.js stop                 # 停止本地服务
node src/cli.js report               # 查看已有本地统计，不扫描日志
node src/cli.js report --json        # JSON 汇总
node src/cli.js export usage.csv     # 导出已有全部记录，不覆盖同名文件
node --test                         # 自动验证
powershell -NoProfile -File build-widget.ps1 -Test  # 悬浮条关闭 / 重开回归验证
```

页面运行期间请直接点击“立即同步”，不要另开 `sync` 进程。

## 统计口径与边界

- 总 token = 普通输入 + 缓存读取 + 缓存写入 + 输出。Codex 的输入含缓存，工具会将缓存拆出；Claude 的缓存单列。
- 推理 token 是 Codex 输出的一部分，只作为说明，不再叠加到总量。Claude 的扩展思考通常已在输出中，不单独推测其数量。
- 上下文每次重新发给模型都会消耗输入 token，累计用量可能远大于聊天文字的长度。这里统计调用消耗，不是当前上下文长度或剩余额度。
- Codex 同时记录 `token_usage_record` 和 `token_count` 时，只读取后者；使用累计差值避免重复事件造成累加，首次有单次用量时优先读单次值。日志内没有模型信息的记录显示 `unknown`。
- Claude 相同消息 ID 去重；同一消息后续用量增加时更新计数。相同时间、相同计数的 Codex 复制事件去重。分叉日志若改写了原事件时间或计数，仍可能无法识别；这不是服务端账单审计系统。
- 按配置时区划分日期。用量时间取日志时间；原工具若只提供累计快照，无法恢复未记录的各次调用时间。
- 不完整的末尾 JSON 行留到下一次同步；完整但损坏的行跳过并在页面提示。超大单行超过 64 MiB 时暂停该文件后续读取并提示跳过数，以限制内存。
- 已导入的记录在原日志删除或移走后仍保留。若同一历史日志被改写，旧记录可能仍在；需要全量重算时，先停止工具，再将 `data` 文件夹重命名备份，重新启动。仅有仍在磁盘上的日志可以重建。
- 支持上述两类日志，以及配套 Chrome 扩展的两类网页文本估算；Cursor 等其他工具尚未接入。不估算费用，不代表订阅账单，不显示额度。

## 本地保存与隐私

`data/usage.json` 保存用量记录和文件进度；`data/app.lock` 是运行锁。数据不会保存提示词、回复、代码、API key 或登录令牌。会保存时间、模型、会话 ID、项目目录以及扫描的日志路径等元数据。解析器需要在内存中读取日志行，但只把指定的用量字段写入统计文件。

页面不加载外部字体、脚本或统计服务。HTTP 服务仅监听 `127.0.0.1`，校验本地主机及请求来源；没有远程上传、定价请求或云同步。CSV 导出会包含项目路径和会话 ID，请按需要分享。

这个工具参考“读取本地日志 → 增量解析 → 去重 → 汇总”的通用思路独立实现，未引入 TokenTracker 的源码或依赖。


# Agent Statistics

本地 Agent 用量与费用仪表盘。  
在本机读取各编码助手留下的会话 / 日志，汇总 Token、缓存与估算费用，并可选查询多家 API 中转 / 订阅的余额。

默认界面语言为**简体中文**，可在「设置」中切换 English。

---

## 如何使用

### 环境要求

- [Node.js](https://nodejs.org/)（建议 LTS）
- [Rust](https://www.rust-lang.org/tools/install) 工具链（`cargo`）
- [Tauri 2](https://v2.tauri.app/) 所需系统依赖（Windows 上通常还需 WebView2）

### 安装与启动

```bash
# 安装前端依赖
npm install

# 开发模式（热更新 + 桌面窗口）
npm run tauri dev
```

生产构建：

```bash
npm run tauri build
```

### 日常操作

1. **首次启动**  
   若本地用量库为空，应用会自动做一次全量扫描。也可随时点工具栏 **「扫描」** / **「全量扫描」**。

2. **概览**  
   看总记录数、会话数、费用与 Token 汇总；按日图表；按 Agent / 按模型表格（支持缓存命中率）。

3. **记录**  
   按 Agent、模型、时间、项目筛选明细；分页浏览。

4. **余额**  
   配置多家 Provider（可多 Key），查询额度 / 余额；结果会写入 SQLite 时序快照。  
   支持按间隔自动刷新（在「设置」里配置）。

5. **设置**  
   - 启用 / 关闭某个 Agent 数据源，并可选覆盖数据路径  
   - 余额 / 用量自动刷新间隔  
   - 模型价格覆盖（手动指定单价）  
   - 界面语言  
   - **「同步价格」**：从公开模型目录拉取单价缓存

6. **主题**  
   标题栏可切换浅色 / 深色 / 跟随系统。

### 数据存放位置

应用数据（SQLite 用量库、设置、价格缓存）一般在：

| 系统 | 路径 |
|------|------|
| Windows | `%APPDATA%\com.zhiyir.agent-statistics\` |
| 主要文件 | `usage.db`、`settings.json`、`prices.json` |

用量本身来自**各 Agent 自己的本机目录**，本应用默认只读扫描，不会改写对方会话文件。

---

## 数据采集说明

### 扫描方式

- **增量扫描（「扫描」）**  
  按源文件 mtime / 大小判断：未变则跳过；JSONL 仅追加则 tail 读取；缩小或重写则整文件重扫。

- **全量扫描（「全量扫描」）**  
  清空该 Agent 在库中的旧行后重建。前端会清空用量视图并显示进度，避免一直显示过期数字。

扫描在后台线程执行；界面用进度事件 + 节流刷新，避免写库时高频全表聚合把 UI 卡死。

### 已支持的 Agent 数据源

| ID | 名称 | 默认路径（可被设置覆盖） | 主要格式 |
|----|------|--------------------------|----------|
| `claude` | Claude Code | `~/.claude/projects` | 会话 JSONL |
| `codex` | OpenAI Codex | `~/.codex/sessions` | `rollout-*.jsonl`（`token_count`） |
| `kimi` | Kimi Code | `~/.kimi-code/sessions`，并兼容 `~/.kimi/sessions`、`%APPDATA%\Kimi Code\sessions` | `wire.jsonl` + `session_index.jsonl` + `config.toml` 模型映射 |
| `opencode` | OpenCode | `~/.local/share/opencode/opencode.db` | SQLite |
| `zcode` | ZCode | 项目内约定路径 | SQLite 等 |
| `zed` | Zed Agent | Windows：`%LOCALAPPDATA%\Zed\threads\threads.db` | zstd/JSON 线程库 |
| `devin` / `devin_desktop` | Devin | 本机会话库 | 只读 SQLite |

各 Collector 实现见 `src-tauri/src/collectors/`。

### Token 口径（常见差异）

不同产品对「Input / Cache」定义不一致，汇总时需要注意：

- **Codex / OpenAI 风格**  
  `input_tokens` 通常已包含缓存部分；`cached_input_tokens ⊆ input`。  
  命中率按 `cache_read / input` 计算。

- **Claude / Anthropic 风格**  
  Input 多为 fresh；cache read / creation 单独字段，统计上可与 Input 相加。

- **Kimi Code**  
  现代 `usage.record` 为顶层字段；只计 `usageScope == "turn"`（`session` 为累计快照，计入会翻倍）。  
  会用 `config.toml` 的 `[models."…"]` 把显示名 / 表键解析为 `model` 字段（Model ID），**不会读取或保存 API Key**。

- **按模型汇总**  
  同一 `model` 可能来自多个 `provider`，汇总按 **model 合并**，避免只显示其中一个 Provider 切片。

### 费用估算

- 价格来自同步的公开目录缓存（`prices.json`）+ 设置里的模型覆盖。  
- 计费时会把 cache read / write / reasoning 与 fresh input 分开（若有单价）。  
- 界面费用默认展示到小数点后两位；仅为估算，以账单为准。

### 余额查询

余额 Tab 通过 HTTP 查询你配置的中转 / 订阅接口（Bearer Token 等）。  
密钥只保存在本地 `settings.json`；快照写入 `usage.db` 的 `balance_snapshots` 表。

---

## 代码库介绍

### 技术栈

| 层级 | 技术 |
|------|------|
| 桌面壳 | [Tauri 2](https://v2.tauri.app/) |
| 前端 | React 19 + TypeScript + Vite + Tailwind / shadcn 风格组件 |
| 图表 | Recharts |
| 后端 | Rust：采集、SQLite、定价、余额请求 |
| 本地库 | `rusqlite`（WAL） |

### 目录结构（精简）

```
.
├── src/                      # 前端
│   ├── App.tsx               # 主界面：概览 / 记录 / 设置与扫描状态
│   ├── components/           # 余额页、标题栏、主题、表格与 UI 原语
│   ├── i18n/                 # 轻量国际化（默认 zh-CN）
│   ├── lib/api.ts            # 调用 Tauri commands
│   └── types.ts              # 前后端共享类型（TS 侧）
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs            # commands、扫描线程、启动逻辑
│   │   ├── collectors/       # 各 Agent 采集器
│   │   ├── db.rs             # usage.db schema 与查询
│   │   ├── pricing.rs        # 价格缓存与 cost 计算
│   │   ├── balance.rs        # 余额 Provider 适配
│   │   ├── models.rs         # 序列化结构
│   │   └── state.rs          # 应用状态与数据目录
│   ├── prices.json           # 打包/默认价格数据
│   └── tauri.conf.json
├── LICENSE                   # GNU AGPL v3 全文
└── README.md
```

### 前后端边界

- **Rust**：只读扫描本机文件 / DB、写自己的 `usage.db`、拉价格、查余额。  
- **前端**：展示、筛选、编辑设置与余额配置、触发扫描 / 同步。  
- 通信：Tauri `invoke` + 事件（`scan-progress`、`scan-finished`、`price-sync-*`、`balance-refreshed` 等）。

### 开发提示

```bash
# 仅前端（无桌面壳时可用 Vite）
npm run dev

# Rust 检查
cd src-tauri && cargo check

# 部分单元测试（例如 Kimi 解析）
cd src-tauri && cargo test --lib
```

贡献代码时请保持改动范围克制：优先修采集口径与汇总正确性，避免无关重构。

---

## 许可证（AGPL v3）

本项目以 **[GNU Affero General Public License v3.0](./LICENSE)**（AGPL-3.0）发布。

### 用白话说意味着什么

1. **你可以**自由使用、学习、修改和再分发本软件。  
2. **如果你分发**修改版（或包含本项目代码的衍生作品），必须以 AGPL v3 开源，并提供完整对应源代码。  
3. **如果你把修改版跑在网络服务上**，让别人通过网络使用它，AGPL 还要求你向这些用户提供对应源代码的获取方式（这是 AGPL 相对普通 GPL 的关键加强点）。  
4. 软件**按「现状」提供，不附带任何担保**；详情见许可证第 15、16 节。

完整法律文本见仓库根目录 [`LICENSE`](./LICENSE)（与 [GNU 官方 AGPL-3.0 文本](https://www.gnu.org/licenses/agpl-3.0.txt) 一致）。  
若你计划闭源商用、嵌入专有 SaaS 或与不兼容许可证组合，请先自行阅读全文或咨询法律顾问。

---

Agent Statistics —— 把散落在本机的 Agent 用量收拢到一张表里。

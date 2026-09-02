# Sydaris 本机状态管理指南

这套命令用于保存和切换本机 Sydaris 的完整运行状态，适合录制演示、调试导入流程和反复回到干净基线。

一个状态包含：

- PostgreSQL 数据库快照；
- Library 原始文件（默认 `.sydaris-library`）；
- 冷启动解析产物（默认 `.cold-start`）。

它不包含 Git 代码、`.env` 或其他项目文件，也不会帮你切换 Git 分支或提交。保存状态时只会把当前 Git commit 和工作区是否有未提交修改记入元数据，方便辨认状态对应的代码版本。

## 最常用的命令

所有命令都应在项目根目录执行：

```bash
cd /Users/soflan/web/association-management
```

查看已有状态：

```bash
pnpm state:list
```

校验状态是否完整：

```bash
pnpm state:verify -- c0-empty
```

加载干净状态 `c0-empty`：

```bash
pnpm state:load -- c0-empty --yes
```

保存一个新状态：

```bash
pnpm state:save -- before-import
```

覆盖同名状态：

```bash
pnpm state:save -- before-import --replace
```

命令中的 `--` 用来把后面的参数传给状态管理脚本；`load` 必须显式添加 `--yes`，因为它会覆盖当前运行中的数据库和文件状态。

## 推荐工作流

### 回到 `c0-empty` 干净基线

先停止正在写数据库或文件的开发服务、Parser 和 worker，然后运行：

```bash
pnpm state:list
pnpm state:verify -- c0-empty
pnpm state:load -- c0-empty --yes
```

看到下面的信息才表示切换完成：

```text
状态已加载：c0-empty
切换前状态保存在：autosave-...
```

然后再启动应用：

```bash
pnpm dev
```

### 在重要操作前保存检查点

例如准备导入一批资料前：

```bash
pnpm state:save -- before-import
pnpm state:verify -- before-import
```

操作完成后还可以再保存一个状态：

```bash
pnpm state:save -- after-import
```

状态名称只能包含字母、数字、点、下划线和连字符，最长 80 个字符。建议使用容易辨认的名称，例如 `c0-empty`、`before-import` 或 `demo-ready-20260901`。

## 加载状态时会发生什么

`state:load` 会按以下顺序执行：

1. 检查是否有 `queued` 或 `running` 的资料编译任务；
2. 校验目标状态的数据库 SHA-256 和文件清单；
3. 自动把当前运行状态保存为 `autosave-<时间>-<随机码>`；
4. 恢复目标数据库、Library 文件和解析产物；
5. 再次校验恢复后的文件状态。

如果加载过程中失败，脚本会尝试用刚创建的 `autosave-*` 自动回滚。因此看到“已自动恢复到切换前状态”表示目标状态没有加载成功，但原状态已经恢复。不要把报错后的自动回滚误认为加载成功。

自动保存会保留在 `.sydaris-states` 中，重复加载可能累积多个 `autosave-*`。当前脚本没有内置删除命令；确认不再需要后，可自行归档或移除旧状态。

## 活跃任务限制

保存和加载前，最好停止正在提交的聊天、文件写入、Parser 和资料编译 worker。

如果存在 `queued` 或 `running` 的资料编译任务，命令默认拒绝继续。只有保存操作可以选择接受当前已持久化的“尽力而为”状态：

```bash
pnpm state:save -- emergency-checkpoint --allow-active
```

`--allow-active` 不适用于 `state:load`。加载前仍应先暂停旧 worker，否则恢复后可能立刻被旧任务继续写入。

## 运行前准备

### 1. 检查数据库连接

项目根目录必须有 `.env`，其中的 `DATABASE_URL` 要指向实际运行的 PostgreSQL。当前本机 PostgreSQL 使用 `5433` 时，地址形式应类似：

```dotenv
DATABASE_URL=postgresql://<用户名>:<密码>@127.0.0.1:5433/<数据库名>
```

不要照抄占位符；只修改自己现有连接地址中需要调整的部分。可以检查端口是否有服务监听：

```bash
lsof -nP -iTCP:5433 -sTCP:LISTEN
```

### 2. 检查命令行依赖

状态保存和恢复依赖 PostgreSQL 客户端工具以及 `rg`（ripgrep）：

```bash
psql --version
pg_dump --version
pg_restore --version
rg --version
```

macOS 缺少 `rg` 时安装：

```bash
brew install ripgrep
```

安装后重新执行原来的 `pnpm state:load` 命令即可。

## 常见问题

### `command not found: rg`

恢复脚本需要 ripgrep。运行：

```bash
brew install ripgrep
rg --version
pnpm state:load -- c0-empty --yes
```

### 数据库连接被拒绝

先确认 `.env` 中的主机和端口，再确认 PostgreSQL 正在监听对应端口：

```bash
lsof -nP -iTCP:5433 -sTCP:LISTEN
```

如果应用直接运行在 macOS 上，可以使用 `127.0.0.1:5433`；如果应用运行在 Docker 容器中，容器里的 `127.0.0.1` 指向容器本身，需要改用容器可访问的数据库主机名。

### 提示状态已经存在

换一个新名称，或者确认确实要覆盖后添加 `--replace`：

```bash
pnpm state:save -- before-import --replace
```

### 提示存在活跃解析任务

优先暂停 Parser、worker 和相关开发进程，再重试。保存时确实接受只记录已持久化内容，才使用 `--allow-active`；加载时不能绕过该检查。

### 状态校验失败

不要继续加载该状态。校验失败说明 `database.dump` 或文件内容与 `manifest.json` 不一致，应改用另一个状态或从可信备份恢复该状态目录。

## 状态保存位置

默认目录结构如下：

```text
.sydaris-states/
└── c0-empty/
    ├── database.dump
    ├── database.dump.sha256
    ├── manifest.json
    └── files/
        ├── library/
        └── cold-start/
```

可以通过环境变量 `SYDARIS_STATE_STORAGE_ROOT` 改变状态仓库位置。Library 和解析产物目录分别可通过 `SYDARIS_LIBRARY_STORAGE_ROOT` 与 `SYDARIS_COLD_START_OUTPUT_ROOT` 配置。

## 命令速查

| 目的 | 命令 |
| --- | --- |
| 查看状态 | `pnpm state:list` |
| 校验状态 | `pnpm state:verify -- <名称>` |
| 保存新状态 | `pnpm state:save -- <名称>` |
| 覆盖同名状态 | `pnpm state:save -- <名称> --replace` |
| 活跃任务期间尽力保存 | `pnpm state:save -- <名称> --allow-active` |
| 加载状态 | `pnpm state:load -- <名称> --yes` |
| 加载干净基线 | `pnpm state:load -- c0-empty --yes` |

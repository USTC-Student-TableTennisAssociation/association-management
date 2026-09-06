# Sydaris 隔离实例指南

隔离实例用于让长时间 Library 解析在后台持续运行，同时让主实例在 3000 端口加载其他状态、使用
另一套模型 API 做交互测试。两个实例共享同一份源代码，但使用各自的数据库、Library 目录、
cold-start 产物目录和 Next build 目录。后台构建不会改写 3000 端口正在使用的 `.next`。

## 1. 创建解析实例环境

当前主 `.env` 仍配置为学校 API 时，可以把其中的模型、MinerU、限速与 embedding 配置安全地
固化为解析实例覆盖文件：

```bash
pnpm instance:init -- parsing --database echo_parsing
```

该命令不会创建数据库，也不会打印 API Key；它会生成权限为 `0600` 的 `.env.parsing`。以后主
`.env` 改成 DeepSeek 官方 API，不会影响已经固化的解析实例。

`.env.parsing` 至少必须显式配置：

```dotenv
# 使用独立数据库；不能与主 .env 指向同一个数据库/schema。
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/association_management_parsing

# 使用独立绝对目录。
SYDARIS_LIBRARY_STORAGE_ROOT=/absolute/path/to/sydaris-parsing/library
SYDARIS_COLD_START_OUTPUT_ROOT=/absolute/path/to/sydaris-parsing/cold-start
SYDARIS_NEXT_DIST_DIR=.next-parsing

# 解析实例使用学校模型 API。
AI_API_BASE_URL=https://api.llm.ustc.edu.cn/v1
AI_API_KEY=
AI_MODEL=
AI_THINKING_MODE=enabled
AI_STRUCTURED_OUTPUT_MODE=json_object

# MinerU 使用学校 API；Key 留空时复用 AI_API_KEY。
COLD_START_MINERU_PROVIDER=api
MINERU_MODEL=mineru
MINERU_API_KEY=
MINERU_API_BASE_URL=https://api.llm.ustc.edu.cn/v1
```

`.env.parsing` 已被 `.gitignore` 的 `.env*` 规则排除，不会提交 API Key。

创建 `.env.parsing` 中指定的独立数据库：

```bash
pnpm instance:db:create -- parsing
```

随后可把共享状态仓库里的基线恢复到解析实例（快照本身包含数据库结构，不需要先执行 migration）：

```bash
pnpm instance:state -- parsing load c0-empty --yes
```

这条命令读取 `.env.parsing`，只覆盖解析实例数据库及其两个运行目录，不会修改主实例。

## 2. 后台启动解析实例

为解析实例单独完成 production build；产物写入 `.next-parsing`，不会触碰主实例的 `.next`：

```bash
pnpm instance:build -- parsing
```

在 3001 端口后台启动，并阻止 macOS 自动睡眠：

```bash
pnpm instance:start -- parsing --port 3001 --background --caffeinate
```

打开 `http://localhost:3001`，在该实例中导入或恢复资料并启动编译。任务由 3001 进程持有，即使关闭
浏览器页面也会继续；不要结束该实例进程，也不要在它运行时重新执行
`pnpm instance:build -- parsing`。

查看实例和日志位置：

```bash
pnpm instance:status -- parsing
tail -f .sydaris-instances/parsing/server.log
```

停止实例会先发送 `SIGTERM`，不会自动使用强制终止：

```bash
pnpm instance:stop -- parsing
```

## 3. 同时使用主实例

主实例继续读取 `.env`，可以配置 DeepSeek 官方 API 并运行在 3000 端口：

```bash
pnpm start
```

由于两边使用不同数据库和文件目录，此时主实例可以安全执行：

```bash
pnpm state:load -- <另一个状态> --yes
```

它不会暂停、覆盖或回滚后台解析实例。共享的是代码和命名状态仓库，不是实时数据库。

## 4. 保存后台解析结果

解析任务完成或暂停后，把解析实例保存成新快照：

```bash
pnpm instance:state -- parsing save after-pipeline-v2
pnpm instance:state -- parsing verify after-pipeline-v2
```

以后需要把结果切回主实例时，先停止主实例中的写入任务，再执行：

```bash
pnpm state:load -- after-pipeline-v2 --yes
```

不要让两个实例使用同一个 `DATABASE_URL` 或相同的运行目录；实例管理脚本会在启动和状态操作前
检查这些边界并拒绝危险配置。

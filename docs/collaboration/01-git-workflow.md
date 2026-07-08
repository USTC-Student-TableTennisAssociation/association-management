# Git 工作流

本文说明本项目日常协作中如何查看分支、新建分支、提交改动、推送代码和打开 Pull Request。所有协作者应按本文约定提交改动。

## 基本原则

* `main` 是默认稳定分支，对应可部署、可继续开发的版本。
* 所有功能、修复、样式和文档调整都应从最新的 `main` 新建分支。
* 不直接在 `main` 上开发或向 `main` 推送代码。
* 一个分支应只处理一个明确任务。
* 分支、commit 和 PR 说明应让其他维护者能够快速理解改动目的和影响范围。
* PR 合并后，应及时删除已经完成的临时分支。

## 常用概念

### branch

branch 是分支，用于隔离未完成的改动。每个任务应在独立分支完成，并通过 PR 合并回 `main`。

### commit

commit 是一次提交记录，用于保存一组相关改动。每个 commit 应只表达一个清晰目的。

示例：

* 新增活动状态记录入口。
* 调整知识条目列表的移动端样式。
* 增加 Git 工作流说明。

### Pull Request

Pull Request，简称 PR，用于请求将一个分支的改动合并到目标分支。

PR Review 用于确认改动是否清晰、可维护、可安全合并。PR 说明和讨论记录也是后续维护时的重要上下文。

## 标准工作流程

一般改动应按以下流程进行：

1. 查看当前分支和工作区状态。
2. 切换到 `main` 分支并同步最新代码。
3. 从 `main` 新建工作分支。
4. 在工作分支上修改代码或文档。
5. 查看本地改动。
6. 运行必要检查。
7. 提交 commit。
8. 推送分支到 GitHub。
9. 打开 Pull Request。
10. 根据 Review 意见继续修改。
11. 检查通过后合并。
12. 合并后清理临时分支。

## 查看分支和状态

查看当前所在分支：

```bash
git branch --show-current
```

查看当前工作区状态：

```bash
git status -sb
```

查看本地分支：

```bash
git branch
```

查看本地和远程分支：

```bash
git branch -a
```

查看本地分支与远程分支的对应关系：

```bash
git branch -vv
```

常见输出示例：

```text
* main
  remotes/origin/HEAD -> origin/main
  remotes/origin/main
```

其中：

* `* main` 表示当前在本地 `main` 分支。
* `origin/main` 表示 GitHub 远程仓库中的 `main` 分支在本地的记录。
* `origin/HEAD -> origin/main` 表示远程仓库的默认分支是 `main`。

如果 `git status -sb` 显示有未提交改动，应先确认这些改动是否属于当前任务。不要在不了解改动来源的情况下直接覆盖或丢弃。

## 从 main 新建工作分支

新任务应从最新的 `main` 开始。

```bash
git switch main
git pull origin main
```

其中：

* `git switch main`：切换到本地 `main` 分支。
* `git pull origin main`：从远程仓库 `origin` 的 `main` 分支拉取最新代码。

然后新建工作分支：

```bash
git switch -c feat/activity-state-board
```

其中：

* `-c` 表示创建新分支。
* `feat/activity-state-board` 是新分支名。

分支名应符合下方“分支命名规范”。

## 查看、验证和提交改动

完成代码或文档修改后，查看改动范围：

```bash
git status -sb
```

查看具体内容差异：

```bash
git diff
```

也可以使用 VS Code 的 Source Control 面板查看文件改动和具体差异。

普通代码改动建议运行：

```bash
pnpm lint
```

如果改动影响页面渲染、依赖、构建配置、数据结构或核心交互，建议再运行：

```bash
pnpm build
```

确认改动范围正确后，提交本次任务相关文件：

```bash
git add src/app/page.tsx
git commit -m "feat: 新增活动状态概览"
```

文档改动示例：

```bash
git add CONTRIBUTING.md docs/collaboration/01-git-workflow.md
git commit -m "docs: 更新项目协作说明"
```

其中：

* `git add`：把文件加入本次提交。
* `git commit -m "..."`：创建提交记录。`-m` 是 `--message` 的缩写，后面的引号内容是本次提交说明。

如果使用 VS Code，也可以在 Source Control 面板中完成暂存和提交。

不要把无关改动一起提交。

## 推送分支到 GitHub

本地新建的分支一开始只存在于自己的电脑上。推送分支就是把这个分支和其中的 commit 上传到 GitHub，这样才能在 GitHub 页面打开 Pull Request。

第一次推送新分支时：

```bash
git push -u origin feat/activity-state-board
```

其中：

* `git push`：把本地提交推送到远程仓库。
* `-u`：设置本地分支与远程分支的跟踪关系。设置后，之后在同一分支上可以直接使用 `git push`。
* `origin`：远程仓库名称，通常就是 GitHub 上的仓库。
* `feat/activity-state-board`：要推送的分支名。远程仓库中会创建同名分支。

设置跟踪关系后，Git 会记住：

```text
本地 feat/activity-state-board 分支
对应远程 origin/feat/activity-state-board 分支
```

后续继续在同一分支提交时，通常只需要：

```bash
git push
```

如果使用 VS Code，也可以点击 Source Control 面板中的 `Publish Branch`。它通常等价于第一次推送当前分支，并建立本地分支和远程分支的跟踪关系。

## 打开 Pull Request

推送分支后，到 GitHub 仓库页面打开 Pull Request。

常见方式：

1. 推送分支后，GitHub 仓库页面通常会出现 `Compare & pull request` 按钮。
2. 如果没有出现，可以进入仓库的 `Pull requests` 页面，点击 `New pull request`。
3. 目标分支选择 `main`，来源分支选择自己的工作分支。

方向应为：

```text
feat/activity-state-board -> main
```

含义是：

```text
请求把 feat/activity-state-board 分支的改动合并到 main 分支。
```

PR 标题应简短说明改动内容，描述应按 [PR 与 Review 规范](02-pr-and-review.md) 填写。

## 根据 Review 修改

如果 PR 收到 Review 意见，应在同一个工作分支继续修改、提交并推送。

```bash
git status -sb
git add src/app/page.tsx
git commit -m "fix: 补充空状态展示"
git push
```

新的 commit 会自动出现在原 PR 中，不需要重新打开 PR。

commit 信息应说明具体修改内容，不建议写成：

```text
fix: 修复 Review 中指出的问题
```

应改为更具体的说明，例如：

```text
docs: 补充分支查看命令说明
fix: 补充活动列表空状态
style: 调整知识条目卡片间距
```

## PR 合并后的清理

PR 合并后，回到本地 `main` 并同步远程最新代码：

```bash
git switch main
git pull origin main
```

删除已经合并的本地临时分支：

```bash
git branch -d feat/activity-state-board
```

如果 GitHub 页面没有自动删除远程分支，可以手动删除：

```bash
git push origin --delete feat/activity-state-board
```

删除分支不会删除已经合并进 `main` 的代码。它只是清理已经完成的临时工作分支。

## 分支命名规范

分支名应使用英文小写，使用 `/` 分组，使用 `-` 连接单词。

格式：

```text
类型/简短说明
```

常用类型：

| 类型        | 适用场景                   | 示例                         |
| ----------- | -------------------------- | ---------------------------- |
| `feat/`     | 新功能                     | `feat/activity-state-board`  |
| `fix/`      | 修复问题                   | `fix/chat-input-submit`      |
| `docs/`     | 文档修改                   | `docs/update-collaboration`  |
| `style/`    | 样式或展示调整             | `style/knowledge-list`       |
| `refactor/` | 重构，不改变功能           | `refactor/memory-entry-form` |
| `chore/`    | 工具、依赖、配置等维护工作 | `chore/update-dependencies`  |
| `hotfix/`   | 紧急线上修复               | `hotfix/build-config`        |

无法准确归类时，应选择最接近的类型，并在 PR 说明中补充背景。

## commit 信息规范

commit 信息应使用中文说明改动内容，类型前缀保留英文。

格式：

```text
类型: 中文说明
```

常用类型：

| 类型       | 含义     | 示例                              |
| ---------- | -------- | --------------------------------- |
| `feat`     | 新功能   | `feat: 新增活动状态概览`          |
| `fix`      | 修复 bug | `fix: 修复聊天输入无法提交的问题` |
| `docs`     | 文档     | `docs: 更新 Git 工作流说明`       |
| `style`    | 样式调整 | `style: 调整知识条目移动端间距`   |
| `refactor` | 重构     | `refactor: 简化记忆条目表单逻辑`  |
| `chore`    | 杂项维护 | `chore: 更新项目依赖`             |
| `test`     | 测试     | `test: 增加活动状态逻辑测试`      |

提交信息应具体说明改动内容。不得使用无法说明改动内容的提交信息，例如：

```text
update
fix
改一下
临时提交
不知道
```

如果需要临时保存未完成工作，可以使用 `wip` 前缀：

```text
wip: 调整活动详情页
```

包含 `wip` 的提交不应作为最终状态合并。合并前应补充完成对应改动，或在 PR 中说明保留原因。

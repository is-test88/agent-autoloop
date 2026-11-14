# 本机 agent-autoloop 升级

日常使用 `agent-autoloop update`。命令会从官方仓库取最新正式标签，在隔离目录复用当前安装相对标签的全部本地 Git 改动和未忽略的新增文件。补丁冲突会中止。用 `agent-autoloop update --check` 可以只验证，不切换服务。命令入口保存在这个目录，与 app 分开。

验证项目在 `verify.py`。给自定义任务增加新行为时，把它的回归测试加入对应项。生产规则与插件使用当前配置，飞书发卡与回调使用模拟 CLI，247 通过现有邮箱只读查找并验签最近一份应到回执。无需再登录 247。升级不运行真实业务任务，也不会开第二个飞书监听。

候选通过后，脚本检查服务空闲，备份旧安装、原始补丁和 SQLite 状态，切换并校验后台版本、Agent、通道和定时显示。启动或检查报错时恢复原 app 并校验原服务。状态备份仅供需要时单独恢复，自动回滚不覆盖中台日志或业务状态。备份位于 `~/.agent-autoloop/backups/local-upgrade-*`，其中 state 含本机密钥。

## 升级演练

运行 `agent-autoloop update --drill`。当本机已是最新正式版时，优先选用最近的旧版安装备份；没有旧备份时用同版本副本演练。两轮都会运行升级验证，第一轮正常切换，第二轮确认候选服务启动后注入失败并检查回滚。演练使用临时安装、独立数据库、回环端口和 launchd 标识，结束时清理，并核对生产服务 PID、版本和配置。

## 换 Mac 恢复

需要 macOS、Git、Node.js 24+ 和 Python 3.10+，并让 `~/.local/bin` 位于 PATH。以下以干净的官方 v1.8.4 为起点。在新 Mac 准备好独立迁移的配置和插件之前，先保持服务关闭。

```sh
git clone --branch codex/local-upgrade-kit https://github.com/is-test88/agent-autoloop.git agent-autoloop-kit
mkdir -p ~/.agent-autoloop
chmod 700 ~/.agent-autoloop
git clone --depth 1 --branch v1.8.4 https://github.com/KKKKhazix/agent-autoloop.git ~/.agent-autoloop/app
python3 -B agent-autoloop-kit/local-upgrade/restore.py
agent-autoloop --help
```

恢复程序校验官方基底和文件冲突，应用 `v1.8.4-local.patch`，并安装独立的命令入口与 Skill 说明。若已有 app 或升级目录，先在备份中保留现有内容，再用干净目录恢复。恢复程序不启动后台服务。

本仓库只存程序、补丁和说明。另从可信备份恢复 `config.json`、`rules.json`、所需密钥及状态，以及 `plugins/`、`jobs/`、`gitea-review/`、`delivery-shared-source/`、`meishi-review/`、`org-optimization/` 和 `ssc-weekly/`。检查规则和任务脚本中的绝对路径与新机一致，恢复飞书、HR CLI 邮箱和 Codex 所需的授权及依赖。需要历史状态时，使用原机的 `agent-autoloop backup` 与新机的 `agent-autoloop restore`，保护好离线备份。进行实际切换前运行 `agent-autoloop update --check`。服务接通后可运行 `agent-autoloop update --drill` 演练。

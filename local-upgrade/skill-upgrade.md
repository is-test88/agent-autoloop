## 本机升级

在这台 Mac 上，从 PATH 运行以下命令。升级入口独立于 app 安装目录，换版时会把本节写入候选版 Skill 并验证帮助输出。

- `agent-autoloop update` 用于正式升级。先移植本地补丁并验证，通过后才切换服务。切换失败会自动回滚。
- `agent-autoloop update --check` 用于先确认新版本兼容本地补丁、规则和插件。只验证候选版，生产服务继续运行。
- `agent-autoloop update --drill` 用于验证升级全过程。用独立端口、数据库和服务实例分别演练正常切换、故障回滚，生产服务继续运行。

### Fork 提交流程

我们自己的改动直接提交并推送到 `is-test88/agent-autoloop` 的 `main`，不为这些改动创建独立分支或向上游开 PR。已关闭的上游 PR #295 保持关闭。

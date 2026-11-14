printf '%s\n' '' '本机升级' \
  '  agent-autoloop update          正式升级，移植本地补丁并验证后切换，切换失败自动回滚。' \
  '  agent-autoloop update --check  想先确认补丁兼容和自定义检查时用，当前服务继续运行。' \
  '  agent-autoloop update --drill  想验证正常切换和故障回滚时用，在隔离服务上跑两轮。'

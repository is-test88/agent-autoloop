"""Read-only and isolated checks for the customizations on this Mac."""
from datetime import datetime
import json
import os
from pathlib import Path
import shutil
import sys

CHECKS = {
    '中文定时显示和组织优化': ('cron.test.ts', 'status-view.test.ts',
                           'status-org-schedule.test.ts', 'status-org-presence.test.ts'),
    'Gitea': ('gitea-review/poll.test.mjs',
              'delivery-shared-source/tests/delivery-gates.test.ts'),
    '美事': ('meishi-review/collect.test.mjs', 'meishi-review/incremental.test.mjs',
           'meishi-review/notification.test.mjs', 'meishi-review/pipeline.test.mjs',
           'meishi-review/policy.test.mjs', 'meishi-review/review.test.mjs'),
    '组织优化': tuple('org-optimization/' + file + '.test.mjs' for file in (
        'gate', 'notification-runner', 'prereview-runner', 'rollup-runner', 'writeback-runner')),
    'SSC 周报': ('ssc-weekly/evidence.test.mjs',),
}


def install_upgrade_skill(app, here):
    path = app / 'skills/agent-autoloop/SKILL.md'
    original = path.read_text()
    section = (here / 'skill-upgrade.md').read_text().rstrip() + '\n\n'
    heading = section.splitlines()[0]
    start = original.find('\n' + heading + '\n')
    if start >= 0:
        end = original.find('\n## ', start + len(heading) + 2)
        original = original[:start + 1] + (original[end + 1:] if end >= 0 else '')
    anchor = '## 看情况、回答'
    if anchor not in original:
        raise RuntimeError('新版 Skill 的升级说明插入位置已变化')
    path.write_text(original.replace(anchor, section + anchor, 1))


def verify_candidate(app, home, here, node, cli, run):
    cli(app, 'check')
    install_upgrade_skill(app, here)
    skill = (app / 'skills/agent-autoloop/SKILL.md').read_text()
    help_text = run('/bin/sh', here / 'help-text.sh', capture=True).decode()
    for command in ('agent-autoloop update', 'agent-autoloop update --check', 'agent-autoloop update --drill'):
        if not any(line.strip().startswith(command + '  ') for line in help_text.splitlines()) or f'`{command}`' not in skill:
            raise RuntimeError(f'本地升级说明缺少 {command}')
    env = {**os.environ, 'AGENT_AUTOLOOP_HOME': str(app.parent),
           'AGENT_AUTOLOOP_RULES': str(app.parent / 'rules.json')}
    shutil.copytree(home / 'plugins', app.parent / 'plugins', symlinks=True)
    rules = json.loads((home / 'rules.json').read_text())
    config = json.loads((home / 'config.json').read_text())

    collector = rules['agents']['meishi-collector']['command']
    if len(collector) != 2 or Path(collector[1]) != home / 'meishi-review/collect.mjs':
        raise RuntimeError('美事监听没有使用本地 collect.mjs')
    run(*collector, '--check-bridge', env=env)

    run(node, '--test', app / 'tests/gitea-history.test.mjs', app / 'tests/gitea-reviewer.test.mjs', env=env)

    for section, files in CHECKS.items():
        print(f'验证 {section}', flush=True)
        root = app / 'tests' if section.startswith('中文') else home
        run(node, '--test', *(root / name for name in files), env=env)
    python = json.loads((home / 'meishi-review/settings.json').read_text())['python']
    run(python, home / 'meishi-review/extract.test.py',
        env={**env, 'PYTHONDONTWRITEBYTECODE': '1'})

    # Run the existing Feishu interaction tests against the actual installed override.
    channel_test = app / 'tests/channels.test.ts'
    temporary_test = app / 'tests/local-feishu.upgrade.test.ts'
    source = channel_test.read_text()
    old = '"../plugins/feishu/channel.ts"'
    if old not in source:
        raise RuntimeError('飞书测试入口已变化，需要移植验证')
    # The local override has its own card layout, so select the interaction tests it shares.
    temporary_test.write_text(source.replace(old, '"../../plugins/feishu/channel.ts"'))
    try:
        run(node, '--test', '--test-name-pattern=handling note|text form|closed card retries', temporary_test, env=env)
    finally:
        temporary_test.unlink()

    metadata = app.parent / 'local-check.json'
    metadata.write_text(json.dumps({'agents': list(rules['agents'].values()),
                                    'channels': [entry.get('use', name) for name, entry in rules['channels'].items()],
                                    'configChannels': list(config['channels'])}))
    shutil.copyfile(here / 'plugins-check.mjs', app.parent / 'plugins-check.mjs')
    run(node, app.parent / 'plugins-check.mjs', env=env)
    # Exercise duplicate delivery against the candidate hub, never the installed engine.
    hub_test = app.parent / 'collector-upgrade.test.mjs'
    original = (home / 'meishi-review/collector-hub.test.mjs').read_text()
    old_engine = str(home / 'app/bin/agent-autoloop.ts')
    if old_engine not in original:
        raise RuntimeError('美事中台测试入口已变化，需要移植验证')
    hub_test.write_text(original.replace(old_engine, str(app / 'bin/agent-autoloop.ts')))
    run(node, '--test', hub_test, env={key: value for key, value in env.items() if key != 'AGENT_AUTOLOOP_RULES'})
    run(sys.executable, '-B', here / 'receipt-check.py', home)
    assert rules['timezone'] == 'Asia/Shanghai'
    watch, = [rule for rule in rules['rules'] if rule['to'] == 'onepanel-watch']
    assert watch['when']['cron'] == '40 10 * * *'
    assert watch['channels'] == ['feishu'] and watch.get('tell') != 'never'
    assert 'cron.anomaly' in watch['emits']['types']
    assert any(rule['to'] == 'onepanel-diagnose' and 'cron.anomaly' in rule['when'].get('types', [])
               for rule in rules['rules'])

"""Run the real upgrade transaction twice against disposable launchd services."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import urllib.request


class InjectedFailure(RuntimeError):
    pass


def fingerprint(updater, home, service):
    launch = updater.run('launchctl', 'print', service, capture=True).decode()
    pid = next(line.strip() for line in launch.splitlines() if line.strip().startswith('pid = '))
    url = json.loads((home / 'config.json').read_text())['url']
    with urllib.request.urlopen(url.rstrip('/') + '/healthz', timeout=5) as response:
        health = json.load(response)
    return pid, health, updater.config_digest()


def installed_tag(updater, app):
    return updater.git(app, 'describe', '--tags', '--exact-match', 'HEAD').decode().strip()


def rehearse(updater, tag):
    prod, app, service = updater.HOME, updater.APP, updater.SERVICE
    current = installed_tag(updater, app)
    source = app
    if current == tag:
        # Same-release rehearsal still needs a real older checkout to exercise the upgrade.
        for candidate in sorted((prod / 'backups').glob('*/app'), reverse=True):
            try:
                previous = installed_tag(updater, candidate)
                if tuple(map(int, previous[1:].split('.'))) < tuple(map(int, tag[1:].split('.'))):
                    source = candidate
                    break
            except (subprocess.CalledProcessError, ValueError):
                continue
        else:
            print('没有旧版备份，本次使用同版本的隔离副本演练切换与回滚。', flush=True)
    before = fingerprint(updater, prod, service)
    print(f'隔离演练 {installed_tag(updater, source)} → {tag}', flush=True)
    try:
        with tempfile.TemporaryDirectory(prefix='autoloop-upgrade-drill-') as folder:
            root = Path(folder).resolve()
            exercise(updater, root / 'success', source, prod, service, tag, fail=False)
            exercise(updater, root / 'rollback', source, prod, service, tag, fail=True)
    finally:
        if fingerprint(updater, prod, service) != before:
            raise RuntimeError('演练期间检测到生产服务 PID、版本或配置变化')
        print('生产服务 PID、健康版本及配置校验值一致。', flush=True)


def verify_help_and_skill(updater, home, phase):
    env = {**os.environ, 'HOME': str(home.parent)}
    for key in ('AGENT_AUTOLOOP_HOME', 'AGENT_AUTOLOOP_RULES'):
        env.pop(key, None)
    help_text = updater.run(home / 'local-upgrade/agent-autoloop', '--help', env=env, capture=True).decode()
    heading, section = help_text.rsplit('\n本机升级\n', 1)
    assert heading and str(home / 'rules.json') in heading, '帮助输出没有使用隔离安装'
    expected_rows = updater.run('/bin/sh', updater.HERE / 'help-text.sh', capture=True).decode().splitlines()[2:]
    assert len(expected_rows) == 3 and section.splitlines() == expected_rows, '帮助缺少升级命令或说明'
    skill = (home / 'app/skills/agent-autoloop/SKILL.md').read_text()
    expected_skill = (updater.HERE / 'skill-upgrade.md').read_text().strip()
    assert skill.count(expected_skill) == 1, 'Skill 的升级说明缺失或重复'
    print(f'{phase}：--help 和 Skill 中的三条升级说明均已核对。', flush=True)


def exercise(updater, home, source, prod, production_service, tag, *, fail):
    from verify import install_upgrade_skill, verify_candidate

    home = home / '.agent-autoloop'
    home.mkdir(mode=0o700, parents=True)
    (home / 'backups').mkdir()
    app = home / 'app'
    shutil.copytree(source, app, symlinks=True, ignore=shutil.ignore_patterns('node_modules'))
    local = home / 'local-upgrade'
    local.mkdir(mode=0o700)
    for name in ('agent-autoloop', 'help-text.sh'):
        shutil.copy2(updater.HERE / name, local / name)
    # Older backups predate the help section. Seed only the isolated old installation.
    install_upgrade_skill(app, updater.HERE)
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    label = 'agent-autoloop-' + hashlib.sha256(str(home).encode()).hexdigest()[:8]
    isolated_service = production_service.rsplit('/', 1)[0] + '/' + label
    assert isolated_service != production_service and not home.is_relative_to(prod)
    if subprocess.run(['launchctl', 'print', isolated_service], capture_output=True).returncode == 0:
        raise RuntimeError('隔离服务标识已被占用')
    saved = updater.HOME, updater.APP, updater.SERVICE, updater.validate
    updater.HOME, updater.APP, updater.SERVICE = home, app, isolated_service
    updater.validate = lambda stage: verify_candidate(
        stage, prod, updater.HERE, updater.NODE,
        lambda candidate, *args: updater.cli(candidate, *args, home=prod), updater.run,
    )
    original = updater.git(app, 'rev-parse', 'HEAD')
    patch = updater.git(app, 'diff', '--binary', 'HEAD')
    seen = []

    def checked(expected):
        assert updater.git(app, 'rev-parse', 'HEAD').decode().strip() == expected
        assert '每 10 分钟' in updater.cli(app, 'status', capture=True).decode()
        verify_help_and_skill(updater, home, '新版启动后')
        seen.append(expected)
        if fail:
            raise InjectedFailure('新版已启动，故意使切换后检查失败')

    try:
        updater.cli(app, 'init', '--no-service', '--command', 'echo drill', '--port', str(port))
        config_file = home / 'config.json'
        config = json.loads(config_file.read_text())
        config.pop('channels', None)
        config_file.write_text(json.dumps(config))
        rules_file = home / 'rules.json'
        rules = json.loads(rules_file.read_text())
        rules['channels'] = {}
        rules['rules'] = [{'name': '隔离演练定时', 'when': {'cron': '*/10 * * * *'},
                           'to': next(iter(rules['agents'])), 'cwd': str(home), 'tell': 'never'}]
        rules_file.write_text(json.dumps(rules))
        updater.cli(app, 'service', 'install')
        verify_help_and_skill(updater, home, '切换前')
        try:
            updater.upgrade(tag, after_switch=checked)
        except InjectedFailure:
            assert fail and seen
            assert updater.git(app, 'rev-parse', 'HEAD') == original
            assert updater.git(app, 'diff', '--binary', 'HEAD') == patch
            verify_help_and_skill(updater, home, '旧版恢复后')
            print(f'回滚通过：新版 {seen[0][:12]} 已启动，故障后旧版 {original.decode()[:12]} 已恢复。', flush=True)
        else:
            assert not fail and seen and installed_tag(updater, app) == tag
            print(f'正常切换通过：{tag} {seen[0][:12]}，中文定时显示有效。', flush=True)
        backup, = (home / 'backups').glob('local-upgrade-*')
        assert (backup / 'local.patch').read_bytes() == patch
        assert (backup / 'state/hub.db').is_file()
    finally:
        try:
            if subprocess.run(['launchctl', 'print', isolated_service], capture_output=True).returncode == 0:
                updater.cli(app, 'service', 'remove')
            if subprocess.run(['launchctl', 'print', isolated_service], capture_output=True).returncode == 0:
                raise RuntimeError(f'隔离服务尚未清理：{isolated_service}')
        finally:
            updater.HOME, updater.APP, updater.SERVICE, updater.validate = saved

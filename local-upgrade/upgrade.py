#!/usr/bin/env python3
"""Stage a tagged release, validate local customizations, then switch the Mac service."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

HOME = Path.home() / '.agent-autoloop'
APP = HOME / 'app'
UPSTREAM = 'https://github.com/KKKKhazix/agent-autoloop.git'
SERVICE = f'gui/{os.getuid()}/agent-autoloop'
HERE = Path(__file__).resolve().parent
NODE = shutil.which('node') or '/opt/homebrew/bin/node'


def run(*args, cwd=None, capture=False, env=None, timeout=240):
    return subprocess.run(args, cwd=cwd, env=env, check=True,
                          stdout=subprocess.PIPE if capture else None, timeout=timeout).stdout


def git(app, *args):
    return run('git', '-C', app, *args, capture=True)


def cli(app, *args, home=None, capture=False):
    home = HOME if home is None else home
    env = {**os.environ, 'AGENT_AUTOLOOP_HOME': str(home),
           'AGENT_AUTOLOOP_RULES': str(home / 'rules.json')}
    return run(NODE, app / 'bin/agent-autoloop.ts', *args, env=env, capture=capture, timeout=90)


def release():
    refs = run('git', 'ls-remote', '--refs', '--tags', UPSTREAM, 'v*', capture=True).decode()
    tags = re.findall(r'refs/tags/(v(\d+)\.(\d+)\.(\d+))$', refs, re.M)
    return max(tags, key=lambda tag: tuple(map(int, tag[1:])))[0]


def overlay(app, stage):
    patch = git(app, 'diff', '--binary', 'HEAD')
    backup = stage.parent / 'local.patch'
    backup.write_bytes(patch)
    # Apply the complete local change, including staged edits. Reverse-check allows an already upstream change.
    if patch:
        # A shallow release clone only has its own blobs; import the old base for three-way application.
        git(stage, 'fetch', '--quiet', '--depth=1', str(app), git(app, 'rev-parse', 'HEAD').decode().strip())
        for path in git(app, 'diff', '--name-only', '-z', 'HEAD').decode().split('\0'):
            if not path:
                continue
            one = stage.parent / 'file.patch'
            one.write_bytes(git(app, 'diff', '--binary', 'HEAD', '--', path))
            reverse = subprocess.run(['git', '-C', stage, 'apply', '--reverse', '--check', one],
                                     capture_output=True, check=False)
            if reverse.returncode:
                run('git', '-C', stage, 'apply', '--3way', one)
    for entry in git(app, 'ls-files', '--others', '--exclude-standard', '-z').decode().split('\0'):
        if not entry:
            continue
        dest = stage / entry
        if dest.exists() or dest.is_symlink():
            if not dest.is_file() or dest.read_bytes() != (app / entry).read_bytes():
                raise RuntimeError(f'新版和本地新增文件重名：{entry}')
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(app / entry, dest, follow_symlinks=False)
    git(stage, 'diff', '--check', 'HEAD')


def config_digest():
    return {name: hashlib.sha256((HOME / name).read_bytes()).hexdigest()
            for name in ('config.json', 'rules.json')}


def state(app):
    return json.loads(cli(app, 'status', '--json', capture=True))


def verify_live(app, expected, baseline, local_display=True):
    url = json.loads((HOME / 'config.json').read_text())['url']
    for _ in range(30):
        try:
            with urllib.request.urlopen(url.rstrip('/') + '/healthz', timeout=2) as response:
                health = json.load(response)
            current = state(app)
            online = lambda data, key: {item['name'] for item in data[key] if item['online']}
            if (health.get('ok') is True and health.get('commit') == expected
                and all(online(baseline, key) <= online(current, key) for key in ('agents', 'channels'))):
                cli(app, 'doctor')
                if not local_display:
                    return
                display = cli(app, 'status', capture=True).decode()
                for label in ('每 10 分钟', '每小时整点', '每天 10:40', '含调休', '组织优化每日流程'):
                    if label not in display:
                        raise RuntimeError(f'状态缺少本地显示：{label}')
                return
        except (OSError, subprocess.CalledProcessError, ValueError):
            pass
        time.sleep(1)
    raise RuntimeError('候选服务的版本、Agent 或通道未恢复')


def switch(stage, backup, stop, start, verify, verify_rollback):
    saved = backup / 'app'
    stop()
    try:
        APP.rename(saved)
        stage.rename(APP)
        start()
        verify()
    except BaseException:
        if saved.exists():
            stop()
            if APP.exists():
                APP.rename(stage)
            saved.rename(APP)
        start()
        verify_rollback()
        print('已恢复并启动原安装。', file=sys.stderr)
        raise


def stop_service():
    run('launchctl', 'bootout', SERVICE)
    for _ in range(100):
        if subprocess.run(['launchctl', 'print', SERVICE], capture_output=True).returncode:
            return
        time.sleep(0.1)
    raise RuntimeError('原服务未退出')


def main():
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--drill', action='store_true', help='在独立服务上演练切换和回滚')
    mode.add_argument('--check', action='store_true', help='验证最新版本，保留当前服务')
    args = parser.parse_args()
    with (HERE / 'upgrade.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        tag = release()
        if args.drill:
            from drill import rehearse
            rehearse(sys.modules[__name__], tag)
        else:
            upgrade(tag, check=args.check)


def upgrade(tag, *, check=False, after_switch=None):
    print(f'验证正式版 {tag} 与本地改动。', flush=True)
    with tempfile.TemporaryDirectory(prefix='.upgrade-', dir=HOME) as folder:
        stage = Path(folder) / 'app'
        run('git', 'clone', '--quiet', '--depth=1', '--branch', tag, UPSTREAM, stage)
        previous = git(APP, 'rev-parse', 'HEAD').decode().strip()
        expected = git(stage, 'rev-parse', 'HEAD').decode().strip()
        digest = config_digest()
        overlay(APP, stage)
        validate(stage)
        if digest != config_digest():
            raise RuntimeError('验证期间本机配置有变化，请重试')
        if check or (previous == expected and after_switch is None):
            print(f'{tag} 及本地改动验证通过，当前服务继续运行。')
            return
        baseline = state(APP)
        if baseline['totals']['running'] or baseline['totals']['queued']:
            raise RuntimeError('有正在执行或排队的任务，请空闲后重试')
        backup = HOME / 'backups' / time.strftime('local-upgrade-%Y%m%d-%H%M%S')
        backup.mkdir(mode=0o700)
        shutil.copy2(Path(folder) / 'local.patch', backup)
        cli(APP, 'backup', str(backup / 'state'))
        if digest != config_digest():
            raise RuntimeError('备份期间本机配置有变化，请重试')
        def verify():
            if digest != config_digest():
                raise RuntimeError('切换期间本机配置有变化')
            verify_live(APP, expected, baseline, local_display=after_switch is None)
            if after_switch is not None:
                after_switch(expected)
        def stop():
            if subprocess.run(['launchctl', 'print', SERVICE], capture_output=True).returncode == 0:
                stop_service()
        baseline = state(APP)
        if baseline['totals']['running'] or baseline['totals']['queued']:
            raise RuntimeError('备份期间有新任务，等服务空闲后重试')
        switch(stage, backup, stop, lambda: cli(APP, 'service', 'install'), verify,
               lambda: verify_live(APP, previous, baseline, local_display=False))
        cli(APP, '--version')
        print(f'升级和验证完成。原安装保存在 {backup}')

def validate(stage):
    from verify import verify_candidate
    verify_candidate(stage, HOME, HERE, NODE, cli, run)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'升级未完成：{error}', file=sys.stderr)
        sys.exit(1)

#!/usr/bin/env python3
"""Restore the upgrade tooling and its release-based patch on another Mac."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess

from verify import install_upgrade_skill

HERE = Path(__file__).resolve().parent
FILES = ('agent-autoloop', 'drill.py', 'help-text.sh', 'plugins-check.mjs',
         'receipt-check.py', 'skill-upgrade.md', 'upgrade.py', 'verify.py', 'README.md')
BASE = 'v1.8.4'
PATCH = HERE / f'{BASE}-local.patch'


def git(app, *args):
    return subprocess.run(('git', '-C', app, *args), check=True, capture_output=True).stdout.strip()


def restore(home, bin_dir):
    app = home / 'app'
    if git(app, 'rev-parse', 'HEAD') != git(app, 'rev-parse', f'{BASE}^{{commit}}'):
        raise RuntimeError(f'恢复补丁需要以官方 {BASE} 为基底')
    if git(app, 'status', '--porcelain'):
        raise RuntimeError('目标 app 有本地改动，请使用干净的安装目录')
    local = home / 'local-upgrade'
    wrapper = bin_dir / 'agent-autoloop'
    if local.exists() or local.is_symlink():
        raise RuntimeError('本地升级目录已存在')
    if os.path.lexists(wrapper) and (
        not wrapper.is_symlink() or wrapper.resolve() != (app / 'bin/agent-autoloop.ts').resolve()
    ):
        raise RuntimeError('命令入口已存在且指向其他程序')
    git(app, 'apply', '--check', PATCH)
    git(app, 'apply', '--index', PATCH)
    local.mkdir(mode=0o700)
    for filename in FILES:
        shutil.copy2(HERE / filename, local / filename)
    (local / 'agent-autoloop').chmod(0o700)
    install_upgrade_skill(app, local)
    bin_dir.mkdir(parents=True, exist_ok=True)
    temporary = bin_dir / f'.agent-autoloop-restore-{os.getpid()}'
    temporary.symlink_to(local / 'agent-autoloop')
    temporary.replace(wrapper)
    print(f'本地升级入口已恢复：{wrapper}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--mac-home', type=Path, default=Path.home(),
                        help='目标 macOS 用户目录，默认为当前用户')
    args = parser.parse_args()
    user_home = args.mac_home.resolve()
    if not user_home.is_dir():
        parser.error('目标用户目录不存在')
    restore(user_home / '.agent-autoloop', user_home / '.local/bin')

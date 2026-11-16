"""Install the Gitea adapter in an existing local Gitea workspace."""
import argparse
from hashlib import sha256
import json
from pathlib import Path
import shutil

HERE = Path(__file__).resolve().parent
START = '代码审查前先用指定 Skill'
END = '合并前保留已审状态文件'


def install(home, skill):
    root = home / 'gitea-review'
    entry = root / 'review-history.mjs'
    manual = root / 'AGENTS.md'
    original = manual.read_text()
    wrapper = (HERE / entry.name).read_text()
    if entry.read_text() == wrapper:
        return
    start, end = original.index(START), original.index(END)
    old_gate = home / 'delivery-shared-source/plugins/delivery/gates.ts'
    materials = [entry.read_text(), old_gate.read_text(), original, skill.read_text()]
    digest = sha256(json.dumps(materials, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
    memo = root / 'review-history-legacy-policy'
    if not (home / 'app/plugins/delivery/gitea-history.mjs').is_file():
        raise RuntimeError('请先安装带 Gitea 审查适配器的 app')
    backup = root / 'review-history-pre-v1.9.0'
    backup.mkdir(mode=0o700)
    for path in (entry, manual):
        shutil.copy2(path, backup / path.name)
    memo.touch(mode=0o600, exist_ok=False)
    memo.write_text(digest + '\n')
    updated = original[:start] + (HERE / 'dispatch.md').read_text().rstrip() + '\n\n' + original[end:]
    install_files = ((entry, wrapper), (manual, updated))
    for path, content in install_files:
        temp = path.with_suffix(path.suffix + '.new')
        with temp.open('x') as output:
            output.write(content)
        temp.replace(path)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--home', type=Path, default=Path.home() / '.agent-autoloop')
    parser.add_argument('--skill', type=Path, default=Path.home() / '.agents/skills/gitea-pr-review/SKILL.md')
    args = parser.parse_args()
    install(args.home, args.skill)

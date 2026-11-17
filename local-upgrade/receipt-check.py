"""Read the most recent due mailbox receipt without mutating the local cache."""
from datetime import datetime, timedelta
from pathlib import Path
import os
import runpy
import sys


def observation_clock(now):
    deadline = now.replace(hour=10, minute=40, second=0, microsecond=0)
    due = deadline if now >= deadline else deadline - timedelta(days=1)
    # Historical mail is checked inside the receiver's retry window.
    return due, min(now, due.replace(hour=14, minute=15))


def main(home):
    root = home / 'jobs/onepanel-monitor'
    sys.path.insert(0, str(root))
    os.environ.pop('AGENT_AUTOLOOP_CONTEXT', None)
    module = runpy.run_path(str(root / 'receive-receipt.py'))
    due, checked_at = observation_clock(datetime.now(module['SHANGHAI']))
    day = due.date().isoformat()
    snapshot = module['find_snapshot'](day, now=checked_at)
    assert snapshot, f'{day} 缺少有效签名回执'
    receipt = module['receipt']
    assert receipt(None, due - timedelta(minutes=1))[1] == {}
    missing = receipt(None, due)[1]
    assert missing['notice'] and missing['later'][0]['at'] == (due + timedelta(minutes=15)).isoformat()
    assert 'later' not in receipt(None, due.replace(hour=14, minute=15))[1]
    assert 'later' not in receipt(snapshot, checked_at)[1]
    print(f'247 {day} 真实邮件验签及超时复查规则通过。')


if __name__ == '__main__':
    main(Path(sys.argv[1]))

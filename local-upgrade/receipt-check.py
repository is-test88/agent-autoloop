"""Read the most recent due mailbox receipt without mutating the local cache."""
from datetime import datetime, timedelta
from pathlib import Path
import os
import runpy
import sys

root = Path(sys.argv[1]) / 'jobs/onepanel-monitor'
sys.path.insert(0, str(root))
os.environ.pop('AGENT_AUTOLOOP_CONTEXT', None)
module = runpy.run_path(str(root / 'receive-receipt.py'))
now = datetime.now(module['SHANGHAI'])
deadline = now.replace(hour=10, minute=40, second=0, microsecond=0)
day = (now.date() if now >= deadline else now.date() - timedelta(days=1)).isoformat()
snapshot = module['find_snapshot'](day)
assert snapshot, f'{day} 缺少有效签名回执'
receipt = module['receipt']
assert receipt(None, deadline - timedelta(minutes=1))[1] == {}
missing = receipt(None, deadline)[1]
assert missing['notice'] and missing['later'][0]['at'] == (deadline + timedelta(minutes=15)).isoformat()
assert 'later' not in receipt(None, deadline.replace(hour=14, minute=15))[1]
assert 'later' not in receipt(snapshot, deadline)[1]
print(f'247 {day} 真实邮件验签及超时复查规则通过。')

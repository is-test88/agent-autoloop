"""A historical receipt must use its own date and an in-window verification time."""
from datetime import datetime
from pathlib import Path
import runpy
import unittest
from zoneinfo import ZoneInfo

clock = runpy.run_path(str(Path(__file__).with_name('receipt-check.py')))['observation_clock']
ZONE = ZoneInfo('Asia/Shanghai')


class ReceiptClockTest(unittest.TestCase):
    def test_last_due_receipt_uses_its_own_valid_window(self):
        for hour, minute, expected_day, expected_time in (
            (10, 39, 16, (14, 15)),
            (10, 40, 17, (10, 40)),
            (18, 30, 17, (14, 15)),
        ):
            with self.subTest(hour=hour, minute=minute):
                now = datetime(2026, 11, 17, hour, minute, tzinfo=ZONE)
                due, checked_at = clock(now)
                self.assertEqual(due.day, expected_day)
                self.assertEqual(checked_at.date(), due.date())
                self.assertEqual((checked_at.hour, checked_at.minute), expected_time)

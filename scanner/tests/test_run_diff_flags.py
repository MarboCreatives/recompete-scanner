"""run_diff's two gate flags. M2-DESIGN 6.6: a failed drift check or a failed
self-test refuses the run.

Outside review, 18 September 2026: both flags defaulted to True, so a caller
that forgot one ran as if it had passed. And a truthy value is not a pass:
drift.main() returns 0 on a match and 1 on a difference, so a caller writing
drift_passed=drift.main() would hand over 1 exactly when drift failed. A caller
that forgets must get an error, and anything but a literal True must refuse.
"""

from __future__ import annotations

import unittest

import diff
from tests import invented
from tests.invented import TODAY, snapshot_row


def healthy():
    before = {f"aa-invented::PID-{n:04d}": snapshot_row(
        contract_key=f"aa-invented::PID-{n:04d}", reference=f"ZZ-TEST-{n:04d}")
        for n in range(10)}
    return before, list(before.values())


class TheGateFlags(unittest.TestCase):

    def test_a_caller_that_does_not_say_cannot_run(self):
        before, after = healthy()
        for passed in ({}, {"self_tests_passed": True}, {"drift_passed": True}):
            with self.subTest(passed=passed):
                with self.assertRaisesRegex(TypeError, "required keyword-only argument"):
                    diff.run_diff(before, {}, after, invented.published_of(after), TODAY,
                                  base_run=7, **passed)

    def test_only_a_literal_true_lets_the_run_through(self):
        before, after = healthy()
        for flag, want in (("drift_passed", diff.REFUSAL_DRIFT),
                           ("self_tests_passed", diff.REFUSAL_SELF_TEST)):
            for value in (1, 2, "yes", [0], None, 0):
                with self.subTest(flag=flag, value=value):
                    flags = {"self_tests_passed": True, "drift_passed": True, flag: value}
                    reason, events, _ = diff.run_diff(
                        before, {}, after, invented.published_of(after), TODAY,
                        base_run=7, **flags)
                    self.assertEqual(reason, want)
                    self.assertEqual(events, [])
        # The premise: with both a literal True, the same data runs.
        reason, _, _ = diff.run_diff(before, {}, after, invented.published_of(after), TODAY,
                                     self_tests_passed=True, drift_passed=True, base_run=7)
        self.assertIsNone(reason)


if __name__ == "__main__":
    unittest.main()

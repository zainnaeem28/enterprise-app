import datetime
import unittest

import backup_lag

NOW = datetime.datetime(2026, 11, 9, 12, 0, tzinfo=datetime.timezone.utc)


class Rds:
    def __init__(self, backups=None, boom=False):
        self.backups, self.boom = backups or [], boom

    def describe_db_instance_automated_backups(self, **kw):
        if self.boom:
            raise RuntimeError("denied")
        return {"DBInstanceAutomatedBackups": self.backups}


class Cw:
    def __init__(self):
        self.calls = []

    def put_metric_data(self, **kw):
        self.calls.append(kw)


class BackupLag(unittest.TestCase):
    def test_lag_is_now_minus_latest_time(self):
        t = NOW - datetime.timedelta(seconds=240)
        cw = Cw()
        out = backup_lag.run(Rds([{"RestoreWindow": {"LatestTime": t}}]), cw, "NS", "", NOW)
        self.assertEqual(out[0]["MetricName"], "BackupReplicaLagSeconds")
        self.assertEqual(out[0]["Value"], 240.0)
        self.assertEqual(out[1]["Value"], 0.0)

    def test_missing_time_publishes_lookup_failed(self):
        cw = Cw()
        out = backup_lag.run(Rds([{"RestoreWindow": {}}]), cw, "NS", "", NOW)
        self.assertEqual([m["MetricName"] for m in out], ["BackupReplicaLookupFailed"])
        self.assertEqual(out[0]["Value"], 1.0)

    def test_api_error_publishes_lookup_failed(self):
        cw = Cw()
        out = backup_lag.run(Rds(boom=True), cw, "NS", "", NOW)
        self.assertEqual(out[0]["Value"], 1.0)
        self.assertEqual(cw.calls[0]["Namespace"], "NS")

    def test_newest_replica_wins(self):
        a = NOW - datetime.timedelta(seconds=900)
        b = NOW - datetime.timedelta(seconds=60)
        out = backup_lag.run(Rds([{"RestoreWindow": {"LatestTime": a}}, {"RestoreWindow": {"LatestTime": b}}]), Cw(), "NS", "", NOW)
        self.assertEqual(out[0]["Value"], 60.0)


if __name__ == "__main__":
    unittest.main()

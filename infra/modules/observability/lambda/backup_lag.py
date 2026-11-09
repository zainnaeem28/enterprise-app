"""Publish BackupReplicaLagSeconds (DEVOPS-PLAN 11.3, DPR-15).

Reads the latest restorable time of the replicated automated backup in the recovery Region and publishes
now - latestRestorableTime. A failed or empty lookup publishes BackupReplicaLookupFailed = 1 instead.
UNVERIFIED: that DescribeDBInstanceAutomatedBackups returns RestoreWindow.LatestTime for a replicated backup;
the staging rehearsal proves it. If not, a documented alternative replaces this before the alarm is relied on.
"""
import datetime
import os


def lag_seconds(backups, now):
    """Smallest lag over the replicated backups, or None when none reports a latest restorable time."""
    times = []
    for b in backups:
        latest = (b.get("RestoreWindow") or {}).get("LatestTime")
        if latest is not None:
            times.append(latest)
    if not times:
        return None
    return max(0.0, (now - max(times)).total_seconds())


def run(rds, cloudwatch, namespace, source_db_arn, now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    try:
        kwargs = {}
        if source_db_arn:
            kwargs["DBInstanceIdentifier"] = source_db_arn
        backups = rds.describe_db_instance_automated_backups(**kwargs).get("DBInstanceAutomatedBackups", [])
        lag = lag_seconds(backups, now)
    except Exception:  # the metric below is the alarm; the cause goes to the function log without request data
        lag = None
    if lag is None:
        data = [{"MetricName": "BackupReplicaLookupFailed", "Value": 1.0, "Unit": "Count"}]
    else:
        data = [
            {"MetricName": "BackupReplicaLagSeconds", "Value": lag, "Unit": "Seconds"},
            {"MetricName": "BackupReplicaLookupFailed", "Value": 0.0, "Unit": "Count"},
        ]
    cloudwatch.put_metric_data(Namespace=namespace, MetricData=data)
    return data


def handler(event, context):
    import boto3  # imported here so the unit test needs no AWS SDK

    rds = boto3.client("rds", region_name=os.environ["RECOVERY_REGION"])
    cloudwatch = boto3.client("cloudwatch")
    return run(rds, cloudwatch, os.environ["METRIC_NAMESPACE"], os.environ.get("SOURCE_DB_ARN", ""))

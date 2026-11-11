# DL-1 C3 (HEAAA-738): failed video vendor calls in the api log group. The api logs one `vendor_call` line per Chime call
# (outcome ok, rejected or an error outcome). R1-GAP-3 (HEAAA-779): the worker logs one `job_dead` line (job id and type only)
# when a job fails its last attempt (apps/worker/src/runner.ts); the second filter and alarm below watch it for
# `telehealth.close_meeting`, whose dead job leaves a vendor video room open.

resource "aws_cloudwatch_log_metric_filter" "video_vendor_failure" {
  name           = "${var.env}-video-vendor-failure"
  log_group_name = "/ecs/${var.compute_name}/api"
  pattern        = "{ $.event = \"vendor_call\" && $.kind = \"video\" && $.outcome != \"ok\" }"

  metric_transformation {
    name          = "VideoVendorFailure"
    namespace     = "Ehr/${var.env}"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "video_vendor_failure" {
  alarm_name          = "${var.env}-video-vendor-failure"
  alarm_description   = "Failed Chime vendor calls from the api (join tokens). Impact: patients or clinicians cannot join a video visit. First step: the api log lines with event=vendor_call, kind=video and their errorClass; check Chime service health and the api role's chime:CreateAttendee."
  namespace           = "Ehr/${var.env}"
  metric_name         = aws_cloudwatch_log_metric_filter.video_vendor_failure.metric_transformation[0].name
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.video_failure_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_topic_arns
  tags                = local.tags
}

resource "aws_cloudwatch_log_metric_filter" "close_meeting_dead" {
  name           = "${var.env}-close-meeting-dead"
  log_group_name = "/ecs/${var.compute_name}/worker"
  pattern        = "{ $.event = \"job_dead\" && $.jobType = \"telehealth.close_meeting\" }"

  metric_transformation {
    name          = "CloseMeetingDead"
    namespace     = "Ehr/${var.env}"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "close_meeting_dead" {
  alarm_name          = "${var.env}-close-meeting-dead"
  alarm_description   = "A telehealth.close_meeting job failed its last attempt (dead). Impact: a vendor video room may stay open. First step: the worker log lines with event=job_dead and the job id; find the earlier 'job failed' lines of that job for the error class, then close the room by hand and re-enqueue."
  namespace           = "Ehr/${var.env}"
  metric_name         = aws_cloudwatch_log_metric_filter.close_meeting_dead.metric_transformation[0].name
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_topic_arns
  tags                = local.tags
}

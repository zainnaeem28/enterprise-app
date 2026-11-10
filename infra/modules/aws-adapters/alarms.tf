# DL-1 C3 (HEAAA-738): failed video vendor calls in the api log group. The api logs one `vendor_call` line per Chime call
# (outcome ok, rejected or an error outcome). The matching alarm for `telehealth.close_meeting` jobs reaching `dead` is NOT here:
# the worker's dead-job log vocabulary is not in the repository yet (open item in the hand-off comment).

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

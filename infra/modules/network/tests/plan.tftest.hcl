mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = { names = ["us-east-2a", "us-east-2b", "us-east-2c"] }
  }
  mock_data "aws_region" {
    defaults = { name = "us-east-2" }
  }
}

variables {
  name                     = "t"
  cidr_block               = "10.0.0.0/16"
  flow_log_destination_arn = "arn:aws:s3:::flow-bucket"
}

run "three_tier_two_az_single_nat" {
  command = plan
  assert {
    condition     = length(aws_subnet.public) == 2 && length(aws_subnet.private) == 2 && length(aws_subnet.data) == 2
    error_message = "expected 2 subnets per tier"
  }
  assert {
    condition     = length(aws_nat_gateway.this) == 1
    error_message = "expected a single NAT gateway"
  }
  assert {
    condition     = aws_flow_log.this.log_destination == "arn:aws:s3:::flow-bucket"
    error_message = "flow logs must go to the given bucket"
  }
}

run "three_az_nat_per_az" {
  command = plan
  variables {
    az_count   = 3
    nat_per_az = true
  }
  assert {
    condition     = length(aws_nat_gateway.this) == 3
    error_message = "expected one NAT per AZ"
  }
}

run "one_az_rejected" {
  command = plan
  variables {
    az_count = 1
  }
  expect_failures = [var.az_count]
}

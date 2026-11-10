#!/usr/bin/env bash
# The restore-test VPC must have no way out except the endpoints: fail if the module declares a resource type that creates
# one (DEVOPS-PLAN 10.3 step 2, DPR-11). A plan test cannot assert that a resource is absent, so this reads the source.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
forbidden='aws_internet_gateway|aws_egress_only_internet_gateway|aws_nat_gateway|aws_eip|aws_vpc_peering_connection|aws_ec2_transit_gateway|aws_route"|aws_vpn_|aws_customer_gateway|aws_network_interface_attachment'
if grep -En "^resource \"(${forbidden})" "$here"/*.tf; then
  echo "forbidden resource type in the restore-test boundary" >&2
  exit 1
fi
# Seeded control: the pattern must catch a violation, or this check proves nothing.
printf 'resource "aws_nat_gateway" "x" {}\n' | grep -Eq "^resource \"(${forbidden})" || { echo "control failed: pattern does not match" >&2; exit 1; }
echo "restore-test boundary declares no internet gateway, NAT, peering, transit or VPN resource"

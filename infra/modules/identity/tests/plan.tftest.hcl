mock_provider "aws" {}

variables {
  name                   = "test"
  patient_auth_domain    = "auth.example.org"
  partner_auth_domain    = "partner-auth.example.org"
  domain_certificate_arn = "arn:aws:acm:us-east-1:111111111111:certificate/11111111-1111-1111-1111-111111111111"
  ses_source_arn         = "arn:aws:ses:us-east-2:111111111111:identity/example.org"
  ses_from_address       = "no-reply@example.org"
  sms_caller_role_arn    = "arn:aws:iam::111111111111:role/cognito-sms"
  sms_external_id        = "external-id-example"
  patient_callback_urls  = ["https://my.example.org/auth/callback"]
  patient_logout_urls    = ["https://my.example.org/"]
  partner_callback_urls  = ["https://partner.example.org/auth/callback"]
  partner_logout_urls    = ["https://partner.example.org/"]
}

run "patient_pool_matches_the_approved_card" {
  command = plan

  assert {
    condition     = aws_cognito_user_pool.patient.user_pool_tier == "ESSENTIALS" && aws_cognito_user_pool_domain.patient.managed_login_version == 2
    error_message = "Essentials plan with managed login"
  }
  assert {
    condition     = toset(one(aws_cognito_user_pool.patient.sign_in_policy).allowed_first_auth_factors) == toset(["PASSWORD", "WEB_AUTHN", "EMAIL_OTP", "SMS_OTP"])
    error_message = "first factors are password, passkey, email OTP and SMS OTP"
  }
  assert {
    condition     = aws_cognito_user_pool.patient.mfa_configuration == "OPTIONAL"
    error_message = "patient MFA is optional (required is incompatible with OTP first factors)"
  }
  assert {
    condition     = one(aws_cognito_user_pool.patient.web_authn_configuration).relying_party_id == "auth.example.org" && one(aws_cognito_user_pool.patient.web_authn_configuration).user_verification == "preferred"
    error_message = "explicit relying-party ID equals the custom auth domain; UV stays at the card value"
  }
  assert {
    condition     = contains(aws_cognito_user_pool_client.patient.explicit_auth_flows, "ALLOW_USER_AUTH") && contains(aws_cognito_user_pool_client.patient.explicit_auth_flows, "ALLOW_REFRESH_TOKEN_AUTH") && aws_cognito_user_pool_client.patient.allowed_oauth_flows == toset(["code"])
    error_message = "choice-based sign-in on the client, code flow unchanged"
  }
  assert {
    condition     = aws_cognito_user_pool_client.patient.generate_secret == false
    error_message = "no client secret (would sit in state); PKCE protects the public client"
  }
  assert {
    condition     = one([for s in aws_cognito_user_pool.patient.schema : s.required if s.name == "email"]) == true
    error_message = "email is a required attribute"
  }
  assert {
    condition     = one(aws_cognito_user_pool.patient.email_configuration).email_sending_account == "DEVELOPER" && one(aws_cognito_user_pool.patient.sms_configuration).sns_caller_arn == "arn:aws:iam::111111111111:role/cognito-sms"
    error_message = "SES for email OTP, SNS role for SMS"
  }
  assert {
    condition     = aws_cognito_user_pool.patient.deletion_protection == "ACTIVE"
    error_message = "pools are deletion protected by default"
  }
}

run "partner_pool_has_mandatory_mfa_and_no_self_sign_up" {
  command = plan

  assert {
    condition     = aws_cognito_user_pool.partner.mfa_configuration == "ON" && one(aws_cognito_user_pool.partner.admin_create_user_config).allow_admin_create_user_only == true
    error_message = "partner MFA mandatory, invite only"
  }
  assert {
    condition     = toset(one(aws_cognito_user_pool.partner.sign_in_policy).allowed_first_auth_factors) == toset(["PASSWORD"])
    error_message = "OTP first factors are not allowed with required MFA"
  }
}

run "dev_pp04_b_is_refused_until_endorsed" {
  command = plan

  variables {
    passkey_user_verification = "required"
  }
  expect_failures = [aws_cognito_user_pool.patient]
}

run "dev_pp04_b_allowed_once_endorsed" {
  command = plan

  variables {
    passkey_user_verification = "required"
    dev_pp04_b_endorsed       = true
  }
  assert {
    condition     = one(aws_cognito_user_pool.patient.web_authn_configuration).user_verification == "required"
    error_message = "endorsed amendment switches UV to required"
  }
}

run "http_callbacks_rejected" {
  command = plan

  variables {
    patient_callback_urls = ["http://my.example.org/auth/callback"]
  }
  expect_failures = [var.patient_callback_urls]
}

output "patient_pool_id" {
  value = aws_cognito_user_pool.patient.id
}

output "patient_pool_arn" {
  value = aws_cognito_user_pool.patient.arn
}

output "patient_client_id" {
  value = aws_cognito_user_pool_client.patient.id
}

output "patient_issuer" {
  description = "OIDC issuer for the ID-token check (issuer, audience, exp, nonce)."
  value       = "https://cognito-idp.${var.region}.amazonaws.com/${aws_cognito_user_pool.patient.id}"
}

output "partner_pool_id" {
  value = aws_cognito_user_pool.partner.id
}

output "partner_pool_arn" {
  value = aws_cognito_user_pool.partner.arn
}

output "partner_client_id" {
  value = aws_cognito_user_pool_client.partner.id
}

output "configuration_summary" {
  description = "The identity configuration as authored, shown in the plan output (decision HEAAA-172). Not evidence about a real pool: PP-02 and PP-04 are verified on a staging pool after apply (QA-03)."
  value = {
    patient_pool = {
      feature_plan              = aws_cognito_user_pool.patient.user_pool_tier
      managed_login_version     = aws_cognito_user_pool_domain.patient.managed_login_version
      first_auth_factors        = local.patient_first_factors
      mfa_configuration         = aws_cognito_user_pool.patient.mfa_configuration
      email_required            = true
      passkey_relying_party_id  = var.patient_auth_domain
      passkey_user_verification = var.passkey_user_verification
      app_client_auth_flows     = aws_cognito_user_pool_client.patient.explicit_auth_flows
      oauth_flows               = aws_cognito_user_pool_client.patient.allowed_oauth_flows
      client_secret             = "none (public client, PKCE)"
      totp_offered              = var.patient_totp_enabled
      email_otp_sender          = "SES ${var.ses_from_address}"
      sms_fallback              = "SNS via role ${var.sms_caller_role_arn} (SMS sandbox exit is an operator item)"
    }
    partner_pool = {
      feature_plan       = aws_cognito_user_pool.partner.user_pool_tier
      first_auth_factors = local.partner_first_factors
      mfa_configuration  = aws_cognito_user_pool.partner.mfa_configuration
      second_factor      = "email OTP${var.partner_totp_enabled ? ", TOTP" : ""}"
      self_sign_up       = false
    }
  }
}

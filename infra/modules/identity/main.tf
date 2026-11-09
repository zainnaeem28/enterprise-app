# Patient and partner user pools (separate realms). DEVOPS-PLAN 7; ARCHITECTURE 7
# (identity rows); decision HEAAA-172. Authored and plan-tested only; nothing applied.
# IAM (the SMS role) is owned by the approvals root and arrives as an input.

locals {
  patient_first_factors = ["PASSWORD", "WEB_AUTHN", "EMAIL_OTP", "SMS_OTP"]
  partner_first_factors = ["PASSWORD"]
}

resource "aws_cognito_user_pool" "patient" {
  name                = "${var.name}-patient_pool"
  user_pool_tier      = "ESSENTIALS"
  deletion_protection = var.deletion_protection
  mfa_configuration   = "OPTIONAL"

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  # Choice-based sign-in. PASSWORD stays available (Cognito always offers it).
  sign_in_policy {
    allowed_first_auth_factors = local.patient_first_factors
  }

  # The relying-party ID is explicit and equals the custom auth domain.
  web_authn_configuration {
    relying_party_id  = var.patient_auth_domain
    user_verification = var.passkey_user_verification
  }

  schema {
    name                = "email"
    attribute_data_type = "String"
    required            = true
    mutable             = true
    string_attribute_constraints {
      min_length = 5
      max_length = 254
    }
  }

  password_policy {
    minimum_length                   = 12
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = false
    password_history_size            = 5
    temporary_password_validity_days = 1
  }

  email_configuration {
    email_sending_account = "DEVELOPER"
    source_arn            = var.ses_source_arn
    from_email_address    = var.ses_from_address
    configuration_set     = var.ses_configuration_set
  }

  sms_configuration {
    sns_caller_arn = var.sms_caller_role_arn
    external_id    = var.sms_external_id
    sns_region     = var.sms_region
  }

  software_token_mfa_configuration {
    enabled = var.patient_totp_enabled
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  admin_create_user_config {
    allow_admin_create_user_only = false
  }

  tags = merge(var.tags, { Realm = "patient_pool" })

  lifecycle {
    precondition {
      condition     = var.passkey_user_verification == "preferred" || var.dev_pp04_b_endorsed
      error_message = "passkey_user_verification = required is the proposed G2 amendment DEV-PP04-B and needs a human endorsement (dev_pp04_b_endorsed = true). The approved configuration is preferred."
    }
  }
}

resource "aws_cognito_user_pool_domain" "patient" {
  domain                = var.patient_auth_domain
  certificate_arn       = var.domain_certificate_arn
  user_pool_id          = aws_cognito_user_pool.patient.id
  managed_login_version = 2
}

# Authorization code with PKCE. A public client: the API exchanges the code with the
# code verifier, so no client secret exists to store (it would sit in state).
resource "aws_cognito_user_pool_client" "patient" {
  name         = "${var.name}-patient-web"
  user_pool_id = aws_cognito_user_pool.patient.id

  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "phone"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = var.patient_callback_urls
  logout_urls                          = var.patient_logout_urls
  explicit_auth_flows                  = ["ALLOW_USER_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors        = "ENABLED"
  enable_token_revocation              = true

  access_token_validity  = var.access_token_minutes
  id_token_validity      = var.id_token_minutes
  refresh_token_validity = var.refresh_token_days
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
}

resource "aws_cognito_user_pool" "partner" {
  name                = "${var.name}-partner_pool"
  user_pool_tier      = "ESSENTIALS"
  deletion_protection = var.deletion_protection
  mfa_configuration   = "ON"

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  # OTP first factors cannot be combined with required MFA, so the first factor is
  # the password and the mandatory second factor is email OTP (works in the replica).
  sign_in_policy {
    allowed_first_auth_factors = local.partner_first_factors
  }

  schema {
    name                = "email"
    attribute_data_type = "String"
    required            = true
    mutable             = true
    string_attribute_constraints {
      min_length = 5
      max_length = 254
    }
  }

  password_policy {
    minimum_length                   = 14
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = true
    password_history_size            = 5
    temporary_password_validity_days = 1
  }

  email_configuration {
    email_sending_account = "DEVELOPER"
    source_arn            = var.ses_source_arn
    from_email_address    = var.ses_from_address
    configuration_set     = var.ses_configuration_set
  }

  email_mfa_configuration {
    subject = "Your sign-in code"
    message = "Your sign-in code is {####}."
  }

  software_token_mfa_configuration {
    enabled = var.partner_totp_enabled
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  # Partner users are invited, never self-registered.
  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  tags = merge(var.tags, { Realm = "partner_pool" })
}

resource "aws_cognito_user_pool_domain" "partner" {
  domain                = var.partner_auth_domain
  certificate_arn       = var.domain_certificate_arn
  user_pool_id          = aws_cognito_user_pool.partner.id
  managed_login_version = 2
}

resource "aws_cognito_user_pool_client" "partner" {
  name         = "${var.name}-partner-web"
  user_pool_id = aws_cognito_user_pool.partner.id

  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = var.partner_callback_urls
  logout_urls                          = var.partner_logout_urls
  explicit_auth_flows                  = ["ALLOW_USER_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors        = "ENABLED"
  enable_token_revocation              = true

  access_token_validity  = var.access_token_minutes
  id_token_validity      = var.id_token_minutes
  refresh_token_validity = var.refresh_token_days
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
}

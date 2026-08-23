interface TeamControlPlaneSecrets {
  TEAM_SESSION_HMAC_SECRET: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_RECONCILIATION_HMAC_SECRET: string;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_RECONCILIATION_HMAC_SECRET: string;
}

interface Env extends TeamControlPlaneSecrets {}

declare namespace Cloudflare {
  interface Env extends TeamControlPlaneSecrets {}
}

interface ProofNetworkSecrets {
  ADMIN_TOKEN: string;
  TELEMETRY_HMAC_KEY: string;
  LIFECYCLE_ISSUING_KEY: string;
}

interface Env extends ProofNetworkSecrets {}

declare namespace Cloudflare {
  interface Env extends ProofNetworkSecrets {}
}

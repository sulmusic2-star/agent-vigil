interface ProofNetworkSecrets {
  ADMIN_TOKEN: string;
  TELEMETRY_HMAC_KEY: string;
  LIFECYCLE_ISSUING_KEY: string;
  FREQUENCY_OPERATOR_PRIVATE_KEY_PKCS8_B64: string;
  FREQUENCY_OPERATOR_KEY_ID: string;
}

interface Env extends ProofNetworkSecrets {}

declare namespace Cloudflare {
  interface Env extends ProofNetworkSecrets {}
}

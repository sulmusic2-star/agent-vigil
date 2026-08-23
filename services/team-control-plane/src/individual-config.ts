import { hmacHex } from "./crypto.ts";
import { ApiError } from "./http.ts";

const INDIVIDUAL_SECRET_NAMES = [
  "R0_MEASUREMENT_CONTROL_HMAC_SECRET",
  "R0_MEASUREMENT_IDENTITY_BRIDGE_HMAC_SECRET",
  "R0_MEASUREMENT_ACTIVITY_BRIDGE_HMAC_SECRET",
  "R0_MEASUREMENT_IDENTITY_HMAC_SECRET",
  "R0_INDIVIDUAL_IDENTITY_HMAC_SECRET",
  "INDIVIDUAL_SESSION_HMAC_SECRET",
  "GITHUB_RECONCILIATION_HMAC_SECRET",
  "GITHUB_WEBHOOK_SECRET",
  "TEAM_SESSION_HMAC_SECRET"
] as const;

type IndividualSecretName = (typeof INDIVIDUAL_SECRET_NAMES)[number];

export interface IndividualFeatureConfig {
  sessionIssuer: string;
  sessionKeyId: string;
  identityKeyId: string;
}

function requireConfiguredId(value: string, name: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/u.test(value) ||
    value.includes("CONFIGURE_BEFORE_DEPLOYMENT")
  ) {
    throw new ApiError(503, "individual_measurement_configuration_invalid", `${name} is not configured.`);
  }
  return value;
}

export function individualMeasurementEnabled(env: Env): boolean {
  const enabled: string = env.R0_INDIVIDUAL_MEASUREMENT_ENABLED;
  return enabled === "true";
}

export function requireIndividualFeatureConfiguration(
  env: Pick<
    Env,
    | IndividualSecretName
    | "R0_INDIVIDUAL_MEASUREMENT_ENABLED"
    | "INDIVIDUAL_SESSION_ISSUER"
    | "INDIVIDUAL_SESSION_KEY_ID"
    | "R0_INDIVIDUAL_IDENTITY_HMAC_KEY_ID"
  >
): IndividualFeatureConfig {
  const enabled: string = env.R0_INDIVIDUAL_MEASUREMENT_ENABLED;
  if (enabled !== "true") {
    throw new ApiError(503, "individual_measurement_disabled", "Individual R0 measurement is disabled.");
  }
  const encoder = new TextEncoder();
  const secrets = INDIVIDUAL_SECRET_NAMES.map((name) => env[name]);
  if (
    secrets.some((secret) => typeof secret !== "string" || encoder.encode(secret).byteLength < 32) ||
    new Set(secrets).size !== secrets.length
  ) {
    throw new ApiError(
      503,
      "individual_measurement_secret_configuration_invalid",
      "Individual measurement secret configuration is invalid."
    );
  }
  let issuer: URL;
  try {
    issuer = new URL(env.INDIVIDUAL_SESSION_ISSUER);
  } catch {
    throw new ApiError(503, "individual_measurement_configuration_invalid", "INDIVIDUAL_SESSION_ISSUER is not configured.");
  }
  if (
    issuer.protocol !== "https:" ||
    issuer.username !== "" ||
    issuer.password !== "" ||
    issuer.search !== "" ||
    issuer.hash !== "" ||
    issuer.toString() !== env.INDIVIDUAL_SESSION_ISSUER
  ) {
    throw new ApiError(503, "individual_measurement_configuration_invalid", "INDIVIDUAL_SESSION_ISSUER is not configured.");
  }
  return {
    sessionIssuer: issuer.toString(),
    sessionKeyId: requireConfiguredId(env.INDIVIDUAL_SESSION_KEY_ID, "INDIVIDUAL_SESSION_KEY_ID"),
    identityKeyId: requireConfiguredId(
      env.R0_INDIVIDUAL_IDENTITY_HMAC_KEY_ID,
      "R0_INDIVIDUAL_IDENTITY_HMAC_KEY_ID"
    )
  };
}

export async function individualSubjectToken(env: Env, accountNodeId: string): Promise<string> {
  const digest = await hmacHex(
    env.R0_INDIVIDUAL_IDENTITY_HMAC_SECRET,
    `agent-vigil:r0:individual:v1:${accountNodeId}`
  );
  return `mind_${digest}`;
}

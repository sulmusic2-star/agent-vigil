import { hmacHex } from "./crypto.ts";
import { ApiError } from "./http.ts";
import { assertMeasurementDutySecretSeparation } from "./measurement-security.ts";

export interface IndividualSessionConfig {
  sessionIssuer: string;
  sessionAudience: string;
  sessionKeyId: string;
}

export interface IndividualFeatureConfig extends IndividualSessionConfig {
  identityKeyId: string;
}

function configuredId(value: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/u.test(value) &&
    !value.includes("CONFIGURE_BEFORE_DEPLOYMENT")
  );
}

function requireConfiguredId(value: string, name: string): string {
  if (!configuredId(value)) {
    throw new ApiError(503, "individual_measurement_configuration_invalid", `${name} is not configured.`);
  }
  return value;
}

export function individualMeasurementEnabled(env: Env): boolean {
  const enabled: string = env.R0_INDIVIDUAL_MEASUREMENT_ENABLED;
  return enabled === "true";
}

export function requireIndividualSessionConfiguration(
  env: Pick<
    Env,
    | "INDIVIDUAL_SESSION_ENABLED"
    | "INDIVIDUAL_SESSION_ISSUER"
    | "INDIVIDUAL_SESSION_AUDIENCE"
    | "INDIVIDUAL_SESSION_KEY_ID"
    | "INDIVIDUAL_SESSION_HMAC_SECRET"
  >
): IndividualSessionConfig {
  const enabled: string = env.INDIVIDUAL_SESSION_ENABLED;
  if (enabled !== "true") {
    throw new ApiError(503, "individual_session_disabled", "Individual session authentication is disabled.");
  }
  if (
    typeof env.INDIVIDUAL_SESSION_HMAC_SECRET !== "string" ||
    new TextEncoder().encode(env.INDIVIDUAL_SESSION_HMAC_SECRET).byteLength < 32
  ) {
    throw new ApiError(503, "individual_session_configuration_invalid", "Individual session configuration is invalid.");
  }
  let issuer: URL;
  try {
    issuer = new URL(env.INDIVIDUAL_SESSION_ISSUER);
  } catch {
    throw new ApiError(503, "individual_session_configuration_invalid", "Individual session configuration is invalid.");
  }
  if (
    issuer.protocol !== "https:" ||
    issuer.username !== "" ||
    issuer.password !== "" ||
    issuer.search !== "" ||
    issuer.hash !== "" ||
    issuer.toString() !== env.INDIVIDUAL_SESSION_ISSUER
  ) {
    throw new ApiError(503, "individual_session_configuration_invalid", "Individual session configuration is invalid.");
  }
  const audience = env.INDIVIDUAL_SESSION_AUDIENCE;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/u.test(audience) ||
    audience.includes("CONFIGURE_BEFORE_DEPLOYMENT") ||
    !configuredId(env.INDIVIDUAL_SESSION_KEY_ID)
  ) {
    throw new ApiError(503, "individual_session_configuration_invalid", "Individual session configuration is invalid.");
  }
  return {
    sessionIssuer: issuer.toString(),
    sessionAudience: audience,
    sessionKeyId: env.INDIVIDUAL_SESSION_KEY_ID
  };
}

export function requireIndividualFeatureConfiguration(
  env: Pick<
    Env,
    | "R0_MEASUREMENT_CONTROL_HMAC_SECRET"
    | "R0_MEASUREMENT_IDENTITY_BRIDGE_HMAC_SECRET"
    | "R0_MEASUREMENT_ACTIVITY_BRIDGE_HMAC_SECRET"
    | "R0_MEASUREMENT_IDENTITY_HMAC_SECRET"
    | "R0_INDIVIDUAL_IDENTITY_HMAC_SECRET"
    | "INDIVIDUAL_SESSION_HMAC_SECRET"
    | "GITHUB_RECONCILIATION_HMAC_SECRET"
    | "GITHUB_WEBHOOK_SECRET"
    | "TEAM_SESSION_HMAC_SECRET"
    | "R0_MEASUREMENT_ENABLED"
    | "R0_INDIVIDUAL_MEASUREMENT_ENABLED"
    | "INDIVIDUAL_SESSION_ENABLED"
    | "INDIVIDUAL_SESSION_ISSUER"
    | "INDIVIDUAL_SESSION_AUDIENCE"
    | "INDIVIDUAL_SESSION_KEY_ID"
    | "R0_INDIVIDUAL_IDENTITY_HMAC_KEY_ID"
  >
): IndividualFeatureConfig {
  const enabled: string = env.R0_INDIVIDUAL_MEASUREMENT_ENABLED;
  if (enabled !== "true") {
    throw new ApiError(503, "individual_measurement_disabled", "Individual R0 measurement is disabled.");
  }
  assertMeasurementDutySecretSeparation(env);
  const session = requireIndividualSessionConfiguration(env);
  return {
    ...session,
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

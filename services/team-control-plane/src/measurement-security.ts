import { ApiError } from "./http.ts";

const ORGANIZATION_MEASUREMENT_DUTY_SECRET_NAMES = [
  "TEAM_SESSION_HMAC_SECRET",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_RECONCILIATION_HMAC_SECRET",
  "R0_MEASUREMENT_CONTROL_HMAC_SECRET",
  "R0_MEASUREMENT_IDENTITY_BRIDGE_HMAC_SECRET",
  "R0_MEASUREMENT_ACTIVITY_BRIDGE_HMAC_SECRET",
  "R0_MEASUREMENT_IDENTITY_HMAC_SECRET"
] as const;

const INDIVIDUAL_MEASUREMENT_DUTY_SECRET_NAMES = [
  "R0_INDIVIDUAL_IDENTITY_HMAC_SECRET",
  "INDIVIDUAL_SESSION_HMAC_SECRET"
] as const;

export const MEASUREMENT_DUTY_SECRET_NAMES = [
  ...ORGANIZATION_MEASUREMENT_DUTY_SECRET_NAMES,
  ...INDIVIDUAL_MEASUREMENT_DUTY_SECRET_NAMES
] as const;

type MeasurementDutySecretName = (typeof MEASUREMENT_DUTY_SECRET_NAMES)[number];

type MeasurementDutyEnvironment = {
  [Name in MeasurementDutySecretName]: string;
} & {
  R0_MEASUREMENT_ENABLED: string;
  R0_INDIVIDUAL_MEASUREMENT_ENABLED: string;
};

export function assertMeasurementDutySecretSeparation(
  env: MeasurementDutyEnvironment
): void {
  const organizationEnabled: string = env.R0_MEASUREMENT_ENABLED;
  const individualEnabled: string = env.R0_INDIVIDUAL_MEASUREMENT_ENABLED;
  if (organizationEnabled !== "true" && individualEnabled !== "true") return;

  const activeNames: readonly MeasurementDutySecretName[] =
    individualEnabled === "true"
      ? MEASUREMENT_DUTY_SECRET_NAMES
      : ORGANIZATION_MEASUREMENT_DUTY_SECRET_NAMES;
  const encoder = new TextEncoder();
  const secrets = activeNames.map((name) => env[name]);
  if (
    secrets.some((secret) => typeof secret !== "string" || encoder.encode(secret).byteLength < 32) ||
    new Set(secrets).size !== secrets.length
  ) {
    throw new ApiError(
      503,
      "r0_measurement_secret_configuration_invalid",
      "R0 measurement duty-secret configuration is invalid."
    );
  }
}

/**
 * Offline verifier for Agent Vigil Continuity Staples.
 *
 * This entry point performs no network calls and does not issue staples.
 */
export {
  CONTINUITY_STAPLE_SCHEMA,
  MAX_CONTINUITY_STAPLE_BYTES,
  STAPLE_CLOCK_SKEW_SECONDS,
  loadContinuityStaple,
  parseContinuityStapleJson,
  verifyContinuityStaple,
  type ContinuityStaplePayload,
  type ContinuityStapleVerification,
  type SignedContinuityStaple,
  type VerifyStapleOptions,
} from "./continuity/staple.js";

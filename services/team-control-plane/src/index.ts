import { authenticate } from "./auth.ts";
import { authenticateIndividual } from "./individual-auth.ts";
import {
  getEntitlementAndRevenue,
  handleProviderReconciliation,
  handleStripeWebhook,
  listBillingCommands,
  prepareCancellation,
  prepareCheckout,
  prepareRefund
} from "./billing.ts";
import { publicCatalog } from "./catalog.ts";
import { ApiError, assertMethod, errorResponse, jsonResponse } from "./http.ts";
import {
  claimGitHubInstallation,
  getGitHubInstallation,
  handleGitHubReconciliation,
  handleGitHubWebhook
} from "./github-app.ts";
import { claimPersonalInstallation, getPersonalInstallation } from "./individual-github.ts";
import {
  getIndividualMeasurement,
  putIndividualMeasurementConsent
} from "./individual-measurement.ts";
import {
  confirmIndividualDeletion,
  exportIndividualData,
  requestIndividualDeletion
} from "./individual-privacy.ts";
import {
  getOrganizationMeasurement,
  handleMeasurementBridge,
  handleMeasurementReport,
  putMeasurementConsent
} from "./measurement.ts";
import { confirmOrganizationDeletion, exportOrganizationData, requestOrganizationDeletion } from "./privacy.ts";
import {
  addException,
  addHistory,
  addRollback,
  getGateState,
  getOrganization,
  getPolicy,
  listAudit,
  listExceptions,
  listHistory,
  listMembers,
  listRollbacks,
  putMember,
  putPolicy
} from "./team.ts";
import { requireOrgId, requireOpaqueId } from "./validation.ts";

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/healthz") {
    assertMethod(request, "GET");
    await env.TEAM_CONTROL_DB.prepare("SELECT 1").first();
    return jsonResponse({ status: "ok", schema_version: "team-control-plane-v1" });
  }
  if (url.pathname === "/v1/catalog") {
    assertMethod(request, "GET");
    return jsonResponse(publicCatalog());
  }
  if (url.pathname === "/v1/billing/stripe/webhook") {
    assertMethod(request, "POST");
    return handleStripeWebhook(request, env);
  }
  if (url.pathname === "/v1/billing/stripe/reconciliation") {
    assertMethod(request, "POST");
    return handleProviderReconciliation(request, env);
  }
  if (url.pathname === "/v1/github/app/webhook") {
    assertMethod(request, "POST");
    return handleGitHubWebhook(request, env);
  }
  if (url.pathname === "/v1/github/app/reconciliation") {
    assertMethod(request, "POST");
    return handleGitHubReconciliation(request, env);
  }
  if (url.pathname === "/v1/measurement/bridge") {
    assertMethod(request, "POST");
    return handleMeasurementBridge(request, env);
  }
  if (url.pathname === "/v1/measurement/report") {
    assertMethod(request, "POST");
    return handleMeasurementReport(request, env);
  }
  if (url.pathname.startsWith("/v1/individual/")) {
    const auth = await authenticateIndividual(request, env);
    if (url.pathname === "/v1/individual/measurement-consent" && request.method === "PUT") {
      return putIndividualMeasurementConsent(request, env, auth);
    }
    if (url.pathname === "/v1/individual/measurement" && request.method === "GET") {
      return getIndividualMeasurement(env, auth);
    }
    if (url.pathname === "/v1/individual/github/installation-claim" && request.method === "POST") {
      return claimPersonalInstallation(request, env, auth);
    }
    if (url.pathname === "/v1/individual/github/installation" && request.method === "GET") {
      return getPersonalInstallation(env, auth);
    }
    if (url.pathname === "/v1/individual/privacy/export" && request.method === "GET") {
      return exportIndividualData(env, auth);
    }
    if (url.pathname === "/v1/individual/privacy/deletion-requests" && request.method === "POST") {
      return requestIndividualDeletion(request, env, auth);
    }
    if (url.pathname === "/v1/individual/privacy/data" && request.method === "DELETE") {
      return confirmIndividualDeletion(request, env, auth);
    }
    throw new ApiError(404, "not_found", "Route not found.");
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] !== "v1" || segments[1] !== "orgs" || !segments[2]) {
    throw new ApiError(404, "not_found", "Route not found.");
  }
  const orgId = requireOrgId(segments[2]);
  const auth = await authenticate(request, env, orgId);
  const resource = segments[3];
  const child = segments[4];

  if (!resource && request.method === "GET") {
    return getOrganization(env, auth);
  }
  if (resource === "policy" && !child) {
    if (request.method === "GET") return getPolicy(env, auth);
    if (request.method === "PUT") return putPolicy(request, env, auth);
  }
  if (resource === "gate" && !child && request.method === "GET") {
    return getGateState(env, auth);
  }
  if (resource === "members") {
    if (!child && request.method === "GET") return listMembers(env, auth);
    if (child && request.method === "PUT") {
      requireOpaqueId(child, "user_id");
      return putMember(request, env, auth, child);
    }
  }
  if (resource === "history" && !child) {
    if (request.method === "GET") return listHistory(env, auth);
    if (request.method === "POST") return addHistory(request, env, auth);
  }
  if (resource === "exceptions" && !child) {
    if (request.method === "GET") return listExceptions(env, auth);
    if (request.method === "POST") return addException(request, env, auth);
  }
  if (resource === "rollbacks" && !child) {
    if (request.method === "GET") return listRollbacks(env, auth);
    if (request.method === "POST") return addRollback(request, env, auth);
  }
  if (resource === "audit" && !child && request.method === "GET") {
    return listAudit(env, auth);
  }
  if (resource === "measurement-consent" && !child && request.method === "PUT") {
    return putMeasurementConsent(request, env, auth);
  }
  if (resource === "measurement" && !child && request.method === "GET") {
    return getOrganizationMeasurement(env, auth);
  }
  if (resource === "github") {
    if (child === "installation-claim" && request.method === "POST") {
      return claimGitHubInstallation(request, env, auth);
    }
    if (child === "installation" && request.method === "GET") {
      return getGitHubInstallation(env, auth);
    }
  }
  if (resource === "billing") {
    if (child === "checkout" && request.method === "POST") return prepareCheckout(request, env, auth);
    if (child === "cancel" && request.method === "POST") return prepareCancellation(request, env, auth);
    if (child === "refund" && request.method === "POST") return prepareRefund(request, env, auth);
    if (child === "commands" && request.method === "GET") return listBillingCommands(env, auth);
    if (child === "ledger" && request.method === "GET") return getEntitlementAndRevenue(env, auth);
  }
  if (resource === "privacy") {
    if (child === "export" && request.method === "GET") return exportOrganizationData(env, auth);
    if (child === "deletion-requests" && request.method === "POST") return requestOrganizationDeletion(env, auth);
    if (child === "data" && request.method === "DELETE") return confirmOrganizationDeletion(request, env, auth);
  }
  throw new ApiError(404, "not_found", "Route not found.");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    try {
      const response = await route(request, env);
      const headers = new Headers(response.headers);
      headers.set("X-Request-Id", requestId);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch (error) {
      if (error instanceof ApiError) {
        console.log(
          JSON.stringify({
            message: "request rejected",
            request_id: requestId,
            method: request.method,
            path: new URL(request.url).pathname,
            code: error.code,
            status: error.status
          })
        );
        return errorResponse(error, requestId);
      }
      console.error(
        JSON.stringify({
          message: "unhandled request error",
          request_id: requestId,
          method: request.method,
          path: new URL(request.url).pathname,
          error: error instanceof Error ? error.name : "unknown"
        })
      );
      return errorResponse(new ApiError(500, "internal_error", "The service could not complete the request."), requestId);
    }
  }
} satisfies ExportedHandler<Env>;

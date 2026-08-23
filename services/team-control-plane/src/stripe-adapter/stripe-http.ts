import { STRIPE_API_VERSION, type StripeFetch } from "./contracts.ts";
import { AdapterError, isRecord } from "./safe.ts";

const STRIPE_ORIGIN = "https://api.stripe.com";
const RESPONSE_LIMIT_BYTES = 524_288;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_ATTEMPTS = 3;

export interface StripeRequestOptions {
  method?: "GET" | "POST";
  form?: URLSearchParams;
  idempotencyKey?: string;
}

export interface StripeClientOptions {
  fetch: StripeFetch;
  secretKey: string;
  livemode: boolean;
  keyMode: "mutation" | "read_only";
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
}

function validateSecretKey(secret: string, livemode: boolean, keyMode: "mutation" | "read_only"): void {
  const prefix = `rk_${livemode ? "live" : "test"}_`;
  if (!secret.startsWith(prefix) || secret.length < prefix.length + 8) {
    throw new AdapterError(
      503,
      "adapter_not_configured",
      `Stripe ${keyMode === "mutation" ? "executor" : "read-only"} restricted key is not configured for this mode.`
    );
  }
}

function shouldRetryResponse(response: Response): boolean {
  const directive = response.headers.get("Stripe-Should-Retry");
  if (directive === "false") return false;
  if (directive === "true") return true;
  return response.status === 409 || response.status === 429 || response.status >= 500;
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > RESPONSE_LIMIT_BYTES) {
    await response.body?.cancel();
    throw new AdapterError(502, "stripe_response_invalid", "Stripe response exceeded the adapter limit.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let received = 0;
  let raw = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > RESPONSE_LIMIT_BYTES) {
        await reader.cancel("response limit exceeded");
        throw new AdapterError(502, "stripe_response_invalid", "Stripe response exceeded the adapter limit.");
      }
      raw += decoder.decode(chunk.value, { stream: true });
    }
    raw += decoder.decode();
    return raw;
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw new AdapterError(502, "stripe_response_invalid", "Stripe response was not valid UTF-8.");
  } finally {
    reader.releaseLock();
  }
}

export class StripeClient {
  private readonly fetchImpl: StripeFetch;
  private readonly secretKey: string;
  private readonly livemode: boolean;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly timeoutMs: number;

  constructor(options: StripeClientOptions) {
    validateSecretKey(options.secretKey, options.livemode, options.keyMode);
    this.fetchImpl = options.fetch;
    this.secretKey = options.secretKey;
    this.livemode = options.livemode;
    this.sleep = options.sleep ?? defaultSleep;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async request(path: string, options: StripeRequestOptions = {}): Promise<Record<string, unknown>> {
    const url = new URL(path, STRIPE_ORIGIN);
    if (url.origin !== STRIPE_ORIGIN || !url.pathname.startsWith("/v1/") || url.hash) {
      throw new AdapterError(500, "invalid_stripe_path", "Stripe adapter path is invalid.");
    }
    const method = options.method ?? "GET";
    if (method === "POST" && !options.idempotencyKey) {
      throw new AdapterError(500, "missing_provider_idempotency", "Mutating Stripe request is missing idempotency.");
    }
    if (options.idempotencyKey && options.idempotencyKey.length > 255) {
      throw new AdapterError(500, "invalid_provider_idempotency", "Stripe idempotency key is invalid.");
    }
    let finalError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const headers = new Headers({
          Authorization: `Bearer ${this.secretKey}`,
          "Stripe-Version": STRIPE_API_VERSION,
          Accept: "application/json",
          "User-Agent": "agent-vigil-team-stripe-adapter/1"
        });
        if (method === "POST") headers.set("Content-Type", "application/x-www-form-urlencoded");
        if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
        const response = await this.fetchImpl(url, {
          method,
          headers,
          signal: controller.signal,
          ...(method === "POST" ? { body: options.form?.toString() ?? "" } : {})
        });
        clearTimeout(timeout);
        if (!response.ok) {
          if (attempt + 1 < MAX_ATTEMPTS && shouldRetryResponse(response)) {
            await response.body?.cancel();
            await this.sleep(attempt === 0 ? 100 : 400);
            continue;
          }
          await response.body?.cancel();
          throw new AdapterError(502, "stripe_rejected", "Stripe rejected the provider operation.");
        }
        const raw = await readBoundedResponse(response);
        let value: unknown;
        try {
          value = JSON.parse(raw);
        } catch {
          throw new AdapterError(502, "stripe_response_invalid", "Stripe response was not valid JSON.");
        }
        if (!isRecord(value)) {
          throw new AdapterError(502, "stripe_response_invalid", "Stripe response did not match the configured mode.");
        }
        if (value.object === "list") {
          if (
            !Array.isArray(value.data) ||
            value.data.some((item) => !isRecord(item) || item.livemode !== this.livemode)
          ) {
            throw new AdapterError(502, "stripe_response_invalid", "Stripe response did not match the configured mode.");
          }
        } else if (value.livemode !== this.livemode) {
          throw new AdapterError(502, "stripe_response_invalid", "Stripe response did not match the configured mode.");
        }
        return value;
      } catch (error) {
        clearTimeout(timeout);
        if (error instanceof AdapterError) throw error;
        finalError = error;
        if (attempt + 1 < MAX_ATTEMPTS) {
          await this.sleep(attempt === 0 ? 100 : 400);
          continue;
        }
      }
    }
    void finalError;
    throw new AdapterError(503, "stripe_unavailable", "Stripe did not return a conclusive response.");
  }
}

export function stripePath(
  resource: "events" | "subscriptions" | "payment_intents" | "refunds",
  id: string
): string {
  return `/v1/${resource}/${encodeURIComponent(id)}`;
}

export function invoicePaymentsPath(invoiceId: string): string {
  const query = new URLSearchParams({ invoice: invoiceId, status: "paid", limit: "2" });
  return `/v1/invoice_payments?${query.toString()}`;
}

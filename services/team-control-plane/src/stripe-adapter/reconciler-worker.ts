import type { ReconcilerEnv } from "./contracts.ts";
import { handleReconciliation } from "./reconciler.ts";
import { adapterErrorResponse } from "./safe.ts";

export default {
  async fetch(request: Request, env: ReconcilerEnv): Promise<Response> {
    try {
      return await handleReconciliation(request, env);
    } catch (error) {
      return adapterErrorResponse(error);
    }
  }
} satisfies ExportedHandler<ReconcilerEnv>;

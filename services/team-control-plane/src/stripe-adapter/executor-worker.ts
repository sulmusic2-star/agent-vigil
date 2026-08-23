import { handleExecution } from "./executor.ts";
import { adapterErrorResponse } from "./safe.ts";
import type { ExecutorEnv } from "./contracts.ts";

export default {
  async fetch(request: Request, env: ExecutorEnv): Promise<Response> {
    try {
      return await handleExecution(request, env);
    } catch (error) {
      return adapterErrorResponse(error);
    }
  }
} satisfies ExportedHandler<ExecutorEnv>;

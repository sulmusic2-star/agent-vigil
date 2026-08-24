import { hmacHex } from "./crypto.ts";

export async function commercialActorPseudonym(
  env: Pick<Env, "COMMERCIAL_ACTOR_HMAC_SECRET">,
  orgId: string,
  userId: string
): Promise<string> {
  const digest = await hmacHex(
    env.COMMERCIAL_ACTOR_HMAC_SECRET,
    `agent-vigil-commercial-actor-v1\u0000${orgId}\u0000${userId}`
  );
  return `userp_${digest}`;
}

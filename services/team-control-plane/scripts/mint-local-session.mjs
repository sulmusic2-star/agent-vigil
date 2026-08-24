import { createHmac, randomUUID } from "node:crypto";

const [orgId = "org_local", userId = "user_owner"] = process.argv.slice(2);
const secret = process.env.TEAM_SESSION_HMAC_SECRET;
const keyId = process.env.TEAM_SESSION_KEY_ID ?? "team-session-key-v1";
if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
  throw new Error("Set TEAM_SESSION_HMAC_SECRET to at least 32 UTF-8 bytes.");
}
const now = Math.floor(Date.now() / 1000);
const payload = Buffer.from(
  JSON.stringify({
    schema_version: "team-session-v1",
    kid: keyId,
    sub: userId,
    org_id: orgId,
    jti: randomUUID(),
    iat: now,
    exp: now + 3600
  })
).toString("base64url");
const signingInput = `avteam_v1.${payload}`;
const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");
process.stdout.write(`${signingInput}.${signature}\n`);

// DSSE v1 pre-authentication encoding. The payload type and exact payload bytes
// are signed together so the same signature cannot be reinterpreted elsewhere.
export function dssePae(payloadType: string, payload: Buffer): Buffer {
  const type = Buffer.from(payloadType, "utf8");
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${type.length} `, "ascii"),
    type,
    Buffer.from(` ${payload.length} `, "ascii"),
    payload,
  ]);
}

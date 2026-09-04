import assert from "node:assert/strict";
import test from "node:test";
import { dssePae, validateGuardRouteEnvelope } from "../src/guard-route-seal.ts";

test("DSSE framing binds payload type and exact bytes", () => {
  assert.equal(dssePae("type", Buffer.from("x")).toString("utf8"), "DSSEv1 4 type 1 x");
  assert.notDeepEqual(dssePae("type", Buffer.from("x")), dssePae("other", Buffer.from("x")));
});

test("route envelopes reject unsupported shapes before signature use", () => {
  assert.throws(() => validateGuardRouteEnvelope({}), /unsupported or missing fields/);
  assert.throws(() => validateGuardRouteEnvelope({ payloadType: "wrong", payload: "e30=", signatures: [] }), /payload type/);
});

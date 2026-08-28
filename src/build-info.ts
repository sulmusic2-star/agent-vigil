declare const __AGENT_VIGIL_BUILD_SHA__: string | undefined;

export const REVIEWED_PUBLIC_ACTION_SHA = "33ae20140ffb2e25a034f291225849765ff8d217";

export type ActionPin = {
  sha: string;
  source: "package-build" | "reviewed-public-release";
};

export function defaultActionPin(): ActionPin {
  const embedded = typeof __AGENT_VIGIL_BUILD_SHA__ === "string" ? __AGENT_VIGIL_BUILD_SHA__ : "";
  if (/^[0-9a-f]{40}$/.test(embedded)) return { sha: embedded, source: "package-build" };
  return { sha: REVIEWED_PUBLIC_ACTION_SHA, source: "reviewed-public-release" };
}

import { isAbsolute, relative, resolve, sep } from "node:path";
import { loadPolicy } from "./config.ts";
import {
  checkIntegrity,
  checkTestsPass,
  checkWorkspaceBinding,
  checkWorkspaceMutation,
  gitRefExists,
  resolveGitRef,
} from "./detectors/reality.ts";
import { verifyPortableReceipt, type PortableReceipt } from "./portable.ts";
import { buildReport, type CheckResult, type Claim, type TrustReport } from "./report.ts";
import { routeIntegrity } from "./integrity-policy.ts";
import { trustedGitOptional } from "./trusted-git.ts";

export type GateOptions = {
  repo: string;
  receiptPath: string;
  /** Logical repository path when receipt bytes were materialized into a private verifier snapshot. */
  receiptGitPath?: string;
  /** Exact UTF-8 bytes read from receiptPath, used to bind a private snapshot back to receiptGitPath. */
  receiptRaw?: string;
  base: string;
  head: string;
  policy?: string;
  policyRef?: string;
};

function git(repo: string, args: string[]): string | undefined {
  return trustedGitOptional(repo, args)?.trim();
}

function result(
  subject: string,
  verdict: CheckResult["verdict"],
  evidence: string,
  ruleId: string,
  blocksPass = false,
): CheckResult {
  return {
    claim: { kind: "integrity", quote: "portable receipt merge-gate check", subject },
    verdict,
    evidence,
    ruleId,
    ...(verdict === "verified" ? {} : { contributesToPass: false }),
    ...(blocksPass ? { blocksPass: true } : {}),
  };
}

function receiptRelativePath(repo: string, path: string): string | undefined {
  const value = relative(resolve(repo), isAbsolute(path) ? resolve(path) : resolve(repo, path)).replaceAll("\\", "/");
  if (!value || value === ".." || value.startsWith("../") || value.startsWith(`..${sep}`)) return undefined;
  return value.replace(/^\.\//, "");
}

export function buildPortableGateReport(receipt: PortableReceipt, options: GateOptions): TrustReport {
  const repo = resolve(options.repo);
  const receiptPath = resolve(options.receiptPath);
  if (!gitRefExists(repo, options.base) || !gitRefExists(repo, options.head)) {
    throw new Error(`invalid git range ${options.base}..${options.head}`);
  }
  const policy = loadPolicy(repo, options.policy, options.policyRef);
  const base = resolveGitRef(repo, options.base);
  const head = resolveGitRef(repo, options.head);
  const results: CheckResult[] = [];
  const advisories: CheckResult[] = [];
  const trusted = policy.value.trustedSignerKeyIds ?? [];
  const verification = verifyPortableReceipt(receipt, trusted);

  results.push(result(
    "portable receipt hash and Ed25519 signature",
    verification.hashValid && verification.signatureValid ? "verified" : "contradicted",
    verification.hashValid && verification.signatureValid
      ? `${receipt.portableHash} is intact and signed by ${verification.keyId}`
      : verification.errors.filter((error) => !error.includes("not pinned")).join("; ") || "portable receipt signature is invalid",
    "portable-signature",
  ));
  results.push(result(
    "receipt signer is pinned by trusted policy",
    verification.signerTrusted ? "verified" : trusted.length ? "contradicted" : "unverifiable",
    verification.signerTrusted
      ? `${verification.keyId} is listed in the base-anchored policy`
      : trusted.length
        ? `${verification.keyId ?? "unreadable signer"} is not one of ${trusted.length} trusted key ID(s)`
        : "trusted policy has no trustedSignerKeyIds; pin a signer before enabling the gate",
    "portable-signer",
    !trusted.length,
  ));
  results.push(result(
    "local Agent Vigil verdict",
    receipt.summary?.status === "PASS" && receipt.summary.pass ? "verified" : receipt.summary?.status === "FAIL" ? "contradicted" : "unverifiable",
    `signed local report ${receipt.reportHash} records ${receipt.summary?.status ?? "an invalid status"}`,
    "portable-local-verdict",
    receipt.summary?.status !== "FAIL",
  ));
  results.push(result(
    "portable receipt matches trusted policy",
    receipt.policy?.sha256 === policy.sha256 ? "verified" : "contradicted",
    receipt.policy?.sha256 === policy.sha256
      ? `receipt and base policy share ${policy.sha256}`
      : `receipt names ${receipt.policy?.sha256 ?? "no policy hash"}; trusted policy is ${policy.sha256}`,
    "portable-policy",
  ));

  const relativeReceipt = receiptRelativePath(repo, options.receiptGitPath ?? receiptPath);
  const configuredReceipt = policy.value.portableReceipt?.replace(/^\.\//, "");
  const committedReceipt = options.receiptGitPath && relativeReceipt
    ? trustedGitOptional(repo, ["show", `${head}:${relativeReceipt}`], 17 * 1024 * 1024)
    : undefined;
  const snapshotBound = !options.receiptGitPath
    || (options.receiptRaw !== undefined && committedReceipt !== undefined && committedReceipt === options.receiptRaw);
  if (configuredReceipt) {
    results.push(result(
      "receipt path is base-policy controlled",
      relativeReceipt === configuredReceipt && snapshotBound ? "verified" : "contradicted",
      relativeReceipt === configuredReceipt && snapshotBound
        ? `${relativeReceipt} matches policy portableReceipt and its private snapshot matches the exact head blob`
        : relativeReceipt !== configuredReceipt
          ? `received ${relativeReceipt ?? "a path outside the repository"}; policy requires ${configuredReceipt}`
          : "private receipt snapshot does not match the exact logical receipt blob at the selected head",
      "portable-path",
    ));
  } else {
    results.push(result(
      "receipt path is base-policy controlled",
      "unverifiable",
      "trusted policy has no portableReceipt path",
      "portable-path",
      true,
    ));
  }

  const receiptHeadExists = gitRefExists(repo, receipt.head);
  const receiptHead = receiptHeadExists ? resolveGitRef(repo, receipt.head) : undefined;
  const receiptBase = gitRefExists(repo, receipt.base) ? resolveGitRef(repo, receipt.base) : undefined;
  const exactHead = receiptHead === head;
  const ancestor = Boolean(receiptHead && git(repo, ["merge-base", "--is-ancestor", receiptHead, head]) !== undefined);
  const evidenceDelta = receiptHead && configuredReceipt
    ? (git(repo, ["diff", "--no-renames", "--name-only", "-z", receiptHead, head]) ?? "").split("\0").filter(Boolean)
    : [];
  const receiptOnlyTail = ancestor && evidenceDelta.length > 0 && evidenceDelta.every((path) => path === configuredReceipt);
  const expectedTree = receiptHead ? git(repo, ["rev-parse", `${receiptHead}^{tree}`]) : undefined;
  const currentRemote = git(repo, ["config", "--get", "remote.origin.url"]);
  const remoteMatches = !receipt.repository?.remote || !currentRemote || receipt.repository.remote === currentRemote;
  const gitBound = receiptBase === base
    && Boolean(receiptHead)
    && (exactHead || receiptOnlyTail)
    && Boolean(expectedTree)
    && receipt.repository?.tree === expectedTree
    && remoteMatches;
  results.push(result(
    "signed repository identity",
    gitBound ? "verified" : "contradicted",
    gitBound
      ? exactHead
        ? `receipt binds exact head ${head} and tree ${expectedTree}`
        : `receipt binds code head ${receiptHead}; ${receiptHead}..${head} changes only ${configuredReceipt}`
      : `expected base ${base}, current head ${head}, receipt base ${receiptBase ?? "invalid"}, receipt head ${receiptHead ?? "invalid"}, receipt tree ${receipt.repository?.tree ?? "missing"}, observed tree ${expectedTree ?? "invalid"}${remoteMatches ? "" : "; remote differs"}`,
    "portable-git-binding",
  ));

  results.push(...checkWorkspaceBinding(repo, head, exactHead && relativeReceipt ? [relativeReceipt] : []));
  const testClaim: Claim = { kind: "tests_pass", quote: "trusted policy verification passes in independent CI", subject: "trusted policy test command" };
  results.push(...checkTestsPass([testClaim], repo, policy.value.testCommand, undefined, base, head));
  results.push(...checkWorkspaceMutation(repo, exactHead && relativeReceipt ? [relativeReceipt] : [], head));
  const integrity = routeIntegrity(checkIntegrity(repo, base, head), policy.value.integrityMode ?? "advisory");
  results.push(...integrity.results);
  advisories.push(...integrity.advisories);

  const policySource = policy.ref && policy.gitPath ? `${policy.gitPath}@${policy.ref}` : policy.path ? relative(repo, policy.path) : undefined;
  const reproduction = [
    "vigil gate", `'${relativeReceipt ?? receiptPath}'`, "--repo .", "--base", base, "--head", head,
    ...(policy.gitPath ? ["--policy", `'${policy.gitPath}'`] : []),
    ...(policy.ref ? ["--policy-ref", policy.ref] : []),
  ].join(" ");
  return buildReport({
    transcript: relativeReceipt ?? "portable-receipt",
    transcriptSha256: receipt.transcriptSha256,
    transcriptFormat: "portable-receipt",
    repo,
    base,
    head,
    results,
    advisories,
    policy: { minVerified: policy.value.minVerified ?? 1, strict: true, source: policySource, sha256: policy.sha256 },
    repository: { ...(currentRemote ? { remote: currentRemote } : {}), ...(git(repo, ["rev-parse", `${head}^{tree}`]) ? { tree: git(repo, ["rev-parse", `${head}^{tree}`]) } : {}) },
    reproduction,
  });
}

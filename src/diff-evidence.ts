import { trustedGit } from "./trusted-git.ts";

export const DEFAULT_TEST_PATTERNS = ["test/**", "tests/**", "__tests__/**", "**/*.test.*", "**/*.spec.*"];

function gitRaw(repo: string, args: string[]): string {
  return trustedGit(repo, args, 8 * 1024 * 1024);
}

function globRegex(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") { source += "(?:.*/)?"; index += 2; }
      else { source += ".*"; index += 1; }
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

export function pathMatches(path: string, patterns: string[]): boolean {
  const clean = path.replace(/^\.\//, "");
  return patterns.some((pattern) => globRegex(pattern.replaceAll("\\", "/").replace(/^\.\//, "")).test(clean));
}

export type DiffEvidence = {
  paths: string[];
  testPaths: string[];
  changedLines?: number;
  binaryPaths: string[];
};

export function collectDiffEvidence(repo: string, base: string, head: string, testPathPatterns = DEFAULT_TEST_PATTERNS): DiffEvidence {
  const paths = gitRaw(repo, ["diff", "--no-renames", "--name-only", "-z", "--diff-filter=ACMRD", `${base}..${head}`]).split("\0").filter(Boolean);
  const overlayablePaths = gitRaw(repo, ["diff", "--no-renames", "--name-only", "-z", "--diff-filter=ACMR", `${base}..${head}`]).split("\0").filter(Boolean);
  const binaryPaths: string[] = [];
  let changedLines = 0;
  const numstat = gitRaw(repo, ["diff", "--no-renames", "--numstat", "-z", `${base}..${head}`]);
  for (const record of numstat.split("\0").filter(Boolean)) {
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab < 0 ? -1 : record.indexOf("\t", firstTab + 1);
    if (firstTab < 1 || secondTab < firstTab + 2 || secondTab === record.length - 1) {
      binaryPaths.push("[unparseable Git numstat record]");
      continue;
    }
    const added = record.slice(0, firstTab);
    const removed = record.slice(firstTab + 1, secondTab);
    const path = record.slice(secondTab + 1);
    if (added === "-" || removed === "-") binaryPaths.push(path);
    else if (/^\d+$/.test(added) && /^\d+$/.test(removed)) changedLines += Number(added) + Number(removed);
    else binaryPaths.push(`[unparseable Git numstat count for ${path}]`);
  }
  return { paths, testPaths: overlayablePaths.filter((path) => pathMatches(path, testPathPatterns)), ...(binaryPaths.length ? {} : { changedLines }), binaryPaths };
}


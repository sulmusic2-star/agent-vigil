import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

const target = process.env.VIGIL_TARGET || "/target";
const manifest = JSON.parse(readFileSync(resolve(target, "package.json"), "utf8"));
const entry = typeof manifest.main === "string" && manifest.main
  ? manifest.main
  : typeof manifest.exports === "string" && manifest.exports
    ? manifest.exports
    : undefined;
const targetRoot = resolve(target);
const entryPath = entry ? resolve(targetRoot, entry) : undefined;
const entryInsideTarget = Boolean(entryPath && entryPath.startsWith(`${targetRoot}${sep}`));
const entryExists = Boolean(entryInsideTarget && existsSync(entryPath));
const binCount = typeof manifest.bin === "string"
  ? 1
  : manifest.bin && typeof manifest.bin === "object" && !Array.isArray(manifest.bin)
    ? Object.keys(manifest.bin).length
    : 0;

process.stdout.write(JSON.stringify({
  schemaVersion: "agent-vigil-upgrade-canary/v1",
  outcome: entryExists ? "PASS" : "FAIL",
  observations: {
    "entry.exists": entryExists,
    "module.type": typeof manifest.type === "string" ? manifest.type : "commonjs-default",
    "bin.count": binCount,
    "scripts.count": manifest.scripts && typeof manifest.scripts === "object"
      ? Object.keys(manifest.scripts).length
      : 0,
  },
}));

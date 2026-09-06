import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatLocalCommand } from "./adoption.ts";
import { REGRESSION_FILE, REGRESSION_IMAGE, parseRegressionContract, regressionJson, renderRegression, runRegression } from "./regression.ts";
import { writePrivateFileAtomic } from "./safe-output.ts";
import { terminalSafe } from "./upgrade/presentation.ts";

export const regressionUsage = `Protected regression checks (local preview)

Keep selected input/output expectations outside the changed program.
Supports dependency-free .cjs files with named functions and JSON values.
Requires Git, Docker and the pinned Node image. No network or credentials
inside the candidate container. No automatic approval of changed expectations.

Usage:
  vigil regression doctor
  vigil regression init --module src/math.cjs --export add --args '[2,3]' --expect '5' [--repo .] [--dry-run]
  vigil regression check --base <40-character-sha> --head <40-character-sha> [--repo .] [--json] [--output receipt.json]

init writes ${REGRESSION_FILE}, refuses overwrites and never runs repository code.
Review the example, add meaningful cases, then commit it to the approved base.
check reads both exact commits, not your uncommitted files. Two runs per case
and revision check repeatability; they do not prove absence of flaky behavior.

Exit codes: 0 selected cases PASS; 1 confirmed mismatch; 2 NOT CHECKED or usage error.
No telemetry, upload, automatic image pull, account connection or merge decision.
`;

export function runRegressionCommand(args: string[], cliUrl?: string): number {
  if (!args.length || args.includes("--help") || args.includes("-h")) { console.log(regressionUsage); return 0; }
  try {
    const command = args[0];
    if (command === "doctor") {
      if (args.length !== 1) throw new Error("doctor accepts no options.");
      const rows = [["Git", ["git", "--version"]], ["Docker daemon", ["docker", "info", "--format", "{{.ServerVersion}}"]], ["Pinned image", ["docker", "image", "inspect", REGRESSION_IMAGE]]] as const;
      let complete = true;
      for (const [name, [executable, ...argv]] of rows) {
        const result = spawnSync(executable, argv, { encoding: "utf8", timeout: 5000, maxBuffer: 65536 });
        const ok = !result.error && result.status === 0;
        complete &&= ok; console.log(`${ok ? "PASS" : "NOT CHECKED"}  ${name}`);
      }
      if (!complete) console.log(`Install/start the missing tools. To fetch the image explicitly: docker pull ${REGRESSION_IMAGE}`);
      console.log("No repository code executed; no enforcement installed.");
      return complete ? 0 : 2;
    }
    if (!["init", "check"].includes(command)) throw new Error("Choose init, check or doctor. Use vigil regression --help.");
    const values: Record<string, string> = {};
    const switches = new Set<string>();
    const allowed = command === "init" ? ["--repo", "--module", "--export", "--args", "--expect"] : ["--repo", "--base", "--head", "--output"];
    for (let i = 1; i < args.length; i++) {
      const flag = args[i];
      if ((command === "init" && flag === "--dry-run") || (command === "check" && flag === "--json")) {
        if (switches.has(flag)) throw new Error("Repeated option.");
        switches.add(flag); continue;
      }
      if (!allowed.includes(flag) || values[flag] !== undefined || args[i + 1] === undefined || args[i + 1].startsWith("--")) throw new Error("Unknown, repeated or incomplete option. Use vigil regression --help.");
      values[flag] = args[++i];
    }
    const repo = resolve(values["--repo"] ?? ".");
    if (command === "init") {
      if (["--module", "--export", "--args", "--expect"].some(flag => values[flag] === undefined)) throw new Error("Provide --module, --export, --args and --expect. Expectations are chosen by you, not learned from possibly broken code.");
      const contract = parseRegressionContract(JSON.stringify({ version: 1, files: [values["--module"]], cases: [{ id: "protected-example", module: values["--module"], export: values["--export"], args: JSON.parse(values["--args"]), expect: JSON.parse(values["--expect"]) }] }));
      const content = regressionJson(contract, true) + "\n";
      if (switches.has("--dry-run")) { console.log(content); return 0; }
      writeFileSync(resolve(repo, REGRESSION_FILE), content, { flag: "wx", mode: 0o600 });
      console.log(`Created ${REGRESSION_FILE}. Review and extend the cases, then commit the file to your approved base. Nothing ran; no protection is active yet.`);
      return 0;
    }
    if (!values["--base"] || !values["--head"]) throw new Error("Provide exact --base and --head commit SHAs.");
    const receipt = runRegression({ repo, base: values["--base"], head: values["--head"] });
    if (cliUrl && /^[0-9a-f]{40}$/.test(receipt.base) && /^[0-9a-f]{40}$/.test(receipt.head)) {
      const path = fileURLToPath(cliUrl);
      const loader = path.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : [];
      receipt.reproduceCommand = formatLocalCommand([process.execPath, ...loader, path, "regression", "check", "--repo", repo, "--base", receipt.base, "--head", receipt.head]);
    }
    const json = regressionJson(receipt, true) + "\n";
    if (values["--output"]) writePrivateFileAtomic(resolve(values["--output"]), json);
    console.log(switches.has("--json") ? json.trimEnd() : renderRegression(receipt));
    return receipt.verdict === "PASS" ? 0 : receipt.verdict === "FAIL" ? 1 : 2;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const message = code === "EEXIST" ? "The contract already exists. It was not overwritten." : code ? "Could not read or write the requested path. No approval was recorded." : error instanceof SyntaxError ? "Invalid JSON arguments or expectations." : error instanceof Error ? error.message : "Unable to check protected cases.";
    console.error(`Agent Vigil: NOT CHECKED\n${terminalSafe(message)}`);
    return 2;
  }
}

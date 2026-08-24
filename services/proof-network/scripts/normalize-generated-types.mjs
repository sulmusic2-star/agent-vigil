import { readFileSync, writeFileSync } from "node:fs";

const path = new URL("../worker-configuration.d.ts", import.meta.url);
const source = readFileSync(path, "utf8");
const normalized = source.replace(/[ \t]+(?=\r?$)/gm, "");
writeFileSync(path, normalized);

import { fileURLToPath } from "node:url";

const REPOSITORY_PART = /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;
const ADOPTION_FORM = "https://github.com/sulmusic2-star/agent-vigil/issues/new?template=adopter-feedback.yml";

export function githubRepositorySlug(remote: string | undefined): string | undefined {
  if (!remote || /[\u0000-\u001f\u007f-\u009f]/.test(remote)) return undefined;
  let path: string | undefined;
  try {
    if (/^git@github\.com:/.test(remote)) path = remote.slice("git@github.com:".length);
    else {
      const url = new URL(remote);
      if (!new Set(["https:", "ssh:", "git:"]).has(url.protocol) || url.hostname.toLowerCase() !== "github.com" || url.search || url.hash) return undefined;
      if (url.password || (url.protocol === "ssh:" ? url.username !== "git" : Boolean(url.username))) return undefined;
      if (url.port && !(url.protocol === "ssh:" && url.port === "22")) return undefined;
      path = url.pathname.replace(/^\//, "");
    }
  } catch { return undefined; }
  const parts = path.replace(/\.git$/, "").split("/");
  if (parts.length !== 2 || !parts.every((part) => REPOSITORY_PART.test(part))) return undefined;
  return `${parts[0]}/${parts[1]}`;
}

export function workflowBadge(slug: string): string {
  const parts = slug.split("/");
  if (parts.length !== 2 || !parts.every((part) => REPOSITORY_PART.test(part))) throw new Error("badge repository must be owner/name");
  const workflow = `https://github.com/${slug}/actions/workflows/agent-vigil.yml`;
  return `[![Agent Vigil workflow](${workflow}/badge.svg)](${workflow})`;
}

export function adoptionRegistrationUrl(slug?: string): string {
  return slug ? `${ADOPTION_FORM}&title=${encodeURIComponent(`[adoption] ${slug}`)}` : ADOPTION_FORM;
}

export function formatLocalCommand(args: string[], platform: NodeJS.Platform = process.platform): string {
  if (!args.length || args.some((arg) => /[\u0000-\u001f\u007f-\u009f]/.test(arg))) {
    throw new Error("local command paths must not contain control characters");
  }
  if (platform === "win32") return "& " + args.map((arg) => `'${arg.replaceAll("'", "''")}'`).join(" ");
  return args.map((arg) => /^[A-Za-z0-9_./:=+-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
}

export function localCliCommand(command: "protect" | "doctor", cliUrl: string, repo = "."): string {
  const cliPath = fileURLToPath(cliUrl);
  // Source checkouts need their local loader; distributed bundles have no loader dependency.
  const loader = cliPath.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : [];
  return formatLocalCommand([process.execPath, ...loader, cliPath, command, "--repo", repo]);
}

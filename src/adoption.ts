const REPOSITORY_PART = /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;
const ADOPTION_FORM = "https://github.com/sulmusic2-star/agent-vigil/issues/new?template=adopter-feedback.yml";
const RELEASE_PACKAGE = "https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.23.3/sulmusic-agent-vigil-0.23.3.tgz";

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

export function releasedDoctorCommand(): string {
  return `npx --yes ${RELEASE_PACKAGE} doctor --repo .`;
}

export function releasedProtectCommand(): string {
  return `npx --yes ${RELEASE_PACKAGE} protect --repo .`;
}

const WINDOWS_RESERVED_BASENAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

export function isCrossPlatformSafeSegment(segment: string): boolean {
  if (!segment || segment === "." || segment === ".."
    || /[\u0000-\u001f\u007f<>:"/\\|?*]/.test(segment)
    || /[. ]$/.test(segment)) return false;
  const basename = segment.split(".", 1)[0].replace(/[. ]+$/g, "");
  return !WINDOWS_RESERVED_BASENAME.test(basename);
}

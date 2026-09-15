// Git's quoted path syntax is byte-oriented C quoting, not JSON or shell syntax.
const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
const names = new Map(Object.entries(escapes).map(([name, value]) => [value, name]));

function relativePath(path: string): boolean {
  return !!path && !path.includes('\0') && !path.includes('\ufffd')
    && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

export function decodeGitPatchPath(token: string): string | undefined {
  if (!token.startsWith('"')) {
    return token && !/[\u0000-\u001f\u007f"\\\ufffd]/u.test(token) ? token : undefined;
  }
  if (token.length < 2 || !token.endsWith('"')) return undefined;
  const bytes: number[] = [];
  for (let i = 1; i < token.length - 1; i++) {
    const char = token[i];
    if (char === '\\') {
      const escaped = token[++i];
      if (i >= token.length - 1) return undefined;
      if (Object.hasOwn(escapes, escaped)) bytes.push(escapes[escaped]);
      else {
        const octal = token.slice(i, i + 3);
        if (!/^[0-3][0-7]{2}$/.test(octal) || i + 3 > token.length - 1) return undefined;
        bytes.push(parseInt(octal, 8)); i += 2;
      }
    } else {
      if (char === '"' || /[\u0000-\u001f\u007f]/u.test(char)) return undefined;
      const point = token.codePointAt(i)!;
      if (point >= 0xd800 && point <= 0xdfff) return undefined;
      bytes.push(...Buffer.from(String.fromCodePoint(point), 'utf8'));
      if (point > 0xffff) i++;
    }
  }
  try {
    const path = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(bytes));
    return path && !path.includes('\0') && !path.includes('\ufffd') ? path : undefined;
  } catch { return undefined; }
}

export function patchHeaderPath(marker: string, prefix: 'a/' | 'b/'): string | undefined {
  // Git appends an empty tab delimiter to some ---/+++ names containing spaces.
  // Consume only that delimiter, never trim filename spaces or accept timestamps.
  const token = marker.endsWith('\t') ? marker.slice(0, -1) : marker;
  if (token === '/dev/null') return '';
  const decoded = decodeGitPatchPath(token);
  return decoded?.startsWith(prefix) && relativePath(decoded.slice(2)) ? decoded.slice(2) : undefined;
}

export function patchRenamePath(marker: string): string | undefined {
  const decoded = decodeGitPatchPath(marker);
  return decoded && relativePath(decoded) ? decoded : undefined;
}

function quoted(path: string, quoteHigh: boolean): string {
  let value = '"';
  for (const char of path) {
    const point = char.codePointAt(0)!;
    if (names.has(point)) value += '\\' + names.get(point);
    else if (point < 32 || point === 127 || (quoteHigh && point >= 128)) {
      for (const byte of Buffer.from(char, 'utf8')) value += '\\' + byte.toString(8).padStart(3, '0');
    } else value += char;
  }
  return value + '"';
}

function forms(path: string): string[] {
  return [...new Set([quoted(path, true), quoted(path, false),
    ...(/[\u0000-\u001f\u007f"\\\ufffd]/u.test(path) ? [] : [path])])];
}

/** Match known identities; never guess where two filenames containing spaces split. */
export function patchDiffIdentityMatches(header: string, oldPath: string, newPath: string): boolean {
  if (!relativePath(oldPath) || !relativePath(newPath)) return false;
  return forms('a/' + oldPath).some((oldForm) => forms('b/' + newPath)
    .some((newForm) => header === `diff --git ${oldForm} ${newForm}`));
}

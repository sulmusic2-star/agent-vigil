import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";

export type RegularFileSnapshot = { absolutePath: string; bytes: Buffer; mode: number };

/** Read a bounded regular file through the descriptor whose identity was verified. */
export function readRegularFileSnapshot(requestedPath: string, maximumBytes: number, label = "input"): RegularFileSnapshot {
  const absolutePath = resolve(requestedPath);
  const expected = lstatSync(absolutePath, { bigint: true });
  if (expected.isSymbolicLink() || !expected.isFile()) throw new Error(`${label} must be a regular non-symbolic-link file`);
  if (expected.size > BigInt(maximumBytes)) throw new Error(`${label} is ${expected.size} bytes; maximum is ${maximumBytes}`);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const nonBlock = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
  const descriptor = openSync(absolutePath, constants.O_RDONLY | noFollow | nonBlock);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino || opened.size !== expected.size
      || opened.mtimeNs !== expected.mtimeNs || opened.ctimeNs !== expected.ctimeNs) {
      throw new Error(`${label} changed while it was opened`);
    }
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error(`${label} changed while it was read`);
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) {
      throw new Error(`${label} changed while it was read`);
    }
    return { absolutePath, bytes, mode: Number(opened.mode & 0o7777n) };
  } finally {
    closeSync(descriptor);
  }
}

export function readRegularUtf8(requestedPath: string, maximumBytes: number, label = "input"): string {
  return readRegularFileSnapshot(requestedPath, maximumBytes, label).bytes.toString("utf8");
}


import { randomBytes } from "node:crypto";
import {
  close,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  write,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, parse, relative, resolve, sep, win32 } from "node:path";

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function assertReplaceableDestination(path: string): void {
  try {
    const status = lstatSync(path);
    if (status.isSymbolicLink()) {
      throw new Error(`Refusing to replace symbolic-link output: ${path}`);
    }
    if (!status.isFile()) {
      throw new Error(`Refusing to replace non-regular output: ${path}`);
    }
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
}

function resolveSafeParent(requested: string): string {
  const parent = dirname(requested);
  const root = parse(parent).root;
  const rootStatus = lstatSync(root);
  if (!rootStatus.isDirectory()) {
    throw new Error(`Refusing to use non-directory output root: ${root}`);
  }

  let current = root;
  const components = parent.slice(root.length).split(sep).filter(Boolean);
  for (const [index, component] of components.entries()) {
    const next = join(current, component);
    const status = lstatSync(next);
    if (status.isSymbolicLink()) {
      // macOS exposes root-owned /tmp and /var aliases. They are part of the
      // platform root layout, not repository-controlled output parents.
      const trustedRootAlias = index === 0
        && status.uid === rootStatus.uid
        && (rootStatus.mode & 0o022) === 0;
      if (!trustedRootAlias) {
        throw new Error(`Refusing to traverse symbolic-link output parent: ${next}`);
      }
      const canonical = realpathSync(next);
      if (!lstatSync(canonical).isDirectory()) {
        throw new Error(`Refusing to traverse non-directory output parent: ${next}`);
      }
      current = canonical;
      continue;
    }
    if (!status.isDirectory()) {
      throw new Error(`Refusing to traverse non-directory output parent: ${next}`);
    }
    current = next;
  }
  return current;
}

function readRegularFileWithoutFollowingReplacement(path: string): string {
  let expected: ReturnType<typeof lstatSync>;
  try {
    expected = lstatSync(path);
  } catch (error) {
    if (isMissing(error)) return "";
    throw error;
  }
  if (expected.isSymbolicLink()) {
    throw new Error(`Refusing to replace symbolic-link output: ${path}`);
  }
  if (!expected.isFile()) {
    throw new Error(`Refusing to replace non-regular output: ${path}`);
  }

  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino) {
      throw new Error(`Output changed while preparing an atomic append: ${path}`);
    }
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function openPrivateTemporaryFile(parent: string): { descriptor: number; path: string } {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const path = join(parent, `.agent-vigil-${randomBytes(16).toString("hex")}.tmp`);
    try {
      const descriptor = openSync(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      return { descriptor, path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`Unable to allocate a private temporary output in ${parent}`);
}

/**
 * Replace a report without following a destination symlink or exposing a
 * partially written file. POSIX files are owner-only; Windows files inherit
 * the destination directory ACL.
 */
export function writePrivateFileAtomic(destination: string, content: string): void {
  const target = validatePrivateFileDestination(destination);
  const parent = dirname(target);
  let descriptor: number | undefined;
  let temporaryPath: string | undefined;
  let failure: unknown;
  try {
    ({ descriptor, path: temporaryPath } = openPrivateTemporaryFile(parent));
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, Buffer.from(content, "utf8"));
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    // Recheck after preparing the complete replacement. Atomic rename never
    // follows a symlink inserted after this check; it replaces that directory
    // entry, so the symlink target still cannot be modified through this path.
    assertReplaceableDestination(target);
    renameSync(temporaryPath, target);
    temporaryPath = undefined;
  } catch (error) {
    failure = error;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch (error) {
        failure ??= error;
      }
    }
    if (temporaryPath !== undefined) {
      try {
        unlinkSync(temporaryPath);
      } catch (error) {
        if (!isMissing(error)) failure ??= error;
      }
    }
  }
  if (failure !== undefined) throw failure;
}

/** Validate an atomic private-file destination without creating or replacing it. */
export function validatePrivateFileDestination(destination: string): string {
  const requested = resolve(destination);
  const parent = resolveSafeParent(requested);
  const target = join(parent, basename(requested));
  assertReplaceableDestination(target);
  return target;
}

/**
 * Create a repository-relative private output without traversing a symlinked
 * parent. This is intentionally separate from the generic atomic writer:
 * most output commands require an existing parent, while portable receipts
 * need to create their conventional `.agent-vigil` directory on first use.
 */
export function writePrivateFileAtomicWithin(root: string, destination: string, content: string): void {
  if (!destination || destination.includes("\0") || isAbsolute(destination) || win32.isAbsolute(destination)) {
    throw new Error(`Private repository output must be a relative path: ${destination}`);
  }
  const canonicalRoot = realpathSync(resolve(root));
  const rootStatus = lstatSync(canonicalRoot, { bigint: true });
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    throw new Error(`Private repository output root must be a non-symlink directory: ${canonicalRoot}`);
  }
  const target = resolve(canonicalRoot, normalize(destination));
  const repositoryPath = relative(canonicalRoot, target);
  if (!repositoryPath || repositoryPath === ".." || repositoryPath.startsWith(`..${sep}`) || isAbsolute(repositoryPath)) {
    throw new Error(`Private repository output escapes its repository: ${destination}`);
  }

  let current = canonicalRoot;
  for (const component of dirname(repositoryPath).split(sep).filter((item) => item && item !== ".")) {
    const next = join(current, component);
    try {
      const status = lstatSync(next);
      if (status.isSymbolicLink() || !status.isDirectory()) {
        throw new Error(`Refusing to traverse unsafe private output parent: ${next}`);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      mkdirSync(next, { mode: 0o700 });
      const status = lstatSync(next);
      if (status.isSymbolicLink() || !status.isDirectory()) {
        throw new Error(`Refusing to traverse unsafe private output parent: ${next}`);
      }
    }
    current = next;
  }
  writePrivateFileAtomic(target, content);
}

/**
 * Create a new owner-only file without replacing an existing directory entry.
 * This is used for append-only evidence where replacement would erase history.
 */
export function writePrivateFileExclusive(destination: string, content: string): void {
  const requested = resolve(destination);
  const parent = resolveSafeParent(requested);
  const target = join(parent, basename(requested));
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let descriptor: number | undefined;
  let failure: unknown;
  try {
    descriptor = openSync(
      target,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, Buffer.from(content, "utf8"));
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    failure = error;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch (error) {
        failure ??= error;
      }
    }
  }
  if (failure !== undefined) throw failure;
}

export type PrivateFileSink = {
  path: string;
  write: (bytes: Buffer) => Promise<void>;
  close: () => Promise<void>;
};

export type AsyncDescriptorSink = {
  queuedBytes: () => number;
  write: (bytes: Buffer) => Promise<void>;
  flush: () => Promise<void>;
};

function writeBuffer(descriptor: number, bytes: Buffer): Promise<void> {
  return new Promise((resolveWrite, rejectWrite) => {
    const writeNext = (offset: number): void => {
      if (offset === bytes.length) {
        resolveWrite();
        return;
      }
      write(descriptor, bytes, offset, bytes.length - offset, null, (error, written) => {
        if (error) {
          rejectWrite(error);
          return;
        }
        if (written <= 0) {
          rejectWrite(new Error("Output descriptor write made no progress"));
          return;
        }
        writeNext(offset + written);
      });
    };
    writeNext(0);
  });
}

function flushDescriptor(descriptor: number): Promise<void> {
  return new Promise((resolveFlush, rejectFlush) => {
    fsync(descriptor, (error) => error ? rejectFlush(error) : resolveFlush());
  });
}

function closeDescriptor(descriptor: number): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    close(descriptor, (error) => error ? rejectClose(error) : resolveClose());
  });
}

/**
 * Queue writes to an existing descriptor without blocking the caller's event
 * loop. The descriptor remains owned by the caller and is never closed here.
 */
export function createAsyncDescriptorSink(descriptor: number): AsyncDescriptorSink {
  if (!Number.isSafeInteger(descriptor) || descriptor < 0) {
    throw new Error("Output descriptor must be a non-negative integer");
  }
  let pending = Promise.resolve();
  let queuedByteCount = 0;
  return {
    queuedBytes: () => queuedByteCount,
    write(bytes: Buffer): Promise<void> {
      const copy = Buffer.from(bytes);
      queuedByteCount += copy.length;
      const operation = pending
        .then(() => writeBuffer(descriptor, copy))
        .finally(() => { queuedByteCount -= copy.length; });
      pending = operation;
      return operation;
    },
    flush: () => pending,
  };
}

/**
 * Open a new owner-only regular file for bounded streaming output. The caller
 * must close the sink; close flushes the file before releasing its descriptor.
 */
export function createPrivateFileSink(destination: string): PrivateFileSink {
  const requested = resolve(destination);
  const parent = resolveSafeParent(requested);
  const target = join(parent, basename(requested));
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(
    target,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
    0o600,
  );
  let accepting = true;
  let pending = Promise.resolve();
  let closePromise: Promise<void> | undefined;
  try {
    fchmodSync(descriptor, 0o600);
  } catch (error) {
    closeSync(descriptor);
    try { unlinkSync(target); } catch { /* Preserve the original failure. */ }
    throw error;
  }
  return {
    path: target,
    write(bytes: Buffer): Promise<void> {
      if (!accepting) return Promise.reject(new Error(`Private output is already closed: ${target}`));
      const copy = Buffer.from(bytes);
      const operation = pending.then(() => writeBuffer(descriptor, copy));
      pending = operation;
      return operation;
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      accepting = false;
      closePromise = (async () => {
        let failure: unknown;
        try { await pending; } catch (error) { failure = error; }
        try { await flushDescriptor(descriptor); } catch (error) { failure ??= error; }
        try { await closeDescriptor(descriptor); } catch (error) { failure ??= error; }
        if (failure !== undefined) throw failure;
      })();
      return closePromise;
    },
  };
}

export function appendPrivateFileAtomic(destination: string, content: string): void {
  const requested = resolve(destination);
  const parent = resolveSafeParent(requested);
  const target = join(parent, basename(requested));
  const existing = readRegularFileWithoutFollowingReplacement(target);
  writePrivateFileAtomic(target, `${existing}${content}`);
}

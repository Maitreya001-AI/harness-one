/**
 * TOCTOU-safe file reading — {@link safeReadFile}.
 *
 * Every fs-touching tool that wants to enforce a "regular file"
 * constraint OR a `maxBytes` cap before reading must NOT do
 * `fs.stat()` → `fs.open()/readFile()` in two separate syscalls. An
 * attacker who controls the workspace can swap the path between the
 * stat and the open (CWE-367 Time-of-check Time-of-use Race
 * Condition). GitHub CodeQL's `js/file-system-race` rule flags this
 * exact pattern.
 *
 * `apps/coding-agent` discovered this via CodeQL high-severity alerts
 * on PR #33 (HARNESS_LOG HC-018). The fix in every call-site was the
 * same: open first, stat the resulting file descriptor. This module
 * centralises the idiom so downstream apps inherit the safe pattern
 * automatically.
 *
 * @module
 */

import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

import { HarnessError, HarnessErrorCode } from '../infra/errors-base.js';

/**
 * What kind of file the caller is willing to accept. Default `'file'` —
 * regular files only, the safest choice for tools that surface contents
 * back to the model.
 *
 * - `'file'` — directories, FIFOs, sockets, devices etc. all reject with
 *   `IO_NOT_REGULAR_FILE`. Symlinks are OK provided the realpath landed
 *   on a regular file.
 * - `'any'` — accept whatever opens successfully, only `maxBytes` is
 *   enforced. Useful for low-level readers (tar inspectors, etc.).
 */
export type SafeReadKind = 'file' | 'any';

/** Options for {@link safeReadFile}. */
export interface SafeReadFileOptions {
  /**
   * Maximum bytes to read before throwing `IO_FILE_TOO_LARGE`. Omitted
   * means "no cap" (only memory bounds the read). Set this on every
   * LLM-driven path — uncapped reads are how a 4 GB log file slips
   * straight into the context window.
   */
  readonly maxBytes?: number;
  /**
   * Required file kind. Default `'file'` — see {@link SafeReadKind}.
   */
  readonly requireFileKind?: SafeReadKind;
  /**
   * Output encoding. Defaults to `'utf8'` returning a string. Pass
   * `'buffer'` to receive a `Buffer` for binary data.
   */
  readonly encoding?: 'utf8' | 'buffer';
  /**
   * When `true` and the file exceeds `maxBytes`, return the first
   * `maxBytes` bytes with `truncated: true` instead of throwing
   * `IO_FILE_TOO_LARGE`. Default `false`.
   *
   * Use `true` for tool surfaces that surface "first N bytes of large
   * file" with an explicit truncation flag back to the LLM. Use `false`
   * (the default) for callers that want loud failure on any oversize
   * read.
   */
  readonly truncateOnOverflow?: boolean;
}

/**
 * Result of a successful {@link safeReadFile} call.
 *
 * - `content` is the file body decoded per `encoding`.
 * - `bytesRead` is the actual number of bytes pulled from disk.
 *   Identical to `Buffer.byteLength(content)` when `encoding === 'buffer'`.
 * - `truncated` is `true` when the file was larger than `maxBytes` AND
 *   the caller opted into truncation by passing
 *   `truncateOnOverflow: true`. With the default behaviour this is
 *   never set because oversize reads throw instead.
 */
export interface SafeReadFileResult<T extends string | Buffer = string | Buffer> {
  readonly content: T;
  readonly bytesRead: number;
  readonly totalBytes: number;
  readonly truncated: boolean;
}

/**
 * Read the contents of a regular file, defending against the TOCTOU
 * race that arises when `fs.stat()` and `fs.open()` are separate
 * syscalls. The implementation always opens first, then stats the
 * resulting file descriptor, so a swap-between-syscalls attack cannot
 * succeed.
 *
 * Pre-conditions:
 *   - `absPath` should already be a workspace-contained absolute path.
 *     Pair this function with {@link resolveWithinRoot} from
 *     `harness-one/io/path-safety` for the full safe-read pipeline.
 *
 * Failure semantics:
 *   - File does not exist → the underlying `ENOENT` propagates.
 *   - File exceeds `maxBytes` → throws `IO_FILE_TOO_LARGE`.
 *   - File is not a regular file (and `requireFileKind` is `'file'`) →
 *     throws `IO_NOT_REGULAR_FILE`.
 *
 * The returned `truncated` field is always `false` in the default
 * configuration; oversize reads throw. (A future opt-in
 * `truncateOnOverflow: true` switch can keep the field meaningful.)
 *
 * @example
 * ```ts
 * const safe = await resolveWithinRoot(workspace, userPath);
 * const { content } = await safeReadFile(safe, { maxBytes: 64 * 1024 });
 * ```
 */
export async function safeReadFile(
  absPath: string,
  options?: SafeReadFileOptions & { encoding?: 'utf8' },
): Promise<SafeReadFileResult<string>>;
export async function safeReadFile(
  absPath: string,
  options: SafeReadFileOptions & { encoding: 'buffer' },
): Promise<SafeReadFileResult<Buffer>>;
export async function safeReadFile(
  absPath: string,
  options?: SafeReadFileOptions,
): Promise<SafeReadFileResult> {
  if (typeof absPath !== 'string' || absPath.length === 0) {
    throw new HarnessError(
      'safeReadFile: path must be a non-empty string',
      HarnessErrorCode.IO_PATH_INVALID,
      'Resolve the path via resolveWithinRoot() before calling safeReadFile',
    );
  }

  const requireKind: SafeReadKind = options?.requireFileKind ?? 'file';
  const encoding = options?.encoding ?? 'utf8';
  const maxBytes = options?.maxBytes;

  if (maxBytes !== undefined && (!Number.isInteger(maxBytes) || maxBytes < 0)) {
    throw new HarnessError(
      `safeReadFile: maxBytes must be a non-negative integer, got ${String(maxBytes)}`,
      HarnessErrorCode.CORE_INVALID_INPUT,
      'Pass an integer >= 0 or omit the option for unbounded reads',
    );
  }

  // Open FIRST. Every subsequent check operates on the resulting file
  // descriptor — this is what defeats CWE-367. If the path is swapped
  // after we open, our `fh` keeps pointing at the inode we opened.
  const fh: FileHandle = await fs.open(absPath, 'r');
  try {
    const stat = await fh.stat();
    if (requireKind === 'file' && !stat.isFile()) {
      throw new HarnessError(
        `Refusing to read non-regular path "${absPath}" (kind=${describeKind(stat)})`,
        HarnessErrorCode.IO_NOT_REGULAR_FILE,
        'safeReadFile only reads regular files. Pass requireFileKind: "any" to override.',
      );
    }

    const totalBytes = stat.size;
    const truncateOnOverflow = options?.truncateOnOverflow === true;
    const overflows = maxBytes !== undefined && totalBytes > maxBytes;

    if (overflows && !truncateOnOverflow) {
      throw new HarnessError(
        `File is ${totalBytes} bytes, exceeds maxBytes ${maxBytes}: ${absPath}`,
        HarnessErrorCode.IO_FILE_TOO_LARGE,
        'Increase maxBytes, pass truncateOnOverflow: true to receive a clipped read, or stream the file via a different API.',
      );
    }

    // How many bytes we will actually pull off disk.
    const readCap = maxBytes !== undefined ? Math.min(totalBytes, maxBytes) : totalBytes;

    if (readCap === 0) {
      // Zero-byte file (or maxBytes === 0)
      const empty: string | Buffer = encoding === 'buffer' ? Buffer.alloc(0) : '';
      return Object.freeze({
        content: empty,
        bytesRead: 0,
        totalBytes,
        truncated: overflows,
      });
    }

    const buf = Buffer.alloc(readCap);
    const { bytesRead } = await fh.read(buf, 0, readCap, 0);
    // Short-read recovery: keep reading until we either fill the buffer
    // or the file reports EOF. Some filesystems (NFS, FUSE) legally
    // return short reads even when more bytes are available.
    let cursor = bytesRead;
    while (cursor < readCap) {
      const next = await fh.read(buf, cursor, readCap - cursor, cursor);
      if (next.bytesRead === 0) break;
      cursor += next.bytesRead;
    }
    const finalBytes = cursor;
    const slice = buf.subarray(0, finalBytes);
    const content: string | Buffer = encoding === 'buffer' ? slice : slice.toString('utf8');
    return Object.freeze({
      content,
      bytesRead: finalBytes,
      totalBytes,
      truncated: overflows,
    });
  } finally {
    await fh.close().catch(() => {
      /* close failure is non-fatal — the read either succeeded or threw above */
    });
  }
}

/**
 * Best-effort name for the file's kind, used in error messages so
 * operators see "directory" not "stat object".
 */
function describeKind(stat: { isDirectory(): boolean; isSymbolicLink(): boolean; isFIFO(): boolean; isSocket(): boolean; isBlockDevice(): boolean; isCharacterDevice(): boolean }): string {
  if (stat.isDirectory()) return 'directory';
  if (stat.isFIFO()) return 'fifo';
  if (stat.isSocket()) return 'socket';
  if (stat.isBlockDevice()) return 'block-device';
  if (stat.isCharacterDevice()) return 'character-device';
  if (stat.isSymbolicLink()) return 'symlink';
  return 'unknown-non-file';
}

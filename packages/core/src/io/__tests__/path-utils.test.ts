import { describe, it, expect } from 'vitest';
import { splitPath, toPosix, toFileUri } from '../path-utils.js';

describe('splitPath', () => {
  it('splits POSIX paths', () => {
    expect(splitPath('a/b/c')).toEqual(['a', 'b', 'c']);
  });

  it('splits Windows-style paths', () => {
    expect(splitPath('a\\b\\c')).toEqual(['a', 'b', 'c']);
  });

  it('splits mixed paths so sensitive-name predicates never miss', () => {
    expect(splitPath('home/.aws\\credentials')).toEqual(['home', '.aws', 'credentials']);
  });

  it('elides empty segments from leading/trailing separators', () => {
    expect(splitPath('/a/b/')).toEqual(['a', 'b']);
    expect(splitPath('\\a\\b\\')).toEqual(['a', 'b']);
  });

  it('elides empty segments from repeated separators', () => {
    expect(splitPath('a//b\\\\c')).toEqual(['a', 'b', 'c']);
  });

  it('returns [] for empty string', () => {
    expect(splitPath('')).toEqual([]);
  });

  it('returns [] for non-string', () => {
    // @ts-expect-error — exercising the runtime input guard — runtime guard
    expect(splitPath(undefined)).toEqual([]);
    // @ts-expect-error — exercising the runtime input guard — runtime guard
    expect(splitPath(null)).toEqual([]);
  });
});

describe('toPosix', () => {
  it('converts Windows paths to POSIX', () => {
    expect(toPosix('C:\\Users\\me\\repo')).toBe('C:/Users/me/repo');
  });

  it('is idempotent for already-POSIX paths', () => {
    expect(toPosix('/tmp/ws/a.ts')).toBe('/tmp/ws/a.ts');
  });

  it('handles mixed separators', () => {
    expect(toPosix('/tmp\\ws/a.ts')).toBe('/tmp/ws/a.ts');
  });

  it('preserves drive letters and colons', () => {
    expect(toPosix('D:\\a\\b')).toBe('D:/a/b');
  });

  it('returns empty string for non-string input', () => {
    // @ts-expect-error — exercising the runtime input guard
    expect(toPosix(undefined)).toBe('');
    // @ts-expect-error — exercising the runtime input guard
    expect(toPosix(123)).toBe('');
  });
});

describe('toFileUri', () => {
  it('builds POSIX URIs from POSIX paths', () => {
    expect(toFileUri('/tmp/ws', 'a.ts')).toBe('file:///tmp/ws/a.ts');
  });

  it('builds POSIX URIs from Windows-shaped workspaces (golden Windows behaviour)', () => {
    // Even though we cannot natively test on Windows from a macOS CI box,
    // the function MUST produce the same shape regardless of host. Both
    // separators in the input are normalised in the output.
    expect(toFileUri('C:\\dev\\ws', 'src\\main.ts')).toBe(
      'file:///C:/dev/ws/src/main.ts',
    );
  });

  it('emits triple-slash for Windows absolute paths', () => {
    expect(toFileUri('C:\\dev\\ws', '.')).toMatch(/^file:\/\/\/C:\//);
  });

  it('handles absolute relativePath by ignoring the workspace', () => {
    expect(toFileUri('/x', '/abs/elsewhere.ts')).toBe('file:///abs/elsewhere.ts');
  });

  it('handles trailing slash in workspace', () => {
    expect(toFileUri('/tmp/ws/', 'a.ts')).toBe('file:///tmp/ws/a.ts');
  });

  it('handles leading slash in relative path', () => {
    // A leading `/` makes it absolute on POSIX — workspace is ignored.
    expect(toFileUri('/tmp/ws', '/abs/path.ts')).toBe('file:///abs/path.ts');
  });

  it('handles repeated separators by collapsing in the join', () => {
    expect(toFileUri('/tmp/ws//', 'sub//a.ts')).toBe('file:///tmp/ws/sub/a.ts');
  });

  it('throws on empty workspace', () => {
    expect(() => toFileUri('', 'a.ts')).toThrow(TypeError);
  });

  it('throws on non-string relativePath', () => {
    // @ts-expect-error — exercising the runtime input guard
    expect(() => toFileUri('/tmp', 123)).toThrow(TypeError);
  });

  it('NEVER produces a backslash in the URI body — LSP rejects them', () => {
    const uri = toFileUri('C:\\a\\b', 'c\\d.ts');
    expect(uri.includes('\\')).toBe(false);
  });
});

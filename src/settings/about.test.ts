import { describe, expect, test } from 'vitest';

import type { License, ToolId } from '../ipc/types';
import { filterLicenses, MANAGED_VERSION, parseVersions, withToolVersions } from './about';

describe('parseVersions', () => {
  const REPORT = [
    'Kaleido: 0.1.0',
    'libmpv: mpv v0.41.0-241-gaccb7b2821',
    'FFmpeg: N-118000-g1234567',
    'Windows: 10.0.26200',
    'GPU: NVIDIA GeForce RTX 4070',
    'Plugins: thumbfast 0f711de (bundled), uosc - (manual)',
    '',
  ].join('\n');

  test('reads libmpv and FFmpeg from their lines', () => {
    expect(parseVersions(REPORT)).toEqual({
      libmpv: 'mpv v0.41.0-241-gaccb7b2821',
      ffmpeg: 'N-118000-g1234567',
    });
  });

  test('reads Windows line endings too', () => {
    expect(parseVersions(REPORT.replaceAll('\n', '\r\n'))).toEqual({
      libmpv: 'mpv v0.41.0-241-gaccb7b2821',
      ffmpeg: 'N-118000-g1234567',
    });
  });

  test('what Rust could not find out is unknown, not a version', () => {
    expect(parseVersions('libmpv: unknown\nFFmpeg: Unknown\n')).toEqual({ libmpv: null, ffmpeg: null });
    expect(parseVersions('libmpv: \nFFmpeg:\n')).toEqual({ libmpv: null, ffmpeg: null });
  });

  test('a line that is not there is no answer', () => {
    expect(parseVersions('')).toEqual({ libmpv: null, ffmpeg: null });
    expect(parseVersions('Kaleido: 0.1.0\nGPU: none\n')).toEqual({ libmpv: null, ffmpeg: null });
    // Only the line of the name counts, not a line that mentions it.
    expect(parseVersions('Plugins: libmpv: 1\n')).toEqual({ libmpv: null, ffmpeg: null });
  });

  test('a version may hold colons', () => {
    expect(parseVersions('libmpv: mpv: v0.41\n').libmpv).toBe('mpv: v0.41');
  });
});

describe('filterLicenses', () => {
  const all: License[] = [
    { name: 'libmpv', version: '0.41.0', license: 'GPL-3.0-or-later', url: 'https://mpv.io' },
    { name: 'zustand', version: '5.0.15', license: 'MIT', url: 'https://github.com/pmndrs/zustand' },
    { name: 'serde', version: '1.0.200', license: 'MIT OR Apache-2.0', url: 'https://serde.rs' },
  ];
  const names = (found: License[]) => found.map((entry) => entry.name);

  test('no words match everything', () => {
    expect(names(filterLicenses(all, ''))).toEqual(['libmpv', 'zustand', 'serde']);
    expect(names(filterLicenses(all, '  '))).toEqual(['libmpv', 'zustand', 'serde']);
  });

  test('finds by the name, the version, the license and the address, in any case', () => {
    expect(names(filterLicenses(all, 'ZUSTAND'))).toEqual(['zustand']);
    expect(names(filterLicenses(all, '0.41'))).toEqual(['libmpv']);
    expect(names(filterLicenses(all, 'mit'))).toEqual(['zustand', 'serde']);
    expect(names(filterLicenses(all, 'gpl'))).toEqual(['libmpv']);
    expect(names(filterLicenses(all, 'serde.rs'))).toEqual(['serde']);
  });

  test('every word has to occur', () => {
    expect(names(filterLicenses(all, 'mit apache'))).toEqual(['serde']);
    expect(filterLicenses(all, 'mit gpl')).toEqual([]);
  });
});

describe('withToolVersions', () => {
  const entry = (name: string, version: string): License => ({
    name,
    version,
    license: 'MIT',
    url: `https://example.org/${name}`,
  });
  const versionOf = (tool: ToolId): string => (tool === 'ytDlp' ? '2026.08.19' : '2.9.7');

  test('puts the version of yt-dlp and Deno in place of the word the file has', () => {
    expect(MANAGED_VERSION).toBe('managed');
    const found = withToolVersions(
      [entry('libmpv', 'git-accb7b2821'), entry('yt-dlp', 'managed'), entry('Deno', 'managed')],
      versionOf,
    );
    expect(found.map((each) => [each.name, each.version])).toEqual([
      ['libmpv', 'git-accb7b2821'],
      ['yt-dlp', '2026.08.19'],
      ['Deno', '2.9.7'],
    ]);
    // The rest of the entry is as it was.
    expect(found[1]).toEqual({ ...entry('yt-dlp', '2026.08.19') });
  });

  test('leaves alone what is not a managed tool, and a tool that has a version already', () => {
    const own = [
      entry('serde', 'managed'),
      entry('yt-dlp', '2026.01.01'),
      entry('constructor', 'managed'),
    ];
    expect(withToolVersions(own, versionOf)).toEqual(own);
  });

  test('does not change the list it is given', () => {
    const list = [entry('yt-dlp', 'managed')];
    withToolVersions(list, versionOf);
    expect(list[0]?.version).toBe('managed');
  });
});

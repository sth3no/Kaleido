import { describe, expect, test } from 'vitest';

import { currentEntryName, knownTitle, linkHost, nameOfFile } from './entryName';

const entries = (...list: { filename: string; title?: string; current?: boolean }[]) => ({
  playlist: list,
});

describe('linkHost', () => {
  test('is the host of a link, with its port and never its user name or password', () => {
    expect(linkHost('https://example.com/watch?v=abc')).toBe('example.com');
    expect(linkHost('https://user:secret@example.com:8080/x')).toBe('example.com:8080');
  });

  test('is null for a path', () => {
    expect(linkHost('C:\\Videa\\a.mkv')).toBeNull();
    expect(linkHost('\\\\server\\share\\a.mkv')).toBeNull();
    expect(linkHost('file:///C:/Videa/a.mkv')).toBeNull();
    expect(linkHost('not a url')).toBeNull();
    expect(linkHost('')).toBeNull();
  });
});

describe('currentEntryName', () => {
  test('is the file name of the current entry', () => {
    expect(
      currentEntryName(
        entries(
          { filename: 'C:\\Videa\\jiný.mkv' },
          { filename: 'C:\\Videa (2026)\\žluťoučký kůň.mkv', current: true },
        ),
      ),
    ).toBe('žluťoučký kůň.mkv');
  });

  test('shows a long path without its \\\\?\\ prefix', () => {
    expect(currentEntryName(entries({ filename: '\\\\?\\C:\\Videa\\a.mkv', current: true }))).toBe('a.mkv');
    expect(
      currentEntryName(entries({ filename: '\\\\?\\UNC\\server\\share\\b.mkv', current: true })),
    ).toBe('b.mkv');
  });

  test('is the host of a link that has no title yet', () => {
    expect(
      currentEntryName(entries({ filename: 'https://example.com/watch?v=abc', current: true })),
    ).toBe('example.com');
    expect(currentEntryName(entries({ filename: 'https://example.com/', current: true }))).toBe(
      'example.com',
    );
  });

  test('is the title the playlist gives, also to a link', () => {
    expect(
      currentEntryName(
        entries({ filename: 'https://example.com/watch?v=abc', title: 'A talk', current: true }),
      ),
    ).toBe('A talk');
  });

  test('is empty without a current entry, and without a playlist', () => {
    expect(currentEntryName(entries({ filename: 'a.mkv' }))).toBe('');
    expect(currentEntryName({})).toBe('');
    expect(currentEntryName({ playlist: null })).toBe('');
  });
});

describe('nameOfFile', () => {
  test('is the file name, without the prefix of a long path', () => {
    expect(nameOfFile('C:\\Videa (2026)\\žluťoučký kůň.mkv')).toBe('žluťoučký kůň.mkv');
    expect(nameOfFile('\\\\?\\C:\\Videa\\a.mkv')).toBe('a.mkv');
    expect(nameOfFile('\\\\server\\share\\b.mkv')).toBe('b.mkv');
  });

  test('is the host of a link, not the tail of its address', () => {
    expect(nameOfFile('https://example.com/watch?v=abc')).toBe('example.com');
    expect(nameOfFile('https://user:secret@example.com:8080/x')).toBe('example.com:8080');
  });

  test('is empty where Rust does not know the file', () => {
    expect(nameOfFile(null)).toBe('');
    expect(nameOfFile('')).toBe('');
  });
});

describe('knownTitle', () => {
  const link = 'https://example.com/watch?v=abc';

  test('is a title mpv has', () => {
    expect(knownTitle({ 'media-title': 'A talk' })).toBe('A talk');
    expect(knownTitle({ 'media-title': 'A talk', ...entries({ filename: link, current: true }) })).toBe(
      'A talk',
    );
  });

  test('is empty where mpv has answered with the tail of the link, which it does at once', () => {
    const props = (title: string, address = link) => ({
      'media-title': title,
      ...entries({ filename: address, current: true }),
    });
    expect(knownTitle(props('watch?v=abc'))).toBe('');
    // mpv undoes the %-escapes of the tail.
    expect(knownTitle(props('a b.mp4', 'https://example.com/v/a%20b.mp4'))).toBe('');
    // The whole address, and the file name part alone.
    expect(knownTitle(props(link))).toBe('');
    expect(knownTitle(props('watch'))).toBe('');
  });

  test('keeps the title of a local file, which is its name and a good one', () => {
    expect(
      knownTitle({
        'media-title': 'a.mkv',
        ...entries({ filename: 'C:\\Videa\\a.mkv', current: true }),
      }),
    ).toBe('a.mkv');
  });

  test('is empty without a title, and shows a long path without its prefix', () => {
    expect(knownTitle({})).toBe('');
    expect(knownTitle({ 'media-title': '' })).toBe('');
    expect(knownTitle({ 'media-title': '\\\\?\\C:\\Videa\\a.mkv' })).toBe('C:\\Videa\\a.mkv');
  });
});

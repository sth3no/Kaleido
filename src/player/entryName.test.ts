import { describe, expect, test } from 'vitest';

import { currentEntryName, linkHost } from './entryName';

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

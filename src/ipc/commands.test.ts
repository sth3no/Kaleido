import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { decodeThumb, settingsSet, systemUiReady, thumbGet } from './commands';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

/** What `thumb_get` answers for a preview of `width` × `height`: the sizes, then the pixels. */
function frame(width: number, height: number, pixels = new Uint8Array(width * height * 4)): ArrayBuffer {
  const bytes = new Uint8Array(8 + pixels.length);
  new DataView(bytes.buffer).setUint32(0, width, true);
  new DataView(bytes.buffer).setUint32(4, height, true);
  bytes.set(pixels, 8);
  return bytes.buffer;
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('thumbGet', () => {
  test('is null before the first preview, when Rust answers with no bytes', async () => {
    vi.mocked(invoke).mockResolvedValue(new ArrayBuffer(0));
    expect(await thumbGet()).toBeNull();
    expect(invoke).toHaveBeenCalledWith('thumb_get');
  });

  test('is null for less than the 8 bytes of the header', () => {
    for (const length of [0, 1, 7]) expect(decodeThumb(new ArrayBuffer(length))).toBeNull();
  });

  test('reads the width, the height and the pixels', async () => {
    const pixels = Uint8Array.from([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255, 13, 14, 15, 255, 16, 17, 18, 255]);
    vi.mocked(invoke).mockResolvedValue(frame(3, 2, pixels));

    const thumb = await thumbGet();
    expect(thumb).not.toBeNull();
    expect(thumb?.width).toBe(3);
    expect(thumb?.height).toBe(2);
    expect(thumb?.rgba).toBeInstanceOf(Uint8ClampedArray);
    expect(Array.from(thumb?.rgba ?? [])).toEqual(Array.from(pixels));
  });

  test('the sizes are little-endian', () => {
    // 0x0102 wide, 1 high: 258 × 1 × 4 bytes of pixels.
    const thumb = decodeThumb(frame(0x0102, 1));
    expect(thumb?.width).toBe(258);
    expect(thumb?.height).toBe(1);
    expect(thumb?.rgba).toHaveLength(258 * 4);
  });

  test('is null, and says so, when the pixels do not fit the size', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const short = frame(2, 2, new Uint8Array(15));
    expect(decodeThumb(short)).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  test('is null, and says so, for an answer that is not bytes', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(decodeThumb(undefined)).toBeNull();
    expect(decodeThumb([1, 2, 3])).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('the wrappers', () => {
  test('a command without arguments is called with its name only', async () => {
    vi.mocked(invoke).mockResolvedValue({ pause: true });
    expect(await systemUiReady()).toEqual({ pause: true });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('system_ui_ready');
  });

  test('a rejection from Rust comes through as it is', async () => {
    const rejection = { type: 'invalid', key: 'appearance.blur', reason: 'from 0 to 40' };
    vi.mocked(invoke).mockRejectedValue(rejection);
    await expect(settingsSet({ appearance: { blur: 99 } })).rejects.toBe(rejection);
    expect(invoke).toHaveBeenCalledWith('settings_set', { patch: { appearance: { blur: 99 } } });
  });
});

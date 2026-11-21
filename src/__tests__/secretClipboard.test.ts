import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SECRET_CLIPBOARD_MS,
  copySecret,
  forgetSecretClipboard,
  writeClipboard,
} from 'src/utils/secretClipboard';

const PHRASE = 'alpha beta gamma';
let held = '';
let readable = false;
let focused = true;
const writeText = vi.fn(async (text: string) => {
  held = text;
});
const readText = vi.fn(async () => held);

const pass = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
};

beforeEach(() => {
  vi.useFakeTimers();
  held = '';
  readable = false;
  focused = true;
  writeText.mockClear();
  readText.mockClear();
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText, readText },
    configurable: true,
  });
  Object.defineProperty(navigator, 'permissions', {
    value: { query: async () => ({ state: readable ? 'granted' : 'prompt' }) },
    configurable: true,
  });
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
});

afterEach(() => {
  forgetSecretClipboard();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('secret clipboard', () => {
  it('writes the secret and leaves it for 60 seconds', async () => {
    expect(await copySecret(PHRASE)).toBe(true);
    expect(held).toBe(PHRASE);
    await pass(SECRET_CLIPBOARD_MS - 1);
    expect(held).toBe(PHRASE);
  });

  it('clears after 60 seconds when the page kept focus and nothing else was copied', async () => {
    await copySecret(PHRASE);
    await pass(SECRET_CLIPBOARD_MS);
    expect(held).toBe('');
    expect(readText).not.toHaveBeenCalled();
  });

  it('leaves the clipboard alone when focus was lost and it cannot be read', async () => {
    await copySecret(PHRASE);
    window.dispatchEvent(new Event('blur'));
    held = 'copied elsewhere';
    await pass(SECRET_CLIPBOARD_MS);
    expect(held).toBe('copied elsewhere');
  });

  it('reads back when allowed and clears only an unchanged clipboard', async () => {
    readable = true;
    await copySecret(PHRASE);
    window.dispatchEvent(new Event('blur'));
    await pass(SECRET_CLIPBOARD_MS);
    expect(readText).toHaveBeenCalledTimes(1);
    expect(held).toBe('');
  });

  it('reads back when allowed and keeps a changed clipboard', async () => {
    readable = true;
    await copySecret(PHRASE);
    held = 'something newer';
    await pass(SECRET_CLIPBOARD_MS);
    expect(held).toBe('something newer');
  });

  it('waits for focus before reading back', async () => {
    readable = true;
    await copySecret(PHRASE);
    focused = false;
    window.dispatchEvent(new Event('blur'));
    await pass(SECRET_CLIPBOARD_MS);
    expect(held).toBe(PHRASE);
    focused = true;
    window.dispatchEvent(new Event('focus'));
    await pass(0);
    expect(held).toBe('');
  });

  it('never clears after another copy from the wallet', async () => {
    await copySecret(PHRASE);
    await writeClipboard('oct1address');
    await pass(SECRET_CLIPBOARD_MS);
    expect(held).toBe('oct1address');
  });

  it('never clears after a manual copy on the page', async () => {
    await copySecret(PHRASE);
    document.dispatchEvent(new Event('copy'));
    held = 'selected text';
    await pass(SECRET_CLIPBOARD_MS);
    expect(held).toBe('selected text');
  });

  it('restarts the 60 seconds on a second secret copy', async () => {
    await copySecret(PHRASE);
    await pass(SECRET_CLIPBOARD_MS - 1000);
    await copySecret('second secret');
    await pass(1000);
    expect(held).toBe('second secret');
    await pass(SECRET_CLIPBOARD_MS);
    expect(held).toBe('');
  });

  it('reports a failed write and schedules nothing', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'));
    expect(await copySecret(PHRASE)).toBe(false);
    await pass(SECRET_CLIPBOARD_MS);
    expect(writeText).toHaveBeenCalledTimes(1);
  });
});

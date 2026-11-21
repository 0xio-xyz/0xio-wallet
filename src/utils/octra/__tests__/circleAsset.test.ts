// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  CIRCLE_CHUNK_FORMAT,
  CIRCLE_CHUNK_MANIFEST_TYPE,
  bytesToB64,
  resolveCircleAsset,
  resolveCircleAssetReply,
} from '../circleAsset';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const utf8 = (s: string) => new TextEncoder().encode(s);

function chunked(body: Uint8Array, parts: Uint8Array[]) {
  const digest = hex(sha256(body));
  const chunks = parts.map((p, i) => ({
    path: `/.octra/chunks/${digest}/${String(i).padStart(4, '0')}`,
    sha256: hex(sha256(p)),
    size_bytes: String(p.length),
  }));
  const manifest: Record<string, any> = {
    format: CIRCLE_CHUNK_FORMAT,
    content_type: 'text/html',
    encoding: 'identity',
    sha256: digest,
    size_bytes: String(body.length),
    chunks,
  };
  const files: Record<string, any> = {
    '/index.html': {
      content_type: CIRCLE_CHUNK_MANIFEST_TYPE,
      body_b64: bytesToB64(utf8(JSON.stringify(manifest))),
    },
  };
  chunks.forEach((c, i) => {
    files[c.path] = { content_type: 'application/octet-stream', body_b64: bytesToB64(parts[i]) };
  });
  return { files, manifest };
}

const setManifest = (files: Record<string, any>, manifest: unknown) => {
  files['/index.html'].body_b64 = bytesToB64(utf8(JSON.stringify(manifest)));
};
const resolve = (files: Record<string, any>) =>
  resolveCircleAsset(async (p) => files[p] ?? null, '/index.html');

describe('resolveCircleAsset', () => {
  it('reads a plain file from body_b64', async () => {
    const out = await resolveCircleAsset(
      async () => ({ content_type: 'text/html', body_b64: bytesToB64(utf8('<p>héllo</p>')) }),
      '/index.html'
    );
    expect(out?.contentType).toBe('text/html');
    expect(new TextDecoder().decode(out!.bytes)).toBe('<p>héllo</p>');
  });

  it('falls back to data_base64 from older nodes', async () => {
    const out = await resolveCircleAsset(
      async () => ({ content_type: 'text/plain', data_base64: bytesToB64(utf8('hi')) }),
      '/a.txt'
    );
    expect(new TextDecoder().decode(out!.bytes)).toBe('hi');
  });

  it('refuses a plain file over 32 MiB', async () => {
    await expect(
      resolveCircleAsset(
        async () => ({ content_type: 'image/png', body_b64: 'A'.repeat(44739244 + 4) }),
        '/a.png'
      )
    ).rejects.toThrow('Circle asset too large');
  });

  it('assembles and checks a chunked file', async () => {
    const body = utf8('<html>' + 'x'.repeat(50) + '</html>');
    const { files } = chunked(body, [body.subarray(0, 20), body.subarray(20)]);
    const out = await resolve(files);
    expect(out?.contentType).toBe('text/html');
    expect(hex(out!.bytes)).toBe(hex(body));
  });

  it('refuses a chunk that does not match its hash', async () => {
    const body = utf8('abcdefghij');
    const { files } = chunked(body, [body.subarray(0, 5), body.subarray(5)]);
    const second = Object.keys(files)[2];
    files[second] = {
      content_type: 'application/octet-stream',
      body_b64: bytesToB64(utf8('zzzzz')),
    };
    await expect(resolve(files)).rejects.toThrow('Circle chunk verification failed');
  });

  it('refuses a chunk path outside the manifest prefix', async () => {
    const body = utf8('abcdefghij');
    const { files, manifest } = chunked(body, [body]);
    manifest.chunks[0].path = '/secret.html';
    setManifest(files, manifest);
    await expect(resolve(files)).rejects.toThrow('Invalid circle chunk entry');
  });

  it('refuses chunks out of order', async () => {
    const body = utf8('abcdefghij');
    const { files, manifest } = chunked(body, [body.subarray(0, 5), body.subarray(5)]);
    manifest.chunks.reverse();
    setManifest(files, manifest);
    await expect(resolve(files)).rejects.toThrow('Invalid circle chunk entry');
  });

  it('refuses a whole body whose hash does not match', async () => {
    const body = utf8('abcdefghij');
    const { files, manifest } = chunked(body, [body]);
    const other = '0'.repeat(64);
    manifest.sha256 = other;
    manifest.chunks[0].path = `/.octra/chunks/${other}/0000`;
    files[manifest.chunks[0].path] = files[Object.keys(files)[1]];
    setManifest(files, manifest);
    await expect(resolve(files)).rejects.toThrow('Circle asset verification failed');
  });

  it('refuses sizes that do not add up', async () => {
    const body = utf8('abcdefghij');
    const { files, manifest } = chunked(body, [body]);
    manifest.size_bytes = '20';
    setManifest(files, manifest);
    await expect(resolve(files)).rejects.toThrow('Circle asset verification failed');
  });

  it('refuses manifest field variants', async () => {
    const body = utf8('abcdefghij');
    const cases: Array<(m: any) => void> = [
      (m) => (m.format = 'octra.circle.asset.chunks.v2'),
      (m) => (m.encoding = 'gzip'),
      (m) => (m.content_type = ''),
      (m) => (m.content_type = 'text/html\n'),
      (m) => (m.sha256 = m.sha256.toUpperCase()),
      (m) => (m.size_bytes = 10),
      (m) => (m.size_bytes = String(33554432 + 1)),
      (m) => (m.chunks = []),
      (m) => (m.chunks = Array.from({ length: 33 }, () => m.chunks[0])),
    ];
    for (const edit of cases) {
      const { files, manifest } = chunked(body, [body]);
      edit(manifest);
      setManifest(files, manifest);
      await expect(resolve(files)).rejects.toThrow('Invalid circle chunk manifest');
    }
  });

  it('refuses chunk entry variants', async () => {
    const body = utf8('abcdefghij');
    const cases: Array<(c: any) => void> = [
      (c) => (c.size_bytes = '0'),
      (c) => (c.size_bytes = String(2097152 + 1)),
      (c) => (c.size_bytes = '11'),
      (c) => (c.sha256 = 'abc'),
    ];
    for (const edit of cases) {
      const { files, manifest } = chunked(body, [body]);
      edit(manifest.chunks[0]);
      setManifest(files, manifest);
      await expect(resolve(files)).rejects.toThrow('Invalid circle chunk entry');
    }
  });

  it('refuses a non canonical base64 manifest or chunk', async () => {
    const body = utf8('ab');
    const { files } = chunked(body, [body]);
    const chunkPath = Object.keys(files)[1];
    files[chunkPath].body_b64 = 'YWI';
    await expect(resolve(files)).rejects.toThrow('Circle chunk verification failed');
    const fresh = chunked(body, [body]).files;
    fresh['/index.html'].body_b64 = fresh['/index.html'].body_b64.replace(/=*$/, '');
    await expect(resolve(fresh)).rejects.toThrow('Invalid circle chunk manifest');
  });

  it('refuses a chunk with the wrong content type or missing', async () => {
    const body = utf8('abcdefghij');
    const { files } = chunked(body, [body]);
    const chunkPath = Object.keys(files)[1];
    files[chunkPath].content_type = 'text/html';
    await expect(resolve(files)).rejects.toThrow('Circle chunk unavailable');
    delete files[chunkPath];
    await expect(resolve(files)).rejects.toThrow('Circle chunk unavailable');
  });

  it('returns null when the file is missing', async () => {
    expect(await resolveCircleAsset(async () => null, '/index.html')).toBeNull();
  });
});

describe('resolveCircleAssetReply', () => {
  it('passes a plain reply through untouched', async () => {
    const reply = { content_type: 'text/plain', body_b64: bytesToB64(utf8('hi')), blob_hash: 'x' };
    expect(await resolveCircleAssetReply(async () => reply, '/a.txt')).toBe(reply);
  });

  it('answers a chunked file with the assembled body', async () => {
    const body = utf8('<html>' + 'y'.repeat(40) + '</html>');
    const { files } = chunked(body, [body.subarray(0, 10), body.subarray(10)]);
    const out = await resolveCircleAssetReply(async (p) => files[p] ?? null, '/index.html');
    expect(out).toMatchObject({
      content_type: 'text/html',
      encoding: 'identity',
      size_bytes: String(body.length),
      blob_hash: hex(sha256(body)),
      body_b64: bytesToB64(body),
      chunked: true,
      chunks: 2,
    });
  });
});

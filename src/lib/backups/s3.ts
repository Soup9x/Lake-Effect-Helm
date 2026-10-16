/**
 * The three S3 calls a backup needs — put, list, delete — signed with
 * Signature Version 4 by hand.
 *
 * No SDK: the backup image is deliberately small and the surface is three
 * requests against a bucket the operator owns. Path-style addressing, so a
 * MinIO or Ceph endpoint works the same as AWS. Objects are written with
 * a single PUT; a dump that will not fit one PUT (5 GB) is a deployment
 * that should split its retention policy, not a case to multipart here.
 */
import { createHash, createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

export interface S3Target {
  bucket: string;
  prefix: string;
  region: string;
  endpoint: string | null;
  accessKeyId: string;
  secretAccessKey: string;
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();

function hostAndBase(t: S3Target): { host: string; base: string } {
  if (t.endpoint) {
    const u = new URL(t.endpoint);
    return { host: u.host, base: `${u.origin}/${t.bucket}` };
  }
  const host = `s3.${t.region}.amazonaws.com`;
  return { host, base: `https://${host}/${t.bucket}` };
}

const encodeKey = (key: string) => key.split('/').map((p) => encodeURIComponent(p)).join('/');

async function signed(
  t: S3Target,
  method: string,
  key: string,
  query: Record<string, string>,
  body: Buffer | null,
  bodyHash: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const { host, base } = hostAndBase(t);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const date = amzDate.slice(0, 8);
  const canonicalUri = `/${t.bucket}/${encodeKey(key)}`.replace(/\/+$/, key === '' ? '/' : '');
  const canonicalQuery = Object.keys(query).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k]!)}`).join('&');
  const headers: Record<string, string> = {
    host, 'x-amz-content-sha256': bodyHash, 'x-amz-date': amzDate, ...extraHeaders,
  };
  const signedHeaders = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = signedHeaders.map((h) => `${h}:${headers[h] ?? headers[Object.keys(headers).find((k) => k.toLowerCase() === h)!]}`).join('\n');
  const canonicalRequest = [method, canonicalUri, canonicalQuery, `${canonicalHeaders}\n`, signedHeaders.join(';'), bodyHash].join('\n');
  const scope = `${date}/${t.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${t.secretAccessKey}`, date);
  const kRegion = hmac(kDate, t.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${t.accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`;

  const url = `${base}/${encodeKey(key)}${canonicalQuery ? `?${canonicalQuery}` : ''}`;
  const { host: _h, ...sendHeaders } = headers;
  return fetch(url, {
    method,
    headers: { ...sendHeaders, authorization },
    body: body ? new Uint8Array(body) : null,
  });
}

/** Upload a file as `${prefix}/${name}`; returns the object key. */
export async function s3Put(t: S3Target, name: string, path: string): Promise<string> {
  const key = `${t.prefix ? `${t.prefix}/` : ''}${name}`;
  const size = (await stat(path)).size;
  // The payload hash needs the bytes once; read them into memory for the
  // hash and again as a stream for the body.
  const hash = await new Promise<string>((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
  const { readFile } = await import('node:fs/promises');
  const body = await readFile(path);
  const res = await signed(t, 'PUT', key, {}, body, hash, { 'content-length': String(size), 'content-type': 'application/octet-stream' });
  if (!res.ok) throw new Error(`S3 PUT ${key} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return key;
}

/** Keys under the prefix, with their last-modified times. */
export async function s3List(t: S3Target): Promise<{ key: string; lastModified: Date }[]> {
  const out: { key: string; lastModified: Date }[] = [];
  let token: string | undefined;
  do {
    const query: Record<string, string> = { 'list-type': '2', prefix: t.prefix ? `${t.prefix}/` : '', 'max-keys': '1000' };
    if (token) query['continuation-token'] = token;
    const res = await signed(t, 'GET', '', query, null, sha256(''));
    if (!res.ok) throw new Error(`S3 LIST failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = /<Key>([^<]*)<\/Key>/.exec(m[1]!)?.[1];
      const lm = /<LastModified>([^<]*)<\/LastModified>/.exec(m[1]!)?.[1];
      if (key) out.push({ key: decodeXml(key), lastModified: lm ? new Date(lm) : new Date(0) });
    }
    token = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1];
  } while (token);
  return out;
}

export async function s3Delete(t: S3Target, key: string): Promise<void> {
  const res = await signed(t, 'DELETE', key, {}, null, sha256(''));
  if (!res.ok && res.status !== 404) throw new Error(`S3 DELETE ${key} failed: ${res.status}`);
}

const decodeXml = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

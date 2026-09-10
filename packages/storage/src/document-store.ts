/**
 * Document object storage.
 *
 * Invoice bytes never live in Postgres. A 2M-documents/day pipeline at ~200KB
 * each is ~400GB/day; that belongs in object storage, with Postgres holding only
 * the key and the content fingerprint.
 *
 * Two properties matter beyond "put and get":
 *
 *   1. **Write-once.** A document is immutable once stored. The key is derived
 *      from the content hash, so re-storing identical bytes is a no-op and two
 *      different documents can never collide on a key.
 *   2. **Tenant-prefixed keys.** Every key begins with the tenant id, so a
 *      bucket policy or a lifecycle rule can be scoped per tenant, and an
 *      accidental cross-tenant read is visible in an access log rather than
 *      silent.
 */

import { type Readable } from 'node:stream';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { NotFoundError, UpstreamError, ValidationError, type TenantId } from '@onelineflow/core';

export interface DocumentStoreOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** MinIO and most S3-compatible stores need path-style addressing. */
  readonly forcePathStyle: boolean;
  /**
   * Request-level server-side encryption, e.g. 'AES256' or 'aws:kms'.
   *
   * Leave unset when the bucket has DEFAULT encryption configured, which is
   * the better arrangement: it cannot be forgotten by a caller and it covers
   * objects written by anything else too. MinIO rejects this outright unless
   * a KMS is wired up, so local development leaves it off.
   */
  readonly serverSideEncryption?: string | undefined;
}

export interface StoredDocument {
  readonly key: string;
  readonly byteSize: number;
  readonly contentType: string;
  /** True when the object already existed — a retry, not a new write. */
  readonly alreadyExisted: boolean;
}

/**
 * Derive the storage key from tenant and content fingerprint.
 *
 * The two-character shard prefix matters at scale: some object stores partition
 * internally by key prefix, and a flat `tenant/<hash>` layout for millions of
 * objects concentrates load on a single partition.
 */
export function documentKey(tenantId: TenantId, fingerprint: string): string {
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new ValidationError(`Expected a sha256 hex fingerprint, got "${fingerprint}"`);
  }
  return `${tenantId}/${fingerprint.slice(0, 2)}/${fingerprint}`;
}

export class DocumentStore {
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly serverSideEncryption: string | undefined;

  constructor(opts: DocumentStoreOptions) {
    const config: S3ClientConfig = {
      endpoint: opts.endpoint,
      region: opts.region,
      forcePathStyle: opts.forcePathStyle,
      credentials: {
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
      },
    };
    this.s3 = new S3Client(config);
    this.bucket = opts.bucket;
    this.serverSideEncryption = opts.serverSideEncryption;
  }

  /**
   * Store document bytes.
   *
   * Checks for an existing object first. Content-addressed keys mean an existing
   * object with this key holds byte-identical content, so re-uploading would
   * burn bandwidth to write exactly what is already there — and on a retry storm
   * that is the difference between a blip and a bill.
   */
  async put(
    tenantId: TenantId,
    fingerprint: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<StoredDocument> {
    const key = documentKey(tenantId, fingerprint);

    const existing = await this.head(key);
    if (existing) {
      return {
        key,
        byteSize: existing.byteSize,
        contentType: existing.contentType ?? contentType,
        alreadyExisted: true,
      };
    }

    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: bytes,
          ContentType: contentType,
          ContentLength: bytes.byteLength,
          // Encryption at rest is required — vendor invoices carry bank
          // details — but it is configured, not hardcoded. Bucket-level
          // default encryption is preferred; this covers stores without it.
          ...(this.serverSideEncryption
            ? { ServerSideEncryption: this.serverSideEncryption as never }
            : {}),
          Metadata: { tenant: tenantId, fingerprint },
        }),
      );
    } catch (err) {
      throw new UpstreamError(`Failed to store document ${key}`, {
        cause: err,
        publicMessage: 'Could not save the uploaded document. Please retry.',
        context: { key, bucket: this.bucket },
      });
    }

    return { key, byteSize: bytes.byteLength, contentType, alreadyExisted: false };
  }

  async head(key: string): Promise<{ byteSize: number; contentType: string | undefined } | null> {
    try {
      const res = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { byteSize: res.ContentLength ?? 0, contentType: res.ContentType };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw new UpstreamError(`Failed to stat document ${key}`, { cause: err });
    }
  }

  /** Fetch document bytes. Used by the extraction worker. */
  async get(key: string): Promise<Buffer> {
    try {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!res.Body) {
        throw new NotFoundError(`Document ${key} has no body`);
      }
      return Buffer.from(await res.Body.transformToByteArray());
    } catch (err) {
      if (isNotFound(err)) {
        // A missing document is permanent, not transient: retrying cannot make
        // bytes appear. Classify it so the worker parks rather than looping.
        throw new NotFoundError(`Document ${key} not found in object storage`, {
          cause: err,
          context: { key, bucket: this.bucket },
        });
      }
      throw new UpstreamError(`Failed to fetch document ${key}`, { cause: err });
    }
  }

  /** Stream variant for large multi-page scans that need not be fully buffered. */
  async getStream(key: string): Promise<Readable> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new NotFoundError(`Document ${key} has no body`);
    return res.Body as Readable;
  }

  async healthy(): Promise<boolean> {
    try {
      // HEAD on a key that will not exist. A 404 proves reachability and
      // credentials without needing s3:ListBucket, which production policies
      // often withhold.
      await this.head('__healthcheck__/never-exists');
      return true;
    } catch {
      return false;
    }
  }

  destroy(): void {
    this.s3.destroy();
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any -- SDK error shapes are untyped */
function isNotFound(err: any): boolean {
  const status = err?.$metadata?.httpStatusCode;
  const name = err?.name ?? err?.Code;
  return status === 404 || name === 'NotFound' || name === 'NoSuchKey';
}
/* eslint-enable @typescript-eslint/no-explicit-any */

import assert from "assert";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { arrayBuffer } from "stream/consumers";
import { ReadableStream } from "stream/web";
import {
  InclusiveRange,
  MultipartOptions,
  MultipartReadableStream,
  createArrayReadableStream,
  createFileReadableStream,
  createFileWritableStream,
  createMultipartArrayReadableStream,
  createMultipartFileReadableStream,
} from "./streams";

const MODE_READ_ONLY = 0o444;

// Serialisable, opaque, unguessable blob identifier
export type BlobId = string;

export interface BlobStore {
  // Database for binary large objects. Provides single and multi-ranged
  // streaming reads and writes.
  //
  // Blobs have unguessable identifiers, can be deleted, but are otherwise
  // immutable. These properties make it possible to perform atomic updates with
  // the SQLite metadata store. No other operations will be able to interact
  // with the blob until it's committed to the metadata store, because they
  // won't be able to guess the ID, and we don't allow listing blobs.
  //
  // For example, if we put a blob in the store, then fail to insert the blob ID
  // into the SQLite database for some reason during a transaction (e.g.
  // `onlyIf` condition failed), no other operations can read that blob because
  // the ID is lost (we'll just background-delete the blob in this case).

  get(
    id: BlobId,
    range?: InclusiveRange
  ): Promise<ReadableStream<Uint8Array> | null>;
  get(
    id: BlobId,
    ranges: InclusiveRange[],
    opts: MultipartOptions
  ): Promise<MultipartReadableStream | null>;

  put(stream: ReadableStream<Uint8Array>): Promise<BlobId>;

  delete(id: BlobId): Promise<void>;
}

function generateBlobId(): string {
  const idBuffer = Buffer.alloc(32 + 8);
  crypto.randomFillSync(idBuffer, 0, 32);
  idBuffer.writeBigUint64BE(process.hrtime.bigint(), 32);
  return idBuffer.toString("hex");
}

export class MemoryBlobStore implements BlobStore {
  readonly #blobs = new Map<string, Uint8Array>();

  get(
    id: string,
    range?: InclusiveRange
  ): Promise<ReadableStream<Uint8Array> | null>;
  get(
    id: string,
    ranges: InclusiveRange[],
    opts: MultipartOptions
  ): Promise<MultipartReadableStream | null>;
  async get(
    id: string,
    ranges?: InclusiveRange | InclusiveRange[],
    opts?: MultipartOptions
  ): Promise<ReadableStream<Uint8Array> | MultipartReadableStream | null> {
    const blob = this.#blobs.get(id);
    if (blob === undefined) return null;
    if (Array.isArray(ranges)) {
      assert(opts !== undefined);
      return createMultipartArrayReadableStream(blob, ranges, opts);
    } else {
      return createArrayReadableStream(blob, ranges);
    }
  }

  async put(stream: ReadableStream<Uint8Array>): Promise<string> {
    const id = generateBlobId();
    const buffer = await arrayBuffer(stream);
    const blob = new Uint8Array(buffer);

    // Store blob, making sure we're storing a new key
    assert(!this.#blobs.has(id));
    this.#blobs.set(id, blob);

    return id;
  }

  async delete(id: string): Promise<void> {
    this.#blobs.delete(id);
  }
}

export class FileBlobStore implements BlobStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = path.resolve(root);
  }

  #idFilePath(id: string) {
    const filePath = path.join(this.#root, id.substring(0, 2), id.substring(2));
    return filePath.startsWith(this.#root) ? filePath : null;
  }

  get(
    id: string,
    range?: InclusiveRange
  ): Promise<ReadableStream<Uint8Array> | null>;
  get(
    id: string,
    ranges: InclusiveRange[],
    opts: MultipartOptions
  ): Promise<MultipartReadableStream | null>;
  async get(
    id: string,
    ranges?: InclusiveRange | InclusiveRange[],
    opts?: MultipartOptions
  ): Promise<ReadableStream<Uint8Array> | MultipartReadableStream | null> {
    // Get path for this ID, returning null if it's outside the root
    const filePath = this.#idFilePath(id);
    if (filePath === null) return null;
    // Get correct response for range, returning null if not found
    try {
      // The caller should only pass an array with >= 2 ranges, but allow less
      if (Array.isArray(ranges)) {
        assert(opts !== undefined);
        return await createMultipartFileReadableStream(filePath, ranges, opts);
      } else {
        return await createFileReadableStream(filePath, ranges);
      }
    } catch (e: any) {
      if (e?.code === "ENOENT") return null;
      throw e;
    }
  }

  async put(stream: ReadableStream<Uint8Array>): Promise<string> {
    const id = generateBlobId();

    // Get path for this ID, this should never be null as blob IDs are encoded
    const filePath = this.#idFilePath(id);
    assert(filePath !== null);

    // Write stream to file with exclusive flag to assert new file creation
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const writable = await createFileWritableStream(filePath, true /* excl. */);
    await stream.pipeTo(writable);
    // Mark the created file as read-only, this still allows it to be deleted
    await fs.chmod(filePath, MODE_READ_ONLY);

    return id;
  }

  async delete(id: string): Promise<void> {
    // Get path for this ID and delete, ignoring if outside root or not found
    const filePath = this.#idFilePath(id);
    try {
      if (filePath !== null) await fs.unlink(filePath);
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e;
    }
  }
}

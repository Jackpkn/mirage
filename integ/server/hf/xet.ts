// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { createHash } from 'node:crypto'
import { decompress } from 'lz4js'

// Xet's own target chunk size. The client's deserializer refuses chunks far
// above it, so the synthetic xorbs this fake serves stay within real bounds.
export const SERVE_CHUNK_SIZE = 1 << 16

const SHARD_HEADER_SIZE = 48
const RECORD_SIZE = 48
const FILE_FLAG_VERIFICATION = 1 << 31
const FILE_FLAG_METADATA_EXT = 1 << 30

export interface ShardEntry {
  casHash: string
  unpacked: number
  start: number
  end: number
}

export interface ShardFile {
  fileHash: string
  entries: ShardEntry[]
}

export interface Xorb {
  content: Buffer
  offsets: number[]
}

/**
 * The hex spelling of a 32-byte Xet merkle hash.
 *
 * The hash renders as four little-endian u64 words, so the raw bytes and the
 * hex that names them in URLs and batch bodies differ in ORDER. Reversing each
 * eight-byte group is that reordering; hex-encoding the 32 bytes as they lie
 * produces a plausible-looking string that addresses nothing.
 *
 * Args:
 *   raw (Uint8Array): the 32 hash bytes, as they arrived on the wire.
 */
export function hashHex(raw: Uint8Array): string {
  let out = ''
  for (let i = 0; i < 32; i += 8) {
    out += Buffer.from(raw.slice(i, i + 8))
      .reverse()
      .toString('hex')
  }
  return out
}

/**
 * Content-addressed stand-in for a file's Xet hash.
 *
 * Any 64-hex value serves, as long as the reconstruction endpoint resolves the
 * same one the tree advertised.
 *
 * Args:
 *   data (Uint8Array): the file's bytes.
 */
export function serveHash(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Undo Xet's byte-grouping-4 split.
 *
 * The stored buffer is the concatenation of every fourth byte starting at
 * offsets 0 through 3, each group padded to its own length: with `n = 4k + r`
 * the first `r` groups hold `k + 1` bytes and the rest hold `k`.
 *
 * Args:
 *   data (Uint8Array): the regrouped buffer.
 */
export function bg4Regroup(data: Uint8Array): Buffer {
  const n = data.length
  const k = Math.floor(n / 4)
  const r = n % 4
  const out = Buffer.alloc(n)
  let off = 0
  for (let i = 0; i < 4; i += 1) {
    const size = i < r ? k + 1 : k
    for (let j = 0; j < size; j += 1) out[i + j * 4] = data[off + j] ?? 0
    off += size
  }
  return out
}

/**
 * Split an uploaded xorb into its decompressed chunks.
 *
 * A xorb is a sequence of chunks, each an eight-byte packed header (version u8,
 * compressed length u24, compression scheme u8, uncompressed length u24)
 * followed by the possibly-compressed payload. The two u32 halves are read
 * separately so the 64-bit field never needs a BigInt.
 *
 * Args:
 *   body (Buffer): the whole uploaded xorb.
 */
export function decodeXorb(body: Buffer): Xorb {
  const parts: Buffer[] = []
  const offsets = [0]
  let total = 0
  let off = 0
  while (off < body.length) {
    const compressedLen = body.readUInt32LE(off) >>> 8
    const high = body.readUInt32LE(off + 4)
    const scheme = high & 0xff
    const uncompressedLen = high >>> 8
    const data = body.subarray(off + 8, off + 8 + compressedLen)
    let chunk: Buffer
    if (scheme === 0) chunk = Buffer.from(data)
    else if (scheme === 1) chunk = Buffer.from(decompress(data))
    else if (scheme === 2) chunk = bg4Regroup(decompress(data))
    else throw new Error(`unknown xorb compression scheme ${String(scheme)}`)
    if (chunk.length !== uncompressedLen) throw new Error('xorb chunk length mismatch')
    parts.push(chunk)
    total += chunk.length
    offsets.push(total)
    off += 8 + compressedLen
  }
  return { content: Buffer.concat(parts), offsets }
}

/**
 * One chunk in the wire form, stored raw.
 *
 * The header packs the same length twice, at bit 8 as the compressed length and
 * at bit 40 as the uncompressed one, with version and scheme both zero; each
 * lands at bit 8 of its own u32 half, so both halves are the length times 256.
 *
 * Args:
 *   chunk (Uint8Array): the chunk's bytes.
 */
export function encodeChunk(chunk: Uint8Array): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32LE(chunk.length * 256, 0)
  header.writeUInt32LE(chunk.length * 256, 4)
  return Buffer.concat([header, Buffer.from(chunk)])
}

/**
 * The file-info section of an MDB shard.
 *
 * Each record names a file hash and the xorb chunk ranges that reconstruct it.
 * The CAS-info section that follows the bookend is redundant with the decoded
 * xorbs already stored, so parsing stops there.
 *
 * Args:
 *   body (Buffer): the whole uploaded shard.
 */
export function parseShardFiles(body: Buffer): ShardFile[] {
  const files: ShardFile[] = []
  let off = SHARD_HEADER_SIZE
  for (;;) {
    const fileHash = body.subarray(off, off + 32)
    if (fileHash.length < 32 || fileHash.every((b) => b === 0xff)) break
    const flags = body.readUInt32LE(off + 32)
    const nEntries = body.readUInt32LE(off + 36)
    off += RECORD_SIZE
    const entries: ShardEntry[] = []
    for (let i = 0; i < nEntries; i += 1) {
      entries.push({
        casHash: hashHex(body.subarray(off, off + 32)),
        unpacked: body.readUInt32LE(off + 36),
        start: body.readUInt32LE(off + 40),
        end: body.readUInt32LE(off + 44),
      })
      off += RECORD_SIZE
    }
    if ((flags & FILE_FLAG_VERIFICATION) !== 0) off += nEntries * RECORD_SIZE
    if ((flags & FILE_FLAG_METADATA_EXT) !== 0) off += RECORD_SIZE
    files.push({ fileHash: hashHex(fileHash), entries })
  }
  return files
}

/**
 * The byte offset of a serve-side chunk inside the serialized xorb.
 *
 * Every chunk but the last is exactly `SERVE_CHUNK_SIZE` bytes behind an
 * eight-byte header.
 *
 * Args:
 *   chunkIndex (number): the chunk's index.
 */
export function serializedOffsetOf(chunkIndex: number): number {
  return chunkIndex * (8 + SERVE_CHUNK_SIZE)
}

/**
 * Content re-serialized as scheme-0 chunks, which is what a reconstruction's
 * `fetch_info` URLs point at.
 *
 * Args:
 *   data (Uint8Array): the file's bytes.
 */
export function serializeChunks(data: Uint8Array): Buffer {
  const parts: Buffer[] = []
  for (let off = 0; off < Math.max(data.length, 1); off += SERVE_CHUNK_SIZE) {
    parts.push(encodeChunk(data.subarray(off, off + SERVE_CHUNK_SIZE)))
  }
  return Buffer.concat(parts)
}

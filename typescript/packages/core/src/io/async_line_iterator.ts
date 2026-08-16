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

const NEWLINE = 0x0a

export class AsyncLineIterator implements AsyncIterableIterator<Uint8Array> {
  private readonly source: AsyncIterator<Uint8Array>
  private buf: Uint8Array<ArrayBuffer> = new Uint8Array(0)
  private exhausted = false

  constructor(source: AsyncIterable<Uint8Array> | AsyncIterator<Uint8Array>) {
    const s = source as AsyncIterable<Uint8Array>
    if (typeof s[Symbol.asyncIterator] === 'function') {
      this.source = s[Symbol.asyncIterator]()
    } else {
      this.source = source as AsyncIterator<Uint8Array>
    }
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
    return this
  }

  async next(): Promise<IteratorResult<Uint8Array>> {
    const line = await this.readline()
    if (line === null) return { done: true, value: undefined }
    return { done: false, value: line }
  }

  async readline(): Promise<Uint8Array | null> {
    while (indexOf(this.buf, NEWLINE) < 0) {
      if (this.exhausted) {
        if (this.buf.byteLength > 0) {
          const remaining = this.buf
          this.buf = new Uint8Array(0)
          return remaining
        }
        return null
      }
      const result = await this.source.next()
      if (result.done === true) {
        this.exhausted = true
        continue
      }
      this.buf = concat2(this.buf, result.value)
    }
    const idx = indexOf(this.buf, NEWLINE)
    const line = this.buf.subarray(0, idx)
    this.buf = this.buf.subarray(idx + 1)
    return line
  }

  /**
   * Read up to (not including) `delim`, or to EOF. Returns the bytes and
   * whether the delimiter was found (false means EOF, which `read`/
   * `mapfile` report as status 1).
   */
  async readUntil(delim: number): Promise<[Uint8Array<ArrayBuffer>, boolean]> {
    while (indexOf(this.buf, delim) < 0) {
      if (this.exhausted) {
        const remaining = copyOf(this.buf)
        this.buf = new Uint8Array(0)
        return [remaining, false]
      }
      const result = await this.source.next()
      if (result.done === true) {
        this.exhausted = true
        continue
      }
      this.buf = concat2(this.buf, result.value)
    }
    const idx = indexOf(this.buf, delim)
    const data = copyOf(this.buf.subarray(0, idx))
    this.buf = this.buf.subarray(idx + 1)
    return [data, true]
  }

  /**
   * Read at most `count` bytes, stopping early at `delim` (null reads
   * through delimiters). `read -n` is the delimited form, `read -N` the
   * null one. The delimiter is consumed and not returned. Returns the
   * bytes and whether the read ended on its own terms rather than EOF.
   */
  async readChars(
    count: number,
    delim: number | null,
  ): Promise<[Uint8Array<ArrayBuffer>, boolean]> {
    let out: Uint8Array<ArrayBuffer> = new Uint8Array(0)
    while (out.byteLength < count) {
      if (this.buf.byteLength === 0) {
        if (this.exhausted) return [copyOf(out), false]
        const result = await this.source.next()
        if (result.done === true) this.exhausted = true
        else this.buf = concat2(this.buf, result.value)
        continue
      }
      const take: Uint8Array<ArrayBuffer> = this.buf.subarray(0, count - out.byteLength)
      if (delim !== null) {
        const di = indexOf(take, delim)
        if (di >= 0) {
          out = concat2(out, take.subarray(0, di))
          this.buf = this.buf.subarray(di + 1)
          return [copyOf(out), true]
        }
      }
      out = concat2(out, take)
      this.buf = this.buf.subarray(take.byteLength)
    }
    return [copyOf(out), true]
  }
}

function indexOf(buf: Uint8Array, byte: number): number {
  for (let i = 0; i < buf.byteLength; i++) {
    if (buf[i] === byte) return i
  }
  return -1
}

function concat2(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  if (a.byteLength === 0) return copyOf(b)
  if (b.byteLength === 0) return copyOf(a)
  const out = new Uint8Array(a.byteLength + b.byteLength)
  out.set(a, 0)
  out.set(b, a.byteLength)
  return out
}

function copyOf(buf: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(buf.byteLength)
  out.set(buf, 0)
  return out
}

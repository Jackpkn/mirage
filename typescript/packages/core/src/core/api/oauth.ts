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

/**
 * Caches a short-lived access token, refreshing before expiry.
 *
 * Subclasses implement `refreshPair` with their provider's grant. An
 * in-flight refresh is shared so concurrent callers cost one round-trip,
 * and `bufferSeconds` refreshes early so a token never expires
 * mid-request.
 */
export abstract class TokenManager {
  private accessToken: string | null = null
  private expiresAt = 0
  private inflight: Promise<string> | null = null
  private readonly bufferSeconds: number

  constructor(bufferSeconds = 300) {
    this.bufferSeconds = bufferSeconds
  }

  /** Fetch a fresh token as `[accessToken, expiresInSeconds]`. */
  protected abstract refreshPair(): Promise<[string, number]>

  async getToken(): Promise<string> {
    if (this.accessToken !== null && Date.now() / 1000 < this.expiresAt) {
      return this.accessToken
    }
    if (this.inflight !== null) return this.inflight
    const p = this.refresh()
    this.inflight = p
    try {
      return await p
    } finally {
      this.inflight = null
    }
  }

  private async refresh(): Promise<string> {
    const [token, expiresIn] = await this.refreshPair()
    this.accessToken = token
    this.expiresAt = Date.now() / 1000 + expiresIn - this.bufferSeconds
    return token
  }
}

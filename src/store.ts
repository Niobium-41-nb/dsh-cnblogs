/**
 * The plugin's own small state document: which local file is bound to which
 * post, plus the last verified account. This is what makes `save` update an
 * existing post instead of creating a duplicate on every call.
 *
 * Writes are atomic (temp file + rename) and private (0600) because the token
 * file lives in the same directory.
 * @module dsh-cnblogs/store
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Account, FileMapping, StateDocument } from './types.ts'

/** Normalize a path into a stable map key (Windows paths are case-insensitive). */
export function mappingKey(filePath: string): string {
  const resolved = resolve(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** An empty document. */
export function emptyState(): StateDocument {
  return { version: 1, files: {} }
}

/** Read, mutate, and persist the state document. */
export class StateStore {
  readonly path: string

  constructor(path: string) {
    this.path = path
  }

  /** Parse the document, tolerating absence and corruption. */
  read(): StateDocument {
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch {
      return emptyState()
    }
    try {
      const parsed = JSON.parse(text) as Partial<StateDocument>
      if (parsed === null || typeof parsed !== 'object') return emptyState()
      const files: Record<string, FileMapping> = {}
      const rawFiles = parsed.files
      if (rawFiles !== undefined && rawFiles !== null && typeof rawFiles === 'object') {
        for (const [key, value] of Object.entries(rawFiles)) {
          if (value === null || typeof value !== 'object') continue
          const entry = value as Partial<FileMapping>
          if (typeof entry.postId !== 'number' || !Number.isInteger(entry.postId)) continue
          files[key] = {
            postId: entry.postId,
            url: typeof entry.url === 'string' ? entry.url : '',
            title: typeof entry.title === 'string' ? entry.title : '',
            updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
          }
        }
      }
      const document: StateDocument = { version: 1, files }
      if (parsed.account !== undefined && parsed.account !== null) document.account = parsed.account
      return document
    } catch {
      return emptyState()
    }
  }

  /** Write atomically and restrict permissions. */
  write(document: StateDocument): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const temp = `${this.path}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    try {
      chmodSync(temp, 0o600)
    } catch {
      // Best effort: a filesystem without POSIX modes is not an error here.
    }
    renameSync(temp, this.path)
  }

  /** The mapping recorded for a local file, if any. */
  getFile(filePath: string): FileMapping | undefined {
    return this.read().files[mappingKey(filePath)]
  }

  /** Bind a local file to a post. */
  setFile(filePath: string, mapping: FileMapping): void {
    const document = this.read()
    document.files[mappingKey(filePath)] = mapping
    this.write(document)
  }

  /** Forget a binding. */
  removeFile(filePath: string): void {
    const document = this.read()
    delete document.files[mappingKey(filePath)]
    this.write(document)
  }

  /** Record the account the token resolves to. */
  setAccount(account: Account): void {
    const document = this.read()
    document.account = {
      displayName: account.displayName,
      blogApp: account.blogApp,
      blogId: account.blogId,
      checkedAt: new Date().toISOString(),
    }
    this.write(document)
  }

  /** Remove the state document entirely. */
  clear(): void {
    rmSync(this.path, { force: true })
  }
}

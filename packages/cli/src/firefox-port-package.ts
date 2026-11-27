import { zipSync } from 'fflate'
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

async function collectArchiveEntries(
  rootDir: string,
  currentDir: string,
  entries: Record<string, Uint8Array>,
): Promise<void> {
  const items = await readdir(currentDir, { withFileTypes: true })
  items.sort((a, b) => a.name.localeCompare(b.name))
  for (const item of items) {
    if (item.name === '.DS_Store') continue
    const fullPath = path.join(currentDir, item.name)
    if (item.isDirectory()) {
      await collectArchiveEntries(rootDir, fullPath, entries)
    } else if (item.isFile()) {
      const relPosix = path.relative(rootDir, fullPath).split(path.sep).join('/')
      const raw = await readFile(fullPath)
      entries[relPosix] = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
    }
  }
}

/**
 * Packages an unpacked Firefox extension directory into a standard `.xpi`
 * (ZIP archive with POSIX forward-slash paths, ready for Firefox / AMO).
 */
export async function packageXpi(unpackedDir: string, destXpiPath: string): Promise<number> {
  const entries: Record<string, Uint8Array> = {}
  await collectArchiveEntries(unpackedDir, unpackedDir, entries)
  const archiveBytes = zipSync(entries, { level: 6 })
  await mkdir(path.dirname(destXpiPath), { recursive: true })
  await writeFile(destXpiPath, archiveBytes)
  return archiveBytes.byteLength
}

export async function copyDirectoryClean(srcDir: string, destDir: string): Promise<void> {
  await rm(destDir, { recursive: true, force: true })
  await mkdir(path.dirname(destDir), { recursive: true })
  await cp(srcDir, destDir, { recursive: true })
}

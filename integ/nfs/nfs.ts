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

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkPlatformNfs,
  FileStat,
  FileType,
  MountMode,
  NFSManager,
  RAMResource,
  Workspace,
} from "@struktoai/mirage-node";

// The addon is not published yet, so a local build is the default and CI
// (or a developer with the crate built elsewhere) overrides it. Named
// loudly rather than resolved silently: without it every probe below
// fails with "needs the addon", which reads as a mount bug.
const BUILT_ADDON = fileURLToPath(
  new URL("../../typescript/packages/mirage-nfs/mirage_nfs_node.node", import.meta.url),
);
if (process.env.MIRAGE_NFS_ADDON === undefined) {
  process.env.MIRAGE_NFS_ADDON = BUILT_ADDON;
  process.stderr.write(`MIRAGE_NFS_ADDON unset; using ${BUILT_ADDON}\n`);
}

const DEC = new TextDecoder();
type Result = Record<string, string | number | boolean | string[] | null>;

/**
 * Run one command in a child process and capture its output.
 *
 * Every touch of the mountpoint must leave this process: the NFS server
 * is served BY this event loop, so a synchronous stat here would
 * deadlock the request it produces.
 */
async function sh(...argv: string[]): Promise<[number, string]> {
  return new Promise((resolve) => {
    execFile(
      argv[0] as string,
      argv.slice(1),
      { timeout: 20_000, encoding: "utf8" },
      (err, stdout, stderr) => {
        const out = `${stdout}${stderr}`.trim();
        const code = err === null ? 0 : ((err as { code?: number }).code ?? 1);
        resolve([typeof code === "number" ? code : 1, out]);
      },
    );
  });
}

async function writeThrough(path: string, text: string): Promise<number> {
  const [code] = await sh("sh", "-c", `printf '%s' '${text}' > ${path}`);
  return code;
}

/** The single-server, multi-mount battery over a RAM workspace. */
async function runBattery(result: Result): Promise<void> {
  const ws = new Workspace({ "/": new RAMResource() }, { mode: MountMode.WRITE });
  await ws.execute("echo alpha > /a.txt");
  await ws.execute("mkdir /docs && echo beta > /docs/b.txt");

  const manager = new NFSManager();
  let whole = "";
  let docs = "";
  try {
    whole = await manager.setup(ws, "/");
    docs = await manager.setup(ws, "/docs");
    result.distinct_mounts = whole !== docs;

    let out: string;
    [, out] = await sh("cat", `${whole}/a.txt`);
    result.cat_a = out;
    [, out] = await sh("cat", `${docs}/b.txt`);
    result.subtree_cat_b = out;
    [, out] = await sh("ls", whole);
    result.ls_names = out
      .split(/\s+/)
      .filter((name) => name !== "" && name !== "dev")
      .sort();

    result.write_ok = (await writeThrough(`${docs}/new.txt`, "via-nfs")) === 0;
    // One server, two exports: a write through the subtree mount is
    // visible through the whole-tree mount, because both are views of
    // the same op tree rather than two copies of it.
    [, out] = await sh("cat", `${whole}/docs/new.txt`);
    result.cross_mount_readback = out;

    let code: number;
    [code] = await sh("ln", "-s", "a.txt", `${whole}/lnk`);
    result.symlink_ok = code === 0;
    [, out] = await sh("readlink", `${whole}/lnk`);
    result.readlink = out;
    [, out] = await sh("cat", `${whole}/lnk`);
    result.cat_through_link = out;
    await sh("rm", `${whole}/lnk`);
    [, out] = await sh("cat", `${whole}/a.txt`);
    result.target_survives_link_rm = out;

    [code] = await sh(
      "sh",
      "-c",
      `mkdir ${whole}/d && mv ${whole}/docs/new.txt ${whole}/d/m.txt`,
    );
    result.mkdir_mv_ok = code === 0;

    try {
      await manager.setup(ws, "/dev", whole);
      result.collision_rejected = false;
    } catch {
      result.collision_rejected = true;
    }
  } finally {
    await manager.close();
  }

  // close() unmounts, then flushes what the client's final WRITEs left
  // buffered, then stops the server -- so the bytes are in the workspace
  // only if that order held.
  const io = await ws.execute("cat /d/m.txt");
  result.close_flushed = DEC.decode((io as { stdout: Uint8Array }).stdout).trim();
  result.mountpoints_cleaned = !existsSync(whole) && !existsSync(docs);
}

/**
 * Size-unknown files read as empty, and the mount says so.
 *
 * NFSv3 has no OPEN procedure, so there is no hydrate-on-open the way
 * FUSE has: the client stops reading at the size GETATTR reported. The
 * resource declares the limitation (which is what the warning reads)
 * and the stat wrapper stands in for one that cannot size a file
 * without fetching it.
 */
async function runSizeless(result: Result): Promise<void> {
  class SizelessRAM extends RAMResource {
    override readonly sizesAlwaysKnown: boolean = false;
  }
  const ws = new Workspace({ "/": new SizelessRAM() }, { mode: MountMode.WRITE });
  await ws.execute("echo hidden-content > /api.json");
  const realStat = ws.fs.stat.bind(ws.fs);
  ws.fs.stat = async (path: string) => {
    const row = await realStat(path);
    if (row.type === FileType.DIRECTORY) return row;
    return new FileStat({ name: row.name, type: row.type, size: null });
  };

  const warnings: string[] = [];
  const realWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  };

  const manager = new NFSManager();
  try {
    const mnt = await manager.setup(ws, "/");
    const [, empty] = await sh("cat", `${mnt}/api.json`);
    result.sizeless_reads_empty = empty === "";
    let [code, size] = await sh("stat", "-f", "%z", `${mnt}/api.json`);
    if (code !== 0) [code, size] = await sh("stat", "-c", "%s", `${mnt}/api.json`);
    result.sizeless_stat_zero = size === "0";
  } finally {
    await manager.close();
    console.warn = realWarn;
  }
  result.sizeless_warned = warnings.some((line) => line.includes("read as empty"));
}

/**
 * Multi-chunk md5 round-trip through a kernel mount.
 *
 * A 1 MiB copy arrives as dozens of WRITEs, and the macOS client has
 * been observed issuing them out of order and overlapping -- the
 * behavior that silently corrupts nfsserve's own demo example. The
 * read-back happens BEFORE any flush, so it exercises the overlay path
 * over the full chunk set; the workspace check after close proves the
 * merged flush stored the same bytes.
 */
async function runBigfile(result: Result): Promise<void> {
  const payload = Buffer.concat(Array.from({ length: 4096 }, () => Buffer.from(Array.from({ length: 256 }, (_, i) => i))));
  const want = createHash("md5").update(payload).digest("hex");
  const hostDir = mkdtempSync(join(tmpdir(), "mirage-nfs-big-"));
  const src = join(hostDir, "src.bin");
  const back = join(hostDir, "back.bin");
  writeFileSync(src, payload);

  const ws = new Workspace({ "/": new RAMResource() }, { mode: MountMode.WRITE });
  const manager = new NFSManager();
  try {
    const mnt = await manager.setup(ws, "/");
    const [inCode] = await sh("cp", src, `${mnt}/big.bin`);
    result.bigfile_cp_in = inCode === 0;
    const [outCode] = await sh("cp", `${mnt}/big.bin`, back);
    result.bigfile_cp_out = outCode === 0;
    result.bigfile_md5_pre_flush =
      createHash("md5").update(readFileSync(back)).digest("hex") === want;
  } finally {
    await manager.close();
  }
  // Verified at the ops tier, not through the executor: `cat` is the
  // agent surface and its output is capped by the post gate (a 1 MiB
  // file comes back truncated by design), while readFile(raw) answers
  // the stored bytes themselves.
  const stored = await ws.fs.readFile("/big.bin", { raw: true });
  result.bigfile_md5_persisted =
    createHash("md5").update(Buffer.from(stored)).digest("hex") === want;
}

async function main(): Promise<void> {
  const result: Result = {};
  try {
    checkPlatformNfs("win32");
    result.win32_refused = false;
  } catch {
    result.win32_refused = true;
  }

  await runBattery(result);
  await runSizeless(result);
  await runBigfile(result);
  process.stdout.write(JSON.stringify(result) + "\n");
  // The addon's idle-flush task holds its callback for the process's
  // lifetime, so stopping the server does not release this event loop.
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});

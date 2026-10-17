import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";

const markerPath = (target: string) => `${target}.paperclip-windows-link.json`;

async function fileIdentity(file: string) {
  const stat = await fs.lstat(file, { bigint: true }).catch(() => null);
  return stat?.isFile() ? { dev: String(stat.dev), ino: String(stat.ino) } : null;
}

export async function isSameWindowsAuthFile(target: string, source: string): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const [left, right] = await Promise.all([fileIdentity(target), fileIdentity(source)]);
  return !!left && !!right && left.dev === right.dev && left.ino === right.ino;
}

export async function isOwnedWindowsAuthLink(target: string): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const identity = await fileIdentity(target);
  if (!identity) return false;
  try {
    const marker = JSON.parse(await fs.readFile(markerPath(target), "utf8"));
    return marker.version === 1 && marker.dev === identity.dev && marker.ino === identity.ino;
  } catch { return false; }
}

export async function clearWindowsAuthLinkMarker(target: string): Promise<void> {
  if (process.platform === "win32") await fs.rm(markerPath(target), { force: true });
}

export async function createWindowsAuthLink(target: string, source: string): Promise<void> {
  // A hard link needs no developer-mode privilege and shares live bytes rather
  // than copying single-use refresh credentials. EXDEV fails closed.
  await fs.link(source, target);
  const identity = await fileIdentity(target);
  if (!identity) throw new Error("Windows auth link is not a regular file");
  const staged = `${markerPath(target)}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(staged, JSON.stringify({ version: 1, ...identity }), { mode: 0o600, flag: "wx" });
    await fs.rename(staged, markerPath(target));
  } finally { await fs.rm(staged, { force: true }); }
}

export async function reconcileWindowsAuthLink(target: string, source: string): Promise<void> {
  if (!await isOwnedWindowsAuthLink(target) || await isSameWindowsAuthFile(target, source)) return;
  // Atomic host credential replacement/logout changes the inode. Only remove
  // a link we created; an independently promoted managed credential is kept.
  await fs.unlink(target);
  await clearWindowsAuthLinkMarker(target);
}

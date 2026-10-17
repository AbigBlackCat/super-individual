import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seedManagedCodexHome, writeApiKeyAuthJson, codexHomeHasUsableAuth } from "./codex-home.js";
import { isOwnedWindowsAuthLink, isSameWindowsAuthFile } from "./windows-auth-link.js";
import { ensureCodexSkillsInjected } from "./execute.js";

describe.skipIf(process.platform !== "win32")("ordinary Windows user Codex auth", () => {
  const roots: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
  });
  async function fixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "si-windows-auth-")); roots.push(root);
    const source = path.join(root,"shared"), target = path.join(root,"managed");
    await fs.mkdir(source,{recursive:true});
    const denied = Object.assign(new Error("Symlink privilege unavailable"),{code:"EPERM"});
    vi.spyOn(fs,"symlink").mockRejectedValue(denied);
    const env = {CODEX_HOME:source,PAPERCLIP_HOME:root};
    return {source,target,env,sourceAuth:path.join(source,"auth.json"),targetAuth:path.join(target,"auth.json")};
  }
  const auth = (account: string) => JSON.stringify({tokens:{account_id:account,id_token:"synthetic-id",access_token:"synthetic-access",refresh_token:"synthetic-refresh"}});

  it("uses a real same-volume hard link when file symlinks are denied", async () => {
    const f=await fixture();await fs.writeFile(f.sourceAuth,'{"OPENAI_API_KEY":"synthetic"}');
    await seedManagedCodexHome(f.target,f.env,async()=>{});
    expect(await isOwnedWindowsAuthLink(f.targetAuth)).toBe(true);
    expect(await isSameWindowsAuthFile(f.targetAuth,f.sourceAuth)).toBe(true);
    await fs.writeFile(f.sourceAuth,'{"OPENAI_API_KEY":"synthetic-updated"}');
    expect(await fs.readFile(f.targetAuth,"utf8")).toContain("synthetic-updated");
    await seedManagedCodexHome(f.target,f.env,async()=>{});
    expect(await isSameWindowsAuthFile(f.targetAuth,f.sourceAuth)).toBe(true);
  });
  it("follows atomic host account replacement and removes linked auth after logout", async () => {
    const f=await fixture();await fs.writeFile(f.sourceAuth,auth("host-a"));
    await seedManagedCodexHome(f.target,f.env,async()=>{});
    await fs.writeFile(f.sourceAuth+".new",auth("host-b"));await fs.rename(f.sourceAuth+".new",f.sourceAuth);
    await seedManagedCodexHome(f.target,f.env,async()=>{});
    expect(await fs.readFile(f.targetAuth,"utf8")).toBe(auth("host-b"));
    await fs.unlink(f.sourceAuth);await seedManagedCodexHome(f.target,f.env,async()=>{});
    expect(await codexHomeHasUsableAuth(f.target)).toBe(false);
  });
  it("preserves an independently promoted company login", async () => {
    const f=await fixture();await fs.writeFile(f.sourceAuth,auth("host"));
    await seedManagedCodexHome(f.target,f.env,async()=>{});
    await fs.writeFile(f.targetAuth+".new",auth("company"));await fs.rename(f.targetAuth+".new",f.targetAuth);
    await seedManagedCodexHome(f.target,f.env,async()=>{});
    expect(await fs.readFile(f.targetAuth,"utf8")).toBe(auth("company"));
    expect(await fs.readFile(f.sourceAuth,"utf8")).toBe(auth("host"));
  });
  it("never overwrites host auth when writing an explicit managed API key", async () => {
    const f=await fixture();await fs.writeFile(f.sourceAuth,auth("host"));
    await seedManagedCodexHome(f.target,f.env,async()=>{});
    await writeApiKeyAuthJson(f.target,"synthetic-override");
    expect(await fs.readFile(f.sourceAuth,"utf8")).toBe(auth("host"));
    expect(await isOwnedWindowsAuthLink(f.targetAuth)).toBe(false);
    expect(await fs.readFile(f.targetAuth,"utf8")).toContain("synthetic-override");
  });
  it("fails closed across volumes instead of copying rotating credentials", async () => {
    const f=await fixture();await fs.writeFile(f.sourceAuth,auth("host"));
    vi.spyOn(fs,"link").mockRejectedValue(Object.assign(new Error("Cross-volume link"),{code:"EXDEV"}));
    await expect(seedManagedCodexHome(f.target,f.env,async()=>{})).rejects.toMatchObject({code:"EXDEV"});
    expect(await fs.readFile(f.sourceAuth,"utf8")).toBe(auth("host"));
    await expect(fs.access(f.targetAuth)).rejects.toMatchObject({code:"ENOENT"});
  });
  it("injects skill directories through an ordinary-user junction", async () => {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),"si-windows-skill-"));roots.push(root);
    const source=path.join(root,"中文技能"),skillsHome=path.join(root,"runtime-skills");
    await fs.mkdir(source);await fs.writeFile(path.join(source,"SKILL.md"),"Synthetic skill");
    await ensureCodexSkillsInjected(async()=>{},{skillsHome,skillsEntries:[{key:"demo",runtimeName:"demo",source}]});
    const target=path.join(skillsHome,"demo");
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(target)).toBe(await fs.realpath(source));
  });
});

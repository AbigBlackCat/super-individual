// Paperclip reads task overrides from adapterConfig, never from a top-level cwd.
export function individualStageOverrides(directory: string) {
  return { adapterConfig: { cwd: directory }, useProjectWorkspace: false };
}

export function individualClaudeEnvironment(proxy?: string): Record<string, string> {
  // Explicitly setting even the default directory selects a different Claude keychain identity.
  const env: Record<string, string> = {};
  if (proxy?.trim()) {
    const value = proxy.trim();
    if (!["http:", "https:"].includes(new URL(value).protocol)) throw new Error("Claude 代理必须使用 HTTP 或 HTTPS 协议");
    Object.assign(env, { HTTP_PROXY: value, HTTPS_PROXY: value, ALL_PROXY: value });
  }
  return env;
}

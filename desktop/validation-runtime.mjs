import path from 'node:path';

// Acceptance tests must never inherit a real database, instance or provider login.
export function validationEnvironment(home, overrides = {}, inherited = process.env) {
  const env = { ...inherited };
  for (const key of Object.keys(env)) {
    if (/^(?:PAPERCLIP_|SUPER_INDIVIDUAL_|SI_|PG|DATABASE_URL$|BETTER_AUTH_|ANTHROPIC_|OPENAI_|CODEX_|CLAUDE_|OTEL_|SENTRY_|NODE_OPTIONS$|NODE_PATH$)/i.test(key)) delete env[key];
  }
  return {
    ...env, SI_DATA_DIRECTORY: home, PAPERCLIP_HOME: home,
    PAPERCLIP_CONFIG: path.join(home, 'instances/default/config.json'), PAPERCLIP_INSTANCE_ID: 'default',
    HOME: home, USERPROFILE: home,
    APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    SUPER_INDIVIDUAL: 'true', PAPERCLIP_TELEMETRY_DISABLED: '1', NODE_ENV: 'production',
    HOST: '127.0.0.1', SERVE_UI: 'true', PAPERCLIP_UI_DEV_MIDDLEWARE: 'false', ...overrides,
  };
}

export function redactValidationLog(text) {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9_.-]+/gi, '$1[redacted]')
    .replace(/("(?:token|secret|password|apiKey|api_key|authorization)"\s*:\s*")[^"\r\n]*/gi, '$1[redacted]')
    .replace(/(postgres(?:ql)?:\/\/)[^@\s]+@/gi, '$1[redacted]@');
}

/**
 * WHERE THE SERVER LISTENS.
 *
 * Three hosts, three conventions, one decision:
 *
 *   · a platform that assigns a port (Render, Railway, Fly, Heroku) → `PORT`
 *   · Hugging Face Spaces (which is what the Dockerfile targets) → 7860, the
 *     only port a Space routes to, and it does NOT set `PORT` for Docker spaces
 *   · anywhere else (`npm start` on a laptop) → 8080
 *
 * `EXPOSE 7860` in the Dockerfile is documentation for the proxy, not a bind:
 * without this rule the container would come up on 8080 and every request to the
 * Space would time out, so the platform is detected rather than trusted.
 */

export const DEFAULT_PORT = 8080;
export const SPACES_PORT = 7860;

/** True when this process is running inside a Hugging Face Space. */
export function isHuggingFaceSpace(env = process.env) {
  return Boolean(env?.SPACE_ID || env?.SPACE_HOST || env?.SPACE_REPO_NAME);
}

/** The port to bind, in priority order: PORT → 7860 on Spaces → 8080. */
export function resolvePort(env = process.env) {
  const explicit = Number(env?.PORT);
  if (Number.isFinite(explicit) && explicit > 0 && explicit < 65_536) return explicit;
  if (isHuggingFaceSpace(env)) return SPACES_PORT;
  return DEFAULT_PORT;
}

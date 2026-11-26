/**
 * Where the broker is. Publishing is off unless `CULTURE_AGENTS_BROKER_URL` is set: the address
 * is configuration of the host the core runs on and is never read from a tracked file.
 *
 * The value is `mqtt://<loopback address>[:<port>]`, for example `mqtt://127.0.0.1:1883` (the
 * port defaults to 1883). The events broker is anonymous and bound to loopback, so the core
 * publishes only to its own host: an address that is not loopback is refused, and so are a user
 * name or password, a path, and any other scheme (the broker has no TLS listener).
 */
export const BROKER_URL_ENV = "CULTURE_AGENTS_BROKER_URL";
export const DEFAULT_BROKER_PORT = 1883;

export interface PublishConfig {
  /** The address as the core uses it: `mqtt://<host>:<port>`. */
  url: string;
  host: string;
  port: number;
}

/** The configured value cannot be used. The message never repeats a user name or password. */
export class PublishConfigError extends Error {
  override readonly name = "PublishConfigError";
}

type Env = Readonly<Record<string, string | undefined>>;

const LOOPBACK_V4 = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** The broker configuration, or null when publishing is off. Throws `PublishConfigError` for a value that cannot be used. */
export function loadPublishConfig(env: Env = process.env): PublishConfig | null {
  const raw = env[BROKER_URL_ENV]?.trim();
  if (raw === undefined || raw === "") return null;
  const refuse = (what: string): never => {
    throw new PublishConfigError(`${BROKER_URL_ENV} ${what}; expected mqtt://127.0.0.1:${DEFAULT_BROKER_PORT} or another loopback address`);
  };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse("is not a URL");
  }
  if (url.protocol !== "mqtt:") return refuse("must use the mqtt scheme");
  if (url.username !== "" || url.password !== "") return refuse("must not hold a user name or password");
  if ((url.pathname !== "" && url.pathname !== "/") || url.search !== "" || url.hash !== "") return refuse("must not hold a path, query or fragment");
  const host = url.hostname.toLowerCase();
  if (!(host === "localhost" || host === "[::1]" || LOOPBACK_V4.test(host))) {
    return refuse("must name a loopback address (the broker is anonymous, so the core publishes only to its own host)");
  }
  const port = url.port === "" ? DEFAULT_BROKER_PORT : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return refuse("must name a TCP port");
  return { url: `mqtt://${host}:${port}`, host: host === "[::1]" ? "::1" : host, port };
}

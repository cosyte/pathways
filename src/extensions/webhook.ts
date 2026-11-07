import type { HttpClientConfig } from "../config/schema.js";
import { resolveHeaders, type Env } from "../connectors/endpoint.js";
import { HttpDestination } from "../connectors/http.js";
import { loadClientTls } from "../connectors/tls.js";
import { DeliveryRejected } from "../connectors/types.js";
import type { LifecycleHook } from "./types.js";

/**
 * What a webhook hook is built with beside its endpoint.
 *
 * @example
 * ```ts
 * const options: WebhookOptions = { timeoutMs: 5_000, env: process.env, where: "pathways.yaml: hooks.0" };
 * ```
 */
export interface WebhookOptions {
  /** The hook's time limit: each POST, connection to answer, gets this long. */
  readonly timeoutMs: number;
  /** Where header values written as `{ env: NAME }` are read from. */
  readonly env: Env;
  /** The file and key that name the hook, such as `pathways.yaml: hooks.0`, for errors. */
  readonly where: string;
}

/**
 * The built-in webhook hook, named in the YAML as `hooks: [{ webhook: { url, headers } }]`. It POSTs
 * each event as JSON to `url`: HTTPS unless the hook says `plaintext: true` with an `http://` url,
 * with the server's certificate always verified, against `tls.ca` when set. Headers that carry a
 * credential are read from the environment (`{ env: NAME }`) at startup and never logged.
 *
 * It is an HTTP destination whose messages are events, so it treats answers the same way: a 2xx is
 * done, and anything else, or no answer within the hook's time limit, fails the call with a
 * `WebhookError` whose code is `HTTP_<status>` or the network's own (`ECONNREFUSED`). The hook runner
 * logs that by name and code and moves on: a webhook is a notification, not a queue, so a failed
 * event is not sent again.
 *
 * An event holds ids, counts, error names, codes and times, never message content, so the body never
 * does either.
 *
 * @throws {ConfigError} when a header's variable is not set or a TLS file cannot be read.
 * @example
 * ```ts
 * const hook = webhookHook(
 *   { url: "https://ops.example.test/pathways", headers: { Authorization: { env: "OPS_TOKEN" } }, tls: undefined, plaintext: false },
 *   { timeoutMs: 5_000, env: process.env, where: "pathways.yaml: hooks.0" },
 * );
 * await hook.onEvent(event, AbortSignal.timeout(5_000));
 * ```
 */
export function webhookHook(config: HttpClientConfig, options: WebhookOptions): LifecycleHook {
  const { timeoutMs, env, where } = options;
  const at = `${where}.webhook`;
  const sender = new HttpDestination({
    url: config.url,
    headers: resolveHeaders({ "Content-Type": "application/json" }, config.headers, env, at),
    timeoutMs,
    ...(config.tls === undefined ? {} : { tls: loadClientTls(config.tls, `${at}.tls`) }),
  });
  return {
    async onEvent(event) {
      try {
        // An HTTP destination reads only the body of what it delivers.
        await sender.deliver({ messageId: 0, seq: 0, body: Buffer.from(JSON.stringify(event)) });
      } catch (error) {
        throw webhookError(error);
      }
    },
    stop: () => sender.stop(),
  };
}

/**
 * A failed POST, as a `WebhookError` whose code is the status (`HTTP_404`) or the network's code. An
 * HTTP destination fails only with a `DeliveryRejected` (reason `HTTP 404`) or an error with a code.
 */
function webhookError(error: unknown): Error & { readonly code: string } {
  const code =
    error instanceof DeliveryRejected
      ? error.reason.replace(" ", "_")
      : (error as { readonly code: string }).code;
  return Object.assign(new Error(`the webhook did not take the event (${code})`), {
    name: "WebhookError",
    code,
  });
}

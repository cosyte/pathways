// The guard every connection an HTTP destination opens goes through: the address a name resolves to
// is checked at each connect, so a name that once resolved to a public address and now resolves to
// a loopback, link-local or private one (DNS rebinding) is refused, and the address checked is the
// address the socket connects to.

import { lookup as dnsLookup } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";

/** The code an attempt fails with when every address of its host is refused. */
export const ADDRESS_REFUSED = "ADDRESS_REFUSED";

/**
 * The ranges refused unless allowed: the unspecified, loopback, link-local (where cloud metadata
 * services answer) and private ranges of IPv4 and IPv6. An IPv4-mapped IPv6 address is checked as
 * the IPv4 address it maps.
 */
const REFUSED_RANGES: readonly (readonly [string, number, "ipv4" | "ipv6"])[] = [
  ["0.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["::", 128, "ipv6"],
  ["::1", 128, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
];

const REFUSED = new BlockList();
for (const [address, prefix, type] of REFUSED_RANGES) REFUSED.addSubnet(address, prefix, type);

/** An address, or an address and a prefix length, as `allowNetworks` writes it. */
const NETWORK = /^([^/]+)(?:\/(\d{1,3}))?$/;

/**
 * Reads one `allowNetworks` entry, `10.20.0.0/16`, `fd00::/8` or a single address such as
 * `127.0.0.1`: its address, prefix length and family, or undefined when it is none of these.
 *
 * @example
 * ```ts
 * parseNetwork("10.20.0.0/16"); // { address: "10.20.0.0", prefix: 16, type: "ipv4" }
 * parseNetwork("lab.example.test"); // undefined
 * ```
 */
export function parseNetwork(
  entry: string,
):
  | { readonly address: string; readonly prefix: number; readonly type: "ipv4" | "ipv6" }
  | undefined {
  const [, address = "", written] = NETWORK.exec(entry) ?? [];
  const family = isIP(address);
  if (family === 0) return undefined;
  const most = family === 4 ? 32 : 128;
  const prefix = written === undefined ? most : Number(written);
  if (prefix > most) return undefined;
  return { address, prefix, type: family === 4 ? "ipv4" : "ipv6" };
}

/**
 * Which addresses an HTTP destination may connect to: any but the refused ranges, and those of the
 * refused ranges `allow` names.
 *
 * @example
 * ```ts
 * const guard = new AddressGuard(["10.20.0.0/16"]);
 * guard.permits("10.20.1.5"); // true
 * guard.permits("169.254.169.254"); // false
 * guard.permits("203.0.113.10"); // true
 * ```
 */
export class AddressGuard {
  private readonly allowed = new BlockList();
  private readonly resolve: typeof dnsLookup;

  /**
   * @param allow The networks of the refused ranges to allow, each as {@link parseNetwork} reads it.
   * @param resolve How a name is resolved; defaults to `dns.lookup`, the resolver Node uses.
   * @throws {RangeError} when an entry of `allow` is not an address or a network.
   */
  constructor(allow: readonly string[], resolve: typeof dnsLookup = dnsLookup) {
    for (const entry of allow) {
      const network = parseNetwork(entry);
      if (network === undefined)
        throw new RangeError("allowNetworks holds an entry that is not a network");
      this.allowed.addSubnet(network.address, network.prefix, network.type);
    }
    this.resolve = resolve;
  }

  /** Whether a connection to `address`, an IP address, is permitted. */
  permits(address: string): boolean {
    const type = isIP(address) === 6 ? "ipv6" : "ipv4";
    return !REFUSED.check(address, type) || this.allowed.check(address, type);
  }

  /**
   * The `lookup` an agent's sockets resolve their host with: every address of the name, the refused
   * ones dropped, and an error coded {@link ADDRESS_REFUSED} when none is left. Node calls it at
   * every connect, so a name that resolves elsewhere later is checked again.
   */
  readonly lookup: LookupFunction = (hostname, options, callback) => {
    this.resolve(hostname, { ...options, all: true }, (error, found) => {
      if (error !== null) {
        callback(error, "");
        return;
      }
      const permitted = found.filter(({ address }) => this.permits(address));
      const [first] = permitted;
      if (first === undefined) {
        callback(refused(), "");
      } else if (options.all === true) {
        callback(null, permitted);
      } else {
        callback(null, first.address, first.family);
      }
    });
  };
}

/** The error a refused connection fails with: its code alone, never the address. */
function refused(): NodeJS.ErrnoException {
  return Object.assign(new Error(`the address is not allowed (${ADDRESS_REFUSED})`), {
    code: ADDRESS_REFUSED,
  });
}

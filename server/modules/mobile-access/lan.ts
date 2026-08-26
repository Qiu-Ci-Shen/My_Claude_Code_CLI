// LAN IPv4 selection helpers, ported from dsh-pocket (GPL-2.0) lib/service.mjs + lib/ip.mjs.
// Picks the IPv4 a phone on the same WiFi can actually reach: physical NICs win,
// virtual adapters (Tailscale/vEthernet/WSL...) lose.

const PRIVATE_IPV4_RE = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

const PHYSICAL_IFACE_RE = /^(?:wlan|wi-?fi|wireless|ethernet|eth\d|en\d|wlp\d|以太网|有线|无线|本地连接)/i;

const VPN_IFACE_RE = /(?:radmin|tailscale|zerotier|easytier|et_|tun|tap|vpn|vethernet|virtual|vmware|virtualbox|wsl|docker|teredo|hamachi|bluetooth|bridge)/i;

export function isValidIpv4(value: unknown): boolean {
  const m = String(value ?? '').match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return m !== null && m.slice(1).every((part) => {
    const n = Number(part);
    return n >= 0 && n <= 255;
  });
}

type NetworkAddress = { family: string; address: string; internal: boolean };

type InterfaceMap = Record<string, NetworkAddress[]> | NodeJS.Dict<NetworkAddress[]>;

/** Score-sort all candidate IPv4 addresses; highest score is most phone-reachable. */
export function selectLanIPv4(interfaces: InterfaceMap): string | null {
  const candidates: { ip: string; score: number; order: number }[] = [];
  for (const [name, addrs] of Object.entries(interfaces ?? {})) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const ip = addr.address;
      if (!ip || ip.startsWith('127.') || ip.startsWith('169.254.')) continue;

      let score = 0;
      if (PRIVATE_IPV4_RE.test(ip)) score += 100;
      if (PHYSICAL_IFACE_RE.test(name)) score += 20;
      else if (VPN_IFACE_RE.test(name)) score -= 50;

      candidates.push({ ip, score, order: candidates.length });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.order - b.order);
  return candidates[0]?.ip ?? null;
}

/** All non-internal IPv4 addresses (manual-override candidates). */
export function listLanCandidates(interfaces: InterfaceMap): string[] {
  const ips: string[] = [];
  for (const [, addrs] of Object.entries(interfaces ?? {})) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const ip = addr.address;
      if (!ip || ip.startsWith('127.') || ip.startsWith('169.254.')) continue;
      if (!ips.includes(ip)) ips.push(ip);
    }
  }
  return ips;
}

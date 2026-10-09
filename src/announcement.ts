import { createHash } from "node:crypto";
import { isIP } from "node:net";

export const NAVICO_GROUP = "239.2.1.1";
export const NAVICO_PORT = 2053;
const MAX_PACKET_BYTES = 16384;

export interface NavicoApp {
  id: string;
  address: string;
  sender: string;
  source: string;
  feature: string;
  name: string;
  description: string;
  url: string;
  icon?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shortString(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= 2048
  );
}

export function parseAnnouncement(
  packet: Buffer,
  sender: string,
  language = "en",
): NavicoApp | undefined {
  if (packet.length > MAX_PACKET_BYTES || isIP(sender) !== 4) return;
  let value: unknown;
  try {
    value = JSON.parse(packet.toString("utf8").replace(/\0+$/, ""));
  } catch {
    return;
  }
  if (
    !record(value) ||
    String(value.Version) !== "1" ||
    !shortString(value.Source) ||
    !shortString(value.FeatureName) ||
    !shortString(value.URL)
  )
    return;
  const address = shortString(value.IP) ? value.IP : sender;
  if (isIP(address) !== 4) return;
  let url: URL;
  try {
    url = new URL(value.URL);
  } catch {
    return;
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    ![address, sender].includes(url.hostname)
  )
    return;
  const texts = Array.isArray(value.Text) ? value.Text.filter(record) : [];
  const text =
    texts.find((item) => item.Language === language) ??
    texts.find((item) => item.Language === "en") ??
    texts[0];
  let icon: string | undefined;
  if (shortString(value.Icon)) {
    try {
      const candidate = new URL(value.Icon, url);
      if (
        candidate.origin === url.origin &&
        !candidate.username &&
        !candidate.password
      ) {
        icon = candidate.href;
      }
    } catch {
      /* An unusable icon does not invalidate an application. */
    }
  }
  const identity = JSON.stringify([value.Source, address, value.FeatureName]);
  return {
    id: createHash("sha256").update(identity).digest("hex").slice(0, 24),
    address,
    sender,
    source: value.Source,
    feature: value.FeatureName,
    name: shortString(text?.Name) ? text.Name : value.FeatureName,
    description:
      typeof text?.Description === "string"
        ? text.Description.slice(0, 2048)
        : "",
    url: url.href,
    icon,
  };
}

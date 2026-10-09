import dgram from "node:dgram";
import { networkInterfaces } from "node:os";
import { isIP } from "node:net";
import type { Plugin, ServerAPI } from "@signalk/server-api";
import { NAVICO_GROUP, NAVICO_PORT, parseAnnouncement } from "./announcement";
import { Catalog } from "./catalog";

const PLUGIN_ID = "signalk-navico-mfd-app";
const MAX_APPS = 128;
const ICON_LIMIT_BYTES = 512 * 1024;

interface Settings {
  interfaces: string[];
  expirySeconds: number;
  language: string;
  launchMode: "embed" | "redirect";
}

function parseSettings(config: object): Settings {
  const value = config as Record<string, unknown>;
  const interfaces = value.interfaces ?? [];
  const expirySeconds = value.expirySeconds ?? 90;
  const language = value.language ?? "en";
  const launchMode = value.launchMode ?? "embed";
  if (
    !Array.isArray(interfaces) ||
    !interfaces.every((item) => typeof item === "string") ||
    typeof expirySeconds !== "number" ||
    !Number.isFinite(expirySeconds) ||
    expirySeconds < 15 ||
    expirySeconds > 3600 ||
    typeof language !== "string" ||
    !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(language) ||
    !["embed", "redirect"].includes(String(launchMode))
  ) {
    throw new Error("Invalid Navico discovery configuration");
  }
  return {
    interfaces,
    expirySeconds,
    language,
    launchMode: launchMode as Settings["launchMode"],
  };
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}

export = (app: ServerAPI): Plugin => {
  const catalog = new Catalog(app);
  let socket: dgram.Socket | undefined;
  let expiryTimer: NodeJS.Timeout | undefined;
  let settings = parseSettings({});
  let listening = false;
  let interfaceErrors: string[] = [];
  const iconRequests = new Set<AbortController>();

  function updateStatus(): void {
    app.setPluginStatus(
      `Navico: ${catalog.entries.size} application(s), UDP ${NAVICO_PORT}`,
    );
  }

  const plugin: Plugin = {
    id: PLUGIN_ID,
    name: "Navico MFD Apps",
    description:
      "Discover Navico network applications and publish individual Signal K webapps",
    schema: {
      type: "object",
      properties: {
        interfaces: {
          type: "array",
          title: "Network interfaces",
          default: [],
          description:
            "Interface names or local IPv4 addresses; empty selects all non-loopback IPv4 interfaces.",
          items: { type: "string" },
        },
        expirySeconds: {
          type: "number",
          title: "Announcement expiry (seconds)",
          default: 90,
          minimum: 15,
          maximum: 3600,
        },
        language: {
          type: "string",
          title: "Preferred announcement language",
          default: "en",
          pattern: "^[a-z]{2}(-[A-Z]{2})?$",
        },
        launchMode: {
          type: "string",
          title: "Launch mode",
          enum: ["embed", "redirect"],
          default: "embed",
        },
      },
    },
    start(config) {
      if (
        typeof app.registerWebapp !== "function" ||
        typeof app.unregisterWebapp !== "function"
      ) {
        throw new Error(
          "This plugin requires a Signal K server with the dynamic webapp registration API",
        );
      }
      settings = parseSettings(config);
      const interfaces = networkInterfaces();
      const localAddresses = new Set(
        Object.values(interfaces).flatMap((items) =>
          (items ?? [])
            .filter((item) => item.family === "IPv4")
            .map((item) => item.address),
        ),
      );
      const addresses = settings.interfaces.length
        ? settings.interfaces.flatMap((selection) => {
            if (isIP(selection) === 4) {
              if (
                !Object.values(interfaces)
                  .flat()
                  .some((item) => item?.address === selection)
              ) {
                throw new Error(`Not a local IPv4 address: ${selection}`);
              }
              return [selection];
            }
            const found = interfaces[selection]
              ?.filter((item) => item.family === "IPv4")
              .map((item) => item.address);
            if (!found?.length)
              throw new Error(`No IPv4 address on interface: ${selection}`);
            return found;
          })
        : Object.values(interfaces).flatMap((items) =>
            (items ?? [])
              .filter((item) => item.family === "IPv4" && !item.internal)
              .map((item) => item.address),
          );
      if (!addresses.length)
        throw new Error("No IPv4 interface available for Navico multicast");
      interfaceErrors = [];
      const receiver = dgram.createSocket({ type: "udp4", reuseAddr: true });
      socket = receiver;
      receiver.on("error", (error) => {
        listening = false;
        app.setPluginError(`Navico UDP: ${error.message}`);
        void plugin.stop();
      });
      receiver.on("message", (message, remote) => {
        if (socket !== receiver || !listening) return;
        const announcement = parseAnnouncement(
          message,
          remote.address,
          settings.language,
        );
        if (
          announcement?.source === "SignalK" &&
          announcement.feature === "Signal K webapps" &&
          localAddresses.has(announcement.address)
        )
          return;
        if (
          !announcement ||
          (!catalog.entries.has(announcement.id) &&
            catalog.entries.size >= MAX_APPS)
        )
          return;
        try {
          const size = catalog.entries.size;
          catalog.observe(announcement);
          if (catalog.entries.size !== size) updateStatus();
        } catch (error) {
          app.setPluginError(`Navico registration: ${String(error)}`);
        }
      });
      receiver.on("listening", () => {
        if (socket !== receiver) return;
        let joined = 0;
        for (const address of new Set(addresses)) {
          try {
            receiver.addMembership(NAVICO_GROUP, address);
            joined++;
          } catch (error) {
            interfaceErrors.push(`${address}: ${String(error)}`);
          }
        }
        if (!joined) {
          app.setPluginError(
            `Navico multicast failed: ${interfaceErrors.join("; ")}`,
          );
          void plugin.stop();
          return;
        }
        listening = true;
        if (interfaceErrors.length)
          app.setPluginError(interfaceErrors.join("; "));
        else updateStatus();
      });
      expiryTimer = setInterval(() => {
        const size = catalog.entries.size;
        catalog.expire(settings.expirySeconds * 1000);
        if (catalog.entries.size !== size) updateStatus();
      }, 5000);
      receiver.bind(NAVICO_PORT, "0.0.0.0");
    },
    async stop() {
      if (expiryTimer) clearInterval(expiryTimer);
      expiryTimer = undefined;
      listening = false;
      catalog.clear();
      for (const controller of iconRequests) controller.abort();
      const receiver = socket;
      socket = undefined;
      if (receiver)
        await new Promise<void>((resolve) => {
          try {
            receiver.close(() => resolve());
          } catch {
            resolve();
          }
        });
    },
    registerWithRouter(router) {
      const read = router.access("readonly");
      read.get("/apps", (_request, response) => {
        response.set("Cache-Control", "no-store").json({
          listening,
          multicastGroup: NAVICO_GROUP,
          port: NAVICO_PORT,
          interfaceErrors,
          apps: Array.from(catalog.entries.values()),
        });
      });
      read.get("/webapps/:id/", (request, response) => {
        const entry = catalog.entries.get(String(request.params.id));
        if (!entry) {
          response.status(404).send("Navico application unavailable");
          return;
        }
        if (!request.path.endsWith("/")) {
          response.redirect(307, `${request.baseUrl}${request.path}/`);
          return;
        }
        response.set("Cache-Control", "no-store");
        if (settings.launchMode === "redirect") {
          response.redirect(302, entry.url);
          return;
        }
        response
          .type("html")
          .send(
            `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(entry.name)}</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#fff}iframe{display:block;border:0;width:100%;height:100%}</style></head><body><iframe src="${escapeHtml(entry.url)}" title="${escapeHtml(entry.name)}" allow="fullscreen" allowfullscreen></iframe></body></html>`,
          );
      });
      read.get("/webapps/:id/icon", async (request, response) => {
        const entry = catalog.entries.get(String(request.params.id));
        if (!entry?.icon) {
          response.sendStatus(404);
          return;
        }
        const controller = new AbortController();
        iconRequests.add(controller);
        const timeout = setTimeout(() => controller.abort(), 5000);
        try {
          const upstream = await fetch(entry.icon, {
            signal: controller.signal,
            redirect: "error",
          });
          const type = upstream.headers.get("content-type")?.split(";")[0];
          if (
            !upstream.ok ||
            !type ||
            ![
              "image/png",
              "image/jpeg",
              "image/gif",
              "image/webp",
              "image/x-icon",
              "image/vnd.microsoft.icon",
            ].includes(type)
          ) {
            await upstream.body?.cancel();
            response.sendStatus(502);
            return;
          }
          const chunks: Uint8Array[] = [];
          let length = 0;
          if (upstream.body) {
            for await (const chunk of upstream.body) {
              length += chunk.length;
              if (length > ICON_LIMIT_BYTES) {
                controller.abort();
                throw new Error("Icon exceeds size limit");
              }
              chunks.push(chunk);
            }
          }
          response
            .type(type)
            .set("Cache-Control", "public, max-age=60")
            .send(Buffer.concat(chunks));
        } catch {
          response.sendStatus(502);
        } finally {
          clearTimeout(timeout);
          iconRequests.delete(controller);
        }
      });
    },
  };
  return plugin;
};

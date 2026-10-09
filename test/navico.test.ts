import { strict as assert } from "node:assert";
import { test } from "node:test";
import dgram from "node:dgram";
import http from "node:http";
import { once } from "node:events";
import express from "express";
import type { PluginRouter, ServerAPI } from "@signalk/server-api";
import createPlugin = require("../src/index");
import { parseAnnouncement, NAVICO_PORT } from "../src/announcement";
import { Catalog, WebappHost } from "../src/catalog";

function message(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      Version: "1",
      Source: "Victron",
      IP: "127.0.0.1",
      FeatureName: "Energy",
      URL: "http://127.0.0.1:8099/app/",
      Icon: "/icon.png",
      Text: [
        { Language: "en", Name: "Energy", Description: "Battery" },
        { Language: "fr", Name: "Energie" },
      ],
      ...overrides,
    }),
  );
}

test("parses Navico announcements with language fallback and stable feature identity", () => {
  const app = parseAnnouncement(message(), "127.0.0.1", "fr")!;
  assert.equal(app.name, "Energie");
  assert.equal(app.icon, "http://127.0.0.1:8099/icon.png");
  assert.equal(parseAnnouncement(message(), "127.0.0.1", "de")?.name, "Energy");
  assert.equal(
    app.id,
    parseAnnouncement(
      message({ URL: "http://127.0.0.1:9000/new/" }),
      "127.0.0.1",
    )?.id,
  );
  assert.notEqual(
    app.id,
    parseAnnouncement(message({ FeatureName: "Tanks" }), "127.0.0.1")?.id,
  );
  assert.equal(
    parseAnnouncement(Buffer.concat([message(), Buffer.from([0])]), "127.0.0.1")
      ?.id,
    app.id,
  );
});

test("ignores malformed packets and unsafe destinations while tolerating missing icons", () => {
  for (const packet of [
    Buffer.from("garbage"),
    Buffer.alloc(20000),
    message({ Version: "2" }),
    message({ URL: "javascript:alert(1)" }),
    message({ URL: "http://user:password@127.0.0.1/" }),
    message({ URL: "http://other.example/" }),
    message({ IP: "invalid" }),
    message({ FeatureName: "" }),
  ]) {
    assert.equal(parseAnnouncement(packet, "127.0.0.1"), undefined);
  }
  assert.equal(
    parseAnnouncement(
      message({ Icon: "http://other.example/icon" }),
      "127.0.0.1",
    )?.icon,
    undefined,
  );
  assert.ok(
    parseAnnouncement(message({ Icon: null, Text: null }), "127.0.0.1"),
  );
});

test("catalog publishes two apps, refreshes without duplicates, updates and expires independently", () => {
  const registered = new Map<string, object>();
  let calls = 0;
  const host: WebappHost = {
    registerWebapp(id, options) {
      calls++;
      registered.set(id, options);
      return `/plugins/navico/webapps/${id}/`;
    },
    unregisterWebapp(id) {
      registered.delete(id);
    },
  };
  const catalog = new Catalog(host);
  const energy = parseAnnouncement(message(), "127.0.0.1")!;
  const tanks = parseAnnouncement(
    message({ FeatureName: "Tanks" }),
    "127.0.0.1",
  )!;
  catalog.observe(energy, 1000);
  catalog.observe(tanks, 1000);
  catalog.observe(energy, 2000);
  assert.equal(calls, 2);
  assert.equal(registered.size, 2);
  catalog.observe(
    { ...energy, name: "New name", url: "http://127.0.0.1/new/" },
    3000,
  );
  assert.equal(calls, 3);
  assert.equal(catalog.entries.get(energy.id)?.url, "http://127.0.0.1/new/");
  catalog.expire(3000, 4000);
  assert.equal(registered.size, 1);
  assert.ok(registered.has(energy.id));
  catalog.clear();
  assert.equal(registered.size, 0);
});

test("real UDP receiver publishes routes, proxies a raster icon and cleans up on restart", async () => {
  const registered = new Map<string, object>();
  let ready: (() => void) | undefined;
  const host = {
    registerWebapp(id: string, options: object) {
      registered.set(id, options);
      return `/plugins/signalk-navico-mfd-app/webapps/${id}/`;
    },
    unregisterWebapp(id: string) {
      registered.delete(id);
    },
    setPluginStatus() {
      ready?.();
    },
    setPluginError(error: string) {
      throw new Error(error);
    },
  };
  const plugin = createPlugin(host as unknown as ServerAPI);
  const router = express.Router() as PluginRouter;
  router.access = () => router;
  plugin.registerWithRouter!(router);
  const web = express();
  web.use(`/plugins/${plugin.id}`, router);
  const httpServer = http.createServer(web).listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const bound = httpServer.address();
  assert.ok(bound && typeof bound !== "string");
  const origin = `http://127.0.0.1:${bound.port}`;
  const sender = dgram.createSocket("udp4");
  const icon = http.createServer((_request, response) =>
    response
      .writeHead(200, { "Content-Type": "image/png" })
      .end(Buffer.from([1, 2, 3])),
  );
  icon.listen(0, "127.0.0.1");
  await once(icon, "listening");
  const iconBound = icon.address();
  assert.ok(iconBound && typeof iconBound !== "string");
  const appOrigin = `http://127.0.0.1:${iconBound.port}`;
  try {
    for (let cycle = 0; cycle < 2; cycle++) {
      await new Promise<void>((resolve) => {
        ready = resolve;
        plugin.start({ interfaces: ["127.0.0.1"] }, () => {});
      });
      ready = undefined;
      const packets = [
        message({ URL: `${appOrigin}/app/` }),
        message({ FeatureName: "Tanks", URL: `${appOrigin}/app/` }),
        message({
          Source: "SignalK",
          FeatureName: "Signal K webapps",
          URL: `${appOrigin}/`,
        }),
      ];
      for (const packet of packets)
        await new Promise<void>((resolve, reject) =>
          sender.send(packet, NAVICO_PORT, "127.0.0.1", (error) =>
            error ? reject(error) : resolve(),
          ),
        );
      let data: { apps: Array<{ id: string; location: string }> } = {
        apps: [],
      };
      for (let tries = 0; tries < 50; tries++) {
        data = await fetch(`${origin}/plugins/${plugin.id}/apps`).then(
          (response) => response.json(),
        );
        if (data.apps.length === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(data.apps.length, 2);
      assert.equal(registered.size, 2);
      const location = data.apps[0]!.location;
      const wrapper = await fetch(origin + location).then((response) =>
        response.text(),
      );
      assert.ok(wrapper.includes(`<iframe src="${appOrigin}/app/"`));
      const trailingSlash = await fetch(origin + location.slice(0, -1), {
        redirect: "manual",
      });
      assert.equal(trailingSlash.headers.get("location"), location);
      const image = await fetch(origin + location + "icon");
      assert.equal(image.headers.get("content-type"), "image/png");
      assert.deepEqual(
        Buffer.from(await image.arrayBuffer()),
        Buffer.from([1, 2, 3]),
      );
      await plugin.stop();
      assert.equal(registered.size, 0);
      assert.equal((await fetch(origin + location)).status, 404);
    }
  } finally {
    ready = undefined;
    await plugin.stop();
    sender.close();
    await Promise.all([
      new Promise<void>((resolve) => httpServer.close(() => resolve())),
      new Promise<void>((resolve) => icon.close(() => resolve())),
    ]);
  }
});

test("fails explicitly without server API support or with invalid interface configuration", () => {
  const old = createPlugin({} as ServerAPI);
  assert.throws(
    () => old.start({}, () => {}),
    /dynamic webapp registration API/,
  );
  const plugin = createPlugin({
    registerWebapp() {},
    unregisterWebapp() {},
  } as unknown as ServerAPI);
  assert.throws(
    () => plugin.start({ interfaces: ["no-such-interface"] }, () => {}),
    /No IPv4/,
  );
  assert.throws(() => plugin.start({ expirySeconds: 0 }, () => {}), /Invalid/);
});

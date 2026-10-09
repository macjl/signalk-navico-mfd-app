# Signal K Navico MFD Apps

Signal K plugin dedicated to Navico MFD application announcements (B&G, Simrad,
Lowrance). Listens to JSON announcements on `239.2.1.1:2053` and registers each
application as a separate standalone Signal K webapp. Garmin and Raymarine
discovery are not supported.

## Prototype Status

This is an experimental, testable prototype, not a production release. It is
published on GitHub only, not npm. The package is marked `private` to prevent
accidental npm publication until the server API is available in a released
Signal K server.

Requires Node.js 22 or later and the companion Signal K server change providing
`registerWebapp()` and `unregisterWebapp()`:
[Signal K server PR #3140](https://github.com/SignalK/signalk-server/pull/3140).
An unmodified server reports a clear plugin startup error. There are no runtime
npm dependencies.

Automated tests cover parsing, validation, stable identities, independent
registrations, expiry, real UDP reception, HTTP routes, icon fetching and restart
cleanup. Docker sandbox tests with simulated multicast announcements also
preserved all existing webapps and verified access controls. Discovery and
display of a real Cerbo GX still require hardware validation; this prototype
does not claim full MFD emulation or compatibility with every Navico app.

## Build and Install

Until the server API is released, the development dependency uses a sibling
checkout of the patched server. Clone both repositories:

```sh
git clone --branch feat/dynamic-plugin-webapps https://github.com/macjl/signalk-server.git signalk-server-navico-webapps
git -C signalk-server-navico-webapps checkout b546f09b5a46f3f2eed74bd88a34b6268e15ca44
git clone https://github.com/macjl/signalk-navico-mfd-app.git
```

Keep this layout:

```text
signalk-server-navico-webapps/
signalk-navico-mfd-app/
```

Build the patched SDK first, then the plugin. Only the SDK is needed to compile
and test the plugin; running it requires a server with the patch applied.

```sh
cd ../signalk-server-navico-webapps
npm install --workspace @signalk/server-api --include-workspace-root --ignore-scripts
npm run build --workspace @signalk/server-api
cd ../signalk-navico-mfd-app
npm ci
npm test
npm pack
```

Install the generated tarball into the Signal K configuration directory with
`npm install /path/to/signalk-navico-mfd-app-0.1.0.tgz --ignore-scripts` and restart
the server. Enable **Navico MFD Apps** in Plugin Config. In Webapps, each detected
application appears individually when the page is opened or refreshed. No server
restart is required after discovery.

## Configuration

| Setting         | Default | Meaning                                                                                      |
| --------------- | ------- | -------------------------------------------------------------------------------------------- |
| `interfaces`    | `[]`    | All non-loopback IPv4 interfaces; optionally select interface names or local IPv4 addresses. |
| `expirySeconds` | `90`    | Remove entries after this many seconds without an announcement.                              |
| `language`      | `en`    | Preferred label language; fall back to English then the first translation.                   |
| `launchMode`    | `embed` | Fullscreen iframe; `redirect` opens the discovered app directly if framing is blocked.       |

Diagnostics: `/plugins/signalk-navico-mfd-app/apps`. Returns listener state,
interface membership errors, original URLs, last-seen times and individual webapp
locations. Plugin debug/error status is available in the server admin UI.

Applications are distinguished by `(Source, IP, FeatureName)`. Changing an app
URL or label keeps its Signal K URL stable; changing its advertised IP changes
its identity. Duplicate periodic announcements refresh the same entry. Stop,
disable or reconfigure the plugin to withdraw all its registrations.

Only version 1 announcements with HTTP(S) application URLs on the advertised or
sending IPv4 address are accepted. Icons must use the application's origin;
raster images are fetched through Signal K with time and size limits. Up to 128
applications can be registered.

## Network and Docker

The discovery receiver and equipment must share a multicast-capable network.
Unicast IP routing, a VPN or HTTP access to the GX application does not by
itself transport Navico announcements. Use a multicast relay/routing setup or
run Signal K on the equipment's LAN. The receiver also accepts announcements
forwarded to its UDP port by a relay.

On Docker Engine for Linux, `network_mode: host` is the recommended prototype
setup. No `ports:` mapping is needed. Host mode is **not mandatory**: `macvlan`
(or an appropriately configured L2 network) can also put the container on the
equipment LAN. A default Docker bridge plus `2053:2053/udp` alone is not a
multicast forwarding setup. Docker Desktop host networking is not equivalent
to Linux host networking for LAN multicast; validate reception explicitly.

References: [Docker host networking](https://docs.docker.com/engine/network/drivers/host/),
[Docker macvlan](https://docs.docker.com/engine/network/drivers/macvlan/).

The browser also needs HTTP(S) and WebSocket access to the discovered equipment:
the plugin does not proxy the application or its data connections. An HTTPS
Signal K page cannot embed an HTTP equipment app without browser mixed-content
restrictions. Embedded apps must permit framing. App-dock can select these entries
through its existing webapp discovery, but automatic dock insertion and its
double-tap gesture inside a cross-origin iframe are not provided by this plugin.

## Simulator

Two apps are announced every ten seconds, on one IP with different feature names:

```sh
npm run build
node dist/tools/simulate.js LOCAL_IPV4
```

For a local receiver test without depending on LAN multicast forwarding:

```sh
node dist/tools/simulate.js 127.0.0.1 127.0.0.1 8099
```

The optional arguments are bind address, destination address, HTTP port and
destination UDP port. This last example sends real Navico-format UDP packets by
unicast; it does not validate multicast forwarding. After stopping the simulator,
both entries disappear after the configured expiry period. It does not announce
the Cerbo or claim that a real device was discovered.

## Cerbo GX Validation

Enable Navico/MFD app integration on the GX as appropriate for its firmware.
Check that announcements reach the Signal K host:

```sh
tcpdump -ni eth0 -A 'udp dst port 2053'
```

Then open the diagnostics API and the Webapps page. Verify the announced URL,
icon and application contents. HTTP accessibility alone is not proof of Navico
discovery. A real GX's announcement format and behaviour without a physical MFD
still need validation against this prototype.

Protocol reference: [Navico announcement implementation](https://github.com/htool/signalk-mfd-plugin/blob/master/plugin/index.js).

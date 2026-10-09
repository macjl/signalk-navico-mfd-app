import dgram from "node:dgram";
import http from "node:http";
import { NAVICO_GROUP, NAVICO_PORT } from "../src/announcement";

const address = process.argv[2] ?? "127.0.0.1";
const target = process.argv[3] ?? NAVICO_GROUP;
const webPort = Number(process.argv[4] ?? 8099);
const receiverPort = Number(process.argv[5] ?? NAVICO_PORT);
const origin = `http://${address}:${webPort}`;
const icon = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const server = http.createServer((request, response) => {
  if (request.url === "/icon.png") {
    response.writeHead(200, { "Content-Type": "image/png" }).end(icon);
    return;
  }
  const second = request.url?.startsWith("/tanks");
  response
    .writeHead(200, { "Content-Type": "text/html" })
    .end(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${second ? "Tanks" : "Energy"}</title><style>body{font:20px system-ui;margin:32px;color:#20252a;background:#fff}h1{font-size:28px}button{font:inherit;padding:8px}progress{width:240px;max-width:100%}</style></head><body><h1>${second ? "Tanks" : "Energy"}</h1><p>${second ? "Fresh water" : "Battery"}</p><progress value="72" max="100"></progress><p>72%</p><button onclick="this.textContent=this.textContent==='Running'?'Stopped':'Running'">Stopped</button></body></html>`,
    );
});
const sender = dgram.createSocket("udp4");
let timer: NodeJS.Timeout | undefined;
function publish(): void {
  for (const [feature, path] of [
    ["Energy", "/energy/"],
    ["Tanks", "/tanks/"],
  ]) {
    const message = Buffer.from(
      JSON.stringify({
        Version: "1",
        Source: "Navico prototype simulator",
        IP: address,
        FeatureName: feature,
        Text: [
          {
            Language: "en",
            Name: `Navico ${feature}`,
            Description: `Simulated ${feature} application`,
          },
        ],
        Icon: `${origin}/icon.png`,
        URL: `${origin}${path}`,
        BrowserPanel: { Enable: true },
      }),
    );
    sender.send(message, receiverPort, target);
  }
}
server.listen(webPort, address, () => {
  sender.bind(0, address, () => {
    sender.setMulticastInterface(address);
    publish();
    timer = setInterval(publish, 10000);
    console.log(
      `Two simulated Navico apps at ${origin}; announcements to ${target}:${receiverPort}`,
    );
  });
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (timer) clearInterval(timer);
    sender.close();
    server.close();
  });
}

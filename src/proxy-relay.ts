// Local proxy relay: Chrome cannot take proxy credentials on the command line, and answering
// Fetch.authRequired per tab misses workers and early requests. Instead we listen on 127.0.0.1,
// accept plain proxy traffic from Chrome, and forward it to the upstream proxy with
// Proxy-Authorization injected. Handles CONNECT (https/wss) and absolute-URI http requests.
import { createServer, connect, type Server, type Socket } from "node:net";

export type Upstream = { host: string; port: number; username: string; password: string };

export async function startProxyRelay(up: Upstream, listenPort = 0): Promise<{ port: number; server: Server }> {
  const auth = "Basic " + Buffer.from(`${up.username}:${up.password}`).toString("base64");
  const server = createServer((client: Socket) => {
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) { if (head.length > 64 * 1024) client.destroy(); return; }
      client.off("data", onData);
      client.pause();
      const headerText = head.subarray(0, end).toString("latin1");
      const rest = head.subarray(end + 4);
      const isConnect = /^CONNECT /i.test(headerText);
      // Plain-http requests: forbid keep-alive so every request passes through here and gets auth.
      const lines = headerText.split("\r\n").filter((l) => !/^proxy-authorization:/i.test(l) && (isConnect || !/^(proxy-)?connection:/i.test(l)));
      if (!isConnect) lines.push("Connection: close");
      lines.splice(1, 0, `Proxy-Authorization: ${auth}`);
      const upstream = connect(up.port, up.host, () => {
        upstream.write(lines.join("\r\n") + "\r\n\r\n");
        if (rest.length) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      });
      const kill = () => { client.destroy(); upstream.destroy(); };
      upstream.on("error", kill);
      client.on("error", kill);
      upstream.on("close", () => client.destroy());
      client.on("close", () => upstream.destroy());
    };
    client.on("data", onData);
    client.on("error", () => client.destroy());
  });
  await new Promise<void>((r) => server.listen(listenPort, "127.0.0.1", r));
  const addr = server.address();
  return { port: typeof addr === "object" && addr ? addr.port : 0, server };
}

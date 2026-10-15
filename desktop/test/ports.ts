import { createServer, type Server } from "node:net";

/**
 * A free port for each name, all distinct: every socket stays open until all are bound, since a
 * port freed by closing its socket can be handed out again to the next bind (#1786).
 */
export async function freePorts<K extends string>(names: readonly K[]): Promise<Record<K, number>> {
  const servers = await Promise.all(
    names.map(
      () =>
        new Promise<Server>((done, fail) => {
          const s = createServer();
          s.once("error", fail);
          s.listen(0, () => done(s));
        }),
    ),
  );
  const ports = Object.fromEntries(
    servers.map((s, i) => [names[i], (s.address() as { port: number }).port]),
  ) as Record<K, number>;
  await Promise.all(servers.map((s) => new Promise((done) => s.close(done))));
  return ports;
}

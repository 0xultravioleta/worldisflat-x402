import assert from "node:assert/strict";
import { test } from "node:test";
import { connectChain } from "../src/chain.js";
import { loadConfig } from "../src/config.js";

const someone = "0x00000000000000000000000000000000000000bb";

test("an RPC that fails charges the standard price, never the holder price", async () => {
  // port 9 (discard) refuses connections: every read fails
  const chain = connectChain(loadConfig({ NETWORK: "robinhood", PAY_TO: someone, RPC_URL: "http://127.0.0.1:9" }));
  assert.equal(await chain.tierOf(someone), "standard");
});

test("no $WIF token means everyone is standard, without touching the RPC", async () => {
  const chain = connectChain(loadConfig({ NETWORK: "robinhood-testnet", PAY_TO: someone, RPC_URL: "http://127.0.0.1:9" }));
  assert.equal(await chain.tierOf(someone), "standard");
});

test("sendWif refuses without a merchant wallet or with a zero amount", async () => {
  const chain = connectChain(loadConfig({ NETWORK: "robinhood", PAY_TO: someone, RPC_URL: "http://127.0.0.1:9" }));
  await assert.rejects(chain.sendWif(someone, 1n), /no merchant wallet/);
  const withKey = connectChain(
    loadConfig({ NETWORK: "robinhood", PAY_TO: someone, RPC_URL: "http://127.0.0.1:9", MERCHANT_PRIVATE_KEY: "0x" + "22".repeat(32) }),
  );
  await assert.rejects(withKey.sendWif(someone, 0n), /above zero/);
});

test("a Config built by hand with a malformed merchant key fails without printing it", () => {
  const cfg = loadConfig({ NETWORK: "robinhood", PAY_TO: someone, RPC_URL: "http://127.0.0.1:9" });
  const bad = "0x" + "de".repeat(31) + "f";
  assert.throws(() => connectChain({ ...cfg, merchantKey: bad }), (e: unknown) => {
    const m = (e as Error).message;
    return /MERCHANT_PRIVATE_KEY/.test(m) && !m.includes(bad.slice(2, 20));
  });
});

test("the holder tier starts exactly at WIF_HOLDER_MIN", async () => {
  // a fake JSON-RPC that answers balanceOf(owner) with the balance encoded in the owner's last byte, in whole $WIF
  const { serve } = await import("@hono/node-server");
  const { Hono } = await import("hono");
  const rpc = new Hono();
  rpc.post("/", async (c) => {
    const body = await c.req.json();
    const one = (r: { id: number; method: string; params: any[] }) => {
      if (r.method === "eth_chainId") return { jsonrpc: "2.0", id: r.id, result: "0x1237" };
      const data: string = r.params?.[0]?.data ?? "";
      const units = BigInt("0x" + data.slice(-2)) * 10n ** 18n;
      return { jsonrpc: "2.0", id: r.id, result: "0x" + units.toString(16).padStart(64, "0") };
    };
    return c.json(Array.isArray(body) ? body.map(one) : one(body));
  });
  const port = 40000 + Math.floor(Math.random() * 10000);
  const server = serve({ fetch: rpc.fetch, port });
  try {
    const chain = connectChain(loadConfig({ NETWORK: "robinhood", PAY_TO: someone, RPC_URL: `http://127.0.0.1:${port}`, WIF_HOLDER_MIN: "100" }));
    const holds = (n: number) => "0x00000000000000000000000000000000000000" + n.toString(16).padStart(2, "0");
    assert.equal(await chain.tierOf(holds(99)), "standard");
    assert.equal(await chain.tierOf(holds(100)), "holder");
    assert.equal(await chain.tierOf(holds(101)), "holder");
  } finally {
    server.close();
  }
});

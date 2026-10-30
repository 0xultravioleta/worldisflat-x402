// When a run asks for a closed network (CI and scripts/ci/preflight.sh do), prove it is closed: Node 22's fetch
// ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1, so the proxy variables alone would close nothing.
import assert from "node:assert/strict";
import { test } from "node:test";

const closed = process.env.NODE_USE_ENV_PROXY === "1" && /127\.0\.0\.1:9$/.test(process.env.HTTPS_PROXY ?? "");

test("the network is really closed when the run asks for it", { skip: closed ? false : "run without the closed-network variables" }, async () => {
  await assert.rejects(fetch("https://example.com", { signal: AbortSignal.timeout(10_000) }), (e: Error & { cause?: { code?: string } }) => {
    return e.cause?.code === "ECONNREFUSED";
  });
});

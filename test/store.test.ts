import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Store } from "../src/store.js";

test("the store survives a restart", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "flatfee-store-"));
  try {
    const a = new Store(dir);
    a.addLedger({ kind: "ask", network: "eip155:46630", payer: "0x1", tier: "standard", price: "100000", settleTx: "0xab", cashbackTx: null });
    a.createTask({ request: "r", payer: "0x1", paidTx: "0xab" });
    const b = new Store(dir);
    assert.equal(b.ledger().length, 1);
    assert.equal(b.tasks().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt state file stops the store instead of being overwritten, and reset clears it", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "flatfee-store-"));
  try {
    const file = path.join(dir, "state.json");
    for (const bad of ["{not json", "{}", '{"ledger": {}, "tasks": []}', "null"]) {
      writeFileSync(file, bad);
      assert.throws(() => new Store(dir), /npm run reset/, bad);
      assert.equal(readFileSync(file, "utf8"), bad, "the file was touched");
    }
    Store.resetDir(dir);
    assert.equal(new Store(dir).ledger().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

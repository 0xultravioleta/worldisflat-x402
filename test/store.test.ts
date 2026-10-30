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

test("the $WIF budget is per day, survives a restart, and a release only touches its own day", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "flatfee-store-"));
  try {
    const a = new Store(dir);
    assert.equal(a.reserveWif("2026-10-30", 6n, 10n), true);
    assert.equal(a.reserveWif("2026-10-30", 4n, 10n), true);
    assert.equal(a.reserveWif("2026-10-30", 1n, 10n), false);
    const b = new Store(dir);
    assert.equal(b.wifSpent("2026-10-30"), 10n);
    b.releaseWif("2026-10-29", 4n); // yesterday's reservation: nothing to give back today
    assert.equal(b.wifSpent("2026-10-30"), 10n);
    b.releaseWif("2026-10-30", 4n);
    assert.equal(b.wifSpent("2026-10-30"), 6n);
    assert.equal(b.wifSpent("2026-10-31"), 0n);
    assert.equal(b.reserveWif("2026-10-31", 10n, 10n), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt state file stops the store instead of being overwritten, and reset clears it", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "flatfee-store-"));
  try {
    const file = path.join(dir, "state.json");
    const unreadableBudget = '{"ledger": [], "tasks": [], "wifBudget": {"day": "2026-10-30", "spent": "-1"}}';
    for (const bad of ["{not json", "{}", '{"ledger": {}, "tasks": []}', "null", unreadableBudget]) {
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

// `npm run reset`: empties the ledger and the task board (DATA_DIR/state.json) for a clean demo recording.
// Stop the server first: it keeps the state in memory and would write the old ledger back on its next save.
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { Store } from "../src/store.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const port = Number(process.env.PORT ?? 3000);
const listening = await new Promise<boolean>((resolve) => {
  const s = connect({ host: "127.0.0.1", port }, () => {
    s.end();
    resolve(true);
  });
  s.on("error", () => resolve(false));
  s.setTimeout(1000, () => {
    s.destroy();
    resolve(false);
  });
});
if (listening) {
  console.error(`something is listening on port ${port}: stop the server first, or the reset would not stick`);
  process.exit(1);
}
const dir = process.env.DATA_DIR?.trim() || "data";
console.log(`cleared ${Store.resetDir(dir)}`);

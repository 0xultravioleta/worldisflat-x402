// `npm run reset`: empties the ledger and the task board (DATA_DIR/state.json) for a clean demo recording.
import { existsSync } from "node:fs";
import { Store } from "../src/store.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const dir = process.env.DATA_DIR?.trim() || "data";
new Store(dir).reset();
console.log(`cleared ${dir}/state.json`);

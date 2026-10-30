// What every script reads from .env, with errors that name the variable and never print a key.
import { ConfigError, loadConfig, privateKey, type Config } from "../../src/config.js";

type Env = Record<string, string | undefined>;

/** loadConfig, or a one-line message and exit 1 */
export function configOrExit(env: Env = process.env): Config {
  try {
    return loadConfig(env);
  } catch (e) {
    console.error(`config: ${e instanceof ConfigError ? e.message : "unreadable"}\nCopy .env.example to .env and fill it in (see README).`);
    process.exit(1);
  }
}

/** a private key that must be set, or a one-line message and exit 1 */
export function keyOrExit(name: string, env: Env = process.env): string {
  let key: string | null = null;
  try {
    key = privateKey(env, name);
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : `${name} could not be read; the value is not shown`);
    process.exit(1);
  }
  if (!key) {
    console.error(`${name} is not set in .env`);
    process.exit(1);
  }
  return key;
}

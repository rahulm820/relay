// Usage: npm run telegram:register -w @relay/channels -- --bot-id <uuid> [--dry-run]
// Env: DATABASE_URL (relay_api login), TELEGRAM_WEBHOOK_PUBLIC_URL (https), and the bot token variable
// named by the bot's credentials_ref (the seeded bot uses TELEGRAM_BOT_TOKEN).
import { createPool } from "@relay/db";
import { registerTelegramWebhook } from "./register.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const botId = args[args.indexOf("--bot-id") + 1];
const databaseUrl = process.env["DATABASE_URL"];
const publicUrl = process.env["TELEGRAM_WEBHOOK_PUBLIC_URL"];

const missing = [
  !botId || botId.startsWith("--") ? "--bot-id" : null,
  !databaseUrl ? "DATABASE_URL" : null,
  !publicUrl ? "TELEGRAM_WEBHOOK_PUBLIC_URL" : null,
].filter(Boolean);
if (missing.length) {
  console.error(`missing: ${missing.join(", ")}`);
  process.exit(1);
}

const pool = createPool(databaseUrl!);
try {
  await registerTelegramWebhook({ pool, botId: botId!, env: process.env, publicUrl: publicUrl!, dryRun, out: (l) => console.log(l) });
} catch (err) {
  // Error messages from this code never carry the token, the secret or message text.
  console.error(`failed: ${err instanceof Error ? err.message : "unknown error"}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}

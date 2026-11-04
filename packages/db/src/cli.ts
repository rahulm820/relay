// Usage: node dist/cli.js migrate | migrate:down [steps] | seed
// Reads DATABASE_ADMIN_URL (the schema owner). Passwords for the service roles come from
// RELAY_API_DB_PASSWORD / RELAY_WORKER_DB_PASSWORD when set.
import { createPool } from "./client.js";
import { migrateDown, migrateUp, setRolePasswords } from "./migrate.js";
import { seed } from "./seed.js";

const [command, arg] = process.argv.slice(2);
const url = process.env["DATABASE_ADMIN_URL"];
if (!url) {
  console.error("DATABASE_ADMIN_URL is required");
  process.exit(1);
}

const pool = createPool(url);
try {
  if (command === "migrate") {
    console.log("applied:", (await migrateUp(pool)).join(", ") || "(nothing pending)");
    await setRolePasswords(pool, {
      relay_api: process.env["RELAY_API_DB_PASSWORD"],
      relay_worker: process.env["RELAY_WORKER_DB_PASSWORD"],
    });
  } else if (command === "migrate:down") {
    console.log("reverted:", (await migrateDown(pool, arg ? Number(arg) : 1)).join(", ") || "(nothing)");
  } else if (command === "seed") {
    await seed(pool);
    console.log("seeded demo tenant");
  } else {
    console.error("unknown command; use migrate | migrate:down [steps] | seed");
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}

import pg from "pg";

const source = process.env.DATABASE_URL;
if (!source) {
  console.error("DATABASE_URL missing");
  process.exit(1);
}

const targetName = process.env.PYSNE_DB_NAME || "pysne";
if (!/^[a-z][a-z0-9_]*$/.test(targetName)) {
  console.error("Invalid PYSNE_DB_NAME");
  process.exit(1);
}

const ssl = /render\.com|amazonaws\.com/.test(new URL(source).hostname)
  ? { rejectUnauthorized: false }
  : undefined;

const admin = new pg.Client({ connectionString: source, ssl });
await admin.connect();
const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [
  targetName,
]);
if (exists.rowCount === 0) {
  await admin.query(`CREATE DATABASE ${targetName}`);
  console.error(`Created database ${targetName}`);
} else {
  console.error(`Database ${targetName} already exists`);
}
await admin.end();

const url = new URL(source);
url.pathname = `/${targetName}`;
const targetUrl = url.toString();

const target = new pg.Client({ connectionString: targetUrl, ssl });
await target.connect();
const tables = await target.query(
  "SELECT to_regclass('public.users') AS users, to_regclass('public.markers') AS markers",
);
await target.end();

const ready = Boolean(tables.rows[0]?.users) && Boolean(tables.rows[0]?.markers);
console.error(ready ? "Schema ready" : "Schema missing core tables");

// Line 1: connection URL for the start script. Line 2: SCHEMA_READY|SCHEMA_MISSING
process.stdout.write(`${targetUrl}\n${ready ? "SCHEMA_READY" : "SCHEMA_MISSING"}\n`);

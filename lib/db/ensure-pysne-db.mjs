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

const url = new URL(source);
const client = new pg.Client({
  connectionString: source,
  ssl: /render\.com|amazonaws\.com/.test(url.hostname)
    ? { rejectUnauthorized: false }
    : undefined,
});

await client.connect();
const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [targetName]);
if (exists.rowCount === 0) {
  await client.query(`CREATE DATABASE ${targetName}`);
  console.error(`Created database ${targetName}`);
} else {
  console.error(`Database ${targetName} already exists`);
}
await client.end();

url.pathname = `/${targetName}`;
process.stdout.write(url.toString());

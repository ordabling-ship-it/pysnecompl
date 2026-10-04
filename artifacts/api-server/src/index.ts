import app from "./app";
import { logger } from "./lib/logger";
import { prepareDatabase } from "./lib/prepare-database";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function startServer(): Promise<void> {
  try {
    await prepareDatabase();
  } catch (err) {
    logger.error({ err }, "Database preparation failed");
    process.exit(1);
  }

  app.listen(port, () => {
    logger.info({ port }, "Server listening");
  });
}

void startServer();

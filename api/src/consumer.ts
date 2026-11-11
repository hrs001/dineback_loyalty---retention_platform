import { connectMongo } from "./lib/mongo.js";
import { logger } from "./lib/logger.js";
import { startConsumer } from "./services/consumer.js";

/**
 * Entrypoint for the Consumer process — runs as its own service, separate
 * from the API process (see System Architecture in the design doc).
 */
async function main() {
  await connectMongo();
  await startConsumer();
  logger.info("consumer process started");
}

main().catch((err) => {
  logger.error({ err }, "fatal consumer startup error");
  process.exit(1);
});

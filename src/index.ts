import dotenv from "dotenv";
dotenv.config();

import { startBrokerRunner } from "./broker-runner";

startBrokerRunner().catch((err) => {
  console.error("[Arbiter] Fatal:", err);
  process.exit(1);
});

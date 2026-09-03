import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import cors from "cors";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

// Dynamic import, not a plain top-level one: onboarding.ts pulls in db/pool.ts,
// which reads process.env.DATABASE_URL at module-load time. A hoisted static
// import would run before dotenv.config() above, capturing `undefined`.
const { onboardingRouter } = await import("./routes/onboarding.js");
const { depositFeedRouter } = await import("./routes/depositFeed.js");

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "tokenized-deposit-settlement-backend" });
});

app.use(onboardingRouter);
app.use(depositFeedRouter);

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
});

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const workspace = process.env.SOLEIL_LOCAL_GATEWAY_WORKSPACE;
const quotesUrl =
  process.env.SOLEIL_MAKER_QUOTES_URL || "http://127.0.0.1:8787/quotes";
const healthUrl = new URL("/health", quotesUrl);
let starting = null;
let ownedChild = null;

export async function makerHealth() {
  try {
    const response = await fetch(healthUrl, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return "offline";
    const body = await response.json();
    return body.configured === true ? "live" : "unconfigured";
  } catch {
    return "offline";
  }
}

export async function ensureMakerGateway() {
  if (!workspace) return;
  const status = await makerHealth();
  if (status === "live") return;
  if (status === "unconfigured")
    throw new Error("Maker gateway is running without its devnet configuration.");
  if (starting) return starting;
  starting = (async () => {
    const entry = join(workspace, "maker-gateway", "server.mjs");
    if (!existsSync(entry))
      throw new Error(`Maker gateway not found at ${entry}`);
    ownedChild = spawn(process.execPath, [entry], {
      cwd: workspace,
      stdio: "ignore",
      windowsHide: true,
    });
    ownedChild.on("error", (error) => {
      console.error("Maker gateway failed to start:", error);
    });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const current = await makerHealth();
      if (current === "live") return;
      if (current === "unconfigured")
        throw new Error("Maker gateway started without devnet configuration.");
      if (ownedChild.exitCode !== null)
        throw new Error(`Maker gateway exited with code ${ownedChild.exitCode}.`);
    }
    throw new Error("Maker gateway did not become healthy within 15 seconds.");
  })();
  try {
    await starting;
  } finally {
    starting = null;
  }
}

export function watchMakerGateway() {
  if (!workspace) return;
  void ensureMakerGateway().catch((error) =>
    console.error("Maker gateway unavailable:", error),
  );
  setInterval(() => {
    void ensureMakerGateway().catch((error) =>
      console.error("Maker gateway unavailable:", error),
    );
  }, 10_000);
}

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureMakerGateway, makerHealth, watchMakerGateway } from "./maker-supervisor.mjs";
import {
  missingFields,
  normalizeIntent,
  parseLocally,
  requestsPositionLifecycle,
} from "./intent.mjs";

const port = Number(process.env.AGENT_PORT || 8788);
const apiKey = process.env.GEMINI_API_KEY;
const makerQuotesUrl =
  process.env.SOLEIL_MAKER_QUOTES_URL || "http://127.0.0.1:8787/quotes";
const elevenKey = process.env.ELEVENLABS_API_KEY;
const elevenVoice = process.env.ELEVENLABS_VOICE_ID;
const snowflakeToken = process.env.SNOWFLAKE_TOKEN;
const snowflakeUrl = process.env.SNOWFLAKE_CORTEX_SEARCH_URL;
const distDir = join(fileURLToPath(new URL("..", import.meta.url)), "dist");

async function bodyJson(request, max = 12_000) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > max) throw new Error("Request too large");
  }
  return JSON.parse(raw);
}

async function serveStatic(pathname, response) {
  const path =
    pathname === "/"
      ? "index.html"
      : normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, "");
  const file = join(distDir, path);
  if (!file.startsWith(`${distDir}${sep}`)) return false;
  try {
    if (!(await stat(file)).isFile()) return false;
    const type =
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".woff2": "font/woff2",
      }[extname(file)] || "application/octet-stream";
    response.writeHead(200, { "content-type": type });
    response.end(await readFile(file));
    return true;
  } catch {
    return false;
  }
}

function reply(response, status, data) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(data));
}

async function geminiInterpret(message, previous) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text: "Extract intent for a Solana devnet SOL option order. Return JSON only. Never invent quantity, expiry, strike, or budget. Interpret protection/hedging as buying a put. Supported expiries are 7, 10, and 14 days. A number followed by SOL is quantity unless explicitly described as maximum spend or budget. Keep USD spending cap in maxPremiumUsd and SOL spending cap in maxPremiumSol. Existing state may be kept. Do not claim a trade was executed.",
            },
          ],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: JSON.stringify({ message, previous }) }],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              side: { type: "STRING", enum: ["buy", "sell"] },
              kind: { type: "STRING", enum: ["call", "put"] },
              quantitySol: { type: "NUMBER" },
              expiryDays: { type: "INTEGER" },
              targetStrikeUsd: { type: "NUMBER" },
              maxPremiumSol: { type: "NUMBER" },
              maxPremiumUsd: { type: "NUMBER" },
              objective: { type: "STRING" },
            },
          },
        },
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok)
    throw new Error(`Gemini request failed (${response.status})`);
  const body = await response.json();
  const content = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) throw new Error("Gemini returned no order intent");
  return normalizeIntent(JSON.parse(content), previous);
}

createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/api/health")
    return reply(response, 200, {
      ok: true,
      model: apiKey ? "gemini" : "local-parser",
      voice: elevenKey && elevenVoice ? "elevenlabs" : "browser",
      evidence: snowflakeToken && snowflakeUrl ? "snowflake" : "local",
      maker: await makerHealth(),
    });
  if (request.method === "POST" && request.url === "/api/speak") {
    if (!elevenKey || !elevenVoice)
      return reply(response, 503, { error: "ElevenLabs is not configured." });
    try {
      const { text } = await bodyJson(request, 2_000);
      if (typeof text !== "string" || !text.trim() || text.length > 400)
        return reply(response, 400, { error: "Short text required." });
      const upstream = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(elevenVoice)}`,
        {
          method: "POST",
          headers: {
            "xi-api-key": elevenKey,
            "content-type": "application/json",
            accept: "audio/mpeg",
          },
          body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!upstream.ok)
        return reply(response, 502, {
          error: `ElevenLabs unavailable (${upstream.status})`,
        });
      response.writeHead(200, {
        "content-type": "audio/mpeg",
        "cache-control": "no-store",
      });
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      return reply(response, 503, {
        error: error instanceof Error ? error.message : "Voice unavailable",
      });
    }
    return;
  }
  if (request.method === "POST" && request.url === "/api/evidence") {
    if (!snowflakeToken || !snowflakeUrl)
      return reply(response, 503, {
        error: "Snowflake Cortex Search is not configured.",
      });
    try {
      const { query } = await bodyJson(request, 2_000);
      if (typeof query !== "string" || !query.trim() || query.length > 300)
        return reply(response, 400, { error: "Short search query required." });
      const upstream = await fetch(snowflakeUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${snowflakeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query,
          columns: ["TITLE", "CONTENT", "SOURCE_URL"],
          limit: 4,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!upstream.ok)
        return reply(response, 502, {
          error: `Snowflake search unavailable (${upstream.status})`,
        });
      const data = await upstream.json();
      return reply(response, 200, {
        source: "snowflake",
        results: data.results || [],
      });
    } catch (error) {
      return reply(response, 503, {
        error:
          error instanceof Error
            ? error.message
            : "Evidence search unavailable",
      });
    }
  }
  if (request.method === "GET" && request.url?.startsWith("/api/quotes")) {
    try {
      await ensureMakerGateway();
      const input = new URL(request.url, "http://127.0.0.1");
      if (input.pathname !== "/api/quotes")
        return reply(response, 404, { error: "Not found" });
      const expiryDays = Number(input.searchParams.get("expiryDays"));
      const spot = Number(input.searchParams.get("spot"));
      if (
        ![7, 10, 14].includes(expiryDays) ||
        !Number.isFinite(spot) ||
        spot <= 0
      )
        return reply(response, 400, {
          error: "Valid SOL spot and 7, 10, or 14-day expiry required.",
        });
      const gateway = new URL(makerQuotesUrl);
      gateway.searchParams.set("underlying", "SOL");
      gateway.searchParams.set("expiryDays", String(expiryDays));
      gateway.searchParams.set("spot", String(spot));
      const upstream = await fetch(gateway, {
        signal: AbortSignal.timeout(65_000),
      });
      return reply(response, upstream.status, await upstream.json());
    } catch (error) {
      return reply(response, 503, {
        error:
          error instanceof Error ? error.message : "Maker gateway unavailable",
      });
    }
  }
  if (request.method === "GET" && request.url === "/api/spot") {
    try {
      const spotResponse = await fetch(
        "https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT",
        { signal: AbortSignal.timeout(8_000) },
      );
      if (!spotResponse.ok) throw new Error("SOL spot source unavailable");
      const price = Number((await spotResponse.json()).price);
      if (!Number.isFinite(price) || price <= 0)
        throw new Error("SOL spot source returned invalid price");
      return reply(response, 200, {
        price,
        source: "Binance SOLUSDT",
        observedAt: Date.now(),
      });
    } catch (error) {
      return reply(response, 503, {
        error: error instanceof Error ? error.message : "SOL spot unavailable",
      });
    }
  }
  if (
    request.method === "GET" &&
    request.url &&
    !request.url.startsWith("/api/")
  ) {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (await serveStatic(pathname, response)) return;
    if (!extname(pathname) && (await serveStatic("/", response))) return;
  }
  if (request.method !== "POST" || request.url !== "/api/interpret")
    return reply(response, 404, { error: "Not found" });
  try {
    const { message, previous = {} } = await bodyJson(request);
    if (
      typeof message !== "string" ||
      !message.trim() ||
      message.length > 1_000
    )
      return reply(response, 400, { error: "Enter a short trade request." });
    if (requestsPositionLifecycle(message))
      return reply(response, 400, {
        error:
          "Closing or cancelling existing positions is not supported here. Use Soleil Portfolio for lifecycle actions.",
      });
    let intent;
    let model = "local-parser";
    let modelError;
    if (apiKey) {
      try {
        intent = await geminiInterpret(message, previous);
        model = "gemini";
      } catch (error) {
        modelError =
          error instanceof Error ? error.message : "Gemini unavailable";
      }
    }
    if (!intent) intent = parseLocally(message, previous);
    return reply(response, 200, {
      intent,
      missing: missingFields(intent),
      model,
      ...(modelError ? { modelError } : {}),
    });
  } catch (error) {
    return reply(response, 400, {
      error:
        error instanceof Error ? error.message : "Unable to interpret request",
    });
  }
}).listen(port, process.env.HOST || "127.0.0.1", () =>
  console.log(`Soleil Control Room ready on port ${port}`),
);
watchMakerGateway();

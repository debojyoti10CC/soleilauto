import { useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  useNodesState,
  type Node,
  type NodeProps,
  type Edge,
} from "@xyflow/react";
import {
  ArrowRight,
  AudioLines,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ExternalLink,
  Grip,
  Mic,
  RotateCcw,
  Search,
  Send,
  Volume2,
  VolumeX,
  Wallet,
  X,
} from "lucide-react";
import "@xyflow/react/dist/style.css";
import MirrorLab from "./MirrorLab";
import { fetchMakerQuotes } from "./quotes";
import {
  accountExists,
  fetchOnchainPositions,
  fetchSolMarket,
  getExplorerTransactionUrl,
  getSolBalance,
  shortAddress,
  submitSolanaTransaction,
} from "./solana";
import {
  buildOpenPositionInstruction,
  deriveMarketPda,
  derivePositionPda,
  getSettlementProgramId,
} from "./settlement";
import { rankOrders, type OrderChoice, type OrderIntent } from "./order";

type Message = { role: "agent" | "user"; text: string };
type AgentResult = {
  intent: OrderIntent;
  missing: string[];
  model: "gemini" | "local-parser";
  modelError?: string;
};
type SpeechEvent = { results: ArrayLike<ArrayLike<{ transcript: string }>> };
type Recognition = {
  lang: string;
  interimResults: boolean;
  onresult: ((event: SpeechEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};
type StepId =
  "intent" | "market" | "risk" | "quotes" | "approval" | "execution" | "proof";
type StepStatus = "idle" | "working" | "passed" | "blocked" | "ready";
type TraceEvent = {
  id: string;
  step: StepId;
  status: StepStatus;
  detail: string;
  at: number;
};
type Capability = {
  model: "gemini" | "local-parser";
  voice: "elevenlabs" | "browser";
  evidence: "snowflake" | "local";
  maker?: "live" | "offline" | "unconfigured";
};
type StageData = Record<string, unknown> & {
  label: string;
  index: string;
  blurb: string;
  status: StepStatus;
  collapsed: boolean;
  onToggle: () => void;
};
type StageNode = Node<StageData, "stage">;
const steps: Array<{
  id: StepId;
  label: string;
  blurb: string;
  x: number;
  y: number;
}> = [
  {
    id: "intent",
    label: "Intent",
    blurb: "Voice → structured order",
    x: 25,
    y: 175,
  },
  {
    id: "market",
    label: "Market scout",
    blurb: "Fresh SOL reference",
    x: 260,
    y: 55,
  },
  {
    id: "risk",
    label: "Risk policy",
    blurb: "Size, budget, expiry",
    x: 260,
    y: 295,
  },
  {
    id: "quotes",
    label: "Quote router",
    blurb: "Compare live makers",
    x: 495,
    y: 175,
  },
  {
    id: "approval",
    label: "Human gate",
    blurb: "Review and wallet sign",
    x: 730,
    y: 55,
  },
  {
    id: "execution",
    label: "Solana executor",
    blurb: "Recheck and submit",
    x: 730,
    y: 295,
  },
  { id: "proof", label: "Proof", blurb: "Devnet receipt", x: 965, y: 175 },
];
const connections: Array<[StepId, StepId]> = [
  ["intent", "market"],
  ["intent", "risk"],
  ["market", "quotes"],
  ["risk", "quotes"],
  ["quotes", "approval"],
  ["approval", "execution"],
  ["execution", "proof"],
];
function StageCard({ data, selected }: NodeProps<StageNode>) {
  return (
    <div className={`flow-node ${data.status} ${selected ? "selected" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <div className="node-top">
        <span className="node-index">{data.index}</span>
        <span className={`node-status ${data.status}`}>
          {data.status === "passed"
            ? "DONE"
            : data.status === "working"
              ? "RUNNING"
              : data.status === "blocked"
                ? "BLOCKED"
                : data.status === "ready"
                  ? "READY"
                  : "WAITING"}
        </span>
      </div>
      <div className="node-body">
        <strong>{data.label}</strong>
        <button
          className="node-collapse nodrag"
          onClick={(event) => {
            event.stopPropagation();
            data.onToggle();
          }}
          aria-label={`${data.collapsed ? "Expand" : "Collapse"} ${data.label}`}
        >
          {data.collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </div>
      {!data.collapsed && <p>{data.blurb}</p>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { stage: StageCard };

const promptExamples = [
  "Protect 0.1 SOL for next week",
  "Buy a 7-day SOL call, size 0.1 SOL",
  "Buy a put below $110 for 14 days, 0.1 SOL",
];
const usd = (value: number) => `$${value.toFixed(2)}`;
const sol = (lamports: number) =>
  `${(lamports / 1_000_000_000).toFixed(5)} SOL`;

async function freshSpot(): Promise<number | null> {
  const market = await fetchSolMarket();
  if (market?.price && market.price > 0) return market.price;
  try {
    const response = await fetch("/api/spot", {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { price?: number };
    return typeof payload.price === "number" &&
      Number.isFinite(payload.price) &&
      payload.price > 0
      ? payload.price
      : null;
  } catch {
    return null;
  }
}

function App() {
  const {
    publicKey,
    connected,
    connecting,
    connect,
    disconnect,
    sendTransaction,
  } = useWallet();
  const { setVisible: showWalletModal } = useWalletModal();
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "agent",
      text: "Tell me what you want to do with SOL. I will find an executable option and show every detail before your wallet signs.",
    },
  ]);
  const [input, setInput] = useState("");
  const [intent, setIntent] = useState<OrderIntent>({});
  const [draft, setDraft] = useState<OrderIntent>({ side: "buy", kind: "put", quantitySol: 0.1, expiryDays: 7 });
  const [view, setView] = useState<"mirror" | "desk">("mirror");
  const [choice, setChoice] = useState<OrderChoice | null>(null);
  const [alternatives, setAlternatives] = useState<OrderChoice[]>([]);
  const [spot, setSpot] = useState<number | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [stage, setStage] = useState<
    "ready" | "thinking" | "quotes" | "review" | "signing" | "done"
  >("ready");
  const [model, setModel] = useState<"gemini" | "local-parser" | "offline">(
    "offline",
  );
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState("");
  const [preflight, setPreflight] = useState<string>("");
  const [now, setNow] = useState(Date.now());
  const [listening, setListening] = useState(false);
  const [voiceReplies, setVoiceReplies] = useState(false);
  const [capabilities, setCapabilities] = useState<Capability>({
    model: "local-parser",
    voice: "browser",
    evidence: "local",
  });
  const [voiceLive, setVoiceLive] = useState(false);
  const [evidenceLive, setEvidenceLive] = useState(false);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [selectedStep, setSelectedStep] = useState<StepId>("intent");
  const [tapeOpen, setTapeOpen] = useState(true);
  const [evidence, setEvidence] = useState<
    Array<{ TITLE?: string; CONTENT?: string; SOURCE_URL?: string }>
  >([]);
  const [evidenceQuery, setEvidenceQuery] = useState("SOL options protection");
  const [evidenceBusy, setEvidenceBusy] = useState(false);
  const [scenarioSpot, setScenarioSpot] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [mobileCanvasOpen, setMobileCanvasOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(
    () => window.matchMedia("(max-width: 900px)").matches,
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<StageNode>(
    steps.map((step, index) => ({
      id: step.id,
      type: "stage",
      position: { x: step.x, y: step.y },
      data: {
        label: step.label,
        index: String(index + 1).padStart(2, "0"),
        blurb: step.blurb,
        status: step.id === "intent" ? "ready" : "idle",
        collapsed: false,
        onToggle: () => undefined,
      },
    })),
  );
  const recognition = useRef<Recognition | null>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  const busy =
    stage === "thinking" || stage === "quotes" || stage === "signing";
  const quoteValid = Boolean(
    choice && choice.terms.expiresAt > now / 1000 + 15,
  );

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages]);
  useEffect(() => {
    const health = () => fetch("/api/health")
      .then((r) => r.json())
      .then((data: Capability) => {
        setModel(data.model);
        setCapabilities(data);
      })
      .catch(() => setModel("offline"));
    void health();
    const poll = window.setInterval(() => void health(), 15_000);
    freshSpot()
      .then((price) => {
        if (price) setSpot(price);
      })
      .catch(() => undefined);
    return () => window.clearInterval(poll);
  }, []);
  useEffect(() => {
    if (!publicKey) {
      setBalance(null);
      return;
    }
    getSolBalance(publicKey.toBase58())
      .then(setBalance)
      .catch(() => setBalance(null));
  }, [publicKey]);
  useEffect(() => () => recognition.current?.stop(), []);
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 900px)");
    const update = () => setIsMobile(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const walletLabel = useMemo(
    () => (publicKey ? shortAddress(publicKey.toBase58()) : "Connect wallet"),
    [publicKey],
  );
  const statuses = useMemo(
    () =>
      Object.fromEntries(
        steps.map((step) => [
          step.id,
          [...events].reverse().find((event) => event.step === step.id)
            ?.status || (step.id === "intent" ? "ready" : "idle"),
        ]),
      ) as Record<StepId, StepStatus>,
    [events],
  );
  const edges = useMemo<Edge[]>(
    () =>
      connections.map(([source, target]) => ({
        id: `${source}-${target}`,
        source,
        target,
        type: "smoothstep",
        animated:
          statuses[source] === "working" || statuses[target] === "working",
        style: {
          stroke: statuses[source] === "passed" ? "#e2a9f1" : "#505458",
          strokeWidth: statuses[source] === "passed" ? 2 : 1.2,
        },
      })),
    [statuses],
  );
  useEffect(() => {
    setNodes((current) =>
      current.map((node) => ({
        ...node,
        data: {
          ...node.data,
          status: statuses[node.id as StepId],
          collapsed: Boolean(collapsed[node.id]),
          onToggle: () =>
            setCollapsed((old) => ({ ...old, [node.id]: !old[node.id] })),
        },
      })),
    );
  }, [statuses, collapsed, setNodes]);
  function trace(step: StepId, status: StepStatus, detail: string) {
    setEvents((current) => [
      ...current,
      { id: crypto.randomUUID(), step, status, detail, at: Date.now() },
    ]);
  }

  async function handleConnect() {
    if (connected) {
      await disconnect();
      return;
    }
    if (connecting) return;
    try {
      await connect();
    } catch {
      showWalletModal(true);
    }
  }

  function say(text: string) {
    setMessages((current) => [...current, { role: "agent", text }]);
    if (!voiceReplies) return;
    if (capabilities.voice === "elevenlabs") {
      void fetch("/api/speak", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: text.slice(0, 400) }),
      })
        .then((r) => {
          if (!r.ok) throw new Error("Voice unavailable");
          return r.blob();
        })
        .then((blob) => {
          setVoiceLive(true);
          const url = URL.createObjectURL(blob);
          const sound = new Audio(url);
          sound.onended = () => URL.revokeObjectURL(url);
          void sound.play();
        })
        .catch(() => {
          setVoiceLive(false);
          speakBrowser(text);
        });
    } else speakBrowser(text);
  }
  function speakBrowser(text: string) {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const spoken = new SpeechSynthesisUtterance(text);
    spoken.rate = 1.03;
    window.speechSynthesis.speak(spoken);
  }

  async function send(raw = input) {
    const message = raw.trim();
    if (!message || busy) return;
    setInput("");
    setError("");
    setChoice(null);
    setAlternatives([]);
    setReceipt("");
    setMessages((current) => [...current, { role: "user", text: message }]);
    setEvents([]);
    trace("intent", "working", `Received: ${message}`);
    setStage("thinking");
    try {
      const response = await fetch("/api/interpret", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, previous: intent }),
      });
      const result = (await response.json()) as AgentResult & {
        error?: string;
      };
      if (!response.ok) throw new Error(result.error || "Agent unavailable");
      setModel(result.model);
      setIntent(result.intent);
      trace(
        "intent",
        result.missing.length ? "blocked" : "passed",
        `${result.model === "gemini" ? "Gemini" : "Local parser"} extracted ${result.intent.side || "?"} ${result.intent.kind || "?"} · ${result.intent.quantitySol || "?"} SOL · ${result.intent.expiryDays || "?"} days${result.modelError ? `; Gemini fallback: ${result.modelError}` : ""}`,
      );
      if (result.missing.length) {
        say(
          `I need ${result.missing.join(" and ")}. Tell me that, then I can check live maker quotes.`,
        );
        setStage("ready");
        return;
      }
      if ((result.intent.quantitySol ?? 0) < 0.1) {
        trace("risk", "blocked", "Minimum size is 0.1 SOL");
        say(
          "Soleil currently needs at least 0.1 SOL per order. What size of 0.1 SOL or more should I check?",
        );
        setStage("ready");
        return;
      }
      say(
        `I understood: ${result.intent.side} ${result.intent.quantitySol} SOL ${result.intent.kind}, ${result.intent.expiryDays} days${result.intent.maxPremiumSol ? `, spend at most ${result.intent.maxPremiumSol} SOL` : ""}${result.intent.maxPremiumUsd ? `, spend at most $${result.intent.maxPremiumUsd}` : ""}. Checking live quotes now.`,
      );
      trace("market", "working", "Fetching fresh SOL/USD spot");
      trace("risk", "working", "Checking size, expiry and premium limits");
      setStage("quotes");
      await findChoice(result.intent);
    } catch (cause) {
      const reason =
        cause instanceof Error ? cause.message : "Agent unavailable";
      setError(reason);
      trace("intent", "blocked", reason);
      say(`I could not prepare an order: ${reason}`);
      setStage("ready");
    }
  }

  async function findChoice(nextIntent: OrderIntent) {
    const price = await freshSpot();
    if (!price) {
      trace("market", "blocked", "Fresh SOL spot unavailable");
      throw new Error("Fresh SOL spot price unavailable. No order prepared.");
    }
    setSpot(price);
    trace("market", "passed", `SOL spot ${usd(price)} · live external feed`);
    trace(
      "quotes",
      "working",
      `Requesting ${nextIntent.expiryDays}-day maker quotes`,
    );
    const rows = await fetchMakerQuotes(price, nextIntent.expiryDays!);
    if (!rows) {
      trace("quotes", "blocked", "Maker gateway unavailable");
      throw new Error(
        "Maker quotes unavailable. Start or deploy Soleil maker gateway and retry.",
      );
    }
    const ranked = rankOrders(nextIntent, rows, price);
    const picked = ranked[0];
    if (!picked) {
      trace("risk", "blocked", "No quote passes size, expiry and budget rules");
      trace(
        "quotes",
        "blocked",
        `Received ${rows.length} rows, zero executable matches`,
      );
      throw new Error(
        "No executable quote meets size, expiry, and budget. Try 0.1 SOL or a different limit.",
      );
    }
    trace(
      "risk",
      "passed",
      `Size ${nextIntent.quantitySol} SOL and stated caps checked against ${ranked.length} executable quotes`,
    );
    trace(
      "quotes",
      "passed",
      `Ranked ${ranked.length} executable quotes; best ${picked.kind} $${picked.series.strike}, ${sol(picked.premiumLamports)} premium`,
    );
    trace("approval", "ready", "Review the ticket; wallet signature required");
    setAlternatives(ranked.slice(0, 3));
    setChoice(picked);
    setStage("review");
    say(
      `Compared ${ranked.length} executable ${picked.kind} quotes. ${usd(picked.series.strike)} is closest to your target. Review the ticket or choose another strike; I will not place it until you sign.`,
    );
  }

  async function runDraft(nextIntent: OrderIntent = draft) {
    if (busy) return;
    if (!nextIntent.kind || !nextIntent.side || !nextIntent.expiryDays || !nextIntent.quantitySol || nextIntent.quantitySol < 0.1) {
      setError("Choose a side, option, 7/10/14 day expiry, and at least 0.1 SOL.");
      return;
    }
    setError("");
    setReceipt("");
    setChoice(null);
    setAlternatives([]);
    setPreflight("");
    setIntent(nextIntent);
    setEvents([]);
    trace("intent", "passed", `Mirror mission: ${nextIntent.side} ${nextIntent.quantitySol} SOL ${nextIntent.kind} · ${nextIntent.expiryDays} days`);
    trace("market", "working", "Fetching fresh SOL spot");
    trace("risk", "working", "Checking size and limits");
    setStage("quotes");
    try {
      await findChoice(nextIntent);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : "Order preparation failed";
      setError(reason);
      trace("quotes", "blocked", reason);
      setStage("ready");
    }
  }

  async function refreshSpotNode() {
    trace("market", "working", "Refreshing SOL/USD reference");
    const price = await freshSpot();
    if (!price) {
      trace("market", "blocked", "Fresh spot feed unavailable");
      setError("Fresh SOL spot unavailable.");
      return;
    }
    setSpot(price);
    trace("market", "passed", `Fresh SOL/USD ${usd(price)}`);
    if (choice) trace("quotes", "ready", "Spot changed; refresh maker quotes before signing");
  }

  async function inspectExecution() {
    if (!choice) return;
    trace("execution", "working", "Checking devnet market and quote accounts");
    try {
      const programId = getSettlementProgramId();
      if (!programId) throw new Error("Soleil devnet program ID is missing.");
      const market = deriveMarketPda(programId, choice.series.strike, choice.series.expiryAt!, choice.kind);
      const [marketFound, quoteFound] = await Promise.all([
        accountExists(market),
        accountExists(new PublicKey(choice.terms.quoteAddress)),
      ]);
      if (!marketFound) throw new Error("This market is not initialized on devnet.");
      if (!quoteFound) throw new Error("Maker quote account is missing on devnet. Refresh quotes.");
      if (choice.terms.expiresAt <= Date.now() / 1000 + 15) throw new Error("Maker quote expired. Refresh quotes.");
      let detail = `Market ${shortAddress(market.toBase58())} and quote ${shortAddress(choice.terms.quoteAddress)} exist on devnet.`;
      if (publicKey) {
        const [duplicate, funds] = await Promise.all([
          accountExists(derivePositionPda(programId, publicKey, market, choice.series.expiryAt!)),
          getSolBalance(publicKey.toBase58()),
        ]);
        setBalance(funds);
        if (duplicate) throw new Error("This wallet already has a position in this contract.");
        const required = (choice.side === "buy" ? choice.premiumLamports : choice.collateralLamports) / 1_000_000_000 + 0.02;
        if (funds < required) throw new Error(`Wallet needs about ${required.toFixed(3)} devnet SOL.`);
        detail += ` Wallet has ${funds.toFixed(4)} SOL; ${required.toFixed(4)} SOL required including reserve.`;
      } else detail += " Connect a wallet to check funds and duplicate position.";
      setPreflight(detail);
      trace("execution", publicKey ? "passed" : "ready", detail);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : "Devnet check failed";
      setPreflight(reason);
      trace("execution", "blocked", reason);
    }
  }

  async function verifyPosition() {
    if (!publicKey) { showWalletModal(true); return; }
    const programId = getSettlementProgramId();
    if (!programId) { trace("proof", "blocked", "Soleil devnet program ID is missing"); return; }
    trace("proof", "working", "Reading this wallet's positions from Solana devnet");
    try {
      const positions = await fetchOnchainPositions(programId, publicKey);
      const match = choice && positions.find((position) => position.marketAddress === deriveMarketPda(programId, choice.series.strike, choice.series.expiryAt!, choice.kind).toBase58());
      trace("proof", match ? "passed" : "ready", match
        ? `${match.status} position ${shortAddress(match.positionAddress)} · ${match.quantity} SOL · ${match.kind.toUpperCase()} $${match.strike}`
        : `Read ${positions.length} devnet position${positions.length === 1 ? "" : "s"}; no position for this selected contract yet.`);
    } catch (cause) {
      trace("proof", "blocked", cause instanceof Error ? cause.message : "Position read failed");
    }
  }

  async function refreshQuote() {
    if (busy || !intent.kind) return;
    setError("");
    setStage("quotes");
    trace("quotes", "working", "Refreshing maker quotes");
    try {
      await findChoice(intent);
    } catch (cause) {
      setChoice(null);
      setAlternatives([]);
      setError(cause instanceof Error ? cause.message : "Quote refresh failed");
      setStage("ready");
    }
  }

  async function submit() {
    if (!choice || !publicKey || !connected || busy) {
      showWalletModal(true);
      return;
    }
    setError("");
    setStage("signing");
    trace(
      "approval",
      "working",
      `Wallet ${shortAddress(publicKey.toBase58())} preparing to sign`,
    );
    trace("execution", "working", "Revalidating quote, market and balance");
    try {
      const programId = getSettlementProgramId();
      if (!programId) throw new Error("Soleil devnet program ID is missing.");
      const now = Date.now() / 1000;
      if (choice.terms.expiresAt <= now + 15)
        throw new Error("Quote expired. Refresh and review a new quote.");
      const fresh = await fetchMakerQuotes(spot || 0, choice.series.expiryDays);
      const current = fresh?.find(
        (row) =>
          row.strike === choice.series.strike &&
          row.expiryAt === choice.series.expiryAt,
      );
      const currentQuote =
        choice.side === "buy"
          ? current?.[choice.kind].askQuote
          : current?.[choice.kind].bidQuote;
      const currentPrice =
        choice.side === "buy"
          ? current?.[choice.kind].ask
          : current?.[choice.kind].bid;
      if (
        !currentQuote ||
        currentQuote.quoteAddress !== choice.terms.quoteAddress ||
        currentQuote.maker !== choice.terms.maker ||
        currentQuote.nonce !== choice.terms.nonce ||
        currentQuote.premiumLamportsPerSol !==
          choice.terms.premiumLamportsPerSol ||
        currentQuote.collateralLamportsPerSol !==
          choice.terms.collateralLamportsPerSol ||
        currentQuote.expiresAt !== choice.terms.expiresAt ||
        currentPrice !== choice.priceUsd ||
        currentQuote.remainingSize < choice.quantitySol ||
        currentQuote.expiresAt <= Date.now() / 1000 + 15
      )
        throw new Error("Quote changed. Refresh and review before signing.");
      if (intent.maxPremiumUsd) {
        const latestSpot = await freshSpot();
        if (!latestSpot)
          throw new Error(
            "Cannot verify your USD spending cap without a fresh SOL price.",
          );
        if (
          (choice.premiumLamports / 1_000_000_000) * latestSpot >
          intent.maxPremiumUsd
        )
          throw new Error(
            "Premium now exceeds your USD spending cap. Review a different quote.",
          );
      }
      const market = deriveMarketPda(
        programId,
        choice.series.strike,
        choice.series.expiryAt!,
        choice.kind,
      );
      if (!(await accountExists(market)))
        throw new Error("Maker market is not initialized on devnet.");
      if (
        await accountExists(
          derivePositionPda(
            programId,
            publicKey,
            market,
            choice.series.expiryAt!,
          ),
        )
      )
        throw new Error(
          "This wallet already has a position in this contract. Choose another strike or expiry.",
        );
      const required =
        (choice.side === "buy"
          ? choice.premiumLamports
          : choice.collateralLamports) /
          1_000_000_000 +
        0.02;
      const walletBalance = await getSolBalance(publicKey.toBase58());
      setBalance(walletBalance);
      if (walletBalance < required)
        throw new Error(
          `Wallet needs about ${required.toFixed(3)} devnet SOL, including transaction reserve.`,
        );
      const instruction = buildOpenPositionInstruction({
        programId,
        owner: new PublicKey(publicKey),
        kind: choice.kind,
        side: choice.side,
        strike: choice.series.strike,
        quantity: choice.quantitySol,
        premium: choice.priceUsd,
        maker: new PublicKey(choice.terms.maker),
        quoteNonce: choice.terms.nonce,
        quoteAddress: choice.terms.quoteAddress,
        expiryAt: choice.series.expiryAt!,
        premiumLamports: choice.premiumLamports,
        collateralLamports: choice.collateralLamports,
      });
      trace(
        "approval",
        "passed",
        "Order checks passed; wallet signature requested",
      );
      const signature = await submitSolanaTransaction(
        [instruction],
        sendTransaction,
        publicKey.toBase58(),
      );
      setReceipt(signature);
      setStage("done");
      trace(
        "execution",
        "passed",
        `Solana devnet transaction confirmed: ${signature}`,
      );
      trace(
        "proof",
        "passed",
        `Explorer receipt: ${getExplorerTransactionUrl(signature)}`,
      );
      say(
        `Position confirmed on Solana devnet. Receipt: ${signature.slice(0, 8)}…${signature.slice(-6)}. Open the explorer link for proof.`,
      );
      getSolBalance(publicKey.toBase58())
        .then(setBalance)
        .catch(() => undefined);
    } catch (cause) {
      const reason =
        cause instanceof Error ? cause.message : "Wallet transaction failed";
      setError(reason);
      trace("execution", "blocked", reason);
      setStage("review");
    }
  }

  function startVoice() {
    if (listening) {
      recognition.current?.stop();
      return;
    }
    const browser = window as unknown as {
      SpeechRecognition?: new () => Recognition;
      webkitSpeechRecognition?: new () => Recognition;
    };
    const SpeechRecognition =
      browser.SpeechRecognition || browser.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setError(
        "Voice input is unavailable in this browser. Type your order instead.",
      );
      return;
    }
    const session = new SpeechRecognition();
    session.lang = "en-US";
    session.interimResults = false;
    session.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript;
      if (transcript) {
        setInput(transcript);
        void send(transcript);
      }
    };
    session.onerror = () => {
      setListening(false);
      setError("Microphone unavailable. Type your order instead.");
    };
    session.onend = () => setListening(false);
    recognition.current = session;
    try {
      session.start();
      setListening(true);
      setError("");
    } catch {
      setError("Could not start microphone. Type your order instead.");
    }
  }

  function reset() {
    setMessages([
      {
        role: "agent",
        text: "New order. Tell me your SOL goal, size, and duration.",
      },
    ]);
    setIntent({});
    setChoice(null);
    setAlternatives([]);
    setReceipt("");
    setError("");
    setStage("ready");
    setEvents([]);
    setSelectedStep("intent");
  }

  async function searchEvidence() {
    if (capabilities.evidence !== "snowflake" || !evidenceQuery.trim()) return;
    setEvidenceBusy(true);
    try {
      const response = await fetch("/api/evidence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: evidenceQuery.trim() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Search failed");
      setEvidence(data.results || []);
      setEvidenceLive(true);
      trace(
        "proof",
        "passed",
        `Snowflake returned ${(data.results || []).length} evidence matches`,
      );
    } catch (cause) {
      setEvidenceLive(false);
      trace(
        "proof",
        "blocked",
        cause instanceof Error ? cause.message : "Snowflake search failed",
      );
    } finally {
      setEvidenceBusy(false);
    }
  }

  const activeStep = steps.find((step) => step.id === selectedStep)!;
  const stepEvents = events
    .filter((event) => event.step === selectedStep)
    .slice()
    .reverse();
  const scenario = scenarioSpot ?? spot ?? choice?.series.strike ?? 0;
  const scenarioPayoff = choice
    ? Math.max(
        0,
        choice.kind === "put"
          ? choice.series.strike - scenario
          : scenario - choice.series.strike,
      ) * choice.quantitySol
    : 0;
  const scenarioPnl = choice
    ? choice.side === "buy"
      ? scenarioPayoff - choice.priceUsd * choice.quantitySol
      : choice.priceUsd * choice.quantitySol - scenarioPayoff
    : 0;
  const scenarioMin = Math.max(
    1,
    Math.floor((spot || choice?.series.strike || 100) * 0.6),
  );
  const scenarioMax = Math.ceil((spot || choice?.series.strike || 100) * 1.4);
  if (view === "mirror") return <MirrorLab
    onBack={() => setView("desk")}
    onCommit={(nextIntent) => {
      setDraft(nextIntent);
      setView("desk");
      void runDraft(nextIntent);
    }}
    walletAddress={publicKey?.toBase58()}
    makerStatus={capabilities.maker}
  />;
  return (
    <div className="control-room">
      <header className="cr-header">
        <div className="cr-brand">
          <img src="/soleil-logo.png" alt="" />
          <span>soleil</span>
          <span className="brand-divider" />
          <strong>CONTROL ROOM</strong>
          <button className="mirror-nav" onClick={() => setView("mirror")}>MIRROR LAB <ArrowRight size={13} /></button>
        </div>
        <div className="header-center">
          <span className="live-pulse" /> SOL OPTIONS{" "}
          <span className="header-sep">/</span> MAKER {capabilities.maker === "live" ? "LIVE" : "OFFLINE"}
        </div>
        <div className="header-actions">
          <span className="network-badge">
            <span className="network-dot" /> DEVNET
          </span>
          <button className="wallet-action" onClick={handleConnect}>
            <Wallet size={15} />
            {walletLabel}
            <ChevronDown size={14} />
          </button>
        </div>
      </header>

      <div className="cr-topline">
        <div><h1>Trade <em>desk.</em></h1></div>
        <div className="mission-stats">
          <div>
            <small>SOL / USD</small>
            <strong>{spot ? usd(spot) : "—"}</strong>
            <span>live reference</span>
          </div>
          <div>
            <small>PIPELINE</small>
            <strong>
              {stage === "done"
                ? "CONFIRMED"
                : stage === "review"
                  ? "REVIEW"
                  : busy
                    ? "RUNNING"
                    : "STANDBY"}
            </strong>
            <span>{events.length} recorded events</span>
          </div>
        </div>
      </div>

      <main className="cr-grid">
        <aside className="cr-left">
          <div className="panel-heading">
            <span className="section-code">02 / COMMAND</span>
            <button
              className="text-icon"
              onClick={reset}
              title="New run"
              aria-label="New run"
            >
              <RotateCcw size={15} />
            </button>
          </div>
          <h2>Tell Soleil what to do.</h2>
          <p className="panel-lede">
            Voice or text. Every trade stops at your wallet.
          </p>
          <div className="capability-stack">
            <div>
              <span className={`tiny-led ${model === "gemini" ? "on" : ""}`} />
              INTENT ENGINE
              <strong>
                {model === "gemini"
                  ? "GEMINI LIVE"
                  : model === "offline"
                    ? "OFFLINE"
                    : capabilities.model === "gemini"
                      ? "GEMINI READY"
                      : "LOCAL PARSER"}
              </strong>
            </div>
            <div>
              <span className={`tiny-led ${voiceLive ? "on" : ""}`} />
              VOICE OUT
              <strong>
                {voiceLive
                  ? "ELEVENLABS LIVE"
                  : capabilities.voice === "elevenlabs"
                    ? "ELEVENLABS READY"
                    : "BROWSER"}
              </strong>
            </div>
            <div>
              <span className={`tiny-led ${evidenceLive ? "on" : ""}`} />
              EVIDENCE
              <strong>
                {evidenceLive
                  ? "SNOWFLAKE LIVE"
                  : capabilities.evidence === "snowflake"
                    ? "SNOWFLAKE READY"
                    : "LOCAL TRACE"}
              </strong>
            </div>
          </div>
          <div className="conversation-list" aria-label="Conversation">
            {messages.map((entry, index) => (
              <div
                className={`cr-message ${entry.role}`}
                key={`${index}-${entry.role}`}
              >
                <small>{entry.role === "agent" ? "SOLEIL" : "YOU"}</small>
                <p>{entry.text}</p>
              </div>
            ))}
            {busy && stage !== "signing" && (
              <div className="cr-message agent">
                <small>SOLEIL</small>
                <p>
                  {stage === "quotes"
                    ? "Routing live maker quotes…"
                    : "Interpreting intent…"}
                </p>
              </div>
            )}
            <div ref={chatEnd} />
          </div>
          {messages.length === 1 && (
            <div className="prompt-list">
              {promptExamples.map((example) => (
                <button key={example} onClick={() => send(example)}>
                  {example}
                  <ArrowRight size={13} />
                </button>
              ))}
            </div>
          )}
          <form
            className="command-box"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <input
              aria-label="Trade request"
              placeholder={listening ? "Listening…" : "Describe your SOL trade"}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              disabled={busy}
            />
            <div className="command-actions">
              <button
                type="button"
                onClick={startVoice}
                className={listening ? "is-listening" : ""}
                title="Speak order"
                aria-label="Speak order"
              >
                <Mic size={17} />
              </button>
              <button
                type="button"
                onClick={() => {
                  setVoiceReplies((v) => !v);
                  window.speechSynthesis?.cancel();
                }}
                title={voiceReplies ? "Mute replies" : "Enable voice replies"}
                aria-label={
                  voiceReplies ? "Mute replies" : "Enable voice replies"
                }
              >
                {voiceReplies ? <Volume2 size={17} /> : <VolumeX size={17} />}
              </button>
              <button
                type="submit"
                className="command-send"
                disabled={!input.trim() || busy}
              >
                RUN <ArrowRight size={15} />
              </button>
            </div>
          </form>
          {error && (
            <div className="cr-error" role="alert">
              <X size={15} />
              {error}
            </div>
          )}
          <div className="left-foot">
            No model can sign. No order is placed before wallet approval.
          </div>
        </aside>

        <section className="cr-center" aria-label="Interactive agent workflow">
          <div className="canvas-heading">
            <div>
              <span className="section-code">03 / LIVE ORCHESTRATION</span>
              <h2>Execution graph</h2>
            </div>
            <div className="canvas-note">
              <Grip size={13} /> DRAG NODES · SCROLL TO ZOOM · SELECT TO INSPECT
            </div>
          </div>
          {isMobile && (
            <div className="mobile-stages">
              {steps.map((step, index) => (
                <button
                  key={step.id}
                  className={`${statuses[step.id]} ${selectedStep === step.id ? "selected" : ""}`}
                  onClick={() => setSelectedStep(step.id)}
                >
                  <small>
                    {String(index + 1).padStart(2, "0")} /{" "}
                    {statuses[step.id].toUpperCase()}
                  </small>
                  <strong>{step.label}</strong>
                  <span>{step.blurb}</span>
                </button>
              ))}
            </div>
          )}
          {isMobile && (
            <button
              className="mobile-canvas-toggle"
              onClick={() => setMobileCanvasOpen((open) => !open)}
            >
              {mobileCanvasOpen
                ? "Hide draggable graph"
                : "Open draggable graph"}{" "}
              {mobileCanvasOpen ? (
                <ChevronUp size={14} />
              ) : (
                <ChevronDown size={14} />
              )}
            </button>
          )}
          {(!isMobile || mobileCanvasOpen) && (
            <div className="flow-wrap">
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onNodeClick={(_, node) => setSelectedStep(node.id as StepId)}
                onInit={(instance) => {
                  requestAnimationFrame(() =>
                    requestAnimationFrame(() => {
                      void instance.fitView({
                        padding: 0.12,
                        minZoom: 0.18,
                        maxZoom: 1,
                      });
                    }),
                  );
                }}
                nodeTypes={nodeTypes}
                fitView
                fitViewOptions={{ padding: 0.12 }}
                minZoom={0.18}
                maxZoom={1.4}
                nodesConnectable={false}
                elementsSelectable
                proOptions={{ hideAttribution: true }}
              >
                <Background color="#272b2d" gap={22} size={1} />
                <Controls showInteractive={false} />
              </ReactFlow>
              <div className="canvas-corner">
                <span className="live-pulse" /> ACTUAL EXECUTION PATH
              </div>
            </div>
          )}
          <div className="inspector">
            <div className="inspector-id">
              <span className="section-code">NODE INSPECTOR</span>
              <strong>{activeStep.label}</strong>
              <span className={`inspector-status ${statuses[selectedStep]}`}>
                {statuses[selectedStep]}
              </span>
            </div>
            <div className="inspector-tool">
              {selectedStep === "intent" && <>
                <div className="tool-fields">
                  <label>Side<select value={draft.side} onChange={(event) => setDraft({ ...draft, side: event.target.value as "buy" | "sell" })}><option value="buy">Buy</option><option value="sell">Sell</option></select></label>
                  <label>Option<select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as "put" | "call" })}><option value="put">Put</option><option value="call">Call</option></select></label>
                  <label>Size SOL<input type="number" min="0.1" step="0.1" value={draft.quantitySol ?? 0.1} onChange={(event) => setDraft({ ...draft, quantitySol: Number(event.target.value) })} /></label>
                  <label>Days<select value={draft.expiryDays} onChange={(event) => setDraft({ ...draft, expiryDays: Number(event.target.value) })}><option value={7}>7</option><option value={10}>10</option><option value={14}>14</option></select></label>
                  <label>Target $<input type="number" min="1" placeholder="Auto" value={draft.targetStrikeUsd ?? ""} onChange={(event) => setDraft({ ...draft, targetStrikeUsd: event.target.value ? Number(event.target.value) : undefined })} /></label>
                </div>
                <button className="tool-action" onClick={() => void runDraft()} disabled={busy}>Route this devnet trade <ArrowRight size={14} /></button>
              </>}
              {selectedStep === "market" && <><p>Current SOL/USD reference: <strong>{spot ? usd(spot) : "unavailable"}</strong>. A fresh price is fetched again during routing.</p><button className="tool-action" onClick={() => void refreshSpotNode()}>Refresh live spot <RotateCcw size={14} /></button></>}
              {selectedStep === "risk" && <><p>{choice ? `${choice.quantitySol} SOL ${choice.kind.toUpperCase()} · ${choice.side === "buy" ? `maximum option loss ${sol(choice.premiumLamports)}` : `collateral ${sol(choice.collateralLamports)}`}. Try an expiry price in the ticket to inspect the payoff.` : "Run a mission to check minimum size, budget, quote capacity and payoff."}</p><button className="tool-action" onClick={() => setSelectedStep("intent")}>Edit risk inputs <ArrowRight size={14} /></button></>}
              {selectedStep === "quotes" && <><p>{alternatives.length ? `${alternatives.length} executable choices for the current goal. Select a strike here or in the ticket.` : "Route an intent to fetch live maker quotes."}</p><div className="tool-choices">{alternatives.map((item) => <button key={`${item.series.expiryAt}-${item.series.strike}`} className={choice?.series.strike === item.series.strike ? "selected" : ""} disabled={busy} onClick={() => { setChoice(item); setPreflight(""); trace("quotes", "passed", `Routed to $${item.series.strike} ${item.kind} · ${sol(item.premiumLamports)}`); }}>${item.series.strike} · {sol(item.premiumLamports)}</button>)}</div><button className="tool-action" onClick={() => void refreshQuote()} disabled={busy || !intent.kind}>Refresh live quotes <RotateCcw size={14} /></button></>}
              {selectedStep === "approval" && <><p>{publicKey ? `Wallet ${shortAddress(publicKey.toBase58())} connected. Review the ticket before signing.` : "Connect your devnet wallet. The agent cannot sign for you."}</p><button className="tool-action" onClick={() => publicKey ? void submit() : void handleConnect()} disabled={busy || !choice}>{publicKey ? "Review & sign selected order" : "Connect devnet wallet"} <Wallet size={14} /></button></>}
              {selectedStep === "execution" && <><p>{preflight || "Inspect the selected maker quote, market PDA and wallet readiness on devnet. Submission rechecks everything before signing."}</p><button className="tool-action" onClick={() => void inspectExecution()} disabled={!choice || busy}>Check devnet accounts <Search size={14} /></button></>}
              {selectedStep === "proof" && <><p>{receipt ? `Confirmed signature ${shortAddress(receipt)}. Read the wallet's on-chain position below.` : "No signed trade in this session. After confirmation, verify the position directly from devnet."}</p><button className="tool-action" onClick={() => void verifyPosition()} disabled={!choice || busy}>Verify on-chain position <Search size={14} /></button>{receipt && <a className="tool-proof" href={getExplorerTransactionUrl(receipt)} target="_blank" rel="noreferrer">Open explorer receipt <ExternalLink size={13} /></a>}</>}
            </div>
            <div className="inspector-events">
              {stepEvents.length ? (
                stepEvents.map((event) => (
                  <div key={event.id}>
                    <time>{new Date(event.at).toLocaleTimeString()}</time>
                    <span>{event.detail}</span>
                  </div>
                ))
              ) : (
                <div>
                  <time>—</time>
                  <span>
                    Waiting for a run. Send a trade request to see evidence
                    here.
                  </span>
                </div>
              )}
            </div>
          </div>
          <div className={`execution-tape ${tapeOpen ? "open" : ""}`}>
            <button
              className="tape-heading"
              onClick={() => setTapeOpen((open) => !open)}
            >
              <span>
                <span className="section-code">04 / OBSERVABILITY</span>
                <strong>
                  Execution tape <i>{events.length}</i>
                </strong>
              </span>
              {tapeOpen ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
            </button>
            {tapeOpen && (
              <div className="tape-list">
                {events.length ? (
                  events
                    .slice()
                    .reverse()
                    .map((event) => (
                      <button
                        key={event.id}
                        onClick={() => setSelectedStep(event.step)}
                      >
                        <time>{new Date(event.at).toLocaleTimeString()}</time>
                        <span className={`tape-mark ${event.status}`} />
                        <strong>
                          {steps.find((step) => step.id === event.step)?.label}
                        </strong>
                        <span>{event.detail}</span>
                      </button>
                    ))
                ) : (
                  <div className="tape-empty">
                    No synthetic trades. Live checks will appear here as they
                    happen.
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        <aside className="cr-right">
          <div className="ticket-head">
            <span className="section-code">05 / TRADE TICKET</span>
            <span
              className={`ticket-state ${choice && quoteValid ? "live" : ""}`}
            >
              {stage === "done"
                ? "CONFIRMED"
                : choice
                  ? quoteValid
                    ? "LIVE QUOTE"
                    : "QUOTE EXPIRED"
                  : "AWAITING ORDER"}
            </span>
          </div>
          {choice ? (
            <div className="ticket-content">
              <div className="contract-title">
                <div>
                  <small>
                    {choice.side.toUpperCase()} · {choice.series.expiryDays} DAY
                    EXPIRY
                  </small>
                  <h2>SOL {choice.kind.toUpperCase()}</h2>
                </div>
                <span className="contract-strike">${choice.series.strike}</span>
              </div>
              <div className="ticket-rule" />
              <div className="ticket-pair">
                <span>Expiry</span>
                <strong>{choice.series.expiryLabel}</strong>
              </div>
              <div className="ticket-pair">
                <span>Size</span>
                <strong>{choice.quantitySol} SOL</strong>
              </div>
              <div className="ticket-pair">
                <span>Price / SOL</span>
                <strong>{usd(choice.priceUsd)}</strong>
              </div>
              <div className="ticket-pair">
                <span>
                  {choice.side === "buy"
                    ? "Premium to pay"
                    : "Premium to receive"}
                </span>
                <strong>{sol(choice.premiumLamports)}</strong>
              </div>
              {choice.side === "sell" && (
                <div className="ticket-pair">
                  <span>Collateral locked</span>
                  <strong>{sol(choice.collateralLamports)}</strong>
                </div>
              )}
              <div className="ticket-pair">
                <span>Maker quote expires</span>
                <strong>
                  {new Date(choice.terms.expiresAt * 1000).toLocaleTimeString()}
                </strong>
              </div>
              <div className="ticket-rule" />
              <div className="selection-reason">
                <small>ROUTING DECISION</small>
                <p>
                  {alternatives[0]?.series.strike === choice.series.strike
                    ? intent.targetStrikeUsd
                      ? `Closest executable strike to your $${intent.targetStrikeUsd} target.`
                      : `Closest executable ${choice.kind} strike to SOL spot (${spot ? usd(spot) : "unavailable"}).`
                    : "Alternative strike selected by you."}{" "}
                  Maker size covers this order.
                </p>
              </div>
              <div className="payoff-sandbox">
                <div>
                  <small>AT EXPIRY IF SOL IS</small>
                  <strong>{usd(scenario)}</strong>
                </div>
                <input
                  aria-label="Scenario SOL price at expiry"
                  type="range"
                  min={scenarioMin}
                  max={scenarioMax}
                  step="0.01"
                  value={scenario}
                  onChange={(event) =>
                    setScenarioSpot(Number(event.target.value))
                  }
                />
                <div className="sandbox-result">
                  <span>Illustrative option P&L</span>
                  <strong
                    className={scenarioPnl >= 0 ? "positive" : "negative"}
                  >
                    {scenarioPnl < 0 ? "-" : "+"}$
                    {Math.abs(scenarioPnl).toFixed(2)}
                  </strong>
                </div>
                <p>
                  USD estimate for this size at expiry; excludes fees and any
                  SOL you already hold.
                </p>
              </div>
              {choice.side === "buy" && choice.kind === "put" && (
                <div className="hedge-lens">
                  <div className="hedge-lens-head">
                    <small>DOWNSIDE HEDGE / {choice.quantitySol} SOL HELD</small>
                    <span>At expiry, indicative USD</span>
                  </div>
                  <div className="hedge-presets">
                    <button onClick={() => setScenarioSpot(Math.max(scenarioMin, Math.round((spot || choice.series.strike) * 0.75)))}>SOL drops 25%</button>
                    <button onClick={() => setScenarioSpot(spot || choice.series.strike)}>Flat</button>
                    <button onClick={() => setScenarioSpot(Math.min(scenarioMax, Math.round((spot || choice.series.strike) * 1.25)))}>SOL rises 25%</button>
                  </div>
                  <div className="hedge-bars">
                    <div><span>Holding alone</span><strong>{usd(scenario * choice.quantitySol)}</strong></div>
                    <div><span>Holding + put</span><strong>{usd(scenario * choice.quantitySol + scenarioPayoff - choice.priceUsd * choice.quantitySol)}</strong></div>
                  </div>
                  <p>Below ${choice.series.strike}, the put offsets further SOL price decline at expiry. Premium is included; fees and execution slippage are excluded.</p>
                </div>
              )}
              {alternatives.length > 1 && (
                <div className="quote-options">
                  <small>OTHER EXECUTABLE STRIKES</small>
                  {alternatives.map((item) => (
                    <button
                      key={`${item.series.expiryAt}-${item.series.strike}`}
                      className={
                        item.series.strike === choice.series.strike
                          ? "chosen"
                          : ""
                      }
                      onClick={() => {
                        setChoice(item);
                        trace(
                          "approval",
                          "ready",
                          `Selected $${item.series.strike} ${item.kind} alternative`,
                        );
                      }}
                      disabled={busy}
                    >
                      <span>${item.series.strike}</span>
                      <strong>{sol(item.premiumLamports)}</strong>
                      {item.series.strike === choice.series.strike && (
                        <Check size={13} />
                      )}
                    </button>
                  ))}
                </div>
              )}
              <button
                className="execute-button"
                onClick={
                  !quoteValid
                    ? refreshQuote
                    : connected
                      ? submit
                      : handleConnect
                }
                disabled={busy || stage === "done"}
              >
                {stage === "signing"
                  ? "CONFIRM IN WALLET"
                  : stage === "done"
                    ? "ORDER CONFIRMED"
                    : !quoteValid
                      ? "REFRESH EXPIRED QUOTE"
                      : connected
                        ? "REVIEW & SIGN ORDER"
                        : "CONNECT WALLET TO SIGN"}
                <ArrowRight size={17} />
              </button>
              <button
                className="link-button"
                onClick={refreshQuote}
                disabled={busy}
              >
                Refresh maker quotes
              </button>
              <p className="signature-note">
                Quote and balances are checked again before the wallet prompt.
                Soleil never receives your key.
              </p>
            </div>
          ) : (
            <div className="ticket-empty">
              <div className="ticket-empty-glyph">
                <AudioLines size={25} />
              </div>
              <h2>No order prepared yet.</h2>
              <p>
                Start with a goal on the left. The agents will fill this ticket
                only from executable maker quotes.
              </p>
              <div className="empty-path">
                <span>INTENT</span>
                <ArrowRight size={12} />
                <span>QUOTE</span>
                <ArrowRight size={12} />
                <span>SIGN</span>
              </div>
            </div>
          )}
          {receipt && (
            <a
              className="proof-link"
              href={getExplorerTransactionUrl(receipt)}
              target="_blank"
              rel="noreferrer"
            >
              <Check size={17} />
              <span>
                Confirmed on Solana devnet
                <small>
                  {receipt.slice(0, 12)}…{receipt.slice(-8)}
                </small>
              </span>
              <ExternalLink size={15} />
            </a>
          )}
          <div className="evidence-panel">
            <div>
              <span className="section-code">EVIDENCE SEARCH</span>
              <span className="evidence-source">
                {capabilities.evidence === "snowflake"
                  ? "SNOWFLAKE CORTEX"
                  : "CONNECT SNOWFLAKE TO ENABLE"}
              </span>
            </div>
            {capabilities.evidence === "snowflake" ? (
              <>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void searchEvidence();
                  }}
                >
                  <input
                    value={evidenceQuery}
                    onChange={(event) => setEvidenceQuery(event.target.value)}
                    aria-label="Search evidence"
                  />
                  <button disabled={evidenceBusy}>
                    <Search size={15} />
                  </button>
                </form>
                {evidence.map((item, index) => (
                  <div className="evidence-result" key={index}>
                    {item.SOURCE_URL?.startsWith("https://") ? (
                      <a
                        href={item.SOURCE_URL}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {item.TITLE || "Evidence"} <ExternalLink size={11} />
                      </a>
                    ) : (
                      <strong>{item.TITLE || "Evidence"}</strong>
                    )}
                    <span>{item.CONTENT?.slice(0, 150)}</span>
                  </div>
                ))}
              </>
            ) : (
              <p>
                Run evidence stays local. Configure a Cortex Search service to
                query indexed Soleil docs and run records.
              </p>
            )}
          </div>
          <div className="ticket-foot">
            <span>
              WALLET{" "}
              <strong>{connected ? walletLabel : "NOT CONNECTED"}</strong>
            </span>
            <span>
              BALANCE{" "}
              <strong>
                {balance === null ? "—" : `${balance.toFixed(4)} SOL`}
              </strong>
            </span>
          </div>
        </aside>
      </main>
    </div>
  );
}

export default App;


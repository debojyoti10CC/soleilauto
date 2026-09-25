import { useEffect, useMemo, useRef, useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { PublicKey } from '@solana/web3.js'
import { ArrowRight, AudioLines, Check, ChevronRight, ExternalLink, LockKeyhole, Mic, RotateCcw, Send, ShieldCheck, Sparkles, Volume2, VolumeX, Wallet, X } from 'lucide-react'
import { fetchMakerQuotes } from './quotes'
import { accountExists, fetchSolMarket, getExplorerTransactionUrl, getSolBalance, shortAddress, submitSolanaTransaction } from './solana'
import { buildOpenPositionInstruction, deriveMarketPda, derivePositionPda, getSettlementProgramId } from './settlement'
import { rankOrders, type OrderChoice, type OrderIntent } from './order'

type Message = { role: 'agent' | 'user'; text: string }
type AgentResult = { intent: OrderIntent; missing: string[]; model: 'gemini' | 'local-parser'; modelError?: string }
type SpeechEvent = { results: ArrayLike<ArrayLike<{ transcript: string }>> }
type Recognition = { lang: string; interimResults: boolean; onresult: ((event: SpeechEvent) => void) | null; onerror: (() => void) | null; onend: (() => void) | null; start: () => void; stop: () => void }

const promptExamples = [
  'Protect 0.1 SOL for next week',
  'Buy a 7-day SOL call, size 0.1 SOL',
  'Buy a put below $110 for 14 days, 0.1 SOL',
]
const usd = (value: number) => `$${value.toFixed(2)}`
const sol = (lamports: number) => `${(lamports / 1_000_000_000).toFixed(5)} SOL`

async function freshSpot(): Promise<number | null> {
  const market = await fetchSolMarket()
  if (market?.price && market.price > 0) return market.price
  try {
    const response = await fetch('/api/spot', { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) return null
    const payload = await response.json() as { price?: number }
    return typeof payload.price === 'number' && Number.isFinite(payload.price) && payload.price > 0 ? payload.price : null
  } catch { return null }
}

function App() {
  const { publicKey, connected, connecting, connect, disconnect, sendTransaction } = useWallet()
  const { setVisible: showWalletModal } = useWalletModal()
  const [messages, setMessages] = useState<Message[]>([{ role: 'agent', text: 'Tell me what you want to do with SOL. I will find an executable option and show every detail before your wallet signs.' }])
  const [input, setInput] = useState('')
  const [intent, setIntent] = useState<OrderIntent>({})
  const [choice, setChoice] = useState<OrderChoice | null>(null)
  const [alternatives, setAlternatives] = useState<OrderChoice[]>([])
  const [spot, setSpot] = useState<number | null>(null)
  const [balance, setBalance] = useState<number | null>(null)
  const [stage, setStage] = useState<'ready' | 'thinking' | 'quotes' | 'review' | 'signing' | 'done'>('ready')
  const [model, setModel] = useState<'gemini' | 'local-parser' | 'offline'>('offline')
  const [error, setError] = useState('')
  const [receipt, setReceipt] = useState('')
  const [now, setNow] = useState(Date.now())
  const [listening, setListening] = useState(false)
  const [voiceReplies, setVoiceReplies] = useState(false)
  const recognition = useRef<Recognition | null>(null)
  const chatEnd = useRef<HTMLDivElement>(null)
  const busy = stage === 'thinking' || stage === 'quotes' || stage === 'signing'
  const quoteValid = Boolean(choice && choice.terms.expiresAt > now / 1000 + 15)

  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }) }, [messages])
  useEffect(() => {
    fetch('/api/health').then((r) => r.json()).then((data) => setModel(data.model === 'gemini' ? 'gemini' : 'local-parser')).catch(() => setModel('offline'))
    freshSpot().then((price) => { if (price) setSpot(price) }).catch(() => undefined)
  }, [])
  useEffect(() => {
    if (!publicKey) { setBalance(null); return }
    getSolBalance(publicKey.toBase58()).then(setBalance).catch(() => setBalance(null))
  }, [publicKey])
  useEffect(() => () => recognition.current?.stop(), [])
  useEffect(() => { const interval = window.setInterval(() => setNow(Date.now()), 1_000); return () => window.clearInterval(interval) }, [])

  const walletLabel = useMemo(() => publicKey ? shortAddress(publicKey.toBase58()) : 'Connect wallet', [publicKey])

  async function handleConnect() {
    if (connected) { await disconnect(); return }
    if (connecting) return
    try { await connect() } catch { showWalletModal(true) }
  }

  function say(text: string) {
    setMessages((current) => [...current, { role: 'agent', text }])
    if (voiceReplies && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel()
      const spoken = new SpeechSynthesisUtterance(text)
      spoken.rate = 1.03
      window.speechSynthesis.speak(spoken)
    }
  }

  async function send(raw = input) {
    const message = raw.trim()
    if (!message || busy) return
    setInput('')
    setError('')
    setChoice(null)
    setAlternatives([])
    setReceipt('')
    setMessages((current) => [...current, { role: 'user', text: message }])
    setStage('thinking')
    try {
      const response = await fetch('/api/interpret', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, previous: intent }) })
      const result = await response.json() as AgentResult & { error?: string }
      if (!response.ok) throw new Error(result.error || 'Agent unavailable')
      setModel(result.model)
      setIntent(result.intent)
      if (result.missing.length) {
        say(`I need ${result.missing.join(' and ')}. Tell me that, then I can check live maker quotes.`)
        setStage('ready')
        return
      }
      if ((result.intent.quantitySol ?? 0) < 0.1) {
        say('Soleil currently needs at least 0.1 SOL per order. What size of 0.1 SOL or more should I check?')
        setStage('ready')
        return
      }
      say(`I understood: ${result.intent.side} ${result.intent.quantitySol} SOL ${result.intent.kind}, ${result.intent.expiryDays} days${result.intent.maxPremiumSol ? `, spend at most ${result.intent.maxPremiumSol} SOL` : ''}${result.intent.maxPremiumUsd ? `, spend at most $${result.intent.maxPremiumUsd}` : ''}. Checking live quotes now.`)
      setStage('quotes')
      await findChoice(result.intent)
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : 'Agent unavailable'
      setError(reason)
      say(`I could not prepare an order: ${reason}`)
      setStage('ready')
    }
  }

  async function findChoice(nextIntent: OrderIntent) {
    const price = await freshSpot()
    if (!price) throw new Error('Fresh SOL spot price unavailable. No order prepared.')
    setSpot(price)
    const rows = await fetchMakerQuotes(price, nextIntent.expiryDays!)
    if (!rows) throw new Error('Maker quotes unavailable. Start or deploy Soleil maker gateway and retry.')
    const ranked = rankOrders(nextIntent, rows, price)
    const picked = ranked[0]
    if (!picked) throw new Error('No executable quote meets size, expiry, and budget. Try 0.1 SOL or a different limit.')
    setAlternatives(ranked.slice(0, 3))
    setChoice(picked)
    setStage('review')
    say(`Compared ${ranked.length} executable ${picked.kind} quotes. ${usd(picked.series.strike)} is closest to your target. Review the ticket or choose another strike; I will not place it until you sign.`)
  }

  async function refreshQuote() {
    if (busy || !intent.kind) return
    setError('')
    setStage('quotes')
    try { await findChoice(intent) } catch (cause) { setChoice(null); setAlternatives([]); setError(cause instanceof Error ? cause.message : 'Quote refresh failed'); setStage('ready') }
  }

  async function submit() {
    if (!choice || !publicKey || !connected || busy) { showWalletModal(true); return }
    setError('')
    setStage('signing')
    try {
      const programId = getSettlementProgramId()
      if (!programId) throw new Error('Soleil devnet program ID is missing.')
      const now = Date.now() / 1000
      if (choice.terms.expiresAt <= now + 15) throw new Error('Quote expired. Refresh and review a new quote.')
      const fresh = await fetchMakerQuotes(spot || 0, choice.series.expiryDays)
      const current = fresh?.find((row) => row.strike === choice.series.strike && row.expiryAt === choice.series.expiryAt)
      const currentQuote = choice.side === 'buy' ? current?.[choice.kind].askQuote : current?.[choice.kind].bidQuote
      const currentPrice = choice.side === 'buy' ? current?.[choice.kind].ask : current?.[choice.kind].bid
      if (!currentQuote || currentQuote.quoteAddress !== choice.terms.quoteAddress || currentQuote.maker !== choice.terms.maker || currentQuote.nonce !== choice.terms.nonce || currentQuote.premiumLamportsPerSol !== choice.terms.premiumLamportsPerSol || currentQuote.collateralLamportsPerSol !== choice.terms.collateralLamportsPerSol || currentQuote.expiresAt !== choice.terms.expiresAt || currentPrice !== choice.priceUsd || currentQuote.remainingSize < choice.quantitySol || currentQuote.expiresAt <= Date.now() / 1000 + 15) throw new Error('Quote changed. Refresh and review before signing.')
      if (intent.maxPremiumUsd) {
        const latestSpot = await freshSpot()
        if (!latestSpot) throw new Error('Cannot verify your USD spending cap without a fresh SOL price.')
        if (choice.premiumLamports / 1_000_000_000 * latestSpot > intent.maxPremiumUsd) throw new Error('Premium now exceeds your USD spending cap. Review a different quote.')
      }
      const market = deriveMarketPda(programId, choice.series.strike, choice.series.expiryAt!, choice.kind)
      if (!await accountExists(market)) throw new Error('Maker market is not initialized on devnet.')
      if (await accountExists(derivePositionPda(programId, publicKey, market, choice.series.expiryAt!))) throw new Error('This wallet already has a position in this contract. Choose another strike or expiry.')
      const required = (choice.side === 'buy' ? choice.premiumLamports : choice.collateralLamports) / 1_000_000_000 + 0.02
      const walletBalance = await getSolBalance(publicKey.toBase58())
      setBalance(walletBalance)
      if (walletBalance < required) throw new Error(`Wallet needs about ${required.toFixed(3)} devnet SOL, including transaction reserve.`)
      const instruction = buildOpenPositionInstruction({
        programId, owner: new PublicKey(publicKey), kind: choice.kind, side: choice.side,
        strike: choice.series.strike, quantity: choice.quantitySol, premium: choice.priceUsd,
        maker: new PublicKey(choice.terms.maker), quoteNonce: choice.terms.nonce,
        quoteAddress: choice.terms.quoteAddress, expiryAt: choice.series.expiryAt!,
        premiumLamports: choice.premiumLamports, collateralLamports: choice.collateralLamports,
      })
      const signature = await submitSolanaTransaction([instruction], sendTransaction, publicKey.toBase58())
      setReceipt(signature)
      setStage('done')
      say(`Position confirmed on Solana devnet. Receipt: ${signature.slice(0, 8)}…${signature.slice(-6)}. Open the explorer link for proof.`)
      getSolBalance(publicKey.toBase58()).then(setBalance).catch(() => undefined)
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : 'Wallet transaction failed'
      setError(reason)
      setStage('review')
    }
  }

  function startVoice() {
    if (listening) { recognition.current?.stop(); return }
    const browser = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }
    const SpeechRecognition = browser.SpeechRecognition || browser.webkitSpeechRecognition
    if (!SpeechRecognition) { setError('Voice input is unavailable in this browser. Type your order instead.'); return }
    const session = new SpeechRecognition()
    session.lang = 'en-US'
    session.interimResults = false
    session.onresult = (event) => { const transcript = event.results[0]?.[0]?.transcript; if (transcript) { setInput(transcript); void send(transcript) } }
    session.onerror = () => { setListening(false); setError('Microphone unavailable. Type your order instead.') }
    session.onend = () => setListening(false)
    recognition.current = session
    try { session.start(); setListening(true); setError('') } catch { setError('Could not start microphone. Type your order instead.') }
  }

  function reset() { setMessages([{ role: 'agent', text: 'New order. Tell me your SOL goal, size, and duration.' }]); setIntent({}); setChoice(null); setAlternatives([]); setReceipt(''); setError(''); setStage('ready') }

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><img src="/soleil-logo.png" alt="Soleil" /><span>soleil<span className="brand-auto">auto</span></span></div><div className="top-actions"><span className="network"><span className="status-dot" />Devnet</span><button className="wallet-button" onClick={handleConnect}><Wallet size={15} />{walletLabel}</button></div></header>
    <main className="layout">
      <section className="conversation" aria-label="Voice order conversation">
        <div className="hero"><div className="eyebrow"><Sparkles size={14} /> CONVERSATIONAL TRADING</div><h1>Say what you want.<br /><span>See exactly what trades.</span></h1><p>Turn a plain-English SOL goal into a live maker quote. You review the contract and sign with your own wallet.</p><div className="hero-pills"><span>Live quotes</span><span>Human approval</span><span>On-chain receipt</span></div></div>
        <div className="chat-card"><div className="chat-head"><div className="agent-avatar"><AudioLines size={18} /></div><div><strong>Soleil agent</strong><small>{model === 'gemini' ? 'Gemini intent engine' : model === 'local-parser' ? 'Local intent mode · add Gemini key for AI' : 'Connecting to agent'}</small></div><button className="icon-button" onClick={() => { setVoiceReplies((value) => !value); window.speechSynthesis?.cancel() }} title={voiceReplies ? 'Turn voice replies off' : 'Turn voice replies on'} aria-label={voiceReplies ? 'Turn voice replies off' : 'Turn voice replies on'}>{voiceReplies ? <Volume2 size={17} /> : <VolumeX size={17} />}</button><button className="icon-button reset-button" onClick={reset} title="New conversation" aria-label="New conversation"><RotateCcw size={17} /></button></div>
          <div className="chat-messages">{messages.map((entry, index) => <div className={`message ${entry.role}`} key={`${index}-${entry.role}`}>{entry.role === 'agent' && <div className="mini-avatar"><Sparkles size={12} /></div>}<div className="bubble">{entry.text}</div></div>)}{busy && stage !== 'signing' && <div className="message agent"><div className="mini-avatar"><Sparkles size={12} /></div><div className="bubble muted-bubble">{stage === 'quotes' ? 'Checking maker quotes…' : 'Understanding your request…'}</div></div>}<div ref={chatEnd} /></div>
          {messages.length === 1 && <div className="suggestions">{promptExamples.map((example) => <button key={example} onClick={() => send(example)}>{example}<ChevronRight size={13} /></button>)}</div>}
          <form className="composer" onSubmit={(event) => { event.preventDefault(); send() }}><button type="button" className={`mic-button ${listening ? 'listening' : ''}`} onClick={startVoice} aria-label={listening ? 'Stop listening' : 'Speak order'}><Mic size={18} /></button><input aria-label="Tell Soleil what you want to trade" placeholder={listening ? 'Listening…' : 'e.g. Protect 0.1 SOL next week'} value={input} onChange={(event) => setInput(event.target.value)} disabled={busy} /><button type="submit" className="send-button" disabled={!input.trim() || busy} aria-label="Send request"><Send size={17} /></button></form>
          <p className="composer-note">Speaking sends your request. Wallet approval remains separate.</p>
        </div>
      </section>
      <aside className="right-rail" aria-label="Order preparation and review"><div className="rail-title"><span>ORDER DESK</span><span className={`rail-state ${stage}`}>{stage === 'done' ? 'Confirmed' : stage === 'review' ? 'Ready to review' : stage === 'signing' ? 'Awaiting wallet' : 'Preparing'}</span></div>
        <div className="progress"><div className="progress-step active"><span>1</span><div><strong>Describe intent</strong><small>Plain language or voice</small></div><Check size={14} /></div><div className={`progress-step ${choice ? 'active' : ''}`}><span>2</span><div><strong>Match live quote</strong><small>Maker-backed SOL option</small></div>{choice && <Check size={14} />}</div><div className={`progress-step ${receipt ? 'active' : ''}`}><span>3</span><div><strong>Wallet signs</strong><small>Solana devnet receipt</small></div>{receipt && <Check size={14} />}</div></div>
        {choice ? <div className="order-card"><div className="card-kicker"><ShieldCheck size={15} /> EXECUTABLE CONTRACT</div><div className="order-heading"><div><small>{choice.side.toUpperCase()} · {choice.series.expiryDays} DAYS</small><h2>SOL {choice.kind === 'put' ? 'Put' : 'Call'}</h2></div><span className="quote-live"><span className="status-dot" />{quoteValid ? 'Live' : 'Expired'}</span></div><div className="order-grid"><div><span>Strike</span><strong>{usd(choice.series.strike)}</strong></div><div><span>Expiry</span><strong>{choice.series.expiryLabel}</strong></div><div><span>Size</span><strong>{choice.quantitySol} SOL</strong></div><div><span>Price / SOL</span><strong>{usd(choice.priceUsd)}</strong></div></div><div className="cost-line"><span>{choice.side === 'buy' ? 'Premium to pay' : 'Premium to receive'}</span><strong>{sol(choice.premiumLamports)}</strong></div>{choice.side === 'sell' && <div className="cost-line"><span>Collateral to lock</span><strong>{sol(choice.collateralLamports)}</strong></div>}<div className="cost-line"><span>Quote expires</span><strong>{new Date(choice.terms.expiresAt * 1000).toLocaleTimeString()}</strong></div><div className="quote-explain"><strong>Why this contract?</strong><p>{alternatives[0]?.series.strike === choice.series.strike ? intent.targetStrikeUsd ? `Closest available strike to your $${intent.targetStrikeUsd} target.` : `Closest available ${choice.kind} strike to current SOL spot (${spot ? usd(spot) : 'unavailable'}).` : 'You selected this alternative strike.'}{intent.maxPremiumSol ? ` Within your ${intent.maxPremiumSol} SOL cap.` : ''}{intent.maxPremiumUsd ? ` Within your $${intent.maxPremiumUsd} cap at current spot.` : ''} Maker size covers your order.</p></div><button className="main-action" onClick={!quoteValid ? refreshQuote : connected ? submit : handleConnect} disabled={busy || stage === 'done'}>{stage === 'signing' ? 'Confirm in wallet…' : stage === 'done' ? 'Order confirmed' : !quoteValid ? 'Refresh quote to continue' : connected ? 'Review & sign in wallet' : 'Connect wallet to continue'}<ArrowRight size={16} /></button><button className="refresh-button" onClick={refreshQuote} disabled={busy}>Refresh live quote</button><p className="card-foot"><LockKeyhole size={13} /> Soleil Auto never receives your wallet key.</p></div> : <div className="empty-order"><div className="empty-icon"><AudioLines size={24} /></div><h2>Your order appears here</h2><p>Describe the outcome you want. The agent asks for missing details, checks maker quotes, and builds a reviewable trade.</p></div>}
        {alternatives.length > 1 && choice && stage !== 'done' && <div className="alternatives"><div className="alternatives-heading"><span>ALSO AVAILABLE</span><small>Compared {alternatives.length} closest strikes</small></div>{alternatives.map((item) => <button key={`${item.series.expiryAt}-${item.series.strike}`} className={item.series.strike === choice.series.strike ? 'selected' : ''} onClick={() => setChoice(item)} disabled={busy}><span>${item.series.strike} {item.kind}</span><strong>{sol(item.premiumLamports)}</strong>{item.series.strike === choice.series.strike && <Check size={13} />}</button>)}</div>}
        {receipt && <a className="receipt-card" href={getExplorerTransactionUrl(receipt)} target="_blank" rel="noreferrer"><Check size={16} /><span>Confirmed on Solana devnet<small>{receipt.slice(0, 12)}…{receipt.slice(-8)}</small></span><ExternalLink size={15} /></a>}
        {error && <div className="error-banner" role="alert"><X size={15} />{error}</div>}
        <div className="rail-footer"><span>Network: Solana devnet</span><span>Wallet: {connected ? walletLabel : 'not connected'}</span>{balance !== null && <span>Balance: {balance.toFixed(4)} SOL</span>}</div>
      </aside>
    </main>
  </div>
}

export default App

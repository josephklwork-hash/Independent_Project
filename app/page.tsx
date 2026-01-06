"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";

export const dynamic = 'force-dynamic';

/* ---------- types ---------- */

type Role = "student" | "professional";

type Screen =
  | "role"
  | "studentProfile"
  | "studentLogin"
  | "dashboard"
  | "professionalDashboard"
  | "game";

type Seat = "top" | "bottom";

type Card = {
  rank: string;
  suit: string;
};

type Street = 0 | 3 | 4 | 5;
type StreetName = "Preflop" | "Flop" | "Turn" | "River";

type GameState = {
  stacks: { top: number; bottom: number };
  bets: { top: number; bottom: number }; // chips currently in front (this street)
  pot: number; // chips already pulled into pot from prior streets
};

type HandStatus = "playing" | "ended";
type HandEndReason = "fold" | "showdown" | null;

type HandResult = {
  status: HandStatus;
  winner: Seat | "tie" | null;
  reason: HandEndReason;
  message: string;
};

type ActionLogItem = {
  id: string;
  street: StreetName;
  seat: Seat;
  text: string;
};

type HandLogSnapshot = {
  handNo: number;
  dealer: Seat;
  endedStreet: Street;
  endedBoard: Card[];
  log: ActionLogItem[];

  heroPos: "SB" | "BB";
  oppPos: "SB" | "BB";

  heroCards: [Card, Card];
  oppCards: [Card, Card];

  // true only if opponent actually showed / was required to show
  oppShown: boolean;

  heroStartStack: number;
  oppStartStack: number;
};

type AuthoritativeState = {
  street: Street;
  toAct: Seat;

  actionLog: ActionLogItem[];
  handResult: HandResult;

  gameOver: boolean;
  endedBoardSnapshot: Street;

  lastAggressor: Seat | null;
  actionsThisStreet: number;
  lastToActAfterAggro: Seat | null;
  sawCallThisStreet: boolean;
  lastRaiseSize: number;
  checked: { top: boolean; bottom: boolean };

  showdownFirst: Seat | null;
  oppRevealed: boolean;
  youMucked: boolean;
  streetBettor: Seat | null;
};

/* ---------- constants ---------- */

const RANKS = ["A", "K", "Q", "J", "T", "9", "8", "7", "6", "5", "4", "3", "2"];
const SUITS = ["♠", "♥", "♦", "♣"];

const STARTING_STACK_BB = 50;
const BASE_SB = 0.5;
const BASE_BB = 1;

/* ---------- helpers ---------- */

function drawUniqueCards(count: number): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push({ rank, suit });

  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck.slice(0, count);
}

function roundToHundredth(n: number) {
  return Math.round(n * 100) / 100;
}

function formatBB(value: number | "") {
  if (value === "") return "";
  if (Number.isInteger(value)) return value.toString();
  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function streetNameFromCount(street: Street): StreetName {
  if (street === 0) return "Preflop";
  if (street === 3) return "Flop";
  if (street === 4) return "Turn";
  return "River";
}

function uid() {
  return Math.random().toString(16).slice(2) + "-" + Date.now().toString(16);
}

/* ---------- simple poker evaluator (7-card) ---------- */

const RANK_TO_VALUE: Record<string, number> = {
  A: 14,
  K: 13,
  Q: 12,
  J: 11,
  T: 10,
  "9": 9,
  "8": 8,
  "7": 7,
  "6": 6,
  "5": 5,
  "4": 4,
  "3": 3,
  "2": 2,
};

function compareScore(a: number[], b: number[]) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function getStraightHigh(valuesUniqueDesc: number[]) {
  const vals = [...valuesUniqueDesc];
  if (vals[0] === 14) vals.push(1); // wheel

  let run = 1;
  for (let i = 0; i < vals.length - 1; i++) {
    if (vals[i] - 1 === vals[i + 1]) {
      run++;
      if (run >= 5) {
        const high = vals[i - 3];
        return high === 1 ? 5 : high;
      }
    } else {
      run = 1;
    }
  }
  return null;
}

function evaluate7(cards: Card[]) {
  const values = cards.map((c) => RANK_TO_VALUE[c.rank]).sort((a, b) => b - a);

  const counts = new Map<number, number>();
  const suits = new Map<string, number[]>();

  for (const c of cards) {
    const v = RANK_TO_VALUE[c.rank];
    counts.set(v, (counts.get(v) ?? 0) + 1);
    const arr = suits.get(c.suit) ?? [];
    arr.push(v);
    suits.set(c.suit, arr);
  }

  const groups = Array.from(counts.entries())
    .map(([v, cnt]) => ({ v, cnt }))
    .sort((a, b) => (b.cnt !== a.cnt ? b.cnt - a.cnt : b.v - a.v));

  // Flush?
  let flushSuit: string | null = null;
  let flushValsDesc: number[] = [];
  for (const [s, vals] of suits.entries()) {
    if (vals.length >= 5) {
      const sorted = vals.slice().sort((a, b) => b - a);
      if (!flushSuit || compareScore(sorted, flushValsDesc) > 0) {
        flushSuit = s;
        flushValsDesc = sorted;
      }
    }
  }

  const uniqueDesc = Array.from(new Set(values)).sort((a, b) => b - a);
  const straightHigh = getStraightHigh(uniqueDesc);

  // Straight flush
  if (flushSuit) {
    const fvUnique = Array.from(new Set(flushValsDesc)).sort((a, b) => b - a);
    const sfHigh = getStraightHigh(fvUnique);
    if (sfHigh !== null) return [8, sfHigh];
  }

  // Quads
  if (groups[0]?.cnt === 4) {
    const quad = groups[0].v;
    const kicker = uniqueDesc.find((v) => v !== quad) ?? 0;
    return [7, quad, kicker];
  }

  // Full house
  if (groups[0]?.cnt === 3) {
    const trips = groups[0].v;
    const pairCandidate = groups.find((g) => g.v !== trips && g.cnt >= 2);
    if (pairCandidate) return [6, trips, pairCandidate.v];
  }

  // Flush
  if (flushSuit) return [5, ...flushValsDesc.slice(0, 5)];

  // Straight
  if (straightHigh !== null) return [4, straightHigh];

  // Trips
  if (groups[0]?.cnt === 3) {
    const trips = groups[0].v;
    const kickers = uniqueDesc.filter((v) => v !== trips).slice(0, 2);
    return [3, trips, ...kickers];
  }

  // Two pair
  if (groups[0]?.cnt === 2) {
    const pairs = groups.filter((g) => g.cnt === 2).map((g) => g.v);
    if (pairs.length >= 2) {
      const sorted = pairs.sort((a, b) => b - a);
      const highPair = sorted[0];
      const lowPair = sorted[1];
      const kicker = uniqueDesc.find((v) => v !== highPair && v !== lowPair) ?? 0;
      return [2, highPair, lowPair, kicker];
    }
  }

  // One pair
  if (groups[0]?.cnt === 2) {
    const pair = groups[0].v;
    const kickers = uniqueDesc.filter((v) => v !== pair).slice(0, 3);
    return [1, pair, ...kickers];
  }

  // High card
  return [0, ...uniqueDesc.slice(0, 5)];
}

const VALUE_TO_NAME: Record<number, string> = {
  14: "Ace",
  13: "King",
  12: "Queen",
  11: "Jack",
  10: "Ten",
  9: "Nine",
  8: "Eight",
  7: "Seven",
  6: "Six",
  5: "Five",
  4: "Four",
  3: "Three",
  2: "Two",
};

function pluralRank(v: number) {
  const name = VALUE_TO_NAME[v] ?? String(v);
  // simple plural for poker ranks
  if (name === "Six") return "Sixes";
  return name + "s";
}

function cardStr(c: Card) {
  return `${c.rank}${c.suit}`;
}

function handDesc(score: number[]) {
  const cat = score[0];

  // score formats from your evaluator:
  // 8: [8, sfHigh]
  // 7: [7, quad, kicker]
  // 6: [6, trips, pair]
  // 5: [5, v1, v2, v3, v4, v5] (flush high cards)
  // 4: [4, straightHigh]
  // 3: [3, trips, k1, k2]
  // 2: [2, highPair, lowPair, kicker]
  // 1: [1, pair, k1, k2, k3]
  // 0: [0, h1, h2, h3, h4, h5]

  if (cat === 8) return `Straight Flush, ${VALUE_TO_NAME[score[1]]}-high`;
  if (cat === 7) return `Four of a Kind, ${pluralRank(score[1])} (kicker ${VALUE_TO_NAME[score[2]]})`;
  if (cat === 6) return `Full House, ${pluralRank(score[1])} full of ${pluralRank(score[2])}`;
  if (cat === 5) return `Flush, ${VALUE_TO_NAME[score[1]]}-high`;
  if (cat === 4) return `Straight, ${VALUE_TO_NAME[score[1]]}-high`;
  if (cat === 3) return `Three of a Kind, ${pluralRank(score[1])} (kicker ${VALUE_TO_NAME[score[2]]})`;
  if (cat === 2)
    return `Two Pair, ${pluralRank(score[1])} and ${pluralRank(score[2])} (kicker ${VALUE_TO_NAME[score[3]]})`;
  if (cat === 1) return `One Pair, ${pluralRank(score[1])} (kicker ${VALUE_TO_NAME[score[2]]})`;

  // high card
  return `High Card, ${VALUE_TO_NAME[score[1]]} (kicker ${VALUE_TO_NAME[score[2]]})`;
}

function handRankOnly(score: number[]) {
  switch (score[0]) {
    case 8: return "Straight Flush";
    case 7: return "Four of a Kind";
    case 6: return "Full House";
    case 5: return "Flush";
    case 4: return "Straight";
    case 3: return "Three of a Kind";
    case 2: return "Two Pair";
    case 1: return "One Pair";
    default: return "High Card";
  }
}

const connectButtonClass =
  "rounded-xl border border-black bg-white px-3 py-1.5 text-sm font-semibold text-black transition-colors hover:bg-gray-50";

/* ---------- UI components ---------- */

const SUIT_COLOR: Record<string, string> = {
  "♠": "text-black",
  "♥": "text-red-600",
  "♦": "text-blue-600",
  "♣": "text-green-600",
};

function CardTile({ card }: { card: Card }) {
  const colorClass = SUIT_COLOR[card.suit];
  return (
    <div className="relative h-24 w-16 rounded-xl border bg-white shadow-sm">
      <div className={`absolute left-3 top-2 text-4xl font-extrabold ${colorClass}`}>
  {card.rank}
</div>
      <div className={`absolute bottom-3 right-3 text-4xl font-bold ${colorClass}`}>
  {card.suit}
</div>
    </div>
  );
}

function renderActionText(text: string) {
  return text.split(/([♠♥♦♣])/).map((part, i) => {
    const suitClass = SUIT_COLOR[part];

    if (suitClass) {
      // Thin, crisp outline (no blur). Webkit stroke gives a continuous outline (great in Safari),
      // and 8-direction text-shadow helps fill tiny gaps on sharp tips.
      const outlineStyle: React.CSSProperties = {
        WebkitTextStroke: "0.45px #fff",
textShadow: `
  -0.45px  0px   0 #fff,
   0.45px  0px   0 #fff,
   0px   -0.45px 0 #fff,
   0px    0.45px 0 #fff,
  -0.45px -0.45px 0 #fff,
   0.45px -0.45px 0 #fff,
  -0.45px  0.45px 0 #fff,
   0.45px  0.45px 0 #fff
`,
      };

      return (
        <span key={i} className={suitClass} style={outlineStyle}>
          {part}
        </span>
      );
    }

    return <span key={i}>{part}</span>;
  });
}


function CardBack() {
  return (
    <div className="relative h-24 w-16 rounded-xl border bg-white shadow-sm">
      <div className="absolute inset-2 rounded-lg border border-dashed opacity-40" />
    </div>
  );
}

function BetChip({ amount, label }: { amount: number; label?: string }) {
  if (amount <= 0) return null;
  return (
    <div className="flex h-9 w-9 flex-col items-center justify-center rounded-full border bg-white text-black shadow-sm">
      <div className="text-[11px] font-bold leading-none tabular-nums">
        {formatBB(amount)}
      </div>
      {label ? (
        <div className="mt-[1px] text-[9px] font-semibold leading-none opacity-70">
          {label}
        </div>
      ) : null}
    </div>
  );
}

function ConfirmModal({
  open,
  title,
  message,
  cancelText = "Go back",
  confirmText = "Confirm",
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  message: string;
  cancelText?: string;
  confirmText?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-6">
      <div className="absolute inset-0 bg-black/50" onClick={onCancel} aria-hidden="true" />
      <div className="relative w-full max-w-md rounded-3xl border border-gray-300 bg-gray-100 p-6 shadow-lg">
        <h3 className="mb-2 text-lg font-bold text-gray-900">{title}</h3>
        <p className="mb-6 text-sm text-gray-800">{message}</p>

        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="rounded-2xl border px-4 py-2 text-sm font-semibold text-gray-900 transition-colors hover:bg-gray-200"
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            className="rounded-2xl border px-4 py-2 text-sm font-semibold text-gray-900 transition-colors hover:bg-gray-200"
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}


/* ---------- main ---------- */

export default function Home() {
  const [seatedRole, setSeatedRole] = useState<Role | null>(null);

  const [handId, setHandId] = useState(0);
  const [gameSession, setGameSession] = useState(0);
  const [sbUser, setSbUser] = useState<User | null>(null);

const handNo = handId + 1; // 1-based

const SB = BASE_SB; // always 0.5
const BB = BASE_BB; // always 1


  const withinBlock = ((handNo - 1) % 10) + 1; // 1..10 within each 10-hand block
let blindNotice: string | null = null;

if (withinBlock >= 7 && withinBlock <= 10) {
  const remaining = 11 - withinBlock; // 7->4, 8->3, 9->2, 10->1
  blindNotice =
    remaining === 1
      ? "Blinds will change next hand"
: `Blinds will change in ${remaining} hands`;
}

  const [auth, setAuth] = useState<AuthoritativeState>(() => ({
  street: 0,
  toAct: "bottom",

  actionLog: [],
  handResult: { status: "playing", winner: null, reason: null, message: "" },

  gameOver: false,
  endedBoardSnapshot: 0,

  lastAggressor: null,
  actionsThisStreet: 0,
  lastToActAfterAggro: null,
  sawCallThisStreet: false,
  lastRaiseSize: BB,
  checked: { top: false, bottom: false },

  showdownFirst: null,
  oppRevealed: false,
  youMucked: false,
  streetBettor: null,
}));

const street = auth.street;
const setStreet = (next: any) =>
  setAuth((prev) => ({
    ...prev,
    street: typeof next === "function" ? next(prev.street) : next,
  }));

const toAct = auth.toAct;
const setToAct = (next: any) =>
  setAuth((prev) => ({
    ...prev,
    toAct: typeof next === "function" ? next(prev.toAct) : next,
  }));

const actionLog = auth.actionLog;
const setActionLog = (next: any) =>
  setAuth((prev) => {
    const value = typeof next === "function" ? next(prev.actionLog) : next;
    return { ...prev, actionLog: value };
  });

const handResult = auth.handResult;
const setHandResult = (next: any) =>
  setAuth((prev) => ({
    ...prev,
    handResult: typeof next === "function" ? next(prev.handResult) : next,
  }));

const gameOver = auth.gameOver;
const setGameOver = (next: any) =>
  setAuth((prev) => ({
    ...prev,
    gameOver: typeof next === "function" ? next(prev.gameOver) : next,
  }));

const endedBoardSnapshot = auth.endedBoardSnapshot;
const setEndedBoardSnapshot = (next: any) =>
  setAuth((prev) => ({
    ...prev,
    endedBoardSnapshot:
      typeof next === "function" ? next(prev.endedBoardSnapshot) : next,
  }));

const lastAggressor = auth.lastAggressor;
const setLastAggressor = (next: any) =>
  setAuth((prev) => ({
    ...prev,
    lastAggressor: typeof next === "function" ? next(prev.lastAggressor) : next,
  }));

const actionsThisStreet = auth.actionsThisStreet;
const setActionsThisStreet = (next: any) =>
  setAuth((prev) => ({
    ...prev,
    actionsThisStreet:
      typeof next === "function" ? next(prev.actionsThisStreet) : next,
  }));

const lastToActAfterAggro = auth.lastToActAfterAggro;
const setLastToActAfterAggro = (next: any) =>
  setAuth((prev) => ({
    ...prev,
    lastToActAfterAggro:
      typeof next === "function" ? next(prev.lastToActAfterAggro) : next,
  }));

const sawCallThisStreet = auth.sawCallThisStreet;
const setSawCallThisStreet = (next: any) =>
  setAuth((prev) => ({
    ...prev,
    sawCallThisStreet:
      typeof next === "function" ? next(prev.sawCallThisStreet) : next,
  }));

const lastRaiseSize = auth.lastRaiseSize;
const setLastRaiseSize = (next: any) =>
  setAuth((prev) => ({
    ...prev,
    lastRaiseSize:
      typeof next === "function" ? next(prev.lastRaiseSize) : next,
  }));

const checked = auth.checked;
const setChecked = (next: any) =>
  setAuth((prev) => ({
    ...prev,
    checked: typeof next === "function" ? next(prev.checked) : next,
  }));

const showdownFirst = auth.showdownFirst;
const setShowdownFirst = (next: any) =>
  setAuth((prev) => ({
    ...prev,
    showdownFirst:
      typeof next === "function" ? next(prev.showdownFirst) : next,
  }));

const oppRevealed = auth.oppRevealed;
const setOppRevealed = (next: any) =>
  setAuth((prev) => ({
    ...prev,
    oppRevealed: typeof next === "function" ? next(prev.oppRevealed) : next,
  }));

const youMucked = auth.youMucked;
const setYouMucked = (next: any) =>
  setAuth((prev) => ({
    ...prev,
    youMucked: typeof next === "function" ? next(prev.youMucked) : next,
  }));

const streetBettor = auth.streetBettor;
const setStreetBettor = (next: any) =>
  setAuth((prev) => ({
    ...prev,
    streetBettor:
      typeof next === "function" ? next(prev.streetBettor) : next,
  }));

  const [dealerOffset, setDealerOffset] = useState<0 | 1>(0);

  const [betSize, setBetSize] = useState<number | "">(2);

  const [game, setGame] = useState<GameState>({
    stacks: { top: STARTING_STACK_BB, bottom: STARTING_STACK_BB },
    bets: { top: 0, bottom: 0 },
    pot: 0,
  });

  const [cards, setCards] = useState<Card[] | null>(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  const [handLogHistory, setHandLogHistory] = useState<HandLogSnapshot[]>([]);
  const [logViewOffset, setLogViewOffset] = useState(0);

  const [screen, setScreen] = useState<Screen>("role");
  const [gamePin, setGamePin] = useState<string | null>(null);
  const [joinMode, setJoinMode] = useState(false);
  const [joinPinInput, setJoinPinInput] = useState("");
  const [creatingGame, setCreatingGame] = useState(false);
  const [isCreatingPin, setIsCreatingPin] = useState(false);

  const [gameId, setGameId] = useState<string | null>(null);
  const [mySeat, setMySeat] = useState<Seat>("bottom");
  const [multiplayerActive, setMultiplayerActive] = useState(false);

  const mpChannelRef = useRef<any>(null);

    const isHost = mySeat === "bottom";
  const suppressMpRef = useRef(false);

  function mpSend(payload: any) {
    if (!multiplayerActive) return;
    const ch = mpChannelRef.current;
    if (!ch) return;

    ch.send({
      type: "broadcast",
      event: "mp",
      payload: { ...payload, sender: sbUser?.id ?? null },
    });
  }

  function applyActionFromSeat(seat: Seat, action: GameAction) {
    // remote actions must bypass local click gating
    if (handResult.status !== "playing") return;
    if (gameOverRef.current) return;

    switch (action.type) {
      case "FOLD":
        actFold(seat);
        return;
      case "CHECK":
        actCheck(seat);
        return;
      case "CALL":
        actCall(seat);
        return;
      case "BET_RAISE_TO":
        actBetRaiseTo(seat, action.to);
        return;
      default:
        return;
    }
  }

  function applyRemoteDeal(nextCards: Card[]) {
    suppressMpRef.current = true;
    setCards(nextCards);
    suppressMpRef.current = false;
  }

const [playAgainRequested, setPlayAgainRequested] = useState(false);

const [aiEnabled, setAiEnabled] = useState(false);

useEffect(() => {
  if (gamePin) {
    setAiEnabled(false);
  }
}, [gamePin]);

const [studentProfile, setStudentProfile] = useState({
  firstName: "",
  lastName: "",
  email: "",
  password: "",
  year: "",
  major: "",
  company: "",
  workTitle: "",
});

const [loginEmail, setLoginEmail] = useState("");
const [loginPassword, setLoginPassword] = useState("");

const [studentMenuOpen, setStudentMenuOpen] = useState(false);

const [otherStudents, setOtherStudents] = useState<
  { firstName: string; lastName: string; year: string; major: string }[]
>([]);

const [otherProfessionals, setOtherProfessionals] = useState<
  { firstName: string; lastName: string; company: string; workTitle: string }[]
>([]);

  // timers
  const opponentTimerRef = useRef<number | null>(null);
  const pendingAiOffRef = useRef(false);
  const nextHandTimerRef = useRef<number | null>(null);
  const gameOverRef = useRef(false);
  const allInCallThisHandRef = useRef(false);
  const actionLogRef = useRef<ActionLogItem[]>([]);
  const endedStreetRef = useRef<Street>(0);
  const blindsPostedRef = useRef(false);
  const gameRef = useRef(game);
  const streetRef = useRef<Street>(street);

useEffect(() => {
  gameRef.current = game;
}, [game]);

useEffect(() => {
  gameOverRef.current = gameOver;
}, [gameOver]);

useEffect(() => {
  streetRef.current = street;
}, [street]);

useEffect(() => {
  (async () => {
    try {
      await getOrCreateUser(); // pre-warm auth session
    } catch (e) {
      console.error("prewarm auth failed:", e);
    }
  })();
}, []);

useEffect(() => {
  if (!gameId) return;

  // Clean up any prior channel
  if (mpChannelRef.current) {
    supabase.removeChannel(mpChannelRef.current);
    mpChannelRef.current = null;
  }

  const ch = supabase.channel(`game:${gameId}`);

  // When the joiner updates games.status to "active", the host should enter the game
  ch.on(
    "postgres_changes",
    {
      event: "UPDATE",
      schema: "public",
      table: "games",
      filter: `id=eq.${gameId}`,
    },
    (payload: any) => {
      const nextStatus = payload?.new?.status;

      if (nextStatus === "active") {
        setMultiplayerActive(true);
        clearTimers();
        resetGame();
        setSeatedRole((prev) => prev ?? "student");
        setScreen("game");
      }
    }
  );

    // realtime action + sync
  ch.on("broadcast", { event: "mp" }, ({ payload }: any) => {
    if (!payload) return;
    if (payload.sender && payload.sender === (sbUser?.id ?? null)) return;

    // ACTION: apply the action coming from the other device
    if (payload.event === "ACTION") {
      suppressMpRef.current = true;
      applyActionFromSeat(payload.seat as Seat, payload.action as GameAction);
      suppressMpRef.current = false;
      return;
    }

    // SYNC: reset / deal
    if (payload.event === "SYNC") {
      if (
  payload.kind === "RESET" &&
  (payload.dealerOffset === 0 || payload.dealerOffset === 1) &&
  Number.isFinite(payload.gameSession) &&
  Number.isFinite(payload.handId) &&
  payload.game &&
  payload.game.stacks &&
  payload.game.bets
) {
  applyRemoteReset({
    dealerOffset: payload.dealerOffset as 0 | 1,
    gameSession: payload.gameSession as number,
    handId: payload.handId as number,
    game: payload.game as GameState,
  });
  return;
}

      if (payload.kind === "DEAL" && Array.isArray(payload.cards)) {
        suppressMpRef.current = true;
        setCards(payload.cards as Card[]);
        suppressMpRef.current = false;
        return;
      }

      if (payload.kind === "STREET_ADVANCE" && typeof payload.nextStreet === "number" && payload.firstToAct) {
        suppressMpRef.current = true;
        resetStreetRound(payload.nextStreet as Street);
        suppressMpRef.current = false;
        return;
      }

      if (payload.kind === "PULL_BETS" && payload.game) {
        suppressMpRef.current = true;
        setGame(payload.game as GameState);
        suppressMpRef.current = false;
        return;
      }

      if (payload.kind === "END_HAND" && payload.stacks) {
        suppressMpRef.current = true;
        setGame((prev: GameState) => ({
          pot: 0,
          bets: { top: 0, bottom: 0 },
          stacks: payload.stacks as GameState["stacks"],
        }));
        suppressMpRef.current = false;
        return;
      }

      if (payload.kind === "NEW_HAND") {
        suppressMpRef.current = true;
        startNewHand();
        suppressMpRef.current = false;
        return;
      }

      if (payload.kind === "SET_TO_ACT" && payload.toAct) {
        suppressMpRef.current = true;
        setToAct(payload.toAct as Seat);
        suppressMpRef.current = false;
        return;
      }

      if (payload.kind === "FOLD_END" && payload.winner && typeof payload.endedStreet === "number") {
        suppressMpRef.current = true;
        endedStreetRef.current = payload.endedStreet as Street;
        setEndedBoardSnapshot(payload.endedStreet as Street);
        suppressMpRef.current = false;
        return;
      }

      if (payload.kind === "ALL_IN_RUNOUT") {
        suppressMpRef.current = true;
        setStreet(5);
        suppressMpRef.current = false;
        return;
      }

      if (payload.kind === "SHOWDOWN" && typeof payload.topShows === "boolean" && typeof payload.bottomShows === "boolean" && payload.winner) {
        suppressMpRef.current = true;
        setOppRevealed(payload.topShows);
        setYouMucked(!payload.bottomShows);
        suppressMpRef.current = false;
        return;
      }

      if (payload.kind === "LOG_ACTION" && payload.item) {
        suppressMpRef.current = true;
        setActionLog((prev: ActionLogItem[]) => {
          const next = [...prev, payload.item as ActionLogItem];
          actionLogRef.current = next;
          return next;
        });
        suppressMpRef.current = false;
        return;
      }

      if (payload.kind === "HAND_RESULT" && payload.handResult) {
        suppressMpRef.current = true;
        setHandResult(payload.handResult as HandResult);
        suppressMpRef.current = false;
        return;
      }

      if (payload.kind === "SET_CHECKED" && payload.seat && typeof payload.actionsThisStreet === "number") {
        suppressMpRef.current = true;
        setChecked((prev: { top: boolean; bottom: boolean }) => ({ ...prev, [payload.seat as Seat]: true }));
        setActionsThisStreet(payload.actionsThisStreet);
        suppressMpRef.current = false;
        return;
      }

      if (payload.kind === "SAW_CALL" && typeof payload.actionsThisStreet === "number") {
        suppressMpRef.current = true;
        setSawCallThisStreet(true);
        setActionsThisStreet(payload.actionsThisStreet);
        suppressMpRef.current = false;
        return;
      }

      if (payload.kind === "SET_AGGRESSOR" && payload.lastAggressor && payload.lastToActAfterAggro && typeof payload.actionsThisStreet === "number" && typeof payload.lastRaiseSize === "number" && payload.streetBettor) {
        suppressMpRef.current = true;
        setLastAggressor(payload.lastAggressor as Seat);
        setLastToActAfterAggro(payload.lastToActAfterAggro as Seat);
        setActionsThisStreet(payload.actionsThisStreet);
        setLastRaiseSize(payload.lastRaiseSize);
        setStreetBettor(payload.streetBettor as Seat);
        setChecked({ top: false, bottom: false });
        suppressMpRef.current = false;
        return;
      }

      if (payload.kind === "RESET_STREET" && typeof payload.nextStreet === "number" && payload.firstToAct) {
        suppressMpRef.current = true;
        setStreet(payload.nextStreet as Street);
        setChecked({ top: false, bottom: false });
        setLastAggressor(null);
        setLastToActAfterAggro(null);
        setActionsThisStreet(0);
        setStreetBettor(null);
        setSawCallThisStreet(false);
        setLastRaiseSize(BB);
        setToAct(payload.firstToAct as Seat);
        suppressMpRef.current = false;
        return;
      }

      if (payload.kind === "SET_SHOWDOWN_FIRST" && payload.showdownFirst) {
        suppressMpRef.current = true;
        setShowdownFirst(payload.showdownFirst as Seat);
        suppressMpRef.current = false;
        return;
      }

      if (payload.kind === "GAME_OVER") {
        suppressMpRef.current = true;
        gameOverRef.current = true;
        setGameOver(true);
        clearTimers();
        suppressMpRef.current = false;
        return;
      }

      if (payload.kind === "CLEAR_LAST_TO_ACT") {
        suppressMpRef.current = true;
        setLastToActAfterAggro(null);
        suppressMpRef.current = false;
        return;
      }

      if (payload.kind === "STREET_COMPLETE" && typeof payload.street === "number") {
        suppressMpRef.current = true;
        pullBetsIntoPot();
        suppressMpRef.current = false;
        return;
      }

      if (payload.kind === "SET_ENDED_SNAPSHOT" && typeof payload.endedBoardSnapshot === "number") {
        suppressMpRef.current = true;
        endedStreetRef.current = payload.endedBoardSnapshot as Street;
        setEndedBoardSnapshot(payload.endedBoardSnapshot as Street);
        suppressMpRef.current = false;
        return;
      }

      if (payload.kind === "HAND_START_STACKS" && payload.stacks) {
        suppressMpRef.current = true;
        setHandStartStacks(payload.stacks as GameState["stacks"]);
        suppressMpRef.current = false;
        return;
      }

      if (payload.kind === "POST_BLINDS" && payload.game && payload.toAct) {
        suppressMpRef.current = true;
        setGame(payload.game as GameState);
        setToAct(payload.toAct as Seat);
        suppressMpRef.current = false;
        return;
      }

      if (payload.kind === "BLINDS_POSTED") {
        suppressMpRef.current = true;
        blindsPostedRef.current = true;
        suppressMpRef.current = false;
        return;
      }

      if (payload.kind === "SET_HAND_ID" && typeof payload.handId === "number") {
        suppressMpRef.current = true;
        setHandId(payload.handId);
        suppressMpRef.current = false;
        return;
      }

      if (payload.kind === "ALL_IN_CALL_FLAG") {
        suppressMpRef.current = true;
        allInCallThisHandRef.current = true;
        suppressMpRef.current = false;
        return;
      }
    }
  });

  ch.subscribe();
  mpChannelRef.current = ch;

  return () => {
    supabase.removeChannel(ch);
    mpChannelRef.current = null;
  };
}, [gameId, sbUser?.id]);

useEffect(() => {
  let mounted = true;

  supabase.auth.getUser().then(({ data }) => {
    if (!mounted) return;
    setSbUser(data.user ?? null);
  });

  const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
    setSbUser(session?.user ?? null);
  });

  return () => {
    mounted = false;
    sub.subscription.unsubscribe();
  };
}, []);

useEffect(() => {
  if (screen !== "role") return;
  if (!gamePin) return;
  if (joinMode) return;

  let cancelled = false;

  const interval = window.setInterval(async () => {
    try {
      const { data, error } = await supabase
        .from("games")
        .select("status")
        .eq("pin", gamePin)
        .single();

      if (cancelled) return;
      if (error || !data) return;

      if (data.status === "active") {
  window.clearInterval(interval);

  setMultiplayerActive(true);

  // creator enters game once someone joins
  clearTimers();
  resetGame();
  setSeatedRole((prev) => prev ?? "student");
  setScreen("game");
}

    } catch {
      // ignore transient network errors
    }
  }, 800);

  return () => {
    cancelled = true;
    window.clearInterval(interval);
  };
}, [screen, gamePin, joinMode]);

  const dealerSeat: Seat = useMemo(
    () => ((handId + dealerOffset) % 2 === 0 ? "top" : "bottom"),
    [handId, dealerOffset]
  );

  const nonDealerSeat: Seat = dealerSeat === "top" ? "bottom" : "top";

  const [handStartStacks, setHandStartStacks] = useState<{ top: number; bottom: number }>({
  top: STARTING_STACK_BB,
  bottom: STARTING_STACK_BB,
});

  // 0 = current hand, 1 = previous hand, 2 = two hands ago, etc.

  function generate4DigitPin() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

async function createPinGame() {
  let user: User;

  // ensure we have an authenticated (anonymous is OK) user
  try {
    const { data, error } = await supabase.auth.getUser();
    if (!error && data.user) {
      user = data.user;
    } else {
      const { data: anonData, error: anonErr } =
        await supabase.auth.signInAnonymously();
      if (anonErr || !anonData.user) throw anonErr;
      user = anonData.user;
    }
  } catch (e) {
    console.error("Auth failed:", e);
    alert("Could not start a guest session.");
    return;
  }

  // attempt to create a unique 4-digit PIN
  for (let attempt = 0; attempt < 12; attempt++) {
    const pin = generate4DigitPin();

    const { data: gameRow, error: gameErr } = await supabase
      .from("games")
      .insert({
        pin,
        created_by: user.id,
        status: "waiting",
      })
      .select("id,pin")
      .single();

    if (gameErr || !gameRow) {
      console.error("games.insert failed:", gameErr);
      continue; // try a different pin
    }

    const { error: playerErr } = await supabase
      .from("game_players")
      .insert({
        game_id: gameRow.id,
        user_id: user.id,
        seat: "bottom",
      });

    if (playerErr) {
      console.error("game_players.insert failed:", playerErr);
      alert("Failed to claim seat.");
      return;
    }

setJoinMode(false);
setJoinPinInput("");
setGamePin(gameRow.pin);

setGameId(gameRow.id);
setMySeat("bottom");
setMultiplayerActive(false);

// stay on title screen to show the PIN screen
return;  

  }

  alert("Failed to create game (PIN collision). Try again.");
}

async function getOrCreateUser() {
  const { data, error } = await supabase.auth.getUser();
  if (!error && data.user) return data.user;

  // If not logged in, create an anonymous user
  const { data: anonData, error: anonErr } = await supabase.auth.signInAnonymously();
  if (anonErr || !anonData.user) throw anonErr ?? new Error("Anonymous sign-in failed");

  return anonData.user;
}

async function joinPinGame() {
  const pin = joinPinInput.trim();
  if (pin.length !== 4) return;

 let user: User;
try {
  user = await getOrCreateUser();
} catch (e) {
  console.error("joinPinGame auth failed:", e);
  alert("Could not start a guest session.");
  return;
}

  const { data: gameRow, error: gameErr } = await supabase
    .from("games")
    .select("id,pin,status")
    .eq("pin", pin)
    .single();

  if (gameErr || !gameRow) return;

  // join as top seat
  const { error: playerErr } = await supabase.from("game_players").insert({
    game_id: gameRow.id,
    user_id: user.id,
    seat: "top",
  });

  if (playerErr) return;

  // mark game as active
  await supabase.from("games").update({ status: "active" }).eq("id", gameRow.id);

  setJoinMode(false);
setJoinPinInput("");
setGamePin(gameRow.pin);

setGameId(gameRow.id);
setMySeat("top");
setMultiplayerActive(true);

// enter the game screen + fresh reset
clearTimers();
resetGame();
setSeatedRole((prev) => prev ?? "student");
setScreen("game");
}

function clearPin() {
  setGamePin(null);
  setJoinMode(false);
  setJoinPinInput("");
  setIsCreatingPin(false);
  setCreatingGame(false);
}

function applyRemoteReset(p: {
  dealerOffset: 0 | 1;
  gameSession: number;
  handId: number;
  game: GameState;
}) {
  suppressMpRef.current = true;

  clearTimers();

  gameOverRef.current = false;
  setGameOver(false);
  setPlayAgainRequested(false);

  setDealerOffset(p.dealerOffset);

  setGame(p.game);
  gameRef.current = p.game;
  streetRef.current = 0;

  setHandResult({ status: "playing", winner: null, reason: null, message: "" });
  setActionLog([]);
  actionLogRef.current = [];
  setStreet(0);
  setChecked({ top: false, bottom: false });
  setLastAggressor(null);
  setLastToActAfterAggro(null);
  setActionsThisStreet(0);
  setSawCallThisStreet(false);
  setStreetBettor(null);
  setShowdownFirst(null);
  setOppRevealed(false);
  setYouMucked(false);

  setBetSize(2);
  setHandLogHistory([]);
  setLogViewOffset(0);

  setGameSession(p.gameSession);
  setHandId(p.handId);
  setDealerOffset(p.dealerOffset);
  blindsPostedRef.current = false;

  suppressMpRef.current = false;
}

  function clearTimers() {
    if (opponentTimerRef.current) {
      window.clearTimeout(opponentTimerRef.current);
      opponentTimerRef.current = null;
    }
    if (nextHandTimerRef.current) {
      window.clearTimeout(nextHandTimerRef.current);
      nextHandTimerRef.current = null;
    }
  }

  function triggerGameOverSequence() {
  if (gameOverRef.current) return;

  gameOverRef.current = true;
  setGameOver(true);
  clearTimers();

  if (multiplayerActive && isHost && !suppressMpRef.current) {
    mpSend({
      event: "SYNC",
      kind: "GAME_OVER",
    });
  }
}

  function snapshotCurrentHandLog() {
  const endedSt = endedStreetRef.current;

  setHandLogHistory((prev) => {
  const snap: HandLogSnapshot = {
  handNo: handId,
  dealer: dealerSeat,
  endedStreet: endedSt,
  endedBoard: board.slice(0, endedSt),
  log: actionLogRef.current,

  heroPos: dealerSeat === "bottom" ? "SB" : "BB",
  oppPos: dealerSeat === "top" ? "SB" : "BB",

  heroCards:
    RANK_TO_VALUE[youC!.rank] >= RANK_TO_VALUE[youD!.rank]
      ? [youC!, youD!]
      : [youD!, youC!],

  oppCards:
    RANK_TO_VALUE[oppA!.rank] >= RANK_TO_VALUE[oppB!.rank]
      ? [oppA!, oppB!]
      : [oppB!, oppA!],

  // Decide shown vs mucked from what actually got logged
  oppShown: (() => {
    const log = actionLogRef.current;
    const mucked = log.some((it) => it.seat === "top" && /muck/i.test(it.text));
    const showed = log.some((it) => it.seat === "top" && it.text.startsWith("Shows "));
    return showed && !mucked;
  })(),

  heroStartStack: handStartStacks.bottom,
  oppStartStack: handStartStacks.top,
};

    if (prev[0]?.handNo === snap.handNo) return prev;
    return [snap, ...prev].slice(0, 30);
  });
}

    /* deal cards each hand */
  useEffect(() => {
    if (!seatedRole) {
      setCards(null);
      return;
    }

    // single-player behavior
    if (!multiplayerActive) {
      setCards(drawUniqueCards(9));
      return;
    }

    // multiplayer: host deals + broadcasts, joiner waits for SYNC
    if (isHost) {
      const next = drawUniqueCards(9);
      setCards(next);
      mpSend({ event: "SYNC", kind: "DEAL", cards: next });
    }
  }, [seatedRole, handId, gameSession, multiplayerActive, isHost]);

  function logAction(seat: Seat, text: string, potOverride?: number) {
  const potNow =
    potOverride ??
    roundToHundredth(gameRef.current.pot + gameRef.current.bets.top + gameRef.current.bets.bottom);

  const lower = text.toLowerCase();

const shouldAppendPot =
  blindsPostedRef.current &&
  !lower.startsWith("posts") &&
  !lower.startsWith("shows") &&
  !lower.startsWith("split") &&
  !lower.startsWith("wins");

  const finalText = shouldAppendPot ? `${text} (${formatBB(potNow)}bb)` : text;

  const item: ActionLogItem = {
    id: uid(),
    street: streetNameFromCount(street),
    seat,
    text: finalText,
  };

  setActionLog((prev: ActionLogItem[]) => {
    const next = [...prev, item];
    actionLogRef.current = next;

    if (multiplayerActive && isHost && !suppressMpRef.current) {
      mpSend({
        event: "SYNC",
        kind: "LOG_ACTION",
        item,
      });
    }

    return next;
  });
}

  function resetStreetRound(nextStreet: Street) {
    setStreet(nextStreet);
setChecked({ top: false, bottom: false });
setLastAggressor(null);
setLastToActAfterAggro(null);
setActionsThisStreet(0);
setStreetBettor(null);
setSawCallThisStreet(false);
setLastRaiseSize(BB);

// HU rule: preflop first to act = dealer; postflop = non-dealer
const firstToAct = nextStreet === 0 ? dealerSeat : nonDealerSeat;
setToAct(firstToAct);

if (multiplayerActive && isHost && !suppressMpRef.current) {
mpSend({
event: "SYNC",
kind: "RESET_STREET",
nextStreet,
firstToAct,
  });
}
  }

  function pullBetsIntoPot() {
  setGame((prev: GameState) => {
    const next = {
      ...prev,
      pot: roundToHundredth(prev.pot + prev.bets.top + prev.bets.bottom),
      bets: { top: 0, bottom: 0 },
    };

    if (multiplayerActive && isHost && !suppressMpRef.current) {
      mpSend({
        event: "SYNC",
        kind: "PULL_BETS",
        game: next,
      });
    }

    return next;
  });
}

  function endHand(
  winner: Seat | "tie",
  reason: HandEndReason,
  message: string,
  showdownFirstOverride: Seat | null = null
) {
  // Always kill any pending timers first (especially auto-next-hand)
  clearTimers();

  const prev = gameRef.current;
  const fullPot = roundToHundredth(prev.pot + prev.bets.top + prev.bets.bottom);

  // Compute next stacks deterministically (no setState side effects)
  let nextStacks: GameState["stacks"];

  if (winner === "tie") {
    const half = roundToHundredth(fullPot / 2);
    nextStacks = {
      top: roundToHundredth(prev.stacks.top + half),
      bottom: roundToHundredth(prev.stacks.bottom + (fullPot - half)),
    };
  } else {
    nextStacks = {
      ...prev.stacks,
      [winner]: roundToHundredth(prev.stacks[winner] + fullPot),
    } as GameState["stacks"];
  }

  // Game is over if either stack is 0 (or below due to rounding)
  const shouldEndGame = nextStacks.top <= 0 || nextStacks.bottom <= 0;

  // Commit the chip state
  setGame({
    pot: 0,
    bets: { top: 0, bottom: 0 },
    stacks: nextStacks,
  });

  if (multiplayerActive && isHost && !suppressMpRef.current) {
    mpSend({
      event: "SYNC",
      kind: "END_HAND",
      stacks: nextStacks,
    });
  }

  // Mark hand ended + snapshot
  setHandResult({ status: "ended", winner, reason, message });

  if (multiplayerActive && isHost && !suppressMpRef.current) {
    mpSend({
      event: "SYNC",
      kind: "HAND_RESULT",
      handResult: { status: "ended", winner, reason, message },
    });
  }

  setTimeout(() => snapshotCurrentHandLog(), 0);

  // If this hand ends the match, freeze here.
  if (shouldEndGame) {
    gameOverRef.current = true; // immediate guard
    setGameOver(true);          // UI state
    clearTimers();              // extra safety

    if (multiplayerActive && isHost && !suppressMpRef.current) {
      mpSend({
        event: "SYNC",
        kind: "GAME_OVER",
      });
    }
  }
}

 function startNewHand() {
    // Don't start a new hand if game is over
    if (gameOverRef.current) return;

    if (multiplayerActive && isHost && !suppressMpRef.current) {
      mpSend({
        event: "SYNC",
        kind: "NEW_HAND",
      });
    }

allInCallThisHandRef.current = false;

    setHandResult({ status: "playing", winner: null, reason: null, message: "" });
    setActionLog([]);
    actionLogRef.current = [];
    setStreet(0);
    setChecked({ top: false, bottom: false });
    setLastAggressor(null);
    setLastToActAfterAggro(null);
    setActionsThisStreet(0);
    setBetSize(2);
    setStreetBettor(null);
    setShowdownFirst(null);
    setOppRevealed(false);
    setYouMucked(false);

    setSawCallThisStreet(false);

    setHandId((h) => {
      const next = h + 1;

      if (multiplayerActive && isHost && !suppressMpRef.current) {
        mpSend({
          event: "SYNC",
          kind: "SET_HAND_ID",
          handId: next,
        });
      }

      return next;
    });
  }

  function resetGame() {
    // reset stacks + randomize starting dealer + deal fresh hand
    clearTimers();

    gameOverRef.current = false;
    setGameOver(false);
    setPlayAgainRequested(false);

    const nextDealerOffset: 0 | 1 = Math.random() < 0.5 ? 0 : 1;
setDealerOffset(nextDealerOffset);

    const freshGame: GameState = {
  stacks: { top: STARTING_STACK_BB, bottom: STARTING_STACK_BB },
  bets: { top: 0, bottom: 0 },
  pot: 0,
};

setGame(freshGame);
gameRef.current = freshGame;
streetRef.current = 0;

    setHandResult({ status: "playing", winner: null, reason: null, message: "" });
    setActionLog([]);
    actionLogRef.current = [];
    setStreet(0);
    setChecked({ top: false, bottom: false });
    setLastAggressor(null);
    setLastToActAfterAggro(null);
    setActionsThisStreet(0);
    setSawCallThisStreet(false);
    setStreetBettor(null);
    setShowdownFirst(null);
    setOppRevealed(false);
    setYouMucked(false);

    setBetSize(2);
    setHandLogHistory([]);
    setLogViewOffset(0);

    setGameSession((s: number) => {
  const next = s + 1;

  if (multiplayerActive && isHost && !suppressMpRef.current) {
  mpSend({
  event: "SYNC",
  kind: "RESET",
  dealerOffset: nextDealerOffset,
  gameSession: next,
  handId: 0,
  game: freshGame,
});
}

  return next;
});

setHandId(0); // reset to Hand #1
blindsPostedRef.current = false;
allInCallThisHandRef.current = false;

  }

  function setBetSizeRounded(value: number | "") {
    if (value === "") {
      setBetSize("");
      return;
    }
    if (!Number.isFinite(value)) return;
    setBetSize(roundToHundredth(Math.max(0, value)));
  }

  const oppRaw1 = cards?.[0];
  const oppRaw2 = cards?.[1];

const [oppA, oppB] = useMemo(() => {
  if (!oppRaw1 || !oppRaw2) return [undefined, undefined] as const;
  const a = RANK_TO_VALUE[oppRaw1.rank];
  const b = RANK_TO_VALUE[oppRaw2.rank];
  return a >= b ? ([oppRaw1, oppRaw2] as const) : ([oppRaw2, oppRaw1] as const);
}, [oppRaw1, oppRaw2]);

  const youRaw1 = cards?.[2];
  const youRaw2 = cards?.[3];

  const [youC, youD] = useMemo(() => {
  if (!youRaw1 || !youRaw2) return [undefined, undefined] as const;
  const a = RANK_TO_VALUE[youRaw1.rank];
  const b = RANK_TO_VALUE[youRaw2.rank];
  return a >= b ? ([youRaw1, youRaw2] as const) : ([youRaw2, youRaw1] as const);
}, [youRaw1, youRaw2]);

  const board = cards ? cards.slice(4, 9) : [];

  const heroHandRank = useMemo(() => {
  if (!youC || !youD) return null;
  if (street === 0) return null; // only postflop
  const shownBoard = board.slice(0, street);
  const score = evaluate7([youC, youD, ...shownBoard]);
  return handRankOnly(score);
}, [youC, youD, board, street]);

  /* post blinds at start of each hand */
  useEffect(() => {
    if (!seatedRole) return;
    setHandStartStacks(gameRef.current.stacks);

    if (multiplayerActive && isHost && !suppressMpRef.current) {
      mpSend({
        event: "SYNC",
        kind: "HAND_START_STACKS",
        stacks: gameRef.current.stacks,
      });
    }

    // reset per-hand state
    setHandResult({ status: "playing", winner: null, reason: null, message: "" });
    allInCallThisHandRef.current = false;
    setActionLog([]);
    actionLogRef.current = [];
    setStreet(0);
    setChecked({ top: false, bottom: false });
    setLastAggressor(null);
    setLastToActAfterAggro(null);
    setSawCallThisStreet(false);
    setActionsThisStreet(0);
    setLastRaiseSize(BB);

    const topBlind = dealerSeat === "top" ? SB : BB;
    const bottomBlind = dealerSeat === "bottom" ? SB : BB;

    setGame((prev: GameState) => {
  const isLevelChangeHand = handId !== 0 && handId % 10 === 0; // hand 11, 21, 31...
  const mult = isLevelChangeHand ? 0.75 : 1;

  const topScaled = roundToHundredth(prev.stacks.top * mult);
  const bottomScaled = roundToHundredth(prev.stacks.bottom * mult);

  const nextGame = {
  pot: 0,
  bets: {
    top: roundToHundredth(topBlind),
    bottom: roundToHundredth(bottomBlind),
  },
  stacks: {
    top: roundToHundredth(Math.max(0, topScaled - topBlind)),
    bottom: roundToHundredth(Math.max(0, bottomScaled - bottomBlind)),
  },
};

  if (multiplayerActive && isHost && !suppressMpRef.current) {
    mpSend({
      event: "SYNC",
      kind: "POST_BLINDS",
      game: nextGame,
      toAct: dealerSeat,
    });
  }

  return nextGame;
});

    // who acts first preflop = dealer
    setToAct(dealerSeat);

    setTimeout(() => {
  blindsPostedRef.current = false;

  logAction(
    "top",
    dealerSeat === "top" ? `Posts SB ${formatBB(SB)}bb` : `Posts BB ${formatBB(BB)}bb`
  );
  logAction(
    "bottom",
    dealerSeat === "bottom" ? `Posts SB ${formatBB(SB)}bb` : `Posts BB ${formatBB(BB)}bb`
  );

  blindsPostedRef.current = true;

  if (multiplayerActive && isHost && !suppressMpRef.current) {
    mpSend({
      event: "SYNC",
      kind: "BLINDS_POSTED",
    });
  }
}, 0);

    setBetSize(2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seatedRole, handId, dealerSeat, gameSession]);

  const topLabel = dealerSeat === "top" ? "SB" : "BB";
  const bottomLabel = dealerSeat === "bottom" ? "SB" : "BB";

  const isBottomTurn = seatedRole && toAct === "bottom" && handResult.status === "playing";

 useEffect(() => {
  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    if (!(seatedRole && toAct === "bottom" && handResult.status === "playing")) return;

    const defaultTo =
      street === 0
        ? 2.5
        : roundToHundredth((game.pot + game.bets.top + game.bets.bottom) * 0.5);

    const size = betSize === "" ? defaultTo : betSize;

    dispatchAction({ type: "BET_RAISE_TO", to: size });
  }

  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}, [seatedRole, toAct, handResult.status, street, game.pot, game.bets.top, game.bets.bottom, betSize]);

  function currentFacingBet(seat: Seat) {
    const other: Seat = seat === "top" ? "bottom" : "top";
    return game.bets[other] > game.bets[seat];
  }

  function amountToCall(seat: Seat) {
    const other: Seat = seat === "top" ? "bottom" : "top";
    return roundToHundredth(Math.max(0, game.bets[other] - game.bets[seat]));
  }

  function canCheck(seat: Seat, g: GameState = gameRef.current, st: Street = streetRef.current) {
  const other: Seat = seat === "top" ? "bottom" : "top";

  if (st === 0 && g.bets[other] > g.bets[seat]) return false;

  return roundToHundredth(g.bets[other]) === roundToHundredth(g.bets[seat]);
}

  function settleIfStreetComplete() {
    if (handResult.status !== "playing") return;

    const equalBets = roundToHundredth(game.bets.top) === roundToHundredth(game.bets.bottom);

    if (lastAggressor) {
      if (equalBets && lastToActAfterAggro === null) {
        pullBetsIntoPot();

        if (multiplayerActive && isHost && !suppressMpRef.current) {
          mpSend({
            event: "SYNC",
            kind: "STREET_COMPLETE",
            street,
          });
        }

        if (street < 5) {
  const nextStreet: Street = street === 0 ? 3 : street === 3 ? 4 : 5;

  // If anyone is all-in postflop, run it out to the river immediately
  const someoneAllIn = (game.stacks.top <= 0 || game.stacks.bottom <= 0);

  if (someoneAllIn) {
    // show the full board
    setStreet(5);

    if (multiplayerActive && isHost && !suppressMpRef.current) {
      mpSend({
        event: "SYNC",
        kind: "ALL_IN_RUNOUT",
      });
    }

    // go straight to showdown
    resolveShowdown();

  } else {
    resetStreetRound(nextStreet);
  }
} else {
  // showdown (existing)
  resolveShowdown();

}

      }
      return;
    }

    const bothChecked = checked.top && checked.bottom;

// Preflop special: SB calls, BB checks => street ends immediately
const preflopCallThenCheckClosed =
  street === 0 &&
  sawCallThisStreet &&
  (checked.top || checked.bottom) &&
  equalBets;

// Postflop: either both checked, OR bet was called then the other checked (your old rule)
const postflopCallThenCheckClosed =
  street !== 0 &&
  sawCallThisStreet &&
  (checked.top || checked.bottom) &&
  actionsThisStreet >= 2;

// NEW: If a bet gets called and someone is all-in, end the street immediately (no check needed)
const allInCallClosed =
  sawCallThisStreet &&
  equalBets &&
  (game.stacks.top <= 0 || game.stacks.bottom <= 0);

if (
  (bothChecked || preflopCallThenCheckClosed || postflopCallThenCheckClosed || allInCallClosed) &&
  equalBets
) {
  pullBetsIntoPot();

  if (multiplayerActive && isHost && !suppressMpRef.current) {
    mpSend({
      event: "SYNC",
      kind: "STREET_COMPLETE",
      street,
    });
  }

  // NEW: if anyone is all-in, run it out to the river and resolve immediately
  if (game.stacks.top <= 0 || game.stacks.bottom <= 0) {
    setStreet(5);

    if (multiplayerActive && isHost && !suppressMpRef.current) {
      mpSend({
        event: "SYNC",
        kind: "ALL_IN_RUNOUT",
      });
    }

    resolveShowdown();
    return;
  }

    if (street < 5) {
    const nextStreet: Street = street === 0 ? 3 : street === 3 ? 4 : 5;
    resetStreetRound(nextStreet);
  } else {
    // River checked through (no betting): out-of-position shows first
    const noBetOnRiver = bothChecked && streetBettor === null;
    resolveShowdown(noBetOnRiver ? nonDealerSeat : null);
  }
}

  }

  function resolveShowdown(showdownFirstOverride: Seat | null = null) {
  const top7 = [oppA!, oppB!, ...board] as Card[];
  const bottom7 = [youC!, youD!, ...board] as Card[];

  const topScore = evaluate7(top7);
  const bottomScore = evaluate7(bottom7);
  const cmp = compareScore(bottomScore, topScore);

  endedStreetRef.current = 5;
  setEndedBoardSnapshot(5);

  if (multiplayerActive && isHost && !suppressMpRef.current) {
    mpSend({
      event: "SYNC",
      kind: "SET_ENDED_SNAPSHOT",
      endedBoardSnapshot: 5,
    });
  }

  // ✅ DEFINE THESE EARLY - BEFORE logAction calls
  const topBest5 = sortBest5ForDisplay(best5From7(top7));
  const bottomBest5 = sortBest5ForDisplay(best5From7(bottom7));

  // Show order logic
  const firstToShow: Seat = (showdownFirstOverride ?? streetBettor ?? nonDealerSeat) as Seat;
  const secondToShow: Seat = firstToShow === "top" ? "bottom" : "top";
  setShowdownFirst(firstToShow);

  const winner: Seat | "tie" = cmp > 0 ? "bottom" : cmp < 0 ? "top" : "tie";

  const secondShows = winner === "tie" || winner === secondToShow;

  const topShows = firstToShow === "top" || (secondToShow === "top" && secondShows);
  const bottomShows = firstToShow === "bottom" || (secondToShow === "bottom" && secondShows);

  if (multiplayerActive && isHost && !suppressMpRef.current) {
    mpSend({
      event: "SYNC",
      kind: "SHOWDOWN",
      topShows,
      bottomShows,
      winner,
    });
  }

  // Control face-up cards in the UI
  setOppRevealed(topShows);
  setYouMucked(!bottomShows);

  // NOW you can use topBest5 and bottomBest5 in logAction
  logAction(
    firstToShow,
    `Shows ${(firstToShow === "top" ? topBest5 : bottomBest5).map(cardStr).join("\u00A0")}`
  );

  if (secondShows) {
    logAction(
      secondToShow,
      `Shows ${(secondToShow === "top" ? topBest5 : bottomBest5).map(cardStr).join("\u00A0")}`
    );
  } else {
    logAction(secondToShow, secondToShow === "top" ? "Opponent mucked" : "You mucked");
  }

  const potTotal = formatBB(
    roundToHundredth(gameRef.current.pot + gameRef.current.bets.top + gameRef.current.bets.bottom)
  );

  if (winner === "bottom") {
    logAction("bottom", `Wins ${potTotal} BB ${bottomBest5.map(cardStr).join("\u00A0")}`);
    endHand("bottom", "showdown", `You win ${potTotal} BB`);
    return;
  }

  if (winner === "top") {
    logAction("top", `Wins ${potTotal} BB ${topBest5.map(cardStr).join("\u00A0")}`);
    endHand("top", "showdown", `Opponent wins ${potTotal} BB`);
    return;
  }

  const halfPot = formatBB(
    roundToHundredth(
      (gameRef.current.pot + gameRef.current.bets.top + gameRef.current.bets.bottom) / 2
    )
  );

  logAction("bottom", `Split pot ${halfPot} BB ${bottomBest5.map(cardStr).join("\u00A0")}`);
  endHand("tie", "showdown", `Split pot ${halfPot} BB`);
}

  function best5From7(all: Card[]) {
  let bestScore: number[] | null = null;
  let bestHand: Card[] = [];

  for (let a = 0; a < all.length - 4; a++) {
    for (let b = a + 1; b < all.length - 3; b++) {
      for (let c = b + 1; c < all.length - 2; c++) {
        for (let d = c + 1; d < all.length - 1; d++) {
          for (let e = d + 1; e < all.length; e++) {
            const hand = [all[a], all[b], all[c], all[d], all[e]];
            const score = evaluate7(hand);
            if (!bestScore || compareScore(score, bestScore) > 0) {
              bestScore = score;
              bestHand = hand;
            }
          }
        }
      }
    }
  }

  return bestHand;
}

function sortBest5ForDisplay(cards: Card[]) {
  const score = evaluate7(cards);
  const cat = score[0];

  const groups = new Map<number, Card[]>();
  for (const c of cards) {
    const v = RANK_TO_VALUE[c.rank];
    const arr = groups.get(v) ?? [];
    arr.push(c);
    groups.set(v, arr);
  }

  const take = (v: number) => {
    const arr = groups.get(v);
    if (!arr || arr.length === 0) return null;
    const c = arr.shift()!;
    if (arr.length === 0) groups.delete(v);
    return c;
  };

  const takeAll = (v: number) => {
    const arr = groups.get(v) ?? [];
    groups.delete(v);
    return arr;
  };

  // Straight / Straight Flush: show in sequence high->low; wheel = 5-4-3-2-A
  if (cat === 4 || cat === 8) {
    const high = score[1];
    const seq =
      high === 5
        ? [5, 4, 3, 2, 14]
        : [high, high - 1, high - 2, high - 3, high - 4];

    return seq.map((v) => take(v)!).filter(Boolean) as Card[];
  }

  // Quads
  if (cat === 7) {
    const quad = score[1];
    const kicker = score[2];
    return [...takeAll(quad), take(kicker)!].filter(Boolean) as Card[];
  }

  // Full House
  if (cat === 6) {
    const trips = score[1];
    const pair = score[2];
    return [...takeAll(trips), ...takeAll(pair)].filter(Boolean) as Card[];
  }

  // Flush (show high->low from score)
  if (cat === 5) {
    const vals = score.slice(1, 6);
    return vals.map((v) => take(v)!).filter(Boolean) as Card[];
  }

  // Trips
  if (cat === 3) {
    const trips = score[1];
    const kickers = score.slice(2);
    return [...takeAll(trips), ...kickers.map((v) => take(v)!)].filter(Boolean) as Card[];
  }

  // Two Pair
  if (cat === 2) {
    const highPair = score[1];
    const lowPair = score[2];
    const kicker = score[3];
    return [...takeAll(highPair), ...takeAll(lowPair), take(kicker)!].filter(Boolean) as Card[];
  }

  // One Pair
  if (cat === 1) {
    const pair = score[1];
    const kickers = score.slice(2);
    return [...takeAll(pair), ...kickers.map((v) => take(v)!)].filter(Boolean) as Card[];
  }

  // High Card
  const vals = score.slice(1, 6);
  return vals.map((v) => take(v)!).filter(Boolean) as Card[];
}

function cards5Str(cards5: Card[]) {
  return cards5.map(cardStr).join(" ");
}

  function actFold(seat: Seat) {
    if (handResult.status !== "playing") return;

    if (multiplayerActive && !suppressMpRef.current) {
    mpSend({ event: "ACTION", seat, action: { type: "FOLD" } });
  }

    const other: Seat = seat === "top" ? "bottom" : "top";

    if (multiplayerActive && isHost && !suppressMpRef.current) {
      mpSend({
        event: "SYNC",
        kind: "FOLD_END",
        winner: other,
        endedStreet: street,
      });
    }

    logAction(seat, "Folds");
    endedStreetRef.current = street;
    setEndedBoardSnapshot(street);

    if (multiplayerActive && isHost && !suppressMpRef.current) {
      mpSend({
        event: "SYNC",
        kind: "SET_ENDED_SNAPSHOT",
        endedBoardSnapshot: street,
      });
    }
    const potTotal = formatBB(
  roundToHundredth(game.pot + game.bets.top + game.bets.bottom)
);

logAction(
  other,
  `${other === "bottom" ? "You" : "Opponent"} wins ${potTotal}bb\n(no showdown)`
);

endHand(
  other,
  "fold",
  seat === "bottom" ? "You folded." : "Opponent folded."
);

  }

  function actCheck(seat: Seat) {
  if (handResult.status !== "playing") return;
  if (!canCheck(seat)) return;

  if (multiplayerActive && !suppressMpRef.current) {
    mpSend({ event: "ACTION", seat, action: { type: "CHECK" } });
  }

  logAction(seat, "Checks");
  setChecked((prev: { top: boolean; bottom: boolean }) => ({ ...prev, [seat]: true }));
  setActionsThisStreet((n: number) => n + 1);

  if (multiplayerActive && isHost && !suppressMpRef.current) {
    mpSend({
      event: "SYNC",
      kind: "SET_CHECKED",
      seat,
      actionsThisStreet: actionsThisStreet + 1,
    });
  }

    if (
  street === 0 &&
  sawCallThisStreet &&
  roundToHundredth(game.bets.top) === roundToHundredth(game.bets.bottom)
) {
  return;
}

const other: Seat = seat === "top" ? "bottom" : "top";

  if (multiplayerActive && isHost && !suppressMpRef.current) {
    mpSend({
      event: "SYNC",
      kind: "SET_TO_ACT",
      toAct: other,
    });
  }

setToAct(other);
  }

  function actCall(seat: Seat) {
  if (handResult.status !== "playing") return;

    if (multiplayerActive && !suppressMpRef.current) {
  mpSend({ event: "ACTION", seat, action: { type: "CALL" } });
}

    const toCall = amountToCall(seat);
    const add = roundToHundredth(Math.min(toCall, game.stacks[seat]));

    if (add <= 0) {
      if (canCheck(seat)) actCheck(seat);
      return;
    }

  setGame((prev: GameState) => {
  const other: Seat = seat === "top" ? "bottom" : "top";

  const seatStack = prev.stacks[seat];
  const otherStack = prev.stacks[other];

  const seatBet = prev.bets[seat];
  const otherBet = prev.bets[other];

  const toCallPrev = roundToHundredth(Math.max(0, otherBet - seatBet));
  const addPrev = roundToHundredth(Math.min(toCallPrev, seatStack));

  let newSeatStack = roundToHundredth(Math.max(0, seatStack - addPrev));
  let newSeatBet = roundToHundredth(seatBet + addPrev);

  let newOtherStack = otherStack;
  let newOtherBet = otherBet;

  // If caller couldn't fully call (all-in short), cap the bettor to the matched amount
  // and refund the unmatched remainder back to the bettor's stack.
  if (addPrev < toCallPrev) {
    const refund = roundToHundredth(Math.max(0, newOtherBet - newSeatBet));
    if (refund > 0) {
      newOtherBet = roundToHundredth(newOtherBet - refund);
      newOtherStack = roundToHundredth(newOtherStack + refund);
    }
  }

  return {
    ...prev,
    stacks: {
      ...prev.stacks,
      [seat]: newSeatStack,
      [other]: newOtherStack,
    } as GameState["stacks"],
    bets: {
      ...prev.bets,
      [seat]: newSeatBet,
      [other]: newOtherBet,
    } as GameState["bets"],
  };
});

const callerWillBeAllIn = roundToHundredth(game.stacks[seat] - add) <= 0;
const bettor = streetBettor;
const bettorSeat: Seat = seat === "top" ? "bottom" : "top";
const facingBeforeCall = currentFacingBet(seat);

if (
  facingBeforeCall &&
  (callerWillBeAllIn || game.stacks[bettorSeat] <= 0)
) {
  allInCallThisHandRef.current = true;

  if (multiplayerActive && isHost && !suppressMpRef.current) {
    mpSend({
      event: "SYNC",
      kind: "ALL_IN_CALL_FLAG",
    });
  }
}

if (street !== 0 && callerWillBeAllIn && bettor) {
  setShowdownFirst(bettor);

  if (multiplayerActive && isHost && !suppressMpRef.current) {
    mpSend({
      event: "SYNC",
      kind: "SET_SHOWDOWN_FIRST",
      showdownFirst: bettor,
    });
  }
}

    logAction(
  seat,
  `Calls ${formatBB(add)}bb`,
  roundToHundredth(game.pot + game.bets.top + game.bets.bottom + add)
);
    setSawCallThisStreet(true);
    setActionsThisStreet((n: number) => n + 1);

    if (multiplayerActive && isHost && !suppressMpRef.current) {
      mpSend({
        event: "SYNC",
        kind: "SAW_CALL",
        actionsThisStreet: actionsThisStreet + 1,
      });
    }

    if (lastToActAfterAggro === seat) {
      setLastToActAfterAggro(null);

      if (multiplayerActive && isHost && !suppressMpRef.current) {
        mpSend({
          event: "SYNC",
          kind: "CLEAR_LAST_TO_ACT",
        });
      }
    }

    // If this is a river call facing a bet, bettor must show first
if (street === 5 && currentFacingBet(seat)) {
  const bettor = streetBettor;
  if (bettor) {
    setShowdownFirst(bettor);

    if (multiplayerActive && isHost && !suppressMpRef.current) {
      mpSend({
        event: "SYNC",
        kind: "SET_SHOWDOWN_FIRST",
        showdownFirst: bettor,
      });
    }
  }
}

    const other: Seat = seat === "top" ? "bottom" : "top";

    if (multiplayerActive && isHost && !suppressMpRef.current) {
      mpSend({
        event: "SYNC",
        kind: "SET_TO_ACT",
        toAct: other,
      });
    }

    setToAct(other);
  }

  function actBetRaiseTo(seat: Seat, targetTotalBet: number) {
  if (handResult.status !== "playing") return;

    if (multiplayerActive && !suppressMpRef.current) {
    mpSend({ event: "ACTION", seat, action: { type: "BET_RAISE_TO", to: targetTotalBet } });
  }

  const other: Seat = seat === "top" ? "bottom" : "top";
  const curr = game.bets[seat];
  const otherBet = game.bets[other];

  const isFacing = otherBet > curr;

// NLHE:
// - If facing a bet, min raise-to = otherBet + lastRaiseSize
// - If not facing a bet, min bet = BB (or min raise over your own current bet)
    const minTarget = isFacing
    ? roundToHundredth(otherBet + lastRaiseSize)
    : roundToHundredth(curr + Math.max(BB, 0));

    const otherStack = game.stacks[other];
const otherCurr = game.bets[other];

// Effective max total bet = what the shorter stack can match
const effectiveMax = roundToHundredth(
  Math.min(
    curr + game.stacks[seat],
    otherCurr + otherStack
  )
);

const maxTarget = effectiveMax;

// If opponent is already all-in (or this action would only match the bet),
// this is NOT a raise — it is a call/all-in.
const isOnlyCalling =
  roundToHundredth(maxTarget) === roundToHundredth(otherBet);

// Final target logic:
// 1) If only calling → target = otherBet
// 2) Else if stacks cap below min raise → target = maxTarget
// 3) Else normal clamp
const target = roundToHundredth(
  isOnlyCalling
    ? otherBet
    : maxTarget < minTarget
    ? maxTarget
    : clamp(targetTotalBet, minTarget, maxTarget)
);

// If the target equals the opponent's bet, that's a CALL (not a raise).
if (isFacing && roundToHundredth(target) === roundToHundredth(otherBet)) {
  actCall(seat);
  return;
}

    const add = roundToHundredth(Math.max(0, target - curr));
    if (add <= 0) return;

    setGame((prev) => ({
      ...prev,
      stacks: {
        ...prev.stacks,
        [seat]: roundToHundredth(Math.max(0, prev.stacks[seat] - add)),
      } as GameState["stacks"],
      bets: {
        ...prev.bets,
        [seat]: roundToHundredth(prev.bets[seat] + add),
      } as GameState["bets"],
    }));

    const newRaiseSize = isFacing
    ? roundToHundredth(target - otherBet)
    : roundToHundredth(target - curr);

    setLastRaiseSize(newRaiseSize);

    logAction(
  seat,
  otherBet > curr ? `Raises to ${formatBB(target)}bb` : `Bets ${formatBB(target)}bb`,
  roundToHundredth(game.pot + game.bets.top + game.bets.bottom + add)
);

    setStreetBettor(seat);

    setActionsThisStreet((n: number) => n + 1);
    setChecked({ top: false, bottom: false });

    setLastAggressor(seat);
    setLastToActAfterAggro(other);

    if (multiplayerActive && isHost && !suppressMpRef.current) {
      mpSend({
        event: "SYNC",
        kind: "SET_AGGRESSOR",
        lastAggressor: seat,
        lastToActAfterAggro: other,
        actionsThisStreet: actionsThisStreet + 1,
        lastRaiseSize: newRaiseSize,
        streetBettor: seat,
      });
    }

    if (multiplayerActive && isHost && !suppressMpRef.current) {
      mpSend({
        event: "SYNC",
        kind: "SET_TO_ACT",
        toAct: other,
      });
    }

    setToAct(other);
  }

    type GameAction =
    | { type: "FOLD" }
    | { type: "CHECK" }
    | { type: "CALL" }
    | { type: "BET_RAISE_TO"; to: number };

  function dispatchAction(action: GameAction) {
  const seat: Seat = mySeat;

  if (handResult.status !== "playing") return;
  if (gameOverRef.current) return;
  if (toAct !== seat) return; // ignore clicks while opponent is thinking

  if (multiplayerActive) {
  applyActionFromSeat(seat, action);
  return;
}

  switch (action.type) {
    case "FOLD":
      actFold(seat);
      return;

    case "CHECK":
      actCheck(seat);
      return;

    case "CALL":
      actCall(seat);
      return;

    case "BET_RAISE_TO":
      actBetRaiseTo(seat, action.to);
      return;

    default:
      return;
  }
}

  /* ---------- opponent random behavior ---------- */

  function pickOpponentBetSize(st: Street) {
    const g = gameRef.current;
    const potNow = roundToHundredth(g.pot + g.bets.top + g.bets.bottom);


    if (st === 0) {
      const options = [2.5, 3, 4, 5];
      return options[Math.floor(Math.random() * options.length)];
    }

    const fractions = [0.33, 0.5, 0.75];
    const f = fractions[Math.floor(Math.random() * fractions.length)];
    const desiredAdd = roundToHundredth(potNow * f);

    return roundToHundredth(game.bets.top + desiredAdd);
  }

  function opponentAct() {
  if (multiplayerActive) return;

  if (handResult.status !== "playing") return;
  if (toAct !== "top") return;

  const tooMany = actionsThisStreet >= 4;
  const st = street;

  // Use latest game state (avoids stale reads that caused illegal "Checks")
  const g = gameRef.current;
  if (streetRef.current === 0 && (g.bets.top === 0 || g.bets.bottom === 0)) return;

 const callAmt = roundToHundredth(Math.max(0, g.bets.bottom - g.bets.top));
  const facing = callAmt > 0;

  // If not facing a bet, opponent may check or bet
  if (!facing) {
 
  const r = Math.random();
  if (tooMany || r < 0.62) {
    actCheck("top");
    return;
  }

  actBetRaiseTo("top", pickOpponentBetSize(st));
  return;
}

  // Facing a bet: opponent must fold / call / raise (NO checking)
  const potNow = roundToHundredth(g.pot + g.bets.top + g.bets.bottom);
  const pressure = potNow > 0 ? clamp(callAmt / potNow, 0, 1) : 0.25;

  const foldP = clamp(0.12 + pressure * 0.35, 0.05, 0.55);
  const raiseP = tooMany ? 0 : clamp(0.18 - pressure * 0.1, 0.06, 0.22);

  const r = Math.random();
  if (r < foldP) {
    actFold("top");
    return;
  }

  if (r < foldP + raiseP) {
    const curr = g.bets.top;
    const otherBet = g.bets.bottom;

    const minRaiseTo = roundToHundredth(otherBet + lastRaiseSize);
    const target = pickOpponentBetSize(st);

    actBetRaiseTo("top", Math.max(target, minRaiseTo));
    return;
  }

  actCall("top");
}

  // opponent takes 10 seconds per decision
  useEffect(() => {
    if (!seatedRole) return;
    if (handResult.status !== "playing") return;
    if (toAct !== "top") return;
    if (!aiEnabled || gamePin) return;

    if (opponentTimerRef.current) window.clearTimeout(opponentTimerRef.current);
opponentTimerRef.current = window.setTimeout(() => {
  opponentAct();

  // If AI was toggled OFF mid-opponent-turn, let this be the last action,
  // then force AI OFF.
  if (pendingAiOffRef.current) {
    pendingAiOffRef.current = false;
    setAiEnabled(false);
  }
}, 1000);
 
    return () => {
      if (opponentTimerRef.current) window.clearTimeout(opponentTimerRef.current);
      opponentTimerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
}, [toAct, handResult.status, street, seatedRole, game.bets.top, game.bets.bottom, aiEnabled]);

  // settle / advance street
  useEffect(() => {
    if (!seatedRole) return;
    if (handResult.status !== "playing") return;
    settleIfStreetComplete();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    game.bets.top,
    game.bets.bottom,
    checked.top,
    checked.bottom,
    lastAggressor,
    lastToActAfterAggro,
  ]);

  useEffect(() => {
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "ArrowLeft") {
      setLogViewOffset((prev) =>
        Math.min(prev + 1, handLogHistory.length)
      );
    }

    if (e.key === "ArrowRight") {
      setLogViewOffset((prev) =>
        Math.max(prev - 1, 0)
      );
    }
  }

  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}, [handLogHistory.length]);

 // auto next hand 5 seconds after hand ends
useEffect(() => {
  if (handResult.status !== "ended") return;

  if (gameOverRef.current) {
    if (nextHandTimerRef.current) {
      window.clearTimeout(nextHandTimerRef.current);
      nextHandTimerRef.current = null;
    }
    return;
  }

  if (nextHandTimerRef.current) window.clearTimeout(nextHandTimerRef.current);
  nextHandTimerRef.current = window.setTimeout(() => {
    startNewHand();
  }, 5000);

  return () => {
    if (nextHandTimerRef.current) {
      window.clearTimeout(nextHandTimerRef.current);
      nextHandTimerRef.current = null;
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [handResult.status]);

/* ---------- title screen ---------- */

if (screen === "role") {
  const baseButton =
    "w-full rounded-3xl border px-6 font-semibold transition-colors duration-200 hover:bg-gray-50 hover:border-gray-300";

  const titleBusy = creatingGame || isCreatingPin;
  const disabledLinkClass = "opacity-40 cursor-not-allowed pointer-events-none";

const createGame = async () => {
  if (creatingGame) return;

  setCreatingGame(true);
  try {
    clearTimers();
    setJoinMode(false);
    setJoinPinInput("");

    await createPinGame();
  } finally {
    setCreatingGame(false);
  }
};

const joinGame = () => {
  if (isCreatingPin) return;

  clearTimers();
  setGamePin(null);
  setJoinMode(true);
  setJoinPinInput("");
};

  const clearPin = () => {
  setGamePin(null);
  setJoinMode(false);
  setJoinPinInput("");
};

  return (
    <main className="relative flex min-h-screen items-center justify-center px-6">

    <div
  className={`absolute top-6 right-6 flex items-center gap-4 ${
    titleBusy ? "opacity-30 pointer-events-none" : ""
  }`}
>
  {studentProfile.firstName && studentProfile.lastName && !gamePin ? (
  <>
    <div className="relative">
      <button
        type="button"
        onClick={() => setStudentMenuOpen((o) => !o)}
        className="text-sm font-semibold text-white underline opacity-90 hover:opacity-100"
      >
        {studentProfile.firstName} {studentProfile.lastName}
      </button>

      {studentMenuOpen && (
        <div className="absolute right-0 mt-2 w-40 rounded-xl border bg-white shadow-md">
          <button
            type="button"

            onClick={() => {
  setStudentMenuOpen(false);
  resetGame();

  setOtherStudents([]);
  setOtherProfessionals([]);

  setStudentProfile({
    firstName: "",
    lastName: "",
    email: "",
    password: "",
    year: "",
    major: "",
    company: "",
    workTitle: "",
  });
  setSeatedRole(null);
  setScreen("role");
}}

            className="w-full flex items-center px-4 py-2 text-left text-sm font-semibold text-black hover:bg-gray-100"
          >
            Log out
          </button>
        </div>
      )}
    </div>

    {!gamePin && (
  <button
    type="button"
    onClick={() =>
      setScreen(
        seatedRole === "professional"
          ? "professionalDashboard"
          : "dashboard"
      )
    }
    className="text-sm font-semibold text-white underline opacity-80 hover:opacity-100"
  >
    Dashboard
  </button>
)}

  </>
) : (
  !gamePin ? (
    <>
      <button
        type="button"
        onClick={() => {
          clearTimers();
          setScreen("studentLogin");
        }}
        className="text-sm font-semibold text-white underline opacity-80 hover:opacity-100"
      >
        Log in
      </button>

      <button
        type="button"
        onClick={() => {
          clearTimers();

          setOtherStudents([]);
          setOtherProfessionals([]);

          setSeatedRole(null);
          setScreen("studentProfile");
        }}
        className="text-sm font-semibold text-white underline opacity-80 hover:opacity-100"
      >
        Sign up
      </button>
    </>
  ) : null
)}

  {!gamePin && (
  <button
    type="button"
    onClick={() => {
      clearTimers();
      resetGame();
      setSeatedRole((prev) => prev ?? "student");
      setScreen("game");
    }}
    className="text-sm font-semibold text-white underline opacity-80 hover:opacity-100"
  >
    Go to game
  </button>
)}
</div>

      <div className="w-full max-w-xl flex flex-col">
        <h1 className="h-[44px] mb-8 text-center text-3xl font-bold leading-[44px]">
          TEMP TITLE
        </h1>

      <div className="h-[220px] flex flex-col justify-start">

    {/* CREATE GAME PIN VIEW */}
{gamePin && !joinMode && (
  <div className="flex flex-col items-center gap-6">
    <div className="text-lg font-semibold tabular-nums">
      Game PIN: <span className="font-bold">{gamePin}</span>
    </div>

    <button
      onClick={clearPin}
      className={`${baseButton} py-4 text-base max-w-sm`}
    >
      Back
    </button>
  </div>
)}

  {/* JOIN GAME INPUT VIEW */}
  {!gamePin && joinMode && (
    <div className="flex flex-col items-center gap-6">
      <input
        type="text"
        inputMode="numeric"
        maxLength={4}
        value={joinPinInput}
        onChange={(e) =>
          setJoinPinInput(e.target.value.replace(/\D/g, ""))
        }
        placeholder="Enter Game PIN"
        className="w-full max-w-xs rounded-xl border px-4 py-3 text-center text-lg tracking-widest tabular-nums"
      />

      <button
  onClick={joinPinGame}
  disabled={joinPinInput.length !== 4}
  className={`${baseButton} py-4 text-base max-w-sm ${
    joinPinInput.length !== 4 ? "opacity-50 pointer-events-none" : ""
  }`}
>
  Join game
</button>

<button
  onClick={clearPin}
  className={`${baseButton} py-4 text-base max-w-sm`}
>
  Back
</button>
    </div>
  )}

  {/* DEFAULT TITLE SCREEN BUTTONS */}
  {!gamePin && !joinMode && (
    <div className="flex flex-col gap-4">
      <button
  type="button"
  onClick={createGame}
  disabled={creatingGame}
  className={`
    ${baseButton}
    py-10
    text-xl
    ${creatingGame
      ? "opacity-60 cursor-not-allowed pointer-events-none"
      : ""}
  `}
>
  {creatingGame ? "Creating..." : "Create Game"}
</button>

      <button
  onClick={joinGame}
  disabled={creatingGame}
  className={`
    ${baseButton}
    py-10
    text-xl
    ${creatingGame ? "opacity-60 cursor-not-allowed pointer-events-none" : ""}
  `}
>
  Join Game
</button>
    </div>
  )}
</div>
      </div>
    </main>
  );
}


/* ---------- Sign Up setup ---------- */

if (screen === "studentProfile") {
  return (
    <main className="relative flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-md">
        <h1 className="mb-6 text-center text-3xl font-bold">Sign up</h1>

<div className="mb-6 flex gap-3">
  <button
  type="button"
  onClick={() => setSeatedRole("student")}
  className={`flex-1 rounded-2xl border px-4 py-3 text-sm font-semibold transition-colors hover:bg-gray-50 ${
    seatedRole === "student" ? "border-white bg-white/10" : ""
  }`}
>
  Student
</button>

  <button
  type="button"
  onClick={() => setSeatedRole("professional")}
  className={`flex-1 rounded-2xl border px-4 py-3 text-sm font-semibold transition-colors hover:bg-gray-50 ${
    seatedRole === "professional" ? "border-white bg-white/10" : ""
  }`}
>
  Professional
</button>
</div>

        <div className="flex flex-col gap-4">
          <input
            type="text"
            placeholder="First name"
            value={studentProfile.firstName}
            onChange={(e) =>
              setStudentProfile({ ...studentProfile, firstName: e.target.value })
            }
            className="rounded-xl border px-4 py-3 text-sm"
          />

          <input
            type="text"
            placeholder="Last name"
            value={studentProfile.lastName}
            onChange={(e) =>
              setStudentProfile({ ...studentProfile, lastName: e.target.value })
            }
            className="rounded-xl border px-4 py-3 text-sm"
          />

          <input
  type="email"
  placeholder="Email"
  value={studentProfile.email}
  onChange={(e) =>
    setStudentProfile({ ...studentProfile, email: e.target.value })
  }
  className="rounded-xl border px-4 py-3 text-sm"
/>

<input
  type="password"
  placeholder="Password"
  value={studentProfile.password}
  onChange={(e) =>
    setStudentProfile({ ...studentProfile, password: e.target.value })
  }
  className="rounded-xl border px-4 py-3 text-sm"
/>

{seatedRole === "student" && (
  <>
    <input
      type="text"
      placeholder="Year"
      value={studentProfile.year}
      onChange={(e) =>
        setStudentProfile({ ...studentProfile, year: e.target.value })
      }
      className="rounded-xl border px-4 py-3 text-sm"
    />

    <input
      type="text"
      placeholder="Major"
      value={studentProfile.major}
      onChange={(e) =>
        setStudentProfile({ ...studentProfile, major: e.target.value })
      }
      className="rounded-xl border px-4 py-3 text-sm"
    />
  </>
)}

{seatedRole === "professional" && (
  <>
    <input
      type="text"
      placeholder="Company"
      value={studentProfile.company || ""}
      onChange={(e) =>
        setStudentProfile({ ...studentProfile, company: e.target.value })
      }
      className="rounded-xl border px-4 py-3 text-sm"
    />

    <input
      type="text"
      placeholder="Work title"
      value={studentProfile.workTitle || ""}
      onChange={(e) =>
        setStudentProfile({ ...studentProfile, workTitle: e.target.value })
      }
      className="rounded-xl border px-4 py-3 text-sm"
    />
  </>
)}

          <button
  type="button"
  disabled={!seatedRole}
  onClick={() => {
    if (seatedRole === "student") {
      setOtherStudents((prev) => [studentProfile, ...prev]);
    } else {
      setOtherProfessionals((prev) => [studentProfile, ...prev]);
    }
    setScreen("role");
  }}
  className={`mt-4 rounded-2xl border px-4 py-3 text-sm font-semibold transition-colors ${
    seatedRole ? "hover:bg-gray-50" : "opacity-50 cursor-not-allowed"
  }`}
>
  Continue
</button>
        </div>
      </div>
    </main>
  );
}

/* ---------- student login ---------- */

if (screen === "studentLogin") {
  return (
    <main className="relative flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-md">
        <h1 className="mb-6 text-center text-3xl font-bold">Log in</h1>

        <div className="flex flex-col gap-4">
          <input
            type="email"
            placeholder="Email"
            value={loginEmail}
            onChange={(e) => setLoginEmail(e.target.value)}
            className="rounded-xl border px-4 py-3 text-sm"
          />

          <input
            type="password"
            placeholder="Password"
            value={loginPassword}
            onChange={(e) => setLoginPassword(e.target.value)}
            className="rounded-xl border px-4 py-3 text-sm"
          />

          <button
            type="button"
            onClick={() => {
              setScreen("role");
            }}
            className="mt-4 rounded-2xl border px-4 py-3 text-sm font-semibold hover:bg-gray-50"
          >
            Continue
          </button>
        </div>
      </div>
    </main>
  );
}

/* ---------- student dashboard ---------- */

if (screen === "dashboard" && seatedRole === "student") {
  const baseButton =
    "w-full rounded-3xl border px-6 font-semibold transition-colors duration-200 hover:bg-gray-50 hover:border-gray-300";

  return (
    <main className="flex min-h-screen justify-center px-6 pt-16">
  <div className="w-full max-w-[96rem]">
       <div className="mb-2 flex items-center justify-center gap-4">
  <h1 className="text-3xl font-bold">Student dashboard</h1>

  <button
  type="button"
  onClick={() => {
    resetGame();
    setScreen("game");
  }}
  className="rounded-xl border px-4 py-1.5 text-sm font-semibold transition-colors hover:bg-gray-50"
>
  Join table
</button>

  <button
    type="button"
    onClick={() => setScreen("role")}
    className="rounded-xl border px-4 py-1.5 text-sm font-semibold transition-colors hover:bg-gray-50"
  >
    Title screen
  </button>
</div>

        <p className="mb-8 text-center text-sm text-black/60">
          Same aesthetic for now — we’ll plug in real widgets next.
        </p>

        <div className="grid gap-4">
          <div className="rounded-3xl border bg-white p-6 w-full px-10">

  <div className="grid grid-cols-2 gap-6">
  <div className="text-xs font-semibold uppercase tracking-wide text-black/50">
  Other students
</div>

<div className="text-xs font-semibold uppercase tracking-wide text-black/50">
  Professionals
</div>

    {/* ---------- Students column ---------- */}
    
    <div className="flex flex-col gap-3">
  <button
    className="w-full rounded-2xl border border-black bg-white px-5 py-4 font-semibold text-black transition-colors hover:bg-gray-50"
  >
    Browse students
  </button>

  <div className="max-h-[70vh] overflow-y-auto pr-4 flex flex-col gap-3">
    {otherStudents.map((s, i) => (
  <div
    key={i}
    className="w-full rounded-2xl border border-black bg-white px-5 py-4 font-semibold text-black flex items-center justify-between"
  >
    <span>
      {s.firstName} {" • "} {s.lastName} {" • "}
      {s.year} {" • "}
      {s.major}
    </span>

    {i > 0 && (
      <button className={connectButtonClass}>
        Connect
      </button>
    )}
  </div>
))}
  </div>
</div>

    {/* ---------- Professionals column ---------- */}
    
    <div className="flex flex-col gap-3">
  <button
    className="w-full rounded-2xl border border-black bg-white px-5 py-4 font-semibold text-black transition-colors hover:bg-gray-50"
  >
    View professionals
  </button>

  <div className="max-h-[70vh] overflow-y-auto pr-4 flex flex-col gap-3">
    {otherProfessionals.map((p, i) => (
  <div
    key={i}
    className="w-full rounded-2xl border border-black bg-white px-5 py-4 font-semibold text-black flex items-center justify-between"
  >
    <span>
      {p.firstName} {p.lastName} {" • "}
      {p.company} {" • "}
      {p.workTitle}
    </span>

    <button className={connectButtonClass}>
      Connect
    </button>
  </div>
))}

  </div>
</div>

  </div>
</div>

        </div>
      </div>
    </main>
  );
}

/* ---------- professional dashboard ---------- */

if (screen === "professionalDashboard" && seatedRole === "professional") {
  const baseButton =
    "w-full rounded-3xl border px-6 font-semibold transition-colors duration-200 hover:bg-gray-50 hover:border-gray-300";

  return (
    <main className="flex min-h-screen justify-center px-6 pt-16">
  <div className="w-full max-w-[96rem]">
       <div className="mb-2 flex items-center justify-center gap-4">
  <h1 className="text-3xl font-bold">Professional Dashboard</h1>

  <button
  type="button"
  onClick={() => {
    resetGame();
    setScreen("game");
  }}
  className="rounded-xl border px-4 py-1.5 text-sm font-semibold transition-colors hover:bg-gray-50"
>
  Join table
</button>

  <button
    type="button"
    onClick={() => setScreen("role")}
    className="rounded-xl border px-4 py-1.5 text-sm font-semibold transition-colors hover:bg-gray-50"
  >
    Title screen
  </button>
</div>

        <p className="mb-8 text-center text-sm text-black/60">
          Same aesthetic for now — we’ll plug in real widgets next.
        </p>

        <div className="grid gap-4">
          <div className="rounded-3xl border bg-white p-6 w-full px-10">

  <div className="grid grid-cols-2 gap-6">
  <div className="text-xs font-semibold uppercase tracking-wide text-black/50">
  Other Professionals
</div>

<div className="text-xs font-semibold uppercase tracking-wide text-black/50">
  Students
</div>

    {/* ---------- ProfD Professionals column ---------- */}
<div className="flex flex-col gap-3">
  <button
    className="w-full rounded-2xl border border-black bg-white px-5 py-4 font-semibold text-black transition-colors hover:bg-gray-50"
  >
    View Professionals
  </button>

  <div className="max-h-[70vh] overflow-y-auto pr-2 flex flex-col gap-3">
    {otherProfessionals.map((p, i) => (
  <div
    key={i}
    className="w-full rounded-2xl border border-black bg-white px-5 py-4 font-semibold text-black flex items-center justify-between"
  >
    <span>
      {p.firstName} {p.lastName} {" • "}
      {p.company} {" • "}
      {p.workTitle}
    </span>

    {i > 0 && (
      <button className={connectButtonClass}>
        Connect
      </button>
    )}
  </div>
))}

  </div>
</div>

    {/* ---------- ProfD Students column ---------- */}
<div className="flex flex-col gap-3">
  <button
    className="w-full rounded-2xl border border-black bg-white px-5 py-4 font-semibold text-black transition-colors hover:bg-gray-50"
  >
    Browse Students
  </button>

  <div className="max-h-[70vh] overflow-y-auto pr-2 flex flex-col gap-3">
    {otherStudents.map((s, i) => (
  <div
    key={i}
    className="w-full rounded-2xl border border-black bg-white px-5 py-4 font-semibold text-black flex items-center justify-between"
  >
    <span>
      {s.firstName} {s.lastName} {" • "}
      {s.year} {" • "}
      {s.major}
    </span>

    <button className={connectButtonClass}>
      Connect
    </button>
  </div>
))}

  </div>
</div>
  </div>
</div>

        </div>
      </div>
    </main>
  );
}

  /* ---------- game view ---------- */

  if (screen !== "game" || !seatedRole) return null;

  const dealerChipTop =
    "absolute -bottom-3 -right-3 flex h-10 w-10 items-center justify-center rounded-full border bg-white text-[20px] font-bold text-black shadow-sm";
  const dealerChipBottom =
    "absolute -top-3 -left-3 flex h-10 w-10 items-center justify-center rounded-full border bg-white text-[20px] font-bold text-black shadow-sm";

  const streetLabel = streetNameFromCount(street);

  const facingBetBottom = currentFacingBet("bottom");
  const bottomCallAmt = amountToCall("bottom");

  const bottomMaxTo = roundToHundredth(game.stacks.bottom + game.bets.bottom);

  const defaultTo =
    street === 0
      ? 2.5
      : roundToHundredth((game.pot + game.bets.top + game.bets.bottom) * 0.5);

  const safeBetSize = betSize === "" ? defaultTo : betSize;

const viewingSnapshot =
  logViewOffset === 0 ? null : handLogHistory[logViewOffset - 1];

  const heroPosLabel = viewingSnapshot
  ? viewingSnapshot.heroPos
  : dealerSeat === "bottom" ? "SB/D" : "BB";

const oppPosLabel = viewingSnapshot
  ? viewingSnapshot.oppPos
  : dealerSeat === "top" ? "SB/D" : "BB";

const displayedActionLog = viewingSnapshot ? viewingSnapshot.log : actionLog;

const displayedHistoryBoard = viewingSnapshot
  ? viewingSnapshot.endedBoard
  : [];

  return (
    <>

<ConfirmModal
  open={showResetConfirm}
  title="Reset game?"
  message="Are you sure? Stack sizes will be reset and the starting position will also reset."
  cancelText="Go back"
  confirmText="Reset game"
  onCancel={() => setShowResetConfirm(false)}
  onConfirm={() => {
    setShowResetConfirm(false);
    resetGame();
  }}
/>

      <main className="relative flex min-h-screen items-center justify-center px-6">

      {gameOver && !playAgainRequested && (
  <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50">
    <button
      onClick={() => setPlayAgainRequested(true)}
      className="rounded-2xl border border-black bg-white px-6 py-2 text-sm font-semibold text-black shadow-sm hover:bg-gray-50"
    >
      Play Again?
    </button>
  </div>
)}

{gameOver && playAgainRequested && (
  <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 rounded-2xl border border-black bg-white px-6 py-2 text-sm font-semibold text-black shadow-sm">
    Invited &quot;Opponent&quot; to play again, waiting for &quot;Opponent&apos;s&quot; response...
  </div>
)}


      {blindNotice && !gameOver ? (
  <div className="absolute top-6 left-1/2 -translate-x-1/2 text-sm font-semibold text-white">
    {blindNotice}
  </div>
) : null}
        <div className="w-full max-w-6xl">
          <div className="mb-6 flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-white">TEMP TITLE</h1>
              <div className="text-sm text-white opacity-80 tabular-nums">
                Pot: {formatBB(roundToHundredth(game.pot + game.bets.top + game.bets.bottom))}{" "}
                BB <span className="opacity-60">·</span> {streetLabel}{" "}
                <span className="opacity-60">·</span>{" "}
                <span className="opacity-90">
  {handResult.status === "playing"
    ? toAct === "bottom"
      ? "Your turn"
      : "Opponent thinking…"
    : gameOver
      ? (game.stacks.bottom <= 0
          ? "Game over — Opponent wins"
          : "Game over — You win")
      : "Hand ended (next hand in 5s)"}
</span>
              </div>
              {handResult.message ? (
                <div className="mt-1 text-sm text-white opacity-90">{handResult.message}</div>
              ) : null}
            </div>

            <div className="flex items-center gap-4">
  <button
    type="button"
    onClick={() => setShowResetConfirm(true)}
    className="text-sm text-white underline opacity-80 hover:opacity-100"
  >
    Reset game
  </button>

  {studentProfile.email && !gamePin && (
  <button
    type="button"
    onClick={() =>
      setScreen(seatedRole === "professional" ? "professionalDashboard" : "dashboard")
    }
    className="text-sm text-white underline opacity-80 hover:opacity-100"
  >
    Dashboard
  </button>
)}

  <button
    type="button"
    onClick={() => {
  clearTimers();                 // stop opponent + next-hand timers
  setOtherStudents([]);          // wipe mock students
  setOtherProfessionals([]);     // wipe mock professionals
  setScreen("role");             // go back to title screen
}}
    className="text-sm text-white underline opacity-80 hover:opacity-100"
  >
    Title screen
  </button>

<button
  type="button"
  disabled={!!gamePin}
  onClick={() => {
    if (gamePin) return;

    // If turning AI OFF
    if (aiEnabled) {
      const opponentTurn = handResult.status === "playing" && toAct === "top";

      if (opponentTurn) {
        pendingAiOffRef.current = true;
        return;
      }

      pendingAiOffRef.current = false;
      clearTimers();
      setAiEnabled(false);
      return;
    }

    pendingAiOffRef.current = false;
    clearTimers();
    setAiEnabled(true);
  }}
  className={`text-sm text-white underline opacity-80 hover:opacity-100 ${
    gamePin ? "opacity-40 cursor-not-allowed pointer-events-none" : ""
  }`}
>
  AI: {aiEnabled ? "ON" : "OFF"}
</button>

</div>
          </div>

          {/* ACTION LOG pinned left + TABLE centered */}
          <div className="relative mt-6 w-full">
            {/* LEFT: ACTION LOG */}
<div className="absolute -left-54 top-0 w-[500px] rounded-3xl border border-white/10 bg-black/20 p-4 text-white text-left">
 {/* Header row (matches your target screenshot) */}
<div className="mb-6 relative flex w-full items-center gap-4">
  {/* arrows */}
  <div className="flex items-center gap-2 shrink-0">
    <button
      type="button"
      className="rounded border border-white/20 bg-white/10 px-2 py-0.5 text-xs hover:bg-white/20"
      onClick={() => setLogViewOffset((o) => Math.min(o + 1, handLogHistory.length))}
    >
      ◀
    </button>

    <button
      type="button"
      className="rounded border border-white/20 bg-white/10 px-2 py-0.5 text-xs hover:bg-white/20"
      onClick={() => setLogViewOffset((o) => Math.max(o - 1, 0))}
    >
      ▶
    </button>
  </div>

  {/* Action + stacks: glued right after arrows */}
  <div className="flex items-baseline gap-3 min-w-0">
    <div className="text-sm font-semibold text-white whitespace-nowrap">Action</div>

    <div className="text-xs font-normal text-white/70 tabular-nums whitespace-nowrap">
      {viewingSnapshot
        ? `You (${viewingSnapshot.heroPos}) ${formatBB(viewingSnapshot.heroStartStack)}bb · Opponent (${viewingSnapshot.oppPos}) ${formatBB(viewingSnapshot.oppStartStack)}bb`
        : `You (${dealerSeat === "bottom" ? "SB" : "BB"}) ${formatBB(handStartStacks.bottom)}bb · Opponent (${dealerSeat === "top" ? "SB" : "BB"}) ${formatBB(handStartStacks.top)}bb`}
    </div>
  </div>

  {/* Current hand pinned right */}
  <div className="absolute right-4 top-1/2 -translate-y-1/2 text-xs text-white/70 tabular-nums whitespace-nowrap">
  {`Hand #${
  logViewOffset === 0
    ? handId + 1
    : (handLogHistory[logViewOffset - 1]?.handNo ?? handId) + 1
}`}

</div>
</div>

  {/* Snapshot extras (ONLY when viewing history) */}
{viewingSnapshot ? (
  <div className="mb-3 flex items-start gap-4">
    <div className="flex flex-col gap-1 text-xs text-white/70 whitespace-nowrap">
      <div>
        You:{" "}
        {renderActionText(
          `${cardStr(viewingSnapshot.heroCards[0])} ${cardStr(viewingSnapshot.heroCards[1])}`
        )}
      </div>

      <div>
  Opponent:{" "}
  {viewingSnapshot.oppShown
    ? renderActionText(
        `${cardStr(viewingSnapshot.oppCards[0])} ${cardStr(viewingSnapshot.oppCards[1])}`
      )
    : viewingSnapshot.log.some(
        (it) => it.seat === "top" && /fold/i.test(it.text)
      )
    ? "Folded"
    : "Mucked"}
    </div>
    </div>

    <div className="flex items-center gap-2 min-w-0 overflow-hidden">
      {displayedHistoryBoard.map((c, i) => (
        <div key={i} className="scale-[0.75] origin-left shrink-0">
          <CardTile card={c} />
        </div>
      ))}
    </div>
  </div>
) : null}

{/* Log list */}
{displayedActionLog.length === 0 ? (
  <div className="text-sm opacity-70">—</div>
) : (
  <div className="max-h-[calc(100vh-220px)] w-full overflow-auto pr-1">
    <div className="w-full text-sm">
      {displayedActionLog.slice(-30).map((a) => (
        <div
          key={a.id}
          className="grid w-full grid-cols-[1fr_1fr_1fr] items-center py-2 leading-none"
        >
          <div
            className="text-center text-xs uppercase tracking-wide text-white/60 -translate-x-4.5 leading-none"
            style={{ paddingTop: "3px" }}
          >
            {a.street}
          </div>

          <div
            className="text-center font-semibold text-white leading-none"
            style={{ marginLeft: "-56px" }}
          >
            {a.seat === "bottom" ? `You (${heroPosLabel})` : `Opponent (${oppPosLabel})`}
          </div>

          <div className="text-center text-white/90 tabular-nums break-words leading-none">
            {renderActionText(a.text)}
          </div>
        </div>
      ))}
    </div>
  </div>
)}

</div>

            {/* CENTER: TABLE */}
            <div className="mx-auto flex w-fit flex-col items-center gap-[92px]">
              {/* TOP SEAT */}
              <div className="relative h-[260px] w-[216px] translate-y-6 rounded-3xl border bg-black/50 text-center">
                {dealerSeat === "top" && <div className={dealerChipTop}>D</div>}

                <div className="absolute -bottom-14 left-1/2 -translate-x-1/2">
                  <BetChip amount={game.bets.top} label={topLabel} />
                </div>

                <div className="flex h-full flex-col justify-center">
                  <div className="-mt-3 text-sm uppercase text-white opacity-60">Opponent</div>
                  <div className="mt-2 text-sm text-white">
                    Stack:{" "}
                    <span className="font-semibold tabular-nums">{formatBB(game.stacks.top)}bb</span>
                  </div>

                  <div className="mt-4 flex justify-center gap-3">
                    {oppA && oppB ? (
                      (handResult.status === "ended" && oppRevealed) ? (
  <>
    <CardTile card={oppA} />
    <CardTile card={oppB} />
  </>
) : (
  <>
    <CardBack />
    <CardBack />
  </>
)

                    ) : null}
                  </div>
                </div>
              </div>

              {/* BOARD (always current hand) */}
<div className="flex h-40 items-center justify-center">
  <div className="flex gap-3">
    {board.slice(0, street).map((c, i) => (
      <CardTile key={i} card={c} />
    ))}
  </div>
</div>

              {/* BOTTOM SEAT */}
              <div className="relative h-[260px] w-[216px] -translate-y-6 rounded-3xl border bg-black/50 text-center">
                {dealerSeat === "bottom" && <div className={dealerChipBottom}>D</div>}

                <div className="absolute -top-14 left-1/2 -translate-x-1/2">
                  <BetChip amount={game.bets.bottom} label={bottomLabel} />
                </div>

                <div className="flex h-full flex-col justify-center">
                  <div className="text-sm uppercase text-white opacity-60">You</div>
                  <div className="text-xl font-semibold capitalize text-white">{seatedRole}</div>

                  <div className="mt-2 text-sm text-white">
                    Stack:{" "}
                    <span className="font-semibold tabular-nums">
                      {formatBB(game.stacks.bottom)}bb
                    </span>
                  </div>

                  <div className="mt-4 flex flex-col items-center gap-2">
                 <div className="flex justify-center gap-3">
                   {youC && youD ? (
                    handResult.status === "ended" && youMucked ? (
                     <>
                      <CardBack />
                      <CardBack />
                    </>
                  ) : (
                    <>
                      <CardTile card={youC} />
                      <CardTile card={youD} />
                    </>
                  )
                ) : null}
              </div>

  {heroHandRank && !(handResult.status === "ended" && youMucked) ? (
    <div className="text-xs font-semibold text-white/80">
      {heroHandRank}
    </div>
  ) : null}
</div>


                </div>
              </div>
            </div>
          </div>

          {/* ACTION PANEL (bottom-right) */}
          {isBottomTurn && (
            <div className="fixed bottom-6 right-6 z-50 flex w-[320px] flex-col gap-3">
              <div className="rounded-2xl border bg-white p-3 text-black shadow-sm">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-sm font-semibold">{facingBetBottom ? "Raise to" : "Bet to"}</div>
                  <div className="text-sm font-bold tabular-nums">{formatBB(safeBetSize)} BB</div>
                </div>

                <div className="flex items-center gap-3 min-w-0">
                  <input
                    type="range"
                    min={0}
                    max={bottomMaxTo}
                    step={0.01}
                    value={betSize === "" ? 0 : betSize}
                    onChange={(e) => setBetSizeRounded(Number(e.target.value))}
                    className="w-full"
                  />

                  <input
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    value={betSize}
                    placeholder="0"
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === "") setBetSize("");
                      else setBetSize(val === "-" ? "" : Number(val));
                    }}
                    onBlur={() => {
                      if (betSize === "") setBetSizeRounded(defaultTo);
                      else setBetSizeRounded(betSize);
                    }}
                    className="w-24 rounded-xl border px-2 py-1 text-sm tabular-nums"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => dispatchAction({ type: "FOLD" })}
                  className="h-[64px] w-[100px] rounded-2xl border bg-white px-4 py-3 text-sm font-semibold text-black shadow-sm hover:bg-gray-100"
                >
                  Fold
                </button>

               <button
  type="button"
  onClick={() =>
  dispatchAction(facingBetBottom ? { type: "CALL" } : { type: "CHECK" })
}
  className="flex h-[64px] w-[100px] flex-col items-center justify-center rounded-2xl border bg-white px-4 py-3 text-sm font-semibold text-black shadow-sm hover:bg-gray-100"
>
  <div>{facingBetBottom ? "Call" : "Check"}</div>

  {facingBetBottom && (
    <div className="mt-0.5 text-xs font-bold tabular-nums">
      {formatBB(bottomCallAmt)} BB
    </div>
  )}
</button>

                <button
  type="button"
  onClick={() => dispatchAction({ type: "BET_RAISE_TO", to: safeBetSize })}
  className="flex h-[64px] w-[100px] flex-col items-center justify-center rounded-2xl border bg-white px-4 py-3 text-sm font-semibold text-black shadow-sm hover:bg-gray-100"
>
  <div className="text-sm leading-tight">
    {facingBetBottom ? "Raise" : "Bet"}
  </div>

  <div className="mt-0.5 w-full text-center text-xs font-bold tabular-nums">
    {formatBB(safeBetSize)} BB
  </div>
</button>
              </div>
            </div>
          )}
        </div>
      </main>
    </>
  );
}

// Next time:
// If player accidentally disconnects from game make it so that progress is saved 
// Make it compatible with ipad and iphone 
// Add sounds
// Coming soon Match history • Stats • Notes • Session goals
// make it so that its also non-student friendly 
// Update it in Repository?
// The whole screen moves every new hand so change it so that it stays put (I think its cause the real time updated action line shows up and disappears)
// Make it so that you have the option to show cards anytime after a hand ends
// think about whether the connection is successful through linkedin or my app itself? which one would it be easier? 
// ADD SCHOOL FIELD IN SIGNUP

// Connect people's names to their Linkedin? Have like a (Connect your Linkedin and then the name becomes a hyperlink?)

// PRETTY MUCH READY TO START THE BACKEND? THE ACTUAL TESTING WITH REAL PEOPLE

// Ask Wilson if he would like to do marketing for this 

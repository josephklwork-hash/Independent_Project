"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import { GAME_CONFIG, BASE_SB, BASE_BB } from './gameConfig';
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";

import { MultiplayerHost } from "./multiplayerHost";
import { MultiplayerJoiner } from "./multiplayerJoiner";
import type { HostState, GameAction } from "./multiplayerHost";

export const dynamic = 'force-dynamic';  // ← THIS LINE

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
  sequence: number;
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

  // true only if player actually showed / was required to show
  heroShown: boolean;
  oppShown: boolean;

  heroStartStack: number;
  oppStartStack: number;
  
  // Best 5-card hands
  heroBest5?: Card[];
  oppBest5?: Card[];
  heroHandDesc?: string;
  oppHandDesc?: string;
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
  canShowTop: boolean;
  canShowBottom: boolean;
  topShowed: boolean;
  bottomShowed: boolean;
};

/* ---------- constants ---------- */

const RANKS = ["A", "K", "Q", "J", "T", "9", "8", "7", "6", "5", "4", "3", "2"];
const SUITS = ["♠", "♥", "♦", "♣"];

// Game configuration imported from shared gameConfig.ts file
// To change game settings, edit gameConfig.ts
const STARTING_STACK_BB = GAME_CONFIG.STARTING_STACK_BB;

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
    <div className="relative h-24 w-16 min-[1536px]:max-[1650px]:h-[75px] min-[1536px]:max-[1650px]:w-[50px] rounded-xl border bg-white shadow-sm">
      <div className={`absolute left-3 top-2 min-[1536px]:max-[1650px]:left-2 min-[1536px]:max-[1650px]:top-1 text-4xl min-[1536px]:max-[1650px]:text-3xl font-extrabold ${colorClass}`}>
  {card.rank}
</div>
      <div className={`absolute bottom-3 right-3 min-[1536px]:max-[1650px]:bottom-2 min-[1536px]:max-[1650px]:right-2 text-4xl min-[1536px]:max-[1650px]:text-3xl font-bold ${colorClass}`}>
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
    <div className="relative h-24 w-16 min-[1536px]:max-[1650px]:h-[75px] min-[1536px]:max-[1650px]:w-[50px] rounded-xl border bg-white shadow-sm">
      <div className="absolute inset-2 min-[1536px]:max-[1650px]:inset-1 rounded-lg border border-dashed opacity-40" />
    </div>
  );
}

function BetChip({ amount, label }: { amount: number; label?: string }) {
  if (amount <= 0) return null;
  return (
    <div className="flex h-9 w-9 min-[1536px]:max-[1650px]:h-7 min-[1536px]:max-[1650px]:w-7 flex-col items-center justify-center rounded-full border bg-white text-black shadow-sm">
      <div className="text-[11px] min-[1536px]:max-[1650px]:text-[9px] font-bold leading-none tabular-nums">
        {formatBB(amount)}
      </div>
      <div className="mt-[1px] text-[9px] min-[1536px]:max-[1650px]:text-[7px] font-semibold leading-none opacity-70">
        BB
      </div>
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
      <div className="relative w-full max-w-md min-[1536px]:max-[1650px]:max-w-[350px] rounded-3xl min-[1536px]:max-[1650px]:rounded-2xl border border-gray-300 bg-gray-100 p-6 min-[1536px]:max-[1650px]:p-4 shadow-lg">
        <h3 className="mb-2 text-lg min-[1536px]:max-[1650px]:text-base font-bold text-gray-900">{title}</h3>
        <p className="mb-6 min-[1536px]:max-[1650px]:mb-4 text-sm min-[1536px]:max-[1650px]:text-xs text-gray-800">{message}</p>

        <div className="flex justify-end gap-3">
          <button
            onClick={onConfirm}
            className="rounded-2xl min-[1536px]:max-[1650px]:rounded-xl border px-4 py-2 min-[1536px]:max-[1650px]:px-3 min-[1536px]:max-[1650px]:py-1.5 text-sm min-[1536px]:max-[1650px]:text-xs font-semibold text-gray-900 transition-colors hover:bg-gray-200"
          >
            {confirmText}
          </button>
          <button
            onClick={onCancel}
            className="rounded-2xl min-[1536px]:max-[1650px]:rounded-xl border px-4 py-2 min-[1536px]:max-[1650px]:px-3 min-[1536px]:max-[1650px]:py-1.5 text-sm min-[1536px]:max-[1650px]:text-xs font-semibold text-gray-900 transition-colors hover:bg-gray-200"
          >
            {cancelText}
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
  canShowTop: false,
  canShowBottom: false,
  topShowed: false,
  bottomShowed: false,
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

const canShowTop = auth.canShowTop;
const setCanShowTop = (next: any) =>
  setAuth((prev) => ({
    ...prev,
    canShowTop: typeof next === "function" ? next(prev.canShowTop) : next,
  }));

const canShowBottom = auth.canShowBottom;
const setCanShowBottom = (next: any) =>
  setAuth((prev) => ({
    ...prev,
    canShowBottom: typeof next === "function" ? next(prev.canShowBottom) : next,
  }));

const topShowed = auth.topShowed;
const setTopShowed = (next: any) =>
  setAuth((prev) => ({
    ...prev,
    topShowed: typeof next === "function" ? next(prev.topShowed) : next,
  }));

const bottomShowed = auth.bottomShowed;
const setBottomShowed = (next: any) =>
  setAuth((prev) => ({
    ...prev,
    bottomShowed: typeof next === "function" ? next(prev.bottomShowed) : next,
  }));

const streetBettor = auth.streetBettor;
const setStreetBettor = (next: any) =>
  setAuth((prev) => ({
    ...prev,
    streetBettor:
      typeof next === "function" ? next(prev.streetBettor) : next,
  }));

  const [dealerOffset, setDealerOffset] = useState<0 | 1>(0);

  const [betSize, setBetSize] = useState<number | "">("");

  const [game, setGame] = useState<GameState>({
    stacks: { top: STARTING_STACK_BB, bottom: STARTING_STACK_BB },
    bets: { top: 0, bottom: 0 },
    pot: 0,
  });

  const [cards, setCards] = useState<Card[] | null>(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showFoldConfirm, setShowFoldConfirm] = useState(false);
  const [showTitleScreenConfirm, setShowTitleScreenConfirm] = useState(false);
  const [opponentQuit, setOpponentQuit] = useState(false);

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

  // Store the multiplayer controllers
const [mpHost, setMpHost] = useState<MultiplayerHost | null>(null);
const [mpJoiner, setMpJoiner] = useState<MultiplayerJoiner | null>(null);

// Store the multiplayer state (received from host or from local host controller)
const [mpState, setMpState] = useState<HostState | null>(null);

    const isHost = mySeat === "bottom";
  const suppressMpRef = useRef(false);

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
  const blindsKeyRef = useRef<string | null>(null);
  const gameRef = useRef(game);
  const streetRef = useRef<Street>(street);
  const actionSequenceRef = useRef(0);

useEffect(() => {
  gameRef.current = game;
}, [game]);

useEffect(() => {
  gameOverRef.current = gameOver;
}, [gameOver]);

useEffect(() => {
  streetRef.current = street;
}, [street]);

// Set page title
useEffect(() => {
  document.title = 'HeadsUp';
}, []);

// Watch for game status changes (for host waiting for joiner)
useEffect(() => {
  if (!gameId) return;
  if (multiplayerActive) return; // Already active, no need to watch
  if (!gamePin) return; // Not in a PIN game
  if (mySeat !== "bottom") return; // Only host needs this

  // Poll for game becoming active
  const interval = setInterval(async () => {
    const { data } = await supabase
      .from("games")
      .select("status")
      .eq("id", gameId)
      .single();

    if (data?.status === "active") {
      console.log("Game became active - joiner joined!");
      clearInterval(interval);
      setMultiplayerActive(true);
      setSeatedRole((prev) => prev ?? "student");
      setScreen("game");
    }
  }, 1000);

  return () => clearInterval(interval);
}, [gameId, multiplayerActive, gamePin, mySeat]);

useEffect(() => {
  if (!gameId) return;
  if (!multiplayerActive) return;

  const ch = supabase.channel(`game:${gameId}`);

  // Subscribe to channel
  ch.subscribe((status) => {
    console.log('Channel status:', status);
    
    if (status === 'SUBSCRIBED') {
      console.log('Successfully subscribed to game channel');
      
      // Initialize the appropriate controller
      if (isHost) {
        // HOST: Create host controller
        const host = new MultiplayerHost(
          ch, 
          sbUser?.id ?? 'host', 
          dealerOffset, 
          () => {
            // When controller processes joiner's action, update host's display
            setMpState(JSON.parse(JSON.stringify(host.getState())));
          },
          () => {
            // Opponent quit
            setOpponentQuit(true);
          }
        );
        setMpHost(host);
        
        // Start the first hand immediately - joiner will request when ready
        host.startHand();
        // Update our own display with host's state
        setMpState(JSON.parse(JSON.stringify(host.getState())));
        
      } else {
        // JOINER: Create joiner controller
        const joiner = new MultiplayerJoiner(
          ch, 
          sbUser?.id ?? 'joiner',
          (state: HostState) => {
            // When we receive state from host, update our display
            setMpState(state);
          },
          () => {
            // Opponent quit
            setOpponentQuit(true);
          }
        );
        setMpJoiner(joiner);
      }
    }
  });

  return () => {
    // Cleanup
    if (mpHost) {
      mpHost.destroy();
      setMpHost(null);
    }
    if (mpJoiner) {
      mpJoiner.destroy();
      setMpJoiner(null);
    }
    supabase.removeChannel(ch);
  };
}, [gameId, multiplayerActive, isHost, sbUser?.id]);

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

  const dealerSeat: Seat = useMemo(() => {
  if (multiplayerActive && mpState) {
    return mpState.dealerSeat;
  }
  return ((handId + dealerOffset) % 2 === 0 ? "top" : "bottom");
}, [handId, dealerOffset, multiplayerActive, mpState]);

  const nonDealerSeat: Seat = dealerSeat === "top" ? "bottom" : "top";

  // Calculate blind notice using correct hand ID
  const effectiveHandId = multiplayerActive && mpState ? mpState.handId : handId;
  const effectiveHandNo = effectiveHandId + 1;
  const withinBlock = ((effectiveHandNo - 1) % GAME_CONFIG.BLINDS_INCREASE_EVERY_N_HANDS) + 1;
  const blindNotice = (withinBlock >= GAME_CONFIG.WARNING_STARTS_AT_HAND && withinBlock <= GAME_CONFIG.BLINDS_INCREASE_EVERY_N_HANDS)
    ? ((GAME_CONFIG.BLINDS_INCREASE_EVERY_N_HANDS + 1) - withinBlock === 1 
        ? "Blinds will change next hand" 
        : `Blinds will change in ${(GAME_CONFIG.BLINDS_INCREASE_EVERY_N_HANDS + 1) - withinBlock} hands`)
    : null;

  // Display variables - use mpState when in multiplayer, otherwise use local state
const displayGame = multiplayerActive && mpState ? mpState.game : game;
const displayToAct = multiplayerActive && mpState ? mpState.toAct : toAct;
const displayCards = multiplayerActive && mpState ? mpState.cards : cards;
const displayActionLog = multiplayerActive && mpState ? mpState.actionLog : actionLog;
const displayHandResult = multiplayerActive && mpState ? mpState.handResult : handResult;
const displayStreet = multiplayerActive && mpState ? mpState.street : street;
const displayOppRevealed = multiplayerActive && mpState ? mpState.oppRevealed : oppRevealed;
const displayYouMucked = multiplayerActive && mpState ? mpState.youMucked : youMucked;
const displayCanShowTop = multiplayerActive && mpState ? mpState.canShowTop : canShowTop;
const displayCanShowBottom = multiplayerActive && mpState ? mpState.canShowBottom : canShowBottom;
const displayTopShowed = multiplayerActive && mpState ? mpState.topShowed : topShowed;
const displayBottomShowed = multiplayerActive && mpState ? mpState.bottomShowed : bottomShowed;

  // Perspective helpers: map game seats to screen positions
  const myActualSeat = mySeat; // "bottom" for host, "top" for joiner
  const oppActualSeat: Seat = mySeat === "bottom" ? "top" : "bottom";
  
  // Determine if I can show hand and if opponent showed
  const canIShow = myActualSeat === "top" ? displayCanShowTop : displayCanShowBottom;
  const didIShow = myActualSeat === "top" ? displayTopShowed : displayBottomShowed;
  const didOppShow = myActualSeat === "top" ? displayBottomShowed : displayTopShowed;
  
  // Game state from my perspective
  const myStack = displayGame.stacks[myActualSeat];
const oppStack = displayGame.stacks[oppActualSeat];
  const myBet = displayGame.bets[myActualSeat];
const oppBet = displayGame.bets[oppActualSeat];
  
  const amIDealer = dealerSeat === myActualSeat;
console.log('DEBUG - handId:', handId, 'dealerOffset:', dealerOffset, 'dealerSeat:', dealerSeat);
console.log('DEBUG - myActualSeat:', myActualSeat, 'oppActualSeat:', oppActualSeat, 'amIDealer:', amIDealer);
console.log('DEBUG - game.bets:', game.bets, 'myBet:', myBet, 'oppBet:', oppBet);
console.log('DEBUG - toAct:', toAct, 'mySeat:', mySeat, 'myTurn:', toAct === mySeat, 'isBottomTurn:', toAct === mySeat && handResult.status === "playing");
  const myPositionLabel = amIDealer ? "SB/D" : "BB";
  const oppPositionLabel = amIDealer ? "BB" : "SB/D";
  
  const myLabel = amIDealer ? "SB" : "BB";
  const oppLabel = amIDealer ? "BB" : "SB";

  const isBottomTurn = seatedRole && displayToAct === mySeat && displayHandResult.status === "playing";

  const [handStartStacks, setHandStartStacks] = useState<{ top: number; bottom: number }>({
  top: STARTING_STACK_BB,
  bottom: STARTING_STACK_BB,
});

  // 0 = current hand, 1 = previous hand, 2 = two hands ago, etc.

  function generate4DigitPin() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

async function createPinGame() {
  const startTime = performance.now();
  console.log("=== CREATE GAME START ===");
  let user: User;

  // Try to use existing session first (much faster)
  try {
    console.log("Step 1: Checking for existing user...");
    const { data: existingData } = await supabase.auth.getUser();
    
    if (existingData?.user) {
      user = existingData.user;
      console.log("Using existing user:", user.id);
    } else {
      // Only create anonymous user if needed
      console.log("Creating new anonymous user...");
      const authStart = performance.now();
      const { data: anonData, error: anonErr } =
        await supabase.auth.signInAnonymously();
      console.log(`signInAnonymously took ${(performance.now() - authStart).toFixed(0)}ms`);
      
      if (anonErr || !anonData.user) throw anonErr;
      user = anonData.user;
      console.log("Anonymous user created:", user.id);
    }
  } catch (e) {
    console.error("Auth failed:", e);
    alert("Could not start a guest session.");
    setCreatingGame(false);
    return;
  }

  // attempt to create a unique 4-digit PIN
  for (let attempt = 0; attempt < 5; attempt++) {
    const pin = generate4DigitPin();
    console.log(`\nAttempt ${attempt + 1}: Trying PIN ${pin}`);

    console.log("Step 2: Inserting game...");
    const insertStart = performance.now();
    const { data: gameRow, error: gameErr } = await supabase
      .from("games")
      .insert({
        pin,
        created_by: user.id,
        status: "waiting",
      })
      .select("id,pin")
      .single();
    console.log(`games.insert took ${(performance.now() - insertStart).toFixed(0)}ms`);

    if (gameErr) {
      console.error("games.insert failed:", gameErr);
      // If it's a PIN collision (unique constraint violation), try again
      if (gameErr.code === "23505") {
        console.log("PIN collision, trying new PIN...");
        continue;
      }
      // For other errors, fail immediately
      alert("Failed to create game. Please try again.");
      setCreatingGame(false);
      return;
    }

    if (!gameRow) {
      console.error("No game row returned");
      continue;
    }

    console.log("Step 3: Claiming seat...");
    const playerStart = performance.now();
    const { error: playerErr } = await supabase
      .from("game_players")
      .insert({
        game_id: gameRow.id,
        user_id: user.id,
        seat: "bottom",
      });
    console.log(`game_players.insert took ${(performance.now() - playerStart).toFixed(0)}ms`);

    if (playerErr) {
      console.error("game_players.insert failed:", playerErr);
      alert("Failed to claim seat.");
      setCreatingGame(false);
      return;
    }

    const totalTime = (performance.now() - startTime).toFixed(0);
    console.log(`=== GAME CREATED SUCCESSFULLY in ${totalTime}ms ===`);
    console.log("PIN:", gameRow.pin);

    setJoinMode(false);
    setJoinPinInput("");
    setGamePin(gameRow.pin);

    setGameId(gameRow.id);
    setMySeat("bottom");
    setMultiplayerActive(false);

    // Randomize dealer offset once when creating the game
    const initialDealerOffset: 0 | 1 = Math.random() < 0.5 ? 0 : 1;
    setDealerOffset(initialDealerOffset);

    // stay on title screen to show the PIN screen
    return;
  }

  console.error("Failed after 5 attempts");
  alert("Failed to create game (PIN collision). Please try again.");
  setCreatingGame(false);
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
  
  // Prevent multiple simultaneous join attempts
  if (creatingGame) {
    console.log("Already joining game, ignoring duplicate click");
    return;
  }
  
  setCreatingGame(true);
  console.log("=== JOIN GAME START ===");
  console.log("PIN:", pin);
  
  let user: User;
  try {
    console.log("Creating anonymous user...");
    const authStart = performance.now();
    const { data: anonData, error: anonErr } =
      await supabase.auth.signInAnonymously();
    console.log(`signInAnonymously took ${(performance.now() - authStart).toFixed(0)}ms`);
    
    if (anonErr || !anonData.user) {
      console.error("Anonymous auth error:", anonErr);
      throw anonErr;
    }
    user = anonData.user;
    console.log("Anonymous user created:", user.id);
  } catch (e) {
    console.error("joinPinGame auth failed:", e);
    alert("Network error: Could not connect to server. Please check your internet connection and try again.");
    setCreatingGame(false);
    return;
  }

  console.log("Looking up game with PIN:", pin);
  const { data: gameRow, error: gameErr } = await supabase
    .from("games")
    .select("id,pin,status")
    .eq("pin", pin)
    .single();

  if (gameErr) {
    console.error("Game lookup error:", gameErr);
    alert("Could not find game with that PIN. Please check the PIN and try again.");
    setCreatingGame(false);
    return;
  }
  
  if (!gameRow) {
    console.error("No game found with PIN:", pin);
    alert("Game not found. Please check the PIN.");
    setCreatingGame(false);
    return;
  }
  
  console.log("Found game:", gameRow.id);

  // join as top seat
  console.log("Claiming seat in game...");
  const { error: playerErr } = await supabase.from("game_players").insert({
    game_id: gameRow.id,
    user_id: user.id,
    seat: "top",
  });

  if (playerErr) {
    console.error("Failed to claim seat:", playerErr);
    alert("Could not join game. The seat may already be taken.");
    setCreatingGame(false);
    return;
  }
  
  console.log("Seat claimed, marking game as active...");

  // mark game as active
  console.log("Marking game as active...");
  await supabase.from("games").update({ status: "active" }).eq("id", gameRow.id);

  console.log("Join successful, entering game...");
  setJoinMode(false);
  setJoinPinInput("");
  setGamePin(gameRow.pin);

  setGameId(gameRow.id);

  // IMPORTANT: set seat BEFORE enabling multiplayer so isHost is never true on joiner
  setMySeat("top");
  setMultiplayerActive(true);

  // enter the game screen and wait for host's RESET
  clearTimers();
  setBetSize(2);
  setSeatedRole((prev) => prev ?? "student");
  setScreen("game");
  setCreatingGame(false);
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
  toAct: Seat;
  handStartStacks: { top: number; bottom: number };
  lastRaiseSize: number;
  endedBoardSnapshot: number;
  blindsPosted: boolean;
  cards: Card[] | null;
  actionLog: ActionLogItem[];
  actionSeq: number;
}) 

{


  suppressMpRef.current = true;

  clearTimers();

  gameOverRef.current = false;
  setGameOver(false);
  setPlayAgainRequested(false);

  setDealerOffset(p.dealerOffset);

  setGame(p.game);
  gameRef.current = p.game;
  streetRef.current = 0;

  setCards(p.cards);

  setHandResult({ status: "playing", winner: null, reason: null, message: "" });
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
  setToAct(p.toAct);
  setHandStartStacks(p.handStartStacks);
  setLastRaiseSize(p.lastRaiseSize);
  setEndedBoardSnapshot(p.endedBoardSnapshot);
  blindsPostedRef.current = p.blindsPosted;
  actionSequenceRef.current = 0;

  suppressMpRef.current = false;
  
  // Set action log after a small delay to ensure React updates
  setTimeout(() => {
    setActionLog(p.actionLog);
    actionLogRef.current = p.actionLog;
  }, 0);
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
      heroShown: (() => {
        const log = actionLogRef.current;
        const mucked = log.some((it) => it.seat === "bottom" && /muck/i.test(it.text));
        const showed = log.some((it) => it.seat === "bottom" && it.text.startsWith("Shows "));
        return showed && !mucked;
      })(),
      
      oppShown: (() => {
        const log = actionLogRef.current;
        const mucked = log.some((it) => it.seat === "top" && /muck/i.test(it.text));
        const showed = log.some((it) => it.seat === "top" && it.text.startsWith("Shows "));
        return showed && !mucked;
      })(),

      heroStartStack: handStartStacks.bottom,
      oppStartStack: handStartStacks.top,
    };

    // Don't add duplicate snapshots for the same hand
    if (prev.length > 0 && prev[0]?.handNo === snap.handNo) return prev;
    console.log('Saving hand history snapshot:', snap.handNo + 1);
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
    sequence: actionSequenceRef.current++,
    street: streetNameFromCount(street),
    seat,
    text: finalText,
  };

  setActionLog((prev: ActionLogItem[]) => {
    const next = [...prev, item];
    actionLogRef.current = next;

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

  }

  function pullBetsIntoPot() {
  setGame((prev: GameState) => {
    const next = {
      ...prev,
      pot: roundToHundredth(prev.pot + prev.bets.top + prev.bets.bottom),
      bets: { top: 0, bottom: 0 },
    };

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

  // Mark hand ended + snapshot
  setHandResult({ status: "ended", winner, reason, message });

  setTimeout(() => snapshotCurrentHandLog(), 0);

  // If this hand ends the match, freeze here.
  if (shouldEndGame) {

    setTimeout(() => {
      gameOverRef.current = true;
      setGameOver(true);
      clearTimers();
    }, multiplayerActive ? 150 : 0);
  }
}

 function startNewHand() {
    // Don't start a new hand if game is over
    if (gameOverRef.current) return;

    allInCallThisHandRef.current = false;
    actionSequenceRef.current = 0;

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
    setCanShowTop(false);
    setCanShowBottom(false);
    setTopShowed(false);
    setBottomShowed(false);

    setSawCallThisStreet(false);

    setHandId((h) => {
      const next = h + 1;

      return next;
    });
  }

  function resetGame() {
    // reset stacks + randomize starting dealer + deal fresh hand
    clearTimers();

    gameOverRef.current = false;
    setGameOver(false);
    setPlayAgainRequested(false);

    // Only randomize dealerOffset in single-player mode
// In multiplayer, keep the existing dealerOffset that was set when creating the game
let currentDealerOffset = dealerOffset;
if (!multiplayerActive) {
  const nextDealerOffset: 0 | 1 = Math.random() < 0.5 ? 0 : 1;
  setDealerOffset(nextDealerOffset);
  currentDealerOffset = nextDealerOffset;
}

    const freshGame: GameState = {
  stacks: { top: STARTING_STACK_BB, bottom: STARTING_STACK_BB },
  bets: { top: 0, bottom: 0 },
  pot: 0,
};

setGame(freshGame);
gameRef.current = freshGame;
streetRef.current = 0;

// host deals immediately on reset so joiner can't miss cards
const nextCards = drawUniqueCards(9);
setCards(nextCards);

    setHandResult({ status: "playing", winner: null, reason: null, message: "" });
    setActionLog([]);
    actionLogRef.current = [];
    actionSequenceRef.current = 0;
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
    setCanShowTop(false);
    setCanShowBottom(false);
    setTopShowed(false);
    setBottomShowed(false);

    setBetSize(2);
    setHandLogHistory([]);
    setLogViewOffset(0);

    setGameSession((s: number) => {
  const next = s + 1;

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

  // Determine if viewing history snapshot
  const viewingSnapshot =
    logViewOffset === 0 ? null : handLogHistory[logViewOffset - 1];

  // Raw cards from deck: [0,1] = top seat, [2,3] = bottom seat
const topRaw1 = displayCards?.[0];
const topRaw2 = displayCards?.[1];
const bottomRaw1 = displayCards?.[2];
const bottomRaw2 = displayCards?.[3];

  // Opponent cards (from my perspective)
  const oppRaw1 = mySeat === "bottom" ? topRaw1 : bottomRaw1;
  const oppRaw2 = mySeat === "bottom" ? topRaw2 : bottomRaw2;

  // My cards (from my perspective)
const youRaw1 = mySeat === "bottom" ? bottomRaw1 : topRaw1;
const youRaw2 = mySeat === "bottom" ? bottomRaw2 : topRaw2;

  const [oppA, oppB] = useMemo(() => {
    // When viewing snapshot, use snapshot's opponent cards
    if (viewingSnapshot) {
      return [viewingSnapshot.oppCards[0], viewingSnapshot.oppCards[1]] as const;
    }
    
    if (!oppRaw1 || !oppRaw2) return [undefined, undefined] as const;
    const a = RANK_TO_VALUE[oppRaw1.rank];
    const b = RANK_TO_VALUE[oppRaw2.rank];
    return a >= b ? ([oppRaw1, oppRaw2] as const) : ([oppRaw2, oppRaw1] as const);
  }, [oppRaw1, oppRaw2, viewingSnapshot]);

  const [youC, youD] = useMemo(() => {
    // When viewing snapshot, use snapshot's hero cards
    if (viewingSnapshot) {
      return [viewingSnapshot.heroCards[0], viewingSnapshot.heroCards[1]] as const;
    }
    
    if (!youRaw1 || !youRaw2) return [undefined, undefined] as const;
    const a = RANK_TO_VALUE[youRaw1.rank];
    const b = RANK_TO_VALUE[youRaw2.rank];
    return a >= b ? ([youRaw1, youRaw2] as const) : ([youRaw2, youRaw1] as const);
  }, [youRaw1, youRaw2, viewingSnapshot]);

  const board = viewingSnapshot 
    ? viewingSnapshot.endedBoard 
    : (displayCards ? displayCards.slice(4, 9) : []);
  
  // Debug: Check if joiner hasn't received state yet
  if (multiplayerActive && !isHost && !mpState) {
    console.warn('JOINER: Waiting for initial state from host...');
  }
  if (multiplayerActive && !isHost && mpState && !mpState.cards) {
    console.error('JOINER: Received state but cards are null!', mpState);
  }

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

  // Prevent double-execution for the same hand/session (can happen from clustered state updates)
  const blindsKey = `${gameSession}-${handId}`;
  if (blindsKeyRef.current === blindsKey) return;
  blindsKeyRef.current = blindsKey;

    if (!multiplayerActive) {
    setHandStartStacks(gameRef.current.stacks);
    }

    // reset per-hand state
    setHandResult({ status: "playing", winner: null, reason: null, message: "" });
    allInCallThisHandRef.current = false;
    setStreet(0);
    setChecked({ top: false, bottom: false });
    setLastAggressor(null);
    setLastToActAfterAggro(null);
    setSawCallThisStreet(false);
    setActionsThisStreet(0);
    setLastRaiseSize(BB);

    const topBlind = dealerSeat === "top" ? SB : BB;
    const bottomBlind = dealerSeat === "bottom" ? SB : BB;

    if (!multiplayerActive || isHost) {
      setGame((prev: GameState) => {
        const isLevelChangeHand = handId !== 0 && handId % GAME_CONFIG.BLINDS_INCREASE_EVERY_N_HANDS === 0;
        const mult = isLevelChangeHand ? 0.75 : 1;

        const topScaled = roundToHundredth(prev.stacks.top * mult);
        const bottomScaled = roundToHundredth(prev.stacks.bottom * mult);

        // Cap blinds at available stack if short
        const actualTopBlind = Math.min(topBlind, topScaled);
        const actualBottomBlind = Math.min(bottomBlind, bottomScaled);
        
        const nextGame = {
          pot: 0,
          bets: {
            top: roundToHundredth(actualTopBlind),
            bottom: roundToHundredth(actualBottomBlind),
          },
          stacks: {
            top: roundToHundredth(Math.max(0, topScaled - actualTopBlind)),
            bottom: roundToHundredth(Math.max(0, bottomScaled - actualBottomBlind)),
          },
        };

        // Determine actual SB/BB amounts based on dealer position
        const actualSB = dealerSeat === "top" ? actualTopBlind : actualBottomBlind;
        const actualBB = dealerSeat === "top" ? actualBottomBlind : actualTopBlind;
        
        if (isHost && !suppressMpRef.current) {
  const blindItems = [
    {
      id: uid(),
      sequence: actionSequenceRef.current++,
      street: "Preflop" as StreetName,
      seat: dealerSeat,
      text: `Posts SB ${formatBB(actualSB)}bb`
    },
    {
      id: uid(),
      sequence: actionSequenceRef.current++,
      street: "Preflop" as StreetName,
      seat: nonDealerSeat,
      text: `Posts BB ${formatBB(actualBB)}bb`
    }
  ];

  // Host adds blind actions to its own log immediately BEFORE sending
  setActionLog(blindItems);
  actionLogRef.current = blindItems;
  
}

        return nextGame;
      });
    }

    // who acts first preflop = dealer
    setToAct(dealerSeat);

   setTimeout(() => {
  blindsPostedRef.current = true;

}, 0);

    setBetSize(2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seatedRole, handId, dealerSeat, gameSession]);

 useEffect(() => {
  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    if (!(displayToAct === mySeat && displayHandResult.status === "playing")) return;

    const effectiveLastRaiseSize = multiplayerActive && mpState ? mpState.lastRaiseSize : lastRaiseSize;
    const facingBet = displayGame.bets[oppActualSeat] > displayGame.bets[myActualSeat];
    
    // Use same logic as bottomMinRaise calculation
    const minRaise = facingBet 
      ? roundToHundredth(displayGame.bets[oppActualSeat] + effectiveLastRaiseSize)
      : (displayStreet === 0 && displayGame.bets[myActualSeat] > 0 && displayGame.bets[oppActualSeat] > 0)
        ? roundToHundredth(Math.max(displayGame.bets[myActualSeat], displayGame.bets[oppActualSeat]) + BB)
        : BB;
    
    const isOpeningAction = displayGame.bets[myActualSeat] === 0 && displayGame.bets[oppActualSeat] === 0;
    const defaultSize = (displayStreet === 0 && isOpeningAction) ? 2 : minRaise;
    const finalSize = betSize === "" ? defaultSize : Math.max(betSize, minRaise);

    dispatchAction({ type: "BET_RAISE_TO", to: finalSize });
  }

  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}, [displayToAct, mySeat, displayHandResult.status, betSize, displayGame, oppActualSeat, myActualSeat, multiplayerActive, mpState, lastRaiseSize, BB, displayStreet, dispatchAction]);

  function currentFacingBet(seat: Seat) {
    const other: Seat = seat === "top" ? "bottom" : "top";
    return game.bets[other] > game.bets[seat];
  }

  function amountToCall(seat: Seat) {
    const other: Seat = seat === "top" ? "bottom" : "top";
    return roundToHundredth(Math.max(0, displayGame.bets[other] - displayGame.bets[seat]));
  }
  function canCheck(seat: Seat, g: GameState = gameRef.current, st: Street = streetRef.current) {
  const other: Seat = seat === "top" ? "bottom" : "top";
  return roundToHundredth(g.bets[other]) === roundToHundredth(g.bets[seat]);
}

  function settleIfStreetComplete() {
    if (handResult.status !== "playing") return;

    const equalBets = roundToHundredth(game.bets.top) === roundToHundredth(game.bets.bottom);

    if (lastAggressor) {
      if (equalBets && lastToActAfterAggro === null) {
        pullBetsIntoPot();

        if (street < 5) {
  const nextStreet: Street = street === 0 ? 3 : street === 3 ? 4 : 5;

  // If anyone is all-in postflop, run it out to the river immediately
  const someoneAllIn = (game.stacks.top <= 0 || game.stacks.bottom <= 0);

  if (someoneAllIn) {
    // show the full board
    setStreet(5);

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

  // NEW: if anyone is all-in, run it out to the river and resolve immediately
  if (game.stacks.top <= 0 || game.stacks.bottom <= 0) {
    setStreet(5);

    resolveShowdown();
    return;
  }

   setTimeout(() => {
      if (street < 5) {
        const nextStreet: Street = street === 0 ? 3 : street === 3 ? 4 : 5;
        resetStreetRound(nextStreet);
      } else {
        // River checked through (no betting): out-of-position shows first
        const noBetOnRiver = bothChecked && streetBettor === null;
        resolveShowdown(noBetOnRiver ? nonDealerSeat : null);
      }
    }, 50);
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

    const other: Seat = seat === "top" ? "bottom" : "top";

    logAction(seat, "Folds");
    endedStreetRef.current = street;
    setEndedBoardSnapshot(street);

    const potTotal = formatBB(
  roundToHundredth(displayGame.pot + displayGame.bets.top + displayGame.bets.bottom)
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

  logAction(seat, "Checks");
  setChecked((prev: { top: boolean; bottom: boolean }) => ({ ...prev, [seat]: true }));
  setActionsThisStreet((n: number) => n + 1);

    if (
  street === 0 &&
  sawCallThisStreet &&
  roundToHundredth(game.bets.top) === roundToHundredth(game.bets.bottom)
) {
  return;
}

const other: Seat = seat === "top" ? "bottom" : "top";

setToAct(other);
  }

  function actCall(seat: Seat) {
  if (handResult.status !== "playing") return;

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
}

if (street !== 0 && callerWillBeAllIn && bettor) {
  setShowdownFirst(bettor);

}

    logAction(
  seat,
  `Calls ${formatBB(add)}bb`,
  roundToHundredth(displayGame.pot + displayGame.bets.top + displayGame.bets.bottom + add)
);
    setSawCallThisStreet(true);
    setActionsThisStreet((n: number) => n + 1);

    if (lastToActAfterAggro === seat) {
      setLastToActAfterAggro(null);

    }

    // If this is a river call facing a bet, bettor must show first
if (street === 5 && currentFacingBet(seat)) {
  const bettor = streetBettor;
  if (bettor) {
    setShowdownFirst(bettor);
  }
}

    const other: Seat = seat === "top" ? "bottom" : "top";

    setToAct(other);
  }

  function actBetRaiseTo(seat: Seat, targetTotalBet: number) {
  if (handResult.status !== "playing") return;

  const other: Seat = seat === "top" ? "bottom" : "top";
  const mySeatBet = displayGame.bets[seat];
  const otherSeatBet = displayGame.bets[other];
  const myStack = displayGame.stacks[seat];
  const otherStack = displayGame.stacks[other];

  const isFacing = otherSeatBet > mySeatBet;

  // Calculate minimum raise according to NLHE rules:
  // - If facing a bet/raise: must raise by at least the size of the previous raise
  // - If opening (no bet): minimum is BB
  let minTarget: number;
  
  // Use the correct lastRaiseSize from multiplayer state if available
  const effectiveLastRaiseSize = multiplayerActive && mpState ? mpState.lastRaiseSize : lastRaiseSize;
  
  // Calculate blind notice using correct hand ID
  const effectiveHandId = multiplayerActive && mpState ? mpState.handId : handId;
  const effectiveHandNo = effectiveHandId + 1;
  const withinBlock = ((effectiveHandNo - 1) % GAME_CONFIG.BLINDS_INCREASE_EVERY_N_HANDS) + 1;
  let blindNotice: string | null = null;
  
  if (withinBlock >= GAME_CONFIG.WARNING_STARTS_AT_HAND && withinBlock <= GAME_CONFIG.BLINDS_INCREASE_EVERY_N_HANDS) {
    const remaining = (GAME_CONFIG.BLINDS_INCREASE_EVERY_N_HANDS + 1) - withinBlock;
    blindNotice =
      remaining === 1
        ? "Blinds will change next hand"
        : `Blinds will change in ${remaining} hands`;
  }
  
  if (isFacing) {
    // The previous raise size is stored in lastRaiseSize
    // Min raise = opponent's current bet + lastRaiseSize
    minTarget = roundToHundredth(otherSeatBet + effectiveLastRaiseSize);
  } else {
    // Opening bet: minimum is BB
    minTarget = BB;
  }

  // Maximum we can bet is our total chips
  const maxPossible = roundToHundredth(mySeatBet + myStack);
  
  // Effective maximum: opponent can only call up to their stack
  const maxEffective = roundToHundredth(Math.min(maxPossible, otherSeatBet + otherStack));

  // If we can't meet the minimum raise, we can only call or go all-in
  const canMeetMinRaise = maxEffective >= minTarget;
  
  // If opponent is all-in and we're just matching, that's a call
  const isJustCalling = isFacing && roundToHundredth(maxEffective) === roundToHundredth(otherSeatBet);
  
  if (isJustCalling) {
    actCall(seat);
    return;
  }

  // Determine final target
  let target: number;
  
  if (!canMeetMinRaise) {
    // Can't meet min raise, so go all-in
    target = maxEffective;
  } else {
    // Clamp between min and max
    target = roundToHundredth(clamp(targetTotalBet, minTarget, maxEffective));
  }

  // If somehow we end up matching opponent's bet exactly, that's a call
  if (isFacing && roundToHundredth(target) === roundToHundredth(otherSeatBet)) {
    actCall(seat);
    return;
  }

  const chipsToAdd = roundToHundredth(target - mySeatBet);
  if (chipsToAdd <= 0) return;

  // Update game state
  setGame((prev) => ({
    ...prev,
    stacks: {
      ...prev.stacks,
      [seat]: roundToHundredth(prev.stacks[seat] - chipsToAdd),
    } as GameState["stacks"],
    bets: {
      ...prev.bets,
      [seat]: target,
    } as GameState["bets"],
  }));

  // Calculate the NEW raise size for the next player
  const newRaiseSize = isFacing 
    ? roundToHundredth(target - otherSeatBet)
    : target;
  
  setLastRaiseSize(newRaiseSize);

  // Log the action
  const actionText = isFacing ? `Raises to ${formatBB(target)}bb` : `Bets ${formatBB(target)}bb`;
  logAction(seat, actionText, roundToHundredth(displayGame.pot + displayGame.bets.top + displayGame.bets.bottom + chipsToAdd));

  setStreetBettor(seat);
  setActionsThisStreet((n: number) => n + 1);
  setChecked({ top: false, bottom: false });
  setLastAggressor(seat);
  setLastToActAfterAggro(other);
  setToAct(other);
}

    type GameAction =
    | { type: "FOLD" }
    | { type: "CHECK" }
    | { type: "CALL" }
    | { type: "BET_RAISE_TO"; to: number };

  function dispatchAction(action: GameAction) {
  // In multiplayer mode, use the controllers
  if (multiplayerActive && mpState) {
    const seat: Seat = mySeat;
    
    if (mpState.handResult.status !== "playing") return;
    if (mpState.toAct !== seat) return;
    
    if (isHost && mpHost) {
      // HOST: Process action directly
      mpHost.processAction(seat, action);
      // Update our display
      setMpState(JSON.parse(JSON.stringify(mpHost.getState())));
    } else if (mpJoiner) {
      // JOINER: Send action to host
      mpJoiner.sendAction(seat, action);
    }
    return;
  }
  
  // Single-player mode (keep your existing logic)
  if (handResult.status !== "playing") return;
  if (gameOverRef.current) return;
  if (toAct !== mySeat) return;
  
  switch (action.type) {
    case "FOLD":
      actFold(mySeat);
      return;
    case "CHECK":
      actCheck(mySeat);
      return;
    case "CALL":
      actCall(mySeat);
      return;
    case "BET_RAISE_TO":
      actBetRaiseTo(mySeat, action.to);
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

// Capture hand history snapshot when hand ends in multiplayer
useEffect(() => {
  if (!multiplayerActive || !mpState) return;
  if (mpState.handResult.status !== "ended") return;
  
  console.log('CAPTURING SNAPSHOT for handId:', mpState.handId);
  
  // Extract cards from perspective
  const myCards = mySeat === "bottom" 
    ? [displayCards?.[2], displayCards?.[3]]
    : [displayCards?.[0], displayCards?.[1]];
  
  const oppCards = mySeat === "bottom"
    ? [displayCards?.[0], displayCards?.[1]]
    : [displayCards?.[2], displayCards?.[3]];
  
  if (!myCards[0] || !myCards[1] || !oppCards[0] || !oppCards[1]) return;
  
  // Calculate best 5-card hands if hand went to showdown
  let heroBest5: Card[] | undefined;
  let oppBest5: Card[] | undefined;
  let heroHandDesc: string | undefined;
  let oppHandDesc: string | undefined;
  
  if (mpState.street >= 3 && mpState.handResult.reason === "showdown") {
    const finalBoard = board.slice(0, mpState.street);
    const hero7 = [myCards[0], myCards[1], ...finalBoard];
    const opp7 = [oppCards[0], oppCards[1], ...finalBoard];
    
    heroBest5 = sortBest5ForDisplay(best5From7(hero7));
    oppBest5 = sortBest5ForDisplay(best5From7(opp7));
    
    const heroScore = evaluate7(hero7);
    const oppScore = evaluate7(opp7);
    
    heroHandDesc = handDesc(heroScore);
    oppHandDesc = handDesc(oppScore);
  }
  
  // Determine if hero and opponent showed by checking action log
  const heroShown = (() => {
    // You ALWAYS see your own cards in hand history (for review purposes)
    return true;
  })();
  
  // oppRevealed is from host's perspective (host = bottom, so oppRevealed = top showed)
  // If I'm top (joiner), then oppRevealed means I showed, not opponent
  // If I'm bottom (host), then oppRevealed means opponent showed
  const oppShown = (
    // At showdown, check if opponent was required to show
    (mpState.handResult.reason === "showdown" && (
      mySeat === "bottom" 
        ? mpState.oppRevealed  // I'm host: oppRevealed = top showed = opponent showed
        : !mpState.youMucked   // I'm joiner: youMucked = bottom mucked = opponent mucked, so !youMucked = opponent showed
    ))
    // OR if opponent clicked Show Hand button
    || (mySeat === "bottom" ? mpState.topShowed : mpState.bottomShowed)
  );
  
  const snap: HandLogSnapshot = {
    handNo: mpState.handId,
    dealer: mpState.dealerSeat,
    endedStreet: mpState.street,
    endedBoard: board.slice(0, mpState.street),
    log: mpState.actionLog,
    
    heroPos: mpState.dealerSeat === mySeat ? "SB" : "BB",
    oppPos: mpState.dealerSeat === mySeat ? "BB" : "SB",
    
    heroCards: RANK_TO_VALUE[myCards[0].rank] >= RANK_TO_VALUE[myCards[1].rank]
      ? [myCards[0], myCards[1]]
      : [myCards[1], myCards[0]],
    
    oppCards: RANK_TO_VALUE[oppCards[0].rank] >= RANK_TO_VALUE[oppCards[1].rank]
      ? [oppCards[0], oppCards[1]]
      : [oppCards[1], oppCards[0]],
    
    heroShown,
    oppShown,
    
    heroStartStack: mpState.handStartStacks[mySeat],
    oppStartStack: mpState.handStartStacks[mySeat === "bottom" ? "top" : "bottom"],
    
    heroBest5,
    oppBest5,
    heroHandDesc,
    oppHandDesc,
  };
  
  setHandLogHistory((prev) => {
    // Update existing snapshot if it exists for this hand (to capture show actions), otherwise add new one
    if (prev.length > 0 && prev[0]?.handNo === snap.handNo) {
      // Only update if the action log actually changed (has more actions)
      const prevActionCount = prev[0].log.length;
      const newActionCount = snap.log.length;
      
      if (newActionCount > prevActionCount) {
        console.log('Updating hand history snapshot:', snap.handNo + 1, 'actions:', prevActionCount, '→', newActionCount);
        // Replace the first (most recent) snapshot with updated version that includes new actions
        return [snap, ...prev.slice(1)];
      }
      // No change in action count, don't update
      return prev;
    }
    console.log('Saving hand history snapshot:', snap.handNo + 1);
    return [snap, ...prev].slice(0, 30);
  });
}, [mpState?.handResult.status, mpState?.actionLog?.length, multiplayerActive, mySeat, displayCards, board]);

// auto next hand 5 seconds after hand ends
useEffect(() => {
  const currentHandResult = multiplayerActive && mpState ? mpState.handResult : handResult;
  
  if (currentHandResult.status !== "ended") return;

  // Snapshot hand history when hand ends (for both host and joiner)
  if (multiplayerActive && mpState && cards) {
    // Create snapshot from mpState
    const endedSt = mpState.street;
    const board = cards.slice(4, 9);
    
    const myCards = mySeat === "bottom" ? [cards[2], cards[3]] : [cards[0], cards[1]];
    const oppCards = mySeat === "bottom" ? [cards[0], cards[1]] : [cards[2], cards[3]];
    
    const snap: HandLogSnapshot = {
      handNo: mpState.handId,
      dealer: mpState.dealerSeat,
      endedStreet: endedSt,
      endedBoard: board.slice(0, endedSt),
      log: mpState.actionLog,
      heroPos: (mpState.dealerSeat === mySeat ? "SB" : "BB") as "SB" | "BB",
      oppPos: (mpState.dealerSeat === mySeat ? "BB" : "SB") as "SB" | "BB",
      heroCards: myCards.sort((a, b) => RANK_TO_VALUE[b.rank] - RANK_TO_VALUE[a.rank]) as [Card, Card],
      oppCards: oppCards.sort((a, b) => RANK_TO_VALUE[b.rank] - RANK_TO_VALUE[a.rank]) as [Card, Card],
      heroShown: true,
      oppShown: mpState.oppRevealed,
      heroStartStack: mpState.handStartStacks[mySeat],
      oppStartStack: mpState.handStartStacks[mySeat === "bottom" ? "top" : "bottom"],
    };
    
    setHandLogHistory((prev: HandLogSnapshot[]) => {
      // Don't add duplicate snapshots for the same hand
if (prev.length > 0 && prev[0]?.handNo === snap.handNo) return prev;
console.log('Saving hand history snapshot:', snap.handNo + 1);
return [snap, ...prev].slice(0, 30);
    });
  } else if (!multiplayerActive) {
    // Single player snapshot (existing logic)
    setTimeout(() => snapshotCurrentHandLog(), 0);
  }

 // Check for game over from multiplayer state or local state
  const effectiveGameOver = (multiplayerActive && mpState) ? mpState.gameOver : gameOver;
  
  if (effectiveGameOver || gameOverRef.current) {
    if (nextHandTimerRef.current) {
      window.clearTimeout(nextHandTimerRef.current);
      nextHandTimerRef.current = null;
    }
    return;
  }

  // Only host starts the next hand in multiplayer
  if (multiplayerActive && !isHost) return;

  if (nextHandTimerRef.current) window.clearTimeout(nextHandTimerRef.current);
 nextHandTimerRef.current = window.setTimeout(() => {
  if (multiplayerActive && isHost && mpHost) {
    // Check one more time before starting
    const currentState = mpHost.getState();
    if (!currentState) return;

    if (currentState.game.stacks.top > 0 && currentState.game.stacks.bottom > 0) {
      mpHost.startHand();
      setMpState(JSON.parse(JSON.stringify(mpHost.getState())));
    }
    return;
  }

  if (!multiplayerActive) {
    startNewHand();
  }
}, 8000);


  return () => {
    if (nextHandTimerRef.current) {
      window.clearTimeout(nextHandTimerRef.current);
      nextHandTimerRef.current = null;
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [multiplayerActive, isHost, mpHost, mpState?.handResult.status, handResult.status, mySeat, cards]);

// Always clear betSize when it becomes our turn or when street/betting changes
useEffect(() => {
  if (displayToAct !== mySeat) return;
  if (displayHandResult.status !== "playing") return;
  
  // Clear input box on every turn
  setBetSize("");
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [displayToAct, mySeat, displayStreet, displayGame.bets.top, displayGame.bets.bottom]);

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
    <main className="relative flex min-h-screen items-center justify-center bg-black px-6">

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
        className="text-sm min-[1536px]:max-[1650px]:text-xs font-semibold text-white underline opacity-90 hover:opacity-100"
      >
        {studentProfile.firstName} {studentProfile.lastName}
      </button>

      {studentMenuOpen && (
        <div className="absolute right-0 mt-2 w-40 min-[1536px]:max-[1650px]:w-32 rounded-xl min-[1536px]:max-[1650px]:rounded-lg border bg-white shadow-md">
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

            className="w-full flex items-center px-4 py-2 min-[1536px]:max-[1650px]:px-3 min-[1536px]:max-[1650px]:py-1.5 text-left text-sm min-[1536px]:max-[1650px]:text-xs font-semibold text-black hover:bg-gray-100"
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
    className="text-sm min-[1536px]:max-[1650px]:text-xs font-semibold text-white underline opacity-80 hover:opacity-100"
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
        className="text-sm min-[1536px]:max-[1650px]:text-xs font-semibold text-white underline opacity-80 hover:opacity-100"
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
        className="text-sm min-[1536px]:max-[1650px]:text-xs font-semibold text-white underline opacity-80 hover:opacity-100"
      >
        Sign up
      </button>
    </>
  ) : null
)}

</div>

      <div className="w-full max-w-xl min-[1536px]:max-[1650px]:max-w-[450px] flex flex-col">
        <h1 className="h-[44px] min-[1536px]:max-[1650px]:h-[34px] mb-8 min-[1536px]:max-[1650px]:mb-6 text-center text-3xl min-[1536px]:max-[1650px]:text-2xl font-bold leading-[44px] min-[1536px]:max-[1650px]:leading-[34px]">
          HeadsUp
        </h1>

      <div className="h-[220px] min-[1536px]:max-[1650px]:h-[180px] flex flex-col justify-start">

    {/* CREATE GAME PIN VIEW */}
{gamePin && !joinMode && (
  <div className="flex flex-col items-center gap-6">
    <div className="text-lg min-[1536px]:max-[1650px]:text-sm font-semibold tabular-nums">
      Game PIN: <span className="font-bold">{gamePin}</span>
    </div>

    <button
      onClick={clearPin}
      className={`${baseButton} py-4 min-[1536px]:max-[1650px]:py-3 text-base min-[1536px]:max-[1650px]:text-xs max-w-sm min-[1536px]:max-[1650px]:max-w-[280px]`}
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
        onKeyDown={(e) => {
          if (e.key === "Enter" && joinPinInput.length === 4) {
            joinPinGame();
          }
        }}
        placeholder="Enter Game PIN"
        className="w-full max-w-xs min-[1536px]:max-[1650px]:max-w-[224px] rounded-xl min-[1536px]:max-[1650px]:rounded-lg border px-4 py-3 min-[1536px]:max-[1650px]:px-3 min-[1536px]:max-[1650px]:py-2 text-center text-lg min-[1536px]:max-[1650px]:text-sm tracking-widest tabular-nums"
      />

      <button
  onClick={joinPinGame}
  disabled={joinPinInput.length !== 4}
  className={`${baseButton} py-4 min-[1536px]:max-[1650px]:py-3 text-base min-[1536px]:max-[1650px]:text-xs max-w-sm min-[1536px]:max-[1650px]:max-w-[280px] ${
    joinPinInput.length !== 4 ? "opacity-50 pointer-events-none" : ""
  }`}
>
  Join game
</button>

<button
  onClick={clearPin}
  className={`${baseButton} py-4 min-[1536px]:max-[1650px]:py-3 text-base min-[1536px]:max-[1650px]:text-xs max-w-sm min-[1536px]:max-[1650px]:max-w-[280px]`}
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
    min-[1536px]:max-[1650px]:py-7
    text-xl
    min-[1536px]:max-[1650px]:text-base
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
    min-[1536px]:max-[1650px]:py-7
    text-xl
    min-[1536px]:max-[1650px]:text-base
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
    <main className="relative flex min-h-screen items-center justify-center bg-black px-6 min-[1536px]:max-[1650px]:scale-[0.85] min-[1536px]:max-[1650px]:origin-center">
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
    <main className="relative flex min-h-screen items-center justify-center bg-black px-6 min-[1536px]:max-[1650px]:scale-[0.85] min-[1536px]:max-[1650px]:origin-center">
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
   <main className="flex min-h-screen justify-center bg-black px-6 pt-16 min-[1536px]:max-[1650px]:scale-[0.85] min-[1536px]:max-[1650px]:origin-center">
  <div className="w-full max-w-[96rem]">
       <div className="mb-2 flex items-center justify-center gap-4">
  <h1 className="text-3xl font-bold">Student dashboard</h1>

  <button
  type="button"
  onClick={() => {
  if (!multiplayerActive) {
    resetGame();
  }
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
   <main className="flex min-h-screen justify-center bg-black px-6 pt-16 min-[1536px]:max-[1650px]:scale-[0.85] min-[1536px]:max-[1650px]:origin-center">
  <div className="w-full max-w-[96rem]">
       <div className="mb-2 flex items-center justify-center gap-4">
  <h1 className="text-3xl font-bold">Professional Dashboard</h1>

  <button
  type="button"
  onClick={() => {
  if (!multiplayerActive) {
    resetGame();
  }
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
    "absolute -bottom-3 -right-3 min-[1536px]:max-[1650px]:-bottom-2 min-[1536px]:max-[1650px]:-right-3 flex h-10 w-10 min-[1536px]:max-[1650px]:h-8 min-[1536px]:max-[1650px]:w-8 items-center justify-center rounded-full border bg-white text-[20px] min-[1536px]:max-[1650px]:text-[16px] font-bold text-black shadow-sm";
  const dealerChipBottom =
    "absolute -top-3 -left-3 min-[1536px]:max-[1650px]:-top-2 min-[1536px]:max-[1650px]:-left-3 flex h-10 w-10 min-[1536px]:max-[1650px]:h-8 min-[1536px]:max-[1650px]:w-8 items-center justify-center rounded-full border bg-white text-[20px] min-[1536px]:max-[1650px]:text-[16px] font-bold text-black shadow-sm";

  const streetLabel = streetNameFromCount(street);

  const facingBetBottom = displayGame.bets[oppActualSeat] > displayGame.bets[myActualSeat];
  // Cap call amount to my remaining stack
  const bottomCallAmt = roundToHundredth(
    Math.min(
      Math.max(0, displayGame.bets[oppActualSeat] - displayGame.bets[myActualSeat]),
      displayGame.stacks[myActualSeat]
    )
  );

  const effectiveLastRaiseSize = multiplayerActive && mpState ? mpState.lastRaiseSize : lastRaiseSize;
  
  // When not facing a bet/raise
  const bottomMinRaise = facingBetBottom 
    ? roundToHundredth(displayGame.bets[oppActualSeat] + effectiveLastRaiseSize)
    : (displayStreet === 0 && displayGame.bets[myActualSeat] > 0 && displayGame.bets[oppActualSeat] > 0)
      ? roundToHundredth(Math.max(displayGame.bets[myActualSeat], displayGame.bets[oppActualSeat]) + BB)
      : BB;
  
  // Cap max bet to what opponent can actually call (effective stack)
  const bottomMaxTo = roundToHundredth(
    Math.min(
      displayGame.bets[myActualSeat] + displayGame.stacks[myActualSeat],  // My total chips
      displayGame.bets[oppActualSeat] + displayGame.stacks[oppActualSeat]  // Opponent's total chips
    )
  );

  const defaultTo = facingBetBottom
    ? bottomMinRaise
    : roundToHundredth((displayGame.pot + displayGame.bets.top + displayGame.bets.bottom) * 0.5);

  // Opening action logic
  const isOpeningAction = displayGame.bets[myActualSeat] === 0 && displayGame.bets[oppActualSeat] === 0;
  const effectiveBetSize = betSize === "" ? bottomMinRaise : betSize;
  const safeBetSize = Math.max(effectiveBetSize, bottomMinRaise);
  
  // Display value: preflop opening defaults to 2BB, postflop opening defaults to 1BB
  const openingDefault = (displayStreet === 0 && isOpeningAction) ? 2 : (isOpeningAction && displayStreet > 0 ? 1 : bottomMinRaise);
  const displayBetSize = (betSize === "" || betSize < bottomMinRaise) 
    ? openingDefault
    : betSize;

  const heroPosLabel = viewingSnapshot
  ? viewingSnapshot.heroPos
  : dealerSeat === mySeat ? "SB/D" : "BB";

const oppPosLabel = viewingSnapshot
  ? viewingSnapshot.oppPos
  : dealerSeat === mySeat ? "BB" : "SB/D";

  // Get hand start stacks (before blinds posted)
  const displayHandStartStacks = multiplayerActive && mpState 
    ? mpState.handStartStacks 
    : handStartStacks;
  
  const heroStartStack = viewingSnapshot 
    ? viewingSnapshot.heroStartStack 
    : displayHandStartStacks[myActualSeat];
  
  const oppStartStack = viewingSnapshot 
    ? viewingSnapshot.oppStartStack 
    : displayHandStartStacks[oppActualSeat];

const displayedActionLog = viewingSnapshot ? viewingSnapshot.log : displayActionLog;
console.log('UI displayedActionLog:', displayedActionLog);

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
  
  if (multiplayerActive && isHost) {
    // In multiplayer, only host can reset and broadcasts to joiner
    resetGame();
  } else if (!multiplayerActive) {
    // Single player can always reset
    resetGame();
  }
  // Joiner cannot reset in multiplayer - do nothing
}}
/>

<ConfirmModal
  open={showFoldConfirm}
  title="Fold hand?"
  message="Are you sure you would like to fold? If you fold, you will forfeit your share of the pot."
  cancelText="Go back"
  confirmText="Fold"
  onCancel={() => setShowFoldConfirm(false)}
  onConfirm={() => {
    setShowFoldConfirm(false);
    dispatchAction({ type: "FOLD" });
  }}
/>

<ConfirmModal
  open={showTitleScreenConfirm}
  title="Go to Title Screen?"
  message="Are you sure you'd like to go to the Title Screen? If you do, the game will end and stack sizes and positions will reset."
  cancelText="Go back"
  confirmText="Confirm"
  onCancel={() => setShowTitleScreenConfirm(false)}
  onConfirm={() => {
    setShowTitleScreenConfirm(false);
    
    // Cleanup multiplayer and broadcast quit
    if (mpHost) {
      mpHost.destroy();
      setMpHost(null);
    }
    if (mpJoiner) {
      mpJoiner.destroy();
      setMpJoiner(null);
    }
    setMultiplayerActive(false);
    setOpponentQuit(false);
    
    clearTimers();
    clearPin();
    setGamePin(null);
    setJoinMode(false);
    setJoinPinInput("");
    setOtherStudents([]);
    setOtherProfessionals([]);
    setScreen("role");
  }}
/>

      <main className="relative flex items-center justify-center bg-black px-6 py-1 overflow-y-auto" style={{ minHeight: '100vh' }}>
      {((multiplayerActive && mpState?.gameOver) || (!multiplayerActive && gameOver)) && !playAgainRequested && (
  <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50">
    <button
      onClick={() => setPlayAgainRequested(true)}
      className="rounded-2xl min-[1536px]:max-[1650px]:rounded-xl border border-black bg-white px-6 py-2 min-[1536px]:max-[1650px]:px-4 min-[1536px]:max-[1650px]:py-1.5 text-sm min-[1536px]:max-[1650px]:text-xs font-semibold text-black shadow-sm hover:bg-gray-50"
    >
      Play Again?
    </button>
  </div>
)}

{((multiplayerActive && mpState?.gameOver) || (!multiplayerActive && gameOver)) && playAgainRequested && (
  <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 rounded-2xl min-[1536px]:max-[1650px]:rounded-xl border border-black bg-white px-6 py-2 min-[1536px]:max-[1650px]:px-4 min-[1536px]:max-[1650px]:py-1.5 text-sm min-[1536px]:max-[1650px]:text-xs font-semibold text-black shadow-sm">
    Invited &quot;Opponent&quot; to play again, waiting for &quot;Opponent&apos;s&quot; response...
  </div>
)}

{/* Show Hand Button */}
{displayHandResult.status === "ended" && 
 canIShow &&
 !didIShow && 
 !((multiplayerActive && mpState?.gameOver) || (!multiplayerActive && gameOver)) && (
  <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50">
    <button
      onClick={() => {
        if (multiplayerActive && isHost && mpHost) {
          mpHost.showHand(mySeat);
          setMpState(JSON.parse(JSON.stringify(mpHost.getState())));
        } else if (multiplayerActive && mpJoiner) {
          mpJoiner.sendShowHand(mySeat);
        } else {
          // Single player - update local state
          if (mySeat === "top") {
            setTopShowed(true);
          } else {
            setBottomShowed(true);
          }
          
          if (youC && youD) {
            logAction(mySeat, `Shows ${cardStr(youC)} ${cardStr(youD)}`);
          }
        }
      }}
      className="rounded-2xl min-[1536px]:max-[1650px]:rounded-xl border border-black bg-white px-6 py-2 min-[1536px]:max-[1650px]:px-4 min-[1536px]:max-[1650px]:py-1.5 text-sm min-[1536px]:max-[1650px]:text-xs font-semibold text-black shadow-sm hover:bg-gray-50"
    >
      Show Hand
    </button>
  </div>
)}

      {blindNotice && 
       displayHandResult.status === "playing" && 
       !((multiplayerActive && mpState?.gameOver) || (!multiplayerActive && gameOver)) ? (
  <div className="absolute top-6 left-1/2 -translate-x-1/2 text-sm min-[1536px]:max-[1650px]:text-xs font-semibold text-white">
    {blindNotice}
  </div>
) : null}
        <div className="w-full max-w-6xl">
          <div className="mb-3 md:mb-6 min-[1536px]:max-[1650px]:mb-2 flex items-center justify-between">
            <div>
              <h1 className="text-2xl min-[1536px]:max-[1650px]:text-xl font-bold text-white">HeadsUp</h1>
              <div className="text-sm min-[1536px]:max-[1650px]:text-xs text-white opacity-80 tabular-nums">
                Pot: {formatBB(roundToHundredth(displayGame.pot + displayGame.bets.top + displayGame.bets.bottom))}{" "}
                BB <span className="opacity-60">·</span> {streetLabel}{" "}
                <span className="opacity-60">·</span>{" "}
                <span className="opacity-90">
  {opponentQuit
    ? "Opponent Quit!"
    : displayHandResult.status === "playing"
    ? displayToAct === mySeat
      ? "Your turn"
      : "Opponent thinking…"
    : ((multiplayerActive && mpState?.gameOver) || (!multiplayerActive && gameOver))
      ? (displayGame.stacks[myActualSeat] <= 0
          ? "Game over — Opponent wins"
          : "Game over — You win")
      : "Hand ended (next hand in 8s)"}
</span>
              </div>
              {handResult.message ? (
                <div className="mt-1 text-sm min-[1536px]:max-[1650px]:text-xs text-white opacity-90">{handResult.message}</div>
              ) : null}
            </div>

            <div className="flex items-center gap-4 min-[1536px]:max-[1650px]:gap-3">

  {studentProfile.email && !gamePin && (
  <button
type="button"
onClick={() =>
setScreen(seatedRole === "professional" ? "professionalDashboard" : "dashboard")
}
className="text-sm min-[1536px]:max-[1650px]:text-xs text-white underline opacity-80 hover:opacity-100"
>
    Dashboard
</button>
)}

  <button
    type="button"
    onClick={() => {
      if (opponentQuit) {
        // Opponent already quit, go directly to title screen
        if (mpHost) {
          mpHost.destroy();
          setMpHost(null);
        }
        if (mpJoiner) {
          mpJoiner.destroy();
          setMpJoiner(null);
        }
        setMultiplayerActive(false);
        setOpponentQuit(false);
        clearTimers();
        clearPin();
        setGamePin(null);
        setJoinMode(false);
        setJoinPinInput("");
        setOtherStudents([]);
        setOtherProfessionals([]);
        setScreen("role");
      } else {
        // Show confirmation modal
        setShowTitleScreenConfirm(true);
      }
    }}
    className="text-sm min-[1536px]:max-[1650px]:text-xs text-white underline opacity-80 hover:opacity-100"
  >
    Title screen
  </button>

{opponentQuit && (
<div className="text-sm min-[1536px]:max-[1650px]:text-xs text-white opacity-90">
      Opponent Quit, Go To Title Screen
</div>
  )}

</div>
          </div>

          {/* ACTION LOG pinned left + TABLE centered */}
          <div className="relative mt-6 w-full">
            {/* LEFT: ACTION LOG */}
<div className="absolute -left-28 md:-left-36 min-[1536px]:max-[1650px]:!-left-[102px] top-0 w-[420px] md:w-[500px] min-[1536px]:max-[1650px]:w-[390px] rounded-3xl min-[1536px]:max-[1650px]:rounded-2xl border border-white/10 bg-black/20 p-3 md:p-4 min-[1536px]:max-[1650px]:p-2 text-white text-left">
 {/* Header row (matches your target screenshot) */}
<div className="mb-6 min-[1536px]:max-[1650px]:mb-4 relative flex w-full items-center gap-4 min-[1536px]:max-[1650px]:gap-3">
  {/* arrows */}
  <div className="flex items-center gap-2 shrink-0">
    <button
      type="button"
      className="rounded border border-white/20 bg-white/10 px-2 py-0.5 min-[1536px]:max-[1650px]:px-1.5 min-[1536px]:max-[1650px]:py-0 text-xs min-[1536px]:max-[1650px]:text-[10px] hover:bg-white/20"
      onClick={() => setLogViewOffset((o) => Math.min(o + 1, handLogHistory.length))}
    >
      ◀
    </button>

    <button
      type="button"
      className="rounded border border-white/20 bg-white/10 px-2 py-0.5 min-[1536px]:max-[1650px]:px-1.5 min-[1536px]:max-[1650px]:py-0 text-xs min-[1536px]:max-[1650px]:text-[10px] hover:bg-white/20"
      onClick={() => setLogViewOffset((o) => Math.max(o - 1, 0))}
    >
      ▶
    </button>
  </div>

  {/* Action + stacks: glued right after arrows */}
  <div className="flex items-baseline gap-3 min-[1536px]:max-[1650px]:gap-2 min-w-0">
    <div className="text-sm min-[1536px]:max-[1650px]:text-xs font-semibold text-white whitespace-nowrap">Action</div>

    <div className="text-xs min-[1536px]:max-[1650px]:text-[10px] font-normal text-white/70 tabular-nums whitespace-nowrap">
      {viewingSnapshot
        ? `You (${viewingSnapshot.heroPos}) ${formatBB(viewingSnapshot.heroStartStack)}bb · Opponent (${viewingSnapshot.oppPos}) ${formatBB(viewingSnapshot.oppStartStack)}bb`
        : `You (${heroPosLabel}) ${formatBB(heroStartStack)}bb · Opponent (${oppPosLabel}) ${formatBB(oppStartStack)}bb`}
    </div>
  </div>

  {/* Current hand pinned right */}
  <div className="absolute right-4 min-[1536px]:max-[1650px]:right-2 top-1/2 -translate-y-1/2 text-xs min-[1536px]:max-[1650px]:text-[10px] text-white/70 tabular-nums whitespace-nowrap">
  {logViewOffset === 0
    ? `Hand #${(multiplayerActive && mpState ? mpState.handId : handId) + 1}`
    : `Hand #${(handLogHistory[logViewOffset - 1]?.handNo ?? 0) + 1}`}
</div>
</div>

  {/* Card summary - shown for both current hand (if ended) and history */}
{(viewingSnapshot || displayHandResult.status === "ended") ? (
  <div className="mb-3 min-[1536px]:max-[1650px]:mb-2 flex flex-col gap-2 min-[1536px]:max-[1650px]:gap-1">
    <div className="flex items-start gap-4 min-[1536px]:max-[1650px]:gap-2">
      <div className="flex flex-col gap-1 text-xs min-[1536px]:max-[1650px]:text-[10px] text-white/70 whitespace-nowrap">
        <div>
          You:{" "}
          {viewingSnapshot ? (
            `${cardStr(viewingSnapshot.heroCards[0])} ${cardStr(viewingSnapshot.heroCards[1])}`
          ) : (
            // Current hand display - always show your cards
            youC && youD
              ? renderActionText(`${cardStr(youC)} ${cardStr(youD)}`)
              : "No cards"
          )}
          {viewingSnapshot?.heroBest5 && (
            <span className="ml-2 opacity-60">
              → {viewingSnapshot.heroBest5.map(cardStr).join(" ")}
            </span>
          )}
        </div>

        <div>
          Opponent:{" "}
          {viewingSnapshot ? (
            viewingSnapshot.oppShown
              ? <>{renderActionText(`${cardStr(viewingSnapshot.oppCards[0])} ${cardStr(viewingSnapshot.oppCards[1])}`)}</>
              : viewingSnapshot.log.some(
                  (it) => it.seat === oppActualSeat && /fold/i.test(it.text)
                )
              ? "Folded"
              : "Mucked"
          ) : (
            // Current hand display
            displayHandResult.status === "ended" && (
              // Showdown: check if opponent was required to show
              (displayHandResult.reason === "showdown" && (
                mySeat === "bottom" 
                  ? displayOppRevealed
                  : !displayYouMucked
              ))
              // OR opponent clicked Show Hand button
              || didOppShow
            ) && oppA && oppB
              ? renderActionText(`${cardStr(oppA)} ${cardStr(oppB)}`)
              : displayActionLog.some((it) => it.seat === oppActualSeat && /fold/i.test(it.text))
              ? "Folded"
              : "Mucked"
          )}
          {viewingSnapshot?.oppShown && viewingSnapshot.oppBest5 && (
            <span className="ml-2 opacity-60">
              → {renderActionText(viewingSnapshot.oppBest5.map(cardStr).join(" "))}
            </span>
          )}
        </div>
      </div>
    
    {viewingSnapshot?.heroHandDesc && (
      <div className="text-xs text-white/60 pl-1">
        You: {viewingSnapshot.heroHandDesc}
      </div>
    )}
    {viewingSnapshot?.oppShown && viewingSnapshot.oppHandDesc && (
      <div className="text-xs text-white/60 pl-1">
        Opponent: {viewingSnapshot.oppHandDesc}
      </div>
    )}
  </div>

    <div className="flex items-center gap-2 min-w-0 overflow-hidden">
      {viewingSnapshot ? (
        displayedHistoryBoard.map((c, i) => (
          <div key={i} className="scale-[0.75] origin-left shrink-0">
            <CardTile card={c} />
          </div>
        ))
      ) : (
        board.slice(0, displayStreet).map((c, i) => (
          <div key={i} className="scale-[0.75] origin-left shrink-0">
            <CardTile card={c} />
          </div>
        ))
      )}
    </div>
  </div>
) : null}

{/* Log list */}
{displayedActionLog.length === 0 ? (
  <div className="text-sm min-[1536px]:max-[1650px]:text-xs opacity-70">—</div>
) : (
  <div className="max-h-[calc(100vh-220px)] min-[1536px]:max-[1650px]:max-h-[calc(100vh-180px)] w-full overflow-auto pr-1">
    <div className="w-full text-sm min-[1536px]:max-[1650px]:text-xs">
      {displayedActionLog.slice(-30).map((a) => (
        <div
          key={a.id}
          className="grid w-full grid-cols-[1fr_1fr_1fr] items-center py-2 leading-none"
        >
          <div
            className="text-center text-xs min-[1536px]:max-[1650px]:text-[10px] uppercase tracking-wide text-white/60 -translate-x-4.5 leading-none"
            style={{ paddingTop: "3px" }}
          >
            {a.street}
          </div>

          <div
            className="text-center font-semibold text-white leading-none min-[1536px]:max-[1650px]:text-xs"
            style={{ marginLeft: "-56px" }}
          >
            {a.seat === myActualSeat ? `You (${heroPosLabel})` : `Opponent (${oppPosLabel})`}
          </div>

          <div className="text-center text-white/90 tabular-nums break-words leading-none min-[1536px]:max-[1650px]:text-xs">
            {renderActionText(a.text)}
          </div>
        </div>
      ))}
    </div>
  </div>
)}

</div>

            {/* CENTER: TABLE */}
            <div className="mx-auto flex w-fit flex-col items-center gap-[60px] min-[1536px]:max-[1650px]:gap-[0px] min-[1651px]:gap-[60px] scale-[0.65] md:scale-[0.75] lg:scale-[0.85] xl:scale-100 origin-center">
              {/* TOP SEAT (Opponent) */}
              <div className="relative h-[260px] w-[216px] min-[1536px]:max-[1650px]:h-[200px] min-[1536px]:max-[1650px]:w-[170px] -translate-y-6 min-[1536px]:max-[1650px]:-translate-y-15 rounded-3xl border border-white/20 bg-black/50 text-center">
                {!amIDealer && <div className={dealerChipTop}>D</div>}

                <div className="absolute -bottom-14 min-[1536px]:max-[1650px]:-bottom-10 left-1/2 -translate-x-1/2">
                  <BetChip amount={oppBet} label={oppLabel} />
                </div>

                <div className="flex h-full flex-col justify-center">
                  <div className="-mt-3 min-[1536px]:max-[1650px]:-mt-2 text-sm min-[1536px]:max-[1650px]:text-xs uppercase text-white opacity-60">Opponent</div>
                  <div className="mt-2 min-[1536px]:max-[1650px]:mt-1 text-sm min-[1536px]:max-[1650px]:text-xs text-white">
                    Stack:{" "}
                    <span className="font-semibold tabular-nums">{formatBB(oppStack)}bb</span>
                  </div>

                  <div className="mt-4 min-[1536px]:max-[1650px]:mt-2 flex justify-center gap-3 min-[1536px]:max-[1650px]:gap-2">
                    {oppA && oppB ? (
                      // When viewing history, use snapshot's oppShown; otherwise use live state
                      (viewingSnapshot 
                        ? viewingSnapshot.oppShown 
                        : (displayHandResult.status === "ended" && (
                            // Showdown: check if opponent was required to show
                            (displayHandResult.reason === "showdown" && (
                              mySeat === "bottom" 
                                ? displayOppRevealed
                                : !displayYouMucked
                            ))
                            // OR opponent clicked Show Hand button
                            || didOppShow
                          ))
                      ) ? (
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
<div className="relative flex h-40 items-center justify-center">
  <div className="absolute flex gap-3 min-[1536px]:max-[1650px]:gap-2 top-[8px] min-[1536px]:max-[1650px]:top-[7px]">
    {board.slice(0, displayStreet).map((c, i) => (
      <CardTile key={i} card={c} />
    ))}
  </div>
</div>

              {/* BOTTOM SEAT (You) */}
              <div className="relative h-[260px] w-[216px] min-[1536px]:max-[1650px]:h-[200px] min-[1536px]:max-[1650px]:w-[170px] -translate-y-6 min-[1536px]:max-[1650px]:-translate-y-3 rounded-3xl border border-white/20 bg-black/50 text-center">
                {amIDealer && <div className={dealerChipBottom}>D</div>}

                <div className="absolute -top-14 min-[1536px]:max-[1650px]:-top-10 left-1/2 -translate-x-1/2">
                  <BetChip amount={myBet} label={myLabel} />
                </div>

                <div className="flex h-full flex-col justify-center">
                  <div className="text-sm min-[1536px]:max-[1650px]:text-xs uppercase text-white opacity-60">You</div>
                  <div className="text-xl min-[1536px]:max-[1650px]:text-base font-semibold capitalize text-white">{seatedRole}</div>

                  <div className="mt-2 min-[1536px]:max-[1650px]:mt-1 text-sm min-[1536px]:max-[1650px]:text-xs text-white">
                    Stack:{" "}
                    <span className="font-semibold tabular-nums">
                      {formatBB(myStack)}bb
                    </span>
                  </div>

                  <div className="mt-4 min-[1536px]:max-[1650px]:mt-2 flex flex-col items-center gap-2 min-[1536px]:max-[1650px]:gap-1">
                 <div className="flex justify-center gap-3">
                   {youC && youD ? (
                    // When viewing history, use snapshot's heroShown; otherwise use live state
                    (viewingSnapshot
                      ? !viewingSnapshot.heroShown
                      : false  // Always show your own cards on your screen
                    ) ? (
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
          {displayToAct === mySeat && displayHandResult.status === "playing" && (
            <div className="fixed bottom-4 md:bottom-6 right-4 md:right-6 z-50 flex w-[280px] md:w-[320px] min-[1536px]:max-[1650px]:w-[258px] flex-col gap-2 md:gap-3">
              {displayGame.stacks[myActualSeat] > bottomCallAmt && displayGame.stacks[oppActualSeat] > 0 && bottomMaxTo > bottomMinRaise && (
                <div className="rounded-2xl min-[1536px]:max-[1650px]:rounded-xl border bg-white p-3 min-[1536px]:max-[1650px]:p-1.5 min-[1536px]:max-[1650px]:py-2.5 text-black shadow-sm min-[1536px]:max-[1650px]:ml-auto min-[1536px]:max-[1650px]:w-[258px]">
                  <div className="mb-2 min-[1536px]:max-[1650px]:mb-1 flex items-center justify-between">
                    <div className="text-sm min-[1536px]:max-[1650px]:text-xs min-[1536px]:max-[1650px]:ml-1 font-semibold">{facingBetBottom ? "Raise to" : "Bet to"}</div>
                    <div className="text-sm min-[1536px]:max-[1650px]:text-xs min-[1536px]:max-[1650px]:mr-1 font-bold tabular-nums">{formatBB(displayBetSize)} BB</div>
                  </div>

                  <div className="flex items-center gap-3 min-w-0 min-[1536px]:max-[1650px]:justify-end">
                    <input
                      type="range"
                      min={bottomMinRaise}
                      max={bottomMaxTo}
                      step={0.01}
                      value={betSize === "" ? bottomMinRaise : Math.max(betSize, bottomMinRaise)}
                      onChange={(e) => setBetSizeRounded(Number(e.target.value))}
                      className="w-full min-[1536px]:max-[1650px]:w-[160px]"
                    />

                    <input
                      type="number"
                      step="0.01"
                      inputMode="decimal"
                      min={0.01}
                      max={bottomMaxTo}
                      value={betSize === "" ? "" : betSize}
                      placeholder=""
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === "") {
                          setBetSize("");
                        } else {
                          const num = Number(val);
                          // Allow any number up to max, don't enforce minimum during typing
                          if (num > 0) {
                            setBetSize(Math.min(num, bottomMaxTo));
                          }
                        }
                      }}
                      onBlur={() => {
                        // On blur, enforce minimum
                        if (betSize === "" || betSize < bottomMinRaise) {
                          setBetSizeRounded((displayStreet === 0 && isOpeningAction) ? 2 : bottomMinRaise);
                        } else {
                          setBetSizeRounded(Math.min(betSize, bottomMaxTo));
                        }
                      }}
                      className="w-24 min-[1536px]:max-[1650px]:w-19 rounded-xl min-[1536px]:max-[1650px]:rounded-lg border px-2 py-1 min-[1536px]:max-[1650px]:px-1.5 min-[1536px]:max-[1650px]:py-0.5 text-sm min-[1536px]:max-[1650px]:text-xs tabular-nums min-[1536px]:max-[1650px]:mr-2"
                    />
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-3 w-full">
                <button
  type="button"
  onClick={() => {
    // Determine if fold warning should show
    const facingBet = displayGame.bets[oppActualSeat] > displayGame.bets[myActualSeat];
    
    // Show warning when not facing a bet (can check for free)
    const shouldWarn = !facingBet;
    
    if (shouldWarn) {
      setShowFoldConfirm(true);
    } else {
      dispatchAction({ type: "FOLD" });
    }
  }}
  disabled={!(displayToAct === mySeat && displayHandResult.status === "playing")}
  className="h-[64px] w-[100px] min-[1536px]:max-[1650px]:h-[50px] min-[1536px]:max-[1650px]:w-[78px] rounded-2xl min-[1536px]:max-[1650px]:rounded-xl border bg-white px-4 py-3 min-[1536px]:max-[1650px]:px-3 min-[1536px]:max-[1650px]:py-2 text-sm min-[1536px]:max-[1650px]:text-xs font-semibold text-black shadow-sm hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
>
  Fold
</button>

               <button
  type="button"
  onClick={() =>
  dispatchAction(facingBetBottom ? { type: "CALL" } : { type: "CHECK" })
}
  disabled={!(displayToAct === mySeat && displayHandResult.status === "playing")}
  className="flex h-[64px] w-[100px] min-[1536px]:max-[1650px]:h-[50px] min-[1536px]:max-[1650px]:w-[78px] flex-col items-center justify-center rounded-2xl min-[1536px]:max-[1650px]:rounded-xl border bg-white px-4 py-3 min-[1536px]:max-[1650px]:px-3 min-[1536px]:max-[1650px]:py-2 text-sm min-[1536px]:max-[1650px]:text-xs font-semibold text-black shadow-sm hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
>
  <div>{facingBetBottom ? "Call" : "Check"}</div>

  {facingBetBottom && (
    <div className="mt-0.5 text-xs min-[1536px]:max-[1650px]:text-[10px] font-bold tabular-nums">
      {formatBB(bottomCallAmt)} BB
    </div>
  )}
</button>

                {displayGame.stacks[myActualSeat] > bottomCallAmt && displayGame.stacks[oppActualSeat] > 0 && (
                  <button
  type="button"
  onClick={() => {
    const finalSize = betSize === "" || betSize < bottomMinRaise ? openingDefault : Math.max(betSize, bottomMinRaise);
    dispatchAction({ type: "BET_RAISE_TO", to: finalSize });
  }}
  disabled={!(displayToAct === mySeat && displayHandResult.status === "playing")}
  className="flex h-[64px] w-[100px] min-[1536px]:max-[1650px]:h-[50px] min-[1536px]:max-[1650px]:w-[78px] flex-col items-center justify-center rounded-2xl min-[1536px]:max-[1650px]:rounded-xl border bg-white px-4 py-3 min-[1536px]:max-[1650px]:px-3 min-[1536px]:max-[1650px]:py-2 text-sm min-[1536px]:max-[1650px]:text-xs font-semibold text-black shadow-sm hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
>
  <div className="text-sm min-[1536px]:max-[1650px]:text-xs leading-tight">
    {facingBetBottom ? "Raise" : "Bet"}
  </div>

  <div className="mt-0.5 w-full text-center text-xs min-[1536px]:max-[1650px]:text-[10px] font-bold tabular-nums">
    {formatBB(displayBetSize)} BB
  </div>
</button>
                )}
              </div>
            </div>
          )}
        </div>
      </main>
    </>
  );
}
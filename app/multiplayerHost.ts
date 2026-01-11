/**
 * Multiplayer Host Controller
 * 
 * The host is the AUTHORITATIVE source of all game state.
 * Host responsibilities:
 * - Run all game logic
 * - Deal cards
 * - Process actions from both players
 * - Broadcast state updates to joiner
 * - Determine winners, advance streets, etc.
 */

import type { RealtimeChannel } from "@supabase/supabase-js";
import { GAME_CONFIG } from "./gameConfig";

// Types
export type Seat = "top" | "bottom";
export type Street = 0 | 3 | 4 | 5;
export type StreetName = "Preflop" | "Flop" | "Turn" | "River";

export type Card = {
  rank: string;
  suit: string;
};

export type GameState = {
  stacks: { top: number; bottom: number };
  bets: { top: number; bottom: number };
  pot: number;
};

export type ActionLogItem = {
  id: string;
  sequence: number;
  street: StreetName;
  seat: Seat;
  text: string;
};

export type GameAction =
  | { type: "FOLD" }
  | { type: "CHECK" }
  | { type: "CALL" }
  | { type: "BET_RAISE_TO"; to: number };

// Complete game state that host broadcasts
export type HostState = {
  // Game state
  game: GameState;
  street: Street;
  toAct: Seat;
  
  // Cards
  cards: Card[] | null;
  
 // Hand info
handId: number;
dealerOffset: 0 | 1;
dealerSeat: Seat;
gameSession: number;
  
  // Action log
  actionLog: ActionLogItem[];
  actionSequence: number;
  
  // Hand result
  handResult: {
    status: "playing" | "ended";
    winner: Seat | "tie" | null;
    reason: "fold" | "showdown" | null;
    message: string;
  };
  
  // State flags
  gameOver: boolean;
  blindsPosted: boolean;
  
  // Betting state
  lastRaiseSize: number;
  lastAggressor: Seat | null;
  actionsThisStreet: number;
  checked: { top: boolean; bottom: boolean };
  
  // Showdown state
  oppRevealed: boolean;
  youMucked: boolean;
  
  // Show hand state (for showing after fold)
  canShowTop: boolean;     // Top player can show their hand
  canShowBottom: boolean;  // Bottom player can show their hand
  topShowed: boolean;      // Top player showed their hand
  bottomShowed: boolean;   // Bottom player showed their hand
  
  // Hand start stacks for history
  handStartStacks: { top: number; bottom: number };
};

// Hand evaluation constants and helpers
const RANK_TO_VALUE: Record<string, number> = {
  A: 14, K: 13, Q: 12, J: 11, T: 10,
  "9": 9, "8": 8, "7": 7, "6": 6, "5": 5, "4": 4, "3": 3, "2": 2,
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
  if (vals[0] === 14) vals.push(1);

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

function roundToHundredth(n: number) {
  return Math.round(n * 100) / 100;
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

  if (flushSuit) {
    const fvUnique = Array.from(new Set(flushValsDesc)).sort((a, b) => b - a);
    const sfHigh = getStraightHigh(fvUnique);
    if (sfHigh !== null) return [8, sfHigh];
  }

  if (groups[0]?.cnt === 4) {
    const quad = groups[0].v;
    const kicker = uniqueDesc.find((v) => v !== quad) ?? 0;
    return [7, quad, kicker];
  }

  if (groups[0]?.cnt === 3) {
    const trips = groups[0].v;
    const pairCandidate = groups.find((g) => g.v !== trips && g.cnt >= 2);
    if (pairCandidate) return [6, trips, pairCandidate.v];
  }

  if (flushSuit) return [5, ...flushValsDesc.slice(0, 5)];

  if (straightHigh !== null) return [4, straightHigh];

  if (groups[0]?.cnt === 3) {
    const trips = groups[0].v;
    const kickers = uniqueDesc.filter((v) => v !== trips).slice(0, 2);
    return [3, trips, ...kickers];
  }

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

  if (groups[0]?.cnt === 2) {
    const pair = groups[0].v;
    const kickers = uniqueDesc.filter((v) => v !== pair).slice(0, 3);
    return [1, pair, ...kickers];
  }

  return [0, ...uniqueDesc.slice(0, 5)];
}

export class MultiplayerHost {
  private channel: RealtimeChannel;
  private userId: string;
  
  // Game state
  private state: HostState;
  
  // Constants
  private readonly SB = 0.5;
  private readonly BB = 1;
  private readonly STARTING_STACK_BB = GAME_CONFIG.STARTING_STACK_BB;
  private readonly BLINDS_INCREASE_EVERY_N_HANDS = GAME_CONFIG.BLINDS_INCREASE_EVERY_N_HANDS;
  
  private onStateChange?: () => void;
  private onOpponentQuit?: () => void;

constructor(channel: RealtimeChannel, userId: string, initialDealerOffset: 0 | 1, onStateChange?: () => void, onOpponentQuit?: () => void, savedState?: HostState | null) {
  this.channel = channel;
  this.userId = userId;
  this.onStateChange = onStateChange;
  this.onOpponentQuit = onOpponentQuit;
  
  // Initialize game state - use saved state if provided, otherwise create fresh
  if (savedState) {
    this.state = savedState;
    console.log('Host restored from saved state, handId:', savedState.handId);
  } else {
    this.state = this.createInitialState(initialDealerOffset);
  }
  
  // Listen for actions from joiner
  this.setupActionListener();
}
  
private createInitialState(initialDealerOffset: 0 | 1): HostState {
  const initialDealerSeat: Seat = initialDealerOffset === 0 ? "top" : "bottom";
  
  return {
    game: {
      stacks: { top: this.STARTING_STACK_BB, bottom: this.STARTING_STACK_BB },
      bets: { top: 0, bottom: 0 },
      pot: 0,
    },
    street: 0,
    toAct: initialDealerSeat,
    cards: null,
    handId: 0,
    dealerOffset: initialDealerOffset,
    dealerSeat: initialDealerSeat,
    gameSession: 0,
      actionLog: [],
      actionSequence: 0,
      handResult: {
        status: "playing",
        winner: null,
        reason: null,
        message: "",
      },
      gameOver: false,
      blindsPosted: false,
      lastRaiseSize: this.BB,
      lastAggressor: null,
      actionsThisStreet: 0,
      checked: { top: false, bottom: false },
      oppRevealed: false,
      youMucked: false,
      canShowTop: false,
      canShowBottom: false,
      topShowed: false,
      bottomShowed: false,
      handStartStacks: { top: this.STARTING_STACK_BB, bottom: this.STARTING_STACK_BB },
    };
  }
  
  private setupActionListener() {
    this.channel.on("broadcast", { event: "mp" }, ({ payload }: any) => {
      if (!payload) return;
      
      // Ignore own messages
      if (payload.sender === this.userId) return;
      
      // Handle player actions
      if (payload.event === "ACTION" && payload.seat && payload.action) {
        this.processAction(payload.seat as Seat, payload.action as GameAction);
      }
      
      // Handle state requests
      if (payload.event === "SYNC" && payload.kind === "REQUEST_SNAPSHOT") {
        this.broadcastFullState();
      }
      
      // Handle show hand action
      if (payload.event === "SHOW_HAND" && payload.seat) {
        console.log("Host received SHOW_HAND event");
        console.log("  - Seat:", payload.seat);
        console.log("  - canShowTop:", this.state.canShowTop);
        console.log("  - canShowBottom:", this.state.canShowBottom);
        console.log("  - topShowed:", this.state.topShowed);
        console.log("  - bottomShowed:", this.state.bottomShowed);
        
        this.handleShowHand(payload.seat as Seat);
        
        console.log("After handleShowHand:");
        console.log("  - topShowed:", this.state.topShowed);
        console.log("  - bottomShowed:", this.state.bottomShowed);
        
        this.broadcastFullState(); // Broadcast updated state back to joiner
        
        // Notify host to update its display
        if (this.onStateChange) {
          this.onStateChange();
        }
      }
      
      // Handle joiner quit
      if (payload.event === "PLAYER_QUIT") {
        console.log("Host received PLAYER_QUIT from joiner");
        if (this.onOpponentQuit) {
          this.onOpponentQuit();
        }
      }
    });
  }
  
  /**
   * Start a new hand - called when host enters game or starts next hand
   */
public startHand() {
    // Increment handId after first hand completes (so hand 2 starts with handId=1)
    // Check if we've played at least one hand by checking if action log has content
    const hasPlayedAHand = this.state.actionLog.length > 0;
    
    if (this.state.handId > 0 || hasPlayedAHand) {
      this.state.handId++;
    }
    
    // Flip dealer for hands after the first
    if (this.state.handId > 0) {
      this.state.dealerOffset = this.state.dealerOffset === 0 ? 1 : 0;
      this.state.dealerSeat = this.state.dealerOffset === 0 ? "top" : "bottom";
    }
    
    // Apply blind level increase (reduce stacks by 25% every N hands from config)
    // With N=5: happens at handId 5, 10, 15... (Hand #6, #11, #16...)
    // With N=10: happens at handId 10, 20, 30... (Hand #11, #21, #31...)
    if (this.state.handId > 0 && this.state.handId % this.BLINDS_INCREASE_EVERY_N_HANDS === 0) {
      this.state.game.stacks.top = Math.round(this.state.game.stacks.top * 0.75 * 100) / 100;
      this.state.game.stacks.bottom = Math.round(this.state.game.stacks.bottom * 0.75 * 100) / 100;
    }
    
    // Store start stacks for hand history (AFTER blind level adjustment)
    this.state.handStartStacks = {
      top: this.state.game.stacks.top,
      bottom: this.state.game.stacks.bottom,
    };
    
    // Deal cards
    this.state.cards = this.dealCards();
    
    // Reset hand state
    this.state.handResult = {
      status: "playing",
      winner: null,
      reason: null,
      message: "",
    };
    this.state.actionLog = [];
    this.state.actionSequence = 0;
    this.state.street = 0;
    this.state.lastAggressor = null;
    this.state.actionsThisStreet = 0;
    this.state.checked = { top: false, bottom: false };
    this.state.oppRevealed = false;
    this.state.youMucked = false;
    this.state.canShowTop = false;
    this.state.canShowBottom = false;
    this.state.topShowed = false;
    this.state.bottomShowed = false;
    this.state.lastRaiseSize = this.BB;
    
    // Post blinds
    this.postBlinds();
    
    // Broadcast initial state
    this.broadcastFullState();
  }
  
  private dealCards(): Card[] {
    // Simple card dealing - 9 cards total (2 for each player + 5 board)
    const ranks = ["A", "K", "Q", "J", "T", "9", "8", "7", "6", "5", "4", "3", "2"];
    const suits = ["♠", "♥", "♦", "♣"];
    
    const deck: Card[] = [];
    for (const rank of ranks) {
      for (const suit of suits) {
        deck.push({ rank, suit });
      }
    }
    
    // Shuffle and take 9 cards
    const shuffled = deck.sort(() => Math.random() - 0.5);
    return shuffled.slice(0, 9);
  }
  
  private postBlinds() {
    const dealerSeat = this.state.dealerOffset === 0 ? "top" : "bottom";
    const nonDealerSeat = dealerSeat === "top" ? "bottom" : "top";
    
    // Post blinds - cap at available stack if short
    const actualSB = Math.min(this.SB, this.state.game.stacks[dealerSeat]);
    const actualBB = Math.min(this.BB, this.state.game.stacks[nonDealerSeat]);
    
    this.state.game.bets[dealerSeat] = roundToHundredth(actualSB);
    this.state.game.bets[nonDealerSeat] = roundToHundredth(actualBB);
    this.state.game.stacks[dealerSeat] = roundToHundredth(this.state.game.stacks[dealerSeat] - actualSB);
    this.state.game.stacks[nonDealerSeat] = roundToHundredth(this.state.game.stacks[nonDealerSeat] - actualBB);
    
    // Dealer acts first preflop
    this.state.toAct = dealerSeat;
    
    // Log blinds
    this.logAction(dealerSeat, `Posts SB ${actualSB}bb`);
    this.logAction(nonDealerSeat, `Posts BB ${actualBB}bb`);
    
    this.state.blindsPosted = true;
  }
  
  /**
   * Process an action from either player
   */
  public processAction(seat: Seat, action: GameAction) {
    // Validate it's this seat's turn
    if (this.state.toAct !== seat) return;
    if (this.state.handResult.status !== "playing") return;
    
    // Process the action
    switch (action.type) {
      case "FOLD":
        this.handleFold(seat);
        break;
      case "CHECK":
        this.handleCheck(seat);
        break;
      case "CALL":
        this.handleCall(seat);
        break;
      case "BET_RAISE_TO":
        this.handleBetRaise(seat, action.to);
        break;
    }
    
    // Broadcast updated state
this.broadcastFullState();

// Notify host to update its display
if (this.onStateChange) {
  this.onStateChange();
}
  }
  
  private handleFold(seat: Seat) {
    const winner = seat === "top" ? "bottom" : "top";
    
    this.logAction(seat, "Folds");
    
    const potSize = this.state.game.pot + this.state.game.bets.top + this.state.game.bets.bottom;
    
    this.state.handResult = {
      status: "ended",
      winner,
      reason: "fold",
      message: `${winner === "bottom" ? "You" : "Opponent"} wins`,
    };
    
    // Award pot
    this.state.game.stacks[winner] += potSize;
    this.state.game.pot = 0;
    this.state.game.bets = { top: 0, bottom: 0 };
    
    this.logAction(winner, `Wins ${potSize}bb`);
    
    // After a fold, both players can optionally show their hand
    this.state.canShowTop = true;
    this.state.canShowBottom = true;
    this.state.topShowed = false;
    this.state.bottomShowed = false;
    
    // Check if game is over
    if (this.state.game.stacks.top <= 0 || this.state.game.stacks.bottom <= 0) {
      this.state.gameOver = true;
    }
  }
  
  private handleCheck(seat: Seat) {
    this.logAction(seat, "Checks");
    
    this.state.checked[seat] = true;
    this.state.actionsThisStreet++;
    
    const otherSeat = seat === "top" ? "bottom" : "top";
    
    // Check if both players have checked OR if bets are equal and we've had enough actions
    const bothChecked = this.state.checked.top && this.state.checked.bottom;
    const betsEqual = this.state.game.bets.top === this.state.game.bets.bottom;
    const enoughActions = this.state.actionsThisStreet >= 2;
    
    if (bothChecked || (betsEqual && enoughActions)) {
      this.advanceStreet();
    } else {
      // Switch turns
      this.state.toAct = otherSeat;
    }
  }
  
  private handleCall(seat: Seat) {
    const otherSeat = seat === "top" ? "bottom" : "top";
    const toCall = roundToHundredth(this.state.game.bets[otherSeat] - this.state.game.bets[seat]);
    const actualCall = roundToHundredth(Math.min(toCall, this.state.game.stacks[seat]));
    
    this.state.game.bets[seat] = roundToHundredth(this.state.game.bets[seat] + actualCall);
    this.state.game.stacks[seat] = roundToHundredth(this.state.game.stacks[seat] - actualCall);
    
    // If caller couldn't fully call (all-in short), refund excess to bettor
    if (actualCall < toCall) {
      const refund = roundToHundredth(this.state.game.bets[otherSeat] - this.state.game.bets[seat]);
      this.state.game.bets[otherSeat] = roundToHundredth(this.state.game.bets[otherSeat] - refund);
      this.state.game.stacks[otherSeat] = roundToHundredth(this.state.game.stacks[otherSeat] + refund);
    }
    
    this.logAction(seat, `Calls ${actualCall}bb`);
    
    this.state.actionsThisStreet++;

    // If someone is all-in after this call, reveal all cards
    if (this.state.game.stacks[seat] <= 0 || this.state.game.stacks[otherSeat] <= 0) {
      this.state.oppRevealed = true;
    }
    
    // Special case: Preflop in heads-up, if SB calls BB's ORIGINAL blind (not a raise), BB gets option
    if (this.state.street === 0) {
      const dealerSeat = this.state.dealerOffset === 0 ? "top" : "bottom";
      const nonDealerSeat = dealerSeat === "top" ? "bottom" : "top";
      
      // If dealer (SB) just called AND there's been no aggression yet (only blinds posted)
      if (seat === dealerSeat && this.state.lastAggressor === null) {
        this.state.toAct = otherSeat;
        return;
      }
    }
    
    // Otherwise, calling completes the street
    this.advanceStreet();
  }
  
  private handleBetRaise(seat: Seat, amount: number) {
    const otherSeat = seat === "top" ? "bottom" : "top";
    const currentBet = this.state.game.bets[seat];
    const otherCurrentBet = this.state.game.bets[otherSeat];
    
    // Cap amount to what player can actually bet (current bet + remaining stack)
    const maxPossible = currentBet + this.state.game.stacks[seat];
    const cappedAmount = Math.min(amount, maxPossible);
    const betAmount = cappedAmount - currentBet;
    
    this.state.game.bets[seat] = roundToHundredth(cappedAmount);
    this.state.game.stacks[seat] = roundToHundredth(this.state.game.stacks[seat] - betAmount);
    
    const actionText = otherCurrentBet > currentBet ? `Raises to ${amount}bb` : `Bets ${amount}bb`;
    this.logAction(seat, actionText);
    
    this.state.lastAggressor = seat;
    // lastRaiseSize should be the RAISE INCREMENT, not the total bet
    const isFacing = otherCurrentBet > currentBet;
    this.state.lastRaiseSize = isFacing 
      ? cappedAmount - otherCurrentBet 
      : cappedAmount;
    this.state.actionsThisStreet++;
    this.state.checked = { top: false, bottom: false };
    
    // Switch turns
    this.state.toAct = otherSeat;
  }
  
  private handleShowHand(seat: Seat) {
    // Check if this seat is allowed to show
    if (seat === "top" && !this.state.canShowTop) return;
    if (seat === "bottom" && !this.state.canShowBottom) return;
    
    // Check if already showed
    if (seat === "top" && this.state.topShowed) return;
    if (seat === "bottom" && this.state.bottomShowed) return;
    
    // Mark as showed
    if (seat === "top") {
      this.state.topShowed = true;
    } else {
      this.state.bottomShowed = true;
    }
    
    // Get the cards for logging
    const cards = seat === "top" 
      ? this.state.cards?.slice(0, 2) 
      : this.state.cards?.slice(2, 4);
    
    if (cards && cards.length === 2) {
      const cardStr = `${cards[0].rank}${cards[0].suit} ${cards[1].rank}${cards[1].suit}`;
      this.logAction(seat, `Shows ${cardStr}`);
    }
  }

  private advanceStreet() {
    // Pull bets into pot
    this.state.game.pot += this.state.game.bets.top + this.state.game.bets.bottom;
    this.state.game.bets = { top: 0, bottom: 0 };
    
    // Check if anyone is all-in
    const someoneAllIn = this.state.game.stacks.top <= 0 || this.state.game.stacks.bottom <= 0;
    
    // Advance to next street
    if (this.state.street === 0) {
      this.state.street = 3; // Flop
    } else if (this.state.street === 3) {
      this.state.street = 4; // Turn
    } else if (this.state.street === 4) {
      this.state.street = 5; // River
    } else {
      // River complete - go to showdown
      this.resolveShowdown();
      return;
    }
    
    // If someone is all-in postflop, run it out to river immediately
    if (someoneAllIn && this.state.street < 5) {
      this.state.street = 5;
      this.resolveShowdown();
      return;
    }
    
    // Reset street state
    this.state.checked = { top: false, bottom: false };
    this.state.lastAggressor = null;
    this.state.actionsThisStreet = 0;
    this.state.lastRaiseSize = this.BB; // Reset to BB for new street
    
    // Non-dealer acts first postflop
    const dealerSeat = this.state.dealerOffset === 0 ? "top" : "bottom";
    this.state.toAct = dealerSeat === "top" ? "bottom" : "top";
  }
  
  private resolveShowdown() {
    // Evaluate both hands
    const board = (this.state.cards?.slice(4, 9) || []).slice(0, this.state.street);
    const topCards = this.state.cards?.slice(0, 2) || [];
    const bottomCards = this.state.cards?.slice(2, 4) || [];
    
    const top7 = [...topCards, ...board];
    const bottom7 = [...bottomCards, ...board];
    
    const topScore = evaluate7(top7);
    const bottomScore = evaluate7(bottom7);
    const cmp = compareScore(bottomScore, topScore);
    
    let winner: Seat | "tie";
    if (cmp > 0) {
      winner = "bottom";
    } else if (cmp < 0) {
      winner = "top";
    } else {
      winner = "tie";
    }
    
    this.state.handResult = {
      status: "ended",
      winner,
      reason: "showdown",
      message: winner === "bottom" ? "You win" : winner === "top" ? "Opponent wins" : "Tie",
    };
    
    // Determine show order: OOP shows first on check-check river, otherwise last aggressor shows first
    const dealerSeat = this.state.dealerOffset === 0 ? "top" : "bottom";
    const nonDealerSeat = dealerSeat === "top" ? "bottom" : "top";
    
    // Check if river was checked through (both checked and no betting on river)
    const riverCheckedThrough = this.state.checked.top && this.state.checked.bottom && 
                                 this.state.lastAggressor === null;
    
    const firstToShow: Seat = riverCheckedThrough ? nonDealerSeat : (this.state.lastAggressor || nonDealerSeat);
    const secondToShow: Seat = firstToShow === "top" ? "bottom" : "top";
    
    // Check if someone is all-in - if so, both must show
    const someoneAllIn = this.state.game.stacks.top <= 0 || this.state.game.stacks.bottom <= 0;
    
    // Second player only shows if they win or tie (can muck if they lose) - unless all-in
    const secondShows = someoneAllIn || winner === "tie" || winner === secondToShow;
    
    const topShows = firstToShow === "top" || (secondToShow === "top" && secondShows);
    const bottomShows = firstToShow === "bottom" || (secondToShow === "bottom" && secondShows);
    
    // Set which cards are revealed in UI

    this.state.oppRevealed = topShows;
    this.state.youMucked = !bottomShows;

    // Show Hand button: only losers who mucked can optionally show
    if (winner === "tie") {
      // Tie: both already showed, no Show Hand button
      this.state.canShowTop = false;
      this.state.canShowBottom = false;
    } else {
      // Winner already showed, loser can show if they mucked
      this.state.canShowTop = (winner !== "top" && !topShows);
      this.state.canShowBottom = (winner !== "bottom" && !bottomShows);
    }
    this.state.topShowed = false;
    this.state.bottomShowed = false;
    
    // Log both players showing their cards at showdown
    const topCardStr = topCards.length === 2 
      ? `${topCards[0].rank}${topCards[0].suit} ${topCards[1].rank}${topCards[1].suit}`
      : "";
    const bottomCardStr = bottomCards.length === 2
      ? `${bottomCards[0].rank}${bottomCards[0].suit} ${bottomCards[1].rank}${bottomCards[1].suit}`
      : "";
    
    // First player always shows
    if (firstToShow === "top" && topCardStr) {
      this.logAction("top", `Shows ${topCardStr}`);
    } else if (firstToShow === "bottom" && bottomCardStr) {
      this.logAction("bottom", `Shows ${bottomCardStr}`);
    }
    
    // Second player shows only if they win or tie
    if (secondShows) {
      if (secondToShow === "top" && topCardStr) {
        this.logAction("top", `Shows ${topCardStr}`);
      } else if (secondToShow === "bottom" && bottomCardStr) {
        this.logAction("bottom", `Shows ${bottomCardStr}`);
      }
    } else {
      // Second player mucks
      this.logAction(secondToShow, "Mucked");
    }
    
    // Award pot
    const potSize = this.state.game.pot + this.state.game.bets.top + this.state.game.bets.bottom;
    
    if (winner === "tie") {
      const half = potSize / 2;
      this.state.game.stacks.top += half;
      this.state.game.stacks.bottom += half;
      this.logAction("top", `Split pot ${half}bb (Showdown)`);
      this.logAction("bottom", `Split pot ${half}bb (Showdown)`);
    } else {
      this.state.game.stacks[winner] += potSize;
      this.logAction(winner, `Wins ${potSize}bb (Showdown)`);
    }
    
    this.state.game.pot = 0;
    this.state.game.bets = { top: 0, bottom: 0 };
    
    // Check if game is over
    if (this.state.game.stacks.top <= 0 || this.state.game.stacks.bottom <= 0) {
      this.state.gameOver = true;
    }
  }
  
  private logAction(seat: Seat, text: string) {
    this.state.actionLog.push({
      id: `${Date.now()}-${this.state.actionSequence}`,
      sequence: this.state.actionSequence++,
      street: this.getStreetName(this.state.street),
      seat,
      text,
    });
  }
  
  private getStreetName(street: Street): StreetName {
    if (street === 0) return "Preflop";
    if (street === 3) return "Flop";
    if (street === 4) return "Turn";
    return "River";
  }
  
  /**
   * Broadcast the complete game state to joiner
   */
  private broadcastFullState() {
    this.channel.send({
      type: "broadcast",
      event: "mp",
      payload: {
        event: "HOST_STATE",
        sender: this.userId,
        state: this.state,
      },
    }).then(() => {
      console.log("Broadcast: HOST_STATE");
    }).catch((err) => {
      console.error("Broadcast failed:", err);
    });
  }
  
  /**
   * Player chooses to show their hand after winning by fold
   */
  public showHand(seat: Seat) {
    this.handleShowHand(seat);
    this.broadcastFullState();
    
    // Notify host to update its display
    if (this.onStateChange) {
      this.onStateChange();
    }
  }

/**
   * Send an action to the host
   */
  public sendAction(seat: Seat, action: GameAction) {
    this.channel.send({
      type: "broadcast",
      event: "mp",
      payload: {
        event: "ACTION",
        seat,
        action,
        sender: this.userId,
      },
    }).then(() => {
      console.log("Sent action:", action.type);
    }).catch((err) => {
      console.error("Action send failed:", err);
    });
  }
  
  /**
   * Send show hand action to the host
   */
  public sendShowHand(seat: Seat) {
    console.log("Joiner sending SHOW_HAND:", seat);
    this.channel.send({
      type: "broadcast",
      event: "mp",
      payload: {
        event: "SHOW_HAND",
        seat,
        sender: this.userId,
      },
    }).then(() => {
      console.log("Sent show hand successfully");
    }).catch((err) => {
      console.error("Show hand send failed:", err);
    });
  }
  
  /**
   * Get current state
   */
  public getState(): HostState | null {
    return this.state;
  }
  
  /**
   * Clean up
   */
  public destroy() {
    // Broadcast quit message
    this.channel.send({
      type: "broadcast",
      event: "mp",
      payload: {
        event: "PLAYER_QUIT",
        sender: this.userId,
      },
    }).catch(() => {
      // Ignore errors on cleanup
    });
  }
}

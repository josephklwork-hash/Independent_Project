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
  
  // Hand start stacks for history
  handStartStacks: { top: number; bottom: number };
};

export class MultiplayerHost {
  private channel: RealtimeChannel;
  private userId: string;
  
  // Game state
  private state: HostState;
  
  // Constants
  private readonly SB = 0.5;
  private readonly BB = 1;
  private readonly STARTING_STACK_BB = 50;
  
  private onStateChange?: () => void;

constructor(channel: RealtimeChannel, userId: string, initialDealerOffset: 0 | 1, onStateChange?: () => void) {
  this.channel = channel;
  this.userId = userId;
  this.onStateChange = onStateChange;
  
  // Initialize game state
  this.state = this.createInitialState(initialDealerOffset);
  
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
    });
  }
  
  /**
   * Start a new hand - called when host enters game or starts next hand
   */
  public startHand() {
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
    
    // Post blinds
    this.state.game.bets[dealerSeat] = this.SB;
    this.state.game.bets[nonDealerSeat] = this.BB;
    this.state.game.stacks[dealerSeat] -= this.SB;
    this.state.game.stacks[nonDealerSeat] -= this.BB;
    
    // Dealer acts first preflop
    this.state.toAct = dealerSeat;
    
    // Log blinds
    this.logAction(dealerSeat, `Posts SB ${this.SB}bb`);
    this.logAction(nonDealerSeat, `Posts BB ${this.BB}bb`);
    
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
    
    this.state.handResult = {
      status: "ended",
      winner,
      reason: "fold",
      message: `${winner === "bottom" ? "You" : "Opponent"} wins`,
    };
    
    // Award pot
    const potSize = this.state.game.pot + this.state.game.bets.top + this.state.game.bets.bottom;
    this.state.game.stacks[winner] += potSize;
    this.state.game.pot = 0;
    this.state.game.bets = { top: 0, bottom: 0 };
    
    this.logAction(winner, `Wins ${potSize}bb`);
  }
  
  private handleCheck(seat: Seat) {
    this.logAction(seat, "Checks");
    
    this.state.checked[seat] = true;
    this.state.actionsThisStreet++;
    
    // Check if street is complete
    if (this.state.checked.top && this.state.checked.bottom) {
      this.advanceStreet();
    } else {
      // Switch turns
      this.state.toAct = seat === "top" ? "bottom" : "top";
    }
  }
  
  private handleCall(seat: Seat) {
    const otherSeat = seat === "top" ? "bottom" : "top";
    const toCall = this.state.game.bets[otherSeat] - this.state.game.bets[seat];
    
    this.state.game.bets[seat] += toCall;
    this.state.game.stacks[seat] -= toCall;
    
    this.logAction(seat, `Calls ${toCall}bb`);
    
    this.state.actionsThisStreet++;
    
    // Calling completes the street
    this.advanceStreet();
  }
  
  private handleBetRaise(seat: Seat, amount: number) {
    const otherSeat = seat === "top" ? "bottom" : "top";
    const currentBet = this.state.game.bets[seat];
    const betAmount = amount - currentBet;
    
    this.state.game.bets[seat] = amount;
    this.state.game.stacks[seat] -= betAmount;
    
    const actionText = currentBet === 0 ? `Bets ${amount}bb` : `Raises to ${amount}bb`;
    this.logAction(seat, actionText);
    
    this.state.lastAggressor = seat;
    this.state.lastRaiseSize = amount;
    this.state.actionsThisStreet++;
    this.state.checked = { top: false, bottom: false };
    
    // Switch turns
    this.state.toAct = otherSeat;
  }
  
  private advanceStreet() {
    // Pull bets into pot
    this.state.game.pot += this.state.game.bets.top + this.state.game.bets.bottom;
    this.state.game.bets = { top: 0, bottom: 0 };
    
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
    
    // Reset street state
    this.state.checked = { top: false, bottom: false };
    this.state.lastAggressor = null;
    this.state.actionsThisStreet = 0;
    this.state.lastRaiseSize = this.BB;
    
    // Non-dealer acts first postflop
    const dealerSeat = this.state.dealerOffset === 0 ? "top" : "bottom";
    this.state.toAct = dealerSeat === "top" ? "bottom" : "top";
  }
  
  private resolveShowdown() {
    // Simple winner determination (placeholder - you'd use actual hand evaluation)
    const winner: Seat | "tie" = Math.random() > 0.5 ? "top" : "bottom";
    
    this.state.handResult = {
      status: "ended",
      winner,
      reason: "showdown",
      message: winner === "tie" ? "Split pot" : winner === "bottom" ? "You win" : "Opponent wins",
    };
    
    this.state.oppRevealed = true;
    
    // Award pot
    const potSize = this.state.game.pot + this.state.game.bets.top + this.state.game.bets.bottom;
    
    if (winner === "tie") {
      this.state.game.stacks.top += potSize / 2;
      this.state.game.stacks.bottom += potSize / 2;
      this.logAction("top", `Splits pot ${potSize / 2}bb`);
    } else {
      this.state.game.stacks[winner] += potSize;
      this.logAction(winner, `Wins ${potSize}bb`);
    }
    
    this.state.game.pot = 0;
    this.state.game.bets = { top: 0, bottom: 0 };
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
   * Get current state (for host's own display)
   */
  public getState(): HostState {
    return this.state;
  }
  
  /**
   * Clean up
   */
  public destroy() {
    // Any cleanup needed
  }
}

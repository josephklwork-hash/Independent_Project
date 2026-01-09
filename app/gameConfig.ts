/**
 * Shared Game Configuration
 * 
 * Change these values to adjust game settings across the entire app.
 * This file is imported by both page.tsx and multiplayerHost.ts to ensure
 * consistent settings in both single-player and multiplayer modes.
 */

export const GAME_CONFIG = {
  /**
   * Starting stack size in big blinds
   * Example: 25 for fast games, 50 for standard, 100 for deep stack
   */
  STARTING_STACK_BB: 25,

  /**
   * How often blind levels change (stacks reduced by 25%)
   * Example: 5 for fast, 10 for standard, 20 for slow
   */
  BLINDS_INCREASE_EVERY_N_HANDS: 5,

  /**
   * When to start showing blind change warnings (within each block)
   * Example: If BLINDS_INCREASE_EVERY_N_HANDS = 5 and WARNING_STARTS_AT_HAND = 2,
   * warnings will show at hands 2, 3, 4, 5 (then blinds change at hand 6)
   */
  WARNING_STARTS_AT_HAND: 2,
} as const;

// Blind values (currently fixed)
export const BASE_SB = 0.5;
export const BASE_BB = 1;

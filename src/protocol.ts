export type Pick = 'heads' | 'tails';
export type ErrorCode = 'INVALID_BET' | 'QUOTE_EXPIRED' | 'ROUND_OPEN' | 'INSUFFICIENT_BALANCE' | 'INTERNAL';

export type Round = { id: string; bet: number; pick: Pick; result: Pick; multiplier: number; payout: number;
  streak?: { offered: boolean; multiplier: number }; state: 'open' | 'acked'; createdAt: string };

export type ClientMessage =
  | { reqId: string; type: 'hello'; clientVersion: string }
  | { reqId: string; type: 'get_balance' } | { reqId: string; type: 'get_open_round' } | { reqId: string; type: 'ping' }
  | { reqId: string; type: 'get_quote'; bet: number }
  | { reqId: string; type: 'place_round'; bet: number; pick: Pick; quoteId: string }
  | { reqId: string; type: 'ack_round'; roundId: string };

export type ServerReply =
  | { reqId: string; type: 'welcome'; sessionId: string; gameId: 'coinflip'; userId: string; balance: number; openRound: Round | null; resumed: boolean }
  | { reqId: string; type: 'balance'; balance: number }
  | { reqId: string; type: 'quote'; quoteId: string; bet: number; multiplier: number; expiresAt: string }
  | { reqId: string; type: 'open_round'; round: Round | null }
  | { reqId: string; type: 'round'; round: Round }
  | { reqId: string; type: 'acked'; roundId: string; balance: number }
  | { reqId: string; type: 'pong' }
  | { reqId?: string; type: 'error'; code: ErrorCode; message: string };

export type ServerPush =
  | { type: 'balance_changed'; balance: number }
  | { type: 'quote_changed'; quoteId: string; bet: number; multiplier: number }
  | { type: 'session_replaced' };

export type ServerMessage = ServerReply | ServerPush;

export const CLOSE = {
  MISSING_USER: [4001, 'MISSING_USER'],
  HELLO_REQUIRED: [4002, 'HELLO_REQUIRED'],
  UNKNOWN_GAME: [4004, 'UNKNOWN_GAME'],
  SESSION_REPLACED: [4009, 'SESSION_REPLACED'],
  DROP: [1011, 'simulated drop'],
} as const;

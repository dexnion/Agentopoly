import OpenAI from 'openai';
import { ProviderMgr, modelSchema } from './models';
import { tiles, tile } from './board';
import {
  chance,
  communityChest,
  chanceSchema,
  communityChestSchema,
} from './cards';
import * as fs from 'fs';
import * as path from 'path';

export interface Property {
  tile: tile;
  owner: string | null;
  houses: number;
  hotels: number;
  mortgaged: boolean;
}

export interface Player {
  id: string;
  name: string;
  position: number;
  money: number;
  properties: number[];
  jailFreeCards: number;
  inJail: boolean;
  jailTurns: number;
  bankrupt: boolean;
}

export interface GameState {
  players: Player[];
  currentPlayerIndex: number;
  properties: Property[];
  chanceCards: chanceSchema[];
  communityChestCards: communityChestSchema[];
  houses: number;
  hotels: number;
  turn: number;
  gameOver: boolean;
  winner: string | null;
}

export interface GameLog {
  timestamp: string;
  turn: number;
  player: string;
  action: string;
  details: any;
  gameStateBefore?: Partial<GameState>;
  gameStateAfter?: Partial<GameState>;
}

export interface AgentInteraction {
  timestamp: string;
  player: string;
  model: string;
  prompt: string;
  response: string;
  toolCalls?: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[];
  toolResults?: any[];
  tokensUsed: { prompt: number; completion: number; total: number };
  latency: number;
}

export interface ReasoningTrace {
  timestamp: string;
  player: string;
  turn: number;
  model: string;
  inputSummary: string;
  thought: string;
  chosenTools: string[];
}

export interface RecordingConfig {
  gameId: string;
  recordingsDir: string;
}

export const monopolyTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'roll_dice',
      description: 'Roll two dice to move your token. Returns dice and sum.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buy_property',
      description: 'Purchase current unowned property or start auction.',
      parameters: {
        type: 'object',
        properties: {
          confirm: {
            type: 'boolean',
            description: 'true to buy, false to decline (start auction)',
          },
        },
        required: ['confirm'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'auction_bid',
      description: 'Place a bid during auction.',
      parameters: {
        type: 'object',
        properties: {
          amount: {
            type: 'number',
            description: 'Bid amount (must exceed current bid).',
          },
        },
        required: ['amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pass_auction',
      description: 'Pass on bidding in current auction.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'build_house',
      description:
        'Build a house on a property you own (must have full color set, build evenly).',
      parameters: {
        type: 'object',
        properties: {
          propertyLocation: {
            type: 'number',
            description: 'Board location of property to build on.',
          },
        },
        required: ['propertyLocation'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'build_hotel',
      description:
        'Build a hotel on a property that currently has 4 houses.',
      parameters: {
        type: 'object',
        properties: {
          propertyLocation: {
            type: 'number',
            description: 'Board location of property to build hotel on.',
          },
        },
        required: ['propertyLocation'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mortgage_property',
      description:
        'Mortgage a property (no buildings on its color group allowed).',
      parameters: {
        type: 'object',
        properties: {
          propertyLocation: {
            type: 'number',
            description: 'Board location of property to mortgage.',
          },
        },
        required: ['propertyLocation'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'unmortgage_property',
      description: 'Pay mortgage + 10% interest to unmortgage property.',
      parameters: {
        type: 'object',
        properties: {
          propertyLocation: {
            type: 'number',
            description: 'Board location of property to unmortgage.',
          },
        },
        required: ['propertyLocation'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sell_house',
      description: 'Sell one house back to bank for half price.',
      parameters: {
        type: 'object',
        properties: {
          propertyLocation: {
            type: 'number',
            description: 'Board location to sell house from.',
          },
        },
        required: ['propertyLocation'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sell_hotel',
      description: 'Sell a hotel back to bank for half price.',
      parameters: {
        type: 'object',
        properties: {
          propertyLocation: {
            type: 'number',
            description: 'Board location to sell hotel from.',
          },
        },
        required: ['propertyLocation'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pay_jail_fine',
      description: 'Pay $50 to get out of jail immediately.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'use_jail_card',
      description: 'Use a Get Out of Jail Free card.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'trade_property',
      description: 'Propose a trade with another player.',
      parameters: {
        type: 'object',
        properties: {
          targetPlayer: {
            type: 'string',
            description: 'ID of player to trade with.',
          },
          offerProperties: {
            type: 'array',
            items: { type: 'number' },
            description: 'Locations you offer.',
          },
          offerMoney: {
            type: 'number',
            description: 'Money you offer.',
          },
          requestProperties: {
            type: 'array',
            items: { type: 'number' },
            description: 'Locations you want.',
          },
          requestMoney: {
            type: 'number',
            description: 'Money you want.',
          },
        },
        required: [
          'targetPlayer',
          'offerProperties',
          'offerMoney',
          'requestProperties',
          'requestMoney',
        ],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'respond_to_trade',
      description: 'Accept or reject a trade proposal.',
      parameters: {
        type: 'object',
        properties: {
          accept: {
            type: 'boolean',
            description: 'Accept (true) or reject (false).',
          },
        },
        required: ['accept'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_game_state',
      description: 'Get current game state summary.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_property_info',
      description: 'Get details about a specific property.',
      parameters: {
        type: 'object',
        properties: {
          propertyLocation: {
            type: 'number',
            description: 'Board location for property.',
          },
        },
        required: ['propertyLocation'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'end_turn',
      description: 'End your turn.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

export class MonopolyAgent {
  public player: Player;
  public model: modelSchema;
  public conversationHistory: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
    [];
  public interactions: AgentInteraction[] = [];
  private recordingsDir: string;

  constructor(player: Player, model: modelSchema, recordingsDir: string) {
    this.player = player;
    this.model = model;
    this.recordingsDir = recordingsDir;

    this.conversationHistory.push({
      role: 'system',
      content: `You are playing Monopoly as ${player.name}. Your goal is to win by bankrupting opponents while managing your money strategically.

RULES:
- Roll dice to move around the board
- Buy properties when you land on them
- Pay rent when landing on opponent properties
- Complete color groups to build houses/hotels for higher rent
- Manage cash carefully - going bankrupt means losing

STRATEGY:
- Complete color groups (monopolies) to build houses
- Balance property acquisition with maintaining cash reserves
- Consider mortgaging properties if low on cash
- Orange and red properties are most landed-on

On EACH turn:
1. Call "get_game_state" first to see the current situation
2. Take actions using the provided tools
3. Call "end_turn" when you're done

Think strategically and explain your reasoning briefly before acting.`,
    });
  }

  async takeTurn(
    gameState: GameState,
    pendingAction?: string
  ): Promise<AgentInteraction> {
    const startTime = Date.now();
    const me = gameState.players.find((p) => p.id === this.player.id)!;

    const contextPrompt = `
TURN ${gameState.turn} - ${me.name}
Position: ${me.position} (${tiles[me.position].name})
Money: $${me.money}
Properties: ${
      me.properties.map((loc) => tiles[loc].name).join(', ') || 'None'
    }
In Jail: ${me.inJail ? `Yes (turn ${me.jailTurns}/3)` : 'No'}

Other Players:
${gameState.players
  .filter((p) => p.id !== this.player.id)
  .map(
    (p) =>
      `- ${p.name}: pos ${p.position} (${tiles[p.position].name}), $${p.money}, ${p.properties.length} properties${p.inJail ? ' [JAIL]' : ''}`
  )
  .join('\n')}

${
  pendingAction
    ? `ACTION REQUIRED: ${pendingAction}`
    : 'Your turn - use tools to act, then call end_turn.'
}
`.trim();

    this.conversationHistory.push({ role: 'user', content: contextPrompt });

    // Keep history bounded: system + last 20 messages
    if (this.conversationHistory.length > 22) {
      this.conversationHistory = [
        this.conversationHistory[0],
        ...this.conversationHistory.slice(-20),
      ];
    }

    let lastError: any = null;
    let releaseSlot: (() => void) | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Acquire rate limit slot BEFORE making request
        releaseSlot = await ProviderMgr.acquireSlot(this.model);

        const client = ProviderMgr.getClient(this.model);
        const response = await client.chat.completions.create({
          model: this.model.id,
          messages: this.conversationHistory,
          tools: monopolyTools,
          tool_choice: 'auto',
          temperature: 0.7,
          max_tokens: this.model.maxTokens || 500, // Use model's limit or default to 500
        });

        // Update rate limits from response headers if available
        if ((response as any).response?.headers) {
          ProviderMgr.updateRateLimits(
            this.model,
            (response as any).response.headers
          );
        }

        // Release slot immediately after successful request
        releaseSlot();
        releaseSlot = null;

        const endTime = Date.now();
        const message = response.choices[0].message;
        this.conversationHistory.push(message);

        const interaction: AgentInteraction = {
          timestamp: new Date().toISOString(),
          player: this.player.name,
          model: this.model.id,
          prompt: contextPrompt,
          response: message.content || '',
          toolCalls: message.tool_calls,
          tokensUsed: {
            prompt: response.usage?.prompt_tokens ?? 0,
            completion: response.usage?.completion_tokens ?? 0,
            total: response.usage?.total_tokens ?? 0,
          },
          latency: endTime - startTime,
        };

        this.interactions.push(interaction);
        this.appendNDJSON('interactions.ndjson', interaction);

        const reasoning: ReasoningTrace = {
          timestamp: interaction.timestamp,
          player: this.player.name,
          turn: gameState.turn,
          model: this.model.id,
          inputSummary: `pos=${me.position} (${tiles[me.position].name}), $${me.money}, props=${me.properties.length}`,
          thought: message.content || '',
          chosenTools: (message.tool_calls || []).map(
            (t) => t.function.name || ''
          ),
        };
        this.appendNDJSON('reasoning.ndjson', reasoning);

        return interaction;
      } catch (err: any) {
        // Release slot on error
        if (releaseSlot) {
          releaseSlot();
          releaseSlot = null;
        }

        lastError = err;

        // Check if it's a rate limit error
        const isRateLimit =
          err?.status === 429 ||
          err?.message?.toLowerCase().includes('rate limit') ||
          err?.message?.toLowerCase().includes('too many requests');

        console.error(
          `  ❌ ${this.player.name} error (attempt ${attempt}/${MAX_RETRIES}): ${err?.message || err}`
        );

        this.appendNDJSON('errors.ndjson', {
          timestamp: new Date().toISOString(),
          player: this.player.name,
          model: this.model.id,
          attempt,
          error: err?.message || String(err),
          status: err?.status,
          isRateLimit,
        });

        if (attempt < MAX_RETRIES) {
          // If rate limit, wait longer
          const waitTime = isRateLimit
            ? RETRY_DELAY_MS * 3
            : RETRY_DELAY_MS * attempt;
          console.log(`  ⏳ Retrying in ${waitTime / 1000}s...`);
          await this.sleep(waitTime);
        }
      }
    }

    // Hard fallback: end turn
    console.error(
      `  💀 All retries failed for ${this.player.name}, forcing end_turn`
    );
    const fallback: AgentInteraction = {
      timestamp: new Date().toISOString(),
      player: this.player.name,
      model: this.model.id,
      prompt: contextPrompt,
      response: `ERROR: ${lastError?.message || 'unknown error'}, forcing end_turn`,
      toolCalls: [
        {
          id: `fallback_${Date.now()}`,
          type: 'function',
          function: { name: 'end_turn', arguments: '{}' },
        },
      ],
      tokensUsed: { prompt: 0, completion: 0, total: 0 },
      latency: Date.now() - startTime,
    };
    this.interactions.push(fallback);
    this.appendNDJSON('interactions.ndjson', fallback);
    return fallback;
  }

  addToolResult(
    toolCall: OpenAI.Chat.Completions.ChatCompletionMessageToolCall,
    result: any
  ) {
    this.conversationHistory.push({
      role: 'tool',
      tool_call_id: toolCall.id,
      content: JSON.stringify(result),
    });

    this.appendNDJSON('tool_results.ndjson', {
      timestamp: new Date().toISOString(),
      player: this.player.name,
      toolCallId: toolCall.id,
      toolName: toolCall.function.name || '',
      arguments: toolCall.function.arguments || '',
      result,
    });
  }

  reset() {
    this.conversationHistory = this.conversationHistory.slice(0, 1);
    this.interactions = [];
  }

  private appendNDJSON(filename: string, obj: any) {
    try {
      const filePath = path.join(this.recordingsDir, filename);
      fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
    } catch (e) {
      console.error(`Failed to append to ${filename}:`, e);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export class MonopolyMultiAgent {
  public agents: MonopolyAgent[];
  public gameState: GameState;
  public logs: GameLog[] = [];
  public gameId: string;
  public recordingsDir: string;

  constructor(
    players: Player[],
    models: modelSchema[],
    recordingConfig: RecordingConfig
  ) {
    if (players.length !== models.length) {
      throw new Error('Number of players must match number of models');
    }

    this.gameId = recordingConfig.gameId;
    this.recordingsDir = recordingConfig.recordingsDir;

    if (!fs.existsSync(this.recordingsDir)) {
      fs.mkdirSync(this.recordingsDir, { recursive: true });
    }

    this.agents = players.map(
      (p, i) => new MonopolyAgent(p, models[i], this.recordingsDir)
    );

    this.gameState = {
      players,
      currentPlayerIndex: 0,
      properties: tiles
        .filter(
          (t) =>
            t.attributes.cost !== undefined && t.attributes.cost !== null
        )
        .map((t) => ({
          tile: t,
          owner: null,
          houses: 0,
          hotels: 0,
          mortgaged: false,
        })),
      chanceCards: this.shuffle([...chance]),
      communityChestCards: this.shuffle([...communityChest]),
      houses: 32,
      hotels: 12,
      turn: 0,
      gameOver: false,
      winner: null,
    };
  }

  private shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  log(action: string, details: any, player?: Player) {
    const before = JSON.parse(JSON.stringify(this.gameState));
    const entry: GameLog = {
      timestamp: new Date().toISOString(),
      turn: this.gameState.turn,
      player: player?.name || 'System',
      action,
      details,
      gameStateBefore: before,
    };
    this.logs.push(entry);
    console.log(
      `[Turn ${this.gameState.turn}] ${entry.player}: ${action}`,
      details
    );
    this.appendNDJSON('logs.ndjson', entry);
  }

  logWithAfter(index: number) {
    if (index < 0 || index >= this.logs.length) return;
    this.logs[index].gameStateAfter = JSON.parse(
      JSON.stringify(this.gameState)
    );
  }

  getCurrentPlayer(): Player {
    return this.gameState.players[this.gameState.currentPlayerIndex];
  }

  getCurrentAgent(): MonopolyAgent {
    return this.agents[this.gameState.currentPlayerIndex];
  }

  nextPlayer() {
    do {
      this.gameState.currentPlayerIndex =
        (this.gameState.currentPlayerIndex + 1) %
        this.gameState.players.length;
    } while (this.getCurrentPlayer().bankrupt && !this.gameState.gameOver);
  }

  rollDice() {
    const d1 = Math.floor(Math.random() * 6) + 1;
    const d2 = Math.floor(Math.random() * 6) + 1;
    return { die1: d1, die2: d2, total: d1 + d2, doubles: d1 === d2 };
  }

  checkWinCondition(): boolean {
    const active = this.gameState.players.filter((p) => !p.bankrupt);
    if (active.length === 1) {
      this.gameState.gameOver = true;
      this.gameState.winner = active[0].name;
      this.log('GAME_OVER', { winner: this.gameState.winner });
      return true;
    }
    return false;
  }

  getAllInteractions(): AgentInteraction[] {
    return this.agents.flatMap((a) => a.interactions);
  }

  exportGameData() {
    const interactions = this.getAllInteractions();
    return {
      finalState: this.gameState,
      logs: this.logs,
      interactions,
      statistics: {
        totalTurns: this.gameState.turn,
        totalInteractions: interactions.length,
        totalTokensUsed: interactions.reduce(
          (sum, i) => sum + i.tokensUsed.total,
          0
        ),
        averageLatency:
          interactions.reduce((s, i) => s + i.latency, 0) /
          (interactions.length || 1),
        winner: this.gameState.winner,
      },
    };
  }

  appendNDJSON(filename: string, obj: any) {
    try {
      const filePath = path.join(this.recordingsDir, filename);
      fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
    } catch (e) {
      console.error(`Failed to append to ${filename}:`, e);
    }
  }
}

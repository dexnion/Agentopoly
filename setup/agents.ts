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
      description: 'Build a hotel on a property that currently has 4 houses.',
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
      name: 'pay_rent',
      description: 'Pay pending rent to property owner.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pay_bank',
      description: 'Pay pending amount to the bank (taxes, fines, fees).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pay_all_players',
      description: 'Pay a pending amount to all other players (e.g. Chairman of the Board).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_game_state',
      description: 'Get current game state information.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_property_info',
      description: 'Get detailed information about a specific property.',
      parameters: {
        type: 'object',
        properties: {
          propertyLocation: {
            type: 'number',
            description: 'Board location of property.',
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
const MAX_MESSAGES = 30;

export class MonopolyAgent {
  public player: Player;
  public model: modelSchema;
  private systemPrompt: OpenAI.Chat.Completions.ChatCompletionMessageParam;
  public turnHistory: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  public interactions: AgentInteraction[] = [];
  public turnInteractionCount = 0;
  private recordingsDir: string;
  
  public pendingPayment: {
    type: 'rent' | 'bank' | 'others';
    amount: number;
    payee: string | null;
    description: string;
  } | null = null;
  
  // NEW: Track roll state
  private hasRolledThisTurn = false;
  private doublesCount = 0;

  constructor(player: Player, model: modelSchema, recordingsDir: string) {
    this.player = player;
    this.model = model;
    this.recordingsDir = recordingsDir;
    this.systemPrompt = {
      role: 'system',
      content: `You are playing Monopoly as ${player.name}. Win by bankrupting others.

COLOR GROUPS (locations):
- Brown:1,3. LightBlue:6,8,9. Pink:11,13,14. Orange:16,18,19.
- Red:21,23,24. Yellow:26,27,29. Green:31,32,34. DarkBlue:37,39.
- Railroads:5,15,25,35. Utilities:12,28.

RULES:
- Roll, buy unowned props, pay rent, trade.
- Own ALL props in a color group = MONOPOLY = can build houses/hotels.
- Houses cost varies by group. Build evenly across group. 4 houses -> hotel.
- Houses multiply rent dramatically (10x-100x base rent!).
- Bankruptcy = loss.

STRATEGY PRIORITY:
1. Roll dice first (mandatory each turn).
2. Buy unowned properties you land on (especially to complete color groups).
3. **BUILD HOUSES/HOTELS** on any monopoly you hold - this is THE key to winning!
   - Check "BUILDABLE" section in game state for where you can build.
   - Build as many houses as you can afford on your monopolies.
4. Trade to complete color groups, then build immediately.
5. End turn when done.

TRADING:
- Use trade_property to propose trades.
- When you receive a trade proposal, use respond_to_trade (accept=true/false).
- Evaluate: does the trade help you complete a color group? Accept if so.

CRITICAL:
- USE TOOLS. Call build_house with propertyLocation for EACH house you want to build.
- NO chit-chat. State is in user prompt.
`,
    };
  }

  public resetForNewTurn() {
    // Roll turnHistory to only last 30 messages
    this.turnHistory = this.turnHistory.slice(-MAX_MESSAGES);
    this.turnInteractionCount = 0;
    
    // NEW: reset per-turn state
    this.hasRolledThisTurn = false;
    this.doublesCount = 0;
    this.pendingPayment = null;
  }

  // NEW: Method for game engine to update roll state
  public markRollResult(doubles: boolean) {
    this.hasRolledThisTurn = true;
    if (doubles) {
      this.doublesCount += 1;
    }
  }

  // NEW: Getter for game engine to check if roll is allowed
  public canRollDice(): boolean {
    // Can roll if:
    // 1. Haven't rolled yet this turn, OR
    // 2. Just rolled doubles (and less than 3 total)
    return !this.hasRolledThisTurn || (this.doublesCount > 0 && this.doublesCount < 3);
  }

  private getCompressedState(state: GameState): string {
    const me = state.players.find((p) => p.id === this.player.id)!;
    const others = state.players.filter((p) => p.id !== this.player.id);
    
    let s = `Turn:${state.turn}. Me:${me.name}(${me.money}|Loc${me.position}). `;
    s += others.map(p => `${p.name}(${p.money}|Loc${p.position})`).join(', ');

    // Filter relevant properties: Owned by anyone, or current location
    const relevantProps = state.properties.filter(p => 
      p.owner !== null || 
      state.players.some(pl => pl.position === p.tile.location)
    );

    if (relevantProps.length > 0) {
      s += ' PROPS: ' + relevantProps.map(p => {
        const owner = p.owner === this.player.id ? 'Me' : (state.players.find(pl => pl.id === p.owner)?.name || 'unk');
        let det = `Loc${p.tile.location}:${owner}`;
        if (p.mortgaged) det += '(M)';
        if (p.houses) det += `(${p.houses}H)`;
        if (p.hotels) det += `(${p.hotels}Htl)`;
        return det;
      }).join(',');
    }

    // Current Tile Details if unowned
    const myTile = state.properties.find(p => p.tile.location === me.position);
    if (myTile && !myTile.owner) {
       s += ` | LANDED: ${myTile.tile.name} ($${myTile.tile.attributes.cost})`;
    }

    // Show buildable monopolies to encourage building
    const myProps = state.properties.filter(p => p.owner === this.player.id);
    const colorGroups: Record<string, typeof myProps> = {};
    for (const p of myProps) {
      const color = p.tile.attributes.color;
      if (color) {
        if (!colorGroups[color]) colorGroups[color] = [];
        colorGroups[color].push(p);
      }
    }

    const buildable: string[] = [];
    for (const [color, props] of Object.entries(colorGroups)) {
      // Check if player has monopoly on this color
      const allInGroup = state.properties.filter(p => p.tile.attributes.color === color);
      if (allInGroup.length === props.length) {
        // Has monopoly!
        for (const p of props) {
          if (p.hotels === 0 && p.houses < 4) {
            const cost = p.tile.attributes.houseCost || 0;
            if (me.money >= cost) {
              // Check even building
              const minHouses = Math.min(...props.map(pr => pr.houses));
              if (p.houses === minHouses) {
                buildable.push(`Loc${p.tile.location}:${p.tile.name}($${cost}/house,${p.houses}H)`);
              }
            }
          } else if (p.houses === 4 && p.hotels === 0) {
            const cost = p.tile.attributes.houseCost || 0;
            if (me.money >= cost) {
              buildable.push(`Loc${p.tile.location}:${p.tile.name}($${cost}/hotel,4H->HTL)`);
            }
          }
        }
      }
    }

    if (buildable.length > 0) {
      s += ` | BUILD NOW: ${buildable.join(', ')}. Use build_house or build_hotel!`;
    }

    // Show potential monopolies (need 1 more property to complete)
    const tradeable: string[] = [];
    for (const [color, props] of Object.entries(colorGroups)) {
      const allInGroup = state.properties.filter(p => p.tile.attributes.color === color);
      if (allInGroup.length - props.length === 1) {
        const missing = allInGroup.find(p => p.owner !== this.player.id);
        if (missing && missing.owner) {
          const ownerName = state.players.find(pl => pl.id === missing.owner)?.name || 'unknown';
          tradeable.push(`Need Loc${missing.tile.location}(${missing.tile.name}) from ${ownerName} to complete ${color}`);
        }
      }
    }
    if (tradeable.length > 0) {
      s += ` | TRADE OPP: ${tradeable.join('; ')}`;
    }

    return s;
  }

  async takeTurn(
    gameState: GameState,
    pendingAction?: string
  ): Promise<AgentInteraction> {
    const startTime = Date.now();
    const me = gameState.players.find((p) => p.id === this.player.id)!;
    const compressedState = this.getCompressedState(gameState);


    let contextPrompt = `GAME STATE: ${compressedState}\n${pendingAction ? `PENDING ACTION: ${pendingAction}` : 'YOUR MOVE.'}`;

    if (this.pendingPayment) {
      const typeMap: Record<string, string> = { rent: 'pay_rent', bank: 'pay_bank', others: 'pay_all_players' };
      contextPrompt += `\nCRITICAL: YOU OWE $${this.pendingPayment.amount} FOR ${this.pendingPayment.description.toUpperCase()}. USE ${typeMap[this.pendingPayment.type]} IMMEDIATELY.`;
    }

    // Optimize history: Remove full state from previous user messages to save tokens.
    // Replace them with a placeholder so the model knows a turn happened but doesn't re-read old states.
    this.turnHistory = this.turnHistory.map(msg => {
      if (msg.role === 'user' && typeof msg.content === 'string' && msg.content.includes('GAME STATE:')) {
         return { ...msg, content: msg.content.split('\n')[0].substring(0, 20) + '... [Old State Omitted]' + (msg.content.includes('PENDING') ? '\n' + msg.content.split('\n').pop() : '') };
      }
      return msg;
    });

    this.turnHistory.push({ role: 'user', content: contextPrompt });

    // AGGRESSIVE TRUNCATION: Keep only last MAX_MESSAGES
    if (this.turnHistory.length > MAX_MESSAGES) {
      this.turnHistory = this.turnHistory.slice(-MAX_MESSAGES);
    }

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      this.systemPrompt,
      ...this.turnHistory,
    ];

    let lastError: any = null;
    let releaseSlot: (() => void) | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        releaseSlot = await ProviderMgr.acquireSlot(this.model);
        const client = ProviderMgr.getClient(this.model);

        const params: any = {
          model: this.model.id,
          messages,
          tools: monopolyTools,
          tool_choice: 'auto',
          temperature: 0.3,
        };

        if (this.model.maxTokens) {
          params.max_tokens = this.model.maxTokens;
        }

        const response = await client.chat.completions.create(params);

        if ((response as any).response?.headers) {
          ProviderMgr.updateRateLimits(
            this.model,
            (response as any).response.headers
          );
        }

        releaseSlot();
        releaseSlot = null;

        const endTime = Date.now();
        const message = response.choices[0].message;

        // Optimize assistant history: remove reasoning/thought process if present, keep only tool calls
        // This saves tokens on subsequent turns.
        const optimizedMessage = { ...message };
        if (optimizedMessage.content && optimizedMessage.tool_calls && optimizedMessage.tool_calls.length > 0) {
           // If we have tool calls, the content (reasoning) is less critical for history context.
           // Keep a minimal summary or remove it.
           optimizedMessage.content = (optimizedMessage.content.slice(0, 50) + '...'); 
        }

        this.turnHistory.push(optimizedMessage);

        if (this.turnHistory.length > MAX_MESSAGES) {
          this.turnHistory = this.turnHistory.slice(-MAX_MESSAGES);
        }

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
        this.turnInteractionCount++;
        this.appendNDJSON('interactions.ndjson', interaction);
        const reasoning: ReasoningTrace = {
          timestamp: interaction.timestamp,
          player: this.player.name,
          turn: gameState.turn,
          model: this.model.id,
          inputSummary: `pos=${me.position}, $${me.money}, props=${me.properties.length}`,
          thought: (message as any).reasoning || message.content || '',
          chosenTools: (message.tool_calls || []).map(
            (t) => t.function.name || ''
          ),
        };

        this.appendNDJSON('reasoning.ndjson', reasoning);

        return interaction;
      } catch (err: any) {
        if (releaseSlot) {
          releaseSlot();
          releaseSlot = null;
        }

        lastError = err;

        const isRateLimit =
          err?.status === 429 ||
          err?.message?.toLowerCase().includes('rate limit') ||
          err?.message?.toLowerCase().includes('too many requests');

        const is400Error = err?.status === 400;

        console.error(
          `  ❌ ${this.player.name} error (attempt ${attempt}/${MAX_RETRIES}): ${err?.status || ''} ${err?.message || err}`
        );
        console.error(`  📊 Message count: ${messages.length}, turnHistory: ${this.turnHistory.length}`);

        this.appendNDJSON('errors.ndjson', {
          timestamp: new Date().toISOString(),
          player: this.player.name,
          model: this.model.id,
          attempt,
          error: err?.message || String(err),
          status: err?.status,
          isRateLimit,
          is400Error,
          messageCount: messages.length,
          turnHistoryLength: this.turnHistory.length,
        });

        if (is400Error) {
          console.warn(
            `  ⚠️  400 error - clearing history (had ${this.turnHistory.length} messages)`
          );
          this.turnHistory = [];
        }

        if (attempt < MAX_RETRIES) {
          const waitTime = isRateLimit
            ? RETRY_DELAY_MS * 3
            : RETRY_DELAY_MS * attempt;
          console.log(`  ⏳ Retrying in ${waitTime / 1000}s...`);
          await this.sleep(waitTime);
        }
      }
    }

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
    this.turnInteractionCount++;
    this.appendNDJSON('interactions.ndjson', fallback);

    return fallback;
  }

  addToolResult(
    toolCall: OpenAI.Chat.Completions.ChatCompletionMessageToolCall,
    result: any
  ) {
    this.turnHistory.push({
      role: 'tool',
      tool_call_id: toolCall.id,
      content: JSON.stringify(result),
    });

    if (this.turnHistory.length > MAX_MESSAGES) {
      this.turnHistory = this.turnHistory.slice(-MAX_MESSAGES);
    }

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
    this.turnHistory = [];
    this.interactions = [];
    this.turnInteractionCount = 0;
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
          (t) => t.attributes.cost !== undefined && t.attributes.cost !== null
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

import * as fs from 'fs';
import * as path from 'path';
import OpenAI from 'openai';
import { MonopolyAgent, MonopolyMultiAgent, Player } from './setup/agents';
import { models, modelSchema, generatePlayers } from './setup/models';
import { tiles } from './setup/board';

export class MonopolyBenchmark {
  public multiAgent: MonopolyMultiAgent;
  public maxTurns: number;
  private doublesCount = 0;
  private currentDiceRoll:
    | { die1: number; die2: number; total: number; doubles: boolean }
    | null = null;
  public gameId: string;
  public recordingsDir: string;
  private lastCardDrawn: { type: 'chance' | 'community_chest'; name: string; description: string; effect: any } | null = null;

  constructor(players: Player[], modelDefs: modelSchema[], maxTurns = 200) {
    this.gameId = new Date().toISOString().replace(/[:.]/g, '-');
    this.recordingsDir = path.join(
      process.cwd(),
      'game_recordings',
      this.gameId
    );
    if (!fs.existsSync(this.recordingsDir)) {
      fs.mkdirSync(this.recordingsDir, { recursive: true });
    }

    this.multiAgent = new MonopolyMultiAgent(players, modelDefs, {
      gameId: this.gameId,
      recordingsDir: this.recordingsDir,
    });
    this.maxTurns = maxTurns;
  }

  async runBenchmark(): Promise<void> {
    console.log('🎲 Starting Monopoly Benchmark');
    console.log(`Game ID: ${this.gameId}`);
    console.log(`Recording dir: ${this.recordingsDir}`);
    console.log(
      `Players: ${this.multiAgent.gameState.players.map((p) => p.name).join(', ')}`
    );
    console.log(`Max turns: ${this.maxTurns}\n`);

    const idxStart = this.multiAgent.logs.length;
    this.multiAgent.log('GAME_START', {
      players: this.multiAgent.gameState.players.map((p) => ({
        name: p.name,
        money: p.money,
        position: p.position,
      })),
    });
    this.multiAgent.logWithAfter(idxStart);
    this.snapshotState('INITIAL');

    while (
      !this.multiAgent.gameState.gameOver &&
      this.multiAgent.gameState.turn < this.maxTurns
    ) {
      await this.playTurn();
      if (this.multiAgent.checkWinCondition()) break;
    }

    if (this.multiAgent.gameState.turn >= this.maxTurns) {
      const idx = this.multiAgent.logs.length;
      this.multiAgent.log('MAX_TURNS_REACHED', { maxTurns: this.maxTurns });
      this.multiAgent.logWithAfter(idx);
      this.determineWinnerByNetWorth();
    }

    await this.saveResults();
    console.log('\n✅ Benchmark completed');
  }

  private async playTurn(): Promise<void> {
    this.multiAgent.gameState.turn++;
    const player = this.multiAgent.getCurrentPlayer();
    const agent = this.multiAgent.getCurrentAgent();

    // FRESH CONVERSATION FOR NEW TURN
    agent.resetForNewTurn();

    console.log(
      `\n=== TURN ${this.multiAgent.gameState.turn}: ${player.name} ===`
    );

    const idxStart = this.multiAgent.logs.length;
    this.multiAgent.log(
      'TURN_START',
      {
        player: player.name,
        position: player.position,
        money: player.money,
      },
      player
    );
    this.multiAgent.logWithAfter(idxStart);

    this.doublesCount = 0;
    let turnEnded = false;
    let emptyResponseCount = 0;

    if (player.inJail) {
      await this.handleJail(player);
      this.snapshotState('AFTER_JAIL');
      if (player.inJail || player.bankrupt) {
        this.multiAgent.nextPlayer();
        return;
      }
    }

    while (!turnEnded && !player.bankrupt) {
      const interaction = await agent.takeTurn(this.multiAgent.gameState);
      const toolCalls = interaction.toolCalls || [];

      if (toolCalls.length === 0) {
        // CRITICAL FIX: Don't end turn immediately, re-prompt the agent
        emptyResponseCount++;
        console.warn(
          `  ⚠️  ${player.name} returned no tool calls (attempt ${emptyResponseCount}/3)`
        );

        if (emptyResponseCount >= 3) {
          console.error(
            `  ❌ ${player.name} failed to use tools 3 times, forcing end_turn`
          );
          turnEnded = true;
        }
        // Otherwise loop continues and will call takeTurn again
      } else {
        // Reset counter on successful tool calls
        emptyResponseCount = 0;

        for (const call of toolCalls) {
          const result = await this.executeToolCall(call, player, agent);
          agent.addToolResult(call, result);
          this.snapshotState(`AFTER_TOOL_${call.function.name}`);

          if (
            call.function.name === 'end_turn' ||
            result.turnEnded ||
            player.bankrupt
          ) {
            turnEnded = true;
            break;
          }
        }
      }

      if (agent.turnInteractionCount > 20) {
        console.warn(
          `⚠️  ${player.name} exceeded 20 interactions, forcing end_turn`
        );
        turnEnded = true;
      }
    }

    this.multiAgent.nextPlayer();
  }

  private parseToolArguments(fn: string, raw: string): any {
    // Try to parse as-is first
    try {
      if (!raw || raw.trim().length === 0) {
        return {};
      }
      return JSON.parse(raw);
    } catch (e) {
      // Attempt to fix common malformed JSON issues
      let fixed = raw.trim();

      // Fix 1: Missing opening brace
      if (!fixed.startsWith('{') && fixed.includes(':')) {
        fixed = '{' + fixed;
      }

      // Fix 2: Missing closing brace
      if (!fixed.endsWith('}') && fixed.includes(':')) {
        fixed = fixed + '}';
      }

      // Fix 3: Add braces if completely missing but has key-value
      if (!fixed.includes('{') && !fixed.includes('}') && fixed.includes(':')) {
        fixed = '{' + fixed + '}';
      }

      // Try parsing the fixed version
      try {
        const parsed = JSON.parse(fixed);
        console.log(`  🔧 Auto-fixed malformed JSON for ${fn}`);
        return parsed;
      } catch (e2) {
        console.warn(
          `  ⚠️  Failed to parse tool arguments for ${fn}, raw=`,
          raw
        );
        return {};
      }
    }
  }

  private async executeToolCall(
    toolCall: OpenAI.Chat.Completions.ChatCompletionMessageToolCall,
    player: Player,
    agent: MonopolyAgent,
  ): Promise<any> {
    const fn = toolCall.function.name;

    // Robust argument parsing with auto-fix
    const args = this.parseToolArguments(fn, toolCall.function.arguments || '');

    console.log(` 🔧 ${player.name} -> ${fn}`, args);

    switch (fn) {
      case 'roll_dice':
        return this.handleRollDice(player, agent);
      case 'buy_property':
        return this.handleBuyProperty(player, args.confirm);
      case 'auction_bid':
        return this.handleAuctionBid(player, args.amount);
      case 'pass_auction':
        return this.handlePassAuction(player);
      case 'build_house':
        return this.handleBuildHouse(player, args.propertyLocation);
      case 'build_hotel':
        return this.handleBuildHotel(player, args.propertyLocation);
      case 'mortgage_property':
        return this.handleMortgageProperty(player, args.propertyLocation);
      case 'unmortgage_property':
        return this.handleUnmortgageProperty(player, args.propertyLocation);
      case 'sell_house':
        return this.handleSellHouse(player, args.propertyLocation);
      case 'sell_hotel':
        return this.handleSellHotel(player, args.propertyLocation);
      case 'pay_jail_fine':
        return this.handlePayJailFine(player);
      case 'use_jail_card':
        return this.handleUseJailCard(player);
      case 'trade_property':
        return this.handleTradeProposal(player, args);
      case 'respond_to_trade':
        return this.handleTradeResponse(player, !!args.accept);
      case 'get_game_state':
        return this.handleGetGameState(player);
      case 'get_property_info':
        return this.handleGetPropertyInfo(args.propertyLocation);
      case 'end_turn':
        return { success: true, turnEnded: true };
      default:
        return { success: false, error: `Unknown tool: ${fn}` };
    }
  }

private handleRollDice(player: Player) {
  const agent = this.multiAgent.getCurrentAgent();
  
  // Check if agent can roll (handles both initial roll and doubles re-roll)
  if (!agent.canRollDice()) {
    console.warn(`  ⚠️ ${player.name} tried to roll dice but can't!`);
    return {
      success: false,
      error: 'You already rolled dice this turn. Call end_turn to finish your turn.',
    };
  }

  // Roll once
  const roll = this.multiAgent.rollDice();
  this.currentDiceRoll = roll;

  // Update agent's roll tracking
  agent.markRollResult(roll.doubles);

  const idx = this.multiAgent.logs.length;
  this.multiAgent.log('DICE_ROLL', { roll }, player);
  this.multiAgent.logWithAfter(idx);

  console.log(
    `  🎲 Rolled ${roll.die1} + ${roll.die2} = ${roll.total}${roll.doubles ? ' (doubles!)' : ''}`
  );

  // Check for 3 doubles -> jail
  if (roll.doubles) {
    this.doublesCount++;
    if (this.doublesCount === 3) {
      this.sendToJail(player, 'Rolled three doubles');
      return { success: true, roll, sentToJail: true, turnEnded: true };
    }
  }

  // Move player
  const oldPos = player.position;
  player.position = (player.position + roll.total) % 40;

  // Check for passing GO
  let passedGo = false;
  if (player.position < oldPos || oldPos + roll.total >= 40) {
    player.money += 200;
    passedGo = true;
    const idx2 = this.multiAgent.logs.length;
    this.multiAgent.log('PASS_GO', { collected: 200 }, player);
    this.multiAgent.logWithAfter(idx2);
    console.log('  💵 Passed GO, collected $200');
  }

  console.log(
    `  📍 Moved to ${player.position} (${tiles[player.position].name})`
  );

  // Clear last card before landing
  this.lastCardDrawn = null;
  
  this.handleLanding(player);

  // Return comprehensive result
  return {
    success: true,
    roll,
    newPosition: player.position,
    landedOn: tiles[player.position].name,
    doubles: roll.doubles,
    canRollAgain: roll.doubles && this.doublesCount < 3,
    passedGo,
    cardDrawn: this.lastCardDrawn,
  };
}


  private handleLanding(player: Player) {
    const tile = tiles[player.position];
    const idx = this.multiAgent.logs.length;
    this.multiAgent.log(
      'LAND_ON_TILE',
      { tile: tile.name, type: tile.type },
      player
    );
    this.multiAgent.logWithAfter(idx);

    switch (tile.type) {
      case 'go':
        break;
      case 'colored':
      case 'railroad':
      case 'utilities':
        this.handlePropertyLanding(player, tile);
        break;
      case 'chance':
        this.drawChanceCard(player);
        break;
      case 'community_chest':
        this.drawCommunityChestCard(player);
        break;
      case 'income_tax':
        this.handleIncomeTax(player);
        break;
      case 'luxury_tax':
        this.handleLuxuryTax(player);
        break;
      case 'go_to_jail':
        this.sendToJail(player, 'Go To Jail space');
        break;
      case 'free_parking':
      case 'visiting_jail':
        console.log(` 🅿️  Resting on ${tile.name}`);
        break;
    }
  }

  private handlePropertyLanding(player: Player, tile: any) {
    const property = this.multiAgent.gameState.properties.find(
      (p) => p.tile.location === tile.location
    );
    if (!property) return;

    if (property.owner === null) {
      console.log(` 🏠 ${tile.name} is available for $${tile.attributes.cost}`);
    } else if (property.owner === player.id) {
      console.log(' ✅ You own this property');
    } else {
      this.payRent(player, property);
    }
  }

  private payRent(player: Player, property: any) {
    if (property.mortgaged) {
      console.log(' 💤 Property mortgaged, no rent');
      return;
    }

    const owner = this.multiAgent.gameState.players.find(
      (p) => p.id === property.owner
    );
    if (!owner || owner.bankrupt) return;

    let rent = property.tile.attributes.rent_amount || 0;

    if (property.hotels > 0) {
      rent = this.calculateHotelRent(property);
    } else if (property.houses > 0) {
      rent = this.calculateHouseRent(property);
    } else if (this.hasMonopoly(owner.id, property.tile)) {
      rent *= 2;
      console.log(' ⚡ Monopoly bonus, rent doubled');
    }

    if (property.tile.type === 'railroad') {
      const count = this.countRailroadsOwned(owner.id);
      rent = 25 * Math.pow(2, count - 1);
    }

    if (property.tile.type === 'utilities' && this.currentDiceRoll) {
      const count = this.countUtilitiesOwned(owner.id);
      rent = this.currentDiceRoll.total * (count === 1 ? 4 : 10);
    }

    console.log(` 💸 Paying $${rent} to ${owner.name}`);

    if (player.money >= rent) {
      player.money -= rent;
      owner.money += rent;
      const idx = this.multiAgent.logs.length;
      this.multiAgent.log(
        'PAY_RENT',
        {
          property: property.tile.name,
          amount: rent,
          to: owner.name,
        },
        player
      );
      this.multiAgent.logWithAfter(idx);
    } else {
      this.handleBankruptcy(player, owner);
    }
  }

  private handleBuyProperty(player: Player, confirm: boolean) {
    const tile = tiles[player.position];
    const property = this.multiAgent.gameState.properties.find(
      (p) => p.tile.location === tile.location
    );

    if (!property) {
      return { success: false, error: 'Not a purchasable property' };
    }

    if (property.owner !== null) {
      return { success: false, error: 'Already owned' };
    }

    const cost = tile.attributes.cost || 0;

    if (!confirm) {
      console.log(' 🔨 Declined, starting auction');
      this.startAuction(property);
      return { success: true, auctionStarted: true };
    }

    if (player.money < cost) {
      return {
        success: false,
        error: `Need $${cost}, have $${player.money}`,
      };
    }

    player.money -= cost;
    property.owner = player.id;
    player.properties.push(tile.location);

    const idx = this.multiAgent.logs.length;
    this.multiAgent.log(
      'BUY_PROPERTY',
      { property: tile.name, cost, newBalance: player.money },
      player
    );
    this.multiAgent.logWithAfter(idx);

    console.log(` ✅ Bought ${tile.name} for $${cost}`);
    return { success: true, property: tile.name, cost };
  }

  private startAuction(property: any) {
    console.log(` 🔨 AUCTION: ${property.tile.name}`);
    const idx = this.multiAgent.logs.length;
    this.multiAgent.log('AUCTION_START', { property: property.tile.name });
    this.multiAgent.logWithAfter(idx);

    const players = this.multiAgent.gameState.players.filter(
      (p) => !p.bankrupt
    );

    let bestBid = 0;
    let winner: Player | null = null;

    for (const p of players) {
      const maxBid = Math.floor((property.tile.attributes.cost || 0) * 0.8);
      if (p.money > maxBid && maxBid > bestBid) {
        bestBid = maxBid;
        winner = p;
      }
    }

    if (winner && bestBid > 0) {
      winner.money -= bestBid;
      property.owner = winner.id;
      winner.properties.push(property.tile.location);
      console.log(` ✅ ${winner.name} wins auction for $${bestBid}`);
      const idx2 = this.multiAgent.logs.length;
      this.multiAgent.log(
        'AUCTION_WON',
        {
          winner: winner.name,
          amount: bestBid,
          property: property.tile.name,
        },
        winner
      );
      this.multiAgent.logWithAfter(idx2);
    } else {
      console.log(' ❌ No bids, property remains with bank');
    }
  }

  private handleAuctionBid(player: Player, amount: number) {
    return { success: true, bid: amount };
  }

  private handlePassAuction(player: Player) {
    return { success: true, passed: true };
  }

  private handleBuildHouse(player: Player, loc: number) {
    const property = this.multiAgent.gameState.properties.find(
      (p) => p.tile.location === loc
    );
    if (!property) return { success: false, error: 'Property not found' };
    if (property.owner !== player.id)
      return { success: false, error: 'Not owner' };

    if (!this.hasMonopoly(player.id, property.tile)) {
      return { success: false, error: 'Need full color group to build' };
    }

    if (property.hotels > 0) {
      return { success: false, error: 'Has a hotel already' };
    }

    if (property.houses >= 4) {
      return { success: false, error: 'Already 4 houses, build hotel instead' };
    }

    if (!this.canBuildEvenly(player.id, property.tile)) {
      return { success: false, error: 'Must build evenly across color group' };
    }

    if (this.multiAgent.gameState.houses <= 0) {
      return { success: false, error: 'No houses in bank' };
    }

    const cost = this.getHouseCost(property.tile);
    if (player.money < cost) {
      return { success: false, error: `Need $${cost}` };
    }

    player.money -= cost;
    property.houses++;
    this.multiAgent.gameState.houses--;

    const idx = this.multiAgent.logs.length;
    this.multiAgent.log(
      'BUILD_HOUSE',
      { property: property.tile.name, cost, houses: property.houses },
      player
    );
    this.multiAgent.logWithAfter(idx);

    console.log(` 🏗️  Built house on ${property.tile.name} for $${cost}`);
    return { success: true };
  }

  private handleBuildHotel(player: Player, loc: number) {
    const property = this.multiAgent.gameState.properties.find(
      (p) => p.tile.location === loc
    );
    if (!property) return { success: false, error: 'Property not found' };
    if (property.owner !== player.id)
      return { success: false, error: 'Not owner' };

    if (property.houses !== 4) {
      return { success: false, error: 'Must have exactly 4 houses to build hotel' };
    }

    if (this.multiAgent.gameState.hotels <= 0) {
      return { success: false, error: 'No hotels in bank' };
    }

    const cost = this.getHouseCost(property.tile);
    if (player.money < cost) {
      return { success: false, error: `Need $${cost}` };
    }

    player.money -= cost;
    property.houses = 0;
    property.hotels = 1;
    this.multiAgent.gameState.houses += 4;
    this.multiAgent.gameState.hotels--;

    const idx = this.multiAgent.logs.length;
    this.multiAgent.log(
      'BUILD_HOTEL',
      { property: property.tile.name, cost },
      player
    );
    this.multiAgent.logWithAfter(idx);

    console.log(` 🏨 Built hotel on ${property.tile.name} for $${cost}`);
    return { success: true };
  }

  private handleMortgageProperty(player: Player, loc: number) {
    const property = this.multiAgent.gameState.properties.find(
      (p) => p.tile.location === loc
    );
    if (!property) return { success: false, error: 'Property not found' };
    if (property.owner !== player.id)
      return { success: false, error: 'Not owner' };

    if (property.mortgaged) {
      return { success: false, error: 'Already mortgaged' };
    }

    if (this.colorGroupHasBuildings(player.id, property.tile)) {
      return { success: false, error: 'Sell all buildings in color group first' };
    }

    const value = Math.floor((property.tile.attributes.cost || 0) / 2);
    player.money += value;
    property.mortgaged = true;

    const idx = this.multiAgent.logs.length;
    this.multiAgent.log(
      'MORTGAGE_PROPERTY',
      { property: property.tile.name, value },
      player
    );
    this.multiAgent.logWithAfter(idx);

    console.log(` 🏦 Mortgaged ${property.tile.name} for $${value}`);
    return { success: true };
  }

  private handleUnmortgageProperty(player: Player, loc: number) {
    const property = this.multiAgent.gameState.properties.find(
      (p) => p.tile.location === loc
    );
    if (!property) return { success: false, error: 'Property not found' };
    if (property.owner !== player.id)
      return { success: false, error: 'Not owner' };

    if (!property.mortgaged) {
      return { success: false, error: 'Not mortgaged' };
    }

    const mort = Math.floor((property.tile.attributes.cost || 0) / 2);
    const cost = Math.floor(mort * 1.1);

    if (player.money < cost) {
      return { success: false, error: `Need $${cost}` };
    }

    player.money -= cost;
    property.mortgaged = false;

    const idx = this.multiAgent.logs.length;
    this.multiAgent.log(
      'UNMORTGAGE_PROPERTY',
      { property: property.tile.name, cost },
      player
    );
    this.multiAgent.logWithAfter(idx);

    console.log(` 🏦 Unmortgaged ${property.tile.name} for $${cost}`);
    return { success: true };
  }

  private handleSellHouse(player: Player, loc: number) {
    const property = this.multiAgent.gameState.properties.find(
      (p) => p.tile.location === loc
    );
    if (!property) return { success: false, error: 'Property not found' };
    if (property.owner !== player.id)
      return { success: false, error: 'Not owner' };

    if (property.houses === 0) {
      return { success: false, error: 'No houses to sell' };
    }

    if (!this.canSellEvenly(player.id, property.tile)) {
      return { success: false, error: 'Must sell evenly across color group' };
    }

    const cost = this.getHouseCost(property.tile);
    const value = Math.floor(cost / 2);
    player.money += value;
    property.houses--;
    this.multiAgent.gameState.houses++;

    const idx = this.multiAgent.logs.length;
    this.multiAgent.log(
      'SELL_HOUSE',
      { property: property.tile.name, value, housesRemaining: property.houses },
      player
    );
    this.multiAgent.logWithAfter(idx);

    console.log(` 🔨 Sold house on ${property.tile.name} for $${value}`);
    return { success: true };
  }

  private handleSellHotel(player: Player, loc: number) {
    const property = this.multiAgent.gameState.properties.find(
      (p) => p.tile.location === loc
    );
    if (!property) return { success: false, error: 'Property not found' };
    if (property.owner !== player.id)
      return { success: false, error: 'Not owner' };

    if (property.hotels === 0) {
      return { success: false, error: 'No hotel to sell' };
    }

    const houseCost = this.getHouseCost(property.tile);
    const hotelCost = houseCost * 5;
    const value = Math.floor(hotelCost / 2);
    player.money += value;
    property.hotels = 0;
    property.houses = 4;
    this.multiAgent.gameState.hotels++;
    this.multiAgent.gameState.houses -= 4;

    const idx = this.multiAgent.logs.length;
    this.multiAgent.log(
      'SELL_HOTEL',
      { property: property.tile.name, value },
      player
    );
    this.multiAgent.logWithAfter(idx);

    console.log(` 🔨 Sold hotel on ${property.tile.name} for $${value}`);
    return { success: true };
  }

  private async handleJail(player: Player) {
    console.log(` 🔒 ${player.name} is in jail (turn ${player.jailTurns}/3)`);
    player.jailTurns++;

    if (player.jailTurns >= 3) {
      if (player.money >= 50) {
        player.money -= 50;
        player.inJail = false;
        player.jailTurns = 0;
        const idx = this.multiAgent.logs.length;
        this.multiAgent.log('PAY_JAIL_FINE', { amount: 50 }, player);
        this.multiAgent.logWithAfter(idx);
        console.log(' 💰 Paid $50 to leave jail');
      } else {
        this.handleBankruptcy(player, null);
      }
      return;
    }

    const roll = this.multiAgent.rollDice();
    console.log(` 🎲 Jail roll: ${roll.die1} + ${roll.die2}`);

    if (roll.doubles) {
      player.inJail = false;
      player.jailTurns = 0;
      player.position = (player.position + roll.total) % 40;
      const idx = this.multiAgent.logs.length;
      this.multiAgent.log('JAIL_DOUBLES', { roll }, player);
      this.multiAgent.logWithAfter(idx);
      console.log(
        ` ✅ Doubles! Out of jail, moved to ${tiles[player.position].name}`
      );
      this.handleLanding(player);
      
    } else {
      const idx2 = this.multiAgent.logs.length;
      this.multiAgent.log('JAIL_NO_DOUBLES', { roll }, player);
      this.multiAgent.logWithAfter(idx2);
      console.log(' ❌ No doubles, stay in jail');
    }
  }

  private handlePayJailFine(player: Player) {
    if (!player.inJail) return { success: false, error: 'Not in jail' };
    if (player.money < 50) return { success: false, error: 'Need $50' };

    player.money -= 50;
    player.inJail = false;
    player.jailTurns = 0;

    const idx = this.multiAgent.logs.length;
    this.multiAgent.log('PAY_JAIL_FINE', { amount: 50 }, player);
    this.multiAgent.logWithAfter(idx);

    console.log(' 💰 Paid $50 and left jail');
    return { success: true };
  }

  private handleUseJailCard(player: Player) {
    if (!player.inJail) return { success: false, error: 'Not in jail' };
    if (player.jailFreeCards === 0)
      return { success: false, error: 'No Get Out of Jail Free card' };

    player.jailFreeCards--;
    player.inJail = false;
    player.jailTurns = 0;

    const idx = this.multiAgent.logs.length;
    this.multiAgent.log('USE_JAIL_CARD', {}, player);
    this.multiAgent.logWithAfter(idx);

    console.log(' 🎫 Used Get Out of Jail Free card');
    return { success: true };
  }

private drawChanceCard(player: Player) {
  const card = this.multiAgent.gameState.chanceCards[0];
  this.multiAgent.gameState.chanceCards = [
    ...this.multiAgent.gameState.chanceCards.slice(1),
    card,
  ];
  
  // NEW: Store for agent feedback
  this.lastCardDrawn = {
    type: 'chance',
    name: card.name,
    description: card.description,
    effect: card.attributes,
  };

  const idx = this.multiAgent.logs.length;
  this.multiAgent.log(
    'DRAW_CHANCE',
    { card: card.name, description: card.description },
    player
  );
  this.multiAgent.logWithAfter(idx);
  console.log(` 🎴 Chance: ${card.name}`);
  this.executeCardEffect(player, card);
}

private drawCommunityChestCard(player: Player) {
  const card = this.multiAgent.gameState.communityChestCards[0];
  this.multiAgent.gameState.communityChestCards = [
    ...this.multiAgent.gameState.communityChestCards.slice(1),
    card,
  ];

  // NEW: Store for agent feedback
  this.lastCardDrawn = {
    type: 'community_chest',
    name: card.name,
    description: card.description,
    effect: card.attributes,
  };

  const idx = this.multiAgent.logs.length;
  this.multiAgent.log(
    'DRAW_COMMUNITY_CHEST',
    { card: card.name, description: card.description },
    player
  );
  this.multiAgent.logWithAfter(idx);
  console.log(` 🎴 Community Chest: ${card.name}`);
  this.executeCardEffect(player, card);
}

private executeCardEffect(player: Player, card: any) {
  const attrs = card.attributes || {};

  // Handle relative movement (e.g., "Go Back 3 Spaces")
  if (attrs.moveSpaces !== undefined) {
    const oldPos = player.position;
    player.position = (player.position + attrs.moveSpaces + 40) % 40; // Handle negative wrap
    
    console.log(` 📍 Moved ${attrs.moveSpaces} spaces to ${tiles[player.position].name}`);
    this.handleLanding(player);
    return; // Don't fall through
  }

  // Handle "Advance to Nearest" cards (Railroad or Utility)
  if (attrs.moveToNearest) {
    const targetType = attrs.moveToNearest; // 'railroad' or 'utility'
    const currentPos = player.position;
    
    let nearestPos = -1;
    
    if (targetType === 'railroad') {
      const railroads = [5, 15, 25, 35]; // Reading, Pennsylvania, B&O, Short Line
      // Find first railroad ahead of current position, or wrap to first railroad
      nearestPos = railroads.find(r => r > currentPos) ?? railroads[0];
    } else if (targetType === 'utility') {
      const utilities = [12, 28]; // Electric Company, Water Works
      // Find first utility ahead of current position, or wrap to first utility
      nearestPos = utilities.find(u => u > currentPos) ?? utilities[0];
    }
    
    if (nearestPos !== -1) {
      const oldPos = player.position;
      player.position = nearestPos;
      
      // Check if passed Go during movement
      if (nearestPos < oldPos) {
        player.money += 200;
        console.log(' 💰 Passed GO via card, collected $200');
      }
      
      console.log(` 📍 Card moved you to ${tiles[player.position].name}`);
      
      // Check if property is owned
      const property = this.multiAgent.gameState.properties.find(
        p => p.tile.location === nearestPos
      );
      
      if (property && property.owner && property.owner !== player.id) {
        const owner = this.multiAgent.gameState.players.find(
          p => p.id === property.owner
        );
        
        if (owner && !owner.bankrupt) {
          // Handle rent multiplier (e.g., pay double rent at railroad)
          if (attrs.rentMultiplier) {
            let baseRent = property.tile.attributes.rent_amount || 0;
            
            if (property.tile.type === 'railroad') {
              const count = this.countRailroadsOwned(owner.id);
              baseRent = 25 * Math.pow(2, count - 1);
            }
            
            const rent = baseRent * attrs.rentMultiplier;
            console.log(` 💸 Paying ${attrs.rentMultiplier}x rent: $${rent} to ${owner.name}`);
            
            if (player.money >= rent) {
              player.money -= rent;
              owner.money += rent;
              const idx = this.multiAgent.logs.length;
              this.multiAgent.log(
                'PAY_RENT_MULTIPLIED',
                {
                  property: property.tile.name,
                  amount: rent,
                  multiplier: attrs.rentMultiplier,
                  to: owner.name,
                },
                player
              );
              this.multiAgent.logWithAfter(idx);
            } else {
              this.handleBankruptcy(player, owner);
            }
          }
          
          // Handle dice multiplier (e.g., roll dice and pay 10x at utility)
          if (attrs.diceMultiplier) {
            const diceRoll = this.multiAgent.rollDice();
            const rent = diceRoll.total * attrs.diceMultiplier;
            
            console.log(` 🎲 Rolled ${diceRoll.die1} + ${diceRoll.die2} = ${diceRoll.total}`);
            console.log(` 💸 Paying ${attrs.diceMultiplier}x dice roll: $${rent} to ${owner.name}`);
            
            if (player.money >= rent) {
              player.money -= rent;
              owner.money += rent;
              const idx = this.multiAgent.logs.length;
              this.multiAgent.log(
                'PAY_RENT_DICE_MULTIPLIER',
                {
                  property: property.tile.name,
                  diceRoll: diceRoll.total,
                  multiplier: attrs.diceMultiplier,
                  amount: rent,
                  to: owner.name,
                },
                player
              );
              this.multiAgent.logWithAfter(idx);
            } else {
              this.handleBankruptcy(player, owner);
            }
          }
        }
      } else {
        // Property unowned or owned by player - handle landing normally
        this.handleLanding(player);
      }
    }
    return; // Don't fall through to other handlers
  }

  // Handle fixed location movement
  if (attrs.location !== undefined) {
    const old = player.position;
    player.position = attrs.location;
    if (attrs.collectOnPassGo && player.position < old) {
      player.money += 200;
      console.log(' 💰 Passed GO via card, collected $200');
    }

    console.log(` 📍 Card moved you to ${tiles[player.position].name}`);
    this.handleLanding(player);
  }

  // Money effects
  if (attrs.amount !== undefined) {
    player.money += attrs.amount;
    console.log(
      ` 💰 Card amount: ${attrs.amount > 0 ? '+' : ''}${attrs.amount}`
    );
  }

  // Get Out of Jail Free card
  if (attrs.jailFreeCard) {
    player.jailFreeCards++;
    console.log(' 🎫 Gained Get Out of Jail Free card');
  }

  // Go to Jail
  if (card.type === 'movement_jail') {
    this.sendToJail(player, 'Card effect');
  }

  // Collect from other players
  if (attrs.collectFromPlayers && attrs.perPlayer) {
    const others = this.multiAgent.gameState.players.filter(
      (p) => !p.bankrupt && p.id !== player.id
    );
    for (const p of others) {
      const amt = Math.min(p.money, attrs.perPlayer);
      p.money -= amt;
      player.money += amt;
    }

    console.log(` 💰 Collected $${attrs.perPlayer} from each player`);
  }

  // Pay to other players
  if (attrs.payToPlayers && attrs.perPlayer) {
    const others = this.multiAgent.gameState.players.filter(
      (p) => !p.bankrupt && p.id !== player.id
    );
    const total = attrs.perPlayer * others.length;
    if (player.money >= total) {
      for (const p of others) {
        player.money -= attrs.perPlayer;
        p.money += attrs.perPlayer;
      }

      console.log(` 💸 Paid $${attrs.perPlayer} to each player`);
    } else {
      this.handleBankruptcy(player, null);
    }
  }

  // Repairs (pay per house/hotel)
  if (attrs.perHouse || attrs.perHotel) {
    let total = 0;
    this.multiAgent.gameState.properties
      .filter((p) => p.owner === player.id)
      .forEach((p) => {
        if (attrs.perHouse) total += p.houses * attrs.perHouse;
        if (attrs.perHotel) total += p.hotels * attrs.perHotel;
      });
    if (player.money >= total) {
      player.money -= total;
      console.log(` 🔧 Paid $${total} for repairs`);
    } else {
      this.handleBankruptcy(player, null);
    }
  }
}


  private handleIncomeTax(player: Player) {
    const opt1 = 200;
    const worth = this.calculateNetWorth(player);
    const opt2 = Math.floor(worth * 0.1);
    const tax = Math.min(opt1, opt2);

    if (player.money >= tax) {
      player.money -= tax;
      const idx = this.multiAgent.logs.length;
      this.multiAgent.log('PAY_INCOME_TAX', { amount: tax }, player);
      this.multiAgent.logWithAfter(idx);
      console.log(` 💸 Paid $${tax} income tax`);
    } else {
      this.handleBankruptcy(player, null);
    }
  }

  private handleLuxuryTax(player: Player) {
    const tax = 75;
    if (player.money >= tax) {
      player.money -= tax;
      const idx = this.multiAgent.logs.length;
      this.multiAgent.log('PAY_LUXURY_TAX', { amount: tax }, player);
      this.multiAgent.logWithAfter(idx);
      console.log(' 💸 Paid $75 luxury tax');
    } else {
      this.handleBankruptcy(player, null);
    }
  }

  private sendToJail(player: Player, reason: string) {
    player.position = 10;
    player.inJail = true;
    player.jailTurns = 0;
    const idx = this.multiAgent.logs.length;
    this.multiAgent.log('SENT_TO_JAIL', { reason }, player);
    this.multiAgent.logWithAfter(idx);
    console.log(` 🚔 Sent to jail (${reason})`);
  }

  private handleBankruptcy(player: Player, creditor: Player | null) {
    console.log(` 💀 ${player.name} is bankrupt`);
    const idx = this.multiAgent.logs.length;
    this.multiAgent.log(
      'BANKRUPTCY',
      { creditor: creditor?.name || 'Bank' },
      player
    );
    this.multiAgent.logWithAfter(idx);

    player.bankrupt = true;

    if (creditor) {
      creditor.money += player.money;
      this.multiAgent.gameState.properties
        .filter((p) => p.owner === player.id)
        .forEach((p) => {
          p.owner = creditor.id;
          creditor.properties.push(p.tile.location);
        });
      creditor.jailFreeCards += player.jailFreeCards;
    } else {
      this.multiAgent.gameState.properties
        .filter((p) => p.owner === player.id)
        .forEach((p) => {
          p.hotels = 0;
          p.houses = 0;
          p.owner = null;
          p.mortgaged = false;
        });
    }

    player.money = 0;
    player.properties = [];
    player.jailFreeCards = 0;
  }

  private handleTradeProposal(player: Player, args: any) {
    console.log(` 🤝 ${player.name} proposes trade to ${args.targetPlayer}`);
    const idx = this.multiAgent.logs.length;
    this.multiAgent.log('TRADE_PROPOSAL', args, player);
    this.multiAgent.logWithAfter(idx);
    return {
      success: true,
      tradePending: true,
      message: 'Trade proposal recorded (actual negotiation not implemented).',
    };
  }

  private handleTradeResponse(player: Player, accept: boolean) {
    console.log(
      ` 🤝 ${player.name} ${accept ? 'accepted' : 'rejected'} a trade`
    );
    return { success: true, accepted: accept };
  }

  private handleGetGameState(player: Player) {
    return {
      success: true,
      gameState: {
        turn: this.multiAgent.gameState.turn,
        currentPlayer: this.multiAgent.getCurrentPlayer().name,
        players: this.multiAgent.gameState.players.map((p) => ({
          name: p.name,
          position: p.position,
          tile: tiles[p.position].name,
          money: p.money,
          properties: p.properties.map((loc) => tiles[loc].name),
          inJail: p.inJail,
          bankrupt: p.bankrupt,
        })),
      },
    };
  }

  private handleGetPropertyInfo(loc: number) {
    const property = this.multiAgent.gameState.properties.find(
      (p) => p.tile.location === loc
    );
    if (!property) return { success: false, error: 'Property not found' };

    return {
      success: true,
      property: {
        name: property.tile.name,
        location: property.tile.location,
        type: property.tile.type,
        color: property.tile.attributes.color,
        cost: property.tile.attributes.cost,
        rent: property.tile.attributes.rent_amount,
        owner: property.owner,
        houses: property.houses,
        hotels: property.hotels,
        mortgaged: property.mortgaged,
      },
    };
  }

  private hasMonopoly(playerId: string, tile: any) {
    const color = tile.attributes.color;
    if (!color) return false;

    const group = this.multiAgent.gameState.properties.filter(
      (p) => p.tile.attributes.color === color
    );
    return group.every((p) => p.owner === playerId);
  }

  private canBuildEvenly(playerId: string, tile: any) {
    const color = tile.attributes.color;
    if (!color) return false;

    const group = this.multiAgent.gameState.properties.filter(
      (p) => p.tile.attributes.color === color && p.owner === playerId
    );
    const current = group.find((p) => p.tile.location === tile.location);
    if (!current) return false;

    const min = Math.min(...group.map((p) => p.houses));
    return current.houses === min;
  }

  private canSellEvenly(playerId: string, tile: any) {
    const color = tile.attributes.color;
    if (!color) return false;

    const group = this.multiAgent.gameState.properties.filter(
      (p) => p.tile.attributes.color === color && p.owner === playerId
    );
    const current = group.find((p) => p.tile.location === tile.location);
    if (!current) return false;

    const max = Math.max(...group.map((p) => p.houses));
    return current.houses === max;
  }

  private colorGroupHasBuildings(playerId: string, tile: any) {
    const color = tile.attributes.color;
    if (!color) return false;

    return this.multiAgent.gameState.properties
      .filter((p) => p.tile.attributes.color === color && p.owner === playerId)
      .some((p) => p.houses > 0 || p.hotels > 0);
  }

  private calculateHouseRent(property: any): number {
    const a = property.tile.attributes;
    if (!a) return 0;

    switch (property.houses) {
      case 1:
        return a.rent1House ?? 0;
      case 2:
        return a.rent2Houses ?? 0;
      case 3:
        return a.rent3Houses ?? 0;
      case 4:
        return a.rent4Houses ?? 0;
      default:
        return a.rent_amount ?? 0;
    }
  }

  private calculateHotelRent(property: any): number {
    return property.tile.attributes?.rentHotel ?? 0;
  }

  private getHouseCost(tile: any): number {
    return tile.attributes.houseCost ?? 0;
  }

  private countRailroadsOwned(playerId: string) {
    return this.multiAgent.gameState.properties.filter(
      (p) => p.tile.type === 'railroad' && p.owner === playerId
    ).length;
  }

  private countUtilitiesOwned(playerId: string) {
    return this.multiAgent.gameState.properties.filter(
      (p) => p.tile.type === 'utilities' && p.owner === playerId
    ).length;
  }

  private calculateNetWorth(player: Player) {
    let worth = player.money;
    this.multiAgent.gameState.properties
      .filter((p) => p.owner === player.id)
      .forEach((p) => {
        worth += p.tile.attributes.cost || 0;
        worth += p.houses * this.getHouseCost(p.tile);
        worth += p.hotels * this.getHouseCost(p.tile) * 5;
        if (p.mortgaged) {
          worth -= Math.floor((p.tile.attributes.cost || 0) / 2);
        }
      });
    return worth;
  }

  private determineWinnerByNetWorth() {
    const active = this.multiAgent.gameState.players.filter((p) => !p.bankrupt);
    let best: Player | null = null;
    let bestWorth = 0;

    for (const p of active) {
      const w = this.calculateNetWorth(p);
      if (w > bestWorth) {
        bestWorth = w;
        best = p;
      }
    }

    if (best) {
      this.multiAgent.gameState.gameOver = true;
      this.multiAgent.gameState.winner = best.name;
      console.log(`\n🏆 Winner by net worth: ${best.name} ($${bestWorth})`);
      const idx = this.multiAgent.logs.length;
      this.multiAgent.log(
        'GAME_OVER_NET_WORTH',
        { winner: best.name, netWorth: bestWorth },
        best
      );
      this.multiAgent.logWithAfter(idx);
    }
  }

  private snapshotState(tag: string) {
    const snap = {
      timestamp: new Date().toISOString(),
      tag,
      turn: this.multiAgent.gameState.turn,
      state: this.multiAgent.gameState,
    };
    const file = path.join(this.recordingsDir, 'state_snapshots.ndjson');
    try {
      fs.appendFileSync(file, JSON.stringify(snap) + '\n', 'utf8');
    } catch (e) {
      console.error('Failed to write state snapshot:', e);
    }
  }

  private async saveResults() {
    const data = this.multiAgent.exportGameData();
    const file = path.join(this.recordingsDir, 'final_summary.json');
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    console.log(`\n📊 Saved final summary to ${file}`);

    console.log('\n=== FINAL STATS ===');
    console.log(`Winner: ${data.statistics.winner}`);
    console.log(`Turns: ${data.statistics.totalTurns}`);
    console.log(`Interactions: ${data.statistics.totalInteractions}`);
    console.log(`Tokens: ${data.statistics.totalTokensUsed}`);
    console.log(`Avg latency: ${data.statistics.averageLatency.toFixed(2)} ms`);
  }
}

async function main() {
  const NUM_GAMES = 1;
  const MAX_TURNS_PER_GAME = 100;

  console.log(`\n🎮 Starting Monopoly Benchmark Suite`);
  console.log(`📊 Running ${NUM_GAMES} games with ${models.length} players\n`);

  const allGameResults: any[] = [];

  for (let gameNum = 1; gameNum <= NUM_GAMES; gameNum++) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🎲 GAME ${gameNum}/${NUM_GAMES}`);
    console.log(`${'='.repeat(60)}\n`);

    const players = generatePlayers(models);
    const benchmark = new MonopolyBenchmark(players, models, MAX_TURNS_PER_GAME);
    await benchmark.runBenchmark();

    const gameData = benchmark.multiAgent.exportGameData();
    allGameResults.push({
      gameNumber: gameNum,
      gameId: benchmark.gameId,
      winner: gameData.statistics.winner,
      turns: gameData.statistics.totalTurns,
      tokens: gameData.statistics.totalTokensUsed,
      avgLatency: gameData.statistics.averageLatency,
    });

    if (gameNum < NUM_GAMES) {
      console.log(`\n⏸️  Cooling down for 5 seconds before next game...\n`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  if (NUM_GAMES > 1) {
    console.log(`\n\n${'='.repeat(60)}`);
    console.log(`📊 BENCHMARK SUITE COMPLETE`);
    console.log(`${'='.repeat(60)}\n`);
    console.log(`Games played: ${NUM_GAMES}`);
    console.log(`\nResults by game:`);
    allGameResults.forEach((result) => {
      console.log(
        ` Game ${result.gameNumber}: ${result.winner} won in ${result.turns} turns (${result.tokens} tokens)`
      );
    });

    console.log(`\nWin counts:`);
    const winCounts: Record<string, number> = {};
    allGameResults.forEach((result) => {
      winCounts[result.winner] = (winCounts[result.winner] || 0) + 1;
    });

    Object.entries(winCounts)
      .sort(([, a], [, b]) => b - a)
      .forEach(([name, wins]) => {
        console.log(
          ` ${name}: ${wins} wins (${((wins / NUM_GAMES) * 100).toFixed(1)}%)`
        );
      });

    const avgTurns =
      allGameResults.reduce((sum, r) => sum + r.turns, 0) / NUM_GAMES;
    const avgTokens =
      allGameResults.reduce((sum, r) => sum + r.tokens, 0) / NUM_GAMES;
    const avgLatency =
      allGameResults.reduce((sum, r) => sum + r.avgLatency, 0) / NUM_GAMES;

    console.log(`\nAverages:`);
    console.log(` Turns per game: ${avgTurns.toFixed(1)}`);
    console.log(` Tokens per game: ${avgTokens.toFixed(0)}`);
    console.log(` Avg latency: ${avgLatency.toFixed(2)}ms`);

    const summaryPath = path.join(
      process.cwd(),
      'game_recordings',
      `benchmark_summary_${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    );

    fs.writeFileSync(
      summaryPath,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          numGames: NUM_GAMES,
          models: models.map((m) => ({ name: m.name, id: m.id })),
          results: allGameResults,
          aggregateStats: {
            winCounts,
            avgTurns,
            avgTokens,
            avgLatency,
          },
        },
        null,
        2
      ),
      'utf8'
    );
    console.log(`\n📁 Saved aggregate results to: ${summaryPath}\n`);
  }
}

if (require.main === module) {
  main().catch(console.error);
}

export default MonopolyBenchmark;

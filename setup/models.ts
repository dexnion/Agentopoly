import OpenAI from 'openai';
import { Player } from './agents';

export interface modelSchema {
  name: string;
  id: string;
  provider?: {
    apiKey?: string;
    baseURL?: string;
  };
  maxTokens?: number; // Token limit per response
}

// Rate limit tracker per provider
interface RateLimitInfo {
  remaining: number;
  limit: number;
  resetAt: number;
  lastRequestAt: number;
}

class ProviderManager {
  private clients = new Map<string, OpenAI>();
  private rateLimits = new Map<string, RateLimitInfo>();
  private requestQueues = new Map<string, Promise<void>>();

  getClient(model: modelSchema): OpenAI {
    const key = this.getProviderKey(model);

    if (!this.clients.has(key)) {
      const client = new OpenAI({
        apiKey: model.provider?.apiKey || process.env.API_KEY,
        baseURL: model.provider?.baseURL || process.env.BASE_URL,
      });
      this.clients.set(key, client);
    }

    return this.clients.get(key)!;
  }

  private getProviderKey(model: modelSchema): string {
    const baseURL = model.provider?.baseURL || process.env.BASE_URL || 'default';
    const apiKey = model.provider?.apiKey || process.env.API_KEY || 'default';
    return `${baseURL}::${apiKey.slice(0, 8)}`;
  }

  async acquireSlot(model: modelSchema): Promise<() => void> {
    const key = this.getProviderKey(model);

    if (this.requestQueues.has(key)) {
      await this.requestQueues.get(key);
    }

    const rateLimitInfo = this.rateLimits.get(key);
    if (rateLimitInfo) {
      const now = Date.now();

      if (rateLimitInfo.remaining <= 5 && now < rateLimitInfo.resetAt) {
        const waitTime = rateLimitInfo.resetAt - now;
        console.log(
          `  ⏳ Rate limit low (${rateLimitInfo.remaining}/${rateLimitInfo.limit}), waiting ${Math.ceil(waitTime / 1000)}s`
        );
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }

      const timeSinceLastReq = now - rateLimitInfo.lastRequestAt;
      if (timeSinceLastReq < 500) {
        await new Promise((resolve) =>
          setTimeout(resolve, 500 - timeSinceLastReq)
        );
      }
    }

    let resolveQueue: () => void;
    const queuePromise = new Promise<void>((resolve) => {
      resolveQueue = resolve;
    });
    this.requestQueues.set(key, queuePromise);

    return () => {
      resolveQueue!();
      if (this.requestQueues.get(key) === queuePromise) {
        this.requestQueues.delete(key);
      }
    };
  }

  updateRateLimits(model: modelSchema, headers: Headers) {
    const key = this.getProviderKey(model);

    const remaining = parseInt(
      headers.get('ratelimit-remaining') || '1000',
      10
    );
    const limit = parseInt(headers.get('ratelimit-limit') || '1000', 10);
    const reset = parseInt(headers.get('ratelimit-reset') || '0', 10);

    this.rateLimits.set(key, {
      remaining,
      limit,
      resetAt: Date.now() + reset * 1000,
      lastRequestAt: Date.now(),
    });

    if (remaining < 10) {
      console.log(`  ⚠️  Low rate limit: ${remaining}/${limit} remaining`);
    }
  }

  getRateLimitInfo(model: modelSchema): RateLimitInfo | undefined {
    return this.rateLimits.get(this.getProviderKey(model));
  }
}

export const ProviderMgr = new ProviderManager();

export const Client = new OpenAI({
  apiKey: process.env.API_KEY,
  baseURL: process.env.BASE_URL,
});

// Configure your models here with token limits
export const models: modelSchema[] = [
  {
    name: 'GPT OSS 120B',
    id: 'openai/gpt-oss-120b',
    maxTokens: 800, // Kimi is usually concise
  },
  {
    name: 'Deepseek V3.2',
    id: 'deepseek-ai/DeepSeek-V3.2',
    provider: {
      apiKey: process.env.GMI_KEY,
      baseURL: 'https://api.gmi-serving.com/v1',
    },
    maxTokens: 300, // Deepseek is VERY verbose, cap it hard
  },
  // Add more models as needed
];

// Helper to generate players from models
export function generatePlayers(modelList: modelSchema[] = models): Player[] {
  return modelList.map((model, index) => ({
    id: `p${index + 1}`,
    name: model.name,
    position: 0,
    money: 1500,
    properties: [],
    jailFreeCards: 0,
    inJail: false,
    jailTurns: 0,
    bankrupt: false,
  }));
}

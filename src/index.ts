import { config } from './config.js';
import { Engine } from './engine.js';
import { DemoFeed } from './feed-demo.js';
import { LiveFeed } from './feed-live.js';
import { startServer } from './server.js';
import type { Feed } from './types.js';

const feed: Feed = config.mode === 'live' ? new LiveFeed(config.rpcWsUrl) : new DemoFeed(config.demoSpeed);
const engine = new Engine(feed);
startServer(engine, config.port);
feed.start();

console.log(`[vigil] mode: ${config.mode}. Paper trading only: there is no wallet, no private key and no real order code.`);

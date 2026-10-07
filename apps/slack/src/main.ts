import { createDb } from '@spinroom/db';
import { Redis } from 'ioredis';
import { createSlackApp } from './app.js';
import { slackConfig } from './config.js';

const cfg = slackConfig();
const { db } = createDb(cfg.databaseUrl, 5);
const redis = new Redis(cfg.redisUrl);
const sub = new Redis(cfg.redisUrl);
const slack = createSlackApp(cfg, { db, redis, sub });
await slack.start();
console.log(`Spinroom Slack app on :${cfg.port} (install at ${cfg.publicUrl}/v1/integrations/slack/install)`);

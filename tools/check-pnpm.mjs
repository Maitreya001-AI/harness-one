#!/usr/bin/env node
const ua = process.env.npm_config_user_agent || '';
if (!ua.startsWith('pnpm')) {
  console.error('\nThis repo uses pnpm. Enable corepack (default on Node 18.19+) or run: npm i -g pnpm\n');
  process.exit(1);
}

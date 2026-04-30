// Live smoke test for the Telegram notifier.
// Run with: npm run telegram:test
// Requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env.

import 'dotenv/config';
import { sendTelegramAlert } from '../integrations/telegramNotifier';

async function main(): Promise<void> {
  console.log('Sending test alert to Telegram...');
  await sendTelegramAlert('[LimaLeads] Telegram integration is working correctly.');
  console.log('Done. Check your Telegram chat for the message.');
}

main().catch((err) => {
  console.error('FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

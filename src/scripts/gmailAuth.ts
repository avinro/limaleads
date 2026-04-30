/**
 * One-time script to generate a Gmail OAuth2 refresh token.
 * Run once with: npm run gmail:auth
 *
 * Prerequisites:
 *   - GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set in .env
 *
 * After running, copy the printed GMAIL_REFRESH_TOKEN value into your .env file.
 */

import { google } from 'googleapis';
import * as readline from 'readline';
import * as dotenv from 'dotenv';

dotenv.config();

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Error: GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set in .env');
  process.exit(1);
}

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  // AVI-13: gmail.compose is required to create drafts via drafts.create.
  // If you already have a token without this scope, revoke it at
  // https://myaccount.google.com/permissions and re-run `npm run gmail:auth`.
  'https://www.googleapis.com/auth/gmail.compose',
];

// OOB redirect — works for Desktop App OAuth clients in GCP.
// OOB deprecation only affects new Web clients; Desktop App flow remains valid.
const REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent',
});

console.log('\n─────────────────────────────────────────────');
console.log('Gmail OAuth2 Authorization');
console.log('─────────────────────────────────────────────');
console.log('\n1. Open this URL in your browser:\n');
console.log(authUrl);
console.log('\n2. Authorize with your Gmail account');
console.log('3. Copy the authorization code shown\n');
console.log('─────────────────────────────────────────────\n');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question('Paste the authorization code here: ', async (code) => {
  rl.close();

  try {
    const { tokens } = await oauth2Client.getToken(code.trim());

    if (!tokens.refresh_token) {
      console.error(
        '\nError: No refresh token returned. This can happen if the account already authorized this app.',
      );
      console.error(
        'Fix: Go to https://myaccount.google.com/permissions, revoke access for LimaLeads, then run this script again.\n',
      );
      process.exit(1);
    }

    console.log('\n─────────────────────────────────────────────');
    console.log('Success! Add this to your .env file:');
    console.log('─────────────────────────────────────────────');
    console.log(`\nGMAIL_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    console.log('─────────────────────────────────────────────\n');
  } catch (err) {
    console.error('\nFailed to exchange code for tokens:', err);
    process.exit(1);
  }
});

/**
 * Polls the IMAP inbox for a BGE verification email and extracts the OTP code.
 * Uses imap-simple + mailparser. Install: npm i imap-simple mailparser @types/imap
 */
import imaps from 'imap-simple';
import { simpleParser } from 'mailparser';

interface OTPReaderConfig {
  host: string;
  port: number;
  email: string;
  password: string;
  senderFilter?: string;
  maxWaitMs?: number;
  pollIntervalMs?: number;
}

export async function fetchBGEOtp(config: OTPReaderConfig): Promise<string | null> {
  const {
    host,
    port,
    email,
    password,
    senderFilter = 'noreply@bge.com',
    maxWaitMs = 120_000,
    pollIntervalMs = 5_000,
  } = config;

  const imapConfig = {
    imap: {
      host,
      port,
      tls: true,
      user: email,
      password,
      authTimeout: 10_000,
      tlsOptions: { rejectUnauthorized: false },
    },
  };

  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    let connection: imaps.ImapSimple | null = null;
    try {
      connection = await imaps.connect(imapConfig);
      await connection.openBox('INBOX');

      const searchCriteria = ['UNSEEN', ['FROM', senderFilter]];
      const fetchOptions = { bodies: [''], markSeen: false };
      const messages = await connection.search(searchCriteria, fetchOptions);

      if (messages.length > 0) {
        // Take the most recent
        const latest = messages[messages.length - 1];
        const raw = latest.parts.find((p: imaps.Message['parts'][number]) => p.which === '')?.body ?? '';
        const parsed = await simpleParser(raw as string);
        const body = parsed.text ?? parsed.html ?? '';

        const otp = extractOtp(body.toString());
        if (otp) {
          // Mark as read so we don't re-process it
          const uid = latest.attributes.uid;
          await connection.addFlags(uid, '\\Seen');
          await connection.end();
          console.log(`[OTP] Code found (first 2 chars): ${otp.substring(0, 2)}****`);
          return otp;
        }
      }

      await connection.end();
    } catch (err) {
      console.error('[OTP] IMAP error:', err);
      try { await connection?.end(); } catch (_) {}
    }

    if (Date.now() < deadline) {
      console.log(`[OTP] Not found yet — retrying in ${pollIntervalMs / 1000}s...`);
      await sleep(pollIntervalMs);
    }
  }

  console.error('[OTP] Timed out waiting for BGE OTP email.');
  return null;
}

function extractOtp(body: string): string | null {
  const patterns = [
    /\b(\d{6})\b/,
    /(?:code|otp|pin|verification)[:\s]+(\d{4,8})/i,
    /(?:Your|Enter)[^.]{0,60}?(\d{6})/i,
  ];
  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

import type { IncomingMessage, ServerResponse } from 'http';
import { bot } from '../src/bot';
import { executeDeadlineCheck } from '../src/cron';

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    const isUrgentOnly = url.searchParams.get('urgent') === 'true';
    const isTodayAndOverdueOnly = url.searchParams.get('today') === 'true';

    const result = await executeDeadlineCheck(bot, {
      isUrgentOnly,
      isTodayAndOverdueOnly,
      manualTrigger: true,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result }));
  } catch (err: any) {
    console.error('[CRON API Error]', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }));
  }
}

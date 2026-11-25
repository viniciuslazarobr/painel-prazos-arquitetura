import type { IncomingMessage, ServerResponse } from 'http';
import { webhookCallback } from 'grammy';
import { bot } from '../src/bot';

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (!bot) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Telegram bot não configurado nesta instância' }));
    return;
  }
  return webhookCallback(bot, 'http')(req, res);
}

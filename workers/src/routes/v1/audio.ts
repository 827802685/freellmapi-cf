/**
 * /v1/audio/speech
 */

import { Hono } from 'hono';
import type { Env } from '../../types';
import { requireUserToken } from '../../lib/auth';
import { err } from '../../lib/response';

export const audioRoute = new Hono<{ Bindings: Env }>();

audioRoute.post('/audio/speech', requireUserToken, async (c) => {
  return err(c, 'Audio TTS not yet wired', 501, 'not_implemented');
});

// Cloudflare Pages Function: GET /api/calendar/<ids>.ics - canonical feed URL (see ../calendar.js).
// The ".ics" path keeps calendar clients happy and avoids a nested "?" inside Google's cid= / Outlook's url=.
import { handleFeed } from '../calendar.js';

export const onRequestGet = handleFeed;
export const onRequestHead = handleFeed;

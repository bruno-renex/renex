import { json, corsHeaders } from './src/utils.js';
import { handleWsRoutes } from './src/routes/wsRoutes.js';
import { handleE2eRoutes } from './src/routes/e2eRoutes.js';
import { handleChatRoutes } from './src/routes/chatRoutes.js';
import { handleAuthRoutes } from './src/routes/authRoutes.js';
import { handleContactRoutes } from './src/routes/contactRoutes.js';
import { handleAutoDeleteRoutes } from './src/routes/autoDeleteRoutes.js';
import { handleGroupRoutes } from './src/routes/groupRoutes.js';
import { handleNotificationRoutes } from './src/routes/notificationRoutes.js';
import { handlePresenceRoutes } from './src/routes/presenceRoutes.js';
import { handleUploadRoutes } from './src/routes/uploadRoutes.js';
import { handleGifRoutes } from './src/routes/gifRoutes.js';
import { handleInviteRoutes } from './src/routes/inviteRoutes.js';
import { scheduled } from './src/cron.js';

// Cloudflare Durable Object binding requirement — must be re-exported from entry point
export { UserSessionDO } from './src/auth.js';

async function fetch(request, env) {
  // PRE-FLIGHT
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(request),
    });
  }

  try {
    const url = new URL(request.url);
    const path = url.pathname.toLowerCase();
    const params = url.searchParams;

    if (path.startsWith('/invite/')) {
      return handleInviteRoutes(request, env, path, params);
    }
    if (path.startsWith('/upload/')) {
      return handleUploadRoutes(request, env, path, params);
    }
    if (path.startsWith('/gif/')) {
      return handleGifRoutes(request, env, path, params);
    }
    if (path === '/chat/ws' || path === '/chat/control' || path === '/chat/test') {
      return handleWsRoutes(request, env, path, params);
    }
    if (path.startsWith('/chat/keys/') || path.startsWith('/e2e/')) {
      return handleE2eRoutes(request, env, path, params);
    }
    if (path === '/chat/auto-delete') {
      return handleAutoDeleteRoutes(request, env, path, params);
    }
    if (path.startsWith('/chat/')) {
      return handleChatRoutes(request, env, path, params);
    }
    if (path.startsWith('/auth/') || path === '/users/me' || path === '/account') {
      return handleAuthRoutes(request, env, path, params);
    }
    if (path.startsWith('/contacts')) {
      return handleContactRoutes(request, env, path, params);
    }
    if (path.startsWith('/groups')) {
      return handleGroupRoutes(request, env, path, params);
    }
    if (path.startsWith('/notifications')) {
      return handleNotificationRoutes(request, env, path);
    }
    if (path.startsWith('/presence')) {
      return handlePresenceRoutes(request, env, path);
    }
    return json(request, { error: 'Not found' }, 404);

  } catch (e) {
    console.error("WORKER CRASH", e);
    return json(request, { error: "Internal server error" }, 500);
  }
}

export default { fetch, scheduled };

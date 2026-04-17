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
import { handlePushRoutes } from './src/routes/pushRoutes.js';
import { handleFeedbackRoutes } from './src/routes/feedbackRoutes.js';
import { handleVoiceRoutes } from './src/routes/voiceRoutes.js';
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
      return await handleInviteRoutes(request, env, path, params);
    }
    if (path.startsWith('/upload/')) {
      return await handleUploadRoutes(request, env, path, params);
    }
    if (path.startsWith('/gif/')) {
      return await handleGifRoutes(request, env, path, params);
    }
    if (path === '/chat/ws' || path === '/chat/control' || path === '/chat/test') {
      return await handleWsRoutes(request, env, path, params);
    }
    if (path.startsWith('/chat/keys/') || path.startsWith('/e2e/')) {
      return await handleE2eRoutes(request, env, path, params);
    }
    if (path === '/chat/auto-delete') {
      return await handleAutoDeleteRoutes(request, env, path, params);
    }
    if (path.startsWith('/chat/')) {
      return await handleChatRoutes(request, env, path, params);
    }
    if (path.startsWith('/auth/') || path === '/users/me' || path === '/account') {
      return await handleAuthRoutes(request, env, path, params);
    }
    if (path.startsWith('/contacts')) {
      return await handleContactRoutes(request, env, path, params);
    }
    if (path.startsWith('/groups')) {
      return await handleGroupRoutes(request, env, path, params);
    }
    if (path.startsWith('/notifications')) {
      return await handleNotificationRoutes(request, env, path);
    }
    if (path.startsWith('/presence')) {
      return await handlePresenceRoutes(request, env, path);
    }
    if (path.startsWith('/push/')) {
      return await handlePushRoutes(request, env, path);
    }
    if (path.startsWith('/feedback/')) {
      return await handleFeedbackRoutes(request, env, path, params);
    }
    if (path.startsWith('/voice/')) {
      return await handleVoiceRoutes(request, env, path, params);
    }
    return json(request, { error: 'Not found' }, 404);

  } catch (e) {
    console.error("WORKER CRASH", e);
    return json(request, { error: "Internal server error" }, 500);
  }
}

export default { fetch, scheduled };

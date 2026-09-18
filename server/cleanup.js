import { expireUnpaid } from './api.js';
import { sweepAbandonedGitHubInstallations } from './connections.js';
export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async()=>{
      const requests=await expireUnpaid(env);
      const installations=await sweepAbandonedGitHubInstallations(env);
      console.info('Vibecheck cleanup',JSON.stringify({requests,installations}));
    })());
  },
  async fetch() { return new Response('Not found', { status: 404 }); }
};

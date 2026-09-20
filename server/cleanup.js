import { expireUnpaid, reconcilePendingReviews, availableReviewSlots } from './api.js';
import { sweepAbandonedGitHubInstallations } from './connections.js';
import { processEmails } from './communications.js';
export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async()=>{
      const requests=await expireUnpaid(env);
      const reviews=await reconcilePendingReviews(env);
      const installations=await sweepAbandonedGitHubInstallations(env);
      const emails=await processEmails(env,availableReviewSlots);
      console.info('Vibecheck cleanup',JSON.stringify({requests,reviews,installations,emails}));
    })());
  },
  async fetch() { return new Response('Not found', { status: 404 }); }
};

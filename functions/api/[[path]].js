import { handle } from '../../server/api.js';
export const onRequest = context => handle(context.request, context.env);

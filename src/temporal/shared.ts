/** Names shared by the workflow, the worker and the client. */
export const TASK_QUEUE_NAME = 'hotel-offers';

/**
 * One workflow id per city. Concurrent requests for the same city attach to the
 * running execution instead of fanning out to the suppliers twice (see the
 * conflict policy in client.ts).
 */
export function hotelsWorkflowId(city: string): string {
  return `hotels:${city}`;
}

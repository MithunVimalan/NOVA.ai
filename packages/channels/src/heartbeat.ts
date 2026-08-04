import { getSqliteManager } from '@nova/shared';

/**
 * Registers a heartbeat listener that delivers proactive messages to the owner
 * address stored under `ownerFactKey`, skipping delivery when it is unknown.
 */
export function registerOwnerHeartbeat(
  heartbeatService: any,
  channel: string,
  ownerFactKey: string,
  send: (ownerAddress: string, message: string) => Promise<unknown>
): void {
  heartbeatService.registerListener(channel, (message: string) => {
    const ownerAddress = getSqliteManager().getFact(ownerFactKey);
    if (!ownerAddress) return;

    send(ownerAddress, message).catch((err: any) => {
      console.error(`[${channel}] Heartbeat send failed:`, err);
    });
  });
}

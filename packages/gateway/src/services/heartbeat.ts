export type NotificationCallback = (message: string) => void;

export class HeartbeatService {
  private listeners: Map<string, NotificationCallback> = new Map();
  private intervalTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.startHeartbeatLoop();
  }

  private startHeartbeatLoop() {
    // Send a subtle check-in every 1 hour (e.g. system is online, current time status)
    this.intervalTimer = setInterval(() => {
      console.log(`[Heartbeat] Service checking in. System is healthy.`);
      this.notifyOwner(`[NOVA Heartbeat] I am online and listening. Current local time: ${new Date().toLocaleTimeString()}`);
    }, 3600000); // 1 hour
  }

  public registerListener(channelId: string, callback: NotificationCallback): void {
    this.listeners.set(channelId, callback);
    console.log(`[Heartbeat] Registered notification listener for channel: ${channelId}`);
  }

  public unregisterListener(channelId: string): void {
    this.listeners.delete(channelId);
    console.log(`[Heartbeat] Unregistered listener: ${channelId}`);
  }

  public notifyOwner(message: string): void {
    console.log(`[Heartbeat Dispatch] ${message}`);
    this.listeners.forEach((callback, channelId) => {
      try {
        callback(message);
      } catch (err) {
        console.error(`[Heartbeat] Error dispatching to ${channelId}:`, err);
      }
    });
  }

  public close() {
    if (this.intervalTimer) clearInterval(this.intervalTimer);
  }
}

let heartbeatServiceInstance: HeartbeatService | null = null;
export function getHeartbeatService(): HeartbeatService {
  if (!heartbeatServiceInstance) {
    heartbeatServiceInstance = new HeartbeatService();
  }
  return heartbeatServiceInstance;
}
